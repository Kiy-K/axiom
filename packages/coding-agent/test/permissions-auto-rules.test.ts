import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PermissionGateway } from "../src/core/permissions/gateway.ts";

// P6 S3: the positive rules of `auto` (`readonly-shell`, `trusted-recoverable-edit`) at gateway level. The grammar
// itself is tested in permissions-shell-grammar.test.ts.
describe("auto mode positive rules", () => {
	let root: string;
	let store: string;
	let interactive: boolean;
	let customizedShell: boolean;
	let prompts: Array<{ title: string; options: string[] }>;
	let answer: string;
	let gateway: PermissionGateway;
	const bash = (command: string) => ({ toolName: "bash", toolCallId: "c", input: { command } });
	const edit = (path: string) => ({
		toolName: "edit",
		toolCallId: "e",
		builtinEdit: "replace" as const,
		input: { path, edits: [{ oldText: "x", newText: "y" }] },
	});
	const make = (getMode: () => "manual" | "accept-edits" | "auto" = () => "auto") =>
		new PermissionGateway({
			getMode,
			getCwd: () => root,
			getSessionId: () => "s",
			canRequestEditTrust: () => interactive,
			shellIsCustomized: () => customizedShell,
			checkpointRoot: store,
			getPrompter: () => ({
				select: async (title, options) => {
					prompts.push({ title, options });
					return answer;
				},
			}),
		});

	/** Authorize an edit and finish it, which frees the gateway's reservation (it holds one edit at a time). */
	const settle = async (path: string) => {
		const call = edit(path);
		const block = await gateway.authorize(call);
		gateway.finishToolCall("e", call.input);
		return block;
	};

	beforeEach(() => {
		vi.stubEnv("PATH", "/usr/bin:/bin");
		root = mkdtempSync(join(tmpdir(), "auto-rules-"));
		store = mkdtempSync(join(tmpdir(), "auto-rules-store-"));
		mkdirSync(join(root, "sub"));
		for (const name of ["a.txt", "package.json", ".bashrc"]) writeFileSync(join(root, name), "x\n");
		interactive = true;
		customizedShell = false;
		prompts = [];
		answer = "Deny";
		gateway = make();
		gateway.beginTask();
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
		rmSync(store, { recursive: true, force: true });
	});

	describe("readonly-shell", () => {
		it("allows read-only commands without a prompt and audits the rule", async () => {
			for (const command of ["ls", "ls | wc -l", "head -n 3 a.txt", "pwd && ls sub"])
				expect(await gateway.authorize(bash(command)), command).toBeUndefined();
			expect(prompts).toEqual([]);
			expect(gateway.audit.tail(1)[0]).toMatchObject({ decision: "allow", source: "auto" });
			expect(gateway.audit.tail(1)[0].detail).toMatch(/^readonly-shell: /);
		});

		it("asks for anything else, and never offers a grant for a shell command", async () => {
			for (const command of [
				"ls && curl https://example.invalid",
				"ls > f",
				"npm test",
				"./ls",
				"git status",
				"cat a.txt",
			]) {
				prompts = [];
				expect((await gateway.authorize(bash(command)))?.block, command).toBe(true);
				expect(prompts, command).toHaveLength(1);
				expect(prompts[0].options, command).toEqual(["Allow once", "Deny"]);
			}
		});

		it("is judged by the hard class when a call mixes it with a read-only command", async () => {
			answer = "Allow once";
			expect(await gateway.authorize(bash("ls && curl https://example.invalid"))).toBeUndefined();
			expect(prompts[0].title).toContain("network");
			expect(gateway.audit.tail(1)[0]).toMatchObject({ source: "user" });
		});

		it("applies only to the model's own bash call, not to job stdin or pi.exec", async () => {
			expect(
				(
					await gateway.authorize({
						toolName: "job",
						toolCallId: "j",
						input: { action: "send_input", jobId: "x", input: "ls" },
					})
				)?.block,
			).toBe(true);
			expect((await gateway.authorizeExec("ls", [], { cwd: root, extensionPath: "/ext.ts" }))?.block).toBe(true);
			expect(prompts).toHaveLength(2);
		});

		it("is off when settings change the shell, when PATH is unsafe, outside a TUI and in manual", async () => {
			customizedShell = true;
			expect((await gateway.authorize(bash("ls")))?.block).toBe(true);
			customizedShell = false;
			vi.stubEnv("PATH", `/usr/bin:${root}`);
			expect((await gateway.authorize(bash("ls")))?.block).toBe(true);
			vi.stubEnv("PATH", "/usr/bin:/bin");
			expect(await gateway.authorize(bash("ls"))).toBeUndefined();
			interactive = false; // auto is literally manual here
			expect((await gateway.authorize(bash("ls")))?.block).toBe(true);
			interactive = true;
			const manual = make(() => "manual");
			expect((await manual.authorize(bash("ls")))?.block).toBe(true);
		});

		it("still reads protected and credentials paths only after a prompt", async () => {
			writeFileSync(join(root, ".env"), "SECRET=1\n");
			for (const command of ["ls .env", "head .env"]) {
				prompts = [];
				expect((await gateway.authorize(bash(command)))?.block, command).toBe(true);
				expect(prompts, command).toHaveLength(1);
			}
		});
	});

	describe("trusted-recoverable-edit", () => {
		it("also asks in accept-edits for a persistence path (the shared edit rule is stricter than before S3)", async () => {
			const acceptEdits = make(() => "accept-edits");
			answer = "Trust edits for this session";
			const first = edit("a.txt");
			expect(await acceptEdits.authorize(first)).toBeUndefined();
			acceptEdits.finishToolCall("e", first.input);
			writeFileSync(join(root, "b.txt"), "x\n");
			const second = edit("b.txt");
			expect(await acceptEdits.authorize(second)).toBeUndefined(); // control: nothing is left reserved
			acceptEdits.finishToolCall("e", second.input);
			prompts = [];
			answer = "Deny";
			expect((await acceptEdits.authorize(edit(".bashrc")))?.block).toBe(true);
			expect(prompts).toHaveLength(1);
		});

		it("does not use a trust answer that arrived after the mode left auto and came back", async () => {
			let mode: "manual" | "auto" = "auto";
			const titles: string[] = [];
			const trusting = new PermissionGateway({
				getMode: () => mode,
				getCwd: () => root,
				getSessionId: () => "s",
				canRequestEditTrust: () => true,
				checkpointRoot: store,
				getPrompter: () => ({
					select: async (title, options) => {
						// Only the first prompt (the trust question) sees the round trip.
						if (titles.push(title) === 1) {
							mode = "manual";
							trusting.syncMode();
							mode = "auto";
							trusting.syncMode();
						}
						return options[0];
					},
				}),
			});
			const first = edit("a.txt");
			// The trust answer is dropped, so the edit goes through the ordinary ask ("Allow once" is the first choice).
			expect(await trusting.authorize(first)).toBeUndefined();
			expect(titles[0]).toContain("Trust automatic edits");
			expect(trusting.audit.tail(1)[0]).toMatchObject({ source: "user" });
			trusting.finishToolCall("e", first.input);
			expect(trusting.editTrustActive).toBe(false);
			// A wrong implementation keeps the trust and allows this one with no prompt.
			titles.length = 0;
			expect(await trusting.authorize(edit("a.txt"))).toBeUndefined();
			expect(titles[0]).toContain("Trust automatic edits");
		});

		it("drops edit trust when the mode leaves auto and comes back", async () => {
			let mode: "manual" | "auto" = "auto";
			const switching = make(() => mode);
			answer = "Trust edits for this session";
			const call = edit("a.txt");
			expect(await switching.authorize(call)).toBeUndefined();
			// The same input object releases the edit's open file; a fresh one would leak it.
			switching.finishToolCall("e", call.input);
			expect(switching.editTrustActive).toBe(true);
			mode = "manual";
			expect(switching.editTrustActive).toBe(false);
			mode = "auto";
			expect(switching.editTrustActive).toBe(false);
		});

		// Issue #1: a file changed while its checkpoint is saved must not be auto-approved.
		it("rechecks the file after saving the checkpoint", async () => {
			const save = gateway.checkpoints.save.bind(gateway.checkpoints);
			vi.spyOn(gateway.checkpoints, "save").mockImplementation(async (...args) => {
				const checkpoint = await save(...args);
				writeFileSync(join(root, "a.txt"), "changed\n");
				return checkpoint;
			});
			answer = "Trust edits for this session";
			await gateway.authorize(edit("a.txt"));
			expect(gateway.audit.tail(1)[0].source).not.toBe("auto");
		});

		// Issue #1: tightening the mode while a checkpoint is saved must not authorize the edit.
		it("rechecks the mode after saving the checkpoint", async () => {
			let mode: "manual" | "auto" = "auto";
			const switching = make(() => mode);
			const save = switching.checkpoints.save.bind(switching.checkpoints);
			vi.spyOn(switching.checkpoints, "save").mockImplementation(async (...args) => {
				const checkpoint = await save(...args);
				mode = "manual";
				return checkpoint;
			});
			answer = "Trust edits for this session";
			await switching.authorize(edit("a.txt"));
			expect(switching.audit.tail(1)[0].source).not.toBe("auto");
		});
		// Issue #1: the file may become executable while the trust prompt is open.
		it("rechecks executable permissions after the trust prompt", async () => {
			const trusting = new PermissionGateway({
				getMode: () => "auto",
				getCwd: () => root,
				getSessionId: () => "s",
				canRequestEditTrust: () => true,
				checkpointRoot: store,
				getPrompter: () => ({
					select: async (_title, options) => {
						if (options.includes("Trust edits for this session")) chmodSync(join(root, "a.txt"), 0o755);
						return options[0];
					},
				}),
			});
			await trusting.authorize(edit("a.txt"));
			expect(trusting.audit.tail(1)[0].source).not.toBe("auto");
		});

		it("allows a built-in edit after session trust, keeps a copy, and audits the rule", async () => {
			answer = "Trust edits for this session";
			const call = edit("a.txt");
			expect(await gateway.authorize(call)).toBeUndefined();
			expect(prompts).toHaveLength(1);
			expect(gateway.editTrustActive).toBe(true);
			expect(gateway.audit.tail(1)[0]).toMatchObject({ decision: "allow", source: "auto" });
			expect(gateway.audit.tail(1)[0].detail).toMatch(/^trusted-recoverable-edit: .*copy \d+ kept/);
			gateway.finishToolCall("e", call.input);
		});

		it("asks for instruction files, other agents' settings, task runners and executable scripts", async () => {
			answer = "Trust edits for this session";
			expect(await settle("a.txt")).toBeUndefined();
			writeFileSync(join(root, "b.txt"), "x\n");
			expect(await settle("b.txt")).toBeUndefined(); // control: nothing is left reserved, so an ordinary file passes
			writeFileSync(join(root, "deploy"), "x\n", { mode: 0o755 });
			for (const path of [
				"AGENTS.override.md",
				".lefthook.yml",
				".mise.toml",
				"mise.local.toml",
				"compose.yaml",
				".codex/config.toml",
				".gemini/settings.json",
				"opencode.json",
				"GEMINI.md",
				"deploy",
			]) {
				mkdirSync(join(root, path, ".."), { recursive: true });
				if (path !== "deploy") writeFileSync(join(root, path), "x\n");
				prompts = [];
				answer = "Deny";
				expect((await settle(path))?.block, path).toBe(true);
				expect(prompts, path).toHaveLength(1);
			}
		});

		it("asks for files that run code or persist, even with trust", async () => {
			answer = "Trust edits for this session";
			expect(await settle("a.txt")).toBeUndefined();
			writeFileSync(join(root, "b.txt"), "x\n");
			expect(await settle("b.txt")).toBeUndefined(); // control: nothing is left reserved
			for (const path of [
				"package.json",
				".bashrc",
				".bash_aliases",
				".gitconfig",
				".inputrc",
				".config/git/config",
				".config/fish/config.fish",
			]) {
				mkdirSync(join(root, path, ".."), { recursive: true });
				writeFileSync(join(root, path), "x\n");
				prompts = [];
				answer = "Deny";
				expect((await settle(path))?.block, path).toBe(true);
				expect(prompts[0].options, path).toEqual(["Allow once", "Deny"]);
			}
		});
	});
});
