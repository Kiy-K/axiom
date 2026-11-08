/**
 * Crash-recovery records for local background jobs: one JSON file per job in the agent's jobs directory,
 * readable only by the owner. A record lets a later process report a job that outlived its supervisor.
 * It never kills anything: after a crash the recorded pid may belong to another process.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface JobRecord {
	job_id: string;
	supervisor_pid: number;
	/** Process group leader of the job. */
	pid: number;
	started_at: number;
}

export function recordJob(dir: string, record: JobRecord): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `${record.job_id}.json`), JSON.stringify(record), { mode: 0o600 });
}

export function forgetJob(dir: string, jobId: string): void {
	rmSync(join(dir, `${jobId}.json`), { force: true });
}

/**
 * Records belonging to other supervisors. Pids are informational and cannot establish whether
 * either the supervisor or the job is still alive, so valid records are never removed by probing.
 */
export function findOrphanedJobs(dir: string): JobRecord[] {
	if (!existsSync(dir)) return [];
	const orphans: JobRecord[] = [];
	for (const file of readdirSync(dir, { withFileTypes: true })) {
		if (!file.isFile() || !file.name.endsWith(".json")) continue;
		const path = join(dir, file.name);
		const record = readRecord(path);
		if (record === undefined) continue;
		if (record.supervisor_pid !== process.pid) orphans.push(record);
	}
	return orphans;
}

/** A record is trusted only with positive integer pids: pid 0 would address the caller's own group. */
function readRecord(path: string): JobRecord | undefined {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as JobRecord;
		if (isPositiveInteger(parsed.pid) && isPositiveInteger(parsed.supervisor_pid)) return parsed;
	} catch {
		// Unreadable: handled below.
	}
	rmSync(path, { force: true });
	return undefined;
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
