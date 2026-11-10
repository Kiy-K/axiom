# Glossary: pi-agent-core

Context: `packages/agent` (`@earendil-works/pi-agent-core`). Source: its README. Map: [../../GLOSSARY-MAP.md](../../GLOSSARY-MAP.md).

**Agent**: a stateful loop that sends messages to a model, runs the tool calls the model asks for, and emits events. Built with `new Agent({...})`.

**AgentMessage**: any message the agent holds: LLM messages (`user`, `assistant`, `toolResult`) plus app-defined custom types. Only LLM messages reach the model. _Avoid_: "message" alone when an LLM message is meant.

**convertToLlm**: the hook that turns `AgentMessage[]` into the model's `Message[]` before each request. Required when custom message types exist.

**transformContext**: optional hook that prunes or injects context before `convertToLlm`.

**prepareRequest**: hook that runs before every provider request, including the first. It installs the canonical persisted context. It does not poll the queues.

**finishTurn**: hook that runs after the assistant message and all tool results are final, before `turn_end`. Returns `{ action: "continue" }` to force one more request, `{ action: "end" }` to stop after `turn_end`, or `undefined` for normal scheduling.

**Turn**: one model response and the tool calls it made. Bounded by `turn_start` and `turn_end`.

**Steering queue**: input queued while the agent runs, polled between turns. **Follow-up queue**: input polled once the response stops on its own. Each queue has mode `one-at-a-time` or `all`.

**beforeToolCall / afterToolCall**: hooks around one tool execution. `beforeToolCall` can block a call; `afterToolCall` can change its result.

**terminate**: a flag on a tool result or hook decision. When every result in a batch sets it, the automatic follow-up request is skipped.

**Tool execution mode**: `parallel` (default) or `sequential`, set globally or per tool with `executionMode`. One sequential tool makes its whole batch sequential.
