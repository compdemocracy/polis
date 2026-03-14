# Journal: Fixing Python-Clojure Discrepancies

This is the ongoing tracking document for the TDD fix process described in
`PLAN_DISCREPANCY_FIXES.md`. It serves as the single source of truth for
our work, while commit messages and PR descriptions serve reviewers.

---

## Initial Baseline (2026-02-25)

### Branch: `series-of-fixes` (forked from `origin/kmeans_analysis_docs`)

### Test Results

**`test_legacy_clojure_regression.py`** (2 datasets: vw, biodiversity):
- 2 passed (`test_pca_components_match_clojure` × 2)
- 6 xfailed:
  - `test_basic_outputs` × 2 — D9/D5/D7: empty `comment_repness`
  - `test_group_clustering` × 2 — D2/D3: wrong participant threshold, missing k-smoother
  - `test_comment_priorities` × 2 — D12: not implemented

**Full test suite** (`tests/` except `test_batch_id.py`):
- 185 passed, 11 failed, 3 skipped, 6 xfailed
- Pre-existing failures (not caused by this work, inherited from stacked PRs):
  - `test_clusters.py::test_init_clusters` — `init_clusters()` doesn't populate members when k > n_points
  - `test_conversation.py::test_recompute` — clustering threshold (7.2) filters out all 20 participants in synthetic data
  - `test_conversation.py::test_data_persistence` — same threshold issue
  - `test_datasets.py` × 4 — DatasetInfo API changed (added `has_cold_start_blob`), tests use old 8-arg constructor
  - `test_edge_cases.py::test_insufficient_data_for_pca` — repness returns empty dict for no-group case
  - `test_repness_smoke.py` × 2 — repness empty due to D9/D5/D7 (the very discrepancies we're fixing)
- **Note**: CI runs on `main` which has different code — these failures are specific to this stacked branch.
  4 of them were already known (documented in MEMORY.md under "Known pre-existing test failures in #2393").

### Datasets Available

| Dataset | Votes | Has cold-start Clojure blob? |
|---------|------:|-----|
| vw | 4,684 | Yes |
| biodiversity | 29,803 | Yes |
| *(5 private datasets)* | 91K–1M | **No** (need prodclone DB) |

### Clojure Blob Structure (vw example)

Repness entry keys: `tid`, `n-agree`, `p-test`, `repness-test`, `n-success`,
`repful-for`, `n-trials`, `repness`, `best-agree`, `p-success`

Consensus structure: `{agree: [{tid, n-success, n-trials, p-success, p-test}], disagree: [...]}`

Comment priorities: `{tid: priority_value}` — 125 entries for vw

In-conv: list of 67 participant IDs (vw)

---

## PR 0: Test Infrastructure (complete)

### What was done
- Created `tests/test_discrepancy_fixes.py` with per-discrepancy test classes
- Created this journal
- Documented initial baseline

### Test results for `test_discrepancy_fixes.py`

After rebase onto updated `origin/kmeans_analysis_docs`:

```
7 passed, 19 skipped, 39 xfailed, 10 xpassed (with --include-local, 7 datasets)
```

- **7 passed**: Clojure formula sanity checks (prop_test, repness metric product, repful rat>rdt) + Clojure blob consistency checks (pat values)
- **19 skipped**: D15 moderation (no moderated comments), incomplete Clojure blobs, engage duplicate files
- **39 xfailed**: Discrepancy tests correctly fail (D2-D12 constants, formulas, and real-data comparisons)
- **10 xpassed** (all `strict=False`, so green):
  - D2 in-conv × 2 on vw — small dataset where old/new thresholds coincide
  - D6 two_prop_test × 1 — pseudocount difference too small to matter for this test case
  - D9 repness_not_empty × 7 on all datasets — `comment_repness` list is populated (all
    (group, comment) pairs) even with wrong thresholds; only `group_repness` selection is
    affected. **TODO**: tighten this test when fixing D9 to check correct *number* of
    representative comments, not just non-emptiness

### Design decisions
- All tests that verify targets not yet implemented are marked `@pytest.mark.xfail` with the discrepancy ID in the reason
- `strict=False` on D2 because vw (small) coincidentally matches while biodiversity (larger) does not
- D5 `test_clojure_pat_values_consistent_with_formula` is a sanity check that verifies Clojure data matches the documented formula — it's NOT xfailed because it doesn't test Python code
- D6 `test_two_prop_test_with_pseudocounts` is xfailed (Python lacks pseudocounts)
- D15 uses `pytest.skip` when dataset has no moderated comments

### Test classes summary

| Class | Discrepancy | Tests | xfail? |
|-------|-------------|-------|--------|
| `TestD2InConvThreshold` | D2 | 2 (per dataset) | xfail(strict=False) |
| `TestD4Pseudocount` | D4 | 2 (1 constant + 1 per dataset) | both xfail |
| `TestD5ProportionTest` | D5 | 2 (1 formula + 1 sanity per dataset) | formula xfail, sanity passes |
| `TestD6TwoPropTest` | D6 | 1 | xfail |
| `TestD7RepnessMetric` | D7 | 1 | xfail |
| `TestD8FinalizeStats` | D8 | 1 | xfail |
| `TestD9ZScoreThresholds` | D9 | 3 (2 constants + 1 per dataset) | all xfail |
| `TestD10RepCommentSelection` | D10 | 1 (per dataset) | xfail |
| `TestD11ConsensusSelection` | D11 | 1 (per dataset) | xfail |
| `TestD12CommentPriorities` | D12 | 1 (per dataset) | xfail |
| `TestD15ModerationHandling` | D15 | 1 (per dataset) | skipped (no mod-out data) |
| `TestSyntheticEdgeCases` | multiple | 5 | 2 xfail (D4, D9), 3 pass |

---

## PR 1: Fix D2 — In-Conv Participant Threshold (blocked on Clojure blob regeneration)

### TDD steps
1. **Baseline (public only)**: 3 failed (2 D2 + 1 DynamoDB), 205 passed, 4 skipped, 20 xfailed, 3 xpassed
2. **Red**: Removed xfail from `TestD2InConvThreshold` — biodiversity fails (Python=428, Clojure=441, threshold 8.8 vs 7)
3. **Fix**: Changed `threshold = 7 + sqrt(n_cmts) * 0.1` → `threshold = min(7, n_cmts)` in `conversation.py:1270`
4. **Green (public only)**: All 4 D2 tests pass (vw + biodiversity × 2 tests each)
5. **Full suite (public only)**: 1 failed (DynamoDB only), 207 passed — but golden snapshots were re-recorded for biodiversity without proper verification
6. **Full suite (with private datasets)**: 15 failed, 6 errors — regression tests fail for private datasets (golden snapshots stale), `engage` dataset has duplicate vote files
7. Investigated regression failures — all caused by expected threshold change. Re-recorded after verification.
8. **Blocker**: 3 private datasets have incomplete Clojure blobs (no in-conv data). D2 tests fail on those — not a code issue. Delegated blob regeneration to separate session.

### Investigation of regression failures
- Private dataset golden snapshots were never committed (unstaged in .local repo) — reverted automatically
- biodiversity: re-recorded after verifying D2 in-conv set matches Clojure exactly (428→441 participants)
- Private datasets: threshold dropped significantly for large conversations:
  - bg2050 (7753 comments): old threshold ≈ 15.8, new threshold = 7 → 6609/7890 qualify (was fewer)
  - This is the expected and correct effect of the D2 fix
- **Gotcha**: `--datasets <name>` alone won't find private datasets — must also pass `--include-local`!
  Without it, private datasets are silently skipped (shown as `[NOTSET]`).
- Golden snapshots re-recorded for FLI, bg2018, pakistan, bg2050 after verifying all regression
  failures are downstream of the expected threshold change. Committed in `.local` repo on
  branch `series-of-fixes`.

### Incomplete Clojure blobs (RESOLVED)

3 private datasets have incomplete Clojure cold-start blobs (4 keys instead of 23):
- Missing `in-conv`, `repness`, `consensus`, `comment-priorities`, etc.
- Root cause: the Clojure math worker relies on incremental processing and cannot
  analyse these large conversations in a single cold-start pass.
- The 4 remaining datasets (vw, biodiversity, FLI, bg2018) have complete cold-start blobs (23 keys)

**Resolution (session 4)**: Instead of regenerating blobs, we now test against both
incremental and cold-start blob types. `get_blob_variants()` discovers which blob types
have meaningful content per dataset (via `_is_blob_filled()`). Tests on datasets with
empty cold-start blobs only run against the incremental blob. D2 in-conv tests on
incremental blobs are xfailed (see session 4 notes). No blob regeneration needed.

### What was NOT needed (revised — see D2c/D2d below)
- ~~`raw_rating_mat` vs `rating_mat` — not needed~~ **WRONG**: See D2c below, this IS needed.
- Greedy fallback / monotonic persistence — not needed for cold-start parity, but monotonicity tests needed for future-proofing (see D2d).

### D2c: Vote count source — raw vs filtered matrix (discovered in session 3)

Deep investigation of Clojure vs Python revealed a **structural discrepancy** in how
votes are counted for the in-conv threshold, independent of delta vs full processing:

| Aspect | Clojure | Python (current) |
|--------|---------|-----------------|
| Vote counts per participant | From `raw-rating-mat` (conversation.clj:217-225) — includes votes on moderated-out comments | From `self.rating_mat` (conversation.py:1226/1244) — excludes moderated-out columns |
| `n_cmts` (threshold cap) | From `rating-mat` (conversation.clj:214-215) — columns zeroed but still present, so count includes moderated-out | From `self.rating_mat` (conversation.py:1268) — moderated-out columns removed entirely |

Key insight: Clojure's `zero-out-columns` (named_matrix.clj:214-228) sets moderated-out
column values to 0 but **keeps the columns** in `rating-mat`. Python's `_apply_moderation`
(conversation.py:308) **removes columns entirely**. This means both `user-vote-counts`
and `n-cmts` differ between implementations.

**Fix**: Both `_compute_user_vote_counts` and `n_cmts` must use `self.raw_rating_mat`.
Two xfail unit tests planned (vote count source + n_cmts threshold).

### D2d: In-conv monotonicity — full recompute vs persistence (discovered in session 3)

Investigated whether Python needs to persist in-conv to DynamoDB (like Clojure persists to
`math_main`). Finding: **no, full recompute is better**.

Clojure persists in-conv (conv_man.clj:55) because it uses delta vote processing. Python
rebuilds `raw_rating_mat` from all votes every time. Since votes are immutable in PostgreSQL
(can be updated, never deleted), a participant's vote count never decreases → monotonicity
is a free consequence of full recompute from `raw_rating_mat`.

**Decision**: No DynamoDB persistence. Instead, 6 tests (T1-T6) guard the monotonicity
invariant, each documenting that switching to delta processing would require adding
persistence. See plan PR 1bis for test details. Ref: compdemocracy/polis#2358.

### D2b: Base-cluster sort order (added from Copilot review)

Copilot flagged that Python sorts base clusters by size (descending) and reassigns IDs,
while Clojure uses `(sort-by :id ...)` which preserves k-means' original cluster IDs.
The size-sort changes the encounter order of base-cluster centers fed into group-level
k-means (which uses first-k-distinct initialization), potentially diverging from Clojure.

**Fix**: Removed size-sort and ID reassignment; now sort by k-means ID (ascending),
matching Clojure's `sort-by :id`.

### Test results for PR 1

```
17 passed, 16 skipped, 31 xfailed, 7 xpassed, 4 errors (with --include-local, 7 datasets)
```

- **17 passed**: D2 tests pass on 4 datasets with complete blobs (8 tests) + formula sanity checks + blob consistency
- **16 skipped**: D2 skipped on 3 datasets with incomplete Clojure blobs + D15 moderation + engage errors
- **31 xfailed**: Remaining discrepancy tests (D4-D12)
- **7 xpassed** (all `strict=False`, so green):
  - D6 two_prop_test × 1 — pseudocount difference too small for this test case
  - D9 repness_not_empty × 6 — test too weak (checks non-empty, not correct count)
- **4 errors**: engage dataset has duplicate vote files (pre-existing data issue)

### Golden snapshot re-recording (BLOCKED)

After D2b fix, regression tests fail on all datasets except vw (as expected — sort order
change cascades to different cluster assignments). biodiversity was re-recorded and verified.
Private datasets (FLI, bg2018, bg2050, pakistan) need re-recording but the recorder crashes
on `engage` (pre-existing duplicate vote files) before reaching the others. Need to record
them individually, but **blocked on fixes to PRs earlier in the stack** (#2393, #2397).
Will re-record after those are resolved and rebased.

### What's Next

1. **PR 1 (D2c)**: Implement the vote count source fix — switch `_compute_user_vote_counts`
   and `n_cmts` to use `self.raw_rating_mat`. Write xfail tests first, then fix, then verify.
2. **PR 1bis (D2d)**: Write the 6 monotonicity tests (T1-T6). These should pass immediately
   after D2c is fixed (full recompute + raw_rating_mat = monotonicity for free). Add the
   code comment block and PR description documenting the design decision.
3. **PR 2 — Fix D4 (Pseudocount)**: Next in pipeline order after D2 is fully resolved.

---

## Session Log

### Session 1 (2026-02-25)

- Assessed codebase: read test infra, repness module, conversation module, Clojure blob structure
- Created `tests/test_discrepancy_fixes.py` (30 tests, 12 classes)
- Created this journal with initial baseline
- Ran baseline: `test_legacy_clojure_regression.py` → 2 passed, 6 xfailed
- Ran full suite → 185 passed, 11 failed (pre-existing), 3 skipped, 6 xfailed
- Investigated 11 pre-existing failures: inherited from stacked PRs (DatasetInfo API change, threshold issues, D9/D5/D7 repness)
- Rebased onto updated `origin/kmeans_analysis_docs` after PR stack rebase
- Committed and created PR #2401 (`[Clj parity PR 0]`)

### Session 2 (2026-02-26)

- Rebased after stack update (base tests tightened, some xpassed→xfailed)
- Updated PR title convention: `[Clj parity PR N]` prefix for reviewer clarity
- Redacted private dataset names from git history across the full stack:
  - `SESSION_HANDOFF_KMEANS.md` in `kmeans_clustering_tooling` (amended deep commit via `GIT_SEQUENCE_EDITOR` rebase)
  - `PLAN_DISCREPANCY_FIXES.md` in `kmeans_analysis_docs` (amended tip)
  - `CLJ-PARITY-FIXES-JOURNAL.md` in `series-of-fixes` (amended tip)
  - Force-pushed all three branches, rebased the chain
- Tests unchanged: 5 passed, 2 skipped, 18 xfailed, 5 xpassed
- Renamed journal and plan to `CLJ-PARITY-FIXES-*.md`, amended introducing commits, rebased chain
- Set up private data repo infrastructure:
  - Pushed data to bare repo at `~/polis/github/real_data_private`
  - Created `link-to-polis-worktree.sh` for per-worktree clones with post-checkout branch sync
  - Linked `.local` to this worktree, created `series-of-fixes` branch in private repo
- Created `CLAUDE.local.md` (via stow) and `CLAUDE.md` in private data repo
- D2 fix (TDD):
  - Baseline (public only): 205 passed, 3 failed (2 D2 + 1 DynamoDB)
  - Red: removed xfail from D2 tests, biodiversity fails (Python=428, Clojure=441)
  - Fix: `threshold = min(7, n_cmts)` in `conversation.py:1270`
  - Green: D2 tests pass on vw + biodiversity
  - Full suite with private datasets (14 min): regression failures on all private datasets (expected — threshold change cascades to clustering)
  - Investigated: all failures are downstream of threshold change, verified correct
  - Re-recorded golden snapshots for biodiversity + 4 private datasets after verification
  - Discovered 3 private datasets have incomplete Clojure blobs (4 keys instead of 23) — delegated regeneration to separate session
  - Committed and pushed D2 fix (`df2d013ec`)

### Session 3 (2026-03-04)

- Deep investigation of in-conv vote counting: compared Clojure `user-vote-counts`
  (conversation.clj:217-225, uses `raw-rating-mat`) vs Python `_compute_user_vote_counts`
  (conversation.py:1226, uses `self.rating_mat`)
- Discovered D2c: structural discrepancy in both vote count source AND `n_cmts` — Clojure's
  `zero-out-columns` keeps moderated-out columns (zeroed), Python's `_apply_moderation`
  removes them entirely. Both vote counts and threshold cap differ.
- Investigated whether to persist in-conv to DynamoDB (like Clojure does to `math_main`).
  Found: Clojure persists because it uses delta vote processing. Python does full recompute
  → monotonicity is free. No persistence needed.
- Verified Clojure persistence path: `prep-main` (conv_man.clj:55) writes `:in-conv`,
  `restructure-json-conv` (conv_man.clj:182) restores it on restart.
- Updated plan: added D2c (vote count source, 2 xfail tests) and D2d (monotonicity, 6 tests
  guarding against future delta-processing refactor). Ref: compdemocracy/polis#2358.
- Corrected earlier journal entry that said `raw_rating_mat` was "not needed" — it IS needed.
- Added terminology rule to CLAUDE.local.md: always say "moderated-out" or "moderated-in",
  never just "moderated".
- Committed plan update (`f2bf77c38`)

### Session 4 (2026-03-10)

- **Dual-blob test infrastructure** (committed on `jc/series-of-fixes`, #2420):
  - Extended `get_dataset_files()` with `blob_type` parameter (explicit `'incremental'` or `'cold_start'`)
  - Added `get_blob_variants()` to discover which blob types are available per dataset,
    filtering out empty/unfilled blobs via `_is_blob_filled()` (checks for PCA data or
    non-empty base-clusters)
  - Extended `@pytest.mark.use_discovered_datasets` with optional `use_blobs=True` parameter
    to parametrize tests with composite `dataset-blob_type` IDs (e.g., `biodiversity-incremental`)
  - Added `parse_dataset_blob_id()` in conftest for splitting composite IDs
  - Applied to `test_legacy_clojure_regression.py`, `test_discrepancy_fixes.py`, and
    `test_legacy_repness_comparison.py`
  - Conversation computation shared across blob variants via `_CONV_CACHE` (keyed by dataset
    name) to avoid redundant recomputation

- **D2 incremental xfail with rationale** (committed on `jc/clj-parity-d2-fix`, #2421):
  - D2 in-conv tests on incremental blobs are xfailed with inline comments explaining why:
    incremental blobs were built progressively as votes trickled in, so the threshold
    `min(7, n_cmts)` was evaluated at each iteration with a smaller `n_cmts`, admitting
    a few extra participants (1–2) during earlier iterations. Very large conversations
    have empty cold-start blobs because the Clojure math worker relies on incremental
    processing — it cannot analyse the whole conversation in a single cold-start pass.
  - Matching incremental exactly would require simulating the progressive threshold — tracked
    as future work under Replay Infrastructure (PRs A/B/C in the plan)

- **Golden snapshots re-recorded** for all public + private datasets, 5 stale xfail markers removed
- **Final test results**: 245 passed, 5 skipped, 36 xfailed, 0 failures, 0 xpassed
- Updated PR #2421 description with incremental vs cold-start explanation
- Local handoff file created at `delphi/docs/HANDOFF_D2_INCREMENTAL_IN_CONV.md` (untracked)
  for future investigation of how much in-conv sets differ between blob types

### Session 5 (2026-03-11)

- **D2c fix**: Switched `_compute_user_vote_counts` and `_get_in_conv_participants` to use
  `self.raw_rating_mat` instead of `self.rating_mat`. Both vote counts and `n_cmts` now
  include votes on moderated-out comments, matching Clojure's `user-vote-counts`
  (conversation.clj:217-225) and `n-cmts` (conversation.clj:214-215).
- **D2c tests** (3 in `TestD2cVoteCountSource`):
  - `test_vote_count_includes_moderated_out_votes`: 10 comments, 3 moderated-out, count=10
  - `test_n_cmts_includes_moderated_out_comments`: verifies threshold uses raw column count,
    not filtered; also tests that a participant with 6 raw votes is correctly excluded
  - `test_participant_stays_in_conv_after_moderation`: the critical scenario — participant
    with 8 votes stays in-conv when 3 comments moderated-out (filtered count drops to 5)
- **D2d monotonicity tests** (5 in `TestD2dInConvMonotonicity`):
  - T1: basic monotonicity across batch updates
  - T2: survives moderation-out
  - T3: worker restart + moderation (key delta-processing guard)
  - T4: worker restart, moderation, no new votes
  - T5: mixed participants with moderation
  - All pass for free with D2c fix (full recompute from `raw_rating_mat`)
- **TDD discipline**: wrote tests first (D2c xfail, D2d no xfail), confirmed D2c red (3
  xfailed) and D2d red (T2-T5 failed, T1 passed), applied fix, confirmed all green.
- **Full test suite**: 253 passed, 5 skipped, 36 xfailed, 0 failures (+8 from session 4)
- **No regressions** on public datasets
- Added code comments on `_get_in_conv_participants` documenting the monotonicity design
  decision and delta-processing caveat (ref: #2358)
- Updated plan: D2, D2b, D2c, D2d all marked DONE; PR 1bis merged into PR 1
- Updated PR #2421 description with D2c/D2d sections

### What's Next

1. **PR 3 — Fix D9 (Z-score thresholds)**: Switch from two-tailed to one-tailed z-scores.
2. Regression test performance investigation (see `HANDOFF_REGRESSION_TEST_PERF.md`)

---

## PR 2: Fix D4 — Pseudocount Formula

### TDD steps
1. **Baseline**: 25 passed, 3 skipped, 28 xfailed (discrepancy tests)
2. **Red**: Removed xfail from 3 D4 tests → 6 failures (constant check, pa values × 4 datasets, synthetic)
3. **Fix**: `PSEUDO_COUNT = 1.5` → `2.0` in `repness.py`
4. **Green**: All 6 D4 tests pass
5. **Full suite**: 258 passed, 3 skipped, 30 xfailed, 0 failures (public datasets)
6. **Private datasets**: 60 passed, 6 skipped, 53 xfailed (discrepancy tests with --include-local)
7. Re-recorded golden snapshots for all 7 datasets

### Changes
- `repness.py`: `PSEUDO_COUNT = 2.0`, updated comment to reference Beta(2,2) prior
- `test_discrepancy_fixes.py`: removed xfail from 3 D4 tests
- `test_repness_unit.py`, `test_old_format_repness.py`: import `PSEUDO_COUNT` instead of hardcoding 1.5
- `simplified_repness_test.py`: updated hardcoded constant

### Side finding: regression test performance
Large private datasets take 1-5 minutes per regression test due to:
- Benchmark mode running pipeline 3× (n_runs=3)
- O(participants × comments) per-participant loop in `_compute_participant_info_optimized`
- Intermediate stages computed redundantly

Fitted model: `t ≈ 1.66 + 3.87e-5 × votes + 9.90e-7 × (ptpts × cmts)` (R²=0.9995).
Detailed analysis in `HANDOFF_REGRESSION_TEST_PERF.md` for a future session.

### Session 6 (2026-03-11)

- Created branch `jc/clj-parity-d4-fix` stacked on `jc/clj-parity-d2-fix`
- D4 fix (TDD): red (6 tests failed) → fix PSEUDO_COUNT → green (all 6 pass)
- Fixed 2 unit tests that hardcoded old pseudocount value (used import instead)
- Re-recorded golden snapshots for all 7 datasets (public + private)
- Investigated regression test performance (engage 317s, pakistan 179s) — confirmed
  consistent with O(votes + ptpts×cmts) complexity, not a regression from D4
- Created `HANDOFF_REGRESSION_TEST_PERF.md` for future optimization work
- Pushed branch, created PR

### What's Next

1. **PR 4 — Fix D5 (Proportion test)**: Change `prop_test` from standard z-test to Clojure formula.
2. Regression test performance optimization (separate session)

---

## PR 4: Fix D5 — Proportion Test Formula

### TDD steps
1. **Baseline**: 1 failed (pakistan-incremental D2, pre-existing), 91 passed, 5 skipped, 129 xfailed, 2 xpassed
2. **Red**: Wrote tests calling `prop_test(succ, n)` (new signature) → 3 failures (TypeError: missing p0 arg)
3. **Fix**: Replaced `prop_test(p, n, p0)` → `prop_test(succ, n)` with Clojure formula:
   `2 * sqrt(n+1) * ((succ+1)/(n+1) - 0.5)` (stats.clj:10-15)
4. **Green**: All 7 D5 tests pass (formula checks + sanity checks + edge cases)
5. **Full suite (public)**: 4 regression failures (expected — pat/pdt/metric values changed)
6. **Investigation**: All diffs are in `pat`, `pdt`, `agree_metric`, `disagree_metric` — direct
   downstream of the prop_test formula change. No unexpected field changes.
7. **Re-recorded golden snapshots** for all 7 datasets (public + private)
8. **Full suite (with --include-local)**: 1 failed (pakistan-incremental D2, pre-existing),
   91 passed, 5 skipped, 129 xfailed, 2 xpassed — no regressions from D5

### Changes
- `repness.py`: `prop_test(p, n, p0)` → `prop_test(succ, n)` with Clojure formula
  `2 * sqrt(n+1) * ((succ+1)/(n+1) - 0.5)`. Added detailed docstring explaining
  the Wilson-score-like regularization and the separate pseudocount from pa/pd.
- `repness.py`: `prop_test_vectorized(p, n, p0)` → `prop_test_vectorized(succ, n)`
- `repness.py`: Updated callers in `comment_stats()` and `compute_group_comment_stats_df()`
  to pass raw counts `(na, ns)` / `(nd, ns)` instead of `(pa, ns, 0.5)` / `(pd, ns, 0.5)`
- `test_discrepancy_fixes.py`: Removed xfail from D5 formula test, added comprehensive
  test cases (8 input pairs including boundary conditions) and edge case test
- `test_repness_unit.py`: Updated `test_prop_test` and vectorized tests for new signature
- `test_old_format_repness.py`: Updated `test_prop_test` for new signature

### Key insight: two separate pseudocounts
The Clojure `prop-test` has its own built-in +1 pseudocount (Laplace smoothing / Beta(1,1)),
separate from the PSEUDO_COUNT=2.0 used for pa/pd (Beta(2,2)). The prop_test takes raw
success counts, not pre-smoothed probabilities. This means:
- `pa = (na + 1) / (ns + 2)` — Beta(2,2) prior for probability estimation
- `pat = 2 * sqrt(ns+1) * ((na+1)/(ns+1) - 0.5)` — Beta(1,1) prior for significance testing

These are conceptually different: the probability is for ranking, the z-score is for
significance filtering. Using different priors is intentional.

### Session 7 (2026-03-13)

- Created branch `jc/clj-parity-d5-prop-test` on top of `jc/clj-parity-d9-fix`
- Read Clojure source (stats.clj:10-15, repness.clj:74-75) to verify formula
- TDD cycle: red (3 TypeError failures) → fix → green (7 pass, 4 xfail)
- Full suite: 4 regression failures, all in pat/pdt/metric fields (expected)
- Re-recorded golden snapshots for all 7 datasets
- Final validation: 19/19 regression tests pass, 1 pre-existing failure (pakistan-incremental D2)

### What's Next

1. **PR 6 — Fix D7 (Repness metric)**: Change formula from `pa * (|pat| + |rat|)` to
   `ra * rat * pa * pat` (Clojure product formula).

---

## PR 5: Fix D6 — Two-Proportion Test Pseudocounts

### TDD steps
1. **Baseline**: 1 failed (pakistan-incremental D2, pre-existing), 102 passed, 5 skipped, 143 xfailed, 2 xpassed
2. **Red**: Rewrote `TestD6TwoPropTest` with new signature `two_prop_test(succ_in, succ_out, pop_in, pop_out)`
   and correct Clojure formula → 3 failures (TypeError: old function expects proportions)
3. **Fix**: Replaced both `two_prop_test` and `two_prop_test_vectorized` with Clojure formula:
   add +1 to all 4 inputs (stats.clj:20), compute `pi1=(s+1)/(p+1)`, standard pooled z-test
4. **Green**: All 3 D6 formula tests pass, 4 blob comparison tests xfail (depend on D10)
5. **Full suite**: 4 regression failures, all in `rat`/`rdt`/`agree_metric`/`disagree_metric` — direct
   downstream of the formula change. No unexpected fields affected.
6. **Re-recorded golden snapshots** for all 7 datasets (public + private)
7. **Final**: 1 failed (pakistan-incremental D2, pre-existing), 102 passed, 5 skipped, 143 xfailed, 2 xpassed

### Changes
- `repness.py`: `two_prop_test(p1, n1, p2, n2)` → `two_prop_test(succ_in, succ_out, pop_in, pop_out)`
  with +1 pseudocount on all 4 inputs, matching Clojure's `(map inc ...)` (stats.clj:20)
- `repness.py`: `two_prop_test_vectorized` — same signature change
- `repness.py`: Updated callers in `add_comparative_stats` and `compute_group_comment_stats_df`
  to pass raw counts `(na, other_na, ns, other_ns)` instead of `(pa, ns, other_pa, other_ns)`
- `test_discrepancy_fixes.py`: Rewrote `TestD6TwoPropTest` with correct formula, 7 test cases,
  edge cases, and regularization effect test
- `test_repness_unit.py`: Updated `test_two_prop_test`, `test_two_prop_test_vectorized`,
  `test_two_prop_test_vectorized_edge_cases` for new signature
- `test_old_format_repness.py`: Updated `test_two_prop_test` for new signature

### Key insight: existing test had wrong expected formula
The pre-existing D6 test computed expected values using `(succ+1)/(n+2)` — as if two pseudocounts
were added to the denominator. But Clojure's `(map inc ...)` adds +1 to each value independently,
giving `(succ+1)/(pop+1)`. The formula is a standard pooled z-test on the pseudocount-adjusted values,
not a Beta distribution posterior.

### Session 8 (2026-03-13)

- Created branch `jc/clj-parity-d6-two-prop-test` on top of `jc/clj-parity-d5-prop-test`
- Read Clojure source (stats.clj:18-33, repness.clj:97-100) to verify formula and call sites
- Discovered the existing D6 test had wrong expected formula — fixed
- TDD cycle: red (3 TypeError failures) → fix → green (3 pass, 4 xfail)
- Updated all callers: both scalar (`add_comparative_stats`) and vectorized
  (`compute_group_comment_stats_df`) now pass raw counts
- Full suite: 4 regression failures, all in rat/rdt/metric fields (expected)
- Re-recorded golden snapshots for all 7 datasets
- Final validation: 102 passed, 1 pre-existing failure (pakistan-incremental D2)

### What's Next

1. **PR 6 — Fix D7 (Repness metric)**: Change from `pa * (|pat| + |rat|)` to `ra * rat * pa * pat`.

---

## PR 6: Fix D7 — Repness Metric Formula

### TDD steps
1. **Baseline**: 1 failed (pakistan-incremental D2, pre-existing), 102 passed, 5 skipped, 143 xfailed, 2 xpassed
2. **Red**: Wrote 5 new D7 tests (agree product, disagree product, zero-kills-metric, sign preservation,
   multiple known values) + updated unit tests in test_repness_unit.py and test_old_format_repness.py → 7 failures
3. **Fix**: Changed both scalar `repness_metric()` and vectorized `compute_group_comment_stats_df()`:
   - agree_metric: `pa * (|pat| + |rat|)` → `ra * rat * pa * pat`
   - disagree_metric: `(1 - pd) * (|pdt| + |rdt|)` → `rd * rdt * pd * pdt`
4. **Green**: All 5 D7 formula tests pass + 4 blob comparison xfailed (D10 selection differs)
5. **Full suite (public)**: 4 regression failures, all in `repness.group_repness` fields (expected —
   metric reranking changes which comments are selected)
6. **Re-recorded golden snapshots** for all 7 datasets (public + private)
7. **Final (with --include-local)**: 1 failed (pakistan-incremental D2, pre-existing), 98 passed,
   5 skipped, 131 xfailed, 3 xpassed — 19/19 regression tests pass

### Changes
- `repness.py`: `repness_metric()` changed from `p_factor * (abs(p_test) + abs(r_test))` to
  `r * r_test * p * p_test`. The old disagree formula was doubly wrong: used `(1-pd)` instead of
  `pd`, and used a weighted sum instead of a product.
- `repness.py`: Vectorized metric in `compute_group_comment_stats_df()` updated to match.
- `test_discrepancy_fixes.py`: Expanded `TestD7RepnessMetric` from 2 to 6 tests (5 formula + 1 blob).
- `test_repness_unit.py`, `test_old_format_repness.py`: Updated expected values to match product formula.

### Key insight: the old disagree formula was doubly wrong
Python's old disagree_metric used `(1 - pd) * (|pdt| + |rdt|)`. This was wrong in two ways:
1. Used `(1 - pd)` instead of `pd` — Clojure uses `pd` directly as the probability factor
2. Used a weighted sum of absolutes instead of a signed product

The old formula could produce high disagree metrics for comments with low disagree probability
(since `1 - pd` is high when `pd` is low), which is the opposite of the intended behavior.

### Decision: no feature flag for old formula
The plan suggested keeping the old formula behind a flag. After investigation, the old formula
has no defensible behavior (doubly wrong disagree, weighted sum vs product). No flag needed.

### Session 9 (2026-03-13)

- Created branch `jc/clj-parity-d7-repness-metric` on top of `jc/clj-parity-d6-two-prop-test`
- Read Clojure source (repness.clj:188-190, finalize-cmt-stats:170-185) to verify formula
- TDD cycle: red (7 failures across 3 test files) → fix → green (all pass)
- Verified regression diffs are all in `repness.group_repness` — no non-repness changes
- Re-recorded golden snapshots for all 7 datasets
- Final validation: 19/19 regression tests pass, 1 pre-existing failure (pakistan-incremental D2)

### What's Next

1. **PR 7 — Fix D8 (Finalize comment stats)**: Change repful classification from
   `pa > 0.5 AND ra > 1.0` to `rat > rdt` (Clojure's simpler logic).

---

## TDD Discipline

**CRITICAL: For every fix, ALWAYS follow this order:**
1. **Run the full test suite** (all datasets, including private) to establish the baseline
2. **Remove xfail** from the target test(s)
3. **Run tests and confirm they FAIL** (red) — this validates the test actually catches the discrepancy
4. **Apply the fix**
5. **Run tests and confirm they PASS** (green)
6. **Run the full test suite** to check for regressions vs the baseline from step 1
7. **If regression tests fail**: INVESTIGATE before re-recording golden snapshots (see below)

Never skip step 3. A test that passes before the fix is applied is not testing anything useful.

### Golden snapshots are precious

**NEVER blindly re-record golden snapshots.** They are the regression safety net.
When a fix causes regression test failures:

1. **Investigate** what changed: compare old vs new output, check which fields differ
2. **Verify** the new output is closer to Clojure (e.g., in-conv set now matches exactly)
3. **Only then** re-record, one dataset at a time, after confirming correctness
4. **Commit** the updated snapshots with a clear message explaining why they changed

### Per-dataset testing for faster feedback

Run each dataset as a **separate background task** instead of one big pytest invocation.
Smallest datasets finish first, giving early signal without waiting for the 1M-vote ones.

**IMPORTANT**: Always pass `--include-local` when testing private datasets.
Without it, `--datasets <name>` silently skips private datasets (shown as `[NOTSET]`).

### Pipelined worktree workflow

Full test suite takes ~14 minutes. To avoid idle time:
- When tests start running on the current worktree, create the next worktree and start coding the next fix
- Each worktree = one fix, one branch, one PR — stacked like the PR chain
- Number of worktrees in flight depends on test duration vs coding speed
- If a lower fix needs amending, rebase the chain of worktrees above it
- Each worktree gets its own `.local` private data clone (via `link-to-polis-worktree.sh`)

**When starting a new Claude session for the next fix**, ask the user whether they want
to create a new worktree. If yes, provide a prompt they can use to start that session:

> Start working on [Clj parity] fix DN (<description>). This is a new worktree
> stacked on `<previous-branch>`. Read `delphi/docs/CLJ-PARITY-FIXES-JOURNAL.md`
> and `delphi/docs/CLJ-PARITY-FIXES-PLAN.md` for context. Follow the TDD discipline
> documented in the journal.

---

## Notes for Future Sessions

- Private datasets are in `delphi/real_data/.local/` (separate git repo, linked via `link-to-polis-worktree.sh`)
- `test_discrepancy_fixes.py` uses same parametrization pattern as `test_legacy_clojure_regression.py` (own `pytest_generate_tests` hook, `dataset_name` fixture).
- 11 pre-existing test failures are from the stacked branch, not from our work. They should be fixed in their respective PRs before merging to main.
- `strict=False` on xfail means xpass (unexpected pass) is reported but not a failure. Used when some datasets pass by coincidence.
- After rebase, D9 `test_repness_not_empty` started xpassing — the `comment_repness` list is populated (all pairs), but `group_repness` (selected reps) may still be affected by wrong thresholds. Consider tightening this test when fixing D9.
- To rebase when base is updated: `git fetch origin kmeans_analysis_docs && git rebase --onto origin/kmeans_analysis_docs series-of-fixes-base series-of-fixes && git tag -f series-of-fixes-base origin/kmeans_analysis_docs`
