"""R10 — poll/load failure and fairness (REAL Postgres).

P-022 §C required matrix:

    Fail vote/mod SELECT, math_main load and full-history load; verify no false
    empty publication or inappropriate watermark advancement, and subsequent
    quiet recovery.  One poison zid must not starve healthy zids.  Exhaust a
    join timeout: ``poll_once`` must surface failure, not successful completion
    (``service.py:350``).
"""

import threading
import time

import pytest

from .conftest import (
    FaultInjector,
    InjectedFault,
    commit_vote,
    drain,
    fail_stage,
    read_math_tables,
    read_vote_events,
    seed_conversation,
    tables_are_coherent,
)
from . import fold as F
from polismath.poller import service as _service

pytestmark = pytest.mark.recovery

MATH_ENV = "recovery"

# The join-timeout contract, named rather than inferred (review of #2708).
#
# #2708 introduces ``PoolDrainTimeout(TimeoutError)`` in
# ``polismath/poller/service.py`` precisely so an exhausted POOL DRAIN is
# distinguishable from a socket/DB ``TimeoutError`` (the builtin is an
# ``OSError``, so a bare ``except TimeoutError`` would swallow both).  It does
# not exist on this base, so the assertion resolves the class BY NAME and falls
# back to the builtin: the test states the same contract before and after #2708
# and needs no edit on rebase.
POOL_DRAIN_TIMEOUT = getattr(_service, "PoolDrainTimeout", TimeoutError)


def _assert_published(engine, zid):
    tables = read_math_tables(engine, zid, MATH_ENV)
    assert tables_are_coherent(tables) == [], tables_are_coherent(tables)
    fold = F.fold_votes(read_vote_events(engine, zid))
    assert F.check_published_against_fold(tables["main"]["data"], fold) == []
    return tables


# --------------------------------------------------------------------------- #
# Poll SELECT failures
# --------------------------------------------------------------------------- #
def test_failing_vote_select_does_not_advance_the_watermark(engine, pg_url,
                                                            make_service):
    """A failed vote poll must leave the watermark untouched (so nothing is
    skipped) and must recover on the next cycle."""
    seed_conversation(engine, zid=1, n_ptpts=6, n_cmts=4)
    svc = make_service(pg_url, math_env=MATH_ENV, worker_pool_size=1)
    before = svc._vote_wm

    injector = FaultInjector(name="poll_votes_since", mode="always")
    undo = fail_stage(svc._pg, "poll_votes_since", injector)
    with pytest.raises(InjectedFault):
        svc._poll_votes_once()
    undo()

    assert svc._vote_wm == before, "a failed poll must not advance the watermark"
    assert read_math_tables(engine, 1, MATH_ENV)["main"] is None

    svc.poll_once()
    _assert_published(engine, 1)


def test_failing_moderation_select_does_not_advance_the_watermark(engine,
                                                                  pg_url,
                                                                  make_service):
    seed_conversation(engine, zid=1, n_ptpts=6, n_cmts=4)
    svc = make_service(pg_url, math_env=MATH_ENV, worker_pool_size=1)
    before = svc._mod_wm

    injector = FaultInjector(name="poll_moderation_since", mode="always")
    undo = fail_stage(svc._pg, "poll_moderation_since", injector)
    with pytest.raises(InjectedFault):
        svc._poll_moderation_once()
    undo()

    assert svc._mod_wm == before
    svc.poll_once()
    _assert_published(engine, 1)


def test_vote_loop_survives_a_failing_poll_and_recovers(engine, pg_url,
                                                        make_service):
    """The running loop swallows and logs the poll failure (``_vote_loop``,
    ``service.py:367``) and the very next cycle publishes correctly."""
    seed_conversation(engine, zid=1, n_ptpts=6, n_cmts=4)
    svc = make_service(pg_url, math_env=MATH_ENV, worker_pool_size=1)
    injector = FaultInjector(name="poll_votes_since", mode="once")
    undo = fail_stage(svc._pg, "poll_votes_since", injector)
    try:
        svc._poll_votes_once()
    except InjectedFault:
        pass
    undo()
    svc.poll_once()
    _assert_published(engine, 1)


# --------------------------------------------------------------------------- #
# Load failures
# --------------------------------------------------------------------------- #
def test_failing_math_main_load_cold_starts_without_a_false_empty(engine,
                                                                  pg_url,
                                                                  make_service):
    """``_load_or_init`` swallows a ``load_math_main`` failure and cold-starts
    (``service.py:570``).  That is safe ONLY because the rebuild then reads the
    full authoritative vote history — assert the published result is the full
    fold, not an empty conversation."""
    seed_conversation(engine, zid=1, n_ptpts=6, n_cmts=4)
    svc = make_service(pg_url, math_env=MATH_ENV, worker_pool_size=1)
    svc.poll_once()
    _assert_published(engine, 1)

    injector = FaultInjector(name="load_math_main", mode="always")
    undo = fail_stage(svc._pg, "load_math_main", injector)
    svc._convs.pop(1, None)
    base = max(e["created"] for e in read_vote_events(engine, 1))
    commit_vote(engine, 1, 0, 0, F.RAW_DISAGREE, base + 1000)
    svc._vote_wm = base
    svc.poll_once()
    undo()

    assert injector.fired >= 1, "the load failure must have fired"
    tables = _assert_published(engine, 1)
    assert tables["main"]["data"]["n"] == 6, (
        "a swallowed load failure must not publish an EMPTY conversation"
    )


def test_failing_full_history_load_never_publishes(engine, pg_url,
                                                   make_service):
    """A failing full-history ``poll_votes`` is NOT swallowed: it must abort the
    cycle (retry/park) rather than publish an empty or partial conversation."""
    seed_conversation(engine, zid=1, n_ptpts=6, n_cmts=4)
    svc = make_service(pg_url, math_env=MATH_ENV, worker_pool_size=1,
                       retry_cap=0)

    injector = FaultInjector(name="poll_votes", mode="always")
    undo = fail_stage(svc._pg, "poll_votes", injector)
    svc.poll_once()
    undo()

    assert injector.fired >= 1
    assert 1 in svc._parked, "the zid must park rather than publish"
    assert read_math_tables(engine, 1, MATH_ENV)["main"] is None, (
        "a failed full-history load must never publish a false empty result"
    )

    svc._reconcile_once()
    drain(svc)
    _assert_published(engine, 1)


def test_an_existing_row_is_never_replaced_by_an_empty_one(engine, pg_url,
                                                           make_service):
    """The worst false-empty shape: a good math_main row must never be
    overwritten by an empty conversation because a load failed."""
    seed_conversation(engine, zid=1, n_ptpts=6, n_cmts=4)
    svc = make_service(pg_url, math_env=MATH_ENV, worker_pool_size=1,
                       retry_cap=0)
    svc.poll_once()
    good = read_math_tables(engine, 1, MATH_ENV)["main"]

    load_fault = FaultInjector(name="load_math_main", mode="always")
    hist_fault = FaultInjector(name="poll_votes", mode="always")
    undo1 = fail_stage(svc._pg, "load_math_main", load_fault)
    undo2 = fail_stage(svc._pg, "poll_votes", hist_fault)
    svc._convs.pop(1, None)
    svc._pool.submit(1, "rebuild", [])
    drain(svc)
    undo1()
    undo2()

    after = read_math_tables(engine, 1, MATH_ENV)["main"]
    assert after["data"] == good["data"], (
        "the previously published row was replaced while both loads were "
        "failing"
    )


# --------------------------------------------------------------------------- #
# Fairness
# --------------------------------------------------------------------------- #
def test_one_poison_zid_does_not_starve_healthy_zids(engine, pg_url,
                                                     make_service):
    """A permanently failing zid must not stop healthy conversations from
    making progress, across repeated cycles."""
    zids = [1, 2, 3, 4]
    for zid in zids:
        seed_conversation(engine, zid=zid, n_ptpts=4, n_cmts=3)
    svc = make_service(pg_url, math_env=MATH_ENV, worker_pool_size=2,
                       retry_cap=1)

    real_write = svc._writer.write_conv_updates
    attempts = {"poison": 0}

    def poison(zid, conv):
        if zid == 1:
            attempts["poison"] += 1
            raise InjectedFault("poison zid")
        return real_write(zid, conv)

    svc._writer.write_conv_updates = poison

    for cycle in range(3):
        svc._vote_wm = 0
        svc.poll_once()
        for zid in zids[1:]:
            assert read_math_tables(engine, zid, MATH_ENV)["main"] is not None, (
                f"healthy zid {zid} starved on cycle {cycle}"
            )
    svc._writer.write_conv_updates = real_write

    assert 1 in svc._parked, "the poison zid must be visibly parked"
    for zid in zids[1:]:
        _assert_published(engine, zid)
    # Bounded, not a hot loop: 2 attempts to park + 2 per later reconcile pass.
    assert attempts["poison"] <= 2 + 2 * 3, (
        f"the poison zid consumed {attempts['poison']} attempts — unbounded "
        "retrying starves the pool"
    )


# --------------------------------------------------------------------------- #
# The join timeout
# --------------------------------------------------------------------------- #
@pytest.mark.xfail(
    strict=True,
    reason=(
        "DEFECT (P-022 §C R10): poll_once IGNORES the pool join result. "
        "polismath/poller/service.py:365 calls `self._pool.join(timeout=120.0)` "
        "and discards its boolean; ConversationWorkerPool.join returns False on "
        "timeout (polismath/poller/worker_pool.py:156). So a cycle whose work "
        "never drained returns NORMALLY and looks like a completed poll — the "
        "`--once` CLI exits 0, and the integration harness treats a stuck "
        "conversation as a successful cycle. P-022 §C: 'Exhaust a join timeout: "
        "poll_once must surface failure, not successful completion.' The fix is "
        "to raise (or return a status) when join() is False; that is a separate "
        "decision (#2708 raises PoolDrainTimeout). The oracle requires the poll "
        "thread to have COMPLETED and the failure to be that named class "
        "(resolved by name, falling back to the builtin TimeoutError on this "
        "base): a permanently hung observer used to satisfy the old "
        "`raised is not None or not returned` form."
    ),
)
def test_poll_once_surfaces_a_join_timeout(engine, pg_url, make_service):
    """Stall a worker past the join bound and require ``poll_once`` to surface
    the failure instead of returning as if the cycle completed."""
    seed_conversation(engine, zid=1, n_ptpts=4, n_cmts=3)
    svc = make_service(pg_url, math_env=MATH_ENV, worker_pool_size=1)

    stalled = threading.Event()
    release = threading.Event()
    real_load = svc._load_or_init

    def stalling_load(zid):
        stalled.set()
        release.wait(timeout=60)
        return real_load(zid)

    svc._load_or_init = stalling_load

    # Shrink the join bound so the timeout is reached deterministically, and
    # observe what poll_once does with it.
    real_join = svc._pool.join
    svc._pool.join = lambda timeout=120.0: real_join(timeout=0.5)

    result = {"returned": False, "raised": None}

    def run():
        try:
            svc.poll_once()
            result["returned"] = True
        except BaseException as exc:
            result["raised"] = exc

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    assert stalled.wait(timeout=30), "the worker never stalled"
    thread.join(timeout=30)

    try:
        # "or not returned" alone was satisfied by an observer that simply
        # HUNG — the very failure mode this row is about (review of
        # #2708).  Require both halves of the contract instead.
        assert not thread.is_alive(), (
            "poll_once never came back at all: a permanently blocked cycle is "
            "not a surfaced failure, and must not satisfy this assertion"
        )
        raised = result["raised"]
        assert raised is not None and not result["returned"], (
            "poll_once returned normally after its pool join timed out with "
            "work still in flight — a stuck cycle is indistinguishable from a "
            "successful one"
        )
        assert isinstance(raised, POOL_DRAIN_TIMEOUT), (
            f"the exhausted pool drain surfaced as "
            f"{type(raised).__name__}: {raised!r}; it must be "
            f"{POOL_DRAIN_TIMEOUT.__name__}, so a drain failure is separately "
            "catchable from a socket/DB timeout"
        )
    finally:
        release.set()
        svc._pool.join = real_join
        svc._load_or_init = real_load
        drain(svc)


# --------------------------------------------------------------------------- #
# Negative control for the poll/load failure class
# --------------------------------------------------------------------------- #
class TestNegativeControl:
    def test_a_hung_observer_is_not_a_surfaced_failure(self):
        """The join-timeout correction, controlled (review of #2708): a
        poll thread that simply never comes back satisfied the old
        ``raised is not None or not returned`` form.  The tightened oracle must
        go red on it, and its class check must be real."""
        hung = threading.Event()
        thread = threading.Thread(target=lambda: hung.wait(30), daemon=True)
        thread.start()
        try:
            result = {"returned": False, "raised": None}
            # The old form: green on an observer that never returned at all.
            assert result["raised"] is not None or not result["returned"]
            # The tightened form: red, as it must be.
            with pytest.raises(AssertionError):
                assert not thread.is_alive(), "poll_once never came back"
        finally:
            hung.set()
            thread.join(timeout=10)
        assert not thread.is_alive()

        # ...and the named class is not merely "any exception".
        assert not isinstance(RuntimeError("boom"), POOL_DRAIN_TIMEOUT)
        assert issubclass(POOL_DRAIN_TIMEOUT, TimeoutError), (
            "PoolDrainTimeout must stay a TimeoutError subclass so existing "
            "handlers keep matching"
        )

    def test_a_watermark_that_advances_on_failure_is_caught(self, engine,
                                                            pg_url,
                                                            make_service):
        """Intentionally broken variant: advance the watermark BEFORE the
        (failing) poll.  The R10 assertion must go red, proving it can see an
        inappropriate advancement."""
        seed_conversation(engine, zid=1, n_ptpts=4, n_cmts=3)
        svc = make_service(pg_url, math_env=MATH_ENV, worker_pool_size=1)
        before = svc._vote_wm

        def broken_poll(since):
            svc._vote_wm = since + 1_000_000   # advance first, then fail
            raise InjectedFault("poll failed after advancing")

        svc._pg.poll_votes_since = broken_poll
        with pytest.raises(InjectedFault):
            svc._poll_votes_once()

        with pytest.raises(AssertionError):
            assert svc._vote_wm == before, "a failed poll must not advance"

    def test_a_false_empty_publication_is_caught(self, engine, pg_url,
                                                 make_service):
        """Publish an EMPTY conversation on purpose; the fold check must reject
        it."""
        seed_conversation(engine, zid=1, n_ptpts=4, n_cmts=3)
        svc = make_service(pg_url, math_env=MATH_ENV, worker_pool_size=1)
        real_history = svc._pg.poll_votes
        svc._pg.poll_votes = lambda zid, since=None: []
        svc.poll_once()
        svc._pg.poll_votes = real_history

        tables = read_math_tables(engine, 1, MATH_ENV)
        fold = F.fold_votes(read_vote_events(engine, 1))
        problems = F.check_published_against_fold(tables["main"]["data"], fold)
        assert problems, (
            "NEGATIVE CONTROL FAILED: an EMPTY publication was accepted as "
            "matching a conversation with 12 votes"
        )
