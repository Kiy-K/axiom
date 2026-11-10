# Glossary: Axiom coding agent

Context: `packages/coding-agent`. Source: its README and `docs/`. Map: [../../GLOSSARY-MAP.md](../../GLOSSARY-MAP.md).

**Axiom**: this fork of Pi, run as the `axiom` command. Self-update is disabled.

**Pi**: the upstream agent harness this fork is based on. `PI_*` environment variables and the `pi` extension API are unchanged.

**Agent directory**: `~/.axiom/agent`, where settings and credentials live. `AXIOM_CODING_AGENT_DIR` overrides it. On first start Axiom copies `~/.pi/agent` here and never changes the Pi directory.

**Project directory**: `.axiom/` inside a project. Axiom does not read `.pi/`.

**Trusted project**: a project directory the user has approved. Trust is asked again after an import from Pi.

**Extension**: code that adds to Axiom through the Pi extension API. See `docs/extensions.md`.

**Skill**: instructions the agent loads on demand. See `docs/skills.md`.

**Prompt template** and **theme**: user-defined prompt text and display styling. See `docs/prompt-templates.md` and `docs/themes.md`.

**Modes**: interactive (`docs/usage.md`), print or JSON (`docs/cli.md`), RPC (`docs/rpc.md`) and the TypeScript SDK (`docs/sdk.md`).

**Codemode tool**: the built-in `codemode` tool, which runs model-written scripts through `@earendil-works/pi-codemode`.
