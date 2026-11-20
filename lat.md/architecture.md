# Architecture

This section is a focused map of how the CLI stack is assembled and where its important seams sit. It describes structure and intent; line-level citations live in [[docs/axiom/architecture.md]].

## Package boundaries

Each workspace package owns one layer; dependency direction runs from the product downward.

| Package (npm name) | Role | Notable source anchors |
| --- | --- | --- |
| `packages/telemetry` (`pi-telemetry`) | Vendor-neutral telemetry contracts and store | [[packages/telemetry/src/noop.ts#NOOP_TELEMETRY_CONTEXT]] |
| `packages/schema` (`pi-schema`) | JSON Schema builders and validators compiled to closures | [[packages/schema/src/validator.ts#compile]] |
| `packages/ai` (`pi-ai`) | Multi-provider LLM API, model catalog, validation, faux provider | [[packages/ai/src/models.ts#createModels]], [[packages/ai/src/providers/faux.ts#fauxProvider]] |
| `packages/agent` (`pi-agent-core`) | Generic agent loop and state | [[packages/agent/src/agent.ts#Agent]], [[packages/agent/src/agent-loop.ts#agentLoop]] |
| `packages/tui` (`pi-tui`) | Differential-render terminal UI | [[packages/tui/src/tui-alt-screen.ts#TuiAltScreen]] |
| `packages/codemode` (`pi-codemode`) | QuickJS-WASM sandbox whose only capability is injected tools | [[packages/codemode/src/runtime/host.ts#CodemodeSandbox]] |
| `packages/mcp` (`pi-mcp`) | MCP client with stdio/HTTP transports and OAuth | [[packages/mcp/src/client.ts#McpClient]] |
| `packages/coding-agent` (`pi-coding-agent`) | The `axiom` CLI: tools, sessions, extensions, modes | [[packages/coding-agent/src/core/agent-session.ts#AgentSession]] |
| `packages/chord` (`@earendil-works/chord`) | Object runtime: contracts, store, plugins, links | [[packages/chord/src/host/host.ts#createHost]], [[packages/chord/src/store/store.ts#openStore]] |
| `packages/durable` (`pi-durable`) | Durable conversation/task runtime with its own harness | [[packages/durable/src/harness/harness.ts#Harness]] |
| `packages/env` (`pi-env`) | SSH-deployed remote exec daemon and client | [[packages/env/GLOSSARY.md]] |
| `packages/evals` (private), `apps/p2` (private) | Evaluation harness and an experimental Durable web/TUI app | [[packages/evals/GLOSSARY.md]], [[apps/p2/GLOSSARY.md]] |

## Agent loop and tool execution

The generic loop turns a model's tool calls into results through a fixed sequence of prepare, hook, execute and finalize steps.

`[[packages/agent/src/agent-loop.ts#agentLoop]]` collects tool-call blocks; a truncated response fails its calls without execution. Execution is parallel by default, sequential if configured or requested per tool. Every call is prepared (validation via [[packages/ai/src/utils/validation.ts#validateToolArguments]], then `beforeToolCall`) before any runs. [[packages/agent/src/agent-loop.ts#runToolCall]] is the single-call path reused by nested calls such as codemode.

The CLI installs its gate on [[packages/coding-agent/src/core/agent-session.ts#AgentSession]]: extension `tool_call` handlers are fail-closed (first block wins, exceptions propagate), while `tool_result` handlers are fail-open. Not every side-effect route crosses that gate: user `!` commands, RPC `bash`, extension `pi.exec`, slash commands and package installs run outside it. See [[decisions#Central permission gateway]] and [[docs/axiom/architecture.md]] section 2 for the full route inventory.

## Extension lifecycle

Extensions are in-process, unsandboxed modules discovered from the agent directory, trusted project directories, settings and CLI flags.

Discovery is owned by [[packages/coding-agent/src/core/extensions/loader.ts#discoverAndLoadExtensions]]; project `.axiom/extensions` is read only for trusted projects. Loading uses jiti in-process and cannot be unloaded. Extensions register tools, commands, providers, MCP servers and event handlers through the `pi` API ([[packages/coding-agent/docs/extensions.md]]). Mutating events can block a tool call, rewrite a result, replace user bash or alter the prompt; the rest are observe-only. Only built-in and explicitly allowlisted extensions load in sandbox mode, as decided in [[decisions#Sandboxed execution]].

## Prompts and tool schemas

The system prompt is assembled from ordered sections and carried as a role `system` message with tool deltas.

[[packages/coding-agent/src/core/system-prompt.ts#buildSystemPromptSections]] orders sections as preamble, tools, rules, docs, addendum, project context, skills, cwd and custom. `SYSTEM.md` replaces the preamble and `APPEND_SYSTEM.md` becomes the addendum. There is no date; cwd is the only environment field.

Coding-agent tool and config schemas use TypeBox, which is also public extension API. Runtime validation instead uses pi-schema compiled validators through [[packages/ai/src/utils/validation.ts#validateToolArguments]]. Provider payloads are derived by [[packages/ai/src/api/constrained-sampling.ts#getJsonSchemaToolParameters]] and each API adapter. The split is deliberate: [[decisions#Schema strategy]].

## Read and edit contracts

The built-in read, edit and write tools share path resolution and mutate files in place, with hashline as an opt-in edit mode.

Read returns raw text (no line numbers) and truncates at 2000 lines / 50 KB. Edit matches exact text, then falls back to normalized fuzzy matching when any block misses, and serializes writes through an in-process mutation queue. Write creates parent directories. None of these operations is atomic and there is no "must read before edit" guard. Hashline mode adds tag-bound line IDs and a shown-line ledger; see [[decisions#Hashline edit mode]] and [[docs/axiom/hashline-contract.md]].

## Session storage

Sessions are JSONL trees under the agent directory, with a versioned header and a leaf pointer.

[[packages/coding-agent/src/core/session-manager.ts#CURRENT_SESSION_VERSION]] is 3. Entries in [[packages/coding-agent/src/core/session-manager.ts#SessionEntry]] form a tree by `id` and `parentId`; types include message, usage, compaction, branch summary, context edit and custom. The file is created lazily and appended to, so rewrites are non-atomic. Migration of entry shape is separate from startup config migration.

## Config and branding

A single `piConfig` block derives app names, directories and environment-variable prefixes.

[[packages/coding-agent/src/config.ts#getAgentDir]] resolves `AXIOM_CODING_AGENT_DIR` or `~/.axiom/agent`. [[packages/coding-agent/src/config.ts#IS_OFFICIAL_DISTRIBUTION]] distinguishes upstream Pi from forks and disables phone-home. Project-local `.axiom/` is trust-gated and merged over global settings. Most `PI_*` environment variables and the package scope `@earendil-works/*` are intentionally unchanged; see [[decisions#Rebrand without breaking Pi compatibility]].

## Tests and platforms

Non-e2e testing is centralized in `./test.sh`; the faux provider makes the harness deterministic without keys.

Vitest covers ai, agent, coding-agent, schema, mcp, durable, chord and evals; `node --test` covers tui and p2. [[packages/coding-agent/test/suite/harness.ts]] builds a real `AgentSession` with a fake model and in-memory settings. E2E suites skip without credentials. Node 26 is required; `apps/p2` runs its own check and test commands outside the root scripts. [[docs/axiom/toolchain.md]] records measured verification and known failures.
