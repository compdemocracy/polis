# math — the Polis math engine (Python)

The real-time opinion-matrix math powering Polis: PCA, base-cluster
k-means, group clustering, representativeness (repness), consensus, and
comment routing — plus the production **math poller** that tails votes and
moderation from Postgres and writes `math_main` / `math_bidtopid` /
`math_ptptstats` under one `math_env`.

This package (`polismath`) replaced the original Clojure implementation
that lived in this directory (Clojure→Python cutover, 2026 — see
`delphi/docs/CUTOVER_RUNBOOK.md` and `delphi/docs/MATH_ALGORITHM_HISTORY.md`).
It is **certified Clojure-exact**: the replay battery holds 20/20 MATCH
dataset pairs against the Clojure reference, and live poller equivalence
runs matched the real Clojure container row-for-row
(`delphi/docs/MATH_POLLER_EQUIV_SPEC.md`). The retired Clojure tree — still
the certification oracle for any future engine change — lives in git
history: `git log -- math/` (any commit before cutover Step #4).

**Restoring the certification oracle** (needed only to RE-REPLAY the
Clojure side after an engine change; cached battery pairs need no oracle):

```sh
# from the repo root; <rev> = any pre-Step-4 commit, e.g. the Step 3 merge
git archive <rev> math/ | tar -x --exclude='math/README.md'
# math/src, math/dev, math/deps.edn, ... reappear alongside polismath/
# (the exclude keeps THIS file — every pre-cutover revision also had a
# math/README.md and would overwrite it).
# Run the battery (cd delphi && uv run python scripts/certify.py run),
# then remove the restored Clojure entries again — UNTRACKED entries only:
git status --porcelain math/ | awk '$1=="??" {print $2}' | xargs rm -r
```

Notes: in this jj-colocated repo the restored files are snapshotted into
the working-copy commit on the next jj command — do the restore + battery
+ cleanup within one working-copy session (or in a scratch clone) and
check `jj st` afterwards. Do NOT use `git checkout <rev> -- math/` here —
checkout/restore clobbers the jj working copy state.

## Layout

- `polismath/` — the package.
  - `conversation/`, `pca_kmeans_rep/` — the math itself (Clojure-exact
    legacy semantics; quirk catalog in `delphi/docs/CLOJURE_QUIRKS.md`).
  - `poller/` — the production service (`python -m polismath.poller`).
  - `database/` — Postgres read/write path.
  - `replay/` — replay harness, certify battery, poller-equivalence +
    shadow comparers.
  - `run_math_pipeline.py` — one-shot pipeline entry
    (`run-math-pipeline` console script; also invoked by
    `delphi/run_delphi.py`).

## Running

The poller service runs via the `math-python` compose service (the deploy
path), or directly:

```sh
cd delphi && uv run python -m polismath.poller          # run forever
cd delphi && uv run python -m polismath.poller --once   # one poll cycle
```

## Development environment

One shared environment with delphi: `polismath` is installed **editable**
into `delphi/.venv` (see `delphi/pyproject.toml` `[tool.uv.sources]`), so
`cd delphi && uv sync` is the only setup step. The test estate — unit and
parity tests, `real_data/` datasets, golden snapshots, replay stores —
deliberately stays under `delphi/` (`delphi/tests/`, `delphi/real_data/`);
run tests from there:

```sh
cd delphi && uv run pytest tests/ -v
```
