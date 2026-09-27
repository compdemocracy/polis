"""P-067 light-shadow daily comparison: closed policy, run-spec, pairing and receipt.

Dependency-free: the supervisor, the operator and all three images import it.
Nothing here reads a database, an engine or a file. The receipt carries fixed
tokens, counts and worst deltas: no conversation ids, row payloads, text or
digests of private rows. Tolerance is never defined here; the images apply
the certified G12 walk (ci/private_cert/images/g12.py) to paired rows.
"""
from __future__ import annotations
import hashlib
import json
import math
import re

from light_shadow_queries import QUERIES, PROD, DEFAULT_SHADOW, MAX_CONVERSATIONS
from receipt import LEGACY_EMPTY_KEYS

KIND = 'light-shadow-compare'
LIMIT = 131072
PAIRING = ('PAIRED', 'UNPAIRED')
UNPAIRED_REASONS = ('NO-PROD-ROW', 'NO-SHADOW-ROW', 'TIMESTAMPS', 'TOTALS')
OUTCOMES = ('PASS', 'NEAR-TIE', 'HISTORY-DIVERGENCE', 'FAIL')
# Existing closed name, spelled as the certified gate and receipt.py spell it.
EMPTY_DEFECT = 'legacy-defect-empty-omits-keys'
LEGACY_DEFECTS = (EMPTY_DEFECT,)
# The certified paired gate's policy (gate.POLICY; NEAR_TIE_POLICY.md).
CERTIFICATION_POLICY = '3dfbdedd33d0c65f5708e4c1622a648abd8e3c89596d2818e6c5f6c4f5871aef'
# Equal on both rows before a pair is compared. Never math_tick/caching_tick.
PAIR_TIMESTAMPS = ('lastVoteTimestamp', 'lastModTimestamp')
PAIR_TOTALS = ('n', 'user-vote-counts', 'n-cmts')
# Declared exclusions: independent per-writer counters, never compared.
EXCLUDED_FIELDS = ('caching_tick', 'math_tick')
UNCOVERED_TABLES = ('math_bidtopid', 'math_ptptstats')
COVERED = ('conversations.created', 'math_main', 'math_ticks')
# certify.ACCEPTANCE_KEYS (prep-main minus the subgroup trio), asserted equal
# by the image tests; `row-schema` names a row that failed raw validation.
ACCEPTANCE_KEYS = ('base-clusters', 'comment-priorities', 'consensus', 'group-aware-consensus',
                   'group-clusters', 'group-votes', 'in-conv', 'lastModTimestamp', 'lastVoteTimestamp',
                   'meta-tids', 'mod-in', 'mod-out', 'n', 'n-cmts', 'pca', 'repness', 'tids',
                   'user-vote-counts', 'votes-base', 'zid')
DIFF_NAMES = ACCEPTANCE_KEYS + ('row-schema',)
# The closure the accepted-tie names cover (legacy_pca.DOWNSTREAM_KEYS): base
# and group clustering and everything computed from groups.
NEAR_TIE_KEYS = frozenset({'base-clusters', 'group-clusters', 'votes-base', 'group-votes',
                           'repness', 'group-aware-consensus', 'comment-priorities'})
# History-dependent: the PCA continuation plus that closure.
HISTORY_KEYS = NEAR_TIE_KEYS | {'pca'}
# certify._DECLARED_ALIAS_FIELDS: only the Python engine writes this twin. A
# row labelled prod that carries it means a Python writer used MATH_ENV=prod.
PYTHON_TWIN = 'group_clusters'
STATUS = ('COMPLETE', 'NOT_VISIBLE', 'LIMIT_EXCEEDED')
CONTROLS = (
    # Live checks on this run's own snapshot.
    'prod-rows-unchanged', 'shadow-label-not-prod',
    # Fixed self-tests of the refusal paths.
    'empty-result-refused', 'forged-evidence-refused', 'forged-projection-refused',
    'prod-label-refused', 'identifier-field-refused', 'content-field-refused',
    'wrong-kind-refused', 'wrong-image-refused', 'wrong-policy-refused', 'false-pass-refused',
    'count-mismatch-refused',
    # Fixed classification vectors.
    'pair-timestamps', 'pair-totals', 'class-pass', 'class-near-tie', 'class-history',
    'class-fail', 'class-legacy-empty')
LIVE_CONTROLS = CONTROLS[:2]
MS_FLOOR, MS_CEILING = 1_500_000_000_000, 4_000_000_000_000
MIN_WINDOW, MAX_WINDOW = 3600, 7 * 86400
LABEL = re.compile(r'[a-z][a-z0-9_-]{0,31}')

POLICY = {'schema': 'polis-light-shadow-policy/1', 'prod': PROD, 'pairing': list(PAIRING),
          'unpaired_reasons': list(UNPAIRED_REASONS), 'outcomes': list(OUTCOMES),
          'legacy_defects': list(LEGACY_DEFECTS), 'certification_policy': CERTIFICATION_POLICY,
          'pair_timestamps': list(PAIR_TIMESTAMPS), 'pair_totals': list(PAIR_TOTALS),
          'excluded_fields': list(EXCLUDED_FIELDS), 'uncovered_tables': list(UNCOVERED_TABLES),
          'covered': list(COVERED), 'diff_names': list(DIFF_NAMES),
          'near_tie_keys': sorted(NEAR_TIE_KEYS), 'history_keys': sorted(HISTORY_KEYS),
          'python_twin': PYTHON_TWIN, 'controls': list(CONTROLS),
          'max_conversations': MAX_CONVERSATIONS, 'max_bytes': LIMIT}


def encoded(v):
    return json.dumps(v, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode()


POLICY_SHA = hashlib.sha256(encoded({'policy': POLICY, 'queries': QUERIES})).hexdigest()
MAX_PROJECTION_BYTES = 8 * 1024**3


def fail(code='SHADOW_SCHEMA'):
    raise ValueError(code)


def decode(raw, limit=MAX_PROJECTION_BYTES):
    """Box-local JSON: duplicate keys and non-finite numbers are refused."""
    if len(raw) > limit:
        fail('SHADOW_LIMIT')

    def pairs(items):
        out = {}
        for k, v in items:
            if k in out:
                fail('SHADOW_DUPLICATE_KEY')
            out[k] = v
        return out

    def constant(_):
        fail('SHADOW_NONFINITE')
    try:
        return json.loads(raw, object_pairs_hook=pairs, parse_constant=constant)
    except (UnicodeError, json.JSONDecodeError, RecursionError):
        fail('SHADOW_JSON')


def closed(v, keys):
    if type(v) is not dict or set(v) != set(keys):
        fail()
    return v


def integer(v, low=0, high=2**31 - 1, code='SHADOW_COUNT'):
    if type(v) is not int or not low <= v <= high:
        fail(code)
    return v


def delta(v):
    """A worst delta: null, or a finite non-negative float with four significant digits."""
    if v is None:
        return None
    if type(v) is not float or not math.isfinite(v) or v < 0 or v != rounded(v):
        fail('SHADOW_DELTA')
    return v


def rounded(v):
    return float(f'{v:.3e}')


# ---------------------------------------------------------------------------
# Run-spec: operator inputs carried in the admitted job. No ids, no free text.
# ---------------------------------------------------------------------------
RUN_SPEC = ('shadow_env', 'shadow_started_ms', 'window_seconds', 'engine_commit', 'engine_image')
# The registry template's run-spec; the operator replaces it (and run_id).
TEMPLATE_RUN_SPEC = {'shadow_env': DEFAULT_SHADOW, 'shadow_started_ms': MS_FLOOR,
                     'window_seconds': 86400, 'engine_commit': '0' * 40,
                     'engine_image': 'sha256:' + '0' * 64}


def validate_run_spec(v):
    closed(v, RUN_SPEC)
    label = v['shadow_env']
    # The served label is refused, whatever else the operator states.
    if type(label) is not str or LABEL.fullmatch(label) is None or label == PROD:
        fail('SHADOW_ENV')
    integer(v['shadow_started_ms'], MS_FLOOR, MS_CEILING, 'SHADOW_RUN_SPEC')
    integer(v['window_seconds'], MIN_WINDOW, MAX_WINDOW, 'SHADOW_RUN_SPEC')
    if type(v['engine_commit']) is not str or not re.fullmatch('[a-f0-9]{40}', v['engine_commit']):
        fail('SHADOW_RUN_SPEC')
    if type(v['engine_image']) is not str or not re.fullmatch('sha256:[a-f0-9]{64}', v['engine_image']):
        fail('SHADOW_RUN_SPEC')
    return dict(v)


# ---------------------------------------------------------------------------
# Pairing (P-067 section 4). Reads only the pairing fields of each blob.
# ---------------------------------------------------------------------------
MISSING = object()


def field(blob, key):
    """Kebab spelling first; the Python engine also writes snake twins."""
    if key in blob:
        return blob[key]
    return blob.get(key.replace('-', '_'), MISSING)


def _count(v):
    return v is MISSING or (type(v) is int and v >= 0)


def totals(blob):
    """(n, sum of user-vote-counts, n-cmts); MISSING where a key is absent; None if malformed."""
    n, votes, comments = (field(blob, k) for k in PAIR_TOTALS)
    if not (_count(n) and _count(comments)):
        return None
    if votes is not MISSING:
        if type(votes) is not dict or any(type(c) is not int or c < 0 for c in votes.values()):
            return None
        votes = sum(votes.values())
    return n, votes, comments


def empty_omission(prod, shadow):
    """Top-level keys the legacy engine omits for an empty conversation.

    Non-empty only when every such key is one the certified empty contract
    names and the shadow row is empty (n == 0).
    """
    top = {k for k in LEGACY_EMPTY_KEYS if '.' not in k}
    missing = tuple(sorted(k for k in top if field(prod, k) is MISSING and field(shadow, k) is not MISSING))
    return missing if missing and field(shadow, 'n') == 0 else ()


def pair(prod, shadow):
    """('PAIRED', None), ('UNPAIRED', reason) or ('MALFORMED', None)."""
    if prod is None:
        return 'UNPAIRED', 'NO-PROD-ROW'
    if shadow is None:
        return 'UNPAIRED', 'NO-SHADOW-ROW'
    if type(prod) is not dict or type(shadow) is not dict:
        return 'MALFORMED', None
    stamps = []
    for blob in (prod, shadow):
        values = tuple(field(blob, k) for k in PAIR_TIMESTAMPS)
        if any(v is not MISSING and v is not None and (type(v) is not int or v < 0) for v in values):
            return 'MALFORMED', None
        stamps.append(values)
    counted = [totals(prod), totals(shadow)]
    if None in counted:
        return 'MALFORMED', None
    if empty_omission(prod, shadow):
        # Omitted totals of an empty legacy row are the shadow's empty values.
        counted[0] = tuple(s if p is MISSING else p for p, s in zip(*counted))
    if stamps[0] != stamps[1]:
        return 'UNPAIRED', 'TIMESTAMPS'
    if counted[0] != counted[1]:
        return 'UNPAIRED', 'TOTALS'
    return 'PAIRED', None


def outcome(differing):
    """The class is a function of the differing acceptance keys alone."""
    names = set(differing)
    if not names:
        return 'PASS'
    if names <= NEAR_TIE_KEYS:
        return 'NEAR-TIE'
    if 'pca' in names and names <= HISTORY_KEYS:
        return 'HISTORY-DIVERGENCE'
    return 'FAIL'


def python_shape(blob):
    return type(blob) is dict and PYTHON_TWIN in blob


# ---------------------------------------------------------------------------
# Per-conversation evidence and receipt entries (no zid in the receipt).
# ---------------------------------------------------------------------------
METRICS = ('float_leaves', 'g12_outliers', 'exact_leaves', 'exact_mismatches', 'shape_faults', 'nonfinite')
EVIDENCE = ('zid', 'pairing', 'unpaired', 'outcome', 'legacy_defect', 'differing', *METRICS,
            'worst_abs', 'worst_rel')
ENTRY = tuple(k for k in EVIDENCE if k != 'zid') + ('created_after_start',)


def unpaired_evidence(zid, reason):
    return dict(zid=zid, pairing='UNPAIRED', unpaired=reason, outcome=None, legacy_defect=None,
                differing=[], worst_abs=None, worst_rel=None, **dict.fromkeys(METRICS, 0))


def validate_entry(e, keys=ENTRY):
    closed(e, keys)
    if e['pairing'] not in PAIRING:
        fail('SHADOW_ENTRY')
    for k in METRICS:
        integer(e[k], 0, 2**53)
    delta(e['worst_abs'])
    delta(e['worst_rel'])
    if 'created_after_start' in keys and type(e['created_after_start']) is not bool:
        fail('SHADOW_ENTRY')
    d = e['differing']
    if type(d) is not list or any(type(n) is not str or n not in DIFF_NAMES for n in d) or d != sorted(set(d)):
        fail('SHADOW_ENTRY')
    if e['pairing'] == 'UNPAIRED':
        if (e['unpaired'] not in UNPAIRED_REASONS or e['outcome'] is not None or e['legacy_defect'] is not None
                or d or any(e[k] for k in METRICS) or e['worst_abs'] is not None or e['worst_rel'] is not None):
            fail('SHADOW_ENTRY')
        return e
    if e['unpaired'] is not None or e['outcome'] != outcome(d):
        fail('SHADOW_ENTRY')
    if e['legacy_defect'] is not None and e['legacy_defect'] not in LEGACY_DEFECTS:
        fail('SHADOW_ENTRY')
    finite = e['float_leaves'] - e['nonfinite']
    if finite < 0 or (e['worst_abs'] is None) != (finite == 0) or (e['worst_rel'] is None) != (finite == 0):
        fail('SHADOW_ENTRY')
    if e['g12_outliers'] > finite or e['exact_mismatches'] > e['exact_leaves']:
        fail('SHADOW_ENTRY')
    faults = e['g12_outliers'] or e['exact_mismatches'] or e['shape_faults'] or e['nonfinite']
    if bool(d) != bool(faults):
        fail('SHADOW_ENTRY')
    return e


# ---------------------------------------------------------------------------
# Receipt: polis-probe-receipt/3, kind light-shadow-compare.
# ---------------------------------------------------------------------------
RECEIPT = ('schema', 'kind', 'run_id', 'job_sha256', 'verdict', 'bindings', 'run_spec', 'window',
           'coverage', 'rows', 'totals', 'worst', 'conversations', 'controls')
BINDINGS = ('source_commit', 'reader', 'producer', 'verifier', 'query_policy', 'certification_policy',
            'server_version_num')
ROWS = ('prod_main', 'shadow_main', 'prod_ticks', 'shadow_ticks', 'active', 'prod_main_after',
        'prod_ticks_after', 'prod_python_shape')
TOTALS = (*PAIRING, *UNPAIRED_REASONS, *OUTCOMES, EMPTY_DEFECT, 'created_after_start', 'triage_required')


def tally(entries):
    t = dict.fromkeys(TOTALS, 0)
    for e in entries:
        t[e['pairing']] += 1
        if e['unpaired']:
            t[e['unpaired']] += 1
        if e['outcome']:
            t[e['outcome']] += 1
        if e['legacy_defect']:
            t[e['legacy_defect']] += 1
        t['created_after_start'] += e['created_after_start']
    t['triage_required'] = t['NEAR-TIE'] + t['HISTORY-DIVERGENCE']
    return t


def worst(entries):
    def top(k):
        values = [e[k] for e in entries if e[k] is not None]
        return max(values) if values else None
    return {'abs': top('worst_abs'), 'rel': top('worst_rel')}


def expected_verdict(r):
    if r['coverage']['status'] != 'COMPLETE':
        return 'INCOMPLETE'
    if not all(r['controls'].values()) or r['totals']['FAIL']:
        return 'FAIL'
    # An empty or wholly unpaired comparison proves nothing: never PASS.
    if not r['totals']['PAIRED']:
        return 'INCOMPLETE'
    return 'PASS'


def validate_window(w, spec):
    closed(w, ('start_ms', 'end_ms'))
    integer(w['end_ms'], MS_FLOOR, MS_CEILING, 'SHADOW_WINDOW')
    if w['start_ms'] != w['end_ms'] - 1000 * spec['window_seconds']:
        fail('SHADOW_WINDOW')
    return w


def validate_receipt(r, job):
    from receipt import sha
    closed(r, RECEIPT)
    if (r['schema'] != 'polis-probe-receipt/3' or r['kind'] != KIND or job.get('kind') != KIND
            or r['run_id'] != job['run_id'] or r['job_sha256'] != sha(job)):
        fail('SHADOW_BINDING')
    if r['verdict'] not in ('PASS', 'FAIL', 'INCOMPLETE'):
        fail('SHADOW_VERDICT')
    b = closed(r['bindings'], BINDINGS)
    if type(b['source_commit']) is not str or not re.fullmatch('[a-f0-9]{40}', b['source_commit']):
        fail('SHADOW_BINDING')
    for k in ('reader', 'producer', 'verifier'):
        if b[k] != job[k]['image'].split('@sha256:')[1]:
            fail('SHADOW_IMAGE')
    if b['query_policy'] != POLICY_SHA or b['certification_policy'] != CERTIFICATION_POLICY:
        fail('SHADOW_POLICY')
    integer(b['server_version_num'])
    if r['run_spec'] != job['run_spec']:
        fail('SHADOW_BINDING')
    spec = validate_run_spec(r['run_spec'])
    c = closed(r['coverage'], ('status', 'covered', 'uncovered_tables', 'excluded_fields'))
    if (c['status'] not in STATUS or c['covered'] != list(COVERED)
            or c['uncovered_tables'] != list(UNCOVERED_TABLES) or c['excluded_fields'] != list(EXCLUDED_FIELDS)):
        fail('SHADOW_SCOPE')
    complete = c['status'] == 'COMPLETE'
    if complete or r['window'] is not None:
        validate_window(r['window'], spec)
    rows = closed(r['rows'], ROWS)
    for k in ROWS:
        integer(rows[k])
    entries = r['conversations']
    if type(entries) is not list or len(entries) > MAX_CONVERSATIONS:
        fail('SHADOW_LIMIT')
    for e in entries:
        validate_entry(e)
    if [encoded(e) for e in entries] != sorted(encoded(e) for e in entries):
        fail('SHADOW_ORDER')
    closed(r['totals'], TOTALS)
    for k in TOTALS:
        integer(r['totals'][k], 0, MAX_CONVERSATIONS)
    if r['totals'] != tally(entries) or r['worst'] != worst(entries):
        fail('SHADOW_COUNT')
    if complete:
        if len(entries) != rows['active'] or rows['prod_python_shape'] > rows['active']:
            fail('SHADOW_COUNT')
    elif entries or rows['active'] or rows['prod_python_shape']:
        fail('SHADOW_COUNT')
    controls = closed(r['controls'], CONTROLS)
    if any(type(v) is not bool for v in controls.values()):
        fail()
    if complete and (controls['shadow-label-not-prod'] != (rows['prod_python_shape'] == 0)):
        fail('SHADOW_FALSE_PASS')
    if complete and controls['prod-rows-unchanged'] and (rows['prod_main_after'] < rows['prod_main']
                                                        or rows['prod_ticks_after'] < rows['prod_ticks']):
        fail('SHADOW_FALSE_PASS')
    if r['verdict'] != expected_verdict(r):
        fail('SHADOW_FALSE_PASS')
    if len(encoded(r)) > LIMIT:
        fail('SHADOW_LIMIT')
    return r


# ---------------------------------------------------------------------------
# Box-local reader projection (never exported): closed shape and bounds.
# ---------------------------------------------------------------------------
PROJECTION_SCHEMA = 'polis-light-shadow-projection/1'
CATALOG = ('prod_main', 'shadow_main', 'prod_ticks', 'shadow_ticks', 'active', 'prod_main_after',
           'prod_ticks_after', 'no_write')


def validate_projection(p, spec):
    closed(p, ('schema', 'source_commit', 'query_policy', 'server_version_num', 'status', 'shadow_env',
               'window', 'catalog', 'conversations'))
    if p['schema'] != PROJECTION_SCHEMA or p['query_policy'] != POLICY_SHA:
        fail('SHADOW_POLICY')
    if type(p['source_commit']) is not str or not re.fullmatch('[a-f0-9]{40}', p['source_commit']):
        fail('SHADOW_BINDING')
    if p['shadow_env'] != spec['shadow_env'] or p['shadow_env'] == PROD:
        fail('SHADOW_ENV')
    integer(p['server_version_num'])
    if p['status'] not in STATUS:
        fail()
    catalog = closed(p['catalog'], CATALOG)
    for k in CATALOG[:-1]:
        integer(catalog[k])
    if type(catalog['no_write']) is not bool:
        fail()
    rows = p['conversations']
    if type(rows) is not list or len(rows) > MAX_CONVERSATIONS:
        fail('SHADOW_LIMIT')
    zids = []
    for row in rows:
        closed(row, ('zid', 'created', 'prod', 'shadow'))
        integer(row['zid'], 1)
        if row['created'] is not None:
            integer(row['created'], 0, MS_CEILING)
        if row['prod'] is None and row['shadow'] is None:
            fail('SHADOW_SNAPSHOT')
        zids.append(row['zid'])
    if zids != sorted(set(zids)):
        fail('SHADOW_ORDER')
    if p['status'] == 'COMPLETE':
        validate_window(p['window'], spec)
        if len(rows) != catalog['active']:
            fail('SHADOW_COUNT')
    elif rows or catalog['active'] or p['window'] is not None:
        fail('SHADOW_COUNT')
    return p
