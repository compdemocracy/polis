# Consensus-Divisive Visualization Tool

## Overview
`702_consensus_divisive_datamapplot.py` generates visualizations that highlight which comments in a Polis conversation have high consensus (green) versus high divisiveness (red).

## Features
- **Data-adaptive scaling** using 95th percentile normalization
- **Environment variable configuration** for production deployment
- **DynamoDB integration** for comment positions and clusters
- **PostgreSQL integration** for extremity values from math_main

## Data Sources
- Comment positions from DynamoDB UMAPGraph table
- Cluster assignments from DynamoDB CommentClusters table
- Topic names from DynamoDB LLMTopicNames table
- Extremity values from PostgreSQL math_main table (`pca.comment-extremity`)

## Usage

### Basic Usage
```bash
python -m umap_narrative.702_consensus_divisive_datamapplot --zid 25096
```

### Advanced Options
```bash
python -m umap_narrative.702_consensus_divisive_datamapplot \
  --zid 25096 \
  --layer 0 \
  --extremity_threshold 0 \
  --output_dir custom/output/path \
  --invert_extremity
```

### Environment Variables
```bash
# Database configuration
export DATABASE_HOST="localhost"
export DATABASE_PORT="5432"
export DATABASE_NAME="polisDB_prod_local_mar14"
export DATABASE_USER="username"
export DATABASE_PASSWORD="password"
export DATABASE_SSL_MODE="disable"

# DynamoDB configuration
export DYNAMODB_ENDPOINT="http://localhost:8000"
export AWS_REGION="us-east-1"
export AWS_ACCESS_KEY_ID="fakeMyKeyId"
export AWS_SECRET_ACCESS_KEY="fakeSecretAccessKey"

# Visualization settings
export EXTREMITY_THRESHOLD="0"  # Use 0 for adaptive percentile-based normalization
export INVERT_EXTREMITY="false"
export VIZ_OUTPUT_DIR="visualizations"
```

## Output
- `{zid}_consensus_divisive_colored_map.png`: Visualization with topic labels
- `{zid}_consensus_divisive_colored_map.svg`: Vector version of the map
- `{zid}_consensus_divisive_colored_map_hires.png`: High-resolution version
- `{zid}_consensus_divisive_enhanced.png`: Simplified visualization without topic labels

## Improvements Made
1. **Statistical robustness**: Replaced arbitrary threshold with adaptive 95th percentile normalization
2. **Environment configuration**: Added comprehensive environment variable support
3. **Database abstraction**: Created reusable connection functions for PostgreSQL
4. **Error handling**: Added comprehensive error tracking and logging
5. **Documentation**: Added usage examples and configuration options