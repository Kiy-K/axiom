// The `readonly-shell` rule of `auto`: a closed grammar for shell lines that only read named workspace files.
// Positive by construction: a line is allowed only if every word fits; the lexical classifier in shell.ts is never
// used as proof of safety. Spec: docs/axiom/p6-auto-mode-contract.md, "Positive rules".

import { statSync } from "node:fs";
import { delimiter, isAbsolute } from "node:path";
import { classifyPath } from "./paths.ts";

/** A word is made of these characters only: no quotes, `$`, `~`, globs, redirections, braces or backticks. */
const WORD = /^[A-Za-z0-9_./@%+=:,-]+$/;
const SEPARATORS = new Set(["&&", "||", ";", "|"]);

interface CommandSpec {
	/** Letters of flags without a value; a cluster such as `-la` is allowed when every letter is listed. */
	flags: string;
	/** Letters of flags that take the next word as a number, and only as a word of their own (`-n 5`). */
	valued: string;
	/** `none`: no file arguments; `any`: files optional; `file`: a regular file is required unless the command follows `|`. */
	files: "none" | "any" | "file";
}

// Not here: `ls -R` (walks trees), `ls -l` (prints symlink targets), `tail -f` (never exits), and `git` (it runs
// programs named in the repository's own configuration).
const COMMANDS: Record<string, CommandSpec> = {
	pwd: { flags: "", valued: "", files: "none" },
	ls: { flags: "aA1FtSr", valued: "", files: "any" },
	wc: { flags: "lwcm", valued: "", files: "file" },
	head: { flags: "", valued: "nc", files: "file" },
	tail: { flags: "", valued: "nc", files: "file" },
};

interface Segment {
	words: string[];
	/** The separator before this segment is `|`, so stdin is the previous command's output. */
	piped: boolean;
}

/** Split on spaces and tabs only. Undefined when a word or separator is outside the grammar. */
function segments(line: string): Segment[] | undefined {
	if (!/^[ \t]*[^ \t]/.test(line)) return undefined;
	const result: Segment[] = [{ words: [], piped: false }];
	for (const word of line.split(/[ \t]+/).filter((part) => part !== "")) {
		if (SEPARATORS.has(word)) {
			if (result[result.length - 1].words.length === 0) return undefined;
			result.push({ words: [], piped: word === "|" });
		} else if (WORD.test(word) && !word.startsWith("=")) {
			result[result.length - 1].words.push(word);
		} else {
			return undefined;
		}
	}
	return result[result.length - 1].words.length === 0 ? undefined : result;
}

/** The file arguments of one segment, or undefined when its command, a flag or a flag value is outside the table. */
function fileArguments(segment: Segment): string[] | undefined {
	const [name, ...args] = segment.words;
	if (!Object.hasOwn(COMMANDS, name)) return undefined;
	const spec = COMMANDS[name];
	const files: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const word = args[i];
		if (word.startsWith("-")) {
			// A non-permuting head/tail/wc (POSIXLY_CORRECT, BSD) reads a flag after a file as another file name.
			if (files.length > 0) return undefined;
			const letters = word.slice(1);
			if (letters.length === 1 && spec.valued.includes(letters)) {
				if (!/^[0-9]+$/.test(args[++i] ?? "")) return undefined;
			} else if (letters === "" || [...letters].some((letter) => !spec.flags.includes(letter))) {
				return undefined;
			}
		} else if (word.startsWith("+")) {
			return undefined;
		} else {
			files.push(word);
		}
	}
	if (spec.files === "none" && files.length > 0) return undefined;
	if (spec.files === "file" && files.length === 0 && !segment.piped) return undefined;
	return files;
}

/** True when a `PATH` entry could name a workspace file, so `ls` might be a file the model wrote. */
function pathEntryUnsafe(entry: string, cwd: string): boolean {
	if (entry === "" || !isAbsolute(entry)) return true;
	const resolved = classifyPath(entry, cwd);
	return resolved === undefined || resolved.inWorkspace;
}

/**
 * True when `line` only reads: every command is one of the table above with listed flags, and every file argument is
 * a plain path inside the workspace that is neither protected nor credentials (and, for `head`, `tail` and `wc`, a
 * regular file, because a FIFO or device would hang the command). Off when `PATH` has an entry that is empty,
 * relative or inside the workspace. The path checks are a snapshot: a swap after them is a P7 matter.
 */
export function isReadonlyShell(line: string, cwd: string, env: NodeJS.ProcessEnv): boolean {
	const parsed = segments(line);
	if (!parsed) return false;
	// Variables that change how bash resolves or runs an allowed command: startup files, exported functions, POSIX mode.
	if (
		Object.keys(env).some(
			(key) => key === "BASH_ENV" || key === "ENV" || key === "POSIXLY_CORRECT" || key.startsWith("BASH_FUNC_"),
		)
	)
		return false;
	// Windows is excluded from the rule, so `PATH` is spelled exactly like this.
	if ((env.PATH ?? "").split(delimiter).some((entry) => pathEntryUnsafe(entry, cwd))) return false;
	for (const segment of parsed) {
		const files = fileArguments(segment);
		if (!files) return false;
		const mustBeRegular = segment.words[0] !== "ls" && segment.words[0] !== "pwd";
		for (const file of files) {
			// classifyPath folds `..` before it follows links, the shell after: `link/..` is not the workspace.
			if (/(^|\/)\.\.(\/|$)/.test(file)) return false;
			// normalizePath, used by classifyPath, strips a leading `@` and a `file:` prefix; the shell does neither.
			if (file.startsWith("@") || file.includes(":")) return false;
			const path = classifyPath(file, cwd);
			if (!path?.inWorkspace || path.protected || path.secret) return false;
			if (mustBeRegular && !isRegularFile(path.real)) return false;
		}
	}
	return true;
}

/** A regular file with a single link: a second name could be an outside file the workspace path only mirrors. */
function isRegularFile(path: string): boolean {
	try {
		const info = statSync(path);
		return info.isFile() && info.nlink === 1;
	} catch {
		return false;
	}
}
