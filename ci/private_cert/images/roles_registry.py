#!/usr/bin/env python3
"""Admit three reviewed census OCI archives and emit a concrete registry entry.

No build/push, fabricated digest or dirty-source staging exception. Apply the
output to jobs.json only after the source commit and image review exist.
"""
import argparse
import json
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'probe_box'))
from control import sha, encoded
from image_admission import inspect_oci, validate_recipe, validate_config, file_digest, HEX
from contracts import validate_job


def admit(archives, recipes, review):
    roles=('reader','producer','verifier')
    if set(review)!={'schema','recipeSha256','reviewSha256'} or review['schema']!='polis-roles-image-review/1' or not HEX.fullmatch(review['reviewSha256']):
        raise ValueError('CENSUS_IMAGE_REVIEW')
    if set(review['recipeSha256'])!=set(roles):raise ValueError('CENSUS_IMAGE_REVIEW')
    job=dict(schema='polis-probe-job/2',kind='roles-census',run_id='0'*32,max_seconds=900)
    evidence={}
    for role,action in zip(roles,('read','produce','verify')):
        r=validate_recipe(recipes[role])
        if r['schema']!='polis-private-image-recipe/2' or r['role']!=role or sha(r)!=review['recipeSha256'][role]:
            raise ValueError('CENSUS_IMAGE_REVIEW_BINDING')
        image=inspect_oci(archives[role]);validate_config(image.pop('config'),r)
        expected={'recipe.json':sha(r),'launcher.py':file_digest(Path(__file__).parent/'launcher.py'),
                  **{'payload/'+k:v for k,v in r['files'].items()}}
        if image.pop('privateFiles')!=expected:raise ValueError('CENSUS_IMAGE_SOURCE')
        evidence[role]=dict(image,recipeSha256=sha(r))
        job[role]={'image':'localhost/polis-roles-'+role+'@'+image['manifestDigest'],'args':[action]}
    for key in ('sourceCommit','candidateSha','oracleSha','policySha256'):
        if len({recipes[r][key] for r in roles})!=1:raise ValueError('CENSUS_IMAGE_BINDING')
    return validate_job(job),evidence


def main():
    p=argparse.ArgumentParser(description=__doc__)
    for role in ('reader','producer','verifier'):
        p.add_argument('--'+role+'-oci',type=Path,required=True);p.add_argument('--'+role+'-recipe',type=Path,required=True)
    p.add_argument('--review',type=Path,required=True);p.add_argument('--out',type=Path,required=True)
    a=p.parse_args();roles=('reader','producer','verifier')
    job,evidence=admit({r:getattr(a,r+'_oci') for r in roles},
        {r:json.loads(getattr(a,r+'_recipe').read_bytes()) for r in roles},json.loads(a.review.read_bytes()))
    with a.out.open('xb') as f:f.write(encoded({'job':job,'images':evidence}))


if __name__=='__main__':main()
