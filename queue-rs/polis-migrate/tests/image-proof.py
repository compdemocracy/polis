#!/usr/bin/env python3
"""Prove fresh image initialization and restart preserve the same 23-row history."""
import os, pathlib, subprocess
assert os.environ.get('COMPOSE_PROJECT_NAME','').startswith('polis-migrate-test-')
d=pathlib.Path(__file__).parent
compose=['docker','compose','-f',str(d/'compose.yml'),'-f',str(d/'image.yml')]
def run(*args): return subprocess.check_output(compose+list(args),text=True).strip()
def query(q): return run('exec','-T','postgres','psql','-X','-v','ON_ERROR_STOP=1','-U','postgres','-d','postgres','-Atc',q)
assert query("SELECT count(*) FROM migrations WHERE status='APPLIED'")=='23'
assert query("SELECT to_regclass('public.polis_coordinator_install') IS NULL")=='t'
before=query('SELECT row_to_json(m) FROM migrations m ORDER BY name')
run('restart','postgres');run('up','-d','--wait')
assert query('SELECT row_to_json(m) FROM migrations m ORDER BY name')==before
assert '23 ready' in run('exec','-T','-e','DATABASE_URL=host=/var/run/postgresql user=postgres dbname=postgres sslmode=disable','-e','POLIS_MIGRATIONS_DIR=/migrations','postgres','polis-migrate','check')
print('image proof: 4 assertions PASS')
