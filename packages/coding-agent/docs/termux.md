# Run Pi on Android with Termux

Pi runs on Android through [Termux](https://termux.dev/), a terminal emulator and Linux environment. Text input, file tools, and shell commands are supported. Pi can copy and paste text through the Android clipboard with Termux:API. Clipboard image paste is not supported.

Preview and npm packages ship `native/process/android-arm64/axiom-process` and `native/process/android-x64/axiom-process`. Running those binaries on Termux has not been verified. Without process-group pidfds, the helper fallback retains the helper when group membership cannot be proven empty; completed jobs can accumulate helpers and zombies until session cleanup.

## Before you begin

Install Termux from [GitHub or F-Droid](https://github.com/termux/termux-app#installation). Do not use the deprecated Google Play build.

[Termux:API](https://github.com/termux/termux-api#installation) is optional. Install it only when you want Pi to copy or paste Android clipboard text, or when shell commands need Android device APIs.

## Install Pi

1. Update Termux packages:

   ```bash
   pkg update && pkg upgrade
   ```

2. Install Node.js and Git:

   ```bash
   pkg install nodejs git
   ```

3. Install Bun 1.4.4, then Axiom from source. Axiom and Bun are not verified on Termux:

   ```bash
   git clone https://github.com/Kiy-K/axiom
   cd axiom
   bun install --ignore-scripts
   bun run build
   alias axiom="bun $PWD/packages/coding-agent/dist/bundle/cli.js"
   ```

   Add the `alias` line to your shell profile so it persists.

4. Verify the installation:

   ```bash
   axiom --version
   ```

5. Open the folder you want to work in and start Pi:

   ```bash
   cd /path/to/working-folder
   axiom
   ```

Continue with the main [Quickstart](quickstart.md#3-choose-a-model) to connect a model and run your first task.

## Access Android shared storage

Termux cannot access shared Android storage until you grant permission. Run this once:

```bash
termux-setup-storage
```

After approval, Android shared storage is available under `/storage/emulated/0` and through the links Termux creates under `~/storage/`.

Only grant this permission when Pi should be able to access those files. Commands and tools running in Termux use the same storage permissions as the Termux process.

## Use clipboard commands

Pi uses `termux-clipboard-set` to copy text and `termux-clipboard-get` for its clipboard-paste shortcut. Shell commands can use both commands directly. Install the Termux:API app and its command-line package:

```bash
pkg install termux-api
```

Verify the integration:

```bash
printf 'Pi clipboard test' | termux-clipboard-set
termux-clipboard-get
```

The second command should print `Pi clipboard test`.

The Termux clipboard API supports text only. Pi's clipboard-paste shortcut inserts that text into the editor but cannot attach clipboard images.

## Add Termux-specific instructions

Pi detects that it is running in Termux, but it cannot infer how you want it to interact with Android. Add only the environment details relevant to your work to `~/.pi/agent/AGENTS.md`:

````markdown
# Termux environment

- Pi runs in Termux on Android.
- Shared Android storage is under `/storage/emulated/0`.
- Open URLs with `termux-open-url "https://example.com"`.
- Open files with `termux-open <path>`.
- Do not access shared storage unless the task requires it.
````

Run `/reload` after changing the file during an active session.

## Troubleshooting

### Clipboard integration fails

Confirm that you installed both components:

1. The Termux:API Android app from the same source as Termux
2. The `termux-api` command-line package

Then run the clipboard verification commands above outside Pi. If they fail there, fix the Termux:API installation before retrying Pi's copy command.

### Shared storage reports permission denied

Run `termux-setup-storage`, approve the Android permission request, and retry the path under `~/storage/` or `/storage/emulated/0`.

### Axiom is not found after installation

Open a new Termux shell, then check the alias and the built bundle:

```bash
type axiom
ls ~/axiom/packages/coding-agent/dist/bundle/cli.js
```

If the alias is missing, add it to your shell profile. If the bundle is missing, run `bun run build` in the checkout again.
