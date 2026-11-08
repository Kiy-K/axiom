# Toolchain: Bun and npm

Axiom runs its own commands with Bun. npm stays only where a step needs npm itself. This page lists both, and the lock-file differences between them.

## Runtime per task

| Task | Runtime | Where |
|---|---|---|
| CI install | `bun install --frozen-lockfile --ignore-scripts` (Bun 1.4.4 via `oven-sh/setup-bun`, pinned by SHA) | `.github/workflows/ci.yml` |
| Local install | `bun install --ignore-scripts` | `README.md` setup steps |
| Install age gate | `bunfig.toml` `minimumReleaseAge` (Bun), `.npmrc` `min-release-age` (npm). Both refuse versions younger than 2 days; workspace packages are excluded. | `bunfig.toml`, `.npmrc` |
| Build, check, package scripts | `bun run` | root and `packages/*/package.json` |
| Tests | `bun run test`: `vitest --run` per package, `node --test` for `packages/tui` | `test.sh`, `ci.yml`, root `test` |
| Single-file Vitest run | `node node_modules/vitest/dist/cli.js --run <file>` (AGENTS.md) | run from the package root |
| Pre-commit | see below | `.husky/pre-commit` |

Pre-commit runs `scripts/check-lockfile-commit.mjs`, then `bun run check`. It also runs `(cd apps/p2 && bun run check)` when `packages/*`, `apps/p2/*` or root package/tsconfig files are staged, and `bun run check:browser-smoke` when `packages/ai`, `packages/web-ui`, `package.json` or `package-lock.json` are staged.

Filter fan-outs use `bun run --filter './packages/*'`. The `./` prefix is required. CI's `other` suite excludes two packages: `--filter '!./packages/coding-agent' --filter '!./packages/durable'`. `bun --cwd <dir> run <script>` prints Bun's usage text and exits 0 in Bun 1.4.4 without running the script, so the repo uses `cd <dir> && bun run <script>` or `--filter` instead.

## Remaining npm invocations (exceptions)

| Where | Command | Why it stays on npm |
|---|---|---|
| root `version:patch/minor/major` | `npm version`, `npm install --package-lock-only --ignore-scripts`, then `bun install --lockfile-only --ignore-scripts` | Writes `package-lock.json`, which stays (see below). The Bun step refreshes `bun.lock`. |
| root `version:set` | `npm version --workspaces --no-workspaces-update` | Not ported. |
| `prepublishOnly`, `publish`, `publish:dry` (root) | `bun run` for the chain; `node scripts/publish.mjs` for the publish itself | The publish step uses npm and npm trusted publishing. |
| `build-binaries.yml` publish job | `npm install -g npm@11.16.0`, `node scripts/publish.mjs --dry-run` | npm trusted publishing needs npm 11.16. The consumer smoke test (`bun run check:package-install`) packs and installs with npm inside the script. |
| `env.yml` | `npm pack --dry-run --json` | Checks the npm file list of `@earendil-works/pi-env`. |
| `npm-audit.yml` | `npm ci --ignore-scripts --no-audit --no-fund`, `node scripts/npm-audit.mjs` (runs `npm audit --omit=dev`), `npm audit signatures --omit=dev` | Audit and registry-signature checks are npm features. |
| `scripts/release.mjs` | `npm version`, `npm install --package-lock-only --ignore-scripts`, `npm ci --ignore-scripts` | The version bump writes `package-lock.json`. `npm ci` builds the npm layout the release checks use. |
| `scripts/package-artifacts.mjs`, `scripts/preview-packages.mjs`, `scripts/publish.mjs` | `npm pack --json`, `npm view`, `npm publish` | Packing and registry queries are npm features. |
| `scripts/local-package-install.mjs` | `npm install` of the packed tarballs into a consumer directory | The consumer smoke test installs as an npm user would. |
| `pnpm` (devDependency) | `scripts/local-package-install.test.mjs` runs pnpm to install a packed consumer, because pnpm is a supported consumer install path. Test-only. | `package.json` |

Messages that scripts print (for example "Run: bun run install-lock:coding-agent") are not invocations and are not listed.

## Lock files

- `bun.lock` is the CI install source (`--frozen-lockfile`) and the source of the pi.dev install lock (`scripts/generate-coding-agent-install-lock.mjs`).
- `package-lock.json` is written only by the npm release path (`version:*`, `scripts/release.mjs`). Development never refreshes it, and `bun run check` does not read it.
- The pre-commit lockfile guard (`scripts/check-lockfile-commit.mjs`) guards both `package-lock.json` and `bun.lock`. A staged change to either needs `PI_ALLOW_LOCKFILE_CHANGE=1`. The workspace-only exemption applies to `package-lock.json` alone, so a commit that also stages `bun.lock` needs the flag.

### Known differences (npm lock vs bun.lock)

Top-level placement differs for three packages. `bun.lock` hoists the newer copies and nests the older ones under the packages that need them:

| Package | `package-lock.json` top level | `bun.lock` top level | Other copy (`bun.lock`) |
|---|---|---|---|
| `agent-base` | 7.1.4 | 9.0.0 | `gaxios/https-proxy-agent/agent-base` 7.1.4 |
| `https-proxy-agent` | 7.0.6 | 9.1.0 | `gaxios/https-proxy-agent` 7.0.6 |
| `retry` | 0.13.1 | 0.12.0 | `p-retry/retry` 0.13.1 |

`bun.lock` has no `license`, `engines`, `funding` or `deprecated` fields, which the npm lock records, so the installer lock lacks them for external packages. The generator takes versions, `resolved` (rebuilt from the registry URL), `integrity`, dependencies, `os`, `cpu`, `libc` and `hasInstallScript` from `bun.lock`. The installer tree therefore follows Bun's resolution, not npm's. Current result: 122 packages (npm's lock gave 123), 24 changed versions, and no platform-specific packages in either.

Consequence: `npm ci` and `bun install --frozen-lockfile` on the same commit produce different `node_modules` layouts. Both pass `./test.sh`.

## Verification

- Committed HEAD `e263b7822` (fresh `git archive` snapshot): `npm ci --ignore-scripts`, `npm run build`, `npm run check`, `./test.sh`, all exit 0. `./test.sh` took 288 s.
- Migrated tree before the commit: `bun install --frozen-lockfile --ignore-scripts`, `bun run build`, `bun run check`, `./test.sh`, all exit 0.
- Bun-migration tree with the major-version bumps (vitest 5, TypeScript 7 in `apps/p2`, SDK majors, `diff` 9, `highlight.js` 11): `bun run build`, `bun run check`, `bun run test:scripts`, and per-package test runs for `chord`, `agent`, `ai`, `codemode`, `durable`, `env`, `evals`, `mcp`, `schema`, `telemetry`, `tui` all exit 0. `cd apps/p2 && bun run check` exits 0. `apps/p2` tests (`bun run test`) were not run: TUI tests need Node 26 and browser tests need `CHROMIUM_BIN`.
- `packages/coding-agent` has 4 failing tests, and they fail at HEAD too: `tools.test.ts` (spawn ENOENT message text), `agent-session-tool-orchestration` (codemode/tool_search active), `3592-no-builtin-tools-keeps-extension-tools` and `5109-exclude-tools` (built-in `job` tool present). `./test.sh` therefore stops at `packages/coding-agent` with exit 1.
- `./test.sh` writes a 200 MiB archive under `TMPDIR`, so it needs that much free quota where `TMPDIR` lives. On a quota-limited tmpfs the export test fails with EDQUOT. The test now fails fast with that error instead of timing out (commit `0caca01fb`).
