// Pre-edit copies of files the gateway lets an edit change without asking, and the restore that puts one back.

import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";

/** Copies kept per session; past it the gateway asks instead of allowing an edit. */
export const MAX_CHECKPOINTS = 200;

/** Bytes kept per session, with the same effect past it. */
export const MAX_CHECKPOINT_BYTES = 64 * 1024 * 1024;

/** Extra room only a restore may use, so a full store can still undo: the file it replaces is kept first. */
const RESTORE_RESERVE_COPIES = 20;
const RESTORE_RESERVE_BYTES = 16 * 1024 * 1024;

/** A session directory untouched this long is removed the next time another session saves a copy. */
const STALE_MS = 30 * 24 * 60 * 60 * 1000;

/** Attempts to take a free copy number when another process took it first. */
const ID_ATTEMPTS = 3;

export interface Checkpoint {
	id: number;
	/** Absolute path of the file the copy belongs to. */
	path: string;
	time: number;
	size: number;
	/** `edit`: the file as it was before an automatic edit. `restore`: the file as it was before a restore replaced it. */
	kind: "edit" | "restore";
}

/**
 * Copies of files as they were before an automatic edit, kept outside the workspace in
 * `<root>/<session id>/`. A copy is made only from the bytes the edit was validated against, and the edit is
 * allowed only when the copy is on disk. Anything that stops the copy (no store, a full store, an I/O error)
 * means no copy, and the caller asks instead of allowing.
 */
export class EditCheckpoints {
	private readonly root: string | undefined;
	private readonly sessionId: () => string;
	private readonly now: () => number;
	private pruned = false;

	constructor(root: string | undefined, sessionId: () => string, now: () => number = Date.now) {
		this.root = root;
		this.sessionId = sessionId;
		this.now = now;
	}

	/** Keep `bytes` as the pre-edit state of `path`. Undefined when no copy could be made. */
	async save(path: string, bytes: Buffer, kind: Checkpoint["kind"] = "edit"): Promise<Checkpoint | undefined> {
		const dir = this.dir();
		if (dir === undefined) return undefined;
		try {
			await mkdir(dir, { recursive: true, mode: 0o700 });
			await this.pruneStale(dir);
			const existing = await this.list();
			const room = kind === "restore";
			if (existing.length >= MAX_CHECKPOINTS + (room ? RESTORE_RESERVE_COPIES : 0)) return undefined;
			const used = existing.reduce((sum, entry) => sum + entry.size, 0);
			if (used + bytes.length > MAX_CHECKPOINT_BYTES + (room ? RESTORE_RESERVE_BYTES : 0)) return undefined;

			// The next number is past every index line and every copy on disk, so a copy left without an index line
			// (a crash between the two writes) cannot block the store.
			let id = Math.max(0, ...existing.map((entry) => entry.id), ...(await this.copyNumbers(dir))) + 1;
			for (let attempt = 0; ; attempt++, id++) {
				try {
					return await this.write(dir, id, path, bytes, kind);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt + 1 >= ID_ATTEMPTS) throw error;
				}
			}
		} catch {
			return undefined;
		}
	}

	/** The session's copies, oldest first. A line that is not a copy record is skipped. Empty when there is no store. */
	async list(): Promise<Checkpoint[]> {
		const dir = this.dir();
		if (dir === undefined) return [];
		let text: string;
		try {
			text = await readFile(join(dir, "index.jsonl"), "utf8");
		} catch {
			return [];
		}
		const copies: Checkpoint[] = [];
		for (const line of text.split("\n")) {
			// Trust boundary: the index is a file another process of the same user can write.
			try {
				const entry = JSON.parse(line) as Checkpoint;
				if (Number.isSafeInteger(entry.id) && entry.id > 0 && typeof entry.path === "string") copies.push(entry);
			} catch {
				// A truncated or corrupt line hides only itself.
			}
		}
		return copies;
	}

	/**
	 * Put copy `id` back. The file as it is now is saved first as a `restore` copy, so a restore can be undone, and
	 * the write goes through a temporary file in the same directory. Returns the path, or throws with the reason.
	 * `allowed` judges the target path (it must be one the user may overwrite).
	 */
	async restore(id: number, allowed: (path: string) => boolean): Promise<string> {
		const entry = (await this.list()).find((candidate) => candidate.id === id);
		if (entry === undefined) throw new Error(`No copy ${id}.`);
		if (!allowed(entry.path)) throw new Error(`Not restoring ${entry.path}: it is outside what edits may change.`);
		const dir = this.dir();
		if (dir === undefined) throw new Error("No copy store.");
		const bytes = await readFile(join(dir, `${id}.snap`));

		let mode = 0o644;
		const current = await lstat(entry.path).catch(() => undefined);
		if (current !== undefined) {
			if (!current.isFile() || current.nlink !== 1) throw new Error(`${entry.path} is no longer a plain file.`);
			mode = (await stat(entry.path)).mode & 0o777;
			if ((await this.save(entry.path, await readFile(entry.path), "restore")) === undefined)
				throw new Error("The copy store is full, so the current file could not be kept first.");
		}
		const sibling = `${entry.path}.restore-${randomBytes(6).toString("hex")}`;
		try {
			const handle = await open(sibling, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
			try {
				await handle.writeFile(bytes);
				await handle.sync();
			} finally {
				await handle.close();
			}
			// The open mode is cut by the umask; the file keeps the mode it had.
			await chmod(sibling, mode);
			await rename(sibling, entry.path);
		} catch (error) {
			await rm(sibling, { force: true });
			throw error;
		}
		return entry.path;
	}

	/**
	 * The session's directory. The name is the id with unsafe characters replaced plus a hash of the whole id, so an
	 * imported session file that chooses its own id cannot name a path outside the store, and two ids that differ
	 * only in replaced characters (or an empty id) still get different directories.
	 */
	private dir(): string | undefined {
		if (this.root === undefined) return undefined;
		const id = this.sessionId();
		const hash = createHash("sha256").update(id).digest("hex").slice(0, 12);
		return join(this.root, `${id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64)}-${hash}`);
	}

	/** Create copy `id` and its index line. A failure after the file exists removes it, so no copy is left unlisted. */
	private async write(
		dir: string,
		id: number,
		path: string,
		bytes: Buffer,
		kind: Checkpoint["kind"],
	): Promise<Checkpoint> {
		const file = join(dir, `${id}.snap`);
		// Exclusive and durable: the edit must not run on the strength of a copy that is not there.
		const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
		try {
			try {
				await handle.writeFile(bytes);
				await handle.sync();
			} finally {
				await handle.close();
			}
			const entry: Checkpoint = { id, path, time: this.now(), size: bytes.length, kind };
			const index = await open(join(dir, "index.jsonl"), "a", 0o600);
			try {
				await index.appendFile(`${JSON.stringify(entry)}\n`);
				await index.sync();
			} finally {
				await index.close();
			}
			await syncDirectory(dir);
			return entry;
		} catch (error) {
			await rm(file, { force: true });
			throw error;
		}
	}

	/** Numbers of the copy files in `dir`, listed or not. */
	private async copyNumbers(dir: string): Promise<number[]> {
		const numbers: number[] = [];
		for (const name of await readdir(dir)) {
			const match = /^(\d+)\.snap$/.exec(name);
			if (match) numbers.push(Number(match[1]));
		}
		return numbers;
	}

	/**
	 * Remove other sessions' directories whose newest write is a month old. Runs once per process, best effort. The
	 * session's own directory is never removed: a resumed session keeps its copies.
	 */
	private async pruneStale(own: string): Promise<void> {
		if (this.pruned || this.root === undefined) return;
		this.pruned = true;
		try {
			for (const name of await readdir(this.root)) {
				const path = join(this.root, name);
				if (path === own) continue;
				const touched = await stat(join(path, "index.jsonl")).catch(() => stat(path));
				if (this.now() - touched.mtimeMs > STALE_MS) await rm(path, { recursive: true, force: true });
			}
		} catch {
			// A directory that cannot be read or removed is left for the next run.
		}
	}
}

/** Make a new directory entry durable. Not supported everywhere (Windows), so a failure is ignored. */
async function syncDirectory(dir: string): Promise<void> {
	try {
		const handle = await open(dir, "r");
		try {
			await handle.sync();
		} finally {
			await handle.close();
		}
	} catch {
		// The copy and its index line are already synced; only the directory entry is not.
	}
}
