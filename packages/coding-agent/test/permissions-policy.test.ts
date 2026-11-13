import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { GrantStore } from "../src/core/permissions/grants.ts";
import { classifyPath } from "../src/core/permissions/paths.ts";
import { actionsForToolCall, execAction, judgeAction } from "../src/core/permissions/policy.ts";
import { redactSecrets, sanitizeForDisplay, stripControlSequences } from "../src/core/permissions/redact.ts";
import { classifyShellCommand } from "../src/core/permissions/shell.ts";
import type { Action } from "../src/core/permissions/types.ts";

describe("permission policy on paths", () => {
	let base: string;
	let ws: string;
	let outside: string;

	beforeEach(() => {
		base = realpathSync(mkdtempSync(join(tmpdir(), "perm-policy-")));
		ws = join(base, "ws");
		outside = join(base, "outside");
		mkdirSync(join(ws, ".git", "hooks"), { recursive: true });
		mkdirSync(join(ws, "src"), { recursive: true });
		mkdirSync(outside);
		writeFileSync(join(ws, "a.txt"), "a");
		writeFileSync(join(outside, "target.txt"), "t");
		vi.stubEnv(ENV_AGENT_DIR, join(base, "agent"));
	});

	afterEach(() => {
		rmSync(base, { recursive: true, force: true });
	});

	/** The strictest verdict over every action the call has. */
	const verdictFor = (tool: string, input: Record<string, unknown>, cwd = ws) => {
		const rank = { allow: 0, ask: 1, deny: 2 };
		const judged = actionsForToolCall(tool, input, cwd).map((action) => ({ action, verdict: judgeAction(action) }));
		return judged.reduce((worst, next) =>
			rank[next.verdict.decision] > rank[worst.verdict.decision] ? next : worst,
		);
	};

	it("allows a read inside the workspace and asks for edits there with a workspace-wide grant offered", () => {
		expect(verdictFor("read", { path: "a.txt" }).verdict.decision).toBe("allow");
		const edit = verdictFor("edit", { path: "src/new.ts" }).verdict;
		expect(edit).toMatchObject({ decision: "ask", grantable: { kind: "write", dir: ws } });
	});

	it("treats a path through a symlink to the outside as outside, even for a file that does not exist yet", () => {
		symlinkSync(outside, join(ws, "link"));
		symlinkSync(join(outside, "target.txt"), join(ws, "file-link"));
		expect(verdictFor("write", { path: "link/new.txt" }).verdict).toMatchObject({
			decision: "ask",
			reason: "writes outside the workspace",
		});
		expect(verdictFor("read", { path: "file-link" }).verdict.reason).toBe("reads outside the workspace");
		expect(verdictFor("read", { path: "../outside/target.txt" }).verdict.decision).toBe("ask");
	});

	it("denies writes to git hooks and to the agent directory but not to a workspace that merely sits under such a name", () => {
		expect(verdictFor("write", { path: ".git/hooks/pre-commit" }).verdict.decision).toBe("deny");
		expect(verdictFor("write", { path: join(base, "agent", "settings.json") }).verdict.decision).toBe("deny");

		const nested = join(base, ".git-parent", ".pi", "proj");
		mkdirSync(nested, { recursive: true });
		expect(verdictFor("write", { path: "x.ts" }, nested).verdict.decision).toBe("ask");
	});

	it("asks about credentials files and never offers a grant for them, but not about .env.example", () => {
		for (const [tool, path] of [
			["read", ".env"],
			["write", ".env.local"],
			["read", join(outside, ".ssh", "id_rsa")],
		] as const) {
			const { verdict } = verdictFor(tool, { path });
			expect(verdict.decision).toBe("ask");
			expect(verdict.grantable).toBeUndefined();
		}
		expect(verdictFor("read", { path: ".env.example" }).verdict.decision).toBe("allow");
	});

	it("defaults ls, find and grep to the working directory and denies a built-in whose input lost its path", () => {
		expect(verdictFor("ls", { path: "a.txt" }).verdict.decision).toBe("allow");
		expect(verdictFor("grep", { pattern: "x", path: "a.txt" }).verdict.decision).toBe("allow");
		expect(verdictFor("grep", { pattern: "x", path: outside }).verdict.decision).toBe("ask");
		expect(verdictFor("read", {}).verdict.decision).toBe("deny");
		expect(verdictFor("write", { path: 42 }).verdict.decision).toBe("deny");
	});

	it("asks, without a grant, for a search over a directory that may hold credentials", () => {
		writeFileSync(join(ws, ".env"), "TOKEN=1");
		for (const [tool, input] of [
			["grep", { pattern: "x" }],
			["ls", {}],
			["find", { pattern: "*" }],
			["grep", { pattern: "x", path: "src" }],
		] as const) {
			const { verdict } = verdictFor(tool, input);
			expect(verdict.decision, tool).toBe("ask");
			expect(verdict.grantable, tool).toBeUndefined();
		}
	});

	it("follows a dangling symlink to where a write through it would land", () => {
		symlinkSync(".git/hooks/pre-commit", join(ws, "innocent.txt"));
		symlinkSync("../outside/new.txt", join(ws, "to-outside.txt"));
		symlinkSync("missing-dir", join(ws, "dangling-dir"));
		symlinkSync(join(ws, ".git"), join(ws, "abs-link"));
		expect(verdictFor("write", { path: "innocent.txt" }).verdict.decision).toBe("deny");
		expect(verdictFor("write", { path: "to-outside.txt" }).verdict.reason).toBe("writes outside the workspace");
		expect(verdictFor("write", { path: "dangling-dir/x.txt" }).verdict.reason).toBe("edits a file");
		// A chain through a dangling link into the git directory.
		symlinkSync("abs-link/hooks/post-merge", join(ws, "chain.txt"));
		expect(verdictFor("write", { path: "chain.txt" }).verdict.decision).toBe("deny");
	});

	it("resolves a relative dangling link against the real directory that holds it", () => {
		// ws/a/b/link -> ../.. is ws itself; dl -> ../escape.txt written through it lands one level above ws.
		mkdirSync(join(ws, "a", "b"), { recursive: true });
		symlinkSync("../..", join(ws, "a", "b", "link"));
		symlinkSync("../escape.txt", join(ws, "dl"));
		symlinkSync("../outside/new.txt", join(ws, "d2"));
		expect(classifyPath("a/b/link/dl", ws)?.real).toBe(join(base, "escape.txt"));
		expect(verdictFor("write", { path: "a/b/link/dl" }).verdict.reason).toBe("writes outside the workspace");
		expect(verdictFor("write", { path: "a/b/link/d2" }).verdict.reason).toBe("writes outside the workspace");
	});

	it("judges both names hashline edit may open when one is a curly-quote link to a file outside", () => {
		const secret = join(outside, "target.txt");
		symlinkSync(secret, join(ws, "notes\u2019s.txt"));
		const actions = actionsForToolCall("edit", { path: "notes's.txt" }, ws);
		expect(actions.some((action) => action.kind === "write" && !action.path.inWorkspace)).toBe(true);
		const reasons = actions.map((action) => judgeAction(action).reason);
		expect(reasons).toContain("writes outside the workspace");
	});

	it("denies a symlink chain longer than the hop limit", () => {
		for (let i = 0; i < 45; i++) symlinkSync(`hop${i + 1}`, join(ws, `hop${i}`));
		expect(classifyPath("hop0", ws)).toBeUndefined();
	});

	it("judges the file read opens when the name exists only in a curly-quote variant", () => {
		const secret = join(outside, "id_rsa");
		writeFileSync(secret, "key");
		symlinkSync(secret, join(ws, "notes\u2019s.txt"));
		const { verdict } = verdictFor("read", { path: "notes's.txt" });
		expect(verdict.decision).toBe("ask");
		expect(verdict.grantable).toBeUndefined();
	});

	it("denies a path it cannot resolve", () => {
		symlinkSync(join(ws, "loop-b"), join(ws, "loop-a"));
		symlinkSync(join(ws, "loop-a"), join(ws, "loop-b"));
		expect(classifyPath("loop-a/x", ws)).toBeUndefined();
		expect(verdictFor("read", { path: "loop-a/x" }).verdict.decision).toBe("deny");
	});
});

describe("permission policy on tools", () => {
	it("asks for shell, grants only the exact command, and denies privilege escalation", () => {
		const plain = judgeAction(execAction("npm test"));
		expect(plain).toMatchObject({ decision: "ask", grantable: { kind: "exec", command: "npm test" } });
		expect(judgeAction(execAction("sudo npm test")).decision).toBe("deny");
	});

	it("denies a command longer than the prompt can show instead of hiding its end", () => {
		const padded = `echo hello${" ".repeat(450)}; python3 -c 'import os; os.system("id")'`;
		expect(judgeAction(execAction(padded)).decision).toBe("ask");
		const hidden = `echo hello; ${"echo x; ".repeat(400)}python3 -c 'import os'`;
		expect(judgeAction(execAction(hidden)).decision).toBe("deny");
	});

	it("denies a command too long to scan without scanning it", () => {
		const started = performance.now();
		expect(judgeAction(execAction(`;${" ".repeat(500_000)}echo`)).decision).toBe("deny");
		expect(performance.now() - started).toBeLessThan(200);
	});

	it("offers no grant for a command with a named risk", () => {
		for (const command of ["git push origin main", "curl https://example.com", "rm -rf build", "cat .env"]) {
			const verdict = judgeAction(execAction(command));
			expect(verdict.decision).toBe("ask");
			expect(verdict.grantable, command).toBeUndefined();
		}
	});

	it("gates job stdin but not job reads, and asks for tools it knows nothing about", () => {
		expect(actionsForToolCall("job", { action: "list" }, "/")).toEqual([]);
		expect(actionsForToolCall("job", { action: "output", job_id: "j" }, "/")).toEqual([]);
		const [stdin] = actionsForToolCall("job", { action: "send_input", job_id: "j", input: "rm -rf /\n" }, "/");
		expect(stdin).toMatchObject({ kind: "exec" });
		expect(judgeAction(stdin).decision).toBe("ask");
		expect(judgeAction(actionsForToolCall("mcp__x__do", {}, "/")[0])).toMatchObject({
			decision: "ask",
			grantable: { kind: "extension", toolName: "mcp__x__do" },
		});
	});
});

describe("shell risk classification", () => {
	it.each([
		["ls -la", []],
		["git status", []],
		["npm test", []],
		["env FOO=1 make", []],
		["cat docs/credentials.md .env.example", []],
		["echo env", []],
		['r"m" -rf build', ["destructive"]],
		["git push origin main", ["publish"]],
		["git push --force origin main", ["publish", "destructive"]],
		["git reset --hard HEAD~1", ["destructive"]],
		["git reset --soft HEAD~1", []],
		["echo hi && curl http://x.test", ["network"]],
		["echo $(wget -qO- http://x.test)", ["network"]],
		["cat < /dev/tcp/10.0.0.1/80", ["network"]],
		["sudo id", ["privilege"]],
		["echo go && sudo id", ["privilege"]],
		["env FOO=1 timeout 5 sudo id", ["privilege"]],
		["bash -c 'sudo id'", ["privilege"]],
		['git commit -m "remove sudo usage"', []],
		["grep -rn su src", ["elevation"]],
		["echo sudo", ["elevation"]],
		["command -v sudo", ["elevation"]],
		["find . -exec sudo rm {} \\;", ["elevation", "destructive"]],
		["git -C . push", ["publish"]],
		["git -c x=y push origin main", ["publish"]],
		["cat ~/.ssh/id_rsa", ["secrets"]],
		["cat .env", ["secrets"]],
		["cat /proc/self/environ", ["secrets"]],
		["echo go; printenv", ["secrets"]],
		["env | sort", ["secrets"]],
		["npm publish", ["publish"]],
		["pip install requests", ["network"]],
	])("%s", (command, expected) => {
		const risks = classifyShellCommand(command);
		for (const risk of expected) expect(risks).toContain(risk);
		expect(risks.filter((risk) => risk !== "opaque").length).toBe(expected.length);
	});

	it.each([
		"{ sudo id; }",
		"if true; then sudo id; fi",
		"! sudo id",
		"while true; do sudo id; done",
		"env -u X sudo id",
		"timeout -s KILL 5 sudo id",
		"bash --login -c 'sudo id'",
		"find . -exec sudo rm {} \\;",
		"eval sudo id",
	])("never lets %s through with no privilege label", (command) => {
		const risks = classifyShellCommand(command);
		expect(risks.includes("privilege") || risks.includes("elevation")).toBe(true);
	});

	// Found by the P6 S4 replay: a word such as `constructor` used to find a function on Object.prototype in the
	// subcommand tables, so `grep "constructor" f` threw and the gateway denied it as "Permission check failed".
	it("reads words that are names on Object.prototype as ordinary arguments", () => {
		for (const word of ["constructor", "toString", "hasOwnProperty", "__proto__", "valueOf"]) {
			expect(classifyShellCommand(`grep ${word} a.ts`), word).toEqual([]);
			expect(classifyShellCommand(`${word} a.ts`), word).toEqual([]);
			expect(classifyShellCommand(`git ${word} a.ts`), word).toEqual([]);
		}
	});

	it("does not call a quoted word that merely contains sudo a privilege", () => {
		expect(classifyShellCommand('git commit -m "fix; sudo thing"')).toEqual([]);
		expect(classifyShellCommand("echo 'a; sudo b'")).toEqual([]);
	});

	it.each([
		"git -c a=b -c c=d -c e=f -c g=h push",
		"kubectl -n prod delete pod x",
		"npm --prefix dir publish",
		"docker --context c push img",
		"gh -R o/r pr create",
	])("sees the subcommand of %s behind its options", (command) => {
		expect(classifyShellCommand(command)).toContain("publish");
	});

	it("flags an interpreter as opaque while still naming what the quoted script contains", () => {
		const risks = classifyShellCommand("bash -c 'rm -rf x'");
		expect(risks).toEqual(expect.arrayContaining(["opaque", "destructive"]));
	});
});

describe("redaction of more shapes", () => {
	it.each([
		["api_key=abcdefghijklmnop", "api_key=[REDACTED]"],
		['{"API_KEY": "abcdefghijklmnop"}', '{"API_KEY": [REDACTED]}'],
		['{"apiKey":"abcdefghijklmnop"}', '{"apiKey":[REDACTED]}'],
		["password=hunter2hunter2", "password=[REDACTED]"],
		["curl --token abcdefghijklmnop https://x.test", "curl --token [REDACTED] https://x.test"],
		["curl -u admin:s3cretpass https://x.test", "curl -u [REDACTED] https://x.test"],
		["curl -H 'X-Api-Key: abcdefghijklmnop' x", "curl -H 'X-Api-Key: [REDACTED]' x"],
		["Authorization: Basic YWRtaW46cGFzcw==", "Authorization: [REDACTED]"],
		["Cookie: session=abcdefghijklmnop; theme=dark", "Cookie: [REDACTED]"],
		["postgres://user:p@ss@host/db", "postgres://user:[REDACTED]@host/db"],
		["mongodb://user:pa/ss@host", "mongodb://user:[REDACTED]@host"],
	])("%s", (input, expected) => {
		expect(redactSecrets(input, {})).toBe(expected);
	});

	it.each([
		"make KEYBOARD=us",
		"monkey=3",
		"primaryKey: id",
		"sort --key=2 file",
		"npm run build --max-tokens 100",
		"docker run -u 1000:1000 img",
	])("leaves %s alone", (input) => {
		expect(redactSecrets(input, {})).toBe(input);
	});

	it.each([
		["SSH_KEY=abcdefghij", "SSH_KEY=[REDACTED]"],
		["accessToken: abcdefghij", "accessToken: [REDACTED]"],
		["curl --user admin:s3cret x", "curl --user [REDACTED] x"],
		["curl -uadmin:s3cret x", "curl -u[REDACTED] x"],
	])("redacts %s", (input, expected) => {
		expect(redactSecrets(input, {})).toBe(expected);
	});

	it("does not treat ordinary environment names as secrets", () => {
		const env = {
			GIT_AUTHOR_NAME: "Alexander Hamilton",
			XDG_SESSION_TYPE: "wayland-session",
			GITHUB_TOKEN: "ghs_abcdef0123456789",
		};
		expect(redactSecrets("Alexander Hamilton wayland-session ghs_abcdef0123456789", env)).toBe(
			"Alexander Hamilton wayland-session [REDACTED]",
		);
	});

	it("stays fast on long adversarial input", () => {
		const started = performance.now();
		sanitizeForDisplay("KEY".repeat(40_000), 400, {});
		sanitizeForDisplay(`${"A".repeat(60_000)}=`, 2000, {});
		for (const unit of ["--token", "--token-", "--api-key", "--password=", "curl -u ", "cookie:", "token ", "a-"]) {
			sanitizeForDisplay(unit.repeat(8_000), 4096, {});
		}
		classifyShellCommand(`;${" ".repeat(60_000)}x`);
		classifyShellCommand(`${"\n".repeat(60_000)}x`);
		classifyShellCommand("git -c ".repeat(8_000));
		expect(performance.now() - started).toBeLessThan(500);
	});

	it("strips invisible and bidirectional characters from display text only", () => {
		expect(sanitizeForDisplay("a\u202eb\u200bc\u2066d\ufeffe\u{e0041}f", 100, {})).toBe("abcdef");
		expect(stripControlSequences("a\u200db\r\n")).toBe("a\u200db\r\n");
	});
});

describe("grants", () => {
	const writeAction = (real: string): Action => ({
		kind: "write",
		path: { real, workspace: "/w/ws", inWorkspace: true, protected: false, secret: false, runsCode: false },
	});

	it("covers a directory tree but not a sibling that shares its name as a prefix", () => {
		const grants = new GrantStore();
		grants.add({ kind: "write", dir: "/w/ws" });
		expect(grants.find(writeAction("/w/ws/a/b.ts"))).toBeDefined();
		expect(grants.find(writeAction("/w/ws-evil/b.ts"))).toBeUndefined();
		expect(grants.find({ ...writeAction("/w/ws/a"), kind: "read" } as Action)).toBeUndefined();
	});

	it("matches a shell command exactly and expires on time", () => {
		let now = 1_000;
		const grants = new GrantStore(() => now);
		grants.add({ kind: "exec", command: "npm test" }, 5_000);
		expect(grants.find(execAction("npm test"))).toBeDefined();
		expect(grants.find(execAction("npm test && curl x"))).toBeUndefined();
		now = 5_999;
		expect(grants.list()).toHaveLength(1);
		now = 6_000;
		expect(grants.find(execAction("npm test"))).toBeUndefined();
		expect(grants.list()).toHaveLength(0);
	});

	it("revokes one grant or all of them", () => {
		const grants = new GrantStore();
		const first = grants.add({ kind: "exec", command: "a" });
		grants.add({ kind: "exec", command: "b" });
		expect(grants.revoke(first.id)).toBe(true);
		expect(grants.revoke(first.id)).toBe(false);
		expect(grants.clear()).toBe(1);
		expect(grants.list()).toEqual([]);
	});
});

describe("redaction", () => {
	it("redacts known credential shapes and keeps the variable name", () => {
		const text = [
			"token ghp_abcdefghijklmnopqrstuvwxyz0123456789",
			"Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345",
			"clone https://user:hunter2hunter2@example.com/repo",
			"OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwx",
			"-----BEGIN RSA PRIVATE KEY-----\nMIIEabc\n-----END RSA PRIVATE KEY-----",
		].join("\n");
		const redacted = redactSecrets(text, {});
		expect(redacted).not.toMatch(/ghp_|abcdefghijklmnopqrstuvwxyz012345|hunter2|sk-abc|MIIEabc/);
		expect(redacted).toContain("OPENAI_API_KEY=[REDACTED]");
		expect(redacted).toContain("https://user:[REDACTED]@example.com/repo");
	});

	it("redacts values of sensitive environment variables, but not short values or other variables", () => {
		const env = { MY_SERVICE_TOKEN: "s3cr3t-value-123", API_KEY: "abc", EDITOR: "vim-editor-long" };
		expect(redactSecrets("a s3cr3t-value-123 b abc vim-editor-long", env)).toBe("a [REDACTED] b abc vim-editor-long");
	});

	it("leaves ordinary output unchanged", () => {
		const text = "PASS src/a.test.ts (12 tests)\nsha 3f2a9c1deadbeef";
		expect(redactSecrets(text, {})).toBe(text);
	});

	it("strips terminal control sequences and cannot be dodged by splitting a secret with one", () => {
		expect(stripControlSequences("a\x1b[31mred\x1b[0m\x1b]0;title\x07b\x1b]8;;http://x\x1b\\link\x00\x08")).toBe(
			"aredblink",
		);
		expect(sanitizeForDisplay("ghp_abcdefghij\x1b[0mklmnopqrstuvwxyz0123", 100, {})).toBe("[REDACTED]");
	});

	it("bounds length and reports how much was cut", () => {
		expect(sanitizeForDisplay("x".repeat(50), 10, {})).toBe(`${"x".repeat(10)}... [truncated 40 chars]`);
	});
});
