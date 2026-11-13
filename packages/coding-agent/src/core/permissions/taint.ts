// Where untrusted content can enter a session: the results of calls whose output the user did not write.

import { parseCommands } from "./shell.ts";
import type { Action } from "./types.ts";

/**
 * Commands the shell classifier does not name as network that still fetch from outside: package runners and
 * resolvers, build tools that download dependencies, `git submodule`, `python -c` and `node -e` (which can do
 * anything). Used only to mark a task as having seen outside content, so a false match costs an extra ask, not a block.
 * Lexical like the classifier: `C=curl; $C x` is still invisible.
 */
const FETCHING_COMMANDS = new Set([
	"npx",
	"bunx",
	"pnpx",
	"uvx",
	"pipx",
	"poetry",
	"mvn",
	"mvnw",
	"gradle",
	"gradlew",
	"dotnet",
	"deno",
	"lynx",
	"aria2c",
]);
const FETCHING_SUBCOMMANDS: Record<string, string[]> = {
	pnpm: ["dlx", "exec", "install", "add", "update"],
	yarn: ["dlx", "install", "add", "up"],
	npm: ["exec", "install", "ci", "add", "update", "x"],
	bun: ["x", "install", "add", "update"],
	pip: ["install", "download"],
	pip3: ["install", "download"],
	uv: ["pip", "add", "sync", "run"],
	gem: ["install"],
	bundle: ["install", "update"],
	git: ["submodule", "archive", "clone", "fetch", "pull", "ls-remote"],
	cargo: ["build", "run", "test", "install", "fetch", "update", "check"],
	go: ["get", "install", "mod", "build", "run", "test"],
	openssl: ["s_client"],
	docker: ["pull", "run", "build", "compose"],
};
/** Interpreters whose `-c` or `-e` script can do anything, the network included. */
const SCRIPT_INTERPRETERS = new Set(["python", "python3", "node", "ruby", "perl"]);

function fetchesFromOutside(command: string): boolean {
	return parseCommands(command).some((words) => {
		const start = words.findIndex((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
		if (start === -1) return false;
		const name = words[start].split("/").pop() ?? "";
		const rest = words.slice(start + 1, start + 6);
		if (FETCHING_COMMANDS.has(name)) return true;
		if (SCRIPT_INTERPRETERS.has(name) && rest.slice(0, 2).some((word) => /^-[a-z]*[ce]$/.test(word))) return true;
		return FETCHING_SUBCOMMANDS[name]?.some((sub) => rest.includes(sub)) ?? false;
	});
}

/** True when `action` is a shell command that reaches the network, publishes, or fetches as the list above says. */
function reachesOutside(action: Action): boolean {
	return (
		action.kind === "exec" &&
		(action.risks.includes("network") || action.risks.includes("publish") || fetchesFromOutside(action.command))
	);
}

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
		if (reachesOutside(action)) return "the output of a network command";
	}
	if (toolName === "job" && networkCommandSeen && (input.action === "output" || input.action === "status"))
		return "background job output after a network command";
	return undefined;
}

/** True when a command in `actions` reaches the network or publishes, so a later job read may show its output. */
export function runsNetworkCommand(actions: Action[]): boolean {
	return actions.some(reachesOutside);
}
