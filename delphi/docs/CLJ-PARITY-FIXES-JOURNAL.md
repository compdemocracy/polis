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

### Incomplete Clojure blobs (BLOCKING)

3 private datasets have incomplete Clojure cold-start blobs (4 keys instead of 23):
- Missing `in-conv`, `repness`, `consensus`, `comment-priorities`, etc.
- Likely caused by Clojure math service timeout on large conversations
- The 4 remaining datasets (vw, biodiversity, FLI, bg2018) have complete blobs (23 keys)
- **D2 tests pass on all datasets with complete blobs**
- D2 tests fail on the 3 incomplete datasets because `in-conv` is empty — this is a data
  problem, not a code problem

**Action needed**: Regenerate Clojure blobs for the 3 incomplete datasets using
`generate_cold_start_clojure.py` with the prodclone DB and Clojure math service.
This is delegated to a separate session.

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
