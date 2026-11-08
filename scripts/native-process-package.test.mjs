import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { execNpmSync } from "./npm-command.mjs";
import { packagedHelpers } from "./smoke-test-process-helper.mjs";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("npm package includes the retained process helper", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "axiom-native-pack-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	copyFileSync(join(root, "packages/coding-agent/package.json"), join(dir, "package.json"));
	for (const path of packagedHelpers) {
		const helper = join(dir, path);
		mkdirSync(dirname(helper), { recursive: true });
		writeFileSync(helper, "fixture");
	}
	const packed = JSON.parse(
		execNpmSync(["pack", "--ignore-scripts", "--dry-run", "--json"], { cwd: dir, encoding: "utf8" }),
	);
	const files = new Set(packed[0].files.map((file) => file.path));
	for (const path of packagedHelpers) assert.ok(files.has(path), path);
});
