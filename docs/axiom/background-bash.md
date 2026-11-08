# P3: Background Bash and process supervisor

Roadmap issue [#1](https://github.com/Kiy-K/axiom/issues/1), phase P3 (spec: [#2](https://github.com/Kiy-K/axiom/issues/2)). Paths are relative to `packages/coding-agent/src/`.

**Status:** implemented; P3 acceptance remains open. Lifecycle integration and independent review are in progress. P4 permission-gateway and P7 sandbox integration have not been verified.

## P3 checklist traceability

Test references are coverage targets, not a claim that they passed in the current run. Paths below are relative to `packages/coding-agent/test/`.

| Requirement | Evidence or remaining gap |
|---|---|
| Pinned upstream audit and contract | Problem, alternatives and implementation details are recorded here; audit completeness is not established by a test. |
| Fast foreground completion | `jobs-bash-supervision.test.ts::finishes in the foreground and never registers a job` |
| 10-second yield and races | `jobs-bash-supervision.test.ts::becomes a background job at 10 seconds without restarting the command`; `::finishes in the foreground when completion wins on the 10-second tick`; `::aborts instead of yielding when cancellation arrives on the 10-second tick` |
| Concurrency limit | `jobs-supervisor.test.ts::refuses adoption at the running limit and leaves the command in the foreground` |
| Exit code and owner checks | `jobs-supervisor.test.ts::rejects foreign owners for output, input and stop without affecting the job` |
| stdin | `jobs-real-process.test.ts::delivers send_input from the job tool to a real shell` |
| Stop and double stop | `jobs-supervisor.test.ts::stops a job once and reports the same final state on a repeated stop` |
| Session shutdown and process tree | `jobs-real-process.test.ts::cleans a descendant of a completed foreground command at session close`; `::kills a TERM-ignoring process group during session shutdown`. Escaped process groups require P7. |
| Stale handles | `jobs-supervisor.test.ts::evicts the oldest finished job beyond the retention limit` |
| Bounded log and cursor | `jobs-log-buffer.test.ts::reports bytes lost to the retention window for a stale cursor`; `::reads from a cursor and returns the next cursor` |
| Denied launch | Blocked: needs P4 permission gateway. |
| Sandbox isolation and sandbox-compatible handles | Blocked: needs P7. Owner checks above are not sandbox isolation. |
| Foreground and nested Bash | `jobs-bash-supervision.test.ts::preserves top-level foreground output and exit status with supervision`; `::never yields a command run by a script, so its result keeps exit_code` |
| RPC and session dispatch | `rpc-headless-jobs.test.ts::delivers the yield and the next-prompt notice over RPC`; `suite/agent-session-jobs.test.ts::starts a background bash job from the model and announces its finish with the next prompt` |
| Extension overrides | `jobs-bash-supervision.test.ts::keeps a backend without a retained handle in the foreground past the yield threshold`; this does not establish all extension override behavior. |
| Baseline resources and usability | Linux measurements are recorded in Evidence below. Comparative task usability and log-read throughput remain unmeasured. |
| Other platforms | Not verified: non-Linux. |

## Problem

Before supervision, `bash` blocked the turn until the command exited. A 90 s test run held the model with no control; `timeout` killed the command and `nohup … &` lost output and completion.

With this change, a command still running after 10 s continues as a background job. The model gets `job_id`, the latest output and a cursor, and can read more or stop it. The agent is told once when the job finishes.

## Facts the design depends on

| Fact (file:symbol) | Consequence |
|---|---|
| `BashOperations.exec` returns only `{exitCode}`; signals are folded into 128+N (`bash.ts:createLocalShellOperations`). Timeout and abort arrive as thrown errors `timeout:<n>` and `aborted`. | State mapping uses the exit code and the thrown error. No signal field exists. |
| Local execution uses a retained native group handle for signalling. | Foreground abort remains an immediate kill. Graceful stop lives in `ManagedJob`, not in `exec`. |
| A shell can exit while other processes in its group continue. | The supervisor retains the native group handle until emptiness is proven or the session closes. |
| Tool calls run in parallel by default (`agent` `toolExecution`). | Foreground calls must not take registry slots. |
| `_beforeToolCall` runs only extension `tool_call` handlers; there is no built-in permission gate (`agent-session.ts:694–700`). | P4 must authorize both `bash` commands and `job` input; ownership alone is not authorization. |
| Nested calls from codemode get ids `<parent>/<n>` (`extensions/types.ts`, `nested-tool-calls.ts`). | `bash` detects nested calls by id and never yields them. Their `exit_code` contract stays intact. |
| `_prepareRun` drains `_pendingNextTurnMessages` (`agent-session.ts:2006`). `sendCustomMessage` with `nextTurn` only queues (`:2450`). | A notice is visible at the next user prompt, not immediately. Notices of jobs the model already saw are dropped at drain time. |
| `AgentSessionRuntime.teardownCurrent` and `dispose` (`agent-session-runtime.ts:167, 409`). Signal exits call `killTrackedDetachedChildren` (hard kill). | Stop-jobs goes into the runtime teardown. Signal exits remain hard kills, documented. |

## Review response (rev 2 review)

| # | Finding | Decision |
|---|---|---|
| B1 | Foreground calls consume slots | Agreed. Calls are prepared unregistered and adopted only at the yield. The cap applies to adoption. A yield that finds the cap full keeps waiting in the foreground. |
| B2 | Abort-first uses grace | Agreed. Pre-yield abort is an immediate kill, as today. Graceful stop is only for `job stop` and session close. |
| B3 | nextTurn not displayed or exactly-once | Partly agreed. Notice is shown at the next prompt, not immediately; documented limit. Exactly-once: notices of jobs observed by a `job` call are dropped at drain. |
| B4 | send_input bypasses gate | Partly agreed. There is no gate today (see Facts). Stated as a P4 requirement. |
| M5 | Codemode shape | Agreed. Nested calls never yield. `exit_code` stays required. |
| M6 | Teardown order, signal exits | Agreed. Stop-jobs runs after `session_shutdown` and before `dispose()`, in `try/finally`. Signal exits are documented hard kills. |
| M7 | Yield-boundary races | Agreed in part. The yield is decided before any await after exec settles; `finishOutput` runs at yield and the accumulator is detached. Backends without retained handles stay foreground and cannot start explicit background jobs. |
| M8 | Descendants outlive the job | Agreed. Group stays tracked and is killed at session close; snapshot shows `descendants: true`. |
| M9 | Registry leaks commands, pid reuse | Agreed. No command in the record; file mode 0600. Orphans are informational; `job stop` never acts on them. |
| M10 | Exit code vs signal | Agreed. Exit code only. |
| m11 | Wiring | Agreed. `job` follows `bash` or `powershell`. `/jobs` is in `interactive-mode.ts`. Registry dir comes from `getAgentDir()`. |
| – | `orphaned` state dropped | Deviation from the issue's frozen list. `orphaned` is a registry report, not a job state. Flagged for the user. |

## Model-facing tools

```
bash({ command, timeout?, background?, name? })
  -> foreground result, unchanged, when it ends before 10 s
  -> text only: "Still running after 10 seconds; continuing as background job <job_id>", the latest output, and a read/stop hint with the cursor. No structuredContent, so no exit_code is claimed.

job({ action: "list"|"status"|"output"|"send_input"|"stop", job_id?, cursor?, input?, maxBytes? })
```

`job` is active whenever `bash` or `powershell` is active and the session supplied a supervisor. `DEFAULT_TOOL_NAMES` does not change. `background: true` in a nested call is an error.

## Job states

`running` → `completed` | `failed` | `stopped` | `timed_out`. First terminal transition wins.

Mapping from the execution outcome, in order:
1. Resolved with exit code 0 → `completed`.
2. Resolved with exit code ≠ 0 and stop was requested → `stopped`.
3. Resolved with exit code ≠ 0 otherwise → `failed` (null code: `failed`, error text "terminated without an exit code").
4. Rejected with `timeout:<n>` → `timed_out`.
5. Rejected with `aborted` and stop was requested → `stopped`.
6. Any other rejection → `failed` with the error text.

`orphaned` is a registry report (below), not a state.

## Yield rule

The bash call prepares the job (exec running, not registered). It waits for the first of: settlement, the 10 s timer, abort.

- Settlement first: the foreground result, built from the same accumulator as today. The job is never registered and produces no notice.
- Timer first and state still `running`: `supervisor.adopt(job)`. If the cap (8) is full, adoption fails and the call keeps waiting in the foreground. Otherwise the call does `finishOutput()` (detaches the accumulator, closes its temp file), sets `announce = true`, and returns the yielded result from the job log.
- Abort first (before yield): immediate kill, error "Command aborted", as today. The job is never adopted.
- After adoption, the call's abort signal is detached. A later abort does not stop the job.
- `timeout` is passed to exec unchanged and still applies after the yield.
- `background: true`: the backend must declare retained-handle support before launch; otherwise the request is rejected without starting the command. A supported backend returns after spawn or settlement.

## Supervisor

One `JobSupervisor` per `AgentSession`. Owner = a stable id created with the session object (not the mutable session id).

```ts
prepare(req): ManagedJob          // runs exec, not registered
adopt(job): boolean               // registers; false when MAX_RUNNING_JOBS (8) reached
start(req): ManagedJob            // prepare + adopt; throws when full (background path)
status / output / sendInput / list / stop / stopSession / killSession / onFinished / orphans
```

- Job ids: 16 hex chars from `randomBytes(8)`. Never a pid.
- Every operation checks owner. A foreign or unregistered id reads as "Unknown job".
- Finished registered jobs: newest 16 by finish order are kept.
- `stop(id, owner, {announce})`: graceful. SIGTERM to the group now; SIGKILL after 3 s if the exec has not settled. Idempotent. Waits grace + 2 s; then `settled: false`.
- `stopSession(owner)`: closes the owner to new jobs, sends TERM, then KILL after a bounded grace period, and waits for cleanup confirmation. Unconfirmed cleanup is warned and its crash record is retained where available.
- `killSession(owner)`: synchronous SIGKILL of running jobs and lingering groups; used by `AgentSession.dispose()`.
- Lingering: a settled job with a retained group handle may still have descendants; the handle is kept until the native owner proves the group empty or session cleanup runs.
- Notices: `onFinished(owner, listener)` fires once per adopted job whose `announce` is true, except a job whose execution failed before its handle was returned (`launchFailed`): the model never received its id. `status` and `output` mark a job observed only when terminal; a model stop marks a finished job observed. A model stop that times out leaves a later finish notice enabled; an overlapping user stop also preserves it. The session drops notices of observed jobs when it drains pending messages.

## Log buffer

Byte ring, 512 KiB, allocated on first append (so unregistered foreground jobs that never yield cost nothing). Absolute offsets; cursor is the decimal offset.

- `read(cursor, maxBytes)`: older-than-window cursor reports `droppedBytes` and a `[N bytes truncated]` prefix; pages do not split UTF-8 sequences. A running job's partial trailing sequence is held back until more output arrives, so a page can return without advancing. Finished output's final page may end in an incomplete sequence, which is shown as U+FFFD. Page size has a 4-byte floor; default 16 KiB, max 64 KiB.
- `tail(maxBytes)`: the latest bytes, with `omittedBytes`. Used for the yield result and the finish notice.
- Output goes through `sanitizeBinaryOutput`. Arguments and environment are never added.

## Local operations additions

`exec` options include these callbacks:

- `onStdin(stream)`: stdin becomes a pipe. Only for explicit background jobs. Not offered when the command comes from stdin.
- `onSpawn(pid)`: reports the group leader pid.
- `onHandle(handle)`: supplies the retained process capability. The pid is informational and is not used as the signal target.

Custom operations opt in to explicit background execution with `retainsProcessHandle: true` and must supply the handle. Without it, foreground execution remains available.

Foreground commands keep stdin `ignore`.

## Session lifecycle

- `AgentSessionRuntime.teardownCurrent` and `dispose`: `abort()`, `session_shutdown`, then `await session.stopJobs()` in `try/finally`, then `session.dispose()`.
- `AgentSession.dispose()`: `killSession` (sync).
- Signal exits (`killTrackedDetachedChildren`) are hard kills, documented.

## Notices and `/jobs`

- Finish notice: `sendCustomMessage({customType: "job_finished", display: true, details: {jobId}}, {deliverAs: "nextTurn"})`. Content: label, job id, state, exit code, error, and a pointer to `job output`. No command output: notices reach the model as user-role text, so output is read through the job tool as tool output.
- Shown at the next user prompt. Limit documented.
- `/jobs` (interactive mode only; in RPC mode the text is sent as a prompt [INFERENCE: not checked]): lists owned jobs and orphans; `/jobs stop <id>` stops owned running jobs only.

## Crash and orphan registry

`<agentDir>/jobs/<job_id>.json`, mode 0600: `{job_id, supervisor_pid, pid, started_at}`. Records contain no command text or session id. A missing directory reports no orphans. Records from another supervisor are reported without probing or killing the recorded pid: after a crash, numeric pids cannot establish identity. Reports can therefore include jobs whose supervisors or process groups have already exited. Invalid or unreadable records are removed.

## Permissions

No central permission gate exists today (see Facts). Session ownership limits which jobs a session can address; it does not authorize their commands or input. In particular, `send_input` may supply commands to an interpreter and must be mediated by P4. P7 sandbox execution and enforcement remain pending; host execution is not evidence of sandbox isolation. Not covered: TUI `!`, RPC `bash`, `pi.exec`, extension code. `bash` and `powershell` supervise commands only when the `job` tool is allowed; otherwise a long command runs in the foreground as before. The P3 security gate remains open until P4/P7 integration is verified.

## Known limits

- Auto-yielded jobs have no stdin; only `background: true` jobs do.
- Notices appear at the next prompt, not immediately.
- Signal exits (SIGHUP, SIGTERM, SIGINT) hard-kill jobs; no grace.
- Custom operations without retained-handle support stay in the foreground and reject explicit `background` before launch.
- Orphan reports are informational: a recorded pid cannot prove process identity after a crash.
- On Unix, a process can leave its original process group with `setsid`; the group handle is not a sandbox. Descendant containment remains a P7 gate.
- Without Linux process-group pidfds (kernels before 6.9, or a sandbox that denies `pidfd_send_signal`), the helper reports `proves_empty: false` at spawn and the fallback pins the group with an unreaped leader, so a finished job keeps its helper, a zombie leader and three pipes. The supervisor bounds this: past 16 such finished jobs per session, the groups that finished longest ago are killed and released (their leftover descendants die early; running jobs and groups the helper can prove empty are never touched). Killed jobs stay owned, so `stopSession` warns that their cleanup is unconfirmed and their crash records remain. Safe emptiness proof without pidfds is not available: the independent review found `/proc` scans race forks, `kill(-pgid, 0)` sees the zombie leader, and a subreaper changes the event's meaning; cgroup v2 or a PID namespace would be a redesign.
- A helper that never reports its spawn (for example an executable on a hung filesystem) cannot read a kill request. A stop request waits 5 s for the spawn, then kills the helper itself. If that spawn later completes, the unowned command can run; no group handle exists to stop it.
- On Linux, a cleanup watchdog also bounds a blocked protocol confirmation write. If the consumer does not read, the helper exits without confirming cleanup; the supervisor retains any available crash record. Other platforms' blocked-write behavior has not been verified.
- Android helpers are shipped for android-arm64 and android-x64. Executing them has not been run here. The pidfd-less fallback above applies to them and to macOS.
- Windows and macOS lifecycle behavior has not been run here.
- `orphaned` is not a job state (deviation from the issue).
- Nested calls never yield.
- Output of a yielded or failed job reaches the model only through the job tool, never inside a notice.


## Review of rev 3 implementation (fresh-context reviewer, verdict incorrect)

Fixed in rev 4:
- `/jobs` threw ENOENT before any job was recorded: a missing registry directory now reports no orphans.
- A job read while running suppressed its finish notice: `status`/`output` mark observed only when terminal.
- A user `/jobs stop` notice was dropped as observed: a model stop no longer marks observed, and user stops are announced.
- `job` tool removed by an allowlist while `bash` still yielded: `bash` gets the job scope only when `job` is allowed.
- `powershell` never supervised: it now receives the job scope.
- `LogBuffer.append` misplaced chunks larger than the window: placement uses the chunk's absolute offset; a test covers a chunk larger than the window.
- A failed background launch announced a notice for an id never returned: the notice is suppressed on launch failure.
- Command output in the finish notice (user-role text): removed from notices.
- A command left running when adoption was refused for a closing owner: the command is stopped.
- `stopSession` always waited 3 s and signalled stale groups: it signals only groups still alive, and waits only when some survive.
- Aborts on the yield tick and background launch: an abort on the same tick as the timer stops the job; a background launch honors the caller's abort until it launches.
- `send_input` reported success for failed writes: the write callback reports errors while the caller waits; after the bounded wait a queued write can still fail.
- `exit_code` optional in the output schema: restored to required; yielded results carry no structuredContent.
- The 512 KiB ring was zero-filled per foreground command with output: allocated with `Buffer.allocUnsafe`, unwritten bytes are never read.
- Cursor not validated: non-integer or negative cursors are rejected with an error.
- Registry records: `session_id` removed (a later process cannot match it); pid and supervisor_pid validated as positive integers.

Not changed: none of the findings was rejected. `stopSession` pid-reuse risk is reduced by the liveness check, not removed.

Round two (review of the rev 4 changes):
- A command that failed before spawning was announced: initially suppressed for pid-less failures; round three replaced this rule with handoff tracking.
- Nested calls were detected by any "/" in the id, so provider ids containing "/" never yielded: nesting now needs a numeric `/<n>` suffix.
- `send_input` could block on a full pipe: input is capped at 16 KiB; a write is refused while earlier bytes are queued; a write the pipe does not take within 1 s is reported as `queued`.
- Cursors such as "" or "1.5" were accepted: only decimal digits are valid; `maxBytes` is floored; a finished job flushes a trailing incomplete UTF-8 character.
- A `job stop` of an already finished job left its notice queued: that stop marks the job observed.
- An unguarded registry delete could throw inside a finish handler: it is guarded like the write; this path has not been independently tested.

Round three (third review of rev 4, verdict incorrect), fixed with tests:
- Finished output could split a character at a page boundary: only the final page of finished output may end in an incomplete character.
- `launchFailed` used pid presence, so a pid-less command that yielded and later timed out lost its notice: a failure counts as a launch failure only before the handle was returned (`markHandedOff`).
- `send_input` could still block: a write is refused while earlier bytes are queued, and a write the pipe does not take within 1 s is reported as `queued`, not as a failure.
- The contract's stale statements (observed rule, page guarantees, test counts) are corrected here and in the lines above.

Focused reviews found incorrect eviction order, duplicate graceful-stop timers, lost stop notices, and stale crash records after descendant cleanup. Regression tests reproduced these before fixes. The original numeric-pid cleanup could signal a reused group; the native-handle cutover is under verification. The process-group lifecycle gate remains open.

Decision: retain native process-group or job-object handles through session cleanup rather than signal unverified numeric process-group IDs. The cutover must preserve shell and job behavior, ship the helper for supported distributions, and fail closed when it is unavailable. P4 and P7 remain pending.

## Evidence

Native-handle cutover on Linux: `cargo build --manifest-path packages/env/daemon/Cargo.toml --locked --bin axiom-process` and `bun run check` passed. Seventeen focused test files passed (187 tests, one skipped), including RPC/headless integration; after the final test type correction, six lifecycle and integration files passed (71 tests). Seven packaging tests passed, and the built helper executed the smoke command. A real shell yielded at 10,002 ms with the same PID and output before and after the yield, and emitted one finish notice. A live offline TUI listed a running job, stopped it, and exited; a separate run exited with a running job and its pid no longer existed. These results do not establish cross-platform behavior or close the lifecycle gate.

Linux cleanup backpressure: a real helper test waits for the shell and output streams to finish, then fills the shared protocol and diagnostic FIFO before requesting cleanup. With the watchdog the helper exited within seven seconds. Earlier tests without the watchdog, and with a watchdog that wrote to blocked diagnostics, left the helper running past seven seconds. This does not establish pidfd-less cleanup or sandbox containment.

An independent review found that Rust's normal process exit can itself block while flushing stdout. A separate FIFO probe reproduced the block with buffered output; `_exit` returned without flushing. Linux abandonment now uses `_exit` after signalling the retained group. A second review found that two threads could race: one claims the kill flag and is descheduled before signalling while the other exits the helper. The flag is now a mutex held across the signal and exit, so no thread exits before the signal is sent. This is correct by construction; no test forces the interleaving. The blocked-cleanup test now decides whether to run from a real helper probe for process-group pidfd support.

A seccomp-controlled Linux run denied `pidfd_send_signal`: a completed shell produced an exit event but the helper remained alive until cleanup. A subreaper alone cannot safely replace the group identity pin for arbitrary descendants and crash paths. The fallback's accumulation is now bounded (see below); a safe emptiness proof without pidfds is still unavailable.

Superseded by the release-build measurement below: an earlier spot check of five sequential idle `sleep` processes used the debug-build helper (median RSS 2,968 KiB, command 2,088 KiB).

Paired comparison on this Linux host, pinned Pi commit `922c3ff2b` versus the working tree, `createLocalBashOperations().exec`, five alternating runs each, medians: abort of `exec sleep` after its first output, 0.27 ms (Pi) versus 0.37 ms (Axiom); `head -c 64MiB /dev/zero` through `onData`, 1,981 MiB/s (Pi) versus 1,311 MiB/s (Axiom, about 34% lower). The cause of the throughput difference was not profiled. Small sample, debug-build helper; no task-success claim.

Decision (owner, 2026-11-08): the roughly 34% pipe-throughput reduction and 0.1 ms abort overhead are accepted as the cost of the retained native process group. No profiling or optimization is planned; revisit only if a real workload regresses.

Release-build per-job cost (eight concurrent idle `sleep` jobs, three runs, `/proc`): the helper's median RSS was 2,492-2,496 KiB (proportional PSS 347 KiB, four threads) on top of the command's 2,092-2,140 KiB, versus 2,084-2,136 KiB for a directly spawned command; spawn-to-`onSpawn` median 7.7-9.4 ms. The Node-side pipes (three file descriptors per helper) are not included in RSS.

Bounded fallback accumulation: with a seccomp filter denying `pidfd_send_signal` (so the helper reports no emptiness proof), 40 sequential `bash` calls left 16 helper processes (64 more file descriptors in the Node process than the 9 before) until `stopSession`, and one after; teardown warned that cleanup of all 40 was unconfirmed. Without the bound each call kept its helper. Linux 7.2 pidfd mode is not bounded and is not affected.

Startup stall: a helper script that ignores the protocol stands in for a blocked spawn. After an abort or timeout, `executeNativeProcess` rejects with `aborted` or the native timeout error after the 5 s grace, and the stand-in helper is killed (two tests). The pidfd-dependent lifecycle tests now skip on a real helper probe instead of the kernel version.

The following measurements predate the native-handle cutover and do not verify it.


- Repo check (`bun run check`): passes after the lifecycle fixes, with no formatting changes on the final run.

- Job and related tests: 157 passed, 1 skipped across 14 files, including the RPC/headless CLI integration and lifecycle regression tests. The skipped test was not inspected.
- Existing bash, tool-list, system prompt and strict-mode tests: pass after adding `job` to expectations that list the default active tools.
- Session-level suite test (`test/suite/agent-session-jobs.test.ts`, 3 tests, faux provider, real local shell): a model-issued `bash` with `background: true` starts a job; the finish notice reaches the next prompt once; `stopJobs()` stops a running job within 5 s; `job` is active only while `bash` or `powershell` is.
- Independent Linux host smoke: a real command yielded at 10,003 ms, kept the same PID, and produced output both before and after yielding; foreign-owner status and stop were rejected, and session cleanup stopped the process group. Natural completion and a user stop each emitted one notice; session cleanup emitted none. The issue's terminal-event wording is not yet reconciled with suppression on session close.
- Before the disposal recheck change, eight multiprocess `killSession` trials all left records after the groups died. After the change, the focused supervisor and real-process files pass (34 tests); the real-process run did not exercise the still-alive-at-settlement branch, which is covered by a deterministic test.
- Live Linux tmux smoke with an offline faux provider: `/jobs` showed an owned running job and `/jobs stop` stopped it; `/quit` stopped another owned job and removed its record. After a forced supervisor crash, a new session displayed the surviving process as orphaned and did not stop it. The process was then stopped by the test, and the stale record was reaped.
- Offline CLI integration (`test/rpc-headless-jobs.test.ts`): RPC and print JSON exposed a job handle and a next-prompt completion notice; RPC client shutdown and print exit stopped running jobs. Print text output and jobs completing after the last prompt were not verified for notice delivery.
- Measured (throwaway script, deleted; Linux, Node, this machine): yield at 10.008 s (bash call to returned handle); stop of a job that obeys SIGTERM 1 ms; stop of a job that ignores SIGTERM 3.006 s (SIGKILL after the 3 s grace); `job stop` 1 ms; log append 13,979 MB/s over 256 MiB in 64 KiB chunks (memory copy only, not disk or pipe throughput).
- Schema bytes (JSON of the parameter schema): `bash` 218 before (command, timeout) and 390 now (adds background, name); `job` 751.
- RSS: Node RSS of the pi process was 99 MB with and without 8 running jobs. This does not measure the jobs, whose `sleep` children are separate processes; the per-job log ring (512 KiB) is allocated only after a job prints output, so idle jobs cost no ring. Real per-job cost is not measured.
- Not verified: Windows, safe process identity across pid reuse, and SIGKILL escalation for lingering descendants. Late disposal uses bounded rechecks and may retain records beyond the window. Print text mode does not report the JSON notice; jobs still running after the final print prompt are stopped during disposal.

## Linux-first completion contract

Complete and verify the existing supervisor on Linux before cross-platform validation. Windows, macOS, Android and Nix checks are not prerequisites for Linux preparation; they remain unverified until exercised. Do not claim the full P3 gate passes on Linux evidence alone where the gate requires other platforms or P4/P7 integration.

1. Audit the pinned Pi Bash, extension overrides, RPC/headless dispatch, session lifecycle, cancellation and subprocess paths. Reconcile this contract with the implementation, including alternatives, interfaces, invariants, tests and rollback.
2. Investigate and fix the Linux helper accumulation and blocked protocol-write risks. Verify bounded cleanup and escalation, concurrency, process counts and resource use. A process group is not sandbox containment; escaped descendants remain a P7 concern.
3. Exercise foreground Bash, extensions, TUI, RPC and headless flows. Record per-job RSS, latency and log throughput against an explicit baseline; do not claim task-success improvements without comparative evidence.
4. Obtain independent focused reviews of the contract and implementation, including lifecycle failure paths and the supporting test evidence.
5. Close only issue checklist items whose complete requirements have passed. Denied-launch and sandbox-isolation evidence remains pending P4 and P7 integration; do not treat host execution or session ownership as proof of either.

Retain `send_input`: it is part of the frozen P3 contract. Deferring it requires an explicit decision and a corresponding contract change.

## Gate evidence to record

Recorded above: yield latency, stop latency, abort latency and pipe throughput versus the pinned Pi, schema bytes, and release-build per-job RSS and spawn latency. Not recorded: a comparison of log read throughput (Pi has no job log to compare), and any task-success measure. Negative results are reported; no task-success claim.
