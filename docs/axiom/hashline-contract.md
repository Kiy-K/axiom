# P2: Hashline read/edit

Roadmap issue [#1](https://github.com/Kiy-K/axiom/issues/1), phase P2. Repo citations are `file:symbol`.

**Status:** revision 3. Implemented behind `editMode: "hashline"`; default stays `"replace"`. Revision 1 went to a fresh-context review (REVISE, 23 findings). Revision 2 was validated by a second fresh-context reviewer (2 MAJOR, 4 MINOR; no BLOCKER). Revision 3 fixes those findings and adds the benchmark. The gate for model-level success is still open (see Gate).

## Problem

`edit` in replace mode (`packages/coding-agent/src/core/tools/edit.ts`) matches exact `oldText`, with a fuzzy fallback (`edit-diff.ts:fuzzyFindText`). Measured failure modes (Benchmark below):

| Case | Replace mode today |
|---|---|
| File changed after the model read it, old `oldText` still matches | Edit applies to bytes the model never saw |
| Mixed `\r\n` and `\n` endings | `restoreLineEndings` rewrites every line to the first ending found |
| Block appears twice | Refused; model must add context |
| Invalid UTF-8 elsewhere in the file | Decoded lossily and written back |

## Decisions

- **Opt-in.** `editMode: "replace" | "hashline"`, default `"replace"`. Read at session build (`agent-session.ts:_buildRuntime`), so it applies on the next session or `/reload`. `createReadToolDefinition` takes option `hashline`; the hashline edit is a separate definition, `createHashlineEditToolDefinition`, because its schema differs.
- **Tag-bound IDs.** The line hash includes the file tag, so an ID from one version does not match another version's line except by a 1 in 256 coincidence.
- **Shown-line ledger (new in rev 3).** An ID is usable only if the model was shown that line under the tag it sends. `hashline-ledger.ts` records shown ranges per absolute path and tag; read and edit results write to it. Edit checks it after the hash. This makes stale-ID rejection deterministic for every ID the tool checks: a coincidental hash match on a line the model did not see under that tag is refused. The ledger is bounded (64 files, 8 tags per file, 256 ranges per tag). Forgetting causes a refusal, which is the safe direction. It is per process; a new process requires a re-read.
- **Snapshot check before rename (restored in rev 3).** The edit's bytes are checked again immediately before the rename, so a write by another process after the edit's read is refused instead of overwritten. Local writer only; custom `EditOperations` keep their own `writeFile`.
- **No `insert_before`.** `insert_after` with `0` covers the top of the file.
- **Refuse, do not fall back.** Hard links, non-regular files, invalid UTF-8, NUL bytes, and files over `MAX_HASHLINE_BYTES` (8 MiB) are refused. Read in hashline mode shows plain output with no tag or IDs for non-text and over-size files.
- **Path resolution.** Read and edit both use `resolveReadPathAsync`.
- **Structured output unchanged.** The header `[file tag T]` is part of the read text, outside the truncation budget.

## Contract

### Line model

A line is `(text, eol)`, `eol` is `"\n"`, `"\r\n"`, or `""`. Only the last line can have `""`, and only when the file has no final newline.

- Split on `"\n"`. A `\r` directly before `\n` is the ending. Any other `\r` is line content.
- BOM: decoded with `ignoreBOM: true`, split off with `splitBom`, kept in the written bytes.

### File tag

`fileTag(bytes)`: first 8 hex chars of SHA-256 over the raw bytes, BOM included.

### Line ID

`N#HH`. Grammar `^(0|[1-9]\d*)#[0-9a-f]{2}$`. `0` is valid only as `start` of `insert_after`.

`HH = hex(sha256(utf8(tag + "\n" + N + "\n" + text)))[0:2]`.

Vectors from `printf '<tag>\n<N>\n<text>' | sha256sum`: tag `3fa91c0e`, N `1`, text `a` gives `cf`; N `2`, empty text gives `96`.

### Read output (hashline mode)

```
[file tag 3fa91c0e]
1#cf|alpha
2#96|
```

Each shown line is recorded in the ledger under the tag. Lines cut by truncation are not shown and get no record.

### Edit input

```
{ path, tag, edits: [{ op, start, end?, text? }] }
op = "replace" | "delete" | "insert_after"
```

- `replace`: `start`, optional `end` (inclusive), `text` required.
- `delete`: `start`, optional `end`. `text` refused.
- `insert_after`: `start` (or `0`), `text` required. `end` refused.
- `text`: empty refused (use `delete`, or `"\n"` for one blank line). One trailing `"\n"` ignored. A CRLF ending is reduced to LF when its LF is present; a CR in the final piece of text that has no LF is refused, and so is any other lone CR. A lone UTF-16 surrogate is refused. Text that is only `N#HH|` read prefixes is refused.

### Application

1. Each ID must match the current tag's hash, and its line must have been shown under the tag (ledger).
2. Ranges must not overlap.
3. An insert at gap `g` (between lines `g` and `g+1`) is refused strictly inside a replaced or deleted range. Boundary gaps are allowed.
4. Inserts at the same gap keep array order.
5. Apply in one pass against the original lines. Nothing is written if any check fails.

### Line endings

- Replaced lines take the ending of the start line, or the nearest earlier line that has one, else `\n`.
- Inserted lines take the ending of the anchor line, walking back to the nearest line that has one. At the top of the file, line 1's ending.
- The old last line of a file without a final newline takes the file's nearest ending when text is appended after it. Appending to a CRLF file with no final newline gives CRLF throughout.
- A file with no final newline keeps none after an edit. A file with one keeps one.
- Unchanged lines keep their own bytes.

### Errors

- Stale tag: names the current tag and says an earlier call may have changed the file.
- ID mismatch: names the line and shows its current content with its current ID, echoed up to 200 UTF-16 units.
- ID not shown under the tag: names the tag and says to re-read the lines you edit.
- Refusals never list more than one line.

### Write

Default writer (hashline definition only), `replaceFileAtomically`:

1. `realpath` the target. Refuse non-regular files and files with `nlink > 1`.
2. Create `.<name>.<random>.tmp` in the target's directory with `wx`. Write, `chmod` to the original mode (after the write, since writing clears setuid and setgid), `fsync`, close.
3. Read the target again. If it differs from the snapshot the edit was computed from, refuse and remove the temp file.
4. `rename` over the target. Any failure removes the temp file and rethrows.

Symlinks are written through to the target and the link is kept. Abort is checked before the write only; after the write the edit is reported as done.

## Limits

- **Between the re-check and the rename.** A write by another process in that gap is not detected. The gap is one `readFile` and one `rename`. Closing it needs a lock the workspace cannot assume.
- **Hash coincidence at the hash layer.** `lineHash` alone accepts a stale ID's line with probability 1/256 (measured 0.0037 over 400,000 random tag pairs). The ledger rejects those at the tool. Without the ledger, the tool would accept about 0.5 percent of a stale-ID flow (measured before rev 3: 19 of 4,000 end-to-end, one wrong-line edit).
- **Ownership, ACLs, xattrs** are not preserved by rename. Mode, setuid, and setgid are.
- **Process restart** forgets the ledger. The model must re-read after a restart; the edit refuses with the re-read message.
- **Read cost.** Hashline read output is about 12 to 30 percent larger than replace-mode output (see Benchmark).
- **Parallel calls.** Two `edit` calls on one file in one turn: the second is refused on the stale tag. A guideline asks for one call per file per turn.
- **Lenient arguments not ported.** Replace mode's argument normalizations (stringified `edits`, single-object `edits`, top-level `oldText`/`newText`) do not apply in hashline mode.
- **Windows and custom `EditOperations`** (SSH, Gondolin) were not exercised.

## Benchmark

Script: `/tmp/hashline-gate/bench.ts` (throwaway, not committed; run `TRIALS=200 bun bench.ts`). Both tools run from this repo's source. The baseline is replace mode, which is Pi's `edit` and `read` in this repo. Each cell is 200 seeded trials on the same generated files. Both paths read the whole file in windows and pay for it. The simulated model copies exact line text (replace) or exact IDs (hashline), so this measures mechanism, not model accuracy.

Outcomes: `ok` (intended bytes written), `refused` (no write), `corrupt` (write when no write was correct, or wrong bytes).

| Lines | Scenario | EOL | Pi ok / refused / corrupt | Hashline ok / refused / corrupt | Pi read chars | Hashline read chars | Pi args | Hashline args | Pi edit ms | Hashline edit ms |
|---|---|---|---|---|---|---|---|---|---|---|
| 50 | clean | lf | 100 / 0 / 0 | 100 / 0 / 0 | 1034 | 1344 | 177 | 184 | 0.15 | 0.28 |
| 50 | clean | mixed | 0 / 0 / 100 | 100 / 0 / 0 | 1044 | 1345 | 178 | 185 | 0.14 | 0.27 |
| 50 | duplicates | lf | 0 / 100 / 0 | 100 / 0 / 0 | 264 | 574 | 149 | 187 | 0.05 | 0.25 |
| 50 | stale | lf | 0 / 0 / 100 | 100 / 0 / 0 | 1034 | 1344 | 183 | 190 | 0.13 | 0.06 |
| 500 | clean | lf | 100 / 0 / 0 | 100 / 0 / 0 | 10834 | 14246 | 183 | 190 | 0.44 | 0.63 |
| 500 | clean | mixed | 0 / 0 / 100 | 100 / 0 / 0 | 10933 | 14245 | 181 | 188 | 0.55 | 0.80 |
| 500 | duplicates | mixed | 0 / 100 / 0 | 100 / 0 / 0 | 2720 | 6030 | 145 | 184 | 0.11 | 0.74 |
| 500 | stale | mixed | 0 / 0 / 100 | 100 / 0 / 0 | 10934 | 14246 | 182 | 190 | 0.48 | 0.13 |
| 2000 | clean | lf | 100 / 0 / 0 | 100 / 0 / 0 | 44669 | 59678 | 184 | 191 | 1.55 | 1.80 |
| 2000 | clean | mixed | 0 / 0 / 100 | 100 / 0 / 0 | 45070 | 59677 | 176 | 184 | 1.57 | 1.68 |
| 2000 | duplicates | lf | 0 / 100 / 0 | 100 / 0 / 0 | 10504 | 25416 | 146 | 187 | 0.22 | 1.60 |
| 2000 | stale | lf | 0 / 0 / 100 | 100 / 0 / 0 | 44668 | 59676 | 181 | 188 | 1.69 | 0.18 |

The full matrix (18 cells, 3,600 paired trials per tool) is in `bench.out`. Hashline had 0 corrupt and 0 false refusals in every cell. Replace mode's corruption on mixed endings is the existing `restoreLineEndings` behavior, which this benchmark reproduces; it is not fixed in replace mode.

Costs, stated: read output is +30 percent characters on these short-line files and +12 percent on the 500-line code-like file measured earlier. Edit arguments are +4 to +10 percent for clean edits and larger for duplicates, where replace mode is refused. Edit latency is 0.1 to 1.8 ms per call for both; hashline is slower by about 0.1 to 1.5 ms because it hashes the whole file for the tag.

Fixture-level silent corruption from the eight hand-written cases: replace mode 3, hashline 0.

## Gate

- **Met, mechanism level:** no silent corruption in any benchmark cell or fixture case; stale and mixed-ending cases fail closed.
- **Measured, model level (not promoted):** two paired live runs of 220 trials each (11 tasks, 10 repeats, `gpt-6-luna`), in `hashline-gate.md`. Run 1 found 49 hashline edit errors, 20 of them malformed or composed IDs. The instruction and hint fix removed those 20: run 2 has 25 errors, all runner-injected stale-tag refusals. Hashline had 0 wrong writes against replace's 10 in both runs (all on mixed line endings, a replace-mode defect). Task pass was equal (110/110 in both modes, run 2). Median tokens were higher by 2,835 (run 2) and 1,676 (run 1); wall time higher by 1.8 s (run 2). Edit success was 84.1% against 100%.
- **Cost:** read output +12 to +30 percent; edit args +4 to +10 percent; edit latency sub-2 ms; live median tokens +36 to +40 percent (run 1: 13,045 vs 9,620; run 2: 13,074 vs 9,353). The stale tasks carry the largest gap, but non-stale tasks also cost more (for example `move-formatter` +3,155 tokens in run 2), so the refusals are not the whole cost.
- **Decision:** default stays `"replace"`. The predeclared rule was not met in run 2: no clear benefit in task pass, tokens, or wall time. The wrong-write advantage is real but is from a replace-mode defect, not a hashline mechanism. Promotion needs a stale-refusal cost reduction and another rerun under the verdict procedure in `hashline-gate.md`.

## Tests

- `test/hashline.test.ts`: pure core. Pinned hash vectors, line model, edit application, gap and boundary rules, CRLF append, lone CR at the end of text, shown predicate, every refusal.
- `test/hashline-tools.test.ts`: real read and edit definitions on a temp directory. Stale tag; an ID with a coincident hash for a line not shown under the tag (refused); an ID from the previous edit's shown window (accepted); BOM and CRLF preservation; CRLF append to no-final-newline file; empty file; invalid UTF-8; over the size limit; hard link; setuid kept; symlink; no leftover temp file; abort before write; access refusal; the pre-rename snapshot check.
- `test/suite/agent-session-hashline-edit.test.ts`: session wiring, the `editMode` schema swap, and a read-then-edit round trip through the faux provider.
- Reviewer attacks (`/tmp/hashline-gate/attack*.ts`, throwaway): CRLF, lone CR, surrogates, tags, ranges, symlinks, hard links, modes, Promise.all, abort. Re-run after rev 3: the stale-ID flow accepted 0 of 4,000 (was 19).
