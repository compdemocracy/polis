#!/usr/bin/env python3
"""Replay-harness CLI (Phase H-A) — run a (dataset, schedule) replay and
compare two recordings.

Runs the Python driver end-to-end and writes a recording store
(``real_data/.local/replays/<dataset>/<schedule_id>/`` by default), and offers
a compare entry point for two recordings. The Clojure driver (H-B) and
cross-language comparison land later; this CLI already exercises the full
Python spine.

Usage (from delphi/)::

    # Run a preset schedule on the public vw dataset:
    uv run python scripts/replay_driver.py run --dataset vw --preset front-loaded
    uv run python scripts/replay_driver.py run --dataset vw --preset uniform --n-cuts 8
    uv run python scripts/replay_driver.py run --dataset vw --preset per-day

    # Run an explicit schedule JSON (§4):
    uv run python scripts/replay_driver.py run --schedule my_schedule.json

    # Compare two recordings step-by-step:
    uv run python scripts/replay_driver.py compare <dir_a> <dir_b> --report out.json
"""

from __future__ import annotations

import logging
import sys
from pathlib import Path

import click

from polismath.replay import schedule as sched
from polismath.replay import store as st
from polismath.replay import stepcompare as sc
from polismath.replay.driver import run_replay
from polismath.replay.real_data import load_export_votes
from polismath.replay.types import ReplayDataset

_PRESETS = (
    "uniform", "front-loaded", "back-loaded", "every-vote", "single-cut", "per-day"
)


def _spec_from_preset(
    preset: str, dataset: str, ds: ReplayDataset, *, n_cuts: int,
    schedule_id: str | None,
) -> sched.ScheduleSpec:
    n = ds.n
    if preset == "uniform":
        return sched.preset_uniform(dataset, n, n_cuts=n_cuts, schedule_id=schedule_id)
    if preset == "front-loaded":
        return sched.preset_front_loaded(
            dataset, n, n_cuts=n_cuts, schedule_id=schedule_id or "front-loaded")
    if preset == "back-loaded":
        return sched.preset_back_loaded(
            dataset, n, n_cuts=n_cuts, schedule_id=schedule_id or "back-loaded")
    if preset == "every-vote":
        return sched.preset_every_vote(dataset, n, schedule_id=schedule_id or "every-vote")
    if preset == "single-cut":
        return sched.preset_single_cut(dataset, n, schedule_id=schedule_id or "single-cut")
    if preset == "per-day":
        return sched.preset_per_day(dataset, ds, schedule_id=schedule_id or "per-day")
    raise click.BadParameter(f"unknown preset {preset!r}")


@click.group()
def cli() -> None:
    """Replay-harness driver + comparer."""


@cli.command()
@click.option("--dataset", help="Dataset slug (e.g. vw). Required unless --schedule sets it.")
@click.option("--schedule", "schedule_path", type=click.Path(exists=True, path_type=Path),
              help="Path to a schedule.json (§4). Overrides --preset.")
@click.option("--preset", type=click.Choice(_PRESETS), default=None,
              help="Built-in schedule preset.")
@click.option("--n-cuts", type=int, default=6, show_default=True,
              help="Number of cuts for uniform/front/back presets.")
@click.option("--schedule-id", default=None, help="Override the schedule id.")
@click.option("--out", "out_root", type=click.Path(path_type=Path), default=None,
              help="Store root (default: real_data/.local/replays).")
@click.option("--verbose", is_flag=True, help="Show driver progress logging.")
def run(dataset, schedule_path, preset, n_cuts, schedule_id, out_root, verbose):
    """Run a (dataset, schedule) replay and write the recording store."""
    if not verbose:
        logging.disable(logging.CRITICAL)

    ds: ReplayDataset | None = None
    loaded_slug: str | None = None
    if schedule_path is not None:
        spec = sched.ScheduleSpec.from_json_file(schedule_path)
        dataset = dataset or spec.dataset
    elif preset is not None:
        if not dataset:
            raise click.UsageError("--dataset is required with --preset")
        ds = load_export_votes(dataset)
        loaded_slug = dataset
        spec = _spec_from_preset(preset, dataset, ds, n_cuts=n_cuts,
                                 schedule_id=schedule_id)
    else:
        raise click.UsageError("provide either --schedule or --preset")

    # Reuse the dataset already loaded to build a preset spec instead of loading
    # it a second time; only the --schedule path (or a slug mismatch) needs a load.
    if ds is None or loaded_slug != spec.dataset:
        ds = load_export_votes(spec.dataset)
    click.echo(f"dataset={spec.dataset} n_votes={ds.n} schedule={spec.schedule_id}", err=True)

    def _progress(i: int, total: int) -> None:
        click.echo(f"  step {i + 1}/{total} …", err=True)

    records = run_replay(ds, spec, progress=_progress if verbose else None)
    out_dir = st.write_recording(records, spec, root=out_root)
    click.echo(f"wrote {len(records)} steps → {out_dir}")


@cli.command()
@click.argument("dir_a", type=click.Path(exists=True, path_type=Path))
@click.argument("dir_b", type=click.Path(exists=True, path_type=Path))
@click.option("--engine", default="py", show_default=True)
@click.option("--report", "report_path", type=click.Path(path_type=Path), default=None,
              help="Write the full per-step JSON report here.")
@click.option("--abs-tol", type=float, default=1e-6, show_default=True)
@click.option("--rel-tol", type=float, default=0.01, show_default=True)
def compare(dir_a, dir_b, engine, report_path, abs_tol, rel_tol):
    """Compare two recordings step-by-step and print a divergence summary."""
    comparer = sc.StepComparer(abs_tolerance=abs_tol, rel_tolerance=rel_tol)
    report = sc.compare_recordings(dir_a, dir_b, engine=engine, comparer=comparer)
    click.echo(sc.format_report(report))
    if report_path is not None:
        sc.write_report(report, report_path)
        click.echo(f"report → {report_path}", err=True)
    sys.exit(0 if report["overall_match"] else 1)


if __name__ == "__main__":
    cli()
