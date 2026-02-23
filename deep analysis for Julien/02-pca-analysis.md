# PCA Implementation Analysis

## 1. Mathematical Foundation

Both implementations perform PCA on the vote matrix `V` of shape `(n_participants × n_comments)` where entries are `{-1, 0, 1, NaN}`. The goal is to find a 2D projection that captures maximum variance in participant opinions.

### 1.1 Missing Data Imputation

Both implementations replace `NaN` (unvoted) entries with column means before PCA:

**Clojure** (`conversation.clj` lines 356–377):
```clojure
;; replace? nil?   ← only replaces nil, not 0 (pass votes)
column-averages = mean of non-nil values per column
mat[i][j] = column-averages[j]  if mat[i][j] is nil
```

**Python** (`pca.py` lines 42–50):
```python
col_means = np.nanmean(matrix_data, axis=0)
nan_indices = np.where(np.isnan(matrix_data))
matrix_data_no_nan[nan_indices] = col_means[nan_indices[1]]
```

**Status: MATCH** — Both impute with column means. Clojure replaces `nil?` (not `0`), Python replaces `NaN`. Since pass votes are stored as `0` in Clojure and also `0` in Python (with `NaN` for unvoted), these are equivalent.

---

## 2. PCA Computation

### 2.1 Clojure: Power Iteration (`pca.clj`)

The Clojure implementation uses **power iteration** (also called the power method) to find eigenvectors of the covariance matrix iteratively.

**Algorithm** (`pca.clj:powerit-pca`):

Given centered data matrix `X` (n × p), find top-k eigenvectors:

```
For each component i = 1..k:
    v_i ← random unit vector of dimension p
    For iter = 1..100:
        v_i ← X^T · X · v_i        (multiply by covariance matrix)
        v_i ← v_i - Σ_{j<i} (v_i · v_j) v_j   (Gram-Schmidt orthogonalization)
        v_i ← v_i / ||v_i||         (normalize)
    components[i] = v_i
```

Key properties:
- **100 iterations** by default (`pca-iters` option)
- Uses previous components as `start-vectors` for warm-starting across updates
- Random initialization from uniform distribution
- Gram-Schmidt ensures orthogonality between components

**Center computation** (`pca.clj:wrapped-pca`):
```
center = column means of the imputed matrix
centered_data = matrix - center (broadcast subtraction)
```

### 2.2 Python: sklearn SVD (`pca.py`)

**Algorithm** (`pca.py` lines 69–82):

```python
center = np.mean(matrix_data_no_nan, axis=0)
cntrd_data = matrix_data_no_nan - center
pca = PCA(n_components=2)
projections = pca.fit_transform(cntrd_data)
```

sklearn's `PCA` uses **truncated SVD** internally:
```
X = U · Σ · V^T
components = V[:n_comps]        (top-k right singular vectors)
projections = X · V[:n_comps]^T  (equivalently: U[:,:n_comps] · Σ[:n_comps])
```

Key properties:
- Fixed random seed (42) for reproducibility
- No warm-starting from previous components
- Single-shot computation (no iterative refinement across updates)

### 2.3 DISCREPANCY: PCA Method

| Property | Clojure | Python |
|----------|---------|--------|
| Algorithm | Power iteration | SVD (sklearn) |
| Iterations | 100 per update | 1 (full SVD) |
| Warm-start | Yes (`start-vectors`) | No |
| Determinism | Random init (varies) | seed=42 (fixed) |
| Large conv | Mini-batch with learning rate | Same as small |

**Impact**: For well-separated eigenvalues, both converge to the same subspace. However:
- Power iteration may find slightly different orientations (sign flips, rotations within the eigenspace)
- Warm-starting means Clojure's PCA is **temporally stable** — small vote additions cause small PCA changes. Python recomputes from scratch each time, potentially causing jumps.
- For large conversations (>10K participants), Clojure uses mini-batch PCA with learning rate 0.01; Python has no such optimization.

---

## 3. Sparsity-Aware Projection

Both implementations apply identical sparsity-aware scaling to projections. This is critical for fair treatment of participants who have voted on few comments.

### 3.1 Mathematical Formula

For participant `i` with projection `p_i = [p_{i,1}, p_{i,2}]`:

```
n_votes_i = number of non-NaN entries in row i
n_comments = total number of comments
scaling_i = sqrt(n_comments / max(n_votes_i, 1))
scaled_projection_i = p_i × scaling_i
```

Participants who have voted on fewer comments get **pushed outward** (larger scaling factor), compensating for the bias toward the center caused by mean imputation.

### 3.2 Clojure (`pca.clj:sparsity-aware-project-ptpt`)

```clojure
(defn sparsity-aware-project-ptpt [votes {:keys [comps center]}]
  (let [n-cmnts (count center)
        clean-votes (map #(if (nil? %) 0 %) votes)
        n-votes (count (remove nil? votes))
        centered (map - clean-votes center)
        projections (mapv #(reduce + (map * centered %)) comps)]
    (mapv #(* (Math/sqrt (/ n-cmnts (max n-votes 1))) %) projections)))
```

Note: Clojure projects each participant individually using dot products with components, then scales.

### 3.3 Python (`pca.py` lines 96–102)

```python
n_cmnts = matrix_data.shape[1]
n_seen = np.sum(~np.isnan(matrix_data), axis=1)
n_seen_safe = np.maximum(n_seen, 1)
proportions = np.sqrt(n_seen_safe / n_cmnts)
scaled_projections = projections / proportions[:, np.newaxis]
```

**IMPORTANT**: Python divides by `sqrt(n_seen/n_cmnts)`, which equals multiplying by `sqrt(n_cmnts/n_seen)`. This is mathematically equivalent to the Clojure formula.

**Status: MATCH** — The sparsity-aware scaling is equivalent between both implementations.

---

## 4. Comment Projection and Extremity

**Clojure only** (`conversation.clj` lines 338–349):

Clojure also projects comments into the PCA space and computes their "extremity" (distance from origin):

```clojure
cmnt-proj = pca-project-cmnts(pca)        ;; project each comment onto PC axes
cmnt-extremity[j] = ||cmnt-proj[j]||       ;; L2 norm of comment's projection
```

This extremity is used in the `priority-metric` for comment routing.

**Python**: Does NOT compute comment projection or extremity. This is a **missing feature** that affects comment priority computation.

---

## 5. Large Conversation Handling

### 5.1 Clojure Mini-Batch PCA (`conversation.clj` lines 706–755)

For conversations with >10K participants or >5K comments, Clojure uses **mini-batch PCA**:

```
sample_size = interpolate(n_ptpts, start=(100,1500), stop=(1500,150000))
For iter = 1..pca_iters:
    indices = random_sample(range(n_ptpts), size=sample_size)
    subset = mat[indices, :]
    part_pca = powerit_pca(subset, start_vectors=current_pca.comps, iters=10)
    pca.center = 0.99 * pca.center + 0.01 * part_pca.center
    pca.comps  = 0.99 * pca.comps  + 0.01 * part_pca.comps
```

The learning rate of 0.01 ensures gradual adaptation. The `sample-size-fn` linearly interpolates between (100 samples at 1500 participants) and (1500 samples at 150000 participants).

### 5.2 Python

**No large-conversation optimization exists.** Python always runs full sklearn PCA on the entire matrix. This could become a performance bottleneck for very large conversations.

**Status: MISSING in Python**
