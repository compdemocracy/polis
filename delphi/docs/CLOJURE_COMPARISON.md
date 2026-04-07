# Clojure Comparison Testing

## Purpose

These tests validate the Python implementation against Clojure reference outputs stored as `math_blob.json` files. They will be removed once the Clojure implementation is fully phased out and replaced with sklearn-based implementations.

## Test Files

- **`tests/test_legacy_clojure_regression.py`** - Automated pytest suite marked with `@pytest.mark.clojure_comparison`
- **`polismath/regression/clojure_comparer.py`** - Comparison utilities shared by tests and CLI tool
- **`scripts/clojure_comparer.py`** - Interactive CLI tool for detailed comparison

## Architecture

The comparison code is shared between pytest tests and the CLI tool to avoid duplication:

```
┌─────────────────────────────────┐
│  clojure_comparer.py            │  ← Shared comparison logic
│  - ClojureComparer class        │
│  - compare_cluster_*()          │
│  - compare_projections()        │
└─────────────┬───────────────────┘
              │
      ┌───────┴────────┐
      │                │
┌─────▼────────┐  ┌───▼──────────────────────┐
│  Test Suite  │  │  CLI Tool                │
│  (pytest)    │  │  (interactive)           │
│  - Minimal   │  │  - Rich reporting        │
│    reporting │  │  - Configurable          │
│              │  │  - Dataset selection     │
└──────────────┘  └──────────────────────────┘
```

## Test Data

Clojure math blobs (JSON outputs) are stored in:
- **`delphi/real_data/{dataset}/{report_id}_math_blob.json`** - Public datasets (committed)
- **`delphi/real_data/.local/{dataset}/{report_id}_math_blob.json`** - Private datasets (requires `--include-local` flag)

The `{report_id}` is discovered automatically by `polismath.regression.datasets.get_dataset_files()`.

The Clojure reference implementation is in: **`math/src/polismath/math/clusters.clj`**

## Known Differences

### Clustering Architecture

This is the **primary reason** clustering results differ between Python and Clojure:

**Python** (Single-level clustering):
- `group_clusters`: Direct clustering of participants into k groups
- Member IDs: Participant IDs
- Example: {id: 0, members: [ptpt1, ptpt2, ...]}

**Clojure** (Two-level clustering):
1. `base-clusters`: First-level clustering of participants into ~100 small clusters
   - Member IDs: Participant IDs
   - Example: 100 base clusters with 3-7 participants each
2. `group-clusters`: Second-level clustering of base clusters into k groups
   - Member IDs: Base cluster IDs (not participants!)
   - Example: {id: 0, members: [0, 1, 5, 8, ...]} where numbers are base cluster IDs

**Impact**: Comparing Python `group_clusters` with Clojure `group-clusters` is **not** apples-to-apples. Python has ~500 participant IDs per group, Clojure has ~50 base cluster IDs per group.

### K-means Initialization

Beyond the architecture, there's also an initialization difference:

| Aspect | Python | Clojure |
|--------|--------|---------|
| **Algorithm** | K-means++ (seed 42) | First k distinct points |
| **Rationale** | Better convergence, industry standard | Simpler implementation |
| **Result** | Different local optima | Different local optima |
| **Quality** | Both are valid clustering algorithms | Both are valid clustering algorithms |

### Other Parameters

| Parameter | Python | Clojure | Match? |
|-----------|--------|---------|--------|
| Euclidean distance | ✓ | ✓ | ✅ |
| Convergence threshold | 0.01 | 0.01 | ✅ |
| Max iterations | 20 | 20 | ✅ |
| Weighted clustering | ✓ | ✓ | ✅ |
| Empty cluster handling | ✓ | ✓ | ✅ |

## Test Status

### Current State

- ✅ **`test_basic_outputs`** - ACTIVE - Validates pipeline runs and produces representativeness
- ⚠️ **`test_pca_components_match_clojure`** - KEPT FOR MEMORY - PCA validated via sklearn (deprecated but kept as reference)
- ❌ **`test_group_clustering`** - EXPECTED TO FAIL - Clustering comparison with tight thresholds (Jaccard ≥95%, L1 ≤0.05)
- ⚠️ **`test_comment_priorities`** - XFAIL - Priority comparison (depends on clustering matching)

### Why Tests Fail

The clustering test **intentionally fails** because:
1. Python uses K-means++ initialization → different initial cluster centers
2. K-means converges to nearest local optimum → different final clusters
3. Tests use very tight thresholds (95% Jaccard, 5% L1) to detect any difference

This is **expected behavior** until we implement Option A (match Clojure initialization).

## Running Tests

### pytest (automated)

```bash
# Run all legacy Clojure tests
uv run pytest tests/test_legacy_clojure_regression.py -v

# Run specific test
uv run pytest tests/test_legacy_clojure_regression.py::TestClojureRegression::test_group_clustering -v

# Include local datasets
uv run pytest tests/test_legacy_clojure_regression.py --include-local -v

# Exclude Clojure comparison tests from regular test runs
uv run pytest tests/ -m "not clojure_comparison" -v

# Run ONLY Clojure comparison tests
uv run pytest tests/ -m "clojure_comparison" -v
```

### CLI Tool (interactive)

```bash
# Compare all datasets with Clojure output
uv run python scripts/clojure_comparer.py

# Compare specific dataset
uv run python scripts/clojure_comparer.py biodiversity

# Compare multiple datasets
uv run python scripts/clojure_comparer.py biodiversity vw

# Include local datasets
uv run python scripts/clojure_comparer.py --include-local

# Show detailed cluster mappings
uv run python scripts/clojure_comparer.py --show-mappings biodiversity

# Use custom thresholds (looser)
uv run python scripts/clojure_comparer.py --jaccard-threshold 0.7 --distribution-tolerance 0.3

# Debug mode
uv run python scripts/clojure_comparer.py --log-level DEBUG biodiversity
```

## Fixing Clustering Comparison

### Option A: Match Clojure Initialization (Temporary)

**Goal**: Make tests pass by using the same initialization algorithm

**Implementation**:
1. Modify `polismath/pca_kmeans_rep/clusters.py::init_clusters()` to use first-k distinct points instead of K-means++
2. The tests should then pass with tight thresholds

**Code change**:
```python
def init_clusters(data: np.ndarray, k: int, seed: int = 42) -> List[Cluster]:
    """Initialize clusters with first k distinct data points (matching Clojure)."""
    # Get unique rows
    unique_data = np.unique(data, axis=0)

    # Take first k
    initial_centers = unique_data[:min(k, len(unique_data))]

    # Create Cluster objects
    clusters = []
    for i, center in enumerate(initial_centers):
        clusters.append(Cluster(id=i, center=center, members=[]))

    return clusters
```

**Pros**:
- Tests will pass
- Validates correctness of K-means implementation
- Enables confident migration to sklearn

**Cons**:
- Suboptimal initialization (worse convergence)
- Temporary solution only

### Option B: Quality-Based Validation (Future)

**Goal**: Accept different results, validate quality instead

**Implementation**:
1. Replace exact matching with quality metrics:
   - Silhouette score (intra-cluster cohesion)
   - Davies-Bouldin index (cluster separation)
   - Inertia (within-cluster sum of squares)
2. Validate that both Python and Clojure produce "good" clustering
3. Accept that specific cluster assignments differ

**Tests would check**:
```python
# Instead of exact matching
assert python_silhouette >= 0.5  # Good clustering
assert clojure_silhouette >= 0.5  # Good clustering

# Allow some difference
assert abs(python_silhouette - clojure_silhouette) < 0.2
```

**Pros**:
- More principled approach
- Doesn't require matching suboptimal initialization
- Better for future sklearn migration

**Cons**:
- Doesn't validate exact compatibility
- Harder to debug subtle differences

### Recommended Path

1. **Now**: Use Option A to validate correctness
   - Temporarily match Clojure initialization
   - Run all tests and verify they pass
   - Confirms K-means implementation is correct

2. **Next**: Migrate to sklearn
   - Replace custom K-means with `sklearn.cluster.KMeans`
   - Keep tests but switch to quality-based validation (Option B)
   - Remove Clojure comparison tests

3. **Finally**: Remove legacy code
   - Archive Clojure reference files
   - Remove all comparison tests
   - Keep only sklearn-based implementation

## Comparison Thresholds

The default thresholds are intentionally **very tight** (per user request):

| Metric | Threshold | Description |
|--------|-----------|-------------|
| **Jaccard similarity** | ≥95% | Cluster membership overlap |
| **L1 distance** | ≤0.05 | Cluster size distribution |
| **Absolute tolerance** | 1e-8 | Numerical comparisons |
| **Relative tolerance** | 1e-6 | Numerical comparisons |

These can be relaxed via CLI options or ClojureComparer constructor.

## Example Output

### CLI Tool Output

```
==============================================================
Comparing: biodiversity
==============================================================
✓ Loaded Clojure math_blob
✓ Loaded votes data: 2847 votes
✓ Computed Python analysis:
  - 95 participants
  - 30 comments
  - 2 groups

--- Clustering Comparison ---

Cluster Size Distribution:
  Python sizes:  [52, 43]
  Clojure sizes: [48, 47]
  L1 distance: 0.0526
  Similarity score: 94.74%
  Status: ✗ FAIL (threshold: 0.05)

Cluster Membership Overlap:
  Average Jaccard similarity: 83.21%
  Status: ✗ FAIL (threshold: 95.00%)

  Cluster Mapping (Python → Clojure):
    ✗ Group 0 (52 members) → Group 0 (48 members): 83.02%
    ✗ Group 1 (43 members) → Group 1 (47 members): 83.72%

⚠ Clustering does not match Clojure output
  Likely cause: Initialization algorithm difference
    Python:  K-means++ (seed 42)
    Clojure: First k distinct points
==============================================================
✗ biodiversity: FAIL
==============================================================
```

### pytest Output

```
test_legacy_clojure_regression.py::TestClojureRegression::test_group_clustering[biodiversity]

[biodiversity] Testing group clustering...
[biodiversity] Comparing group clustering:
  Python groups: 2
  Clojure groups: 2

  Cluster Size Distribution:
    Python sizes:  [52, 43]
    Clojure sizes: [48, 47]
    L1 distance: 0.0526
    Similarity score: 94.74%

  Cluster Membership Overlap:
    Average Jaccard similarity: 83.21%
    Threshold: 95.00%

  Cluster Mapping (Python → Clojure):
    ✗ Group 0 (52 members) → Group 0 (48 members): 83.02%
    ✗ Group 1 (43 members) → Group 1 (47 members): 83.72%

  ⚠ Clustering does not match Clojure output
  Likely cause: Initialization algorithm difference
    Python:  K-means++ (seed 42)
    Clojure: First k distinct points
  Recommendation: Match initialization to align results

FAILED
```

## Integration with CI

The `@pytest.mark.clojure_comparison` marker allows selective test execution:

```yaml
# Run only fast tests (exclude Clojure comparison)
- name: Fast Tests
  run: pytest -m "not clojure_comparison"

# Run all tests including Clojure comparison
- name: Full Tests
  run: pytest

# Run only Clojure comparison tests
- name: Clojure Compatibility
  run: pytest -m "clojure_comparison"
```

## Migration Timeline

1. ✅ **Phase 1: Consolidation** (Current)
   - Merge 3 legacy test files into coherent suite
   - Create shared comparison utilities
   - Add CLI tool for interactive testing
   - Document known differences

2. 📋 **Phase 2: Validation** (Next)
   - Implement Option A (match Clojure initialization)
   - Verify all tests pass
   - Validate correctness of K-means implementation

3. 🔄 **Phase 3: Migration** (Future)
   - Replace custom K-means with sklearn
   - Switch to quality-based validation
   - Update tests to use quality metrics

4. 🗑️ **Phase 4: Cleanup** (Final)
   - Remove Clojure comparison tests
   - Archive legacy reference files
   - Keep only sklearn-based implementation

## Troubleshooting

### Tests fail with "No module named 'polismath.regression.clojure_comparer'"

**Solution**: Make sure you're running from the `delphi/` directory and have installed the package:
```bash
cd delphi/
uv sync --dev
uv run pytest tests/test_legacy_clojure_regression.py -v
```

### CLI tool shows "No datasets with Clojure math_blob found"

**Solution**: Ensure datasets have `math_blob.json` files:
```bash
ls real_data/*/math_blob.json
# Should show: real_data/biodiversity/math_blob.json, real_data/vw/math_blob.json, etc.
```

### Tests pass locally but fail in CI

**Possible causes**:
1. Local datasets not committed (use `--include-local` flag locally)
2. Different Python version (pin to 3.12.x)
3. Different package versions (use `uv sync` to match lockfile)

### Clustering results differ significantly (< 50% Jaccard)

**Possible causes**:
1. Different vote data (check MD5 hashes)
2. Different random seed (should be 42)
3. Bug in K-means implementation (compare step-by-step)

## References

- **Clojure Implementation**: `math/src/polismath/math/clusters.clj`
- **Python Implementation**: `delphi/polismath/pca_kmeans_rep/clusters.py`
- **Golden Snapshots**: `delphi/real_data/{dataset}/golden_snapshot.json` (Python-to-Python regression)
- **Math Blobs**: `delphi/real_data/{dataset}/math_blob.json` (Clojure reference output)

## Questions?

See the main project documentation in `delphi/CLAUDE.md` for general guidance on:
- Database interactions
- Environment configuration
- Running the Delphi pipeline
- Dataset structure

For questions specific to Clojure comparison, check:
1. This document (CLOJURE_COMPARISON.md)
2. The plan file: `.claude/plans/logical-prancing-thacker.md`
3. The comparison utilities: `polismath/regression/clojure_comparer.py`
