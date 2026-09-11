#!/usr/bin/env python3
"""Build and execute D07 in an attributed disposable source workspace."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'coordinator-rs/ci'))
from source_workspace import prepare


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--allow-local-changes', action='store_true')
    p.add_argument('--profile',choices=('all','vw-warm','vw-snapshot','biodiversity-warm','biodiversity-snapshot'),default='all')
    p.add_argument('--controls',action='store_true')
    args = p.parse_args()
    for key in ('COMPOSE_PROJECT_NAME','POLIS_RECOVERY_PG_PORT','RECOVERY_PG_PORT'):
        if not os.environ.get(key): p.error(key+' required')
    if os.environ['POLIS_RECOVERY_PG_PORT'] != os.environ['RECOVERY_PG_PORT']:
        p.error('ports must agree')
    output = args.output.resolve()
    if output.is_relative_to(ROOT): p.error('output must be outside checkout')
    output.mkdir(parents=True, exist_ok=False)
    local = tuple(str(f.relative_to(ROOT)) for f in Path(__file__).parent.iterdir()
                  if f.is_file()) if args.allow_local_changes else ()
    report = prepare(ROOT,output/'source',allow_local=args.allow_local_changes,local_files=local)
    (output/'source-reconciliation.json').write_text(json.dumps(report,indent=2)+'\n')
    with (output/'build.log').open('w') as log:
        subprocess.run(['cargo','build','--locked','--features','fault-injection','--target-dir','target/fault'],
                       cwd=output/'source/coordinator-rs',stdout=log,stderr=subprocess.STDOUT,check=True)
    profiles=('vw-warm','vw-snapshot','biodiversity-warm','biodiversity-snapshot') if args.profile=='all' else (args.profile,)
    for i,profile in enumerate(profiles):
        port=int(os.environ['POLIS_RECOVERY_PG_PORT'])+14*i
        env=dict(os.environ,D07_PROFILE=profile,D07_CONTROLS='1' if args.controls and i==0 else '0',
                 COMPOSE_PROJECT_NAME=os.environ['COMPOSE_PROJECT_NAME']+'-'+str(i),
                 POLIS_RECOVERY_PG_PORT=str(port),RECOVERY_PG_PORT=str(port))
        with (output/(profile+'.log')).open('w') as log:
            subprocess.run([sys.executable,'-B','coordinator-rs/tools/d07/run.py','--output',str(output/profile)],
                           cwd=output/'source',env=env,stdout=log,stderr=subprocess.STDOUT,check=True)


if __name__ == '__main__': main()
