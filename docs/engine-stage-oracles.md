# Engine stage oracles

**What this is.** A way to ask *where* two implementations of the Polis math
engine first disagree, instead of only being told that their final `math_main`
blobs differ.

Both replay drivers can dump the intermediate outputs of the tick pipeline —
one file per replay step, in a shared JSON shape — and a comparer diffs the two
dumps stage by stage and names the **first diverging stage**.

**What this is not.** A gate. Stage dumps are **diagnostics only**. The single
PASS / APPROVED_DIFFERENCE / FAIL / INCONCLUSIVE authority remains
`polismath.replay.certify` on the final blob. Nothing in this document changes a
verdict, and `certify` does not import either module (there is a test that
asserts it).

The reason is not squeamishness. The two live engines already differ at ~1e-16
inside `proj` and at ~1e-5 in cold-tick `comps` while the final blob still
MATCHes — noise the acceptance policy deliberately tolerates. A stage-level
exact comparison would fail on exactly that noise, so a stage dump that voted
would be a worse gate than the one we have.

---

## Producing the dumps

A *recording directory* holds both engines' output for one (dataset, schedule):

```
<recording>/
  schedule.json
  provenance.json
  clj/                 # Clojure prep-main blobs      (certify's reference)
  py/                  # Python  step payloads        (certify's candidate)
  clj-stages/          # Clojure stage dumps          <- this document
  py-stages/           # Python  stage dumps          <- this document
```

The stage directories are **siblings** of the blob directories, never inside
them. `certify` globs `step-*` and `step-*.json` inside an engine directory for
its inventory and digest sets (`certify.py:868,873,1283`),
`store.write_recording` deletes `step-*.json` there before every write, and
`store.load_step_blobs` reads that same glob as step payloads. A stage file
inside `clj/` or `py/` would be picked up by all three.

### Clojure

```bash
cd math
clojure -M:replay \
  --schedule <schedule.json> \
  --votes    ../delphi/real_data/<dataset>/*-votes.csv \
  --out      <recording> \
  --stage-json
```

`--stage-json` is a sibling sink beside the always-on blob writer and the
optional `--edn` dump. It is off by default and it does not touch the recorded
`prep-main` blob: the same schedule run with and without it produces a
byte-identical `clj/step-NNN.blob.json`. With `--repeats N > 1` the stage
dumps follow the blob layout: rep 0 flat in `clj-stages/`, every rep also in
`clj-stages/rep-<i>/`.

### Python

```bash
cd delphi
OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 \
uv run python -m polismath.replay.stages \
  --dataset vw --preset single-cut --out <recording>
```

or, in process:

```python
from polismath.replay import real_data, stages, certify

ds   = real_data.load_export_votes("vw")
spec = certify.build_effective_spec(entry, ds)      # the battery's own spec
stages.run_stage_dump(ds, spec, out_dir=recording / "py-stages")
```

`run_stage_dump` folds with `driver.run_replay` itself, through its `on_step`
hook, so a stage dump can never drift from the recording `certify` consumes.

### A third engine

Write the same `polis-stage-dump/1` files into `<recording>/<engine>-stages/`
and point the comparer at the directory. Nothing about the format is Python- or
Clojure-specific.

---

## Reading the diff

```bash
cd delphi
uv run python -m polismath.replay.stagecompare \
  --recording <recording> [--verbose] [--out report.json]
```

```
Stage comparison (clj vs py)
  DIAGNOSTICS ONLY — certify on the final blob is the sole PASS/FAIL authority.
  A: …/clj-stages  (1 steps)
  B: …/py-stages   (1 steps)
  first diverging stage: none — every stage within tolerance
  step 0: first diverging stage = none
      [MATCH] R04_pca.pca (geom): 0/750 out of tolerance,
              max_abs=9.031e-08 max_rel=1.739e-06
              worst=pca.comment-projection.1.4
      [CARVED C4] R13_ptpt_stats.ptpt-stats (exact): 52/134 out of tolerance,
              max_abs=2.800e+01 max_rel=5.000e-01 worst=ptpt-stats.49.n-votes
```

Per key you get: how many numeric pairs were compared, how many fell outside
that key's tolerance, and the **max absolute and max relative error over every
compared pair** with the path that produced the largest one. `max_abs` /
`max_rel` are reported even when the key matches — on a matching key they are
the headroom, i.e. how close that stage came to its bound. Exit status is always
0; this tool does not fail a build.

Two caveats when reading the numbers:

* **`max_rel` near zero is not meaningful.** When one side is exactly 0.0 and
  the other is 2e-7, the relative error is 1.0 while the absolute error is
  comfortably inside the bound. Read `max_abs` first.
* **`n_compared` counts numeric leaves, not entities.** A 67×67 `bucket-dists`
  contributes 4 489 comparisons.

### What "first diverging stage" means

Stages run in a fixed pipeline order, and each consumes the previous ones'
output:

| stage | Clojure graph nodes |
|---|---|
| `R01_ingest` | `raw-rating-mat`, `rating-mat`, `tids`, `n`, `n-cmts`, `last-vote-timestamp` |
| `R02_moderation` | `mod-in`, `mod-out`, `meta-tids`, `last-mod-timestamp` |
| `R03_eligibility` | `user-vote-counts`, `in-conv` |
| `R04_pca` | `mat` (imputed), `pca` = center / comps / comment-projection / comment-extremity |
| `R05_projections` | `proj` (as a named matrix over participant ids) |
| `R06_base_clusters` | `base-clusters`, `base-clusters-proj`, `base-clusters-weights`, `bid-to-pid`, `bucket-dists` |
| `R09_group_clusters` | `group-clusterings`, `group-clusterings-silhouettes`, `group-k-smoother`, `group-clusters` |
| `R10_tallies` | `votes-base`, `group-votes`, `group-aware-consensus` |
| `R11_repness` | `repness`, `consensus` |
| `R12_priorities` | `comment-priorities` |
| `R13_ptpt_stats` | `ptpt-stats` |

The **first diverging stage** is the earliest stage carrying a difference that
is outside its declared tolerance *and* outside the declared carve-outs.

It is the only number worth acting on. A difference at stage *N* mechanically
propagates into every later stage, so a report showing eight divergent stages is
usually one bug at the earliest of them and seven consequences. Fix the first;
re-run; look again. Correspondingly, a divergence at a *later* stage with every
earlier stage clean is a genuinely local bug in that stage's own arithmetic —
the most useful signal this tool produces.

Stage names are zero-padded (`R01…R13`) so that lexicographic key order in the
JSON *is* pipeline order.

### Tolerance classes

| class | bound | applies to |
|---|---|---|
| `exact` | `a == b` | typed ids, counts, membership, eligibility, vote meaning, cursors, the k-smoother state |
| `tight` | `abs(a-b) <= 1e-6 + 1e-4·max(\|a\|,\|b\|)` | numeric statistics: `mat`, tallies-derived consensus, repness/consensus stats, comment priorities |
| `geom` | `abs(a-b) <= 1e-6 + 1e-2·max(\|a\|,\|b\|)` | PCA-derived geometry: `pca`, `proj`, cluster centers, `bucket-dists`, silhouettes |

`tight` is the bound `P-022-G-engine-contract.md` §numeric-policy proposes for
finite numeric statistics with zero outlier allowance. `geom` is deliberately
looser because the two engines' cold-tick `comps` are documented to differ at
~1e-5 while the final blob still MATCHes; it is the same relative bound
`stepcompare.StepComparer` already defaults to for PCA-family paths.

Non-numeric leaves (ids, booleans, strings, membership lists) are compared
exactly whatever a key's numeric class is, and a shape difference — a missing
key, a length mismatch — is always a divergence, never a tolerance question.

### What the comparer normalizes first

Three transformations, applied to each side before diffing, so that only real
differences survive.

1. **Polarity.** Clojure computes in raw-DB convention (AGREE = −1); Python
   computes in Delphi convention (AGREE = +1) and negates only at its blob
   emission boundary. Each dump declares its `vote_sign_convention`, and a
   `raw-db` dump has its vote-valued and geometry nodes negated into Delphi
   convention before comparison. The negation set is `rating-mat`,
   `raw-rating-mat`, `mat`, `pca.center`, `pca.comment-projection`, `proj`, and
   every base-/group-cluster `center`. Deliberately *not* negated: `comps`
   (`XᵀX == (−X)ᵀ(−X)`, so power iteration from the same start vector returns
   the identical vector), `comment-extremity` and `bucket-dists` (norms and
   distances), and every count and tally (counts are relabelled, not rescaled).

   The **emitters do not do this**. Each writes its engine's native numbers, so
   the file stays a faithful record of what that engine actually computed and
   the interpretation lives in one auditable place.

2. **Identity keying.** Named matrices become `{rowname|colname: cell}`, and
   every tid-, pid- or bid-indexed array becomes a dict keyed by that id. Clojure
   emits `tids` in hash/insertion order and Python in sorted order; each blob is
   internally consistent, so array position is not semantics. Without this every
   run would report thousands of phantom differences.

3. **Coupled component sign.** Each principal component is oriented so its
   largest-magnitude entry is positive (first tid on ties), and the arrays coupled
   to it — that component's `comment-projection` row, the matching `proj`
   column, and coordinate *k* of every base- and group-cluster center — are
   flipped with it. `pca.center` is a data mean and is never flipped. This is
   `crosslang.canonicalize_blob`'s rule, applied one level deeper.

---

## Carve-outs — differences that are expected

From P-030 §Q13/Q18 and the engines' own documented boundaries. Four are applied
automatically (the key reports `CARVED` instead of `DIVERGENT`, with its numbers
still printed, and it does not become the first diverging stage). Two are
documented but never auto-suppressed.

| id | key | auto | why it is expected |
|---|---|---|---|
| **C1** | `mod-in`, `mod-out`, `meta-tids` | yes | Clojure emits `nil` until a `mod-update` has written the set; Python emits an empty set. `null` vs `[]` on those three keys only — a genuinely absent value anywhere else still reports. Python's own blob boundary already mirrors the Clojure rule via `moderation_applied`, and the stage emitter applies the same gate, so in practice this fires rarely. |
| **C2** | cluster ids / membership on warm chains | **no** | **Q13.** Warm-chain split-loop extraction order is knife-edge chaotic on tie-dense geometry: within-engine gaps at 2.5e-16 and 5.6e-17 against cross-engine projection noise at ~1e-5, eleven orders larger. No arithmetic replication reproduces the order. Ledgered on `FP-912391ece7 / FP-c29173e1ba / FP-98dc728043`; carved in the battery by swapping `pc-revote-01` for `pc-revote-02`. |
| **C3** | `group-clusterings-silhouettes` | yes | The two engines score with **different estimators**: Clojure's `clusters/silhouette` over `bucket-dists`, Python's `calculate_silhouette_sklearn` over the base-cluster centers. The values are expected to differ. What must agree is the *argmax* they feed, which is visible in `group-k-smoother` and the group count — both compared exactly. |
| **C4** | `ptpt-stats` | yes | The engines compute **different statistics under the same name**. Clojure emits `coreness` / `centricness` / `extremeness` (geometry over the participant projection); Python emits `n_agree` / `n_disagree` / `n_pass` / `group_correlations`. Even the two same-named fields disagree by construction: Clojure's `n-votes` is `user-vote-counts` over the *raw* rating matrix, Python's `n_votes` counts non-zero cells of the moderation-applied matrix, and Python omits participants with no votes entirely. `math_ptptstats` has no reader anywhere in Node or the clients, so this is verification surface only. |
| **C5** | `mat`, all-NaN column | yes | Python substitutes a 0.0 column mean where Clojure would divide by zero. Unreachable on a real conversation — every column carries at least one vote. |
| **C6** | cluster ids on coincident centers | **no** | **Q18.** `uniqify`'s exact-center-equality predicate is value-dependent ulp luck: `merge-clusters`' weighted mean preserves the input value for some doubles and rounds one ulp for others, so whether a merge *chain* over coincident singletons continues — and which id survives — depends on the 17th digit. Root cause of all 11 `carved-out` entries in `delphi/docs/divergences.json`. |

**Why C2 and C6 are not auto-suppressed.** They are chaotic, not addressable by
a path rule. A rule that hid "cluster ids differ" would also hide real
structural breakage in the lineage code, which is precisely what R7 exists to
catch. So they are reported, and this table is how a reader recognises the
fingerprint. P-030 §5/R7 says it directly: if a divergence's path pattern
matches a carved-out fingerprint on a mod-heavy warm chain, probe it with the
split-probe before spending a day on it — the correct action is to record it,
not to fix it.

---

## The file format

`polis-stage-dump/1`. One document per step, plus a manifest.

```json
{
  "engine": "clj",
  "input_digest": "sha256:a3d12bdc…",
  "schema": "polis-stage-dump/1",
  "stages": { "R01_ingest": { "n": 69, "n-cmts": 125, … }, … },
  "step": 0,
  "tick": 1732040170000,
  "vote_sign_convention": "raw-db"
}
```

`stages-manifest.json` carries `{engine, n_steps, schema, stage_order, steps,
vote_sign_convention}` where each step row is `{file, index, input_digest,
tick}`.

Encoding rules, identical on both engines:

* **Key order.** Every object's keys are sorted ascending as strings. Integer
  and keyword map keys are stringified *first* and then sorted, so `"10"`
  precedes `"2"` on both sides.
* **Integers** — ids, counts, timestamps, vote values — are JSON integers with
  no decimal point.
* **Doubles** use the shortest decimal that round-trips to the same double
  (`Double/toString` on JDK 19+, `repr(float)` in Python). **Nothing is ever
  rounded**: the compared numbers are the exact doubles the engine computed.
  Exponent *formatting* differs across the two languages (`1.0E-5` vs `1e-05`)
  and does not matter — the comparison parses, it does not diff bytes.
* **Non-finite doubles** become the JSON strings `"NaN"`, `"Infinity"`,
  `"-Infinity"`; JSON has no literal for them and silently emitting one would
  make the file unparseable by a strict reader.
* **A named matrix** is `{"rownames": […], "colnames": […], "matrix": [[…]]}`
  with missing cells as `null` — a nil vote and a 0 vote are different meanings.
* **Sets** become sorted arrays; keywords become their bare name.
* **`input_digest`** is `sha256` over the step's fed batch in *export/Delphi*
  sign convention (`{"mods": [[tid, is_meta, mod, modified], …], "votes":
  [[pid, tid, sign, created], …]}`, canonical JSON, fed order). Taking it in
  export convention is what makes the two engines' digests comparable despite
  the raw-DB flip Clojure applies before `conv-update`. **If the digests differ,
  stop**: the engines were not fed the same batch and every other number in the
  report is meaningless.

Dumps are large — for `vw` (69 participants, 125 comments) roughly 350 KB per
step per engine, dominated by `bucket-dists` and the two vote matrices. They are
regenerated, not checked in.

---

## Tests

```bash
cd delphi
uv run python -m pytest tests/replay_harness/test_stages.py -q
RUN_CLJ_INTEGRATION=1 uv run python -m pytest \
  tests/replay_harness/test_stage_oracle_e2e.py -q

cd math
clojure -M:test          # includes test/stage_json_test.clj
```

`test_stages.py` and `stage_json_test.clj` pin the encoding contract on both
sides — key order, integer formatting, exact double round-trip over a 5 000-value
random sample, non-finite handling, named-matrix shape — plus the comparer's
canonicalization, tolerance classes and carve-outs.

`test_stage_oracle_e2e.py` runs the whole loop on the smallest public battery
case (`vw:single-cut`). The Clojure half is opt-in behind
`RUN_CLJ_INTEGRATION=1`; the Python half and a self-comparison negative control
run unconditionally. It asserts what the harness owes — both dumps exist, the
input digests match, every stage is present with an error report — and
deliberately asserts **no verdict**, because a numeric threshold there would
quietly become the gate the plan forbids.

Measured results on the public battery cases are recorded in
`cost-reduction/04-plans/P-030-R-ORACLE-implementation-notes.md`.
