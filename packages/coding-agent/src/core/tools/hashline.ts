/**
 * Hashline core: line IDs bound to a file tag, and all-or-nothing edit application over lines that keep
 * their own line endings. Pure functions only; the read and edit tools own I/O.
 */

import { createHash } from "node:crypto";
import { sliceHead } from "./truncate.ts";

/** One line of a file. `eol` is "" only for a last line that has no trailing newline. */
export interface HashlineLine {
	text: string;
	eol: "\r\n" | "\n" | "";
}

export interface HashlineEdit {
	/** One of replace, delete, insert_after; checked when the edit is applied. */
	op: string;
	/** Line ID `N#HH`. `insert_after` also accepts `0` for the start of the file. */
	start: string;
	/** Inclusive end line ID for `replace` and `delete`; defaults to `start`. */
	end?: string;
	/** New lines for `replace` and `insert_after`, joined by `\n`. Refused for `delete`. */
	text?: string;
}

/** Files above this size have no hashline read or edit: both hold the whole file in memory. */
export const MAX_HASHLINE_BYTES = 8 * 1024 * 1024;
/** Lines shown back after an edit, so a large change does not flood the result. */
export const MAX_SHOWN_LINES = 40;

const LINE_ID = /^(0|[1-9]\d*)#([0-9a-f]{2})$/;
const READ_PREFIX = /^\d+#[0-9a-f]{2}\|/;
const HASH_ONLY = /^(?:\S*#)?([0-9a-f]{2})$/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
/** Longest line text echoed back in an error, in UTF-16 units. */
const ECHO_LIMIT = 200;
/** Most shown lines named in a hint when an ID is not a line ID. */
const HINT_IDS = 3;

/** First 8 hex chars of SHA-256 over the raw file bytes: the file's identity for staleness checks. */
export function fileTag(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex").slice(0, 8);
}

/**
 * Decode a file as UTF-8 text, keeping any BOM for the caller to split off. Returns undefined for
 * invalid UTF-8 or a NUL byte: hashline never addresses or rewrites those.
 */
export function decodeTextFile(bytes: Uint8Array): string | undefined {
	if (bytes.includes(0)) return undefined;
	try {
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
	} catch {
		return undefined;
	}
}

/**
 * Two hex chars: the first byte of SHA-256 over the UTF-8 bytes of `${tag}\n${number}\n${text}`.
 * Binding the tag makes an ID from another version of the file miss this line by hash, except for a
 * 1 in 256 coincidence; `shown` rejects those deterministically (see `applyHashlineEdits`).
 */
export function lineHash(tag: string, number: number, text: string): string {
	return createHash("sha256").update(`${tag}\n${number}\n${text}`, "utf8").digest("hex").slice(0, 2);
}

/** Split decoded text (BOM already removed) into lines. A CR before LF is part of the ending, not the text. */
export function parseLines(text: string): HashlineLine[] {
	if (text === "") return [];
	const parts = text.split("\n");
	const lines: HashlineLine[] = [];
	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		if (i === parts.length - 1) {
			// The text ended with "\n", so the empty piece after it is not a line.
			if (part !== "") lines.push({ text: part, eol: "" });
		} else if (part.endsWith("\r")) {
			lines.push({ text: part.slice(0, -1), eol: "\r\n" });
		} else {
			lines.push({ text: part, eol: "\n" });
		}
	}
	return lines;
}

/** Concatenate lines back into text, reproducing the original bytes for unchanged lines. */
export function serializeLines(lines: readonly HashlineLine[]): string {
	let out = "";
	for (const line of lines) out += line.text + line.eol;
	return out;
}

/** Render lines `[from, to)` (0-based) as `N#HH|text`, with IDs bound to `tag`. */
export function renderLines(lines: readonly HashlineLine[], tag: string, from: number, to: number): string[] {
	const rendered: string[] = [];
	for (let i = from; i < to; i++) {
		const text = lines[i].text;
		rendered.push(`${i + 1}#${lineHash(tag, i + 1, text)}|${text}`);
	}
	return rendered;
}

/**
 * Resolve a line ID `N#HH` to its 1-based line number. The hash must match the current line under `tag`,
 * and `shown` must confirm the model was shown that line under `tag`: only then is the ID the model
 * holds for this exact line.
 */
function checkedLine(
	id: string,
	tag: string,
	lines: readonly HashlineLine[],
	shown: (line: number) => boolean,
	field: string,
): number {
	const match = LINE_ID.exec(id);
	if (!match) {
		const hash = HASH_ONLY.exec(id)?.[1];
		const holders: string[] = [];
		for (let n = 1; hash !== undefined && n <= lines.length && holders.length < HINT_IDS; n++) {
			if (shown(n) && lineHash(tag, n, lines[n - 1].text) === hash) holders.push(`${n}#${hash}`);
		}
		throw new Error(
			holders.length > 0
				? `${field} "${id}" is not a line ID. Lines shown to you under this tag with hash ${hash} include ${holders.join(", ")}. Send the full ID of the line you mean.`
				: `${field} "${id}" is not a line ID. Send the whole ID shown before | on a read line: line number, #, and two-character hash, for example 7#e4.`,
		);
	}
	const number = Number(match[1]);
	if (number < 1 || number > lines.length) {
		throw new Error(`${field} ${id} is out of range; the file has ${lines.length} lines. Re-read the file.`);
	}
	const line = lines[number - 1];
	const current = lineHash(tag, number, line.text);
	if (current !== match[2]) {
		const echo = sliceHead(line.text, ECHO_LIMIT);
		// A hash that belongs to another shown line is the usual cause: the model kept the number and copied the neighbor's hash.
		let owner = 0;
		for (let n = 1; owner === 0 && n <= lines.length; n++) {
			if (n !== number && shown(n) && lineHash(tag, n, lines[n - 1].text) === match[2]) owner = n;
		}
		const ownerNote =
			owner === 0 ? "" : ` Hash ${match[2]} is the ID of line ${owner} (${owner}#${match[2]}), not line ${number}.`;
		throw new Error(
			`${field} ${id} does not match the current content of line ${number}. Current line: ${number}#${current}|${echo}.${ownerNote} Re-read the file.`,
		);
	}
	if (!shown(number)) {
		throw new Error(
			`${field} ${id} was not shown to you under the current file tag ${tag}. Re-read the lines you edit; IDs from an older read are not valid after a change.`,
		);
	}
	return number;
}

/**
 * Edit text to lines. One trailing "\n" is ignored, a CRLF is reduced to LF, and the lines take the
 * ending of their neighbors. Refuses text that would write something other than what it shows.
 */
function textLines(text: string): string[] {
	if (text === "") {
		throw new Error('text is empty. Use delete to remove lines, or "\\n" for one blank line.');
	}
	if (LONE_SURROGATE.test(text)) {
		throw new Error("text contains a lone UTF-16 surrogate, which cannot be written as UTF-8. Fix the text.");
	}
	// A CR is part of a CRLF only when its LF is present: the final piece of text that has no LF keeps its CR.
	const terminated = text.endsWith("\n");
	const body = terminated ? text.slice(0, -1) : text;
	const pieces = body.split("\n");
	const lines = pieces.map((line, i) => {
		const isLast = i === pieces.length - 1;
		return (!isLast || terminated) && line.endsWith("\r") ? line.slice(0, -1) : line;
	});
	if (lines.some((line) => line.includes("\r"))) {
		throw new Error("text has a carriage return that is not part of a CRLF line ending. Remove it.");
	}
	const nonEmpty = lines.filter((line) => line !== "");
	if (nonEmpty.length > 0 && nonEmpty.every((line) => READ_PREFIX.test(line))) {
		throw new Error("text starts with line-ID prefixes (before |) copied from read. Send only the line text.");
	}
	return lines;
}

/**
 * Line ending for lines placed at `index`: the nearest line at or above `index` that has one, else LF.
 * Walking back matters for a file without a final newline, whose last line has no ending.
 */
function endingAt(lines: readonly HashlineLine[], index: number): "\r\n" | "\n" {
	for (let i = Math.min(index, lines.length - 1); i >= 0; i--) {
		const eol = lines[i].eol;
		if (eol !== "") return eol;
	}
	return "\n";
}

interface PlannedChange {
	/** Half-open range of original lines replaced; an insert has from === to. */
	from: number;
	to: number;
	insert: boolean;
	/** Position among edits, so inserts at the same gap keep the array order. */
	order: number;
	texts: string[];
	ending: "\r\n" | "\n";
}

/**
 * Validate every edit against the lines as read (identified by `tag`), then apply them together.
 * `shown(line)` reports whether the model was shown that 1-based line under `tag`. Throws on the first
 * problem; the input lines are never modified.
 */
export function applyHashlineEdits(
	lines: readonly HashlineLine[],
	tag: string,
	shown: (line: number) => boolean,
	edits: readonly HashlineEdit[],
): HashlineLine[] {
	if (edits.length === 0) throw new Error("edits must contain at least one change.");
	const planned = edits.map((edit, order) => planChange(lines, tag, shown, edit, order));

	const ranges = planned.filter((change) => !change.insert).sort((a, b) => a.from - b.from);
	for (let i = 1; i < ranges.length; i++) {
		if (ranges[i].from < ranges[i - 1].to) {
			throw new Error(
				"Two edits touch the same line or overlap. Merge them into one edit or target disjoint lines.",
			);
		}
	}
	for (const insert of planned.filter((change) => change.insert)) {
		const inside = ranges.find((range) => range.from < insert.from && insert.from < range.to);
		if (inside) {
			throw new Error(
				`An insert lands inside lines ${inside.from + 1}-${inside.to}, which another edit replaces or deletes. Move the insert outside that range or merge the edits.`,
			);
		}
	}

	planned.sort((a, b) => a.from - b.from || (a.insert === b.insert ? a.order - b.order : a.insert ? -1 : 1));
	const out: HashlineLine[] = [];
	let cursor = 0;
	for (const change of planned) {
		for (let i = cursor; i < change.from; i++) out.push({ ...lines[i] });
		for (const text of change.texts) out.push({ text, eol: change.ending });
		cursor = change.to;
	}
	for (let i = cursor; i < lines.length; i++) out.push({ ...lines[i] });

	// A line that was last before an append now sits in the middle and takes the file's ending, not a fixed LF.
	const inherited = endingAt(lines, lines.length - 1);
	for (let i = 0; i < out.length - 1; i++) {
		if (out[i].eol === "") out[i].eol = inherited;
	}
	// A file without a final newline keeps that state; a file with one keeps a final newline.
	const hadFinalNewline = lines.length === 0 || lines[lines.length - 1].eol !== "";
	const last = out[out.length - 1];
	if (last) last.eol = hadFinalNewline ? last.eol || "\n" : "";

	if (serializeLines(out) === serializeLines(lines)) {
		throw new Error("No changes made. The edits produced identical content.");
	}
	return out;
}

function planChange(
	lines: readonly HashlineLine[],
	tag: string,
	shown: (line: number) => boolean,
	edit: HashlineEdit,
	order: number,
): PlannedChange {
	if (edit.op === "insert_after") {
		if (edit.end !== undefined) throw new Error("end is only for replace and delete. insert_after takes one start.");
		const gap = edit.start === "0" ? 0 : checkedLine(edit.start, tag, lines, shown, "start");
		const texts = textLines(requireText(edit));
		return { from: gap, to: gap, insert: true, order, texts, ending: endingAt(lines, Math.max(gap - 1, 0)) };
	}

	if (edit.op !== "replace" && edit.op !== "delete") {
		throw new Error(`Unknown op "${edit.op}". Use replace, delete, or insert_after.`);
	}
	if (edit.op === "delete" && edit.text !== undefined) {
		throw new Error("delete takes no text. Use replace to change lines.");
	}
	const start = checkedLine(edit.start, tag, lines, shown, "start");
	const end = edit.end === undefined ? start : checkedLine(edit.end, tag, lines, shown, "end");
	if (end < start) throw new Error(`end ${edit.end} is before start ${edit.start}.`);
	const texts = edit.op === "replace" ? textLines(requireText(edit)) : [];
	return { from: start - 1, to: end, insert: false, order, texts, ending: endingAt(lines, start - 1) };
}

function requireText(edit: HashlineEdit): string {
	if (edit.text === undefined) throw new Error(`${edit.op} needs text.`);
	return edit.text;
}

/** Half-open index range of `after` that differs from `before`, after common prefix and suffix are removed. */
export function changedRange(
	before: readonly HashlineLine[],
	after: readonly HashlineLine[],
): { from: number; to: number } {
	const same = (a: HashlineLine, b: HashlineLine) => a.text === b.text && a.eol === b.eol;
	let from = 0;
	while (from < before.length && from < after.length && same(before[from], after[from])) from++;
	let suffix = 0;
	while (
		suffix < before.length - from &&
		suffix < after.length - from &&
		same(before[before.length - 1 - suffix], after[after.length - 1 - suffix])
	) {
		suffix++;
	}
	return { from, to: after.length - suffix };
}
