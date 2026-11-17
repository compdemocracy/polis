"""The Delphi shadow's CPU priority load test: the work it times, run inside
the containers cpu_priority.sh starts from docker-compose.yml's own services
(their CPU weight, CPU cap, memory ceiling and thread settings unchanged).

  math --runs N        N cold recomputes of a public conversation by the math
                       engine's own code: the votes loaded, then PCA, k-means,
                       representative comments and comment priorities
                       (Conversation.update_votes, recompute), and the
                       math_main blob encoded as the writer encodes it. One
                       JSON line per run: wall seconds, CPU seconds and the
                       seconds its threads waited for a CPU (schedstat).
  embed [--seconds S]  the shadow's embedding step (the model the service
                       names, read from the image offline) over every public
                       comment, pass after pass, until stopped or for S
                       seconds. One JSON line per pass. With --threads N every
                       thread library is set to N (the two-CPU reference);
                       otherwise the thread settings are the ones the shadow's
                       entry point gives its children (`polis-delphi-shadow
                       threads`), none when the image's entry point has none.
  report OUT ...       on the host, standard library only: summary.json and
                       the verdict from the lines the harness kept in OUT.

math and embed first print a "facts" line: the container's CPUs, cgroup CPU
weight and quota, memory ceiling and OOM adjustment, as the kernel reports
them.

Public fixtures only (delphi/real_data, mounted at /app/real_data). The votes
are the public export's, agree = +1, converted to the engine's (semantic) votes
through the vote convention module, and checked against the export's own agree
and disagree counts before anything is timed.
"""

from __future__ import annotations

import argparse
import csv
import glob
import json
import os
import re
import subprocess
import sys
import time
from math import ceil as math_ceil

REAL_DATA = "/app/real_data"
MATH_CONVERSATION = "r4tykwac8thvzv35jrn53-biodiversity"
THREAD_VARS = ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS", "NUMBA_NUM_THREADS")


def emit(event, **fields):
    print(json.dumps(dict(fields, event=event), sort_keys=True), flush=True)


def _read(path):
    try:
        with open(path) as f:
            return f.read().strip()
    except OSError:
        return None


def facts():
    """What the kernel says this container may use."""
    return {
        "cpus_online": os.cpu_count(),
        "cpus_affinity": len(os.sched_getaffinity(0)),
        "cpu_max": _read("/sys/fs/cgroup/cpu.max"),
        "cpu_weight": _read("/sys/fs/cgroup/cpu.weight"),
        "memory_max": _read("/sys/fs/cgroup/memory.max"),
        "oom_score_adj": _read("/proc/self/oom_score_adj"),
        "thread_env": {k: os.environ.get(k) for k in THREAD_VARS},
    }


def _schedstat():
    """CPU and run-queue wait nanoseconds summed over this process's threads."""
    cpu = wait = 0
    for path in glob.glob("/proc/self/task/*/schedstat"):
        parts = (_read(path) or "0 0").split()
        cpu += int(parts[0])
        wait += int(parts[1])
    return cpu, wait


# ---------------------------------------------------------------- math


def _public_votes():
    """The biodiversity export's votes as the engine takes them, self-checked."""
    from polismath.utils.vote_convention import EXPORT_AGREE_VALUE, SEMANTIC_AGREE, SEMANTIC_DISAGREE, semantic_vote

    folder = os.path.join(REAL_DATA, MATH_CONVERSATION)
    (votes_csv,) = glob.glob(os.path.join(folder, "*-votes.csv"))
    (comments_csv,) = glob.glob(os.path.join(folder, "*-comments.csv"))
    votes = []
    with open(votes_csv) as f:
        for row in csv.DictReader(f):
            votes.append({
                "pid": int(row["voter-id"]),
                "tid": int(row["comment-id"]),
                # The export's convention, declared: agree = EXPORT_AGREE_VALUE.
                "vote": semantic_vote(int(row["vote"]), EXPORT_AGREE_VALUE),
                "created": int(row["timestamp"]) * 1000,
            })
    votes.sort(key=lambda v: v["created"])
    # The self-check: the last vote of each participant on each comment,
    # counted by meaning, against the export's own per-comment counts. A
    # flipped sign would swap the two (19,285 agrees against 5,488 disagrees).
    last = {(v["pid"], v["tid"]): v["vote"] for v in votes}
    agree = sum(1 for v in last.values() if v == SEMANTIC_AGREE)
    disagree = sum(1 for v in last.values() if v == SEMANTIC_DISAGREE)
    with open(comments_csv) as f:
        rows = list(csv.DictReader(f))
    export_agree = sum(int(r["agrees"]) for r in rows)
    export_disagree = sum(int(r["disagrees"]) for r in rows)
    for name, ours, theirs in (("agree", agree, export_agree), ("disagree", disagree, export_disagree)):
        if abs(ours - theirs) > 0.02 * theirs:
            sys.exit(f"vote sign self-check failed: {name} {ours} against the export's {theirs}")
    return votes, {"votes": len(votes), "agree": agree, "export_agree": export_agree,
                   "disagree": disagree, "export_disagree": export_disagree}


def run_math(runs):
    from polismath.conversation import Conversation
    from polismath.database.postgres import encode_math_blob

    votes, check = _public_votes()
    emit("facts", role="math", conversation=MATH_CONVERSATION, sign_check=check, **facts())
    batch = {"votes": votes, "lastVoteTimestamp": votes[-1]["created"]}
    for i in range(runs):
        cpu0, wait0 = _schedstat()
        p0, w0 = time.process_time(), time.perf_counter()
        conv = Conversation(9201).update_votes(batch, recompute=False).recompute()
        blob = encode_math_blob(conv.to_dict())
        wall = time.perf_counter() - w0
        cpu = time.process_time() - p0
        cpu1, wait1 = _schedstat()
        emit("recompute", run=i, wall_s=round(wall, 4), cpu_s=round(cpu, 4),
             runqueue_wait_s=round((wait1 - wait0) / 1e9, 4), oncpu_s=round((cpu1 - cpu0) / 1e9, 4),
             blob_bytes=len(blob), groups=len(conv.group_clusters or []))


# ---------------------------------------------------------------- embed


def _entry_point_threads():
    """The settings the shadow's entry point adds for its children, applied
    before any thread library loads; none when the image's entry point has
    no `threads` command (it then sets none: it predates them)."""
    try:
        p = subprocess.run(["polis-delphi-shadow", "threads"], capture_output=True, text=True, timeout=30)
    except OSError as e:
        return {"source": f"unavailable: {e}"}
    if p.returncode != 0:
        return {"source": "none (the image's entry point sets no thread counts)"}
    applied = {}
    for line in p.stdout.splitlines():
        key, _, value = line.partition("=")
        if key not in THREAD_VARS or not re.fullmatch(r"[1-9][0-9]*", value):
            sys.exit(f"unexpected line from polis-delphi-shadow threads: {line!r}")
        os.environ[key] = value
        applied[key] = value
    return {"source": "polis-delphi-shadow threads", "set": applied}


def run_embed(seconds, threads):
    if threads:
        for key in THREAD_VARS:
            os.environ[key] = str(threads)
        setting = {"source": f"--threads {threads}"}
    else:
        setting = _entry_point_threads()
    import numba
    import torch
    from sentence_transformers import SentenceTransformer
    from threadpoolctl import threadpool_info

    texts = []
    for path in sorted(glob.glob(os.path.join(REAL_DATA, "*", "*-comments.csv"))):
        with open(path) as f:
            texts += [r["comment-body"] for r in csv.DictReader(f) if r["comment-body"].strip()]
    model_dir = os.environ.get("DELPHI_EMBED_MODEL_PATH") or os.environ.get("SENTENCE_TRANSFORMER_MODEL")
    model = SentenceTransformer(model_dir, local_files_only=True)
    emit("facts", role="embed", model=os.environ.get("SENTENCE_TRANSFORMER_MODEL"), comments=len(texts),
         thread_setting=setting, torch_threads=torch.get_num_threads(),
         numba_threads=numba.config.NUMBA_NUM_THREADS,
         blas_threads={p.get("internal_api"): p.get("num_threads") for p in threadpool_info()},
         **facts())
    start = time.monotonic()
    i = 0
    while not seconds or time.monotonic() - start < seconds:
        t0 = time.monotonic()
        model.encode(texts, show_progress_bar=False)
        emit("pass", i=i, seconds=round(time.monotonic() - t0, 4), comments=len(texts))
        i += 1


# ---------------------------------------------------------------- report


def _lines(path):
    if not os.path.exists(path):
        return []
    with open(path) as f:
        return [json.loads(line) for line in f if line.startswith("{")]


def _median(xs):
    xs = sorted(xs)
    n = len(xs)
    if not n:
        return None
    return xs[n // 2] if n % 2 else (xs[n // 2 - 1] + xs[n // 2]) / 2


def _quantile(xs, q):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(q * len(xs)))] if xs else None


def _throughput(passes):
    """Comments a second over every pass but the first (its warm-up)."""
    timed = passes[1:]
    seconds = sum(p["seconds"] for p in timed)
    return (sum(p["comments"] for p in timed) / seconds if seconds else None), len(timed)


def report(out, tolerance, band, min_scale, host_cpus):
    """summary.json from the lines the harness kept; exit 1 unless both hold."""
    recomputes = [r for r in _lines(os.path.join(out, "math.jsonl")) if r.get("event") == "recompute"]
    timed = [r for r in recomputes if r["run"] > 0]  # each container's first run is its warm-up

    def side(state):
        rows = [r for r in timed if r["state"] == state]
        wall = [r["wall_s"] for r in rows]
        return {"count": len(rows), "blocks": len({r["block"] for r in rows}),
                "median_wall_s": _median(wall), "p90_wall_s": _quantile(wall, 0.9),
                "min_wall_s": min(wall) if wall else None, "max_wall_s": max(wall) if wall else None,
                "median_cpu_s": _median([r["cpu_s"] for r in rows]),
                "median_runqueue_wait_s": _median([r["runqueue_wait_s"] for r in rows]),
                "max_runqueue_wait_s": max((r["runqueue_wait_s"] for r in rows), default=None)}

    math = {state: side(state) for state in ("absent", "stopped", "running")}
    blocks = sorted({r["block"] for r in timed if r["state"] in ("stopped", "running")})
    paired = []
    for b in blocks:
        s = _median([r["wall_s"] for r in timed if r["block"] == b and r["state"] == "stopped"])
        g = _median([r["wall_s"] for r in timed if r["block"] == b and r["state"] == "running"])
        if s and g:
            paired.append(round(g / s, 4))
    stopped, running = math["stopped"]["median_wall_s"], math["running"]["median_wall_s"]
    ratio = running / stopped if stopped and running else None
    reference, ref_n = _throughput([p for p in _lines(os.path.join(out, "reference.jsonl")) if p.get("event") == "pass"])
    window = [p for p in _lines(os.path.join(out, "window.jsonl")) if p.get("event") == "pass"]
    shadow, shadow_n = _throughput([{"seconds": 0, "comments": 0}] + window)  # every window pass counts
    scale = shadow / reference if shadow and reference else None
    control, control_n = _throughput([p for p in _lines(os.path.join(out, "control.jsonl")) if p.get("event") == "pass"])
    facts_lines = _lines(os.path.join(out, "shadow-facts.json"))
    facts = facts_lines[-1] if facts_lines else {}
    # The mode is the fence the service really has, read in its own cgroup.
    quota = (facts.get("cpu_max") or "max").split()
    fence = math_ceil(int(quota[0]) / int(quota[1])) if quota[0] != "max" else None
    env = facts.get("thread_env") or {}
    if fence:
        # Fenced (the default, 2 CPUs, or any DELPHI_SHADOW_CONTAINER_CPUS):
        # one library thread per CPU of the fence, and
        # the throughput of the same work on the same fence with that many
        # threads (the reference), within the band; the old configuration
        # (the libraries counting the whole box inside the fence) is the
        # control and must fall outside it, or the check could not tell.
        threads_ok = (facts.get("torch_threads") == fence and
                      all(env.get(k) == str(fence) for k in THREAD_VARS))
        embed_ok = bool(scale and scale >= 1 - band)
        control_ok = bool(control and reference and control / reference < 1 - band)
    else:
        # Unfenced (DELPHI_SHADOW_CONTAINER_CPUS=0): no thread count set, and
        # throughput at least min_scale times two threads on two CPUs.
        threads_ok = all(env.get(k) in (None, "") for k in THREAD_VARS)
        embed_ok = bool(scale and scale >= min_scale)
        control_ok = True
    summary = {
        "host_cpus": host_cpus,
        "mode": f"fenced at {fence} CPUs" if fence else "unfenced",
        "math_recompute": math,
        "math_ratio_running_to_stopped": round(ratio, 4) if ratio else None,
        "math_slowdown_pct": round((ratio - 1) * 100, 1) if ratio else None,
        "math_paired_block_ratios": paired,
        "math_tolerance": tolerance,
        "math_holds": bool(ratio and ratio <= 1 + tolerance),
        "cpu_weight": facts.get("cpu_weight"),
        "weight_holds": facts.get("cpu_weight") == "1",
        "threads": {"torch": facts.get("torch_threads"), **env},
        "threads_hold": threads_ok,
        "embed_reference_comments_per_s": round(reference, 2) if reference else None,
        "embed_reference_cpus": fence or 2,
        "embed_reference_passes": ref_n,
        "embed_control_oversubscribed_comments_per_s": round(control, 2) if control else None,
        "embed_control_passes": control_n,
        "embed_shadow_comments_per_s": round(shadow, 2) if shadow else None,
        "embed_shadow_passes": shadow_n,
        "embed_ratio_to_reference": round(scale, 3) if scale else None,
        "embed_band": band,
        "embed_min_scale": min_scale,
        "embed_holds": embed_ok,
        "control_detected": control_ok,
        "shadow_facts": facts,
    }
    summary["passed"] = all(summary[k] for k in ("math_holds", "weight_holds", "threads_hold", "embed_holds", "control_detected"))
    with open(os.path.join(out, "summary.json"), "w") as f:
        json.dump(summary, f, indent=1, sort_keys=True)
    print(json.dumps({k: summary[k] for k in (
        "passed", "mode", "math_holds", "math_slowdown_pct", "math_tolerance", "weight_holds", "threads_hold",
        "embed_holds", "embed_ratio_to_reference", "embed_shadow_comments_per_s",
        "embed_reference_comments_per_s", "control_detected",
        "embed_control_oversubscribed_comments_per_s")}, sort_keys=True))
    for state in ("absent", "stopped", "running"):
        m = math[state]
        print(f"math {state}: {m['count']} recomputes in {m['blocks']} blocks, median {m['median_wall_s']} s, "
              f"p90 {m['p90_wall_s']} s, median wait for a CPU {m['median_runqueue_wait_s']} s")
    return 0 if summary["passed"] else 1


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="mode", required=True)
    m = sub.add_parser("math")
    m.add_argument("--runs", type=int, default=6)
    e = sub.add_parser("embed")
    e.add_argument("--seconds", type=float, default=0.0)
    e.add_argument("--threads", type=int, default=0)
    r = sub.add_parser("report")
    r.add_argument("out")
    r.add_argument("--tolerance", type=float, required=True)
    r.add_argument("--band", type=float, required=True)
    r.add_argument("--min-scale", type=float, required=True)
    r.add_argument("--host-cpus", type=int, required=True)
    args = parser.parse_args(argv)
    if args.mode == "math":
        run_math(args.runs)
    elif args.mode == "embed":
        run_embed(args.seconds, args.threads)
    else:
        sys.exit(report(args.out, args.tolerance, args.band, args.min_scale, args.host_cpus))


if __name__ == "__main__":
    main()
