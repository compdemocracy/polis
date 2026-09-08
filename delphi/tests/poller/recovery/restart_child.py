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
    after the poll cycle advanced the watermark, before any compute
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


def _emit(stage: str) -> None:
    sys.stdout.write(f"STAGE {stage}\n")
    sys.stdout.flush()


def _block_forever() -> None:
    """Park this process so the parent's SIGKILL lands at exactly this point."""
    threading.Event().wait()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--legacy-writes", action="store_true",
                        help="Test-only negative control: commit each write separately")
    parser.add_argument("--pg-url", required=True)
    parser.add_argument("--math-env", required=True)
    parser.add_argument("--kill-stage", default="none")
    parser.add_argument("--poll-from-days-ago", type=float, default=1.0)
    parser.add_argument("--reconcile-interval-ms", type=int, default=60000)
    args = parser.parse_args()

    import logging

    logging.disable(logging.CRITICAL)

    from polismath.conversation.conversation import Conversation
    from polismath.database.postgres import PostgresClient, PostgresConfig
    from polismath.poller.service import MathPollerService, PollerConfig

    pg = PostgresClient(
        PostgresConfig(url=args.pg_url, math_env=args.math_env,
                       ssl_mode="disable")
    )
    pg.initialize()
    if args.legacy_writes:
        # None tells each table writer to own/commit its transaction. Only the
        # victim uses this: survivors always run the production atomic writer.
        from contextlib import nullcontext
        pg.transaction = lambda: nullcontext(None)
        # Standalone _write_returning also uses transaction(), so provide its
        # original implementation bound to the engine rather than recurse.
        def legacy_returning(sql, params=None, *, connection=None):
            from sqlalchemy import text
            with pg.engine.begin() as conn:
                result = conn.execute(text(sql), params or {})
                # Mirror the real _write_returning: .mappings() on a statement
                # with no result set raises. Every writer uses RETURNING today,
                # so this only keeps the stand-in from drifting.
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
            dump_dir=os.environ.get("POLIS_RECOVERY_DUMP_DIR", "/tmp/errorconv"),
        ),
    )
    svc._ensure_runtime()

    stage = args.kill_stage

    if stage == "after_poll":
        real = svc._run_engine

        def hooked(zid, coalesced):
            _emit(stage)
            _block_forever()

        svc._run_engine = hooked

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
