#!/usr/bin/env python3
"""
Reset/delete all Delphi data for a specific conversation.
This script is environment-aware and works for both local (Docker/MinIO) 
and live AWS environments.
"""

import os
import argparse
import logging
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


def delete_dynamodb_data(conversation_id: str, report_id: str = None):
    """
    Deletes all data from DynamoDB tables for a given conversation_id.
    This function handles multiple key structures and uses efficient batch deletion.
    """
    dynamodb = get_boto_resource('dynamodb')
    total_deleted_count = 0

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

    logger.info(f"\nDeleting DynamoDB data for conversation {conversation_id}...")

    single_key_tables = {
        'Delphi_PCAConversationConfig': 'zid',
        'Delphi_UMAPConversationConfig': 'conversation_id',
    }
    for table_name, key_name in single_key_tables.items():
        try:
            table = dynamodb.Table(table_name)
            table.delete_item(Key={key_name: conversation_id})
            logger.info(f"  ✓ {table_name}: 1 item deleted.")
            total_deleted_count += 1
        except Exception as e:
            if 'ResourceNotFoundException' in str(e): continue
            if 'ConditionalCheckFailedException' in str(e): continue # Item didn't exist
            logger.error(f"  ✗ {table_name}: Error - {e}")
    
    query_tables = {
        "Delphi_CommentEmbeddings": ["conversation_id", "comment_id"],
        "Delphi_CommentHierarchicalClusterAssignments": [
            "conversation_id",
            "comment_id",
        ],
        "Delphi_CommentClustersStructureKeywords": ["conversation_id", "cluster_key"],
        "Delphi_CommentClustersFeatures": ["conversation_id", "cluster_key"],
        "Delphi_CommentClustersLLMTopicNames": ["conversation_id", "topic_key"],
        "Delphi_UMAPGraph": ["conversation_id", "edge_id"],
        "Delphi_CommentExtremity": ["conversation_id", "comment_id"],
    }
    for table_name, keys in query_tables.items():
        try:
            table = dynamodb.Table(table_name)
            response = table.query(KeyConditionExpression=Key(keys[0]).eq(conversation_id))
            items = response.get('Items', [])
            while 'LastEvaluatedKey' in response:
                response = table.query(KeyConditionExpression=Key(keys[0]).eq(conversation_id), ExclusiveStartKey=response['LastEvaluatedKey'])
                items.extend(response.get('Items', []))
            total_deleted_count += batch_delete_items(table, items, keys)
        except Exception as e:
            if 'ResourceNotFoundException' in str(e): continue
            logger.error(f"  ✗ {table_name}: Query failed - {e}")

    prefix_scan_tables = {
        'Delphi_CommentRouting': {'keys': ['zid_tick', 'comment_id'], 'prefix': f'{conversation_id}:'},
        'Delphi_PCAResults': {'keys': ['zid', 'math_tick'], 'prefix': conversation_id},
        'Delphi_KMeansClusters': {'keys': ['zid_tick', 'group_id'], 'prefix': f'{conversation_id}:'},
        'Delphi_RepresentativeComments': {'keys': ['zid_tick_gid', 'comment_id'], 'prefix': f'{conversation_id}:'},
        'Delphi_PCAParticipantProjections': {'keys': ['zid_tick', 'participant_id'], 'prefix': f'{conversation_id}:'},
    }
    for table_name, config in prefix_scan_tables.items():
        try:
            table = dynamodb.Table(table_name)
            scan_kwargs = {'FilterExpression': Key(config['keys'][0]).begins_with(config['prefix'])}
            response = table.scan(**scan_kwargs)
            items = response.get('Items', [])
            while 'LastEvaluatedKey' in response:
                scan_kwargs['ExclusiveStartKey'] = response['LastEvaluatedKey']
                response = table.scan(**scan_kwargs)
                items.extend(response.get('Items', []))
            total_deleted_count += batch_delete_items(table, items, config['keys'])
        except Exception as e:
            if 'ResourceNotFoundException' in str(e): continue
            logger.error(f"  ✗ {table_name}: Scan failed - {e}")
            
    if report_id:
        try:
            table = dynamodb.Table('Delphi_NarrativeReports')
            scan_kwargs = {'FilterExpression': Key('rid_section_model').begins_with(report_id)}
            response = table.scan(**scan_kwargs)
            items = response.get('Items', [])
            while 'LastEvaluatedKey' in response:
                scan_kwargs['ExclusiveStartKey'] = response['LastEvaluatedKey']
                response = table.scan(**scan_kwargs)
                items.extend(response.get('Items', []))
            total_deleted_count += batch_delete_items(table, items, ['rid_section_model', 'timestamp'])
        except Exception as e:
            if 'ResourceNotFoundException' not in str(e):
                logger.error(f"  ✗ Delphi_NarrativeReports: Scan failed - {e}")

    try:
        table = dynamodb.Table('Delphi_JobQueue')
        scan_kwargs = {'FilterExpression': Attr('job_params').contains(conversation_id)}
        response = table.scan(**scan_kwargs)
        items = response.get('Items', [])
        while 'LastEvaluatedKey' in response:
            scan_kwargs['ExclusiveStartKey'] = response['LastEvaluatedKey']
            response = table.scan(**scan_kwargs)
            items.extend(response.get('Items', []))
        total_deleted_count += batch_delete_items(table, items, ['job_id'])
    except Exception as e:
        if 'ResourceNotFoundException' not in str(e):
            logger.error(f"  ✗ Delphi_JobQueue: Scan failed - {e}")
    
    # Delete collective statements for this conversation
    try:
        table = dynamodb.Table('Delphi_CollectiveStatement')
        # Scan for items where zid_topic_jobid contains the conversation_id
        scan_kwargs = {'FilterExpression': Key('zid_topic_jobid').begins_with(f'{conversation_id}#')}
        response = table.scan(**scan_kwargs)
        items = response.get('Items', [])
        while 'LastEvaluatedKey' in response:
            scan_kwargs['ExclusiveStartKey'] = response['LastEvaluatedKey']
            response = table.scan(**scan_kwargs)
            items.extend(response.get('Items', []))
        total_deleted_count += batch_delete_items(table, items, ['zid_topic_jobid'])
    except Exception as e:
        if 'ResourceNotFoundException' not in str(e):
            logger.error(f"  ✗ Delphi_CollectiveStatement: Scan failed - {e}")
            
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