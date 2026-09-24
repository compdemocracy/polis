"""Hoist group label resolution and count the same predicates column-wise."""
from typing import Any, Dict, Sequence

import numpy as np
import pandas as pd


def group_vote_counts(matrix: pd.DataFrame, comments: pd.Index,
                      groups: Sequence[Dict[str, Any]],
                      chunk: int = 64) -> Dict[str, Any]:
    """Unique matrix axes only; the caller retains its general scalar path.

    Columns are counted ``chunk`` at a time so the member-row copy stays small.
    """
    result = {}
    for group in groups:
        identity = group.get('id')
        if identity is None:
            continue
        # The original helper chooses the first equal ID, while the final
        # assignment's n-members and overwrite order use the current group.
        first = next((g for g in groups if g.get('id') == identity), None)
        members = first.get('members', []) if first else []
        rows = []
        for member in members if len(comments) else []:
            try:
                rows.append(matrix.index.get_loc(member))
            except ValueError:
                continue
        counts = [(0, 0, 0)] * len(comments)
        if members and len(comments):
            positions = []
            for index, tid in enumerate(comments):
                try:
                    positions.append((index, matrix.columns.get_loc(tid)))
                except ValueError:
                    continue
            if positions:
                data = matrix.values
                row_index = np.asarray(rows, dtype=np.intp)
                for start in range(0, len(positions), chunk):
                    part = positions[start:start + chunk]
                    values = data[np.ix_(row_index, [column for _, column in part])]
                    agree = np.sum(np.abs(values - 1.0) < 0.001, axis=0)
                    disagree = np.sum(np.abs(values + 1.0) < 0.001, axis=0)
                    seen = np.sum(~np.isnan(values), axis=0)
                    for j, (index, _) in enumerate(part):
                        counts[index] = (int(agree[j]), int(disagree[j]), int(seen[j]))
        result[str(identity)] = {
            'n-members': len(group.get('members', [])),
            'votes': {tid: {'A': a, 'D': d, 'S': s}
                      for tid, (a, d, s) in zip(comments, counts)},
        }
    return result
