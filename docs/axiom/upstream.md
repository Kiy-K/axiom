# Upstream tracking

Axiom is a fork of Pi. This page records the upstream base, license obligations, and sync procedure. Facts are from HEAD `922c3ff2b`; upstream refs were read with `git ls-remote upstream` (read-only).

## 1. Upstream and pin

| Item | Value |
|---|---|
| Upstream | https://github.com/earendil-works/pi (remote `upstream`) |
| Axiom remote | `origin` = https://github.com/Kiy-K/axiom |
| Fork point (merge-base with `upstream/main`) | `922c3ff2bdea786b16c9b26680f22c2272251ffc` (equals HEAD) |
| Nearest release tag | `v1.5.0` = `f9a26365568127461c47a07a37dcb42c140a3ac5` (2026-11-02) |
| Distance from tag | 237 commits (`v1.5.0-237-g922c3ff2b`) |

Caveat: `upstream/main` equals HEAD, so no commit exists on Axiom's side that is absent from upstream main. Either the Axiom commits were pushed to `earendil-works/pi`, or the fork point carries no information. Confirm before relying on `922c3ff`. Until then, use `v1.5.0` as the release base.

Reproduce the pin:

```sh
git fetch upstream --tags
git merge-base upstream/main HEAD                          # 922c3ff2b...
git describe --tags --long "$(git merge-base upstream/main HEAD)"   # v1.5.0-237-g922c3ff2b
git rev-parse v1.5.0                                       # f9a2636...
git rev-list --left-right --count upstream/main...HEAD     # 0 0
git rev-list --left-right --count v1.5.0...HEAD            # 0 237
```

## 2. Versions at HEAD

- `packages/{agent,ai,chord,codemode,coding-agent,durable,env,evals,mcp,schema,telemetry,tui}`: `1.5.0` each. Names are `@earendil-works/pi-*`, except `@earendil-works/chord`. `evals` is private.
- `packages/coding-agent/install-lock`: `1.5.0`, private.
- `apps/p2` (`p2`): `0.0.1`, private.
- Root (`pi-monorepo`): `0.0.3`, private.

## 3. License

- Root `LICENSE`: MIT, `Copyright (c) 2025 Mario Zechner`. No NOTICE file. Every workspace `package.json` declares `"license": "MIT"`.
- MIT obligation: every copy or substantial portion keeps the copyright line and permission notice. Rebranding does not remove it. The binary, npm name, and `piConfig` may change; the Mario Zechner notice stays. An Axiom copyright line may be added beside it.

Verified gaps (notice not shipped):

| Artifact | Notice shipped? | Evidence |
|---|---|---|
| npm tarball `@earendil-works/pi-coding-agent` | no | `npm pack --dry-run --ignore-scripts` lists 183 files, no LICENSE; no `packages/*/LICENSE` is tracked |
| Standalone archives | no | `scripts/build-binaries.sh:143-159` copies package.json, README, CHANGELOG, docs, examples, assets; no LICENSE |
| Bundled `dist/bundle/cli.js` | stripped | `scripts/build-coding-agent-bundle.mjs:86` sets `legalComments: "none"` |

Vendored or derived third-party code:

| Path | Origin | License | Notice in repo |
|---|---|---|---|
| `packages/coding-agent/src/core/export-html/vendor/highlight.min.js` | highlight.js 11.9.0 | BSD-3-Clause | header only; full text absent |
| `.../export-html/vendor/marked.min.js`, `marked-cjk-friendly.min.js` | marked, marked-cjk-friendly | MIT | header |
| `packages/coding-agent/src/utils/ansi.ts` | sindresorhus | MIT | full notice |
| `packages/mcp/src/oauth/{types,discovery,flow}.ts` | modelcontextprotocol SDK 1.29.0 | MIT | `packages/mcp/THIRD_PARTY_NOTICES/` |
| `packages/schema/src/formats/typebox/**` | TypeBox | MIT | `packages/schema/THIRD_PARTY_NOTICES/` |
| `packages/tui/src/oklab.ts`, `stdin-buffer.ts` | Björn Ottosson; OpenTUI | MIT | header |
| `apps/p2/plugins/terminals/vendor/ghostty/` | Ghostty (`ghostty-vt.wasm`) | MIT | `LICENSE` present |
| `apps/p2/plugins/workspace/fuzzy.ts` | VS Code fuzzyScorer | MIT | header only |
| `apps/p2/voice-server/supertonic_helper.py` | Supertone Inc. | MIT | header only |
| `examples/extensions/doom-overlay/doom/build/doom.{js,wasm}` | doomgeneric build | GPL-2.0 [INFERENCE, verify] | none |
| `photon_rs_bg.wasm` (`@silvia-odwyer/photon-node`) | photon-node | Apache-2.0 | none; shipped in npm dist and binaries |

Apache-2.0 requires shipping the license text on redistribution. Check the doom build's upstream license before publishing.

## 4. Upstream sync strategy

- Track release tags, not `upstream/main`, which moves constantly.
- Keep the rebrand diff small. Change identity through `piConfig` and `bin`. Do not rename `@earendil-works/*` packages, import paths, or wire names. The touchpoints are in the inventory.
- Merge each tag into a sync branch in its own worktree, so other sessions in the main checkout are undisturbed.

```sh
git config rerere.enabled true                        # reuse recorded conflict resolutions
git fetch upstream --tags
git worktree add ../axiom-sync-v1.6.0 -b sync/upstream-v1.6.0 main
cd ../axiom-sync-v1.6.0
git merge --no-ff v1.6.0                              # conflicts should only touch rebrand files
# verify: bun install --ignore-scripts && bun run check
cd <main checkout> && git merge --no-ff sync/upstream-v1.6.0
```

After merging a tag, also run `cmp LICENSE packages/coding-agent/LICENSE` (the package copy must match the root notice).

Never force-push. Never run `git reset --hard`, `git checkout .`, or `git stash` in a shared checkout.

## Compatibility exclusions

Deliberately unchanged by the rebrand (`docs/axiom/rebrand.md` D3-D5, D7). Renaming these would break third-party packages, user config, or server-side allowlists, and each one is an upstream merge-conflict site.

| Kept as is | Why |
|---|---|
| `@earendil-works/*` package names and import specifiers | Published upstream names; extensions import them. |
| `pkg.pi` package manifest key (`cad/core/pi-manifest.ts`) | Public contract of third-party Pi packages. |
| `pi` extension API variable, `pi-ai` bin | Documented API used by every extension. |
| `PI_*` env vars other than the agent/session dir (e.g. `PI_OFFLINE`, `PI_TIMING`, `PI_TELEMETRY`), bash-tool exports `PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`, `PI_MODEL`, `PI_REASONING_LEVEL`, marker `PI_CODING_AGENT=true` | User scripts and CI read them; about 40 read sites. |
| `PI_CODING_AGENT_DIR` / `PI_CODING_AGENT_SESSION_DIR` | No longer read by Axiom (`AXIOM_*` replace them); a set `PI_CODING_AGENT_DIR` only skips the data import. |
| UA `pi/<version>`, `originator: "pi"`, xAI `referrer`, `pi-gateway` OAuth client ID, MCP `clientInfo.name`, `AI_AGENT="pi"` | Server-visible identities; providers may allowlist them. |
| `pi-messages` / `pi-virtual` API ids, temp-file prefixes | User `models.json` and on-disk names. |
| System prompt text ("running inside pi", "Pi documentation") | Byte-identical prompts keep P7 benchmarks comparable. |
| pi.dev hosts for the model catalog, share viewer (`PI_SHARE_VIEWER_URL` overrides), and MCP OAuth client documents | Accepted dependency on upstream hosts. Version checks, install telemetry, self-update and `/bug` upload are off in Axiom (`IS_OFFICIAL_DISTRIBUTION`). |
| `update [source\|self\|pi]` input tokens; managed-install prose ("managed Pi") | Upstream-only install paths. |
| Release workflow publish steps, source tarball `pi-${VERSION}-source.tar.gz`, install-lock asset names, install-lock `resolved` URLs, `pi-env` daemon names | Upstream-only publishing; disabled for Axiom because the upstream secrets are absent. Only binary and archive names were renamed. |

MCP conformance (D7): with `clientRegistration` `auto`, Axiom registers by DCR as `axiom` instead of using pi.dev's client metadata document. Any resulting change in `packages/coding-agent/test/mcp-conformance/baseline.json` `auth/basic-cimd` is expected; a change in any other scenario is a bug.
