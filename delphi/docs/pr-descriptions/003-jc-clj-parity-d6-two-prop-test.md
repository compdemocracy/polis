## Title
Fix D6: match Clojure two-proportion test formula (+1 pseudocount on all inputs)

## Summary
The Python `two_prop_test` used a standard two-proportion z-test with no pseudocounts,
while Clojure's `stats/two-prop-test` (stats.clj:18-33) adds +1 to all four inputs
(`succ-in`, `succ-out`, `pop-in`, `pop-out`) via `(map inc ...)` before computing
the pooled z-test. This Laplace smoothing regularizes z-scores for small group sizes,
which are common in Polis conversations.

### Changes
- **Signature change**: `two_prop_test(p1, n1, p2, n2)` (proportions) →
  `two_prop_test(succ_in, succ_out, pop_in, pop_out)` (raw counts)
- **Formula**: Standard pooled z-test on pseudocount-adjusted values:
  `pi1 = (succ_in+1)/(pop_in+1)`, `pi_hat = (s1+s2)/(p1+p2)`
- **Callers updated**: Both scalar (`add_comparative_stats`) and vectorized
  (`compute_group_comment_stats_df`) now pass raw counts matching Clojure's
  `(stats/two-prop-test (:na in-stats) (sum :na rest-stats) (:ns in-stats) (sum :ns rest-stats))`
  (repness.clj:97-100)

### Affected output fields
- `rat` (agree representativeness test z-score)
- `rdt` (disagree representativeness test z-score)
- `agree_metric`, `disagree_metric` (downstream of rat/rdt)

## Test plan
- [x] Targeted D6 tests pass (formula, edge cases, regularization effect)
- [x] Full test suite passes (excluding DynamoDB/MinIO tests)
- [x] Private dataset tests pass (--include-local)
- [x] Golden snapshots re-recorded for all 7 datasets

## Test results
```
1 failed (pre-existing pakistan-incremental D2), 102 passed, 5 skipped,
143 xfailed, 2 xpassed (with --include-local, 7 datasets)
```
