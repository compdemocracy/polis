# Data Format Standards for Delphi System

This document defines the data format standards used throughout the Delphi system to ensure consistency and compatibility across all components.

## Database Key Formats

### DynamoDB Key Formats

DynamoDB tables use specific key format conventions that must be followed consistently:

#### Delphi_NarrativeReports Table

- **Primary Key (rid_section_model)**: `{report_id}#{section_name}#{model}`
  - **report_id**: The report identifier (e.g., "r123456" or numerical ID)
  - **section_name**: The section of the report (e.g., "topic_zebra_crossing")
  - **model**: The LLM model used (e.g., "claude-sonnet-5")
  - **Delimiter**: Always use `#` as the delimiter (not underscores)

```python
# CORRECT FORMAT - Always use # delimiter
rid_section_model = f"{report_id}#{section_name}#{model}"

# INCORRECT - Don't use _ delimiter
# rid_section_model = f"{report_id}_{section_name}_{model}"
```

**API Query Example**:
```javascript
// How the server queries reports
FilterExpression: "begins_with(rid_section_model, :prefix)",
ExpressionAttributeValues: {
  ":prefix": `${conversation_id}#`
}
```

#### Delphi_UMAPGraph Table

- **Primary Key**: `{conversation_id}#{edge_id}`
  - **conversation_id**: The conversation ID
  - **edge_id**: Unique identifier for the edge
  - **Delimiter**: Always use `#` as the delimiter

#### Delphi_CommentClustersStructureKeywords Table

- **Primary Key**: `{conversation_id}#{cluster_key}`
  - **conversation_id**: The conversation ID
  - **cluster_key**: Unique identifier for the cluster
  - **Delimiter**: Always use `#` as the delimiter

### Job Custom ID Format

For Anthropic batch API calls, we use a custom_id format to track individual requests:

- **Custom ID Format**: `{conversation_id}_{cluster_id}_{section_name}`
  - **conversation_id**: The conversation ID (zid)
  - **cluster_id**: Numerical ID of the cluster/group
  - **section_name**: Name of the report section
  - **Delimiter**: Underscores are acceptable here as this is just for tracking

```python
# Create a valid custom_id (only allow a-zA-Z0-9_-)
custom_id = f"{conversation_id}_{cluster_id}_{section_name}"
safe_custom_id = re.sub(r'[^a-zA-Z0-9_-]', '_', custom_id)

# Validate custom_id length (max 64 chars for Anthropic API)
if len(safe_custom_id) > 64:
    safe_custom_id = safe_custom_id[:64]
```

## Report Data JSON Structure

Reports stored in the `Delphi_NarrativeReports` table follow a consistent JSON structure:

```json
{
  "id": "topic_overview_and_consensus",
  "title": "Overview of Topic and Consensus",
  "paragraphs": [
    {
      "id": "topic_overview",
      "title": "Overview of Waste Management Concerns",
      "sentences": [
        {
          "clauses": [
            {
              "text": "The discourse around waste management revealed significant concerns",
              "citations": [196, 230, 491]
            }
          ]
        }
      ]
    }
  ]
}
```

## Reserved Keywords in DynamoDB

When working with DynamoDB, be aware of reserved keywords that require special handling:

- **status**: Always use ExpressionAttributeNames when updating status
- **data**: Always use ExpressionAttributeNames
- **timestamp**: Always use ExpressionAttributeNames

```python
# CORRECT - Using ExpressionAttributeNames
table.update_item(
    Key={'job_id': job_id},
    UpdateExpression="SET #s = :new_status",
    ExpressionAttributeNames={
        '#s': 'status'  # Handle reserved keyword
    },
    ExpressionAttributeValues={
        ':new_status': 'COMPLETED'
    }
)

# INCORRECT - Don't use reserved keywords directly
# table.update_item(
#     Key={'job_id': job_id},
#     UpdateExpression="SET status = :new_status",
#     ExpressionAttributeValues={
#         ':new_status': 'COMPLETED'
#     }
# )
```

## Environment Variable Standards

Environment variable naming follows these conventions:

- **API Keys**: `{SERVICE}_API_KEY` (e.g., `ANTHROPIC_API_KEY`)
- **Endpoints**: `{SERVICE}_ENDPOINT` (e.g., `DYNAMODB_ENDPOINT`)
- **Job Information**: `DELPHI_JOB_ID`, `DELPHI_REPORT_ID`

## Script Return Codes

Scripts should use consistent return codes:

- **0**: Success
- **1**: General failure
- **2**: Configuration error
- **3**: External API failure

## Error Messages

Error messages should follow this format:

```
{component_name} error: {specific_error} - {context}
```

Examples:
- "Batch API error: Failed to retrieve results - batch_id msgbatch_123"
- "DynamoDB error: Conditional check failed - job_id batch_check_123"

## Logging Standards

Logs should include:

1. Timestamp
2. Log level (INFO, ERROR, etc.)
3. Job ID when available
4. Concise message with specific identifiers

Example:
```
2025-05-13 23:02:47,711 - INFO - Job batch_check_123: Retrieved batch details for batch_id msgbatch_456
```

## Conversion Between PostgreSQL and DynamoDB

When moving data between PostgreSQL and DynamoDB:

1. PostgreSQL uses numeric `zid` for conversation IDs
2. DynamoDB might use string versions of these IDs
3. Always convert to the appropriate type:

```python
# When going from PostgreSQL to DynamoDB
zid_numeric = result.zid  # From PostgreSQL
zid_string = str(zid_numeric)  # For DynamoDB

# When going from DynamoDB to PostgreSQL
zid_string = item['conversation_id']  # From DynamoDB
zid_numeric = int(zid_string)  # For PostgreSQL
```

## File Structure for Generated Content

Generated content like visualization files follow this structure:

```
visualizations/{report_id}/{job_id}/layer_{layer_num}_datamapplot.html
```

## Consistent Content Types

When serving API responses:

- JSON responses should use `application/json` content-type
- JSONL responses should use `application/jsonl` content-type
- HTML visualizations should use `text/html` content-type

## Report Sections Naming Convention

Report sections should use consistent naming:

- `topic_{descriptive_name}` - For topic-specific sections
- `group_informed_consensus` - For consensus analysis
- `groups_overview` - For group overview
- `uncertainty_analysis` - For uncertainty analysis

## Versioning

Data formats should include version fields when appropriate:

```json
{
  "schema_version": "1.0",
  "content": { ... }
}
```

## Encoding Standards

- All text should be UTF-8 encoded
- Timestamps should use ISO 8601 format (e.g., "2025-05-13T23:02:47.711Z")
- All numeric IDs should be stored as strings in DynamoDB to avoid precision issues

By adhering to these standards, we ensure that components can reliably exchange and interpret data across the entire Delphi system.