import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.ts";
import { createHarness, createTestUiContext, type Harness } from "./harness.ts";

describe("AgentSession auto mode plumbing", () => {
	const harnesses: Harness[] = [];
	let agentDir: string;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "auto-session-"));
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		vi.stubEnv("CI", undefined);
	});

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		rmSync(agentDir, { recursive: true, force: true });
		vi.unstubAllEnvs();
	});

	/** A session whose user always picks the grant choice when one is offered, and records what was offered. */
	async function start(permissionMode: "auto" | "manual", mode: "tui" | "rpc" = "tui") {
		const harness = await createHarness({ settings: { permissionMode } });
		harnesses.push(harness);
		const offers: string[][] = [];
		await harness.session.bindExtensions({
			mode,
			uiContext: createTestUiContext({
				select: async (_title, options) => {
					offers.push(options);
					return options.find((option) => option.startsWith("Allow for")) ?? "Allow once";
				},
			}),
		});
		const runBash = async (source?: "extension") => {
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("bash", { command: "echo hi" })], { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("go", source ? { source } : undefined);
		};
		return { harness, offers, runBash };
	}

	it("offers a grant in a user-started auto run and clears it when the run settles", async () => {
		const { harness, offers, runBash } = await start("auto");
		await runBash();
		expect(offers[0]?.some((option) => option.startsWith("Allow for"))).toBe(true);
		expect(harness.session.permissions.grants.list()).toHaveLength(0);
	});

	it("offers no grant in an auto run an extension started", async () => {
		const { harness, offers, runBash } = await start("auto");
		await runBash("extension");
		expect(offers[0]?.some((option) => option.startsWith("Allow for"))).toBe(false);
		expect(harness.session.permissions.grants.list()).toHaveLength(0);
	});

	it("keeps a manual-mode grant after the run settles", async () => {
		const { harness, runBash } = await start("manual");
		await runBash();
		expect(harness.session.permissions.grants.list()).toHaveLength(1);
	});

	it("runs auto as manual outside the TUI, so grants are offered and kept as in manual", async () => {
		const { harness, offers, runBash } = await start("auto", "rpc");
		expect(harness.session.permissions.mode).toBe("manual");
		await runBash("extension");
		expect(offers[0]?.some((option) => option.startsWith("Allow for"))).toBe(true);
		expect(harness.session.permissions.grants.list()).toHaveLength(1);
	});
});
