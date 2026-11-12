import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.ts";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, createTestUiContext, getToolResult, type Harness } from "./harness.ts";

// Issue #1: only the selected built-in tool may receive automatic edit permission.
describe("accept-edits session integration", () => {
	const dirs: string[] = [];
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses) harness.cleanup();
		for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
		harnesses.length = 0;
		dirs.length = 0;
		vi.unstubAllEnvs();
	});
	it("trusts a clean built-in edit but asks before a subsequent dirty edit and a shell call", async () => {
		const root = mkdtempSync(join(tmpdir(), "edit-session-"));
		const agentDir = mkdtempSync(join(tmpdir(), "edit-agent-"));
		dirs.push(root, agentDir);
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		vi.stubEnv("CI", undefined);
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
		const harness = await createHarness({
			settings: { permissionMode: "accept-edits", editMode: "replace" },
			sessionManager: SessionManager.inMemory(root),
		});
		harnesses.push(harness);
		const prompts: string[] = [];
		await harness.session.bindExtensions({
			mode: "tui",
			uiContext: createTestUiContext({
				select: async (title) => {
					prompts.push(title);
					return title.startsWith("Trust automatic edits") ? "Trust edits for this session" : "Deny";
				},
			}),
		});
		const run = async (name: string, args: Parameters<typeof fauxToolCall>[1]) => {
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("go");
			return getToolResult(harness, name);
		};
		const first = await run("edit", { path: file, edits: [{ oldText: "original", newText: "changed" }] });
		expect(first.isError, JSON.stringify(first)).toBeFalsy();
		expect(readFileSync(file, "utf8")).toBe("changed\n");
		expect((await run("edit", { path: file, edits: [{ oldText: "changed", newText: "again" }] })).isError).toBe(true);
		expect((await run("bash", { command: "echo no" })).isError).toBe(true);
		expect(prompts).toHaveLength(3);
	});

	// A parallel batch aborted at a prompt must not leave the edit reservation held.
	it("frees the edit reservation when a parallel batch is aborted", async () => {
		const root = mkdtempSync(join(tmpdir(), "edit-abort-"));
		const agentDir = mkdtempSync(join(tmpdir(), "edit-abort-agent-"));
		dirs.push(root, agentDir);
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		vi.stubEnv("CI", undefined);
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
		const harness = await createHarness({
			settings: { permissionMode: "accept-edits", editMode: "replace" },
			sessionManager: SessionManager.inMemory(root),
		});
		harnesses.push(harness);
		const prompts: string[] = [];
		await harness.session.bindExtensions({
			mode: "tui",
			uiContext: createTestUiContext({
				select: async (title) => {
					prompts.push(title);
					if (title.startsWith("Trust automatic edits")) return "Trust edits for this session";
					await harness.session.abort();
					return undefined;
				},
			}),
		});
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("edit", { path: file, edits: [{ oldText: "original", newText: "changed" }] }),
					fauxToolCall("bash", { command: "echo no" }),
				],
				{ stopReason: "toolUse" },
			),
		]);
		await harness.session.prompt("go");
		expect(readFileSync(file, "utf8")).toBe("original\n");
		harness.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("edit", { path: file, edits: [{ oldText: "original", newText: "changed" }] })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("again");
		expect(readFileSync(file, "utf8")).toBe("changed\n");
	});

	// A built-in edit another tool starts through ctx.executeTool follows the same rules as a direct one.
	it("applies the same rules to a nested built-in edit", async () => {
		const root = mkdtempSync(join(tmpdir(), "edit-nested-"));
		const agentDir = mkdtempSync(join(tmpdir(), "edit-nested-agent-"));
		dirs.push(root, agentDir);
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		vi.stubEnv("CI", undefined);
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
		const harness = await createHarness({
			settings: { permissionMode: "accept-edits", editMode: "replace" },
			sessionManager: SessionManager.inMemory(root),
			extensionFactories: [
				(pi: ExtensionAPI) => {
					pi.registerTool({
						name: "outer",
						label: "outer",
						description: "Edits a file.",
						parameters: Type.Object({}),
						execute: async (_id, _params, _signal, _update, ctx) => {
							const outcome = await ctx.executeTool("edit", {
								path: file,
								edits: [{ oldText: "original", newText: "changed" }],
							});
							return { content: outcome.result.content, details: {}, isError: outcome.isError };
						},
					});
				},
			],
		});
		harnesses.push(harness);
		const prompts: string[] = [];
		await harness.session.bindExtensions({
			mode: "tui",
			uiContext: createTestUiContext({
				select: async (title) => {
					prompts.push(title);
					return title.startsWith("Trust automatic edits") ? "Trust edits for this session" : "Allow once";
				},
			}),
		});
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("outer", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		expect(readFileSync(file, "utf8")).toBe("changed\n");
		expect(prompts).toHaveLength(2);
		expect(harness.session.permissions.editTrustActive).toBe(true);
	});
});
