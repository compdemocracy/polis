"""P-078 un-flip rehearsal: closed run-spec, digest bindings, verdict rule and receipt.

Dependency-free: the operator, the worker and all three images import it.
Nothing here opens a database, reads the wall clock or calls AWS. The step
machine that talks to the restored copy is unflip_rehearsal_steps.py; the
operator's RDS and Secrets Manager calls are in unflip_operator.py.

The rehearsal proves, on a temporary copy restored from the latest automated
snapshot inside the VPC, that the un-flip transaction (P-078 section 2a, the
held file server/postgres/migrations/held/000024_vote_sign_unflip.sql):

  (a) completes within the measured time, lock and storage footprint,
  (b) refuses a second run by its version guard,
  (c) leaves every semantic fact identical (aggregates, participant hashes,
      served pca2 bytes, cold engine rebuilds, exports),
  (d) and that the restore rule brings a pre-flip copy to version 1.

The receipt carries counts, durations, digests and fixed verdict names only:
no snapshot or instance identifier, no conversation id, no hostname, no text.
The snapshot and the temporary endpoint enter the job only as sha256.

    python3 ci/probe_box/unflip_rehearsal.py --print-sql        # the bound queries (day blocks marked)
    python3 ci/probe_box/unflip_rehearsal.py --print-migration  # the held migration, its digests
"""
from __future__ import annotations

import hashlib
import json
import math
import re
from pathlib import Path

KIND = 'unflip-rehearsal'
RECEIPT_SCHEMA = 'polis-unflip-rehearsal-receipt/1'
STATE_SCHEMA = 'polis-unflip-rehearsal-state/1'
LIMIT = 16384

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
MIGRATION_NAME = '000024_vote_sign_unflip'
MIGRATION_PATH = REPO / 'server/postgres/migrations/held' / (MIGRATION_NAME + '.sql')
QUERIES_PATH = HERE / 'unflip_rehearsal_queries.sql'
# PR-A is not on edge yet; the tests bind this stand-in (see its header).
CONVENTION_STANDIN_PATH = HERE / 'fixtures/unflip/vote_convention_standin.sql'
LEDGER_MARKER = b'-- ledger-self-checksum'

MODES = ('dry', 'flip')
VERDICTS = ('PASS', 'REFUSE', 'INCOMPLETE')
ASSERTIONS = ('aggregates', 'hashes', 'pca2', 'math', 'exports', 'convention_version', 'insert_roundtrip')
# A dry run keeps the copy unchanged (ROLLBACK); after it, these three are
# re-read and must equal the pre recording. The rest belong to a committed flip.
DRY_ASSERTIONS = ('aggregates', 'hashes', 'convention_version')
OUTCOMES = ('PASS', 'FAIL', 'NOT_COLLECTED')
RULE_OUTCOMES = ('PASS', 'REFUSE', 'NOT_RUN')
# Why the step machine stopped or the run cannot pass. Closed names only.
REFUSALS = ('SNAPSHOT_STALE', 'SERVER_VERSION', 'SUPERUSER_SESSION', 'STORAGE_HEADROOM', 'RESTORE_SHAPE',
            'DDL_DIGEST', 'MIGRATION_DIGEST', 'QUERIES_DIGEST', 'CONVENTION_STATE', 'CERTIFICATION_MISSING',
            'LOCK_BUDGET', 'WALL_BUDGET', 'MIGRATION_FAILED', 'RERUN_NOT_REFUSED', 'COLLECTION_FAILED')
# The SQLSTATE the held file raises at its version guard.
GUARD_SQLSTATE = 'P0785'
# The plan's estimate is 10-30 min on db.t3.large; three times the top is the budget.
WALL_BUDGET_SECONDS = 5400
SERVER_MAJOR = 17
# The engine's cold rebuilds publish under this label; nothing serves it.
ENGINE_LABEL = 'probe'

HEX64 = re.compile('[a-f0-9]{64}')
IMAGE = re.compile('sha256:[a-f0-9]{64}')
INSTANCE_CLASS = re.compile(r'db\.[a-z0-9]{2,12}\.[a-z0-9]{3,12}')
SQLSTATE_CLASS = re.compile('[0-9A-Z]{2}')
MS_FLOOR, MS_CEILING = 1_500_000_000_000, 4_000_000_000_000
ZERO = '0' * 64


def encoded(v) -> bytes:
    return json.dumps(v, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode()


def digest(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def fail(code='UNFLIP_SCHEMA'):
    raise ValueError(code)


def closed(v, keys):
    if type(v) is not dict or set(v) != set(keys):
        fail()
    return v


def integer(v, low=0, high=2**53 - 1, code='UNFLIP_COUNT'):
    if type(v) is not int or not low <= v <= high:
        fail(code)
    return v


def signed(v):
    return integer(v, -(2**53 - 1), 2**53 - 1)


def seconds(v, nullable=False):
    if v is None and nullable:
        return v
    if type(v) not in (int, float) or type(v) is bool or not math.isfinite(v) or not 0 <= v <= 10**7:
        fail('UNFLIP_DURATION')
    return v


def hexdigest(v, nullable=False):
    if v is None and nullable:
        return v
    if type(v) is not str or not HEX64.fullmatch(v):
        fail('UNFLIP_DIGEST')
    return v


def boolean(v):
    if type(v) is not bool:
        fail()
    return v


# ---------------------------------------------------------------------------
# The held migration and the bound queries.
# ---------------------------------------------------------------------------
def ledger_checksum(raw: bytes) -> str:
    """sha256 of the file with its one ledger-self-checksum line removed (PR-A rule)."""
    lines = raw.split(b'\n')
    if sum(LEDGER_MARKER in line for line in lines) != 1:
        fail('UNFLIP_LEDGER_MARKER')
    return digest(b'\n'.join(line for line in lines if LEDGER_MARKER not in line))


def migration_body(raw: bytes) -> str:
    """The statements between the file's own BEGIN; and COMMIT; lines.

    The dry mode runs exactly these inside a transaction it rolls back; the
    flip mode runs the whole file. Exactly one BEGIN; and one COMMIT; line,
    in that order, with nothing but comments and blank lines outside them."""
    lines = raw.decode('utf-8').split('\n')
    begins = [i for i, line in enumerate(lines) if line.strip() == 'BEGIN;']
    commits = [i for i, line in enumerate(lines) if line.strip() == 'COMMIT;']
    if len(begins) != 1 or len(commits) != 1 or begins[0] >= commits[0]:
        fail('UNFLIP_MIGRATION_SHAPE')
    outside = lines[:begins[0]] + lines[commits[0] + 1:]
    if any(line.strip() and not line.lstrip().startswith('--') for line in outside):
        fail('UNFLIP_MIGRATION_SHAPE')
    return '\n'.join(lines[begins[0] + 1:commits[0]]) + '\n'


NAME = re.compile(r'-- name: ([a-z_]+)( \(day\))?')


def parse_queries(raw: bytes) -> dict:
    """{name: (sql, day)} from the bound queries file; names unique, bodies non-empty."""
    out, current, body, day = {}, None, [], False

    def close():
        if current is not None:
            sql = '\n'.join(body).strip()
            if not sql or current in out:
                fail('UNFLIP_QUERIES_SHAPE')
            out[current] = (sql, day)
    for line in raw.decode('utf-8').split('\n'):
        m = NAME.fullmatch(line.strip())
        if m:
            close()
            current, body, day = m.group(1), [], bool(m.group(2))
        elif current is not None and not line.lstrip().startswith('--'):
            body.append(line)
    close()
    if not REQUIRED_QUERIES <= set(out):
        fail('UNFLIP_QUERIES_SHAPE')
    return out


ROLLED_BACK = ('insert_roundtrip', 'insert_readback')


def render_queries(raw: bytes) -> str:
    """The bound queries for reading and for the production day: each block
    under its name, day blocks marked, and the vote_insert round trip only ever
    wrapped in BEGIN; ... ROLLBACK; (rehearsal copies only, never production)."""
    q = parse_queries(raw)
    out = []
    for name, (sql, day) in q.items():
        if name == ROLLED_BACK[1]:
            continue
        if name == ROLLED_BACK[0]:
            out.append('-- name: insert_roundtrip + insert_readback (rehearsal copies only; NEVER on production;\n'
                       '--   it would overwrite a real participant\'s vote. Always rolled back.)\n'
                       f'BEGIN;\n{sql}\n{q[ROLLED_BACK[1]][0]}\nROLLBACK;\n')
            continue
        out.append(f'-- name: {name}{" (day)" if day else ""}\n{sql}\n')
    return '\n'.join(out)


REQUIRED_QUERIES = frozenset({
    'session', 'objects', 'convention', 'unflip_ledger', 'database_bytes', 'raw_counts', 'totals',
    'aggregates_votes', 'aggregates_latest', 'participant_hashes', 'sizes', 'wal_lsn', 'wal_since', 'backend',
    'lock_sample', 'cancel_backend', 'certification', 'certification_handles', 'sample', 'insert_target', 'insert_roundtrip',
    'insert_readback', 'engine_rows', 'engine_clear', 'restore_detection'})


# ---------------------------------------------------------------------------
# Run-spec: the operator's closed parameters. Identifiers never enter it.
# ---------------------------------------------------------------------------
RUN_SPEC = ('mode', 'restore_rule', 'snapshot_sha256', 'snapshot_created_ms', 'max_snapshot_age_seconds',
            'db_host_sha256', 'r2_host_sha256', 'instance_class', 'storage_type', 'allocated_storage_gb',
            'min_free_storage_gb', 'sample_conversations', 'certification_conversations', 'certification_sha256',
            'lock_wait_budget_ms', 'migration_sql_sha256', 'convention_ddl_sha256', 'queries_sha256',
            'server_image', 'engine_image', 'restore_observed')
RESTORE_OBSERVED = ('duration_s', 'storage_growth_s', 'instance_class', 'storage_type', 'allocated_storage_gb')
STORAGE_TYPES = ('gp2', 'gp3', 'io1', 'io2')
SNAPSHOT_AGE = (3600, 129600)

# The certification digests are sha256 of the public conversation ids the
# operator names at restore time; the template's are placeholders.
TEMPLATE_CERTIFICATION = ['1' * 64, '2' * 64]
TEMPLATE_RUN_SPEC = {
    'mode': 'flip', 'restore_rule': True, 'snapshot_sha256': ZERO, 'snapshot_created_ms': MS_FLOOR,
    'max_snapshot_age_seconds': 129600, 'db_host_sha256': ZERO, 'r2_host_sha256': ZERO,
    'instance_class': 'db.t3.large', 'storage_type': 'gp3', 'allocated_storage_gb': 60,
    'min_free_storage_gb': 30, 'sample_conversations': 200, 'certification_conversations': 2,
    'certification_sha256': TEMPLATE_CERTIFICATION, 'lock_wait_budget_ms': 30000,
    'migration_sql_sha256': ZERO, 'convention_ddl_sha256': ZERO, 'queries_sha256': ZERO,
    'server_image': 'sha256:' + ZERO, 'engine_image': 'sha256:' + ZERO,
    'restore_observed': {'duration_s': 0, 'storage_growth_s': 0, 'instance_class': 'db.t3.large',
                         'storage_type': 'gp3', 'allocated_storage_gb': 60}}


def validate_run_spec(v):
    s = closed(v, RUN_SPEC)
    if s['mode'] not in MODES:
        fail('UNFLIP_MODE')
    boolean(s['restore_rule'])
    if s['mode'] == 'dry' and s['restore_rule']:
        # The restore rule needs a committed flip beside it; a dry run never has one.
        fail('UNFLIP_MODE')
    for k in ('snapshot_sha256', 'db_host_sha256', 'migration_sql_sha256', 'convention_ddl_sha256',
              'queries_sha256'):
        hexdigest(s[k])
    if s['restore_rule']:
        hexdigest(s['r2_host_sha256'])
        if s['r2_host_sha256'] == s['db_host_sha256'] != ZERO:
            fail('UNFLIP_HOST')
    elif s['r2_host_sha256'] is not None:
        fail('UNFLIP_HOST')
    integer(s['snapshot_created_ms'], MS_FLOOR, MS_CEILING, 'UNFLIP_CLOCK')
    integer(s['max_snapshot_age_seconds'], *SNAPSHOT_AGE)
    if type(s['instance_class']) is not str or not INSTANCE_CLASS.fullmatch(s['instance_class']):
        fail('UNFLIP_INSTANCE')
    if s['storage_type'] not in STORAGE_TYPES:
        fail('UNFLIP_INSTANCE')
    integer(s['allocated_storage_gb'], 20, 16384)
    integer(s['min_free_storage_gb'], 1, s['allocated_storage_gb'])
    integer(s['certification_conversations'], 0, 8)
    integer(s['sample_conversations'], max(1, s['certification_conversations']), 5000)
    if s['mode'] == 'flip' and s['certification_conversations'] < 1:
        # pca2 and the exports are compared on the certification conversations.
        fail('UNFLIP_CERTIFICATION')
    c = s['certification_sha256']
    if (type(c) is not list or len(c) != s['certification_conversations']
            or any(type(x) is not str or not HEX64.fullmatch(x) for x in c) or c != sorted(set(c))):
        fail('UNFLIP_CERTIFICATION')
    integer(s['lock_wait_budget_ms'], 100, 60000)
    for k in ('server_image', 'engine_image'):
        if type(s[k]) is not str or not IMAGE.fullmatch(s[k]):
            fail('UNFLIP_IMAGE')
    o = closed(s['restore_observed'], RESTORE_OBSERVED)
    seconds(o['duration_s'])
    seconds(o['storage_growth_s'])
    if type(o['instance_class']) is not str or not INSTANCE_CLASS.fullmatch(o['instance_class']):
        fail('UNFLIP_INSTANCE')
    if o['storage_type'] not in STORAGE_TYPES:
        fail('UNFLIP_INSTANCE')
    integer(o['allocated_storage_gb'], 20, 16384)
    return s


def placeholder(spec) -> bool:
    """A registry template: the all-zero digests are never launched."""
    return (ZERO in (spec['snapshot_sha256'], spec['db_host_sha256'], spec['migration_sql_sha256'],
                     spec['convention_ddl_sha256'], spec['queries_sha256'], spec['server_image'][7:],
                     spec['engine_image'][7:], spec['r2_host_sha256'])
            or spec['snapshot_created_ms'] == MS_FLOOR
            or any(x in TEMPLATE_CERTIFICATION for x in spec['certification_sha256']))


def restore_shape(spec):
    o = spec['restore_observed']
    return (o['instance_class'] == spec['instance_class'],
            o['storage_type'] == spec['storage_type'] and o['allocated_storage_gb'] >= spec['allocated_storage_gb'])


# The stack's rehearsal secret: written by the operator's restore step, read by
# the worker. One copy (and `r2` when the restore rule runs), each bound to the
# job by the sha256 of its host. The relay on the box reaches port 5432 only.
SECRET = ('host', 'port', 'dbname', 'username', 'password')


def validate_secret(doc, spec):
    def one(d, host_sha):
        if (type(d) is not dict or set(d) != set(SECRET) or type(d['port']) is not int or d['port'] != 5432
                or any(type(d[k]) is not str or not d[k] or len(d[k]) > 256
                       or any(c in d[k] for c in '\r\n\0') for k in ('host', 'dbname', 'username', 'password'))):
            fail('SECRET_SHAPE')
        if digest(d['host'].encode()) != host_sha:
            fail('HOST_BINDING')
        return dict(d)
    if type(doc) is not dict or set(doc) != set(SECRET) | ({'r2'} if spec['restore_rule'] else set()):
        fail('SECRET_SHAPE')
    out = one({k: doc[k] for k in SECRET}, spec['db_host_sha256'])
    if spec['restore_rule']:
        out['r2'] = one(doc['r2'], spec['r2_host_sha256'])
    return out


# ---------------------------------------------------------------------------
# The receipt.
# ---------------------------------------------------------------------------
RECEIPT = ('schema', 'kind', 'job_sha256', 'run_id', 'mode', 'verdict', 'snapshot_sha256', 'snapshot_age_s',
           'restore', 'convention_ddl_applied', 'pre', 'migrate', 'rerun_refused', 'rerun_sqlstate_class', 'post',
           'assertions', 'restore_rule', 'refusals', 'cleanup_confirmed')
RESTORE = ('duration_s', 'storage_growth_s', 'class_ok', 'storage_ok', 'free_storage_gb_before')
SECTION = ('conversations', 'participants', 'votes', 'votes_latest', 'agg_sha256', 'hashes_sha256', 'pca2_cases',
           'pca2_sha256', 'math_zids', 'math_sha256', 'exports_sha256', 'lsn_before_sha256')
MIGRATE = ('wall_s', 'wal_bytes', 'max_lock_waiters', 'max_lock_wait_ms', 'heap_growth_bytes',
           'index_growth_bytes', 'dead_tuples_after', 'counts_mirrored', 'vacuum_s')


def validate_section(v):
    if v is None:
        return v
    s = closed(v, SECTION)
    for k in ('conversations', 'participants', 'votes', 'votes_latest', 'pca2_cases', 'math_zids'):
        integer(s[k])
    hexdigest(s['agg_sha256'])
    hexdigest(s['hashes_sha256'])
    hexdigest(s['lsn_before_sha256'])
    for count_key, digest_key in (('pca2_cases', 'pca2_sha256'), ('math_zids', 'math_sha256')):
        hexdigest(s[digest_key], nullable=True)
        if (s[count_key] == 0) != (s[digest_key] is None):
            fail('UNFLIP_SECTION')
    hexdigest(s['exports_sha256'], nullable=True)
    return s


def validate_migrate(v, mode):
    if v is None:
        return v
    m = closed(v, MIGRATE)
    seconds(m['wall_s'])
    for k in ('wal_bytes', 'max_lock_waiters', 'max_lock_wait_ms', 'dead_tuples_after'):
        integer(m[k])
    signed(m['heap_growth_bytes'])
    signed(m['index_growth_bytes'])
    boolean(m['counts_mirrored'])
    seconds(m['vacuum_s'], nullable=True)
    if mode == 'dry' and m['vacuum_s'] is not None:
        fail('UNFLIP_MODE')
    return m


def rule_expected(spec):
    return 'PASS' if spec['restore_rule'] else 'NOT_RUN'


def expected_verdict(r, spec):
    """REFUSE on any refusal or failed condition; INCOMPLETE when a stage was not
    reached without a named refusal; PASS only when every condition holds."""
    if r['refusals']:
        return 'REFUSE'
    if r['pre'] is None or r['migrate'] is None or r['post'] is None or r['snapshot_age_s'] is None:
        return 'INCOMPLETE'
    a, m, restore = r['assertions'], r['migrate'], r['restore']
    required = ASSERTIONS if r['mode'] == 'flip' else DRY_ASSERTIONS
    if any(a[k] != 'PASS' for k in required):
        return 'REFUSE'
    if r['mode'] == 'dry' and any(a[k] != 'NOT_COLLECTED' for k in ASSERTIONS if k not in DRY_ASSERTIONS):
        return 'REFUSE'
    if (not m['counts_mirrored'] or not r['rerun_refused'] or m['max_lock_wait_ms'] > spec['lock_wait_budget_ms']
            or m['wall_s'] > WALL_BUDGET_SECONDS or r['snapshot_age_s'] > spec['max_snapshot_age_seconds']
            or not restore['class_ok'] or not restore['storage_ok'] or restore['free_storage_gb_before'] is None
            or restore['free_storage_gb_before'] < spec['min_free_storage_gb']):
        return 'REFUSE'
    if r['restore_rule'] != rule_expected(spec):
        return 'REFUSE'
    return 'PASS'


def passed(r):
    return r['verdict'] == 'PASS'


def validate_receipt(r, job):
    from receipt import sha
    closed(r, RECEIPT)
    if (r['schema'] != RECEIPT_SCHEMA or r['kind'] != KIND or job.get('kind') != KIND
            or r['run_id'] != job['run_id'] or r['job_sha256'] != sha(job)):
        fail('UNFLIP_BINDING')
    spec = validate_run_spec(job['run_spec'])
    if r['mode'] != spec['mode'] or r['snapshot_sha256'] != spec['snapshot_sha256']:
        fail('UNFLIP_BINDING')
    if r['verdict'] not in VERDICTS:
        fail('UNFLIP_VERDICT')
    seconds(r['snapshot_age_s'], nullable=True)
    restore = closed(r['restore'], RESTORE)
    seconds(restore['duration_s'])
    seconds(restore['storage_growth_s'])
    if (restore['class_ok'], restore['storage_ok']) != restore_shape(spec):
        fail('UNFLIP_BINDING')
    if (restore['duration_s'], restore['storage_growth_s']) != (spec['restore_observed']['duration_s'],
                                                                spec['restore_observed']['storage_growth_s']):
        fail('UNFLIP_BINDING')
    seconds(restore['free_storage_gb_before'], nullable=True)
    boolean(r['convention_ddl_applied'])
    validate_section(r['pre'])
    validate_section(r['post'])
    validate_migrate(r['migrate'], r['mode'])
    boolean(r['rerun_refused'])
    if r['rerun_sqlstate_class'] != 'NONE' and (type(r['rerun_sqlstate_class']) is not str
                                                or not SQLSTATE_CLASS.fullmatch(r['rerun_sqlstate_class'])):
        fail('UNFLIP_SQLSTATE')
    if r['rerun_refused'] and r['rerun_sqlstate_class'] != GUARD_SQLSTATE[:2]:
        fail('UNFLIP_SQLSTATE')
    a = closed(r['assertions'], ASSERTIONS)
    if any(x not in OUTCOMES for x in a.values()):
        fail('UNFLIP_ASSERTION')
    if r['restore_rule'] not in RULE_OUTCOMES:
        fail('UNFLIP_RULE')
    if spec['mode'] == 'dry' and r['restore_rule'] != 'NOT_RUN':
        fail('UNFLIP_RULE')
    f = r['refusals']
    if type(f) is not list or any(x not in REFUSALS for x in f) or f != sorted(set(f)):
        fail('UNFLIP_REFUSAL')
    boolean(r['cleanup_confirmed'])
    if r['verdict'] != expected_verdict(r, spec):
        fail('UNFLIP_FALSE_PASS')
    if len(encoded(r)) > LIMIT:
        fail('UNFLIP_LIMIT')
    return r


# ---------------------------------------------------------------------------
# The verifier's reduction of the box-local state to the receipt.
# ---------------------------------------------------------------------------
def cases_digest(cases):
    """Digest of a {key: sha256} case map; None when nothing was collected."""
    if not cases:
        return None
    return digest(encoded(sorted(cases.items())))


def compare(pre, post):
    if pre is None or post is None:
        return 'NOT_COLLECTED'
    return 'PASS' if pre == post else 'FAIL'


def compare_cases(pre, post):
    if not pre and not post:
        return 'NOT_COLLECTED'
    return 'PASS' if pre and pre == post else 'FAIL'


def section(rec, cases):
    """The receipt section of one recording (pre or post) and its case maps."""
    if rec is None:
        return None
    cases = cases or {}
    return {'conversations': rec['conversations'], 'participants': rec['participants'], 'votes': rec['votes'],
            'votes_latest': rec['votes_latest'], 'agg_sha256': rec['agg_sha256'],
            'hashes_sha256': rec['hashes_sha256'], 'pca2_cases': len(cases.get('pca2') or {}),
            'pca2_sha256': cases_digest(cases.get('pca2')), 'math_zids': len(cases.get('math') or {}),
            'math_sha256': cases_digest(cases.get('math')), 'exports_sha256': cases_digest(cases.get('exports')),
            'lsn_before_sha256': rec['lsn_before_sha256']}


def assertions(state, mode):
    pre, post = state.get('pre'), state.get('post')
    pre_cases, post_cases = state.get('pre_cases') or {}, state.get('post_cases') or {}
    out = dict.fromkeys(ASSERTIONS, 'NOT_COLLECTED')
    if pre is not None and post is not None:
        out['aggregates'] = compare((pre['agg_sha256'], pre['conversations'], pre['votes'], pre['votes_latest']),
                                    (post['agg_sha256'], post['conversations'], post['votes'], post['votes_latest']))
        out['hashes'] = compare((pre['hashes_sha256'], pre['participants']),
                                (post['hashes_sha256'], post['participants']))
    if mode == 'flip' and post is not None:
        for name in ('pca2', 'math', 'exports'):
            out[name] = compare_cases(pre_cases.get(name), post_cases.get(name))
    convention = state.get('convention_after')
    if convention is not None:
        out['convention_version'] = 'PASS' if tuple(convention) == ((1, 1) if mode == 'flip' else (0, -1)) else 'FAIL'
    if mode == 'flip':
        out['insert_roundtrip'] = state.get('insert_roundtrip') or 'NOT_COLLECTED'
    return out


STATE = ('schema', 'preflight', 'pre', 'pre_cases', 'migrate', 'rerun', 'post', 'post_cases', 'convention_after',
         'insert_roundtrip', 'restore_rule', 'refusals', 'zids')


def empty_state():
    return {'schema': STATE_SCHEMA, 'preflight': None, 'pre': None, 'pre_cases': {}, 'migrate': None,
            'rerun': None, 'post': None, 'post_cases': {}, 'convention_after': None, 'insert_roundtrip': None,
            'restore_rule': 'NOT_RUN', 'refusals': [], 'zids': None}


MAX_STATE_BYTES = 4 * 1024 * 1024


def decode_state(raw):
    """The box-local state between containers: closed keys, no duplicate keys."""
    if len(raw) > MAX_STATE_BYTES:
        fail('UNFLIP_STATE')

    def pairs(items):
        out = {}
        for k, v in items:
            if k in out:
                fail('UNFLIP_STATE')
            out[k] = v
        return out
    try:
        state = json.loads(raw, object_pairs_hook=pairs, parse_constant=lambda _: fail('UNFLIP_STATE'))
    except (UnicodeError, json.JSONDecodeError, RecursionError):
        fail('UNFLIP_STATE')
    closed(state, STATE)
    if state['schema'] != STATE_SCHEMA:
        fail('UNFLIP_STATE')
    return state


ENGINE = ('which', 'math', 'refusals')


def engine_output(state, which):
    """What the producer hands the verifier for one rebuild (pre or post)."""
    return {'which': which, 'math': (state[which + '_cases'] or {}).get('math') or {},
            'refusals': sorted(set(state['refusals']))}


def merge_engine(state, doc):
    """The verifier's merge of one producer output into the reader's state."""
    closed(doc, ENGINE)
    if doc['which'] not in ('pre', 'post'):
        fail('UNFLIP_ENGINE')
    math_cases = doc['math']
    if (type(math_cases) is not dict or any(not HEX64.fullmatch(k) or type(v) is not str or not HEX64.fullmatch(v)
                                            for k, v in math_cases.items())):
        fail('UNFLIP_ENGINE')
    if type(doc['refusals']) is not list or any(x not in REFUSALS for x in doc['refusals']):
        fail('UNFLIP_ENGINE')
    if math_cases:
        state[doc['which'] + '_cases'] = dict(state[doc['which'] + '_cases'] or {}, math=math_cases)
    state['refusals'] = sorted(set(state['refusals']) | set(doc['refusals']))
    return state


def build_receipt(state, job):
    from receipt import sha
    closed(state, STATE)
    if state['schema'] != STATE_SCHEMA:
        fail('UNFLIP_STATE')
    spec = validate_run_spec(job['run_spec'])
    mode = spec['mode']
    pre_flight = state['preflight'] or {}
    class_ok, storage_ok = restore_shape(spec)
    rerun = state['rerun'] or {'refused': False, 'sqlstate_class': 'NONE'}
    r = {'schema': RECEIPT_SCHEMA, 'kind': KIND, 'job_sha256': sha(job), 'run_id': job['run_id'], 'mode': mode,
         'verdict': 'INCOMPLETE', 'snapshot_sha256': spec['snapshot_sha256'],
         'snapshot_age_s': pre_flight.get('snapshot_age_s'),
         'restore': {'duration_s': spec['restore_observed']['duration_s'],
                     'storage_growth_s': spec['restore_observed']['storage_growth_s'],
                     'class_ok': class_ok, 'storage_ok': storage_ok,
                     'free_storage_gb_before': pre_flight.get('free_storage_gb')},
         'convention_ddl_applied': bool(pre_flight.get('convention_ddl_applied')),
         'pre': section(state['pre'], state['pre_cases']),
         'migrate': state['migrate'],
         'rerun_refused': rerun['refused'], 'rerun_sqlstate_class': rerun['sqlstate_class'],
         'post': section(state['post'], state['post_cases'] if mode == 'flip' else {}),
         'assertions': assertions(state, mode),
         'restore_rule': state['restore_rule'] if mode == 'flip' else 'NOT_RUN',
         'refusals': sorted(set(state['refusals'])), 'cleanup_confirmed': False}
    r['verdict'] = expected_verdict(r, spec)
    return validate_receipt(r, job)


# ---------------------------------------------------------------------------
# Operator-side helpers that read local files only.
# ---------------------------------------------------------------------------
def file_digests():
    return {'migration_sql_sha256': digest(MIGRATION_PATH.read_bytes()),
            'queries_sha256': digest(QUERIES_PATH.read_bytes())}


def main(argv=None):
    import argparse
    import sys
    p = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument('--print-sql', action='store_true', help='print the bound queries file and its sha256')
    g.add_argument('--print-migration', action='store_true',
                   help='print the held migration, its sha256 and its ledger checksum')
    a = p.parse_args(argv)
    if a.print_sql:
        raw = QUERIES_PATH.read_bytes()
        sys.stdout.write(f'-- queries_sha256 {digest(raw)}\n')
        sys.stdout.write(render_queries(raw))
    else:
        raw = MIGRATION_PATH.read_bytes()
        migration_body(raw)
        sys.stdout.write(f'-- migration_sql_sha256 {digest(raw)}\n-- ledger_checksum {ledger_checksum(raw)}\n')
        sys.stdout.write(raw.decode('utf-8'))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
