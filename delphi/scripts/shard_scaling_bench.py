#!/usr/bin/env python3
"""Shard-scaling benchmark CLI — does throughput scale with the shard count?

Answers HANDOFF_PYTHON_SHARDING.md §7's open acceptance criterion ("with N
shards on an N-core box, aggregate throughput should approach the measured
15.7x at 16 rather than the current 1.0x") for the SHIPPED ``zid % N`` filter,
which the cost study's arm never exercised (§8).

Thin wrapper over ``polismath.replay.shard_bench`` — same split as
``scripts/poller_equiv.py`` and ``scripts/certify.py``: the library stays pure
/ side-effect-scoped, this script owns printing and process exit codes.

Usage (from delphi/)::

    # Default sweep: biodiversity, 24 zids, N = 1,2,4,8, BLAS pinned.
    uv run python scripts/shard_scaling_bench.py run

    # The §0 control arm: identical sweep with BLAS threads UNPINNED, which is
    # what production runs today (nothing sets OMP_NUM_THREADS anywhere).
    uv run python scripts/shard_scaling_bench.py run --no-pin

    # Both arms, so pinned vs unpinned is measured rather than asserted:
    uv run python scripts/shard_scaling_bench.py run --both

Each arm spawns real processes and takes ~a minute of CPU, so this is opt-in
tooling, never part of the pytest suite. Exit code is 1 if the pinned sweep
fails the quasi-linear bar.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import click

from polismath.replay import shard_bench as sb


def _echo(msg: str) -> None:
    click.echo(msg, err=True)


def _render(report: dict) -> list[str]:
    """Compact table — one line per arm, plus the verdict."""
    pinned = "pinned" if report["blas_pinned"] else "UNPINNED"
    lines = [
        f"dataset={report['dataset']} zids={report['zid_count']} "
        f"cuts/zid={report['cuts_per_zid']} blas={pinned} "
        f"cores={report['cpu_count']} repeats={report['repeats']} "
        f"load={report['load_before'][0]:.2f}->{report['load_after'][0]:.2f}",
        f"{'N':>3}  {'ticks':>6}  {'wall_s':>8}  {'ticks/s':>8}  "
        f"{'speedup':>8}  {'effic':>6}  {'serial_f':>9}  {'cpu/tick':>9}  {'vs N=1':>7}",
    ]
    for r in report["rows"]:
        sf = r["serial_fraction"]
        rel = r["cpu_per_tick_vs_baseline"]
        lines.append(
            f"{r['shard_count']:>3}  {r['ticks']:>6}  {r['wall_seconds']:>8.2f}  "
            f"{r['throughput']:>8.2f}  {r['speedup']:>7.2f}x  "
            f"{r['efficiency']:>6.2f}  {'--' if sf is None else f'{sf:>9.4f}'}  "
            f"{r['cpu_per_tick']:>9.3f}  "
            f"{'--' if rel is None else f'{rel:>6.2f}x'}"
        )
    warn = sb.load_warning(
        load1=report["load_before"][0], cpu_count=report["cpu_count"],
        shard_count=report["verdict"]["max_shard_count"],
    )
    if warn:
        lines.append(warn)
    v = report["verdict"]
    lines.append(
        f"VERDICT: {'QUASI-LINEAR' if v['quasi_linear'] else 'NOT quasi-linear'} "
        f"— {v['speedup']:.2f}x at N={v['max_shard_count']} "
        f"(efficiency {v['efficiency']:.2f}, bar {v['min_efficiency']:.2f}; "
        f"serial fraction {v['serial_fraction']:.4f})"
    )
    return lines


@click.group()
def cli() -> None:
    """Shard-scaling benchmark (see module docstring)."""


@cli.command()
@click.option("--dataset", default=sb.DEFAULT_DATASET, show_default=True,
              help="Dataset slug replayed once per zid.")
@click.option("--zid-count", type=int, default=sb.DEFAULT_ZID_COUNT,
              show_default=True,
              help="Fixed workload size; must divide every shard count.")
@click.option("--shard-counts", default=",".join(map(str, sb.DEFAULT_SHARD_COUNTS)),
              show_default=True, help="Comma-separated arms to run.")
@click.option("--cuts", type=int, default=4, show_default=True,
              help="Schedule cuts per zid (= math ticks per zid).")
@click.option("--pin/--no-pin", default=True, show_default=True,
              help="Pin BLAS/OpenMP threads to 1 in each shard (handoff §0).")
@click.option("--both", is_flag=True,
              help="Run pinned AND unpinned sweeps, to measure the difference.")
@click.option("--repeats", type=int, default=1, show_default=True,
              help="Run each arm this many times and keep the fastest — "
                   "background load only ever ADDS wall time.")
@click.option("--min-efficiency", type=float, default=sb.DEFAULT_MIN_EFFICIENCY,
              show_default=True, help="Parallel-efficiency bar at the largest arm.")
@click.option("--out", type=click.Path(path_type=Path), default=None,
              help="Write the full report JSON here.")
def run(dataset, zid_count, shard_counts, cuts, pin, both, repeats,
        min_efficiency, out):
    """Run the sweep and report speedup / efficiency / serial fraction."""
    counts = [int(x) for x in shard_counts.split(",") if x.strip()]
    work_dir = Path("scratch/shard_bench")
    arms = [True, False] if both else [pin]

    reports = []
    for do_pin in arms:
        _echo(f"--- sweep: BLAS {'pinned to 1' if do_pin else 'UNPINNED'} ---")
        report = sb.run_sweep(
            dataset=dataset, zid_count=zid_count, shard_counts=counts,
            n_cuts=cuts, pin=do_pin, work_dir=work_dir,
            min_efficiency=min_efficiency, repeats=repeats, log=_echo,
        )
        reports.append(report)

    for report in reports:
        click.echo("")
        for line in _render(report):
            click.echo(line)

    if out is not None:
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(reports, indent=2), encoding="utf-8")
        _echo(f"\nreport written to {out}")

    # Judge the PINNED sweep — the unpinned arm is a control, and is expected
    # to scale badly. If only --no-pin was requested, judge that.
    judged = reports[0]
    return 0 if judged["verdict"]["quasi_linear"] else 1


if __name__ == "__main__":
    sys.exit(cli(standalone_mode=False) or 0)
