"""CLI for the cut-cadence experiment suite.

Reproduce the committed results (from ``delphi/``)::

    uv run python -m polismath.replay.experiments.run_cadence --exp all \
        --out polismath/replay/experiments/results_cadence.json \
        --md polismath/replay/experiments/RESULTS.md --jobs 6

``--exp`` selects one family (``fixed``, ``poisson``, ``time``,
``bursty``) or ``all``. ``--jobs`` parallelizes across runs (each run is
independently seeded, so results are identical at any parallelism).
"""

import argparse
import datetime
import json
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

from polismath.replay.experiments import cadence


def run_spec(spec: dict) -> dict:
    """Build one case, run inference + metrics, and time it."""
    t0 = time.perf_counter()
    case = cadence.build_case(
        spec["family"], spec["era"], spec["N"], spec["seed"],
        n_votes=spec["n_votes"],
    )
    out = cadence.run_case(case)
    out["runtime_s"] = round(time.perf_counter() - t0, 2)
    return out


def _fmt(x, nd=1):
    return "-" if x is None else f"{x:.{nd}f}"


def _cell_rows(aggregates: list[dict]) -> list[dict]:
    return aggregates  # already sorted by aggregate()


def render_markdown(results: dict) -> str:
    """Compact summary tables (seed-median aggregates) + reproduce commands."""
    meta = results["meta"]
    aggs = _cell_rows(results["aggregates"])
    lines: list[str] = []
    lines.append("# Cut-cadence experiment results")
    lines.append("")
    lines.append(
        f"Generated {meta['generated_at']} by `{meta['command']}` "
        f"(grid: eras {meta['eras']}, N {meta['ns']}, seeds {meta['seeds']}, "
        f"{meta['n_votes']} votes, {meta['n_samples']} posterior samples/run; "
        "all runs count-constrained t_range=(T,T)). "
        "Cells are medians across seeds."
    )
    lines.append("")
    lines.append("Reproduce per experiment family (from `delphi/`):")
    lines.append("")
    lines.append("```bash")
    for family in cadence.FAMILIES:
        lines.append(
            "uv run python -m polismath.replay.experiments.run_cadence "
            f"--exp {family} --out /tmp/results_{family}.json"
        )
    lines.append("# full committed grid:")
    lines.append(
        "uv run python -m polismath.replay.experiments.run_cadence --exp all \\"
    )
    lines.append(
        "    --out polismath/replay/experiments/results_cadence.json \\"
    )
    lines.append(
        "    --md polismath/replay/experiments/RESULTS.md --jobs 6"
    )
    lines.append("```")

    lines.append("")
    lines.append("## Posterior localization and coverage")
    lines.append("")
    lines.append(
        "| family | era | N | cuts | loc med (votes) | loc p90 (votes) "
        "| loc med (s) | loc p90 (s) | cov@3v | cov@10s |"
    )
    lines.append("|---|---|---|---|---|---|---|---|---|---|")
    for a in aggs:
        lines.append(
            f"| {a['family']} | {a['era']} | {a['N'] if a['N'] else '-'} "
            f"| {a['n_cuts']:.0f} "
            f"| {_fmt(a['loc_med_votes'])} | {_fmt(a['loc_p90_votes'])} "
            f"| {_fmt(a['loc_med_s'])} | {_fmt(a['loc_p90_s'])} "
            f"| {_fmt(a['cov_3votes'], 2)} | {_fmt(a['cov_10s'], 2)} |"
        )

    lines.append("")
    lines.append("## Estimator comparison — matched median displacement")
    lines.append("")
    lines.append(
        "Optimal 1-1 assignment of estimate to truth; three point "
        "estimates: MAP schedule, per-index posterior median, single "
        "posterior draw."
    )
    lines.append("")
    lines.append(
        "| family | era | N | MAP (votes) | median (votes) | draw (votes) "
        "| MAP (s) | median (s) | draw (s) |"
    )
    lines.append("|---|---|---|---|---|---|---|---|---|")
    for a in aggs:
        lines.append(
            f"| {a['family']} | {a['era']} | {a['N'] if a['N'] else '-'} "
            f"| {_fmt(a['disp_map_votes'])} | {_fmt(a['disp_median_votes'])} "
            f"| {_fmt(a['disp_sample1_votes'])} "
            f"| {_fmt(a['disp_map_s'])} | {_fmt(a['disp_median_s'])} "
            f"| {_fmt(a['disp_sample1_s'])} |"
        )

    lines.append("")
    lines.append("## Posterior concentration")
    lines.append("")
    lines.append(
        "| family | era | N | MAP mass | distinct schedules (of "
        f"{meta['n_samples']}) | median needed sorting |"
    )
    lines.append("|---|---|---|---|---|---|")
    for a in aggs:
        lines.append(
            f"| {a['family']} | {a['era']} | {a['N'] if a['N'] else '-'} "
            f"| {a['map_mass']:.2e} | {a['distinct_schedules']:.0f} "
            f"| {'yes' if a['median_sort_needed_any'] else 'no'} |"
        )
    lines.append("")
    return "\n".join(lines)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="run_cadence", description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--exp", default="all", choices=("all",) + cadence.FAMILIES)
    parser.add_argument("--out", required=True, help="output JSON path")
    parser.add_argument("--md", default=None, help="optional markdown summary path")
    parser.add_argument("--seeds", default="0,1,2", help="comma-separated seeds")
    parser.add_argument("--Ns", default="5,10,50", help="comma-separated N grid")
    parser.add_argument("--n-votes", type=int, default=cadence.N_VOTES)
    parser.add_argument("--jobs", type=int, default=1, help="parallel workers")
    args = parser.parse_args(argv)

    seeds = tuple(int(s) for s in args.seeds.split(","))
    ns = tuple(int(s) for s in args.Ns.split(","))
    specs = cadence.grid_specs(
        exp=args.exp, ns=ns, seeds=seeds, n_votes=args.n_votes
    )

    runs: list = [None] * len(specs)
    t0 = time.perf_counter()
    if args.jobs > 1:
        with ProcessPoolExecutor(max_workers=args.jobs) as ex:
            futures = {ex.submit(run_spec, s): i for i, s in enumerate(specs)}
            for done, fut in enumerate(as_completed(futures), start=1):
                i = futures[fut]
                runs[i] = fut.result()
                r = runs[i]
                print(
                    f"[{done}/{len(specs)}] {r['family']} era={r['era']} "
                    f"N={r['N']} seed={r['seed']} cuts={r['n_cuts']} "
                    f"loc_med={r['loc_med_votes']:.1f}v/{r['loc_med_s']:.1f}s "
                    f"({r['runtime_s']}s)",
                    flush=True,
                )
    else:
        for i, s in enumerate(specs, start=1):
            runs[i - 1] = run_spec(s)
            r = runs[i - 1]
            print(
                f"[{i}/{len(specs)}] {r['family']} era={r['era']} N={r['N']} "
                f"seed={r['seed']} cuts={r['n_cuts']} "
                f"loc_med={r['loc_med_votes']:.1f}v/{r['loc_med_s']:.1f}s "
                f"({r['runtime_s']}s)",
                flush=True,
            )

    results = {
        "meta": {
            "generated_at": datetime.datetime.now(datetime.timezone.utc)
            .strftime("%Y-%m-%d %H:%M UTC"),
            "command": "uv run python -m polismath.replay.experiments.run_cadence "
            + " ".join(argv if argv is not None else sys.argv[1:]),
            "exp": args.exp,
            "eras": list(cadence.GRID_ERAS),
            "ns": list(ns),
            "seeds": list(seeds),
            "n_votes": args.n_votes,
            "n_samples": cadence.N_SAMPLES,
            "sample_seed": cadence.SAMPLE_SEED,
            "total_runtime_s": round(time.perf_counter() - t0, 1),
        },
        "runs": runs,
        "aggregates": cadence.aggregate(runs),
    }
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(results, indent=1, sort_keys=True) + "\n")
    print(f"wrote {out_path}")
    if args.md:
        md_path = Path(args.md)
        md_path.parent.mkdir(parents=True, exist_ok=True)
        md_path.write_text(render_markdown(results))
        print(f"wrote {md_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
