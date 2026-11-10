// The rules: which actions a tool call performs, and whether each is allowed, denied or needs the user.

import { statSync } from "node:fs";
import { resolveReadPath } from "../tools/path-utils.ts";
import { classifyPath } from "./paths.ts";
import { classifyShellCommand } from "./shell.ts";
import type { Action, ActionVerdict } from "./types.ts";

const READ_TOOLS = new Set(["read", "ls", "find", "grep"]);
const WRITE_TOOLS = new Set(["write", "edit"]);
const SHELL_TOOLS = new Set(["bash", "powershell"]);
/** Tools that resolve their path with `resolveReadPath`, which may open a differently spelled file. */
const OPENS_NAME_VARIANTS = new Set(["read", "edit"]);

/** Longest shell text the user is shown in a prompt, after whitespace is collapsed. Longer text is denied, not abbreviated. */
export const MAX_COMMAND_CHARS = 2000;

/** Longest raw shell text that is looked at at all. */
const MAX_RAW_COMMAND_CHARS = 100_000;

/** Whitespace runs collapsed to one space, so padding cannot push the end of a command out of view. */
export function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/**
 * The effects of one tool call. Built-in names are interpreted by their documented input shape. A built-in whose
 * input does not have that shape (an extension replaced the tool with another schema) is `unsupported`, so the call
 * is denied rather than guessed at. Any other tool is an `extension` action: its effects are unknown.
 */
export function actionsForToolCall(toolName: string, input: Record<string, unknown>, cwd: string): Action[] {
	if (READ_TOOLS.has(toolName) || WRITE_TOOLS.has(toolName)) {
		const kind = READ_TOOLS.has(toolName) ? "read" : "write";
		// ls, find and grep default to the working directory.
		const target = input.path ?? (kind === "read" && toolName !== "read" ? "." : undefined);
		// Trust boundary: a replaced built-in may not follow the built-in schema.
		if (typeof target !== "string") return [unsupported(toolName, "input has no path")];
		// `read` and the hashline `edit` open the variant of the name that exists (curly quotes, NFD, AM/PM), the
		// replace-mode `edit` the name as given. Judge every file the call may open.
		const names = OPENS_NAME_VARIANTS.has(toolName) ? [target, resolveReadPath(target, cwd)] : [target];
		const actions: Action[] = [];
		for (const name of names) {
			const path = classifyPath(name, cwd);
			if (path === undefined) return [unsupported(toolName, `cannot resolve path ${JSON.stringify(target)}`)];
			if (actions.some((action) => "path" in action && action.path.real === path.real)) continue;
			const tree = kind === "read" && toolName !== "read" && !isSingleFile(path.real);
			actions.push(tree ? { kind, path, tree } : { kind, path });
		}
		return actions;
	}

	if (SHELL_TOOLS.has(toolName)) {
		if (typeof input.command !== "string") return [unsupported(toolName, "input has no command")];
		return [execAction(input.command)];
	}

	if (toolName === "job") {
		// Ownership limits which job a session can address; it does not authorize what stdin feeds an interpreter.
		if (input.action !== "send_input") return [];
		if (typeof input.input !== "string") return [unsupported(toolName, "send_input has no input")];
		return [execAction(input.input)];
	}

	return [{ kind: "extension", toolName }];
}

/** True when `path` names one existing file. A directory or a missing path counts as a tree. */
function isSingleFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

/** An action for shell text, from the model's `bash` tool, a job's stdin, or a command the user typed. */
export function execAction(command: string): Action {
	// Past the cap the command is denied anyway; skip the scan so cost does not grow with the input.
	return { kind: "exec", command, risks: command.length > MAX_RAW_COMMAND_CHARS ? [] : classifyShellCommand(command) };
}

function unsupported(toolName: string, reason: string): Action {
	return { kind: "unsupported", toolName, reason };
}

/** The decision for one action in `manual` mode. */
export function judgeAction(action: Action): ActionVerdict {
	switch (action.kind) {
		case "read": {
			const { path } = action;
			if (path.secret) return { decision: "ask", reason: "reads a file that looks like credentials" };
			if (!path.inWorkspace) {
				return {
					decision: "ask",
					reason: "reads outside the workspace",
					grantable: { kind: "read", dir: path.real },
				};
			}
			// A grant would also cover the credentials files under the directory, so none is offered.
			if (action.tree) return { decision: "ask", reason: "searches a directory; files there may hold credentials" };
			return { decision: "allow", reason: "read inside the workspace" };
		}
		case "write": {
			const { path } = action;
			if (path.protected) {
				return {
					decision: "deny",
					reason: "writes a protected path (git, harness configuration or the agent directory)",
				};
			}
			if (path.secret) return { decision: "ask", reason: "writes a file that looks like credentials" };
			if (!path.inWorkspace) {
				return {
					decision: "ask",
					reason: "writes outside the workspace",
					grantable: { kind: "write", dir: path.real },
				};
			}
			return { decision: "ask", reason: "edits a file", grantable: { kind: "write", dir: path.workspace } };
		}
		case "exec": {
			if (action.risks.includes("privilege")) return { decision: "deny", reason: "raises privileges" };
			if (action.command.length > MAX_RAW_COMMAND_CHARS || oneLine(action.command).length > MAX_COMMAND_CHARS) {
				return {
					decision: "deny",
					reason: `command is longer than ${MAX_COMMAND_CHARS} characters and cannot be reviewed; put the script in a file`,
				};
			}
			// `opaque` only says the shell hides what runs, which is true of every command.
			const named = action.risks.filter((risk) => risk !== "opaque");
			if (named.length > 0) return { decision: "ask", reason: `shell command (${named.join(", ")})` };
			return { decision: "ask", reason: "shell command", grantable: { kind: "exec", command: action.command } };
		}
		case "extension":
			return {
				decision: "ask",
				reason: "tool with effects the gateway cannot see",
				grantable: { kind: "extension", toolName: action.toolName },
			};
		case "unsupported":
			return { decision: "deny", reason: `cannot be mediated: ${action.reason}` };
	}
}
