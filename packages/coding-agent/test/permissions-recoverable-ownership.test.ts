import * as childProcess from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Git's own test switch makes every repository look owned by someone else. The probe builds its Git
// environment from scratch, so the wrapper below injects the switch into each child process it starts.
vi.mock("node:child_process", async (importOriginal) => {
	const original = await importOriginal<typeof childProcess>();
	const custom = Symbol.for("nodejs.util.promisify.custom");
	const originalPromised = (original.execFile as unknown as Record<symbol, (...a: unknown[]) => unknown>)[custom];
	const execFile = Object.assign(() => undefined, {
		// promisify(execFile) resolves to this form, which carries stdout and stderr.
		[custom]: (...args: unknown[]) => {
			const options = args.find((arg) => typeof arg === "object" && arg !== null && "env" in arg) as
				| { env: Record<string, string | undefined> }
				| undefined;
			if (options && process.env.PI_TEST_DIFFERENT_OWNER) options.env.GIT_TEST_ASSUME_DIFFERENT_OWNER = "1";
			return originalPromised(...args);
		},
	});
	return { ...original, execFile };
});

const { isRecoverableEdit } = await import("../src/core/permissions/recoverable-edit.ts");

// Issue #1: a repository Git refuses as unsafe must not be treated as recoverable.
describe("recoverable edit ownership", () => {
	let root: string;
	let file: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-edit-owner-"));
		file = join(root, "tracked.txt");
		childProcess.execFileSync("git", ["init", "-q", root]);
		writeFileSync(file, "original\n");
		childProcess.execFileSync("git", ["-C", root, "add", "tracked.txt"]);
		childProcess.execFileSync("git", [
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
	afterEach(() => {
		delete process.env.PI_TEST_DIFFERENT_OWNER;
		rmSync(root, { recursive: true, force: true });
	});

	it("accepts the repository while Git considers it ours", async () => {
		expect(await isRecoverableEdit(root, file)).toBe(true);
	});

	it("refuses a repository Git reports as dubious ownership", async () => {
		process.env.PI_TEST_DIFFERENT_OWNER = "1";
		expect(await isRecoverableEdit(root, file)).toBe(false);
	});
});
