"""Record historical/1's replays: two public conversations, tick by tick,
through the real Python math engine, with every input its priority formula
was fed and every priority it returned.

Run once, in the delphi image built from the commit named by --commit, with
the image's own delphi source (the directory that holds polismath) and the
repository's public vote exports:

  python -I make_fixture.py --delphi /app --data <delphi/real_data> \
      --commit <sha> --image <image id> --out-dir .

It writes vw.json, biodiversity.json and constructed.json. The fixtures it
writes are never edited: a changed Python formula is a new rule version with
its own fixture.

The vote sign. The public exports write agree as EXPORT_AGREE_VALUE (+1) and
disagree as its flip; the engine's update_votes takes semantic votes (agree
+1). Every vote this script feeds the engine goes through the convention
module (semantic_vote with the export's agree value declared), every sign
comparison is against the module's constants, and two checks prove the
reading:
  1. raw rows against the comments export: for every comment, the rows whose
     vote is the export's agree (disagree) value number exactly the export's
     `agrees` (`disagrees`); this proves the export's sign is read as the
     export declares it;
  2. the latest vote against the engine: an independent fold (each
     participant's last vote on each comment, in (timestamp, file order))
     gives, at every prefix, exactly the agreed, disagreed and passed counts
     of the engine's own loaded vote matrix; this proves the loader neither
     flipped nor dropped a vote.
Raw counts are never compared with latest-vote counts: re-votes make them
different populations.

The recorder does not change the engine. It replaces the module attribute
priority_metric, which the engine's loop looks up at each call, with a
wrapper that calls the original and records its arguments and result.
"""

import argparse
import csv
import hashlib
import inspect
import json
import math
import os
import platform
import sys

# The only inputs this script accepts: the repository's tracked public
# exports and math blobs, each by its SHA-256.
CONVERSATIONS = {
    "vw": {
        "dir": "r6vbnhffkxbd7ifmfbdrd-vw",
        "votes": ("2025-11-11-1704-r6vbnhffkxbd7ifmfbdrd-votes.csv",
                  "622b8c164150dc509f7387d81d2e2d616d37211c3bb256458064972ad805b56a"),
        "comments": ("2025-11-11-1704-r6vbnhffkxbd7ifmfbdrd-comments.csv",
                     "ffaed9db95e7c9c28cb8595cef9845a262b80c0c787f2a2492ba41c28cf683d2"),
        "blob": ("r6vbnhffkxbd7ifmfbdrd_math_blob.json",
                 "f55036f12628164af2e48ab3c13bc6e4ad7b4f90920c3c54334502c454b0a5e6"),
    },
    "biodiversity": {
        "dir": "r4tykwac8thvzv35jrn53-biodiversity",
        "votes": ("2025-11-11-1704-r4tykwac8thvzv35jrn53-votes.csv",
                  "9b6c1847bcd2e93c2cc349e79676f8be3ffe49a7e5f79f0d2e19412f0be29f94"),
        "comments": ("2025-11-11-1704-r4tykwac8thvzv35jrn53-comments.csv",
                     "b8f7b9a9821f64d6a33262289ec7268b33ed6f2c2196aa8d94c3ebad27c853b4"),
        "blob": ("r4tykwac8thvzv35jrn53_math_blob.json",
                 "cf935a36deb19697b6af094ed8c82068c6e52918c008ea849aa10098b0386f1f"),
    },
}
PREFIXES = 10

PROVES = (
    "Given exactly the counts and extremities that the Python engine fed its "
    "priority formula while replaying this public conversation at ten prefixes, "
    "the crate's historical/1 must return the same numbers; this does not prove "
    "that any production caller feeds the crate correctly signed or correctly "
    "lagged counts, nor that these ticks are the ticks production ran."
)


class Refused(Exception):
    pass


def check(cond, why):
    if not cond:
        raise Refused(why)


def sha256_file(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def pinned(data_dir, conv, key):
    name, digest = CONVERSATIONS[conv][key]
    path = os.path.join(data_dir, CONVERSATIONS[conv]["dir"], name)
    check(os.path.isfile(path) and not os.path.islink(path), f"{path}: not a plain file")
    got = sha256_file(path)
    check(got == digest, f"{path}: SHA-256 {got}, pinned {digest}")
    return path


class Recorder:
    """Wraps priority_metric; records each call in order."""

    def __init__(self, original):
        self.original = original
        self.calls = []

    def __call__(self, is_meta, A, P, S, E):
        result = self.original(is_meta, A, P, S, E)
        self.calls.append((is_meta, A, P, S, E, result))
        return result


def column_counts(mat, conv_mod):
    """Agreed, disagreed and passed per column of the engine's vote matrix,
    read through the convention constants."""
    vc = conv_mod
    out = {}
    for tid in mat.columns:
        col = mat[tid]
        out[int(tid)] = (int((col == vc.SEMANTIC_AGREE).sum()),
                         int((col == vc.SEMANTIC_DISAGREE).sum()),
                         int((col == vc.SEMANTIC_PASS).sum()))
    return out


def fold_latest(rows, vc, agree_value):
    """Each participant's last vote on each comment, rows already in
    (timestamp, file order); counts per comment by the export's values."""
    latest = {}
    for _, _, pid, tid, raw in rows:
        latest[(pid, tid)] = raw
    disagree_value = vc.flipped(agree_value)
    counts = {}
    for (_, tid), raw in latest.items():
        a, d, p = counts.get(tid, (0, 0, 0))
        if raw == agree_value:
            a += 1
        elif raw == disagree_value:
            d += 1
        elif raw == vc.SEMANTIC_PASS:
            p += 1
        else:
            raise Refused(f"comment {tid}: a vote value outside the export's three")
        counts[tid] = (a, d, p)
    return counts


def summed_previous(group_votes, tid):
    a = d = s = 0
    for gv in (group_votes or {}).values():
        v = gv.get("votes", {}).get(tid, {"A": 0, "D": 0, "S": 0})
        a += v.get("A", 0)
        d += v.get("D", 0)
        s += v.get("S", 0)
    return int(a), int(d), int(s)


def run_ticks(cm, vc, batches, meta_tids, moderation=None):
    """Feeds each batch through the engine's update_votes and recompute,
    recording every priority call. Returns the tick records and the final
    conversation."""
    original = cm.priority_metric
    conv = cm.Conversation("public-fixture", last_updated=1)
    conv = conv.update_moderation({"meta_tids": sorted(meta_tids)}, recompute=False)
    check(set(conv.meta_tids) == set(meta_tids), "meta comments not loaded as given")
    ticks = []
    rec = Recorder(original)
    cm.priority_metric = rec
    try:
        for k, batch in enumerate(batches, start=1):
            previous = getattr(conv, "group_votes", {}) or {}
            rec.calls = []
            moderate = bool(moderation and k in moderation)
            conv = conv.update_votes({"votes": batch["votes"],
                                      "lastVoteTimestamp": batch["last_ms"]},
                                     recompute=not moderate)
            if moderate:
                # The votes and the moderation change land in one tick.
                conv = conv.update_moderation(moderation[k], recompute=True)
            ticks.append(record_tick(cm, conv, previous, rec.calls, k, batch))
    finally:
        cm.priority_metric = original
    return ticks, conv


def record_tick(cm, conv, previous, calls, k, batch):
    columns = list(conv.rating_mat.columns) if conv.rating_mat is not None else []
    priorities = dict(getattr(conv, "comment_priorities", {}) or {})
    tick = {"tick": k, "rows": batch.get("rows"), "columns": len(columns),
            "previous_groups": len(previous),
            "current_groups": len(getattr(conv, "group_votes", {}) or {}),
            "calls": len(calls), "cells": []}
    if not calls:
        # A tick with no priority calls: its priority map must be empty.
        check(priorities == {}, f"tick {k}: no calls, but a priority map")
        tick["no_priority_calls"] = True
        return tick
    # One call per column, in the column order of the engine's loop.
    check(len(calls) == len(columns), f"tick {k}: {len(calls)} calls for {len(columns)} columns")
    check(len(priorities) == len(columns), f"tick {k}: priority map size")
    data = conv.to_dict()
    pca = data.get("pca") or {}
    stored_e = dict(zip([int(t) for t in data["tids"]], pca["comment-extremity"]))
    types = set()
    for tid, (is_meta, A, P, S, E, out) in zip(columns, calls):
        tid = int(tid)
        a, d, s = summed_previous(previous, tid)
        check((int(A), int(S), int(P)) == (a, s, s - a - d), f"tick {k} comment {tid}: counts")
        check(bool(is_meta) == (tid in conv.meta_tids), f"tick {k} comment {tid}: meta")
        check(float(E) == float(stored_e[tid]), f"tick {k} comment {tid}: extremity not the stored one")
        check(float(out) == priorities[tid], f"tick {k} comment {tid}: output not the stored priority")
        check(math.isfinite(float(out)), f"tick {k} comment {tid}: non-finite")
        types.add((type(A).__name__, type(P).__name__, type(S).__name__, type(E).__name__))
        tick["cells"].append({"tid": tid, "agreed": int(A), "disagreed": int(S) - int(A) - int(P),
                              "passed": int(P), "seen": int(S), "extremity": float(E),
                              "meta": bool(is_meta), "weight": float(out)})
    tick["argument_types"] = sorted(list(t) for t in types)
    return tick


def wrong_on_purpose(cm, conv, tick):
    """The extremity recomputed from the SERVED centre without restore_axis,
    for one non-meta comment with |c| well away from 0, and proof that the
    recorder's own extremity check rejects it."""
    import numpy as np
    from polismath.utils import vote_convention as vc
    data = conv.to_dict()
    stored = dict(zip([int(t) for t in data["tids"]], data["pca"]["comment-extremity"]))
    # The centre as the wire carries it (emit_axis), used without restore_axis,
    # in the engine's own column order.
    tids = [int(t) for t in conv.rating_mat.columns]
    served_center = np.asarray(vc.emit_axis(np.asarray(conv.pca["center"], dtype=float)), dtype=float)
    comps = np.asarray(conv.pca["comps"], dtype=float)
    wrong = cm.compute_comment_extremity(cm.pca_project_cmnts(served_center, comps))
    cells = {c["tid"]: c for c in tick["cells"]}
    best = None
    for i, tid in enumerate(tids):
        c = abs(served_center[i])
        cell = cells.get(tid)
        # Well away from 0 and from the unanimous ends, with a non-zero
        # loading (a zero loading gives E = 0 from either centre).
        if cell is None or cell["meta"] or not 0.2 <= c <= 0.9 or not float(stored[tid]) > 1e-6:
            continue
        if best is None or c > best[1]:
            best = (tid, c, float(wrong[i]))
    check(best is not None, "no comment for the wrong-on-purpose witness")
    tid, c, e_wrong = best
    check(e_wrong != float(stored[tid]), "the served-centre extremity equals the stored one")
    cell = dict(cells[tid])
    cell.update({"extremity": e_wrong, "wrong_on_purpose": True, "served_center": float(served_center[tid_index(tids, tid)])})
    rejected = float(e_wrong) != float(stored[tid])
    return {"tick": tick["tick"], "cell": cell, "recorder_extremity_check_rejects_it": rejected}


def tid_index(tids, tid):
    return tids.index(tid)


def replay(cm, vc, data_dir, name):
    votes_path = pinned(data_dir, name, "votes")
    comments_path = pinned(data_dir, name, "comments")
    blob_path = pinned(data_dir, name, "blob")
    with open(blob_path) as f:
        meta_tids = [int(t) for t in json.load(f).get("meta-tids", [])]
    agree_value = vc.EXPORT_AGREE_VALUE
    disagree_value = vc.flipped(agree_value)
    rows = []
    with open(votes_path, newline="") as f:
        for ordinal, r in enumerate(csv.DictReader(f)):
            rows.append((int(r["timestamp"]), ordinal, int(r["voter-id"]),
                         int(r["comment-id"]), int(r["vote"])))
    rows.sort(key=lambda r: (r[0], r[1]))
    # Sign check 1: raw rows against the comments export, every comment.
    raw = {}
    for _, _, _, tid, v in rows:
        a, d = raw.get(tid, (0, 0))
        raw[tid] = (a + (v == agree_value), d + (v == disagree_value))
    exported = {}
    with open(comments_path, newline="") as f:
        for r in csv.DictReader(f):
            exported[int(r["comment-id"])] = (int(r["agrees"]), int(r["disagrees"]))
    check(set(raw) <= set(exported), "a voted comment missing from the comments export")
    mismatched = [t for t in exported if raw.get(t, (0, 0)) != exported[t]]
    check(not mismatched, f"sign check 1 failed for comments {mismatched[:5]}")
    n = len(rows)
    bounds = [k * n // PREFIXES for k in range(PREFIXES + 1)]
    batches = []
    for k in range(1, PREFIXES + 1):
        part = rows[bounds[k - 1]:bounds[k]]
        batches.append({
            "rows": bounds[k],
            "last_ms": part[-1][0] * 1000,
            "votes": [{"pid": pid, "tid": tid, "created": t * 1000,
                       "vote": vc.semantic_vote(v, storage_agree_value=agree_value)}
                      for t, _, pid, tid, v in part],
        })
    # Sign check 2 needs the matrix at every prefix: run tick by tick and
    # compare the fold of each prefix with the engine's loaded matrix.
    original = cm.priority_metric
    conv = cm.Conversation("public-fixture", last_updated=1)
    conv = conv.update_moderation({"meta_tids": sorted(meta_tids)}, recompute=False)
    rec = Recorder(original)
    ticks = []
    check2 = []
    cm.priority_metric = rec
    try:
        for k, batch in enumerate(batches, start=1):
            previous = getattr(conv, "group_votes", {}) or {}
            rec.calls = []
            conv = conv.update_votes({"votes": batch["votes"], "lastVoteTimestamp": batch["last_ms"]},
                                     recompute=True)
            fold = fold_latest(rows[:bounds[k]], vc, agree_value)
            engine = column_counts(conv.raw_rating_mat, vc)
            check(fold == {t: c for t, c in engine.items() if c != (0, 0, 0)} and set(fold) == set(engine),
                  f"sign check 2 failed at prefix {k}")
            # The same check must reject a fold read with the flipped sign.
            flipped_fold = fold_latest(rows[:bounds[k]], vc, disagree_value)
            check(flipped_fold != fold or all(a == d for a, d, _ in fold.values()),
                  f"prefix {k}: a flipped fold is not told apart")
            check2.append({"prefix": k, "rows": bounds[k], "comments": len(fold),
                           "agreed": sum(c[0] for c in fold.values()),
                           "disagreed": sum(c[1] for c in fold.values()),
                           "passed": sum(c[2] for c in fold.values()),
                           "flipped_fold_rejected": flipped_fold != engine})
            ticks.append(record_tick(cm, conv, previous, rec.calls, k, batch))
    finally:
        cm.priority_metric = original
    witness = wrong_on_purpose(cm, conv, ticks[-1])
    latest_pairs = len({(r[2], r[3]) for r in rows})
    return {
        "conversation": name,
        "inputs": {k: {"file": CONVERSATIONS[name][k][0], "sha256": CONVERSATIONS[name][k][1]}
                   for k in ("votes", "comments", "blob")},
        "source_convention": {"agree": agree_value, "disagree": disagree_value,
                              "pass": vc.SEMANTIC_PASS, "declared_by": "EXPORT_AGREE_VALUE"},
        "meta_tids": sorted(meta_tids), "meta_source": "the math blob's meta-tids",
        "moderation": "none applied (the replay feeds votes only)",
        "raw_rows": n, "participant_comment_pairs": latest_pairs,
        "prefix_rule": "prefix k is the first floor(k*n/10) rows in (timestamp, file order)",
        "sign_check_1": {"compared": "raw rows with the export's agree and disagree values, against the comments export's agrees and disagrees",
                         "comments": len(exported), "equal": len(exported)},
        "sign_check_2": {"compared": "each participant's latest vote per comment, folded here, against the engine's loaded vote matrix, at every prefix",
                         "prefixes": check2},
        "ticks": ticks,
        "wrong_on_purpose": witness,
    }


def constructed(cm, vc):
    """Small constructed conversations for what the replays may lack."""
    agree = vc.semantic_vote(vc.EXPORT_AGREE_VALUE, storage_agree_value=vc.EXPORT_AGREE_VALUE)
    disagree = vc.flipped(agree)
    pas = vc.SEMANTIC_PASS

    def votes(triples, t):
        return {"votes": [{"pid": p, "tid": c, "vote": v, "created": t} for p, c, v in triples],
                "last_ms": t}

    cases = []
    # One comment only: the first tick, and fewer than two component rows.
    one = [votes([(p, 0, agree if p % 3 else disagree) for p in range(8)], 1000)]
    # Then new comments arrive (scored at zero previous counts), then a
    # change of groups between ticks.
    many = one + [
        votes([(p, c, [agree, disagree, pas][(p * 7 + c) % 3]) for p in range(12) for c in range(1, 6)], 2000),
        votes([(p, c, agree if p < 10 else disagree) for p in range(12, 30) for c in range(0, 6)], 3000),
        votes([(p, 6, agree) for p in range(30)], 4000),
    ]
    ticks, _ = run_ticks(cm, vc, many, meta_tids=[5])
    cases.append({"name": "first tick, one comment, new comments, groups change", "ticks": ticks})
    # A moderation change between ticks: comment 2 moderated out at tick 3.
    ticks, _ = run_ticks(cm, vc, many[:3], meta_tids=[], moderation={3: {"mod_out_tids": [2]}})
    cases.append({"name": "moderation change at tick 3", "ticks": ticks})
    # Too few participants for a PCA: the tick may make no priority calls.
    ticks, _ = run_ticks(cm, vc, [votes([(0, 0, agree)], 1000)], meta_tids=[])
    cases.append({"name": "one vote", "ticks": ticks})
    return cases


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--delphi", required=True, help="the directory that holds polismath")
    ap.add_argument("--data", required=True, help="the repository's delphi/real_data")
    ap.add_argument("--commit", required=True)
    ap.add_argument("--image", required=True)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--only", choices=sorted(CONVERSATIONS) + ["constructed"])
    args = ap.parse_args()
    for refused in ("POLIS_REAL_DATA", "REAL_DATA_DIR"):
        check(refused not in os.environ, f"{refused} is set; this script takes only --data")

    sys.path.insert(0, os.path.abspath(args.delphi))
    import numpy
    from polismath.conversation import conversation as cm
    from polismath.utils import vote_convention as vc

    with open(__file__, "rb") as f:
        generator_sha = hashlib.sha256(f.read()).hexdigest()
    header = {
        "rule": "historical/1",
        "function": "polismath.conversation.conversation.priority_metric",
        "proves": PROVES,
        "source_commit": args.commit,
        "priority_metric_source_sha256": hashlib.sha256(inspect.getsource(cm.priority_metric).encode()).hexdigest(),
        "conversation_py_sha256": sha256_file(cm.__file__),
        "image": args.image,
        "python": sys.version,
        "numpy": numpy.__version__,
        "platform": platform.platform(),
        "machine": platform.machine(),
        "libc": " ".join(platform.libc_ver()),
        "engine_environment": {k: v for k, v in sorted(os.environ.items())
                               if k.startswith(("POLIS", "MATH", "DELPHI", "PYTHONHASHSEED"))},
        "invocation": list(getattr(sys, "orig_argv", sys.argv)),
        "generator_sha256": generator_sha,
    }
    names = [args.only] if args.only else sorted(CONVERSATIONS) + ["constructed"]
    for name in names:
        body = {"cases": constructed(cm, vc)} if name == "constructed" else replay(cm, vc, args.data, name)
        out = os.path.join(args.out_dir, f"{name}.json")
        with open(out, "w") as f:
            json.dump({"header": header, **body}, f, allow_nan=False, separators=(",", ":"))
            f.write("\n")
        ticks = body["ticks"] if "ticks" in body else [t for c in body["cases"] for t in c["ticks"]]
        print(f"{name}: {len(ticks)} ticks, {sum(len(t['cells']) for t in ticks)} cells -> {out}")


if __name__ == "__main__":
    main()
