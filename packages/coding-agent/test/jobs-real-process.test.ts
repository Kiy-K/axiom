// Integration tests against real shell processes. They wait on real process state and the real stop grace
// period, which fake timers cannot reproduce, so they use the platform clock.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_INPUT_BYTES } from "../src/core/jobs/managed-job.ts";
import { JobSupervisor } from "../src/core/jobs/supervisor.ts";
import { createLocalBashOperations } from "../src/core/tools/bash.ts";
import { createJobToolDefinition } from "../src/core/tools/job.ts";
import { isProcessGroupAlive } from "../src/utils/shell.ts";

const OWNER = "owner-real";

/** Polls `predicate` until it holds or `ms` elapses. */
async function until(predicate: () => boolean, ms: number): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	return predicate();
}

function request(command: string, stdin = false) {
	return {
		owner: OWNER,
		name: undefined,
		command,
		cwd: process.cwd(),
		env: process.env,
		operations: createLocalBashOperations(),
		timeout: undefined,
		stdin,
		onData: undefined,
	};
}

describe("background jobs with the local shell", () => {
	it("completes a foreground-style command and keeps its output in the log", async () => {
		const supervisor = new JobSupervisor();
		const job = supervisor.prepare(request("echo hello; sleep 0.2; echo world"));
		expect(supervisor.adopt(job)).toBe(true);
		await expect(job.completion).resolves.toEqual({ exitCode: 0 });
		expect(job.state).toBe("completed");
		expect(job.log.read(undefined, 1024).text).toContain("hello\nworld");
		supervisor.killSession(OWNER);
	});

	it("passes input to a background job's stdin", async () => {
		const supervisor = new JobSupervisor();
		const job = supervisor.start(request("cat", true));
		// The background path waits for launch the same way, so the model only gets the handle once stdin exists.
		await job.launched;
		await supervisor.sendInput(job.jobId, OWNER, "ping\n");
		expect(await until(() => job.log.read(undefined, 1024).text.includes("ping"), 5_000)).toBe(true);
		const result = await supervisor.stop(job.jobId, OWNER, { announce: false });
		expect(result.job.state).toBe("stopped");
	});

	// Regression for roadmap issue #1: the model-facing action must reach the actual stdin pipe.
	it("delivers send_input from the job tool to a real shell", async () => {
		const supervisor = new JobSupervisor();
		const job = supervisor.start(request("read line; printf 'received:%s\\n' \"$line\"", true));
		const tool = createJobToolDefinition({ supervisor, owner: () => OWNER });
		try {
			await job.launched;
			const sent = await tool.execute(
				"input",
				{ action: "send_input", job_id: job.jobId, input: "hello\n" },
				undefined,
				undefined,
				undefined as never,
			);
			expect(sent.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Sent 6 bytes") });
			await job.settled;
			const result = await tool.execute(
				"output",
				{ action: "output", job_id: job.jobId },
				undefined,
				undefined,
				undefined as never,
			);
			expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("received:hello") });
		} finally {
			supervisor.killSession(OWNER);
		}
	});

	it("accepts input of exactly the size cap and refuses one byte more", async () => {
		const supervisor = new JobSupervisor();
		const job = supervisor.start(request("read line; printf '%s' \"$line\" | wc -c", true));
		try {
			await job.launched;
			const tooLarge = `${"a".repeat(MAX_INPUT_BYTES)}\n`;
			await expect(supervisor.sendInput(job.jobId, OWNER, tooLarge)).rejects.toThrow("larger than");
			// The refused write left the job running and its stdin untouched.
			const exact = `${"a".repeat(MAX_INPUT_BYTES - 1)}\n`;
			expect(await supervisor.sendInput(job.jobId, OWNER, exact)).toMatchObject({ bytes: MAX_INPUT_BYTES });
			await job.settled;
			expect(supervisor.output(job.jobId, OWNER, undefined, 1024).page.text).toContain(String(MAX_INPUT_BYTES - 1));
		} finally {
			supervisor.killSession(OWNER);
		}
	});

	it("pages job output at 16 KiB by default and at the caller's maxBytes", async () => {
		const supervisor = new JobSupervisor();
		const job = supervisor.start(request("head -c 40000 /dev/zero | tr '\\0' a"));
		const tool = createJobToolDefinition({ supervisor, owner: () => OWNER });
		const run = async (params: { cursor?: string; maxBytes?: number }) => {
			const result = await tool.execute(
				"output",
				{ action: "output", job_id: job.jobId, ...params },
				undefined,
				undefined,
				undefined as never,
			);
			const text = (result.content[0] as { text: string }).text;
			return { run: text.match(/a+/)?.[0].length, cursor: text.match(/cursor: (\d+)/)?.[1] };
		};
		try {
			await job.settled;
			const first = await run({});
			expect(first.run).toBe(16 * 1024);
			// The next page starts where the default page ended.
			expect((await run({ cursor: first.cursor })).run).toBe(16 * 1024);
			expect((await run({ maxBytes: 100 })).run).toBe(100);
		} finally {
			supervisor.killSession(OWNER);
		}
	});

	it("stops a well-behaved job with SIGTERM well inside the grace period", async () => {
		const supervisor = new JobSupervisor();
		const job = supervisor.start(request("sleep 30"));
		// SIGTERM is only meaningful once the process group exists.
		expect(await until(() => job.pid !== undefined, 5_000)).toBe(true);
		const started = Date.now();
		const result = await supervisor.stop(job.jobId, OWNER, { announce: false });
		expect(result.settled).toBe(true);
		expect(result.job.state).toBe("stopped");
		expect(Date.now() - started).toBeLessThan(2_000);
	});

	it("escalates to SIGKILL when the job ignores SIGTERM", async () => {
		const supervisor = new JobSupervisor();
		const job = supervisor.start(request("trap '' TERM; echo ready; sleep 30"));
		expect(await until(() => job.log.read(undefined, 1024).text.includes("ready"), 5_000)).toBe(true);
		const pid = job.pid;
		expect(pid).toEqual(expect.any(Number));
		const started = Date.now();
		const result = await supervisor.stop(job.jobId, OWNER, { announce: false });
		expect(result.job.state).toBe("stopped");
		expect(Date.now() - started).toBeGreaterThanOrEqual(2_500);
		supervisor.killSession(OWNER);
		expect(await until(() => !isProcessGroupAlive(pid as number), 2_000)).toBe(true);
	}, 20_000);

	// Regression for roadmap issue #1: session shutdown must escalate without a separate killSession call.
	it("kills a TERM-ignoring process group during session shutdown", async () => {
		const supervisor = new JobSupervisor();
		const job = supervisor.start(request("trap '' TERM; echo ready; sleep 30"));
		try {
			expect(await until(() => job.log.read(undefined, 1024).text.includes("ready"), 5_000)).toBe(true);
			const pid = job.pid;
			expect(pid).toEqual(expect.any(Number));
			await supervisor.stopSession(OWNER);
			expect(await until(() => !isProcessGroupAlive(pid as number), 5_000)).toBe(true);
		} finally {
			await supervisor.stopSession(OWNER);
		}
	}, 20_000);

	it("cleans a descendant of a completed foreground command at session close", async () => {
		const supervisor = new JobSupervisor();
		const job = supervisor.prepare(request("(sleep 30 &); echo started"));
		await job.settled;
		expect(job.state).toBe("completed");
		const pid = job.pid;
		expect(pid).toEqual(expect.any(Number));
		await supervisor.stopSession(OWNER);
		expect(await until(() => !isProcessGroupAlive(pid as number), 5_000)).toBe(true);
	}, 20_000);

	it("tracks processes that outlive the shell until the session closes", async () => {
		const supervisor = new JobSupervisor();
		const job = supervisor.prepare(request("(sleep 30 &); echo started"));
		supervisor.adopt(job);
		await job.settled;
		expect(job.state).toBe("completed");
		expect(job.snapshot().descendants).toBe(true);
		const pid = job.pid;
		expect(pid).toEqual(expect.any(Number));
		await supervisor.stopSession(OWNER);
		expect(await until(() => !isProcessGroupAlive(pid as number), 5_000)).toBe(true);
	}, 20_000);

	it("keeps the crash record when descendants outlive the shell", async () => {
		const dir = mkdtempSync(join(tmpdir(), "axiom-jobs-"));
		const supervisor = new JobSupervisor({ registryDir: dir });
		try {
			const job = supervisor.prepare(request("(sleep 30 &); echo started"));
			supervisor.adopt(job);
			await job.settled;
			expect(job.snapshot().descendants).toBe(true);
			expect(existsSync(join(dir, `${job.jobId}.json`))).toBe(true);
			await supervisor.stopSession(OWNER);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 20_000);

	it("forgets the crash record once lingering descendants are cleaned", async () => {
		const dir = mkdtempSync(join(tmpdir(), "axiom-jobs-"));
		const supervisor = new JobSupervisor({ registryDir: dir });
		try {
			const job = supervisor.prepare(request("(sleep 30 &); echo started"));
			supervisor.adopt(job);
			await job.settled;
			const pid = job.pid;
			const record = join(dir, `${job.jobId}.json`);
			expect(pid).toEqual(expect.any(Number));
			expect(existsSync(record)).toBe(true);
			await supervisor.stopSession(OWNER);
			expect(await until(() => !isProcessGroupAlive(pid as number), 5_000)).toBe(true);
			supervisor.killSession(OWNER);
			expect(await until(() => !existsSync(record), 5_000)).toBe(true);
		} finally {
			supervisor.killSession(OWNER);
			rmSync(dir, { recursive: true, force: true });
		}
	}, 20_000);

	it("forgets a dead multiprocess crash record after killSession without another dispose", async () => {
		const dir = mkdtempSync(join(tmpdir(), "axiom-jobs-"));
		const supervisor = new JobSupervisor({ registryDir: dir });
		try {
			const job = supervisor.start(request("for i in $(seq 80); do sleep 60 & done; wait"));
			const record = join(dir, `${job.jobId}.json`);
			expect(await until(() => job.pid !== undefined && existsSync(record), 5_000)).toBe(true);
			const pid = job.pid as number;
			supervisor.killSession(OWNER);
			await job.settled;
			expect(await until(() => !isProcessGroupAlive(pid) && !existsSync(record), 5_000)).toBe(true);
		} finally {
			supervisor.killSession(OWNER);
			rmSync(dir, { recursive: true, force: true });
		}
	}, 20_000);

	it("queues stdin input a job does not read, then refuses further input", async () => {
		const supervisor = new JobSupervisor();
		const job = supervisor.start(request("sleep 30", true));
		await job.launched;
		const chunk = "x".repeat(16 * 1024);
		let queued = false;
		for (let i = 0; i < 32 && !queued; i++) {
			const sent = await supervisor.sendInput(job.jobId, OWNER, chunk);
			queued = sent.queued;
		}
		expect(queued).toBe(true);
		await expect(supervisor.sendInput(job.jobId, OWNER, "more")).rejects.toThrow("not reading its stdin");
		await supervisor.stop(job.jobId, OWNER, { announce: false });
	}, 30_000);
});
