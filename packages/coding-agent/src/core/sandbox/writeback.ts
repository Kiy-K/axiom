// Moves the guest's workspace changes to the host: plan (silent / review / conflict), then apply what was approved.

import { chmod, lstat, mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, sep } from "node:path";
import { classifyPath } from "../permissions/paths.ts";
import { hostChanged } from "./manifest.ts";
import type { Workspace } from "./workspace.ts";

export interface PlannedChange {
	/** Workspace-relative path. */
	path: string;
	action: "write" | "symlink" | "delete";
	mode: number;
	size: number;
	/** Why the user must approve it; set only for changes in `review`. */
	reason?: string;
}

export interface WriteBackPlan {
	/** Ordinary source edits: applied without asking. */
	silent: PlannedChange[];
	/** Everything that can run code, hold secrets or change permissions: one prompt for the lot. */
	review: PlannedChange[];
	/** Changes to files that also changed on the host during the session: never applied. */
	conflicts: PlannedChange[];
}

export interface WriteBackResult {
	applied: string[];
	failed: { path: string; error: string }[];
}

/** Sorts every guest change into silent, review or conflict. Reads the host only to classify paths and compare with the manifest. */
export async function planWriteBack(workspace: Workspace): Promise<WriteBackPlan> {
	const plan: WriteBackPlan = { silent: [], review: [], conflicts: [] };
	const { cow, hostCwd, manifest } = workspace;
	const changes: PlannedChange[] = [
		...(await cow.changes()).map((entry) => ({
			path: entry.path.slice(1),
			action: entry.kind === "symlink" ? ("symlink" as const) : ("write" as const),
			mode: entry.mode & 0o7777,
			size: entry.size,
		})),
		...cow.deletedPaths().map((path) => ({ path: path.slice(1), action: "delete" as const, mode: 0, size: 0 })),
	];
	for (const change of changes) {
		if (await hostChanged(manifest, hostCwd, change.path)) {
			plan.conflicts.push(change);
			continue;
		}
		const reason = reviewReason(workspace, change);
		if (reason) plan.review.push({ ...change, reason });
		else plan.silent.push(change);
	}
	return plan;
}

/** The reason a change needs the user's approval, or undefined for an ordinary source edit. */
function reviewReason({ hostCwd, manifest }: Workspace, change: PlannedChange): string | undefined {
	const target = classifyPath(join(hostCwd, change.path), hostCwd);
	if (!target) return "path cannot be resolved on the host";
	if (!target.inWorkspace) return "resolves outside the project";
	if (target.secret) return "looks like a secret file";
	if (target.protected) return "protected path (agent configuration, git internals)";
	if (target.runsCode) return "can run code (hooks, package scripts, CI, build config)";
	if (change.action === "symlink") return "symbolic link";
	if (change.action === "write") {
		const before = manifest.get(change.path);
		if (!before && change.mode & 0o111) return "new executable file";
		if (before && (before.mode & 0o7777) !== change.mode) return "permission change";
	}
	return undefined;
}

/** Applies the given changes to the host one by one; a failure is recorded and the rest still run. */
export async function applyWriteBack(workspace: Workspace, changes: PlannedChange[]): Promise<WriteBackResult> {
	const result: WriteBackResult = { applied: [], failed: [] };
	for (const change of changes) {
		try {
			await applyOne(workspace, change);
			result.applied.push(change.path);
		} catch (error) {
			result.failed.push({ path: change.path, error: error instanceof Error ? error.message : String(error) });
		}
	}
	return result;
}

async function applyOne({ hostCwd, cow }: Workspace, change: PlannedChange): Promise<void> {
	const destination = await safeHostPath(hostCwd, change.path);
	const guestPath = `/${change.path}`;
	if (change.action === "delete") {
		await rm(destination, { force: true });
		return;
	}
	await mkdir(dirname(destination), { recursive: true });
	// Written beside the target and renamed over it, so a reader never sees half a file and a link at the target is replaced, not followed.
	const temporary = `${destination}.pi-sandbox-${process.pid}`;
	try {
		if (change.action === "symlink") {
			await symlink(await cow.readUpperLink(guestPath), temporary);
		} else {
			await writeFile(temporary, await cow.readUpper(guestPath), { mode: change.mode });
			await chmod(temporary, change.mode);
		}
		await rename(temporary, destination);
	} catch (error) {
		await rm(temporary, { force: true });
		throw error;
	}
}

/** The host path for a workspace-relative path, after checking that no directory on the way is a symlink or a file. */
async function safeHostPath(hostCwd: string, relativePath: string): Promise<string> {
	const parts = relativePath.split("/");
	if (isAbsolute(relativePath) || parts.some((part) => part === ".." || part === "" || part === ".")) {
		throw new Error(`refusing unsafe path "${relativePath}"`);
	}
	let current = hostCwd;
	for (const part of parts.slice(0, -1)) {
		current = join(current, part);
		const stats = await lstat(current).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return undefined;
			throw error;
		});
		if (!stats) break;
		if (!stats.isDirectory()) throw new Error(`"${current.slice(hostCwd.length + 1)}" is not a plain directory`);
	}
	const destination = join(hostCwd, ...parts);
	if (!destination.startsWith(hostCwd + sep)) throw new Error(`refusing unsafe path "${relativePath}"`);
	return destination;
}

/** Copies changes that were not applied (declined, conflicting, failed) to `directory`, so the guest's work is never lost silently. */
export async function saveUnapplied(workspace: Workspace, changes: PlannedChange[], directory: string): Promise<void> {
	for (const change of changes) {
		if (change.action === "delete") continue;
		const target = join(directory, ...change.path.split("/").filter((part) => part !== ".." && part !== ""));
		await mkdir(dirname(target), { recursive: true });
		if (change.action === "symlink")
			await writeFile(target, `symlink -> ${await workspace.cow.readUpperLink(`/${change.path}`)}\n`);
		else await writeFile(target, await workspace.cow.readUpper(`/${change.path}`));
	}
}
