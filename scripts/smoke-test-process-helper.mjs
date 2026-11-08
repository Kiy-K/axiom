#!/usr/bin/env node
// Proves a shipped axiom-process binary can run a command, and that a package root has every helper.
// spawnSync would EOF after start, and the helper kills the child before it can exit.

import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const packagedHelpers = [
	"native/process/linux-x64/axiom-process",
	"native/process/linux-arm64/axiom-process",
	"native/process/darwin-x64/axiom-process",
	"native/process/darwin-arm64/axiom-process",
	"native/process/win32-x64/axiom-process.exe",
	"native/process/win32-arm64/axiom-process.exe",
	"native/process/android-arm64/axiom-process",
	"native/process/android-x64/axiom-process",
];

const MARKER = "axiom-smoke";

function takeFrames(buffer) {
	const frames = [];
	let offset = 0;
	while (offset + 5 <= buffer.length) {
		const length = buffer.readUInt32BE(offset + 1);
		const end = offset + 5 + length;
		if (end > buffer.length) break;
		frames.push({ kind: buffer[offset], bytes: buffer.subarray(offset + 5, end) });
		offset = end;
	}
	return { frames, rest: buffer.subarray(offset) };
}

export function smokeProcessHelper(helper) {
	const stat = statSync(helper);
	if (stat.size === 0) throw new Error(`empty process helper: ${helper}`);
	const windows = process.platform === "win32";
	const env = {};
	if (windows) {
		for (const key of ["PATH", "SystemRoot", "WINDIR"]) {
			if (process.env[key]) env[key] = process.env[key];
		}
	}
	const start = {
		type: "start",
		command: windows ? "cmd.exe" : "/bin/echo",
		args: windows ? ["/d", "/c", `echo ${MARKER}`] : [MARKER],
		env,
		cwd: process.cwd(),
		stdin: false,
	};
	return new Promise((resolve, reject) => {
		const child = spawn(helper, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
		let rest = Buffer.alloc(0);
		let stderr = "";
		let proved = false;
		let settled = false;
		const timer = setTimeout(() => fail(new Error(`${helper} timed out before command output or exit`)), 20000);
		const fail = (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			child.kill();
			reject(error);
		};
		const succeed = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve();
		};
		const closeOrderly = () => {
			if (proved || settled) return;
			proved = true;
			child.stdin.write(`${JSON.stringify({ type: "close" })}\n`);
			child.stdin.end();
		};
		child.stdin.on("error", () => {});
		child.stdout.on("data", (chunk) => {
			const taken = takeFrames(Buffer.concat([rest, chunk]));
			rest = taken.rest;
			for (const frame of taken.frames) {
				if (frame.kind === 0x4f && frame.bytes.includes(MARKER)) closeOrderly();
				if (frame.kind !== 0x4a) continue;
				let message;
				try {
					message = JSON.parse(frame.bytes.toString("utf8"));
				} catch {
					continue;
				}
				if (message.type === "error") fail(new Error(`${helper} did not spawn a command: ${message.message}`));
				else if (message.type === "exit" && message.code === 0) closeOrderly();
				else if (message.type === "exit") fail(new Error(`${helper} exit ${message.code}`));
			}
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString("utf8");
		});
		child.on("error", (error) => fail(error));
		child.on("exit", (code) => {
			if (!proved) fail(new Error(`${helper} did not prove command output or exit: ${stderr}`));
			else if (code !== 0) fail(new Error(`${helper} exited ${code} after close: ${stderr}`));
			else succeed();
		});
		child.stdin.write(`${JSON.stringify(start)}\n`);
	});
}

export async function requirePackagedHelpers(root) {
	const missing = packagedHelpers.filter((path) => {
		try {
			return statSync(join(root, path)).size === 0;
		} catch {
			return true;
		}
	});
	if (missing.length > 0) throw new Error(`missing process helpers:\n${missing.join("\n")}`);
	await smokeProcessHelper(join(root, `native/process/${process.platform}-${process.arch}/${process.platform === "win32" ? "axiom-process.exe" : "axiom-process"}`));
}

async function main() {
	const [flag, target] = process.argv.slice(2);
	if (flag === "--require-all" && target) {
		await requirePackagedHelpers(target);
		return;
	}
	if (!flag || target) throw new Error("Usage: node scripts/smoke-test-process-helper.mjs [--require-all] <path>");
	await smokeProcessHelper(flag);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	});
}
