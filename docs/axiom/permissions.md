# P4: Central permission gateway

Roadmap issue [#1](https://github.com/Kiy-K/axiom/issues/1), phase P4. Paths are relative to `packages/coding-agent/src/`.

**Status:** gateway, policy, grants, audit and redaction are implemented and tested. The default mode is still `yolo` (Pi's behavior). P4 acceptance is not claimed: see [Routes and their control](#routes-and-their-control) and [Open](#open).

## Problem

Before this change nothing decided whether a tool call may run; `tool_call` extension handlers were the only hook (`architecture.md` section 2). A permissive default such as accept-edits (P5) or Auto Mode (P6) needs one place that decides, outside the model, and fails closed.

## Design

`core/permissions/` holds one `PermissionGateway` per `AgentSession`. `AgentSession._beforeToolCall` calls `gateway.authorize()` **after** the extension `tool_call` chain, so it judges the input the tool will receive (handlers mutate `event.input` in place). Nested calls from `ctx.executeTool` (codemode) pass through the same function with `parentToolCallId`, so they are gated separately from the outer call.

```
tool call -> extension tool_call handlers -> gateway.authorize -> tool.execute
                                                |
              mode = yolo: allow, no audit
              mode = manual: actions -> allow | deny | ask -> (grant? prompt?) -> audit
```

Setting `permissionMode` (global settings only): `"yolo"` (default when unset, gateway off), `"manual"`, `"accept-edits"`, or `"auto"`. `auto` is `manual` plus positive allow rules from the [P6 contract](p6-auto-mode-contract.md); the plumbing exists (slice S1) but no rule relaxes anything yet, so it behaves as `manual`. It acts as `auto` only in an interactive TUI session with `CI` unset; everywhere else its effective mode is `manual`. In `accept-edits`, explicit session trust can allow eligible built-in edits to tracked files in a clean Git worktree; other actions follow the manual rules. It fails closed: any other value, including the former `"unrestricted"` name, and an unreadable global settings file, mean `manual`. A value that is set but not recognized (the former name or a typo) is not migrated, and startup prints a warning that names the value and says the session runs in `manual`; for the former name it says to set `"yolo"` to turn the gateway off. An unreadable file gets only the parse error. A project setting cannot loosen it. Settings are read when the session loads or reloads (`/reload`), not on every call.

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
| `pi.exec(command, args, { cwd })` from extension code, and `pi.authorizeExec(command, args, { cwd, onBehalfOf })`, which asks the same question without starting anything | judged as the shell line `command args` (each argument quoted as one word), preceded by `cd <dir> &&` when `cwd` is not the session directory, so it has the shell rules above and shares exact-command grants with `bash` (a grant for a command in one directory does not cover it in another). The tool is named `pi.exec`; the prompt shows the extension path on an `Extension:` line (cut from the front, so the file name stays visible) and the audit entry has it as `caller`. A grant is keyed by the command alone, so it also covers the same command from another extension or from `bash`. Every call asks, including those from event handlers and slash commands (auto-commit on exit, checkpoints); with no UI they are denied. A block rejects the call with the reason (other `pi.exec` failures resolve with a nonzero `code`), so a call an extension neither awaits in `try`/`catch` nor `.catch()`es can become an unhandled rejection; a caller whose `signal` had aborted gets a `killed: true` result instead, and nothing is started. A command over 2000 characters once quoted (each `'` in an argument takes four) is denied. The session must still be live when the user answers: if the extension context went stale meanwhile, the call rejects and nothing runs |
| built-in name whose input lacks the expected shape, or a path that cannot be resolved | **deny** |

Paths are resolved with symlinks followed through the deepest existing ancestor, and a dangling symlink is followed to where it points (up to 40 hops, else the call is denied), so `link-to-outside/new.txt` counts as outside and a link to `.git/hooks/pre-commit` is protected. A relative link target is resolved against the real directory that holds the link. For `read` and the hashline `edit`, the files judged are every one the tool may open, including the curly-quote, NFD and AM/PM name variants of the name given; the strictest verdict wins. A prompt that is dismissed, times out (2 minutes) or is aborted is a denial. The gateway enforces that deadline itself, so a UI that ignores the timeout cannot hang the call. With no UI bound (print mode) an ask is denied at once. RPC always binds a UI, so an ask there waits for the client to answer the `extension_ui_request` and is denied after 2 minutes. Any exception inside the gateway is a denial.

Grants are per session, in memory, expire after 10 minutes, and are revoked with `/permissions revoke <id|all>`. A resumed or new session starts with none. `/permissions` shows the mode, live grants and the last decisions.

### Audit and redaction

Every decision in `manual` mode is appended to `<agentDir>/audit/permissions.jsonl` (mode 0600) and kept in memory (last 200). The file moves to `permissions.jsonl.1` (replacing an older one) once it holds 5 MiB, so at most two files of about that size exist; the size is read on every write because sessions share the file. A write or rotation failure is reported as an extension error and never changes the decision. **Prompts are not redacted.** They show each command as written, with only control sequences and invisible or bidirectional Unicode removed and whitespace collapsed to one line, because a redacted span of a command can hide the code being approved. The audit log and job names, commands and errors in `job` output have those removed too and, in addition, known credential shapes (assignments in any case, headers, `--token` style options, `curl -u`, URL passwords, common key formats) and sensitive environment values replaced by `[REDACTED]`. Credential-word matching needs a whole word (`token`, `secret`, `password`, `api_key`, `*_KEY`); a bare `key` is not enough. Only the first 2 x the display limit is scanned, and a shell command over 100,000 characters is denied before it is scanned, so cost does not grow with input size. Not covered: `mysql -pPASS`, `sshpass -p`, `docker login -p`, `sk_live_`, `AIza`, `glpat-` shapes. Command output returned by `job output` or shown when a command moves to the background is not redacted, by decision: redaction would mangle arbitrary command output and give false assurance, and the model can print the same data with a plain `bash` call. The log buffer bounds it (512 KiB retained, 64 KiB per page) and removes C0 controls, DEL and C1 controls (including 8-bit CSI), so output cannot move the cursor or retitle the terminal. The audit `sessionId` is the session manager id. Redaction is best effort and does not replace denying access.

## Routes and their control

The gateway is authoritative for every route where the **model or an extension** chooses what runs. Every other route is listed here with the control that applies. Paths are relative to `packages/coding-agent/src/`; the design is in [p4-closure-contract.md](p4-closure-contract.md).

| Route | Who chooses what runs | Class | Control |
|---|---|---|---|
| Model tool calls (`core/agent-session.ts:_beforeToolCall`) | model | gated | gateway |
| Nested `ctx.executeTool` | extension tool, model input | gated | gateway, own `parentToolCallId` |
| `pi.exec` | extension | gated | gateway |
| `pi.authorizeExec`, used by `extensions/mcp` for MCP servers an extension registers: the stdio command (shown with its `env`), each `!command` env or header value, and the `!command` OAuth client secret (asked at connect and sign-in, resolved once per connection) | extension | gated | gateway, as `pi.exec`. Asked once per connection attempt, so a reconnect asks again |
| User `!`/`!!` in the TUI and RPC `bash` | user (RPC: its client) | exempt | recorded as `user-command`, not blocked: typing it is the consent, and an RPC client is part of the trust base. An extension's `user_bash` handler can replace the executor or the result; that is extension code (below) |
| `axiom install`/`update`/`remove` | user | exempt | user command |
| Missing packages installed while resolving settings | settings file | trust-gated | project trust for project settings; not the gateway |
| MCP servers from `mcp.json`, global or project | user's or project's config | exempt | user-authored; project config is read only in a trusted project |
| `!command` values in `models.json` and `auth.json` (provider keys and headers, `core/auth-storage.ts`, `core/provider-composer.ts`) and in the `env`, `headers` and OAuth secret of `mcp.json` servers (`core/resolve-config-value.ts`) | user's config | exempt | `models.json` and `auth.json` are global files in the agent directory, written by the user; project trust does not apply to them. Project `mcp.json` is read only in a trusted project. Only these callers resolve `!command` values; no `settings.json` value does |
| `shellPath`, `shellCommandPrefix` and `npmCommand` in `settings.json`: choose the shell binary and a prefix that every model `bash` command runs with, and the npm binary for package installs | user's config, project settings when trusted | trust-gated | project trust. The gateway judges only the command text, so in a trusted project whose `settings.json` sets these, the binary and prefix are not shown at the prompt (`permissionMode` itself is read from global settings only). Not verified end to end |
| Harness helpers with a fixed binary (`gh`, `rg`, `trash`, clipboard, browser opener, `$EDITOR`, `git` for the footer, tool downloads) | harness, started by a user action or startup | exempt | none chosen by the model or an extension. `open-browser` receives the OAuth authorization URL a server's discovery supplies during a sign-in the user starts; its scheme is checked to be `http(s)` before (`packages/mcp/src/oauth/flow.ts`) |
| `!command` values in a provider an extension registers with `pi.registerProvider`: `apiKey` (when no credential is stored), provider `headers`, and the `headers` of its models (`core/provider-composer.ts`, `core/model-runtime.ts`) | extension | gated | gateway, through `ModelRuntime.addExecAuthorizer`, which each `AgentSession` calls (and undoes on dispose): each body is judged as `sh -c <body>` and the prompt names the extension that registered the provider. Credentials and request headers resolve on every LLM request (and on a cache warm-up request, if one fires), so an allow, including "Allow once", is remembered for 30 seconds per provider, extension and command, and identical asks in flight share one prompt; a refusal is never remembered. After 30 seconds it asks again; a command with a named risk (network, secrets, publish, destructive) gets no grant, so it asks every 30 seconds at most. Header commands are asked about only once a credential exists to send them with. The caller's abort signal ends a waiting prompt on the `apiKey` and per-model header paths, not on the OAuth path, which has no signal. The prompt names the extension that registered the provider last. A refused, dismissed or expired prompt is not worded as a transient error, so the agent's auto-retry does not re-ask. Checks belong to the runtime and every installed check must allow, so sessions that share one `ModelRuntime` (SDK use) cannot switch each other's gate off; a runtime with no session has no check, so it runs the commands unasked. With no UI (print mode) a provider with a command value fails to resolve. `!command` values in the user's own `models.json` are exempt (user config). Providers registered as a native `Provider` object are extension code (below) |
| `auth.provider` on an extension's MCP server | extension | exempt for the key lookup | it reads the named provider's key: the gate above applies if an extension registered that provider, and a `models.json` command is the user's own. The key is then sent to the server's URL, which the extension chose; an in-process extension can read the key directly, so this is extension code (below) |
| Codemode `models.*` | model-written script | not mediated | sends script-chosen content to a configured provider; the `codemode` tool itself asks by name |
| Extension code: handlers, factories, in-process file and network access, `node:child_process`, the exported `createBashTool` and `createLocalBashOperations`, a `pi.exec` or `pi.authorizeExec` called while the extension factory loads (before the gateway is bound) | extension | not mediated | P7 |
| A shell's contents (`eval`, variable expansion, scripts written then run, `bash -c` bodies built at runtime) | model | not mediated | P7. Every shell command still asks, so the lexical classifier only names risks and withholds grants |
| TOCTOU: the gateway resolves a path once and the tool resolves it again when it runs | model | not mediated | P7. A link swapped in between can redirect it |
| Built-in slash commands that write files or use the network, startup network calls | user, harness | exempt | no model- or extension-chosen input |
| Bare `Agent` (pi-agent-core) and Durable/p2 | embedder | not mediated | they have their own loops and no gateway |

Fail-closed is tested for the built-ins: each name in `allToolNames`, called with `{}` and nobody to ask, is blocked (`test/permissions-gateway.test.ts`). A tool without a policy row is an `extension` action and asks.

## Open

- Not done from review: a workspace write grant covers `.github/workflows`, `package.json`, `.vscode`, `.envrc` and similar files that run code; the exact-command grant is shared between `bash`, `job send_input` and `pi.exec` and survives edits to a script it runs; `mv`, `cp`, `sed -i`, `tee` and redirections have no named risk; option-prefixed subcommands are found only within the first three words after the command (first for git); `.git/config` is not credentials-like; the gateway uses the session manager's cwd, not a tool context cwd.

- A user who never set `permissionMode` but has an unreadable global `settings.json` gets `manual` until the next successful reload.
- `yolo` (formerly `unrestricted`) remains the default; `accept-edits` is opt-in.
- `/mode [manual|accept-edits|auto|yolo]` sets a session override (not saved to settings); `/mode yolo` asks to confirm. The effective mode is `override ?? setting`. Changing it clears all grants and edit trust, and a prompt open across the change is a denial. A new, resumed or forked session starts from the setting, except that an override stricter than the setting is carried over. `/reload` drops an override that is not stricter than the reloaded setting. In-process extension code can still reach the TUI submit handler or the settings file, so this is not a boundary against extensions (P7). Editing the settings file takes effect after `/reload` or a new session.
- Cross-session job access is covered by the supervisor's owner check, not by new gateway tests.
- Prompts show text only; there is no diff preview for edits.
