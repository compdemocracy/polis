# Delphi System Reference Guide

This document provides comprehensive guidance for working with the Delphi system, including database interactions, environment configuration, Docker services, and the distributed job queue system. It serves as both documentation and a practical reference for day-to-day operations.

## Documentation

**Warning:** Many docs in `docs/` are outdated and should not be trusted. Always verify against the actual code. Start with `docs/PLAN_DISCREPANCY_FIXES.md` (canonical fix plan) and `docs/CLJ-PARITY-FIXES-JOURNAL.md` (session journal) for current Clojure parity work.

The [environment read reference](../docs/configuration-env-reference.md) lists per-site defaults and secret status; the [deployment/service inventory](../docs/deployment-configuration.md) relates those inputs to external services. These source-backed references supplement the workflow and debugging procedures below.

## Helpful terminology

zid - conversation id
pid - participant id
tid - comment id

this avoids the confusion of having anything called a "cid", the joke was "conversationzzzz", that's why it's a zid throughout the codebase

## helpful background

this was built in two parts, the PCA/k-means/representativeness and the umap/narrative, and these are combined in the run_delphi.py script.

## Local Python Environment

Canonical venv: `delphi/.venv` (Python 3.12). Setup is documented for humans in
[`README.md`](README.md#local-python-development) and
[`docs/QUICK_START.md`](docs/QUICK_START.md#environment-setup) — see those for
the `make venv` / `uv sync` workflows.

Invariant to be aware of when navigating this repo: **both `delphi/.venv` and
`polis/.venv` should point at the same environment** (one real, the other a
symlink). The Pyright config (`[tool.pyright]` in `delphi/pyproject.toml`)
resolves `venv = ".venv"` to `delphi/.venv`; editors opening at the repo root
look for `polis/.venv`. If you see unresolved imports while working in this
codebase, check that both paths exist and resolve to the same env.

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

- From `delphi/`, the repository-root environment file is `../.env`; loading it depends on the entry point. Root Compose maps Delphi inputs explicitly ([Compose:99](../docker-compose.yml#L99)).
- The repository-root example is `../example.env`. Its values are local setup examples, not defaults shared by all Python entry points.
- `MATH_ENV` is namespace configuration: the standalone PostgreSQL poller defaults to `dev`, while root Compose supplies `prod` to Delphi and defaults the separate `math-python` profile to `python` ([poller config:234](polismath/poller/service.py#L234), [Compose:114](../docker-compose.yml#L114), [Compose:176](../docker-compose.yml#L176)).

### Key Environment Variables

- **Database Connection**:

  - `DATABASE_URL`: Main PostgreSQL connection string
  - `POSTGRES_DB`: Database name
  - `POSTGRES_USER`: Database username
  - `POSTGRES_PASSWORD`: Database password
  - `POSTGRES_HOST`: Database host; root Compose maps it to `DATABASE_HOST` for Delphi ([Compose:136](../docker-compose.yml#L136)). `DATABASE_*`, `POSTGRES_*` and `DATABASE_URL` handling varies by entry point; see [PostgresClient](polismath/database/postgres.py#L1) and [math pipeline](polismath/run_math_pipeline.py#L1).
  - `POSTGRES_CONNECT_TIMEOUT`: Seconds before the initial TCP `connect()`
    gives up. **Default 30s** (conservative for production: transient
    slowness, scale-up, network blips). CI and `example.env` override to **5s**
    so tests and local dev fail fast when Postgres isn't running — without
    this, an unreachable DB causes the process to hang for the kernel default
    (~60–120s+). Honored by:
    - `polismath/database/postgres.py` — SQLAlchemy `PostgresClient`.
    - `polismath/run_math_pipeline.py` — psycopg2 `connect()` (the production
      math worker invoked from `run_delphi.py`).

    Note that SQLAlchemy's `pool_pre_ping` does NOT replace this: pre-ping
    only acts on already-pooled connections, not on the initial socket connect.
    Other psycopg2 callsites (`tests/`, `scripts/regression_download.py`) still
    hardcode their own timeouts (typically 5s) — flag as a future cleanup if
    you change anything in their neighborhood.

- **Docker Configuration**:

  - `PYTHONPATH=/app` is set in the container
  - For root Compose networking, set `DYNAMODB_ENDPOINT=http://dynamodb:8000`; Compose passes the configured value without a fallback ([Compose:116](../docker-compose.yml#L116), [service:286](../docker-compose.yml#L286)). Some standalone constructors retain `dynamodb-local` or `localhost` fallbacks, so select the endpoint for the actual launch topology.
  - Ollama endpoint: `http://ollama:11434`

- **LLM Integration**:
  - Supply the selected provider's API key through the intended environment; do not assume a parent `.env` contains working credentials. The [provider factory](umap_narrative/llm_factory_constructor/model_provider.py#L687) takes a provider argument or `LLM_PROVIDER`; the Anthropic path also needs a model argument or `ANTHROPIC_MODEL`.
  - The Ollama provider defaults to `llama3`; the [setup script](scripts/setup_ollama.sh#L11) defaults to `llama3.1:8b`. `OLLAMA_MODEL` selects the model, and the provider reads `OLLAMA_HOST` before `OLLAMA_ENDPOINT`; caller-specific fallbacks are listed in the [reference](../docs/configuration-env-reference.md).

- **Sentence Transformer Configuration**:
  - Default embedding model: `all-MiniLM-L6-v2` (configurable via `SENTENCE_TRANSFORMER_MODEL`)
  - For multilingual support, set `SENTENCE_TRANSFORMER_MODEL=sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2`
  - Both models produce 384-dimensional embeddings

## IMPORTANT: Finding All Logs

**CRITICAL NOTE**: JobQueue is not a full system-log archive. `job_results` contains structured result/error fields, while `logs.entries` retains the latest **50 entries** ([complete_job:773](scripts/job_poller.py#L773), [log truncation:757](scripts/job_poller.py#L757)). Inspect both the record and the selected Compose project's `delphi` stdout/stderr logs; child output is streamed by [the worker](scripts/job_poller.py#L1273). When debugging issues:

1. Check job results in DynamoDB for the recorded result/error summary:

   ```bash
   docker compose exec delphi python -c "
   import boto3, json
   dynamodb = boto3.resource('dynamodb', endpoint_url='http://dynamodb:8000', region_name='us-east-1')
   table = dynamodb.Table('Delphi_JobQueue')
   job_id = '<YOUR_JOB_ID>'  # Replace with your job ID
   job = table.get_item(Key={'job_id': job_id})['Item']
   results = json.loads(job.get('job_results', '{}'))
   print('Recorded Job Output Summary:')
   print(results.get('output_summary', 'No output'))
   "
   ```

2. Check the retained job log entries (up to the latest 50, not the full history):

   ```bash
   docker compose exec delphi python -c "
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

1. `dynamodb`: Local DynamoDB instance for development
2. `ollama`: Ollama service for local LLM processing
3. `delphi`: Main application service

These are root Compose service names ([definitions](../docker-compose.yml#L99)); `polis-dev-delphi-1` is a project-generated container name and is not portable. The debugging commands below use `docker compose exec ... delphi`; select the intended project/profile before running them.

## DynamoDB Configuration

### Docker Services

- The primary DynamoDB service is defined in the main `/docker-compose.yml` file
- Service name is `dynamodb` and container name is `polis-dynamodb-local`
- Exposed on port 8000
- Uses persistent storage via Docker volume `dynamodb-data`
- Access URL from the host: `http://localhost:8000`
- Access URL from Delphi containers on the root Compose network: `http://dynamodb:8000` ([service:286](../docker-compose.yml#L286)). `host.docker.internal` is a different, host-access topology and is not the root service DNS name.

**Important Update:** Root Compose defines the centralized `dynamodb` service ([Compose:286](../docker-compose.yml#L286)). Standalone Python constructors can still select a different endpoint or local fallback; this service definition does not redirect every DynamoDB operation automatically.

### Connection Details

When connecting to DynamoDB from the Delphi container, use these settings:

```
DYNAMODB_ENDPOINT=http://dynamodb:8000
AWS_ACCESS_KEY_ID=dummy
AWS_SECRET_ACCESS_KEY=dummy
AWS_REGION=us-east-1
```

These are local-emulator example values. Configure them for the selected process; `run_delphi.py` does not establish one universal endpoint/credential policy for all callers. Consult [the per-site inventory](../docs/configuration-env-reference.md).

### DynamoDB Job Queue System

Delphi now includes a distributed job queue system built on DynamoDB:

1. **Submitting Jobs**: Use the `delphi_cli.py` script:

   ```bash
   ./delphi # Launches interactive mode
   ./delphi submit --zid="$LOCAL_ZID" # Direct command mode
   ```

2. **Processing Jobs**: Start the job poller service:

   ```bash
   python start_poller.py
   ```

3. **Table Management**: For a disposable local queue only, with workers stopped, the historical drop/recreate procedure is:

   This is not a conversation reset: `Delphi_JobActiveGuard` is a separate table and stale guards must not be abandoned. Use [Reset Single Conversation](#reset-single-conversation) for the full conversation/guard cleanup contract.

   ```bash
   aws dynamodb delete-table --table-name Delphi_JobQueue --endpoint-url http://localhost:8000 && \
   docker compose exec -e PYTHONPATH=/app delphi python /app/create_dynamodb_tables.py --endpoint-url http://dynamodb:8000
   ```

4. **DynamoDB Best Practices**:
   - Use strongly consistent **base-table** reads (`ConsistentRead=True`) for critical decisions; a GSI cannot provide the guard's strong-consistency proof ([job guard:16](../server/src/routes/delphi/jobGuard.ts#L16)).
   - Use optimistic locking with version numbers for updates
   - Never use empty strings for indexed fields - use placeholders instead
   - DynamoDB has a `NULL` type; do not replace every null with an empty string. Follow the actual serializer/model, especially for indexed keys ([serializer](polismath/database/dynamodb.py#L75), [models](umap_narrative/polismath_commentgraph/schemas/dynamo_models.py#L1)).

### Table Creation

- Primary script: [`create_dynamodb_tables.py`](create_dynamodb_tables.py) - Creates BOTH Polis math and EVōC tables
- This script is used in `run_delphi.py` and now integrated into `umap_narrative/run_pipeline.py`

### Schema Definitions

- Model schemas: [`umap_narrative/polismath_commentgraph/schemas/dynamo_models.py`](umap_narrative/polismath_commentgraph/schemas/dynamo_models.py) - Contains Pydantic models for the UMAP pipeline
- Table definitions: [`create_dynamodb_tables.py`](create_dynamodb_tables.py) - Contains DynamoDB table schemas

### Key Tables

#### Polis Math Tables (Now with Delphi\_ prefix)

- `Delphi_PCAConversationConfig` - Conversation metadata (formerly `PolisMathConversations`)
- `Delphi_PCAResults` - PCA and cluster data (formerly `PolisMathAnalysis`)
- `Delphi_KMeansClusters` - Group data (formerly `PolisMathGroups`)
- `Delphi_CommentRouting` - Comment data with priorities (formerly `PolisMathComments`)
- `Delphi_RepresentativeComments` - Representativeness data (formerly `PolisMathRepness`)
- `Delphi_PCAParticipantProjections` - Participant projection data (formerly `PolisMathProjections`)

#### EVōC/UMAP Tables (Now with Delphi\_ prefix)

- `Delphi_UMAPConversationConfig` - Metadata for conversations (formerly `ConversationMeta`)
- `Delphi_CommentEmbeddings` - Embedding vectors for comments (formerly `CommentEmbeddings`)
- `Delphi_CommentHierarchicalClusterAssignments` - Cluster assignments for comments (formerly `CommentClusters`)
- `Delphi_CommentClustersStructureKeywords` - Topic information for clusters (formerly `ClusterTopics`)
- `Delphi_UMAPGraph` - Graph structure and node positions (formerly `UMAPGraph`)
- `Delphi_CommentClustersFeatures` - TF-IDF analysis for clusters (formerly `ClusterCharacteristics`)
- `Delphi_CommentClustersLLMTopicNames` - LLM-generated topic names (formerly `LLMTopicNames`)
- `Delphi_NarrativeReports` - Generated reports (formerly `report_narrative_store`)
- `Delphi_JobQueue` - Job queue (formerly `DelphiJobQueue`)
- `Delphi_JobActiveGuard` - Server-side active-work guard for job submission; one row per
  (conversation + report + job type) scope, written in the same transaction as the queue row so a
  resubmit cannot pay for a second provider run. Never holds queue rows, has no TTL, and is released
  only on proof — a strongly consistent terminal root plus a completed strongly consistent base-table
  scan finding no live checker descendant. A missing guard table makes submission fail closed (503),
  and a reset must delete the conversation's guard rows or the scope stays blocked. See
  `docs/JOB_QUEUE_SCHEMA.md`, `docs/RESET_SINGLE_CONVERSATION.md` and
  [server/src/routes/delphi/jobGuard.ts](../server/src/routes/delphi/jobGuard.ts). `GET /api/v3/delphi/visualizations` reports the same
  effective-work answer per job as `workLive`, so a reloaded client knows when to stop polling.
- `Delphi_CollectiveStatement` - Collective statements generated for topics
- `Delphi_TopicAgendaSelections` - Saved report/topic agenda selections ([table definition:425](create_dynamodb_tables.py#L425)).

> **Note:** All table names now use the `Delphi_` prefix for consistency.
> Table definitions in `create_dynamodb_tables.py` are the canonical reference for names and schemas.

## Reset Single Conversation

For an authorized reset of the selected local conversation, set `LOCAL_ZID` and, where needed, `LOCAL_REPORT_ID` to the intended fixture identifiers, then use the existing cleanup workflow:

```bash
# Reset by zid (conversation ID)
./reset_conversation.sh "$LOCAL_ZID"

# Reset by zid with report_id for full cleanup
./reset_conversation.sh "$LOCAL_ZID" "$LOCAL_REPORT_ID"
```

Or run the comprehensive cleanup directly:

```bash
# For zid only:
docker compose exec delphi python /app/umap_narrative/reset_conversation.py --zid "$LOCAL_ZID"

# For zid with report_id:
docker compose exec delphi python /app/umap_narrative/reset_conversation.py --zid "$LOCAL_ZID" --rid "$LOCAL_REPORT_ID"
```

This removes data from ALL Delphi DynamoDB tables including:

- Math/PCA pipeline data (clusters, projections, etc.)
- UMAP/Topic pipeline data (embeddings, topic names, etc.)
- Narrative reports, job queue entries and the conversation's active-work guards (see [reset implementation](umap_narrative/reset_conversation.py#L1)).

See [RESET_SINGLE_CONVERSATION.md](docs/RESET_SINGLE_CONVERSATION.md) for detailed documentation.

## Running Delphi Pipeline

### Direct Execution

After identifying the correct conversation ZID, run the Delphi pipeline directly with:

```bash
python run_delphi.py --zid [ZID]
```

Additional options include:

- `--verbose`: Show detailed logs
- `--force`: Force reprocessing even if data exists
- `--validate`: Run extra validation checks

### Distributed Execution

For distributed execution, use the job queue system. The CLI examples below write queue rows directly ([submit_job:201](scripts/delphi_cli.py#L201)); they do not acquire the server's active-work guard. Production duplicate-work protection depends on guarded server admission, not simply on using DynamoDB.

1. Start the poller service on your worker machine:

   ```bash
   python start_poller.py
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
   # Disposable local queue only; stop workers and account for active-work guards first
   aws dynamodb delete-table --table-name Delphi_JobQueue --endpoint-url http://localhost:8000
   docker compose exec -e PYTHONPATH=/app delphi python /app/create_dynamodb_tables.py --endpoint-url http://dynamodb:8000
   ```

2. **Testing specific pipeline stages**:

   ```bash
   # Submit only a PCA or UMAP job
   ./delphi submit --zid="$LOCAL_ZID" --job-type=PCA
   ./delphi submit --zid="$LOCAL_ZID" --job-type=UMAP
   ```

3. **Handling large datasets**:

   ```bash
   # Use batch processing for large conversations
   ./delphi submit --zid="$LOCAL_ZID" --max-votes=100000 --batch-size=10000
   ```

4. **Deploying to EC2**:
   - Use `systemd` service files to manage the poller
   - Set environment variables to configure instance resources
   - Scale horizontally with multiple worker instances

## Instance Type Autoscaling Configuration

Provisioning helpers write resource settings based on the instance-size label ([configure_instance.py:93](configure_instance.py#L93), [after_install.sh:134](../scripts/after_install.sh#L134)). Those writes do not prove that a running worker reads every setting. Current CDK instance types and capacity differ from the historical labels in the helper.

### Instance Types and Resource Allocation

| Instance Type       | Description               | Worker Threads | Worker Memory | Container Memory | Container CPUs |
| ------------------- | ------------------------- | -------------- | ------------- | ---------------- | -------------- |
| small (helper label) | Historical small preset | 3 (written only) | 2g (written only) | 8g | 2 |
| large (helper label) | Historical large preset | 8 (written only) | 8g (written only) | 32g | 8 |

The helper chooses `INSTANCE_SIZE` first, then `/etc/app-info/instance_size.txt`, then its default preset ([detection:55](configure_instance.py#L55)). `DELPHI_MAX_WORKERS` and `DELPHI_WORKER_MEMORY` have no current application readers; retain them here as documented helper outputs, not effective worker controls. `start_poller.py` instead reads `MAX_WORKERS` and passes `--max-workers` ([wrapper:22](start_poller.py#L22)). Compose reads `DELPHI_CONTAINER_MEMORY` / `DELPHI_CONTAINER_CPUS`, with fallbacks `16g` / `2` ([Compose:151](../docker-compose.yml#L151)).

Current CDK uses **c7i.2xlarge** (small) and **c7i.8xlarge** (large), both x86_64; see [ec2.ts:14](../cdk/ec2.ts#L14) and the complete [scaling table](../docs/scaling.md#current-cdk-capacity-reference). These are source defaults, not a report of deployed capacity.

### Manual Configuration

The historical helper output can be reproduced with the values below. Only the container memory/CPU names shown here have current Compose readers; these examples do not change worker parallelism. For a worker launched through `start_poller.py`, use `MAX_WORKERS` instead.

```bash
# Historical small helper preset (current CDK type is c7i.2xlarge)
INSTANCE_SIZE=small
DELPHI_MAX_WORKERS=3
DELPHI_WORKER_MEMORY=2g
DELPHI_CONTAINER_MEMORY=8g
DELPHI_CONTAINER_CPUS=2

# Historical large helper preset (current CDK type is c7i.8xlarge)
INSTANCE_SIZE=large
DELPHI_MAX_WORKERS=8
DELPHI_WORKER_MEMORY=8g
DELPHI_CONTAINER_MEMORY=32g
DELPHI_CONTAINER_CPUS=8
```

### Auto-scaling Groups

The system uses AWS Auto Scaling Groups to manage capacity:

- Small Instance ASG: minimum/desired/maximum **1/1/7** ([autoscaling.ts:72](../cdk/autoscaling.ts#L72)).
- Large Instance ASG: minimum/desired/maximum **0/0/3** ([autoscaling.ts:90](../cdk/autoscaling.ts#L90)).
- The worker still classifies conversations above 5,000 comments as large ([job_poller.py:696](scripts/job_poller.py#L696)); zero desired large-tier capacity therefore matters to routing.

Delphi CPU target tracking uses **60%**; **80%** is a separate high-CPU alarm threshold, not a symmetric scale-out threshold ([policies:129](../cdk/autoscaling.ts#L129)).


## Testing

Run tests with `pytest` on the `tests/` folder.

### Datasets of reference

In `real_data`, we have several datasets of real conversations, exported from Polis, that can be used for testing and development. Those at the root of `real_data` are public.
In `real_data/.local`, we have some private datasets that can only be used internally. The comparer supports both public and private datasets via the `--include-local` flag.

### Regressions and golden snapshots

For regressions compared to the latest validated python code, there are both regression unit tests in `tests/`, as well as a test script that compares the output to "golden snapshots": `scripts/regression_comparer.py`. That script is more verbose than the tests, useful for debugging.

The regression comparer applies its own numerical tolerances. This does not relax replay/certification gates: follow [certify.py](polismath/replay/certify.py#L1829), [served-math validation](polismath/replay/served_math.py#L197), and [engine-stage oracles](../docs/engine-stage-oracles.md) for the contract under test.

### Old Clojure reference implementation, and moving to Sklearn

For math, the Clojure implementation is in [`../math/src/polismath`](../math/src/polismath); `delphi/polismath` is Python. Until we can replace it, we run comparisons between the two implementations in `tests/*legacy*`. Those run the python code, and compare some of the output in some way to the `math blob`, which is the JSON output of the Clojure implementation, often stored in the PostgreSQL database, but for simplicity stored along the golden (python) snapshots used by the regression comparer, so we do not have to run Postgres nor Clojure to run those tests.

A lot of the current python code was ported from Clojure using an AI agent (Sonnet 3.5 last year), including a lot of home-made implementations of core algorithms. We are in the process of replacing those with standard implementations (such as sklearn for the PCA and K-means). This is ongoing work, and made harder by the fact that the Python code does not quite produce the same output as the Clojure code. So typically we have to check what the ported python code is doing differently from the clojure code, adjust the python code to match the clojure output, and then replace it with standard implementations, which may again produce different output. Evaluate those differences against the named regression and certification contracts rather than treating similar-looking output as acceptance. The Python PCA switch currently defaults to `powerit`; `sklearn` is an explicitly selected alternative ([pca.py:37](polismath/pca_kmeans_rep/pca.py#L37), [flag resolver:24](polismath/utils/env_flags.py#L24)).
