# K-Divergence Investigation — RESOLVED

## Problem (was)

After all cold-start-relevant formula fixes (D2-D15), Python and Clojure
selected different k values on cold-start blobs. On vw: Python=4, Clojure=2.

## Root Cause: Participant Row Ordering

The k divergence was caused by **different participant ordering in the rating
matrix**, which cascades through base-cluster IDs into group-level k-means
initialization via first-k-distinct.

### The chain

```
rating_mat row order
  → PCA projection order
    → base-cluster ID assignment (map-indexed on input rows)
      → group-level k-means first-k-distinct init (first k base-cluster centers)
        → different local optima → different silhouette scores → different k
```

### Clojure ordering

Clojure's NamedMatrix preserves **insertion order** (backed by
`java.util.Vector`). When `rowname-subset` filters to `in-conv` participants,
`filter-by-index` (utils.clj:128-133) preserves the **original matrix row
order** (iterates source, checks membership in filter set). So the base-cluster
ordering is the vote-encounter order of participants in the rating matrix.

### Python ordering (before fix)

Python used `natsorted()` (conversation.py:232) to sort rating matrix rows
by PID. This gave ascending PID order `[1, 2, 3, 4, 5, ...]` instead of
the vote-encounter order `[2, 3, 4, 6, 8, ...]` that Clojure produces.

### Impact

With first-k-distinct initialization, different ordering → different initial
centers → different k-means local optima → different silhouette landscape:

| k | Python (PID order) | Clojure (encounter order) |
|---|-------------------|--------------------------|
| 2 | sil=0.457         | **sil=0.487 (wins)**     |
| 3 | sil=0.481         | sil=0.329                |
| 4 | **sil=0.508 (wins)** | sil=0.362             |

## Fix

Changed `update_votes()` and `_apply_moderation()` to preserve vote-encounter
order for participant rows instead of natsort:

1. `update_votes()`: track first-appearance order from `vote_updates`, append
   new PIDs in encounter order (not `natsorted`)
2. `_apply_moderation()`: filter `raw_rating_mat.index` preserving order
   (list comprehension instead of `natsorted`)

Column (comment ID) ordering remains `natsorted` — column permutation doesn't
affect PCA eigenvalues/vectors, only reorders component loadings.

## Results after fix

| Dataset | CS blob | Clj k | Py k | Sizes match? |
|---------|---------|-------|------|--------------|
| vw | ✓ | 2 | **2** | [50,17] exact |
| biodiversity | ✓ | 2 | **2** | [81,19] exact |
| bg2018 | ✓ | 2 | **2** | close ([51,49] vs [52,48]) |
| FLI | ✓ | 2 | 3 | **still diverges** |
| engage | empty | — | — | — |
| bg2050 | empty | — | — | — |
| pakistan | empty | — | — | — |

### FLI: inherent PCA divergence (not fixable)

FLI has 94.5% NaN sparsity. The PCA components are nearly but not exactly
identical (|cos|≈0.9997 vs 1.000000 for vw). This produces a silhouette
landscape where k=2 and k=3 differ by only 0.001. The tiny PCA difference
tips the balance. Injection test confirms: with Clojure projections injected,
Python picks k=2. This is inherent to the PCA algorithm difference (sklearn
full SVD vs Clojure power iteration) and not fixable without replicating
Clojure's PCA exactly.

## Investigation Findings (for the record)

### PCA is NOT the primary cause for most datasets

- vw: PCA components have cosine similarity = 1.000000 (identical!)
- Projections are exactly negated (sign flip, irrelevant for clustering)
- Silhouette scores are identical for both projection sets

### Silhouette implementation matches

- Both use (b-a)/max(a,b) formula, unweighted mean
- Both compute on base-cluster centers (not raw participants)
- Clojure's `weighted-mean` without weights = unweighted mean

### K-means initialization matches

- Both use first-k-distinct (Clojure: `init-clusters`, Python: `_get_first_k_distinct_centers`)
- Both sort base clusters by ID
- The only difference was the DATA ORDER feeding into first-k-distinct

## Files modified

- `delphi/polismath/conversation/conversation.py` — `update_votes()` and `_apply_moderation()`
- `delphi/tests/test_conversation.py` — updated ordering tests
- `delphi/tests/test_legacy_clojure_regression.py` — removed xfail on `test_group_clustering`

## Future investigation

- **FLI k divergence**: Could be resolved by implementing Clojure's power
  iteration PCA. Low priority — the silhouette gap is 0.001.
- **Column ordering**: Currently natsorted, Clojure uses insertion order.
  Doesn't affect clustering but could affect other comparisons.
- **Multiple k-means restarts**: Using k-means++ with n_init=10 finds the
  global optimum (k=4 for vw) regardless of ordering. This would be more
  robust than first-k-distinct but would NOT match Clojure.
