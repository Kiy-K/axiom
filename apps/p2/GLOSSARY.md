# Glossary: p2

Context: `apps/p2`. Source: its README and `docs/p2-notes.md`. Experimental prototype; its formats and APIs change without notice. Map: [../../GLOSSARY-MAP.md](../../GLOSSARY-MAP.md).

**Owner**: a signed-in or local user with full agent and shell control on the server and its workers. Owners have distinct, revocable cookies.

**Local device owner**: the owner on the server's loopback address. It auto-signs in and is the only owner that can mint invitations.

**Remote owner (`access: "device"`)**: a signed-in device. It can manage provider logins and upload SSH keys, but cannot mint owner tokens.

**Owner link and owner token**: a one-time, ten-minute link (`/owner#<token>`) that signs a device in. The token is a credential: keep it out of logs and URLs.

**Guest**: a visitor with a share link and no owner cookie. Guest access is session-limited.

**Radius**: a separate authenticated transport that reaches an owner's server without a tunnel. Proxy headers are not authentication.

**TUI launcher and TUI worker**: the launcher is the trusted side on the visitor's machine. It owns terminal input, sign-in and cookies. The worker runs the downloaded TUI bundle in a locked-down environment with no file, network or child-process access.

**TUI bundle**: one self-contained ESM file built from the selected plugins' `tui.ts` facets, served by hash.

**Plugin**: a Chord plugin. Each one contributes objects and, optionally, a `tui.ts` facet.

**Providers**: the Providers screen, where an owner logs in to model providers through pi-ai. Credentials are kept in the server's private `auth.json`.

**Voice mode**: hands-free conversation through a speech service. It appears only when `voice.json` names a service.
