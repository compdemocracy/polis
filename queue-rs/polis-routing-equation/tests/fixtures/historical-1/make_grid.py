"""Record historical/1's grid of cases from the real Python priority formula.

Calls polismath.conversation.conversation.priority_metric directly, over the
grid below, and writes every case with the weight Python returned. Floats are
written by json, which uses repr(), so each double reads back exactly.

Run once, in the delphi image built from the commit named by --commit, with
the image's own delphi source (the directory that holds polismath):

  python -I make_grid.py --delphi /app --commit <sha> --image <image id> --out grid.json

The fixture this writes is never edited: a changed Python formula is a new
rule version with its own fixture.
"""

import argparse
import hashlib
import inspect
import json
import os
import platform
import sys

S_VALUES = [0, 1, 2, 3, 5, 10, 20, 50, 200, 279, 280, 281, 10000, 4294967295]
E_VALUES = [0.0, 5e-324, 1e-300, 0.1, 1.0, 3.7, 50.0, 400.0, 1e70]


def splits(seen):
    """Every agreed/disagreed/passed split up to 5 votes seen; above that, all
    agreed, all disagreed, all passed and an even split."""
    if seen <= 5:
        for agreed in range(seen + 1):
            for disagreed in range(seen - agreed + 1):
                yield agreed, disagreed, seen - agreed - disagreed
    else:
        third = seen // 3
        yield seen, 0, 0
        yield 0, seen, 0
        yield 0, 0, seen
        yield third, third, seen - 2 * third


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--delphi", required=True, help="the directory that holds polismath")
    ap.add_argument("--commit", required=True)
    ap.add_argument("--image", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    sys.path.insert(0, os.path.abspath(args.delphi))
    import numpy
    from polismath.conversation import conversation as conv

    fn = conv.priority_metric
    cases = []
    for seen in S_VALUES:
        for agreed, disagreed, passed in splits(seen):
            for extremity in E_VALUES:
                for meta in (False, True):
                    # The engine's call: priority_metric(is_meta, A, P, S, E),
                    # with A, P and S as integers and E as a float.
                    weight = float(fn(meta, agreed, passed, seen, extremity))
                    cases.append({
                        "agreed": agreed, "disagreed": disagreed, "passed": passed,
                        "seen": seen, "extremity": extremity, "meta": meta,
                        "weight": weight,
                    })

    with open(__file__, "rb") as f:
        generator_sha = sha256_bytes(f.read())
    with open(conv.__file__, "rb") as f:
        conversation_sha = sha256_bytes(f.read())
    header = {
        "rule": "historical/1",
        "function": "polismath.conversation.conversation.priority_metric",
        "source_commit": args.commit,
        "priority_metric_source_sha256": sha256_bytes(inspect.getsource(fn).encode()),
        "conversation_py_sha256": conversation_sha,
        "conversation_py_path": os.path.relpath(conv.__file__, os.path.abspath(args.delphi)),
        "image": args.image,
        "python": sys.version,
        "numpy": numpy.__version__,
        "platform": platform.platform(),
        "machine": platform.machine(),
        "libc": " ".join(platform.libc_ver()),
        "invocation": list(getattr(sys, "orig_argv", sys.argv)),
        "generator_sha256": generator_sha,
        "case_count": len(cases),
        "grid": {"seen": S_VALUES, "extremity": E_VALUES, "meta": [False, True],
                 "splits": "every split up to 5 seen; above, all agreed, all disagreed, all passed, even"},
    }
    with open(args.out, "w") as f:
        f.write('{"header": ' + json.dumps(header, allow_nan=False) + ',\n"cases": [\n')
        f.write(",\n".join(json.dumps(c, allow_nan=False) for c in cases))
        f.write("\n]}\n")
    print(f"wrote {len(cases)} cases to {args.out}")


if __name__ == "__main__":
    main()
