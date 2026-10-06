"""Unit boundaries plus opt-in generated-fixture tests on a real local PG17 replica."""
import copy
import datetime
import importlib.util
import json
import os
from pathlib import Path
import sys
import unittest
from collections import Counter,defaultdict
from unittest.mock import patch
HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE));sys.path.insert(0,str(HERE.parent/'private_cert/images'))
import vote_census as v
import vote_census_reader as reader
import vote_census_verifier as verifier
from contracts import validate_job,refuse_placeholder
from receipt import decode_receipt,sha,receipt_passed,receipt_limit

def job():
 j=copy.deepcopy(json.loads((HERE/'jobs.json').read_text())['jobs']['vote-census-v1'])
 j['run_id']='a'*32;j['run_spec']['source_commit']='1'*40
 for i,r in enumerate(('reader','producer','verifier'),2):j[r]['image']=j[r]['image'].split('@')[0]+'@sha256:'+str(i)*64
 return validate_job(j)

def projection():
 return dict(schema='polis-vote-census-projection/1',source_commit='1'*40,query_policy=v.POLICY_SHA,
 sql_sha256=v.SQL_SHA256,server_version_num=170011,status='COMPLETE',snapshot_ms=1900000000000,
 replica=True,counts=v.empty_counts())

def category(n):
 return {-1:'neg',0:'zero',1:'pos',None:'null'}.get(n,'other')

class Boundaries(unittest.TestCase):
 def test_sql_pin(self):self.assertEqual(tuple(reader.statements(reader.SQL_PATH.read_bytes())),tuple(v.METRICS))
 def test_sql_mismatch_before_connect(self):
  p=reader.projection(lambda:self.fail('connected'),'1'*40,job()['run_spec'],b'SELECT 1;')
  self.assertEqual(p['status'],'SQL_MISMATCH')
 def test_complete_roundtrip(self):
  p=projection();j=job();r=verifier.export(p,v.evidence(p),j,'1'*40)
  self.assertEqual(decode_receipt(v.encoded(r),j),r);self.assertTrue(receipt_passed(r,j))
  self.assertLess(len(v.encoded(r)),receipt_limit(j))
 def test_fixed_controls(self):self.assertEqual(verifier.controls(job()),dict.fromkeys(v.CONTROLS,True))
 def test_each_incomplete_status(self):
  for status in v.STATUSES[1:]:
   with self.subTest(status=status):
    p=reader.empty('1'*40,status);j=job();r=verifier.export(p,v.evidence(p),j,'1'*40)
    self.assertIsNone(r['counts']);self.assertFalse(receipt_passed(r,j))
 def test_duplicate_json_refused(self):
  with self.assertRaises(ValueError):decode_receipt(b'{"schema":1,"schema":2}',job())
 def test_unknown_run_spec_refused(self):
  j=job();j['run_spec']['zid']=1
  with self.assertRaises(ValueError):validate_job(j)
 def test_kind_crossing_refused(self):
  p=projection();j=job();r=verifier.export(p,v.evidence(p),j,'1'*40);j['kind']='roles-census';j.pop('run_spec')
  with self.assertRaises(ValueError):decode_receipt(v.encoded(r),j)
 def test_placeholder_images_refused(self):
  j=json.loads((HERE/'jobs.json').read_text())['jobs']['vote-census-v1']
  with self.assertRaisesRegex(ValueError,'PLACEHOLDER_IMAGE'):refuse_placeholder(validate_job(j))
 def test_placeholder_source_refused(self):
  j=job();j['run_spec']['source_commit']='0'*40
  with self.assertRaisesRegex(ValueError,'PLACEHOLDER_RUN_SPEC'):refuse_placeholder(j)
 def test_source_binding(self):
  p=projection();j=job();j['run_spec']['source_commit']='9'*40
  with self.assertRaises(ValueError):verifier.export(p,v.evidence(p),j,'1'*40)
 def test_empty_dataset_is_complete_census(self):
  p=projection();self.assertEqual(verifier.export(p,v.evidence(p),job(),'1'*40)['verdict'],'COMPLETE')
 def test_incomplete_does_not_carry_counts(self):
  p=projection();p['status']='TIMEOUT'
  with self.assertRaises(ValueError):v.validate_projection(p)
 def test_no_unknown_metric(self):
  for group in v.METRICS:
   with self.subTest(group=group):
    p=projection();p['counts'][group]['statement']='secret'
    with self.assertRaises(ValueError):v.validate_projection(p)
 def test_schema_regenerates(self):self.assertEqual(json.loads((HERE/'vote_census_receipt.schema.json').read_text()),v.receipt_schema())
 def test_reader_errors_are_closed(self):
  def connect():raise RuntimeError('credential must not escape')
  p=reader.projection(connect,'1'*40,job()['run_spec'],reader.SQL_PATH.read_bytes())
  self.assertEqual(p['status'],'QUERY_FAILED');self.assertNotIn(b'credential',v.encoded(p))
 def test_inconsistent_totals_refused(self):
  p=projection();p['counts']['sizes']['votes:rows']=1
  with self.assertRaises(ValueError):v.validate_projection(p)
 def test_nonzero_counts_arithmetic_refused(self):
  for key in ('a:n:-:c','2020:n:-:z','excluded_seed'):
   p=projection();p['counts']['witness_nonzero'][key]=1
   with self.assertRaises(ValueError):v.validate_projection(p)
 def test_old_sql_and_policy_refused(self):
  p=projection();p['sql_sha256']='0747a0644e172833b061e04af56c30f824b4db4da5c5636900362100bbbe29ca'
  with self.assertRaises(ValueError):v.validate_projection(p)
 def test_new_launcher_preserves_previous(self):
  self.assertIn("'vote-census'",(HERE.parent/'private_cert/images/launcher_vote_census.py').read_text())
  self.assertNotIn('vote-census',(HERE.parent/'private_cert/images/launcher.py').read_text())
  self.assertNotIn('vote-census',(HERE.parent/'private_cert/images/launcher_verify.py').read_text())

@unittest.skipUnless(os.environ.get('VOTE_CENSUS_LOCAL_TEST')=='1','opt-in local PG17 primary and replica')
class Postgres(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  import psycopg2
  cls.db=psycopg2
  cls.data=json.loads(Path(os.environ['VOTE_CENSUS_FIXTURE']).read_text())
  cls.p=reader.projection(cls.connect,'1'*40,job()['run_spec'],reader.SQL_PATH.read_bytes())
  if cls.p['status']!='COMPLETE':raise AssertionError(cls.p['status'])
  cls.c=cls.p['counts']
 @staticmethod
 def connect(port=55626,user='polis_probe_reader'):
  import psycopg2
  return psycopg2.connect(host='127.0.0.1',port=port,dbname='probe_test',user=user)
 def test_actual_replica_and_readonly(self):
  with self.connect() as c:
   with c.cursor() as cur:
    cur.execute("SELECT pg_is_in_recovery(),current_setting('transaction_read_only')")
    self.assertEqual(cur.fetchone(),(True,'on'))
 def test_primary_refused(self):
  p=reader.projection(lambda:self.connect(55625),'1'*40,job()['run_spec'],reader.SQL_PATH.read_bytes())
  self.assertEqual(p['status'],'NOT_REPLICA');self.assertIsNone(p['counts'])
 def test_privileged_login_refused(self):
  p=reader.projection(lambda:self.connect(user='postgres'),'1'*40,job()['run_spec'],reader.SQL_PATH.read_bytes())
  self.assertEqual(p['status'],'SESSION_REFUSED')
 def test_no_dml_or_temp(self):
  for sql in ('INSERT INTO public.votes VALUES(1,0,0,0,0)','CREATE TEMP TABLE forbidden(n integer)'):
   with self.subTest(sql=sql),self.connect() as c:
    with self.assertRaises(self.db.Error):
     with c.cursor() as cur:cur.execute(sql)
    c.rollback()
 def test_values_and_years_independent(self):
  expected=dict.fromkeys(v.METRICS['values'],0)
  for table in v.TABLES:
   for z,p,t,n,stamp in self.data[table]:
    yr='unknown' if stamp is None else ('out_of_range' if stamp<0 or stamp>=4133980800000 else 'y'+str(datetime.datetime.fromtimestamp(stamp/1000,datetime.timezone.utc).year))
    expected[f'{table}:{yr}:{category(n)}']+=1;expected[f'{table}:all:{category(n)}']+=1
  self.assertEqual(self.c['values'],expected)
 def test_witness_independent(self):
  classified=[]
  for z,t,p in self.data['comments']:
   rows=[(n,s) for zz,pp,tt,n,s in self.data['votes'] if (zz,pp,tt)==(z,p,t)]
   if not rows:classified.append((z,t,p,'none',False,False));continue
   times=[s for n,s in rows if s is not None];stamp=min(times) if times else None
   first=[n for n,s in rows if s==stamp];unknown=any(s is None for n,s in rows)
   label='unknown_time' if unknown else ('ambiguous' if len(set(first))>1 else category(first[0]))
   changed=not unknown and len(set(first))==1 and any(s is not None and s>stamp and n!=first[0] for n,s in rows)
   classified.append((z,t,p,label,len(first)>1,changed))
  counts=Counter(x[3] for x in classified);want=dict.fromkeys(v.METRICS['witness'],0)
  for x in v.FIRST:want['value:'+x]=counts[x]
  zs=set(self.data['conversations'])|{x[0] for x in classified}
  for z in zs:
   rows=[x for x in classified if x[0]==z];values=Counter(x[3] for x in rows)
   unsuitable=sum(values[x] for x in v.FIRST if x not in ('neg','pos','none'))
   b='all_neg' if values['neg'] and not values['pos'] and not unsuitable else 'all_pos' if values['pos'] and not values['neg'] and not unsuitable else 'none' if not values['pos'] and not values['neg'] else 'mixed'
   want['bucket:'+b]+=1
   for x in v.FIRST:want[f'bucket_value:{b}:{x}']+=values[x]
  want.update(comments=len(classified),conversations=len(zs),first_time_tied=sum(x[4] for x in classified),
   changed_comments=sum(x[5] for x in classified),changed_authors=len({(x[0],x[2]) for x in classified if x[5]}),
   changed_conversations=len({x[0] for x in classified if x[5]}),authors=len({(x[0],x[2]) for x in classified}))
  self.assertEqual(self.c['witness'],want)
 def test_nonzero_witness_independent(self):
  want=dict.fromkeys(v.METRICS['witness_nonzero'],0);seen=defaultdict(set)
  metadata={(r[0],r[1]):r[2:] for r in self.data['comment_metadata']}
  for z,t,p in self.data['comments']:
   seed,orig,stamp=metadata[z,t]
   if seed is None:want['excluded_unknown_seed']+=1;continue
   if seed:want['excluded_seed']+=1;continue
   rows=[(n,s) for zz,pp,tt,n,s in self.data['votes'] if (zz,pp,tt)==(z,p,t)]
   nz=[(n,s) for n,s in rows if n in (-1,1)]
   if not rows:label='n'
   elif any(s is None for n,s in nz):label='u'
   elif not nz:label='o' if any(n not in (-1,0,1,None) for n,s in rows) else 'p'
   else:
    first=min(s for n,s in nz);signs={n for n,s in nz if s==first}
    label='t' if len(signs)>1 else '-' if -1 in signs else '+'
   year='u' if stamp is None else 'x' if stamp<0 or stamp>=4133980800000 else str(datetime.datetime.fromtimestamp(stamp/1000,datetime.timezone.utc).year)
   cohort='n' if orig is None else 'i'
   for yr in (year,'a'):
    key=f'{yr}:{cohort}:{label}'
    want[key+':c']+=1;seen[key].add(z)
  for key,zs in seen.items():want[key+':z']=len(zs)
  self.assertEqual(self.c['witness_nonzero'],want)
  # Literal NULL followed by -1 becomes first nonzero -1; seeds stay literal only.
  self.assertGreater(self.c['witness']['value:null'],0)
  self.assertGreater(want['a:i:-:c'],0)
  self.assertEqual(want['excluded_seed'],2)

 def test_null_counts_and_ages(self):
  want=dict.fromkeys(v.METRICS['nulls'],0);clock=self.p['snapshot_ms']
  for table in v.TABLES:
   rows=[r for r in self.data[table] if r[3] is None]
   want[table+':rows']=len(rows);want[table+':conversations']=len({r[0] for r in rows})
   for z,p,t,n,stamp in rows:
    a='unknown' if stamp is None else 'future' if stamp>clock else 'day' if clock-stamp<86400000 else 'month' if clock-stamp<2592000000 else 'year' if clock-stamp<31536000000 else 'older'
    want[f'{table}:age:{a}']+=1
  for table,metric,direction in [('latest','latest:has_earlier_nonnull',-1),('votes','votes:followed_by_nonnull',1)]:
   for z,p,t,n,s in self.data[table]:
    if n is None and s is not None and any((zz,pp,tt)==(z,p,t) and nn is not None and ss is not None and (ss-s)*direction>0 for zz,pp,tt,nn,ss in self.data['votes']):want[metric]+=1
  self.assertEqual(self.c['nulls'],want)
 def test_latest_disagreement_independent(self):
  raw=defaultdict(list)
  for z,p,t,n,s in self.data['votes']:raw[z,p,t].append((n,s))
  latest={tuple(r[:3]):tuple(r[3:]) for r in self.data['latest']}
  want=dict.fromkeys(v.METRICS['latest'],0);want.update(raw_keys=len(raw),latest_keys=len(latest))
  for k in raw.keys()|latest.keys():
   if k not in raw:want['latest_only']+=1;want['definite_disagreement']+=1;continue
   rows=raw[k];times=[s for n,s in rows if s is not None];stamp=max(times) if times else None
   first=[n for n,s in rows if s==stamp];unknown=any(s is None for n,s in rows)
   want['unknown_order']+=unknown;want['latest_time_ties']+=len(first)>1;want['latest_value_ambiguous']+=len(set(first))>1
   if k not in latest:want['raw_only']+=1;want['definite_disagreement']+=1;continue
   if unknown:continue
   n,s=latest[k];bad=n not in first;ts=s!=stamp
   want['value_disagreement']+=bad;want['timestamp_disagreement']+=ts;want['definite_disagreement']+=bad or ts
  self.assertEqual(self.c['latest'],want)
 def test_changes_independent(self):
  raw=defaultdict(list)
  for z,p,t,n,s in self.data['votes']:raw[z,p,t].append(n)
  counts=self.c['changes']
  self.assertEqual(counts['keys'],len(raw));self.assertEqual(counts['multirow_keys'],sum(len(r)>1 for r in raw.values()))
  self.assertEqual(counts['distinct_value_changed_keys'],sum(len(set(r))>1 for r in raw.values()))
  self.assertEqual(counts['extra_rows'],sum(len(r)-1 for r in raw.values()))
  self.assertEqual(counts['max_rows_per_key'],max(map(len,raw.values())))
  buckets=Counter('one' if len(r)==1 else 'two' if len(r)==2 else 'three_five' if len(r)<=5 else 'six_ten' if len(r)<=10 else 'eleven_hundred' if len(r)<=100 else 'over_hundred' for r in raw.values())
  self.assertEqual({h:counts['rows_per_key:'+h] for h in v.HIST},{h:buckets[h] for h in v.HIST})
 def test_orphans_independent(self):
  for table in v.TABLES:
   want=Counter();comments={(r[0],r[1]) for r in self.data['comments']};participants=set(map(tuple,self.data['participants']))
   for z,p,t,n,s in self.data[table]:
    flags=[(z,t) not in comments,(z,p) not in participants,z not in self.data['conversations']]
    for key,b in zip(('comment','participant','conversation','any'),flags+[any(flags)]):want[key]+=b
   self.assertEqual({k:self.c['orphans'][table+':'+k] for k in want},dict(want))
 def test_math_json_column_and_payload_shape(self):
  m=self.c['math'];self.assertEqual(m['rows:prod'],2);self.assertEqual(m['rows:python'],1);self.assertEqual(m['rows:other'],1)
  self.assertEqual(m['kebab_only_group_clusters'],1);self.assertEqual(m['payload_not_object'],1)
  self.assertEqual(m['votes_newer_than_watermark:prod'],2);self.assertEqual(m['votes_newer_than_modified:prod'],1)
  self.assertEqual(m['missing_blob:prod'],8);self.assertEqual(m['missing_blob:python'],9)
 def test_nonzero_edge_classes_on_real_sql(self):
  # Only the disposable local primary is edited; rollback restores its fixture.
  c=self.connect(55625,'postgres')
  try:
   with c.cursor() as cur:
    cur.execute('DELETE FROM public.votes; DELETE FROM public.comments')
    rows=[[],[(0,1),(None,2)],[(0,1),(-1,2)],[(None,None),(1,3)],
          [(-1,1),(1,1)],[(-1,None),(1,2)],[(2,1)],[(1,1),(1,1)]]
    for t,votes in enumerate(rows):
     cur.execute('INSERT INTO public.comments(zid,tid,pid,is_seed,original_id,created) VALUES(1,%s,0,false,NULL,1577836800000)',(t,))
     for n,stamp in votes:cur.execute('INSERT INTO public.votes VALUES(1,0,%s,%s,%s)',(t,n,stamp))
    cur.execute(reader.statements(reader.SQL_PATH.read_bytes())['witness_nonzero']);actual=dict(cur.fetchall())
    for label,n in dict(n=1,p=1,t=1,u=1,o=1,**{'-':1,'+':2}).items():
     self.assertEqual(actual[f'2020:n:{label}:c'],n)
     self.assertEqual(actual[f'a:n:{label}:c'],n)
     self.assertEqual(actual[f'a:n:{label}:z'],1)
  finally:c.rollback();c.close()

 def test_relation_sizes(self):
  for t in v.TABLES:
   s=self.c['sizes'];self.assertEqual(s[t+':rows'],len(self.data[t]))
   self.assertGreaterEqual(s[t+':table_bytes'],s[t+':heap_bytes'])
   self.assertEqual(s[t+':total_bytes'],s[t+':table_bytes']+s[t+':index_bytes'])
 def test_receipt_contains_no_dynamic_strings(self):
  r=verifier.export(self.p,v.evidence(self.p),job(),'1'*40);raw=v.encoded(r)
  self.assertNotIn(b'private label',raw);self.assertNotIn(b'zid',raw);self.assertNotIn(b'pid',raw);self.assertNotIn(b'tid',raw)
  self.assertEqual(decode_receipt(raw,job()),r)
 def test_missing_grant_incomplete(self):
  import time
  def change(sql):
   c=self.connect(55625,'postgres')
   with c:
    with c.cursor() as cur:cur.execute(sql);cur.execute('SELECT pg_current_wal_lsn()');lsn=cur.fetchone()[0]
   c.close()
   for _ in range(100):
    c=self.connect()
    with c:
     with c.cursor() as cur:cur.execute('SELECT pg_last_wal_replay_lsn()>=%s::pg_lsn',(lsn,));done=cur.fetchone()[0]
    c.close()
    if done:return
    time.sleep(.02)
   self.fail('replica did not catch up')
  try:
   change('REVOKE SELECT ON votes_latest_unique FROM polis_probe_reader')
   p=reader.projection(self.connect,'1'*40,job()['run_spec'],reader.SQL_PATH.read_bytes())
   self.assertEqual(p['status'],'NOT_VISIBLE');self.assertIsNone(p['counts'])
  finally:change('GRANT SELECT ON votes_latest_unique TO polis_probe_reader')

 def test_transitions_independent(self):
  raw=defaultdict(lambda:defaultdict(set))
  for z,p,t,n,stamp in self.data['votes']:raw[z,p,t][stamp].add(n)
  want=dict.fromkeys(v.METRICS['transitions'],0)
  for times in raw.values():
   if None in times or any(len(values)>1 for values in times.values()):want['excluded_keys']+=1;continue
   want['eligible_keys']+=1
   ordered=[next(iter(times[stamp])) for stamp in sorted(times)]
   n=sum(a!=b for a,b in zip(ordered,ordered[1:]))
   h='zero' if n==0 else 'one' if n==1 else 'two' if n==2 else 'three_five' if n<=5 else 'six_ten' if n<=10 else 'eleven_hundred' if n<=100 else 'over_hundred'
   want['changes_per_key:'+h]+=1;want['transitions']+=n
  self.assertEqual(self.c['transitions'],want)

if __name__=='__main__':unittest.main()
