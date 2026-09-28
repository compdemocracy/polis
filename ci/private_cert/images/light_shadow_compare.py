"""Classify one conversation's prod and shadow math_main rows (P-067 section 4).

Shared comparison library of the producer and verifier images. Tolerance,
sign alignment, raw checkpoint validation and the acceptance projection are
the certified ones (g12.py and polismath.replay.certify), called unchanged.
Evidence rows carry the zid only on the box; the verifier drops it from the
receipt.
"""
from __future__ import annotations
import copy
import json
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(REPO / 'delphi'))
sys.path.insert(0, str(REPO / 'ci/probe_box'))
import g12
from polismath.replay import certify
from light_shadow import (ACCEPTANCE_KEYS, EMPTY_DEFECT, EXCLUDED_FIELDS, LEGACY_EMPTY_KEYS, METRICS,
                          NEAR_TIE_KEYS, encoded, field, outcome, pair, rounded, unpaired_evidence)

# The committed empty-conversation schedule declares the empty values the
# legacy engine omits; restored values must equal them exactly.
EMPTY_SCHEDULE = REPO / 'delphi/scripts/schedules/pc-zerovote-01-empty.json'
DELTA_CEILING = 1e300


def empty_output():
    return json.loads(EMPTY_SCHEDULE.read_bytes())['empty_output']


def without_excluded(blob):
    """Declared exclusion: per-writer counters never enter the comparison."""
    return {k: v for k, v in blob.items() if k not in EXCLUDED_FIELDS}


def reconcile_empty(prod, shadow, declared):
    """Comparison-only restore of keys an empty legacy row omits.

    Applies only when the shadow row is empty (n == 0), only to names in the
    certified empty contract, and only with the declared empty value (the
    moderation lists, which the contract leaves dynamic, take the validated
    shadow value as the certified gate does). Returns (prod view, restored).
    """
    if shadow.get('n') != 0:
        return prod, []
    view, restored = copy.deepcopy(prod), []
    for key in sorted(LEGACY_EMPTY_KEYS):
        parent, _, child = key.partition('.')
        source, target = (shadow, view) if not child else (shadow.get(parent), view.get(parent))
        name = child or parent
        if type(source) is not dict or type(target) is not dict or name in target or name not in source:
            continue
        if key in declared and encoded(source[name]) != encoded(declared[key]):
            continue
        target[name] = copy.deepcopy(source[name])
        restored.append(key)
    return view, restored


def admitted(view):
    """The certified field contract on one row alone (as the gate admits each side first)."""
    for key, value in view.items():
        col = g12.Collector()
        g12._walk_keyed(key, value, value, key, col)
        if not g12.summarize(col)['rollup']['g12_pass']:
            return False
    return True


def _ints(v, length=None):
    return (type(v) is list and all(type(x) is int for x in v)
            and (length is None or len(v) == length))


def _numbers(v, length):
    return (type(v) is list and len(v) == length
            and all(type(x) in (int, float) and type(x) is not bool for x in v))


def _abs(v):
    return type(v) is dict and set(v) >= {'A', 'D', 'S'}


def structure(view):
    """Nested schema of one acceptance projection, against its own inventories.

    Each row must be coherent on its own, so a defect both rows share is still
    structure: tids length n_c; PCA comps and comment-projection as k rows of
    n_c numbers (k >= 1 unless n_c == 0), center and comment-extremity of n_c;
    base-clusters as equal-length columns id/members/count/x/y (b clusters);
    each group cluster with an integer id, integer members and a k-long center;
    votes-base as A/D/S vectors of length b; group-votes keyed by the group ids
    with integer A/D/S per comment. Early and empty layouts (b == 0, no groups,
    n_c == 0) are valid. Values and cardinality are left to the comparison.
    """
    try:
        tids = view['tids']
        if not _ints(tids):
            return False
        n_c = len(tids)
        pca = view['pca']
        if type(pca) is not dict or not set(pca) >= {'comps', 'center', 'comment-projection', 'comment-extremity'}:
            return False
        comps, projection = pca['comps'], pca['comment-projection']
        if type(comps) is not list or type(projection) is not list:
            return False
        k = len(comps)
        if (k == 0 and n_c) or len(projection) != k:
            return False
        if not all(_numbers(row, n_c) for row in comps + projection):
            return False
        if not (_numbers(pca['center'], n_c) and _numbers(pca['comment-extremity'], n_c)):
            return False
        base = view['base-clusters']
        if type(base) is not dict or not set(base) >= {'id', 'members', 'count', 'x', 'y'}:
            return False
        b = len(base['id']) if type(base['id']) is list else -1
        if not (_ints(base['id'], b) and _ints(base['count'], b) and _numbers(base['x'], b)
                and _numbers(base['y'], b) and type(base['members']) is list and len(base['members']) == b
                and all(_ints(m) for m in base['members'])):
            return False
        groups = view['group-clusters']
        if type(groups) is not list:
            return False
        for g in groups:
            if (type(g) is not dict or type(g.get('id')) is not int or not _ints(g.get('members'))
                    or not _numbers(g.get('center'), k)):
                return False
        votes = view['votes-base']
        if type(votes) is not dict or not all(_abs(v) and all(_ints(v[x], b) for x in 'ADS')
                                              for v in votes.values()):
            return False
        group_votes = view['group-votes']
        if type(group_votes) is not dict or set(group_votes) != {str(g['id']) for g in groups}:
            return False
        for g in group_votes.values():
            if type(g) is not dict or type(g.get('votes')) is not dict:
                return False
            if not all(_abs(v) and all(type(v[x]) is int for x in 'ADS') for v in g['votes'].values()):
                return False
        return True
    except (KeyError, TypeError, AttributeError):
        return False


def inventory(view):
    """Cluster inventory: base ids and members, group ids and members."""
    base, groups = view['base-clusters'], view['group-clusters']
    return (encoded([base['id'], base['members']]),
            encoded(sorted([g['id'], sorted(g['members'])] for g in groups)))


def empty_contract(view, declared):
    """The shadow's empty row carries every declared empty value exactly."""
    for key, value in declared.items():
        parent, _, child = key.partition('.')
        holder = view.get(parent) if child else view
        name = child or parent
        if type(holder) is not dict or name not in holder or encoded(holder[name]) != encoded(value):
            return False
    return True


def measure(left, right):
    """(differing keys, keys with shape faults, merged g12 collector), certification's sign alignment (d=1)."""
    try:
        signs = g12.infer_axis_sign(left['pca']['comps'], right['pca']['comps'])
    except (KeyError, TypeError, IndexError):
        signs = None
    axis = g12.Axis(signs, 1)
    merged = g12.Collector()
    differing = set(left) ^ set(right)
    shaped = set(differing)
    for key in sorted(differing):
        merged.add_shape(key, 'acceptance-key-inventory')
    for key in sorted(set(left) & set(right)):
        col = g12.Collector()
        g12._walk_keyed(key, left[key], right[key], key, col, axis)
        if not g12.summarize(col)['rollup']['g12_pass']:
            differing.add(key)
        if col.shape:
            shaped.add(key)
        for mine, theirs in ((merged.pairs, col.pairs), (merged.exact_total, col.exact_total),
                             (merged.exact_mismatch, col.exact_mismatch), (merged.shape, col.shape)):
            mine.update(theirs)
    return sorted(differing), shaped, merged


def malformed(zid):
    return dict(unpaired_evidence(zid, None), pairing='PAIRED', unpaired=None, outcome='FAIL',
                differing=['row-schema'], shape_faults=1)


def classify(zid, prod, shadow, declared):
    """One evidence row for one conversation; never raises on row content.

    Structure is checked before any triage class is possible: present, typed
    pairing metadata (in `pair`); the certified raw checkpoint validation, with
    required keys unless the shadow row is the declared empty conversation;
    the complete acceptance inventory on both sides after the named legacy-
    empty restoration; each side admitted alone by the certified field
    contract; no shape fault outside cluster cardinality; and at least one
    compared leaf. Any failure is `row-schema`, a FAIL.
    """
    state, reason = pair(prod, shadow)
    if state == 'UNPAIRED':
        return unpaired_evidence(zid, reason)
    if state == 'MALFORMED':
        return malformed(zid)
    empty = field(shadow, 'n') == 0
    try:
        views = []
        for label, blob in (('prod', prod), ('shadow', shadow)):
            blob = without_excluded(blob)
            certify.validate_checkpoint_blob(blob, label, require_keys=not empty)
            views.append(certify.project_acceptance(blob))
        left, right = views
        if empty and not empty_contract(right, declared):
            return malformed(zid)
        left, restored = reconcile_empty(left, right, declared)
        if set(left) != set(ACCEPTANCE_KEYS) or set(right) != set(ACCEPTANCE_KEYS):
            structural = True
        else:
            structural = not (admitted(left) and admitted(right) and structure(left) and structure(right))
        differing, shaped, col = measure(left, right)
        rollup = g12.summarize(col)['rollup']
    except (certify.CertifyError, TypeError, ValueError, KeyError, IndexError, AttributeError,
            OverflowError, RecursionError):
        return malformed(zid)
    # Between two coherent rows, a shape difference in the clustering closure is
    # admitted only when the cluster inventory itself differs (a different
    # number of clusters or different members); any other shape fault is structure.
    if not structural and shaped & NEAR_TIE_KEYS:
        structural = inventory(left) == inventory(right)
    structural = structural or bool(shaped - NEAR_TIE_KEYS) or rollup['n'] + rollup['n_exact'] == 0
    if structural:
        differing = sorted(set(differing) | {'row-schema'})
    leaves = sum(len(v) for v in col.pairs.values())
    finite = rollup['n']
    def top(value):
        return rounded(min(value, DELTA_CEILING)) if finite else None
    metrics = dict(float_leaves=leaves, g12_outliers=rollup['g12_outliers'], exact_leaves=rollup['n_exact'],
                   exact_mismatches=rollup['exact_mismatches'], shape_faults=rollup['shape_faults'],
                   nonfinite=rollup['nonfinite'])
    assert set(metrics) == set(METRICS)
    return dict(zid=zid, pairing='PAIRED', unpaired=None, outcome=outcome(differing),
                legacy_defect=EMPTY_DEFECT if restored else None, differing=differing,
                worst_abs=top(rollup['max_abs']), worst_rel=top(rollup['max_rel_all']), **metrics)


def classify_projection(projection, declared=None):
    """Evidence rows in zid order; box-local only."""
    declared = empty_output() if declared is None else declared
    if projection['status'] != 'COMPLETE':
        return []
    return [classify(c['zid'], c['prod'], c['shadow'], declared) for c in projection['conversations']]


# ---------------------------------------------------------------------------
# Constructed fixture blobs (public; no production values) for controls/tests.
# ---------------------------------------------------------------------------
def fixture_blob():
    return {
        'zid': 1, 'n': 3, 'n-cmts': 2, 'tids': [0, 1], 'in-conv': [0, 1, 2],
        'lastVoteTimestamp': 1_700_000_000_000, 'lastModTimestamp': None, 'math_tick': 7,
        'pca': {'comps': [[0.6, 0.8], [0.8, -0.6]], 'center': [0.1, 0.2],
                'comment-projection': [[1.0, 0.0], [0.0, 1.0]], 'comment-extremity': [1.0, 1.0]},
        'base-clusters': {'id': [0], 'members': [[0, 1, 2]], 'count': [3], 'x': [0.0], 'y': [0.0]},
        'group-clusters': [{'id': 0, 'members': [0], 'center': [0.0, 0.0]}],
        'votes-base': {'0': {'A': [1], 'D': [1], 'S': [3]}},
        'group-votes': {'0': {'votes': {'0': {'A': 1, 'D': 1, 'S': 3}}}},
        'repness': {'0': [{'tid': 0, 'p': 0.5}]}, 'group-aware-consensus': {'0': 0.5},
        'comment-priorities': {'0': 0.5}, 'consensus': {'agree': [], 'disagree': []},
        'user-vote-counts': {'0': 1, '1': 1, '2': 1}, 'mod-in': [], 'mod-out': [], 'meta-tids': [],
    }


def fixture_empty_pair():
    """A legacy empty row and the shadow's declared empty values."""
    declared = empty_output()
    shadow = {'zid': 1, 'lastVoteTimestamp': 0, 'lastModTimestamp': None, 'mod-in': [], 'mod-out': [],
              'meta-tids': [], 'base-clusters': {'id': [], 'members': [], 'count': [], 'x': [], 'y': []},
              'repness': {}, 'comment-priorities': {}, 'pca': {'comps': [[], []]}}
    for key, value in declared.items():
        parent, _, child = key.partition('.')
        if child:
            shadow['pca'][child] = copy.deepcopy(value)
        elif key != 'lastVoteTimestamp':
            shadow[key] = copy.deepcopy(value)
    prod = copy.deepcopy(shadow)
    for key in LEGACY_EMPTY_KEYS:
        parent, _, child = key.partition('.')
        if child:
            prod['pca'].pop(child, None)
        else:
            prod.pop(key, None)
    return prod, shadow


def fixture_variants():
    """Named (prod, shadow) pairs, one per pairing state and outcome."""
    base = fixture_blob()
    near_tie = copy.deepcopy(base)
    near_tie['group-clusters'][0]['center'] = [0.5, 0.0]
    history = copy.deepcopy(base)
    history['pca']['center'] = [0.5, 0.2]
    engine = copy.deepcopy(base)
    engine['consensus'] = {'agree': [{'tid': 0}], 'disagree': []}
    timestamps = copy.deepcopy(base)
    timestamps['lastVoteTimestamp'] += 1
    totals = copy.deepcopy(base)
    totals['n'] = 4
    empty_prod, empty_shadow = fixture_empty_pair()
    return {'pass': (base, copy.deepcopy(base)), 'near-tie': (base, near_tie), 'history': (base, history),
            'fail': (base, engine), 'legacy-empty': (empty_prod, empty_shadow),
            'timestamps': (base, timestamps), 'totals': (base, totals),
            'no-prod-row': (None, copy.deepcopy(base)), 'no-shadow-row': (copy.deepcopy(base), None)}


def structural_variants():
    """Named (prod, shadow) pairs that must FAIL: structure is never a triage class."""
    base = fixture_blob()
    no_time = copy.deepcopy(base)
    no_time.pop('lastVoteTimestamp')
    out = {'missing-pairing': (no_time, copy.deepcopy(no_time)), 'empty-objects': ({}, {})}
    for key in ('pca', 'group-clusters', 'repness'):
        bad = copy.deepcopy(base)
        bad.pop(key)
        out['missing-' + key] = (base, bad)
    bad = copy.deepcopy(base)
    bad['pca']['comps'] = [[], []]
    out['truncated-pca'] = (base, bad)
    # Defects both rows share, and nested holes inside the clustering closure.
    both = copy.deepcopy(base)
    both['pca'] = {}
    out['both-empty-pca'] = (both, copy.deepcopy(both))
    both = copy.deepcopy(base)
    both['pca']['comps'] = [[], []]
    out['both-truncated-pca'] = (both, copy.deepcopy(both))
    both = copy.deepcopy(base)
    both['group-clusters'][0]['center'] = []
    out['both-truncated-group-center'] = (both, copy.deepcopy(both))
    out['truncated-group-center'] = (base, copy.deepcopy(both))
    bad = copy.deepcopy(base)
    del bad['group-clusters'][0]['center']
    out['missing-group-center'] = (base, bad)
    bad = copy.deepcopy(base)
    bad['base-clusters']['x'] = []
    out['truncated-base-x'] = (base, bad)
    bad = copy.deepcopy(base)
    del bad['votes-base']['0']['A']
    out['missing-votes-vector'] = (base, bad)
    bad = copy.deepcopy(base)
    bad['votes-base']['0']['A'] = []
    out['truncated-votes-vector'] = (base, bad)
    return out


def cardinality_variant():
    """A valid cluster-cardinality difference: one more group. A candidate, not structure."""
    base = fixture_blob()
    more = copy.deepcopy(base)
    more['group-clusters'].append({'id': 1, 'members': [0], 'center': [1.0, 1.0]})
    more['group-votes']['1'] = {'votes': {'0': {'A': 0, 'D': 0, 'S': 1}}}
    return base, more
