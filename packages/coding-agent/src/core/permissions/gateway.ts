// The permission gateway: one decision point every tool call passes before it executes.

import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getShellEnv } from "../../utils/shell.ts";
import type { EditMode } from "../settings-manager.ts";
import { MAX_HASHLINE_BYTES } from "../tools/hashline.ts";
import { type AuditEntry, AuditLog, type DecisionSource } from "./audit.ts";
import { autoVerdict, hardClass, impliedActions } from "./auto-classes.ts";
import { EditCheckpoints } from "./checkpoints.ts";
import { editLeavesContent } from "./edit-content.ts";
import { type EditLease, openEditLease } from "./edit-lease.ts";
import { GRANT_TTL_MS, GrantStore } from "./grants.ts";
import { classifyPath } from "./paths.ts";
import { actionsForToolCall, execAction, judgeAction, MAX_COMMAND_CHARS } from "./policy.ts";
import { sanitizeForDisplay as sanitize, sanitizeForPrompt as show } from "./redact.ts";
import { isReadonlyShell } from "./shell-grammar.ts";
import { runsNetworkCommand, untrustedSource } from "./taint.ts";
import {
	type Action,
	type ActionVerdict,
	type Decision,
	type GrantScope,
	PERMISSION_MODES_STRICTEST_FIRST,
	type PermissionMode,
} from "./types.ts";

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
	/** Only a fresh interactive TUI session can request edit trust, and only there does `auto` act as `auto`. */
	canRequestEditTrust?: () => boolean;
	/** True when `shellCommandPrefix` or `shellPath` is set: a prefix can make any command run code, so `readonly-shell` is off. */
	shellIsCustomized?: () => boolean;
	/** Where decisions are appended as JSONL. Omit to keep them in memory only. */
	auditFile?: string;
	/** Directory of pre-edit copies. Without it no edit is trusted: an edit is allowed only once its copy is kept. */
	checkpointRoot?: string;
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
	/** Set only when the session selected its own built-in edit tool; names the schema that tool validates. */
	builtinEdit?: EditMode;
	parentToolCallId?: string;
	input: Record<string, unknown>;
}

/** A prompt that nobody answers within this time is a denial. */
export const PROMPT_TIMEOUT_MS = 2 * 60 * 1000;

/**
 * Approval prompts one task may show after untrusted content entered it, in a mode that relaxes prompts. Later ones
 * are denied without asking: an injected agent that keeps asking would otherwise wear the user down (a deterministic
 * budget of 1 to 2 gave the best result in the study cited in the P6 contract; 3 leaves room for a legitimate step).
 */
export const TAINT_ASK_BUDGET = 3;

const ALLOW_ONCE = "Allow once";
/** Rule ids named in the audit entry of an automatic allow in `auto`. */
const EDIT_RULE = "trusted-recoverable-edit";
const SHELL_RULE = "readonly-shell";
const DENY = "Deny";
/** Long enough for any command the policy lets through, so a prompt or log entry never hides part of one. */
const MAX_DETAIL_CHARS = MAX_COMMAND_CHARS;

/** Longest extension path shown in a prompt or written to the log. */
const MAX_CALLER_CHARS = 120;

/** One line, so a command with newlines cannot fake extra lines in a prompt or log entry. */
function clean(text: string, maxLength: number): string {
	return sanitize(text, maxLength).replace(/\s*\n\s*/g, " | ");
}

/** Position in {@link PERMISSION_MODES_STRICTEST_FIRST}: a larger rank is a looser mode. */
export function modeRank(mode: PermissionMode): number {
	return PERMISSION_MODES_STRICTEST_FIRST.indexOf(mode);
}

export class PermissionGateway {
	readonly grants = new GrantStore();
	readonly audit: AuditLog;
	private readonly options: PermissionGatewayOptions;
	private editTrust?: { workspace: string; sessionId: string; accepted: boolean };
	private editReservation?: { id: string; input: Record<string, unknown>; lease?: EditLease };
	private modeOverride?: PermissionMode;
	private lastMode?: PermissionMode;
	/** Counts effective-mode changes, so a prompt can tell that the mode changed while it was open. */
	private modeGeneration = 0;
	/** True between `beginTask` and `endTask`: a run the user started. */
	private taskActive = false;
	/** The first untrusted source of this task, until the user's next prompt. */
	private taint?: string;
	private taintAsks = 0;
	/** Set by the first network command of the session and kept across tasks: a job it started may print later. */
	private networkCommandSeen = false;
	/** Allowed calls whose result is untrusted content, by call id, until the call finishes. */
	private readonly pendingUntrusted = new Map<string, string>();
	// Started and not yet ended calls per id: a provider may reuse an id, and the first end must not free the other call.
	private readonly running = new Map<string, number>();

	readonly checkpoints: EditCheckpoints;

	constructor(options: PermissionGatewayOptions) {
		this.options = options;
		this.audit = new AuditLog(options.auditFile);
		this.checkpoints = new EditCheckpoints(options.checkpointRoot, options.getSessionId);
	}

	/**
	 * The effective mode: the session override, else the setting. `auto` is literally `manual` outside an interactive
	 * TUI session. Every read notices a change of the effective mode and then drops all grants and edit trust, so
	 * nothing granted under one mode outlives it.
	 */
	get mode(): PermissionMode {
		const requested = this.modeOverride ?? this.options.getMode();
		const mode = requested === "auto" && !this.options.canRequestEditTrust?.() ? "manual" : requested;
		if (this.lastMode !== undefined && mode !== this.lastMode) {
			this.grants.clear();
			this.editTrust = undefined;
			this.modeGeneration++;
		}
		this.lastMode = mode;
		return mode;
	}

	/** The session override, if any. */
	get override(): PermissionMode | undefined {
		return this.modeOverride;
	}

	/** Set or clear the session override. Callers: the TUI's `/mode` command and session replacement. */
	setModeOverride(mode: PermissionMode | undefined): void {
		this.modeOverride = mode;
		this.syncMode();
	}

	/** Notice a change of the effective mode now, even when no call is being decided. */
	syncMode(): void {
		void this.mode;
	}

	/** The override if it is stricter than the setting: the only kind a replacement session inherits. */
	tighteningOverride(): PermissionMode | undefined {
		return this.modeOverride !== undefined && modeRank(this.modeOverride) < modeRank(this.options.getMode())
			? this.modeOverride
			: undefined;
	}

	/** After settings reload: drop an override that is no longer stricter than the setting. */
	onSettingsReloaded(): void {
		if (this.modeOverride !== undefined && modeRank(this.modeOverride) >= modeRank(this.options.getMode()))
			this.modeOverride = undefined;
		this.syncMode();
	}

	/** A run the user started begins. Extension-started runs do not call this and get no grants in `auto`. */
	beginTask(): void {
		this.taskActive = true;
		this.taint = undefined;
		this.taintAsks = 0;
	}

	/** The run settled or was aborted. In `auto`, grants end with the task. */
	endTask(): void {
		this.taskActive = false;
		if (this.mode === "auto") this.grants.clear();
	}

	/** Why prompts are tighter right now: untrusted content entered this task in a mode that relaxes prompts. */
	get untrustedSource(): string | undefined {
		const mode = this.mode;
		return mode === "accept-edits" || mode === "auto" ? this.taint : undefined;
	}

	get editTrustActive(): boolean {
		if (
			this.editTrust &&
			(this.editTrust.sessionId !== this.options.getSessionId() ||
				this.editTrust.workspace !== resolve(this.options.getCwd()))
		)
			this.editTrust = undefined;
		return (
			(this.mode === "accept-edits" || this.mode === "auto") &&
			this.editTrust?.accepted === true &&
			!!this.options.canRequestEditTrust?.()
		);
	}

	revokeEditTrust(): void {
		this.editTrust = undefined;
	}

	/**
	 * Decide a tool call. Returns undefined to let it run, or a block. Call it after every hook that may change the
	 * input has run: it judges exactly what the tool will execute. Any failure here blocks the call.
	 */
	async authorize(call: ToolCallRequest, signal?: AbortSignal): Promise<PermissionBlock | undefined> {
		if (this.mode === "yolo") return undefined;
		try {
			const actions = actionsForToolCall(call.toolName, call.input, this.options.getCwd());
			if (await this.tryAcceptEdit(call, actions, signal)) return undefined;
			const block = await this.decide(call, actions, signal);
			if (!block) {
				this.expectUntrustedResult(call, actions);
				await this.keepCopyOfApprovedWrite(call, actions);
			}
			return block;
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
		if (this.mode === "yolo") return undefined;
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
		if (this.mode === "yolo") return;
		const action = execAction(command);
		this.record({ toolName: "user-bash", toolCallId: "" }, "allow", "user-command", describe(action));
	}

	private blockOnError(call: CallLabel, error: unknown): PermissionBlock {
		const reason = `Permission check failed: ${error instanceof Error ? error.message : String(error)}`;
		this.record(call, "deny", "error", reason);
		return { block: true, reason: clean(reason, MAX_DETAIL_CHARS) };
	}

	/** Count a started tool call, so the reservation outlives an earlier call that shares its id. */
	startToolCall(id: string): void {
		this.running.set(id, (this.running.get(id) ?? 0) + 1);
	}

	/** Drop the reservation of the last call with this id that ended, even one aborted in a parallel batch. */
	endToolCall(id: string): void {
		this.pendingUntrusted.delete(id);
		const remaining = (this.running.get(id) ?? 1) - 1;
		if (remaining > 0) this.running.set(id, remaining);
		else {
			this.running.delete(id);
			if (this.editReservation?.id === id) {
				void this.editReservation.lease?.close().catch(() => {});
				this.editReservation = undefined;
			}
		}
	}

	/** Release a reservation only for the completed call and its validated argument object. */
	finishToolCall(id: string, input: unknown): void {
		const source = this.pendingUntrusted.get(id);
		if (source !== undefined) {
			this.pendingUntrusted.delete(id);
			this.taint ??= source;
		}
		if (this.editReservation?.id === id && this.editReservation.input === input) {
			void this.editReservation.lease?.close().catch(() => {});
			this.editReservation = undefined;
		}
	}

	/** The descriptor reserved for this automatic edit, if this call has one. */
	editLease(id: string, target: string, input: unknown): EditLease | undefined {
		const reservation = this.editReservation;
		if (!reservation || reservation.id !== id) return undefined;
		if (!reservation.lease || reservation.lease.target !== target || reservation.input !== input) {
			throw new Error("Automatic edit target or arguments changed.");
		}
		return reservation.lease;
	}

	private async tryAcceptEdit(call: ToolCallRequest, actions: Action[], signal?: AbortSignal): Promise<boolean> {
		const mode = this.mode;
		if ((mode !== "accept-edits" && mode !== "auto") || !call.builtinEdit || call.toolName !== "edit") return false;
		if (this.editReservation) return false;
		if (!this.options.canRequestEditTrust?.() || typeof call.input.path !== "string") return false;
		// Untrusted content entered this task: a planted edit is what an injection wants, so every edit asks.
		if (this.untrustedSource !== undefined) return false;
		const generation = this.modeGeneration;
		const workspace = resolve(this.options.getCwd());
		const sessionId = this.options.getSessionId();
		const target = resolve(workspace, call.input.path);
		const action = actions[0];
		if (
			actions.length !== 1 ||
			action.kind !== "write" ||
			!action.path.inWorkspace ||
			action.path.protected ||
			action.path.secret ||
			action.path.runsCode ||
			// Credentials and code-running files are excluded above; this also keeps persistence paths a hard class.
			hardClass(action) !== undefined ||
			action.path.real !== target
		)
			return false;
		const reservation = { id: call.toolCallId, input: call.input, lease: undefined as EditLease | undefined };
		this.editReservation = reservation;
		let accepted = false;
		try {
			const lease = await openEditLease(workspace, target);
			if (!lease) return false;
			if (this.editReservation !== reservation) {
				await lease.close();
				return false;
			}
			reservation.lease = lease;
			const original = lease.original;
			if (!editLeavesContent(original, call.builtinEdit, call.input)) return false;
			if (!this.editTrustActive) {
				if (this.editTrust?.accepted === false) return false;
				const prompter = this.options.getPrompter();
				if (!prompter) return false;
				const choice = await this.ask(
					prompter,
					`Trust automatic edits in ${show(workspace, MAX_DETAIL_CHARS)} for this session?\nA copy of each file is kept before an automatic edit changes it; /restore puts one back.`,
					["Trust edits for this session", "Not now"],
					signal,
				);
				if (this.options.getSessionId() !== sessionId || resolve(this.options.getCwd()) !== workspace) return false;
				// A mode that left and came back during the prompt cleared trust; the answer must not set it again.
				this.syncMode();
				if (this.modeGeneration !== generation) return false;
				if (choice === "Not now") this.editTrust = { workspace, sessionId, accepted: false };
				if (choice !== "Trust edits for this session") return false;
				this.editTrust = { workspace, sessionId, accepted: true };
				// The user may leave the prompt open while the workspace changes.
				await lease.assertUnchanged();
			}
			if (
				signal?.aborted ||
				this.mode !== mode ||
				this.modeGeneration !== generation ||
				resolve(this.options.getCwd()) !== workspace ||
				this.options.getSessionId() !== sessionId ||
				!this.options.canRequestEditTrust?.() ||
				this.untrustedSource !== undefined
			)
				return false;
			// The copy is made from the bytes the edit was just validated against, and the edit waits for it.
			const kept = await this.checkpoints.save(target, original);
			await lease.assertUnchanged();
			if (
				!kept ||
				signal?.aborted ||
				this.mode !== mode ||
				this.modeGeneration !== generation ||
				resolve(this.options.getCwd()) !== workspace ||
				this.options.getSessionId() !== sessionId ||
				!this.options.canRequestEditTrust?.() ||
				this.untrustedSource !== undefined
			)
				return false;
			const detail = `${describe(action)}: trusted edit, copy ${kept.id} kept`;
			if (mode === "auto") this.record(call, "allow", "auto", `${EDIT_RULE}: ${detail}`);
			else this.record(call, "allow", "accept-edits", detail);
			accepted = true;
			return true;
		} catch {
			return false;
		} finally {
			if (!accepted) this.finishToolCall(call.toolCallId, call.input);
		}
	}

	private async decide(
		call: CallLabel,
		requested: Action[],
		signal: AbortSignal | undefined,
	): Promise<PermissionBlock | undefined> {
		// In `auto` the writes a shell line implies join the call, and a hard class is never covered by a grant: the
		// verdict has no grant to offer, so none is consulted. Only `auto` does this, and it only ever tightens.
		const auto = this.mode === "auto";
		const actions = auto ? [...requested, ...impliedActions(requested, this.options.getCwd())] : requested;
		const verdicts = actions.map((action) => {
			const base = auto ? autoVerdict(action, judgeAction(action)) : judgeAction(action);
			const rule =
				auto && base.decision === "ask" && this.isReadonlyShellCall(call, action) ? SHELL_RULE : undefined;
			const verdict: ActionVerdict = rule ? { decision: "allow", reason: rule } : base;
			return { action, verdict, rule };
		});
		const summary = actions.map(describe).join("; ") || "no direct effect";

		const denied = verdicts.find((entry) => entry.verdict.decision === "deny");
		if (denied) {
			this.record(call, "deny", "policy", `${describe(denied.action)}: ${denied.verdict.reason}`);
			return { block: true, reason: `Blocked by permission policy: ${denied.verdict.reason}.` };
		}

		const untrusted = this.untrustedSource;
		const pending = verdicts.filter(
			(entry) => entry.verdict.decision === "ask" && !(entry.verdict.grantable && this.findGrant(entry.action)),
		);
		if (pending.length === 0) {
			const grant = verdicts.map((entry) => this.findGrant(entry.action)).find((found) => found !== undefined);
			const rules = verdicts.flatMap((entry) => (entry.rule ? [entry.rule] : []));
			if (grant) this.record(call, "allow", "grant", summary, grant.id);
			else if (rules.length > 0) this.record(call, "allow", "auto", `${rules.join(", ")}: ${summary}`);
			else this.record(call, "allow", "policy", summary);
			return undefined;
		}

		const prompter = this.options.getPrompter();
		if (!prompter) {
			this.record(call, "deny", "no-ui", summary);
			return { block: true, reason: "Blocked: this action needs approval and no user interface is available." };
		}

		// Only the model's own calls spend the budget: an extension's `pi.exec`, an MCP server start or a provider
		// credential command (they carry a `caller`) must not fail a model request because the model asked three times.
		if (untrusted !== undefined && call.caller === undefined && ++this.taintAsks > TAINT_ASK_BUDGET) {
			this.record(call, "deny", "taint-budget", summary);
			return {
				block: true,
				reason: `Blocked: untrusted content (${untrusted}) entered this task and the approval budget is spent. Stop and ask the user to continue in a new message.`,
			};
		}

		const grantable = pending.map((entry) => entry.verdict.grantable);
		// In `auto`, only a run the user started can offer a grant; it ends with the task. After untrusted content
		// entered the task, none is offered at all (see `findGrant`).
		const mayGrant = (this.mode !== "auto" || this.taskActive) && untrusted === undefined;
		const grantScopes =
			mayGrant && grantable.every((scope) => scope !== undefined) ? (grantable as GrantScope[]) : undefined;
		const grantLabel = grantScopes
			? `Allow for ${GRANT_TTL_MS / 60000} minutes: ${grantScopes.map(describeGrantScope).join(", ")}`
			: undefined;
		const choices = [ALLOW_ONCE, ...(grantLabel ? [grantLabel] : []), DENY];
		const asker = call.caller === undefined ? "" : `\nExtension: ${showTail(call.caller, MAX_CALLER_CHARS)}`;
		const taintNote = untrusted === undefined ? "" : `\nUntrusted content entered this task: ${untrusted}.`;
		const title = `Permission needed: ${show(call.toolName, 100)}${asker}${taintNote}\n${pending.map(promptLine).join("\n")}`;

		const generation = this.modeGeneration;
		const choice = await this.ask(prompter, title, choices, signal);
		this.syncMode();
		if (this.modeGeneration !== generation) {
			this.record(call, "deny", "mode-change", summary);
			return { block: true, reason: "Blocked: the permission mode changed while the prompt was open." };
		}
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
	 * The `readonly-shell` rule: only the model's own `bash` tool, never `job send_input` (stdin goes to any process) or
	 * `pi.exec`; never a hard class; never with a shell prefix or path from settings; not on Windows, whose shells
	 * this grammar was not checked against.
	 */
	private isReadonlyShellCall(call: CallLabel, action: Action): boolean {
		return (
			action.kind === "exec" &&
			call.toolName === "bash" &&
			call.caller === undefined &&
			process.platform !== "win32" &&
			!this.options.shellIsCustomized?.() &&
			hardClass(action) === undefined &&
			isReadonlyShell(action.command, this.options.getCwd(), getShellEnv())
		);
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

	/** A live grant covering `action`. None once untrusted content entered the task: every ask then needs an answer. */
	private findGrant(action: Action) {
		return this.untrustedSource === undefined ? this.grants.find(action) : undefined;
	}

	/**
	 * Keep a copy of a file an `edit` or `write` the user approved is about to change, so `/restore` covers it too. Best
	 * effort: the user already consented, so a failed copy never blocks. Credentials are not copied into the store.
	 * Only in the modes that relax prompts, where an edit can be the one a prompt-injected agent asked for.
	 */
	private async keepCopyOfApprovedWrite(call: ToolCallRequest, actions: Action[]): Promise<void> {
		const mode = this.mode;
		if ((mode !== "accept-edits" && mode !== "auto") || (call.toolName !== "edit" && call.toolName !== "write"))
			return;
		for (const action of actions) {
			if (action.kind !== "write" || !action.path.inWorkspace || action.path.protected || action.path.secret)
				continue;
			try {
				const bytes = await readEditableFile(action.path.real);
				if (bytes) await this.checkpoints.save(action.path.real, bytes);
			} catch {
				// A file that does not exist yet (a new `write`) or cannot be read has nothing to keep.
			}
		}
	}

	/** Note that an allowed call's result is untrusted content; it taints the task when the call finishes. */
	private expectUntrustedResult(call: ToolCallRequest, actions: Action[]): void {
		const source = untrustedSource(call.toolName, call.input, actions, this.networkCommandSeen);
		if (runsNetworkCommand(actions)) this.networkCommandSeen = true;
		if (source !== undefined) this.pendingUntrusted.set(call.toolCallId, source);
	}

	/**
	 * Put a pre-edit copy back (the user's `/restore`). Only a plain file inside the workspace that edits may
	 * change: not protected, not credentials, not a file that runs code. The file as it is now is kept first.
	 */
	async restoreCheckpoint(id: number): Promise<string> {
		// A running edit read its file before this restore, and replace mode would write over the restored bytes.
		if (this.running.size > 0) throw new Error("A tool call is running; restore when it finishes.");
		const cwd = this.options.getCwd();
		const restored = await this.checkpoints.restore(id, (target) => {
			const resolved = classifyPath(target, cwd);
			return (
				resolved !== undefined &&
				resolved.real === target &&
				resolved.inWorkspace &&
				!resolved.protected &&
				!resolved.secret &&
				!resolved.runsCode
			);
		});
		this.record({ toolName: "restore", toolCallId: "" }, "allow", "user-command", `restored copy ${id}: ${restored}`);
		return restored;
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
		case "undetermined":
			return show(action.reason, MAX_DETAIL_CHARS);
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

/** The bytes of a plain, singly linked file small enough to edit, or undefined when it is anything else. */
async function readEditableFile(path: string): Promise<Buffer | undefined> {
	const info = await lstat(path);
	if (!info.isFile() || info.nlink !== 1 || info.size > MAX_HASHLINE_BYTES) return undefined;
	return readFile(path);
}
