# Engine stage oracles

**What this is.** A way to ask *where* two implementations of the Polis math
engine first disagree, instead of only being told that their final `math_main`
blobs differ.

Both replay drivers can dump the intermediate outputs of the tick pipeline —
one file per replay step, in a shared JSON shape — and a comparer diffs the two
dumps stage by stage and names the **first diverging stage**.

**What this is not.** A gate. Stage dumps are **diagnostics only**. The comparer
does emit per-key statuses — MATCH, DIVERGENT, CARVED, ENGINE_LOCAL — but the
accurate promise is narrower and stronger than "no verdicts": **`certify` never
consumes any of them**, and there is a test asserting it imports neither module.
The single PASS / APPROVED_DIFFERENCE / FAIL / INCONCLUSIVE authority remains
`polismath.replay.certify` on the final blob.

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

**Captures vs reconstructions.** Where an engine persists a node, the stage
function *captures* it. Where it does not, the stage function *reconstructs* the
node by calling that engine's own code on stored state — on the Python side that
is `mat` (the imputation block of `pca_project_dataframe`),
`pca.comment-projection` / `comment-extremity`, the base-cluster derived
matrices, the per-k silhouettes, `user-vote-counts`, and the R13 geometry
(`math_writer.derive_ptptstats`). A reconstruction is faithful to the engine's
code, but it is not evidence that the engine executed it during the tick.

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
  DIAGNOSTICS ONLY — certify never consumes these statuses; the final-blob
  gate is untouched (P-030 §2.3).
  A: …/clj-stages  (1 steps)
  B: …/py-stages   (1 steps)
  first diverging stage: none — every stage within tolerance
  step 0: first diverging stage = none
      [ENGINE_LOCAL] R13_ptpt_stats.participant-info-legacy: not graded
                     (present on b)
```

and with `--verbose`, every key including the ones that matched:

```
      [MATCH] R04_pca.pca (geom-legacy): 0/750 out of tolerance,
              max_abs=9.031e-08 max_rel=1.739e-06
              worst=pca.comment-projection.1.i:4
      [MATCH] R13_ptpt_stats.ptpt-stats (tight): 0/335 out of tolerance,
              max_abs=1.186e-07 max_rel=2.004e-06
              worst=ptpt-stats.i:66.centricness
```

Per key you get a **status** — `MATCH`, `DIVERGENT`, `CARVED`, `NONFINITE` or
`ENGINE_LOCAL` — plus how many numeric pairs were compared, how many fell
outside that key's tolerance, and the **max absolute and max relative error over
every compared pair** with the path that produced the largest one. `max_abs` /
`max_rel` are reported even when the key matches — on a matching key they are
the headroom, i.e. how close that stage came to its bound. Exit status is always
0; this tool does not fail a build.

**`NONFINITE` is not a pass.** Two engines *agreeing* on a `NaN` or an infinity
is not a divergence, but it is not clean data either. Such a key gets its own
status, always prints (even without `--verbose`), and qualifies the headline:
the report says how many non-finite values are present instead of "every stage
within tolerance". A non-finite in an *integer-typed* field — a vote, an id, a
count — is stronger still: it is a structural defect and a divergence, because
those fields are never non-finite. Matching invalid data is never hidden behind
a clean default.

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
| `R13_ptpt_stats` | `ptpt-stats` (the contract geometry), plus this engine's ungraded `participant-info-legacy` |

The **first diverging stage** is the earliest stage carrying a difference that
is outside its declared tolerance *and* outside the declared carve-outs.

It is the number to act on first. A difference at stage *N* feeds every later
stage, so a report showing eight divergent stages is usually one bug at the
earliest of them and seven consequences. Fix the first; re-run; look again.

It is a *suggested cause*, not a proof. The tool cannot show that the later
differences are only propagation, and it cannot rule out a second, independent
bug further down the pipeline — so keep reading the later stages after you fix
the first one. Correspondingly, a divergence at a *later* stage with every
earlier stage clean is a genuinely local bug in that stage's own arithmetic —
the most useful signal this tool produces.

Stage names are zero-padded (`R01…R13`) so that lexicographic key order in the
JSON *is* pipeline order.

### Tolerance classes

**Integer leaves never see a tolerance at all.** Typed IDs, counts, membership,
eligibility, vote meaning and watermarks — `id`, `pid`, `gid`, `tid`, `members`,
`n`, `n-cmts`, `n-votes`, `n-agree`, `n-success`, `n-trials`, `n-members`, the
`A`/`D`/`S` buckets, the k-smoother state, both timestamps, and every cell of
the two vote matrices — are compared as **exact integers, without ever being
converted to float**. This matters twice over: it stops a `geom` class on a
containing key from leaking onto the cluster `id` inside it (200 vs 201 is a
divergence, not a rounding), and it stops the float round trip from erasing a
one-unit difference above 2^53. A non-integral value, or a boolean, in an
integer-typed field is a structural defect, not a number. The two engines'
legitimate spellings of the same integer — Clojure `-1`, Python `-1.0` — agree.

The type is checked **before equality, on both sides**, so two *equally*
malformed operands cannot slip through: `True` vs `True` for a count, `"1"` vs
`"1"` for a tid, or a float-spelled cluster id `1.5` on both sides are all
divergences, not matches.

So is the **shape** — and the shape of everything below it. Each integer
position carries a declared **rank**: `("scalar",)` for a count,
`("array", "scalar")` for a list of ids, `("array", "array", "scalar")` for
`bid-to-pid`, the one legitimately two-dimensional integer key. The rank is
validated before any recursion and descends *with* it, so `n = {}` on both sides
is not a count that happens to agree (it is not a count), and `in-conv = [{}]` is
a malformed element rather than an unconstrained subtree. A null element of an
integer array is structural too — a top-level integer field may legitimately be
null (a nullable `n-votes`, a watermark on a votes tick, a moderation set before
any `mod-update`), but an array of ids holds ids.

The declaration is *key-scoped* where it has to be: `A`/`D`/`S` are
per-base-cluster bucket arrays in `votes-base` and per-group scalar totals in
`group-votes`, so a rule keyed on the field name alone gets one of them wrong.

The remaining, genuinely continuous leaves get one of two bounds:

| class | bound | applies to |
|---|---|---|
| `tight` | `abs(a-b) <= 1e-6 + 1e-4 · max(abs(a), abs(b))` | numeric statistics: `mat`, group-aware consensus, repness/consensus stats, comment priorities, the ptptstats geometry |
| `geom-legacy` | `abs(a-b) <= 1e-6 + 1e-2 · max(abs(a), abs(b))` | PCA-derived geometry: `pca`, `proj`, cluster centers, `bucket-dists`, silhouettes |

`tight` is the bound `P-022-G-engine-contract.md` proposes for finite numeric
statistics with zero outlier allowance. It is a **proposed diagnostic
reference**, not an admitted one: it has never been measured against the full
battery.

`geom-legacy` is named for what it is — the 1e-2 relative bound
`stepcompare.StepComparer` already defaults to for PCA-family paths, kept so
this tool's geometry verdicts line up with the comparer already in use. It is
**not** the proposed contract bound, and the documented ~1e-5 cross-engine noise
does not establish that 1e-2 is necessary: 1e-5 is two orders below this ceiling
and already inside `tight`'s relative coefficient at most scales. G permits a
higher ceiling only under scoped, independently measured reference jitter, which
nobody has measured here. So every `geom-legacy` key **also reports
`n_over_tight`** — how many of its values the stricter reference would reject —
and the bound is never tuned from candidate output. On the public battery
`n_over_tight` is **0 everywhere**: the looseness is currently carrying nothing.

Non-numeric leaves (booleans, strings, membership lists) are compared exactly
whatever a key's numeric class is, and a shape difference — a missing key, a
length mismatch, a duplicate identity — is always a divergence, never a
tolerance question.

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

2. **Identity keying, after validation.** Named matrices become
   `{rowlabel|collabel: cell}` and every tid-, pid- or bid-indexed array becomes
   a dict keyed by that id. Clojure emits `tids` in hash/insertion order and
   Python in sorted order; each blob is internally consistent, so array position
   is not semantics. Without this every run would report thousands of phantom
   differences.

   Two safeguards make that keying honest. Labels are **type-tagged**, so the
   integer `1` and the string `"1"` are different rows rather than colliding into
   one. And the shape is **validated first**: a matrix whose row count disagrees
   with its rownames, a ragged row, a duplicate row or column identity, an array
   whose length disagrees with `tids`, a cluster list with a duplicate id, a
   ptptstats row list with a duplicate or missing pid — each becomes a
   **structural error**, reported as such. It is never a synthesized number,
   because a number can be absorbed by a tolerance and a dropped cell can hide a
   real difference behind a clean MATCH.

3. **Coupled component sign, on declared axes.** Each principal component is
   oriented so its largest-magnitude entry is positive (first tid in canonical
   order on ties), and the arrays coupled to it — that component's
   `comment-projection` row, the matching `proj` column, and coordinate *k* of
   every base- and group-cluster center — are flipped with it. `pca.center` is a
   data mean and is never flipped. This is `crosslang.canonicalize_blob`'s rule,
   applied one level deeper.

   The axis orientation of `comment-projection` is **fixed by the producer and
   declared on the wire, never inferred from array lengths** — not in the
   comparer and not in the emitter. `pca_project_cmnts` always returns
   comments-by-components, so the Python emitter transposes *unconditionally*;
   a transpose conditioned on a shape comparison would emit the wrong array
   whenever a conversation has as many comments as components, while still
   declaring the right axes. Both emitters write `comps-by-tids` and say so; a
   dump that does not declare it is refused.

   The projection is **always at least two rows wide**, even when the PCA has a
   single component: in that rank-one case Clojure's `[pc1 pc2]` destructure
   truncates every comment to 0.0 on both components (Q16), and the Python port
   matches. So the emitted array has `max(len(comps), 2)` rows, and the comparer
   requires exactly that — an extra component row is a structural error, not a
   row to drop. The **padded row is compared like any other**: it takes a
   declared sign (`+1`, inert because it is all zeros) and its all-zero
   construction is checked, so a stray value there is a structural defect even
   when both engines carry it. It is never zipped away against a shorter list
   of component signs.

   When an emitter *cannot* verify a shape it refuses rather than guessing: it
   writes a `__structural_error__` sentinel, which the comparer lifts into a
   structural failure. A refusal is never graded as data.

---

## Carve-outs — differences that are expected

From P-030 §Q13/Q18 and the engines' own documented boundaries.

**The rule a carve-out must obey: it may never suppress a real difference.**
Each one below has a narrow, mechanical scope, and anything outside that scope is
reported normally. Only two carve-outs have a comparison rule at all; the rest
are notes for the reader and suppress nothing.

| id | scope | key | why it is expected |
|---|---|---|---|
| **C1** | `null` ↔ `[]` **only**, type-checked | `mod-in`, `mod-out`, `meta-tids` | Clojure emits `nil` until a `mod-update` has written the set; Python emits an empty set. That exact pair is suppressed — one side literally `None`, the other literally an empty JSON *list* — and nothing adjacent to it: `[1]` → `[2]`, `null` → `[2]`, `null` → `{}`, a missing key or a wrong type all report as divergences. Python's own blob boundary already mirrors the Clojure rule via `moderation_applied`, and the stage emitter applies the same gate, so this rarely fires. |
| **C2** | none — documented only | cluster ids / membership on warm chains | **Q13.** Warm-chain split-loop extraction order is knife-edge chaotic on tie-dense geometry: within-engine gaps at 2.5e-16 and 5.6e-17 against cross-engine projection noise at ~1e-5, eleven orders larger. Ledgered on `FP-912391ece7 / FP-c29173e1ba / FP-98dc728043`; carved in the *battery* by swapping `pc-revote-01` for `pc-revote-02`. |
| **C3** | numeric **values** only | `group-clusterings-silhouettes` | The two engines score with **different estimators**: Clojure's `clusters/silhouette` over `bucket-dists`, Python's `calculate_silhouette_sklearn` over the base-cluster centers. Different numbers are expected. The candidate inventory (*which* k were scored), the argmax they feed, the smoother state and group membership are all **outside** the exception and compared normally — a missing k is a coverage problem, not an estimator difference. |
| **C4** | none — documented only | `participant-info-legacy` | This engine's `participant_info` is a vote-correlation *report* statistic (`n_agree`/`n_disagree`/`n_pass`/`group_correlations`). It is not engine-contract surface and has no Clojure counterpart, so it rides along as an **engine-local** key, reported and never graded. It is **not** a waiver on `ptpt-stats`: see below. |
| **C5** | none — documented only | `mat`, all-NaN column | Python substitutes a 0.0 column mean where Clojure would divide by zero. Unreachable on a real conversation (every column carries at least one vote), so there is no comparison rule — if it were ever observed it would report as an ordinary divergence. |
| **C6** | none — documented only | cluster ids on coincident centers | **Q18.** `uniqify`'s exact-center-equality predicate is value-dependent ulp luck: `merge-clusters`' weighted mean preserves the input value for some doubles and rounds one ulp for others, so whether a merge *chain* over coincident singletons continues — and which id survives — depends on the 17th digit. Root cause of all 11 `carved-out` entries in `delphi/docs/divergences.json`. |

**There is no carve-out on `ptpt-stats`.** The engine contract names six
columnar geometric statistics — pid, gid, n-votes, centricness, coreness,
extremeness — and this engine already implements them in
`polismath.poller.math_writer.derive_ptptstats`, the production output adapter,
a verbatim port of `repness/participant-stats` pinned against a live Clojure
reference row. The stage reads *that*, with the raw `user-vote-counts` Clojure's
`n-votes` is taken from, and compares pid/gid/n-votes exactly and the three
geometric floats tolerantly. The absence of a Node reader for `math_ptptstats`
is not a reason to waive anything.

**Why C2 and C6 are not auto-suppressed.** They are chaotic, not addressable by
a path rule. A rule that hid "cluster ids differ" would also hide real
structural breakage in the lineage code, which is precisely what R7 exists to
catch. So they are reported, and this table is how a reader recognises the
fingerprint. P-030 §5/R7 says it directly: if a divergence's path pattern
matches a carved-out fingerprint on a mod-heavy warm chain, probe it with the
split-probe before spending a day on it — the correct action is to record it,
not to fix it.

---

## Incomplete or misaligned input

**A comparison that could not happen is not agreement.** Before diffing anything,
the comparer validates each recording and refuses to print a headline unless the
two are a complete, aligned, same-input pair. It checks that:

* both directories exist and carry a `stages-manifest.json`;
* the manifest's schema, `stage_order`, `engine`, axes declaration and `n_steps`
  are right, its inventory matches the files actually on disk, every file it
  names is present, and **each manifest row agrees with the document it names**
  on `tick` and `input_digest` — an inventory that disagrees with its own
  contents is not an inventory of this recording;
* every document carries a **typed** step identity, tick, `sha256:` digest and
  engine — a null tick or a null digest is missing evidence, not a value that
  happens to equal the other side's;
* every document declares a supported `vote_sign_convention` and the expected
  `comment_projection_axes`, and carries **all eleven stages, each with its full
  declared key inventory**. A stage present but mapped to `{}`, to `null`, or to
  an array is a hole in the recording, not a stage that happened to agree; an
  unknown stage or key is reported too;
* the digest is **64 lower-case hex digits**, not merely a `sha256:` prefix;
* each manifest row **names a real step file** — matching `step-NNN.stages.json`,
  unique, and present in the recording — and agrees with *that document* on all
  five identity fields (index, tick, digest, engine, polarity); every step file
  on disk appears in the manifest; and the recording declares **one** engine and
  **one** polarity throughout, matching the manifest's;
* a malformed document — not an object, unparseable JSON, a non-object `stages`
  container, a non-integer step, an unusable `engine` or `vote_sign_convention`
  (wrong type, unknown value, empty) — becomes a named input problem rather than
  an exception. Metadata is type- and enum-checked *before* it is used as a set
  member or a membership test, and every container is type-checked rather than
  tested for truthiness: a **non-empty** array in a stage position is truthy, and
  used to raise where the empty and null cases did not;
* a document that fails any of this is **not sent onward to be compared**. A
  usable step identity is not a licence to canonicalize a document validation has
  already rejected;
* step identities are unique, and the two sides are aligned **by step identity**,
  not by position — two recordings that both hold "one step" are not comparable
  if one is step 0 and the other step 7;
* the two engines were fed the same batch (equal `input_digest`) and reached the
  same `tick`.

Anything unmet lands in `input_problems`, sets `input_valid: false` and
`headline_withheld: true`, and the report prints `INCOMPLETE OR MISALIGNED
INPUT` with the reasons instead of a first-diverging-stage line. Two empty
directories now say so, rather than reporting that every stage is within
tolerance.

This is input validity, not a gate: an invalid input makes the *diagnostic*
unusable, and says nothing about any engine.

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
  (`Double/toString` on JDK 19+, `repr(float)` in Python). Exponent *formatting*
  differs across the two languages (`1.0E-5` vs `1e-05`) and does not matter —
  the comparison parses, it does not diff bytes.
* **Non-finite doubles** become the JSON strings `"NaN"`, `"Infinity"`,
  `"-Infinity"`; JSON has no literal for them and silently emitting one would
  make the file unparseable by a strict reader.
* **A named matrix** is `{"rownames": […], "colnames": […], "matrix": [[…]]}`
  with missing cells as `null` — a nil vote and a 0 vote are different meanings.
* **Sets** become sorted arrays; keywords become their bare name.
* **`comment_projection_axes`** declares the orientation of
  `pca.comment-projection` (`comps-by-tids` on both engines). A dump without it
  is refused rather than guessed at.
* **`input_digest`** is `sha256` over the step's fed batch in *export/Delphi*
  sign convention (`{"mods": [[tid, is_meta, mod, modified], …], "votes":
  [[pid, tid, sign, created], …]}`, canonical JSON, fed order). Taking it in
  export convention is what makes the two engines' digests comparable despite
  the raw-DB flip Clojure applies before `conv-update`. **If the digests differ,
  stop**: the engines were not fed the same batch and every other number in the
  report is meaningless.

### What the encoding is and is not lossless for

**Verified.** Finite `binary64` survives the wire in both directions,
bit-for-bit: 265 values Clojure→Python and 265 Python→Clojure, including signed
zero, the minimum subnormal, the maximum finite value and adjacent representable
neighbours, plus a 5 000-value random-bit sample within each runtime. Ordinary
signed-64-bit JSON integers are preserved on output by both emitters, and the
comparer compares them as integers rather than through a float.

**Not claimed.** This is not a general, lossless serializer for arbitrary engine
values, and the following are deliberate, tested limits of the admitted value
domain rather than defects to be discovered later:

* map keys are **stringified**, so integer `1` and string `"1"` collapse into one
  key on both engines;
* the JSON string `"NaN"` and the non-finite token for NaN are
  **indistinguishable** on the wire — the same is true of the two infinities;
* Clojure `Ratio` (e.g. `1/3`) is projected to the nearest double
  (`0.3333333333333333`), and keyword / set / type identity is projected away;
* a pandas `NaN` cell in a vote matrix means **missing vote** and becomes `null`,
  not a non-finite token — a field-level rule, not a number rule;
* the JSON is canonical *within* each engine, but the two engines' bytes are not
  identical, because their decimal spellings differ. Numeric round-trip
  equivalence is the claim; byte equality is not.

If exact source-type reconstruction is ever needed, rationals and non-finite
values will have to be tagged rather than projected.

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

The `test_f1_…` through `test_f6_…` group is the regression set for the six
findings in `cost-reduction/04-plans/P-030-R-ORACLE-astra-review.md`, one
behaviour per name: the contract geometry at R13, C1's narrow scope, integer
identities never seeing a tolerance, malformed matrices and undeclared axes
becoming structural errors, incomplete input withholding the headline, and the
non-finite tokens surviving polarity conversion.

`test_stage_oracle_e2e.py` runs the whole loop on the smallest public battery
case (`vw:single-cut`). The Clojure half is opt-in behind
`RUN_CLJ_INTEGRATION=1`; the Python half and a self-comparison negative control
run unconditionally. It asserts what the harness owes — both dumps exist, the
input digests match, every stage is present with an error report — and
deliberately asserts **no verdict**, because a numeric threshold there would
quietly become the gate the plan forbids.

Measured results on the public battery cases are recorded in
`cost-reduction/04-plans/P-030-R-ORACLE-implementation-notes.md`.
