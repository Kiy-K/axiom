/**
 * Bounded byte ring for one job's output, addressed by absolute byte offsets.
 * The cursor is the absolute offset of the next byte the reader has not seen.
 */

import { sanitizeBinaryOutput } from "../../utils/shell.ts";

/** Retained output per job. Older bytes are dropped and reported as truncated. */
export const LOG_RETAINED_BYTES = 512 * 1024;
export const LOG_PAGE_MAX_BYTES = 64 * 1024;

export interface OutputPage {
	/** Sanitized text of this page. May start with a truncation notice. */
	text: string;
	/** Offset to pass back to read the bytes after this page. */
	cursor: string;
	/** Bytes between the requested cursor and the oldest retained byte. 0 when nothing was lost. */
	droppedBytes: number;
}

/** Append-only byte log with a fixed retention window. */
export class LogBuffer {
	/**
	 * Allocated on the first append. Not zero-filled: bytes are read only below `written`, so unwritten
	 * memory is never observed, and foreground commands with output avoid a 512 KiB zero-fill.
	 */
	private ring: Buffer | undefined;
	/** Total bytes ever appended. The retained window is [written - LOG_RETAINED_BYTES, written). */
	private written = 0;

	append(chunk: Buffer): void {
		if (this.ring === undefined) this.ring = Buffer.allocUnsafe(LOG_RETAINED_BYTES);
		// Only the last window of a large chunk can survive. Its first byte has absolute offset
		// written + chunk.length - data.length, and that offset decides where it goes in the ring.
		const data = chunk.length > LOG_RETAINED_BYTES ? chunk.subarray(chunk.length - LOG_RETAINED_BYTES) : chunk;
		const absoluteStart = this.written + chunk.length - data.length;
		const start = absoluteStart % LOG_RETAINED_BYTES;
		const firstPart = Math.min(data.length, LOG_RETAINED_BYTES - start);
		data.copy(this.ring, start, 0, firstPart);
		if (firstPart < data.length) data.copy(this.ring, 0, firstPart);
		this.written += chunk.length;
	}

	/** The last `maxBytes` retained bytes; retained bytes before them are counted in `omittedBytes`. */
	tail(maxBytes: number): OutputPage & { omittedBytes: number } {
		const oldest = Math.max(0, this.written - LOG_RETAINED_BYTES);
		const start = Math.max(oldest, this.written - maxBytes);
		return { ...this.read(String(start), maxBytes), omittedBytes: start - oldest };
	}

	/**
	 * Read up to `maxBytes` from `cursor` (decimal absolute offset, undefined = oldest retained byte).
	 * Throws for a cursor that is not a non-negative integer.
	 */
	read(cursor: string | undefined, maxBytes: number, flush = false): OutputPage {
		const oldest = Math.max(0, this.written - LOG_RETAINED_BYTES);
		if (cursor !== undefined && !/^\d+$/.test(cursor)) {
			throw new Error(`Invalid cursor: ${cursor}. Use the cursor from the previous output result.`);
		}
		const requested = cursor === undefined ? oldest : Number(cursor);
		if (!Number.isSafeInteger(requested)) {
			throw new Error(`Invalid cursor: ${cursor}. Use the cursor from the previous output result.`);
		}
		const from = Math.max(oldest, Math.min(requested, this.written));
		const droppedBytes = Math.max(0, oldest - requested);
		// Floor of 4: a UTF-8 sequence is at most 4 bytes, so every page advances the cursor.
		const limit = Math.min(Math.max(4, Math.floor(maxBytes)), LOG_PAGE_MAX_BYTES);
		const to = Math.min(this.written, from + limit);
		let bytes = this.slice(from, to);
		let skipped = 0;
		// A page starting inside a UTF-8 sequence drops its continuation bytes; the sequence's lead byte is on the earlier page.
		while (skipped < bytes.length && (bytes[skipped] & 0xc0) === 0x80) skipped++;
		bytes = bytes.subarray(skipped);
		let end = to;
		// Keep a sequence cut by the page size for the next page, so no character is split. Only the final page
		// of finished output may end in an incomplete sequence: nothing more will arrive to complete it.
		const finalPage = flush && to === this.written;
		const trimmed = finalPage ? bytes : trimIncompleteUtf8Tail(bytes);
		end -= bytes.length - trimmed.length;
		bytes = trimmed;
		const notice = droppedBytes > 0 ? `[${droppedBytes} bytes truncated]\n` : "";
		return {
			text: notice + sanitizeBinaryOutput(bytes.toString("utf8")),
			cursor: String(end),
			droppedBytes,
		};
	}

	private slice(from: number, to: number): Buffer {
		const ring = this.ring;
		if (ring === undefined) return Buffer.alloc(0);
		const out = Buffer.alloc(to - from);
		for (let pos = from; pos < to; ) {
			const ringPos = pos % LOG_RETAINED_BYTES;
			const n = Math.min(to - pos, LOG_RETAINED_BYTES - ringPos);
			ring.copy(out, pos - from, ringPos, ringPos + n);
			pos += n;
		}
		return out;
	}
}

/** Drop a trailing UTF-8 sequence that is cut short, so it is read whole by the next page. */
function trimIncompleteUtf8Tail(bytes: Buffer): Buffer {
	for (let back = 1; back <= Math.min(3, bytes.length); back++) {
		const byte = bytes[bytes.length - back];
		if ((byte & 0xc0) === 0x80) continue;
		const need = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
		return need > back ? bytes.subarray(0, bytes.length - back) : bytes;
	}
	return bytes;
}
