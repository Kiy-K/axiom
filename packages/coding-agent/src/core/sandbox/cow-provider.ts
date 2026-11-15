// Copy-on-write layer for the guest workspace: guest writes land in memory, the host project is never touched.

import type { Dirent } from "node:fs";
import { posix } from "node:path";
import {
	ERRNO,
	isWriteFlag,
	MemoryProvider,
	normalizeVfsPath,
	type VirtualFileHandle,
	type VirtualProvider,
	VirtualProviderClass,
} from "@earendil-works/gondolin";

/** A path the guest wrote: kept in memory until write-back decides whether the host gets it. */
export interface UpperEntry {
	path: string;
	kind: "file" | "symlink";
	mode: number;
	size: number;
}

/** The optional file methods every provider used here implements (MemoryProvider and the host-backed layers all do). */
type FullProvider = VirtualProvider &
	Required<Pick<VirtualProvider, "readFile" | "writeFile" | "readlink" | "realpath" | "symlink" | "chmod">>;

function fsError(errno: number, syscall: string, path: string): Error {
	const code = Object.keys(ERRNO).find((name) => ERRNO[name as keyof typeof ERRNO] === errno) ?? `ERRNO_${errno}`;
	return Object.assign(new Error(`${code}: ${syscall} '${path}'`), { code, errno, syscall, path });
}

function direntOf(name: string, stats: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }) {
	return {
		name,
		isFile: () => stats.isFile(),
		isDirectory: () => stats.isDirectory(),
		isSymbolicLink: () => stats.isSymbolicLink(),
	};
}

/**
 * Reads fall through to `lower` until the guest touches a path; the first write copies the file up into memory.
 * It has no Sync methods: the guest file-system RPC calls only the async ones, so `createWorkspace` casts it to `VirtualProvider` for the mount.
 * Deletes are tombstones. Directory renames of lower directories fail with EXDEV, which `mv` answers by copying.
 */
export class CowProvider extends VirtualProviderClass {
	private readonly lower: FullProvider;
	private readonly upper = new MemoryProvider() as FullProvider;
	private readonly deleted = new Set<string>();
	private readonly capBytes: number;
	private used = 0;

	constructor(lower: VirtualProvider, capBytes: number) {
		super();
		this.lower = lower as FullProvider;
		this.capBytes = capBytes;
	}

	get readonly(): boolean {
		return false;
	}

	get supportsSymlinks(): boolean {
		return true;
	}

	get supportsWatch(): boolean {
		return false;
	}

	/** Paths of the lower layer the guest deleted. */
	deletedPaths(): string[] {
		return [...this.deleted];
	}

	/** Every file and symlink the guest created or changed. */
	async changes(): Promise<UpperEntry[]> {
		const found: UpperEntry[] = [];
		const walk = async (dir: string): Promise<void> => {
			for (const name of (await this.upper.readdir(dir)) as string[]) {
				const path = posix.join(dir, name);
				const stats = await this.upper.lstat(path);
				if (stats.isDirectory()) await walk(path);
				else
					found.push({
						path,
						kind: stats.isSymbolicLink() ? "symlink" : "file",
						mode: stats.mode & 0o7777,
						size: stats.size,
					});
			}
		};
		await walk("/");
		return found;
	}

	/** Content of a path in the write layer. */
	async readUpper(path: string): Promise<Buffer> {
		return (await this.upper.readFile(path)) as Buffer;
	}

	async readUpperLink(path: string): Promise<string> {
		return this.upper.readlink(path);
	}

	private async inUpper(path: string): Promise<boolean> {
		try {
			await this.upper.lstat(path);
			return true;
		} catch {
			return false;
		}
	}

	private async inLower(path: string): Promise<boolean> {
		if (this.deleted.has(path)) return false;
		try {
			await this.lower.lstat(path);
			return true;
		} catch {
			return false;
		}
	}

	private charge(bytes: number, syscall: string, path: string): void {
		if (this.used + bytes > this.capBytes) throw fsError(ERRNO.ENOSPC, syscall, path);
		this.used += bytes;
	}

	/** Brings a lower entry into memory (directories keep their mode, so the guest sees the same permissions). */
	private async copyUp(path: string): Promise<void> {
		if (await this.inUpper(path)) return;
		const stats = await this.lower.lstat(path);
		if (path !== "/") await this.copyUpParents(path);
		if (stats.isDirectory()) {
			await this.upper.mkdir(path);
		} else if (stats.isSymbolicLink()) {
			await this.upper.symlink(await this.lower.readlink(path), path);
			return;
		} else {
			this.charge(stats.size, "copyup", path);
			const handle = await this.lower.open(path, "r");
			const content = (await handle.readFile()) as Buffer;
			await handle.close();
			await this.upper.writeFile(path, content);
		}
		await this.upper.chmod(path, stats.mode & 0o7777);
	}

	private async copyUpParents(path: string): Promise<void> {
		const parent = posix.dirname(path);
		if (parent === path) return;
		if (!(await this.inUpper(parent))) {
			if (!(await this.inLower(parent))) throw fsError(ERRNO.ENOENT, "open", path);
			await this.copyUp(parent);
		}
	}

	/** Fails when the path exists; otherwise makes its parent chain writable in memory. */
	private async prepareCreate(path: string, syscall: string): Promise<void> {
		if (await this.exists(path)) throw fsError(ERRNO.EEXIST, syscall, path);
		await this.copyUpParents(path);
		this.deleted.delete(path);
	}

	private async exists(path: string): Promise<boolean> {
		return (await this.inUpper(path)) || (await this.inLower(path));
	}

	async open(entryPath: string, flags: string, mode?: number): Promise<VirtualFileHandle> {
		const path = normalizeVfsPath(entryPath);
		if (!isWriteFlag(flags)) {
			if (await this.inUpper(path)) return this.upper.open(path, flags, mode);
			if (this.deleted.has(path)) throw fsError(ERRNO.ENOENT, "open", path);
			return this.lower.open(path, flags, mode);
		}
		if (await this.inUpper(path)) {
			if (flags.startsWith("w")) this.used -= (await this.upper.lstat(path)).size;
		} else if (await this.inLower(path)) {
			if (flags.startsWith("w")) {
				await this.copyUpParents(path);
				await this.upper.writeFile(path, Buffer.alloc(0));
				await this.upper.chmod(path, (await this.lower.lstat(path)).mode & 0o7777);
			} else {
				await this.copyUp(path);
			}
		} else {
			if (flags.startsWith("r")) throw fsError(ERRNO.ENOENT, "open", path);
			await this.prepareCreate(path, "open");
		}
		return this.metered(await this.upper.open(path, flags, mode), path);
	}

	/** Counts bytes the guest adds through a handle against the cap. */
	private metered(handle: VirtualFileHandle, path: string): VirtualFileHandle {
		const grow = async (to: (before: number) => number, syscall: string): Promise<void> => {
			const before = (await handle.stat()).size;
			const after = to(before);
			if (after > before) this.charge(after - before, syscall, path);
		};
		return new Proxy(handle, {
			get: (target, key) => {
				if (key === "write")
					return async (buffer: Buffer, offset: number, length: number, position?: number | null) => {
						await grow((before) => Math.max(before, (position ?? before) + length), "write");
						return target.write(buffer, offset, length, position);
					};
				if (key === "writeFile")
					return async (data: Buffer | string, options?: { encoding?: BufferEncoding }) => {
						await grow(() => Buffer.byteLength(data), "write");
						return target.writeFile(data, options);
					};
				if (key === "truncate")
					return async (length?: number) => {
						await grow(() => length ?? 0, "truncate");
						return target.truncate(length);
					};
				const value = Reflect.get(target, key);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
	}

	async stat(entryPath: string, options?: object) {
		const path = normalizeVfsPath(entryPath);
		if (await this.inUpper(path)) return this.upper.stat(path, options);
		if (this.deleted.has(path)) throw fsError(ERRNO.ENOENT, "stat", path);
		return this.lower.stat(path, options);
	}

	async lstat(entryPath: string, options?: object) {
		const path = normalizeVfsPath(entryPath);
		if (await this.inUpper(path)) return this.upper.lstat(path, options);
		if (this.deleted.has(path)) throw fsError(ERRNO.ENOENT, "lstat", path);
		return this.lower.lstat(path, options);
	}

	async readdir(entryPath: string, options?: { withFileTypes?: boolean }) {
		const path = normalizeVfsPath(entryPath);
		const names = new Set<string>();
		const inUpper = await this.inUpper(path);
		const inLower = await this.inLower(path);
		if (!inUpper && !inLower) throw fsError(ERRNO.ENOENT, "scandir", path);
		if (inLower)
			for (const name of (await this.lower.readdir(path)) as string[])
				if (!this.deleted.has(posix.join(path, name))) names.add(name);
		if (inUpper) for (const name of (await this.upper.readdir(path)) as string[]) names.add(name);
		const sorted = [...names].sort();
		if (!options?.withFileTypes) return sorted;
		const entries = await Promise.all(
			sorted.map(async (name) => direntOf(name, await this.lstat(posix.join(path, name)))),
		);
		// The guest RPC reads only name and the three type predicates.
		return entries as unknown as Dirent[];
	}

	async mkdir(entryPath: string, options?: { recursive?: boolean; mode?: number }) {
		const path = normalizeVfsPath(entryPath);
		if (options?.recursive) {
			if (await this.exists(path)) return;
			const parent = posix.dirname(path);
			if (parent !== path) await this.mkdir(parent, options);
		} else {
			await this.prepareCreate(path, "mkdir");
		}
		this.deleted.delete(path);
		await this.upper.mkdir(path, { mode: options?.mode });
	}

	async unlink(entryPath: string): Promise<void> {
		const path = normalizeVfsPath(entryPath);
		const upper = await this.inUpper(path);
		if (upper) {
			this.used -= (await this.upper.lstat(path)).size;
			await this.upper.unlink(path);
		}
		if (await this.inLower(path)) this.deleted.add(path);
		else if (!upper) throw fsError(ERRNO.ENOENT, "unlink", path);
	}

	async rmdir(entryPath: string): Promise<void> {
		const path = normalizeVfsPath(entryPath);
		if (!(await this.exists(path))) throw fsError(ERRNO.ENOENT, "rmdir", path);
		if ((await this.readdir(path)).length > 0) throw fsError(ERRNO.ENOTEMPTY, "rmdir", path);
		if (await this.inUpper(path)) await this.upper.rmdir(path);
		if (await this.inLower(path)) this.deleted.add(path);
	}

	async rename(oldEntry: string, newEntry: string): Promise<void> {
		const from = normalizeVfsPath(oldEntry);
		const to = normalizeVfsPath(newEntry);
		if (!(await this.exists(from))) throw fsError(ERRNO.ENOENT, "rename", from);
		if ((await this.stat(from)).isDirectory() && (await this.inLower(from)))
			throw fsError(ERRNO.EXDEV, "rename", from);
		await this.copyUp(from);
		await this.copyUpParents(to);
		if (await this.inUpper(to)) this.used -= (await this.upper.lstat(to)).size;
		await this.upper.rename(from, to);
		this.deleted.delete(to);
		if (await this.inLower(from)) this.deleted.add(from);
	}

	async chmod(entryPath: string, mode: number): Promise<void> {
		const path = normalizeVfsPath(entryPath);
		if (!(await this.exists(path))) throw fsError(ERRNO.ENOENT, "chmod", path);
		await this.copyUp(path);
		await this.upper.chmod(path, mode);
	}

	async symlink(target: string, entryPath: string): Promise<void> {
		const path = normalizeVfsPath(entryPath);
		await this.prepareCreate(path, "symlink");
		await this.upper.symlink(target, path);
	}

	async readlink(entryPath: string) {
		const path = normalizeVfsPath(entryPath);
		if (await this.inUpper(path)) return this.upper.readlink(path);
		if (this.deleted.has(path)) throw fsError(ERRNO.ENOENT, "readlink", path);
		return this.lower.readlink(path);
	}

	async realpath(entryPath: string) {
		const path = normalizeVfsPath(entryPath);
		if (await this.inUpper(path)) return path;
		if (this.deleted.has(path)) throw fsError(ERRNO.ENOENT, "realpath", path);
		return this.lower.realpath(path);
	}

	async access(entryPath: string): Promise<void> {
		await this.stat(entryPath);
	}
}
