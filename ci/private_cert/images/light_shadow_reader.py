"""Fixed read-only snapshot of the prod and shadow math rows for P-067.

One REPEATABLE READ, READ ONLY transaction on the existing polis_probe_reader
login (no new grant) reads both labels' math_main rows for the conversations
active in the window, plus a catalog of counts. A second read-only transaction
re-counts the prod rows afterwards. The projection stays on the box; only the
verifier's receipt leaves.
"""
from __future__ import annotations
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'probe_box'))
from light_shadow import (CATALOG, POLICY_SHA, PROD, PROJECTION_SCHEMA, encoded, fail,
                          validate_run_spec)
from light_shadow_queries import QUERIES, LIMITS

SESSION = ("SELECT pg_catalog.current_setting('server_version_num')::int,"
           "pg_catalog.current_setting('transaction_read_only'),"
           "pg_catalog.current_setting('transaction_isolation'),current_user,session_user")
SETTINGS = ("SET LOCAL search_path=pg_catalog; SET LOCAL statement_timeout='300s'; "
            "SET LOCAL lock_timeout='1s'; SET LOCAL idle_in_transaction_session_timeout='60s'")


def empty(source_commit, spec, status, version=0):
    return {'schema': PROJECTION_SCHEMA, 'source_commit': source_commit, 'query_policy': POLICY_SHA,
            'server_version_num': version, 'status': status, 'shadow_env': spec['shadow_env'], 'window': None,
            'catalog': dict(dict.fromkeys(CATALOG[:-1], 0), no_write=False), 'conversations': []}


def fetch(cur, name, params):
    cur.execute(QUERIES[name], params)
    rows = cur.fetchmany(LIMITS[name] + 1)
    if len(rows) > LIMITS[name]:
        fail('SHADOW_LIMIT')
    return rows


def begin(conn, cur):
    conn.set_session(readonly=True, isolation_level='REPEATABLE READ', autocommit=False)
    cur.execute(SETTINGS)
    cur.execute(SESSION)
    version, readonly, isolation, user, session_user = cur.fetchone()
    if (readonly, isolation, user, session_user) != ('on', 'repeatable read', 'polis_probe_reader',
                                                     'polis_probe_reader'):
        fail('SHADOW_SESSION')
    return version


def counts(cur, params):
    keys = {('math_main', PROD): 'prod_main', ('math_main', params['shadow']): 'shadow_main',
            ('math_ticks', PROD): 'prod_ticks', ('math_ticks', params['shadow']): 'shadow_ticks'}
    out = dict.fromkeys(keys.values(), 0)
    for table, env, n in fetch(cur, 'counts', params):
        out[keys[table, env]] = n
    return out


def projection(conn, source_commit, spec):
    spec = validate_run_spec(spec)
    result = empty(source_commit, spec, 'NOT_VISIBLE')
    try:
        with conn.cursor() as cur:
            result['server_version_num'] = begin(conn, cur)
            (end,), = fetch(cur, 'clock', {})
            params = {'prod': PROD, 'shadow': spec['shadow_env'], 'end': end,
                      'start': end - 1000 * spec['window_seconds']}
            catalog = result['catalog']
            catalog.update(counts(cur, params))
            active = [z for z, in fetch(cur, 'active', params)]
            catalog['active'] = len(active)
            created = dict(fetch(cur, 'created', params))
            conversations = {z: {'zid': z, 'created': created.get(z), 'prod': None, 'shadow': None} for z in active}
            for zid, env, data in fetch(cur, 'rows', params):
                conversations[zid]['prod' if env == PROD else 'shadow'] = data
            (no_write,), = fetch(cur, 'no_write', {})
            conn.rollback()
            if sorted(conversations) != active or any(c['prod'] is None and c['shadow'] is None
                                                      for c in conversations.values()):
                fail('SHADOW_SNAPSHOT')
            # After the snapshot: prod rows are append/upsert only, so fewer
            # rows afterwards would mean something removed them.
            begin(conn, cur)
            after = counts(cur, params)
            conn.rollback()
            catalog.update(prod_main_after=after['prod_main'], prod_ticks_after=after['prod_ticks'],
                           no_write=no_write is True)
            result.update(window={'start_ms': params['start'], 'end_ms': end}, status='COMPLETE',
                          conversations=[conversations[z] for z in active])
            return result
    except Exception as error:
        # A missing grant, a query failure or a limit never becomes an empty
        # PASS. Neither SQL/error text nor any row leaves in this projection.
        status = 'LIMIT_EXCEEDED' if type(error) is ValueError and str(error) == 'SHADOW_LIMIT' else 'NOT_VISIBLE'
        return empty(source_commit, spec, status, result['server_version_num'])
    finally:
        conn.rollback()


def main():
    import psycopg2
    if sys.argv[1:] != ['read']:
        fail('SHADOW_ACTION')
    recipe = json.loads(Path('/opt/polis-private-image/recipe.json').read_bytes())
    context = json.loads(Path('/selection/context.json').read_bytes())
    conn = psycopg2.connect(service='probe', connect_timeout=10)
    try:
        value = projection(conn, recipe['sourceCommit'], context['run_spec'])
    finally:
        conn.close()
    Path('/output/projection.json').write_bytes(encoded(value))
    Path('/output/inputs.json').write_bytes(encoded({k: recipe[k] for k in ('candidateSha', 'oracleSha', 'policySha256')}))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        raise SystemExit('SHADOW_READER_FAILED') from None
