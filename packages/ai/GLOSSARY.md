# Glossary: pi-ai

Context: `packages/ai` (`@earendil-works/pi-ai`). Source: its README. Map: [../../GLOSSARY-MAP.md](../../GLOSSARY-MAP.md).

**Provider**: the runtime unit that owns a model catalog, its auth, and its stream behavior. Registered on a `Models` collection. _Avoid_: calling a wire protocol a provider.

**Models collection**: holds providers and routes each request to the provider that owns the model. Built with `createModels()`, or `builtinModels()` for every built-in provider.

**API implementation**: the wire protocol a provider speaks, such as `anthropic-messages`, `openai-responses` or `openai-completions`. Many providers share one. Mixed providers (GitHub Copilot, OpenCode Zen) choose one per model.

**Model**: a catalog entry with an `id`, its `api`, `contextWindow`, input kinds and a `reasoning` flag.

**Context** (pi-ai): the conversation a model request carries: `systemPrompt`, `messages`, `tools`. It is serializable and can move to another model mid-session (cross-provider handoff). _Avoid_: confusing it with the Chord or Durable call context.

**Tool** (pi-ai): a `name`, `description` and JSON Schema `parameters` the model may call. Its result returns as a `toolResult` message.

**Thinking level**: how much reasoning a request asks for: `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`.

**Stop reason**: why an assistant response ended, such as a normal stop, `error` or `aborted`.

**Usage and cost**: `usage.cost.total` is the best available total. `usage.cost.totalFromProvider` is `true` when the provider reported the billed cost, `false` when it was estimated from catalog rates.

**Auth and credential store**: each provider resolves its credential (API key or OAuth token) from a credential store or environment variables.

**Client identity**: the headers that name the calling app to providers. The default names pi.

**Faux provider**: an in-memory test provider. It makes no network calls.
