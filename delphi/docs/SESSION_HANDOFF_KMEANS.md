# K-means Two-Level Clustering - Session Handoff

> **Status (2026-06-11):** Two-level clustering and cold-start blob generation described below are merged (#2431, #2485). The k-divergence investigation concluded — see `INVESTIGATION_K_DIVERGENCE.md` (RESOLVED). Still open: incremental clustering warm-start (`:last-clusters`) and the D3 k-smoother, tracked in `PLAN_DISCREPANCY_FIXES.md`. Kept as background reference; do not treat its TODO lists as current.

## Goal

**Modify Python to match Clojure's EXACT two-level clustering architecture**, including:
1. Base clusters (participants → ~100 clusters)
2. Group clusters (base clusters → 2-5 groups with silhouette-based k selection)
3. Hierarchical storage format matching Clojure's output
4. Tests expecting exact hierarchical match

---

## Clojure Architecture (Reference)

### Two-Level Clustering (ALWAYS Used, Not Conditional)

Clojure ALWAYS uses two-level hierarchical clustering:

#### Level 1: Base Clusters

**Location**: `math/src/polismath/math/conversation.clj` lines 400-407

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

- **Input**: Participant PCA projections (filtered by `in-conv`)
- **k value**: `base-k = 100` (hardcoded default in line 145)
- **Output**: ~100 small clusters
- **Members**: Participant IDs (pids)

#### Level 2: Group Clusters

**Location**: `math/src/polismath/math/conversation.clj` lines 429-474

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
  (get group-clusterings (:smoothed-k group-k-smoother)))
```

- **Input**: Base cluster centers (each base cluster treated as a data point)
- **k range**: 2 to max-k (default max-k=5)
- **Selection**: Silhouette coefficient picks best k, with smoothing buffer
- **Weights**: Base cluster sizes as weights
- **Members**: Base cluster IDs (NOT participant IDs!)

### Default Configuration

From `conversation.clj` lines 142-147:
```clojure
:base-iters 100      ; Max iterations for base clustering
:base-k 100          ; Number of base clusters
:max-k 5             ; Max number of final groups
:group-iters 100     ; Max iterations for group clustering
:group-k-buffer 4    ; Smoothing buffer for k changes
```

### max-k Calculation

From `conversation.clj` lines 271-276:
```clojure
(defn max-k-fn [data max-max-k]
  (min max-max-k
       (+ 2 (int (/ (count (nm/rownames data)) 12)))))
```

Formula: `min(max-k, 2 + floor(n_base_clusters / 12))`

### Participant Filtering (`in-conv`)

From `conversation.clj` lines 239-266:
- Participants must have voted on enough comments to be included
- Threshold based on: `7 + sqrt(n-cmts) * 0.1`
- Once included, participants remain in `in-conv` permanently

### Storage Formats

#### Folded Format (for JSON/database)

```python
{
    "id": [0, 1, 2, ...],           # Base cluster IDs
    "members": [[530, 13], ...],    # Participant IDs for each
    "x": [0.5, -0.3, ...],          # X coordinates
    "y": [0.2, 0.8, ...],           # Y coordinates
    "count": [3, 5, ...]            # Member counts
}
```

#### Unfolded Format (for processing)

```python
[
    {"id": 0, "members": [530, 13, 157], "center": [0.5, 0.2]},
    {"id": 1, "members": [42, 88], "center": [-0.3, 0.8]},
    ...
]
```

---

## Current Python State (January 2026)

### ✅ What's Implemented

1. **Two-level clustering architecture**: Participants → base clusters → group clusters
2. **SKlearn KMeans integration**: Using `sklearn.cluster.KMeans` for all clustering
3. **First-k initialization**: Matches Clojure's deterministic initialization
4. **Silhouette-based k selection**: Tries k=2..5, picks best silhouette score
5. **Weighted k-means**: Group clustering uses base cluster sizes as weights
6. **Hierarchical storage**: Outputs `base-clusters` (folded) + `group-clusters`
7. **Participant filtering**: `_get_in_conv_participants()` implements threshold logic
8. **Fold/unfold utilities**: `_fold_base_clusters()` and `_unfold_base_clusters()`

Files modified:
- `polismath/pca_kmeans_rep/clusters.py`: Added `kmeans_sklearn()`, `calculate_silhouette_sklearn()`, `_get_first_k_distinct_centers()`
- `polismath/conversation/conversation.py`: Rewrote `_compute_clusters()` for two-level architecture

### ⚠️ What's Missing for Full Clojure Parity

1. **Incremental clustering continuity**: Using `:last-clusters` from previous computation (see below)
2. **k-smoothing buffer**: Group k selection should use `:group-k-buffer` to avoid flapping
3. **PCA sign consistency**: Python PCA may flip axis signs differently than Clojure

---

## ⚠️ CRITICAL: Incremental Update Pattern & Non-Determinism

### How Clojure Uses Previous Clusters

Clojure's clustering is **NOT stateless** - it uses previous clusters for warm-starting:

#### Base Clusters (Line 406)
```clojure
:last-clusters (:base-clusters conv)
```
- Loads previous `base-clusters` from `conv` object
- Uses them as initialization for new base clustering
- Provides **continuity** across updates

#### Group Clusters (Lines 438-439)
```clojure
:last-clusters (when-let [last-clusterings (:group-clusterings conv)]
                 (last-clusterings k))
```
- Loads previous `group-clusterings` map (ALL k values)
- Extracts clustering for specific k (e.g., previous k=3 clustering)
- If no previous clustering for that k, returns `nil` → first-k initialization

### Database Persistence Model

**Location**: `server/schema.sql` lines 640-645

```sql
CREATE TABLE math_main (
    zid integer NOT NULL,
    data jsonb NOT NULL,           -- The math_blob
    math_tick bigint NOT NULL,     -- Increments each update
    UNIQUE (zid, math_env)         -- ← Only ONE row per conversation!
);
```

**Key Facts:**
1. **No versioning**: Only ONE row exists per conversation
2. **Overwrites**: Each computation replaces previous `data` jsonb
3. **No history**: Previous cluster states are LOST after overwrite
4. **`math_tick` increments**: But doesn't preserve old data

### What Gets Persisted vs Ephemeral

From `conv_man.clj` line 174 (`restructure-json-conv`):

**✅ Persisted to Database:**
- `base-clusters` (folded format)
- `group-clusters` (final chosen clustering)
- `pca`, `in-conv`, `repness`, `group-votes`, etc.

**❌ NOT Persisted (Ephemeral):**
- `group-clusterings` (map of all k values)
- Previous k=2, k=3, k=4, k=5 clusterings are LOST

### Non-Deterministic Behavior Bug

This creates **two different behaviors** for the SAME conversation:

#### Scenario A: Math Worker NOT Restarted
```clojure
; In-memory state has everything:
conv = {
  :base-clusters [...],           ; from database
  :group-clusterings {             ; ← Still in memory!
    2 [...], 3 [...], 4 [...], 5 [...]
  },
  :group-clusters [...]
}

; Next update:
; - Base clusters: warm-started from previous base-clusters ✓
; - Group k=3: warm-started from previous k=3 clustering ✓
```
**Result**: Stable, consistent clusters across updates

#### Scenario B: Math Worker WAS Restarted
```clojure
; Loaded from database only:
conv = {
  :base-clusters [...],           ; ✓ loaded from database
  :group-clusterings nil,          ; ✗ NOT in database!
  :group-clusters [...]
}

; Next update:
; - Base clusters: warm-started from previous base-clusters ✓
; - Group k=3: NO previous k=3! Uses first-k initialization ✗
```
**Result**: Different clusters than Scenario A!

### Impact on Testing & Comparison

**The math_blobs in `real_data/` are problematic for comparison:**

1. **Unknown provenance**: We don't know if they were generated:
   - After worker restart (base warm-started, groups cold-started)
   - Without restart (both levels warm-started)
   - After how many previous updates (clusters could be far from "natural" solution)

2. **Unfair comparison**: Python does cold-start (first-k always) vs Clojure with unknown warm-start state

3. **No ground truth**: Without versioning, we can't recover the initial "clean" clustering

### Solution for Fair Testing

To properly compare Python vs Clojure, we need:

1. **Generate fresh Clojure clusterings** from scratch:
   - Start with empty conversation state (`new-conv`)
   - Run clustering ONCE with all votes
   - Save this as "clean" reference

2. **Capture ALL intermediate state**:
   - Save `group-clusterings` map (all k values)
   - Save initialization state for next run
   - Version the math_blobs with timestamps

3. **Test both modes**:
   - Cold-start: Python vs Clojure fresh computation
   - Warm-start: Implement Python incremental updates, test those

### Current Comparison Results

Running `scripts/clojure_comparer.py`:
- **Biodiversity**: 21% Jaccard similarity (FAIL)
- **VW**: 19% Jaccard similarity (FAIL)

**Why it fails**: Comparing Python cold-start vs Clojure warm-started from unknown previous state.

---

## Implementation Plan

### Phase 1: Add Silhouette Coefficient

**File**: `polismath/pca_kmeans_rep/clusters.py`

Add function to calculate silhouette score:

```python
def calculate_silhouette_score(clusters: List[Cluster],
                               distance_matrix: np.ndarray) -> float:
    """
    Calculate average silhouette coefficient for a clustering.

    Matches Clojure's clusters/silhouette function.

    Args:
        clusters: List of clusters with members assigned
        distance_matrix: Pre-computed distance matrix between cluster centers

    Returns:
        Average silhouette score (higher = better clustering)
    """
    # Implementation details in Clojure: clusters.clj lines 330-370
```

### Phase 2: Add Base Clustering

**File**: `polismath/conversation/conversation.py`

Modify `_compute_clusters()` to implement two-level clustering:

```python
def _compute_clusters(self) -> None:
    """Compute two-level hierarchical clustering matching Clojure."""

    # Configuration (matching Clojure defaults)
    BASE_K = 100
    MAX_K = 5
    BASE_ITERS = 100
    GROUP_ITERS = 100

    # Step 1: Filter participants (in-conv logic)
    in_conv_pids = self._get_in_conv_participants()

    # Step 2: Base clustering (participants → ~100 base clusters)
    base_proj_matrix = self._get_projections_for_pids(in_conv_pids)
    self.base_clusters = cluster_dataframe(
        base_proj_matrix,
        k=BASE_K,
        max_iters=BASE_ITERS
    )

    # Step 3: Compute base cluster weights and centers
    base_weights = {bc['id']: len(bc['members']) for bc in self.base_clusters}
    base_centers_df = self._base_clusters_to_dataframe()

    # Step 4: Group clustering with multiple k values
    max_k = min(MAX_K, 2 + len(self.base_clusters) // 12)
    group_clusterings = {}
    silhouettes = {}

    for k in range(2, max_k + 1):
        clusters = cluster_dataframe(
            base_centers_df,
            k=k,
            max_iters=GROUP_ITERS,
            weights=base_weights
        )
        group_clusterings[k] = clusters
        silhouettes[k] = calculate_silhouette_score(clusters, distance_matrix)

    # Step 5: Select best k using silhouette (with smoothing)
    best_k = max(silhouettes, key=silhouettes.get)
    self.group_clusters = group_clusterings[best_k]
```

### Phase 3: Add Participant Filtering

**File**: `polismath/conversation/conversation.py`

Add `in-conv` filtering logic:

```python
def _get_in_conv_participants(self) -> Set[str]:
    """
    Get participants who have voted enough to be included in clustering.

    Matches Clojure's in-conv logic from conversation.clj lines 239-266.

    Threshold: participant must have voted on at least:
        7 + sqrt(n_comments) * 0.1 comments
    """
    n_cmts = len(self.comments) if self.comments else 0
    threshold = 7 + np.sqrt(n_cmts) * 0.1

    in_conv = set()
    for pid, vote_count in self.user_vote_counts.items():
        if vote_count >= threshold:
            in_conv.add(pid)

    return in_conv
```

### Phase 4: Update Serialization

**File**: `polismath/conversation/conversation.py`

Update `to_dict()` to output hierarchical format:

```python
def to_dict(self) -> Dict:
    # ... existing code ...

    # Base clusters in folded format
    result['base-clusters'] = self._fold_clusters(self.base_clusters)

    # Group clusters (members are base cluster IDs, not participant IDs)
    result['group-clusters'] = self.group_clusters

    # ... rest of output ...
```

Add fold/unfold utilities:

```python
def _fold_clusters(self, clusters: List[Dict]) -> Dict:
    """Convert cluster list to folded format for storage."""
    return {
        'id': [c['id'] for c in clusters],
        'members': [c['members'] for c in clusters],
        'x': [c['center'][0] for c in clusters],
        'y': [c['center'][1] for c in clusters],
        'count': [len(c['members']) for c in clusters]
    }

def _unfold_clusters(self, folded: Dict) -> List[Dict]:
    """Convert folded format back to cluster list."""
    return [
        {'id': id, 'members': members, 'center': [x, y]}
        for id, members, x, y in zip(
            folded['id'], folded['members'], folded['x'], folded['y']
        )
    ]
```

### Phase 5: Update Tests

**File**: `tests/test_legacy_clojure_regression.py`

Update tests to compare hierarchical structures:

```python
def test_group_clustering(self, conversation_data):
    """Test that two-level clustering matches Clojure exactly."""
    conv = conversation_data['conv']
    clojure_output = conversation_data['clojure_output']

    # Compare base clusters
    assert len(conv.base_clusters) == len(clojure_output['base-clusters']['id'])

    # Compare group clusters (members should be base cluster IDs)
    python_groups = conv.group_clusters
    clojure_groups = clojure_output['group-clusters']

    assert len(python_groups) == len(clojure_groups)

    # Compare membership (exact match expected)
    for py_group, clj_group in zip(
        sorted(python_groups, key=lambda g: g['id']),
        sorted(clojure_groups, key=lambda g: g['id'])
    ):
        assert set(py_group['members']) == set(clj_group['members'])
```

---

## File Locations

### Python (to modify)

| File | Changes |
|------|---------|
| `polismath/pca_kmeans_rep/clusters.py` | Add `calculate_silhouette_score()`, update `cluster_dataframe()` for weights |
| `polismath/conversation/conversation.py` | Two-level clustering in `_compute_clusters()`, add `_get_in_conv_participants()`, update `to_dict()` |
| `polismath/regression/clojure_comparer.py` | Update to compare hierarchical structures directly |
| `tests/test_legacy_clojure_regression.py` | Update to expect exact hierarchical match |

### Clojure (reference)

| File | Key Functions |
|------|---------------|
| `math/src/polismath/math/conversation.clj` | `:base-clusters` (400-407), `:group-clusterings` (429-442), `:group-clusters` (471-474), `:in-conv` (239-266) |
| `math/src/polismath/math/clusters.clj` | `init-clusters` (55-65), `kmeans` (301-312), `silhouette` (330-370), `fold-clusters` (389-399) |

---

## Verification

### Test Commands

```bash
# Run clustering comparison tests
uv run pytest tests/test_legacy_clojure_regression.py::TestClojureRegression::test_group_clustering -v

# Run all Clojure comparison tests
uv run pytest tests/test_legacy_clojure_regression.py -v

# Quick sanity check
uv run python -c "
from polismath.conversation.conversation import Conversation
from polismath.regression import get_dataset_files
from tests.common_utils import load_votes, load_clojure_output

files = get_dataset_files('biodiversity')
votes = load_votes(files['votes'])
clojure = load_clojure_output(files['math_blob'])

conv = Conversation('test')
conv = conv.update_votes(votes).recompute()

print(f'Base clusters: {len(conv.base_clusters)}')
print(f'Group clusters: {len(conv.group_clusters)}')
print(f'Clojure base clusters: {len(clojure[\"base-clusters\"][\"id\"])}')
print(f'Clojure group clusters: {len(clojure[\"group-clusters\"])}')
"
```

### Expected Results

After implementation:

1. **Base clusters**: Python should produce ~100 base clusters (matching `base-k=100`)
2. **Group clusters**: Members should be base cluster IDs (integers 0-99), not participant IDs
3. **Exact match**: Jaccard similarity should be 100% when comparing same data
4. **Hierarchy preserved**: `group-clusters[i]['members']` contains base cluster IDs

---

## Progress Summary

| Step | Status | Notes |
|------|--------|-------|
| Analyze Clojure architecture | ✅ Done | Two-level always used, discovered non-determinism bug |
| Document in SESSION_HANDOFF | ✅ Done | This document + non-determinism section |
| Add silhouette calculation | ✅ Done | `calculate_silhouette_sklearn()` using sklearn |
| Implement base clustering | ✅ Done | `kmeans_sklearn()` with first-k initialization |
| Implement group clustering with k selection | ✅ Done | Tries k=2..5, picks best silhouette |
| Add in-conv filtering | ✅ Done | `_get_in_conv_participants()` |
| Update serialization | ✅ Done | `_fold_base_clusters()`, outputs hierarchical format |
| Add incremental clustering (`:last-clusters`) | ⏳ TODO | Need to use previous clusters as initialization |
| Generate clean Clojure references | ✅ Done | Uses "fake conversation" approach - creates temp conversation with copied votes |
| Update tests for fair comparison | ✅ Done | Tests now prefer cold-start blobs automatically |
| Implement fake conversation approach | ✅ Done | Script creates temp zid, copies votes with fresh timestamps, runs poller |

---

## Generating Clean Cold-Start Clojure References

To ensure fair comparison between Python and Clojure implementations, we can generate fresh cold-start Clojure math blobs using the `generate_cold_start_clojure.py` script.

### Why Cold-Start Matters

The Clojure implementation uses `:last-clusters` to warm-start from previous state. This creates non-deterministic behavior:
- If math worker was NOT restarted: uses previous clusters for initialization
- If math worker WAS restarted: loses in-memory state, behaves differently

By generating cold-start references, we compare:
- **Python cold-start** (always) vs **Clojure cold-start** (forced by deleting math_main row)

### How to Generate Cold-Start Blobs

**Prerequisites:**
1. Stop any running math worker: `docker compose stop math` (from the worktree root)
2. Ensure DATABASE_URL is set in the worktree root's `.env` file
   - Example: `DATABASE_URL=postgres://postgres:password@host.docker.internal:5433/polis-dev`

**Generate for single dataset:**
```bash
cd delphi  # from worktree root
uv run python scripts/generate_cold_start_clojure.py biodiversity
```

**Generate for all committed datasets:**
```bash
uv run python scripts/generate_cold_start_clojure.py --all
```

**Generate for all datasets including local (.local/):**
```bash
uv run python scripts/generate_cold_start_clojure.py --all --include-local
```

**Advanced options:**
```bash
# Keep fake conversation data for debugging (not cleaned up)
uv run python scripts/generate_cold_start_clojure.py biodiversity --no-cleanup

# Process a specific local dataset
uv run python scripts/generate_cold_start_clojure.py my-local-dataset

# Increase timeout for large datasets
uv run python scripts/generate_cold_start_clojure.py biodiversity --timeout 600
```

**Output files:**
- `{report_id}_math_blob_cold_start.json` - Fresh cold-start computation

### Finding Pre-Computed Cold-Start Math Blobs

After running the script, cold-start math blobs are saved in the dataset directories:

**Location pattern:**
```
delphi/real_data/{report_id}-{dataset_name}/{report_id}_math_blob_cold_start.json
```

**For committed datasets:**
```bash
# Biodiversity example
ls -lh delphi/real_data/r4tykwac8thvzv35jrn53-biodiversity/r4tykwac8thvzv35jrn53_math_blob_cold_start.json

# VW example
ls -lh delphi/real_data/r6vbnhffkxbd7ifmfbdrd-vw/r6vbnhffkxbd7ifmfbdrd_math_blob_cold_start.json

# List all cold-start blobs
find delphi/real_data -name "*_math_blob_cold_start.json" -type f
```

**For local datasets:**
```bash
# List all cold-start blobs in .local/
find delphi/real_data/.local -name "*_math_blob_cold_start.json" -type f
```

**Verify a cold-start blob was created:**
```bash
cd delphi  # from worktree root

# Check file exists and size
ls -lh real_data/r4tykwac8thvzv35jrn53-biodiversity/*cold_start*.json

# Quick inspection of content
jq 'keys | length' real_data/r4tykwac8thvzv35jrn53-biodiversity/r4tykwac8thvzv35jrn53_math_blob_cold_start.json

# Compare file sizes (cold-start should be similar to original)
ls -lh real_data/r4tykwac8thvzv35jrn53-biodiversity/*_math_blob*.json
```

**Dataset directory structure after running script:**
```
real_data/r4tykwac8thvzv35jrn53-biodiversity/
├── 2024-11-12-1652-r4tykwac8thvzv35jrn53-votes.csv
├── 2024-11-12-1652-r4tykwac8thvzv35jrn53-comments.csv
├── 2024-11-12-1652-r4tykwac8thvzv35jrn53-summary.csv
├── r4tykwac8thvzv35jrn53_math_blob.json                    # Original (unknown provenance)
├── r4tykwac8thvzv35jrn53_math_blob_cold_start.json         # Fresh cold-start ✨
└── golden_snapshot.json
```

### How Tests Use Cold-Start Blobs

The test infrastructure automatically detects and prefers cold-start blobs when available:

**Automatic detection (in `datasets.py`):**
```python
def get_dataset_files(name: str, prefer_cold_start: bool = True):
    # Automatically uses {report_id}_math_blob_cold_start.json if it exists
    # Falls back to {report_id}_math_blob.json otherwise
```

**Run tests (will auto-use cold-start blobs):**
```bash
cd delphi  # from worktree root

# Run all Clojure comparison tests
uv run pytest tests/test_legacy_clojure_regression.py -v

# Run specific clustering comparison
uv run pytest tests/test_legacy_clojure_regression.py::TestClojureRegression::test_group_clustering -v

# Run for specific dataset
uv run pytest tests/test_legacy_clojure_regression.py -v -k biodiversity
```

**Check which blob is being used:**
```python
from polismath.regression import get_dataset_files

# Will use cold-start if available
files = get_dataset_files('biodiversity')
print(f"Using: {files['math_blob']}")
# Output: .../r4tykwac8thvzv35jrn53_math_blob_cold_start.json (if exists)

# Force use of original blob
files = get_dataset_files('biodiversity', prefer_cold_start=False)
print(f"Using: {files['math_blob']}")
# Output: .../r4tykwac8thvzv35jrn53_math_blob.json
```

**Check which datasets have cold-start blobs:**
```bash
cd delphi  # from worktree root

# List all datasets with cold-start blobs
uv run python -c "
from polismath.regression import discover_datasets
datasets = discover_datasets(include_local=False)
for name, info in datasets.items():
    status = '✓ cold-start' if info.has_cold_start_blob else '✗ original only'
    print(f'{name}: {status}')
"
```

### How the Script Works (Fake Conversation Approach)

The script uses a "fake conversation" approach to generate true cold-start computations. This works WITH the Clojure poller's design rather than against it.

**The Process:**

1. **Create fake conversation**: Insert a minimal row in `conversations` table with a fresh auto-generated zid
2. **Copy votes with fresh timestamps**: Copy all votes from source zid to fake zid, with timestamps starting from "now" (spaced 10ms apart to preserve order)
3. **Run poller**: Start the Clojure poller with `MATH_ZID_ALLOWLIST={fake_zid}` to only process our fake conversation
4. **Wait for computation**: Poll `math_main` until `base-clusters` has data
5. **Extract and save**: Save the math blob with the original source zid for consistency
6. **Cleanup**: Delete all fake data from `conversations`, `votes`, `votes_latest_unique`, `participants`, and `math_main`

**Why This Works:**
- The poller finds votes with `created > last_poll_timestamp`
- Fresh timestamps ensure the votes are picked up
- A new zid means no interference from existing math_main rows or cached state
- The `MATH_ZID_ALLOWLIST` filter restricts processing to just our fake conversation

**Key Functions:**
- `create_fake_conversation(conn, source_zid)` → Creates minimal conversation row, returns new zid
- `copy_votes_with_fresh_timestamps(conn, source_zid, fake_zid)` → Copies votes with sequential fresh timestamps
- `cleanup_fake_conversation(conn, fake_zid)` → Deletes all fake data from all tables

### Command-Line Options

- `DATASETS...`: Specify one or more dataset names (e.g., `biodiversity vw`)
- `--all`: Process all datasets
- `--include-local`: Include datasets from `real_data/.local/`
- `--no-cleanup`: Keep fake conversation data for debugging (normally cleaned up automatically)
- `--timeout N`: Set timeout in seconds for math computation (default: 300)
- `--pause-math`: Automatically pause running math workers (resumes after completion)
- `--verbose` / `-v`: Show detailed output including real-time Clojure poller logs

**Examples:**
```bash
# Single dataset
uv run python scripts/generate_cold_start_clojure.py biodiversity

# Multiple datasets
uv run python scripts/generate_cold_start_clojure.py biodiversity vw american-assembly

# All datasets with verbose output and longer timeout
uv run python scripts/generate_cold_start_clojure.py --all --include-local --pause-math --timeout 600 -v
```

### Safety Features

- **Math worker detection**: Refuses to run if math worker is active (use `--pause-math` to auto-pause)
- **Environment validation**: Checks that DATABASE_URL is set before proceeding
- **Report ID validation**: Verifies report_id exists in reports table
- **Vote verification**: Confirms source zid has votes before attempting computation
- **Automatic cleanup**: Fake conversation data is always deleted (unless `--no-cleanup`)
- **No permanent changes**: Original database data is never modified
- **Error detection**: Monitors Clojure poller output for fatal errors and aborts early (see below)

### Clojure Error Detection

The script monitors the Clojure poller output for fatal errors and aborts early instead of waiting for timeout. Detected patterns:
- `"Failed conversation update"` - General computation failure
- `"nil has zero dimensionality"` - Empty matrix in PCA (see Known Limitations)
- `"Re-queueing messages for failed update"` - Persistent failure
- `"java.lang.OutOfMemoryError"` - Memory exhaustion

When detected, the script aborts with:
```
✗ Clojure poller failed: Clojure error detected: nil has zero dimensionality
  The conversation data may not be processable by the Clojure implementation.
```

---

## Cluster Visualization Script

The `visualize_cluster_comparison.py` script generates visual comparisons between different clustering outputs.

### Usage

```bash
cd delphi

# Single dataset
uv run python scripts/visualize_cluster_comparison.py biodiversity

# Multiple datasets
uv run python scripts/visualize_cluster_comparison.py biodiversity vw

# All datasets
uv run python scripts/visualize_cluster_comparison.py --all --include-local
```

### Output

For each dataset, generates:
- `{dataset}_golden_vs_coldstart_sidebyside.png` - Python vs Clojure cold-start side-by-side
- `{dataset}_golden_vs_coldstart_overlay.png` - Python vs Clojure cold-start overlay
- `{dataset}_coldstart_vs_regular_sidebyside.png` - Clojure cold-start vs original
- `{dataset}_coldstart_vs_regular_overlay.png` - Clojure cold-start vs original overlay
- `{dataset}_*_metrics.json` - Comparison metrics (Jaccard similarity, etc.)

Output directory: `scripts/outputs/cluster_visualizations/{dataset}/`

Full absolute paths are printed for each PNG, allowing alt-click to open in IDE.

### Features

- **PCA sign flip detection**: Automatically detects and corrects PCA sign flips between implementations
- **Synchronized axes**: Side-by-side plots share the same X/Y limits for direct comparison
- **Convex hulls**: Shows group boundaries with convex hulls in overlay mode

---

## Known Limitations

### Clojure "nil has zero dimensionality" Error

Some large conversations fail in the Clojure implementation with:
```
clojure.lang.ExceptionInfo: nil has zero dimensionality, cannot get count for dimension: 0
    at polismath.math.conversation/partial-pca/learn (conversation.clj:719)
```

**Cause**: The conversation data results in an empty or nil matrix during PCA computation. This can happen when:
- All comments are moderated out
- Not enough participants meet the "in-conv" threshold
- Edge cases in the data that produce empty participant matrices

**Impact**: These conversations cannot be processed by the Clojure implementation and will fail in the cold-start generation script.

**Workaround**: The Python implementation may handle these edge cases differently. For affected conversations, only Python-generated outputs will be available.

**Known affected datasets**: bg2050 (pakistan)

---

## Configuration

### Environment Setup

The cold-start generation script requires database access. Configuration is loaded from the worktree root's `.env` file.

**Required variables**:
```bash
DATABASE_URL=postgres://postgres:password@host.docker.internal:5433/polis-dev
MATH_ENV=prod  # or 'dev' for development
```

**Setup**:
```bash
# Copy from main polis repo if not already present
cp /path/to/polis/.env /path/to/polis-kmeans/.env
```

The script also needs the Clojure math worker Docker image available:
```bash
cd /path/to/polis-kmeans
docker compose build math  # If image not already built
```

---

## References

- **Clojure two-level doc**: `docs/CLOJURE_TWO_LEVEL_CLUSTERING.md`
- **Clojure source**: `math/src/polismath/math/`
- **Python clusters**: `polismath/pca_kmeans_rep/clusters.py`
- **Python conversation**: `polismath/conversation/conversation.py`
- **Cold-start script**: `scripts/generate_cold_start_clojure.py`
