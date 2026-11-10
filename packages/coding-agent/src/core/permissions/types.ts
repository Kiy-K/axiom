// Shared vocabulary of the permission gateway: modes, actions a tool call performs, and decisions.

/**
 * `unrestricted` makes the gateway a no-op (Pi's behavior). `manual` mediates every action and asks for
 * anything that is not a read inside the workspace.
 */
export type PermissionMode = "unrestricted" | "manual";

export type Decision = "allow" | "deny" | "ask";

/** A path after normalization and symlink resolution. */
export interface ResolvedPath {
	/** Absolute path with symlinks resolved as far as the file system allows. */
	real: string;
	/** The workspace root (the session working directory, symlinks resolved). */
	workspace: string;
	inWorkspace: boolean;
	/** Writes are always denied: the path can change what code runs (git hooks, harness config, credentials store). */
	protected: boolean;
	/** Looks like credentials: reads and writes always ask and are never covered by a grant. */
	secret: boolean;
}

/**
 * Why a shell command needs more than a plain prompt. `privilege`: a command like `sudo` is run (denied).
 * `elevation`: such a word appears somewhere else in the command, which may or may not run it (asks, no grant).
 */
/** Why a shell command needs more than a plain prompt. Lexical, best effort: a shell is opaque. */
export type ShellRisk = "network" | "publish" | "destructive" | "secrets" | "privilege" | "elevation" | "opaque";

/** One effect a tool call would have. A call may have several, or none (for example `job list`). */
export type Action =
	/** `tree`: the call searches or lists a directory, so it reads every file under it, credentials included. */
	| { kind: "read"; path: ResolvedPath; tree?: boolean }
	| { kind: "write"; path: ResolvedPath }
	| { kind: "exec"; command: string; risks: ShellRisk[] }
	/** A tool the gateway knows nothing about (extension, MCP, codemode). Its effects are unknown. */
	| { kind: "extension"; toolName: string }
	/** A call the gateway cannot interpret, such as a built-in name with a replaced schema. Denied in `manual`. */
	| { kind: "unsupported"; toolName: string; reason: string };

/** What a grant covers. Matching is exact on `command` and `toolName`, and by containment on `dir`. */
export type GrantScope =
	| { kind: "read" | "write"; dir: string }
	| { kind: "exec"; command: string }
	| { kind: "extension"; toolName: string };

export interface Grant {
	id: string;
	scope: GrantScope;
	/** Epoch ms after which the grant no longer applies. */
	expiresAt: number;
}

/** The decision for one action, with the grant the user may be offered for it. */
export interface ActionVerdict {
	decision: Decision;
	reason: string;
	/** Set when `decision` is `ask` and a session grant may be offered. Absent: allow this single call only. */
	grantable?: GrantScope;
}
