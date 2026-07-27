"""Clojure ``mod-update`` parity — ``Conversation.mod_update`` (MOD_RESTART_PORT_SPEC.md).

Pins the conversation.clj:846-884 reducer semantics that the existing
``update_moderation`` (replace-only-when-truthy) cannot express:

- un-moderation REMOVES a tid from a set (``disj``);
- ``is_meta`` rows land in BOTH mod-out and mod-in (and meta-tids);
- the reduce is order-sensitive within one batch (last row wins per tid);
- watermark = ``max(existing or 0, *modified)``;
- NO math recompute — sets and watermark only (Clojure's ``:moderation``
  message handler runs ``mod-update`` alone; math changes at the NEXT
  votes recompute).

RED observed 2026-07-22 (session 4): every test fails with AttributeError
(``mod_update`` does not exist); the semantic cases are also inexpressible
via ``update_moderation`` by construction (it never removes set members).
"""

import numpy as np
import pytest

from polismath.conversation.conversation import Conversation
from polismath.utils.engine_mode import ENGINE_MODE_ENV_VAR


@pytest.fixture
def legacy_mode(monkeypatch):
    monkeypatch.setenv(ENGINE_MODE_ENV_VAR, 'clojure-legacy')


def _conv(**sets):
    conv = Conversation("mod-parity-probe", last_updated=1)
    for attr, val in sets.items():
        setattr(conv, attr, set(val))
    return conv


def _row(tid, mod: int | None = 0, is_meta=False, modified=100):
    return {"tid": tid, "is_meta": is_meta, "mod": mod, "modified": modified}


class TestReducerSemantics:
    def test_mod_minus_one_conjs_mod_out_and_disjs_mod_in(self):
        conv = _conv(mod_in_tids={4})
        result = conv.mod_update([_row(4, mod=-1)])
        assert 4 in result.mod_out_tids
        assert 4 not in result.mod_in_tids
        assert 4 not in result.meta_tids

    def test_mod_plus_one_conjs_mod_in_and_disjs_mod_out(self):
        conv = _conv(mod_out_tids={9})
        result = conv.mod_update([_row(9, mod=1)])
        assert 9 in result.mod_in_tids
        assert 9 not in result.mod_out_tids

    def test_unmoderation_removes_from_both_sets(self):
        # mod=0 (neither -1 nor 1) disjs from BOTH sets — the removal
        # update_moderation cannot express.
        conv = _conv(mod_out_tids={5}, mod_in_tids={5})
        result = conv.mod_update([_row(5, mod=0)])
        assert 5 not in result.mod_out_tids
        assert 5 not in result.mod_in_tids

    def test_mod_none_behaves_as_disj(self):
        # Clojure (= mod -1)/(= mod 1) is false for nil -> disj everywhere.
        conv = _conv(mod_out_tids={2}, mod_in_tids={2})
        result = conv.mod_update([_row(2, mod=None)])
        assert 2 not in result.mod_out_tids
        assert 2 not in result.mod_in_tids

    def test_is_meta_lands_in_both_mod_sets_and_meta(self):
        conv = _conv()
        result = conv.mod_update([_row(7, mod=0, is_meta=True)])
        assert 7 in result.mod_out_tids
        assert 7 in result.mod_in_tids
        assert 7 in result.meta_tids

    def test_meta_unset_disjs_meta_tids(self):
        conv = _conv(meta_tids={3})
        result = conv.mod_update([_row(3, mod=1, is_meta=False)])
        assert 3 not in result.meta_tids
        assert 3 in result.mod_in_tids

    def test_order_sensitive_last_row_wins(self):
        conv = _conv()
        fwd = conv.mod_update([_row(3, mod=-1), _row(3, mod=1)])
        assert 3 in fwd.mod_in_tids and 3 not in fwd.mod_out_tids
        rev = conv.mod_update([_row(3, mod=1), _row(3, mod=-1)])
        assert 3 in rev.mod_out_tids and 3 not in rev.mod_in_tids


class TestWatermark:
    def test_watermark_max_of_existing_and_rows(self):
        conv = _conv()
        conv.last_mod_timestamp = 500
        result = conv.mod_update([_row(1, modified=200), _row(2, modified=900)])
        assert result.last_mod_timestamp == 900

    def test_watermark_never_regresses(self):
        conv = _conv()
        conv.last_mod_timestamp = 500
        result = conv.mod_update([_row(1, modified=200)])
        assert result.last_mod_timestamp == 500

    def test_watermark_from_none_starts_at_zero_floor(self):
        conv = _conv()
        assert conv.last_mod_timestamp is None
        result = conv.mod_update([_row(1, modified=250)])
        assert result.last_mod_timestamp == 250

    def test_empty_mods_floors_none_watermark_at_zero(self):
        # (apply max (or nil 0) '()) = 0 — Clojure's load-or-init calls
        # mod-update with the (possibly empty) full mod history.
        conv = _conv()
        result = conv.mod_update([])
        assert result.last_mod_timestamp == 0

    def test_empty_mods_preserves_existing_watermark(self):
        conv = _conv()
        conv.last_mod_timestamp = 42
        result = conv.mod_update([])
        assert result.last_mod_timestamp == 42


class TestWatermarkDroppedByRecompute:
    """Clojure's ``conv-update`` is a plumbing-graph compile whose output map
    has ONLY graph-node keys — ``:last-mod-timestamp`` is not one
    (conversation.clj:780-820), so EVERY votes tick drops the mod watermark;
    it is blob-visible only on ticks whose last write was a mod-update.
    Observed on the vw restart probe (2026-07-22 s4): restart mod-update set
    the watermark, the next conv-update's blob emitted null."""

    BATCH = {
        "votes": [
            {"pid": 0, "tid": 0, "vote": 1, "created": 10},
            {"pid": 1, "tid": 0, "vote": -1, "created": 20},
        ],
        "lastVoteTimestamp": 20,
    }

    def test_votes_recompute_drops_watermark_in_legacy_mode(self, legacy_mode):
        conv = Conversation("wm-drop", last_updated=1)
        conv = conv.mod_update([_row(0, mod=-1, modified=777)])
        assert conv.last_mod_timestamp == 777
        conv2 = conv.update_votes(dict(self.BATCH), recompute=True)
        assert conv2.last_mod_timestamp is None


class TestGroupVotesTallyRawMatrix:
    """Clojure's group-votes aggregates votes-base, whose fnk reads
    RAW-rating-mat (conversation.clj:601-608): moderated-out comments report
    the ACTUAL votes cast (and true seen-counts), not the post-zeroing
    pass-shaped columns. Found on pc-meta-01 step 1 (2026-07-22 s4): python
    tallied the zeroed rating_mat -> A=0/D=0 with S inflated to every member
    ("everyone passed"), where Clojure reports the real A/D/S."""

    @staticmethod
    def _moderated_conv():
        """4 ptpts; tid 0 gets A=3/D=1 then is moderated OUT; the next votes
        tick applies the moderation (zeroed rating_mat) and recomputes."""
        conv = Conversation("gv-raw", last_updated=1)
        votes = []
        for pid, (v0, v1) in enumerate([(1, 1), (1, -1), (-1, -1), (1, 1)]):
            votes.append({"pid": pid, "tid": 0, "vote": v0, "created": 10 + pid})
            votes.append({"pid": pid, "tid": 1, "vote": v1, "created": 20 + pid})
        conv = conv.update_votes({"votes": votes, "lastVoteTimestamp": 30},
                                 recompute=False)
        conv = conv.recompute()
        conv = conv.mod_update([_row(0, mod=-1, modified=100)])
        return conv.update_votes(
            {"votes": [{"pid": 0, "tid": 1, "vote": 1, "created": 40}],
             "lastVoteTimestamp": 40},
            recompute=True,
        )

    def test_legacy_group_votes_report_actual_votes_for_moderated_tid(self, legacy_mode):
        # group-votes must still tally tid 0's REAL votes post-moderation.
        gv = self._moderated_conv().group_votes
        assert gv, "expected at least one group"
        tot_a = sum(g["votes"][0]["A"] for g in gv.values())
        tot_d = sum(g["votes"][0]["D"] for g in gv.values())
        tot_s = sum(g["votes"][0]["S"] for g in gv.values())
        assert (tot_a, tot_d) == (3, 1)
        assert tot_s == 4

    def test_legacy_to_dynamo_dict_group_votes_tally_raw_matrix(self, legacy_mode):
        # #2656 review finding 4: the THIRD inline group-votes tally
        # (to_dynamo_dict) must obey the same raw-matrix rule as
        # _compute_group_votes and to_dict — not the zeroed rating_mat.
        dyn = self._moderated_conv().to_dynamo_dict()
        gv = dyn["group_votes"]
        assert gv, "expected at least one group"
        tot_a = sum(g["votes"][0]["agree"] for g in gv.values())
        tot_d = sum(g["votes"][0]["disagree"] for g in gv.values())
        tot_s = sum(g["votes"][0]["total"] for g in gv.values())
        assert (tot_a, tot_d) == (3, 1)
        assert tot_s == 4


class TestNoRecomputeAndImmutability:
    def test_math_state_untouched(self):
        conv = _conv()
        sentinel_pca = {"center": np.array([0.5]), "comps": np.array([[1.0], [0.0]])}
        conv.pca = sentinel_pca
        conv.base_clusters = [{"id": 0, "members": [1], "center": [0.0, 0.0]}]
        result = conv.mod_update([_row(6, mod=-1)])
        assert result.base_clusters == conv.base_clusters
        assert result.pca is not None
        np.testing.assert_array_equal(result.pca["center"], sentinel_pca["center"])

    def test_returns_new_conversation_original_untouched(self):
        conv = _conv(mod_out_tids={8})
        result = conv.mod_update([_row(8, mod=0)])
        assert result is not conv
        assert 8 in conv.mod_out_tids
        assert 8 not in result.mod_out_tids
