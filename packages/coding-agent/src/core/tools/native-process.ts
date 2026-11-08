import { spawn } from "node:child_process";
import { Writable } from "node:stream";
import { getNativeProcessHelperPath } from "../../config.ts";
import type { ShellConfig } from "../../utils/shell.ts";
import type { NativeProcessHandle } from "./bash.ts";

export interface NativeProcessOptions {
	command: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
	shell: ShellConfig;
	onData: (data: Buffer) => void;
	onStdin?: (stdin: Writable) => void;
	onHandle?: (handle: NativeProcessHandle) => void;
	onSpawn?: (pid: number) => void;
	signal?: AbortSignal;
	timeoutMs?: number;
}

export class NativeTimeoutError extends Error {
	readonly shellExit: { exitCode: number; afterSeconds: number } | undefined;
	constructor(shellExit: { exitCode: number; afterSeconds: number } | undefined) {
		super("Native command timed out");
		this.shellExit = shellExit;
	}
}

/** Time a stop request waits for the helper to report its spawn before the helper itself is killed. */
const STARTUP_STOP_GRACE_MS = 5_000;

/** Execute through the owner of the native group; its PID is never used as a signal target. */
export async function executeNativeProcess(options: NativeProcessOptions): Promise<number | null> {
	if (options.signal?.aborted) throw new Error("aborted");
	const helper = spawn(getNativeProcessHelperPath(), [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
	let diagnostic = "";
	helper.stderr.setEncoding("utf8");
	helper.stderr.on("data", (chunk: string) => {
		diagnostic += chunk;
	});
	let closed = false;
	let lost = false;
	const lostListeners = new Set<() => void>();
	let empty = false;
	const emptyListeners = new Set<() => void>();
	let cleanupPending = false;
	let cleaned = false;
	const cleanedListeners = new Set<() => void>();
	let spawned = false;
	let provesEmpty: boolean | undefined;
	let exited = false;
	let exitCode: number | null = null;
	let exitAfterMs: number | undefined;
	let exitBeforeTimeout: { exitCode: number; afterSeconds: number } | undefined;
	let stdoutEnded = false;
	let stderrEnded = false;
	let settled = false;
	let timedOut = false;
	let postExitTimer: NodeJS.Timeout | undefined;
	let timeoutTimer: NodeJS.Timeout | undefined;
	let startupStopTimer: NodeJS.Timeout | undefined;
	let startupKilled = false;
	let nextInputId = 0;
	const writes = new Map<number, (error?: Error | null) => void>();
	const startedAt = performance.now();
	const completion = Promise.withResolvers<number | null>();
	const send = (message: object) => {
		if (!closed && !helper.stdin.destroyed) helper.stdin.write(`${JSON.stringify(message)}\n`);
	};
	const markLost = () => {
		if (lost) return;
		lost = true;
		for (const listener of lostListeners) listener();
	};
	const handle: NativeProcessHandle = {
		pid: 0,
		get canProveEmpty() {
			return provesEmpty;
		},
		get lost() {
			return lost;
		},
		onLost: (listener) => {
			if (lost) listener();
			else lostListeners.add(listener);
		},
		onEmpty: (listener) => {
			if (empty) listener();
			else emptyListeners.add(listener);
		},
		onCleaned: (listener) => {
			if (cleaned) listener();
			else cleanedListeners.add(listener);
		},
		cleanup: () => {
			if (closed || cleanupPending) return;
			cleanupPending = true;
			send({ type: "cleanup" });
		},
		signal: (signal) => send({ type: "signal", signal }),
		close: () => {
			if (closed) return;
			send({ type: "close" });
			closed = true;
			helper.stdin.end();
		},
	};
	const finish = (error?: Error) => {
		if (settled) return;
		settled = true;
		clearTimeout(postExitTimer);
		clearTimeout(timeoutTimer);
		clearTimeout(startupStopTimer);
		options.signal?.removeEventListener("abort", abort);
		if (error && !closed) {
			if (spawned) markLost();
			handle.signal("kill");
			handle.close();
		} else if (!options.onHandle || !spawned) handle.close();
		if (error) completion.reject(error);
		else completion.resolve(exitCode);
	};
	const armIdle = () => {
		clearTimeout(postExitTimer);
		postExitTimer = setTimeout(() => finish(), 100);
	};
	// The helper reads requests only after its spawn call returns; a spawn that stalls (for example an
	// executable on a hung filesystem) cannot see a kill request, so the helper is killed after a grace period.
	// shortcut: the helper's child, already forked and stuck in exec, is not tied to the helper and runs
	// unowned if the filesystem recovers; upgrade to a parent-death signal if that case matters.
	const stopBeforeSpawn = () => {
		if (spawned || startupStopTimer) return;
		startupStopTimer = setTimeout(() => {
			if (spawned || settled) return;
			startupKilled = helper.kill("SIGKILL");
		}, STARTUP_STOP_GRACE_MS);
	};
	const abort = () => {
		handle.signal("kill");
		stopBeforeSpawn();
	};
	const input = new Writable({
		write(chunk: Buffer, _encoding, callback) {
			if (closed || !spawned || exited) {
				callback(new Error("Process stdin is closed"));
				return;
			}
			const id = ++nextInputId;
			writes.set(id, callback);
			send({ type: "input", id, data: chunk.toString("base64") });
		},
		final(callback) {
			send({ type: "end_input" });
			callback();
		},
	});
	input.on("error", () => {});
	helper.stdin.on("error", () => {});
	helper.once("error", (error) => finish(error));
	helper.once("close", () => {
		const unexpected = !closed;
		closed = true;
		if (unexpected) markLost();
		const error = new Error(
			`Native process helper disconnected${diagnostic ? `: ${diagnostic.trim()}` : ""}; command outcome may be unknown`,
		);
		for (const callback of writes.values()) callback(error);
		writes.clear();
		if (!settled) {
			if (!startupKilled) finish(cleaned && options.signal?.aborted ? new Error("aborted") : error);
			else finish(options.signal?.aborted ? new Error("aborted") : undefined);
		}
	});
	const protocolError = (message: string) => {
		if (spawned) markLost();
		if (settled && !closed) {
			handle.signal("kill");
			handle.close();
		} else finish(new Error(message));
	};
	const onControl = (payload: Buffer) => {
		let message: {
			type: string;
			pid?: number;
			proves_empty?: boolean;
			code?: number | null;
			id?: number;
			error?: string;
			message?: string;
		};
		try {
			message = JSON.parse(payload.toString("utf8"));
		} catch {
			protocolError("Invalid native process helper response");
			return;
		}
		switch (message.type) {
			case "spawn":
				if (!Number.isInteger(message.pid) || !message.pid || message.pid < 0) {
					protocolError("Invalid native process handle");
					return;
				}
				spawned = true;
				provesEmpty = message.proves_empty;
				handle.pid = message.pid;
				if (options.onStdin && options.shell.commandTransport !== "stdin") options.onStdin(input);
				options.onHandle?.(handle);
				options.onSpawn?.(message.pid);
				if (options.shell.commandTransport === "stdin") input.end(options.command);
				if (options.signal?.aborted || timedOut) handle.signal("kill");
				break;
			case "cleaned":
				if (!cleanupPending) {
					protocolError("Unexpected native cleanup confirmation");
					break;
				}
				cleaned = true;
				closed = true;
				helper.stdin.end();
				for (const listener of cleanedListeners) listener();
				cleanedListeners.clear();
				break;
			case "empty":
				empty = true;
				for (const listener of emptyListeners) listener();
				emptyListeners.clear();
				break;
			case "stdout_end":
				stdoutEnded = true;
				if (exited && stderrEnded) finish();
				break;
			case "stderr_end":
				stderrEnded = true;
				if (exited && stdoutEnded) finish();
				break;
			case "exit":
				exited = true;
				exitCode = message.code ?? null;
				exitAfterMs = performance.now() - startedAt;
				if (stdoutEnded && stderrEnded) finish();
				else armIdle();
				break;
			case "input_result": {
				const callback = message.id === undefined ? undefined : writes.get(message.id);
				if (callback && message.id !== undefined) {
					writes.delete(message.id);
					callback(message.error ? new Error(message.error) : null);
				}
				break;
			}
			case "error":
				if (spawned) markLost();
				if (settled && !closed) handle.cleanup?.();
				finish(new Error(message.message ?? "Native process helper error"));
				break;
		}
	};
	let pending: Buffer = Buffer.alloc(0);
	helper.stdout.on("data", (chunk: Buffer) => {
		pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
		while (pending.length >= 5) {
			const length = pending.readUInt32BE(1);
			if (length > 16 * 1024 * 1024) {
				protocolError("Invalid native process frame length");
				return;
			}
			if (pending.length < length + 5) return;
			const type = pending[0];
			const payload = pending.subarray(5, length + 5);
			pending = pending.subarray(length + 5);
			if (type === 74) onControl(payload);
			else if (type === 79 || type === 69) {
				if (!settled) {
					options.onData(payload);
					if (exited) armIdle();
				}
			} else {
				protocolError("Invalid native process frame type");
				return;
			}
		}
	});
	options.signal?.addEventListener("abort", abort, { once: true });
	if (options.timeoutMs !== undefined)
		timeoutTimer = setTimeout(() => {
			timedOut = true;
			if (exited && exitAfterMs !== undefined && exitCode !== null) {
				exitBeforeTimeout = { exitCode, afterSeconds: Math.round(exitAfterMs / 100) / 10 };
			}
			handle.signal("kill");
			stopBeforeSpawn();
		}, options.timeoutMs);
	send({
		type: "start",
		command: options.shell.shell,
		args: options.shell.commandTransport === "stdin" ? options.shell.args : [...options.shell.args, options.command],
		cwd: options.cwd,
		env: options.env,
		stdin: options.shell.commandTransport === "stdin" || !!options.onStdin,
	});
	try {
		const code = await completion.promise;
		if (options.signal?.aborted) throw new Error("aborted");
		if (timedOut) throw new NativeTimeoutError(exitBeforeTimeout);
		return code;
	} finally {
		clearTimeout(timeoutTimer);
	}
}
