import { describe, expect, it } from "vitest";
import { formatFinishNotice, formatJobList, formatJobStatus } from "../src/core/jobs/format.ts";
import { JobSupervisor } from "../src/core/jobs/supervisor.ts";
import type { BashOperations } from "../src/core/tools/bash.ts";

const OWNER = "owner-a";
const HOST_PID = 424_242_424;
const SECRET = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

/** An execution that reports a host pid, then fails with an error message that carries a secret and escape sequences. */
const failingOperations: BashOperations = {
	exec: async (_command, _cwd, options) => {
		options.onSpawn?.(HOST_PID);
		throw new Error(`spawn failed: token=${SECRET}\x1b]0;pwned\x07\x1b[2J`);
	},
};

describe("job list, status and finish notice text", () => {
	it("carries no host pid, no credential and no control sequence in names, commands and errors", async () => {
		const supervisor = new JobSupervisor();
		const job = supervisor.start({
			owner: OWNER,
			name: `deploy \x1b[31m--password=hunter2hunter2`,
			// The list and status views cut a command at 60 characters, so the secret and the sequence must sit before the cut.
			command: `TOKEN=${SECRET} ./x\x1b]0;retitle\x07`,
			cwd: "/tmp",
			env: {},
			operations: failingOperations,
			timeout: undefined,
			stdin: false,
			onData: undefined,
		});
		await job.settled;
		const snapshot = supervisor.status(job.jobId, OWNER);
		const text = [
			formatJobList([snapshot], Date.now()),
			formatJobStatus(snapshot, Date.now()),
			formatFinishNotice(job),
		].join("\n");

		expect(snapshot.state).toBe("failed");
		expect(text).toContain("[REDACTED]");
		for (const leaked of [String(HOST_PID), SECRET, SECRET.slice(0, 12), "hunter2hunter2", "\x1b", "\x07"]) {
			expect(text).not.toContain(leaked);
		}
	});

	it("shortens a very long command in job status", async () => {
		const supervisor = new JobSupervisor();
		const job = supervisor.start({
			owner: OWNER,
			name: undefined,
			command: `echo ${"a".repeat(50_000)}`,
			cwd: "/tmp",
			env: {},
			operations: failingOperations,
			timeout: undefined,
			stdin: false,
			onData: undefined,
		});
		await job.settled;
		const status = formatJobStatus(supervisor.status(job.jobId, OWNER), Date.now());
		expect(status.length).toBeLessThan(1000);
	});
});
