"""An independent statement of the floor rule and the importance terms, in
NumPy, for the crate's second cross-check (vectors-4.json).

Written from the formulas of the rules as published (the crate's README and
registry), not from the Rust code, and separately from make_crosscheck.py,
which is a published fixture and is not changed. It states:

  symmetric-gic/1    w = (R * R * (E + 1) * (1 + 8 * 2^(-S/5)))^2 * (0.5 + G),
                     R = (A + D + 1) / (S + 2); G by gic-geomean/1 (exp of the
                     mean over every member group of ln((A + 1) / (S + 2)),
                     an absent count read as no votes) or gic-mean/1 (mean
                     over groups with a count of (A + 1) / (A + D + 2), 0.5
                     with none); the factor is exactly 1 with fewer than two
                     groups; a fixed meta comment weighs 7^2 with no factor
                     and no term; a comment in only one frame is unscored.
  importance-lift/1  rho = marked_total / eligible_total;
                     r = (M + k * rho) / (n + k); m = clamp(r / rho, 1, cap),
                     k = 20, cap = 3; m = 1 when the comment has no marks
                     record, when n = 0, or when the totals are unavailable,
                     have no eligible votes or no marks.
  importance-normalized-lift/1
                     m = max(1, (S_j / V_j) / (sum S / sum V)), no cap;
                     m = 1 when V_j = 0.
                     A term multiplies a scored, non-meta comment's weight.
  the floor          d_j = a / n + (1 - a) * b_j / B over the candidates, with
                     b_j the weight (an unscored comment's b_j = 1) and
                     B = sum of b; when B = 0 the weighted share is given to
                     the uniform lane and d_j = 1 / n.

For each constructed case it writes each comment's weight (null when
unscored), each scored comment's multiplier, and for the candidates in order
the draw weights d, the uniform parts a / n and the weighted parts. Floats go
through repr() in json, so each double reads back exactly. The Rust test
(tests/crosscheck_floor.rs) reproduces them at 1e-12.

  uv run --no-project --with numpy==2.1.3 python3 -I make_crosscheck_4.py --out vectors-4.json

No vote value appears here: the inputs are counts of agrees, disagrees and
passes, by name, and counts of marked and eligible votes.
"""

import argparse
import json

import numpy as np

K, CAP = 20.0, 3.0


def symmetric(a, d, p, e):
    seen = np.float64(a + d + p)
    r = (np.float64(a + d) + 1.0) / (seen + 2.0)
    novelty = 1.0 + 8.0 * np.exp2(-seen / 5.0)
    return (r * r * (np.float64(e) + 1.0) * novelty) ** 2


def factor(form, case, tid):
    members = case["groups"]["members"]
    if len(members) < 2:
        return 1.0
    cells = {(g, t): (a, d, p) for g, t, a, d, p in case["groups"]["cells"]}
    if form == "gic-mean/1":
        vals = [(a + 1.0) / (a + d + 2.0) for (g, t), (a, d, p) in cells.items() if t == tid]
        g_value = float(np.mean(vals)) if vals else 0.5
    else:
        logs = []
        for g, _ in members:
            a, d, p = cells.get((g, tid), (0, 0, 0))
            logs.append(np.log((a + 1.0) / (a + d + p + 2.0)))
        g_value = float(np.exp(np.mean(logs)))
    return 0.5 + g_value


def multiplier(term, tid):
    if term is None:
        return 1.0
    if term["term"] == "importance-lift/1":
        marks = {t: (m, n) for t, m, n in term["marks"]}
        totals = term["totals"]
        if tid not in marks or totals is None or totals[0] == 0 or totals[1] == 0:
            return 1.0
        m, n = marks[tid]
        if n == 0:
            return 1.0
        rho = totals[0] / totals[1]
        return float(np.clip(((m + K * rho) / (n + K)) / rho, 1.0, CAP))
    rows = {t: (v, s) for t, v, s in term["voters"]}
    if tid not in rows or rows[tid][0] == 0:
        return 1.0
    v, s = rows[tid]
    return max(1.0, (s / v) / (term["total_weight"] / term["total_voters"]))


def floor(alpha, base):
    base = np.array(base, dtype=np.float64)
    n = len(base)
    total = base.sum()
    if total == 0.0:
        uniform = np.full(n, 1.0 / n)
        return uniform, uniform, np.zeros(n), True
    uniform = np.full(n, alpha / n)
    weighted = (1.0 - alpha) * (base / total)
    return uniform + weighted, uniform, weighted, False


def evaluate(case):
    prev = {t: (a, d, p) for t, a, d, p in case["previous"]}
    ext = {t: e for t, e in case["extremity"]}
    weights, mults = {}, {}
    for tid in sorted(set(prev) | set(ext)):
        if tid not in prev or tid not in ext:
            weights[tid] = None
        elif tid in case["meta"]:
            weights[tid] = 49.0
        else:
            m = multiplier(case["term"], tid)
            mults[tid] = m
            w = symmetric(*prev[tid], ext[tid]) * factor(case["form"], case, tid)
            weights[tid] = float(w * m)
    base = [1.0 if weights[t] is None else weights[t] for t in case["candidates"]]
    d, u, w, donated = floor(case["floor_share"], base)
    return {
        "weights": [[t, weights[t]] for t in sorted(weights)],
        "multipliers": [[t, mults[t]] for t in sorted(mults)],
        "d": [float(x) for x in d],
        "uniform": [float(x) for x in u],
        "weighted": [float(x) for x in w],
        "donated": donated,
    }


def lanes(name, alpha, base):
    d, u, w, donated = floor(alpha, base)
    return {"name": name, "kind": "lanes", "floor_share": alpha, "base": base,
            "expect": {"d": [float(x) for x in d], "uniform": [float(x) for x in u],
                       "weighted": [float(x) for x in w], "donated": donated}}


def two_groups(term=None, form="gic-geomean/1", alpha=0.1):
    return {
        "previous": [[0, 3, 1, 0], [1, 0, 4, 1], [2, 2, 2, 2], [3, 0, 0, 0], [4, 5, 0, 1]],
        "extremity": [[0, 0.5], [1, 1.25], [2, 0.0], [3, 2.0], [5, 0.75]],
        "groups": {"members": [[0, 6], [2, 4]],
                   "cells": [[0, 0, 3, 1, 0], [2, 0, 0, 2, 1], [0, 1, 1, 3, 0],
                             [0, 2, 2, 1, 1], [2, 2, 2, 0, 0], [0, 4, 4, 0, 1]]},
        "meta": [4], "candidates": [0, 1, 2, 3, 4, 5], "form": form,
        "floor_share": alpha, "term": term,
    }


def five_groups(term, alpha):
    rng = np.random.default_rng(4017)
    gids = [1, 4, 6, 11, 40]
    prev, ext, cells = [], [], []
    for t in range(12):
        a, d, p = (int(x) for x in rng.integers(0, 15, size=3))
        prev.append([t, a, d, p])
        ext.append([t, float(np.round(rng.uniform(0, 3), 6))])
        for g in gids:
            if (t + g) % 4 != 0:
                ga, gd, gp = (int(x) for x in rng.integers(0, 5, size=3))
                cells.append([g, t, ga, gd, gp])
    return {"previous": prev, "extremity": ext,
            "groups": {"members": [[g, 15] for g in gids], "cells": cells},
            "meta": [], "candidates": list(range(12)), "form": "gic-geomean/1",
            "floor_share": alpha, "term": term}


LIFT = {"term": "importance-lift/1",
        "marks": [[0, 2, 4], [1, 0, 5], [2, 1, 6], [3, 0, 0]], "totals": [6, 60]}
LIFT_NO_TOTALS = dict(LIFT, totals=None)
LIFT_NO_MARKS = {"term": "importance-lift/1", "marks": [[0, 0, 4], [1, 0, 5]],
                 "totals": [0, 60]}
NORMALIZED = {"term": "importance-normalized-lift/1",
              "voters": [[0, 2, 52.0], [1, 3, 3.0], [2, 0, 0.0], [3, 1, 1.0]],
              "total_voters": 10, "total_weight": 70.0}
FIVE_LIFT = {"term": "importance-lift/1",
             "marks": [[t, t % 3, 6 + t] for t in range(12)], "totals": [40, 400]}


def cases():
    out = []
    for name, case in [
        ("floor, two groups, geometric mean, an unscored and a meta comment", two_groups()),
        ("floor, two groups, mean, floor 0.25", two_groups(form="gic-mean/1", alpha=0.25)),
        ("floor 0: the weights alone", two_groups(alpha=0.0)),
        ("floor with importance-lift/1", two_groups(term=LIFT)),
        ("importance-lift/1 with its totals unavailable", two_groups(term=LIFT_NO_TOTALS)),
        ("importance-lift/1 with no marks in the conversation", two_groups(term=LIFT_NO_MARKS)),
        ("floor with importance-normalized-lift/1", two_groups(term=NORMALIZED)),
        ("five sparse groups, twelve candidates, importance-lift/1", five_groups(FIVE_LIFT, 0.1)),
        ("five sparse groups, twelve candidates, no importance", five_groups(None, 0.3)),
        ("one candidate", dict(two_groups(), candidates=[2])),
        ("one group: the factor is 1", dict(two_groups(), groups={
            "members": [[0, 6]], "cells": [[0, 0, 3, 1, 0]]})),
    ]:
        out.append(dict(case, name=name, kind="rule", expect=evaluate(case)))
    out += [
        lanes("lanes [1, 3] at 0.1", 0.1, [1.0, 3.0]),
        lanes("lanes [0, 2] at 0.1: a zero weight keeps its floor", 0.1, [0.0, 2.0]),
        lanes("lanes [1, 5e-324] at 0.1", 0.1, [1.0, 5e-324]),
        lanes("zero mass [0, 0] at 0.1: donated", 0.1, [0.0, 0.0]),
        lanes("zero mass [0, 0, 0] at 0.25: donated", 0.25, [0.0, 0.0, 0.0]),
        lanes("lanes [2, 0, 6] at 0.25", 0.25, [2.0, 0.0, 6.0]),
        lanes("lanes, twelve weights at 0.1", 0.1,
              [float(x) for x in np.random.default_rng(7).uniform(0, 40, size=12)]),
    ]
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    doc = {
        "header": {
            "generator": "make_crosscheck_4.py",
            "numpy": np.__version__,
            "statement": "symmetric-gic/1 weights as in vectors-3.json; importance-lift/1: "
                         "rho=marked/eligible over the conversation, r=(M+20*rho)/(n+20), "
                         "m=clamp(r/rho,1,3), exactly 1 with no record, n=0 or no usable "
                         "totals; importance-normalized-lift/1: m=max(1,(S_j/V_j)/(sum S/sum V)), "
                         "1 at V_j=0; a term multiplies a scored non-meta weight; the floor: "
                         "d_j=a/n+(1-a)*b_j/B, unscored b_j=1, B=0 donates to uniform (1/n)",
            "tolerance": 1e-12,
            "scope": "constructed cases; meta_policy fixed only; parameters at their "
                     "defaults except the floor share",
        },
        "cases": cases(),
    }
    with open(args.out, "w") as f:
        json.dump(doc, f, indent=1)
        f.write("\n")


if __name__ == "__main__":
    main()
