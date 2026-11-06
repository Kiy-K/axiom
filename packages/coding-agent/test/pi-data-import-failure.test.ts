import { createHash } from "node:crypto";
import type * as NodeFs from "node:fs";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { importPiAgentDir } from "../src/pi-data-import.ts";

const copies = vi.hoisted(() => ({ count: 0 }));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof NodeFs>();
	return {
		...actual,
		copyFileSync: (...args: Parameters<typeof actual.copyFileSync>) => {
			copies.count++;
			if (copies.count === 2) throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
			actual.copyFileSync(...args);
		},
	};
});

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function digest(dir: string): string {
	const hash = createHash("sha256");
	for (const name of readdirSync(dir, { recursive: true }).map(String).sort()) {
		hash.update(name);
		try {
			hash.update(readFileSync(join(dir, name)));
		} catch {}
	}
	return hash.digest("hex");
}

describe("importPiAgentDir write failure", () => {
	it("fails cleanly: no target, no temp dir, source unchanged", () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-data-import-failure-")));
		tempDirs.push(root);
		const source = join(root, "pi");
		mkdirSync(join(source, "sessions"), { recursive: true });
		writeFileSync(join(source, "settings.json"), "{}");
		writeFileSync(join(source, "sessions", "a.jsonl"), "{}");
		writeFileSync(join(source, "z.txt"), "z");
		const before = digest(source);
		const target = join(root, "axiom", "agent");

		const result = importPiAgentDir(source, target);

		expect(result).toMatchObject({ kind: "failed", error: expect.stringContaining("ENOSPC") });
		expect(readdirSync(join(root, "axiom"))).toEqual([]);
		expect(digest(source)).toBe(before);
	});
});
