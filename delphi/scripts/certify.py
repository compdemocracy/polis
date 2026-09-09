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

    # A strict run succeeds only on a complete PASS manifest:
    uv run python scripts/certify.py run --strict

    # Inspect the earliest divergent step of an EXISTING recording pair
    # (produced by a prior `run`, or a manual replay):
    uv run python scripts/certify.py focus vw uniform8-clojure-legacy
"""

from __future__ import annotations

import sys
import uuid
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
              help="Exit nonzero unless the complete run manifest verdict is PASS.")
@click.option("--root", type=click.Path(path_type=Path), default=None,
              help="Recording store root (default: real_data/.local/replays).")
@click.option("--workers", type=int, default=6, show_default=True,
              help="Parallel battery entries (drivers + compare); the ledger "
                   "fold stays serial, so results match --workers 1 exactly.")
@click.option("--drivers", default="clj,py", show_default=True,
              help="Comma-separated producer ids (clj,py[,rust]). The default "
                   "clj,py is the unchanged legacy two-driver run; selecting rust "
                   "(or any non-default set) routes to the P-045 bridge, which "
                   "emits a polis-certification-run/2 report with per-entry "
                   "clj/py/rust rows. rust requires both references.")
@click.option("--profile", "profile", default=None,
              help="Bridge campaign profile (battery-chain/1 or "
                   "snapshot-rebuild/1); mandatory when rust is selected.")
def run(battery_path, only, refresh_clj, refresh_py, strict, root, workers, drivers, profile):
    """Certify every entry in the battery (or a filtered subset).

    ``--drivers clj,py`` with no ``--profile`` is the legacy two-driver path,
    byte-for-byte unchanged. Any other driver set routes to the additive P-045
    bridge, whose rust rows are UNSUPPORTED_PROFILE until the slice-3
    forced-compute path exists (exit 2 / INCONCLUSIVE, never a fabricated PASS).
    """
    if drivers != "clj,py" or profile is not None:
        from polismath.replay import coordinator_driver as cdrv
        try:
            selected = cdrv.parse_drivers(drivers)
            if profile is None:
                raise cdrv.BridgeError("profile", "--profile is required for a bridge run")
            entries = cert.load_battery(battery_path)
            if only is not None:
                entries = cert._filter_only(entries, only)
            report = cdrv.run_bridge_battery(
                entries, root=root or cert.st.replays_root(), profile=profile,
                drivers=selected, battery_path=battery_path)
        except (cdrv.BridgeError, ValueError, KeyError, TypeError, OSError) as exc:
            click.echo(f"certify: bridge FAIL [configuration] {exc}")
            sys.exit(2)
        for line in cdrv.render_bridge_lines(report):
            click.echo(line)
        sys.exit(cdrv.bridge_exit_code(report))
    try:
        entries = cert.load_battery(battery_path)
        report = cert.run_battery(entries, root=root, refresh_clj=refresh_clj,
                                 refresh_py=refresh_py, only=only, workers=workers,
                                 battery_path=battery_path)
    except (ValueError, KeyError, TypeError, OSError) as exc:
        output_root = root or cert.st.replays_root()
        # Per-run filename here too: a battery that fails to even load must not
        # overwrite the manifest of the last run that actually reached a verdict.
        run_id = str(uuid.uuid4())
        manifest_path = cert.run_manifest_path(output_root, run_id)
        cert._write_json(manifest_path, {
            "schema": "polis-certification-run/1", "run_id": run_id, "verdict": "FAIL",
            "partial": only is not None, "finished_at": None,
            "inventory": [], "entries": [], "configuration_errors": [str(exc)],
        })
        cert._write_json(output_root / cert.RUN_MANIFEST_LATEST, {
            "schema": "polis-certification-run-pointer/1", "run_id": run_id,
            "verdict": "FAIL", "finished_at": None, "run_manifest": str(manifest_path),
        })
        click.echo(f"certify: FAIL [configuration] {exc}; manifest={manifest_path}")
        sys.exit(1)
    # Carry the CLI selection into the summary even if a caller substitutes a runner.
    if only is not None:
        report["partial"] = True
    for line in cert.render_run_lines(report):
        click.echo(line)
    sys.exit(cert.battery_exit_code(report, strict=strict))


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
