/**
 * Registry of background jobs for this process. A command is prepared unregistered; it becomes a job when it
 * is adopted (it yielded, or it was started in the background). Every operation takes the owner, the id of
 * the AgentSession that owns the job; a job of another owner reads as unknown.
 */

import { randomBytes } from "node:crypto";
import type { BashOperations } from "../tools/bash.ts";
import type { OutputPage } from "./log-buffer.ts";
import { type JobSnapshot, ManagedJob, STOP_GRACE_MS } from "./managed-job.ts";
import { findOrphanedJobs, forgetJob, type JobRecord, recordJob } from "./registry.ts";

export const MAX_RUNNING_JOBS = 8;
const MAX_FINISHED_JOBS = 16;
/**
 * Finished jobs per session whose helper may stay alive. Where the kernel cannot prove a group empty (no
 * process-group pidfd), every finished job keeps a helper, a zombie leader and three pipes until closed; past
 * this bound the oldest groups are killed and released.
 */
export const MAX_UNPROVEN_GROUPS = 16;
/** Time allowed after the grace period before a stop reports `settled: false`. */
const STOP_WAIT_EXTRA_MS = 2_000;
/** Allow the helper's five-second cleanup confirmation window and IPC delivery. */
const CLEANUP_CONFIRM_WAIT_MS = 6_000;

export interface PrepareRequest {
	owner: string;
	name: string | undefined;
	command: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
	operations: BashOperations;
	timeout: number | undefined;
	/** Whether the job gets a stdin pipe. Only explicit background jobs do. */
	stdin: boolean;
	onData: ((chunk: Buffer) => void) | undefined;
}

export interface StopResult {
	job: JobSnapshot;
	/** False when the operations did not settle within grace plus the extra wait. The state stays `running`. */
	settled: boolean;
}

export interface JobSupervisorOptions {
	/** Directory of crash-recovery records. Undefined disables recording. */
	registryDir?: string;
}

/** Starts, registers, inspects and stops background jobs. One supervisor serves one process. */
export class JobSupervisor {
	private readonly jobs = new Map<string, ManagedJob>();
	private readonly closedOwners = new Set<string>();
	private readonly finishedListeners = new Map<string, Set<(job: ManagedJob) => void>>();
	/** Prepared jobs retain their handles even after foreground completion or eviction. */
	private readonly ownedJobs = new Map<string, Set<ManagedJob>>();
	/** Finish sequence, so eviction keeps recently finished jobs rather than recently adopted ones. */
	private readonly finishOrder = new Map<string, number>();
	private nextFinishOrder = 0;
	/** Settle sequence of every job, adopted or not, so the bound drops the longest-finished groups first. */
	private readonly settleOrder = new WeakMap<ManagedJob, number>();
	/** User stops whose finish notice a model stop must not clear. */
	private readonly userAnnounced = new Set<string>();
	/** Model stops that have hidden the finish notice until they know whether the job settled. */
	private readonly modelStopHolds = new Map<string, number>();
	private readonly registryDir: string | undefined;

	constructor(options: JobSupervisorOptions = {}) {
		this.registryDir = options.registryDir;
	}
	/** Start the command without registering it. The caller decides whether it becomes a job (adopt). */
	prepare(request: PrepareRequest): ManagedJob {
		const job = new ManagedJob({
			jobId: randomBytes(8).toString("hex"),
			owner: request.owner,
			name: request.name,
			command: request.command,
			stdin: request.stdin,
			onSpawned: (spawned) => {
				if (spawned.hasHandle) this.recordSpawn(spawned);
				if (this.closedOwners.has(spawned.owner)) spawned.killNow();
			},
			onHandleLost: (lost) => {
				this.recordSpawn(lost);
			},
			onGroupEmpty: (empty) => {
				if (!empty.releaseEmpty()) return;
				this.ownedJobs.get(empty.owner)?.delete(empty);
				this.forgetRecord(empty.jobId);
			},
			onSettled: (settled) => this.handleSettled(settled),
		});
		let owned = this.ownedJobs.get(request.owner);
		if (!owned) {
			owned = new Set();
			this.ownedJobs.set(request.owner, owned);
		}
		owned.add(job);
		job.run(request.operations, {
			cwd: request.cwd,
			env: request.env,
			timeout: request.timeout,
			onData: request.onData,
		});
		return job;
	}

	/**
	 * Register a prepared job as a background job. Returns false, leaving the job unregistered, when the
	 * running limit is reached. Throws when the owner's session is closing.
	 */
	adopt(job: ManagedJob): boolean {
		if (this.closedOwners.has(job.owner)) throw new Error("The session is closing; no new background jobs.");
		if (this.countRunning() >= MAX_RUNNING_JOBS) return false;
		job.adopted = true;
		job.announce = true;
		this.jobs.set(job.jobId, job);
		if (job.pid !== undefined) this.recordSpawn(job);
		return true;
	}

	/** Start a background job now. Throws before spawning when the limit is reached or the session is closing. */
	start(request: PrepareRequest): ManagedJob {
		if (this.closedOwners.has(request.owner)) throw new Error("The session is closing; no new background jobs.");
		if (this.countRunning() >= MAX_RUNNING_JOBS) {
			throw new Error(
				`Too many running background jobs (limit ${MAX_RUNNING_JOBS}). Stop one with job({action: "stop", job_id}).`,
			);
		}
		const job = this.prepare(request);
		if (!this.adopt(job)) throw new Error("Too many running background jobs.");
		return job;
	}

	/** Status of a job. Marks it observed once terminal, so its finish notice is not repeated. */
	status(jobId: string, owner: string): JobSnapshot {
		const job = this.get(jobId, owner);
		const snapshot = job.snapshot();
		if (snapshot.state !== "running") job.markObserved();
		return snapshot;
	}

	/**
	 * Output after `cursor` (undefined: the oldest retained byte), with the job's current state. Marks the job
	 * observed once terminal, as status does.
	 */
	output(
		jobId: string,
		owner: string,
		cursor: string | undefined,
		maxBytes: number,
	): { page: OutputPage; job: JobSnapshot } {
		const job = this.get(jobId, owner);
		const page = job.log.read(cursor, maxBytes, job.state !== "running");
		const snapshot = job.snapshot();
		if (snapshot.state !== "running") job.markObserved();
		return { page, job: snapshot };
	}

	async sendInput(jobId: string, owner: string, data: string): Promise<{ bytes: number; queued: boolean }> {
		return this.get(jobId, owner).sendInput(data);
	}

	list(owner: string): JobSnapshot[] {
		return [...this.jobs.values()].filter((job) => job.owner === owner).map((job) => job.snapshot());
	}

	/**
	 * Stop one job, gracefully. Idempotent: stopping a finished job returns its final state. A model stop (`announce`
	 * false) of a job that already finished marks it observed. A model stop that does not settle keeps the later
	 * finish notice unless the session is closing. A user stop notice stays even if a model stop overlaps it.
	 */
	async stop(jobId: string, owner: string, options: { announce: boolean }): Promise<StopResult> {
		const job = this.get(jobId, owner);
		// A model stop of a finished job shows the final state, so the job's queued notice is not repeated.
		if (job.state !== "running" && !options.announce) job.markObserved();
		if (options.announce) this.userAnnounced.add(jobId);
		const held = !options.announce && !this.userAnnounced.has(jobId);
		if (held) {
			this.modelStopHolds.set(jobId, (this.modelStopHolds.get(jobId) ?? 0) + 1);
			job.announce = false;
		} else {
			job.announce = true;
		}
		try {
			return await this.stopJob(job);
		} finally {
			if (held) {
				const left = (this.modelStopHolds.get(jobId) ?? 1) - 1;
				if (left <= 0) this.modelStopHolds.delete(jobId);
				else this.modelStopHolds.set(jobId, left);
				if (
					left <= 0 &&
					job.state === "running" &&
					!this.closedOwners.has(owner) &&
					!this.userAnnounced.has(jobId)
				) {
					job.announce = true;
				}
			}
		}
	}

	/** Stop all owned groups, including descendants of completed foreground commands. */
	async stopSession(owner: string): Promise<StopResult[]> {
		this.closedOwners.add(owner);
		const jobs = [...(this.ownedJobs.get(owner) ?? [])];
		const running = jobs.filter((job) => job.state === "running");
		for (const job of jobs) {
			job.announce = false;
			if (job.state !== "running") job.terminateGroup();
		}
		const hasHandles = jobs.some((job) => job.hasHandle);
		const resultsPromise = Promise.all(running.map((job) => this.stopJob(job)));
		if (hasHandles) {
			await waitWithin(
				Promise.all(jobs.map((job) => job.cleanupConfirmed)).then(() => {}),
				STOP_GRACE_MS,
			);
		}
		for (const job of jobs) {
			job.killNow();
		}
		const unconfirmed = new Set(jobs.map((job) => job.jobId));
		const confirmations = Promise.all(
			jobs.map(async (job) => {
				if (await job.cleanupConfirmed) unconfirmed.delete(job.jobId);
			}),
		).then(() => {});
		await waitWithin(confirmations, CLEANUP_CONFIRM_WAIT_MS);
		this.ownedJobs.delete(owner);
		const results = await resultsPromise;
		if (unconfirmed.size > 0) {
			console.warn(
				`Could not confirm process cleanup for jobs ${[...unconfirmed].join(", ")}; crash records were retained where available.`,
			);
		}
		return results;
	}

	/** Immediately kill and release all retained groups owned by the session. */
	killSession(owner: string): void {
		this.closedOwners.add(owner);
		for (const job of this.ownedJobs.get(owner) ?? []) {
			job.announce = false;
			job.killNow();
		}
		this.ownedJobs.delete(owner);
	}

	/** Listen for adopted jobs of the owner finishing. Returns the unsubscribe function. */
	onFinished(owner: string, listener: (job: ManagedJob) => void): () => void {
		let listeners = this.finishedListeners.get(owner);
		if (!listeners) {
			listeners = new Set();
			this.finishedListeners.set(owner, listeners);
		}
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
		};
	}

	/** Whether the model has read the terminal state of this job. False for unknown or evicted jobs. */
	isObserved(jobId: string): boolean {
		return this.jobs.get(jobId)?.observed === true;
	}

	/** Records from earlier processes whose jobs may still run. Never includes this process's own jobs. */
	orphans(): JobRecord[] {
		return this.registryDir ? findOrphanedJobs(this.registryDir) : [];
	}

	/** Registered job of the owner, or the same "Unknown job" error for a missing or foreign id. */
	get(jobId: string, owner: string): ManagedJob {
		const job = this.jobs.get(jobId);
		if (!job || job.owner !== owner) throw new Error(`Unknown job: ${jobId}`);
		return job;
	}

	private async stopJob(job: ManagedJob): Promise<StopResult> {
		const settled = await waitWithin(job.stop({ graceful: true }), STOP_GRACE_MS + STOP_WAIT_EXTRA_MS);
		return { job: job.snapshot(), settled };
	}

	private countRunning(): number {
		let count = 0;
		for (const job of this.jobs.values()) if (job.state === "running") count++;
		return count;
	}

	private handleSettled(job: ManagedJob): void {
		this.settleOrder.set(job, this.nextFinishOrder++);
		if (!job.adopted) {
			if (!job.hasHandle && !job.handleLost) this.ownedJobs.get(job.owner)?.delete(job);
			this.boundUnprovenGroups(job.owner);
			return;
		}
		this.finishOrder.set(job.jobId, this.nextFinishOrder - 1);
		if (job.announce && !job.launchFailed) {
			for (const listener of this.finishedListeners.get(job.owner) ?? []) listener(job);
		}
		this.evictFinished();
		this.boundUnprovenGroups(job.owner);
	}

	/**
	 * Kills and releases the groups that finished longest ago beyond MAX_UNPROVEN_GROUPS. The helper still pins
	 * the group, so the signal is safe. The job stays owned: session teardown still reports unconfirmed cleanup.
	 */
	private boundUnprovenGroups(owner: string): void {
		const retained = [...(this.ownedJobs.get(owner) ?? [])].filter((job) => job.retainsUnprovenGroup);
		retained.sort((a, b) => (this.settleOrder.get(a) ?? 0) - (this.settleOrder.get(b) ?? 0));
		for (const job of retained.slice(0, Math.max(0, retained.length - MAX_UNPROVEN_GROUPS))) job.killNow();
	}

	private forgetRecord(jobId: string): void {
		if (!this.registryDir) return;
		try {
			forgetJob(this.registryDir, jobId);
		} catch {
			// A record that cannot be removed is reported as an orphan later; the finish must still complete.
		}
	}

	/** Keeps the newest finished jobs, by finish order, so `job status` still answers for recent ones. */
	private evictFinished(): void {
		const finished = [...this.jobs.values()].filter((job) => job.state !== "running");
		finished.sort((a, b) => (this.finishOrder.get(a.jobId) ?? 0) - (this.finishOrder.get(b.jobId) ?? 0));
		for (const job of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED_JOBS))) {
			this.jobs.delete(job.jobId);
			this.finishOrder.delete(job.jobId);
			this.userAnnounced.delete(job.jobId);
			this.modelStopHolds.delete(job.jobId);
		}
	}

	private recordSpawn(job: ManagedJob): void {
		if (!this.registryDir || job.pid === undefined) return;
		try {
			recordJob(this.registryDir, {
				job_id: job.jobId,
				supervisor_pid: process.pid,
				pid: job.pid,
				started_at: job.startedAt,
			});
		} catch {
			// Only crash reporting is lost if the record cannot be written; the job itself still runs.
		}
	}
}

/** Resolves true when `promise` settles within `ms`, false otherwise. */
function waitWithin(promise: Promise<void>, ms: number): Promise<boolean> {
	const deadline = Promise.withResolvers<boolean>();
	const timer = setTimeout(() => deadline.resolve(false), ms);
	return Promise.race([promise.then(() => true), deadline.promise]).finally(() => clearTimeout(timer));
}
