# Domain model

This section records the vocabulary the codebase uses and where a word changes meaning between packages. It is a map of owned concepts, not a copy of the glossaries.

The authoritative per-context definitions are linked below and indexed by [[GLOSSARY-MAP.md]]. When code and a glossary disagree, the glossary is fixed in the same change; when a concept has no owner, that is a signal to stop and name it before writing code ([[docs/agents/domain.md]]).

## Contexts

Axiom is split into 13 contexts: 12 workspace packages and one app, each with its own glossary.

| Context | Owns | Glossary |
| --- | --- | --- |
| agent | Stateful agent loop, events, queues, hooks | [[packages/agent/GLOSSARY.md]] |
| ai | Providers, models, auth, usage and cost | [[packages/ai/GLOSSARY.md]] |
| chord | Objects, hosts, facets, references, documents, reloads | [[packages/chord/GLOSSARY.md]] |
| codemode | Model-written scripts in a QuickJS sandbox | [[packages/codemode/GLOSSARY.md]] |
| coding-agent | The CLI, its directories and extension points | [[packages/coding-agent/GLOSSARY.md]] |
| durable | Harness, conversations, entries, tasks, submissions | [[packages/durable/GLOSSARY.md]] |
| env | Remote execution daemon, connections, terminals | [[packages/env/GLOSSARY.md]] |
| evals | Suites, variants, arms, pairs, lift | [[packages/evals/GLOSSARY.md]] |
| mcp | MCP client, transports, OAuth, server config | [[packages/mcp/GLOSSARY.md]] |
| schema | Schema builders, validation, coercion | [[packages/schema/GLOSSARY.md]] |
| telemetry | Spans, events, metrics, propagation, stored telemetry | [[packages/telemetry/GLOSSARY.md]] |
| tui | Renderers, components, overlays, mouse | [[packages/tui/GLOSSARY.md]] |
| p2 | Owners, guests, share links, TUI launcher, voice | [[apps/p2/GLOSSARY.md]] |

## Cross-context vocabulary

These words are overloaded; use the owning context's meaning or qualify them explicitly.

| Word | Meanings by context |
| --- | --- |
| Agent | agent: the `Agent` loop class. durable: the per-conversation configuration stored in `pi.agent`. coding-agent: the product itself. |
| Context | ai: the serializable model request input. chord/durable: the call value carrying cancellation and telemetry. telemetry: `TelemetryContext`, held by the host, never inside a call context. |
| Provider | ai: the runtime unit owning a model catalog, auth and streaming. p2: a model-provider login on the Providers screen. |
| Store | chord: the persisted store. codemode: JSON values kept across executions. telemetry: `TelemetryStore`, the read side of recorded telemetry. |
| Extension | coding-agent and durable: a named bundle of tools, prompt sections and hooks. p2 says "plugin" for its Chord plugins. |
| Tool | agent and ai: the model-facing definition and its call. codemode: a host function called as `tools.<name>`. mcp: a tool exposed by a remote server. |
| Message | agent: `AgentMessage`, possibly a custom type. ai: the LLM `Message`. durable: no messages, only entries. |

## Execution concepts

The concepts below are the ones that recur across the CLI stack and the Durable stack.

- **Agent loop** — [[packages/agent/src/agent.ts#Agent]] sends messages to a model, runs the tool calls it asks for and emits events. A **turn** is one model response plus its tool calls; a **run** is every turn from one input to its final answer (durable vocabulary).
- **Tool call** — one model-requested execution. It is prepared (argument validation and hooks), executed and finalized before its result returns as a `toolResult`. Hooks can block, rewrite or terminate it; see [[architecture#Agent loop and tool execution]].
- **Extension** — in-process code that registers tools, commands, providers, hooks and prompt sections. It is trusted host code, not a sandbox boundary ([[architecture#Extension lifecycle]]).
- **Session** — the coding-agent's JSONL transcript tree ([[architecture#Session storage]]). In durable, a `Harness.open()` session wraps a storage backend and can be read-only.
- **Entry and commit** — durable concepts: an entry is one immutable transcript record; a commit atomically appends entries, edits documents and creates tasks. Do not call an entry a message.
- **Object, host and reference** — Chord concepts: an object is a live instance of a contract selected by params, running on a host (process, worker or tab). A reference is a live handle, not the object itself.
- **Script and sandbox** — codemode concepts: a script is model-written JavaScript run in QuickJS; a sandbox runs it with only injected tools and globals, returning output, calls and store writes.
- **Provider and models** — [[packages/ai/src/models.ts#createModels]] holds providers and routes each request to the provider owning the model. An API implementation is the wire protocol; many providers share one.

## Security and trust vocabulary

These terms describe boundaries rather than features, and are used by the permission and sandbox contracts.

- **Trusted project** — a project directory the user approved; it gates project-local extensions, skills, settings and system prompt overrides. Importing from Pi does not carry trust over ([[decisions#Rebrand without breaking Pi compatibility]]).
- **Hard class** — an action in `auto` mode that always asks: externally visible or irreversible work such as `git push`, or edits to code-running files. See [[decisions#Central permission gateway]].
- **Taint** — a latch that records untrusted content entering a task. While tainted, grants are ignored and no automatic edit is made.
- **Sandbox state** — `starting`, `sandboxed` (enforced), `failed` or `unavailable`. If the VM cannot start, tool calls fail; there is no host fallback ([[decisions#Sandboxed execution]]).
- **Owner and guest** — p2 concepts: an owner has full control; a guest holds a share link with session-limited access. Proxy headers are never authentication.
