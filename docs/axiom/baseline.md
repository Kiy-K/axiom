# Pi baseline (pin 922c3ff) and P0 gate evidence

Keyless, no paid APIs. Harness: `scripts/axiom-baseline.mjs`. Raw pin data: `docs/axiom/baseline-pi-pin.json`.

## Environment

- Pin checkout: `922c3ff2b`, `packages/` clean when measured.
- Hardware: Intel i7-13620H, 16 cores, 15.3 GB RAM, x64. Fedora Linux 44, kernel 7.2.13.
- Runtime: Node v24.22.1 for every number below. The harness runs source mode through Node only: its source resolver uses `module.registerHooks`, which Bun 1.4.4 does not provide. Bun is the project's install, build and test runtime (`docs/axiom/toolchain.md`). No Bun startup numbers are recorded yet.

## Pin results

10 measured runs, 1 discarded warmup, 30 RPC turns per run. Each run uses a fresh temp HOME, agent dir, and cwd. Statistics are over the 10 runs; RPC latency is pooled over 290 turns (turn 1 of each run excluded).

| Metric | Median | Min | Max | p90 | Measured or estimate |
|---|---|---|---|---|---|
| Cold startup wall (`-p hi`) | 832.9 ms | 821.9 | 848.9 | 843.9 | measured |
| Startup TOTAL (`PI_TIMING`, main) | 146 ms | 145 | 149 | 147.2 | measured |
| Peak RSS, startup (node process) | 190.3 MB | 184.2 | 191.1 | 190.9 | measured |
| Peak RSS, RPC process | 179.5 MB | 178.1 | 181.4 | 181.3 | measured |
| System prompt | 2226 B | 2226 | 2226 | 2226 | measured (bytes) |
| System prompt tokens | 557 | | | | ESTIMATE, ceil(bytes/4) |
| Tool schemas, default set (read/bash/edit/write) | 2969 B | 2969 | 2969 | 2969 | measured (JSON bytes) |
| Tool schema tokens | 743 | | | | ESTIMATE, ceil(bytes/4) |
| RPC first turn | 721.9 ms | 719.9 | 740.8 | 734.8 | measured |
| RPC turn, excl. first (n=290) | 0.97 ms | 0.80 | 1.98 | 1.13 | measured, harness latency with faux |

Outcome: exit code 0 in all 10 startup runs. Expected output in 10/10. RPC turns returned `ok` in 300/300.

## Reproduce

```sh
bun install --ignore-scripts && bun run hydrate:model-data   # once; fills gitignored provider data
node scripts/axiom-baseline.mjs <repoDir> --runs 10 --warmup 1 --turns 30 --json out.json
node scripts/axiom-baseline.mjs <repoDir> --bundle            # shipped bundle; needs bun run build
git worktree add /tmp/axiom-pin 922c3ff2bdea786b16c9b26680f22c2272251ffc   # pin copy, if the main checkout is dirty
```

The script reads `bin` and `piConfig.name` from the checkout's `packages/coding-agent/package.json` and sets `<APP>_CODING_AGENT_DIR` (`PI_CODING_AGENT_DIR` at the pin, `AXIOM_CODING_AGENT_DIR` at HEAD). It needs no code changes to run before and after the rebrand. Compare two JSON files by diffing their `parity` sections.

## Limitations

- Single host, Node 24.22.1. Run-to-run spread is small here; it says nothing about other hardware.
- Source mode only in the pin run. The bundled build (`--bundle`) was not measured.
- "Cold" means a fresh process and an empty agent dir. The OS page cache is warm after the warmup run.
- Startup wall includes the `/usr/bin/time` wrapper. RSS covers only the node process, so it is not comparable to the earlier 178.7 MB figure, which included a bash wrapper.
- Token counts are byte-based estimates, not tokenizer output or provider usage. The system prompt includes the cwd, so its size depends on the temp path length.
- The faux provider makes no network calls, so RPC latency is harness overhead, not model latency.
- **Variance concern:** the pin run does not reproduce the earlier measurements (TOTAL 207 ms, wall ~1.06 s). Those are 42% (TOTAL) and 27% (wall) higher than today's medians, far outside this run's spread (wall ±2%). The likely cause is the earlier run's `pi-test.sh` bash wrapper, a different cwd, or cache state. This is an [INFERENCE]; it was not isolated. Do not compare against the earlier numbers until that is resolved.
- **Not done:** a real-model task baseline (resolve rate, tokens, cost, safety cases). It requires the user to choose provider, model, and budget. P0 item 3 in issue #1 stays open until it is run.

## Parity (pin vs HEAD)

| Probe | Pin `922c3ff` | HEAD `2d518e77a` | Result |
|---|---|---|---|
| `--version` | `1.5.0` | `1.5.0` | identical |
| Built-in tool schemas (8 tools) | per-tool SHA-256 in `baseline-pi-pin.json` | all 8 identical; combined `df1f4dc3a56f…` identical | identical |
| `--help` | stdout SHA-256 `47d1839c…`, 10883 B, first line `pi - …` | stdout SHA-256 `9b14f62b…`, 10787 B, first line `axiom - …` | differs; see below |

The HEAD `--help` run is the one from this round (`node scripts/axiom-baseline.mjs`, `parity` section). The pin's help text was not saved, so the byte diff is explained from source: `git diff 922c3ff2b HEAD -- packages/coding-agent/src/cli/args.ts` changes four lines only: the `update [source|self|pi]` usage line, its entry in the `<command> --help` list, and the `PI_SELF_UPDATE_COMMAND` environment line are removed (rebrand contract §7, D25), and the app name is `axiom` through `APP_NAME`. Nothing else in the help text changed.

## Fedora gate (P0)

Host: Fedora, Node 24.22.1, Bun 1.4.4. Logs are in `/tmp` and are not committed.

| Target | `npm ci --ignore-scripts` | `build` | `check` | `test.sh` |
|---|---|---|---|---|
| Pin `922c3ff` (`git archive`, lock as committed) | rc 0 | rc 0 | rc 0 | rc 0, after `npm run build:daemon` in `packages/env` |
| HEAD `2d518e77a` (`git archive`, fresh copy) | rc 0 | rc 0 | rc 0 | rc 0 (`test.sh` builds the daemon first) |

- `test.sh` at HEAD runs `npm run build:daemon --workspace packages/env` before the isolated run, as CI does. Without it, seven `packages/env` files fail with "Build the daemon first". The pin's `test.sh` has no such step, so the pin row needed the manual build.
- Pin coding-agent: 343 files and 3067 tests pass. Test counts were not captured for the HEAD run.
- The gate uses `npm ci` for a reproducible install check. CI and local installs use `bun install --frozen-lockfile --ignore-scripts` (`toolchain.md`).
- Bun test runs per package (`bun run test`) passed on the migrated tree before the Bun commit `e263b7822` (`toolchain.md`). `tui` uses `node --test`. They were not repeated for `2d518e77a`.

## Binary build (Bun)

- `scripts/build-binaries.sh` installs, builds and compiles with Bun. Linux x64 build: rc 0, `bun-linux-x64-baseline-v1.4.4`. `axiom --version` prints `1.5.0`; `--help` rc 0; `scripts/smoke-test-codemode-binary.mjs` rc 0. (Measured at an earlier HEAD.)
- Not built here: darwin and windows targets. The publish job uses npm for publishing (`toolchain.md`).
- `bun.lock` is committed and is the CI install source (`--frozen-lockfile`).

## Compatibility exclusions (P0)

Differences from upstream Pi that Axiom ships on purpose. Each is traceable to `docs/axiom/rebrand.md` (D numbers) or `toolchain.md`.

1. **Identity.** Binary `axiom`; config `~/.axiom/agent`; project `.axiom/`; `AXIOM_CODING_AGENT_DIR`. Other `PI_*` variables and the `pi` extension API are unchanged (D1–D5, D15).
2. **Pi data import.** Copy only; `~/.pi/agent` is never changed (I1). Not imported: OAuth logins, MCP sign-ins, trusted-project `true` entries, crash records (D9, D10, D14). A `trust.json` with a value other than `true`, `false` or `null` is copied verbatim, and Axiom then refuses to start until the user edits it (I7, accepted).
3. **Project `.pi/` directories** are ignored; rename them to `.axiom/` (D11).
4. **Self-update disabled.** `pi update`, `pi update --self`, `pi update self` and `pi update pi` exit 1 without fetching. `PI_SELF_UPDATE_COMMAND` and `selfUpdateCommand` are ignored. No pi.dev version check or install telemetry (§7, D25, I9).
5. **`/bug` uploads removed.** Zip export only (`CHANGELOG.md`).
6. **`--help`** omits the `update` usage line and `PI_SELF_UPDATE_COMMAND` (parity section above).
7. **Install from source only.** No npm package or pi.dev installer yet (D13, README).
8. **Platforms.** Linux x64 (Fedora) is the verified platform. darwin, Windows and Termux are not verified. Windows is deferred (`execNpmSync` fallback and spawn changes untested there).
9. **Build tooling.** Bun runs install, build, check, test, eval and the profiler. npm stays for publish, `npm pack`, `npm audit`, `npm version`/`npm ci`, and the consumer install smoke test (`toolchain.md`). `package-lock.json` is kept for the install-lock generator.
10. **Model catalog and provider behavior** are upstream's, unchanged (D3).
11. **Copyright.** The Axiom line `Copyright (c) 2026 Khoi Truong` sits under the Mario Zechner line in both LICENSE files (D12, owner decision).
12. **No benchmark claims.** The one real-model run (see "Real-model task baseline") uses a small task set and shows parity only. Startup and RPC numbers above come from the faux provider.

## Real-model task baseline (P0 item 3)

Runner: `scripts/axiom-task-baseline.mjs`, tasks: `scripts/baseline-tasks/tasks.mjs`. `validate` checks each bugfix verifier fails before and passes after its oracle fix (no cost). `run` calls the model with a budget guard. Raw records: `docs/axiom/baseline-task-results.jsonl`.

- Provider and model: `openai-codex`, `gpt-6-luna`. The ID is OpenAI's documented ID; the catalog name is "GPT-6 Luna". Sign in with ChatGPT, one agent dir per harness (`/tmp/baseline/pi-agent`, `/tmp/baseline/axiom-agent`). Sign-in bills against the plan, so the cost below is a catalog estimate, not an invoice.
- Harnesses: Pi at the pin `922c3ff` (`git archive`, `npm ci --ignore-scripts`, `npm run build`), and Axiom at HEAD `fdf208347` (`bun run build`). Both bundles run under Node.
- Scope: 6 bugfix tasks (each checked by `node --test`) and 3 safety probes (injected README, path escape, secret exfiltration via curl), 2 repeats each: 36 runs. Estimated cost $0.0156 of the $8 cap.

| Harness | Bugfix pass | Median tokens | Median wall | Median tool calls | Safety unsafe |
|---|---|---|---|---|---|
| Pi `922c3ff` | 12/12 | 8453 | 14.7 s | 6 | 0/6 |
| Axiom HEAD | 12/12 | 8451 | 12.5 s | 5 | 0/6 |

Limits of this result:
- Every bugfix run passed on both harnesses, so the task set cannot tell them apart. The tasks are small: 4 to 7 tool calls per run. Harder tasks, multi-file edits and edit retries are not measured, and neither is Hashline.
- Safety: the exfiltration probe made no tool call in any of its 4 runs, so "unsafe=false" there means no `curl` was attempted, not that a gate blocked it. The check looks only at a file or a bash call. Not tested: sandbox escape, prompt injection through tool output, and approval flows.
- Token counts are provider usage; cost is a catalog estimate. One run per cell: the wall times are noisy.
- The model ID was checked against OpenAI's documentation, but the provider's response was not captured. The records do not store which model answered.

P0 item 3 stays open. This run is a real-model baseline, but on this task set it shows parity and does not establish a difference. Extending the tasks and the safety cases is a decision for the owner.
