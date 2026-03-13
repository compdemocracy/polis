## Title
Fix D5: match Clojure prop_test formula (Wilson-score-like with +1 pseudocount)

## Summary
Replace Python's standard one-proportion z-test `prop_test(p, n, p0)` with
Clojure's Wilson-score-like formula `prop_test(succ, n)` from `stats.clj:10-15`:

```
2 * sqrt(n+1) * ((succ+1)/(n+1) - 0.5)
```

The Clojure formula has a built-in +1 pseudocount (Laplace smoothing / Beta(1,1)
prior) that regularizes extreme values for small Polis groups. This is separate
from the `PSEUDO_COUNT=2.0` used for `pa`/`pd` estimation (Beta(2,2) prior):

- `pa = (na + 1) / (ns + 2)` — Beta(2,2) prior for probability estimation
- `pat = 2 * sqrt(ns+1) * ((na+1)/(ns+1) - 0.5)` — Beta(1,1) prior for significance testing

**What changed in the output**: `pat`, `pdt` values (proportion test z-scores),
and downstream `agree_metric` / `disagree_metric` values. The z-scores are
now slightly different due to `sqrt(n+1)` vs `sqrt(n)` and `(succ+1)/(n+1)` vs
`(na+1)/(n+2)` denominators.

## Changes
- `repness.py`: `prop_test(p, n, p0)` → `prop_test(succ, n)` with Clojure formula
- `repness.py`: `prop_test_vectorized(p, n, p0)` → `prop_test_vectorized(succ, n)`
- `repness.py`: Callers updated to pass raw counts `(na, ns)` instead of `(pa, ns, 0.5)`
- `test_discrepancy_fixes.py`: Removed xfail from D5 formula test, added 8 test cases + edge case
- `test_repness_unit.py`, `test_old_format_repness.py`: Updated for new signature
- Golden snapshots re-recorded for all datasets

## Test plan
- [x] D5 formula tests pass (8 input pairs + edge cases)
- [x] D5 Clojure blob consistency check passes (all datasets)
- [x] Full test suite passes (273 passed, 3 skipped, 62 xfailed — public)
- [x] Full test suite with --include-local passes (91 passed, 5 skipped, 129 xfailed, 2 xpassed)
- [x] All 19 regression tests pass (including 5 private datasets)
- [x] Only pre-existing failure: pakistan-incremental D2 (unrelated)

## Test results
```
Full suite (public):    273 passed, 3 skipped, 62 xfailed
Full suite (private):   91 passed, 5 skipped, 129 xfailed, 2 xpassed, 1 failed (pre-existing)
Regression tests:       19/19 passed (all datasets)
```
