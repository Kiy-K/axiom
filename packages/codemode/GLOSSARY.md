# Glossary: pi-codemode

Context: `packages/codemode` (`@earendil-works/pi-codemode`). Source: its README. Map: [../../GLOSSARY-MAP.md](../../GLOSSARY-MAP.md).

**Script**: model-written JavaScript run in a QuickJS VM. Its code is the body of an async function, so `return` and top-level `await` work.

**Sandbox**: runs scripts. Three kinds share one API and one result format: `CodemodeSandbox` (a worker thread on Node or Bun), `RemoteCodemodeSandbox` (a Durable Object on Cloudflare) and `InlineCodemodeSandbox` (the calling thread).

**Tool (script side)**: a host function a script calls as `tools.<name>(args)`. Invalid identifier characters become `_`, so `my-tool` is also `tools.my_tool`. Nested tool calls never enter the model's context.

**Global**: a host function callable from a script, such as `image(ref)`. It is not recorded in `result.calls`.

**Output items**: `text(value)` and `image(...)` append to `result.output`. Only this output and the return value go back to the model.

**Store**: JSON values a script keeps across executions with `store` and `load`. The sandbox persists nothing itself; the host passes the store in and applies `result.storeWrites`.

**Options line**: an optional first line `// @options: {...}` with `max_output_tokens` and `timeout_ms`. The sandbox ignores it; the caller acts on it.

**Declarations**: TypeScript declarations rendered from tool schemas (`renderDeclarations`) for the model to read.

**Interrupt budget**: on Cloudflare, the number of interrupt polls a script may use while computing without calling a tool. Past it, the result is `kind: "timeout"`.

**CodemodeResult**: `ok`, plus `value`, `output`, `calls` and `storeWrites` on success, or `error` with a `kind` and `message` on failure.
