// One sandbox per agent session: starts the VM in the background, exposes tool operations that wait for it, and closes it.

import type { SandboxBackend, SandboxState } from "./backend.ts";
import { requireEnforced } from "./backend.ts";
import { startGondolinBackend } from "./gondolin-backend.ts";
import { createSandboxOperations, type SandboxOperations } from "./operations.ts";
import { createWorkspace, type Workspace } from "./workspace.ts";

export class SandboxSession {
	/** The only source for a "sandboxed" indicator. */
	state: SandboxState = { kind: "starting" };
	readonly ready: Promise<SandboxState>;
	readonly operations: SandboxOperations;
	/** The guest's project view and write layer; set once the VM start succeeded. Write-back reads it before close. */
	workspace: Workspace | undefined;

	constructor(hostCwd: string) {
		this.ready = createWorkspace(hostCwd)
			.then((workspace) => {
				this.workspace = workspace;
				return startGondolinBackend({
					mounts: { "/workspace": workspace.provider },
					workspace: { mount: "/workspace", hostDir: hostCwd, hiddenPaths: workspace.hidden.slice(0, 20) },
				});
			})
			.catch(
				(error): SandboxState => ({
					kind: "failed",
					reason: error instanceof Error ? error.message : String(error),
				}),
			)
			.then((state) => (this.state = state));
		this.operations = createSandboxOperations(this.deferredBackend(), hostCwd);
	}

	/** Stops the VM, waiting for a start that is still in flight. */
	async close(): Promise<void> {
		const state = await this.ready;
		if (state.kind === "enforced") await state.backend.close();
	}

	/** A backend whose calls wait for the start and then refuse unless isolation was proven. */
	private deferredBackend(): SandboxBackend {
		const enforced = async () => requireEnforced(await this.ready);
		return {
			exec: async (command, cwd, options) => (await enforced()).exec(command, cwd, options),
			grantHost: (host) => requireEnforced(this.state).grantHost(host),
			revokeHost: (host) => requireEnforced(this.state).revokeHost(host),
			grantedHosts: () => (this.state.kind === "enforced" ? this.state.backend.grantedHosts() : []),
			fs: {
				readFile: async (p) => (await enforced()).fs.readFile(p),
				writeFile: async (p, content) => (await enforced()).fs.writeFile(p, content),
				mkdir: async (p) => (await enforced()).fs.mkdir(p),
				access: async (p) => (await enforced()).fs.access(p),
				stat: async (p) => (await enforced()).fs.stat(p),
				listDir: async (p) => (await enforced()).fs.listDir(p),
			},
			close: () => this.close(),
		};
	}
}
