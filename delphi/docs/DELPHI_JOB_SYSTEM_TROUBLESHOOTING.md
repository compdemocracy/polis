# Delphi Job System Troubleshooting Guide

## 🚨 CRITICAL UI CONSISTENCY ISSUE

**The two report interfaces use different API endpoints:**

- **TopicReport.jsx**: `/api/v3/delphi` (LLM topic names from DynamoDB)
- **CommentsReport.jsx**: `/api/v3/delphi/reports` (narrative reports from NarrativeReports table)

**Result**: TopicReport dropdown always appears if topics exist, but CommentsReport dropdown only appears if narrative reports have been generated. This creates inconsistent UX.

This document provides strategies for diagnosing and resolving common issues in the Delphi job system, based on real-world debugging experiences.

## Job System Architecture

The Delphi job processing system consists of:

1. **Job Queue** - DynamoDB table `Delphi_JobQueue` storing job metadata
2. **Job Poller** - `/scripts/job_poller.py` that monitors the queue and executes jobs
3. **Job Processors** - Script files like `801_narrative_report_batch.py` and `803_check_batch_status.py`
4. **Storage Systems** - DynamoDB tables like `Delphi_NarrativeReports` and PostgreSQL

## Common Issues and Solutions

### 1. Jobs Getting Stuck in PROCESSING State

**Symptoms**:

- Jobs remain in PROCESSING state indefinitely
- Subsequent steps aren't triggered
- No error message in job record

**Causes and Solutions**:

1. **Vague State Management**
   - **Problem**: Using the same status (PROCESSING) for different logical states causes confusion
   - **Solution**: Use explicit job types instead of relying solely on status:

     ```python
     # Instead of:
     job['status'] = 'PROCESSING'

     # Use job types with clearer semantics:
     job['job_type'] = 'CREATE_NARRATIVE_BATCH'
     job['job_type'] = 'AWAITING_NARRATIVE_BATCH'
     ```

2. **DynamoDB Reserved Keywords**
   - **Problem**: 'status' is a reserved keyword in DynamoDB
   - **Solution**: Always use ExpressionAttributeNames when updating status:

     ```python
     table.update_item(
         Key={'job_id': job_id},
         UpdateExpression="SET #s = :status",
         ExpressionAttributeNames={
             '#s': 'status'  # Use ExpressionAttributeNames for 'status'
         },
         ExpressionAttributeValues={
             ':status': 'COMPLETED'
         }
     )
     ```

3. **Script Selection Logic**
   - **Problem**: Job poller might run the wrong script based on ambiguous conditions
   - **Solution**: Use job_type to explicitly determine which script to run:

     ```python
     if job_type == 'CREATE_NARRATIVE_BATCH':
         # Run 801_narrative_report_batch.py
         cmd = ['python', '/app/umap_narrative/801_narrative_report_batch.py', ...]
     elif job_type == 'AWAITING_NARRATIVE_BATCH':
         # Run 803_check_batch_status.py
         cmd = ['python', '/app/umap_narrative/803_check_batch_status.py', ...]
     ```

### 2. DynamoDB Data Retrieval Issues

**Symptoms**:

- Data exists in DynamoDB but API returns empty results
- Browser interface shows no reports

**Causes and Solutions**:

1. **Key Format Mismatch**
   - **Problem**: Database keys aren't formatted as expected by server code
   - **Solution**: Ensure consistent key formatting across the system:

     ```python
     # Server expects this format:
     ":prefix": `${conversation_id}#`

     # Make sure 803_check_batch_status.py uses:
     rid_section_model = f"{report_id}#{section_name}#{model}"
     ```

2. **Report/Conversation Mapping**
   - **Problem**: Missing entry in PostgreSQL `reports` table linking report_id to zid
   - **Solution**: Verify the mapping exists:

     ```sql
     SELECT * FROM reports WHERE report_id = 'your_report_id';
     ```

3. **Scan vs Query**
   - **Problem**: Inefficient or incorrect DynamoDB access patterns
   - **Solution**: Use the appropriate access pattern based on your data structure:

     ```javascript
     // For prefix scanning:
     FilterExpression: "begins_with(rid_section_model, :prefix)",
     ExpressionAttributeValues: {
       ":prefix": `${conversation_id}#`
     }
     ```

### 3. Job Poller Script Selection Issues

**Symptoms**:

- Jobs are picked up but the wrong script runs
- Logs show unexpected script execution
- Jobs fail with "Cannot import module" errors

**Causes and Solutions**:

1. **Ambiguous Script Selection Logic**
   - **Problem**: Job poller selects script based on ambiguous conditions
   - **Solution**: Create explicit mapping between job types and scripts:

     ```python
     SCRIPT_MAPPING = {
         'CREATE_NARRATIVE_BATCH': '/app/umap_narrative/801_narrative_report_batch.py',
         'AWAITING_NARRATIVE_BATCH': '/app/umap_narrative/803_check_batch_status.py',
         'FULL_PIPELINE': '/app/run_delphi.sh'
     }

     cmd = ['python', SCRIPT_MAPPING.get(job_type, DEFAULT_SCRIPT)]
     ```

2. **Missing Job Type**
   - **Problem**: Job record doesn't specify job_type field
   - **Solution**: Always include job_type when creating jobs:

     ```python
     job = {
         'job_id': job_id,
         'status': 'PENDING',
         'job_type': 'CREATE_NARRATIVE_BATCH',  # Always specify
         # other fields...
     }
     ```

### 4. External API Integration Issues

**Symptoms**:

- Jobs fail when interacting with external services like Anthropic
- TypeErrors or unexpected response formats

**Causes and Solutions**:

1. **API Response Format Changes**
   - **Problem**: External API changes its response format
   - **Solution**: Use robust response parsing that handles different formats:

     ```python
     # Don't assume specific object structure:
     try:
         # Try direct API call with robust parsing
         response = requests.get(api_url, headers=headers)
         response.raise_for_status()

         # Process each line separately for JSONL
         for line in response.text.strip().split('\n'):
             if line.strip():
                 try:
                     entry = json.loads(line)
                     process_entry(entry)
                 except json.JSONDecodeError:
                     logger.error(f"Error parsing line: {line}")
     except Exception as e:
         logger.error(f"API error: {str(e)}")
     ```

2. **Missing API Keys**
   - **Problem**: Environment variables not properly passed to containers
   - **Solution**: Verify and explicitly pass environment variables:

     ```python
     # When spawning a process, pass environment variables
     env = os.environ.copy()
     env['ANTHROPIC_API_KEY'] = os.environ.get('ANTHROPIC_API_KEY')
     subprocess.run(cmd, env=env)
     ```

## Debugging Strategies

### 1. Trace Job Execution End-to-End

To debug a complete job flow:

1. Create a test job with unique ID
2. Update job poller to log extensively
3. Add debug logs at entry/exit points of scripts
4. Watch all database entries during execution

Example debug instrumentation:

```python
# Create a test job
job_id = f"test_job_{int(time.time())}_{uuid.uuid4().hex[:8]}"
job = {
    'job_id': job_id,
    'status': 'PENDING',
    'job_type': 'CREATE_NARRATIVE_BATCH',
    # other required fields
}
table.put_item(Item=job)
print(f"Created test job {job_id}")

# Run the job manually and capture all output
cmd = ['/usr/bin/python', script_path, f'--job-id={job_id}', '--log-level=DEBUG']
process = subprocess.run(cmd, capture_output=True, text=True)
print(f"Process exit code: {process.returncode}")
print(f"STDOUT:\n{process.stdout}")
print(f"STDERR:\n{process.stderr}")

# Check the result in the database
result = table.get_item(Key={'job_id': job_id})
print(f"Job status: {result.get('Item', {}).get('status')}")
```

### 2. Direct API Testing

Sometimes it's useful to bypass the job system and test the API directly:

```python
import requests

api_key = os.environ.get('ANTHROPIC_API_KEY')
headers = {
    'x-api-key': api_key,
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json'
}

# Test batch status
response = requests.get(
    f'https://api.anthropic.com/v1/messages/batches/{batch_id}?beta=true',
    headers=headers
)
print(f"Status code: {response.status_code}")
print(f"Response: {response.json()}")

# Test batch results
results_response = requests.get(
    f'https://api.anthropic.com/v1/messages/batches/{batch_id}/results?beta=true',
    headers=headers
)
print(f"Results status code: {results_response.status_code}")
print(f"First 500 chars of results: {results_response.text[:500]}")
```

### 3. Database Verification

Always verify data exists in the correct place with the correct format:

```python
# Check DynamoDB
dynamodb = boto3.resource('dynamodb', endpoint_url='http://host.docker.internal:8000')
report_table = dynamodb.Table('Delphi_NarrativeReports')
job_table = dynamodb.Table('Delphi_JobQueue')

# Check for specific report
response = report_table.scan(
    FilterExpression='begins_with(rid_section_model, :prefix)',
    ExpressionAttributeValues={':prefix': f'{report_id}#'}
)
print(f"Found {len(response.get('Items', []))} reports")

# Check PostgreSQL
import psycopg2
conn = psycopg2.connect(
    host='host.docker.internal',
    port=5432,
    database='polisDB_prod_local_mar14',
    user='postgres'
)
cursor = conn.cursor()
cursor.execute("SELECT zid, topic FROM conversations WHERE zid = %s", [zid])
rows = cursor.fetchall()
print(f"Found {len(rows)} conversations")
```

## Job System Administration

### Reset Stuck Jobs

To reset jobs stuck in PROCESSING state:

```python
import boto3
from datetime import datetime, timedelta

# Connect to DynamoDB
dynamodb = boto3.resource('dynamodb', endpoint_url='http://host.docker.internal:8000')
table = dynamodb.Table('Delphi_JobQueue')

# Find all jobs in PROCESSING state
response = table.scan(
    FilterExpression='#s = :status',
    ExpressionAttributeNames={'#s': 'status'},
    ExpressionAttributeValues={':status': 'PROCESSING'}
)

# Reset stuck jobs (those in PROCESSING for more than 1 hour)
count = 0
one_hour_ago = (datetime.now() - timedelta(hours=1)).isoformat()
for job in response.get('Items', []):
    job_id = job['job_id']
    updated_at = job.get('updated_at', '2000-01-01')
    if updated_at < one_hour_ago:
        table.update_item(
            Key={'job_id': job_id},
            UpdateExpression='SET #s = :status, error_message = :error',
            ExpressionAttributeNames={'#s': 'status'},
            ExpressionAttributeValues={
                ':status': 'FAILED',
                ':error': 'Reset due to being stuck in PROCESSING state'
            }
        )
        count += 1

print(f"Reset {count} stuck jobs")
```

## Related Documentation

- [JOB_QUEUE_SCHEMA.md](JOB_QUEUE_SCHEMA.md) - Details about the job queue schema
- [ANTHROPIC_BATCH_API_GUIDE.md](ANTHROPIC_BATCH_API_GUIDE.md) - Guide for working with Anthropic's Batch API
- [DATABASE_NAMING_PROPOSAL.md](DATABASE_NAMING_PROPOSAL.md) - Information about database naming conventions
