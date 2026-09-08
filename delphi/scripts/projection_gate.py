#!/usr/bin/env python3
"""Projection gate for the served ``votes`` / ``votes_latest_unique`` wire contract.

WHY THIS EXISTS
---------------
Two live read paths return these tables with a wildcard, so any column added to
``votes`` or ``votes_latest_unique`` would reach the wire the instant a migration
commits:

  * ``server/src/routes/votes.ts`` ``votesGet`` — ``sql_votes_latest_unique.star()``
    (node-sql emits ``SELECT "votes_latest_unique".*``), executed through
    ``pg.query_readOnly``.
  * ``server/src/routes/votes.ts`` ``handle_GET_votes_me`` —
    ``SELECT * FROM votes WHERE zid = ($1) AND pid = ($2)``, also through
    ``pg.query_readOnly``.

``query_readOnly`` resolves to the replica pool when ``READ_ONLY_DATABASE_URL`` is
set (``server/src/db/pg-query.ts``), so the replica path is in scope: run this gate
a second time with ``--dsn`` pointed at a replica.

WHAT THIS TOOL DOES
-------------------
It freezes the column list that each site is allowed to serve today, then compares
that frozen ("expected") projection against the actual served wildcard projection,
cell by cell, and classifies every difference. There is NO approved-difference
list: the only passing state is total byte equality (every cell IDENTICAL, no extra
column, no missing column, no reordered column). When a future migration adds an
internal column, the wildcard returns it, the frozen projection does not, and the
gate reports ``EXTRA_FIELD`` — which is exactly the leak this gate is meant to catch
(see the negative-control test).

FROZEN COLUMN LISTS (verified against edge migrations 000000..000018)
---------------------------------------------------------------------
  * ``votes``               -> zid, pid, tid, vote, weight_x_32767, created, high_priority
  * ``votes_latest_unique`` -> zid, pid, tid, vote, weight_x_32767, modified

``created``/``high_priority`` come from ``000000_initial.sql`` and
``000008_add_comment_priority.sql``; ``votes_latest_unique`` is unchanged since
``000000``. ``vote_event_id`` / ``selected_vote_event_id`` do NOT exist on edge —
they are introduced later by P-047, and catching them is the whole point of the gate.

SAFETY (read-only, zero DDL, zero extra locks)
----------------------------------------------
This module issues nothing but ``SELECT`` (plus a ``SET TRANSACTION READ ONLY``
guard). Enforcement is layered:
  1. the connection is opened with ``set_session(readonly=True)`` so every
     transaction is read-only at the server;
  2. each transaction additionally begins with ``SET TRANSACTION READ ONLY``;
  3. every statement is passed through a SELECT-only allowlist before execution
     (``_assert_statement_allowed``), which rejects multi-statement strings and any
     non-SELECT leading keyword.
There is no ``ALTER``/``CREATE``/``DROP``/``INSERT``/``UPDATE``/``DELETE`` anywhere
in this file; the negative-control DDL lives only in the test harness.

Usage:
    python projection_gate.py --dsn postgresql://... --zid 123
    python projection_gate.py --dsn "$READ_ONLY_DATABASE_URL" --zid 123   # replica run
"""

from __future__ import annotations

import argparse
import contextlib
import re
import sys
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Iterator, Optional, Sequence

import psycopg2
import psycopg2.extensions


# ---------------------------------------------------------------------------
# Frozen contract
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ProjectionSite:
    """A served wildcard projection whose column list is being frozen.

    ``frozen_columns`` is the ordered list the site is allowed to serve today
    (ordinal order, which is what ``SELECT *`` returns). ``filter_columns`` are
    the columns the real handler allows in its WHERE clause. ``order_columns`` is
    the deterministic sort applied to BOTH projections so rows line up for
    positional cell comparison (the real handler has no ORDER BY; ordering changes
    no cell, only row sequence).
    """

    name: str
    table: str
    frozen_columns: tuple[str, ...]
    filter_columns: tuple[str, ...]
    order_columns: tuple[str, ...]
    served_shape: str  # human description of the real wildcard site


SITES: dict[str, ProjectionSite] = {
    "votesGet": ProjectionSite(
        name="votesGet",
        table="votes_latest_unique",
        frozen_columns=("zid", "pid", "tid", "vote", "weight_x_32767", "modified"),
        filter_columns=("zid", "pid", "tid"),
        order_columns=("zid", "pid", "tid"),
        served_shape='sql_votes_latest_unique.select(star()) -> SELECT "votes_latest_unique".*',
    ),
    "handle_GET_votes_me": ProjectionSite(
        name="handle_GET_votes_me",
        table="votes",
        frozen_columns=(
            "zid",
            "pid",
            "tid",
            "vote",
            "weight_x_32767",
            "created",
            "high_priority",
        ),
        filter_columns=("zid", "pid"),
        order_columns=("zid", "pid", "tid", "created"),
        served_shape="SELECT * FROM votes WHERE zid = ($1) AND pid = ($2)",
    ),
}


# ---------------------------------------------------------------------------
# Classification
# ---------------------------------------------------------------------------


class CellClass(str, Enum):
    IDENTICAL = "IDENTICAL"
    ORDER_ONLY = "ORDER_ONLY"
    MISSING_FIELD = "MISSING_FIELD"
    EXTRA_FIELD = "EXTRA_FIELD"
    VALUE_DIFF = "VALUE_DIFF"


@dataclass(frozen=True)
class Finding:
    """One classified difference. ``row_index`` is None for column-set findings."""

    cls: CellClass
    column: str
    row_index: Optional[int] = None
    expected: Optional[str] = None
    served: Optional[str] = None


@dataclass
class SiteReport:
    site: ProjectionSite
    filters: dict[str, Any]
    expected_columns: tuple[str, ...]
    served_columns: tuple[str, ...]
    row_count_expected: int
    row_count_served: int
    identical_cells: int = 0
    findings: list[Finding] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        """Pass iff every cell is IDENTICAL: no findings, matching row counts."""
        return not self.findings and self.row_count_expected == self.row_count_served

    def counts(self) -> dict[str, int]:
        out = {c.value: 0 for c in CellClass}
        out[CellClass.IDENTICAL.value] = self.identical_cells
        for f in self.findings:
            out[f.cls.value] += 1
        return out

    def summary_line(self) -> str:
        c = self.counts()
        verdict = "PASS" if self.ok else "FAIL"
        return (
            f"[{verdict}] {self.site.name} ({self.site.table}) "
            f"rows(expected={self.row_count_expected},served={self.row_count_served}) "
            f"IDENTICAL={c['IDENTICAL']} ORDER_ONLY={c['ORDER_ONLY']} "
            f"MISSING_FIELD={c['MISSING_FIELD']} EXTRA_FIELD={c['EXTRA_FIELD']} "
            f"VALUE_DIFF={c['VALUE_DIFF']}"
        )


# ---------------------------------------------------------------------------
# Read-only enforcement
# ---------------------------------------------------------------------------


class GateReadOnlyViolation(RuntimeError):
    """Raised when the gate is asked to run a statement that is not a bare SELECT."""


_SELECT_RE = re.compile(r"^\s*SELECT\b", re.IGNORECASE)
_ALLOWED_CONTROL = frozenset({"SET TRANSACTION READ ONLY"})
_LINE_COMMENT_RE = re.compile(r"--[^\n]*")
_BLOCK_COMMENT_RE = re.compile(r"/\*.*?\*/", re.DOTALL)


def _strip_comments(sql: str) -> str:
    return _BLOCK_COMMENT_RE.sub("", _LINE_COMMENT_RE.sub("", sql)).strip()


def _assert_statement_allowed(sql: str) -> None:
    """SELECT-only allowlist. Rejects multi-statement strings and non-SELECT DML/DDL.

    The read-only transaction is the real server-side guarantee; this is defense in
    depth so a bug in this tool cannot even attempt a write.
    """
    stripped = _strip_comments(sql)
    if stripped.upper() in _ALLOWED_CONTROL:
        return
    # No embedded statement separators (a single trailing ';' is fine).
    body = stripped[:-1] if stripped.endswith(";") else stripped
    if ";" in body:
        raise GateReadOnlyViolation(f"multiple statements are not allowed: {sql!r}")
    if not _SELECT_RE.match(stripped):
        raise GateReadOnlyViolation(f"only SELECT is allowed, got: {sql!r}")


def _execute(cur: "psycopg2.extensions.cursor", sql: str, params: Sequence[Any] = ()) -> None:
    _assert_statement_allowed(sql)
    cur.execute(sql, params)


@contextlib.contextmanager
def read_only_connection(dsn: str) -> Iterator["psycopg2.extensions.connection"]:
    """Yield a connection on which every transaction is read-only."""
    conn = psycopg2.connect(dsn)
    try:
        # Session-level: every future transaction is read only at the server.
        conn.set_session(readonly=True, autocommit=False)
        yield conn
    finally:
        conn.rollback()
        conn.close()


@contextlib.contextmanager
def _read_only_cursor(conn: "psycopg2.extensions.connection") -> Iterator["psycopg2.extensions.cursor"]:
    conn.rollback()  # start from a clean transaction boundary
    cur = conn.cursor()
    try:
        _execute(cur, "SET TRANSACTION READ ONLY")  # first stmt in the txn
        yield cur
    finally:
        cur.close()
        conn.rollback()  # SELECTs take no locks worth holding; release promptly


# ---------------------------------------------------------------------------
# Projections
# ---------------------------------------------------------------------------


def _ident(name: str) -> str:
    """Quote an SQL identifier. Identifiers here come only from the frozen contract."""
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name):
        raise ValueError(f"refusing to quote suspicious identifier: {name!r}")
    return '"' + name + '"'


def _where(site: ProjectionSite, filters: dict[str, Any]) -> tuple[str, list[Any]]:
    clauses: list[str] = []
    params: list[Any] = []
    for col in site.filter_columns:
        if col in filters and filters[col] is not None:
            clauses.append(f"{_ident(col)} = %s")
            params.append(filters[col])
    where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
    return where, params


def _order_by(site: ProjectionSite, available: Sequence[str]) -> str:
    cols = [c for c in site.order_columns if c in available]
    if not cols:
        return ""
    return " ORDER BY " + ", ".join(_ident(c) for c in cols)


def _fetch(
    cur: "psycopg2.extensions.cursor",
    select_list: str,
    site: ProjectionSite,
    filters: dict[str, Any],
    order_available: Sequence[str],
) -> tuple[tuple[str, ...], list[tuple[Any, ...]]]:
    where, params = _where(site, filters)
    sql = f"SELECT {select_list} FROM {_ident(site.table)}{where}{_order_by(site, order_available)}"
    _execute(cur, sql, params)
    columns = tuple(d.name for d in cur.description)
    rows = [tuple(r) for r in cur.fetchall()]
    return columns, rows


def served_projection(
    cur: "psycopg2.extensions.cursor", site: ProjectionSite, filters: dict[str, Any]
) -> tuple[tuple[str, ...], list[tuple[Any, ...]]]:
    """Reproduce the actual served wildcard (``SELECT *``)."""
    # Order by the frozen order columns that still exist on the table.
    available = _table_columns(cur, site.table)
    return _fetch(cur, "*", site, filters, available)


def expected_projection(
    cur: "psycopg2.extensions.cursor", site: ProjectionSite, filters: dict[str, Any]
) -> tuple[tuple[str, ...], list[tuple[Any, ...]]]:
    """The frozen explicit column list — what the site is allowed to serve today."""
    select_list = ", ".join(_ident(c) for c in site.frozen_columns)
    return _fetch(cur, select_list, site, filters, site.frozen_columns)


def _table_columns(cur: "psycopg2.extensions.cursor", table: str) -> tuple[str, ...]:
    _execute(
        cur,
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_schema = 'public' AND table_name = %s ORDER BY ordinal_position",
        (table,),
    )
    return tuple(r[0] for r in cur.fetchall())


# ---------------------------------------------------------------------------
# The gate
# ---------------------------------------------------------------------------


def _cell_bytes(value: Any) -> str:
    """Canonical rendering of a cell for byte-equality comparison.

    Both projections read the identical underlying rows through the same driver,
    so a shared cell renders identically here; a genuine value divergence would
    render differently and surface as VALUE_DIFF.
    """
    if value is None:
        return "␀NULL"  # a token that cannot collide with a real text value
    if isinstance(value, bool):
        return "t" if value else "f"
    return repr(value)


def classify(
    site: ProjectionSite,
    filters: dict[str, Any],
    expected_columns: tuple[str, ...],
    expected_rows: list[tuple[Any, ...]],
    served_columns: tuple[str, ...],
    served_rows: list[tuple[Any, ...]],
) -> SiteReport:
    report = SiteReport(
        site=site,
        filters=dict(filters),
        expected_columns=expected_columns,
        served_columns=served_columns,
        row_count_expected=len(expected_rows),
        row_count_served=len(served_rows),
    )

    exp_idx = {c: i for i, c in enumerate(expected_columns)}
    srv_idx = {c: i for i, c in enumerate(served_columns)}

    # Column-set classification.
    for c in served_columns:
        if c not in exp_idx:
            report.findings.append(Finding(CellClass.EXTRA_FIELD, c))
    for c in expected_columns:
        if c not in srv_idx:
            report.findings.append(Finding(CellClass.MISSING_FIELD, c))

    # Shared columns, in frozen order. ORDER_ONLY: shared columns present in a
    # different relative order in the served object than in the frozen contract.
    shared = [c for c in expected_columns if c in srv_idx]
    served_shared_order = [c for c in served_columns if c in exp_idx]
    if shared != served_shared_order:
        for c in shared:
            report.findings.append(Finding(CellClass.ORDER_ONLY, c))

    # Per-cell value classification over shared columns, positional row match
    # (both projections used the same WHERE + ORDER BY).
    n = min(len(expected_rows), len(served_rows))
    for i in range(n):
        erow = expected_rows[i]
        srow = served_rows[i]
        for c in shared:
            ev = _cell_bytes(erow[exp_idx[c]])
            sv = _cell_bytes(srow[srv_idx[c]])
            if ev == sv:
                report.identical_cells += 1
            else:
                report.findings.append(
                    Finding(CellClass.VALUE_DIFF, c, row_index=i, expected=ev, served=sv)
                )
    return report


def gate_site(
    conn: "psycopg2.extensions.connection", site: ProjectionSite, filters: dict[str, Any]
) -> SiteReport:
    with _read_only_cursor(conn) as cur:
        exp_cols, exp_rows = expected_projection(cur, site, filters)
        srv_cols, srv_rows = served_projection(cur, site, filters)
    return classify(site, filters, exp_cols, exp_rows, srv_cols, srv_rows)


def gate_all(
    dsn: str, filters: dict[str, Any], sites: Optional[Sequence[str]] = None
) -> list[SiteReport]:
    names = list(sites) if sites else list(SITES)
    reports: list[SiteReport] = []
    with read_only_connection(dsn) as conn:
        for name in names:
            reports.append(gate_site(conn, SITES[name], filters))
    return reports


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _parse_args(argv: Optional[Sequence[str]] = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--dsn", required=True, help="Postgres connection string (a replica DSN is supported and safe)")
    p.add_argument("--zid", type=int, required=True, help="conversation id to project (synthetic in tests)")
    p.add_argument("--pid", type=int, default=None)
    p.add_argument("--tid", type=int, default=None)
    p.add_argument("--site", choices=list(SITES) + ["all"], default="all")
    return p.parse_args(argv)


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = _parse_args(argv)
    filters = {"zid": args.zid, "pid": args.pid, "tid": args.tid}
    sites = None if args.site == "all" else [args.site]
    reports = gate_all(args.dsn, filters, sites)
    all_ok = True
    for r in reports:
        print(r.summary_line())
        for f in r.findings:
            loc = f"row {f.row_index} " if f.row_index is not None else ""
            detail = ""
            if f.cls is CellClass.VALUE_DIFF:
                detail = f" expected={f.expected!r} served={f.served!r}"
            print(f"    {f.cls.value}: {loc}column={f.column}{detail}")
        all_ok = all_ok and r.ok
    print(f"GATE {'PASS' if all_ok else 'FAIL'}: {len(reports)} site(s) checked")
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())
