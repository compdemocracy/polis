#!/usr/bin/env python3
"""Large-conversation tick benchmark (GOAL_CUTOVER_READY.md Phase 5).

Times ONE full-PCA math tick at the largest prodclone conversation shape
(33,422 participants x 783 comments, ~2.0M votes) — the pre-flip
measurement required by CUTOVER_RUNBOOK.md risk register item 3. The
conversation is SYNTHESIZED (seeded RNG; no real data leaves anywhere),
sized by CLI flags so the same script smoke-tests at small shapes.

Two numbers matter:
- cold_tick_s: first-ever recompute (no warm-start state) — the
  worst case a poller pays when it first meets a huge conv.
- warm_tick_s: recompute after one more small vote batch — the steady
  per-tick cost (lineage warm starts populated), which is what the
  serial-capacity verdict rides on.

Usage::

    uv run python scripts/large_conv_tick_bench.py                 # full shape
    uv run python scripts/large_conv_tick_bench.py --n-ptpts 2000 \
        --n-cmts 200 --n-votes 120000                              # smoke
    ... --json-out result.json                                     # machine copy
"""

from __future__ import annotations

import json
import platform
import time

import click
import numpy as np

from polismath.conversation.conversation import Conversation

# Largest prodclone conv (CUTOVER_RUNBOOK.md risk item 3 / journal s6).
DEFAULT_N_PTPTS = 33_422
DEFAULT_N_CMTS = 783
DEFAULT_N_VOTES = 2_000_000


def synthesize_votes(n_ptpts: int, n_cmts: int, n_votes: int,
                     seed: int = 42) -> list[dict]:
    """Deterministic public fixture vote stream shaped like a real large conv.

    Every participant votes on ``round(n_votes / n_ptpts)`` distinct random
    comments (so the per-row density matches the target total), with a
    realistic agree-heavy sign mix (55% agree / 30% disagree / 15% pass).
    ``created`` timestamps advance one ms per vote — deterministic ordering.
    """
    rng = np.random.default_rng(seed)
    per_ptpt = max(1, round(n_votes / n_ptpts))
    votes: list[dict] = []
    t_ms = 1_600_000_000_000
    for pid in range(n_ptpts):
        tids = rng.choice(n_cmts, size=min(per_ptpt, n_cmts), replace=False)
        signs = rng.choice([1.0, -1.0, 0.0], size=len(tids), p=[0.55, 0.30, 0.15])
        for tid, sign in zip(tids, signs):
            t_ms += 1
            votes.append({"pid": pid, "tid": int(tid), "vote": float(sign),
                          "created": t_ms})
    return votes


def run_bench(n_ptpts: int, n_cmts: int, n_votes: int, seed: int = 42) -> dict:
    votes = synthesize_votes(n_ptpts, n_cmts, n_votes, seed=seed)
    n_total = len(votes)

    conv = Conversation("large-conv-bench", last_updated=1)
    t0 = time.perf_counter()
    conv = conv.update_votes(
        {"votes": votes, "lastVoteTimestamp": votes[-1]["created"]},
        recompute=False)
    ingest_s = time.perf_counter() - t0

    t0 = time.perf_counter()
    conv = conv.recompute()
    cold_tick_s = time.perf_counter() - t0

    # One more tiny batch -> the steady-state warm tick (lineage warm starts
    # for PCA/base/group all populated by the cold tick above).
    tail = [{"pid": 0, "tid": 0, "vote": 1.0,
             "created": votes[-1]["created"] + 1}]
    t0 = time.perf_counter()
    conv = conv.update_votes(
        {"votes": tail, "lastVoteTimestamp": tail[0]["created"]},
        recompute=False)
    conv = conv.recompute()
    warm_tick_s = time.perf_counter() - t0

    return {
        "n_ptpts": n_ptpts,
        "n_cmts": n_cmts,
        "n_votes": n_total,
        "ingest_s": round(ingest_s, 3),
        "cold_tick_s": round(cold_tick_s, 3),
        "warm_tick_s": round(warm_tick_s, 3),
        "n_groups": len(conv.group_clusters),
        "n_base_clusters": len(conv.base_clusters),
        "machine": platform.machine(),
        "platform": platform.platform(),
    }


@click.command()
@click.option("--n-ptpts", default=DEFAULT_N_PTPTS, show_default=True)
@click.option("--n-cmts", default=DEFAULT_N_CMTS, show_default=True)
@click.option("--n-votes", default=DEFAULT_N_VOTES, show_default=True)
@click.option("--seed", default=42, show_default=True)
@click.option("--json-out", type=click.Path(), default=None,
              help="Also write the result JSON to this path.")
def main(n_ptpts: int, n_cmts: int, n_votes: int, seed: int,
         json_out: str | None) -> None:
    """Time one cold + one warm full-PCA tick at a synthesized conv shape."""
    result = run_bench(n_ptpts, n_cmts, n_votes, seed=seed)
    payload = json.dumps(result, indent=2, sort_keys=True)
    click.echo(payload)
    if json_out:
        with open(json_out, "w") as fh:
            fh.write(payload + "\n")


if __name__ == "__main__":
    main()
