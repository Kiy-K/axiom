import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.ts";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { createHarness, createTestUiContext, getMessageText, getToolResult, type Harness } from "./harness.ts";

describe("AgentSession permission gateway", () => {
	const harnesses: Harness[] = [];
	let agentDir: string;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "perm-session-"));
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
	});

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		rmSync(agentDir, { recursive: true, force: true });
	});

	async function start(options: Parameters<typeof createHarness>[0] = {}) {
		const harness = await createHarness({ settings: { permissionMode: "manual" }, ...options });
		harnesses.push(harness);
		return harness;
	}

	const callBash = (command: string) => [
		fauxAssistantMessage([fauxToolCall("bash", { command })], { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	];

	it("blocks a model shell call that needs approval when there is no user interface", async () => {
		const harness = await start();
		harness.setResponses(callBash("echo should-not-run"));
		await harness.session.prompt("go");
		const result = getToolResult(harness, "bash");
		expect(result.isError).toBe(true);
		expect(getMessageText(result)).toContain("no user interface");
		expect(getMessageText(result)).not.toContain("should-not-run\n");
		expect(harness.session.listJobs()).toEqual([]);
	});

	it("runs the call once the user allows it, and blocks it when the user denies", async () => {
		const prompts: string[] = [];
		let answer = "Allow once";
		const harness = await start();
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({
				select: async (title) => {
					prompts.push(title);
					return answer;
				},
			}),
		});

		harness.setResponses(callBash("echo hello-allowed"));
		await harness.session.prompt("go");
		expect(getToolResult(harness, "bash").isError).toBeFalsy();
		expect(getMessageText(getToolResult(harness, "bash"))).toContain("hello-allowed");

		answer = "Deny";
		harness.setResponses(callBash("echo hello-denied"));
		await harness.session.prompt("again");
		const denied = getToolResult(harness, "bash");
		expect(denied.isError).toBe(true);
		expect(getMessageText(denied)).toContain("user denied");
		expect(prompts).toHaveLength(2);
	});

	it("judges the input an extension handler rewrote, not the one the model sent", async () => {
		const prompts: string[] = [];
		const harness = await start({
			extensionFactories: [
				(pi: ExtensionAPI) => {
					pi.on("tool_call", (event) => {
						if (event.toolName === "bash") event.input.command = "sudo whoami";
					});
				},
			],
		});
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({
				select: async (title) => {
					prompts.push(title);
					return "Allow once";
				},
			}),
		});
		harness.setResponses(callBash("echo innocent"));
		await harness.session.prompt("go");
		expect(getMessageText(getToolResult(harness, "bash"))).toContain("raises privileges");
		expect(prompts).toEqual([]);
	});

	it("denies a write to a protected path without asking", async () => {
		const prompts: string[] = [];
		const harness = await start();
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({
				select: async (title) => {
					prompts.push(title);
					return "Allow once";
				},
			}),
		});
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: ".git/hooks/pre-commit", content: "x" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		expect(getMessageText(getToolResult(harness, "write"))).toContain("protected path");
		expect(prompts).toEqual([]);
	});

	it("gates a call another tool makes through ctx.executeTool", async () => {
		const harness = await start({
			extensionFactories: [
				(pi: ExtensionAPI) => {
					pi.registerTool({
						name: "outer",
						label: "outer",
						description: "Calls bash.",
						parameters: Type.Object({}),
						execute: async (_id, _params, _signal, _update, ctx) => {
							const outcome = await ctx.executeTool("bash", { command: "echo nested-ran" });
							return { content: outcome.result.content, details: {}, isError: outcome.isError };
						},
					});
				},
			],
		});
		// `outer` is an extension tool, so the user is asked once for it and once for the nested bash call.
		const prompts: string[] = [];
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({
				select: async (title) => {
					prompts.push(title);
					return title.includes("outer") ? "Allow once" : "Deny";
				},
			}),
		});
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("outer", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		expect(prompts).toHaveLength(2);
		expect(prompts[1]).toContain("Permission needed: bash");
		expect(getMessageText(getToolResult(harness, "outer"))).not.toContain("nested-ran");
	});

	it("leaves behavior unchanged in the default mode", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses(callBash("echo default-mode"));
		await harness.session.prompt("go");
		expect(getMessageText(getToolResult(harness, "bash"))).toContain("default-mode");
	});
});
