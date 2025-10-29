# Reset Single Conversation Data

This guide provides scripts to completely remove all data for a single conversation from the Delphi system.

## Quick Reset Command

Use this script to remove all data for a conversation by report_id:

```bash
# Usage: ./reset_conversation.py <report_id>
docker exec polis-dev-delphi-1 python -c "
import boto3
import sys

def reset_conversation_data(report_id):
    '''Remove all data for a conversation from all Delphi DynamoDB tables'''

    # Connect to DynamoDB
    dynamodb = boto3.resource('dynamodb', endpoint_url='http://dynamodb:8000', region_name='us-east-1')

    print(f'🔍 Resetting ALL data for conversation: {report_id}')

    # All Delphi tables that might contain conversation data
    tables_to_check = [
        # Math/PCA tables
        'Delphi_PCAConversationConfig',
        'Delphi_PCAResults',
        'Delphi_KMeansClusters',
        'Delphi_CommentRouting',
        'Delphi_RepresentativeComments',
        'Delphi_PCAParticipantProjections',

        # UMAP/Topic tables
        'Delphi_UMAPConversationConfig',
        'Delphi_CommentEmbeddings',
        'Delphi_CommentHierarchicalClusterAssignments',
        'Delphi_CommentClustersStructureKeywords',
        'Delphi_UMAPGraph',
        'Delphi_CommentClustersFeatures',
        'Delphi_CommentClustersLLMTopicNames',

        # Narrative and job tables
        'Delphi_NarrativeReports',
        'Delphi_JobQueue'
    ]

    total_deleted = 0

    for table_name in tables_to_check:
        try:
            table = dynamodb.Table(table_name)
            deleted_from_table = 0

            print(f'📋 Checking {table_name}...')

            # Method 1: Check by conversation_id field
            try:
                response = table.scan(
                    FilterExpression='conversation_id = :conv_id',
                    ExpressionAttributeValues={':conv_id': report_id}
                )
                items = response.get('Items', [])
                deleted_from_table += delete_items(table, items, 'conversation_id match')
            except:
                pass

            # Method 2: Check narrative reports (special format)
            if table_name == 'Delphi_NarrativeReports':
                try:
                    response = table.scan(
                        FilterExpression='begins_with(rid_section_model, :prefix)',
                        ExpressionAttributeValues={':prefix': f'{report_id}#'}
                    )
                    items = response.get('Items', [])
                    deleted_from_table += delete_items(table, items, 'narrative reports')
                except:
                    pass

            # Method 3: Check job queue (might have report_id or job_id containing report_id)
            if table_name == 'Delphi_JobQueue':
                try:
                    response = table.scan(
                        FilterExpression='contains(job_id, :report_id) OR (attribute_exists(report_id) AND report_id = :report_id)',
                        ExpressionAttributeValues={':report_id': report_id}
                    )
                    items = response.get('Items', [])
                    deleted_from_table += delete_items(table, items, 'job queue')
                except:
                    pass

            # Method 4: Check primary key contains report_id (for tables that use report_id as part of key)
            try:
                key_schema = table.key_schema
                pk_name = key_schema[0]['AttributeName']
                response = table.scan(
                    FilterExpression='contains(#pk, :report_id)',
                    ExpressionAttributeNames={'#pk': pk_name},
                    ExpressionAttributeValues={':report_id': report_id}
                )
                items = response.get('Items', [])
                deleted_from_table += delete_items(table, items, 'primary key match')
            except:
                pass

            if deleted_from_table > 0:
                print(f'  ✅ Deleted {deleted_from_table} items from {table_name}')
                total_deleted += deleted_from_table
            else:
                print(f'  ⚪ No data found in {table_name}')

        except Exception as e:
            print(f'  ❌ Error checking {table_name}: {e}')

    print(f'🎯 Total deletion complete: {total_deleted} items removed')
    return total_deleted

def delete_items(table, items, source_desc):
    '''Delete a list of items from a DynamoDB table'''
    if not items:
        return 0

    deleted_count = 0
    key_schema = table.key_schema

    for item in items:
        try:
            # Build the key for deletion
            delete_key = {}
            for key_attr in key_schema:
                attr_name = key_attr['AttributeName']
                if attr_name in item:
                    delete_key[attr_name] = item[attr_name]

            if delete_key:
                table.delete_item(Key=delete_key)
                deleted_count += 1

        except Exception as e:
            print(f'    ⚠️  Error deleting item: {e}')

    return deleted_count

# Get report_id from command line argument
import sys
if len(sys.argv) > 1:
    report_id = sys.argv[1]
else:
    report_id = '${1:-REPORT_ID_REQUIRED}'

if report_id == 'REPORT_ID_REQUIRED':
    print('❌ Usage: reset_conversation.py <report_id>')
    print('   Example: reset_conversation.py r3p4ryckema3wfitndk6m')
    sys.exit(1)

# Execute the reset
reset_conversation_data(report_id)
" "$1"
```

## Usage Examples

```bash
# Reset conversation by report ID
docker exec polis-dev-delphi-1 python -c "$(cat reset_conversation_script)" r3p4ryckema3wfitndk6m

# Reset conversation by zid (if you have a zid, use it as report_id)
docker exec polis-dev-delphi-1 python -c "$(cat reset_conversation_script)" 12345
```

## What Gets Deleted

This script removes data from ALL Delphi tables:

### Math/PCA Pipeline Data
- `Delphi_PCAConversationConfig` - Conversation metadata
- `Delphi_PCAResults` - PCA analysis results
- `Delphi_KMeansClusters` - Cluster/group data
- `Delphi_CommentRouting` - Comment routing data
- `Delphi_RepresentativeComments` - Representative comment analysis
- `Delphi_PCAParticipantProjections` - Participant projections

### UMAP/Topic Pipeline Data
- `Delphi_UMAPConversationConfig` - UMAP configuration
- `Delphi_CommentEmbeddings` - Comment embeddings
- `Delphi_CommentHierarchicalClusterAssignments` - Cluster assignments
- `Delphi_CommentClustersStructureKeywords` - Cluster keywords/structure
- `Delphi_UMAPGraph` - UMAP graph data
- `Delphi_CommentClustersFeatures` - Cluster features
- `Delphi_CommentClustersLLMTopicNames` - LLM-generated topic names

### Narrative and Job Data
- `Delphi_NarrativeReports` - Generated narrative reports
- `Delphi_JobQueue` - Job queue entries

## Safe Usage

- ✅ **Safe**: Only affects the specified conversation
- ✅ **Thorough**: Checks all possible data locations
- ✅ **Informative**: Shows exactly what was deleted
- ⚠️ **Irreversible**: Deleted data cannot be recovered

## Troubleshooting

If you see errors about missing tables, that's normal - it means those tables don't exist yet or are empty.

The script uses multiple detection methods:
1. Direct `conversation_id` field matching
2. Special format handling for narrative reports (`rid_section_model`)
3. Job queue entries with embedded report IDs
4. Primary key substring matching

This ensures all data related to the conversation is found and removed.

### Important: Report ID vs Conversation ID Mismatch

**⚠️ KNOWN ISSUE**: Some data may be stored with numeric `conversation_id` (e.g., 31342) while you have the report_id (e.g., r3p4ryckema3wfitndk6m).

If the script shows "No data found" but you know data exists:

1. **Find the actual conversation_id**:
   ```bash
   # Search for report_id in metadata fields
   docker exec polis-dev-delphi-1 python -c "
   import boto3
   dynamodb = boto3.resource('dynamodb', endpoint_url='http://dynamodb:8000', region_name='us-east-1')

   # Check UMAPConversationConfig for metadata containing report_id
   table = dynamodb.Table('Delphi_UMAPConversationConfig')
   response = table.scan()
   for item in response.get('Items', []):
       if 'YOUR_REPORT_ID' in str(item).lower():
           print(f'Found: conversation_id={item.get(\"conversation_id\")}, metadata={item.get(\"metadata\", {})}')
   "
   ```

2. **Use the numeric conversation_id** instead:
   ```bash
   # Reset using the numeric ID you found
   docker exec polis-dev-delphi-1 python -c "$(cat reset_conversation_script)" 31342
   ```

3. **TODO**: Update the script to automatically resolve report_id → conversation_id mappings by checking metadata fields.

This mapping issue occurs because:
- PostgreSQL uses numeric zid/conversation_id
- DynamoDB stores data with these numeric IDs
- Report URLs use string report_id format
- The metadata field may contain the report_id but the primary key uses conversation_id
