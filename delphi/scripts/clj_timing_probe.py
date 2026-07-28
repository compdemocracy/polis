#!/usr/bin/env python3
"""Clojure timing probe (Spec C) — empirical runtime-vs-size measurement for
the Clojure Mode A replay driver (``math/dev/replay.clj``), used to set the
size cutoff for a parity-certification battery.

For each requested vote-count N (capped at the dataset size), this:

  1. writes a truncated votes CSV (first N data rows, header preserved) to a
     temp dir,
  2. writes a single-cut vote-count schedule (``{"mode": "vote-count", "at":
     ["end"]}``, ``warm_start: chain``, ``schedule_id: probe-<N>``),
  3. runs the Clojure driver as a subprocess (``cwd=math/``) and records
     wall-clock seconds (subprocess only) and whether it produced a final
     step blob.

JVM startup is a fixed cost baked into every run; it is estimated from the
smallest size probed (compute time is assumed negligible there) and used as
the intercept ``a`` in a fitted ``runtime ~ a + b * N^k`` power-law model
(log-log least squares on the successful runs). The fit is then inverted to
recommend the largest N that stays within ``--budget-min`` minutes.

Usage (from delphi/)::

    uv run python scripts/clj_timing_probe.py probe \\
        --votes real_data/*-vw/*-votes.csv \\
        --sizes 500,1000,2000,4000 --budget-min 10
"""

from __future__ import annotations

import csv
import json
import math
import subprocess
import sys
import tempfile
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Sequence

import click
import numpy as np

# scripts/ -> delphi/ -> repo root
DELPHI_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = DELPHI_ROOT.parent
MATH_DIR = REPO_ROOT / "math"

DEFAULT_SIZES = "500,1000,2000,5000"
DEFAULT_BUDGET_MIN = 10.0
DEFAULT_TIMEOUT_SEC = 900.0  # generous: first clojure invocation downloads maven deps


# ---------------------------------------------------------------------------
# Data shapes.
# ---------------------------------------------------------------------------

@dataclass
class ProbeResult:
    size: int
    seconds: float | None
    ok: bool
    error: str | None = None


@dataclass
class FitResult:
    a_est: float | None
    b: float | None
    k: float | None
    n_fit_points: int


# ---------------------------------------------------------------------------
# Dataset discovery.
# ---------------------------------------------------------------------------

def default_votes_path() -> Path | None:
    """First ``delphi/real_data/*-vw/*-votes.csv`` found, sorted for determinism."""
    candidates = sorted(DELPHI_ROOT.glob("real_data/*-vw/*-votes.csv"))
    return candidates[0] if candidates else None


def infer_dataset_slug(votes_path: Path) -> str:
    """Dataset slug from the export dir name, e.g. ``r6vbnh...-vw`` -> ``vw``."""
    parent = votes_path.resolve().parent.name
    if "-" in parent:
        return parent.rsplit("-", 1)[-1]
    return parent


def count_data_rows(path: Path) -> int:
    """Number of data rows in an export votes CSV (excludes the header)."""
    with path.open("r", newline="") as f:
        reader = csv.reader(f)
        next(reader, None)
        return sum(1 for _ in reader)


# ---------------------------------------------------------------------------
# Size list parsing.
# ---------------------------------------------------------------------------

def parse_sizes(spec: str, n_max: int) -> list[int]:
    """Parse a comma-separated size list, capped at ``n_max``, deduped, ascending."""
    sizes: set[int] = set()
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        n = int(part)
        if n <= 0:
            raise ValueError(f"size must be positive, got {n}")
        sizes.add(min(n, n_max))
    return sorted(sizes)


# ---------------------------------------------------------------------------
# Per-size input generation.
# ---------------------------------------------------------------------------

def truncate_votes_csv(src: Path, n: int, dest: Path) -> int:
    """Write the header + first ``n`` data rows of ``src`` (FILE order, no
    resort) to ``dest``. Returns the number of data rows actually written
    (may be < n if the source has fewer rows)."""
    with src.open("r", newline="") as fsrc, dest.open("w", newline="") as fdst:
        reader = csv.reader(fsrc)
        writer = csv.writer(fdst)
        header = next(reader)
        writer.writerow(header)
        written = 0
        for row in reader:
            if written >= n:
                break
            writer.writerow(row)
            written += 1
    return written


def build_schedule(dataset: str, size: int) -> dict:
    """A single-cut vote-count schedule that closes the whole (truncated) file."""
    return {
        "dataset": dataset,
        "schedule_id": f"probe-{size}",
        "source": "votes-csv",
        "cuts": {"mode": "vote-count", "at": ["end"]},
        "moderation": "none",
        "clojure": {"warm_start": "chain"},
        "notes": f"clj_timing_probe size={size}",
    }


def write_schedule_json(schedule: dict, dest: Path) -> None:
    dest.write_text(json.dumps(schedule))


def find_final_blob(out_dir: Path) -> Path | None:
    """Last ``clj/step-*.blob.json`` under ``out_dir``, or None if absent."""
    clj_dir = out_dir / "clj"
    if not clj_dir.is_dir():
        return None
    blobs = sorted(clj_dir.glob("step-*.blob.json"))
    return blobs[-1] if blobs else None


# ---------------------------------------------------------------------------
# Subprocess invocation (patchable seam for tests).
# ---------------------------------------------------------------------------

def _invoke_clojure(cmd: list[str], cwd: Path, timeout: float) -> subprocess.CompletedProcess:
    return subprocess.run(
        cmd, cwd=str(cwd), capture_output=True, text=True, timeout=timeout
    )


InvokeFn = Callable[[list[str], Path, float], subprocess.CompletedProcess]


def run_probe_size(
    size: int,
    votes_src: Path,
    *,
    dataset: str,
    math_dir: Path,
    timeout: float,
    invoke: InvokeFn = _invoke_clojure,
) -> ProbeResult:
    """Truncate votes, write a schedule, run the clojure driver once, and
    record wall-clock seconds (subprocess only) + whether a final step blob
    was produced."""
    with tempfile.TemporaryDirectory(prefix=f"clj-timing-{size}-") as tmp:
        tmp_path = Path(tmp)
        votes_path = tmp_path / "votes.csv"
        truncate_votes_csv(votes_src, size, votes_path)

        schedule = build_schedule(dataset, size)
        schedule_path = tmp_path / "schedule.json"
        write_schedule_json(schedule, schedule_path)

        out_dir = tmp_path / "out"
        cmd = [
            "clojure", "-M:replay",
            "--schedule", str(schedule_path),
            "--votes", str(votes_path),
            "--out", str(out_dir),
        ]

        t0 = time.perf_counter()
        try:
            proc = invoke(cmd, math_dir, timeout)
        except subprocess.TimeoutExpired:
            elapsed = time.perf_counter() - t0
            return ProbeResult(
                size=size, seconds=elapsed, ok=False,
                error=f"timeout after {timeout}s",
            )
        except OSError as exc:
            elapsed = time.perf_counter() - t0
            return ProbeResult(size=size, seconds=elapsed, ok=False, error=str(exc))
        elapsed = time.perf_counter() - t0

        blob = find_final_blob(out_dir)
        if proc.returncode != 0:
            return ProbeResult(
                size=size, seconds=elapsed, ok=False,
                error=f"returncode={proc.returncode}: {proc.stderr[-500:]}",
            )
        if blob is None:
            return ProbeResult(
                size=size, seconds=elapsed, ok=False,
                error="no final step blob produced",
            )
        return ProbeResult(size=size, seconds=elapsed, ok=True, error=None)


def run_all(
    sizes: list[int],
    votes_src: Path,
    *,
    dataset: str,
    math_dir: Path,
    timeout: float,
    invoke: InvokeFn = _invoke_clojure,
) -> list[ProbeResult]:
    """Run ``run_probe_size`` for each size, in the order given (caller sorts)."""
    return [
        run_probe_size(n, votes_src, dataset=dataset, math_dir=math_dir,
                        timeout=timeout, invoke=invoke)
        for n in sizes
    ]


# ---------------------------------------------------------------------------
# Fit: runtime ~ a + b * N^k.
# ---------------------------------------------------------------------------

def fit_power_law(sizes: Sequence[int], seconds: Sequence[float]) -> FitResult:
    """Fit ``t ~ a_est + b * N^k`` on (sizes, seconds).

    ``a_est`` (the JVM-startup fixed cost) is taken directly from the
    smallest size's wall time — compute time is assumed negligible there.
    ``b`` and ``k`` come from a log-log least-squares fit of
    ``log(t - a_est) ~ k * log(N) + log(b)`` over the remaining points whose
    residual is strictly positive. Needs >= 2 such points (i.e. >= 3 sizes
    total) or the fit is left unset (``b = k = None``).
    """
    if not sizes:
        raise ValueError("fit_power_law requires at least one data point")
    if len(sizes) != len(seconds):
        raise ValueError("sizes and seconds must be the same length")

    pairs = sorted(zip(sizes, seconds), key=lambda p: p[0])
    sizes_sorted = [p[0] for p in pairs]
    seconds_sorted = [p[1] for p in pairs]
    a_est = float(seconds_sorted[0])

    xs: list[float] = []
    ys: list[float] = []
    for n, t in zip(sizes_sorted[1:], seconds_sorted[1:]):
        diff = t - a_est
        if diff > 1e-9 and n > 0:
            xs.append(math.log(n))
            ys.append(math.log(diff))

    if len(xs) < 2:
        return FitResult(a_est=a_est, b=None, k=None, n_fit_points=len(xs))

    slope, intercept = np.polyfit(xs, ys, 1)
    k = float(slope)
    b = float(math.exp(intercept))
    return FitResult(a_est=a_est, b=b, k=k, n_fit_points=len(xs))


def recommend_max_votes(fit: FitResult, budget_min: float) -> int | None:
    """Invert ``a_est + b * N^k = budget_min * 60`` for N. None if the fit is
    unavailable, non-increasing (k <= 0), or the fixed cost alone already
    exceeds the budget."""
    if fit.k is None or fit.b is None or fit.a_est is None:
        return None
    if fit.k <= 0 or fit.b <= 0:
        return None
    budget_s = budget_min * 60.0
    target = budget_s - fit.a_est
    if target <= 0:
        return None
    n = (target / fit.b) ** (1.0 / fit.k)
    if not math.isfinite(n) or n <= 0:
        return None
    return int(round(n))


# ---------------------------------------------------------------------------
# Reporting.
# ---------------------------------------------------------------------------

def format_report_lines(
    results: list[ProbeResult], fit: FitResult, recommended: int | None,
    budget_min: float,
) -> list[str]:
    """One line per size, then a fit line, then a recommendation line."""
    lines: list[str] = []
    for r in results:
        secs = "NA" if r.seconds is None else f"{r.seconds:.2f}"
        status = "ok" if r.ok else f"fail ({r.error})"
        lines.append(f"size={r.size} seconds={secs} status={status}")

    if fit.k is not None and fit.b is not None:
        lines.append(
            f"fit: a_est(jvm_startup)={fit.a_est:.2f}s b={fit.b:.3e} "
            f"k={fit.k:.3f} (n_fit_points={fit.n_fit_points})"
        )
    else:
        a_str = "NA" if fit.a_est is None else f"{fit.a_est:.2f}s"
        lines.append(f"fit: a_est(jvm_startup)={a_str} b=NA k=NA (insufficient data points)")

    if recommended is not None:
        lines.append(f"recommended_max_votes~={recommended} for budget={budget_min:g}min")
    else:
        lines.append(f"recommended_max_votes=NA for budget={budget_min:g}min (insufficient data)")

    return lines


def build_report(
    *, votes_path: Path, dataset: str, dataset_size: int, budget_min: float,
    timeout_sec: float, results: list[ProbeResult], fit: FitResult,
    recommended: int | None,
) -> dict:
    return {
        "votes_path": str(votes_path),
        "dataset": dataset,
        "dataset_size": dataset_size,
        "budget_min": budget_min,
        "timeout_sec": timeout_sec,
        "sizes": [r.size for r in results],
        "seconds": [r.seconds for r in results],
        "ok": [r.ok for r in results],
        "errors": [r.error for r in results],
        "fit": asdict(fit),
        "jvm_startup_estimate_sec": fit.a_est,
        "recommended_max_votes": recommended,
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }


# ---------------------------------------------------------------------------
# CLI.
# ---------------------------------------------------------------------------

@click.group()
def cli() -> None:
    """Clojure timing probe (Spec C) — runtime-vs-size measurement + fit."""


@cli.command()
@click.option(
    "--votes", "votes_path", type=click.Path(exists=True, path_type=Path), default=None,
    help="Votes CSV (default: first delphi/real_data/*-vw/*-votes.csv found).",
)
@click.option(
    "--sizes", default=DEFAULT_SIZES, show_default=True,
    help="Comma-separated vote-count sizes to probe (capped at dataset size).",
)
@click.option(
    "--out", "out_path", type=click.Path(path_type=Path), default=None,
    help="Output JSON path (default: real_data/.local/replays/timing_probe.json).",
)
@click.option(
    "--budget-min", type=float, default=DEFAULT_BUDGET_MIN, show_default=True,
    help="Target wall-clock budget (minutes) used for the N extrapolation.",
)
@click.option(
    "--timeout-sec", type=float, default=DEFAULT_TIMEOUT_SEC, show_default=True,
    help="Per-run subprocess timeout (generous: first clojure invocation "
         "downloads maven deps).",
)
@click.option(
    "--dataset", default=None,
    help="Dataset slug recorded in the schedule (default: inferred from --votes).",
)
def probe(votes_path, sizes, out_path, budget_min, timeout_sec, dataset) -> None:
    """Run the Clojure driver at increasing sizes and fit a runtime model."""
    if votes_path is None:
        votes_path = default_votes_path()
        if votes_path is None:
            raise click.UsageError(
                "no --votes given and no delphi/real_data/*-vw/*-votes.csv found"
            )
    votes_path = Path(votes_path)

    if dataset is None:
        dataset = infer_dataset_slug(votes_path)

    if out_path is None:
        out_path = DELPHI_ROOT / "real_data" / ".local" / "replays" / "timing_probe.json"
    out_path = Path(out_path)

    n_max = count_data_rows(votes_path)
    size_list = parse_sizes(sizes, n_max)
    if not size_list:
        raise click.UsageError("no sizes to probe")

    results = run_all(
        size_list, votes_path, dataset=dataset, math_dir=MATH_DIR, timeout=timeout_sec,
    )

    ok_sizes = [r.size for r in results if r.ok]
    ok_seconds = [r.seconds for r in results if r.ok]
    if ok_sizes:
        fit = fit_power_law(ok_sizes, ok_seconds)
    else:
        fit = FitResult(a_est=None, b=None, k=None, n_fit_points=0)

    recommended = recommend_max_votes(fit, budget_min)

    for line in format_report_lines(results, fit, recommended, budget_min):
        click.echo(line)

    report = build_report(
        votes_path=votes_path, dataset=dataset, dataset_size=n_max,
        budget_min=budget_min, timeout_sec=timeout_sec, results=results,
        fit=fit, recommended=recommended,
    )
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(report, indent=2))
    click.echo(f"report -> {out_path}", err=True)


if __name__ == "__main__":
    cli()
