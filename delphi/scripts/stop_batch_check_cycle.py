#!/usr/bin/env python3
"""
Stop Batch Check Cycle - Emergency script to break infinite batch checking loops

This script addresses a critical issue where batch check jobs can get stuck in an infinite
loop when checking Anthropic batch API status. This happens when:

1. A batch is submitted to Anthropic's API
2. The batch ID is stored locally but the batch doesn't actually exist on Anthropic's side
   (deleted, wrong account, API issue, etc.)
3. The Anthropic API returns "in_progress" status anyway (possible API bug)
4. The check job exits with status 3 ("check again later")
5. A new check job is created with a new timestamp
6. The cycle repeats indefinitely, creating hundreds of check jobs

The script works by:
1. Finding all jobs related to a batch ID
2. Deleting all batch_check jobs
3. Marking the original batch job as COMPLETED to prevent new checks

TODO/IMPROVEMENTS:
- Add option to check if batch actually exists on Anthropic before deleting
- Add dry-run mode to preview what would be deleted
- Add support for multiple batch IDs at once
- Integrate with the retry logic to add max retry limits
- Add monitoring/alerting when this pattern is detected
- Fix the root cause in 803_check_batch_status.py to handle missing batches properly
- Add exponential backoff to batch checking
- Store batch check attempt count and fail after N attempts
- Add batch expiration timestamps (fail if checking for > 24 hours)

Usage:
    python stop_batch_check_cycle.py <batch_job_id>
    
Example:
    python stop_batch_check_cycle.py batch_report_r4tykwac8thvzv35jrn53_1753593589_c09e1bc8

Author: System Admin Script
Created: 2025-07-27
"""

import sys
import os
import boto3
from datetime import datetime

def get_dynamodb_resource():
    """Get DynamoDB resource with proper configuration."""
    endpoint_url = os.environ.get('DYNAMODB_ENDPOINT', 'http://dynamodb:8000')
    
    # If running outside Docker, use localhost
    if not os.path.exists('/.dockerenv'):
        endpoint_url = 'http://localhost:8000'
    
    return boto3.resource(
        'dynamodb',
        endpoint_url=endpoint_url,
        region_name='us-east-1',
        aws_access_key_id='dummy',
        aws_secret_access_key='dummy'
    )

def stop_batch_check_cycle(batch_job_id, dry_run=False):
    """
    Stop the infinite batch check cycle for a given batch job.
    
    Args:
        batch_job_id: The original batch job ID (e.g., batch_report_r4tykwac8thvzv35jrn53_...)
        dry_run: If True, only show what would be done without making changes
        
    Returns:
        Tuple of (success: bool, message: str, stats: dict)
    """
    dynamodb = get_dynamodb_resource()
    table = dynamodb.Table('Delphi_JobQueue')
    
    stats = {
        'batch_checks_found': 0,
        'batch_checks_deleted': 0,
        'other_jobs_found': 0,
        'other_jobs_deleted': 0,
        'base_job_updated': False,
        'errors': []
    }
    
    print(f"\n{'[DRY RUN] ' if dry_run else ''}Stopping batch check cycle for: {batch_job_id}")
    print("=" * 80)
    
    try:
        # Step 1: Find all related jobs
        print("\n1. Scanning for related jobs...")
        response = table.scan(
            FilterExpression='contains(job_id, :batch_id)',
            ExpressionAttributeValues={':batch_id': batch_job_id}
        )
        
        all_related_jobs = response.get('Items', [])
        
        # Handle pagination
        while 'LastEvaluatedKey' in response:
            response = table.scan(
                FilterExpression='contains(job_id, :batch_id)',
                ExpressionAttributeValues={':batch_id': batch_job_id},
                ExclusiveStartKey=response['LastEvaluatedKey']
            )
            all_related_jobs.extend(response.get('Items', []))
        
        # Categorize jobs
        batch_check_jobs = []
        other_jobs = []
        base_job = None
        
        for job in all_related_jobs:
            job_id = job['job_id']
            if job_id == batch_job_id:
                base_job = job
            elif 'batch_check' in job_id:
                batch_check_jobs.append(job)
                stats['batch_checks_found'] += 1
            else:
                other_jobs.append(job)
                stats['other_jobs_found'] += 1
        
        print(f"   Found {stats['batch_checks_found']} batch_check jobs")
        print(f"   Found {stats['other_jobs_found']} other related jobs")
        print(f"   Base job exists: {'Yes' if base_job else 'No'}")
        
        if not base_job and not batch_check_jobs:
            return False, "No jobs found for this batch ID", stats
        
        # Step 2: Delete batch_check jobs
        if batch_check_jobs:
            print(f"\n2. {'Would delete' if dry_run else 'Deleting'} {len(batch_check_jobs)} batch_check jobs...")
            
            # Show sample of jobs to be deleted
            print("   Sample jobs:")
            for job in batch_check_jobs[:5]:
                print(f"     - {job['job_id']} (status: {job.get('status', 'UNKNOWN')})")
            if len(batch_check_jobs) > 5:
                print(f"     ... and {len(batch_check_jobs) - 5} more")
            
            if not dry_run:
                for job in batch_check_jobs:
                    try:
                        table.delete_item(Key={'job_id': job['job_id']})
                        stats['batch_checks_deleted'] += 1
                    except Exception as e:
                        stats['errors'].append(f"Failed to delete {job['job_id']}: {str(e)}")
                
                print(f"   Deleted {stats['batch_checks_deleted']} batch_check jobs")
        
        # Step 3: Optionally delete other related jobs
        if other_jobs:
            print(f"\n3. Found {len(other_jobs)} other related jobs")
            response = input("   Delete these as well? (y/N): ").strip().lower()
            
            if response == 'y' and not dry_run:
                for job in other_jobs:
                    try:
                        table.delete_item(Key={'job_id': job['job_id']})
                        stats['other_jobs_deleted'] += 1
                    except Exception as e:
                        stats['errors'].append(f"Failed to delete {job['job_id']}: {str(e)}")
                
                print(f"   Deleted {stats['other_jobs_deleted']} other jobs")
        
        # Step 4: Update base job to COMPLETED
        if base_job:
            current_status = base_job.get('status', 'UNKNOWN')
            print(f"\n4. Base job status: {current_status}")
            
            if current_status in ['PENDING', 'PROCESSING', 'FAILED']:
                print(f"   {'Would mark' if dry_run else 'Marking'} base job as COMPLETED to prevent new checks...")
                
                if not dry_run:
                    try:
                        table.update_item(
                            Key={'job_id': batch_job_id},
                            UpdateExpression='SET #s = :status, error_message = :msg, completed_at = :time',
                            ExpressionAttributeNames={'#s': 'status'},
                            ExpressionAttributeValues={
                                ':status': 'COMPLETED',
                                ':msg': f'Manually completed by stop_batch_check_cycle.py at {datetime.utcnow().isoformat()}',
                                ':time': datetime.utcnow().isoformat()
                            }
                        )
                        stats['base_job_updated'] = True
                        print("   Base job marked as COMPLETED")
                    except Exception as e:
                        stats['errors'].append(f"Failed to update base job: {str(e)}")
        
        # Step 5: Summary
        print("\n" + "=" * 80)
        print("SUMMARY:")
        print(f"  Batch check jobs deleted: {stats['batch_checks_deleted']}/{stats['batch_checks_found']}")
        print(f"  Other jobs deleted: {stats['other_jobs_deleted']}/{stats['other_jobs_found']}")
        print(f"  Base job updated: {'Yes' if stats['base_job_updated'] else 'No'}")
        
        if stats['errors']:
            print(f"\n  Errors encountered: {len(stats['errors'])}")
            for error in stats['errors'][:5]:
                print(f"    - {error}")
        
        success = stats['batch_checks_deleted'] == stats['batch_checks_found'] and not stats['errors']
        message = "Successfully stopped batch check cycle" if success else "Partially stopped cycle (see errors)"
        
        return success, message, stats
        
    except Exception as e:
        return False, f"Unexpected error: {str(e)}", stats

def main():
    """Main entry point."""
    if len(sys.argv) < 2:
        print(__doc__)
        print("\nError: No batch job ID provided")
        sys.exit(1)
    
    batch_job_id = sys.argv[1]
    dry_run = '--dry-run' in sys.argv
    
    # Validate job ID format
    if not batch_job_id.startswith('batch_'):
        print(f"Warning: Job ID '{batch_job_id}' doesn't start with 'batch_'. Continue? (y/N): ", end='')
        if input().strip().lower() != 'y':
            sys.exit(1)
    
    # Execute
    success, message, stats = stop_batch_check_cycle(batch_job_id, dry_run)
    
    print(f"\nResult: {message}")
    
    # Suggest follow-up actions
    if success and not dry_run:
        print("\nRecommended follow-up actions:")
        print("1. Check if the Anthropic batch actually exists in your dashboard")
        print("2. If you need to reprocess, create a new batch job with:")
        print(f"   ./delphi submit --report-id={batch_job_id.split('_')[2]}")
        print("3. Monitor for any new batch_check jobs being created")
    
    sys.exit(0 if success else 1)

if __name__ == "__main__":
    main()