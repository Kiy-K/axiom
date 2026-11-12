import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, createTestUiContext, getToolResult } from "./harness.ts";

// Issue #1: a UI attached to RPC or CI must not grant session edit trust.
it.each(["rpc", "ci", "print"] as const)("does not request edit trust in %s mode", async (mode) => {
	const root = mkdtempSync(join(tmpdir(), "edit-headless-"));
	const agentDir = mkdtempSync(join(tmpdir(), "edit-headless-agent-"));
	vi.stubEnv(ENV_AGENT_DIR, agentDir);
	vi.stubEnv("CI", mode === "ci" ? "true" : undefined);
	let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
	try {
		const file = join(root, "file.txt");
		execFileSync("git", ["init", "-q", root]);
		writeFileSync(file, "original\n");
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
		harness = await createHarness({
			settings: { permissionMode: "accept-edits", editMode: "replace" },
			sessionManager: SessionManager.inMemory(root),
		});
		const prompts: string[] = [];
		if (mode !== "print") {
			await harness.session.bindExtensions({
				mode: mode === "rpc" ? "rpc" : "tui",
				uiContext: createTestUiContext({
					select: async (title) => {
						prompts.push(title);
						return "Deny";
					},
				}),
			});
		}
		harness.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("edit", { path: file, edits: [{ oldText: "original", newText: "changed" }] })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		expect(getToolResult(harness, "edit").isError).toBe(true);
		expect(prompts.some((title) => title.startsWith("Trust automatic edits"))).toBe(false);
		expect(harness.session.permissions.editTrustActive).toBe(false);
	} finally {
		harness?.cleanup();
		rmSync(root, { recursive: true, force: true });
		rmSync(agentDir, { recursive: true, force: true });
		vi.unstubAllEnvs();
	}
});
