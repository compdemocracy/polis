"""R02 — a newer revote arrives while the older one is being retried.

P-022 §C required matrix:

    Old agree fails; newer disagree is queued while worker is blocked; include
    pass and equal-time controlled-order variants.  Exercise coalesced and
    separately scheduled batches with real Conversation.  Final cell is the
    authoritative winner, timestamp agrees, counters use correct event/cell
    semantics.

P-019's review flagged that the existing M2 test used a fake conversation which
"retains per-cell timestamps that the actual merge does not
(``conversation.py:470``)".  These tests therefore drive the REAL
``Conversation`` against a REAL Postgres, and cover BOTH shapes:

* **coalesced** — the newer revote lands in the pool queue while the worker is
  latched inside the failing write, so the retry and the new batch merge into
  ONE ``CoalescedBatch`` and are resolved by ``update_votes``'s created-sort;
* **separately scheduled** — the retry batch runs alone to completion and the
  newer revote arrives in a LATER cycle, so the winner has to survive the
  cross-batch merge into already-newer state (``conversation.py:470``, the path
  with no per-cell timestamp guard).

The deterministic interleaving comes from a latch at the ``write_conv_updates``
boundary, never from a sleep.
"""

import threading

import pytest

from .conftest import (
    FaultInjector,
    InjectedFault,
    Latch,
    commit_vote,
    drain,
    fail_stage,
    read_math_tables,
    read_vote_events,
    seed_conversation,
    tables_are_coherent,
)
from . import fold as F
from polismath.poller.worker_pool import VOTES

pytestmark = pytest.mark.recovery

MATH_ENV = "recovery"
RAW_AGREE = F.RAW_AGREE          # -1 in storage
RAW_DISAGREE = F.RAW_DISAGREE    # +1 in storage
RAW_PASS = F.RAW_PASS            # 0


def _final_state(engine, zid=1):
    tables = read_math_tables(engine, zid, MATH_ENV)
    assert tables_are_coherent(tables) == [], tables_are_coherent(tables)
    fold = F.fold_votes(read_vote_events(engine, zid))
    problems = F.check_published_against_fold(tables["main"]["data"], fold)
    assert problems == [], problems
    return tables, fold


@pytest.mark.parametrize(
    "old_raw,new_raw,label",
    [
        (RAW_AGREE, RAW_DISAGREE, "agree-then-disagree"),
        (RAW_DISAGREE, RAW_AGREE, "disagree-then-agree"),
        (RAW_AGREE, RAW_PASS, "agree-then-pass"),
        (RAW_PASS, RAW_DISAGREE, "pass-then-disagree"),
    ],
)
def test_coalesced_newer_revote_wins_over_retried_older(
    engine, pg_url, make_service, old_raw, new_raw, label
):
    """The newer revote is queued WHILE the worker is latched inside the failing
    write of the older one.  Retry + new batch coalesce; the newer value must
    win, the timestamp must be the newer one, and counters must use cell (not
    event) semantics."""
    seed_conversation(engine, zid=1, n_ptpts=6, n_cmts=4)
    svc = make_service(pg_url, math_env=MATH_ENV, retry_cap=2, worker_pool_size=1)
    svc.poll_once()  # warm the cache with a published, good generation

    base = max(e["created"] for e in read_vote_events(engine, 1))
    t_old, t_new = base + 1000, base + 2000
    commit_vote(engine, 1, 0, 0, old_raw, t_old)

    at_write = Latch("write_conv_updates(old)")
    fault = FaultInjector(name="write(old)", mode="once")
    real_write = svc._writer.write_conv_updates

    def latched_write(zid, conv):
        if fault.should_fire():
            at_write.block()          # hold the worker here, batch in hand
            raise InjectedFault("old revote write failed")
        return real_write(zid, conv)

    svc._writer.write_conv_updates = latched_write

    svc._vote_wm = t_old - 1
    poller = threading.Thread(target=svc._poll_votes_once, daemon=True)
    poller.start()
    at_write.wait_arrival()

    # Worker is frozen INSIDE the failing write. Commit + enqueue the newer
    # revote; the pool queues it behind the in-flight cycle for this zid.
    commit_vote(engine, 1, 0, 0, new_raw, t_new)
    svc._pool.submit(1, VOTES, [{"zid": 1, "pid": 0, "tid": 0,
                                 "vote": F.raw_to_engine(new_raw),
                                 "created": t_new}])
    at_write.let_go()
    poller.join(timeout=30)
    svc._writer.write_conv_updates = real_write
    drain(svc)

    # Bounded eventual progress, no new input.
    svc._vote_wm = 0
    svc.poll_once()

    tables, fold = _final_state(engine, 1)
    expected = F.raw_to_engine(new_raw)
    assert fold.cells[(0, 0)] == expected, "fold disagrees with its own input"
    assert (0, 0) not in fold.ambiguous
    assert tables["main"]["last_vote_timestamp"] == t_new == fold.last_vote_timestamp

    # Cell semantics, not event semantics: participant 0 revoted the SAME cell
    # three times, so their count is unchanged from the seeded 4 cells.
    counts = {int(k): int(v)
              for k, v in tables["main"]["data"]["user-vote-counts"].items()}
    assert counts[0] == 4, f"{label}: revotes must not inflate the cell count"
    assert fold.event_count == 24 + 2, "both revote EVENTS are in the stream"


def test_separately_scheduled_older_retry_then_newer_batch(engine, pg_url,
                                                           make_service):
    """The retry of the older vote completes in its OWN batch, and the newer
    revote arrives in a LATER cycle merged into already-newer state — the
    cross-batch path (``conversation.py:470``) that has no per-cell timestamp
    guard."""
    seed_conversation(engine, zid=1, n_ptpts=6, n_cmts=4)
    svc = make_service(pg_url, math_env=MATH_ENV, retry_cap=2, worker_pool_size=1)
    svc.poll_once()

    base = max(e["created"] for e in read_vote_events(engine, 1))
    t_old, t_new = base + 1000, base + 2000

    # Cycle 1: the older agree fails once, then its retry succeeds ALONE.
    commit_vote(engine, 1, 0, 0, RAW_AGREE, t_old)
    fault = FaultInjector(name="write(old)", mode="once")
    undo = fail_stage(svc._writer, "write_conv_updates", fault)
    svc._vote_wm = t_old - 1
    svc.poll_once()
    undo()
    assert fault.fired == 1
    assert read_math_tables(engine, 1, MATH_ENV)["main"][
        "last_vote_timestamp"] == t_old

    # Cycle 2: the newer disagree, as a separate batch.
    commit_vote(engine, 1, 0, 0, RAW_DISAGREE, t_new)
    svc._vote_wm = t_new - 1
    svc.poll_once()

    tables, fold = _final_state(engine, 1)
    assert fold.cells[(0, 0)] == F.ENGINE_DISAGREE
    assert tables["main"]["last_vote_timestamp"] == t_new


def _apply_new_then_old(engine, svc, t_old, t_new):
    """Apply the NEWER revote as its own batch, then replay the OLDER one as a
    separate, later batch."""
    svc._pool.submit(1, VOTES, [{"zid": 1, "pid": 0, "tid": 0,
                                 "vote": F.ENGINE_DISAGREE, "created": t_new}])
    drain(svc)
    assert read_math_tables(engine, 1, MATH_ENV)["main"][
        "last_vote_timestamp"] == t_new
    svc._pool.submit(1, VOTES, [{"zid": 1, "pid": 0, "tid": 0,
                                 "vote": F.ENGINE_AGREE, "created": t_old}])
    drain(svc)


def test_late_older_batch_does_not_regress_the_watermark(engine, pg_url,
                                                         make_service):
    """The watermark half of the new-then-old ordering: ``advance_watermark``'s
    monotonic max means a late OLDER batch can never pull
    ``last_vote_timestamp`` backwards.  This part holds today."""
    seed_conversation(engine, zid=1, n_ptpts=6, n_cmts=4)
    svc = make_service(pg_url, math_env=MATH_ENV, retry_cap=0, worker_pool_size=1)
    svc.poll_once()

    base = max(e["created"] for e in read_vote_events(engine, 1))
    t_old, t_new = base + 1000, base + 2000
    commit_vote(engine, 1, 0, 0, RAW_AGREE, t_old)
    commit_vote(engine, 1, 0, 0, RAW_DISAGREE, t_new)
    _apply_new_then_old(engine, svc, t_old, t_new)

    main = read_math_tables(engine, 1, MATH_ENV)["main"]
    fold = F.fold_votes(read_vote_events(engine, 1))
    assert main["last_vote_timestamp"] == t_new == fold.last_vote_timestamp, (
        "a late older batch must never regress the watermark"
    )


@pytest.mark.xfail(
    strict=True,
    reason=(
        "DEFECT (latent, retained regression): merging an OLDER batch into "
        "already-newer conversation state overwrites the newer cell. "
        "polismath/conversation/conversation.py:387 sorts by `created` WITHIN "
        "one payload, but the merge into existing state at "
        "polismath/conversation/conversation.py:470 has NO per-cell timestamp "
        "guard, so a batch whose events are all older than the stored cell "
        "still wins. Observed here: with the newer DISAGREE published first, a "
        "later OLDER-AGREE batch flips tid 0 back to A=3/D=3 where the "
        "independent fold says A=2/D=4. The published watermark is unaffected "
        "(advance_watermark is a monotonic max), so nothing else signals the "
        "regression. REACHABILITY: the current pool cannot produce this "
        "ordering on its own — _requeue runs on the worker thread before it "
        "re-checks the queue (poller/service.py:664), so a retry always "
        "coalesces with any newer batch instead of following it. This is "
        "therefore a hardening gap and a retained regression test, not a "
        "presently-triggerable production bug; any future change that lets a "
        "stale batch be scheduled separately (a second writer, a queue "
        "reorder, a cross-process replay) turns it into one."
    ),
)
def test_late_older_batch_must_not_overwrite_the_newer_cell(engine, pg_url,
                                                            make_service):
    """The cell-value half of the new-then-old ordering — the authoritative
    winner must still be the newer value."""
    seed_conversation(engine, zid=1, n_ptpts=6, n_cmts=4)
    svc = make_service(pg_url, math_env=MATH_ENV, retry_cap=0, worker_pool_size=1)
    svc.poll_once()

    base = max(e["created"] for e in read_vote_events(engine, 1))
    t_old, t_new = base + 1000, base + 2000
    commit_vote(engine, 1, 0, 0, RAW_AGREE, t_old)
    commit_vote(engine, 1, 0, 0, RAW_DISAGREE, t_new)
    _apply_new_then_old(engine, svc, t_old, t_new)

    tables, fold = _final_state(engine, 1)
    assert fold.cells[(0, 0)] == F.ENGINE_DISAGREE


def test_equal_time_controlled_order_is_flagged_ambiguous(engine, pg_url,
                                                          make_service):
    """Equal-``created`` opposite votes on one cell: the DB's
    ``ORDER BY zid, tid, pid, created`` does not break the tie, so no single
    winner may be asserted.  The published value must be ONE of the two, the
    watermark must be the shared timestamp, and the cell count must still be 1.

    P-022 §A: "Ambiguous equal-time opposite votes need a separately specified
    contract/test; do not invent historical order."
    """
    seed_conversation(engine, zid=1, n_ptpts=6, n_cmts=4)
    svc = make_service(pg_url, math_env=MATH_ENV, worker_pool_size=1)
    svc.poll_once()

    base = max(e["created"] for e in read_vote_events(engine, 1))
    tie = base + 1000
    commit_vote(engine, 1, 0, 0, RAW_AGREE, tie)
    commit_vote(engine, 1, 0, 0, RAW_DISAGREE, tie)

    svc._vote_wm = tie - 1
    svc.poll_once()

    fold = F.fold_votes(read_vote_events(engine, 1))
    assert (0, 0) in fold.ambiguous, (
        "the fold must REFUSE to pick a winner for an equal-time opposite pair"
    )
    tables = read_math_tables(engine, 1, MATH_ENV)
    assert tables_are_coherent(tables) == []
    data = tables["main"]["data"]
    assert data["lastVoteTimestamp"] == tie == fold.last_vote_timestamp
    counts = {int(k): int(v) for k, v in data["user-vote-counts"].items()}
    assert counts[0] == 4, "an ambiguous tie is still ONE cell"
    totals = F.votes_base_totals(data)
    assert totals[0]["S"] == 6, "six participants have an observed cell on tid 0"
    assert totals[0]["A"] + totals[0]["D"] == 6
    # Exactly one of the two possible resolutions, and nothing else.
    assert (totals[0]["A"], totals[0]["D"]) in {(3, 3), (4, 2), (2, 4)}


# --------------------------------------------------------------------------- #
# Negative control for the retry-ordering failure class
# --------------------------------------------------------------------------- #
class TestNegativeControl:
    def test_stale_older_value_would_be_caught(self, engine, pg_url,
                                               make_service):
        """Intentionally broken variant: publish the state produced by applying
        ONLY the older vote, and check that the R02 assertions go red.  This
        proves the suite would notice a retry that overwrote a newer revote."""
        seed_conversation(engine, zid=1, n_ptpts=6, n_cmts=4)
        svc = make_service(pg_url, math_env=MATH_ENV, worker_pool_size=1)
        svc.poll_once()

        base = max(e["created"] for e in read_vote_events(engine, 1))
        t_old, t_new = base + 1000, base + 2000
        commit_vote(engine, 1, 0, 0, RAW_AGREE, t_old)
        commit_vote(engine, 1, 0, 0, RAW_DISAGREE, t_new)

        # The BROKEN behaviour: only the older batch is ever applied.
        svc._pool.submit(1, VOTES, [{"zid": 1, "pid": 0, "tid": 0,
                                     "vote": F.ENGINE_AGREE, "created": t_old}])
        drain(svc)

        tables = read_math_tables(engine, 1, MATH_ENV)
        fold = F.fold_votes(read_vote_events(engine, 1))
        problems = F.check_published_against_fold(tables["main"]["data"], fold)
        assert problems, (
            "NEGATIVE CONTROL FAILED: publishing only the OLDER revote was "
            "accepted as matching the input fold"
        )
        assert tables["main"]["last_vote_timestamp"] != fold.last_vote_timestamp
