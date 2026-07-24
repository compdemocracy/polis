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

import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from polismath.poller.math_writer import derive_bidtopid, derive_ptptstats, MathWriter


def _fake_conv(zid=42, base_clusters=None, last_updated=1234567,
                group_clusters=None, proj=None):
    """Minimal stand-in exposing the public attributes the writer consumes."""
    conv = SimpleNamespace()
    conv.conversation_id = str(zid)
    conv.last_updated = last_updated
    conv.base_clusters = base_clusters if base_clusters is not None else []
    conv.group_clusters = group_clusters if group_clusters is not None else []
    conv.proj = proj if proj is not None else {}
    conv.participant_info = {}
    conv.to_dict = lambda: {"base-clusters": {"id": [], "members": []},
                            "lastVoteTimestamp": last_updated,
                            "user-vote-counts": {}}
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


# --------------------------------------------------------------------------- #
# derive_ptptstats — REAL bug fix, 2026-07-24 (poller-equivalence harness live
# debugging session 2). Before this fix, derive_ptptstats just wrapped
# conv.participant_info (a Python-only, ROW-wise dict of n_agree/n_disagree/
# n_pass/group_correlations — a COMPLETELY DIFFERENT statistic from Clojure's,
# not just a different shape). Clojure's prep-ptpt-stats (conv_man.clj:90-94)
# wraps a COLUMNAR {pid, gid, n-votes, centricness, coreness, extremeness}
# dict built by `columnize` (conv_man.clj:79-88) over
# repness/participant-stats (math/repness.clj:383-413) — a GEOMETRIC
# per-participant stat (distance-to-center in the PCA-projected plane), not a
# vote-correlation stat. Confirmed live: a real clj-ref math_ptptstats row
# (real_data/.local/replays/poller_equiv/vw/main/clj-ref/batch-000/
# math_ptptstats.json) has EXACTLY these 6 keys, each a same-length array,
# with plain int pid/gid values — see TestDerivePtptstatsMatchesLiveClj below.
# --------------------------------------------------------------------------- #
class TestDerivePtptstatsMatchesLiveClj:
    """Structural fidelity against the ACTUAL clj-ref row captured in the live
    poller-equivalence store (2026-07-24 vw full-run — see the class
    docstring above for the exact path)."""

    _LIVE_CLJ_PTPTSTATS_PATH = (
        Path(__file__).resolve().parents[2]
        / "real_data" / ".local" / "replays" / "poller_equiv" / "vw" / "main"
        / "clj-ref" / "batch-000" / "math_ptptstats.json"
    )

    def test_live_clj_row_has_the_expected_columnar_key_set(self):
        """Sanity-checks the fixture itself is what this whole fix is based
        on — if this ever fails, the live evidence path/shape changed and
        the derive_ptptstats rewrite below needs re-deriving, not just this
        assertion patched."""
        if not self._LIVE_CLJ_PTPTSTATS_PATH.exists():
            pytest.skip("live poller-equiv store not present in this checkout")
        row = json.loads(self._LIVE_CLJ_PTPTSTATS_PATH.read_text())
        pt = row["data"]["ptptstats"]
        assert set(pt.keys()) == {"pid", "gid", "n-votes", "centricness", "coreness", "extremeness"}
        lengths = {len(v) for v in pt.values()}
        assert len(lengths) == 1  # every column is the SAME length (positionally aligned)
        assert all(isinstance(p, int) for p in pt["pid"])
        assert all(isinstance(g, int) for g in pt["gid"])

    def test_derive_ptptstats_output_has_the_same_key_set(self):
        conv = _fake_conv(
            base_clusters=[{"id": 0, "members": [1]}, {"id": 1, "members": [2]}],
            group_clusters=[{"id": 0, "members": [0, 1]}],
            proj={1: [0.0, 0.0], 2: [1.0, 0.0]},
        )
        result = derive_ptptstats(conv, 7, user_vote_counts={1: 3, 2: 4})
        assert set(result["ptptstats"].keys()) == {
            "pid", "gid", "n-votes", "centricness", "coreness", "extremeness",
        }


class TestDerivePtptstatsMath:
    """Hand-computed 3-participant / 2-group scenario — verifies the actual
    geometry (repness/participant-stats, math/repness.clj:383-413):

        global_center = mean(proj) = mean([0,0], [2,0], [10,0]) = [4, 0]
        group 0 = {pid 1, pid 2} (base clusters 0, 1)
          center0 = mean([0,0], [2,0]) = [1, 0]
          extreme_direction0 = normalise([1,0] - [4,0]) = normalise([-3,0]) = [-1, 0]
          pid 1 @ [0,0]: centricness = 1 - |[0,0]-[4,0]| = 1-4 = -3
                          coreness    = 1 - |[0,0]-[1,0]| = 1-1 =  0
                          extremeness = dot([0,0]-[1,0], [-1,0]) = dot([-1,0],[-1,0]) = 1
          pid 2 @ [2,0]: centricness = 1 - |[2,0]-[4,0]| = 1-2 = -1
                          coreness    = 1 - |[2,0]-[1,0]| = 1-1 =  0
                          extremeness = dot([2,0]-[1,0], [-1,0]) = dot([1,0],[-1,0])  = -1
        group 1 = {pid 3} (base cluster 2)
          center1 = mean([10,0]) = [10, 0]
          extreme_direction1 = normalise([10,0]-[4,0]) = normalise([6,0]) = [1, 0]
          pid 3 @ [10,0]: centricness = 1 - |[10,0]-[4,0]| = 1-6 = -5
                           coreness    = 1 - |[10,0]-[10,0]| = 1-0 = 1
                           extremeness = dot([10,0]-[10,0], [1,0]) = dot([0,0],[1,0]) = 0
    """

    def _conv(self):
        return _fake_conv(
            base_clusters=[
                {"id": 0, "members": [1]},
                {"id": 1, "members": [2]},
                {"id": 2, "members": [3]},
            ],
            group_clusters=[
                {"id": 0, "members": [0, 1]},  # base clusters 0+1 -> pids 1,2
                {"id": 1, "members": [2]},     # base cluster 2 -> pid 3
            ],
            proj={1: [0.0, 0.0], 2: [2.0, 0.0], 3: [10.0, 0.0]},
        )

    def test_hand_computed_geometry_matches_exactly(self):
        result = derive_ptptstats(self._conv(), 7, user_vote_counts={1: 5, 2: 7, 3: 9})
        pt = result["ptptstats"]
        assert pt["pid"] == [1, 2, 3]
        assert pt["gid"] == [0, 0, 1]
        assert pt["n-votes"] == [5, 7, 9]
        assert pt["centricness"] == pytest.approx([-3.0, -1.0, -5.0])
        assert pt["coreness"] == pytest.approx([0.0, 0.0, 1.0])
        assert pt["extremeness"] == pytest.approx([1.0, -1.0, 0.0])

    def test_envelope_keys_are_zid_ptptstats_lastvotetimestamp(self):
        result = derive_ptptstats(self._conv(), 7, user_vote_counts={1: 5, 2: 7, 3: 9})
        assert set(result.keys()) == {"zid", "ptptstats", "lastVoteTimestamp"}
        assert result["zid"] == 7

    def test_missing_vote_count_yields_none_matching_clojures_nil(self):
        """Clojure's `(get ptpt-vote-counts pid)` returns nil for a pid not
        in the map — mirror that as None, never a guessed 0."""
        result = derive_ptptstats(self._conv(), 7, user_vote_counts={1: 5})  # 2, 3 missing
        assert result["ptptstats"]["n-votes"] == [5, None, None]

    def test_no_groups_gives_an_empty_ptptstats_dict_not_empty_arrays(self):
        """Clojure's columnize on an empty stats seq returns `{}` (keys is
        nil on an empty seq), NOT a dict of empty-array columns."""
        conv = _fake_conv(group_clusters=[], base_clusters=[], proj={})
        result = derive_ptptstats(conv, 7, user_vote_counts={})
        assert result["ptptstats"] == {}

    def test_no_proj_gives_an_empty_ptptstats_dict(self):
        conv = _fake_conv(
            group_clusters=[{"id": 0, "members": []}], base_clusters=[], proj={},
        )
        result = derive_ptptstats(conv, 7, user_vote_counts={})
        assert result["ptptstats"] == {}

    def test_group_member_not_in_proj_is_skipped_not_a_crash(self):
        """A participant in a base-cluster's members but absent from `proj`
        (e.g. transient state) must not raise — just excluded from stats."""
        conv = _fake_conv(
            base_clusters=[{"id": 0, "members": [1, 99]}],  # 99 has no proj entry
            group_clusters=[{"id": 0, "members": [0]}],
            proj={1: [0.0, 0.0]},
        )
        result = derive_ptptstats(conv, 7, user_vote_counts={1: 1})
        assert result["ptptstats"]["pid"] == [1]

    def test_single_group_zero_direction_matches_clj_zero_extremeness(self):
        """The Q4-degenerate single-group case: ONE group covering every
        participant makes group center == global center BY CONSTRUCTION, so
        extreme-direction normalises a ZERO vector. #2657 review deduced from
        vectorz `AVector.toNormal()` bytecode that Clojure would get nil and
        crash — REFUTED empirically (2026-07-24, clojure -M on the pinned
        stack, journal s5): `(mat/normalise (mat/matrix [0.0 0.0]))` returns
        the ZERO VECTOR (not nil) and the extremeness dot is a clean 0.0.
        Python's `direction/norm if norm > 0 else direction` therefore
        MATCHES Clojure exactly here: extremeness 0.0 for every member, no
        divergence, nothing to ledger. This test pins that agreement."""
        conv = _fake_conv(
            base_clusters=[
                {"id": 0, "members": [1]},
                {"id": 1, "members": [2]},
            ],
            group_clusters=[{"id": 0, "members": [0, 1]}],  # ONE group = everyone
            proj={1: [-1.0, 0.0], 2: [1.0, 0.0]},  # global center == group center == [0,0]
        )
        result = derive_ptptstats(conv, 7, user_vote_counts={1: 2, 2: 2})
        stats = result["ptptstats"]
        assert stats["pid"] == [1, 2]
        assert stats["extremeness"] == [0.0, 0.0]
        # centricness == coreness here (same center), sanity-pinning the geometry
        assert stats["centricness"] == stats["coreness"] == [0.0, 0.0]


class TestDerivePtptstatsGroupOrderClojureHashMap:
    """Clojure's `group-data` map (conv_man.clj's `(into {} ...)` over
    group-clusters) is an ARRAY-map (insertion/group_clusters order) for <=8
    groups but a PersistentHashMap (HAMT id-hash order) for >8 — the EXACT
    same threshold legacy_kmeans.py's cleared-clusters scan order already
    documents and relies on (same clojure_hash_map_key_order utility)."""

    def test_at_most_8_groups_visited_in_group_clusters_order(self):
        from polismath.utils.clj_hash import clojure_hash_map_key_order

        # 8 groups, deliberately NOT in id-ascending order.
        ids = [7, 3, 5, 1, 8, 2, 6, 4]
        assert clojure_hash_map_key_order(ids) != ids  # sanity: hash order WOULD differ
        base_clusters = [{"id": i, "members": [i]} for i in ids]
        group_clusters = [{"id": gid, "members": [gid]} for gid in ids]
        proj = {i: [float(i), 0.0] for i in ids}
        conv = _fake_conv(base_clusters=base_clusters, group_clusters=group_clusters, proj=proj)

        result = derive_ptptstats(conv, 7, user_vote_counts={})
        # <=8 -> array-map -> INSERTION (group_clusters) order, not hash order.
        assert result["ptptstats"]["gid"] == ids

    def test_more_than_8_groups_visited_in_clojure_hash_map_order(self):
        from polismath.utils.clj_hash import clojure_hash_map_key_order

        ids = list(range(1, 10))  # 9 groups -> PersistentHashMap territory
        expected_order = clojure_hash_map_key_order(ids)
        assert expected_order != ids  # sanity: this scenario actually exercises hash order

        base_clusters = [{"id": i, "members": [i]} for i in ids]
        group_clusters = [{"id": gid, "members": [gid]} for gid in ids]
        proj = {i: [float(i), 0.0] for i in ids}
        conv = _fake_conv(base_clusters=base_clusters, group_clusters=group_clusters, proj=proj)

        result = derive_ptptstats(conv, 7, user_vote_counts={})
        assert result["ptptstats"]["gid"] == expected_order


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

    def test_ptptstats_written_uses_user_vote_counts_from_to_dict(self):
        """write_conv_updates must thread data["user-vote-counts"] (already
        computed once for math_main) into derive_ptptstats — not recompute
        it, and not silently drop it (n-votes would be all-None otherwise)."""
        client = MagicMock()
        client.increment_math_tick.return_value = 1
        conv = _fake_conv(
            zid=42,
            base_clusters=[{"id": 0, "members": [1]}],
            group_clusters=[{"id": 0, "members": [0]}],
            proj={1: [0.0, 0.0]},
        )
        conv.to_dict = lambda: {
            "base-clusters": {"id": [0], "members": [[1]]},
            "lastVoteTimestamp": 1234567,
            "user-vote-counts": {1: 42},
        }
        MathWriter(client).write_conv_updates(42, conv)

        call = client.write_participant_stats.call_args
        data = call.kwargs.get("data")
        if data is None:
            data = call.args[1]
        assert data["ptptstats"]["n-votes"] == [42]


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
