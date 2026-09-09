"""Isolated home for the ONE reviewed wildcard SELECT of the poller-equivalence
harness — the guarded ``SELECT * FROM {table}`` in :func:`fetch_math_row` — and
the literal :data:`EQUIV_TABLES` tuple that guards it.

This module exists ONLY to hold that guarded query and its guard set, nothing
else, so that the projection-gate exemption pinned to it (a whole-module
``ast.dump`` digest in ``delphi/scripts/projection_inventory.py``) is disturbed
only by an edit to the query or its guard — never by an unrelated change to the
much larger :mod:`polismath.replay.poller_equiv`. Keep this module minimal: do
not add unrelated helpers here.
"""

from __future__ import annotations

from typing import Any

import sqlalchemy as sa

# The three data tables the feeder snapshots per (math_env, batch); the same
# three tables the spec's "compare" bullet names. Fixed constants ONLY — never
# interpolate a caller-supplied string into the SQL built from this tuple
# (:func:`fetch_math_row`) or the filesystem path built from it
# (``poller_equiv.snapshot_path``).
EQUIV_TABLES: tuple[str, ...] = ("math_main", "math_bidtopid", "math_ptptstats")


def fetch_math_row(conn: Any, table: str, zid: int, math_env: str) -> dict[str, Any] | None:
    """``SELECT * FROM <table> WHERE zid=:zid AND math_env=:math_env`` — same
    connection interface as :func:`wait_for_tick` (``.execute(text, params)``
    -> ``Result.mappings().first()``). ``table`` MUST be one of
    :data:`EQUIV_TABLES` — those are the only values ever interpolated into
    the SQL text (never a caller-supplied string)."""
    if table not in EQUIV_TABLES:
        raise ValueError(f"unknown equiv table {table!r}; expected one of {EQUIV_TABLES}")
    result = conn.execute(
        sa.text(f"SELECT * FROM {table} WHERE zid = :zid AND math_env = :math_env"),
        {"zid": zid, "math_env": math_env},
    )
    row = result.mappings().first()
    return dict(row) if row is not None else None
