# Session log: Hashline default, P2 gate iterations 3-4, open items

Date: 2026-11-07. Repo: /home/khoi/Projects/axiom. Base HEAD b7458ccf2. All changes uncommitted; nothing pushed. GitHub issue #1 untouched.

## Completed

- P2 gate, Iteration 3 (stale recovery, holdout v1): null verdict. Criterion 3 (tokens/wall) failed. Replace stays the verdict of record. The P2 null verdict has not been changed.
- Iteration 4 fixes:
  - Non-stale ID/tag: a hash that belongs to another shown line now names that line in the refusal. Validation unchanged. An empty `tag` is refused before stale recovery and returns no file lines.
  - Replace mixed line endings: `restoreLineEndings(original, newNormalized)` keeps each surviving line's own ending; added lines take the nearest kept line's ending. `detectLineEnding` removed.
- Holdout v2 (new, frozen before the run; sha256 6ac95633...; holdout v1 unchanged, sha256 75fdff4c...). Clean run, 120 trials, seed 1, records in docs/axiom/hashline-gate/results-v4-holdout-v2.jsonl.
  - K1 wrong writes: replace 0/60, hashline 0/60. Pass.
  - K2 task pass: hashline 60/60, replace 59/60; discordant pairs 1 hashline-only, 0 replace-only. Pass.
  - K3 non-stale ID/tag errors: 0 of 60 hashline runs. Pass.
  - K4 replace compatibility: 98.3% vs 95% threshold. Pass.
  - K5 (reported): hashline tokens median +1,627 [+1,236, +2,503], about +19%; wall +1.1 s.
- Default flipped on user approval: `editMode` now defaults to `hashline` (settings-defaults.ts, schema default, docs/settings.md, CHANGELOG Unreleased). Replace remains selectable via `editMode: "replace"`; replace code not removed.
- ADR: docs/axiom/adr-hashline-first.md, status accepted.
- Tests: three replace-output tests pinned `editMode: "replace"` explicitly (agent-session-codemode, builtin-tool-strict-mode, tool-renderer-examples). They pass.
- `bun run check`: exit 0 (last run after test edits).
- Bundle rebuilt after source changes.

## Findings

- Aborted first holdout-v2 run: EDQUOT writing an artifact to /tmp (shared tmpfs, 7.7 GB). 110 records discarded; full set rerun to /home.
- Anomalies in aborted run (did not recur in clean run): replace BOM refusal with 0 edits (model misjudged BOM as blocking the match; edit.ts strips BOM before matching); replace whole-file `write` adding a final newline (tool choice).
- Example extensions `built-in-tool-renderer.ts` and `minimal-mode.ts` re-register `read` and `edit` with `createReadToolDefinition` and `createEditToolDefinition` (plain factories). Loading them silently switches a session to replace mode, so the default hashline is disabled for those users. NOT FIXED. Also the cause of the strict-mode test's prompt change under default. Needs a mode-aware fix.
- `./test.sh` after the flip: 12 failures in 7 files before the test pins. After: 7 failures in 4 files, all also failing on an untouched `git archive HEAD` copy (same count, 7):
  - package-manager.test.ts (2): skills count from user `~/.agents`
  - project-trust-saved-decision.test.ts (2)
  - trust-manager.test.ts (2)
  - package-command-paths.test.ts (1): expects `.axiom/settings.json`
  - Caveat: HEAD copy ran 148 tests vs 194 in the working tree; compared by count, not test names.
- Still ENOENT on `.axiom/settings.json` in package-command-paths is probably the rename (pi to axiom); not verified.

## Blockers

- Isolated bug review on Grok 4.7 High: not run. `task` tool has per-call models disabled and Axiom's agent config has no xAI. In OMP (`omp --model xai/grok-4.7:high --no-context-files`), the model resolves but the probe fails with `No API key found for xai`, including after the user reported logging in. Needs a successful xAI credential in OMP before the review can run.

## Open questions

- Should the example extensions use a mode-aware edit/read definition (and the strict-mode test be updated accordingly), or should they stay replace-only and say so?
- Should the 7 environmental test failures be fixed in this change or split out?
- Confirm the `.axiom` rename is the cause of the package-command-paths failure.

## Next steps

1. Get xAI working in OMP (`omp` then `/login` for xai, or XAI_API_KEY), then rerun the isolated review with `omp --model xai/grok-4.7:high --no-context-files -p` in a fresh process. Read-only brief, no architecture notes.
2. Decide and fix the example-extension edit-mode override.
3. Decide the 7 pre-existing test failures.
4. Commit only on user request; stage explicit paths; leave `.agents/` and `skills-lock.json` out.

## Update: xAI subscription login and reviewer run

- Correct OMP provider for SuperGrok subscription is `xai-oauth`, not `xai` (`xai` is the API-key provider). `omp login xai-oauth` completed the device sign-in. Credential saved to OMP's agent database. `omp usage` shows the account active with quota (SuperGrok Weekly Credits 26% used).
- Model calls via `xai-oauth/grok-4.7:high` and `xai-oauth/grok-4.7` return no output: 300 s and 150 s hard timeouts, exit 124, with no error text.
- The isolated reviewer (`omp --model xai-oauth/grok-4.7:high --no-context-files --no-extensions --no-skills --no-session --no-lsp --tools read,grep,find`) exited 0 after about 25 minutes with an empty report. No findings were produced. Output: `/home/khoi/.cache/tmp/review-isolated/report.md` (0 bytes).
- Cause not established. Not the reasoning level (plain grok-4.7 also stalls). Not auth (login and quota are fine). Unverified candidates: xAI-side stall, or OMP's xai-oauth transport.
- Blocker remains: no Grok review. The isolated review has not run.

## Update: isolated review on Claude

- User chose Claude (Anthropic, active in OMP) over Grok. Ran `omp --model anthropic/claude-opus-5-5` with the same fresh, read-only tools (`read`, `grep`, `find`), no context files, no extensions, no session. Report: `/home/khoi/.cache/tmp/review-isolated/report-claude.md`. Labeled Claude, not Grok 4.7.
- Reviewer ran no tests and had no git. Nine findings from reading code.
- Verified against code:
  - F1 (High): hashline read reads the whole file before the 8 MiB check (`read.ts:325`). Plain read streams.
  - F4 (gate integrity): `verify` runs `node --test` in an agent-writable workdir, and the verdict checks only `src/` guards (`axiom-hashline-gate.mjs:108-111`, `:246-248`). An agent that edits or deletes tests would pass. Observed in 120 v4 runs: 0 runs wrote under `test/` (heuristic over edit, write, bash). Verdict unaffected in practice; the verify step should be hardened before the next gate.
- Not verified: F2 (delete of last line with no final newline vs contract wording), F3 (directory-writability requirement for atomic write), F4's zero-test exit-0 claim, F5-F9.
- Not fixed in this pass.

## Update: F1 and F4 fixed

- F1 (high): hashline `read` now checks the file size first (`ReadOperations.fileSize`, default `stat`) and streams files over the hashline limit. Custom operations without `fileSize` keep the old behavior. Regression test in `hashline-tools.test.ts`. Reasoned, not run against the old code: the old code called `readFile` unconditionally in hashline mode, so that test would have failed.
- F4 (gate integrity): `verify` restores the task's `test/` files before running; zero tests fails; `testsTampered` is recorded per trial. Regression tests in `scripts/axiom-hashline-gate.test.mjs` (6 pass). A test-runner parent env var (`NODE_TEST_CONTEXT`) changed the child's report format; it is now removed for the child.
- Re-verified all 120 v4 trials with the hardened verdict: no `pass` value changed, none tampered with `test/`.
- Checks: `bun run check` exit 0; bundle rebuilt; `validate` all 30 tasks; `node --test scripts/*.test.mjs` 60/60; `./test.sh`: 3170 passed, 7 failed in the same 4 pre-existing files.
- Not fixed: F2, F3, and F5-F9 from the review (unverified or lower priority).
