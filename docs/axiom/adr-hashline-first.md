# ADR: Hashline-first edit direction

Status: accepted. Hashline is the default edit mode, approved by the user after the Iteration 4 gate in `docs/axiom/hashline-gate.md` passed. Replace stays available through `editMode: "replace"`.

## Decision

Axiom's edit path is Hashline: the model edits by line ID, and each ID carries a hash of the line under the file's current tag. `editMode` defaults to `"hashline"`. `editMode: "replace"` keeps the exact `oldText` tool for users who need it.

## Why

- Replace can silently write the wrong bytes on mixed line endings. Run 1, run 2, and the v3 holdout show this (10 of 10 runs on the mixed-ending task each time). The per-line fix in `restoreLineEndings` removes that defect for replace; it did not change the choice of direction.
- Hashline refused every stale and mismatched edit in the gate (0 wrong writes across Iterations 1-4). Its cost is extra turns and tokens. On holdout v2 the median was 9,838 tokens against 8,413 for replace (+19%, paired CI +1,236 to +2,503), with wall +1.1 s.
- Gate evidence is limited to one model, six JavaScript fixtures per set, and runner-injected stale changes. The cost trade-off is accepted for correctness, and it is the cost users now pay by default.

## What this does not change

- Replace keeps its API, tool name, and code. `editMode: "replace"` restores the previous behaviour.
- The P2 null verdict in Iteration 3 stands; it is the reason for the earlier gate, not a reversal.

## Open costs (not yet fixed)

- Read output carries an ID on every line (about +43% characters on the same files).
- Each stale change still costs one refused edit and one retry turn (one per stale run on holdout v2).
- Models still sometimes send a hash that belongs to a neighboring line; the refusal now names the owner line.
