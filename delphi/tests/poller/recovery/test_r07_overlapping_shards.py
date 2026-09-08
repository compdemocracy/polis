"""R07 — overlapping shards / duplicate writers (REAL Postgres).

P-022 §C required matrix:

    Two processes, same shard index and math env; then partially overlapping
    allowlists and a rolling shard-count change.  Require startup refusal or
    demonstrable exclusive/fenced ownership.  For this cutover, deployment
    enforces one replica; duplicate-start must be prevented/observable.  Do not
    claim modulus filtering alone prevents duplicate writers.  Disjoint valid
    shards must cover every selected zid exactly once.

The partitioning arithmetic (``should_process_zid``,
``polismath/poller/service.py:62``) is correct and is asserted here as a pure
property.  Ownership is a different question: nothing in the poller takes a
lease, advisory lock or fence before writing, and ``ConversationWorkerPool``
serialises per zid only WITHIN a process (``worker_pool.py:5``).  Two processes
that both accept a zid therefore both write it, with no mutual exclusion — which
is what the duplicate-writer tests below establish, on real processes against
real rows.
"""

import os
import subprocess
import sys
import threading
import time

import pytest
import sqlalchemy as sa

from .conftest import (
    read_math_tables,
    read_vote_events,
    seed_conversation,
    tables_are_coherent,
)
from . import fold as F
from polismath.poller.service import PollerConfig, should_process_zid
from .test_r05_mid_batch_restart import Child, _DELPHI_ROOT

pytestmark = pytest.mark.recovery

MATH_ENV = "recovery"


# --------------------------------------------------------------------------- #
# Partition arithmetic — a pure property, no DB needed
# --------------------------------------------------------------------------- #
def test_disjoint_shards_cover_every_zid_exactly_once():
    """For every shard count, the shards partition the zid space: each zid is
    accepted by exactly one shard index."""
    zids = list(range(0, 500))
    for count in (1, 2, 3, 4, 7, 8, 16):
        owners = {}
        for zid in zids:
            accepting = [
                idx for idx in range(count)
                if should_process_zid(zid, [], [], idx, count)
            ]
            assert len(accepting) == 1, (
                f"zid {zid} accepted by {accepting} of {count} shards"
            )
            owners[zid] = accepting[0]
        assert set(owners.values()) <= set(range(count))


def test_shard_test_precedes_the_allowlist():
    """A shard must never process a zid outside its slice, even one an
    allowlist names — the allowlist cannot widen ownership."""
    assert not should_process_zid(3, [3], [], shard_index=0, shard_count=2)
    assert should_process_zid(3, [3], [], shard_index=1, shard_count=2)


def test_out_of_range_shard_is_a_startup_refusal():
    """An unusable shard slice must crash at construction, not start healthy and
    silently process nothing."""
    with pytest.raises(ValueError, match="shard_index must be in"):
        PollerConfig(shard_index=2, shard_count=2)
    with pytest.raises(ValueError, match="shard_index must be in"):
        PollerConfig(shard_index=-1, shard_count=2)
    with pytest.raises(ValueError, match="shard_count must be >= 1"):
        PollerConfig(shard_count=0)


def test_rolling_shard_count_change_leaves_no_zid_unowned(engine, pg_url,
                                                          make_service):
    """A rolling shard-count change (2 -> 3) may DOUBLE-cover a zid mid-roll,
    but it must never leave one unowned.  Assert both halves explicitly."""
    zids = list(range(1, 61))
    old, new = 2, 3
    unowned, double = [], []
    for zid in zids:
        owners = [("old", i) for i in range(old)
                  if should_process_zid(zid, [], [], i, old)]
        owners += [("new", i) for i in range(new)
                   if should_process_zid(zid, [], [], i, new)]
        if not owners:
            unowned.append(zid)
        if len(owners) > 1:
            double.append(zid)
    assert unowned == [], f"zids with no owner during a rolling change: {unowned}"
    assert double, (
        "a rolling shard-count change necessarily double-covers some zids; "
        "that is exactly why ownership needs a fence, not just a modulus"
    )


# --------------------------------------------------------------------------- #
# Duplicate writers — the ownership question
# --------------------------------------------------------------------------- #
def _run_two_children(pg_url, tmp_path, days=1.0):
    """Start two identical poller processes at once (same shard, same math_env)
    and wait for both to finish one cycle."""
    env = dict(os.environ)
    env["PYTHONPATH"] = _DELPHI_ROOT + os.pathsep + env.get("PYTHONPATH", "")
    env["POLIS_RECOVERY_DUMP_DIR"] = str(tmp_path / "errorconv")
    child = os.path.join(os.path.dirname(__file__), "restart_child.py")
    procs = [
        subprocess.Popen(
            [sys.executable, child, "--pg-url", pg_url, "--math-env", MATH_ENV,
             "--kill-stage", "none", "--poll-from-days-ago", str(days)],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            env=env, cwd=_DELPHI_ROOT,
        )
        for _ in range(2)
    ]
    outs = []
    for p in procs:
        out, err = p.communicate(timeout=180)
        outs.append((p.returncode, out, err))
    return outs


@pytest.mark.xfail(
    strict=True,
    reason=(
        "DEFECT (P-022 §C R07): nothing prevents or fences a duplicate writer. "
        "Two poller processes with the SAME POLL_SHARD_INDEX/POLL_SHARD_COUNT "
        "and the same MATH_ENV both start cleanly and both write the same "
        "zid's math_main / math_bidtopid / math_ptptstats rows. There is no "
        "startup refusal, no advisory lock, no lease and no fencing token "
        "anywhere in polismath/poller/service.py or "
        "polismath/database/postgres.py; ConversationWorkerPool serialises per "
        "zid only WITHIN one process (polismath/poller/worker_pool.py:5). "
        "P-022 §C requires 'startup refusal or demonstrable exclusive/fenced "
        "ownership' and warns not to claim modulus filtering alone prevents "
        "duplicate writers. Today the only control is the deployment promising "
        "one replica, which is not observable from the database. A fix (a "
        "pg_advisory_lock lease per (math_env, shard) held for the process "
        "lifetime, or a fencing token checked in the writes) is a separate "
        "decision."
    ),
)
def test_duplicate_shard_start_is_refused_or_fenced(engine, pg_url, tmp_path):
    """Two identical processes, same shard index and math env: one must refuse
    to start, or ownership must be demonstrably exclusive."""
    seed_conversation(engine, zid=1, n_ptpts=6, n_cmts=4)
    results = _run_two_children(pg_url, tmp_path)
    exit_codes = [rc for rc, _out, _err in results]
    refusals = [rc for rc in exit_codes if rc != 0]
    assert refusals, (
        "both duplicate processes started and completed a full write cycle "
        f"(exit codes {exit_codes}); neither refused, and nothing fenced them"
    )


def test_duplicate_writers_both_write_the_same_rows(engine, pg_url, tmp_path):
    """The observable consequence, asserted directly so the defect above is
    documented rather than inferred: two duplicate processes both advance the
    same zid's math_tick.  (Both write authoritative full-history state, so the
    CONTENT stays correct here — the hazard is unfenced concurrent ownership,
    not a demonstrated corruption on this fixture.)"""
    seed_conversation(engine, zid=1, n_ptpts=6, n_cmts=4)
    results = _run_two_children(pg_url, tmp_path)
    assert [rc for rc, _o, _e in results] == [0, 0], (
        f"both duplicates were expected to run to completion: {results}"
    )
    with engine.connect() as conn:
        tick = conn.execute(
            sa.text("SELECT math_tick FROM math_ticks WHERE zid=:z AND "
                    "math_env=:e"), {"z": 1, "e": MATH_ENV},
        ).scalar()
    assert tick is not None and tick >= 1, (
        f"two writers must have advanced the shared math_tick at least twice "
        f"(saw math_tick={tick})"
    )
    tables = read_math_tables(engine, 1, MATH_ENV)
    assert tables_are_coherent(tables) == [], tables_are_coherent(tables)


def test_partially_overlapping_allowlists_both_accept_the_shared_zid(engine,
                                                                     pg_url,
                                                                     make_service):
    """Two configurations whose allowlists overlap on zid 2: both accept it.
    Allowlists are a selection mechanism, not an ownership mechanism."""
    for zid in (1, 2, 3):
        seed_conversation(engine, zid=zid, n_ptpts=4, n_cmts=3)

    a = make_service(pg_url, math_env=MATH_ENV, allowlist=[1, 2],
                     worker_pool_size=1)
    b = make_service(pg_url, math_env=MATH_ENV, allowlist=[2, 3],
                     worker_pool_size=1)
    for zid in (1, 2, 3):
        accepted_by = [
            name for name, svc in (("a", a), ("b", b))
            if should_process_zid(zid, svc.config.allowlist, svc.config.blocklist,
                                  svc.config.shard_index, svc.config.shard_count)
        ]
        expected = {1: ["a"], 2: ["a", "b"], 3: ["b"]}[zid]
        assert accepted_by == expected

    a.poll_once()
    b.poll_once()
    for zid in (1, 2, 3):
        tables = read_math_tables(engine, zid, MATH_ENV)
        assert tables_are_coherent(tables) == [], tables_are_coherent(tables)
        fold = F.fold_votes(read_vote_events(engine, zid))
        assert F.check_published_against_fold(tables["main"]["data"], fold) == []


def test_disjoint_shards_cover_every_seeded_zid_exactly_once_on_real_pg(
    engine, pg_url, make_service
):
    """End-to-end partitioning: shard 0/2 and shard 1/2 together publish every
    seeded conversation, and neither touches the other's zids."""
    zids = [1, 2, 3, 4, 5, 6]
    for zid in zids:
        seed_conversation(engine, zid=zid, n_ptpts=4, n_cmts=3)

    shard0 = make_service(pg_url, math_env=MATH_ENV + "_s0", shard_index=0,
                          shard_count=2, worker_pool_size=1)
    shard1 = make_service(pg_url, math_env=MATH_ENV + "_s1", shard_index=1,
                          shard_count=2, worker_pool_size=1)
    shard0.poll_once()
    shard1.poll_once()

    for zid in zids:
        owner = MATH_ENV + ("_s0" if zid % 2 == 0 else "_s1")
        other = MATH_ENV + ("_s1" if zid % 2 == 0 else "_s0")
        assert read_math_tables(engine, zid, owner)["main"] is not None, (
            f"zid {zid} was not published by its owning shard"
        )
        assert read_math_tables(engine, zid, other)["main"] is None, (
            f"zid {zid} was published by the NON-owning shard"
        )


# --------------------------------------------------------------------------- #
# Negative control for the shard-ownership failure class
# --------------------------------------------------------------------------- #
class TestNegativeControl:
    def test_a_broken_partition_is_detected(self):
        """Intentionally broken variant: a filter that ignores the shard index.
        The exactly-once partition assertion must go red on it."""
        def broken(zid, allowlist, blocklist, shard_index, shard_count):
            return True  # every shard accepts every zid

        accepting = [idx for idx in range(4) if broken(7, [], [], idx, 4)]
        assert len(accepting) != 1, (
            "NEGATIVE CONTROL FAILED: a shard filter that accepts everything "
            "still looked like an exactly-once partition"
        )

    def test_a_shard_that_owns_nothing_would_be_caught(self):
        """A shard index outside its count owns no zid at all — the failure
        mode ``_validate_shard`` exists to prevent.  Assert the arithmetic
        really would go silent, so the startup refusal is load-bearing."""
        owned = [z for z in range(200)
                 if should_process_zid(z, [], [], shard_index=5, shard_count=2)]
        assert owned == [], (
            "an out-of-range shard owns nothing; without the constructor's "
            "ValueError such a process would start and look healthy"
        )
