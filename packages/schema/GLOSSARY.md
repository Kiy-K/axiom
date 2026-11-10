# Glossary: pi-schema

Context: `packages/schema` (`@earendil-works/pi-schema`). Source: its README. Map: [../../GLOSSARY-MAP.md](../../GLOSSARY-MAP.md).

**Schema**: a JSON Schema document. Drafts 2020-12 and 7 are supported.

**Builder**: a function such as `str()`, `obj()` or `opt()` that returns plain JSON Schema, typed with the values it accepts.

**Compiled validator**: the result of `compile(schema)`. It offers `check` (boolean, fast path), `errors` (JSON Pointer paths, built on first failure), `validate` (both) and, with `coerce: true`, `coerce` and `parse`.

**Static**: the TypeScript type a schema accepts, from `Static<typeof Schema>`.

**Coercion**: converting loosely typed input (for example a model's tool arguments) to the schema's types. Off unless `coerce: true` is passed.

**Optional null**: a `null` in an optional property whose schema rejects `null`. Coercion drops it, as if the property were omitted.

**Unresolved reference**: a `$ref` that names no definition. It throws on compile, or rejects values at its place with `unresolvedRefs: "reject"`.
