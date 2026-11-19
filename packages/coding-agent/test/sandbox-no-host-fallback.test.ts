// Sandbox mode must never run a model tool on the host when the VM failed to start.

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, type JsonObject } from "@earendil-works/pi-ai";
import type { FauxResponseStep } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { createHarness, getToolResult, type Harness } from "./suite/harness.ts";

describe("sandbox failed start refuses host execution", () => {
	const harnesses: Harness[] = [];
	let agentDir: string;

	beforeEach(() => {
		// The gateway and job supervisor write audit/checkpoint files under the agent dir:
		// keep them out of the real user dir, as every permission suite does.
		agentDir = mkdtempSync(join(tmpdir(), "sandbox-nofallback-"));
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
	});

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		rmSync(agentDir, { recursive: true, force: true });
		vi.unstubAllEnvs();
	});

	// The harness cwd is a plain temp dir, not a git work tree, so the workspace view
	// fails deterministically: no KVM, no VM, a `failed` state, on any machine.
	async function startFailedSandbox() {
		const harness = await createHarness({
			settings: { sandbox: { enabled: true }, permissionMode: "yolo", editMode: "replace" },
		});
		harnesses.push(harness);
		expect(harness.session.sandbox).toBeDefined();
		const state = await harness.session.sandbox!.ready;
		expect(state.kind).toBe("failed");
		return harness;
	}

	async function runTool(harness: Harness, name: string, args: JsonObject) {
		const steps: FauxResponseStep[] = [
			fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		];
		harness.setResponses(steps);
		await harness.session.prompt("go");
		return getToolResult(harness, name);
	}

	it("refuses every file and shell tool with the failure reason and writes nothing on the host", async () => {
		const harness = await startFailedSandbox();
		const marker = join(harness.tempDir, "host-marker");
		// A readable host file: a fallback read would return this content instead of the refusal.
		const hostFile = join(harness.tempDir, "host-file");
		writeFileSync(hostFile, "HOST-CONTENT-MUST-NOT-LEAK");
		const calls: Array<[string, JsonObject]> = [
			["bash", { command: `touch '${marker}'` }],
			["write", { path: marker, content: "host" }],
			["edit", { path: marker, edits: [{ oldText: "host", newText: "changed" }] }],
			["read", { path: hostFile }],
		];
		for (const [name, args] of calls) {
			const result = await runTool(harness, name, args);
			const text = JSON.stringify(result.content);
			expect(text, name).toContain("Sandbox not enforced");
			expect(text, name).not.toContain("HOST-CONTENT-MUST-NOT-LEAK");
			expect(result.isError, name).toBe(true);
		}
		expect(existsSync(marker)).toBe(false);
	});

	it("refuses user ! bash through the same route", async () => {
		const harness = await startFailedSandbox();
		const marker = join(harness.tempDir, "user-bash-marker");
		await expect(harness.session.executeBash(`touch '${marker}'`)).rejects.toThrow("Sandbox not enforced");
		expect(existsSync(marker)).toBe(false);
	});

	it("refuses a background job before any process starts, leaving no job handle", async () => {
		const harness = await startFailedSandbox();
		const marker = join(harness.tempDir, "job-marker");
		const result = await runTool(harness, "bash", { command: `touch '${marker}'`, background: true });
		expect(JSON.stringify(result.content)).toContain("retained process handles");
		expect(harness.session.listJobs()).toHaveLength(0);
		expect(existsSync(marker)).toBe(false);
	});
});
