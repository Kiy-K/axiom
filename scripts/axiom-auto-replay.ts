#!/usr/bin/env node
// P6 S4 replay: feed the tool calls of recorded sessions through the permission gateway in `manual`, `accept-edits`
// and `auto`, and count what each mode would have asked, allowed without a prompt, or denied. Nothing is executed:
// the gateway only decides. Spec: docs/axiom/p6-auto-mode-contract.md, "Replay measurement (S4)".
//
//   node scripts/axiom-auto-replay.ts [--list] [--cwd <workspace>] <session.jsonl>...
//
// A session is a JSONL file with `message` lines holding `toolCall` parts (the session store's format). The user answers
// every prompt with its first, narrowest choice ("Allow once", or "Trust edits for this session" at the trust prompt).
// `--list` prints each call `auto` allowed without a prompt and each it asked about, for hand labelling.
// A toolCall part may carry a hand-written `label`: "hard" (must never run without a prompt) or "safe" (a reviewer would
// not mind it being allowed). The report counts labelled hard calls allowed (the gate needs 0, and the exit code says so)
// and labelled safe calls that still ask (false blocks). Unlabelled calls are only counted.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PermissionGateway } from "../packages/coding-agent/src/core/permissions/gateway.ts";
import { classifyPath } from "../packages/coding-agent/src/core/permissions/paths.ts";
import type { PermissionMode } from "../packages/coding-agent/src/core/permissions/types.ts";

interface Call {
	id: string;
	name: string;
	input: Record<string, unknown>;
	label?: string;
	/** True for the first call after a user message. */
	startsTask: boolean;
}

type Outcome = "allow" | "ask" | "deny";
interface Tally {
	counts: Record<Outcome, number>;
	bySource: Record<string, number>;
	calls: Array<{ call: Call; outcome: Outcome; source: string }>;
}

// Tools Axiom's agent has. Recordings from other harnesses carry tools Axiom never sees; they would ask and spend the budget.
const AXIOM_TOOLS = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);
const MODES: PermissionMode[] = ["manual", "accept-edits", "auto"];

function readCalls(file: string): Call[] {
	const calls: Call[] = [];
	let startsTask = false;
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (line.trim() === "") continue;
		const entry = JSON.parse(line);
		const message = entry.message;
		if (entry.type !== "message" || !message) continue;
		if (message.role === "user") startsTask = true;
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const part of message.content) {
			if (part.type !== "toolCall" || !AXIOM_TOOLS.has(part.name)) continue;
			let input: Record<string, unknown> = part.arguments ?? {};
			// Pi sessions name the path `file`; the gateway reads `path`. Anchor edits keep their anchors, which the gateway
			// does not inspect: the replay decides on the path and file class only.
			if (typeof input.file === "string" && !("path" in input)) input = { ...input, path: input.file };
			// Older sessions record `edit` as one {oldText, newText}; the replace-mode tool takes a list of them.
			if (part.name === "edit" && typeof input.oldText === "string" && !("edits" in input)) {
				input = { path: input.path, edits: [{ oldText: input.oldText, newText: input.newText }] };
			}
			calls.push({ id: part.id, name: part.name, input, label: part.label, startsTask });
			startsTask = false;
		}
	}
	return calls;
}

async function replay(calls: Call[], mode: PermissionMode, cwd: string, store: string): Promise<Tally> {
	const tally: Tally = { counts: { allow: 0, ask: 0, deny: 0 }, bySource: {}, calls: [] };
	let prompted = 0;
	const gateway = new PermissionGateway({
		getMode: () => mode,
		getCwd: () => cwd,
		getSessionId: () => "replay",
		canRequestEditTrust: () => true,
		checkpointRoot: store,
		getPrompter: () => ({
			select: async (_title, options) => {
				prompted++;
				return options[0];
			},
		}),
	});
	for (const call of calls) {
		if (call.startsTask) {
			gateway.endTask();
			gateway.beginTask();
		}
		prompted = 0;
		gateway.startToolCall(call.id);
		const block = await gateway.authorize({
			toolName: call.name,
			toolCallId: call.id,
			input: call.input,
			...(call.name === "edit" ? { builtinEdit: "replace" as const } : {}),
		});
		const source = gateway.audit.tail(1)[0]?.source ?? "none";
		// The scripted user always allows, so a block is a policy denial or the taint budget, never a refused prompt.
		const outcome: Outcome = block ? "deny" : prompted > 0 ? "ask" : "allow";
		tally.counts[outcome]++;
		tally.bySource[source] = (tally.bySource[source] ?? 0) + 1;
		tally.calls.push({ call, outcome, source });
		if (!block) gateway.finishToolCall(call.id, call.input);
		gateway.endToolCall(call.id);
	}
	return tally;
}

function describeCall(call: Call): string {
	const text = call.name === "bash" ? String(call.input.command) : `${call.name} ${String(call.input.path ?? "")}`;
	return text.replace(/\s+/g, " ").slice(0, 160);
}

const args = process.argv.slice(2);
const list = args.includes("--list");
const cwdAt = args.indexOf("--cwd");
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cwd = cwdAt === -1 ? repoRoot : resolve(args[cwdAt + 1]);
const files = args.filter((arg, at) => !arg.startsWith("--") && args[at - 1] !== "--cwd");
if (files.length === 0) {
	console.error("usage: node scripts/axiom-auto-replay.ts [--list] [--cwd <workspace>] <session.jsonl>...");
	process.exit(2);
}

// `readonly-shell` is off for an unsafe PATH, which would make the measurement silently zero.
process.env.PATH = "/usr/bin:/bin";
for (const key of ["BASH_ENV", "ENV", "POSIXLY_CORRECT"]) delete process.env[key];

let hardAllowed = 0;
const store = mkdtempSync(join(tmpdir(), "auto-replay-"));
try {
	console.log(`workspace ${cwd}\n`);
	for (const file of files) {
		const calls = readCalls(file);
		const edits = calls.filter((call) => call.name === "edit");
		const eligible = edits.filter((call) => {
			const path = typeof call.input.path === "string" ? classifyPath(call.input.path, cwd) : undefined;
			return path?.inWorkspace && !path.protected && !path.secret && !path.runsCode;
		});
		console.log(`${file}: ${calls.length} tool calls (${edits.length} edits, ${eligible.length} of them on plain workspace files)`);
		const byMode = new Map<PermissionMode, Tally>();
		for (const mode of MODES) byMode.set(mode, await replay(calls, mode, cwd, store));
		console.log("mode           allow    ask   deny   sources");
		for (const mode of MODES) {
			const { counts, bySource } = byMode.get(mode) as Tally;
			const sources = Object.entries(bySource)
				.map(([name, n]) => `${name}=${n}`)
				.join(" ");
			console.log(
				`${mode.padEnd(13)} ${String(counts.allow).padStart(6)} ${String(counts.ask).padStart(6)} ${String(counts.deny).padStart(6)}   ${sources}`,
			);
		}
		const auto = (byMode.get("auto") as Tally).calls;
		const hard = auto.filter((item) => item.call.label === "hard");
		const safe = auto.filter((item) => item.call.label === "safe");
		if (hard.length + safe.length > 0) {
			const slipped = hard.filter((item) => item.outcome === "allow");
			hardAllowed += slipped.length;
			const rules = auto.filter((item) => item.source === "auto").length;
			console.log(
				`\nlabelled in auto: hard ${hard.length}, allowed without prompt ${slipped.length} (must be 0); safe ${safe.length}, allowed ${safe.filter((item) => item.outcome === "allow").length}, asked or denied ${safe.filter((item) => item.outcome !== "allow").length} (false blocks); calls allowed by a rule (source auto): ${rules}`,
			);
			for (const item of slipped) console.log(`  HARD CALL ALLOWED: ${describeCall(item.call)}`);
			if (list) for (const item of safe.filter((entry) => entry.outcome !== "allow")) console.log(`  false block: ${describeCall(item.call)}`);
		}
		if (list) {
			console.log("\nauto, allowed without a prompt (label each by hand: any hard class here is a failure):");
			for (const entry of auto.filter((item) => item.outcome === "allow"))
				console.log(`  [${entry.source}] ${describeCall(entry.call)}`);
			console.log("\nauto, asked or denied (label each by hand: safe = a false block):");
			for (const entry of auto.filter((item) => item.outcome !== "allow"))
				console.log(`  [${entry.outcome}/${entry.source}] ${describeCall(entry.call)}`);
		}
		console.log();
	}
} finally {
	rmSync(store, { recursive: true, force: true });
}
if (hardAllowed > 0) process.exitCode = 1;
