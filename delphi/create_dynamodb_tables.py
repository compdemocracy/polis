#!/usr/bin/env python3
"""
Create all DynamoDB tables for Delphi system.

This script creates all necessary DynamoDB tables for both the Polis math system
and the EVōC (Efficient Visualization of Clusters) pipeline.

Usage:
    python create_dynamodb_tables.py [options]

Options:
    --endpoint-url ENDPOINT_URL   DynamoDB endpoint URL
    --region REGION               AWS region (default: us-east-1)
    --delete-existing             Delete existing tables before creating new ones
    --evoc-only                   Create only EVōC tables
    --polismath-only              Create only Polis math tables
    --aws-profile PROFILE         AWS profile to use (optional)
"""

import boto3
import os
import logging
import argparse
import time

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

def create_polis_math_tables(dynamodb, delete_existing=False):
    """
    Create all tables for the Polis math system.
    
    Args:
        dynamodb: boto3 DynamoDB resource
        delete_existing: If True, delete existing tables before creating new ones
    """
    # Get list of existing tables
    existing_tables = [t.name for t in dynamodb.tables.all()]
    
    # Define table schemas for Polis math
    tables = {
        # Main conversation metadata table
        'Delphi_PCAConversationConfig': {
            'KeySchema': [
                {'AttributeName': 'zid', 'KeyType': 'HASH'}
            ],
            'AttributeDefinitions': [
                {'AttributeName': 'zid', 'AttributeType': 'S'}
            ],
            'ProvisionedThroughput': {
                'ReadCapacityUnits': 5,
                'WriteCapacityUnits': 5
            }
        },
        # PCA and cluster data
        'Delphi_PCAResults': {
            'KeySchema': [
                {'AttributeName': 'zid', 'KeyType': 'HASH'},
                {'AttributeName': 'math_tick', 'KeyType': 'RANGE'}
            ],
            'AttributeDefinitions': [
                {'AttributeName': 'zid', 'AttributeType': 'S'},
                {'AttributeName': 'math_tick', 'AttributeType': 'N'}
            ],
            'ProvisionedThroughput': {
                'ReadCapacityUnits': 5,
                'WriteCapacityUnits': 5
            }
        },
        # Group data
        'Delphi_KMeansClusters': {
            'KeySchema': [
                {'AttributeName': 'zid_tick', 'KeyType': 'HASH'},
                {'AttributeName': 'group_id', 'KeyType': 'RANGE'}
            ],
            'AttributeDefinitions': [
                {'AttributeName': 'zid_tick', 'AttributeType': 'S'},
                {'AttributeName': 'group_id', 'AttributeType': 'N'}
            ],
            'ProvisionedThroughput': {
                'ReadCapacityUnits': 5,
                'WriteCapacityUnits': 5
            }
        },
        # Comment data with priorities
        'Delphi_CommentRouting': {
            'KeySchema': [
                {'AttributeName': 'zid_tick', 'KeyType': 'HASH'},
                {'AttributeName': 'comment_id', 'KeyType': 'RANGE'}
            ],
            'AttributeDefinitions': [
                {'AttributeName': 'zid_tick', 'AttributeType': 'S'},
                {'AttributeName': 'comment_id', 'AttributeType': 'S'},
                {'AttributeName': 'zid', 'AttributeType': 'S'}
            ],
            'ProvisionedThroughput': {
                'ReadCapacityUnits': 5,
                'WriteCapacityUnits': 5
            },
            'GlobalSecondaryIndexes': [
                {
                    'IndexName': 'zid-index',
                    'KeySchema': [
                        {'AttributeName': 'zid', 'KeyType': 'HASH'}
                    ],
                    'Projection': { 'ProjectionType': 'ALL' },
                    'ProvisionedThroughput': {
                        'ReadCapacityUnits': 5,
                        'WriteCapacityUnits': 5
                    }
                }
            ]
        },
        # Representativeness data
        'Delphi_RepresentativeComments': {
            'KeySchema': [
                {'AttributeName': 'zid_tick_gid', 'KeyType': 'HASH'},
                {'AttributeName': 'comment_id', 'KeyType': 'RANGE'}
            ],
            'AttributeDefinitions': [
                {'AttributeName': 'zid_tick_gid', 'AttributeType': 'S'},
                {'AttributeName': 'comment_id', 'AttributeType': 'S'}
            ],
            'ProvisionedThroughput': {
                'ReadCapacityUnits': 5,
                'WriteCapacityUnits': 5
            }
        },
        # Participant projection data
        'Delphi_PCAParticipantProjections': {
            'KeySchema': [
                {'AttributeName': 'zid_tick', 'KeyType': 'HASH'},
                {'AttributeName': 'participant_id', 'KeyType': 'RANGE'}
            ],
            'AttributeDefinitions': [
                {'AttributeName': 'zid_tick', 'AttributeType': 'S'},
                {'AttributeName': 'participant_id', 'AttributeType': 'S'}
            ],
            'ProvisionedThroughput': {
                'ReadCapacityUnits': 5,
                'WriteCapacityUnits': 5
            }
        }
    }
    
    # Handle table deletion if requested
    if delete_existing:
        _delete_tables(dynamodb, tables.keys(), existing_tables)
        # Update list of existing tables
        existing_tables = [t.name for t in dynamodb.tables.all()]
    
    # Create tables
    created_tables = _create_tables(dynamodb, tables, existing_tables)
    
    return created_tables

def create_job_queue_table(dynamodb, delete_existing=False):
    """
    Create the job queue table for the Delphi distributed processing system.
    
    Args:
        dynamodb: boto3 DynamoDB resource
        delete_existing: If True, delete existing tables before creating new ones
    """
    # Get list of existing tables
    existing_tables = [t.name for t in dynamodb.tables.all()]
    
    # Define table schema for job queue - Redesigned with job_id as partition key
    tables = {
        'Delphi_JobQueue': {
            'KeySchema': [
                {'AttributeName': 'job_id', 'KeyType': 'HASH'}   # Partition key
            ],
            'AttributeDefinitions': [
                {'AttributeName': 'job_id', 'AttributeType': 'S'},
                {'AttributeName': 'status', 'AttributeType': 'S'},
                {'AttributeName': 'created_at', 'AttributeType': 'S'},
                {'AttributeName': 'conversation_id', 'AttributeType': 'S'},
                {'AttributeName': 'job_type', 'AttributeType': 'S'},
                {'AttributeName': 'priority', 'AttributeType': 'N'},
                {'AttributeName': 'worker_id', 'AttributeType': 'S'}
            ],
            'BillingMode': 'PAY_PER_REQUEST',

            'GlobalSecondaryIndexes': [
                {
                    'IndexName': 'StatusCreatedIndex',
                    'KeySchema': [
                        {'AttributeName': 'status', 'KeyType': 'HASH'},
                        {'AttributeName': 'created_at', 'KeyType': 'RANGE'}
                    ],
                    'Projection': {'ProjectionType': 'ALL'},
                },
                {
                    'IndexName': 'ConversationIndex',
                    'KeySchema': [
                        {'AttributeName': 'conversation_id', 'KeyType': 'HASH'},
                        {'AttributeName': 'created_at', 'KeyType': 'RANGE'}
                    ],
                    'Projection': {'ProjectionType': 'ALL'},
                },
                {
                    'IndexName': 'JobTypeIndex',
                    'KeySchema': [
                        {'AttributeName': 'job_type', 'KeyType': 'HASH'},
                        {'AttributeName': 'priority', 'KeyType': 'RANGE'}
                    ],
                    'Projection': {'ProjectionType': 'ALL'},
                },
                {
                    'IndexName': 'WorkerStatusIndex',
                    'KeySchema': [
                        {'AttributeName': 'worker_id', 'KeyType': 'HASH'},
                        {'AttributeName': 'status', 'KeyType': 'RANGE'}
                    ],
                    'Projection': {'ProjectionType': 'ALL'},
                }
            ],
        }
    }
    
    # Handle table deletion if requested
    if delete_existing:
        _delete_tables(dynamodb, tables.keys(), existing_tables)
        # Update list of existing tables
        existing_tables = [t.name for t in dynamodb.tables.all()]
    
    # Create tables
    created_tables = _create_tables(dynamodb, tables, existing_tables)
    
    return created_tables

def create_evoc_tables(dynamodb, delete_existing=False):
    """
    Create all tables for the EVōC (Efficient Visualization of Clusters) pipeline.
    
    Args:
        dynamodb: boto3 DynamoDB resource
        delete_existing: If True, delete existing tables before creating new ones
    """
    # Get list of existing tables
    existing_tables = [t.name for t in dynamodb.tables.all()]
    
    # Define table schemas for EVōC
    tables = {
        # Comment extremity table
        'Delphi_CommentExtremity': {
            'KeySchema': [
                {'AttributeName': 'conversation_id', 'KeyType': 'HASH'},
                {'AttributeName': 'comment_id', 'KeyType': 'RANGE'}
            ],
            'AttributeDefinitions': [
                {'AttributeName': 'conversation_id', 'AttributeType': 'S'},
                {'AttributeName': 'comment_id', 'AttributeType': 'S'},
                {'AttributeName': 'calculation_method', 'AttributeType': 'S'}
            ],
            'GlobalSecondaryIndexes': [
                {
                    'IndexName': 'ByMethod',
                    'KeySchema': [
                        {'AttributeName': 'calculation_method', 'KeyType': 'HASH'},
                        {'AttributeName': 'conversation_id', 'KeyType': 'RANGE'}
                    ],
                    'Projection': {'ProjectionType': 'ALL'},
                },
                {
                    'IndexName': 'zid-index',
                    'KeySchema': [
                        {'AttributeName': 'conversation_id', 'KeyType': 'HASH'}
                    ],
                    'Projection': {
                        'ProjectionType': 'ALL'
                    },
                }
            ],
            'BillingMode': 'PAY_PER_REQUEST'
        },
        'Delphi_NarrativeReports': {
            'KeySchema': [
                {'AttributeName': 'rid_section_model', 'KeyType': 'HASH'},
                {'AttributeName': 'timestamp', 'KeyType': 'RANGE'}
            ],
            'AttributeDefinitions': [
                {'AttributeName': 'rid_section_model', 'AttributeType': 'S'},
                {'AttributeName': 'timestamp', 'AttributeType': 'S'},
                {'AttributeName': 'report_id', 'AttributeType': 'S'}
            ],
            'BillingMode': 'PAY_PER_REQUEST',
            'GlobalSecondaryIndexes': [
                {
                    'IndexName': 'ReportIdTimestampIndex',
                    'KeySchema': [
                        {'AttributeName': 'report_id', 'KeyType': 'HASH'},
                        {'AttributeName': 'timestamp', 'KeyType': 'RANGE'}
                    ],
                    'Projection': {
                        'ProjectionType': 'ALL'
                    }
                }
            ]
        },
        # Core tables
        'Delphi_UMAPConversationConfig': {
            'KeySchema': [
                {'AttributeName': 'conversation_id', 'KeyType': 'HASH'}
            ],
            'AttributeDefinitions': [
                {'AttributeName': 'conversation_id', 'AttributeType': 'S'}
            ],
            'BillingMode': 'PAY_PER_REQUEST'
        },
        'Delphi_CommentEmbeddings': {
            'KeySchema': [
                {'AttributeName': 'conversation_id', 'KeyType': 'HASH'},
                {'AttributeName': 'comment_id', 'KeyType': 'RANGE'}
            ],
            'AttributeDefinitions': [
                {'AttributeName': 'conversation_id', 'AttributeType': 'S'},
                {'AttributeName': 'comment_id', 'AttributeType': 'N'}
            ],
            'BillingMode': 'PAY_PER_REQUEST'
        },
        'Delphi_CommentHierarchicalClusterAssignments': {
            'KeySchema': [
                {'AttributeName': 'conversation_id', 'KeyType': 'HASH'},
                {'AttributeName': 'comment_id', 'KeyType': 'RANGE'}
            ],
            'AttributeDefinitions': [
                {'AttributeName': 'conversation_id', 'AttributeType': 'S'},
                {'AttributeName': 'comment_id', 'AttributeType': 'N'}
            ],
            'BillingMode': 'PAY_PER_REQUEST'
        },
        'Delphi_CommentClustersStructureKeywords': {
            'KeySchema': [
                {'AttributeName': 'conversation_id', 'KeyType': 'HASH'},
                {'AttributeName': 'cluster_key', 'KeyType': 'RANGE'}
            ],
            'AttributeDefinitions': [
                {'AttributeName': 'conversation_id', 'AttributeType': 'S'},
                {'AttributeName': 'cluster_key', 'AttributeType': 'S'}
            ],
            'BillingMode': 'PAY_PER_REQUEST'
        },
        'Delphi_UMAPGraph': {
            'KeySchema': [
                {'AttributeName': 'conversation_id', 'KeyType': 'HASH'},
                {'AttributeName': 'edge_id', 'KeyType': 'RANGE'}
            ],
            'AttributeDefinitions': [
                {'AttributeName': 'conversation_id', 'AttributeType': 'S'},
                {'AttributeName': 'edge_id', 'AttributeType': 'S'}
            ],
            'BillingMode': 'PAY_PER_REQUEST'
        },
        
        # Extended tables
        'Delphi_CommentClustersFeatures': {
            'KeySchema': [
                {'AttributeName': 'conversation_id', 'KeyType': 'HASH'},
                {'AttributeName': 'cluster_key', 'KeyType': 'RANGE'}
            ],
            'AttributeDefinitions': [
                {'AttributeName': 'conversation_id', 'AttributeType': 'S'},
                {'AttributeName': 'cluster_key', 'AttributeType': 'S'}
            ],
            'BillingMode': 'PAY_PER_REQUEST'
        },
        'Delphi_CommentClustersLLMTopicNames': {
            'KeySchema': [
                {'AttributeName': 'conversation_id', 'KeyType': 'HASH'},
                {'AttributeName': 'topic_key', 'KeyType': 'RANGE'}
            ],
            'AttributeDefinitions': [
                {'AttributeName': 'conversation_id', 'AttributeType': 'S'},
                {'AttributeName': 'topic_key', 'AttributeType': 'S'}
            ],
            'BillingMode': 'PAY_PER_REQUEST'
        },
        # Topic Agenda table for storing user selections
        'Delphi_TopicAgendaSelections': {
            'KeySchema': [
                {'AttributeName': 'conversation_id', 'KeyType': 'HASH'},
                {'AttributeName': 'participant_id', 'KeyType': 'RANGE'}
            ],
            'AttributeDefinitions': [
                {'AttributeName': 'conversation_id', 'AttributeType': 'S'},
                {'AttributeName': 'participant_id', 'AttributeType': 'S'}
            ],
            'BillingMode': 'PAY_PER_REQUEST'
        },
        # Collective Statement table for storing AI-generated group statements
        'Delphi_CollectiveStatement': {
            'KeySchema': [
                {'AttributeName': 'zid_topic_jobid', 'KeyType': 'HASH'}
            ],
            'AttributeDefinitions': [
                {'AttributeName': 'zid_topic_jobid', 'AttributeType': 'S'},
                {'AttributeName': 'zid', 'AttributeType': 'S'},
                {'AttributeName': 'created_at', 'AttributeType': 'S'}
            ],
            'GlobalSecondaryIndexes': [
                {
                    'IndexName': 'zid-created_at-index',
                    'KeySchema': [
                        {'AttributeName': 'zid', 'KeyType': 'HASH'},
                        {'AttributeName': 'created_at', 'KeyType': 'RANGE'}
                    ],
                    'Projection': {
                        'ProjectionType': 'ALL'
                    }
                }
            ],
            'BillingMode': 'PAY_PER_REQUEST'
        }
    }
    
    # Handle table deletion if requested
    if delete_existing:
        _delete_tables(dynamodb, tables.keys(), existing_tables)
        # Update list of existing tables
        existing_tables = [t.name for t in dynamodb.tables.all()]
    
    # Create tables
    created_tables = _create_tables(dynamodb, tables, existing_tables)
    
    return created_tables

def _delete_tables(dynamodb, table_names, existing_tables):
    """Helper function to delete tables."""
    for table_name in table_names:
        if table_name in existing_tables:
            try:
                table = dynamodb.Table(table_name)
                table.delete()
                logger.info(f"Deleted table {table_name}")
                # Wait for table to be deleted
                table.meta.client.get_waiter('table_not_exists').wait(TableName=table_name)
            except Exception as e:
                logger.error(f"Error deleting table {table_name}: {str(e)}")

def _create_tables(dynamodb, tables, existing_tables):
    """Helper function to create tables."""
    created_tables = []
    
    for table_name, table_schema in tables.items():
        if table_name in existing_tables:
            logger.info(f"Table {table_name} already exists, skipping creation")
            continue
        
        try:
            # Ensure all GSI key attributes are in AttributeDefinitions
            # This is good practice though boto3 might infer sometimes
            if 'GlobalSecondaryIndexes' in table_schema:
                for gsi in table_schema['GlobalSecondaryIndexes']:
                    for key_element in gsi['KeySchema']:
                        attr_name = key_element['AttributeName']
                        # Check if this attr_name is already defined
                        is_defined = False
                        for ad in table_schema['AttributeDefinitions']:
                            if ad['AttributeName'] == attr_name:
                                is_defined = True
                                break
                        if not is_defined:
                            # This part is a bit tricky as we need to know the type.
                            # For this specific GSI, we know 'report_id' is 'S'.
                            # A more robust solution would require type info alongside GSI def.
                            # For now, relying on explicit definition as done above.
                            logger.warning(f"Attribute {attr_name} for GSI in {table_name} was not in AttributeDefinitions. Ensure it's added if not inferred.")


            table = dynamodb.create_table(
                TableName=table_name,
                **table_schema
            )
            logger.info(f"Created table {table_name}")
            created_tables.append(table_name)
            table.meta.client.get_waiter('table_exists').wait(TableName=table_name)
            logger.info(f"Table {table_name} is active.")

        except Exception as e:
            logger.error(f"Error creating table {table_name}: {str(e)}")
    
    return created_tables

def create_tables(endpoint_url=None, region_name='us-east-1', 
                 delete_existing=False, evoc_only=False, polismath_only=False,
                 aws_profile=None):
    # Use the environment variable if endpoint_url is not provided
    if endpoint_url is None:
        endpoint_url = os.environ.get('DYNAMODB_ENDPOINT')
    
    logger.info(f"Creating tables with DynamoDB endpoint: {endpoint_url}")
    """
    Create all necessary DynamoDB tables for both systems.
    
    Args:
        endpoint_url: URL of the DynamoDB endpoint (local or AWS)
        region_name: AWS region name
        delete_existing: If True, delete existing tables before creating new ones
        evoc_only: If True, create only EVōC tables
        polismath_only: If True, create only Polis math tables
        aws_profile: AWS profile to use (optional)
    """
    # Set up environment variables for credentials if not already set (for local development)
    if not os.environ.get('AWS_ACCESS_KEY_ID') and endpoint_url and ('localhost' in endpoint_url or 'host.docker.internal' in endpoint_url or 'polis-dynamodb-local' in endpoint_url):
        os.environ['AWS_ACCESS_KEY_ID'] = 'fakeMyKeyId'
    
    if not os.environ.get('AWS_SECRET_ACCESS_KEY') and endpoint_url and ('localhost' in endpoint_url or 'host.docker.internal' in endpoint_url or 'polis-dynamodb-local' in endpoint_url):
        os.environ['AWS_SECRET_ACCESS_KEY'] = 'fakeSecretAccessKey'
    
    # Create DynamoDB session and resource
    session_args = {'region_name': region_name}
    if aws_profile:
        session_args['profile_name'] = aws_profile
    
    session = boto3.Session(**session_args)
    
    dynamodb_args = {}
    if endpoint_url:
        dynamodb_args['endpoint_url'] = endpoint_url
    
    dynamodb = session.resource('dynamodb', **dynamodb_args)
    
    # Get list of existing tables before any operations
    existing_tables = [t.name for t in dynamodb.tables.all()]
    logger.info(f"Existing tables before operations: {existing_tables}")
    
    created_tables = []
    
    # Always create the job queue table
    logger.info("Creating job queue table...")
    job_queue_tables = create_job_queue_table(dynamodb, delete_existing)
    created_tables.extend(job_queue_tables)
    
    # Create tables based on flags
    if not polismath_only:
        logger.info("Creating EVōC tables...")
        evoc_tables = create_evoc_tables(dynamodb, delete_existing)
        created_tables.extend(evoc_tables)
    
    if not evoc_only:
        logger.info("Creating Polis math tables...")
        polismath_tables = create_polis_math_tables(dynamodb, delete_existing)
        created_tables.extend(polismath_tables)
    
    # Check that requested tables were created
    if created_tables:
        logger.info(f"Created {len(created_tables)} new tables: {created_tables}")
    else:
        logger.info("No new tables were created")
    
    # Final list of all tables
    updated_tables = [t.name for t in dynamodb.tables.all()]
    logger.info(f"All tables after creation: {updated_tables}")
    
    return created_tables

def main():
    # Parse arguments
    parser = argparse.ArgumentParser(description='Create DynamoDB tables for Delphi system')
    parser.add_argument('--endpoint-url', type=str, default=None,
                      help='DynamoDB endpoint URL (default: use DYNAMODB_ENDPOINT env var)')
    parser.add_argument('--region', type=str, default='us-east-1',
                      help='AWS region (default: us-east-1)')
    parser.add_argument('--delete-existing', action='store_true',
                      help='Delete existing tables before creating new ones')
    parser.add_argument('--evoc-only', action='store_true',
                      help='Create only EVōC tables')
    parser.add_argument('--polismath-only', action='store_true',
                      help='Create only Polis math tables')
    parser.add_argument('--aws-profile', type=str,
                      help='AWS profile to use (optional)')
    args = parser.parse_args()
    
    # Create tables
    start_time = time.time()
    create_tables(
        endpoint_url=args.endpoint_url,
        region_name=args.region,
        delete_existing=args.delete_existing,
        evoc_only=args.evoc_only,
        polismath_only=args.polismath_only,
        aws_profile=args.aws_profile
    )
    elapsed_time = time.time() - start_time
    logger.info(f"Table creation completed in {elapsed_time:.2f} seconds")

if __name__ == "__main__":
    main()