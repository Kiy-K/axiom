// Unit tests for the copy-on-write workspace layer: the lower layer is never written.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReadonlyProvider, RealFSProvider } from "@earendil-works/gondolin";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CowProvider } from "../src/core/sandbox/cow-provider.ts";

describe("CowProvider", () => {
	let dir: string;
	let cow: CowProvider;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "cow-"));
		writeFileSync(join(dir, "a.txt"), "alpha");
		mkdirSync(join(dir, "sub"));
		writeFileSync(join(dir, "sub", "b.txt"), "beta");
		cow = new CowProvider(new ReadonlyProvider(new RealFSProvider(dir)), 1024);
	});

	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const read = async (path: string) => ((await (await cow.open(path, "r")).readFile()) as Buffer).toString();
	const write = async (path: string, text: string, flags = "w") => {
		const handle = await cow.open(path, flags);
		await handle.writeFile(text);
		await handle.close();
	};

	it("reads fall through to the lower layer", async () => {
		expect(await read("/a.txt")).toBe("alpha");
		expect(await cow.readdir("/")).toEqual(["a.txt", "sub"]);
	});

	it("creates files in memory and not on the host", async () => {
		await write("/new.txt", "fresh");
		expect(await read("/new.txt")).toBe("fresh");
		expect(await cow.readdir("/")).toContain("new.txt");
		expect(() => readFileSync(join(dir, "new.txt"))).toThrow();
		expect((await cow.changes()).map((c) => c.path)).toEqual(["/new.txt"]);
	});

	it("modifies a lower file by copying it up, host stays unchanged", async () => {
		await write("/a.txt", "changed");
		expect(await read("/a.txt")).toBe("changed");
		expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("alpha");
	});

	it("appends to a lower file after copying it up", async () => {
		await write("/a.txt", "+more", "a");
		expect(await read("/a.txt")).toBe("alpha+more");
	});

	it("deletes with a tombstone", async () => {
		await cow.unlink("/a.txt");
		await expect(cow.stat("/a.txt")).rejects.toMatchObject({ code: "ENOENT" });
		expect(await cow.readdir("/")).toEqual(["sub"]);
		expect(cow.deletedPaths()).toEqual(["/a.txt"]);
		expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("alpha");
	});

	it("recreates a deleted path", async () => {
		await cow.unlink("/a.txt");
		await write("/a.txt", "again");
		expect(await read("/a.txt")).toBe("again");
	});

	it("renames a lower file", async () => {
		await cow.rename("/a.txt", "/c.txt");
		expect(await read("/c.txt")).toBe("alpha");
		await expect(cow.stat("/a.txt")).rejects.toMatchObject({ code: "ENOENT" });
		expect(cow.deletedPaths()).toEqual(["/a.txt"]);
	});

	it("refuses to rename a lower directory so mv copies it", async () => {
		await expect(cow.rename("/sub", "/sub2")).rejects.toMatchObject({ code: "EXDEV" });
	});

	it("removes only empty directories", async () => {
		await expect(cow.rmdir("/sub")).rejects.toMatchObject({ code: "ENOTEMPTY" });
		await cow.unlink("/sub/b.txt");
		await cow.rmdir("/sub");
		expect(await cow.readdir("/")).toEqual(["a.txt"]);
	});

	it("makes nested directories in memory", async () => {
		await cow.mkdir("/x/y/z", { recursive: true });
		await write("/x/y/z/f.txt", "deep");
		expect(await read("/x/y/z/f.txt")).toBe("deep");
	});

	it("stops with ENOSPC at the byte cap", async () => {
		await expect(write("/big.bin", "x".repeat(2000))).rejects.toMatchObject({ code: "ENOSPC" });
		await write("/ok.txt", "x".repeat(1000));
		await expect(write("/more.txt", "x".repeat(100))).rejects.toMatchObject({ code: "ENOSPC" });
	});

	it("keeps symlinks as entries, not followed", async () => {
		await cow.symlink("a.txt", "/link");
		expect(await cow.readlink("/link")).toBe("a.txt");
		expect(await cow.changes()).toMatchObject([{ path: "/link", kind: "symlink" }]);
	});

	it("records a mode change", async () => {
		await cow.chmod("/a.txt", 0o755);
		expect(await cow.changes()).toMatchObject([{ path: "/a.txt", mode: 0o755 }]);
	});
});
