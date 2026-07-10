# Versioned Topic Keys Implementation Guide

## Overview

As part of the Smart Comment Filtering for Multi-Layer Batch Reports initiative, we've discovered that the system has evolved to use versioned topic keys. This document outlines what needs to be completed to properly land this feature as part of the broader narrative batch work.

## Current State

### ✅ What's Working
- **801_narrative_report_batch.py**: Generates versioned topic keys (`9c867bbb-1616-44e3-947c-1406bc56e4d2#0#42`)
- **803_check_batch_status.py**: Parses versioned custom IDs and stores reports correctly
- **TopicReport.jsx**: Dynamically constructs section keys using job UUID from server
- **Server API**: `/api/v3/delphi` extracts and provides job UUID for key construction
- **Global Sections**: Working with both legacy and versioned formats

### 🚧 Current Issue
The system generates versioned topic keys but the frontend components aren't fully aligned with this new system. We have a hybrid state that works but needs completion.

## Integration with Smart Comment Filtering Plan

The versioned topic keys are a foundational piece of the Smart Comment Filtering implementation:

1. **Job Isolation**: Each batch run (with different filtering criteria) gets unique keys
2. **Multi-Layer Support**: Versioned keys enable proper separation between layer processing runs
3. **Global Sections**: Versioned keys support the planned global sections architecture
4. **Reproducibility**: Essential for A/B testing different filtering thresholds

## Required Changes

### 1. CommentsReport.jsx Updates
**Purpose**: Align with versioned key system for global sections

**Current State**: Uses simple global section names
**Target State**: Uses versioned global section names when available

**Implementation**:
```javascript
// In CommentsReport.jsx - update global section key construction
const globalSections = [
  {
    key: runInfo?.job_uuid ? `global_groups` : "global_groups",
    name: "Divisive Comments (Global)",
    // ... existing config
  },
  // ... other global sections
];
```

**Files to Modify**:
- `/client-report/src/components/commentsReport/CommentsReport.jsx`

### 2. Enhanced Server API Response
**Purpose**: Ensure consistent job UUID provision across all endpoints

**Current State**: `/api/v3/delphi` provides job UUID
**Target State**: All narrative report endpoints provide job UUID context

**Implementation**:
- Verify `/api/v3/delphi/reports` includes job UUID information
- Ensure global sections are properly versioned in responses
- Add debug logging for job UUID extraction

**Files to Modify**:
- `/server/src/routes/delphi.ts`
- `/server/src/routes/delphi/reports.ts`

### 3. Complete 801 Versioning Logic
**Purpose**: Ensure all topic key generation uses consistent versioning

**Current State**: Generates versioned keys but may have edge cases
**Target State**: All topic keys (global and layer-specific) use versioned format

**Implementation**:
- Verify global section keys are properly versioned
- Ensure job UUID is consistently applied
- Remove any debug logging once stable

**Files to Modify**:
- `/delphi/umap_narrative/801_narrative_report_batch.py`

### 4. Frontend Key Construction Consistency
**Purpose**: Ensure all components use the same key construction logic

**Current State**: TopicReport uses dynamic construction
**Target State**: Shared utility function for key construction

> **Correction**: The actual key format used in `801_narrative_report_batch.py` is
> `{report_id}#{section}#{model}` with `#` as the delimiter (not underscore).
> Example: `9c867bbb-1616-44e3-947c-1406bc56e4d2#0#42`.
> The `constructSectionKey` example below uses underscore delimiters and does NOT
> reflect the current production format.
>
> Note: `CommentsReport.jsx` updates and `sectionKeyUtils.js` creation (marked 🚧 below)
> were never implemented.

**Implementation**:
```javascript
// Shared utility function
const constructSectionKey = (sectionName, jobUuid = null) => {
  if (jobUuid && !sectionName.startsWith('global_')) {
    // For layer-specific topics, use versioned format
    return `${jobUuid}_${sectionName.replace('layer', '').replace('_', '_')}`;
  }
  // For global sections or legacy data, use as-is
  return sectionName;
};
```

**Files to Modify**:
- `/client-report/src/util/sectionKeyUtils.js` (new file) 🚧 never implemented
- `/client-report/src/components/topicReport/TopicReport.jsx`
- `/client-report/src/components/commentsReport/CommentsReport.jsx` 🚧 never implemented

## Testing Requirements

### 1. Cross-Format Compatibility
- ✅ Legacy conversations (layer0_X format) continue working
- ✅ Versioned conversations (UUID format) work properly
- 🚧 Global sections work with both formats
- 🚧 Mixed scenarios (legacy + versioned data) handle gracefully

### 2. Component Integration
- 🚧 CommentsReport displays global sections correctly
- 🚧 TopicReport shows layer-specific topics correctly
- 🚧 Navigation between global and topic views works
- 🚧 API responses consistent across components

### 3. Smart Filtering Integration
- 🚧 Versioned keys work with filtered comment selection
- 🚧 Different filtering thresholds generate unique versioned keys
- 🚧 A/B testing scenarios supported via versioning

## Implementation Priority

### Phase 1: Complete Core Versioning (This Sprint)
1. **Fix CommentsReport**: Update to handle versioned global sections
2. **Shared Utilities**: Create consistent key construction logic
3. **Testing**: Verify both legacy and versioned formats work
4. **Documentation**: Update this doc with final implementation details

### Phase 2: Smart Filtering Integration (Next Sprint)
1. **Filter Metrics**: Implement comment filtering based on statistical metrics
2. **Dynamic Limits**: Add layer-based comment limits
3. **Global Sections**: Complete global sections with filtering
4. **Performance**: Optimize for large conversations

### Phase 3: UI Enhancement (Following Sprint)
1. **Separation**: Clear UI separation between global and topic sections
2. **Navigation**: Improved user experience across section types
3. **Performance**: Optimize loading and display

## Success Criteria

### Technical Success
- [ ] All components handle versioned keys correctly
- [ ] No regression in legacy format support
- [ ] Global sections work with versioned system
- [ ] Consistent API responses across endpoints

### User Experience Success
- [ ] Reports load correctly for all conversation types
- [ ] Global and topic sections display properly
- [ ] Navigation between sections is seamless
- [ ] No user-visible errors or inconsistencies

### Smart Filtering Readiness
- [ ] Versioned keys support filtered comment sets
- [ ] Multiple filtering runs can coexist
- [ ] A/B testing infrastructure ready
- [ ] Performance scales with conversation size

## Next Steps

1. **Immediate (This Week)**:
   - Complete CommentsReport versioning support
   - Create shared key construction utilities
   - Test cross-format compatibility

2. **Short Term (Next Week)**:
   - Integrate with smart filtering metrics
   - Implement dynamic comment limits
   - Complete global sections

3. **Medium Term (Following Weeks)**:
   - UI enhancement and separation
   - Performance optimization
   - Production deployment

## Notes

This versioned topic key system is not a bug or edge case - it's the correct evolution of the Delphi system to support the Smart Comment Filtering initiative. The versioning enables the sophisticated multi-layer, multi-threshold batch processing that's central to the filtering plan.

The current "hybrid" state where both formats work is actually the desired transition state, allowing us to maintain compatibility while rolling out the enhanced system.