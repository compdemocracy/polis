## Title
Fix D8: match Clojure repful classification (rat > rdt)

## Summary
Replace the complex 3-branch `repful` classification logic with Clojure's simple `rat > rdt` comparison (repness.clj:175-177).

**Old Python logic:**
- `if pa > 0.5 and ra > 1.0` → agree
- `elif pd > 0.5 and rd > 1.0` → disagree
- `else` → higher of agree_metric vs disagree_metric

**New (matching Clojure):**
- `if rat > rdt` → agree
- `else` → disagree

The two-proportion z-test scores (`rat`/`rdt`) already encode group significance — the old probability/ratio thresholds (`pa > 0.5`, `ra > 1.0`) were redundant gates.

Both scalar (`finalize_cmt_stats`) and vectorized (`compute_group_comment_stats_df`) implementations updated.

## Test plan
- [x] 5 new formula tests pass (rat>rdt, rat<rdt, equal, both negative, both zero)
- [x] Blob comparison tests xfail (depend on D10 selection logic)
- [x] Unit tests in test_repness_unit.py pass (existing values compatible with both logics)
- [x] Full test suite passes (public datasets): 289 passed, 0 failed
- [x] Full test suite passes (private datasets): 19/19 regression, 3 pre-existing failures only
- [x] Golden snapshots re-recorded for all 7 datasets

## Test results
```
Public only:  289 passed, 3 skipped, 60 xfailed
With private: 19/19 regression pass, 1 pre-existing failure (pakistan-incremental D2),
              2 pre-existing PCA dimension failures (bg2050/pakistan incremental)
```

## Regression diff analysis
All 142 diffs per dataset are in `comment_repness[*].repness` — the repness value changes
when repful classification flips (agree→disagree or vice versa), switching from `ra` to `rd`.
No changes in PCA, clustering, group_repness selection, or any other field.
