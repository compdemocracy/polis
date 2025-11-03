#!/usr/bin/env python3
"""
Reset/delete all Delphi data for a specific conversation.
This script is environment-aware and works for both local (Docker/MinIO) 
and live AWS environments.
"""

import os
import argparse
import logging
import time
import boto3
from boto3.dynamodb.conditions import Key, Attr

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

def get_boto_resource(service_name: str):
    """
    Creates a boto3 resource, automatically using the correct endpoint
    and credentials for local vs. AWS environments.
    """
    resource_args = {'region_name': os.environ.get('AWS_REGION', 'us-east-1')}
    endpoint_url = None

    if service_name == 's3':
        endpoint_url = os.environ.get('AWS_S3_ENDPOINT')
    elif service_name == 'dynamodb':
        endpoint_url = os.environ.get('DYNAMODB_ENDPOINT')

    if endpoint_url:
        logger.info(f"Local environment detected. Connecting {service_name} to endpoint: {endpoint_url}")
        resource_args['endpoint_url'] = endpoint_url
        resource_args['aws_access_key_id'] = os.environ.get('AWS_ACCESS_KEY_ID')
        resource_args['aws_secret_access_key'] = os.environ.get('AWS_SECRET_ACCESS_KEY')
    else:
        logger.info(f"AWS environment detected for {service_name}. Using IAM role credentials.")
        
    return boto3.resource(service_name, **resource_args)


def delete_single_item(dynamodb, table_name, key_config):
    """
    Delete a single item from a DynamoDB table.

    Args:
        dynamodb: DynamoDB resource object
        table_name: Name of the table
        key_config: Dict with 'key_name' and 'key_value' for the item to delete

    Returns:
        Number of items deleted (0 or 1)
    """
    try:
        table = dynamodb.Table(table_name)
        table.delete_item(Key={key_config['key_name']: key_config['key_value']})
        logger.info(f"  ✓ {table_name}: 1 item deleted.")
        return 1
    except Exception as e:
        if 'ResourceNotFoundException' in str(e):
            logger.debug(f"  - {table_name}: Table does not exist")
            return 0
        elif 'ConditionalCheckFailedException' in str(e):
            logger.debug(f"  - {table_name}: Item did not exist")
            return 0
        else:
            logger.error(f"  ✗ {table_name}: Error - {e}")
            return 0

def batch_delete_items(table, items, primary_keys):
    """Helper to perform batch deletion and handle errors."""
    if not items:
        return 0
    try:
        with table.batch_writer() as batch:
            for item in items:
                key_to_delete = {pk: item[pk] for pk in primary_keys}
                batch.delete_item(Key=key_to_delete)
        logger.info(f"  ✓ {table.name}: {len(items)} items deleted.")
        return len(items)
    except Exception as e:
        logger.error(f"  ✗ {table.name}: Batch delete failed - {e}")
        return 0


def _fetch_and_delete_items(dynamodb, table_name, key_config, operation_type, operation_kwargs):
    """
    Generic helper to fetch items from DynamoDB and delete them.

    Args:
        dynamodb: DynamoDB resource object
        table_name: Name of the table
        key_config: Dict with 'keys' (list of key names)
        operation_type: 'query' or 'scan'
        operation_kwargs: Kwargs for the query/scan operation

    Returns:
        Number of items deleted
    """
    try:
        # Track timing for the operation
        start_time = time.time()

        operation_name = 'Query' if operation_type == 'query' else 'Scan'

        logger.info(f"Starting {operation_name.lower()} for {table_name}...")

        table = dynamodb.Table(table_name)

        # Get the appropriate operation method
        operation = getattr(table, operation_type)

        # Start fetching items
        fetch_start = time.time()
        items = []
        # Shallow copy to avoid mutating the original during pagination
        local_operation_kwargs = operation_kwargs.copy()
        response = operation(**local_operation_kwargs)
        items.extend(response.get('Items', []))

        # Track pagination
        page_count = 1

        while 'LastEvaluatedKey' in response:
            local_operation_kwargs['ExclusiveStartKey'] = response['LastEvaluatedKey']
            response = operation(**local_operation_kwargs)
            items.extend(response.get('Items', []))
            page_count += 1

        fetch_time = time.time() - fetch_start
        logger.info(f"[{time.time() - start_time:.2f}s] {table_name}: Fetched {len(items)} items across {page_count} pages in {fetch_time:.2f}s")

        # Delete items in batches
        if items:
            delete_start = time.time()
            deleted_count = batch_delete_items(table, items, key_config['keys'])
            delete_time = time.time() - delete_start
            logger.info(f"[{time.time() - start_time:.2f}s] {table_name}: Deletion completed in {delete_time:.2f}s")

            total_time = time.time() - start_time
            logger.info(f"[{time.time() - start_time:.2f}s] {table_name}: Total operation completed in {total_time:.2f}s")

            return deleted_count
        else:
            logger.info(f"[{time.time() - start_time:.2f}s] {table_name}: No items to delete")
            return 0

    except Exception as e:
        if 'ResourceNotFoundException' in str(e):
            logger.debug(f"  - {table_name}: Table does not exist")
            return 0
        else:
            operation_name = 'Query' if operation_type == 'query' else 'Scan'
            logger.error(f"  ✗ {table_name}: {operation_name} failed - {e}")
            return 0


def query_and_delete(dynamodb, table_name, key_config):
    """
    Query a DynamoDB table using a partition key and delete matching items.

    Args:
        dynamodb: DynamoDB resource object
        table_name: Name of the table to query
        key_config: Dict with 'keys' (list of key names) and 'partition_value'

    Returns:
        Number of items deleted
    """
    operation_kwargs = {
        'KeyConditionExpression': Key(key_config['keys'][0]).eq(key_config['partition_value'])
    }
    return _fetch_and_delete_items(dynamodb, table_name, key_config, 'query', operation_kwargs)


def scan_and_delete_with_prefix(dynamodb, table_name, key_config):
    """
    Scan a DynamoDB table for items matching a prefix and delete them.

    Args:
        dynamodb: DynamoDB resource object
        table_name: Name of the table to scan
        key_config: Dict with 'keys' (list of key names) and 'prefix' (prefix to match)

    Returns:
        Number of items deleted
    """
    operation_kwargs = {
        'FilterExpression': Key(key_config['keys'][0]).begins_with(key_config['prefix'])
    }
    return _fetch_and_delete_items(dynamodb, table_name, key_config, 'scan', operation_kwargs)


def scan_and_delete_with_attribute(dynamodb, table_name, key_config):
    """
    Scan a DynamoDB table for items where an attribute contains a value and delete them.

    Args:
        dynamodb: DynamoDB resource object
        table_name: Name of the table to scan
        key_config: Dict with 'keys' (list of key names), 'attribute' name, and 'contains_value'

    Returns:
        Number of items deleted
    """
    operation_kwargs = {
        'FilterExpression': Attr(key_config['attribute']).contains(key_config['contains_value'])
    }
    return _fetch_and_delete_items(dynamodb, table_name, key_config, 'scan', operation_kwargs)



def delete_dynamodb_data(conversation_id: str, report_id: str = None):
    """
    Deletes all data from DynamoDB tables for a given conversation_id.
    This function handles multiple key structures and uses efficient batch deletion.
    """
    dynamodb = get_boto_resource('dynamodb')
    total_deleted_count = 0

    logger.info(f"\nDeleting DynamoDB data for conversation {conversation_id}...")

    # Single-item tables (direct delete by primary key)
    single_key_tables = {
        'Delphi_PCAConversationConfig': {
            'key_name': 'zid',
            'key_value': conversation_id
        },
        'Delphi_UMAPConversationConfig': {
            'key_name': 'conversation_id',
            'key_value': conversation_id
        },
    }

    # Process single-item deletions
    for table_name, config in single_key_tables.items():
        deleted_count = delete_single_item(dynamodb, table_name, config)
        total_deleted_count += deleted_count

    # Query-based tables (efficient query by partition key)
    query_tables = {
        'Delphi_CommentEmbeddings': {
            'keys': ['conversation_id', 'comment_id'],
            'partition_value': conversation_id
        },
        'Delphi_CommentHierarchicalClusterAssignments': {
            'keys': ['conversation_id', 'comment_id'],
            'partition_value': conversation_id
        },
        'Delphi_CommentClustersStructureKeywords': {
            'keys': ['conversation_id', 'cluster_key'],
            'partition_value': conversation_id
        },
        'Delphi_CommentClustersFeatures': {
            'keys': ['conversation_id', 'cluster_key'],
            'partition_value': conversation_id
        },
        'Delphi_CommentClustersLLMTopicNames': {
            'keys': ['conversation_id', 'topic_key'],
            'partition_value': conversation_id
        },
        'Delphi_UMAPGraph': {
            'keys': ['conversation_id', 'edge_id'],
            'partition_value': conversation_id
        },
        'Delphi_CommentExtremity': {
            'keys': ['conversation_id', 'comment_id'],
            'partition_value': conversation_id
        },
    }

    # Process query-based deletions
    for table_name, config in query_tables.items():
        logger.info(f"Processing table {table_name}...")
        deleted_count = query_and_delete(dynamodb, table_name, config)
        total_deleted_count += deleted_count

    # Prefix-scan tables (scan with prefix filter)
    prefix_scan_tables = {
        'Delphi_CommentRouting': {
            'keys': ['zid_tick', 'comment_id'],
            'prefix': f'{conversation_id}:'
        },
        'Delphi_PCAResults': {
            'keys': ['zid', 'math_tick'],
            'prefix': conversation_id
        },
        'Delphi_KMeansClusters': {
            'keys': ['zid_tick', 'group_id'],
            'prefix': f'{conversation_id}:'
        },
        'Delphi_RepresentativeComments': {
            'keys': ['zid_tick_gid', 'comment_id'],
            'prefix': f'{conversation_id}:'
        },
        'Delphi_PCAParticipantProjections': {
            'keys': ['zid_tick', 'participant_id'],
            'prefix': f'{conversation_id}:'
        },
        'Delphi_CollectiveStatement': {
            'keys': ['zid_topic_jobid'],
            'prefix': f'{conversation_id}#'
        },
    }

    if report_id:
        prefix_scan_tables['Delphi_NarrativeReports'] = {
            'keys': ['rid_section_model', 'timestamp'],
            'prefix': report_id
        }

    # Process prefix-scan deletions
    for table_name, config in prefix_scan_tables.items():
        deleted_count = scan_and_delete_with_prefix(dynamodb, table_name, config)
        total_deleted_count += deleted_count


    # Attribute-contains tables (scan with attribute filter)
    attribute_scan_tables = {
        'Delphi_JobQueue': {
            'keys': ['job_id'],
            'attribute': 'job_params',
            'contains_value': conversation_id
        },
    }

    # Process attribute-contains scan deletions
    for table_name, config in attribute_scan_tables.items():
        deleted_count = scan_and_delete_with_attribute(dynamodb, table_name, config)
        total_deleted_count += deleted_count

    return total_deleted_count

def delete_s3_data(bucket_name: str, report_id: str):
    """
    Deletes all visualization files from S3/MinIO for a given report_id.
    """
    if not report_id:
        logger.info("\nNo report_id (--rid) provided. Skipping S3/MinIO cleanup.")
        return 0

    s3 = get_boto_resource('s3')
    bucket = s3.Bucket(bucket_name)
    prefix = f'visualizations/{report_id}/'
    
    logger.info(f"\nDeleting S3/MinIO data for report {report_id} from bucket '{bucket_name}'...")
    logger.info(f"  - Looking for objects with prefix: {prefix}")
    
    try:
        objects_to_delete = [{'Key': obj.key} for obj in bucket.objects.filter(Prefix=prefix)]
        
        if not objects_to_delete:
            logger.info("  No visualization files found to delete.")
            return 0
            
        logger.info(f"  Found {len(objects_to_delete)} files to delete.")
        response = bucket.delete_objects(Delete={'Objects': objects_to_delete})
        deleted_count = len(response.get('Deleted', []))
        
        if errors := response.get('Errors', []):
            logger.error(f"  ✗ Encountered {len(errors)} errors during S3 deletion.")
            for error in errors: logger.error(f"    - Key: {error['Key']}, Code: {error['Code']}")
        if deleted_count > 0:
            logger.info(f"  ✓ Successfully deleted {deleted_count} files.")
            
        return deleted_count

    except Exception as e:
        logger.error(f"  ✗ An error occurred accessing S3/MinIO: {e}")
        return 0

def main(zid: str, rid: str = None):
    """
    Main function to coordinate the deletion process.
    """
    zid_str = str(zid)
    logger.info(f"\n🗑️  Starting reset for conversation zid='{zid_str}'" + (f" and report rid='{rid}'" if rid else ""))
    print("=" * 60)
    
    dynamo_deleted_count = delete_dynamodb_data(zid_str, rid)
    
    s3_bucket = os.environ.get("AWS_S3_BUCKET_NAME", "polis-delphi")
    s3_deleted_count = delete_s3_data(s3_bucket, rid)
    
    print("=" * 60)
    logger.info("✅ Reset complete!\n")
    logger.info(f"DynamoDB: Deleted a total of {dynamo_deleted_count} items across all tables.")
    logger.info(f"S3/MinIO: Deleted a total of {s3_deleted_count} visualization files.")
    
    logger.info("\nThe conversation is ready for a fresh Delphi run.")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Reset Delphi data for a conversation.")
    parser.add_argument(
        '--zid', 
        type=int, 
        required=True,
        help="The numeric conversation ID (e.g., 19548). Used for all DynamoDB and S3 cleanup."
    )
    parser.add_argument(
        '--rid', 
        type=str, 
        required=False,
        help="The report ID (e.g., r4tykwac8thvzv35jrn53). Only needed for cleaning the Delphi_NarrativeReports table."
    )
    
    args = parser.parse_args()
    
    main(zid=args.zid, rid=args.rid)