#!/usr/bin/env python3
"""Shadow-soak comparer CLI — Clojure→Python math cutover Step #1.

Compares the Clojure engine's live math rows (``math_env='prod'``) against
the Python poller's shadow rows (``math_env='python'``) in the SAME
database, with the same acceptance surface as the certify battery /
poller-equivalence harness. Read-only. See
``polismath/replay/shadow_compare.py`` (the logic + full semantics) and
``delphi/docs/CUTOVER_RUNBOOK.md`` "Step 1 — shadow in prod".

Typical soak usage (math host, or anywhere with DB access)::

    cd delphi && uv run python scripts/shadow_compare.py \\
        --min-matches 5 --json-out scratch/shadow_report.json

Exit codes (the Step #2 gate): 0 = clean (no unexpected divergence AND
``--min-matches`` full-MATCH zids demonstrated); 1 = at least one
UNEXPECTED divergence (a small/mid conv differs while in sync — investigate
before any flip); 2 = clean so far but coverage not yet demonstrated
(fewer than ``--min-matches`` matches — keep soaking, re-run).

Large convs (>10k ptpts or >5k comments) are reported as
``large-conv-q10`` and never fail the run: the Clojure baseline there is
unseeded-random (Q10, CLOJURE_QUIRKS.md) — expected, not a defect.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import click
import sqlalchemy as sa

from polismath.replay import shadow_compare as sc
from polismath.replay.poller_equiv import _url_with_scheme


def _parse_zids(value: str | None) -> list[int] | None:
    if not value:
        return None
    try:
        return [int(z) for z in value.split(",") if z.strip()]
    except ValueError:
        raise click.BadParameter(
            f"--zids must be a comma-separated list of integers, got {value!r}"
        )


@click.command()
@click.option(
    "--database-url",
    envvar="DATABASE_URL",
    required=True,
    help="Postgres connection URL (defaults to $DATABASE_URL).",
)
@click.option(
    "--clj-env", default="prod", show_default=True,
    help="math_env the Clojure engine writes under.",
)
@click.option(
    "--py-env", default="python", show_default=True,
    help="math_env the Python shadow poller writes under (MATH_PYTHON_ENV).",
)
@click.option(
    "--zids", default=None, callback=lambda ctx, param, value: _parse_zids(value),
    help="Comma-separated zids to compare (default: discover every zid with "
         "a math_main row in either env, most recently modified first).",
)
@click.option(
    "--limit", type=int, default=50, show_default=True,
    help="Max zids when discovering (ignored with --zids).",
)
@click.option(
    "--min-matches", type=int, default=0, show_default=True,
    help="Fail (exit 2) unless at least this many zids fully MATCH — makes "
         "the runbook's 'spot-compare N active zids' gate mechanical.",
)
@click.option(
    "--json-out", type=click.Path(dir_okay=False, path_type=Path), default=None,
    help="Also write the full report as JSON.",
)
def main(database_url, clj_env, py_env, zids, limit, min_matches, json_out):
    """One read-only compare pass over live clj-vs-python shadow rows."""
    engine = sa.create_engine(_url_with_scheme(database_url, "postgresql+psycopg2"))
    with engine.connect() as conn:
        report = sc.run(
            conn,
            math_envs=(clj_env, py_env),
            zids=zids,
            limit=limit,
            min_matches=min_matches,
        )
    for line in sc.render_lines(report):
        click.echo(line)
    if json_out is not None:
        json_out.write_text(json.dumps(report, indent=2, default=str))
        click.echo(f"full report: {json_out}")
    sys.exit(report["summary"]["exit_code"])


if __name__ == "__main__":
    main()
