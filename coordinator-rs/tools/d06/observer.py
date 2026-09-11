"""Independent coordinator and current-table observation. No pc_* calls or payload projection."""
from __future__ import annotations
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import queue
import re
import threading
import time

import psycopg2

CATALOG = 'b497500ab5652f3d24775f4895736c01'
UP_SHA = 'd50f169ad7afe12d14582a6a746c622d402ecafd8131aae246812263bf2d5e82'
ROLE = 'polis_coordinator_observer'
CODES = {'OK','OBSERVER_AUTHORITY','OBSERVER_QUERY','OBSERVER_SCOPE','OBSERVER_SCHEMA',
         'OBSERVER_LIMIT','OBSERVER_CLOCK','OBSERVER_METADATA','OBSERVER_CURRENT','POLL_MISSING','POLL_STALE','POLL_FAILED'}


class Refused(ValueError):
    pass


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def profile(value):
    if (type(value) is not dict or set(value) != {'environment','math_env','shards','allowlist'}
        or any(type(value[k]) is not str or not re.fullmatch(r'[a-zA-Z0-9_-]{1,64}',value[k])
               for k in ('environment','math_env'))
        or type(value['shards']) is not int or not 1 <= value['shards'] <= 1024
        or type(value['allowlist']) is not list or len(value['allowlist']) > 10000
        or any(type(z) is not int or not 1 <= z <= 2147483647 for z in value['allowlist'])
        or value['allowlist'] != sorted(set(value['allowlist']))):
        raise Refused('OBSERVER_SCOPE')
    return value


def scope_digest(p):
    return hashlib.sha256(canonical([p['shards'],p['allowlist']])).hexdigest()


def admit(cur):
    cur.execute('SELECT session_user=current_user,rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,rolreplication FROM pg_roles WHERE rolname=session_user')
    if cur.fetchone() != (True,False,False,False,False,False): raise Refused('OBSERVER_AUTHORITY')
    cur.execute('SELECT r.rolname FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid JOIN pg_roles u ON u.oid=m.member WHERE u.rolname=session_user ORDER BY r.rolname')
    if cur.fetchall() != [(ROLE,)]: raise Refused('OBSERVER_AUTHORITY')
    cur.execute("SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND starts_with(p.proname,'pc_') AND has_function_privilege(session_user,p.oid,'EXECUTE')")
    if cur.fetchone() != (0,): raise Refused('OBSERVER_AUTHORITY')
    cur.execute("SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND (has_table_privilege(session_user,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER') OR has_any_column_privilege(session_user,c.oid,'INSERT,UPDATE'))")
    if cur.fetchone() != (0,): raise Refused('OBSERVER_AUTHORITY')
    cur.execute("SELECT bool_and(has_table_privilege(session_user,t,'SELECT')) FROM unnest(ARRAY['math_ticks','math_main','math_bidtopid','math_ptptstats']) t")
    if cur.fetchone() != (True,): raise Refused('OBSERVER_AUTHORITY')
    cur.execute('SELECT migration_id,catalog_fingerprint FROM polis_coordinator_install WHERE singleton')
    if cur.fetchone() != ('000021',CATALOG): raise Refused('OBSERVER_SCHEMA')


# Single read-only snapshot: every aggregate is complete or the sample fails.
# The bounded profile limits returned metadata, while SQL timeouts limit work.
PENDING = """SELECT count(*),
 count(*) FILTER (WHERE g.operation_id IS NULL),
 coalesce(max(extract(epoch FROM statement_timestamp()-o.admitted_at)) FILTER (WHERE g.operation_id IS NULL),0)::float8,
 count(*) FILTER (WHERE NOT isfinite(o.admitted_at) OR o.admitted_at>statement_timestamp()),
 count(*) FILTER (WHERE (o.state='resolved' AND g.operation_id IS NULL) OR
   (g.operation_id IS NOT NULL AND (g.owner_id<>o.owner_id OR g.publisher_epoch<>o.owner_epoch
     OR g.expected_tick IS DISTINCT FROM o.expected_tick OR g.capability_sha256<>o.capability_sha256))),
 count(*) FILTER (WHERE a.enabled=false AND g.operation_id IS NULL),
 count(*) FILTER (WHERE o.state='unresolved' AND g.operation_id IS NULL)
 FROM polis_coordinator_operations o
 LEFT JOIN polis_coordinator_generations g ON g.math_env=o.math_env AND g.zid=o.zid AND g.operation_id=o.operation_id
 LEFT JOIN polis_coordinator_writer_authority a ON a.math_env=o.math_env AND a.zid=o.zid
 WHERE o.math_env=%s AND (cardinality(%s::int[])=0 OR o.zid=ANY(%s))"""


# P-031's two-table pending predicate, plus current bundle pointer consistency.
# Namespace is bound on every input. No payload is selected, including in joins.
CURRENT = """WITH t AS (SELECT zid,math_tick,modified FROM math_ticks WHERE math_env=%s),
 m AS (SELECT zid,math_tick FROM math_main WHERE math_env=%s),
 b AS (SELECT zid,math_tick FROM math_bidtopid WHERE math_env=%s),
 p AS (SELECT zid,math_tick FROM math_ptptstats WHERE math_env=%s),
 keys AS (SELECT zid FROM t UNION SELECT zid FROM m UNION SELECT zid FROM b UNION SELECT zid FROM p),
 rows AS (SELECT k.zid,t.math_tick AS tick,m.math_tick AS main,t.modified,
 b.math_tick AS bid,p.math_tick AS stats FROM keys k
 LEFT JOIN t USING(zid) LEFT JOIN m USING(zid) LEFT JOIN b USING(zid) LEFT JOIN p USING(zid)
 WHERE cardinality(%s::int[])=0 OR k.zid=ANY(%s)),
 stamped AS (SELECT *,extract(epoch FROM statement_timestamp())*1000 AS now_ms FROM rows)
 SELECT count(*) FILTER (WHERE tick IS NOT NULL AND (main IS NULL OR tick>main)),
 count(*) FILTER (WHERE main>tick),
 count(*) FILTER (WHERE tick IS NULL AND main IS NOT NULL),
 count(*) FILTER (WHERE (main IS NOT NULL AND (bid IS DISTINCT FROM main OR stats IS DISTINCT FROM main))
   OR (main IS NULL AND (bid IS NOT NULL OR stats IS NOT NULL))),
 count(*) FILTER (WHERE tick IS NOT NULL AND (main IS NULL OR tick>main)
   AND (modified IS NULL OR modified<=0 OR modified>now_ms)),
 coalesce(max((now_ms-modified)/1000) FILTER (WHERE tick IS NOT NULL AND (main IS NULL OR tick>main)),0)::float8
 FROM stamped"""


def sample(connection, p):
    p=profile(p)
    result={'schema':'polis-observer/1','Environment':p['environment'],'MathEnv':p['math_env'],
            'ObserverHealthy':0,'code':'OBSERVER_QUERY'}
    try:
        with connection:
            with connection.cursor() as cur:
                cur.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
                cur.execute("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='500ms'")
                admit(cur)
                cur.execute('SELECT writer_kind FROM polis_coordinator_namespaces WHERE math_env=%s',(p['math_env'],))
                if cur.fetchone() != ('python',): raise Refused('OBSERVER_SCOPE')
                cur.execute('SELECT max_operations FROM polis_coordinator_budgets WHERE math_env=%s',(p['math_env'],))
                bound=cur.fetchone()
                if not bound: raise Refused('OBSERVER_SCOPE')
                cur.execute(PENDING,(p['math_env'],p['allowlist'],p['allowlist']))
                total,pending,age,clock_bad,identity_bad,withdrawn,unresolved=cur.fetchone()
                if total>bound[0]: raise Refused('OBSERVER_LIMIT')
                if clock_bad or not math.isfinite(age) or age<0: raise Refused('OBSERVER_CLOCK')
                if identity_bad: raise Refused('OBSERVER_METADATA')
                cur.execute('SELECT count(*) FROM polis_coordinator_transitions WHERE (math_env=%s OR source_env=%s) AND (cardinality(%s::int[])=0 OR zid=ANY(%s))',
                            (p['math_env'],p['math_env'],p['allowlist'],p['allowlist']))
                transitions=cur.fetchone()[0]
                cur.execute("SELECT consumer,position FROM polis_coordinator_cursors WHERE math_env=%s AND starts_with(consumer,'poll-health-') ORDER BY consumer LIMIT 1025",(p['math_env'],))
                health=cur.fetchall()
                cur.execute('SELECT extract(epoch FROM statement_timestamp())::float8')
                now=cur.fetchone()[0]
                expected={f'poll-health-{i}-{p["shards"]}' for i in range(p['shards'])}
                code='OK'
                if {name for name,_ in health} != expected: code='POLL_MISSING'
                else:
                    for _,h in health:
                        if (type(h) is not dict or set(h)!={'schema','scope','started','healthy'}
                            or h['schema']!='polis-poll-health/1' or h['scope']!=scope_digest(p)
                            or type(h['healthy']) is not bool): raise Refused('OBSERVER_SCOPE')
                        if not h['healthy']: code='POLL_FAILED'; continue
                        at=h['started']
                        if type(at) not in (float,int) or not math.isfinite(at) or at<=0 or at>now: raise Refused('OBSERVER_CLOCK')
                        if now-at>120 and code=='OK': code='POLL_STALE'
                cur.execute(CURRENT,(p['math_env'],)*4+(p['allowlist'],p['allowlist']))
                behind,ahead,missing,bundle_bad,current_clock,current_age=cur.fetchone()
                if current_clock or not math.isfinite(current_age) or current_age<0:
                    raise Refused('OBSERVER_CLOCK')
                result.update(CurrentBehind=behind,CurrentAhead=ahead,CurrentMissingTicks=missing,
                              CurrentBundleMismatch=bundle_bad,
                              CurrentPointerHealthy=int(not(behind or ahead or missing or bundle_bad)))
                if ahead or missing or bundle_bad: raise Refused('OBSERVER_CURRENT')
                result.update(ObserverHealthy=1,PollHealthy=int(code=='OK'),
                              PublishLagSeconds=max(age,current_age),AdmittedLagSeconds=age,
                              CurrentLagSeconds=current_age,PendingOperations=pending,
                              WithdrawnPendingOperations=withdrawn,Transitions=transitions,
                              UnresolvedOperations=unresolved,code=code)
    except Refused as error:
        result['code']=str(error) if str(error) in CODES else 'OBSERVER_QUERY'
    except Exception:
        result['code']='OBSERVER_QUERY'
    return result


class Delivery:
    """Bounded best-effort output; no producer I/O and no blocking shutdown.

    A stalled sink is detected by missing delivered samples, not by trying to
    emit success through that same sink. Counters never erase a previous drop.
    """
    def __init__(self, sink, capacity=128):
        if type(capacity) is not int or not 1<=capacity<=128: raise ValueError('DELIVERY_CAPACITY')
        self.queue=queue.Queue(capacity);self.dropped=0;self.written=0
        self.sink=sink;self.closed=False
        self.thread=threading.Thread(target=self._run,daemon=True);self.thread.start()
    def _run(self):
        while True:
            raw=self.queue.get()
            if raw is None: return
            try: self.sink(raw);self.written+=1
            except Exception: self.dropped+=1
            finally: self.queue.task_done()
    def emit(self,value):
        raw=canonical(value)+b'\n'
        if self.closed or len(raw)>16384: self.dropped+=1;return False
        try:self.queue.put_nowait(raw);return True
        except queue.Full:self.dropped+=1;return False
    def close(self):
        self.closed=True
        end=time.monotonic()+0.1
        while self.queue.unfinished_tasks and time.monotonic()<end: time.sleep(.001)
        try:self.queue.put_nowait(None)
        except queue.Full:pass


def alarm(samples, key):
    """Local five-period 3/5 arithmetic only; destination delivery is external."""
    values=list(samples)[-5:]
    values=[None]*(5-len(values))+values
    if key not in ('PollHealthy','ObserverHealthy','PublishLagSeconds'): raise ValueError('ALARM_KEY')
    return sum((v is None and key!='PublishLagSeconds') or
               (v is not None and (v>600 if key=='PublishLagSeconds' else v<1)) for v in values)>=3


def emf(value):
    result=dict(value)
    names=('ObserverHealthy','PollHealthy','PublishLagSeconds','PendingOperations',
           'WithdrawnPendingOperations','Transitions','UnresolvedOperations','MetricsDropped',
           'AdmittedLagSeconds','CurrentLagSeconds','CurrentBehind','CurrentAhead',
           'CurrentMissingTicks','CurrentBundleMismatch','CurrentPointerHealthy')
    result['_aws']={'Timestamp':int(time.time()*1000),'CloudWatchMetrics':[{
        'Namespace':'Polis/Math','Dimensions':[['Environment','MathEnv']],
        'Metrics':[{'Name':n,'Unit':'Seconds' if n.endswith('LagSeconds') else 'Count'}
                   for n in names if n in value]}]}
    return result


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--profile',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--once',action='store_true')
    args=parser.parse_args()
    p=profile(json.loads(args.profile.read_bytes()))
    def write(raw):
        with args.output.open('ab',buffering=0) as out:out.write(raw)
    transport=Delivery(write)
    try:
        while True:
            connection=None
            try:
                connection=psycopg2.connect(os.environ['COORDINATOR_OBSERVER_DATABASE_URL'],connect_timeout=5)
                value=sample(connection,p)
            except Exception:
                value={'schema':'polis-observer/1','Environment':p['environment'],'MathEnv':p['math_env'],
                       'ObserverHealthy':0,'code':'OBSERVER_QUERY'}
            finally:
                if connection is not None:connection.close()
            value['MetricsDropped']=transport.dropped
            transport.emit(emf(value))
            if args.once:return
            time.sleep(60)
    finally:transport.close()


if __name__=='__main__':main()
