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
``after_main_commit``
    after ``write_math_main`` committed, before the other two tables
``before_final_table_commit``
    after main+bidtopid committed, before ``write_participant_stats``
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

    elif stage == "after_main_commit":
        real_main = pg.write_math_main

        def hooked_main(*a, **kw):
            result = real_main(*a, **kw)
            _emit(stage)
            _block_forever()

        pg.write_math_main = hooked_main

    elif stage == "before_final_table_commit":
        real_stats = pg.write_participant_stats

        def hooked_stats(*a, **kw):
            _emit(stage)
            _block_forever()

        pg.write_participant_stats = hooked_stats

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
