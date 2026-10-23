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
python setup_minio.py
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

## Replaying a published math generation

The math poller does not keep past generations (`math_main` is overwritten on
every tick), but every tick it publishes writes a `math_recompute_log` row with
the exact inputs the engine consumed: how the tick started, the votes the poll
delivered in delivery order, the moderation it read (as deltas), and for a
rebuild a digest of the full vote history it read. `scripts/replay_tick.py`
recomputes any logged tick from those rows and the `votes` table, through the
same `compute_tick` the poller runs (which takes no database handle), and
prints the `math_main` blob (bit for bit, except the wall-clock `math_tick`
field inside it):

```bash
# The blob of tick 1200 of conversation 40523 under the prod label
uv run python scripts/replay_tick.py --zid 40523 --math-env prod --tick 1200

# comment-priorities for every logged tick from 1200 to 1250, as {tick: map}
uv run python scripts/replay_tick.py --zid 40523 --math-env prod \
    --tick 1200 --through 1250 --field comment-priorities
```

Run it inside the image that computed the ticks: every row records its
`engine_version` (the image's git hash), and a tick from another or an unknown
version is refused unless you pass `--allow-engine-mismatch`. It reads
`DATABASE_URL` (or `--database-url`; TLS per `DATABASE_SSL_MODE` or
`--ssl-mode`, default `require`) and writes nothing. Replaying a tick costs
every tick since its chain's last rebuild (no checkpoints yet).

The three start modes in the log: `incremental` (the previous tick's in-memory
state plus the delivered votes and, if read, moderation), `warm_restore` (a
restart, an eviction or a forced rebuild: the previous tick's blob restored,
then the full history) and `cold` (no usable persisted state, or a failed
restore: the full history from scratch). Exit code 3 means the tick cannot be
reproduced and says why. The usual one is a digest refusal: a rebuild tick's
full-history read no longer matches the `votes` table (a vote committed late
with an older `created` that no later tick delivered, or a deleted vote), so
the database no longer holds what that tick saw. Others: another engine
version; a reset tick sequence (`math_ticks` removed, so a tick number now
holds a later generation); a promoted tick under its target label (replay it
under the staged label); ticks published before the log recorded inputs.
Design: `polismath/poller/__init__.py` ("Recording and replay") and
PROPENSITY-LOGGING-DESIGN.md §9.

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
