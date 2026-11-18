import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { ReadonlyProvider, RealFSProvider, VM } from "@earendil-works/gondolin";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { requireEnforced, type SandboxBackend, type SandboxState } from "../src/core/sandbox/backend.ts";
import * as sandboxDetect from "../src/core/sandbox/detect.ts";
import { startGondolinBackend } from "../src/core/sandbox/gondolin-backend.ts";

describe("requireEnforced", () => {
	it("refuses every state except enforced", () => {
		const states: SandboxState[] = [
			{ kind: "unavailable", reason: "no kvm" },
			{ kind: "starting" },
			{ kind: "failed", reason: "probe" },
		];
		for (const state of states) expect(() => requireEnforced(state)).toThrow(/Sandbox not enforced/);
	});
});

it("closes the VM when the isolation probe throws an empty error", async () => {
	const close = vi.fn().mockResolvedValue(undefined);
	const exec = vi
		.fn()
		.mockResolvedValueOnce({ exitCode: 0, stdout: "" })
		.mockResolvedValueOnce({ exitCode: 0, stdout: "" })
		.mockRejectedValueOnce(new Error(""));
	const support = vi.spyOn(sandboxDetect, "detectSandboxSupport").mockReturnValue({ ok: true, imageCached: true });
	const create = vi.spyOn(VM, "create").mockResolvedValue({ exec, close } as unknown as VM);
	try {
		const state = await startGondolinBackend({ hostHome: "/root", hostEnv: {} });
		expect(state.kind).toBe("failed");
		expect(exec).toHaveBeenCalledTimes(3);
		expect(String(exec.mock.calls[2][0])).toContain("networkInterfaces");
		expect(close).toHaveBeenCalledOnce();
	} finally {
		create.mockRestore();
		support.mockRestore();
	}
});

// Needs /dev/kvm and the Gondolin guest image (downloaded on first use).
describe.skipIf(!sandboxDetect.detectSandboxSupport().ok)("gondolin backend", { timeout: 180_000 }, () => {
	let work: string;
	let backend: SandboxBackend;
	const out: Buffer[] = [];
	const run = async (command: string, options: { timeout?: number; signal?: AbortSignal } = {}) => {
		out.length = 0;
		const { exitCode } = await backend.exec(command, "/", { onData: (d) => out.push(d), ...options });
		return { exitCode, text: Buffer.concat(out).toString() };
	};

	beforeAll(async () => {
		work = mkdtempSync(join(tmpdir(), "pi-sandbox-"));
		writeFileSync(join(work, "a.txt"), "hello");
		const state = await startGondolinBackend({
			mounts: { "/workspace": new ReadonlyProvider(new RealFSProvider(work)) },
			readOnlyMounts: ["/workspace"],
		});
		backend = requireEnforced(state);
	});

	afterAll(async () => {
		await backend?.close();
		rmSync(work, { recursive: true, force: true });
	});

	it("runs a command and streams output", async () => {
		expect(await run("cat /workspace/a.txt")).toEqual({ exitCode: 0, text: "hello" });
	});

	it("refuses writes to the read-only workspace", async () => {
		expect((await run("touch /workspace/x")).exitCode).not.toBe(0);
	});

	it("has no external interfaces or connection to a host listener", async () => {
		const address = Object.values(networkInterfaces())
			.flat()
			.find((item) => item && item.family === "IPv4" && !item.internal)?.address;
		if (!address) throw new Error("Network isolation test unavailable: no non-loopback host IPv4 address");
		const token = randomUUID();
		let connections = 0;
		let received = "";
		const server = createServer((socket) => {
			connections++;
			socket.on("data", (data) => {
				received += data.toString();
			});
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, address, resolve);
		});
		try {
			const port = (server.address() as { port: number }).port;
			await new Promise<void>((resolve, reject) => {
				const socket = createConnection({ host: address, port }, () => socket.end(token));
				socket.on("error", reject);
				socket.on("close", () => resolve());
			});
			expect(received).toBe(token);
			expect(connections).toBe(1);
			const interfaces = await run(
				`node -e 'const os=require("node:os"); console.log(JSON.stringify(Object.values(os.networkInterfaces()).flat().filter(i=>i&&!i.internal)))'`,
			);
			expect(interfaces.exitCode).toBe(0);
			expect(JSON.parse(interfaces.text)).toEqual([]);
			const command = `node -e 'const s=require("node:net").connect(${port},${JSON.stringify(address)}); s.setTimeout(2000,()=>s.destroy()); s.on("error",()=>process.exit(1)); s.on("timeout",()=>process.exit(1)); s.on("connect",()=>{s.end(${JSON.stringify(token)});process.exit(0)})'`;
			const result = await run(command, { timeout: 5 }).catch((error: unknown) => {
				if (error instanceof Error && error.message === "timeout:5") return { exitCode: null, text: "" };
				throw error;
			});
			expect(result.exitCode).not.toBe(0);
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect(connections).toBe(1);
			expect(received).toBe(token);
		} finally {
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		}
	});

	it("kills the whole guest process group on timeout", async () => {
		await expect(run("sleep 77 & sleep 78", { timeout: 1 })).rejects.toThrow("timeout:1");
		expect((await run("ps | grep 'sleep 7[78]' | grep -v grep | wc -l")).text.trim()).toBe("0");
	});

	it("kills the guest process on abort", async () => {
		const controller = new AbortController();
		const pending = run("sleep 66", { signal: controller.signal });
		setTimeout(() => controller.abort(), 500);
		await expect(pending).rejects.toThrow("aborted");
		expect((await run("ps | grep 'sleep 66' | grep -v grep | wc -l")).text.trim()).toBe("0");
	});
});
