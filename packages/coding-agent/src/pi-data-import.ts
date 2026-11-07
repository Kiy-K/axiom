// One-time copy of Pi's agent directory into this app's agent directory (docs/axiom/rebrand.md §3).

import {
	chmodSync,
	closeSync,
	constants,
	copyFileSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	renameSync,
	rmSync,
	type Stats,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { APP_NAME, CONFIG_DIR_NAME, ENV_AGENT_DIR } from "./config.ts";
import { stripBom } from "./utils/text.ts";

export type PiDataImportSkip = { path: string; reason: "symlink" | "special" | "unreadable" };

export type PiDataImportResult =
	| {
			kind: "imported";
			source: string;
			target: string;
			files: number;
			skipped: PiDataImportSkip[];
			droppedOAuth: string[];
	  }
	| {
			kind: "skipped";
			reason: "info-command" | "custom-agent-dir" | "target-exists" | "pi-dir-env" | "no-source" | "overlap";
	  }
	| { kind: "failed"; source: string; target: string; error: string };

// --help still imports: printing help creates the agent dir, which would otherwise block every later import.
const INFO_FLAGS = new Set(["-v", "--version"]);

/** CLI entry: decide whether to import, run it, and report on stderr only. */
export function runPiDataImport(args: string[], env: NodeJS.ProcessEnv = process.env): PiDataImportResult {
	if (args.some((arg) => INFO_FLAGS.has(arg))) return { kind: "skipped", reason: "info-command" };
	if (env[ENV_AGENT_DIR]) return { kind: "skipped", reason: "custom-agent-dir" };
	const target = join(homedir(), CONFIG_DIR_NAME, "agent");
	if (lstatOrUndefined(target)) return { kind: "skipped", reason: "target-exists" };
	const source = realpathOrUndefined(join(homedir(), ".pi", "agent"));
	// An unlistable source counts as no-source: nothing is created, so the next start retries.
	if (source === undefined || !hasPiData(source) || !canRead(source)) return { kind: "skipped", reason: "no-source" };
	if (overlaps(source, resolveThroughExisting(target))) return { kind: "skipped", reason: "overlap" };
	if (env.PI_CODING_AGENT_DIR) {
		console.error(
			`Pi data in ${source} is not imported because PI_CODING_AGENT_DIR is set. Unset it and start ${APP_NAME} again to import it.`,
		);
		return { kind: "skipped", reason: "pi-dir-env" };
	}

	removeStaleTemps(dirname(target));
	console.error(`Importing Pi data from ${source} to ${target}; ${source} is not changed.`);
	const result = importPiAgentDir(source, target);
	report(result, source, target);
	return result;
}

const PI_DATA_MARKERS = ["auth.json", "settings.json", "models.json"];

/** A legacy dir counts only with real Pi data, so a stray empty dir never claims the target. */
function hasPiData(dir: string): boolean {
	if (!statOrUndefined(dir)?.isDirectory()) return false;
	return (
		PI_DATA_MARKERS.some((name) => statOrUndefined(join(dir, name))?.isFile()) ||
		statOrUndefined(join(dir, "sessions"))?.isDirectory() === true
	);
}

/** realpath of the nearest existing ancestor, joined with the segments that do not exist yet. */
function resolveThroughExisting(path: string): string {
	const missing: string[] = [];
	let current = path;
	while (realpathOrUndefined(current) === undefined && dirname(current) !== current) {
		missing.unshift(basename(current));
		current = dirname(current);
	}
	return join(realpathOrUndefined(current) ?? current, ...missing);
}

function overlaps(a: string, b: string): boolean {
	return a === b || a.startsWith(`${b}${sep}`) || b.startsWith(`${a}${sep}`);
}

const TEMP_PREFIX = ".agent-import-";
const STALE_TEMP_MS = 60 * 60 * 1000;

/** Remove temp trees whose importer process is gone; live ones and young ones may belong to a running import. */
function removeStaleTemps(parent: string): void {
	let names: string[];
	try {
		names = readdirSync(parent);
	} catch {
		return;
	}
	for (const name of names) {
		if (!name.startsWith(TEMP_PREFIX)) continue;
		const path = join(parent, name);
		const stats = lstatOrUndefined(path);
		if (!stats?.isDirectory()) continue;
		const importerPid = Number(name.slice(TEMP_PREFIX.length).split("-")[0]);
		if (importerIsGone(importerPid) || Date.now() - stats.mtimeMs > STALE_TEMP_MS) removeTree(path);
	}
}

/** True only when the pid is definitely gone; EPERM means the process exists under another user. */
function importerIsGone(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return false;
	} catch (error) {
		return error instanceof Error && "code" in error && error.code === "ESRCH";
	}
}

function report(result: PiDataImportResult, source: string, target: string): void {
	if (result.kind === "failed") {
		console.error(
			`Pi data import failed: ${result.error}. Nothing in ${source} was changed. ${APP_NAME} continues with a new empty ${target}; to retry, quit ${APP_NAME}, delete ${target} (this deletes what ${APP_NAME} saved there) and start ${APP_NAME}.`,
		);
		return;
	}
	if (result.kind !== "imported") return;
	const lines = [`Imported Pi data (${result.files} files).`];
	if (result.droppedOAuth.length > 0) {
		lines.push(
			`OAuth logins not imported: ${result.droppedOAuth.join(", ")}; run "${APP_NAME} auth login <provider>".`,
		);
	}
	lines.push("Not imported: trusted projects (you will be asked again) and MCP sign-ins.");
	for (const skip of result.skipped.slice(0, MAX_REPORTED_SKIPS))
		lines.push(`  skipped ${skip.path} (${skip.reason})`);
	if (result.skipped.length > MAX_REPORTED_SKIPS) {
		lines.push(`  … and ${result.skipped.length - MAX_REPORTED_SKIPS} more`);
	}
	console.error(lines.join("\n"));
}

const MAX_REPORTED_SKIPS = 20;

type WalkState = { root: string; target: string; files: number; skipped: PiDataImportSkip[]; droppedOAuth: string[] };

/** Copy Pi agent dir `source` (already realpath'd) to absent `target` via a temp dir and one rename; never writes under `source`. */
export function importPiAgentDir(source: string, target: string): PiDataImportResult {
	let temp: string | undefined;
	try {
		mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
		temp = mkdtempSync(join(dirname(target), `${TEMP_PREFIX}${process.pid}-`));
		const state: WalkState = { root: source, target, files: 0, skipped: [], droppedOAuth: [] };
		copyChildren(source, temp, "", readdirSync(source), state);
		applyMetadata(temp, statSync(source));
		try {
			renameSync(temp, target);
		} catch (error) {
			// A concurrent start renamed its copy first.
			if (!lstatOrUndefined(target)) throw error;
			removeTree(temp);
			return { kind: "skipped", reason: "target-exists" };
		}
		return {
			kind: "imported",
			source,
			target,
			files: state.files,
			skipped: state.skipped,
			droppedOAuth: state.droppedOAuth,
		};
	} catch (error) {
		if (temp !== undefined) removeTree(temp);
		return { kind: "failed", source, target, error: error instanceof Error ? error.message : String(error) };
	}
}

// Top-level only: lock dirs, logs and crash records of the Pi process, and MCP tokens issued to Pi's client (D14).
const TOP_LEVEL_EXCLUDES = new Set([
	"tmp",
	"pi-debug.log",
	"pi-tui-debug.log",
	"pi-tui-crash.log",
	"crashes.json",
	"mcp-auth.json",
]);

// Top-level files this import filters rather than copies verbatim (D10, D14).
const TOP_LEVEL_FILTERED: Record<string, true> = { "trust.json": true, "auth.json": true };

function copyChildren(srcDir: string, dstDir: string, relDir: string, names: string[], state: WalkState): void {
	for (const name of [...names].sort()) {
		const rel = relDir === "" ? name : `${relDir}/${name}`;
		const src = join(srcDir, name);
		const dst = join(dstDir, name);
		if (relDir === "") {
			if (TOP_LEVEL_EXCLUDES.has(name) || name.endsWith(".lock")) continue;
			if (TOP_LEVEL_FILTERED[name] === true) {
				copyFiltered(src, dst, rel, name, state);
				continue;
			}
		}
		copyEntry(src, dst, rel, state);
	}
}

function copyEntry(src: string, dst: string, rel: string, state: WalkState): void {
	let stats: Stats;
	try {
		stats = lstatSync(src);
	} catch (error) {
		// A child of a readable but not searchable dir fails lstat with EACCES.
		if (!isReadError(error)) throw error;
		state.skipped.push({ path: rel, reason: "unreadable" });
		return;
	}
	if (stats.isDirectory()) {
		let names: string[];
		try {
			names = readdirSync(src);
		} catch (error) {
			if (!isReadError(error)) throw error;
			state.skipped.push({ path: rel, reason: "unreadable" });
			return;
		}
		mkdirSync(dst, { mode: 0o700 });
		copyChildren(src, dst, rel, names, state);
		// After the children, so read-only source dirs do not block their own copy.
		applyMetadata(dst, stats);
	} else if (stats.isFile()) {
		copyRegularFile(src, dst, rel, stats, state);
	} else if (stats.isSymbolicLink()) {
		copySymlink(src, dst, rel, state);
	} else {
		state.skipped.push({ path: rel, reason: "special" });
	}
}

/** Keep relative links that stay inside the final target tree; copy the content of other file links; skip the rest. */
function copySymlink(src: string, dst: string, rel: string, state: WalkState): void {
	const link = readlinkSync(src);
	const real = realpathOrUndefined(src);
	const topLevelName = real !== undefined && dirname(real) === state.root ? basename(real) : undefined;
	// Excluded top-level files are never copied, so a link must not copy their content either (D10, D14).
	if (
		topLevelName !== undefined &&
		(TOP_LEVEL_EXCLUDES.has(topLevelName) ||
			topLevelName.endsWith(".lock") ||
			TOP_LEVEL_FILTERED[topLevelName] === true)
	) {
		state.skipped.push({ path: rel, reason: "symlink" });
		return;
	}
	// Checked against the final target: the copy is renamed into place, so a link may leave the tree and re-enter it by name.
	const keepsInside =
		real !== undefined &&
		isInside(real, state.root) &&
		!isAbsolute(link) &&
		isInside(resolve(state.target, dirname(rel), link), state.target);
	if (keepsInside) {
		symlinkSync(link, dst, statOrUndefined(real)?.isDirectory() ? "dir" : "file");
		return;
	}
	const stats = statOrUndefined(src);
	if (stats?.isFile()) {
		copyRegularFile(src, dst, rel, stats, state);
		return;
	}
	state.skipped.push({ path: rel, reason: "symlink" });
}

/** Whether `path` is `root` or lies under it, compared lexically. */
function isInside(path: string, root: string): boolean {
	return path === root || path.startsWith(`${root}${sep}`);
}

function copyRegularFile(src: string, dst: string, rel: string, stats: Stats, state: WalkState): void {
	if (!canRead(src)) {
		state.skipped.push({ path: rel, reason: "unreadable" });
		return;
	}
	copyFileSync(src, dst, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
	applyMetadata(dst, stats);
	state.files++;
}

function copyFiltered(src: string, dst: string, rel: string, name: string, state: WalkState): void {
	const stats = statOrUndefined(src);
	if (!stats?.isFile()) {
		state.skipped.push({ path: rel, reason: lstatSync(src).isSymbolicLink() ? "symlink" : "special" });
		return;
	}
	if (!canRead(src)) {
		state.skipped.push({ path: rel, reason: "unreadable" });
		return;
	}
	const bytes = readFileSync(src);
	const filtered = name === "trust.json" ? filterTrust(bytes) : filterAuth(bytes, state.droppedOAuth);
	if (filtered === undefined) return;
	writeFileSync(dst, filtered, { flag: "wx", mode: stats.mode & 0o7777 });
	applyMetadata(dst, stats);
	state.files++;
}

/** Keep explicit distrust only (D10). Bytes that do not parse as an object, or hold a value other than true/false/null, are copied verbatim so Axiom fails as Pi does instead of guessing. */
function filterTrust(bytes: Buffer): Buffer | undefined {
	const data = parseObject(bytes.toString("utf8"));
	if (data === undefined) return bytes;
	if (!Object.values(data).every((value) => value === true || value === false || value === null)) return bytes;
	const kept = Object.fromEntries(Object.entries(data).filter(([, value]) => value === false));
	return Object.keys(kept).length === 0 ? undefined : Buffer.from(`${JSON.stringify(kept, null, 2)}\n`);
}

/** Drop OAuth credentials so the two apps never share a refresh token (D14). */
function filterAuth(bytes: Buffer, droppedOAuth: string[]): Buffer | undefined {
	const data = parseObject(bytes.toString("utf8"));
	if (data === undefined) return bytes;
	const kept: Record<string, unknown> = {};
	for (const [provider, credential] of Object.entries(data)) {
		if (
			typeof credential === "object" &&
			credential !== null &&
			"type" in credential &&
			credential.type === "oauth"
		) {
			droppedOAuth.push(provider);
		} else {
			kept[provider] = credential;
		}
	}
	return Object.keys(kept).length === 0 ? undefined : Buffer.from(`${JSON.stringify(kept, null, 2)}\n`);
}

// Trust boundary: file content written by another program.
function parseObject(text: string): Record<string, unknown> | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripBom(text));
	} catch {
		return undefined;
	}
	return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
		? (parsed as Record<string, unknown>)
		: undefined;
}

function applyMetadata(path: string, stats: Stats): void {
	chmodSync(path, stats.mode & 0o7777);
	// Node's utimes takes seconds as a double, about 240 ns resolution at current epochs, so an mtime can differ from the source by up to ~120 ns. Node has no nanosecond utimes.
	utimesSync(path, stats.atimeMs / 1000, stats.mtimeMs / 1000);
}

const READ_ERRORS = new Set(["EACCES", "EPERM", "ENOENT", "ELOOP"]);

function isReadError(error: unknown): boolean {
	return error instanceof Error && "code" in error && READ_ERRORS.has(String(error.code));
}

function canRead(path: string): boolean {
	try {
		closeSync(openSync(path, "r"));
		return true;
	} catch (error) {
		if (isReadError(error)) return false;
		throw error;
	}
}

/** Remove a temp tree, first making its dirs writable; errors are ignored and the next start retries. */
function removeTree(path: string): void {
	try {
		makeWritable(path);
		rmSync(path, { recursive: true, force: true });
	} catch {
		// Left for removeStaleTemps.
	}
}

function makeWritable(path: string): void {
	if (!lstatSync(path).isDirectory()) return;
	chmodSync(path, 0o700);
	for (const name of readdirSync(path)) makeWritable(join(path, name));
}

function lstatOrUndefined(path: string): Stats | undefined {
	try {
		return lstatSync(path);
	} catch {
		return undefined;
	}
}

function statOrUndefined(path: string): Stats | undefined {
	try {
		return statSync(path);
	} catch {
		return undefined;
	}
}

function realpathOrUndefined(path: string): string | undefined {
	try {
		return realpathSync(path);
	} catch {
		return undefined;
	}
}
