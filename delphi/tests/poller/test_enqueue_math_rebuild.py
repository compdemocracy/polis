"""Operator admissions share the real queue contract, even for a small conversation."""
from unittest.mock import Mock
import json

import pytest

from scripts import enqueue_math_rebuild as cli
from polismath.poller.admission import MemoryModel


COMMIT = "a" * 40


@pytest.mark.parametrize("zid,staged,target,commit", [
    (0, "stage", "python", COMMIT),
    (7, "python", "target", COMMIT),
    (7, "prod", "target", COMMIT),
    (7, "stage", "stage", COMMIT),
    (7, "stage", "python", "unknown"),
    (7, "stage/invalid", "python", COMMIT),
])
def test_refuses_invalid_admission_before_database(monkeypatch, zid, staged, target, commit):
    connection = Mock(side_effect=AssertionError("must not connect"))
    monkeypatch.setattr(cli.psycopg2, "connect", connection)
    assert cli.main(["--zid", str(zid), "--staged-label", staged,
                     "--target-label", target, "--source-commit", commit]) == 2
    connection.assert_not_called()


def test_small_conversation_uses_existing_admission_without_threshold_override():
    queue = Mock()
    queue.enqueue_math_rebuild.return_value = ("enqueued", "generated-job")
    model = MemoryModel()
    result = cli.admit(7, staged_label="staged", target_label="python",
                       source_commit=COMMIT, model=model, snapshot=((36, 6, 6), 123),
                       queue=queue)
    assert result["outcome"] == "enqueued"
    assert result["config"]["need_bytes"] == model.above_base_bytes(36, 6, 6)
    assert result["config"]["input_through_ms"] == 123
    queue.enqueue_math_rebuild.assert_called_once_with(
        7, config=result["config"], staged_label="staged", target_label="python")


def test_dry_run_is_read_only():
    queue = Mock()
    result = cli.admit(7, staged_label="staged", target_label="python",
                       source_commit=COMMIT, model=MemoryModel(),
                       snapshot=((0, 0, 0), None), queue=queue, dry_run=True)
    assert result["outcome"] == "dry_run" and result["job_id"] is None
    queue.enqueue_math_rebuild.assert_not_called()


def test_database_errors_do_not_disclose_connection_details(monkeypatch, capsys):
    monkeypatch.setenv("DATABASE_URL", "generated-db-url")
    monkeypatch.setattr(cli, "read_snapshot", Mock(
        side_effect=cli.psycopg2.OperationalError("sensitive-connection-detail")))
    assert cli.main(["--zid", "7", "--staged-label", "stage", "--target-label", "python",
                     "--source-commit", COMMIT, "--dry-run"]) == 2
    assert "sensitive-connection-detail" not in capsys.readouterr().err


def test_active_scope_conflict_reports_failure_and_preserves_existing_job(monkeypatch, capsys):
    monkeypatch.setenv("DATABASE_URL", "generated-db-url")
    monkeypatch.setattr(cli, "read_snapshot", Mock(return_value=((36, 6, 6), 123)))
    queue = Mock()
    queue.enqueue_math_rebuild.return_value = ("conflict", "existing-job")
    monkeypatch.setattr(cli, "QueueClient", Mock(return_value=queue))
    assert cli.main(["--zid", "7", "--staged-label", "stage", "--target-label", "python",
                     "--source-commit", COMMIT]) == 1
    result = json.loads(capsys.readouterr().out)
    assert result["outcome"] == "conflict" and result["job_id"] == "existing-job"
    queue.enqueue_math_rebuild.assert_called_once()
