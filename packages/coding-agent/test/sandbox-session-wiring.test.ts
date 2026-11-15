import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { detectSandboxSupport } from "../src/core/sandbox/detect.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("sandbox setting wiring", { timeout: 180_000 }, () => {
	let dir: string;
	let agentDir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-sandbox-wiring-"));
		agentDir = join(dir, "agent");
		mkdirSync(agentDir);
		writeFileSync(join(dir, "a.txt"), "hello");
		execFileSync("git", ["init", "-q"], { cwd: dir });
		execFileSync("git", ["add", "-A"], { cwd: dir });
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	async function create(sandbox: boolean) {
		const settingsManager = SettingsManager.inMemory({ sandbox: { enabled: sandbox } });
		const resourceLoader = new DefaultResourceLoader({ cwd: dir, agentDir, settingsManager });
		await resourceLoader.reload();
		return (
			await createAgentSession({
				cwd: dir,
				agentDir,
				model: getModel("anthropic", "claude-sonnet-4-5")!,
				settingsManager,
				sessionManager: SessionManager.inMemory(dir),
				resourceLoader,
			})
		).session;
	}

	it("is off by default and starts no VM", async () => {
		const session = await create(false);
		expect(session.sandbox).toBeUndefined();
		expect(session.getAllTools().map((t) => t.name)).toContain("grep");
		session.dispose();
	});

	it.skipIf(!detectSandboxSupport().ok)("runs user bash in the guest and drops host-spawning tools", async () => {
		const session = await create(true);
		expect(session.getAllTools().map((t) => t.name)).not.toContain("grep");
		const result = await session.executeBash("cat /workspace/a.txt; echo $HOME");
		expect(result.output).toContain("hello");
		expect(result.output).toContain("/root");
		expect(session.sandbox?.state.kind).toBe("enforced");
		session.dispose();
	});
});
