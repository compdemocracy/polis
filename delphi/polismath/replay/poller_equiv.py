"""Poller-equivalence harness — schema/seeder (Stage A) + runners (Stage B) +
feeder/comparer (Stage C).

See ``delphi/docs/MATH_POLLER_EQUIV_SPEC.md`` for the full design (goal
condition 2: poller equivalence — identical math_main/bidToPid/ptptstats rows
and tick/watermark semantics between the Clojure math container and the
Python poller replaying the SAME vote stream against one throwaway Postgres).
This module implements spec §3 stages A (schema + seeder), B (runners),
C (feeder + comparer, see the "Stage C" section near the bottom of this file),
and D (self-jitter envelope + full-run orchestration, see the "Stage D"
section at the very bottom): :func:`compute_self_jitter_envelope` measures
clj-vs-clj float jitter across two independent runs of the same stream;
:func:`compare_batch`/:func:`compare_snapshots` accept an optional
``envelope`` parameter that accepts (and separately counts) float mismatches
within the envelope while never excusing structural divergences;
:func:`run_full_equiv_protocol` orchestrates the complete spec protocol
(two clj-only self-jitter runs -> envelope -> one paired clj+py restart-seam
run -> envelope-aware compare -> verdict), with its decision logic split into
the pure, canned-dir-testable :func:`assemble_full_run_verdict`.

Schema derivation (spec item A.1 — "do not guess; quote the clj SQL")
-----------------------------------------------------------------------
The Clojure ``full`` subcommand (``clojure -M:run full``, ``deps.edn:65-66``
``-m polismath.runner``, subcommand table ``runner.clj:71-78`` ``"full"`` ->
``system/full-system``) is defined as ``(merge (poller-system
config-overrides))`` (``system.clj:47-52``), and ``poller-system`` is
``base-system`` (config, logger, core-matrix-boot, postgres,
conversation-manager) plus a votes poller and a moderation poller
(``system.clj:29-33``). Notably this does NOT include ``task-system``
(worker_tasks) or ``export-system``/darwin (``participants`` table reads
live ONLY in ``darwin/export.clj`` — grepped, confirmed absent from
poller.clj/conv_man.clj/postgres.clj) — so those tables are OUT of scope for
the clj side of this harness.

Tables touched, with the exact query/columns (clj file:line, then py
file:line):

* ``votes`` — clj ``postgres/poll`` (postgres.clj:132-145, global watermark
  loop) and ``postgres/conv-poll`` (postgres.clj:197-212, load-or-init full
  history) both ``SELECT * ... ORDER BY zid, tid, pid, created WHERE created >
  ts``; only ``:pid :tid :vote`` are actually destructured downstream
  (conv_man.clj:202-203), ``:zid``/``:created`` drive grouping/watermark
  (poller.clj:18-27). Py: ``PostgresClient.poll_votes_since``
  (postgres.py:534-567) and ``.poll_votes`` (postgres.py:474-532) — both
  ``SELECT zid, tid, pid, vote, created ... ORDER BY zid, tid, pid, created``.
  Columns: ``zid, pid, tid, vote, created`` (+ ``weight_x_32767`` kept for
  shape-fidelity with the real ``SELECT *`` — never read by either poller).
* ``comments`` — clj ``postgres/mod-poll`` (postgres.clj:148-161, global) and
  ``postgres/conv-mod-poll`` (postgres.clj:214-225, load-or-init) both
  ``SELECT * ... ORDER BY zid, tid, modified WHERE modified > ts``; consumed
  by ``conv/mod-update`` (math/conversation.clj:846-884) which destructures
  ``:tid :is_meta :mod :modified``. Py: ``poll_moderation_since``
  (postgres.py:569-604) ``SELECT zid, tid, modified, mod, is_meta`` and
  ``poll_moderation`` (postgres.py:645-723) ``SELECT tid, modified, mod,
  is_meta``. Columns: ``zid, tid, modified, mod, is_meta`` (+ ``pid, uid,
  created, txt`` kept NOT NULL with placeholders — neither poller reads them).
* ``conversations`` — FK target only. Neither poller SELECTs a column off it
  (grepped ``math/src/polismath`` for ``conversations``/``strict_moderation``
  outside ``darwin/export.clj`` — no hits); it exists purely so
  ``math_main``/``math_ticks``/``math_bidtopid``/``math_ptptstats`` FKs
  resolve (``server/postgres/migrations/000000_initial.sql:658-667`` etc, all
  ``zid INTEGER [NOT NULL] REFERENCES conversations(zid)``). Columns: ``zid``.
* ``math_ticks`` — clj ``inc-math-tick`` (postgres.clj:292-295): ``insert into
  math_ticks (zid, math_env) values (?,?) on conflict (zid, math_env) do
  update set modified = now_as_millis(), math_tick = (math_ticks.math_tick +
  1) returning math_tick``. Py: ``increment_math_tick`` (postgres.py:910-939),
  byte-identical SQL text.
* ``math_main`` — clj ``upload-math-main`` (postgres.clj:323-338) and
  ``load-conv`` (postgres.clj:419-434, ``SELECT * FROM math_main WHERE zid=?
  AND math_env=?``). Py: ``write_math_main`` (postgres.py:757-817),
  ``load_math_main`` (postgres.py:725-755). Columns: ``zid, math_env, data,
  last_vote_timestamp, caching_tick, math_tick, modified``.
* ``math_bidtopid`` — clj ``upload-math-bidtopid`` (postgres.clj:369-380). Py:
  ``write_math_bidtopid`` (postgres.py:819-848). Columns: ``zid, math_env,
  math_tick, data, modified``.
* ``math_ptptstats`` — clj ``upload-math-ptptstats`` (postgres.clj:350-361).
  Py: ``write_participant_stats`` (postgres.py:850-879). Columns: ``zid,
  math_env, math_tick, data, modified``.

Two extra tables that are NOT in the spec's headline list, added after
tracing both poller code paths (the "do not guess" instruction cuts both
ways):

* ``participants`` (pid, zid, mod) — a SHIM, needed ONLY by the PYTHON side.
  ``poll_moderation`` (postgres.py:701-713) unconditionally runs ``SELECT pid
  FROM participants WHERE zid=:zid AND (mod=-1 OR mod='-1')`` for
  ``mod_out_ptpts`` (the participant-ban leak fix, 2026-06-10) on EVERY
  load-or-init and every moderation batch — a missing table raises and parks
  the zid (service.py's per-zid exception boundary, ``_handle_zid``). The
  Clojure ``full`` poller never queries ``participants`` at all (only
  ``darwin/export.clj`` does, out of scope). We create the table but never
  seed rows into it: no participant-ban scenario is in scope for this harness.
* ``math_profile`` — clj writes it every vote-batch cycle via
  ``handle-profile-data`` (conv_man.clj:97-113) -> ``upload-math-profile``
  (postgres.clj:340-348), including the actor-startup ``react-to-messages!
  ... :votes []`` call (conv_man.clj:387). A missing table is non-fatal
  (caught + logged, conv_man.clj:104-112) but noisy; included so the clj
  container's stderr stays clean and its write-side footprint is
  production-shaped. Python never touches this table.

Vote sign convention (spec item A.2 — "the DB must hold RAW-DB-convention
signs")
-----------------------------------------------------------------------
``votes.vote`` in production is RAW-DB convention: AGREE=-1, DISAGREE=+1
(``server/postgres/migrations/000000_initial.sql:742-747``). The Clojure
poller consumes this value AS-IS (no flip anywhere in postgres.clj/conv_man.clj
— grepped). The Python poller flips it AT INGRESS
(``polismath.utils.general.postgres_vote_to_delphi``, ``vote * -1``) inside
``poll_votes``/``poll_votes_since`` (postgres.py:474-567) to Delphi convention
(AGREE=+1). Meanwhile ``ReplayDataset.votes[i].sign`` (the seeder's INPUT) is
ALREADY in Delphi convention — ``driver.py``'s module docstring: "export CSVs
are ALREADY in Delphi convention (AGREE=+1)"; ``VOTE_SIGN_CONVENTION =
"delphi"`` (driver.py:56). So the seeder must flip dataset sign -> raw DB sign
via ``polismath.utils.general.delphi_vote_to_postgres`` (the documented
inverse, general.py:43-56) before INSERTing — the opposite direction from the
py poller's ingress flip, landing the DB in the same RAW convention production
holds, which BOTH pollers then read exactly as they read production data.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Optional, Sequence
from urllib.parse import urlsplit, urlunsplit

import sqlalchemy as sa

from polismath.replay import real_data
from polismath.replay import schedule as sched
from polismath.replay.certify import _acceptance_projecting_comparer, normalize_path
from polismath.replay.stepcompare import DEFAULT_TOLERANT_STAT_KEYS, StepComparer
from polismath.replay.store import _safe_path_component
from polismath.replay.types import ModEvent, ReplayDataset
from polismath.utils.engine_mode import ENGINE_MODE_ENV_VAR, ENGINE_MODE_LEGACY
from polismath.utils.general import delphi_vote_to_postgres

# poller_equiv.py -> replay -> polismath -> delphi -> repo root (mirrors
# certify.py / store.py).
_DELPHI_ROOT = Path(__file__).resolve().parents[2]
_REPO_ROOT = _DELPHI_ROOT.parents[0]
_MATH_ROOT = _REPO_ROOT / "math"

DEFAULT_DBNAME = "polis_equiv"
DEFAULT_ZID = 1
# The comment placeholder text is NEVER real content (private-data policy,
# CLAUDE.local.md — never commit vote/comment CONTENT); a bare "comment {tid}"
# also satisfies production's UNIQUE(zid, txt) if that constraint is ever
# reintroduced, though our subset schema does not declare it.
_PLACEHOLDER_TXT_FMT = "comment {tid}"


# ---------------------------------------------------------------------------
# Schema (Stage A.1).
# ---------------------------------------------------------------------------
# Verbatim from server/postgres/migrations/000000_initial.sql:22-30 — every
# BIGINT ``modified``/``created``/tick column in the real schema (and both
# pollers' literal SQL, e.g. postgres.clj:295/328/338/... and
# postgres.py's "now_as_millis()" call-sites) depends on this function
# existing; Postgres has no builtin equivalent.
NOW_AS_MILLIS_FN = """
CREATE OR REPLACE FUNCTION now_as_millis() RETURNS BIGINT AS $$
        DECLARE
            temp TIMESTAMP := now();
        BEGIN
            RETURN 1000*FLOOR(EXTRACT(EPOCH FROM temp)) + FLOOR(EXTRACT(MILLISECONDS FROM temp)) - 1000*FLOOR(EXTRACT(SECOND FROM temp));
        END;
$$ LANGUAGE plpgsql;
"""

# conversations: FK target only (see module docstring) — no other column is
# ever read by either poller's "full"/py-poller code path.
CREATE_CONVERSATIONS = """
CREATE TABLE conversations (
    zid SERIAL PRIMARY KEY
);
"""

# votes: postgres.clj:132-145 (poll) / :197-212 (conv-poll); postgres.py:474-567
# (poll_votes / poll_votes_since). No PK/FK — matches production
# (migrations.sql:737-755): a revote is simply a new row, latest-created wins.
CREATE_VOTES = """
CREATE TABLE votes (
    zid INTEGER NOT NULL,
    pid INTEGER NOT NULL,
    tid INTEGER NOT NULL,
    -- RAW DB convention: -1=agree, +1=disagree, 0=pass/unsure (migrations.sql:742-747).
    vote SMALLINT,
    -- Present because both pollers' SELECT * would include it in production;
    -- never read downstream (nm/update-nmat / poll_votes only touch pid/tid/vote).
    weight_x_32767 SMALLINT DEFAULT 0,
    created BIGINT NOT NULL
);
"""

# comments: postgres.clj:148-161 (mod-poll) / :214-225 (conv-mod-poll);
# math/conversation.clj:846-884 (mod-update, destructures tid/is_meta/mod/modified);
# postgres.py:569-604 (poll_moderation_since) / :645-723 (poll_moderation).
# UNIQUE(zid, tid) backs our seeder's idempotent ON CONFLICT upsert. No FK to
# participants (production has one, migrations.sql:505) — this subset schema
# does not model participants as a real per-comment-author table (see the
# `participants` shim below for why one exists at all).
CREATE_COMMENTS = """
CREATE TABLE comments (
    tid INTEGER NOT NULL,
    zid INTEGER NOT NULL REFERENCES conversations(zid),
    pid INTEGER NOT NULL DEFAULT 0,
    uid INTEGER NOT NULL DEFAULT 0,
    created BIGINT NOT NULL DEFAULT 0,
    modified BIGINT NOT NULL,
    txt VARCHAR(1000) NOT NULL DEFAULT '',
    mod INTEGER NOT NULL DEFAULT 0,
    is_meta BOOLEAN NOT NULL DEFAULT FALSE,
    UNIQUE (zid, tid)
);
"""

# SHIM — needed ONLY by the Python poller (see module docstring): postgres.py
# poll_moderation:701-713 unconditionally selects pid from here. Never seeded
# with rows (no participant-ban scenario is in this harness's scope).
CREATE_PARTICIPANTS = """
CREATE TABLE participants (
    pid INTEGER NOT NULL,
    zid INTEGER NOT NULL REFERENCES conversations(zid),
    mod INTEGER NOT NULL DEFAULT 0,
    UNIQUE (zid, pid)
);
"""

# math_ticks: postgres.clj:292-295 inc-math-tick; postgres.py:910-939
# increment_math_tick. Verbatim column shape from migrations.sql:647-654.
CREATE_MATH_TICKS = """
CREATE TABLE math_ticks (
    zid INTEGER REFERENCES conversations(zid),
    math_tick BIGINT NOT NULL DEFAULT 0,
    caching_tick BIGINT NOT NULL DEFAULT 0,
    math_env VARCHAR(999) NOT NULL,
    modified BIGINT NOT NULL DEFAULT now_as_millis(),
    UNIQUE (zid, math_env)
);
"""

# math_main: postgres.clj:323-338 upload-math-main, :419-434 load-conv;
# postgres.py:757-817 write_math_main, :725-755 load_math_main. Verbatim
# column shape from migrations.sql:658-667.
CREATE_MATH_MAIN = """
CREATE TABLE math_main (
    zid INTEGER NOT NULL REFERENCES conversations(zid),
    math_env VARCHAR(999) NOT NULL,
    data jsonb NOT NULL,
    last_vote_timestamp BIGINT NOT NULL,
    caching_tick BIGINT NOT NULL DEFAULT 0,
    math_tick BIGINT NOT NULL DEFAULT -1,
    modified BIGINT DEFAULT now_as_millis(),
    UNIQUE (zid, math_env)
);
"""

# math_ptptstats: postgres.clj:350-361 upload-math-ptptstats; postgres.py:850-879
# write_participant_stats. Verbatim column shape from migrations.sql:679-687.
CREATE_MATH_PTPTSTATS = """
CREATE TABLE math_ptptstats (
    zid INTEGER NOT NULL REFERENCES conversations(zid),
    math_env VARCHAR(999) NOT NULL,
    math_tick BIGINT NOT NULL DEFAULT -1,
    data jsonb NOT NULL,
    modified BIGINT DEFAULT now_as_millis(),
    UNIQUE (zid, math_env)
);
"""

# math_bidtopid: postgres.clj:369-380 upload-math-bidtopid; postgres.py:819-848
# write_math_bidtopid. Verbatim column shape from migrations.sql:698-706.
CREATE_MATH_BIDTOPID = """
CREATE TABLE math_bidtopid (
    zid INTEGER NOT NULL REFERENCES conversations(zid),
    math_env VARCHAR(999) NOT NULL,
    math_tick BIGINT NOT NULL DEFAULT -1,
    data jsonb NOT NULL,
    modified BIGINT DEFAULT now_as_millis(),
    UNIQUE (zid, math_env)
);
"""

# math_profile: conv_man.clj:97-113 handle-profile-data -> postgres.clj:340-348
# upload-math-profile (see module docstring — clj write-side only, never read
# by the harness comparer). Verbatim column shape from migrations.sql:670-677.
CREATE_MATH_PROFILE = """
CREATE TABLE math_profile (
    zid INTEGER NOT NULL REFERENCES conversations(zid),
    math_env VARCHAR(999) NOT NULL,
    data jsonb NOT NULL,
    modified BIGINT DEFAULT now_as_millis(),
    UNIQUE (zid, math_env)
);
"""

# Order matters: FK targets (conversations) before their referrers.
SCHEMA_STATEMENTS: list[str] = [
    NOW_AS_MILLIS_FN,
    CREATE_CONVERSATIONS,
    CREATE_VOTES,
    CREATE_COMMENTS,
    CREATE_PARTICIPANTS,
    CREATE_MATH_TICKS,
    CREATE_MATH_MAIN,
    CREATE_MATH_PTPTSTATS,
    CREATE_MATH_BIDTOPID,
    CREATE_MATH_PROFILE,
]

# Joined form for introspection/documentation (parse_schema_columns operates
# on this; the function DDL has no "CREATE TABLE" in it so it's harmless here).
SCHEMA_DDL = "\n\n".join(SCHEMA_STATEMENTS)


# ---------------------------------------------------------------------------
# DDL introspection — "parse your own DDL" (Stage A test requirement).
# ---------------------------------------------------------------------------
_CREATE_TABLE_START_RE = re.compile(r"CREATE TABLE (\w+)\s*\(", re.IGNORECASE)
_CONSTRAINT_KEYWORDS = frozenset({"UNIQUE", "PRIMARY", "FOREIGN", "CHECK", "CONSTRAINT"})


def _strip_line_comments(sql: str) -> str:
    return re.sub(r"--[^\n]*", "", sql)


def _split_top_level_commas(body: str) -> list[str]:
    """Split ``body`` on commas that are NOT nested inside parens (e.g. the
    comma-free ``VARCHAR(999)`` argument list must not count as a split)."""
    parts: list[str] = []
    depth = 0
    current: list[str] = []
    for ch in body:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        if ch == "," and depth == 0:
            parts.append("".join(current))
            current = []
        else:
            current.append(ch)
    parts.append("".join(current))
    return parts


def parse_schema_columns(ddl: str = SCHEMA_DDL) -> dict[str, list[str]]:
    """Parse ``CREATE TABLE name (...)`` column names out of ``ddl``.

    NOT a general SQL parser — depth-counts parens to find each table's
    closing ``)`` (robust to ``VARCHAR(999)``-style nested parens) and drops
    bare constraint lines (``UNIQUE (...)`` etc). Good enough for a
    self-consistency check that our own DDL declares the columns each
    poller's SELECT/INSERT statement actually needs (module docstring).
    """
    text = _strip_line_comments(ddl)
    tables: dict[str, list[str]] = {}
    for m in _CREATE_TABLE_START_RE.finditer(text):
        name = m.group(1)
        start = m.end()  # just past the opening '(' consumed by the regex
        depth = 1
        i = start
        while depth > 0 and i < len(text):
            if text[i] == "(":
                depth += 1
            elif text[i] == ")":
                depth -= 1
            i += 1
        body = text[start : i - 1]
        cols = []
        for part in _split_top_level_commas(body):
            stripped = part.strip()
            if not stripped:
                continue
            first_word = stripped.split()[0].upper()
            if first_word in _CONSTRAINT_KEYWORDS:
                continue
            cols.append(stripped.split()[0])
        tables[name] = cols
    return tables


# ---------------------------------------------------------------------------
# Seeder (Stage A.2).
# ---------------------------------------------------------------------------
# Never point create_equiv_db at one of these — belt-and-braces guard for
# MATH_POLLER_EQUIV_SPEC.md hazard 1 ("NEVER touch polis-dev / polis_prodclone").
_PRECIOUS_DBNAMES = frozenset(
    {"postgres", "polis-dev", "polis_dev", "polis_prodclone", "polis-prod", "polis_prod"}
)


def _url_with_dbname(url: str, dbname: str) -> str:
    parts = urlsplit(url)
    return urlunsplit((parts.scheme, parts.netloc, f"/{dbname}", parts.query, parts.fragment))


def _url_with_scheme(url: str, scheme: str) -> str:
    """Swap ``url``'s scheme, preserving user/pass/host/port/path/query.

    Needed because the clj and py runners require OPPOSITE, MUTUALLY
    INCOMPATIBLE schemes for the SAME connection string (root cause #1,
    2026-07-24 live debug — see :func:`build_clj_env`'s docstring):
    Clojure's Hikari datasource regex (``postgres.clj``'s
    ``create-hikari-datasource``) only matches a literal ``postgres://``
    prefix, while SQLAlchemy/psycopg2 (the py side) reject that exact scheme
    (dropped in SQLAlchemy 1.4+) and require ``postgresql://``. Every
    connection URL flowing through this module (``admin_url`` /
    :func:`create_equiv_db`'s return value) is SQLAlchemy-style
    (``postgresql://`` or ``postgresql+driver://``) — this normalizes to
    whichever scheme the CALLING runner actually needs, at the last possible
    moment, so neither runner ever sees the other's required scheme.
    """
    parts = urlsplit(url)
    return urlunsplit((scheme, parts.netloc, parts.path, parts.query, parts.fragment))


def _format_days_ago(value: float) -> str:
    """Format a days-ago value as a BARE INTEGER string (root cause #2,
    2026-07-24 live debug — see :func:`build_clj_env`'s docstring): Clojure's
    ``->long`` config parser is ``Long/parseLong``, which throws (caught +
    logged, returns nil) on ANY non-integer-literal string — including
    ``"10000.0"``, exactly what ``str()`` on a Python float produces. The
    CLI's ``--poll-from-days-ago`` option is ``type=float`` (so fractional
    windows are technically allowed), so this ROUNDS to the nearest whole
    day rather than truncating a caller-supplied fraction into a raw '.0'
    string. Applied on BOTH runners' env assembly for consistency, even
    though only the clj side's parser is fatally strict about it — the py
    side's ``float(...)`` parses either form fine either way.
    """
    return str(int(round(value)))


def create_equiv_db(admin_url: str, dbname: str = DEFAULT_DBNAME) -> str:
    """``CREATE DATABASE dbname`` (DROP first if it exists), then create the
    schema subset inside it. Returns a connection URL for the new database
    (same credentials/host as ``admin_url``, dbname swapped).

    ``admin_url`` must point at an EXISTING database on the target server that
    is NOT ``dbname`` itself — Postgres refuses DROP/CREATE DATABASE on the
    database a connection is currently attached to (point this at the
    server's ``postgres`` maintenance db, or any db other than ``dbname``).
    """
    if dbname in _PRECIOUS_DBNAMES:
        raise ValueError(
            f"refusing to create/drop {dbname!r}: matches a known-precious "
            "database name (MATH_POLLER_EQUIV_SPEC.md hazard 1)"
        )

    admin_engine = sa.create_engine(admin_url, isolation_level="AUTOCOMMIT")
    try:
        with admin_engine.connect() as conn:
            conn.execute(sa.text(f'DROP DATABASE IF EXISTS "{dbname}"'))
            conn.execute(sa.text(f'CREATE DATABASE "{dbname}"'))
    finally:
        admin_engine.dispose()

    target_url = _url_with_dbname(admin_url, dbname)
    schema_engine = sa.create_engine(target_url)
    try:
        with schema_engine.begin() as conn:
            for stmt in SCHEMA_STATEMENTS:
                conn.execute(sa.text(stmt))
    finally:
        schema_engine.dispose()
    return target_url


def seed_conversation(conn: Any, dataset: ReplayDataset, zid: int = DEFAULT_ZID) -> None:
    """Insert the conversation row + comment rows for ``dataset`` under
    ``zid``. Idempotent (ON CONFLICT DO NOTHING on both inserts) — safe to
    call again against an already-seeded conversation.

    Comment text is ALWAYS a placeholder (``"comment {tid}"``) — never real
    content (private-data policy). Comment ``mod``/``modified`` seed at the
    UNMODERATED baseline (``mod=0``, ``modified=created``); applying dataset
    ``mod_events`` over time is the feeder's job (Stage C), not this seeder's.
    Votes are NOT inserted here — see :func:`insert_votes` for the timed
    batches the driver loop issues incrementally.
    """
    conn.execute(
        sa.text("INSERT INTO conversations (zid) VALUES (:zid) ON CONFLICT (zid) DO NOTHING"),
        {"zid": zid},
    )
    for tid in sorted(dataset.comments):
        meta = dataset.comments[tid]
        conn.execute(
            sa.text(
                "INSERT INTO comments (tid, zid, pid, uid, created, modified, txt, mod, is_meta) "
                "VALUES (:tid, :zid, 0, 0, :created, :created, :txt, 0, :is_meta) "
                "ON CONFLICT (zid, tid) DO NOTHING"
            ),
            {
                "tid": tid,
                "zid": zid,
                "created": meta.created_ms,
                "txt": _PLACEHOLDER_TXT_FMT.format(tid=tid),
                "is_meta": meta.is_meta,
            },
        )


def insert_votes(
    conn: Any, dataset: ReplayDataset, from_slot: int, to_slot: int, zid: int = DEFAULT_ZID
) -> int:
    """Insert ``dataset.votes[from_slot:to_slot]`` (plain 0-based Python slice
    — consistent with :func:`polismath.replay.schedule.slice_schedule`'s own
    ``dataset.votes[prev:cut]`` use of 1-based cut slots as slice bounds),
    preserving ``pid``/``tid``/``created`` (``t_ms``) and flipping the vote
    sign from the dataset's Delphi convention to RAW DB convention (module
    docstring) via :func:`polismath.utils.general.delphi_vote_to_postgres`.

    ATOMIC per batch — ONE multi-row ``INSERT ... VALUES (...), (...), ...``
    statement, never a per-row loop (ROOT CAUSE #5, 2026-07-24 live-debug
    task, found AFTER :func:`snap_cuts_past_timestamp_ties` fixed the
    CROSS-batch tie boundary: a genuine INTRA-batch race remained). Both
    pollers run continuously (~1s interval) REGARDLESS of harness batch
    boundaries; under the harness's AUTOCOMMIT isolation level, a per-row
    execute() loop lets a poller's concurrent SELECT observe a PARTIAL
    batch mid-insert. If that partial snapshot's max ``created`` happens to
    tie with a not-yet-committed row's ``created`` (the vw dataset's
    timestamps are 1-second-granular with most seconds shared by several
    votes — see the module docstring), the watermark's STRICT ``created >
    ts`` comparison (both engines, byte-identical SQL) permanently drops
    that row — reproduced live: pid 33's vote at dataset index 2050,
    comfortably INSIDE a batch's slice (nowhere near either cut edge),
    silently vanished from clj-ref's own vote count. A single multi-row
    INSERT is one atomic unit under Postgres MVCC: a concurrent reader sees
    either NONE or ALL of a batch's rows, never a subset — this is NOT the
    same as DBAPI ``executemany`` (psycopg2's default executemany is ITSELF
    a client-side loop of single-row execute calls, no atomicity gained).

    NOT idempotent by design: a repeated call over an overlapping range
    inserts duplicate rows, exactly like production (``votes`` has no
    unique constraint — a revote is simply a new row). Callers (the future
    Stage C feeder) must call this once per NEW batch, not repeatedly for
    the same range.

    Returns the number of rows inserted. Issues NO statement at all for an
    empty slice (``from_slot == to_slot``) — an empty ``VALUES ()`` clause
    is invalid SQL, and there is nothing to insert anyway.
    """
    rows = dataset.votes[from_slot:to_slot]
    if not rows:
        return 0
    value_clauses = []
    params: dict[str, Any] = {"zid": zid}
    for i, v in enumerate(rows):
        value_clauses.append(f"(:zid, :pid{i}, :tid{i}, :vote{i}, :created{i})")
        params[f"pid{i}"] = v.pid
        params[f"tid{i}"] = v.tid
        params[f"vote{i}"] = delphi_vote_to_postgres(v.sign)
        params[f"created{i}"] = v.t_ms
    stmt = (
        "INSERT INTO votes (zid, pid, tid, vote, created) VALUES "
        + ", ".join(value_clauses)
    )
    conn.execute(sa.text(stmt), params)
    return len(rows)


def insert_mod_events(
    conn: Any,
    dataset: ReplayDataset,
    prev_time_ms: int | None,
    cut_time_ms: int,
    zid: int = DEFAULT_ZID,
) -> int:
    """Apply ``dataset.mod_events`` with ``prev_time_ms < t_ms <= cut_time_ms``
    (``prev_time_ms=None`` means no floor — the first batch) as
    ``comments.mod``/``comments.modified`` UPDATEs. The moderation-stream
    analogue of :func:`insert_votes`, added session 2 (2026-07-24) to
    actually exercise pc-meta-02's ``"interleave-by-timestamp"`` moderation
    schedule — the live feeder never had this before (only the CSV-based
    driver, :func:`polismath.replay.schedule.slice_schedule`, applied
    mod_events; ``seed_conversation``'s own docstring flagged this as "the
    feeder's job", but Stage C never built it).

    Time-windowing is IDENTICAL to ``slice_schedule`` (schedule.py:206-225:
    ``m.t_ms <= cut_time_ms and (prev_time is None or m.t_ms > prev_time)``)
    — an event is attached to the FIRST batch whose cut reaches it, so both
    drivers agree on which batch a given mod_event lands in. Events after
    the final cut are silently excluded (same "tail" convention as tail
    votes) — the CALLER controls this simply by never invoking the function
    with a ``cut_time_ms`` past the schedule's last cut.

    ATOMIC — ONE ``UPDATE ... FROM (VALUES ...)`` statement, never a per-row
    loop (same rationale as :func:`insert_votes`'s root cause #5: a
    per-row loop under AUTOCOMMIT would let a concurrent poller observe a
    partial moderation batch mid-update). Multiple events for the SAME tid
    within one window are DE-DUPLICATED to the latest (highest ``t_ms``)
    BEFORE the statement is built — Postgres's ``UPDATE ... FROM`` has
    UNSPECIFIED behavior when the FROM subquery matches a target row more
    than once, so this must never be left to the database.

    Returns the number of RAW events in the window (mirrors
    :func:`insert_votes`'s row-count contract), even though fewer VALUES
    rows may actually be sent due to de-duplication. Issues NO statement for
    an empty window (including the common case of a dataset with zero
    mod_events at all — e.g. vw).
    """
    events = [
        e for e in dataset.mod_events
        if e.t_ms <= cut_time_ms and (prev_time_ms is None or e.t_ms > prev_time_ms)
    ]
    if not events:
        return 0
    latest: dict[int, ModEvent] = {}
    for e in events:  # dataset.mod_events is t_ms-sorted (ReplayDataset.build) -> later wins.
        latest[e.tid] = e
    value_clauses = []
    params: dict[str, Any] = {"zid": zid}
    for i, (tid, e) in enumerate(latest.items()):
        value_clauses.append(f"(:tid{i}, :mod{i}, :modified{i})")
        params[f"tid{i}"] = tid
        params[f"mod{i}"] = e.mod
        params[f"modified{i}"] = e.t_ms
    stmt = (
        "UPDATE comments SET mod = v.mod, modified = v.modified "
        "FROM (VALUES " + ", ".join(value_clauses) + ") AS v(tid, mod, modified) "
        "WHERE comments.tid = v.tid AND comments.zid = :zid"
    )
    conn.execute(sa.text(stmt), params)
    return len(events)


# ---------------------------------------------------------------------------
# Runners (Stage B.1/B.2) — subprocess wrappers for the clj container loop and
# the python poller CLI, sharing one lifecycle (start/is_alive/kill).
# ---------------------------------------------------------------------------
class _SubprocessRunner:
    """Shared Popen lifecycle. ``kill()`` is SIGTERM-then-SIGKILL: a grace
    period for cooperative shutdown (both the JVM and the python poller
    install signal handling — math_poller.py:63-68 traps SIGTERM/SIGINT), then
    an unconditional SIGKILL so a hung/ignoring process never blocks the
    harness (spec B.1 — "kill() must terminate the JVM (SIGKILL after grace)").

    ``log_path`` (REQUIRED FIX #3, 2026-07-24 live-debug task — "RUNNER
    EVIDENCE"): when given, stdout+stderr are redirected DIRECTLY to that
    file (append mode — a seam restart reusing the same path preserves the
    pre-seam timeline in one file) instead of a ``subprocess.PIPE``. This is
    not merely a debugging nicety: an un-drained PIPE fills its OS buffer
    (~64KB) once the child writes enough output, at which point the child
    BLOCKS on its next write — a classic subprocess deadlock — because the
    live feeder loop (:func:`run_batch_loop`) never reads from the runners'
    stdout the way the standalone ``run-clj``/``run-py`` CLI subcommands do
    (``_run_and_stream`` in ``scripts/poller_equiv.py``). ``log_path=None``
    (the default) preserves the original PIPE-based contract those
    subcommands rely on."""

    def __init__(
        self, cmd: list[str], *, cwd: Path, env: dict[str, str],
        log_path: Optional[Path] = None,
    ):
        self.cmd = cmd
        self.cwd = cwd
        self.env = env
        self.log_path = Path(log_path) if log_path is not None else None
        self._proc: Optional[subprocess.Popen] = None
        self._log_fh: Optional[Any] = None

    def start(self) -> subprocess.Popen:
        if self.log_path is not None:
            self.log_path.parent.mkdir(parents=True, exist_ok=True)
            self._log_fh = open(self.log_path, "a")
            stdout_target: Any = self._log_fh
        else:
            stdout_target = subprocess.PIPE
        self._proc = subprocess.Popen(
            self.cmd,
            cwd=str(self.cwd),
            env=self.env,
            stdout=stdout_target,
            stderr=subprocess.STDOUT,
            text=True,
        )
        return self._proc

    @property
    def pid(self) -> Optional[int]:
        return self._proc.pid if self._proc is not None else None

    def is_alive(self) -> bool:
        return self._proc is not None and self._proc.poll() is None

    def wait(self, timeout: Optional[float] = None) -> Optional[int]:
        if self._proc is None:
            return None
        return self._proc.wait(timeout=timeout)

    def kill(self, grace: float = 5.0) -> None:
        try:
            if self._proc is None or self._proc.poll() is not None:
                return
            self._proc.terminate()  # SIGTERM: cooperative shutdown attempt
            try:
                self._proc.wait(timeout=grace)
            except subprocess.TimeoutExpired:
                self._proc.kill()  # SIGKILL: unconditional
                self._proc.wait(timeout=grace)
        finally:
            if self._log_fh is not None:
                self._log_fh.close()
                self._log_fh = None


def build_clj_env(
    *,
    database_url: str,
    math_env: str,
    poll_from_days_ago: float = 10000,
    logging_level: str = "info",
    base_env: Optional[dict[str, str]] = None,
) -> dict[str, str]:
    """Env for ``clojure -M:run full``, keyed exactly to what
    ``polismath.components.config`` actually reads (config.clj rules map,
    :63-114 — environ lower-kebabs the env var name):

      DATABASE_URL       -> :database-url  (config.clj:68; postgres.clj:108
                            asserts non-nil at Postgres component start).
                            TRANSLATED to the ``postgres://`` scheme
                            (:func:`_url_with_scheme`) — root cause #1
                            (2026-07-24 live debug): ``create-hikari-datasource``
                            (postgres.clj:18) parses this with
                            ``#"postgres://(?:(.+):(.*)@)?([^:]+)(?::(\\d+))?/(.+)"``,
                            which only matches a LITERAL "postgres://" prefix.
                            The SQLAlchemy-style "postgresql://" URLs this
                            module otherwise deals in (``create_equiv_db``'s
                            return value) make ``re-matches`` return nil, so
                            user/password/host/port/db ALL destructure to
                            nil -> ``jdbc:postgresql://:5432/`` (empty host,
                            default port) -> immediate ConnectException.
                            Reproduced live against a real Postgres; fixed by
                            this translation (verified: math_main rows are
                            written once corrected).
      MATH_ENV           -> :math-env      (config.clj:65; becomes
                            :math-env-string, the upsert key on every
                            math_main/math_ticks/... row)
      POLL_FROM_DAYS_AGO -> :poll-from-days-ago (config.clj:106; poller.clj:15
                            ``start-polling-from = now - poll-from-days-ago
                            days`` — 10000 days makes every historical vote
                            timestamp "since" the watermark). FORMATTED as a
                            bare integer string (:func:`_format_days_ago`) —
                            root cause #2 (2026-07-24 live debug): Clojure's
                            ``->long`` parser (``Long/parseLong``) throws on
                            "10000.0" (exactly what ``str()`` on the CLI's
                            ``type=float`` default produces), silently
                            becoming nil post-``deep-merge`` (config.clj's
                            defaults-vs-environ merge REPLACES, not
                            fall-backs). ``polismath.poller/poll`` then
                            computes ``(* nil 1000 60 60 24)`` — reproduced
                            live as ``NullPointerException at
                            polismath.poller/poll (poller.clj:15)``.
      LOGGING_LEVEL       -> :logging-level (config.clj:111, applied by
                            ``polismath.components.logger`` — its
                            ``:min-level`` defaults to ``:warn``
                            (``defaults`` map, config.clj:53), which
                            SILENTLY SUPPRESSES every application-level
                            trace (poll cycles, conv-manager batch
                            processing, recompute completion). RUNNER
                            EVIDENCE (2026-07-24 live-debug task, REQUIRED
                            FIX #3): without this, a captured runner log
                            (:class:`_SubprocessRunner`'s ``log_path``) is
                            HikariCP connection-pool heartbeats and nothing
                            else — a stalled container is indistinguishable
                            from a healthy-but-quiet one. Defaults to
                            ``"info"`` (every poll cycle + conv-manager
                            timing line, still well short of ``:debug``'s
                            volume); overridable per-call.
    """
    env = dict(base_env if base_env is not None else os.environ)
    env["DATABASE_URL"] = _url_with_scheme(database_url, "postgres")
    env["MATH_ENV"] = math_env
    env["POLL_FROM_DAYS_AGO"] = _format_days_ago(poll_from_days_ago)
    env["LOGGING_LEVEL"] = logging_level
    return env


class CljContainerRunner(_SubprocessRunner):
    """The REAL clj math container loop: ``clojure -M:run full``
    (``deps.edn:65-66`` ``:run`` alias -> ``-m polismath.runner``;
    ``runner.clj`` subcommand table -> ``"full"`` -> ``system/full-system``,
    ``system.clj:47-52`` = ``poller-system`` = base-system + vote-poller +
    mod-poller, ``system.clj:29-33``). ``math/bin/run`` wraps this same
    invocation in a 4h-reboot while-loop (MATH_POLLER_EQUIV_SPEC.md hazard 4)
    that is irrelevant at harness timescales — we invoke the bare command.
    """

    def __init__(
        self,
        *,
        database_url: str,
        math_env: str,
        poll_from_days_ago: float = 10000,
        logging_level: str = "info",
        base_env: Optional[dict[str, str]] = None,
        log_path: Optional[Path] = None,
    ):
        env = build_clj_env(
            database_url=database_url,
            math_env=math_env,
            poll_from_days_ago=poll_from_days_ago,
            logging_level=logging_level,
            base_env=base_env,
        )
        super().__init__(["clojure", "-M:run", "full"], cwd=_MATH_ROOT, env=env, log_path=log_path)


def build_py_env(
    *,
    database_url: str,
    math_env: str,
    poll_from_days_ago: float = 10000,
    engine_mode: str = ENGINE_MODE_LEGACY,
    database_ssl_mode: str = "disable",
    base_env: Optional[dict[str, str]] = None,
) -> dict[str, str]:
    """Env for ``scripts/math_poller.py``, keyed to ``PollerConfig.from_env``
    (service.py:150-182): ``DATABASE_URL``, ``MATH_ENV``,
    ``POLL_FROM_DAYS_AGO`` (same names as the clj side — see
    :func:`build_clj_env`), plus ``POLISMATH_ENGINE_MODE`` (engine_mode.py:30
    ``ENGINE_MODE_ENV_VAR``), applied at service start via
    ``apply_engine_mode`` (service.py:207-220).

    ``DATABASE_URL`` is normalized to the ``postgresql://`` scheme
    (:func:`_url_with_scheme`) — the mirror-image guard of the clj side's
    translation to ``postgres://`` (:func:`build_clj_env`'s docstring):
    SQLAlchemy/psycopg2 reject the bare "postgres" dialect (removed in
    SQLAlchemy 1.4+), so even a caller that already normalized for the clj
    side must not leak that scheme here.

    ``DATABASE_SSL_MODE`` defaults to ``"disable"`` — root cause #3
    (2026-07-24 live debug): ``scripts/math_poller.py`` never loads a `.env`
    file, so ``PostgresClient``'s own fallback
    (``os.environ.get("DATABASE_SSL_MODE", "require")``, postgres.py:92) bites
    whenever this env var isn't already present in the CALLING shell —
    reproduced live as an infinite ``psycopg2.OperationalError: ... server
    does not support SSL, but SSL was required`` retry loop against the
    harness's local (non-SSL) Postgres target. This harness always targets a
    local/OrbStack-proxied Postgres with no SSL layer (spec hazard 1) so
    "disable" is the correct default; overridable for a caller that DOES
    target an SSL-requiring server.
    """
    env = dict(base_env if base_env is not None else os.environ)
    env["DATABASE_URL"] = _url_with_scheme(database_url, "postgresql")
    env["MATH_ENV"] = math_env
    env["POLL_FROM_DAYS_AGO"] = _format_days_ago(poll_from_days_ago)
    env[ENGINE_MODE_ENV_VAR] = engine_mode
    env["DATABASE_SSL_MODE"] = database_ssl_mode
    return env


class PyPollerRunner(_SubprocessRunner):
    """The python math_poller CLI (``scripts/math_poller.py``), run-forever
    mode — its only flag is ``--once`` (math_poller.py:43-48), which we do NOT
    pass, so it runs until killed exactly like the clj container."""

    def __init__(
        self,
        *,
        database_url: str,
        math_env: str,
        poll_from_days_ago: float = 10000,
        engine_mode: str = ENGINE_MODE_LEGACY,
        database_ssl_mode: str = "disable",
        base_env: Optional[dict[str, str]] = None,
        log_path: Optional[Path] = None,
    ):
        env = build_py_env(
            database_url=database_url,
            math_env=math_env,
            poll_from_days_ago=poll_from_days_ago,
            engine_mode=engine_mode,
            database_ssl_mode=database_ssl_mode,
            base_env=base_env,
        )
        super().__init__(
            ["uv", "run", "python", "scripts/math_poller.py"], cwd=_DELPHI_ROOT, env=env,
            log_path=log_path,
        )


# ---------------------------------------------------------------------------
# wait_for_tick (Stage B.3) — poll math_main until a caller predicate holds.
# ---------------------------------------------------------------------------
def wait_for_tick(
    conn: Any,
    math_env: str,
    zid: int,
    predicate: Callable[[dict[str, Any]], bool],
    timeout: float,
    *,
    poll_interval: float = 0.5,
    sleep: Callable[[float], None] = time.sleep,
    now: Callable[[], float] = time.monotonic,
) -> Optional[dict[str, Any]]:
    """Poll ``math_main`` for ``(zid, math_env)`` until ``predicate(row)`` is
    True or ``timeout`` seconds elapse. Returns the matching row (as a plain
    dict) or ``None`` on timeout.

    ``conn`` needs only ``.execute(text, params) -> Result`` with
    ``Result.mappings().first()`` — a plain SQLAlchemy ``Connection`` (same
    interface ``tests/poller/test_integration_postgres.py`` already uses) or a
    stand-in double. ``sleep``/``now`` are injectable seams so unit tests never
    actually sleep or depend on wall-clock time.
    """
    deadline = now() + timeout
    while True:
        result = conn.execute(
            sa.text("SELECT * FROM math_main WHERE zid = :zid AND math_env = :math_env"),
            {"zid": zid, "math_env": math_env},
        )
        row = result.mappings().first()
        if row is not None:
            row_dict = dict(row)
            if predicate(row_dict):
                return row_dict
        if now() >= deadline:
            return None
        sleep(poll_interval)


# ---------------------------------------------------------------------------
# Quirk Q19 harness-level mitigation (session 2, 2026-07-24) — wait-for-
# first-poll-cycle gate, approved under the goal's standing autonomy.
#
# ``conv_man.clj``'s ``queue-message-batch!`` has an unsynchronized
# check-then-act race: ``(if-let [...] (get @conversations zid) ...)`` then
# a BLIND ``(swap! conversations assoc zid conv-actor)`` with no conflict
# check. When the ``:votes`` AND ``:moderation`` pollers BOTH discover data
# for a brand-new zid on their very first poll tick, they can each
# independently decide "no actor yet" and each spin up their OWN
# conv-actor (confirmed live via duplicate "Running load or init" log
# lines) — whichever actor's swap! lands last wins the registry slot, and
# the OTHER actor (which may have ALREADY correctly processed an earlier
# batch) is silently orphaned, permanently losing that batch's votes with
# no self-healing (no periodic full recompute exists). Reproduced 3/3 live
# attempts once the earlier root causes (#1-#5) were fixed and out of the
# way — ledgered as quirk Q19, math team notified separately (math/src/ is
# off-limits to fix this here).
#
# This harness triggers the race with near-certainty because it seeds
# comments AND inserts batch 0's votes well before the JVM finishes
# booting (~20-30s) — so BOTH pollers see data on their FIRST-EVER cycle.
# The mitigation: delay feeding batch 0 until we've observed evidence that
# the clj container has ALREADY completed at least one ``:votes`` poll
# cycle. By construction that cycle found ZERO votes (none inserted yet),
# so it can NEVER call ``queue-message-batch!`` — meaning only ONE poller
# (moderation, discovering the pre-seeded comments) can EVER be first to
# create the actor, regardless of exact scheduling. This is a pure
# INPUT-sequencing change (when we feed data, not what we accept as a
# match) — it does not touch, weaken, or special-case any comparison logic.
#
# Signal choice: ``polismath.poller/poll`` (poller.clj:24) logs
# ``"Polling <message-type> > <watermark>"`` UNCONDITIONALLY on EVERY
# cycle, found rows or not — this is what makes it reliable (vs. e.g.
# waiting for a DB row, which wouldn't exist yet on a genuinely quiet
# cycle) and requires ``LOGGING_LEVEL=info`` (already the harness default,
# see :func:`build_clj_env`).
# ---------------------------------------------------------------------------
def _poll_cycle_signal_seen(log_text: str, *, message_type: str = "votes") -> bool:
    """Pure predicate: has ``log_text`` (a runner log's current content)
    shown evidence of at least one completed poll cycle for
    ``message_type``. See the section docstring above for why this
    specific, unconditionally-emitted log line is a reliable signal."""
    return f"Polling :{message_type} >" in log_text


def wait_for_first_poll_cycle(
    log_path: Path | None,
    timeout: float,
    *,
    message_type: str = "votes",
    poll_interval: float = 0.5,
    sleep: Callable[[float], None] = time.sleep,
    now: Callable[[], float] = time.monotonic,
    start_offset: int = 0,
) -> dict[str, Any]:
    """Poll ``log_path``'s content (from byte ``start_offset`` onward) until
    :func:`_poll_cycle_signal_seen` matches or ``timeout`` elapses. Mirrors
    :func:`wait_for_tick`'s injectable-clock shape so it's testable with a
    fake clock and no real sleeping. ``log_path=None`` (no runner log
    captured — e.g. :class:`_SubprocessRunner` was built without one)
    returns immediately as NOT observed, never waits — there is nothing to
    poll.

    ``start_offset`` matters because :class:`_SubprocessRunner` opens its
    log in APPEND mode (so a seam restart's post-restart output lands in
    the SAME file as the pre-restart run — see its docstring). Without an
    offset, a FRESH container's cold-start gate check would be satisfied
    INSTANTLY by a "Polling ..." line left over from a PREVIOUS attempt
    sitting earlier in the same ``--out`` directory's log file, silently
    defeating the whole quirk-Q19 mitigation after the very first run —
    reproduced live (2026-07-24 session 2): the mitigation's first
    real-world run still hit Q19 because the gate read stale text.
    Callers (:func:`run_batch_loop`) capture ``log_path``'s size
    IMMEDIATELY BEFORE starting to wait and pass it as this offset, so only
    genuinely NEW content (from THIS container instance) can satisfy the
    gate. ``start_offset=0`` (the default) reads the whole file, unchanged
    from before this parameter existed.

    A missing (not-yet-created) log file is treated as empty content, not
    an error — the subprocess may not have flushed its first write yet.

    Returns a dict always carrying ``observed``/``elapsed_s``, plus
    ``reason``/``message_type`` on a timeout — this is the SAME dict
    :func:`run_batch_loop` records verbatim into the manifest's
    ``startup_gate`` section, so a run is self-describing about whether the
    gate fired, and whether it actually observed the signal in time.
    """
    start = now()
    if log_path is None:
        return {"observed": False, "elapsed_s": 0.0, "reason": "no runner log path"}
    log_path = Path(log_path)
    deadline = start + timeout
    while True:
        text = ""
        if log_path.exists():
            with open(log_path, "rb") as fh:
                fh.seek(start_offset)
                text = fh.read().decode(errors="replace")
        if _poll_cycle_signal_seen(text, message_type=message_type):
            return {"observed": True, "elapsed_s": now() - start, "message_type": message_type}
        if now() >= deadline:
            return {
                "observed": False, "elapsed_s": now() - start,
                "reason": "timeout", "message_type": message_type,
            }
        sleep(poll_interval)


# =============================================================================
# Stage C — feeder + comparer.
# =============================================================================
# The three data tables the feeder snapshots per (math_env, batch); the same
# three tables the spec's "compare" bullet names. Fixed constants ONLY — never
# interpolate a caller-supplied string into the SQL built from this tuple
# (:func:`fetch_math_row`) or the filesystem path built from it
# (:func:`snapshot_path`).
EQUIV_TABLES: tuple[str, ...] = ("math_main", "math_bidtopid", "math_ptptstats")


# ---------------------------------------------------------------------------
# Readiness predicate — pure logic (spec §1 "feed" bullet).
# ---------------------------------------------------------------------------
def blob_total_votes(blob: dict[str, Any]) -> int | None:
    """Cumulative distinct ``(pid, tid)`` rated-cell count carried by a
    math_main blob's ``user-vote-counts`` key (sum of its per-pid values).

    ``user-vote-counts`` is one of the 23 prep-main keys BOTH engines emit
    (crosslang.py:44-50 ``PREP_MAIN_KEYS``); Python builds it via
    ``_compute_user_vote_counts`` (conversation.py:2013-2116) from
    ``raw_rating_mat`` over EVERY participant in ``rating_mat.index`` — summed
    across all pids, this is exactly the number of distinct ``(pid, tid)``
    pairs with a latest vote (a revote overwrites the SAME rating-matrix cell
    rather than adding a new one, so revotes never inflate the total — the
    same invariant :func:`expected_cumulative_vote_count` relies on below).
    Verified against the committed vw recording
    (``real_data/.local/replays/vw/uniform8-clojure-legacy/py/step-000.json``):
    ``sum(blob["user-vote-counts"].values()) == 585 ==
    blob["vote_stats"]["n_votes"] == batch_size`` at step 0.

    ``votes-base`` was deliberately NOT used here despite also being a
    prep-main key: in ``clojure-legacy`` engine mode (the mode this harness
    always runs — ``build_py_env``'s default) Python's ``votes-base`` is the
    Clojure-exact BUCKET form (``_compute_votes_base_buckets``,
    conversation.py:1743-1791), whose own docstring warns "the aggregation
    domain is each bucket's member pids only — votes from unclustered
    participants never appear" (FP-81fda13ef6). Summing its ``'S'`` vectors
    therefore UNDERCOUNTS whenever a participant hasn't been assigned to a
    base cluster yet (measured 565 vs the true 585 on the same vw step-000
    blob above) — exactly the kind of transient state a readiness predicate
    would otherwise stall on forever.

    Falls back to the Python-only ``vote_stats.n_votes`` (conversation.py:
    526-561 ``_compute_vote_stats``) when ``user-vote-counts`` is
    absent/malformed — the Clojure side never populates ``vote_stats``, so
    this fallback only ever helps when inspecting a lone Python snapshot in
    isolation.

    Returns ``None`` (never a guessed ``0``) when neither key is present in
    the expected shape — callers must treat that as "not ready to judge yet",
    not as "zero votes seen".
    """
    if not isinstance(blob, dict):
        return None
    uvc = blob.get("user-vote-counts")
    if isinstance(uvc, dict):
        try:
            return sum(uvc.values())
        except TypeError:
            return None
    vs = blob.get("vote_stats")
    if isinstance(vs, dict) and "n_votes" in vs:
        return vs["n_votes"]
    return None


def expected_cumulative_vote_count(dataset: ReplayDataset, upto_slot: int) -> int:
    """The value :func:`blob_total_votes` should reach once a math_main row
    reflects every vote in ``dataset.votes[:upto_slot]``: the count of
    DISTINCT ``(pid, tid)`` pairs in that prefix.

    ``VoteEvent.is_revote`` already flags exactly this (types.py:44 — "a
    later occurrence of an already-seen (pid, tid) pair in sorted order",
    computed incrementally over a GROWING prefix in
    :meth:`ReplayDataset.build`) — so counting non-revotes within any prefix
    of the sorted stream gives that prefix's distinct-pair count directly.
    Pure/unit-testable: no I/O, no dataset mutation.
    """
    return sum(1 for v in dataset.votes[:upto_slot] if not v.is_revote)


def make_batch_ready_predicate(
    *, min_last_vote_ts: int, min_vote_count: int,
) -> Callable[[dict[str, Any] | None], bool]:
    """Pure predicate factory (spec §1 "feed" bullet — "wait until EACH
    math_env's math_main row for the zid reflects the batch").

    The returned predicate matches a math_main ROW (the shape
    :func:`wait_for_tick` / :func:`fetch_math_row` return — a dict with a
    ``data`` key holding the blob, plus the persisted ``last_vote_timestamp``
    column) once BOTH:

      - the blob's ``lastVoteTimestamp`` is ``>= min_last_vote_ts`` (the
        batch's cut time) — falls back to the persisted
        ``last_vote_timestamp`` column if the blob is missing the key
        (defensive; both are written from the same ``conv.last_updated``
        value — poller/math_writer.py:101-112), and
      - :func:`blob_total_votes` has caught up to ``>= min_vote_count`` —
        "vote count advanced".

    ``None`` (a cold zid — no row yet) never satisfies the predicate.
    """

    def predicate(row: dict[str, Any] | None) -> bool:
        if row is None:
            return False
        blob = row.get("data")
        if not isinstance(blob, dict):
            return False
        lvt = blob.get("lastVoteTimestamp")
        if lvt is None:
            lvt = row.get("last_vote_timestamp")
        if lvt is None or lvt < min_last_vote_ts:
            return False
        n_votes = blob_total_votes(blob)
        if n_votes is None or n_votes < min_vote_count:
            return False
        return True

    return predicate


# ---------------------------------------------------------------------------
# Batch slicing — pure logic (spec §1 "feed" bullet: "insert vote batch k").
# ---------------------------------------------------------------------------
def batch_slices(cuts: Sequence[int]) -> list[tuple[int, int]]:
    """Partition ``cuts`` into half-open, 1-based ``(prev, cut]`` batches.

    Mirrors :func:`polismath.replay.schedule.slice_schedule`'s own
    ``prev = 0; for cut in slots: batch = votes[prev:cut]; prev = cut`` loop
    (schedule.py:208-230), WITHOUT materializing vote/mod payloads — the live
    feeder slices the actual dataset itself at insert time (see
    :func:`insert_votes`), so this only needs to produce the ``(prev, cut)``
    slot pairs.

    ``cuts`` must already be resolved: strictly increasing, 1-based absolute
    vote-count slots (e.g. :func:`polismath.replay.schedule.resolve_cut_slots`'s
    output, or a bare preset's slot list — ``ScheduleSpec``/schedule-file
    resolution is the CALLER's job, kept out of this pure function). The
    first batch always starts at slot 0 (spec's "first batch from slot 0"
    edge case); this function does not know the dataset's total vote count
    ``n``, so a caller wanting the LAST batch to run "to n" (spec's other
    edge case) must include ``n`` as ``cuts[-1]`` themselves — exactly like
    schedule.py's ``"end"`` sentinel.

    Raises ``ValueError`` if ``cuts`` is not strictly increasing.
    """
    if not cuts:
        return []
    slices: list[tuple[int, int]] = []
    prev = 0
    for cut in cuts:
        if cut <= prev:
            raise ValueError(
                f"cuts must be strictly increasing 1-based slots; got {cut!r} "
                f"after prev={prev}"
            )
        slices.append((prev, cut))
        prev = cut
    return slices


def snap_cuts_past_timestamp_ties(dataset: ReplayDataset, cuts: Sequence[int]) -> list[int]:
    """Adjust each 1-based cut slot FORWARD (never backward) so it never
    falls strictly inside a run of votes sharing the SAME ``created``
    millisecond timestamp.

    ROOT CAUSE #4 (2026-07-24 live-debug task): BOTH pollers watermark with
    STRICT ``created > ts`` — ``postgres/poll`` (postgres.clj:132-145,
    global vote poll) and ``PostgresClient.poll_votes_since``
    (postgres.py:534-557) are byte-identical on this point (also confirmed
    directly against the SQL text). If a batch cut falls in the MIDDLE of a
    run of votes sharing the exact same ``created`` value, the votes AFTER
    the cut with that timestamp become PERMANENTLY unreachable for BOTH
    engines the instant the FIRST batch's poll advances its watermark to
    that exact value — verified live against a real Postgres + real
    ``clojure -M:run full``: with vw's committed uniform-8 schedule (cut=585
    at slot 585), votes at 0-based indices 585/586/587 shared
    ``t_ms=1732028794000`` with index 584 (the cut boundary vote); clj-ref's
    own ``user-vote-counts`` came up short by EXACTLY 1 for EXACTLY the 3
    pids owning those 3 votes (pid=2/tid=43, pid=17/tid=11, pid=22/tid=22),
    stalling the feeder's readiness predicate forever (its target vote count
    assumed every vote up to the cut was reachable). This is NOT a
    clj-vs-py divergence — both engines drop the exact same votes,
    identically, by construction (same SQL, same watermark) — it is a
    structurally unreachable target the HARNESS's own batch-cut choice
    created; fixing it here (rather than loosening the readiness predicate
    or the acceptance bar) is the only change that doesn't touch what's
    being measured.

    A cut equal to ``len(dataset.votes)`` (the dataset's own total — the
    "final batch runs to n" convention :func:`batch_slices` documents) is
    NEVER adjusted: there is no "next" vote to tie against, and growing past
    the dataset would be nonsensical.
    """
    votes = dataset.votes
    n = len(votes)
    adjusted: list[int] = []
    for cut in cuts:
        c = cut
        while 0 < c < n and votes[c - 1].t_ms == votes[c].t_ms:
            c += 1
        adjusted.append(c)
    return adjusted


# ---------------------------------------------------------------------------
# Snapshot store — mirrors store.py's per-(dataset, schedule) directory
# convention (design §7 / store.py:1-23), keyed here by (math_env, batch).
# ---------------------------------------------------------------------------
def snapshot_dir(out_dir: str | Path, math_env: str, batch_index: int) -> Path:
    """``<out_dir>/<math_env>/batch-<NNN>/`` — never created here (lazy, like
    :func:`polismath.replay.store.write_recording`); see :func:`write_snapshot`."""
    math_env = _safe_path_component(math_env, label="math_env")
    return Path(out_dir) / math_env / f"batch-{batch_index:03d}"


def snapshot_path(out_dir: str | Path, math_env: str, batch_index: int, table: str) -> Path:
    if table not in EQUIV_TABLES:
        raise ValueError(f"unknown equiv table {table!r}; expected one of {EQUIV_TABLES}")
    return snapshot_dir(out_dir, math_env, batch_index) / f"{table}.json"


def write_snapshot(
    out_dir: str | Path, math_env: str, batch_index: int, table: str, row: dict[str, Any],
) -> Path:
    """Write one DB row (as returned by :func:`wait_for_tick` /
    :func:`fetch_math_row`) to its snapshot path, creating parent directories
    lazily. Returns the path written."""
    path = snapshot_path(out_dir, math_env, batch_index, table)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as fh:
        json.dump(row, fh, indent=2, sort_keys=True, default=str)
    return path


def load_snapshot(
    out_dir: str | Path, math_env: str, batch_index: int, table: str,
) -> dict[str, Any] | None:
    """The inverse of :func:`write_snapshot`; ``None`` when the snapshot was
    never written (e.g. the batch never became ready for that env)."""
    path = snapshot_path(out_dir, math_env, batch_index, table)
    if not path.exists():
        return None
    return json.loads(path.read_text())


def discover_batches(out_dir: str | Path, math_env: str) -> list[int]:
    """Batch indices actually snapshotted for ``math_env`` (its
    ``batch-NNN/`` subdirectories under ``out_dir``), sorted ascending.
    Empty when the env has no directory at all (nothing snapshotted yet, or
    an unrecognized/misspelled env name — never raises for that case, unlike
    :func:`snapshot_path`, since "no batches yet" is a normal state for the
    comparer to report on, not a caller error)."""
    math_env = _safe_path_component(math_env, label="math_env")
    d = Path(out_dir) / math_env
    if not d.is_dir():
        return []
    indices: list[int] = []
    for p in sorted(d.glob("batch-*")):
        if not p.is_dir():
            continue
        try:
            indices.append(int(p.name.split("-", 1)[1]))
        except (IndexError, ValueError):
            continue
    return sorted(indices)


def write_manifest(out_dir: str | Path, manifest: dict[str, Any]) -> Path:
    """Write the feeder's per-batch bookkeeping (expected vote counts, cut
    times, …) alongside the snapshots — the comparer's watermark check reads
    this back instead of re-loading the dataset (:func:`load_manifest`)."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "manifest.json"
    with open(path, "w") as fh:
        json.dump(manifest, fh, indent=2, sort_keys=True, default=str)
    return path


def load_manifest(out_dir: str | Path) -> dict[str, Any] | None:
    path = Path(out_dir) / "manifest.json"
    if not path.exists():
        return None
    return json.loads(path.read_text())


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


class PollerEquivStreamError(RuntimeError):
    """Raised by :func:`run_batch_loop` when a batch's readiness predicate
    times out for some ``math_env`` — REQUIRED FIX #2 (2026-07-24 live-debug
    task) "FAIL-FAST FEEDER": aborts the WHOLE stream immediately rather than
    silently recording ``{"ready": False}`` and continuing to feed more vote
    batches into a runner that will never catch up (or has already crashed).
    The pre-fix behavior is exactly what produced a vacuous PASS in the
    2026-07-24 live run: 8 batches fed, 0 ever became ready, nothing ever
    surfaced the failure loudly. The message always names the offending env,
    batch index, elapsed wait, and the LAST OBSERVED math_main state for that
    env (or the literal phrase "no row ever appeared" if the zid never got a
    single tick) — plus, when the failing runner has a captured log
    (:attr:`_SubprocessRunner.log_path`), the last ~30 lines of it."""


_RUNNER_LOG_TAIL_LINES = 30


def _tail_lines(path: Path | None, n: int = _RUNNER_LOG_TAIL_LINES) -> str:
    """Last ``n`` lines of ``path`` (or a placeholder when unavailable) —
    the diagnostic body :class:`PollerEquivStreamError` embeds so a stream
    abort is debuggable from the exception message alone, no separate log
    hunt required."""
    if path is None:
        return "(no runner log captured for this env)"
    path = Path(path)
    if not path.exists():
        return f"(runner log {path} does not exist)"
    try:
        lines = path.read_text(errors="replace").splitlines()
    except OSError as exc:
        return f"(could not read runner log {path}: {exc})"
    if not lines:
        return f"(runner log {path} is empty)"
    return "\n".join(lines[-n:])


def _describe_math_main_row(row: dict[str, Any] | None) -> str:
    """Human-readable summary of the LAST observed math_main row for a
    timed-out env (or the literal "no row ever appeared" when ``row`` is
    ``None`` — a zid that never got a single tick from that env)."""
    if row is None:
        return "no row ever appeared"
    blob = row.get("data")
    n_votes = blob_total_votes(blob) if isinstance(blob, dict) else None
    return (
        f"caching_tick={row.get('caching_tick')} math_tick={row.get('math_tick')} "
        f"last_vote_timestamp={row.get('last_vote_timestamp')} blob_total_votes={n_votes}"
    )


# ---------------------------------------------------------------------------
# Feeder — the LIVE loop (spec §1 "feed"/"seam" bullets). Thin by
# construction: every decision above this point is a pure function; this
# loop only sequences I/O calls to them.
# ---------------------------------------------------------------------------
def run_batch_loop(
    conn: Any,
    dataset: ReplayDataset,
    cuts: Sequence[int],
    math_envs: Sequence[str],
    runners: dict[str, Any],
    *,
    out_dir: str | Path,
    zid: int = DEFAULT_ZID,
    seam_after: int | None = None,
    restart_envs_at_seam: Sequence[str] | None = None,
    restart_builders: dict[str, Callable[[], Any]] | None = None,
    wait_timeout: float = 120.0,
    poll_interval: float = 0.5,
    sleep: Callable[[float], None] = time.sleep,
    now: Callable[[], float] = time.monotonic,
    insert_fn: Callable[[Any, ReplayDataset, int, int, int], int] = insert_votes,
    mod_insert_fn: Callable[[Any, ReplayDataset, int | None, int, int], int] = insert_mod_events,
    startup_gate_envs: Sequence[str] | None = None,
    startup_gate_timeout: float = 60.0,
    startup_gate_message_type: str = "votes",
) -> dict[str, Any]:
    """Insert vote batches one at a time, waiting for each ``math_env`` to
    reflect the batch before snapshotting its three tables and moving on;
    optionally restart runners at ``seam_after``.

    Every decision (readiness, batch bounds, snapshot naming) is delegated to
    the pure functions above, so this loop is itself trivially exercised with
    fake ``conn``/``runners`` doubles and a fake ``insert_fn`` — see
    ``tests/replay_harness/test_poller_equiv_compare.py::TestRunBatchLoop``
    (no real DB, no real subprocess).

    ``runners`` is mutated in place: a seam restart replaces the entry for a
    restarted env with the freshly-built runner (mirrors
    :class:`_SubprocessRunner`'s kill-then-replace lifecycle — the OLD
    runner object is never reused after ``kill()``).

    ``mod_insert_fn`` (session 2, 2026-07-24) applies ``dataset.mod_events``
    alongside each batch's votes, using the SAME ``(prev_time_ms,
    cut_time_ms]`` time-window :func:`insert_mod_events` documents (mirrors
    ``slice_schedule``'s moderation semantics) — defaults to the real
    :func:`insert_mod_events`, which is a no-op (never touches ``conn``) for
    any dataset with zero mod_events, so this is safe for every existing
    caller/test unchanged.

    ``startup_gate_envs`` (session 2, 2026-07-24 — quirk Q19 harness-level
    mitigation, approved under the goal's standing autonomy) names the
    envs (if any) whose runner must show evidence of AT LEAST ONE completed
    poll cycle (:func:`wait_for_first_poll_cycle`) BEFORE batch 0 is ever
    inserted — see that function's module-level docstring for the full
    rationale. ``None`` (the default) disables the gate entirely, keeping
    the manifest's ``startup_gate`` section a fixed ``{"enabled": False,
    "envs": {}}`` for every caller that doesn't opt in. A gate that never
    observes its signal within ``startup_gate_timeout`` aborts the WHOLE
    stream the same way a batch-readiness timeout does (persists the
    partial manifest, raises :class:`PollerEquivStreamError`) — proceeding
    into batch 0 without the safety net the gate exists for would be worse
    than not gating at all.

    Returns (and also writes, via :func:`write_manifest`) the batch manifest.
    """
    out_dir = Path(out_dir)
    # ROOT CAUSE #4 (2026-07-24 live-debug task) — see
    # :func:`snap_cuts_past_timestamp_ties`'s docstring: a raw cut that falls
    # inside a same-millisecond vote cluster makes votes structurally
    # unreachable for BOTH pollers, not just harder to reach — snap BEFORE
    # slicing so the readiness predicate is never given an impossible target.
    effective_cuts = snap_cuts_past_timestamp_ties(dataset, cuts)
    slices = batch_slices(effective_cuts)
    manifest: dict[str, Any] = {
        "zid": zid, "math_envs": list(math_envs),
        "cuts_requested": list(cuts), "cuts_effective": effective_cuts,
        "startup_gate": {"enabled": bool(startup_gate_envs), "envs": {}},
        "batches": [],
    }

    # Quirk Q19 mitigation (session 2, 2026-07-24) — see this function's
    # docstring and wait_for_first_poll_cycle's module-level docstring:
    # block feeding batch 0 until each gated env's runner has shown evidence
    # of a completed poll cycle, so the conv_man.clj actor-creation race can
    # never trigger from the votes side (a cycle observed BEFORE any votes
    # exist is guaranteed to have found none).
    if startup_gate_envs:
        gate_envs_report: dict[str, Any] = {}
        for env in startup_gate_envs:
            runner = runners.get(env)
            log_path = getattr(runner, "log_path", None)
            # Capture the CURRENT log size BEFORE waiting — see
            # wait_for_first_poll_cycle's start_offset docstring: the log is
            # append-mode (seam-restart continuity), so without this a
            # second-or-later run in the same --out dir would have its gate
            # satisfied instantly by a PRIOR attempt's stale "Polling..."
            # line, silently defeating the mitigation (found live).
            start_offset = 0
            if log_path is not None and Path(log_path).exists():
                start_offset = Path(log_path).stat().st_size
            result = wait_for_first_poll_cycle(
                log_path, startup_gate_timeout, message_type=startup_gate_message_type,
                poll_interval=poll_interval, sleep=sleep, now=now,
                start_offset=start_offset,
            )
            gate_envs_report[env] = result
            if not result["observed"]:
                manifest["startup_gate"]["envs"] = gate_envs_report
                write_manifest(out_dir, manifest)
                raise PollerEquivStreamError(
                    f"poller-equiv feeder ABORT: startup gate for env={env!r} never observed "
                    f"a {startup_gate_message_type!r} poll cycle within "
                    f"{startup_gate_timeout}s (quirk Q19 mitigation — see "
                    f"wait_for_first_poll_cycle's docstring).\n"
                    f"--- last {_RUNNER_LOG_TAIL_LINES} lines of "
                    f"{log_path if log_path is not None else '(no runner log)'} ---\n"
                    f"{_tail_lines(log_path)}"
                )
        manifest["startup_gate"]["envs"] = gate_envs_report

    prev_mod_time_ms: int | None = None
    for i, (prev, cut) in enumerate(slices):
        n_inserted = insert_fn(conn, dataset, prev, cut, zid)
        cut_time_ms = dataset.votes[cut - 1].t_ms
        n_mod_applied = mod_insert_fn(conn, dataset, prev_mod_time_ms, cut_time_ms, zid)
        prev_mod_time_ms = cut_time_ms
        expected_votes = expected_cumulative_vote_count(dataset, cut)

        batch_record: dict[str, Any] = {
            "index": i,
            "prev_slot": prev,
            "cut_slot": cut,
            "n_inserted": n_inserted,
            "n_mod_events_applied": n_mod_applied,
            "cut_time_ms": cut_time_ms,
            "expected_vote_count": expected_votes,
            "envs": {},
        }
        for env in math_envs:
            predicate = make_batch_ready_predicate(
                min_last_vote_ts=cut_time_ms, min_vote_count=expected_votes,
            )
            row = wait_for_tick(
                conn, env, zid, predicate, wait_timeout,
                poll_interval=poll_interval, sleep=sleep, now=now,
            )
            if row is None:
                last_row = fetch_math_row(conn, "math_main", zid, env)
                last_state = _describe_math_main_row(last_row)
                batch_record["envs"][env] = {
                    "ready": False, "timeout_s": wait_timeout, "last_state": last_state,
                }
                # Persist whatever we have BEFORE raising — a fail-fast abort
                # must still leave a post-mortem-able manifest on disk (spec's
                # "keep the DB alive... for post-mortem" intent, extended to
                # the manifest the comparer reads).
                manifest["batches"].append(batch_record)
                write_manifest(out_dir, manifest)

                runner = runners.get(env)
                log_path = getattr(runner, "log_path", None)
                raise PollerEquivStreamError(
                    f"poller-equiv feeder ABORT: env={env!r} batch={i} "
                    f"(prev_slot={prev}, cut_slot={cut}) never became ready within "
                    f"{wait_timeout}s (expected_vote_count={expected_votes}, "
                    f"cut_time_ms={cut_time_ms}).\n"
                    f"Last observed math_main state for {env!r}: {last_state}\n"
                    f"--- last {_RUNNER_LOG_TAIL_LINES} lines of "
                    f"{log_path if log_path is not None else '(no runner log)'} ---\n"
                    f"{_tail_lines(log_path)}"
                )

            write_snapshot(out_dir, env, i, "math_main", row)
            snap_ok = {"math_main": True}
            for table in ("math_bidtopid", "math_ptptstats"):
                trow = fetch_math_row(conn, table, zid, env)
                if trow is not None:
                    write_snapshot(out_dir, env, i, table, trow)
                snap_ok[table] = trow is not None
            batch_record["envs"][env] = {"ready": True, "snapshots": snap_ok}

        manifest["batches"].append(batch_record)

        if seam_after is not None and i == seam_after:
            for env in (restart_envs_at_seam or ()):
                runner = runners.get(env)
                if runner is not None:
                    runner.kill()
                if restart_builders and env in restart_builders:
                    new_runner = restart_builders[env]()
                    new_runner.start()
                    runners[env] = new_runner

    write_manifest(out_dir, manifest)
    return manifest


def run_equiv_stream(
    admin_url: str,
    dataset_slug: str,
    cuts: Sequence[int],
    *,
    out_dir: str | Path,
    seam_after: int | None = None,
    math_envs: tuple[str, str] = ("clj-ref", "py-shadow"),
    restart_clj_at_seam: bool = False,
    dbname: str = DEFAULT_DBNAME,
    zid: int = DEFAULT_ZID,
    poll_from_days_ago: float = 10000,
    engine_mode: str = ENGINE_MODE_LEGACY,
    wait_timeout: float = 120.0,
    poll_interval: float = 0.5,
    engine_factory: Callable[[str], Any] | None = None,
    runner_builders: dict[str, Callable[[], Any]] | None = None,
    sleep: Callable[[float], None] = time.sleep,
    now: Callable[[], float] = time.monotonic,
    wait_for_clj_poll_cycle: bool = True,
    poll_cycle_gate_timeout: float = 60.0,
) -> dict[str, Any]:
    """Stage C top-level orchestration SKELETON (spec §1 "feed"/"seam"
    bullets): seed the throwaway DB, start both runners, then delegate every
    per-batch decision to :func:`run_batch_loop`.

    ``wait_for_clj_poll_cycle`` (session 2, 2026-07-24, default True) wires
    :func:`run_batch_loop`'s ``startup_gate_envs`` to ``[clj_env]`` — quirk
    Q19's harness-level mitigation, see that function's docstring.

    ``math_envs`` is ``(clj_env_name, py_env_name)`` — the CLJ env is always
    first, matching the spec's own default ``("clj-ref", "py-shadow")``; this
    is a documented positional convention, not inferred from the strings.
    ``restart_clj_at_seam`` mirrors the spec's "optionally the clj runner —
    parameter" bullet: the PY runner is ALWAYS restarted at the seam, the clj
    one only when this is set.

    ``runner_builders`` lets a test (or an alternate invocation) replace
    ``{"clj": ..., "py": ...}`` runner factories wholesale — the DEFAULT
    builders construct the real :class:`CljContainerRunner` /
    :class:`PyPollerRunner` subprocess wrappers. ``engine_factory`` defaults
    to ``sqlalchemy.create_engine`` — override with a fake in tests that
    never touch a real Postgres.

    NOT exercised by the default test suite (needs a real Postgres AND real
    ``clojure``/``uv run python`` subprocesses running for the duration of the
    stream). Every decision this function makes is either delegated to
    :func:`run_batch_loop` (itself fully unit-tested with fakes) or is thin
    setup/teardown glue around it.
    """
    clj_env, py_env = math_envs
    ds = real_data.load_export_votes(dataset_slug)

    target_url = create_equiv_db(admin_url, dbname=dbname)
    engine = (engine_factory or (lambda url: sa.create_engine(url, isolation_level="AUTOCOMMIT")))(
        target_url
    )

    # REQUIRED FIX #3 (2026-07-24 live-debug task) "RUNNER EVIDENCE": each
    # runner's stdout+stderr land in <out_dir>/<env>.runner.log — append mode
    # (see :class:`_SubprocessRunner`) means a seam restart's post-restart
    # output lands in the SAME file as its pre-restart run, so the whole
    # process lifetime is one file. compare_snapshots()'s consumers /
    # PollerEquivStreamError's message both read this back.
    out_dir_path = Path(out_dir)
    default_builders: dict[str, Callable[[], Any]] = {
        "clj": lambda: CljContainerRunner(
            database_url=target_url, math_env=clj_env, poll_from_days_ago=poll_from_days_ago,
            log_path=out_dir_path / f"{clj_env}.runner.log",
        ),
        "py": lambda: PyPollerRunner(
            database_url=target_url, math_env=py_env, poll_from_days_ago=poll_from_days_ago,
            engine_mode=engine_mode, log_path=out_dir_path / f"{py_env}.runner.log",
        ),
    }
    builders = dict(default_builders)
    if runner_builders:
        builders.update(runner_builders)

    runners: dict[str, Any] = {}
    try:
        with engine.connect() as seed_conn:
            seed_conversation(seed_conn, ds, zid=zid)

        runners = {clj_env: builders["clj"](), py_env: builders["py"]()}
        for r in runners.values():
            r.start()

        restart_envs = [py_env] + ([clj_env] if restart_clj_at_seam else [])
        restart_builders = {py_env: builders["py"]}
        if restart_clj_at_seam:
            restart_builders[clj_env] = builders["clj"]

        with engine.connect() as conn:
            manifest = run_batch_loop(
                conn, ds, cuts, [clj_env, py_env], runners, out_dir=out_dir, zid=zid,
                seam_after=seam_after, restart_envs_at_seam=restart_envs,
                restart_builders=restart_builders, wait_timeout=wait_timeout,
                poll_interval=poll_interval, sleep=sleep, now=now,
                startup_gate_envs=[clj_env] if wait_for_clj_poll_cycle else None,
                startup_gate_timeout=poll_cycle_gate_timeout,
            )
    finally:
        for r in runners.values():
            r.kill()
        engine.dispose()

    return manifest


# ---------------------------------------------------------------------------
# Comparer (spec §1 "compare" bullet).
# ---------------------------------------------------------------------------
def strictly_increasing(values: Sequence[Any]) -> dict[str, Any]:
    """Pure monotonicity check for a per-batch ``caching_tick`` / ``math_tick``
    sequence (spec §1 compare bullets: "caching_tick strictly increasing per
    env" / "math_ticks == number of completed recomputes per env").

    The feeder gates each batch's insert on the PREVIOUS batch's readiness
    (:func:`run_batch_loop`), so every observed tick is credited to exactly
    one batch by construction — a strictly-increasing per-batch sequence is
    the observable signature of "every batch got exactly one recompute; none
    were skipped, none were silently merged away". ``None`` entries (a
    missing snapshot) always count as a violation, never silently skipped.
    """
    violations: list[dict[str, Any]] = []
    for i in range(1, len(values)):
        a, b = values[i - 1], values[i]
        if a is None or b is None or not (b > a):
            violations.append({"index": i, "prev": a, "next": b})
    return {
        "values": list(values),
        "strictly_increasing": len(violations) == 0,
        "violations": violations,
    }


def _normalize_bidtopid(data: dict[str, Any]) -> dict[str, Any]:
    """Normalize the ONE documented cross-engine representational difference
    before an EXACT equality check: Python pids are strings, Clojure pids are
    ints (``polismath/poller/__init__.py``'s "bidToPid shape" docstring /
    ``math_writer.py:49-53`` — the TS server ``parseInt()``s them either way,
    so this is harmless). Casts every member pid to ``str`` and SORTS each
    group (membership is a set, not an ordered list). The outer bid ORDER
    (i.e. base-cluster id order) is left untouched — that ordering IS
    meaningful, positionally aligned to ``math_main.base-clusters.id``
    (``derive_bidtopid``'s docstring)."""
    d = dict(data)
    bid = d.get("bidToPid")
    if isinstance(bid, list):
        d["bidToPid"] = [
            sorted(str(pid) for pid in group) if isinstance(group, list) else group
            for group in bid
        ]
    return d


def compare_bidtopid(a: dict[str, Any], b: dict[str, Any]) -> dict[str, Any]:
    """EXACT equality (spec §1 "compare" bullet: "math_bidtopid.data → EXACT
    equality") modulo the pid int/str normalization above."""
    na, nb = _normalize_bidtopid(a), _normalize_bidtopid(b)
    return {"match": na == nb, "a": na, "b": nb}


def _ptptstats_comparer(**kwargs: Any) -> StepComparer:
    """``math_ptptstats.data`` = ``{"zid", "ptptstats", "lastVoteTimestamp"}``
    (``math_writer.py`` ``derive_ptptstats``) — a flat ENVELOPE both engines
    emit directly, with no kebab/snake key mismatch to project away at the
    envelope level (unlike math_main) — so a plain :class:`StepComparer`
    compares the envelope correctly as-is, no acceptance-projection needed.

    CORRECTION (2026-07-24, live evidence — poller-equivalence harness full
    vw run, real_data/.local/replays/poller_equiv/vw/main/): this docstring
    used to ALSO claim ``ptptstats``' inner VALUE was "a flat envelope both
    engines emit directly" with no shape difference — that was FALSE and is
    the OPPOSITE of "no kebab/snake key mismatch to project away": the live
    clj-ref row's ``ptptstats`` was a COLUMNAR dict (``{pid: [...], gid:
    [...], n-votes: [...], centricness: [...], coreness: [...], extremeness:
    [...]}``, math/repness.clj:383-413's shape via conv_man.clj's
    ``columnize``) while the pre-fix py-shadow row was an entirely different,
    ROW-wise, vote-correlation-based structure (``Conversation.
    participant_info`` — n_agree/n_disagree/n_pass/group_correlations, a
    Python-only statistic, not a shape variant of Clojure's). Fixed at the
    SOURCE (``derive_ptptstats``/``math_writer.py`` now computes the same
    geometric centricness/coreness/extremeness Clojure does, columnized
    identically) rather than here — a comparer-side shape reconciliation
    would have papered over a real py-poller correctness bug (production
    consumers read the clj shape). This comparer needs no shape-projection
    logic itself; it's a plain structural+tolerant compare same as any other
    table, now that both sides actually agree on what they're emitting.

    Widens the tolerant-stat-key set with ``"ptptstats"`` purely for
    REPORTING (so its nested per-pid float divergences classify as
    'tolerant' rather than 'exact' in the verdict) — the underlying
    ``ConversationComparer`` already applies numeric tolerance to every float
    leaf regardless of this label (stepcompare.py:19-23), so this does not
    change pass/fail, only how a failure is described. Structural + tolerant
    per spec §1's math_ptptstats bullet.

    ``**kwargs`` forwards to :class:`StepComparer` (e.g. Stage D's
    :func:`_zero_tolerance_comparer` overrides ``abs_tolerance``/
    ``rel_tolerance``/``outlier_fraction`` to measure self-jitter) — every
    existing no-arg call site is unaffected (same default as before)."""
    return StepComparer(tolerant_stat_keys=DEFAULT_TOLERANT_STAT_KEYS | {"ptptstats"}, **kwargs)


def compare_batch(
    out_dir: str | Path,
    batch_index: int,
    math_envs: tuple[str, str],
    *,
    math_main_comparer: StepComparer | None = None,
    ptptstats_comparer: StepComparer | None = None,
    envelope: dict[str, float] | None = None,
) -> dict[str, Any]:
    """Per-batch, per-table verdict (spec §1 "compare" bullet). Reads ONLY
    from disk (the snapshots + manifest :func:`run_batch_loop` wrote) — no DB,
    no subprocess; fully exercisable against canned snapshot fixtures.

    ``math_main`` uses the SAME acceptance surface as certify: subgroup-*
    excluded per Q7, structural identity + declared float tolerances
    (``certify.py:100-113`` ``project_acceptance``, ``:115-126``
    ``_acceptance_projecting_comparer`` — the very function imported and used
    here). We deliberately skip certify's hash-first cache
    (``certify.py:609-664`` ``compare_recording_pair``) — that's a
    performance optimization for batteries with many (dataset, schedule)
    pairs; irrelevant at this scale (one comparer call per batch, run once).

    ``math_bidtopid`` is EXACT (:func:`compare_bidtopid`). ``math_ptptstats``
    is structural + tolerant (:func:`_ptptstats_comparer`). The math_main
    table additionally carries a ``watermark`` verdict: both envs'
    :func:`blob_total_votes` must equal this batch's manifest-recorded
    ``expected_vote_count`` EXACTLY (spec: "no double-processing") — read
    from :func:`load_manifest` rather than re-deriving from the dataset, so
    the comparer never needs the dataset/CSV at hand, only the store.

    ``envelope`` (Stage D item 2, spec §2) is an OPTIONAL ``{path_pattern:
    max_delta}`` mapping (:func:`compute_self_jitter_envelope`'s output). When
    given, float ("tolerant"-family) divergences on ``math_main``/
    ``math_ptptstats`` within :func:`envelope_threshold` are reclassified into
    a THIRD family, ``within_envelope`` — accepted for ``match`` but NEVER
    silently dropped (``n_within_envelope`` is always reported alongside
    ``n_divergences``, see :func:`_apply_envelope_to_step`). Structural
    ("exact"-family) divergences are NEVER excused, envelope or not.
    ``envelope=None`` (the default) leaves ``math_main``/``math_ptptstats``
    verdicts BYTE-IDENTICAL to the pre-Stage-D shape — no ``within_envelope``
    family, no ``n_within_envelope`` key. ``math_bidtopid`` is pure-int EXACT
    equality (no float leaves) and is never envelope-adjusted.
    """
    env_a, env_b = math_envs
    tables: dict[str, Any] = {}
    watermark: dict[str, Any] | None = None

    main_a = load_snapshot(out_dir, env_a, batch_index, "math_main")
    main_b = load_snapshot(out_dir, env_b, batch_index, "math_main")
    if main_a is None or main_b is None:
        tables["math_main"] = {
            "match": False,
            "reason": "missing-snapshot",
            "missing": [e for e, r in ((env_a, main_a), (env_b, main_b)) if r is None],
        }
    else:
        cmp = math_main_comparer or _acceptance_projecting_comparer()
        step = _apply_envelope_to_step(
            cmp.compare_step(main_a["data"], main_b["data"], batch_index), envelope, "math_main",
        )
        tables["math_main"] = {
            "match": step["match"],
            "n_divergences": step["n_divergences"],
            "families": step["families"],
        }
        if envelope is not None:
            tables["math_main"]["n_within_envelope"] = step.get("n_within_envelope", 0)
        manifest = load_manifest(out_dir)
        expected = None
        if manifest is not None and batch_index < len(manifest.get("batches", [])):
            expected = manifest["batches"][batch_index].get("expected_vote_count")
        obs_a = blob_total_votes(main_a["data"])
        obs_b = blob_total_votes(main_b["data"])
        watermark = {
            "expected": expected,
            env_a: obs_a,
            env_b: obs_b,
            "ok": expected is not None and obs_a == expected and obs_b == expected,
        }

    bid_a = load_snapshot(out_dir, env_a, batch_index, "math_bidtopid")
    bid_b = load_snapshot(out_dir, env_b, batch_index, "math_bidtopid")
    if bid_a is None or bid_b is None:
        tables["math_bidtopid"] = {
            "match": False,
            "reason": "missing-snapshot",
            "missing": [e for e, r in ((env_a, bid_a), (env_b, bid_b)) if r is None],
        }
    else:
        tables["math_bidtopid"] = compare_bidtopid(bid_a["data"], bid_b["data"])

    pt_a = load_snapshot(out_dir, env_a, batch_index, "math_ptptstats")
    pt_b = load_snapshot(out_dir, env_b, batch_index, "math_ptptstats")
    if pt_a is None or pt_b is None:
        tables["math_ptptstats"] = {
            "match": False,
            "reason": "missing-snapshot",
            "missing": [e for e, r in ((env_a, pt_a), (env_b, pt_b)) if r is None],
        }
    else:
        cmp2 = ptptstats_comparer or _ptptstats_comparer()
        step2 = _apply_envelope_to_step(
            cmp2.compare_step(pt_a["data"], pt_b["data"], batch_index), envelope, "math_ptptstats",
        )
        tables["math_ptptstats"] = {
            "match": step2["match"],
            "n_divergences": step2["n_divergences"],
            "families": step2["families"],
        }
        if envelope is not None:
            tables["math_ptptstats"]["n_within_envelope"] = step2.get("n_within_envelope", 0)

    result: dict[str, Any] = {"batch": batch_index, "tables": tables}
    if watermark is not None:
        result["watermark"] = watermark
    return result


def check_batch_coverage(out_dir: str | Path, math_envs: Sequence[str]) -> dict[str, Any]:
    """NO-COVERAGE GUARD (REQUIRED FIX #1, 2026-07-24 live-debug task): "a
    vacuous pass must be structurally impossible". Reads the feeder's
    ``manifest.json`` (if present, via :func:`load_manifest`) for any batch
    EXPLICITLY marked ``ready: false`` for one of ``math_envs`` — the shape
    :func:`run_batch_loop` writes both on a clean batch AND (since the
    fail-fast fix) into the partial manifest it persists right before
    raising :class:`PollerEquivStreamError`. Independently checks each env's
    on-disk snapshot store isn't completely empty
    (:func:`discover_batches`).

    A batch record that simply has NO ``envs`` entry at all for a given env
    (older/canned-fixture manifests that never tracked per-env readiness) is
    NOT penalized here — only an EXPLICIT ``ready: False`` counts as a
    coverage failure. This keeps the guard additive: it catches the real,
    observed failure mode (a manifest that HONESTLY records "this batch
    never became ready") without requiring every historical/fixture
    manifest to carry readiness bookkeeping it was never asked for.

    Reads ONLY from disk — no DB, no subprocess.
    """
    out_dir = Path(out_dir)
    manifest = load_manifest(out_dir)
    not_ready: list[dict[str, Any]] = []
    n_manifest_batches = 0
    if manifest is not None:
        batches = manifest.get("batches", [])
        n_manifest_batches = len(batches)
        for b in batches:
            envs_info = b.get("envs") or {}
            for env in math_envs:
                info = envs_info.get(env)
                if info is not None and info.get("ready") is False:
                    not_ready.append({"batch": b.get("index"), "env": env})
    empty_stores = [env for env in math_envs if not discover_batches(out_dir, env)]
    return {
        "manifest_present": manifest is not None,
        "n_manifest_batches": n_manifest_batches,
        "not_ready": not_ready,
        "empty_stores": empty_stores,
        "ok": not not_ready and not empty_stores,
    }


def compare_snapshots(
    out_dir: str | Path,
    *,
    math_envs: tuple[str, str] = ("clj-ref", "py-shadow"),
    math_main_comparer: StepComparer | None = None,
    ptptstats_comparer: StepComparer | None = None,
    envelope: dict[str, float] | None = None,
    expected_batches: int | None = None,
) -> dict[str, Any]:
    """Top-level comparer (spec §1 "compare" bullet + Stage C item 2):
    per-batch table verdicts (:func:`compare_batch`) plus the CROSS-batch
    tick-monotonicity checks (:func:`strictly_increasing` over each env's
    ``caching_tick`` / ``math_tick`` sequence, read from its math_main
    snapshots).

    Batches present in only ONE env's store are reported (``batches_only_in``)
    but never silently dropped from that visibility — only the ALIGNED
    (present-in-both) batches are compared table-by-table, since a solo batch
    has no partner to diff against.

    ``envelope`` (Stage D item 2) is forwarded unchanged to every
    :func:`compare_batch` call. ``envelope=None`` (the default) returns a
    report BYTE-IDENTICAL to the pre-Stage-D shape (no extra keys); passing an
    envelope adds ``envelope_applied``/``n_within_envelope_total`` so the
    within-envelope acceptance is always visible in the verdict JSON, never
    silent.
    """
    out_dir = Path(out_dir)
    env_a, env_b = math_envs
    batches_a = discover_batches(out_dir, env_a)
    batches_b = discover_batches(out_dir, env_b)
    aligned = sorted(set(batches_a) & set(batches_b))
    only_a = sorted(set(batches_a) - set(batches_b))
    only_b = sorted(set(batches_b) - set(batches_a))

    per_batch = [
        compare_batch(
            out_dir, i, math_envs,
            math_main_comparer=math_main_comparer, ptptstats_comparer=ptptstats_comparer,
            envelope=envelope,
        )
        for i in aligned
    ]

    tick_series: dict[str, dict[str, list[Any]]] = {
        env: {"caching_tick": [], "math_tick": []} for env in math_envs
    }
    for i in aligned:
        for env in math_envs:
            row = load_snapshot(out_dir, env, i, "math_main")
            tick_series[env]["caching_tick"].append(row.get("caching_tick") if row else None)
            tick_series[env]["math_tick"].append(row.get("math_tick") if row else None)

    ticks = {
        env: {
            "caching_tick": strictly_increasing(tick_series[env]["caching_tick"]),
            "math_tick": strictly_increasing(tick_series[env]["math_tick"]),
        }
        for env in math_envs
    }

    tables_ok = all(
        all(t.get("match", False) for t in b["tables"].values()) for b in per_batch
    )
    watermarks_ok = all(b.get("watermark", {}).get("ok", True) for b in per_batch)
    ticks_ok = all(
        tr["caching_tick"]["strictly_increasing"] and tr["math_tick"]["strictly_increasing"]
        for tr in ticks.values()
    )
    coverage = check_batch_coverage(out_dir, math_envs)
    # NO-COVERAGE GUARD (spec: "a vacuous pass must be structurally
    # impossible") — ``len(aligned) > 0`` is checked EXPLICITLY, not merely
    # inferred from ``coverage["ok"]``: a manifest that never tracked
    # per-env readiness at all (coverage-neutral by design, see
    # :func:`check_batch_coverage`) must still not let a zero-aligned-batch
    # comparison report MATCH via the vacuous ``all([])`` behavior above.
    # COMPLETENESS GUARD (#2657 review finding 2, 2026-07-24): non-zero is
    # not enough — a feeder killed cleanly BETWEEN batches (outside the
    # fail-fast paths that write ready:false) leaves later batches simply
    # ABSENT, which the readiness coverage cannot see. When the caller
    # knows the PLANNED batch count, aligned must equal it exactly.
    complete = expected_batches is None or len(aligned) == expected_batches
    overall_match = (
        len(aligned) > 0 and not only_a and not only_b and complete
        and tables_ok and watermarks_ok and ticks_ok and coverage["ok"]
    )

    report: dict[str, Any] = {
        "out_dir": str(out_dir),
        "math_envs": list(math_envs),
        "n_batches_aligned": len(aligned),
        "batches_only_in": {env_a: only_a, env_b: only_b},
        "per_batch": per_batch,
        "ticks": ticks,
        "coverage": coverage,
        "overall_match": overall_match,
    }
    if envelope is not None:
        report["envelope_applied"] = True
        report["n_within_envelope_total"] = sum(
            b["tables"].get(t, {}).get("n_within_envelope", 0)
            for b in per_batch
            for t in ("math_main", "math_ptptstats")
        )
    if expected_batches is not None:
        # Same only-when-provided convention as ``envelope``: default calls
        # keep the pre-existing report shape byte-identical.
        report["expected_batches"] = expected_batches
    return report


def write_compare_verdict(report: dict[str, Any], out_dir: str | Path) -> Path:
    """Persist :func:`compare_snapshots`'s report to
    ``<out_dir>/compare_verdict.json`` (mirrors certify's
    ``<root>/certify_report.json`` convention, certify.py:824)."""
    path = Path(out_dir) / "compare_verdict.json"
    with open(path, "w") as fh:
        json.dump(report, fh, indent=2, sort_keys=True, default=str)
    return path


def compare_exit_code(report: dict[str, Any]) -> int:
    return 0 if report["overall_match"] else 1


def render_compare_lines(report: dict[str, Any], *, max_lines: int = 40) -> list[str]:
    """Render :func:`compare_snapshots`'s report to ≤``max_lines`` stdout
    lines — certify's terse-output convention (certify.py:872-886
    ``render_run_lines``): a header, one line per aligned batch (truncated
    with a '+N more' line if the run is too large to fit), and a footer
    with the overall verdict + per-env tick-monotonicity status.

    When ``report`` carries ``envelope_applied`` (Stage D item 2 —
    :func:`compare_snapshots` called WITH an envelope), one extra trailing
    line reports the total within-envelope-accepted count — REPORTED, never
    silent, per spec §2 item 2. Reports without that key (the default,
    envelope-less path) get no such line, keeping the ≤40-line footer
    unchanged from before Stage D.
    """
    header = [
        f"poller-equiv compare: {report['n_batches_aligned']} aligned batches  "
        f"envs={report['math_envs']}",
    ]
    only_in = report["batches_only_in"]
    if any(only_in.values()):
        header.append(f"  ! batches only in one env: {only_in}")

    coverage = report.get("coverage")
    if coverage is not None and not coverage.get("ok", True):
        header.append(
            f"  ! COVERAGE GUARD FAILED: not_ready={coverage.get('not_ready')} "
            f"empty_stores={coverage.get('empty_stores')} "
            f"manifest_present={coverage.get('manifest_present')}"
        )

    tick_bits = []
    for env, tr in report["ticks"].items():
        ok = tr["caching_tick"]["strictly_increasing"] and tr["math_tick"]["strictly_increasing"]
        tick_bits.append(f"{env}:ticks_ok={ok}")
    footer = [
        f"verdict: {'MATCH' if report['overall_match'] else 'DIVERGENCE'}  "
        + "  ".join(tick_bits)
    ]
    if report.get("envelope_applied"):
        footer.append(
            f"  envelope: {report.get('n_within_envelope_total', 0)} divergence(s) "
            "accepted within self-jitter envelope"
        )

    budget = max(max_lines - len(header) - len(footer), 0)
    body = []
    for b in report["per_batch"]:
        bad = [t for t, v in b["tables"].items() if not v.get("match", False)]
        wm = b.get("watermark", {})
        wm_flag = "" if wm.get("ok", True) else "  WATERMARK-MISMATCH"
        if bad or wm_flag:
            body.append(f"  batch {b['batch']}: FAIL tables={bad}{wm_flag}")
        else:
            body.append(f"  batch {b['batch']}: MATCH")

    if len(body) > budget:
        shown = body[: max(budget - 1, 0)]
        body = shown + [f"  … +{len(body) - len(shown)} more batches — see compare_verdict.json"]

    return header + body + footer


# =============================================================================
# Stage D — self-jitter envelope + full-run orchestration.
# =============================================================================
# The clj container's cold-tick PCA start is unseeded-random in production
# (MATH_POLLER_EQUIV_SPEC.md §2 — no Clojure source edits allowed, so this
# harness can never Q10/Q12-pin it away). Two independent clj runs on the
# SAME vote stream therefore differ in their float tails even with zero code
# changes; the "envelope" is the measured size of that self-jitter, per
# structural location, so Stage C's comparer can tell "py disagrees with clj"
# apart from "clj disagrees with itself".
_ENVELOPE_FLOOR = 1e-9
_ENVELOPE_SAFETY_FACTOR = 2.0
# math_bidtopid is pure-int bid->pid membership (compare_bidtopid, EXACT
# equality) — no float leaf exists to jitter, so it is never walked here.
_ENVELOPE_TABLES: tuple[str, ...] = ("math_main", "math_ptptstats")


def _safe_abs_delta(a: Any, b: Any) -> float | None:
    """``abs(float(a) - float(b))``, or ``None`` when either side isn't
    coercible to float (defensive — a "Numeric mismatch"-reasoned diff's
    ``a``/``b`` are always floats in practice, but this never raises into a
    caller's loop over many diffs)."""
    try:
        return abs(float(a) - float(b))
    except (TypeError, ValueError):
        return None


def _zero_tolerance_comparer(table: str) -> StepComparer:
    """The SAME comparer factory Stage C's :func:`compare_batch` uses for
    ``table`` (:func:`_acceptance_projecting_comparer` for math_main —
    acceptance-projected, prep-main-keyed; :func:`_ptptstats_comparer` for
    math_ptptstats — the flat envelope, no projection needed), but with
    EVERY tolerance floor forced to zero. ``ConversationComparer`` only
    records a "Numeric mismatch" divergence when ``np.allclose(..., rtol=0,
    atol=0)`` is False (comparer.py:856) — i.e. when the two floats are NOT
    bit-identical — so this configuration surfaces every non-zero cross-run
    delta, however small, as a measurable divergence entry. This is for
    self-jitter MEASUREMENT only (:func:`compute_self_jitter_envelope`);
    never used for pass/fail acceptance."""
    kwargs = {"abs_tolerance": 0.0, "rel_tolerance": 0.0, "outlier_fraction": 0.0}
    if table == "math_main":
        return _acceptance_projecting_comparer(**kwargs)
    if table == "math_ptptstats":
        return _ptptstats_comparer(**kwargs)
    raise ValueError(f"no zero-tolerance comparer for table {table!r}; expected one of {_ENVELOPE_TABLES}")


def envelope_path_key(table: str, raw_path: str) -> str:
    """``{table}.{normalized-path}`` — the envelope's lookup key.

    ``raw_path`` is normalized with certify's OWN fingerprint normalizer
    (:func:`polismath.replay.certify.normalize_path`, imported — never
    reimplemented, per the task's explicit instruction): strips the
    ``step_N.`` prefix, collapses ``[idx]`` -> ``[]``, and collapses
    purely-numeric dotted segments -> ``N``, so the SAME structural location
    at a different batch/list-index/dict-key collapses to one key — exactly
    the alignment :func:`compare_batch`'s per-batch divergence paths need to
    match against when doing envelope-aware acceptance. Table-prefixed so
    math_main and math_ptptstats can never collide even if a leaf name is
    ever shared between them.
    """
    return f"{table}.{normalize_path(raw_path)}"


def compute_self_jitter_envelope(
    out_dir_run1: str | Path,
    out_dir_run2: str | Path,
    *,
    math_env: str = "clj-ref",
    tables: Sequence[str] = _ENVELOPE_TABLES,
) -> dict[str, Any]:
    """Per-``path_pattern`` max absolute float-leaf delta between TWO
    independent clj-ref snapshot stores of the SAME stream (spec §2 item 1 /
    Stage D item 1: "clj self-jitter envelope first").

    Walks the IDENTICAL acceptance-projected surface Stage C's
    :func:`compare_batch` compares — :func:`_zero_tolerance_comparer` reuses
    the exact same comparer factories (:func:`_acceptance_projecting_comparer`
    / :func:`_ptptstats_comparer`), only with every tolerance forced to zero
    so EVERY cross-run delta (not just ones beyond the default 1e-6/1%
    tolerance) is captured, however small. Only ``"Numeric mismatch"``
    -reasoned leaves feed the envelope; any OTHER divergence reason (Integer/
    String/Value/Length/Key/Type mismatch — the two clj runs disagreeing
    STRUCTURALLY, which would be a harness bug, not jitter) is reported
    separately in ``structural_divergences`` — never silently folded into a
    numeric envelope.

    Batches present in only one store (``batches_only_in``) or a missing
    per-(batch, table) snapshot pair (``missing_snapshots``) are reported but
    simply skipped for that slice — a partial self-jitter run still yields a
    usable (partial) envelope for whichever (batch, table) pairs DID land on
    both sides.

    Reads ONLY from disk — no DB, no subprocess; identical inputs (two stores
    with byte-identical data) yield an EMPTY ``envelope`` mapping (no
    "Numeric mismatch" is ever recorded for equal floats — ``np.allclose``
    with ``rtol=atol=0`` is true iff the floats are bit-identical), the
    "all-zero" case — callers must read a missing key via
    :func:`envelope_threshold` (which defaults to the floor), never assume a
    present-but-zero entry.
    """
    out_dir_run1, out_dir_run2 = Path(out_dir_run1), Path(out_dir_run2)
    batches1 = discover_batches(out_dir_run1, math_env)
    batches2 = discover_batches(out_dir_run2, math_env)
    aligned = sorted(set(batches1) & set(batches2))
    only1 = sorted(set(batches1) - set(batches2))
    only2 = sorted(set(batches2) - set(batches1))

    comparers = {t: _zero_tolerance_comparer(t) for t in tables}
    envelope: dict[str, float] = {}
    n_leaf_diffs = 0
    structural_divergences: list[dict[str, Any]] = []
    per_batch_table_diff_counts: dict[str, int] = {}
    missing_snapshots: list[dict[str, Any]] = []

    for i in aligned:
        for table in tables:
            row1 = load_snapshot(out_dir_run1, math_env, i, table)
            row2 = load_snapshot(out_dir_run2, math_env, i, table)
            if row1 is None or row2 is None:
                missing_snapshots.append({
                    "batch": i, "table": table,
                    "missing_in": [name for name, row in (("run1", row1), ("run2", row2)) if row is None],
                })
                continue

            step = comparers[table].compare_step(row1["data"], row2["data"], i)
            count_this = 0
            for family in ("exact", "tolerant"):
                for d in step["families"][family]:
                    reason = d.get("reason") or ""
                    if not reason.startswith("Numeric mismatch"):
                        # 'exact'-family here means a NON-numeric structural
                        # disagreement between the two clj runs (e.g. an
                        # Integer/Value/Length/Key mismatch) — real, but not
                        # jitter; surfaced separately, never silently dropped.
                        structural_divergences.append({
                            "batch": i, "table": table, "path": d.get("path"), "reason": reason,
                        })
                        continue
                    delta = _safe_abs_delta(d.get("a"), d.get("b"))
                    if delta is None:
                        continue
                    key = envelope_path_key(table, d.get("path") or "")
                    envelope[key] = max(envelope.get(key, 0.0), delta)
                    count_this += 1
                    n_leaf_diffs += 1
            per_batch_table_diff_counts[f"batch-{i:03d}.{table}"] = count_this

    return {
        "math_env": math_env,
        "out_dir_run1": str(out_dir_run1),
        "out_dir_run2": str(out_dir_run2),
        "n_batches_aligned": len(aligned),
        "batches_only_in": {"run1": only1, "run2": only2},
        "missing_snapshots": missing_snapshots,
        "n_leaf_diffs": n_leaf_diffs,
        "per_batch_table_diff_counts": per_batch_table_diff_counts,
        "structural_divergences": structural_divergences,
        "envelope": dict(sorted(envelope.items())),
    }


def write_envelope(envelope_report: dict[str, Any], out_dir: str | Path) -> Path:
    """Persist :func:`compute_self_jitter_envelope`'s report to
    ``<out_dir>/self_jitter_envelope.json`` (mirrors :func:`write_compare_verdict`'s
    convention)."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "self_jitter_envelope.json"
    with open(path, "w") as fh:
        json.dump(envelope_report, fh, indent=2, sort_keys=True, default=str)
    return path


def load_envelope(out_dir: str | Path) -> dict[str, Any] | None:
    path = Path(out_dir) / "self_jitter_envelope.json"
    if not path.exists():
        return None
    return json.loads(path.read_text())


def envelope_threshold(envelope: dict[str, float] | None, key: str) -> float:
    """``max(envelope[key] * 2, 1e-9)`` — spec §2 item 2's acceptance formula
    (safety factor 2, floor 1e-9). ``envelope=None`` or a missing ``key``
    means "no observed self-jitter at this path" -> the threshold is just the
    floor, never zero (a genuinely bit-identical clj-vs-clj path still allows
    a hair of float noise before a py divergence counts as real)."""
    base = (envelope or {}).get(key, 0.0)
    return max(base * _ENVELOPE_SAFETY_FACTOR, _ENVELOPE_FLOOR)


def _apply_envelope_to_step(
    step: dict[str, Any], envelope: dict[str, float] | None, table: str,
) -> dict[str, Any]:
    """Reclassify ``step``'s (a :meth:`StepComparer.compare_step` result)
    'tolerant'-family divergences that fall within the self-jitter envelope
    into a THIRD family, ``within_envelope`` (spec §2 item 2 / Stage D item
    2). Accepted for ``match`` purposes but ALWAYS counted
    (``n_within_envelope``) — never silently dropped from the verdict.

    'exact'-family divergences (structural: memberships/cluster ids/
    selections/priority ordering — see ``stepcompare.py``'s family
    docstring) are NEVER touched: the envelope can only excuse a FLOAT
    jitter, never a structural mismatch (spec's explicit "structural
    divergences are NEVER excused by the envelope").

    ``envelope=None`` returns ``step`` COMPLETELY UNCHANGED (same dict,
    same keys: ``step``/``match``/``n_divergences``/``families``/
    ``sign_flips``) — :func:`compare_batch`'s "byte-identical when no
    envelope" contract relies on this exact pass-through.
    """
    if envelope is None:
        return step

    still_tolerant: list[dict[str, Any]] = []
    within_envelope: list[dict[str, Any]] = []
    for d in step["families"]["tolerant"]:
        reason = d.get("reason") or ""
        delta = _safe_abs_delta(d.get("a"), d.get("b")) if reason.startswith("Numeric mismatch") else None
        if delta is None:
            still_tolerant.append(d)
            continue
        key = envelope_path_key(table, d.get("path") or "")
        threshold = envelope_threshold(envelope, key)
        if delta <= threshold:
            within_envelope.append({**d, "envelope_key": key, "delta": delta, "threshold": threshold})
        else:
            still_tolerant.append(d)

    n_exact = len(step["families"]["exact"])
    match = n_exact == 0 and len(still_tolerant) == 0
    return {
        "step": step["step"],
        "match": match,
        "n_divergences": n_exact + len(still_tolerant),
        "n_within_envelope": len(within_envelope),
        "families": {
            "exact": step["families"]["exact"],
            "tolerant": still_tolerant,
            "within_envelope": within_envelope,
        },
        "sign_flips": step.get("sign_flips", []),
    }


# ---------------------------------------------------------------------------
# clj-only self-jitter stream — spec §2 item 1's "run the clj side TWICE".
# ---------------------------------------------------------------------------
def run_clj_only_stream(
    admin_url: str,
    dataset_slug: str,
    cuts: Sequence[int],
    *,
    out_dir: str | Path,
    dbname: str,
    math_env: str = "clj-ref",
    zid: int = DEFAULT_ZID,
    poll_from_days_ago: float = 10000,
    wait_timeout: float = 120.0,
    poll_interval: float = 0.5,
    engine_factory: Callable[[str], Any] | None = None,
    runner_builder: Callable[[], Any] | None = None,
    sleep: Callable[[float], None] = time.sleep,
    now: Callable[[], float] = time.monotonic,
    wait_for_clj_poll_cycle: bool = True,
    poll_cycle_gate_timeout: float = 60.0,
) -> dict[str, Any]:
    """Seed a FRESH throwaway DB and run ONLY the clj container against it —
    NO py runner at all (Stage D item 1 / spec §2 item 1: "run the clj side
    TWICE on the same stream, fresh DB each"). A thin single-env wrapper
    around the SAME :func:`run_batch_loop` Stage C already uses — no new
    feeder logic, ``math_envs``/``runners`` is just a one-entry list/dict.

    ``wait_for_clj_poll_cycle`` (session 2, 2026-07-24, default True) —
    quirk Q19's harness-level mitigation, same as :func:`run_equiv_stream`'s
    own parameter of the same name; see :func:`wait_for_first_poll_cycle`'s
    docstring for the full rationale.

    NOT exercised by the default test suite (needs a real Postgres AND a real
    ``clojure`` subprocess running for the duration of the stream) — mirrors
    :func:`run_equiv_stream`'s own "not exercised" note; every decision this
    function makes is delegated to :func:`run_batch_loop` (fully unit-tested
    with fakes) or is thin setup/teardown glue around it.
    """
    ds = real_data.load_export_votes(dataset_slug)
    target_url = create_equiv_db(admin_url, dbname=dbname)
    engine = (engine_factory or (lambda url: sa.create_engine(url, isolation_level="AUTOCOMMIT")))(
        target_url
    )

    build = runner_builder or (lambda: CljContainerRunner(
        database_url=target_url, math_env=math_env, poll_from_days_ago=poll_from_days_ago,
        log_path=Path(out_dir) / f"{math_env}.runner.log",
    ))

    runners: dict[str, Any] = {}
    try:
        with engine.connect() as seed_conn:
            seed_conversation(seed_conn, ds, zid=zid)

        runners = {math_env: build()}
        runners[math_env].start()

        with engine.connect() as conn:
            manifest = run_batch_loop(
                conn, ds, cuts, [math_env], runners, out_dir=out_dir, zid=zid,
                wait_timeout=wait_timeout, poll_interval=poll_interval, sleep=sleep, now=now,
                startup_gate_envs=[math_env] if wait_for_clj_poll_cycle else None,
                startup_gate_timeout=poll_cycle_gate_timeout,
            )
    finally:
        for r in runners.values():
            r.kill()
        engine.dispose()

    return manifest


# ---------------------------------------------------------------------------
# Full-run orchestration (spec §2/§3 stage D item 3) — pure verdict assembly
# split out from the live I/O glue, per the task's explicit testability ask.
# ---------------------------------------------------------------------------
def assemble_full_run_verdict(
    out_dir_run1: str | Path,
    out_dir_run2: str | Path,
    out_dir_main: str | Path,
    *,
    dataset: str = "",
    cuts: Sequence[int] = (),
    seam_after: int | None = None,
    clj_env: str = "clj-ref",
    py_env: str = "py-shadow",
) -> dict[str, Any]:
    """PURE decision logic (Stage D item 3: "its DECISION LOGIC ... must be a
    pure function unit-testable with canned snapshot dirs") for the full
    protocol's envelope-wiring + verdict assembly: given THREE already-
    populated snapshot stores — two independent clj-only self-jitter runs
    (:func:`run_clj_only_stream`'s output dirs) plus one paired clj+py
    restart-seam run (:func:`run_equiv_stream`'s output dir) — compute the
    self-jitter envelope, feed it into an envelope-aware
    :func:`compare_snapshots`, and assemble one verdict dict.

    Reads ONLY from disk (:func:`compute_self_jitter_envelope` and
    :func:`compare_snapshots` are themselves disk-only) — never touches a DB
    or a subprocess, so this is exercisable against canned/fixture snapshot
    directories with no live services, exactly like every other Stage C/D
    pure function in this module.
    """
    expected_batches = len(cuts) if cuts else None
    envelope_report = compute_self_jitter_envelope(out_dir_run1, out_dir_run2, math_env=clj_env)
    compare_report = compare_snapshots(
        out_dir_main, math_envs=(clj_env, py_env), envelope=envelope_report["envelope"],
        expected_batches=expected_batches,
    )
    # NO-COVERAGE GUARD (REQUIRED FIX #1, 2026-07-24 live-debug task) applied
    # to the self-jitter streams too — this is the SAME class of bug as the
    # "main" store's zero-aligned-batches guard, but on the envelope
    # measurement itself: an envelope computed from 0 aligned batches (both
    # clj-only runs empty) reports an all-zero "0 path(s) jittered" envelope
    # that reads exactly like a clean, IDENTICAL pair — reproduced verbatim
    # in the 2026-07-24 live run's terse summary. ``compare_snapshots``
    # already guards the "main" store; the self-jitter streams need the same
    # ``check_batch_coverage`` guard directly, since :func:`compute_self_jitter_envelope`
    # itself has no pass/fail concept (it's a pure measurement, by design).
    jitter1_coverage = check_batch_coverage(out_dir_run1, [clj_env])
    jitter2_coverage = check_batch_coverage(out_dir_run2, [clj_env])
    self_jitter_ok = (
        envelope_report["n_batches_aligned"] > 0
        and jitter1_coverage["ok"] and jitter2_coverage["ok"]
        # COMPLETENESS (#2657 review finding 2): a partial self-jitter
        # stream under-measures the envelope the same way a partial main
        # store under-compares — planned count must be met here too.
        and (expected_batches is None
             or envelope_report["n_batches_aligned"] == expected_batches)
    )
    return {
        "dataset": dataset,
        "cuts": list(cuts),
        "seam_after": seam_after,
        "clj_env": clj_env,
        "py_env": py_env,
        "out_dir_run1": str(out_dir_run1),
        "out_dir_run2": str(out_dir_run2),
        "out_dir_main": str(out_dir_main),
        "self_jitter_envelope": envelope_report,
        "self_jitter_coverage": {"run1": jitter1_coverage, "run2": jitter2_coverage},
        "compare": compare_report,
        "overall_pass": compare_report["overall_match"] and self_jitter_ok,
    }


def write_full_run_verdict(verdict: dict[str, Any], out_root: str | Path) -> Path:
    """Persist :func:`assemble_full_run_verdict`'s report to
    ``<out_root>/full_run_verdict.json`` (spec §2 item 3 / Stage D item
    3(e))."""
    out_root = Path(out_root)
    out_root.mkdir(parents=True, exist_ok=True)
    path = out_root / "full_run_verdict.json"
    with open(path, "w") as fh:
        json.dump(verdict, fh, indent=2, sort_keys=True, default=str)
    return path


def render_full_run_lines(verdict: dict[str, Any], *, max_lines: int = 40) -> list[str]:
    """≤``max_lines`` stdout summary (Stage D item 3(e): "overall PASS/FAIL +
    per-batch/table counts + the envelope's worst paths"). Delegates the
    per-batch/table portion to :func:`render_compare_lines` (already its own
    ≤N-line renderer) after reserving room for a PASS/FAIL header and the
    envelope's worst (largest-max-delta) paths — so the WHOLE full-run
    summary, not just the compare section, respects the line budget.
    """
    compare_report = verdict["compare"]
    envelope = verdict["self_jitter_envelope"]["envelope"]
    overall = "PASS" if verdict["overall_pass"] else "FAIL"

    header = [
        f"poller-equiv full-run: dataset={verdict.get('dataset', '?')} "
        f"seam_after={verdict.get('seam_after')}  verdict={overall}",
    ]

    worst = sorted(envelope.items(), key=lambda kv: kv[1], reverse=True)[:5]
    envelope_lines = [f"  self-jitter envelope: {len(envelope)} path(s) jittered; worst:"]
    if worst:
        envelope_lines += [f"    {path}: {delta:.3e}" for path, delta in worst]
    else:
        envelope_lines.append("    (none observed — identical self-jitter runs)")

    # NO-COVERAGE GUARD visibility (REQUIRED FIX #1): an empty/all-zero
    # envelope is AMBIGUOUS on its own — "identical self-jitter runs" reads
    # identically whether that's genuinely zero jitter OR zero batches ever
    # measured (the exact misleading text the 2026-07-24 live run printed).
    # This line disambiguates whenever self_jitter_coverage is present and
    # failed — never silent.
    jitter_coverage = verdict.get("self_jitter_coverage")
    if jitter_coverage is not None:
        bad_runs = [name for name, cov in jitter_coverage.items() if not cov.get("ok", True)]
        if bad_runs:
            envelope_lines.append(f"  ! SELF-JITTER COVERAGE FAILED: {bad_runs}")

    reserved = len(header) + len(envelope_lines)
    remaining = max(max_lines - reserved, 4)
    body = render_compare_lines(compare_report, max_lines=remaining)

    lines = header + envelope_lines + body
    if len(lines) > max_lines:
        lines = lines[: max_lines - 1] + ["  … output truncated — see full_run_verdict.json"]
    return lines


# ---------------------------------------------------------------------------
# Default schedule resolution (Stage D item 3: "cuts (default: vw at its
# uniform8 slots — read the actual slots from scripts/schedules or the
# certify battery)").
# ---------------------------------------------------------------------------
_VW_UNIFORM8_RESTART4_SCHEDULE = _DELPHI_ROOT / "scripts" / "schedules" / "vw-uniform8-restart4.json"


def default_full_run_schedule(dataset: str) -> tuple[list[int], int]:
    """Default ``(cuts, seam_after)`` for the ``full-run`` CLI when
    ``--cuts``/``--seam-after`` are not given explicitly.

    For ``vw`` this is read VERBATIM from the committed
    ``scripts/schedules/vw-uniform8-restart4.json`` — the SAME schedule file
    ``certify_battery.json``'s own restart-seam entry uses (its
    ``"dataset": "vw", "schedule": "schedules/vw-uniform8-restart4.json"``
    row): vw's uniform-8 cuts with the restart seam at step 4 (mid-schedule
    for 8 cuts, 0-based).

    For any OTHER dataset, uniform-8 cuts are derived from the dataset's OWN
    vote count via :func:`polismath.replay.schedule.preset_uniform` — the
    SAME preset certify's own ``"preset": "uniform", "n_cuts": 8`` battery
    entries resolve through — with the seam fixed at the middle cut index.
    """
    if dataset == "vw":
        spec = sched.ScheduleSpec.from_json_file(_VW_UNIFORM8_RESTART4_SCHEDULE)
        cuts = [int(c) for c in spec.cuts["at"]]
        seam_after = spec.restart_after if spec.restart_after is not None else len(cuts) // 2
        return cuts, seam_after
    ds = real_data.load_export_votes(dataset)
    spec = sched.preset_uniform(dataset, ds.n, n_cuts=8)
    cuts = [int(c) for c in spec.cuts["at"]]
    return cuts, len(cuts) // 2


# ---------------------------------------------------------------------------
# Live full-run orchestration — REQUIRES Postgres + the clojure CLI.
# ---------------------------------------------------------------------------
def preflight_check(admin_url: str, *, connect_timeout: float = 5.0) -> None:
    """Fail FAST with a clear, actionable message when a prerequisite live
    service is unreachable (Stage D item 3: "must fail fast ... when
    Postgres/clojure are unreachable") — never a bare driver traceback deep
    inside a multi-minute run."""
    if shutil.which("clojure") is None:
        raise RuntimeError(
            "poller-equiv full-run requires the 'clojure' CLI on PATH (it invokes "
            "`clojure -M:run full` in math/, see CljContainerRunner) — not found. "
            "Install/activate it before retrying."
        )
    # psycopg2 rejects a float connect_timeout ("invalid integer value") —
    # ceil to at least 1 whole second (found live, 2026-07-24 preflight).
    probe = sa.create_engine(
        admin_url,
        connect_args={"connect_timeout": max(1, int(round(connect_timeout)))},
    )
    try:
        with probe.connect():
            pass
    except Exception as exc:
        raise RuntimeError(
            f"poller-equiv full-run cannot reach Postgres via --pg-admin-url "
            f"(connect_timeout={connect_timeout}s): {exc}"
        ) from exc
    finally:
        probe.dispose()


@dataclass(frozen=True)
class FullRunConfig:
    """Full-run parameters (Stage D item 3). By the time
    :func:`run_full_equiv_protocol` sees one of these, ``cuts``/``seam_after``
    are already FULLY RESOLVED — the CLI (or a test) resolves defaults via
    :func:`default_full_run_schedule` before constructing this."""

    dataset: str
    admin_url: str
    out_root: str
    cuts: tuple[int, ...]
    seam_after: int
    dbname: str = "polis_equiv_full"
    zid: int = DEFAULT_ZID
    clj_env: str = "clj-ref"
    py_env: str = "py-shadow"
    engine_mode: str = ENGINE_MODE_LEGACY
    poll_from_days_ago: float = 10000
    wait_timeout: float = 120.0
    poll_interval: float = 0.5
    # Spec §1's "seam" bullet: "Also restart the clj container at the same
    # seam for symmetry (its load-or-init)" — full-run implements the
    # COMPLETE protocol end-to-end, so this defaults True (stricter than the
    # lower-level `feed` CLI subcommand's conservative default False).
    restart_clj_at_seam: bool = True
    # Quirk Q19 harness-level mitigation (session 2, 2026-07-24), approved
    # under the goal's standing autonomy — see wait_for_first_poll_cycle's
    # docstring. Defaults ON for the same reason restart_clj_at_seam does:
    # full-run implements the complete, strictest protocol end-to-end.
    wait_for_clj_poll_cycle: bool = True
    poll_cycle_gate_timeout: float = 60.0


def run_full_equiv_protocol(
    config: FullRunConfig,
    *,
    engine_factory: Callable[[str], Any] | None = None,
    clj_runner_builder: Callable[[], Any] | None = None,
    py_runner_builder: Callable[[], Any] | None = None,
    sleep: Callable[[float], None] = time.sleep,
    now: Callable[[], float] = time.monotonic,
    skip_preflight: bool = False,
) -> dict[str, Any]:
    """LIVE orchestration of the spec's complete protocol (Stage D item 3):
    (a) clj-ref run 1, (b) fresh DB + clj-ref run 2 -> self-jitter envelope,
    (c) fresh DB + clj-ref/py-shadow paired run with a restart seam, (d)/(e)
    envelope-aware compare + verdict JSON + terse summary.

    REQUIRES live Postgres + the ``clojure`` CLI — :func:`preflight_check`
    fails fast (clear message, before touching anything) unless
    ``skip_preflight`` is set (tests only). Every decision beyond I/O
    sequencing is delegated to :func:`assemble_full_run_verdict` (pure,
    canned-dir testable) — this function is thin glue around three
    ``run_*_stream`` calls plus that assembly, mirroring
    :func:`run_equiv_stream`'s own "not exercised by the default test suite"
    status for the same reason (needs a real Postgres + real subprocesses).
    """
    if not skip_preflight:
        preflight_check(config.admin_url)

    out_root = Path(config.out_root)
    out_dir_run1 = out_root / "self-jitter-1"
    out_dir_run2 = out_root / "self-jitter-2"
    out_dir_main = out_root / "main"

    run_clj_only_stream(
        config.admin_url, config.dataset, config.cuts, out_dir=out_dir_run1,
        dbname=f"{config.dbname}_jitter1", math_env=config.clj_env, zid=config.zid,
        poll_from_days_ago=config.poll_from_days_ago, wait_timeout=config.wait_timeout,
        poll_interval=config.poll_interval, engine_factory=engine_factory,
        runner_builder=clj_runner_builder, sleep=sleep, now=now,
        wait_for_clj_poll_cycle=config.wait_for_clj_poll_cycle,
        poll_cycle_gate_timeout=config.poll_cycle_gate_timeout,
    )
    run_clj_only_stream(
        config.admin_url, config.dataset, config.cuts, out_dir=out_dir_run2,
        dbname=f"{config.dbname}_jitter2", math_env=config.clj_env, zid=config.zid,
        poll_from_days_ago=config.poll_from_days_ago, wait_timeout=config.wait_timeout,
        poll_interval=config.poll_interval, engine_factory=engine_factory,
        runner_builder=clj_runner_builder, sleep=sleep, now=now,
        wait_for_clj_poll_cycle=config.wait_for_clj_poll_cycle,
        poll_cycle_gate_timeout=config.poll_cycle_gate_timeout,
    )

    runner_builders: dict[str, Callable[[], Any]] = {}
    if clj_runner_builder is not None:
        runner_builders["clj"] = clj_runner_builder
    if py_runner_builder is not None:
        runner_builders["py"] = py_runner_builder

    run_equiv_stream(
        config.admin_url, config.dataset, config.cuts, out_dir=out_dir_main,
        seam_after=config.seam_after, math_envs=(config.clj_env, config.py_env),
        restart_clj_at_seam=config.restart_clj_at_seam, dbname=f"{config.dbname}_main",
        zid=config.zid, poll_from_days_ago=config.poll_from_days_ago,
        engine_mode=config.engine_mode, wait_timeout=config.wait_timeout,
        poll_interval=config.poll_interval, engine_factory=engine_factory,
        runner_builders=runner_builders or None, sleep=sleep, now=now,
        wait_for_clj_poll_cycle=config.wait_for_clj_poll_cycle,
        poll_cycle_gate_timeout=config.poll_cycle_gate_timeout,
    )

    verdict = assemble_full_run_verdict(
        out_dir_run1, out_dir_run2, out_dir_main,
        dataset=config.dataset, cuts=config.cuts, seam_after=config.seam_after,
        clj_env=config.clj_env, py_env=config.py_env,
    )
    write_full_run_verdict(verdict, out_root)
    return verdict
