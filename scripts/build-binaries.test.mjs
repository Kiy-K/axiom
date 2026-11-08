import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./build-binaries.sh", import.meta.url));

test("build-binaries.sh names a missing helper before deleting output", () => {
	const root = mkdtempSync(join(tmpdir(), "axiom-build-binaries-"));
	try {
		mkdirSync(join(root, "scripts"));
		copyFileSync(script, join(root, "scripts/build-binaries.sh"));
		chmodSync(join(root, "scripts/build-binaries.sh"), 0o755);
		const helper = join(root, "packages/coding-agent/native/process/linux-arm64/axiom-process");
		mkdirSync(join(root, "packages/coding-agent/native/process/linux-arm64"), { recursive: true });
		writeFileSync(helper, "");
		const out = join(root, "out");
		mkdirSync(out);
		writeFileSync(join(out, "keep"), "kept");
		const result = spawnSync(
			"bash",
			[join(root, "scripts/build-binaries.sh"), "--skip-install", "--skip-build", "--platform", "linux-arm64", "--out", out],
			{ encoding: "utf8" },
		);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /linux-arm64\/axiom-process/);
		assert.equal(readFileSync(join(out, "keep"), "utf8"), "kept");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
