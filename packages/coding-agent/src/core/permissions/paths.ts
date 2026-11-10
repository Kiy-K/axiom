// Path normalization and classification for the permission gateway: where a path really points and what it is.

import { readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "../../config.ts";
import { isPathWithin } from "../../utils/paths.ts";
import { resolveToCwd } from "../tools/path-utils.ts";
import type { ResolvedPath } from "./types.ts";

/** Directory names under which any path is protected: writes there can change what code runs. */
const PROTECTED_SEGMENTS = new Set([".git", ".husky", CONFIG_DIR_NAME.toLowerCase()]);

/** Directory names that hold credentials. */
const SECRET_SEGMENTS = new Set([".ssh", ".aws", ".gnupg", ".kube", ".docker"]);

const SECRET_FILE_NAME =
	/^(?:\.env(?:\.(?!example$|sample$|template$|dist$).+)?|\.npmrc|\.netrc|\.pypirc|\.git-credentials|auth\.json|credentials(?:\.json)?|id_(?:rsa|dsa|ecdsa|ed25519)|.+\.(?:pem|key|p12|pfx|tfstate))$/i;

/** True when any segment of `path`, taken as text, is a credentials directory or a credentials file name. */
export function looksLikeSecretPath(path: string): boolean {
	const segments = path.split(/[\\/]/);
	return (
		segments.some((segment) => SECRET_SEGMENTS.has(segment.toLowerCase())) ||
		SECRET_FILE_NAME.test(segments[segments.length - 1])
	);
}

/** Symlinks followed while resolving one path; a longer chain is treated as a loop. */
const MAX_LINK_HOPS = 40;

/**
 * Normalize `input` the way the file tools do, then resolve symlinks. A path that does not exist yet resolves
 * through its deepest existing ancestor, so `link-to-outside/new.txt` is seen as outside the workspace. A dangling
 * symlink is followed to the place it points at, because writing through it creates that target.
 * Returns undefined when the path cannot be resolved (symlink loop, permission error): callers must deny.
 *
 * The result is a snapshot. A tool resolves the path again when it runs, so a link swapped in between can still
 * redirect it (TOCTOU); only a sandbox closes that window.
 */
export function resolveRealPath(input: string, cwd: string): string | undefined {
	const tail: string[] = [];
	let current = resolveToCwd(input, cwd);
	let hops = 0;
	while (true) {
		try {
			return join(realpathSync(current), ...tail);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT" && code !== "ENOTDIR") return undefined;
		}
		const target = readLinkOrUndefined(current);
		if (target !== undefined) {
			if (++hops > MAX_LINK_HOPS) return undefined;
			// A relative target is relative to the link's real directory: its parent may itself be reached through a link.
			current = resolve(realParentOrUndefined(current) ?? "", target);
			if (!isAbsolute(current)) return undefined;
			continue;
		}
		const parent = dirname(current);
		if (parent === current) return undefined;
		tail.unshift(basename(current));
		current = parent;
	}
}

/** The real path of the directory that holds `path`. It exists whenever `path` is a symlink. */
function realParentOrUndefined(path: string): string | undefined {
	try {
		return realpathSync(dirname(path));
	} catch {
		return undefined;
	}
}

/** The target of the symlink at `path`, or undefined when `path` is not a symlink or does not exist. */
function readLinkOrUndefined(path: string): string | undefined {
	try {
		return readlinkSync(path);
	} catch {
		return undefined;
	}
}

/** Resolve and classify `input` against the workspace, which is the session working directory. Undefined when it cannot be resolved. */
export function classifyPath(input: string, cwd: string): ResolvedPath | undefined {
	const real = resolveRealPath(input, cwd);
	const workspace = resolveRealPath(".", cwd);
	if (real === undefined || workspace === undefined) return undefined;

	const inWorkspace = isPathWithin(workspace, real);
	const agentDir = resolveRealPath(getAgentDir(), cwd) ?? getAgentDir();
	const inAgentDir = isPathWithin(agentDir, real);
	// Names above the workspace root are the user's own layout: a project under ~/.pi/ is not a protected path.
	const inspected = inWorkspace ? relative(workspace, real) : real;
	const segments = inspected.split(sep).map((segment) => segment.toLowerCase());
	return {
		real,
		workspace,
		inWorkspace,
		protected: inAgentDir || segments.some((segment) => PROTECTED_SEGMENTS.has(segment)),
		secret: inAgentDir || looksLikeSecretPath(inspected),
	};
}
