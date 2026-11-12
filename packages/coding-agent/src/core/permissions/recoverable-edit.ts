// Check whether Git can recover an edit without running repository-configured helpers.
import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const NULL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null";

// Windows paths differ by case and Git prints them with forward slashes, so compare resolved, case-folded forms.
const samePath = (a: string, b: string): boolean =>
	process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;

/** Return whether a regular file is tracked in a clean worktree containing the workspace. */
export async function isRecoverableEdit(workspace: string, file: string): Promise<boolean> {
	try {
		const cwd = await realpath(workspace);
		const target = resolve(file);
		const inside = relative(cwd, target);
		if (
			!inside ||
			inside === ".." ||
			inside.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
			isAbsolute(inside)
		)
			return false;
		const targetStat = await lstat(target);
		if (!targetStat.isFile() || targetStat.nlink !== 1 || !samePath(await realpath(target), target)) return false;
		const env = {
			PATH: process.env.PATH,
			SYSTEMROOT: process.env.SYSTEMROOT,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: NULL_DEVICE,
			GIT_TERMINAL_PROMPT: "0",
			GIT_OPTIONAL_LOCKS: "0",
		};
		const git = async (dir: string, args: string[]): Promise<string> => {
			const result = await execFileAsync(
				"git",
				[
					"-C",
					dir,
					"-c",
					"core.fsmonitor=false",
					"-c",
					`core.hooksPath=${NULL_DEVICE}`,
					"-c",
					"core.pager=cat",
					"-c",
					"diff.external=",
					...args,
				],
				{ env, timeout: 5000, maxBuffer: 1024 * 1024 },
			);
			return result.stdout;
		};
		const root = await realpath((await git(cwd, ["rev-parse", "--show-toplevel"])).trim());
		const targetRoot = await realpath((await git(dirname(target), ["rev-parse", "--show-toplevel"])).trim());
		if (!samePath(targetRoot, root)) return false;
		const config = await git(cwd, ["config", "--null", "--name-only", "--list"]);
		if (config.split("\0").some((key) => key.toLowerCase().startsWith("filter."))) return false;
		const index = await git(cwd, ["ls-files", "-v", "-z"]);
		if (index.split("\0").some((entry) => entry !== "" && !entry.startsWith("H "))) return false;
		// Submodule status can execute helpers from a separate, unchecked Git configuration.
		const staged = await git(cwd, ["ls-files", "--stage", "-z"]);
		if (staged.split("\0").some((entry) => entry.startsWith("160000 "))) return false;
		await git(cwd, ["--literal-pathspecs", "ls-files", "--error-unmatch", "--", relative(root, target)]);
		return (
			(await git(cwd, [
				"status",
				"--porcelain=v1",
				"-z",
				"--untracked-files=normal",
				"--ignore-submodules=none",
			])) === ""
		);
	} catch {
		return false;
	}
}
