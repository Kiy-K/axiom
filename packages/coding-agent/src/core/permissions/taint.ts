// Where untrusted content can enter a session: the results of calls whose output the user did not write.

import type { Action } from "./types.ts";

/**
 * What the result of an allowed call is, when it is content from outside the user's own workspace: a tool the
 * gateway cannot see into (extension, MCP), a file outside the workspace, the output of a command that reaches the
 * network, or the output of a background job after such a command ran. Undefined for everything else. Files inside
 * the workspace are not a source: the user chose to trust the workspace, and a hostile file there is the residual
 * risk this gate cannot see (see docs/axiom/p6-auto-mode-contract.md).
 */
export function untrustedSource(
	toolName: string,
	input: Record<string, unknown>,
	actions: Action[],
	networkCommandSeen: boolean,
): string | undefined {
	for (const action of actions) {
		if (action.kind === "extension") return `the ${toolName} tool`;
		if (action.kind === "read" && !action.path.inWorkspace) return "a file outside the workspace";
		if (action.kind === "exec" && (action.risks.includes("network") || action.risks.includes("publish")))
			return "the output of a network command";
	}
	if (toolName === "job" && networkCommandSeen && (input.action === "output" || input.action === "status"))
		return "background job output after a network command";
	return undefined;
}

/** True when a command in `actions` reaches the network or publishes, so a later job read may show its output. */
export function runsNetworkCommand(actions: Action[]): boolean {
	return actions.some(
		(action) => action.kind === "exec" && (action.risks.includes("network") || action.risks.includes("publish")),
	);
}
