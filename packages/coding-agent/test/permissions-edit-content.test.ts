import { describe, expect, it } from "vitest";
import { editLeavesContent } from "../src/core/permissions/edit-content.ts";
import { fileTag, lineHash } from "../src/core/tools/hashline.ts";

// Issue #1: automatic edit approval must not allow an edit that empties a file.
describe("automatic edit content check", () => {
	it("checks the actual result of replacement edits", () => {
		const original = Buffer.from("hello\nworld\n");
		expect(editLeavesContent(original, "replace", { edits: [{ oldText: "hello", newText: "hi" }] })).toBe(true);
		expect(editLeavesContent(original, "replace", { edits: [{ oldText: "hello\nworld\n", newText: "" }] })).toBe(
			false,
		);
		expect(editLeavesContent(original, "replace", { edits: [{ oldText: "missing", newText: "hi" }] })).toBe(false);
	});

	it("checks hashline changes against the current snapshot", () => {
		const original = Buffer.from("hello\nworld\n");
		const tag = fileTag(original);
		const start = `1#${lineHash(tag, 1, "hello")}`;
		const end = `2#${lineHash(tag, 2, "world")}`;
		expect(editLeavesContent(original, "hashline", { tag, edits: [{ op: "delete", start }] })).toBe(true);
		expect(editLeavesContent(original, "hashline", { tag, edits: [{ op: "delete", start, end }] })).toBe(false);
		expect(editLeavesContent(original, "hashline", { tag: "stale", edits: [{ op: "delete", start }] })).toBe(false);
		// Mixed schemas must not select a verifier different from the executing tool.
		expect(
			editLeavesContent(original, "hashline", {
				tag,
				edits: [{ op: "delete", start, oldText: "hello\nworld\n", newText: "" }],
			}),
		).toBe(false);
	});
});
