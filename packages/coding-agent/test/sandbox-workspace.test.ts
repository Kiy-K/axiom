// Tests for createWorkspace: what the guest can see of a git project, and the host-edit manifest.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hostChanged } from "../src/core/sandbox/manifest.ts";
import { createWorkspace } from "../src/core/sandbox/workspace.ts";

describe("createWorkspace", () => {
	let dir: string;
	let outside: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "ws-"));
		outside = mkdtempSync(join(tmpdir(), "ws-outside-"));
		writeFileSync(join(outside, "private.txt"), "outside secret");
		execFileSync("git", ["init", "-q"], { cwd: dir });
		writeFileSync(join(dir, ".gitignore"), "node_modules\n");
		writeFileSync(join(dir, "a.txt"), "alpha");
		writeFileSync(join(dir, ".env"), "TOKEN=1");
		mkdirSync(join(dir, "src"));
		writeFileSync(join(dir, "src", "main.ts"), "code");
		mkdirSync(join(dir, "node_modules"));
		writeFileSync(join(dir, "node_modules", "dep.js"), "dep");
		symlinkSync(join(outside, "private.txt"), join(dir, "escape"));
		symlinkSync(".env", join(dir, "to-env"));
		symlinkSync("a.txt", join(dir, "inside"));
		execFileSync("git", ["add", "-A"], { cwd: dir });
		writeFileSync(join(dir, "untracked.txt"), "new");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
	});

	const exists = async (ws: Awaited<ReturnType<typeof createWorkspace>>, path: string) =>
		ws.provider.stat(path).then(
			() => true,
			() => false,
		);

	it("shows tracked and untracked files", async () => {
		const ws = await createWorkspace(dir);
		expect(await exists(ws, "/a.txt")).toBe(true);
		expect(await exists(ws, "/src/main.ts")).toBe(true);
		expect(await exists(ws, "/untracked.txt")).toBe(true);
	});

	it("hides secret-like files, ignored directories and .git", async () => {
		const ws = await createWorkspace(dir);
		expect(await exists(ws, "/.env")).toBe(false);
		expect(await exists(ws, "/node_modules/dep.js")).toBe(false);
		expect(await exists(ws, "/.git/config")).toBe(false);
		expect(await ws.provider.readdir("/")).not.toContain(".env");
		expect(await ws.provider.readdir("/")).not.toContain("node_modules");
		expect(await ws.provider.readdir("/")).not.toContain(".git");
	});

	it("hides symlinks that leave the project or point at a secret", async () => {
		const ws = await createWorkspace(dir);
		expect(await exists(ws, "/escape")).toBe(false);
		expect(await exists(ws, "/to-env")).toBe(false);
		expect(ws.hidden.sort()).toEqual([".env", "escape", "to-env"]);
		// A symlink that stays inside the project is fine.
		expect(await exists(ws, "/inside")).toBe(true);
	});

	it("hides a secret created on the host after the session started", async () => {
		const ws = await createWorkspace(dir);
		writeFileSync(join(dir, ".env.local"), "TOKEN=2");
		writeFileSync(join(dir, "late.txt"), "late");
		expect(await exists(ws, "/.env.local")).toBe(false);
		expect(await exists(ws, "/late.txt")).toBe(false);
	});

	it("a guest-created file stays visible and never reaches the host", async () => {
		const ws = await createWorkspace(dir);
		const handle = await ws.provider.open("/created.txt", "w");
		await handle.writeFile("x");
		await handle.close();
		expect(await exists(ws, "/created.txt")).toBe(true);
		expect(await exists(ws, "/.env")).toBe(false);
	});

	it("fails closed outside a git work tree", async () => {
		const plain = mkdtempSync(join(tmpdir(), "ws-plain-"));
		try {
			await expect(createWorkspace(plain)).rejects.toThrow(/needs a git work tree/);
		} finally {
			rmSync(plain, { recursive: true, force: true });
		}
	});

	it("does not run a program named by the repository's fsmonitor config", async () => {
		const marker = join(outside, "ran");
		writeFileSync(join(outside, "hook.sh"), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
		execFileSync("git", ["config", "core.fsmonitor", join(outside, "hook.sh")], { cwd: dir });
		expect(await exists(await createWorkspace(dir), "/a.txt")).toBe(true);
		expect(existsSync(marker)).toBe(false);
	});

	it("reports host edits made after the start", async () => {
		const ws = await createWorkspace(dir);
		expect(await hostChanged(ws.manifest, dir, "a.txt")).toBe(false);
		writeFileSync(join(dir, "a.txt"), "edited on host");
		utimesSync(join(dir, "a.txt"), new Date(), new Date(Date.now() + 5000));
		expect(await hostChanged(ws.manifest, dir, "a.txt")).toBe(true);
		// A path the guest never saw that now exists on the host counts as changed.
		expect(await hostChanged(ws.manifest, dir, "late.txt")).toBe(false);
		writeFileSync(join(dir, "late.txt"), "late");
		expect(await hostChanged(ws.manifest, dir, "late.txt")).toBe(true);
	});
});
