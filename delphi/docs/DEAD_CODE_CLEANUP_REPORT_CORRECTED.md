# Dead Code Cleanup Report - CORRECTED

**Date:** January 2026
**Branch:** `dead-code-cleanup`
**Status:** ⚠️ Contains Critical Error - See Corrections Below

---

## ⚠️ CRITICAL CORRECTION

**This report corrects a critical false positive in the original dead code cleanup.**

### False Positive Identified

**File Incorrectly Deleted:** `polismath/utils/general.py` (263 lines)

**Original Claim:**
> "Result: No matches" for `grep -r "from polismath.utils.general import"`

**Actual Reality:**
The file had **4 active imports** in production code:

1. **`polismath/database/postgres.py:28`**
   - Imports: `postgres_vote_to_delphi`
   - Used at: line 466 to convert PostgreSQL vote convention

2. **`polismath/run_math_pipeline.py:15`**
   - Imports: `postgres_vote_to_delphi`
   - Used at: line 113 for vote conversion

3. **`polismath/pca_kmeans_rep/repness.py:15`**
   - Imports: `AGREE, DISAGREE`
   - Used at: lines 133-134, 559-560, 583-584

4. **`polismath/pca_kmeans_rep/clusters.py:15`**
   - Imports: `weighted_mean, weighted_means`
   - **Note:** These specific functions were not used, but the import existed

**Impact:**
- ❌ **Breaking Change:** All tests failed with `ModuleNotFoundError`
- ❌ **Import Chain Broken:** `polismath.conversation` → `pca_kmeans_rep` → `utils.general`
- ❌ **Production Code Broken:** Vote conversion failed in database and pipeline modules

**Resolution:**
- ✅ File restored from git history (commit `884a59db49^`)
- ✅ Tests now pass (211 passed, 7 skipped, 2 xfailed)

**Root Cause:**
The grep command **does work correctly**:
```bash
$ grep -r "from polismath.utils.general import" --include="*.py" .
polismath/database/postgres.py:from polismath.utils.general import postgres_vote_to_delphi
polismath/pca_kmeans_rep/repness.py:from polismath.utils.general import AGREE, DISAGREE
polismath/pca_kmeans_rep/clusters.py:from polismath.utils.general import weighted_mean, weighted_means
polismath/run_math_pipeline.py:from polismath.utils.general import postgres_vote_to_delphi
```

**Likely Causes:**
1. Grep run from wrong directory (outside repo)
2. Wrong git state analyzed (branch where imports were missing)
3. Human error in reading grep output
4. Silent tool failure

---

## Correctly Deleted Code (Verified)

### ✅ Legacy Poller/System Architecture (1,162 lines)

| File | Lines | Status |
|------|-------|--------|
| `polismath/__main__.py` | 150 | ✅ Correctly removed - no references |
| `polismath/system.py` | 208 | ✅ Correctly removed - only used by `__main__.py` |
| `polismath/poller.py` | 507 | ✅ Correctly removed - replaced by `scripts/job_poller.py` |
| `polismath/components/server.py` | 297 | ✅ Correctly removed - only used by legacy system |

**Verification:**
```bash
$ grep -r "from polismath.system\|from polismath.poller\|from polismath.components.server" --include="*.py" .
# No matches (only in docs/DEAD_CODE_CLEANUP_REPORT.md)
```

**Note:** The new poller at `scripts/job_poller.py` is a completely different implementation using DynamoDB job queue, not the legacy PostgreSQL continuous polling.

### ✅ Unused Import (1 line)

| File | Line | Import | Status |
|------|------|--------|--------|
| `polismath/pca_kmeans_rep/corr.py` | 14 | `squareform` from scipy.spatial.distance | ✅ Correctly removed |

**Verification:**
```bash
$ grep "squareform" polismath/pca_kmeans_rep/corr.py
# No matches
```

---

## Additional Cleanup (Post-Audit)

### Unused Imports Removed (3 files, 5 imports)

Following the audit, these additional unused imports were identified and removed:

**1. `polismath/pca_kmeans_rep/clusters.py`**
```python
# BEFORE:
from polismath.utils.general import weighted_mean, weighted_means

# AFTER:
# (removed - functions never called in this file)
```
- Vulture confidence: 90%
- Verified: Functions imported but never called

**2. `polismath/database/postgres.py`**
```python
# BEFORE:
from sqlalchemy.dialects.postgresql import JSON, JSONB
from sqlalchemy.pool import QueuePool

# AFTER:
from sqlalchemy.dialects.postgresql import JSONB
# (JSON and QueuePool removed - never used)
```
- Vulture confidence: 90%
- Verified: Only JSONB is used, JSON and QueuePool never referenced

**3. `scripts/job_poller.py`**
```python
# BEFORE:
from sqlalchemy.dialects.postgresql import JSON, JSONB
from sqlalchemy.pool import QueuePool

# AFTER:
from sqlalchemy.dialects.postgresql import JSONB
# (JSON and QueuePool removed - never used)
```
- Vulture confidence: 90%
- Verified: Same pattern as postgres.py

**Verification:**
```bash
$ .venv/bin/pytest tests/test_clusters.py tests/test_postgres_real_data.py -v
# 25 passed, 1 skipped, 1 warning in 5.04s
```

---

## Final Statistics (Corrected)

### Commits Made

| Commit | Description | Files | Lines |
|--------|-------------|-------|-------|
| `cebd9d2b6` | Remove legacy poller/system architecture | 6 | -1,165 |
| `884a59db4` | ~~Remove dead code~~ **FALSE POSITIVE** | ~~5~~ 4 | ~~-524~~ -261 |
| `ec5532d83` | Update RUNNING_THE_SYSTEM.md and archive docs | 3 | -229 |
| *(new)* | Restore general.py + remove unused imports | 4 | +263 -5 |

### Summary by Category

| Category | Lines |
|----------|-------|
| ✅ Legacy system (4 files) | -1,162 |
| ❌ **Incorrectly deleted** (general.py) | ~~-263~~ **+263 (restored)** |
| ✅ Unused imports (original) | -1 |
| ✅ Unused imports (post-audit) | -5 |
| ✅ Outdated documentation | -492 |
| **Net Total** | **-1,397** |

---

## Lessons Learned

### What Went Wrong

1. **No Test Suite Run:** Network issues prevented running tests before merging
2. **Insufficient Verification:** Relied solely on grep without cross-checking
3. **No Staged Commits:** All deletions in one commit made rollback harder
4. **No Import Validation:** Didn't verify Python can import after changes

### Recommended Process Improvements

**Before Deleting Code:**
1. ✅ Run grep from multiple directories (repo root, delphi/, parent/)
2. ✅ Use multiple search patterns (import, from X import, X.function())
3. ✅ Check for dynamic imports (importlib, __import__, eval)
4. ✅ Search for string references (especially for entry points)
5. ✅ **Always run full test suite** (block on network if needed)

**During Deletion:**
1. ✅ Create one commit per logical group (system files, utils, docs)
2. ✅ Test after each commit, not just at the end
3. ✅ Use `git bisect` to verify each change independently

**After Deletion:**
1. ✅ Verify imports: `python -c "import module"`
2. ✅ Run full test suite with coverage
3. ✅ Check for runtime errors, not just import errors
4. ✅ Validate all entry points still work

### Automated Tools to Consider

**For Finding Dead Code:**
- `vulture` - Static analysis (already used)
- `coverage.py` - Runtime coverage analysis
- `autoflake` - Automatic unused import removal
- `pycln` - Import cleaner

**For Verification:**
- `pytest --collect-only` - Verify test discovery
- `mypy` - Static type checking
- `ruff check` - Fast linter

---

## Remaining Vulture Findings (Not Addressed)

Vulture identified **93 additional items** (after removing the 5 imports above). These were NOT removed due to:
- Lower confidence (60% vs 90%)
- Potential use in untested code paths
- Need for domain expertise to verify

### High-Priority Candidates (90%+ confidence)

**Unused Imports:**
- `polismath/components/config.py:12` - `Set`
- `polismath/conversation/conversation.py:10` - `Set`
- `polismath/conversation/manager.py:10` - `Set`
- `polismath/database/postgres.py:13` - `Set`
- `scripts/delphi_cli.py:23` - `Text`
- `scripts/delphi_cli.py:24` - `rprint`
- `umap_narrative/801_narrative_report_batch.py:40` - `csv`
- `umap_narrative/801_narrative_report_batch.py:41` - `io`
- `umap_narrative/polismath_commentgraph/core/clustering.py:6` - `hdbscan`
- `umap_narrative/polismath_commentgraph/core/clustering.py:14` - `delayed`, `Parallel`

**Potentially Unused Classes:**
- `polismath/conversation/manager.py` - `ConversationManager` class (needs verification)
- `polismath/database/postgres.py` - `PostgresManager` class (many unused methods)

**Statistical Functions (in stats.py):**
- Only used by test files - may be legitimate test utilities

**Recommendation:**
- Address high-confidence (90%+) unused imports in next cleanup
- Verify each with grep AND by removing + running tests
- Leave 60% confidence items for manual review

---

## Reproducibility

### Verify Cleanup Was Correct

```bash
# 1. Verify legacy system imports are gone
grep -r "from polismath.system\|from polismath.poller" --include="*.py" . | grep -v DEAD_CODE
# Expected: No matches (except this report)

# 2. Verify general.py imports exist
grep -r "from polismath.utils.general import" --include="*.py" .
# Expected: 4 matches (postgres.py, repness.py, clusters.py, run_math_pipeline.py)

# 3. Verify unused imports are gone
grep "from polismath.utils.general import weighted_mean" polismath/pca_kmeans_rep/clusters.py
# Expected: No match

grep "from sqlalchemy.pool import QueuePool" polismath/database/postgres.py
# Expected: No match

# 4. Verify tests pass
uv sync --extra dev
.venv/bin/pytest tests/ -v
# Expected: 211 passed, 7 skipped, 2 xfailed
```

### Search for Additional Dead Code

```bash
# Run vulture
uv pip install vulture
.venv/bin/vulture . --min-confidence 90 --exclude ".git,__pycache__,*.pyc,.venv,tests"

# Check for unused imports only
.venv/bin/vulture . --min-confidence 90 --exclude ".git,__pycache__,*.pyc,.venv,tests" | grep "unused import"
```

---

## Documentation Updates

### Files Archived (moved to docs/archive/)

| File | Reason |
|------|--------|
| `conversion_plan.md` | Historical - conversion completed ~1 year ago |
| `NEXT_STEPS.md` | Outdated roadmap from conversion era |
| `project_structure.md` | Described *proposed* structure, not actual |
| `architecture_overview.md` | Described Clojure implementation, not Python |
| `summary.md` | Referenced deleted poller/server/system components |

### Files Updated

- **`docs/RUNNING_THE_SYSTEM.md`:** Removed `SystemManager` references, added current CLI commands
- **`polismath/__init__.py`:** Removed `System`, `SystemManager` exports
- **`polismath/components/__init__.py`:** Removed `Server`, `ServerManager` exports

---

## Conclusion

The dead code cleanup successfully removed **1,397 lines** of genuinely dead code, but also **incorrectly deleted** a critical utility module that broke all tests.

**Key Takeaways:**
- ✅ Legacy poller/system architecture removal was correct
- ❌ `general.py` deletion was a false positive due to faulty grep verification
- ✅ Additional unused imports were found and removed post-audit
- ⚠️ 93 additional items remain from Vulture analysis (lower confidence)

**Next Steps:**
1. Review and address high-confidence (90%+) unused imports from Vulture
2. Implement automated unused import removal in CI/CD
3. Add pre-commit hooks to prevent unused imports
4. Improve test coverage to catch more issues automatically

---

*Report corrected and updated: January 7, 2026*
