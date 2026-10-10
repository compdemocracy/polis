#!/usr/bin/env python3
"""Apply the core SQL on fresh local fixtures; no deployment runner or fake receipts."""
import hashlib
import sys
from prove import ROOT, C, DB, OUT, record, sql, sp
MIG = ROOT / 'server/postgres/migrations'

def query(db, text, ok=True):
    p = sp.run(C + ['exec', '-T', 'postgres', 'psql', '-XqAt', '-v',
                   'ON_ERROR_STOP=1', '-U', 'postgres', '-d', db],
               input=text, text=True, capture_output=True)
    if (p.returncode == 0) != ok:
        raise AssertionError((db, p.stdout[-1000:], p.stderr[-2000:]))
    return p.stdout.strip() if ok else p.stderr

def baseline(db):
    query('postgres', 'CREATE DATABASE ' + db)
    paths = sorted(p for p in MIG.glob('*.sql') if p.name[:6].isdigit()
                   and int(p.name[:6]) <= 24)
    assert [int(p.name[:6]) for p in paths] == [n for n in range(25) if n != 20]
    for p in paths:
        query(db, p.read_text())
    assert query(db, 'SELECT contract_version FROM polis_queue_install') == 'polis-queue/3'

forward = (MIG / '000027_create_sealed_job_graphs.sql').read_text()
down = (MIG / 'down/000027_drop_sealed_job_graphs.sql').read_text()
if sys.argv[1:] == ['--bootstrap']:
    baseline(DB)
    query(DB, forward)
    print('Applied unchanged 000000–000024 prerequisites (no 20), then trimmed M27')
else:
    for line in (MIG / 'down/000027-files.sha256').read_text().splitlines():
        digest, name = line.split()
        assert hashlib.sha256((MIG / name).read_bytes()).hexdigest() == digest
    record('forward_and_down_seals_match')
    db = DB + '_empty_down'
    baseline(db)
    query(db, forward)
    # The down migration itself compares the complete /3 catalog to the baseline.
    query(db, down)
    assert query(db, 'SELECT contract_version FROM polis_queue_install') == 'polis-queue/3'
    query(db, forward)
    assert query(db, 'SELECT contract_version FROM polis_queue_install') == 'polis-queue/5'
    assert 'nonempty graph contract' in sql(down, ok=False)
    record('empty_forward_down_reapply_exact_catalog_nonempty_refusal')
    # Never adopt the earlier unreleased M27 under the new seal.
    assert 'queue /3 catalog drift' in query(DB, forward, ok=False)
    record('reapply_requires_explicit_migration_management')
