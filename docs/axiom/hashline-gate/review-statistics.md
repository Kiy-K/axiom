# Statistics review: hashline vs replace gate

Verdict: the stats module's printed point estimates match an independent recompute of `/tmp/hashline-gate/results.jsonl`. Every printed difference is either `Number#toFixed` rounding or the bootstrap seed (module default 7, this review's assigned seed 1). The data supports a pair-level wrong-write difference and a pair-level increase in tokens and wall time for hashline. It does not support a pass-rate difference. A 1-discordant-pair result is not informative. The wrong-write sign test is significant only if the unit is the `(task, repeat)` pair; it is not significant if the unit is the task.

Computed by `/tmp/hashline-gate/verify/recompute.mjs` (does not import `scripts/hashline-gate-stats.mjs`). The module was run only after those numbers existed: `node scripts/axiom-hashline-gate.mjs summarize /tmp/hashline-gate/results.jsonl`.

## 1. Headline numbers vs the module

Exact values are this review. Printed values are the module's stdout. Wilson intervals use z = 1.96. Even-n median is the average of the two central sorted values (same definition as `median` in `scripts/hashline-gate-stats.mjs:40-44`).

| metric | replace exact | replace printed | hashline exact | hashline printed | mismatch |
|---|---|---|---|---|---|
| runs | 110 | 110 | 110 | 110 | none |
| task pass | 110/110 = 1 | 110/110 = 100.0% | 109/110 = 0.990909... | 109/110 = 99.1% | print rounds to 1 decimal |
| pass Wilson 95% | [0.966254866, 1] | [96.6%, 100.0%] | [0.950293130, 0.998393466] | [95.0%, 99.8%] | print rounds to 1 decimal |
| wrong writes | 11/110 = 0.1 | 11/110 | 0/110 = 0 | 0/110 | none |
| wrong-write Wilson 95% | [0.056759535, 0.170236572] | [5.7%, 17.0%] | [0, 0.033745134] | [0.0%, 3.4%] | print rounds to 1 decimal |
| edit calls | 130 | 130 | 181 | 181 | none |
| edit errors | 0 | 0 (0.00 per run) | 49 | 49 (0.45 per run) | 49/110 = 0.44545..., printed 0.45 |
| exact edit success | 130/130 = 1 | 100.0% | 132/181 = 0.729281768 | 72.9% | print rounds to 1 decimal |
| edit-success Wilson 95% | [0.971297414, 1] | [97.1%, 100.0%] | [0.660283143, 0.788749975] | [66.0%, 78.9%] | print rounds to 1 decimal |
| tokens median | 9619.5 | 9620 | 13045 | 13045 | `toFixed(0)` rounds 9619.5 up |
| tokens mean | 10484.472727... | 10484 | 13451.390909... | 13451 | `toFixed(0)` truncates the fraction |
| wall median ms | 15111.5 | 15112 | 17381 | 17381 | `toFixed(0)` rounds 15111.5 up |
| cost sum | 0.07216904 | 0.0722 | 0.0876833 | 0.0877 | `toFixed(4)` |
| timeouts | 0 | 0 | 0 | 0 | none |
| stale injected / edit after | 29 / 29 | 29 / 29 | 30 / 29 | 30 / 29 | none; these are two counts, not a ratio |
| model | gpt-6-luna | gpt-6-luna | gpt-6-luna | gpt-6-luna | none |

Paired, hashline minus replace, 110 pairs:

| metric | exact (this review) | module printed | mismatch |
|---|---|---|---|
| pass discordance | hashline-only 0, replace-only 1 | same | none |
| wrong-write discordance | hashline-only 0, replace-only 11 | same | none |
| tokens median diff | 1676 | 1676 | none |
| tokens 95% bootstrap, seed 1, 5000 | [983.5, 3182] | not printed | assigned seed; module does not use it |
| tokens 95% bootstrap, seed 7, 5000 | [983.5, 3479] | [984, 3479] | print rounds 983.5 to 984. Raw interval matches `bootstrapMedianCI` default seed 7 (`scripts/hashline-gate-stats.mjs:48`) |
| wall median diff ms | 2419.5 | 2420 | `toFixed(0)` |
| wall 95% bootstrap, seed 1, 5000 | [1161, 4275.5] | not printed | assigned seed |
| wall 95% bootstrap, seed 7, 5000 | [1124.5, 4239.5] | [1125, 4240] | print rounds both ends. Raw interval matches seed 7 |
| edit-errors diff sum | 49 | 49 | none |

Percentile indexes are `floor(0.025*5000)=125` and `floor(0.975*5000)=4875`, the module's rule, not a `(B+1)` quantile. Both seeds use that rule. The seed-1 and seed-7 intervals disagree in the upper tail. That is the RNG seed, not an arithmetic bug: recomputing seed 7 independently reproduces the module before rounding.

The module does not compute a sign test. The p-values below are this review only.

Per-task pass, wrong-write, and edit-error counts match the printed table exactly. Per-task token medians that are `x.5` are printed one higher by `toFixed(0)`. Those are display rounding, not different medians:

| task | exact median tokens replace / hashline | printed |
|---|---|---|
| crlf-report | 8669.5 / 10185 | 8670 / 10185 |
| dup-config-workers | 10887.5 / 12130.5 | 10888 / 12131 |
| dup-validators | 9319.5 / 10472.5 | 9320 / 10473 |
| mixed-eol-ledger | 9653.5 / 11007 | 9654 / 11007 |
| move-formatter | 11159 / 11661.5 | 11159 / 11662 |
| stale-content-shipping | 8857 / 14770.5 | 8857 / 14771 |

The other five tasks print the exact integer median.

## 2. Sample structure

220 JSONL records. No structural anomaly.

- 11 tasks × 2 modes × repeats 1..10. Every `(task, mode)` cell has exactly those 10 repeats.
- 110 `(task, repeat)` pairs, each with both modes. No incomplete pair, no pair collision.
- 220 distinct `runId`s. No duplicate.
- Every record has boolean `pass` and an array `violations`. Observed violation lengths are only 0, 1, and 6.
- Every `tokens`, `wallMs`, and `cost` is finite. `agentExit` is 0 on all 220. `timedOut` is false on all 220. `costBilled` is false on all 220.
- One run has `editCalls = 0`: `stale-content-shipping-hashline-r2`. It is also the only `pass: false` record.

## 3. Stale injection

Three stale tasks (`stale-clobber-inventory`, `stale-content-shipping`, `stale-shift-rates`), 60 records.

`stale.injected === false` on stale tasks: 1 record.

- `stale-shift-rates-replace-r1`: `stale.injected` false, `stale.editAfterInjection` false, `pass` true, `violations` length 1 (`lost: "SENTINEL-RATES"`). This run did not exercise the stale case. It is also one of the 11 wrong-write records.

Injected but no edit after injection: 1 record.

- `stale-content-shipping-hashline-r2`: `injected` true, `editAfterInjection` false, `editCalls` 0, `editErrors` 0, `pass` false, `violations` length 0, `tokens` 4739. This is the sole test failure and the reason the module's hashline stale row is `30 / 29` rather than `30 / 30`.

The other 58 stale records have `injected` true. All 29 injected replace records also have `editAfterInjection` true, which is why that row prints `29 / 29`.

Non-stale tasks have `stale.injected` false because the runner only injects when `task.stale` is set (`scripts/axiom-hashline-gate.mjs:180-186`). That is not a missed injection.

## 4. Hand check: tokens reconstructed from events

Definition used by the runner (`scripts/axiom-hashline-gate.mjs:114-120` and `:259`): sum `message.usage.totalTokens` over `message_end` events whose `message.role` is `assistant`. Event index is the 0-based line index in `events.jsonl`.

`mixed-eol-ledger-replace-r8` (JSONL `tokens` 11469). Six assistant `message_end` events:

| event index | line | `_tMs` | totalTokens |
|---|---|---|---|
| 26 | 27 | 2449 | 1147 |
| 55 | 56 | 3886 | 1792 |
| 82 | 83 | 5213 | 1931 |
| 130 | 131 | 6974 | 2124 |
| 152 | 153 | 8391 | 2172 |
| 191 | 192 | 9825 | 2303 |

Hand sum: 1147+1792=2939; +1931=4870; +2124=6994; +2172=9166; +2303=11469. Matches JSONL.

`mixed-eol-ledger-replace-r1` (JSONL `tokens` 11281): event indexes 38, 55, 80, 153, 174, 215 with totalTokens 1159, 1357, 1632, 2302, 2349, 2482. Hand sum: 1159+1357=2516; +1632=4148; +2302=6450; +2349=8799; +2482=11281. Matches. Input 3211 and output 262 also match the JSONL fields.

`mixed-eol-ledger-hashline-r1` (JSONL `tokens` 11650): event indexes 17, 49, 114, 135, 176 with totalTokens 1309, 2296, 2580, 2666, 2799. Hand sum: 1309+2296=3605; +2580=6185; +2666=8851; +2799=11650. Matches. Input 4317 and output 293 match.

Extra check, not required: the same reconstruction of `tokens`, `input`, `output`, `cost`, `editCalls`, and `editErrors` against `events.jsonl` for all 220 runIds found 0 mismatches. Edit counts used `tool_execution_end` with `toolName === "edit"` and `isError === true`, which is `measure` in `scripts/axiom-hashline-gate.mjs:146-155`.

## 5. Paired analysis

Pass discordance (1 pair): replace-only `stale-content-shipping` repeat 2 (`stale-content-shipping-replace-r2` passed, `stale-content-shipping-hashline-r2` did not). Hashline-only: 0. Concordant: 109 both-pass, 0 both-fail.

Exact two-sided sign test, binomial p=0.5, p-value = sum of point masses no larger than the observed mass. For n=1, k=0: both outcomes have probability 1/2, so p = 1. Doubled one-sided tail, capped at 1, is also 1. A single discordant pair cannot reject a fair coin. It is not informative.

Wrong-write discordance (11 pairs), all replace-only, hashline-only 0:

- `mixed-eol-ledger` repeats 1..10. Each has `violations.length === 6` and the same six `lost:` strings (first seen on `mixed-eol-ledger-replace-r8`). Hashline partner has length 0. All 10 passed their tests.
- `stale-shift-rates` repeat 1. Replace violation is `lost: "SENTINEL-RATES"`. This is the run that was not injected. Hashline partner is clean.

Two distinct violation payloads, not 11 different findings.

Sign test n=11, k=0 hashline-only. `binom(11,0)=binom(11,11)=1`, and every other coefficient is larger, so the two-sided probability mass is 2. `2^11 = 2048`. p = 2/2048 = 0.0009765625. The doubled lower tail is the same number. At the `(task, repeat)` unit, with an independence assumption, the wrong-write difference is significant at 0.05.

That assumption is false for a task-level claim. Ten of the eleven pairs are repeats of one task with an identical guard payload. Task-level discordant wrong-write tasks: 2 vs 0 (`mixed-eol-ledger`, `stale-shift-rates`). Exact sign test n=2, k=0: p = 2/4 = 0.5. Drop the uninjected `stale-shift-rates-replace-r1` and the task-level count is 1 vs 0, p = 1. The pair-level p-value does not support "hashline avoids wrong writes across tasks." It supports "on these 110 pairs, replace produced the wrong write 11 times and hashline never did, and 10 of those 11 are one task repeated."

Median of paired differences, even n, indexes 54 and 55 of the sorted 110 diffs (0-based):

- Tokens: 1671 and 1681, average 1676. Of 110 diffs: 83 positive, 27 negative, 0 zero.
- Wall ms: 2384 and 2455, average 2419.5. Of 110 diffs: 73 positive, 37 negative, 0 zero.

Seed-1 95% pair bootstrap intervals exclude 0: tokens [983.5, 3182], wall [1161, 4275.5]. Seed 7 also excludes 0. So does a task-cluster bootstrap (resample the 11 tasks with replacement, keep each task's 10 diffs, same percentile rule, seed 1): tokens [586, 4367], wall [251.5, 4733]. The cluster interval is a sensitivity check, not the assigned statistic.

Within-task median of the 10 paired diffs is positive for tokens on 9/11 tasks and for wall on 8/11 tasks. Exact sign tests at the task unit: tokens 9 vs 2, favorable mass 134, p = 134/2048 = 0.0654296875; wall 8 vs 3, favorable mass 464, p = 464/2048 = 0.2265625. Neither task-level sign test is significant at 0.05. The magnitude interval still excludes 0 under task resampling; the direction count does not clear 0.05.

## 6. What the data supports

Supported, at the unit stated:

- Structure is the planned 11×2×10 grid. 110 complete pairs. No duplicate runIds. `pass` and `violations` are present on every record.
- Replace passed its own tests on 110/110 runs. Hashline passed on 109/110. The miss is `stale-content-shipping-hashline-r2`.
- Wilson 95% intervals in the table above. Replace pass [96.6%, 100%] and hashline pass [95.0%, 99.8%] overlap. Wrong-write intervals [5.7%, 17.0%] and [0%, 3.4%] do not overlap. Pooled edit-success intervals [97.1%, 100%] and [66.0%, 78.9%] do not overlap. The edit-success interval treats 181 edit calls as independent Bernoulli trials. They are nested in runs (40 hashline runs had at least one edit error; 0 replace runs did) and in 5 tasks, so that interval is too narrow as a CI for a run-level or task-level rate.
- Pair-level exact sign test for wrong writes: p = 0.0009765625. Significant at 0.05 if pairs are the unit and are treated as independent.
- Hashline's successful edit count (132) is close to replace's (130). The rate gap is 49 extra failed edit calls, not fewer completed edits. Those 49 errors are on 40 runs in 5 tasks: `multihunk-stats` 17, `stale-shift-rates` 12, `stale-clobber-inventory` 10, `stale-content-shipping` 9, `rename-fetch` 1. Replace edit errors are 0.
- Paired median hashline−replace is +1676 tokens and +2419.5 ms. Assigned seed-1 95% bootstrap intervals exclude 0. A task-cluster bootstrap also excludes 0.
- JSONL `tokens` for the three named runs equals the assistant `message_end` sum. The same holds for all 220 runs.
- Dollar figures are estimates. `costBilled` is false on every record, matching the runner's `totalFromProvider !== true` flag (`scripts/axiom-hashline-gate.mjs:122`). Printed costs 0.0722 and 0.0877 are the 4-decimal rounding of 0.07216904 and 0.0876833.
- One stale-task run, `stale-shift-rates-replace-r1`, did not receive the injection.

## 7. What the data does not support

- A pass-rate difference. One discordant pair, sign-test p = 1. Wilson intervals overlap. Not informative.
- A cross-task wrong-write effect. Task-level sign test p = 0.5 (or p = 1 if the uninjected stale run is excluded). The pair-level p-value counts ten identical `mixed-eol-ledger` failures as ten trials.
- That the uninjected `stale-shift-rates-replace-r1` wrong write is evidence about stale-read behavior. The file was not mutated after a read.
- That hashline is cheaper or faster. Both point estimates and both bootstrap intervals go the other way.
- A task-level sign-test claim that hashline uses more tokens (p = 0.0654) or more wall time (p = 0.2266). The median-difference interval is the supported claim, not the 9-vs-2 direction count.
- A task-level sign-test claim that hashline has more edit errors: 5 tasks vs 0, p = 2/32 = 0.0625. The descriptive gap (0 vs 49 errors, 0 vs 40 runs) is real; n = 11 tasks is too small for that sign test to clear 0.05.
- Provider-billed spend. Every record has `costBilled: false`.
- That stale injection was universal. 1/60 stale records was not injected, and 1/60 was injected but never edited afterward.
- Anything about model intent. This review did not read assistant text for motive.

## 8. Open questions

- The module reports discordant counts and bootstrap intervals. It does not state a pre-registered unit, alpha, or sign test. Whether "significant" is the decision rule is outside this file. If the gate's unit was the task, the wrong-write result is not a significant sign test.
- `pass` was not re-derived by re-running task tests. `violations` were not re-derived by re-running guards. Both were taken from JSONL and, for violations, compared across records. Another review owns whether those fields match the workdirs.
- The pair bootstrap and the module both ignore within-task correlation. The cluster interval above still excludes 0, but it was not the module's procedure and was not the assigned seed-1 pair bootstrap.
