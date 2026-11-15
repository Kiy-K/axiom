// Session-end step of sandbox mode: apply the guest's workspace changes to the host, asking once for risky ones.

import type { Workspace } from "./workspace.ts";
import { applyWriteBack, type PlannedChange, planWriteBack, saveUnapplied } from "./writeback.ts";

/** The part of the UI this step needs; undefined means nobody can be asked. */
export interface ReviewPrompter {
	select(title: string, options: string[]): Promise<string | undefined>;
}

const APPLY = "Apply these changes to the project";
const KEEP = "Do not apply (save a copy)";

/**
 * Applies ordinary edits, asks once about the risky ones, never applies conflicts, and saves every change it did not apply
 * under `savedDirectory`. Returns lines describing what happened; empty when the guest changed nothing.
 */
export async function finishSandbox(
	workspace: Workspace,
	prompter: ReviewPrompter | undefined,
	savedDirectory: string,
): Promise<string[]> {
	const plan = await planWriteBack(workspace);
	const lines: string[] = [];
	const unapplied: PlannedChange[] = [...plan.conflicts];

	const silent = await applyWriteBack(workspace, plan.silent);
	if (silent.applied.length) lines.push(`Sandbox: applied ${silent.applied.length} change(s) to the project.`);
	unapplied.push(...plan.silent.filter((c) => silent.failed.some((f) => f.path === c.path)));
	for (const failure of silent.failed) lines.push(`Sandbox: could not apply ${failure.path}: ${failure.error}`);

	if (plan.review.length) {
		const title = `The sandbox changed files that need your review:\n${plan.review.map((c) => `  ${c.action} ${c.path} (${c.reason})`).join("\n")}`;
		const choice = await prompter?.select(title, [APPLY, KEEP]);
		if (choice === APPLY) {
			const reviewed = await applyWriteBack(workspace, plan.review);
			lines.push(`Sandbox: applied ${reviewed.applied.length} reviewed change(s).`);
			for (const failure of reviewed.failed)
				lines.push(`Sandbox: could not apply ${failure.path}: ${failure.error}`);
			unapplied.push(...plan.review.filter((c) => reviewed.failed.some((f) => f.path === c.path)));
		} else {
			unapplied.push(...plan.review);
		}
	}
	for (const conflict of plan.conflicts) {
		lines.push(
			`Sandbox: ${conflict.path} changed on the host during the session; the guest's version was not applied.`,
		);
	}
	if (unapplied.length) {
		await saveUnapplied(workspace, unapplied, savedDirectory);
		lines.push(`Sandbox: ${unapplied.length} change(s) were not applied; copies are in ${savedDirectory}.`);
	}
	return lines;
}
