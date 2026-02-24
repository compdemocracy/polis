# Dead and Unreachable Code

## 1. Python (Delphi) Dead Code

### 1.1 `_compute_votes_base()` — Dead Code with Bug

**File**: `conversation.py` lines 1047–1093
**Status**: DEAD — Never called from `recompute()` or any other pipeline method
**Bug**: Line 1076 uses `self.rating_mat[:, 'tid']` which is invalid pandas syntax. Should be `self.rating_mat[tid]`.
**Note**: Marked with `TODO(julien): why is that not called anywhere?`

The `to_dict()` method (lines 1497–1521) has its own inline votes-base computation that IS used for serialization, making this method redundant.

### 1.2 Custom `kmeans()` function — Dead Code

**File**: `clusters.py` lines 383–419
**Status**: DEAD — The pipeline uses `kmeans_sklearn()` exclusively
**Related dead code**:
- `cluster_step()` (lines 219–250) — only called by custom `kmeans()`
- `assign_points_to_clusters()` (lines 164–188) — only called by `cluster_step()`
- `update_cluster_centers()` (lines 191–203) — only called by `cluster_step()`
- `filter_empty_clusters()` (lines 206–216) — only called by `cluster_step()`
- `same_clustering()` (lines 135–161) — only called by custom `kmeans()`
- `clean_start_clusters()` (lines 318–380) — only called by custom `kmeans()`
- `split_cluster()` (lines 279–315) — only called by `clean_start_clusters()`
- `most_distal()` (lines 253–276) — only called by `split_cluster()`
- `distance_matrix()` (lines 422–441) — only called by custom `silhouette()`
- Custom `silhouette()` (lines 444–503) — pipeline uses `calculate_silhouette_sklearn()`

### 1.3 `cluster_dataframe()` — Dead Code

**File**: `clusters.py` lines 729–790
**Status**: DEAD — The pipeline calls `kmeans_sklearn()` directly from `_compute_clusters()`
**Related**: `determine_k()` (lines 689–726) is only called by `cluster_dataframe()`, making it also dead.

### 1.4 `clusters_from_dict()` — Dead Code

**File**: `clusters.py` lines 536–564
**Status**: DEAD — Used by `cluster_dataframe()` which is dead. The pipeline constructs clusters as plain dicts, not `Cluster` objects.

### 1.5 `clusters_to_dict()` — Dead Code

**File**: `clusters.py` lines 506–533
**Status**: DEAD — Same reason as above.

### 1.6 `Cluster` class — Partially Dead

**File**: `clusters.py` lines 19–79
**Status**: PARTIALLY DEAD — The `Cluster` class is used by the dead custom `kmeans()` chain but not by `kmeans_sklearn()`. The pipeline works with plain dicts instead.

### 1.7 Legacy `comment_stats()`, `add_comparative_stats()`, etc. — Dead Code

**File**: `repness.py` lines 118–392
**Status**: DEAD — These are the non-vectorized versions. The pipeline uses the vectorized DataFrame functions (`compute_group_comment_stats_df`, `select_rep_comments_df`, etc.) exclusively via `conv_repness()`.

Specifically dead:
- `comment_stats()` (lines 118–154)
- `add_comparative_stats()` (lines 157–186)
- `finalize_cmt_stats()` (lines 213–243)
- `passes_by_test()` (lines 246–268)
- `best_agree()` (lines 271–290)
- `best_disagree()` (lines 293–312)
- `select_rep_comments()` (lines 315–392)
- `select_consensus_comments()` (lines 413–454)

The vectorized replacements (`compute_group_comment_stats_df`, `select_rep_comments_df`, `select_consensus_comments_df`) are used instead.

### 1.8 `calculate_kl_divergence()` — Dead Code

**File**: `repness.py` lines 395–410
**Status**: DEAD — Never called from anywhere.

### 1.9 `_compute_group_votes()` — Partially Dead

**File**: `conversation.py` lines 1095–1177
**Status**: Called by `_compute_group_aware_consensus()` which is called from nowhere in the main pipeline. The `to_dict()` method has its own inline group-votes computation.

### 1.10 `_compute_group_aware_consensus()` — Dead Code

**File**: `conversation.py` lines 1291–1349
**Status**: DEAD — Never called from `recompute()`. The `to_dict()` method has its own inline consensus computation.

### 1.11 `comment_priorities` attribute — Dead Code

**File**: `conversation.py` lines 1039–1041, 1452–1453
**Status**: The attribute is checked in `to_dict()` and `get_full_data()` but never populated by any pipeline method.

---

## 2. Python Code That Is Used But Has Issues

### 2.1 `_get_in_conv_participants()` — Used but Wrong Formula

**File**: `conversation.py` lines 1225–1248
**Status**: ACTIVE but uses wrong threshold formula (see D2 in discrepancies)

### 2.2 `to_dict()` In-Conv — Used but Different from Pipeline

**File**: `conversation.py` lines 1637–1644
**Status**: ACTIVE — Uses `min(7, n_cmts)` threshold (matching Clojure) but only for serialization output, not for the actual clustering pipeline.

### 2.3 `repness.py` Z_90 = 1.645 — Used but Wrong Value

**File**: `repness.py` line 19
**Status**: ACTIVE — Should be 1.2816 to match Clojure (see D9 in discrepancies)

---

## 3. Clojure Dead Code

### 3.1 `choose-group-k` — Commented Out

**File**: `conversation.clj` lines 97–101
**Status**: DEAD — Commented out, replaced by silhouette-based k-selection.

### 3.2 `cmnt-proj` binding — Commented Out

**File**: `conversation.clj` lines 391–393
**Status**: DEAD — Commented out in favor of computing projection+extremity together in `with-proj-and-extremtiy`.

---

## 4. Summary

| Category | Count | Impact |
|----------|-------|--------|
| Dead pipeline methods (Python) | 3 (`_compute_votes_base`, `_compute_group_votes`, `_compute_group_aware_consensus`) | None (unused) |
| Dead utility functions (Python) | ~15 (custom kmeans chain, non-vectorized repness) | None (unused) |
| Dead but referenced attributes (Python) | 1 (`comment_priorities`) | Confusing — suggests feature is implemented when it's not |
| Active code with bugs (Python) | 3 (in-conv threshold, Z_90 value, to_dict inconsistency) | HIGH |
| Dead Clojure code | 2 (commented out, harmless) | None |
