import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PermissionGateway, type PermissionPrompter } from "../src/core/permissions/gateway.ts";
import type { PermissionMode } from "../src/core/permissions/types.ts";

interface Asked {
	title: string;
	options: string[];
}

describe("PermissionGateway", () => {
	let dir: string;
	let mode: PermissionMode;
	let answers: Array<string | undefined | Error>;
	let asked: Asked[];
	let hasPrompter: boolean;
	let warnings: string[];

	const prompter: PermissionPrompter = {
		select: async (title, options) => {
			asked.push({ title, options });
			const answer = answers.shift();
			if (answer instanceof Error) throw answer;
			return answer;
		},
	};

	const make = (auditFile?: string) =>
		new PermissionGateway({
			getMode: () => mode,
			getCwd: () => dir,
			getSessionId: () => "s1",
			getPrompter: () => (hasPrompter ? prompter : undefined),
			auditFile,
			onWarning: (message) => warnings.push(message),
		});

	const call = (toolName: string, input: Record<string, unknown>) => ({ toolName, toolCallId: "c1", input });

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "perm-gateway-"));
		mode = "manual";
		answers = [];
		asked = [];
		hasPrompter = true;
		warnings = [];
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("does nothing in unrestricted mode: no decision, no prompt, no audit entry", async () => {
		mode = "unrestricted";
		const gateway = make();
		expect(await gateway.authorize(call("bash", { command: "sudo rm -rf /" }))).toBeUndefined();
		gateway.recordUserCommand("ls");
		expect(asked).toEqual([]);
		expect(gateway.audit.tail(10)).toEqual([]);
	});

	it("applies a mode change on the next call", async () => {
		const gateway = make();
		answers = ["Deny"];
		expect((await gateway.authorize(call("bash", { command: "ls" })))?.block).toBe(true);
		mode = "unrestricted";
		expect(await gateway.authorize(call("bash", { command: "ls" }))).toBeUndefined();
	});

	it("denies a call that needs approval when nobody can be asked", async () => {
		hasPrompter = false;
		const gateway = make();
		const result = await gateway.authorize(call("write", { path: "a.txt", content: "x" }));
		expect(result?.reason).toContain("no user interface");
		expect(gateway.audit.tail(1)[0]).toMatchObject({ decision: "deny", source: "no-ui" });
	});

	it("allows reads inside the workspace without asking, and records them", async () => {
		const gateway = make();
		expect(await gateway.authorize(call("read", { path: "a.txt" }))).toBeUndefined();
		expect(asked).toEqual([]);
		expect(gateway.audit.tail(1)[0]).toMatchObject({ decision: "allow", source: "policy", toolName: "read" });
	});

	it("allow once covers one call only", async () => {
		const gateway = make();
		answers = ["Allow once", "Deny"];
		expect(await gateway.authorize(call("bash", { command: "npm test" }))).toBeUndefined();
		expect((await gateway.authorize(call("bash", { command: "npm test" })))?.reason).toContain("denied");
		expect(asked).toHaveLength(2);
	});

	it("a grant covers the same command later, nothing else, and stops when revoked", async () => {
		const gateway = make();
		answers = [undefined];
		await gateway.authorize(call("bash", { command: "npm test" }));
		const grantOption = asked[0].options.find((option) => option.startsWith("Allow for"));
		expect(grantOption).toContain("this exact command");

		answers = [grantOption];
		expect(await gateway.authorize(call("bash", { command: "npm test" }))).toBeUndefined();
		const [grant] = gateway.grants.list();

		asked = [];
		expect(await gateway.authorize(call("bash", { command: "npm test" }))).toBeUndefined();
		expect(asked).toEqual([]);
		expect(gateway.audit.tail(1)[0]).toMatchObject({ source: "grant", grantId: grant.id });

		answers = ["Deny"];
		expect((await gateway.authorize(call("bash", { command: "npm test; npm test" })))?.block).toBe(true);
		expect(asked).toHaveLength(1);

		gateway.grants.revoke(grant.id);
		answers = ["Deny"];
		expect((await gateway.authorize(call("bash", { command: "npm test" })))?.block).toBe(true);
		expect(asked).toHaveLength(2);
	});

	it("never offers a grant for a risky command, so a grant for a plain one cannot be stretched to it", async () => {
		const gateway = make();
		answers = ["Deny"];
		await gateway.authorize(call("bash", { command: "git push origin main" }));
		expect(asked[0].options).toEqual(["Allow once", "Deny"]);
		expect(asked[0].title).toContain("(shell command (publish))");
	});

	it("blocks without prompting for a privileged command and for a built-in with an unreadable input", async () => {
		const gateway = make();
		expect((await gateway.authorize(call("bash", { command: "sudo ls" })))?.reason).toContain("raises privileges");
		expect((await gateway.authorize(call("edit", { edits: [] })))?.reason).toContain("cannot be mediated");
		expect(asked).toEqual([]);
	});

	it("treats a dismissed or timed-out prompt as a denial", async () => {
		const gateway = make();
		answers = [undefined];
		expect((await gateway.authorize(call("bash", { command: "ls" })))?.reason).toContain("timed out");
		expect(gateway.audit.tail(1)[0]).toMatchObject({ decision: "deny", source: "timeout" });
	});

	it("fails closed when the prompt itself throws", async () => {
		const gateway = make();
		answers = [new Error("ui crashed")];
		const result = await gateway.authorize(call("bash", { command: "ls" }));
		expect(result?.reason).toContain("ui crashed");
		expect(gateway.audit.tail(1)[0]).toMatchObject({ decision: "deny", source: "error" });
	});

	it("gates job stdin but lets job reads and stops through", async () => {
		const gateway = make();
		expect(await gateway.authorize(call("job", { action: "list" }))).toBeUndefined();
		expect(await gateway.authorize(call("job", { action: "stop", job_id: "j" }))).toBeUndefined();
		answers = ["Deny"];
		expect(
			(await gateway.authorize(call("job", { action: "send_input", job_id: "j", input: "whoami\n" })))?.block,
		).toBe(true);
		expect(asked[0].title).toContain("run whoami");
	});

	it("asks once per tool whose effects it cannot see", async () => {
		const gateway = make();
		answers = ["Allow once"];
		expect(await gateway.authorize(call("mcp__x__deploy", {}))).toBeUndefined();
		expect(asked[0].options.some((option) => option.includes("tool mcp__x__deploy"))).toBe(true);
	});

	it("denies when the prompt ignores its timeout, and when the call is aborted meanwhile", async () => {
		const silent: PermissionPrompter = { select: () => new Promise(() => {}) };
		const gateway = new PermissionGateway({
			getMode: () => "manual",
			getCwd: () => dir,
			getSessionId: () => "s1",
			getPrompter: () => silent,
			promptTimeoutMs: 30,
		});
		const timedOut = await gateway.authorize(call("bash", { command: "ls" }));
		expect(timedOut?.reason).toContain("timed out");
		expect(gateway.audit.tail(1)[0]).toMatchObject({ decision: "deny", source: "timeout" });

		const controller = new AbortController();
		const pending = gateway.authorize(call("bash", { command: "ls" }), controller.signal);
		controller.abort();
		expect((await pending)?.block).toBe(true);
		expect(gateway.audit.tail(1)[0]).toMatchObject({ decision: "deny", source: "timeout" });
		expect(gateway.grants.list()).toEqual([]);
	});

	it("shows the whole command, however it is padded, and never offers a grant for a padded one", async () => {
		const gateway = make();
		answers = ["Deny"];
		await gateway.authorize(call("bash", { command: `echo hello${" ".repeat(450)}\n\n; python3 -c 'import os'` }));
		expect(asked[0].title).toContain("echo hello ; python3 -c 'import os'");
	});

	it("records a user-typed command as allowed without asking", () => {
		const gateway = make();
		gateway.recordUserCommand("rm -rf build");
		expect(asked).toEqual([]);
		expect(gateway.audit.tail(1)[0]).toMatchObject({ decision: "allow", source: "user-command" });
	});

	it("shows the command as written in a prompt, and redacts it only in the audit entry", async () => {
		const gateway = make();
		answers = ["Deny"];
		const command = "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123' x\n- run ls\x1b[2J";
		await gateway.authorize(call("bash", { command }));
		const [prompt] = asked;
		const [entry] = gateway.audit.tail(1);
		// The user must see everything they approve: a redacted span could hide code.
		expect(prompt.title).toContain("Bearer abcdefghijklmnopqrstuvwxyz0123' x - run ls");
		expect(prompt.title).not.toContain("\x1b");
		expect(prompt.title.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(1);
		expect(entry.detail).not.toContain("abcdefghijklmnopqrstuvwxyz0123");
		expect(entry.detail).not.toContain("\x1b");
		expect(entry.detail).not.toContain("\n");
	});

	it("does not let a credential-looking word hide the rest of a command in the prompt", async () => {
		const gateway = make();
		for (const command of [
			`echo cookie: ; python3 -c 'import os; os.system("id")'`,
			`KEY="$(python3 -c 'import os; os.system("id")')" true`,
			`curl --password=x; python3 -c 'import os'`,
		]) {
			answers = ["Deny"];
			await gateway.authorize(call("bash", { command }));
			expect(asked.at(-1)?.title).toContain("python3 -c");
		}
	});

	it("denies a call whose signal is already aborted without asking or granting", async () => {
		const gateway = make();
		answers = ["Allow for 10 minutes: this exact command"];
		const controller = new AbortController();
		controller.abort();
		const result = await gateway.authorize(call("bash", { command: "npm test" }), controller.signal);
		expect(result?.block).toBe(true);
		expect(asked).toEqual([]);
		expect(gateway.grants.list()).toEqual([]);
		expect(gateway.audit.tail(1)[0]).toMatchObject({ decision: "deny", source: "timeout" });
	});

	it("appends audit entries to a private JSONL file, and keeps deciding when the file cannot be written", async () => {
		const file = join(dir, "audit", "permissions.jsonl");
		const gateway = make(file);
		await gateway.authorize(call("read", { path: "a.txt" }));
		const lines = readFileSync(file, "utf-8").trim().split("\n");
		expect(JSON.parse(lines[0])).toMatchObject({ sessionId: "s1", toolName: "read", decision: "allow" });
		expect(statSync(file).mode & 0o777).toBe(0o600);

		// A directory where the file should be makes every append fail.
		const broken = join(dir, "broken");
		mkdirSync(broken);
		const failing = make(broken);
		expect(await failing.authorize(call("read", { path: "a.txt" }))).toBeUndefined();
		expect(warnings[0]).toContain("audit log write failed");
	});
});
