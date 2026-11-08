import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JobSupervisor, MAX_RUNNING_JOBS } from "../src/core/jobs/supervisor.ts";
import type { BashOperations } from "../src/core/tools/bash.ts";
import { createBashToolDefinition } from "../src/core/tools/bash.ts";
import {
	type JobScope,
	runSupervisedCommand,
	YIELD_AFTER_MS,
	yieldedResult,
} from "../src/core/tools/bash-supervision.ts";

const OWNER = "owner-b";
const FAKE_PID = 999_999_999;

interface FakeRun {
	resolve(exitCode: number): void;
}

/** Operations whose executions finish when the test resolves them; an abort rejects like the local backend. */
function fakeOperations(retainedHandle = true): { operations: BashOperations; runs: Map<string, FakeRun> } {
	const runs = new Map<string, FakeRun>();
	const operations: BashOperations = {
		retainsProcessHandle: retainedHandle,
		exec: (command, _cwd, options) => {
			const outcome = Promise.withResolvers<{ exitCode: number | null }>();
			// A pid no process group can have, so cleanup in tests never signals a real group.
			options.onSpawn?.(FAKE_PID);
			if (retainedHandle) options.onHandle?.({ pid: FAKE_PID, signal: () => {}, close: () => {} });
			const abort = () => outcome.reject(new Error("aborted"));
			if (options.signal?.aborted) abort();
			else options.signal?.addEventListener("abort", abort, { once: true });
			runs.set(command, { resolve: (exitCode) => outcome.resolve({ exitCode }) });
			return outcome.promise;
		},
	};
	return { operations, runs };
}

function runOf(runs: Map<string, FakeRun>, command: string): FakeRun {
	const run = runs.get(command);
	if (!run) throw new Error(`no execution for ${command}`);
	return run;
}

/** Lets the launch of a fake execution run; setImmediate is not faked. */
function flush(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

describe("runSupervisedCommand", () => {
	let scope: JobScope;
	let supervisor: JobSupervisor;

	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		supervisor = new JobSupervisor();
		scope = { supervisor, owner: () => OWNER };
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	function call(
		operations: BashOperations,
		command: string,
		overrides: { background?: boolean; signal?: AbortSignal } = {},
	) {
		return runSupervisedCommand({
			scope,
			operations,
			command,
			cwd: "/tmp",
			env: {},
			timeout: undefined,
			name: undefined,
			background: overrides.background ?? false,
			signal: overrides.signal,
			onData: () => {},
		});
	}

	it("finishes in the foreground and never registers a job", async () => {
		const { operations, runs } = fakeOperations();
		const run = call(operations, "quick");
		await flush();
		runOf(runs, "quick").resolve(0);
		await expect(run).resolves.toEqual({ kind: "finished", exitCode: 0 });
		expect(supervisor.list(OWNER)).toEqual([]);
	});

	it("keeps a backend without a retained handle in the foreground past the yield threshold", async () => {
		const { operations, runs } = fakeOperations(false);
		const run = call(operations, "foreground-only");
		await flush();
		await vi.advanceTimersByTimeAsync(YIELD_AFTER_MS);
		expect(supervisor.list(OWNER)).toEqual([]);
		runOf(runs, "foreground-only").resolve(0);
		await expect(run).resolves.toEqual({ kind: "finished", exitCode: 0 });
		expect(supervisor.list(OWNER)).toEqual([]);
	});

	it("rejects explicit background execution without a retained handle", async () => {
		const { operations, runs } = fakeOperations(false);
		await expect(call(operations, "unsupported", { background: true })).rejects.toThrow(
			"Background jobs require an execution backend with retained process handles",
		);
		expect(runs.size).toBe(0);
	});

	it("waits for a retained handle reported after the spawn notification", async () => {
		const outcome = Promise.withResolvers<{ exitCode: number | null }>();
		let deliver: (() => void) | undefined;
		let returned = false;
		const operations: BashOperations = {
			retainsProcessHandle: true,
			exec: (_command, _cwd, options) => {
				options.onSpawn?.(FAKE_PID);
				deliver = () => options.onHandle?.({ pid: FAKE_PID, signal: () => {}, close: () => {} });
				return outcome.promise;
			},
		};
		const pending = call(operations, "delayed", { background: true });
		void pending.then(() => {
			returned = true;
		});
		await flush();
		expect(returned).toBe(false);
		deliver?.();
		const result = await pending;
		expect(result.kind).toBe("yielded");
		outcome.resolve({ exitCode: 0 });
	});

	it("aborts a background launch even if its backend has not delivered a handle", async () => {
		const controller = new AbortController();
		const operations: BashOperations = {
			retainsProcessHandle: true,
			exec: () => new Promise(() => {}),
		};
		const pending = call(operations, "pending", { background: true, signal: controller.signal });
		await flush();
		controller.abort();
		await expect(pending).rejects.toThrow("aborted");
	});

	it("rejects when abort follows handle delivery before launch returns", async () => {
		const controller = new AbortController();
		const operations: BashOperations = {
			retainsProcessHandle: true,
			exec: (_command, _cwd, options) => {
				options.onHandle?.({ pid: FAKE_PID, signal: () => {}, close: () => {} });
				controller.abort();
				return Promise.resolve({ exitCode: 0 });
			},
		};
		await expect(call(operations, "race", { background: true, signal: controller.signal })).rejects.toThrow(
			"aborted",
		);
	});

	it("becomes a background job at 10 seconds without restarting the command", async () => {
		const { operations, runs } = fakeOperations();
		const exec = vi.spyOn(operations, "exec");
		const notices: string[] = [];
		supervisor.onFinished(OWNER, (job) => notices.push(job.jobId));
		const run = call(operations, "build");
		await flush();
		exec.mock.calls[0][2].onData(Buffer.from("before\n"));
		await vi.advanceTimersByTimeAsync(YIELD_AFTER_MS);
		const outcome = await run;
		expect(outcome.kind).toBe("yielded");
		if (outcome.kind !== "yielded") return;
		expect(outcome.job.state).toBe("running");
		expect(outcome.job.log.read(undefined, 1024).text).toBe("before\n");
		exec.mock.calls[0][2].onData(Buffer.from("after\n"));
		expect(supervisor.list(OWNER).map((job) => job.jobId)).toEqual([outcome.job.jobId]);
		runOf(runs, "build").resolve(0);
		await outcome.job.settled;
		expect(outcome.job.log.read(undefined, 1024).text).toBe("before\nafter\n");
		expect(exec).toHaveBeenCalledTimes(1);
		expect(notices).toEqual([outcome.job.jobId]);
		expect(outcome.job.state).toBe("completed");
	});

	// Regression for roadmap issue #1: settlement on the threshold must not create a duplicate job.
	it("finishes in the foreground when completion wins on the 10-second tick", async () => {
		const { operations, runs } = fakeOperations();
		setTimeout(() => runOf(runs, "boundary-finish").resolve(0), YIELD_AFTER_MS);
		const run = call(operations, "boundary-finish");
		await flush();
		await vi.advanceTimersByTimeAsync(YIELD_AFTER_MS);
		await expect(run).resolves.toEqual({ kind: "finished", exitCode: 0 });
		expect(supervisor.list(OWNER)).toEqual([]);
	});

	// Regression for roadmap issue #1: cancellation on the yield tick must not return a live handle.
	it("aborts instead of yielding when cancellation arrives on the 10-second tick", async () => {
		const { operations } = fakeOperations();
		const controller = new AbortController();
		const pending = call(operations, "boundary-abort", { signal: controller.signal });
		await flush();
		vi.advanceTimersByTime(YIELD_AFTER_MS);
		controller.abort();
		await expect(pending).rejects.toThrow("aborted");
		expect(supervisor.list(OWNER)).toEqual([]);
	});

	it("stays in the foreground at the threshold when the running limit is full", async () => {
		const { operations, runs } = fakeOperations();
		for (let i = 0; i < MAX_RUNNING_JOBS; i++) {
			supervisor.adopt(supervisor.prepare({ ...stub(operations, `bg-${i}`) }));
		}
		const run = call(operations, "foreground");
		await flush();
		await vi.advanceTimersByTimeAsync(YIELD_AFTER_MS);
		runOf(runs, "foreground").resolve(0);
		await expect(run).resolves.toEqual({ kind: "finished", exitCode: 0 });
	});

	it("stops the command at once when aborted before the threshold", async () => {
		const { operations, runs } = fakeOperations();
		const controller = new AbortController();
		const run = call(operations, "long", { signal: controller.signal });
		await flush();
		controller.abort();
		await expect(run).rejects.toThrow("aborted");
		expect(runs.has("long")).toBe(true);
		expect(supervisor.list(OWNER)).toEqual([]);
	});

	it("does not stop the background job when the call is aborted after the yield", async () => {
		const { operations, runs } = fakeOperations();
		const controller = new AbortController();
		const run = call(operations, "serve", { signal: controller.signal });
		await flush();
		await vi.advanceTimersByTimeAsync(YIELD_AFTER_MS);
		const outcome = await run;
		if (outcome.kind !== "yielded") throw new Error("expected a yield");
		controller.abort();
		await flush();
		expect(outcome.job.state).toBe("running");
		runOf(runs, "serve").resolve(0);
		await outcome.job.settled;
	});

	it("starts a background job and returns once it has launched", async () => {
		const { operations } = fakeOperations();
		const outcome = await call(operations, "watch", { background: true });
		expect(outcome.kind).toBe("yielded");
		if (outcome.kind !== "yielded") return;
		expect(supervisor.list(OWNER).map((job) => job.jobId)).toEqual([outcome.job.jobId]);
	});

	it("reports the job id and the latest output in the yielded result", async () => {
		const { operations } = fakeOperations();
		const outcome = await call(operations, "tail", { background: true });
		if (outcome.kind !== "yielded") throw new Error("expected a yield");
		const result = yieldedResult(outcome.job, true);
		expect(result.content[0].text).toContain(`Started background job ${outcome.job.jobId}.`);
		expect(result.content[0].text).toContain(`job({"action":"output","job_id":"${outcome.job.jobId}"`);
		// A yielded result is text only: a script never receives it, so it must not claim an exit code.
		expect(result).not.toHaveProperty("structuredContent");
	});
});

/** Prepare request for a fake command, for filling the running limit. */
function stub(operations: BashOperations, command: string) {
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

// The bash tool reads the session's environment from ctx.sessionManager; a minimal stand-in suffices.
const toolContext = {
	model: undefined,
	thinkingLevel: undefined,
	sessionManager: { getSessionId: () => OWNER, getSessionFile: () => undefined },
} as never;

describe("bash tool with a supervisor", () => {
	// Regression for roadmap issue #1: supervision must preserve top-level foreground results.
	it("preserves top-level foreground output and exit status with supervision", async () => {
		const { operations, runs } = fakeOperations();
		const exec = vi.spyOn(operations, "exec");
		const supervisor = new JobSupervisor();
		const tool = createBashToolDefinition("/tmp", { operations, jobs: { supervisor, owner: () => OWNER } });
		for (const code of [0, 3]) {
			const command = `foreground-${code}`;
			const pending = tool.execute(command, { command }, undefined, undefined, toolContext);
			await flush();
			exec.mock.calls[code === 0 ? 0 : 1][2].onData(Buffer.from("hello\n"));
			runOf(runs, command).resolve(code);
			const result = await pending;
			expect(result.content[0]).toMatchObject({
				type: "text",
				text: code === 0 ? "hello\n" : "hello\n\n\nCommand exited with code 3",
			});
			expect(result.structuredContent).toMatchObject({ output: "hello\n", exit_code: code });
			expect(result.isError).toBe(code === 0 ? undefined : true);
		}
		expect(supervisor.list(OWNER)).toEqual([]);
	});

	it("never yields a command run by a script, so its result keeps exit_code", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const { operations, runs } = fakeOperations();
			const supervisor = new JobSupervisor();
			const tool = createBashToolDefinition("/tmp", {
				operations,
				jobs: { supervisor, owner: () => OWNER },
			});
			// Nested calls carry a "<parent>/<n>" id.
			const pending = tool.execute("parent-1/1", { command: "nested" }, undefined, undefined, toolContext);
			await flush();
			await vi.advanceTimersByTimeAsync(YIELD_AFTER_MS * 2);
			runOf(runs, "nested").resolve(0);
			await expect(pending).resolves.toMatchObject({ structuredContent: { exit_code: 0 } });
			expect(supervisor.list(OWNER)).toEqual([]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("rejects background launch from a script", async () => {
		const { operations } = fakeOperations();
		const tool = createBashToolDefinition("/tmp", {
			operations,
			jobs: { supervisor: new JobSupervisor(), owner: () => OWNER },
		});
		await expect(
			tool.execute("parent-2/1", { command: "x", background: true }, undefined, undefined, toolContext),
		).rejects.toThrow("not available for commands run by a script");
	});

	it("treats a top-level id that contains a slash as a top-level call", async () => {
		const { operations } = fakeOperations();
		const tool = createBashToolDefinition("/tmp", {
			operations,
			jobs: { supervisor: new JobSupervisor(), owner: () => OWNER },
		});
		const result = await tool.execute(
			"call_abc/def",
			{ command: "watch", background: true },
			undefined,
			undefined,
			toolContext,
		);
		expect(result.content[0]).toMatchObject({ type: "text" });
		expect(String(result.content[0].type === "text" && result.content[0].text)).toContain("Started background job");
	});
});
