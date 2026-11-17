// Runs each test file in its own node process under a time limit, so a hung file is named and the rest still run.
// Usage: node scripts/test-files.mjs [file...]   (default: test/*/*.test.ts, as `bun run test` globbed before)
// P2_TEST_FILE_TIMEOUT_MS overrides the per-file limit (default 20 minutes: some tests set 11 to 15 minute timeouts).
import { spawn } from "node:child_process";
import { globSync } from "node:fs";

const fileTimeoutMs = Number(process.env.P2_TEST_FILE_TIMEOUT_MS ?? 20 * 60_000);
const files = process.argv.length > 2 ? process.argv.slice(2) : globSync("test/*/*.test.ts").sort();
const failures = [];

for (const file of files) {
	console.log(`\n=== ${file}`);
	const started = Date.now();
	const outcome = await runFile(file);
	const seconds = Math.round((Date.now() - started) / 1000);
	console.log(`=== ${file}: ${outcome} in ${seconds}s`);
	if (outcome !== "passed") failures.push(`${file} (${outcome})`);
}

if (failures.length > 0) {
	console.error(
		`\n${failures.length} of ${files.length} test files failed:\n${failures.map((f) => `  ${f}`).join("\n")}`,
	);
	process.exit(1);
}
console.log(`\nAll ${files.length} test files passed.`);

/** Runs one file; a file still running at the limit is killed with everything it spawned (browsers, daemons). */
function runFile(file) {
	return new Promise((resolve) => {
		const child = spawn(
			process.execPath,
			["--import", "./src/source.ts", "--test", "--test-concurrency=1", "--test-timeout=120000", file],
			{ stdio: "inherit", detached: true },
		);
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			console.error(`\n=== ${file}: still running after ${fileTimeoutMs / 1000}s, killing it`);
			killGroup(child.pid, "SIGKILL");
		}, fileTimeoutMs);
		child.on("close", (code) => {
			clearTimeout(timer);
			// Leftovers of a finished file (a stray browser) must not leak into the next one.
			killGroup(child.pid, "SIGKILL");
			resolve(
				timedOut ? `timed out after ${fileTimeoutMs / 1000}s` : code === 0 ? "passed" : `failed, exit ${code}`,
			);
		});
	});
}

function killGroup(pid, signal) {
	try {
		process.kill(-pid, signal);
	} catch {
		// The group is already gone.
	}
}
