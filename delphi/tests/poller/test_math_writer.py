"""Writer tests: bidToPid derivation + the four Postgres writes.

Verifies fidelity to the Clojure writers:
  - upload-math-main caching_tick = COALESCE((select max(caching_tick)+1 ...),1)
    (postgres.clj:323-338)
  - inc-math-tick atomic INSERT ... ON CONFLICT ... math_tick+1 RETURNING
    (postgres.clj:292-295)
  - prep-bidToPid shape {:zid :bidToPid :lastVoteTimestamp} where bidToPid is a
    vector of member-vectors sorted by base cluster id (conv_man.clj:35-40,
    conversation.clj:585-586)
  - write-conv-updates! writes math_main / math_bidtopid / math_ptptstats with
    ONE shared math_tick (conv_man.clj:158-169).
"""

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from polismath.poller.math_writer import derive_bidtopid, MathWriter


def _fake_conv(zid=42, base_clusters=None, last_updated=1234567):
    """Minimal stand-in exposing the public attributes the writer consumes."""
    conv = SimpleNamespace()
    conv.conversation_id = str(zid)
    conv.last_updated = last_updated
    conv.base_clusters = base_clusters if base_clusters is not None else []
    conv.participant_info = {}
    conv.to_dict = lambda: {"base-clusters": {"id": [], "members": []},
                            "lastVoteTimestamp": last_updated}
    return conv


class TestDeriveBidToPid:
    def test_shape_is_list_of_member_lists_sorted_by_id(self):
        # base_clusters intentionally out of id order to prove sorting.
        conv = _fake_conv(
            zid=7,
            base_clusters=[
                {"id": 2, "members": ["30", "31"]},
                {"id": 0, "members": ["10", "11", "12"]},
                {"id": 1, "members": ["20"]},
            ],
        )
        result = derive_bidtopid(conv, 7)
        # bidToPid[i] must be the members of the base cluster whose id sorts to
        # position i -> positionally aligned with base-clusters.id (ascending).
        assert result["bidToPid"] == [["10", "11", "12"], ["20"], ["30", "31"]]

    def test_wrapper_keys_match_prep_bidToPid(self):
        conv = _fake_conv(zid=7, base_clusters=[{"id": 0, "members": ["1"]}],
                          last_updated=999)
        result = derive_bidtopid(conv, 7)
        assert result["zid"] == 7
        assert result["lastVoteTimestamp"] == 999
        assert set(result.keys()) == {"zid", "bidToPid", "lastVoteTimestamp"}

    def test_empty_base_clusters_gives_empty_bidToPid(self):
        conv = _fake_conv(zid=7, base_clusters=[])
        assert derive_bidtopid(conv, 7)["bidToPid"] == []


class TestMathWriterSharedTick:
    def test_all_writes_share_one_math_tick(self):
        client = MagicMock()
        client.increment_math_tick.return_value = 77
        conv = _fake_conv(zid=42, base_clusters=[{"id": 0, "members": ["1"]}])

        writer = MathWriter(client)
        writer.write_conv_updates(42, conv)

        # tick incremented exactly once for the zid
        client.increment_math_tick.assert_called_once_with(42)

        # all three data writes carry the SAME tick value returned above
        assert client.write_math_main.call_args.kwargs.get("math_tick") == 77 \
            or 77 in client.write_math_main.call_args.args
        bidtopid_tick = client.write_math_bidtopid.call_args
        ptptstats_tick = client.write_participant_stats.call_args
        assert 77 in bidtopid_tick.args or bidtopid_tick.kwargs.get("math_tick") == 77
        assert 77 in ptptstats_tick.args or ptptstats_tick.kwargs.get("math_tick") == 77

    def test_bidtopid_data_written_has_correct_shape(self):
        client = MagicMock()
        client.increment_math_tick.return_value = 1
        conv = _fake_conv(zid=42, base_clusters=[{"id": 0, "members": ["1", "2"]}])
        MathWriter(client).write_conv_updates(42, conv)

        # Find the data dict passed to write_math_bidtopid.
        call = client.write_math_bidtopid.call_args
        data = call.kwargs.get("data")
        if data is None:
            # positional: (zid, data, math_tick)
            data = call.args[1]
        assert data["bidToPid"] == [["1", "2"]]


class TestWriterSQLFidelity:
    """The Clojure-exact SQL lives in PostgresClient; verify text + params via a
    recorder that captures every raw query without touching a database."""

    def _client_with_recorder(self):
        from polismath.database.postgres import PostgresClient, PostgresConfig

        cfg = PostgresConfig(url="postgresql://u:p@h:5432/db", math_env="delphi")
        client = PostgresClient(cfg)
        calls = []

        def recorder(sql, params=None):
            calls.append((sql, params or {}))
            # increment_math_tick reads [0]["math_tick"] off the result
            return [{"math_tick": 5, "zid": 1}]

        # Writers persist via the committing _write_returning path (not query()).
        client._write_returning = recorder  # type: ignore[assignment]
        client._initialized = True
        return client, calls

    def test_increment_math_tick_is_atomic_upsert(self):
        client, calls = self._client_with_recorder()
        tick = client.increment_math_tick(42)
        sql, params = calls[-1]
        norm = " ".join(sql.lower().split())
        assert "insert into math_ticks" in norm
        assert "on conflict" in norm
        assert "math_tick" in norm and "+ 1" in norm.replace("+1", "+ 1")
        assert "returning math_tick" in norm
        assert tick == 5

    def test_write_math_main_has_caching_tick_max_plus_one_subquery(self):
        client, calls = self._client_with_recorder()
        client.write_math_main(
            42, {"k": "v"}, last_vote_timestamp=111, math_tick=5
        )
        sql, params = calls[-1]
        norm = " ".join(sql.lower().split())
        assert "insert into math_main" in norm
        assert "coalesce" in norm
        assert "max(caching_tick) + 1" in norm.replace("max(caching_tick)+1",
                                                        "max(caching_tick) + 1")
        assert "on conflict" in norm

    def test_write_math_bidtopid_upsert(self):
        client, calls = self._client_with_recorder()
        client.write_math_bidtopid(42, {"bidToPid": [["1"]]}, math_tick=5)
        sql, params = calls[-1]
        norm = " ".join(sql.lower().split())
        assert "insert into math_bidtopid" in norm
        assert "on conflict" in norm
