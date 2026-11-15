// Builds the guest's /workspace: the files git knows, minus secrets, over a read-only host view, with a memory write layer.

import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { ReadonlyProvider, RealFSProvider, ShadowProvider, type VirtualProvider } from "@earendil-works/gondolin";
import { classifyPath, looksLikeSecretPath } from "../permissions/paths.ts";
import { CowProvider } from "./cow-provider.ts";
import { type Manifest, takeManifest } from "./manifest.ts";

const execFileAsync = promisify(execFile);

/** Bytes the guest may write to its memory layer before writes fail with ENOSPC. */
export const DEFAULT_WRITE_CAP_BYTES = 512 * 1024 * 1024;

export interface Workspace {
	hostCwd: string;
	/** The write layer: its changes() and deletedPaths() are what write-back reviews. */
	cow: CowProvider;
	/** The same layer typed for mounting at /workspace. */
	provider: VirtualProvider;
	manifest: Manifest;
	/** Workspace-relative files git lists but the guest cannot see: secret-like names and links that leave the project. */
	hidden: string[];
}

/**
 * The guest sees what git tracks plus untracked files that are not ignored. Ignored paths (node_modules, build output)
 * and `.git` are not visible. Host edits to visible files reach the guest; files created on the host after the start do not.
 * Fails for a directory that is not a git work tree, because there is no list to build the visible set from.
 */
export async function createWorkspace(hostCwd: string, capBytes = DEFAULT_WRITE_CAP_BYTES): Promise<Workspace> {
	const listed = await listProjectFiles(hostCwd);
	const hidden: string[] = [];
	const visible = new Set<string>();
	for (const path of listed) {
		if (await isVisible(hostCwd, path)) visible.add(path);
		else hidden.push(path);
	}
	// Directories are visible only as the parents of visible files.
	const directories = new Set<string>();
	for (const path of visible) for (let dir = dirname(path); dir !== "."; dir = dirname(dir)) directories.add(dir);

	const lower = new ShadowProvider(new ReadonlyProvider(new RealFSProvider(hostCwd)), {
		shouldShadow: ({ path }) => {
			const relative = path.slice(1);
			return relative !== "" && !visible.has(relative) && !directories.has(relative);
		},
		denySymlinkBypass: true,
	});
	const cow = new CowProvider(lower as VirtualProvider, capBytes);
	return {
		hostCwd,
		cow,
		// The guest file-system RPC calls only the async methods, so the missing Sync ones are never reached.
		provider: cow as unknown as VirtualProvider,
		manifest: await takeManifest(hostCwd, visible),
		hidden,
	};
}

/** Tracked and untracked-not-ignored files below `hostCwd`, relative to it. */
async function listProjectFiles(hostCwd: string): Promise<string[]> {
	// A repository's own config can make git run a program (core.fsmonitor), which would run on the host.
	const git = (...args: string[]) =>
		execFileAsync("git", ["-c", "core.fsmonitor=false", "ls-files", "-z", ...args], {
			cwd: hostCwd,
			maxBuffer: 256 * 1024 * 1024,
			env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
		});
	let tracked: string;
	let untracked: string;
	try {
		tracked = (await git()).stdout;
		untracked = (await git("--others", "--exclude-standard")).stdout;
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`sandbox mode needs a git work tree to decide which files the guest sees: ${reason}`);
	}
	return [...new Set([...tracked.split("\0"), ...untracked.split("\0")].filter((path) => path !== ""))];
}

/** A file the guest may see: it exists, has no secret-like name, and any symlink stays inside the project. */
async function isVisible(hostCwd: string, path: string): Promise<boolean> {
	if (looksLikeSecretPath(path)) return false;
	let stats: Awaited<ReturnType<typeof lstat>>;
	try {
		stats = await lstat(join(hostCwd, path));
	} catch {
		return false;
	}
	if (stats.isSymbolicLink()) {
		const target = classifyPath(join(hostCwd, path), hostCwd);
		return target?.inWorkspace === true && !target.secret;
	}
	// A submodule is listed as a directory; its contents are not part of this project's list.
	return stats.isFile();
}
