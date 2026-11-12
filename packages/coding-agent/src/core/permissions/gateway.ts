// The permission gateway: one decision point every tool call passes before it executes.

import { resolve } from "node:path";
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

/** Where and for whom an extension's `pi.exec` runs. */
export interface ExecRequest {
	/** Directory the command runs in. */
	cwd: string;
	/** Path of the extension that calls `pi.exec`, shown in the prompt and written to the audit entry. */
	extensionPath: string;
	signal?: AbortSignal;
}

/** What identifies a call in prompts and audit entries. */
type CallLabel = Pick<ToolCallRequest, "toolName" | "toolCallId" | "parentToolCallId"> & {
	/** Path of the extension that makes the call itself. */
	caller?: string;
};

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

/** Longest extension path shown in a prompt or written to the log. */
const MAX_CALLER_CHARS = 120;

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
			return await this.decide(call, actionsForToolCall(call.toolName, call.input, this.options.getCwd()), signal);
		} catch (error) {
			return this.blockOnError(call, error);
		}
	}

	/**
	 * Decide a command an extension runs with `pi.exec`. It is judged as the shell line it amounts to (preceded by
	 * `cd <dir> &&` when it runs outside the session directory), so it has the same rules and grants as a model `bash`
	 * call. The prompt and the audit entry name the extension that asks.
	 */
	async authorizeExec(command: string, args: string[], request: ExecRequest): Promise<PermissionBlock | undefined> {
		if (this.mode === "unrestricted") return undefined;
		const call = { toolName: "pi.exec", toolCallId: "", caller: request.extensionPath };
		try {
			const line = shellLine(command, args);
			// spawn resolves a relative cwd against the process directory, so the judged line does the same.
			const dir = resolve(request.cwd);
			const shell = dir === resolve(this.options.getCwd()) ? line : `${shellLine("cd", [dir])} && ${line}`;
			return await this.decide(call, [execAction(shell)], request.signal);
		} catch (error) {
			return this.blockOnError(call, error);
		}
	}

	/** Record shell the user typed themselves (`!cmd`). Typing it is the consent, so it is never blocked. */
	recordUserCommand(command: string): void {
		if (this.mode === "unrestricted") return;
		const action = execAction(command);
		this.record({ toolName: "user-bash", toolCallId: "" }, "allow", "user-command", describe(action));
	}

	private blockOnError(call: CallLabel, error: unknown): PermissionBlock {
		const reason = `Permission check failed: ${error instanceof Error ? error.message : String(error)}`;
		this.record(call, "deny", "error", reason);
		return { block: true, reason: clean(reason, MAX_DETAIL_CHARS) };
	}

	private async decide(
		call: CallLabel,
		actions: Action[],
		signal: AbortSignal | undefined,
	): Promise<PermissionBlock | undefined> {
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
		const asker = call.caller === undefined ? "" : `\nExtension: ${showTail(call.caller, MAX_CALLER_CHARS)}`;
		const title = `Permission needed: ${show(call.toolName, 100)}${asker}\n${pending.map(promptLine).join("\n")}`;

		const choice = await this.ask(prompter, title, choices, signal);
		if (choice === undefined) {
			this.record(call, "deny", "timeout", summary);
			return {
				block: true,
				reason:
					"Blocked: the approval prompt was dismissed or expired. This is not a transient error; do not retry.",
			};
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

	private record(call: CallLabel, decision: Decision, source: DecisionSource, detail: string, grantId?: string): void {
		const entry: AuditEntry = {
			time: Date.now(),
			sessionId: this.options.getSessionId(),
			toolName: clean(call.toolName, 200),
			...(call.caller === undefined ? {} : { caller: clean(call.caller, MAX_DETAIL_CHARS) }),
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

/** Sanitized text cut from the front, so the end of a path (the file that tells extensions apart) stays visible. */
function showTail(text: string, maxLength: number): string {
	const line = show(text, 4 * maxLength);
	return line.length <= maxLength ? line : `...${line.slice(-(maxLength - 3))}`;
}

/** The command and arguments as one shell line, quoted so the policy reads each argument as one word. */
function shellLine(command: string, args: string[]): string {
	return [command, ...args]
		.map((word) => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`))
		.join(" ");
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
