"""
What the topic-naming step stores, end to end through the pipeline's storage.

Postgres mode runs against the real attempt writer (WriterResource, the SQLite
scratch the daemon turns into a result spool); DynamoDB mode against a storage
that records what it was given. The provider is a stand-in, so no network or API
key is needed. A naming run must store the provider's names under the provider's
model; when the provider fails, the run must fail and store nothing, never
keyword labels under the model's name.
"""

import importlib
import json
import uuid
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

from umap_narrative import topic_naming

FAMILY = "Delphi_CommentClustersLLMTopicNames"
MODEL = "stand-in-topic-model"
COMMENTS = ["fix the potholes", "more crosswalks", "rent is too high", "build more homes"]
LAYER = np.array([0, 0, 1, 1])
DOCUMENT_MAP = np.array([[0, 0], [0.1, 0], [5, 5], [5.1, 5]], dtype=float)
CHARACTERISTICS = {
    0: {"top_words": ["potholes", "crosswalks"], "sample_comments": ["fix the potholes"]},
    1: {"top_words": ["rent", "homes"], "sample_comments": ["rent is too high"]},
}


def _succeeded(custom_id, text):
    return {"custom_id": custom_id,
            "result": {"type": "succeeded", "message": {"content": [{"type": "text", "text": text}]}}}


class StandInProvider:
    """The batch provider's surface: create, poll, fetch results."""

    supports_batching = True

    def __init__(self, failure=None, results=None):
        self.model_name = MODEL
        self.failure = failure
        self.results = results if results is not None else [
            _succeeded("layer0_cluster0", '"Street Safety"'),
            _succeeded("layer0_cluster1", '"Housing Costs"'),
        ]
        self.requests = None

    def get_batch_responses(self, batch_requests):
        self.requests = batch_requests
        if self.failure == "create":
            return {"error": "API key missing"}
        return {"id": "msgbatch_standin", "processing_status": "in_progress"}

    def poll_batch(self, batch_id, max_wait_seconds=1800, sleep=None):
        if self.failure == "poll":
            raise TimeoutError(f"Batch {batch_id} did not complete within {max_wait_seconds}s")
        return {"id": batch_id, "processing_status": "ended",
                "results_url": "https://api.anthropic.com/v1/messages/batches/msgbatch_standin/results"}

    def get_batch_results(self, batch):
        if self.failure == "results":
            raise ValueError("Batch results URL redirected; refusing to follow with credentials")
        return self.results

    @staticmethod
    def extract_text_from_result(record):
        from umap_narrative.llm_factory_constructor.model_provider import AnthropicProvider
        return AnthropicProvider.extract_text_from_result(record)


@pytest.fixture(scope="module")
def pipeline():
    narrative_dir = Path(__file__).resolve().parents[2] / "umap_narrative"
    with pytest.MonkeyPatch.context() as patch:
        patch.syspath_prepend(str(narrative_dir))
        patch.setenv("MPLBACKEND", "Agg")
        yield importlib.import_module("umap_narrative.run_pipeline")


@pytest.fixture
def attempt(tmp_path, monkeypatch):
    """A bound Postgres-mode queue attempt with an empty writer base."""
    jid, run, att = [str(uuid.uuid4()) for _ in range(3)]
    frame = dict(schema="polis-jobs.frame/1", env="proof", zid=1, job_id=jid, run_id=run, attempt_id=att,
                 lease_epoch="1", config={"result_backend": "postgres"},
                 writer_base={"schema": "delphi-writer-base/1", "zid": 1, "families": {}})
    (tmp_path / "frame.json").write_text(json.dumps(frame))
    for key, value in dict(DELPHI_RESULT_BACKEND="postgres", DELPHI_OUTPUT_MANIFEST=str(tmp_path / "manifest.json"),
                           DELPHI_FRAME=str(tmp_path / "frame.json"), DELPHI_JOB_ID=jid, DELPHI_RUN_ID=run,
                           DELPHI_ATTEMPT_ID=att).items():
        monkeypatch.setenv(key, value)
    import boto3
    monkeypatch.setattr(boto3, "resource", lambda *a, **k: pytest.fail("DynamoDB resource created"))
    from polismath.delphi_storage.writer import WriterResource
    writer = WriterResource()
    writer.reset()  # what run_delphi.py does before the pipeline in Postgres mode
    return SimpleNamespace(writer=writer, job_id=jid)


class RecordingStorage:
    """DynamoDB mode: every topic-name write the step makes."""

    def __init__(self):
        self.written = []

    def batch_create_llm_topic_names(self, models):
        self.written.extend(models)
        return {"success": len(models), "failure": 0}


def _name_topics(pipeline, monkeypatch, tmp_path, provider, storage, job_id="job-1"):
    monkeypatch.setenv("LLM_PROVIDER", "anthropic")
    monkeypatch.setenv("ANTHROPIC_TOPIC_MODEL", MODEL)
    monkeypatch.setattr(topic_naming, "get_model_provider", lambda *a, **k: provider)
    monkeypatch.setattr(pipeline, "process_layers_and_store_characteristics",
                        lambda *a, **k: {0: {"characteristics": CHARACTERISTICS}})
    monkeypatch.setattr(pipeline, "create_visualizations", lambda *a, **k: str(tmp_path / "index.html"))
    return pipeline.process_layers_and_create_visualizations(
        "1", "Streets and homes", DOCUMENT_MAP, [LAYER], COMMENTS, str(tmp_path),
        name_topics=True, dynamo_storage=storage, job_id=job_id)


def _stored(attempt):
    from polismath.delphi_storage.resource import result_resource
    return result_resource().Table(FAMILY).scan()["Items"]


def test_postgres_run_stores_the_providers_names(pipeline, attempt, tmp_path, monkeypatch):
    from polismath_commentgraph.utils.storage import DynamoDBStorage
    provider = StandInProvider()
    _name_topics(pipeline, monkeypatch, tmp_path, provider, DynamoDBStorage(), attempt.job_id)
    rows = _stored(attempt)
    assert sorted(r["topic_name"] for r in rows) == ["0_0: Street Safety", "0_1: Housing Costs"]
    assert {r["model_name"] for r in rows} == {MODEL}
    assert len(provider.requests) == 2
    # The family reaches the spool the daemon publishes, with the same names.
    from polismath.delphi_storage.codec import decode_family
    files = attempt.writer.spool()
    _, spooled = decode_family((attempt.writer.directory / files[FAMILY]["file"]).read_bytes())
    assert sorted(r["topic_name"]["S"] for r in spooled) == ["0_0: Street Safety", "0_1: Housing Costs"]


@pytest.mark.parametrize("failure", ["create", "poll", "results"])
def test_postgres_run_with_a_failed_provider_fails_and_stores_nothing(pipeline, attempt, tmp_path, monkeypatch, failure):
    from polismath_commentgraph.utils.storage import DynamoDBStorage
    with pytest.raises(RuntimeError, match="topic naming failed"):
        _name_topics(pipeline, monkeypatch, tmp_path, StandInProvider(failure), DynamoDBStorage(), attempt.job_id)
    rows = _stored(attempt)
    assert not [r for r in rows if r["topic_name"].startswith("Keywords:")]
    assert rows == []


def test_postgres_run_where_every_request_errored_fails_and_stores_nothing(pipeline, attempt, tmp_path, monkeypatch):
    from polismath_commentgraph.utils.storage import DynamoDBStorage
    errored = [{"custom_id": f"layer0_cluster{c}", "result": {"type": "errored", "error": {"type": "invalid_request"}}}
               for c in (0, 1)]
    with pytest.raises(RuntimeError, match="topic naming failed"):
        _name_topics(pipeline, monkeypatch, tmp_path, StandInProvider(results=errored), DynamoDBStorage(),
                     attempt.job_id)
    assert _stored(attempt) == []


def test_dynamodb_run_with_a_failed_provider_fails_and_writes_nothing(pipeline, tmp_path, monkeypatch):
    storage = RecordingStorage()
    with pytest.raises(RuntimeError, match="topic naming failed"):
        _name_topics(pipeline, monkeypatch, tmp_path, StandInProvider("create"), storage)
    assert storage.written == []


def test_dynamodb_run_stores_the_providers_names(pipeline, tmp_path, monkeypatch):
    storage = RecordingStorage()
    _name_topics(pipeline, monkeypatch, tmp_path, StandInProvider(), storage)
    assert sorted(m.topic_name for m in storage.written) == ["0_0: Street Safety", "0_1: Housing Costs"]
    assert {m.model_name for m in storage.written} == {MODEL}
