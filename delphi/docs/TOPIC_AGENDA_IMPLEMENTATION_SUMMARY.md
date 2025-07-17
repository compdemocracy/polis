# Topic Agenda Implementation Summary

## Quick Overview

This document provides a concise summary of the proposed Topic Agenda storage implementation for quick review.

## Key Design Decisions

### 1. Storage Strategy
- **Store archetypal comment IDs** instead of topic names/clusters
- **Why**: Comment IDs are stable across Delphi runs, topics are not
- **Result**: User selections persist even when topic modeling changes

### 2. DynamoDB Table Structure
- **Table Name**: `Delphi_TopicAgendaSelections`
- **Primary Key**: `conversation_id` (zid)
- **Sort Key**: `participant_id` (pid)
- **Why**: Follows existing Polis patterns, enables efficient per-user queries

### 3. Data Stored Per Selection
```json
{
  "layer_id": 3,
  "cluster_id": "9",
  "archetypal_comments": [
    {
      "comment_id": "123",
      "coordinates": { "x": 1.23, "y": 4.56 }
    }
  ]
}
```

### 4. API Endpoints
- `POST /api/v3/topicAgenda/selections` - Save selections
- `GET /api/v3/topicAgenda/selections?conversation_id={zid}` - Retrieve
- `PUT /api/v3/topicAgenda/selections` - Update
- `DELETE /api/v3/topicAgenda/selections?conversation_id={zid}` - Delete

## Implementation Steps

### Immediate (Phase 1)
1. Create DynamoDB table
2. Implement backend routes
3. Update TopicAgenda.jsx to save on "Done" click
4. Add retrieval on component mount

### Near-term (Phase 2)
1. Add loading/error states
2. Implement overwrite confirmation
3. Add success feedback

### Future (Phase 3)
1. Handle Delphi re-runs (spatial matching)
2. Add confidence scoring
3. Implement migration UI

## Key Questions for Review

1. **Overwrite behavior**: Should we append to existing selections or replace?
2. **Multiple sessions**: Should we track selection history or just current state?
3. **Visibility**: Should selections be private to user or shareable?
4. **Expiration**: Should old selections expire after N days?

## Next Immediate Actions

1. **Backend**: Create `/server/src/routes/delphi/topicAgenda.ts`
2. **Frontend**: Update `handleDone()` in TopicAgenda.jsx
3. **Database**: Create DynamoDB table via AWS console or CloudFormation

## Code to Add to TopicAgenda.jsx

```javascript
// Add to handleDone function after archetypal extraction:
const response = await fetch('/api/v3/topicAgenda/selections', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    conversation_id: conversation.conversation_id,
    selections: archetypes.map(/* transform to API format */)
  }),
  credentials: 'include'
});
```

## Success Criteria

- ✅ User clicks "Done" → selections saved to DynamoDB
- ✅ User returns → previous selections loaded
- ✅ Delphi re-runs → selections still valid via comment IDs
- ✅ API responds in < 200ms