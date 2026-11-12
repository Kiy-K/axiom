import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PermissionGateway } from "../src/core/permissions/gateway.ts";

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], {
		stdio: "ignore",
	});

// Issue #1: automatic edits stay inside the clean, tracked, ordinary files of the workspace.
describe("accept-edits path and repository boundaries", () => {
	let root: string;
	let outside: string;
	let prompts: string[];
	let gateway: PermissionGateway;
	const edit = (id: string, path: string, newText = "changed") => ({
		toolName: "edit",
		toolCallId: id,
		builtinEdit: "replace" as const,
		input: { path, edits: [{ oldText: "original", newText }] },
	});
	const asked = async (path: string, newText?: string) => {
		prompts.length = 0;
		gateway.startToolCall(path);
		const verdict = await gateway.authorize(edit(path, path, newText));
		gateway.endToolCall(path);
		return { verdict, prompts: [...prompts] };
	};
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "edit-paths-"));
		outside = mkdtempSync(join(tmpdir(), "edit-outside-"));
		git(tmpdir(), "init", "-q", root);
		for (const name of ["file.txt", ".env", ".git-hooks.txt"]) writeFileSync(join(root, name), "original\n");
		mkdirSync(join(root, ".git-extra"));
		writeFileSync(join(root, ".git-extra", "inner.txt"), "original\n");
		writeFileSync(join(outside, "target.txt"), "original\n");
		symlinkSync(join(outside, "target.txt"), join(root, "link.txt"));
		symlinkSync(join(root, "file.txt"), join(root, "alias.txt"));
		git(root, "add", ".");
		git(root, "commit", "-qm", "initial");
		prompts = [];
		gateway = new PermissionGateway({
			getMode: () => "accept-edits",
			getCwd: () => root,
			getSessionId: () => "test",
			canRequestEditTrust: () => true,
			getPrompter: () => ({
				select: async (title) => {
					prompts.push(title);
					return title.startsWith("Trust automatic edits") ? "Trust edits for this session" : "Deny";
				},
			}),
		});
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
	});

	it("auto-approves an ordinary tracked file", async () => {
		expect((await asked(join(root, "file.txt"))).verdict).toBeUndefined();
	});

	it.each([
		["a secret file", () => join(root, ".env")],
		["a protected Git path", () => join(root, ".git", "config")],
		["a file outside the workspace", () => join(outside, "target.txt")],
		["a traversal out of the workspace", () => join(root, "..", "x.txt")],
		["a symlink to an outside file", () => join(root, "link.txt")],
		["a symlink to a workspace file", () => join(root, "alias.txt")],
	])("asks for %s", async (_name, path) => {
		const result = await asked(path());
		expect(result.verdict?.block).toBe(true);
		expect(result.prompts.every((title) => !title.startsWith("Trust automatic edits"))).toBe(true);
	});

	it("asks when the edit would empty the file", async () => {
		const call = edit("empty", join(root, "file.txt"));
		call.input.edits = [{ oldText: "original\n", newText: "" }];
		expect((await gateway.authorize(call))?.block).toBe(true);
	});

	it("asks for a file in a nested repository", async () => {
		const nested = join(root, "nested");
		mkdirSync(nested);
		git(tmpdir(), "init", "-q", nested);
		writeFileSync(join(nested, "n.txt"), "original\n");
		git(nested, "add", ".");
		git(nested, "commit", "-qm", "nested");
		expect((await asked(join(nested, "n.txt"))).verdict?.block).toBe(true);
	});

	it("auto-approves in a linked worktree and asks after it becomes dirty", async () => {
		const linked = join(outside, "linked");
		git(root, "worktree", "add", "-q", linked);
		const linkedGateway = new PermissionGateway({
			getMode: () => "accept-edits",
			getCwd: () => linked,
			getSessionId: () => "linked",
			canRequestEditTrust: () => true,
			getPrompter: () => ({
				select: async (title) =>
					title.startsWith("Trust automatic edits") ? "Trust edits for this session" : "Deny",
			}),
		});
		linkedGateway.startToolCall("a");
		expect(await linkedGateway.authorize(edit("a", join(linked, "file.txt")))).toBeUndefined();
		linkedGateway.endToolCall("a");
		writeFileSync(join(linked, "file.txt"), "dirty\n");
		expect((await linkedGateway.authorize(edit("b", join(linked, "file.txt"))))?.block).toBe(true);
	});

	it("stops auto-approving after trust is revoked", async () => {
		expect((await asked(join(root, "file.txt"))).verdict).toBeUndefined();
		gateway.revokeEditTrust();
		const result = await asked(join(root, "file.txt"));
		expect(result.prompts.some((title) => title.startsWith("Trust automatic edits"))).toBe(true);
	});

	it("holds one reservation, so a concurrent edit is asked about", async () => {
		const first = edit("first", join(root, "file.txt"));
		expect(await gateway.authorize(first)).toBeUndefined();
		expect((await gateway.authorize(edit("second", join(root, "file.txt"))))?.block).toBe(true);
		gateway.finishToolCall("first", first.input);
	});
});
