"""An independent statement of the corrected rules, in NumPy, for the crate's
cross-check.

Written from the formulas in the crate's README and registry (not from the
Rust code): symmetric/1, the group-informed consensus factor in its two forms
(gic-mean/1, gic-geomean/1) and symmetric-gic/1 in both forms. For each
constructed case it writes every comment's weight (null when unscored), G and
the factor, and the probability vector a draw over the candidates would have,
with an unscored comment's weight read as 1. Floats go through repr() in json,
so each double reads back exactly. The Rust test reproduces them at 1e-12.

  uv run --no-project --with numpy==2.1.3 python3 -I make_crosscheck.py --out vectors-3.json

No vote value appears here: the inputs are counts of agrees, disagrees and
passes, by name.
"""

import argparse
import json

import numpy as np

SYMMETRIC = dict(side_prior=1.0, seen_prior=2.0, extremity_offset=1.0,
                 novelty_amplitude=8.0, novelty_halving_votes=5.0, exponent=2,
                 meta_inner=7.0)
GIC_OFFSET = 0.5
GIC_MIN_GROUPS = 2

SYM_PLAIN = ('"side_prior":1.0,"seen_prior":2.0,"extremity_offset":1.0,'
             '"novelty_amplitude":8.0,"novelty_halving_votes":5.0,"exponent":2,'
             '"meta_inner":7.0,"meta_policy":"fixed"')
GIC_PLAIN = '"gic_offset":0.5,"gic_min_groups":2'


def plain(rule, params):
    return '{"rule":"%s","params":{%s},"terms":[]}' % (rule, params)


RULES = [
    ("symmetric", plain("symmetric/1", SYM_PLAIN)),
    ("gic-mean", plain("gic-mean/1", GIC_PLAIN)),
    ("gic-geomean", plain("gic-geomean/1", GIC_PLAIN)),
    ("symmetric-gic-geomean", plain(
        "symmetric-gic/1", SYM_PLAIN + ',"consensus_form":"gic-geomean/1",' + GIC_PLAIN)),
    ("symmetric-gic-mean", plain(
        "symmetric-gic/1", SYM_PLAIN + ',"consensus_form":"gic-mean/1",' + GIC_PLAIN)),
]


def symmetric_weight(a, d, p, e):
    """(R * R * (E + 1) * (1 + 8 * 2^(-S/5)))^2, R = (A + D + 1) / (S + 2)."""
    s = SYMMETRIC
    seen = np.float64(a + d + p)
    r = (np.float64(a + d) + s["side_prior"]) / (seen + s["seen_prior"])
    novelty = 1.0 + s["novelty_amplitude"] * np.exp2(-seen / s["novelty_halving_votes"])
    inner = r * r * (np.float64(e) + s["extremity_offset"]) * novelty
    return inner ** s["exponent"]


def gic(form, case, tid):
    """G and the factor for one comment, or (None, 1.0) with too few groups."""
    groups = sorted(case["groups"]["members"])
    if len(groups) < GIC_MIN_GROUPS:
        return None, 1.0
    cells = {(g, t): (a, d, p) for g, t, a, d, p in case["groups"]["cells"]}
    if form == "mean":
        vals = np.array([(a + 1.0) / (a + d + 2.0)
                         for g in groups if (g, tid) in cells
                         for a, d, _p in [cells[(g, tid)]]])
        g_value = float(np.mean(vals)) if len(vals) else 0.5
    else:
        a = np.array([cells.get((g, tid), (0, 0, 0))[0] for g in groups], dtype=float)
        n = np.array([sum(cells.get((g, tid), (0, 0, 0))) for g in groups], dtype=float)
        g_value = float(np.exp(np.mean(np.log((a + 1.0) / (n + 2.0)))))
    return g_value, GIC_OFFSET + g_value


def evaluate(case, rule):
    out = {"rule": rule[0], "params": rule[1], "comments": {}}
    ids = sorted(set(case["previous"]) | set(case["extremity"]), key=int)
    weights = {}
    for tid in ids:
        entry = {}
        form = {"gic-mean": "mean", "gic-geomean": "geo",
                "symmetric-gic-mean": "mean", "symmetric-gic-geomean": "geo"}.get(rule[0])
        if form is not None:
            g_value, factor = gic(form, case, int(tid))
            entry["g"] = g_value
            entry["factor"] = factor
        if rule[0].startswith("symmetric"):
            scored = tid in case["previous"] and tid in case["extremity"]
            if not scored:
                w = None
            elif int(tid) in case["meta"]:
                w = SYMMETRIC["meta_inner"] ** SYMMETRIC["exponent"]
            else:
                a, d, p = case["previous"][tid]
                w = float(symmetric_weight(a, d, p, case["extremity"][tid]))
                if form is not None:
                    w = w * entry["factor"]
            entry["weight"] = w
            weights[tid] = w
        out["comments"][tid] = entry
    if rule[0].startswith("symmetric"):
        mapped = np.array([1.0 if weights.get(str(t)) is None else weights[str(t)]
                           for t in case["candidates"]])
        out["probabilities"] = [float(x) for x in mapped / mapped.sum()]
    return out


class Lcg:
    """A fixed generator for the larger constructed cases."""

    def __init__(self, seed):
        self.x = seed

    def below(self, n):
        self.x = (self.x * 6364136223846793005 + 1442695040888963407) % (1 << 64)
        return (self.x >> 33) % n


def random_case(name, seed, group_ids, n_comments, absent_every=0):
    rng = Lcg(seed)
    members = {g: 5 + rng.below(40) for g in group_ids}
    cells, previous, extremity = [], {}, {}
    for t in range(n_comments):
        tot = [0, 0, 0]
        for g in group_ids:
            if absent_every and rng.below(absent_every) == 0:
                continue
            m = members[g]
            a = rng.below(m + 1)
            d = rng.below(m - a + 1)
            p = rng.below(m - a - d + 1)
            cells.append([g, t, a, d, p])
            tot = [tot[0] + a, tot[1] + d, tot[2] + p]
        previous[str(t)] = [max(0, x - rng.below(3)) for x in tot]
        extremity[str(t)] = [0.0, 0.25, 1.0, 2.5, 7.0][rng.below(5)]
    return dict(name=name, candidates=list(range(n_comments)),
                groups=dict(members=members, cells=cells),
                previous=previous, extremity=extremity, meta=[])


def cases():
    out = [
        dict(name="two groups, every cell present", candidates=[3, 1, 2, 0],
             groups=dict(members={0: 10, 1: 12},
                         cells=[[0, 0, 9, 1, 0], [1, 0, 2, 8, 1], [0, 1, 5, 5, 0],
                                [1, 1, 6, 6, 0], [0, 2, 0, 0, 10], [1, 2, 1, 0, 0],
                                [0, 3, 0, 0, 0], [1, 3, 0, 0, 0]]),
             previous={"0": [11, 9, 1], "1": [10, 10, 0], "2": [1, 0, 9], "3": [0, 0, 0]},
             extremity={"0": 0.4, "1": 0.0, "2": 3.0, "3": 1.25}, meta=[]),
        dict(name="three sparse groups, absent and zero cells", candidates=[0, 1, 2, 3, 4],
             groups=dict(members={0: 20, 2: 20, 7: 5},
                         cells=[[0, 0, 9, 1, 0], [2, 0, 0, 0, 0], [0, 1, 9, 1, 0],
                                [2, 2, 3, 3, 3], [7, 2, 5, 0, 0], [0, 3, 1, 1, 0],
                                [2, 3, 1, 1, 0], [7, 3, 0, 4, 1]]),
             previous={"0": [9, 1, 0], "1": [9, 1, 0], "2": [8, 3, 3], "3": [2, 6, 1], "4": [0, 0, 0]},
             extremity={"0": 0.5, "1": 0.5, "2": 0.5, "3": 0.5, "4": 0.5}, meta=[]),
        dict(name="one candidate", candidates=[5],
             groups=dict(members={1: 3, 4: 3}, cells=[[1, 5, 3, 0, 0], [4, 5, 0, 3, 0]]),
             previous={"5": [3, 3, 0]}, extremity={"5": 2.0}, meta=[]),
        dict(name="one group: the factor is 1", candidates=[0, 1],
             groups=dict(members={0: 9}, cells=[[0, 0, 8, 0, 0], [0, 1, 0, 8, 0]]),
             previous={"0": [8, 0, 0], "1": [0, 8, 0]}, extremity={"0": 1.0, "1": 1.0}, meta=[]),
        dict(name="first tick: no previous counts, no groups", candidates=[0, 1, 2],
             groups=dict(members={}, cells=[]),
             previous={}, extremity={"0": 0.0, "1": 1.0, "2": 2.0}, meta=[]),
        dict(name="new comments unscored beside scored ones", candidates=[0, 1, 2, 3],
             groups=dict(members={0: 6, 1: 6},
                         cells=[[0, 0, 6, 0, 0], [1, 0, 6, 0, 0], [0, 2, 1, 0, 0]]),
             previous={"0": [12, 0, 0], "1": [0, 0, 1]},
             extremity={"0": 0.5, "1": 0.5, "2": 0.5}, meta=[]),
        dict(name="a fixed meta comment", candidates=[0, 1],
             groups=dict(members={0: 6, 1: 6},
                         cells=[[0, 0, 6, 0, 0], [1, 0, 6, 0, 0], [0, 1, 6, 0, 0], [1, 1, 0, 6, 0]]),
             previous={"0": [12, 0, 0], "1": [6, 6, 0]},
             extremity={"0": 0.5, "1": 0.5}, meta=[1]),
    ]
    out.append(random_case("five groups, twelve candidates", 2024, [0, 1, 2, 3, 4], 12))
    out.append(random_case("five sparse groups, twelve candidates, absent cells",
                           7, [2, 3, 5, 11, 40], 12, absent_every=3))
    out.append(random_case("three groups, twelve candidates", 99, [0, 1, 2], 12, absent_every=5))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    built = []
    for case in cases():
        case["groups"]["members"] = {int(k): int(v) for k, v in case["groups"]["members"].items()}
        built.append(dict(case, results=[evaluate(case, r) for r in RULES]))
        built[-1]["groups"] = dict(members=[[g, m] for g, m in sorted(case["groups"]["members"].items())],
                                   cells=case["groups"]["cells"])
    doc = dict(header=dict(
        generator="make_crosscheck.py",
        numpy=np.__version__,
        statement=("symmetric/1: (R*R*(E+1)*(1+8*2^(-S/5)))^2 with R=(A+D+1)/(S+2); "
                   "gic-mean/1: mean over groups with a count of (A+1)/(A+D+2), 0.5 with none; "
                   "gic-geomean/1: exp(mean over every group of ln((A+1)/(S+2))), absent as no votes; "
                   "factor 0.5+G, exactly 1 with fewer than 2 groups; symmetric-gic/1: symmetric/1 times "
                   "the factor; unscored comments weigh nothing here and 1 in a draw, unmultiplied; "
                   "a fixed meta comment weighs 7^2"),
        tolerance=1e-12,
        scope="constructed cases; importance, the floor and zero mass are not in this file"),
        cases=built)
    with open(args.out, "w") as f:
        json.dump(doc, f, indent=1)
        f.write("\n")


if __name__ == "__main__":
    main()
