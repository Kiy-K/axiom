// Gondolin-backed SandboxBackend: boots a VM with no host env and no network, proven by a start probe.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { Writable } from "node:stream";
import { type ExecProcess, type VirtualProvider, VM } from "@earendil-works/gondolin";
import type { SandboxBackend, SandboxExecOptions, SandboxFs, SandboxState } from "./backend.ts";
import { detectSandboxSupport } from "./detect.ts";

export interface GondolinBackendOptions {
	/** Guest path -> provider. Mounts listed in `readOnlyMounts` are probed to refuse writes. */
	mounts?: Record<string, VirtualProvider>;
	readOnlyMounts?: string[];
	/** A writable project mount: the probe checks that guest writes stay off the host and that hidden paths are invisible. */
	workspace?: { mount: string; hostDir: string; hiddenPaths: string[] };
	/** Host home and env are probed against the guest; defaults to the real ones. */
	hostHome?: string;
	hostEnv?: NodeJS.ProcessEnv;
	/** Seconds; a VM that does not become ready in this time fails the start. */
	startTimeoutSeconds?: number;
}

/** Env the guest gets: nothing from the host. */
const GUEST_ENV = { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/root", LANG: "C.UTF-8" };

/** Guest script: kill the pid in file "$1" and every descendant. A process that daemonized away from the tree survives, but stays in the VM. */
const KILL_TREE = `ps -o pid,ppid | awk -v r="$(cat "$1")" 'NR>1{pp[$1]=$2} END{for(p in pp){q=p;n=0;while((q in pp)&&n++<64){if(q==r){print p;break}q=pp[q]}}}' | xargs -r kill -KILL`;

/** Start a VM and prove isolation. Returns `enforced` only when every probe check passes; the VM is closed otherwise. */
export async function startGondolinBackend(options: GondolinBackendOptions = {}): Promise<SandboxState> {
	const support = detectSandboxSupport();
	if (!support.ok) return { kind: "unavailable", reason: support.reason };

	let vm: VM;
	try {
		vm = await VM.create({
			sandbox: { netEnabled: false },
			env: GUEST_ENV,
			startTimeoutMs: (options.startTimeoutSeconds ?? 120) * 1000,
			...(options.mounts ? { vfs: { mounts: options.mounts } } : {}),
		});
	} catch (error) {
		return { kind: "failed", reason: `VM did not start: ${message(error)}` };
	}

	let problem: string | undefined;
	try {
		problem = await probe(vm, options);
	} catch (error) {
		await vm.close().catch(() => {});
		return { kind: "failed", reason: `isolation probe failed: ${message(error)}` };
	}
	if (problem) {
		await vm.close().catch(() => {});
		return { kind: "failed", reason: `isolation probe failed: ${problem}` };
	}
	return { kind: "enforced", backend: new GondolinBackend(vm) };
}

/** Returns a description of the first failed check, or undefined when the guest is isolated as designed. */
async function probe(vm: VM, options: GondolinBackendOptions): Promise<string | undefined> {
	const sh = async (script: string) => {
		const result = await vm.exec(["/bin/sh", "-c", script], { signal: AbortSignal.timeout(10_000) });
		return { code: result.exitCode, out: result.stdout };
	};
	const hostHome = options.hostHome ?? process.env.HOME;
	if (hostHome && (await sh(`test -e ${quote(hostHome)}`)).code === 0 && hostHome !== "/root") {
		return `host home ${hostHome} exists in the guest`;
	}
	const env = (await sh("env")).out;
	for (const [key, value] of Object.entries(options.hostEnv ?? process.env)) {
		// Short and path-like values are not credentials and collide with guest defaults.
		if (value && value.length >= 12 && !value.startsWith("/") && env.includes(value)) {
			return `host env ${key} is visible in the guest`;
		}
	}
	for (const mount of options.readOnlyMounts ?? []) {
		if ((await sh(`touch ${quote(`${mount}/.pi-probe`)}`)).code === 0) return `${mount} is writable`;
	}
	if (options.workspace) {
		const problem = await probeWorkspace(sh, options.workspace);
		if (problem) return problem;
	}
	const net = await sh(
		`timeout 10 node -e 'const os = require("node:os"); process.exit(Object.values(os.networkInterfaces()).flat().some(i => i && !i.internal && (i.family === "IPv4" || i.family === "IPv6")) ? 1 : 0)'`,
	);
	if (net.code !== 0) return "network interface check failed or found a non-internal interface";
	return undefined;
}

async function probeWorkspace(
	sh: (script: string) => Promise<{ code: number; out: string }>,
	{ mount, hostDir, hiddenPaths }: NonNullable<GondolinBackendOptions["workspace"]>,
): Promise<string | undefined> {
	const probeFile = `${mount}/.pi-probe`;
	if ((await sh(`echo x > ${quote(probeFile)}`)).code !== 0) return `${mount} is not writable`;
	// The probe file lives in the write layer only; removing it leaves no change for write-back.
	const leaked = existsSync(join(hostDir, ".pi-probe"));
	await sh(`rm -f ${quote(probeFile)}`);
	if (leaked) return `a guest write to ${mount} reached the host`;
	for (const hidden of [".git", ...hiddenPaths]) {
		if ((await sh(`test -e ${quote(`${mount}/${hidden}`)}`)).code === 0)
			return `hidden path ${hidden} is visible in the guest`;
	}
	return undefined;
}

class GondolinBackend implements SandboxBackend {
	readonly #vm: VM;
	#counter = 0;
	readonly fs: SandboxFs;

	constructor(vm: VM) {
		this.#vm = vm;
		this.fs = {
			readFile: (p) => vm.fs.readFile(p),
			writeFile: (p, content) => vm.fs.writeFile(p, content, { encoding: "utf8" }),
			mkdir: async (p) => {
				await vm.fs.mkdir(p, { recursive: true });
			},
			access: (p) => vm.fs.access(p),
			stat: (p) => vm.fs.stat(p),
			listDir: (p) => vm.fs.listDir(p),
		};
	}

	async close(): Promise<void> {
		await this.#vm.close();
	}

	async exec(command: string, cwd: string, options: SandboxExecOptions): Promise<{ exitCode: number | null }> {
		// Aborting the host promise does not stop the guest process, so its pid is recorded (the shell then execs the
		// command, keeping the pid and the exit code) and a second exec kills the pid and its descendants.
		const pidFile = `/tmp/.pi-exec-${++this.#counter}.pid`;
		const proc = this.#vm.exec(["/bin/sh", "-c", `echo $$ >"$1"; exec /bin/sh -c "$2"`, "sh", pidFile, command], {
			cwd,
			env: options.env,
			stdout: "pipe",
			stderr: "pipe",
			...(options.onStdin ? { stdin: true } : {}),
		});
		if (options.onStdin) options.onStdin(stdinOf(proc));

		let stopped: "aborted" | "timeout" | undefined;
		const stop = (reason: "aborted" | "timeout") => {
			if (stopped) return;
			stopped = reason;
			void this.#killGroup(pidFile);
		};
		const onAbort = () => stop("aborted");
		if (options.signal?.aborted) onAbort();
		options.signal?.addEventListener("abort", onAbort, { once: true });
		const timer = options.timeout ? setTimeout(() => stop("timeout"), options.timeout * 1000) : undefined;

		try {
			const reader = (async () => {
				for await (const chunk of proc.output()) options.onData(chunk.data);
			})();
			const result = await proc;
			await reader;
			if (stopped === "timeout") throw new Error(`timeout:${options.timeout}`);
			if (stopped === "aborted") throw new Error("aborted");
			return { exitCode: result.signal ? 128 + result.signal : result.exitCode };
		} finally {
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
		}
	}

	async #killGroup(pidFile: string): Promise<void> {
		await this.#vm.exec(["/bin/sh", "-c", KILL_TREE, "sh", pidFile]).catch(() => {});
	}
}

function stdinOf(proc: ExecProcess): Writable {
	return new Writable({
		write(chunk, _encoding, done) {
			proc.write(chunk);
			done();
		},
		final(done) {
			proc.end();
			done();
		},
	});
}

function quote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
