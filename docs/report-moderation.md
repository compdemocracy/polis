# Report Moderation: Architecture Analysis & Issues

This document analyzes the current state of comment moderation/filtering across the Polis report system. It identifies inconsistencies, architectural issues, and proposes improvements.

## Current State Summary

**tl;dr**: There is no consistent source-of-truth for which comments are included in reports. Different parts of the system handle moderation filtering differently, leading to inconsistent behavior.

---

## 1. Moderation Levels in the UI

The **client-admin** UI (`ReportsList.js`) offers three moderation options when creating a report:

| mod_level | Description |
|-----------|-------------|
| -2 | Include all comments |
| -1 | Include all comments except for moderation rejections |
| 0 | Include only moderator accepted comments |

The `mod_level` is stored in the `reports` table and retrieved via `/api/v3/reports`.

---

## 2. How Different Systems Handle Moderation

### 2.1 Server API (Node.js)

The server API properly uses `mod_level` from the report:

```typescript
// server/src/routes/comments.ts:164
req.p.mod_gt = Number(report.mod_level ?? -2);
```

The `getComments()` function then filters comments where `mod > mod_gt`:

- mod_level -2 → includes everything (mod > -2)
- mod_level -1 → includes unmoderated and approved (mod > -1, i.e., mod >= 0)
- mod_level 0 → includes only approved (mod > 0, i.e., mod >= 1)

### 2.2 Delphi Pipeline (Python)

**Problem**: Delphi collapses the three mod_levels into a binary `include_moderation` flag:

```javascript
// client-report/src/components/commentsReport/CommentsReport.jsx:41
include_moderation: reportModLevel !== -2,
```

This means:

- mod_level -2 → `include_moderation = False` → includes all comments ✓
- mod_level -1 → `include_moderation = True` → filters to `mod > -1` ✓ (sort of)
- mod_level 0 → `include_moderation = True` → filters to `mod > -1` ✗ **WRONG!**

**The bug**: mod_level 0 should filter to only approved comments (mod > 0), but Delphi treats it the same as mod_level -1.

Delphi's filtering logic (multiple places):

```python
# delphi/umap_narrative/run_pipeline.py:1351
if include_moderation:
    comments = [comment for comment in comments if comment["mod"] > -1]

# delphi/umap_narrative/polismath_commentgraph/utils/group_data.py:660
if include_moderation:
    comments = [comment for comment in comments if comment['mod'] > -1]

# delphi/umap_narrative/801_narrative_report_batch.py:298
if self.include_moderation:
    comments = [comment for comment in comments if comment['mod'] > -1]
```

All these hardcode `mod > -1`, ignoring the distinction between mod_level -1 and 0.

### 2.3 Client-Report Data Loading

The client-report properly uses the report's mod_level when fetching comments via the server API:

```javascript
// client-report/src/components/app.jsx:387
getComments(_report.conversation_id, _conversation.strict_moderation, authToken, _report.mod_level)
```

But this only affects the **UI display** of comments. When Delphi generates narrative reports and topic analysis, it uses its own direct database queries with the broken binary flag.

---

## 3. Additional Data Source Issues

### 3.1 `report_comment_selections` Table

This table stores per-report comment selections (for matrix visualization, etc.):

```sql
-- schema.sql
CREATE TABLE public.report_comment_selections (
    rid INTEGER REFERENCES reports(rid),
    tid INTEGER,
    selection INTEGER,
    zid INTEGER REFERENCES conversations(zid),
    ...
);
```

**Usage**:

- **Server API** (`comments.ts`): Includes selections when `report_id` is provided
- **Delphi**: Never uses this table - all direct Postgres queries ignore report_comment_selections

This means if an admin manually selects/deselects specific comments for a report, Delphi's narrative generation won't respect those selections.

### 3.2 Props Passed to Report Components

Different report types receive different data:

| Component | Has report_id | Has mod_level | Gets filtered comments |
|-----------|---------------|---------------|------------------------|
| CommentsReport | Yes (via hook) | Yes (`reportModLevel`) | Yes (via API) |
| TopicReport | Yes | No | Via API (uses report.mod_level) |
| ExportReport | Yes | No | Via API |
| Standard Report | Yes (via report obj) | Via report obj | Yes (via API) |
| NarrativeReport | Yes | No | Via API |

Only `CommentsReport` explicitly passes `reportModLevel` to trigger Delphi jobs with moderation settings.

---

## 4. Dual Systems: Real-time Math vs Batch Reports

Delphi has **two parallel systems** that handle comments differently:

### 4.1 Real-time Math System (`system.py`)

Started via `python -m polismath`, this system runs continuously and includes:

```python
# delphi/polismath/system.py
class System:
    def initialize(self):
        self.conversation_manager = ConversationManager(data_dir)
        self.poller = PollerManager.get_poller(...)
        self.server = ServerManager.get_server(...)
```

Components:

- **`server.py`**: FastAPI server with `/api/v3/moderation/{conversation_id}` endpoint
- **`poller.py`**: Polls Postgres for new votes and moderation changes
- **`conversation.py`**: In-memory conversation state with PCA/clustering

This system is designed for **live updates** during active conversations. The moderation handling here (`update_moderation()`, `_poll_moderation()`) is well-implemented.

### 4.2 Batch Report Generation (`run_delphi.py`, `801_narrative_report_batch.py`, etc.)

These scripts run **on-demand** to generate reports. They:

- Query Postgres directly (not via ConversationManager)
- Use a separate filtering logic (`include_moderation` flag)
- Don't use the real-time system's moderation tracking

### 4.3 The Disconnect

**Problem**: The batch report system doesn't leverage the well-designed moderation infrastructure in the real-time system. Instead, each script implements its own filtering:

```python
# Batch scripts (fragmented, inconsistent):
if include_moderation:
    comments = [c for c in comments if c['mod'] > -1]

# Real-time system (proper, unused by batch):
def update_moderation(self, moderation):
    self.mod_out_tids = set(mod_out_tids)
    self.mod_in_tids = set(mod_in_tids)
    self._apply_moderation()
```

This suggests either:

1. The real-time system was built for a use case that didn't materialize, OR
2. The batch scripts were built quickly without integrating the existing infrastructure

---

## 5. Identified Issues

### Issue 1: Binary Collapse of mod_level

**Severity**: High  
**Location**: `CommentsReport.jsx`, Delphi scripts  
**Impact**: mod_level 0 (approved-only) treated same as mod_level -1

### Issue 2: Inconsistent Data Sources

**Severity**: Medium  
**Location**: Server vs Delphi  
**Impact**: Server API respects report settings; Delphi ignores report_comment_selections

### Issue 3: Dual Systems Not Integrated

**Severity**: Medium  
**Location**: Real-time system vs batch scripts  
**Impact**: Well-designed moderation infrastructure exists but isn't used by batch reports

### Issue 4: No mod_level in Delphi Job Schema

**Severity**: High  
**Location**: `server/src/routes/delphi/jobs.ts`  
**Impact**: Cannot properly pass mod_level through job system

---

## 6. Proposed Improvements

### Short-term Fixes

**Replace binary `include_moderation` with numeric `mod_level`**:

- Pass actual `mod_level` to Delphi jobs
- Update Delphi scripts to filter based on numeric threshold

```python
# Instead of:
if include_moderation:
    comments = [c for c in comments if c['mod'] > -1]

# Use:
comments = [c for c in comments if c['mod'] > mod_level]
```

**Add `mod_level` to Delphi job configuration**:

- Update `server/src/routes/delphi/jobs.ts`
- Update `delphi/scripts/job_poller.py`
- Update all Delphi scripts that filter comments

### Medium-term Improvements

**Create single source of truth for comment filtering**:

- Add a utility function in Delphi that mirrors server's `getComments()` behavior
- Include support for `report_comment_selections`

**Document the moderation model**:

- What do `mod` values mean? (-1 = rejected, 0 = unmoderated, 1 = approved)
- When is `is_seed` relevant?
- What's the difference between `mod` and `active`?

### Long-term Architecture

**Consider having Delphi use server API**:

- Instead of direct Postgres queries, have Delphi fetch comments via API
- Ensures consistent filtering logic
- Single place to maintain business rules

**Evaluate and remove orphaned code**:

- If `server.py` moderation endpoints are unused, remove them
- If real-time moderation polling isn't needed, simplify `poller.py`

---

## 7. Questions for Future Investigation

1. **What's the intended use case for the real-time Delphi system?**
   - Is `python -m polismath` meant to run alongside the Node.js server?
   - Should it replace the Clojure math system eventually?
   - Why do batch reports not use the ConversationManager?

2. **Should `report_comment_selections` be respected by Delphi?**
   - Currently only used for the correlation matrix in the UI
   - If admin manually excludes comments, should Delphi respect that?

3. **What happens when mod_level changes after Delphi has generated a report?**
   - Currently, reports become stale
   - Should there be cache invalidation?

4. **Should we unify the systems or keep them separate?**
   - Option A: Have batch scripts use ConversationManager
   - Option B: Keep them separate but share filtering utilities
   - Option C: Have Delphi fetch data via Node.js API (single source of truth)

5. **Is there a mapping between mod values and human-readable states?**
   - Code assumes -1=rejected, 0=unmoderated, 1=approved
   - Is this documented anywhere officially?
   - Are there other values (e.g., for spam, hidden)?

---

## Appendix: Comment Moderation Values

### Official Values (from `server/src/utils/common.ts`)

```typescript
polisTypes.mod = {
  ban: -1,       // rejected by moderator
  unmoderated: 0, // pending review
  ok: 1,         // approved by moderator
}
```

### Report mod_level Filtering

The `mod_level` stored in `reports` table determines which comments appear:

| mod_level | Filter | Result |
|-----------|--------|--------|
| -2 | `mod > -2` | All comments (always true) |
| -1 | `mod > -1` | Unmoderated (0) + Approved (1) |
| 0 | `mod > 0` | Only Approved (1) |

### Strict Moderation Mode

Conversations can have `strict_moderation = true`, which changes behavior:

- In strict mode: `mod = 1` required for display
- In non-strict mode: `mod >= 0` (unmoderated allowed)

### Additional Comment Flags

- `active` (boolean): Whether comment is displayed (can be false due to toxicity filter)
- `is_seed` (boolean): Comment created by moderator/admin (auto-approved)
- `is_meta` (boolean): Meta-comment flag (used for topic moderation)
