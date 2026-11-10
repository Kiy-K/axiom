// The permission gateway: one decision point every tool call passes before it executes.

import { type AuditEntry, AuditLog, type DecisionSource } from "./audit.ts";
import { GRANT_TTL_MS, GrantStore } from "./grants.ts";
import { actionsForToolCall, execAction, judgeAction, MAX_COMMAND_CHARS } from "./policy.ts";
import { sanitizeForDisplay as sanitize, sanitizeForPrompt as show } from "./redact.ts";
import type { Action, ActionVerdict, Decision, GrantScope, PermissionMode } from "./types.ts";

/** The part of the extension UI the gateway needs to ask the user. */
export interface PermissionPrompter {
	select(
		title: string,
		options: string[],
		opts?: { signal?: AbortSignal; timeout?: number },
	): Promise<string | undefined>;
}

export interface PermissionGatewayOptions {
	getMode: () => PermissionMode;
	getCwd: () => string;
	getSessionId: () => string;
	/** Undefined when nobody can be asked (print mode, no UI bound): an `ask` then becomes a denial. */
	getPrompter: () => PermissionPrompter | undefined;
	/** Where decisions are appended as JSONL. Omit to keep them in memory only. */
	auditFile?: string;
	onWarning?: (message: string) => void;
	/** How long a prompt may stay unanswered before it is a denial. Default: {@link PROMPT_TIMEOUT_MS}. */
	promptTimeoutMs?: number;
}

/** What a hook returns to stop a call. */
export interface PermissionBlock {
	block: true;
	reason: string;
}

export interface ToolCallRequest {
	toolName: string;
	toolCallId: string;
	parentToolCallId?: string;
	input: Record<string, unknown>;
}

/** A prompt that nobody answers within this time is a denial. */
export const PROMPT_TIMEOUT_MS = 2 * 60 * 1000;

const ALLOW_ONCE = "Allow once";
const DENY = "Deny";
/** Long enough for any command the policy lets through, so a prompt or log entry never hides part of one. */
const MAX_DETAIL_CHARS = MAX_COMMAND_CHARS;

/** One line, so a command with newlines cannot fake extra lines in a prompt or log entry. */
function clean(text: string, maxLength: number): string {
	return sanitize(text, maxLength).replace(/\s*\n\s*/g, " | ");
}

export class PermissionGateway {
	readonly grants = new GrantStore();
	readonly audit: AuditLog;
	private readonly options: PermissionGatewayOptions;

	constructor(options: PermissionGatewayOptions) {
		this.options = options;
		this.audit = new AuditLog(options.auditFile);
	}

	get mode(): PermissionMode {
		return this.options.getMode();
	}

	/**
	 * Decide a tool call. Returns undefined to let it run, or a block. Call it after every hook that may change the
	 * input has run: it judges exactly what the tool will execute. Any failure here blocks the call.
	 */
	async authorize(call: ToolCallRequest, signal?: AbortSignal): Promise<PermissionBlock | undefined> {
		if (this.mode === "unrestricted") return undefined;
		try {
			return await this.decide(call, signal);
		} catch (error) {
			const reason = `Permission check failed: ${error instanceof Error ? error.message : String(error)}`;
			this.record(call, "deny", "error", reason);
			return { block: true, reason: clean(reason, MAX_DETAIL_CHARS) };
		}
	}

	/** Record shell the user typed themselves (`!cmd`). Typing it is the consent, so it is never blocked. */
	recordUserCommand(command: string): void {
		if (this.mode === "unrestricted") return;
		const action = execAction(command);
		this.record({ toolName: "user-bash", toolCallId: "" }, "allow", "user-command", describe(action));
	}

	private async decide(call: ToolCallRequest, signal: AbortSignal | undefined): Promise<PermissionBlock | undefined> {
		const actions = actionsForToolCall(call.toolName, call.input, this.options.getCwd());
		const verdicts = actions.map((action) => ({ action, verdict: judgeAction(action) }));
		const summary = actions.map(describe).join("; ") || "no direct effect";

		const denied = verdicts.find((entry) => entry.verdict.decision === "deny");
		if (denied) {
			this.record(call, "deny", "policy", `${describe(denied.action)}: ${denied.verdict.reason}`);
			return { block: true, reason: `Blocked by permission policy: ${denied.verdict.reason}.` };
		}

		const pending = verdicts.filter(
			(entry) => entry.verdict.decision === "ask" && !(entry.verdict.grantable && this.grants.find(entry.action)),
		);
		if (pending.length === 0) {
			const grant = verdicts.map((entry) => this.grants.find(entry.action)).find((found) => found !== undefined);
			this.record(call, "allow", grant ? "grant" : "policy", summary, grant?.id);
			return undefined;
		}

		const prompter = this.options.getPrompter();
		if (!prompter) {
			this.record(call, "deny", "no-ui", summary);
			return { block: true, reason: "Blocked: this action needs approval and no user interface is available." };
		}

		const grantable = pending.map((entry) => entry.verdict.grantable);
		const grantScopes = grantable.every((scope) => scope !== undefined) ? (grantable as GrantScope[]) : undefined;
		const grantLabel = grantScopes
			? `Allow for ${GRANT_TTL_MS / 60000} minutes: ${grantScopes.map(describeGrantScope).join(", ")}`
			: undefined;
		const choices = [ALLOW_ONCE, ...(grantLabel ? [grantLabel] : []), DENY];
		const title = `Permission needed: ${show(call.toolName, 100)}\n${pending.map(promptLine).join("\n")}`;

		const choice = await this.ask(prompter, title, choices, signal);
		if (choice === undefined) {
			this.record(call, "deny", "timeout", summary);
			return { block: true, reason: "Blocked: the approval prompt was dismissed or timed out." };
		}
		if (choice === ALLOW_ONCE || choice === grantLabel) {
			const grantIds =
				choice === grantLabel && grantScopes ? grantScopes.map((scope) => this.grants.add(scope).id) : [];
			this.record(call, "allow", "user", summary, grantIds.join(",") || undefined);
			return undefined;
		}
		this.record(call, "deny", "user", summary);
		return { block: true, reason: "Blocked: the user denied this action." };
	}

	/**
	 * Ask the user. The gateway enforces the deadline and the abort itself, so a UI that ignores `timeout` and
	 * `signal` cannot hold the tool call forever.
	 */
	private async ask(
		prompter: PermissionPrompter,
		title: string,
		choices: string[],
		signal: AbortSignal | undefined,
	): Promise<string | undefined> {
		if (signal?.aborted) return undefined;
		const timeoutMs = this.options.promptTimeoutMs ?? PROMPT_TIMEOUT_MS;
		const dismissed = new AbortController();
		const stopOnAbort = () => dismissed.abort();
		signal?.addEventListener("abort", stopOnAbort, { once: true });
		const timer = setTimeout(stopOnAbort, timeoutMs);
		const gone = new Promise<undefined>((resolve) => {
			dismissed.signal.addEventListener("abort", () => resolve(undefined), { once: true });
		});
		try {
			const choice = await Promise.race([
				prompter.select(title, choices, { signal: dismissed.signal, timeout: timeoutMs }),
				gone,
			]);
			// An answer that arrives after the deadline or the abort does not count.
			return dismissed.signal.aborted ? undefined : choice;
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", stopOnAbort);
		}
	}

	private record(
		call: Pick<ToolCallRequest, "toolName" | "toolCallId" | "parentToolCallId">,
		decision: Decision,
		source: DecisionSource,
		detail: string,
		grantId?: string,
	): void {
		const entry: AuditEntry = {
			time: Date.now(),
			sessionId: this.options.getSessionId(),
			toolName: call.toolName,
			...(call.toolCallId ? { toolCallId: call.toolCallId } : {}),
			...(call.parentToolCallId ? { parentToolCallId: call.parentToolCallId } : {}),
			decision,
			source,
			detail: clean(detail, MAX_DETAIL_CHARS),
			...(grantId ? { grantId } : {}),
		};
		this.audit.record(entry, this.options.onWarning);
	}
}

/**
 * Description of what an action does, as the user sees it at a prompt: nothing is redacted, because a redacted span
 * of a command can hide the code being approved. The audit log redacts it again before writing.
 */
export function describe(action: Action): string {
	switch (action.kind) {
		case "read":
		case "write":
			return `${action.kind} ${show(action.path.real, MAX_DETAIL_CHARS)}`;
		case "exec":
			return `run ${show(action.command, MAX_DETAIL_CHARS)}`;
		case "extension":
			return `call tool ${show(action.toolName, 100)}`;
		case "unsupported":
			return `${show(action.toolName, 100)}: ${show(action.reason, MAX_DETAIL_CHARS)}`;
	}
}

function promptLine({ action, verdict }: { action: Action; verdict: ActionVerdict }): string {
	return `- ${describe(action)}\n  (${verdict.reason})`;
}

/** Sanitized description of what a grant covers. */
export function describeGrantScope(scope: GrantScope): string {
	switch (scope.kind) {
		case "read":
		case "write":
			return `${scope.kind} under ${show(scope.dir, 200)}`;
		case "exec":
			return "this exact command";
		case "extension":
			return `tool ${show(scope.toolName, 100)}`;
	}
}
