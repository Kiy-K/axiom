/** The `job` tool: list, inspect, read, write to and stop the background jobs of this session. */

import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import { formatJobList, formatJobStatus } from "../jobs/format.ts";
import type { JobScope } from "./bash-supervision.ts";

const DEFAULT_OUTPUT_BYTES = 16 * 1024;

const jobSchema = Type.Object({
	action: Type.Union(
		[
			Type.Literal("list"),
			Type.Literal("status"),
			Type.Literal("output"),
			Type.Literal("send_input"),
			Type.Literal("stop"),
		],
		{ description: "list all jobs, status or output of one job, send_input to its stdin, or stop it" },
	),
	job_id: Type.Optional(Type.String({ description: "Job id returned by bash (required except for list)" })),
	cursor: Type.Optional(
		Type.String({
			description: "Position from the previous output result; omit to read from the oldest retained output",
		}),
	),
	input: Type.Optional(Type.String({ description: "Text to write to stdin (send_input only)" })),
	maxBytes: Type.Optional(Type.Number({ description: "Output page size in bytes (default 16384, max 65536)" })),
});

export type JobToolInput = Static<typeof jobSchema>;

/** Model-facing `job` tool bound to one session's supervisor. */
export function createJobToolDefinition(scope: JobScope): ToolDefinition<typeof jobSchema, undefined> {
	return {
		name: "job",
		label: "job",
		description:
			"Manage background bash jobs. A command that runs longer than 10 seconds, or was started with background: true, becomes a job. Actions: list, status, output (read from a cursor), send_input (write to stdin of a job started with background: true), stop.",
		promptSnippet: "Manage background bash jobs: list, status, output, send_input, stop",
		parameters: jobSchema,
		constrainedSampling: false,
		async execute(_toolCallId, params) {
			const { supervisor } = scope;
			const owner = scope.owner();
			const now = Date.now();
			const jobId = (): string => {
				if (params.job_id === undefined) throw new Error(`job_id is required for action "${params.action}".`);
				return params.job_id;
			};
			let text: string;
			switch (params.action) {
				case "list":
					text = formatJobList(supervisor.list(owner), now);
					break;
				case "status":
					text = formatJobStatus(supervisor.status(jobId(), owner), now);
					break;
				case "output": {
					const { page, job } = supervisor.output(
						jobId(),
						owner,
						params.cursor,
						params.maxBytes ?? DEFAULT_OUTPUT_BYTES,
					);
					text = `${page.text}\n[state: ${job.state}, cursor: ${page.cursor}]`;
					break;
				}
				case "send_input": {
					if (params.input === undefined) throw new Error('input is required for action "send_input".');
					const sent = await supervisor.sendInput(jobId(), owner, params.input);
					text = sent.queued
						? `Queued ${sent.bytes} bytes for job ${params.job_id}; delivery is pending and may fail if stdin closes.`
						: `Sent ${sent.bytes} bytes to job ${params.job_id}.`;
					break;
				}
				case "stop": {
					const result = await supervisor.stop(jobId(), owner, { announce: false });
					text = formatJobStatus(result.job, now);
					if (!result.settled) text += "\nThe job did not exit within the grace period; it may still be running.";
					break;
				}
			}
			return { content: [{ type: "text", text }], details: undefined };
		},
	};
}
