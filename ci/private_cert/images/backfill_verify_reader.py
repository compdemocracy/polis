"""Run the shipped P-070 verification SQL in one read-only snapshot; counts only.

One REPEATABLE READ, READ ONLY transaction on the existing polis_probe_reader
login runs the grant check, the five SELECTs of the digest-bound
`backfill_verification.sql`, and the fixed extra counts (per-table
source-without-target, newest published tick per label, no-write proof). Every value
kept is an integer; the projection stays on the box and only the verifier's
receipt leaves. The file is refused before any connection if its bytes are
not the reviewed digest named by both this image and the admitted job.
"""
from __future__ import annotations
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'probe_box'))
from backfill_verify import (POLICY_SHA, PROJECTION_SCHEMA, encoded, fail, validate_projection,
                             validate_run_spec)
from backfill_verify_queries import (EXTRA, EXTRA_LIMITS, READ_TABLES, SETTINGS, SHIPPED, SOURCE, SQL_NAME,
                                     SQL_SHA256, TABLES, TARGET, digest, shipped_statements)

SQL_PATH = Path(__file__).resolve().parents[2] / 'probe_box' / SQL_NAME
SESSION = ("SELECT pg_catalog.current_setting('server_version_num')::int,"
           "pg_catalog.current_setting('transaction_read_only'),"
           "pg_catalog.current_setting('transaction_isolation'),current_user,session_user")
# PostgreSQL condition codes mapped to closed statuses; no error text is kept.
CODES = {'42501': 'NOT_VISIBLE', '57014': 'TIMEOUT', '55P03': 'TIMEOUT'}


def empty(source_commit, measured, status, version=0):
    return {'schema': PROJECTION_SCHEMA, 'source_commit': source_commit, 'query_policy': POLICY_SHA,
            'verification_sql': measured, 'server_version_num': version, 'status': status,
            'snapshot_ms': None, 'results': None, 'no_write': False}


def rows(cur, limit, columns=None):
    if columns is not None and tuple(d[0] for d in cur.description) != columns:
        fail('VERIFY_SQL_SHAPE')
    out = cur.fetchmany(limit + 1)
    if len(out) > limit:
        fail('VERIFY_LIMIT')
    return out


def count(v):
    if type(v) is not int or v < 0:
        fail('VERIFY_COUNT')
    return v


def begin(conn, cur):
    conn.set_session(readonly=True, isolation_level='REPEATABLE READ', autocommit=False)
    cur.execute(SETTINGS)
    cur.execute(SESSION)
    version, readonly, isolation, user, session_user = cur.fetchone()
    if (readonly, isolation, user, session_user) != ('on', 'repeatable read', 'polis_probe_reader',
                                                     'polis_probe_reader'):
        fail('VERIFY_SESSION')
    return version


def extra(cur, name, params):
    cur.execute(EXTRA[name], params)
    return rows(cur, EXTRA_LIMITS[name])


def read(cur, statements, params):
    """All counts from the one open snapshot, as the closed results shape."""
    grants = dict(extra(cur, 'grants', {}))
    if set(grants) != set(READ_TABLES):
        fail('VERIFY_SQL_SHAPE')
    if not all(v is True for v in grants.values()):
        fail('VERIFY_NOT_VISIBLE')
    (clock,), = extra(cur, 'clock', {})
    results = {}
    for (name, columns, limit), sql in zip(SHIPPED, statements):
        cur.execute(sql, params)
        got = rows(cur, limit, columns)
        if name == 'rows':
            labels = {SOURCE: 'source', TARGET: 'target'}
            table = {t: {'source': 0, 'target': 0} for t in TABLES}
            for t, env, n in got:
                if t not in table or env not in labels:
                    fail('VERIFY_SQL_SHAPE')
                table[t][labels[env]] = count(n)
            results['rows'] = table
        else:
            if len(got) != 1:
                fail('VERIFY_SQL_SHAPE')
            results[name] = {k: count(v) for k, v in zip(columns, got[0])}
    without = dict(extra(cur, 'without_target', params))
    if set(without) != set(TABLES):
        fail('VERIFY_SQL_SHAPE')
    results['without_target'] = {t: count(without[t]) for t in TABLES}
    (source_newest, target_newest), = extra(cur, 'published', params)
    results['published'] = {'source_newest_ms': source_newest, 'target_newest_ms': target_newest}
    (no_write,), = extra(cur, 'no_write', {})
    return clock, results, no_write is True


def projection(connect, source_commit, spec, sql_bytes):
    spec = validate_run_spec(spec)
    measured = digest(sql_bytes)
    if measured != SQL_SHA256 or measured != spec['verification_sql_sha256']:
        return empty(source_commit, measured, 'SQL_MISMATCH')
    try:
        statements = shipped_statements(sql_bytes)
    except ValueError:
        return empty(source_commit, measured, 'SQL_MISMATCH')
    params = {'source': spec['source_env'], 'target': spec['target_env'], 'cutoff_ms': spec['cutoff_ms']}
    result = empty(source_commit, measured, 'QUERY_FAILED')
    conn = None
    try:
        conn = connect()
        with conn.cursor() as cur:
            result['server_version_num'] = begin(conn, cur)
            clock, results, no_write = read(cur, statements, params)
            conn.rollback()
        result.update(status='COMPLETE', snapshot_ms=clock, results=results, no_write=no_write)
        return validate_projection(result, spec)
    except Exception as error:
        # A missing grant, a timeout, a replica conflict or a limit never
        # becomes a zero count. Neither SQL/error text nor any row is kept.
        code = str(error) if type(error) is ValueError else getattr(error, 'pgcode', None)
        status = {'VERIFY_LIMIT': 'LIMIT_EXCEEDED', 'VERIFY_NOT_VISIBLE': 'NOT_VISIBLE'}.get(code) or CODES.get(code)
        return empty(source_commit, measured, status or 'QUERY_FAILED', result['server_version_num'])
    finally:
        if conn is not None:
            try:
                conn.rollback()
            finally:
                conn.close()


def main():
    import psycopg2
    if sys.argv[1:] != ['read']:
        fail('VERIFY_ACTION')
    recipe = json.loads(Path('/opt/polis-private-image/recipe.json').read_bytes())
    context = json.loads(Path('/selection/context.json').read_bytes())
    value = projection(lambda: psycopg2.connect(service='probe', connect_timeout=10), recipe['sourceCommit'],
                       context['run_spec'], SQL_PATH.read_bytes())
    Path('/output/projection.json').write_bytes(encoded(value))
    Path('/output/inputs.json').write_bytes(encoded({k: recipe[k] for k in ('candidateSha', 'oracleSha', 'policySha256')}))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        raise SystemExit('VERIFY_READER_FAILED') from None
