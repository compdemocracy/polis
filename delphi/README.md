# Pol.is Math (Python Implementation)

## Quickstart example

```bash
docker-compose up -d
```

```bash
docker exec polis-dev-delphi-1 python /app/create_dynamodb_tables.py --endpoint-url=http://dynamodb-local:8000
```

```bash
# Set up the MinIO bucket for visualization storage
python setup_minio_bucket.py
```

```bash
./run_delphi.sh --zid=36416
```

This is a Python implementation of the mathematical components of the [Pol.is](https://pol.is) conversation system, converted from the original Clojure codebase.

## Features

- Processes Pol.is conversations using Python-based mathematical algorithms
- Uses DynamoDB for storing intermediate and final results
- Generates interactive and static visualizations for conversations
- Stores visualizations in S3-compatible storage (see [S3_STORAGE.md](S3_STORAGE.md) for details)
