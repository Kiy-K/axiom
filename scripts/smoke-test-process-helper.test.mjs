import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { packagedHelpers, requirePackagedHelpers } from "./smoke-test-process-helper.mjs";

const script = fileURLToPath(new URL("./smoke-test-process-helper.mjs", import.meta.url));

function frame(text) {
	const body = Buffer.from(text);
	const header = Buffer.alloc(5);
	header[0] = 0x4a;
	header.writeUInt32BE(body.length, 1);
	return Buffer.concat([header, body]);
}

function fakeHelper(dir, name, body) {
	const path = join(dir, name);
	writeFileSync(path, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
	chmodSync(path, 0o755);
	return path;
}

test("shipped helper list covers desktop and android", () => {
	assert.deepEqual(packagedHelpers, [
		"native/process/linux-x64/axiom-process",
		"native/process/linux-arm64/axiom-process",
		"native/process/darwin-x64/axiom-process",
		"native/process/darwin-arm64/axiom-process",
		"native/process/win32-x64/axiom-process.exe",
		"native/process/win32-arm64/axiom-process.exe",
		"native/process/android-arm64/axiom-process",
		"native/process/android-x64/axiom-process",
	]);
});

test("rejects a helper that does not spawn", () => {
	const dir = mkdtempSync(join(tmpdir(), "axiom-helper-smoke-"));
	try {
		const helper = fakeHelper(dir, "axiom-process", `process.stdout.write(Buffer.from(${JSON.stringify(frame('{"type":"error","message":"no"}').toString("base64"))}, "base64"))`);
		const result = spawnSync(process.execPath, [script, helper], { encoding: "utf8" });
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /did not spawn/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("spawn frame alone is not success", () => {
	const dir = mkdtempSync(join(tmpdir(), "axiom-helper-spawn-"));
	try {
		const helper = fakeHelper(
			dir,
			"axiom-process",
			`process.stdout.write(Buffer.from(${JSON.stringify(frame('{"type":"spawn","pid":1}').toString("base64"))}, "base64")); process.exit(0);`,
		);
		const result = spawnSync(process.execPath, [script, helper], { encoding: "utf8" });
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /did not prove/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("closes only after output or exit", () => {
	const dir = mkdtempSync(join(tmpdir(), "axiom-helper-close-"));
	const early = join(dir, "early");
	try {
		const helper = fakeHelper(dir, "axiom-process", closeAfterProof(early));
		const result = spawnSync(process.execPath, [script, helper], { encoding: "utf8", timeout: 5000 });
		assert.equal(result.status, 0, result.stderr);
		assert.equal(existsSync(early), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("require-all fails closed without executing a foreign helper", async () => {
	const dir = mkdtempSync(join(tmpdir(), "axiom-helper-pack-"));
	try {
		await assert.rejects(() => requirePackagedHelpers(dir), /missing process helpers/);
		for (const path of packagedHelpers) {
			mkdirSync(dirname(join(dir, path)), { recursive: true });
			writeFileSync(join(dir, path), "x");
		}
		await assert.rejects(() => requirePackagedHelpers(dir), /did not prove|ENOENT|spawn/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

function closeAfterProof(early) {
	const spawnFrame = frame('{"type":"spawn","pid":1}').toString("base64");
	const out = frameBytes(0x4f, "axiom-smoke\n").toString("base64");
	const exit = frame('{"type":"exit","code":0}').toString("base64");
	return `
		const { createInterface } = require("node:readline");
		const { writeFileSync } = require("node:fs");
		const early = ${JSON.stringify(early)};
		let proved = false;
		const rl = createInterface({ input: process.stdin });
		rl.on("line", (line) => {
			const msg = JSON.parse(line);
			if (!proved && msg.type === "close") {
				writeFileSync(early, "close-before-proof");
				process.exit(2);
			}
			if (msg.type === "start") {
				process.stdout.write(Buffer.from(${JSON.stringify(spawnFrame)}, "base64"));
				setTimeout(() => {
					proved = true;
					process.stdout.write(Buffer.from(${JSON.stringify(out)}, "base64"));
					process.stdout.write(Buffer.from(${JSON.stringify(exit)}, "base64"));
				}, 40);
			}
			if (msg.type === "close" && proved) process.exit(0);
		});
		rl.on("close", () => {
			if (!proved) {
				writeFileSync(early, "eof-before-proof");
				process.exit(3);
			}
		});
	`;
}

function frameBytes(kind, text) {
	const body = Buffer.from(text);
	const header = Buffer.alloc(5);
	header[0] = kind;
	header.writeUInt32BE(body.length, 1);
	return Buffer.concat([header, body]);
}
