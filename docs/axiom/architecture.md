# Axiom architecture map (P0 "Elephant")

Baseline map for roadmap issue [#1](https://github.com/Kiy-K/axiom/issues/1). Paths are relative to the repo root; `cad/` = `packages/coding-agent/src/`. Citations are `file:symbol` (`:N` = line at time of writing). `[INFERENCE]` = read but not executed.

## 1. Package boundaries

The `pi` CLI is coding-agent + agent + ai + tui + codemode + mcp (+ schema, telemetry). chord/durable/env/p2 are a separate Durable stack with their own agent loop.

| Package (npm name) | Purpose | Workspace deps | Public entry points |
|---|---|---|---|
| `packages/telemetry` (pi-telemetry) | Vendor-neutral telemetry contracts | none | `.`, `./render`, `./testing` |
| `packages/schema` (pi-schema) | Eval-free JSON Schema (2020-12/7) validator compiled to closures, TypeBox-compatible `Static` | none | `src/index.ts` (`compile`, `Validator`, builders `str/obj/...`), `./formats` |
| `packages/ai` (pi-ai) | Multi-provider LLM API, model catalog, faux provider, tool-arg validation | schema, telemetry | `.`, `./models`, `./api/*`, `./providers/*`, `./utils/*`, `./oauth`; bin `pi-ai` |
| `packages/agent` (pi-agent-core) | Generic agent loop + state | ai, schema | `agent.ts:Agent`, `agent-loop.ts:agentLoop/runToolCall` |
| `packages/tui` (pi-tui) | Differential-render terminal UI | none | `src/index.ts` |
| `packages/codemode` (pi-codemode) | QuickJS-WASM sandbox whose only capability is injected tools | quickjs-wasi | `.`, `./worker`, `./portable`, `./cloudflare` |
| `packages/mcp` (pi-mcp) | MCP client (stdio/HTTP, OAuth) | none | `.`, `./oauth`, `./testing` |
| `packages/coding-agent` (pi-coding-agent) | The `pi` CLI: tools, sessions, extensions, modes | agent, ai, codemode, mcp, tui; `typebox`, `jiti` | bin `pi` → `dist/bundle/cli.js`; `cad/index.ts` (`main`, `createAgentSession`, tools, extension types), `./rpc-entry` |
| `packages/chord` | Object runtime (contracts, store, plugins, HTTP, workers) | schema, telemetry | many subpaths (`./http`, `./workers`, `./tui`...) |
| `packages/durable` (pi-durable) | Durable conversation/task runtime; own tool harness (`durable/src/harness/tool.ts`) | chord, ai, codemode, schema, telemetry | `.`, `./tools`, `./storage/*`, `./testing` |
| `packages/env` (pi-env) | SSH-deployed remote exec daemon + client | chord, durable | `.` |
| `packages/evals` (private) | vitest-evals harness driving the SDK with a real model | dev: ai, coding-agent | `src/cli.ts`, `src/harness.ts:runPiCodingAgent` |
| `apps/p2` (private) | Experimental web/TUI on Durable+Chord ("will be gone soon", `apps/p2/README.md`) | chord, durable, env, ai, codemode, mcp, schema, tui | `bun run start`; outside root `bun run check`/tests |

## 2. Agent loop and tool execution

**Trace (model `toolCall` → `toolResult`)**, `packages/agent/src/agent-loop.ts`:
1. `runLoop` (:172) collects `toolCall` blocks from the assistant message; `stopReason === "length"` → `failToolCallsFromTruncatedMessage` (:488, no hooks, no execution).
2. `executeToolCalls` (:518): sequential if `toolExecution === "sequential"` or any tool has `executionMode: "sequential"`, else parallel (default, `agent.ts` ctor). Parallel: every `prepareToolCall` runs **sequentially first** (:606-654), then executions run via `Promise.all` (:656); results are emitted in source order.
3. `prepareToolCall` (:718): unknown tool → error result; `prepareToolCallArguments` (:704, optional `tool.prepareArguments`); **`validateToolArguments` (:737)** → `packages/ai/src/utils/validation.ts:54` (pi-schema `compile(..., {coerce:true})`, WeakMap cache, `structuredClone` of args); then **`config.beforeToolCall` (:738)**: `block` or throw → error result (fail-closed).
4. `executePreparedToolCall` (:831) → `tool.execute(id, args, signal, onUpdate)` (:842); updates → `tool_execution_update`.
5. `finalizeExecutedToolCall` (:869) → `config.afterToolCall` (:880) may override content/details/isError/terminate.
6. Events: `tool_execution_start/update/end`, then `message_start/message_end` with `role:"toolResult"` (:940-959).

**Coding-agent wiring**: `cad/core/agent-session.ts:_installAgentToolHooks` (:688) sets `agent.beforeToolCall = _beforeToolCall` (:694 → `ExtensionRunner.emitToolCall`, `runner.ts:1256`: sequential, first `block` wins, exceptions propagate = fail-closed) and `afterToolCall = _afterToolCall` (:720 → `emitToolResult`, `runner.ts:1197`: exceptions swallowed = fail-open). Nested calls (`ctx.executeTool`, used by codemode) go `runner.ts:985` → `_executeNestedToolCall` (:766) → `NestedToolCallRunner` (`cad/core/nested-tool-calls.ts`) → `agent-loop.ts:runToolCall` (:821) with the same hooks plus `parentToolCallId`.

**Side-effect routes**

| Route | Path to execution | Through `_beforeToolCall`? |
|---|---|---|
| Built-in `bash` | `cad/core/tools/bash.ts` `ops.exec` → `spawn(shell)` | yes |
| Built-in `edit`/`write` | `tools/edit.ts`/`write.ts` `ops.writeFile` | yes |
| `read/grep/find/ls` | `tools/*.ts`; `find` spawns `fd` | yes |
| Extension `registerTool` tools | `cad/core/extensions/wrapper.ts:wrapRegisteredTool` | yes |
| MCP tools (built-in ext) | `cad/extensions/mcp/tools.ts` `client.callTool` | yes (server spawn/connection itself: no) |
| `codemode` tool + nested calls | `cad/extensions/codemode/execute.ts` → `ctx.executeTool` → `runToolCall` | yes (re-enters gate) |
| codemode `models.*` globals | `execute.ts` → `ctx.modelRegistry` | no (LLM network) |
| User `!`/`!!` (TUI) | `interactive-mode.ts:handleBashCommand` (:7132) → `emitUserBash` → `AgentSession.executeBash` (:3978) → `cad/core/bash-executor.ts` | **no** (only `user_bash` event) |
| RPC `bash` command | `cad/modes/rpc/rpc-mode.ts:582` → `emitUserBash` → `session.executeBash` | **no** |
| Extension event handlers / factory | arbitrary in-process JS (`runner.ts` emit loops) | **no** |
| Extension `pi.exec` | `loader.ts:423` → `cad/core/exec.ts:execCommand` (`spawn`, `shell:false`) | **no** |
| Extension `/commands` | `AgentSession.prompt` → `_tryExecuteExtensionCommand` (:2243) | **no** |
| Built-in slash commands | `cad/core/slash-commands.ts` (`/share`, `/bug` network; `/trust`, `/login`, `/export` file writes) | **no** |
| `!cmd` config values | `cad/core/resolve-config-value.ts:executeWithDefaultShell` (`execSync`) | **no** |
| Package install/update | `cad/core/package-manager.ts:install` (:1106) → npm/git | **no** |
| Startup network | version check, `report-install` fetch (`interactive-mode.ts:1475`), tools-manager downloads, remote catalog | **no** |
| SDK | `cad/core/sdk.ts:createAgentSession` (no `beforeToolCall` option; hooks only via extensions) | yes for model calls |
| Bare `Agent` (pi-agent-core) | `agent.ts` public `beforeToolCall` field | no session gate |
| Print/JSON/RPC prompts | all call `session.prompt` (`print-mode.ts:139`, `rpc-mode.ts:416`) | yes for model calls |
| Durable / p2 | `packages/durable/src/harness/tool.ts` (own loop), `apps/p2/src/runtime/tool-access.ts` | separate stack |

**P3 gate insertion point: `AgentSession._beforeToolCall` (`agent-session.ts:694`)**, as a built-in step before or after the extension `tool_call` chain. It covers every model-initiated call and nested calls, has `parentToolCallId`, and can reach `ctx.ui`. Constraints:
- The `runner.hasHandlers("tool_call")` early return (:699) must not skip the gate.
- Args are shared, not copied: handlers mutate `event.input` in place, which is the same object `execute` receives. Decide after the last mutation, or freeze/clone.
- Shell must also be gated at `AgentSession.executeBash` (:3978), the single chokepoint for TUI `!` and RPC `bash`. `pi.exec`, handler code, `!cmd` config and package installs stay outside any in-process gate. Those need P6 sandboxing or trust (`cad/core/trust-manager.ts`).
- `ask` UI per mode: TUI `ctx.ui.confirm/select`. RPC `extension_ui_request`/`extension_ui_response` (`rpc-types.ts:252-297`); it blocks forever without a timeout, so map timeout to deny. Print: `noOpUIContext` (`runner.ts:331`) returns `confirm→false`, so ask = deny.
- Parallel batches: an `ask` in prepare pauses the whole batch (all prepares finish before any execute).
- The existing trust (`cad/core/project-trust.ts:resolveProjectTrusted`, `<agentDir>/trust.json`) gates project resource loading only. No per-call approval exists today.

## 3. Extension lifecycle

- **Discovery** (`cad/core/resource-loader.ts:DefaultResourceLoader.reload`, ~:541): a bootstrap load of global and CLI extensions runs first, then project trust, then `packageManager.resolve()`, then `loadFinalExtensionSet`. Dirs: `<agentDir>/extensions`, and `<cwd>/.pi/extensions` only when trusted (`package-manager.ts` ~:2659-2693). Entries are `*.ts|*.js` or one subdir level (`package.json` `pi.extensions` or `index.ts`) (`loader.ts:discoverExtensionsInDir` :803). Other sources: the settings `extensions` array and `packages` (npm/git into `<agentDir>/npm|git` or `.pi/npm|git`), and CLI `-e/--extension` (accepts `builtin:<name>`), `-ne` and `--no-mcp` (`cad/cli/args.ts:186-191`). Built-ins: `cad/extensions/index.ts:builtInExtensions` (llama.cpp, plus replaceable codemode, tool-search and mcp).
- **Trust bypass**: the exported `loader.ts:discoverAndLoadExtensions` (:840) loads `.pi/extensions` without a trust check (SDK surface).
- **Loading**: `loader.ts:loadExtensionModule` (:571) uses jiti (`moduleCache:false`), in-process, unsandboxed. Virtual modules expose pi packages and `typebox` (`cad/core/extensions/virtual-modules.ts`). `ExtensionFactory = (pi: ExtensionAPI) => void|Promise<void>` (`types.ts:2094`). `initializeExtension` commits or discards. Provider/MCP registrations are queued until `ExtensionRunner.bindCore` (`runner.ts:417`). Extensions cannot be unloaded.
- **API** (`types.ts:1638-1967`, impl `loader.ts:279-540`): `on` (41 events), `registerTool` (only check: `parameters` is an object, :298), `registerCommand`, `registerShortcut`, `registerFlag`, renderers, `sendMessage`, `sendUserMessage`, `appendEntry`, `exec`, `get/setActiveTools`, `setModel`, `registerProvider`, `registerMcpServer`, `registerVirtualModel`, `events` bus.
- **Mutating events** (`types.ts:1426-1458`): `input` (transform/handled), `tool_call` (block, mutate input), `tool_result` (rewrite), `user_bash` (replace ops/result), `context`/`context_with_system` (messages), `before_provider_request` (payload), `before_provider_headers`, `before_agent_start` (inject message, override system prompt), `message_end`, `turn_end`/`agent_before_settle`, `session_before_{switch,fork,compact,tree}` (cancel), `project_trust`, `resources_discover`. The rest are observe-only.
- **Outside tools**: extensions get arbitrary fs/net/spawn, `ctx.ui` dialogs, replacement of built-in tools (same name, `agent-session.ts:_refreshToolRegistry`), system prompt and provider changes, and prompt and `!` interception.
- **Modes**: `AgentSession.bindExtensions` (:3388). The UI context is the TUI (`interactive-mode.ts:2093`), RPC (`extension_ui_request`; `custom()` is unsupported, `rpc-mode.ts:232`), or none for print/json.

## 4. Prompts and tool schemas

- **System prompt**: `cad/core/system-prompt.ts:buildSystemPromptSections` (:128) and `buildSystemPrompt` (:207), fed by `agent-session.ts:_rebuildSystemPrompt` (:1765) and `_preparePromptAndToolLoadout` (:1803). Section order: `preamble`, `tools` (only tools with a `promptSnippet`), `rules`, `docs`, `addendum`, `project_context`, `skills`, `cwd`, then custom. Each non-preamble section is wrapped in `<name>…</name>`. There is no date; cwd is the only environment field. `.pi/SYSTEM.md` (trusted) or `<agentDir>/SYSTEM.md` replaces the preamble; `APPEND_SYSTEM.md` becomes `addendum` (`resource-loader.ts:1245-1268`). Context files are the first of `AGENTS.override.md|AGENTS.md|AGENTS.MD|CLAUDE.md|CLAUDE.MD` per dir, walked from cwd to `/`, root-most first (`resource-loader.ts:213,260`); `-nc` disables them. The system prompt is a `role:"system"` message carrying `sections` and `toolsAdded`.
- **Schema library**: tool and config schemas in coding-agent use `typebox` 1.3.27 (23 files in `cad/`: 7 tool files `tools/{bash,edit,find,grep,ls,read,write}.ts`, `extensions/types.ts:ToolDefinition<TParams extends TSchema>` :600, `settings-schema.ts`, `model-config.ts`, keybindings, theme schema, codemode, tool-search, mcp). Other packages have no runtime TypeBox. ai, agent, durable, chord and p2 use pi-schema (38 files).
- **TS inference**: `type ReadToolInput = Static<typeof readSchema>` (pattern in each tool file), `packages/agent/src/types.ts:AgentToolParams<T> = Static<T>` (pi-schema `Static`), `packages/ai/src/types.ts:Tool<TParameters extends object>` (:779; `parameters` is plain JSON Schema).
- **Runtime validation**: only `packages/ai/src/utils/validation.ts:validateToolArguments`, called at `agent-loop.ts:737` and `durable/src/harness/tool.ts:396`. There is no AJV or TypeBox `Value` on runtime paths. `Type.Refine` is not enforced (ai CHANGELOG).
- **Provider emission**: `packages/ai/src/api/constrained-sampling.ts:getJsonSchemaToolParameters` (:163; strict → `makeStrictJsonSchema`, rejects `$ref/allOf/oneOf/...`). Adapters: `anthropic-messages.ts:convertTools` (:1885; non-strict keeps only `type/properties/required/$defs`), `openai-completions.ts:convertTools` (:1478), `openai-responses-shared.ts:convertResponsesTools` (:439), `google-shared.ts:convertTools` (:439, `rewriteConstAsEnum`), `bedrock-converse-stream.ts:convertToolConfig` (:1186), `mistral-conversations.ts:toFunctionTools` (:749, `stripSymbolKeys` drops TypeBox symbols).
- **Serialization**: `packages/ai/src/utils/transcript.ts:toToolDeclaration` (:123) JSON round-trips `{name, description, parameters, constrainedSampling}`. System messages carry `toolsAdded/toolsRemoved` deltas, which are persisted verbatim in session JSONL and in `CompactionEntry.systemMessage`. No schemas cross RPC (`rpc-types.ts`) [INFERENCE from absence]. MCP schemas are cast, not built: `cad/extensions/mcp/tools.ts:269` (`as unknown as TSchema`).
- **P1 touchpoints**: `ai/src/types.ts:779`, `ai/src/utils/validation.ts`, `agent/src/types.ts:466`, `cad/core/extensions/types.ts:600`, `loader.ts:300`, `virtual-modules.ts` (TypeBox is public extension API).

## 5. Read/edit contracts (`cad/core/tools/`)

| | read | edit | write |
|---|---|---|---|
| Params | `path`, `offset?` (1-based), `limit?` | `path`, `edits:[{oldText,newText}]`; `prepareEditArguments` also accepts a JSON string, a single object, or legacy top-level `oldText/newText` | `path`, `content` |
| Path resolution | `path-utils.ts:resolveReadPathAsync` → `resolveToCwd` → `utils/paths.ts:normalizePath` (unicode spaces, strips leading `@`, `~`, `file://`); fallbacks: macOS AM/PM U+202F, NFD, curly quote | `resolveToCwd` only | `resolveToCwd` only |
| Matching | n/a | Exact `indexOf` on LF-normalized text. If any edit misses, the whole base uses `normalizeForFuzzyMatch` (NFKC, trimEnd, smart quotes, dashes, spaces) and is overlaid with `applyReplacementsPreservingUnchangedLines`. Uniqueness is counted in fuzzy space even for exact hits. All edits match the original; overlap is an error; applied in reverse | n/a |
| Output | Raw text, **no line numbers**. `truncateHead` limit is 2000 lines / 50 KB (`truncate.ts:11`), with notices `[Showing lines A-B of N. Use offset=X to continue.]`. Images are sniffed, resized, and returned as an image block | `Successfully replaced N block(s) in <path>.`; details `{diff, patch, firstChangedLine}` (`edit-diff.ts:generateDiffString`, 4 context lines) | `Successfully wrote to <path>` |
| Failures | raw `access` errno; `Offset N is beyond end of file`; abort | `Could not find the exact text…`, `Found N occurrences…`, `edits[i] and edits[j] overlap`, `No changes made`, `oldText must not be empty`, `Could not edit file… Error code` | raw fs errors |
| Write path | none | BOM stripped and restored; first-newline EOL restored to all lines (lone `\r` → `\n`); utf-8 decode is lossy; `fs.writeFile` **in place, not atomic** | `mkdir -p` then `fs.writeFile`, not atomic, no overwrite check |
| Locking | none | `file-mutation-queue.ts:withFileMutationQueue` (in-process, realpath key) | same |
| Seams | `ReadOperations` | `EditOperations` | `WriteOperations` (used by ssh/gondolin examples) |

There is no "must read before edit" guard.

## 6. Session storage (`cad/core/session-manager.ts`)

- Location: `<agentDir>/sessions/--<cwd with / \ : → ->--/<timestamp>_<uuidv7>.jsonl` (`getDefaultSessionDirPath` :590; this encoding is not injective). Override with `--session-dir` or `PI_CODING_AGENT_SESSION_DIR` (`main.ts:749`).
- Format: JSONL. Line 1 is the header `{type:"session", version, id, timestamp, cwd, parentSession?}`. Entries are `{type, id (8 hex), parentId, timestamp}` forming a tree with a leaf pointer. Types: `message`, `thinking_level_change`, `model_change`, `usage`, `compaction`, `branch_summary`, `custom`, `custom_message`, `context_edit`, `label`, `session_info` (:183-194).
- Writes: the file is created lazily on the first user/assistant message (`openSync "wx"`), then `appendFileSync`. `_rewriteFile` (:1125) truncates and rewrites non-atomically (on migration).
- Versioning: `CURRENT_SESSION_VERSION = 3` (:41). `migrateToCurrentVersion` (:337) runs `migrateV1ToV2` (ids/parentIds) and `migrateV2ToV3` (`hookMessage` → `custom`). Later entry types are additive with no migration. Startup config migrations live separately in `cad/migrations.ts:runMigrations` (auth.json, commands → prompts, tools → bin, and others).

## 7. Config and branding

- `cad/config.ts` reads `packages/coding-agent/package.json` at load (:593). `APP_NAME = piConfig.name || "pi"` (:604), `APP_TITLE` (`"π"` if unnamed), `CONFIG_DIR_NAME = piConfig.configDir || ".pi"` (:606). `ENV_AGENT_DIR = ${APP_NAME.upper}_CODING_AGENT_DIR` and `ENV_SESSION_DIR` (:610-611). Today `piConfig` is `{configDir:".pi"}` only. The bin name is separate (`package.json` `bin.pi`), as are `scripts/build-binaries.sh` outputs (`pi`, `pi.exe`) and the nix wrapper.
- Paths: `getAgentDir()` (:630) = `$PI_CODING_AGENT_DIR` or `~/.pi/agent`, containing `settings.json`, `models.json`, `auth.json`, `trust.json`, `sessions/`, `bin/`, `prompts/`, `themes/`, `extensions/`, `skills/`, `npm/`, `git/`, `${APP_NAME}-debug.log`. `getPackageDir` honours `PI_PACKAGE_DIR`. AGENTS.md requires asset paths to go through `config.ts` helpers.
- Project-local `<cwd>/.pi/` (trust-gated, `trust-manager.ts:30-39`): `settings.json`, `extensions/`, `skills/`, `prompts/`, `themes/`, `SYSTEM.md`, `APPEND_SYSTEM.md`, `mcp.json`, `npm/`, `git/`. Ancestor `.agents/skills` is also gated. Settings are `deepMergeSettings(global, project)` with project winning and arrays replaced (`settings-manager.ts:143`). An untrusted project reads as `{}`. Writes go through `proper-lockfile`.
- Hardcoded `PI_*` env vars (not derived from `APP_NAME`): `PI_OFFLINE`, `PI_SKIP_VERSION_CHECK`, `PI_TIMING`, `PI_STARTUP_BENCHMARK`, `PI_TELEMETRY`, `PI_EXPERIMENTAL`, `PI_PACKAGE_DIR`, `PI_SELF_UPDATE_COMMAND`, `PI_SHARE_VIEWER_URL`, `PI_MANAGED_INSTALL_ROOT`, `PI_INSTALLER_API_BASE`, `PI_CODEMODE_MAX_WORKERS`, `PI_RADIUS_GATEWAY`, `PI_CLIPBOARD_OSC52`, `PI_CLEAR_ON_SHRINK`, `PI_HARDWARE_CURSOR`, `PI_NO_LOCAL_LLM`. Markers `PI_CODING_AGENT` and `AI_AGENT` are set for children (`cad/cli/setup.ts`). `scripts/profile-coding-agent-node.mjs:16` and `packages/evals/src/harness.ts:83` hardcode `PI_CODING_AGENT_DIR`.
- Hardcoded brand and endpoints: preamble "running inside pi" (`system-prompt.ts:156`), `pi.dev` for version check (`utils/version-check.ts:5`), install report, share viewer, installer API, remote catalog, MCP OAuth client metadata, theme `$schema`. Package scope `@earendil-works/*`.

## 8. Tests and platforms

- Runners: vitest for ai, agent, coding-agent, schema, mcp, durable (+`test:store`/`test:workers`), chord, evals. `node --test` for tui and apps/p2. Root `bun run test` = `test:scripts` + workspaces. `vitest.base.ts` aliases `@earendil-works/*` to `src/`, except Chord/Durable process/esbuild tests that need `dist/` (AGENTS.md).
- `./test.sh`: `env -i` with an allowlist and a temp HOME/TMP/XDG/npm cache, `LANG=C TZ=UTC`, git neutered, `PI_NO_LOCAL_LLM=1`, no API keys, then `bun run test`. Covers `packages/*` only.
- E2E gating: `describe.skipIf(!process.env.<KEY>)` / credential helpers (`ai/test/azure-utils.ts`). Local LLM tests are skipped by `PI_NO_LOCAL_LLM`. coding-agent vitest sets `PI_OFFLINE=1` (`vitest.config.ts`).
- Faux provider: `packages/ai/src/providers/faux.ts:fauxProvider` (keyless, provider `faux`, model `faux-1`, scripted `setResponses` of messages or factories, chars/4 usage, optional `tokensPerSecond`). Suite harness: `packages/coding-agent/test/suite/harness.ts:createHarness` returns a real `AgentSession` + faux + in-memory settings + `events`.
- Platforms: `engines.node >=22.19.0` everywhere; CI uses Node 22. Shells: `cad/utils/shell.ts:getShellConfig` (Git Bash on Windows, legacy WSL bash rejected; `/bin/bash` → `bash` → `sh`), PowerShell tool. Standalone: `build:binary` = `bun build --compile` (`scripts/build-binaries.sh`: darwin/linux/windows × x64/arm64). Node bundle: `scripts/build-coding-agent-bundle.mjs` (esbuild → `dist/bundle/cli.js`). Nix: `flake.nix`, `nix/package.nix`.

## 9. Baseline measurement hooks (no paid APIs)

Setup, once: `bun install --ignore-scripts && bun run hydrate:model-data`. The gitignored `packages/ai/src/providers/data/` is required even when running from source. Use a keyless faux provider through an extension (no CLI flag exists). The extension is a file outside the repo, e.g. `/tmp/faux-ext.ts`:

```ts
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function (pi: ExtensionAPI) {
	const faux = fauxProvider();
	faux.setResponses(Array.from({ length: 1000 }, () => () => fauxAssistantMessage("ok")));
	pi.registerProvider(faux.provider);
}
```

Isolated, deterministic environment: `export HOME=$T/home PI_CODING_AGENT_DIR=$T/agent` and an empty cwd. Without the HOME override, `~/.agents/skills` added a 57 KB `skills` section in our run. Common flags: `F="--offline --no-session -ne -e /tmp/faux-ext.ts --model faux/faux-1"`. `./pi-test.sh --no-env` runs from source via `cad/experimental/source-resolver.ts`; use `bun packages/coding-agent/dist/bundle/cli.js` after `bun run build` for shipped startup.

| Metric | Command | Measured 2026-11-06 (source, Node 24.22.1, Linux x64) |
|---|---|---|
| Cold startup breakdown | `PI_TIMING=1 ./pi-test.sh --no-env $F -p hi` (prints "Startup Timings", `cad/core/timings.ts`) | main TOTAL 207 ms (`createAgentSessionRuntime` 202 ms); faux ext import 136 ms; wall ≈1.06 s |
| Startup harness | `bun run profile:rpc -- --runs 10 --warmup 2 --isolated-agent-dir [--bundle]` (`scripts/profile-coding-agent-node.mjs`, time to first `get_state` response) | not run (builds first) |
| Peak RSS | `/usr/bin/time -f %M ./pi-test.sh --no-env $F --mode json hi` | 178.7 MB (wrapper + node) |
| Prompt + schema size | `--mode json` stream: the `message_end` event with `role:"system"` has `sections` and `toolsAdded` | sections: preamble 126 B, tools 274, rules 589, docs 1194, cwd 41 = 2228 B (≈557 tok); `toolsAdded` read/bash/edit/write = 2969 B JSON |
| Per-turn harness latency | RPC loop: write `{"type":"prompt","message":"…"}` lines to `--mode rpc` stdin and time until each `agent_end` event | 30 turns: p50 1.0 ms, p90 1.4 ms (first turn 771 ms includes startup) |

- There is no tokenizer dependency. The estimate is `ceil(chars/4)` (`cad/core/compaction/compaction.ts:estimateTokens`, `ai/src/utils/estimate.ts`), so exact counts need provider-reported usage or an added tokenizer. The schema bytes above are pre-adapter. Per-provider wire size requires calling `getJsonSchemaToolParameters` and the adapter `convertTools` in-process, or capturing payloads via `before_provider_request`.
- In-process alternative: `createHarness` + `session.systemPrompt` (`agent-session.ts:1530`) or `buildSystemPromptSections`.
- A real-model baseline additionally needs provider credentials (`auth.json` or env key) and a pinned model id, network access (drop `--offline`), multiple runs to absorb provider latency variance, provider `usage` for true token counts and cache behaviour, and the evals harness (`bun run eval` with `PI_PROVIDER`/`PI_MODEL`, `packages/evals/src/harness.ts:resolveModelSelection`) for task-level scores.
