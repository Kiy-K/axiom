# Glossary map

Axiom is split into 13 contexts: 12 workspace packages under `packages/` and one app under `apps/`. Each context has its own `GLOSSARY.md` next to its code. Read the glossary of each context your change touches. Look here first when a word means different things in different packages.

| Context | Package | Glossary | Covers |
| --- | --- | --- | --- |
| agent | `@earendil-works/pi-agent-core` | `packages/agent/GLOSSARY.md` | stateful agent loop, events, queues, hooks |
| ai | `@earendil-works/pi-ai` | `packages/ai/GLOSSARY.md` | providers, models, auth, usage and cost |
| chord | `@earendil-works/chord` | `packages/chord/GLOSSARY.md` | objects, hosts, facets, references, documents, reloads |
| codemode | `@earendil-works/pi-codemode` | `packages/codemode/GLOSSARY.md` | sandboxed model-written scripts |
| coding-agent | `@earendil-works/pi-coding-agent` | `packages/coding-agent/GLOSSARY.md` | Axiom CLI, its directories and extension points |
| durable | `@earendil-works/pi-durable` | `packages/durable/GLOSSARY.md` | harness, conversations, entries, tasks, submissions |
| env | `@earendil-works/pi-env` | `packages/env/GLOSSARY.md` | remote execution daemon, connections, terminals |
| evals | `@earendil-works/pi-evals` (private) | `packages/evals/GLOSSARY.md` | eval suites, variants, arms, lift |
| mcp | `@earendil-works/pi-mcp` | `packages/mcp/GLOSSARY.md` | MCP client, transports, OAuth, server config |
| schema | `@earendil-works/pi-schema` | `packages/schema/GLOSSARY.md` | JSON Schema builders, validation, coercion |
| telemetry | `@earendil-works/pi-telemetry` | `packages/telemetry/GLOSSARY.md` | spans, events, metrics, propagation, stored telemetry |
| tui | `@earendil-works/pi-tui` | `packages/tui/GLOSSARY.md` | terminal renderers, components, overlays, mouse |
| p2 | `p2` (private) | `apps/p2/GLOSSARY.md` | owners, guests, share links, TUI launcher, voice |

Package names come from each `package.json`. `evals` and `p2` are `private: true` and are not published. `p2` is also an experimental prototype.

## Words that mean different things

| Word | Meaning by context |
| --- | --- |
| Agent | agent: the `Agent` loop class. durable: the per-conversation configuration (model, extensions, tools) stored in `pi.agent`. coding-agent: the product itself. |
| Context | ai: the `Context` a model request carries (system prompt, messages, tools). chord and durable: the call value that carries cancellation and telemetry. telemetry: `TelemetryContext`, an adapter that starts root spans. Adapters never go inside a call context. |
| Provider | ai: the runtime unit that owns a model catalog, auth and streaming. p2: a model-provider login on the Providers screen, which uses pi-ai providers. |
| Store | chord: the persisted store (`openStore`). codemode: the JSON values a script keeps across executions. telemetry: `TelemetryStore`, the read side for recorded telemetry. |
| Extension | coding-agent and durable: a named bundle of tools, prompt sections and hooks. p2 uses "plugin" for its Chord plugins. |
| Tool | agent and ai: the model-facing tool definition and its call. codemode: a function a script calls as `tools.<name>`. mcp: a tool a remote MCP server exposes. |
| Message | agent: `AgentMessage`, which may be a custom type. ai: the LLM `Message`. durable: no messages; it stores entries. |

## Rules for these glossaries

- A term appears in the context that owns it. Other contexts refer to it by name and link here.
- The definitions come from each package's README. When code and glossary disagree, fix the glossary in the same change.
- Add a term when a change introduces a new name that a second context would need to understand. Do not add terms that appear only once in one file.
