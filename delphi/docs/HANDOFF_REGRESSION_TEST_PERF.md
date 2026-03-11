# Handoff: Regression Test Performance Investigation

## Problem

The `test_regression.py` tests are slow for large private datasets, particularly
`engage` (317s) and `pakistan` (179s). This was noticed during the D4 pseudocount
fix session but is **not caused by D4** — the pseudocount is just a constant and
has zero performance impact.

## Dataset Dimensions

| Dataset       |    Votes | Participants | Comments | t_regression | t_stages |
|---------------|----------|--------------|----------|--------------|----------|
| vw            |    4,683 |           69 |      125 |        3.02s |    0.62s |
| biodiversity  |   29,802 |          536 |      316 |       15.83s |    2.40s |
| FLI           |   91,364 |        1,090 |    1,454 |        8.72s |    9.61s |
| bg2018        |  226,232 |        2,044 |      896 |       13.66s |   11.21s |
| engage        |  442,583 |        5,531 |    7,728 |      317.33s |   59.97s |
| pakistan       |  400,075 |       18,081 |    9,034 |      196.47s |  178.89s |
| bg2050        |1,034,858 |        7,890 |    7,753 |      165.32s |   87.16s |

- `t_regression` = `test_conversation_regression` (runs benchmark: 3x full pipeline)
- `t_stages` = `test_conversation_stages_individually` (single pipeline run)

## Complexity Model

Fitted a linear model on vw, biodiversity, FLI, bg2018, pakistan (5 points),
then predicted engage and bg2050 (held out):

```
t_stages ≈ 1.66 + 3.87e-5 × votes + 9.90e-7 × (participants × comments)
```

R² = 0.9995 on fit data.

| Dataset       | Predicted |  Observed | Ratio |
|---------------|-----------|-----------|-------|
| vw            |     1.85s |     0.62s |  0.34 | (intercept dominates small datasets)
| biodiversity  |     2.98s |     2.40s |  0.81 |
| FLI           |     6.77s |     9.61s |  1.42 |
| bg2018        |    12.23s |    11.21s |  0.92 |
| **engage**    |  **61.12s** | **59.97s** | **0.98** | held out — predicted well
| pakistan       |   178.91s |   178.89s |  1.00 |
| **bg2050**    | **102.29s** | **87.16s** | **0.85** | held out — 15% over-prediction

**Conclusion: timings are fully explained by O(votes) + O(participants × comments).**

## Two Bottlenecks

### 1. `_compute_participant_info_optimized` — O(participants × groups × comments)

Location: `conversation.py:726-904`

Per-participant Python loop computing correlations with each group. For each of
the N participants:
- Slice participant votes: O(comments)
- For each group: mask + `np.corrcoef` on valid comments: O(comments)
- Total: O(participants × groups × comments)

For pakistan (18K × ~3 × 9K ≈ 486M ops), this dominates.

**Fix ideas:**
- Vectorize: compute all participant-group correlations as a single matrix operation
- Use `np.corrcoef` on the full (participants × comments) matrix at once
- Or skip participant_info entirely if it's not needed downstream

### 2. Benchmark mode runs pipeline 3×

`compare_with_golden(benchmark=True)` calls `compute_all_stages_with_benchmark`
which runs `compute_all_stages` **3 times** (n_runs=3). This is the main reason
`t_regression ≈ 5× t_stages` for large datasets.

**Fix: set `benchmark=False` in test_regression.py** (or make it opt-in).

### 3. Intermediate stages redundancy

`compute_all_stages` runs 6 stages including intermediate ones (empty, load-only,
PCA-only, PCA+clustering, full recompute, full data export). The full recompute
already includes everything — the intermediate stages exist for granular failure
detection in `test_conversation_stages_individually`.

**Question:** Are the intermediate stages actually useful? If a regression is
detected, the stage-level test tells you WHERE, but you could also just diff
the full recompute output. Consider:
- Keep intermediate stages for small datasets only
- Or compute them lazily (only if full recompute fails)
- Or remove them entirely and rely on diff-based debugging

## Files to Modify

- `tests/test_regression.py` — disable benchmark, possibly skip intermediate stages
- `polismath/regression/comparer.py:62` — `compare_with_golden(benchmark=True)` default
- `polismath/regression/utils.py:40` — `compute_all_stages()` intermediate stages
- `polismath/regression/utils.py:158` — `compute_all_stages_with_benchmark()` n_runs=3
- `polismath/conversation/conversation.py:726` — `_compute_participant_info_optimized`
