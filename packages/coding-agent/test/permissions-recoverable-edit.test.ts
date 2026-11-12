import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isRecoverableEdit } from "../src/core/permissions/recoverable-edit.ts";

// Issue #1: automatic edits require a tracked file in a clean worktree.
describe("recoverable edit eligibility", () => {
	let root: string;
	let file: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-edit-recovery-"));
		file = join(root, "tracked.txt");
		execFileSync("git", ["init", "-q", root]);
		writeFileSync(file, "original\n");
		execFileSync("git", ["-C", root, "add", "tracked.txt"]);
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
	});

	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("accepts a tracked file in a clean worktree", async () => {
		expect(await isRecoverableEdit(root, file)).toBe(true);
	});

	it("rejects a dirty worktree and untracked files", async () => {
		writeFileSync(join(root, "untracked.txt"), "new\n");
		expect(await isRecoverableEdit(root, file)).toBe(false);
	});

	it("rejects index flags that hide dirty files", async () => {
		execFileSync("git", ["-C", root, "update-index", "--assume-unchanged", "tracked.txt"]);
		writeFileSync(file, "changed\n");
		expect(await isRecoverableEdit(root, file)).toBe(false);
	});

	it("rejects modified or staged files", async () => {
		writeFileSync(file, "changed\n");
		expect(await isRecoverableEdit(root, file)).toBe(false);
		execFileSync("git", ["-C", root, "add", "tracked.txt"]);
		expect(await isRecoverableEdit(root, file)).toBe(false);
	});

	it("rejects submodules before inspecting their configuration", async () => {
		const child = mkdtempSync(join(tmpdir(), "pi-edit-submodule-"));
		try {
			execFileSync("git", ["init", "-q", child]);
			writeFileSync(join(child, "file"), "initial\n");
			execFileSync("git", ["-C", child, "add", "file"]);
			execFileSync("git", [
				"-C",
				child,
				"-c",
				"user.name=Test",
				"-c",
				"user.email=test@example.invalid",
				"commit",
				"-qm",
				"initial",
			]);
			execFileSync("git", ["-C", root, "-c", "protocol.file.allow=always", "submodule", "add", "-q", child, "sub"]);
			execFileSync("git", [
				"-C",
				root,
				"-c",
				"user.name=Test",
				"-c",
				"user.email=test@example.invalid",
				"commit",
				"-qm",
				"submodule",
			]);
			expect(await isRecoverableEdit(root, file)).toBe(false);
		} finally {
			rmSync(child, { recursive: true, force: true });
		}
	});

	it("does not run configured clean filters", async () => {
		const marker = join(root, "filter-ran");
		execFileSync("git", ["-C", root, "config", "filter.probe.clean", `touch ${marker}`]);
		writeFileSync(join(root, ".gitattributes"), "tracked.txt filter=probe\n");
		expect(await isRecoverableEdit(root, file)).toBe(false);
		expect(existsSync(marker)).toBe(false);
	});

	it("ignores untracked files that .gitignore hides", async () => {
		writeFileSync(join(root, ".gitignore"), "ignored.txt\n");
		execFileSync("git", ["-C", root, "add", ".gitignore"]);
		execFileSync("git", [
			"-C",
			root,
			"-c",
			"user.name=Test",
			"-c",
			"user.email=test@example.invalid",
			"commit",
			"-qm",
			"ignore",
		]);
		writeFileSync(join(root, "ignored.txt"), "scratch\n");
		expect(await isRecoverableEdit(root, file)).toBe(true);
	});

	it("does not run a repository fsmonitor or hooks, and ignores inherited Git variables", async () => {
		const marker = join(root, "helper-ran");
		execFileSync("git", ["-C", root, "config", "core.fsmonitor", `touch ${marker}`]);
		execFileSync("git", ["-C", root, "config", "core.hooksPath", root]);
		const other = mkdtempSync(join(tmpdir(), "pi-edit-other-"));
		const saved = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
		try {
			execFileSync("git", ["init", "-q", other]);
			process.env.GIT_DIR = join(other, ".git");
			process.env.GIT_WORK_TREE = other;
			expect(await isRecoverableEdit(root, file)).toBe(true);
			expect(existsSync(marker)).toBe(false);
		} finally {
			for (const [key, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			rmSync(other, { recursive: true, force: true });
		}
	});
});
