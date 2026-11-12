import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.ts";
import { createAgentSessionServices } from "../../src/core/agent-session-services.ts";
import type { ExecOptions } from "../../src/core/exec.ts";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { createHarness, createTestUiContext, getMessageText, getToolResult, type Harness } from "./harness.ts";

describe("AgentSession permission gateway", () => {
	const harnesses: Harness[] = [];
	let agentDir: string;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "perm-session-"));
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
	});

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		rmSync(agentDir, { recursive: true, force: true });
	});

	async function start(options: Parameters<typeof createHarness>[0] = {}) {
		const harness = await createHarness({ settings: { permissionMode: "manual" }, ...options });
		harnesses.push(harness);
		return harness;
	}

	const callBash = (command: string) => [
		fauxAssistantMessage([fauxToolCall("bash", { command })], { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	];

	it("blocks a model shell call that needs approval when there is no user interface", async () => {
		const harness = await start();
		harness.setResponses(callBash("echo should-not-run"));
		await harness.session.prompt("go");
		const result = getToolResult(harness, "bash");
		expect(result.isError).toBe(true);
		expect(getMessageText(result)).toContain("no user interface");
		expect(getMessageText(result)).not.toContain("should-not-run\n");
		expect(harness.session.listJobs()).toEqual([]);
	});

	it("runs the call once the user allows it, and blocks it when the user denies", async () => {
		const prompts: string[] = [];
		let answer = "Allow once";
		const harness = await start();
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({
				select: async (title) => {
					prompts.push(title);
					return answer;
				},
			}),
		});

		harness.setResponses(callBash("echo hello-allowed"));
		await harness.session.prompt("go");
		expect(getToolResult(harness, "bash").isError).toBeFalsy();
		expect(getMessageText(getToolResult(harness, "bash"))).toContain("hello-allowed");

		answer = "Deny";
		harness.setResponses(callBash("echo hello-denied"));
		await harness.session.prompt("again");
		const denied = getToolResult(harness, "bash");
		expect(denied.isError).toBe(true);
		expect(getMessageText(denied)).toContain("user denied");
		expect(prompts).toHaveLength(2);
	});

	it("judges the input an extension handler rewrote, not the one the model sent", async () => {
		const prompts: string[] = [];
		const harness = await start({
			extensionFactories: [
				(pi: ExtensionAPI) => {
					pi.on("tool_call", (event) => {
						if (event.toolName === "bash") event.input.command = "sudo whoami";
					});
				},
			],
		});
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({
				select: async (title) => {
					prompts.push(title);
					return "Allow once";
				},
			}),
		});
		harness.setResponses(callBash("echo innocent"));
		await harness.session.prompt("go");
		expect(getMessageText(getToolResult(harness, "bash"))).toContain("raises privileges");
		expect(prompts).toEqual([]);
	});

	it("denies a write to a protected path without asking", async () => {
		const prompts: string[] = [];
		const harness = await start();
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({
				select: async (title) => {
					prompts.push(title);
					return "Allow once";
				},
			}),
		});
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: ".git/hooks/pre-commit", content: "x" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		expect(getMessageText(getToolResult(harness, "write"))).toContain("protected path");
		expect(prompts).toEqual([]);
	});

	it("gates a call another tool makes through ctx.executeTool", async () => {
		const harness = await start({
			extensionFactories: [
				(pi: ExtensionAPI) => {
					pi.registerTool({
						name: "outer",
						label: "outer",
						description: "Calls bash.",
						parameters: Type.Object({}),
						execute: async (_id, _params, _signal, _update, ctx) => {
							const outcome = await ctx.executeTool("bash", { command: "echo nested-ran" });
							return { content: outcome.result.content, details: {}, isError: outcome.isError };
						},
					});
				},
			],
		});
		// `outer` is an extension tool, so the user is asked once for it and once for the nested bash call.
		const prompts: string[] = [];
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({
				select: async (title) => {
					prompts.push(title);
					return title.includes("outer") ? "Allow once" : "Deny";
				},
			}),
		});
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("outer", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		expect(prompts).toHaveLength(2);
		expect(prompts[1]).toContain("Permission needed: bash");
		expect(getMessageText(getToolResult(harness, "outer"))).not.toContain("nested-ran");
	});

	/**
	 * An extension tool `runner` that runs `pi.exec(command, args, options)` and reports what it returned. The harness
	 * loads extensions in a temp dir but gives the session `process.cwd()`, so the default runs in the session's dir.
	 */
	const runnerExtension =
		(command: string, args: string[] | undefined, options: () => ExecOptions = () => ({ cwd: process.cwd() })) =>
		(pi: ExtensionAPI) => {
			pi.registerTool({
				name: "runner",
				label: "runner",
				description: "Runs a command.",
				parameters: Type.Object({}),
				execute: async () => {
					const result = await pi.exec(command, args as string[], options());
					return {
						content: [{ type: "text", text: `out=${result.stdout.trim()} killed=${result.killed}` }],
						details: {},
					};
				},
			});
		};

	const callRunner = () => [
		fauxAssistantMessage([fauxToolCall("runner", {})], { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	];

	/** Binds a UI that allows the extension tool itself and answers every `pi.exec` prompt with `answer`. */
	async function bindExecAnswers(harness: Harness, answer: () => string): Promise<string[]> {
		const prompts: string[] = [];
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({
				select: async (title) => {
					prompts.push(title);
					return title.includes("Permission needed: runner") ? "Allow once" : answer();
				},
			}),
		});
		return prompts;
	}

	it("runs a command an extension tool starts with pi.exec once the user allows it, and not when denied", async () => {
		const harness = await start({ extensionFactories: [runnerExtension("echo", ["exec-ran"])] });
		let answer = "Allow once";
		const prompts = await bindExecAnswers(harness, () => answer);

		harness.setResponses(callRunner());
		await harness.session.prompt("go");
		expect(prompts).toHaveLength(2);
		expect(prompts[1]).toContain("Permission needed: pi.exec");
		expect(prompts[1]).toContain("run echo exec-ran");
		expect(getToolResult(harness, "runner").isError).toBeFalsy();
		expect(getMessageText(getToolResult(harness, "runner"))).toContain("out=exec-ran");

		answer = "Deny";
		harness.setResponses(callRunner());
		await harness.session.prompt("again");
		expect(getToolResult(harness, "runner").isError).toBe(true);
		expect(getMessageText(getToolResult(harness, "runner"))).toContain("user denied");
	});

	it("judges the directory pi.exec runs in when the extension gives none: the one it was loaded for", async () => {
		const harness = await start({ extensionFactories: [runnerExtension("pwd", [], () => ({}))] });
		const prompts = await bindExecAnswers(harness, () => "Deny");
		harness.setResponses(callRunner());
		await harness.session.prompt("go");
		expect(prompts[1]).toContain(`run cd ${resolve(harness.tempDir)} && pwd`);
	});

	it("judges the directory a pi.exec runs in", async () => {
		const harness = await start({
			extensionFactories: [runnerExtension("pwd", [], () => ({ cwd: tmpdir() }))],
		});
		const prompts = await bindExecAnswers(harness, () => "Deny");
		harness.setResponses(callRunner());
		await harness.session.prompt("go");
		expect(prompts[1]).toContain(`run cd ${resolve(tmpdir())} && pwd`);
	});

	it("passes a pi.exec call with no args to the gateway as a command without arguments", async () => {
		const harness = await start({ extensionFactories: [runnerExtension("true", undefined)] });
		const prompts = await bindExecAnswers(harness, () => "Allow once");
		harness.setResponses(callRunner());
		await harness.session.prompt("go");
		expect(prompts[1]).toContain("run true");
		expect(getToolResult(harness, "runner").isError).toBeFalsy();
	});

	it("returns a killed result to a pi.exec caller that aborted while the gateway refused the call", async () => {
		const controller = new AbortController();
		const harness = await start({
			extensionFactories: [runnerExtension("echo", ["x"], () => ({ signal: controller.signal }))],
		});
		const prompts = await bindExecAnswers(harness, () => {
			controller.abort();
			return "Allow once";
		});
		harness.setResponses(callRunner());
		await harness.session.prompt("go");
		expect(prompts).toHaveLength(2);
		expect(getMessageText(getToolResult(harness, "runner"))).toContain("killed=true");
		expect(getMessageText(getToolResult(harness, "runner"))).not.toContain("out=x");
		// The gateway saw the abort: the prompt's answer arrived after it and does not count.
		expect(harness.session.permissions.audit.tail(1)[0]).toMatchObject({ decision: "deny", source: "timeout" });
	});

	it("does not start a command whose prompt was answered after the extension context went stale", async () => {
		const harness = await start({ extensionFactories: [runnerExtension("echo", ["late"])] });
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({
				select: async (title) => {
					if (title.includes("Permission needed: runner")) return "Allow once";
					harness.session.extensionRunner.invalidate();
					return "Allow once";
				},
			}),
		});
		harness.setResponses(callRunner());
		await harness.session.prompt("go");
		const result = getToolResult(harness, "runner");
		expect(getMessageText(result)).toContain("stale");
		expect(result.isError).toBe(true);
		expect(getMessageText(result)).not.toContain("out=late");
	});

	it("makes pi.authorizeExec reject for a caller whose session went stale while the prompt was open", async () => {
		let spawned = false;
		const harness = await start({
			extensionFactories: [
				(pi: ExtensionAPI) => {
					pi.registerTool({
						name: "runner",
						label: "runner",
						description: "Authorizes, then would spawn.",
						parameters: Type.Object({}),
						execute: async () => {
							await pi.authorizeExec("echo", ["x"]);
							spawned = true;
							return { content: [{ type: "text", text: "spawned" }], details: {} };
						},
					});
				},
			],
		});
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({
				select: async (title) => {
					if (!title.includes("Permission needed: runner")) harness.session.extensionRunner.invalidate();
					return "Allow once";
				},
			}),
		});
		harness.setResponses(callRunner());
		await harness.session.prompt("go");
		expect(getMessageText(getToolResult(harness, "runner"))).toContain("stale");
		expect(spawned).toBe(false);
	});

	it("leaves pi.exec alone in the default mode: no prompt, no audit entry", async () => {
		const harness = await createHarness({ extensionFactories: [runnerExtension("echo", ["free"])] });
		harnesses.push(harness);
		harness.setResponses(callRunner());
		await harness.session.prompt("go");
		expect(getMessageText(getToolResult(harness, "runner"))).toContain("out=free");
		expect(harness.session.permissions.audit.tail(5)).toEqual([]);
	});

	it("does not gate a pi.exec that an extension factory runs while loading, before the gateway is bound", async () => {
		let loadTimeRun: Promise<{ stdout: string }> | undefined;
		const harness = await start({
			extensionFactories: [
				(pi: ExtensionAPI) => {
					loadTimeRun = pi.exec("echo", ["load-time"]);
				},
			],
		});
		expect((await loadTimeRun)?.stdout.trim()).toBe("load-time");
		expect(harness.session.permissions.audit.tail(5)).toEqual([]);
	});

	it("leaves behavior unchanged in the default mode", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses(callBash("echo default-mode"));
		await harness.session.prompt("go");
		expect(getMessageText(getToolResult(harness, "bash"))).toContain("default-mode");
	});
});

describe("AgentSession permission gateway and provider !command values", () => {
	const harnesses: Harness[] = [];
	let agentDir: string;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "perm-provider-"));
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
	});

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		vi.unstubAllEnvs();
		rmSync(agentDir, { recursive: true, force: true });
	});

	const marker = (name: string) => join(agentDir, name);
	/** A `!command` value that leaves a file behind when it runs, so a test can tell whether it did. */
	const touching = (name: string, output: string) => `!touch ${marker(name)} && echo ${output}`;

	const acme = (overrides: Record<string, unknown>) => ({
		baseUrl: "http://acme.invalid",
		api: "openai-completions",
		models: [
			{
				id: "m",
				name: "m",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1000,
				maxTokens: 100,
			},
		],
		...overrides,
	});

	async function setup(options: {
		manual?: boolean;
		provider?: Record<string, unknown>;
		modelsJson?: unknown;
		answer?: () => string;
	}) {
		const prompts: string[] = [];
		const harness = await createHarness({
			...(options.manual === false ? {} : { settings: { permissionMode: "manual" as const } }),
			...(options.modelsJson === undefined ? {} : { modelsJson: options.modelsJson as never }),
			extensionFactories: options.provider
				? [(pi: ExtensionAPI) => pi.registerProvider("acme", options.provider as never)]
				: [],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({
				select: async (title) => {
					prompts.push(title);
					return options.answer?.() ?? "Deny";
				},
			}),
		});
		return { harness, prompts, runtime: harness.session.modelRuntime };
	}

	it("asks before an extension provider's apiKey and header commands run, naming the extension", async () => {
		const { prompts, runtime } = await setup({
			provider: acme({ apiKey: touching("key", "keyval"), headers: { "X-T": touching("hdr", "hdrval") } }),
			answer: () => "Deny",
		});
		await expect(runtime.getAuth("acme")).rejects.toThrow("user denied");
		expect(prompts[0]).toContain("Permission needed: pi.exec");
		expect(prompts[0]).toContain("Extension: <inline:");
		expect(prompts[0]).toContain("sh -c");
		// Denied: neither command ran.
		expect(existsSync(marker("key"))).toBe(false);
		expect(existsSync(marker("hdr"))).toBe(false);
	});

	it("runs the commands once the user allows them, and uses their output", async () => {
		const { prompts, runtime } = await setup({
			provider: acme({ apiKey: touching("key", "keyval"), headers: { "X-T": touching("hdr", "hdrval") } }),
			answer: () => "Allow once",
		});
		const auth = await runtime.getAuth("acme");
		expect(prompts).toHaveLength(2);
		expect(auth?.auth.apiKey).toBe("keyval");
		expect(auth?.auth.headers).toMatchObject({ "X-T": "hdrval" });
		expect(existsSync(marker("key"))).toBe(true);
		expect(existsSync(marker("hdr"))).toBe(true);
	});

	it("asks about the headers of an extension's model before a request resolves them", async () => {
		const models = acme({}).models.map((model) => ({ ...model, headers: { "X-M": touching("model", "modelval") } }));
		const { prompts, runtime } = await setup({
			provider: acme({ apiKey: "literal-key", models }),
			answer: () => "Deny",
		});
		const model = runtime.getModel("acme", "m");
		if (!model) throw new Error("model not registered");
		await expect(runtime.getAuth(model)).rejects.toThrow("user denied");
		expect(prompts.join("\n")).toContain("touch");
		expect(existsSync(marker("model"))).toBe(false);
	});

	it("asks before the fallback request config runs an extension's header command", async () => {
		const { prompts, runtime } = await setup({
			provider: acme({ apiKey: "literal-key", headers: { "X-C": touching("compat", "compatval") } }),
			answer: () => "Deny",
		});
		const model = runtime.getModel("acme", "m");
		if (!model) throw new Error("model not registered");
		await expect(runtime.getCompatibilityRequestConfig(model)).rejects.toThrow("user denied");
		expect(prompts).toHaveLength(1);
		expect(existsSync(marker("compat"))).toBe(false);
	});

	it("asks before an OAuth extension provider's header command runs", async () => {
		const { harness, prompts, runtime } = await setup({
			provider: acme({
				oauth: {
					name: "Acme",
					login: async () => ({ access: "a", refresh: "r", expires: Date.now() + 3_600_000 }),
					refreshToken: async (credentials: unknown) => credentials,
					getApiKey: (credentials: { access: string }) => credentials.access,
				},
				headers: { "X-O": touching("oauth", "oauthval") },
			}),
			answer: () => "Deny",
		});
		await harness.authStorage.modify("acme", async () => ({
			type: "oauth",
			access: "a",
			refresh: "r",
			expires: Date.now() + 3_600_000,
		}));
		await expect(runtime.getAuth("acme")).rejects.toThrow("user denied");
		expect(prompts).toHaveLength(1);
		expect(existsSync(marker("oauth"))).toBe(false);
	});

	it("does not ask about literal values, or about commands in the user's own models.json", async () => {
		const { prompts, runtime } = await setup({
			provider: acme({ apiKey: "literal-key", headers: { "X-L": "literal" } }),
			modelsJson: {
				providers: {
					mine: {
						baseUrl: "http://mine.invalid",
						api: "openai-completions",
						apiKey: touching("user", "userkey"),
						models: [{ id: "m" }],
					},
				},
			},
		});
		expect((await runtime.getAuth("acme"))?.auth.apiKey).toBe("literal-key");
		expect((await runtime.getAuth("mine"))?.auth.apiKey).toBe("userkey");
		expect(prompts).toEqual([]);
		expect(existsSync(marker("user"))).toBe(true);
	});

	it("names the extension for a provider registered while extensions load, as the CLI registers it", async () => {
		const services = await createAgentSessionServices({
			cwd: agentDir,
			agentDir,
			resourceLoaderOptions: {
				extensionFactories: [
					(pi: ExtensionAPI) => pi.registerProvider("acme", acme({ apiKey: touching("key", "keyval") }) as never),
				],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		});
		const callers: string[] = [];
		services.modelRuntime.addExecAuthorizer(async (_command, _args, caller) => {
			callers.push(caller);
			throw new Error("refused");
		});
		await expect(services.modelRuntime.getAuth("acme")).rejects.toThrow("refused");
		expect(callers).toHaveLength(1);
		expect(callers[0]).toMatch(/^<inline:/);
		expect(existsSync(marker("key"))).toBe(false);
	});

	it("does not ask about header commands of a provider that has no credential to send them with", async () => {
		const { prompts, runtime } = await setup({
			provider: acme({ headers: { "X-H": touching("hdr", "hdrval") } }),
			answer: () => "Deny",
		});
		expect(await runtime.getAuth("acme")).toBeUndefined();
		expect(prompts).toEqual([]);
		expect(existsSync(marker("hdr"))).toBe(false);
	});

	it("passes the caller's abort signal to the check", async () => {
		const models = acme({}).models.map((model) => ({ ...model, headers: { "X-M": touching("model", "v") } }));
		const { runtime } = await setup({ manual: false, provider: acme({ apiKey: "literal-key", models }) });
		const seen: Array<AbortSignal | undefined> = [];
		runtime.addExecAuthorizer(async (_command, _args, _caller, signal) => {
			seen.push(signal);
		});
		const model = runtime.getModel("acme", "m");
		if (!model) throw new Error("model not registered");
		const controller = new AbortController();
		await runtime.getAuth(model, { signal: controller.signal });
		expect(seen).toEqual([controller.signal]);
	});

	it("needs every installed check to allow, so another session's check cannot switch this one off", async () => {
		const { harness, prompts, runtime } = await setup({
			provider: acme({ apiKey: touching("key", "keyval") }),
			answer: () => "Deny",
		});
		const removeOther = runtime.addExecAuthorizer(async () => {});
		await expect(runtime.getAuth("acme")).rejects.toThrow("user denied");
		expect(prompts).toHaveLength(1);
		expect(existsSync(marker("key"))).toBe(false);
		// Disposing the session takes its check away; the other one alone then allows.
		harness.session.dispose();
		expect((await runtime.getAuth("acme"))?.auth.apiKey).toBe("keyval");
		removeOther();
	});

	it("shares one prompt between concurrent resolutions of the same command", async () => {
		const { runtime } = await setup({ manual: false, provider: acme({ apiKey: touching("key", "keyval") }) });
		const answer = Promise.withResolvers<void>();
		let asked = 0;
		runtime.addExecAuthorizer(() => {
			asked++;
			return answer.promise;
		});
		const both = Promise.all([runtime.getAuth("acme"), runtime.getAuth("acme")]);
		await vi.waitFor(() => expect(asked).toBe(1));
		answer.resolve();
		const [first, second] = await both;
		expect([first?.auth.apiKey, second?.auth.apiKey]).toEqual(["keyval", "keyval"]);
		expect(asked).toBe(1);
	});

	it("remembers an allow for a short time, and never a refusal", async () => {
		const allowed = await setup({
			provider: acme({ apiKey: touching("key", "keyval") }),
			answer: () => "Allow once",
		});
		await allowed.runtime.getAuth("acme");
		await allowed.runtime.getAuth("acme");
		expect(allowed.prompts).toHaveLength(1);
		const now = Date.now();
		const clock = vi.spyOn(Date, "now").mockReturnValue(now + 31_000);
		try {
			await allowed.runtime.getAuth("acme");
		} finally {
			clock.mockRestore();
		}
		expect(allowed.prompts).toHaveLength(2);

		const denied = await setup({ provider: acme({ apiKey: touching("key2", "v") }), answer: () => "Deny" });
		await expect(denied.runtime.getAuth("acme")).rejects.toThrow("user denied");
		await expect(denied.runtime.getAuth("acme")).rejects.toThrow("user denied");
		expect(denied.prompts).toHaveLength(2);
	});

	it("is a no-op in unrestricted mode: the commands run, with no prompt and no audit entry", async () => {
		const { harness, prompts, runtime } = await setup({
			manual: false,
			provider: acme({ apiKey: touching("key", "keyval") }),
		});
		expect((await runtime.getAuth("acme"))?.auth.apiKey).toBe("keyval");
		expect(prompts).toEqual([]);
		expect(harness.session.permissions.audit.tail(5)).toEqual([]);
	});
});
