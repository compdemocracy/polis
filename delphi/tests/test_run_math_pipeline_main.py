"""run_math_pipeline.main against a generated fixture database.

``main`` is the math stage of a Delphi FULL_PIPELINE job (run_delphi.py runs it
as a subprocess). These tests drive the real ``main`` with a fake connection,
a recording stand-in for ``Conversation`` and a stand-in DynamoDB client, so
they observe exactly what the stage feeds the engine and how it exits.
"""

import sys
from types import SimpleNamespace

import pytest

import polismath.conversation.conversation as conversation_module
import polismath.database.dynamodb as dynamodb_module
import polismath.run_math_pipeline as rmp


class FakeCursor:
    def __init__(self, rows):
        self.rows = rows
        self._result = None

    def execute(self, sql, params):
        if "COUNT(*)" in sql:
            self._result = [(len(self.rows),)]
        else:
            _zid, limit, offset = params
            self._result = self.rows[offset:offset + limit]

    def fetchone(self):
        return self._result[0]

    def fetchall(self):
        return list(self._result)

    def close(self):
        pass


class FakeConn:
    def __init__(self, rows):
        self.rows = rows

    def cursor(self, *args, **kwargs):
        return FakeCursor(self.rows)

    def close(self):
        pass


class RecordingConversation:
    """Records what main() feeds the engine; computes nothing."""

    instances = []

    def __init__(self, conversation_id):
        self.conversation_id = conversation_id
        self.fed_votes = []
        self.group_clusters = []
        self.comment_count = 0
        self.participant_count = 0
        self.repness = None
        self.raw_rating_mat = SimpleNamespace(
            memory_usage=lambda deep=True: SimpleNamespace(sum=lambda: 0)
        )
        self.export_result = True
        RecordingConversation.instances.append(self)

    def update_moderation(self, moderation, recompute=False):
        return self

    def update_votes(self, votes, recompute=False):
        self.fed_votes.extend(votes["votes"])
        return self

    def _compute_pca(self):
        pass

    def _compute_clusters(self):
        pass

    def _compute_repness(self):
        pass

    def _compute_participant_info(self):
        pass

    def export_to_dynamodb(self, client):
        return RecordingConversation.export_result


class FakeDynamoDBClient:
    def __init__(self, **kwargs):
        pass

    def initialize(self):
        pass


@pytest.fixture
def run_main(monkeypatch):
    """Run main() over generated vote rows ``(created, tid, pid, raw_vote)``."""

    def _run(rows, *, export_result=True):
        RecordingConversation.instances.clear()
        RecordingConversation.export_result = export_result
        monkeypatch.setattr(rmp, "connect_to_db", lambda: FakeConn(rows))
        monkeypatch.setattr(rmp, "fetch_comments", lambda conn, zid: {"comments": []})
        monkeypatch.setattr(rmp, "fetch_moderation", lambda conn, zid: {})
        monkeypatch.setattr(conversation_module, "Conversation", RecordingConversation)
        monkeypatch.setattr(dynamodb_module, "DynamoDBClient", FakeDynamoDBClient)
        monkeypatch.setattr(sys, "argv", ["run_math_pipeline.py", "--zid=1"])
        exit_code = 0
        try:
            rmp.main()
        except SystemExit as e:
            exit_code = e.code
        (conv,) = RecordingConversation.instances
        return exit_code, conv.fed_votes

    return _run


def test_successful_export_exits_zero(run_main):
    exit_code, _ = run_main([(1000, 1, 1, 0)])
    assert exit_code == 0


def test_failed_export_exits_with_the_export_failed_code(run_main):
    exit_code, fed = run_main([(1000, 1, 1, 0)], export_result=False)
    assert exit_code == rmp.MATH_EXPORT_FAILED_EXIT_CODE
    assert exit_code != 0
    # The math was still computed over the same input.
    assert len(fed) == 1
