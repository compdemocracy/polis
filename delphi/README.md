# Pol.is Math (Python Implementation)

## Local Python development

Run locally (outside Docker) with either `make` or `uv`:

```bash
# Option A: make + pip
cd delphi
make venv                # Creates delphi/.venv + a polis/.venv symlink for editor discovery
source .venv/bin/activate
make install-dev         # Installs delphi with dev + notebook extras

# Option B: uv (faster, locked deps)
cd delphi
uv sync                  # Creates delphi/.venv with all dependencies
ln -sfn delphi/.venv ../.venv   # One-time, for editor discovery at the repo root
```

**Why two `.venv` paths?** Pyright (configured in `delphi/pyproject.toml`)
looks for the venv at `delphi/.venv`, but editors and IDEs (VS Code, Cursor,
Claude Code, JetBrains) opening the workspace at the repo root look for
`polis/.venv`. Both must exist — either as the real venv directory or as a
symlink to it. `make venv` creates both; the `uv` path needs the one-time
symlink. If your editor's language server reports "missing imports" for
`numpy`, `polismath`, etc., this is the usual cause.

If you have a leftover `delphi-env/` from before the rename, adopt it without
reinstalling: `ln -sfn delphi-env delphi/.venv`.

For a full walkthrough (tests, real data, system tests), see
[`docs/QUICK_START.md`](docs/QUICK_START.md).

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

## Topic-cluster naming (LLM provider)

Topic-cluster labels (the short 3–5 word names for each cluster) are generated
by an LLM. The provider is selected with environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `LLM_PROVIDER` | `anthropic` | `anthropic` (Batch API) or `ollama` (self-hosted GPU) |
| `ANTHROPIC_TOPIC_MODEL` | `claude-haiku-4-5-20251001` | Anthropic model; falls back to `ANTHROPIC_MODEL` |
| `ANTHROPIC_API_KEY` | — | Required when `LLM_PROVIDER=anthropic` |
| `TOPIC_BATCH_MAX_WAIT_SECONDS` | `1800` | Max wait for a naming batch before falling back to generic labels |
| `OLLAMA_MODEL` / `OLLAMA_HOST` | `llama3.1:8b` / `http://ollama:11434` | Only used when `LLM_PROVIDER=ollama` |

**Anthropic (default):** all cluster prompts for a layer are submitted as one
Anthropic Message Batch and polled until complete. Naming never crashes the
pipeline — a failed request falls back to a generic `Topic N` label, and a
wholesale failure falls back to conventional keyword labels.

Enable topic naming with `run_pipeline.py --name-topics` (the deprecated
`--use-ollama` flag still works and forces `LLM_PROVIDER=ollama`).

**Re-enabling the self-hosted Ollama GPU stack:** the GPU infrastructure is
turned off by default to save cost, but the self-hosted LLM path remains
supported. To bring it back:

1. Deploy the CDK stack with `CDK_ENABLE_OLLAMA=true` (recreates the ASG, GPU
   launch template, EFS, internal NLB and the `/polis/ollama-service-url`
   secret — the EFS model volume is `RETAIN`, so the model file survives).
2. Set `LLM_PROVIDER=ollama` (plus `OLLAMA_MODEL` / `OLLAMA_HOST`) in the
   Delphi environment.
