import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectSandboxSupport } from "../src/core/sandbox/detect.ts";
import { SandboxSession } from "../src/core/sandbox/session.ts";
import type { Workspace } from "../src/core/sandbox/workspace.ts";
import { applyWriteBack, planWriteBack } from "../src/core/sandbox/writeback.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("sandbox settings", () => {
	it("is off by default and read from global settings only", () => {
		const settings = SettingsManager.inMemory({});
		expect(settings.getSandboxEnabled()).toBe(false);
		expect(settings.getSandboxExtensions()).toEqual([]);
		settings.setSandboxEnabled(true);
		expect(settings.getSandboxEnabled()).toBe(true);
	});
});

// Needs /dev/kvm and the Gondolin guest image.
describe.skipIf(!detectSandboxSupport().ok)("SandboxSession", { timeout: 180_000 }, () => {
	it("gives the guest a writable copy of the visible project and keeps secrets and the host untouched", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "sandbox-session-"));
		execFileSync("git", ["init", "-q"], { cwd });
		writeFileSync(join(cwd, "a.txt"), "hello");
		writeFileSync(join(cwd, ".env"), "TOKEN=secret");
		execFileSync("git", ["add", "-A"], { cwd });
		const session = new SandboxSession(cwd);
		try {
			let out = "";
			const { exitCode } = await session.operations.bash.exec(
				"cat a.txt && echo more >> a.txt && echo new > b.txt && ! test -e .env && ! test -e .git && ls -a",
				cwd,
				{
					onData: (data) => {
						out += data.toString();
					},
				},
			);
			expect(session.state.kind).toBe("enforced");
			expect(out).toContain("hello");
			expect(exitCode).toBe(0);
			expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("hello");
			expect(existsSync(join(cwd, "b.txt"))).toBe(false);
			const plan = await planWriteBack(session.workspace as Workspace);
			expect(plan.silent.map((c) => c.path).sort()).toEqual(["a.txt", "b.txt"]);
			await applyWriteBack(session.workspace as Workspace, plan.silent);
			expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("hellomore\n");
			expect(readFileSync(join(cwd, "b.txt"), "utf8")).toBe("new\n");
		} finally {
			await session.close();
		}
	});
});
