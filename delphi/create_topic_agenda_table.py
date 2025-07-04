#!/usr/bin/env python3
"""
Create Topic Agenda DynamoDB table for Delphi system.

This script creates the Delphi_TopicAgendaSelections table for storing user topic selections.

Usage:
    python create_topic_agenda_table.py [options]

Options:
    --endpoint-url ENDPOINT_URL   DynamoDB endpoint URL
    --region REGION               AWS region (default: us-east-1)
    --force                       Force recreate table if it exists
"""

import boto3
import os
import logging
import argparse
import time

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

def create_topic_agenda_table(dynamodb, force_recreate=False):
    """
    Create the Topic Agenda table for storing user selections.
    
    Args:
        dynamodb: boto3 DynamoDB resource
        force_recreate: If True, delete existing table before creating
    """
    table_name = 'Delphi_TopicAgendaSelections'
    
    # Check if table exists
    existing_tables = [t.name for t in dynamodb.tables.all()]
    
    if table_name in existing_tables:
        if force_recreate:
            logger.info(f"Deleting existing table {table_name}...")
            table = dynamodb.Table(table_name)
            table.delete()
            table.meta.client.get_waiter('table_not_exists').wait(TableName=table_name)
            logger.info(f"Table {table_name} deleted.")
        else:
            logger.info(f"Table {table_name} already exists. Use --force to recreate.")
            return False
    
    # Create table
    logger.info(f"Creating table {table_name}...")
    
    table = dynamodb.create_table(
        TableName=table_name,
        KeySchema=[
            {'AttributeName': 'conversation_id', 'KeyType': 'HASH'},
            {'AttributeName': 'participant_id', 'KeyType': 'RANGE'}
        ],
        AttributeDefinitions=[
            {'AttributeName': 'conversation_id', 'AttributeType': 'S'},
            {'AttributeName': 'participant_id', 'AttributeType': 'S'}
        ],
        ProvisionedThroughput={
            'ReadCapacityUnits': 5,
            'WriteCapacityUnits': 5
        }
    )
    
    # Wait for table to be active
    table.meta.client.get_waiter('table_exists').wait(TableName=table_name)
    logger.info(f"Table {table_name} created and active.")
    
    return True

def main():
    # Parse arguments
    parser = argparse.ArgumentParser(description='Create Topic Agenda DynamoDB table')
    parser.add_argument('--endpoint-url', type=str, default=None,
                      help='DynamoDB endpoint URL')
    parser.add_argument('--region', type=str, default='us-east-1',
                      help='AWS region (default: us-east-1)')
    parser.add_argument('--force', action='store_true',
                      help='Force recreate table if it exists')
    args = parser.parse_args()
    
    # Set up environment variables for local DynamoDB
    if args.endpoint_url:
        if 'localhost' in args.endpoint_url or '127.0.0.1' in args.endpoint_url:
            os.environ['AWS_ACCESS_KEY_ID'] = 'dummy'
            os.environ['AWS_SECRET_ACCESS_KEY'] = 'dummy'
    
    # Create DynamoDB resource
    dynamodb = boto3.resource(
        'dynamodb',
        endpoint_url=args.endpoint_url,
        region_name=args.region
    )
    
    # Create table
    start_time = time.time()
    success = create_topic_agenda_table(dynamodb, args.force)
    elapsed_time = time.time() - start_time
    
    if success:
        logger.info(f"Table creation completed in {elapsed_time:.2f} seconds")
    else:
        logger.info(f"Table creation skipped (already exists)")

if __name__ == "__main__":
    main()