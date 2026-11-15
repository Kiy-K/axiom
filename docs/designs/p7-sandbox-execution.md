# P7: Run untrusted execution in a Gondolin VM

*   **Author:** Kiy-K
*   **Status:** Implemented (Stages 1-5). Where this document and the "As built" section disagree, "As built" is correct. User documentation: [sandbox.md](../axiom/sandbox.md).
*   **Date:** 2026-11-15

--------------------------------------------------------------------------------

## Overview

Axiom's `auto` permission mode (P6) decides whether to prompt, allow or deny a tool call by reading the command text and the files it touches. P6 closed with a negative result: on real sessions the trusted-recoverable-edit rule allowed nothing, because the taint gate blocked it, and `grep`, `npm` and `git` still ask every time. The default mode stays `yolo` until P7.

P7 moves the enforcement from command text to a boundary the operating system enforces. Code that the model can cause to run (built-in tools, shell commands, background jobs, `pi.exec`) runs inside a Gondolin microVM, behind a small internal interface called `SandboxBackend`. The host keeps the UI, orchestration, model calls and credentials. The VM works on an isolated copy of the project, has no network, receives no host credentials and sees a minimal environment. Changes return to the host through a reviewed write-back that applies at least the protected-file rules `auto` uses today.

P7 closes the roadmap item "P4 item 1" (extension code, `pi.exec`, `node:child_process`, `createBashTool` and `createLocalBashOperations`, user `!` and RPC bash, package installs, MCP spawning, codemode `models.*` and factory-time code are not mediated) and unblocks the unchecked P3 items (sandbox-compatible supervisor execution handles and sandbox isolation tests). Tracking issue: [Kiy-K/axiom#1](https://github.com/Kiy-K/axiom/issues/1).

## The Problem

An agent session reads repository content, dependency scripts, tool output and web content, and any of these can contain instructions that make the model run a command. Today the permission layer tries to recognise unsafe commands by their text. That approach has two limits:

1.  It prompts on ordinary work. `grep`, local tests and offline Git ask for approval, so users either answer prompts all day or switch to `yolo`, which checks nothing.
2.  It cannot see code that runs without going through a checked route. An extension can call `node:child_process` directly. A package install runs dependency scripts. Neither is visible to the command-text check.

Example: a repository's `package.json` has a `postinstall` script that reads `~/.ssh/id_ed25519` and sends it to a remote host. The model runs `npm install` because the user asked it to set the project up. In `auto` mode `npm` asks, and a user in a hurry approves. In `yolo` mode nothing asks. In both cases the script runs with the user's full account.

Proposed solution: run that code where it cannot reach the user's files, credentials or network, so the command text no longer decides safety. The VM has no network and no host secrets, so the script in the example finds no key and has nowhere to send it. Harmless work such as `grep`, tests and offline Git then needs no approval. The remaining risk moves to the points where something crosses the boundary: files copied in, changes written back, network grants, and code that still runs on the host. The design below addresses each.

Verified facts this design relies on (Gondolin 0.14.0, Fedora, checked 2026-11-15):

*   The SDK default is open network: `netEnabled` defaults to `true` and `createHttpHooks` defaults `allowedHosts` to `["*"]`. Axiom must turn the network off itself. With `sandbox: { netEnabled: false }` a probe VM could not resolve any name.
*   The existing example extension (`packages/coding-agent/examples/extensions/gondolin/index.ts`) mounts the live project read-write, leaves the network open and forwards host environment variables. It can supply plumbing but not configuration.
*   Startup on one machine with a minimal image: about 30 s the first time (image fetch), then 0.13 s to create the VM and about 2.5 s to the first command. This does not include a project with dependencies.
*   This machine has a usable `/dev/kvm` and QEMU.

## Goals

The gate for P7 is that all of the following are shown by adversarial tests, not by inspection:

*   Every execution route the model can reach is either run in the VM or blocked, with no route left on the host that the model can use without a decision by the user.
*   There is no implicit fallback to the host. If the VM cannot start, the agent stops and says so. The word "sandboxed" appears only while a VM is running and its enforcement was confirmed.
*   Code in the VM cannot read host credentials or host files outside the copied workspace, and host environment variables do not reach it.
*   The VM has no network unless the user approves a grant for named hosts. Commands such as `npm install` and `git clone` fail by default with an explanation that says what to approve.
*   A change made in the VM cannot reach a protected host path without review. The sandbox file policy is no weaker than `auto`'s.
*   The original `.git` directory cannot be written from the VM.
*   `grep`, local tests and offline Git run without repeated approval prompts.
*   VM startup time, command latency and regression against the current workflow are measured and reported.

Security enforcement ranks above convenience: where the two conflict, enforcement wins.

## Non-Goals

*   Protecting against a guest that escapes the hypervisor. The design avoids unnecessary privileges and documents the residual risk.
*   Approved SSH from the VM. SSH is off by default; approving it is a separate enhancement.
*   Running the whole Pi process inside a VM, as OpenShell and Docker Sandboxes do. Pi stays on the host; only tool execution moves. This leaves the extension problem open, which the Technical Plan handles by refusing extensions in sandbox mode unless the user allowlists them. Whole-process isolation is a possible later phase.
*   Depending on `apps/p2` or extracting its launcher. P7 uses `@earendil-works/gondolin` directly behind the internal adapter.
*   Rewriting the extension runtime. Enforcement happens at the execution boundary; unsupported capabilities are documented and fail closed.
*   Moving MCP stdio servers and codemode `models.*` calls into the VM. They are blocked in sandbox mode for now; moving them needs its own design.
*   Providing sandbox network access for model provider calls. Those stay on the host, with credentials that stay on the host.

## Open Questions

*   **Per-run network grants**: Can network policy on a running Gondolin VM change, or does every grant need a VM restart? Restarting loses guest state such as installed files and shell history. Resolve with a spike before the grant flow is designed; the answer decides whether a grant is a prompt or a prompt plus a restart.
*   **Copy cost on a real project**: How long does copying this repository (and a project with dependencies) into the guest take, and does skipping `node_modules` make local tests unusable? Resolve by measuring on this repository. If tests need dependencies, the design needs a read-only dependency cache or a controlled install step.
*   **Workspace mechanism (decided by the author, 2026-11-15)**: a read-only view of the live project plus an in-memory write layer (Technical Plan, "Workspace view"). The remaining unknowns are spike items: whether Git works against this view (index lock, object writes), the memory cap, and how deletions behave.
*   **Brief claims not re-checked**: The brief names `execCommand` (`packages/coding-agent/src/core/exec.ts`) and `createLocalBashOperations`/`createLocalShellOperations` (`packages/coding-agent/src/core/tools/bash.ts`) as host paths. Confirm the full route list in the Technical Plan by reading the callers, not by relying on the brief.
*   **Extension allowlist**: Where does the user define the allowlist, and does an allowlisted extension count as trusted host code or as code that runs only through the adapter? The accepted resolution says `pi.exec` for allowlisted extensions goes through the adapter, but arbitrary allowlisted extension code can still call `node:child_process`. Decide what an allowlist entry promises.
*   **Hook and config files in the guest**: The sanitised guest `.git` has no hooks, credentials or remotes. Decide how a guest commit behaves for repositories that rely on hooks (for example a pre-commit hook), since the guest would not run them.
*   **OpenShell**: Only a paper comparison is planned. Reopen if the spike fails on startup cost, dependency handling or extension needs.
*   **Reconciled with the brief (author decision, 2026-11-15)**: the brief (resolution 3) said "never `RealFSProvider` on the live project". The final design mounts the live project through `RealFSProvider` inside `ReadonlyProvider`, with allowlist hiding so the guest sees the same file set the brief's copy would have had. The "never `RealFSProvider`" rule is withdrawn because the provider is read-only; the rule it protected, no guest write and no secret file in the guest, is kept by the read-only wrapper and the allowlist.
*   **Dependencies**: with `node_modules` hidden, local tests that need dependencies fail until a dependency cache exists (Future Improvements). The spike measures how many of this repository's tests need them.
*   **`grep` and `find` in the guest**: the guest image must contain `rg` (and `fd` if `find` uses it). Confirm the image has them; if not, the tool fails closed with a message rather than running on the host.
*   **Permission rules inside the sandbox**: "no repeated prompts for `grep`, tests and offline Git" implies the permission gateway treats a command bound for the VM differently from one bound for the host. Read `packages/coding-agent/src/core/permissions/policy.ts` before the Detailed Implementation to decide which existing rules stay and which become unnecessary inside the boundary.

## Technical Plan

### Shape

Pi stays on the host: terminal UI, orchestration, model calls and credentials. Everything the model can make execute moves behind one adapter that talks to a Gondolin VM. The VM has no network, a minimal environment, and a workspace built from the project.

```
            host                                    VM (Gondolin, QEMU/KVM)
 ┌──────────────────────────────┐            ┌──────────────────────────────┐
 │ model calls, credentials, UI │            │ /workspace                   │
 │                              │            │   read-only base (live proj, │
 │ permission gateway           │            │   secret paths hidden)       │
 │   │ judges each call         │  exec/fs   │   + in-memory write layer    │
 │ SandboxBackend (adapter) ────┼───────────►│ no network, minimal env      │
 │   ├ capability detection     │            └──────────────────────────────┘
 │   ├ network grants (host)    │
 │   └ write-back review ───────┼──► protected-path prompt ──► host project
 │ HostExecGuard (spawn sites)  │
 └──────────────────────────────┘
```

### The adapter

`SandboxBackend` is the only module that imports `@earendil-works/gondolin`. It exposes: capability detection, create, exec, workspace mapping, network policy, export of changes, and teardown. Its state is a tagged union: `unavailable` (with the reason), `starting`, `enforced` (every check below passed), `failed`. The "sandboxed" indicator reads this state and nothing else.

Capability detection runs before any VM starts and checks `/dev/kvm` access, QEMU, the Node version Gondolin needs, and the guest image. After the VM starts, the backend confirms enforcement by running a fixed probe in the guest: network off (a name lookup fails), the host home directory absent, host environment variables absent, `/workspace` writes land in the write layer and not on the host, and the hidden paths and `.git` are absent. State moves to `enforced` only if the probe passes. A failed probe is `failed`, not a warning.

### Workspace view

The guest sees `/workspace` built from three layers over the live project:

1.  Base: the live project mounted through `RealFSProvider` inside `ReadonlyProvider`. The guest cannot change host files through it.
2.  Hiding (allowlist): at start the backend computes the visible set: `git ls-files` plus untracked files that are not git-ignored, minus every path `looksLikeSecretPath` (`packages/coding-agent/src/core/permissions/paths.ts`) matches, minus symlinks whose real target is outside the project (checked with `resolveRealPath`). `ShadowProvider` hides every other path in the project, including git-ignored files and `node_modules`. The one exemption is `.git`, handled by its own rules below. Hidden paths read as missing. `denySymlinkBypass` stays on. The count and names of hidden files are shown at start. Files the guest creates live in the write layer and are visible to it regardless of this set.
3.  Write layer: a new copy-on-write provider, written for this feature. Guest writes go to a `MemoryProvider`; deletes are recorded as tombstones; reads fall through to the base for untouched paths. A fixed byte cap makes writes fail with `ENOSPC` past the cap (value chosen in the spike).

Why a new provider: `ShadowProvider` redirects writes only for the paths it shadows; it is not a whole-tree overlay.

Git: superseded, see "As built": the guest has no `.git` at all.

Limits this accepts: the guest sees the host project as it is during the run, so a host edit mid-run changes the base under the guest. The start manifest (below) lets write-back detect this.

### Routes

Every way the model can run code, and its disposition when sandbox mode is on:

| Route | Where it lives | Disposition |
|---|---|---|
| `bash` tool, background jobs | `core/tools/bash.ts` (`createShellToolDefinition`, ops default at line 252) | Runs in the VM through `SandboxBashOperations`; jobs keep working through the supervisor handle (see "Jobs") |
| `read`, `write`, `edit`, `ls` | in-process fs with pluggable `*Operations` | Swapped to the guest workspace through their Operations hooks |
| `grep`, `find` | `core/tools/grep.ts`, `find.ts` spawn `rg`/`fd` on the host | Superseded: removed in sandbox mode (the guest image has no `rg`/`fd`, see Spike Results) |
| User `!` and RPC `bash` | `AgentSession.executeBash` (`agent-session.ts:4145`), `modes/rpc/rpc-mode.ts:582` | Same adapter. A user-typed `!` command is the user's own decision; it still runs in the VM so one route does not differ from another |
| Package installs | `core/package-manager.ts` (`spawnProcess`) | Refused in sandbox mode (`assertHostExecAllowed("package-install")`); turn sandbox mode off to install |
| `pi.exec` | `core/extensions/loader.ts:435` → `execCommand` | Allowlisted extensions only, routed through the adapter; others get a blocked error |
| Extension code | in-process JavaScript | Cannot be intercepted. Refused in sandbox mode unless allowlisted by name (resolution 1) |
| MCP stdio servers, shell-evaluated `!cmd` config values | `core/mcp-servers.ts`, `core/resolve-config-value.ts` | Blocked in sandbox mode (resolution 2) |
| codemode `models.*` | codemode runtime | Blocked unless the user opts in |
| Host UI spawns (footer Git status, clipboard, editor, browser, session share) | `footer-data-provider.ts`, `utils/clipboard-command.ts`, `modes/interactive/*` | Not model-reachable; unchanged |

**HostExecGuard.** Swapping Operations is not enough: an extension tool that calls `createBashTool(cwd)` without options gets the local default. So each model-reachable host spawn site (`executeNativeProcess`, `execCommand`, the `grep`/`find` spawns, `package-manager` spawns, `resolve-config-value`) first asks one guard. When sandbox mode is on and the caller does not hold a host-exec grant from the user, the guard throws a blocked error that names the route. This is the fail-closed rule; there is no silent host fallback. It cannot stop an allowlisted or in-process extension that spawns directly; that is why extensions need the allowlist.

### Network

The VM is created with `sandbox: { netEnabled: false }`. Model provider calls and credentials never enter the VM. A command that needs the network fails inside the guest; the tool result adds a fixed note: the VM has no network, and which grant would allow it. A grant is a user prompt naming hosts (`allowedHosts` for `createHttpHooks`) with `blockInternalRanges` on and WebSockets off, scoped to the current operation or session. Whether a grant applies live or restarts the VM is an Open Question.

### Environment

The guest starts with Gondolin's minimal environment. No host variable is forwarded by default. A user can name variables to pass; each named variable is shown at the prompt.

### Permissions

The permission gateway keeps judging each call. Inside the boundary its exec rules change: a command bound for the VM no longer needs a prompt because the boundary, not a command allowlist, limits it. The prompts that remain are network grants, write-back of protected paths, host-exec grants, and unsandboxed fallback (below).

### Write-back

At start the backend records a manifest of the project files (path, size, mtime, mode). Write-back runs when the user accepts changes, at the end of a run or on request:

1.  Read the write layer into a list of changes: created, modified, deleted, renamed, mode-changed, and symlinks.
2.  Classify every path with `classifyPath` (`paths.ts:187`). Ordinary source edits apply without a prompt. Protected paths, code-running paths (`looksLikeCodeRunningPath`), secret-like paths, new executable files, mode changes and anything unclassifiable (resolution 5) go to one review prompt that shows the diff. Unclassifiable paths are refused.
3.  Compare each destination with the start manifest. A mismatch means the host changed the file during the run; the change is a conflict and is shown, not applied silently.
4.  Apply through a temp file and rename, without following symlinks at the destination. If any change fails, report which were applied and which were not.

### Jobs

Background jobs hold a process handle today (`retainsProcessHandle` on `BashOperations`; `NativeProcessHandle` is opaque and its pid informational). The adapter issues a job handle bound to the session and the VM. A handle from one session cannot be used from another, and teardown ends every guest process. Whether Gondolin's exec API supports stdin, signals and detached processes at the level the supervisor needs is a spike item.

### Fallback

Sandbox mode is on or off per session. If the VM cannot start or enforcement fails, the session stops tool execution and prints the reason. The only way to run unsandboxed is an explicit session command; it sets a persistent `UNSANDBOXED` marker in the UI and the audit entry. The word "sandboxed" is never shown outside the `enforced` state.

### Spike (first stage)

A throwaway script, not production code: boot a VM with `netEnabled: false`, the read-only base with the three layers, and the sanitised `.git`. Measure startup on this repository; check that Git commits, `rg`, a test run and a deletion work; check whether a network grant changes live. Its results settle the Open Questions marked as spike items.

## Spike Results (Stage 1, 2026-11-15)

Run with Gondolin 0.14.0 on this machine; scripts were throwaway, outside the tree.

- Boot: `VM.create` 39 ms, first `exec` about 2.7 s, later execs 2-35 ms. Read-only `RealFSProvider` mount of this repo at `/workspace` works; `touch` fails with "Read-only file system".
- Isolation: `netEnabled:false` gives no DNS or route; guest `HOME=/root` is empty; no host env leaks when `env` is set explicitly.
- **The default guest image has no `git`, `rg` or `fd`.** It has `node`, `sh`, `bash`. So guest `git status`, and `grep`/`find` through guest `rg`/`fd`, do not work. Resolution needed (see Open Questions): custom image via `gondolin build` with `rootfsPackages`, or run grep/find/git-read operations on the host against the filtered view.
- Network grants are live. With `netEnabled:true`, `createHttpHooks` and a mutable allow set read inside `isRequestAllowed`, adding a host turns a guest request from 403 to 200 and removing it turns it back to 403, with no VM restart. This resolves the per-run grant question: grants are a mutable set owned by the adapter.
- Exec handles: `stdin: true` with `write`/`end` works. `AbortSignal` rejects the host promise ("exec aborted") but **does not kill the guest process** (`sleep 31` stayed running). The adapter must kill inside the guest itself (record the pid, then a second `exec` that runs `kill`). Background processes survive their launching exec.
- **Decision (author, 2026-11-15): no custom image.** grep, find and read-only git run on the host against the same filtered file list the VM sees (the VM only sees `git ls-files` plus untracked non-ignored paths). Guest `git commit` and other guest-side git use stay unavailable; guest commits and the "guest commits exported as a patch" step are dropped from this stage and move to Future Improvements.
- Not yet measured: write-layer byte cap, git on a copy-on-write view (blocked by the missing `git`), how many repo tests need `node_modules`.

## Alternatives Considered

### Decided by the author

*   **Extract p2's launcher or depend on `apps/p2`.** Rejected by author: the coding agent cannot depend on `apps/p2` (outside the root check), and the SDK gives what P7 needs behind a small adapter.
*   **Mount the live project read-write** (what the example extension does). Rejected by author: a guest write would reach the host project with no review, which defeats the protected-file rule.
*   **Put model calls or credentials in the guest, or forward the host environment.** Rejected by author: the guest runs untrusted code; anything in it can be sent out if the network is ever granted.
*   **Silent fallback to the host when the VM fails.** Rejected by author: it turns every VM failure into an unsandboxed run that looks sandboxed.
*   **Workspace as a host staging copy (option A).** Not chosen by the author among three options. Trade-off: uses only existing SDK pieces, but the copy time grows with repository size and guest files sit on the host disk during the run.
*   **Workspace uploaded into guest storage (option C).** Not chosen by the author. Trade-off: no writable host path at all, but it has the slowest start and export, and upload cost scales with file count.

### Weighed, with technical reasons

*   **OpenShell instead of Gondolin.** It isolates the whole Pi process, which removes the extension problem. It needs a gateway, is not installed on this machine and was not tested. Only the documentation compares it. The design stays on Gondolin and reopens this if the spike fails on startup cost, dependencies or extension needs.
*   **Docker Sandboxes or plain Docker with the whole Pi process inside.** Same whole-process benefit as OpenShell. It conflicts with keeping Pi on the host and the SDK behind an internal adapter. Docker is not installed here.
*   **Use the existing Gondolin extension as is.** It mounts the project read-write, leaves the network open and forwards host environment variables. It also falls back to the local tools (`localRead`, `localBash` and others in `examples/extensions/gondolin/index.ts`). It supplies plumbing for the guest Operations, not the configuration.
*   **Swap the tool Operations only, with no `HostExecGuard`.** Fails closed only for code that passes the Operations. An extension tool that calls `createBashTool(cwd)` without options gets the local default. The guard at each host spawn site closes that.
*   **Intercept only `pi.exec`.** Does not stop extension code that calls `node:child_process`.
*   **Refuse all extensions in sandbox mode.** Matches the strict reading of the scope but removes every extension. The allowlist variant keeps trusted ones and makes the trust explicit.
*   **Sync the guest `.git` back into the host repository.** Would carry hooks, config and refs from untrusted code into the host repository. Guest commits stay in the guest and leave as a reviewed patch.
*   **Hide only secret-like paths (denylist view).** Offered to the author and not chosen. It lets tests use `node_modules`, but an ignored file that holds a secret and does not match `looksLikeSecretPath` would be readable by guest code.
*   **Hash every project file at start for the write-back manifest.** Catches the same host changes but costs a full read of the project at every start. Path, size, mtime and mode cost one stat per file.

## Non-Functional Requirements

*   **Security first, UX second.** A feature that weakens a gate item is dropped before it is made convenient.
*   **Latency.** Startup (cold image, warm image), first command and a 100-command loop are measured before and after on this repository and reported. No target is set until the spike gives numbers; the gate asks for the measurement, not a threshold.
*   **Failure behavior.** VM start failure, guest crash, memory-layer cap and host change mid-run each produce a stated error and leave the host project unchanged.
*   **Portability.** Needs `/dev/kvm` and QEMU, so Linux first. Other platforms report `unavailable` and fall back only by the explicit session command.

## Future Improvements

*   Approved SSH access (needs a raw TCP path Gondolin does not offer today).
*   A read-only dependency cache so `node_modules` is visible without a network install.
*   Running the whole Pi process in the boundary (OpenShell or similar) if extension compatibility turns out to matter more than keeping Pi on the host.
*   Sandboxing MCP stdio servers in the VM instead of blocking them.

## Detailed Implementation Plan

All paths are under `packages/coding-agent/` unless stated. Implementation follows the staging below; each stage ends with its own verification.

### Staging

1.  **Spike** (scratch outside the tree): boots the VM with the three-layer workspace; settles the Open Questions marked as spike items. Output: numbers and a go/no-go note.
2.  **Backend, detection and fallback**: adapter with state union, probe, session on/off.
3.  **Routes**: Operations swap, `HostExecGuard`, MCP and extension blocking, allowlist.
4.  **Workspace and write-back**: copy-on-write provider, manifest, classification, apply.
5.  **Adversarial tests and gate**: one test per gate item, measurements recorded.

### Target Files

New files:

| File | Purpose and rationale |
|---|---|
| `src/core/sandbox/backend.ts` | `SandboxBackend` interface and the state union (`unavailable`, `starting`, `enforced`, `failed`). The only seam the rest of the agent sees; nothing else imports the SDK. |
| `src/core/sandbox/gondolin-backend.ts` | The only importer of `@earendil-works/gondolin`. Builds the VM (`netEnabled: false`, minimal env), mounts the workspace view, runs the enforcement probe, implements exec and teardown. Reuses plumbing patterns from `examples/extensions/gondolin/index.ts` but none of its configuration. |
| `src/core/sandbox/detect.ts` | Capability detection before any VM starts: `/dev/kvm` access, QEMU, Node version, guest image. Returns a reason string used in the `unavailable` message. Separate so tests can fake it. |
| `src/core/sandbox/workspace.ts` | Builds the read-only base, the visible-file allowlist (`git ls-files` plus untracked non-ignored, minus `looksLikeSecretPath` and outside-pointing symlinks, using `resolveRealPath`, both from `core/permissions/paths.ts`), the `ShadowProvider` that hides the rest, the sanitised `.git/config`, hidden `.git/hooks`, and the hidden-file report shown at start. |
| `src/core/sandbox/cow-provider.ts` | Copy-on-write provider: `MemoryProvider` writes, tombstones for deletes, byte cap. New because no existing provider overlays a whole tree. |
| `src/core/sandbox/manifest.ts` | Start manifest (path, size, mtime, mode) and the host-change check used at write-back. |
| `src/core/sandbox/writeback.ts` | Collect changes from the write layer, classify with `classifyPath`, build the review prompt, apply with temp-file and rename without following symlinks, report partial results. Includes patch export for guest commits. |
| `src/core/sandbox/operations.ts` | Guest implementations of `BashOperations` (copying `retainsProcessHandle`), `Read/Write/Edit/Ls/Grep/FindOperations`. Replaces the example extension's copies; no `local*` fallback in any of them. |
| `src/core/sandbox/host-exec-guard.ts` | `assertHostExecAllowed(route)`: throws a blocked error naming the route when sandbox mode is on and no host-exec grant exists. |
| `src/core/sandbox/allowlist.ts` | Reads the extension allowlist (by name) from settings; answers "may this extension load in sandbox mode". |
| `src/core/sandbox/network.ts` | Grant model (hosts, scope) and the fixed explanation appended to failed-network tool results. Applies grants through `createHttpHooks` with `blockInternalRanges` on and WebSockets off. |
| `test/sandbox-*.test.ts` (one per module above, plus `sandbox-adversarial.test.ts`) | Unit tests with a fake backend; the adversarial file needs a real VM and is skipped, with a visible message, when `detect.ts` says `unavailable`. |
| `docs/sandbox.md` | User guide: what is isolated, what is blocked, how to grant network, residual risks. Linked from `docs/security.md` and `docs/containerization.md`. |

Changed files:

| File | Change and rationale |
|---|---|
| `src/core/tools/bash.ts` (`createShellToolDefinition`, line 252) | No change to the default. The sandbox supplies `operations`; the guard goes in `createLocalShellOperations` (line 133) so any caller that reaches the local default is checked. |
| `src/core/tools/native-process.ts` (`executeNativeProcess`) | Call the guard before spawning the helper. |
| `src/core/tools/grep.ts`, `src/core/tools/find.ts` | Call the guard before the `rg`/`fd` spawn; the sandbox provides guest Operations. |
| `src/core/exec.ts` (`execCommand`) | Call the guard; `pi.exec` for an allowlisted extension is routed to the adapter by the loader. |
| `src/core/extensions/loader.ts` (line ~435) | Route `pi.exec` through the adapter for allowlisted extensions; return a blocked error otherwise. Enforce the allowlist at extension load. |
| `src/core/package-manager.ts` (spawn sites, lines ~2874, 2888, 2955) | Guard; in sandbox mode installs are blocked until a network grant exists. |
| `src/core/resolve-config-value.ts` | Guard on `execSync`/`spawnSync`; `!cmd` config values fail closed in sandbox mode. |
| `src/extensions/mcp/runtime.ts` (`McpTransportFactory`, `McpExecAuthorizer`) | Stdio transport creation and `!cmd` values refuse in sandbox mode through the existing authorizer seam. HTTP servers keep working. |
| `src/core/agent-session.ts` (line ~4145) and `src/modes/rpc/rpc-mode.ts` (line ~582) | `executeBash` takes its `operations` from the session's sandbox state instead of the local default. |
| `src/core/permissions/gateway.ts` and `policy.ts` | Judge VM-bound commands without exec prompts (the boundary replaces the command allowlist). Add the sandbox prompts (network grant, write-back, host-exec grant, unsandboxed). Exact rules depend on reading `policy.ts` (145 lines) first. |
| `src/core/settings-defaults.ts` and the settings schema | New `sandbox` block: enabled, extension allowlist, passed env names. Default stays `yolo` until the gate closes, then the default-mode decision is a separate step. |
| `src/core/sdk.ts`, `src/modes/interactive/interactive-mode.ts` | Create and tear down the backend with the session; show the sandbox state and the `UNSANDBOXED` marker only from the backend state. |
| `package.json` (this package) | Move `@earendil-works/gondolin` (0.14.0, pinned) from the example extension into dependencies; check `check:pinned-deps` and `check:runtime-deps`. |
| `docs/security.md`, `docs/containerization.md`, `CHANGELOG.md` (`## [Unreleased]`) | Link the new guide; record the change per repository rules. |
| `docs/axiom/p4-closure-contract.md`, GitHub issue #1 | Tick P3 sandbox boxes and P4 item 1 only after the gate passes. |

The example extension `examples/extensions/gondolin/` stays as an example; its `local*` fallbacks are noted in the guide as the pattern the built-in sandbox does not follow.

### Verification Plan

Unit tests (fake backend, run in the normal suite):

*   State machine: only a passing probe reaches `enforced`; the "sandboxed" label reads the state.
*   `HostExecGuard`: every spawn site above throws when sandbox mode is on; none throws when it is off.
*   Allowlist: a non-listed extension fails to load; a listed one's `pi.exec` reaches the adapter.
*   Write-back classification: source edit applies silently; protected, code-running, secret-like, new-executable, mode-change, rename and symlink cases each prompt or refuse; host-changed file becomes a conflict; partial failure is reported.
*   Manifest, copy-on-write provider (create, modify, delete, cap), secret hiding including symlink bypass.

Adversarial tests (real VM, one per gate item; skipped with a message when KVM is absent):

1.  Route coverage: a script enumerates the host spawn sites by search and asserts each has a guard test; try each model-reachable route and assert VM execution or a blocked error.
2.  No implicit fallback: make the VM fail to start; assert no tool runs and no command executes on the host.
3.  Credentials and host files: from the guest, read `~/.ssh`, `~/.aws`, host env; try a symlink out of the project and `..` paths; all fail.
4.  Network: DNS, TCP and HTTP all fail by default; `npm install` and `git clone` fail with the explanation; a granted host works, an ungranted host does not, and internal ranges stay blocked.
5.  Workspace policy: the guest edits `.git/hooks`, `package.json` scripts, a CI file and creates an executable; each reaches write-back review; the host `.git` is unchanged.
6.  Cleanup: after teardown no VM or guest process remains; a job handle from another session is refused.
7.  Usability: `grep`, a test run and offline `git commit` complete with no approval prompt for the exec itself.

Measurements recorded in `docs/sandbox.md`: cold and warm startup, first-command latency, 100-command loop, write-back time, against the current workflow.

Run `bun run check` after code changes. The adversarial suite is run by hand on a machine with `/dev/kvm` until CI offers one.

---
*Drafted with EGM*


## As built (Stage 5, 2026-11-15)

What shipped differs from the plan above in these points.

*   **No `.git` in the guest.** `.git` is always hidden, so there is no sanitised config and no guest commit; guest commits and patch export are Future Improvements. Host git runs only as `git -c core.fsmonitor=false ls-files -z` to build the visible set. A directory that is not a git work tree fails closed.
*   **Visible set is evaluated per call.** `ShadowProvider` takes a `shouldShadow` function, not a path list built once, so a secret created on the host after start is hidden too. Visible: tracked plus untracked-not-ignored files, minus `looksLikeSecretPath` matches; everything else is hidden. Files the guest creates stay visible.
*   **Write layer** is `CowProvider` (`core/sandbox/cow-provider.ts`): `MemoryProvider` upper layer, tombstones, 512 MiB cap (`ENOSPC`). Gondolin's guest only calls the async provider methods and opens with `r`, `r+`, `w`, `w+`, `a`, `a+`.
*   **`grep` and `find` are removed in sandbox mode**, not run in the guest or on the host. `read`, `write`, `edit`, `ls`, `bash`, `powershell` run in the guest. Background jobs are refused.
*   **Write-back** (`writeback.ts`, `finish.ts`) runs from `AgentSession.finishSandbox()`, awaited after `stopJobs()` and before `dispose()` in both teardown paths. Silent: ordinary edits. Review (one prompt, or not applied when no UI is bound): secret, protected and code-running paths, symlinks, new executables, permission changes. Conflicts (the host changed the file, or the host has a file the guest never saw) are never applied. Everything not applied is saved under `<agentDir>/sandbox-unapplied/<sessionId>/`. Host writes check every path component with `lstat` and use a temp file plus rename.
*   **Host-exec guard** (`host-exec-guard.ts`) is called from config commands, extension exec, user `!` and RPC bash, and package install/clone/update. Read-only package-manager query commands are not guarded. There is no grant surface yet: `hostExecGranted` is always empty.
*   **Extensions**: in sandbox mode only built-in extensions and paths in `sandbox.extensions` load, on every load path; `baseToolsOverride` is refused.
*   **MCP**: servers an extension registers go through `pi.authorizeExec`, which the `extension-exec` guard covers. Servers in `mcp.json` or `.mcp.json` are user configuration and still start on the host; the model can only change `.mcp.json` through write-back, which sends it to review. The `mcp-stdio` and `codemode` guard routes are declared but no call site uses them (codemode runs in QuickJS and reaches tools through the session's sandboxed tools).
*   **Not done:** a UI marker for sandbox state, host-exec grants, a custom guest image, guest-side `git`.
