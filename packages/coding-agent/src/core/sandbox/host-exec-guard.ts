// Last line of defence: model-reachable code that would spawn on the host must ask here first.

/** Where a spawn site is reachable from the model. Named so a refusal tells the user which route was blocked. */
export type HostExecRoute =
	| "bash"
	| "user-bash"
	| "rpc-bash"
	| "package-install"
	| "extension-exec"
	| "mcp-stdio"
	| "config-command"
	| "codemode";

/** Whether sandbox mode is on, and which routes the user explicitly allowed to run on the host. */
export interface HostExecPolicy {
	sandboxMode: boolean;
	hostExecGranted: ReadonlySet<HostExecRoute>;
}

/** Throws when sandbox mode is on and the route has no host-exec grant; a no-op otherwise. */
export function assertHostExecAllowed(route: HostExecRoute, policy: HostExecPolicy): void {
	if (!policy.sandboxMode || policy.hostExecGranted.has(route)) return;
	throw new Error(
		`Blocked: "${route}" would run on the host, but sandbox mode is on. Grant host execution for this route or turn sandbox mode off.`,
	);
}
