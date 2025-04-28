#!/usr/bin/env python3
"""
Create DynamoDB tables for EVōC (Efficient Visualization of Clusters).

This script creates all necessary DynamoDB tables for the EVōC pipeline:
- Core tables: ConversationMeta, CommentEmbeddings, CommentClusters, ClusterTopics, UMAPGraph
- Extended tables: ClusterCharacteristics, LLMTopicNames

Usage:
    python create_dynamodb_tables.py [--endpoint-url ENDPOINT_URL]

Args:
    --endpoint-url: DynamoDB endpoint URL (default: http://localhost:8000)
"""

import boto3
import os
import logging
import argparse

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

def create_tables(endpoint_url=None, delete_existing=False):
    # Use the environment variable if endpoint_url is not provided
    if endpoint_url is None:
        endpoint_url = os.environ.get('DYNAMODB_ENDPOINT', 'http://localhost:8000')
    
    logger.info(f"Creating tables with DynamoDB endpoint: {endpoint_url}")
    """
    Create all necessary DynamoDB tables for the EVōC pipeline.
    
    Args:
        endpoint_url: URL of the DynamoDB endpoint (local or AWS)
        delete_existing: If True, delete existing tables before creating new ones
    """
    # Set up environment variables for credentials if not already set
    if not os.environ.get('AWS_ACCESS_KEY_ID'):
        os.environ['AWS_ACCESS_KEY_ID'] = 'fakeMyKeyId'
    
    if not os.environ.get('AWS_SECRET_ACCESS_KEY'):
        os.environ['AWS_SECRET_ACCESS_KEY'] = 'fakeSecretAccessKey'
    
    # Create DynamoDB client
    dynamodb = boto3.resource('dynamodb', 
                             endpoint_url=endpoint_url, 
                             region_name='us-west-2')
    
    # Get list of existing tables
    existing_tables = [t.name for t in dynamodb.tables.all()]
    logger.info(f"Existing tables: {existing_tables}")
    
    # Delete existing tables if requested
    if delete_existing:
        for table_name in existing_tables:
            try:
                table = dynamodb.Table(table_name)
                table.delete()
                logger.info(f"Deleted table {table_name}")
                # Wait for table to be deleted
                table.meta.client.get_waiter('table_not_exists').wait(TableName=table_name)
            except Exception as e:
                logger.error(f"Error deleting table {table_name}: {str(e)}")
        
        # Update list of existing tables after deletion
        existing_tables = [t.name for t in dynamodb.tables.all()]
        logger.info(f"Tables after deletion: {existing_tables}")
    
    # Define table schemas
    tables = {
        # Report table
        'report_narrative_store': {
            'KeySchema': [
                {'AttributeName': 'rid_section_model', 'KeyType': 'HASH'},
                {'AttributeName': 'timestamp', 'KeyType': 'RANGE'}
            ],
            'AttributeDefinitions': [
                {'AttributeName': 'rid_section_model', 'AttributeType': 'S'},
                {'AttributeName': 'timestamp', 'AttributeType': 'S'}
            ],
            'ProvisionedThroughput': {
                'ReadCapacityUnits': 5,
                'WriteCapacityUnits': 5
            }
        },
        # Core tables
        'ConversationMeta': {
            'KeySchema': [
                {'AttributeName': 'conversation_id', 'KeyType': 'HASH'}
            ],
            'AttributeDefinitions': [
                {'AttributeName': 'conversation_id', 'AttributeType': 'S'}
            ],
            'ProvisionedThroughput': {
                'ReadCapacityUnits': 5,
                'WriteCapacityUnits': 5
            }
        },
        'CommentEmbeddings': {
            'KeySchema': [
                {'AttributeName': 'conversation_id', 'KeyType': 'HASH'},
                {'AttributeName': 'comment_id', 'KeyType': 'RANGE'}
            ],
            'AttributeDefinitions': [
                {'AttributeName': 'conversation_id', 'AttributeType': 'S'},
                {'AttributeName': 'comment_id', 'AttributeType': 'N'}
            ],
            'ProvisionedThroughput': {
                'ReadCapacityUnits': 5,
                'WriteCapacityUnits': 5
            }
        },
        'CommentClusters': {
            'KeySchema': [
                {'AttributeName': 'conversation_id', 'KeyType': 'HASH'},
                {'AttributeName': 'comment_id', 'KeyType': 'RANGE'}
            ],
            'AttributeDefinitions': [
                {'AttributeName': 'conversation_id', 'AttributeType': 'S'},
                {'AttributeName': 'comment_id', 'AttributeType': 'N'}
            ],
            'ProvisionedThroughput': {
                'ReadCapacityUnits': 5,
                'WriteCapacityUnits': 5
            }
        },
        'ClusterTopics': {
            'KeySchema': [
                {'AttributeName': 'conversation_id', 'KeyType': 'HASH'},
                {'AttributeName': 'cluster_key', 'KeyType': 'RANGE'}
            ],
            'AttributeDefinitions': [
                {'AttributeName': 'conversation_id', 'AttributeType': 'S'},
                {'AttributeName': 'cluster_key', 'AttributeType': 'S'}
            ],
            'ProvisionedThroughput': {
                'ReadCapacityUnits': 5,
                'WriteCapacityUnits': 5
            }
        },
        'UMAPGraph': {
            'KeySchema': [
                {'AttributeName': 'conversation_id', 'KeyType': 'HASH'},
                {'AttributeName': 'edge_id', 'KeyType': 'RANGE'}
            ],
            'AttributeDefinitions': [
                {'AttributeName': 'conversation_id', 'AttributeType': 'S'},
                {'AttributeName': 'edge_id', 'AttributeType': 'S'}
            ],
            'ProvisionedThroughput': {
                'ReadCapacityUnits': 5,
                'WriteCapacityUnits': 5
            }
        },
        
        # Extended tables
        'ClusterCharacteristics': {
            'KeySchema': [
                {'AttributeName': 'conversation_id', 'KeyType': 'HASH'},
                {'AttributeName': 'cluster_key', 'KeyType': 'RANGE'}
            ],
            'AttributeDefinitions': [
                {'AttributeName': 'conversation_id', 'AttributeType': 'S'},
                {'AttributeName': 'cluster_key', 'AttributeType': 'S'}
            ],
            'ProvisionedThroughput': {
                'ReadCapacityUnits': 5,
                'WriteCapacityUnits': 5
            }
        },
        'LLMTopicNames': {
            'KeySchema': [
                {'AttributeName': 'conversation_id', 'KeyType': 'HASH'},
                {'AttributeName': 'topic_key', 'KeyType': 'RANGE'}
            ],
            'AttributeDefinitions': [
                {'AttributeName': 'conversation_id', 'AttributeType': 'S'},
                {'AttributeName': 'topic_key', 'AttributeType': 'S'}
            ],
            'ProvisionedThroughput': {
                'ReadCapacityUnits': 5,
                'WriteCapacityUnits': 5
            }
        }
    }
    
    # Create tables if they don't exist
    for table_name, table_schema in tables.items():
        if table_name in existing_tables:
            logger.info(f"Table {table_name} already exists, skipping creation")
            continue
        
        try:
            table = dynamodb.create_table(
                TableName=table_name,
                **table_schema
            )
            logger.info(f"Created table {table_name}")
        except Exception as e:
            logger.error(f"Error creating table {table_name}: {str(e)}")
    
    # Check that all tables were created
    updated_tables = [t.name for t in dynamodb.tables.all()]
    logger.info(f"Tables after creation: {updated_tables}")
    
    missing_tables = set(tables.keys()) - set(updated_tables)
    if missing_tables:
        logger.warning(f"Some tables could not be created: {missing_tables}")
    else:
        logger.info("All tables successfully created!")

def main():
    # Parse arguments
    parser = argparse.ArgumentParser(description='Create DynamoDB tables for EVōC')
    parser.add_argument('--endpoint-url', type=str, default='http://localhost:8000',
                      help='DynamoDB endpoint URL (default: http://localhost:8000)')
    parser.add_argument('--delete-existing', action='store_true',
                      help='Delete existing tables before creating new ones')
    args = parser.parse_args()
    
    # Create tables
    create_tables(endpoint_url=args.endpoint_url, delete_existing=args.delete_existing)

if __name__ == "__main__":
    main()