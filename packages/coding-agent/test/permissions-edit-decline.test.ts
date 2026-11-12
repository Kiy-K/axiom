import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { PermissionGateway } from "../src/core/permissions/gateway.ts";

// Issue #1: declining session trust should not repeatedly ask for it.
it("remembers a declined trust request for the current session", async () => {
	const root = mkdtempSync(join(tmpdir(), "edit-decline-"));
	const store = mkdtempSync(join(tmpdir(), "edit-decline-store-"));
	try {
		writeFileSync(join(root, "file.txt"), "original\n");
		const prompts: string[] = [];
		const gateway = new PermissionGateway({
			getMode: () => "accept-edits",
			getCwd: () => root,
			checkpointRoot: store,
			getSessionId: () => "test",
			canRequestEditTrust: () => true,
			getPrompter: () => ({
				select: async (title) => {
					prompts.push(title);
					return title.startsWith("Trust automatic edits") ? "Not now" : "Deny";
				},
			}),
		});
		for (const id of ["one", "two"]) {
			await gateway.authorize({
				toolName: "edit",
				toolCallId: id,
				builtinEdit: "replace",
				input: { path: "file.txt", edits: [{ oldText: "original", newText: "changed" }] },
			});
		}
		expect(prompts.filter((title) => title.startsWith("Trust automatic edits"))).toHaveLength(1);
	} finally {
		rmSync(root, { recursive: true, force: true });
		rmSync(store, { recursive: true, force: true });
	}
});

// A dismissed or aborted prompt is not a decision, so trust is asked again.
it("does not remember a dismissed trust prompt", async () => {
	const root = mkdtempSync(join(tmpdir(), "edit-dismiss-"));
	const store = mkdtempSync(join(tmpdir(), "edit-dismiss-store-"));
	try {
		writeFileSync(join(root, "file.txt"), "original\n");
		let trustPrompts = 0;
		const gateway = new PermissionGateway({
			getMode: () => "accept-edits",
			getCwd: () => root,
			checkpointRoot: store,
			getSessionId: () => "test",
			canRequestEditTrust: () => true,
			promptTimeoutMs: 10,
			getPrompter: () => ({
				select: (title) => {
					if (title.startsWith("Trust automatic edits")) trustPrompts++;
					return new Promise<string | undefined>(() => {});
				},
			}),
		});
		for (const id of ["one", "two"]) {
			await gateway.authorize({
				toolName: "edit",
				toolCallId: id,
				builtinEdit: "replace",
				input: { path: "file.txt", edits: [{ oldText: "original", newText: "changed" }] },
			});
		}
		expect(trustPrompts).toBe(2);
	} finally {
		rmSync(root, { recursive: true, force: true });
		rmSync(store, { recursive: true, force: true });
	}
});
