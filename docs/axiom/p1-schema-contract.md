# P1: schema interoperability and ArkType spike

Roadmap issue [#1](https://github.com/Kiy-K/axiom/issues/1), phase P1. Repo citations are `file:symbol` or `file:line`. Measurements come from scratch probes in `/tmp/arkspike` (not committed); the numbers are what those probes printed.

**Status:** accepted 2026-11-07. Gate result: reject full ArkType migration. Independent validation agreed with the verdict; the reasons were corrected during validation (see Decision).

**Decision: reject full migration.** No runtime, dependency or API change in this phase. TypeBox stays the authoring library and pi-schema stays the validator.

## Problem

Axiom wants ArkType as a candidate tool-schema library without coupling the agent to it. Before any change, we need evidence on three questions: do ArkType schemas validate the same way, do they reach providers the same way, and what do they cost.

## Contract

**Boundary.** P1 adds no abstraction. Tools already cross the boundary as plain JSON Schema (`packages/ai/src/types.ts` `Tool.parameters`). The authoring type is still TypeBox: `ToolDefinition<TParams extends TSchema>` (`packages/coding-agent/src/core/extensions/types.ts:600`) and `registerTool` require TypeBox's `TSchema`. ArkType could enter only through `Type.Unsafe<T>(json)`, the pattern in `packages/coding-agent/src/core/pi-ai-schemas.ts:26`. No ArkType type appears in any public signature.

**Checks.**
- C1 drift: emitted JSON Schema vs TypeBox. Canonical form drops `$schema`, sorts keys, and compares `required` as a set.
- C2 validation parity: `compile(schema, {coerce: true, formats, unresolvedRefs: "reject"})`, the options `packages/ai/src/utils/validation.ts` uses.
- C3 wire parity: the real Anthropic `stream()` with `onPayload` throwing after capture (pattern from `packages/ai/test/anthropic-strict-tool-schema.test.ts`), strict and non-strict. Anthropic only.
- C4 unsupported keywords: what `toJsonSchema()` does with them.
- C7 cost: cold import and install footprint, on Node (the CLI runtime).

## P1.1 Inventory of schema consumers

| Consumer | Where | Library |
|---|---|---|
| Built-in tool parameters (7) | `packages/coding-agent/src/core/tools/{bash,read,write,edit,grep,find,ls}.ts` | TypeBox 1.3.27 |
| Other authoring (settings, model config, keybindings, codemode, MCP, theme) | 23 files under `packages/coding-agent/src` | TypeBox |
| Extension tool API | `core/extensions/types.ts:600`, `core/extensions/loader.ts:298` (checks only that `parameters` is an object), `core/extensions/virtual-modules.ts` (exposes `typebox`, `typebox/compile`, `typebox/value`) | TypeBox, public |
| Runtime argument validation | `packages/ai/src/utils/validation.ts:54`, called at `packages/agent/src/agent-loop.ts:737` and `packages/durable/src/harness/tool.ts:396` | pi-schema, coerce |
| Provider emission | `packages/ai/src/api/constrained-sampling.ts:163` and the per-provider adapters | JSON Schema |
| Serialization | `packages/ai/src/utils/transcript.ts:123` (JSON round-trip, which drops TypeBox symbol keys) | JSON |
| RPC and sessions | no schemas cross RPC (`rpc-types.ts`) | none |
| Other packages | pi-schema in ai, agent, durable, chord, p2 (38 files) | pi-schema |

## Measurements

**C1 drift, 7 built-in tools (canonical form).** Five are equal: `bash`, `read`, `grep`, `find`, `ls`. `write` and `edit` differ only in the order of `required`, which JSON Schema treats as a set.

**C2 parity.** Same accept/reject and same coerced value on 9 of 9 cases for `read` and `edit`. This is close to vacuous: pi-schema validates the emitted JSON, so identical JSON gives identical results. It shows ArkType's output is accepted by the validator, nothing more.

**C3 wire, Anthropic `input_schema`.** "Stripped" removes the top-level `$schema` from the ArkType side, which is what an adapter would need to do.

| Schema | Non-strict | Strict, raw | Strict, `$schema` stripped |
|---|---|---|---|
| `read` (optional fields) | equal | differs (`$schema`) | equal |
| nullable union | equal | differs (`$schema`) | equal |
| `Record<string, number>` | equal | equal | equal |
| integer with bounds | equal | equal | equal |
| `'a' \| 'b'` literal union | **differs**: ArkType `{enum:[…]}`, TypeBox `anyOf` of `const` | **differs** | **differs** |

Bounds is a non-strict case in both modes: `minimum` and `maximum` are in `ANTHROPIC_STRICT_UNSUPPORTED_KEYWORDS`, so the adapter falls back to non-strict and the "strict" row does not test strict mode.

**C4 unsupported keywords.** `toJsonSchema()` throws at definition time for `morph` (`string.integer.parse`), `.narrow()`, and a `string.url` predicate. A loud failure, not a silent drop.

**Recursive schemas are not byte-stable.** `scope({Node: …}).toJsonSchema()` names its `$defs` `intersection219` in one process and `intersection378` after 50 unrelated type builds in the same process. The names are deterministic for a fixed load order, so this only matters for recursive tool schemas. None of the 7 built-ins is recursive.

**Defaults.** `n: "number = 3"` emits `default: 3` and fills it on parse, matching TypeBox. `"n?": "number = 3"` is a type error.

**C7 cost.**

| Measure | TypeBox (in tree) | ArkType 2.2.9 | pi-schema (in tree) |
|---|---|---|---|
| Cold import, Node 24.22.1, median of 3–5 | 55 ms | **137 ms** | 45 ms (source via Node type stripping) |
| Cold import, Bun 1.4.4 | 31 ms | 165–177 ms | 4.5 ms |
| Define the 7 built-in tool schemas | not timed fairly | 0.17 ms median | n/a |
| Unpacked footprint | n/a | `arktype` 652 K, `@ark/schema` 684 K, `@ark/util` 268 K, `arkregex` 112 K (about 1.7 MB) | n/a |

The CLI's main-path startup is about 207 ms (`docs/axiom/architecture.md` section 8, measured 2026-11-06, Node 24.22.1). The 137 ms Node import would add about 66% to it, but only if ArkType became a runtime dependency. As a devDependency it adds nothing to startup.

## Decision

Reject full migration. Each reason below is weighted by the evidence behind it.

1. **No capability gain (decisive).** Validation and coercion are pi-schema's. The error text the model sees is pi-schema's, built from the emitted schema, so ArkType's messages never reach the model. ArkType's distinctive features, `morph` and `narrow`, do not emit to JSON Schema at all. What remains is authoring ergonomics, and TypeBox already gives type inference. Nothing in the agent needs ArkType.
2. **Cost if it became a runtime dependency.** Node cold import 137 ms vs 55 ms for TypeBox, and about 1.7 MB unpacked, for the same JSON Schema output.
3. **Wire differences (fixable, one unverified).** Strict mode leaks `$schema`, and a one-line strip at the Anthropic strict path removes it (`google-shared.ts:347` already strips it for Google). The enum shape change is real and unmeasured against a live provider: `[INFERENCE]` that it could change tool-call behavior. Recursive `$defs` names depend on process history, which blocks recursive tool schemas.

**Keep:** TypeBox as the authoring default, pi-schema as the validator, the existing payload path. No repo change was made, so nothing to revert.

**Not done, with reason:**
- The P1.3 internal boundary module. It only serves a migration that is rejected, so it would be speculative abstraction.
- Provider conformance beyond Anthropic. It would only matter if the decision flipped.

**Separate option, not P1.** The strongest case for change is decoupling extensions from TypeBox: `registerTool` accepts only `TSchema` (`extensions/types.ts:600`, `loader.ts:298`). Accepting a plain JSON Schema there needs no ArkType at all, and is a separate decision with its own contract.

## Limits

- `[INFERENCE]` that the enum shape or `$schema` would change provider behavior. Not verified against a live API; no paid calls.
- One machine: Linux x64, Node 24.22.1 for the cold-import numbers, Bun 1.4.4 for the secondary ones. The import times are in-process `import()` timings, not end-to-end CLI startup.

## What would reopen this

- A tool needs a constraint that ArkType can emit to JSON Schema and pi-schema cannot validate.
- ArkType loaded only on an opt-in path, and the provider check shows the enum shape is safe.
