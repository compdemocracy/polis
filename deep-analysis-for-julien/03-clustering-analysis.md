# Clustering Analysis

## 1. Two-Level Hierarchical Clustering

Both implementations use a two-level clustering approach:

```
Level 1: Participants → ~100 base clusters (k-means on PCA projections)
Level 2: Base clusters → 2-5 group clusters (weighted k-means on base cluster centers)
```

The base clustering reduces the computational cost of the group-level clustering while preserving the distribution of participants in opinion space.

---

## 2. K-Means Implementation

### 2.1 Clojure (`clusters.clj`)

**Initialization** (`init-clusters`):
```clojure
;; Take first k distinct rows from the NamedMatrix in encounter order
(defn init-clusters [nmat k]
  (->> (nm/get-matrix nmat)
       distinct
       (take k)
       (mapv (fn [row] {:center row :members [] :id nil}))))
```

**Iteration** (`kmeans`):
```
1. Initialize clusters (init-clusters or clean-start-clusters if previous exists)
2. Repeat up to max-iters:
   a. Assign each point to nearest cluster center (Euclidean distance)
   b. Update centers as weighted mean of members
   c. Remove empty clusters
   d. If converged (same clustering as previous step, threshold=0.01), stop
3. Sort by :id
```

**Clean-start** (`clean-start-clusters`): When previous clusters exist:
```
1. Start with old cluster centers
2. Assign all current data points to nearest old center
3. If need more clusters: split largest cluster using most-distal point
4. If need fewer: merge closest pair
5. Run k-means from these starting positions
```

**Convergence** (`same-clustering?`, lines 68–76): Two clusterings are "same" if EVERY pairwise center distance is < threshold (0.01 default). Centers are sorted before comparison.

### 2.2 Python (`clusters.py`)

Python has TWO k-means implementations:

**Custom `kmeans()`** (lines 383–419): Mirrors Clojure's approach:
```python
clusters = clean_start_clusters(data, k, last_clusters)
for _ in range(max_iters):
    new_clusters = cluster_step(data, clusters, weights)
    if same_clustering(clusters, new_clusters):
        break
    clusters = new_clusters
```

**sklearn `kmeans_sklearn()`** (lines 595–665): Used in the actual pipeline:
```python
init = _get_first_k_distinct_centers(data, k)  # match Clojure init
kmeans = KMeans(n_clusters=k, init=init, n_init=1, algorithm='lloyd')
kmeans.fit(data, sample_weight=weights)
```

**Which is actually used?** The `_compute_clusters()` method in `conversation.py` (line 576) calls `kmeans_sklearn()`, NOT the custom `kmeans()`. The custom implementation is **dead code**.

---

## 3. Silhouette Coefficient

The silhouette coefficient measures clustering quality. For each point `i`:

```
a(i) = mean distance to other points in same cluster
b(i) = min over other clusters C: mean distance to points in C
s(i) = (b(i) - a(i)) / max(a(i), b(i))
```

Overall silhouette = mean of all s(i). Range: [-1, 1]. Higher is better.

### 3.1 Clojure (`clusters.clj:silhouette`)

Custom implementation using a **named distance matrix** (`named-dist-matrix`):
```clojure
;; Precomputes pairwise distances between all base cluster centers
;; Then computes silhouette using those distances
(defn silhouette [dist-matrix clustering]
  ;; For each cluster, for each member:
  ;;   a = avg distance to same-cluster members
  ;;   b = min avg distance to other-cluster members
  ;;   s = (b - a) / max(a, b)
  ;; Return mean of all s values
  )
```

### 3.2 Python

**Custom `silhouette()`** (lines 444–503): Direct implementation matching Clojure logic.

**sklearn `calculate_silhouette_sklearn()`** (lines 668–686): Wrapper around `sklearn.metrics.silhouette_score`.

The actual pipeline uses `calculate_silhouette_sklearn()` (`conversation.py` line 633).

---

## 4. Optimal k Selection

### 4.1 Clojure: k-smoother with Buffer

**Max k calculation** (`conversation.clj` lines 271–276):
```clojure
(defn max-k-fn [data max-max-k]
  (min max-max-k
       (+ 2 (int (/ (count (nm/rownames data)) 12)))))
;; max-max-k defaults to 5
;; Example: 100 base clusters → max-k = min(5, 2 + 100/12) = min(5, 10) = 5
```

**k-smoother** (`conversation.clj` lines 452–468):
```
State: {last-k, last-k-count, smoothed-k}
Algorithm:
  this-k = argmax_k silhouette(k)           # best k for current data
  if this-k == last-k:
      this-k-count = last-k-count + 1
  else:
      this-k-count = 1
  if this-k-count >= group-k-buffer (default 4):
      smoothed-k = this-k                    # switch to new k
  else:
      smoothed-k = previous smoothed-k       # keep old k
```

**Purpose**: Prevents the number of groups from flickering between values. A new k must be the best for **4 consecutive updates** before the system switches to it.

### 4.2 Python: Direct Best Silhouette

**Max k** (`conversation.py` line 614):
```python
max_k = min(MAX_K, 2 + len(base_clusters) // 12)
max_k = max(2, min(max_k, len(base_clusters)))
```

**k selection** (`conversation.py` lines 624–641):
```python
best_k = 2
best_score = -1
for k in range(2, max_k + 1):
    labels, centers, members = kmeans_sklearn(base_centers, k=k, weights=base_weights)
    score = calculate_silhouette_sklearn(base_centers, labels)
    if score > best_score:
        best_score = score
        best_k = k
```

### 4.3 DISCREPANCY: No k-smoother in Python

Python picks the best k by silhouette **every single update** without any buffering. This means:

1. Groups can flicker between k=2 and k=3 (or other values) on consecutive updates
2. Participants may see their group assignment change frequently
3. The visualization becomes unstable

**Impact**: HIGH — This is a user-visible instability.

---

## 5. Subgroup Clustering

### 5.1 Clojure (`conversation.clj` lines 480–570)

For each group cluster, Clojure runs another round of clustering:
```
For each group g:
    Get base clusters belonging to g
    For k = 2..max-k:
        Run k-means on those base cluster centers
    Apply k-smoother (same buffer logic)
    Store best subgroup clustering
```

This produces a second level of hierarchy: groups → subgroups.

### 5.2 Python

**No subgroup clustering exists.** The `subgroup_clusters` attribute is initialized to `{}` and never populated.

**Status: MISSING in Python**

---

## 6. `determine_k()` Function — Python Dead Code

Python has a `determine_k()` function (`clusters.py` lines 689–726) that uses a logarithmic heuristic:
```python
if n_rows < 10: return 2
if n_rows >= 500: k = 2 + int(min(1, log2(n_rows) / 10))
else:             k = 2 + int(min(2, log2(n_rows) / 5))
```

This function is **NOT used** in the actual pipeline. The pipeline uses the Clojure-matching `max_k` formula with silhouette selection. `determine_k()` is only called from `cluster_dataframe()`, which itself is not used in the main pipeline (the pipeline calls `kmeans_sklearn()` directly).

---

## 7. Cluster Output Format

### 7.1 Clojure

Group clusters are sorted by `:id` and contain:
```clojure
{:id 0
 :center [x, y]
 :members [bid1, bid2, ...]  ;; base cluster IDs
 :count n}
```

Base clusters contain:
```clojure
{:id 0
 :center [x, y]
 :members [pid1, pid2, ...]  ;; participant IDs
 :count n}
```

### 7.2 Python

Both levels use the same dict format:
```python
{'id': 0, 'center': [x, y], 'members': [...]}
```

Group clusters are sorted by size (descending) and re-assigned sequential IDs. This matches Clojure's behavior of sorting by `:id` after creation.

### 7.3 Base Cluster Folding

For serialization, Clojure uses a "folded" format:
```clojure
{:id [0 1 2 ...], :members [[...] [...] ...], :x [...], :y [...], :count [...]}
```

Python's `_fold_base_clusters()` (`conversation.py` lines 1250–1269) matches this format.
