# Regression Testing System for Delphi

This directory contains a lightweight regression testing system for the Polis `delphi/` Python codebase. It captures and compares outputs from key Conversation operations to ensure refactoring doesn't change computational behavior.

## Overview

The regression testing system works by:
1. **Recording** golden snapshots of Conversation outputs at key lifecycle stages
2. **Comparing** current implementation outputs against these golden snapshots
3. **Detecting** any unintended changes in computational results

This provides confidence during refactoring that the mathematical/computational behavior remains unchanged, even if the underlying implementation changes.

## Components

### Core Files

- **`recorder.py`** - Records golden snapshots of Conversation outputs
- **`comparer.py`** - Compares current outputs with golden snapshots
- **`regression_test.py`** - CLI runner for recording and comparing
- **`golden/`** - Directory storing golden snapshot JSON files

### Integration

- **`../tests/test_regression.py`** - Pytest wrapper for running as part of test suite

## Key Features

### 1. Minimal Configuration
- No config files required
- Reuses existing test infrastructure from `tests/dataset_config.py` and `tests/common_utils.py`
- Hardcoded reasonable defaults for tolerances

### 2. Native Serialization
- Uses `Conversation.to_dict()` and `Conversation.get_full_data()` methods
- No access to internal NamedMatrix representation
- JSON-serializable outputs only

### 3. Data Integrity
- MD5 checksums validate that dataset CSV files haven't changed
- Fixed timestamps ensure reproducible results
- Automatically ignores non-deterministic fields (e.g., `math_tick`)

### 4. Tolerance-Based Comparison
- Absolute tolerance: `1e-6` (for small values)
- Relative tolerance: `1%` (for large values)
- Exact matching for integer counts
- Special handling for NaN and infinity values

### 5. Statistical Performance Benchmarking
- **Multiple runs**: Each computation stage runs 3 times to collect statistically meaningful timing data
- **Statistical metrics**: Records mean, standard deviation, and raw timing values
- **T-test analysis**: Performs independent two-sample t-tests to determine if performance differences are statistically significant
- **P-value reporting**: Shows p-values with interpretation (significant if p < 0.05)
- **Visual indicators**: Displays emoji symbols for quick interpretation:
  - **🚀**: Significantly faster (p < 0.05) - real performance improvement
  - **⚠️**: Significantly slower (p < 0.05) - real performance regression
  - **No emoji**: No significant difference (p ≥ 0.05) - normal variation
- **Compact format**: Single-line display per stage showing:
  - Status (✅/❌), stage name, current vs golden timing, performance result, and p-value
  - Example: `✅ after_pca: 101ms ± 4ms vs 94ms ± 8ms │ 1.08x slower, p=0.2461`
  - Times automatically formatted in appropriate units (µs, ms, or s)
- **Interpretation**: Small p-values (< 0.05) indicate real performance changes, while large p-values suggest natural variation
- Helps distinguish real performance regressions from measurement noise

### 6. Comprehensive Stage Coverage

The system captures 6 stages of the Conversation lifecycle:

1. **Empty** - Initial conversation state
2. **After load (no compute)** - Votes loaded but no analysis performed
3. **After PCA** - Principal Component Analysis computed
4. **After clustering** - K-means clustering computed
5. **After full recompute** - Complete pipeline including repness and participant info
6. **Full data export** - Output from `get_full_data()` method

## Usage

### Command-Line Interface

```bash
cd delphi

# Record golden snapshots for all datasets
python regression_tests/regression_test.py record --datasets biodiversity,vw

# Record for a single dataset
python regression_tests/regression_test.py record --datasets biodiversity

# Compare current implementation with golden
python regression_tests/regression_test.py compare --datasets biodiversity,vw

# Update golden snapshots after verified changes
python regression_tests/regression_test.py update --datasets biodiversity --force

# Adjust comparison tolerances
python regression_tests/regression_test.py compare --datasets biodiversity \
    --tolerance-abs 1e-8 --tolerance-rel 0.001
```

### Pytest Integration

```bash
cd delphi

# Run regression tests through pytest
pytest tests/test_regression.py -v

# Run with coverage
pytest tests/test_regression.py -v --cov=polismath

# Run specific dataset test
pytest tests/test_regression.py::test_conversation_regression[biodiversity] -v
```

### Typical Workflow

1. **Initial Setup** - Record golden snapshots before refactoring:
   ```bash
   python regression_tests/regression_test.py record --datasets biodiversity,vw
   ```

2. **During Refactoring** - Run comparison frequently:
   ```bash
   python regression_tests/regression_test.py compare --datasets biodiversity
   ```

3. **After Verification** - Update golden if changes are intentional:
   ```bash
   python regression_tests/regression_test.py update --datasets biodiversity --force
   ```

### Example Output

When recording, the system runs 3 iterations for statistical benchmarking:

```
Recording golden snapshot for biodiversity...
  Computing all stages with benchmarking...
  Running 3 iterations for benchmarking...
    Iteration 1/3 complete
    Iteration 2/3 complete
    Iteration 3/3 complete
  Saving golden snapshot to .../biodiversity_golden.json
Successfully recorded golden snapshot for biodiversity
```

When comparing, you'll see timing information with statistical significance:

```
Comparing biodiversity with golden snapshot...
  Running 3 iterations for benchmarking...
    Iteration 1/3 complete
    Iteration 2/3 complete
    Iteration 3/3 complete
✅ biodiversity: All stages match!

============================================================
REGRESSION TEST REPORT
============================================================
Dataset: biodiversity
Overall Result: ✅ PASS

Metadata:
  dataset_name: biodiversity
  report_id: r4tykwac8thvzv35jrn53
  votes_csv_md5: cf32750948416aa7741832f16d004aea
  comments_csv_md5: 6b961ecb3dd6b5a277139b0f39f83861
  n_votes_in_csv: 29802
  n_comments_in_csv: 316
  n_participants_in_csv: 536
  fixed_timestamp: 1700000000000
  recorded_at: 2025-11-12T13:52:26.966074

Numerical comparison:
  (Tolerances: abs=1e-06, rel=1.0%)
  ✅ Match      empty                      (= 1.02x slower, p=0.8388)
  ✅ Match      after_load_no_compute      (= 1.02x faster, p=0.0710)
  ✅ Match      after_pca                  (= 1.08x slower, p=0.2461)
  ✅ Match      after_clustering           (= 1.00x faster, p=0.9855)
  ✅ Match      after_full_recompute       (- 1.07x slower, p=0.0018)
  ✅ Match      full_data_export           (= 1.03x slower, p=0.8889)

Speed comparison:
  Status Stage                     Current (mean ± std)  Golden (mean ± std)     Performance
  ✅ empty                      300µs ± 10µs         vs 300µs ± 10µs          │ 1.02x slower, p=0.8388
  ✅ after_load_no_compute      605ms ± 7ms          vs 614ms ± 1ms           │ 1.02x faster, p=0.0710
  ✅ after_pca                  101ms ± 4ms          vs 94ms ± 8ms            │ 1.08x slower, p=0.2461
  ✅ after_clustering           131ms ± 21ms         vs 132ms ± 0ms           │ 1.00x faster, p=0.9855
  ✅ after_full_recompute       954ms ± 11ms         vs 891ms ± 10ms          │ ⚠️1.07x slower, p=0.0018
  ✅ full_data_export           300µs ± 100µs        vs 300µs ± 100µs         │ 1.03x slower, p=0.8889
============================================================
```

**Interpreting the Output:**

The report is organized into two sections:

**1. Numerical comparison:**
Shows the result of comparing numerical values within tolerances:
- **First line**: Shows the tolerance values used (absolute and relative)
- **One line per stage**: Compact format showing status, stage name, and optional performance summary
- **✅ Match / ❌ Mismatch**: Shows whether the numerical values match within tolerances
- **Performance symbols** (in parentheses):
  - **"="**: No significant difference (p ≥ 0.05)
  - **"+"**: Significantly faster (p < 0.05)
  - **"-"**: Significantly slower (p < 0.05)

**2. Speed comparison:**
Shows aligned, formatted timing metrics with a header row:
- **Header line**: Clarifies which column is Current vs Golden timing
- **Status emoji**: ✅ for passing stages, ❌ for failing stages
- **Stage name**: Left-aligned with fixed width for visual alignment
- **Current timing**: Shows mean ± std dev for new implementation
- **Golden timing**: Shows mean ± std dev for golden snapshot
- **Performance emoji indicators**:
  - **🚀**: Significantly faster (p < 0.05) - real performance improvement detected
  - **⚠️**: Significantly slower (p < 0.05) - real performance regression detected
  - **No emoji**: No significant difference (p ≥ 0.05) - normal variation
- **Performance metrics**: Speedup/slowdown ratio with p-value
- **Time units**: Automatically formatted (µs for < 1ms, ms for < 1s, s otherwise)

In the example above:
- The Numerical comparison shows all stages match with tolerance abs=1e-06, rel=1.0%
- Most stages show **"="** (no significant performance difference)
- `after_full_recompute` shows **"-"** with p=0.0018 and ⚠️ emoji, indicating a real performance regression worth investigating

## Design Decisions

### Fixed Timestamps

The system uses a fixed timestamp (`1700000000000` milliseconds) to ensure reproducibility:

```python
fixed_timestamp = 1700000000000
conv = Conversation(dataset_name, last_updated=fixed_timestamp)
```

This prevents timestamp-based fields from causing false positives in comparisons.

### Ignored Fields

Certain fields are automatically ignored during comparison:
- `math_tick` - A timestamp-derived metadata field not part of computational results

To add more ignored fields, modify `comparer.py`:

```python
def _compare_dicts(self, golden: Any, current: Any, path: str = "") -> Dict:
    # Add new ignored fields here
    if path.endswith(".your_field") or path == "your_field":
        return {"match": True, "path": path, "note": "Ignored field"}
    # ... rest of comparison logic
```

### Reused Infrastructure

The system leverages existing test code to avoid duplication:

- **Dataset management**: Uses `tests/dataset_config.py` for file discovery
- **Vote loading**: Follows the same pattern as `tests/common_utils.py`
- **Test data**: Uses existing test datasets in `real_data/`

## File Format

Golden snapshot files are JSON with this structure:

```json
{
  "metadata": {
    "dataset_name": "biodiversity",
    "report_id": "r4tykwac8thvzv35jrn53",
    "recorded_at": "2025-11-11T12:36:01.652000",
    "votes_csv_md5": "abc123...",
    "comments_csv_md5": "def456...",
    "n_votes_in_csv": 29802,
    "n_comments_in_csv": 316,
    "n_participants_in_csv": 536
  },
  "stages": {
    "empty": { /* to_dict() output */ },
    "after_load_no_compute": { /* to_dict() output */ },
    "after_pca": { /* to_dict() output */ },
    "after_clustering": { /* to_dict() output */ },
    "after_full_recompute": { /* to_dict() output */ },
    "full_data_export": { /* get_full_data() output */ }
  },
  "timing_stats": {
    "empty": {
      "mean": 0.0006514590349979699,
      "std": 0.00001234,
      "raw": [0.00065, 0.00066, 0.00065]
    },
    "after_load_no_compute": {
      "mean": 0.606867374968715,
      "std": 0.0012345,
      "raw": [0.6056, 0.6069, 0.6081]
    },
    "after_pca": {
      "mean": 0.08539487503003329,
      "std": 0.0083456,
      "raw": [0.0854, 0.0930, 0.0777]
    },
    "after_clustering": {
      "mean": 0.13137866597389802,
      "std": 0.0213245,
      "raw": [0.1121, 0.1500, 0.1320]
    },
    "after_full_recompute": {
      "mean": 0.9307277500047348,
      "std": 0.0103456,
      "raw": [0.9307, 0.9200, 0.9415]
    },
    "full_data_export": {
      "mean": 0.00022733298828825355,
      "std": 0.00001000,
      "raw": [0.00023, 0.00022, 0.00023]
    }
  }
}
```

## Troubleshooting

### Dataset Files Changed

**Error:**
```
Dataset files have changed! MD5 mismatch.
```

**Solution:**
If the CSV files were intentionally updated, re-record the golden snapshot:
```bash
python regression_tests/regression_test.py update --datasets biodiversity --force
```

### Numeric Mismatches

**Error:**
```
Numeric mismatch: golden=1.234567, current=1.234568, abs_diff=1e-6
```

**Solutions:**
1. If the difference is acceptable, adjust tolerances:
   ```bash
   python regression_tests/regression_test.py compare --tolerance-abs 1e-5
   ```

2. If this represents a genuine regression, investigate the code changes.

### Missing Golden Snapshot

**Error:**
```
No golden snapshot found for dataset. Run recorder first.
```

**Solution:**
```bash
python regression_tests/regression_test.py record --datasets biodiversity
```

### Non-Deterministic Results

If you encounter random variations in output (e.g., clustering order changes):

1. Check if fields should be ignored (like `math_tick`)
2. Ensure random seeds are fixed in the code
3. Verify timestamps are using the fixed value

## Extending the System

### Adding New Datasets

1. Ensure the dataset exists in `delphi/real_data/`
2. Add it to `tests/dataset_config.py` if not already there
3. Record a golden snapshot:
   ```bash
   python regression_tests/regression_test.py record --datasets your_dataset
   ```

### Adding New Stages

To capture additional computation stages, modify `recorder.py` and `comparer.py`:

```python
# In recorder.py
print("  Computing your stage...")
conv.your_method()
snapshot["stages"]["your_stage"] = conv.to_dict()

# In comparer.py
elif stage_name == "your_stage":
    current_conv = Conversation(dataset_name, last_updated=fixed_timestamp)
    # ... setup
    current_conv.your_method()
    current_dict = current_conv.to_dict()
```

### Custom Comparison Logic

For special comparison needs, modify `_compare_dicts()` in `comparer.py`:

```python
# Example: Special handling for cluster member sets
if "cluster" in path and "members" in path:
    # Custom comparison logic for unordered sets
    return self._compare_sets(golden, current, path)
```

## Performance Notes

- Recording a golden snapshot: ~2-3 seconds per dataset
- Comparison run: ~3-4 seconds per dataset
- Golden snapshot file size: ~500KB - 2MB per dataset

## Limitations

1. **No internal state checking** - Only compares serialized outputs, not internal NamedMatrix state
2. **Limited to test datasets** - Only works with datasets that have CSV files available
3. **No partial updates** - Must record/update entire stage sets
4. **Fixed tolerance values** - Same tolerances apply to all numeric fields

## When to Use This System

**Use regression tests when:**
- Refactoring computational code
- Optimizing algorithms while preserving behavior
- Restructuring data flow
- Changing internal representations

**Don't rely solely on regression tests for:**
- Verifying correctness against requirements (use unit tests)
- Testing edge cases (use property-based tests)
- Validating against the Clojure implementation (use comparison tests)

## Related Testing

This regression system complements other test types:

- **Unit tests** (`tests/test_*.py`) - Verify individual component behavior
- **Smoke tests** (`tests/test_conversation_smoke.py`) - Verify code runs without crashing
- **Comparison tests** - Validate against Clojure reference implementation
- **Integration tests** - Test end-to-end workflows

## License

Part of the Polis project. See repository root for license information.
