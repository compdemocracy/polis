"""
Unit tests for provider-agnostic topic naming.

The provider factory is mocked with fake providers so no network or API key is
needed. Covers: batch request construction (one custom_id per cluster), mapping
results back to the right clusters, partial failures, the label cleanup, the
ollama (non-batch) path, and conventional fallback.
"""

import numpy as np
import pytest

from umap_narrative import topic_naming
from umap_narrative.topic_naming import (
    build_topic_prompt,
    clean_topic_name,
    generate_cluster_topic_labels,
    resolve_model_name,
    resolve_provider_type,
    select_representative_comments,
)


# --- provider resolution ---------------------------------------------------

def test_resolve_provider_default_anthropic(monkeypatch):
    monkeypatch.delenv("LLM_PROVIDER", raising=False)
    assert resolve_provider_type() == "anthropic"


def test_resolve_provider_env(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "OLLAMA")
    assert resolve_provider_type() == "ollama"


def test_resolve_model_precedence(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_TOPIC_MODEL", raising=False)
    monkeypatch.delenv("ANTHROPIC_MODEL", raising=False)
    assert resolve_model_name("anthropic") == topic_naming.DEFAULT_ANTHROPIC_TOPIC_MODEL
    monkeypatch.setenv("ANTHROPIC_MODEL", "claude-x")
    assert resolve_model_name("anthropic") == "claude-x"
    monkeypatch.setenv("ANTHROPIC_TOPIC_MODEL", "claude-topic")
    assert resolve_model_name("anthropic") == "claude-topic"


# --- cleanup ---------------------------------------------------------------

@pytest.mark.parametrize(
    "raw,expected",
    [
        ('"Traffic Safety"', "Traffic Safety"),
        ("Topic label: Housing Costs", "Housing Costs"),
        ("1_2: Public Transit", "Public Transit"),
        ("- **Climate Policy**", "Climate Policy"),
        ("First line here\nsecond line", "First line here"),
    ],
)
def test_clean_topic_name(raw, expected):
    assert clean_topic_name(raw, "fallback") == expected


def test_clean_topic_name_empty_uses_fallback():
    assert clean_topic_name("   ", "Topic 3") == "Topic 3"
    assert clean_topic_name("", "Topic 3") == "Topic 3"


def test_build_prompt_caps_at_five_comments():
    prompt = build_topic_prompt([f"c{i}" for i in range(10)])
    assert "1. c0" in prompt and "5. c4" in prompt
    assert "6. c5" not in prompt


# --- representative comment selection --------------------------------------

def test_select_representative_uses_centroid():
    layer = np.array([0, 0, 0, 0, 0, 1])
    document_map = np.array(
        [[0, 0], [0.1, 0], [10, 10], [11, 11], [12, 12], [0, 0]], dtype=float
    )
    comments = [f"c{i}" for i in range(6)]
    chosen = select_representative_comments(0, layer, comments, document_map, limit=2)
    # The two closest to the cluster-0 centroid should be selected.
    assert set(chosen).issubset(set(comments[:5]))
    assert len(chosen) == 2


def test_select_representative_no_map_takes_first():
    layer = np.array([0, 0, 0, 1])
    comments = ["a", "b", "c", "d"]
    assert select_representative_comments(0, layer, comments, None, limit=2) == ["a", "b"]


# --- fake providers --------------------------------------------------------

class FakeAnthropicProvider:
    supports_batching = True

    def __init__(self, results, model_name="claude-haiku-4-5-20251001", fail_create=False):
        self.model_name = model_name
        self._results = results
        self._fail_create = fail_create
        self.created_requests = None

    def get_batch_responses(self, batch_requests):
        self.created_requests = batch_requests
        if self._fail_create:
            return {"error": "boom"}
        return {"id": "batch_1", "processing_status": "in_progress"}

    def poll_batch(self, batch_id, max_wait_seconds=1800, sleep=None):
        return {"processing_status": "ended", "results_url": "https://x"}

    def get_batch_results(self, batch):
        return self._results

    @staticmethod
    def extract_text_from_result(record):
        from umap_narrative.llm_factory_constructor.model_provider import AnthropicProvider
        return AnthropicProvider.extract_text_from_result(record)


class FakeOllamaProvider:
    supports_batching = False

    def __init__(self, mapping, model_name="llama3.1:8b"):
        self.model_name = model_name
        self._mapping = mapping
        self.prompts_seen = []

    def get_response(self, system_message, user_message):
        self.prompts_seen.append(user_message)
        # Return based on which cluster's prompt this is.
        for key, val in self._mapping.items():
            if key in user_message:
                return val
        return "Generic"


def _characteristics(ids):
    return {i: {"top_words": [f"w{i}"], "sample_comments": [f"sample {i}"]} for i in ids}


# --- batch path ------------------------------------------------------------

def test_batch_path_maps_results_to_clusters(monkeypatch):
    # Two clusters; results returned out of order.
    results = [
        {"custom_id": "layer0_cluster1", "result": {"type": "succeeded", "message": {"content": [{"type": "text", "text": '"Housing"'}]}}},
        {"custom_id": "layer0_cluster0", "result": {"type": "succeeded", "message": {"content": [{"type": "text", "text": '"Traffic"'}]}}},
    ]
    provider = FakeAnthropicProvider(results)
    monkeypatch.setattr(topic_naming, "get_model_provider", lambda *a, **k: provider)

    layer = np.array([0, 0, 1, 1])
    comments = ["a", "b", "c", "d"]
    labels = generate_cluster_topic_labels(
        _characteristics([0, 1]),
        comment_texts=comments,
        layer=layer,
        layer_idx=0,
        name_topics=True,
    )

    # One request per cluster, custom_id per cluster.
    assert {r["custom_id"] for r in provider.created_requests} == {"layer0_cluster0", "layer0_cluster1"}
    # Correct mapping despite out-of-order results, with layer_cluster prefix.
    assert labels[0] == "0_0: Traffic"
    assert labels[1] == "0_1: Housing"


def test_batch_partial_failure_uses_fallback_label(monkeypatch):
    results = [
        {"custom_id": "layer0_cluster0", "result": {"type": "succeeded", "message": {"content": [{"type": "text", "text": "Good Label"}]}}},
        {"custom_id": "layer0_cluster1", "result": {"type": "errored", "error": {"type": "server_error"}}},
        # cluster 2 missing entirely from results.
    ]
    provider = FakeAnthropicProvider(results)
    monkeypatch.setattr(topic_naming, "get_model_provider", lambda *a, **k: provider)

    layer = np.array([0, 1, 2])
    labels = generate_cluster_topic_labels(
        _characteristics([0, 1, 2]),
        comment_texts=["a", "b", "c"],
        layer=layer,
        layer_idx=0,
        name_topics=True,
    )
    assert labels[0] == "0_0: Good Label"
    assert labels[1] == "0_1: Topic 1"   # errored -> fallback
    assert labels[2] == "0_2: Topic 2"   # missing -> fallback


def test_batch_creation_failure_falls_back_to_conventional(monkeypatch):
    provider = FakeAnthropicProvider([], fail_create=True)
    monkeypatch.setattr(topic_naming, "get_model_provider", lambda *a, **k: provider)

    labels = generate_cluster_topic_labels(
        _characteristics([0]),
        comment_texts=["a"],
        layer=np.array([0]),
        layer_idx=0,
        name_topics=True,
    )
    # Conventional fallback: keyword-based, no "0_0:" prefix.
    assert "Keywords" in labels[0]


# --- ollama path -----------------------------------------------------------

def test_ollama_path_selected_and_sequential(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "ollama")
    provider = FakeOllamaProvider({"sampleA": "\"Label A\""})
    captured = {}

    def fake_factory(provider_type, model_name):
        captured["provider_type"] = provider_type
        return provider

    monkeypatch.setattr(topic_naming, "get_model_provider", fake_factory)

    # Comment text 'sampleA' distinguishes cluster 0's prompt.
    layer = np.array([0])
    labels = generate_cluster_topic_labels(
        _characteristics([0]),
        comment_texts=["sampleA text"],
        layer=layer,
        layer_idx=0,
        name_topics=True,
    )
    assert captured["provider_type"] == "ollama"
    assert labels[0] == "0_0: Label A"
    assert provider.prompts_seen  # went through the one-by-one path


def test_use_ollama_alias_forces_ollama(monkeypatch):
    monkeypatch.delenv("LLM_PROVIDER", raising=False)
    provider = FakeOllamaProvider({})
    captured = {}

    def fake_factory(provider_type, model_name):
        captured["provider_type"] = provider_type
        return provider

    monkeypatch.setattr(topic_naming, "get_model_provider", fake_factory)
    generate_cluster_topic_labels(
        _characteristics([0]),
        comment_texts=["x"],
        layer=np.array([0]),
        layer_idx=0,
        use_ollama=True,  # deprecated alias
    )
    assert captured["provider_type"] == "ollama"


# --- naming disabled -------------------------------------------------------

def test_name_topics_false_returns_conventional():
    labels = generate_cluster_topic_labels(
        _characteristics([0, 1]),
        comment_texts=["a", "b"],
        layer=np.array([0, 1]),
        name_topics=False,
    )
    assert all("Keywords" in v for v in labels.values())
