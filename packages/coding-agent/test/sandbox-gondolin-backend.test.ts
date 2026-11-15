import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReadonlyProvider, RealFSProvider } from "@earendil-works/gondolin";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requireEnforced, type SandboxBackend, type SandboxState } from "../src/core/sandbox/backend.ts";
import { detectSandboxSupport } from "../src/core/sandbox/detect.ts";
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

// Needs /dev/kvm and the Gondolin guest image (downloaded on first use).
describe.skipIf(!detectSandboxSupport().ok)("gondolin backend", { timeout: 180_000 }, () => {
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

	it("blocks ungranted hosts and follows live grants", async () => {
		const fetchStatus = `node -e 'fetch("http://example.com").then(r=>console.log(r.status),e=>console.log("ERR"))'`;
		expect((await run(fetchStatus)).text.trim()).toBe("403");
		backend.grantHost("example.com");
		expect((await run(fetchStatus)).text.trim()).not.toBe("403");
		backend.revokeHost("example.com");
		expect((await run(fetchStatus)).text.trim()).toBe("403");
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
