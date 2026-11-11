// Record of every gateway decision: a bounded in-memory tail plus an append-only JSONL file.

import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Decision } from "./types.ts";

/** Entries kept in memory for `/permissions` and tests. */
const MAX_MEMORY_ENTRIES = 200;

/** Who produced the decision. */
export type DecisionSource =
	| "policy" // the rules decided without asking
	| "grant" // a live grant covered the call
	| "user" // the user answered a prompt
	| "user-command" // the user typed the command themselves
	| "no-ui" // a prompt was needed and there was nobody to ask
	| "timeout" // the prompt expired or was dismissed
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

	constructor(filePath?: string) {
		this.filePath = filePath;
	}

	/** Append an entry. A file write failure is reported through `onError` and never changes the decision. */
	record(entry: AuditEntry, onError?: (message: string) => void): void {
		this.entries.push(entry);
		if (this.entries.length > MAX_MEMORY_ENTRIES) this.entries.shift();
		if (this.filePath === undefined) return;
		try {
			mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
			appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
			chmodSync(this.filePath, 0o600);
		} catch (error) {
			onError?.(`Permission audit log write failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/** The newest `count` entries, oldest first. */
	tail(count: number): AuditEntry[] {
		return this.entries.slice(-count);
	}
}
