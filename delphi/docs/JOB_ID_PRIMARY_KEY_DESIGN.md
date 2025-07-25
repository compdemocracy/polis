# Job ID Primary Key Design Document

## Overview

This document outlines the design for restructuring the Delphi DynamoDB schema to use `job_id` as the primary key for all tables. This approach optimizes for job-based queries, which represent our most common access pattern, while maintaining a clean and simple data model.

## Background

During our previous implementation effort, we learned that most of our DynamoDB queries are scoped by `job_id`. Having `job_id` as a secondary attribute accessed through a Global Secondary Index (GSI) resulted in performance inefficiencies and occasional schema validation errors.

Analysis of our query patterns shows that optimizing for job-based access would provide significant performance improvements and cost savings. This document outlines a fresh approach that makes `job_id` the primary key for all tables.

## Design Goals

1. **Performance Optimization**: Ensure fast, strongly consistent reads for job-based queries
2. **Simplicity**: Maintain a clean data model without complex composite keys
3. **Cost Efficiency**: Minimize DynamoDB read/write costs by optimizing for common access patterns
4. **Consistency**: Establish a uniform approach across all DynamoDB tables
5. **Flexibility**: Allow for future addition of GSIs if query patterns evolve
6. **Job Tree Support**: Maintain hierarchical job relationships (parent-child, root jobs)
7. **Clean Implementation**: Start fresh from edge branch rather than extending the current approach

## Primary Key Design

### Key Structure

For all tables, we will standardize on the following key structure:

```
Primary Key:
- HASH key (Partition key): job_id
- RANGE key (Sort key): original attribute (comment_id, cluster_key, etc. specific to each table)
```

Where:
- `job_id` is a UUID that uniquely identifies a processing job
- Each table uses its own natural identifier as the range key (comment_id, cluster_key, etc.)
- `conversation_id` is stored as a regular attribute, not part of the key

### Table-Specific Key Structures

| Table | Current Primary Key | New Primary Key | Range Key Type |
|-------|---------------------|-----------------|----------------|
| Delphi_CommentEmbeddings | (conversation_id, comment_id) | (job_id, comment_id) | Number |
| Delphi_CommentHierarchicalClusterAssignments | (conversation_id, comment_id) | (job_id, comment_id) | Number |
| Delphi_CommentClustersStructureKeywords | (conversation_id, cluster_key) | (job_id, cluster_key) | String |
| Delphi_UMAPGraph | (conversation_id, edge_id) | (job_id, edge_id) | String |
| Delphi_CommentClustersLLMTopicNames | (conversation_id, topic_key) | (job_id, topic_key) | String |
| Delphi_CommentExtremity | (conversation_id, comment_id) | (job_id, comment_id) | Number |

### Example Item Structure

```json
{
  "job_id": "f84d63ed-3b42-448e-9a1d-3474137f4e80",
  "comment_id": 123,
  "conversation_id": "36324",
  "embedding": { ... },
  "created_at": "2025-07-24T08:30:37.214Z",
  "parent_job_id": "parent-uuid-here",
  "root_job_id": "root-uuid-here",
  "job_stage": "UMAP"
}
```

## Secondary Indexes (Optional)

While not implemented initially, we maintain the flexibility to add these GSIs if needed:

```
Optional GSI (ConversationIndex):
- HASH key: conversation_id
- RANGE key: created_at
```

This GSI would allow efficient querying of all items for a specific conversation, sorted by creation time.

## Data Model Changes

### Pydantic Model Updates

The Pydantic models in `dynamo_models.py` will be updated to reflect the new primary key structure:

```python
class CommentEmbedding(BaseModel):
    """Embedding vector for a comment with UMAP projection coordinates."""
    # Primary key fields
    job_id: str
    comment_id: int
    
    # Regular attributes
    conversation_id: str
    created_at: str = Field(default_factory=lambda: datetime.now().isoformat())
    
    # Job tree fields (optional)
    parent_job_id: Optional[str] = None
    root_job_id: Optional[str] = None
    job_stage: Optional[str] = None
    
    # Entity-specific fields
    embedding: Embedding
    # ... other fields
```

Similar updates will be made for all other models.

### DataConverter Class Updates

The `DataConverter` class methods will be updated to properly construct models with the new key structure:

```python
@staticmethod
def create_comment_embedding(
    conversation_id: str,
    comment_id: int,
    vector: np.ndarray,
    job_id: str,  # Now required
    parent_job_id: Optional[str] = None,
    root_job_id: Optional[str] = None,
    job_stage: Optional[str] = None
) -> CommentEmbedding:
    """Create a CommentEmbedding model from raw data."""
    # Create embedding object
    embedding = Embedding(
        vector=vector.tolist() if isinstance(vector, np.ndarray) else vector,
        dimensions=len(vector),
        model='all-MiniLM-L6-v2'
    )
    
    # Create model data
    model_data = {
        'job_id': job_id,
        'comment_id': int(comment_id),
        'conversation_id': conversation_id,
        'embedding': embedding,
        'created_at': datetime.now().isoformat()
    }
    
    # Add job tree fields if provided
    if parent_job_id:
        model_data['parent_job_id'] = parent_job_id
    if root_job_id:
        model_data['root_job_id'] = root_job_id
    if job_stage:
        model_data['job_stage'] = job_stage
    
    # Create the model
    model = CommentEmbedding(**model_data)
    
    return model
```

## Storage Class Updates

The storage classes that interact with DynamoDB will need to be updated to use the new key structure:

```python
def get_comment_embeddings_by_job(self, job_id):
    """Get all comment embeddings for a specific job."""
    response = self.comment_embeddings_table.query(
        KeyConditionExpression=Key('job_id').eq(job_id)
    )
    return response.get('Items', [])

def get_comment_embedding(self, job_id, comment_id):
    """Get a specific comment embedding."""
    response = self.comment_embeddings_table.get_item(
        Key={
            'job_id': job_id,
            'comment_id': comment_id
        }
    )
    return response.get('Item')
    
def get_comment_embeddings_by_job_and_conversation(self, job_id, conversation_id):
    """Get all comment embeddings for a specific job and conversation."""
    # Since conversation_id is not part of the key, we need to use a filter expression
    response = self.comment_embeddings_table.query(
        KeyConditionExpression=Key('job_id').eq(job_id),
        FilterExpression=Attr('conversation_id').eq(conversation_id)
    )
    return response.get('Items', [])
```

## Query Patterns

### Common Query Patterns

1. **Get all data for a specific job**:
   ```python
   response = table.query(
       KeyConditionExpression=Key('job_id').eq(job_id)
   )
   ```

2. **Get a specific item**:
   ```python
   response = table.get_item(
       Key={
           'job_id': job_id,
           'comment_id': comment_id  # Or cluster_key, edge_id, etc. depending on the table
       }
   )
   ```

3. **Get all data for a specific job and conversation**:
   ```python
   # Using filter expression (less efficient)
   response = table.query(
       KeyConditionExpression=Key('job_id').eq(job_id),
       FilterExpression=Attr('conversation_id').eq(conversation_id)
   )
   ```

4. **Optional - If GSI is added later - Get all data for a specific conversation**:
   ```python
   response = table.query(
       IndexName='ConversationIndex',
       KeyConditionExpression=Key('conversation_id').eq(conversation_id)
   )
   ```

## Implementation Approach

Since we'll be reprocessing all data with the new code rather than migrating existing data, our approach is simplified:

1. **Schema Design and Code Update**:
   - Update all DynamoDB table schemas in `create_dynamodb_tables.py`
   - Update Pydantic models in `dynamo_models.py`
   - Update DataConverter and storage classes to use the new schema

2. **Table Recreation**:
   - Delete existing tables (with --delete-existing flag)
   - Create new tables with the updated schema

3. **Data Reprocessing**:
   - Run full pipeline jobs to reprocess conversations with the new schema
   - No need for data migration since all data will be newly generated

4. **Validation**:
   - Verify that new data is being correctly stored with the new schema
   - Confirm that all queries work as expected

## Implementation Plan

1. **Phase 1: Preparation (Week 1)**
   - Create design document with detailed schema for each table
   - Create a new branch based on `edge`
   - Update Pydantic models in `dynamo_models.py`
   - Update `create_dynamodb_tables.py` to support the new schema

2. **Phase 2: Core System Updates (Week 2)**
   - Update DataConverter class methods to make job_id required
   - Update storage classes to use the new key structure
   - Implement proper job tree support (parent-child relationships)
   - Modify run_pipeline.py, run_delphi.py, and run_delphi.sh to pass job_id properly

3. **Phase 3: Visualization and Report Generation (Week 3)**
   - Update 700_datamapplot_for_layer.py to use job_id directly
   - Update 702_consensus_divisive_datamapplot.py for job_id primary key
   - Update 801_narrative_report_batch.py for job-based data retrieval
   - Ensure visualizations use consistent job_id throughout

4. **Phase 4: API and Web UI Updates (Week 4)**
   - Create job tree management API endpoints
   - Implement job selection UI in the CommentsReport component
   - Create visualization proxy for S3/Minio access
   - Add job management interfaces to the UI

5. **Phase 5: Testing and Deployment (Week 5)**
   - Set up test environment with the new schema
   - Develop end-to-end test script for the full pipeline
   - Deploy to staging environment
   - Create documentation for the new job-based system

## Trade-offs

### Advantages

1. **Simplicity**: Clean data model without complex composite keys
2. **Type Preservation**: Entity IDs maintain their native types (no string conversion)
3. **Direct Access**: Simplified key structure for direct item retrieval
4. **Performance**: Optimized for the most common query pattern (by job_id)

### Disadvantages

1. **Less Efficient Filtering**: Querying by job_id and conversation_id requires a filter expression, which is less efficient than a key condition
2. **Potential GSI Need**: May require adding a GSI later if querying by conversation_id becomes a common pattern
3. **Uniqueness Constraint**: Requires ensuring uniqueness of range key values (comment_id, cluster_key, etc.) within a job (usually guaranteed by the nature of the data)

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Temporary service disruption | Medium | Schedule reprocessing during low-traffic periods, maintain clear communication about the update |
| Performance regression for job+conversation queries | Medium | Monitor query performance, add GSI if needed |
| Code compatibility issues | Medium | Comprehensive testing of all components in isolated environment before deployment |
| Missing data during transition | Low | Ensure full reprocessing of all required conversations before decommissioning old system |

## Lessons Learned from Previous Implementation

During our previous implementation attempt, we encountered several challenges that inform this new design:

1. **Consistency is Critical**: Having different primary key structures across tables created confusion and bugs

2. **DynamoDB Validation Errors**: We encountered "One of the required keys was not given a value" errors when tables had mismatched schemas and model definitions

3. **Job Tree Implementation**: Supporting parent-child relationships between jobs requires specific GSIs and proper data modeling

4. **UI Integration Challenges**: Ensuring job_id is propagated to the UI required proxy mechanisms for accessing S3/Minio visualizations

5. **Required vs. Optional Fields**: Making job_id optional led to inconsistent usage; the new design makes it required

6. **Parameter Passing**: Using environment variables for job_id was problematic due to race conditions; explicit parameter passing is preferred

## Conclusion

Moving to a `job_id`-based primary key structure will optimize our DynamoDB tables for the most common access pattern - querying by job_id. This approach maintains a clean and simple data model without complex composite keys, while still providing the flexibility to add GSIs for other query patterns if needed.

By implementing this design as a fresh start from the edge branch, we can avoid the inconsistencies and technical debt that accumulated in our previous attempt. The standardized approach will make the codebase more maintainable and improve performance for our most common query patterns.