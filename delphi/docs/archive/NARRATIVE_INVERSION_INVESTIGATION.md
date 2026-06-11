# Narrative Report Vote Inversion Investigation

## Executive Summary

**CRITICAL BUG CONFIRMED**: The Delphi Python codebase uses a "natural" sign convention (AGREE=+1, DISAGREE=-1) **by design**, but the sign flip at the PostgreSQL boundary is **missing**. This causes the LLM narrative reports to interpret agreement as disagreement and vice versa.

## Design Intent

The Delphi codebase was **intentionally designed** to use "natural" signs:

- **AGREE = +1** (positive = agreement, intuitive for humans and LLMs)
- **DISAGREE = -1** (negative = disagreement, intuitive for humans and LLMs)
- **PASS = 0**

This design choice was made because:

1. It allows Delphi code maintainers to reason about votes naturally
2. LLMs were getting confused when positive numbers indicated DISAGREEMENT

**The architecture requires sign flipping at data boundaries:**

- Data coming INTO Delphi (from PostgreSQL) should be flipped
- Data going OUT to DynamoDB stays in Delphi's natural convention
- DynamoDB is considered "within Delphi's realm"

## The Root Cause

**The sign flip at the PostgreSQL boundary is MISSING.**

### Vote Conventions by System

| System | AGREE | DISAGREE | PASS |
|--------|-------|----------|------|
| **PostgreSQL/Server/Client** | **-1** | **+1** | 0 |
| **Delphi Internal** | **+1** | **-1** | 0 |

### Evidence: PostgreSQL/Server Convention

**Evidence from authoritative sources:**

1. **Client UI** (`client-participation-alpha/src/components/Statement.jsx:62-65`):

   ```jsx
   <button className="vote-button agree" onClick={() => handleVoteClick(-1)} disabled={isVoting}>
   ...
   <button className="vote-button disagree" onClick={() => handleVoteClick(1)} disabled={isVoting}>
   ```

2. **Client Constants** (`client-participation/js/util/constants.js:11-15`):

   ```javascript
   REACTIONS: {
       AGREE: -1,
       PASS: 0,
       DISAGREE: 1
   }
   ```

3. **Server Report Generation** (`server/src/report.ts:327-330`):

   ```typescript
   // note that -1 means agree and 1 means disagree
   if (row.vote === -1) comment.agrees += 1;
   else if (row.vote === 1) comment.disagrees += 1;
   ```

4. **Server Integration Tests** (`server/__tests__/integration/vote.test.ts`):

   ```typescript
   vote: -1, // -1 = AGREE in this system
   vote: 1,  // 1 = DISAGREE in this system
   ```

### Delphi Internal Convention (BY DESIGN)

The Delphi Python code uses the **natural/intuitive** convention (this is CORRECT for internal use):

1. **Constants Definition** (`delphi/polismath/utils/general.py:15-17`):

   ```python
   AGREE = 1       # CORRECT for Delphi internal use
   DISAGREE = -1   # CORRECT for Delphi internal use
   PASS = 0
   ```

2. **Vote Processing Logic** (`delphi/umap_narrative/polismath_commentgraph/utils/group_data.py:158-163`):

   ```python
   if vote_val == 1:
       voting_patterns[pid]['agree'] += 1    # CORRECT if vote_val has been flipped at boundary
   elif vote_val == -1:
       voting_patterns[pid]['disagree'] += 1  # CORRECT if vote_val has been flipped at boundary
   ```

   **PROBLEM**: This code expects Delphi-convention data, but receives PostgreSQL-convention data (no flip).

3. **Same pattern** (`group_data.py:373-381`):

   ```python
   if vote_val == 1:
       vote_data[tid]['total_agrees'] += 1
       vote_data[tid]['groups'][group_id]['agrees'] += 1
   elif vote_val == -1:
       vote_data[tid]['total_disagrees'] += 1
       vote_data[tid]['groups'][group_id]['disagrees'] += 1
   ```

   **PROBLEM**: Same issue - expects flipped data, receives raw PostgreSQL data.

4. **Documentation** (`delphi/docs/QUICK_START.md:157`):
   > Votes: columns `voter-id`, `comment-id`, and `vote` (values: 1=agree, -1=disagree, 0=pass)

   **CORRECT** for Delphi's internal convention.

5. **Documentation** (`delphi/docs/usage_examples.md:185`):

   ```python
   # Randomly determine vote (1=agree, -1=disagree, None=pass)
   ```

   **CORRECT** for Delphi's internal convention.

6. **Test Code Comments** (`delphi/tests/test_repness_unit.py:601`):

   ```python
   'vote': [1, 1, 1, 1, -1, -1, -1, -1]  # AGREE=1, DISAGREE=-1
   ```

   **CORRECT** for Delphi's internal convention.

## Data Flow to Narrative Report

The bug affects the narrative report through this path:

```text
PostgreSQL (votes table)
    │
    │ vote values: AGREE=-1, DISAGREE=+1
    ▼
PostgresClient.get_votes_by_conversation()  ← ❌ MISSING SIGN FLIP HERE
    │
    │ Raw vote values passed through (PostgreSQL convention)
    │ Should be: vote = vote * -1  (flip to Delphi convention)
    ▼
GroupDataProcessor.get_vote_data_by_groups()
    │
    │ Code expects Delphi convention (AGREE=+1)
    │ But receives PostgreSQL convention (AGREE=-1)
    │ Result: vote_val=1 (actually DISAGREE) counted as agree
    ▼
GroupDataProcessor.get_export_data()
    │
    │ Returns inverted agree/disagree counts
    ▼
BatchReportGenerator.get_conversation_data()
    │
    │ Inverted data stored in processed_comments
    ▼
PolisConverter.convert_to_xml()
    │
    │ XML attributes have inverted agrees/disagrees
    ▼
LLM Prompt (topics.xml, groups.xml, etc.)
    │
    │ LLM receives data where "agrees" actually means "disagrees"
    ▼
❌ INVERTED NARRATIVE OUTPUT
```

## PostgreSQL Ingress Points (Boundaries Requiring Sign Flip)

These are the locations where Delphi reads vote data from PostgreSQL. Each needs a sign flip:

### 1. `delphi/umap_narrative/polismath_commentgraph/utils/storage.py`

**Function:** `PostgresClient.get_votes_by_conversation()` (lines 294-316)

```python
def get_votes_by_conversation(self, zid: int) -> List[Dict[str, Any]]:
    sql = """
    SELECT v.zid, v.pid, v.tid, v.vote
    FROM votes_latest_unique v
    WHERE v.zid = :zid
    """
    return self.query(sql, {"zid": zid})  # ❌ No sign flip!
```

### 2. `delphi/polismath/database/postgres.py`

**Function:** `poll_votes()` (around line 456-464)

```python
return [
    {
        "pid": str(v["pid"]),
        "tid": str(v["tid"]),
        "vote": int(v["vote"]),  # ❌ No sign flip!
        "created": v["created"],
    }
    for v in votes
]
```

### 3. `delphi/polismath/run_math_pipeline.py`

**Function:** `fetch_votes()` (lines 67-104)

```python
votes_list.append({
    'pid': str(vote['voter_id']),
    'tid': str(vote['comment_id']),
    'vote': float(vote['vote']),  # ❌ No sign flip!
    'created': created_time
})
```

### 4. `delphi/scripts/job_poller.py`

**Function:** `PostgresClient.get_votes_by_conversation()` (lines 288-310)

```python
# Similar pattern - raw query with no sign flip
```

## Impact

Because the boundary flip is missing, PostgreSQL data (AGREE=-1) is passed directly to Delphi code expecting (AGREE=+1):

- Comments with high agreement in PostgreSQL (vote=-1) are counted as disagrees in Delphi
- Comments with high disagreement in PostgreSQL (vote=+1) are counted as agrees in Delphi
- All derivative calculations (consensus, extremity, group patterns) are inverted
- LLM receives inverted data and generates backwards narratives

## Questions to Investigate Further

1. **Does the Clojure math pipeline use PostgreSQL convention or does it flip?**
   - The `math/src/polismath/math/conversation.clj` has `(s/def ::vote #{-1 0 1 -1.0 1.0 0.0})` but doesn't explicitly document semantics
   - If Clojure uses PostgreSQL convention (AGREE=-1), then `math_main` table values are in that convention
   - This would mean Delphi should NOT flip values read from `math_main` (they're already processed)

2. **Are there any write operations back to PostgreSQL?**
   - If Delphi writes vote data back to PostgreSQL, it would need a reverse flip
   - Currently unclear if any such writes exist

3. **What about data from `./math` Clojure pipeline?**
   - Does Delphi read any intermediate results from the Clojure math pipeline?
   - If so, what convention do those use?

4. **CSV imports in tests**
   - Do the CSV test fixtures use PostgreSQL convention or Delphi convention?
   - If PostgreSQL convention, the CSV loading functions need flipping too

## Fix Applied: Centralized Sign Flip at PostgreSQL Boundary

A centralized utility function was added to handle vote sign conversion, and it's applied at each PostgreSQL ingress point.

### Canonical Function: `delphi/polismath/utils/general.py`

```python
def postgres_vote_to_delphi(pg_vote: Union[int, float]) -> Union[int, float]:
    """
    Convert PostgreSQL vote convention to Delphi convention.
    
    PostgreSQL/Server/Client use: AGREE=-1, DISAGREE=+1, PASS=0
    Delphi uses:                  AGREE=+1, DISAGREE=-1, PASS=0
    
    This function should be called at every PostgreSQL data ingress boundary
    to ensure Delphi code receives votes in the expected convention.
    """
    return pg_vote * -1


def delphi_vote_to_postgres(delphi_vote: Union[int, float]) -> Union[int, float]:
    """
    Convert Delphi vote convention to PostgreSQL convention.
    (For future use if Delphi writes vote data back to PostgreSQL)
    """
    return delphi_vote * -1
```

### Fix 1: `delphi/umap_narrative/polismath_commentgraph/utils/storage.py` ✅ APPLIED

- Added local `_postgres_vote_to_delphi()` function (same logic, local to avoid cross-package dependency)
- Updated `get_votes_by_conversation()` to apply the flip

### Fix 2: `delphi/polismath/database/postgres.py` ✅ APPLIED

- Added import: `from polismath.utils.general import postgres_vote_to_delphi`
- Updated `poll_votes()` to apply the flip

### Fix 3: `delphi/polismath/run_math_pipeline.py` ✅ APPLIED

- Added import: `from polismath.utils.general import postgres_vote_to_delphi`
- Updated `fetch_votes()` to apply the flip

### Fix 4: `delphi/scripts/job_poller.py` ✅ APPLIED

- Added local `_postgres_vote_to_delphi()` function (same logic, local to avoid import dependencies in standalone script)
- Updated `get_votes_by_conversation()` to apply the flip
- Note: This method may be unused, but updated for consistency

### Testing the Fix

After adding the boundary flips, validate by:

1. **Compare with server CSV export**: The server's report endpoint produces CSVs with correct agree/disagree counts. Delphi's counts should now match.

2. **Existing test suite**: Tests using Delphi convention should still pass (they don't go through PostgreSQL boundary).

3. **Integration test**: Run a narrative report and verify:
   - A comment known to have high agreement in the Polis UI should be described as having high agreement in the narrative
   - Group characterizations should match manual inspection of the Polis report visualization

4. **Spot check math**: For a known comment, manually verify:
   - PostgreSQL: `SELECT vote, COUNT(*) FROM votes WHERE tid=X GROUP BY vote`
   - Delphi output should show the same counts but with flipped signs

## Files Changed

### PostgreSQL Boundary Files (SIGN FLIP APPLIED ✅)

1. **`delphi/umap_narrative/polismath_commentgraph/utils/storage.py`** ✅
   - Added: `_postgres_vote_to_delphi()` local function
   - Updated: `PostgresClient.get_votes_by_conversation()` now flips signs

2. **`delphi/polismath/database/postgres.py`** ✅
   - Added: `from polismath.utils.general import postgres_vote_to_delphi`
   - Updated: `poll_votes()` now flips signs

3. **`delphi/polismath/run_math_pipeline.py`** ✅
   - Added: `from polismath.utils.general import postgres_vote_to_delphi`
   - Updated: `fetch_votes()` now flips signs

4. **`delphi/scripts/job_poller.py`** ✅
   - Added: `_postgres_vote_to_delphi()` local function
   - Updated: `PostgresClient.get_votes_by_conversation()` now flips signs

### Utility Function Added ✅

- **`delphi/polismath/utils/general.py`**
  - Added: `postgres_vote_to_delphi()` - canonical implementation
  - Added: `delphi_vote_to_postgres()` - inverse for potential future writes

### Files That Are CORRECT (No Changes Needed)

These use Delphi's internal convention correctly:

- `delphi/polismath/utils/general.py` - Constants are correct for internal use
- `delphi/umap_narrative/polismath_commentgraph/utils/group_data.py` - Logic is correct for Delphi convention
- `delphi/polismath/conversation/conversation.py` - Vote masks are correct for Delphi convention
- `delphi/docs/*.md` - Documentation is correct for Delphi convention
- `delphi/tests/*.py` - Tests use Delphi convention correctly

### Files to Verify: Other Data Ingress Points

Check if these also read from PostgreSQL without flipping:

- `delphi/tests/test_postgres_real_data.py`
- `delphi/tests/profile_postgres_data.py`
- `delphi/scripts/participation_timeline.py`

## Historical Context

The Delphi codebase was designed with "natural" sign conventions from the start:

- AGREE = +1 (positive = good/agreement)
- DISAGREE = -1 (negative = bad/disagreement)

This was an intentional design choice to make the code more intuitive and to help LLMs reason about the data correctly. The expectation was that sign flipping would happen at data boundaries.

**The bug**: The boundary sign flip was never implemented in the PostgreSQL reading functions.

## Summary

This is a **high-severity bug** where the designed boundary sign flip is missing at PostgreSQL ingress points. The fix is:

1. **Add `vote * -1`** at each PostgreSQL read location (4 files identified)
2. **Leave all other Delphi code unchanged** - it correctly uses Delphi's internal convention
3. **Verify DynamoDB operations** - should already use Delphi convention (no flip needed)

The fix is minimal and surgical - only the boundary functions need changes, not the entire codebase.
