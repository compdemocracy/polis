"""The drift guard: every generation the REAL poller publishes replays exactly.

PROPENSITY-LOGGING-DESIGN.md §9 "What keeps them in lockstep", item 2. A real
``MathPollerService`` runs on a fresh migrated Postgres (this package's
``pg_url``: one database per test, so nothing is shared and the test is not
serial) over a scripted stream:

* vote bursts across several polls (incremental ticks), a revote, and a
  superseded late vote the poll window drops;
* a vote with a NULL ``created`` (in every full-history read, never polled);
* a vote on a new cell stamped below the previous tick's lastVoteTimestamp
  but inside the overlap window (delivered late);
* two polls coalesced into one batch while the worker is held, so the
  delivered order is poll A then poll B, not the canonical (tid, pid) order a
  single poll returns;
* a moderation flip: a comment moderated out, then moderated in (the mod-out
  set stays sticky), a meta flag, and a moderation-only tick;
* a forced LRU eviction (``conv_cache_cap=1`` and a second conversation): the
  next touch restores warm from ``math_main``;
* a restore that fails, falling back to a cold rebuild;
* a service restart (a new service on the same database: warm restore), then
  a vote stamped below that rebuild's read but committed after it, which the
  next poll delivers (replay must not refuse the rebuild for it);
* afterwards, a tick-sequence reset (``math_ticks`` removed).

Every publication's ``math_main`` row is captured right after it commits
(the writer is wrapped; it is otherwise the production writer). Each published
tick is then replayed from ``math_recompute_log`` and the votes read once,
with every database method of PostgresClient made to raise, and compared with
the captured blob, whole, bit for bit through its JSON text, except the
cosmetic wall-clock ``math_tick`` key. Refusals are checked too: a vote
committed late and never delivered, another engine version, and the ticks
whose predecessor the reset overwrote.
"""

import json
import threading
import time
from typing import Any

import pytest
import sqlalchemy as sa

from polismath.conversation.conversation import Conversation
from polismath.database.postgres import PostgresClient
from polismath.replay.tick_replay import ReplayRefused, TickReplayer, jsonb_roundtrip
from tests.vote_fixtures import AGREE, DISAGREE, PASS, seed_vote

from .conftest import commit_vote, seed_conversation

pytestmark = pytest.mark.recovery

ENV = "tickreplay"


def _strip(blob: dict[str, Any]) -> str:
    blob = dict(blob)
    blob.pop("math_tick", None)  # 25000 + time.time() % 10000: wall clock only
    return json.dumps(blob)


class Capture:
    """Wraps a service's writer: after each publication commits, read the
    published math_main row back, as the server (and a restore) reads it."""

    def __init__(self, engine):
        self.engine = engine
        self.published: dict[tuple[int, int], dict[str, Any]] = {}

    def attach(self, svc):
        real = svc._writer.write_conv_updates

        def write_conv_updates(zid, conv, **kwargs):
            tick = real(zid, conv, **kwargs)
            with self.engine.connect() as conn:
                row = conn.execute(
                    sa.text("SELECT math_tick, data FROM math_main "
                            "WHERE zid = :z AND math_env = :e"),
                    {"z": zid, "e": ENV}).mappings().one()
            assert row["math_tick"] == tick
            self.published[(zid, tick)] = row["data"]
            return tick

        svc._writer.write_conv_updates = write_conv_updates


def _moderate(engine, zid, tid, *, mod=None, is_meta=None):
    sets = ["modified = :modified"]
    if mod is not None:
        sets.append("mod = :mod")
    if is_meta is not None:
        sets.append("is_meta = :is_meta")
    with engine.begin() as conn:
        conn.execute(sa.text(f"UPDATE comments SET {', '.join(sets)} "
                             "WHERE zid = :zid AND tid = :tid"),
                     {"zid": zid, "tid": tid, "mod": mod, "is_meta": is_meta,
                      "modified": int(time.time() * 1000)})


def _pattern(pid, tid):
    """Varied, deterministic votes (three loose camps plus noise), so PCA and
    the clustering are not degenerate."""
    h = (pid * 7919 + tid * 104729) % 23
    if h < 3:
        return PASS
    return AGREE if (pid % 3 == tid % 3) != (h < 6) else DISAGREE


def _log(svc, zid):
    return svc._pg.read_recompute_log(zid, ENV)


def _hold_first_compute(svc, zid):
    """Hold the worker inside the next computation for ``zid`` until released."""
    arrived, release = threading.Event(), threading.Event()
    real = svc._compute_and_publish
    armed = [True]

    def held(z, conv, coalesced):
        if armed[0] and z == zid:
            armed[0] = False
            arrived.set()
            assert release.wait(60), "never released"
        return real(z, conv, coalesced)

    svc._compute_and_publish = held
    return arrived, release


@pytest.fixture
def no_database(monkeypatch):
    """Arms a patch making every database method of PostgresClient raise."""
    def arm():
        def touched(name):
            def raise_(*_a, **_k):
                raise AssertionError(f"replay touched the database: {name}")
            return raise_
        for name in ("initialize", "query", "transaction", "session", "_write_returning",
                     "_vote_rows", "poll_votes", "poll_votes_since", "poll_moderation",
                     "load_math_main", "read_recompute_log"):
            monkeypatch.setattr(PostgresClient, name, touched(name))
    return arm


def test_every_published_tick_replays_bit_for_bit(engine, pg_url, make_service, capsys,
                                                  monkeypatch, no_database):
    clock = [int(time.time() * 1000)]

    def tick_clock(step=7):
        clock[0] += step
        return clock[0]

    def vote(zid, pid, tid, semantic, created=None):
        commit_vote(engine, zid, pid, tid, seed_vote(semantic),
                    tick_clock() if created is None else created)

    capture = Capture(engine)
    seed_conversation(engine, zid=1, n_ptpts=40, n_cmts=6,
                      vote_pattern=lambda pid, tid: seed_vote(_pattern(pid, tid)))
    with engine.begin() as conn:                     # a vote whose created IS NULL
        conn.execute(sa.text("SET session_replication_role = replica"))
        conn.execute(sa.text("INSERT INTO votes (zid, pid, tid, vote, created) "
                             "VALUES (1, 70, 0, :v, NULL)"), {"v": seed_vote(AGREE)})
    svc = make_service(pg_url, math_env=ENV, worker_pool_size=1, conv_cache_cap=1)
    capture.attach(svc)

    svc.poll_once()                                  # zid 1: cold
    for i in range(36):                              # burst of new participants
        pid, tid = 40 + (i * 5) % 12, (i * 7) % 6
        vote(1, pid, tid, _pattern(pid, tid))
    vote(1, 0, 1, DISAGREE)                          # a revote
    svc.poll_once()                                  # incremental
    late_older = clock[0] - 3                        # same cell, older stamp
    commit_vote(engine, 1, 0, 1, seed_vote(PASS), late_older)  # window drops it
    _moderate(engine, 1, 2, mod=-1)                  # mod out
    for pid in (57, 52, 55):
        for tid in (5, 0, 3):
            vote(1, pid, tid, _pattern(pid, tid))
    svc.poll_once()                                  # incremental + moderation
    # A new cell stamped below the last tick's lastVoteTimestamp, inside the
    # overlap: committed now, delivered by the next poll.
    vote(1, 71, 1, DISAGREE, created=clock[0] - 30)
    vote(1, 71, 2, AGREE)
    svc.poll_once()                                  # incremental, a late delivery

    # Two polls coalesced into one batch: the worker is held inside a first
    # computation while poll A (tids 4, 5) and poll B (tids 0, 1) are queued.
    # A single poll is delivered in canonical (tid, pid) order; the coalesced
    # batch is A then B.
    arrived, release = _hold_first_compute(svc, 1)
    vote(1, 72, 3, AGREE)
    svc._poll_votes_once()
    assert arrived.wait(30)
    vote(1, 73, 4, AGREE)
    vote(1, 73, 5, DISAGREE)
    svc._poll_votes_once()                           # poll A
    vote(1, 74, 0, DISAGREE)
    vote(1, 74, 1, AGREE)
    svc._poll_votes_once()                           # poll B
    release.set()
    assert svc._pool.join(timeout=60)
    coalesced = [r for r in _log(svc, 1) if r["vote_pids"] == [73, 73, 74, 74]]
    assert len(coalesced) == 1 and coalesced[0]["vote_tids"] == [4, 5, 0, 1]

    seed_conversation(engine, zid=2, n_ptpts=6, n_cmts=4, base_created=tick_clock())
    clock[0] += 6 * 4
    svc.poll_once()                                  # zid 2 cold; zid 1 evicted
    assert 1 not in svc._convs
    vote(1, 60, 3, DISAGREE)
    vote(1, 60, 4, AGREE)
    svc.poll_once()                                  # zid 1: warm restore
    _moderate(engine, 1, 2, mod=1)                   # mod in (mod-out stays sticky)
    _moderate(engine, 1, 0, is_meta=True)            # meta flag
    svc.poll_once()                                  # zid 1 incremental, mod read

    # A restore that fails: the poller rebuilds cold and logs it as cold.
    svc._cache_drop(1)
    with monkeypatch.context() as m:
        def broken(cls, data, **kwargs):
            raise KeyError("injected restore failure")
        m.setattr(Conversation, "from_dict", classmethod(broken))
        vote(1, 61, 0, AGREE)
        svc.poll_once()
    assert _log(svc, 1)[-1]["start_mode"] == "cold"

    restarted = make_service(pg_url, math_env=ENV, worker_pool_size=1, conv_cache_cap=2)
    capture.attach(restarted)
    restarted.poll_once()                            # every zid: warm restore
    # (its moderation poll may follow as a separate incremental tick)
    rebuild = next(r for r in reversed(_log(restarted, 1)) if r["start_mode"] != "incremental")
    assert rebuild["start_mode"] == "warm_restore"
    # Stamped below that rebuild's read, committed after it: delivered next.
    vote(1, 75, 3, AGREE, created=rebuild["rebuild_through_created"] - 5)
    for pid in (64, 61, 63, 62):
        for tid in (2, 1, 5):
            vote(1, pid, tid, _pattern(pid, tid))
    restarted.poll_once()                            # incremental
    _moderate(engine, 1, 4, mod=-1)
    restarted.poll_once()                            # moderation-only tick

    log1 = _log(restarted, 1)
    modes = [r["start_mode"] for r in log1]
    assert modes[0] == "cold" and modes.count("warm_restore") >= 2 and \
        modes.count("cold") == 2, modes
    assert any(r["mod_read"] and r["start_mode"] == "incremental" for r in log1)
    assert any(r["n_votes"] == 0 and r["mod_read"] for r in log1), "no moderation-only tick"
    assert any(not r["mod_read"] for r in log1)
    assert any(r["n_votes"] and 71 in r["vote_pids"] for r in log1)
    # The mod-in read finds no comment moderated out, and the set stays sticky.
    empty_read = next(r for r in log1 if r["mod_read"] and r["mod_out_tids_removed"] == [2])
    sticky = capture.published[(1, empty_read["math_tick"])]
    assert sticky["mod-out"] == [2] and sticky["mod-in"] == [2]
    assert 0 in sticky["meta-tids"]

    # Replay every published tick, with no database access at all.
    logs = {zid: _log(restarted, zid) for zid in (1, 2)}
    tables = {zid: restarted._pg.poll_votes(zid, None) for zid in (1, 2)}
    assert any(v["created"] is None for v in tables[1])
    no_database()
    replayed = 0
    for zid in (1, 2):
        rows = logs[zid]
        ticks = sorted(t for (z, t) in capture.published if z == zid)
        assert [r["math_tick"] for r in rows] == ticks, f"zid {zid}: a tick has no log row"
        replayer = TickReplayer(rows, tables[zid])
        for tick, row in zip(ticks, rows):
            assert _strip(replayer.blob(tick)) == _strip(capture.published[(zid, tick)]), (
                f"zid {zid} tick {tick} ({row['start_mode']}) does not replay to its "
                "published blob")
            replayed += 1
        for tick in ticks:  # fresh replayers, single ticks: no cached fold
            assert _strip(TickReplayer(rows, tables[zid]).blob(tick)) == \
                _strip(capture.published[(zid, tick)])
    assert replayed == len(capture.published) >= 14
    # Another engine version: refused.
    with pytest.raises(ReplayRefused, match="engine_version"):
        TickReplayer(logs[1], tables[1], expected_version="another-build").blob(
            log1[-1]["math_tick"])
    monkeypatch.undo()  # the database again

    # The operator CLI, end to end on this database.
    from scripts import replay_tick as cli

    ticks = [r["math_tick"] for r in log1]
    db = ["--database-url", pg_url, "--ssl-mode", "disable"]
    capsys.readouterr()
    assert cli.main(["--zid", "1", "--math-env", ENV, "--tick", str(ticks[1]),
                     "--through", str(ticks[-1]), "--field", "comment-priorities", *db]) == 0
    printed = json.loads(capsys.readouterr().out)
    assert printed == {str(t): capture.published[(1, t)]["comment-priorities"]
                       for t in ticks[1:]}
    with monkeypatch.context() as m:  # an image of another build
        m.setenv("POLIS_GIT_HASH", "0000000")
        assert cli.main(["--zid", "1", "--math-env", ENV, "--tick", str(ticks[-1]), *db]) == 3
        assert "engine_version" in capsys.readouterr().err
        assert cli.main(["--zid", "1", "--math-env", ENV, "--tick", str(ticks[-1]),
                         "--allow-engine-mismatch", *db]) == 0
        capsys.readouterr()

    # A tick-sequence reset: math_ticks removed, the sequence restarts at 0 and
    # overwrites the oldest log rows (re-stamping created). The new ticks still
    # replay (their chain reaches the later cold rebuild); an old tick whose
    # predecessor was overwritten is refused, never replayed wrong.
    with engine.begin() as conn:
        conn.execute(sa.text("DELETE FROM math_ticks WHERE zid = 1 AND math_env = :e"),
                     {"e": ENV})
    for n in range(3):
        vote(1, 80 + n, n, AGREE)
        restarted.poll_once()
    after = {r["math_tick"]: r for r in _log(restarted, 1)}
    assert sorted(t for t in after if t <= 2) == [0, 1, 2]
    assert after[0]["created"] > after[ticks[-1]]["created"]
    table = restarted._pg.poll_votes(1, None)
    for t in (0, 1, 2):
        assert _strip(TickReplayer(list(after.values()), table).blob(t)) == \
            _strip(capture.published[(1, t)])
    with pytest.raises(ReplayRefused, match="tick 3 continues tick 2 .*reset"):
        TickReplayer(list(after.values()), table).blob(3)

    # The digest is live: a vote committed now with an old created, which no
    # later tick delivered, falls inside the restart's read: that tick refuses.
    restart_tick = rebuild["math_tick"]
    commit_vote(engine, 1, 3, 3, seed_vote(AGREE), log1[0]["rebuild_through_created"])
    with pytest.raises(ReplayRefused, match="digest"):
        TickReplayer(_log(restarted, 1),
                     lambda: restarted._pg.poll_votes(1, None)).blob(restart_tick)
    assert cli.main(["--zid", "1", "--math-env", ENV, "--tick", str(restart_tick), *db]) == 3
    assert "digest" in capsys.readouterr().err


@pytest.mark.parametrize("payload", [
    {"b": 1, "a": {"zz": 1e16, "y": -0.0, "x": 1e-07},
     "ccc": [1.5e17, 2.0, 0.1, 1 / 3, 1e23, 1.7976931348623157e308],
     "10": "k", "é": [True, None, "xé"], "": {}},
])
@pytest.mark.parametrize("column", ["jsonb", "json"])
def test_jsonb_emulation_matches_postgres(engine, payload, column):
    """jsonb_roundtrip is what math_main returns, for both payload column
    types (production's json and the migrations' jsonb): the writer casts
    to jsonb either way."""
    from polismath.database.postgres import encode_math_blob

    with engine.begin() as conn:
        conn.execute(sa.text(f"CREATE TEMP TABLE t (data {column})"))
        conn.execute(sa.text("INSERT INTO t VALUES (cast(:d as jsonb))"),
                     {"d": encode_math_blob(payload)})
        back = conn.execute(sa.text("SELECT data FROM t")).scalar_one()
    assert json.dumps(back) == json.dumps(jsonb_roundtrip(payload))
