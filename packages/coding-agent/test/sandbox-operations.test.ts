import { describe, expect, it } from "vitest";
import type { SandboxBackend } from "../src/core/sandbox/backend.ts";
import { createSandboxOperations, GUEST_WORKSPACE, toGuestPath } from "../src/core/sandbox/operations.ts";

describe("toGuestPath", () => {
	it("maps the workspace and its children under /workspace", () => {
		expect(toGuestPath("/home/u/proj", "/home/u/proj")).toBe(GUEST_WORKSPACE);
		expect(toGuestPath("/home/u/proj", "/home/u/proj/src/a.ts")).toBe("/workspace/src/a.ts");
		expect(toGuestPath("/home/u/proj", "src/a.ts")).toBe("/workspace/src/a.ts");
	});

	it("keeps paths outside the workspace absolute, including ../ escapes", () => {
		expect(toGuestPath("/home/u/proj", "/home/u/.ssh/id_rsa")).toBe("/home/u/.ssh/id_rsa");
		expect(toGuestPath("/home/u/proj", "../.ssh/id_rsa")).toBe("/home/u/.ssh/id_rsa");
		expect(toGuestPath("/home/u/proj", "/home/u/proj2/x")).toBe("/home/u/proj2/x");
	});
});

describe("createSandboxOperations", () => {
	it("runs bash in the guest cwd and drops the host env", async () => {
		const calls: Array<{ command: string; cwd: string; env: unknown }> = [];
		const backend = {
			exec: async (command: string, cwd: string, options: { env?: unknown }) => {
				calls.push({ command, cwd, env: options.env });
				return { exitCode: 0 };
			},
		} as unknown as SandboxBackend;
		const { bash } = createSandboxOperations(backend, "/home/u/proj");
		await bash.exec("ls", "/home/u/proj/src", { onData: () => {}, env: { SECRET_TOKEN: "abcdefghijklmnop" } });
		expect(calls).toEqual([{ command: "ls", cwd: "/workspace/src", env: undefined }]);
	});

	it("reads and writes through the guest filesystem with mapped paths", async () => {
		const seen: string[] = [];
		const backend = {
			fs: {
				readFile: async (p: string) => {
					seen.push(`read ${p}`);
					return Buffer.from("x");
				},
				writeFile: async (p: string) => {
					seen.push(`write ${p}`);
				},
				mkdir: async (p: string) => {
					seen.push(`mkdir ${p}`);
				},
				access: async (p: string) => {
					if (p !== "/workspace/ok") throw new Error("ENOENT");
				},
				stat: async () => ({ isDirectory: () => true }),
				listDir: async () => [],
			},
		} as unknown as SandboxBackend;
		const ops = createSandboxOperations(backend, "/home/u/proj");
		await ops.read.readFile("/home/u/proj/a");
		await ops.write.writeFile("/home/u/proj/b", "y");
		await ops.write.mkdir("/home/u/proj/d");
		expect(seen).toEqual(["read /workspace/a", "write /workspace/b", "mkdir /workspace/d"]);
		expect(await ops.ls.exists("/home/u/proj/ok")).toBe(true);
		expect(await ops.ls.exists("/home/u/proj/nope")).toBe(false);
	});
});
