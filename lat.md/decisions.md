# Key design decisions

This section records the decisions that shape Axiom and the reasons behind them. It is a snapshot of what is implemented, not a history of proposals.

The contracts behind each decision are linked from its section. Where code and a contract disagree, the contract is the intent to restore; where a contract is marked open, that status is carried here too.

## Rebrand without breaking Pi compatibility

Axiom changes the brand, directories and phone-home behavior while leaving the extension API and environment-variable contract intact.

`piConfig` in `packages/coding-agent/package.json` is the single derivation point for `APP_NAME`, `APP_TITLE`, the `.axiom/` config directory and `AXIOM_*` directory overrides; [[packages/coding-agent/src/config.ts#IS_OFFICIAL_DISTRIBUTION]] then disables version checks, install telemetry and `/bug` uploads. Self-update is disabled because no Axiom release build exists.

The Pi agent directory is imported once, through [[packages/coding-agent/src/pi-data-import.ts#importPiAgentDir]], into `~/.axiom/agent` ([[packages/coding-agent/src/config.ts#getAgentDir]]). OAuth grants are dropped so the two clients cannot rotate each other's tokens; explicit "do not trust" decisions are kept but trust approvals are not. Project `.pi/` is ignored, and `PI_CODING_AGENT_DIR` is never an import source because isolation scripts set it. No `AXIOM_*` aliases were added for the roughly 40 `PI_*` read sites: those names are API. Contract: [[docs/axiom/rebrand.md]].

## Central permission gateway

One authoritative pre-execution decision governs every route where the model or an extension chooses what runs; routes that cannot be mediated in-process are documented rather than silently trusted.

The gateway sits in `manual` and `auto` modes. `auto` is only effective in an interactive TUI session and relaxes read/write dirs with task-bounded grants; shell commands get "allow once" only, project scripts and interpreters are never auto-allowed, and `git push` stays a hard-class ask. A taint latch and a small per-task approval budget, plus pre-edit copies, address prompt injection and recoverability. Edits to code-running files (`AGENTS.md`, hooks, task runners, `package.json`) are never trust-allowed. Denials explain the block and ask for a materially safer path.

The default mode remains unrestricted; the gate contract describes the mechanism's bounds, not a safe default. Contracts: [[docs/axiom/permissions.md]], [[docs/axiom/p4-closure-contract.md]], [[docs/axiom/p6-auto-mode-contract.md]].

## Sandboxed execution

Sandbox mode runs model tools in a Gondolin microVM and fails closed if the VM cannot start.

The guest sees a copy-on-write view of tracked project files, with secrets and ignored paths hidden and no network at the VM boundary. `read`, `write`, `edit`, `ls`, `bash` and `powershell` run in the guest; `grep` and `find` are removed, background jobs and installs are refused, and only built-in or explicitly allowlisted extensions load (still as trusted host code). At session end, ordinary changes are written back while risky paths are collected into one prompt; files changed on the host in the meantime are never overwritten, and rejected changes are saved under the agent directory.

Sandbox mode is off by default and can only be enabled in global settings. The original usability gate and independent review remain open. Contracts: [[docs/axiom/sandbox.md]], [[design_draft.md]], [[concepts_brief.md]].

## Hashline edit mode

Hashline is an opt-in read/edit contract that makes stale edits detectable instead of silently overwriting newer file content.

Line IDs are bound to a file tag so they do not survive an intervening change, and a shown-line ledger ensures an ID is usable only if that line was shown to the model under the same tag. Bytes are checked again immediately before the rename. Hard links, non-regular files, invalid UTF-8 and oversized files are refused rather than falling back to plain replace mode. The default stays `replace` until the paired live-model gate says otherwise; [[docs/axiom/hashline-gate.md]] records the iterations and their limits.

Related ADR: [[docs/axiom/adr-hashline-first.md]]. Contracts: [[docs/axiom/hashline-contract.md]], [[docs/axiom/filesystem-race-research.md]].

## Schema strategy

Runtime validation uses pi-schema's compiled validators, while TypeBox remains the coding-agent's declaration and extension API.

[[packages/schema/src/validator.ts#compile]] produces fast check/error/validate paths and optional coercion. Coercion is the trust boundary for loosely typed model tool arguments, applied by [[packages/ai/src/utils/validation.ts#validateToolArguments]]; there is no AJV or TypeBox `Value` on runtime paths. Provider payloads are then narrowed by [[packages/ai/src/api/constrained-sampling.ts#getJsonSchemaToolParameters]] and each API adapter. ArkType and a full TypeBox migration were weighed and rejected; the inventory, measurements and reopen conditions are in [[docs/axiom/p1-schema-contract.md]].

## Toolchain and lockfiles

Bun runs development tasks; npm remains only where a step needs npm itself.

`bun.lock` is the CI install source and the source of the coding-agent install lock, which pins transitive dependencies for the pi.dev installer. `package-lock.json` is written only by the npm release path; the pre-commit guard requires `PI_ALLOW_LOCKFILE_CHANGE=1` for either lock. The two locks resolve different versions for a small set of packages, so `npm ci` and `bun install --frozen-lockfile` produce different layouts that both pass tests. See [[docs/axiom/toolchain.md]].

## Upstream tracking

Axiom treats Pi as a pinned upstream and records every deliberate divergence as a compatibility exclusion.

The fork follows upstream at a recorded pin and keeps a documented sync strategy. Package names, import specifiers, the `pi` extension API variable, `PI_*` variables, the `pi` binary inside pi-ai, client identity headers and system prompt bytes are left alone because renaming them would break third-party packages, user config or server allowlists, and each rename is a merge-conflict site. License notices are shipped with binaries. Contract: [[docs/axiom/upstream.md]].
