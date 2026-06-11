# Delphi Job Queue Schema Design

## Overview

This document defines the schema for the Delphi job queue system. The job queue is implemented as a DynamoDB table and serves as the central coordination mechanism for distributed processing of Polis data. This design has been fully implemented and is operational.

## Table Design

### Table Name
`Delphi_JobQueue`

### Primary Key Structure
- **Partition Key**: `job_id` (String) - Unique identifier for each job (UUID v4)

This design choice enables:
- Persistent job history (jobs are never deleted)
- Easy lookups of specific jobs
- Optimistic locking for safe concurrent operations

### Global Secondary Indexes (GSI)

#### 1. StatusCreatedIndex
- **Partition Key**: `status` (String) - Current job status
- **Sort Key**: `created_at` (String) - ISO 8601 timestamp
- Purpose: Find jobs by status, ordered by creation time (for FIFO processing)

#### 2. ConversationIndex
- **Partition Key**: `conversation_id` (String) - Polis conversation ID
- **Sort Key**: `created_at` (String) - ISO 8601 timestamp
- Purpose: Find all jobs related to a specific conversation, ordered by creation time

#### 3. JobTypeIndex
- **Partition Key**: `job_type` (String) - Type of job
- **Sort Key**: `priority` (Number) - Priority level (higher values = higher priority)
- Purpose: Query jobs by type, ordered by priority

#### 4. WorkerStatusIndex
- **Partition Key**: `worker_id` (String) - ID of the worker processing the job
- **Sort Key**: `status` (String) - Current job status
- Purpose: Find all jobs being processed by a specific worker with their current status

## Attributes

### Core Attributes
| Attribute | Type | Description |
|-----------|------|-------------|
| `job_id` | String | UUID v4 identifier for the job (primary key) |
| `status` | String | Current job status (PENDING, PROCESSING, COMPLETED, FAILED, CANCELLED) |
| `created_at` | String | ISO 8601 timestamp of job creation |
| `updated_at` | String | ISO 8601 timestamp of last update |
| `started_at` | String | ISO 8601 timestamp when job processing began (empty string if not started) |
| `completed_at` | String | ISO 8601 timestamp when job processing completed (empty string if not completed) |
| `worker_id` | String | ID of the worker processing this job (non-empty placeholder if not assigned) |
| `job_type` | String | Type of job (PCA, UMAP, REPORT, FULL_PIPELINE) |
| `priority` | Number | Priority level (0-100, with 100 being highest priority) |
| `conversation_id` | String | Polis conversation ID the job relates to |
| `retry_count` | Number | Number of times this job has been retried |
| `max_retries` | Number | Maximum number of retry attempts allowed |
| `timeout_seconds` | Number | Maximum execution time in seconds |
| `version` | Number | Optimistic locking version number (incremented on each update) |

### Job Configuration

The `job_config` attribute will be a JSON object containing job-specific parameters. Different job types will have different configuration needs. Here are some examples:

#### For PCA Jobs
```json
{
  "max_votes": 1000000,
  "batch_size": 50000,
  "n_components": 2,
  "pca_method": "randomized"
}
```

#### For UMAP Jobs
```json
{
  "n_neighbors": 15,
  "min_dist": 0.1,
  "n_components": 2,
  "metric": "cosine",
  "embedding_model": "all-MiniLM-L6-v2",
  "skip_embedding": false
}
```

#### For Report Generation Jobs
```json
{
  "model": "claude-sonnet-5",
  "include_topics": true,
  "include_consensus": true,
  "include_uncertainty": true,
  "language": "en",
  "max_tokens": 4000
}
```

### Job Results

The `job_results` attribute will be a JSON object containing the outputs and references to outputs of the job. For example:

```json
{
  "result_type": "SUCCESS",
  "output_location": {
    "dynamodb_tables": ["ConversationMeta", "CommentClusters"],
    "s3_artifacts": ["s3://polis-analysis/19305/visualization.html"]
  },
  "summary_metrics": {
    "processing_time_seconds": 142.3,
    "votes_processed": 12500,
    "groups_identified": 3
  }
}
```

### Job Logs

The `logs` attribute will contain the most recent log entries (limited to keep the item size manageable):

```json
{
  "entries": [
    {"timestamp": "2025-04-23T21:34:12Z", "level": "INFO", "message": "Started PCA calculation"},
    {"timestamp": "2025-04-23T21:35:22Z", "level": "INFO", "message": "PCA completed with 2 components"},
    {"timestamp": "2025-04-23T21:35:23Z", "level": "ERROR", "message": "Failed to save results to S3"}
  ],
  "log_location": "s3://polis-logs/jobs/job-123-456.log"
}
```

## Status Lifecycle

Jobs will transition through the following states:

1. **PENDING**: Initial state, job is waiting to be processed
2. **PROCESSING**: Job has been picked up by a worker and is being processed
3. **COMPLETED**: Job has successfully completed
4. **FAILED**: Job has failed after all retry attempts
5. **CANCELLED**: Job was cancelled by an administrator or user

## Locking Mechanism

The job queue uses optimistic locking with a version field to prevent race conditions:

1. Worker queries for PENDING jobs using the StatusCreatedIndex
2. Worker attempts to update job status to PROCESSING with a condition that checks both status and version
3. Version number is incremented with each update
4. If condition fails, another worker has claimed the job or it's been modified

```python
# Claim a job with optimistic locking
try:
    response = table.update_item(
        Key={
            'job_id': job_id
        },
        UpdateExpression='''
            SET #status = :new_status, 
                updated_at = :now, 
                started_at = :now,
                worker_id = :worker_id,
                version = :new_version
        ''',
        ConditionExpression='#status = :old_status AND version = :current_version',
        ExpressionAttributeNames={
            '#status': 'status'
        },
        ExpressionAttributeValues={
            ':old_status': 'PENDING',
            ':new_status': 'PROCESSING',
            ':now': datetime.now().isoformat(),
            ':worker_id': worker_id,
            ':current_version': current_version,
            ':new_version': current_version + 1
        },
        ReturnValues='ALL_NEW'
    )
    # Job successfully claimed
except ClientError as e:
    if e.response['Error']['Code'] == 'ConditionalCheckFailedException':
        # Job was already claimed or modified
        pass
    else:
        # Other error
        raise
```

This approach ensures that jobs are never lost, and multiple workers can safely operate on the job queue concurrently.

## Retention and Cleanup

To manage the growth of the job queue table:

1. **Recently Completed Jobs**: Retain for 7 days for debugging and status checks
2. **Historical Jobs**: After 7 days, summarize key metrics and move to an archive table
3. **Failed Jobs**: Retain for 30 days to allow for investigation

## Example Job Items

### PCA Job
```json
{
  "job_id": "d290f1ee-6c54-4b01-90e6-d701748f0851",
  "status": "PENDING",
  "created_at": "2025-04-23T19:15:00Z",
  "updated_at": "2025-04-23T19:15:00Z",
  "started_at": null,
  "completed_at": null,
  "worker_id": null,
  "job_type": "PCA",
  "priority": 50,
  "conversation_id": "19305",
  "retry_count": 0,
  "max_retries": 3,
  "timeout_seconds": 3600,
  "job_config": {
    "max_votes": 500000,
    "batch_size": 50000,
    "n_components": 2
  },
  "job_results": null,
  "logs": {
    "entries": [],
    "log_location": null
  },
  "created_by": "server-api",
  "dependencies": [],
  "dependent_jobs": []
}
```

### Full Pipeline Job
```json
{
  "job_id": "a1b2c3d4-5e6f-7g8h-9i0j-k1l2m3n4o5p6",
  "status": "PENDING",
  "created_at": "2025-04-23T19:17:00Z",
  "updated_at": "2025-04-23T19:17:00Z",
  "started_at": null,
  "completed_at": null,
  "worker_id": null,
  "job_type": "FULL_PIPELINE",
  "priority": 80,
  "conversation_id": "19305",
  "retry_count": 0,
  "max_retries": 3,
  "timeout_seconds": 7200,
  "job_config": {
    "stages": [
      {
        "stage": "PCA",
        "config": {
          "max_votes": 500000,
          "batch_size": 50000
        }
      },
      {
        "stage": "UMAP",
        "config": {
          "n_neighbors": 15,
          "min_dist": 0.1
        }
      },
      {
        "stage": "REPORT",
        "config": {
          "model": "claude-sonnet-5",
          "include_topics": true
        }
      }
    ],
    "visualizations": ["basic", "enhanced", "multilayer"]
  },
  "job_results": null,
  "logs": {
    "entries": [],
    "log_location": null
  },
  "created_by": "admin-ui",
  "dependencies": [],
  "dependent_jobs": []
}
```

## Implementation Code

> **Caution:** The sample below predates the final schema — the actual table (see `create_dynamodb_tables.py`) uses `job_id` as the sole hash key, not `status`+`created_at`.

Here's a sample Python code for creating the job queue table:

```python
import boto3

def create_job_queue_table(dynamodb=None, table_name='Delphi_JobQueue'):
    if not dynamodb:
        dynamodb = boto3.resource('dynamodb')
        
    table = dynamodb.create_table(
        TableName=table_name,
        KeySchema=[
            {'AttributeName': 'status', 'KeyType': 'HASH'},   # Partition key
            {'AttributeName': 'created_at', 'KeyType': 'RANGE'}  # Sort key
        ],
        AttributeDefinitions=[
            {'AttributeName': 'status', 'AttributeType': 'S'},
            {'AttributeName': 'created_at', 'AttributeType': 'S'},
            {'AttributeName': 'job_id', 'AttributeType': 'S'},
            {'AttributeName': 'conversation_id', 'AttributeType': 'S'},
            {'AttributeName': 'job_type', 'AttributeType': 'S'},
            {'AttributeName': 'priority', 'AttributeType': 'N'},
            {'AttributeName': 'worker_id', 'AttributeType': 'S'},
            {'AttributeName': 'started_at', 'AttributeType': 'S'}
        ],
        GlobalSecondaryIndexes=[
            {
                'IndexName': 'JobIdIndex',
                'KeySchema': [
                    {'AttributeName': 'job_id', 'KeyType': 'HASH'}
                ],
                'Projection': {'ProjectionType': 'ALL'},
                'ProvisionedThroughput': {'ReadCapacityUnits': 5, 'WriteCapacityUnits': 5}
            },
            {
                'IndexName': 'ConversationIndex',
                'KeySchema': [
                    {'AttributeName': 'conversation_id', 'KeyType': 'HASH'},
                    {'AttributeName': 'created_at', 'KeyType': 'RANGE'}
                ],
                'Projection': {'ProjectionType': 'ALL'},
                'ProvisionedThroughput': {'ReadCapacityUnits': 5, 'WriteCapacityUnits': 5}
            },
            {
                'IndexName': 'JobTypeIndex',
                'KeySchema': [
                    {'AttributeName': 'job_type', 'KeyType': 'HASH'},
                    {'AttributeName': 'priority', 'KeyType': 'RANGE'}
                ],
                'Projection': {'ProjectionType': 'ALL'},
                'ProvisionedThroughput': {'ReadCapacityUnits': 5, 'WriteCapacityUnits': 5}
            },
            {
                'IndexName': 'WorkerIndex',
                'KeySchema': [
                    {'AttributeName': 'worker_id', 'KeyType': 'HASH'},
                    {'AttributeName': 'started_at', 'KeyType': 'RANGE'}
                ],
                'Projection': {'ProjectionType': 'ALL'},
                'ProvisionedThroughput': {'ReadCapacityUnits': 5, 'WriteCapacityUnits': 5}
            }
        ],
        ProvisionedThroughput={'ReadCapacityUnits': 10, 'WriteCapacityUnits': 10}
    )
    
    return table
```

## Next Steps

1. Implement the table creation in the `create_dynamodb_tables.py` script
2. Develop job submission API for the server
3. Create the worker poller service that will process jobs
4. Add admin UI components for monitoring and managing the job queue