"""Fixed statements for the P-070 backfill verification job. No job-supplied SQL.

Two sources, both fixed:

1. The shipped verification file, `backfill_verification.sql`, copied byte for
   byte from `delphi/polismath/poller/backfill_verification.sql` and bound by
   SQL_SHA256. The reader runs its five SELECTs unchanged except for the
   three psql variables, which become driver parameters (a quoted literal for
   `:'source'`/`:'target'`, an integer for `:cutoff_ms`, exactly what psql
   substitutes). Its own BEGIN is replaced by the driver's REPEATABLE READ
   READ ONLY transaction, and its COMMIT by a rollback (nothing was written).
2. EXTRA below: the snapshot clock, the grant check, the per-table
   source-without-target counts, the newest published tick per label and the
   no-write proof. Plain SELECTs on the `polis_probe_reader` login.

Every value either source returns is an integer count, an integer
millisecond timestamp or a closed label; no zid, payload or text leaves.
"""
from __future__ import annotations
import hashlib
import re

SOURCE = 'prod'
TARGET = 'python'
# sha256 of the shipped verification file (branch math-backfill-before-flip,
# 8d11df4e4, reviewed in round [1451]; every payload reference cast ::jsonb
# for production's json columns on branch backfill-json-column-cast).
SQL_SHA256 = '13654de8042f74e0f8021356bee07831be072636c11aa8c32dda9af495718810'
SQL_NAME = 'backfill_verification.sql'
TABLES = ('math_main', 'math_bidtopid', 'math_ptptstats', 'math_ticks')
# Every relation the shipped file and EXTRA read.
READ_TABLES = TABLES + ('votes',)

# The shipped file's five result shapes, in order: (name, columns, max rows).
SHIPPED = (
    ('rows', ('tbl', 'math_env', 'n'), 2 * len(TABLES)),
    ('conversations', ('source_conversations', 'missing_main', 'missing_bidtopid', 'missing_ptptstats',
                       'missing_ticks', 'unequal_generation', 'uninitialized_generation', 'invalid_payload',
                       'behind_source_stale', 'live_lag', 'source_ahead', 'complete'), 1),
    ('orphans', ('target_only_main', 'orphan_bidtopid', 'orphan_ptptstats', 'orphan_ticks'), 1),
    ('payloads', ('checked', 'main_not_object', 'main_missing_keys', 'main_zid_unbound', 'main_timestamp_unbound',
                  'bidtopid_malformed', 'ptptstats_malformed', 'companion_timestamp_unbound', 'empty_shape',
                  'invalid_payload'), 1),
    ('cutoff', ('behind_input_at_cutoff', 'source_ahead_of_input', 'live_tail_after_cutoff'), 1),
)
BEGIN = 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'
VARIABLES = {":'source'": '%(source)s', ":'target'": '%(target)s', ':cutoff_ms': '%(cutoff_ms)s'}


def digest(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def shipped_statements(raw: bytes) -> list[str]:
    """The five SELECTs of the bound file as driver statements, or ValueError.

    Refuses any other file: the digest first, then the exact structure
    (full-line comments only, BEGIN, five SELECTs, COMMIT, only the three
    known variables, no `%` that the driver would read as a placeholder).
    """
    if type(raw) is not bytes or digest(raw) != SQL_SHA256:
        raise ValueError('VERIFY_SQL_DIGEST')
    text = raw.decode('utf-8')
    body = '\n'.join(line for line in text.split('\n') if not line.lstrip().startswith('--'))
    if '--' in body or '/*' in body or '%' in body or '\\' in body:
        raise ValueError('VERIFY_SQL_SHAPE')
    parts = [p.strip() for p in body.split(';')]
    if parts[-1] != '':
        raise ValueError('VERIFY_SQL_SHAPE')
    parts = parts[:-1]
    if len(parts) != 2 + len(SHIPPED) or parts[0] != BEGIN or parts[-1] != 'COMMIT':
        raise ValueError('VERIFY_SQL_SHAPE')
    out = []
    for sql in parts[1:-1]:
        if not sql.startswith('SELECT'):
            raise ValueError('VERIFY_SQL_SHAPE')
        for name, placeholder in VARIABLES.items():
            sql = sql.replace(name, placeholder)
        # Only `::` casts may remain; any other colon is an unknown variable.
        if re.search(r'(?<!:):(?!:)', sql):
            raise ValueError('VERIFY_SQL_VARIABLE')
        out.append(sql)
    return out


ENVS = '(%(source)s,%(target)s)'


def _without_target(table):
    return (f"SELECT '{table}', pg_catalog.count(*) FROM public.{table} s WHERE s.math_env = %(source)s "
            f"AND NOT EXISTS (SELECT 1 FROM public.{table} t WHERE t.zid = s.zid AND t.math_env = %(target)s)")


EXTRA = {
    # The snapshot's own clock; cutoff, publication and readiness ages are measured from it.
    'clock': "SELECT (pg_catalog.date_part('epoch',pg_catalog.transaction_timestamp())*1000)::bigint",
    # SELECT on every relation read. A missing grant is NOT_VISIBLE, never a zero count.
    'grants': ' UNION ALL '.join(
        f"SELECT '{t}', pg_catalog.has_table_privilege('public.{t}','SELECT')" for t in READ_TABLES),
    # Per table: source rows with no target row for the same conversation.
    'without_target': ' UNION ALL '.join(_without_target(t) for t in TABLES),
    # The newest tick each label's writer published: catch-up evidence only.
    # Not poller liveness (a stopped writer keeps its old tick, an idle one
    # publishes nothing); that is the operator's readiness record.
    'published': ("SELECT pg_catalog.max(k.modified) FILTER (WHERE k.math_env = %(source)s), "
              "pg_catalog.max(k.modified) FILTER (WHERE k.math_env = %(target)s) "
              "FROM public.math_ticks k WHERE k.math_env IN " + ENVS),
    # Proof the snapshot wrote nothing: no transaction id was ever assigned.
    'no_write': 'SELECT pg_catalog.pg_current_xact_id_if_assigned() IS NULL',
}
EXTRA_LIMITS = {'clock': 1, 'grants': len(READ_TABLES), 'without_target': len(TABLES), 'published': 1, 'no_write': 1}
# One extra row proves a fixed cap was exceeded without unbounded fetching.
EXTRA = {name: sql + f' LIMIT {EXTRA_LIMITS[name] + 1}' for name, sql in EXTRA.items()}
# Session bounds. The shipped file reads every target payload twice (queries 2
# and 4), so each statement gets a long but fixed budget; the job's
# max_seconds covers all of them. The pg_catalog-first path keeps the shipped
# file's unqualified names on the public tables and its functions on the
# built-ins; pg_temp last.
SETTINGS = ("SET LOCAL search_path=pg_catalog,public,pg_temp; SET LOCAL statement_timeout='1200s'; "
            "SET LOCAL lock_timeout='5s'; SET LOCAL idle_in_transaction_session_timeout='120s'")
