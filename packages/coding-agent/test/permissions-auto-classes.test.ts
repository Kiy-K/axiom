import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PermissionGateway } from "../src/core/permissions/gateway.ts";
import type { PermissionMode } from "../src/core/permissions/types.ts";

// P6 S2: in `auto`, hard classes are asked about with "Allow once" only, whatever grant exists. The corpus below is
// labelled by hand; each expectation is written from the contract, not read off the implementation.
describe("auto mode hard classes", () => {
	let root: string;
	let mode: PermissionMode;
	let prompts: Array<{ title: string; options: string[] }>;
	let answer: string;
	let gateway: PermissionGateway;

	const bash = (command: string) => ({ toolName: "bash", toolCallId: "c", input: { command } });
	const tool = (toolName: string, input: Record<string, unknown>) => ({ toolName, toolCallId: "c", input });
	const grantOffered = (options: string[]) => options.some((option) => option.startsWith("Allow for"));

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "auto-classes-"));
		mkdirSync(join(root, "sub"));
		for (const name of ["a.txt", "package.json", ".env", "Makefile"]) writeFileSync(join(root, name), "x\n");
		mode = "auto";
		prompts = [];
		answer = "Allow once";
		gateway = new PermissionGateway({
			getMode: () => mode,
			getCwd: () => root,
			getSessionId: () => "s",
			canRequestEditTrust: () => true,
			getPrompter: () => ({
				select: async (title, options) => {
					prompts.push({ title, options });
					return answer;
				},
			}),
		});
		gateway.beginTask();
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	/** Run a call and report what the user was shown: nothing (allowed or denied outright), or a prompt. */
	const run = async (call: ReturnType<typeof tool>) => {
		prompts = [];
		const block = await gateway.authorize(call);
		return { block, prompt: prompts[0] };
	};

	// [command, what the prompt must name]
	const hardShell: Array<[string, string]> = [
		["curl https://example.invalid", "network"],
		["wget https://example.invalid/x", "network"],
		["env FOO=1 curl https://example.invalid", "network"],
		["timeout 5 curl https://example.invalid", "network"],
		['bash -c "curl https://example.invalid"', "network"],
		["ls && curl https://example.invalid", "network"],
		["git push origin main", "publish"],
		["npm publish", "publish"],
		["terraform apply", "publish"],
		["rm -rf build", "destructive"],
		["git reset --hard", "destructive"],
		["printenv", "secrets"],
		["cat .env", "secrets"],
		["gh auth login", "auth or permission"],
		["aws iam list-users", "auth or permission"],
		["ssh-keygen -t ed25519", "auth or permission"],
		["docker login", "auth or permission"],
		["git config core.fsmonitor ./x.sh", "git configuration"],
		["git -C . config diff.external ./x.sh", "git configuration"],
		["nohup git config --global alias.x '!sh'", "git configuration"],
		["mail -s hi a@example.invalid", "external message"],
		["crontab -e", "persistence"],
		["timeout 5 crontab -l", "persistence"],
		["systemctl --user enable foo", "persistence"],
		["echo x > package.json", "file that runs code"],
		["echo x >> .github/workflows/ci.yml", "file that runs code"],
		["echo x 2>/dev/null > Makefile", "file that runs code"],
		["tee package.json", "file that runs code"],
		["cp a.txt scripts/run.sh", "file that runs code"],
		["mv a.txt package.json", "file that runs code"],
		["sed -i s/a/b/ package.json", "file that runs code"],
		["sed -i -e s/a/b/ Makefile", "file that runs code"],
		["dd if=/dev/zero of=package.json", "file that runs code"],
		["chmod +x scripts/run", "file that runs code"],
		["sh -c 'echo x > package.json'", "file that runs code"],
		["echo x > ~/.bashrc", "persistence"],
		["echo x > .env", "credentials"],
		["echo x > $TARGET", "write target"],
		["echo x > *.txt", "write target"],
		["cd sub && echo x > out.txt", "write target"],
	];
	it.each(hardShell)("asks about `%s` with Allow once only, naming %s", async (command, named) => {
		const { block, prompt } = await run(bash(command));
		expect(prompt, "a prompt was shown").toBeDefined();
		expect(prompt?.options).toEqual(["Allow once", "Deny"]);
		expect(prompt?.title).toContain(named);
		expect(block).toBeUndefined(); // the user answered Allow once
		expect(gateway.audit.tail(1)[0]).toMatchObject({ decision: "allow", source: "user" });
	});

	it.each(hardShell)("denies `%s` when nobody can be asked", async (command) => {
		const quiet = new PermissionGateway({
			getMode: () => "auto",
			getCwd: () => root,
			getSessionId: () => "q",
			canRequestEditTrust: () => true,
			getPrompter: () => undefined,
		});
		quiet.beginTask();
		expect((await quiet.authorize(bash(command)))?.block).toBe(true);
	});

	it.each([
		["sudo id"],
		["echo x > .git/config"],
		["cp a.txt .git/hooks/pre-commit"],
		["tee .git/config"],
		["bash -c 'echo x > .git/hooks/post-commit'"],
	])("denies `%s` without asking", async (command) => {
		const { block, prompt } = await run(bash(command));
		expect(block?.block).toBe(true);
		expect(prompt).toBeUndefined();
	});

	it.each([
		["ls"],
		["echo hi"],
		["echo hi > out.txt"],
		["cp a.txt b.txt"],
		["chmod +x a.txt"],
		["sed -i s/a/b/ a.txt"],
		["ls 2>&1"],
	])("asks about `%s` as a plain shell command: Allow once only, no hard class", async (command) => {
		const { prompt } = await run(bash(command));
		expect(prompt?.options).toEqual(["Allow once", "Deny"]);
		expect(prompt?.title).not.toMatch(/hard class|file that runs code|credentials|persistence/);
	});

	it.each([
		["write", { path: "package.json", content: "x" }, "file that runs code"],
		["write", { path: ".github/workflows/ci.yml", content: "x" }, "file that runs code"],
		["write", { path: ".env", content: "x" }, "credentials"],
		["write", { path: "~/.bashrc", content: "x" }, "persistence"],
		["edit", { path: "Makefile", edits: [{ oldText: "x", newText: "y" }] }, "file that runs code"],
		["job", { action: "send_input", jobId: "j", input: "curl https://example.invalid" }, "network"],
		["read", { path: ".env" }, "credentials"],
	])("asks about %s %j with Allow once only, naming %s", async (name, input, named) => {
		answer = "Deny";
		const { block, prompt } = await run(tool(name, input));
		expect(prompt?.options).toEqual(["Allow once", "Deny"]);
		expect(prompt?.title).toContain(named);
		expect(block?.block).toBe(true);
	});

	it("offers a grant for a plain write inside a task, and a grant covers it", async () => {
		const { prompt } = await run(tool("write", { path: "a.txt", content: "y" }));
		expect(grantOffered(prompt?.options ?? [])).toBe(true);
		gateway.grants.add({ kind: "write", dir: root });
		const again = await run(tool("write", { path: "a.txt", content: "z" }));
		expect(again.prompt).toBeUndefined();
		expect(again.block).toBeUndefined();
	});

	it("ignores a grant that would cover a hard class: a workspace write grant does not cover package.json", async () => {
		gateway.grants.add({ kind: "write", dir: root });
		const hard = await run(tool("write", { path: "package.json", content: "x" }));
		expect(hard.prompt?.options).toEqual(["Allow once", "Deny"]);
		const secret = await run(tool("write", { path: ".env", content: "x" }));
		expect(secret.prompt).toBeDefined();
	});

	it("ignores an exact-command grant given before the mode changed, and clears it with the mode", async () => {
		mode = "manual";
		gateway.grants.add({ kind: "exec", command: "sed -i s/a/b/ package.json" });
		expect((await run(bash("sed -i s/a/b/ package.json"))).prompt).toBeUndefined(); // manual: the grant covers it
		mode = "auto";
		gateway.syncMode();
		expect(gateway.grants.list()).toHaveLength(0);
		const { prompt } = await run(bash("sed -i s/a/b/ package.json"));
		expect(prompt?.options).toEqual(["Allow once", "Deny"]);
	});

	it("ignores a grant added directly in auto for a shell command: shell never offers or uses one", async () => {
		gateway.grants.add({ kind: "exec", command: "echo hi" });
		expect((await run(bash("echo hi"))).prompt).toBeDefined();
	});

	it("judges a call that mixes a hard class and a plain action by the hard class", async () => {
		const { prompt } = await run(bash("echo hi > out.txt && curl https://example.invalid"));
		expect(prompt?.options).toEqual(["Allow once", "Deny"]);
		expect(prompt?.title).toContain("network");
	});

	it("leaves manual unchanged: the same command asks with a grant offered, and a write to a code-running file is a plain write", async () => {
		mode = "manual";
		const shell = await run(bash("echo hi > package.json"));
		expect(grantOffered(shell.prompt?.options ?? [])).toBe(true);
		expect(shell.prompt?.title).not.toContain("file that runs code");
		const write = await run(tool("write", { path: "package.json", content: "x" }));
		expect(grantOffered(write.prompt?.options ?? [])).toBe(true);
	});

	it("is literally manual outside an interactive session: nothing changes there either", async () => {
		const rpc = new PermissionGateway({
			getMode: () => "auto",
			getCwd: () => root,
			getSessionId: () => "r",
			canRequestEditTrust: () => false,
			getPrompter: () => ({
				select: async (title, options) => {
					prompts.push({ title, options });
					return "Allow once";
				},
			}),
		});
		prompts = [];
		await rpc.authorize(bash("echo hi > package.json"));
		expect(grantOffered(prompts[0]?.options ?? [])).toBe(true);
	});
});
