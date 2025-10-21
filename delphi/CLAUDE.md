# Delphi System Reference Guide

This document provides comprehensive guidance for working with the Delphi system, including database interactions, environment configuration, Docker services, and the distributed job queue system. It serves as both documentation and a practical reference for day-to-day operations.

## Documentation Directory

For a comprehensive list of all documentation files with descriptions, see:
[delphi/docs/DOCUMENTATION_DIRECTORY.md](docs/DOCUMENTATION_DIRECTORY.md)

## Current work todos are located in:

delphi/docs/JOB_QUEUE_SCHEMA.md
delphi/docs/DISTRIBUTED_SYSTEM_ROADMAP.md

## Helpful terminology

zid - conversation id
pid - participant id
tid - comment id

this avoids the confusion of having anything called a "cid", the joke was "conversationzzzz", that's why it's a zid throughout the codebase

## helpful background

this was built in two parts, the pca/kmenas/repness and the umap/narrative, and these are combined in the run_delphi.sh script.

## Database Interactions

### Querying Local PostgreSQL Database

To interact with the local PostgreSQL database:

```sql
-- List all available databases
psql -h localhost -l

-- Query for conversations with specific keywords in topic/description
psql -h localhost -d [DATABASE_NAME] -c "SELECT zid, topic FROM conversations WHERE LOWER(topic) LIKE '%keyword%' OR LOWER(description) LIKE '%keyword%'"

-- Check comment counts for selected conversations
psql -h localhost -d [DATABASE_NAME] -c "SELECT c.zid, c.topic, COUNT(cm.tid) as comment_count FROM conversations c LEFT JOIN comments cm ON c.zid = cm.zid WHERE LOWER(c.topic) LIKE '%keyword%' GROUP BY c.zid, c.topic ORDER BY comment_count DESC"

-- Check vote counts for selected conversations
psql -h localhost -d [DATABASE_NAME] -c "SELECT c.zid, c.topic, COUNT(v.tid) as vote_count FROM conversations c LEFT JOIN votes v ON c.zid = v.zid WHERE LOWER(c.topic) LIKE '%keyword%' GROUP BY c.zid, c.topic ORDER BY vote_count DESC"

-- Check participant counts for selected conversations
psql -h localhost -d [DATABASE_NAME] -c "SELECT c.zid, c.topic, COUNT(DISTINCT p.pid) as participant_count FROM conversations c LEFT JOIN participants p ON c.zid = p.zid WHERE LOWER(c.topic) LIKE '%keyword%' GROUP BY c.zid, c.topic ORDER BY participant_count DESC"
```

Always use the commands above to determine the most substantial conversation when multiple matches are found by checking:

1. Number of comments
2. Number of votes
3. Number of participants

## Environment Configuration

### Environment Files

- Main project uses a `.env` file in the parent directory (`/Users/colinmegill/polis/.env`)
- Example environment file is available at `/Users/colinmegill/polis/delphi/example.env`

### Key Environment Variables

- **Database Connection**:

  - `DATABASE_URL`: Main PostgreSQL connection string
  - `POSTGRES_DB`: Database name
  - `POSTGRES_USER`: Database username
  - `POSTGRES_PASSWORD`: Database password
  - `POSTGRES_HOST`: Database host

- **Docker Configuration**:

  - `PYTHONPATH=/app` is set in the container
  - DynamoDB local endpoint: `http://dynamodb-local:8000`
  - Ollama endpoint: `http://ollama:11434`

- **LLM Integration**:
  - LLM API keys (Anthropic, OpenAI, etc.) are available in the parent `.env` file
  - Default Ollama model: `llama3.1:8b` (configurable via `OLLAMA_MODEL`)

- **Sentence Transformer Configuration**:
  - Default embedding model: `all-MiniLM-L6-v2` (configurable via `SENTENCE_TRANSFORMER_MODEL`)
  - For multilingual support, set `SENTENCE_TRANSFORMER_MODEL=sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2`
  - Both models produce 384-dimensional embeddings

## IMPORTANT: Finding All Logs

**CRITICAL NOTE**: The FULL system logs are stored in the DynamoDB JobQueue table's job results! When debugging issues:

1. Check job results in DynamoDB to see detailed logs that don't appear in container stdout:

   ```bash
   docker exec polis-dev-delphi-1 python -c "
   import boto3, json
   dynamodb = boto3.resource('dynamodb', endpoint_url='http://dynamodb:8000', region_name='us-east-1')
   table = dynamodb.Table('Delphi_JobQueue')
   job_id = '<YOUR_JOB_ID>'  # Replace with your job ID
   job = table.get_item(Key={'job_id': job_id})['Item']
   results = json.loads(job.get('job_results', '{}'))
   print('Complete Job Output:')
   print(results.get('output_summary', 'No output'))
   "
   ```

2. For even more detailed logs, check the job's log entries:
   ```bash
   docker exec polis-dev-delphi-1 python -c "
   import boto3, json
   dynamodb = boto3.resource('dynamodb', endpoint_url='http://dynamodb:8000', region_name='us-east-1')
   table = dynamodb.Table('Delphi_JobQueue')
   job_id = '<YOUR_JOB_ID>'  # Replace with your job ID
   job = table.get_item(Key={'job_id': job_id})['Item']
   logs = json.loads(job.get('logs', '{}'))
   print('Job Log Entries:')
   for entry in logs.get('entries', []):
      print(f\"- {entry.get('message')}\")
   "
   ```

## Docker Services

The system uses Docker Compose with three main services:

1. `dynamodb-local`: Local DynamoDB instance for development
2. `ollama`: Ollama service for local LLM processing
3. `polis-dev-delphi-1`: Main application container

## DynamoDB Configuration

### Docker Services

- The primary DynamoDB service is defined in the main `/docker-compose.yml` file
- Service name is `dynamodb` and container name is `polis-dynamodb-local`
- Exposed on port 8000
- Uses persistent storage via Docker volume `dynamodb-data`
- Access URL from the host: `http://localhost:8000`
- Access URL from Delphi containers: `http://host.docker.internal:8000`

**Important Update:** The Delphi-specific DynamoDB service (`dynamodb-local` in delphi/docker-compose.yml) has been deprecated. All DynamoDB operations now use the centralized instance from the main docker-compose.yml file.

### Connection Details

When connecting to DynamoDB from the Delphi container, use these settings:

```
DYNAMODB_ENDPOINT=http://host.docker.internal:8000
AWS_ACCESS_KEY_ID=dummy
AWS_SECRET_ACCESS_KEY=dummy
AWS_REGION=us-east-1
```

These are configured in run_delphi.sh for all DynamoDB operations.

### DynamoDB Job Queue System

Delphi now includes a distributed job queue system built on DynamoDB:

1. **Submitting Jobs**: Use the `delphi_cli.py` script:

   ```bash
   ./delphi # Launches interactive mode
   ./delphi submit --zid=12345 # Direct command mode
   ```

2. **Processing Jobs**: Start the job poller service:

   ```bash
   ./start_poller.sh
   ```

3. **Table Management**: To reset the job queue:

   ```bash
   aws dynamodb delete-table --table-name DelphiJobQueue --endpoint-url http://localhost:8000 && \
   docker exec -e PYTHONPATH=/app polis-dev-delphi-1 python /app/create_dynamodb_tables.py --endpoint-url http://host.docker.internal:8000
   ```

4. **DynamoDB Best Practices**:
   - Always use strongly consistent reads (`ConsistentRead=True`) for critical operations
   - Use optimistic locking with version numbers for updates
   - Never use empty strings for indexed fields - use placeholders instead
   - Remember that DynamoDB doesn't support null values - use empty strings

### Table Creation

- Primary script: `/create_dynamodb_tables.py` - Creates BOTH Polis math and EVōC tables
- This script is used in `run_delphi.sh` and now integrated into `umap_narrative/run_pipeline.py`

### Schema Definitions

- Model schemas: `/umap_narrative/polismath_commentgraph/schemas/dynamo_models.py` - Contains Pydantic models for the UMAP pipeline
- Table definitions: `/create_dynamodb_tables.py` - Contains DynamoDB table schemas

### Key Tables

#### Polis Math Tables (Now with Delphi\_ prefix):

- `Delphi_PCAConversationConfig` - Conversation metadata (formerly `PolisMathConversations`)
- `Delphi_PCAResults` - PCA and cluster data (formerly `PolisMathAnalysis`)
- `Delphi_KMeansClusters` - Group data (formerly `PolisMathGroups`)
- `Delphi_CommentRouting` - Comment data with priorities (formerly `PolisMathComments`)
- `Delphi_RepresentativeComments` - Representativeness data (formerly `PolisMathRepness`)
- `Delphi_PCAParticipantProjections` - Participant projection data (formerly `PolisMathProjections`)

#### EVōC/UMAP Tables (Now with Delphi\_ prefix):

- `Delphi_UMAPConversationConfig` - Metadata for conversations (formerly `ConversationMeta`)
- `Delphi_CommentEmbeddings` - Embedding vectors for comments (formerly `CommentEmbeddings`)
- `Delphi_CommentHierarchicalClusterAssignments` - Cluster assignments for comments (formerly `CommentClusters`)
- `Delphi_CommentClustersStructureKeywords` - Topic information for clusters (formerly `ClusterTopics`)
- `Delphi_UMAPGraph` - Graph structure and node positions (formerly `UMAPGraph`)
- `Delphi_CommentClustersFeatures` - TF-IDF analysis for clusters (formerly `ClusterCharacteristics`)
- `Delphi_CommentClustersLLMTopicNames` - LLM-generated topic names (formerly `LLMTopicNames`)
- `Delphi_NarrativeReports` - Generated reports (formerly `report_narrative_store`)
- `Delphi_JobQueue` - Job queue (formerly `DelphiJobQueue`)
- `Delphi_CollectiveStatement` - Collective statements generated for topics

> **Note:** All table names now use the `Delphi_` prefix for consistency.
> For complete documentation on the table renaming, see `/Users/colinmegill/polis/delphi/docs/DATABASE_NAMING_PROPOSAL.md`

## Reset Single Conversation

To completely remove all data for a single conversation from the Delphi system:

```bash
# Reset by report_id or zid
./reset_conversation.sh r3p4ryckema3wfitndk6m
./reset_conversation.sh 12345
```

Or run the comprehensive cleanup directly:
```bash
docker exec polis-dev-delphi-1 python /app/scripts/reset_conversation.py r3p4ryckema3wfitndk6m
```

This removes data from ALL Delphi DynamoDB tables including:
- Math/PCA pipeline data (clusters, projections, etc.)
- UMAP/Topic pipeline data (embeddings, topic names, etc.) 
- Narrative reports and job queue entries

See [RESET_SINGLE_CONVERSATION.md](docs/RESET_SINGLE_CONVERSATION.md) for detailed documentation.

## Running Delphi Pipeline

### Direct Execution

After identifying the correct conversation ZID, run the Delphi pipeline directly with:

```bash
./run_delphi.sh --zid=[ZID]
```

Additional options include:

- `--verbose`: Show detailed logs
- `--force`: Force reprocessing even if data exists
- `--validate`: Run extra validation checks

### Distributed Execution

For production environments, use the job queue system:

1. Start the poller service on your worker machine:

   ```bash
   ./start_poller.sh
   ```

2. Submit a job from any machine with access to DynamoDB:

   ```bash
   ./delphi submit --zid=[ZID] --priority=50
   ```

3. Monitor job status:
   ```bash
   ./delphi list
   ./delphi details [JOB_ID]
   ```

### Common Use Cases and Solutions

1. **Job queue needs resetting**:

   ```bash
   # Drop and recreate the table
   aws dynamodb delete-table --table-name Delphi_JobQueue --endpoint-url http://localhost:8000
   docker exec -e PYTHONPATH=/app polis-dev-delphi-1 python /app/create_dynamodb_tables.py --endpoint-url http://host.docker.internal:8000
   ```

   Or use the reset_database.sh script to recreate all tables:

   ```bash
   # Reset all tables (both Polis math and EVōC tables)
   ./reset_database.sh
   ```

2. **Testing specific pipeline stages**:

   ```bash
   # Submit only a PCA or UMAP job
   ./delphi submit --zid=12345 --job-type=PCA
   ./delphi submit --zid=12345 --job-type=UMAP
   ```

3. **Handling large datasets**:

   ```bash
   # Use batch processing for large conversations
   ./delphi submit --zid=12345 --max-votes=100000 --batch-size=10000
   ```

4. **Deploying to EC2**:
   - Use `systemd` service files to manage the poller
   - Set environment variables to configure instance resources
   - Scale horizontally with multiple worker instances

## Instance Type Autoscaling Configuration

When running Delphi in an autoscaling environment, the system automatically configures resources based on the instance type. This configuration is controlled by instance metadata and environment variables.

### Instance Types and Resource Allocation

| Instance Type       | Description               | Worker Threads | Worker Memory | Container Memory | Container CPUs |
| ------------------- | ------------------------- | -------------- | ------------- | ---------------- | -------------- |
| small (t3.large)    | Cost-efficient processing | 3              | 2g            | 8g               | 2              |
| large (c6g.4xlarge) | High-performance ARM      | 8              | 8g            | 32g              | 8              |

These settings are automatically applied based on the `/etc/app-info/instance_size.txt` file created during instance initialization.

### Manual Configuration

To manually configure these settings, set the following environment variables:

```bash
# For small instances (t3.large)
INSTANCE_SIZE=small
DELPHI_MAX_WORKERS=3
DELPHI_WORKER_MEMORY=2g
DELPHI_CONTAINER_MEMORY=8g
DELPHI_CONTAINER_CPUS=2

# For large instances (c6g.4xlarge)
INSTANCE_SIZE=large
DELPHI_MAX_WORKERS=8
DELPHI_WORKER_MEMORY=8g
DELPHI_CONTAINER_MEMORY=32g
DELPHI_CONTAINER_CPUS=8
```

### Auto-scaling Groups

The system uses AWS Auto Scaling Groups to manage capacity:

- Small Instance ASG: 2 instances by default, scales up to 5 based on demand
- Large Instance ASG: 1 instance by default, scales up to 3 based on demand

CPU utilization triggers scaling actions (scale down when below 60%, scale up when above 80%).
