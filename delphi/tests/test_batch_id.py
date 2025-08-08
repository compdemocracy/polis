#!/usr/bin/env python3
"""
Test script to debug the batch_id storage and retrieval issue.
This script:
1. Creates a job with a known batch_id
2. Verifies it can be retrieved
"""

import boto3
import uuid
import json
import time
from datetime import datetime

# Set up DynamoDB
dynamodb = boto3.resource(
    'dynamodb',
    endpoint_url='http://localhost:8000',
    region_name='us-west-2',
    aws_access_key_id='fakeMyKeyId',
    aws_secret_access_key='fakeSecretAccessKey'
)

# Job queue table
job_table = dynamodb.Table('Delphi_JobQueue')

# Generate a job ID
job_id = f"test_batch_job_{int(time.time())}_{uuid.uuid4().hex[:8]}"
print(f"Creating test job with ID: {job_id}")

# Create a job with a fake batch ID
fake_batch_id = "msgbatch_01HkcTjaV5uDC8jWR4ZsDV8d"  # From Anthropic docs
current_time = datetime.now().isoformat()

job_item = {
    'job_id': job_id,
    'conversation_id': '19305',
    'status': 'PROCESSING',
    'job_type': 'NARRATIVE_BATCH',
    'created_at': current_time,
    'updated_at': current_time,
    'batch_id': fake_batch_id,  # This is the key field we're testing
    'batch_status': 'processing',
    'priority': 10,
    'version': 1,
    'logs': json.dumps({'entries': []})
}

# Store the job
response = job_table.put_item(Item=job_item)
print(f"Job created with response: {response}")

# Wait briefly
time.sleep(1)

# Retrieve the job to verify the batch_id is stored correctly
get_response = job_table.get_item(Key={'job_id': job_id})
if 'Item' in get_response:
    job = get_response['Item']
    print(f"Retrieved job fields: {list(job.keys())}")
    if 'batch_id' in job:
        print(f"VERIFICATION SUCCESS: batch_id is present: {job['batch_id']}")
    else:
        print(f"VERIFICATION FAILED: batch_id not found in job!")
else:
    print(f"ERROR: Could not retrieve job!")

# Test the query that the poller uses to find jobs with batch_id
print("\nTesting poller's scan for finding batch jobs...")
scan_response = job_table.scan(
    FilterExpression='attribute_exists(batch_id) AND (attribute_not_exists(status) OR status <> :completed_status)',
    ExpressionAttributeValues={':completed_status': 'COMPLETED'}
)

items = scan_response.get('Items', [])
found = False
for item in items:
    if item.get('job_id') == job_id:
        found = True
        print(f"SCAN SUCCESS: Job found by scan with batch_id!")
        print(f"Fields present: {list(item.keys())}")
        break

if not found:
    print(f"SCAN FAILED: Job not found by scan looking for batch_id attribute!")
    
    # Try a simpler scan to see if the job exists
    simple_scan = job_table.scan(
        FilterExpression='job_id = :job_id',
        ExpressionAttributeValues={':job_id': job_id}
    )
    
    if simple_scan.get('Items'):
        print(f"Job exists but not matched by batch_id attribute scan")
    else:
        print(f"Job not found at all in simple scan")