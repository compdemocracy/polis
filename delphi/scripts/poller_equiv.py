#!/usr/bin/env python3
"""Poller-equivalence harness CLI — Stages A (schema+seed), B (runners),
C (feeder + comparer), and D (self-jitter envelope + full-run orchestration).

See ``delphi/docs/MATH_POLLER_EQUIV_SPEC.md`` and
``polismath.replay.poller_equiv`` (the library this is a thin click wrapper
over — same split as ``scripts/certify.py``: the library stays pure /
side-effect-scoped, this script owns printing and process exit codes).

Stages A/B/C are wired up here: create the throwaway DB + seed a conversation;
start/stop the clj container and the python poller against it; feed timed vote
batches while snapshotting math_main/math_bidtopid/math_ptptstats per env, and
compare the resulting snapshot store. Stage D adds the ``full-run`` subcommand:
two independent clj-only runs -> self-jitter envelope, one paired clj+py
restart-seam run, envelope-aware compare, verdict JSON + terse summary.

Usage (from delphi/)::

    # Create polis_equiv (dropping it first) and seed one dataset's full
    # conversation (comments + ALL votes) under zid=1:
    uv run python scripts/poller_equiv.py seed --dataset vw \\
        --admin-url postgresql://postgres:postgres@localhost:15432/postgres

    # Start the clj container against an already-seeded DB, block until Ctrl-C:
    uv run python scripts/poller_equiv.py run-clj \\
        --database-url postgresql://postgres:postgres@localhost:15432/polis_equiv \\
        --math-env clj-ref

    # Start the python poller the same way:
    uv run python scripts/poller_equiv.py run-py \\
        --database-url postgresql://postgres:postgres@localhost:15432/polis_equiv \\
        --math-env py-shadow

    # Feed a vw uniform-8 batch stream through BOTH runners at once, snapshotting
    # each batch's three tables under --out, with a restart seam after batch 3:
    uv run python scripts/poller_equiv.py feed --dataset vw \\
        --admin-url postgresql://postgres:postgres@localhost:15432/postgres \\
        --cuts 100,200,300,400,500,585 --seam-after 3 \\
        --out real_data/.local/replays/_poller_equiv/vw

    # Compare an existing --out snapshot store:
    uv run python scripts/poller_equiv.py compare \\
        --out real_data/.local/replays/_poller_equiv/vw

    # Full protocol (spec §2/§3 stage D) — two clj-only self-jitter runs,
    # one paired clj+py restart-seam run, envelope-aware compare, verdict:
    uv run python scripts/poller_equiv.py full-run --dataset vw \\
        --admin-url postgresql://postgres:postgres@localhost:15432/postgres \\
        --out real_data/.local/replays/_poller_equiv_full/vw
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

import click
import sqlalchemy as sa

from polismath.replay import poller_equiv as pe
from polismath.replay.real_data import load_export_votes


@click.group()
def cli() -> None:
    """Poller-equivalence harness (Stages A/B/C/D — see module docstring)."""


@cli.command()
@click.option("--dataset", required=True, help="Dataset slug (e.g. vw).")
@click.option("--admin-url", required=True,
              help="Connection URL to an EXISTING db (e.g. .../postgres) on "
                   "the target server — NOT the equiv db itself.")
@click.option("--dbname", default=pe.DEFAULT_DBNAME, show_default=True,
              help="Throwaway database name to (re)create.")
@click.option("--zid", type=int, default=pe.DEFAULT_ZID, show_default=True)
@click.option("--to-slot", type=int, default=None,
              help="Insert votes[:to_slot] (default: the whole dataset).")
def seed(dataset, admin_url, dbname, zid, to_slot):
    """Create the throwaway equiv DB and seed one dataset's conversation."""
    ds = load_export_votes(dataset)
    to_slot = ds.n if to_slot is None else to_slot
    click.echo(f"dataset={dataset} n_votes={ds.n} n_comments={len(ds.comments)}", err=True)

    target_url = pe.create_equiv_db(admin_url, dbname=dbname)
    engine = sa.create_engine(target_url)
    try:
        with engine.begin() as conn:
            pe.seed_conversation(conn, ds, zid=zid)
            n = pe.insert_votes(conn, ds, 0, to_slot, zid=zid)
    finally:
        engine.dispose()

    click.echo(f"seeded zid={zid} into {dbname!r}: {n} votes, "
               f"{len(ds.comments)} comments -> {target_url}")


@cli.command("run-clj")
@click.option("--database-url", required=True)
@click.option("--math-env", required=True)
@click.option("--poll-from-days-ago", type=float, default=10000, show_default=True)
def run_clj(database_url, math_env, poll_from_days_ago):
    """Start the REAL clj math container loop (blocks; Ctrl-C stops it)."""
    runner = pe.CljContainerRunner(
        database_url=database_url, math_env=math_env,
        poll_from_days_ago=poll_from_days_ago,
    )
    _run_and_stream(runner, label="clj")


@cli.command("run-py")
@click.option("--database-url", required=True)
@click.option("--math-env", required=True)
@click.option("--poll-from-days-ago", type=float, default=10000, show_default=True)
def run_py(database_url, math_env, poll_from_days_ago):
    """Start the python math_poller (blocks; Ctrl-C stops it)."""
    runner = pe.PyPollerRunner(
        database_url=database_url, math_env=math_env,
        poll_from_days_ago=poll_from_days_ago,
    )
    _run_and_stream(runner, label="py")


@cli.command()
@click.option("--dataset", required=True, help="Dataset slug (e.g. vw).")
@click.option("--admin-url", required=True,
              help="Connection URL to an EXISTING db (e.g. .../postgres) on "
                   "the target server — NOT the equiv db itself.")
@click.option("--cuts", required=True,
              help="Comma-separated, strictly-increasing 1-based vote-count "
                   "cut slots (e.g. 100,200,300,400,500,585). Include the "
                   "dataset's total vote count as the last value to recompute "
                   "the tail (batch_slices' 'final batch to n' convention).")
@click.option("--out", "out_dir", required=True, type=click.Path(path_type=Path),
              help="Snapshot store root — one subdir per math_env.")
@click.option("--seam-after", type=int, default=None,
              help="Batch index (0-based) after which to kill+restart the "
                   "py runner (and, with --restart-clj-at-seam, the clj one).")
@click.option("--restart-clj-at-seam", is_flag=True, default=False)
@click.option("--dbname", default=pe.DEFAULT_DBNAME, show_default=True)
@click.option("--zid", type=int, default=pe.DEFAULT_ZID, show_default=True)
@click.option("--clj-env", default="clj-ref", show_default=True)
@click.option("--py-env", default="py-shadow", show_default=True)
@click.option("--poll-from-days-ago", type=float, default=10000, show_default=True)
@click.option("--wait-timeout", type=float, default=120.0, show_default=True,
              help="Seconds to wait for EACH math_env to reflect a batch "
                   "before giving up on it.")
def feed(dataset, admin_url, cuts, out_dir, seam_after, restart_clj_at_seam, dbname, zid,
         clj_env, py_env, poll_from_days_ago, wait_timeout):
    """Stage C feeder: seed the equiv DB, start both runners, then insert
    vote batches one at a time — waiting for each math_env to reflect a
    batch before snapshotting math_main/math_bidtopid/math_ptptstats and
    moving on (spec §1 'feed'/'seam' bullets)."""
    cut_slots = [int(c) for c in cuts.split(",") if c.strip()]
    try:
        manifest = pe.run_equiv_stream(
            admin_url, dataset, cut_slots,
            out_dir=out_dir, seam_after=seam_after, math_envs=(clj_env, py_env),
            restart_clj_at_seam=restart_clj_at_seam, dbname=dbname, zid=zid,
            poll_from_days_ago=poll_from_days_ago,
            wait_timeout=wait_timeout,
        )
    except pe.PollerEquivStreamError as exc:
        click.echo(f"poller-equiv feed: ABORTED\n{exc}", err=True)
        sys.exit(1)
    n_ready = sum(
        1 for b in manifest["batches"] if all(e["ready"] for e in b["envs"].values())
    )
    click.echo(
        f"fed {len(manifest['batches'])} batches ({n_ready} fully ready) -> {out_dir}"
    )


@cli.command()
@click.option("--out", "out_dir", required=True,
              type=click.Path(exists=True, file_okay=False, path_type=Path))
@click.option("--clj-env", default="clj-ref", show_default=True)
@click.option("--py-env", default="py-shadow", show_default=True)
def compare(out_dir, clj_env, py_env):
    """Stage C comparer: verdict over an existing --out snapshot store (spec
    §1 'compare' bullet — same acceptance as certify for math_main, exact
    equality for math_bidtopid, structural+tolerant for math_ptptstats, plus
    tick-monotonicity and watermark-exactly-once checks)."""
    report = pe.compare_snapshots(out_dir, math_envs=(clj_env, py_env))
    pe.write_compare_verdict(report, out_dir)
    for line in pe.render_compare_lines(report):
        click.echo(line)
    sys.exit(pe.compare_exit_code(report))


@cli.command("full-run")
@click.option("--dataset", required=True, help="Dataset slug (e.g. vw).")
@click.option("--admin-url", required=True,
              help="Connection URL to an EXISTING db (e.g. .../postgres) on "
                   "the target server — NOT any of the equiv dbs themselves.")
@click.option("--cuts", default=None,
              help="Comma-separated, strictly-increasing 1-based vote-count "
                   "cut slots. Default: --dataset's uniform-8 slots (for vw, "
                   "read VERBATIM from scripts/schedules/vw-uniform8-restart4.json; "
                   "for any other dataset, derived the same way certify's own "
                   "uniform/n_cuts=8 battery entries are).")
@click.option("--seam-after", type=int, default=None,
              help="Batch index (0-based) after which to restart the runners. "
                   "Default: the default schedule's own restart point (vw: "
                   "step 4) — mid-schedule for a derived schedule.")
@click.option("--out", "out_root", required=True, type=click.Path(path_type=Path),
              help="Output root — holds self-jitter-1/, self-jitter-2/, main/ "
                   "snapshot stores plus full_run_verdict.json.")
@click.option("--dbname", default="polis_equiv_full", show_default=True,
              help="Throwaway database name STEM — suffixed _jitter1/_jitter2/_main.")
@click.option("--zid", type=int, default=pe.DEFAULT_ZID, show_default=True)
@click.option("--clj-env", default="clj-ref", show_default=True)
@click.option("--py-env", default="py-shadow", show_default=True)
@click.option("--poll-from-days-ago", type=float, default=10000, show_default=True)
@click.option("--wait-timeout", type=float, default=120.0, show_default=True,
              help="Seconds to wait for EACH math_env to reflect a batch "
                   "before giving up on it.")
@click.option("--restart-clj-at-seam/--no-restart-clj-at-seam", default=True, show_default=True,
              help="Also restart the clj container at the seam, for symmetry "
                   "with the py restart (spec §1's 'seam' bullet).")
@click.option("--wait-for-clj-poll-cycle/--no-wait-for-clj-poll-cycle", default=True, show_default=True,
              help="Quirk Q19 harness-level mitigation: block feeding batch 0 "
                   "until the clj runner's log shows evidence of a completed "
                   "poll cycle (see wait_for_first_poll_cycle's docstring). "
                   "Avoids a conv_man.clj actor-creation race that can "
                   "silently drop an early batch's votes.")
@click.option("--poll-cycle-gate-timeout", type=float, default=60.0, show_default=True,
              help="Seconds to wait for the poll-cycle gate signal before "
                   "aborting (only used when --wait-for-clj-poll-cycle).")
def full_run(dataset, admin_url, cuts, seam_after, out_root, dbname, zid, clj_env, py_env,
             poll_from_days_ago, wait_timeout, restart_clj_at_seam,
             wait_for_clj_poll_cycle, poll_cycle_gate_timeout):
    """Stage D full protocol orchestration (spec §2/§3): (a) clj-ref run 1,
    (b) fresh DB + clj-ref run 2 -> self-jitter envelope, (c) fresh DB +
    clj-ref/py-shadow paired run with a restart seam, (d)/(e) envelope-aware
    compare + verdict JSON + a terse (<=40-line) stdout summary.

    REQUIRES live Postgres + the ``clojure`` CLI — fails fast with a clear
    message when either is unreachable (see ``preflight_check``)."""
    default_cuts, default_seam = pe.default_full_run_schedule(dataset)
    cut_slots = [int(c) for c in cuts.split(",") if c.strip()] if cuts else default_cuts
    resolved_seam = seam_after if seam_after is not None else default_seam

    config = pe.FullRunConfig(
        dataset=dataset, admin_url=admin_url, out_root=str(out_root),
        cuts=tuple(cut_slots), seam_after=resolved_seam, dbname=dbname, zid=zid,
        clj_env=clj_env, py_env=py_env,
        poll_from_days_ago=poll_from_days_ago, wait_timeout=wait_timeout,
        restart_clj_at_seam=restart_clj_at_seam,
        wait_for_clj_poll_cycle=wait_for_clj_poll_cycle,
        poll_cycle_gate_timeout=poll_cycle_gate_timeout,
    )
    try:
        verdict = pe.run_full_equiv_protocol(config)
    except pe.PollerEquivStreamError as exc:
        click.echo(f"poller-equiv full-run: ABORTED\n{exc}", err=True)
        sys.exit(1)
    for line in pe.render_full_run_lines(verdict):
        click.echo(line)
    sys.exit(0 if verdict["overall_pass"] else 1)


def _run_and_stream(runner: Any, *, label: str) -> None:
    proc = runner.start()
    click.echo(f"[{label}] started pid={proc.pid} cmd={' '.join(runner.cmd)}", err=True)
    try:
        if proc.stdout is not None:
            for line in proc.stdout:
                click.echo(f"[{label}] {line}", nl=False)
        proc.wait()
    except KeyboardInterrupt:
        click.echo(f"\n[{label}] stopping…", err=True)
        runner.kill()
    sys.exit(proc.returncode or 0)


if __name__ == "__main__":
    cli()
