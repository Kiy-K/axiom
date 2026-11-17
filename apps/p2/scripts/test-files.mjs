// Runs each test file in its own node process under a time limit, so a hung file is named and the rest still run.
// Usage: node scripts/test-files.mjs [file...]   (default: test/*/*.test.ts, as `bun run test` globbed before)
// P2_TEST_FILE_TIMEOUT_MS overrides the per-file limit (default 20 minutes: some tests set 11 to 15 minute timeouts).
import { spawn } from "node:child_process";
import { globSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fileTimeoutMs = Number(process.env.P2_TEST_FILE_TIMEOUT_MS ?? 20 * 60_000);
const files = process.argv.length > 2 ? process.argv.slice(2) : globSync("test/*/*.test.ts").sort();
const failures = [];
const reportDir = mkdtempSync(join(tmpdir(), "p2-test-"));

for (const file of files) {
	console.log(`\n=== ${file}`);
	const started = Date.now();
	const report = join(reportDir, `${file.replaceAll("/", "_")}.tap`);
	const outcome = await runFile(file, report);
	const seconds = Math.round((Date.now() - started) / 1000);
	console.log(`=== ${file}: ${outcome} in ${seconds}s`);
	if (outcome !== "passed") {
		failures.push(`${file} (${outcome})`);
		printFailures(report);
	}
}

if (failures.length > 0) {
	console.error(
		`\n${failures.length} of ${files.length} test files failed:\n${failures.map((f) => `  ${f}`).join("\n")}`,
	);
	process.exit(1);
}
console.log(`\nAll ${files.length} test files passed.`);

/** Runs one file; a file still running at the limit is killed with everything it spawned (browsers, daemons). */
function runFile(file, report) {
	return new Promise((resolve) => {
		const child = spawn(
			process.execPath,
			[
				"--import",
				"./src/source.ts",
				"--test",
				"--test-concurrency=1",
				"--test-timeout=120000",
				// The spec reporter prints failure details only at the end, which a killed file never reaches; TAP is written as tests finish.
				"--test-reporter=spec",
				"--test-reporter-destination=stdout",
				"--test-reporter=tap",
				`--test-reporter-destination=${report}`,
				file,
			],
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

/** Prints the failed tests of a file from its TAP report, with their error details. */
function printFailures(report) {
	let lines;
	try {
		lines = readFileSync(report, "utf8").split("\n");
	} catch {
		return; // The file died before its reporter wrote anything.
	}
	let inFailure = false;
	for (const line of lines) {
		if (/^\s*not ok /.test(line)) inFailure = true;
		else if (/^\s*(ok |# |1\.\.)/.test(line)) inFailure = false;
		if (inFailure) console.log(line);
	}
}
