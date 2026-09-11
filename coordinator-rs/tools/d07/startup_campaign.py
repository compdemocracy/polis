#!/usr/bin/env python3
"""Freeze sources and run the non-admitting Clojure startup diagnostic."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
ROOT=Path(__file__).resolve().parents[3]
sys.path.insert(0,str(ROOT/'coordinator-rs/ci'))
from source_workspace import prepare


def main():
    p=argparse.ArgumentParser();p.add_argument('--output',type=Path,required=True)
    p.add_argument('--allow-local-changes',action='store_true');a=p.parse_args()
    for key in ('COMPOSE_PROJECT_NAME','POLIS_RECOVERY_PG_PORT','RECOVERY_PG_PORT'):
        if not os.environ.get(key):p.error(key+' required')
    if os.environ['POLIS_RECOVERY_PG_PORT']!=os.environ['RECOVERY_PG_PORT']:p.error('ports must agree')
    output=a.output.resolve()
    if output.is_relative_to(ROOT):p.error('output must be outside checkout')
    output.mkdir(parents=True,exist_ok=False)
    local=tuple(str(f.relative_to(ROOT)) for f in Path(__file__).parent.iterdir() if f.is_file()) if a.allow_local_changes else ()
    report=prepare(ROOT,output/'source',allow_local=a.allow_local_changes,local_files=local)
    (output/'source-reconciliation.json').write_text(json.dumps(report,indent=2)+'\n')
    with (output/'run.log').open('w') as log:
        r=subprocess.run([sys.executable,'-B','coordinator-rs/tools/d07/startup.py','--output',str(output/'results')],
                         cwd=output/'source',stdout=log,stderr=subprocess.STDOUT)
    return r.returncode


if __name__=='__main__':sys.exit(main())
