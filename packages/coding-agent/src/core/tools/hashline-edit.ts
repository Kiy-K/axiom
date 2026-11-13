import { randomBytes } from "node:crypto";
import { constants } from "fs";
import { access as fsAccess, open as fsOpen, readFile as fsReadFile, realpath, rename, rm, stat } from "fs/promises";
import { basename, dirname, join } from "path";
import { type Static, Type } from "typebox";
import { splitBom } from "../../utils/text.ts";
import { StringEnum } from "../extensions/pi-ai-extension-view.ts";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import type { EditOperations, EditToolDetails, EditToolOptions } from "./edit.ts";
import { generateDiffString, generateUnifiedPatch } from "./edit-diff.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import {
	applyHashlineEdits,
	changedRange,
	decodeTextFile,
	fileTag,
	MAX_HASHLINE_BYTES,
	MAX_SHOWN_LINES,
	parseLines,
	renderLines,
	serializeLines,
} from "./hashline.ts";
import { recordShown, wasShown } from "./hashline-ledger.ts";
import { resolveReadPathAsync } from "./path-utils.ts";
import { type EditRenderState, editRenderers } from "./renderers/edit.ts";

/** Lines a stale-tag refusal shows, so the retry needs no separate read. Bounded: never more than this. */
const RECOVERY_LINES = 20;

const hashlineEditSchema = Type.Object({
	path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
	tag: Type.String({ description: "File tag from the latest read of this file" }),
	edits: Type.Array(
		Type.Object({
			op: StringEnum(["replace", "delete", "insert_after"], {
				description: "replace changes lines, delete removes them, insert_after adds lines after start",
			}),
			start: Type.String({
				description:
					"Line ID from read: line number, #, hash, for example 7#e4. For insert_after, 0 means the start of the file.",
			}),
			end: Type.Optional(
				Type.String({ description: "Last line ID (inclusive) for replace or delete. Defaults to start." }),
			),
			text: Type.Optional(
				Type.String({
					description: "New lines for replace or insert_after, joined by newlines. No line-ID prefix before |.",
				}),
			),
		}),
		{
			description:
				"Changes to apply together. Every ID refers to the file as last read, not to the result of another edit in this call.",
		},
	),
});

type HashlineEditInput = Static<typeof hashlineEditSchema>;

/**
 * Replace a regular file through a temp file in its directory and a rename. Right before the rename the
 * target must still hold `snapshot`, the bytes the edit was computed from; otherwise nothing is renamed
 * and the temp file is removed. Refuses hard links, since rename would detach them.
 */
export async function replaceFileAtomically(
	absolutePath: string,
	content: string,
	snapshot: Buffer,
	checkIdentity?: () => Promise<void>,
): Promise<void> {
	await checkIdentity?.();
	const target = await realpath(absolutePath);
	if (checkIdentity && target !== absolutePath)
		throw new Error("The automatic edit path changed after authorization.");
	const info = await stat(target);
	if (!info.isFile()) {
		throw new Error(`${target} is not a regular file. Hashline edit will not replace it.`);
	}
	if (info.nlink > 1) {
		throw new Error(`${target} has ${info.nlink} hard links. Replacing it would detach the other links.`);
	}
	const temp = join(dirname(target), `.${basename(target)}.${randomBytes(6).toString("hex")}.tmp`);
	try {
		const handle = await fsOpen(temp, "wx");
		try {
			await handle.writeFile(content, "utf-8");
			// After the write: writing clears setuid and setgid bits, so the mode is restored last.
			await handle.chmod(info.mode & 0o7777);
			await handle.sync();
		} finally {
			await handle.close();
		}
		if (!(await fsReadFile(target)).equals(snapshot)) {
			throw new Error(
				`${absolutePath} changed while the edit was being written. Nothing was written. Re-read the file.`,
			);
		}
		await checkIdentity?.();
		await rename(temp, target);
	} catch (error) {
		await rm(temp, { force: true });
		throw error;
	}
}

/** Refuses a file too large to hold as lines; the replace-mode tool handles it. */
function assertHashlineSize(path: string, size: number): void {
	if (size > MAX_HASHLINE_BYTES) {
		throw new Error(
			`${path} is ${size} bytes; hashline edit handles files up to ${MAX_HASHLINE_BYTES} bytes. Use the replace-mode edit tool for this file.`,
		);
	}
}

/** The line-addressed edit tool used when `editMode` is `hashline`; the same name as the replace-mode tool. */
export function createHashlineEditToolDefinition(
	cwd: string,
	options?: EditToolOptions,
): ToolDefinition<typeof hashlineEditSchema, EditToolDetails | undefined, EditRenderState> {
	const custom: EditOperations | undefined = options?.operations;
	const readFile = custom?.readFile ?? ((path: string) => fsReadFile(path));
	const access = custom?.access ?? ((path: string) => fsAccess(path, constants.R_OK | constants.W_OK));
	return {
		name: "edit",
		label: "edit",
		description:
			"Edit a file by line ID. Pass the file tag and the line IDs (for example 7#e4) from the latest read of the file. All edits apply together or none do. A changed file (stale tag) or an ID whose hash no longer matches is refused with the current lines; re-read and retry.",
		promptSnippet: "Edit files by line ID using the file tag and line IDs (for example 7#e4) from read",
		promptGuidelines: [
			"Make one edit call per file per turn and batch its changes in edits[]. A second call on the same file after a change fails on the stale tag.",
			"After any successful edit, use the new tag and IDs from its result, or re-read before editing lines outside that result.",
		],
		parameters: hashlineEditSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		renderShell: "self",
		async execute(toolCallId, input: HashlineEditInput, signal?: AbortSignal, _onUpdate?, ctx?: ExtensionContext) {
			const absolutePath = await resolveReadPathAsync(input.path, ctx?.cwd || cwd);
			const lease = options?.editLease?.(toolCallId, absolutePath, input);

			return withFileMutationQueue(absolutePath, async () => {
				// Checked after each await rather than from an abort listener, so the queue stays locked
				// until the in-flight filesystem call settles.
				const throwIfAborted = (): void => {
					if (signal?.aborted) throw new Error("Operation aborted");
				};
				throwIfAborted();

				try {
					if (!lease) await access(absolutePath);
				} catch (error: unknown) {
					throwIfAborted();
					const errorMessage =
						error instanceof Error && "code" in error ? `Error code: ${error.code}` : String(error);
					throw new Error(`Could not edit file: ${input.path}. ${errorMessage}.`);
				}
				throwIfAborted();
				// Default path: check the size before reading, so an oversized file is never loaded.
				if (!custom && !lease) assertHashlineSize(input.path, (await stat(absolutePath)).size);

				const original = lease?.original ?? (await readFile(absolutePath));
				throwIfAborted();
				assertHashlineSize(input.path, original.length);
				const currentTag = fileTag(original);
				const decoded = decodeTextFile(original);
				if (input.tag === "") {
					throw new Error(
						`${input.path}: no file tag was sent. Read the file first to get its tag and line IDs. Nothing was written.`,
					);
				}
				if (input.tag !== currentTag) {
					const head = `${input.path} changed since it was read (file tag is now ${currentTag}, you sent ${input.tag}), possibly by an earlier call in this turn. Nothing was written.`;
					const recovery =
						decoded === undefined ? undefined : recoveryLines(decoded, currentTag, input.edits[0]?.start);
					if (recovery === undefined)
						throw new Error(`${head} Re-read the file and edit with the new tag and IDs.`);
					// Only these lines are shown under the new tag, so only their IDs pass the shown check on retry.
					recordShown(absolutePath, currentTag, recovery.from + 1, recovery.to);
					throw new Error([`${head} Retry with these lines and their IDs:`, ...recovery.rendered].join("\n"));
				}
				if (decoded === undefined) {
					throw new Error(
						`${input.path} is not UTF-8 text (invalid UTF-8 or NUL bytes). Hashline edit only changes text files; use write or bash.`,
					);
				}

				const { bom, text } = splitBom(decoded);
				const oldLines = parseLines(text);
				const shown = (line: number) => wasShown(absolutePath, currentTag, line);
				const newLines = applyHashlineEdits(oldLines, currentTag, shown, input.edits);
				const newText = serializeLines(newLines);
				throwIfAborted();
				if (custom) {
					await custom.writeFile(absolutePath, bom + newText);
				} else {
					await replaceFileAtomically(absolutePath, bom + newText, original, lease && (() => lease.assertPath()));
				}

				// Past the write the edit has happened, so an abort no longer reports as a failure.
				const newTag = fileTag(Buffer.from(bom + newText, "utf-8"));
				const range = changedRange(oldLines, newLines);
				const shownFrom = Math.max(0, range.from - 2);
				const shownTo = Math.min(newLines.length, range.to + 2, range.from + 2 + MAX_SHOWN_LINES);
				const shownLines = renderLines(newLines, newTag, shownFrom, shownTo);
				// Only these lines were shown under the new tag; the rest of the file needs a re-read.
				recordShown(absolutePath, newTag, shownFrom + 1, shownTo);
				const summary = [`Successfully edited ${input.path}. New file tag: ${newTag}.`, ...shownLines];
				if (shownTo < range.to + 2 && shownTo < newLines.length) {
					summary.push(`... ${newLines.length - shownTo} more lines. Re-read the file to see their IDs.`);
				}
				const diffResult = generateDiffString(text, newText);
				const patch = generateUnifiedPatch(input.path, text, newText);
				return {
					content: [{ type: "text", text: summary.join("\n") }],
					details: { diff: diffResult.diff, patch, firstChangedLine: diffResult.firstChangedLine },
				};
			});
		},
		...editRenderers,
	};
}

/**
 * The lines a stale-tag refusal shows: RECOVERY_LINES lines starting two above the refused call's first target
 * line, clipped to the file, rendered under the current tag. `from` is zero-based; `to` is exclusive.
 */
function recoveryLines(
	decoded: string,
	tag: string,
	startId: string | undefined,
): { from: number; to: number; rendered: string[] } {
	const lines = parseLines(splitBom(decoded).text);
	const target = Number(/^(\d+)#/.exec(startId ?? "")?.[1] ?? 1);
	const from = Math.max(0, Math.min(target - 3, lines.length - RECOVERY_LINES));
	const to = Math.min(lines.length, from + RECOVERY_LINES);
	return { from, to, rendered: renderLines(lines, tag, from, to) };
}
