# Subgroup Clustering - Third Level (Not Yet Implemented)

## Overview

The Clojure implementation has a **third level** of clustering called "subgroups" that is NOT implemented in Python and appears NOT to be used by the TypeScript server/client code.

## Three-Level Hierarchy in Clojure

### Level 1: Base Clusters
- **Field**: `base-clusters`
- **Input**: Participant PCA projections
- **Output**: ~100 base clusters
- **Members**: Participant IDs
- **Format**: Folded dict `{id: [...], members: [[pid, pid]], x: [...], y: [...]}`

### Level 2: Group Clusters
- **Field**: `group-clusters`
- **Input**: Base cluster centers
- **Output**: 2-5 groups
- **Members**: Base cluster IDs
- **Format**: List `[{id, members: [base-cluster-ids], center}]`
- **Selection**: Silhouette coefficient

### Level 3: Subgroup Clusters (NOT IN PYTHON)
- **Field**: `subgroup-clusters`
- **Input**: Base clusters **within each group**
- **Output**: 2-N subgroups per group
- **Members**: Base cluster IDs (subset from parent group)
- **Format**: Dict `{group-id: [{id, members: [base-cluster-ids], center, parent-id}]}`
- **Selection**: Silhouette coefficient per group

## Clojure Implementation Details

### Location
- File: `math/src/polismath/math/conversation.clj`
- Lines: 480-570

### Algorithm (conversation.clj:483-510)

For each group cluster:
1. Extract the base cluster IDs that belong to that group (`group-cluster.members`)
2. Get the base cluster projections for only those base clusters
3. Run k-means with k ∈ [2, max-k] using the same max-k formula
4. Compute silhouette scores for each k
5. Use k-smoothing buffer to avoid flapping
6. Store result as `{group-id: subgroups}` with each subgroup having `parent-id` set

### Data Structures Generated

```clojure
;; For each group, cluster its base clusters into subgroups
:subgroup-clusterings
  {0 {2 [clusters-k2], 3 [clusters-k3], ...}  ; group 0 at different k values
   1 {2 [clusters-k2], 3 [clusters-k3], ...}  ; group 1 at different k values
   ...}

;; Best k selected per group
:subgroup-clusters
  {0 [{id: 0, members: [base-cluster-ids], parent-id: 0}, ...]
   1 [{id: 0, members: [base-cluster-ids], parent-id: 1}, ...]
   ...}

;; Vote aggregations at subgroup level
:subgroup-votes
  {0 {0 {votes: {tid: {A, D, S}}}, 1 {...}}  ; group 0's subgroups
   1 {0 {votes: {tid: {A, D, S}}}, 1 {...}}  ; group 1's subgroups
   ...}

;; Representative comments per subgroup
:subgroup-repness
  {0 {0 {tid: [repness-data]}, 1 {...}}
   1 {0 {tid: [repness-data]}, 1 {...}}
   ...}

;; Participant statistics per subgroup
:subgroup-ptpt-stats
  {0 {0 [ptpt-stats], 1 [...]}, ...}
```

### Usage in Clojure (conversation.clj:606-693)

Subgroups are used to compute:
- **`subgroup-votes`** (line 606): Vote aggregations per subgroup (finer granularity than `group-votes`)
- **`subgroup-repness`** (line 677): Representative comments per subgroup
- **`subgroup-ptpt-stats`** (line 688): Participant statistics per subgroup

## Current Status

### Python Implementation
- **NOT IMPLEMENTED**: Python always sets `self.subgroup_clusters = {}`
- All Python golden snapshots have empty `{}` for:
  - `subgroup-votes`
  - `subgroup-repness`
  - `subgroup-clusters`

### TypeScript/Server Usage
- **NOT USED**: No references to "subgroup" found in TypeScript/JavaScript server or client code
- Server appears to ignore these fields entirely

### Math Blob JSON Structure

Example from `r6vbnhffkxbd7ifmfbdrd_math_blob.json`:

```json
{
  "base-clusters": {
    "id": [0, 1, 2, ...],     // 68 base clusters
    "members": [[pids], ...],
    "x": [...],
    "y": [...]
  },
  "group-clusters": [
    {
      "id": 0,
      "members": [6, 33, 36, 42, 50],  // base cluster IDs
      "center": [...]
    },
    // ... 4 groups total
  ],
  "subgroup-clusters": {
    "0": [  // subgroups within group 0
      {
        "id": 0,
        "members": [42, 61],  // base cluster IDs from group 0
        "center": [...],
        "parent-id": 0
      },
      {
        "id": 1,
        "members": [6, 33, 36, 50, 69],
        "center": [...],
        "parent-id": 0
      }
    ],
    "1": [...],  // subgroups within group 1
    // ... one key per group
  }
}
```

## Analysis

### Purpose
Subgroups provide **finer-grained clustering within each major group**, allowing analysis of substructure. This could be useful for:
- Identifying minority opinions within a group
- Finding sub-coalitions
- More granular representative comment selection

### Why Not Implemented in Python?
1. **Not used by application**: TypeScript code doesn't reference these fields
2. **Adds complexity**: Third level increases computation and storage
3. **Diminishing returns**: Two levels may be sufficient for most use cases
4. **Legacy feature**: May have been experimental and never fully integrated

## Implementation Considerations

If subgroups are needed in the future:

### Algorithm
1. After computing group clusters, iterate over each group
2. For each group with sufficient base clusters (>10?):
   - Extract base cluster centers for that group's members
   - Run k-means with k ∈ [2, max-k]
   - Compute silhouette scores
   - Select best k (with smoothing buffer)
   - Add `parent-id` to each subgroup
3. Store as nested dict `{group-id: [subgroups]}`

### Code Location
- Update `conversation.py::_compute_clusters()` to add subgroup computation after group clustering
- Reuse `kmeans_sklearn()` and `calculate_silhouette_sklearn()` functions
- Apply same k-smoothing logic used for groups

### Testing
- Compare against Clojure math blobs that have populated subgroups
- Verify hierarchical structure: subgroup members ⊆ parent group members
- Check that `parent-id` references match group IDs

## Recommendation

**Keep subgroups as empty dicts for now** (`self.subgroup_clusters = {}`). They can be implemented later if needed, following the pattern established for group clustering.

## References

- **Clojure source**: `math/src/polismath/math/conversation.clj` lines 480-693
- **SESSION_HANDOFF**: `docs/SESSION_HANDOFF_KMEANS.md` (only documents 2 levels)
- **Clojure two-level doc**: `docs/CLOJURE_TWO_LEVEL_CLUSTERING.md` (should note this is actually 3 levels in Clojure)
