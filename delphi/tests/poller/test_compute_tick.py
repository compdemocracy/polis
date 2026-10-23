"""``compute_tick``: the one function the live poller and replay both call
(PROPENSITY-LOGGING-DESIGN.md §9).

Pinned here, without a database: each start mode computes exactly what the
pre-refactor inline chain computed (``_compute_and_publish`` for an
incremental tick, ``_load_or_init`` for a rebuild); the sticky moderation set
is reproduced, not fixed; and compute_tick takes no database handle at all,
so replay needs none: no mode touches the database client.
"""

import inspect
import json
from unittest.mock import patch

import pytest

from polismath.conversation.conversation import Conversation
from polismath.poller.compute_tick import (
    RestoreFailed,
    RestoreSource,
    compute_tick,
)
from polismath.poller.math_writer import render_main_blob
from polismath.poller.service import advance_watermark
from polismath.poller.tick_inputs import COLD, WARM_RESTORE, TickInputs

ZID = 31
CLOCK_MS = 1700000000000


def _votes(participants=12, statements=4, start=0, base=CLOCK_MS):
    votes = []
    for pid in range(start, start + participants):
        for tid in range(statements):
            vote = -1 if tid == 2 and pid % 2 else 1
            votes.append({"zid": ZID, "pid": pid, "tid": tid, "vote": vote,
                          "created": base + len(votes)})
    return votes


MODS = {"mod_out_tids": [3], "mod_in_tids": [1], "meta_tids": [0], "mod_out_ptpts": []}


def _canon(blob):
    blob = dict(blob)
    blob.pop("math_tick", None)  # wall-clock cosmetic
    return json.dumps(blob, default=str)


def _old_cold_chain(votes, mods):
    """``_load_or_init`` before the refactor, cold branch."""
    conv = Conversation(ZID, last_updated=1)
    conv.last_updated = 0
    if votes:
        last_ts = advance_watermark(conv.last_updated, (v["created"] for v in votes))
        conv = conv.update_votes({"votes": votes, "lastVoteTimestamp": last_ts},
                                 recompute=False)
    conv = conv.update_moderation(mods, recompute=False)
    return conv.recompute()


@pytest.fixture(autouse=True)
def frozen_clock():
    with patch("time.time", return_value=CLOCK_MS / 1000):
        yield


class DatabaseTouched(AssertionError):
    pass


@pytest.fixture
def no_database(monkeypatch):
    """Every way polismath reaches Postgres raises while the test runs."""
    from polismath.database.postgres import PostgresClient

    def touched(name):
        def raise_(*_a, **_k):
            raise DatabaseTouched(name)
        return raise_

    for name in ("initialize", "query", "transaction", "session", "_write_returning",
                 "_vote_rows", "poll_votes", "poll_votes_since", "poll_moderation",
                 "load_math_main"):
        monkeypatch.setattr(PostgresClient, name, touched(name))
    import psycopg2
    monkeypatch.setattr(psycopg2, "connect", touched("psycopg2.connect"))


def test_compute_tick_takes_no_database_handle():
    params = set(inspect.signature(compute_tick).parameters)
    assert params == {"prev_state", "inputs", "zid", "rebuild_votes", "reset_moderation",
                      "after_moderation"}


def test_no_mode_touches_the_database(no_database):
    votes = _votes()
    cold = TickInputs.rebuild(COLD, prev_math_tick=None, votes=votes, moderation=MODS,
                              version=None)
    state, blob = compute_tick(None, cold, zid=ZID, rebuild_votes=votes)
    persisted = json.loads(json.dumps(blob, default=str))
    warm = TickInputs.rebuild(WARM_RESTORE, prev_math_tick=1, votes=votes, moderation=MODS,
                              version=None)
    compute_tick(RestoreSource(persisted, state.last_updated), warm, zid=ZID,
                 rebuild_votes=votes)
    batch = _votes(participants=2, start=12, base=CLOCK_MS + 50_000)
    step = TickInputs.incremental(prev_math_tick=1, votes=batch, moderation=MODS,
                                  version=None)
    compute_tick(state, step, zid=ZID)


def test_cold_matches_the_old_load_or_init_chain():
    votes = _votes()
    inputs = TickInputs.rebuild(COLD, prev_math_tick=None, votes=votes, moderation=MODS,
                                version=None)
    state, blob = compute_tick(None, inputs, zid=ZID, rebuild_votes=votes)
    old = _old_cold_chain(votes, MODS)
    assert _canon(blob) == _canon(render_main_blob(old, ZID))
    assert state.last_updated == old.last_updated == votes[-1]["created"]


def test_cold_with_no_votes():
    inputs = TickInputs.rebuild(COLD, prev_math_tick=None, votes=[], moderation=MODS,
                                version=None)
    _, blob = compute_tick(None, inputs, zid=ZID, rebuild_votes=[])
    assert _canon(blob) == _canon(render_main_blob(_old_cold_chain([], MODS), ZID))
    assert blob["lastVoteTimestamp"] == 0


def test_warm_restore_matches_the_old_load_or_init_chain():
    first = _votes()
    prev = _old_cold_chain(first, MODS)
    persisted = json.loads(json.dumps(render_main_blob(prev, ZID), default=str))
    history = first + _votes(participants=3, start=12, base=CLOCK_MS + 10_000)
    inputs = TickInputs.rebuild(WARM_RESTORE, prev_math_tick=5, votes=history,
                                moderation=MODS, version=None)
    _, blob = compute_tick(RestoreSource(persisted, prev.last_updated), inputs,
                           zid=ZID, rebuild_votes=history)

    old = Conversation.from_dict(persisted)
    old.last_updated = prev.last_updated
    last_ts = advance_watermark(old.last_updated, (v["created"] for v in history))
    old = old.update_votes({"votes": history, "lastVoteTimestamp": last_ts},
                           recompute=False)
    old = old.update_moderation(MODS, recompute=False).recompute()
    assert _canon(blob) == _canon(render_main_blob(old, ZID))


def test_a_null_persisted_timestamp_restores_at_the_zero_floor():
    prev = _old_cold_chain(_votes(), MODS)
    persisted = json.loads(json.dumps(render_main_blob(prev, ZID), default=str))
    inputs = TickInputs.rebuild(WARM_RESTORE, prev_math_tick=5, votes=[], moderation=MODS,
                                version=None)
    state, _ = compute_tick(RestoreSource(persisted, None), inputs, zid=ZID,
                            rebuild_votes=[])
    assert state.last_updated == 0


def test_an_unrestorable_blob_raises_restore_failed():
    inputs = TickInputs.rebuild(WARM_RESTORE, prev_math_tick=5, votes=[], moderation=MODS,
                                version=None)
    with pytest.raises(RestoreFailed):
        compute_tick(RestoreSource({"pca": "not a pca"}, 1), inputs, zid=ZID,
                     rebuild_votes=[])


def test_a_rebuild_refuses_votes_that_do_not_match_its_descriptor():
    votes = _votes()
    inputs = TickInputs.rebuild(COLD, prev_math_tick=None, votes=votes, moderation=MODS,
                                version=None)
    with pytest.raises(ValueError, match="rebuild_n_votes"):
        compute_tick(None, inputs, zid=ZID, rebuild_votes=votes[:-1])


def test_incremental_matches_the_old_compute_and_publish_chain():
    base = _old_cold_chain(_votes(), MODS)
    batch = _votes(participants=2, start=12, base=CLOCK_MS + 50_000)
    for mods in (None, {"mod_out_tids": [2], "mod_in_tids": [], "meta_tids": [0],
                        "mod_out_ptpts": [5]}):
        inputs = TickInputs.incremental(prev_math_tick=3, votes=batch, moderation=mods,
                                        version=None)
        state, blob = compute_tick(base, inputs, zid=ZID)

        old = base
        last_ts = advance_watermark(old.last_updated, (v["created"] for v in batch))
        old = old.update_votes({"votes": batch, "lastVoteTimestamp": last_ts},
                               recompute=False)
        if mods is not None:
            old = old.update_moderation(mods, recompute=False)
        old = old.recompute()
        assert _canon(blob) == _canon(render_main_blob(old, ZID))
        assert state.last_updated == old.last_updated


def test_a_moderation_only_tick():
    base = _old_cold_chain(_votes(), MODS)
    mods = {"mod_out_tids": [1], "mod_in_tids": [], "meta_tids": [], "mod_out_ptpts": []}
    inputs = TickInputs.incremental(prev_math_tick=3, votes=[], moderation=mods,
                                    version=None)
    _, blob = compute_tick(base, inputs, zid=ZID)
    old = base.update_moderation(mods, recompute=False).recompute()
    assert _canon(blob) == _canon(render_main_blob(old, ZID))


def test_the_mod_out_set_stays_sticky():
    """An empty read never clears the engine's mod-out set (conversation.py
    ``if mod_out_tids:``): reproduced, not fixed."""
    base = _old_cold_chain(_votes(), MODS)
    cleared = {"mod_out_tids": [], "mod_in_tids": [], "meta_tids": [], "mod_out_ptpts": []}
    inputs = TickInputs.incremental(prev_math_tick=3, votes=[], moderation=cleared,
                                    version=None)
    state, blob = compute_tick(base, inputs, zid=ZID)
    assert state.mod_out_tids == {3}
    assert blob["mod-out"] == [3]
