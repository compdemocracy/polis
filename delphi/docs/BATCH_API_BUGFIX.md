# Batch API Processing Bug Fix

## Issue

We identified a critical issue in the job processing system that causes the wrong script to be executed for NARRATIVE_BATCH jobs. The problem is in `job_poller.py` where it determines which script to run:

```python
if job_type == 'NARRATIVE_BATCH':
    # Check if this job is in a PROCESSING state (with or without batch_id)
    if job.get('status') == 'PROCESSING':
        # Run 803_check_batch_status.py (batch status checker)
    else:
        # Run 801_narrative_report_batch.py (batch creator)
```

The issue is that by the time this check happens, all jobs have already been moved to 'PROCESSING' state by the job poller (in the `claim_job` method). This means that all NARRATIVE_BATCH jobs will always run the batch status checker script (803) instead of the batch creation script (801) on their first run.

This creates an infinite loop where:
1. A new NARRATIVE_BATCH job is created with status PENDING
2. The job poller changes it to PROCESSING and then checks the status
3. The poller sees job_type='NARRATIVE_BATCH' and status='PROCESSING' and runs 803_check_batch_status.py
4. 803_check_batch_status.py finds no batch_id and should mark it as FAILED but fails to do so
5. The job remains in PROCESSING state and the cycle repeats

## Solution

Change the logic to use the presence of a `batch_id` field rather than the job status to determine which script to run:

```python
if job_type == 'NARRATIVE_BATCH':
    # Check if this job already has a batch_id
    if 'batch_id' in job:
        # Run 803_check_batch_status.py (batch status checker)
    else:
        # Run 801_narrative_report_batch.py (batch creator)
```

This way, new jobs (which don't have a batch_id) will run 801 first to create the batch, and jobs that already have a batch_id will run 803 to check the status.

## Implementation

1. A patch file has been created with the fix (`job_poller_fix.patch`)
2. All in-progress NARRATIVE_BATCH jobs should be reset to FAILED state
3. After deploying the fix, submit a new NARRATIVE_BATCH job to verify it works correctly

## Additional Improvements

1. Fix the DynamoDB "status" reserved keyword issue in all scripts
2. Improve the job state machine to have more explicit states
3. Add better error handling to prevent infinite loops