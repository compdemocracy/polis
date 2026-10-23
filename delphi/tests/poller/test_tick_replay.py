"""Replay of published ticks from ``math_recompute_log`` (no database).

``polismath.replay.tick_replay`` folds the log rows through ``compute_tick``
(which takes no database handle). Here the "live" side is simulated with the
same building blocks the poller uses (TickInputs with its moderation deltas,
compute_tick, the jsonb read-back of math_main, ``created`` re-stamped on an
overwrite); ``tests/poller/recovery/test_tick_replay_roundtrip.py`` runs the
real poller on a real Postgres. Pinned: every tick of a cold -> incremental ->
moderation -> warm_restore -> incremental chain replays to the published blob;
the rebuild digest is checked against the votes table, a vote a later tick of
the chain delivered is not a refusal, any other late vote is; NULL
``created``; refusals for a missing or unrecorded lineage, another engine
version and a tick-sequence reset; a chain of more restarts than the
recursion limit; the jsonb emulation; the CLI.
"""

import dataclasses
import json
from unittest.mock import patch

import pytest

from polismath.conversation.conversation import Conversation
from polismath.poller.compute_tick import RestoreSource, compute_tick
from polismath.poller.tick_inputs import COLD, WARM_RESTORE, TickInputs, engine_version
from polismath.replay.tick_replay import (
    ReplayRefused,
    TickReplayer,
    jsonb_roundtrip,
    replay_to_tick,
)

ZID = 44
ENV = "replaytest"
CLOCK_MS = 1700000000000
VERSION = engine_version()


def _votes(pids, tids, base, flip=()):
    out = []
    for pid in pids:
        for tid in tids:
            vote = -1 if (tid == 2 and pid % 2) or (pid, tid) in flip else 1
            out.append({"zid": ZID, "pid": pid, "tid": tid, "vote": vote,
                        "created": base + len(out)})
    return out


def _canonical(votes):
    """ORDER BY zid, tid, pid, created (NULL created last)."""
    return sorted(votes, key=lambda v: (v["tid"], v["pid"], v["created"] is None,
                                        v["created"] or 0))


MODS0 = {"mod_out_tids": [], "mod_in_tids": [], "meta_tids": [], "mod_out_ptpts": []}
MODS1 = {"mod_out_tids": [3], "mod_in_tids": [1], "meta_tids": [0], "mod_out_ptpts": []}
MODS2 = {"mod_out_tids": [], "mod_in_tids": [1, 3], "meta_tids": [0], "mod_out_ptpts": [5]}


def _strip(blob):
    blob = dict(blob)
    blob.pop("math_tick", None)
    return json.dumps(blob)


class Live:
    """What the poller does, tick by tick: compute, publish (jsonb read-back),
    log the inputs with moderation deltas against the chain's previous read,
    and re-stamp ``created`` when a tick number is written again."""

    def __init__(self, version=VERSION):
        self.version = version
        self.rows, self.published, self.table = {}, {}, []
        self.state, self.prev_tick, self.read = None, None, None
        self.clock = 0

    def _publish(self, tick, inputs, blob):
        published = jsonb_roundtrip(blob)
        inputs = dataclasses.replace(
            inputs, last_vote_timestamp=published["lastVoteTimestamp"],
            n_comments=len(published.get("comment-priorities") or {}))
        self.clock += 10
        self.rows[tick] = {"zid": ZID, "math_env": ENV, "math_tick": tick,
                           "created": self.clock, **inputs.to_row()}
        self.published[tick] = published
        self.prev_tick = tick
        if inputs.mod_read:
            self.read = inputs.mod_sets()

    def rebuild(self, tick, mods, *, restore=True, history=None):
        hist = _canonical(self.table) if history is None else history
        mode = WARM_RESTORE if restore else COLD
        inputs = TickInputs.rebuild(mode, prev_math_tick=self.prev_tick if restore else None,
                                    votes=hist, moderation=mods, version=self.version)
        source = None
        if restore:
            source = RestoreSource(self.published[self.prev_tick],
                                   self.rows[self.prev_tick]["last_vote_timestamp"])
        self.state, blob = compute_tick(source, inputs, zid=ZID, rebuild_votes=hist)
        self._publish(tick, inputs, blob)

    def step(self, tick, batch, mods=None):
        inputs = TickInputs.incremental(prev_math_tick=self.prev_tick, votes=batch,
                                        moderation=mods, version=self.version,
                                        mod_base=self.read)
        self.state, blob = compute_tick(self.state, inputs, zid=ZID)
        self._publish(tick, inputs, blob)

    def log(self):
        return list(self.rows.values())


@pytest.fixture(autouse=True)
def frozen_clock():
    with patch("time.time", return_value=CLOCK_MS / 1000):
        yield


def _chain(live):
    """Ticks 1..5: cold, two incremental (the second re-reads moderation),
    a warm restore (a restart), one more incremental re-reading moderation."""
    live.table += _votes(range(8), range(4), CLOCK_MS)
    live.table.append({"zid": ZID, "pid": 7, "tid": 3, "vote": 1, "created": None})
    live.rebuild(1, MODS0, restore=False)
    b2 = _votes(range(8, 11), range(4), CLOCK_MS + 1000)
    live.table += b2
    live.step(2, b2)
    b3 = _votes(range(3), range(4), CLOCK_MS + 2000, flip={(0, 0), (1, 1)})
    live.table += b3
    live.step(3, b3, MODS1)
    live.table += _votes(range(11, 13), range(4), CLOCK_MS + 3000)
    live.rebuild(4, MODS1)
    b5 = _votes(range(13, 15), range(4), CLOCK_MS + 4000)
    live.table += b5
    live.step(5, b5, MODS2)
    return live


@pytest.fixture
def live():
    return _chain(Live())


def test_every_tick_replays_to_its_published_blob(live):
    for tick in live.published:
        assert _strip(replay_to_tick(live.log(), _canonical(live.table), tick)) == \
            _strip(live.published[tick]), tick


def test_moderation_deltas_fold_back_to_the_sets_read(live):
    assert live.rows[5]["mod_out_tids_removed"] == [3]
    assert live.rows[5]["mod_in_tids_added"] == [3]
    assert live.rows[2]["mod_out_tids_added"] is None  # not read
    assert live.published[5]["mod-out"] == [3]  # sticky: an empty read keeps it


def test_a_range_replays_in_one_fold(live):
    table = _canonical(live.table)
    got = dict(TickReplayer(live.log(), lambda: table).ticks(2, 5))
    assert list(got) == [2, 3, 4, 5]
    assert all(_strip(got[t]) == _strip(live.published[t]) for t in got)


def test_a_late_vote_is_refused_by_the_digest(live):
    late = dict(live.table[0], created=CLOCK_MS + 2500, pid=99)  # created <= tick 4's read
    with pytest.raises(ReplayRefused, match=r"tick 4 .*digest.*late"):
        replay_to_tick(live.log(), _canonical(live.table + [late]), 4)
    # A vote created after the rebuild read is outside it: still replayable.
    after = dict(live.table[0], created=CLOCK_MS + 9000, pid=99)
    replay_to_tick(live.log(), _canonical(live.table + [after]), 4)


def test_a_late_commit_a_later_tick_delivered_is_not_a_refusal():
    """A vote stamped below a rebuild's read but committed after it is in the
    table at replay, yet the rebuild never saw it; the chain's next tick
    delivered it. Replay removes what later ticks of the chain delivered and
    re-checks the digest."""
    live = Live()
    live.table += _votes(range(6), range(4), CLOCK_MS)
    live.rebuild(1, MODS0, restore=False)                  # read through CLOCK_MS + 23
    late = {"zid": ZID, "pid": 40, "tid": 2, "vote": -1, "created": CLOCK_MS + 5}
    live.table.append(late)                                # committed after the read
    live.step(2, [late])                                   # the window delivers it
    table = _canonical(live.table)
    for tick in (1, 2):
        assert _strip(replay_to_tick(live.log(), table, tick)) == \
            _strip(live.published[tick])


def test_null_created_votes_replay(live):
    assert any(v["created"] is None for v in live.table)
    assert live.rows[1]["rebuild_through_created"] == CLOCK_MS + 31
    assert _strip(replay_to_tick(live.log(), _canonical(live.table), 4)) == \
        _strip(live.published[4])


def test_a_tick_missing_from_the_log_is_refused(live):
    table = _canonical(live.table)
    with pytest.raises(ReplayRefused, match="no math_recompute_log row for tick 9"):
        replay_to_tick(live.log(), table, 9)
    with pytest.raises(ReplayRefused, match="tick 2 continues tick 1, which has no"):
        replay_to_tick([r for r in live.log() if r["math_tick"] != 1], table, 2)


def test_an_incremental_tick_without_a_predecessor_is_refused(live):
    rows = [dict(r, prev_math_tick=None) if r["math_tick"] == 2 else r for r in live.log()]
    with pytest.raises(ReplayRefused, match="tick 2 .*no recorded predecessor"):
        replay_to_tick(rows, _canonical(live.table), 3)


def test_an_unrecorded_rebuild_row_is_refused(live):
    unrecorded = {"zid": ZID, "math_env": ENV, "math_tick": 1, "created": 0,
                  **TickInputs.unrecorded().to_row()}
    with pytest.raises(ReplayRefused, match="tick 1 .*not replayable"):
        replay_to_tick([unrecorded] + live.log()[1:], _canonical(live.table), 2)


@pytest.mark.parametrize("tick,changed", [(3, 2), (5, 2), (5, 4), (1, 1)])
@pytest.mark.parametrize("version", ["another-build", None])
def test_a_tick_computed_by_another_engine_version_is_refused(live, tick, changed, version):
    """Every row the replay folds counts, the warm restore's predecessor chain
    included (tick 5 restores through 4 from 3, 2, 1)."""
    rows = [dict(r, engine_version=version) if r["math_tick"] == changed else r
            for r in live.log()]
    table = _canonical(live.table)
    with pytest.raises(ReplayRefused, match=rf"tick {changed} .*engine_version"):
        replay_to_tick(rows, table, tick)
    assert _strip(replay_to_tick(rows, table, tick, allow_engine_mismatch=True)) == \
        _strip(live.published[tick])


def test_a_tick_sequence_reset_is_refused_not_replayed_wrong():
    """math_ticks removed: the sequence restarts and overwrites log rows 1..10
    (ON CONFLICT re-stamps created). Old tick 15 continues old 14..11 and then
    the NEW tick 10, which is not its predecessor: refused."""
    live = Live()
    live.table += _votes(range(6), range(3), CLOCK_MS)
    live.rebuild(1, MODS0, restore=False)
    for tick in range(2, 21):
        batch = _votes([20 + tick], range(3), CLOCK_MS + 1000 * tick)
        live.table += batch
        live.step(tick, batch)
    old_15 = live.published[15]
    live.prev_tick = None                       # the restarted sequence
    live.rebuild(1, MODS0, restore=False)
    for tick in range(2, 11):
        batch = _votes([60 + tick], range(3), CLOCK_MS + 100_000 + 1000 * tick)
        live.table += batch
        live.step(tick, batch)
    table = _canonical(live.table)
    with pytest.raises(ReplayRefused, match="tick 11 continues tick 10 .*reset"):
        replay_to_tick(live.log(), table, 15)
    assert _strip(replay_to_tick(live.log(), table, 10)) == _strip(live.published[10])
    assert _strip(live.published[15]) == _strip(old_15)


def test_more_restarts_than_the_recursion_limit():
    import sys

    live = Live()
    live.rebuild(1, MODS0, restore=False)
    n = sys.getrecursionlimit() + 50
    for tick in range(2, n):
        live.rebuild(tick, MODS0)               # a restart: warm restore, no votes
    assert _strip(replay_to_tick(live.log(), [], n - 1)) == _strip(live.published[n - 1])


def test_jsonb_roundtrip_orders_keys_and_normalises_numbers():
    out = jsonb_roundtrip({"bb": 1, "a": {"zz": 1e16, "y": -0.0, "x": 1e-07},
                           "ccc": [1.5e17, 2.0, 0.1, 1e23], 10: "int key"})
    assert list(out) == ["a", "10", "bb", "ccc"]
    assert list(out["a"]) == ["x", "y", "zz"]
    assert out["a"]["zz"] == 10**16 and isinstance(out["a"]["zz"], int)
    assert repr(out["a"]["y"]) == "0.0"
    assert out["a"]["x"] == 1e-07
    # numeric keeps the decimal text: 1e23 is 10**23, not int(1e23).
    assert out["ccc"] == [150000000000000000, 2.0, 0.1, 10**23]
    assert isinstance(out["ccc"][1], float)


# --------------------------------------------------------------------------- #
# scripts/replay_tick.py
# --------------------------------------------------------------------------- #
class _Pg:
    def __init__(self, rows, table):
        self.rows, self.table, self.calls = rows, table, []

    def read_recompute_log(self, zid, math_env=None):
        self.calls.append(("log", zid, math_env))
        return self.rows

    def poll_votes(self, zid, since):
        self.calls.append(("votes", zid, since))
        return self.table

    def shutdown(self):
        pass


def _run_cli(monkeypatch, capsys, pg, argv):
    from scripts import replay_tick as cli

    monkeypatch.setattr(cli, "_client", lambda url, env, ssl_mode=None: pg)
    code = cli.main(argv)
    out, err = capsys.readouterr()
    return code, out, err


ARGS = ["--zid", str(ZID), "--math-env", ENV, "--database-url", "postgresql://x/y"]


def test_cli_prints_the_blob_of_a_tick(live, monkeypatch, capsys):
    pg = _Pg(live.log(), _canonical(live.table))
    code, out, _ = _run_cli(monkeypatch, capsys, pg, ARGS + ["--tick", "3"])
    assert code == 0
    assert _strip(json.loads(out)) == _strip(live.published[3])
    assert ("log", ZID, ENV) in pg.calls and ("votes", ZID, None) in pg.calls


def test_cli_prints_one_field_per_tick_for_a_range(live, monkeypatch, capsys):
    code, out, _ = _run_cli(monkeypatch, capsys, _Pg(live.log(), _canonical(live.table)),
                            ARGS + ["--tick", "2", "--through", "4",
                                    "--field", "comment-priorities"])
    assert code == 0
    assert json.loads(out) == {str(t): live.published[t]["comment-priorities"]
                               for t in (2, 3, 4)}


def test_cli_refusal_exits_3_with_the_reason(live, monkeypatch, capsys):
    late = dict(live.table[0], created=CLOCK_MS + 10, pid=99)
    code, out, err = _run_cli(monkeypatch, capsys,
                              _Pg(live.log(), _canonical(live.table + [late])),
                              ARGS + ["--tick", "1"])
    assert code == 3 and out == ""
    assert "digest" in err


def test_cli_engine_version_mismatch(live, monkeypatch, capsys):
    rows = [dict(r, engine_version="another-build") for r in live.log()]
    pg = _Pg(rows, _canonical(live.table))
    code, out, err = _run_cli(monkeypatch, capsys, pg, ARGS + ["--tick", "2"])
    assert code == 3 and "engine_version" in err and "--allow-engine-mismatch" in err
    code, out, _ = _run_cli(monkeypatch, capsys, pg,
                            ARGS + ["--tick", "2", "--allow-engine-mismatch"])
    assert code == 0 and _strip(json.loads(out)) == _strip(live.published[2])


def test_cli_a_failed_restore_is_a_refusal_not_a_traceback(live, monkeypatch, capsys):
    def broken(cls, data, **kwargs):
        raise KeyError("pca")

    monkeypatch.setattr(Conversation, "from_dict", classmethod(broken))
    code, out, err = _run_cli(monkeypatch, capsys, _Pg(live.log(), _canonical(live.table)),
                              ARGS + ["--tick", "4"])
    assert code == 3 and out == "" and "restore" in err and "Traceback" not in err


def test_cli_a_malformed_row_is_a_refusal_not_a_traceback(live, monkeypatch, capsys):
    rows = [dict(r, vote_pids=[1]) if r["math_tick"] == 2 else r for r in live.log()]
    code, out, err = _run_cli(monkeypatch, capsys, _Pg(rows, _canonical(live.table)),
                              ARGS + ["--tick", "2"])
    assert code == 3 and out == "" and "tick 2" in err


def test_the_readme_examples_parse():
    """The commands delphi/README.md shows are accepted by the CLI as written."""
    import os
    import shlex

    from scripts import replay_tick as cli

    readme = os.path.join(os.path.dirname(__file__), "..", "..", "README.md")
    if not os.path.isfile(readme):
        pytest.skip("delphi/README.md is not packaged with the tests")
    with open(readme) as fh:
        section = fh.read().split("## Replaying a published math generation", 1)[1]
    section = section.split("\n## ", 1)[0].replace("\\\n", " ")
    commands = [line.strip() for line in section.splitlines()
                if line.strip().startswith("uv run python scripts/replay_tick.py")]
    assert len(commands) == 2
    parsed = [cli.build_parser().parse_args(shlex.split(c)[4:]) for c in commands]
    assert [(a.zid, a.math_env, a.tick, a.through, a.field) for a in parsed] == [
        (40523, "prod", 1200, None, None),
        (40523, "prod", 1200, 1250, "comment-priorities")]
