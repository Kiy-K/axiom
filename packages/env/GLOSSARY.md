# Glossary: pi-env

Context: `packages/env` (`@earendil-works/pi-env`). Source: its README and `docs/`. Map: [../../GLOSSARY-MAP.md](../../GLOSSARY-MAP.md).

**Daemon (`pi-env`)**: a small Rust program that runs on the machine where tools execute. It speaks a framed protocol on stdin and stdout and performs file operations and commands there.

**Connection**: the link to a daemon. It is either started over SSH (`connectSsh`, `sshConnection`) or run locally (`localDaemon()`).

**ExecutionEnv**: Durable's interface for file operations and commands. `RemoteExecutionEnv` and `LocalExecutionEnv` implement it through a daemon.

**Terminal (`openTerminal`)**: a program run in a pseudo-terminal of the daemon, with raw output, input, resizing and an exit code.

**Process (`openProcess`)**: a program run with plain pipes, for protocol programs such as MCP servers. Its process group is killed when it exits. It is not a terminal.

**Host key and known hosts**: the SSH host key is shown to the owner, who compares its fingerprint out of band and accepts it (`scanHostKey`, `acceptHostKey`). Connections run in strict host-key mode against the app's own known-hosts file.

**Deploy**: the daemon binary is named by its SHA-256 and verified before every start.
