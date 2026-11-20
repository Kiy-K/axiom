// The sandbox backend contract and its state: what runs model-reachable commands, and whether isolation is proven.

import type { Writable } from "node:stream";

/** What one command run needs from a backend. Mirrors BashOperations.exec so the adapter can wrap it directly. */
export interface SandboxExecOptions {
	onData: (data: Buffer) => void;
	signal?: AbortSignal;
	/** Seconds; the backend kills the guest process and throws `timeout:<seconds>` when it passes. */
	timeout?: number;
	env?: Record<string, string>;
	/** Receives the guest process's stdin. Only background jobs ask for it. */
	onStdin?: (stdin: Writable) => void;
}

/** File access in the guest's view of the filesystem, so hidden paths stay hidden and writes land in the write layer. */
export interface SandboxFs {
	readFile(guestPath: string): Promise<Buffer>;
	writeFile(guestPath: string, content: string): Promise<void>;
	mkdir(guestPath: string): Promise<void>;
	access(guestPath: string): Promise<void>;
	stat(guestPath: string): Promise<{ isDirectory(): boolean }>;
	listDir(guestPath: string): Promise<string[]>;
}

/** A running isolated environment. Only an `enforced` state exposes one. */
export interface SandboxBackend {
	/** Run `command` in `cwd` (a guest path) and stream output. Null exit code means the process was killed. */
	exec(command: string, cwd: string, options: SandboxExecOptions): Promise<{ exitCode: number | null }>;
	readonly fs: SandboxFs;
	close(): Promise<void>;
}

/** Why a command ran, or could not run, without isolation. The label "sandboxed" is only valid for `enforced`. */
// @lat: [[decisions#Sandboxed execution]]
export type SandboxState =
	| { kind: "unavailable"; reason: string }
	| { kind: "starting" }
	| { kind: "enforced"; backend: SandboxBackend }
	| { kind: "failed"; reason: string };

/** Throws unless isolation is proven; tool code calls this before every guest command. */
export function requireEnforced(state: SandboxState): SandboxBackend {
	if (state.kind === "enforced") return state.backend;
	const why = state.kind === "starting" ? "the sandbox is still starting" : state.reason;
	throw new Error(`Sandbox not enforced: ${why}`);
}
