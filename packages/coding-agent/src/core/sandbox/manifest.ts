// Start-of-session record of the host files the guest can see, used to detect host edits made while the guest ran.

import { lstat } from "node:fs/promises";
import { join } from "node:path";

export interface ManifestEntry {
	size: number;
	mtimeMs: number;
	mode: number;
}

/** Workspace-relative path -> state of that file on the host when the session started. */
export type Manifest = Map<string, ManifestEntry>;

/** Records size, mtime and mode of each path; paths that cannot be stat'ed (deleted since `git ls-files`) are skipped. */
export async function takeManifest(hostCwd: string, paths: Iterable<string>): Promise<Manifest> {
	const manifest: Manifest = new Map();
	for (const path of paths) {
		const entry = await statEntry(hostCwd, path);
		if (entry) manifest.set(path, entry);
	}
	return manifest;
}

/** True when the host file at `path` is not what the guest started from, or exists although the guest never saw it. */
export async function hostChanged(manifest: Manifest, hostCwd: string, path: string): Promise<boolean> {
	const now = await statEntry(hostCwd, path);
	const then = manifest.get(path);
	if (!now || !then) return now !== then;
	return now.size !== then.size || now.mtimeMs !== then.mtimeMs || now.mode !== then.mode;
}

async function statEntry(hostCwd: string, path: string): Promise<ManifestEntry | undefined> {
	try {
		const stats = await lstat(join(hostCwd, path));
		return { size: stats.size, mtimeMs: stats.mtimeMs, mode: stats.mode & 0o7777 };
	} catch {
		return undefined;
	}
}
