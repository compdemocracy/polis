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
from light_shadow import (EMPTY_DEFECT, EXCLUDED_FIELDS, LEGACY_EMPTY_KEYS, METRICS, encoded, outcome,
                          pair, rounded, unpaired_evidence)

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


def measure(left, right):
    """(differing keys, merged g12 collector) with certification's sign alignment (d=1)."""
    try:
        signs = g12.infer_axis_sign(left['pca']['comps'], right['pca']['comps'])
    except (KeyError, TypeError, IndexError):
        signs = None
    axis = g12.Axis(signs, 1)
    merged = g12.Collector()
    differing = set(left) ^ set(right)
    for key in sorted(differing):
        merged.add_shape(key, 'acceptance-key-inventory')
    for key in sorted(set(left) & set(right)):
        col = g12.Collector()
        g12._walk_keyed(key, left[key], right[key], key, col, axis)
        if not g12.summarize(col)['rollup']['g12_pass']:
            differing.add(key)
        for mine, theirs in ((merged.pairs, col.pairs), (merged.exact_total, col.exact_total),
                             (merged.exact_mismatch, col.exact_mismatch), (merged.shape, col.shape)):
            mine.update(theirs)
    return sorted(differing), merged


def malformed(zid):
    return dict(unpaired_evidence(zid, None), pairing='PAIRED', unpaired=None, outcome='FAIL',
                differing=['row-schema'], shape_faults=1)


def classify(zid, prod, shadow, declared):
    """One evidence row for one conversation; never raises on row content."""
    state, reason = pair(prod, shadow)
    if state == 'UNPAIRED':
        return unpaired_evidence(zid, reason)
    if state == 'MALFORMED':
        return malformed(zid)
    try:
        views = []
        for label, blob in (('prod', prod), ('shadow', shadow)):
            blob = without_excluded(blob)
            certify.validate_checkpoint_blob(blob, label, require_keys=False)
            views.append(certify.project_acceptance(blob))
        left, right = views
        left, restored = reconcile_empty(left, right, declared)
        differing, col = measure(left, right)
        rollup = g12.summarize(col)['rollup']
    except (certify.CertifyError, TypeError, ValueError, KeyError, IndexError, AttributeError,
            OverflowError, RecursionError):
        return malformed(zid)
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
