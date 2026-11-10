# Glossary: pi-mcp

Context: `packages/mcp` (`@earendil-works/pi-mcp`). Source: its README. Map: [../../GLOSSARY-MAP.md](../../GLOSSARY-MAP.md).

**Client (`McpClient`)**: owns request correlation, initialization, timeouts, cancellation and server requests. It does not own I/O.

**Transport**: owns framing and I/O, and delivers single JSON-RPC messages to the client. Kinds: `StdioTransport` (starts a program), `StreamableHttpTransport` (remote server), `PipeTransport` (a program started elsewhere, reached through a pipe) and an in-memory transport for tests.

**Pipe (`McpPipe`)**: the handle a `PipeTransport` gets from its `open` function: `write`, `closeStdin`, `close` and `exited`.

**Roots**: the file URIs the client reports when the server calls `roots/list`.

**Tool result content (`toLlmContent`)**: converts an MCP `CallToolResult` into the text and image content a model reads. Audio and binary resources become short text placeholders.

**Server entry**: one `mcpServers` config entry, validated by `validateMcpServerConfig` as `stdio` or `http`. An **override entry** has no `command`, `url` or `type` and only changes fields of a server defined in another file.

**Tool name (`createMcpToolName`)**: the model-facing name `mcp__<server>__<tool>`, limited to the characters and length providers accept.

**Sign-in**: the OAuth flow for a remote server. `startMcpSignIn` and `completeMcpSignIn` split it across two requests. A missing or expired grant raises `McpOAuthAuthorizationRequiredError`.
