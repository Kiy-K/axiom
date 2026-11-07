import { fauxAssistantMessage, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import type { ToolResultMessage } from "@earendil-works/pi-ai/compat";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

/** The text of the most recent tool result for `toolName`, from the transcript the model would see. */
function lastToolResultText(context: TranscriptContext, toolName: string): string {
	const results = context.messages.filter(
		(message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === toolName,
	);
	const last = results[results.length - 1];
	if (!last) throw new Error(`no ${toolName} result in transcript`);
	return last.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

describe("AgentSession editMode", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("gives the model the line-ID edit schema and the ID-bearing read output when editMode is hashline", async () => {
		const harness = await createHarness({ settings: { editMode: "hashline" } });
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const path = join(harness.tempDir, "notes.txt");
		writeFileSync(path, "alpha\nbeta\n");

		const edit = harness.session.agent.state.tools.find((tool) => tool.name === "edit");
		expect(edit?.parameters.properties).toHaveProperty("tag");

		const seenEditSchemaItems: string[] = [];
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path })], { stopReason: "toolUse" }),
			(context: TranscriptContext) => {
				const shown = lastToolResultText(context, "read");
				const tag = /\[file tag ([0-9a-f]{8})\]/.exec(shown)?.[1];
				const id = /^(2#[0-9a-f]{2})\|beta$/m.exec(shown)?.[1];
				if (!tag || !id) throw new Error(`read output lacks tag or ID: ${shown}`);
				return fauxAssistantMessage(
					[fauxToolCall("edit", { path, tag, edits: [{ op: "replace", start: id, text: "BETA" }] })],
					{ stopReason: "toolUse" },
				);
			},
			(context: TranscriptContext) => {
				seenEditSchemaItems.push(lastToolResultText(context, "edit"));
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("change beta");

		expect(readFileSync(path, "utf8")).toBe("alpha\nBETA\n");
		expect(seenEditSchemaItems[0]).toContain("Successfully edited");
	});

	it("uses the line-ID edit schema when editMode is not set", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		await harness.session.bindExtensions({});

		const edit = harness.session.agent.state.tools.find((tool) => tool.name === "edit");
		expect(edit?.parameters.properties).toHaveProperty("tag");
	});

	it("keeps the exact-text edit schema when editMode is replace", async () => {
		const harness = await createHarness({ settings: { editMode: "replace" } });
		harnesses.push(harness);
		await harness.session.bindExtensions({});

		const edit = harness.session.agent.state.tools.find((tool) => tool.name === "edit");
		expect(edit?.parameters.properties).not.toHaveProperty("tag");
		expect(JSON.stringify(edit?.parameters)).toContain("oldText");
	});
});
