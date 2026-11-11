import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AuditEntry, AuditLog } from "../src/core/permissions/audit.ts";

describe("AuditLog rotation", () => {
	let dir: string;
	let file: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "perm-audit-"));
		file = join(dir, "audit", "permissions.jsonl");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const entry = (detail: string): AuditEntry => ({
		time: 1,
		sessionId: "s",
		toolName: "bash",
		decision: "allow",
		source: "policy",
		detail,
	});
	const lines = (path: string) =>
		readFileSync(path, "utf-8")
			.trim()
			.split("\n")
			.map((line) => (JSON.parse(line) as AuditEntry).detail);
	const mode = (path: string) => statSync(path).mode & 0o777;

	it("moves a full file to .1, starts a new private file with the newest entry, and keeps one generation", () => {
		const size = JSON.stringify(entry("a")).length + 1;
		const log = new AuditLog(file, 2 * size); // Holds two entries.
		for (const detail of ["a", "b"]) log.record(entry(detail));
		expect(lines(file)).toEqual(["a", "b"]);
		expect(existsSync(`${file}.1`)).toBe(false);

		log.record(entry("c")); // The file is full, so a and b move out and c opens the new file.
		expect(lines(file)).toEqual(["c"]);
		expect(lines(`${file}.1`)).toEqual(["a", "b"]);
		expect(mode(file)).toBe(0o600);
		expect(mode(`${file}.1`)).toBe(0o600);

		for (const detail of ["d", "e"]) log.record(entry(detail)); // A second rotation replaces .1.
		expect(lines(file)).toEqual(["e"]);
		expect(lines(`${file}.1`)).toEqual(["c", "d"]);
		expect(existsSync(`${file}.2`)).toBe(false);
	});

	it("loses no entry across rotations", () => {
		const log = new AuditLog(file, 300);
		const all = Array.from({ length: 6 }, (_, i) => `entry-${i}`);
		for (const detail of all) log.record(entry(detail));
		const kept = [...(existsSync(`${file}.1`) ? lines(`${file}.1`) : []), ...lines(file)];
		// The newest entry is always in the live file, and every kept entry is contiguous and in order.
		expect(lines(file).at(-1)).toBe("entry-5");
		expect(kept).toEqual(all.slice(all.length - kept.length));
	});

	it("reports a failed rotation and still appends the entry", () => {
		const log = new AuditLog(file, 10);
		log.record(entry("first"));
		// A directory at <file>.1 makes the rename fail.
		mkdirSync(`${file}.1`);
		writeFileSync(join(`${file}.1`, "keep"), "x");
		const errors: string[] = [];
		log.record(entry("second"), (message) => errors.push(message));
		expect(errors[0]).toContain("rotation failed");
		expect(lines(file)).toEqual(["first", "second"]);
		chmodSync(file, 0o600);
	});

	it("does not rotate below the cap", () => {
		const log = new AuditLog(file, 1_000_000);
		for (const detail of ["a", "b", "c"]) log.record(entry(detail));
		expect(lines(file)).toEqual(["a", "b", "c"]);
		expect(existsSync(`${file}.1`)).toBe(false);
	});
});
