#!/usr/bin/env python3
"""Three source-only census recipes; staging still requires reviewed commits."""
import argparse
from pathlib import Path
import subprocess
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'probe_box'))
from control import encoded
from image_admission import file_digest, validate_recipe
from roles_census import POLICY_SHA


def recipe(source, role, runtime):
    names=['ci/probe_box/'+n+'.py' for n in ('roles_census','roles_queries','receipt','contracts')]
    names.append('ci/private_cert/images/roles_'+role+'.py')
    head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=source,text=True).strip()
    r=dict(schema='polis-private-image-recipe/2',kind='roles-census',role=role,sourceCommit=head,
        candidateSha=head,oracleSha=head,policySha256=POLICY_SHA,runtimeImage=runtime,
        files={n:file_digest(source/n) for n in names},entrypoint=names[-1],gates=['roles-census'])
    return validate_recipe(r)


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--source',type=Path,required=True);p.add_argument('--role',choices=['reader','producer','verifier'],required=True)
    p.add_argument('--runtime-image',required=True);p.add_argument('--out',type=Path,required=True)
    a=p.parse_args()
    with a.out.open('xb') as f:f.write(encoded(recipe(a.source,a.role,a.runtime_image)))


if __name__=='__main__':main()
