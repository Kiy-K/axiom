# Auto mode: S3 rules and S4 replay report

Roadmap issue [#1](https://github.com/Kiy-K/axiom/issues/1), phase P6. Contract: [p6-auto-mode-contract.md](p6-auto-mode-contract.md). Rules: [permissions.md](permissions.md).

## What `auto` allows without a prompt (S3)

Only in an interactive TUI session with `CI` unset (elsewhere the effective mode is `manual`). Each allow is audited with `source: "auto"` and the rule id first in the detail.

| Rule | Allows | Code |
|---|---|---|
| `readonly-shell` | the model's own `bash` calls built only from `pwd`, `ls` (`-aA1FtSr`), `wc` (`-lwcm`), `head`/`tail` (`-n N`, `-c N`), joined by `&&`, `\|\|`, `;`, `\|`; file arguments must be plain workspace paths that are not protected or credentials, with no `..` segment, and single-link regular files for `head`/`tail`/`wc` | `core/permissions/shell-grammar.ts` |
| `trusted-recoverable-edit` | a built-in `edit` of a plain workspace file after session edit trust, with a pre-edit copy kept; never a code-running file, credentials or persistence path; never once the task is tainted | `core/permissions/gateway.ts` (`tryAcceptEdit`) |

Off or not applicable: `shellCommandPrefix` or `shellPath` set; Windows; `PATH` entry empty, relative or inside the workspace; `job send_input`; `pi.exec`. A call that mixes an allowed command with a hard class (`ls && curl x`) is judged by the hard class. A shell prompt in `auto` still offers "Allow once" only.

## Replay (S4)

Tool: `node scripts/axiom-auto-replay.ts [--list] [--cwd <workspace>] <session.jsonl>...`. It feeds the recorded calls to the gateway in `manual`, `accept-edits` and `auto`; nothing runs. The scripted user always picks the first choice.

Session set (one, chosen before measuring): `packages/coding-agent/test/fixtures/large-session.jsonl`, 391 tool calls (192 bash, 146 edit, 50 read, 3 write). Workspace: this repository. `scripts/baseline-tasks` holds task definitions, not recorded calls, so it is not replayable.

| Mode | allow | ask | deny |
|---|---|---|---|
| manual | 49 | 342 | 0 |
| accept-edits | 49 | 338 | 4 (taint budget) |
| auto | 49 | 338 | 4 (taint budget) |

- **Hand-labelled hard-class allows: 0**, but this says nothing about S3: all 49 auto-allows are `read` of a workspace file, the same as `manual`. I read the full list (`--list`). The S3 evidence is the sample replay below.
- **`auto` relaxes nothing on this session.** Of 192 `bash` calls, 87 start with `grep`; 62 are `cd <dir> && npm …`, and 6 start with `git`; only 3 start with `ls`, and those use globs or other words outside the grammar. `grep`, `cat`, `find`, `npm` and `git` are deliberately not in `readonly-shell` (D2, and git runs repository-configured programs).
- **The edit rule is not measured.** The session was recorded in another repository, so the files its edits target do not exist here and every edit asks. Measuring `trusted-recoverable-edit` needs a replay against a checkout of the session's own repository (`--cwd`).
- **Task completion** is P8 (D5), not measured here.
- Not labelled: asks a reviewer would call safe (false blocks). Needs a second person; the `--list` output is the input.

### Sample replay: exercises the S3 rules (hand-written, synthetic)

The recorded session above never fires an S3 rule, so it says nothing about them. `docs/axiom/auto-replay-sample.jsonl` is a **hand-written** session of 68 calls against this repository's own files (not a real user's work, so it says nothing about how often real sessions hit the rules). Each call carries a hand-written label. 28 are `safe` (read-only commands and plain edits a reviewer would not mind auto-allowing, including ones outside the grammar on purpose), 34 are `hard` (network, publish, destructive, credentials, code-running and persistence files, outside-workspace and `..` paths, redirections, chains with a hard command). Each hard call is its own task, so the approval budget cannot hide a classification. Run: `node scripts/axiom-auto-replay.ts --list docs/axiom/auto-replay-sample.jsonl` (exit code 1 if any hard call is allowed).

| Mode | allow | ask | deny |
|---|---|---|---|
| manual | 4 | 64 | 0 |
| accept-edits | 5 | 63 | 0 |
| auto | 21 | 46 | 1 |

- **Hard calls allowed without a prompt in `auto`: 0 of 34** (33 ask, 1 policy denial: `tee .git/config`).
- **The S3 rules fired 18 times** (16 `readonly-shell`, 2 `trusted-recoverable-edit`): all 16 read-only shell calls were allowed.
- **Safe calls that still ask (false blocks): 7 of 28.** Five are read-only commands outside the grammar (`cat`, `grep`, `ls -l`, `find`, `head a b | cat`), by design. `head README.md -n 5` asks because a flag after a file is outside the grammar (GNU `head` accepts it, BSD and `POSIXLY_CORRECT` read the flag as file names). One is the single trust prompt before the first automatic edit. `git status` and `git diff --stat` are deliberately unlabelled: git runs programs named in the repository's own configuration, which is why the contract excludes it.
- Project scripts (`npm test`, `bun run check`) all ask, as D2 says.
- Labels: written by me, then relabelled blind by a fresh reviewer who saw only the calls (28 safe, 6 neutral, 34 hard). Three disagreements, resolved as above: `git status` and `git diff --stat` (safe to neutral), `head @README.md` (hard to neutral: it reads a file literally named that, and is only an attack if that name is a link), and `head README.md -n 5` (hard to safe: a plain read). The sample is still synthetic, and it is a regression check, not a measure: the repo has no symlinks, hardlinks or FIFOs, so those protections rest on unit tests and the reviewers' fuzzing.

## Finding from the replay

Five `bash` calls containing the word `constructor` were denied as "Permission check failed" in **every** mode, `manual` included. `shell.ts` looked up subcommand tables with a plain index, so `constructor` found `Object.prototype.constructor`, a function, and `.includes` threw. The gateway failed closed, so nothing unsafe ran, but legitimate commands were blocked. Fixed with an own-property lookup (`own()` in `shell.ts`, also used in `auto-classes.ts` and `taint.ts`); regression tests in `test/permissions-policy.test.ts` and `test/permissions-auto-classes.test.ts` fail without it.

## Gate status

- Safety suite and mode tests green; `bun run check` exits 0.
- Replay: 0 hard-labelled allows on the recorded session and on the hand-written sample (34 hard calls). The recorded session exercises no S3 rule, the sample is synthetic and labelled by the author.
- Independent reviews of S3: a subagent (high: `link/..`; medium: persistence names, `accept-edits` change; low: hardlink) and the Oracle (medium: leading `@`/`file:` words, a flag after a file operand, empty gate evidence; low: `BASH_FUNC_`/`BASH_ENV`/`POSIXLY_CORRECT`, wrong `PATH` key, mode round trip during the trust prompt). All fixed with tests that fail without the fix; see Review 4 and Review 5 in the contract.
- A final review by a reviewer who had seen none of the work found one more medium (the auto edit rule allowed `AGENTS.override.md`, `.lefthook.yml`, `.mise.toml`, `compose.yaml`, other agents' settings and executable extensionless scripts) and an incomplete fix for the trust-prompt round trip; both are fixed with tests, each verified to fail without its fix (Review 6 in the contract).
- **Not yet met:** a review of the Review 6 fixes, and a replay of a real session recorded in its own repository (to measure the edit rule on real work). The default stays `yolo`; passing this gate does not make `auto` safe to default (that needs P7).
