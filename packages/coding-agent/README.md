# Axiom coding agent

> Docs under docs/ say `pi`, `~/.pi/agent`, `.pi/`; in Axiom read `axiom`, `~/.axiom/agent`, `.axiom/`. `PI_*` env vars and the `pi` extension API are unchanged. Self-update is disabled: `axiom update` and `axiom update --self` exit 1, and the `pi update` text in docs/ does not apply.

Axiom is a fork of [Pi](https://github.com/earendil-works/pi) (MIT; see [LICENSE](LICENSE)), a minimal, extensible agent harness. Customize it with [extensions](docs/extensions.md), [skills](docs/skills.md), [prompt templates](docs/prompt-templates.md), and [themes](docs/themes.md). Use it [interactively](docs/usage.md), in [print or JSON mode](docs/cli.md), over [RPC](docs/rpc.md), or through the [TypeScript SDK](docs/sdk.md). Report issues at https://github.com/Kiy-K/axiom/issues.

## Getting started

Install from source with [Bun](https://bun.sh) (tested with 1.4.4; Node.js 22.19 or newer must also be on `PATH` because the build scripts call `node`):

```bash
git clone https://github.com/Kiy-K/axiom
cd axiom
bun install --ignore-scripts
bun run build
alias axiom="bun $PWD/packages/coding-agent/dist/bundle/cli.js"
```

Start Axiom in the directory where you want it to work, then run `/login` to connect a subscription or API key.

## Coming from Pi

On its first start Axiom copies `~/.pi/agent` into `~/.axiom/agent` and never changes the Pi directory. OAuth logins are not imported (run `axiom auth login <provider>`; API keys are imported), trusted projects are asked again, and MCP sign-ins and crash records are left behind. The import is skipped when `AXIOM_CODING_AGENT_DIR` or `PI_CODING_AGENT_DIR` is set. Project `.pi/` directories are not read; rename them to `.axiom/`.

## Share your OSS coding agent sessions

If you use Pi for open source work, please share your coding agent sessions.

Public OSS session data helps improve models, prompts, tools, and evaluations using real development workflows.

For the full explanation, see [this post on X](https://x.com/badlogicgames/status/2037811643774652911).

To publish sessions, use [`badlogic/pi-share-hf`](https://github.com/badlogic/pi-share-hf) using a Hugging Face account and the Hugging Face CLI.

- [Demo video](https://x.com/badlogicgames/status/2041151967695634619) on how to publish Pi sessions
- Published Pi development sessions: [`badlogicgames/pi-mono` on Hugging Face](https://huggingface.co/datasets/badlogicgames/pi-mono).

## Development

Clone the repository, install its dependencies, and run Pi from source:

```bash
git clone https://github.com/earendil-works/pi
cd pi
bun install --ignore-scripts
./pi-test.sh
```

`pi-test.sh` can be called from any directory and preserves the caller's working directory.

Before submitting changes, run:

```bash
bun run check
./test.sh
```

Read [CONTRIBUTING.md](https://github.com/earendil-works/pi/blob/main/CONTRIBUTING.md) before opening an issue or pull request. It defines the contribution gate, issue quality bar, and required checks. Read [AGENTS.md](https://github.com/earendil-works/pi/blob/main/AGENTS.md) for repository-specific implementation, testing, dependency, and release rules.

## License

MIT
