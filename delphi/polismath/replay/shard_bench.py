"""Shard-scaling benchmark — does aggregate throughput scale with shard count?

Closes the gap named in ``HANDOFF_PYTHON_SHARDING.md`` §8: the cost study's
``py-zid-shard`` arm launched N independent processes on N separate cells and
"exercises no ``zid % N`` filter at all", so it measured the CEILING sharding
can reach rather than a sharding implementation.  This harness measures the
shipped filter: one fixed workload of ``zid``s is partitioned by the REAL
:func:`polismath.poller.service.should_process_zid`, N processes each take
their slice, and aggregate throughput is compared against the single-shard arm.

Design notes, each of which is load-bearing for the number this produces:

* **Cost-balanced workload.** Every zid replays the SAME dataset, so an even
  count split is an even work split.  ``zid % N`` balances count, not cost
  (handoff §4: median 2 in-conv participants, max 23,354), but that skew is a
  capacity-planning property — mixing it in here would confound the question
  "does the mechanism scale?" with "is this particular zid set balanced?".
* **BLAS pinning.** Unpinned numpy fans a single recompute across every core.
  N such shards on one box thrash.  Every shard therefore pins its BLAS/OpenMP
  threads to 1 (handoff §0); the ``pin=False`` arm exists to MEASURE that
  correction rather than assume it.
* **Startup is excluded.** Interpreter start + numpy import + dataset load is
  ~2 s and does not shard; each child times only its compute phase, and the
  parent releases every child from a barrier so the phases actually overlap.
* **Wall is the slowest shard**, never the sum — shards run concurrently, and
  the arm is done when the last one finishes.

The live benchmark is opt-in (it needs N processes and ~a minute of CPU); this
module's pure decision points are unit-tested with canned numbers.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Sequence

from polismath.poller.service import should_process_zid

# Every knob a BLAS/OpenMP backend might read.  Pinning only OMP_NUM_THREADS
# leaves OpenBLAS free to fan out on its own, which is exactly the pathology
# being controlled for.
BLAS_ENV_VARS = (
    "OMP_NUM_THREADS",
    "OPENBLAS_NUM_THREADS",
    "MKL_NUM_THREADS",
    "VECLIB_MAXIMUM_THREADS",
    "NUMEXPR_NUM_THREADS",
)

# 24 is divisible by every default shard count, so each arm gets an exactly
# even split and no arm is measuring a remainder.
DEFAULT_ZID_COUNT = 24
DEFAULT_SHARD_COUNTS = (1, 2, 4, 8)
DEFAULT_DATASET = "biodiversity"
# Quasi-linear bar. Amdahl leaves headroom for real per-process overhead
# (interpreter start is excluded, but page cache, memory bandwidth and OS
# scheduling are not), so "linear" cannot mean 1.00.
DEFAULT_MIN_EFFICIENCY = 0.8

_DELPHI_ROOT = Path(__file__).resolve().parents[2]
CHILD_TIMEOUT_SEC = 1800.0


# --------------------------------------------------------------------------- #
# Pure helpers
# --------------------------------------------------------------------------- #
def shard_workload(
    zids: Sequence[int], shard_index: int, shard_count: int
) -> list[int]:
    """The zids this shard owns, decided by the PRODUCTION filter.

    Deliberately delegates to :func:`should_process_zid` rather than
    recomputing ``zid % shard_count``: a benchmark that reimplements the thing
    under test can scale beautifully while the shipped code does not.
    """
    return [
        z for z in zids if should_process_zid(z, [], [], shard_index, shard_count)
    ]


def blas_env(base: dict[str, str], *, pin: bool) -> dict[str, str]:
    """Child environment with BLAS threads pinned to 1, or explicitly unpinned.

    ``pin=False`` REMOVES the variables rather than leaving them alone: the
    parent shell may already export them (certify and CI both do), and an
    inherited "1" would silently pin the control arm and erase the very
    difference this arm exists to show.
    """
    env = dict(base)
    for var in BLAS_ENV_VARS:
        if pin:
            env[var] = "1"
        else:
            env.pop(var, None)
    return env


@dataclass(frozen=True)
class ShardResult:
    """One shard process's own report of its compute phase."""

    shard_index: int
    ticks: int
    compute_seconds: float
    # user+sys CPU consumed by this shard during the compute phase.
    cpu_seconds: float = 0.0


@dataclass(frozen=True)
class ArmResult:
    """One (shard_count) arm: all its shards, aggregated."""

    shard_count: int
    ticks: int
    wall_seconds: float
    throughput: float
    cpu_seconds: float = 0.0
    cpu_per_tick: float = 0.0


def summarize_arm(shard_count: int, results: Sequence[ShardResult]) -> ArmResult:
    """Aggregate an arm. Wall = the SLOWEST shard, since they run concurrently.

    ``cpu_per_tick`` is the diagnostic that makes a disappointing speedup
    interpretable: if it stays flat as N grows, each shard is doing the same
    work and the wall-clock ceiling is core availability (a property of the
    BOX). If it climbs, the shards are genuinely interfering (a property of
    the MECHANISM). Without it, a sub-linear number cannot be attributed.
    """
    if not results:
        raise ValueError(f"no shard results for shard_count={shard_count}")
    wall = max(r.compute_seconds for r in results)
    if wall <= 0:
        raise ValueError(
            f"non-positive wall {wall!r} for shard_count={shard_count}: "
            "the compute phase was not measured"
        )
    ticks = sum(r.ticks for r in results)
    cpu = sum(r.cpu_seconds for r in results)
    return ArmResult(
        shard_count=shard_count,
        ticks=ticks,
        wall_seconds=wall,
        throughput=ticks / wall,
        cpu_seconds=cpu,
        cpu_per_tick=cpu / ticks if ticks else 0.0,
    )


def load_warning(
    *, load1: float, cpu_count: int | None, shard_count: int
) -> str | None:
    """Warn when the machine cannot actually give ``shard_count`` shards a core.

    A scaling sweep on a loaded box measures the BOX. This is not hypothetical:
    a sweep taken at load 9.0 on a 10-core laptop reported 3.60x at N=8 while
    CPU per tick stayed flat — the shards were starved, not contending, and
    nothing in the table said so.
    """
    if not cpu_count or shard_count <= 1:
        return None
    free = cpu_count - load1
    if free >= shard_count:
        return None
    return (
        f"WARNING: load average {load1:.1f} on {cpu_count} cores leaves ~{free:.1f} "
        f"free, but the largest arm wants {shard_count}. Wall-clock speedup is a "
        "FLOOR, not the mechanism's ceiling — compare cpu/tick instead, and "
        "re-run on a quiet machine for a real scaling number."
    )


def best_arm(arms: Sequence[ArmResult]) -> ArmResult:
    """The fastest repeat of one arm.

    Timing noise on a shared machine is one-sided: background load can only ADD
    wall time. The minimum is therefore the best estimate of the true cost,
    where a mean would encode whatever else the box happened to be running.
    """
    if not arms:
        raise ValueError("no arms to choose from")
    counts = {a.shard_count for a in arms}
    if len(counts) != 1:
        raise ValueError(f"all repeats must share the same shard_count, got {counts}")
    return max(arms, key=lambda a: a.throughput)


def karp_flatt(speedup: float, shard_count: int) -> float | None:
    """Karp-Flatt experimentally-determined serial fraction.

    ``e = (1/S - 1/N) / (1 - 1/N)``.  Reported because the handoff quotes
    serial fractions (py-threads 0.9884, py-zid-shard 0.0013), so this is the
    directly comparable statistic — and unlike raw speedup it exposes overhead
    that grows with N.  Undefined for a single worker.
    """
    if shard_count <= 1:
        return None
    inv_n = 1.0 / shard_count
    return (1.0 / speedup - inv_n) / (1.0 - inv_n)


def scaling_table(arms: Iterable[ArmResult]) -> list[dict[str, Any]]:
    """Rows of (shard_count, ticks, wall, throughput, speedup, efficiency,
    serial_fraction), speedup measured against the single-shard arm."""
    ordered = sorted(arms, key=lambda a: a.shard_count)
    baseline = next((a for a in ordered if a.shard_count == 1), None)
    if baseline is None:
        raise ValueError(
            "no shard_count=1 baseline arm: speedup is meaningless without it"
        )
    rows: list[dict[str, Any]] = []
    for arm in ordered:
        speedup = arm.throughput / baseline.throughput
        rows.append(
            {
                "shard_count": arm.shard_count,
                "ticks": arm.ticks,
                "wall_seconds": arm.wall_seconds,
                "throughput": arm.throughput,
                "speedup": speedup,
                "efficiency": speedup / arm.shard_count,
                "serial_fraction": karp_flatt(speedup, arm.shard_count),
                "cpu_per_tick": arm.cpu_per_tick,
                # Flat across N => same work per tick, so any wall-clock
                # shortfall is core availability, not sharding overhead.
                "cpu_per_tick_vs_baseline": (
                    arm.cpu_per_tick / baseline.cpu_per_tick
                    if baseline.cpu_per_tick else None
                ),
            }
        )
    return rows


def verdict(
    rows: Sequence[dict[str, Any]], *, min_efficiency: float = DEFAULT_MIN_EFFICIENCY
) -> dict[str, Any]:
    """Quasi-linear iff parallel efficiency at the LARGEST arm clears the bar.

    The largest arm is the honest place to judge: efficiency decays with N, so
    a mid-range arm can look fine while the top one has already collapsed.
    """
    if len(rows) < 2:
        raise ValueError("need at least two arms (a baseline and one more)")
    top = max(rows, key=lambda r: r["shard_count"])
    return {
        "quasi_linear": bool(top["efficiency"] >= min_efficiency),
        "max_shard_count": top["shard_count"],
        "speedup": top["speedup"],
        "efficiency": top["efficiency"],
        "serial_fraction": top["serial_fraction"],
        "min_efficiency": min_efficiency,
    }


# --------------------------------------------------------------------------- #
# Child: one shard process
# --------------------------------------------------------------------------- #
def run_shard_workload(
    dataset_slug: str,
    zids: Sequence[int],
    shard_index: int,
    shard_count: int,
    *,
    n_cuts: int,
    ready_path: Path | None = None,
    go_path: Path | None = None,
) -> ShardResult:
    """Replay each owned zid and report ONLY the compute phase.

    Imports, dataset load and conversation setup happen before the barrier, so
    the measured window contains math and nothing else.
    """
    # Imported here, not at module scope: the parent process orchestrates and
    # must not pay numpy/scipy import cost, and the child must pay it BEFORE
    # the barrier so it lands outside the timed window.
    from polismath.replay.driver import run_replay
    from polismath.replay.real_data import load_export_votes
    from polismath.replay.schedule import ScheduleSpec

    owned = shard_workload(zids, shard_index, shard_count)
    dataset = load_export_votes(dataset_slug)
    n_votes = len(dataset.votes)
    cuts = [round(n_votes * (i + 1) / n_cuts) for i in range(n_cuts)]
    spec = ScheduleSpec(
        dataset=dataset_slug,
        schedule_id=f"shardbench{n_cuts}",
        cuts={"mode": "vote-count", "at": cuts},
    )

    # Barrier: every shard signals readiness, then waits to be released, so the
    # arms' compute phases actually overlap. Without it a staggered start lets
    # early shards run alone, understating contention and overstating speedup.
    if ready_path is not None:
        ready_path.write_text("ready", encoding="utf-8")
    if go_path is not None:
        while not go_path.exists():
            time.sleep(0.01)

    import resource

    ticks = 0
    ru0 = resource.getrusage(resource.RUSAGE_SELF)
    t0 = time.perf_counter()
    for _zid in owned:
        ticks += len(run_replay(dataset, spec))
    compute = time.perf_counter() - t0
    ru1 = resource.getrusage(resource.RUSAGE_SELF)
    cpu = (ru1.ru_utime - ru0.ru_utime) + (ru1.ru_stime - ru0.ru_stime)

    return ShardResult(
        shard_index=shard_index, ticks=ticks, compute_seconds=compute,
        cpu_seconds=cpu,
    )


# --------------------------------------------------------------------------- #
# Parent: orchestrate one arm, then the sweep
# --------------------------------------------------------------------------- #
def _child_cmd(
    dataset: str, zid_count: int, shard_index: int, shard_count: int,
    n_cuts: int, ready: Path, go: Path,
) -> list[str]:
    return [
        sys.executable, "-m", "polismath.replay.shard_bench",
        "--dataset", dataset,
        "--zid-count", str(zid_count),
        "--shard-index", str(shard_index),
        "--shard-count", str(shard_count),
        "--cuts", str(n_cuts),
        "--ready-file", str(ready),
        "--go-file", str(go),
    ]


def run_arm(
    dataset: str, zid_count: int, shard_count: int, *, n_cuts: int, pin: bool,
    work_dir: Path, log: Any = None,
) -> ArmResult:
    """Spawn ``shard_count`` real processes, barrier them, collect their reports."""
    work_dir.mkdir(parents=True, exist_ok=True)
    go = work_dir / f"go-{shard_count}-{int(pin)}"
    go.unlink(missing_ok=True)
    env = blas_env(dict(os.environ), pin=pin)

    # Child output goes to FILES, never pipes.  conversation.py logs several KB
    # per tick to stderr; a 64KB pipe fills long before a shard finishes, and
    # the child then blocks on write until the parent reads it.  Because the
    # parent drains shard-by-shard (communicate() below), shard 0 would run at
    # full speed while every other shard sat blocked awaiting its turn — which
    # serialises the arm and silently destroys the measurement.  Measured on an
    # IDLE 16-core r8g.4xlarge before this fix: 1.05x at N=2, cpu/tick flat.
    procs: list[tuple[int, subprocess.Popen, Path, Path, Path, Any, Any]] = []
    for idx in range(shard_count):
        ready = work_dir / f"ready-{shard_count}-{int(pin)}-{idx}"
        ready.unlink(missing_ok=True)
        out_path = work_dir / f"out-{shard_count}-{int(pin)}-{idx}.txt"
        err_path = work_dir / f"err-{shard_count}-{int(pin)}-{idx}.txt"
        out_fh = out_path.open("w", encoding="utf-8")
        err_fh = err_path.open("w", encoding="utf-8")
        proc = subprocess.Popen(
            _child_cmd(dataset, zid_count, idx, shard_count, n_cuts, ready, go),
            cwd=str(_DELPHI_ROOT), env=env,
            stdout=out_fh, stderr=err_fh, text=True,
        )
        procs.append((idx, proc, ready, out_path, err_path, out_fh, err_fh))

    # Wait for every child to finish its setup, then release them together.
    deadline = time.monotonic() + CHILD_TIMEOUT_SEC
    while not all(r.exists() for _, _, r, _, _, _, _ in procs):
        dead = [
            (i, p, ep) for i, p, _, _, ep, _, _ in procs if p.poll() is not None
        ]
        if dead:
            for _, fh in [(p, fh) for _, p, _, _, _, fh, _ in procs]:
                fh.close()
            i, p, ep = dead[0]
            err = ep.read_text(encoding="utf-8", errors="replace") if ep.exists() else ""
            raise RuntimeError(
                f"shard {i} died before the barrier (rc={p.returncode}):\n"
                f"{err.strip()[-2000:]}"
            )
        if time.monotonic() > deadline:
            for _, p, _, _, _, _, _ in procs:
                p.kill()
            raise RuntimeError("timed out waiting for shards to become ready")
        time.sleep(0.01)
    go.write_text("go", encoding="utf-8")

    results: list[ShardResult] = []
    for idx, proc, _, out_path, err_path, out_fh, err_fh in procs:
        proc.wait(timeout=CHILD_TIMEOUT_SEC)
        out_fh.close()
        err_fh.close()
        if proc.returncode != 0:
            err = err_path.read_text(encoding="utf-8", errors="replace")
            raise RuntimeError(
                f"shard {idx}/{shard_count} failed (rc={proc.returncode}):\n"
                f"{err.strip()[-2000:]}"
            )
        out = out_path.read_text(encoding="utf-8", errors="replace").strip()
        if not out:
            err = err_path.read_text(encoding="utf-8", errors="replace")
            raise RuntimeError(
                f"shard {idx}/{shard_count} produced no result line:\n"
                f"{err.strip()[-2000:]}"
            )
        payload = json.loads(out.splitlines()[-1])
        results.append(ShardResult(**payload))

    arm = summarize_arm(shard_count, results)
    if log is not None:
        log(
            f"  N={shard_count:>2}  ticks={arm.ticks:>4}  "
            f"wall={arm.wall_seconds:6.2f}s  {arm.throughput:6.2f} ticks/s"
        )
    return arm


def run_sweep(
    *, dataset: str = DEFAULT_DATASET, zid_count: int = DEFAULT_ZID_COUNT,
    shard_counts: Sequence[int] = DEFAULT_SHARD_COUNTS, n_cuts: int = 4,
    pin: bool = True, work_dir: Path, min_efficiency: float = DEFAULT_MIN_EFFICIENCY,
    repeats: int = 1, log: Any = None,
) -> dict[str, Any]:
    """Run every arm ``repeats`` times, keep each arm's fastest, and judge.

    Load average is recorded because it is the single biggest confounder on a
    developer machine: a sweep taken under heavy background load understates
    scaling, and a reader cannot tell that from the table alone.
    """
    for n in shard_counts:
        if zid_count % n:
            raise ValueError(
                f"zid_count={zid_count} is not divisible by shard_count={n}: "
                "an uneven split would measure a remainder, not scaling"
            )
    load_before = os.getloadavg()
    arms: list[ArmResult] = []
    for n in sorted(shard_counts):
        repeats_for_n = [
            run_arm(dataset, zid_count, n, n_cuts=n_cuts, pin=pin,
                    work_dir=work_dir, log=log)
            for _ in range(max(1, repeats))
        ]
        arms.append(best_arm(repeats_for_n))
    rows = scaling_table(arms)
    return {
        "dataset": dataset,
        "zid_count": zid_count,
        "cuts_per_zid": n_cuts,
        "blas_pinned": pin,
        "repeats": repeats,
        "cpu_count": os.cpu_count(),
        "load_before": load_before,
        "load_after": os.getloadavg(),
        "rows": rows,
        "verdict": verdict(rows, min_efficiency=min_efficiency),
    }


# --------------------------------------------------------------------------- #
# Child entrypoint (python -m polismath.replay.shard_bench)
# --------------------------------------------------------------------------- #
def _main(argv: Sequence[str]) -> int:
    import argparse

    ap = argparse.ArgumentParser(description="one shard of the scaling benchmark")
    ap.add_argument("--dataset", required=True)
    ap.add_argument("--zid-count", type=int, required=True)
    ap.add_argument("--shard-index", type=int, required=True)
    ap.add_argument("--shard-count", type=int, required=True)
    ap.add_argument("--cuts", type=int, default=4)
    ap.add_argument("--ready-file")
    ap.add_argument("--go-file")
    args = ap.parse_args(list(argv))

    result = run_shard_workload(
        args.dataset,
        list(range(args.zid_count)),
        args.shard_index,
        args.shard_count,
        n_cuts=args.cuts,
        ready_path=Path(args.ready_file) if args.ready_file else None,
        go_path=Path(args.go_file) if args.go_file else None,
    )
    print(json.dumps(result.__dict__))
    return 0


if __name__ == "__main__":
    raise SystemExit(_main(sys.argv[1:]))
