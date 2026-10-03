"""The operator's side of the un-flip rehearsal: the only RDS and Secrets Manager caller.

    python3 ci/probe_box/run.py unflip-rehearsal check   --config C --profile P --source-db-instance S
    python3 ci/probe_box/run.py unflip-rehearsal restore --config C --profile P --source-db-instance S \
        --run-id R --mode flip --certification ID --certification ID --ddl F --server-image D --engine-image D
    python3 ci/probe_box/run.py unflip-rehearsal launch  --config C --profile P --run-id R
    python3 ci/probe_box/run.py unflip-rehearsal watch   --config C --profile P --run-id R
    python3 ci/probe_box/run.py unflip-rehearsal receipt --config C --profile P --run-id R
    python3 ci/probe_box/run.py unflip-rehearsal cleanup --config C --profile P --run-id R

Runs under the operator's deploy SSO only (shape C): the worker has no RDS
rights and never sees a snapshot or instance identifier. Identifiers (the
snapshot, the temporary endpoints, the password) live in the operator dir
(the directory of --config) and the stack's rehearsal secret; the job carries
their sha256. Every later probe launch, of any kind, refuses while an instance
tagged with this box exists or the ledger records an unconfirmed cleanup:
that is the sweeper, without a Lambda.

Config keys: the stack's WorkerConfig output (REGION, BOX_ID, REHEARSAL_SECRET_ARN,
REHEARSAL_SECURITY_GROUP, REHEARSAL_INSTANCE, REHEARSAL_INSTANCE_R2, ...) plus
DB_SUBNET_GROUP, the production database's subnet group, added by the operator.
"""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import os
import re
import sys
import time
from pathlib import Path

import unflip_rehearsal as u

BOX_TAG, RUN_TAG = 'polis:probe-box', 'polis:probe-run'
LEDGER = 'unflip-ledger.jsonl'
RESTORE_SECONDS = 45 * 60
STORAGE_GROWTH_SECONDS = 30 * 60
DELETE_SECONDS = 30 * 60
POLL_SECONDS = 30
RUN_ID = re.compile('[a-f0-9]{32}')
CONFIG_KEYS = ('REGION', 'BOX_ID', 'REHEARSAL_SECRET_ARN', 'REHEARSAL_SECURITY_GROUP', 'REHEARSAL_INSTANCE',
               'REHEARSAL_INSTANCE_R2', 'DB_SUBNET_GROUP')
PUBLIC_ID = re.compile('[A-Za-z0-9]{4,64}')


class Refused(RuntimeError):
    """A closed refusal; str() is the code alone."""

    def __init__(self, code, detail=None):
        super().__init__(code)
        self.code, self.detail = code, detail


def sha(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


# ---------------------------------------------------------------------------
# The sweeper: leftovers and the ledger.
# ---------------------------------------------------------------------------
def tags(rds, instance):
    if 'TagList' in instance:
        return {t['Key']: t['Value'] for t in instance['TagList']}
    return {t['Key']: t['Value'] for t in rds.list_tags_for_resource(ResourceName=instance['DBInstanceArn'])['TagList']}


def tagged(rds, box_id):
    out = []
    for page in rds.get_paginator('describe_db_instances').paginate():
        for i in page['DBInstances']:
            t = tags(rds, i)
            if t.get(BOX_TAG) == box_id:
                out.append((i, t))
    return out


def leftovers(rds, box_id, allow_run=None):
    """Instances tagged with this box, except those of the run being launched."""
    return sorted(i['DBInstanceIdentifier'] for i, t in tagged(rds, box_id)
                  if allow_run is None or t.get(RUN_TAG) != allow_run)


def refuse_leftovers(rds, box_id, allow_run=None):
    found = leftovers(rds, box_id, allow_run)
    if found:
        raise Refused('REHEARSAL_INSTANCE_REMAINS', found)


def read_ledger(state_dir: Path):
    path = state_dir / LEDGER
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def append_ledger(state_dir: Path, entry: dict):
    entry = dict(entry, at=dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'))
    fd = os.open(state_dir / LEDGER, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    with os.fdopen(fd, 'a') as f:
        f.write(json.dumps(entry, sort_keys=True) + '\n')


def refuse_ledger(state_dir: Path):
    """The last cleanup of each run must be confirmed; otherwise every launch refuses."""
    last = {}
    for e in read_ledger(state_dir):
        if e.get('event') == 'cleanup':
            last[e.get('run_id')] = e.get('confirmed') is True
    unconfirmed = sorted(r for r, ok in last.items() if not ok)
    if unconfirmed:
        raise Refused('CLEANUP_UNCONFIRMED', unconfirmed)


def launch_preflight(cfg, profile, state_dir: Path, allow_run=None, rds=None):
    """Called before every probe launch (run.py launch), whatever its kind."""
    refuse_ledger(state_dir)
    if 'REHEARSAL_SECRET_ARN' not in cfg:
        # A stack without the rehearsal delta has no rehearsal security group,
        # so restore() cannot have created an instance for it.
        return
    refuse_leftovers(rds or client('rds', cfg, profile), cfg['BOX_ID'], allow_run)


# ---------------------------------------------------------------------------
# Snapshot, files and the secret document.
# ---------------------------------------------------------------------------
def latest_snapshot(rds, source, max_age_seconds, now=None):
    now = time.time() if now is None else now
    snaps = [s for page in rds.get_paginator('describe_db_snapshots').paginate(
        DBInstanceIdentifier=source, SnapshotType='automated') for s in page['DBSnapshots']
        if s.get('Status') == 'available']
    if not snaps:
        raise Refused('SNAPSHOT_MISSING')
    snap = max(snaps, key=lambda s: s['SnapshotCreateTime'])
    if now - snap['SnapshotCreateTime'].timestamp() > max_age_seconds:
        raise Refused('SNAPSHOT_STALE')
    return snap


def check_job_files(job, ddl: bytes):
    """The job's digests against the files on this checkout."""
    s = job['run_spec']
    if s['migration_sql_sha256'] != u.digest(u.MIGRATION_PATH.read_bytes()):
        raise Refused('MIGRATION_DIGEST')
    if s['queries_sha256'] != u.digest(u.QUERIES_PATH.read_bytes()):
        raise Refused('QUERIES_DIGEST')
    if s['convention_ddl_sha256'] != u.digest(ddl):
        raise Refused('DDL_DIGEST')


def validate_secret(doc, spec):
    """The closed secret document (unflip_rehearsal.validate_secret), refusals named."""
    try:
        return u.validate_secret(doc, spec)
    except ValueError as e:
        raise Refused(str(e)) from None


# ---------------------------------------------------------------------------
# AWS plumbing (operator profile only).
# ---------------------------------------------------------------------------
def client(name, cfg, profile):
    import boto3
    from botocore.config import Config
    return boto3.Session(profile_name=profile, region_name=cfg['REGION']).client(
        name, config=Config(retries={'total_max_attempts': 1, 'mode': 'standard'},
                            connect_timeout=10, read_timeout=30))


def describe(rds, name):
    try:
        return rds.describe_db_instances(DBInstanceIdentifier=name)['DBInstances'][0]
    except Exception as e:
        if getattr(e, 'response', {}).get('Error', {}).get('Code') == 'DBInstanceNotFound':
            return None
        raise


def wait(rds, name, until, seconds, *, sleep=time.sleep, clock=time.monotonic):
    end = clock() + seconds
    while True:
        i = describe(rds, name)
        if until(i):
            return i
        if clock() >= end:
            raise Refused('RDS_TIMEOUT', [name])
        sleep(POLL_SECONDS)


def available(i):
    return i is not None and i['DBInstanceStatus'] == 'available'


def restore_one(rds, cfg, name, snap, run_id, spec_values, *, sleep=time.sleep, clock=time.monotonic):
    """Restore, size, set a one-time master password; returns the secret entry and timings."""
    import secrets
    params = dict(DBInstanceIdentifier=name, DBSnapshotIdentifier=snap['DBSnapshotIdentifier'],
                  DBInstanceClass=spec_values['instance_class'], StorageType=spec_values['storage_type'],
                  DBSubnetGroupName=cfg['DB_SUBNET_GROUP'], VpcSecurityGroupIds=[cfg['REHEARSAL_SECURITY_GROUP']],
                  PubliclyAccessible=False, MultiAZ=False, DeletionProtection=False, CopyTagsToSnapshot=False,
                  Tags=[{'Key': BOX_TAG, 'Value': cfg['BOX_ID']}, {'Key': RUN_TAG, 'Value': run_id}])
    started = clock()
    try:
        rds.restore_db_instance_from_db_snapshot(AllocatedStorage=spec_values['allocated_storage_gb'], **params)
    except Exception as e:
        code = getattr(e, 'response', {}).get('Error', {}).get('Code')
        if code not in ('InvalidParameterCombination', 'InvalidParameterValue'):
            raise
        # A rejected parameter creates nothing; restore at the snapshot's size and grow after.
        rds.restore_db_instance_from_db_snapshot(**params)
    i = wait(rds, name, available, RESTORE_SECONDS, sleep=sleep, clock=clock)
    restored = clock() - started
    grown = clock()
    if i['AllocatedStorage'] < spec_values['allocated_storage_gb']:
        rds.modify_db_instance(DBInstanceIdentifier=name, AllocatedStorage=spec_values['allocated_storage_gb'],
                               ApplyImmediately=True)
        wait(rds, name, lambda x: available(x) and x['AllocatedStorage'] >= spec_values['allocated_storage_gb'],
             STORAGE_GROWTH_SECONDS, sleep=sleep, clock=clock)
    growth = clock() - grown
    password = secrets.token_urlsafe(32)
    rds.modify_db_instance(DBInstanceIdentifier=name, MasterUserPassword=password, BackupRetentionPeriod=0,
                           ApplyImmediately=True)
    sleep(POLL_SECONDS)   # the modification is accepted before the status leaves `available`
    i = wait(rds, name, lambda x: available(x) and not x.get('PendingModifiedValues'), RESTORE_SECONDS,
             sleep=sleep, clock=clock)
    entry = {'host': i['Endpoint']['Address'], 'port': int(i['Endpoint']['Port']), 'dbname': i['DBName'],
             'username': i['MasterUsername'], 'password': password}
    observed = {'duration_s': round(restored, 3), 'storage_growth_s': round(growth, 3),
                'instance_class': i['DBInstanceClass'], 'storage_type': i['StorageType'],
                'allocated_storage_gb': int(i['AllocatedStorage'])}
    return entry, observed


def run_dir(state_dir: Path, run_id: str) -> Path:
    if not RUN_ID.fullmatch(run_id or ''):
        raise Refused('RUN_ID')
    d = state_dir / ('unflip-' + run_id[:8])
    d.mkdir(mode=0o700, exist_ok=True)
    return d


def write_private(path: Path, value):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as f:
        json.dump(value, f, sort_keys=True, indent=1)


def registry_entry():
    return json.loads((u.HERE / 'jobs.json').read_bytes())['jobs']['unflip-rehearsal-v1']


def draft_job(run_id, *, mode, restore_rule, snap, entry, r2_entry, observed, certification, ddl, server_image,
              engine_image):
    from contracts import validate_job
    job = registry_entry()
    spec = dict(job['run_spec'], mode=mode, restore_rule=restore_rule,
                snapshot_sha256=sha(snap['DBSnapshotIdentifier']),
                snapshot_created_ms=int(snap['SnapshotCreateTime'].timestamp() * 1000),
                db_host_sha256=sha(entry['host']), r2_host_sha256=sha(r2_entry['host']) if r2_entry else None,
                certification_conversations=len(certification),
                certification_sha256=sorted(sha(x) for x in certification),
                convention_ddl_sha256=u.digest(ddl), server_image=server_image, engine_image=engine_image,
                restore_observed=observed, **u.file_digests())
    return validate_job(dict(job, run_id=run_id, run_spec=spec))


# ---------------------------------------------------------------------------
# Subcommands.
# ---------------------------------------------------------------------------
def cmd_check(a, cfg, state_dir):
    rds = client('rds', cfg, a.profile)
    refuse_ledger(state_dir)
    refuse_leftovers(rds, cfg['BOX_ID'])
    client('sts', cfg, a.profile).get_caller_identity()
    client('secretsmanager', cfg, a.profile).describe_secret(SecretId=cfg['REHEARSAL_SECRET_ARN'])
    snap = latest_snapshot(rds, a.source_db_instance, a.max_snapshot_age_seconds)
    age = time.time() - snap['SnapshotCreateTime'].timestamp()
    return {'check': 'PASS', 'snapshot_age_s': round(age, 1)}


def cmd_restore(a, cfg, state_dir):
    if not (a.run_id and a.mode and a.ddl and a.server_image and a.engine_image):
        raise Refused('REQUEST_REFUSED')
    if any(not PUBLIC_ID.fullmatch(x) for x in a.certification) or len(set(a.certification)) != len(a.certification):
        raise Refused('CERTIFICATION_ID')
    restore_rule = a.mode == 'flip' and not a.no_restore_rule
    rds = client('rds', cfg, a.profile)
    refuse_ledger(state_dir)
    refuse_leftovers(rds, cfg['BOX_ID'])
    snap = latest_snapshot(rds, a.source_db_instance, a.max_snapshot_age_seconds)
    d = run_dir(state_dir, a.run_id)
    values = registry_entry()['run_spec']
    # Fixed by the stack, so the worker's exact-name DNS allowlist names them.
    names = [cfg['REHEARSAL_INSTANCE']] + ([cfg['REHEARSAL_INSTANCE_R2']] if restore_rule else [])
    write_private(d / 'restore.json', {'snapshot': snap['DBSnapshotIdentifier'], 'instances': names})
    entry, observed = restore_one(rds, cfg, names[0], snap, a.run_id, values)
    r2_entry = restore_one(rds, cfg, names[1], snap, a.run_id, values)[0] if restore_rule else None
    secret = dict(entry, **({'r2': r2_entry} if r2_entry else {}))
    ddl = Path(a.ddl).read_bytes()
    job = draft_job(a.run_id, mode=a.mode, restore_rule=restore_rule, snap=snap, entry=entry, r2_entry=r2_entry,
                    observed=observed, certification=a.certification, ddl=ddl, server_image=a.server_image,
                    engine_image=a.engine_image)
    validate_secret(secret, job['run_spec'])
    client('secretsmanager', cfg, a.profile).put_secret_value(SecretId=cfg['REHEARSAL_SECRET_ARN'],
                                                              SecretString=json.dumps(secret))
    write_private(d / 'job.json', job)
    append_ledger(state_dir, {'event': 'restore', 'run_id': a.run_id, 'mode': a.mode, 'instances': len(names),
                              'restore_s': observed['duration_s'], 'storage_growth_s': observed['storage_growth_s']})
    return {'restore': 'PASS', 'job_sha256': sha_job(job), 'instances': len(names)}


def sha_job(job):
    from receipt import sha as receipt_sha
    return receipt_sha(job)


def load_job(state_dir, run_id, ddl=None):
    from contracts import refuse_placeholder, validate_job
    job = validate_job(json.loads((run_dir(state_dir, run_id) / 'job.json').read_bytes()))
    if job['run_id'] != run_id or job.get('kind') != u.KIND:
        raise Refused('JOB_BINDING')
    if ddl is not None:
        check_job_files(job, ddl)
    return refuse_placeholder(job)


def cmd_launch(a, cfg, state_dir, session):
    job = load_job(state_dir, a.run_id, Path(a.ddl).read_bytes() if a.ddl else None)
    launch_preflight(cfg, a.profile, state_dir, allow_run=a.run_id)
    return session.start(job)


def cmd_cleanup(a, cfg, state_dir, rds=None, secrets_client=None, *, sleep=time.sleep, clock=time.monotonic):
    """Delete every instance of this box and run, empty the secret, record the outcome."""
    if not RUN_ID.fullmatch(a.run_id or ''):
        raise Refused('RUN_ID')
    rds = rds or client('rds', cfg, a.profile)
    confirmed, remaining = True, []
    try:
        mine = [i['DBInstanceIdentifier'] for i, t in tagged(rds, cfg['BOX_ID']) if t.get(RUN_TAG) == a.run_id]
        for name in mine:
            i = describe(rds, name)
            if i is not None and i['DBInstanceStatus'] != 'deleting':
                rds.delete_db_instance(DBInstanceIdentifier=name, SkipFinalSnapshot=True, DeleteAutomatedBackups=True)
        for name in mine:
            try:
                wait(rds, name, lambda x: x is None, DELETE_SECONDS, sleep=sleep, clock=clock)
            except Refused:
                remaining.append(name)
        if leftovers(rds, cfg['BOX_ID']):
            remaining.extend(x for x in leftovers(rds, cfg['BOX_ID']) if x not in remaining)
    except Exception:
        confirmed = False
    confirmed = confirmed and not remaining
    try:
        (secrets_client or client('secretsmanager', cfg, a.profile)).put_secret_value(
            SecretId=cfg['REHEARSAL_SECRET_ARN'], SecretString='{}')
    except Exception:
        confirmed = False
    append_ledger(state_dir, {'event': 'cleanup', 'run_id': a.run_id, 'confirmed': confirmed})
    if not confirmed:
        # The operator's own terminal: Colin deletes these by hand.
        print('UNFLIP_CLEANUP_UNCONFIRMED delete by hand: ' + ' '.join(sorted(remaining) or ['(describe failed)']),
              file=sys.stderr)
    return {'cleanup': 'PASS' if confirmed else 'REFUSE', 'run_id': a.run_id}


def cmd_receipt(a, cfg, state_dir, session):
    """Fetch, decode with the closed decoder, bind to the job, record in the ledger."""
    from receipt import decode_receipt, sha as receipt_sha
    job = load_job(state_dir, a.run_id)
    state, _ = session.active()
    if not state or state['admission'].get('id') != a.run_id:
        raise Refused('RUN_NOT_ACTIVE')
    c = session.control(state)
    owned = c.read(c.prefix + 'instance.json')
    if not owned:
        raise Refused('RECEIPT_MISSING')
    arn = f'arn:aws:ec2:{c.a["region"]}:{c.a["account"]}:instance/{owned["id"]}'
    raw = session.s3.get_object(Bucket=cfg['EVIDENCE_BUCKET'], Key=f'results/{arn}/receipt.json')['Body'].read(131073)
    r = decode_receipt(raw, job)
    cleanups = [e for e in read_ledger(state_dir) if e.get('event') == 'cleanup' and e.get('run_id') == a.run_id]
    r = u.validate_receipt(dict(r, cleanup_confirmed=bool(cleanups and cleanups[-1].get('confirmed') is True)), job)
    d = run_dir(state_dir, a.run_id)
    path = d / 'receipt.json'
    if not path.exists():
        write_private(path, r)
    digest = receipt_sha(r)
    window = 'ALLOWED' if (r['verdict'] == 'PASS' and r['mode'] == 'flip' and r['cleanup_confirmed']) else 'REFUSED'
    append_ledger(state_dir, {'event': 'receipt', 'run_id': a.run_id, 'receipt_sha256': digest,
                              'verdict': r['verdict'], 'mode': r['mode'], 'cleanup_confirmed': r['cleanup_confirmed'],
                              'window': window})
    return {'run_id': a.run_id, 'verdict': r['verdict'], 'mode': r['mode'], 'receipt_sha256': digest,
            'cleanup_confirmed': r['cleanup_confirmed'], 'window': window}


def main(argv, *, session_factory, watch):
    import argparse
    p = argparse.ArgumentParser(prog='run.py unflip-rehearsal', description=__doc__.split('\n')[0])
    p.add_argument('action', choices=('check', 'restore', 'launch', 'watch', 'receipt', 'cleanup'))
    p.add_argument('--config', type=Path, required=True)
    p.add_argument('--profile', required=True)
    p.add_argument('--run-id')
    p.add_argument('--source-db-instance')
    p.add_argument('--mode', choices=u.MODES)
    p.add_argument('--no-restore-rule', action='store_true')
    p.add_argument('--certification', action='append', default=[])
    p.add_argument('--ddl')
    p.add_argument('--server-image')
    p.add_argument('--engine-image')
    p.add_argument('--max-snapshot-age-seconds', type=int, default=129600)
    a = p.parse_args(argv)
    try:
        cfg = json.loads(a.config.read_bytes())
        state_dir = a.config.resolve().parent
        for k in CONFIG_KEYS:
            if not isinstance(cfg.get(k), str):
                raise Refused('CONFIG_UNKNOWN')
        if a.action in ('check', 'restore') and not a.source_db_instance:
            raise Refused('REQUEST_REFUSED')
        if a.action == 'check':
            result = cmd_check(a, cfg, state_dir)
        elif a.action == 'restore':
            result = cmd_restore(a, cfg, state_dir)
        elif a.action == 'cleanup':
            result = cmd_cleanup(a, cfg, state_dir)
        elif a.action == 'launch':
            return session_factory(cfg, a.profile, lambda s: cmd_launch(a, cfg, state_dir, s))
        elif a.action == 'receipt':
            result = session_factory(cfg, a.profile, lambda s: cmd_receipt(a, cfg, state_dir, s), raw=True)
        else:
            if not RUN_ID.fullmatch(a.run_id or ''):
                raise Refused('RUN_ID')
            try:
                return session_factory(cfg, a.profile, lambda s: watch(s, a.run_id))
            finally:
                print(json.dumps(cmd_cleanup(a, cfg, state_dir), sort_keys=True))
    except Refused as r:
        print(f'UNFLIP_REFUSED {r.code}')
        if r.detail and r.code in ('REHEARSAL_INSTANCE_REMAINS', 'CLEANUP_UNCONFIRMED', 'RDS_TIMEOUT'):
            # The operator's own terminal: the identifiers to delete by hand.
            print('UNFLIP_DETAIL ' + ' '.join(r.detail), file=sys.stderr)
        return 2
    except Exception:
        # Closed output: no SDK message, identifier or receipt byte.
        print('UNFLIP_REFUSED UNCLASSIFIED')
        return 2
    print(json.dumps(result, sort_keys=True))
    return 0 if result.get('verdict', 'PASS') == 'PASS' and 'REFUSE' not in result.values() else 1
