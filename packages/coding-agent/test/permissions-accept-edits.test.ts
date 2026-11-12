import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PermissionGateway } from "../src/core/permissions/gateway.ts";

// Issue #1: automatic edit permission must be explicit, recoverable (a pre-edit copy is kept) and limited to the built-in edit tool.
describe("accept-edits permission", () => {
	let root: string;
	let store: string;
	/** The copy directory of the session "test": its name carries a hash of the id. */
	const sessionDir = () => join(store, readdirSync(store).find((name) => name.startsWith("test-")) ?? "none");
	let prompts: string[];
	let answer: string;
	let gateway: PermissionGateway;
	const call = (id: string, builtinEdit: "replace" | undefined) => ({
		toolName: "edit",
		toolCallId: id,
		builtinEdit,
		input: { path: "file.txt", edits: [{ oldText: "original", newText: "changed" }] },
	});
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "accept-edits-"));
		store = mkdtempSync(join(tmpdir(), "accept-edits-store-"));
		writeFileSync(join(root, "file.txt"), "original\n");
		prompts = [];
		answer = "Trust edits for this session";
		gateway = new PermissionGateway({
			getMode: () => "accept-edits",
			getCwd: () => root,
			getSessionId: () => "test",
			checkpointRoot: store,
			canRequestEditTrust: () => true,
			getPrompter: () => ({
				select: async (title) => {
					prompts.push(title);
					return answer;
				},
			}),
		});
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
		rmSync(store, { recursive: true, force: true });
	});
	it("asks for session trust once, audits auto-approval, and holds a reservation until completion", async () => {
		const first = call("one", "replace");
		expect(await gateway.authorize(first)).toBeUndefined();
		expect(prompts).toHaveLength(1);
		expect(gateway.audit.tail(1)[0]).toMatchObject({ decision: "allow", source: "accept-edits" });
		answer = "Deny";
		expect((await gateway.authorize(call("two", "replace")))?.block).toBe(true);
		gateway.finishToolCall("one", first.input);
		expect(await gateway.authorize(call("three", "replace"))).toBeUndefined();
		expect(prompts).toHaveLength(2);
	});
	it("keeps the reservation when an earlier call that shares its id ends", async () => {
		gateway.startToolCall("dup");
		expect(await gateway.authorize(call("dup", "replace"))).toBeUndefined();
		gateway.startToolCall("dup");
		gateway.endToolCall("dup");
		answer = "Deny";
		expect((await gateway.authorize(call("other", "replace")))?.block).toBe(true);
		gateway.endToolCall("dup");
		expect(await gateway.authorize(call("later", "replace"))).toBeUndefined();
	});
	it("rechecks the file after the trust prompt", async () => {
		gateway = new PermissionGateway({
			getMode: () => "accept-edits",
			getCwd: () => root,
			getSessionId: () => "test",
			checkpointRoot: store,
			canRequestEditTrust: () => true,
			getPrompter: () => ({
				select: async (title) => {
					if (title.startsWith("Trust automatic edits")) {
						writeFileSync(join(root, "file.txt"), "changed during prompt\n");
						return "Trust edits for this session";
					}
					return "Deny";
				},
			}),
		});
		expect((await gateway.authorize(call("changed", "replace")))?.block).toBe(true);
	});

	it("asks instead of auto-approving a replaced edit tool, or an edit whose text is not in the file", async () => {
		answer = "Deny";
		expect((await gateway.authorize(call("custom", undefined)))?.block).toBe(true);
		writeFileSync(join(root, "file.txt"), "something else\n");
		expect((await gateway.authorize(call("stale", "replace")))?.block).toBe(true);
		expect(prompts).toHaveLength(2);
	});

	it("keeps the file as it was before the edit, and allows an edit of an already modified, untracked file", async () => {
		const first = call("one", "replace");
		expect(await gateway.authorize(first)).toBeUndefined();
		const [copy] = await gateway.checkpoints.list();
		expect(copy).toMatchObject({ id: 1, path: join(root, "file.txt"), kind: "edit" });
		expect(readFileSync(join(sessionDir(), "1.snap"), "utf8")).toBe("original\n");
		expect(gateway.audit.tail(1)[0]?.detail).toContain("copy 1 kept");
		gateway.finishToolCall("one", first.input);
		// The tool changes the file; the next edit finds it modified, in a directory that is not a repository.
		writeFileSync(join(root, "file.txt"), "changed\n");
		const second = {
			...call("two", "replace"),
			input: { path: "file.txt", edits: [{ oldText: "changed", newText: "again" }] },
		};
		expect(await gateway.authorize(second)).toBeUndefined();
		expect(readFileSync(join(sessionDir(), "2.snap"), "utf8")).toBe("changed\n");
	});

	it("asks instead of allowing an edit whose copy could not be kept", async () => {
		const blocker = join(store, "not-a-directory");
		writeFileSync(blocker, "x");
		gateway = new PermissionGateway({
			getMode: () => "accept-edits",
			getCwd: () => root,
			getSessionId: () => "test",
			checkpointRoot: blocker,
			canRequestEditTrust: () => true,
			getPrompter: () => ({
				select: async (title) => {
					prompts.push(title);
					return title.startsWith("Trust automatic edits") ? "Trust edits for this session" : "Deny";
				},
			}),
		});
		expect((await gateway.authorize(call("nocopy", "replace")))?.block).toBe(true);
		expect(readFileSync(join(root, "file.txt"), "utf8")).toBe("original\n");
		const noStore = new PermissionGateway({
			getMode: () => "accept-edits",
			getCwd: () => root,
			getSessionId: () => "test",
			canRequestEditTrust: () => true,
			getPrompter: () => undefined,
		});
		expect((await noStore.authorize(call("nostore", "replace")))?.block).toBe(true);
	});
});
