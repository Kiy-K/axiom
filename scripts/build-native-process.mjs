#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const name = process.platform === "win32" ? "axiom-process.exe" : "axiom-process";
const destination = join(root, "packages/coding-agent/native/process", `${process.platform}-${process.arch}`, name);
const prebuilt = [
	"linux-x64/axiom-process",
	"linux-arm64/axiom-process",
	"darwin-x64/axiom-process",
	"darwin-arm64/axiom-process",
	"win32-x64/axiom-process.exe",
	"win32-arm64/axiom-process.exe",
].every((path) => existsSync(join(root, "packages/coding-agent/native/process", path)));
if (!prebuilt && !(process.env.AXIOM_NATIVE_PROCESS_PREBUILT === "1" && existsSync(destination))) {
	const daemon = join(root, "packages/env/daemon");
	execFileSync("cargo", ["build", "--release", "--locked", "--bin", "axiom-process"], { cwd: daemon, stdio: "inherit" });
	mkdirSync(dirname(destination), { recursive: true });
	copyFileSync(join(daemon, "target/release", name), destination);
}
