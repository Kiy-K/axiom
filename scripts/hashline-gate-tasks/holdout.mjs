// Holdout task set for the P2 gate (docs/axiom/hashline-gate.md). Never used to tune the candidate: a
// change to this file after the freeze invalidates the holdout comparison. Same shape as tasks.mjs.

const lines = (...rows) => `${rows.join("\n")}\n`;

function swaps(text, pairs) {
	let out = text;
	for (const [from, to] of pairs) {
		if (!out.includes(from)) throw new Error(`oracle anchor not found: ${from.slice(0, 70)}`);
		out = out.replace(from, () => to);
	}
	return out;
}

// The text of one top-level function: from its header to the next "\n}\n".
function fnBlock(src, name) {
	const start = src.indexOf(`function ${name}(`);
	if (start < 0) throw new Error(`no function ${name}`);
	return src.slice(start, src.indexOf("\n}\n", start) + 3);
}

// Every line of `src` (with its own terminator) that passes the filter.
function linesWhere(src, keep) {
	return (src.match(/[^\n]*\n|[^\n]+$/g) ?? []).filter(keep);
}

const lost = (final, parts) => parts.filter((part) => !final.includes(part)).map((part) => `lost: ${JSON.stringify(part.slice(0, 70))}`);

export const tasks = [
	{
		id: "holdout-stale-price",
		category: "stale",
		stale: {
			path: "src/pricing.js",
			mutate: (text) => `// SENTINEL-PRICE: finance table, keep this header\n${text}`,
		},
		prompt: "The tests in test/ fail. Fix src/pricing.js so that `node --test` passes. Do not edit the tests.",
		files: {
			"src/pricing.js": lines(
				"// Discount rates by customer tier.",
				"const RATES = { gold: 0.1, silver: 0.05 };",
				"function discountFor(tier) {",
				"  return RATES[tier] ?? 0;",
				"}",
				"module.exports = { discountFor };",
			),
			"test/pricing.test.js": lines(
				'const test = require("node:test");',
				'const assert = require("node:assert");',
				'const { discountFor } = require("../src/pricing.js");',
				'test("gold tier gets 15 percent", () => assert.strictEqual(discountFor("gold"), 0.15));',
				'test("unknown tier gets nothing", () => assert.strictEqual(discountFor("bronze"), 0));',
			),
		},
		oracle: (cur) => ({ "src/pricing.js": swaps(cur["src/pricing.js"], [["gold: 0.1,", "gold: 0.15,"]]) }),
		guard: (final) => lost(final["src/pricing.js"] ?? "", ["SENTINEL-PRICE"]),
		corrupt: (cur) => ({ "src/pricing.js": cur["src/pricing.js"].replace(/^\/\/ SENTINEL-PRICE[^\n]*\n/, "") }),
	},
	{
		id: "holdout-stale-log-append",
		category: "stale",
		stale: {
			path: "src/log.js",
			mutate: (text) =>
				`${text}\n// SENTINEL-LOG: audit hook, keep this block\nfunction auditLine(msg) {\n  return "audit: " + msg;\n}\nmodule.exports.auditLine = auditLine;\n`,
		},
		prompt: "The tests in test/ fail. Fix src/log.js so that `node --test` passes. Do not edit the tests.",
		files: {
			"src/log.js": lines(
				"// Formats one log line.",
				"function formatLine(level, msg) {",
				'  return "[" + level + "] " + msg;',
				"}",
				"module.exports = { formatLine };",
			),
			"test/log.test.js": lines(
				'const test = require("node:test");',
				'const assert = require("node:assert");',
				'const { formatLine } = require("../src/log.js");',
				'test("levels are upper case", () => assert.strictEqual(formatLine("warn", "disk"), "[WARN] disk"));',
				'test("info lines", () => assert.strictEqual(formatLine("info", "ok"), "[INFO] ok"));',
			),
		},
		oracle: (cur) => ({
			"src/log.js": swaps(cur["src/log.js"], [['return "[" + level + "] " + msg;', 'return "[" + level.toUpperCase() + "] " + msg;']]),
		}),
		guard: (final) => lost(final["src/log.js"] ?? "", ["SENTINEL-LOG", "function auditLine(msg) {"]),
		corrupt: (cur) => ({ "src/log.js": cur["src/log.js"].replace(/\n\/\/ SENTINEL-LOG[\s\S]*$/, "\n") }),
	},
	{
		id: "holdout-dup-totals",
		category: "duplicate",
		prompt: "The tests in test/ fail. Fix src/totals.js so that `node --test` passes. Do not edit the tests.",
		files: {
			"src/totals.js": lines(
				"// Totals over a list of line items.",
				"function grossTotal(items) {",
				"  return items.reduce((s, x) => s + x.amount, 0);",
				"}",
				"",
				"function shippingTotal(items) {",
				"  return items.reduce((s, x) => s + x.amount, 0);",
				"}",
				"",
				"function refundTotal(items) {",
				"  return items.reduce((s, x) => s + x.amount, 0);",
				"}",
				"module.exports = { grossTotal, shippingTotal, refundTotal };",
			),
			"test/totals.test.js": lines(
				'const test = require("node:test");',
				'const assert = require("node:assert");',
				'const { grossTotal, shippingTotal, refundTotal } = require("../src/totals.js");',
				'test("gross sums amounts", () => assert.strictEqual(grossTotal([{ amount: 2 }, { amount: 3 }]), 5));',
				'test("shipping sums amounts", () => assert.strictEqual(shippingTotal([{ amount: 4 }]), 4));',
				'test("refunds are negative", () => assert.strictEqual(refundTotal([{ amount: 5 }]), -5));',
			),
		},
		oracle: (cur) => ({
			"src/totals.js": swaps(cur["src/totals.js"], [["function refundTotal(items) {\n  return items.reduce", "function refundTotal(items) {\n  return -items.reduce"]]),
		}),
		guard: (final, pristine) =>
			lost(final["src/totals.js"] ?? "", [fnBlock(pristine["src/totals.js"], "grossTotal"), fnBlock(pristine["src/totals.js"], "shippingTotal")]),
		corrupt: (cur) => ({
			"src/totals.js": swaps(cur["src/totals.js"], [["function grossTotal(items) {\n  return items.reduce", "function grossTotal(items) {\n  return -items.reduce"]]),
		}),
	},
	{
		id: "holdout-mixed-eol-table",
		category: "line-endings",
		prompt: "The tests in test/ fail. Fix src/table.js so that `node --test` passes. Do not edit the tests.",
		files: {
			"src/table.js":
				"// Column widths for the report.\nconst WIDTH = 12;\r\nfunction pad(text) {\r\n  return text.padEnd(WIDTH);\r\n}\r\nfunction fit(text) {\r\n  return text.slice(0, WIDTH - 1);\r\n}\r\nmodule.exports = { pad, fit };\r\n",
			"test/table.test.js": lines(
				'const test = require("node:test");',
				'const assert = require("node:assert");',
				'const { pad, fit } = require("../src/table.js");',
				'test("fit keeps 12 characters", () => assert.strictEqual(fit("abcdefghijklmnop"), "abcdefghijkl"));',
				'test("pad fills to 12", () => assert.strictEqual(pad("ab"), "ab" + " ".repeat(10)));',
			),
		},
		oracle: (cur) => ({ "src/table.js": swaps(cur["src/table.js"], [["slice(0, WIDTH - 1)", "slice(0, WIDTH)"]]) }),
		guard: (final, pristine) =>
			lost(final["src/table.js"] ?? "", linesWhere(pristine["src/table.js"], (line) => !line.includes("WIDTH - 1"))),
		corrupt: (cur) => ({ "src/table.js": cur["src/table.js"].replace(/\r\n/g, "\n") }),
	},
	{
		id: "holdout-bom-title",
		category: "encoding",
		prompt: "The tests in test/ fail. Fix src/title.js so that `node --test` passes. Do not edit the tests.",
		files: {
			"src/title.js":
				"\uFEFF// Title helpers. Café-safe.\nfunction titleCase(text) {\n  return text.toLowerCase();\n}\nmodule.exports = { titleCase };\n",
			"test/title.test.js": lines(
				'const test = require("node:test");',
				'const assert = require("node:assert");',
				'const { titleCase } = require("../src/title.js");',
				'test("capitalizes words", () => assert.strictEqual(titleCase("hello world"), "Hello World"));',
				'test("keeps accented letters", () => assert.strictEqual(titleCase("élan vital"), "Élan Vital"));',
			),
		},
		oracle: (cur) => ({
			"src/title.js": swaps(cur["src/title.js"], [[
				"  return text.toLowerCase();",
				"  return text.toLowerCase().replace(/(^|\\s)(\\p{L})/gu, (m, s, c) => s + c.toUpperCase());",
			]]),
		}),
		guard: (final, pristine) => {
			const bom = final["src/title.js"]?.startsWith("\uFEFF") ? [] : ["BOM removed"];
			const parts = linesWhere(pristine["src/title.js"], (line) => /[^\x00-\x7F]/.test(line));
			return [...bom, ...lost(final["src/title.js"] ?? "", parts)];
		},
		corrupt: (cur) => ({ "src/title.js": cur["src/title.js"].replace(/^\uFEFF/, "") }),
	},
	{
		id: "holdout-rename-settings",
		category: "multi-file",
		prompt:
			"Rename the function loadSettings to readSettings everywhere in src/: its definition, its exports, its imports and its callers. Do not rename loadSettingsCache. Keep the behavior, then make `node --test` pass. Do not edit the tests.",
		files: {
			"src/settings.js": lines(
				"const cache = new Map();",
				"function loadSettings(name) {",
				"  if (!cache.has(name)) cache.set(name, { name, debug: false });",
				"  return cache.get(name);",
				"}",
				"function loadSettingsCache() {",
				"  return cache.size;",
				"}",
				"module.exports = { loadSettings, loadSettingsCache };",
			),
			"src/app.js": lines(
				'const { loadSettings } = require("./settings.js");',
				"function boot() {",
				'  return loadSettings("app").debug;',
				"}",
				"module.exports = { boot };",
			),
			"src/worker.js": lines(
				'const { loadSettings } = require("./settings.js");',
				"function run(job) {",
				"  return loadSettings(job).name;",
				"}",
				"module.exports = { run };",
			),
			"test/settings.test.js": lines(
				'const test = require("node:test");',
				'const assert = require("node:assert");',
				'const { readSettings, loadSettingsCache } = require("../src/settings.js");',
				'test("readSettings returns the named settings", () => assert.strictEqual(readSettings("x").name, "x"));',
				'test("cache size is a number", () => assert.strictEqual(typeof loadSettingsCache(), "number"));',
			),
		},
		oracle: (cur) =>
			Object.fromEntries(
				["src/settings.js", "src/app.js", "src/worker.js"].map((p) => [p, cur[p].replace(/\bloadSettings\b/g, () => "readSettings")]),
			),
		guard: (final) => {
			const out = lost(final["src/settings.js"] ?? "", ["function loadSettingsCache() {"]);
			for (const p of ["src/settings.js", "src/app.js", "src/worker.js"]) {
				if (/\bloadSettings\b/.test(final[p] ?? "")) out.push(`old name left in ${p}`);
			}
			return out;
		},
		corrupt: (cur) => ({ "src/settings.js": cur["src/settings.js"].replace(/\bloadSettingsCache\b/g, () => "readSettingsCache") }),
	},
];
