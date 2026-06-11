# ZID Exposure Audit - Delphi Routes

> **Status (2026-06-11):** Still open — `conversation_id` (zid) is still exposed in delphi API responses (e.g., `server/src/routes/delphi.ts` response assembly). The remediation steps below were never executed.

## 🚨 **CRITICAL WARNING - FIELD NAME AMBIGUITY**

**The term "conversation_id" is DANGEROUSLY AMBIGUOUS and could mean:**
- ✅ **Zinvite** (public identifier like `4anfsauat2`) - SAFE
- ❌ **ZID** (internal database ID like `39321`) - SECURITY ISSUE

**NEVER assume `conversation_id` field contents without verification!**

**Before any fixes**: We MUST verify what data type each `conversation_id` field actually contains:
- If it contains zinvites → Already safe, no fix needed
- If it contains ZIDs → Security issue, must fix

**Data Flow Investigation ✅ COMPLETED**: 
- `/api/v3/reports` returns `conversation_id: "4anfsauat2"` (zinvite - SAFE)
- `/api/v3/delphi` returns `conversation_id: "39321"` (ZID - CONFIRMED SECURITY ISSUE)
- `getZidFromReport()` returns numeric ZID which gets stringified and exposed

**CONFIRMED**: All delphi routes ARE exposing real ZIDs, not zinvites!

## Overview
This document identifies all locations where internal ZID (database conversation IDs) are being exposed to clients through API responses. ZIDs are internal database identifiers (like `39321`) that should never be visible to users. Only public identifiers like zinvites (`4anfsauat2`) and report IDs (`r6vbnhffkxbd7ifmfbdrd`) should be exposed.

**Status**: 🔴 **CRITICAL SECURITY ISSUE** - Multiple ZID exposures found (PENDING VERIFICATION)

## Executive Summary

**ZID Exposures Found**: 6 locations across 5 server route files
**Risk Level**: HIGH - Internal database structure exposed to clients
**Scope**: All delphi API endpoints expose conversation_id (ZID) in responses

## Detailed Findings

### 1. `/server/src/routes/delphi.ts` ❌ **ZID EXPOSED**

**Endpoint**: `GET /api/v3/delphi`
**Lines**: 87-88, 142-143
**Exposure Type**: Response body includes `conversation_id`

```typescript
// Lines 87-88 (Error case)
conversation_id,
runs: {}, // Return "runs" object for consistency

// Lines 142-143 (Success case)  
conversation_id,
runs: sortedRuns,
```

**Impact**: ZID exposed in both success and error responses

---

### 2. `/server/src/routes/delphi/batchReports.ts` ❌ **ZID EXPOSED**

**Endpoint**: `POST /api/v3/delphi/batchReports` 
**Lines**: 145-146
**Exposure Type**: Response body includes `conversation_id`

```typescript
// Lines 145-146
report_id: report_id,
conversation_id: conversation_id,
job_id: job_id,
```

**Impact**: ZID exposed when batch report jobs are created

---

### 3. `/server/src/routes/delphi/jobs.ts` ❌ **ZID EXPOSED**

**Endpoint**: `POST /api/v3/delphi/jobs`
**Lines**: 179-180  
**Exposure Type**: Response body includes `conversation_id`

```typescript
// Lines 179-180
job_id: job_id,
conversation_id: zid,
```

**Impact**: ZID exposed when new delphi jobs are created

---

### 4. `/server/src/routes/delphi/visualizations.ts` ❌ **ZID EXPOSED**

**Endpoint**: `GET /api/v3/delphi/visualizations`
**Lines**: 139, 149, 246-247
**Exposure Type**: Response body includes `conversation_id` in multiple scenarios

```typescript
// Line 139 (Error case)
conversation_id,

// Line 149 (No visualizations case)  
conversation_id,

// Lines 246-247 (Success case)
report_id,
conversation_id,
jobs: jobsWithVisualizations,
```

**Impact**: ZID exposed in all visualization API responses

---

### 5. `/server/src/routes/delphi/topics.ts` ❌ **ZID EXPOSED**

**Endpoint**: `GET /api/v3/delphi` (aliased handler)
**Lines**: 129, 196, 278, 294, 357
**Exposure Type**: Response body includes `conversation_id` in ALL response scenarios

```typescript
// Line 129 (Table not found)
conversation_id: conversation_id,

// Line 196 (No topics found)
conversation_id: conversation_id,

// Line 278 (Success case)
conversation_id: conversation_id,

// Line 294 (Table not found error)  
conversation_id: conversation_id,

// Line 357 (Processing error)
conversation_id: conversation_id,
```

**Impact**: ZID exposed in every possible response scenario

---

### 6. `/server/src/routes/delphi/reports.ts` ✅ **NO ZID EXPOSURE**

**Endpoint**: `GET /api/v3/delphi/reports`
**Status**: CLEAN - Uses proper `report_id` approach
**Note**: This file was already fixed in previous conversation

## Root Cause Analysis

### Pattern Identified
All affected files follow the same problematic pattern:

1. ✅ **Correctly** accept `report_id` from client
2. ✅ **Correctly** convert `report_id` to internal `zid` using `getZidFromReport()`
3. ✅ **Correctly** use `zid` for internal database operations
4. ❌ **INCORRECTLY** expose `zid` as `conversation_id` in API responses

### Example Problem Code
```typescript
const zid = await getZidFromReport(report_id);
const conversation_id = zid.toString();

// PROBLEM: Exposing internal ZID to client
return res.json({
  status: "success",
  report_id: report_id,
  conversation_id: conversation_id,  // ← ZID EXPOSED
  // ...other data
});
```

## Fix Strategy

### Required Changes
For each affected endpoint, remove `conversation_id` from ALL response objects:

```typescript
// BEFORE (Bad)
return res.json({
  status: "success",
  report_id: report_id,
  conversation_id: conversation_id,  // ← Remove this
  runs: sortedRuns,
});

// AFTER (Good)  
return res.json({
  status: "success",
  report_id: report_id,              // ← Keep only public identifiers
  runs: sortedRuns,
});
```

### Files Requiring Changes

1. **`/server/src/routes/delphi.ts`**
   - Remove `conversation_id` from lines 87-88, 142-143

2. **`/server/src/routes/delphi/batchReports.ts`**  
   - Remove `conversation_id` from line 145

3. **`/server/src/routes/delphi/jobs.ts`**
   - Remove `conversation_id` from line 180

4. **`/server/src/routes/delphi/visualizations.ts`**
   - Remove `conversation_id` from lines 139, 149, 247

5. **`/server/src/routes/delphi/topics.ts`**
   - Remove `conversation_id` from lines 129, 196, 278, 294, 357

### Testing Requirements
After fixes:
1. Verify all endpoints still function correctly
2. Confirm no ZID values appear in any API responses  
3. Ensure report_id values are preserved for client use
4. Test error scenarios to ensure ZID not leaked in error responses

## Security Impact

### Current Risk
- **Data Exposure**: Internal database structure revealed to clients
- **Privacy**: ZIDs could be used to infer conversation creation order
- **Security**: Potential enumeration attacks using sequential ZIDs

### Post-Fix Benefits
- ZIDs remain internal implementation details
- Clients only see public identifiers (report_id, zinvite)
- Reduced attack surface for enumeration attempts

## Next Steps

1. ✅ **Document all ZID exposures** (This document)
2. ⏳ **Fix server routes** (Remove conversation_id from responses)
3. ⏳ **Fix delphi visualization generation** (Known issue in delphi/umap/700)
4. ⏳ **Test full pipeline** (Ensure no regressions)
5. ⏳ **Client verification** (Confirm frontend still works without ZIDs)

## Client Impact Assessment

### Frontend Dependencies ✅ **AUDIT COMPLETED**

**Good News**: The client-report application does **NOT** depend on `conversation_id` from delphi API responses.

**Analysis**: 
- ✅ Client gets ZID from `/api/v3/reports` endpoint (not delphi endpoints)
- ✅ Client uses `report.conversation_id` from the reports table
- ✅ Delphi API responses containing `conversation_id` are not consumed by client
- ✅ No ZID dependencies in delphi-related client code

### Client ZID Usage Patterns Found:

#### 1. **Legitimate ZID Usage** ✅ (via /api/v3/reports)
**File**: `/client-report/src/components/app.jsx`
**Pattern**: Client fetches ZID through proper channel
```javascript
// Lines 279-290: Proper ZID acquisition
const getReport = (report_id) => {
  return net.polisGet("/api/v3/reports", {
    report_id: report_id,
  }).then((reports) => {
    return reports[0]; // Contains conversation_id from reports table
  });
};

// Lines 341-358: Uses ZID for internal API calls
return getMath(report.conversation_id);        // ✅ OK - Internal use
return getComments(report.conversation_id);    // ✅ OK - Internal use  
return getConversation(report.conversation_id);// ✅ OK - Internal use
```

#### 2. **Display Usage** ✅ (Uses zinvites - SAFE)
**File**: `/client-report/src/components/framework/heading.jsx:32`
**File**: `/client-report/src/components/RawDataExport.jsx:15`
```javascript
// Heading component shows zinvite in URL
href={`${urlPrefix + conversation.conversation_id}`}

// File download names include zinvite
`${timestamp}-${conversation.conversation_id}-${file}.csv`
```
**Impact**: These use `conversation.conversation_id` from `/api/v3/reports` which contains **zinvites** (like `4anfsauat2`), not ZIDs. **NO ZID EXPOSURE**.

#### 3. **No Delphi Dependencies Found** ✅
- No consumption of `conversation_id` from delphi API responses
- All delphi endpoint calls use `report_id` parameter
- Client logging shows delphi response structure but doesn't use `conversation_id`

### Mitigation Strategy ✅ **SIMPLIFIED**

**Original Plan**: ❌ Complex - Fix server first, then client  
**Actual Plan**: ✅ Simple - Only fix server routes (client already safe)

1. **Server Route Fixes**: Remove `conversation_id` from delphi API responses
2. **Client Impact**: None - client doesn't use those fields
3. **Optional Cleanup**: Consider removing cosmetic ZID displays (separate task)

---

**Document Created**: 2025-06-07
**Last Updated**: 2025-06-07  
**Status**: 🔴 Active remediation required