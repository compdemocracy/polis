"""R09 — partial tables and concurrent readers (REAL Postgres).

P-022 §C required matrix:

    Pause after main but before bidtopid/ptptstats; continuously query through
    Node.  No response may combine incompatible generations.  Prefer a
    transaction spanning all three writes or a reader-visible completed
    generation.  Eventual repair alone does not make a mixed mapping safe.  Seed
    preexisting partial rows, restart and repair; fail on absent/mismatched
    required rows.

The reader here is a Python transcription of the TWO server queries that
together produce a participant mapping —
``server/src/utils/pca.ts:360`` (``select * from math_main where zid = $1 and
math_env = $2``) and ``server/src/utils/participants.ts:10``
(``select * from math_bidtopid where zid = $1 and math_env = $2``) — plus
``getPidsForGid``'s positional join of ``base-clusters.id`` ->
``bidToPid[index]`` (``participants.ts:25-60``).  Running the real Node server
is D's job (see the notes file); what R09 needs is the exact query pair and the
exact join, which is what is reproduced.
"""

import json
import threading
import time

import pytest
import sqlalchemy as sa

from .conftest import (
    Latch,
    eventually,
    latch_method,
    read_math_tables,
    read_vote_events,
    seed_conversation,
    tables_are_coherent,
)
from . import fold as F

pytestmark = pytest.mark.recovery

MATH_ENV = "recovery"


# --------------------------------------------------------------------------- #
# The server's reader, transcribed
# --------------------------------------------------------------------------- #
def read_generation(engine, zid: int, math_env: str):
    """One SNAPSHOT of the reader's two queries, taken inside a single
    REPEATABLE READ transaction so any incoherence is the writer's, not a
    torn read of the test's own making."""
    conn = engine.connect().execution_options(isolation_level="REPEATABLE READ")
    try:
        with conn.begin():
            main = conn.execute(
                sa.text("select * from math_main where zid = :z and "
                        "math_env = :e"), {"z": zid, "e": math_env},
            ).mappings().first()
            bid = conn.execute(
                sa.text("select * from math_bidtopid where zid = :z and "
                        "math_env = :e"), {"z": zid, "e": math_env},
            ).mappings().first()
            pts = conn.execute(
                sa.text("select * from math_ptptstats where zid = :z and "
                        "math_env = :e"), {"z": zid, "e": math_env},
            ).mappings().first()
    finally:
        conn.close()
    return (dict(main) if main else None,
            dict(bid) if bid else None,
            dict(pts) if pts else None)


def response_problems(main, bid, pts):
    """Everything wrong with the response a reader would build from this
    snapshot.  Empty list == a usable, single-generation response."""
    problems = []
    if main is None:
        return ["no math_main row: nothing to serve"]
    if bid is None:
        problems.append("math_bidtopid row absent while math_main is published")
    if pts is None:
        problems.append("math_ptptstats row absent while math_main is published")
    if bid is not None and bid["math_tick"] != main["math_tick"]:
        problems.append(
            f"MIXED GENERATIONS: math_main math_tick={main['math_tick']} vs "
            f"math_bidtopid math_tick={bid['math_tick']}"
        )
    if pts is not None and pts["math_tick"] != main["math_tick"]:
        problems.append(
            f"MIXED GENERATIONS: math_main math_tick={main['math_tick']} vs "
            f"math_ptptstats math_tick={pts['math_tick']}"
        )
    if bid is not None:
        problems.extend(_mapping_problems(main["data"], bid["data"]))
    return problems


def _mapping_problems(main_data, bid_data):
    """``getPidsForGid``'s positional join (participants.ts:25-60): index a
    group's base-cluster ids through ``base-clusters.id`` into ``bidToPid``."""
    problems = []
    ids = (main_data.get("base-clusters") or {}).get("id") or []
    bid_to_pid = bid_data.get("bidToPid") or []
    if len(ids) != len(bid_to_pid):
        problems.append(
            f"positional contract broken: base-clusters.id has {len(ids)} "
            f"entries, bidToPid has {len(bid_to_pid)}"
        )
        return problems
    bid_to_index = {b: i for i, b in enumerate(ids)}
    known_pids = set()
    for members in bid_to_pid:
        known_pids.update(members)
    for group in main_data.get("group-clusters") or []:
        for member in group.get("members", []):
            # group-clusters members are already unfolded to pids by the writer;
            # the base-cluster ids are the ones that must resolve.
            if member not in known_pids:
                problems.append(
                    f"group {group.get('id')} references pid {member!r} that "
                    "no base cluster in this bidToPid contains"
                )
    for bid_id in ids:
        if bid_id not in bid_to_index:
            problems.append(f"base cluster {bid_id} has no bidToPid index")
    return problems


# --------------------------------------------------------------------------- #
# Continuous reader while a write is paused mid-way
# --------------------------------------------------------------------------- #
class ContinuousReader(threading.Thread):
    """Polls the reader's query pair until stopped, recording every snapshot."""

    def __init__(self, engine, zid, math_env):
        super().__init__(daemon=True)
        self.engine = engine
        self.zid = zid
        self.math_env = math_env
        self.snapshots = []
        self._halt = threading.Event()

    def run(self):
        while not self._halt.is_set():
            self.snapshots.append(read_generation(self.engine, self.zid,
                                                  self.math_env))
            self._halt.wait(0.01)

    def stop(self):
        self._halt.set()
        self.join(timeout=30)

    def incoherent(self):
        return [response_problems(*s) for s in self.snapshots
                if s[0] is not None and response_problems(*s)]


@pytest.mark.xfail(
    strict=True,
    reason=(
        "DEFECT (predicted by P-022 §C): the three tables are published "
        "NON-ATOMICALLY, so a reader can observe math_main at generation N "
        "together with math_bidtopid/math_ptptstats at N-1 or absent. "
        "polismath/poller/math_writer.py:238 makes three separate client "
        "calls and each commits on its own engine.begin() "
        "(polismath/database/postgres.py:413, :432). The consumer joins the "
        "two blobs POSITIONALLY — server/src/utils/participants.ts:33-51 maps "
        "base-clusters.id -> index -> bidToPid[index] — so a mixed pair is a "
        "wrong participant mapping, not merely a stale one. P-022 §C: 'No "
        "response may combine incompatible generations... Eventual repair "
        "alone does not make a mixed mapping safe.' The fix is a transaction "
        "spanning all three writes, or a reader-visible completed-generation "
        "marker; that is a separate decision."
    ),
)
def test_reader_never_sees_a_mixed_generation(engine, pg_url, make_service):
    """Pause the writer after the main commit and before the bidtopid commit,
    while a reader polls continuously."""
    seed_conversation(engine, zid=1, n_ptpts=6, n_cmts=4)
    svc = make_service(pg_url, math_env=MATH_ENV, worker_pool_size=1)
    svc.poll_once()          # generation 1: complete

    reader = ContinuousReader(engine, 1, MATH_ENV)
    reader.start()

    latch = Latch("write_math_bidtopid")
    undo = latch_method(svc._pg, "write_math_bidtopid", latch)
    from .conftest import commit_vote
    base = max(e["created"] for e in read_vote_events(engine, 1))
    commit_vote(engine, 1, 0, 0, F.RAW_DISAGREE, base + 1000)
    svc._vote_wm = base

    worker = threading.Thread(target=svc.poll_once, daemon=True)
    worker.start()
    latch.wait_arrival()
    # The reader is running while math_main is committed and bidtopid is not.
    eventually(lambda: len(reader.snapshots) > 3, timeout=10,
               message="the reader took no snapshots during the pause")
    latch.let_go()
    worker.join(timeout=60)
    undo()
    reader.stop()

    bad = reader.incoherent()
    assert bad == [], (
        f"{len(bad)} of {len(reader.snapshots)} reader snapshots combined "
        f"incompatible generations, e.g. {bad[0]}"
    )


def test_the_mixed_window_is_real_and_observable(engine, pg_url, make_service):
    """Companion to the xfail: assert the incoherent window EXISTS, so the
    defect is documented directly rather than only as a failing expectation."""
    seed_conversation(engine, zid=1, n_ptpts=6, n_cmts=4)
    svc = make_service(pg_url, math_env=MATH_ENV, worker_pool_size=1)
    svc.poll_once()
    first_tick = read_math_tables(engine, 1, MATH_ENV)["main"]["math_tick"]

    latch = Latch("write_math_bidtopid")
    undo = latch_method(svc._pg, "write_math_bidtopid", latch)
    from .conftest import commit_vote
    base = max(e["created"] for e in read_vote_events(engine, 1))
    commit_vote(engine, 1, 0, 0, F.RAW_DISAGREE, base + 1000)
    svc._vote_wm = base
    worker = threading.Thread(target=svc.poll_once, daemon=True)
    worker.start()
    latch.wait_arrival()

    main, bid, pts = read_generation(engine, 1, MATH_ENV)
    assert main["math_tick"] > first_tick, "math_main advanced on its own"
    assert bid["math_tick"] == first_tick, "math_bidtopid is a generation behind"
    assert pts["math_tick"] == first_tick
    problems = response_problems(main, bid, pts)
    assert any("MIXED GENERATIONS" in p for p in problems), problems

    latch.let_go()
    worker.join(timeout=60)
    undo()
    assert tables_are_coherent(read_math_tables(engine, 1, MATH_ENV)) == []


# --------------------------------------------------------------------------- #
# Preexisting partial rows: repair on restart
# --------------------------------------------------------------------------- #
def test_preexisting_partial_rows_are_repaired(engine, pg_url, make_service):
    """Seed a math_main row with NO bidtopid/ptptstats (the state a crash
    between writes leaves) and require a subsequent cycle to repair it into a
    single coherent generation matching the fold."""
    seed_conversation(engine, zid=1, n_ptpts=6, n_cmts=4)
    with engine.begin() as conn:
        conn.execute(
            sa.text("insert into math_main (zid, math_env, data, "
                    "last_vote_timestamp, caching_tick, math_tick) values "
                    "(:z, :e, cast(:d as jsonb), 0, 1, 7)"),
            {"z": 1, "e": MATH_ENV, "d": json.dumps({"zid": 1})},
        )
    main, bid, pts = read_generation(engine, 1, MATH_ENV)
    assert response_problems(main, bid, pts), "precondition: partial rows"

    svc = make_service(pg_url, math_env=MATH_ENV, worker_pool_size=1)
    svc.poll_once()

    main, bid, pts = read_generation(engine, 1, MATH_ENV)
    assert response_problems(main, bid, pts) == [], (
        response_problems(main, bid, pts)
    )
    fold = F.fold_votes(read_vote_events(engine, 1))
    assert F.check_published_against_fold(main["data"], fold) == []


def test_absent_required_rows_fail_the_reader_check(engine, pg_url,
                                                    make_service):
    """"fail on absent/mismatched required rows": deleting either companion row
    must make the reader check go red."""
    seed_conversation(engine, zid=1, n_ptpts=6, n_cmts=4)
    svc = make_service(pg_url, math_env=MATH_ENV, worker_pool_size=1)
    svc.poll_once()
    assert response_problems(*read_generation(engine, 1, MATH_ENV)) == []

    for table in ("math_bidtopid", "math_ptptstats"):
        with engine.begin() as conn:
            conn.execute(
                sa.text(f"delete from {table} where zid=:z and math_env=:e"),
                {"z": 1, "e": MATH_ENV},
            )
        problems = response_problems(*read_generation(engine, 1, MATH_ENV))
        assert any(table in p for p in problems), (
            f"deleting {table} was not detected: {problems}"
        )


def test_positional_bidtopid_contract_holds_for_a_complete_generation(
    engine, pg_url, make_service
):
    """The contract the server relies on (``math_writer.py:42``): every base
    cluster id has a positionally aligned bidToPid entry, and every group
    member resolves."""
    seed_conversation(engine, zid=1, n_ptpts=8, n_cmts=5)
    svc = make_service(pg_url, math_env=MATH_ENV, worker_pool_size=1)
    svc.poll_once()
    main, bid, _pts = read_generation(engine, 1, MATH_ENV)
    assert _mapping_problems(main["data"], bid["data"]) == []


# --------------------------------------------------------------------------- #
# Negative control for the partial-table / reader failure class
# --------------------------------------------------------------------------- #
class TestNegativeControl:
    def test_an_atomic_three_table_write_is_never_observed_mixed(self, engine,
                                                                 pg_url,
                                                                 make_service):
        """Intentionally 'fixed' variant: write all three rows inside ONE
        transaction and show the continuous reader never observes a split.
        This proves the observer above can distinguish atomic from non-atomic
        publication — the xfail is about the writer, not about the check."""
        seed_conversation(engine, zid=1, n_ptpts=6, n_cmts=4)
        svc = make_service(pg_url, math_env=MATH_ENV, worker_pool_size=1)
        svc.poll_once()
        tables = read_math_tables(engine, 1, MATH_ENV)
        blob = tables["main"]["data"]
        bid_blob = tables["bidtopid"]["data"]
        pts_blob = tables["ptptstats"]["data"]

        reader = ContinuousReader(engine, 1, MATH_ENV)
        reader.start()
        for tick in range(50, 55):
            with engine.begin() as conn:      # ONE transaction for all three
                conn.execute(
                    sa.text("update math_main set math_tick=:t, data=cast(:d as "
                            "jsonb) where zid=:z and math_env=:e"),
                    {"t": tick, "d": json.dumps(blob), "z": 1, "e": MATH_ENV})
                conn.execute(
                    sa.text("update math_bidtopid set math_tick=:t, "
                            "data=cast(:d as jsonb) where zid=:z and "
                            "math_env=:e"),
                    {"t": tick, "d": json.dumps(bid_blob), "z": 1,
                     "e": MATH_ENV})
                conn.execute(
                    sa.text("update math_ptptstats set math_tick=:t, "
                            "data=cast(:d as jsonb) where zid=:z and "
                            "math_env=:e"),
                    {"t": tick, "d": json.dumps(pts_blob), "z": 1,
                     "e": MATH_ENV})
        reader.stop()

        assert len(reader.snapshots) > 1
        assert reader.incoherent() == [], (
            "NEGATIVE CONTROL FAILED: an ATOMIC three-table write was still "
            "observed as a mixed generation, so the reader check has a false "
            f"positive: {reader.incoherent()[:1]}"
        )

    def test_a_deliberately_misaligned_mapping_is_caught(self, engine, pg_url,
                                                         make_service):
        """Break the positional contract on purpose; the mapping check must
        detect it."""
        seed_conversation(engine, zid=1, n_ptpts=8, n_cmts=5)
        svc = make_service(pg_url, math_env=MATH_ENV, worker_pool_size=1)
        svc.poll_once()
        main, bid, _pts = read_generation(engine, 1, MATH_ENV)
        broken = dict(bid["data"])
        broken["bidToPid"] = broken["bidToPid"][:-1]      # drop one bucket
        problems = _mapping_problems(main["data"], broken)
        assert problems, (
            "NEGATIVE CONTROL FAILED: a truncated bidToPid was accepted as "
            "positionally aligned"
        )
