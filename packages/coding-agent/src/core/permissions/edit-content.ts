// Check an edit's result against the same snapshot and transformations used by the built-in tools.

import { splitBom } from "../../utils/text.ts";
import type { EditMode } from "../settings-manager.ts";
import { applyEditsToNormalizedContent, type Edit, normalizeToLF } from "../tools/edit-diff.ts";
import {
	applyHashlineEdits,
	decodeTextFile,
	fileTag,
	type HashlineEdit,
	MAX_HASHLINE_BYTES,
	parseLines,
	serializeLines,
} from "../tools/hashline.ts";

/** Return false when an edit is invalid, unverifiable, or would leave the file empty. */
export function editLeavesContent(original: Buffer, mode: EditMode, input: Record<string, unknown>): boolean {
	try {
		// Tool input is model-supplied; the active tool's schema is known, so only that schema is accepted.
		if (!Array.isArray(input.edits) || input.edits.length === 0 || original.length > MAX_HASHLINE_BYTES) return false;
		const text = decodeTextFile(original);
		if (text === undefined) return false;
		const content = splitBom(text).text;
		if (mode === "hashline") {
			const tag = fileTag(original);
			if (typeof input.tag !== "string" || input.tag !== tag) return false;
			const edits: HashlineEdit[] = [];
			for (const edit of input.edits) {
				if (!edit || typeof edit !== "object" || typeof edit.op !== "string" || typeof edit.start !== "string")
					return false;
				if ("oldText" in edit || "newText" in edit) return false;
				if (edit.end !== undefined && typeof edit.end !== "string") return false;
				if (edit.text !== undefined && typeof edit.text !== "string") return false;
				edits.push({ op: edit.op, start: edit.start, end: edit.end, text: edit.text });
			}
			return serializeLines(applyHashlineEdits(parseLines(content), tag, () => true, edits)).length > 0;
		}
		const edits: Edit[] = [];
		for (const edit of input.edits) {
			if (!edit || typeof edit !== "object" || typeof edit.oldText !== "string" || typeof edit.newText !== "string")
				return false;
			edits.push({ oldText: edit.oldText, newText: edit.newText });
		}
		return applyEditsToNormalizedContent(normalizeToLF(content), edits, "edit").newContent.length > 0;
	} catch {
		return false;
	}
}
