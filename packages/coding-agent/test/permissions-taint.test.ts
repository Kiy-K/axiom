import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PermissionGateway, TAINT_ASK_BUDGET } from "../src/core/permissions/gateway.ts";
import type { PermissionMode } from "../src/core/permissions/types.ts";

// P6: once content the user did not write entered a task, relaxed prompts tighten until the user's next prompt.
describe("untrusted content in a task", () => {
	let root: string;
	let outside: string;
	let store: string;
	let mode: PermissionMode;
	let asked: string[][];
	let choose: (options: string[]) => string | undefined;
	let gateway: PermissionGateway;

	const call = (toolName: string, input: Record<string, unknown>, id = `${toolName}-${Math.random()}`) => ({
		toolName,
		toolCallId: id,
		input,
	});
	/** Authorize, then finish the call the way the session does when its result is in. */
	const run = async (toolName: string, input: Record<string, unknown>) => {
		const request = call(toolName, input);
		const block = await gateway.authorize(request);
		if (!block) gateway.finishToolCall(request.toolCallId, input);
		return block;
	};
	const edit = (path: string, id: string) => ({
		toolName: "edit",
		toolCallId: id,
		builtinEdit: "replace" as const,
		input: { path, edits: [{ oldText: "original", newText: "changed" }] },
	});

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "taint-"));
		outside = mkdtempSync(join(tmpdir(), "taint-out-"));
		store = mkdtempSync(join(tmpdir(), "taint-store-"));
		writeFileSync(join(root, "a.txt"), "original\n");
		writeFileSync(join(outside, "x.txt"), "x\n");
		mode = "accept-edits";
		asked = [];
		choose = (options) => options.find((option) => option === "Trust edits for this session") ?? "Allow once";
		gateway = new PermissionGateway({
			getMode: () => mode,
			getCwd: () => root,
			getSessionId: () => "s",
			checkpointRoot: store,
			canRequestEditTrust: () => true,
			getPrompter: () => ({
				select: async (_title, options) => {
					asked.push(options);
					return choose(options);
				},
			}),
		});
		gateway.beginTask();
	});

	afterEach(() => {
		for (const dir of [root, outside, store]) rmSync(dir, { recursive: true, force: true });
	});

	it("allows a trusted edit until an extension tool's result arrives, then asks for every edit", async () => {
		const first = edit(join(root, "a.txt"), "e1");
		expect(await gateway.authorize(first)).toBeUndefined();
		gateway.finishToolCall("e1", first.input);
		expect(gateway.untrustedSource).toBeUndefined();

		await run("some_mcp_tool", {});
		expect(gateway.untrustedSource).toContain("some_mcp_tool");

		choose = () => "Deny";
		writeFileSync(join(root, "a.txt"), "original\n");
		expect((await gateway.authorize(edit(join(root, "a.txt"), "e2")))?.block).toBe(true);
	});

	it("does not taint on a read inside the workspace, and a new task clears the taint", async () => {
		await run("read", { path: "a.txt" });
		expect(gateway.untrustedSource).toBeUndefined();
		await run("read", { path: join(outside, "x.txt") });
		expect(gateway.untrustedSource).toBe("a file outside the workspace");
		gateway.beginTask();
		expect(gateway.untrustedSource).toBeUndefined();
	});

	it("taints on the output of a network command and on job output after one", async () => {
		choose = () => "Allow once";
		await run("bash", { command: "curl https://example.invalid" });
		expect(gateway.untrustedSource).toBe("the output of a network command");
		// A job the command started can print in a later task, so reading it taints that task too.
		gateway.beginTask();
		expect(gateway.untrustedSource).toBeUndefined();
		await run("bash", { command: "echo hi" });
		expect(gateway.untrustedSource).toBeUndefined();
		await run("job", { action: "list" });
		expect(gateway.untrustedSource).toBeUndefined();
		await run("job", { action: "output", jobId: "j" });
		expect(gateway.untrustedSource).toBe("background job output after a network command");
	});

	it("is off in manual and yolo, where nothing is relaxed", async () => {
		mode = "manual";
		await run("some_mcp_tool", {});
		expect(gateway.untrustedSource).toBeUndefined();
	});

	it("ignores live grants and offers none once tainted", async () => {
		mode = "auto";
		choose = (options) => options.find((option) => option.startsWith("Allow for")) ?? "Allow once";
		await run("bash", { command: "ls" });
		expect(gateway.grants.list()).toHaveLength(1);
		await run("some_mcp_tool", {});
		asked = [];
		choose = () => "Allow once";
		expect(await run("bash", { command: "ls" })).toBeUndefined();
		expect(asked).toHaveLength(1);
		expect(asked[0]?.some((option) => option.startsWith("Allow for"))).toBe(false);
	});

	it(`denies without prompting after ${TAINT_ASK_BUDGET} approval prompts in a tainted task`, async () => {
		mode = "auto";
		await run("some_mcp_tool", {});
		asked = [];
		choose = () => "Allow once";
		for (let i = 0; i < TAINT_ASK_BUDGET; i++) expect(await run("bash", { command: `echo ${i}` })).toBeUndefined();
		const blocked = await run("bash", { command: "echo more" });
		expect(blocked?.block).toBe(true);
		expect(blocked?.reason).toContain("approval budget");
		expect(asked).toHaveLength(TAINT_ASK_BUDGET);
		expect(gateway.audit.tail(1)[0]).toMatchObject({ decision: "deny", source: "taint-budget" });
		// The user's next prompt starts over.
		gateway.beginTask();
		expect(await run("bash", { command: "echo again" })).toBeUndefined();
	});

	it("keeps the budget out of manual mode", async () => {
		mode = "manual";
		choose = () => "Allow once";
		await run("some_mcp_tool", {});
		for (let i = 0; i < TAINT_ASK_BUDGET + 2; i++)
			expect(await run("bash", { command: `echo ${i}` })).toBeUndefined();
	});

	it("names the untrusted source in the prompt", async () => {
		const titles: string[] = [];
		let answer = "Allow once";
		gateway = new PermissionGateway({
			getMode: () => mode,
			getCwd: () => root,
			getSessionId: () => "s",
			canRequestEditTrust: () => true,
			getPrompter: () => ({
				select: async (title) => {
					titles.push(title);
					return answer;
				},
			}),
		});
		gateway.beginTask();
		await gateway.authorize(call("some_mcp_tool", {}, "m1"));
		gateway.finishToolCall("m1", {});
		titles.length = 0;
		answer = "Deny";
		await gateway.authorize(call("bash", { command: "echo" }));
		expect(titles[0]).toContain("Untrusted content entered this task");
	});
	it("sets the mark when the call finishes, not when it is authorized, so an edit in the same batch is not shaped by it", async () => {
		const fetch = call("some_mcp_tool", {}, "t1");
		choose = () => "Allow once";
		expect(await gateway.authorize(fetch)).toBeUndefined();
		expect(gateway.untrustedSource).toBeUndefined();
		const sibling = edit(join(root, "a.txt"), "e1");
		expect(await gateway.authorize(sibling)).toBeUndefined();
		gateway.finishToolCall("t1", fetch.input);
		expect(gateway.untrustedSource).toContain("some_mcp_tool");
	});

	it("leaves no mark when the call is aborted before its result arrives", async () => {
		const fetch = call("some_mcp_tool", {}, "t2");
		choose = () => "Allow once";
		gateway.startToolCall("t2");
		await gateway.authorize(fetch);
		gateway.endToolCall("t2");
		gateway.finishToolCall("t2", fetch.input);
		expect(gateway.untrustedSource).toBeUndefined();
	});

	it("keeps the mark through a run that is not a user task, and through a mode switch, until the next user prompt", async () => {
		await run("some_mcp_tool", {});
		gateway.endTask();
		expect(gateway.untrustedSource).toContain("some_mcp_tool");
		mode = "auto";
		expect(gateway.untrustedSource).toContain("some_mcp_tool");
		mode = "accept-edits";
		expect(gateway.untrustedSource).toContain("some_mcp_tool");
		gateway.beginTask();
		expect(gateway.untrustedSource).toBeUndefined();
	});

	it("does not spend the budget on an extension's exec or a provider command", async () => {
		mode = "auto";
		await run("some_mcp_tool", {});
		choose = () => "Allow once";
		for (let i = 0; i < TAINT_ASK_BUDGET + 2; i++)
			expect(
				await gateway.authorizeExec("echo", [String(i)], { cwd: root, extensionPath: "/ext.ts" }),
			).toBeUndefined();
		// The model's own asks still have their full budget.
		for (let i = 0; i < TAINT_ASK_BUDGET; i++) expect(await run("bash", { command: `echo ${i}` })).toBeUndefined();
		expect((await run("bash", { command: "echo more" }))?.block).toBe(true);
	});
});
