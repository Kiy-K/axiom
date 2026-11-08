/**
 * One command execution tracked as a job: its exec promise, output log, optional stdin and terminal state.
 * A job is prepared unregistered for every bash call and becomes a registered background job only when it
 * yields or starts in the background (see JobSupervisor.adopt). The first terminal transition wins.
 */

import type { Writable } from "node:stream";
import type { BashOperations, NativeProcessHandle } from "../tools/bash.ts";
import { LogBuffer } from "./log-buffer.ts";

export type JobState = "running" | "completed" | "failed" | "stopped" | "timed_out";

/** Time between SIGTERM and SIGKILL when a job is stopped gracefully. */
export const STOP_GRACE_MS = 3_000;
/** Largest input `send_input` accepts in one call. */
export const MAX_INPUT_BYTES = 16 * 1024;
/** How long `send_input` waits for the pipe to take the input before reporting it as queued. */
export const STDIN_FLUSH_WAIT_MS = 1_000;

export interface JobSnapshot {
	jobId: string;
	name: string | undefined;
	command: string;
	state: JobState;
	/** Exit code of the shell (128 + N for signal N). Undefined while running or when no code was reported. */
	exitCode: number | undefined;
	/** Error text for jobs that did not exit with a code: spawn failure, timeout, abort. */
	error: string | undefined;
	hasStdin: boolean;
	/** Whether processes started by the job may still run after its shell exited. */
	descendants: boolean;
	startedAt: number;
	endedAt: number | undefined;
}

export interface ManagedJobInit {
	jobId: string;
	owner: string;
	name: string | undefined;
	command: string;
	stdin: boolean;
	onSpawned: (job: ManagedJob) => void;
	onHandleLost: (job: ManagedJob) => void;
	onGroupEmpty: (job: ManagedJob) => void;
	onSettled: (job: ManagedJob) => void;
}

export interface RunOptions {
	cwd: string;
	env: NodeJS.ProcessEnv;
	timeout: number | undefined;
	onData: ((chunk: Buffer) => void) | undefined;
}

export class ManagedJob {
	readonly jobId: string;
	readonly owner: string;
	readonly name: string | undefined;
	readonly command: string;
	readonly log = new LogBuffer();
	readonly startedAt = Date.now();
	/** Whether the agent is told when this job finishes. Set when the job is adopted. */
	announce = false;
	/** Whether the job is registered with the supervisor (running in the background). */
	adopted = false;
	/** Whether the model has read this job's state through a `job` call. */
	observed = false;

	private readonly wantsStdin: boolean;
	private readonly onSpawned: (job: ManagedJob) => void;
	private readonly onHandleLost: (job: ManagedJob) => void;
	private readonly onGroupEmpty: (job: ManagedJob) => void;
	private readonly onSettled: (job: ManagedJob) => void;
	private readonly controller = new AbortController();
	private readonly settledSignal = Promise.withResolvers<void>();
	private readonly launchSignal = Promise.withResolvers<void>();
	private readonly completionSignal = Promise.withResolvers<{ exitCode: number | null }>();
	private readonly cleanupSignal = Promise.withResolvers<boolean>();
	private stateValue: JobState = "running";
	private exitCodeValue: number | undefined;
	private errorValue: string | undefined;
	private endedAtValue: number | undefined;
	private descendantsValue = false;
	private pidValue: number | undefined;
	private handle: NativeProcessHandle | undefined;
	private killed = false;
	private closed = false;
	private lostHandle = false;
	private groupEmpty = false;
	private stdinStream: Writable | undefined;
	private stopRequested = false;
	private launchFailedValue = false;
	private handedOffValue = false;
	private killTimer: NodeJS.Timeout | undefined;

	/** Resolves when the job reaches a terminal state, whatever the cause. */
	readonly settled: Promise<void> = this.settledSignal.promise;
	/** Resolves once the process exists or the job has settled. Rejects when the launch failed. */
	readonly launched: Promise<void> = this.launchSignal.promise;
	/** The execution outcome: the exit code, or the error that ended it (abort, timeout, spawn failure). */
	readonly completion: Promise<{ exitCode: number | null }> = this.completionSignal.promise;
	/** Resolves true on proven empty group, false if the capability is lost. */
	readonly cleanupConfirmed: Promise<boolean> = this.cleanupSignal.promise;

	constructor(init: ManagedJobInit) {
		this.jobId = init.jobId;
		this.owner = init.owner;
		this.name = init.name;
		this.command = init.command;
		this.wantsStdin = init.stdin;
		this.onSpawned = init.onSpawned;
		this.onHandleLost = init.onHandleLost;
		this.onGroupEmpty = init.onGroupEmpty;
		this.onSettled = init.onSettled;
		// Callers that never await these must not produce unhandled rejections.
		this.launched.catch(() => {});
		this.completion.catch(() => {});
	}

	get state(): JobState {
		return this.stateValue;
	}

	get pid(): number | undefined {
		return this.pidValue;
	}

	/** Mark the job as handed to the model (returned as a background handle). Failures before this are not announced. */
	markHandedOff(): void {
		this.handedOffValue = true;
	}

	/** Whether execution failed before a process spawned. Such a job never ran and is not announced. */
	get launchFailed(): boolean {
		return this.launchFailedValue;
	}

	/** Start the execution. Errors from `operations.exec` become the job's terminal state. */
	run(operations: BashOperations, options: RunOptions): void {
		const execution = Promise.resolve().then(() =>
			operations.exec(this.command, options.cwd, {
				onData: (chunk) => {
					this.log.append(chunk);
					options.onData?.(chunk);
				},
				signal: this.controller.signal,
				timeout: options.timeout,
				env: options.env,
				onStdin: this.wantsStdin
					? (stdin: Writable) => {
							// A write after the child exits fails; sendInput reports it, not an unhandled error event.
							stdin.on("error", () => {});
							this.stdinStream = stdin;
						}
					: undefined,
				onSpawn: (pid: number) => {
					this.pidValue = pid;
					this.onSpawned(this);
					if (!operations.retainsProcessHandle) this.launchSignal.resolve();
				},
				onHandle: (handle: NativeProcessHandle) => {
					this.pidValue = handle.pid;
					this.launchSignal.resolve();
					this.handle = handle;
					handle.onLost?.(() => {
						this.lostHandle = true;
						this.onHandleLost(this);
						this.cleanupSignal.resolve(false);
					});
					handle.onEmpty?.(() => {
						this.groupEmpty = true;
						this.cleanupSignal.resolve(true);
						if (this.stateValue !== "running") this.onGroupEmpty(this);
					});
					handle.onCleaned?.(() => {
						this.groupEmpty = true;
						this.cleanupSignal.resolve(true);
						this.onGroupEmpty(this);
					});
					this.onSpawned(this);
					if (this.closed) this.cleanupHandle();
					else if (this.killed) handle.signal("kill");
				},
			}),
		);
		execution.then(
			(result) => this.settle({ exitCode: result.exitCode }),
			(error: unknown) => this.settle({ error: error instanceof Error ? error : new Error(String(error)) }),
		);
	}

	/**
	 * Write to stdin. Resolves with the byte count and whether the pipe was still holding the data when the call
	 * returned (queued). Rejects if the write fails or the job is not reading.
	 */
	async sendInput(data: string): Promise<{ bytes: number; queued: boolean }> {
		if (!this.wantsStdin) {
			throw new Error("This job has no stdin channel. Start it with background: true.");
		}
		if (this.stateValue !== "running") {
			throw new Error(`Job ${this.jobId} is not running.`);
		}
		if (!this.stdinStream) {
			throw new Error(`Job ${this.jobId} has no open stdin.`);
		}
		if (Buffer.byteLength(data, "utf-8") > MAX_INPUT_BYTES) {
			throw new Error(`Input is larger than ${MAX_INPUT_BYTES} bytes; send it in smaller pieces.`);
		}
		// Refuse another write while Node still has bytes queued.
		if (this.stdinStream.writableLength > 0) {
			throw new Error(`Job ${this.jobId} is not reading its stdin; its input buffer is full.`);
		}
		const flushed = Promise.withResolvers<void>();
		this.stdinStream.write(data, (error) => {
			if (error) flushed.reject(error);
			else flushed.resolve();
		});
		// flushed.promise may reject after the bound below has already answered; the race reports errors that arrive in time.
		flushed.promise.catch(() => {});
		// Report a pending write after a bounded wait; the stream may still fail before delivering it.
		const bound = Promise.withResolvers<boolean>();
		const timer = setTimeout(() => bound.resolve(false), STDIN_FLUSH_WAIT_MS);
		try {
			const flushedInTime = await Promise.race([flushed.promise.then(() => true), bound.promise]);
			return { bytes: Buffer.byteLength(data, "utf-8"), queued: !flushedInTime };
		} finally {
			clearTimeout(timer);
		}
	}

	/**
	 * Stop the job. Graceful: SIGTERM to the group now, SIGKILL after STOP_GRACE_MS if still running.
	 * Immediate: SIGKILL now, as foreground abort always did. Resolves on settlement.
	 */
	stop(options: { graceful: boolean }): Promise<void> {
		if (this.stateValue !== "running") return this.settled;
		this.stopRequested = true;
		if (!options.graceful || this.handle === undefined) {
			this.clearKillTimer();
			this.killed = true;
			this.handle?.signal("kill");
			this.controller.abort();
			return this.settled;
		}
		this.handle.signal("term");
		// A second graceful stop must not leak the first timer or push the kill later.
		if (this.killTimer === undefined) {
			this.killTimer = setTimeout(() => {
				this.killTimer = undefined;
				this.killed = true;
				this.handle?.signal("kill");
				this.controller.abort();
			}, STOP_GRACE_MS);
		}
		return this.settled;
	}

	/** Immediately kill and release the retained group, including after the shell settles. */
	killNow(): void {
		if (this.closed) return;
		this.closed = true;
		this.stopRequested = true;
		this.clearKillTimer();
		this.cleanupHandle();
		this.killed = true;
		this.controller.abort();
	}

	private cleanupHandle(): void {
		if (!this.handle) return;
		if (this.handle.cleanup) {
			this.handle.cleanup();
		} else {
			this.handle.signal("kill");
			this.handle.close();
			this.cleanupSignal.resolve(false);
			this.handle = undefined;
		}
	}

	/** Signal a retained group during graceful session teardown. */
	terminateGroup(): void {
		if (!this.closed && !this.killed) this.handle?.signal("term");
	}

	private clearKillTimer(): void {
		clearTimeout(this.killTimer);
		this.killTimer = undefined;
	}

	/** Mark the job's state as read by the model, so a queued finish notice is not repeated. */
	markObserved(): void {
		this.observed = true;
	}

	snapshot(): JobSnapshot {
		return {
			jobId: this.jobId,
			name: this.name,
			command: this.command,
			state: this.stateValue,
			exitCode: this.exitCodeValue,
			error: this.errorValue,
			hasStdin: this.wantsStdin && this.stdinStream !== undefined,
			descendants: this.descendantsValue,
			startedAt: this.startedAt,
			endedAt: this.endedAtValue,
		};
	}

	/** Whether this job has a retained process group. */
	get hasHandle(): boolean {
		return this.handle !== undefined;
	}

	get handleLost(): boolean {
		return this.lostHandle || this.handle?.lost === true;
	}

	/** Release only after the native owner has proved the group empty. */
	releaseEmpty(): boolean {
		if (!this.groupEmpty || !this.handle || this.handleLost) return false;
		this.clearKillTimer();
		this.handle.close();
		this.handle = undefined;
		this.closed = true;
		this.descendantsValue = false;
		return true;
	}

	private settle(outcome: { exitCode: number | null } | { error: Error }): void {
		if (this.stateValue !== "running") return;
		if (!this.stopRequested || !this.handle) this.clearKillTimer();
		if ("error" in outcome) {
			this.stateValue = mapErrorState(outcome.error, this.stopRequested);
			this.errorValue = outcome.error.message;
			// Failed before the job was handed to the model: the model never learned its id, so nothing is announced.
			this.launchFailedValue = !this.handedOffValue;
			this.launchSignal.reject(outcome.error);
			this.completionSignal.reject(outcome.error);
		} else {
			const exitCode = outcome.exitCode;
			this.exitCodeValue = exitCode ?? undefined;
			if (exitCode === 0) this.stateValue = "completed";
			else if (this.stopRequested && exitCode !== null) this.stateValue = "stopped";
			else this.stateValue = "failed";
			if (exitCode === null) this.errorValue = "Command terminated without an exit code";
			this.launchSignal.resolve();
			this.completionSignal.resolve(outcome);
		}
		this.endedAtValue = Date.now();
		this.stdinStream = undefined;
		this.descendantsValue = this.handle !== undefined;
		if (this.closed && !this.handle) this.cleanupSignal.resolve(false);
		this.settledSignal.resolve();
		this.onSettled(this);
		if (this.groupEmpty) this.onGroupEmpty(this);
	}
}

/** Terminal state of an execution that rejected. */
function mapErrorState(error: Error, stopRequested: boolean): JobState {
	if (error.message.startsWith("timeout:")) return "timed_out";
	if (stopRequested && error.message === "aborted") return "stopped";
	return "failed";
}
