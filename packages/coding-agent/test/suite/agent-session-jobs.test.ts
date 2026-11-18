import { existsSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getMessageText, getToolResult, type Harness } from "./harness.ts";

/** Real processes take real time; poll the session until the condition holds or the deadline passes. */
async function until(predicate: () => boolean, ms: number): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	return predicate();
}

describe("AgentSession background jobs", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("starts a background bash job from the model and announces its finish with the next prompt", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("bash", { command: "echo started; sleep 0.3; echo finished", background: true })],
				{
					stopReason: "toolUse",
				},
			),
			fauxAssistantMessage("launched"),
		]);
		await harness.session.prompt("run the tests in the background");

		const jobs = harness.session.listJobs();
		expect(jobs).toHaveLength(1);
		const [job] = jobs;
		expect(await until(() => harness.session.listJobs()[0]?.state !== "running", 5_000)).toBe(true);
		expect(harness.session.listJobs()[0]?.state).toBe("completed");

		harness.setResponses([fauxAssistantMessage("noted")]);
		await harness.session.prompt("what happened to the tests?");
		const notices = harness.session.messages.filter(
			(message) => message.role === "custom" && message.customType === "job_finished",
		);
		expect(notices).toHaveLength(1);
		expect(JSON.stringify(notices[0])).toContain(job.jobId);
		expect(JSON.stringify(notices[0])).toContain("completed");
		// The notice carries no command output; the model reads it with the job tool.
		expect(getMessageText(notices[0])).not.toContain("finished");
	}, 20_000);

	it("stops the session's running jobs when the session stops them", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 30", background: true })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("started"),
		]);
		await harness.session.prompt("start a long job");
		expect(harness.session.listJobs()[0]?.state).toBe("running");

		const started = Date.now();
		await harness.session.stopJobs();
		expect(Date.now() - started).toBeLessThan(5_000);
		expect(harness.session.listJobs()[0]?.state).toBe("stopped");
	}, 20_000);

	it.each([false, true])(
		"only launches a host background job in a non-git workspace when sandbox enabled=%s",
		async (enabled) => {
			const harness = await createHarness({ settings: { sandbox: { enabled } } });
			harnesses.push(harness);
			const marker = join(harness.tempDir, "background-marker");
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("bash", { command: `touch '${marker}'`, background: true })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("done"),
			]);
			try {
				await harness.session.prompt("start the job");
				if (enabled) {
					expect((await harness.session.sandbox?.ready)?.kind).toBe("failed");
					expect(getToolResult(harness, "bash").isError).toBe(true);
					expect(getMessageText(getToolResult(harness, "bash"))).toContain(
						"Background jobs require an execution backend with retained process handles.",
					);
					expect(harness.session.listJobs()).toHaveLength(0);
					expect(existsSync(marker)).toBe(false);
				} else {
					expect(await until(() => existsSync(marker), 5_000)).toBe(true);
					expect(harness.session.listJobs()).toHaveLength(1);
				}
			} finally {
				await harness.session.stopJobs();
				await harness.session.sandbox?.close();
			}
		},
		30_000,
	);

	it("activates the job tool only while a shell tool is active", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		expect(harness.session.getActiveToolNames()).toContain("job");

		harness.session.setActiveToolsByName(["read", "edit", "write"]);
		expect(harness.session.getActiveToolNames()).not.toContain("job");

		harness.session.setActiveToolsByName(["read", "powershell"]);
		expect(harness.session.getActiveToolNames()).toContain("job");
	});
});
