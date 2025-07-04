# Polis Comment Graph Lambda Service Project Summary

## Overview

This document summarizes the implementation of a serverless Lambda service for processing Polis conversation comments using EVōC clustering. The service loads data from a PostgreSQL database, processes the comments, and stores the results in DynamoDB for visualization and analysis.

## System Architecture

1. **Data Source**: PostgreSQL database containing Polis conversations, comments, votes, and participants.
2. **Processing Engine**: AWS Lambda function that processes conversations and comments.
3. **Storage**: DynamoDB tables for storing processed results.
4. **Deployment**: Docker container deployed to AWS Lambda.

## Technical Components

### 1. PostgreSQL Integration

- Direct connection to Polis database (supports both RDS and local development)
- Queries comments, votes, and participants by conversation ID
- SQL queries designed to retrieve all relevant data efficiently
- Now includes both active and inactive comments for complete processing

### 2. Comment Processing Pipeline

- **Text Embedding**: Using SentenceTransformer (configurable via `SENTENCE_TRANSFORMER_MODEL` env var, defaults to `all-MiniLM-L6-v2`) to generate 384-dimensional embeddings
- **Dimensionality Reduction**: UMAP projection to 2D for visualization
- **Hierarchical Clustering**: EVōC algorithm creates multiple layers of clusters
  - Fine-grained (most detailed)
  - Medium (intermediate level)
  - Coarse (high-level groupings)

### 3. DynamoDB Schema

Five tables were created to store different aspects of the processed data:

- **ConversationMeta**: Metadata about processed conversations
  - Configuration parameters (UMAP, EVōC)
  - Cluster layer information
  - Processing timestamps
  - Comment counts

- **CommentEmbeddings**: Vector representations of comments
  - 384-dimensional embeddings
  - 2D UMAP coordinates
  - Nearest neighbor information

- **CommentClusters**: Cluster assignments for each comment
  - Layer-specific cluster IDs
  - Distance to cluster centroid
  - Confidence scores

- **ClusterTopics**: Information about each cluster
  - Topic label
  - Sample comments
  - Parent/child relationships
  - Centroid coordinates

- **CommentTexts**: Original comment text and metadata
  - Comment body
  - Author ID
  - Creation timestamp
  - Vote counts

### 4. Float-to-Decimal Conversion

A critical implementation detail was handling DynamoDB's limitation with floating-point numbers:

- Created a `DataConverter` class with `convert_floats_to_decimal` method
- Implemented recursive conversion of all floats to Decimal
- Applied conversion before all DynamoDB write operations
- Ensured compatibility with numeric vector data

### 5. Local Development Environment

- Docker-based local DynamoDB instance
- PostgreSQL connection to development database
- CLI interface for local testing
- Export utilities for analyzing results

## Performance Results

Testing with conversation ID 17909 (zinvite: 9wtchdmmun):

### Data Size
- Total comments: 896
- Active comments: 636
- Inactive comments: 260

### Cluster Structure
- Layer 0 (Fine-grained): 37 clusters
- Layer 1 (Medium): 17 clusters
- Layer 2 (Coarse): 7 clusters

### Processing Time
- Total: 11.02 seconds
- Embedding generation: 2.07s
- UMAP projection: 2.92s
- EVōC clustering: 2.59s
- DynamoDB storage: 3.34s

### Storage Results
- CommentClusters: 896 items
- CommentEmbeddings: 896 items
- CommentTexts: 896 items
- ClusterTopics: 61 items
- ConversationMeta: 1 item

## Key Accomplishments

1. **Serverless Architecture**: Implemented as an AWS Lambda function, eliminating the need for a persistent server.

2. **Database Integration**: Connected directly to the PostgreSQL database instead of using exported files.

3. **Hierarchical Clustering**: Implemented EVōC to create multiple layers of clustering for different granularity levels.

4. **Efficient Storage**: Used DynamoDB for scalable, fast access to processed data.

5. **Float-to-Decimal Conversion**: Solved the critical issue of storing floating-point numbers in DynamoDB.

6. **Complete Data Processing**: Modified to process all comments (both active and inactive) for comprehensive analysis.

## Implementation Challenges Solved

1. **DynamoDB Float Limitation**: 
   - Problem: DynamoDB doesn't accept floating-point numbers directly
   - Solution: Implemented automatic conversion to Decimal type

2. **Active vs. Inactive Comments**:
   - Problem: Initial implementation only processed active comments
   - Solution: Removed the filter to process all comments

3. **Large Document Size**:
   - Problem: Embedding vectors could potentially exceed DynamoDB limits
   - Solution: Verified that even with 384-dimensional vectors, we stay well under the 400KB item limit

4. **Local Testing Environment**:
   - Problem: Needed a way to test without AWS credentials
   - Solution: Implemented Docker-based local DynamoDB with simulated credentials

## Future Enhancements

1. **Parallel Processing**: Implement batch processing for very large conversations.

2. **Topic Extraction**: Add automatic topic labeling based on cluster content.

3. **Incremental Updates**: Optimize for adding new comments without reprocessing entire conversations.

4. **Advanced Visualization**: Create interactive visualizations that read directly from DynamoDB.

5. **Authentication**: Implement secure access to the Lambda function via API Gateway.

## AWS Deployment Considerations

1. **IAM Permissions**: Need access to DynamoDB, RDS/PostgreSQL, and CloudWatch Logs.

2. **Memory Allocation**: 1024MB recommended for processing medium-sized conversations.

3. **Timeout Configuration**: 5-minute timeout should be sufficient for most conversations.

4. **Container Deployment**: Using Docker container for consistent dependencies.

5. **Event Triggers**: Can be triggered by SNS, SQS, API Gateway, or direct invocation.

## Conclusion

The Polis Comment Graph Lambda service successfully transforms Polis conversation data into a structured format for analysis and visualization. By leveraging serverless architecture, it provides a scalable solution that can handle conversations of various sizes while maintaining good performance.

The hierarchical clustering approach provides multiple levels of insight into conversation structure, allowing users to explore themes at different granularity levels.

With the float-to-Decimal conversion issue solved, the service is ready for deployment to AWS or continued local development and testing.