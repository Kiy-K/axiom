// Tests for the session-end step: what is applied, what is asked, what is saved.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { finishSandbox } from "../src/core/sandbox/finish.ts";
import { createWorkspace, type Workspace } from "../src/core/sandbox/workspace.ts";

describe("finishSandbox", () => {
	let dir: string;
	let saved: string;
	let ws: Workspace;

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "fin-"));
		saved = mkdtempSync(join(tmpdir(), "fin-saved-"));
		execFileSync("git", ["init", "-q"], { cwd: dir });
		mkdirSync(join(dir, "src"));
		writeFileSync(join(dir, "src", "main.ts"), "code");
		execFileSync("git", ["add", "-A"], { cwd: dir });
		ws = await createWorkspace(dir);
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		rmSync(saved, { recursive: true, force: true });
	});

	const guestWrite = async (path: string, text: string, mode?: number) => {
		const handle = await ws.cow.open(path, "w");
		await handle.writeFile(text);
		await handle.close();
		if (mode !== undefined) await ws.cow.chmod(path, mode);
	};

	it("does nothing when the guest changed nothing", async () => {
		expect(await finishSandbox(ws, undefined, saved)).toEqual([]);
	});

	it("applies ordinary edits without asking", async () => {
		await guestWrite("/src/main.ts", "edited");
		let asked = false;
		const lines = await finishSandbox(
			ws,
			{
				select: async () => {
					asked = true;
					return undefined;
				},
			},
			saved,
		);
		expect(asked).toBe(false);
		expect(readFileSync(join(dir, "src", "main.ts"), "utf8")).toBe("edited");
		expect(lines.join("\n")).toContain("applied 1 change");
	});

	it("asks once for risky changes and applies them when approved", async () => {
		await guestWrite("/package.json", "{}");
		await guestWrite("/tool", "#!/bin/sh\n", 0o755);
		const titles: string[] = [];
		await finishSandbox(
			ws,
			{
				select: async (title, options) => {
					titles.push(title);
					return options[0];
				},
			},
			saved,
		);
		expect(titles).toHaveLength(1);
		expect(titles[0]).toContain("package.json");
		expect(titles[0]).toContain("tool");
		expect(existsSync(join(dir, "package.json"))).toBe(true);
		expect(existsSync(join(dir, "tool"))).toBe(true);
	});

	it("saves declined changes and leaves the project alone", async () => {
		await guestWrite("/package.json", "{}");
		const lines = await finishSandbox(ws, { select: async (_title, options) => options[1] }, saved);
		expect(existsSync(join(dir, "package.json"))).toBe(false);
		expect(readFileSync(join(saved, "package.json"), "utf8")).toBe("{}");
		expect(lines.join("\n")).toContain(saved);
	});

	it("applies nothing risky when nobody can be asked", async () => {
		await guestWrite("/package.json", "{}");
		await guestWrite("/src/main.ts", "edited");
		await finishSandbox(ws, undefined, saved);
		expect(existsSync(join(dir, "package.json"))).toBe(false);
		expect(readFileSync(join(dir, "src", "main.ts"), "utf8")).toBe("edited");
		expect(existsSync(join(saved, "package.json"))).toBe(true);
	});

	it("never applies a conflicting change and saves the guest's version", async () => {
		await guestWrite("/src/main.ts", "guest");
		writeFileSync(join(dir, "src", "main.ts"), "host edit, longer");
		const lines = await finishSandbox(ws, undefined, saved);
		expect(readFileSync(join(dir, "src", "main.ts"), "utf8")).toBe("host edit, longer");
		expect(readFileSync(join(saved, "src", "main.ts"), "utf8")).toBe("guest");
		expect(lines.join("\n")).toContain("changed on the host");
	});
});
