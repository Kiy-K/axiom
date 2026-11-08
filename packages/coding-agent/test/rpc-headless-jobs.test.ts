import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

interface IsolatedBox {
	root: string;
	cwd: string;
	agentDir: string;
	env: NodeJS.ProcessEnv;
	args: string[];
}

interface PrintRun {
	code: number | null;
	stdout: string;
	stderr: string;
}
const pkgDir = resolve(import.meta.dirname, "..");
const cliPath = join(pkgDir, "src/cli.ts");
const resolverUrl = pathToFileURL(join(pkgDir, "src/experimental/source-resolver.ts")).href;
const dirs: string[] = [];

const EXTENSION = `import { fauxAssistantMessage, fauxToolCall, fauxProvider } from "@earendil-works/pi-ai";

export default function (pi) {
	const command = process.env.JOB_COMMAND;
	const holdMs = Number(process.env.JOB_HOLD_MS || 0);
	const faux = fauxProvider();
	faux.setResponses([
		() =>
			fauxAssistantMessage([fauxToolCall("bash", { command, background: true })], {
				stopReason: "toolUse",
			}),
		async () => {
			if (holdMs > 0) await new Promise((resolve) => setTimeout(resolve, holdMs));
			return fauxAssistantMessage("launched");
		},
		() => fauxAssistantMessage("noted"),
	]);
	pi.registerProvider(faux.provider);
}
`;

function isolated(extra: Record<string, string> = {}) {
	const root = mkdtempSync(join(tmpdir(), "axiom-rpc-jobs-"));
	dirs.push(root);
	const home = join(root, "home");
	const agentDir = join(root, "agent");
	const cwd = join(root, "cwd");
	mkdirSync(home, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	const extPath = join(root, "faux-ext.ts");
	writeFileSync(extPath, EXTENSION);
	const nodeOptions = [process.env.NODE_OPTIONS, `--import ${resolverUrl}`].filter(Boolean).join(" ");
	return {
		root,
		home,
		agentDir,
		cwd,
		extPath,
		env: {
			HOME: home,
			AXIOM_CODING_AGENT_DIR: agentDir,
			PI_OFFLINE: "1",
			PI_SKIP_VERSION_CHECK: "1",
			NODE_OPTIONS: nodeOptions,
			...extra,
		},
		args: ["--offline", "--no-session", "-ne", "-e", extPath, "--model", "faux/faux-1"],
	};
}

function jobIdFrom(text: string): string {
	const match = text.match(/Started background job ([0-9a-f]{16})\./);
	if (!match) throw new Error(`no job yield in: ${text.slice(0, 2000)}`);
	return match[1];
}

function recordPid(agentDir: string, jobId: string): number {
	const record = JSON.parse(readFileSync(join(agentDir, "jobs", `${jobId}.json`), "utf8")) as { pid: number };
	return record.pid;
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Real child processes; fake timers cannot observe their exit. */
async function until(predicate: () => boolean, ms: number): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	return predicate();
}

describe("RPC and headless background jobs", () => {
	afterEach(() => {
		while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
	});

	it("delivers the yield and the next-prompt notice over RPC", async () => {
		const box = isolated({ JOB_COMMAND: "echo finished" });
		const client = new RpcClient({ cliPath, cwd: box.cwd, env: box.env, args: box.args });
		const events: unknown[] = [];
		client.onEvent((event) => events.push(event));
		await client.start();
		try {
			await client.promptAndWait("start a background job");
			const jobId = jobIdFrom(JSON.stringify(events));
			// The finish record is removed when the job settles; that is the signal the notice is queued.
			expect(await until(() => !existsSync(join(box.agentDir, "jobs", `${jobId}.json`)), 5_000)).toBe(true);
			await client.promptAndWait("what happened?");
			const listed = await client.getMessages();
			expect(JSON.stringify(listed)).toContain("job_finished");
			expect(JSON.stringify(listed)).toContain(jobId);
			expect(JSON.stringify(events)).toContain("Started background job");
		} finally {
			client.stop();
		}
	}, 60_000);

	it("stops the recorded process when the RPC client stops", async () => {
		const box = isolated({ JOB_COMMAND: "exec sleep 60" });
		const client = new RpcClient({ cliPath, cwd: box.cwd, env: box.env, args: box.args });
		const events: unknown[] = [];
		client.onEvent((event) => events.push(event));
		await client.start();
		try {
			await client.promptAndWait("start a long job");
			const pid = recordPid(box.agentDir, jobIdFrom(JSON.stringify(events)));
			expect(alive(pid)).toBe(true);
			client.stop();
			expect(await until(() => !alive(pid), 5_000)).toBe(true);
		} catch (error) {
			client.stop();
			throw error;
		}
	}, 60_000);

	it("emits the yield and notice in print JSON, and kills the job on exit", async () => {
		const notice = isolated({ JOB_COMMAND: "echo finished", JOB_HOLD_MS: "400" });
		const noticeRun = await runPrint(notice, ["--mode", "json", "-p", "start a background job", "what happened?"]);
		expect(noticeRun.code, noticeRun.stderr).toBe(0);
		const jobId = jobIdFrom(noticeRun.stdout);
		expect(noticeRun.stdout).toContain("job_finished");
		expect(noticeRun.stdout).toContain(jobId);

		const teardown = isolated({ JOB_COMMAND: "echo $$ > pid.txt; exec sleep 60", JOB_HOLD_MS: "300" });
		const teardownRun = await runPrint(teardown, ["--mode", "json", "-p", "start a long job"]);
		expect(teardownRun.code, teardownRun.stderr).toBe(0);
		const pid = Number(readFileSync(join(teardown.cwd, "pid.txt"), "utf8").trim());
		expect(Number.isInteger(pid)).toBe(true);
		expect(alive(pid)).toBe(false);
	}, 60_000);
});

function runPrint(box: IsolatedBox, args: string[]): Promise<PrintRun> {
	const { promise, resolve, reject } = Promise.withResolvers<PrintRun>();
	const child = spawn(process.execPath, ["--import", resolverUrl, cliPath, ...args, ...box.args], {
		cwd: box.cwd,
		env: { ...process.env, ...box.env, NODE_OPTIONS: process.env.NODE_OPTIONS },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		stdout += chunk;
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	child.on("error", reject);
	child.on("exit", (code) => resolve({ code, stdout, stderr }));
	return promise;
}
