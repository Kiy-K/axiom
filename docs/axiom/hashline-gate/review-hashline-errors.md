# Hashline edit errors — independent review

Verdict: of the 49 hashline edit errors, 29 (59.2%) are the harness stale-tag refusal after injection, and 0 (0%) are the tool changing the tag after the model's own successful edit. The other 20 are the model sending an ID the tool's `N#HH` parser rejects, or (one call) a placeholder tag before any read. All 40 error runs still passed the task tests.

Checked against the event streams, not the summary. 110 hashline `events.jsonl` files contain 181 `tool_execution_end` with `toolName: "edit"`; 49 have `isError: true`, in 40 runs. That matches `results.jsonl` `editErrors` on every run (zero mismatches) and `results.jsonl.summary.json` `hashline.editErrors: 49`, `editCalls: 181`.

## Classification rule

Applied in this order to each `tool_execution_end` where `toolName` is `edit` and `isError` is true. The error text is the `result.content[].text` of that event. The arguments are the matching `tool_execution_start` (`toolCallId`).

1. **Stale tag after the runner's injected change.** Error text contains `changed since it was read`. The edit `tool_execution_start` index is after the first successful `read` of the task's `stale.path` (the runner injects on that read's end: `scripts/axiom-hashline-gate.mjs:184-186`, `injection.eventIndex = events.length` after the push, so the write sits between that read end and the next event). No earlier successful edit of that path in the run. Sent tag equals `fileTag` of the fixture bytes; the error's `file tag is now` equals `fileTag` of `task.stale.mutate(fixture)`. `fileTag` is SHA-256 of the raw bytes, first 8 hex chars (`packages/coding-agent/src/core/tools/hashline.ts:38-39`).
2. **Stale tag after the model's own earlier successful edit.** Same error text, and a successful edit of that path precedes this call, and the sent tag is not the post-injection tag from rule 1.
3. **Stale tag with no injection and no own earlier edit.** Same error text, `stale.injected` is false, and no successful edit of that path precedes the call.
4. **ID or hash mismatch (line changed since the tag shown).** Error text contains `does not match the current content`. Used only if the file tag on the call is not the tag from the last read (the line actually changed under the tag the model was shown).
5. **Shown-line ledger refusal.** Error text contains `was not shown to you under the current file tag` (`hashline.ts:128-131`).
6. **Other.** Everything else the tool rejected: not a line ID, schema, empty text, overlapping ranges.

Rule 4 matched nothing. The eight `does not match` errors are recorded below as **composed ID**, not as rule 4: the tag on the call was still the read's tag, so the line had not changed. The model attached a hash to the wrong line number. That is model-composed text the tool rejected, closer to rule 6, but kept as its own row because the error text is the hash check.

Tag check runs before ID check (`hashline-edit.ts:147-163` compares `input.tag` to `fileTag(original)`, then `applyHashlineEdits` calls `checkedLine`). A call with both a stale tag and a bad ID is classified by the error that was returned (rule 1), and the bad ID is noted.

## Category counts

| Category | Errors | Runs |
|---|---:|---:|
| Stale tag after harness injection | 29 | 29 |
| Stale tag after the model's own edit | 0 | 0 |
| Stale tag, no injection, no own edit | 1 | 1 |
| ID/hash mismatch because the line changed | 0 | 0 |
| Composed ID (hash does not match that line; file tag unchanged) | 8 | 8 |
| Shown-line ledger refusal | 0 | 0 |
| Other: not a line ID | 11 | 11 |
| Other: schema, empty text, overlap | 0 | 0 |
| **Total** | **49** | **40 runs; 8 runs have 2 errors, 1 run has 3** |

Share, as asked: **29/49 (59.2%) are a direct consequence of the harness injection. 0/49 (0%) come from the tag changing after the model's own edit.**

Narrower injection share: 26 of those 29 sent well-formed `N#HH` IDs taken from the pre-injection read, so the refusal is only the injected write. The other 3 were refused on the stale tag but the IDs were already illegal, so a refusal was likely even without the injection (`stale-clobber-inventory-hashline-r6`, `stale-clobber-inventory-hashline-r9`, `stale-shift-rates-hashline-r5`). Counting only the 26: **26/49 (53.1%)** would not have fired without the harness write.

## Task x category

| Task | Runs with errors | Injection stale | Not a line ID | Composed hash mismatch | Placeholder tag | Errors |
|---|---:|---:|---:|---:|---:|---:|
| stale-clobber-inventory | 10 | 10 | 0 | 0 | 0 | 10 |
| stale-content-shipping | 9 | 9 | 0 | 0 | 0 | 9 |
| stale-shift-rates | 10 | 10 | 1 | 1 | 0 | 12 |
| multihunk-stats | 10 | 0 | 10 | 7 | 0 | 17 |
| rename-fetch | 1 | 0 | 0 | 0 | 1 | 1 |
| other 6 tasks | 0 | 0 | 0 | 0 | 0 | 0 |

`stale-content-shipping-hashline-r2` is the shipping run with no edit error: `editCalls: 0`, `stale.injected: true`, `editAfterInjection: false`, `pass: false`, `toolCalls: {bash: 1, read: 1}`, `tokens: 4739` (`results.jsonl`). It never called edit, so it is not in the 49. That is why shipping has 9 injection errors, not 10, and why the summary's `staleEditAfter: 29` equals the 29 injection-error runs (30 injected runs minus this one).

## What the tool actually said

Injection, inventory (10 runs, identical text). Example `stale-clobber-inventory-hashline-r3` end index 178, `_tMs` 17425:

> src/inventory.js changed since it was read (file tag is now 6194a705, you sent 00048b15), possibly by an earlier call in this turn. Nothing was written. Re-read the file and edit with the new tag and IDs.

Shipping, 9 runs, same sentence with `src/shipping.js`, now `96bb7911`, sent `3c00f626`. Rates, 10 runs, `src/rates.js`, now `3e255ccd`, sent `3a159f7e`.

Those three "now" tags are `fileTag(mutate(fixture))`, and the three "sent" tags are `fileTag(fixture)`, computed from `scripts/hashline-gate-tasks/tasks.mjs` (`stale-shift-rates` mutate prepends three comment lines at lines 441-444; shipping replace at 481-484; inventory append at 520-523). Every one of the 29 had a prior successful read of that path whose first line was `[file tag <sent tag>]`, and the edit start index was after that read end. No successful edit of that path preceded the call.

Not a line ID (`hashline.ts:114`), three wordings:

- `start "e4" is not a line ID. Send only the N#HH part shown by read, for example 12#a7.` — 8 calls
- `start "N#e4" is not a line ID. Send only the N#HH part shown by read, for example 12#a7.` — 2 calls
- `start "N#1d" is not a line ID. Send only the N#HH part shown by read, for example 12#a7.` — 1 call

`LINE_ID` is `/^(0|[1-9]\d*)#([0-9a-f]{2})$/` (`hashline.ts:31`). `e4` has no `#`. `N#e4` fails because `N` is not a line number.

Composed mismatch (`hashline.ts:124-125`):

- `start 6#e4 does not match the current content of line 6. Current line: 6#32|function mean(xs) {. Re-read the file.` — 7 calls, all `multihunk-stats`, all still on tag `89574289`
- `start 7#1d does not match the current content of line 7. Current line: 7#99|function taxFor(amount) {. Re-read the file.` — `stale-shift-rates-hashline-r5` end index 285, tag `3e255ccd` (the injected tag, so the tag check had already passed)

Placeholder, `rename-fetch-hashline-r3` end index 90, `_tMs` 4221:

> src/users.js changed since it was read (file tag is now 20b25d8a, you sent N/A), possibly by an earlier call in this turn. Nothing was written. Re-read the file and edit with the new tag and IDs.

Arguments: `{"path":"src/users.js","tag":"N/A","edits":[]}`. No read of `src/users.js` before this call. The next read of it (end index 111) starts `[file tag 20b25d8a]`. Fixture `fileTag` of `tasks.mjs` `rename-fetch` `src/users.js` is `20b25d8a`. The file was not changed. The message's "changed since it was read" and "possibly by an earlier call" are both false for this call.

## Error-run list

`dTok` is this run's `results.jsonl` `tokens` minus the replace run with the same task and repeat. `extra` is assistant `message_end` events after the first error end and before the next successful edit's start (or end of stream). Event index is the `tool_execution_end` index in that run's `events.jsonl`.

### Injection stale tag (29)

Path and the uniform error text are as above. Arguments that matter are `tag` (always the pre-injection tag) and `edits[].start`/`end`.

| runId | end# | _tMs | sent tag | IDs (op:start[-end]) | read end# | extra | dTok |
|---|---:|---:|---|---|---:|---:|---:|
| stale-clobber-inventory-hashline-r1 | 263 | 10636 | 00048b15 | replace:4#91-8#1d, insert_after:12#a5, replace:14#19 | 65 | 2 | 1606 |
| stale-clobber-inventory-hashline-r2 | 230 | 9734 | 00048b15 | replace:4#91-8#1d, insert_after:12#a5, replace:14#19 | 54 | 2 | 4670 |
| stale-clobber-inventory-hashline-r3 | 178 | 17425 | 00048b15 | replace:5#07-6#e8, insert_after:8#1d | 53 | 2 | 6225 |
| stale-clobber-inventory-hashline-r4 | 210 | 8111 | 00048b15 | replace:6#e8, insert_after:13#ee, replace:14#19 | 53 | 2 | 8661 |
| stale-clobber-inventory-hashline-r5 | 236 | 12694 | 00048b15 | replace:4#91-8#1d, replace:14#19 | 56 | 2 | 118 |
| stale-clobber-inventory-hashline-r6 | 129 | 7704 | 00048b15 | replace:07, insert_after:0d3 | 52 | 2 | -4023 |
| stale-clobber-inventory-hashline-r7 | 263 | 15266 | 00048b15 | replace:4#91-8#1d, insert_after:12#a5, replace:14#19 | 53 | 2 | -4221 |
| stale-clobber-inventory-hashline-r8 | 197 | 10353 | 00048b15 | replace:5#07-6#e8, insert_after:12#a5 | 57 | 2 | 9390 |
| stale-clobber-inventory-hashline-r9 | 130 | 6776 | 00048b15 | replace:07, insert_after:8a | 55 | 2 | 212 |
| stale-clobber-inventory-hashline-r10 | 171 | 9720 | 00048b15 | replace:6#e8, replace:14#19 | 52 | 2 | 7679 |
| stale-content-shipping-hashline-r1 | 114 | 7692 | 3c00f626 | replace:5#eb | 46 | 2 | 6343 |
| stale-content-shipping-hashline-r3 | 114 | 10450 | 3c00f626 | replace:5#eb | 46 | 2 | 5647 |
| stale-content-shipping-hashline-r4 | 148 | 8794 | 3c00f626 | replace:5#eb | 52 | 2 | 5434 |
| stale-content-shipping-hashline-r5 | 126 | 10670 | 3c00f626 | replace:5#eb | 54 | 2 | 2226 |
| stale-content-shipping-hashline-r6 | 114 | 6653 | 3c00f626 | replace:5#eb | 46 | 2 | 5695 |
| stale-content-shipping-hashline-r7 | 123 | 6544 | 3c00f626 | replace:5#eb | 47 | 2 | 9155 |
| stale-content-shipping-hashline-r8 | 133 | 7187 | 3c00f626 | replace:5#eb | 61 | 2 | 7493 |
| stale-content-shipping-hashline-r9 | 120 | 6965 | 3c00f626 | replace:5#eb | 41 | 2 | 6225 |
| stale-content-shipping-hashline-r10 | 125 | 6777 | 3c00f626 | replace:5#eb | 46 | 2 | 12295 |
| stale-shift-rates-hashline-r1 | 162 | 11351 | 3a159f7e | replace:5#f0 | 63 | 2 | 7611 |
| stale-shift-rates-hashline-r2 | 127 | 7474 | 3a159f7e | replace:5#f0 | 25 | 2 | 6865 |
| stale-shift-rates-hashline-r3 | 131 | 6888 | 3a159f7e | replace:4#c6-6#22 | 52 | 2 | 8939 |
| stale-shift-rates-hashline-r4 | 118 | 7261 | 3a159f7e | replace:5#f0 | 48 | 2 | 6523 |
| stale-shift-rates-hashline-r5 | 125 | 7506 | 3a159f7e | replace:N#f0 | 54 | 5 | 12107 |
| stale-shift-rates-hashline-r6 | 125 | 7087 | 3a159f7e | replace:5#f0 | 55 | 2 | 3987 |
| stale-shift-rates-hashline-r7 | 131 | 7498 | 3a159f7e | replace:5#f0 | 60 | 2 | 8594 |
| stale-shift-rates-hashline-r8 | 133 | 7889 | 3a159f7e | replace:4#c6-6#22 | 54 | 2 | 3962 |
| stale-shift-rates-hashline-r9 | 109 | 6012 | 3a159f7e | replace:5#f0 | 41 | 2 | 2799 |
| stale-shift-rates-hashline-r10 | 122 | 7046 | 3a159f7e | replace:5#f0 | 54 | 2 | 3889 |

r6 and r9 sent hashes with no line number (`07`, `0d3`, `8a`). r5 sent `N#f0`. Those three still match rule 1 because the returned error is the tag mismatch; the ID was not evaluated. The read before r5's call (end index 54) showed `5#f0|  return Math.floor(amount * RATE);` under `[file tag 3a159f7e]`, so `N#f0` is the letter N standing in for line 5.

### Not a line ID and composed mismatch (19), plus the placeholder (1)

All multihunk calls used `path: src/stats.js`, `tag: 89574289`, which is the tag on the read. `multihunk-stats-hashline-r1` read end index 61:

```
[file tag 89574289]
6#32|function mean(xs) {
7#e4|  return total(xs) / (xs.length - 1);
21#e4|  for (const x of xs) counts.set(x, (counts.get(x) || 0) + 1);
```

Hash `e4` is on line 7 and line 21. The model stripped the line number, then guessed line 6.

| runId | end# | _tMs | kind | first bad start | other starts in that call |
|---|---:|---:|---|---|---|
| multihunk-stats-hashline-r1 | 333 | 14340 | not a line ID | e4 | 07-72, 7d, ed, 67 |
| multihunk-stats-hashline-r1 | 602 | 28778 | composed mismatch | 6#e4 | 11#07-12#72, 16#7d, 23#ed, 29#67 |
| multihunk-stats-hashline-r2 | 310 | 8995 | not a line ID | e4 | 11#07-12#72, 7d, 23#ed, 29#67 |
| multihunk-stats-hashline-r3 | 324 | 10445 | not a line ID | N#e4 | N#07-N#72, N#7d, N#ed, N#40-N#97 |
| multihunk-stats-hashline-r4 | 307 | 8797 | not a line ID | e4 | 07-12, 7d, ed, 40 |
| multihunk-stats-hashline-r5 | 334 | 12477 | not a line ID | e4 | 07-72, 7d, ed, 67 |
| multihunk-stats-hashline-r5 | 603 | 18512 | composed mismatch | 6#e4 | 11#07-12#72, 16#7d, 23#ed, 29#67 |
| multihunk-stats-hashline-r6 | 326 | 12997 | not a line ID | N#e4 | N#07-N#72, N#7d, N#ed, N#97 |
| multihunk-stats-hashline-r6 | 595 | 19447 | composed mismatch | 6#e4 | 11#07-12#72, 16#7d, 23#ed, 29#67 |
| multihunk-stats-hashline-r7 | 307 | 10972 | not a line ID | e4 | 07-72, 7d, ed, 67 |
| multihunk-stats-hashline-r7 | 574 | 17625 | composed mismatch | 6#e4 | 11#07-12#72, 16#7d, 23#ed, 29#67 |
| multihunk-stats-hashline-r8 | 306 | 12073 | not a line ID | e4 | 07-72, 7d, ed, 67 |
| multihunk-stats-hashline-r8 | 575 | 18528 | composed mismatch | 6#e4 | 11#07-12#72, 16#7d, 23#ed, 29#67 |
| multihunk-stats-hashline-r9 | 311 | 9749 | not a line ID | e4 | 11#07-12#72, 7d, ed, 67 |
| multihunk-stats-hashline-r9 | 580 | 16713 | composed mismatch | 6#e4 | 11#07-12#72, 16#7d, 23#ed, 29#67 |
| multihunk-stats-hashline-r10 | 321 | 11174 | not a line ID | e4 | 07-72, 7d, ed, 40-29 |
| multihunk-stats-hashline-r10 | 596 | 17722 | composed mismatch | 6#e4 | 11#07-12#72, 16#7d, 23#ed, 28#40-29#67 |
| stale-shift-rates-hashline-r5 | 217 | 11260 | not a line ID | N#1d | (only edit; tag 3e255ccd) |
| stale-shift-rates-hashline-r5 | 285 | 14749 | composed mismatch | 7#1d | (only edit; tag 3e255ccd) |
| rename-fetch-hashline-r3 | 90 | 4221 | placeholder tag | (edits []) | tag N/A, path src/users.js |

r2 is the cleanest format miss: four of five IDs in the same call were already `11#07`, `23#ed`, `29#67`, and only the first start was bare `e4`. The tool rejects on the first bad ID (`checkedLine` throws). The later IDs in that call were never checked.

## Runs with 2+ errors

Eight runs. In every one the successful edit is the last edit of that file. There is no later call that could have used, or failed to use, the new tag. Across all 49 errors, `priorSuccessSameFile` is 0. No failed edit in the 110 hashline runs followed a successful edit of the same file.

### multihunk-stats, seven runs with two errors (r1, r5, r6, r7, r8, r9, r10)

Same shape. Cited from r8; the other six match the table above (no read of `src/stats.js` between the two errors; checked for all seven).

1. end#306 `_tMs` 12073, tag `89574289`, starts `e4`, `07`, `7d`, `ed`, `67`. Error: `start "e4" is not a line ID... example 12#a7.`
2. No read between end#306 and start#574. Next assistant turn retries the edit.
3. end#575 `_tMs` 18528, same tag `89574289`, starts `6#e4`, `11#07-12#72`, `16#7d`, `23#ed`, `29#67`. Error: `start 6#e4 does not match... Current line: 6#32|function mean(xs) {.`
4. Later success, start#843 / end#844, `_tMs` 24899, tag still `89574289`, first start `7#e4` (the ID from the read, not from the error). Result text:

> Successfully edited src/stats.js. New file tag: 479825ca.
> 5#9d|
> 6#dc|function mean(xs) {
> 7#8c|  return total(xs) / xs.length;
> 8#f3|}

The success text does show the new tag and the new line IDs. The model never had to use them: that success was the last edit. The retry after the first error did not use a new tag from a success; it kept `89574289` and invented line 6 for hash `e4`. Why that call was stale: it was not stale. The tag still matched the read. `6#e4` was never a shown ID. The shown ID is `7#e4` (and, a collision, `21#e4`).

r4, r2, r3 had one error each (bare `e4` or `N#e4`) and then a success on tag `89574289` with `7#e4`. Same success header (`New file tag: 479825ca.`) on r1, r2, r3, r4, r5, r6, r7, r8, r9, r10. No subsequent edit.

### stale-shift-rates-hashline-r5 (3 errors)

1. end#125 `_tMs` 7506, tag `3a159f7e`, start `N#f0`. Error is the injection sentence (now `3e255ccd`, sent `3a159f7e`). The read at end#54 showed `5#f0|  return Math.floor(amount * RATE);` under tag `3a159f7e`. The ID would also have failed `LINE_ID`, but the tag check returned first.
2. end#151 read, `[file tag 3e255ccd]`, and `8#1d|  return Math.floor(amount * RATE);` (injection prepended 3 lines; the hash changed because `lineHash` binds tag and line number, `hashline.ts:60-61`).
3. end#217 `_tMs` 11260, tag `3e255ccd` (the new tag from that read), start `N#1d`. Error: `start "N#1d" is not a line ID...`. The model copied `N#` and the hash `1d`, not the line number 8.
4. No read between end#217 and the next edit. end#285 `_tMs` 14749, tag still `3e255ccd`, start `7#1d`. Error: `start 7#1d does not match... Current line: 7#99|function taxFor(amount) {.` Off-by-one the other way: the return is line 8, the function header is line 7.
5. end#311 re-read, same tag `3e255ccd`.
6. end#377 `_tMs` 18634, tag `3e255ccd`, start `8#1d`. Success:

> Successfully edited src/rates.js. New file tag: 59b2777e.
> 6#62|
> 7#33|function taxFor(amount) {
> 8#a8|  return Math.round(amount * RATE * 100) / 100;
> 9#67|}
> 10#2e|

The model used the new tag from the re-read (`3e255ccd`), not a tag from its own edit result. The success result does show the new tag and the new IDs. Nothing edited `src/rates.js` after that, so the "use the new tag the result gave" question does not arise. The failed calls were stale relative to the injection (call 1 only). Calls 3 and 4 were not stale; they were a literal `N#` and then the wrong line number on a hash taken from the post-injection read.

### rename-fetch-hashline-r3 (1 error, 4 edit calls)

Included because the placeholder is the only non-injection stale tag, and the later calls show the success text.

1. end#90, tag `N/A`, `edits: []`, before any read. Error as quoted above. Not an own-edit stale tag.
2. reads at end#109-111 return tags `ed11cf35` (cache.js), `10d98e5f` (routes.js), `20b25d8a` (users.js).
3. end#134-136, three successful edits in one turn, tags `20b25d8a`, `10d98e5f`, `ed11cf35`, each result starting `Successfully edited <path>. New file tag: <new>.` followed by `N#HH|text` lines. No further edit. The model used the tags from the reads, which is what the tool asks for when there has been no prior edit.

## Retry cost

Definition used: assistant `message_end` after the first error's end index and before the next successful edit's start index. Median extra turns: **2**. Total: **84** across 40 runs. 28 of the 29 injection-only runs have exactly 2 (one turn to re-read, one turn to issue the successful edit). The three multihunk runs with a single format error have 1 (retry the edit with no re-read). The seven double-format runs have 2 or 3. rates r5 has 5.

`results.jsonl` `tokens` is the sum of assistant `usage.totalTokens` (`scripts/axiom-hashline-gate.mjs:111-120`, stored at line 259). On `multihunk-stats-hashline-r1` that sum is 33837, equal to input 12373 + output 984 + cacheRead 20480. So `tokens` counts the prompt again on every turn, not just new output.

Paired against the replace run with the same task and repeat (40 pairs):

- Total extra tokens: **247466**
- Median extra tokens: **6225**
- Input-field delta (sum of `usage.input`): 73754. Output-field delta: 7440. Those two do not add to 247466 because `tokens` also includes cache reads.

By task, error-run paired delta (total / median):

| Task | Error runs | Total dTok | Median dTok |
|---|---:|---:|---:|
| stale-clobber-inventory | 10 | 30317 | 3138 |
| stale-content-shipping | 9 | 60513 | 6225 |
| stale-shift-rates | 10 | 65276 | 6694 |
| multihunk-stats | 10 | 91252 | 8969.5 |
| rename-fetch | 1 | 108 | 108 |

Is the cost difference explained by the errors? Only partly.

- The 60 hashline runs in the six tasks with zero edit errors are still ahead of their replace pairs by 56161 tokens total, median 431.5. Hashline mode has a small token premium with no edit errors. That does not account for a median of 6225 on the error runs.
- The 11 runs whose errors include a format miss (10 multihunk + rates r5) account for 103359 of the 247466. Those are not injection. The format retry, not the harness write, is the expensive loop.
- Two injection runs are cheaper than their replace pair (`stale-clobber-inventory-hashline-r6` −4023, `r7` −4221). An error does not determine the sign of the delta. Replace-side variance is large (those replace runs used 17690 and 20163 tokens).
- `rename-fetch-hashline-r3`'s one error is +108 versus its replace pair. The task's hashline-vs-replace gap is +26469 over 10 pairs, almost all of it in the 9 runs with no edit error. That error does not explain rename-fetch's cost gap.
- Absolute `totalTokens` inside the recovery window sum to 214178 (median 4563). That is not "extra" cost: each of those turns re-sends the whole prompt. It is the same order of magnitude as the paired delta, which is what you would expect if the extra turns are the main addition and the prompts are a few thousand tokens. It is not a separate number to add on top of 247466.

So: the median gap on error runs is much larger than the no-error hashline premium, and it lines up with the extra turns, but it is not a clean error tax. Format retries cost more than injection retries. Two injection runs went the other way. rename-fetch's gap is not its error.

## Design flaw vs model misuse

Tool text the model is given (`hashline-edit.ts:111-117`):

> Edit a file by line ID. Pass the file tag and the N#HH IDs from the latest read of the file. All edits apply together or none do. A changed file (stale tag) or an ID whose hash no longer matches is refused with the current lines; re-read and retry.

> Make one edit call per file per turn and batch its changes in edits[]. A second call on the same file after a change fails on the stale tag.

> After any successful edit, use the new tag and IDs from its result, or re-read before editing lines outside that result.

Success text (`hashline-edit.ts:180-183`):

> Successfully edited ${path}. New file tag: ${newTag}.

then the rendered `N#HH|text` lines for the changed window, and a re-read notice if the window was truncated. The cited success results above match that shape, including the new tag and the new IDs.

The system prompt stored on `message_end` in these runs says: "In hashline mode, text lines show as N#HH|text under a file tag header. Pass the tag and the N#HH IDs to edit." Same `N#HH` metavariable as `read.ts:264` and the error at `hashline.ts:114`.

What this evidence supports:

1. **Drop the letter `N` from model-visible ID instructions.** Three surfaced errors sent a literal `N#` (`multihunk` r3 and r6 `N#e4`; rates r5 `N#1d`). A fourth call, rates r5's first edit, sent `N#f0` and was refused on the tag before the ID check. The read had already shown `5#f0` and, after the re-read, `8#1d`. The model kept the hash and wrote `N` where the line number goes. The error's own example `12#a7` was not enough to override the `N#HH` in the prompt, the tool description, and the error sentence ("Send only the N#HH part").
2. **On "not a line ID", name the shown lines that carry that hash.** Seven runs retried bare `e4` as `6#e4` with no re-read. The read shows `7#e4` (the mean return) and `21#e4` (a loop). The model guessed the function header line. The mismatch error, which does echo `Current line: 6#32|function mean(xs) {`, was followed by a successful `7#e4` call. The echo works. The not-a-line-ID error does not give the line number the model just stripped, and `e4` is not unique in this file, so a hint has to list both lines.

What this evidence does **not** support: changing the design so the tag stays put across an edit, or blaming the success text for hiding the new IDs. Zero errors are a stale tag after the model's own edit. In every multi-error run the success was the last edit, and its result text already leads with `New file tag:` and the new `N#HH|text` lines. The guideline at `hashline-edit.ts:115` (a second call on the same file after a change fails) was not what these 49 errors hit.

The injection error's "possibly by an earlier call in this turn" is false for all 29 injection refusals (the writer is the runner, `axiom-hashline-gate.mjs:184-186`) and false for the `N/A` call (nothing wrote the file). Models still re-read and recovered, and all 40 error runs passed. That sentence is misleading, but it is not what produced the extra format errors. I would not spend the design change on it ahead of the `N#` wording.

Ledger refusal (`was not shown`, `hashline.ts:128-131`) did not fire once. No evidence here for or against that check.

## What contradicts the summary

`results.jsonl.summary.json` counts match: 49 edit errors, 181 edit calls, `staleEditAfter: 29`. It does not classify causes. Two readings of it would be wrong:

- `staleEditAfter: 29` is 29 runs, not 29 of the 49 errors. Those 29 runs contain 31 errors (rates r5 adds a not-a-line-ID and a composed mismatch after the injection refusal). The other 18 errors are in runs with `stale.injected: false`.
- `retriesPerRun: 0.44545454545454544` is `49/110`, the error count per run, not a retry count. Several runs have two or three errors; the recovery-turn median is 2, not 0.445.

No summary claim that "hashline edit errors are stale tags after the model's own edit" exists in that file. If that claim is in circulation, it is contradicted: that class is 0/49.

## Open questions

- Whether a second edit of the same file after a success would use the new tag. This gate never did that. The 49 errors all precede the first success on that path. The success text's clarity is untested by a follow-up edit.
- inventory r6 (`07`, `0d3`) and r9 (`07`, `8a`): the tool reported the injection tag error and did not say the IDs were illegal. A re-run without injection would be needed to see the ID error. Not done; the gate artifacts are the evidence.
- `tokens` vs dollars. `usage.cost.totalFromProvider` is false on the sampled message (`multihunk-stats-hashline-r1` first assistant `message_end`). This review did not audit cost, only `tokens`.
