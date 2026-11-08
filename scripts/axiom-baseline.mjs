#!/usr/bin/env node
// Paid-API-free baseline for a Pi-derived checkout, run from source (or the built bundle with --bundle).
// Measures cold startup, peak RSS, system-prompt and tool-schema bytes, RPC per-turn latency with the
// keyless faux provider, and runs parity probes (--version, --help, built-in tool schemas) that can be diffed
// between checkouts. Each run uses a fresh temp HOME, agent dir and cwd; the real ~/.pi and ~/.axiom are never read.
//
// Usage: node scripts/axiom-baseline.mjs <repoDir> [--runs N=10] [--warmup N=1] [--turns N=30] [--bundle] [--json out.json]

import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { arch, cpus, release, totalmem, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const SCRIPT_VERSION = 1;
const MODEL = "faux/faux-1";
const TIME_BIN = "/usr/bin/time";
const CHILD_TIMEOUT_MS = 120_000;
const TURN_TIMEOUT_MS = 30_000;
const TOOLS_ALL = "read,bash,powershell,edit,write,grep,find,ls";
const FAUX_EXTENSION = `import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";

export default function (pi) {
	const faux = fauxProvider();
	faux.setResponses(Array.from({ length: 1000 }, () => () => fauxAssistantMessage("ok")));
	pi.registerProvider(faux.provider);
}
`;

const { repoArg, options } = parseArgs(process.argv.slice(2));
const repoDir = resolve(repoArg);
const pkgDir = join(repoDir, "packages", "coding-agent");
const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
const binEntries = typeof pkg.bin === "string" ? { [pkg.name]: pkg.bin } : (pkg.bin ?? {});
const binName = Object.keys(binEntries)[0];
const appName = pkg.piConfig?.name || "pi";
const agentDirEnv = `${appName.toUpperCase()}_CODING_AGENT_DIR`;
const resolverPath = join(pkgDir, "src", "experimental", "source-resolver.ts");
const sourceEntry = join(pkgDir, "src", "cli.ts");
const bundleEntry = join(pkgDir, binEntries[binName] ?? "dist/bundle/cli.js");
const entry = options.bundle ? bundleEntry : sourceEntry;
if (!existsSync(entry)) fail(`CLI entry not found: ${entry} (run bun run hydrate:model-data; --bundle needs bun run build)`);
if (!options.bundle && !existsSync(resolverPath)) fail(`source resolver not found: ${resolverPath}`);
const hasTimeBin = existsSync(TIME_BIN);

const commandLog = [];
const nodePrefix = options.bundle ? [] : ["--import", pathToFileURL(resolverPath).href];

const raw = { startupWallMs: [], startupTotalMs: [], rssStartupMb: [], rssRpcMb: [], systemPromptBytes: [], toolSchemaBytes: [], rpcFirstTurnMs: [], rpcTurnMs: [], rpcTurnOkCount: 0, rpcTurnTotal: 0, startupOkCount: 0, startupExitCodes: [] };
const schemaSummary = [];

const meta = collectMeta();
const parityWork = await runParity();

const total = options.runs + options.warmup;
for (let i = 0; i < total; i++) {
	const measured = i >= options.warmup;
	const r = await runOne(i);
	if (!measured) continue;
	raw.startupWallMs.push(r.startupWallMs);
	raw.startupTotalMs.push(r.startupTotalMs);
	raw.rssStartupMb.push(r.rssStartupMb);
	raw.rssRpcMb.push(r.rssRpcMb);
	raw.systemPromptBytes.push(r.systemPromptBytes);
	raw.toolSchemaBytes.push(r.toolSchemaBytes);
	raw.rpcFirstTurnMs.push(r.rpcTurns[0]?.ms ?? null);
	raw.rpcTurnMs.push(r.rpcTurns.slice(1).map((t) => t.ms));
	raw.rpcTurnOkCount += r.rpcTurns.filter((t) => t.text === "ok").length;
	raw.rpcTurnTotal += r.rpcTurns.length;
	raw.startupOkCount += r.startupOk ? 1 : 0;
	raw.startupExitCodes.push(r.startupExit);
	schemaSummary.push(r.schemaNames);
}

const pooledTurns = raw.rpcTurnMs.flat();
const result = {
	schema: "axiom-baseline/1",
	scriptVersion: SCRIPT_VERSION,
	generatedAt: new Date().toISOString(),
	meta: { ...meta, runs: options.runs, warmup: options.warmup, turnsPerRun: options.turns, model: MODEL, mode: options.bundle ? "bundle" : "source", entry: relative(entry), commands: commandLog },
	measured: {
		startupWallMs: stats(raw.startupWallMs),
		startupTotalMs_PI_TIMING_main: stats(raw.startupTotalMs.filter((v) => v !== null)),
		peakRssStartupMb: stats(raw.rssStartupMb.filter((v) => v !== null)),
		peakRssRpcMb: stats(raw.rssRpcMb.filter((v) => v !== null)),
		systemPromptBytes: stats(raw.systemPromptBytes.filter((v) => v !== null)),
		toolSchemaBytes: stats(raw.toolSchemaBytes.filter((v) => v !== null)),
		rpcFirstTurnMs: stats(raw.rpcFirstTurnMs.filter((v) => v !== null)),
		rpcTurnMs_pooled_excluding_first: stats(pooledTurns),
		rpcPerRunP50Ms: stats(raw.rpcTurnMs.map((t) => percentile(t, 50)).filter((v) => v !== null)),
		rpcPerRunP90Ms: stats(raw.rpcTurnMs.map((t) => percentile(t, 90)).filter((v) => v !== null)),
	},
	estimates: {
		label: "ESTIMATE ceil(bytes/4); not a tokenizer count, not provider usage",
		systemPromptTokensEst: stats(raw.systemPromptBytes.filter((v) => v !== null).map(tokenEst)),
		toolSchemaTokensEst: stats(raw.toolSchemaBytes.filter((v) => v !== null).map(tokenEst)),
	},
	parity: parityWork,
	outcome: {
		startupExitCodes: raw.startupExitCodes,
		startupRunsWithExpectedOutput: `${raw.startupOkCount}/${options.runs}`,
		rpcTurnsWithExpectedText: `${raw.rpcTurnOkCount}/${raw.rpcTurnTotal}`,
		toolNamesPerRun: schemaSummary,
	},
	raw,
};

if (options.jsonOut) writeFileSync(resolve(options.jsonOut), JSON.stringify(result, null, 2) + "\n");
printSummary(result);

// ---------------------------------------------------------------------------

async function runOne(index) {
	const tmp = mkdtempSync(join(tmpdir(), "axiom-baseline-"));
	try {
		const home = join(tmp, "home");
		const agentDir = join(tmp, "agent");
		const cwd = join(tmp, "cwd");
		for (const d of [home, agentDir, cwd, join(tmp, "tmp")]) mkdirSync(d, { recursive: true });
		const extPath = join(tmp, "faux-ext.ts");
		writeFileSync(extPath, FAUX_EXTENSION);
		const env = makeEnv(tmp, home, agentDir, { PI_TIMING: "1" });
		const common = ["--offline", "--no-session", "-ne", "-e", extPath, "--model", MODEL];
		const rssFile = join(tmp, "rss-startup.txt");

		const startArgs = [...nodeArgv(), "-p", "hi", ...common];
		const startup = await runChild(wrapTime(startArgv(startArgs), rssFile), { env, cwd, stdin: "ignore", label: "startup" });
		const rssStartupMb = readRssMb(rssFile);
		const startupOk = startup.code === 0 && startup.stdout.includes("ok");
		const startupTotalMs = parseMainTotal(startup.stderr);

		const jsonArgs = [...nodeArgv(), "--mode", "json", "-p", "hi", ...common];
		const schemaRun = await runChild(startArgv(jsonArgs), { env: makeEnv(tmp, home, agentDir, {}), cwd, stdin: "ignore", label: "schema" });
		const sys = findSystemMessage(schemaRun.stdout);
		const systemPromptBytes = sys ? Object.values(sys.sections ?? {}).reduce((n, s) => n + Buffer.byteLength(String(s), "utf8"), 0) : null;
		const toolSchemaBytes = sys?.toolsAdded ? Buffer.byteLength(JSON.stringify(sys.toolsAdded), "utf8") : null;
		const schemaNames = sys?.toolsAdded ? sys.toolsAdded.map((t) => t.name) : null;

		const rpcRssFile = join(tmp, "rss-rpc.txt");
		const rpcArgs = [...nodeArgv(), "--mode", "rpc", ...common];
		const rpc = await runRpc(wrapTime(startArgv(rpcArgs), rpcRssFile), { env: makeEnv(tmp, home, agentDir, {}), cwd, turns: options.turns, label: "rpc" });
		const rssRpcMb = readRssMb(rpcRssFile);

		return {
			startupWallMs: startup.wallMs,
			startupExit: startup.code,
			startupOk,
			startupTotalMs,
			rssStartupMb,
			rssRpcMb,
			systemPromptBytes,
			toolSchemaBytes,
			schemaNames,
			rpcTurns: rpc.turns,
		};
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

async function runParity() {
	const tmp = mkdtempSync(join(tmpdir(), "axiom-parity-"));
	try {
		const home = join(tmp, "home");
		const agentDir = join(tmp, "agent");
		const cwd = join(tmp, "cwd");
		for (const d of [home, agentDir, cwd, join(tmp, "tmp")]) mkdirSync(d, { recursive: true });
		const extPath = join(tmp, "faux-ext.ts");
		writeFileSync(extPath, FAUX_EXTENSION);
		const env = makeEnv(tmp, home, agentDir, {});

		const version = await runChild(startArgv([...nodeArgv(), "--version"]), { env, cwd, stdin: "ignore", label: "version" });
		const help = await runChild(startArgv([...nodeArgv(), "--help"]), { env, cwd, stdin: "ignore", label: "help" });
		const tools = await runChild(startArgv([...nodeArgv(), "--mode", "json", "-p", "hi", "--offline", "--no-session", "-ne", "-e", extPath, "--model", MODEL, "--tools", TOOLS_ALL]), { env, cwd, stdin: "ignore", label: "tools" });
		const sys = findSystemMessage(tools.stdout);
		const perTool = (sys?.toolsAdded ?? []).map((t) => ({ name: t.name, schemaSha256: sha(JSON.stringify(t)), bytes: Buffer.byteLength(JSON.stringify(t), "utf8") })).sort((a, b) => a.name.localeCompare(b.name));
		return {
			version: { exit: version.code, stdout: version.stdout.trim(), stderrLines: lines(version.stderr) },
			help: { exit: help.code, stdoutBytes: Buffer.byteLength(help.stdout, "utf8"), stdoutSha256: sha(help.stdout), firstLine: lines(help.stdout)[0] ?? "" },
			builtinTools: { requested: TOOLS_ALL, exit: tools.code, names: perTool.map((t) => t.name), perToolSchemaSha256: perTool, allSha256: sha(JSON.stringify(perTool)), stderrLines: lines(tools.stderr).slice(0, 5) },
		};
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------

function parseArgs(argv) {
	const opts = { runs: 10, warmup: 1, turns: 30, bundle: false, jsonOut: undefined };
	let repo;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--runs") opts.runs = positiveInt(argv[++i], a);
		else if (a === "--warmup") opts.warmup = nonNegativeInt(argv[++i], a);
		else if (a === "--turns") opts.turns = positiveInt(argv[++i], a);
		else if (a === "--json") opts.jsonOut = argv[++i];
		else if (a === "--bundle") opts.bundle = true;
		else if (a.startsWith("--")) fail(`unknown flag ${a}`);
		else if (repo === undefined) repo = a;
		else fail(`unexpected argument ${a}`);
	}
	if (repo === undefined) fail("usage: node scripts/axiom-baseline.mjs <repoDir> [--runs N] [--warmup N] [--turns N] [--bundle] [--json out.json]");
	return { repoArg: repo, options: opts };
}

function positiveInt(v, flag) {
	const n = Number(v);
	if (!Number.isInteger(n) || n < 1) fail(`${flag} needs a positive integer`);
	return n;
}

function nonNegativeInt(v, flag) {
	const n = Number(v);
	if (!Number.isInteger(n) || n < 0) fail(`${flag} needs a non-negative integer`);
	return n;
}

function fail(message) {
	process.stderr.write(`axiom-baseline: ${message}\n`);
	process.exit(1);
}

function nodeArgv() {
	return [...nodePrefix, entry];
}

function startArgv(args) {
	return [process.execPath, ...args];
}

function wrapTime(argv, rssFile) {
	if (!hasTimeBin) return argv;
	return [TIME_BIN, "-f", "%M", "-o", rssFile, ...argv];
}

function makeEnv(tmp, home, agentDir, extra) {
	const env = {
		PATH: process.env.PATH ?? "",
		LANG: "C",
		LC_ALL: "C",
		TZ: "UTC",
		TERM: "dumb",
		NO_COLOR: "1",
		HOME: home,
		XDG_CONFIG_HOME: join(home, ".config"),
		XDG_CACHE_HOME: join(home, ".cache"),
		XDG_DATA_HOME: join(home, ".local", "share"),
		TMPDIR: join(tmp, "tmp"),
		PI_OFFLINE: "1",
		PI_SKIP_VERSION_CHECK: "1",
		PI_TELEMETRY: "0",
		[agentDirEnv]: agentDir,
	};
	return { ...env, ...extra };
}

function runChild(argv, { env, cwd, stdin, label }) {
	recordCommand(label, argv, cwd);
	return new Promise((resolveP, rejectP) => {
		const started = performance.now();
		const child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: [stdin, "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (c) => (stdout += c));
		child.stderr.on("data", (c) => (stderr += c));
		const timer = setTimeout(() => child.kill("SIGKILL"), CHILD_TIMEOUT_MS);
		child.on("error", (e) => {
			clearTimeout(timer);
			rejectP(e);
		});
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			resolveP({ code: code ?? `signal:${signal}`, stdout, stderr, wallMs: performance.now() - started });
		});
	});
}

function runRpc(argv, { env, cwd, turns, label }) {
	recordCommand(label, argv, cwd, `(then ${turns} prompt commands, each waits for agent_end)`);
	return new Promise((resolveP, rejectP) => {
		const child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
		const results = [];
		let buffer = "";
		let stderr = "";
		let pending;
		let sent = 0;
		let timer;
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (c) => (stderr += c));
		child.stdout.on("data", (chunk) => {
			buffer += chunk;
			let nl;
			while ((nl = buffer.indexOf("\n")) !== -1) {
				const line = buffer.slice(0, nl);
				buffer = buffer.slice(nl + 1);
				handleLine(line);
			}
		});
		child.on("error", (e) => {
			clearTimeout(timer);
			rejectP(e);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolveP({ code: code ?? "signal", turns: results, stderr });
		});

		function handleLine(line) {
			if (!line.trim() || !pending) return;
			let ev;
			try {
				ev = JSON.parse(line);
			} catch {
				return;
			}
			if (ev.type === "message_end" && ev.message?.role === "assistant") pending.text = textOf(ev.message);
			if (ev.type === "agent_end") {
				clearTimeout(timer);
				results.push({ ms: performance.now() - pending.t0, text: pending.text });
				pending = undefined;
				sendNext();
			}
		}

		function sendNext() {
			if (sent >= turns) {
				child.stdin.end();
				return;
			}
			sent++;
			pending = { t0: performance.now(), text: "" };
			timer = setTimeout(() => child.kill("SIGKILL"), TURN_TIMEOUT_MS);
			child.stdin.write(`${JSON.stringify({ id: `turn-${sent}`, type: "prompt", message: `turn ${sent}` })}\n`);
		}

		sendNext();
	});
}

function recordCommand(label, argv, cwd, note) {
	if (commandLog.some((c) => c.label === label)) return;
	const quoted = argv.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : JSON.stringify(a)));
	commandLog.push({ label, cwd: "<temp>", command: quoted.map((a) => a.replaceAll(process.execPath, "node")).join(" "), note });
}

function findSystemMessage(stdout) {
	for (const line of stdout.split("\n")) {
		if (!line.trim()) continue;
		let ev;
		try {
			ev = JSON.parse(line);
		} catch {
			continue;
		}
		if (ev.type === "message_end" && ev.message?.role === "system") return ev.message;
	}
	return undefined;
}

function textOf(message) {
	return (message.content ?? [])
		.filter((b) => b.type === "text")
		.map((b) => b.text)
		.join("");
}

function parseMainTotal(stderr) {
	const block = stderr.split("Startup Timings: main")[1]?.split("Startup Timings:")[0];
	if (!block) return null;
	const m = /TOTAL:\s*([\d.]+)ms/.exec(block);
	return m ? Number(m[1]) : null;
}

function readRssMb(file) {
	if (!hasTimeBin || !existsSync(file)) return null;
	const kb = Number(readFileSync(file, "utf8").trim().split("\n").pop());
	return Number.isFinite(kb) ? kb / 1024 : null;
}

function tokenEst(bytes) {
	return Math.ceil(bytes / 4);
}

function sha(text) {
	return createHash("sha256").update(text).digest("hex");
}

function lines(text) {
	return text.split("\n").filter((l) => l.trim() !== "");
}

function relative(p) {
	return p.startsWith(repoDir + "/") ? p.slice(repoDir.length + 1) : p;
}

function percentile(values, p) {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const rank = (p / 100) * (sorted.length - 1);
	const lo = Math.floor(rank);
	const hi = Math.ceil(rank);
	return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

function stats(values) {
	if (values.length === 0) return { n: 0 };
	const round = (v) => Math.round(v * 100) / 100;
	return {
		n: values.length,
		median: round(percentile(values, 50)),
		min: round(Math.min(...values)),
		max: round(Math.max(...values)),
		p90: round(percentile(values, 90)),
	};
}

function git(args) {
	try {
		return execFileSync("git", ["-C", repoDir, ...args], { encoding: "utf8" }).trim();
	} catch {
		return null;
	}
}

function osRelease() {
	try {
		const m = /^PRETTY_NAME="?([^"\n]+)"?/m.exec(readFileSync("/etc/os-release", "utf8"));
		return m ? m[1] : null;
	} catch {
		return null;
	}
}

function collectMeta() {
	const status = (git(["status", "--porcelain", "--untracked-files=no"]) ?? "").split("\n").filter(Boolean);
	const model = cpus()[0]?.model ?? null;
	return {
		repoDir,
		git: {
			sha: git(["rev-parse", "HEAD"]),
			branch: git(["rev-parse", "--abbrev-ref", "HEAD"]),
			dirtyTracked: status.length > 0,
			dirtyTrackedFiles: status,
			dirtyUnderPackages: status.some((l) => l.slice(3).startsWith("packages/")),
		},
		bin: { name: binName, all: binEntries },
		appName,
		agentDirEnv,
		hardware: { cpuModel: model, cores: cpus().length, ramGb: Math.round((totalmem() / 2 ** 30) * 10) / 10, arch: arch(), kernel: release(), osRelease: osRelease() },
		node: process.version,
		platform: process.platform,
		date: new Date().toISOString(),
		timeBinAvailable: hasTimeBin,
	};
}

function printSummary(r) {
	const row = (name, s, unit) => (s?.n ? `${name.padEnd(36)} median ${String(s.median).padStart(9)} min ${String(s.min).padStart(9)} max ${String(s.max).padStart(9)} p90 ${String(s.p90).padStart(9)} ${unit} (n=${s.n})` : `${name.padEnd(36)} n/a`);
	const m = r.measured;
	const out = [
		`axiom-baseline ${r.meta.repoDir} @ ${r.meta.git.sha?.slice(0, 9)} dirtyTracked=${r.meta.git.dirtyTracked} bin=${r.meta.bin.name} app=${r.meta.appName}`,
		row("startup wall", m.startupWallMs, "ms"),
		row("startup TOTAL (PI_TIMING main)", m.startupTotalMs_PI_TIMING_main, "ms"),
		row("peak RSS startup", m.peakRssStartupMb, "MB"),
		row("peak RSS rpc process", m.peakRssRpcMb, "MB"),
		row("system prompt bytes", m.systemPromptBytes, "B"),
		row("tool schema bytes (default set)", m.toolSchemaBytes, "B"),
		row("rpc first turn", m.rpcFirstTurnMs, "ms"),
		row("rpc turn (pooled, excl. first)", m.rpcTurnMs_pooled_excluding_first, "ms"),
		`outcome: exit ${r.outcome.startupExitCodes.join(",")}; expected output ${r.outcome.startupRunsWithExpectedOutput}; rpc turns ok ${r.outcome.rpcTurnsWithExpectedText}`,
		`parity: --version exit ${r.parity.version.exit} "${r.parity.version.stdout}"; --help exit ${r.parity.help.exit}; builtin tools [${r.parity.builtinTools.names.join(", ")}] all=${r.parity.builtinTools.allSha256.slice(0, 12)}`,
	];
	process.stdout.write(out.join("\n") + "\n");
}
