import {
	chmodSync,
	createReadStream,
	existsSync,
	linkSync,
	lstatSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EditOperations } from "../src/core/tools/edit.ts";
import { fileTag, lineHash, MAX_HASHLINE_BYTES } from "../src/core/tools/hashline.ts";
import { createHashlineEditToolDefinition, replaceFileAtomically } from "../src/core/tools/hashline-edit.ts";
import { createReadToolDefinition } from "../src/core/tools/read.ts";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "hashline-tools-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

type EditArg = { op: string; start: string; end?: string; text?: string };
type Content = Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;

function textOf(content: Content): string {
	return content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

async function read(path: string, args: { offset?: number; limit?: number } = {}): Promise<string> {
	const tool = createReadToolDefinition(dir, { hashline: true });
	const result = await tool.execute("read", { path, ...args }, undefined, undefined, undefined as never);
	return textOf(result.content);
}

/** The `N#HH` ID that read shows for line `n` in `shown`. */
function idOf(shown: string, n: number): string {
	const line = shown.split("\n").find((row) => row.startsWith(`${n}#`));
	if (!line) throw new Error(`line ${n} not in read output`);
	return line.split("|")[0];
}

function tagOf(shown: string): string {
	const match = /^\[file tag ([0-9a-f]{8})\]/.exec(shown);
	if (!match) throw new Error("no file tag in read output");
	return match[1];
}

async function edit(path: string, tag: string, edits: EditArg[], operations?: EditOperations) {
	const tool = createHashlineEditToolDefinition(dir, { operations });
	return tool.execute("edit", { path, tag, edits }, undefined, undefined, undefined as never);
}

describe("hashline read", () => {
	it("shows a file tag of the raw bytes and N#HH| IDs for each line", async () => {
		const path = join(dir, "f.txt");
		const bytes = Buffer.from("alpha\nbeta\n");
		writeFileSync(path, bytes);
		const shown = await read(path);
		expect(tagOf(shown)).toBe(fileTag(bytes));
		expect(shown).toContain(`1#${lineHash(fileTag(bytes), 1, "alpha")}|alpha`);
		expect(shown).toContain(`2#${lineHash(fileTag(bytes), 2, "beta")}|beta`);
	});

	it("gives an empty file a tag and no lines", async () => {
		const path = join(dir, "empty.txt");
		writeFileSync(path, "");
		expect(await read(path)).toBe(`[file tag ${fileTag(Buffer.alloc(0))}]\n`);
	});

	it("reports offset past the last line of a file that ends with a newline", async () => {
		const path = join(dir, "f.txt");
		writeFileSync(path, "a\n");
		await expect(read(path, { offset: 2 })).rejects.toThrow(/beyond end of file \(1 lines total\)/);
	});

	it("shows no tag or IDs for invalid UTF-8, so such a file cannot be edited by line", async () => {
		const path = join(dir, "latin1.txt");
		writeFileSync(path, Buffer.from([0x61, 0xff, 0x0a]));
		const shown = await read(path);
		expect(shown).not.toContain("[file tag");
		expect(shown).not.toContain("|");
	});
});

describe("hashline edit", () => {
	it("applies an edit read by ID and returns the new tag and IDs", async () => {
		const path = join(dir, "f.txt");
		writeFileSync(path, "alpha\nbeta\n");
		const shown = await read(path);
		const result = await edit(path, tagOf(shown), [{ op: "replace", start: idOf(shown, 2), text: "BETA" }]);
		const written = readFileSync(path);
		expect(written.toString()).toBe("alpha\nBETA\n");
		const text = textOf(result.content);
		expect(text).toContain(`New file tag: ${fileTag(written)}.`);
		expect(text).toContain(`2#${lineHash(fileTag(written), 2, "BETA")}|BETA`);
	});

	it("refuses a stale tag, writes nothing, and says an earlier call may have changed the file", async () => {
		const path = join(dir, "f.txt");
		writeFileSync(path, "alpha\nbeta\n");
		const shown = await read(path);
		writeFileSync(path, "changed\nbeta\n");
		await expect(edit(path, tagOf(shown), [{ op: "replace", start: idOf(shown, 2), text: "X" }])).rejects.toThrow(
			/changed since it was read.*possibly by an earlier call in this turn/,
		);
		expect(readFileSync(path, "utf8")).toBe("changed\nbeta\n");
	});

	it("a stale refusal writes nothing, shows at most 20 retry lines, and accepts an ID from them on retry", async () => {
		const path = join(dir, "f.txt");
		const original = `${Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n")}\n`;
		writeFileSync(path, original);
		const shown = await read(path);
		writeFileSync(path, `header\n${original}`);
		const refusal = await edit(path, tagOf(shown), [{ op: "replace", start: idOf(shown, 10), text: "TEN" }]).then(
			() => "",
			(error: Error) => error.message,
		);
		expect(readFileSync(path, "utf8")).toBe(`header\n${original}`);
		const retryLines = refusal.match(/^\d+#[0-9a-f]{2}\|/gm) ?? [];
		expect(retryLines.length).toBeGreaterThan(0);
		expect(retryLines.length).toBeLessThanOrEqual(20);
		const newTag = /file tag is now ([0-9a-f]{8})/.exec(refusal)?.[1] ?? "";
		const retryId = /^(\d+#[0-9a-f]{2})\|line 10$/m.exec(refusal)?.[1] ?? "";
		expect(retryId).not.toBe("");
		await edit(path, newTag, [{ op: "replace", start: retryId, text: "TEN" }]);
		expect(readFileSync(path, "utf8")).toBe(`header\n${original.replace("line 10\n", "TEN\n")}`);
	});

	it("a stale refusal does not make IDs outside its retry lines valid", async () => {
		const path = join(dir, "f.txt");
		const original = `${Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n")}\n`;
		writeFileSync(path, original);
		const shown = await read(path);
		writeFileSync(path, `header\n${original}`);
		const refusal = await edit(path, tagOf(shown), [{ op: "replace", start: idOf(shown, 10), text: "TEN" }]).then(
			() => "",
			(error: Error) => error.message,
		);
		const newTag = /file tag is now ([0-9a-f]{8})/.exec(refusal)?.[1] ?? "";
		const outside = `30#${lineHash(newTag, 30, "line 29")}`;
		await expect(edit(path, newTag, [{ op: "replace", start: outside, text: "X" }])).rejects.toThrow(
			/was not shown to you under the current file tag/,
		);
	});

	it("names the owner line when a hash copied from a neighbor line is sent with a number", async () => {
		const path = join(dir, "f.txt");
		writeFileSync(path, "alpha\nbeta\ngamma\n");
		const shown = await read(path);
		const neighborHash = idOf(shown, 1).split("#")[1];
		await expect(
			edit(path, tagOf(shown), [{ op: "replace", start: `2#${neighborHash}`, text: "X" }]),
		).rejects.toThrow(`Hash ${neighborHash} is the ID of line 1 (1#${neighborHash}), not line 2.`);
		expect(readFileSync(path, "utf8")).toBe("alpha\nbeta\ngamma\n");
	});

	it("refuses an empty tag without writing or returning file lines", async () => {
		const path = join(dir, "f.txt");
		writeFileSync(path, "alpha\nbeta\n");
		await read(path);
		const error = await edit(path, "", []).then(
			() => "",
			(e: Error) => e.message,
		);
		expect(error).toMatch(/no file tag was sent/);
		expect(error).not.toContain("Retry with these lines");
		expect(readFileSync(path, "utf8")).toBe("alpha\nbeta\n");
	});

	it("refuses an ID taken from an older read even when its hash coincides with the new tag", async () => {
		// Old read shows blank lines 2..4. The edit result under the new tag shows only lines 1..4, so
		// line 10 was never shown under the new tag; a correct-looking hash for it must still be refused.
		const path = join(dir, "f.txt");
		writeFileSync(path, "a\nb\n\n\n\n\n\n\n\n\nz\n");
		const first = await read(path);
		const inserted = await edit(path, tagOf(first), [{ op: "insert_after", start: idOf(first, 1), text: "top" }]);
		const newTag = /New file tag: ([0-9a-f]{8})\./.exec(textOf(inserted.content))?.[1] ?? "";
		const newLines = readFileSync(path, "utf8").split("\n");
		expect(newTag).toBe(fileTag(readFileSync(path)));
		const coincidentId = `10#${lineHash(newTag, 10, newLines[9])}`;
		await expect(edit(path, newTag, [{ op: "replace", start: coincidentId, text: "X" }])).rejects.toThrow(
			/was not shown to you under the current file tag/,
		);
		expect(readFileSync(path, "utf8")).toBe("a\ntop\nb\n\n\n\n\n\n\n\n\nz\n");
	});

	it("accepts an ID for a line shown in the result of the previous edit", async () => {
		const path = join(dir, "f.txt");
		writeFileSync(path, "a\nb\nc\n");
		const first = await read(path);
		const inserted = await edit(path, tagOf(first), [{ op: "insert_after", start: "0", text: "top" }]);
		const newTag = /New file tag: ([0-9a-f]{8})\./.exec(textOf(inserted.content))?.[1] ?? "";
		const newLines = readFileSync(path, "utf8").split("\n");
		await edit(path, newTag, [{ op: "replace", start: `2#${lineHash(newTag, 2, newLines[1])}`, text: "A" }]);
		expect(readFileSync(path, "utf8")).toBe("top\nA\nb\nc\n");
	});

	it("keeps a BOM and CRLF endings on lines it does not change", async () => {
		const path = join(dir, "bom.txt");
		writeFileSync(path, Buffer.from("\uFEFFa\r\nb\r\n", "utf8"));
		const shown = await read(path);
		await edit(path, tagOf(shown), [{ op: "replace", start: idOf(shown, 2), text: "B" }]);
		expect(readFileSync(path)).toEqual(Buffer.from("\uFEFFa\r\nB\r\n", "utf8"));
	});

	it("appends with CRLF to a CRLF file that has no final newline", async () => {
		const path = join(dir, "crlf.txt");
		writeFileSync(path, "a\r\nb\r\nc");
		const shown = await read(path);
		await edit(path, tagOf(shown), [{ op: "insert_after", start: idOf(shown, 3), text: "X" }]);
		expect(readFileSync(path, "utf8")).toBe("a\r\nb\r\nc\r\nX");
	});

	it("fills an empty file with insert_after 0", async () => {
		const path = join(dir, "empty.txt");
		writeFileSync(path, "");
		await edit(path, fileTag(Buffer.alloc(0)), [{ op: "insert_after", start: "0", text: "hello" }]);
		expect(readFileSync(path, "utf8")).toBe("hello\n");
	});

	it("refuses to edit invalid UTF-8 and leaves the bytes alone", async () => {
		const path = join(dir, "latin1.txt");
		const bytes = Buffer.from([0x61, 0xff, 0x0a]);
		writeFileSync(path, bytes);
		await expect(edit(path, fileTag(bytes), [{ op: "insert_after", start: "0", text: "x" }])).rejects.toThrow(
			/not UTF-8 text/,
		);
		expect(readFileSync(path)).toEqual(bytes);
	});

	it("refuses a file above the hashline size limit without reading it into edits", async () => {
		const path = join(dir, "big.txt");
		const bytes = Buffer.alloc(MAX_HASHLINE_BYTES + 1, "a");
		writeFileSync(path, bytes);
		await expect(edit(path, fileTag(bytes), [{ op: "insert_after", start: "0", text: "x" }])).rejects.toThrow(
			/hashline edit handles files up to/,
		);
		expect(readFileSync(path).equals(bytes)).toBe(true);
	});

	it("reads a file above the hashline size limit by streaming it, with no tag and no whole-file load", async () => {
		const path = join(dir, "huge-read.txt");
		writeFileSync(path, `line one\n${"a".repeat(MAX_HASHLINE_BYTES)}`);
		let wholeFileLoads = 0;
		const tool = createReadToolDefinition(dir, {
			hashline: true,
			operations: {
				readFile: async (p) => {
					wholeFileLoads++;
					return readFileSync(p);
				},
				createReadStream: (p, options) => createReadStream(p, options),
				fileSize: async (p) => statSync(p).size,
				access: async () => {},
			},
		});
		const result = await tool.execute("read", { path, limit: 1 }, undefined, undefined, undefined as never);
		const text = textOf(result.content);
		expect(wholeFileLoads).toBe(0);
		expect(text).not.toContain("[file tag");
		expect(text).toContain("line one");
	});

	it("refuses to replace a hard-linked file and leaves the other link unchanged", async () => {
		const path = join(dir, "f.txt");
		const other = join(dir, "other.txt");
		writeFileSync(path, "alpha\n");
		linkSync(path, other);
		const shown = await read(path);
		await expect(edit(path, tagOf(shown), [{ op: "replace", start: idOf(shown, 1), text: "ALPHA" }])).rejects.toThrow(
			/hard links/,
		);
		expect(readFileSync(other, "utf8")).toBe("alpha\n");
	});

	it("keeps setuid and setgid bits of the file it replaces", async () => {
		const path = join(dir, "suid.txt");
		writeFileSync(path, "alpha\n");
		chmodSync(path, 0o4755);
		const shown = await read(path);
		await edit(path, tagOf(shown), [{ op: "replace", start: idOf(shown, 1), text: "ALPHA" }]);
		expect(statSync(path).mode & 0o7777).toBe(0o4755);
	});

	it("writes through a symlink to its target and keeps the link", async () => {
		const target = join(dir, "target.txt");
		const link = join(dir, "link.txt");
		writeFileSync(target, "alpha\n");
		symlinkSync(target, link);
		const shown = await read(link);
		await edit(link, tagOf(shown), [{ op: "replace", start: idOf(shown, 1), text: "ALPHA" }]);
		expect(lstatSync(link).isSymbolicLink()).toBe(true);
		expect(readFileSync(target, "utf8")).toBe("ALPHA\n");
	});

	it("leaves no temp file behind after a successful edit", async () => {
		const path = join(dir, "f.txt");
		writeFileSync(path, "alpha\n");
		const shown = await read(path);
		await edit(path, tagOf(shown), [{ op: "replace", start: idOf(shown, 1), text: "ALPHA" }]);
		expect(readdirSync(dir)).toEqual(["f.txt"]);
	});

	it("does not write when the operation is aborted after the read", async () => {
		const path = join(dir, "f.txt");
		writeFileSync(path, "alpha\n");
		const shown = await read(path);
		const controller = new AbortController();
		let writes = 0;
		const tool = createHashlineEditToolDefinition(dir, {
			operations: {
				readFile: async (p: string) => {
					const buffer = readFileSync(p);
					controller.abort();
					return buffer;
				},
				access: async () => {},
				writeFile: async () => {
					writes++;
				},
			},
		});
		await expect(
			tool.execute(
				"edit",
				{ path, tag: tagOf(shown), edits: [{ op: "replace", start: idOf(shown, 1), text: "X" }] },
				controller.signal,
				undefined,
				undefined as never,
			),
		).rejects.toThrow(/Operation aborted/);
		expect(writes).toBe(0);
		expect(readFileSync(path, "utf8")).toBe("alpha\n");
	});

	it("does not write when the access check rejects the file", async () => {
		const path = join(dir, "f.txt");
		writeFileSync(path, "alpha\n");
		const shown = await read(path);
		await expect(
			edit(path, tagOf(shown), [{ op: "replace", start: idOf(shown, 1), text: "X" }], {
				readFile: async (p: string) => readFileSync(p),
				access: async () => {
					throw Object.assign(new Error("denied"), { code: "EACCES" });
				},
				writeFile: async () => {
					throw new Error("must not be called");
				},
			}),
		).rejects.toThrow(/Error code: EACCES/);
		expect(existsSync(path)).toBe(true);
		expect(readFileSync(path, "utf8")).toBe("alpha\n");
	});
});

describe("replaceFileAtomically", () => {
	it("renames nothing when the file no longer holds the snapshot the edit was computed from", async () => {
		const path = join(dir, "f.txt");
		writeFileSync(path, "changed by another process\n");
		await expect(replaceFileAtomically(path, "edited\n", Buffer.from("original\n"))).rejects.toThrow(
			/changed while the edit was being written/,
		);
		expect(readFileSync(path, "utf8")).toBe("changed by another process\n");
		expect(readdirSync(dir)).toEqual(["f.txt"]);
	});
});
