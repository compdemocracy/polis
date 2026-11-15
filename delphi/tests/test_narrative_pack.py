"""Narrative prompt packs: Delphi's own requests, read back without a model call.

Generated rows only: no votes, no database server and no provider call. The
generator reads through an in-memory stand-in for the DynamoDB resource, and
its conversation, comment and math_main reads are stand-ins, as in
test_narrative_topic_preparation.py.
"""
import asyncio
import importlib
import json
from decimal import Decimal
from pathlib import Path

import pytest

from polismath.job_child import census

DELPHI_ROOT = Path(__file__).resolve().parents[1]
ZID = 1
PACK_ID = "00000000-0000-4000-8000-0000000008a1"
TOPIC_JOB = "00000000-0000-4000-8000-000000000700"
TOPIC_KEYS = [f"{TOPIC_JOB}#0#0", f"{TOPIC_JOB}#0#1"]

RESULT_ROWS = {
    "Delphi_CommentHierarchicalClusterAssignments": [
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
    """Per-comment counts, overall and for two opinion groups, agree as agree."""

    # Group columns are named as get_export_data names them: group, then the
    # group id, then the count.
    GROUPS = {"0": (6, 4, 1, 1), "1": (4, 1, 1, 2)}

    def get_export_data(self, zid, include_moderation):
        groups = {f"group-{g}-{name}": n for g, counts in self.GROUPS.items()
                  for name, n in zip(("votes", "agrees", "disagrees", "passes"), counts)}
        return {"comments": [{"comment_id": tid, "comment-id": tid, "comment": f"generated comment {tid}",
                              "votes": 10, "passes": 3, "total-votes": 10, "total-agrees": 5,
                              "total-disagrees": 2, "total-passes": 3, **groups}
                             for tid in range(1, 5)]}


class MemoryTable:
    def __init__(self, rows):
        self.rows = rows

    def query(self, KeyConditionExpression, **kwargs):
        node = KeyConditionExpression.get_expression()
        name, value = node["values"][0].name, node["values"][1]
        return {"Items": [dict(row) for row in self.rows if row.get(name) == value]}


class MemoryDynamo:
    def Table(self, name):
        return MemoryTable(RESULT_ROWS.get(name, []))


@pytest.fixture
def requests_and_module(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    for key in ("DELPHI_OUTPUT_MANIFEST", "DELPHI_FRAME", "DELPHI_RUN_ID", "DELPHI_ATTEMPT_ID"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("DELPHI_RESULT_BACKEND", "dynamodb")
    import boto3
    monkeypatch.setattr(boto3, "resource", lambda *a, **k: MemoryDynamo())
    monkeypatch.syspath_prepend(str(DELPHI_ROOT / "umap_narrative"))
    batch = importlib.import_module("umap_narrative.801_narrative_report_batch")
    pack = importlib.import_module("umap_narrative.narrative_pack")

    def refuse(*args, **kwargs):
        raise AssertionError("a prompt pack never submits a batch")

    monkeypatch.setattr(batch.BatchReportGenerator, "submit_batch", refuse)
    generator = batch.BatchReportGenerator(conversation_id=ZID, model=pack.NO_MODEL, job_id=PACK_ID,
                                           include_moderation=True)
    generator.postgres_client = ConversationReads()
    generator.group_processor = ExportReads()
    return asyncio.run(generator.prepare_batch_requests()), pack


INPUTS = {"math_env": "prod", "math_tick": 7, "math_caching_tick": 0,
          "comment_set_sha256": "0" * 64, "vote_hwm": 1}


def test_a_pack_carries_every_prepared_request_byte_for_byte(requests_and_module):
    requests, pack_module = requests_and_module
    pack = pack_module.build_pack(requests, zid=ZID, report_id="rgenerated", pack_id=PACK_ID,
                                  inputs=INPUTS, settings={"include_moderation": True})
    assert pack["schema"] == "polis-narrative-pack/1"
    assert pack["prompt_version"] == "narrative/1"
    assert pack["model_called"] is False
    assert pack["zid"] == "1" and pack["report_id"] == "rgenerated" and pack["inputs"] == INPUTS
    assert len(pack["sections"]) == len(requests) == 5
    for request, section in zip(requests, pack["sections"]):
        assert section["request"] == {k: request[k] for k in ("system", "messages", "max_tokens")}
        assert section["section"] == request["metadata"]["section_name"]
        assert section["prompt_sha256"] == pack_module.request_prompt_sha256(request)
    topics = [s for s in pack["sections"] if s["kind"] == "topic"]
    assert sorted(s["topic_key"] for s in topics) == sorted(TOPIC_KEYS)
    assert {s["section"] for s in topics} == {k.replace("#", "_") for k in TOPIC_KEYS}
    globals_ = [s for s in pack["sections"] if s["kind"] == "global"]
    assert sorted(s["section"] for s in globals_) == sorted(
        f"{PACK_ID}_global_{n}" for n in ("groups", "group_informed_consensus", "uncertainty"))
    assert pack["clustering"] == {"labels": [TOPIC_JOB]}
    json.dumps(pack)  # the pack is plain JSON


def test_the_comments_are_read_back_from_the_request_the_model_gets(requests_and_module):
    requests, pack_module = requests_and_module
    topic = next(r for r in requests if r["metadata"]["topic_key"] == TOPIC_KEYS[0])
    section = pack_module.section_of(topic)
    # The XML is inside the user message the model is given.
    assert section["comments_xml"].strip().startswith("<?xml")
    assert section["citation_ids"] == [1, 2]
    first = section["comments"][0]
    assert first == {"id": 1, "text": "generated comment 1", "votes": 10, "agrees": 5, "disagrees": 2, "passes": 3,
                     "groups": {"0": {"votes": 6, "agrees": 4, "disagrees": 1, "passes": 1},
                                "1": {"votes": 4, "agrees": 1, "disagrees": 1, "passes": 2}}}
    lines = section["comments_csv"].splitlines()
    counts = ("votes", "agrees", "disagrees", "passes")
    group_columns = [f"group-{g}-{name}" for g in ("0", "1") for name in counts]
    assert lines[0] == ",".join(["comment_id", "comment_text", *counts, *group_columns])
    assert lines[1].startswith("1,generated comment 1,10,5,2,3,6,4,1,1,4,1,1,2")


def test_versions_are_digests_of_the_prompt_files_and_code(requests_and_module):
    _, pack_module = requests_and_module
    assert len(pack_module.prompt_files_sha256()) == 64
    assert len(pack_module.code_version()) == 64
    assert pack_module.prompt_files_sha256() == pack_module.prompt_files_sha256()


def test_no_requests_is_refused(requests_and_module):
    _, pack_module = requests_and_module
    with pytest.raises(ValueError):
        pack_module.build_pack([], zid=ZID, report_id="r", pack_id=PACK_ID, inputs=INPUTS, settings={})


def test_the_comment_set_digest_the_server_compares_is_the_census_digest():
    # The same three comments are inserted by the server's narrative-jobs
    # test, which asserts pd_narrative_source_state gives this same digest.
    rows = [{"tid": 0, "mod": 0, "active": True, "txt": "Generated evidence 0"},
            {"tid": 1, "mod": 0, "active": True, "txt": "Generated evidence 1"},
            {"tid": 2, "mod": 1, "active": False, "txt": "Generated evidence 2"}]
    assert census.comment_set_sha256(rows) == "7dec5fc5677bfd39ec3e23c103db022a8cc9eb3e01e8d46b3b9cb6d6d7c6f5fb"
