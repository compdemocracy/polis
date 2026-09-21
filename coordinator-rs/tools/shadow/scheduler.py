"""Opt-in daily scheduling and immutable receipt delivery observations.

The collector owns input/runtime/reader evidence. This module never creates a
bound cut, retries an uncertain write, or exports private collection artifacts.
"""
from __future__ import annotations

import argparse
import copy
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
import tempfile
import time

import daily

DAY = 86400
LIMIT = 16384
MAX_DELIVERIES = 1024
PROFILE_FIELDS = ('schema', 'run', 'build', 'policy', 'start_epoch', 'days',
                  'bucket', 'prefix', 'kms_key', 'collector_profile',
                  'expected_cuts', 'expected_routes', 'observer_expected')
REQUEST_FIELDS = ('run', 'window', 'start', 'end', 'build', 'policy')
DELIVERY_FIELDS = ('schema', 'run', 'window', 'sequence', 'action', 'outcome',
                   'receipt_sha256', 'previous_sha256')


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def decode(raw, limit=LIMIT):
    if type(raw) is not bytes or not raw or len(raw) > limit:
        raise ValueError('SHADOW_SCHEDULE_SIZE')
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError('SHADOW_SCHEDULE_DUPLICATE_FIELD')
            result[key] = value
        return result
    return json.loads(raw, object_pairs_hook=pairs,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError('SHADOW_SCHEDULE_NUMBER')))


def read_bytes(path, limit=LIMIT):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise ValueError('SHADOW_SCHEDULE_PATH')
        raw = stream.read(limit + 1)
        if len(raw) > limit:
            raise ValueError('SHADOW_SCHEDULE_SIZE')
        return raw


def read_json(path):
    return decode(read_bytes(path))


def validate_profile(value):
    daily.closed(value, PROFILE_FIELDS)
    if value['schema'] != 'polis-shadow-schedule/1' or type(value['run']) is not str or not re.fullmatch(r'[a-f0-9]{32}', value['run']):
        raise ValueError('SHADOW_SCHEDULE_PROFILE')
    for key in ('build', 'policy'):
        if type(value[key]) is not str or not daily.SHA.fullmatch(value[key]):
            raise ValueError('SHADOW_SCHEDULE_PROFILE')
    daily.number(value['start_epoch'], 10**12)
    daily.number(value['days'], 36500)
    daily.number(value['expected_cuts'])
    daily.number(value['observer_expected'])
    if not value['days'] or not value['expected_cuts'] or not value['observer_expected']:
        raise ValueError('SHADOW_SCHEDULE_SCOPE')
    daily.closed(value['expected_routes'], daily.ROUTES)
    for count in value['expected_routes'].values():
        daily.number(count)
        if not count:
            raise ValueError('SHADOW_SCHEDULE_SCOPE')
    if not sum(value['expected_routes'].values()):
        raise ValueError('SHADOW_SCHEDULE_SCOPE')
    if type(value['bucket']) is not str or not re.fullmatch(r'[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]', value['bucket']):
        raise ValueError('SHADOW_SCHEDULE_TARGET')
    if type(value['prefix']) is not str or not re.fullmatch(r'[a-z0-9][a-z0-9/_-]{0,127}', value['prefix']) or value['prefix'].endswith('/'):
        raise ValueError('SHADOW_SCHEDULE_TARGET')
    if (type(value['kms_key']) is not str or not value['kms_key'] or len(value['kms_key']) > 256
            or any(ord(c) < 33 or ord(c) > 126 for c in value['kms_key'])):
        raise ValueError('SHADOW_SCHEDULE_TARGET')
    if type(value['collector_profile']) is not str or not Path(value['collector_profile']).is_absolute():
        raise ValueError('SHADOW_SCHEDULE_PROFILE')
    if len(daily.canonical(value)) > LIMIT:
        raise ValueError('SHADOW_SCHEDULE_SIZE')
    return value


def private_directory(path):
    path = Path(path)
    if path.is_symlink():
        raise ValueError('SHADOW_SCHEDULE_PATH')
    path.mkdir(parents=True, mode=0o700, exist_ok=True)
    info = path.stat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
        raise ValueError('SHADOW_SCHEDULE_PATH')
    return path


def immutable_bytes(path, raw, limit=LIMIT):
    """Atomic create-only local record, including durability before cloud I/O."""
    if type(raw) is not bytes or not raw or len(raw) > limit:
        raise ValueError('SHADOW_SCHEDULE_SIZE')
    path = Path(path)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as stream:
        temporary = Path(stream.name)
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())
    created = False
    try:
        temporary.chmod(0o400)
        try:
            os.link(temporary, path)
            created = True
        except FileExistsError:
            if read_bytes(path, limit) != raw:
                raise ValueError('SHADOW_SCHEDULE_REBOUND')
        fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    finally:
        temporary.unlink()
    return created


def immutable(path, value):
    return immutable_bytes(path, daily.canonical(value))


@contextmanager
def locked(root):
    fd = os.open(root / 'scheduler.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ValueError('SHADOW_SCHEDULE_PATH')
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError('SHADOW_SCHEDULE_BUSY') from None
        yield
    finally:
        os.close(fd)


def request_for(profile, window):
    daily.number(window, 36500)
    if window >= profile['days']:
        raise ValueError('SHADOW_SCHEDULE_WINDOW')
    start = profile['start_epoch'] + window * DAY
    return dict(run=profile['run'], window=window, start=start, end=start + DAY,
                build=profile['build'], policy=profile['policy'])


def object_key(profile, window):
    return f"{profile['prefix']}/{profile['run']}/window-{window:05d}.json"


def admit_collected(profile, request, receipt, now):
    daily.validate_receipt(receipt)
    if receipt['delivery'] != 'PENDING':
        raise ValueError('SHADOW_SCHEDULE_DELIVERY')
    for key in ('run', 'window', 'build', 'policy'):
        if receipt[key] != request[key]:
            raise ValueError('SHADOW_SCHEDULE_BINDING')
    if (receipt['windows']['expected'] != profile['expected_cuts']
            or receipt['observer']['expected'] != profile['observer_expected']
            or any(receipt['routes'][name]['expected'] != profile['expected_routes'][name] for name in daily.ROUTES)):
        raise ValueError('SHADOW_SCHEDULE_SCOPE')
    if receipt['seconds'] > min(DAY, max(0, int(now - request['start']))):
        raise ValueError('SHADOW_SCHEDULE_DURATION')
    return receipt


def absent_collector(profile, request):
    """Zero observations, never an assumed cut or completed observation duration."""
    return dict(schema='polis-shadow-receipt/1', run=request['run'], window=request['window'], seconds=0,
                build=request['build'], policy=request['policy'],
                admission={key: False for key in ('host', 'runtime', 'input', 'collector', 'clojure_serving')},
                windows=dict(expected=profile['expected_cuts'], bound=0, incomplete=profile['expected_cuts']),
                residuals={'cut-unbound-late-row': 0},
                routes={name: dict(expected=count, observed=0, **{v: 0 for v in daily.VERDICTS})
                        for name, count in profile['expected_routes'].items()},
                observer=dict(expected=profile['observer_expected'], observed=0, alarms=0, unresolved=0),
                delivery='PENDING', cleanup='RETAINED', verdict='INCOMPLETE')


def stop_process_group(process):
    """Stop the owned collector and descendants, including a surviving child."""
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        pass
    # The leader exiting does not prove that all of its children have exited.
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    process.wait(timeout=10)


def start_collector(profile, request_path, output_path):
    """Invoke only the adjacent production collector; no shell or custom command."""
    collector = Path(__file__).with_name('collector.py')
    raw_profile = read_bytes(profile['collector_profile'], daily.MAX_BODY)
    decode(raw_profile, daily.MAX_BODY)
    root = Path(request_path).parent.parent
    snapshot = root / 'collector-profile.json'
    immutable_bytes(snapshot, raw_profile, daily.MAX_BODY)
    immutable(root / 'collector-profile-binding.json',
              dict(schema='polis-shadow-collector-profile/1', sha256=digest(raw_profile)))
    command = [sys.executable, '-B', str(collector), '--profile', str(snapshot),
               '--request', str(request_path), '--output', str(output_path)]
    request = read_json(request_path)
    if request['window']:
        previous = root / f"window-{request['window']-1:05d}" / 'confirmed-receipt.json'
        command.extend(('--previous-receipt', str(previous)))
    # Collector diagnostics are private; none are forwarded into public logs.
    env = {key: os.environ[key] for key in ('PATH', 'LANG', 'LC_ALL', 'TZ') if key in os.environ}
    env.update(SHADOW_COLLECTOR_ENABLE='1', PYTHONDONTWRITEBYTECODE='1')
    return subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL, start_new_session=True, env=env)


def finish_collector(process, output_path):
    try:
        status = process.wait(timeout=DAY + 120)
    except BaseException:
        stop_process_group(process)
        raise
    stop_process_group(process)
    if status:
        raise ValueError('SHADOW_COLLECTOR_FAILED')

    return read_json(output_path)


def run_collector(profile, request_path, output_path):
    return finish_collector(start_collector(profile, request_path, output_path), output_path)


def delivery_chain(directory, receipt, request):
    chain = []
    previous = None
    for path in sorted(directory.glob('delivery-*.json')):
        if path.name != f'delivery-{len(chain):04d}.json' or len(chain) >= MAX_DELIVERIES:
            raise ValueError('SHADOW_DELIVERY_CHAIN')
        event = read_json(path)
        daily.closed(event, DELIVERY_FIELDS)
        if (event['schema'] != 'polis-shadow-delivery/1' or event['run'] != request['run']
                or type(event['window']) is not int or event['window'] != request['window']
                or type(event['sequence']) is not int or event['sequence'] != len(chain)
                or event['action'] not in ('PUT', 'GET')
                or (chain and event['action'] != 'GET')
                or event['outcome'] not in ('CONFIRMED', 'FAILED', 'UNCERTAIN')
                or event['receipt_sha256'] != digest(daily.canonical(receipt))
                or event['previous_sha256'] != previous
                or (chain and chain[-1]['outcome'] != 'UNCERTAIN')):
            raise ValueError('SHADOW_DELIVERY_CHAIN')
        chain.append(event)
        previous = digest(daily.canonical(event))
    return chain


def reconcile(client, profile, key, receipt):
    """GET only: absence or unreadability is unresolved, never a new publication."""
    raw = daily.canonical(receipt)
    body = None
    try:
        body = client.get_object(Bucket=profile['bucket'], Key=key)['Body']
        observed = body.read(len(raw) + 1)
        return 'CONFIRMED' if observed == raw else 'FAILED'
    except Exception:
        return 'UNCERTAIN'
    finally:
        if body is not None and hasattr(body, 'close'):
            body.close()


def observed_receipt(receipt, outcome):
    result = copy.deepcopy(receipt)
    result['delivery'] = outcome
    result['verdict'] = daily.receipt_verdict(result)
    return daily.validate_receipt(result)


def deliver(client, profile, directory, request, receipt):
    key = object_key(profile, request['window'])
    intent = dict(schema='polis-shadow-publication-intent/1', run=request['run'], window=request['window'],
                  receipt_sha256=digest(daily.canonical(receipt)),
                  target_sha256=digest(daily.canonical(dict(bucket=profile['bucket'], key=key, kms_key=profile['kms_key']))))
    fresh = immutable(directory / 'publication-intent.json', intent)
    chain = delivery_chain(directory, receipt, request)
    if chain and chain[-1]['outcome'] in ('CONFIRMED', 'FAILED'):
        return observed_receipt(receipt, chain[-1]['outcome'])
    if len(chain) >= MAX_DELIVERIES:
        raise ValueError('SHADOW_DELIVERY_LIMIT')
    # A persisted intent with no observation may have lost the process after PUT.
    # It must reconcile even if the process actually died before issuing PUT.
    action = 'PUT' if fresh else 'GET'
    outcome = daily.publish(client, profile['bucket'], key, profile['kms_key'], receipt) if fresh else reconcile(client, profile, key, receipt)
    event = dict(schema='polis-shadow-delivery/1', run=request['run'], window=request['window'], sequence=len(chain),
                 action=action, outcome=outcome, receipt_sha256=intent['receipt_sha256'],
                 previous_sha256=digest(daily.canonical(chain[-1])) if chain else None)
    immutable(directory / f'delivery-{len(chain):04d}.json', event)
    return observed_receipt(receipt, outcome)


def run_window(client, profile, state, window, *, collector=run_collector, now=time.time, reconcile_only=False):
    validate_profile(profile)
    root = private_directory(state)
    with locked(root):
        return _run_window(client, profile, root, window, collector=collector, now=now,
                           reconcile_only=reconcile_only)


def _run_window(client, profile, root, window, *, collector=run_collector, now=time.time,
                reconcile_only=False, prepared=False):
    """Caller owns the run lock; prepared applies only to a live owned child."""
    immutable(root / 'schedule.json', profile)
    request = request_for(profile, window)
    if now() < request['start'] - 60:
        raise ValueError('SHADOW_SCHEDULE_NOT_DUE')
    directory = private_directory(root / f'window-{window:05d}')
    request_path = directory / 'request.json'
    if reconcile_only and not (directory / 'publication-intent.json').exists():
        raise ValueError('SHADOW_NO_PUBLICATION_INTENT')
    new_request = immutable(request_path, request)
    receipt_path = directory / 'receipt.json'
    if receipt_path.exists():
        receipt = admit_collected(profile, request, read_json(receipt_path), now())
    else:
        if reconcile_only:
            raise ValueError('SHADOW_NO_PENDING_RECEIPT')
        try:
            if not new_request and not prepared:
                raise ValueError('SHADOW_INTERRUPTED_COLLECTOR')
            receipt = admit_collected(profile, request, collector(profile, request_path, directory / 'collector-output.json'), now())
        except Exception:
            receipt = absent_collector(profile, request)
            daily.validate_receipt(receipt)
        immutable(receipt_path, receipt)
    result = deliver(client, profile, directory, request, receipt)
    if result['verdict'] == 'PASS' and result['delivery'] == 'CONFIRMED':
        immutable(directory / 'confirmed-receipt.json', result)
    return result


def run_daily(client, profile, state, *, start=start_collector, finish=finish_collector,
              now=time.time, monotonic=time.monotonic, sleep=time.sleep, emit=lambda _: None):
    """Prewarm at most the current and next child under one exclusive run lock."""
    validate_profile(profile)
    root = private_directory(state)
    pending = {}
    with locked(root):
        immutable(root / 'schedule.json', profile)
        def prepare(window):
            directory = private_directory(root / f'window-{window:05d}')
            request_path = directory / 'request.json'
            if (directory / 'receipt.json').exists() or request_path.exists():
                return  # A process restart never recaptures an unexplained gap.
            immutable(request_path, request_for(profile, window))
            try:
                process = start(profile, request_path, directory / 'collector-output.json')
            except Exception:
                process = None
            pending[window] = (process, monotonic() + DAY + 120)
        try:
            for window in range(profile['days']):
                due = request_for(profile, window)['start'] - 60
                while now() < due:
                    sleep(min(60, due - now()))
                if window not in pending:
                    prepare(window)
                owned = window in pending
                process, deadline = pending.get(window, (None, None))
                while process is not None and process.poll() is None:
                    if monotonic() >= deadline:
                        stop_process_group(process)
                        break
                    next_window = window + 1
                    if (next_window < profile['days'] and next_window not in pending
                            and now() >= request_for(profile, next_window)['start'] - 60):
                        prepare(next_window)
                    sleep(1)
                def collected(_profile, _request, output):
                    if process is None:
                        raise ValueError('SHADOW_COLLECTOR_FAILED')
                    return finish(process, output)
                result = _run_window(client, profile, root, window, collector=collected,
                                     now=now, prepared=owned)
                pending.pop(window, None)
                emit(dict(run=result['run'], window=window, verdict=result['verdict'], delivery=result['delivery']))
                if result['verdict'] != 'PASS':
                    return 2
            return 0
        finally:
            for process, _deadline in pending.values():
                if process is not None:
                    stop_process_group(process)


def main(argv=None):
    parser = argparse.ArgumentParser(description='Dormant daily shadow scheduler; activation requires --enable.')
    parser.add_argument('action', choices=('run', 'reconcile'))
    parser.add_argument('--enable', action='store_true')
    parser.add_argument('--profile', required=True)
    parser.add_argument('--state', required=True)
    parser.add_argument('--window', type=int)
    args = parser.parse_args(argv)
    if not args.enable:
        print('SHADOW_SCHEDULER_DISABLED', file=sys.stderr)
        return 2
    def interrupted(_signum, _frame):
        raise KeyboardInterrupt()
    previous_term = signal.signal(signal.SIGTERM, interrupted)
    try:
        profile = validate_profile(read_json(args.profile))
        # Existing runtime dependency; neither credentials nor endpoint are accepted in argv.
        import boto3
        from botocore.config import Config
        client = boto3.client('s3', config=Config(connect_timeout=5, read_timeout=10, retries={'max_attempts': 0}))
        emit = lambda value: print(daily.canonical(value).decode(), flush=True)
        if args.action == 'run':
            if args.window is not None:
                raise ValueError('SHADOW_SCHEDULE_WINDOW')
            return run_daily(client, profile, args.state, emit=emit)
        if args.window is None:
            raise ValueError('SHADOW_SCHEDULE_WINDOW')
        receipt = run_window(client, profile, args.state, args.window, reconcile_only=True)
        emit(dict(run=receipt['run'], window=receipt['window'], verdict=receipt['verdict'], delivery=receipt['delivery']))
        return 0 if receipt['verdict'] == 'PASS' else 2
    except (Exception, KeyboardInterrupt):
        print('SHADOW_SCHEDULE_INCOMPLETE', file=sys.stderr)
        return 2
    finally:
        signal.signal(signal.SIGTERM, previous_term)


if __name__ == '__main__':
    raise SystemExit(main())
