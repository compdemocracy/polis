"""Trusted, fixed PostgreSQL 17 catalog projection for P-058."""
from __future__ import annotations
import json
from pathlib import Path
import sys

sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'probe_box'))
from roles_census import FAMILIES, POLICY_SHA, LIMIT, encoded, normalize, validate_census
from roles_queries import QUERIES, MAX_FAMILY_ROWS


def projection(conn, source_commit):
    result={'schema':'polis-roles-projection/1','source_commit':source_commit,'query_policy':POLICY_SHA,
        'server_version_num':0,'coverage':{f:'NOT_VISIBLE' for f in FAMILIES},
        'counts':{f:0 for f in FAMILIES},'census':{f:[] for f in FAMILIES}}
    conn.set_session(readonly=True,isolation_level='REPEATABLE READ',autocommit=False)
    try:
        with conn.cursor() as cur:
            cur.execute("SET LOCAL search_path=pg_catalog; SET LOCAL TimeZone='UTC'; SET LOCAL DateStyle='ISO, YMD'; SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='1s'")
            cur.execute("SELECT pg_catalog.current_setting('server_version_num')::int,pg_catalog.current_setting('transaction_read_only'),pg_catalog.current_setting('transaction_isolation'),current_user,session_user,pg_catalog.current_setting('max_identifier_length')::int")
            version,readonly,isolation,user,session_user,identifier_limit=cur.fetchone()
            result['server_version_num']=version
            if version//10000!=17:
                result['coverage']={f:'UNSUPPORTED_VERSION' for f in FAMILIES}
                return result
            if (readonly,isolation,user,session_user,identifier_limit)!=('on','repeatable read','polis_probe_reader','polis_probe_reader',63):
                raise ValueError('CENSUS_SESSION')
            cur.execute("SET LOCAL transaction_timeout='60s'")
            rows={}
            for family in FAMILIES:
                cur.execute(QUERIES[family])
                values=cur.fetchmany(MAX_FAMILY_ROWS+1)
                if len(values)>MAX_FAMILY_ROWS: raise ValueError('CENSUS_LIMIT')
                rows[family]=[r[0] for r in values]
            for r in rows['policies']:r['roles'].sort(key=encoded)
            for r in rows['default_acls']:r['entries'].sort(key=encoded)
            rows=normalize(rows)
            if len(encoded(rows))>LIMIT: raise ValueError('CENSUS_LIMIT')
            validate_census(rows,complete=False)
            result.update(census=rows,counts={f:len(rows[f]) for f in FAMILIES},coverage={f:'COMPLETE' for f in FAMILIES})
            if any(r[k]=='UNSUPPORTED_EXPRESSION' for r in rows['policies'] for k in ('using','with_check')):
                result['coverage']['policies']='UNSUPPORTED_EXPRESSION'
            if len(encoded(result))>LIMIT: raise ValueError('CENSUS_LIMIT')
            return result
    except Exception as e:
        # Missing catalog permission, malformed references and query failure do
        # not become an empty PASS. Neither SQL/error text nor its digest leaves.
        status='LIMIT_EXCEEDED' if type(e) is ValueError and str(e)=='CENSUS_LIMIT' else 'NOT_VISIBLE'
        result['coverage']={f:status for f in FAMILIES}
        result['census']={f:[] for f in FAMILIES}
        result['counts']={f:0 for f in FAMILIES}
        return result
    finally:
        conn.rollback()


def main():
    import psycopg2
    if sys.argv[1:]!=['read']:raise ValueError('CENSUS_ACTION')
    recipe=json.loads(Path('/opt/polis-private-image/recipe.json').read_bytes())
    conn=psycopg2.connect(service='probe',connect_timeout=10)
    try: value=projection(conn,recipe['sourceCommit'])
    finally:conn.close()
    Path('/output/projection.json').write_bytes(encoded(value))
    Path('/output/inputs.json').write_bytes(encoded({k:recipe[k] for k in ('candidateSha','oracleSha','policySha256')}))


if __name__=='__main__':
    try:main()
    except Exception:raise SystemExit('CENSUS_READER_FAILED') from None
