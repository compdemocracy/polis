"""Fixed aggregate SELECTs on the restricted login and a physical replica only."""
from __future__ import annotations
import hashlib
import json
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'probe_box'))
from vote_census import (METRICS,POLICY_SHA,SQL_SHA256,encoded,fail,validate_projection,validate_run_spec)
SQL_PATH=Path(__file__).resolve().parents[2]/'probe_box/vote_census.sql'
READ_TABLES=('votes','votes_latest_unique','comments','participants','conversations','math_main')
SETTINGS="""SET LOCAL search_path=pg_catalog; SET LOCAL TimeZone='UTC'; SET LOCAL DateStyle='ISO, YMD';
SET LOCAL statement_timeout='600s'; SET LOCAL lock_timeout='1s'; SET LOCAL transaction_timeout='1800s';
SET LOCAL idle_in_transaction_session_timeout='30s'; SET LOCAL work_mem='16MB'; SET LOCAL row_security=off"""
SESSION="""SELECT current_setting('server_version_num')::int,current_setting('transaction_read_only'),
current_setting('transaction_isolation'),current_user,session_user,pg_is_in_recovery(),
(extract(epoch FROM transaction_timestamp())*1000)::bigint,
(SELECT rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls FROM pg_roles WHERE rolname=current_user),
EXISTS(SELECT 1 FROM pg_roles WHERE rolname<>current_user AND pg_has_role(current_user,oid,'MEMBER'))"""
GRANTS="""SELECT c.relname,c.relkind,c.relrowsecurity,
has_table_privilege(current_user,c.oid,'SELECT'),
has_table_privilege(current_user,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
 OR has_any_column_privilege(current_user,c.oid,'INSERT,UPDATE,REFERENCES'),
c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user),
EXISTS(SELECT 1 FROM pg_inherits WHERE inhparent=c.oid)
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relname=ANY(%s)"""

def statements(raw):
 if hashlib.sha256(raw).hexdigest()!=SQL_SHA256: fail('SQL_MISMATCH')
 parts=raw.decode().split('\n-- section: ')[1:]
 result={}
 for part in parts:
  name,sql=part.split('\n',1)
  if name in result: fail('SQL_MISMATCH')
  result[name]=sql
 if tuple(result)!=tuple(METRICS): fail('SQL_MISMATCH')
 return result

def empty(source,status,version=0):
 return dict(schema='polis-vote-census-projection/1',source_commit=source,query_policy=POLICY_SHA,
 sql_sha256=SQL_SHA256,server_version_num=version,status=status,snapshot_ms=None,replica=False,counts=None)

def projection(connect,source,spec,raw):
 validate_run_spec(spec)
 if source!=spec['source_commit']: fail('SOURCE_MISMATCH')
 try: sql=statements(raw)
 except ValueError: return empty(source,'SQL_MISMATCH')
 conn=None;version=0
 try:
  conn=connect();conn.set_session(readonly=True,isolation_level='REPEATABLE READ',autocommit=False)
  with conn.cursor() as cur:
   cur.execute(SETTINGS);cur.execute(SESSION)
   version,ro,iso,user,session_user,replica,clock,broad,member=cur.fetchone()
   if not replica: return empty(source,'NOT_REPLICA',version)
   if (version//10000,ro,iso,user,session_user,broad,member)!=(17,'on','repeatable read','polis_probe_reader','polis_probe_reader',False,False):
    return empty(source,'SESSION_REFUSED',version)
   cur.execute(GRANTS,(list(READ_TABLES),)); grants=cur.fetchmany(7)
   if len(grants)!=len(READ_TABLES) or {r[0] for r in grants}!=set(READ_TABLES) or any(r[1:]!=('r',False,True,False,False,False) for r in grants):
    return empty(source,'NOT_VISIBLE',version)
   counts={}
   for name,query in sql.items():
    cur.execute(query); rows=cur.fetchmany(len(METRICS[name])+1)
    if tuple(d[0] for d in cur.description)!=('metric','n') or len(rows)!=len(METRICS[name]): fail()
    if len({r[0] for r in rows})!=len(rows): fail()
    counts[name]=dict(rows)
   p=empty(source,'COMPLETE',version);p.update(snapshot_ms=clock,replica=True,counts=counts)
   return validate_projection(p)
 except Exception as error:
  status={'42501':'NOT_VISIBLE','57014':'TIMEOUT','55P03':'TIMEOUT','25P04':'TIMEOUT'}.get(getattr(error,'pgcode',None),'QUERY_FAILED')
  return empty(source,status,version)
 finally:
  if conn is not None:
   try: conn.rollback()
   finally: conn.close()

def main():
 import psycopg2
 if sys.argv[1:]!=['read']: fail()
 from receipt import decode_json
 recipe=decode_json(Path('/opt/polis-private-image/recipe.json').read_bytes())
 context=decode_json(Path('/selection/context.json').read_bytes())
 value=projection(lambda:psycopg2.connect(service='probe',connect_timeout=10),recipe['sourceCommit'],context['run_spec'],SQL_PATH.read_bytes())
 Path('/output/projection.json').write_bytes(encoded(value))
 Path('/output/inputs.json').write_bytes(encoded({k:recipe[k] for k in ('candidateSha','oracleSha','policySha256')}))

if __name__=='__main__':
 try: main()
 except Exception: raise SystemExit('VOTE_CENSUS_READER_FAILED') from None
