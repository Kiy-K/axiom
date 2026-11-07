# Axiom rebrand contract (P0)

Implementation contract for "Rebrand binaries/package/docs/config carefully; preserve existing Pi user data and import/migration path" ([#1](https://github.com/Kiy-K/axiom/issues/1)). Paths are repo-relative; `cad/` = `packages/coding-agent/src/`; `:N` = line at base `922c3ff2b`. Background: `docs/axiom/architecture.md` §7, `docs/axiom/upstream.md`. The canonical repo and tracker is `https://github.com/Kiy-K/axiom`.

**Terms**
- **Official distribution:** `PACKAGE_NAME === "@earendil-works/pi-coding-agent" && APP_NAME === "pi" && CONFIG_DIR_NAME === ".pi"` (today `cad/cli/startup-ui.ts:34-49`). Axiom is not official.
- **Legacy dir:** `join(os.homedir(), ".pi", "agent")`.
- **Target dir:** `getAgentDir()` with `AXIOM_CODING_AGENT_DIR` unset, i.e. `~/.axiom/agent` (`cad/config.ts:630`).
- **Import:** the one-time copy from the legacy dir to the target dir (§3).
- **Phone-home:** exactly these requests: `pi.dev/api/latest-version` (`cad/utils/version-check.ts:5`), `pi.dev/api/report-install` (`cad/modes/interactive/interactive-mode.ts:1475`), the installer API (`cad/package-manager-cli.ts:54`), the `/bug` upload (`cad/core/bug-report-upload.ts:20`), and `PI_ATTRIBUTION` headers (`cad/core/client-identity.ts:14`).

## 1. Decisions

| # | Decision | Rationale (code) |
|---|---|---|
| D1 | Set `packages/coding-agent/package.json:6-8` to `"piConfig": {"name":"axiom","configDir":".axiom"}`. These follow automatically: `APP_NAME`, `APP_TITLE`, `CONFIG_DIR_NAME`, `ENV_AGENT_DIR=AXIOM_CODING_AGENT_DIR`, `ENV_SESSION_DIR=AXIOM_CODING_AGENT_SESSION_DIR`, `axiom-debug.log` (`cad/config.ts:602-611,680`), help text (`cad/cli/args.ts:284-298,462-463`), `process.title` (`cad/cli/setup.ts:5`, `cad/rpc-entry.ts:6`), and terminal program status `app:"axiom"` (`cad/modes/interactive/program-status-reporter.ts:96`). | Single derivation point; no other code reads these names. |
| D2 | Rename the `pi` executable to `axiom` everywhere a build, smoke, nix or local-release script needs it: (a) `packages/coding-agent/package.json:9-11` bin `axiom`; `:35` `--outfile dist/axiom`. (b) `scripts/build-binaries.sh:3,18-23` comments; `:133,135` outfiles `axiom.exe`/`axiom`; `:168-173,182,184` archives `axiom-<platform>.{zip,tar.gz}` with wrapper dir `axiom`; `:196,198` echoes. (c) `.github/workflows/build-binaries.yml:94-99,112-117,238-243,268-273` archive names; `:170-183` `root="extracted/axiom"`, `binary=…/axiom[.exe]`. (d) `.github/workflows/nix.yml:130,131,133` `./result/bin/axiom`. (e) `nix/package.nix:95` `pname="axiom"`; `:120-121,128,155,162` `lib/axiom`; `:127,149` `bin/axiom`; `:170` `mainProgram="axiom"`. (f) `flake.nix:38,47,51` attribute `axiom`; `:44` `bin/axiom`; `:45` `"Axiom coding agent"`. (g) `scripts/local-release.mjs:50,147` archive names; `:58-67` shims `axiom.cmd`/`axiom.ps1`/`.bin/axiom[.cmd/.exe/.ps1]`; `:149,154,160` printed paths. (h) `scripts/coding-agent-smoke.mjs:36` `manifest.bin.axiom`; `scripts/coding-agent-smoke.test.mjs:36` fixture `bin: { axiom: … }`. (i) Lockfiles: hand-edit `package-lock.json:6210` to `"axiom": "dist/bundle/cli.js"`, then `node scripts/generate-coding-agent-install-lock.mjs` (rewrites `packages/coding-agent/install-lock/package-lock.json:523`) and `--check`; commit with `PI_ALLOW_LOCKFILE_CHANGE=1` (AGENTS.md). Unchanged and documented as upstream-only (publishing is disabled for Axiom because the upstream secrets are absent): source tarball `pi-${VERSION}-source.tar.gz` (`build-binaries.yml:64,73-74,109,235,265`), install-lock asset names (`:88-89,118-119`), every npm/R2/pi.dev publish step, `pi-env` daemon names, and install-lock `resolved` URLs (`scripts/generate-coding-agent-install-lock.mjs:207`, which point to upstream tarballs and are not Axiom artifacts). | Each listed line hardcodes the bin or archive name the next step reads; for example `local-release.mjs:51` `cpSync`s the archive name, and `nix.yml:130` runs `bin/pi`. |
| D3 | Unchanged; record each in `docs/axiom/upstream.md` "Compatibility exclusions": `@earendil-works/*` names and import specifiers; the `pkg.pi` manifest key (`cad/core/pi-manifest.ts:21-33`); the `pi` extension API variable; the `pi-ai` bin; UA `pi/<v>` (`packages/ai/src/utils/identity.ts:6-8`); `originator:"pi"`, the xAI `referrer`, the `pi-gateway` OAuth client ID, MCP `clientInfo.name`, `AI_AGENT="pi"` (`cad/cli/setup.ts:7`); the `pi-messages`/`pi-virtual` API ids; temp-file prefixes; the system prompt bytes (`cad/core/system-prompt.ts:156,162`; director Q1); pi.dev hosts for the model catalog (`cad/core/remote-catalog-provider.ts:14`), share viewer (`cad/config.ts:617`) and MCP OAuth documents (director Q5); `update [source\|self\|pi]` input tokens (`cad/package-manager-cli.ts:299,561`); prose naming Pi in managed-install paths (`package-manager-cli.ts:123,206`) and comments. | Renaming these breaks third-party packages, user `models.json`, or server allowlists, and each is an upstream merge-conflict site (`upstream.md` §4). |
| D4 | No `AXIOM_*` aliases for any other `PI_*` var (`PI_OFFLINE`, `PI_TIMING`, `PI_TELEMETRY`, …), the bash-tool exports (`cad/core/tools/bash.ts:222-236`), or `PI_CODING_AGENT=true`. | That would mean about 40 read sites in 4 packages, all conflict points, with no new capability. These names are API. |
| D5 | `PI_CODING_AGENT_DIR` / `PI_CODING_AGENT_SESSION_DIR` neither override Axiom's dirs nor act as an import source. If `PI_CODING_AGENT_DIR` is set and the import would otherwise run, Axiom prints one hint and skips (§3). | Scripts set `PI_CODING_AGENT_DIR` to temp dirs for isolation while keeping the real `HOME` (e.g. `scripts/smoke-test-codemode-binary.mjs:136`, `.github/workflows/issue-analysis.yml:359`). Using it as a source would freeze the real target with junk (review #2). A fallback override would make Axiom write into Pi's live dir. |
| D6 | `cad/config.ts` exports `IS_OFFICIAL_DISTRIBUTION` (the constants move from `cad/cli/startup-ui.ts:34-49`). `shouldRunFirstTimeSetup` (:131) uses it, so first-time setup stays off for Axiom. | The dialog sets `enableAnalytics` for upstream analytics (`startup-ui.ts:191-194`); forks are excluded by upstream design. The constant also avoids `version-check`/`telemetry` importing TUI code. |
| D7 | MCP OAuth: no code change. `oauth.ts:169-172` already uses DCR with `client_name:"axiom"` when `APP_NAME !== "pi"` and the setting is `auto`. The resulting `auth/basic-cimd` changes in `packages/coding-agent/test/mcp-conformance/baseline.json` are accepted (record in `upstream.md`); changes in any other scenario are bugs. | pi.dev's client document names Pi. Explicit `"cimd"` still uses it (user choice). |
| D8 | Phone-home off when `!IS_OFFICIAL_DISTRIBUTION`, through three guards. (1) `getLatestPiRelease` (`cad/utils/version-check.ts:51`) returns `undefined` first thing. This disables the update notice (`checkForNewPiVersion` :101) and every self-update: `getSelfUpdatePlan` (`package-manager-cli.ts:692-703`) throws `Could not determine latest axiom version.`, caught at `:1229-1233` with exit 1. The npm, managed and configured install paths all run only after the plan (`:1149-1200`), so Axiom is never replaced by Pi. (2) `isInstallTelemetryEnabled` (`cad/core/telemetry.ts:8`) returns `false` before reading `PI_TELEMETRY`. This covers `report-install` and attribution. (3) `/bug` (`cad/modes/interactive/bug-report.ts`): delivery choices become `["Export as Zip","Cancel"]` (:137); the `:138` text drops the upload sentence; `DISCLAIMER` (:45) becomes `"This report stays on your machine as a zip. Attach it to an issue at https://github.com/Kiy-K/axiom/issues. It includes your axiom version, …"` (rest unchanged); `interactive-mode.ts:2294` becomes `` `If this looks like a ${APP_NAME} bug, /bug exports a report for https://github.com/Kiy-K/axiom/issues.` `` | `PACKAGE_NAME` stays upstream (`config.ts:603`), so a working self-update would run `npm i -g @earendil-works/pi-coding-agent`. Install pings default on (`settings-defaults.ts:32`). `/bug` sends transcripts to the Pi developers (`bug-report.ts:45`). These three guards are the only callers (grep: `getLatestPiRelease` is used only at `version-check.ts:94,101` and `package-manager-cli.ts:695`). |
| D9 | Import the legacy dir per §3. | The roadmap requires preserving Pi data. |
| D10 | `trust.json`: keep only `false` entries; omit the file if none remain; copy it verbatim if it does not parse as a JSON object or if any value is not `true`, `false` or `null`. | `true` approved `<project>/.pi/` code (`cad/core/trust-manager.ts:30-39,198`), but Axiom loads the unreviewed `.axiom/`. Keeping `false` stops `defaultProjectTrust:"always"` (`cad/core/project-trust.ts:78-80`) from trusting a refused project. Invalid input fails closed in Pi (`trust-manager.ts:106-131`) and must in Axiom too. A value such as `"false"` (a string) is a decision Axiom cannot read: dropping it would turn a refusal into auto-trust, so the whole file is copied and Axiom fails as Pi does. Known effect: lookup walks to the nearest ancestor with `true\|false` (`trust-manager.ts:50-65`), so a dropped `true` under a kept `false` parent resolves to distrusted without a prompt. This is fail-safe; the user runs `/trust`. |
| D11 | Project `<repo>/.pi/` is ignored (no fallback, no hint; director Q3). | A fallback doubles discovery and trust surfaces. `AGENTS.md`, `CLAUDE.md` and `.agents/skills` keep working. |
| D12 | Copy root `LICENSE` to `packages/coding-agent/LICENSE` (npm packs it automatically). `scripts/build-binaries.sh` gains `cp ../../LICENSE "$OUTPUT_DIR/$platform/"` after :145. Keep the Mario Zechner notice. Add **no** Axiom copyright line in P0 (director Q2). Whether to add one later is a legal choice for the owner. Add `cmp LICENSE packages/coding-agent/LICENSE` to the `upstream.md` sync checklist. | The MIT notice is not shipped today (`upstream.md` §3). Deferred: `legalComments:"none"` (`scripts/build-coding-agent-bundle.mjs:86`) and the photon Apache-2.0 text. |
| D13 | Docs. Rewrite the intro, install and paths sections of root `README.md` and `packages/coding-agent/README.md`: "Axiom, a fork of [Pi](https://github.com/earendil-works/pi), MIT", install from source only (`git clone https://github.com/Kiy-K/axiom && cd axiom && bun install --ignore-scripts && bun run build`, then `alias axiom="bun $PWD/packages/coding-agent/dist/bundle/cli.js"`), the `~/.axiom/agent` and `.axiom/` paths, the import (§3) and its limits. At the top of `packages/coding-agent/README.md` add: "Docs under docs/ say `pi`, `~/.pi/agent`, `.pi/`; in Axiom read `axiom`, `~/.axiom/agent`, `.axiom/`. `PI_*` env vars and the `pi` extension API are unchanged." Leave `docs/**`, other READMEs and released CHANGELOG sections untouched. | No Axiom release archive exists (review #13). `docs/extensions.md` alone has 326 hits, mostly about the unchanged API. Install commands moved to Bun with the Bun migration (`docs/axiom/toolchain.md`). |
| D14 | Not imported: OAuth credentials. From `auth.json`, drop every entry whose `type` is `"oauth"` (shape: `cad/core/auth-storage.ts:230-254`). Keep the other entries, write with the source mode (0600), and omit the file if empty. Copy verbatim if it does not parse as a JSON object. Skip `mcp-auth.json` entirely (`cad/extensions/mcp/oauth.ts:72`). | Sharing a refresh token lets the first client to refresh rotate it [INFERENCE: provider-dependent] and sign out the other, which damages Pi data (review #19). MCP tokens were issued to pi.dev's CIMD client, but Axiom refreshes as a DCR client (D7). |
| D15 | User-visible commands and paths use the brand. `cad/cli/auth-command.ts:41-45` `pi auth` → `${APP_NAME} auth`; `:48` → `` `Credentials are stored in ~/${CONFIG_DIR_NAME}/agent/auth.json.` ``. `cad/extensions/mcp/cli.ts:567` and `cad/extensions/mcp/index.ts:806,1020`: `.pi/mcp.json` → `${CONFIG_DIR_NAME}/mcp.json`. `cad/modes/interactive/interactive-mode.ts:2285` `"start pi and"` → `` `start ${APP_NAME} and` ``; `:4409` `restart pi.` → `` `restart ${APP_NAME}.` ``. `cad/cli/args.ts:293` `Update pi,` → `Update ${APP_NAME},`. | These lines tell the user a command to type or a path to edit (review #10). Other prose stays (D3). |

## 2. Interfaces

```ts
// cad/config.ts (D6)
/** Whether this build is upstream Pi; forks and rebrands get false. */
export const IS_OFFICIAL_DISTRIBUTION: boolean;

// cad/pi-data-import.ts (new file; one concept: one-time import of Pi's agent dir)
export type PiDataImportSkip = { path: string; reason: "symlink" | "special" | "unreadable" };
export type PiDataImportResult =
	| { kind: "imported"; source: string; target: string; files: number; skipped: PiDataImportSkip[]; droppedOAuth: string[] }
	| { kind: "skipped"; reason: "info-command" | "custom-agent-dir" | "target-exists" | "pi-dir-env" | "no-source" | "overlap" }
	| { kind: "failed"; source: string; target: string; error: string };
/** Copy Pi agent dir `source` (already realpath'd) to absent `target` via a temp dir and one rename; never writes under `source`. */
export function importPiAgentDir(source: string, target: string): PiDataImportResult;
/** CLI entry: decide whether to import, run it, and report on stderr only. */
export function runPiDataImport(args: string[], env: NodeJS.ProcessEnv = process.env): PiDataImportResult;
```

- The caller is `cad/main.ts:main`. Call `runPiDataImport(args)` right after the offline block (:626-630), before `runAuthCommand` (:632), because the agent dir is first read inside `runAuthCommand` (`main.ts:138`). This covers interactive, `-p`, `--mode json`, `--mode rpc` (`cad/rpc-entry.ts:13`), `auth`, and package commands. Library callers of `createAgentSession` never import; SDK callers of the exported `main()` (`cad/index.ts:421`) do.
- `runPiDataImport` owns every `skipped` reason. `importPiAgentDir` returns `imported`, `failed`, or `target-exists` (rename race only).
- `cad/migrations.ts:runMigrations` (:305) is not reused: it runs later (`main.ts:727`) and only inside one agent dir.

## 3. Import specification

`runPiDataImport(args, env)`. The first matching rule wins:
1. `args` contains `-v` or `--version` → `info-command`. (`--help` still imports: the smoke test showed that printing help creates the agent dir, which would block every later import.)
2. `env[ENV_AGENT_DIR]` is non-empty → `custom-agent-dir`.
3. `lstat(target)` succeeds (any type) → `target-exists`.
4. `realpath(legacy dir)` fails, is not a directory, is not readable (probe `openSync(S,"r")`), or contains none of `auth.json`, `settings.json`, `models.json` (via `stat`: regular file) or `sessions` (via `stat`: directory) → `no-source`.
5. Overlap. Let `T` be `realpath` of the nearest existing ancestor of `target`, joined with the remaining segments. If `T` equals `S = realpath(legacy)`, or either starts with the other plus `path.sep` → `overlap`.
6. `env.PI_CODING_AGENT_DIR` is non-empty → `pi-dir-env`. Only reached when the import would otherwise run. Print one stderr line: `Pi data in <S> is not imported because PI_CODING_AGENT_DIR is set. To import it, unset PI_CODING_AGENT_DIR before axiom's first start: the import runs only while <target> does not exist.` The wording says "before the first start" because a run with the variable set still creates `<target>` (Axiom ignores the variable, D5), and after that the import is blocked by rule 3. It never prints a copy command: a manual `cp -a` would copy `trust.json` and `auth.json` unfiltered (D10, D14), and an unquoted path breaks on spaces.
7. Remove stale temps. These are entries of `dirname(target)` that match `/^\.agent-import-/`, are real directories (`lstat`), and have an mtime older than 1 h. Remove each with make-writable (`chmod` dirs `0o700`, depth-first) then `rmSync({recursive:true, force:true})`; ignore errors.
8. Print `Importing Pi data from <S> to <target>; <S> is not changed.` to stderr. Call `importPiAgentDir(S, target)`, then report (below).

`importPiAgentDir(S, target)`:
1. `mkdirSync(dirname(target), {recursive:true, mode:0o700})`; `temp = mkdtempSync(join(dirname(target), ".agent-import-"))` (mode 0700).
2. Walk `S` depth-first in name order. For each entry `p` (relative path `rel`), use `lstat`:
   - **Top-level excludes** (silently not copied): `tmp`, any name ending in `.lock` (proper-lockfile dirs `auth.json.lock`, `settings.json.lock`, `trust.json.lock`, `mcp-auth.json.lock`, `mcp-auth-refresh-*.lock`), `pi-debug.log`, `pi-tui-debug.log`, `pi-tui-crash.log`, `crashes.json` (`cad/core/crash-log.ts:21-22`, `packages/tui/src/tui-main-screen.ts:329,524`), and `mcp-auth.json`. These rules apply to top-level names only; e.g. `git/x/yarn.lock` is copied.
   - **Top-level filtered:** `trust.json` (D10) and `auth.json` (D14). Read with `readFileSync` (this follows links). Write the filtered or verbatim bytes with `writeFileSync(dst, data, {flag:"wx", mode})`, then `chmodSync(dst, srcMode & 0o7777)` and `utimesSync(dst, srcAtime, srcMtime)`.
   - **Directory:** `readdirSync` first; on `EACCES`/`EPERM`, skip as `unreadable` and create nothing. Then `mkdirSync(dst, {mode:0o700})`, recurse, and after the children `chmodSync(dst, mode & 0o7777)` and `utimesSync`.
   - **Regular file:** probe with `openSync(p,"r")` + `closeSync`; a probe error (`EACCES`/`EPERM`/`ENOENT`/`ELOOP`) means skip as `unreadable`. Then `copyFileSync(p, dst, COPYFILE_EXCL | COPYFILE_FICLONE)`, `chmodSync`, `utimesSync`.
   - **Symlink**, with text `L = readlinkSync(p)`: if `realpath(p)` is a top-level excluded or filtered file (`TOP_LEVEL_EXCLUDES`, `*.lock`, `trust.json`, `auth.json`), skip as `symlink`. Else if `L` is relative, `realpath(p)` lies inside `S`, and `resolve(T, dirname(rel), L)` lies inside the final `target` `T`, recreate it verbatim with `symlinkSync(L, dst)`. The check uses `T`, not the temp dir: the copy is renamed into place, and a link may leave the tree and re-enter it by name. Else, if `stat(p)` is a regular file, copy its content as a regular file (probe, copy, then mode and mtimes of the link target). Otherwise (directory outside, dangling, loop, special) skip as `symlink`.
   - **Other** (FIFO, socket, device): skip as `special`.
3. Set the root `temp` mode and mtimes from `S`. Then `renameSync(temp, target)`. If `rename` throws and `lstat(target)` now succeeds, remove `temp` (make-writable, rm) and return `target-exists`.
4. Any other error after step 1 (write side: `ENOSPC`, `EDQUOT`, `EIO`, `EROFS`, a rename error, …): make `temp` writable, remove it, and return `failed`.

Reporting (stderr only; never stdout):
- `imported`: print `Imported Pi data (<files> files).`. If `droppedOAuth` is non-empty, print `OAuth logins not imported: <ids>; run "axiom auth login <provider>".`. Always print `Not imported: trusted projects (you will be asked again) and MCP sign-ins.`. Then one line per skip, `  skipped <rel> (<reason>)`, at most 20, then `  … and <k> more`.
- `failed`: print `Pi data import failed: <error>. Nothing in <S> was changed. Axiom continues with a new empty <target>; to retry, quit axiom, delete <target> (this deletes what axiom saved there) and start axiom.`

**Invariants**
- **I1:** nothing under `S` is created, written, renamed, deleted, chmod'ed or utime'd. No copied symlink lets a later Axiom write reach `S`: only relative in-tree links are kept.
- **I2:** after any return, `target` is absent or complete, and no `.agent-import-*` from this call remains. An interrupted import's temp is removed by the next attempt after 1 h.
- **I3:** a symlink is dereferenced only to copy a regular file's content or to test containment.
- **I4:** file and dir modes and mtimes are preserved (`auth.json` 0600; `bin/*` executable; session mtimes keep `SessionManager.list` order).
- **I5:** stdout is byte-identical with or without an import.
- **I6:** an import runs at most once per target.
- **I7:** no `true`/`null` trust entry and no `type:"oauth"` credential reaches the target. Exception: a `trust.json` or `auth.json` that Axiom cannot read is copied verbatim (D10, D14). Axiom refuses to apply such a trust file (`trust-manager.ts:124-127`, fail closed), so no trust decision is taken from its `true` entries. Known effect, accepted: Axiom then refuses to start (`Invalid trust store …: value for "<key>" must be true, false, or null`) until the user edits that `trust.json`. Observed in a smoke run of the built CLI.
- **I8:** no import when `AXIOM_CODING_AGENT_DIR` or `PI_CODING_AGENT_DIR` is set, or for `--version`.
- **I9:** a non-official build makes no phone-home request (Terms).

Copied data is not rewritten. Absolute paths into `S` inside settings, `models.json` or session headers (`parentSession`) keep resolving, because `S` is not modified. A `sessionDir` setting (shared directory) is copied verbatim, so Pi and Axiom then share that directory (CHANGELOG).

## 4. Test plan (packages/coding-agent/test/)

New file `pi-data-import.test.ts`. Temp `HOME` only; pass `env` explicitly; skip mode/FIFO/root-sensitive cases on win32 or when `process.getuid?.() === 0`.
1. A full tree (nested, unicode/space names, `npm/node_modules`) copies byte-equal; `files` is counted. A nested `git/r/yarn.lock` is copied. Top-level excludes are absent.
2. `auth.json` (0600) keeps only non-oauth entries and lists the oauth ids in `droppedOAuth`. All-oauth gives no file. Invalid JSON is copied verbatim. `mcp-auth.json` is absent.
3. `trust.json` `{a:true,b:false,c:null}` becomes `{b:false}`. All-true gives no file. Invalid JSON, or any value other than `true`/`false`/`null` (e.g. `"false"`), is copied verbatim.
4. Modes: file 0755, a dir 0750 and a dir 0555 with children are preserved after import. Session mtimes are preserved.
5. The source snapshot (paths, bytes, modes, mtimes, link texts) is equal before and after, for `imported` and for `failed` (I1).
6. Symlinks:
   - (a) relative in-tree file link and (b) relative in-tree dir link are kept with the same `readlink`;
   - (c) an absolute link to an outside file becomes a regular file, and writing the copy leaves the outside file unchanged;
   - (d) an absolute link to an in-tree file becomes a regular file;
   - (e) a link to an outside dir, (f) a dangling link and (g) a loop are skipped as `symlink`;
   - (h) a FIFO is skipped as `special`;
   - (i) a legacy dir that is itself a symlink is copied from its realpath.
7. An unreadable file (chmod 000) gives `imported`, with that path skipped as `unreadable`.
8. Failure: mock `fs.copyFileSync` to throw `ENOSPC` on the 2nd call. Expect `failed`, `target` absent, no `.agent-import-*`, source unchanged.
9. `runPiDataImport` reasons:
   - `info-command` (`-v`, `--version`; `--help` imports);
   - `custom-agent-dir`;
   - `target-exists` (empty dir, file, non-empty dir); target untouched;
   - `pi-dir-env` (one stderr line, no writes);
   - `no-source` (missing dir; empty existing dir; only `foo.txt`);
   - `overlap` (`~/.axiom` is a symlink to `~/.pi`).
   For each, assert no fs writes outside the expected.
10. Stale temps: an `.agent-import-old` with mtime −2 h is removed; `.agent-import-new` (now) is kept.
11. Race: two child processes import concurrently. Exactly one `imported` and one `target-exists`; the target is complete; no temps remain.
12. CLI: spawn `cad/cli.ts` like `session-file-invalid.test.ts`, with a temp `HOME` containing `.pi/agent/settings.json`, no agent-dir env, args `--offline --list-models`. Run 1: stderr contains the source and target paths and stdout equals stdout of a run without a legacy dir. Run 2: no import lines. Do not pin sentences.

Making `IS_OFFICIAL_DISTRIBUTION` controllable per test:
```ts
const dist = vi.hoisted(() => ({ official: true }));
vi.mock("../src/config.ts", async (orig) => ({ ...(await orig()), get IS_OFFICIAL_DISTRIBUTION() { return dist.official; } }));
```

Update existing tests (contract tests: update, do not weaken):
- `config.test.ts`: add `APP_NAME==="axiom"`, `CONFIG_DIR_NAME===".axiom"`, `ENV_AGENT_DIR==="AXIOM_CODING_AGENT_DIR"`, `IS_OFFICIAL_DISTRIBUTION===false`, and `getAgentDir()` ignores `PI_CODING_AGENT_DIR`.
- `first-time-setup.test.ts`: mock `IS_OFFICIAL_DISTRIBUTION:true`. `first-time-setup-fork.test.ts`: remove the `PACKAGE_NAME` mock (:6-12); unmocked Axiom must return false.
- With the hoisted mock (official by default, plus new `dist.official=false` cases):
  - `version-check.test.ts`: Axiom → `getLatestPiRelease` resolves `undefined`, no fetch.
  - `sdk-client-identity.test.ts` (:149-155): Axiom with `PI_TELEMETRY=1` → `attribution: null`.
  - `package-command-paths.test.ts` (self-update cases :103 onwards): Axiom `update` → exit code 1, no fetch to `pi.dev`, no spawn.
  - `bug-report.test.ts`: Axiom choices contain no `Upload Report`; zip export works.
- `mcp-oauth-refresh.test.ts`: mock `APP_NAME:"pi"` for the file (:239,274 rely on it). New `mcp-oauth-rebrand.test.ts` (unmocked): `auto` registers by DCR with `client_name` equal to `APP_NAME`. `suite/agent-session-mcp-oauth.test.ts:203`: expect `[APP_NAME]`.
- Wording rule: an assertion on `APP_NAME`-derived text uses `${APP_NAME}`, and PATH or `.bin` shims are named `APP_NAME`. Known sites:
  - `package-command-paths.test.ts:72,500,646,661,682,742,801,820,851,884,911,934,936,973,1031,1077,1169,1172,1222`;
  - `auth-login.test.ts:147,178,192,220`; `credential-print.test.ts:92`; `mcp-command.test.ts:113`;
  - `interactive-mode-bug-report-hint.test.ts:22`; `resource-loader.test.ts:106,127,149`; `program-status-reporter.test.ts:54` (`app: APP_NAME`); `package-distribution.test.ts:5,19` (`bin.axiom`).
  After `./test.sh`, any remaining failure whose only diff is `pi`→`axiom` in such text gets the same fix; any other failure is a bug.
- `.pi` literals → `CONFIG_DIR_NAME` in `resource-loader`, `settings-manager`, `settings-manager-bug`, `package-manager`, `package-command-paths`, `mcp-command`, `mcp-extension`, and `interactive-mode-status` (:1340-1390, `~/${CONFIG_DIR_NAME}/agent`). Leave `crash-log.test.ts` (path data) and `fixtures/*.jsonl`.
- `PI_CODING_AGENT_DIR` → `ENV_AGENT_DIR` in `rpc.test.ts:23`, `theme-export.test.ts:25-35,62,84,117`, `theme-picker.test.ts:23,43`, `suite/regressions/2791-fswatch-error-crash.test.ts:54,93`. Use the literal `AXIOM_CODING_AGENT_DIR` in `scripts/smoke-test-codemode-binary.mjs:136`, `scripts/coding-agent-smoke.mjs:21` (path `join(home, ".axiom", "agent")`), `scripts/profile-coding-agent-node.mjs:16,37`, `packages/evals/src/harness.ts:83`, `packages/evals/test/harness.test.ts:49`, `packages/evals/docker/entrypoint.ts:115`, and `packages/evals/src/docker.ts:69` (fallback `join(homedir(), ".axiom", "agent")`). `packages/ai/test/openai-codex-stream.test.ts` stays (pi-ai never reads the var).
- `main()` in-process tests: `credential-print.test.ts` adds `vi.stubEnv(ENV_AGENT_DIR, <tmp>)`. `deleted-cwd.test.ts` uses `--version` (skipped by rule 1). `package-command-paths.test.ts` already sets it (:162).
- Run: `npm run check`, `./test.sh`, `node --test scripts/*.test.mjs`, `npm run test:mcp-conformance` (D7); after `npm run build`, `node packages/coding-agent/dist/bundle/cli.js --version`, `npm pack --dry-run --ignore-scripts` in `packages/coding-agent` (lists `LICENSE`, bin `axiom`), `scripts/build-binaries.sh --platform linux-x64` (archive `axiom-linux-x64.tar.gz` holds `axiom/axiom` and `axiom/LICENSE`), `node scripts/smoke-test-codemode-binary.mjs packages/coding-agent/binaries/linux-x64/axiom`, and `nix build .#default && ./result/bin/axiom --version`.

CHANGELOG (`packages/coding-agent/CHANGELOG.md`, `## [Unreleased]` → `### Breaking Changes`): "Renamed the CLI to `axiom`: bin `axiom`, config `~/.axiom/agent`, project `.axiom/`, env `AXIOM_CODING_AGENT_DIR`/`AXIOM_CODING_AGENT_SESSION_DIR`; other `PI_*` env vars are unchanged. On first start Axiom copies `~/.pi/agent` to `~/.axiom/agent` without changing it. It does not import trusted projects (asked again), OAuth logins (run `axiom auth login`), MCP sign-ins, or crash records, and it skips the import when `PI_CODING_AGENT_DIR` or `AXIOM_CODING_AGENT_DIR` is set. A `sessionDir` setting is copied, so both apps then share that directory. Project `.pi/` dirs are not read; rename them to `.axiom/`. Axiom never contacts pi.dev for versions, install telemetry, or self-update (`axiom update` without `--extensions` exits 1), and `/bug` only exports a zip."

## 5. Rollback

1. `git revert <rebrand commits>` (never reset or force-push), then `bun install --ignore-scripts && bun run build`. The bin, paths and lockfiles return with the revert.
2. `~/.pi/agent` was never modified (I1) and Pi's OAuth tokens were never shared (D14), so Pi keeps working. To carry new Axiom sessions back: `cp -Rn ~/.axiom/agent/sessions/. ~/.pi/agent/sessions/`. Then `rm -rf ~/.axiom`.
3. To re-run only the import: quit axiom, `rm -rf ~/.axiom/agent` (this loses Axiom-only data), start axiom.

## 6. Out of scope (do not drift)

- Renaming npm packages or scope, import paths, `pkg.pi`, the `pi` API variable, `PI_*` vars, identity headers or UA, pi.dev hosts, temp prefixes, workflow secrets or publish steps, `issue-analysis.yml`, `pi-test.sh`/`.ps1`/`.bat`, `scripts/auto-pi.sh`.
- Any `axiom import`/`migrate` command; syncing back to Pi; rewriting paths inside copied files; disk-space pre-checks (`shortcut:` comment in the walk); a cross-process import lock.
- The repo's own `.pi/` (known stale after D2: `.pi/skills/release.md:16-31`); `examples/extensions/subagent/index.ts:309` (spawns `pi`); apps/p2, durable, env, chord (`apps/p2/src/hosts/tui-local-preferences.ts:40` keeps `PI_CODING_AGENT_DIR`).
- Logo and assets, easter eggs, Radius copy, system prompt text, `docs/**`, released CHANGELOG sections, `legalComments`, third-party notice bundling, npm publishing.

## 7. Self-update: disabled until Axiom has a release build

**Current state.** In non-official builds (`IS_OFFICIAL_DISTRIBUTION` false), `axiom update` and `axiom update --self` print `Self-update is disabled ...` and exit 1 before any fetch or spawn. `PI_SELF_UPDATE_COMMAND` and `selfUpdateCommand` are disabled with them. The help omits the `update` usage line, the `update` entry in the `<command> --help` list, and `PI_SELF_UPDATE_COMMAND`. `axiom update --extensions` and `--models` still run. `--all` runs the extension update first, then exits 1 for self.

**Why.** Self-update installs upstream Pi (`@earendil-works/pi-coding-agent` from pi.dev's release feed). Axiom has no release feed of its own, so enabling it would replace Axiom with Pi. Review row 25 records the decision; D8 describes the earlier guard.

**Re-enable (after Axiom publishes its own release build):**
1. Decide the feed: where Axiom's latest version is published, and the package name it installs. Keep `PACKAGE_NAME` and `APP_NAME` consistent with it.
2. `packages/coding-agent/src/utils/version-check.ts`: `getLatestPiRelease` returns `undefined` for `!IS_OFFICIAL_DISTRIBUTION`. Point it at Axiom's feed for non-official builds. Leave pi.dev out of Axiom builds.
3. `packages/coding-agent/src/package-manager-cli.ts`: delete the `if (!IS_OFFICIAL_DISTRIBUTION)` block that prints `Self-update is disabled` (search for that string), and the pointer comment above it.
4. `packages/coding-agent/src/cli/args.ts`: restore the `update [source|self|pi]` usage line, the `update` entry in the `<command> --help` list, and the `PI_SELF_UPDATE_COMMAND` env line.
5. `packages/coding-agent/test/package-command-paths.test.ts`: replace the test named "disables self-update in a forked distribution..." with positive tests against Axiom's feed. The official self-update tests in the same file show the pattern.
6. `packages/coding-agent/CHANGELOG.md` `[Unreleased]` Breaking Changes, the rebrand bullet: remove the self-update clause. `README.md` (the "Axiom does not check pi.dev for updates ... self-update" line) and the `upstream.md` "Kept as is" table: update the self-update wording.
7. Verify: `bun run check`, `./test.sh`, and `axiom update --self` against a real Axiom release from a clean HOME. Confirm it installs the new version and that `axiom --version` reports it.

Do not re-enable by reverting the disable commit alone. It would pull in the pre-release code paths without a feed.

## Review log (`/tmp/goldfish-contract-review.md`)

| # | Resolution |
|---|---|
| 1 | Accepted. D2 now lists `nix.yml`, all `local-release.mjs` lines, `flake.nix:38,45,51`, `build-binaries.sh:3,18-23,196,198`, `package.json:35`, and the smoke fixture. |
| 2 | Accepted, stricter. D5: `PI_CODING_AGENT_DIR` is never a source (rule 6 skips with a hint, only after the source checks pass). The source needs a marker file (rule 4). All sites are renamed in §4; tests 9 and 12. |
| 3 | Accepted. Excludes are top-level only and named; nested `yarn.lock` is tested (test 1). |
| 4 | Accepted. `crashes.json`, `pi-tui-*.log`, `pi-debug.log` and `mcp-auth.json` are excluded. |
| 5 | Accepted. Read-side errors go to `unreadable` skips; `failed` is only for write-side errors, with an accurate retry message; tests 7 and 8. |
| 6 | Accepted. Dirs are created 0700 and chmod'ed and utime'd after their children; cleanup makes the tree writable first; test 4 (0555). |
| 7 | Accepted, using the safer variant: only relative in-tree links are kept; outside file links are copied as content; everything else is skipped; tests 6a-6i. |
| 8 | Accepted, amended in implementation: rule 1 skips only `--version` (help creates the agent dir); there is a pre-copy notice; `COPYFILE_FICLONE`; stale temps are removed after 1 h; no import lock (§6). |
| 9 | Accepted. §4 gives the hoisted getter mock, the wording rule, the known sites, and the `main()` callers. |
| 10 | Accepted. D15 lists the replaced literals. |
| 11 | Accepted. D8 is three guards; the self-update chain is verified (`package-manager-cli.ts:692-703,1149-1233`). |
| 12 | Accepted. D7 is no code change; the conformance `auth/basic-cimd` change is accepted and recorded. |
| 13 | Closed by the director (Q4). Publishing is unchanged and upstream-only; D13 says install from source. |
| 14 | Accepted. Phone-home is defined by an endpoint list; the catalog is a D3 exclusion. |
| 15 | Accepted. The wording now says trusted projects are not imported; the ancestor effect is noted in D10. |
| 16 | Accepted. `pi-import.json` is dropped; skips are listed on stderr. |
| 17 | Accepted. Rule 5 `overlap`, compared via realpath of the nearest existing ancestor. |
| 18 | Accepted. §2 assigns ownership of each reason and notes that `main()` is an SDK export. |
| 19 | Accepted, stronger. D14 does not import OAuth or MCP tokens instead of only warning. |
| 20 | Accepted. D2(i) hand-edits the lockfile and runs the generator and `--check`; the `resolved` URLs are noted. |
| 21 | Accepted. `PI_PROGRAM_STATUS` `app:"axiom"` is in D1; test updated. |
| 22 | Accepted. No new check; `cmp` is in the `upstream.md` sync checklist (D12). |
| 23 | Accepted as known stale (§6). |
| 24 | Bun amendment (director, Bun is the project runtime). §5 rollback now uses `bun install --ignore-scripts && bun run build`. D13 install text and the §4 "Run:" line (`npm run check`, `npm run test:mcp-conformance`, `node --test`, `npm pack`) still show npm/node; read those as `bun run check` (verified under Bun) and the Bun equivalents. The repo's own `package.json` scripts, `test.sh` and `pi-test.sh` still call `node`/`npm` internally; that is a separate, unapproved change. |
| 25 | Director decision: self-update is disabled in Axiom builds until Axiom has its own release build. One guard at the top of the self branch in `package-manager-cli.ts` (`!IS_OFFICIAL_DISTRIBUTION`): `update` and `update --self` print `Self-update is disabled ...` and exit 1 before any fetch or spawn. `PI_SELF_UPDATE_COMMAND` and `selfUpdateCommand` are disabled with it. `--all` runs the extension update first, then exits 1 for self. This supersedes D8's `getSelfUpdatePlan` throw. The option to run a configured command with `{packageName}` only was built, tested, and reverted. Known wording gap: `CHANGELOG.md` line 8 says `axiom update` without `--extensions` exits 1, which is also true of `--models`; not fixed because the edit tool could not display that 844-byte line. |
| 26 | Minors from Goldfish fixed or accepted. (a) Orphan temp: temp trees are named `.agent-import-<pid>-XXXXXX`. The next start removes a tree whose pid no longer exists, without waiting for the one-hour age limit (`removeStaleTemps`, `importerIsGone`). Test: "removes temp dirs of a dead importer at once and keeps one whose importer is alive". (b) mtime drift: accepted, not fixable in Node. `fs.utimes` takes seconds as a double, about 240 ns resolution at current epochs, so copied mtimes can differ by up to ~120 ns (comment at `applyMetadata`). (c) `--help` no longer lists `update` or `PI_SELF_UPDATE_COMMAND` while self-update is disabled. The `update` subcommand's own help is unchanged. |
| 27 | License: `Copyright (c) 2026 Khoi Truong` added under the Mario Zechner notice in `LICENSE` and `packages/coding-agent/LICENSE`. |
