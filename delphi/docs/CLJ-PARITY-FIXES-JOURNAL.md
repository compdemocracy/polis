# Journal: Fixing Python-Clojure Discrepancies

This is the ongoing tracking document for the TDD fix process described in
`CLJ-PARITY-FIXES-PLAN.md`. It serves as the single source of truth for
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
5 passed, 2 skipped, 18 xfailed, 5 xpassed
```

- **5 passed**: Clojure formula sanity checks (prop_test, repness metric product, repful rat>rdt) + Clojure blob consistency checks (pat values for vw and biodiversity)
- **2 skipped**: D15 moderation — vw and biodiversity have no moderated comments
- **18 xfailed**: Discrepancy tests correctly fail (D2-D12 constants, formulas, and real-data comparisons)
- **5 xpassed** (all `strict=False`, so green):
  - D2 in-conv × 2 on vw (small dataset where thresholds coincide)
  - D9 repness_not_empty × 2 on vw+biodiversity (rebased code produces non-empty `comment_repness` — the full list of all (group, comment) pairs is populated even with wrong thresholds; only `group_repness` selection is affected)
  - D6 two_prop_test × 1 (the pseudocount difference is small enough for this particular test case)

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

## What's Next: PR 1 — Fix D2 (In-Conv Participant Threshold)

- Change `threshold = 7 + sqrt(n_cmts) * 0.1` to `threshold = min(7, n_cmts)` in `conversation.py:1238`
- Use `self.raw_rating_mat` instead of `self.rating_mat` for counting
- Add greedy fallback (top-15 voters if <15 qualify)
- Add monotonic persistence (once in, always in)
- Remove xfail from `TestD2InConvThreshold`
- Check cluster count impact (may change from 3→2 for biodiversity, matching Clojure)
- Re-record golden snapshots if needed
- Document new baseline

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
  - `CLJ-PARITY-FIXES-PLAN.md` in `kmeans_analysis_docs` (amended tip)
  - `CLJ-PARITY-FIXES-JOURNAL.md` in `series-of-fixes` (amended tip)
  - Force-pushed all three branches, rebased the chain
- Tests unchanged: 5 passed, 2 skipped, 18 xfailed, 5 xpassed

---

## Notes for Future Sessions

- Private datasets not available in this worktree. Need prodclone DB + `generate_cold_start_clojure.py`.
- `test_discrepancy_fixes.py` uses same parametrization pattern as `test_legacy_clojure_regression.py` (own `pytest_generate_tests` hook, `dataset_name` fixture).
- 11 pre-existing test failures are from the stacked branch, not from our work. They should be fixed in their respective PRs before merging to main.
- `strict=False` on xfail means xpass (unexpected pass) is reported but not a failure. Used when some datasets pass by coincidence.
- After rebase, D9 `test_repness_not_empty` started xpassing — the `comment_repness` list is populated (all pairs), but `group_repness` (selected reps) may still be affected by wrong thresholds. Consider tightening this test when fixing D9.
- To rebase when base is updated: `git fetch origin kmeans_analysis_docs && git rebase --onto origin/kmeans_analysis_docs series-of-fixes-base series-of-fixes && git tag -f series-of-fixes-base origin/kmeans_analysis_docs`
