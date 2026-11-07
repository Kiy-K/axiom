import { describe, expect, it } from "vitest";
import {
	applyHashlineEdits,
	changedRange,
	decodeTextFile,
	type HashlineEdit,
	lineHash,
	parseLines,
	renderLines,
	serializeLines,
} from "../src/core/tools/hashline.ts";

const TAG = "3fa91c0e";
const ALL_SHOWN = () => true;

/** The line ID read would show for 1-based line `n` of `text` under TAG. */
function id(text: string, n: number): string {
	return `${n}#${lineHash(TAG, n, parseLines(text)[n - 1].text)}`;
}

function apply(text: string, edits: HashlineEdit[], shown: (line: number) => boolean = ALL_SHOWN): string {
	return serializeLines(applyHashlineEdits(parseLines(text), TAG, shown, edits));
}

describe("lineHash", () => {
	// Vectors from `printf '<tag>\n<n>\n<text>' | sha256sum`, computed outside this code.
	it("matches an independent SHA-256 over tag, number and text", () => {
		expect(lineHash(TAG, 1, "a")).toBe("cf");
		expect(lineHash(TAG, 2, "")).toBe("96");
	});

	it("gives identical lines at different positions different IDs", () => {
		const ids = renderLines(parseLines("}\n}\n}\n"), TAG, 0, 3).map((line) => line.split("|")[0]);
		expect(new Set(ids).size).toBe(3);
	});

	it("changes the ID of a line when the tag changes", () => {
		expect(lineHash("3fa91c0e", 1, "a")).not.toBe(lineHash("00000000", 1, "a"));
	});
});

describe("decodeTextFile", () => {
	it("refuses invalid UTF-8 and NUL bytes", () => {
		expect(decodeTextFile(Buffer.from([0xff, 0xfe, 0x41]))).toBeUndefined();
		expect(decodeTextFile(Buffer.from("a\0b"))).toBeUndefined();
	});

	it("keeps a BOM in the text so the caller can split it off", () => {
		expect(decodeTextFile(Buffer.from("\uFEFFabc"))).toBe("\uFEFFabc");
	});
});

describe("line parsing", () => {
	it("keeps each line's own ending and the missing final newline", () => {
		const text = "a\r\nb\nc";
		expect(parseLines(text)).toEqual([
			{ text: "a", eol: "\r\n" },
			{ text: "b", eol: "\n" },
			{ text: "c", eol: "" },
		]);
		expect(serializeLines(parseLines(text))).toBe(text);
	});

	it("treats a lone CR as line content, not an ending", () => {
		expect(parseLines("a\rb\n")).toEqual([{ text: "a\rb", eol: "\n" }]);
	});

	it("does not count the empty piece after a final newline as a line", () => {
		expect(parseLines("a\n")).toHaveLength(1);
		expect(parseLines("")).toHaveLength(0);
		expect(parseLines("\n")).toEqual([{ text: "", eol: "\n" }]);
	});
});

describe("applyHashlineEdits", () => {
	it("replaces one line and leaves every other byte alone", () => {
		const text = "one\r\ntwo\nthree\r\n";
		expect(apply(text, [{ op: "replace", start: id(text, 2), text: "TWO" }])).toBe("one\r\nTWO\nthree\r\n");
	});

	it("applies several disjoint edits against the lines as read", () => {
		const text = "a\nb\nc\nd\n";
		const result = apply(text, [
			{ op: "delete", start: id(text, 1) },
			{ op: "replace", start: id(text, 3), end: id(text, 4), text: "C\nD" },
		]);
		expect(result).toBe("b\nC\nD\n");
	});

	it("keeps the array order of inserts at the same gap", () => {
		const text = "x\ny\n";
		const result = apply(text, [
			{ op: "insert_after", start: id(text, 1), text: "first" },
			{ op: "insert_after", start: id(text, 1), text: "second" },
		]);
		expect(result).toBe("x\nfirst\nsecond\ny\n");
	});

	it("inserts at the start of the file with insert_after 0", () => {
		expect(apply("x\n", [{ op: "insert_after", start: "0", text: "top" }])).toBe("top\nx\n");
	});

	it("allows an insert at the boundary of a replaced range but refuses one inside it", () => {
		const text = "a\nb\nc\n";
		expect(
			apply(text, [
				{ op: "replace", start: id(text, 1), end: id(text, 2), text: "x" },
				{ op: "insert_after", start: id(text, 2), text: "y" },
			]),
		).toBe("x\ny\nc\n");
		expect(() =>
			apply(text, [
				{ op: "replace", start: id(text, 1), end: id(text, 3), text: "x" },
				{ op: "insert_after", start: id(text, 1), text: "y" },
			]),
		).toThrow(/inside lines 1-3/);
	});

	it("adds an ending to a missing-final-newline line when text is appended after it", () => {
		const text = "a\nb";
		expect(apply(text, [{ op: "insert_after", start: id(text, 2), text: "c" }])).toBe("a\nb\nc");
	});

	it("uses CRLF for an append after a CRLF file with no final newline", () => {
		const text = "a\r\nb\r\nc";
		expect(apply(text, [{ op: "insert_after", start: id(text, 3), text: "X" }])).toBe("a\r\nb\r\nc\r\nX");
	});

	it("uses the first line's CRLF for an insert at the top of a CRLF file", () => {
		const text = "a\r\nb\r\n";
		expect(apply(text, [{ op: "insert_after", start: "0", text: "top" }])).toBe("top\r\na\r\nb\r\n");
	});

	it("keeps a file without a final newline without one after a replace of its last line", () => {
		const text = "a\nb";
		expect(apply(text, [{ op: "replace", start: id(text, 2), text: "B" }])).toBe("a\nB");
	});

	it("drops the final newline of a CRLF file when its last line is deleted without one", () => {
		const text = "a\r\nb";
		expect(apply(text, [{ op: "delete", start: id(text, 2) }])).toBe("a");
	});

	it("keeps the final newline when the file had one", () => {
		const text = "a\nb\n";
		expect(apply(text, [{ op: "delete", start: id(text, 2) }])).toBe("a\n");
	});

	it("keeps the neighbor's line ending for new lines in a CRLF file", () => {
		const text = "a\r\nb\r\n";
		expect(apply(text, [{ op: "insert_after", start: id(text, 1), text: "new" }])).toBe("a\r\nnew\r\nb\r\n");
	});

	it("writes an empty file's first lines with LF and a final newline", () => {
		expect(apply("", [{ op: "insert_after", start: "0", text: "hello" }])).toBe("hello\n");
	});

	it("treats a trailing newline in text as the end of the last line, not an extra blank line", () => {
		const text = "a\nb\n";
		expect(apply(text, [{ op: "replace", start: id(text, 1), text: "A\n" }])).toBe("A\nb\n");
		expect(apply(text, [{ op: "replace", start: id(text, 1), text: "A\n\n" }])).toBe("A\n\nb\n");
	});

	it("turns a CRLF in text into the neighbor's line ending", () => {
		const text = "a\nb\n";
		expect(apply(text, [{ op: "replace", start: id(text, 1), text: "x\r\ny" }])).toBe("x\ny\nb\n");
		expect(apply(text, [{ op: "replace", start: id(text, 1), text: "x\r\n" }])).toBe("x\nb\n");
	});

	it("refuses an ID that does not match the current tag's hash, even at a shown line", () => {
		const oldId = `2#${lineHash("00000000", 2, "")}`;
		expect(() =>
			applyHashlineEdits(parseLines("a\n\n\n"), TAG, ALL_SHOWN, [{ op: "replace", start: oldId, text: "x" }]),
		).toThrow(/does not match the current content of line 2/);
	});

	it("refuses a correct ID for a line the model was not shown under this tag", () => {
		const text = "a\nb\nc\n";
		const notShown = (line: number) => line <= 2;
		expect(() => apply(text, [{ op: "replace", start: id(text, 3), text: "C" }], notShown)).toThrow(
			/was not shown to you under the current file tag/,
		);
		expect(apply(text, [{ op: "replace", start: id(text, 2), text: "B" }], notShown)).toBe("a\nB\nc\n");
	});

	it("refuses an ID past the end of the file", () => {
		expect(() => apply("a\n", [{ op: "delete", start: "9#00" }])).toThrow(/out of range/);
	});

	it("refuses a malformed ID and an ID with leading zeros", () => {
		expect(() => apply("a\n", [{ op: "delete", start: "a" }])).toThrow(/is not a line ID/);
		expect(() => apply("a\n", [{ op: "delete", start: `01#${lineHash(TAG, 1, "a")}` }])).toThrow(/is not a line ID/);
	});

	it("names the shown line that carries a bare hash", () => {
		const hash = lineHash(TAG, 2, "b");
		expect(() => apply("a\nb\n", [{ op: "delete", start: hash }])).toThrow(`2#${hash}`);
	});

	it("does not name a line the model was not shown", () => {
		const hash = lineHash(TAG, 2, "b");
		let message = "";
		try {
			apply("a\nb\n", [{ op: "delete", start: hash }], (line) => line !== 2);
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message).toContain("is not a line ID");
		expect(message).not.toContain(`2#${hash}`);
	});

	it("refuses a read line prefix pasted into text", () => {
		const text = "a\nb\n";
		expect(() => apply(text, [{ op: "replace", start: id(text, 1), text: `1#${lineHash(TAG, 1, "A")}|A` }])).toThrow(
			/copied from read/,
		);
	});

	it("refuses an empty text, a lone carriage return at the end, and a lone surrogate", () => {
		const text = "a\n";
		expect(() => apply(text, [{ op: "replace", start: id(text, 1), text: "" }])).toThrow(/text is empty/);
		expect(() => apply(text, [{ op: "replace", start: id(text, 1), text: "a\r" }])).toThrow(/carriage return/);
		expect(() => apply(text, [{ op: "replace", start: id(text, 1), text: "a\n\r" }])).toThrow(/carriage return/);
		expect(() => apply(text, [{ op: "replace", start: id(text, 1), text: "x\ry" }])).toThrow(/carriage return/);
		expect(() => apply(text, [{ op: "replace", start: id(text, 1), text: "\ud800" }])).toThrow(/lone UTF-16/);
	});

	it("refuses text on delete and an end on insert_after", () => {
		const text = "a\nb\n";
		expect(() => apply(text, [{ op: "delete", start: id(text, 1), text: "x" }])).toThrow(/delete takes no text/);
		expect(() => apply(text, [{ op: "insert_after", start: id(text, 1), end: id(text, 2), text: "x" }])).toThrow(
			/end is only for replace and delete/,
		);
	});

	it("refuses the removed insert_before op", () => {
		const text = "a\n";
		expect(() => apply(text, [{ op: "insert_before", start: id(text, 1), text: "x" }])).toThrow(/Unknown op/);
	});

	it("refuses overlapping replacements", () => {
		const text = "a\nb\nc\n";
		expect(() =>
			apply(text, [
				{ op: "replace", start: id(text, 1), end: id(text, 2), text: "x" },
				{ op: "replace", start: id(text, 2), text: "y" },
			]),
		).toThrow(/overlap/);
	});

	it("refuses an end before its start", () => {
		const text = "a\nb\n";
		expect(() => apply(text, [{ op: "delete", start: id(text, 2), end: id(text, 1) }])).toThrow(/is before start/);
	});

	it("refuses an edit that changes nothing", () => {
		const text = "a\nb\n";
		expect(() => apply(text, [{ op: "replace", start: id(text, 1), text: "a" }])).toThrow(/identical content/);
	});

	it("refuses a replace or insert with no text", () => {
		const text = "a\n";
		expect(() => apply(text, [{ op: "replace", start: id(text, 1) }])).toThrow(/needs text/);
	});

	it("does not modify the input lines when it refuses", () => {
		const lines = parseLines("a\nb\n");
		const before = JSON.stringify(lines);
		expect(() => applyHashlineEdits(lines, TAG, ALL_SHOWN, [{ op: "replace", start: "1#00", text: "x" }])).toThrow();
		expect(JSON.stringify(lines)).toBe(before);
	});
});

describe("changedRange", () => {
	it("returns the lines that differ, not the whole file", () => {
		const before = parseLines("a\nb\nc\nd\n");
		const after = parseLines("a\nB\nC\nd\n");
		expect(changedRange(before, after)).toEqual({ from: 1, to: 3 });
	});
});
