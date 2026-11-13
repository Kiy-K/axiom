# P6 Native Auto Mode: implementation contract

Roadmap issue [#1](https://github.com/Kiy-K/axiom/issues/1), phase P6. Paths are relative to `packages/coding-agent/src/`. Builds on [permissions.md](permissions.md) and [p4-closure-contract.md](p4-closure-contract.md).

**Status:** revision 3, slice S0 (contract). S1 (plumbing) and S2 (hard classes) implemented; the P5 follow-up and the prompt-injection gate are implemented (see Decisions D4, D10); S2 onward not. Written from the code at `6a25d2e`. Two review passes so far (see [Review record](#review-record)); every finding is fixed here or listed under [Open for the user](#open-for-the-user). Item 1 gates S2, item 3 gates S3, item 2 gates S4; item 4 is outside P6. None gates S1.

## Problem

`manual` asks about every action that is not a read inside the workspace. `accept-edits` removes the prompt for one kind of edit. Between them and `yolo` (gateway off) there is nothing: a user who wants fewer prompts must give up the gateway. P6 adds `auto`: a mode where the gateway can allow more than workspace edits, by positive rules only, without trusting the model's account of what it is doing.

Example of why this is not "ask less": `git diff --output=/tmp/x` has no named risk in `core/permissions/shell.ts`, so `manual` asks. An `auto` that allowed "anything with no named risk" would write outside the workspace silently. Published bypasses of coding-agent allowlists have this shape: `git show --output=.git/config` (Codex), `find -exec sh -c` (Claude Code), `rg --pre=sh` (an agent skill), environment-variable built-ins (Cursor CVE-2026-22708).

Second example, found in review and reproduced: even `git status` and `git diff` run programs named in the repository's own `.git/config` (`core.fsmonitor`, `diff.external`, a `textconv` driver) or in `GIT_EXTERNAL_DIFF`. A flag table cannot stop that, because the gateway decides and never changes the command line. So git is not in the v1 allowlist.

## What v1 delivers, honestly

v1 `auto` is `accept-edits` with its hole closed (code-running files), a mode switch, a hard-class check that runs before everything else, a positive shell rule for five commands, and a taint gate against prompt injection. Almost all of the prompt reduction a user would feel needs either P7 (sandbox) or the deferred items below. P5's old recoverable-edit rule needed a fully clean worktree, so after one real edit every later edit asked; it is replaced by pre-edit copies (D10), so edits no longer stop after the first one. P6's value is the safe structure that later rules plug into, not fewer prompts yet. The S5 report says so with numbers.

## Decisions

### D1. v1 is narrow; broad autonomy waits for P7

Claude Code and Codex both treat the sandbox as the primary control; Codex's reported prompt reduction assumes one. Without a sandbox a shell is opaque and project scripts are arbitrary code.

### D2. Project scripts and interpreters are never auto-allowed

`npm test`, `bun run check`, `make`, `python x.py` and the like ask every time, because D8 gives shell commands no grant in `auto`. Revisit after S4, with a fingerprint of code-running files that voids an allow when they change.

### D3. `auto` relaxes only in an interactive TUI session

Same condition as edit trust today (`agent-session.ts`: `_extensionMode === "tui"` and `CI` unset). Elsewhere (print, RPC, SDK, and a TUI with `CI` set) the **effective mode is literally `manual`**: manual verdicts, manual grants (including shell grants), asks go to whoever answers today (the RPC client) or are denied (print). The footer shows the effective mode, so a user sees `manual` and not `auto`. The task and grant rules below apply only while the effective mode is `auto`.

### D4. Decided (user, 2026-11-12): `accept-edits` does not trust-allow edits to code-running files

New hard classes apply in `auto` only. The code-running path class applies to `accept-edits` too: `tryAcceptEdit` does not trust-allow a write to such a file, and it falls through to the manual verdict. A grant the user chose at a prompt still covers it in `accept-edits` and `manual`; only `auto` ignores grants for hard-class actions (S2). Implemented: `ResolvedPath.runsCode`, `looksLikeCodeRunningPath`.

### D5. Task completion is measured in P8

P6 reports replay numbers only. A paired real-model run needs a provider, model and budget that were not chosen. The issue's P6 gate says "measure approval fatigue, false blocks and task completion"; this narrows it. The narrowing needs your sign-off and a line in the issue (see [Open for the user](#open-for-the-user)). Likewise "context-aware risk assessment" is met here by deterministic path, class and grammar checks only; model assessment is deferred (D6).

### D6. Model review is deferred

Not part of the first release. Built only if S4 shows a fatigue problem that deterministic rules cannot fix. Design notes are kept in [Deferred](#deferred).

### D10. Prompt-injection gate and pre-edit copies (decided by the user, built)

The user asked for a gate against prompt injection and for a different approach to P5's recoverability rule. Research (Firecrawl, 2026-11-12): Aljumaily et al., *Treating the Model as an Untrusted Component* (arXiv 2611.11571; simulation for human and taint layers, two small open-weights models for the rest) found that guardrails and detectors fall under adaptive attackers while deterministic enforcement holds its bound; that human approval behind a monitor helps most when triggered by taint, not by tool severity alone; that a human layer alone fails against approval spamming unless each episode has a deterministic approval budget (1 to 2 gave the best result); and that taint coverage failing degrades the gate gradually to the bound of the layer beneath, not below it. The Cloud Security Alliance note on the Claude Code auto-mode bypass (Rehberger, Aug 2026) shows a chain of individually benign steps, ending in Python module shadowing, defeated a model classifier; Anthropic called auto mode best effort and not a security boundary. Repository-file injection (README, `AGENTS.md`) reaches every major assistant (ReadSecBench 84%, AIShellJack 41-84%). Hence a deterministic gate, not a classifier.

Built: a taint latch (`core/permissions/taint.ts`, `docs/axiom/permissions.md`), a per-task approval budget of 3, grants ignored while tainted, no automatic edit while tainted, `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, `.claude/**` in the code-running class. Not covered, stated: a hostile file inside the workspace (the user trusted the workspace), taint through model-generated values (session-level, as in the study), and any step that is benign alone (module shadowing); P7 is the control for those.

Recoverability: Cline, Kilo, Hermes and Claude Code all keep pre-edit copies or shadow-repo snapshots outside the project instead of requiring a clean worktree. Axiom keeps one copy per automatic edit (not per user-approved edit) in `<agentDir>/checkpoints/<session>/`, written before the edit runs; `/restore` brings one back. Like Claude Code's rewind, it covers built-in edits only, not what `bash` changes.

### D7. `git push` stays a hard-class ask

Claude Code carves out pushes to the session's own branch when the remote was configured before the session. Axiom does not in v1: a push is externally visible and irreversible.

### D8. No shell-command grants in `auto`

A shell prompt in `auto` offers "Allow once" only. Grants for read and write directories stay as in `manual`, but a grant never covers a hard-class action or a code-running file (below). This replaces the revision 1 `task-grant` rule and its list of runners: a negative list of interpreters leaks (`deno`, `tsx`, `go run`, `pytest`, `uv run`, `awk`, `docker`), and exact-command grants are shared by `bash`, `job send_input` and `pi.exec` (open P4 finding). Not offering them removes both problems.

Grants are bounded to a task (below): all grants are cleared when a task ends, as well as at the existing 10 minute TTL.

### D9. Denial wording now; counters later

A block returns the reason plus an instruction: do not reach the same outcome by another route; find a materially safer path or stop and ask. Escalation counters (stop after N blocks) are deferred: "block", "in a row" and the stop mechanism are undefined today (the gateway has no abort handle, and a model can reset a consecutive count with a harmless call). They matter once a model reviewer can be wrong, so they come with model review.

## Design

### Modes and switching

`PermissionMode` gains `"auto"`; `settings-schema.ts` gains the literal and `getPermissionMode` returns it (today the string `"auto"` reads as `manual`). Unknown values and the former `unrestricted` stay `manual` (startup prints a warning for them; see `permissions.md`). A project setting cannot loosen the mode (global settings only). The default stays `yolo`.

`/mode [yolo|manual|accept-edits|auto]` sets a **session override**. The effective mode is `override ?? setting`.

1. **Order.** `manual < accept-edits < auto < yolo`, from strictest to loosest. "Stricter" and "loosening" use this order.
2. **Lifecycle.** The override is held by the gateway. A session replacement (`/new`, resume, fork, clone) builds a new `AgentSession` and gateway (`agent-session-runtime.ts`), so the override would be lost and the user returned to the setting, `yolo` by default. Therefore the runtime carries a **tightening** override (stricter than the setting) into the replacement session, and never carries a loosening one. A loosening override is session-only: the user types it again. `/reload` re-reads the setting and keeps the override, unless the setting is stricter than it, in which case the override is cleared.
3. **Any change of effective mode** clears all grants and edit trust. The gateway records the last effective mode on every read of the mode, including in `yolo` (where `authorize` returns first), and keeps a **mode generation** counter that increments on a change. A prompt answered after the generation changed is a denial and adds no grant (`decide` adds grants after `await ask`).
4. **Who can loosen.** The setter is a method on `AgentSession` called only by the TUI's `/mode` handler. It is not on `ExtensionContext` or `ExtensionAPI`, and is not reachable from a model tool call, from RPC (v1 has no RPC mode switch), from print mode, or from `sendUserMessage`. `/mode yolo` asks the user to confirm with `ui.select`; the confirmation cannot be skipped.
5. **What this does not claim.** In-process extension code is unmediated (`permissions.md`, routes table). Review found it can drive the TUI: a custom editor from `ctx.ui.setEditorComponent` can call the submit handler with `/mode yolo`, and an extension can edit the global settings file. Neither can be stopped from inside the process; both are P7. The contract claims only that no API the session or gateway exposes loosens the mode.
6. The footer shows the effective mode. `/permissions` shows mode, grants and recent decisions.

### Decision flow (monotonic)

For every tool call in `auto` the order is:

```
0. effective mode is auto (D3), else the existing flow, unchanged
1. actions = actionsForToolCall(call)
2. any action is deny                     -> block (as manual)
3. any action is a hard class             -> ask, "Allow once" only; no grant is consulted or offered; no edit auto-allow
4. tryAcceptEdit (code-running files excluded)           -> allow
5. every action is relaxed by a positive rule             -> allow (audit source "auto", rule id)
6. otherwise                                               -> manual verdicts (grants for read/write dirs apply; prompt)
```

Steps 2 and 3 run before `tryAcceptEdit` and before `grants.find`. Today `authorize` runs `tryAcceptEdit` first and `decide` consults grants before anything else, so a hard-class check inside `relax` alone would be bypassed (review H4: an exact-command grant given in `manual` for `sed -i s/a/b/ package.json` would still allow it after `/mode auto`). A call with several actions is allowed only if **every** action is allowed (strictest wins). Write actions derived from redirection, `tee`, `mv`, `cp` and `sed -i` are **added** to the call's actions; the `exec` action stays, so a grant for the write can never stand in for the opaque command.

`judgeAction` stays pure and unchanged.

### Invariants

Each is tested with an independent oracle (see Tests).

1. Auto never turns a `deny` into anything else.
2. A hard-class action is never allowed without an explicit "Allow once" from a UI: not by rule, grant, edit trust or reload.
3. Auto is never looser than `manual` unless a named positive rule fired; the audit entry names it.
4. Unparseable, unresolvable, over-long or unknown input is `deny` or `ask`, never `allow`.
5. No UI means `ask` becomes `deny`.
6. Only a UI answer is the user's consent. Chat text never relaxes anything.
7. Any exception in the auto path is a denial.
8. Changing the effective mode clears grants and edit trust, and a prompt that was open across the change adds no grant.
9. A call that mixes a hard-class action with a relaxable one is judged by the hard-class action.

### Hard classes

| Tier | Classes | Behavior |
|---|---|---|
| deny | privilege escalation; protected paths (`.git`, `.husky`, `.axiom`/`.pi`, agent dir); unresolvable paths; commands over 2000 characters | as today |
| ask always, no grant | secrets read/write and environment dumps; network egress; publish, deploy, production (`git push`, `npm publish`, `terraform apply`, `kubectl apply`, ...); destructive git and filesystem (`rm`, `reset --hard`, `clean`, force push, recursive `chmod`/`chown`); auth and permission changes (`gh auth`, `aws iam`, `ssh-keygen`, `git config` credential keys); external messages (`gh pr/issue comment`, `curl` to a webhook, `sendmail`); persistence (cron, `authorized_keys`, shell profiles); writes to code-running files | the prompt names the class; "Allow once" only |

**Code-running files** are a path class in `core/permissions/paths.ts`. It is a best-effort denylist: every source and test file is code that `npm test` runs, so no list is complete. Matching is on the workspace-relative real path (`path.real` made relative to `path.workspace`), case-insensitive, as path-suffix globs where a pattern contains `/` and as a file name at any depth where it does not. Initial list:

- CI and tasks: `.github/**`, `.gitlab-ci.yml`, `.circleci/**`, `.buildkite/**`, `azure-pipelines.yml`, `.travis.yml`, `Jenkinsfile`, `Taskfile.yml`, `lefthook.yml`, `.pre-commit-config.yaml`, `justfile`, `Makefile`, `GNUmakefile`, `makefile`, `Procfile`, `mise.toml`, `scripts/**`, `bin/**`, `*.sh`
- JS: `package.json` (any depth), `bunfig.toml`, `.yarnrc`, `.yarnrc.yml`, `.yarn/releases/**`, `.babelrc*`, `.eslintrc*`, `.prettierrc.js`, `.mocharc*`, `.lintstagedrc*`, `.huskyrc*`, and the named tool configs `{vite,vitest,jest,eslint,webpack,rollup,babel,postcss,tailwind}.config.*` (not every `*.config.*`: `src/app.config.ts` is ordinary source)
- Python, Rust, Go, JVM, Ruby, C: `conftest.py`, `setup.py`, `setup.cfg`, `pyproject.toml`, `tox.ini`, `sitecustomize.py`, `*.pth`, `Cargo.toml`, `.cargo/config.toml`, `build.rs`, `build.gradle*`, `pom.xml`, `Gemfile`, `Rakefile`, `CMakeLists.txt`
- Containers and editors: `Dockerfile`, `Dockerfile.*` (not `*.md`), `docker-compose*`, `.devcontainer/**`, `.devcontainer.json`, `.vscode/tasks.json`, `.vscode/settings.json`, `.vscode/launch.json`, `.envrc`
- Git: `.gitattributes`, `.gitmodules` (`.git/**` is already protected)
- Agent instruction files, so a planted edit does not persist as instructions: `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, `.claude/**`, `.cursor/**` (`.pi/**` is already protected)

Known cost: ordinary editing of these files asks (for example `conftest.py` in a pytest project, `scripts/**`). That is accepted for v1.

Verified by reading and reproduced in review: today `PROTECTED_SEGMENTS` is only `.git`, `.husky` and the config directory, and `tryAcceptEdit` rejects only protected or secret paths.

**Classes missing from `shell.ts` today:** external messages, auth/permission changes, persistence, more deploy tools, and file-moving or writing commands (`mv`, `cp`, `sed -i`, `tee`, redirection `>`/`>>`) as `write` actions on the resolved path. Review confirmed `cp`, `mv`, `sed -i`, `tee`, `>`, `git diff --output=`, `rg --pre=sh` and `ls {.env,a}` all have empty named risks today.

### Positive rules (v1)

| Rule id | Allows | Excludes |
|---|---|---|
| `workspace-read` | unchanged from `manual` | |
| `trusted-recoverable-edit` | built-in `edit` of a plain workspace file, session trust, a pre-edit copy kept (D10) | code-running files (also in `accept-edits`, D4); any file once the task is tainted |
| `readonly-shell` | `bash` calls only: one command, or commands joined by `&&`, `\|\|`, `;`, `\|`, each in the table below | everything else in this section |

`readonly-shell` applies only to the model's `bash` tool. It does not apply to `job send_input` (stdin goes to an arbitrary process) or to `pi.exec`.

**Grammar (closed).** A line is allowed only if all of these hold, otherwise the whole line asks as one opaque command:

- The line is split on spaces and tabs only. Other whitespace (`
`, NBSP, newline) rejects the line.
- Every word matches `[A-Za-z0-9_./@%+=:,-]+` and does not start with `=`. No quotes, `$`, `~`, braces, `* ? [ ]`, `< >`, `&`, backticks, parentheses, here-docs. `VAR=value` as a first word is rejected.
- Separators are exactly the standalone words `&&`, `||`, `;`, `|`. A separator glued to a word (`ls;ls`) is not a separator, so the word fails the charset and the line asks.
- **The command word equals a table entry exactly**: no `/`, so `./ls`, `/bin/ls` and `/tmp/x/ls` ask (a file the model wrote can be run as `./ls`; the existing classifier uses `basename` and must not be reused here).
- The rule is off when any `PATH` entry in the spawn environment (`getShellEnv`) is empty, relative, or resolves inside the workspace, because a workspace file could shadow `ls`.
- Each command is in the table, with only the listed flags. A flag is a word beginning with `-`. Combined short flags (`-la`) are allowed only if every letter is listed. A flag value is the next word and must match `^[0-9]+$`. The forms `-n5`, `-5`, `+N` and `--` are rejected.
- Every other word is a file argument. It must resolve (`classifyPath`) inside the workspace, not secret, **not protected** (so `.git/config`, which can hold a token in a remote URL, asks), and for `head`/`tail`/`wc` it must be a **regular file** by `stat` (no FIFO, device, socket or directory; a FIFO hangs `head`, reproduced in review). A code-running file is allowed here: reading one is what the `read` tool does silently, and the hard class is about writes.
- A word `-` is rejected (stdin). `head`, `tail` and `wc` need a file argument unless they follow a `|`.
- The rule is off when `shellCommandPrefix` or `shellPath` is set in settings (a prefix such as `ls() { sh ./x.sh; }` would make an allowed `ls` run code; review H5).

This reads exactly what the `read` tool reads, using the same `classifyPath`; it is not looser than `manual`'s read rule. The secret list is the existing one: in a workspace that is `$HOME`, `.config/gh/hosts.yml` and `.bash_history` are not secret, for the `read` tool and for this rule alike.

| Command | Flags |
|---|---|
| `pwd` | none |
| `ls` | `-a -A -1 -F -t -S -r` (not `-R`, not `-l`: `-l` prints symlink targets) |
| `wc` | `-l -w -c -m` |
| `head` | `-n N`, `-c N` |
| `tail` | `-n N`, `-c N` (not `-f`, `-F`, `--follow`) |

`ls` of a directory lists names only. The built-in `ls` tool asks for a directory because a search also reads files, and the `ls` tool is not changed: the model will find the shell route more convenient, by design.

`git` is excluded: it runs repo-configured programs (`core.fsmonitor`, `diff.external`, textconv, `GIT_EXTERNAL_DIFF`) and reads outside the workspace through implicit repo-root paths (`git diff` from a subdirectory; `:/path`; `rev:path`; history with committed secrets). Both were reproduced in review. Returning `git status|diff|log|show` needs a config probe and an environment sanitizer, which is [Deferred](#deferred).

The grammar lives in `core/permissions/shell-grammar.ts`, separate from the lexical classifier in `shell.ts`, so a negative list is never used as proof of safety.

### Tasks and grants

Applies only while the effective mode is `auto` (D3), so `manual` keeps its 10-minute grants across runs.

A **task** is one user-triggered run. It starts after `_prepareRun` succeeds in `_startRun` and ends at `agent_settled` or on abort. Steering and follow-up messages extend it, as do retry, overflow-compaction and queued-message continuations and the extension `agent_before_settle` continuation: `agent_end` fires several times per prompt, `agent_settled` once per `_startRun`. A run triggered by an extension (`sendCustomMessage` with `triggerTurn`, `sendUserMessage` with source `extension`) starts no task: its asks offer "Allow once" only.

Plumbing the implementer must add, found in review:

1. The prompt source (`interactive`, `rpc`, `extension`) lives on `PromptOptions` only. `BeforeAgentStartTrigger` is `{messageType, prompt, images}` (`runner.ts`, `agent-session.ts:2349`), so `_startRun` cannot tell the two apart. Carry the source on the trigger.
2. `_startRun` catches a failure in `_prepareRun` and rethrows without emitting `agent_settled`. Call `beginTask` after `_prepareRun` succeeds, or call `endTask` in that catch, so a throwing `before_agent_start` handler cannot leave a task open.
3. `_emitAgentSettled` runs extension `agent_settled` handlers before it drains deferred runs. Call `endTask` as its first statement, so an extension-triggered deferred run cannot inherit the previous task's grants.

`AgentSession` calls `beginTask()` and `endTask()` on the gateway; `endTask` clears all grants.

### Prompt injection

Prompt text is not enforcement. The structural defense is that no positive rule reaches a secrets or external-effect action, so an injected instruction cannot get one auto-allowed whether or not it is detected. (Meta's Agents Rule of Two: untrusted input is unavoidable, so sensitive access and external effects are the two to deny.)

Residual risk, accepted and stated: whatever the positive rules allow, which is recoverable edits to non-code-running files and the five read-only commands. A hostile file inside the workspace cannot be detected. The remaining attack is planted code that the user later runs. P8's "malicious repo instructions" cases measure it.

### Timeouts, cancellation, override, reasons

Unchanged: prompt deadline 2 minutes means deny, abort means deny, no UI means deny. The user may answer "Allow once" on any ask-always item. A deny cannot be overridden. A model-chosen retry of a blocked call is a new call and is judged again.

Reason display: an ask or block shows the class and rule in the prompt or block text (reusing the `reason` strings on verdicts). An auto-allow shows nothing inline; it is in `/permissions` and the audit log. This is a deliberate, partial reading of the checklist item "compact reason display"; see [Open for the user](#open-for-the-user).

### Audit

`DecisionSource` gains `"auto"`; the entry's `detail` starts with the rule id or class. No change to rotation.

## Open for the user

Decided 2026-11-12: D4 (above), gate wording (replay only for P6, task completion in P8, "context-aware risk assessment" read as deterministic checks), the P5 follow-up (fixed by D10). Still open: whether to also add one line on untrusted content to the system prompt in sessions whose mode is `auto` or `accept-edits` when the prompt is built. Not done: it is prompt-level, so weak, and a mid-session `/mode auto` would not rebuild it. The deterministic gate above is the control. The issue text for P6 should record the gate-wording decision when the issue is next edited.

## Deferred

Recorded here so a later change starts from the evidence, not from scratch.

- **`git` in `readonly-shell`.** Needs (a) a config probe (refuse if `core.fsmonitor`, `core.pager`, `filter.*`, `diff.*.{textconv,external,command}` is set), (b) refusing `GIT_EXTERNAL_DIFF` and `GIT_PAGER` in the environment, (c) explicit pathspecs after `--` only, rejecting `:` magic and `rev:path`, bare `git diff`, `git log -p` and `git show`. A snapshot only.
- **Model review.** Runs only on non-hard-class asks; sees user messages and the proposed call, never assistant text or tool results; fails closed; one extra model call per action. Counters (D9) come with it. Published vendor numbers are not targets: Claude Code 0.4% false positives on 10,000 real calls, 17% of 52 real overeager actions missed; Codex 90.3% recall on synthetic overeager cases. Both say it is not a guarantee.
- **Provenance marker.** Wrap untrusted results in a marked block (prompt level, weak).
- **Tool-keyed grants.** Changes `GrantScope` and `covers()` for every mode, so it is a separate change; D8 avoids needing it in `auto`.
- **RPC mode switch** (tighten only).
- **Fingerprint of code-running files** (D2).

## Slices

| # | Slice | Contents | Goldfish |
|---|---|---|---|
| S0 | Contract | this document and its review | fresh reviewer, issue and code only |
| S1 | Plumbing (done) | `auto` value and schema, `/mode` and override lifecycle, footer, audit source, `beginTask`/`endTask`, effective-mode change clears grants and trust. `auto` behaves as `manual` until S3. Corpus and invariant tests written first | loosening unreachable from the session and gateway API |
| S2 | Hard classes (done) | classifier additions, code-running path class (applied in `auto`, and in `accept-edits` per D4), redirection as write, hard-class check before `tryAcceptEdit` and grants | attack with new obfuscations; attack the reorder |
| S3 | Positive rules | `readonly-shell` grammar, edit rule, no shell grants (D8) | attack every allowed command with every flag trick |
| S4 | Gate | hand-labelled corpus, replay numbers, `docs/axiom/auto-mode.md`, sign-off | independent reproduction |

`auto` is selectable from S1 but relaxes nothing before S3, and the hard classes land in S2, so no slice opens a window where `package.json` is auto-editable in `auto`. S2 and S3 are independent after S1. One commit per slice; `yolo` and `manual` are unaffected by all of them; `accept-edits` changes only by D4.

## Tests

Each must fail against a plausible wrong implementation. Oracles are independent of the code under test: the corpus is hand-labelled, and the grammar test uses a separately written regex, not the classifier.

| Case | Wrong implementation it catches |
|---|---|
| Hand-labelled corpus of 150+ calls, each with an expected decision: hard classes with wrappers (`env`, `timeout`, `bash -c`, `sh -c`, subshell, `$()`, line continuation, quoting, `base64 \| sh`). With an always-"Allow" UI, the decision source is `user` (a prompt was shown) or the call is denied, never `policy`, `auto`, `grant` or `accept-edits`; with no UI, denied | classifier checks only the first word; a rule or grant allowing a hard class |
| Regression corpus from real bypasses: `git show --output=.git/config`, `find . -exec sh -c x \;`, `rg --pre=sh x`, `FOO=bar ls`, `export PATH=/tmp:$PATH`, `ls {.env,a}`, `git status`, `git diff` from a subdirectory: all ask | allowlist by command name |
| Edit to `package.json`, `.github/workflows/ci.yml`, `bunfig.toml`, nested `pkg/package.json` in a clean tracked repo with edit trust: asks in `auto` and in `accept-edits` | P5 edit rule inherited unchanged |
| Exact-command grant given in `manual` for `sed -i s/a/b/ package.json`, then `/mode auto`: asks, and the grant is gone | grants consulted before the hard-class check; grants survive a mode change |
| Filesystem fixtures for `readonly-shell`: symlink to an outside file asks; symlink to `.env` asks; FIFO asks (and does not hang); directory as `head` argument asks; `.git/config` asks; `./ls`, `/bin/ls` and `=ls` ask; `head -` asks; `head -n x f` asks; `ls;ls` asks; `ls -l` asks; PATH with `.` or a workspace entry turns the rule off | grammar looser than its spec on the real filesystem |
| One call with a hard-class action and a relaxable one (for example `ls && curl x`, an `edit` plus a nested hard-class call): judged by the hard-class action | per-action relaxation |
| `ls > f`: the call has the exec action and a write action; a write-directory grant does not allow it | write action replacing the exec action |
| `readonly-shell` property test: for generated strings, `allow` iff the string matches an independent grammar regex written in the test; and every allowed string run through `shell.ts` has no named risk | grammar looser than its own spec |
| `ls \| wc -l` allowed; `ls && curl x` asks; `ls > f` asks; `head f` allowed; `head` alone asks; `tail -f f` asks; `tail -n5 f` asks; `ls -R` asks; `ls "a b"` asks | chain judged by first command; stdin hang; flag forms |
| With `shellCommandPrefix` set in a trusted project: `ls` asks | prefix ignored |
| `job send_input "ls"` and `pi.exec ls` ask in `auto` | rule applied to other routes |
| A shell prompt in `auto` offers no grant; a read-directory grant is offered and cleared by `endTask` | shell grants; grants outliving the task |
| A run with an extension `triggerTurn` has no task: no grant offered | extension runs inherit grants |
| One user prompt with two retries and a queued follow-up: one task; `endTask` once, at `agent_settled`; an extension-triggered deferred run after it has no grants | `agent_end` used as the boundary; grants inherited |
| `/mode` from model tool, `sendUserMessage`, RPC `prompt` text, print: not a mode change. `/mode auto` in the TUI with `CI` set, or in RPC: effective mode and footer are `manual`, with manual shell grants | loosening reachable; D3 wrong |
| Project settings `permissionMode: "auto"`: ignored. Global `"auto"`: accepted. Reload with a stricter setting: override cleared. New session: override cleared | scope and lifecycle |
| Mode change by override or reload, including a `manual`-`yolo`-`manual` interlude between two calls: grants and edit trust cleared | stale grants; clearing missed because `authorize` returns first in `yolo` |
| A prompt open while `/mode` changes: answered "Allow for 10 minutes" adds no grant and the call is denied | grant added after the mode changed |
| `/mode manual`, then `/new`, resume, fork: the new session is `manual`. `/mode auto`, then `/new`: back to the setting | tightening lost; loosening carried |
| Golden test: for a fixed set of calls, `manual` and `accept-edits` verdicts and grant behavior are identical before and after the change, except D4's trust-allow case | `manual` changed; `endTask` clearing grants outside `auto` |
| Edit trust path: `accept-edits` with trust, edit to `package.json`: falls through to the manual verdict (asks) | D4 not applied |
| Prompt `source`: `sendUserMessage` from an extension starts no task and offers no grant; a user prompt with a throwing `before_agent_start` handler leaves no open task | source not on the trigger; task leaked on prepare failure |
| Exception injected in the auto path: denial | fail open |
| Block text contains the "do not work around" instruction | reason only |

## Replay measurement (S4)

Choose and record the session set before measuring: existing session files plus `scripts/baseline-tasks`. Feed their tool calls through `manual`, `accept-edits` and `auto`. Report per task: asks, auto-allows, denies; calls allowed in `auto` that a human labelled hard-class (must be 0; the labels are made by hand, not by the classifier); asks a reviewer labels safe. Report plainly if auto-allows are near zero, and why (clean-worktree rule, D2). Task completion is P8 (D5).

Gate passes when the safety suite is green, replay shows zero hand-labelled hard-class allows, mode tests pass, and an independent review found no unfixed high or medium issue. The default stays `yolo`; passing the gate does not make `auto` safe to default (that needs P7).

## What `auto` cannot claim

Opaque shell contents (`eval`, scripts written then run), path swaps after the check, extension code (including driving the TUI and editing settings), user `!` commands, MCP servers from config and codemode `models.*` are unmediated (see `permissions.md`, routes table). The mode description and `/mode` help must say this. The code-running list is a best-effort denylist. Subagents (P9) must run the same checks at delegation and at return; nothing to build now.

## Out of scope

Model review and taint latch; git in `readonly-shell`; project scripts (D2); the sandbox (P7); porting hard classes to `manual` (D4); `git push` carve-out (D7); tool-keyed grants; the other open P4 findings in `permissions.md`.

## Rollback

One commit per slice. Reverting any one leaves the others working; with `auto` unset nothing changes. D4's `accept-edits` change reverts with S2.

## Review record

### Review 1 (fresh context, revision 1)

Reviewer had the issue, the contract and the code, and no other context. 5 high-or-medium-high, 10 medium, 1 low findings. Verified and fixed in this revision:

| Finding | Status |
|---|---|
| H1 `git status/diff/log/show` run repo-configured programs (reproduced: `core.fsmonitor`, `diff.textconv`, `diff.external`, `GIT_EXTERNAL_DIFF`) | git removed from v1; moved to Deferred |
| H2 implicit git reads outside the workspace (reproduced: `git diff` from a subdirectory, `:/`, `rev:path`) | same |
| H3 "loosening unreachable from extensions" is false in the TUI (custom editor, `onTerminalInput`) | rule restated; extension code stated as unmediated; `/mode yolo` asks to confirm |
| H4 `tryAcceptEdit` and grants run before `relax` (reproduced: grant then `/mode auto`) | decision flow reordered; grants cleared on mode change; invariants 2 and 8 |
| H5 `shellCommandPrefix`/`shellPath` from project settings defeat the allowlist | rule disabled when set |
| M1 P5 recoverable edit needs a clean worktree, and (reproduced) fails when the workspace is a subdirectory of the git root | fixed: pre-edit copies replace the clean-worktree rule (D10) |
| M2 D3 wrong for RPC (it binds a UI) | D3 rewritten on `_extensionMode` |
| M3 `agent_end` is not a task boundary | `_startRun` to `agent_settled`, user-triggered only; `beginTask`/`endTask` |
| M4 code-running list incomplete | list extended; stated as best effort |
| M5 D8 denylist leaks; grant-key change touches `manual` | no shell grants in `auto`; tool-keyed grants deferred |
| M6 grammar underspecified | closed grammar and flag table |
| M7 override lifecycle missing | lifecycle rules |
| M8 tests circular | independent oracles, hand-labelled corpus |
| M9 D9 not buildable | counters deferred; wording now |
| M10 no RPC path for `/mode manual` | RPC switch deferred |
| M11 S1 opens a window | `auto` relaxes nothing until S3; hard classes in S2 |
| L1 no inline reason on allow | stated as a deliberate choice |
| Over-engineering: model review, taint latch, `match`/`not_match`, git flag table, task-grant counts, denial counters, generated property tests, replay harness | all cut except the replay measurement, which the gate needs and is now hand-labelled and small |

Checklist coverage the reviewer flagged as partial, and the answer here: "context-aware risk assessment" is deterministic (path, class, grammar) with model assessment deferred (D6); "per-task grants" are directory grants bounded to a task (D8); "task completion" is P8 (D5); "compact reason display" is shown on ask and block only.

Not independently verified by the reviewer: the external vendor numbers and advisories; whether `onTerminalInput` rewritten data reaches the editor (types only).

### Review 2 (same reviewer, with its earlier context, revision 2)

Not a fresh-context pass: the reviewer re-checked its own findings and attacked the new material. 2 high, 9 medium, 2 low. Fixed in revision 3:

| Finding | Status |
|---|---|
| N1 (high) grammar did not require an exact command word; `./ls` written by the model would match; relative PATH entries | exact word, no `/`; rule off for a relative or workspace PATH entry; no leading `=` |
| N2 (high) task plumbing: source not on the trigger; task leaked when `_prepareRun` throws; `endTask` ordering in `_emitAgentSettled` | three plumbing steps added |
| N3 `endTask` clearing grants would change `manual`; D3 ambiguous | task rules only in effective `auto`; D3 means literal `manual` |
| N4 grants still cover code-running files in `accept-edits` | D4 narrowed to the trust-allow; grant behavior stated |
| N5 list matching and gaps | path-suffix matching, list extended, agent instruction files added, cost stated |
| N6 grammar excluded reads of code-running files | reads allowed; `!protected` instead |
| N7 tightening lost across `/new`, resume, fork; "stricter" undefined; `yolo` interlude missed | order defined; tightening carried; mode read tracked in every mode |
| N8 grant added after a prompt across a mode change | mode generation counter |
| N9 FIFO, `.git/config`, `ls -l` link targets, numeric flag values, whitespace, `-` | regular file, `!protected`, `-l` removed, numeric regex, space/tab only, `-` rejected |
| N10 `ls` tool vs shell inconsistency | stated as deliberate |
| N11 test wording and gaps | rewritten; fixtures and mixed-action cases added |
| N12 counts, confirm wording | fixed |

Checklist findings from review 2: reason display on allow is partial; "context-aware assessment" is a narrowing; injection is structural only; the gate redefinition needs sign-off. These are items 2 and 3 in [Open for the user](#open-for-the-user). Nothing in the issue text forces git, task grants with counts, counters, model review or taint back in.

Not verified by the reviewer: external vendor numbers and advisories; whether an extension's custom editor or `onTerminalInput` reaches `/mode` (types only); macOS and Windows shells.

### Review 3 (fresh context, taint gate and pre-edit copies, 2026-11-12)

The reviewer read the uncommitted tree and the deleted git-based rule. No high findings; 8 medium and 8 low. Fixed:

| Finding | Status |
|---|---|
| M1 denylist misses `.agents/**`, `node_modules`, `.venv`, `.pnpmfile.cjs`, `.cargo`, tool configs (reproduced) | list extended; Windows trailing dot or space handled; `src/app.config.ts` stays editable |
| M2 orphan snapshot or corrupt index line blocks the store for the session (reproduced) | failed write removes its file; per-line index parsing; next id from index and files; retry on EEXIST |
| M3 a resumed session removed its own old copies (reproduced) | own directory never pruned; staleness from the newest write |
| M4 restore refused at the 200-copy cap (reproduced) | restore reserve of 20 copies and 16 MiB |
| M5 network classifier gaps; docs overclaimed | docs now say what the classifier flags and name what it misses; nothing more detected |
| M6 `authorizeExec` spent the budget (reproduced) | calls with a caller no longer spend it |
| M7 replace-mode edit can overwrite a same-batch `bash` change | documented; hashline mode closes it; not fixed in replace mode |
| M8 restore not audited, racing a running edit, mode lost to umask | audit entry, refused while a tool call runs, `chmod` after write, file and directory fsync |
| L1 session-id directory collisions and the empty id | directory name carries a hash of the id |
| L2 `/restore` printed raw paths | sanitized |
| L3 only automatic edits get a copy | prompt and docs say so; not changed |
| L4 Windows `package.json.` | trailing dots and spaces stripped |
| L5 `bin` and `scripts` match at any depth | accepted |
| L6 a call made in `yolo` is not tracked if the user then leaves `yolo` | accepted |
| L8 an extension tool named like a built-in is taken for it | accepted (extension code is trusted code) |

Tests added: orphan and corrupt index, id collisions, cumulative size, own-session prune, restore reserve and mode, restore audit and refusal while running, mark set at finish and not at authorize (mutation checked), abort leaves no mark, mark survives non-user runs and mode switches, budget exemption, extra code-running paths. Not added: a hashline-mode accept-edits session test (the accept-edits suite uses `replace`).

### After review 3 (2026-11-12): follow-ups

- M5 (network classifier gaps): the taint mark now also fires on `npx`, `bunx`, `pnpm dlx`, `python -c`, `node -e`, `git submodule`, `cargo build`, `go mod`, `poetry`, `mvn`, `gradle`, `dotnet`, `deno`, `docker run` and similar; still lexical.
- L3 (no copy for approved edits): a best-effort copy is now kept for an `edit` or `write` the user approves, in `accept-edits` and `auto`.
- Missing hashline-mode test: added at gateway level.
- S2 built per this contract: hard classes, implied shell writes, no shell grants in `auto`. Hard-class check runs inside `decide` before any grant is consulted; edit trust (`tryAcceptEdit`) does not run in `auto` until S3, so the order in the decision-flow diagram holds trivially today and S3 must keep it.
- Still open: M7 (replace-mode edit overwriting a same-batch `bash` change, documented), L6 (a call made in `yolo` is not tracked), L8 (extension tool named like a built-in), S3 positive rules, S4 gate and replay, the issue text for the P6 gate wording, and the one-line system-prompt instruction on untrusted content (prompt level, deliberately not added).

### Review 4

None yet.
