# Global Section Template Mapping Fix

## Issue Identified

The global section template mapping logic in `801_narrative_report_batch.py` had a critical flaw that could cause conflicts between concurrent jobs processing the same conversation.

### Root Cause

**Original problematic code (line 991)**:

```python
base_name = topic_name.replace("global_", "")
```

**The Problem**: This logic assumed `topic_name` would be in the format `"global_groups"`, but actually:

- **topic_name**: `"groups"` (just the short name)
- **topic_key**: `"batch_report_r6vbnhffkxbd7ifmfbdrd_1749465598_b83d9a1b_global_groups"` (full versioned key)
- **section_name**: `"batch_report_r6vbnhffkxbd7ifmfbdrd_1749465598_b83d9a1b_global_groups"` (derived from topic_key)

Since `topic_name` was just `"groups"` (not `"global_groups"`), the `.replace("global_", "")` operation did nothing, and the code worked by accident.

### Potential Issues

1. **Fragile Logic**: Code worked by coincidence, not by design
2. **Concurrent Job Conflicts**: Multiple jobs with different `job_id`s but same conversation could overwrite each other's template mappings
3. **Version Format Changes**: Any changes to the topic key format could break template selection

## Solution Implemented

**New robust code (lines 990-1007)**:

```python
# Extract the base name from the section_name (works with both old and new formats)
# Old format: "global_groups" -> "groups"  
# New format: "batch_report_xxx_global_groups" -> "groups"
if section_name.endswith("_groups"):
    base_name = "groups"
elif section_name.endswith("_group_informed_consensus"):
    base_name = "group_informed_consensus"
elif section_name.endswith("_uncertainty"):
    base_name = "uncertainty"
else:
    # Fallback: try the old logic for backwards compatibility
    base_name = topic_name.replace("global_", "")
    logger.warning(f"Could not determine base name from section_name '{section_name}', using fallback: '{base_name}'")
```

### Benefits of New Approach

1. **Format Agnostic**: Works with both old (`global_groups`) and new (`batch_report_xxx_global_groups`) formats
2. **Job Isolation**: Multiple concurrent jobs can't interfere with each other's template selection
3. **Explicit Logic**: Clear, explicit matching instead of string replacement tricks
4. **Backward Compatible**: Falls back to old logic if new patterns don't match
5. **Better Logging**: Logs the actual section_name and base_name for debugging

## Technical Details

### Global Section Types Supported

| Base Name | Template File | Section Name Examples |
|-----------|---------------|----------------------|
| `groups` | `groups.xml` | `global_groups`, `batch_report_xxx_global_groups` |
| `group_informed_consensus` | `group_informed_consensus.xml` | `global_group_informed_consensus`, `batch_report_xxx_global_group_informed_consensus` |
| `uncertainty` | `uncertainty.xml` | `global_uncertainty`, `batch_report_xxx_global_uncertainty` |

### Data Flow

1. **Topic Generation** (`get_topics()` method):

   ```python
   global_topic_prefix = f"{self.job_id}_global"
   topic_key = f"{global_topic_prefix}_groups"  # → batch_report_xxx_global_groups
   ```

2. **Section Name Conversion**:

   ```python
   section_name = topic_key.replace('#', '_')  # → batch_report_xxx_global_groups
   ```

3. **Template Selection** (FIXED):

   ```python
   if section_name.endswith("_groups"):
       base_name = "groups"
       template_filename = "groups.xml"
   ```

## Verification

The fix ensures that:

- ✅ **Old format sections** (`global_groups`) still work
- ✅ **New format sections** (`batch_report_xxx_global_groups`) work correctly  
- ✅ **Multiple concurrent jobs** can't interfere with each other
- ✅ **Template selection** is deterministic and explicit
- ✅ **Debugging** is improved with better logging

## Files Modified

- **File**: `/Users/colinmegill/polis/delphi/umap_narrative/801_narrative_report_batch.py`
- **Lines**: 981-1007 (template selection logic)
- **Change Type**: Bug fix + robustness improvement

## Testing

This fix was implemented as part of the UI consistency work where both TopicReport and CommentsReport were updated to handle versioned topic keys. The template mapping fix ensures that global sections continue to use the correct XML templates regardless of the topic key format.

## Related Work

This fix is part of the broader effort to:

1. Implement versioned topic keys for Smart Comment Filtering
2. Resolve UI consistency issues between TopicReport and CommentsReport
3. Support concurrent batch processing jobs without conflicts

See also:

- `SMART_COMMENT_FILTERING_PLAN.md`
- UI component refactoring in `client-report/src/components/topicReport/`
