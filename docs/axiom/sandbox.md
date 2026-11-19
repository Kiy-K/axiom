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

Gate status (2026-11-19): adversarial isolation tests are written and pass on KVM hardware (see Tests); UX and latency figures are the measured ones below, re-measured with the current probe; the model routes `bash`, `write`, `edit`, `read`, user `!` bash and background jobs all refuse host execution when the sandbox is not enforced, proven by `test/sandbox-no-host-fallback.test.ts`. The remaining routes are covered structurally, not by that test: `ls` goes through the same `requireEnforced` operations (`sandbox/session.ts:54-59`), `powershell` gets a fixed refusal (`SANDBOX_POWERSHELL_REFUSAL`), `grep`/`find` are removed from the tool set in sandbox mode, and extension/MCP/package-install host spawns hit `assertHostExecAllowed` (`sandbox/host-exec-guard.ts`). What remains for the gate is user approval of the test set and the write-back UX, and the independent review.

## Write-back

When the session ends (`/new`, switch, exit), the guest's changes are compared with the project:

- Ordinary edits, new files and deletes are applied without asking.
- One prompt lists the risky ones: secret, protected and code-running paths (hooks, `package.json`, CI files, task runners), symlinks, new executables, permission changes. Declining, or having no UI, applies none of them.
- A file the host changed during the session, or a host file the guest never saw, is never overwritten.
- Whatever was not applied is saved under `<agentDir>/sandbox-unapplied/<sessionId>/`.
- Host writes check every path component for symlinks and use a temp file plus rename.

If the process is killed before this step, the memory layer is lost.

## Cost

Measured on this repository (4,290 tracked files, KVM): VM start until the probe passes was about 2 s (1.9 to 2.0 s over two runs, 2026-11-15, when the probe still did an HTTP round trip). Re-measured 2026-11-19 with the current network-interface probe and three runs each: 1.72 to 1.78 s on a minimal repo and on this one alike, first command 1 to 3 ms after ready; building the workspace view 144 ms (2026-11-15 figure). The VM starts in the background while the session loads. Not measured: repositories far larger than this one, an interactive TUI review prompt, and write-back of large layers.

## Tests

`test/sandbox-*.test.ts`. The VM tests need `/dev/kvm` and skip without it. `sandbox-adversarial.test.ts` covers a hostile guest (secret and symlink reads, `.git` hook planting, late host files, risky changes without a reviewer, a host edit racing write-back, host PIDs invisible in guest `/proc` with `kill`, `kill -9` and a `kill -9 -1` broadcast leaving the host process alive). `sandbox-no-host-fallback.test.ts` proves the refusal paths without KVM: a failed sandbox start makes `bash`, `write`, `edit` and `read` fail with the reason and nothing touch the host, and background jobs stay refused.

## Backend comparison (OpenShell vs Gondolin)

Desk research on NVIDIA OpenShell (2026-11-19, docs pages cited per claim; nothing installed or run locally — the issue's "validate with real local use cases" is not done by this section). Axiom's backend is the Gondolin micro-VM above; OpenShell is a gateway + supervisor + in-sandbox runtime that confines workloads with Landlock, seccomp (BPF plus user-notification mediation of TCP and DNS) and driver-built egress fences.

| Aspect | Gondolin (this backend) | OpenShell |
|---|---|---|
| Boundary | Per-session micro-VM: a separate guest kernel; hypervisor escape is an explicit non-goal (host and guest share only virtio channels) | Kernel LSM + seccomp inside a container/VM chosen by its compute driver; three planes (gateway, supervisor, sandbox) ([architecture](https://docs.nvidia.com/openshell/about/architecture.md)) |
| Filesystem | Copy-on-write project view, `git ls-files` minus secrets, `.git` and ignored paths absent; guest writes never reach the host until write-back | Landlock confines declared paths; default policy reads `/usr /lib /etc /app /var/log /proc /dev/urandom` read-only, workdir and `/tmp /dev/null` writable ([default-policy](https://docs.nvidia.com/openshell/how-it-works/policies/default-policy.md)); no CoW view — bind mounts are opt-in and documented as able to bypass workspace isolation ([best-practices](https://docs.nvidia.com/openshell/security/best-practices.md)) |
| Network | Off at the VM boundary; no grants | Mediated per binary and per endpoint: sandbox intercepts TCP/DNS via seccomp user-notif, supervisor evaluates policy and opens approved connections; ignoring proxy env vars does not bypass it ([runtimes](https://docs.nvidia.com/openshell/how-it-works/sandboxes/runtimes.md)) |
| Secrets | None propagate: fixed guest env, no host environment; `.env` and key files hidden from the guest | Credential substitution: the agent never sees the secret; the supervisor injects it into approved requests ([architecture](https://docs.nvidia.com/openshell/about/architecture.md)) |
| Processes | Separate kernel and PID space: host PIDs absent from guest `/proc`, signals cannot cross (proven by `test/sandbox-adversarial.test.ts`) | No separate PID namespace or `/proc` hiding documented; host-visible processes are readable, though `ptrace`, `process_vm_readv`, `setns`, `unshare` are seccomp-blocked for the workload ([best-practices](https://docs.nvidia.com/openshell/security/best-practices.md)) |
| Fedora | Needs `/dev/kvm` + QEMU + guest image | Installs as an RPM; kernel prerequisites are Landlock ABI ≥ 3 and seccomp user-notif ([installation](https://docs.nvidia.com/openshell/about/installation.md), [support-matrix](https://docs.nvidia.com/openshell/about/support-matrix.md)); on this Fedora 45 host a local check measured Landlock ABI 11 with landlock in the active LSM set (our measurement, not a source claim) |
| Maturity | Vendored by Axiom | Apache-2.0, CNCF Sandbox project (accepted 2026-09-26, [cncf.io](https://www.cncf.io/projects/openshell/)), weekly stable releases (v0.1.9 on 2026-11-17, [releases API](https://api.github.com/repos/NVIDIA/OpenShell/releases)); pre-1.0, policy/API churn expected |
| Cost / latency | Measured: view 144 ms, VM start 1.72–1.78 s, first command 1–3 ms (2026-11-19) | Not established: no published startup-latency, per-sandbox overhead or cost figures (docs say the gateway takes a few seconds to listen); maintenance burden heavier: Rust gateway daemon + supervisor + prover + per-driver packaging |

Verdict: not a replacement for the Gondolin backend — its documented model keeps host processes visible and documents no enforcement probe comparable to our `ready === enforced` gate (its pipeline is admission-gated: Attach → Confirm → StartAgent, [architecture](https://docs.nvidia.com/openshell/about/architecture.md)), so it cannot meet the isolation tier above. It is a candidate second tier where Axiom has no capability: scoped per-binary egress with credential substitution ("sandbox with network grants and no secrets in the environment"). Revisit if a `SandboxBackend` adapter for its gateway API is proposed; the "research … then validate with real local use cases" issue item stays open until an install-and-run validation happens.
