# Sandbox mode

Sandbox mode runs the model's tools in a Gondolin microVM instead of on your machine. It is off by default; turn it on with `sandbox.enabled` in global settings (project settings cannot set it). Design and decisions: [P7 design](../designs/p7-sandbox-execution.md). Tracking: [#1](https://github.com/Kiy-K/axiom/issues/1).

```json
{ "sandbox": { "enabled": true, "extensions": ["/abs/path/to/trusted-extension.ts"] } }
```

## Requirements

Linux with `/dev/kvm` access and QEMU, and the Gondolin guest image. If the VM cannot start, or its start-up probe fails, tool calls fail with the reason; nothing falls back to the host. The state is `enforced` only after the probe passes: no network, no host home or environment, a guest write to `/workspace` does not reach the host, and `.git` and the hidden paths are absent.

## What the guest sees

- `/workspace` is a copy-on-write view of the project. Guest writes go to a memory layer (512 MiB cap, then `ENOSPC`); the project on disk is not touched while the VM runs.
- Visible files: `git ls-files` (tracked, plus untracked and not ignored), minus anything that looks like a secret (`.env`, keys, credentials). Hidden: `.git`, git-ignored files and directories (so `node_modules`), and any file created on the host after start. A directory that is not a git work tree is refused.
- Guest networking is disabled at the VM boundary, not merely denied by an HTTP proxy. There are no network grants. The guest has no host environment variables or dependency cache, and the agent does not offer guest `grep` or `find` tools. Install dependencies and run builds that need them outside sandbox mode; the guest cannot download them.

## Which tools run where

| Route | In sandbox mode |
|---|---|
| `read`, `write`, `edit`, `ls`, `bash`, `powershell` (model and user `!`, RPC bash) | Guest |
| `grep`, `find` | Removed (the guest image has no `rg`/`fd`) |
| Background bash jobs | Refused |
| Package install, clone, update | Refused; turn sandbox mode off |
| Config `!command` values, `pi.exec` | Refused (host-exec guard) |
| Configured MCP server process launches | Refused, including command-valued environment, headers, and OAuth secrets; plain HTTP servers without commands can still connect |
| Extensions | Only built-in ones and paths in `sandbox.extensions`; they still run in-process on the host |
| `baseToolsOverride` (SDK) | Refused |

Only built-in extensions and explicitly allowlisted extensions load in sandbox mode. They run in-process on the host and are trusted host code, not isolated guest code. Read-only package-manager query commands are not covered by the host-exec guard. There is no way to grant a host-exec route.

The interactive footer reports the session's sandbox state: `sandbox starting`, `sandboxed` (enforced), `sandbox failed`, or `sandbox unavailable`; it shows no sandbox marker when the mode is off. This state does not detect unexpected VM death.

The original P7 usability gate and independent review remain open.

## Write-back

When the session ends (`/new`, switch, exit), the guest's changes are compared with the project:

- Ordinary edits, new files and deletes are applied without asking.
- One prompt lists the risky ones: secret, protected and code-running paths (hooks, `package.json`, CI files, task runners), symlinks, new executables, permission changes. Declining, or having no UI, applies none of them.
- A file the host changed during the session, or a host file the guest never saw, is never overwritten.
- Whatever was not applied is saved under `<agentDir>/sandbox-unapplied/<sessionId>/`.
- Host writes check every path component for symlinks and use a temp file plus rename.

If the process is killed before this step, the memory layer is lost.

## Cost

Measured on this repository (4,290 tracked files, KVM, 2026-11-15): building the workspace view 144 ms; VM start until the former HTTP-based probe passed about 2 s (1.9 to 2.0 s over two runs, small and large project alike); first command 7 to 21 ms after that. The VM starts in the background while the session loads. Not measured: startup with the current network-interface probe, repositories far larger than this one, an interactive TUI review prompt, and write-back of large layers.

## Tests

`test/sandbox-*.test.ts`. The VM tests need `/dev/kvm` and skip without it; `sandbox-adversarial.test.ts` covers a hostile guest (secret and symlink reads, `.git` hook planting, late host files, risky changes without a reviewer, a host edit racing write-back).
