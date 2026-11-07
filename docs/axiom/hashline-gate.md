# P2 live-model gate: replace vs hashline

Roadmap issue [#1](https://github.com/Kiy-K/axiom/issues/1), phase P2, gate item: "improve edit success/retry or token/latency metrics over the existing Pi edit path without higher silent-corruption rate." This document records the real-model run that the mechanism benchmark in `hashline-contract.md` could not provide.

Runner: `scripts/axiom-hashline-gate.mjs` (`validate`, `run`, `summarize`). Statistics: `scripts/hashline-gate-stats.mjs`. Tasks and guards: `scripts/hashline-gate-tasks/tasks.mjs`. Raw trial records and per-run event logs are kept outside the repo in `/tmp/hashline-gate/` (paths in the results section).

## Question

Does `editMode: "hashline"` (opt-in) beat `editMode: "replace"` (default) on paired real coding tasks, without more wrong writes or task failures?

## Decision rule (predeclared before any live result was read)

Replace stays the default unless all of these hold:

1. **No wrong-write regression.** Hashline's wrong-write count is zero, and no more than replace's.
2. **No task regression.** Replace-only passes are not significantly more than hashline-only passes (two-sided exact sign test on discordant pairs, p ≥ 0.05, or hashline ahead).
3. **Clear benefit.** At least one of these holds with a paired 95% interval that excludes zero in hashline's favor: task pass rate (hashline-only minus replace-only discordance, shown as a count), median total tokens (lower), median wall time (lower). Exact edit success is reported but is not on its own a benefit: a stale refusal is an edit error that the model must repair.
4. **Consistent.** The benefit appears in at least two task categories, or the pooled effect holds with the per-category breakdown not reversing.

If (3) or (4) fails, the result is a null: keep replace and report the costs (for example extra read tokens and stale-retry turns). A null result is recorded as such; it is not a reason to change the rule.

## Verdict procedure: fix, then re-benchmark

Added after run 1 was read and before run 2 started. It binds run 2 onward; run 1's verdict stands as recorded and is not re-scored.

When a run shows a candidate with a promising or defective result traced to a specific cause in the candidate (a tool bug, a misleading instruction, an unhelpful error), the verdict waits:

1. Fix the cause in the candidate. Do not change the tasks, guards, or decision rule.
2. Rebuild the bundle and run `validate`.
3. Rerun the full paired gate with the same tasks, repeats, and decision rule. Both modes are rerun, so the baseline gets a new sample too.
4. Give the verdict from the rerun only. Report every run, including the pre-fix run, and name the fix between them.

A rerun with no change to the candidate is a variance check, not a fix, and is reported as one. If the rerun fails the rule, the result is a null; another fix needs another rerun before any verdict.

## Metrics (per trial)

| Metric | Definition |
|---|---|
| Task pass | The task's own `node --test` passes in the workdir after the agent stops. |
| Wrong write | The guard reports a violation: bytes the task must keep are lost or changed (sentinel lost, line endings changed, BOM removed, neighboring function rewritten, a renamed name that should not change). |
| Exact edit success | `(edit calls − edit errors) / edit calls`, pooled over runs. An edit error is a tool result with `isError`: stale tag, unknown ID, non-unique `oldText`, hash mismatch. |
| Retries | Edit errors per run. Every edit error costs at least one more model turn. |
| Total tokens | Sum of provider `usage.totalTokens` over assistant messages in the run. |
| Latency | Process wall time from spawn to exit. |
| Stale injected | For stale tasks, whether the runner's change happened after the agent's first read of the file, and whether an edit call came after it. |

Cost is recorded as the catalog estimate from provider usage; `openai-codex` bills against a ChatGPT plan, so it is not an invoice.

## Setup

- Model: `openai-codex`, `gpt-6-luna`. Temperature and seed are not controllable through this provider path; the provider default applies to every trial.
- Harness: the coding-agent bundle built from the working tree (`packages/coding-agent/dist/bundle/cli.js`) at HEAD `b7458ccf2` plus the uncommitted hashline changes. Both modes run the same bundle; the only difference is `editMode` in each trial's `settings.json`.
- Isolation: each trial has its own `HOME`, its own agent dir (copied `auth.json` and `models-store.json`, plus `settings.json`), and its own workdir. Trials run one at a time, so latency is not shared.
- Pairing: each task and repeat runs once in each mode. Pair order is shuffled (seed 1) and the mode order inside each pair is random.
- Budget: $5 estimated cap; the run stops before a trial once the estimate reaches it.
- The prompt does not mention hashline or replace; the model sees the same text in both modes.

## Stale-read injection

For stale tasks, the runner watches the JSON event stream. When the agent's first `read` of the target file succeeds, the runner rewrites the file (adding a comment block, or changing one line, or appending a block). The agent's next edit therefore runs against content it has already read. The sentinel string the change adds is what the guard checks, so a write that drops it is a wrong write.

Replace mode matches old text, so it can apply an edit to changed content if the old text still appears. Hashline checks the file tag and refuses. Both outcomes are measured, not assumed.

## Duplicate-block cases

Two tasks have identical lines in several functions: `dup-validators` (the same final `return` line in three validators) and `dup-config-workers` (the same three-line reader shape in four readers). Replace mode needs a unique `oldText`; hashline addresses lines by ID. The guard checks that the untouched copies are byte-identical to the fixture.

## Task set

Each task was validated with `node scripts/axiom-hashline-gate.mjs validate` (zero cost): the fixture fails its tests before, the oracle fix passes them after, the guard is clean on the fix, and a deliberately wrong write (the task's `corrupt` variant) is flagged by the guard.

| Task | Category | What it tests |
|---|---|---|
| `multihunk-stats` | multi-hunk | Five bugs in five separate functions; one correct function is protected |
| `dup-validators` | duplicate | Identical final `return` line in three functions; only one is wrong |
| `crlf-report` | line endings | All-CRLF file; a write that normalizes endings is a wrong write |
| `mixed-eol-ledger` | line endings | CRLF lines followed by LF lines; replace mode rewrites endings to the first one |
| `unicode-bom-greet` | encoding | BOM and non-ASCII strings must survive the edit |
| `rename-fetch` | multi-file | Rename across four files, but `getUserName` must keep its name |
| `move-formatter` | move | Move a function to a new module, keep its body |
| `stale-shift-rates` | stale | Runner prepends three comment lines after the first read; line numbers shift, text does not |
| `stale-content-shipping` | stale | Runner adds a trailing sentinel comment to the line being fixed |
| `stale-clobber-inventory` | stale | Runner appends an audit block after the first read; a rewrite from the stale view drops it |
| `dup-config-workers` | duplicate | Same reader shape in four functions; only one needs a clamp |

Wrong-write cases are the sentinel losses (stale tasks), the line-ending changes (`crlf-report`, `mixed-eol-ledger`), the BOM loss (`unicode-bom-greet`), the renamed neighbor (`rename-fetch`), the changed function body (`move-formatter`), and the edits to the wrong duplicate (`dup-validators`, `dup-config-workers`).

## Limits

- One model, one provider, one harness version. Results do not transfer to other models without a rerun.
- The stale change is injected by the runner, not by a concurrent process. The real race window (between an agent's check and its write) is not exercised, only the case where the file changed after the read.
- Eleven small fixtures in JavaScript. They do not cover large files, very long lines, binary data, or languages other than JavaScript.
- Per-task sample sizes are small (10 pairs). Pooled intervals are reported; per-task numbers are descriptive.
- Provider token counts are per request, so a retry's full context counts again. That is the intended cost of a retry.

## Results

Run: 220 trials, 11 tasks, 10 repeats per task and mode, sequential, seed 1. Estimated spend $0.16 on the catalog estimate. Zero timeouts, zero non-zero agent exits. Raw records: `docs/axiom/hashline-gate/results.jsonl`. Per-run event logs and workdirs: `/tmp/hashline-gate/artifacts/` (not committed, 32 MB).

| Metric | replace (default) | hashline (opt-in) |
|---|---|---|
| Task pass (own tests) | 110/110 = 100% [96.6, 100] | 109/110 = 99.1% [95.0, 99.8] |
| Wrong writes (guard) | 10/110 = 9.1% [5.0, 15.9] | 0/110 = 0% [0.0, 3.4] |
| Exact edit success | 130 edit calls, 0 errors = 100% [97.1, 100] | 181 edit calls, 49 errors = 72.9% [66.0, 78.9] |
| Retries (edit errors per run) | 0 | 0.45 |
| Total tokens, median (mean) | 9,620 (10,484) | 13,045 (13,451) |
| Wall time, median | 15.1 s | 17.4 s |
| Cost estimate | $0.072 | $0.088 |

Paired (110 task-repeat pairs), hashline minus replace:

- Task pass discordance: hashline-only 0, replace-only 1. Sign test p = 1.0.
- Wrong-write discordance: hashline-only 0, replace-only 10. All 10 are `mixed-eol-ledger` (see below).
- Tokens: median +1,676 [95% bootstrap +984, +3,479].
- Wall: median +2.4 s [+1.1, +4.2].
- Edit errors: +49 in hashline.

Per task (replace / hashline, out of 10):

| Task | Pass | Wrong writes | Edit errors (hashline) | Tokens median (replace / hashline) |
|---|---|---|---|---|
| multihunk-stats | 10 / 10 | 0 / 0 | 17 | 13,920 / 19,034 |
| dup-validators | 10 / 10 | 0 / 0 | 0 | 9,320 / 10,473 |
| dup-config-workers | 10 / 10 | 0 / 0 | 0 | 10,888 / 12,131 |
| move-formatter | 10 / 10 | 0 / 0 | 0 | 11,159 / 11,662 |
| crlf-report | 10 / 10 | 0 / 0 | 0 | 8,670 / 10,185 |
| unicode-bom-greet | 10 / 10 | 0 / 0 | 0 | 8,325 / 8,769 |
| rename-fetch | 10 / 10 | 0 / 0 | 1 | 12,567 / 14,057 |
| mixed-eol-ledger | 10 / 10 | **10 / 0** | 0 | 9,654 / 11,007 |
| stale-shift-rates | 10 / 10 | 0 / 0 | 12 | 9,323 / 15,217 |
| stale-content-shipping | 10 / 9 | 0 / 0 | 9 | 8,857 / 14,771 |
| stale-clobber-inventory | 10 / 10 | 0 / 0 | 10 | 11,741 / 15,891 |

### Correction to the runner's wrong-write count

The runner's summary reports replace wrong writes as 11, not 10. The 11th is `stale-shift-rates-replace-r1`, where the model read the file with `cat` through bash, so the runner's `read`-triggered injection never ran. The guard then checked for a sentinel that was never added. The runner now skips the sentinel guard when the injection did not happen (`scripts/axiom-hashline-gate.mjs`, `runOne`). The results file was produced before that fix and is unchanged; the numbers above exclude that run. The summary tool's printed numbers include it.

### Failures and independent review

Three fresh-context reviewers read the raw artifacts. Reports: `docs/axiom/hashline-gate/review-*.md`.

- **Wrong writes, replace, `mixed-eol-ledger` (10 of 10 runs): true wrong writes, caused by the tool.** All 10 replace edits wrote the same 336-byte CRLF rewrite. `detectLineEnding` (`edit-diff.ts`) reads the first newline as CRLF in a file whose first line ends in CRLF, and `edit.ts` restores that ending across the whole file. The model's `newText` used LF and changed only the arithmetic. Hashline kept the mixed endings in 10 of 10. The repo's own tests cover uniform CRLF, not mixed endings. This matches the mechanism benchmark in `hashline-contract.md`.
- **Hashline failure, `stale-content-shipping-hashline-r2`: model error.** The model read the file correctly, then stopped without an edit (`stopReason: stop`), and said it would change the condition. Tests failed. The replace run on the same task passed. Single failure; not a hashline mechanism.
- **Hashline edit errors, 49 in 40 runs: 29 are the forced stale refusal, 19 are malformed IDs, 1 is a stale call before any read.** Of the 29 stale refusals, all come from the harness's change after the first read; 0 come from the tag changing after the model's own successful edit. Of the 19 malformed IDs, 8 were composed (`6#e4`) and 11 were bare (`e4`, `N#e4`); the tool text and the error message both invite these: the model-visible instruction says `N#HH`, and the message does not name the lines that carry the hash. All 40 runs still passed.
- **Stale cases, replace: 29 of 29 injected runs were clean.** The model's edit text still matched, and the sentinel survived every time. The stale hazard the design targets did not occur in replace mode on these fixtures; hashline's refusal prevented nothing measurable here, and it cost a retry.
- **Statistics:** an independent recompute matched the module's point estimates. The wrong-write sign test (p ≈ 0.001 at pair level) is driven by one task: the 10 discordant pairs are repeats of `mixed-eol-ledger`, so they are not independent at the task level. Report: `review-statistics.md`.

### Decision (predeclared rule)

1. No wrong-write regression: **met.** Hashline 0, replace 10.
2. No task regression: **met.** Pass discordance 0 vs 1; not significant.
3. Clear benefit in task pass, tokens, or wall time: **not met.** Pass is equal within noise; tokens and wall are higher with intervals that exclude zero.
4. Consistency: not evaluated, because 3 failed.

**Replace stays the default. Hashline stays opt-in.**

The rule did not list wrong-write reduction as a benefit criterion, and it is the one real advantage hashline shows. That advantage is concentrated in one defect: replace-mode line-ending restoration on mixed-ending files. The tool can fix that directly, without switching edit modes. It is not tested here; the claim that it would remove the difference is an [INFERENCE] from the mechanism.

The P2 gate item in issue #1 says "improve edit success/retry or token/latency metrics over the existing Pi edit path without higher silent-corruption rate." Corruption is not higher. Edit success, retries, tokens, and latency are all worse. **The P2 live gate is not passed.** The item stays unchecked. I have not modified the issue.

### Recommended next steps (not started; need your approval)

1. **Replace mode: fix mixed-ending preservation.** Change `detectLineEnding`/`restoreLineEndings` so a file's existing endings are kept line by line, not rewritten. Add the mixed-ending case to the repo tests. Then rerun the `mixed-eol-ledger` pair. This changes replace-mode behavior, so it needs approval.
2. **Hashline: fix the ID instructions and error text.** Stop showing a literal `N`, and when an ID is not a line ID, name the shown lines that carry that hash. The review attributes most non-stale errors to these two things.
3. **Re-gate hashline after 1 and 2.** Add more tasks where replace mode can fail: duplicate blocks whose `oldText` is not unique, and stale changes that alter the matched text. Two of the current fixtures that were meant to be hard (`dup-validators`, `dup-config-workers`) passed in both modes.

### Limits

- One model (`gpt-6-luna` via `openai-codex`), one harness version, eleven JavaScript fixtures. Results do not transfer to other models or languages.
- The wrong-write evidence is one task family. The difference is real in that family and absent in the other ten.
- The stale case is a runner-triggered change after a read, not a concurrent process. The race window between the tool's check and its rename is not exercised.
- Reviewer spend (three read-only reviewers) was roughly $3 by the agent status lines. That is not an invoice.

## Run 2: after the hint and instruction fix

Change under test: hashline's model-visible instructions no longer show a literal `N#HH`; a bare or `N#`-prefixed hash is answered with the shown lines that carry that hash (`packages/coding-agent/src/core/tools/hashline.ts`, `checkedLine`). Tasks, guards, seed, and decision rule are unchanged. Both modes were rerun. Raw records: `docs/axiom/hashline-gate/results-v2.jsonl`. Run 1 is kept above and is not re-scored.

| Metric | replace | hashline |
|---|---|---|
| Task pass | 110/110 = 100% [96.6, 100] | 110/110 = 100% [96.6, 100] |
| Wrong writes (guard) | 10/110 = 9.1% [5.0, 15.9] | 0/110 = 0% [0.0, 3.4] |
| Exact edit success | 131 calls, 0 errors = 100% [97.2, 100] | 157 calls, 25 errors = 84.1% [77.5, 89.0] |
| Retries (edit errors per run) | 0 | 0.23 |
| Total tokens, median (mean) | 9,353 (10,159) | 13,074 (13,209) |
| Wall time, median | 15.1 s | 16.8 s |
| Cost estimate | $0.072 | $0.088 |

Paired, hashline minus replace:

- Task pass discordance: 0 and 0.
- Wrong-write discordance: hashline-only 0, replace-only 10 (all `mixed-eol-ledger`).
- Tokens: median +2,835 [95% bootstrap +2,183, +3,131].
- Wall: median +1.8 s [+0.4, +2.6].
- Edit errors: 25, all of them stale-tag refusals.

What the fix changed. Run 1 had 49 hashline edit errors. Of these, 20 were not stale refusals: 19 malformed or composed IDs (11 bare hashes such as `e4` or `N#e4`, and 8 composed IDs such as `6#e4` whose hash did not match that line) and 1 placeholder tag. Run 2 has 0 malformed-ID, 0 composed-ID, and 0 shown-ledger refusals. All 25 remaining errors are the runner-injected stale-tag refusal, one per stale run, in `stale-clobber-inventory` (5), `stale-content-shipping` (10), and `stale-shift-rates` (10). The classification was a throwaway scan of the run's `events.jsonl` (`/tmp/hashline-gate/classify-v2.mjs`), counting runs that contain each message.

The fix removed the non-stale errors. It did not close the gap. The median token cost of hashline stayed at about 13,000 in both runs (13,045 and 13,074); the gap in run 2 is wider because the replace median fell from 9,620 to 9,353. Both runs' token and wall intervals exclude zero in replace's favor. Per task (run 2, median tokens), the two largest gaps are on stale tasks: `stale-content-shipping` 8,941 vs 15,115 and `stale-shift-rates` 9,353 vs 13,491, where a refusal costs a re-read and a retry turn. Non-stale tasks also cost more: `rename-fetch` +3,520, `move-formatter` +3,155, and `multihunk-stats` +781 (smallest).

### Verdict (predeclared rule, applied to the rerun only)

1. No wrong-write regression: **met.** Hashline 0, replace 10.
2. No task regression: **met.** Discordance 0 and 0.
3. Clear benefit: **not met.** Task pass is equal. Tokens and wall time are higher, with intervals that exclude zero in replace's favor. Edit success is lower.
4. Consistency: not evaluated.

**Result: null. Replace stays the default. Hashline stays opt-in.**

The fix did what it was meant to do: the non-stale edit errors went from 20 to 0, and the malformed-ID guidance is no longer a cost. The remaining cost is the stale-tag refusal, which is the designed protection working on a change the runner injected. On these fixtures that protection prevented no corruption: replace mode kept the sentinel in all 30 injected runs as well.

### Replace-mode defect (separate)

Replace still rewrites a mixed-ending file to the first ending it finds in `mixed-eol-ledger`: 10 of 10 runs in run 1 and 10 of 10 in run 2. This is the only source of the wrong-write difference, and it is not a hashline result. Fixing it in replace mode is a separate change that needs approval; it is not tested here.

### Next options (need approval; each needs another paired rerun before any verdict)

1. Reduce the stale-refusal cost: when the tag is stale, return the current lines with their IDs in the error, so the retry needs no separate `read`. This targets the cost that remains; it is a new fix, so the rerun rule applies.
2. Fix replace-mode mixed-ending preservation, then rerun to see whether the 10 wrong writes disappear.

## Iteration 3: stale-recovery feedback, holdout, frozen baseline

Written after the run 2 diagnosis and before the change, so the criteria below bind this iteration.

### Diagnosis (run 2 traces)

Scripts: `/tmp/hashline-gate/diagnose.mjs`, `calls.mjs`, `sequence.mjs` (throwaway, not in the repo). Pooled medians, hashline vs replace:

- Assistant turns 6 vs 5. Tokens 13,074 vs 9,353. Tokens per turn 2,054 vs 1,758.
- Read output 1,109 vs 774 chars (IDs on every line). Edit success text 201 vs 50 chars (the shown lines after an edit). Edit arguments 182 vs 189 chars.
- Stale refusals: 25 of 110 hashline runs had exactly one, and each was followed by at least one more turn. The turns after the error cost a median 4,484 to 9,948 tokens in those tasks.
- Non-stale tasks (80 runs, no errors): hashline makes more calls. Reads 1.99 vs 1.82 per run, bash 2.54 vs 2.36 per run, edits equal at 1.26. The cause is not established; [INFERENCE] the larger read output invites more inspection.
- Each turn resends the transcript, so tool-result characters are paid again in every later turn. The read output and success text are the carried overhead.
- All 25 hashline exact-edit failures are the stale-tag refusal. There are no other edit errors.

Not addressed in this iteration: the ID text in read output (+43 percent characters) and the shown lines after an edit. Both are the format and would need their own gate.

### Change under test

The stale-tag refusal returns, in the error, the current file tag and the lines around the refused call's target: 20 lines starting two above the target line from the first edit's start ID, clipped to the file. Those lines are recorded as shown under the current tag, so the next call may use their IDs. The refusal writes nothing. The fail-closed checks do not change: tag match at the write, hash match per ID, shown-under-tag ledger, atomic rename with a change check.

### Sets

- **Dev (tuning):** the 11 tasks in `hashline-gate-tasks/tasks.mjs`. Used for diagnosis and tuning. Not evidence of a benefit.
- **Holdout (confirmatory):** 6 tasks in `hashline-gate-tasks/holdout.mjs`, sha256 `75fdff4cc96c05102e9a5d9edc512d8760b7ff863fa9d7c43c6704bb764761b0`, written before the change and never used for tuning. They cover stale sentinels (price, log append), a duplicate different from the dev set, mixed endings in the other direction, a BOM with a Unicode title, and a cross-file rename with a prefix-named neighbor. Validation (fixtures against oracle and corrupt, no live run) passed on this file. Any later edit to it voids the holdout run.
- **Frozen baseline:** the 6 bugfix tasks from the P0 set `scripts/baseline-tasks/tasks.mjs`, run through the gate for task pass, tokens, wall time, and edit errors. They have no wrong-write guard, so their wrong-write count is not measured.

### Predeclared criteria

The confirmatory set is holdout. Dev and frozen are reported, not used for the verdict. Promotion requires all five:

1. Holdout wrong writes: hashline no more than replace, and 0 for hashline on the stale holdout tasks.
2. Holdout task pass: replace-only passes not significantly more than hashline-only (exact sign test p ≥ 0.05, or hashline ahead).
3. Holdout benefit: median tokens or median wall time lower for hashline, with a paired 95 percent bootstrap interval excluding zero in hashline's favor.
4. Generalization: the direction of the token or wall effect on dev matches holdout.
5. Frozen baseline: hashline's task pass not below replace's.

If criterion 3 fails, the result is null: replace stays the default. If all five hold, promotion is the next step: the `edit` tool name runs the hashline implementation by default. Replacing the replace-mode code removes the mixed-ending defect with it, which is a separate decision and needs the user's confirmation before the code is removed.

The replace-mode mixed-ending defect is not fixed in this iteration.

### Run plan (fixed before the live runs)

- Candidate: stale-recovery change in `hashline-edit.ts` (RECOVERY_LINES = 20); replace path unchanged.
- Order: holdout (confirmatory), then frozen baseline, then dev. Sequential, one trial at a time, so latency is not shared. Seed 1 for all three.
- Repeats: holdout 10 per task and mode (120 trials), dev 10 (220 trials), frozen 5 (60 trials).
- Budget cap: $5 per set, catalog estimate.
- Artifacts: `/tmp/hashline-gate/v3/` (not committed); raw records copied to `docs/axiom/hashline-gate/` afterward.

### Holdout result (confirmatory, 120 trials, seed 1)

Records: `docs/axiom/hashline-gate/results-v3-holdout.jsonl`.

| metric | replace | hashline |
|---|---|---|
| task pass | 60/60 | 60/60 |
| wrong writes (guard) | 10/60 | 0/60 |
| edit errors | 0 | 30 |
| exact edit success | 100.0% | 73.7% [64.9%, 80.9%] |
| tokens median | 9,106 | 12,575 |
| wall median | 14.9 s | 16.2 s |

Paired hashline minus replace: tokens +3,061 [2,428, 4,513]; wall +1,426 ms [513, 2,650].

Criteria: (1) pass, wrong writes 0 vs 10, 0 on stale holdout tasks. (2) pass, zero discordant task pairs. (3) FAIL, tokens and wall higher for hashline, CI excludes zero in replace's favour.

Verdict: null. Replace stays the default. Promotion not performed.

Edit-error breakdown (hashline):
- Stale refusals: 20 of 20 stale runs refused once (`stale-log-append` 10, `stale-price` 10). The recovery window works, but every stale run still pays one refused edit and one retry turn.
- Non-stale: `bom-title` 6 hash mismatches (`start 2#8c does not match`; the model used a hash the current line does not have, outside the stale path). `rename-settings` 2 edits sent an empty tag (`you sent `), plus 2 stale refusals.

Not reported: the frozen baseline and dev reruns were stopped after 12 frozen trials. The holdout verdict is decided by criterion 3, so neither can change it. Their partial records are not used.

Stale recovery therefore did not close the gap. [INFERENCE] The token cost comes from the larger read output and the extra retry turns; the holdout run did not isolate these, and the stale-refusal count is the same as before the change.

## Iteration 4: non-stale ID/tag fixes, replace EOL fix, correctness-first holdout v2

P2 verdict stays null (Iteration 3). This iteration does not change any default.

### Diagnosis of the v3 holdout non-stale errors

Traces: `/tmp/hashline-gate/v3/artifacts-holdout/` (throwaway script `/tmp/hashline-gate/diag-v3.mjs`).

- `bom-title` (6 errors): the model kept the line number and copied the hash of the next line. Line 2 is `2#1d`; it sent `2#8c`, which is line 3's ID (`3#8c`). Each time the tool refused, then the model re-read (one extra turn) before retrying. No wrong write.
- `rename-settings` (4 errors): the model sent an edit with an empty tag and no edits to `src/app.js` and `src/worker.js` before reading them. The stale branch then returned file lines as its "retry" output and the message said `you sent ` with nothing after it. These are not stale refusals.
- Stale refusals (20 of 20 stale runs): unchanged, one per run, as expected.
- `bom-title` also had a regex escape error in the model's code (`\\p{L}` written double-escaped). That is a model code error caught by the tests, not a hashline failure.

### Changes

- `hashline.ts` `checkedLine`: when a sent hash does not match the named line but matches another line the model was shown under the same tag, the refusal names that line: `Hash 8c is the ID of line 3 (3#8c), not line 2.` The validation is unchanged: the edit is still refused. The hint discloses only lines already shown under this tag.
- `hashline-edit.ts`: an empty tag is refused before the stale branch with `no file tag was sent. Read the file first`. It returns no file lines, so the empty tag is no longer a read side channel. Writes stay refused.
- `edit-diff.ts` `restoreLineEndings(original, newNormalized)` replaces the first-line rule. Each line that survives keeps its exact original ending (`\r\n`, `\n`, or `\r`). An added line takes the ending of the nearest kept line above it, or the file's first ending. `detectLineEnding` is removed (no other caller). `edit.ts` passes the original content.
- Tests: `hashline-tools.test.ts` (owner-line hint; empty tag), `tools.test.ts` (three mixed-ending replace cases: LF-first, CRLF-first, inserted line). The mixed-ending cases are expected to fail on the previous code; this was reasoned from the old `restoreLineEndings`, not re-run on the old code.
- Test result: `hashline.test.ts`, `hashline-tools.test.ts`, `tools.test.ts`, `suite/agent-session-hashline-edit.test.ts`: 168/168. `bun run check`: exit 0.

### Holdout v2 (new, frozen before the run)

- File: `scripts/hashline-gate-tasks/holdout-v2.mjs`, sha256 `6ac95633af4cfed567e6293729c422ab98ecd353387349996baf81988968355d`.
- Holdout v1 unchanged: sha256 `75fdff4c…`.
- Six tasks: `v2-mixed-eol-grid` (CRLF first line, LF rest; replace must keep each ending), `v2-stale-slot-index` (stale), `v2-near-duplicate-fees` (adjacent identical lines; tests the owner-line hint), `v2-two-files-count` (two files, empty-tag probe case), `v2-bom-crlf-config` (BOM plus CRLF), `v2-no-final-newline`.
- All six validate (fails before, passes after, guard clean, corrupt flagged).

### Predeclared correctness-first criteria (fixed before the run)

Confirmatory set: holdout v2 only, 10 repeats per task and mode, seed 1, 120 trials.

- K1 (blocking) correctness: wrong writes 0 in both modes on all six tasks. Replace must now be 0 on `v2-mixed-eol-grid` and `v2-bom-crlf-config`.
- K2 (blocking) task pass: exact sign test on discordant pairs; fail if replace-only passes exceed hashline-only passes with p < 0.05.
- K3 (blocking) non-stale ID/tag errors: share of hashline runs with at least one non-stale ID/tag error (hash mismatch, empty tag, not a line ID) at most 10%; Wilson 95% CI reported.
- K4 (blocking) replace compatibility: replace task pass at least 95% on holdout v2.
- K5 (reported, not gating): tokens and wall, paired medians with bootstrap 95% CI. A default change still requires an explicit user decision even if K1-K4 pass.

Verdict rule: gate passes iff K1-K4 hold. A pass makes hashline eligible for promotion; defaults stay unchanged until the user approves. A failure keeps replace as default and the reason is recorded.

Run plan: `node scripts/axiom-hashline-gate.mjs run --task-set holdout-v2 --repeats 10 --budget 5 --seed 1` after `bun run build`. Clean run wrote to `/home/khoi/.cache/hashline-gate/v4/` (the first attempt in `/tmp` aborted, see the result below). Verdict from the clean run only.

### Holdout v2 result (clean run, 120 trials, seed 1)

Records: `docs/axiom/hashline-gate/results-v4-holdout-v2.jsonl`.

A first run aborted at trial 111 with `EDQUOT` writing an artifact (`/tmp` is a shared tmpfs). Its 110 records are not used. The full set was rerun to `/home` with the same task set, freeze hash, seed, and repeats.

| metric | replace | hashline |
|---|---|---|
| task pass | 59/60 | 60/60 |
| wrong writes (guard) | 0/60 | 0/60 |
| non-stale ID/tag errors | 0 | 0 |
| edit errors (all stale) | 0 | 10 |
| tokens median | 8,413 | 9,838 |
| wall median | 12.9 s | 14.8 s |

Paired hashline minus replace: task-pass discordance hashline-only 1, replace-only 0; tokens +1,627 [1,236, 2,503]; wall +1,095 ms [463, 2,071]. Cost estimate $0.034 replace, $0.038 hashline.

Criteria:
- K1 wrong writes: PASS (0 both). No run used the whole-file `write` tool in either mode.
- K2 task pass: PASS (hashline ahead by one discordant pair; replace-only 0).
- K3 non-stale ID/tag errors: PASS (0 of 60 hashline runs; the 10 hashline errors are all on the stale task).
- K4 replace compatibility: PASS (59/60 = 98.3%, threshold 95%). The one replace failure made no edit and claimed the tests should pass.
- K5 (reported): tokens +19% median, wall +7%.

Gate verdict: revised gate PASSES (K1-K4). Per the ADR, hashline is eligible for promotion; defaults are unchanged pending explicit user approval.

Caveats:
- `v2-near-duplicate-fees` was designed to exercise the owner-line hint, so it is not an independent test of that fix.
- The aborted run's anomalies did not recur in the clean run: two replace BOM refusals with 0 edits (model misjudged the BOM as blocking the match; `edit.ts` strips BOM before matching) and one replace whole-file `write` that added a final newline. These are model behaviour; they are recorded, not hidden.
- One model, six new tasks, 10 repeats, runner-injected stale change, catalog-estimate cost.

### Default decision

The user approved hashline as the default after the Iteration 4 verdict. `editMode` now defaults to `"hashline"` (`settings-defaults.ts`, schema, `docs/settings.md`, CHANGELOG `[Unreleased] ### Changed`). Replace remains selectable with `editMode: "replace"`. The replace-mode code is not removed.

This changes the default for every user. The measured cost is in the holdout v2 section above (tokens +19% median; correctness criteria K1-K4 passed).

### Gate hardening (after the v4 run)

Found by an isolated read-only review (Claude, see session log). Fixed in `scripts/axiom-hashline-gate.mjs`:

- The bugfix verdict ran the task's tests in an agent-writable directory. `verify` now restores the task's `test/` files from the task definition first, so an agent that edits, adds, or deletes tests cannot change the result. Each trial records `testsTampered`.
- Zero tests is now a failure. Previously `node --test` with no tests exited 0.
- The verdict helpers are exported and covered by `scripts/axiom-hashline-gate.test.mjs` (6 tests, run by `test:scripts`).

Re-verification: all 120 v4 trials were re-verified with the hardened `verify` from their saved work directories. Every `pass` value is unchanged, and no trial modified `test/`. The v4 verdict stands.

Holdout v2 task file unchanged (sha256 6ac95633...). The v4 records and the verdict are not rerun.
