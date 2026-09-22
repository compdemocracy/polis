"""Empty math readers use declared data, never invented group assignments.

Exercise the real serializers/readers. Only database tables/query transport and
the report helper's DynamoDB initialization are replaced; no cloud calls.
"""

import copy
import json
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from polismath.conversation.conversation import Conversation
from polismath.database.dynamodb import DynamoDBClient
from umap_narrative.polismath_commentgraph.utils.group_data import GroupDataProcessor


def empty_blob(legacy=False):
    schedule = json.loads(
        (Path(__file__).parents[1] / "scripts/schedules/pc-zerovote-01-empty.json").read_text()
    )
    blob = {"zid": "synthetic-empty", "pca": {"comps": [[], []]}}
    for key, value in schedule["empty_output"].items():
        if "." in key:
            parent, leaf = key.split(".")
            blob.setdefault(parent, {})[leaf] = value
        else:
            blob[key] = value
    if legacy:
        for key in schedule["legacy_absent_keys"]:
            if "." in key:
                parent, leaf = key.split(".")
                blob[parent].pop(leaf)
            else:
                blob.pop(key)
        # A real legacy empty blob omits PCA altogether.
        blob.pop("pca")
    return blob


@pytest.mark.parametrize("legacy", [False, True])
def test_restore_declared_empty_or_legacy_omissions(legacy):
    conv = Conversation.from_dict(empty_blob(legacy))
    assert conv.group_clusters == []
    assert conv.base_clusters == []


@pytest.mark.parametrize("alias", ["group_clusters", "group-clusters"])
def test_restore_populated_group_alias(alias):
    groups = [{"id": 3, "members": [4, 7], "center": [0.25, -0.5]}]
    conv = Conversation.from_dict({"zid": "synthetic-populated", alias: groups})
    assert conv.group_clusters == groups


@pytest.mark.parametrize("snake", [None, []])
def test_restore_null_or_explicit_empty_snake_alias(snake):
    groups = [{"id": 3, "members": [4]}]
    conv = Conversation.from_dict({"group_clusters": snake, "group-clusters": groups})
    # Preserve an explicit empty internal alias; null/absent may use the wire key.
    assert conv.group_clusters == (groups if snake is None else [])


def test_restore_existing_snake_alias_keeps_precedence():
    internal = [{"id": 2, "members": [6]}]
    conv = Conversation.from_dict({
        "group_clusters": internal, "group-clusters": [{"id": 9, "members": [8]}]
    })
    assert conv.group_clusters == internal


def representative_client():
    client = DynamoDBClient()
    table = MagicMock(name="representative_table")
    client.tables = {"Delphi_RepresentativeComments": table}
    return client, table


def test_real_empty_dynamo_serialization_does_not_fail_on_none_repness():
    conv = Conversation("synthetic-empty", last_updated=1)
    assert conv.repness is None
    assert "repness" not in conv.to_dynamo_dict()
    client, table = representative_client()
    assert client.write_conversation(conv) is True
    table.batch_writer.assert_not_called()


@pytest.mark.parametrize("wire_repness", [None, {}])
def test_empty_wire_repness_does_not_fail(wire_repness, monkeypatch):
    conv = Conversation("synthetic-empty", last_updated=1)
    wire = conv.to_dynamo_dict()
    wire["repness"] = wire_repness
    monkeypatch.setattr(conv, "to_dynamo_dict", lambda: wire)
    client, table = representative_client()
    assert client.write_conversation(conv) is True
    table.batch_writer.assert_not_called()


@pytest.mark.parametrize("optimized", [False, True])
def test_populated_representativeness_still_written(optimized):
    from types import SimpleNamespace

    conv = SimpleNamespace(
        conversation_id="synthetic-populated",
        repness={"comment_repness": [{"gid": 2, "tid": 4, "repness": 0.5}]},
    )
    if optimized:
        conv.to_dynamo_dict = lambda: {
            "math_tick": 7,
            "repness": {"comment_repness": [{"group_id": 2, "comment_id": 4, "repness": 0.5}]},
        }
    client, table = representative_client()
    assert client.write_conversation(conv) is True
    batch = table.batch_writer.return_value.__enter__.return_value
    item = batch.put_item.call_args.kwargs["Item"]
    assert (item["group_id"], item["comment_id"], item["repness"]) == (2, "4", 0.5)


@pytest.fixture
def report_reader(monkeypatch):
    monkeypatch.setattr(GroupDataProcessor, "init_dynamodb", lambda self: None)
    db = MagicMock(name="query_transport")
    # Votes exist, but they cannot justify inventing a clustering result.
    db.get_votes_by_conversation.return_value = [{"pid": 7, "tid": 1, "vote": 1}]
    return GroupDataProcessor(db), db


@pytest.mark.parametrize("rows", [[], [{}], [{"data": "not json"}], [{"data": None}]])
def test_missing_or_unreadable_math_never_fabricates_groups(report_reader, rows):
    reader, db = report_reader
    db.query.return_value = rows
    assert reader.get_math_main_by_conversation(1) == {"group_assignments": {}, "n_groups": 0}
    db.get_votes_by_conversation.assert_not_called()


@pytest.mark.parametrize("legacy", [False, True])
@pytest.mark.parametrize("encoded", [False, True])
def test_empty_report_row_is_preserved(report_reader, legacy, encoded):
    reader, db = report_reader
    blob = empty_blob(legacy)
    db.query.return_value = [{"data": json.dumps(blob) if encoded else copy.deepcopy(blob)}]
    assert reader.get_math_main_by_conversation(1) == blob
    db.get_votes_by_conversation.assert_not_called()


def test_populated_report_row_and_environment_query_are_preserved(report_reader):
    reader, db = report_reader
    blob = {"group-clusters": [{"id": 0, "members": [7]}]}
    db.query.return_value = [{"data": blob}]
    assert reader.get_math_main_by_conversation(1) == blob
    sql, params = db.query.call_args.args
    assert "math_env = :math_env" in sql
    assert params["zid"] == 1
    assert "math_env" in params
    db.get_votes_by_conversation.assert_not_called()
