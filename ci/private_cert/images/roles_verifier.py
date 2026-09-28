"""Reconstruct reader projection independently; only this image emits receipt/3."""
from __future__ import annotations
import copy
import hashlib
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'probe_box'))
from roles_census import (FAMILIES, CONTROLS, POLICY_SHA, LIMIT, closed, encoded, identity,
                          validate_census, validate_receipt, fail)
from receipt import sha, decode_json


def reconstruct(projection):
    closed(projection,('schema','source_commit','query_policy','server_version_num','coverage','counts','census'))
    if projection['schema']!='polis-roles-projection/1' or projection['query_policy']!=POLICY_SHA:fail('CENSUS_POLICY')
    closed(projection['counts'],FAMILIES);closed(projection['coverage'],FAMILIES);closed(projection['census'],FAMILIES)
    reconstructed={}
    for family in FAMILIES:
        values=projection['census'][family]
        if type(values) is not list or type(projection['counts'][family]) is not int or len(values)!=projection['counts'][family]:fail('CENSUS_COUNT')
        # No producer code imported: walk the original inventory and insert each
        # identity independently, refusing duplicates rather than coalescing.
        indexed={}
        for value in values:
            key=identity(value,family)
            if key in indexed:fail('CENSUS_DUPLICATE')
            indexed[key]=copy.deepcopy(value)
        reconstructed[family]=[indexed[k] for k in sorted(indexed)]
    validate_census(reconstructed,complete=False)
    if reconstructed!=projection['census']:fail('CENSUS_ORDER')
    return reconstructed


def receipt(projection, produced, job, source_commit):
    census=reconstruct(projection)
    if census!=produced or projection['source_commit']!=source_commit:fail('CENSUS_RECONSTRUCTION')
    coverage=dict(projection['coverage'],scope={'schema':'public','database':'CURRENT'},
        password_state='NOT_COLLECTED',provenance='NOT_COLLECTED',data_state='NOT_COLLECTED',reversal='NOT_EVALUATED',
        unsupported_policies=sum(p[k]=='UNSUPPORTED_EXPRESSION' for p in census['policies'] for k in ('using','with_check')),
        settings_rows=sum(s['rows'] for s in census['role_settings']),
        external_dependencies=sum(s['count'] for s in census['role_dependencies'] if s['scope']!='CURRENT'))
    return {'schema':'polis-probe-receipt/3','kind':'roles-census','run_id':job['run_id'],'job_sha256':sha(job),
        'verdict':'PASS' if all(coverage[f]=='COMPLETE' for f in FAMILIES) else 'INCOMPLETE',
        'bindings':dict(source_commit=source_commit,query_policy=POLICY_SHA,census=hashlib.sha256(encoded(census)).hexdigest(),
            server_version_num=projection['server_version_num'],**{k:job[k]['image'].split('@sha256:')[1] for k in ('reader','producer','verifier')}),
        'coverage':coverage,'census':census,'controls':{k:False for k in CONTROLS}}


def controls(job):
    from roles_census import FLAGS
    census={f:[] for f in FAMILIES}
    census['roles']=[dict(name='fixture',connection_limit=-1,valid_until=None,config_present=False,config_count=0,**{k:False for k in FLAGS})]
    census['database']=[dict(name='fixture',owner='fixture',allow_connections=True,connection_limit=-1,acl_state='DEFAULT')]
    census['schemas']=[dict(name='public',owner='fixture',acl_state='DEFAULT')]
    p=dict(schema='polis-roles-projection/1',source_commit='1'*40,query_policy=POLICY_SHA,server_version_num=170000,
        coverage={f:'COMPLETE' for f in FAMILIES},counts={f:len(census[f]) for f in FAMILIES},census=census)
    good=receipt(p,census,job,'1'*40);good['controls']={k:True for k in CONTROLS}
    validate_receipt(good,job)
    mutations={
      'extra-field':lambda v:v.update(extra='forbidden'),
      'duplicate-row':lambda v:v['census']['roles'].append(copy.deepcopy(v['census']['roles'][0])),
      'dangling-role':lambda v:v['census']['schemas'][0].update(owner='missing'),
      'missing-family':lambda v:v['census'].pop('policies'),
      'wrong-kind':lambda v:v.update(kind='battery'),
      'wrong-image':lambda v:v['bindings'].update(reader='0'*64),
      'wrong-policy':lambda v:v['bindings'].update(query_policy='0'*64),
      'oversize-name':lambda v:v['census']['roles'][0].update(name='x'*64),
      'false-pass':lambda v:v['coverage'].update(policies='NOT_VISIBLE')}
    outcomes={}
    for name,mutate in mutations.items():
        bad=copy.deepcopy(good);mutate(bad)
        bad['bindings']['census']=hashlib.sha256(encoded(bad['census'])).hexdigest()
        try:validate_receipt(bad,job)
        except (ValueError,KeyError,TypeError):outcomes[name]=True
        else:outcomes[name]=False
    bad=copy.deepcopy(p);bad['counts']['roles']+=1
    try:reconstruct(bad)
    except ValueError:outcomes['wrong-count']=True
    else:outcomes['wrong-count']=False
    return outcomes


def main():
    if sys.argv[1:]!=['verify']:fail('CENSUS_ACTION')
    from contracts import validate_job
    recipe=decode_json(Path('/opt/polis-private-image/recipe.json').read_bytes())
    job=validate_job(decode_json(Path('/job/job.json').read_bytes()))
    projection=decode_json(Path('/input/projection.json').read_bytes())
    produced=decode_json(Path('/evidence/census.json').read_bytes())
    r=receipt(projection,produced,job,recipe['sourceCommit']);r['controls']=controls(job)
    if not all(r['controls'].values()):r['verdict']='FAIL'
    if len(encoded(r))>LIMIT:
        r['census']={f:[] for f in FAMILIES}
        r['bindings']['census']=hashlib.sha256(encoded(r['census'])).hexdigest()
        r['coverage'].update({f:'LIMIT_EXCEEDED' for f in FAMILIES})
        r['coverage'].update(unsupported_policies=0,settings_rows=0,external_dependencies=0)
        r['verdict']='INCOMPLETE'
    validate_receipt(r,job)
    Path('/verdict/receipt.json').write_bytes(encoded(r))


if __name__=='__main__':
    try:main()
    except Exception:raise SystemExit('CENSUS_VERIFIER_FAILED') from None
