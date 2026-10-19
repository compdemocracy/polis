"""Narrative preparation keeps every topic section in both result backends.

Generated rows only: no votes, no database server and no provider call. In
Postgres mode the generator reads through the attempt writer that a bound
polis-jobs attempt selects (a SQLite scratchpad that only the thread which
opened it may use); in DynamoDB mode it reads through boto3's resource, here an
in-memory stand-in. The conversation, comment and math_main reads are stand-ins
in both modes.
"""
import asyncio
import importlib
import json
import logging
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace

import pytest

from polismath.delphi_storage.codec import item_from_python

DELPHI_ROOT = Path(__file__).resolve().parents[1]
ZID = 1
JOB_ID = "00000000-0000-4000-8000-000000000801"
RUN_ID = "00000000-0000-4000-8000-000000000802"
ATTEMPT_ID = "00000000-0000-4000-8000-000000000803"
TOPIC_JOB = "00000000-0000-4000-8000-000000000700"
TOPIC_KEYS = [f"{TOPIC_JOB}#0#0", f"{TOPIC_JOB}#0#1"]
GLOBAL_KEYS = [f"{JOB_ID}_global_{name}" for name in ("groups", "group_informed_consensus", "uncertainty")]
CLUSTER_FAMILY = "Delphi_CommentHierarchicalClusterAssignments"

# Four comments in two layer-0 topics, with the topic names and keywords: the
# rows the topic stage leaves for the narrative stage to read.
RESULT_ROWS = {
    CLUSTER_FAMILY: [
        {"conversation_id": "1", "comment_id": Decimal(tid), "layer0_cluster_id": Decimal(cluster)}
        for tid, cluster in ((1, 0), (2, 0), (3, 1), (4, 1))
    ],
    "Delphi_CommentClustersLLMTopicNames": [
        {"conversation_id": "1", "topic_key": key, "layer_id": Decimal(0), "cluster_id": Decimal(cluster),
         "topic_name": f"Generated topic {cluster}"}
        for cluster, key in enumerate(TOPIC_KEYS)
    ],
    "Delphi_CommentClustersStructureKeywords": [
        {"conversation_id": "1", "cluster_key": f"layer0_{cluster}",
         "sample_comments": [f"generated comment {2 * cluster + 1}"]}
        for cluster in (0, 1)
    ],
}


class ConversationReads:
    """The generator's Postgres reads: conversation, comments and math_main."""

    def initialize(self):
        pass

    def shutdown(self):
        pass

    def get_conversation_by_id(self, zid):
        return {"zid": zid, "topic": "generated conversation"}

    def get_comments_by_conversation(self, zid):
        return [{"tid": tid, "txt": f"generated comment {tid}", "mod": 0} for tid in range(1, 5)]

    def get_report_comment_selections(self, zid):
        return []

    def query(self, sql, params):
        return [{"data": {"tids": [1, 2, 3, 4], "pca": {"comment-extremity": [1.5, 0.2, 1.2, 0.1]},
                          "group-aware-consensus": {"1": 0.9, "2": 0.1, "3": 0.8, "4": 0.2}}}]


class ExportReads:
    def get_export_data(self, zid, include_moderation):
        return {"comments": [{"comment_id": tid, "comment-id": tid, "comment": f"generated comment {tid}",
                              "votes": 10, "passes": 3, "total-votes": 10, "total-agrees": 5,
                              "total-disagrees": 2, "total-passes": 3} for tid in range(1, 5)]}


class MemoryTable:
    def __init__(self, name, rows):
        self.name = name
        self.rows = rows

    def load(self):
        return None

    def query(self, KeyConditionExpression, **kwargs):
        node = KeyConditionExpression.get_expression()
        assert node["operator"] == "=" and not kwargs
        name, value = node["values"][0].name, node["values"][1]
        return {"Items": [dict(row) for row in self.rows if row.get(name) == value]}


class MemoryDynamo:
    """Stands in for boto3.resource('dynamodb'), holding RESULT_ROWS."""

    def Table(self, name):
        return MemoryTable(name, RESULT_ROWS.get(name, []))


class FailingClusterReads:
    """The generator's resource, except that every cluster-assignment read fails."""

    def __init__(self, resource):
        self.resource = resource

    def Table(self, name):
        if name != CLUSTER_FAMILY:
            return self.resource.Table(name)

        def query(**kwargs):
            raise RuntimeError("generated cluster read failure")

        return SimpleNamespace(query=query)


@pytest.fixture(scope="module")
def batch_module():
    # The numbered script imports relative to umap_narrative.
    with pytest.MonkeyPatch.context() as patch:
        patch.syspath_prepend(str(DELPHI_ROOT / "umap_narrative"))
        yield importlib.import_module("umap_narrative.801_narrative_report_batch")


def _bind_postgres_attempt(tmp_path, monkeypatch):
    """The environment and frame of a bound Postgres attempt, its base holding RESULT_ROWS."""
    families = {family: [item_from_python(row) for row in rows] for family, rows in RESULT_ROWS.items()}
    frame = dict(schema="polis-jobs.frame/1", env="proof", zid=ZID, job_id=JOB_ID, run_id=RUN_ID,
                 attempt_id=ATTEMPT_ID, lease_epoch="1", config={"result_backend": "postgres"},
                 writer_base={"schema": "delphi-writer-base/1", "zid": ZID, "families": families})
    (tmp_path / "frame.json").write_text(json.dumps(frame))
    for key, value in dict(DELPHI_RESULT_BACKEND="postgres", DELPHI_OUTPUT_MANIFEST=str(tmp_path / "manifest.json"),
                           DELPHI_FRAME=str(tmp_path / "frame.json"), DELPHI_JOB_ID=JOB_ID,
                           DELPHI_RUN_ID=RUN_ID, DELPHI_ATTEMPT_ID=ATTEMPT_ID).items():
        monkeypatch.setenv(key, value)
    import boto3
    monkeypatch.setattr(boto3, "resource", lambda *a, **k: pytest.fail("Postgres mode created a DynamoDB resource"))


def _use_dynamodb(monkeypatch):
    for key in ("DELPHI_OUTPUT_MANIFEST", "DELPHI_FRAME", "DELPHI_RUN_ID", "DELPHI_ATTEMPT_ID"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("DELPHI_RESULT_BACKEND", "dynamodb")
    import boto3
    monkeypatch.setattr(boto3, "resource", lambda *a, **k: MemoryDynamo())


def _generator(batch_module, mode, tmp_path, monkeypatch):
    # No provider is ever reachable from these tests.
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    if mode == "postgres":
        _bind_postgres_attempt(tmp_path, monkeypatch)
    else:
        _use_dynamodb(monkeypatch)
    # The real constructor, so the backend is the one result_resource selects.
    generator = batch_module.BatchReportGenerator(conversation_id=ZID, model="generated-fixture-model", job_id=JOB_ID)
    expected = "WriterResource" if mode == "postgres" else "MemoryDynamo"
    assert type(generator.dynamodb).__name__ == expected
    generator.postgres_client = ConversationReads()
    generator.group_processor = ExportReads()
    return generator


@pytest.fixture(params=["postgres", "dynamodb"])
def generator(request, batch_module, tmp_path, monkeypatch):
    return _generator(batch_module, request.param, tmp_path, monkeypatch)


def _errors(caplog):
    return [record.getMessage() for record in caplog.records if record.levelno >= logging.ERROR]


def test_preparation_keeps_both_topics_and_the_global_sections(generator, caplog):
    with caplog.at_level(logging.INFO):
        requests = asyncio.run(generator.prepare_batch_requests())
    assert sorted(r["metadata"]["topic_key"] for r in requests) == sorted(GLOBAL_KEYS + TOPIC_KEYS)
    assert len(requests) == 5
    topics = {r["metadata"]["topic_key"]: r["metadata"]["cluster_id"] for r in requests
              if r["metadata"]["topic_key"] in TOPIC_KEYS}
    assert topics == {TOPIC_KEYS[0]: 0, TOPIC_KEYS[1]: 1}
    # Nothing failed quietly on the way: a swallowed read is how the topics went missing.
    assert _errors(caplog) == []


def test_both_backends_prepare_identical_requests(batch_module, tmp_path, monkeypatch):
    prepared = {}
    for mode in ("postgres", "dynamodb"):
        attempt_dir = tmp_path / mode
        attempt_dir.mkdir()
        generator = _generator(batch_module, mode, attempt_dir, monkeypatch)
        prepared[mode] = json.dumps(asyncio.run(generator.prepare_batch_requests()), default=str)
    assert prepared["postgres"] == prepared["dynamodb"]


def test_a_cluster_read_failure_fails_preparation(generator, caplog):
    generator.dynamodb = FailingClusterReads(generator.dynamodb)
    with caplog.at_level(logging.INFO):
        assert asyncio.run(generator.prepare_batch_requests()) == []
        # An empty preparation fails the stage before any provider call.
        assert asyncio.run(generator.submit_batch()) is None
    errors = "\n".join(_errors(caplog))
    assert "generated cluster read failure" in errors
    assert "No batch requests to submit" in errors
