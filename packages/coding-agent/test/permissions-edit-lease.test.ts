import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionToolContext } from "../src/core/extensions/types.ts";
import { openEditLease } from "../src/core/permissions/edit-lease.ts";
import { PermissionGateway } from "../src/core/permissions/gateway.ts";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";
import { fileTag, lineHash } from "../src/core/tools/hashline.ts";
import { createHashlineEditToolDefinition } from "../src/core/tools/hashline-edit.ts";
import { recordShown } from "../src/core/tools/hashline-ledger.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform !== "linux")("automatic edit lease", () => {
	it("writes the opened file rather than a replacement at its old path", async () => {
		const root = mkdtempSync(join(tmpdir(), "edit-lease-"));
		roots.push(root);
		const path = join(root, "file.txt");
		writeFileSync(path, "old");
		const lease = await openEditLease(root, path);
		expect(lease).toBeDefined();
		renameSync(path, join(root, "moved.txt"));
		writeFileSync(path, "replacement");
		await lease?.write(Buffer.from("new"));
		await lease?.close();
		expect(readFileSync(path, "utf8")).toBe("replacement");
		expect(readFileSync(join(root, "moved.txt"), "utf8")).toBe("new");
	});

	it("refuses replace edits if the authorized path is replaced", async () => {
		const root = mkdtempSync(join(tmpdir(), "edit-lease-"));
		roots.push(root);
		const path = join(root, "file.txt");
		writeFileSync(path, "old");
		const gateway = new PermissionGateway({
			getMode: () => "auto",
			getCwd: () => root,
			getSessionId: () => "session",
			getPrompter: () => ({ select: async () => "Trust edits for this session" }),
			canRequestEditTrust: () => true,
			checkpointRoot: join(root, "copies"),
		});
		gateway.beginTask();
		const input = { path: "file.txt", edits: [{ oldText: "old", newText: "new" }] };
		expect(
			await gateway.authorize({ toolName: "edit", toolCallId: "edit", builtinEdit: "replace", input }),
		).toBeUndefined();
		const tool = createEditToolDefinition(root, {
			editLease: (id, target, args) => gateway.editLease(id, target, args),
		});
		renameSync(path, join(root, "moved.txt"));
		writeFileSync(path, "replacement");
		await expect(tool.execute("edit", input, undefined, undefined, {} as ExtensionToolContext)).rejects.toThrow(
			/path changed/,
		);
		gateway.finishToolCall("edit", input);
		expect(readFileSync(path, "utf8")).toBe("replacement");
		expect(readFileSync(join(root, "moved.txt"), "utf8")).toBe("old");
	});

	it("refuses hashline replacement if the authorized path is replaced", async () => {
		const root = mkdtempSync(join(tmpdir(), "edit-lease-"));
		roots.push(root);
		const path = join(root, "file.txt");
		writeFileSync(path, "old\n");
		const gateway = new PermissionGateway({
			getMode: () => "auto",
			getCwd: () => root,
			getSessionId: () => "session",
			getPrompter: () => ({ select: async () => "Trust edits for this session" }),
			canRequestEditTrust: () => true,
			checkpointRoot: join(root, "copies"),
		});
		gateway.beginTask();
		const tag = fileTag(Buffer.from("old\n"));
		const input = {
			path: "file.txt",
			tag,
			edits: [{ op: "replace" as const, start: `1#${lineHash(tag, 1, "old")}`, text: "new" }],
		};
		recordShown(path, tag, 1, 1);
		expect(
			await gateway.authorize({ toolName: "edit", toolCallId: "edit", builtinEdit: "hashline", input }),
		).toBeUndefined();
		const tool = createHashlineEditToolDefinition(root, {
			editLease: (id, target, args) => gateway.editLease(id, target, args),
		});
		renameSync(path, join(root, "moved.txt"));
		writeFileSync(path, "old\n");
		await expect(tool.execute("edit", input, undefined, undefined, {} as ExtensionToolContext)).rejects.toThrow(
			/path changed/,
		);
		gateway.finishToolCall("edit", input);
		expect(readFileSync(path, "utf8")).toBe("old\n");
	});

	it("refuses changed contents and executable permissions", async () => {
		const root = mkdtempSync(join(tmpdir(), "edit-lease-"));
		roots.push(root);
		const path = join(root, "file.txt");
		writeFileSync(path, "old");
		const first = await openEditLease(root, path);
		writeFileSync(path, "other");
		await expect(first?.write(Buffer.from("new"))).rejects.toThrow(/changed after authorization/);
		await first?.close();
		const second = await openEditLease(root, path);
		chmodSync(path, 0o755);
		await expect(second?.write(Buffer.from("new"))).rejects.toThrow(/changed after authorization/);
		await second?.close();
		expect(readFileSync(path, "utf8")).toBe("other");
	});

	it("refuses symlinks in the path", async () => {
		const root = mkdtempSync(join(tmpdir(), "edit-lease-"));
		roots.push(root);
		mkdirSync(join(root, "real"));
		writeFileSync(join(root, "real", "file.txt"), "old");
		symlinkSync("real", join(root, "link"));
		await expect(openEditLease(root, join(root, "link", "file.txt"))).rejects.toThrow();
	});
});
