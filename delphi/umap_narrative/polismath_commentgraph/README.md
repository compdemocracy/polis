# Polis Comment Graph Lambda Service

This service processes Polis conversation comments using EVōC clustering and generates visualization data that is stored in DynamoDB. The service is designed to run as an AWS Lambda function, triggered by events such as new comments or requests to process an entire conversation.

## Architecture

The service follows a serverless architecture:

1. **PostgreSQL Integration**: 
   - Reads comments, participants, and votes from Polis PostgreSQL database
   - Supports both RDS and local development PostgreSQL instances

2. **Clustering Engine**:
   - Uses EVōC (Evolutionary Clustering) for hierarchical clustering of comments
   - Provides KMeans fallback for smaller datasets where EVōC may fail
   - Creates multiple layers of clusters with different granularity levels

3. **DynamoDB Storage**:
   - Stores conversation metadata, comment embeddings, cluster assignments, and visualization data
   - Separates data into multiple tables for efficient querying
   - Uses composite keys for fast lookups by conversation ID

4. **Event Processing**:
   - Processes entire conversations on-demand
   - Processes individual new comments and integrates them into existing clusters
   - Can be triggered by SNS topics, SQS queues, or direct invocation

## Components

- **Core Engine**:
  - `embedding.py`: Generates comment embeddings using SentenceTransformer
  - `clustering.py`: Performs EVōC clustering and creates hierarchical layers

- **Storage and Data Access**:
  - `storage.py`: Handles DynamoDB and PostgreSQL data access
  - `converter.py`: Converts between data formats

- **Lambda Functions**:
  - `lambda_handler.py`: Main entry point for AWS Lambda

- **CLI Tools**:
  - `cli.py`: Command-line tools for testing and local development

## Usage

### Local Development

1. Setup a local environment:
   ```bash
   python -m venv .venv
   source .venv/bin/activate
   pip install -r requirements.txt
   
   # Install EVOC from local directory
   pip install -e ../evoc-main
   ```

2. Test PostgreSQL connection:
   ```bash
   python -m polismath_commentgraph.cli test-postgres \
     --pg-host localhost \
     --pg-port 5432 \
     --pg-database polis \
     --pg-user postgres \
     --pg-password your_password
   ```

3. Test with a specific conversation:
   ```bash
   python -m polismath_commentgraph.cli test-postgres \
     --pg-host localhost \
     --pg-port 5432 \
     --pg-database polis \
     --pg-user postgres \
     --pg-password your_password \
     --zid 12345
   ```

4. Run the Lambda handler locally:
   ```bash
   python -m polismath_commentgraph.cli lambda-local \
     --conversation-id 12345 \
     --pg-host localhost \
     --pg-port 5432 \
     --pg-database polis \
     --pg-user postgres \
     --pg-password your_password
   ```

### Deployment

1. Build the Docker image:
   ```bash
   docker build -t polis-comment-graph-lambda .
   ```

2. Push to ECR:
   ```bash
   aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin 123456789012.dkr.ecr.us-east-1.amazonaws.com
   docker tag polis-comment-graph-lambda:latest 123456789012.dkr.ecr.us-east-1.amazonaws.com/polis-comment-graph-lambda:latest
   docker push 123456789012.dkr.ecr.us-east-1.amazonaws.com/polis-comment-graph-lambda:latest
   ```

3. Create Lambda function using the AWS CLI:
   ```bash
   aws lambda create-function \
     --function-name polis-comment-graph-lambda \
     --package-type Image \
     --code ImageUri=123456789012.dkr.ecr.us-east-1.amazonaws.com/polis-comment-graph-lambda:latest \
     --role arn:aws:iam::123456789012:role/lambda-execution-role \
     --environment "Variables={DATABASE_HOST=polis-db.cluster-xyz.us-east-1.rds.amazonaws.com,DATABASE_NAME=polis,DATABASE_USER=polis}" \
     --timeout 300 \
     --memory-size 1024
   ```

### Environment Variables

- `DATABASE_HOST`: PostgreSQL host
- `DATABASE_PORT`: PostgreSQL port (default: 5432)
- `DATABASE_NAME`: PostgreSQL database name (default: polis)
- `DATABASE_USER`: PostgreSQL username
- `DATABASE_PASSWORD`: PostgreSQL password
- `DYNAMODB_ENDPOINT`: Optional DynamoDB endpoint for local development
- `AWS_REGION`: AWS region for DynamoDB and other services (default: us-east-1)
- `MODEL_CACHE_DIR`: Directory to cache SentenceTransformer models (default: /tmp/model_cache)
- `LOG_LEVEL`: Logging level (default: INFO)

## Data Flow

1. PostgreSQL -> Comments data
2. Comments -> SentenceTransformer -> Embeddings
3. Embeddings -> UMAP -> 2D projection
4. Embeddings -> EVōC -> Hierarchical clusters
5. All data -> DynamoDB -> Tables for visualization

## Schema

### PostgreSQL Tables Used

- `conversations`: Metadata about conversations
- `comments`: Comment text and metadata
- `participants`: User participation information
- `votes`: User votes on comments
- `zinvites`: Conversation invite codes

### DynamoDB Tables

- `ConversationMeta`: Metadata about processed conversations
- `CommentEmbeddings`: Embeddings and coordinates for each comment
- `CommentClusters`: Cluster assignments for each comment
- `ClusterTopics`: Topic information for each cluster
- `UMAPGraph`: Graph structure for visualization
- `CommentTexts`: Original text and metadata for each comment

## Limitations and Important Notes

- EVōC may fail on very small datasets (< 30 comments), in which case KMeans is used as a fallback
- Large datasets may require more memory than the default Lambda allocation
- The Lambda function has a maximum execution time of 15 minutes, which should be sufficient for most conversations

## Technical Notes

### DynamoDB Float Handling

DynamoDB does not accept floating-point numbers directly. Our service automatically converts all floating-point values to `Decimal` types before storing them in DynamoDB. This is handled by the `DataConverter.convert_floats_to_decimal()` method in `converter.py`. When retrieving data from DynamoDB, you may need to convert `Decimal` values back to native float types in your application code.

### Local Development with DynamoDB

For local development, you can run DynamoDB locally using Docker:

```bash
docker run -p 8000:8000 amazon/dynamodb-local -jar DynamoDBLocal.jar -sharedDb
```

Then create the required tables:

```python
python -c "
import boto3
dynamodb = boto3.resource('dynamodb', endpoint_url='http://localhost:8000', 
                         region_name='us-east-1',
                         aws_access_key_id='fakeMyKeyId',
                         aws_secret_access_key='fakeSecretAccessKey')

# Create tables
for table_name in ['ConversationMeta', 'CommentEmbeddings', 'CommentClusters', 
                   'ClusterTopics', 'UMAPGraph', 'CommentTexts']:
    # Define schema based on table
    if table_name == 'ConversationMeta':
        key_schema = [{'AttributeName': 'conversation_id', 'KeyType': 'HASH'}]
        attr_defs = [{'AttributeName': 'conversation_id', 'AttributeType': 'S'}]
    elif table_name in ['CommentEmbeddings', 'CommentClusters', 'CommentTexts']:
        key_schema = [
            {'AttributeName': 'conversation_id', 'KeyType': 'HASH'},
            {'AttributeName': 'comment_id', 'KeyType': 'RANGE'}
        ]
        attr_defs = [
            {'AttributeName': 'conversation_id', 'AttributeType': 'S'},
            {'AttributeName': 'comment_id', 'AttributeType': 'N'}
        ]
    elif table_name == 'ClusterTopics':
        key_schema = [
            {'AttributeName': 'conversation_id', 'KeyType': 'HASH'},
            {'AttributeName': 'cluster_key', 'KeyType': 'RANGE'}
        ]
        attr_defs = [
            {'AttributeName': 'conversation_id', 'AttributeType': 'S'},
            {'AttributeName': 'cluster_key', 'AttributeType': 'S'}
        ]
    elif table_name == 'UMAPGraph':
        key_schema = [
            {'AttributeName': 'conversation_id', 'KeyType': 'HASH'},
            {'AttributeName': 'edge_id', 'KeyType': 'RANGE'}
        ]
        attr_defs = [
            {'AttributeName': 'conversation_id', 'AttributeType': 'S'},
            {'AttributeName': 'edge_id', 'AttributeType': 'S'}
        ]
    
    # Create table
    try:
        table = dynamodb.create_table(
            TableName=table_name,
            KeySchema=key_schema,
            AttributeDefinitions=attr_defs,
            BillingMode='PAY_PER_REQUEST'
        )
        print(f'Creating table: {table_name}')
    except Exception as e:
        print(f'Error creating {table_name}: {e}')
"
```