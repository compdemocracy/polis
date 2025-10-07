# Topic Naming (LLM) – How it works

## Overview

The topic naming feature assigns a short, human‑readable label to each comment cluster. It runs after UMAP projection and hierarchical clustering have produced clusters for each layer. Labels are generated with an LLM (Ollama in this environment) using a small, representative sample of comments from each cluster.

## Pipeline prerequisites

- UMAP projection and hierarchical clustering must be completed for the conversation (produces `cluster_layers`).
- Topic naming runs per layer/cluster and is invoked from `generate_cluster_topic_labels` in `umap_narrative/run_pipeline.py` when the Ollama path is enabled.

## LLM provider

- Provider: Ollama.
- Model: controlled by env var `OLLAMA_MODEL` (default `llama3.1:8b`).

## Prompt text (exact)

This is the exact prompt currently sent to the LLM for a given cluster’s sampled comments:

```text
Read these comments and provide ONLY ONE short topic label (3–5 words) that captures their combined essence. Do not give one topic per comment. Do not include explanations, introductions, or multiple outputs. Reply with exactly one topic label, in quotation marks, on a single line.

Comments:
1. …
2. …
3. …
4. …
5. …
```

The 1–5 comment items are filled by the sampling strategy below.

## Sampling strategy (deterministic pseudo‑random 5)

- For each (conversation, `layer_idx`, `cluster_id`) we select up to 5 comments from that cluster.
- If a cluster has 5 or fewer comments, we use all of them.
- If it has more than 5, we sample 5 using a deterministic seed so results are reproducible across runs:
  - Seed = `SHA1("{conversation_name}|{layer_idx}|{cluster_id}")`, reduced to a 32‑bit integer.
  - A `random.Random(seed)` instance samples 5 comment indices from the cluster.

Rationale: avoids bias from “first N” comments, while keeping runs reproducible (important for debugging and auditability).

## Name cleanup

After receiving the model’s response:

- Remove common prefixes (e.g., “Topic label:”, “Label:”, etc.).
- Take the first line only; trim quotes and markdown asterisks.
- Truncate to 50 chars if overly long.

## Storage

Generated names are stored in DynamoDB table `Delphi_CommentClustersLLMTopicNames` with metadata including:

- `conversation_id`
- `layer_id`, `cluster_id`
- `topic_name`
- `model_name` (Ollama model used)
- `created_at`
- `job_id` (when run via job system)

These names are later consumed by visualization and reporting layers.

## Running it

- Full job pipeline (UI/CLI): choose “Full Pipeline” and ensure topic naming/reporting is enabled.
- “Report only”: will generate topic names if clustering (UMAP+layers) already exists for the conversation.

## Configuration quick reference

- `OLLAMA_MODEL`: model name (default `llama3.1:8b`).
- Sampling is deterministic by `(conversation_name, layer_idx, cluster_id)` and not user‑configurable; change the conversation name or the cluster structure to alter the sample deterministically.

## Future improvements

- Weighted sampling by cluster representativeness or centroid proximity.
- Language detection and multilingual prompt variants.
- Confidence/quality metrics for names and optional re‑rolls.
- Consider alternate LLM providers (eg. Gemma3, Mistral, etc.)
