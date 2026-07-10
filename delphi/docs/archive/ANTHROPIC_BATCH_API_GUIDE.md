# Anthropic Batch API Integration Guide

This document provides comprehensive guidance for working with Anthropic's Batch API in the Delphi system, including common issues, debugging tips, and best practices.

## Overview

The Delphi system uses Anthropic's Batch API to efficiently process multiple narrative report requests in parallel. The workflow consists of:

1. **Batch Creation**: `801_narrative_report_batch.py` prepares and submits batch requests to Anthropic's API
2. **Status Monitoring**: `803_check_batch_status.py` checks batch status and processes completed results
3. **Result Storage**: Processed results are stored in DynamoDB's `Delphi_NarrativeReports` table for display in the UI

## Key Components

### Job Flow Architecture

1. A job of type `CREATE_NARRATIVE_BATCH` runs `801_narrative_report_batch.py`
2. This script creates a batch request to Anthropic's API and submits it
3. After successful submission, it creates a new job of type `AWAITING_NARRATIVE_BATCH` with batch information
4. The job poller detects this job and runs `803_check_batch_status.py` to handle batch results when complete
5. Results are stored in DynamoDB with a key format that the server API expects

### Database Schema

#### Jobs Table (Delphi_JobQueue)

- `job_id`: Unique identifier for the job
- `job_type`: Type of job (e.g., `CREATE_NARRATIVE_BATCH`, `AWAITING_NARRATIVE_BATCH`)
- `batch_id`: The Anthropic batch ID (for batch-related jobs)
- `conversation_id`: The Polis conversation ID (zid)
- `report_id`: The report ID used for storing and retrieving results
- `status`: Current job status (PENDING, PROCESSING, COMPLETED, FAILED)

#### Reports Table (Delphi_NarrativeReports)

- `rid_section_model`: Primary key in format `report_id#section_name#model` - **this format is critical**
- `timestamp`: ISO timestamp for when the report was created
- `report_data`: The actual report content (JSON)
- Other metadata fields such as `job_id`, `section`, `model`

## Common Issues and Solutions

### 1. Key Format Mismatch

**Problem**: The server API expects report keys in the format `report_id#section_name#model` with `#` as delimiter, but the batch handler might use a different format.

**Solution**: 
```python
# CORRECT - Use # delimiter
rid_section_model = f"{report_id}#{section_name}#{model}"

# INCORRECT - Don't use _ delimiter
# rid_section_model = f"{report_id}_{section_name}_{model}"  
```

### 2. Handling Anthropic Batch Results

**Problem**: The Anthropic Batch API returns results in JSON Lines (JSONL) format, not as an async iterator.

**Solution**:
```python
# Direct HTTP request approach (recommended)
headers = {
    'x-api-key': self.anthropic.api_key,
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json'
}

response = requests.get(
    f'https://api.anthropic.com/v1/messages/batches/{batch_id}/results?beta=true',
    headers=headers
)
response.raise_for_status()

# Process each line as a separate JSON object
entries = []
for line in response.text.strip().split('\n'):
    if line.strip():
        try:
            entry = json.loads(line)
            entries.append(entry)
        except json.JSONDecodeError as e:
            logger.error(f"Error parsing JSON line: {str(e)}")
```

### 3. Missing custom_id in Responses

**Problem**: Sometimes batch responses may have `custom_id` set to None, causing errors when trying to use it.

**Solution**:
```python
# Extract metadata from custom_id
custom_id = entry.get('request', {}).get('custom_id')
logger.info(f"Processing successful result for custom_id: {custom_id}")

# Handle missing custom_id safely
if custom_id:
    parts = custom_id.split('_')
    
    # Try to determine section name from custom_id
    section_name = None
    if len(parts) > 2:
        # Skip conversation_id and cluster_id
        section_name = '_'.join(parts[2:])
else:
    # If custom_id is None, we need to create a fallback
    parts = []
    section_name = None

# If section_name couldn't be determined, use a default
if not section_name:
    section_name = f"topic_{len(results)}"
```

### 4. Report ID vs Conversation ID Confusion

**Problem**: The report_id (used in database key) may be different from the conversation_id (zid).

**Solution**:
- The server requires that there is an entry in the PostgreSQL `reports` table linking `report_id` to a `zid`
- Always ensure that the `reports` table has an entry for your report before expecting reports to appear in the UI
- When testing, you can query the `reports` table to verify the relationship:

```sql
SELECT report_id, zid FROM reports WHERE zid = '19305';
```

## Debugging Tips

### 1. Inspecting Batch Status Directly

You can directly query the Anthropic API to check batch status:

```python
import os
import json
import requests

# Get Anthropic API key from environment
api_key = os.environ.get('ANTHROPIC_API_KEY')
batch_id = 'msgbatch_YOUR_BATCH_ID'

# Set up headers
headers = {
    'x-api-key': api_key,
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json'
}

# Get batch status
response = requests.get(
    f'https://api.anthropic.com/v1/messages/batches/{batch_id}?beta=true',
    headers=headers
)
response.raise_for_status()
batch_data = response.json()

print(f'Batch ID: {batch_data.get("id")}')
print(f'Status: {batch_data.get("processing_status")}')
print(f'Number of requests: {len(batch_data.get("requests", []))}')
print(f'Created at: {batch_data.get("created_at")}')
```

### 2. Checking for Reports in DynamoDB

Query DynamoDB to verify reports exist with the correct key format:

```python
import boto3, json
dynamodb = boto3.resource('dynamodb', endpoint_url='http://host.docker.internal:8000', region_name='us-west-2')
table = dynamodb.Table('Delphi_NarrativeReports')

# Check for records with a specific prefix
response = table.scan(
    FilterExpression='begins_with(rid_section_model, :prefix)',
    ExpressionAttributeValues={
        ':prefix': 'report_id#'  # Use the correct report_id here
    },
    Limit=5
)

print(f"Found {len(response.get('Items', []))} matching reports")
for item in response.get('Items', []):
    print(f"Report key: {item['rid_section_model']}")
```

### 3. Testing Server API Response

Test the server API endpoint directly:

```bash
curl -s "http://server:5000/api/v3/delphi/reports?report_id=your_report_id"
```

Make sure to use the correct report_id, not just the conversation_id.

## Best Practices

1. **Consistent Key Format**: Always use the `#` delimiter for report keys
2. **Error Handling**: Always handle missing or null values in API responses
3. **Logging**: Implement comprehensive logging for debugging
4. **Verify Database Entries**: Check both PostgreSQL and DynamoDB for expected records
5. **Direct HTTP Approach**: Use the direct HTTP approach for handling Anthropic batch results rather than SDK-specific methods which may change

## Related Documentation

- [Anthropic Batch API Documentation](https://docs.anthropic.com/en/docs/messages-batch-api-reference)
- [DynamoDB Reserved Keywords](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ReservedWords.html) - Remember to use ExpressionAttributeNames for reserved keywords like "status"
- [Polis Database Schema](https://docs.pol.is/env-prep/database)

This guide should help future Claude instances troubleshoot and understand the Anthropic Batch API integration in the Delphi system.