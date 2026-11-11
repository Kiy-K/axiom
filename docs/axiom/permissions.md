# P4: Central permission gateway

Roadmap issue [#1](https://github.com/Kiy-K/axiom/issues/1), phase P4. Paths are relative to `packages/coding-agent/src/`.

**Status:** gateway, policy, grants, audit and redaction are implemented and tested. The default mode is still `unrestricted` (Pi's behavior). P4 acceptance is not claimed: see [Not mediated](#not-mediated) and [Open](#open).

## Problem

Before this change nothing decided whether a tool call may run; `tool_call` extension handlers were the only hook (`architecture.md` section 2). A permissive default such as accept-edits (P5) or Auto Mode (P6) needs one place that decides, outside the model, and fails closed.

## Design

`core/permissions/` holds one `PermissionGateway` per `AgentSession`. `AgentSession._beforeToolCall` calls `gateway.authorize()` **after** the extension `tool_call` chain, so it judges the input the tool will receive (handlers mutate `event.input` in place). Nested calls from `ctx.executeTool` (codemode) pass through the same function with `parentToolCallId`, so they are gated separately from the outer call.

```
tool call -> extension tool_call handlers -> gateway.authorize -> tool.execute
                                                |
              mode = unrestricted: allow, no audit
              mode = manual: actions -> allow | deny | ask -> (grant? prompt?) -> audit
```

Setting `permissionMode` (global settings only): `"unrestricted"` (default when unset, gateway off) or `"manual"`. It fails closed: any other value (`"Manual"`, `"strict"`), and an unreadable global settings file, mean `manual`. A project setting cannot loosen it. Settings are read when the session loads or reloads (`/reload`), not on every call.

### Actions and rules in `manual` mode

A call maps to zero or more actions (`core/permissions/policy.ts:actionsForToolCall`); the strictest verdict wins.

| Action | Decision |
|---|---|
| `read` of a file inside the workspace; `ls`/`find`/`grep` aimed at one existing file | allow |
| `ls`/`find`/`grep` aimed at a directory (the default), inside the workspace | ask; **no grant offered**, because the search also reads credentials files under it |
| read outside the workspace | ask; grant offered for that directory |
| read of a credentials-like path (`.env*` except examples, `.ssh`, `.aws`, `.docker`, `.npmrc`, `*.pem`, `*.tfstate`) or of the agent directory | ask; **no grant offered** |
| write of a credentials-like path | ask; **no grant offered** (writes to the agent directory are denied, below) |
| write or edit under `.git`, `.husky`, `.axiom`/`.pi` or the agent directory | **deny** |
| write or edit outside the workspace | ask; grant for that directory |
| write or edit inside the workspace | ask; grant for the workspace |
| shell command (`bash`, `powershell`) | ask; grant for the **exact** command, only when no named risk |
| shell command that runs `sudo`, `su`, `doas` and similar: first word of a command, after an operator, keyword (`then`, `do`, `!`, `{`) or wrapper (`env`, `timeout`, `xargs`...), or inside `bash -c` | **deny** |
| the same word elsewhere in a command (`find -exec sudo`, `command -v sudo`, `echo sudo`) | ask; no grant (it may or may not run). A quoted word that only contains it (`git commit -m "remove sudo usage"`) does not count |
| shell command longer than 2000 characters once whitespace is collapsed | **deny**: the prompt must show the whole command |
| shell command with a lexical risk (network, publish, destructive, secrets) | ask; no grant; the prompt names the risk |
| `job send_input` | treated as shell text (stdin can feed an interpreter) |
| `job list/status/output/stop` | no action (the supervisor's owner check applies) |
| any other tool (extension, MCP, codemode) | ask; grant per tool name |
| `pi.exec(command, args, { cwd })` from extension code | judged as the shell line `command args` (each argument quoted as one word), preceded by `cd <dir> &&` when `cwd` is not the session directory, so it has the shell rules above and shares exact-command grants with `bash` (a grant for a command in one directory does not cover it in another). The tool is named `pi.exec`; the prompt shows the extension path on an `Extension:` line (cut from the front, so the file name stays visible) and the audit entry has it as `caller`. A grant is keyed by the command alone, so it also covers the same command from another extension or from `bash`. Every call asks, including those from event handlers and slash commands (auto-commit on exit, checkpoints); with no UI they are denied. A block rejects the call with the reason (other `pi.exec` failures resolve with a nonzero `code`), so a call an extension neither awaits in `try`/`catch` nor `.catch()`es can become an unhandled rejection; a caller whose `signal` had aborted gets a `killed: true` result instead, and nothing is started. A command over 2000 characters once quoted (each `'` in an argument takes four) is denied. The session must still be live when the user answers: if the extension context went stale meanwhile, the call rejects and nothing runs |
| built-in name whose input lacks the expected shape, or a path that cannot be resolved | **deny** |

Paths are resolved with symlinks followed through the deepest existing ancestor, and a dangling symlink is followed to where it points (up to 40 hops, else the call is denied), so `link-to-outside/new.txt` counts as outside and a link to `.git/hooks/pre-commit` is protected. A relative link target is resolved against the real directory that holds the link. For `read` and the hashline `edit`, the files judged are every one the tool may open, including the curly-quote, NFD and AM/PM name variants of the name given; the strictest verdict wins. A prompt that is dismissed, times out (2 minutes) or is aborted is a denial. The gateway enforces that deadline itself, so a UI that ignores the timeout cannot hang the call. With no UI bound (print mode) an ask is denied at once. RPC always binds a UI, so an ask there waits for the client to answer the `extension_ui_request` and is denied after 2 minutes. Any exception inside the gateway is a denial.

Grants are per session, in memory, expire after 10 minutes, and are revoked with `/permissions revoke <id|all>`. A resumed or new session starts with none. `/permissions` shows the mode, live grants and the last decisions.

### Audit and redaction

Every decision in `manual` mode is appended to `<agentDir>/audit/permissions.jsonl` (mode 0600) and kept in memory (last 200). The file moves to `permissions.jsonl.1` (replacing an older one) once it holds 5 MiB, so at most two files of about that size exist; the size is read on every write because sessions share the file. A write or rotation failure is reported as an extension error and never changes the decision. **Prompts are not redacted.** They show each command as written, with only control sequences and invisible or bidirectional Unicode removed and whitespace collapsed to one line, because a redacted span of a command can hide the code being approved. The audit log and job names, commands and errors in `job` output have those removed too and, in addition, known credential shapes (assignments in any case, headers, `--token` style options, `curl -u`, URL passwords, common key formats) and sensitive environment values replaced by `[REDACTED]`. Credential-word matching needs a whole word (`token`, `secret`, `password`, `api_key`, `*_KEY`); a bare `key` is not enough. Only the first 2 x the display limit is scanned, and a shell command over 100,000 characters is denied before it is scanned, so cost does not grow with input size. Not covered: `mysql -pPASS`, `sshpass -p`, `docker login -p`, `sk_live_`, `AIza`, `glpat-` shapes. Command output returned by `job output` or shown when a command moves to the background is not redacted, by decision: redaction would mangle arbitrary command output and give false assurance, and the model can print the same data with a plain `bash` call. The log buffer bounds it (512 KiB retained, 64 KiB per page) and removes C0 controls, DEL and C1 controls (including 8-bit CSI), so output cannot move the cursor or retitle the terminal. The audit `sessionId` is the session manager id. Redaction is best effort and does not replace denying access.

## Not mediated

These routes run without the gateway. Each is outside the model's tool calls or runs arbitrary code, so in-process rules cannot see it. P7 (sandbox) or project trust is the control.

- A shell is opaque. The risk classifier is lexical: `eval`, variable expansion, scripts written then run, and `bash -c` bodies built at runtime defeat it. In `manual` mode every shell command still asks, so the classifier only names risks and withholds grants.
- Extension code: handlers, factories, in-process file and network access, and any process it starts itself (`node:child_process`, the exported `createBashTool` and `createLocalBashOperations`). Extension tools are asked about by name, not by effect. `pi.exec` is the only extension route that is mediated (see the table above), and only once the session has bound its gateway: a factory that runs a command while loading is not.
- User `!`/`!!` in the TUI and RPC `bash`: the user typed it, so it is recorded (`user-command`) and not blocked.
- Built-in slash commands that write files or use the network, `!cmd` config values, package install, startup network calls, MCP server spawning, codemode `models.*`.
- TOCTOU: the gateway resolves a path once and the tool resolves it again when it runs. A link swapped in between can redirect it.
- Bare `Agent` (pi-agent-core) and Durable/p2 have their own loops and no gateway.

## Open

- Not done from review: a workspace write grant covers `.github/workflows`, `package.json`, `.vscode`, `.envrc` and similar files that run code; the exact-command grant is shared between `bash`, `job send_input` and `pi.exec` and survives edits to a script it runs; `mv`, `cp`, `sed -i`, `tee` and redirections have no named risk; option-prefixed subcommands are found only within the first three words after the command (first for git); `.git/config` is not credentials-like; the gateway uses the session manager's cwd, not a tool context cwd.

- A user who never set `permissionMode` but has an unreadable global `settings.json` gets `manual` until the next successful reload.
- `unrestricted` remains the default until P5 defines accept-edits on top of this gateway.
- No `/mode` switch (P6). The setting is read from memory on every call; editing the file takes effect after `/reload` or a new session.
- Cross-session job access is covered by the supervisor's owner check, not by new gateway tests.
- Prompts show text only; there is no diff preview for edits.
