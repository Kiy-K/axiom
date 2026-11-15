// Adapter from a SandboxBackend to the tools' Operations hooks, so bash, read, write, edit and ls run in the guest.

import path from "node:path";
import type { BashOperations } from "../tools/bash.ts";
import type { EditOperations } from "../tools/edit.ts";
import type { LsOperations } from "../tools/ls.ts";
import type { ReadOperations } from "../tools/read.ts";
import type { WriteOperations } from "../tools/write.ts";
import type { SandboxBackend } from "./backend.ts";

export const GUEST_WORKSPACE = "/workspace";

/** The guest is Linux without PowerShell; the tool must not fall back to the host shell. */
export const SANDBOX_POWERSHELL_REFUSAL: BashOperations = {
	exec: async () => {
		throw new Error("PowerShell is not available in sandbox mode.");
	},
};

export interface SandboxOperations {
	bash: BashOperations;
	read: ReadOperations;
	write: WriteOperations;
	edit: EditOperations;
	ls: LsOperations;
}

/** Operations for one workspace. Paths under `hostCwd` map to GUEST_WORKSPACE; any other absolute path is looked up in the guest as given. */
export function createSandboxOperations(backend: SandboxBackend, hostCwd: string): SandboxOperations {
	const guest = (hostPath: string) => toGuestPath(hostCwd, hostPath);
	const read: ReadOperations = {
		readFile: (p) => backend.fs.readFile(guest(p)),
		access: (p) => backend.fs.access(guest(p)),
	};
	const write: WriteOperations = {
		writeFile: (p, content) => backend.fs.writeFile(guest(p), content),
		mkdir: (p) => backend.fs.mkdir(guest(p)),
	};
	return {
		// The host env is never forwarded: options.env is dropped so the guest keeps its own minimal env.
		bash: {
			exec: (command, cwd, { onData, signal, timeout, onStdin }) =>
				backend.exec(command, guest(cwd), { onData, signal, timeout, onStdin }),
		},
		read,
		write,
		edit: { readFile: read.readFile, writeFile: write.writeFile, access: read.access },
		ls: {
			exists: (p) =>
				backend.fs.access(guest(p)).then(
					() => true,
					() => false,
				),
			stat: (p) => backend.fs.stat(guest(p)),
			readdir: (p) => backend.fs.listDir(guest(p)),
		},
	};
}

/** Map a host path to the guest: inside the workspace it moves under GUEST_WORKSPACE, outside it stays absolute. */
export function toGuestPath(hostCwd: string, hostPath: string): string {
	const relative = path.relative(hostCwd, path.resolve(hostCwd, hostPath));
	if (relative === "") return GUEST_WORKSPACE;
	if (relative.startsWith("..") || path.isAbsolute(relative)) {
		return path.posix.resolve("/", path.resolve(hostCwd, hostPath).split(path.sep).join("/"));
	}
	return path.posix.join(GUEST_WORKSPACE, relative.split(path.sep).join("/"));
}
