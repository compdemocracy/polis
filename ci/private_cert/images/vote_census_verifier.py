"""Reconstruct from sealed reader aggregates, reject edits, run fixed negative controls."""
import copy
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'probe_box'))
from vote_census import (CONTROLS,KIND,VERSION,POLICY_SHA,SQL_SHA256,evidence,encoded,fail,
 empty_counts,validate_projection,validate_receipt)
from receipt import sha,decode_json

def receipt(p,produced,job,source):
 validate_projection(p)
 if p['source_commit']!=source or produced!=evidence(p): fail('VOTE_CENSUS_RECONSTRUCTION')
 return dict(schema='polis-probe-receipt/3',kind=KIND,version=VERSION,run_id=job['run_id'],job_sha256=sha(job),
 verdict='COMPLETE' if p['status']=='COMPLETE' else 'INCOMPLETE',
 bindings={**{k:p[k] for k in ('source_commit','query_policy','sql_sha256','server_version_num')},
 **{r:job[r]['image'].split('@sha256:')[1] for r in ('reader','producer','verifier')}},
 **{k:copy.deepcopy(p[k]) for k in ('status','snapshot_ms','replica','counts')},controls=dict.fromkeys(CONTROLS,True))

def controls(job):
 source=job['run_spec']['source_commit']
 p=dict(schema='polis-vote-census-projection/1',source_commit=source,query_policy=POLICY_SHA,
 sql_sha256=SQL_SHA256,server_version_num=170011,status='COMPLETE',snapshot_ms=1900000000000,
 replica=True,counts=empty_counts())
 good=receipt(p,evidence(p),job,source);validate_receipt(good,job)
 def refused(fn):
  try: fn()
  except (ValueError,KeyError,TypeError): return True
  return False
 def mutate(fn):
  bad=copy.deepcopy(good);fn(bad)
  return refused(lambda:validate_receipt(bad,job))
 checks={
 'extra-field':mutate(lambda r:r['counts']['witness'].update(zid=1)),
 'missing-metric':mutate(lambda r:r['counts']['witness'].pop('comments')),
 'negative-count':mutate(lambda r:r['counts']['witness'].update(comments=-1)),
 'boolean-count':mutate(lambda r:r['counts']['witness'].update(comments=True)),
 'text-count':mutate(lambda r:r['counts']['witness'].update(comments='private')),
 'wrong-image':mutate(lambda r:r['bindings'].update(reader='0'*64)),
 'wrong-sql':mutate(lambda r:r['bindings'].update(sql_sha256='0'*64)),
 'wrong-kind':mutate(lambda r:r.update(kind='roles-census')),
 'wrong-source':refused(lambda:receipt(p,evidence(p),job,'f'*40 if source!='f'*40 else 'e'*40)),
 'false-complete':mutate(lambda r:r.update(status='TIMEOUT')),
 'forged-evidence':refused(lambda:receipt(p,{},job,source)),
 }
 if set(checks)!=set(CONTROLS): fail()
 return checks

def export(p,produced,job,source):
 r=receipt(p,produced,job,source);r['controls']=controls(job)
 if not all(r['controls'].values()):r['verdict']='INCOMPLETE'
 return validate_receipt(r,job)

def main():
 from contracts import validate_job
 if sys.argv[1:]!=['verify']: fail()
 recipe=decode_json(Path('/opt/polis-private-image/recipe.json').read_bytes())
 job=validate_job(decode_json(Path('/job/job.json').read_bytes()))
 p=decode_json(Path('/input/projection.json').read_bytes())
 e=decode_json(Path('/evidence/evidence.json').read_bytes())
 Path('/verdict/receipt.json').write_bytes(encoded(export(p,e,job,recipe['sourceCommit'])))

if __name__=='__main__':
 try: main()
 except Exception: raise SystemExit('VOTE_CENSUS_VERIFIER_FAILED') from None
