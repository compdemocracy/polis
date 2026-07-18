#!/usr/bin/env python3
"""Prodclone extractor CLI — pull feature-classified real conversations out of
a "prodclone" Postgres database (a clone of the production polis DB) into the
replay-dataset export format, for Clojure↔Python math parity certification.

See ``delphi/polismath/replay/prodclone.py`` for the pure building blocks
(SQL builders, feature classifiers, CSV formatters, slug minting, the
path-safety guard). This script is a thin click CLI wiring those together
with a live psycopg2 connection — mirrors the style of
``scripts/replay_driver.py``.

CRITICAL privacy rules — see the pure module's docstring and
delphi/tests/test_prodclone_extract.py for the full policy. In short:
output goes ONLY under ``<out-root>/.local/``, slugs are neutral, the
directory prefix is a salted hash (never the real report id), the slug→zid
mapping lives ONLY in prodclone_map.json, and comment text is redacted.

Usage (from delphi/)::

    # Survey the prodclone DB for candidate conversations per feature class:
    uv run python scripts/prodclone_extract.py survey \\
        --database-url postgresql://user:pass@host:5432/prodclone

    # Extract one conversation for a feature class:
    uv run python scripts/prodclone_extract.py extract \\
        --database-url postgresql://user:pass@host:5432/prodclone \\
        --zid 12345 --feature modheavy
"""

from __future__ import annotations

import json
from pathlib import Path

import click
import psycopg2

from polismath.replay import prodclone as pc
from polismath.replay.real_data import REAL_DATA_ROOT

DEFAULT_SURVEY_OUT = REAL_DATA_ROOT / ".local" / "prodclone_survey.json"


@click.group()
def cli() -> None:
    """Prodclone extractor — survey + extract feature-classified conversations."""


def _print_survey(result: dict) -> None:
    sc = result["size_classes"]
    counts = sc["counts"]
    click.echo(
        f"size classes (n={result['n_conversations']}): "
        f"small(<={sc['small_max_votes']} votes)={counts['small']}  "
        f"medium(<={sc['medium_max_votes']} votes)={counts['medium']}  "
        f"large={counts['large']}"
    )
    for feature in pc.FEATURES:
        candidates = result["candidates"][feature]
        click.echo(f"[{feature}] {len(candidates)} candidate(s)")
        for c in candidates:
            click.echo(
                f"  zid={c['zid']} n_votes={c['n_votes']} n_ptpts={c['n_ptpts']} "
                f"n_comments={c['n_comments']} metric={c['metric']:.3f}"
            )


@cli.command()
@click.option("--database-url", required=True,
              help="Postgres connection URL for the prodclone database.")
@click.option("--limit", type=int, default=3, show_default=True,
              help="Max candidates listed per feature class.")
@click.option("--out", "out_path", type=click.Path(path_type=Path), default=None,
              help=f"Full survey JSON path (default: {DEFAULT_SURVEY_OUT}).")
def survey(database_url: str, limit: int, out_path: Path | None) -> None:
    """Survey the prodclone DB: candidate conversations per feature class,
    no topics/text — just zid, n_votes, n_ptpts, n_comments, metric."""
    out_path = out_path or DEFAULT_SURVEY_OUT
    # The survey JSON contains raw zids — same containment rule as extract:
    # refuse any destination outside real_data/.local/ (review finding,
    # 2026-07-22: --out could previously bypass the guard).
    out_path = pc.assert_under_local(out_path, REAL_DATA_ROOT)
    conn = psycopg2.connect(database_url)
    try:
        result = pc.run_survey(conn, limit=limit)
    finally:
        conn.close()

    _print_survey(result)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
    click.echo(f"full survey -> {out_path}")


@cli.command()
@click.option("--database-url", required=True,
              help="Postgres connection URL for the prodclone database.")
@click.option("--zid", type=int, required=True, help="Conversation zid to extract.")
@click.option("--feature", type=click.Choice(pc.FEATURES), required=True,
              help="Feature class this extraction is for (mints the next free slug).")
@click.option("--out-root", type=click.Path(path_type=Path), default=None,
              help="real_data root — a .local/ subdir is created beneath it "
                   f"(default: {REAL_DATA_ROOT}).")
def extract(database_url: str, zid: int, feature: str, out_root: Path | None) -> None:
    """Mint the next free slug for FEATURE and export ZID's votes (full
    revote history) + comments (text redacted) into
    <out-root>/.local/<fake-prefix>-<slug>/, then merge-update
    prodclone_map.json."""
    out_root = out_root or REAL_DATA_ROOT
    conn = psycopg2.connect(database_url)
    try:
        result = pc.run_extract(conn, zid=zid, feature=feature, out_root=out_root)
    finally:
        conn.close()

    entry = result["entry"]
    click.echo(f"slug={result['slug']}")
    click.echo(
        f"wrote {entry['n_votes']} votes, {entry['n_comments']} comments -> {result['dir']}"
    )
    click.echo(f"prodclone_map.json updated ({out_root / '.local' / 'prodclone_map.json'})")


if __name__ == "__main__":
    cli()
