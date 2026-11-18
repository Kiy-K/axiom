import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { detectSandboxSupport } from "../src/core/sandbox/detect.ts";
import { createAgentSession, type ExtensionFactory } from "../src/core/sdk.ts";
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

	async function create(sandbox: boolean, extensionFactories: ExtensionFactory[] = []) {
		const settingsManager = SettingsManager.inMemory({ sandbox: { enabled: sandbox }, permissionMode: "yolo" });
		const resourceLoader = new DefaultResourceLoader({ cwd: dir, agentDir, settingsManager, extensionFactories });
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

	it("runs user bash on the host when sandboxing is off", async () => {
		const session = await create(false);
		const marker = join(dir, "host-bash");
		try {
			const result = await session.executeBash(`touch '${marker}'`);
			expect(result.exitCode).toBe(0);
			expect(existsSync(marker)).toBe(true);
		} finally {
			session.dispose();
		}
	});

	it.skipIf(!detectSandboxSupport().ok)("keeps user bash side effects inside the guest", async () => {
		const session = await create(true);
		const marker = join(dir, "host-bash");
		try {
			const result = await session.executeBash("touch /workspace/host-bash; test -f /workspace/host-bash");
			expect(result.exitCode).toBe(0);
			expect(session.sandbox?.state.kind).toBe("enforced");
			expect(existsSync(marker)).toBe(false);
		} finally {
			await session.sandbox?.close();
			session.dispose();
		}
	});

	it.each([false, true])("enforces host process boundaries with sandbox enabled=%s", async (sandbox) => {
		const execMarker = join(dir, "extension-exec");
		const configMarker = join(dir, "config-command");
		let runExtension: (() => Promise<unknown>) | undefined;
		const session = await create(sandbox, [
			(pi) => {
				runExtension = () => pi.exec("touch", [execMarker], { cwd: dir });
				pi.registerProvider("sandbox-route-test", {
					baseUrl: "http://example.invalid",
					api: "openai-completions",
					apiKey: `!touch '${configMarker}' && echo test-key`,
					models: [
						{
							id: "test",
							name: "test",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 1000,
							maxTokens: 100,
						},
					],
				});
			},
		]);
		try {
			expect(runExtension).toBeDefined();
			if (!runExtension) throw new Error("extension was not loaded");
			if (sandbox) {
				await expect(runExtension()).rejects.toThrow(/extension-exec.*sandbox mode is on/);
				await expect(session.modelRuntime.getAuth("sandbox-route-test")).rejects.toThrow(
					/config-command.*sandbox mode is on/,
				);
			} else {
				await runExtension();
				const auth = await session.modelRuntime.getAuth("sandbox-route-test");
				expect(auth?.auth.apiKey).toBe("test-key");
			}
			expect(existsSync(execMarker)).toBe(!sandbox);
			expect(existsSync(configMarker)).toBe(!sandbox);
		} finally {
			await session.sandbox?.close();
			session.dispose();
		}
	});

	it.each([false, true])("guards package installation host processes with sandbox enabled=%s", async (sandbox) => {
		const marker = join(dir, "package-install");
		const script = join(dir, "fake-npm.sh");
		writeFileSync(script, `touch '${marker}'\n`);
		const settingsManager = SettingsManager.inMemory({ sandbox: { enabled: sandbox }, npmCommand: ["sh", script] });
		const packageManager = new DefaultPackageManager({ cwd: dir, agentDir, settingsManager });
		if (sandbox) {
			await expect(packageManager.install("npm:route-test")).rejects.toThrow(/package-install.*sandbox mode is on/);
		} else {
			await packageManager.install("npm:route-test");
		}
		expect(existsSync(marker)).toBe(!sandbox);
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
