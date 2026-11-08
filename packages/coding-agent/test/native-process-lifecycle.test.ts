import { spawn } from "node:child_process";
import { once } from "node:events";
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { release, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { getNativeProcessHelperPath } from "../src/config.ts";
import { JobSupervisor } from "../src/core/jobs/supervisor.ts";
import { type BashOperations, createBashTool, createLocalBashOperations } from "../src/core/tools/bash.ts";

type Handle = Parameters<NonNullable<Parameters<BashOperations["exec"]>[2]["onHandle"]>>[0];
const [kernelMajor = 0, kernelMinor = 0] = release().split(".").map(Number);
const hasGroupPidfd = process.platform === "linux" && (kernelMajor > 6 || (kernelMajor === 6 && kernelMinor >= 9));

// Real process exit and signal delivery cannot be driven by fake timers.
async function until(predicate: () => boolean, ms = 5_000): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await delay(20);
	}
	return predicate();
}

function alive(pid: number): boolean {
	try {
		const state = readFileSync(`/proc/${pid}/stat`, "utf8").match(/\) (\w)/)?.[1];
		return state !== undefined && state !== "Z";
	} catch {
		return false;
	}
}

describe.skipIf(process.platform !== "linux")("native shell process lifecycle", () => {
	it("runs the resolved helper and preserves output, stdin, cwd, environment, and exit status", async () => {
		accessSync(getNativeProcessHelperPath(), constants.X_OK);
		const cwd = mkdtempSync(join(tmpdir(), "axiom-native-"));
		let output = "";
		try {
			const result = await createLocalBashOperations().exec(
				'read -r input; printf "out:%s:%s:%s\\n" "$input" "$PWD" "$AXIOM_NATIVE_TEST"; printf "err\\n" >&2; exit 7',
				cwd,
				{
					env: { ...process.env, AXIOM_NATIVE_TEST: "value" },
					onData: (chunk) => {
						output += chunk.toString();
					},
					onStdin: (stdin) => {
						stdin.end("hello\n");
					},
				},
			);
			expect(result.exitCode).toBe(7);
			expect(output).toContain(`out:hello:${cwd}:value\n`);
			expect(output).toContain("err\n");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("retains the original process identity after the shell exits and stops its descendant", async () => {
		let handle: Handle | undefined;
		let output = "";
		let descendant: number | undefined;
		try {
			const result = await createLocalBashOperations().exec(
				"sleep 30 </dev/null >/dev/null 2>&1 & echo $!",
				process.cwd(),
				{
					onData: (chunk) => {
						output += chunk.toString();
					},
					onHandle: (value) => {
						handle = value;
					},
				},
			);
			expect(result.exitCode).toBe(0);
			descendant = Number(output.trim());
			expect(Number.isSafeInteger(descendant) && descendant > 1).toBe(true);
			expect(alive(descendant)).toBe(true);
			expect(handle).toBeDefined();
			handle?.signal("kill");
			expect(await until(() => !alive(descendant as number))).toBe(true);
		} finally {
			handle?.signal("kill");
			handle?.close();
			if (descendant && alive(descendant)) process.kill(descendant, "SIGKILL");
		}
	}, 15_000);

	it.skipIf(!hasGroupPidfd)(
		"reaps the leader while retaining the group until the last descendant exits",
		async () => {
			let handle: Handle | undefined;
			let output = "";
			let descendant: number | undefined;
			let empty = false;
			try {
				await createLocalBashOperations().exec("sleep 30 </dev/null >/dev/null 2>&1 & echo $!", process.cwd(), {
					onData: (chunk) => {
						output += chunk.toString();
					},
					onHandle: (value) => {
						handle = value;
						expect(value.onEmpty).toBeDefined();
						value.onEmpty?.(() => {
							empty = true;
						});
					},
				});
				descendant = Number(output.trim());
				expect(Number.isSafeInteger(descendant) && descendant > 1).toBe(true);
				expect(handle).toBeDefined();
				expect(await until(() => handle !== undefined && !existsSync(`/proc/${handle.pid}`))).toBe(true);
				expect(alive(descendant)).toBe(true);
				expect(empty).toBe(false);
				handle?.signal("kill");
				expect(await until(() => empty)).toBe(true);
				expect(alive(descendant)).toBe(false);
			} finally {
				handle?.signal("kill");
				handle?.close();
				if (descendant && alive(descendant)) process.kill(descendant, "SIGKILL");
			}
		},
		15_000,
	);

	it.skipIf(!hasGroupPidfd)(
		"signals a retained group while descendants fork and the leader has exited",
		async () => {
			let handle: Handle | undefined;
			let output = "";
			let descendant: number | undefined;
			let empty = false;
			try {
				await createLocalBashOperations().exec(
					"(while :; do sleep 0.02 & wait; done) </dev/null >/dev/null 2>&1 & echo $!",
					process.cwd(),
					{
						onData: (chunk) => {
							output += chunk.toString();
						},
						onHandle: (value) => {
							handle = value;
							value.onEmpty?.(() => {
								empty = true;
							});
						},
					},
				);
				descendant = Number(output.trim());
				expect(Number.isSafeInteger(descendant) && descendant > 1).toBe(true);
				expect(await until(() => handle !== undefined && !existsSync(`/proc/${handle.pid}`))).toBe(true);
				expect(alive(descendant)).toBe(true);
				handle?.signal("kill");
				expect(await until(() => empty)).toBe(true);
				expect(alive(descendant)).toBe(false);
			} finally {
				handle?.signal("kill");
				handle?.close();
				if (descendant && alive(descendant)) process.kill(descendant, "SIGKILL");
			}
		},
		15_000,
	);

	it.skipIf(!hasGroupPidfd)(
		"does not signal an unrelated process after the retained group becomes empty",
		async () => {
			let handle: Handle | undefined;
			let empty = false;
			const unrelated = spawn("sleep", ["1"], { stdio: "ignore" });
			const unrelatedExit = once(unrelated, "exit");
			try {
				await createLocalBashOperations().exec("true", process.cwd(), {
					onData: () => {},
					onHandle: (value) => {
						handle = value;
						value.onEmpty?.(() => {
							empty = true;
						});
					},
				});
				expect(await until(() => empty)).toBe(true);
				handle?.signal("kill");
				handle?.close();
				handle?.signal("kill");
				await expect(unrelatedExit).resolves.toEqual([0, null]);
			} finally {
				handle?.close();
				unrelated.kill("SIGKILL");
			}
		},
		10_000,
	);

	it("does not affect an unrelated process after the handle is closed", async () => {
		const unrelated = spawn("sleep", ["30"], { stdio: "ignore" });
		let handle: Handle | undefined;
		try {
			await createLocalBashOperations().exec("true", process.cwd(), {
				onData: () => {},
				onHandle: (value) => {
					handle = value;
				},
			});
			expect(handle).toBeDefined();
			handle?.close();
			handle?.signal("kill");
			expect(unrelated.pid).toBeDefined();
			expect(alive(unrelated.pid as number)).toBe(true);
		} finally {
			handle?.close();
			unrelated.kill("SIGKILL");
		}
	});

	it.skipIf(!hasGroupPidfd)(
		"delivers the shell exit before confirming cleanup",
		async () => {
			let handle: Handle | undefined;
			let cleaned = false;
			let output = "";
			const execution = createLocalBashOperations().exec("echo ready; exec sleep 30", process.cwd(), {
				onData: (chunk) => {
					output += chunk.toString();
				},
				onHandle: (value) => {
					handle = value;
					value.onCleaned?.(() => {
						cleaned = true;
					});
				},
			});
			try {
				expect(await until(() => output.includes("ready"))).toBe(true);
				handle?.cleanup?.();
				expect((await execution).exitCode).toBe(137);
				expect(await until(() => cleaned)).toBe(true);
			} finally {
				handle?.signal("kill");
				handle?.close();
			}
		},
		10_000,
	);

	it("cleans up descendants of a nested foreground command when the session closes", async () => {
		const supervisor = new JobSupervisor();
		const tool = createBashTool(process.cwd(), { jobs: { supervisor, owner: () => "nested-owner" } });
		let descendant = 0;
		try {
			const result = await tool.execute("parent/1", { command: "sleep 30 </dev/null >/dev/null 2>&1 & echo $!" });
			const first = result.content[0];
			if (first?.type !== "text") throw new Error("expected shell output");
			descendant = Number(first.text.trim());
			expect(Number.isSafeInteger(descendant) && descendant > 1).toBe(true);
			expect(alive(descendant)).toBe(true);
			await supervisor.stopSession("nested-owner");
			expect(await until(() => !alive(descendant))).toBe(true);
		} finally {
			supervisor.killSession("nested-owner");
			if (descendant > 1 && alive(descendant)) process.kill(descendant, "SIGKILL");
		}
	}, 15_000);

	it("times out a running process", async () => {
		let output = "";
		await expect(
			createLocalBashOperations().exec("echo started; sleep 30", process.cwd(), {
				onData: (chunk) => {
					output += chunk.toString();
				},
				timeout: 0.5,
			}),
		).rejects.toThrow("timeout:0.5");
		expect(output).toContain("started");
	}, 10_000);

	it("reports the shell exit when a descendant holds output until the deadline", async () => {
		const tool = createBashTool(process.cwd());
		await expect(
			tool.execute("native-late-output", {
				command: "(while true; do echo tick; sleep 0.02; done) & sleep 0.2; exit 3",
				timeout: 1,
			}),
		).rejects.toThrow(/shell exited with code 3.*background processes/);
	}, 10_000);

	it("aborts a running process", async () => {
		const controller = new AbortController();
		let output = "";
		const execution = createLocalBashOperations().exec("echo ready; sleep 30", process.cwd(), {
			onData: (chunk) => {
				output += chunk.toString();
			},
			signal: controller.signal,
		});
		try {
			expect(await until(() => output.includes("ready"))).toBe(true);
			controller.abort();
			await expect(execution).rejects.toThrow("aborted");
		} finally {
			controller.abort();
		}
	}, 10_000);
});
