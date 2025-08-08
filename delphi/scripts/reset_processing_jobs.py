#!/usr/bin/env python3
"""
Reset all PROCESSING jobs to FAILED in DynamoDB.
This script is useful for cleaning up after testing.
"""

import boto3
import json
from datetime import datetime

# Set up DynamoDB client
dynamodb = boto3.resource(
    'dynamodb',
    endpoint_url='http://host.docker.internal:8000',  # For Docker environment
    region_name='us-west-2',
    aws_access_key_id='fakeMyKeyId',
    aws_secret_access_key='fakeSecretAccessKey'
)

# Get the job queue table
job_table = dynamodb.Table('Delphi_JobQueue')

# Query for PROCESSING jobs
print("Querying for PROCESSING jobs...")
try:
    # Use StatusCreatedIndex to find PROCESSING jobs
    response = job_table.query(
        IndexName='StatusCreatedIndex',
        KeyConditionExpression="#s = :status",
        ExpressionAttributeNames={
            "#s": "status"
        },
        ExpressionAttributeValues={
            ":status": "PROCESSING"
        }
    )
    
    processing_jobs = response.get('Items', [])
    print(f"Found {len(processing_jobs)} PROCESSING jobs")
    
    # Handle pagination
    while 'LastEvaluatedKey' in response:
        response = job_table.query(
            IndexName='StatusCreatedIndex',
            KeyConditionExpression="#s = :status",
            ExpressionAttributeNames={
                "#s": "status"
            },
            ExpressionAttributeValues={
                ":status": "PROCESSING"
            },
            ExclusiveStartKey=response['LastEvaluatedKey']
        )
        processing_jobs.extend(response.get('Items', []))
        print(f"Now have {len(processing_jobs)} PROCESSING jobs")
    
    # Update each job to FAILED
    for job in processing_jobs:
        job_id = job.get('job_id')
        print(f"Resetting job {job_id} from PROCESSING to FAILED...")
        
        # Update job status
        try:
            update_response = job_table.update_item(
                Key={'job_id': job_id},
                UpdateExpression="SET #s = :status, error_message = :error, completed_at = :now",
                ExpressionAttributeNames={
                    "#s": "status"  # Use ExpressionAttributeNames to avoid 'status' reserved keyword
                },
                ExpressionAttributeValues={
                    ':status': 'FAILED',
                    ':error': 'Reset by admin script',
                    ':now': datetime.now().isoformat()
                },
                ReturnValues="UPDATED_NEW"
            )
            print(f"  Job {job_id} updated to FAILED: {update_response.get('Attributes', {})}")
        except Exception as e:
            print(f"  Error updating job {job_id}: {str(e)}")
    
    print(f"Successfully reset {len(processing_jobs)} jobs to FAILED")
    
except Exception as e:
    print(f"Error: {str(e)}")