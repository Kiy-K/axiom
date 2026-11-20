# Axiom

Axiom is a fork of Pi: a minimal, extensible agent harness built as a Bun/TypeScript monorepo. This section records what the product is and where its two runtime stacks split.

Axiom keeps Pi's MIT license and the `pi` extension API, but brands itself as `axiom`, stores data in `~/.axiom/agent`, and reads project settings from `.axiom/`. The upstream vocabulary and the fork's choices are anchored in [[decisions#Rebrand without breaking Pi compatibility]] and [[domain#Contexts]].

## Two runtime stacks

The repository contains two independent execution stacks that share only low-level libraries.

| Stack | Packages | Entry point |
| --- | --- | --- |
| Pi/Axiom CLI | `@earendil-works/pi-coding-agent`, `pi-agent-core`, `pi-ai`, `pi-tui`, `pi-codemode`, `pi-mcp`, `pi-schema`, `pi-telemetry` | `axiom` CLI, built from `packages/coding-agent/dist/bundle/cli.js` |
| Durable | `@earendil-works/chord`, `pi-durable`, `pi-env` plus experimental `apps/p2` | A durable conversation/task runtime with its own harness and agent loop |

The CLI stack is the shipped product; the Durable stack is experimental and outside root checks and tests. See [[architecture#Package boundaries]] for per-package responsibilities.

## Repository layout

The root documentation is the map of the codebase; lat.md records the concepts and decisions those documents describe.

- [[README.md]] — install, development commands, supply-chain rules.
- [[GLOSSARY-MAP.md]] — index of the per-context glossaries.
- [[docs/axiom/architecture.md]] — line-level baseline map of the CLI stack (paths relative to root, `cad/` = `packages/coding-agent/src/`).
- [[docs/axiom/]] — contracts and design notes for the P0–P7 workstreams.
- [[packages/coding-agent/docs/]] — user-facing extension, skill, mode and containerization docs; prose still says `pi`, read it as `axiom`.

## Development commands

Bun drives development; npm remains only where a step needs npm itself.

`bun install --ignore-scripts`, `bun run build`, `bun run check`, `./test.sh` and `./pi-test.sh` are the core loop ([[README.md]]). Root `bun run test` and the full vitest suite are deliberately not used as the default; see [[architecture#Tests and platforms]]. The lockfile split and install-lock generation are decided in [[decisions#Toolchain and lockfiles]].
