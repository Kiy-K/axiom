# P5: accept-edits in trusted workspaces

Issue: https://github.com/Kiy-K/axiom/issues/1

## Goal and boundary

Offer automatic edits only when the user explicitly trusts the current workspace for editing. This is separate from project-resource trust: a project with no special resources may be implicitly trusted for loading, which does not authorize writes. The permission gateway remains authoritative. Shell commands, extension tools, outside-workspace access, protected or secret paths, and destructive writes retain their manual decisions.

## Mode and trust

`yolo` replaces `unrestricted` and remains the default; it disables the permission gateway. `accept-edits` is opt-in and distinct from `manual` and `yolo`. Without explicit edit trust, accept-edits behaves as manual. A fresh interactive session can obtain an explicit edit-trust decision, held only in memory for that session and exact workspace. New directories, resume, fork, CI, print and RPC do not inherit it; RPC is treated as headless even if it has a UI. The effective mode and whether edit trust is active are visible in the TUI and CLI, with the existing interrupt and permissions review controls. Auto-approvals are audited with a distinct reason.

Every non-`yolo` mode continues to enforce the gateway on `pi.authorizeExec`, extension MCP servers and provider commands. Project-scope MCP remains governed by project-resource trust, not edit trust; accepting edits does not change which project configuration is loaded. Existing `unrestricted` configuration is not silently migrated: an unrecognized value fails closed to `manual`.

## Eligible edits

Only the built-in `edit` tool operating on an existing regular file is eligible; the `write` tool and calls involving unrecognized schemas ask. Both replace-mode and hashline edits qualify, except an edit that would empty a file asks. Symlinked paths always ask. For every path the edit may open, including resolved name variants, the gateway must confirm that it is inside the exact workspace, not protected or secret, and tracked by the same Git worktree. Multi-file effects, nested repositories, submodules, ambiguous paths and unverifiable outcomes ask. Extension replacement of `edit` or custom file operations must not qualify as the built-in implementation. Nested extension calls qualify only if they reach that same built-in implementation.

Before approval, verify that the whole worktree has no staged or unstaged changes, no untracked files and no dirty submodules; ignored files do not count. A session directory inside a repository uses that repository's status but must not grant access outside the session directory. Git worktrees with a `.git` file can qualify. Git errors, ownership refusals and unsupported repository states ask. No operation resets or cleans the worktree.

The session holds at most one outstanding automatic edit authorization. Reserve it atomically before returning approval, so concurrent calls cannot both pass the same clean-state check. Release it only after the operation finishes, and check cleanliness again for the next attempt. If completion cannot be observed reliably, keep the reservation and ask for later edits instead of guessing.

Git probes use fixed argument vectors, an intentionally constructed environment and configuration that disables executable hooks such as fsmonitor, hooks, external diffs and pagers. Do not inherit Git directory or configuration overrides. Validate the actual Git invocations and configuration isolation; on any uncertainty or error, ask rather than auto-approve. Git supplies recovery, not permission to run repository-configured commands.

## Limitations

The existing gateway resolves paths before tools open them. A path or symlink can change between those steps, and external processes can change the worktree after its status check; P7's sandbox is the documented boundary for these races. An edit can remove content from a tracked file, but Git can restore the pre-edit version when the check succeeds. Whole-file replacement through `write`, deletion of a file and edits that empty it are not automatically approved. Accept-edits does not authorize arbitrary shell execution or claim sandbox isolation. Because the clean check runs before every edit, an edit normally makes later edits ask until the worktree is clean again.

## Verification

Tests cover explicit trust and its reset, new and resumed sessions, CI, print and RPC, mode display, clean and dirty worktrees, staged and untracked changes, submodules, nested repositories, linked worktrees, ownership and Git errors, ignored files, tracked and untracked files, protected and secret paths, traversal and symlinks, name variants, emptying a file, custom or replaced tools, concurrent calls and reservation release, audit reasons, shell and external effects, and interruption/review. Verify Git probe execution isolation, run affected tests and `bun run check`, and obtain an independent Claude review of the final code.
