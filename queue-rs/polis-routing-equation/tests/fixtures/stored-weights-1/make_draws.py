"""An independent second oracle for stored-weights/1: a line-by-line
transliteration of the Node server's selectProbabilistically
(server/src/nextComment.ts) into Python floats.

JavaScript numbers and Python floats are both IEEE doubles with the same +, *
and >, so for the weights below this computes the same running sums,
randomN and chosen position as Node. It writes the cases to draws.json, with
floats written by repr() through json so each double reads back exactly.

  python3 -I make_draws.py --out draws.json

Negative stored weights are left out: Node draws them, the crate refuses them.
"""

import argparse
import json
import math


def select_probabilistically(tids, priorities, unit):
    """nextComment.ts, selectProbabilistically, with Math.random() as unit."""
    last_count = 0.0                                    # { lastCount: 0 }
    lookup = []
    for tid in tids:
        value = priorities.get(str(tid))                # priorities[comment.tid]
        lookup_val = last_count + float(value or 1.0)   # o.lastCount + (... || 1)
        lookup.append((lookup_val, tid))
        last_count = lookup_val
    random_n = unit * last_count                        # Math.random() * lookup.lastCount
    for position, (val, _tid) in enumerate(lookup):     # _.find(..., x[0] > randomN)
        if val > random_n:
            return position, random_n, last_count
    return None, random_n, last_count


class XorShift:
    def __init__(self, seed):
        self.state = seed

    def next(self):
        x = self.state
        x ^= (x << 13) & 0xFFFFFFFFFFFFFFFF
        x ^= x >> 7
        x ^= (x << 17) & 0xFFFFFFFFFFFFFFFF
        self.state = x
        return x

    def below(self, n):
        return self.next() % n

    def unit(self):
        return (self.next() >> 11) / float(1 << 53)


MISSING = object()
PALETTE = [MISSING, None, False, 0, 0.0, 1e-9, 0.5, 1, 2.5, 3, 7.25, 1e6, 5e-324, 1e150]


def case(name, priorities, tids, unit):
    position, random_n, total = select_probabilistically(tids, priorities if priorities is not None else {}, unit)
    return {"name": name, "priorities": priorities, "candidates": tids, "unit": unit,
            "index": position, "random_n": random_n, "total": total}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    below_one = math.nextafter(1.0, 0.0)
    cases = [
        case("recorded unit 0", {"0": 0, "1": 3}, [0, 1], 0.0),
        case("recorded unit 0.25", {"0": 0, "1": 3}, [0, 1], 0.25),
        case("recorded no map", None, [0, 1], 0.75),
        case("[1, 3] just below 0.25", {"0": 1, "1": 3}, [0, 1], math.nextafter(0.25, 0.0)),
        case("[1, 3] at 0.25", {"0": 1, "1": 3}, [0, 1], 0.25),
        case("2^-1021 below one", {"0": 2.0 ** -1021}, [0], below_one),
        case("5e-324 below one", {"0": 5e-324}, [0], below_one),
        case("[1, 5e-324] absorbed", {"0": 1, "1": 5e-324}, [0, 1], below_one),
    ]
    rng = XorShift(0x9E3779B97F4A7C15)
    for k in range(120):
        n = 1 + rng.below(7)
        tids = list(range(n))
        priorities = {}
        for tid in tids:
            v = PALETTE[rng.below(len(PALETTE))]
            if v is MISSING:
                continue
            priorities[str(tid)] = rng.unit() * 10 if v == 7.25 else v
        units = [rng.unit(), 0.0, below_one]
        # The boundary of every candidate's interval, and its neighbours.
        _, _, total = select_probabilistically(tids, priorities, 0.0)
        running = 0.0
        for tid in tids:
            running = running + float(priorities.get(str(tid)) or 1.0)
            if total > 0:
                u = running / total
                for v in (math.nextafter(u, 0.0), u, math.nextafter(u, 1.0)):
                    if 0.0 <= v < 1.0:
                        units.append(v)
        for j, unit in enumerate(units):
            cases.append(case(f"generated {k}.{j}", priorities, tids, unit))
    with open(args.out, "w") as f:
        f.write('{"generator": "make_draws.py, a transliteration of selectProbabilistically",\n"cases": [\n')
        f.write(",\n".join(json.dumps(c, allow_nan=False) for c in cases))
        f.write("\n]}\n")
    print(f"wrote {len(cases)} cases to {args.out}")


if __name__ == "__main__":
    main()
