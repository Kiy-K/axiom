import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
	accessSync,
	closeSync,
	constants,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	readSync,
	rmSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { getNativeProcessHelperPath } from "../src/config.ts";
import { JobSupervisor } from "../src/core/jobs/supervisor.ts";
import { type BashOperations, createBashTool, createLocalBashOperations } from "../src/core/tools/bash.ts";
import { executeNativeProcess } from "../src/core/tools/native-process.ts";
import { getShellConfig } from "../src/utils/shell.ts";

type Handle = Parameters<NonNullable<Parameters<BashOperations["exec"]>[2]["onHandle"]>>[0];
// Real helper probe: the group is only provably empty where the kernel and sandbox allow process-group pidfds.
async function probeGroupPidfd(): Promise<boolean> {
	if (process.platform !== "linux") return false;
	const helper = spawn(getNativeProcessHelperPath(), [], { stdio: ["pipe", "pipe", "ignore"] });
	helper.on("error", () => {});
	helper.stdin.on("error", () => {});
	let seen = "";
	helper.stdout.on("data", (chunk: Buffer) => {
		seen += chunk.toString("latin1");
	});
	helper.stdin.write(
		`${JSON.stringify({ type: "start", command: "/bin/sh", args: ["-c", "exit 0"], cwd: "/", env: {}, stdin: false })}\n`,
	);
	// The spawn frame states the capability directly; the `empty` event is behavior these tests check, so it must not gate them.
	const found = await until(() => seen.includes('"proves_empty":true'), 5_000);
	helper.kill("SIGKILL");
	return found;
}

const hasGroupPidfd = await probeGroupPidfd();

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

	it.skipIf(!hasGroupPidfd)(
		"bounds cleanup when its confirmation and diagnostic output are blocked",
		async () => {
			const cwd = mkdtempSync(join(tmpdir(), "axiom-confirm-"));
			const fds: number[] = [];
			let helper: ChildProcess | undefined;
			try {
				const outputPath = join(cwd, "output");
				execFileSync("mkfifo", [outputPath]);
				const reader = openSync(outputPath, constants.O_RDONLY | constants.O_NONBLOCK);
				fds.push(reader);
				const output = openSync(outputPath, constants.O_WRONLY);
				fds.push(output);
				const filler = openSync(outputPath, constants.O_WRONLY | constants.O_NONBLOCK);
				fds.push(filler);
				helper = spawn(getNativeProcessHelperPath(), [], { stdio: ["pipe", output, output] });
				const stdin = helper.stdin!;
				stdin.on("error", () => {});
				let exited = false;
				helper.on("exit", () => {
					exited = true;
				});
				stdin.write(
					`${JSON.stringify({
						type: "start",
						command: "/bin/sh",
						args: ["-c", "exit 0"],
						cwd,
						env: process.env,
						stdin: false,
					})}\n`,
				);
				let frames: Buffer = Buffer.alloc(0);
				let empty = false;
				const chunk = Buffer.alloc(4096);
				expect(
					await until(() => {
						try {
							const n = readSync(reader, chunk, 0, chunk.length, null);
							frames = Buffer.concat([frames, chunk.subarray(0, n)]);
						} catch (error) {
							if ((error as NodeJS.ErrnoException).code !== "EAGAIN") throw error;
						}
						while (frames.length >= 5 && frames.length >= frames.readUInt32BE(1) + 5) {
							const length = frames.readUInt32BE(1);
							if (frames[0] === 74 && JSON.parse(frames.subarray(5, length + 5).toString()).type === "empty") {
								empty = true;
							}
							frames = frames.subarray(length + 5);
						}
						return empty;
					}),
				).toBe(true);
				for (const bytes of [Buffer.alloc(4096), Buffer.alloc(1)]) {
					for (;;) {
						try {
							writeSync(filler, bytes);
						} catch (error) {
							if ((error as NodeJS.ErrnoException).code !== "EAGAIN") throw error;
							break;
						}
					}
				}
				const started = performance.now();
				stdin.write('{"type":"cleanup"}\n');
				expect(await until(() => exited, 7_000)).toBe(true);
				expect(performance.now() - started).toBeGreaterThanOrEqual(4_000);
				expect(helper.exitCode).toBe(1);
			} finally {
				helper?.kill("SIGKILL");
				helper?.stdin?.destroy();
				for (const fd of fds) closeSync(fd);
				rmSync(cwd, { recursive: true, force: true });
			}
		},
		12_000,
	);

	describe("a helper that never reports its spawn", () => {
		// A script that ignores the protocol stands in for a helper blocked inside spawn.
		async function withStalledHelper(run: () => Promise<void>): Promise<void> {
			const packageDir = mkdtempSync(join(tmpdir(), "axiom-stalled-"));
			const original = process.env.PI_PACKAGE_DIR;
			try {
				const helperDir = join(packageDir, "native", "process", `${process.platform}-${process.arch}`);
				mkdirSync(helperDir, { recursive: true });
				writeFileSync(join(helperDir, "axiom-process"), "#!/bin/sh\nexec sleep 60\n", { mode: 0o755 });
				process.env.PI_PACKAGE_DIR = packageDir;
				await run();
			} finally {
				if (original === undefined) delete process.env.PI_PACKAGE_DIR;
				else process.env.PI_PACKAGE_DIR = original;
				rmSync(packageDir, { recursive: true, force: true });
			}
		}
		const request = {
			command: "true",
			cwd: process.cwd(),
			env: process.env,
			shell: getShellConfig(),
			onData: () => {},
		};

		it("is killed after the grace period when the command is aborted", async () => {
			await withStalledHelper(async () => {
				const controller = new AbortController();
				const started = performance.now();
				const execution = executeNativeProcess({ ...request, signal: controller.signal });
				setTimeout(() => controller.abort(), 100);
				await expect(execution).rejects.toThrow("aborted");
				expect(performance.now() - started).toBeGreaterThanOrEqual(4_500);
				expect(performance.now() - started).toBeLessThan(10_500);
			});
		}, 12_000);

		it("is killed after the grace period when the command times out", async () => {
			await withStalledHelper(async () => {
				const started = performance.now();
				await expect(executeNativeProcess({ ...request, timeoutMs: 100 })).rejects.toThrow(
					"Native command timed out",
				);
				expect(performance.now() - started).toBeGreaterThanOrEqual(4_500);
				expect(performance.now() - started).toBeLessThan(10_500);
			});
		}, 12_000);
	});

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

	it("outlives hangup, interrupt and terminate signals and kills its command only when its owner disconnects", async () => {
		const helper = spawn(getNativeProcessHelperPath(), [], { stdio: ["pipe", "pipe", "ignore"] });
		let seen = "";
		helper.stdout.on("data", (chunk: Buffer) => {
			seen += chunk.toString("latin1");
		});
		helper.stdin.write(
			`${JSON.stringify({ type: "start", command: "/bin/sh", args: ["-c", "sleep 30"], cwd: "/", env: {}, stdin: false })}\n`,
		);
		let commandPid = 0;
		try {
			expect(await until(() => /"pid":\d+/.test(seen))).toBe(true);
			commandPid = Number(seen.match(/"pid":(\d+)/)?.[1]);
			// A terminal hangup or Ctrl+C reaches the helper because it shares its owner's process group.
			for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"] as const) helper.kill(signal);
			await delay(300);
			expect(helper.exitCode).toBeNull();
			expect(helper.signalCode).toBeNull();
			expect(alive(commandPid)).toBe(true);
			// The owner going away is what ends the command.
			helper.stdin.end();
			expect(await until(() => !alive(commandPid))).toBe(true);
		} finally {
			helper.kill("SIGKILL");
			if (commandPid > 0 && alive(commandPid)) process.kill(-commandPid, "SIGKILL");
		}
	}, 15_000);
});
