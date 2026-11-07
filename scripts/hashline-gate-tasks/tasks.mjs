// Task set for the P2 live-model gate (docs/axiom/hashline-gate.md): replace vs hashline edit mode.
// Each task has a fixture, a prompt, an oracle (a fix only `validate` applies), a guard (violations of
// bytes the task must not change), and a corrupt variant (a plausible wrong write that the guard must flag).
// Stale tasks change a file after the agent's first read of it, through the runner.

const lines = (...rows) => `${rows.join("\n")}\n`;
const crlf = (...rows) => `${rows.join("\r\n")}\r\n`;

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

const TEST_HEADER = `const test = require("node:test");\nconst assert = require("node:assert");\n`;

export const tasks = [
	{
		id: "multihunk-stats",
		category: "multi-hunk",
		prompt: "The tests in test/ fail. Fix src/stats.js so that `node --test` passes. Do not edit the tests.",
		files: {
			"src/stats.js": lines(
				"// Descriptive statistics. variance is the sample variance (divides by n - 1).",
				"function total(xs) {",
				"  return xs.reduce((a, b) => a + b, 0);",
				"}",
				"",
				"function mean(xs) {",
				"  return total(xs) / (xs.length - 1);",
				"}",
				"",
				"function median(xs) {",
				"  const mid = Math.floor(xs.length / 2);",
				"  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;",
				"}",
				"",
				"function range(xs) {",
				"  return Math.max(...xs) - Math.min(...xs) + 1;",
				"}",
				"",
				"function mode(xs) {",
				"  const counts = new Map();",
				"  for (const x of xs) counts.set(x, (counts.get(x) || 0) + 1);",
				"  let best = xs[0];",
				"  for (const [x, c] of counts) if (c >= counts.get(best)) best = x;",
				"  return best;",
				"}",
				"",
				"function variance(xs) {",
				"  const m = mean(xs);",
				"  return xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length;",
				"}",
				"",
				"module.exports = { total, mean, median, range, mode, variance };",
			),
			"test/stats.test.js": `${TEST_HEADER}const { total, mean, median, range, mode, variance } = require("../src/stats.js");
test("total adds numbers", () => assert.strictEqual(total([1, 2, 3]), 6));
test("mean is the arithmetic mean", () => assert.strictEqual(mean([1, 2, 3]), 2));
test("median sorts before choosing", () => {
  assert.strictEqual(median([5, 1, 3]), 3);
  assert.strictEqual(median([4, 1, 3, 2]), 2.5);
});
test("range is max minus min", () => assert.strictEqual(range([4, 9, 1]), 8));
test("mode keeps the first value among ties", () => assert.strictEqual(mode([2, 1, 2, 1]), 2));
test("variance is the sample variance", () => assert.ok(Math.abs(variance([1, 2, 3, 4]) - 5 / 3) < 1e-9));
`,
		},
		oracle: (cur) => ({
			"src/stats.js": swaps(cur["src/stats.js"], [
				["return total(xs) / (xs.length - 1);", "return total(xs) / xs.length;"],
				[
					"  const mid = Math.floor(xs.length / 2);\n  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;",
					"  const s = [...xs].sort((a, b) => a - b);\n  const mid = Math.floor(s.length / 2);\n  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;",
				],
				["return Math.max(...xs) - Math.min(...xs) + 1;", "return Math.max(...xs) - Math.min(...xs);"],
				["if (c >= counts.get(best)) best = x;", "if (c > counts.get(best)) best = x;"],
				[
					"return xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length;",
					"return xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);",
				],
			]),
		}),
		guard: (final, pristine) => lost(final["src/stats.js"] ?? "", [fnBlock(pristine["src/stats.js"], "total")]),
		corrupt: (cur) => ({
			"src/stats.js": swaps(cur["src/stats.js"], [["xs.reduce((a, b) => a + b, 0)", "xs.reduce((a, b) => a + b, 1)"]]),
		}),
	},
	{
		id: "dup-validators",
		category: "duplicate",
		prompt: "The tests in test/ fail. Fix src/forms.js so that `node --test` passes. Do not edit the tests.",
		files: {
			"src/forms.js": lines(
				"// Form validators. Each returns true when the value is acceptable.",
				"function validateName(value) {",
				'  if (typeof value !== "string") throw new TypeError("value must be a string");',
				"  const v = value.trim();",
				'  return v !== "";',
				"}",
				"",
				"function validateEmail(value) {",
				'  if (typeof value !== "string") throw new TypeError("value must be a string");',
				"  const v = value.trim();",
				'  return v.includes("@");',
				"}",
				"",
				"function validatePhone(value) {",
				'  if (typeof value !== "string") throw new TypeError("value must be a string");',
				"  const v = value.trim();",
				'  return v !== "";',
				"}",
				"",
				"module.exports = { validateName, validateEmail, validatePhone };",
			),
			"test/forms.test.js": `${TEST_HEADER}const { validateName, validateEmail, validatePhone } = require("../src/forms.js");
test("name must not be blank", () => {
  assert.strictEqual(validateName("  "), false);
  assert.strictEqual(validateName(" Ana "), true);
});
test("email needs an @", () => {
  assert.strictEqual(validateEmail("ana"), false);
  assert.strictEqual(validateEmail("ana@x.io"), true);
});
test("phone needs at least 7 digits", () => {
  assert.strictEqual(validatePhone("+1 555"), false);
  assert.strictEqual(validatePhone("+1 (555) 123-4567"), true);
  assert.strictEqual(validatePhone("  "), false);
});
test("non-strings throw", () => assert.throws(() => validatePhone(12), TypeError));
`,
		},
		oracle: (cur) => ({
			"src/forms.js": swaps(cur["src/forms.js"], [
				[
					'return v !== "";\n}\n\nmodule.exports',
					'return v.replace(/\\D/g, "").length >= 7;\n}\n\nmodule.exports',
				],
			]),
		}),
		guard: (final, pristine) =>
			lost(final["src/forms.js"] ?? "", [fnBlock(pristine["src/forms.js"], "validateName"), fnBlock(pristine["src/forms.js"], "validateEmail")]),
		corrupt: (cur) => ({
			"src/forms.js": swaps(cur["src/forms.js"], [
				['return v !== "";\n}\n\nfunction validateEmail', 'return v.replace(/\\D/g, "").length >= 7;\n}\n\nfunction validateEmail'],
			]),
		}),
	},
	{
		id: "crlf-report",
		category: "line-endings",
		prompt: "The tests in test/ fail. Fix src/report.js so that `node --test` passes. Do not edit the tests.",
		files: {
			"src/report.js": crlf(
				"// Order summaries.",
				"function formatOrder(order) {",
				"  const items = order.items.length;",
				"  const total = order.items.reduce((s, i) => s + i.price * i.qty, 0);",
				"  return `${order.id}: ${items} items, ${total.toFixed(2)}`;",
				"}",
				"",
				"function formatTotal(orders) {",
				"  const sum = orders.reduce((s, o) => s + o.total, 0);",
				"  return sum.toFixed(1);",
				"}",
				"",
				"module.exports = { formatOrder, formatTotal };",
			),
			"test/report.test.js": `${TEST_HEADER}const { formatOrder, formatTotal } = require("../src/report.js");
test("formatTotal keeps cents", () => assert.strictEqual(formatTotal([{ total: 1.5 }, { total: 2.25 }]), "3.75"));
test("formatOrder sums line items", () => assert.strictEqual(formatOrder({ id: "A", items: [{ price: 2, qty: 2 }] }), "A: 1 items, 4.00"));
`,
		},
		oracle: (cur) => ({
			"src/report.js": swaps(cur["src/report.js"], [["  return sum.toFixed(1);", "  return sum.toFixed(2);"]]),
		}),
		guard: (final) => (/(?<!\r)\n/.test(final["src/report.js"] ?? "") ? ["bare LF: file endings were changed"] : []),
		corrupt: (cur) => ({ "src/report.js": cur["src/report.js"].replace(/\r\n/g, "\n") }),
	},
	{
		id: "mixed-eol-ledger",
		category: "line-endings",
		prompt: "The tests in test/ fail. Fix src/ledger.js so that `node --test` passes. Do not edit the tests.",
		files: {
			"src/ledger.js": [
				["// Money helpers. The first lines use CRLF and the rest use LF.", "\r\n"],
				["function sumCents(items) {", "\r\n"],
				["  return items.reduce((s, i) => s + i.cents, 0);", "\r\n"],
				["}", "\r\n"],
				["", "\n"],
				["function toDollars(cents) {", "\n"],
				["  return Math.floor(cents / 100);", "\n"],
				["}", "\n"],
				["", "\n"],
				["function describe(cents) {", "\n"],
				["  return `$${toDollars(cents).toFixed(2)}`;", "\n"],
				["}", "\n"],
				["", "\n"],
				["module.exports = { sumCents, toDollars, describe };", "\n"],
			]
				.map(([line, ending]) => line + ending)
				.join(""),
			"test/ledger.test.js": `${TEST_HEADER}const { sumCents, toDollars, describe } = require("../src/ledger.js");
test("sumCents adds cents", () => assert.strictEqual(sumCents([{ cents: 100 }, { cents: 50 }]), 150));
test("toDollars keeps fractions", () => {
  assert.strictEqual(toDollars(150), 1.5);
  assert.strictEqual(toDollars(99), 0.99);
});
test("describe formats two decimals", () => assert.strictEqual(describe(150), "$1.50"));
`,
		},
		oracle: (cur) => ({
			"src/ledger.js": swaps(cur["src/ledger.js"], [["  return Math.floor(cents / 100);", "  return cents / 100;"]]),
		}),
		guard: (final, pristine) => {
			const parts = linesWhere(pristine["src/ledger.js"], (line) => !line.includes("Math.floor"));
			return lost(final["src/ledger.js"] ?? "", parts);
		},
		corrupt: (cur) => ({
			"src/ledger.js": swaps(cur["src/ledger.js"], [["  return Math.floor(cents / 100);", "  return cents / 100;"]]).replace(/\r?\n/g, "\r\n"),
		}),
	},
	{
		id: "unicode-bom-greet",
		category: "encoding",
		prompt:
			"The tests in test/ fail. Fix src/greet.js so that `node --test` passes. Unknown languages must fall back to English. Do not edit the tests.",
		files: {
			"src/greet.js": `\uFEFF${lines(
				"// Greetings in several languages.",
				"const GREETINGS = {",
				'  en: "Hello",',
				'  fr: "Bonjour, café ✓",',
				'  de: "Grüß dich — Größe",',
				'  ja: "こんにちは",',
				"};",
				"function greet(lang, name) {",
				"  const base = GREETINGS[lang];",
				"  return `${base} ${name.trim()}`;",
				"}",
				"",
				"module.exports = { greet };",
			)}`,
			"test/greet.test.js": `${TEST_HEADER}const { greet } = require("../src/greet.js");
test("known languages", () => {
  assert.strictEqual(greet("fr", "Ana"), "Bonjour, café ✓ Ana");
  assert.strictEqual(greet("de", " Max "), "Grüß dich — Größe Max");
});
test("unknown languages fall back to English", () => assert.strictEqual(greet("xx", "Ana"), "Hello Ana"));
`,
		},
		oracle: (cur) => ({
			"src/greet.js": swaps(cur["src/greet.js"], [["const base = GREETINGS[lang];", "const base = GREETINGS[lang] || GREETINGS.en;"]]),
		}),
		guard: (final, pristine) => {
			const parts = linesWhere(pristine["src/greet.js"], (line) => /[^\x00-\x7F]/.test(line));
			const bom = final["src/greet.js"]?.startsWith("\uFEFF") ? [] : ["BOM removed"];
			return [...bom, ...lost(final["src/greet.js"] ?? "", parts)];
		},
		corrupt: (cur) => ({ "src/greet.js": cur["src/greet.js"].replace(/^\uFEFF/, "") }),
	},
	{
		id: "rename-fetch",
		category: "multi-file",
		prompt:
			"Rename the function getUser to fetchUser everywhere in src/: its definition, its exports, its imports and its callers. Do not rename getUserName. Keep the behavior, then make `node --test` pass. Do not edit the tests.",
		files: {
			"src/db.js": lines(
				"// Fake storage used by the tests.",
				"module.exports = {",
				"  find(id) {",
				'    return { id, name: "user" + id };',
				"  },",
				"};",
			),
			"src/users.js": lines(
				'const db = require("./db.js");',
				"",
				"function getUser(id) {",
				"  return db.find(id);",
				"}",
				"",
				"function getUserName(id) {",
				"  const u = getUser(id);",
				"  return u ? u.name : null;",
				"}",
				"",
				"module.exports = { getUser, getUserName };",
			),
			"src/routes.js": lines(
				'const { getUser, getUserName } = require("./users.js");',
				"",
				"function profile(id) {",
				"  return { user: getUser(id), name: getUserName(id) };",
				"}",
				"",
				"module.exports = { profile };",
			),
			"src/cache.js": lines(
				'const { getUser } = require("./users.js");',
				"",
				"const cache = new Map();",
				"",
				"function cachedUser(id) {",
				"  if (!cache.has(id)) cache.set(id, getUser(id));",
				"  return cache.get(id);",
				"}",
				"",
				"module.exports = { cachedUser };",
			),
			"test/users.test.js": `${TEST_HEADER}const users = require("../src/users.js");
const { profile } = require("../src/routes.js");
const { cachedUser } = require("../src/cache.js");
test("fetchUser returns the stored user", () => assert.deepStrictEqual(users.fetchUser(3), { id: 3, name: "user3" }));
test("getUserName keeps its name", () => assert.strictEqual(users.getUserName(3), "user3"));
test("getUser is no longer exported", () => assert.strictEqual(users.getUser, undefined));
test("profile", () => assert.deepStrictEqual(profile(4), { user: { id: 4, name: "user4" }, name: "user4" }));
test("cachedUser", () => {
  assert.deepStrictEqual(cachedUser(5), { id: 5, name: "user5" });
  assert.strictEqual(cachedUser(5), cachedUser(5));
});
`,
		},
		oracle: (cur) =>
			Object.fromEntries(
				["src/users.js", "src/routes.js", "src/cache.js"].map((p) => [p, cur[p].replace(/\bgetUser\b/g, () => "fetchUser")]),
			),
		guard: (final, pristine) => {
			const out = lost(final["src/users.js"] ?? "", ["function getUserName(id) {"]);
			out.push(...lost(final["src/db.js"] ?? "", [pristine["src/db.js"]]));
			for (const p of ["src/users.js", "src/routes.js", "src/cache.js"]) {
				if (/\bgetUser\b/.test(final[p] ?? "")) out.push(`${p} still has getUser`);
			}
			return out;
		},
		corrupt: (cur) =>
			Object.fromEntries(
				["src/users.js", "src/routes.js", "src/cache.js"].map((p) => [p, cur[p].replace(/\bgetUser/g, () => "fetchUser")]),
			),
	},
	{
		id: "move-formatter",
		category: "move",
		prompt:
			"Move formatMoney out of src/invoice.js into a new module src/money.js. Export it from money.js, import it into invoice.js, and keep the behavior. Make `node --test` pass. Do not edit the tests.",
		files: {
			"src/invoice.js": lines(
				"// Invoice rendering.",
				"function formatMoney(cents) {",
				'  const sign = cents < 0 ? "-" : "";',
				"  const abs = Math.abs(cents);",
				'  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;',
				"}",
				"",
				"function renderLine(item) {",
				"  return `${item.name} ${formatMoney(item.cents)}`;",
				"}",
				"",
				"function renderInvoice(items) {",
				'  return items.map(renderLine).join("\\n");',
				"}",
				"",
				"module.exports = { renderInvoice, renderLine };",
			),
			"test/invoice.test.js": `${TEST_HEADER}const { formatMoney } = require("../src/money.js");
const { renderInvoice } = require("../src/invoice.js");
test("formatMoney handles negatives", () => assert.strictEqual(formatMoney(-150), "-$1.50"));
test("formatMoney pads cents", () => assert.strictEqual(formatMoney(1205), "$12.05"));
test("renderInvoice lists items", () =>
  assert.strictEqual(renderInvoice([{ name: "tea", cents: 250 }, { name: "cake", cents: 1205 }]), "tea $2.50\\ncake $12.05"));
`,
		},
		oracle: () => ({
			"src/money.js": lines(
				"// Money formatting.",
				"function formatMoney(cents) {",
				'  const sign = cents < 0 ? "-" : "";',
				"  const abs = Math.abs(cents);",
				'  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;',
				"}",
				"",
				"module.exports = { formatMoney };",
			),
			"src/invoice.js": lines(
				"// Invoice rendering.",
				'const { formatMoney } = require("./money.js");',
				"",
				"function renderLine(item) {",
				"  return `${item.name} ${formatMoney(item.cents)}`;",
				"}",
				"",
				"function renderInvoice(items) {",
				'  return items.map(renderLine).join("\\n");',
				"}",
				"",
				"module.exports = { renderInvoice, renderLine };",
			),
		}),
		guard: (final, pristine) => {
			const money = final["src/money.js"] ?? "";
			const invoice = final["src/invoice.js"] ?? "";
			return [
				...lost(money, ['  const abs = Math.abs(cents);\n', '  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;\n']),
				...lost(invoice, [fnBlock(pristine["src/invoice.js"], "renderLine"), fnBlock(pristine["src/invoice.js"], "renderInvoice")]),
			];
		},
		corrupt: (cur) => ({
			"src/money.js": lines(
				"// Money formatting.",
				"function formatMoney(cents) {",
				'  const sign = cents < 0 ? "-" : "";',
				"  const abs = Math.abs(cents);",
				'  return `${sign}$${Math.floor(abs / 100)}.${abs % 100}`;',
				"}",
				"",
				"module.exports = { formatMoney };",
			),
			"src/invoice.js": cur["src/invoice.js"],
		}),
	},
	{
		id: "stale-shift-rates",
		category: "stale",
		stale: {
			path: "src/rates.js",
			mutate: (text) =>
				`// Rates table, reviewed by finance: SENTINEL-RATES keep this header\n// Tax rate is 8 percent.\n// Amounts are dollars.\n${text}`,
		},
		prompt: "The tests in test/ fail. Fix src/rates.js so that `node --test` passes. Tax must be rounded to the cent. Do not edit the tests.",
		files: {
			"src/rates.js": lines(
				"// Sales tax helpers. Amounts are in dollars.",
				"const RATE = 0.08;",
				"",
				"function taxFor(amount) {",
				"  return Math.floor(amount * RATE);",
				"}",
				"",
				"function totalFor(amount) {",
				"  return amount + taxFor(amount);",
				"}",
				"",
				"module.exports = { taxFor, totalFor };",
			),
			"test/rates.test.js": `${TEST_HEADER}const { taxFor, totalFor } = require("../src/rates.js");
test("tax is rounded to the cent", () => {
  assert.strictEqual(taxFor(10), 0.8);
  assert.strictEqual(taxFor(1.26), 0.1);
});
test("total adds tax", () => assert.ok(Math.abs(totalFor(10) - 10.8) < 1e-9));
`,
		},
		oracle: (cur) => ({
			"src/rates.js": swaps(cur["src/rates.js"], [["return Math.floor(amount * RATE);", "return Math.round(amount * RATE * 100) / 100;"]]),
		}),
		guard: (final) => lost(final["src/rates.js"] ?? "", ["SENTINEL-RATES"]),
		corrupt: (cur) => ({
			"src/rates.js": swaps(cur["src/rates.js"].replace(/^\/\/ Rates table[\s\S]*?\n(?=\/\/ Sales)/, ""), [["return Math.floor(amount * RATE);", "return Math.round(amount * RATE * 100) / 100;"]]),
		}),
	},
	{
		id: "stale-content-shipping",
		category: "stale",
		stale: {
			path: "src/shipping.js",
			mutate: (text) =>
				text.replace(
					"  if (total >= FREE_OVER && !express) return 0;",
					() => "  if (total >= FREE_OVER && !express) return 0; // SENTINEL-SHIP: promo band, keep",
				),
		},
		prompt: "The tests in test/ fail. Fix src/shipping.js so that `node --test` passes. Do not edit the tests.",
		files: {
			"src/shipping.js": lines(
				"// Shipping charge in dollars. Orders over the free threshold ship free; the threshold is strictly more than $50.",
				"const FREE_OVER = 50;",
				"",
				"function shippingFor(total, express) {",
				"  if (total >= FREE_OVER && !express) return 0;",
				"  return express ? 15 : 5;",
				"}",
				"",
				"module.exports = { shippingFor };",
			),
			"test/shipping.test.js": `${TEST_HEADER}const { shippingFor } = require("../src/shipping.js");
test("orders over 50 ship free", () => assert.strictEqual(shippingFor(51, false), 0));
test("exactly 50 pays standard", () => assert.strictEqual(shippingFor(50, false), 5));
test("express pays 15 when not free", () => assert.strictEqual(shippingFor(60, true), 15));
test("standard under the threshold", () => assert.strictEqual(shippingFor(20, false), 5));
`,
		},
		oracle: (cur) => ({
			"src/shipping.js": swaps(cur["src/shipping.js"], [["if (total >= FREE_OVER && !express) return 0;", "if (total > FREE_OVER && !express) return 0;"]]),
		}),
		guard: (final) => lost(final["src/shipping.js"] ?? "", ["SENTINEL-SHIP"]),
		corrupt: (cur) => ({
			"src/shipping.js": swaps(cur["src/shipping.js"].replace(" // SENTINEL-SHIP: promo band, keep", ""), [["if (total >= FREE_OVER && !express) return 0;", "if (total > FREE_OVER && !express) return 0;"]]),
		}),
	},
	{
		id: "stale-clobber-inventory",
		category: "stale",
		stale: {
			path: "src/inventory.js",
			mutate: (text) =>
				`${text}\n// SENTINEL-INV: ops audit hook, keep this block\nfunction auditRestock(sku) {\n  return \`audit:\${sku}\`;\n}\nmodule.exports.auditRestock = auditRestock;\n`,
		},
		prompt: "The tests in test/ fail. Fix src/inventory.js so that `node --test` passes. Do not edit the tests.",
		files: {
			"src/inventory.js": lines(
				"// Stock levels by SKU.",
				"const stock = new Map();",
				"",
				"function restock(sku, qty) {",
				"  const have = stock.get(sku) || 0;",
				"  stock.set(sku, have - qty);",
				"  return stock.get(sku);",
				"}",
				"",
				"function available(sku) {",
				"  return stock.get(sku) || 0;",
				"}",
				"",
				"module.exports = { restock, available, stock };",
			),
			"test/inventory.test.js": `${TEST_HEADER}const inventory = require("../src/inventory.js");
test("restock adds stock", () => {
  assert.strictEqual(inventory.restock("a", 5), 5);
  assert.strictEqual(inventory.restock("a", 3), 8);
  assert.strictEqual(inventory.available("a"), 8);
});
test("unknown sku has none", () => assert.strictEqual(inventory.available("b"), 0));
test("audit hook", () => assert.strictEqual(inventory.auditRestock("a"), "audit:a"));
`,
		},
		oracle: (cur) => ({
			"src/inventory.js": swaps(cur["src/inventory.js"], [["stock.set(sku, have - qty);", "stock.set(sku, have + qty);"]]),
		}),
		guard: (final) => lost(final["src/inventory.js"] ?? "", ["SENTINEL-INV", "function auditRestock(sku) {"]),
		corrupt: (cur) => ({
			"src/inventory.js": swaps(cur["src/inventory.js"].replace(/\n\/\/ SENTINEL-INV[\s\S]*$/, "\n"), [["stock.set(sku, have - qty);", "stock.set(sku, have + qty);"]]),
		}),
	},
	{
		id: "dup-config-workers",
		category: "duplicate",
		prompt: "The tests in test/ fail. Fix src/config.js so that `node --test` passes. Do not edit the tests.",
		files: {
			"src/config.js": lines(
				"// Config readers. Each reads a value from the environment or falls back to a default.",
				"function readPort(env) {",
				"  const raw = env.PORT;",
				"  if (raw === undefined) return 8080;",
				"  return Number(raw);",
				"}",
				"",
				"function readHost(env) {",
				"  const raw = env.HOST;",
				'  if (raw === undefined) return "localhost";',
				"  return String(raw);",
				"}",
				"",
				"function readWorkers(env) {",
				"  const raw = env.WORKERS;",
				"  if (raw === undefined) return 4;",
				"  return Number(raw);",
				"}",
				"",
				"function readTimeout(env) {",
				"  const raw = env.TIMEOUT;",
				"  if (raw === undefined) return 30;",
				"  return Number(raw);",
				"}",
				"",
				"module.exports = { readPort, readHost, readWorkers, readTimeout };",
			),
			"test/config.test.js": `${TEST_HEADER}const cfg = require("../src/config.js");
test("port", () => {
  assert.strictEqual(cfg.readPort({}), 8080);
  assert.strictEqual(cfg.readPort({ PORT: "80" }), 80);
});
test("host", () => assert.strictEqual(cfg.readHost({}), "localhost"));
test("workers are at least 1", () => {
  assert.strictEqual(cfg.readWorkers({}), 4);
  assert.strictEqual(cfg.readWorkers({ WORKERS: "3" }), 3);
  assert.strictEqual(cfg.readWorkers({ WORKERS: "0" }), 1);
});
test("timeout", () => assert.strictEqual(cfg.readTimeout({ TIMEOUT: "7" }), 7));
`,
		},
		oracle: (cur) => ({
			"src/config.js": swaps(cur["src/config.js"], [
				['function readWorkers(env) {\n  const raw = env.WORKERS;\n  if (raw === undefined) return 4;\n  return Number(raw);', 'function readWorkers(env) {\n  const raw = env.WORKERS;\n  if (raw === undefined) return 4;\n  return Math.max(1, Number(raw));'],
			]),
		}),
		guard: (final, pristine) =>
			lost(final["src/config.js"] ?? "", [fnBlock(pristine["src/config.js"], "readPort"), fnBlock(pristine["src/config.js"], "readTimeout"), fnBlock(pristine["src/config.js"], "readHost")]),
		corrupt: (cur) => ({
			"src/config.js": swaps(cur["src/config.js"], [
				['function readPort(env) {\n  const raw = env.PORT;\n  if (raw === undefined) return 8080;\n  return Number(raw);', 'function readPort(env) {\n  const raw = env.PORT;\n  if (raw === undefined) return 8080;\n  return Math.max(1, Number(raw));'],
			]),
		}),
	},
];
