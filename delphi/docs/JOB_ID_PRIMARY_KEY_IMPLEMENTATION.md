# Job ID Primary Key Implementation

This document describes the implementation of the job_id primary key schema for DynamoDB tables in the Delphi analytics pipeline.

## Overview

The Delphi analytics pipeline has been updated to use job_id as the primary hash key for all DynamoDB tables. This optimizes for job-based queries which are the most common access pattern while maintaining the ability to query by conversation_id through Global Secondary Indexes (GSIs).

## Key Design Principles

1. All tables use job_id as the primary hash key (partition key)
2. Each table uses its own natural identifier as the range key (comment_id, cluster_key, etc.)
3. All tables have a ConversationIdIndex GSI for querying by conversation_id
4. The job_id is generated at the start of each pipeline run and passed through the entire pipeline

## Implementation Steps

1. Updated all model classes in `dynamo_models.py` to use job_id as primary key and specific attribute names as range keys
2. Updated the table creation script in `create_dynamodb_tables.py` to use the new schema
3. Updated the converter methods in `converter.py` to require job_id parameter
4. Modified `run_pipeline.py` to pass job_id to all converter methods

## Table Schema Changes

| Table Name | Old Schema | New Schema |
|------------|------------|------------|
| Delphi_UMAPConversationConfig | Hash: conversation_id | Hash: job_id, Range: conversation_id |
| Delphi_CommentEmbeddings | Hash: conversation_id, Range: comment_id | Hash: job_id, Range: comment_id |
| Delphi_CommentHierarchicalClusterAssignments | Hash: conversation_id, Range: comment_id | Hash: job_id, Range: comment_id |
| Delphi_CommentClustersStructureKeywords | Hash: conversation_id, Range: cluster_key | Hash: job_id, Range: cluster_key |
| Delphi_UMAPGraph | Hash: conversation_id, Range: edge_id | Hash: job_id, Range: edge_id |
| Delphi_CommentClustersFeatures | Hash: conversation_id, Range: cluster_key | Hash: job_id, Range: cluster_key |
| Delphi_CommentClustersLLMTopicNames | Hash: conversation_id, Range: topic_key | Hash: job_id, Range: topic_key |

## Job ID Generation and Propagation

The job_id is generated in `run_pipeline.py` at the start of processing:

```python
# Generate a job_id for this pipeline run
job_id = os.environ.get("DELPHI_JOB_ID", f"pipeline_run_{uuid.uuid4()}")
logger.info(f"Using job_id: {job_id} for this pipeline run.")
```

For jobs started via the job poller (`job_poller.py`), the job_id is passed as an environment variable:

```python
env = os.environ.copy()
env['DELPHI_JOB_ID'] = job_id
env['DELPHI_REPORT_ID'] = str(job.get('report_id', conversation_id))
```

## Global Secondary Indexes

Each table has a ConversationIdIndex GSI with the following structure:

```
IndexName: 'ConversationIdIndex',
KeySchema: [
    {'AttributeName': 'conversation_id', 'KeyType': 'HASH'},
    {'AttributeName': '<table-specific-range-key>', 'KeyType': 'RANGE'}
]
```

This allows querying data by conversation_id when job_id is not known.

## Query Patterns

### Primary Access Pattern (by job_id)

```python
# Query by job_id (hash key)
response = table.query(
    KeyConditionExpression=Key('job_id').eq(job_id)
)

# Query by job_id and range key for specific item
response = table.get_item(
    Key={
        'job_id': job_id,
        'comment_id': comment_id  # or cluster_key, edge_id, etc.
    }
)
```

### Secondary Access Pattern (by conversation_id)

```python
# Query by conversation_id using GSI
response = table.query(
    IndexName='ConversationIdIndex',
    KeyConditionExpression=Key('conversation_id').eq(conversation_id)
)
```

## System Recreation Instructions

If you need to recreate the tables with the new schema:

1. Delete the existing tables (optional if you want to start fresh):
   ```bash
   docker exec polis-dev-delphi-1 python3 -c "
   import boto3
   client = boto3.client('dynamodb', endpoint_url='http://dynamodb:8000', region_name='us-east-1')
   tables = client.list_tables()['TableNames']
   for table in tables:
       if table.startswith('Delphi_'):
           print(f'Deleting {table}...')
           client.delete_table(TableName=table)
   "
   ```

2. Create the new tables with the job_id primary key schema:
   ```bash
   docker exec polis-dev-delphi-1 python /app/create_dynamodb_tables.py
   ```

3. Ensure the pipeline code passes job_id to all converter methods in `run_pipeline.py`.

## Troubleshooting

If you encounter "job_id parameter is required" errors, verify that job_id is being passed to the following methods in `run_pipeline.py`:

1. `DataConverter.create_conversation_meta`
2. `DataConverter.batch_convert_embeddings`
3. `DataConverter.batch_convert_umap_edges`
4. `DataConverter.batch_convert_clusters`
5. `DataConverter.batch_convert_topics`
6. `DataConverter.batch_convert_cluster_characteristics`
7. `DataConverter.batch_convert_llm_topic_names`

## Verification

To verify the tables are using the correct schema:

```python
import boto3
client = boto3.client('dynamodb', endpoint_url='http://dynamodb:8000', region_name='us-east-1')
table_info = client.describe_table(TableName='Delphi_CommentEmbeddings')
print('KeySchema:', table_info['Table']['KeySchema'])
print('GSIs:', [{'IndexName': gsi['IndexName'], 'KeySchema': gsi['KeySchema']} 
              for gsi in table_info['Table'].get('GlobalSecondaryIndexes', [])])
```

The output should show job_id as the HASH key and the appropriate attribute as the RANGE key.