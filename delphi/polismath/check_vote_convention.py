#!/usr/bin/env python3
"""The job-boundary check (P-078): the database must declare its stored vote
sign before a Delphi job changes anything.

``run_delphi.py`` runs this script as its first stage, before the reset that
removes a conversation's previous results, so a job launched directly, or by
an older poller that never checked at boot, refuses before any side effect.
It reads ``public.vote_convention_current()`` exactly as the pollers do at
startup (``polismath.utils.vote_convention_boot``) and exits 1 with the
operator message when the migration is not applied, the row is missing, the
contract is unknown or the sign is not the one this build is built for.
Exit 0 prints the declared convention. It writes nothing anywhere.

    python polismath/check_vote_convention.py
"""
from __future__ import annotations

import logging
import os
import sys

from polismath.database.postgres import PostgresClient, PostgresConfig
from polismath.utils.vote_convention_boot import (
    VoteConventionRefusal,
    refuse_and_exit,
    require_declared_convention,
)

COMPONENT = "Delphi job"
logger = logging.getLogger("check_vote_convention")


def open_client() -> PostgresClient:
    """The same connection the math stage uses: DATABASE_URL, else the
    DATABASE_HOST/PORT/NAME/USER/PASSWORD variables."""
    client = PostgresClient(PostgresConfig(url=os.environ.get("DATABASE_URL") or None))
    client.initialize()
    return client


def main(argv=None) -> int:
    client = open_client()
    try:
        try:
            declared = require_declared_convention(lambda sql: client.query(sql), COMPONENT)
        except VoteConventionRefusal as exc:
            refuse_and_exit(exc, logger, exit_code=1)
    finally:
        try:
            client.shutdown()
        except Exception:  # noqa: BLE001 - the verdict is already decided
            pass
    print(f"vote convention: version {declared.version}, agree stored as {declared.agree_value}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
