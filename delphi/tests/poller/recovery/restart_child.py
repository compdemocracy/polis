"""A REAL poller process, killable at a NAMED stage — the R05 subject.

Run as a subprocess by ``test_r05_mid_batch_restart.py``.  It builds a real
``PostgresClient`` + ``MathPollerService`` against the test database, installs a
single hook at the requested stage, and — when that stage is reached — prints
``STAGE <name>`` on stdout and then blocks forever so the PARENT can deliver the
kill.  The kill is therefore genuinely external (SIGKILL from the test), which
is what P-022 §G requires: "A process kill is driven externally.  Stdin-only
crash simulations do not replace kill/restart tests."

Stages (the P-022 §C R05 list):

``after_poll``
    after the poll cycle advanced the watermark, before any compute.  This one
    is LATCHED, not merely hooked (astra review finding 4): see
    :func:`_install_after_poll_latch`.
``during_compute``
    inside ``Conversation.recompute``
``after_first_table_write``
    after the FIRST of the three table writes (``write_math_bidtopid``)
    executed, before the other two.  Under the production writer nothing is
    committed yet; under ``--legacy-writes`` that first table committed alone,
    which is the mixed generation the old writer could leave behind.
``before_final_table_write``
    after tick+bidtopid+ptptstats executed, before ``write_math_main`` — which
    is deliberately the LAST statement in the publication transaction, so this
    is the widest uncommitted window the writer ever has
``after_all_writes_before_cache``
    after all three writes committed, before the conversation is cached
``none``
    no kill: run one poll cycle and exit 0 (the restart process)
"""

import argparse
import os
import sys
import threading
import time


# Exit codes with a specific meaning to the parent tests.  A crash for any
# OTHER reason exits 1 (or dies by signal) and must never be mistaken for one
# of these (astra review findings 3 and 4).
EXIT_OK = 0
EXIT_OWNERSHIP_REFUSED = 3
EXIT_OWNERSHIP_LATCH_TIMEOUT = 4
EXIT_WATERMARK_NOT_ADVANCED = 5
EXIT_NO_DISPATCH = 6

OWNERSHIP_REFUSAL_MARKER = "OWNERSHIP-REFUSED"

# An ownership refusal is a NAMED, deliberate startup path — not "the process
# happened to die".  The poller has no such path today (that is R07's defect);
# these are the shapes a fix would take, and the parent test accepts nothing
# else as a refusal.
_OWNERSHIP_ERROR_NAMES = (
    "OwnershipRefused", "ShardAlreadyOwned", "DuplicateWriterRefused",
    "FenceRejected", "StaleFenceError",
)
_OWNERSHIP_ERROR_PATTERN = (
    r"already owned|duplicate writer|ownership (lease|refus)|advisory lock "
    r"(held|not acquired)|fencing token|stale fence"
)


def _emit(stage: str) -> None:
    sys.stdout.write(f"STAGE {stage}\n")
    sys.stdout.flush()


def _emit_line(line: str) -> None:
    """A non-STAGE acknowledgement line the parent can assert on, in order."""
    sys.stdout.write(f"{line}\n")
    sys.stdout.flush()


def _block_forever() -> None:
    """Park this process so the parent's SIGKILL lands at exactly this point."""
    threading.Event().wait()


def _is_ownership_refusal(exc: BaseException) -> bool:
    import re

    if type(exc).__name__ in _OWNERSHIP_ERROR_NAMES:
        return True
    return bool(re.search(_OWNERSHIP_ERROR_PATTERN, str(exc), re.I))


def _install_after_poll_latch(svc) -> None:
    """Make the ``after_poll`` kill point DETERMINISTIC.

    ``MathPollerService._poll_votes_once`` (``polismath/poller/service.py:433``)
    SUBMITS each zid's batch to the worker pool BEFORE assigning
    ``self._vote_wm`` (``:447``), and ``_run_engine`` runs on a POOL thread.  So
    hooking ``_run_engine`` alone — what this child used to do — emits the stage
    marker from another thread at a moment that may PRECEDE the watermark
    assignment; the SIGKILL is real but the named ordering "after the poll cycle
    advanced the watermark, before any compute" is unproven (astra review
    finding 4).

    The latch instead:

    1. gates ``_run_engine`` so no compute can start, and records that dispatch
       really happened (``GATE run_engine``).  The marker is WRITTEN AND FLUSHED
       BEFORE ``dispatched`` is set (astra second-round review): setting the
       event first lets the polling thread wake and print ``WM_ACK``/``STAGE``
       between the ``set()`` and the ``write()``, so the stdout ORDER the parent
       asserts would flake even though the watermark barrier itself is correct;
    2. lets ``_poll_votes_once`` RETURN, then reads the watermark it assigned
       and acknowledges it (``WM_ACK <value>``).  If the watermark did not
       advance, or the pool never picked the work up, the child exits with a
       distinct code instead of emitting the stage — so a vacuous pass is
       impossible;
    3. only then emits ``STAGE after_poll`` and parks for the parent's kill.
    """
    dispatched = threading.Event()
    hold = threading.Event()          # never set: the compute never starts

    def gated_run_engine(zid, coalesced):
        # ORDER MATTERS: emit + flush the marker BEFORE releasing the polling
        # thread.  `dispatched` is what unblocks `WM_ACK`/`STAGE after_poll` in
        # `latched_poll_votes_once`, so setting it first would let those two
        # lines reach stdout ahead of this one.  The event is now strictly the
        # LAST thing this gate does before parking.
        _emit_line(f"GATE run_engine zid={zid}")
        dispatched.set()
        hold.wait()

    svc._run_engine = gated_run_engine

    real_poll = svc._poll_votes_once
    wm_before = svc._vote_wm

    def latched_poll_votes_once():
        real_poll()
        wm_after = svc._vote_wm
        if wm_after is None or wm_before is None or wm_after <= wm_before:
            _emit_line(f"WM_NOT_ADVANCED before={wm_before} after={wm_after}")
            sys.stderr.write(
                f"after_poll latch: watermark did not advance "
                f"({wm_before} -> {wm_after}); refusing to claim the stage\n")
            sys.stderr.flush()
            os._exit(EXIT_WATERMARK_NOT_ADVANCED)
        if not dispatched.wait(60):
            _emit_line("NO_DISPATCH")
            sys.stderr.write("after_poll latch: the pool never entered "
                             "_run_engine; nothing was dispatched\n")
            sys.stderr.flush()
            os._exit(EXIT_NO_DISPATCH)
        _emit_line(f"WM_ACK {wm_after}")
        _emit("after_poll")
        _block_forever()

    svc._poll_votes_once = latched_poll_votes_once


def _hold_ownership(latch_dir: str) -> int:
    """Announce that this process has taken whatever ownership it takes, then
    wait for the parent to release.  Lets R07 prove that two duplicate writers
    were alive AT THE SAME TIME rather than merely one after the other."""
    os.makedirs(latch_dir, exist_ok=True)
    with open(os.path.join(latch_dir, f"owned.{os.getpid()}"), "w") as fh:
        fh.write(str(os.getpid()))
    _emit("OWNED")
    release = os.path.join(latch_dir, "release")
    deadline = time.monotonic() + 120.0
    while not os.path.exists(release):
        if time.monotonic() > deadline:
            sys.stderr.write("ownership latch was never released\n")
            sys.stderr.flush()
            return EXIT_OWNERSHIP_LATCH_TIMEOUT
        time.sleep(0.02)
    return EXIT_OK


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--legacy-writes", action="store_true",
                        help="Test-only negative control: commit each write separately")
    parser.add_argument("--pg-url", required=True)
    parser.add_argument("--math-env", required=True)
    parser.add_argument("--kill-stage", default="none")
    parser.add_argument("--poll-from-days-ago", type=float, default=1.0)
    parser.add_argument("--reconcile-interval-ms", type=int, default=60000)
    parser.add_argument(
        "--ownership-latch-dir", default=None,
        help=("Announce ownership into this directory (owned.<pid>) and wait "
              "for a 'release' file before polling, so the parent can prove "
              "two duplicate writers were alive CONCURRENTLY."),
    )
    args = parser.parse_args()

    import logging

    logging.disable(logging.CRITICAL)

    from polismath.conversation.conversation import Conversation
    from polismath.database.postgres import PostgresClient, PostgresConfig
    from polismath.poller.service import MathPollerService, PollerConfig

    # Startup is wrapped so that an OWNERSHIP refusal — a named, deliberate
    # refusal to run because someone else owns this shard — is reported with
    # its own exit code and marker, and can never be confused with an import
    # error, a DB outage or any other crash (astra review finding 3).  The
    # poller has no such path today; that absence is exactly what R07 asserts.
    try:
        pg = PostgresClient(
            PostgresConfig(url=args.pg_url, math_env=args.math_env,
                           ssl_mode="disable")
        )
        pg.initialize()
        if args.legacy_writes:
            # None tells each table writer to own/commit its transaction. Only
            # the victim uses this: survivors always run the production
            # atomic writer.
            from contextlib import nullcontext
            pg.transaction = lambda: nullcontext(None)
            # Standalone _write_returning also uses transaction(), so provide
            # its original implementation bound to the engine rather than
            # recurse.
            def legacy_returning(sql, params=None, *, connection=None):
                from sqlalchemy import text
                with pg.engine.begin() as conn:
                    result = conn.execute(text(sql), params or {})
                    # Mirror the real _write_returning: .mappings() on a
                    # statement with no result set raises. Every writer uses
                    # RETURNING today, so this only keeps the stand-in from
                    # drifting.
                    if not result.returns_rows:
                        return []
                    return [dict(row) for row in result.mappings().all()]
            pg._write_returning = legacy_returning
        svc = MathPollerService(
            pg,
            PollerConfig(
                database_url=args.pg_url,
                math_env=args.math_env,
                poll_from_days_ago=args.poll_from_days_ago,
                worker_pool_size=1,
                retry_cap=0,
                reconcile_interval_ms=args.reconcile_interval_ms,
                dump_dir=os.environ.get("POLIS_RECOVERY_DUMP_DIR",
                                        "/tmp/errorconv"),
            ),
        )
        svc._ensure_runtime()
    except BaseException as exc:  # noqa: BLE001 - classified and re-raised
        if _is_ownership_refusal(exc):
            _emit_line(f"{OWNERSHIP_REFUSAL_MARKER} {type(exc).__name__}: {exc}")
            sys.stderr.write(f"{OWNERSHIP_REFUSAL_MARKER}: {exc}\n")
            sys.stderr.flush()
            return EXIT_OWNERSHIP_REFUSED
        raise

    if args.ownership_latch_dir:
        held = _hold_ownership(args.ownership_latch_dir)
        if held != EXIT_OK:
            return held

    stage = args.kill_stage

    if stage == "after_poll":
        _install_after_poll_latch(svc)

    elif stage == "during_compute":
        real_recompute = Conversation.recompute

        def hooked_recompute(self, *a, **kw):
            _emit(stage)
            _block_forever()

        Conversation.recompute = hooked_recompute

    elif stage == "after_first_table_write":
        real_bidtopid = pg.write_math_bidtopid

        def hooked_bidtopid(*a, **kw):
            result = real_bidtopid(*a, **kw)
            _emit(stage)
            _block_forever()

        pg.write_math_bidtopid = hooked_bidtopid

    elif stage == "before_final_table_write":
        real_main = pg.write_math_main

        def hooked_main(*a, **kw):
            _emit(stage)
            _block_forever()

        pg.write_math_main = hooked_main

    elif stage == "after_all_writes_before_cache":
        real_remember = svc._remember

        def hooked_remember(zid, conv):
            _emit(stage)
            _block_forever()

        svc._remember = hooked_remember

    elif stage != "none":
        raise SystemExit(f"unknown --kill-stage {stage!r}")

    _emit("READY")
    svc.poll_once()
    _emit("DONE")
    svc.stop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
