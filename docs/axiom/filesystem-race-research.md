# Filesystem authorization race research

## Scope

The permission gateway checks a pathname before a tool runs. The requested investigation is whether those checks can guarantee that the later edit acts on the same safe file, including when another process changes the filesystem concurrently.

## Repository evidence

- `packages/coding-agent/src/core/permissions/gateway.ts` classifies the path, reads the original, checks the executable bits and saves a pre-edit copy before returning authorization. `packages/coding-agent/src/core/agent-session.ts` passes that authorization through a `beforeToolCall` hook.
- `packages/coding-agent/src/core/tools/edit.ts` subsequently resolves the input path again and independently calls `access`, `readFile` and `writeFile`. A rename, symlink swap, chmod or content change can occur between those operations. `packages/coding-agent/src/core/tools/hashline-edit.ts` independently reads the path and atomically replaces it with a temporary file; its final rename still uses the pathname. The read-only shell rule has another filesystem access path.
- `docs/axiom/permissions.md` explicitly lists path re-resolution as unmediated and assigns it to P7. The existing P6 contract likewise defers the sandbox and TOCTOU swaps to P7.

## Platform findings

- An open file descriptor refers to an open file description even if the pathname is removed or made to refer to another file. Opening the intended object once and using that descriptor avoids a later final-path symlink swap. It does not by itself constrain all ancestor traversal or prevent another process from modifying the same file. [Linux `open(2)`](https://man7.org/linux/man-pages/man2/open.2.html)
- Linux `openat2` can constrain resolution relative to a directory descriptor with `RESOLVE_BENEATH` or `RESOLVE_IN_ROOT`, and can reject symlinks with `RESOLVE_NO_SYMLINKS`. It may return `EAGAIN` when it cannot verify safe resolution under a race. This is Linux-specific and protects resolution, not future mutations of the opened inode. [Linux `openat2(2)`](https://man7.org/linux/man-pages/man2/openat2.2.html)
- Linux `flock` is advisory: another process with permissions can ignore it. A lock therefore cannot provide a security guarantee against an uncooperative concurrent writer. [Linux `flock(2)`](https://man7.org/linux/man-pages/man2/flock.2.html)
- `rename` atomically replaces a destination name, but that is not a conditional compare-and-swap against the contents or identity previously checked, and it does not stop later renames. [Linux `rename(2)`](https://man7.org/linux/man-pages/man2/rename.2.html)
- Node exposes file handles and operations on them, but the documented filesystem API does not expose `openat2`'s resolution controls. The project also supports platforms other than Linux, so a Linux-only syscall is not a complete portable solution. [Node.js filesystem API](https://nodejs.org/api/fs.html)

## Review of the proposed edit lease

- On Linux, `O_NOFOLLOW` rejects a symlink only in the final pathname component; it does not prevent symlinks in ancestor directories. Therefore opening the original pathname with `O_NOFOLLOW` is not enough to establish that the handle came from the workspace under a concurrent parent-directory swap. `openat2` can constrain the entire lookup, but is Linux-specific. [Linux `open(2)`](https://man7.org/linux/man-pages/man2/open.2.html), [Linux `openat2(2)`](https://man7.org/linux/man-pages/man2/openat2.2.html)
- A handle keeps referring to the opened file if the pathname changes. This prevents a subsequent swap of that name from redirecting a handle-based write to the replacement, but the opened file can itself be renamed or modified by another process. The handle is not proof that the file remains at an allowed pathname or retains its checked contents or mode. [Linux `open(2)`](https://man7.org/linux/man-pages/man2/open.2.html)
- `RENAME_EXCHANGE` atomically exchanges names; `RENAME_NOREPLACE` refuses an existing destination. Neither provides an atomic operation to replace an existing destination only if it still names a particular previously checked inode. A stat followed by rename therefore leaves a race even if the rename is atomic. [Linux `rename(2)`](https://man7.org/linux/man-pages/man2/rename.2.html)
- On Windows, `CreateFileW` documents separate reparse-point and sharing controls, including `FILE_FLAG_OPEN_REPARSE_POINT` and `FILE_SHARE_DELETE`; the Linux `O_NOFOLLOW` design cannot simply be assumed to apply. Node documents `O_NOFOLLOW`, but cross-platform behavior and availability must be verified against the supported Node versions and filesystems before relying on it. [Microsoft `CreateFileW`](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew), [Node.js filesystem flags](https://nodejs.org/api/fs.html#file-system-flags)
- The previously proposed lease is therefore partial hardening, not a race-free authorization boundary. In particular, a portable hashline implementation that preserves atomic replacement cannot claim that the file checked at authorization is necessarily the one replaced. Fail closed where the chosen platform implementation cannot establish the intended guarantees; do not silently downgrade flags or substitute a post-open path check as equivalent.

## Implementation contract

- Automatic built-in edits must validate and checkpoint bytes from an opened regular file, retain that handle under the tool-call identity, and release it on every outcome. Refuse automatic approval when a secure platform-specific open is unavailable; never silently remove no-follow protection. Explicitly approved edits keep their existing behavior.
- Replace-mode execution uses the retained handle, not a fresh pathname lookup. It refuses if the handle's metadata or contents no longer match the authorization snapshot. In-place writes are not atomic and concurrent writers remain outside this guarantee.
- Hashline execution reads and validates the retained handle and preserves its existing atomic temp-file replacement. Recheck pathname identity and snapshot immediately before rename; a concurrent change after the check remains a documented race, not a security guarantee.
- Test both modes end-to-end for an ordinary edit, path replacement, changed contents, executable-bit changes and cancellation; verify the checkpoint contains the authorized bytes and handles are released. Test unsupported platforms as a refusal, not an unprotected fallback.
- This slice does not secure shell execution, prevent other processes writing or renaming the opened file, or implement the P7 sandbox.

## Consequence

Repeating `lstat`, `realpath` or content checks only narrows the race; it does not close it. A file-handle-based edit can close some path-replacement windows, but must be integrated with authorization and checkpointing. Hashline also needs to retain its atomic-replacement guarantee: writing through a file handle in place would discard that guarantee. Neither approach alone stops hostile mutation of the same inode. A general guarantee for tools that open arbitrary paths after authorization requires an enforced OS isolation boundary, with platform-specific implementations and tests. Until that boundary exists, the current gateway must not be described as race-free against concurrent filesystem mutation.
