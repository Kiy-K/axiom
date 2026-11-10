# Glossary: Chord

Context: `packages/chord` (`@earendil-works/chord`). Source: its README. The full rules are in `packages/chord/docs/design.md`. Map: [../../GLOSSARY-MAP.md](../../GLOSSARY-MAP.md).

**Object type (contract)**: a runtime value with a name, `params` that pick the instance, the host it lives on, its `members` (state and methods) and a `version`. Written with `@earendil-works/pi-schema` builders.

**Object**: one live instance of an object type, selected by its params (one greeter per language, for example).

**Host**: one running process (a server, a worker, a browser tab) that runs objects. Created with `createHost`.

**Facet**: a plugin's declarations for one host: the types it serves and its registry contributions. A facet factory only declares; Chord activates it.

**Reference**: a live handle to an object. It is never the object itself. It is hydrated once its `get` resolves, works the same locally and across links, and keeps the object alive until released.

**Document**: a named JSON value an object owns. Changed in transactions and persisted in the store.

**Derive**: a value computed from watchables.

**Job**: owned work that outlives the call that started it.

**Principal and principal key**: the identity on every call. Links stamp it; objects are kept per principal key.

**Link**: a transport between hosts, such as `memoryLinkPair`, `ipcLink` or `webSocketLink`.

**Reload**: swapping a plugin's code inside the running app, rolled out host by host. Hosts keep running; data and connections survive where they can.

**Watch (WatchHandle)**: the change feed for a value. The listener receives one call at a time, each carrying a value or a failure, and the ops that produced it.

**Context**: the value every call takes. It carries cancellation and the current telemetry span. `BACKGROUND_CONTEXT` never cancels.
