# Pi baseline (pin 922c3ff, faux provider)

Keyless, no paid APIs. Harness: `scripts/axiom-baseline.mjs`. Raw data: `docs/axiom/baseline-pi-pin.json`.

## Environment

- Checkout: `/home/khoi/Projects/axiom` at `922c3ff2b`, `packages/` clean (verified before the run).
- Hardware: Intel i7-13620H, 16 cores, 15.3 GB RAM, x64. Fedora Linux 44, kernel 7.2.13.
- Runtime: Node v24.22.1 for every number below. Bun, the project runtime, is not measured yet. Run from source via `packages/coding-agent/src/cli.ts` with the repo's source resolver.

## Results

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

Parity probes (once, not per run):
- `--version`: exit 0, prints `1.5.0`.
- `--help`: exit 0. Stdout SHA-256 is in the JSON for diffing.
- Built-in tools with `--tools read,bash,powershell,edit,write,grep,find,ls`: bash, edit, find, grep, ls, powershell, read, write. Per-tool schema SHA-256 and the combined hash (`df1f4dc3a56f…`) are in `parity.builtinTools`.

## Reproduce

```sh
bun install --ignore-scripts && bun run hydrate:model-data   # once; fills gitignored provider data
bun scripts/axiom-baseline.mjs <repoDir> --runs 10 --warmup 1 --turns 30 --json out.json
bun scripts/axiom-baseline.mjs <repoDir> --bundle            # shipped bundle; needs bun run build
git worktree add /tmp/axiom-pin 922c3ff2bdea786b16c9b26680f22c2272251ffc   # pin copy, if the main checkout is dirty
```

The script reads `bin` and `piConfig.name` from the checkout's `packages/coding-agent/package.json`. It sets `<APP>_CODING_AGENT_DIR` (for example `PI_CODING_AGENT_DIR` today, `AXIOM_CODING_AGENT_DIR` after a rename). It needs no code changes to run before and after the rebrand. Compare two JSON files by diffing their `parity` sections, which hold the version, help hash, and tool schema hashes.

## Limitations

- Single host, Node 24.22.1. Run-to-run spread is small here; it says nothing about other hardware.
- Source mode only in this run. The bundled build (`--bundle`) was not measured.
- "Cold" means a fresh process and an empty agent dir. The OS page cache is warm after the warmup run.
- Startup wall includes the `/usr/bin/time` wrapper. RSS covers only the node process, so it is not comparable to the earlier 178.7 MB figure, which included a bash wrapper.
- Token counts are byte-based estimates, not tokenizer output or provider usage. The system prompt includes the cwd, so its size depends on the temp path length.
- The faux provider makes no network calls, so RPC latency is harness overhead, not model latency.
- **Variance concern:** this run does not reproduce the earlier measurements (TOTAL 207 ms, wall ~1.06 s). Those are 42% (TOTAL) and 27% (wall) higher than today's medians, far outside this run's spread (wall ±2%). The likely cause is the earlier run's `pi-test.sh` bash wrapper, a different cwd, or cache state. This is an [INFERENCE]; it was not isolated. Do not compare against the earlier numbers until that is resolved.
- **Not done:** a real-model task baseline (resolve rate, tokens, cost). It requires the user to choose provider, model, and budget.

## Fedora gate (P0)

Host: Fedora, Node 24.22.1, Bun 1.4.4. Each row is a separate run; logs are in `/tmp` and are not committed.

| Target | `npm ci` | `build` | `check` | `test.sh` |
|---|---|---|---|---|
| Pin `922c3ff` (`git archive`, lock as committed) | rc 0 | rc 0 | rc 0 | rc 0, after `npm run build:daemon` in `packages/env` |
| HEAD working tree, lock refreshed (`@types/bun@1.4.4` and `bun-types@1.4.4` added by `npm install --package-lock-only`), fresh copy | rc 0 | rc 0 | rc 0 | rc 0, `test.sh` builds the daemon first |

- `test.sh` at HEAD runs `npm run build:daemon --workspace packages/env` before the isolated run, as CI does. Without it, seven `packages/env` files fail with "Build the daemon first". The pin's `test.sh` has no such step, so the pin row needed the manual build.
- Pin coding-agent: 343 files and 3067 tests pass. HEAD copy: 346 files and 3093 tests pass.
- The root has no `hydrate` script at the pin or at HEAD. An earlier note that `npm run hydrate` passed was wrong.
- Bun at HEAD (`bun run test` per package): all workspace packages exit 0. `tui` uses `node --test`, so its tests run under Node; its log has no summary line.

## Binary build (Bun)

- `scripts/build-binaries.sh` installs, builds and compiles with Bun. Linux x64 build: rc 0, `bun-linux-x64-baseline-v1.4.4`. `axiom --version` prints `1.5.0`; `--help` rc 0; `scripts/smoke-test-codemode-binary.mjs` rc 0.
- Not built here: darwin and windows targets. The release job still uses Node for its `node scripts/*.mjs` helpers and `npm` for the publish job.
- No `bun.lock` is committed, so release builds resolve dependencies at build time.

## Parity

- The MCP conformance baseline has one accepted change (D7): `auth/basic-cimd` gains `client-registration` in its passing list, because Axiom registers by DCR. The run reports no regressions.
