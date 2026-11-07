#!/usr/bin/env node
// P2 live-model gate: replace vs opt-in hashline edit mode on paired coding tasks (docs/axiom/hashline-gate.md).
//
// Usage:
//   node scripts/axiom-hashline-gate.mjs validate
//   node scripts/axiom-hashline-gate.mjs run --out <file.jsonl> [--repeats 5] [--budget 5] [--seed 1]
//       [--tasks id,id] [--modes replace,hashline] [--artifacts <dir>] [--auth-from <agentDir>]
//   node scripts/axiom-hashline-gate.mjs summarize <file.jsonl>
//
// `validate` costs nothing. `run` calls the real model one trial at a time, so latency is not shared between
// trials. Each trial gets its own HOME and agent dir (copied auth.json and models-store.json, plus settings.json
// with editMode), so the only difference between the two modes of a pair is editMode.

import { spawn, spawnSync } from "node:child_process";
import {
	appendFileSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { mulberry32, shuffle, summarize } from "./hashline-gate-stats.mjs";
import { tasks as devTasks } from "./hashline-gate-tasks/tasks.mjs";
import { tasks as holdoutTasks } from "./hashline-gate-tasks/holdout.mjs";
import { tasks as frozenTasks } from "./hashline-gate-tasks/frozen-baseline.mjs";
import { tasks as holdoutV2Tasks } from "./hashline-gate-tasks/holdout-v2.mjs";

// dev: tuning set. holdout: frozen before the stale-recovery change. holdout-v2: frozen after the ID/tag and replace EOL fixes. frozen: P0 bugfix baseline.
const TASK_SETS = { dev: devTasks, holdout: holdoutTasks, "holdout-v2": holdoutV2Tasks, frozen: frozenTasks };

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE = join(repoRoot, "packages/coding-agent/dist/bundle/cli.js");
const PROVIDER = "openai-codex";
const MODEL = "gpt-6-luna";
const MODES = ["replace", "hashline"];
const RUN_TIMEOUT_MS = 600_000;
const VERIFY_TIMEOUT_MS = 60_000;

function parseOptions(argv) {
	const options = {
		mode: argv[0],
		out: undefined,
		repeats: 5,
		budget: 5,
		seed: 1,
		taskIds: undefined,
		modes: MODES,
		taskSet: "dev",
		artifacts: "/tmp/hashline-gate/artifacts",
		authFrom: "/tmp/baseline/axiom-agent",
		summarizeFile: undefined,
	};
	const first = argv[0] === "summarize" ? 2 : 1;
	if (argv[0] === "summarize") options.summarizeFile = argv[1];
	for (let i = first; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--out") options.out = argv[++i];
		else if (arg === "--repeats") options.repeats = Number(argv[++i]);
		else if (arg === "--budget") options.budget = Number(argv[++i]);
		else if (arg === "--seed") options.seed = Number(argv[++i]);
		else if (arg === "--task-set") options.taskSet = argv[++i];
		else if (arg === "--modes") options.modes = argv[++i].split(",");
		else if (arg === "--artifacts") options.artifacts = argv[++i];
		else if (arg === "--auth-from") options.authFrom = argv[++i];
		else throw new Error(`Unknown option: ${arg}`);
	}
	return options;
}

function materialize(files, dir) {
	for (const [rel, content] of Object.entries(files)) {
		const target = join(dir, rel);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, content);
	}
}

// Every text file under dir, keyed by its path relative to dir, with forward slashes.
function readTree(dir, base = dir, out = {}) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const abs = join(dir, entry.name);
		if (entry.isDirectory()) readTree(abs, base, out);
		else out[relative(base, abs)] = readFileSync(abs, "utf8");
	}
	return out;
}

function writeChanged(dir, changed) {
	materialize(changed, dir);
}

// The stale-read case: the runner changes the file after the agent's first read of it.
function applyStale(task, dir) {
	if (!task.stale) return;
	const abs = join(dir, task.stale.path);
	writeFileSync(abs, task.stale.mutate(readFileSync(abs, "utf8")));
}

// Restores the task's test files from its definition, so an agent's edits to them cannot change the verdict.
export function restoreTests(task, dir) {
	rmSync(join(dir, "test"), { recursive: true, force: true });
	materialize(Object.fromEntries(Object.entries(task.files).filter(([rel]) => rel.startsWith("test/"))), dir);
}

// True when the test files under dir differ from the task definition: edited, added, or deleted.
export function testsTampered(task, dir) {
	const tree = readTree(dir);
	const expected = Object.entries(task.files).filter(([rel]) => rel.startsWith("test/"));
	const actual = Object.keys(tree).filter((rel) => rel.startsWith("test/"));
	return actual.length !== expected.length || expected.some(([rel, content]) => tree[rel] !== content);
}

// Bugfix verdict: the task's own tests, restored first, must run and pass. Zero tests is a failure.
export function verify(task, dir) {
	restoreTests(task, dir);
	// A parent running under node --test sets NODE_TEST_CONTEXT, which changes the child's report format.
	const env = { ...process.env };
	delete env.NODE_TEST_CONTEXT;
	const result = spawnSync("node", ["--test"], { cwd: dir, env, timeout: VERIFY_TIMEOUT_MS, encoding: "utf8" });
	const ran = /^ℹ tests (\d+)$/m.exec(result.stdout ?? "");
	return result.status === 0 && ran !== null && Number(ran[1]) > 0;
}

// Wrong-write verdict: byte-level violations of what the task must keep (empty when clean).
function violationsFor(task, dir) {
	return task.guard(readTree(dir), task.files);
}

function parseUsage(events) {
	const usage = { input: 0, output: 0, totalTokens: 0, cost: 0, billed: true, assistantMessages: 0, model: undefined };
	let lastText = "";
	for (const event of events) {
		if (event.type !== "message_end" || event.message?.role !== "assistant") continue;
		const message = event.message;
		usage.assistantMessages++;
		usage.input += message.usage?.input ?? 0;
		usage.output += message.usage?.output ?? 0;
		usage.totalTokens += message.usage?.totalTokens ?? 0;
		usage.cost += message.usage?.cost?.total ?? 0;
		if (message.usage?.cost?.totalFromProvider !== true) usage.billed = false;
		usage.model ??= message.model;
		const text = (message.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
		if (text) lastText = text;
	}
	return { usage, lastText };
}

function resultText(result) {
	const blocks = Array.isArray(result?.content) ? result.content : [];
	return blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n").slice(0, 400);
}

// Per-run measurements from the JSON event stream: tool calls, edit outcomes, the stale-read injection.
function measure(events, injection) {
	const { usage, lastText } = parseUsage(events);
	const toolCalls = {};
	let firstEditIndex = -1;
	const editResults = [];
	events.forEach((event, index) => {
		if (event.type === "tool_execution_start") {
			toolCalls[event.toolName] = (toolCalls[event.toolName] ?? 0) + 1;
			if (event.toolName === "edit" && firstEditIndex < 0) firstEditIndex = index;
		}
		if (event.type === "tool_execution_end" && event.toolName === "edit") {
			editResults.push({ isError: event.isError === true, text: resultText(event.result) });
		}
	});
	return {
		usage,
		lastText: lastText.slice(-1500),
		toolCalls,
		editCalls: editResults.length,
		editErrors: editResults.filter((r) => r.isError).length,
		editErrorSamples: editResults.filter((r) => r.isError).slice(0, 3).map((r) => r.text),
		stale: {
			injected: injection !== undefined,
			editAfterInjection: injection !== undefined && firstEditIndex > injection.eventIndex,
		},
	};
}

function runAgent(task, mode, workdir, runDir, options) {
	const home = join(runDir, "home");
	const agent = join(runDir, "agent");
	mkdirSync(home, { recursive: true });
	mkdirSync(agent, { recursive: true });
	for (const name of ["auth.json", "models-store.json"]) {
		if (existsSync(join(options.authFrom, name))) copyFileSync(join(options.authFrom, name), join(agent, name));
	}
	writeFileSync(join(agent, "settings.json"), `${JSON.stringify({ editMode: mode })}\n`);
	const argv = [BUNDLE, "--mode", "json", "-p", task.prompt, "--provider", PROVIDER, "--model", MODEL, "--no-session"];
	const env = { ...process.env, HOME: home, AXIOM_CODING_AGENT_DIR: agent };
	const started = performance.now();
	const events = [];
	const staleCallIds = new Set();
	let injection;
	const handle = (event) => {
		if (!task.stale) return;
		if (event.type === "tool_execution_start" && event.toolName === "read" && typeof event.args?.path === "string") {
			if (resolve(workdir, event.args.path) === resolve(workdir, task.stale.path)) staleCallIds.add(event.toolCallId);
		}
		if (!injection && event.type === "tool_execution_end" && staleCallIds.has(event.toolCallId) && !event.isError) {
			applyStale(task, workdir);
			injection = { eventIndex: events.length, atMs: Math.round(performance.now() - started) };
		}
	};
	return new Promise((resolveRun) => {
		const child = spawn("node", argv, { cwd: workdir, env, stdio: ["ignore", "pipe", "pipe"] });
		let stdoutBuffer = "";
		let stderr = "";
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, RUN_TIMEOUT_MS);
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdoutBuffer += chunk;
			let newline = stdoutBuffer.indexOf("\n");
			while (newline >= 0) {
				const line = stdoutBuffer.slice(0, newline);
				stdoutBuffer = stdoutBuffer.slice(newline + 1);
				if (line.trim()) {
					try {
						const event = JSON.parse(line);
						event._tMs = Math.round(performance.now() - started);
						events.push(event);
						handle(event);
					} catch {
						// Non-JSON stdout lines are kept out of the event log; stderr is recorded separately.
					}
				}
				newline = stdoutBuffer.indexOf("\n");
			}
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolveRun({ exit: timedOut ? "timeout" : code, wallMs: Math.round(performance.now() - started), events, stderr, injection, timedOut });
		});
	});
}

async function runOne(step, options) {
	const { task, mode, repeat } = step;
	const runId = `${task.id}-${mode}-r${repeat}`;
	const runDir = join(options.artifacts, runId);
	const workdir = join(runDir, "work");
	rmSync(runDir, { recursive: true, force: true });
	mkdirSync(workdir, { recursive: true });
	materialize(task.files, workdir);
	const agent = await runAgent(task, mode, workdir, runDir, options);
	const measured = measure(agent.events, agent.injection);
	const tampered = testsTampered(task, workdir);
	const pass = verify(task, workdir);
	// A stale task whose change never happened has no sentinel to check: the case was not exercised, not a wrong write.
	const violations = task.stale && !measured.stale.injected ? [] : violationsFor(task, workdir);
	writeFileSync(join(runDir, "events.jsonl"), agent.events.map((e) => JSON.stringify(e)).join("\n") + "\n");
	writeFileSync(join(runDir, "stderr.txt"), agent.stderr);
	// Credentials can rotate on refresh; keep the source copy current, then drop the per-run copies.
	const rotated = join(runDir, "agent", "auth.json");
	if (existsSync(rotated) && readFileSync(rotated, "utf8") !== readFileSync(join(options.authFrom, "auth.json"), "utf8")) {
		copyFileSync(rotated, join(options.authFrom, "auth.json"));
	}
	rmSync(join(runDir, "agent"), { recursive: true, force: true });
	rmSync(join(runDir, "home"), { recursive: true, force: true });
	return {
		runId,
		task: task.id,
		category: task.category,
		mode,
		repeat,
		agentExit: agent.exit,
		timedOut: agent.timedOut,
		wallMs: agent.wallMs,
		tokens: measured.usage.totalTokens,
		input: measured.usage.input,
		output: measured.usage.output,
		cost: measured.usage.cost,
		costBilled: measured.usage.billed,
		model: measured.usage.model,
		toolCalls: measured.toolCalls,
		editCalls: measured.editCalls,
		editErrors: measured.editErrors,
		editErrorSamples: measured.editErrorSamples,
		stale: measured.stale,
		pass,
		testsTampered: tampered,
		violations,
		lastAssistantText: measured.lastText,
		artifactDir: runDir,
	};
}

// Pairs (task, repeat) are shuffled; within each pair the mode order is random too.
function schedule(selected, modes, repeats, seed) {
	const random = mulberry32(seed);
	const pairs = [];
	for (let repeat = 1; repeat <= repeats; repeat++) for (const task of selected) pairs.push({ task, repeat });
	shuffle(pairs, random);
	const plan = [];
	for (const pair of pairs) {
		const order = shuffle([...modes], random);
		for (const mode of order) plan.push({ task: pair.task, repeat: pair.repeat, mode });
	}
	return plan;
}

function validate() {
	let ok = true;
	for (const task of Object.values(TASK_SETS).flat()) {
		const dir = mkdtempSync(join(tmpdir(), `hl-validate-${task.id}-`));
		materialize(task.files, dir);
		applyStale(task, dir);
		const failsBefore = !verify(task, dir);
		writeChanged(dir, task.oracle(readTree(dir)));
		const passesAfter = verify(task, dir);
		const guardClean = violationsFor(task, dir).length === 0;
		rmSync(dir, { recursive: true, force: true });

		const corruptDir = mkdtempSync(join(tmpdir(), `hl-corrupt-${task.id}-`));
		materialize(task.files, corruptDir);
		applyStale(task, corruptDir);
		if (task.corrupt) writeChanged(corruptDir, task.corrupt(readTree(corruptDir)));
		const corruptFlagged = task.corrupt ? violationsFor(task, corruptDir).length > 0 : true;
		rmSync(corruptDir, { recursive: true, force: true });

		const good = failsBefore && passesAfter && guardClean && corruptFlagged;
		ok &&= good;
		process.stdout.write(
			`${good ? "ok  " : "FAIL"} ${task.id.padEnd(26)} fails-before=${failsBefore} passes-after=${passesAfter} guard-clean=${guardClean} corrupt-flagged=${corruptFlagged}\n`,
		);
	}
	process.stdout.write(ok ? "validate: all tasks verified\n" : "validate: FAILED\n");
	process.exitCode = ok ? 0 : 1;
}

async function run(options) {
	if (!options.out) throw new Error("run needs --out <file.jsonl>");
	if (!existsSync(BUNDLE)) throw new Error(`missing ${BUNDLE}; run bun run build in packages/coding-agent`);
	if (!TASK_SETS[options.taskSet]) throw new Error(`unknown --task-set ${options.taskSet}`);
	const selected = TASK_SETS[options.taskSet].filter((t) => !options.taskIds || options.taskIds.includes(t.id));
	if (selected.length === 0) throw new Error("no tasks selected");
	mkdirSync(options.artifacts, { recursive: true });
	writeFileSync(options.out, "");
	const plan = schedule(selected, options.modes, options.repeats, options.seed);
	process.stdout.write(`plan: ${plan.length} trials (${selected.length} tasks, ${options.modes.join("/")}, ${options.repeats} repeats, seed ${options.seed})\n`);
	let spent = 0;
	for (const step of plan) {
		if (spent >= options.budget) {
			process.stdout.write(`budget reached (estimated $${spent.toFixed(4)} >= $${options.budget}); stopping\n`);
			return;
		}
		const record = await runOne(step, options);
		spent += record.cost;
		appendFileSync(options.out, `${JSON.stringify(record)}\n`);
		const edits = `edits=${record.editCalls - record.editErrors}/${record.editCalls}`;
		process.stdout.write(
			`${record.runId}: exit=${record.agentExit} pass=${record.pass} wrong=${record.violations.length} ${edits} tokens=${record.tokens} wall=${record.wallMs}ms spent=$${spent.toFixed(4)}\n`,
		);
	}
	process.stdout.write(`done: estimated $${spent.toFixed(4)}\n`);
}

// Runs the CLI only when executed directly, so tests can import the verdict helpers.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const options = parseOptions(process.argv.slice(2));
	if (options.mode === "validate") validate();
	else if (options.mode === "run") await run(options);
	else if (options.mode === "summarize") summarize(options.summarizeFile);
	else throw new Error("Usage: axiom-hashline-gate.mjs validate | run --out <file.jsonl> | summarize <file.jsonl>");
}
