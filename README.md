# Axiom

Axiom is a fork of [Pi](https://github.com/earendil-works/pi), a minimal, extensible agent harness. It keeps Pi's MIT license and copyright notice (see [LICENSE](LICENSE)). Report Axiom issues at https://github.com/Kiy-K/axiom/issues.

Customize Axiom with [extensions](packages/coding-agent/docs/extensions.md), [skills](packages/coding-agent/docs/skills.md), [prompt templates](packages/coding-agent/docs/prompt-templates.md), and [themes](packages/coding-agent/docs/themes.md), and bundle them as [packages](packages/coding-agent/docs/packages.md). Use it [interactively](packages/coding-agent/docs/usage.md), in [print or JSON mode](packages/coding-agent/docs/cli.md), over [RPC](packages/coding-agent/docs/rpc.md), or through the [TypeScript SDK](packages/coding-agent/docs/sdk.md).

The docs under `packages/coding-agent/docs/` still say `pi`, `~/.pi/agent`, and `.pi/`. In Axiom read them as `axiom`, `~/.axiom/agent`, and `.axiom/`. The `PI_*` environment variables (except the agent and session dir) and the `pi` extension API are unchanged.

## Getting started

Axiom has no release archives or npm package yet; install it from source. It runs on [Bun](https://bun.sh) (tested with 1.4.4). The repository's build and check scripts still call `node` internally, so Node.js 22.19 or newer must also be on `PATH` to build.

```bash
git clone https://github.com/Kiy-K/axiom
cd axiom
bun install --ignore-scripts
bun run build
alias axiom="bun $PWD/packages/coding-agent/dist/bundle/cli.js"
```

Start Axiom in the directory where you want it to work, then run `/login` to connect a subscription or API key:

```bash
cd /path/to/project
axiom
```

With Nix, `nix build .` or `nix run .` builds or runs your checkout (`bin/axiom`).

## Coming from Pi

Axiom keeps its data in `~/.axiom/agent` (override with `AXIOM_CODING_AGENT_DIR`) and reads project settings from `.axiom/`. On its first start, Axiom copies `~/.pi/agent` into `~/.axiom/agent` and never changes the Pi directory. Not imported:

- OAuth logins (subscriptions), so Pi and Axiom never share a refresh token; run `axiom auth login <provider>`. API keys are imported.
- Trusted projects; Axiom asks again. Explicit "do not trust" decisions are kept.
- MCP sign-ins and crash records.

The import is skipped when `AXIOM_CODING_AGENT_DIR` or `PI_CODING_AGENT_DIR` is set; copy the directory yourself in that case. Project `.pi/` directories are not read; rename them to `.axiom/`. Axiom does not check pi.dev for updates, send install telemetry, self-update, or upload `/bug` reports.

## Packages

This monorepo contains the Pi CLI and its supporting libraries.

| Package | Description |
|---------|-------------|
| **[@earendil-works/chord](packages/chord)** | Object runtime for apps across processes: contracts, documents, a store, links, plugins with hot reload, HTTP, workers, web and terminal clients |
| **[@earendil-works/pi-telemetry](packages/telemetry)** | Vendor-neutral telemetry contracts, reference adapter, conformance tests, and typed schemas |
| **[@earendil-works/pi-ai](packages/ai)** | Unified multi-provider LLM API (OpenAI, Anthropic, Google, etc.) |
| **[@earendil-works/pi-durable](packages/durable)** | Durable conversation, task, and document runtime |
| **[@earendil-works/pi-agent-core](packages/agent)** | Agent runtime with tool calling and state management |
| **[@earendil-works/pi-coding-agent](packages/coding-agent)** | Interactive coding agent CLI |
| **[@earendil-works/pi-tui](packages/tui)** | Terminal UI library with differential rendering |

For Slack/chat automation and workflows see [earendil-works/pi-chat](https://github.com/earendil-works/pi-chat).

## Permissions & Containerization

Pi does not include a built-in permission system for restricting filesystem, process, network, or credential access. By default, it runs with the permissions of the user and process that launched it.

If you need stronger boundaries, containerize or sandbox Pi. See [packages/coding-agent/docs/containerization.md](packages/coding-agent/docs/containerization.md) for three patterns:

- **Gondolin extension**: keep `pi` and provider auth on the host while routing built-in tools and `!` commands into a local Linux micro-VM.
- **Plain Docker**: run the whole `pi` process in a local container for simple isolation.
- **OpenShell**: run the whole `pi` process in a policy-controlled sandbox.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and [AGENTS.md](AGENTS.md) for project-specific rules (for both humans and agents).  Longer term plans for Pi can also be found in [RFCs](https://rfc.earendil.com/keyword/pi).

## Development

```bash
bun install --ignore-scripts  # Install all dependencies without running lifecycle scripts
bun run build         # Refresh model data, then build all packages
bun run build:offline # Rebuild using existing model data without network access
bun run check         # Lint, format, and type check
./test.sh            # Run tests (skips LLM-dependent tests without API keys)
./pi-test.sh         # Run pi from sources (can be run from any directory)
```

### Using local packages outside the monorepo

Build every public package into one coherent local artifact set:

```bash
bun run pack:packages -- --out .artifacts/pi-packages
```

This refreshes model data before building `pi-ai`. To avoid network access when
model data is already hydrated, pass `--offline-model-data`.

Then configure an external project to consume one package and resolve all of
its Pi dependencies from the same artifact set. npm is the default:

```bash
bun scripts/use-local-packages.mjs \
  --manifest .artifacts/pi-packages/manifest.json \
  --consumer ../my-project \
  --package @earendil-works/pi-durable \
  --package @earendil-works/pi-agent-core
cd ../my-project
npm install --ignore-scripts
```

For a pnpm project, point `--consumer` at the workspace root:

```bash
bun scripts/use-local-packages.mjs \
  --manifest .artifacts/pi-packages/manifest.json \
  --consumer ../my-project \
  --package @earendil-works/pi-agent-core \
  --package-manager pnpm
cd ../my-project
pnpm install --ignore-scripts
```

Repeat `--package` for each direct dependency. The command updates the
consumer's `package.json` with content-addressed local `file:` references. It
writes transitive overrides to `package.json` for npm or `pnpm-workspace.yaml`
for pnpm. Keep the artifact directory available while installing or updating
the consumer. Re-run both commands after changing Pi source.

## Building standalone binaries from release source

GitHub releases include a versioned source archive covered by the release's `SHA256SUMS` file. Extract it and run the same build script used for the official standalone binaries:

```bash
VERSION="<release-version>"
tar -xzf "pi-${VERSION}-source.tar.gz"
cd "pi-${VERSION}"
./scripts/build-binaries.sh --offline-model-data --platform linux-x64 --out "$PWD/out"
```

The archive includes release model data and native prebuilds. `--offline-model-data` uses that model data without refreshing provider catalogs. The script installs dependencies and builds the executable with its runtime assets; pass `--skip-install` if dependencies are already provided.

## Supply-chain hardening

We treat npm dependency changes as reviewed code changes.

- Direct external dependencies are pinned to exact versions. Internal workspace packages remain version-ranged.
- `.npmrc` sets `save-exact=true` and `min-release-age=2` to avoid same-day dependency releases during npm resolution.
- `package-lock.json` is the npm lock, and the source for the pi.dev install lock generator. CI installs from `bun.lock` (see `docs/axiom/toolchain.md`). Pre-commit blocks accidental `package-lock.json` changes unless `PI_ALLOW_LOCKFILE_CHANGE=1` is set.
- `bun run check` verifies pinned direct deps, native TypeScript import compatibility, and the generated coding-agent install lock.
- The pi.dev installer installs from `packages/coding-agent/install-lock/`, generated from the root lockfile, to pin transitive deps. The npm package does not pin transitive deps.
- Local release smoke tests and npm publication use the same tarball packer; npm publishes the validated tarballs rather than repacking workspace directories.
- Local release installs, documented npm installs, and `pi update --self` use `--ignore-scripts` where supported.
- CI installs with `bun install --frozen-lockfile --ignore-scripts`, and a scheduled GitHub workflow runs `npm audit --omit=dev` plus `npm audit signatures --omit=dev`.
- Install lock generation has an explicit allowlist for dependency lifecycle scripts; new lifecycle-script deps fail checks until reviewed.

## Share your OSS coding agent sessions

If you use Pi or other coding agents for open source work, please share your sessions.

Public OSS session data helps improve coding agents with real-world tasks, tool use, failures, and fixes instead of toy benchmarks.

For the full explanation, see [this post on X](https://x.com/badlogicgames/status/2037811643774652911).

To publish sessions, use [`badlogic/pi-share-hf`](https://github.com/badlogic/pi-share-hf). Read its README.md for setup instructions. All you need is a Hugging Face account, the Hugging Face CLI, and `pi-share-hf`.

You can also watch [this video](https://x.com/badlogicgames/status/2041151967695634619), where I show how I publish my `pi-mono` sessions.

I regularly publish my own `pi-mono` work sessions here:

- [badlogicgames/pi-mono on Hugging Face](https://huggingface.co/datasets/badlogicgames/pi-mono)

## License

MIT

<p align="center">
  <a href="https://pi.dev">pi.dev</a> domain graciously donated by
  <br /><br />
  <a href="https://exe.dev"><img src="packages/coding-agent/docs/images/exy.png" alt="Exy mascot" width="48" /><br />exe.dev</a>
</p>
