import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PermissionGateway } from "../src/core/permissions/gateway.ts";

// Issue #1: automatic edit permission must be explicit, recoverable and limited to the built-in edit tool.
describe("accept-edits permission", () => {
	let root: string;
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
		execFileSync("git", ["init", "-q", root]);
		writeFileSync(join(root, "file.txt"), "original\n");
		execFileSync("git", ["-C", root, "add", "file.txt"]);
		execFileSync("git", [
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
		prompts = [];
		answer = "Trust edits for this session";
		gateway = new PermissionGateway({
			getMode: () => "accept-edits",
			getCwd: () => root,
			getSessionId: () => "test",
			canRequestEditTrust: () => true,
			getPrompter: () => ({
				select: async (title) => {
					prompts.push(title);
					return answer;
				},
			}),
		});
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));
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
	it("rechecks the worktree after the trust prompt", async () => {
		gateway = new PermissionGateway({
			getMode: () => "accept-edits",
			getCwd: () => root,
			getSessionId: () => "test",
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

	it("asks instead of auto-approving a replaced edit tool or a dirty worktree", async () => {
		answer = "Deny";
		expect((await gateway.authorize(call("custom", undefined)))?.block).toBe(true);
		writeFileSync(join(root, "file.txt"), "changed\n");
		expect((await gateway.authorize(call("dirty", "replace")))?.block).toBe(true);
		expect(prompts).toHaveLength(2);
	});
});
