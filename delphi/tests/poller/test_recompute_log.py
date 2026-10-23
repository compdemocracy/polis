"""Every math generation the writer publishes leaves a ``math_recompute_log`` row.

The served next-comment draw weights statements by ``comment-priorities`` of the
latest math generation (``math_main.math_tick``). The serve log records which
generation a draw used; this table says what that generation was: when it was
computed, from how many new votes, and over how many prioritised comments. See
the propensity-logging design, §5 (DDL) and §6 (this write path).

The row is written inside the publication transaction that mints the tick,
so a tick never commits without its log row. Its columns are the tick's
``TickInputs`` (§9: what the engine consumed, enough to replay it) with the
outputs (``last_vote_timestamp``, ``n_comments``) filled in by the writer. These are unit tests against a
mocked client; ``test_recompute_log_postgres.py`` runs the same path against a
real Postgres.
"""

from types import SimpleNamespace
from typing import Optional
from unittest.mock import MagicMock

import pytest
import sqlalchemy as sa

from polismath.poller.math_writer import MathWriter, attach_tick_record
from polismath.poller.service import MathPollerService, PollerConfig
from polismath.poller.tick_inputs import COLUMNS, INCREMENTAL, TickInputs
from polismath.poller.worker_pool import CoalescedBatch

PRIORITIES = {"0": 1.5, "1": 0.25, "2": 9.0}


def _fake_conv(zid=42, last_updated=1234567, priorities=PRIORITIES):
    conv = SimpleNamespace()
    conv.conversation_id = str(zid)
    conv.last_updated = last_updated
    conv.base_clusters = []
    conv.group_clusters = []
    conv.proj = {}
    conv.participant_info = {}
    blob = {"base-clusters": {"id": [], "members": []},
            "lastVoteTimestamp": last_updated,
            "user-vote-counts": {}}
    if priorities is not None:
        blob["comment-priorities"] = dict(priorities)
    conv.to_dict = lambda: dict(blob)
    return conv


def _inputs(n_votes=3):
    votes = [{"pid": p, "tid": 1, "vote": 1, "created": 200 + p} for p in range(n_votes)]
    return TickInputs.incremental(prev_math_tick=76, votes=votes, moderation=None,
                                  version="v")


def _client(tick=77):
    client = MagicMock()
    client.increment_math_tick.return_value = tick
    return client


def _log_call(client):
    client.write_recompute_log.assert_called_once()
    return client.write_recompute_log.call_args


class TestWriterLogsEveryTick:
    def test_log_row_is_written_in_the_publication_transaction(self):
        client = _client(tick=77)
        MathWriter(client).write_conv_updates(42, _fake_conv(zid=42))

        connection = client.transaction.return_value.__enter__.return_value
        call = _log_call(client)
        assert call.args == (42,)
        assert call.kwargs["connection"] is connection
        assert call.kwargs["math_tick"] == 77
        client.transaction.assert_called_once_with()

    def test_log_row_carries_timestamp_and_comment_count(self):
        client = _client()
        MathWriter(client).write_conv_updates(
            42, _fake_conv(zid=42, last_updated=1700000000123), inputs=_inputs())
        inputs = _log_call(client).kwargs["inputs"]
        assert inputs.last_vote_timestamp == 1700000000123
        assert inputs.n_comments == len(PRIORITIES)

    def test_missing_priorities_count_zero_comments(self):
        client = _client()
        MathWriter(client).write_conv_updates(42, _fake_conv(priorities=None),
                                              inputs=_inputs())
        assert _log_call(client).kwargs["inputs"].n_comments == 0

    def test_the_tick_inputs_are_recorded_with_outputs_filled(self):
        client = _client()
        given = _inputs(n_votes=13)
        MathWriter(client).write_conv_updates(42, _fake_conv(), inputs=given)
        logged = _log_call(client).kwargs["inputs"]
        assert logged.n_votes == 13 and logged.vote_created == given.vote_created
        assert logged.start_mode == INCREMENTAL and logged.prev_math_tick == 76

    def test_a_rebuild_record_attached_to_the_conversation_is_taken(self):
        """The backfill and the engine-rebuild tool publish _load_or_init's
        conversation without its inputs: the writer takes the attached record
        (inputs and rendered blob), and removes it from the conversation."""
        client = _client()
        conv = _fake_conv()
        given = _inputs(n_votes=2)
        attach_tick_record(conv, given, {"lastVoteTimestamp": 5, "comment-priorities": {}})
        MathWriter(client).write_conv_updates(42, conv)
        logged = _log_call(client).kwargs["inputs"]
        assert logged.vote_pids == given.vote_pids and logged.last_vote_timestamp == 5
        assert not hasattr(conv, "_tick_record")

    def test_no_recorded_inputs_logs_an_unreplayable_row(self):
        client = _client()
        MathWriter(client).write_conv_updates(42, _fake_conv())
        logged = _log_call(client).kwargs["inputs"]
        assert logged.rebuild_digest is None and not logged.replayable

    def test_log_row_follows_the_tick_and_precedes_math_main(self):
        """math_main stays the last write (its caching_tick allocation sits
        next to COMMIT); the log row is written after the tick is minted."""
        client = _client()
        order = []
        client.increment_math_tick.side_effect = lambda *a, **k: order.append("tick") or 5
        client.write_recompute_log.side_effect = lambda *a, **k: order.append("log")
        client.write_math_main.side_effect = lambda *a, **k: order.append("main")
        MathWriter(client).write_conv_updates(42, _fake_conv())
        assert order.index("tick") < order.index("log") < order.index("main")
        assert order[-1] == "main"

    def test_a_failing_log_write_aborts_the_publication(self):
        client = _client()
        client.write_recompute_log.side_effect = RuntimeError("no table")
        with pytest.raises(RuntimeError, match="no table"):
            MathWriter(client).write_conv_updates(42, _fake_conv())
        client.write_math_main.assert_not_called()

    def test_coordinator_publisher_path_writes_no_log_row(self):
        """The coordinator path publishes through its own RPC; this writer
        opens no transaction there and so cannot add rows to it."""
        client = _client()
        publisher = MagicMock()
        publisher.publish.return_value = 9
        MathWriter(client, publisher=publisher).write_conv_updates(42, _fake_conv())
        client.write_recompute_log.assert_not_called()


class TestServicePassesBatchSize:
    def _service(self):
        svc = MathPollerService(MagicMock(), PollerConfig())
        writer = MagicMock()
        svc._writer = writer
        return svc, writer

    def _cached_conv(self):
        conv = MagicMock()
        conv.last_updated = 100
        conv.update_votes.return_value = conv
        conv.update_moderation.return_value = conv
        conv.recompute.return_value = conv
        return conv

    def test_incremental_batch_records_its_votes_in_delivery_order(self):
        svc, writer = self._service()
        votes = [{"zid": 5, "pid": p, "tid": 1, "vote": 1, "created": 200 - p}
                 for p in range(3)]
        svc._conv_ticks[5] = 41
        svc._conv_mod_reads[5] = ((), (), (), ())  # the chain's last read
        svc._compute_and_publish(5, self._cached_conv(), CoalescedBatch(votes=votes))
        inputs = writer.write_conv_updates.call_args.kwargs["inputs"]
        assert inputs.n_votes == 3
        assert inputs.vote_pids == (0, 1, 2) and inputs.vote_created == (200, 199, 198)
        assert inputs.prev_math_tick == 41
        assert inputs.mod_read is False  # no moderation message: cached sets kept
        svc._pg.poll_moderation.assert_not_called()

    def test_moderation_only_batch_has_zero_votes_and_reads_moderation(self):
        svc, writer = self._service()
        svc._pg.poll_moderation.return_value = {
            "mod_out_tids": [1], "mod_in_tids": [], "meta_tids": [2], "mod_out_ptpts": []}
        svc._compute_and_publish(
            5, self._cached_conv(),
            CoalescedBatch(moderation=[{"zid": 5, "tid": 1, "modified": 300}]))
        inputs = writer.write_conv_updates.call_args.kwargs["inputs"]
        assert inputs.n_votes == 0
        assert inputs.mod_read and inputs.mod_out_tids == (1,) and inputs.meta_tids == (2,)

    def test_the_published_tick_becomes_the_next_prev_math_tick(self):
        svc, writer = self._service()
        writer.write_conv_updates.return_value = 12
        conv = self._cached_conv()
        svc._conv_mod_reads[5] = ((), (), (), ())
        svc._compute_and_publish(5, conv, CoalescedBatch(votes=[]))
        svc._compute_and_publish(5, conv, CoalescedBatch(votes=[]))
        assert writer.write_conv_updates.call_args.kwargs["inputs"].prev_math_tick == 12

    def test_moderation_deltas_are_against_the_chain_previous_read(self):
        """The rebuild's read is the base of the next mod_read tick; a
        votes-only tick in between keeps it; each read becomes the next base."""
        svc, writer = self._service()
        writer.write_conv_updates.return_value = 3
        rebuilt = self._cached_conv()
        rebuild = TickInputs.rebuild(
            "cold", prev_math_tick=None, votes=[], version="v",
            moderation={"mod_out_tids": [4], "mod_in_tids": [], "meta_tids": [],
                        "mod_out_ptpts": []})
        attach_tick_record(rebuilt, rebuild, {})
        svc._load_or_init = MagicMock(return_value=rebuilt)  # type: ignore[method-assign]
        svc._compute_and_publish(5, None, CoalescedBatch())
        conv = svc._convs[5]
        svc._compute_and_publish(5, conv, CoalescedBatch(votes=[]))
        svc._pg.poll_moderation.return_value = {
            "mod_out_tids": [4, 6], "mod_in_tids": [], "meta_tids": [], "mod_out_ptpts": []}
        svc._compute_and_publish(5, conv, CoalescedBatch(moderation=[{"tid": 6}]))
        first = writer.write_conv_updates.call_args.kwargs["inputs"]
        assert first.mod_base == ((4,), (), (), ())
        assert first.to_row()["mod_out_tids_added"] == [6]
        svc._pg.poll_moderation.return_value = {
            "mod_out_tids": [6], "mod_in_tids": [], "meta_tids": [], "mod_out_ptpts": []}
        svc._compute_and_publish(5, conv, CoalescedBatch(moderation=[{"tid": 4}]))
        second = writer.write_conv_updates.call_args.kwargs["inputs"]
        assert second.mod_base == ((4, 6), (), (), ())
        assert second.to_row()["mod_out_tids_removed"] == [4]

    def test_an_unknown_base_leaves_the_tick_without_a_predecessor(self):
        """A cached conversation whose chain's last read is unknown (never
        published by this service) cannot log deltas replay could fold: its
        tick records no predecessor, so replay refuses it instead."""
        svc, writer = self._service()
        svc._conv_ticks[5] = 9
        svc._pg.poll_moderation.return_value = {
            "mod_out_tids": [1], "mod_in_tids": [], "meta_tids": [], "mod_out_ptpts": []}
        svc._compute_and_publish(5, self._cached_conv(), CoalescedBatch(moderation=[{}]))
        assert writer.write_conv_updates.call_args.kwargs["inputs"].prev_math_tick is None

    def test_cold_rebuild_publishes_the_record_load_or_init_attached(self):
        """A full-history rebuild subsumes the triggering batch: its inputs
        come from _load_or_init (attached to the conversation), not from the
        batch."""
        svc, writer = self._service()
        conv = MagicMock()
        svc._load_or_init = MagicMock(return_value=conv)  # type: ignore[method-assign]
        svc._compute_and_publish(5, None, CoalescedBatch(votes=[{"created": 1}]))
        assert writer.write_conv_updates.call_args.args == (5, conv)
        assert writer.write_conv_updates.call_args.kwargs == {}


class TestSQL:
    """The SQL lives in PostgresClient; record it without a database."""

    def _client_with_recorder(self):
        from polismath.database.postgres import PostgresClient, PostgresConfig

        client = PostgresClient(PostgresConfig(url="postgresql://u:p@h:5432/db",
                                               math_env="delphi"))
        calls = []

        def recorder(sql, params=None, *, connection=None):
            calls.append((" ".join(sql.lower().split()), params or {}, connection))
            return []

        client._write_returning = recorder  # type: ignore[assignment]
        client._initialized = True
        return client, calls

    def test_log_row_insert(self):
        client, calls = self._client_with_recorder()
        conn = MagicMock()
        inputs = _inputs()
        client.write_recompute_log(42, math_tick=7, inputs=inputs, connection=conn)
        assert len(calls) == 1
        sql, params, used = calls[0]
        assert "insert into math_recompute_log" in sql
        assert "on conflict (zid, math_env, math_tick)" in sql
        for column in COLUMNS:
            assert f":{column}" in sql and f"{column} = excluded.{column}" in sql
        assert used is conn
        assert params == {"zid": 42, "math_env": "delphi", "math_tick": 7,
                          **inputs.to_row()}

class TestDeclaredSchema:
    def test_sqlalchemy_models(self):
        from polismath.database.postgres import MathRecomputeLog

        log = MathRecomputeLog.__table__
        assert isinstance(log, sa.Table)
        assert log.name == "math_recompute_log"
        assert [c.name for c in log.primary_key.columns] == ["zid", "math_env", "math_tick"]
        assert set(log.columns.keys()) == {
            "zid", "math_env", "math_tick", "created", *COLUMNS}

    def test_replay_harness_schema_has_the_log_table(self):
        """The poller-equivalence harness runs the real Python poller against
        its own hand-written schema; without this table every publication
        there would roll back."""
        from polismath.replay import poller_equiv as pe

        tables = pe.parse_schema_columns()
        assert set(tables["math_recompute_log"]) == {
            "zid", "math_env", "math_tick", "created", *COLUMNS}


class TestSchemaReadiness:
    """Without migration 000044 every publication rolls back and the error
    path parks each conversation after its retry; the poller refuses to start
    instead (exit 2, like its other refusals)."""

    def _pg(self, log: Optional[str] = "math_recompute_log"):
        pg = MagicMock()
        pg.query.return_value = [{"recompute_log": log}]
        return pg

    def test_the_log_table_present_passes(self):
        from polismath.poller.service import require_recompute_log_schema

        pg = self._pg()
        require_recompute_log_schema(pg)
        sql = " ".join(pg.query.call_args.args[0].split())
        assert "to_regclass('math_recompute_log')" in sql

    def test_a_missing_log_table_is_refused_naming_the_migration(self):
        from polismath.poller.service import (
            SchemaNotReady,
            require_recompute_log_schema,
        )

        with pytest.raises(SchemaNotReady) as exc:
            require_recompute_log_schema(self._pg(None))
        message = str(exc.value)
        assert "000044_routing_propensities" in message
        assert "math_recompute_log" in message

    def _cli(self, monkeypatch, pg):
        from scripts import math_poller

        monkeypatch.setattr(math_poller, "PostgresClient", lambda config: pg)
        monkeypatch.setattr(math_poller, "_memory_admission", lambda config, log: MagicMock())
        monkeypatch.setattr(math_poller, "_backfill_config", lambda log: None)
        built = []
        monkeypatch.setattr(math_poller, "MathPollerService",
                            lambda *a, **k: built.append(a) or "service")
        config = PollerConfig(database_url="postgresql://u:p@127.0.0.1:1/db", math_env="python")
        return math_poller, config, built

    def test_the_poller_refuses_to_start_without_the_table(self, monkeypatch, capsys):
        math_poller, config, built = self._cli(monkeypatch, self._pg(None))
        with pytest.raises(SystemExit) as exc:
            math_poller._build_service(config)
        assert exc.value.code == 2
        assert built == []  # no service, so no loops
        err = capsys.readouterr().err
        assert "refusing to start" in err and "000044_routing_propensities" in err

    def test_the_poller_builds_its_service_with_the_table(self, monkeypatch):
        math_poller, config, built = self._cli(monkeypatch, self._pg())
        assert math_poller._build_service(config) == "service"
        assert len(built) == 1
