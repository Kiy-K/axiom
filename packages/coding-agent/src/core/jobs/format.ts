/** Text shown to the model and the user for background jobs: list, status and the finish notice. */

import type { JobSnapshot, ManagedJob } from "./managed-job.ts";

/**
 * The finish message the agent receives once for a background job. It carries state, exit code and error only.
 * Command output is not included: it reaches the model as user-role text, so the model reads it with `job output`
 * as tool output instead.
 */
export function formatFinishNotice(job: ManagedJob): string {
	const snapshot = job.snapshot();
	const exit = snapshot.exitCode === undefined ? "" : ` (exit code ${snapshot.exitCode})`;
	const error = snapshot.error === undefined ? "" : `\n${snapshot.error}`;
	const label = job.name ?? job.jobId;
	return `Background job ${label} (${job.jobId}) ${snapshot.state}${exit}.${error}\nRead its output with job({"action":"output","job_id":"${job.jobId}"}).`;
}

/** One line per job, newest first, for `job list` and `/jobs`. */
export function formatJobList(jobs: JobSnapshot[], now: number): string {
	if (jobs.length === 0) return "No background jobs.";
	return jobs
		.slice()
		.reverse()
		.map((job) => {
			const name = job.name === undefined ? "" : `${job.name}  `;
			return `${job.jobId}  ${job.state.padEnd(10)}  ${formatAge(now - job.startedAt)}  ${name}${shorten(job.command)}`;
		})
		.join("\n");
}

/** Multi-line description of one job for `job status`. */
export function formatJobStatus(job: JobSnapshot, now: number): string {
	const lines = [`job ${job.jobId}`, `state: ${job.state}`];
	if (job.name !== undefined) lines.push(`name: ${job.name}`);
	lines.push(`command: ${shorten(job.command)}`);
	lines.push(`age: ${formatAge(now - job.startedAt)}`);
	lines.push(`stdin: ${job.hasStdin ? "open" : "none"}`);
	if (job.descendants) lines.push("descendants: processes started by the job may still run");
	if (job.exitCode !== undefined) lines.push(`exit code: ${job.exitCode}`);
	if (job.error !== undefined) lines.push(`error: ${job.error}`);
	return lines.join("\n");
}

function formatAge(ms: number): string {
	return `${Math.max(0, Math.round(ms / 1000))}s`;
}

function shorten(command: string): string {
	const oneLine = command.replace(/\s+/g, " ").trim();
	return oneLine.length > 60 ? `${oneLine.slice(0, 57)}...` : oneLine;
}
