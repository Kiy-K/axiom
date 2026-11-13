// Opens an automatic edit through directory handles and keeps the validated file open.
import { constants } from "node:fs";
import { type FileHandle, lstat, open } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { MAX_HASHLINE_BYTES } from "../tools/hashline.ts";

export class EditLease {
	readonly target: string;
	readonly original: Buffer;
	private readonly file: FileHandle;

	constructor(file: FileHandle, target: string, original: Buffer) {
		this.target = target;
		this.file = file;
		this.original = original;
	}

	async assertUnchanged(): Promise<void> {
		const info = await this.file.stat();
		if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o111) !== 0 || info.size !== this.original.length) {
			throw new Error("The automatic edit target changed after authorization.");
		}
		const current = Buffer.alloc(info.size);
		const { bytesRead } = await this.file.read(current, 0, current.length, 0);
		if (bytesRead !== current.length || !current.equals(this.original)) {
			throw new Error("The automatic edit target changed after authorization.");
		}
	}

	async assertPath(): Promise<void> {
		await this.assertUnchanged();
		const target = await lstat(this.target);
		const opened = await this.file.stat();
		if (!target.isFile() || target.dev !== opened.dev || target.ino !== opened.ino) {
			throw new Error("The automatic edit path changed after authorization.");
		}
	}

	async write(content: Buffer): Promise<void> {
		await this.assertUnchanged();
		let offset = 0;
		while (offset < content.length) {
			const { bytesWritten } = await this.file.write(content, offset, content.length - offset, offset);
			if (bytesWritten === 0) throw new Error("Unable to write the automatic edit.");
			offset += bytesWritten;
		}
		await this.file.truncate(content.length);
	}

	async close(): Promise<void> {
		await this.file.close();
	}
}

// Node does not expose Linux O_PATH; it opens the inode without opening a device or FIFO.
const LINUX_O_PATH = 0o10000000;

export async function openEditLease(workspace: string, target: string): Promise<EditLease | undefined> {
	if (process.platform !== "linux") return undefined;
	const path = relative(workspace, target);
	if (!path || isAbsolute(path) || path.split(sep).some((part) => part === "..")) return undefined;
	const parts = path.split(sep);
	let directory = await open(workspace, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	try {
		for (const part of parts.slice(0, -1)) {
			const next = await open(
				`/proc/self/fd/${directory.fd}/${part}`,
				constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
			);
			await directory.close();
			directory = next;
		}
		const pathHandle = await open(
			`/proc/self/fd/${directory.fd}/${parts[parts.length - 1]}`,
			LINUX_O_PATH | constants.O_NOFOLLOW,
		);
		try {
			const info = await pathHandle.stat();
			if (!info.isFile() || info.nlink !== 1 || info.size > MAX_HASHLINE_BYTES || (info.mode & 0o111) !== 0) {
				return undefined;
			}
			const file = await open(`/proc/self/fd/${pathHandle.fd}`, constants.O_RDWR);
			try {
				const bytes = Buffer.alloc(info.size + 1);
				const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
				if (bytesRead !== info.size) {
					await file.close();
					return undefined;
				}
				const original = bytes.subarray(0, bytesRead);
				return new EditLease(file, target, original);
			} catch (error) {
				await file.close();
				throw error;
			}
		} finally {
			await pathHandle.close();
		}
	} finally {
		await directory.close();
	}
}
