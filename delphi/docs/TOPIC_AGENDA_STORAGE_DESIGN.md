# Topic Agenda Storage Design

## Overview

This document outlines the design for storing user topic agenda selections as archetypal comments. The system stores stable comment references that persist across Delphi topic modeling runs, allowing users to maintain their preferences even as topic names and clusters change.

## Problem Statement

- Topic names and cluster assignments change between Delphi runs
- Users need their topic selections to persist across these changes
- Solution: Store archetypal comments (stable comment IDs) instead of topic references

## Data Model

### PostgreSQL Table: `topic_agenda_selections`

**Table Design:**

- **Primary Key**: Composite key on (`zid`, `pid`)
- **Foreign Keys**: References to `conversations(zid)` and `participants(zid, pid)`

**Table Schema:**

```sql
CREATE TABLE topic_agenda_selections (
  zid INTEGER NOT NULL,                   -- Conversation ID (foreign key)
  pid INTEGER NOT NULL,                   -- Participant ID (foreign key)
  archetypal_selections JSONB,            -- Array of selection objects
  delphi_job_id TEXT,                     -- Delphi job ID that generated the topics
  total_selections INTEGER NOT NULL,      -- Count of selected topics
  created_at TIMESTAMP WITH TIME ZONE,    -- Record creation time
  updated_at TIMESTAMP WITH TIME ZONE,    -- Last update time
  PRIMARY KEY (zid, pid)
);
```

**JSONB Data Structure:**

The `archetypal_selections` column stores an array of selection objects:

```json
[
  {
    "layer_id": 3,                  // Layer number
    "cluster_id": "9",              // Cluster ID within layer
    "topic_key": "layer3_9",        // Original topic key
    "archetypal_comments": [
      {
        "comment_id": "123",        // Stable comment ID
        "comment_text": "...",      // Cached text
        "coordinates": {
          "x": 1.23,               // UMAP x coordinate
          "y": 4.56                // UMAP y coordinate
        },
        "distance_to_centroid": 0.15
      }
    ],
    "selection_timestamp": "2024-01-15T10:30:00Z"
  }
]
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

1. Create PostgreSQL table via migration (000012_create_topic_agenda_selections.sql)
2. Implement API routes in `/server/src/routes/delphi/topicAgenda.ts`
3. Add authentication and authorization checks via existing middleware
4. Implement input validation
5. Use existing pgQuery module for database operations

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
import { Response } from 'express';
import pgQuery from '../../db/pg-query';
import { RequestWithP } from '../../d';

export async function handle_POST_topicAgenda_selections(
  req: RequestWithP,
  res: Response
) {
  try {
    const { selections } = req.body;
    
    // The middleware ensures we have a participant
    const zid = req.p.zid!;
    const pid = req.p.pid!;
    
    // Get current Delphi job ID (from DynamoDB job queue)
    const jobId = await getCurrentDelphiJobId(zid.toString());
    
    // Use UPSERT to handle both new and existing records
    const query = `
      INSERT INTO topic_agenda_selections 
        (zid, pid, archetypal_selections, delphi_job_id, total_selections, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT (zid, pid) 
      DO UPDATE SET 
        archetypal_selections = EXCLUDED.archetypal_selections,
        delphi_job_id = EXCLUDED.delphi_job_id,
        total_selections = EXCLUDED.total_selections,
        updated_at = CURRENT_TIMESTAMP
      RETURNING zid, pid, total_selections
    `;
    
    const result = await pgQuery.queryP(
      query,
      [zid, pid, JSON.stringify(selections), jobId, selections.length]
    );
    
    res.json({
      status: 'success',
      message: 'Topic agenda selections saved successfully',
      data: {
        conversation_id: zid.toString(),
        participant_id: pid.toString(),
        selections_count: result[0]?.total_selections || selections.length,
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
}
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
