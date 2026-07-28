#!/usr/bin/env python3
"""Math Poller CLI — the Python replacement for the Clojure math container.

Polls Postgres for votes/moderation, maintains per-conversation math state in
memory, and writes math_main / math_bidtopid / math_ptptstats under one
math_env.  See polismath.poller (package docstring) and
delphi/docs/MATH_POLLER_DESIGN.md.

Usage (was scripts/math_poller.py before cutover Step #4):
    uv run python -m polismath.poller            # run forever (SIGTERM stops)
    uv run python -m polismath.poller --once     # one poll cycle then exit
"""

import argparse
import logging
import os
import signal
import sys

from polismath.database.postgres import PostgresClient, PostgresConfig
from polismath.poller.service import MathPollerService, PollerConfig


def _configure_logging() -> None:
    level = os.environ.get("LOG_LEVEL", "INFO").upper()
    logging.basicConfig(
        level=getattr(logging, level, logging.INFO),
        format="%(asctime)s %(levelname)s [%(threadName)s] %(name)s: %(message)s",
    )


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
    service = _build_service(config)

    if args.once:
        log.info("Running a single poll cycle (--once)")
        service.poll_once()
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
