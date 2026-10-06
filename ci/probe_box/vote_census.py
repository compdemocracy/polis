"""Closed aggregate boundary for vote-census/1. Completion is not sign approval."""
from __future__ import annotations
import hashlib
import json
import re

KIND = 'vote-census'
VERSION = 'vote-census/1'
LIMIT = 131072
VALUES = ('neg', 'zero', 'pos', 'null', 'other')
FIRST = VALUES + ('ambiguous', 'unknown_time', 'none')
BUCKETS = ('all_neg', 'all_pos', 'mixed', 'none')
AGES = ('unknown', 'future', 'day', 'month', 'year', 'older')
ENVS = ('prod', 'python', 'other', 'null')
TABLES = ('votes', 'latest')
YEARS = tuple('y'+str(y) for y in range(1970, 2101)) + ('unknown', 'out_of_range', 'all')
WYEARS = tuple(str(y) for y in range(1970,2101)) + ('u','x','a')
WCLASSES = ('n','p','t','-','+','u','o')
HIST = ('one', 'two', 'three_five', 'six_ten', 'eleven_hundred', 'over_hundred')
METRICS = {
 'values': tuple(f'{t}:{y}:{v}' for t in TABLES for y in YEARS for v in VALUES),
 'witness': tuple('value:'+v for v in FIRST) + tuple('bucket:'+b for b in BUCKETS)
 + tuple(f'bucket_value:{b}:{v}' for b in BUCKETS for v in FIRST)
 + ('comments','conversations','first_time_tied','changed_comments','changed_authors','changed_conversations','authors'),
 'witness_nonzero': tuple(f'{y}:{i}:{k}:{m}' for y in WYEARS for i in ('n','i') for k in WCLASSES for m in ('c','z'))
 + ('excluded_seed','excluded_unknown_seed'),
 'nulls': tuple(f'{t}:age:{a}' for t in TABLES for a in AGES)
 + tuple(f'{t}:{m}' for t in TABLES for m in ('rows','conversations'))
 + ('latest:has_earlier_nonnull','votes:followed_by_nonnull'),
 'latest': ('raw_keys','latest_keys','raw_only','latest_only','unknown_order','latest_time_ties',
 'latest_value_ambiguous','value_disagreement','timestamp_disagreement','definite_disagreement'),
 'changes': tuple('rows_per_key:'+h for h in HIST) + ('keys','multirow_keys','distinct_value_changed_keys','extra_rows','max_rows_per_key'),
 'orphans': tuple(f'{t}:{m}' for t in TABLES for m in ('comment','participant','conversation','any')),
 'math': tuple('rows:'+e for e in ENVS) + tuple(f'age:{e}:{a}' for e in ENVS for a in AGES)
 + tuple(f'{m}:{e}' for m in ('votes_newer_than_watermark','votes_newer_than_modified') for e in ENVS)
 + ('missing_blob:prod','missing_blob:python','payload_not_object','kebab_only_group_clusters','unknown_watermark','unknown_modified'),
 'sizes': tuple(f'{t}:{m}' for t in TABLES for m in ('rows','heap_bytes','table_bytes','index_bytes','total_bytes')),
 'transitions': tuple('changes_per_key:'+h for h in ('zero',)+HIST) + ('eligible_keys','excluded_keys','transitions'),
}
# Frozen separately from the measured bytes; edited SQL must be explicitly re-pinned.
SQL_SHA256 = 'b0080d7c7dcb2952e35f82547e192486041b12fbd34c1dea903e3b0b32d8c94e'
POLICY_SHA = hashlib.sha256(json.dumps({'version':VERSION,'metrics':METRICS,'sql':SQL_SHA256,
 'tie_policy':'unanimous-first-time-or-ambiguous;any-missing-time-unknown',
 'replica_required':True,'limits':[600,1800,16]},sort_keys=True,separators=(',',':')).encode()).hexdigest()
STATUSES = ('COMPLETE','NOT_VISIBLE','TIMEOUT','NOT_REPLICA','SESSION_REFUSED','SQL_MISMATCH','QUERY_FAILED')
CONTROLS = ('extra-field','missing-metric','negative-count','boolean-count','text-count','wrong-image',
 'wrong-sql','wrong-kind','wrong-source','false-complete','forged-evidence')

def encoded(v):
 return json.dumps(v,sort_keys=True,separators=(',',':'),allow_nan=False).encode()

def fail(code='VOTE_CENSUS_SCHEMA'):
 raise ValueError(code)

def closed(v,keys):
 if type(v) is not dict or set(v)!=set(keys): fail()
 return v

def count(v):
 if type(v) is not int or not 0<=v<=9223372036854775807: fail()

def digest(v,n=64):
 if type(v) is not str or re.fullmatch('[a-f0-9]{'+str(n)+'}',v) is None: fail()

def validate_counts(v):
 closed(v,METRICS)
 for section,keys in METRICS.items():
  closed(v[section],keys)
  for n in v[section].values(): count(n)
 for t in TABLES:
  total=sum(v['values'][f'{t}:all:{x}'] for x in VALUES)
  if total!=v['sizes'][f'{t}:rows']: fail()
  for x in VALUES:
   if sum(v['values'][f'{t}:{y}:{x}'] for y in YEARS if y!='all')!=v['values'][f'{t}:all:{x}']: fail()
  nulls=v['nulls'][f'{t}:rows']
  if nulls!=v['values'][f'{t}:all:null'] or nulls!=sum(v['nulls'][f'{t}:age:{a}'] for a in AGES): fail()
  if v['nulls'][f'{t}:conversations']>nulls: fail()
  if v['orphans'][f'{t}:any']>total: fail()
 w=v['witness']
 if sum(w['value:'+x] for x in FIRST)!=w['comments']: fail()
 if sum(w['bucket:'+b] for b in BUCKETS)!=w['conversations']: fail()
 for x in FIRST:
  if sum(w[f'bucket_value:{b}:{x}'] for b in BUCKETS)!=w['value:'+x]: fail()
 if not w['changed_conversations']<=w['changed_authors']<=w['changed_comments']<=w['comments']: fail()
 if w['changed_authors']>w['authors'] or w['first_time_tied']>w['comments']: fail()
 nw=v['witness_nonzero']
 total=sum(nw[f'a:{i}:{k}:c'] for i in ('n','i') for k in WCLASSES)
 if total+nw['excluded_seed']+nw['excluded_unknown_seed']!=w['comments']: fail()
 for i in ('n','i'):
  for k in WCLASSES:
   if sum(nw[f'{y}:{i}:{k}:c'] for y in WYEARS if y!='a')!=nw[f'a:{i}:{k}:c']: fail()
   for y in WYEARS:
    if nw[f'{y}:{i}:{k}:z']>nw[f'{y}:{i}:{k}:c']: fail()
   if nw[f'a:{i}:{k}:z']>sum(nw[f'{y}:{i}:{k}:z'] for y in WYEARS if y!='a'): fail()
 c=v['changes']; l=v['latest']
 if sum(c['rows_per_key:'+h] for h in HIST)!=c['keys'] or c['keys']!=l['raw_keys']: fail()
 if c['keys']+c['extra_rows']!=v['sizes']['votes:rows']: fail()
 if c['multirow_keys']!=c['keys']-c['rows_per_key:one'] or c['distinct_value_changed_keys']>c['multirow_keys']: fail()
 tr=v['transitions']
 if tr['eligible_keys']+tr['excluded_keys']!=c['keys']: fail()
 if sum(tr['changes_per_key:'+h] for h in ('zero',)+HIST)!=tr['eligible_keys']: fail()
 if l['latest_keys']!=v['sizes']['latest:rows']: fail()
 for e in ('prod','python'):
  if sum(v['math'][f'age:{e}:{a}'] for a in AGES)!=v['math']['rows:'+e]: fail()
 return v

def empty_counts():
 return {k:dict.fromkeys(names,0) for k,names in METRICS.items()}

def validate_projection(p):
 closed(p,('schema','source_commit','query_policy','sql_sha256','server_version_num','status','snapshot_ms','replica','counts'))
 if p['schema']!='polis-vote-census-projection/1' or p['query_policy']!=POLICY_SHA: fail()
 digest(p['source_commit'],40); digest(p['sql_sha256']);count(p['server_version_num'])
 if p['status'] not in STATUSES or type(p['replica']) is not bool: fail()
 if p['status']=='COMPLETE':
  if p['sql_sha256']!=SQL_SHA256 or not p['replica'] or p['server_version_num']//10000!=17: fail()
  count(p['snapshot_ms']);validate_counts(p['counts'])
 elif p['counts'] is not None or p['snapshot_ms'] is not None or p['replica']: fail()
 return p

def evidence(p):
 validate_projection(p)
 return {'schema':'polis-vote-census-evidence/1','projection_sha256':hashlib.sha256(encoded(p)).hexdigest(),
         'counts':p['counts'],'status':p['status']}

def validate_receipt(r,job):
 from contracts import validate_job
 from receipt import sha
 job=validate_job(job)
 closed(r,('schema','kind','version','run_id','job_sha256','verdict','bindings','status','snapshot_ms','replica','counts','controls'))
 if job.get('kind')!=KIND or r['schema']!='polis-probe-receipt/3' or r['kind']!=KIND or r['version']!=VERSION: fail()
 if r['run_id']!=job['run_id'] or r['job_sha256']!=sha(job): fail()
 b=closed(r['bindings'],('source_commit','query_policy','sql_sha256','server_version_num','reader','producer','verifier'))
 for role in ('reader','producer','verifier'):
  if b[role]!=job[role]['image'].split('@sha256:')[1]: fail()
 closed(r['controls'],CONTROLS)
 if any(type(v) is not bool for v in r['controls'].values()): fail()
 p=dict(schema='polis-vote-census-projection/1',**{k:b[k] for k in ('source_commit','query_policy','sql_sha256','server_version_num')},
        **{k:r[k] for k in ('status','snapshot_ms','replica','counts')})
 validate_projection(p)
 if b['source_commit']!=job['run_spec']['source_commit'] or b['sql_sha256']!=job['run_spec']['sql_sha256']: fail()
 want='COMPLETE' if p['status']=='COMPLETE' and all(r['controls'].values()) else 'INCOMPLETE'
 if r['verdict']!=want or len(encoded(r))>LIMIT: fail()
 return r

def validate_run_spec(s):
 closed(s,('source_commit','sql_sha256'))
 digest(s['source_commit'],40)
 if s['sql_sha256']!=SQL_SHA256: fail()
 return dict(s)

def passed(r):
 return r['verdict']=='COMPLETE'

def receipt_schema():
 integer={'type':'integer','minimum':0,'maximum':9223372036854775807}
 def obj(properties):
  return {'type':'object','additionalProperties':False,'properties':properties,'required':list(properties)}
 counts=obj({s:obj({m:integer for m in names}) for s,names in METRICS.items()})
 pin={'type':'string','pattern':'^[a-f0-9]{64}$'}
 return {'$schema':'https://json-schema.org/draft/2020-12/schema',**obj({
 'schema':{'const':'polis-probe-receipt/3'},'kind':{'const':KIND},'version':{'const':VERSION},
 'run_id':{'type':'string','pattern':'^[a-f0-9]{32}$'},'job_sha256':pin,
 'verdict':{'enum':['COMPLETE','INCOMPLETE']},
 'bindings':obj({'source_commit':{'type':'string','pattern':'^[a-f0-9]{40}$'},'query_policy':{'const':POLICY_SHA},
 'sql_sha256':{'const':SQL_SHA256},'server_version_num':integer,**{r:pin for r in ('reader','producer','verifier')}}),
 'status':{'enum':list(STATUSES)},'snapshot_ms':{'anyOf':[integer,{'type':'null'}]},'replica':{'type':'boolean'},
 'counts':{'anyOf':[counts,{'type':'null'}]},'controls':obj({c:{'type':'boolean'} for c in CONTROLS})})}
