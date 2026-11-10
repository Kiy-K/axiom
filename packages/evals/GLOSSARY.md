# Glossary: Pi evals

Context: `packages/evals` (`@earendil-works/pi-evals`). Source: its README. Map: [../../GLOSSARY-MAP.md](../../GLOSSARY-MAP.md).

**Eval**: a `vitest-evals` suite file under `evals/`. A `*.docs.eval.ts` file is a documentation-lift eval. Other `*.eval.ts` files are host evals.

**Case**: one scenario in an eval, with its setup, task and deterministic grading.

**Variant**: one documentation condition: `without_docs` (no coding-agent docs or examples in the image) or `with_docs` (the docs are included).

**Arm**: one planned run of `(case, variant, model, runNumber)` in a fresh container.

**Pair**: the `with_docs` and `without_docs` arms of the same case, model and repetition. A pair counts toward lift only when both arms produce exactly one score.

**Blocked pair**: a pair with a missing, duplicate, skipped, pending, unscored or errored arm. When any pair is blocked, headline pass rates are withheld.

**Cohort**: the complete set of planned arms, written to `expected-runs.json`.

**Lift**: the pass-rate difference between the two variants of a comparison.

**Judge and `judgeThreshold`**: the scoring step. `judgeThreshold: null` makes scoring comparative: a low score is data, not a failure.
