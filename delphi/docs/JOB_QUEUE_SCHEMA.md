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
## Companion table: `Delphi_JobActiveGuard`

The server's two HTTP producers (`POST /api/v3/delphi/jobs` and
`POST /api/v3/delphi/batchReports`) do not write `Delphi_JobQueue` directly.
They go through the active-work guard added by P-003 S3
(`server/src/routes/delphi/jobGuard.ts`), which creates the queue row and a
guard row in a single `TransactWriteItems`.

### Table design

- **Table name**: `Delphi_JobActiveGuard`
- **Partition key**: `guard_key` (String)
- **Billing**: PAY_PER_REQUEST, no GSIs
- **No TTL attribute** — deliberately. An automatic expiry could release a
  scope while paid provider work is still live.

`guard_key` is a SHA-256 digest with a one-character kind prefix:

| Prefix | Meaning | Digest input |
|---|---|---|
| `s:` | Submission scope | `v2`, `job_type`, `conversation_id`, `report_id` |
| `i:` | Idempotency alias | `v2`, `conversation_id`, `report_id`, client `idempotency_key` |

The scope deliberately excludes `job_config`: at most one root job of a given
type runs per conversation/report, because two configurations still reset and
publish into the same structures. Configuration is recorded as `config_hash`
and is what an idempotency key binds to.

Scope rows carry `job_id`, `version`, `conversation_id`, `report_id`,
`job_type`, `config_hash` and, for an adopted pre-existing root, `adopted_at`.
Alias rows carry `scope_guard_key`, `config_hash`, `job_id`,
`binding_expires_at`, and `conversation_id`/`report_id`/`job_type` so a
conversation's guard rows can be found without a join.

### Lifecycle

1. **Alias check.** When the request carries an idempotency key, the alias is
   read first, on every path. A key bound to a different scope or a different
   `config_hash` is a conflict (HTTP 409) even when the target scope is already
   occupied by someone else's job.
2. **Scope check.** A strongly-consistent read of the scope guard decides
   whether work is outstanding.
3. **Migration check.** With no guard, the server sweeps the base table for
   outstanding work in the scope and adopts its root rather than admitting a
   duplicate beside it. The sweep does not filter on status: a live checker
   under an already-terminal parent, and a root whose terminal write is
   unresolved (FAILED with no confirmed process exit, or
   `checker_schedule_failed`), are both outstanding work that a status filter
   hides. Candidates are classified with the same rule release uses. Rows the sweep
   already shows as cleanly finished — terminal, resolved, no failed checker
   scheduling — are skipped, so a conversation's ordinary history neither costs
   a strong re-read nor fills the 25-candidate budget. Above that budget of
   genuinely ambiguous roots, admission fails closed with 503 and an operator
   has to triage them (see `RESET_SINGLE_CONVERSATION.md`). After writing, it sweeps again: a producer that does not take part
   in the transaction cannot be fenced by a read, so if one raced in, the server
   withdraws its own row while that row is still unclaimed. This narrows the
   window; it does not close it. **Deploy every producer before relying on the
   guard.**
4. **Admission.** One transaction: conditional `Put` of the queue row
   (`attribute_not_exists(job_id)`), conditional `Put` of the scope guard, and
   the alias when supplied. Either both tables are written or neither is.
5. **Key binding.** Every accepted idempotency key is bound to the job the
   caller was actually told about — on creation, on deduplication and on
   adoption alike. A key that is acknowledged without a binding invites a retry
   that starts a second run once the first job finishes.
6. **Release.** A guard is deleted only under an exact `job_id` + `version`
   condition, and only on *proof* that no paid work remains. Four conditions,
   all of them:
   - a strongly-consistent read shows the root `COMPLETED` or `FAILED`;
   - a completed, strongly-consistent **base-table scan** finds no non-terminal
     `batch_job_id` descendant. A GSI query cannot serve here — a global
     secondary index is eventually consistent and does not accept
     `ConsistentRead`, so its silence is not evidence;
   - the terminal write is *resolved*. `job_poller.py` verifies the job's whole
     **process group** is empty on every completion path and records the answer
     as `process_exit_confirmed`. Jobs are started with `start_new_session=True`
     and stopped by signalling their group, because a `FULL_PIPELINE` child is
     `run_delphi.py`, which launches subprocesses of its own; stopping the
     direct child alone left those running, and a parent that exits by itself —
     with any status, including 0 — does not take them with it. An explicit
     `false` means the worker could not confirm, and blocks release whatever the
     status says, success included. An *absent* flag is a migration case, not a
     refusal: accepted on `COMPLETED` (a row written before the flag existed),
     still rejected on `FAILED`, which is where orphans come from. Process exit
     is not provider reconciliation: that is what the descendant sweep and
     `checker_schedule_failed` are for;
   - the root was **already terminal before the descendant sweep began**, and
     had not moved by the time it ended. A strongly-consistent `Scan` is not a
     snapshot: a child written between pages, past a point page one already
     read, is invisible to it. The anchor is what makes the sweep's silence mean
     something — children are only created while the root is non-terminal, so a
     root that was terminal before the first page can have no later ones. The
     conversation-wide reader applies the same rule by sweeping twice and
     reporting live wherever the two reads disagree;
   - the root does not carry `checker_schedule_failed`, which
     `801_narrative_report_batch.py` sets when it submitted a provider batch but
     could not schedule the checker row that would otherwise represent it.

   Any error, page cap, or missing root row keeps the guard.
7. **Alias expiry.** The alias outlives the scope guard for a 24-hour binding
   window **anchored at the moment the binding is written**, not at the job's
   completion: a key first used at T is replayable until T + 24 h. The window is
   evaluated in code; it is not a DynamoDB TTL. An intentional rerun needs a new
   key, or none.

### Operator notes

- Guard rows must never be written into `Delphi_JobQueue`: they carry no
  `status`, so they would appear to the queue observer as missing-status
  anomalies.
- Migrating the queue off DynamoDB moves the guard in the same cutover. A
  Postgres job row with a DynamoDB guard has no transaction across it and is
  forbidden (P-003 rev3, G6).
- **Fail closed.** If the guard table is missing or an existing-work sweep
  cannot be completed, submission returns HTTP 503 with
  `code: "JOB_ADMISSION_UNAVAILABLE"` and writes no job. There is no
  un-deduplicated fallback. `cdk/dynamodb.ts` provisions the table.
- Deleting a conversation's job rows (`RESET_SINGLE_CONVERSATION.md`) leaves the
  guard pointing at a row that no longer exists. That is treated as uncertainty
  and keeps the scope blocked, so the reset must delete the scope's guard rows
  too.

### `SUPERSEDED`

When this server loses a race with a producer outside the guard transaction, it
withdraws the admission it just made: the queue row is **marked**
`status = SUPERSEDED` with `superseded_by`, and its scope guard and idempotency
alias are removed, in one transaction. The row is marked rather than deleted
because its id may already have gone out to a client, and an acknowledged id has
to keep resolving to something real. A superseded row is terminal, is not work,
and `job_poller.py`'s finder never looks for that status, so no worker claims it.

### Effective work state for readers

`GET /api/v3/delphi/visualizations` returns `workLive` per job. It is computed by
`assessConversationLiveness`, one **strongly-consistent base-table sweep** of the
conversation — not from the `ConversationIndex` query that produces the rest of
that response. The distinction matters because clients stop polling on
`workLive === false`: an index that has not caught up with a newly written
checker row would otherwise report its parent as finished, and the client would
believe it. When the sweep cannot be completed, every job is reported live.

This costs one extra consistent scan per visualizations request. The client only
polls while something is outstanding, and the table was measured at 255 rows.
