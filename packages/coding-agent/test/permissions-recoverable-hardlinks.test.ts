import { execFileSync } from "node:child_process";
import { linkSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { isRecoverableEdit } from "../src/core/permissions/recoverable-edit.ts";

// Issue #1: editing a hard link can also change a file outside the workspace.
it("does not auto-approve an edit to a multiply linked file", async () => {
	const parent = mkdtempSync(join(tmpdir(), "edit-hardlink-"));
	try {
		const root = join(parent, "repo");
		execFileSync("git", ["init", "-q", root]);
		const file = join(root, "file.txt");
		writeFileSync(file, "original\n");
		execFileSync("git", ["-C", root, "add", "file.txt"]);
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
		linkSync(file, join(parent, "outside.txt"));
		expect(await isRecoverableEdit(root, file)).toBe(false);
	} finally {
		rmSync(parent, { recursive: true, force: true });
	}
});
