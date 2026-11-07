// Statistics and the summary report for the P2 live-model gate (docs/axiom/hashline-gate.md): rates with Wilson
// intervals, paired differences with bootstrap intervals, and a per-task breakdown. Also the seeded shuffle
// that the runner uses to order trials.

import { readFileSync, writeFileSync } from "node:fs";

const Z = 1.96;
const MODES = ["replace", "hashline"];

export function mulberry32(seed) {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function shuffle(items, random) {
	for (let i = items.length - 1; i > 0; i--) {
		const j = Math.floor(random() * (i + 1));
		[items[i], items[j]] = [items[j], items[i]];
	}
	return items;
}

// Wilson score interval for k successes out of n.
export function wilson(k, n) {
	if (n === 0) return [Number.NaN, Number.NaN];
	const p = k / n;
	const z2 = Z * Z;
	const denom = 1 + z2 / n;
	const center = (p + z2 / (2 * n)) / denom;
	const half = (Z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
	return [Math.max(0, center - half), Math.min(1, center + half)];
}

export function median(xs) {
	if (xs.length === 0) return Number.NaN;
	const s = [...xs].sort((a, b) => a - b);
	const m = Math.floor(s.length / 2);
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// 95% percentile bootstrap interval of the median of paired differences.
export function bootstrapMedianCI(diffs, seed = 7, resamples = 5000) {
	if (diffs.length === 0) return [Number.NaN, Number.NaN];
	const random = mulberry32(seed);
	const medians = [];
	for (let b = 0; b < resamples; b++) {
		const sample = diffs.map(() => diffs[Math.floor(random() * diffs.length)]);
		medians.push(median(sample));
	}
	medians.sort((a, b) => a - b);
	return [medians[Math.floor(0.025 * resamples)], medians[Math.floor(0.975 * resamples)]];
}

const pct = (x) => (Number.isFinite(x) ? `${(100 * x).toFixed(1)}%` : "n/a");
const num = (x, digits = 0) => (Number.isFinite(x) ? x.toFixed(digits) : "n/a");

function modeStats(records) {
	const n = records.length;
	const pass = records.filter((r) => r.pass).length;
	const wrong = records.filter((r) => r.violations.length > 0).length;
	const editCalls = records.reduce((s, r) => s + r.editCalls, 0);
	const editErrors = records.reduce((s, r) => s + r.editErrors, 0);
	const tokens = records.map((r) => r.tokens);
	return {
		n,
		pass,
		passCI: wilson(pass, n),
		wrong,
		wrongCI: wilson(wrong, n),
		editCalls,
		editErrors,
		editSuccess: wilson(editCalls - editErrors, editCalls),
		retriesPerRun: n ? editErrors / n : Number.NaN,
		tokensMedian: median(tokens),
		tokensMean: n ? tokens.reduce((s, x) => s + x, 0) / n : Number.NaN,
		wallMedianMs: median(records.map((r) => r.wallMs)),
		costTotal: records.reduce((s, r) => s + r.cost, 0),
		timeouts: records.filter((r) => r.timedOut).length,
		staleInjected: records.filter((r) => r.stale.injected).length,
		staleEditAfter: records.filter((r) => r.stale.editAfterInjection).length,
		models: [...new Set(records.map((r) => r.model ?? "unknown"))],
	};
}

function pairsOf(records) {
	const byKey = new Map();
	for (const r of records) {
		const key = `${r.task}|${r.repeat}`;
		const entry = byKey.get(key) ?? {};
		entry[r.mode] = r;
		byKey.set(key, entry);
	}
	return [...byKey.values()].filter((e) => e.replace && e.hashline);
}

function pairedStats(pairs) {
	const diff = (fn) => pairs.map((p) => fn(p.hashline) - fn(p.replace));
	const tokens = diff((r) => r.tokens);
	const wall = diff((r) => r.wallMs);
	const errors = diff((r) => r.editErrors);
	const discord = (fn) => ({
		hashlineOnly: pairs.filter((p) => fn(p.hashline) && !fn(p.replace)).length,
		replaceOnly: pairs.filter((p) => !fn(p.hashline) && fn(p.replace)).length,
	});
	return {
		pairs: pairs.length,
		pass: discord((r) => r.pass),
		wrong: discord((r) => r.violations.length > 0),
		tokensMedianDiff: median(tokens),
		tokensMedianDiffCI: bootstrapMedianCI(tokens),
		wallMedianDiffMs: median(wall),
		wallMedianDiffCI: bootstrapMedianCI(wall),
		editErrorsDiffSum: errors.reduce((s, x) => s + x, 0),
	};
}

function perTask(records) {
	const ids = [...new Set(records.map((r) => r.task))];
	return ids.map((task) => {
		const row = { task, category: records.find((r) => r.task === task).category };
		for (const mode of MODES) {
			const rs = records.filter((r) => r.task === task && r.mode === mode);
			row[mode] = {
				n: rs.length,
				pass: rs.filter((r) => r.pass).length,
				wrong: rs.filter((r) => r.violations.length > 0).length,
				editErrors: rs.reduce((s, r) => s + r.editErrors, 0),
				tokensMedian: median(rs.map((r) => r.tokens)),
			};
		}
		return row;
	});
}

export function summarize(file) {
	const records = readFileSync(file, "utf8")
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line));
	const modes = Object.fromEntries(MODES.map((mode) => [mode, modeStats(records.filter((r) => r.mode === mode))]));
	const paired = pairedStats(pairsOf(records));
	const tasks = perTask(records);
	const failures = records.filter((r) => !r.pass || r.violations.length > 0).map((r) => r.runId);

	const out = [];
	out.push(`| metric | ${MODES.join(" | ")} |`, "|---|---|---|");
	const row = (label, fn) => out.push(`| ${label} | ${MODES.map((m) => fn(modes[m])).join(" | ")} |`);
	row("runs", (s) => `${s.n}`);
	row("task pass (tests)", (s) => `${s.pass}/${s.n} = ${pct(s.n ? s.pass / s.n : NaN)} [${pct(s.passCI[0])}, ${pct(s.passCI[1])}]`);
	row("wrong writes (guard)", (s) => `${s.wrong}/${s.n} [${pct(s.wrongCI[0])}, ${pct(s.wrongCI[1])}]`);
	row("edit calls", (s) => `${s.editCalls}`);
	row("edit errors (retries)", (s) => `${s.editErrors} (${num(s.retriesPerRun, 2)} per run)`);
	row("exact edit success", (s) => `${pct(s.editCalls ? (s.editCalls - s.editErrors) / s.editCalls : NaN)} [${pct(s.editSuccess[0])}, ${pct(s.editSuccess[1])}]`);
	row("tokens median (mean)", (s) => `${num(s.tokensMedian)} (${num(s.tokensMean)})`);
	row("wall median ms", (s) => num(s.wallMedianMs));
	row("cost estimate $", (s) => s.costTotal.toFixed(4));
	row("timeouts", (s) => `${s.timeouts}`);
	row("stale injected / edit after", (s) => `${s.staleInjected} / ${s.staleEditAfter}`);
	row("models", (s) => s.models.join(", "));

	out.push("", `Paired (${paired.pairs} task-repeat pairs), hashline minus replace:`);
	out.push(`- task pass discordance: hashline-only ${paired.pass.hashlineOnly}, replace-only ${paired.pass.replaceOnly}`);
	out.push(`- wrong-write discordance: hashline-only ${paired.wrong.hashlineOnly}, replace-only ${paired.wrong.replaceOnly}`);
	out.push(`- tokens median diff ${num(paired.tokensMedianDiff)} [${num(paired.tokensMedianDiffCI[0])}, ${num(paired.tokensMedianDiffCI[1])}]`);
	out.push(`- wall median diff ms ${num(paired.wallMedianDiffMs)} [${num(paired.wallMedianDiffCI[0])}, ${num(paired.wallMedianDiffCI[1])}]`);
	out.push(`- edit errors diff sum ${paired.editErrorsDiffSum}`);

	out.push("", "| task | category | replace pass | hashline pass | replace wrong | hashline wrong | replace edit errors | hashline edit errors | replace tokens | hashline tokens |", "|---|---|---|---|---|---|---|---|---|---|");
	for (const t of tasks) {
		const r = t.replace;
		const h = t.hashline;
		out.push(`| ${t.task} | ${t.category} | ${r.pass}/${r.n} | ${h.pass}/${h.n} | ${r.wrong} | ${h.wrong} | ${r.editErrors} | ${h.editErrors} | ${num(r.tokensMedian)} | ${num(h.tokensMedian)} |`);
	}
	out.push("", `Failing or wrong-write runs (${failures.length}): ${failures.join(", ") || "none"}`);
	process.stdout.write(`${out.join("\n")}\n`);

	writeFileSync(`${file}.summary.json`, `${JSON.stringify({ file, modes, paired, tasks, failures }, null, 2)}\n`);
}
