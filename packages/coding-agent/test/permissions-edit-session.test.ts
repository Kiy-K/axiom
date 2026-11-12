import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { PermissionGateway } from "../src/core/permissions/gateway.ts";

// Issue #1: resuming or forking through the same agent must not inherit edit trust.
it("does not carry edit trust into a different session", async () => {
	const root = mkdtempSync(join(tmpdir(), "edit-session-id-"));
	try {
		execFileSync("git", ["init", "-q", root]);
		writeFileSync(join(root, "file.txt"), "original\n");
		execFileSync("git", ["-C", root, "add", "file.txt"]);
		execFileSync("git", [
			"-C",
			root,
			"-c",
			"user.name=Test",
			"-c",
			"user.email=test@example.invalid",
			"commit",
			"-qm",
			"initial",
		]);
		let sessionId = "first";
		let answer = "Trust edits for this session";
		const gateway = new PermissionGateway({
			getMode: () => "accept-edits",
			getCwd: () => root,
			getSessionId: () => sessionId,
			canRequestEditTrust: () => true,
			getPrompter: () => ({ select: async () => answer }),
		});
		const input = { path: "file.txt", edits: [{ oldText: "original", newText: "changed" }] };
		expect(
			await gateway.authorize({ toolName: "edit", toolCallId: "first", builtinEdit: "replace", input }),
		).toBeUndefined();
		expect(gateway.editTrustActive).toBe(true);
		gateway.finishToolCall("first", input);
		sessionId = "second";
		expect(gateway.editTrustActive).toBe(false);
		answer = "Deny";
		expect(
			(await gateway.authorize({ toolName: "edit", toolCallId: "second", builtinEdit: "replace", input }))?.block,
		).toBe(true);
		// Resuming the first session id again must not revive the discarded trust.
		sessionId = "first";
		expect(gateway.editTrustActive).toBe(false);
		gateway.revokeEditTrust();
		expect(gateway.editTrustActive).toBe(false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
