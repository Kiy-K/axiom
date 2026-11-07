# Toolchain: Bun and npm

Axiom runs its own commands with Bun. npm stays only where a step needs npm itself. This page lists both, and the lock-file differences between them.

## Runtime per task

| Task | Runtime | Where |
|---|---|---|
| CI install | `bun install --frozen-lockfile --ignore-scripts` (Bun 1.4.4 via `oven-sh/setup-bun`, pinned by SHA) | `.github/workflows/ci.yml` |
| Local install | `bun install --ignore-scripts` | `README.md` setup steps |
| Build, check, package scripts | `bun run` | root and `packages/*/package.json` |
| Tests | `bun run test`: `vitest --run` per package, `node --test` for `packages/tui` | `test.sh`, `ci.yml`, root `test` |
| Single-file Vitest run | `node node_modules/vitest/dist/cli.js --run <file>` (AGENTS.md) | run from the package root |
| Pre-commit | see below | `.husky/pre-commit` |

Pre-commit runs `scripts/check-lockfile-commit.mjs`, then `bun run check`. It also runs `(cd apps/p2 && bun run check)` when `packages/*`, `apps/p2/*` or root package/tsconfig files are staged, and `bun run check:browser-smoke` when `packages/ai`, `packages/web-ui`, `package.json` or `package-lock.json` are staged.

Filter fan-outs use `bun run --filter './packages/*'`. The `./` prefix is required. CI's `other` suite excludes two packages: `--filter '!./packages/coding-agent' --filter '!./packages/durable'`. `bun --cwd <dir> run <script>` prints Bun's usage text and exits 0 in Bun 1.4.4 without running the script, so the repo uses `cd <dir> && bun run <script>` or `--filter` instead.

## Remaining npm invocations (exceptions)

| Where | Command | Why it stays on npm |
|---|---|---|
| root `clean` | `npm run clean --workspaces --if-present` | Not ported. |
| root `eval` | `npm run eval --workspace=@earendil-works/pi-evals --` | Not ported. Argument passing through `bun run --filter` was not verified. |
| root `version:patch/minor/major` | `npm version`, `npm install --package-lock-only --ignore-scripts`, then `bun install --lockfile-only --ignore-scripts` | Writes `package-lock.json`, which stays (see below). The Bun step refreshes `bun.lock`. |
| root `version:set` | `npm version --workspaces --no-workspaces-update` | Not ported. |
| root `prepublishOnly`, `publish`, `publish:dry` | `npm run ...`, `node scripts/publish.mjs` | Publishing uses npm and npm trusted publishing. |
| `build-binaries.yml` publish job | `npm install -g npm@11.16.0`, `npm run check:package-install`, `node scripts/publish.mjs` | npm trusted publishing needs npm 11.16. The consumer smoke test packs and installs with npm. |
| `env.yml` | `npm pack --dry-run --json` | Checks the npm file list of `@earendil-works/pi-env`. |
| `npm-audit.yml` | `npm ci --ignore-scripts --no-audit --no-fund`, `node scripts/npm-audit.mjs` (runs `npm audit --omit=dev`), `npm audit signatures --omit=dev` | Audit and registry-signature checks are npm features. |

Messages that scripts print (for example "Run: npm run install-lock:coding-agent") are not invocations and are not listed.

## Lock files

- `bun.lock` is the CI install source (`--frozen-lockfile`).
- `package-lock.json` is kept. `scripts/generate-coding-agent-install-lock.mjs` reads it, and the version scripts write it. Changing the install-lock source is a separate decision.
- The pre-commit lockfile guard (`scripts/check-lockfile-commit.mjs`) reads only `package-lock.json`. Changes to `bun.lock` are not guarded and must be reviewed in the diff.

### Known differences (npm lock vs bun.lock)

Top-level placement differs for three packages. `bun.lock` hoists the newer copies and nests the older ones under the packages that need them:

| Package | `package-lock.json` top level | `bun.lock` top level | Other copy (`bun.lock`) |
|---|---|---|---|
| `agent-base` | 7.1.4 | 9.0.0 | `gaxios/https-proxy-agent/agent-base` 7.1.4 |
| `https-proxy-agent` | 7.0.6 | 9.1.0 | `gaxios/https-proxy-agent` 7.0.6 |
| `retry` | 0.13.1 | 0.12.0 | `p-retry/retry` 0.13.1 |

`bun.lock` also has no `resolved`, `license`, `engines`, `funding` or `deprecated` fields, which the npm lock records. The install-lock generator reads only `package-lock.json`, so this difference does not reach the installer output.

Consequence: `npm ci` and `bun install --frozen-lockfile` on the same commit produce different `node_modules` layouts. Both pass `./test.sh`.

## Verification

- Committed HEAD `e263b7822` (fresh `git archive` snapshot): `npm ci --ignore-scripts`, `npm run build`, `npm run check`, `./test.sh`, all exit 0. `./test.sh` took 288 s.
- Migrated tree before the commit: `bun install --frozen-lockfile --ignore-scripts`, `bun run build`, `bun run check`, `./test.sh`, all exit 0.
- `./test.sh` writes a 200 MiB archive under `TMPDIR`, so it needs that much free quota where `TMPDIR` lives. On a quota-limited tmpfs the export test fails with EDQUOT. The test now fails fast with that error instead of timing out (commit `0caca01fb`).
