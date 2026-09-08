"""
Unit tests for the Anthropic Message Batches helpers on AnthropicProvider.

The HTTP layer (``requests``) is fully mocked, so no network access or API key
is needed. These cover the create -> poll -> results flow and result parsing.
"""

import json
from unittest import mock

import pytest

from umap_narrative.llm_factory_constructor.model_provider import (
    AnthropicProvider,
    get_model_provider,
)


class FakeResponse:
    def __init__(self, *, json_data=None, text=None, status_code=200):
        self._json = json_data
        self.text = text if text is not None else ""
        self.status_code = status_code

    def json(self):
        return self._json

    def raise_for_status(self):
        if self.status_code >= 400:
            raise AssertionError(f"HTTP {self.status_code}")


def make_provider():
    return AnthropicProvider(model_name="claude-haiku-4-5-20251001", api_key="sk-test")


def test_provider_supports_batching():
    assert make_provider().supports_batching is True


def test_get_batch_responses_posts_to_batches_endpoint():
    provider = make_provider()
    captured = {}

    def fake_post(url, headers=None, json=None):
        captured["url"] = url
        captured["json"] = json
        return FakeResponse(json_data={"id": "batch_123", "processing_status": "in_progress"})

    batch_requests = [
        {"custom_id": "layer0_cluster0", "params": {"messages": [{"role": "user", "content": "p0"}], "max_tokens": 64}},
        {"custom_id": "layer0_cluster1", "params": {"messages": [{"role": "user", "content": "p1"}], "max_tokens": 64}},
    ]

    with mock.patch("umap_narrative.llm_factory_constructor.model_provider.requests.post", side_effect=fake_post):
        result = provider.get_batch_responses(batch_requests)

    # Correct (plural) endpoint, not the singular ".../batch".
    assert captured["url"] == "https://api.anthropic.com/v1/messages/batches"
    # One request per cluster, each with a custom_id and the model injected.
    reqs = captured["json"]["requests"]
    assert [r["custom_id"] for r in reqs] == ["layer0_cluster0", "layer0_cluster1"]
    assert all(r["params"]["model"] == "claude-haiku-4-5-20251001" for r in reqs)
    assert result["id"] == "batch_123"


def test_get_batch_responses_without_api_key_returns_error():
    provider = AnthropicProvider(model_name="claude-haiku-4-5-20251001", api_key=None)
    provider.api_key = None
    result = provider.get_batch_responses([{"custom_id": "a", "params": {}}])
    assert "error" in result


def test_poll_batch_polls_until_ended():
    provider = make_provider()
    responses = [
        {"processing_status": "in_progress", "request_counts": {"processing": 2}},
        {"processing_status": "in_progress", "request_counts": {"processing": 1}},
        {"processing_status": "ended", "results_url": "https://x/results", "request_counts": {"succeeded": 2}},
    ]
    calls = {"n": 0}

    def fake_get(url, headers=None):
        r = responses[calls["n"]]
        calls["n"] += 1
        return FakeResponse(json_data=r)

    slept = []
    with mock.patch("umap_narrative.llm_factory_constructor.model_provider.requests.get", side_effect=fake_get):
        final = provider.poll_batch("batch_123", initial_interval=1, sleep=slept.append)

    assert final["processing_status"] == "ended"
    assert final["results_url"] == "https://x/results"
    assert calls["n"] == 3
    # Backoff doubled between the two waits (1s then 2s).
    assert slept == [1, 2]


def test_poll_batch_times_out():
    provider = make_provider()

    def fake_get(url, headers=None):
        return FakeResponse(json_data={"processing_status": "in_progress"})

    # Fake clock that jumps past the deadline on the first check.
    clock = {"t": 0.0}

    def fake_now():
        clock["t"] += 10_000
        return clock["t"]

    with mock.patch("umap_narrative.llm_factory_constructor.model_provider.requests.get", side_effect=fake_get):
        with pytest.raises(TimeoutError):
            provider.poll_batch("batch_123", max_wait_seconds=1, sleep=lambda s: None, now=fake_now)


def test_get_batch_results_parses_jsonl():
    provider = make_provider()
    lines = [
        json.dumps({"custom_id": "layer0_cluster0", "result": {"type": "succeeded", "message": {"content": [{"type": "text", "text": "\"Traffic Safety\""}]}}}),
        "",  # blank line ignored
        json.dumps({"custom_id": "layer0_cluster1", "result": {"type": "errored", "error": {"type": "invalid_request"}}}),
    ]

    def fake_get(url, headers=None):
        assert url == "https://x/results"
        return FakeResponse(text="\n".join(lines))

    with mock.patch("umap_narrative.llm_factory_constructor.model_provider.requests.get", side_effect=fake_get):
        records = provider.get_batch_results({"results_url": "https://x/results"})

    assert len(records) == 2
    assert records[0]["custom_id"] == "layer0_cluster0"


def test_extract_text_from_result():
    ok = {"result": {"type": "succeeded", "message": {"content": [{"type": "text", "text": "hello"}]}}}
    errored = {"result": {"type": "errored", "error": {}}}
    refused = {"result": {"type": "succeeded", "message": {"stop_reason": "refusal", "content": []}}}
    assert AnthropicProvider.extract_text_from_result(ok) == "hello"
    assert AnthropicProvider.extract_text_from_result(errored) is None
    assert AnthropicProvider.extract_text_from_result(refused) is None


def test_factory_selects_ollama_and_anthropic(monkeypatch):
    monkeypatch.setenv("OLLAMA_MODEL", "llama3.1:8b")
    ollama = get_model_provider("ollama")
    assert ollama.supports_batching is False

    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    anthropic = get_model_provider("anthropic", "claude-haiku-4-5-20251001")
    assert anthropic.supports_batching is True
