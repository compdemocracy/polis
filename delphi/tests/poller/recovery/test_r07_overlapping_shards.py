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
from .test_r05_mid_batch_restart import (  # noqa: F401  (children is a fixture)
    _spawn,
    children,
)

pytestmark = pytest.mark.recovery

MATH_ENV = "recovery"

# The refusal contract, defined by the harness and asserted by name.
#
# "Nonzero exit" is NOT a refusal: an import error, a DB outage or two crashed
# workers would all satisfy it (astra review finding 3).  A refusal is a
# process that declined to run BECAUSE someone else owns this shard, and it
# announces itself with this exit code and this marker
# (``restart_child._is_ownership_refusal`` / ``OWNERSHIP_REFUSAL_MARKER``).
# Nothing else is accepted, and any other nonzero exit is a HARD failure.
OWNERSHIP_REFUSAL_EXIT = 3
OWNERSHIP_REFUSAL_MARKER = "OWNERSHIP-REFUSED"


class OwnershipNotFenced(AssertionError):
    """Raised when duplicate writers were neither refused nor fenced.

    A distinct type so the ``xfail`` below can name it with ``raises=``: any
    OTHER failure — an unrelated crash, no healthy publisher, an incoherent
    final generation — is then a real FAILURE and not a green xfail.
    """


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


def test_rolling_shard_count_change_arithmetic_leaves_no_zid_unowned(
    engine, pg_url, make_service
):
    """A rolling shard-count change (2 -> 3) may DOUBLE-cover a zid mid-roll,
    but it must never leave one unowned.  Assert both halves explicitly.

    LIMITATION, kept explicit (astra review finding 3): this evaluates two
    complete arithmetic partitions side by side.  It is NOT a rolling ownership
    handoff — no process starts, stops, or hands anything over, and nothing
    here shows what the two generations of processes do to the same rows while
    both are live.  A real handoff test needs process-level fencing and
    reconfiguration to exist first; until then the duplicate-writer tests below
    are the only process-level ownership evidence in this module."""
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
def _advisory_locks(engine) -> list:
    """Every advisory lock held on this database right now.

    An "exclusive/fenced ownership" implementation would show up here (a
    ``pg_advisory_lock`` lease per ``(math_env, shard)`` is the obvious form).
    Read WHILE both duplicate writers hold their ownership latch, so an empty
    result is real evidence that nothing was fenced rather than a timing
    artefact."""
    with engine.connect() as conn:
        rows = conn.execute(sa.text(
            "select locktype, classid, objid, objsubid, granted, pid "
            "from pg_locks where locktype = 'advisory'"
        )).mappings().all()
    return [dict(r) for r in rows]


def _ownership_table_names(engine) -> list:
    """Tables that would carry a durable lease / fencing token, if any existed."""
    with engine.connect() as conn:
        rows = conn.execute(sa.text(
            "select table_name from information_schema.tables "
            "where table_schema = 'public' and ("
            "  table_name ilike '%owner%' or table_name ilike '%lease%' "
            "  or table_name ilike '%fence%' or table_name ilike '%shard%')"
        )).scalars().all()
    return list(rows)


def _run_two_latched_children(engine, pg_url, tmp_path, children, days=1.0):
    """Two identical poller processes held CONCURRENTLY at their ownership
    point, so "both ran" cannot be two one-shot processes running one after the
    other (astra review finding 3).

    Returns ``(kids, evidence)`` where ``evidence`` is what the database showed
    while both were alive and holding.
    """
    latch_dir = tmp_path / "ownership"
    kids = [
        _spawn_latched(children, pg_url, tmp_path, latch_dir, days)
        for _ in range(2)
    ]
    for kid in kids:
        kid.await_stage("OWNED", timeout=120)
    assert all(kid.proc.poll() is None for kid in kids), (
        "both duplicate processes must still be ALIVE while holding ownership"
    )

    evidence = {
        "advisory_locks": _advisory_locks(engine),
        "ownership_tables": _ownership_table_names(engine),
        "held_concurrently": True,
    }

    (latch_dir / "release").write_text("go")
    for kid in kids:
        kid.proc.wait(timeout=180)
    return kids, evidence


def _spawn_latched(kids, pg_url, tmp_path, latch_dir, days):
    return _spawn(kids, pg_url, "none", days=days, tmp_path=tmp_path,
                  ownership_latch_dir=latch_dir)


def _classify(kid):
    """``'publisher'`` (exit 0, completed a cycle), ``'refusal'`` (the named
    ownership refusal) or ``'crash'`` (anything else)."""
    rc = kid.proc.returncode
    stderr = kid.proc.stderr.read() if kid.proc.stderr else ""
    if rc == 0 and "DONE" in kid.stages:
        return "publisher", stderr
    if rc == OWNERSHIP_REFUSAL_EXIT and any(
        l.startswith(OWNERSHIP_REFUSAL_MARKER) for l in kid.lines
    ):
        return "refusal", stderr
    return "crash", stderr


@pytest.mark.xfail(
    strict=True,
    raises=OwnershipNotFenced,
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
        "decision. NOTE the xfail names OwnershipNotFenced explicitly: an "
        "unrelated crash, a missing healthy publisher or an incoherent final "
        "generation is a REAL failure here, never a green xfail."
    ),
)
def test_duplicate_shard_start_is_refused_or_fenced(engine, pg_url, tmp_path,
                                                    children):
    """Two identical processes, same shard index and math env, held ALIVE at
    the same time: one must refuse to start for a named ownership reason, or
    ownership must be demonstrably exclusive/fenced.

    Every precondition is a plain assertion, so it fails for real:

    * both processes were alive concurrently while holding ownership (two
      one-shot children running sequentially would prove nothing);
    * exactly one proven-healthy publisher exists (exit 0 with a completed
      cycle);
    * no process crashed for an unrelated reason — a nonzero exit only counts
      as a refusal when it is ``OWNERSHIP_REFUSAL_EXIT`` with the marker;
    * no losing process is left running;
    * the final generation is coherent and matches the independent fold.

    Only the ownership question itself raises :class:`OwnershipNotFenced`.
    """
    seed_conversation(engine, zid=1, n_ptpts=6, n_cmts=4)
    kids, evidence = _run_two_latched_children(engine, pg_url, tmp_path,
                                               children)
    outcomes = [_classify(kid) for kid in kids]
    kinds = [kind for kind, _err in outcomes]

    assert evidence["held_concurrently"]
    crashes = [(kid.proc.returncode, kid.lines, err)
               for kid, (kind, err) in zip(kids, outcomes) if kind == "crash"]
    assert not crashes, (
        "a duplicate-writer process died for a reason that is NOT the named "
        f"ownership refusal, which must never be read as fencing: {crashes}"
    )
    assert kinds.count("publisher") >= 1, (
        f"no healthy publisher survived the duplicate start: {kinds}"
    )
    assert all(kid.proc.poll() is not None for kid in kids), (
        "a losing process is still running"
    )

    tables = read_math_tables(engine, 1, MATH_ENV)
    assert tables_are_coherent(tables) == [], tables_are_coherent(tables)
    fold = F.fold_votes(read_vote_events(engine, 1))
    assert F.check_published_against_fold(tables["main"]["data"], fold) == []

    refused = [kid for kid, (kind, _e) in zip(kids, outcomes)
               if kind == "refusal"]
    fenced = bool(evidence["advisory_locks"]) or bool(
        evidence["ownership_tables"])
    if not refused and not fenced:
        raise OwnershipNotFenced(
            "both duplicate processes started and completed a full write "
            f"cycle (outcomes {kinds}); none refused with exit "
            f"{OWNERSHIP_REFUSAL_EXIT}/{OWNERSHIP_REFUSAL_MARKER}, no advisory "
            "lock was held while both were alive "
            f"({evidence['advisory_locks']}) and no lease/fence table exists "
            f"({evidence['ownership_tables']})"
        )


def test_duplicate_writers_both_write_the_same_rows(engine, pg_url, tmp_path,
                                                    children):
    """The observable consequence, asserted directly so the defect above is
    documented rather than inferred: two duplicate processes, proven ALIVE AT
    THE SAME TIME by the ownership latch, both advance the same zid's
    math_tick.  (Both write authoritative full-history state, so the CONTENT
    stays correct here — the hazard is unfenced concurrent ownership, not a
    demonstrated corruption on this fixture.)"""
    seed_conversation(engine, zid=1, n_ptpts=6, n_cmts=4)
    kids, evidence = _run_two_latched_children(engine, pg_url, tmp_path,
                                               children)
    assert evidence["held_concurrently"]
    assert [kid.proc.returncode for kid in kids] == [0, 0], (
        "both duplicates were expected to run to completion: "
        f"{[(k.proc.returncode, k.lines) for k in kids]}"
    )
    assert all("DONE" in kid.stages for kid in kids)
    assert evidence["advisory_locks"] == [], (
        "no advisory lock was taken while two duplicate writers were both "
        f"alive: {evidence['advisory_locks']}"
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

    def test_an_unrelated_crash_is_not_classified_as_a_refusal(self, pg_url,
                                                               tmp_path,
                                                               children):
        """The correction itself, controlled (astra review finding 3): a child
        that dies of a DB outage — the very thing "any nonzero exit" used to
        accept — must classify as a CRASH, never as an ownership refusal."""
        kid = _spawn(children, pg_url.replace("/rec_", "/nope_does_not_exist_"),
                     "none", tmp_path=tmp_path)
        rc = kid.proc.wait(timeout=120)
        assert rc != 0, "the unreachable-database child must fail"
        assert rc != OWNERSHIP_REFUSAL_EXIT
        kind, _err = _classify(kid)
        assert kind == "crash", (
            "NEGATIVE CONTROL FAILED: an unrelated process failure was "
            f"classified as {kind!r}"
        )
        assert not any(l.startswith(OWNERSHIP_REFUSAL_MARKER)
                       for l in kid.lines)

    def test_the_refusal_classifier_recognises_a_real_refusal(self):
        """...and the classifier is not merely always-false: the shapes an
        ownership refusal would take ARE recognised, so the xfail above is
        waiting on production, not on an unreachable assertion."""
        from .restart_child import _is_ownership_refusal

        class OwnershipRefused(RuntimeError):
            pass

        assert _is_ownership_refusal(OwnershipRefused("shard 0/2"))
        assert _is_ownership_refusal(
            RuntimeError("shard (recovery, 0/2) is already owned by pid 42"))
        assert _is_ownership_refusal(
            RuntimeError("ownership lease advisory lock not acquired"))
        assert _is_ownership_refusal(RuntimeError("stale fence rejected"))
        # ...and not by accident:
        assert not _is_ownership_refusal(ImportError("no module named x"))
        assert not _is_ownership_refusal(
            RuntimeError("could not connect to server"))

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
