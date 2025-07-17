# Topic Agenda Storage Design

## Overview

This document outlines the design for storing user topic agenda selections as archetypal comments. The system stores stable comment references that persist across Delphi topic modeling runs, allowing users to maintain their preferences even as topic names and clusters change.

## Problem Statement

- Topic names and cluster assignments change between Delphi runs
- Users need their topic selections to persist across these changes
- Solution: Store archetypal comments (stable comment IDs) instead of topic references

## Data Model

### DynamoDB Table: `Delphi_TopicAgendaSelections`

**Primary Key Design:**
- **Partition Key**: `conversation_id` (string) - The zid of the conversation
- **Sort Key**: `participant_id` (string) - The pid of the participant

**Attributes:**
```json
{
  "conversation_id": "string",      // zid as string
  "participant_id": "string",       // pid as string
  
  "archetypal_selections": [
    {
      "layer_id": "number",         // 0, 1, 2, 3, etc.
      "cluster_id": "string",       // The cluster within that layer
      "topic_key": "string",        // Original topic key for reference
      "archetypal_comments": [
        {
          "comment_id": "string",   // Stable comment identifier
          "comment_text": "string", // Cached for display
          "coordinates": {
            "x": "number",          // UMAP x coordinate
            "y": "number"           // UMAP y coordinate
          },
          "distance_to_centroid": "number"
        }
      ],
      "selection_timestamp": "string" // ISO 8601 timestamp
    }
  ],
  
  "metadata": {
    "job_id": "string",            // Delphi job ID these selections are from
    "created_at": "string",        // ISO 8601 timestamp
    "updated_at": "string",        // ISO 8601 timestamp
    "version": "number",           // Schema version (start with 1)
    "total_selections": "number"   // Count of selected topics
  }
}
```

## API Design

### 1. Save Topic Agenda Selections

**Endpoint:** `POST /api/v3/topicAgenda/selections`

**Request Headers:**
```
Content-Type: application/json
Cookie: [authentication cookie]
```

**Request Body:**
```json
{
  "conversation_id": "string",
  "selections": [
    {
      "layer_id": 3,
      "cluster_id": "9",
      "topic_key": "layer3_9",
      "archetypal_comments": [
        {
          "comment_id": "123",
          "comment_text": "We need better public transportation",
          "coordinates": { "x": 1.23, "y": 4.56 },
          "distance_to_centroid": 0.15
        }
      ]
    }
  ]
}
```

**Response:**
```json
{
  "status": "success",
  "message": "Topic agenda selections saved successfully",
  "data": {
    "conversation_id": "string",
    "participant_id": "string",
    "selections_count": 3,
    "job_id": "string"
  }
}
```

### 2. Retrieve Topic Agenda Selections

**Endpoint:** `GET /api/v3/topicAgenda/selections?conversation_id={zid}`

**Response:**
```json
{
  "status": "success",
  "data": {
    "conversation_id": "string",
    "participant_id": "string",
    "archetypal_selections": [...],
    "metadata": {...}
  }
}
```

### 3. Update Topic Agenda Selections

**Endpoint:** `PUT /api/v3/topicAgenda/selections`

Same structure as POST, but replaces existing selections entirely.

### 4. Delete Topic Agenda Selections

**Endpoint:** `DELETE /api/v3/topicAgenda/selections?conversation_id={zid}`

## Implementation Plan

### Phase 1: Backend Infrastructure
1. Create DynamoDB table with specified schema
2. Implement data access layer in `/server/src/db/topicAgenda.ts`
3. Create API routes in `/server/src/routes/delphi/topicAgenda.ts`
4. Add authentication and authorization checks
5. Implement input validation

### Phase 2: Frontend Integration
1. Update `TopicAgenda.jsx` to call save API on "Done" click
2. Add loading states and error handling
3. Implement retrieval on component mount
4. Add confirmation UI for overwrites

### Phase 3: Cross-Run Persistence
1. Implement comment matching algorithm for new Delphi runs
2. Create migration logic for when clusters change
3. Add fallback UI for missing comments
4. Implement confidence scoring for matches

## Code Examples

### Backend Route Implementation

```typescript
// /server/src/routes/delphi/topicAgenda.ts
import { Router } from 'express';
import { DynamoDBDocumentClient, PutCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { isAuthenticated } from '../../middleware/auth';
import { getPidPromise } from '../../user';
import Conversation from '../../conversation';

const router = Router();
const TABLE_NAME = 'Delphi_TopicAgendaSelections';

router.post('/selections', isAuthenticated, async (req, res) => {
  try {
    const { conversation_id, selections } = req.body;
    const uid = req.user.uid;
    
    // Convert conversation_id to zid
    const zid = await Conversation.getZidFromConversationId(conversation_id);
    const zidStr = zid.toString();
    
    // Get participant ID
    const pid = await getPidPromise(zidStr, uid);
    const pidStr = pid.toString();
    
    // Get current Delphi job ID
    const jobId = await getCurrentDelphiJobId(zidStr);
    
    // Prepare DynamoDB item
    const item = {
      conversation_id: zidStr,
      participant_id: pidStr,
      archetypal_selections: selections,
      metadata: {
        job_id: jobId,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        version: 1,
        total_selections: selections.length
      }
    };
    
    // Save to DynamoDB
    const putParams = {
      TableName: TABLE_NAME,
      Item: item
    };
    
    await docClient.send(new PutCommand(putParams));
    
    res.json({
      status: 'success',
      message: 'Topic agenda selections saved successfully',
      data: {
        conversation_id: zidStr,
        participant_id: pidStr,
        selections_count: selections.length,
        job_id: jobId
      }
    });
    
  } catch (error) {
    console.error('Error saving topic agenda selections:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to save topic agenda selections'
    });
  }
});
```

### Frontend Integration

```javascript
// In TopicAgenda.jsx handleDone function
const handleDone = async () => {
  try {
    // Extract archetypal comments
    const archetypes = extractArchetypalComments(selections, topicData, clusterGroups, commentMap);
    
    // Transform to API format
    const apiSelections = archetypes.map(group => ({
      layer_id: group.layerId,
      cluster_id: group.clusterId,
      topic_key: group.topicKey,
      archetypal_comments: group.archetypes.map(a => ({
        comment_id: a.commentId,
        comment_text: a.text,
        coordinates: a.coordinates,
        distance_to_centroid: a.distance
      }))
    }));
    
    // Send to API
    const response = await fetch('/api/v3/topicAgenda/selections', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        conversation_id: conversation.conversation_id,
        selections: apiSelections
      }),
      credentials: 'include'
    });
    
    const result = await response.json();
    
    if (result.status === 'success') {
      console.log('Selections saved successfully');
      // Show success UI
    } else {
      console.error('Failed to save selections:', result.message);
      // Show error UI
    }
    
  } catch (error) {
    console.error('Error saving selections:', error);
    // Show error UI
  }
};
```

## Migration Strategy

When a new Delphi run creates different clusters:

1. **Spatial Matching**: Use UMAP coordinates to find closest new clusters
2. **Comment Preservation**: Keep original comment IDs as anchors
3. **Confidence Scoring**: Calculate confidence based on:
   - Distance between old and new cluster centroids
   - Percentage of comments that moved together
   - Topic name similarity (if available)
4. **User Notification**: Inform users when their selections need review

## Security Considerations

1. **Authentication**: Require valid user session
2. **Authorization**: Users can only save/retrieve their own selections
3. **Rate Limiting**: Implement rate limits on save operations
4. **Input Validation**: Validate all input data formats
5. **Data Privacy**: Ensure participant selections remain private

## Performance Considerations

1. **Caching**: Cache retrieved selections in memory
2. **Batch Operations**: Support bulk updates for multiple selections
3. **Indexing**: Create GSI if needed for query patterns
4. **Compression**: Consider compressing large selection sets

## Future Enhancements

1. **Selection History**: Track changes over time
2. **Sharing**: Allow users to share their topic agendas
3. **Analytics**: Aggregate anonymous selection patterns
4. **Templates**: Pre-defined topic agenda templates
5. **Export**: Allow users to export their selections

## Success Metrics

1. **Persistence Rate**: % of selections that survive Delphi re-runs
2. **Accuracy**: % of correctly matched topics after re-runs
3. **Performance**: API response times < 200ms
4. **Adoption**: % of users who save their selections