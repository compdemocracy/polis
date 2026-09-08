#!/usr/bin/env python3
"""
Provider-agnostic topic-cluster naming for the UMAP narrative pipeline.

This module is deliberately kept free of the heavy scientific imports used by
``run_pipeline.py`` (torch, sentence-transformers, umap, datamapplot) so the
naming logic can be unit-tested without them. It depends only on ``numpy`` (for
representative-comment selection) and the LLM provider factory.

Two naming strategies are supported:

* **Anthropic (default)** — all cluster prompts for a layer are collected and
  submitted as a *single* Message Batch; the pipeline polls until the batch
  ends and maps each result back to its cluster by ``custom_id``.
* **Ollama (self-hosted)** — prompts are sent one-by-one, exactly as before.

Provider selection:

* ``LLM_PROVIDER`` env var (default ``anthropic``).
* Anthropic model: ``ANTHROPIC_TOPIC_MODEL`` -> ``ANTHROPIC_MODEL`` ->
  ``DEFAULT_ANTHROPIC_TOPIC_MODEL``.
* Ollama model/host: ``OLLAMA_MODEL`` / ``OLLAMA_HOST`` (as before).

Naming failures never crash the pipeline: an individual failed request falls
back to a generic ``Topic N`` label, and a wholesale failure falls back to the
conventional keyword-based labels.
"""

import logging
import os
import re
from typing import Callable, Dict, List, Optional

import numpy as np

from umap_narrative.llm_factory_constructor.model_provider import get_model_provider

logger = logging.getLogger(__name__)

# Default Anthropic model for topic labels. Overridable via ANTHROPIC_TOPIC_MODEL
# (or ANTHROPIC_MODEL). Kept small/cheap — labels are 3–5 words.
DEFAULT_ANTHROPIC_TOPIC_MODEL = "claude-haiku-4-5-20251001"

# Small cap: labels are a few words. Leaves headroom above the visible text.
TOPIC_MAX_TOKENS = 64

# Prefixes an LLM sometimes prepends to a label; stripped during cleanup.
_PREFIXES_TO_REMOVE = [
    "Here is the list of topic labels:",
    "Here is the list of topic labels",
    "Here are the topic labels:",
    "Here are the topic labels",
    "Here is the topic label:",
    "Here is the topic label",
    "The topic label is:",
    "The topic label is",
    "Topic label:",
    "Here is a concise topic label:",
    "Here's a concise topic label:",
    "Concise topic label:",
    "Topic name:",
    "Topic name",
    "Topic:",
    "Label:",
    "Label",
]


def resolve_provider_type(provider_type: Optional[str] = None) -> str:
    """Resolve the provider type from arg -> LLM_PROVIDER env -> 'anthropic'."""
    return (provider_type or os.environ.get("LLM_PROVIDER") or "anthropic").lower()


def resolve_model_name(provider_type: str) -> Optional[str]:
    """Resolve the model name for the given provider from the environment."""
    if provider_type == "anthropic":
        return (
            os.environ.get("ANTHROPIC_TOPIC_MODEL")
            or os.environ.get("ANTHROPIC_MODEL")
            or DEFAULT_ANTHROPIC_TOPIC_MODEL
        )
    return os.environ.get("OLLAMA_MODEL", "llama3.1:8b")


def build_topic_prompt(comments: List[str]) -> str:
    """Build the single-label topic-naming prompt for a set of comments."""
    prompt = (
        "Read these comments and provide ONLY ONE short topic label (3–5 words) "
        "that captures their combined essence. Do not give one topic per comment. "
        "Do not include explanations, introductions, or multiple outputs. "
        "Reply with exactly one topic label, in quotation marks, on a single line.\n\n"
        "Comments:\n"
    )
    for j, comment in enumerate(comments[:5]):
        prompt += f"{j + 1}. {comment}\n"
    return prompt


def clean_topic_name(raw_response: str, fallback: str) -> str:
    """
    Clean an LLM topic label: strip layer/cluster prefixes, boilerplate
    prefixes, quotes, list markers and markdown; truncate if too long. Returns
    ``fallback`` if the cleaned string is empty.
    """
    if not raw_response:
        return fallback

    raw_response = raw_response.strip()

    # Remove an accidental "1_2:" layer_cluster prefix if the model echoed one.
    layer_prefix_match = re.match(r"^\d+_\d+:\s*", raw_response)
    if layer_prefix_match:
        raw_response = raw_response[layer_prefix_match.end():]

    for prefix in _PREFIXES_TO_REMOVE:
        if raw_response.startswith(prefix):
            raw_response = raw_response.replace(prefix, "", 1)

    raw_response = raw_response.strip()

    # Only the first line is the label.
    topic = raw_response.split("\n")[0].strip()

    # Strip surrounding quotes (single or double).
    topic = topic.strip("\"'")

    # Remove list markers like "1. Topic" or "- Topic".
    if topic.startswith("1. ") or topic.startswith("- "):
        topic = topic[3:].strip()

    # Drop markdown emphasis.
    topic = topic.replace("*", "")

    if not topic or not topic.strip():
        logger.warning(
            f"Empty topic name after cleaning - original response: '{raw_response}'"
        )
        return fallback

    if len(topic) > 50:
        topic = topic[:50] + "..."

    return topic


def select_representative_comments(
    cluster_id: int,
    layer,
    comment_texts: List[str],
    document_map=None,
    limit: int = 5,
) -> List[str]:
    """
    Pick up to ``limit`` comments that best represent a cluster: the ones
    closest to the cluster centroid in 2D document-map space when available,
    otherwise the first ``limit`` members.
    """
    cluster_indices = np.where(np.asarray(layer) == cluster_id)[0]

    if len(cluster_indices) > limit and document_map is not None:
        centroid = np.mean(document_map[cluster_indices], axis=0)
        distances = np.sqrt(
            np.sum((document_map[cluster_indices] - centroid) ** 2, axis=1)
        )
        closest = np.argsort(distances)[:limit]
        selected_indices = cluster_indices[closest].tolist()
    else:
        selected_indices = cluster_indices.tolist()[:limit]

    return [comment_texts[i] for i in selected_indices]


def _prefixed(layer_idx: int, cluster_id: int, cleaned: str) -> str:
    """Apply the unique ``layer_cluster:`` prefix used throughout the pipeline."""
    cleaned = cleaned.strip().strip("\"'")
    if cleaned:
        return f"{layer_idx}_{cluster_id}: {cleaned}"
    return f"{layer_idx}_{cluster_id}:"


def _conventional_labels(cluster_characteristics) -> Dict[int, str]:
    """Keyword/example based labels — the non-LLM fallback."""
    labels: Dict[int, str] = {}
    for cluster_id, characteristics in cluster_characteristics.items():
        top_words = characteristics.get("top_words", [])
        sample_comments = characteristics.get("sample_comments", [])
        label_parts = []
        if len(top_words) > 0:
            label_parts.append("Keywords: " + ", ".join(top_words[:5]))
        if len(sample_comments) > 0:
            first_comment = sample_comments[0]
            if len(first_comment) > 50:
                first_comment = first_comment[:47] + "..."
            label_parts.append("Example: " + first_comment)
        if label_parts:
            label = " | ".join(label_parts)
            if len(label) > 50:
                label = label[:47] + "..."
        else:
            label = f"Topic {cluster_id}"
        labels[cluster_id] = label
    return labels


def _cluster_prompts(
    cluster_characteristics,
    layer,
    comment_texts,
    document_map,
) -> Dict[int, str]:
    """Build a topic prompt for every (non-noise) cluster in the layer."""
    prompts: Dict[int, str] = {}
    for cluster_id in cluster_characteristics.keys():
        if cluster_id < 0:  # Skip noise points.
            continue
        comments = select_representative_comments(
            cluster_id, layer, comment_texts, document_map
        )
        prompts[cluster_id] = build_topic_prompt(comments)
    return prompts


def _label_via_batch(
    provider,
    prompts: Dict[int, str],
    layer_idx: int,
    max_wait_seconds: float,
    sleep: Callable[[float], None],
) -> Dict[int, str]:
    """
    Name all clusters in one Anthropic Message Batch. Returns raw (uncleaned)
    label text keyed by cluster_id; a cluster maps to ``None`` if its request
    failed (errored/refused/missing) so the caller can substitute a fallback.
    """
    custom_id_to_cluster: Dict[str, int] = {}
    batch_requests = []
    for cluster_id, prompt in prompts.items():
        custom_id = f"layer{layer_idx}_cluster{cluster_id}"
        custom_id_to_cluster[custom_id] = cluster_id
        batch_requests.append(
            {
                "custom_id": custom_id,
                "params": {
                    "model": provider.model_name,
                    "max_tokens": TOPIC_MAX_TOKENS,
                    "messages": [{"role": "user", "content": prompt}],
                },
            }
        )

    created = provider.get_batch_responses(batch_requests)
    if not isinstance(created, dict) or created.get("error") or not created.get("id"):
        raise RuntimeError(f"Batch creation failed: {created}")

    batch_id = created["id"]
    final = provider.poll_batch(
        batch_id, max_wait_seconds=max_wait_seconds, sleep=sleep
    )
    records = provider.get_batch_results(final)

    raw_labels: Dict[int, Optional[str]] = {cid: None for cid in prompts}
    for record in records:
        cluster_id = custom_id_to_cluster.get(record.get("custom_id"))
        if cluster_id is None:
            continue
        raw_labels[cluster_id] = provider.extract_text_from_result(record)
    return raw_labels


def _label_one_by_one(provider, prompts: Dict[int, str]) -> Dict[int, Optional[str]]:
    """Name clusters sequentially (Ollama path)."""
    raw_labels: Dict[int, Optional[str]] = {}
    for cluster_id, prompt in prompts.items():
        try:
            raw_labels[cluster_id] = provider.get_response("", prompt)
        except Exception as e:  # noqa: BLE001 - never crash on a single label.
            logger.error(f"Error naming cluster {cluster_id}: {e}")
            raw_labels[cluster_id] = None
    return raw_labels


def generate_cluster_topic_labels(
    cluster_characteristics,
    comment_texts=None,
    layer=None,
    layer_idx=0,
    conversation_name=None,
    name_topics=False,
    document_map=None,
    provider_type=None,
    max_wait_seconds: Optional[float] = None,
    sleep: Callable[[float], None] = None,
    use_ollama=False,  # Deprecated alias — forces the ollama provider.
):
    """
    Generate topic labels for clusters.

    When ``name_topics`` is truthy and comments/layer are available, labels are
    produced by an LLM (Anthropic batch by default, or Ollama when
    ``LLM_PROVIDER=ollama`` / the deprecated ``use_ollama=True``). Otherwise, and
    on any LLM failure, conventional keyword-based labels are returned.

    Returns a dict mapping cluster_id -> topic label string.
    """
    if use_ollama:
        # Backwards-compatible alias: force the ollama provider for this call.
        provider_type = "ollama"
        name_topics = True

    if not (name_topics and comment_texts is not None and layer is not None):
        return _conventional_labels(cluster_characteristics)

    provider_type = resolve_provider_type(provider_type)

    if max_wait_seconds is None:
        max_wait_seconds = float(
            os.environ.get("TOPIC_BATCH_MAX_WAIT_SECONDS", "1800")
        )
    if sleep is None:
        import time as _time

        sleep = _time.sleep

    try:
        model_name = resolve_model_name(provider_type)
        provider = get_model_provider(provider_type, model_name)
        prompts = _cluster_prompts(
            cluster_characteristics, layer, comment_texts, document_map
        )

        if not prompts:
            return _conventional_labels(cluster_characteristics)

        if provider.supports_batching:
            logger.info(
                f"Naming {len(prompts)} clusters in layer {layer_idx} via one "
                f"{provider_type} batch (model={model_name})"
            )
            raw_labels = _label_via_batch(
                provider, prompts, layer_idx, max_wait_seconds, sleep
            )
        else:
            logger.info(
                f"Naming {len(prompts)} clusters in layer {layer_idx} one-by-one "
                f"via {provider_type} (model={model_name})"
            )
            raw_labels = _label_one_by_one(provider, prompts)

        cluster_labels: Dict[int, str] = {}
        for cluster_id in prompts:
            raw = raw_labels.get(cluster_id)
            fallback = f"Topic {cluster_id}"
            cleaned = clean_topic_name(raw, fallback) if raw else fallback
            cluster_labels[cluster_id] = _prefixed(layer_idx, cluster_id, cleaned)

        logger.info(
            f"Generated {len(cluster_labels)} topic names for layer {layer_idx} "
            f"using {provider_type}"
        )
        return cluster_labels

    except Exception as e:  # noqa: BLE001 - naming must never crash the pipeline.
        logger.error(
            f"LLM topic naming failed for layer {layer_idx} ({e}); "
            "falling back to conventional labels",
            exc_info=True,
        )
        return _conventional_labels(cluster_characteristics)
