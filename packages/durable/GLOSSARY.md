# Glossary: pi-durable

Context: `packages/durable` (`@earendil-works/pi-durable`). Source: its README. Experimental. Map: [../../GLOSSARY-MAP.md](../../GLOSSARY-MAP.md).

**Harness**: one open storage plus the machinery that runs agents on it. Every change goes through one line of atomic commits. Built with `Harness.open()`.

**Session**: what `Harness.open()` opens over a storage backend. A read-only session rejects every write with `ReadOnlySession`.

**Conversation**: a transcript of entries. `root()` creates the root conversation. A `Conversation` handle holds no state; compare handles by `id`.

**Entry**: one immutable transcript record: a user message (`pi.user`), a model response (`pi.assistant`), a tool result (`pi.tool-result`), a system prompt change (`pi.system`), a reset (`pi.reset`), or an app-defined kind. _Avoid_: "message" for an entry; the agent's `AgentMessage` is a different type.

**Commit**: an atomic write with `conversation.commit((tx) => ...)`. It can append entries, edit documents and create tasks together.

**Document**: typed JSON state stored beside the transcript and changed in commits. Built-in documents hold each conversation's agent (`pi.agent`), provider session identity (`pi.provider`), running work (`pi.live`), queued submissions (`pi.inbox`) and spend (`pi.usage`).

**Task**: a durable state machine that saves a checkpoint at each step. Every task has an owner: a conversation or another task. Built-in tasks are `pi.generation` (calls the model) and `pi.tool` (runs one tool call).

**Submission**: something handed to a conversation, either user input or an entry to write. It can be waited on, and `requestId` makes a retry return the same submission.

**Turn and run**: a turn is one model response and its tool calls. A run is every turn from one input to its final answer. A conversation is busy while a run goes on.

**Agent (durable)**: the configuration a conversation runs with: model, thinking level, selected extensions, tools, instructions and working directory. Stored as names in `pi.agent`. _Avoid_: confusing it with the `Agent` class in pi-agent-core.

**Extension**: a named bundle of tools, system prompt sections, hooks, wrappers and tasks, installed in a registry.

**Registry**: the extensions this process installed. It can change while the Harness runs; new work uses the new state.

**Sleep and wake**: a task that waits for time ends its phase asleep. The sleep is stored, survives restarts and resumes at its checkpoint.

**Interrupted run**: work cut off by a crash or eviction. A model request cut off this way counts as a failed attempt and is retried under `settings.retry`.
