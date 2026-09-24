"""Private replay observations. Only closed verifier classifications may leave the box."""
import base64
import hashlib
import json
from pathlib import Path

import numpy as np

from polismath.pca_kmeans_rep.pca import pca_project_cmnts


def label(value):
    kind = 'i' if isinstance(value, (int, np.integer)) and not isinstance(value, bool) else 's'
    return kind + ':' + base64.b64encode(str(value).encode('utf-8')).decode('ascii')


def folded_digest(frame):
    rows = sorted((label(v), i) for i, v in enumerate(frame.index))
    cols = sorted((label(v), i) for i, v in enumerate(frame.columns))
    h = hashlib.sha256()
    for prefix, labels in [('r', rows), ('c', cols)]:
        for key, _ in labels:
            h.update((prefix + key + '\n').encode('ascii'))
    data = frame.to_numpy(dtype=float)
    order = [c for _, c in cols]
    for _, r in rows:
        values = data[r, order]
        if not np.all(np.isnan(values) | np.isin(values, [-1., 0., 1.])):
            raise ValueError('ATTRIBUTION_VOTE')
        # Fixed-width raw-DB tokens, vectorized across comments. Avoid a
        # Python per-cell loop on the largest admitted matrices.
        tokens = np.where(np.isnan(values), ord('n'),
                          np.where(values == 1, ord('-'),
                                   np.where(values == -1, ord('+'), ord('0'))))
        h.update(tokens.astype(np.uint8).tobytes())
        h.update(b'\n')
    return h.hexdigest()


def start_kinds(starts, width, rows):
    if width < 2 or rows < 2:
        return ['not-computed', 'not-computed']
    starts = [] if starts is None else list(starts)
    kinds = []
    for axis in range(2):
        v = starts[axis] if axis < len(starts) else None
        kinds.append('missing-fallback' if v is None else 'zero-fallback' if not np.any(v)
                     else 'padded-warm' if len(v) < width else 'nonzero-warm')
    return kinds


def capture(step, conv, record, starts, directory):
    rows = sorted((label(v), i) for i, v in enumerate(conv.rating_mat.index))
    cols = sorted((label(v), i) for i, v in enumerate(conv.rating_mat.columns))
    pc = conv.pca or {}
    center = np.asarray(pc.get('center', []), dtype=float)
    comps = np.asarray(pc.get('comps', []), dtype=float)
    valid = (center.shape == (len(cols),) and comps.ndim == 2 and comps.shape[1] == len(cols))
    order = [i for _, i in cols]
    comments = -pca_project_cmnts(center, comps).T if valid and len(cols) else np.empty((0,0))
    people = [conv.proj.get(conv.rating_mat.index[i]) for _, i in rows]
    doc = dict(schema='polis-replay-attribution/1', checkpoint=step.index,
               pids=[v for v, _ in rows], tids=[v for v, _ in cols],
               fold=folded_digest(conv.raw_rating_mat), rating_fold=folded_digest(conv.rating_mat),
               starts=start_kinds(starts, len(cols), len(rows)),
               center=(-center[order]).tolist() if valid else None,
               comps=comps[:,order].tolist() if valid else None,
               comments=comments[:,order].tolist() if comments.size else None,
               person=[(-np.asarray(v)).tolist() if v is not None else None for v in people],
               partitions=[[label(c['id']), sorted(label(v) for v in c['members'])] for c in conv.base_clusters])
    directory = Path(directory); directory.mkdir(parents=True, exist_ok=True)
    with (directory / f'step-{step.index:03d}.json').open('x') as file:
        json.dump(doc, file, allow_nan=False, separators=(',', ':'))
