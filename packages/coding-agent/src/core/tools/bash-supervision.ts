/**
 * How a bash call runs under the job supervisor: it finishes in the foreground, becomes a background job once
 * YIELD_AFTER_MS has passed, or starts in the background at once. The command is never restarted.
 */

import type { ManagedJob } from "../jobs/managed-job.ts";
import type { JobSupervisor } from "../jobs/supervisor.ts";
import type { BashOperations } from "./bash.ts";

/** A command still running after this long becomes a background job; the bash call returns its job_id. */
export const YIELD_AFTER_MS = 10_000;
const YIELD_OUTPUT_BYTES = 16 * 1024;

/** The session's job supervisor and the owner id its jobs are registered under. */
export interface JobScope {
	supervisor: JobSupervisor;
	owner: () => string;
}

export interface SupervisedCommand {
	scope: JobScope;
	operations: BashOperations;
	command: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
	timeout: number | undefined;
	name: string | undefined;
	background: boolean;
	yieldAfterMs?: number | null;
	signal: AbortSignal | undefined;
	onData: (chunk: Buffer) => void;
}

export type CommandRun = { kind: "finished"; exitCode: number | null } | { kind: "yielded"; job: ManagedJob };

/**
 * Run the command under the supervisor. Errors (abort, timeout, launch failure) reject with the same Error
 * the foreground path throws, so the bash tool reports them unchanged.
 */
export async function runSupervisedCommand(request: SupervisedCommand): Promise<CommandRun> {
	return request.background ? runBackground(request) : runForeground(request);
}

async function runBackground(request: SupervisedCommand): Promise<CommandRun> {
	if (request.operations.retainsProcessHandle !== true) {
		throw new Error("Background jobs require an execution backend with retained process handles.");
	}
	const { supervisor } = request.scope;
	const job = supervisor.start({
		owner: request.scope.owner(),
		name: request.name,
		command: request.command,
		cwd: request.cwd,
		env: request.env,
		operations: request.operations,
		timeout: request.timeout,
		stdin: true,
		onData: request.onData,
	});
	// The launch wait is the only window in which the caller's abort can still stop the job before it is returned.
	const aborted = Promise.withResolvers<void>();
	const onAbort = () => {
		void job.stop({ graceful: false });
		aborted.resolve();
	};
	attachAbort(request.signal, onAbort);
	try {
		await Promise.race([
			job.launched,
			aborted.promise.then(() => {
				throw new Error("aborted");
			}),
		]);
		if (request.signal?.aborted) throw new Error("aborted");
	} catch (error) {
		// A launch that failed never reaches the model, so it must not produce a finish notice.
		job.announce = false;
		throw error;
	} finally {
		request.signal?.removeEventListener("abort", onAbort);
	}
	if (!job.hasHandle && job.state === "running") {
		void job.stop({ graceful: false });
		throw new Error("Background jobs require an execution backend with retained process handles.");
	}
	job.markHandedOff();
	return { kind: "yielded", job };
}

async function runForeground(request: SupervisedCommand): Promise<CommandRun> {
	const { supervisor } = request.scope;
	const job = supervisor.prepare({
		owner: request.scope.owner(),
		name: request.name,
		command: request.command,
		cwd: request.cwd,
		env: request.env,
		operations: request.operations,
		timeout: request.timeout,
		stdin: false,
		onData: request.onData,
	});
	const onAbort = () => {
		if (job.state === "running") void job.stop({ graceful: false });
	};
	attachAbort(request.signal, onAbort);
	const yieldTimer = Promise.withResolvers<"yield">();
	const timer =
		request.yieldAfterMs === null
			? undefined
			: setTimeout(() => yieldTimer.resolve("yield"), request.yieldAfterMs ?? YIELD_AFTER_MS);
	try {
		const winner = await Promise.race([job.settled.then(() => "finished" as const), yieldTimer.promise]);
		// Yield only when this call is still live: an abort on the same tick as the timer stops the job instead.
		if (winner === "yield" && job.state === "running" && job.hasHandle && !request.signal?.aborted) {
			// Adoption fails at the running limit; the call then stays in the foreground.
			if (adoptOrStop(supervisor, job)) {
				job.markHandedOff();
				return { kind: "yielded", job };
			}
		} else if (winner === "yield" && job.state === "running" && request.signal?.aborted) {
			void job.stop({ graceful: false });
		}
		await job.settled;
	} finally {
		clearTimeout(timer);
		// The abort signal stops the job only until the yield; after adoption the job outlives the call.
		request.signal?.removeEventListener("abort", onAbort);
	}
	return { kind: "finished", exitCode: (await job.completion).exitCode };
}

function attachAbort(signal: AbortSignal | undefined, onAbort: () => void): void {
	if (signal?.aborted) onAbort();
	else signal?.addEventListener("abort", onAbort, { once: true });
}

/** Adopt the job. When the session is closing the refused command is stopped, so it cannot outlive the call. */
function adoptOrStop(supervisor: JobSupervisor, job: ManagedJob): boolean {
	try {
		return supervisor.adopt(job);
	} catch (error) {
		void job.stop({ graceful: false });
		throw error;
	}
}

/** Tool result for a call that is now a background job: the latest output, its cursor and the job id, as text. */
export function yieldedResult(
	job: ManagedJob,
	background: boolean,
): { content: [{ type: "text"; text: string }]; details: undefined } {
	const page = job.log.tail(YIELD_OUTPUT_BYTES);
	const output = page.omittedBytes > 0 ? `[${page.omittedBytes} earlier bytes omitted]\n${page.text}` : page.text;
	const header = background
		? `Started background job ${job.jobId}.`
		: `Still running after ${YIELD_AFTER_MS / 1000} seconds; continuing as background job ${job.jobId}.`;
	const body = output.length > 0 ? output : "(no output yet)";
	const hint = `Read more: job({"action":"output","job_id":"${job.jobId}","cursor":"${page.cursor}"}). Stop it: job({"action":"stop","job_id":"${job.jobId}"}).`;
	return {
		content: [{ type: "text", text: `${header}\n\n${body}\n\n${hint}` }],
		details: undefined,
	};
}
