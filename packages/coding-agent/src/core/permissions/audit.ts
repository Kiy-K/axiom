// Record of every gateway decision: a bounded in-memory tail plus an append-only JSONL file.

import { appendFileSync, chmodSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { Decision } from "./types.ts";

/** Entries kept in memory for `/permissions` and tests. */
const MAX_MEMORY_ENTRIES = 200;

/** The file is moved to `<file>.1` once it holds this many bytes; one older generation is kept. */
export const AUDIT_MAX_BYTES = 5 * 1024 * 1024;

/** Who produced the decision. */
export type DecisionSource =
	| "policy" // the rules decided without asking
	| "accept-edits" // a trusted, recoverable built-in edit
	| "auto" // a positive rule of `auto` allowed it; the entry's detail starts with the rule id
	| "grant" // a live grant covered the call
	| "user" // the user answered a prompt
	| "user-command" // the user typed the command themselves
	| "no-ui" // a prompt was needed and there was nobody to ask
	| "timeout" // the prompt expired or was dismissed
	| "mode-change" // the permission mode changed while the prompt was open
	| "taint-budget" // the task's approval budget was spent after untrusted content entered it
	| "error"; // evaluating the call failed, so it was denied

export interface AuditEntry {
	time: number;
	sessionId: string;
	toolName: string;
	toolCallId?: string;
	parentToolCallId?: string;
	/** Sanitized path of the extension that asked, for calls an extension makes itself (`pi.exec`). */
	caller?: string;
	decision: Decision;
	source: DecisionSource;
	/** Sanitized one-line description of the effects and the reason. */
	detail: string;
	grantId?: string;
}

export class AuditLog {
	private readonly entries: AuditEntry[] = [];
	private readonly filePath: string | undefined;
	private readonly maxBytes: number;

	constructor(filePath?: string, maxBytes = AUDIT_MAX_BYTES) {
		this.filePath = filePath;
		this.maxBytes = maxBytes;
	}

	/** Append an entry. A file write failure is reported through `onError` and never changes the decision. */
	record(entry: AuditEntry, onError?: (message: string) => void): void {
		this.entries.push(entry);
		if (this.entries.length > MAX_MEMORY_ENTRIES) this.entries.shift();
		if (this.filePath === undefined) return;
		try {
			mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
			this.rotateIfFull(this.filePath, onError);
			appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
			chmodSync(this.filePath, 0o600);
		} catch (error) {
			onError?.(`Permission audit log write failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/**
	 * Move a full file over `<file>.1`. The size is read on every write, not counted in memory: sessions share this
	 * file, so a private count would drift. A failed rotation is reported and the entry is still appended.
	 */
	private rotateIfFull(file: string, onError?: (message: string) => void): void {
		let size: number;
		try {
			size = statSync(file).size;
		} catch {
			return; // No file yet.
		}
		if (size < this.maxBytes) return;
		try {
			renameSync(file, `${file}.1`);
		} catch (error) {
			onError?.(`Permission audit log rotation failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/** The newest `count` entries, oldest first. */
	tail(count: number): AuditEntry[] {
		return this.entries.slice(-count);
	}
}
