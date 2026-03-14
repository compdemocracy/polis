## Title
Fix D7: match Clojure repness metric formula (product of 4 signed values)

## Summary
Changes the representativeness metric from a weighted sum of absolutes to the
Clojure product formula (repness.clj:188-190).

**Before (Python):**
- agree_metric = `pa * (|pat| + |rat|)` — weighted sum, tolerant of weak factors
- disagree_metric = `(1 - pd) * (|pdt| + |rdt|)` — doubly wrong: uses `(1-pd)` and sum

**After (Clojure formula):**
- agree_metric = `ra * rat * pa * pat` — product of 4 signed values
- disagree_metric = `rd * rdt * pd * pdt` — product of 4 signed values

The product formula is more conservative: any factor near zero kills the entire
metric, requiring ALL dimensions (probability, significance, relative
representativeness) to be strong simultaneously.

The old disagree formula was doubly wrong:
1. Used `(1 - pd)` instead of `pd` — high metric when disagree probability is LOW
2. Used a weighted sum of absolutes instead of a signed product

No feature flag for the old formula — it has no defensible behavior.

## Test plan
- [x] 5 new D7 formula tests (agree product, disagree product, zero-kills-metric,
      sign preservation, multiple known values)
- [x] Updated unit tests in test_repness_unit.py and test_old_format_repness.py
- [x] Full test suite passes (excluding DynamoDB/MinIO tests)
- [x] Private dataset tests pass (--include-local)
- [x] Golden snapshots re-recorded for all 7 datasets

## Test results
```
Full suite (with --include-local):
1 failed (pakistan-incremental D2, pre-existing), 98 passed, 5 skipped,
131 xfailed, 3 xpassed

Regression tests: 19/19 passed (all datasets including private)
```
