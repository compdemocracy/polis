#!/usr/bin/env python3
"""Math Poller CLI — the Python replacement for the Clojure math container.

Polls Postgres for votes/moderation, maintains per-conversation math state in
memory, and writes math_main / math_bidtopid / math_ptptstats under one
math_env.  See polismath.poller (package docstring) and
delphi/docs/MATH_POLLER_DESIGN.md.

Usage:
    uv run python scripts/math_poller.py            # run forever (SIGTERM stops)
    uv run python scripts/math_poller.py --once      # one poll cycle then exit
"""

import argparse
import logging
import os
import signal
import sys

from polismath.database.postgres import PostgresClient, PostgresConfig
from polismath.poller.service import MathPollerService, PollerConfig, PoolDrainTimeout


def _configure_logging() -> None:
    level = os.environ.get("LOG_LEVEL", "INFO").upper()
    logging.basicConfig(
        level=getattr(logging, level, logging.INFO),
        format="%(asctime)s %(levelname)s [%(threadName)s] %(name)s: %(message)s",
    )


# The math_env the server reads (the legacy Clojure engine's namespace). While
# this poller runs as a shadow beside that engine, writing under it would
# overwrite the served rows, so startup refuses it unless explicitly allowed.
SERVED_MATH_ENV = "prod"
ALLOW_SERVED_ENV_VAR = "MATH_POLLER_ALLOW_SERVED_ENV"


def _refuse_served_env(math_env: str) -> None:
    """Exit non-zero before touching the database when MATH_ENV is unsafe.

    Refused: an empty or whitespace-only MATH_ENV (always), and the served
    namespace ``prod`` unless MATH_POLLER_ALLOW_SERVED_ENV=1 (cut-over only).
    """
    if not math_env.strip():
        print(
            "refusing to start: MATH_ENV is empty; set it to the poller's own "
            "namespace (e.g. python)",
            file=sys.stderr,
        )
        raise SystemExit(2)
    if (
        math_env.strip() == SERVED_MATH_ENV
        and os.environ.get(ALLOW_SERVED_ENV_VAR) != "1"
    ):
        print(
            f"refusing to start: MATH_ENV={SERVED_MATH_ENV} is the served "
            f"namespace and would overwrite the served math rows; set "
            f"{ALLOW_SERVED_ENV_VAR}=1 only to cut over",
            file=sys.stderr,
        )
        raise SystemExit(2)


def _build_service(config: PollerConfig) -> MathPollerService:
    if not config.database_url:
        print("DATABASE_URL is required", file=sys.stderr)
        raise SystemExit(2)
    pg = PostgresClient(PostgresConfig(url=config.database_url, math_env=config.math_env))
    pg.initialize()
    return MathPollerService(pg, config)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Polis Python math poller")
    parser.add_argument(
        "--once",
        action="store_true",
        help="Run a single vote+moderation poll cycle, block until processed, exit.",
    )
    args = parser.parse_args(argv)

    _configure_logging()
    log = logging.getLogger("math_poller")

    config = PollerConfig.from_env()
    _refuse_served_env(config.math_env)
    service = _build_service(config)

    if args.once:
        log.info("Running a single poll cycle (--once)")
        try:
            service.poll_once()
        except PoolDrainTimeout as exc:
            # Report through the logger _configure_logging() just set up, the
            # way _build_service reports its own failure, instead of letting
            # the default excepthook print a bare traceback to stderr.
            log.error("Single poll cycle did not complete: %s", exc)
            # stop() here rather than leaving the pool to
            # concurrent.futures' interpreter-exit hook: the shutdown is then
            # inside main's control and logged. A worker stuck FOREVER still
            # blocks — shutdown(wait=True) joins non-daemon executor threads
            # either way, and forcing exit past that would need os._exit.
            service.stop()
            return 1
        service.stop()
        return 0

    # Graceful shutdown on SIGTERM/SIGINT (docker stop, Ctrl-C).
    def _handle_signal(signum, _frame):
        log.info("Received signal %s; stopping poller", signum)
        service._stop.set()

    signal.signal(signal.SIGTERM, _handle_signal)
    signal.signal(signal.SIGINT, _handle_signal)

    log.info(
        "Starting math poller: math_env=%s vote_interval=%dms mod_interval=%dms "
        "pool=%d",
        config.math_env,
        config.vote_interval_ms,
        config.mod_interval_ms,
        config.worker_pool_size,
    )
    service.run_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
