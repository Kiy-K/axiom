// Regression tests for the gate's bugfix verdict: the agent must not be able to pass by editing or deleting tests.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { restoreTests, testsTampered, verify } from "./axiom-hashline-gate.mjs";

const TEST_EXPECTS_TWO = [
	'const test = require("node:test");',
	'const assert = require("node:assert");',
	'const { value } = require("../src/value.js");',
	'test("value is two", () => assert.strictEqual(value, 2));',
	"",
].join("\n");

const task = {
	files: {
		"src/value.js": "module.exports = { value: 2 };\n",
		"test/value.test.js": TEST_EXPECTS_TWO,
	},
};

function workdirWith(files) {
	const dir = mkdtempSync(join(tmpdir(), "hl-verdict-test-"));
	for (const [rel, content] of Object.entries(files)) {
		mkdirSync(dirname(join(dir, rel)), { recursive: true });
		writeFileSync(join(dir, rel), content);
	}
	return dir;
}

test("verify passes a correct fix against the task's tests", () => {
	const dir = workdirWith(task.files);
	try {
		assert.equal(verify(task, dir), true);
		assert.equal(testsTampered(task, dir), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("verify fails when the agent rewrote the test to match a broken source", () => {
	const dir = workdirWith({
		"src/value.js": "module.exports = { value: 1 };\n",
		"test/value.test.js": TEST_EXPECTS_TWO.replace("strictEqual(value, 2)", "strictEqual(value, 1)"),
	});
	try {
		assert.equal(testsTampered(task, dir), true);
		assert.equal(verify(task, dir), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("verify fails when the agent deleted the tests", () => {
	const dir = workdirWith({ "src/value.js": "module.exports = { value: 1 };\n" });
	try {
		assert.equal(verify(task, dir), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("testsTampered reports a deleted test file", () => {
	const dir = workdirWith(task.files);
	try {
		unlinkSync(join(dir, "test/value.test.js"));
		assert.equal(testsTampered(task, dir), true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("restoreTests puts back the task's test files and drops extra ones", () => {
	const dir = workdirWith({ ...task.files, "test/extra.test.js": "throw new Error('planted');\n" });
	try {
		restoreTests(task, dir);
		assert.equal(testsTampered(task, dir), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("verify fails when the task has no tests at all", () => {
	const dir = workdirWith({ "src/value.js": "module.exports = { value: 2 };\n" });
	try {
		assert.equal(verify({ files: { "src/value.js": "" } }, dir), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
