"""An independent statement of the two count policies, in plain Python, for
the crate's third cross-check (vectors-5.json).

Written from the formulas of the rules as published (the crate's README and
registry), not from the Rust code, and separately from make_crosscheck.py and
make_crosscheck_4.py, which are published fixtures and are not changed. It
states, for a plan built from math update u:

  base-counts:lag-1  A, D and P per comment are those of update u - 1, given
                     as their own frame (the symmetric/1 rules).
  base-counts:lag-0  A, D and P per comment are summed over the opinion
                     groups of update u that have a cell for it, P = S - A - D
                     per cell; a comment with a cell in at least one group is
                     present (a cell of zeros counts), one with none is absent
                     (the symmetric/2 rules).
  symmetric          R = (A + D + side_prior) / (S + seen_prior);
                     w = (R * R * (E + extremity_offset)
                          * (1 + novelty_amplitude * 2^(-S / novelty_halving_votes)))^exponent;
                     a comment in only one of the counts and the extremity is
                     unscored; meta_policy fixed: a meta comment weighs
                     meta_inner^exponent with no factor; ordinary: the
                     formula; exclude: excluded whatever its inputs.
  symmetric-gic      w = symmetric's w * (gic_offset + G), G by gic-geomean/1
                     (exp of the mean over every member group of
                     ln((A_g + 1) / (S_g + 2)), an absent cell read as no
                     votes) or gic-mean/1 (mean over the groups with a cell of
                     (A_g + 1) / (A_g + D_g + 2), 0.5 with none); the factor
                     is exactly 1 with fewer than gic_min_groups groups. G
                     always reads update u, under either policy.
  the floor          d_j = a / n + (1 - a) * b_j / B over the candidates, with
                     b_j the weight (an unscored comment's b_j = 1) and
                     B = sum of b; when B = 0 the weighted share is given to
                     the uniform lane and d_j = 1 / n.

Run: python3 -I make_crosscheck_5.py (writes vectors-5.json beside it). Every
case is constructed and every id made up. The crate never sees a signed vote:
these are counts.
"""

import json
import math
import os

DEFAULTS = {
    "side_prior": 1.0,
    "seen_prior": 2.0,
    "extremity_offset": 1.0,
    "novelty_amplitude": 8.0,
    "novelty_halving_votes": 5.0,
    "exponent": 2,
    "meta_inner": 7.0,
    "meta_policy": "fixed",
    "consensus_form": "gic-geomean/1",
    "gic_offset": 0.5,
    "gic_min_groups": 2,
    "floor_share": 0.1,
}


def latest(case):
    """Lag-0 counts: (A, D, P) summed over the groups with a cell."""
    out = {}
    for _g, tid, a, d, s in case["cells"]:
        prev = out.get(tid, (0, 0, 0))
        out[tid] = (prev[0] + a, prev[1] + d, prev[2] + (s - a - d))
    return out


def previous(case):
    return {tid: (a, d, p) for tid, a, d, p in case["previous"]}


def symmetric(p, a, d, pa, e):
    s = a + d + pa
    r = (a + d + p["side_prior"]) / (s + p["seen_prior"])
    novelty = 1.0 + p["novelty_amplitude"] * 2.0 ** (-s / p["novelty_halving_votes"])
    return (r * r * (e + p["extremity_offset"]) * novelty) ** p["exponent"]


def factor(p, case, tid):
    members = [g for g, _n in case["members"]]
    if len(members) < p["gic_min_groups"]:
        return 1.0
    cells = {(g, t): (a, d, s) for g, t, a, d, s in case["cells"]}
    if p["consensus_form"] == "gic-geomean/1":
        logs = []
        for g in members:
            a, _d, s = cells.get((g, tid), (0, 0, 0))
            logs.append(math.log((a + 1.0) / (s + 2.0)))
        g_value = math.exp(sum(logs) / len(logs))
    else:
        values = []
        for g in members:
            if (g, tid) in cells:
                a, d, _s = cells[(g, tid)]
                values.append((a + 1.0) / (a + d + 2.0))
        g_value = sum(values) / len(values) if values else 0.5
    return p["gic_offset"] + g_value


def weights(case, counts, with_factor):
    """Per comment: a weight, None (unscored) or "excluded"."""
    p = dict(DEFAULTS, **case.get("params", {}))
    extremity = dict((tid, e) for tid, e in case["extremity"])
    meta = set(case.get("meta", []))
    out = {}
    for tid in sorted(set(counts) | set(extremity)):
        if tid in meta and p["meta_policy"] == "exclude":
            out[tid] = "excluded"
        elif tid not in counts or tid not in extremity:
            out[tid] = None
        elif tid in meta and p["meta_policy"] == "fixed":
            out[tid] = p["meta_inner"] ** p["exponent"]
        else:
            a, d, pa = counts[tid]
            w = symmetric(p, a, d, pa, extremity[tid])
            out[tid] = w * factor(p, case, tid) if with_factor else w
    for tid in meta:
        if p["meta_policy"] == "exclude":
            out[tid] = "excluded"
    return out


def floor(case, base):
    p = dict(DEFAULTS, **case.get("params", {}))
    a = p["floor_share"]
    b = [1.0 if base[t] is None else base[t] for t in case["candidates"]]
    n = len(b)
    total = sum(b)
    if total == 0.0:
        return [1.0 / n for _ in b]
    return [a / n + (1.0 - a) * x / total for x in b]


def plain(ws):
    return {str(t): w for t, w in sorted(ws.items())}


def evaluate(case):
    lag1, lag0 = previous(case), latest(case)
    gic1 = weights(case, lag1, True)
    gic2 = weights(case, lag0, True)
    return {
        "symmetric/1": plain(weights(case, lag1, False)),
        "symmetric/2": plain(weights(case, lag0, False)),
        "symmetric-gic/1": plain(gic1),
        "symmetric-gic/2": plain(gic2),
        "symmetric-gic-floor/1": floor(case, gic1),
        "symmetric-gic-floor/2": floor(case, gic2),
    }


def group(g, members):
    return [g, members]


def cases():
    out = []
    # (1) The witness: lagged and latest give different weights.
    out.append({
        "id": "witness",
        "members": [group(0, 4), group(2, 3)],
        "cells": [[0, 7, 3, 0, 4], [0, 8, 1, 1, 2], [2, 7, 0, 2, 2], [2, 8, 0, 1, 3]],
        "previous": [[7, 1, 0, 0], [8, 0, 1, 0]],
        "extremity": [[7, 0.5], [8, 1.5]],
        "candidates": [7, 8],
    })
    # (2) A first update: no previous counts, latest counts present.
    out.append({
        "id": "first-update",
        "members": [group(0, 5), group(1, 4)],
        "cells": [[0, 1, 2, 1, 4], [1, 1, 0, 3, 3], [0, 2, 1, 0, 1], [1, 3, 2, 2, 4]],
        "previous": [],
        "extremity": [[1, 0.25], [2, 2.0], [3, 0.0]],
        "candidates": [1, 2, 3],
    })
    # (3) Extremity only (unscored under /2), present-zero cells in every
    # group (scored at zero counts), counts only (unscored).
    out.append({
        "id": "presence",
        "members": [group(0, 3), group(1, 3)],
        "cells": [[0, 6, 0, 0, 0], [1, 6, 0, 0, 0], [0, 9, 2, 0, 3]],
        "previous": [[5, 1, 1, 1], [6, 0, 0, 0]],
        "extremity": [[5, 0.75], [6, 1.25]],
        "candidates": [5, 6],
    })
    # (4) Fewer groups than gic_min_groups: the factor is 1. One group at
    # the defaults; two groups under gic_min_groups = 3 with gic-mean/1.
    out.append({
        "id": "one-group",
        "members": [group(4, 6)],
        "cells": [[4, 1, 3, 1, 5], [4, 2, 0, 4, 6]],
        "previous": [[1, 2, 0, 1], [2, 0, 2, 0]],
        "extremity": [[1, 0.5], [2, 0.9]],
        "candidates": [1, 2],
    })
    out.append({
        "id": "below-min-groups-mean",
        "members": [group(0, 6), group(1, 5)],
        "cells": [[0, 1, 3, 1, 5], [1, 1, 1, 3, 4], [0, 2, 0, 2, 2]],
        "previous": [[1, 2, 1, 1], [2, 0, 1, 0]],
        "extremity": [[1, 0.5], [2, 0.9]],
        "params": {"consensus_form": "gic-mean/1", "gic_min_groups": 3},
        "candidates": [1, 2],
    })
    # (5) Sparse group ids 0, 2, 7, and the same groups renamed.
    sparse = {
        "members": [group(0, 4), group(2, 5), group(7, 3)],
        "cells": [[0, 3, 2, 1, 4], [2, 3, 0, 4, 5], [7, 3, 1, 1, 3],
                  [0, 4, 0, 0, 1], [7, 4, 3, 0, 3]],
        "previous": [[3, 1, 2, 0], [4, 1, 0, 0]],
        "extremity": [[3, 1.0], [4, 0.2]],
        "candidates": [3, 4],
    }
    out.append(dict(sparse, id="sparse-groups"))
    rename = {0: 11, 2: 5, 7: 1}
    out.append(dict(
        sparse,
        id="sparse-groups-renamed",
        members=[group(rename[g], n) for g, n in reversed(sparse["members"])],
        cells=[[rename[g], t, a, d, s] for g, t, a, d, s in reversed(sparse["cells"])],
    ))
    # (6) The three meta policies; meta comment 20 is in both frames, 21 in
    # the group frame only, 22 in neither.
    meta_case = {
        "members": [group(0, 4), group(1, 4)],
        "cells": [[0, 10, 2, 1, 4], [1, 10, 0, 3, 4], [0, 20, 1, 1, 2],
                  [1, 21, 1, 0, 1]],
        "previous": [[10, 1, 1, 0], [20, 1, 0, 0]],
        "extremity": [[10, 0.6], [20, 0.4]],
        "meta": [20, 21, 22],
    }
    out.append(dict(meta_case, id="meta-fixed", candidates=[10, 20]))
    out.append(dict(meta_case, id="meta-ordinary", params={"meta_policy": "ordinary"},
                    candidates=[10, 20]))
    out.append(dict(meta_case, id="meta-exclude", params={"meta_policy": "exclude"},
                    candidates=[10]))
    # (7) One candidate, and twelve with non-default parameters.
    out.append({
        "id": "one-candidate",
        "members": [group(0, 2), group(1, 2)],
        "cells": [[0, 1, 1, 0, 1], [1, 1, 0, 1, 2]],
        "previous": [[1, 0, 1, 0]],
        "extremity": [[1, 0.3]],
        "candidates": [1],
    })
    cells, prev, ext = [], [], []
    for t in range(1, 13):
        cells.append([0, t, t % 4, (t * 3) % 5, (t % 4) + ((t * 3) % 5) + (t % 3)])
        if t % 2:
            cells.append([3, t, (t * 2) % 3, t % 2, ((t * 2) % 3) + (t % 2) + 1])
        prev.append([t, t % 3, (t + 1) % 3, t % 2])
        ext.append([t, (t % 5) * 0.35])
    out.append({
        "id": "twelve-candidates-nondefault",
        "members": [group(0, 9), group(3, 4)],
        "cells": cells,
        "previous": prev,
        "extremity": ext,
        "params": {
            "side_prior": 0.5, "seen_prior": 3.0, "extremity_offset": 0.25,
            "novelty_amplitude": 2.0, "novelty_halving_votes": 7.0, "exponent": 3,
            "meta_inner": 4.0, "consensus_form": "gic-mean/1", "gic_offset": 0.75,
            "gic_min_groups": 2, "floor_share": 0.3,
        },
        "candidates": list(range(1, 13)),
    })
    return out


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    doc = {
        "header": {
            "generator": "make_crosscheck_5.py",
            "statement": "base-counts:lag-1 reads the previous update's (A, D, P); base-counts:lag-0 sums (A, D, S - A - D) over the groups of the update read that have a cell, present if any cell; symmetric R=(A+D+side_prior)/(S+seen_prior), w=(R*R*(E+offset)*(1+amp*2^(-S/halving)))^exponent; symmetric-gic multiplies by gic_offset+G read from the update read; the floor d_j=a/n+(1-a)*b_j/B, unscored b_j=1",
            "tolerance": 1e-12,
            "scope": "constructed cases; every id made up; counts, never votes",
        },
        "cases": [],
    }
    for case in cases():
        doc["cases"].append(dict(case, expect=evaluate(case)))
    with open(os.path.join(here, "vectors-5.json"), "w") as f:
        json.dump(doc, f, indent=1)
        f.write("\n")


if __name__ == "__main__":
    main()
