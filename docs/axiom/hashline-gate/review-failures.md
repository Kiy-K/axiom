# Review: 12 non-clean P2 gate trials

Verdict: the 10 `mixed-eol-ledger` replace wrong writes are a property of the replace-mode edit tool, not of the model. The one `stale-content-shipping` hashline failure is noise: the model stopped before any edit. `stale-shift-rates-replace-r1` is a harness artifact (injection never ran), not a sentinel the model deleted.

Checked raw `results.jsonl`, `events.jsonl`, workdir files, `scripts/hashline-gate-tasks/tasks.mjs`, `scripts/axiom-hashline-gate.mjs`, and `packages/coding-agent/src/core/tools/edit.ts` / `edit-diff.ts`. Reproduced the rewrite by importing those functions. Re-ran `node --test` on scratch copies of three workdirs. Did not trust a summary.

## Classification

| runId | classification | mechanism | evidence |
|---|---|---|---|
| mixed-eol-ledger-replace-r1 | true wrong write | replace tool rewrote every ending to CRLF after a successful LF-only edit | edit i=154 `_tMs` 8504; work file sha256 `2c70bbe35df6` 336 bytes, 14 CRLF, 0 bare LF |
| mixed-eol-ledger-replace-r2 | true wrong write | same | edit i=130 `_tMs` 8799; same file hash |
| mixed-eol-ledger-replace-r3 | true wrong write | same | edit i=163 `_tMs` 8889; same file hash |
| mixed-eol-ledger-replace-r4 | true wrong write | same | edit i=100 `_tMs` 6355; same file hash |
| mixed-eol-ledger-replace-r5 | true wrong write | same | edit i=96 `_tMs` 7053; same file hash |
| mixed-eol-ledger-replace-r6 | true wrong write | same | edit i=134 `_tMs` 9945; same file hash |
| mixed-eol-ledger-replace-r7 | true wrong write | same | edit i=137 `_tMs` 7169; same file hash |
| mixed-eol-ledger-replace-r8 | true wrong write | same | edit i=131 `_tMs` 6974; same file hash |
| mixed-eol-ledger-replace-r9 | true wrong write | same | edit i=118 `_tMs` 7167; same file hash |
| mixed-eol-ledger-replace-r10 | true wrong write | same | edit i=176 `_tMs` 8823; same file hash |
| stale-shift-rates-replace-r1 | harness artifact | runner injects only after a `read` of `src/rates.js`; this run used `bash` `cat` | `stale.injected: false`; bash i=32 `_tMs` 2452; no `read` of `src/rates.js`; final file has no sentinel |
| stale-content-shipping-hashline-r2 | model error | diagnosed the bug, then `stop` with no tool call | message_end i=99 `_tMs` 6453 `stopReason: stop`; `editCalls: 0`; `willRetry: false` |

## mixed-eol-ledger replace (r1–r10)

### Violations are true wrong writes

Every replace run records the same six strings in `violations` (`results.jsonl`):

- `lost: "function toDollars(cents) {\n"`
- `lost: "}\n"`
- `lost: "function describe(cents) {\n"`
- `lost: "  return \`$${toDollars(cents).toFixed(2)}\`;\n"`
- `lost: "}\n"`
- `lost: "module.exports = { sumCents, toDollars, describe };\n"`

The guard (`scripts/hashline-gate-tasks/tasks.mjs:232-234`) keeps every fixture line of `src/ledger.js` except the line containing `Math.floor`, including its own terminator (`linesWhere`, `tasks.mjs:26-30`). The fixture (`tasks.mjs:202-219`) is four CRLF lines, then LF lines. The six hits are the non-blank LF lines. They are absent because those lines were rewritten to CRLF, so `"function toDollars(cents) {\n"` is not a substring of `"function toDollars(cents) {\r\n"`.

Not a guard false positive. The bytes the task must keep were changed.

Guard under-count, not over-count: the three blank `"\n"` parts are also rewritten, but `lost()` uses `includes`, and `"\r\n"` contains `"\n"`, so blanks are not reported. The CRLF header lines are still present, so the guard did not flag preserved bytes.

Final file, all 10 runs, identical sha256 prefix `2c70bbe35df6`, 336 bytes, 14 CRLF, 0 bare LF, 0 lone CR. `Math.floor` is gone; `cents / 100` is present. Scratch copy of r1: `node --test` 3/3 pass. Logic fix is right; endings are wrong.

Contrast: all 10 `mixed-eol-ledger-hashline-r*` work files equal the oracle (only `Math.floor(cents / 100)` → `cents / 100`, original endings kept: 4 CRLF + 10 bare LF). Zero hashline violations in `results.jsonl`.

### The tool produced the endings, not `newText`

Each run made one successful edit (`isError: false`, result text `Successfully replaced 1 block(s) in src/ledger.js.`). `newText` contains no `\r` in any of the 10. Two shapes, both only the floor expression:

- r1, r2, r7, r9, r10 (event args): `oldText`/`newText` are the `function toDollars` block with LF, `Math.floor(cents / 100)` → `cents / 100`.
- r3: `return Math.floor(cents / 100);` → `return cents / 100;`
- r4, r5, r6, r8: same line with the two-space indent.

So 10/10 model edit texts would normally keep endings. None asked for a file-wide CRLF rewrite.

Write path:

- `packages/coding-agent/src/core/tools/edit-diff.ts:11-16` `detectLineEnding`: if the first `\r\n` is before the first `\n`, the file is treated as CRLF.
- On this fixture that is true because the first newline is the LF of the first CRLF: `crlfIdx` 63, `lfIdx` 64. Return value `"\r\n"`.
- `edit-diff.ts:19-24` `normalizeToLF` then `restoreLineEndings`: if the detected ending is `\r\n`, every `\n` becomes `\r\n`.
- `edit.ts:189-194` always writes `bom + restoreLineEndings(newContent, originalEnding)`. One ending for the whole file.
- `edit-diff.ts:305-307` also normalizes `oldText` and `newText` to LF before matching, so a CR in `newText` would not survive as a mixed ending either. These runs had no CR in `newText`.

Reproduction (imported the real module, did not touch the repo): `detectLineEnding(fixture) === "\r\n"`. Applying either the r1 block edit or the r3 line edit, then `restoreLineEndings`, is byte-identical to `artifacts/mixed-eol-ledger-replace-r1/work/src/ledger.js`.

`applyReplacementsPreservingUnchangedLines` (`edit-diff.ts:132`, used at `:353` only after a fuzzy match) runs on already-LF text. It does not preserve mixed endings. These runs were exact matches anyway.

### Tool property, not model-dependent

Yes. Any successful replace-mode edit of this fixture takes the `edit.ts:189-194` path and rewrites every ending to the first one. The 10/10 rate does not depend on which of the two LF edit texts the model sent, and the same model in hashline mode kept the mixed endings on all 10 repeats.

`docs/axiom/hashline-gate.md:64` already states this: "CRLF lines followed by LF lines; replace mode rewrites endings to the first one." A summary that called these model mistakes would be wrong.

### Existing test

`packages/coding-agent/test/tools.test.ts:1625-1716` ("edit tool CRLF handling"):

- `:1650` asserts a uniform CRLF file stays CRLF after an LF `newText`.
- `:1663` asserts a uniform LF file stays LF.
- `:1676` writes `hello\r\nworld\r\n---\r\nhello\nworld\n` and expects `Found 2 occurrences`. It does not assert that mixed endings survive.

Grep of `packages/coding-agent/test` for `detectLineEnding` / mixed-ending preservation: no test that a CRLF-then-LF file keeps both endings. The gate fixture is the check that shows the rewrite. The unit tests do not.

## stale-shift-rates-replace-r1

Violation: `lost: "SENTINEL-RATES"` (`results.jsonl`). `pass: true`, `editCalls: 1`, `editErrors: 0`, `stale: { injected: false, editAfterInjection: false }`.

Not a true wrong write. The sentinel was never in the file the model read or wrote.

Trace:

1. Event i=32 `_tMs` 2452, `bash`, command `ls; ls src; ls test; cat src/rates.js`. Result is the pristine fixture: `// Sales tax helpers...` and `return Math.floor(amount * RATE);`. No `SENTINEL-RATES`.
2. Event i=62 `_tMs` 3780, `read` of `test/rates.test.js` only. The runner injects only when `toolName === "read"` and the path resolves to `task.stale.path` (`scripts/axiom-hashline-gate.mjs:181-186`). `src/rates.js` was never passed to `read`, so `applyStale` did not run. That matches `stale.injected: false`.
3. Event i=116 `_tMs` 6128, `edit` of `src/rates.js`: `  return Math.floor(amount * RATE);` → `  return Math.round(amount * RATE * 100) / 100;`. Success. The edit does not touch a header.
4. Final `work/src/rates.js` (247 bytes) is the pristine file with that one expression changed. No sentinel. Scratch `node --test`: 2/2 pass.

The model's edit did not remove the sentinel. The runner never injected it.

The guard (`tasks.mjs:473`) is `lost(final["src/rates.js"], ["SENTINEL-RATES"])`. It assumes the sentinel was injected. Here that premise is false, so the string is a false signal. Classification is harness artifact, not "the model clobbered the stale header."

Contrast: `stale-shift-rates-replace-r2` did `read` `src/rates.js` (event i=55) and the final file starts with `// Rates table, reviewed by finance: SENTINEL-RATES keep this header`. Injection works when the `read` tool is used. In `results.jsonl`, this is the only violation among 10 replace and 10 hashline repeats of this task.

## stale-content-shipping-hashline-r2

`pass: false`, `violations: []`, `editCalls: 0`, `editErrors: 0`, `stale: { injected: true, editAfterInjection: false }`, `agentExit: 0`, `timedOut: false`.

Why it stopped: the model gave up the turn. It did not hit a tool error, did not misread the hashline view, and did not get stuck in a retry loop.

Trace:

1. Event i=27 `_tMs` 2458, `bash` `ls -R; node --test`. Fails `exactly 50 pays standard`: `0 !== 5`. That is the fixture bug (`total >= FREE_OVER`).
2. Event i=56 `_tMs` 3993, `read` `src/shipping.js`. Result (tool_execution_end i=57 `_tMs` 3996) is hashline text, line 5: `5#eb|  if (total >= FREE_OVER && !express) return 0;` No sentinel in the read result. Injection runs after a successful `read` end (`axiom-hashline-gate.mjs:184-186`), so the model was shown the pre-injection line. `stale.injected: true` is consistent with the final file, not with the read result.
3. Last assistant turn: `message_update` i=63–98 are only `text_start` / text deltas / `text_end`. No tool-call event. `message_end` i=99 `_tMs` 6453, `stopReason: "stop"`, text: `` `shippingFor` treats exactly $50 as eligible for free shipping. The condition should be strictly greater than $50. I’ll update it and rerun the tests. ``
4. `turn_end` i=100 `stopReason: "stop"`. `agent_end` i=101 `willRetry: false`. No edit was attempted.

Final `work/src/shipping.js` line 5 is still `if (total >= FREE_OVER && !express) return 0; // SENTINEL-SHIP: promo band, keep`. The sentinel is there because injection happened and nothing edited the file. Scratch `node --test` fails the same assertion (`0 !== 5`). The failure is the original bug left in place, not a hashline mismatch and not the sentinel.

The hashline read was parsed correctly: the model named the right change (`>=` to `>`). It then ended the turn without calling `edit`. That is a model error (premature stop), not a hashline-mode failure and not an effect of the injected comment (the model never saw it).

Other repeats: `results.jsonl` has 9/10 hashline passes and 10/10 replace passes on this task, 0 violations. `stale-content-shipping-hashline-r1` did edit `>=` to `>` and kept `// SENTINEL-SHIP: promo band, keep`.

## What this contradicts

- Counting all 11 non-empty `violations` rows as model wrong writes overstates the model. Ten are the replace tool rewriting mixed endings. One is a missed injection.
- Counting the shipping hashline failure as evidence against hashline mode is wrong. Hashline edit was never called. The read format did not prevent a correct diagnosis.

## Open questions

- If a published wrong-write rate includes `stale-shift-rates-replace-r1`, it should be removed or labeled harness. Not re-derived here for the other 208 trials.
- The mixed-eol guard misses blank LF lines. That does not create the six hits; it hides three more real ending changes.

## Verdict line

The replace-mode wrong-write rate on `mixed-eol-ledger` is a tool property (10/10, reproduced from `detectLineEnding` + `restoreLineEndings`, independent of the model's LF `newText`). The one hashline failure on `stale-content-shipping` is noise (model stopped before any edit), not hashline mode.
