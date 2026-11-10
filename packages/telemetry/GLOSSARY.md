# Glossary: pi-telemetry

Context: `packages/telemetry` (`@earendil-works/pi-telemetry`). Source: its README. Map: [../../GLOSSARY-MAP.md](../../GLOSSARY-MAP.md).

**TelemetryContext**: the adapter contract. It starts root spans and is held by the host. It is never placed inside a call context.

**TelemetrySpan**: the span a callback receives. It is the explicit parent for child spans. There is no public `end()`; the span closes when its callback's value or promise settles.

**Span**: a timed record of one operation. Spans nest into a tree.

**Attribute**: a named fact on a span or event, such as `provider: "openai"`.

**Event**: a named point in time inside a span, with no duration.

**Status**: `ok` or `error`. Normal completion is `ok`, and a throw is an error unless a status was set.

**Link**: a relation to another span that does not change the parent. Targets are contexts, including spans or remote parents.

**Carrier**: an opaque, JSON-safe string map that carries trace identity across a process boundary. `inject` makes one; `extract` turns one back into a parent. Carriers are diagnostics, never authorization.

**Metric**: a counter, an up-down counter or a histogram. Measurements carry low-cardinality attributes only. Exemplars link a histogram measurement to a span.

**No-op context**: `NOOP_TELEMETRY_CONTEXT`, for when telemetry is optional. It records nothing.

**TelemetryStore**: the read side for recorded telemetry: `findTraces`, `getTrace` and `findMetrics`. The in-memory adapter and the SQLite adapter in Chord implement it.
