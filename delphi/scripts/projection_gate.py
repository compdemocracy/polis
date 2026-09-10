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

SAFETY (read-only, zero DDL, zero writes, no schema change)
-----------------------------------------------------------
This module issues nothing but ``SELECT`` (plus a read-only/isolation control
statement). It does NOT take "zero locks" — a SELECT takes an ordinary
``AccessShareLock`` on each relation it reads; what it takes is nothing beyond
that, holds it only for the short read-only transaction, and rolls back promptly.
Enforcement is layered (P2):
  1. the connection is opened with ``default_transaction_read_only=on`` and
     ``set_session(readonly=True, isolation_level=REPEATABLE READ)``;
  2. each transaction additionally begins with
     ``SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`` (one snapshot
     shared by both projections, P3);
  3. every statement passes through a conservative structural guard
     (``_assert_statement_allowed``) that rejects any comment token, any statement
     separator, and anything but a single leading SELECT (or the closed set of
     read-only control statements) — with no comment stripping, which is what the
     round-1 guard was defeated by.
There is no ``ALTER``/``CREATE``/``DROP``/``INSERT``/``UPDATE``/``DELETE`` anywhere
in this file; the negative-control DDL lives only in the test harness.

Usage:
    python projection_gate.py --dsn postgresql://... --zid 123
    python projection_gate.py --dsn "$READ_ONLY_DATABASE_URL" --zid 123   # replica run
"""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import re
import shutil
import subprocess
import sys
from collections import Counter
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
    # Set when the run carries no evidence for this site (zero rows) and empty was
    # not explicitly declared acceptable (P4). An INCONCLUSIVE report is not a PASS.
    inconclusive_reason: Optional[str] = None
    channel: str = "preflight"  # "preflight" (DB) or "wire" (Node serializer)

    @property
    def status(self) -> str:
        if self.inconclusive_reason:
            return "INCONCLUSIVE"
        if self.findings or self.row_count_expected != self.row_count_served:
            return "FAIL"
        return "PASS"

    @property
    def ok(self) -> bool:
        """Pass iff every cell is IDENTICAL AND the run carried evidence."""
        return self.status == "PASS"

    def counts(self) -> dict[str, int]:
        out = {c.value: 0 for c in CellClass}
        out[CellClass.IDENTICAL.value] = self.identical_cells
        for f in self.findings:
            out[f.cls.value] += 1
        return out

    def summary_line(self) -> str:
        c = self.counts()
        verdict = self.status
        if self.inconclusive_reason:
            verdict = f"INCONCLUSIVE({self.inconclusive_reason})"
        return (
            f"[{verdict}] {self.channel}:{self.site.name} ({self.site.table}) "
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
# Exact, closed set of non-SELECT control statements the gate is allowed to issue.
# Nothing outside this set and a single leading SELECT is ever executed.
_ALLOWED_CONTROL = frozenset({
    "SET TRANSACTION READ ONLY",
    "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    "SHOW transaction_isolation",
})


def _assert_statement_allowed(sql: str) -> None:
    """Conservative structural read-only guard (P2).

    The round-1 guard stripped ``--`` comments before inspecting the string, so a
    ``--`` inside a *string literal* hid a trailing multi-statement write
    (the second reviewer reproduced a committed INSERT through this). No comment stripping now:
    a comment token, a statement separator, or anything but a single leading
    SELECT is rejected outright. There is no ``pglast``/``sqlparse`` in the venv,
    so this is the sanctioned conservative rejection rather than a full parse; it
    is intentionally stricter than SQL (it rejects legitimate-but-unused forms
    such as a literal containing ``--``), because the gate only ever issues its
    own closed set of comment-free, single-statement queries.

    This is defense in depth. The real guarantee is the database session: the
    connection is opened read-only with ``default_transaction_read_only=on`` and
    a REPEATABLE READ READ ONLY isolation level, and every statement here is a
    single SELECT, so no write is expressible even if this check were bypassed.
    """
    if not isinstance(sql, str):
        raise GateReadOnlyViolation(f"statement must be a string, got {type(sql)!r}")
    normalized = sql.strip()
    if normalized in _ALLOWED_CONTROL:
        return
    if "--" in sql or "/*" in sql or "*/" in sql:
        raise GateReadOnlyViolation(f"comments are not allowed: {sql!r}")
    if ";" in sql:
        raise GateReadOnlyViolation(f"statement separators are not allowed: {sql!r}")
    if not _SELECT_RE.match(normalized):
        raise GateReadOnlyViolation(f"only a single leading SELECT is allowed: {sql!r}")


def _execute(cur: "psycopg2.extensions.cursor", sql: str, params: Sequence[Any] = ()) -> None:
    _assert_statement_allowed(sql)
    cur.execute(sql, params)


@contextlib.contextmanager
def read_only_connection(dsn: str) -> Iterator["psycopg2.extensions.connection"]:
    """Yield a connection on which every transaction is read-only.

    Read-only is enforced at the database level three ways: ``options`` sets
    ``default_transaction_read_only=on`` for the whole session, ``set_session``
    marks the session read-only and REPEATABLE READ (one snapshot per
    transaction, P3), and each transaction additionally issues an explicit
    ``SET TRANSACTION ... READ ONLY`` (see ``_read_only_cursor``).
    """
    conn = psycopg2.connect(dsn, options="-c default_transaction_read_only=on")
    try:
        conn.set_session(
            isolation_level=psycopg2.extensions.ISOLATION_LEVEL_REPEATABLE_READ,
            readonly=True,
            autocommit=False,
        )
        yield conn
    finally:
        conn.rollback()
        conn.close()


@contextlib.contextmanager
def _read_only_cursor(conn: "psycopg2.extensions.connection") -> Iterator["psycopg2.extensions.cursor"]:
    conn.rollback()  # start from a clean transaction boundary
    cur = conn.cursor()
    try:
        # First statement of the transaction: fix isolation + read-only mode. The
        # REPEATABLE READ snapshot itself is taken at the first query below.
        _execute(cur, "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        yield cur
    finally:
        cur.close()
        conn.rollback()  # a SELECT holds only an AccessShareLock; release promptly


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
    """DB-preflight classification (P3): shared-column comparison as a MULTISET.

    The raw ``votes`` order has same-cell/same-time ties (the accepted P-047
    census) and edge ``votes`` has no per-row unique key, so positional row
    matching is not well defined. Instead compare WHOLE ROWS over the shared
    columns as a multiset (``Counter`` of full row tuples) — order-independent and
    multiplicity-preserving, so exact-duplicate votes and genuine permutations
    match, while a change that swaps values BETWEEN rows (e.g. two comments'
    votes) breaks the row tuple and is caught (review round-2 defect: independent
    per-column bags missed this). Column-set deviations (extra/missing/reordered)
    are read from the column lists directly.
    """
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

    # ORDER_ONLY: shared columns in a different relative order than the contract.
    shared = [c for c in expected_columns if c in srv_idx]
    served_shared_order = [c for c in served_columns if c in exp_idx]
    if shared != served_shared_order:
        for c in shared:
            report.findings.append(Finding(CellClass.ORDER_ONLY, c))

    # Whole-row multiset over shared columns (associations survive).
    def rowkey(row: tuple[Any, ...], idx: dict[str, int]) -> tuple[str, ...]:
        return tuple(_cell_bytes(row[idx[c]]) for c in shared)

    exp_ms = Counter(rowkey(r, exp_idx) for r in expected_rows)
    srv_ms = Counter(rowkey(r, srv_idx) for r in served_rows)
    report.identical_cells += sum((exp_ms & srv_ms).values()) * len(shared)
    if exp_ms != srv_ms:
        only_exp = list((exp_ms - srv_ms).elements())
        only_srv = list((srv_ms - exp_ms).elements())
        # Report the columns that differ, pairing leftover rows for a hint.
        reported: set[str] = set()
        for i, ek in enumerate(only_exp):
            sk = only_srv[i] if i < len(only_srv) else None
            for j, c in enumerate(shared):
                if sk is None or ek[j] != sk[j]:
                    if c not in reported:
                        report.findings.append(
                            Finding(
                                CellClass.VALUE_DIFF,
                                c,
                                expected=ek[j],
                                served=(sk[j] if sk is not None else None),
                            )
                        )
                        reported.add(c)
        # Extra served rows with no expected counterpart still count as a diff.
        for i in range(len(only_exp), len(only_srv)):
            sk = only_srv[i]
            for j, c in enumerate(shared):
                if c not in reported:
                    report.findings.append(
                        Finding(CellClass.VALUE_DIFF, c, expected=None, served=sk[j])
                    )
                    reported.add(c)
    return report


def gate_site(
    conn: "psycopg2.extensions.connection", site: ProjectionSite, filters: dict[str, Any]
) -> SiteReport:
    with _read_only_cursor(conn) as cur:
        exp_cols, exp_rows = expected_projection(cur, site, filters)
        srv_cols, srv_rows = served_projection(cur, site, filters)
    return classify(site, filters, exp_cols, exp_rows, srv_cols, srv_rows)


def _apply_coverage(
    report: SiteReport, require_populated: bool, allow_empty: Sequence[str]
) -> SiteReport:
    """A run with zero rows carries no evidence for the contract (P4). Mark it
    INCONCLUSIVE unless the caller declared this site's empty case acceptable."""
    if (
        require_populated
        and report.row_count_served == 0
        and report.row_count_expected == 0
        and report.site.name not in allow_empty
    ):
        report.inconclusive_reason = "no rows: zero evidence"
    return report


def gate_all(
    dsn: str,
    filters: dict[str, Any],
    sites: Optional[Sequence[str]] = None,
    require_populated: bool = True,
    allow_empty: Sequence[str] = (),
) -> list[SiteReport]:
    names = list(sites) if sites else list(SITES)
    reports: list[SiteReport] = []
    with read_only_connection(dsn) as conn:
        for name in names:
            report = gate_site(conn, SITES[name], filters)
            reports.append(_apply_coverage(report, require_populated, allow_empty))
    return reports


# ---------------------------------------------------------------------------
# Served-wire gate (P1) — bind to the real handler/query/serializer via a Node
# witness (server/scripts/projection-gate-witness.mjs). The DB gate above is
# retained as the named "preflight"; this is the acceptance channel.
# ---------------------------------------------------------------------------


class WireWitnessUnavailable(RuntimeError):
    """Raised when the Node wire witness cannot be run (no node / no server deps)."""


def _resolve_server_dir() -> Optional[str]:
    here = os.path.dirname(os.path.abspath(__file__))  # delphi/scripts
    repo = os.path.abspath(os.path.join(here, "..", ".."))
    cand = os.path.join(repo, "server")
    return cand if os.path.isdir(cand) else None


def _has_node_deps(node_modules: str) -> bool:
    return os.path.isdir(os.path.join(node_modules, "sql")) and os.path.isdir(
        os.path.join(node_modules, "pg")
    )


def _resolve_node_modules(server_dir: str) -> Optional[str]:
    env = os.environ.get("PROJGATE_SERVER_NODE_MODULES")
    if env and _has_node_deps(env):
        return env
    local = os.path.join(server_dir, "node_modules")
    if _has_node_deps(local):
        return local
    # Fall back to the primary worktree's install (worktrees have no node_modules).
    try:
        common = subprocess.check_output(
            ["git", "-C", server_dir, "rev-parse", "--git-common-dir"], text=True
        ).strip()
        common_abs = common if os.path.isabs(common) else os.path.join(server_dir, common)
        primary = os.path.dirname(os.path.abspath(common_abs))
        pnm = os.path.join(primary, "server", "node_modules")
        if _has_node_deps(pnm):
            return pnm
    except Exception:
        pass
    return None


def run_wire_witness(
    dsn: str,
    filters: dict[str, Any],
    sites: Optional[Sequence[str]] = None,
    server_dir: Optional[str] = None,
    node_modules: Optional[str] = None,
    src_root: Optional[str] = None,
) -> dict[str, Any]:
    node = shutil.which("node")
    if not node:
        raise WireWitnessUnavailable("node not found on PATH")
    server_dir = server_dir or _resolve_server_dir()
    if not server_dir:
        raise WireWitnessUnavailable("server/ directory not found")
    witness = os.path.join(server_dir, "scripts", "projection-gate-witness.mjs")
    if not os.path.exists(witness):
        raise WireWitnessUnavailable(f"witness missing: {witness}")
    node_modules = node_modules or _resolve_node_modules(server_dir)
    if not node_modules:
        raise WireWitnessUnavailable("server node_modules (sql, pg, typescript) not resolvable")
    names = list(sites) if sites else list(SITES)
    args = [node, witness, "--dsn", dsn, "--zid", str(filters["zid"]), "--sites", ",".join(names)]
    if filters.get("pid") is not None:
        args += ["--pid", str(filters["pid"])]
    if filters.get("tid") is not None:
        args += ["--tid", str(filters["tid"])]
    if src_root:
        args += ["--src-root", src_root]
    env = dict(os.environ, NODE_PATH=node_modules)
    proc = subprocess.run(args, capture_output=True, text=True, env=env)
    if proc.returncode != 0:
        raise WireWitnessUnavailable(f"witness failed: {proc.stderr.strip()[-500:]}")
    return json.loads(proc.stdout)


def _wire_token(value: Any) -> str:
    """Type-tagged rendering of a JSON cell so int8-as-string ("1000") and
    int4-as-number (1000) — IDENTICAL to the psycopg2 preflight — are DISTINCT."""
    return f"{type(value).__name__}:{json.dumps(value, sort_keys=True)}"


def classify_wire(
    site: ProjectionSite,
    expected_rows: list[dict[str, Any]],
    served_rows: list[dict[str, Any]],
    filters: Optional[dict[str, Any]] = None,
    served_json: Optional[str] = None,
    expected_json: Optional[str] = None,
    served_status: Optional[int] = None,
) -> SiteReport:
    """Classify SERVED wire objects: positional (array order is contract), keys in
    object order (ORDER_ONLY), type-sensitive values (VALUE_DIFF). If the exact
    served/expected JSON strings are supplied, a byte mismatch is caught too; if the
    served HTTP status is supplied, a non-200 response is a finding."""
    report = SiteReport(
        site=site,
        filters=dict(filters or {}),
        expected_columns=tuple(expected_rows[0].keys()) if expected_rows else (),
        served_columns=tuple(served_rows[0].keys()) if served_rows else (),
        row_count_expected=len(expected_rows),
        row_count_served=len(served_rows),
        channel="wire",
    )
    extra: set[str] = set()
    missing: set[str] = set()
    order_cols: set[str] = set()
    n = min(len(expected_rows), len(served_rows))
    for i in range(n):
        e = expected_rows[i]
        s = served_rows[i]
        ekeys = list(e.keys())
        skeys = list(s.keys())
        extra.update(k for k in skeys if k not in e)
        missing.update(k for k in ekeys if k not in s)
        shared = [k for k in ekeys if k in s]
        shared_srv_order = [k for k in skeys if k in e]
        if shared != shared_srv_order:
            order_cols.update(shared)
        for k in shared:
            et, st = _wire_token(e[k]), _wire_token(s[k])
            if et == st:
                report.identical_cells += 1
            else:
                report.findings.append(
                    Finding(CellClass.VALUE_DIFF, k, row_index=i, expected=et, served=st)
                )
    for k in sorted(extra):
        report.findings.append(Finding(CellClass.EXTRA_FIELD, k))
    for k in sorted(missing):
        report.findings.append(Finding(CellClass.MISSING_FIELD, k))
    for k in sorted(order_cols):
        report.findings.append(Finding(CellClass.ORDER_ONLY, k))
    # Exact wire bytes: if the raw JSON strings differ but per-cell classification
    # found nothing (e.g. numeric spelling / escaping), record it as a VALUE_DIFF.
    if (
        served_json is not None
        and expected_json is not None
        and served_json != expected_json
        and not report.findings
    ):
        report.findings.append(
            Finding(CellClass.VALUE_DIFF, "<raw-json-bytes>", expected=expected_json[:120], served=served_json[:120])
        )
    # The served response status is part of the wire contract (frozen: 200).
    if served_status is not None and served_status != 200:
        report.findings.append(
            Finding(CellClass.VALUE_DIFF, "<http-status>", expected="200", served=str(served_status))
        )
    return report


def gate_wire(
    dsn: str,
    filters: dict[str, Any],
    sites: Optional[Sequence[str]] = None,
    require_populated: bool = True,
    allow_empty: Sequence[str] = (),
    server_dir: Optional[str] = None,
    node_modules: Optional[str] = None,
    src_root: Optional[str] = None,
) -> list[SiteReport]:
    data = run_wire_witness(dsn, filters, sites, server_dir, node_modules, src_root)
    names = list(sites) if sites else list(SITES)
    reports: list[SiteReport] = []
    for name in names:
        blob = data[name]
        report = classify_wire(
            SITES[name], blob["expected"], blob["served"], filters,
            served_json=blob.get("servedJson"), expected_json=blob.get("expectedJson"),
            served_status=blob.get("servedStatus"),
        )
        reports.append(_apply_coverage(report, require_populated, allow_empty))
    return reports


@dataclass
class ChannelRun:
    """One (dsn-label, channel) run over the requested sites."""

    dsn_label: str
    channel: str
    reports: list[SiteReport]
    note: Optional[str] = None  # e.g. why a wire run could not be produced

    @property
    def ok(self) -> bool:
        return bool(self.reports) and self.note is None and all(r.ok for r in self.reports)


@dataclass(frozen=True)
class ServerIdentity:
    """A database cluster's identity + read role, used to bind a physical standby
    to its primary (a streaming standby shares the primary's system identifier and
    reports ``pg_is_in_recovery()`` true)."""

    system_identifier: str
    in_recovery: bool
    server_addr: Optional[str]
    upstream_host: Optional[str]  # pg_stat_wal_receiver.sender_host, if any


def _server_identity(dsn: str) -> ServerIdentity:
    with read_only_connection(dsn) as conn:
        with _read_only_cursor(conn) as cur:
            _execute(
                cur,
                "SELECT (SELECT system_identifier::text FROM pg_control_system()), "
                "pg_is_in_recovery(), inet_server_addr()::text, "
                "(SELECT sender_host FROM pg_stat_wal_receiver LIMIT 1)",
            )
            sysid, in_recovery, addr, upstream = cur.fetchone()
    return ServerIdentity(str(sysid), bool(in_recovery), addr, upstream)


@dataclass
class Manifest:
    """A coverage manifest binding required runs and their results (P4/R3/R4).

    Acceptance binds BOTH endpoint roles and identities:
      * the PRIMARY must be a write endpoint (``pg_is_in_recovery()`` false);
      * the REPLICA must be a bound physical standby (``pg_is_in_recovery()`` true
        AND the primary's ``pg_control_system()`` identifier, which a streaming
        standby shares) — an UNRELATED primary is never a replica;
      * ``approve_same_identity`` is the same-cluster read-pool profile and STILL
        requires an equal system identifier — an override can never accept two
        different identifiers;
      * ``expected_system_identifier``, if supplied, is a bound profile both
        endpoints must match;
    and requires non-empty POPULATED WIRE coverage per read target (declaring
    cases empty, or a preflight-only run, is not acceptance).
    """

    runs: list[ChannelRun]
    require_replica: bool
    replica_seen: bool
    requested_sites: tuple[str, ...]
    primary_identity: Optional[ServerIdentity] = None
    replica_identity: Optional[ServerIdentity] = None
    approve_same_identity: bool = False
    expected_system_identifier: Optional[str] = None

    @property
    def primary_valid(self) -> bool:
        """The primary endpoint must be a write endpoint (not in recovery), and
        match ``expected_system_identifier`` when one is supplied."""
        if self.primary_identity is None or self.primary_identity.in_recovery:
            return False
        if (
            self.expected_system_identifier is not None
            and self.primary_identity.system_identifier != self.expected_system_identifier
        ):
            return False
        return True

    @property
    def distinct_replica(self) -> bool:
        """A VALID bound replica (name kept for the R3 review script). Never
        accepts two different system identifiers: the same-cluster approval and the
        physical-standby profile both require an equal identifier; the standby
        profile additionally requires the replica to be in recovery."""
        if not self.replica_seen or self.replica_identity is None or self.primary_identity is None:
            return False
        same_id = self.replica_identity.system_identifier == self.primary_identity.system_identifier
        if self.expected_system_identifier is not None and (
            self.replica_identity.system_identifier != self.expected_system_identifier
        ):
            return False
        if self.approve_same_identity:
            return same_id  # same-cluster read pool — still one cluster
        return self.replica_identity.in_recovery and same_id

    def _wire_populated(self, label: str) -> bool:
        """The WIRE channel ran on `label` with every requested site populated."""
        wire_runs = [
            run for run in self.runs
            if run.dsn_label == label and run.channel == "wire" and run.note is None
        ]
        if not wire_runs:
            return False
        for name in self.requested_sites:
            reps = [r for run in wire_runs for r in run.reports if r.site.name == name]
            if not reps or not any(r.row_count_served > 0 for r in reps):
                return False
        return True

    @property
    def populated_ok(self) -> bool:
        """Acceptance requires POPULATED WIRE evidence on the primary and (when a
        replica is present) the replica — per read target and channel. A
        preflight-only run, or empty replica tables, does not certify."""
        if not self._wire_populated("primary"):
            return False
        if self.replica_seen and not self._wire_populated("replica"):
            return False
        return True

    @property
    def diagnostic_ok(self) -> bool:
        """Every run passed, ignoring the wire-evidence requirement (informational
        only — never a substitute for acceptance)."""
        return bool(self.runs) and all(run.ok for run in self.runs)

    @property
    def ok(self) -> bool:
        if not self.runs:
            return False
        if not self.primary_valid:  # primary must be a write endpoint, not a standby
            return False
        if self.require_replica and not self.replica_seen:
            return False
        if self.require_replica and not self.distinct_replica:
            return False
        if not self.populated_ok:
            return False
        return all(run.ok for run in self.runs)

    def summary_line(self) -> str:
        verdict = "PASS" if self.ok else "FAIL"
        parts = []
        for r in self.runs:
            v = "PASS" if r.ok else (f"UNAVAILABLE({r.note})" if r.note else "FAIL")
            parts.append(f"{r.dsn_label}/{r.channel}={v}")
        reasons = []
        if not self.primary_valid:
            reasons.append("primary NOT a write endpoint (in recovery or wrong system id)")
        if self.require_replica and not self.replica_seen:
            reasons.append("replica MISSING")
        elif self.require_replica and not self.distinct_replica:
            reasons.append("replica NOT a bound standby (needs in-recovery + shared system id, or approval)")
        if not self.populated_ok:
            reasons.append("no populated WIRE coverage on primary+replica")
        tail = (" [" + "; ".join(reasons) + "]") if reasons else ""
        return f"MANIFEST {verdict}: {', '.join(parts)}{tail}"


def run_manifest(
    primary_dsn: str,
    filters: dict[str, Any],
    sites: Optional[Sequence[str]] = None,
    replica_dsn: Optional[str] = None,
    require_replica: bool = False,
    require_populated: bool = True,
    allow_empty: Sequence[str] = (),
    channels: Sequence[str] = ("preflight",),
    server_dir: Optional[str] = None,
    node_modules: Optional[str] = None,
    approve_same_identity: bool = False,
    src_root: Optional[str] = None,
    expected_system_identifier: Optional[str] = None,
) -> Manifest:
    runs: list[ChannelRun] = []

    def add(label: str, dsn: str) -> None:
        if "preflight" in channels:
            runs.append(
                ChannelRun(
                    label,
                    "preflight",
                    gate_all(dsn, filters, sites, require_populated, allow_empty),
                )
            )
        if "wire" in channels:
            try:
                reports = gate_wire(
                    dsn, filters, sites, require_populated, allow_empty,
                    server_dir, node_modules, src_root,
                )
                runs.append(ChannelRun(label, "wire", reports))
            except WireWitnessUnavailable as exc:
                runs.append(ChannelRun(label, "wire", [], note=str(exc)))

    add("primary", primary_dsn)
    primary_identity = _server_identity(primary_dsn)
    replica_identity: Optional[ServerIdentity] = None
    if replica_dsn:
        add("replica", replica_dsn)
        replica_identity = _server_identity(replica_dsn)
    return Manifest(
        runs=runs,
        require_replica=require_replica,
        replica_seen=bool(replica_dsn),
        requested_sites=tuple(sites) if sites else tuple(SITES),
        primary_identity=primary_identity,
        replica_identity=replica_identity,
        approve_same_identity=approve_same_identity,
        expected_system_identifier=expected_system_identifier,
    )


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _parse_args(argv: Optional[Sequence[str]] = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--dsn", required=True, help="primary Postgres connection string")
    p.add_argument("--replica-dsn", default=None, help="replica connection string (read-only; safe)")
    p.add_argument("--require-replica", action="store_true",
                   help="fail the manifest unless a DISTINCT replica run is provided (acceptance item 3)")
    p.add_argument("--approve-same-identity", action="store_true",
                   help="same-cluster read pool profile (still requires an equal system identifier)")
    p.add_argument("--expected-system-identifier", default=None,
                   help="bound profile: both primary and replica must report this pg_control_system() id")
    p.add_argument("--zid", type=int, required=True, help="conversation id to project (public fixture in tests)")
    p.add_argument("--pid", type=int, default=None)
    p.add_argument("--tid", type=int, default=None)
    p.add_argument("--site", choices=list(SITES) + ["all"], default="all")
    p.add_argument("--channel", choices=["preflight", "wire", "both"], default="both",
                   help="preflight = DB look-alike; wire = real served bytes via Node witness")
    p.add_argument("--allow-empty", action="append", default=[],
                   help="site name whose empty result is acceptable (repeatable)")
    p.add_argument("--server-dir", default=None, help="path to server/ (for the wire witness)")
    p.add_argument("--node-modules", default=None, help="path to server/node_modules (for the wire witness)")
    return p.parse_args(argv)


def _print_run(run: ChannelRun) -> None:
    if run.note:
        print(f"  {run.dsn_label}/{run.channel}: UNAVAILABLE ({run.note})")
        return
    for r in run.reports:
        print(f"  {run.dsn_label}: {r.summary_line()}")
        for f in r.findings:
            detail = ""
            if f.cls is CellClass.VALUE_DIFF:
                detail = f" expected={f.expected!r} served={f.served!r}"
            print(f"      {f.cls.value}: column={f.column}{detail}")


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = _parse_args(argv)
    filters = {"zid": args.zid, "pid": args.pid, "tid": args.tid}
    sites = None if args.site == "all" else [args.site]
    channels = ("preflight", "wire") if args.channel == "both" else (args.channel,)
    manifest = run_manifest(
        args.dsn,
        filters,
        sites,
        replica_dsn=args.replica_dsn,
        require_replica=args.require_replica,
        allow_empty=args.allow_empty,
        channels=channels,
        server_dir=args.server_dir,
        node_modules=args.node_modules,
        approve_same_identity=args.approve_same_identity,
        expected_system_identifier=args.expected_system_identifier,
    )
    for run in manifest.runs:
        _print_run(run)
    print(manifest.summary_line())
    return 0 if manifest.ok else 1


if __name__ == "__main__":
    sys.exit(main())
