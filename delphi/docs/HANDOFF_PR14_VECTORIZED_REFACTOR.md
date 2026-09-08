# Handoff: PR 14 — Make Vectorized Code Readable + Blob Injection Tests

> **Status (2026-06-11):** PR 14a (delete dead scalar paths in repness.py) is in the open spr stack as PR #2564. Tasks 14b (vectorized blob-injection tests) and 14c (readability refactor) remain open and are tracked in `PLAN_DISCREPANCY_FIXES.md`. The branch names and stack listing below are from the 2026-03/06 sessions and are stale — do not branch from them.

## Goal

The scalar functions (`comment_stats`, `add_comparative_stats`, `repness_metric`,
`finalize_cmt_stats`) read like a step-by-step recipe. Their vectorized replacement
(`compute_group_comment_stats_df`) buries the same logic in 150 lines of DataFrame
plumbing. The vectorized path is the ONLY production code path — the scalar functions
are dead code, called only from tests and benchmarks.

**PR 14 must make the vectorized code at least as readable as the scalar code, then
delete the scalar functions.** This also enables vectorized blob injection tests —
the only non-tautological way to verify correctness against the Clojure math blob.

## Starting point

Branch off `jc/clj-parity-d9-fix` (Stack 13). This is BELOW D5-D8 in the stack,
so the refactor will be inherited by all formula fix PRs.

## Current stack (as of 2026-03-17)

```
Stack 13: jc/clj-parity-d9-fix          ← branch off HERE for PR 14
Stack 14: jc/clj-parity-d5-prop-test     (draft PR #2448)
Stack 15: jc/clj-parity-d6-two-prop-test (draft PR #2449)
Stack 16: jc/clj-parity-d7-repness-metric (draft PR #2450)
Stack 17: jc/clj-parity-d8-finalize-stats (draft PR #2451)
Stack 18: jc/clj-parity-d15-moderation-handling-zeros-vs-removes (PR #2452)
Stack 19: jc/clj-parity-kmeans-k-divergence (k-divergence fix)
Stack 20: jc/clj-parity-d10-rep-comment-selection
Stack 21: jc/clj-parity-d11-consensus-comment-selection
Stack 22: jc/clj-parity-d3-k-smoother-buffer
Stack 23: jc/clj-parity-d12-comment-priorities
Stack 24: jc/clj-parity-d1-pca-sign-flip-prevention
Stack 25: jc/clj-parity-pr15-load-votes-sort
```

D5-D8 are draft PRs waiting for vectorized blob tests before being marked ready.

## Task sequence

### 1. Refactor `compute_group_comment_stats_df`

Split into two phases:

**(a) DataFrame construction** (the plumbing):
- Build participant→group mapping
- Compute total counts per comment
- Create full (group, comment) cross-product index
- Join total counts, compute "other" counts

**(b) Statistics computation** (the readable part):
A new function with clean DataFrame inputs (columns: `na`, `nd`, `ns`,
`other_agree`, `other_disagree`, `other_votes`) → outputs (columns: `pa`, `pd`,
`pat`, `pdt`, `ra`, `rd`, `rat`, `rdt`, `agree_metric`, `disagree_metric`, `repful`).

This function should read like the scalar recipe:
```python
# Probabilities with pseudocounts
df['pa'] = (df['na'] + PSEUDO_COUNT/2) / (df['ns'] + PSEUDO_COUNT)
# Proportion tests
df['pat'] = prop_test_vectorized(df['na'], df['ns'])
# Representativeness ratios
df['ra'] = df['pa'] / df['other_pa']
# ...etc
```

### 2. Write vectorized blob injection tests

Inject Clojure group memberships + votes into the new statistics function,
compare output to blob values. Test the PRODUCTION code path.

For each `(group, tid)` in the blob's `repness`:
- Compare `pat` (or `pdt`) to blob `p-test`
- Compare `rat` (or `rdt`) to blob `repness-test`
- Compare `pa` (or `pd`) to blob `p-success`
- Compare `repful` to blob `repful-for`

The blob only stores the winning side's values. `repful-for` tells you which
side won: if `agree`, then `n-success`=na, `p-test`=pat, `repness-test`=rat.
If `disagree`, then `n-success`=nd, `p-test`=pdt, `repness-test`=rdt.

### 3. Verify scalar ≡ vectorized

Run both paths on all datasets, compare outputs field by field. Must be
identical (not just close — exact match) since they implement the same formulas.

### 4. Delete scalar functions

Remove: `comment_stats`, `add_comparative_stats`, `repness_metric`,
`finalize_cmt_stats`, and scalar `prop_test`/`two_prop_test` if no longer
needed (the vectorized versions remain).

Update all tests that called the scalar API.

### 5. Cascade rebase

Rebase D5→D6→D7→D8→D15→k-divergence→D10→D11→D3→D12→D1→PR15 on top.
Use `.claude/skills/pr-stack/rebase-stack.sh` for the cascade.

### 6. Add per-PR vectorized blob injection tests

For each of D5, D6, D8: insert a RED blob test commit before the fix,
verify it fails, then verify the fix makes it pass. Same TDD pattern used
for the scalar blob tests already in those branches.

Then mark #2448-#2451 as ready (un-draft).

## Key blob context

- `n-trials` in the Clojure blob = `S` (total seen, INCLUDING passes), not
  `A+D` (agrees + disagrees). Verified: `prop_test(11, 14)` matches blob
  `p-test` for tid=49 group 0 in vw (A=2, D=11, S=14, A+D=13).
- `group-votes[gid].votes[tid]` = `{A: agrees, D: disagrees, S: total_seen}`
- Blob `repness[gid][i]` fields: `n-success`, `n-trials`, `p-success`,
  `p-test`, `repness` (=ra or rd), `repness-test` (=rat or rdt),
  `repful-for`, `tid`, `best-agree` (optional).

## Files to modify

- `delphi/polismath/pca_kmeans_rep/repness.py` — the refactor
- `delphi/tests/test_discrepancy_fixes.py` — vectorized blob tests
- `delphi/tests/test_repness_unit.py` — update for new API
- `delphi/tests/test_old_format_repness.py` — update for new API
- `delphi/polismath/benchmarks/bench_repness.py` — update imports

## Reference

- Journal: `delphi/docs/CLJ-PARITY-FIXES-JOURNAL.md` — Session 11 entry,
  PR 14 readability goal in Notes for Future Sessions
- Plan: `delphi/docs/PLAN_DISCREPANCY_FIXES.md` — mandatory blob comparison
  section in Testing Principles
- Clojure source: `math/src/polismath/math/stats.clj` (prop-test, two-prop-test),
  `math/src/polismath/math/repness.clj` (finalize-cmt-stats, repness-metric)
