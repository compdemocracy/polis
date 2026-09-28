"""Classify private replay observations; return only a closed, bounded vocabulary."""
import json
import math
import re

import numpy as np
import g12

STARTS = frozenset({'nonzero-warm', 'padded-warm', 'zero-fallback', 'missing-fallback', 'not-computed'})
FIELDS = {'schema', 'checkpoint', 'pids', 'tids', 'fold', 'rating_fold', 'starts',
          'center', 'comps', 'comments', 'person', 'partitions'}
PER_ENTRY = 8
TOTAL = 64


def unavailable(checkpoint):
    return dict(checkpoint=checkpoint, folded_matrix='unavailable',
                moderated_matrix='unavailable', legacy_starts=['unavailable']*2,
                python_starts=['unavailable']*2, person_projection='unavailable',
                base_partition='unavailable', comment_center_swap='unavailable',
                comment_components_swap='unavailable', comment_joint_swap='unavailable')


def admit(doc, checkpoint):
    if (type(doc) is not dict or set(doc) != FIELDS or doc['schema'] != 'polis-replay-attribution/1'
            or type(doc['checkpoint']) is not int or doc['checkpoint'] != checkpoint):
        raise ValueError('ATTRIBUTION_SCHEMA')
    for name in ('pids', 'tids'):
        labels = doc[name]
        if (type(labels) is not list or any(type(x) is not str for x in labels)
                or labels != sorted(set(labels))):
            raise ValueError('ATTRIBUTION_LABELS')
    for name in ('fold', 'rating_fold'):
        if type(doc[name]) is not str or re.fullmatch('[0-9a-f]{64}', doc[name]) is None:
            raise ValueError('ATTRIBUTION_FOLD')
    if (type(doc['starts']) is not list or len(doc['starts']) != 2
            or any(type(x) is not str or x not in STARTS for x in doc['starts'])):
        raise ValueError('ATTRIBUTION_STARTS')
    if type(doc['partitions']) is not list or type(doc['person']) is not list or len(doc['person']) != len(doc['pids']):
        raise ValueError('ATTRIBUTION_SHAPE')
    return doc


def array(value):
    if value is None:
        return None
    try:
        a = np.asarray(value, dtype=float)
    except (TypeError, ValueError):
        return None
    return a if np.isfinite(a).all() else None


def matches(a, b):
    return (a is not None and b is not None and a.shape == b.shape
            and all(not g12.g12_fail(float(x), float(y)) for x, y in zip(a.flat, b.flat)))


def partition(doc):
    by_members = {}
    seen_ids, seen_members = set(), set()
    for row in doc['partitions']:
        if type(row) is not list or len(row) != 2 or type(row[0]) is not str or type(row[1]) is not list:
            raise ValueError('ATTRIBUTION_PARTITION')
        identity, members = row
        if (any(type(p) is not str for p in members) or members != sorted(set(members))
                or not members or identity in seen_ids or seen_members.intersection(members)
                or not set(members) <= set(doc['pids'])):
            raise ValueError('ATTRIBUTION_PARTITION')
        seen_ids.add(identity); seen_members.update(members)
        by_members[tuple(members)] = identity
    return by_members


def measure(left, right, checkpoint):
    a, b = admit(left, checkpoint), admit(right, checkpoint)
    pa, pb = partition(a), partition(b)
    result = dict(checkpoint=checkpoint,
                  folded_matrix='equal' if a['fold'] == b['fold'] else 'different',
                  moderated_matrix='equal' if a['rating_fold'] == b['rating_fold'] else 'different',
                  legacy_starts=a['starts'], python_starts=b['starts'],
                  person_projection='fail' if a['pids'] != b['pids'] else 'unavailable',
                  base_partition=('same-ids' if pa == pb else 'different-ids' if pa.keys() == pb.keys() else 'different'),
                  comment_center_swap='unavailable', comment_components_swap='unavailable',
                  comment_joint_swap='unavailable')
    ca, cb = array(a['comps']), array(b['comps'])
    ea, eb = array(a['center']), array(b['center'])
    width = len(a['tids'])
    if (a['tids'] != b['tids'] or ca is None or cb is None or ca.shape != (2, width)
            or cb.shape != ca.shape or ea is None or eb is None or ea.shape != (width,) or eb.shape != ea.shape):
        return result
    signs = np.array(g12.infer_axis_sign(ca.tolist(), cb.tolist()))
    cb = cb * signs[:, None]
    xa, xb = array(a['person']), array(b['person'])
    if a['pids'] != b['pids']:
        result['person_projection'] = 'fail'
    elif xa is not None and xb is not None and xa.shape == xb.shape == (len(a['pids']), 2):
        result['person_projection'] = 'pass' if matches(xa, xb*signs) else 'fail'
    qa, qb = array(a['comments']), array(b['comments'])
    if qa is None or qb is None or qa.shape != qb.shape or qa.shape != (2, width):
        return result
    qb = qb * signs[:, None]
    # Admit the local formula against BOTH actual outputs before attributing
    # an error to its inputs. Otherwise a last-step kernel difference could
    # masquerade as a successful center/components substitution.
    scale = math.sqrt(width)
    if not matches(((-1.0 - ea) * ca) * scale, qa) or not matches(((-1.0 - eb) * cb) * scale, qb):
        return result
    if matches(qa, qb):
        for key in ('comment_center_swap', 'comment_components_swap', 'comment_joint_swap'):
            result[key] = 'not-applicable'
        return result
    # Reproduce the other engine's observed coordinates using one replaced
    # upstream input. Joint replacement is a control for the formula itself.
    for key, center, comps in [('comment_center_swap', eb, ca),
                               ('comment_components_swap', ea, cb),
                               ('comment_joint_swap', eb, cb)]:
        value = ((-1.0 - center) * comps) * math.sqrt(width)
        result[key] = 'reproduced' if matches(value, qb) else 'not-reproduced'
    return result


def corroborate_starts(starts, previous):
    """Admitted legacy output corroborates each claimed warm restart.

    Checkpoint zero has the driver's pinned all-ones cold seed, so absence of
    an earlier file is not evidence for a restart. Later checkpoints use the
    preceding blob's components, including across the load/restart seam.
    Unknown/malformed evidence cannot grant an acceptance exception.
    """
    result = list(starts)
    pca = previous.get('pca') if type(previous) is dict else None
    comps = pca.get('comps') if type(pca) is dict else None
    for axis, kind in enumerate(starts):
        if kind not in {'zero-fallback', 'missing-fallback'}:
            continue
        admitted = previous is not None
        value = comps[axis] if type(comps) is list and axis < len(comps) else None
        if kind == 'zero-fallback':
            admitted = admitted and type(value) is list and all(
                type(v) in (int, float) and v == 0 for v in value)
        else:
            admitted = admitted and (comps is None or
                (type(comps) is list and (axis >= len(comps) or value is None)))
        if not admitted:
            result[axis] = 'unavailable'
    return result


def measure_recording(directory, checks):
    # Observation inventory and schema failures are not science verdicts.
    expected = {f'step-{i:03d}.json' for i in range(checks)}
    try:
        for engine in ('clj', 'py'):
            names = {p.name for p in (directory / (engine + '-attribution')).glob('step-*.json')}
            if not names <= expected:
                return [unavailable(i) for i in range(checks)]
    except Exception:
        return [unavailable(i) for i in range(checks)]
    results = []
    for i in range(checks):
        try:
            row = measure(
                json.loads((directory / 'clj-attribution' / f'step-{i:03d}.json').read_text()),
                json.loads((directory / 'py-attribution' / f'step-{i:03d}.json').read_text()), i)
            if any(kind in {'zero-fallback', 'missing-fallback'} for kind in row['legacy_starts']):
                previous = (json.loads((directory / 'clj' / f'step-{i-1:03d}.blob.json').read_text())
                            if i else None)
                row['legacy_starts'] = corroborate_starts(row['legacy_starts'], previous)
            results.append(row)
        except Exception:
            results.append(unavailable(i))
    return results


def bounded(entries):
    """Failing entries first, then other entries; preserve public entry order."""
    from polismath.replay.legacy_pca import restart_checkpoint
    projected = [[] for _ in entries]
    priority = sorted(range(len(entries)), key=lambda i: entries[i]['pass'])
    ordered = []
    for entry in entries:
        bad = {i for i, row in enumerate(entry['strict']['per_step']) if not row['match']}
        bad.update(row['checkpoint'] for row in entry.get('diagnostics', []))
        # The authoritative strict comparison supplies the checkpoint count for
        # export too. Disabled capture or a shorter observer list fills gaps.
        by_index = {row['checkpoint']: row for row in entry.get('attribution', [])}
        rows = [by_index.get(i, unavailable(i)) for i in range(len(entry['strict']['per_step']))]
        # Reserve the observed onset even when the accepted entry's other
        # attribution rows are truncated. Verdicts use the full private set.
        onset = restart_checkpoint(rows)
        ordered.append(sorted(rows, key=lambda row: (row['checkpoint'] != onset,
                              row['checkpoint'] not in bad, row['checkpoint'])))
    remaining = TOTAL
    # Reserve one observation per entry before spending the rest on failures.
    # In the current 34-entry plan this preserves coverage even if all fail.
    for index in priority:
        if remaining and ordered[index]:
            projected[index] = ordered[index][:1]
            remaining -= 1
    for index in priority:
        extra = ordered[index][len(projected[index]):PER_ENTRY][:remaining]
        projected[index].extend(extra)
        remaining -= len(extra)
    return [dict(attribution=sorted(rows, key=lambda row: row['checkpoint']),
                 attribution_truncated=len(rows) < len(entry['strict']['per_step']))
            for rows, entry in zip(projected, entries)]
