import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { importPiAgentDir, runPiDataImport } from "../src/pi-data-import.ts";

const posixOnly = process.platform === "win32" || process.getuid?.() === 0 ? it.skip : it;
const tempDirs: string[] = [];

function tempDir(): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-data-import-")));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	for (const dir of tempDirs.splice(0)) {
		for (const path of walk(dir)) {
			if (lstatSync(path).isDirectory()) chmodSync(path, 0o700);
		}
		rmSync(dir, { recursive: true, force: true });
	}
});

function walk(dir: string): string[] {
	const paths = [dir];
	if (!lstatSync(dir).isDirectory()) return paths;
	try {
		chmodSync(dir, 0o700);
	} catch {}
	for (const name of readdirSync(dir)) paths.push(...walk(join(dir, name)));
	return paths;
}

/** Paths, types, modes, mtimes, contents and link texts of a tree, for byte-level comparison. */
function snapshot(dir: string): Record<string, string> {
	const result: Record<string, string> = {};
	const visit = (path: string, rel: string): void => {
		const stats = lstatSync(path);
		const meta = `${stats.mode}:${Math.floor(stats.mtimeMs)}`;
		if (stats.isSymbolicLink()) result[rel] = `link:${readlinkSync(path)}`;
		else if (stats.isDirectory()) {
			result[rel] = `dir:${meta}`;
			if ((stats.mode & 0o500) === 0o500) {
				for (const name of readdirSync(path).sort()) visit(join(path, name), `${rel}/${name}`);
			}
		} else if (stats.isFile()) {
			const hash =
				(stats.mode & 0o400) === 0 ? "unreadable" : createHash("sha256").update(readFileSync(path)).digest("hex");
			result[rel] = `file:${meta}:${hash}`;
		} else result[rel] = `special:${meta}`;
	};
	visit(dir, ".");
	return result;
}

function writePiDir(dir: string): void {
	mkdirSync(join(dir, "sessions", "--home--"), { recursive: true });
	writeFileSync(join(dir, "settings.json"), '{"theme":"dark"}\n');
	writeFileSync(join(dir, "sessions", "--home--", "a.jsonl"), '{"type":"session"}\n');
}

describe("importPiAgentDir", () => {
	it("copies the tree byte-equal, keeps nested lock files and drops top-level excludes", () => {
		const root = tempDir();
		const source = join(root, "pi");
		const target = join(root, "axiom", "agent");
		writePiDir(source);
		mkdirSync(join(source, "npm", "node_modules", "pkg"), { recursive: true });
		writeFileSync(join(source, "npm", "node_modules", "pkg", "index.js"), "export {};\n");
		mkdirSync(join(source, "git", "r"), { recursive: true });
		writeFileSync(join(source, "git", "r", "yarn.lock"), "lock\n");
		writeFileSync(join(source, "ünï cødé name.md"), "x");
		for (const name of ["pi-debug.log", "pi-tui-debug.log", "pi-tui-crash.log", "crashes.json", "mcp-auth.json"]) {
			writeFileSync(join(source, name), "{}");
		}
		mkdirSync(join(source, "tmp", "extensions"), { recursive: true });
		mkdirSync(join(source, "settings.json.lock"));

		const result = importPiAgentDir(source, target);

		expect(result).toMatchObject({ kind: "imported", files: 5, skipped: [], droppedOAuth: [] });
		expect(readFileSync(join(target, "git", "r", "yarn.lock"), "utf8")).toBe("lock\n");
		expect(readFileSync(join(target, "ünï cødé name.md"), "utf8")).toBe("x");
		expect(readFileSync(join(target, "npm", "node_modules", "pkg", "index.js"), "utf8")).toBe("export {};\n");
		for (const name of [
			"pi-debug.log",
			"pi-tui-debug.log",
			"pi-tui-crash.log",
			"crashes.json",
			"mcp-auth.json",
			"tmp",
			"settings.json.lock",
		]) {
			expect(existsSync(join(target, name))).toBe(false);
		}
		expect(readdirSync(join(root, "axiom"))).toEqual(["agent"]);
	});

	it("copies a relative link that resolves outside the target tree as file content, not as a link", () => {
		const root = tempDir();
		const source = join(root, "pi");
		const target = join(root, "axiom", "agent");
		writePiDir(source);
		mkdirSync(join(source, "sub"));
		writeFileSync(join(source, "models.json"), '{"providers":{}}\n');
		// Inside the source tree; from the target's sub dir it points at root/axiom/pi/models.json.
		symlinkSync("../../pi/models.json", join(source, "sub", "esc.json"));

		expect(importPiAgentDir(source, target)).toMatchObject({ kind: "imported", skipped: [] });
		expect(lstatSync(join(target, "sub", "esc.json")).isSymbolicLink()).toBe(false);
		expect(readFileSync(join(target, "sub", "esc.json"), "utf8")).toBe('{"providers":{}}\n');
	});

	it("keeps a relative link that leaves the tree and re-enters it by name", () => {
		const root = tempDir();
		const source = join(root, "pi", "agent");
		const target = join(root, "axiom", "agent");
		writePiDir(source);
		mkdirSync(join(source, "ext"));
		symlinkSync("../../agent/settings.json", join(source, "ext", "settings-link.json"));

		expect(importPiAgentDir(source, target)).toMatchObject({ kind: "imported", skipped: [] });
		expect(readlinkSync(join(target, "ext", "settings-link.json"))).toBe("../../agent/settings.json");
		expect(readFileSync(join(target, "ext", "settings-link.json"), "utf8")).toBe('{"theme":"dark"}\n');
	});

	it("does not copy auth.json or mcp-auth.json through an absolute link", () => {
		const root = tempDir();
		const source = join(root, "pi");
		const target = join(root, "axiom", "agent");
		writePiDir(source);
		writeFileSync(join(source, "auth.json"), '{"a":{"type":"oauth","access":"A","refresh":"R","expires":1}}\n');
		writeFileSync(join(source, "mcp-auth.json"), '{"tok":1}\n');
		symlinkSync(join(source, "auth.json"), join(source, "auth.bak"));
		symlinkSync(join(source, "mcp-auth.json"), join(source, "mcp-link"));

		expect(importPiAgentDir(source, target)).toMatchObject({
			kind: "imported",
			skipped: [
				{ path: "auth.bak", reason: "symlink" },
				{ path: "mcp-link", reason: "symlink" },
			],
		});
		expect(existsSync(join(target, "auth.json"))).toBe(false);
		expect(existsSync(join(target, "auth.bak"))).toBe(false);
		expect(existsSync(join(target, "mcp-link"))).toBe(false);
	});

	it("copies a non-JSON auth.json byte for byte, including invalid UTF-8", () => {
		const root = tempDir();
		const source = join(root, "pi");
		const target = join(root, "axiom", "agent");
		writePiDir(source);
		const bytes = Buffer.from([0x7b, 0x22, 0x6b, 0x22, 0x3a, 0xff, 0x7d]); // {"k":<0xff>}
		writeFileSync(join(source, "auth.json"), bytes);

		expect(importPiAgentDir(source, target)).toMatchObject({ kind: "imported" });
		expect(readFileSync(join(target, "auth.json"))).toEqual(bytes);
	});

	posixOnly("skips a child of a readable but not searchable dir as unreadable and imports the rest", () => {
		const root = tempDir();
		const source = join(root, "pi");
		const target = join(root, "axiom", "agent");
		writePiDir(source);
		mkdirSync(join(source, "locked"));
		writeFileSync(join(source, "locked", "hidden.txt"), "x");
		chmodSync(join(source, "locked"), 0o444);
		try {
			expect(importPiAgentDir(source, target)).toMatchObject({
				kind: "imported",
				skipped: [{ path: "locked/hidden.txt", reason: "unreadable" }],
			});
			expect(readFileSync(join(target, "settings.json"), "utf8")).toBe('{"theme":"dark"}\n');
		} finally {
			chmodSync(join(source, "locked"), 0o700);
		}
	});

	it("drops OAuth credentials from auth.json and keeps API keys with mode 0600", () => {
		const root = tempDir();
		const source = join(root, "pi");
		writePiDir(source);
		writeFileSync(
			join(source, "auth.json"),
			JSON.stringify({
				openai: { type: "api_key", key: "sk" },
				anthropic: { type: "oauth", access: "a", refresh: "r", expires: 1 },
			}),
			{ mode: 0o600 },
		);
		chmodSync(join(source, "auth.json"), 0o600);

		const result = importPiAgentDir(source, join(root, "target"));

		expect(result).toMatchObject({ kind: "imported", droppedOAuth: ["anthropic"] });
		expect(JSON.parse(readFileSync(join(root, "target", "auth.json"), "utf8"))).toEqual({
			openai: { type: "api_key", key: "sk" },
		});
		if (process.platform !== "win32") expect(statSync(join(root, "target", "auth.json")).mode & 0o777).toBe(0o600);
	});

	it("omits an all-OAuth auth.json and copies an invalid one verbatim", () => {
		const root = tempDir();
		const onlyOAuth = join(root, "a");
		writePiDir(onlyOAuth);
		writeFileSync(
			join(onlyOAuth, "auth.json"),
			JSON.stringify({ x: { type: "oauth", access: "a", refresh: "r", expires: 1 } }),
		);
		expect(importPiAgentDir(onlyOAuth, join(root, "ta"))).toMatchObject({ droppedOAuth: ["x"] });
		expect(existsSync(join(root, "ta", "auth.json"))).toBe(false);

		const invalid = join(root, "b");
		writePiDir(invalid);
		writeFileSync(join(invalid, "auth.json"), "{ not json");
		importPiAgentDir(invalid, join(root, "tb"));
		expect(readFileSync(join(root, "tb", "auth.json"), "utf8")).toBe("{ not json");
	});

	it("keeps only explicit distrust in trust.json", () => {
		const root = tempDir();
		const mixed = join(root, "a");
		writePiDir(mixed);
		writeFileSync(join(mixed, "trust.json"), JSON.stringify({ "/a": true, "/b": false, "/c": null }));
		importPiAgentDir(mixed, join(root, "ta"));
		expect(JSON.parse(readFileSync(join(root, "ta", "trust.json"), "utf8"))).toEqual({ "/b": false });

		const allTrue = join(root, "b");
		writePiDir(allTrue);
		writeFileSync(join(allTrue, "trust.json"), JSON.stringify({ "/a": true }));
		importPiAgentDir(allTrue, join(root, "tb"));
		expect(existsSync(join(root, "tb", "trust.json"))).toBe(false);

		const invalid = join(root, "c");
		writePiDir(invalid);
		writeFileSync(join(invalid, "trust.json"), "[1]");
		importPiAgentDir(invalid, join(root, "tc"));
		expect(readFileSync(join(root, "tc", "trust.json"), "utf8")).toBe("[1]");
	});

	it("copies trust.json verbatim when a value is not true, false or null (Pi fails closed on it)", () => {
		const root = tempDir();
		const src = join(root, "a");
		writePiDir(src);
		writeFileSync(join(src, "trust.json"), JSON.stringify({ "/a": "false", "/b": false }));
		importPiAgentDir(src, join(root, "t"));
		expect(readFileSync(join(root, "t", "trust.json"), "utf8")).toBe(JSON.stringify({ "/a": "false", "/b": false }));
	});

	posixOnly("preserves file and directory modes and mtimes, including read-only dirs", () => {
		const root = tempDir();
		const source = join(root, "pi");
		writePiDir(source);
		mkdirSync(join(source, "bin"));
		writeFileSync(join(source, "bin", "rg"), "#!/bin/sh\n");
		chmodSync(join(source, "bin", "rg"), 0o755);
		mkdirSync(join(source, "shared"));
		chmodSync(join(source, "shared"), 0o750);
		mkdirSync(join(source, "ro"));
		writeFileSync(join(source, "ro", "f.txt"), "f");
		const past = new Date("2020-01-02T03:04:05Z");
		utimesSync(join(source, "sessions", "--home--", "a.jsonl"), past, past);
		chmodSync(join(source, "ro"), 0o555);
		const before = snapshot(source);

		const target = join(root, "target");
		expect(importPiAgentDir(source, target)).toMatchObject({ kind: "imported" });

		const after = snapshot(target);
		expect(after["./bin/rg"]).toBe(before["./bin/rg"]);
		expect(after["./shared"]).toBe(before["./shared"]);
		expect(after["./ro"]).toBe(before["./ro"]);
		expect(after["./ro/f.txt"]).toBe(before["./ro/f.txt"]);
		expect(after["./sessions/--home--/a.jsonl"]).toBe(before["./sessions/--home--/a.jsonl"]);
		expect(snapshot(source)).toEqual(before);
	});

	posixOnly("applies the symlink rule and never links back into Pi data", () => {
		const root = tempDir();
		const source = join(root, "pi");
		const outside = join(root, "outside");
		writePiDir(source);
		mkdirSync(join(outside, "dir"), { recursive: true });
		writeFileSync(join(outside, "settings.json"), "outside");
		writeFileSync(join(source, "real.txt"), "real");
		mkdirSync(join(source, "realdir"));
		symlinkSync("real.txt", join(source, "rel-file"));
		symlinkSync("realdir", join(source, "rel-dir"));
		symlinkSync(join(outside, "settings.json"), join(source, "abs-outside-file"));
		symlinkSync(join(source, "real.txt"), join(source, "abs-inside-file"));
		symlinkSync(join(outside, "dir"), join(source, "outside-dir"));
		symlinkSync("missing", join(source, "dangling"));
		symlinkSync("loop-b", join(source, "loop-a"));
		symlinkSync("loop-a", join(source, "loop-b"));
		execFileSync("mkfifo", [join(source, "fifo")]);
		const before = snapshot(source);

		const target = join(root, "target");
		const result = importPiAgentDir(source, target);

		expect(result.kind).toBe("imported");
		expect(readlinkSync(join(target, "rel-file"))).toBe("real.txt");
		expect(readlinkSync(join(target, "rel-dir"))).toBe("realdir");
		for (const name of ["abs-outside-file", "abs-inside-file"]) {
			expect(lstatSync(join(target, name)).isFile()).toBe(true);
		}
		writeFileSync(join(target, "abs-outside-file"), "changed by axiom");
		writeFileSync(join(target, "abs-inside-file"), "changed by axiom");
		expect(readFileSync(join(outside, "settings.json"), "utf8")).toBe("outside");
		expect(readFileSync(join(source, "real.txt"), "utf8")).toBe("real");
		expect(result.kind === "imported" && result.skipped).toEqual([
			{ path: "dangling", reason: "symlink" },
			{ path: "fifo", reason: "special" },
			{ path: "loop-a", reason: "symlink" },
			{ path: "loop-b", reason: "symlink" },
			{ path: "outside-dir", reason: "symlink" },
		]);
		expect(snapshot(source)).toEqual(before);
	});

	posixOnly("skips unreadable files and dirs but imports the rest", () => {
		const root = tempDir();
		const source = join(root, "pi");
		writePiDir(source);
		writeFileSync(join(source, "secret.txt"), "s");
		chmodSync(join(source, "secret.txt"), 0o000);
		mkdirSync(join(source, "closed"));
		chmodSync(join(source, "closed"), 0o000);

		const result = importPiAgentDir(source, join(root, "target"));

		expect(result).toMatchObject({
			kind: "imported",
			skipped: [
				{ path: "closed", reason: "unreadable" },
				{ path: "secret.txt", reason: "unreadable" },
			],
		});
		expect(existsSync(join(root, "target", "settings.json"))).toBe(true);
		expect(existsSync(join(root, "target", "closed"))).toBe(false);
	});

	it("reports target-exists when another import renamed first", () => {
		const root = tempDir();
		const source = join(root, "pi");
		writePiDir(source);
		const target = join(root, "target");
		mkdirSync(join(target, "x"), { recursive: true });

		expect(importPiAgentDir(source, target)).toEqual({ kind: "skipped", reason: "target-exists" });
		expect(readdirSync(target)).toEqual(["x"]);
		expect(readdirSync(root).filter((name) => name.startsWith(".agent-import-"))).toEqual([]);
	});
});

describe("runPiDataImport", () => {
	let home: string;
	let legacy: string;
	let target: string;

	beforeEach(() => {
		home = tempDir();
		legacy = join(home, ".pi", "agent");
		target = join(home, ".axiom", "agent");
		vi.stubEnv("HOME", home);
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	});

	it("imports once, then reports target-exists", () => {
		writePiDir(legacy);
		const before = snapshot(legacy);
		expect(runPiDataImport([], {})).toMatchObject({ kind: "imported", source: legacy, target });
		expect(snapshot(legacy)).toEqual(before);
		expect(runPiDataImport([], {})).toEqual({ kind: "skipped", reason: "target-exists" });
	});

	it("never imports for version, but imports for help because help creates the agent dir", () => {
		writePiDir(legacy);
		for (const flag of ["-v", "--version"]) {
			expect(runPiDataImport(["-p", flag], {})).toEqual({ kind: "skipped", reason: "info-command" });
		}
		expect(existsSync(join(home, ".axiom"))).toBe(false);
		expect(runPiDataImport(["--help"], {})).toMatchObject({ kind: "imported" });
	});

	it("never imports with an agent dir override", () => {
		writePiDir(legacy);
		expect(runPiDataImport([], { AXIOM_CODING_AGENT_DIR: join(home, "custom") })).toEqual({
			kind: "skipped",
			reason: "custom-agent-dir",
		});
		expect(existsSync(join(home, ".axiom"))).toBe(false);
	});

	it("leaves an existing target untouched", () => {
		writePiDir(legacy);
		for (const create of [() => mkdirSync(target, { recursive: true }), () => writeFileSync(target, "f")]) {
			rmSync(join(home, ".axiom"), { recursive: true, force: true });
			mkdirSync(join(home, ".axiom"), { recursive: true });
			create();
			expect(runPiDataImport([], {})).toEqual({ kind: "skipped", reason: "target-exists" });
		}
	});

	it("skips with one hint line when PI_CODING_AGENT_DIR is set and the import would otherwise run", () => {
		writePiDir(legacy);
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		expect(runPiDataImport([], { PI_CODING_AGENT_DIR: join(home, "elsewhere") })).toEqual({
			kind: "skipped",
			reason: "pi-dir-env",
		});
		expect(error).toHaveBeenCalledTimes(1);
		const [hint] = error.mock.calls[0] as [string];
		expect(hint).toContain("unset PI_CODING_AGENT_DIR before");
		expect(hint).not.toContain("cp -a");
		expect(existsSync(join(home, ".axiom"))).toBe(false);
	});

	it("prints no PI_CODING_AGENT_DIR hint when there is no Pi data to import", () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		expect(runPiDataImport([], { PI_CODING_AGENT_DIR: join(home, "elsewhere") })).toEqual({
			kind: "skipped",
			reason: "no-source",
		});
		expect(error).not.toHaveBeenCalled();
	});

	posixOnly("treats an unlistable Pi dir as no-source and creates nothing", () => {
		writePiDir(legacy);
		chmodSync(legacy, 0o100);
		try {
			expect(runPiDataImport([], {})).toEqual({ kind: "skipped", reason: "no-source" });
			expect(existsSync(join(home, ".axiom"))).toBe(false);
		} finally {
			chmodSync(legacy, 0o700);
		}
	});

	it("does not fail the import when stderr rejects writes", () => {
		writePiDir(legacy);
		vi.mocked(process.stderr.write).mockImplementation(() => {
			throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
		});
		expect(runPiDataImport([], {})).toMatchObject({ kind: "imported", target });
	});

	it("requires a Pi data marker in the legacy dir", () => {
		expect(runPiDataImport([], {})).toEqual({ kind: "skipped", reason: "no-source" });
		mkdirSync(legacy, { recursive: true });
		expect(runPiDataImport([], {})).toEqual({ kind: "skipped", reason: "no-source" });
		writeFileSync(join(legacy, "foo.txt"), "x");
		expect(runPiDataImport([], {})).toEqual({ kind: "skipped", reason: "no-source" });
		expect(existsSync(join(home, ".axiom"))).toBe(false);
	});

	posixOnly("refuses overlapping source and target", () => {
		writePiDir(legacy);
		mkdirSync(join(legacy, "nested"));
		symlinkSync(join(legacy, "nested"), join(home, ".axiom"));
		expect(runPiDataImport([], {})).toEqual({ kind: "skipped", reason: "overlap" });
	});

	posixOnly("overlap wins over PI_CODING_AGENT_DIR and prints no hint", () => {
		writePiDir(legacy);
		mkdirSync(join(legacy, "nested"));
		symlinkSync(join(legacy, "nested"), join(home, ".axiom"));
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		expect(runPiDataImport([], { PI_CODING_AGENT_DIR: join(home, "elsewhere") })).toEqual({
			kind: "skipped",
			reason: "overlap",
		});
		expect(error).not.toHaveBeenCalled();
		expect(existsSync(target)).toBe(false);
	});

	it("copies from the realpath when the legacy dir is a symlink", () => {
		const real = join(home, "dotfiles", "pi-agent");
		writePiDir(real);
		mkdirSync(join(home, ".pi"));
		symlinkSync(real, legacy, "dir");
		expect(runPiDataImport([], {})).toMatchObject({ kind: "imported", source: real });
		expect(lstatSync(target).isDirectory()).toBe(true);
	});

	it("removes stale temp dirs and keeps young ones", () => {
		writePiDir(legacy);
		const old = join(home, ".axiom", ".agent-import-old");
		const young = join(home, ".axiom", ".agent-import-new");
		mkdirSync(join(old, "x"), { recursive: true });
		mkdirSync(young, { recursive: true });
		const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
		utimesSync(old, twoHoursAgo, twoHoursAgo);

		runPiDataImport([], {});

		expect(existsSync(old)).toBe(false);
		expect(existsSync(young)).toBe(true);
	});

	it("removes temp dirs of a dead importer at once and keeps one whose importer is alive", () => {
		writePiDir(legacy);
		const dead = spawnSync(process.execPath, ["-e", ""]).pid;
		const orphan = join(home, ".axiom", `.agent-import-${dead}-orphan`);
		const live = join(home, ".axiom", `.agent-import-${process.pid}-live`);
		mkdirSync(orphan, { recursive: true });
		mkdirSync(live, { recursive: true });

		runPiDataImport([], {});

		expect(existsSync(orphan)).toBe(false);
		expect(existsSync(live)).toBe(true);
	});
});

const sourceResolverUrl = pathToFileURL(resolve(__dirname, "../src/experimental/source-resolver.ts")).href;
const modulePath = pathToFileURL(resolve(__dirname, "../src/pi-data-import.ts")).href;
const cliPath = resolve(__dirname, "../src/cli.ts");

function run(args: string[], env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string; code: number | null }> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(process.execPath, ["--import", sourceResolverUrl, ...args], {
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("error", reject);
		child.on("close", (code) => resolvePromise({ stdout, stderr, code }));
	});
}

function cleanEnv(home: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, PI_OFFLINE: "1" };
	delete env.AXIOM_CODING_AGENT_DIR;
	delete env.PI_CODING_AGENT_DIR;
	return env;
}

describe("concurrent and CLI imports", () => {
	it("lets exactly one of two concurrent imports win", async () => {
		const root = tempDir();
		const source = join(root, "pi");
		writePiDir(source);
		for (let i = 0; i < 200; i++) writeFileSync(join(source, `f${i}.txt`), `${i}`);
		const target = join(root, "axiom", "agent");
		const script = `import { importPiAgentDir } from ${JSON.stringify(modulePath)}; process.stdout.write(JSON.stringify(importPiAgentDir(${JSON.stringify(source)}, ${JSON.stringify(target)})));`;
		const scriptPath = join(root, "race.mjs");
		writeFileSync(scriptPath, script);

		const results = await Promise.all([run([scriptPath], cleanEnv(root)), run([scriptPath], cleanEnv(root))]);
		const kinds = results.map(
			(result) => (JSON.parse(result.stdout) as { kind: string; reason?: string }).reason ?? "imported",
		);

		expect(kinds.sort()).toEqual(["imported", "target-exists"]);
		expect(readdirSync(target)).toHaveLength(202);
		expect(readdirSync(join(root, "axiom")).filter((name) => name.startsWith(".agent-import-"))).toEqual([]);
	}, 60_000);

	it("imports on the first CLI run only and keeps stdout clean", async () => {
		const withPi = tempDir();
		writePiDir(join(withPi, ".pi", "agent"));
		const withoutPi = tempDir();

		const first = await run([cliPath, "--offline", "--list-models", "faux"], cleanEnv(withPi));
		const baseline = await run([cliPath, "--offline", "--list-models", "faux"], cleanEnv(withoutPi));
		const second = await run([cliPath, "--offline", "--list-models", "faux"], cleanEnv(withPi));

		expect(first.stderr).toContain(join(withPi, ".pi", "agent"));
		expect(first.stderr).toContain(join(withPi, ".axiom", "agent"));
		expect(first.stdout).toBe(baseline.stdout);
		expect(second.stderr).not.toContain(join(withPi, ".pi", "agent"));
		expect(existsSync(join(withPi, ".axiom", "agent", "sessions", "--home--", "a.jsonl"))).toBe(true);
	}, 120_000);
});
