#!/usr/bin/env python3
"""Certification CLI (SPEC A) — battery runner + first-divergence focuser.

Thin click wrapper over ``polismath.replay.certify``: this script owns ALL
printing (``click.echo``) and process exit codes; the library itself stays
pure / side-effect-scoped so it is directly unit-testable without a CliRunner
(see ``tests/replay_harness/test_certify.py`` for the library, and
``tests/replay_harness/test_certify_cli.py`` for this CLI).

Usage (from delphi/)::

    # Certify the whole starter battery (scripts/certify_battery.json):
    uv run python scripts/certify.py run

    # Restrict to one dataset, or one (dataset, schedule_id) pair:
    uv run python scripts/certify.py run --only vw
    uv run python scripts/certify.py run --only vw:uniform8-clojure-legacy

    # Force re-running a driver (bypass the content-hash cache):
    uv run python scripts/certify.py run --refresh-clj --refresh-py

    # SKIPPED (dataset-unavailable) entries also fail the run:
    uv run python scripts/certify.py run --strict

    # Inspect the earliest divergent step of an EXISTING recording pair
    # (produced by a prior `run`, or a manual replay):
    uv run python scripts/certify.py focus vw uniform8-clojure-legacy
"""

from __future__ import annotations

import sys
from pathlib import Path

import click

from polismath.replay import certify as cert


@click.group()
def cli() -> None:
    """Clojure<->Python math parity certification."""


@cli.command()
@click.option("--battery", "battery_path", type=click.Path(exists=True, path_type=Path),
              default=cert.DEFAULT_BATTERY_PATH, show_default=True,
              help="Battery config JSON.")
@click.option("--only", default=None, help="Restrict to dataset[:schedule_id].")
@click.option("--refresh-clj", is_flag=True, help="Force re-run the Clojure driver.")
@click.option("--refresh-py", is_flag=True, help="Force re-run the Python driver.")
@click.option("--strict", is_flag=True,
              help="SKIPPED (dataset-unavailable) entries also fail the run.")
@click.option("--root", type=click.Path(path_type=Path), default=None,
              help="Recording store root (default: real_data/.local/replays).")
@click.option("--workers", type=int, default=6, show_default=True,
              help="Parallel battery entries (drivers + compare); the ledger "
                   "fold stays serial, so results match --workers 1 exactly.")
def run(battery_path, only, refresh_clj, refresh_py, strict, root, workers):
    """Certify every entry in the battery (or a filtered subset)."""
    entries = cert.load_battery(battery_path)
    report = cert.run_battery(entries, root=root, refresh_clj=refresh_clj,
                               refresh_py=refresh_py, only=only, workers=workers)
    for line in cert.render_run_lines(report):
        click.echo(line)
    sys.exit(cert.battery_exit_code(report["battery"], strict=strict))


@cli.command()
@click.argument("dataset")
@click.argument("schedule_id")
@click.option("--root", type=click.Path(path_type=Path), default=None,
              help="Recording store root (default: real_data/.local/replays).")
def focus(dataset, schedule_id, root):
    """First-divergence focuser: earliest divergent step of an EXISTING
    (dataset, schedule_id) recording pair (produced by a prior `run`)."""
    result = cert.run_focus(dataset, schedule_id, root=root)
    for line in cert.render_focus_lines(result):
        click.echo(line)
    sys.exit(0 if result["verdict"] == "MATCH" else 1)


if __name__ == "__main__":
    cli()
