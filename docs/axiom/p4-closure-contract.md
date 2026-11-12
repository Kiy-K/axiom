# P4 closure contract

Roadmap issue [#1](https://github.com/Kiy-K/axiom/issues/1), phase P4. Paths are relative to `packages/coding-agent/src/`. Builds on [permissions.md](permissions.md).

**Status:** revision 2. D3, D4 and D5 are implemented. A fresh-context review of D3 found one blocker (the OAuth client secret command ran at sign-in and refresh without a prompt) and several smaller gaps; they are fixed. The provider route is gated in D7. D7 had its own review, and a final review of all four commits found no blocker; its high and medium findings are fixed or listed in Carry-over (revision 3). Written from the code at `0f394fb`.

## Problem

Three P4 boxes are open:

1. "One authoritative pre-execution decision API for built-in tools and extensions ... read/write/exec/network/credentials/external side effects."
2. The payload half of the hardening item: command output and audit log size.
3. The gate: "fail-closed unsupported actions; denial and prompt boundaries proven by tests; document actions that cannot be mediated."

Item 1 cannot be met literally without a sandbox: an extension runs in-process and can call `node:child_process`, and a shell is opaque. Left as written, the box stays open until P7 and hides how much of the route set is already closed. The contract narrows item 1 to a claim the code can keep and lists everything outside it.

## Decisions

### D1. What "authoritative" covers

The gateway is authoritative for every route where input chosen by the **model or an extension** selects what runs. A route chosen by the **user** or by **trusted configuration** is outside it, recorded in the table below with the control that applies. Code an extension runs by itself is outside any in-process gate (P7).

Inventory, from a search of `spawn`/`exec` call sites and the dispatch paths. Every row was checked against the code by two fresh-context reviews; the one row they could not confirm end to end is marked.

| Route | Who chooses what runs | Class | Control |
|---|---|---|---|
| Model tool calls (`core/agent-session.ts:_beforeToolCall`) | model | gated | gateway |
| Nested `ctx.executeTool` | extension tool, model input | gated | gateway, own `parentToolCallId` |
| `pi.exec` (`core/extensions/loader.ts`) | extension | gated | gateway (done, `0f394fb`) |
| User `!`/`!!` in the TUI (`modes/interactive/interactive-mode.ts`) and RPC `bash` (`modes/rpc/rpc-mode.ts`) | user (RPC: its client) | exempt | recorded as `user-command`; see D2 |
| `axiom install/update` (`package-manager-cli.ts`) | user | exempt | user command |
| Missing packages installed while resolving settings (`core/package-manager.ts:installMissing`) | settings file | trust-gated | project trust for project settings; not the gateway |
| MCP stdio servers, scope `global` (`extensions/mcp/runtime.ts:createDefaultTransport`) | user's `mcp.json` | exempt | user-authored config |
| MCP stdio servers, scope `project` | project `mcp.json` | trust-gated | project trust |
| `!command` apiKey, headers and model headers of providers an extension registers (`core/provider-composer.ts`) | extension | **gated (new, D7)** | gateway via a `ModelRuntime` hook |
| MCP stdio servers, scope `extension` | extension via `registerMcpServer` | **gated (new, D3)** | gateway |
| `!cmd` config values (`core/resolve-config-value.ts`) | settings, `models.json`, `mcp.json` env | trust-gated | project trust |
| Codemode `models.*` (`extensions/codemode/execute.ts`) | model-written script | not mediated | sends script-chosen content to a configured provider only; the `codemode` tool itself asks by name |
| Fixed-argv helpers (`footer-data-provider.ts` git, `utils/tools-manager.ts`, clipboard, open-browser, external editor) | harness | exempt | no model- or extension-controlled argv |
| Extension code using `node:child_process`, `createBashTool`, `createLocalBashOperations` | extension | not mediated | P7 |
| Opaque shell contents, TOCTOU on paths | model | not mediated | P7; a shell command still asks |

### D2. User-typed commands stay exempt

A command the user types (`!cmd`, RPC `bash`) is consent. It is recorded, not blocked. Alternative rejected: gate it. The user would be asked to approve what they just typed, and an RPC client (the user's own program) could not run commands without a UI round trip. The RPC client is part of the trust base, and the docs say so.

Not covered by D2: an extension's `user_bash` handler can replace the executor (`operations`) or the result. That is extension code, listed as not mediated.

### D3. MCP stdio servers registered by an extension ask before they spawn

`McpServerEntry.scope` already records where an entry came from. In `manual` mode, a server with `scope === "extension"` asks before each process connecting it starts: the stdio `command`, `args` and `cwd`, and every `!command` value in its `env`, `headers` or `oauth.clientSecret` (judged as `sh -c <body>`, since `resolveConfigValue` runs them through a shell). The caller is the registering extension's path (`entry.source`). Same rules, grants and audit as `pi.exec`. The MCP extension reaches the gateway through a new public `pi.authorizeExec(command, args, { cwd, signal, onBehalfOf })`, which judges and starts nothing; other extensions that spawn their own processes can use it too.

Alternatives rejected:

- Gate every stdio server: `global` entries are user-authored, and asking at every startup, before a UI is bound, would deny them all.
- Gate `project` entries too: project trust already decides whether the file is read, and a second prompt per server adds friction without a new boundary. Revisit in P5, when trust levels are defined.

Failure behavior: the connection goes to its existing error state with the gateway's reason, and does not retry in a loop on a denial. The prompt is answered before `createTransport` runs, so a denied server starts nothing. Gating is once per connection attempt (not per retry). The OAuth client secret command cannot be asked at its use, because `oauthSettings()` is synchronous and runs on every token refresh inside the pi-mcp package, so it is approved at connect and sign-in and kept for the connection.

Open question for the reviewer: connects can happen before a UI is bound, so extension servers would be denied at startup in `manual` mode. Proposed answer: that is correct (fail closed), and the user approves by reconnecting from `/mcp`.

### D4. Command output is not redacted; control characters are stripped

`job output` and the output shown when a command moves to the background are what the command printed. Redacting it mangles legitimate output and gives false assurance, and the model could print the same data with a plain `bash` call. Decision: no redaction of command output, and the docs say so.

The buffer is already bounded (512 KiB ring, 64 KiB page, 16 KiB on yield) and drops C0 controls including ESC (`utils/shell.ts:sanitizeBinaryOutput`). Gap read from its regex: it stops at `\x1F`, so DEL and C1 controls (`\x7F` to `\x9F`, including 8-bit CSI `\x9B`) pass through. Fix: strip `\x7F-\x9F` from log pages in `core/jobs/log-buffer.ts`, as `stripControlSequences` already does for metadata. The implementation first reproduces the gap with a failing test.

### D5. The audit log is capped by rotation

`AuditLog` (`core/permissions/audit.ts`) appends without limit. When the file reaches `AUDIT_MAX_BYTES` (5 MiB), rename it over `permissions.jsonl.1` (one generation kept) and start a new file, mode 0600 for both. The size is read with `stat` on every write, not counted in memory, because sessions share the file and a private count would drift. A rotation or write failure goes to `onError` and never changes a decision (existing rule). The cap is a constructor option so tests can use a small value.

### D6. The gate box

Ticked when all of this holds:

- D3, D4 and D5 are implemented with the tests below.
- `permissions.md` carries the D1 inventory in place of the free-text "Not mediated" list.
- Fail-closed is shown for every name in `allToolNames`: called with empty input `{}` in `manual` mode, none returns allow. `job` is not in that set; `job {}` is allowed by design because it has no effect, and only `send_input` is judged.
- A fresh-context reviewer, given the issue and the code, has attacked the final state, and every high and medium finding is fixed or listed as open.

The default stays `unrestricted`. Changing it is P5. Ticking the gate means the mechanism meets its stated bounds, not that the default is safe.

## Item 1 wording

Replace the box text with: "One authoritative pre-execution decision for every route where the model or an extension chooses what runs, and a documented control for every other route." Routes that cannot be mediated in-process stay listed (P7).

## Tests

Each test must fail against a plausible wrong implementation.

| Case | Wrong implementation it catches |
|---|---|
| Extension-scope MCP stdio spawn, user denies: no transport is created | gate placed after the spawn |
| Same, user allows once: transport created with exactly the `command`, `args` and `cwd` that were judged | judged line differs from spawned line |
| Global-scope and project-scope entries spawn with no prompt in `manual` mode | gate applied to every scope |
| A denied extension server does not respawn in a loop | retry on denial |
| Extension server in `unrestricted` mode: no prompt, no audit entry | gate not a no-op |
| Audit file at the cap rotates to `.1`; both files 0600; newest entry in the new file; one generation kept after a second rotation | no rotation; rotation losing the new entry; old generations piling up |
| Audit rotation failure still returns the decision | rotation error treated as a denial or thrown |
| Log page with `\x9b2J`, `\x7f` and a multibyte character: controls removed, the character intact | stripping by byte (corrupts UTF-8), or not at all |
| Every built-in tool name with `{}`: never allow | a new tool added without a policy row |

## Out of scope

Gating user commands, project-scope MCP prompts, output redaction, accept-edits (P5), the sandbox (P7), and the other open review findings in `permissions.md` (write grants covering workflow files, `mv`/`cp` risks, and so on).

## Rollback

One commit per decision: MCP spawn gate, log-page stripping, audit rotation, docs. Reverting any one leaves the others working. `unrestricted` mode is unaffected by all of them.

## Questions for the reviewer

1. Is any model- or extension-controlled route missing from the D1 table? Look past `spawn`: `Worker`, `fork`, `import()` of extension paths, `fetch` to attacker-chosen URLs.
2. Is D3's startup denial acceptable, or should extension servers wait for a UI?
3. Does D4's argument ("the model could print it") still hold for a job that started before a permission was revoked?
4. Is single-generation 5 MiB rotation enough, or can an attacker use rotation to evict the record of an earlier decision?

### D7. Extension-registered provider `!command` values ask before they run

`ModelRuntime.addExecAuthorizer(authorizer)` adds a check that runs before the harness executes a `!command` value an extension gave a provider. Each `AgentSession` adds its own in its constructor, as `gateway.authorizeExec("sh", ["-c", body], { extensionPath })`, and removes it on dispose. The runtime outlives sessions and may be shared, so every installed check must allow a command. An allow is remembered for 30 seconds per provider, extension and command, a new check clears that memory, identical asks in flight share one prompt, and a refusal is never remembered. The bodies come from the extension's own config only (`extension.apiKey` when no credential is stored, `extension.headers`, the extension's model `headers`), never from `models.json`. It is asked at the three places the harness resolves them: `composeApiKeyAuth.resolve`, `composeOAuthAuth.toAuth`, and the per-model header resolution in `ModelRuntime.getAuth` and `getCompatibilityRequestConfig` (now async). The registering extension's path is threaded from `pi.registerProvider` through `ExtensionRunner.bindCore` and `ModelRegistry.registerProvider` into `ModelRuntime`. A refusal rejects the resolution, and no command runs.

Known limit: a runtime without a session has no check and runs the commands unasked; the CLI loads no extensions in session-less commands, so it is not affected. Not done: a native `Provider` object registered by an extension is extension code and is not asked about.

## Carry-over

- **Fixed (was medium): SDK sessions sharing one `ModelRuntime`.** Each session adds a check and all must allow; dispose removes it.
- **Fixed (was medium): prompt volume for provider commands.** An allow is remembered for 30 seconds and identical in-flight asks share one prompt. Left: a command with a named risk still asks every 30 seconds, an OAuth-path prompt has no abort signal, and the prompt has no queue across different commands. Cache warm-up timing was not verified.
- **Low: attribution.** Provider registrations merge, but the prompt names the extension that registered last, so a command another extension set can be shown under the wrong name.
- **Low: judged shell and directory.** The harness runs a `!command` through the platform default shell in `process.cwd()`; the gateway judges `sh -c <body>`. See Windows below.
- **Windows.** `!command` values run through the default shell or the configured one, while the gateway judges them as `sh -c <body>`; cross-spawn may route `.cmd` shims through cmd.exe. The POSIX lexical classifier may misjudge them there. Not verified.
- **Prompt volume.** A server with N `!command` values asks N+1 times in a row. Grouping them into one prompt is not done.
- **OAuth authorization URL scheme: closed.** `packages/mcp/src/oauth/flow.ts` rejects a non-http(s) authorization endpoint before the URL reaches `openBrowser` (tested in `packages/mcp/test/oauth.test.ts`). An earlier note here said no check existed; that was wrong.
