import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getNativeProcessHelperPath } from "../src/config.ts";

const originalPackageDir = process.env.PI_PACKAGE_DIR;
let directory: string | undefined;

afterEach(() => {
	if (originalPackageDir === undefined) delete process.env.PI_PACKAGE_DIR;
	else process.env.PI_PACKAGE_DIR = originalPackageDir;
	if (directory) rmSync(directory, { recursive: true, force: true });
});

describe("native process helper packaging", () => {
	it("resolves the current platform's packaged executable", () => {
		directory = mkdtempSync(join(tmpdir(), "axiom-native-"));
		process.env.PI_PACKAGE_DIR = directory;
		const helper = join(
			directory,
			"native",
			"process",
			`${process.platform}-${process.arch}`,
			process.platform === "win32" ? "axiom-process.exe" : "axiom-process",
		);
		mkdirSync(dirname(helper), { recursive: true });
		writeFileSync(helper, "fixture");
		expect(getNativeProcessHelperPath()).toBe(helper);
	});

	it("reports a missing helper instead of choosing a numeric PID fallback", () => {
		directory = mkdtempSync(join(tmpdir(), "axiom-native-"));
		process.env.PI_PACKAGE_DIR = directory;
		expect(() => getNativeProcessHelperPath()).toThrow(/native process helper.*not found/i);
	});
});
