# Fix Plan: Bringing Python to Clojure Parity

## Prioritized Fix Order

Fixes are ordered by: (1) cascading impact, (2) severity, (3) ease of implementation. Items that affect downstream computations come first.

---

## Phase 1: Foundation Fixes (Highest Priority)

### Fix 1: In-Conv Participant Threshold [D2]

**Files to modify**: `delphi/polismath/conversation/conversation.py`

**Current** (lines 1237–1238):
```python
threshold = 7 + np.sqrt(n_cmts) * 0.1
```

**Target**:
```python
threshold = min(7, n_cmts)
```

**Additional changes needed**:
1. Use `self.raw_rating_mat` instead of `self.rating_mat` for vote counting
2. Add monotonic persistence: store `self._in_conv` set, union with new qualifiers
3. Add greedy fallback: if `len(in_conv) < 15`, add top voters until reaching 15

**Estimated effort**: 1–2 hours

### Fix 2: Z-Score Significance Thresholds [D9]

**Files to modify**: `delphi/polismath/pca_kmeans_rep/repness.py`

**Current** (line 19):
```python
Z_90 = 1.645
Z_95 = 1.96
```

**Target**:
```python
Z_90 = 1.2816   # one-tailed, matching Clojure
Z_95 = 1.6449   # one-tailed, matching Clojure
```

**Estimated effort**: 5 minutes

### Fix 3: Pseudocount Formula [D4]

**Files to modify**: `delphi/polismath/pca_kmeans_rep/repness.py`

**Current** (line 35):
```python
PSEUDO_COUNT = 1.5
```

**Target**:
```python
PSEUDO_COUNT = 2.0  # +1 numerator, +2 denominator, matching Clojure Beta(2,2) prior
```

Verify that `pa = (na + PSEUDO_COUNT/2) / (ns + PSEUDO_COUNT)` with `PSEUDO_COUNT=2.0` gives `pa = (na + 1) / (ns + 2)`, which matches Clojure. ✓

**Estimated effort**: 5 minutes

### Fix 4: Proportion Test Formula [D5]

**Files to modify**: `delphi/polismath/pca_kmeans_rep/repness.py`

**Current** (`prop_test`, lines 64–86):
```python
def prop_test(p, n, p0):
    se = math.sqrt(p0 * (1 - p0) / n)
    return (p - p0) / se
```

**Target** (match Clojure's `stats.clj:prop-test`):
```python
def prop_test(succ, n):
    """Clojure-compatible proportion test.
    z = 2 * sqrt(n+1) * ((succ+1)/(n+1) - 0.5)
    """
    if n == 0:
        return 0.0
    return 2 * math.sqrt(n + 1) * ((succ + 1) / (n + 1) - 0.5)
```

**Note**: This changes the function signature from `(p, n, p0)` to `(succ, n)`. All callers need to be updated. The vectorized version (`prop_test_vectorized`) also needs updating.

**Estimated effort**: 1 hour (including caller updates and vectorized version)

---

## Phase 2: Repness Metric Fixes

### Fix 5: Repness Metric Formula [D7]

**Files to modify**: `delphi/polismath/pca_kmeans_rep/repness.py`

**Current** (`repness_metric`, lines 189–210):
```python
p_factor = p if key_prefix == 'a' else (1 - p)
return p_factor * (abs(p_test) + abs(r_test))
```

**Target** (match Clojure's product of 4):
```python
def repness_metric(stats, key_prefix):
    p = stats[f'p{key_prefix}']       # pa or pd
    p_test = stats[f'p{key_prefix}t'] # pat or pdt
    r = stats[f'r{key_prefix}']       # ra or rd
    r_test = stats[f'r{key_prefix}t'] # rat or rdt
    return r * r_test * p * p_test
```

**Also update vectorized version** in `compute_group_comment_stats_df`:
```python
# Current (lines 649–650):
stats_df['agree_metric'] = stats_df['pa'] * (stats_df['pat'].abs() + stats_df['rat'].abs())
stats_df['disagree_metric'] = (1 - stats_df['pd']) * (stats_df['pdt'].abs() + stats_df['rdt'].abs())

# Target:
stats_df['agree_metric'] = stats_df['ra'] * stats_df['rat'] * stats_df['pa'] * stats_df['pat']
stats_df['disagree_metric'] = stats_df['rd'] * stats_df['rdt'] * stats_df['pd'] * stats_df['pdt']
```

**Estimated effort**: 30 minutes

### Fix 6: Finalize Comment Stats Logic [D8]

**Files to modify**: `delphi/polismath/pca_kmeans_rep/repness.py`

**Current** (`finalize_cmt_stats`, lines 230–241):
```python
if result['pa'] > 0.5 and result['ra'] > 1.0:
    result['repful'] = 'agree'
elif result['pd'] > 0.5 and result['rd'] > 1.0:
    result['repful'] = 'disagree'
else: ...
```

**Target** (match Clojure's simple comparison):
```python
if result['rat'] > result['rdt']:
    result['repful'] = 'agree'
else:
    result['repful'] = 'disagree'
```

**Also update vectorized version** in `compute_group_comment_stats_df` (lines 656–663):
```python
# Target:
stats_df['repful'] = np.where(stats_df['rat'] > stats_df['rdt'], 'agree', 'disagree')
```

**Estimated effort**: 15 minutes

### Fix 7: Two-Proportion Test Adjustment [D6]

**Files to modify**: `delphi/polismath/pca_kmeans_rep/repness.py`

**Current** (`two_prop_test`, lines 89–115):
```python
def two_prop_test(p1, n1, p2, n2):
    p = (p1 * n1 + p2 * n2) / (n1 + n2)
    ...
```

**Target** (add +1 pseudocount like Clojure):
```python
def two_prop_test(succ1, n1, succ2, n2):
    """Clojure-compatible two-proportion test with +1 pseudocounts."""
    succ1, n1 = succ1 + 1, n1 + 1
    succ2, n2 = succ2 + 1, n2 + 1
    p1 = succ1 / n1
    p2 = succ2 / n2
    p = (succ1 + succ2) / (n1 + n2)
    se = math.sqrt(p * (1 - p) * (1/n1 + 1/n2))
    if se == 0:
        return 0.0
    return (p1 - p2) / se
```

**Note**: Signature changes from proportions to counts. Callers must be updated.

**Estimated effort**: 1 hour

---

## Phase 3: Selection & Consensus Fixes

### Fix 8: Representative Comment Selection [D10]

**Files to modify**: `delphi/polismath/pca_kmeans_rep/repness.py`

Match Clojure's `select-rep-comments` logic:
- Single pass with beats-best-by-test? and passes-by-test?
- Up to 5 total comments (agrees prioritized over disagrees)

**Estimated effort**: 2–3 hours (algorithm redesign)

### Fix 9: Consensus Comment Selection [D11]

**Files to modify**: `delphi/polismath/pca_kmeans_rep/repness.py`

Match Clojure's `consensus-stats` + `select-consensus-comments`:
- Per-comment stats with `pa = (A+1)/(S+2)` smoothing
- Top 5 agree (pa > 0.5) + top 5 disagree (pd > 0.5)
- Include z-test scores via `format-stat`

**Estimated effort**: 2–3 hours

---

## Phase 4: K-Smoother and Comment Priorities

### Fix 10: K-Smoother Buffer [D3]

**Files to modify**: `delphi/polismath/conversation/conversation.py`

Add state tracking to `Conversation`:
```python
# In __init__:
self.group_k_smoother = {
    'last_k': None,
    'last_k_count': 0,
    'smoothed_k': None
}

# In _compute_clusters(), after finding best_k by silhouette:
GROUP_K_BUFFER = 4
smoother = self.group_k_smoother
this_k = best_k
same = (smoother['last_k'] is not None and this_k == smoother['last_k'])
this_k_count = smoother['last_k_count'] + 1 if same else 1

if this_k_count >= GROUP_K_BUFFER:
    smoothed_k = this_k
else:
    smoothed_k = smoother['smoothed_k'] if smoother['smoothed_k'] is not None else this_k

self.group_k_smoother = {
    'last_k': this_k,
    'last_k_count': this_k_count,
    'smoothed_k': smoothed_k
}

# Use smoothed_k instead of best_k for the actual clustering
```

**Estimated effort**: 1–2 hours

### Fix 11: Comment Priorities [D12]

**Files to modify**: `delphi/polismath/conversation/conversation.py`, `delphi/polismath/pca_kmeans_rep/pca.py`

**Step 1**: Add comment projection and extremity to PCA:
```python
# In pca.py, after computing components:
comment_projection = pca.components_  # (n_comps × n_comments)
comment_extremity = np.linalg.norm(comment_projection, axis=0)
# Add to pca_results
pca_results['comment-projection'] = comment_projection
pca_results['comment-extremity'] = comment_extremity
```

**Step 2**: Implement `importance_metric`:
```python
def importance_metric(A, P, S, E):
    p = (P + 1) / (S + 2)
    a = (A + 1) / (S + 2)
    return (1 - p) * (E + 1) * a
```

**Step 3**: Implement `priority_metric`:
```python
META_PRIORITY = 7

def priority_metric(is_meta, A, P, S, E):
    if is_meta:
        return META_PRIORITY ** 2  # = 49
    imp = importance_metric(A, P, S, E)
    novelty = 1 + 8 * (2 ** (S / -5))
    return (imp * novelty) ** 2
```

**Step 4**: Compute priorities in `recompute()`:
```python
def _compute_comment_priorities(self):
    group_votes = self._compute_group_votes()
    extremities = dict(zip(
        self.rating_mat.columns,
        self.pca.get('comment-extremity', np.zeros(len(self.rating_mat.columns)))
    ))

    priorities = {}
    for tid in self.rating_mat.columns:
        total_A = total_D = total_S = total_P = 0
        for gid, gdata in group_votes.items():
            v = gdata['votes'].get(tid, {'A': 0, 'D': 0, 'S': 0})
            total_A += v['A']
            total_D += v['D']
            total_S += v['S']
            total_P += v['S'] - v['A'] - v['D']

        E = extremities.get(tid, 0)
        is_meta = tid in self.meta_tids if self.meta_tids else False
        priorities[tid] = priority_metric(is_meta, total_A, total_P, total_S, E)

    self.comment_priorities = priorities
```

**Step 5**: Call from `recompute()` after `_compute_repness()`.

**Estimated effort**: 4–6 hours

---

## Phase 5: Cleanup

### Fix 12: Remove Dead Code

Remove the extensive dead code identified in `08-dead-code.md`:
- Custom kmeans chain in `clusters.py`
- Non-vectorized repness functions in `repness.py`
- Buggy `_compute_votes_base()` in `conversation.py`

**Estimated effort**: 1–2 hours

### Fix 13: Resolve Internal Inconsistencies

- Remove or align `stats.py:prop_test` with the repness version
- Remove `stats.py:z_sig_90` (uses 1.2816) since `repness.py` is authoritative

**Estimated effort**: 30 minutes

---

## Testing Strategy

### Unit Tests Per Fix

Each fix should include tests comparing Python output to known Clojure output:

1. **In-conv test**: Given a vote matrix with known vote counts, verify the same participants qualify
2. **Proportion test**: Compare z-scores for specific (succ, n) pairs
3. **Repness metric test**: Compute metric for known stats, compare to Clojure value
4. **Full pipeline test**: Run both implementations on the same small dataset and compare:
   - PCA projections (direction, not exact values due to SVD vs power iteration)
   - Cluster assignments
   - Representative comments per group
   - Consensus comments
   - Comment priorities

### Integration Test

Use a real conversation dataset (export from production) and run both pipelines, comparing:
- Group count
- Group membership overlap
- Representative comment overlap
- Priority ranking correlation (Spearman rank)

---

## Timeline Estimate

| Phase | Fixes | Effort | Dependencies |
|-------|-------|--------|-------------|
| Phase 1 | D2, D9, D4, D5 | 3–4 hours | None |
| Phase 2 | D7, D8, D6 | 2–3 hours | Phase 1 |
| Phase 3 | D10, D11 | 4–6 hours | Phase 2 |
| Phase 4 | D3, D12 | 6–8 hours | Phase 3 |
| Phase 5 | Cleanup | 2–3 hours | All above |
| Testing | Unit + integration | 4–6 hours | All above |
| **Total** | | **21–30 hours** | |

---

## Future: sklearn Streamlining

Once parity is achieved, opportunities to leverage sklearn more effectively:

1. **PCA**: Already using sklearn. Could use `IncrementalPCA` for warm-starting and large-conversation support.
2. **K-means**: Already using sklearn. The custom `kmeans()` is dead code and can be removed.
3. **Silhouette**: Already using sklearn.
4. **Statistical tests**: Could use `scipy.stats.proportions_ztest` instead of custom implementations, BUT need to ensure the pseudocount behavior matches Clojure.
5. **Clustering pipeline**: Could use sklearn's `Pipeline` or custom pipeline class for cleaner composition.

**Important**: Any sklearn adoption must preserve the exact mathematical behavior of the Clojure implementation. The goal is code simplification, not behavioral change.
