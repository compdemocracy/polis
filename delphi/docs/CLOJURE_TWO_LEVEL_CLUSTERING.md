# Clojure Two-Level Clustering Architecture

## Overview

**YES**, Clojure **ALWAYS** uses two-level hierarchical clustering, not conditionally.

## Architecture

### Level 1: Base Clusters (Participants → ~100 Base Clusters)

**Location**: `polismath/math/conversation.clj` lines 400-407

```clojure
:base-clusters
(plmb/fnk [conv proj-nmat in-conv opts']
  (let [in-conv-mat (nm/rowname-subset proj-nmat in-conv)]
    (sort-by :id
      (clusters/kmeans in-conv-mat
        (:base-k opts')          ; Default: 100
        :last-clusters (:base-clusters conv)
        :max-iters (:base-iters opts')))))
```

- **Input**: Participant PCA projections
- **k value**: `base-k = 100` (from `conversation.clj` line 145)
- **Output**: ~100 small clusters, each containing a few participants
- **Members**: Participant IDs (pids)

### Level 2: Group Clusters (Base Clusters → 2-5 Groups)

**Location**: `polismath/math/conversation.clj` lines 429-474

```clojure
:group-clusterings
(plmb/fnk [conv base-clusters-weights base-clusters-proj opts']
  (plmb/map-from-keys
    (fn [k]
      (sort-by :id
        (clusters/kmeans base-clusters-proj k
          :last-clusters (when-let [last-clusterings (:group-clusterings conv)]
                           (last-clusterings k))
          :cluster-iters (:group-iters opts')
          :weights base-clusters-weights)))
    (range 2 (inc (max-k-fn base-clusters-proj (:max-k opts'))))))

:group-clusters
(plmb/fnk [group-clusterings group-k-smoother]
  (get group-clusterings
    (:smoothed-k group-k-smoother)))
```

- **Input**: Base cluster centers (treating each base cluster as a data point)
- **k value**: Adaptive (2-5), selected using silhouette analysis
- **Output**: 2-5 final groups
- **Members**: Base cluster IDs (NOT participant IDs)
- **Weighted**: Uses base cluster sizes as weights

## Why Two-Level Clustering?

### Explicit Comments Found

From `conversation.clj` line 477:
```clojure
;; Now we're going to do the same thing for subclusters, or 2-level, 2-down hierarchical clustering
```

### No Direct Explanation Found

Despite extensive search, **no explicit documentation** was found explaining WHY this two-level architecture was chosen. However, based on the code structure, probable reasons include:

1. **Scalability**: Clustering 10,000 participants directly would be O(n²) expensive; clustering 100 base clusters is much faster
2. **Stability**: Small clusters stabilize more quickly; reduces flickering as new votes arrive
3. **Incremental Updates**: Base clusters can be updated incrementally (line 406 uses `:last-clusters`)
4. **Weighted Representation**: Larger base clusters carry more weight in group-level clustering
5. **Memory Efficiency**: Storing/transmitting ~100 base cluster centers vs 10,000 participant positions

### Default Configuration

From `conversation.clj` lines 142-147:
```clojure
:base-iters 100      ; Max iterations for base clustering
:base-k 100          ; Number of base clusters
:max-k 5             ; Max number of final groups
:group-iters 100     ; Max iterations for group clustering
```

## Storage Format

### Folded Format (for Database/JSON)

Base clusters are "folded" for efficient storage:

```clojure
{:id      [0 1 2 ...]           ; Base cluster IDs
 :members [[530 13 157] ...]    ; Participant IDs for each
 :x       [0.5 -0.3 ...]         ; X coordinates
 :y       [0.2 0.8 ...]          ; Y coordinates
 :count   [3 5 7 ...]}           ; Member counts
```

**Folding function**: `polismath/math/clusters.clj` lines 389-399

### Unfolded Format (for Processing)

When loaded back, clusters are unfolded:

```clojure
[{:id 0 :members [530 13 157] :center [0.5 0.2]}
 {:id 1 :members [42 88 199 234 301] :center [-0.3 0.8]}
 ...]
```

**Unfolding function**: `polismath/math/clusters.clj` lines 402-414

## Server-Side Usage

### Hierarchy is Maintained

The server-side TypeScript code (`server/src/report.ts` lines 132-175) maintains the two-level hierarchy:

```typescript
// 1. Find participant's base cluster
let baseClusterIndex = -1;
for (let i = 0; i < membersByIndex.length; i += 1) {
  const members = membersByIndex[i];
  if (Array.isArray(members) && members.includes(pid)) {
    baseClusterIndex = i;
    break;
  }
}

// 2. Get base cluster ID
const baseClusterId = baseClusterIds[baseClusterIndex];

// 3. Find which group contains this base cluster
for (const groupCluster of groupClustersArray) {
  if (groupCluster.members.includes(baseClusterId)) {
    return groupCluster.id;
  }
}
```

### Unfolding for Exports

For data exports, the hierarchy is flattened using `flatten-clusters` (`darwin/export.clj` lines 286-299):

```clojure
(defn flatten-clusters
  "Takes group clusters and base clusters and flattens them out into a cluster mapping to ptpt ids directly"
  [group-clusters base-clusters]
  (map
    (fn [gc]
      (update-in gc [:members]
        (fn [members]
          (mapcat
            (fn [bid]
              ;; get the base cluster, then get it's members, mapcat them
              (:members (ffilter #(= (:id %) bid) base-clusters)))
            members))))
    group-clusters))
```

This is used in:
- `participants-votes-table` - CSV exports
- Other export functions

## Python vs Clojure

### Python (Current Implementation)

- **Two-level**: Participants → Base Clusters → Groups (matching Clojure)
- **Unfolding**: Group cluster members are unfolded from base-cluster IDs to participant IDs for serialization and downstream consumers

### Clojure (Reference Implementation)

- **Two-level**: Participants → Base Clusters → Groups
- **More complex**: Additional level of indirection
- **Benefits**: Better scalability, stability, and incremental updates

## Implications for Migration

When comparing Python and Clojure implementations:

1. **Cannot compare directly**: Group members have different meanings
   - Python groups contain participant IDs
   - Clojure groups contain base cluster IDs

2. **Must unfold Clojure**: Convert base cluster IDs to participant IDs for fair comparison
   - Use `unfold_clojure_group_clusters()` in Python
   - Handles string/integer ID type conversion

3. **Architecture decision**: Should Python adopt two-level clustering?
   - **Pros**: Match Clojure behavior exactly, better scalability
   - **Cons**: More complexity, harder to maintain
   - **Current approach**: Keep single-level for simplicity until scalability becomes an issue

## References

- **Main clustering logic**: `polismath/math/conversation.clj` lines 400-474
- **Fold/unfold utilities**: `polismath/math/clusters.clj` lines 389-414
- **Server-side navigation**: `server/src/report.ts` lines 132-175
- **Export flattening**: `polismath/darwin/export.clj` lines 286-299
- **Python unfold implementation**: `polismath/regression/clojure_comparer.py` lines 123-199
