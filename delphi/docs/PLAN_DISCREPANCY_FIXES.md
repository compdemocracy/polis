# Plan: TDD Approach to Fixing Python-Clojure Discrepancies

## Context

The Delphi Python math pipeline has 15 documented discrepancies with the Clojure reference implementation (see `deep-analysis-for-julien/07-discrepancies.md` and `deep-analysis-for-julien/09-fix-plan.md`). We need to fix them one-by-one with a TDD approach: **first extend the regression test to verify the discrepancy exists, then fix it, then verify the test passes**.

Each fix will be a separate PR to keep reviews manageable. PRs will be **stacked** (each builds on the previous), since fixes are ordered by pipeline execution order — fixing upstream affects downstream. PRs should be clearly labeled as stacked with their dependency chain, so reviewers know the order. We can use `git rebase -i` to clean up commit history before merging to main.

**PR naming convention**: Clojure parity fix PRs use the title prefix `[Clj parity PR N]` (e.g., `[Clj parity PR 0] Per-discrepancy test infrastructure`, `[Clj parity PR 1] Fix D2: in-conv participant threshold`).

**Prerequisite**: The current `kmeans_work` branch has changes from `edge`. These should be separated into their own PR(s) first, before we start the discrepancy fix PRs. The discrepancy fix PRs should be based on the cleaned-up branch.

**Action**: Before starting any fix, analyze the diff of `kmeans_work` vs `upstream/edge` to understand what's changed. Group those changes into logical PR(s) — e.g., test infrastructure improvements, doc updates, minor bug fixes. Each should be reviewable independently. The discrepancy fix PRs (PR 1+) then stack on top of this clean base.

### Session Continuity

Because this work will span multiple Claude Code sessions, we maintain:

1. **`delphi/docs/CLJ-PARITY-FIXES-JOURNAL.md`** — An ongoing (committed) tracking:
   - Test baseline after each PR (which tests pass/fail)
   - Gotchas and edge cases discovered along the way
   - Keep the detailed context here, in addition to commit messages and PR descriptions. This document serves as the single source of truth for the fix process for our work, while commit messages are for reviewers and colleagues and future maintainers.
   - Notes for the next session to pick up where we left off
2. **`delphi/CLAUDE.md`** — Updated with stable patterns and conventions discovered during fixes
3. **Commit messages and PR descriptions** — All information useful for reviewers goes here (the journal should reference commit hashes, but can also duplicate content: different audiences, info can overlap, even be identical if it helps.)
4. **Reference docs** — `deep-analysis-for-julien/` (architecture, discrepancies, fix plan), this plan file

### Current Test Baseline
- `test_legacy_clojure_regression.py`: **12 failed, 6 passed, 7 xfailed** (with --include-local)
- Key failures: `test_basic_outputs` (repness empty!), `test_group_clustering` (wrong k, wrong membership)
- `test_legacy_repness_comparison.py`: 4 passed (but only checks structure, not values)
- Only `biodiversity` and `vw` have Clojure math blobs; private datasets do not yet

### Testing Principles

- **Granular tests per discrepancy**: Not just overall regression — each fix gets its own targeted test checking the specific aspect it addresses. Multiple discrepancies may affect `test_basic_outputs`; we need to see incremental improvement per fix.
- **Targeted pipeline-stage tests**: For D2/D3 (participant filtering, clustering), check in-conv count, cluster count, and cluster memberships against Clojure blob. For D12, check comment-priorities against Clojure blob.
- **All datasets, not just biodiversity**: Every fix must pass on ALL datasets. biodiversity is just one reference among many.
- **Synthetic edge-case tests**: Every time we discover an edge case specific to one conversation, extract it into a synthetic unit test with made-up data (never real data from private datasets). These run fast and document the intent clearly.
- **E2E awareness**: GitHub Actions has Cypress E2E tests (`cypress-tests.yml`) testing UI workflows, and `python-ci.yml` running pytest regression. The Cypress tests don't test math output values directly, but `python-ci.yml` will break if clustering/repness changes. Formula-level fixes (D4, D5, D6, D7, D8, D9) are pure computation — no E2E risk. Selection logic changes (D10, D11) and priority computation (D12) could affect what the TypeScript server returns. We decide case-by-case which PRs need E2E verification.

### Datasets Available (sorted by size, smallest first)

| Dataset | Votes | Has Clojure blob? | Notes |
|---------|------:|-------------------|-------|
| vw | 4,684 | Yes | Fastest for iteration |
| biodiversity | 29,803 | Yes | Medium-size reference |
| *(5 private datasets in real_data/.local/)* | 91K–1M | **Need to generate** | Require prodclone DB |

**Generating missing Clojure blobs**: Use `delphi/scripts/generate_cold_start_clojure.py` which creates a temporary conversation in Postgres, runs the Clojure poller via Docker, captures the math blob, and cleans up. Requires the prodclone Postgres database to be running. This should be done as a **pre-requisite step** (PR 0 or setup task) before starting fixes. Note: this is ONLY for a full cold-start blob generation. For incremental testing (D3, D1), we need the replay infrastructure to feed votes in batches and capture intermediate blobs. See below.

```bash
cd delphi
python scripts/generate_cold_start_clojure.py --all --include-local --pause-math
```

If the prodclone DB is not running, we need to start it first. Also check if the main polis worktree already has generated blobs we can copy.
**Testing strategy**: Start with `vw` (fastest), then `biodiversity`, then progressively larger datasets. Expect that some discrepancies only manifest in certain conversations (different edge cases). When we find such a case, add a synthetic unit test for that pattern.

### TypeScript Server Dependency

The TypeScript server (`server/src/nextComment.ts`) depends on Delphi's math outputs:
- **`comment-priorities`**: Used by `getNextPrioritizedComment()` → `selectProbabilistically()` for weighted comment routing. **Currently NOT computed by Python** — falls back to uniform random (weight=1 for all).
- **`repness`**: Consumed by `client-report/src/components/lists/participantGroups.jsx` for displaying representative comments per group in the **legacy report mode**.
- **`consensus`**: Consumed by `client-report/` via `normalizeConsensus.js` for consensus display.

**Two report modes exist**:
- **Legacy report** (`/report/{report_id}`) — uses `math["repness"]`, `math["group-votes"]`, `math["group-clusters"]` from the math blob
- **Narrative report** (`/narrativeReport/{report_id}`) — uses DynamoDB UMAP/topic data, independent of math blob repness

The formula-level fixes (D4, D5, D6, D7, D8, D9) are pure math improvements — they make the computation correct regardless of consumer. The **selection logic** fixes (D10, D11) need a legacy-mode flag since `client-report/` may depend on current behavior. Comment priorities (D12) is a net-new computation that the TypeScript server will consume.

**Future PRs** (after parity): Implement Python versions of TypeScript routing logic (`getNextPrioritizedComment`, `selectProbabilistically`) so core computations live in Python, with TypeScript as thin routing layer. Open a GitHub Issue upstream documenting this proposal with permalinks to the relevant TypeScript code.

---

## Fix Order (one PR per fix)

Fixes are ordered by **pipeline execution order**: participant filtering → probability estimates → proportion tests → z-score thresholds → repness metrics → comment stats → selection → consensus → clustering stability → priorities. This way, after each fix, we re-run and compare up to that point.

**After each PR**: re-check the full baseline. Document results in the journal. Some earlier fixes may resolve downstream failures.

---

### PR 0: Generate Missing Clojure Blobs + Test Infrastructure Setup

**Pre-requisite** before any fixes.

1. Start prodclone Postgres if not running
2. Run `generate_cold_start_clojure.py --all --include-local --pause-math` to generate cold-start blobs for all private datasets
3. Create `tests/test_discrepancy_fixes.py` with the test infrastructure:
   - One test class per discrepancy, parametrized by ALL datasets
   - Shared comparison utilities that call the same core comparer logic as `regression_comparer.py`
   - Synthetic edge-case test scaffolding
4. Create `delphi/docs/CLJ-PARITY-FIXES-JOURNAL.md` with initial baseline
5. Update `delphi/CLAUDE.md` with TypeScript/Delphi connection documentation

---

### PR 1: Fix D2 — In-Conv Participant Threshold

**Why first**: This is the **first step in the pipeline** — it gates which participants enter clustering. Wrong threshold → wrong participants → wrong clusters → wrong everything downstream.

**File**: `delphi/polismath/conversation/conversation.py`

**Current**: `threshold = 7 + sqrt(n_cmts) * 0.1` → biodiversity (314 comments): threshold=8.8, keeps 428/536.
**Target**: `threshold = min(7, n_cmts)` → threshold=7, more participants qualify.

**Additional changes**:
- Use `self.raw_rating_mat` instead of `self.rating_mat` (count on unmoderated matrix)
- Add greedy fallback (top-15 voters if <15 qualify)
- Add monotonic persistence (once in, always in)

**Test-first approach**:
1. Add test comparing in-conv participant count/set between Python and Clojure for ALL datasets
2. Add synthetic edge-case tests: tiny conversation (fewer comments than threshold), conversation where greedy fallback triggers
3. Run tests → expect failure
4. Apply fix
5. Re-run ALL tests — cluster count may change (possibly 3→2 for biodiversity, matching Clojure)
6. **Cluster comparison test (CRITICAL)**: After fixing D2, add a test that compares Python and Clojure cluster assignments at the participant level — number of clusters AND which participants are in which cluster (using Jaccard similarity or exact match). The Python clustering calls sklearn K-means; Clojure uses a two-level approach. If clusters still don't match after the threshold fix, investigate why and potentially create an additional PR (PR 1b) to fix the remaining clustering discrepancy before moving on to repness fixes.
7. Document new baseline in journal

---

### PR 2: Fix D4 — Pseudocount Formula

**Why before D9**: The pseudocount affects probability estimates (`pa`, `pd`), which feed into proportion tests and z-scores. Fixing this first gives us correct probability values, even if the z-score thresholds are still wrong. This follows pipeline execution order: probabilities are computed before significance testing.

**File**: `delphi/polismath/pca_kmeans_rep/repness.py`

**Current**: `PSEUDO_COUNT = 1.5` → `pa = (na + 0.75) / (ns + 1.5)` (Beta(1.75,1.75) prior)
**Target**: `PSEUDO_COUNT = 2.0` → `pa = (na + 1) / (ns + 2)` (Beta(2,2) prior, matching Clojure)

**Test-first approach**:
1. Add unit test: for known (na, ns) pairs from Clojure math blob repness, verify `pa` values match
2. Compare `pa`/`pd` values for specific (group, comment) pairs across ALL datasets
3. Fix: Change `PSEUDO_COUNT = 2.0`
4. Document which repness values improved and which are still off (due to remaining D5/D6/D7/D9)

---

### PR 3: Fix D9 — Z-Score Significance Thresholds

**Why next**: Now that probabilities are correct (D4 fixed), we fix the significance gates. This is likely why `comment_repness` is empty — Python requires 28% higher z-scores.

**File**: `delphi/polismath/pca_kmeans_rep/repness.py`

**Current**: `Z_90 = 1.645` (two-tailed), `Z_95 = 1.96` (two-tailed)
**Target**: `Z_90 = 1.2816` (one-tailed), `Z_95 = 1.6449` (one-tailed) — matching Clojure

**Note**: Python's own `stats.py` already uses 1.2816. This fix resolves an internal inconsistency.

**Test-first approach**:
1. Add test checking repness produces non-empty `comment_repness` for ALL datasets
2. Add test comparing repness values (pa, pat, ra, rat, overall metric) to Clojure — expect partial match (D5/D6/D7 still unfixed, so z-scores will differ, but more comments should now pass significance)
3. Fix: Change constants
4. Re-run full suite — `test_basic_outputs` may now pass
5. Document which repness values now match Clojure and which still differ

---

### PR 4: Fix D5 — Proportion Test Formula

**Why next**: With correct probabilities (D4) and thresholds (D9), now fix the proportion test formula itself. This changes ALL `pat`/`pdt` z-scores.

**File**: `delphi/polismath/pca_kmeans_rep/repness.py`

**Analysis**:

| Aspect | Python (current) | Clojure (target) |
|--------|-----------------|------------------|
| Formula | `(p - 0.5) / sqrt(0.25/n)` | `2*sqrt(n+1)*((succ+1)/(n+1) - 0.5)` |
| Type | Standard z-test | Wilson-score-like with built-in continuity correction |
| Pseudocount | None in test (applied separately) | Built-in Beta(1,1) prior: `(succ+1)/(n+1)` |
| Small n | Can produce extreme z-scores | Regularized — `+1` terms shrink extremes |

The Clojure formula is preferable for Polis: small group sizes are common, and the built-in regularization prevents spurious significance.

**Code comments**: Check Clojure source (`stats.clj`) for explanatory comments and copy them to Python. Add clear docstring explaining what this test does, why the Clojure formula is used, and how it differs from a standard z-test.

**Signature change**: `prop_test(p, n, p0)` → `prop_test(succ, n)`. All callers need updating including `prop_test_vectorized`.

**Test-first approach**:
1. Unit tests: for known (succ, n) pairs, compare to Clojure formula output
2. Compare pat/pdt values against Clojure blob for ALL datasets
3. Fix: Replace both scalar and vectorized implementations, update all callers
4. Document improvements

---

### PR 5: Fix D6 — Two-Proportion Test Adjustment

**Why next**: Similar to D5, this fixes the group-vs-other z-scores (`rat`/`rdt`).

**File**: `delphi/polismath/pca_kmeans_rep/repness.py`

**Current**: Standard two-proportion z-test, no pseudocounts
**Target**: Add +1 pseudocount to all 4 inputs (succ1, n1, succ2, n2), matching Clojure

**Signature change**: From proportions to counts. All callers (including `two_prop_test_vectorized`) need updating.

**Test-first approach**:
1. Unit tests with known values, compare to Clojure formula
2. Compare rat/rdt values against Clojure blob for ALL datasets
3. Fix: Add pseudocounts, change signatures, update callers

---

### PR 6: Fix D7 — Repness Metric Formula

**Why next**: With all underlying statistics now correct (D4, D5, D6, D9), fix the metric that ranks comments.

**File**: `delphi/polismath/pca_kmeans_rep/repness.py`

**Analysis**:

| Aspect | Python (current) | Clojure (target) |
|--------|-----------------|------------------|
| Formula | `pa * (\|pat\| + \|rat\|)` | `ra * rat * pa * pat` |
| Type | Weighted sum of 2 absolute values | Product of 4 signed values |
| Zero sensitivity | Tolerant | Strict — any factor near 0 kills metric |
| Behavior | High probability OR high test score | Requires ALL dimensions to be strong |

The Clojure product formula is more conservative and arguably better for finding truly representative comments.

**Possibly unintentional change**: The Python formula may have been an LLM hallucination during the Clojure→Python port. Team has been asked to confirm. **Preserve the current formula behind a flag** with a TODO comment to delete or keep once confirmed. Default to Clojure formula for regression tests.

**Test-first approach**:
1. Extract Clojure repness scores from math blob for ALL datasets
2. Compare agree_metric/disagree_metric per (group, comment)
3. Fix: Change to `ra * rat * pa * pat` (both scalar and vectorized), keep old formula behind flag
4. Verify ranking order matches Clojure

---

### PR 7: Fix D8 — Finalize Comment Stats Logic

**File**: `delphi/polismath/pca_kmeans_rep/repness.py`

**Current**: `if pa > 0.5 AND ra > 1.0 → 'agree'; elif pd > 0.5 AND rd > 1.0 → 'disagree'`
**Target**: Simple `rat > rdt → 'agree'; else → 'disagree'` (matching Clojure)

**Test-first approach**:
1. Test: verify `repful` classification matches Clojure across ALL datasets
2. Fix: Replace threshold checks with `rat > rdt` (both scalar and vectorized)

---

### PR 8: Fix D10 — Representative Comment Selection

**File**: `delphi/polismath/pca_kmeans_rep/repness.py`

**Pre-investigation needed**: Dig into `client-report/src/components/lists/participantGroups.jsx` to understand exactly how it consumes `repness`. The legacy report uses `math["repness"][gid]`, the narrative report uses DynamoDB topics. Determine if changing selection logic (3+2 → 5 total, agrees first) would break the legacy report display.

**Approach**: Implement Clojure's selection as default, keep current selection behind `DELPHI_LEGACY_REPNESS_SELECTION=true` env var (update `example.env`). TODO comment: remove legacy mode once verified in production.

**Test-first approach**:
1. Compare selected rep comments per group to Clojure's repness output for ALL datasets
2. Fix: Match Clojure's single-pass with beats-best-by-test, up to 5 total (agrees first)

---

### PR 9: Fix D11 — Consensus Comment Selection

**File**: `delphi/polismath/pca_kmeans_rep/repness.py`

**Current**: ALL groups `pa > 0.6`, top 2 overall
**Target**: Per-comment `pa > 0.5`, top 5 agree + 5 disagree with z-test scores

Same legacy-mode flag approach as D10. TODO comment + GitHub Issue (upstream) proposing consolidation of all math into Python, with permalinks to the TypeScript code that would be simplified.

**Test-first approach**:
1. Compare consensus comments to Clojure's `consensus` blob key for ALL datasets
2. Fix: Match Clojure's logic

---

### PR 10: Fix D3 — K-Smoother Buffer

**File**: `delphi/polismath/conversation/conversation.py`

**This is a temporal stability feature**: Clojure requires k to be best for 4 consecutive updates before switching. Without it, groups flicker.

**WARNING**: The k-smoother makes `k` depend on the full history of updates, which we don't have in cold-start math blobs. Cold-start blobs are single-shot. Therefore:

- **Cold-start test**: Verify the smoother doesn't change cold-start behavior (buffer=4 means first k is always accepted)
- **Incremental test**: Feed votes in batches, verify k doesn't flicker — Python-only test, no Clojure comparison possible without replay infrastructure

If we discover that cold-start fixes can't be completed without warm-start testing, we'll need the replay infrastructure earlier (see Replay Infrastructure section below).

**Test approach**:
1. Cold-start: verify same results as without smoother (first run always accepts k)
2. Incremental: feed votes in batches, assert k stability
3. Fix: Add `group_k_smoother` state with buffer=4

---

### PR 11: Fix D12 — Comment Priorities

**Files**: `delphi/polismath/conversation/conversation.py`, `delphi/polismath/pca_kmeans_rep/pca.py`

**Critical for production**: Without comment priorities, TypeScript server falls back to uniform random selection. Currently `_compute_votes_base()` is dead code with a bug (line 1076: invalid pandas syntax).

This replaces the reading from the math blob with a proper Python computation matching Clojure.

**Test-first approach**:
1. Remove xfail from existing `test_comment_priorities`
2. Extract `comment-priorities` from Clojure math blob, compare rankings (Spearman correlation) for ALL datasets
3. Implement: comment projection/extremity in PCA, `importance_metric`, `priority_metric`, full computation
4. Fix buggy `_compute_votes_base()` method

---

### PR 12: Fix D15 — Moderation Handling

**File**: `delphi/polismath/conversation/conversation.py`

Clojure zeros out moderated comments (keeps structure, sets values to 0). Python removes them entirely. Affects matrix dimensions and vote counts.

**Test-first approach**:
1. Add test with dataset containing moderated comments, compare behavior
2. Fix or document the difference

---

### PR 13: Fix D1/D1b — PCA Sign Flip Prevention

**Files**: `delphi/polismath/pca_kmeans_rep/pca.py`

**This MUST be fixed**: We cannot afford sign flips between updates — they cause participants to appear to jump to the opposite side of the visualization.

**Approach**:
1. Add a test that detects sign flips (feed incremental votes, check projection consistency)
2. Implement sign-consistency logic: after computing PCA, compare to previous components and flip signs to maintain consistency
3. Consider `IncrementalPCA` for warm-starting (also addresses D14 for free)

This is non-trivial and should be one of the last fixes.

---

### PR 14: Cleanup — Remove Dead Code

**Files**: Multiple (see `08-dead-code.md`)
- Custom kmeans chain in `clusters.py`
- Non-vectorized repness functions in `repness.py`
- Buggy `_compute_votes_base()` (after D12 replaces it)
- `stats.py` inconsistencies (after D9 makes `repness.py` authoritative)

By this point, we should have good test coverage from all the per-discrepancy tests, giving confidence that dead code removal won't break anything. Still run full regression suite after cleanup.

---

### Explicitly Deferred

- **D13 — Subgroup Clustering**: Not implemented in Python, never used by TypeScript consumers. No fix needed.
- **D14 — Large Conversation Optimization**: Clojure needed mini-batch PCA because it was slow. Python's sklearn SVD is fast enough. No fix needed unless we adopt `IncrementalPCA` for sign consistency (PR 13).

---

### Future PRs (after parity)

- **Python implementation of TypeScript routing logic**: `getNextPrioritizedComment`, `selectProbabilistically`, returning a pre-computed list of next comments so TypeScript becomes thin routing layer
- **GitHub Issue**: Document proposal to consolidate math in Python with permalinks to TypeScript code

---

## Discrepancy Coverage Checklist

| ID | Discrepancy | PR | Status |
|----|-------------|-----|--------|
| D1 | PCA sign flips | PR 13 | Fix (sign consistency) |
| D1b | Projection input | PR 13 | Fix with D1 |
| D2 | In-conv threshold | **PR 1** | Fix |
| D3 | K-smoother buffer | PR 10 | Fix |
| D4 | Pseudocount formula | **PR 2** | Fix |
| D5 | Proportion test | PR 4 | Fix |
| D6 | Two-proportion test | PR 5 | Fix |
| D7 | Repness metric | PR 6 | Fix (with flag for old formula) |
| D8 | Finalize cmt stats | PR 7 | Fix |
| D9 | Z-score thresholds | **PR 3** | Fix |
| D10 | Rep comment selection | PR 8 | Fix (with legacy env var) |
| D11 | Consensus selection | PR 9 | Fix (with legacy env var) |
| D12 | Comment priorities | PR 11 | Fix (implement from scratch) |
| D13 | Subgroup clustering | — | **Deferred** (unused) |
| D14 | Large conv optimization | — | **Deferred** (Python fast enough) |
| D15 | Moderation handling | PR 12 | Fix |

---

## Test Infrastructure

### `tests/test_discrepancy_fixes.py` — New test file

**Two types of tests per discrepancy**:

1. **Real-data parametrized tests**: One test class per discrepancy, parametrized by ALL datasets. Loads conversation + Clojure math blob, checks specific aspect, designed to FAIL before fix and PASS after.

2. **Synthetic edge-case tests**: When we discover an edge case in a real conversation, extract the pattern into a test with completely made-up data (never real data from private datasets). These run fast, document the edge case clearly, and prevent regressions.

**All datasets must have cold start Clojure blobs** — generate missing ones using `generate_cold_start_clojure.py` before starting fixes.

### Shared comparison logic

Both `pytest` tests and `regression_comparer.py` should use the **same core comparison logic**. The pytest tests call it with assertions; the script calls it with report generation. This ensures consistency and reduces duplication. Extend `ClojureComparer` with methods like:
- `compare_in_conv_participants()` — participant set comparison
- `compare_repness_values()` — per-(group, comment) metric comparison
- `compare_consensus()` — consensus comment overlap
- `compare_priorities()` — priority ranking correlation (Spearman)

### Replay Infrastructure (separate PRs, needed for D3/D1)

Three separate PRs for temporal/incremental testing:

**Replay PR A**: Core replay infrastructure
- Script that takes a conversation's votes CSV, splits into batches of configurable size
- For each batch: feed votes to Python `Conversation.update()`, record state
- For each batch: feed votes to Clojure via DB + poller, record math blob
- Compare Python vs Clojure state after each batch
- Requires separate test Postgres database (not touching main environment)
- Generation can be done once but must be scripted for reproducibility

**Replay PR B**: Use replay infrastructure for tests
- Test D3 (k-smoother stability) with real incremental data
- Test D1 (PCA sign consistency) with real incremental data
- Compare Python's incremental behavior to Clojure's

**Replay PR C**: Visualization movie generation
- Adapt existing static visualization scripts (`delphi/scripts/visualize_cluster_comparison.py`) for temporal replay
- Generate frame-by-frame visualizations showing conversation evolution
- Fixed x/y ranges across all frames for consistent animation
- Useful for debugging, tutorials, and showcasing

---

## Dataset Size Strategy

When iterating on a fix:
1. Start with **vw** (4.7K votes) — fastest feedback loop
2. Then **biodiversity** (30K votes) — another reference
3. Then private datasets (91K–1M) — progressively larger
4. Full suite with ALL datasets only after fix is stable on smaller ones

All datasets are equally important. No single dataset is "the main" reference — each may expose different edge cases.

### On Test Redundancy: `pytest` vs `regression_comparer.py`

**Keep both** — they serve different purposes:

| | `pytest` tests | `regression_comparer.py` |
|---|---|---|
| **Purpose** | Binary pass/fail | Detailed human-readable reports |
| **CI-friendly** | Yes | No (interactive use) |
| **When** | After each change (automated) | Investigating failures (manual) |

**Critical**: Both must use the same core comparison logic (shared in `polismath/regression/`), so updating one automatically benefits the other.

### Golden snapshot updates

After each fix: `uv run python scripts/regression_recorder.py`

---

## Verification After Each PR

1. Run targeted discrepancy test on **vw**: `uv run pytest tests/test_discrepancy_fixes.py -k <fix_name> --datasets=vw`
2. If pass, run on **biodiversity**: `--datasets=biodiversity`
3. Run on **all datasets**: `--include-local`
4. Run full legacy suite: `uv run pytest tests/test_legacy_clojure_regression.py --include-local` — no new failures
5. Run full regression suite: `uv run pytest tests/test_regression.py --include-local` — re-record golden snapshots if needed
6. Optional deep inspection: `uv run python scripts/regression_comparer.py --include-local`
7. Document updated baseline in `CLJ-PARITY-FIXES-JOURNAL.md`
8. Write clear commit message and PR description with test results
