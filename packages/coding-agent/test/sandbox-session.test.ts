import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
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
describe("sandbox startup failure", () => {
	it("refuses bash and writes in a non-git workspace without touching the host", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "sandbox-nongit-"));
		const marker = join(cwd, "marker");
		const session = new SandboxSession(cwd);
		try {
			expect((await session.ready).kind).toBe("failed");
			await expect(session.operations.bash.exec(`touch '${marker}'`, cwd, { onData: () => {} })).rejects.toThrow(
				"Sandbox not enforced",
			);
			await expect(session.operations.write.writeFile(marker, "host")).rejects.toThrow("Sandbox not enforced");
			expect(existsSync(marker)).toBe(false);
			await session.close();
			expect(session.state.kind).toBe("failed");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

// Needs /dev/kvm and the Gondolin guest image.
describe.skipIf(!detectSandboxSupport().ok)("SandboxSession", { timeout: 180_000 }, () => {
	it("never invokes a backend after the close transition", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "sandbox-close-race-"));
		execFileSync("git", ["init", "-q"], { cwd });
		const session = new SandboxSession(cwd);
		try {
			const state = await session.ready;
			expect(state.kind).toBe("enforced");
			if (state.kind !== "enforced") throw new Error("sandbox did not start");
			const states: string[] = [];
			vi.spyOn(state.backend, "exec").mockImplementation(async () => {
				states.push(session.state.kind);
				return { exitCode: 0 };
			});
			const command = session.operations.bash.exec("true", cwd, { onData: () => {} });
			await session.close();
			await command;
			expect(states).toEqual(["enforced"]);
		} finally {
			await session.close();
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("closes once during startup and refuses subsequent commands and writes", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "sandbox-close-"));
		execFileSync("git", ["init", "-q"], { cwd });
		const session = new SandboxSession(cwd);
		try {
			const first = session.close();
			expect(session.close()).toBe(first);
			await first;
			expect(session.state).toEqual({ kind: "unavailable", reason: "the sandbox was closed" });
			await session.close();
			await expect(session.operations.bash.exec("true", cwd, { onData: () => {} })).rejects.toThrow(
				"the sandbox was closed",
			);
			await expect(session.operations.write.writeFile(join(cwd, "marker"), "x")).rejects.toThrow(
				"the sandbox was closed",
			);
			expect(existsSync(join(cwd, "marker"))).toBe(false);
		} finally {
			await session.close();
			rmSync(cwd, { recursive: true, force: true });
		}
	});

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
