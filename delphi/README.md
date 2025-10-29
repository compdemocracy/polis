# Pol.is Math (Python Implementation)

This is a Python implementation of the mathematical components of the [Pol.is](https://pol.is) conversation system, converted from the original Clojure codebase.

## Quick Development Setup

For the fastest development environment setup:

```bash
# One-command setup (recommended)
./setup_dev.sh
```

This will create the canonical `delphi-env` virtual environment, install all dependencies, and set up development tools.

## Manual Development Setup

If you prefer manual setup:

```bash
# Create canonical virtual environment
python3 -m venv delphi-env
source delphi-env/bin/activate

# Install with development dependencies
pip install -e ".[dev,notebook]"

# Set up pre-commit hooks
pre-commit install
```

## Production/Docker Quickstart

For production or containerized usage:

from parent directory (e.g. $HOME/polis/),

```bash
make DETACH=true start
```

or with production environment:

```bash
make PROD DETACH=true start
```

```bash
docker exec polis-dev-delphi-1 python /app/create_dynamodb_tables.py --endpoint-url=http://dynamodb-local:8000
```

```bash
# Set up the MinIO bucket for visualization storage
python setup_minio.py
```

```bash
./run_delphi.py --zid=36416
```

## Features

- Processes Pol.is conversations using Python-based mathematical algorithms
- Uses DynamoDB for storing intermediate and final results
- Generates interactive and static visualizations for conversations
- Stores visualizations in S3-compatible storage (see [S3_STORAGE.md](S3_STORAGE.md) for details)
