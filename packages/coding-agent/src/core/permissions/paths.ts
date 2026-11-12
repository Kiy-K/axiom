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

/** Directory names under which any file can run as code: CI definitions, scripts, editor and agent configuration. */
const CODE_RUNNING_DIRS = new Set([
	".github",
	".gitlab",
	".circleci",
	".buildkite",
	".devcontainer",
	".claude",
	".cursor",
	".agents",
	".cargo",
	"scripts",
	"bin",
	// Installed and generated code: not tracked, but loaded and run by whatever uses it.
	"node_modules",
	".venv",
	"venv",
	"site-packages",
]);

/** File names that run code or choose what code runs. Compared in lower case. */
const CODE_RUNNING_NAMES = new Set([
	"package.json",
	"bunfig.toml",
	".yarnrc",
	".yarnrc.yml",
	"makefile",
	"gnumakefile",
	"justfile",
	"taskfile.yml",
	"procfile",
	"mise.toml",
	"lefthook.yml",
	".pre-commit-config.yaml",
	".gitlab-ci.yml",
	".travis.yml",
	"azure-pipelines.yml",
	"jenkinsfile",
	"conftest.py",
	"setup.py",
	"setup.cfg",
	"pyproject.toml",
	"tox.ini",
	"sitecustomize.py",
	"cargo.toml",
	"build.rs",
	"pom.xml",
	"gemfile",
	"rakefile",
	"cmakelists.txt",
	"bitbucket-pipelines.yml",
	"pytest.ini",
	"gradlew",
	"mvnw",
	".mcp.json",
	".pnpmfile.cjs",
	".envrc",
	".devcontainer.json",
	".gitattributes",
	".gitmodules",
	"agents.md",
	"claude.md",
	".cursorrules",
]);

/** Name shapes that run code, in lower case. `Dockerfile.md` is documentation, not a Dockerfile. */
const CODE_RUNNING_NAME_PATTERNS = [
	/^dockerfile(\.(?!md$).+)?$/,
	/^docker-compose.*\.ya?ml$/,
	/^(vite|vitest|jest|eslint|webpack|rollup|babel|postcss|tailwind|next|nuxt|svelte|astro|remix|tsup|tsdown|esbuild|playwright|cypress|prettier|stylelint|commitlint|metro|rspack|turbo|gulp|grunt)\.config\.[cm]?[jt]s$/,
	/^vitest\.workspace\.[cm]?[jt]s$/,
	/^(gulpfile|gruntfile)(\..+)?$/,
	/^\.(babelrc|eslintrc|mocharc|lintstagedrc|huskyrc|prettierrc)(\..+)?$/,
	/^build\.gradle(\.kts)?$/,
	/\.sh$/,
	/\.pth$/,
];

/**
 * True when a file at `segments` (lower-cased, relative to the workspace) can run as code or change what runs.
 * A best-effort denylist: every source and test file is code that `npm test` runs, so no list is complete.
 */
export function looksLikeCodeRunningPath(rawSegments: string[]): boolean {
	// Windows ignores trailing dots and spaces, so `package.json.` is `package.json` there.
	const segments = rawSegments.map((segment) => segment.replace(/[. ]+$/, ""));
	const name = segments[segments.length - 1] ?? "";
	const dirs = segments.slice(0, -1);
	if (dirs.some((dir) => CODE_RUNNING_DIRS.has(dir))) return true;
	if (dirs.includes(".yarn") && dirs[dirs.indexOf(".yarn") + 1] === "releases") return true;
	if (dirs[dirs.length - 1] === ".vscode" && ["tasks.json", "settings.json", "launch.json"].includes(name))
		return true;
	return CODE_RUNNING_NAMES.has(name) || CODE_RUNNING_NAME_PATTERNS.some((pattern) => pattern.test(name));
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
		runsCode: inWorkspace && looksLikeCodeRunningPath(segments),
	};
}
