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
from .test_r05_mid_batch_restart import (  # noqa: F401  (children is a fixture)
    _spawn,
    children,
)

pytestmark = pytest.mark.recovery

MATH_ENV = "recovery"

# The refusal contract, defined by the harness and asserted by name.
#
# "Nonzero exit" is NOT a refusal: an import error, a DB outage or two crashed
# workers would all satisfy it (review finding 3).  A refusal is a
# process that declined to run BECAUSE someone else owns this shard, and it
# announces itself with this exit code and this marker
# (``restart_child._is_ownership_refusal`` / ``OWNERSHIP_REFUSAL_MARKER``).
# Nothing else is accepted, and any other nonzero exit is a HARD failure.
OWNERSHIP_REFUSAL_EXIT = 3
OWNERSHIP_REFUSAL_MARKER = "OWNERSHIP-REFUSED"

# The FENCE contract, likewise defined by name (second-round review).
#
# "Any advisory lock, or any table whose name contains owner/lease/fence/shard"
# is NOT a fence: creating an unrelated `lease_notes` table, or holding an
# advisory lock for something else entirely, would flip the acceptance green
# with the same two unfenced publishers and the same output.  Only these two
# shapes count, and each is tied to THIS zid:
#
# ``lease row``
#     a row in a lease/owner/fence table that names this zid AND carries both
#     an owner column and a version/epoch/fence-token column, so a stale writer
#     is distinguishable from the live one;
# ``advisory lock keyed by this zid``
#     a GRANTED advisory lock whose key encodes the zid — the two-int form
#     ``(namespace, zid)`` or the bigint form ``namespace << 32 | zid`` — held
#     by a backend other than this test's own.
#
# Even then, a lock alone is not stale-writer fencing: the fence must have had
# an OBSERVABLE effect, so `test_duplicate_shard_start_is_refused_or_fenced`
# additionally requires exactly one healthy publisher.  Two processes that both
# completed a full write cycle were not exclusively owned, whatever the catalog
# says.  Catalog-wide `_advisory_locks` / `_ownership_table_names` remain in the
# evidence dict as DIAGNOSTICS for the failure message only.
OWNERSHIP_LEASE_OWNER_COLUMNS = (
    "owner", "owner_id", "owner_pid", "owner_name", "holder", "locked_by",
    "lease_owner",
)
OWNERSHIP_LEASE_VERSION_COLUMNS = (
    "version", "epoch", "fence", "fence_token", "token", "generation",
    "lease_version",
)
OWNERSHIP_LEASE_ZID_COLUMNS = ("zid", "conversation_id", "conv_id")


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

    LIMITATION, kept explicit (review finding 3): this evaluates two
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
            "from pg_locks where locktype = 'advisory' "
            "  and database = "
            "      (select oid from pg_database where datname = current_database())"
        )).mappings().all()
    return [dict(r) for r in rows]


def _ownership_table_names(engine) -> list:
    """Tables that would carry a durable lease / fencing token, if any existed.

    DIAGNOSTIC ONLY.  A name match is not a fence — see
    :func:`_zid_ownership_leases` for the check the acceptance actually uses."""
    with engine.connect() as conn:
        rows = conn.execute(sa.text(
            "select table_name from information_schema.tables "
            "where table_schema = 'public' and ("
            "  table_name ilike '%owner%' or table_name ilike '%lease%' "
            "  or table_name ilike '%fence%' or table_name ilike '%shard%')"
        )).scalars().all()
    return list(rows)


def _zid_ownership_leases(engine, zid: int) -> list:
    """LEASE ROWS for ``zid``: the first of the two fence shapes.

    A candidate table qualifies only if its COLUMNS make it a lease — a zid
    column, an owner column and a version/epoch/fence-token column — and only
    if it actually holds a row for this zid with a non-null owner.  A table that
    merely has "lease" in its name contributes nothing (second-round
    review: ``unrelated_lease_notes`` used to flip this green)."""
    found = []
    with engine.connect() as conn:
        candidates = conn.execute(sa.text(
            "select table_name from information_schema.tables "
            "where table_schema = 'public' and ("
            "  table_name ilike '%owner%' or table_name ilike '%lease%' "
            "  or table_name ilike '%fence%' or table_name ilike '%shard%')"
        )).scalars().all()
        for table in candidates:
            cols = set(conn.execute(sa.text(
                "select column_name from information_schema.columns "
                "where table_schema = 'public' and table_name = :t"
            ), {"t": table}).scalars().all())
            zid_col = next((c for c in OWNERSHIP_LEASE_ZID_COLUMNS
                            if c in cols), None)
            owner_col = next((c for c in OWNERSHIP_LEASE_OWNER_COLUMNS
                              if c in cols), None)
            version_col = next((c for c in OWNERSHIP_LEASE_VERSION_COLUMNS
                                if c in cols), None)
            if not (zid_col and owner_col and version_col):
                continue
            rows = conn.execute(sa.text(
                f'select "{owner_col}" as owner, "{version_col}" as version '
                f'from "{table}" where "{zid_col}" = :z '
                f'and "{owner_col}" is not null'
            ), {"z": zid}).mappings().all()
            for row in rows:
                found.append({"table": table, "zid": zid,
                              "owner": row["owner"], "version": row["version"]})
    return found


def _zid_keyed_advisory_locks(engine, zid: int) -> list:
    """ADVISORY LOCKS KEYED BY ``zid``: the second fence shape.

    Postgres reports ``pg_advisory_lock(k1 int, k2 int)`` as
    ``(classid, objid, objsubid) = (k1, k2, 2)`` and
    ``pg_advisory_lock(k bigint)`` as ``(k >> 32, k & 0xffffffff, 1)``.  Either
    encoding of this zid counts; an advisory lock on any other key does not.
    The holder must also be some OTHER backend, so the test's own session can
    never satisfy its own fence check.

    Read WHILE the duplicate writers hold their ownership latch, so an empty
    result is real evidence rather than a timing artefact."""
    with engine.connect() as conn:
        rows = conn.execute(sa.text(
            "select locktype, classid, objid, objsubid, granted, pid "
            "from pg_locks "
            "where locktype = 'advisory' and granted "
            "  and database = "
            "      (select oid from pg_database where datname = current_database()) "
            "  and pid <> pg_backend_pid() "
            "  and ((objsubid = 2 and objid = :z) "
            "    or (objsubid = 1 and (classid::bigint << 32 | objid::bigint) "
            "        = :z) "
            "    or (objsubid = 1 and objid = :z))"
        ), {"z": zid}).mappings().all()
    return [dict(r) for r in rows]


def _collect_evidence(engine, zid: int, owners: int, refusals: int) -> dict:
    return {
        # The fence contract, per zid.  These two decide the acceptance.
        "zid_leases": _zid_ownership_leases(engine, zid),
        "zid_advisory_locks": _zid_keyed_advisory_locks(engine, zid),
        # Diagnostics for the failure message; NOT acceptance criteria.
        "advisory_locks": _advisory_locks(engine),
        "ownership_tables": _ownership_table_names(engine),
        "owners": owners,
        "refusals": refusals,
        "held_concurrently": owners >= 2,
    }


def _await_ownership_outcome(kid, timeout=120.0):
    """Wait for a child to declare EITHER outcome the contract allows.

    ``'owned'``
        it announced ``STAGE OWNED`` and is holding the ownership latch;
    ``'refused'``
        it printed the named ownership refusal (and will exit
        ``OWNERSHIP_REFUSAL_EXIT``);
    ``'dead'``
        it exited without saying either — never a fence, always a real failure.

    Waiting for OWNED from BOTH children, which this helper used to do, makes
    the PASSING shape unreachable (second-round review): a correctly
    refused startup exits before ``_hold_ownership`` and can never emit OWNED,
    so the helper timed out before the classifier ever saw the valid refusal."""
    deadline = time.monotonic() + timeout

    def _settled():
        if any(l.startswith(OWNERSHIP_REFUSAL_MARKER) for l in kid.lines):
            return "refused"
        if "OWNED" in kid.stages:
            return "owned"
        return None

    while True:
        settled = _settled()
        if settled:
            return settled
        if kid.proc.poll() is not None:
            # Exited without either announcement: give the stdout reader a beat
            # to drain the pipe, then call it what it is.
            time.sleep(0.2)
            return _settled() or "dead"
        if time.monotonic() > deadline:
            raise AssertionError(
                f"child neither took ownership nor refused within {timeout}s "
                f"(stages={kid.stages}, lines={kid.lines})"
            )
        time.sleep(0.02)


def _run_two_latched_children(engine, pg_url, tmp_path, children, days=1.0,
                              zid=1):
    """Two identical poller processes driven to their ownership decision, held
    CONCURRENTLY if they both take ownership — so "both ran" cannot be two
    one-shot processes running one after the other (review finding 3).

    BOTH contract shapes are reachable from here:

    * two owners  — today's unfenced reality; the caller's classifier decides;
    * one owner + one named refusal — the PASSING shape, which this helper no
      longer deadlocks on.

    Anything else (a child that died for an unrelated reason, or no owner at
    all) is a hard failure, never evidence of a fence.

    Returns ``(kids, evidence)`` where ``evidence`` is what the database showed
    while the owner(s) were alive and holding.
    """
    latch_dir = tmp_path / "ownership"
    kids = [
        _spawn_latched(children, pg_url, tmp_path, latch_dir, days)
        for _ in range(2)
    ]
    outcomes = [_await_ownership_outcome(kid) for kid in kids]

    dead = [(kid.proc.returncode, kid.stages, kid.lines)
            for kid, out in zip(kids, outcomes) if out == "dead"]
    assert not dead, (
        "a duplicate-writer process exited without taking ownership and "
        f"without the named refusal; that is a crash, not a fence: {dead}"
    )
    owners = [kid for kid, out in zip(kids, outcomes) if out == "owned"]
    refusals = [kid for kid, out in zip(kids, outcomes) if out == "refused"]
    assert owners, (
        "neither process took ownership; a shard with no owner is not fencing, "
        f"it is an outage: {[(k.stages, k.lines) for k in kids]}"
    )
    assert all(kid.proc.poll() is None for kid in owners), (
        "an owning process died while it was supposed to be holding ownership"
    )

    evidence = _collect_evidence(engine, zid, len(owners), len(refusals))

    latch_dir.mkdir(parents=True, exist_ok=True)
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
        "decision. The acceptance recognises ONLY a lease row or advisory lock "
        "keyed by this zid, AND observably exclusive publication; a "
        "lease-NAMED table or an unrelated advisory lock is diagnostics, not a "
        "fence (see TestNegativeControl). NOTE the xfail names "
        "OwnershipNotFenced explicitly: an "
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

    * whichever children took ownership were alive concurrently while holding
      it (two one-shot children running sequentially would prove nothing);
    * exactly one proven-healthy publisher exists (exit 0 with a completed
      cycle);
    * no process crashed for an unrelated reason — a nonzero exit only counts
      as a refusal when it is ``OWNERSHIP_REFUSAL_EXIT`` with the marker;
    * no losing process is left running;
    * the final generation is coherent and matches the independent fold.

    The PASSING shape is exactly one of:

    * **refusal** — exactly one owner and exactly one named refusal, leaving
      exactly one publisher; or
    * **fence** — exactly one publisher, plus a lease row or advisory lock
      keyed by THIS zid (:func:`_zid_ownership_leases` /
      :func:`_zid_keyed_advisory_locks`).  A zid-keyed lock is necessary but
      not sufficient: two processes that both completed a full write cycle were
      not exclusively owned no matter what the catalog holds, so the publisher
      count is required as well (second-round review).

    Only the ownership question itself raises :class:`OwnershipNotFenced`.
    """
    seed_conversation(engine, zid=1, n_ptpts=6, n_cmts=4)
    kids, evidence = _run_two_latched_children(engine, pg_url, tmp_path,
                                               children)
    outcomes = [_classify(kid) for kid in kids]
    kinds = [kind for kind, _err in outcomes]

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
    exclusive = kinds.count("publisher") == 1
    fence_for_zid = (evidence.get("zid_leases") or
                     evidence.get("zid_advisory_locks"))

    if refused:
        # Shape 1: a named startup refusal. Reachable now that the helper waits
        # for either outcome rather than OWNED from both.
        assert len(refused) == 1 and evidence["owners"] == 1, (
            "a refusal must leave exactly one owner, not "
            f"{evidence['owners']} owners and {len(refused)} refusals"
        )
        assert exclusive, (
            f"one process refused, yet {kinds.count('publisher')} processes "
            f"published: {kinds}"
        )
        return

    if fence_for_zid and exclusive:
        # Shape 2: a real per-zid lease/lock AND observably exclusive
        # publication.
        return

    raise OwnershipNotFenced(
        "both duplicate processes started and completed a full write cycle "
        f"(outcomes {kinds}, owners={evidence.get('owners')}, "
        f"refusals={evidence.get('refusals')}); none refused with exit "
        f"{OWNERSHIP_REFUSAL_EXIT}/{OWNERSHIP_REFUSAL_MARKER}, no advisory "
        "lock keyed by zid 1 was held while both were alive "
        f"({evidence.get('zid_advisory_locks')}) and no lease row names it "
        f"with an owner and a version ({evidence.get('zid_leases')}). "
        "Diagnostics only, NOT accepted as fencing: advisory locks "
        f"{evidence['advisory_locks']}, lease/owner/fence/shard-named tables "
        f"{evidence['ownership_tables']}"
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
    assert evidence["held_concurrently"] and evidence["owners"] == 2, (
        "both duplicates were expected to take ownership concurrently: "
        f"owners={evidence['owners']} refusals={evidence['refusals']}"
    )
    assert [kid.proc.returncode for kid in kids] == [0, 0], (
        "both duplicates were expected to run to completion: "
        f"{[(k.proc.returncode, k.lines) for k in kids]}"
    )
    assert all("DONE" in kid.stages for kid in kids)
    assert evidence["advisory_locks"] == [], (
        "no advisory lock was taken while two duplicate writers were both "
        f"alive: {evidence['advisory_locks']}"
    )
    assert evidence["zid_advisory_locks"] == [] and evidence["zid_leases"] == [], (
        "no fence keyed by this zid existed either: "
        f"{evidence['zid_advisory_locks']} / {evidence['zid_leases']}"
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
        """The correction itself, controlled (review finding 3): a child
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

    # -- the fence detector itself (second-round review) -------------- #
    def test_an_unrelated_lease_named_table_is_not_a_fence(self, engine):
        """The correction, controlled: a table whose NAME merely matches
        lease/owner/fence/shard used to flip the acceptance green with the same
        two unfenced publishers.  It must now count as diagnostics only."""
        with engine.begin() as conn:
            conn.execute(sa.text(
                "create table unrelated_lease_notes "
                "(id int primary key, note text)"))
            conn.execute(sa.text(
                "insert into unrelated_lease_notes values (1, 'not a lease')"))
        try:
            assert "unrelated_lease_notes" in _ownership_table_names(engine), (
                "the diagnostic name scan should still see it"
            )
            assert _zid_ownership_leases(engine, 1) == [], (
                "NEGATIVE CONTROL FAILED: a lease-NAMED table with no zid, "
                "owner or version column was accepted as a fence"
            )
        finally:
            with engine.begin() as conn:
                conn.execute(sa.text("drop table unrelated_lease_notes"))

    def test_a_lease_table_without_a_version_is_not_a_fence(self, engine):
        """Owner without a version/fence token cannot distinguish a live owner
        from a stale one, so it is not a fence either."""
        with engine.begin() as conn:
            conn.execute(sa.text(
                "create table shard_owner_hint (zid int, owner text)"))
            conn.execute(sa.text(
                "insert into shard_owner_hint values (:z, 'pid-42')"),
                {"z": 1})
        try:
            assert _zid_ownership_leases(engine, 1) == [], (
                "NEGATIVE CONTROL FAILED: an owner column with no version / "
                "fence token was accepted as a fence"
            )
        finally:
            with engine.begin() as conn:
                conn.execute(sa.text("drop table shard_owner_hint"))

    def test_an_advisory_lock_on_an_unrelated_key_is_not_a_fence(self, engine):
        """An advisory lock for something else entirely must not read as
        ownership of THIS zid."""
        holder = engine.connect()
        try:
            holder.execute(sa.text("select pg_advisory_lock(4242, 987654)"))
            holder.commit()
            assert _advisory_locks(engine), (
                "the diagnostic scan should see the unrelated lock"
            )
            assert _zid_keyed_advisory_locks(engine, 1) == [], (
                "NEGATIVE CONTROL FAILED: an advisory lock keyed (4242, 987654) "
                "was accepted as ownership of zid 1"
            )
        finally:
            holder.execute(sa.text("select pg_advisory_unlock_all()"))
            holder.commit()
            holder.close()

    def test_a_real_per_zid_lease_row_is_recognised(self, engine):
        """...and the detector is not merely always-false: a lease row that
        names this zid with an owner AND a version IS a fence, so the xfail
        above is waiting on production rather than on an unreachable check."""
        with engine.begin() as conn:
            conn.execute(sa.text(
                "create table poller_shard_lease "
                "(zid int primary key, owner text, version bigint)"))
            conn.execute(sa.text(
                "insert into poller_shard_lease values (:z, 'poller-a', 7)"),
                {"z": 1})
        try:
            leases = _zid_ownership_leases(engine, 1)
            assert [(l["table"], l["owner"], l["version"]) for l in leases] == [
                ("poller_shard_lease", "poller-a", 7)
            ], leases
            assert _zid_ownership_leases(engine, 2) == [], (
                "a lease for one zid must not fence a different zid"
            )
        finally:
            with engine.begin() as conn:
                conn.execute(sa.text("drop table poller_shard_lease"))

    def test_a_real_per_zid_advisory_lock_is_recognised(self, engine):
        """Positive counterpart for the lock shape: a lock keyed by the zid, in
        either of Postgres' two encodings, IS recognised — and only for its own
        zid."""
        holder = engine.connect()
        try:
            holder.execute(sa.text("select pg_advisory_lock(1234, :z)"),
                           {"z": 1})
            holder.commit()
            locks = _zid_keyed_advisory_locks(engine, 1)
            assert locks, "a (namespace, zid) advisory lock was not recognised"
            assert all(l["objid"] == 1 and l["granted"] for l in locks), locks
            assert _zid_keyed_advisory_locks(engine, 2) == [], (
                "a lock keyed by one zid must not fence a different zid"
            )
        finally:
            holder.execute(sa.text("select pg_advisory_unlock_all()"))
            holder.commit()
            holder.close()

    # -- the ownership helper's accepted shapes ----------------------------- #
    def test_a_named_refusal_reaches_the_classifier(self):
        """The second correction, controlled: a child that legitimately REFUSED
        never emits OWNED, so waiting for OWNED from both children made the
        passing shape unreachable.  ``_await_ownership_outcome`` must settle it
        as a refusal without waiting for a stage that will never come."""
        class FakeProc:
            def __init__(self, returncode):
                self.returncode = returncode

            def poll(self):
                return self.returncode

        class FakeKid:
            def __init__(self, stages, lines, returncode):
                self.stages, self.lines = stages, lines
                self.proc = FakeProc(returncode)

        owner = FakeKid(["OWNED"], ["STAGE OWNED"], None)
        refuser = FakeKid(
            [], [f"{OWNERSHIP_REFUSAL_MARKER} ShardAlreadyOwned: pid 42"],
            OWNERSHIP_REFUSAL_EXIT)
        crashed = FakeKid([], ["boom"], 1)

        assert _await_ownership_outcome(owner, timeout=1) == "owned"
        assert _await_ownership_outcome(refuser, timeout=1) == "refused"
        assert _await_ownership_outcome(crashed, timeout=1) == "dead"

        # ...and the classifier then reads that refusal as a refusal, not a
        # crash, so the exactly-one-owner-plus-a-named-refusal shape passes.
        refuser.proc.stderr = None
        assert _classify(refuser)[0] == "refusal"
        crashed.proc.stderr = None
        assert _classify(crashed)[0] == "crash"

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
