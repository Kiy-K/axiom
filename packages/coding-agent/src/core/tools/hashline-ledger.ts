/**
 * Which lines of a file were shown to the model under each file tag. An edit may use a line ID only if
 * the model was shown that line under the tag it sends, so IDs taken from an older read are refused even
 * when their hash happens to match. The ledger is bounded: when it forgets, the edit is refused and the
 * model re-reads, which is the safe direction.
 */

/** Tags remembered per file. Older tags are forgotten first. */
const MAX_TAGS_PER_FILE = 8;
/** Files remembered. The least recently used file is forgotten first. */
const MAX_FILES = 64;
/** Shown ranges kept per tag. Older ranges are forgotten first. */
const MAX_RANGES_PER_TAG = 256;

/** 1-based inclusive line ranges shown under one tag. */
type Ranges = Array<[number, number]>;

const ledger = new Map<string, Map<string, Ranges>>();

/** Record that lines `from`..`to` (1-based, inclusive) of `absolutePath` were shown under `tag`. */
export function recordShown(absolutePath: string, tag: string, from: number, to: number): void {
	if (to < from) return;
	let tags = ledger.get(absolutePath);
	if (tags) {
		// Re-insert to mark the file most recently used.
		ledger.delete(absolutePath);
	} else {
		tags = new Map();
		const oldest = ledger.keys().next();
		if (ledger.size >= MAX_FILES && !oldest.done) ledger.delete(oldest.value);
	}
	ledger.set(absolutePath, tags);

	let ranges = tags.get(tag);
	if (!ranges) {
		const oldestTag = tags.keys().next();
		if (tags.size >= MAX_TAGS_PER_FILE && !oldestTag.done) tags.delete(oldestTag.value);
		ranges = [];
		tags.set(tag, ranges);
	}
	if (ranges.length >= MAX_RANGES_PER_TAG) ranges.shift();
	ranges.push([from, to]);
}

/** Whether line `line` (1-based) of `absolutePath` was shown under `tag`. */
export function wasShown(absolutePath: string, tag: string, line: number): boolean {
	const ranges = ledger.get(absolutePath)?.get(tag);
	return ranges?.some(([from, to]) => line >= from && line <= to) ?? false;
}
