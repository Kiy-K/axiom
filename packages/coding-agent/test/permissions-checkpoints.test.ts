import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EditCheckpoints, MAX_CHECKPOINT_BYTES, MAX_CHECKPOINTS } from "../src/core/permissions/checkpoints.ts";
import { PermissionGateway } from "../src/core/permissions/gateway.ts";

describe("pre-edit copies", () => {
	let root: string;
	let store: string;
	let sessionId: string;
	let copies: EditCheckpoints;
	/** The directory of the current session id: its name carries a hash of the id. */
	const dirOf = (id: string) => join(store, readdirSync(store).find((name) => name.startsWith(`${id}-`)) ?? "none");

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "ckpt-ws-"));
		store = mkdtempSync(join(tmpdir(), "ckpt-store-"));
		sessionId = "s1";
		copies = new EditCheckpoints(store, () => sessionId);
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
		rmSync(store, { recursive: true, force: true });
	});

	it("keeps bytes exactly (binary and CRLF included) and numbers copies in order", async () => {
		const bytes = Buffer.from([0, 255, 13, 10, 200]);
		expect((await copies.save("/w/a", bytes))?.id).toBe(1);
		expect((await copies.save("/w/b", Buffer.from("x")))?.id).toBe(2);
		expect(readFileSync(join(dirOf("s1"), "1.snap")).equals(bytes)).toBe(true);
		expect((await copies.list()).map((copy) => copy.path)).toEqual(["/w/a", "/w/b"]);
	});

	it("keeps sessions apart, and a hostile session id cannot leave the store", async () => {
		await copies.save("/w/a", Buffer.from("x"));
		sessionId = "../../escape";
		expect((await copies.save("/w/b", Buffer.from("y")))?.id).toBe(1);
		expect((await copies.list()).map((copy) => copy.path)).toEqual(["/w/b"]);
		const [name] = readdirSync(store).filter((entry) => entry.startsWith("______escape-"));
		expect(readFileSync(join(store, name ?? "", "1.snap"), "utf8")).toBe("y");
	});

	it("gives ids that differ only in replaced characters, and an empty id, their own directories", async () => {
		sessionId = "a.b";
		await copies.save("/w/dot", Buffer.from("1"));
		sessionId = "a_b";
		expect((await copies.save("/w/underscore", Buffer.from("2")))?.id).toBe(1);
		expect((await copies.list()).map((copy) => copy.path)).toEqual(["/w/underscore"]);
		sessionId = "";
		await copies.save("/w/empty", Buffer.from("3"));
		expect(existsSync(join(store, "1.snap"))).toBe(false);
		expect(existsSync(join(store, "index.jsonl"))).toBe(false);
	});

	it("is not blocked by a copy left without an index line, and does not reuse its number", async () => {
		await copies.save("/w/a", Buffer.from("x"));
		const sessionDir = readdirSync(store)[0] ?? "";
		writeFileSync(join(store, sessionDir, "2.snap"), "orphan");
		const saved = await copies.save("/w/b", Buffer.from("y"));
		expect(saved?.id).toBe(3);
		expect(readFileSync(join(store, sessionDir, "2.snap"), "utf8")).toBe("orphan");
	});

	it("removes a copy whose index line could not be written, so the number is free again", async () => {
		await copies.save("/w/a", Buffer.from("x"));
		const sessionDir = join(store, readdirSync(store)[0] ?? "");
		rmSync(join(sessionDir, "index.jsonl"));
		mkdirSync(join(sessionDir, "index.jsonl")); // appending to a directory fails
		expect(await copies.save("/w/b", Buffer.from("y"))).toBeUndefined();
		expect(readdirSync(sessionDir).filter((name) => name.endsWith(".snap"))).toEqual(["1.snap"]);
	});

	it("skips a truncated index line and keeps listing and saving after it", async () => {
		await copies.save("/w/a", Buffer.from("x"));
		await copies.save("/w/b", Buffer.from("y"));
		const sessionDir = join(store, readdirSync(store)[0] ?? "");
		appendFileSync(join(sessionDir, "index.jsonl"), '{"id":3,"path":"/w/c","ti');
		expect((await copies.list()).map((copy) => copy.id)).toEqual([1, 2]);
		expect((await copies.save("/w/d", Buffer.from("z")))?.id).toBe(3);
		// The line without a newline ran into the next record; both are lost to list, neither to the files.
		expect(existsSync(join(sessionDir, "3.snap"))).toBe(true);
		expect((await copies.save("/w/e", Buffer.from("w")))?.id).toBe(4);
	});

	it("ignores index lines that are not copy records", async () => {
		await copies.save("/w/a", Buffer.from("x"));
		const sessionDir = join(store, readdirSync(store)[0] ?? "");
		appendFileSync(join(sessionDir, "index.jsonl"), '{"id":"x","path":1}\n{"id":-4,"path":"/p"}\nnull\n');
		expect((await copies.list()).map((copy) => copy.id)).toEqual([1]);
	});

	it("counts the sizes of all copies, not only the new one", async () => {
		const half = Buffer.alloc(MAX_CHECKPOINT_BYTES / 2 + 1);
		expect(await copies.save("/w/a", half)).toBeDefined();
		expect(await copies.save("/w/b", half)).toBeUndefined();
	});

	it("never removes its own session's copies when it has been idle for a month, but removes another stale session's", async () => {
		await copies.save("/w/a", Buffer.from("x"));
		const ownDir = join(store, readdirSync(store)[0] ?? "");
		const staleDir = join(store, "stale-session");
		mkdirSync(staleDir);
		writeFileSync(join(staleDir, "index.jsonl"), "");
		const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
		for (const path of [ownDir, join(ownDir, "index.jsonl"), staleDir, join(staleDir, "index.jsonl")])
			utimesSync(path, old, old);
		const fresh = new EditCheckpoints(store, () => sessionId);
		expect((await fresh.save("/w/b", Buffer.from("y")))?.id).toBe(2);
		expect(existsSync(staleDir)).toBe(false);
		expect((await fresh.list()).map((copy) => copy.id)).toEqual([1, 2]);
	});

	it("lets a restore use the reserve past the cap, but an edit not", async () => {
		const file = join(root, "a.txt");
		writeFileSync(file, "v1\n");
		await copies.save(file, Buffer.from("v1\n"));
		for (let i = 1; i < MAX_CHECKPOINTS; i++) await copies.save("/w/x", Buffer.from("x"));
		expect(await copies.save("/w/x", Buffer.from("x"))).toBeUndefined();
		writeFileSync(file, "v2\n");
		expect(await copies.restore(1, () => true)).toBe(file);
		expect(readFileSync(file, "utf8")).toBe("v1\n");
	});

	it("restores the file with the mode it had, whatever the umask", async () => {
		const file = join(root, "run.sh");
		writeFileSync(file, "v1\n");
		await copies.save(file, Buffer.from("v1\n"));
		chmodSync(file, 0o775);
		await copies.restore(1, () => true);
		expect(statSync(file).mode & 0o777).toBe(0o775);
	});

	it("refuses a copy past the count or size bound, and with no store", async () => {
		expect(await new EditCheckpoints(undefined, () => "s").save("/w/a", Buffer.from("x"))).toBeUndefined();
		expect(await copies.save("/w/big", Buffer.alloc(MAX_CHECKPOINT_BYTES + 1))).toBeUndefined();
		for (let i = 0; i < MAX_CHECKPOINTS; i++) await copies.save("/w/a", Buffer.from("x"));
		expect(await copies.save("/w/a", Buffer.from("x"))).toBeUndefined();
	});

	it("restores a copy, keeps the file as it was first, and keeps its mode", async () => {
		const file = join(root, "a.txt");
		writeFileSync(file, "v1\n");
		chmodSync(file, 0o755);
		await copies.save(file, Buffer.from("v1\n"));
		writeFileSync(file, "v2\n");
		expect(await copies.restore(1, () => true)).toBe(file);
		expect(readFileSync(file, "utf8")).toBe("v1\n");
		const list = await copies.list();
		expect(list[1]).toMatchObject({ kind: "restore", path: file });
		expect(readFileSync(join(dirOf("s1"), "2.snap"), "utf8")).toBe("v2\n");
		// A restore can itself be undone.
		await copies.restore(2, () => true);
		expect(readFileSync(file, "utf8")).toBe("v2\n");
	});

	it("refuses to restore over a symlink, a path the caller does not allow, or an unknown id", async () => {
		const target = join(root, "t.txt");
		const link = join(root, "l.txt");
		writeFileSync(target, "t\n");
		symlinkSync(target, link);
		await copies.save(link, Buffer.from("old\n"));
		await expect(copies.restore(1, () => true)).rejects.toThrow("no longer a plain file");
		expect(readFileSync(target, "utf8")).toBe("t\n");
		await copies.save(join(root, "b.txt"), Buffer.from("x"));
		await expect(copies.restore(2, () => false)).rejects.toThrow("outside what edits may change");
		await expect(copies.restore(99, () => true)).rejects.toThrow("No copy 99");
	});

	it("gateway restore only touches ordinary workspace files", async () => {
		const gateway = new PermissionGateway({
			getMode: () => "accept-edits",
			getCwd: () => root,
			getSessionId: () => "g",
			checkpointRoot: store,
			getPrompter: () => undefined,
		});
		const ok = join(root, "ok.txt");
		const manifest = join(root, "package.json");
		writeFileSync(ok, "now\n");
		writeFileSync(manifest, "now\n");
		await gateway.checkpoints.save(ok, Buffer.from("then\n"));
		await gateway.checkpoints.save(manifest, Buffer.from("then\n"));
		await gateway.checkpoints.save(join(tmpdir(), "elsewhere.txt"), Buffer.from("then\n"));
		expect(await gateway.restoreCheckpoint(1)).toBe(ok);
		expect(readFileSync(ok, "utf8")).toBe("then\n");
		await expect(gateway.restoreCheckpoint(2)).rejects.toThrow("outside what edits may change");
		await expect(gateway.restoreCheckpoint(3)).rejects.toThrow("outside what edits may change");
	});

	it("gateway restore is audited, refused while a tool call runs, and refuses .git and secret files", async () => {
		const gateway = new PermissionGateway({
			getMode: () => "accept-edits",
			getCwd: () => root,
			getSessionId: () => "g2",
			checkpointRoot: store,
			getPrompter: () => undefined,
		});
		const ok = join(root, "ok.txt");
		writeFileSync(ok, "now\n");
		await gateway.checkpoints.save(ok, Buffer.from("then\n"));
		await gateway.checkpoints.save(join(root, ".env"), Buffer.from("S=1\n"));
		await gateway.checkpoints.save(join(root, ".git", "config"), Buffer.from("x"));
		gateway.startToolCall("busy");
		await expect(gateway.restoreCheckpoint(1)).rejects.toThrow("A tool call is running");
		gateway.endToolCall("busy");
		await gateway.restoreCheckpoint(1);
		expect(gateway.audit.tail(1)[0]).toMatchObject({
			toolName: "restore",
			decision: "allow",
			source: "user-command",
		});
		await expect(gateway.restoreCheckpoint(2)).rejects.toThrow("outside what edits may change");
		await expect(gateway.restoreCheckpoint(3)).rejects.toThrow("outside what edits may change");
	});
});
