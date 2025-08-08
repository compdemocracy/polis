#!/usr/bin/env python3
"""
Reset/delete all Delphi data for a specific conversation.
This includes DynamoDB tables and MinIO visualization files.

Usage:
    python reset_conversation.py <conversation_id_or_report_id>
    
Example:
    python reset_conversation.py 19548
    python reset_conversation.py r4tykwac8thvzv35jrn53
"""

import sys
import boto3
from boto3.dynamodb.conditions import Key
import subprocess
import os

def get_conversation_id(identifier):
    """Convert report_id to conversation_id if needed."""
    # If it's already a number, assume it's a conversation_id
    if identifier.isdigit():
        return identifier
    
    # If it starts with 'r', it's likely a report_id - need to look it up
    if identifier.startswith('r'):
        # This would require PostgreSQL access
        print(f"Note: Report ID provided ({identifier}). You may need to provide the conversation ID directly.")
        return None
    
    return identifier

def delete_dynamodb_data(conversation_id):
    """Delete all data from DynamoDB tables for a conversation."""
    
    # Setup DynamoDB
    dynamodb = boto3.resource('dynamodb', 
        endpoint_url=os.environ.get('DYNAMODB_ENDPOINT', 'http://dynamodb:8000'),
        region_name='us-east-1',
        aws_access_key_id='dummy',
        aws_secret_access_key='dummy'
    )
    
    deleted_count = {}
    
    # List of all Delphi tables and their key structures
    table_configs = {
        # Single key tables
        'Delphi_PCAConversationConfig': {
            'type': 'single',
            'hash_key': 'zid'
        },
        'Delphi_UMAPConversationConfig': {
            'type': 'single', 
            'hash_key': 'conversation_id'
        },
        
        # Tables with conversation_id as hash key
        'Delphi_CommentEmbeddings': {
            'type': 'query',
            'hash_key': 'conversation_id',
            'range_key': 'comment_id'
        },
        'Delphi_CommentHierarchicalClusterAssignments': {
            'type': 'query',
            'hash_key': 'conversation_id',
            'range_key': 'comment_id'
        },
        'Delphi_CommentClustersStructureKeywords': {
            'type': 'query',
            'hash_key': 'conversation_id',
            'range_key': 'topic_key'
        },
        'Delphi_CommentClustersFeatures': {
            'type': 'query',
            'hash_key': 'conversation_id',
            'range_key': 'topic_key'
        },
        'Delphi_CommentClustersLLMTopicNames': {
            'type': 'query',
            'hash_key': 'conversation_id',
            'range_key': 'topic_key'
        },
        'Delphi_UMAPGraph': {
            'type': 'query',
            'hash_key': 'conversation_id',
            'range_key': 'edge_id'
        },
        'Delphi_CommentExtremity': {
            'type': 'query',
            'hash_key': 'conversation_id',
            'range_key': 'comment_id'
        },
        
        # Tables with composite keys using zid
        'Delphi_CommentRouting': {
            'type': 'scan_prefix',
            'hash_key': 'zid_tick',
            'range_key': 'comment_id',
            'prefix': f'{conversation_id}:'
        },
        'Delphi_PCAResults': {
            'type': 'scan_prefix',
            'hash_key': 'zid',
            'range_key': 'math_tick',
            'prefix': conversation_id
        },
        'Delphi_KMeansClusters': {
            'type': 'scan_prefix',
            'hash_key': 'zid_tick',
            'range_key': 'group_id',
            'prefix': f'{conversation_id}:'
        },
        'Delphi_RepresentativeComments': {
            'type': 'scan_prefix',
            'hash_key': 'zid_tick_gid',
            'range_key': 'comment_id',
            'prefix': f'{conversation_id}:'
        },
        'Delphi_PCAParticipantProjections': {
            'type': 'scan_prefix',
            'hash_key': 'zid_tick',
            'range_key': 'participant_id',
            'prefix': f'{conversation_id}:'
        },
        
        # Special case tables
        'Delphi_NarrativeReports': {
            'type': 'scan_contains',
            'hash_key': 'rid_section_model',
            'range_key': 'timestamp'
        },
        'Delphi_JobQueue': {
            'type': 'scan_job',
            'hash_key': 'job_id'
        }
    }
    
    print(f'\nDeleting DynamoDB data for conversation {conversation_id}...\n')
    
    for table_name, config in table_configs.items():
        try:
            table = dynamodb.Table(table_name)
            count = 0
            
            if config['type'] == 'single':
                # Single item delete
                try:
                    response = table.delete_item(Key={config['hash_key']: conversation_id})
                    count = 1
                except:
                    count = 0
                    
            elif config['type'] == 'query':
                # Query by hash key and delete all items
                response = table.query(
                    KeyConditionExpression=Key(config['hash_key']).eq(conversation_id)
                )
                
                for item in response.get('Items', []):
                    key = {
                        config['hash_key']: conversation_id,
                        config['range_key']: item[config['range_key']]
                    }
                    table.delete_item(Key=key)
                    count += 1
                    
                # Handle pagination
                while 'LastEvaluatedKey' in response:
                    response = table.query(
                        KeyConditionExpression=Key(config['hash_key']).eq(conversation_id),
                        ExclusiveStartKey=response['LastEvaluatedKey']
                    )
                    for item in response.get('Items', []):
                        key = {
                            config['hash_key']: conversation_id,
                            config['range_key']: item[config['range_key']]
                        }
                        table.delete_item(Key=key)
                        count += 1
                        
            elif config['type'] == 'scan_prefix':
                # Scan for items with prefix
                response = table.scan(
                    FilterExpression=f'begins_with({config["hash_key"]}, :prefix)',
                    ExpressionAttributeValues={':prefix': config['prefix']}
                )
                
                for item in response.get('Items', []):
                    key = {
                        config['hash_key']: item[config['hash_key']],
                        config['range_key']: item[config['range_key']]
                    }
                    table.delete_item(Key=key)
                    count += 1
                    
                # Handle pagination
                while 'LastEvaluatedKey' in response:
                    response = table.scan(
                        FilterExpression=f'begins_with({config["hash_key"]}, :prefix)',
                        ExpressionAttributeValues={':prefix': config['prefix']},
                        ExclusiveStartKey=response['LastEvaluatedKey']
                    )
                    for item in response.get('Items', []):
                        key = {
                            config['hash_key']: item[config['hash_key']],
                            config['range_key']: item[config['range_key']]
                        }
                        table.delete_item(Key=key)
                        count += 1
                        
            elif config['type'] == 'scan_contains' and table_name == 'Delphi_NarrativeReports':
                # Special handling for narrative reports - need report_id
                # For now, skip if we don't have report_id
                pass
                
            elif config['type'] == 'scan_job':
                # Scan for jobs containing this conversation_id
                response = table.scan(
                    FilterExpression='contains(job_params, :cid)',
                    ExpressionAttributeValues={':cid': conversation_id}
                )
                
                for item in response.get('Items', []):
                    table.delete_item(Key={config['hash_key']: item[config['hash_key']]})
                    count += 1
            
            if count > 0:
                deleted_count[table_name] = count
                print(f'  ✓ {table_name}: {count} items deleted')
                
        except Exception as e:
            if 'ResourceNotFoundException' not in str(e):
                print(f'  ✗ {table_name}: Error - {str(e)}')
    
    return deleted_count

def delete_minio_data(identifier):
    """Delete visualization files from MinIO."""
    
    # Determine if we have a report_id or need to find it
    if identifier.startswith('r'):
        report_id = identifier
    else:
        print(f"\n⚠️  Note: To delete MinIO visualizations, you need the report_id (starting with 'r')")
        return 0
    
    print(f'\nDeleting MinIO visualization data for report {report_id}...\n')
    
    # Configure AWS CLI for MinIO
    env = os.environ.copy()
    env['AWS_ACCESS_KEY_ID'] = 'minioadmin'
    env['AWS_SECRET_ACCESS_KEY'] = 'minioadmin'
    
    # List files first
    list_cmd = [
        'aws', 's3', 'ls', 
        f's3://polis-delphi/visualizations/{report_id}/',
        '--recursive',
        '--endpoint-url', 'http://localhost:9000'
    ]
    
    try:
        result = subprocess.run(list_cmd, capture_output=True, text=True, env=env)
        if result.returncode == 0 and result.stdout:
            file_count = len(result.stdout.strip().split('\n'))
            print(f'  Found {file_count} visualization files')
            
            # Delete files
            delete_cmd = [
                'aws', 's3', 'rm',
                f's3://polis-delphi/visualizations/{report_id}/',
                '--recursive',
                '--endpoint-url', 'http://localhost:9000'
            ]
            
            result = subprocess.run(delete_cmd, capture_output=True, text=True, env=env)
            if result.returncode == 0:
                print(f'  ✓ Deleted all visualization files for report {report_id}')
                return file_count
            else:
                print(f'  ✗ Error deleting files: {result.stderr}')
                return 0
        else:
            print(f'  No visualization files found for report {report_id}')
            return 0
            
    except Exception as e:
        print(f'  ✗ Error accessing MinIO: {str(e)}')
        return 0

def main():
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(1)
    
    identifier = sys.argv[1]
    
    # Get conversation_id
    conversation_id = get_conversation_id(identifier)
    
    if not conversation_id:
        print("\n❌ Could not determine conversation_id. Please provide the numeric conversation ID.")
        sys.exit(1)
    
    print(f"\n🗑️  Resetting all Delphi data for conversation {conversation_id}")
    print("=" * 60)
    
    # Delete DynamoDB data
    deleted_tables = delete_dynamodb_data(conversation_id)
    
    # Delete MinIO data (if we have a report_id)
    minio_files = delete_minio_data(identifier)
    
    # Summary
    print("\n" + "=" * 60)
    print("✅ Reset complete!\n")
    
    if deleted_tables:
        total_items = sum(deleted_tables.values())
        print(f"DynamoDB: Deleted {total_items} items across {len(deleted_tables)} tables")
    
    if minio_files > 0:
        print(f"MinIO: Deleted {minio_files} visualization files")
    
    print("\nThe conversation is ready for a fresh Delphi run.")

if __name__ == "__main__":
    main()