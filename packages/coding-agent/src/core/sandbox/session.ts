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
	private closePromise: Promise<void> | undefined;

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
	close(): Promise<void> {
		this.closePromise ??= this.ready.then(async () => {
			if (this.state.kind !== "enforced") return;
			const backend = this.state.backend;
			this.state = { kind: "unavailable", reason: "the sandbox was closed" };
			await backend.close();
		});
		return this.closePromise;
	}

	/** A backend whose calls wait for the start and then refuse unless isolation was proven. */
	private deferredBackend(): SandboxBackend {
		return {
			exec: (command, cwd, options) =>
				this.ready.then(() => requireEnforced(this.state).exec(command, cwd, options)),
			fs: {
				readFile: (p) => this.ready.then(() => requireEnforced(this.state).fs.readFile(p)),
				writeFile: (p, content) => this.ready.then(() => requireEnforced(this.state).fs.writeFile(p, content)),
				mkdir: (p) => this.ready.then(() => requireEnforced(this.state).fs.mkdir(p)),
				access: (p) => this.ready.then(() => requireEnforced(this.state).fs.access(p)),
				stat: (p) => this.ready.then(() => requireEnforced(this.state).fs.stat(p)),
				listDir: (p) => this.ready.then(() => requireEnforced(this.state).fs.listDir(p)),
			},
			close: () => this.close(),
		};
	}
}
