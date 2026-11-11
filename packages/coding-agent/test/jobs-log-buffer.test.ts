import { describe, expect, it } from "vitest";
import { LOG_RETAINED_BYTES, LogBuffer } from "../src/core/jobs/log-buffer.ts";

describe("LogBuffer", () => {
	it("reads from a cursor and returns the next cursor", () => {
		const log = new LogBuffer();
		log.append(Buffer.from("hello "));
		log.append(Buffer.from("world"));
		const first = log.read(undefined, 6);
		expect(first.text).toBe("hello ");
		expect(first.droppedBytes).toBe(0);
		const second = log.read(first.cursor, 100);
		expect(second.text).toBe("world");
		expect(log.read(second.cursor, 100).text).toBe("");
	});

	it("removes DEL and C1 controls, including 8-bit CSI, and keeps neighbouring characters whole", () => {
		const log = new LogBuffer();
		// U+009B is the 8-bit CSI; U+0085 and U+009F are other C1 controls. "é" (U+00E9) and "€" sit just outside the range.
		log.append(Buffer.from("a\u009b2Jb\x7fc\u0085d\u009fé€\n"));
		expect(log.read(undefined, 100).text).toBe("a2Jbcdé€\n");
	});

	it("reports bytes lost to the retention window for a stale cursor", () => {
		const log = new LogBuffer();
		log.append(Buffer.alloc(LOG_RETAINED_BYTES, "a"));
		log.append(Buffer.from("tail"));
		const page = log.read("0", 64 * 1024);
		expect(page.droppedBytes).toBe(4);
		expect(page.text.startsWith("[4 bytes truncated]\n")).toBe(true);
		expect(page.text).toBe(`[4 bytes truncated]\n${"a".repeat(64 * 1024)}`);
	});

	it("never splits a multi-byte character across pages", () => {
		const log = new LogBuffer();
		log.append(Buffer.from("aé€😀"));
		const seen: string[] = [];
		let cursor: string | undefined;
		for (let i = 0; i < 20; i++) {
			const page = log.read(cursor, 4);
			seen.push(page.text);
			if (page.cursor === cursor) break;
			cursor = page.cursor;
		}
		expect(seen.join("")).toBe("aé€😀");
		expect(seen.every((text) => !text.includes("\uFFFD"))).toBe(true);
	});

	it("tail keeps the latest bytes and counts the omitted earlier ones", () => {
		const log = new LogBuffer();
		log.append(Buffer.from("0123456789"));
		const tail = log.tail(4);
		expect(tail.text).toBe("6789");
		expect(tail.omittedBytes).toBe(6);
		expect(tail.cursor).toBe("10");
	});

	it("keeps a chunk larger than the window in order after it wraps", () => {
		const log = new LogBuffer();
		log.append(Buffer.from("head-"));
		const body = Buffer.alloc(LOG_RETAINED_BYTES + 100_000);
		for (let i = 0; i < body.length; i++) body[i] = 97 + (i % 26);
		log.append(body);
		const tail = log.tail(256);
		expect(tail.text).toBe(body.subarray(body.length - 256).toString("utf8"));
		expect(tail.omittedBytes).toBeGreaterThan(0);
	});

	it("rejects a cursor that is not a non-negative integer", () => {
		const log = new LogBuffer();
		log.append(Buffer.from("abc"));
		expect(() => log.read("not-a-number", 10)).toThrow("Invalid cursor");
		expect(() => log.read("", 10)).toThrow("Invalid cursor");
		expect(() => log.read("1.5", 10)).toThrow("Invalid cursor");
	});

	it("holds an incomplete trailing character until the output is final", () => {
		const log = new LogBuffer();
		log.append(Buffer.from([0x61, 0xc3]));
		const running = log.read(undefined, 16, false);
		expect(running.text).toBe("a");
		expect(running.cursor).toBe("1");
		const final = log.read(running.cursor, 16, true);
		expect(final.text).toBe("\uFFFD");
		expect(final.cursor).toBe("2");
	});

	it("splits no character across pages of finished output", () => {
		const log = new LogBuffer();
		log.append(Buffer.from("€€€"));
		let text = "";
		let cursor: string | undefined;
		for (let i = 0; i < 20; i++) {
			const page = log.read(cursor, 4, true);
			text += page.text;
			if (page.cursor === cursor) break;
			cursor = page.cursor;
		}
		expect(text).toBe("€€€");
	});
});
