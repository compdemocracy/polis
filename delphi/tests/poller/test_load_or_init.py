"""load-or-init + the from_dict restoration finding.

These tests LOCK the finding documented in polismath/poller/__init__.py:
``Conversation.from_dict`` restores warm state (pca, moderation, counts — and,
since the 2026-07-24 restart-seam fix, zid, base_clusters and group_votes,
mirroring what restructure-json-conv keeps, conv_man.clj:171-186) but NOT the
rating matrices or the group-clusterings/smoother memory, so load-or-init must
ALWAYS rebuild the matrices from the full vote history (conv_man.clj:188-207).
"""

import time
from unittest.mock import MagicMock

from polismath.conversation.conversation import Conversation
from polismath.poller.service import MathPollerService, PollerConfig


def _empty_mods():
    return {"mod_out_tids": [], "mod_in_tids": [], "meta_tids": [], "mod_out_ptpts": []}


def _build_votes(n_ptpts=8, n_cmts=5, created0=1000):
    """Two opposing camps so PCA + base clusters are non-trivial."""
    votes = []
    created = created0
    for p in range(n_ptpts):
        camp = 1 if p % 2 == 0 else -1
        for t in range(n_cmts):
            votes.append(
                {"pid": str(p), "tid": str(t), "vote": camp, "created": created}
            )
            created += 1
    return votes


class TestFromDictFinding:
    def test_from_dict_restores_pca_and_moderation_but_not_matrices(self):
        conv = Conversation("42")
        conv = conv.update_moderation({"mod_out_tids": ["3"]}, recompute=False)
        conv = conv.update_votes(
            {"votes": _build_votes(), "lastVoteTimestamp": 9999}, recompute=True
        )

        # Preconditions: the live conv has populated matrices + pca + clusters.
        assert conv.raw_rating_mat.size > 0
        assert conv.pca is not None

        blob = conv.to_dict()
        restored = Conversation.from_dict(blob)

        # RESTORED (warm state): pca, moderation, counts — and, since the
        # restart-seam fix (journal 2026-07-24), zid + base clusters
        # (id/members faithful — the warm-start lineage input) + group-votes,
        # exactly what restructure-json-conv keeps (conv_man.clj:171-186).
        assert restored.pca is not None
        assert set(restored.mod_out_tids) == {"3"}
        assert restored.participant_count == conv.participant_count
        assert restored.conversation_id == "42"
        assert [c["id"] for c in restored.base_clusters] == \
            [c["id"] for c in conv.base_clusters]
        assert [c["members"] for c in restored.base_clusters] == \
            [c["members"] for c in conv.base_clusters]

        # NOT RESTORED: the vote matrices (and the per-k clusterings/smoother
        # memory) — hence a full rebuild is mandatory in load-or-init.
        assert restored.raw_rating_mat.size == 0
        assert restored.rating_mat.size == 0
        assert restored.group_clusterings == {}
        assert restored.group_k_smoother == {}


class TestLoadOrInit:
    def test_cold_start_when_no_math_main_row(self):
        pg = MagicMock()
        pg.load_math_main.return_value = None
        pg.poll_votes.return_value = _build_votes()
        pg.poll_moderation.return_value = {
            "mod_out_tids": [], "mod_in_tids": [], "meta_tids": [], "mod_out_ptpts": []
        }
        svc = MathPollerService(pg, PollerConfig())

        conv = svc._load_or_init(42)

        assert isinstance(conv, Conversation)
        # Full-history rebuild always runs (offset-0 analog).
        pg.poll_votes.assert_called_once_with(42, None)
        pg.poll_moderation.assert_called_once_with(42, None)
        assert conv.raw_rating_mat.size > 0

    def test_warm_restore_then_full_rebuild(self):
        # Produce a real math_main blob from a computed conversation.
        seed = Conversation("42")
        seed = seed.update_votes(
            {"votes": _build_votes(), "lastVoteTimestamp": 9999}, recompute=True
        )
        blob = seed.to_dict()

        pg = MagicMock()
        pg.load_math_main.return_value = {"zid": 42, "data": blob}
        pg.poll_votes.return_value = _build_votes()
        pg.poll_moderation.return_value = {
            "mod_out_tids": [], "mod_in_tids": [], "meta_tids": [], "mod_out_ptpts": []
        }
        svc = MathPollerService(pg, PollerConfig())

        conv = svc._load_or_init(42)

        assert isinstance(conv, Conversation)
        # Even with a warm row, matrices are rebuilt from full vote history.
        pg.poll_votes.assert_called_once_with(42, None)
        assert conv.raw_rating_mat.size > 0
        assert conv.pca is not None

    def test_cold_start_conversation_id_is_the_native_int_zid(self):
        """2026-07-24 live finding (session 3): service.py used to construct
        ``Conversation(str(zid), last_updated=1)`` — a Type mismatch against
        Clojure's int zid showed up live as ``step_0.zid`` (and every
        ``tids[i]``/``repness.*.tid``, fixed separately in postgres.py) in a
        real vw poller-equivalence full-run. ``Conversation.__init__`` just
        does a bare ``self.conversation_id = conversation_id`` (no
        string-specific logic; grepped every ``.conversation_id`` use site —
        the only ``str()`` casts are at the DynamoDB boundary,
        database/dynamodb.py, which already handles either type
        defensively), so passing the int through is a one-point fix."""
        pg = MagicMock()
        pg.load_math_main.return_value = None
        pg.poll_votes.return_value = _build_votes()
        pg.poll_moderation.return_value = _empty_mods()
        svc = MathPollerService(pg, PollerConfig())

        conv = svc._load_or_init(42)

        assert conv.conversation_id == 42
        assert isinstance(conv.conversation_id, int)

    def test_cold_start_to_dict_zid_is_int(self):
        """The observable, live-evidence-matching field: to_dict()['zid']
        (conversation.py:2379 renames conversation_id -> zid at emission)."""
        pg = MagicMock()
        pg.load_math_main.return_value = None
        pg.poll_votes.return_value = _build_votes()
        pg.poll_moderation.return_value = _empty_mods()
        svc = MathPollerService(pg, PollerConfig())

        conv = svc._load_or_init(42)

        assert conv.to_dict()["zid"] == 42
        assert isinstance(conv.to_dict()["zid"], int)

    def test_from_dict_failure_falls_back_to_cold(self, monkeypatch):
        pg = MagicMock()
        pg.load_math_main.return_value = {"zid": 42, "data": {"garbage": object()}}
        pg.poll_votes.return_value = _build_votes()
        pg.poll_moderation.return_value = {
            "mod_out_tids": [], "mod_in_tids": [], "meta_tids": [], "mod_out_ptpts": []
        }

        # Force from_dict to raise to exercise the guarded fallback.
        def boom(cls, data):
            raise ValueError("bad blob")

        monkeypatch.setattr(Conversation, "from_dict", classmethod(boom))
        svc = MathPollerService(pg, PollerConfig())

        conv = svc._load_or_init(42)
        assert isinstance(conv, Conversation)
        assert conv.raw_rating_mat.size > 0


class TestLastVoteTimestampSeed:
    """T7: a cold rebuild must resolve last_updated to true max(created), not the
    wall-clock leaked by Conversation's `last_updated or now` footgun (which
    advance_watermark can never regress). Clojure floors at 0 (conversation.clj:161-165)."""

    def test_cold_start_last_updated_is_max_created_not_wall_clock(self):
        pg = MagicMock()
        pg.load_math_main.return_value = None
        votes = _build_votes(created0=1000)
        pg.poll_votes.return_value = votes
        pg.poll_moderation.return_value = _empty_mods()
        svc = MathPollerService(pg, PollerConfig())

        wall_clock_before = int(time.time() * 1000)
        conv = svc._load_or_init(42)

        max_created = max(v["created"] for v in votes)
        assert conv.last_updated == max_created
        # The historical timestamps are ~1e3 ms; a wall-clock leak would be ~1e12.
        assert conv.last_updated < wall_clock_before

    def test_warm_restore_last_updated_from_history_not_wall_clock(self):
        seed = Conversation("42").update_votes(
            {"votes": _build_votes(), "lastVoteTimestamp": 9999}, recompute=True
        )
        blob = seed.to_dict()
        votes = _build_votes(created0=1000)
        max_created = max(v["created"] for v in votes)

        pg = MagicMock()
        # The persisted row carries a correct (historical) last_vote_timestamp.
        pg.load_math_main.return_value = {
            "zid": 42, "data": blob, "last_vote_timestamp": max_created,
        }
        pg.poll_votes.return_value = votes
        pg.poll_moderation.return_value = _empty_mods()
        svc = MathPollerService(pg, PollerConfig())

        wall_clock_before = int(time.time() * 1000)
        conv = svc._load_or_init(42)

        assert conv.last_updated == max_created
        assert conv.last_updated < wall_clock_before

    def test_zero_votes_cold_start_floors_last_updated_to_zero(self):
        """A conversation with NO votes at all (e.g. moderation-only activity)
        must emit lastVoteTimestamp=0 (the Clojure floor, conversation.clj:161-165),
        not the internal nonzero constructor-dodge seed."""
        pg = MagicMock()
        pg.load_math_main.return_value = None
        pg.poll_votes.return_value = []
        pg.poll_moderation.return_value = _empty_mods()
        svc = MathPollerService(pg, PollerConfig())

        conv = svc._load_or_init(42)

        assert conv.last_updated == 0
        assert conv.to_dict()["lastVoteTimestamp"] == 0

    def test_persisted_zero_last_vote_timestamp_is_preserved(self):
        """A legitimately persisted last_vote_timestamp of 0 must be preserved,
        not coerced to 1 by a falsy-`or` default."""
        seed = Conversation("42").update_votes(
            {"votes": _build_votes(), "lastVoteTimestamp": 9999}, recompute=True
        )
        blob = seed.to_dict()

        pg = MagicMock()
        pg.load_math_main.return_value = {
            "zid": 42, "data": blob, "last_vote_timestamp": 0,
        }
        pg.poll_votes.return_value = []
        pg.poll_moderation.return_value = _empty_mods()
        svc = MathPollerService(pg, PollerConfig())

        conv = svc._load_or_init(42)

        assert conv.last_updated == 0
