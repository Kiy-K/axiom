import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { STOP_GRACE_MS } from "../src/core/jobs/managed-job.ts";
import { findOrphanedJobs } from "../src/core/jobs/registry.ts";
import {
	JobSupervisor,
	MAX_RUNNING_JOBS,
	MAX_UNPROVEN_GROUPS,
	type PrepareRequest,
} from "../src/core/jobs/supervisor.ts";
import type { BashOperations } from "../src/core/tools/bash.ts";

const OWNER = "owner-a";
const FAKE_PID = 999_999_999;

interface FakeRun {
	resolve(exitCode: number): void;
}

/** Operations whose executions finish only when the test says so; an abort rejects like the local backend. */
function fakeOperations(): { operations: BashOperations; runs: Map<string, FakeRun> } {
	const runs = new Map<string, FakeRun>();
	const operations: BashOperations = {
		exec: (command, _cwd, options) => {
			const outcome = Promise.withResolvers<{ exitCode: number | null }>();
			options.onHandle?.({
				pid: FAKE_PID,
				signal: (signal) => {
					if (signal === "kill") outcome.reject(new Error("aborted"));
				},
				close: () => {},
			});
			const abort = () => outcome.reject(new Error("aborted"));
			if (options.signal?.aborted) abort();
			else options.signal?.addEventListener("abort", abort, { once: true });
			runs.set(command, { resolve: (exitCode) => outcome.resolve({ exitCode }) });
			return outcome.promise;
		},
	};
	return { operations, runs };
}

function request(operations: BashOperations, command: string): PrepareRequest {
	return {
		owner: OWNER,
		name: undefined,
		command,
		cwd: "/tmp",
		env: {},
		operations,
		timeout: undefined,
		stdin: false,
		onData: undefined,
	};
}

/** Lets queued microtasks and the execution start run. */
function flush(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

function runOf(runs: Map<string, FakeRun>, command: string): FakeRun {
	const run = runs.get(command);
	if (!run) throw new Error(`no execution for ${command}`);
	return run;
}

describe("JobSupervisor", () => {
	it("keeps a prepared command unregistered until it is adopted", async () => {
		const { operations, runs } = fakeOperations();
		const supervisor = new JobSupervisor();
		const job = supervisor.prepare(request(operations, "build"));
		await flush();
		expect(supervisor.list(OWNER)).toEqual([]);
		runOf(runs, "build").resolve(0);
		await expect(job.completion).resolves.toEqual({ exitCode: 0 });
		expect(job.state).toBe("completed");
	});

	it("reaches an adopted job only through its owner", async () => {
		const { operations } = fakeOperations();
		const supervisor = new JobSupervisor();
		const job = supervisor.prepare(request(operations, "server"));
		expect(supervisor.adopt(job)).toBe(true);
		expect(supervisor.list(OWNER).map((listed) => listed.jobId)).toEqual([job.jobId]);
		expect(() => supervisor.status(job.jobId, "someone-else")).toThrow("Unknown job");
	});

	// Regression coverage for roadmap issue #1: ownership applies to every operation, not just status.
	it("rejects foreign owners for output, input and stop without affecting the job", async () => {
		const { operations, runs } = fakeOperations();
		const supervisor = new JobSupervisor();
		const job = supervisor.start(request(operations, "private"));
		await flush();
		expect(supervisor.list("owner-b")).toEqual([]);
		expect(() => supervisor.output(job.jobId, "owner-b", undefined, 128)).toThrow("Unknown job");
		await expect(supervisor.sendInput(job.jobId, "owner-b", "hello")).rejects.toThrow("Unknown job");
		await expect(supervisor.stop(job.jobId, "owner-b", { announce: false })).rejects.toThrow("Unknown job");
		expect(supervisor.status(job.jobId, OWNER).state).toBe("running");
		runOf(runs, "private").resolve(7);
		await job.settled;
		expect(supervisor.status(job.jobId, OWNER)).toMatchObject({ state: "failed", exitCode: 7 });
	});

	it("refuses adoption at the running limit and leaves the command in the foreground", async () => {
		const { operations, runs } = fakeOperations();
		const supervisor = new JobSupervisor();
		for (let i = 0; i < MAX_RUNNING_JOBS; i++) {
			expect(supervisor.adopt(supervisor.prepare(request(operations, `job-${i}`)))).toBe(true);
		}
		const extra = supervisor.prepare(request(operations, "extra"));
		expect(supervisor.adopt(extra)).toBe(false);
		expect(() => supervisor.start({ ...request(operations, "late"), name: undefined })).toThrow("Too many running");
		await flush();
		runOf(runs, "extra").resolve(0);
		await expect(extra.completion).resolves.toEqual({ exitCode: 0 });
	});

	it("notifies the owner once for each adopted job that announces", async () => {
		const { operations, runs } = fakeOperations();
		const supervisor = new JobSupervisor();
		const notified: string[] = [];
		supervisor.onFinished(OWNER, (job) => notified.push(job.command));
		const foreground = supervisor.prepare(request(operations, "quick"));
		const background = supervisor.start({ ...request(operations, "watch"), name: undefined });
		await flush();
		runOf(runs, "quick").resolve(0);
		runOf(runs, "watch").resolve(0);
		await foreground.settled;
		await background.settled;
		expect(notified).toEqual(["watch"]);
	});

	it("stops a job once and reports the same final state on a repeated stop", async () => {
		const { operations } = fakeOperations();
		const supervisor = new JobSupervisor();
		const job = supervisor.start({ ...request(operations, "sleep"), name: undefined });
		const first = await supervisor.stop(job.jobId, OWNER, { announce: false });
		const second = await supervisor.stop(job.jobId, OWNER, { announce: false });
		expect(first.settled).toBe(true);
		expect(first.job.state).toBe("stopped");
		expect(second.job.state).toBe("stopped");
	});

	it("refuses new jobs for an owner whose session is closing", async () => {
		const { operations } = fakeOperations();
		const supervisor = new JobSupervisor();
		await supervisor.stopSession(OWNER);
		expect(() => supervisor.adopt(supervisor.prepare(request(operations, "after-close")))).toThrow("closing");
	});

	it("marks a job observed once the model reads its terminal state", async () => {
		const { operations, runs } = fakeOperations();
		const supervisor = new JobSupervisor();
		const job = supervisor.start({ ...request(operations, "tail"), name: undefined });
		await flush();
		runOf(runs, "tail").resolve(0);
		await job.settled;
		expect(supervisor.isObserved(job.jobId)).toBe(false);
		supervisor.status(job.jobId, OWNER);
		expect(supervisor.isObserved(job.jobId)).toBe(true);
	});

	it("evicts the oldest finished job beyond the retention limit", async () => {
		const { operations, runs } = fakeOperations();
		const supervisor = new JobSupervisor();
		const ids: string[] = [];
		for (let i = 0; i < 17; i++) {
			const job = supervisor.start({ ...request(operations, `c${i}`), name: undefined });
			ids.push(job.jobId);
			await flush();
			runOf(runs, `c${i}`).resolve(0);
			await job.settled;
		}
		expect(() => supervisor.status(ids[0], OWNER)).toThrow("Unknown job");
		expect(supervisor.status(ids[16], OWNER).state).toBe("completed");
	});

	it("answers every operation on an evicted handle as an unknown job", async () => {
		const { operations, runs } = fakeOperations();
		const supervisor = new JobSupervisor();
		const ids: string[] = [];
		for (let i = 0; i < 17; i++) {
			const job = supervisor.start({ ...request(operations, `stale${i}`), name: undefined });
			ids.push(job.jobId);
			await flush();
			runOf(runs, `stale${i}`).resolve(0);
			await job.settled;
		}
		const stale = ids[0];
		expect(() => supervisor.output(stale, OWNER, undefined, 1024)).toThrow(`Unknown job: ${stale}`);
		await expect(supervisor.sendInput(stale, OWNER, "x")).rejects.toThrow(`Unknown job: ${stale}`);
		await expect(supervisor.stop(stale, OWNER, { announce: true })).rejects.toThrow(`Unknown job: ${stale}`);
		expect(supervisor.list(OWNER).map((job) => job.jobId)).not.toContain(stale);
		expect(supervisor.isObserved(stale)).toBe(false);
		// A handle that was never issued reads the same as an evicted one.
		expect(() => supervisor.status("0000000000000000", OWNER)).toThrow("Unknown job");
	});

	it("keeps the finish notice when the model only read a running job", async () => {
		const { operations, runs } = fakeOperations();
		const supervisor = new JobSupervisor();
		const job = supervisor.start({ ...request(operations, "watch-running"), name: undefined });
		await flush();
		supervisor.status(job.jobId, OWNER);
		expect(supervisor.isObserved(job.jobId)).toBe(false);
		runOf(runs, "watch-running").resolve(0);
		await job.settled;
		expect(supervisor.isObserved(job.jobId)).toBe(false);
	});

	it("announces a stop the user asked for", async () => {
		const { operations } = fakeOperations();
		const supervisor = new JobSupervisor();
		const notified: string[] = [];
		supervisor.onFinished(OWNER, (job) => notified.push(job.state));
		const job = supervisor.start({ ...request(operations, "user-stop"), name: undefined });
		// Production hands the job to the model before any stop; a stop of a job the model never saw is not announced.
		job.markHandedOff();
		await supervisor.stop(job.jobId, OWNER, { announce: true });
		expect(notified).toEqual(["stopped"]);
	});

	it("does not announce a command that failed before it spawned", async () => {
		const failing: BashOperations = {
			exec: async () => {
				throw new Error("spawn failed");
			},
		};
		const supervisor = new JobSupervisor();
		const notified: string[] = [];
		supervisor.onFinished(OWNER, (job) => notified.push(job.jobId));
		const job = supervisor.start({ ...request(failing, "missing-binary"), name: undefined });
		await expect(job.completion).rejects.toThrow("spawn failed");
		expect(job.launchFailed).toBe(true);
		expect(notified).toEqual([]);
	});

	it("marks a finished job observed when the model stops it, so its notice is not repeated", async () => {
		const { operations, runs } = fakeOperations();
		const supervisor = new JobSupervisor();
		const job = supervisor.start({ ...request(operations, "done-early"), name: undefined });
		await flush();
		runOf(runs, "done-early").resolve(0);
		await job.settled;
		await supervisor.stop(job.jobId, OWNER, { announce: false });
		expect(supervisor.isObserved(job.jobId)).toBe(true);
	});

	it("announces a yielded pid-less command that later times out", async () => {
		const outcome = Promise.withResolvers<{ exitCode: number | null }>();
		const custom: BashOperations = { exec: () => outcome.promise };
		const supervisor = new JobSupervisor();
		const notified: string[] = [];
		supervisor.onFinished(OWNER, (job) => notified.push(job.state));
		const job = supervisor.start({ ...request(custom, "slow-custom"), name: undefined });
		job.markHandedOff();
		outcome.reject(new Error("timeout:5"));
		await job.settled;
		expect(job.launchFailed).toBe(false);
		expect(notified).toEqual(["timed_out"]);
	});

	it("keeps the newest finished job by finish order when an older job finishes last", async () => {
		const { operations, runs } = fakeOperations();
		const supervisor = new JobSupervisor();
		const notified: string[] = [];
		let oldVisibleAtNotice = false;
		supervisor.onFinished(OWNER, (job) => {
			notified.push(job.command);
			if (job.command === "old")
				oldVisibleAtNotice = supervisor.list(OWNER).some((item) => item.jobId === job.jobId);
		});
		const old = supervisor.start({ ...request(operations, "old"), name: undefined });
		await flush();
		const newer: string[] = [];
		for (let i = 0; i < 16; i++) {
			const job = supervisor.start({ ...request(operations, `n${i}`), name: undefined });
			newer.push(job.jobId);
			await flush();
			runOf(runs, `n${i}`).resolve(0);
			await job.settled;
		}
		runOf(runs, "old").resolve(0);
		await old.settled;
		expect(notified).toContain("old");
		expect(oldVisibleAtNotice).toBe(true);
		expect(supervisor.status(old.jobId, OWNER).state).toBe("completed");
		expect(() => supervisor.status(newer[0], OWNER)).toThrow("Unknown job");
		expect(supervisor.status(newer[15], OWNER).state).toBe("completed");
	});

	it("does not leak or postpone the kill timer when graceful stops overlap", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const { operations } = fakeOperations();
			const supervisor = new JobSupervisor();
			const job = supervisor.start({ ...request(operations, "overlap"), name: undefined });
			await flush();
			const first = job.stop({ graceful: true });
			const second = job.stop({ graceful: true });
			expect(vi.getTimerCount()).toBe(1);
			await vi.advanceTimersByTimeAsync(STOP_GRACE_MS - 1);
			expect(job.state).toBe("running");
			const immediate = job.stop({ graceful: false });
			await flush();
			expect(job.state).toBe("stopped");
			expect(vi.getTimerCount()).toBe(0);
			await first;
			await second;
			await immediate;
		} finally {
			vi.useRealTimers();
		}
	});

	it("announces the later finish when a model stop does not settle", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const outcome = Promise.withResolvers<{ exitCode: number | null }>();
			const custom: BashOperations = {
				exec: (_command, _cwd, options) => {
					options.onSpawn?.(FAKE_PID);
					return outcome.promise;
				},
			};
			const supervisor = new JobSupervisor();
			const notified: string[] = [];
			supervisor.onFinished(OWNER, (job) => notified.push(job.state));
			const job = supervisor.start({ ...request(custom, "ignore-stop"), name: undefined });
			job.markHandedOff();
			await flush();
			const stopping = supervisor.stop(job.jobId, OWNER, { announce: false });
			await vi.advanceTimersByTimeAsync(STOP_GRACE_MS + 2_000);
			const result = await stopping;
			expect(result.settled).toBe(false);
			expect(notified).toEqual([]);
			outcome.resolve({ exitCode: 0 });
			await job.settled;
			expect(notified).toEqual(["completed"]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps a user stop notice when a model stop overlaps it", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const { operations } = fakeOperations();
			const supervisor = new JobSupervisor();
			const notified: string[] = [];
			supervisor.onFinished(OWNER, (job) => notified.push(job.state));
			const job = supervisor.start({ ...request(operations, "user-overlap"), name: undefined });
			job.markHandedOff();
			await flush();
			const userStop = supervisor.stop(job.jobId, OWNER, { announce: true });
			const modelStop = supervisor.stop(job.jobId, OWNER, { announce: false });
			await vi.advanceTimersByTimeAsync(STOP_GRACE_MS);
			await userStop;
			await modelStop;
			expect(notified).toEqual(["stopped"]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps a user stop notice when the user stop starts after a model stop", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const { operations } = fakeOperations();
			const supervisor = new JobSupervisor();
			const notified: string[] = [];
			supervisor.onFinished(OWNER, (job) => notified.push(job.state));
			const job = supervisor.start({ ...request(operations, "model-then-user"), name: undefined });
			job.markHandedOff();
			await flush();
			const modelStop = supervisor.stop(job.jobId, OWNER, { announce: false });
			const userStop = supervisor.stop(job.jobId, OWNER, { announce: true });
			await vi.advanceTimersByTimeAsync(STOP_GRACE_MS);
			await modelStop;
			await userStop;
			expect(notified).toEqual(["stopped"]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not announce when two model stops overlap", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const { operations } = fakeOperations();
			const supervisor = new JobSupervisor();
			const notified: string[] = [];
			supervisor.onFinished(OWNER, (job) => notified.push(job.state));
			const job = supervisor.start({ ...request(operations, "two-model-stops"), name: undefined });
			job.markHandedOff();
			await flush();
			const first = supervisor.stop(job.jobId, OWNER, { announce: false });
			const second = supervisor.stop(job.jobId, OWNER, { announce: false });
			await vi.advanceTimersByTimeAsync(STOP_GRACE_MS);
			await first;
			await second;
			expect(notified).toEqual([]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("retains a completed foreground group until session cleanup", async () => {
		const signals: string[] = [];
		let closed = 0;
		const operations: BashOperations = {
			exec: async (_command, _cwd, options) => {
				options.onHandle?.({ pid: FAKE_PID, signal: (signal) => signals.push(signal), close: () => closed++ });
				return { exitCode: 0 };
			},
		};
		const supervisor = new JobSupervisor();
		const job = supervisor.prepare(request(operations, "foreground"));
		await job.settled;
		expect(signals).toEqual([]);
		expect(closed).toBe(0);
		supervisor.killSession(OWNER);
		expect(signals).toEqual(["kill"]);
		expect(closed).toBe(1);
	});

	it("kills a handle delivered after session disposal without signaling its numeric pid", async () => {
		const signals: string[] = [];
		let closed = 0;
		const outcome = Promise.withResolvers<{ exitCode: number | null }>();
		let deliver: (() => void) | undefined;
		const operations: BashOperations = {
			exec: (_command, _cwd, options) => {
				deliver = () =>
					options.onHandle?.({
						pid: FAKE_PID,
						signal: (signal) => signals.push(signal),
						close: () => closed++,
					});
				return outcome.promise;
			},
		};
		const supervisor = new JobSupervisor();
		const job = supervisor.start(request(operations, "late-handle"));
		await flush();
		supervisor.killSession(OWNER);
		deliver?.();
		outcome.resolve({ exitCode: 0 });
		await job.settled;
		expect(signals).toEqual(["kill"]);
		expect(closed).toBe(1);
	});

	it("escalates a graceful stop after the shell settles", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const signals: string[] = [];
			const outcome = Promise.withResolvers<{ exitCode: number | null }>();
			const operations: BashOperations = {
				exec: (_command, _cwd, options) => {
					options.onHandle?.({ pid: FAKE_PID, signal: (signal) => signals.push(signal), close: () => {} });
					return outcome.promise;
				},
			};
			const supervisor = new JobSupervisor();
			const job = supervisor.start(request(operations, "leader-exits"));
			await flush();
			void job.stop({ graceful: true });
			outcome.resolve({ exitCode: 0 });
			await job.settled;
			await vi.advanceTimersByTimeAsync(STOP_GRACE_MS);
			expect(signals).toEqual(["term", "kill"]);
			supervisor.killSession(OWNER);
		} finally {
			vi.useRealTimers();
		}
	});

	it("retains the crash record if the native capability is lost", async () => {
		const dir = mkdtempSync(join(tmpdir(), "axiom-lost-"));
		let lose: (() => void) | undefined;
		const operations: BashOperations = {
			exec: async (_command, _cwd, options) => {
				options.onHandle?.({
					pid: FAKE_PID,
					signal: () => {},
					close: () => {},
					lost: false,
					onLost: (listener) => {
						lose = listener;
					},
				});
				return { exitCode: 0 };
			},
		};
		try {
			const supervisor = new JobSupervisor({ registryDir: dir });
			const job = supervisor.start(request(operations, "lost"));
			await job.settled;
			lose?.();
			supervisor.killSession(OWNER);
			expect(existsSync(join(dir, `${job.jobId}.json`))).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps a crash record until cleanup is confirmed, and preserves it on handle loss", async () => {
		const dir = mkdtempSync(join(tmpdir(), "axiom-cleanup-"));
		const cleaned = new Map<string, () => void>();
		const lost = new Map<string, () => void>();
		const operations: BashOperations = {
			exec: async (command, _cwd, options) => {
				options.onHandle?.({
					pid: FAKE_PID,
					signal: () => {},
					close: () => {},
					cleanup: () => {},
					onCleaned: (listener) => cleaned.set(command, listener),
					onLost: (listener) => lost.set(command, listener),
				});
				return { exitCode: 0 };
			},
		};
		try {
			const supervisor = new JobSupervisor({ registryDir: dir });
			const confirmed = supervisor.start(request(operations, "confirmed"));
			const uncertain = supervisor.start(request(operations, "uncertain"));
			await Promise.all([confirmed.settled, uncertain.settled]);
			const confirmedRecord = join(dir, `${confirmed.jobId}.json`);
			const uncertainRecord = join(dir, `${uncertain.jobId}.json`);
			supervisor.killSession(OWNER);
			expect(existsSync(confirmedRecord)).toBe(true);
			expect(existsSync(uncertainRecord)).toBe(true);
			cleaned.get("confirmed")?.();
			lost.get("uncertain")?.();
			expect(existsSync(confirmedRecord)).toBe(false);
			expect(existsSync(uncertainRecord)).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("waits for confirmed cleanup before session teardown returns", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			let cleaned: (() => void) | undefined;
			let cleanupRequested = false;
			const operations: BashOperations = {
				exec: async (_command, _cwd, options) => {
					options.onHandle?.({
						pid: FAKE_PID,
						signal: () => {},
						close: () => {},
						cleanup: () => {
							cleanupRequested = true;
						},
						onCleaned: (listener) => {
							cleaned = listener;
						},
					});
					return { exitCode: 0 };
				},
			};
			const supervisor = new JobSupervisor();
			const job = supervisor.prepare(request(operations, "foreground"));
			await job.settled;
			let returned = false;
			const stopping = supervisor.stopSession(OWNER).then(() => {
				returned = true;
			});
			await vi.advanceTimersByTimeAsync(STOP_GRACE_MS);
			expect(cleanupRequested).toBe(true);
			expect(returned).toBe(false);
			cleaned?.();
			await stopping;
			expect(returned).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it("reports cleanup unknown when a native handle is lost", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			let lose: (() => void) | undefined;
			const operations: BashOperations = {
				exec: async (_command, _cwd, options) => {
					options.onHandle?.({
						pid: FAKE_PID,
						signal: () => {},
						close: () => {},
						cleanup: () => {
							lose?.();
						},
						onLost: (listener) => {
							lose = listener;
						},
					});
					return { exitCode: 0 };
				},
			};
			const supervisor = new JobSupervisor();
			const job = supervisor.prepare(request(operations, "unknown"));
			await job.settled;
			// The warning is visible without aborting session teardown.
			const stopping = supervisor.stopSession(OWNER);
			await vi.advanceTimersByTimeAsync(STOP_GRACE_MS);
			await stopping;
			expect(warning).toHaveBeenCalledWith(expect.stringContaining(job.jobId));
		} finally {
			warning.mockRestore();
			vi.useRealTimers();
		}
	});

	it("bounds the wait when cleanup is never acknowledged", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const operations: BashOperations = {
				exec: async (_command, _cwd, options) => {
					options.onHandle?.({ pid: FAKE_PID, signal: () => {}, close: () => {}, cleanup: () => {} });
					return { exitCode: 0 };
				},
			};
			const supervisor = new JobSupervisor();
			const job = supervisor.prepare(request(operations, "unconfirmed"));
			await job.settled;
			const stopping = supervisor.stopSession(OWNER);
			await vi.advanceTimersByTimeAsync(STOP_GRACE_MS + 6_000);
			await stopping;
			expect(warning).toHaveBeenCalledWith(expect.stringContaining(job.jobId));
		} finally {
			warning.mockRestore();
			vi.useRealTimers();
		}
	});

	it("releases an empty group without waiting for session closure", async () => {
		let empty: (() => void) | undefined;
		let closes = 0;
		const operations: BashOperations = {
			exec: async (_command, _cwd, options) => {
				options.onHandle?.({
					pid: FAKE_PID,
					signal: () => {},
					close: () => {
						closes++;
					},
					onEmpty: (listener: () => void) => {
						empty = listener;
					},
				});
				return { exitCode: 0 };
			},
		};
		const supervisor = new JobSupervisor();
		const job = supervisor.prepare(request(operations, "empty"));
		supervisor.adopt(job);
		await job.settled;
		empty?.();
		expect(closes).toBe(1);
		supervisor.killSession(OWNER);
		expect(closes).toBe(1);
	});

	describe("retained groups that cannot be proved empty", () => {
		/** Operations whose executions finish on demand; each handle reports whether its helper can prove emptiness. */
		function heldGroups(canProveEmpty: boolean) {
			const cleanups: number[] = [];
			const finishers: Array<() => void> = [];
			const operations: BashOperations = {
				exec: (_command, _cwd, options) => {
					const index = finishers.length;
					const outcome = Promise.withResolvers<{ exitCode: number | null }>();
					finishers.push(() => outcome.resolve({ exitCode: 0 }));
					options.onHandle?.({
						pid: FAKE_PID + index,
						canProveEmpty,
						signal: () => {},
						close: () => {},
						cleanup: () => {
							cleanups.push(index);
						},
					});
					return outcome.promise;
				},
			};
			return { cleanups, finishers, operations };
		}

		it("keeps the newest MAX_UNPROVEN_GROUPS finished groups, ordered by when they finished", async () => {
			const { cleanups, finishers, operations } = heldGroups(false);
			const supervisor = new JobSupervisor();
			const jobs = Array.from({ length: MAX_UNPROVEN_GROUPS + 1 }, (_, i) =>
				supervisor.prepare(request(operations, `command-${i}`)),
			);
			await flush();
			// The first-prepared job finishes last, so it must not be the one killed.
			for (let i = 1; i < jobs.length; i++) {
				finishers[i]?.();
				await jobs[i]?.settled;
			}
			expect(cleanups).toEqual([]);
			finishers[0]?.();
			await jobs[0]?.settled;
			expect(cleanups).toEqual([1]);
		});

		it("spares running jobs and groups whose helper can prove emptiness", async () => {
			const proved = heldGroups(true);
			const supervisor = new JobSupervisor();
			const jobs = Array.from({ length: MAX_UNPROVEN_GROUPS + 4 }, (_, i) =>
				supervisor.prepare(request(proved.operations, `proved-${i}`)),
			);
			await flush();
			for (const finish of proved.finishers) finish();
			await Promise.all(jobs.map((job) => job.settled));
			expect(proved.cleanups).toEqual([]);

			const unproved = heldGroups(false);
			const running = supervisor.prepare(request(unproved.operations, "running"));
			for (let i = 0; i < MAX_UNPROVEN_GROUPS + 1; i++) {
				const job = supervisor.prepare(request(unproved.operations, `done-${i}`));
				await flush();
				unproved.finishers[i + 1]?.();
				await job.settled;
			}
			expect(running.state).toBe("running");
			expect(unproved.cleanups).toEqual([1]);
		});
	});

	it("waits for execution settlement before releasing an already-empty group", async () => {
		const outcome = Promise.withResolvers<{ exitCode: number | null }>();
		let closes = 0;
		const operations: BashOperations = {
			exec: (_command, _cwd, options) => {
				options.onHandle?.({
					pid: FAKE_PID,
					signal: () => {},
					close: () => {
						closes++;
					},
					onEmpty: (listener: () => void) => listener(),
				});
				return outcome.promise;
			},
		};
		const supervisor = new JobSupervisor();
		const job = supervisor.prepare(request(operations, "early-empty"));
		supervisor.adopt(job);
		await flush();
		expect(closes).toBe(0);
		outcome.resolve({ exitCode: 0 });
		await job.settled;
		expect(closes).toBe(1);
	});
	it("reports old records without probing or deleting their numeric process ids", () => {
		const dir = mkdtempSync(join(tmpdir(), "axiom-orphans-"));
		const kill = vi.spyOn(process, "kill");
		const record = { job_id: "old", supervisor_pid: FAKE_PID, pid: FAKE_PID, started_at: 1 };
		try {
			writeFileSync(join(dir, "old.json"), JSON.stringify(record));
			expect(findOrphanedJobs(dir)).toEqual([record]);
			expect(existsSync(join(dir, "old.json"))).toBe(true);
			expect(kill).not.toHaveBeenCalled();
		} finally {
			kill.mockRestore();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
