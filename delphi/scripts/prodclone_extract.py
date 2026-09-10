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

from polismath.replay import fixture_bundle as fb
from polismath.replay import fixture_config as fc
from polismath.replay import fixture_extract as fx
from polismath.replay import fixture_survey as fs
from polismath.replay.fixture_selection import validate_report
from polismath.replay import prodclone as pc
from polismath.replay.real_data import REAL_DATA_ROOT

DEFAULT_SURVEY_OUT = REAL_DATA_ROOT / ".local" / "prodclone_survey.json"


@click.group()
def cli() -> None:
    """Prodclone extractor — survey + extract feature-classified conversations."""


def _print_survey(result: dict) -> None:
    """Print COUNTS only.

    Raw zids never reach stdout (P-022 A: ".gitignore protects neither logs nor
    uploaded artifacts"). The identities live only in the survey JSON under
    ``real_data/.local/``; a reviewer who needs them opens that file
    deliberately.
    """
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


# ---------------------------------------------------------------------------
# P-022 A: config-driven certification extraction.
# ---------------------------------------------------------------------------


@cli.command("select-representative")
@click.option("--database-url", required=True)
@click.option("--from-config", "config_path", type=click.Path(path_type=Path), required=True)
@click.option("--out", "out_path", type=click.Path(path_type=Path), required=True,
              help="Box-only provenance file, beneath real_data/.local/; never a payload member.")
@click.option("--snapshot-id", default=None)
@click.option("--writers-disabled", is_flag=True, default=False)
def select_representative(database_url: str, config_path: Path, out_path: Path,
                          snapshot_id: str | None, writers_disabled: bool) -> None:
    """Emit only seed/bucket counts/selected sizes; retain identities in the box.

    Selection-only: no new payload, recipe, schedule or battery is admitted.
    Exit 2 with an empty census report when the snapshot has no conversations.
    """
    try:
        config = fc.load_config(config_path)
        if fc.representative_seed(config) is None:
            raise ValueError("SELECTION_NOT_CONFIGURED")
        target = out_path.resolve()
        parts = target.parts
        if ".local" not in parts:
            raise ValueError("PRIVATE_PATH_REQUIRED")
        guard = Path(*parts[:parts.index(".local")])
        target = pc.assert_under_local(target, guard)
        conn = psycopg2.connect(database_url)
        try:
            result = fx.select_representative_from_config(
                conn, config=config, snapshot_id=snapshot_id,
                writers_disabled=writers_disabled)
        finally:
            conn.close()
        validate_report(result["report"])
        target.parent.mkdir(parents=True, exist_ok=True)
        fb.os_umask_safe_write(target, fb.canonical_json(result))
    except Exception:
        # Connection/config/path/raw database errors can contain private data.
        raise click.ClickException("REPRESENTATIVE_SELECTION_FAILED") from None
    click.echo(fb.canonical_json(result["report"]).decode().strip())
    if result["report"]["bucket_counts"]["population"] == 0:
        raise click.exceptions.Exit(2)


@cli.command("from-config")
@click.option("--database-url", required=True,
              help="Postgres connection URL for the prodclone database.")
@click.option("--from-config", "config_path", type=click.Path(path_type=Path),
              default=None,
              help=f"Selection config (default: {fc.DEFAULT_CONFIG_PATH}).")
@click.option("--out", "out_dir", type=click.Path(path_type=Path), required=True,
              help="Extraction target. MUST be under a real_data root's .local/ "
                   "(e.g. real_data/.local/<opaque-dir>); the path guard rejects "
                   "anything else.")
@click.option("--snapshot-id", default=None,
              help="A pg_export_snapshot() id held open by the orchestrator, so "
                   "survey and extraction share one snapshot across sessions.")
@click.option("--writers-disabled", is_flag=True, default=False,
              help="Record that the clone additionally had all writers disabled. "
                   "Does not relax the isolation level.")
@click.option("--reuse-dirs", type=click.Path(path_type=Path), default=None,
              help="A previous manifest (or dir_names JSON) whose opaque directory "
                   "assignment is reused, for a byte-comparable repeat extraction.")
@click.option("--accept-public-fixture", multiple=True,
              help="Role slug whose deterministic public fixture replacement is EXPLICITLY "
                   "approved because production supplied no candidate. Repeatable.")
@click.option("--no-generated", is_flag=True, default=False,
              help="Skip the generated boundary cases (production roles only).")
@click.option("--include-heavy", is_flag=True, default=False,
              help="Materialise the heavy generated scale control as well.")
def from_config(database_url: str, config_path: Path | None, out_dir: Path,
                snapshot_id: str | None, writers_disabled: bool,
                reuse_dirs: Path | None, accept_public_fixture: tuple[str, ...],
                no_generated: bool, include_heavy: bool) -> None:
    """Survey, select and extract EVERY configured role in one repeatable-read
    transaction, into opaque fixture directories under OUT.

    Prints counts only — no zid, no report id, no directory-to-role mapping.
    """
    try:
        config = fc.load_config(config_path)
    except Exception:
        raise click.ClickException("INVALID_SELECTION_CONFIG") from None
    try:
        _extract_config(config, database_url, out_dir, snapshot_id, writers_disabled,
                        reuse_dirs, accept_public_fixture, no_generated, include_heavy)
    except Exception:
        if "representative_selection" in config:
            raise click.ClickException("REPRESENTATIVE_EXTRACTION_FAILED") from None
        raise


def _extract_config(config: dict, database_url: str, out_dir: Path,
                    snapshot_id: str | None, writers_disabled: bool,
                    reuse_dirs: Path | None, accept_public_fixture: tuple[str, ...],
                    no_generated: bool, include_heavy: bool) -> None:
    payload_root = Path(out_dir).resolve()
    # Derive the real_data root from the caller's path so assert_under_local can
    # re-check every single write. --out may be "<root>/.local" itself or a
    # staging directory beneath it ("<root>/.local/<opaque-bundle-dir>").
    parts = payload_root.parts
    if ".local" not in parts:
        raise click.ClickException(
            f"--out must live under a real_data root's .local/ (got {payload_root})")
    guard_root = Path(*parts[: parts.index(".local")])
    payload_root.mkdir(parents=True, exist_ok=True)
    pc.assert_under_local(payload_root, guard_root)

    dir_names: dict[str, str] = {}
    if reuse_dirs is not None:
        loaded = json.loads(Path(reuse_dirs).read_text())
        if "roles" in loaded:  # a manifest
            dir_names = {r["slug"]: r["dir"] for r in loaded["roles"] if r.get("dir")}
        else:
            dir_names = dict(loaded)

    try:
        conn = psycopg2.connect(database_url)
    except Exception:
        if "representative_selection" in config:
            raise click.ClickException("REPRESENTATIVE_EXTRACTION_FAILED") from None
        raise
    try:
        result = fx.extract_from_config(
            conn, config=config, payload_root=payload_root, guard_root=guard_root,
            snapshot_id=snapshot_id,
            writers_disabled=writers_disabled, dir_names=dir_names,
            accept_public_fixture=accept_public_fixture,
            include_generated=not no_generated, include_heavy=include_heavy,
        )
    except Exception as exc:
        if "representative_selection" in config:
            raise click.ClickException("REPRESENTATIVE_EXTRACTION_FAILED") from None
        if isinstance(exc, fs.RoleUnsatisfied):
            raise click.ClickException(str(exc)) from exc
        raise
    finally:
        conn.close()

    if "representative_selection" in config:
        try:
            if "representative_provenance" not in result:
                raise ValueError("MISSING_SELECTION_PROVENANCE")
            validate_report(result["representative_selection"])
        except Exception:
            raise click.ClickException("REPRESENTATIVE_REPORT_INVALID") from None

    # Side-car artefacts live BESIDE the payload, never inside it: the payload
    # tree is what gets hashed into the bundle, and the survey/provenance files
    # carry zids and must not be published with it.
    sidecar = payload_root.parent / f"{payload_root.name}.private"
    sidecar.mkdir(parents=True, exist_ok=True)
    survey_path = pc.assert_under_local(sidecar / "certify_survey.json", guard_root)
    fb.os_umask_safe_write(survey_path, fb.canonical_json(result["survey"]))
    provenance_path = pc.assert_under_local(
        sidecar / "certify_provenance_rows.json", guard_root)
    fb.os_umask_safe_write(provenance_path, fb.canonical_json(result["provenance_rows"]))
    extract_path = pc.assert_under_local(sidecar / "certify_extract.json", guard_root)
    fb.os_umask_safe_write(extract_path, fb.canonical_json({
        k: v for k, v in result.items() if k not in ("survey", "provenance_rows", "representative_provenance")}))

    if "representative_selection" in result:
        representative_path = pc.assert_under_local(
            sidecar / "representative_selection.private.json", guard_root)
        fb.os_umask_safe_write(representative_path, fb.canonical_json({
            "report": result["representative_selection"],
            "provenance_rows": result["representative_provenance"],
            "transaction_guarantee": result["transaction_guarantee"],
        }))
        click.echo(fb.canonical_json(result["representative_selection"]).decode().strip())
        return

    click.echo(
        f"transaction: {result['transaction_guarantee']['isolation_level']} / "
        f"{result['transaction_guarantee']['access_mode']}"
        f" (snapshot {'imported' if snapshot_id else 'session-local'})")
    click.echo(f"tie order: {result['tie_key']['guarantee']} "
               f"via {result['tie_key']['method']}")
    click.echo(f"surveyed {result['survey']['n_conversations']} conversation(s)")
    for role in result["roles"]:
        counts = role.get("counts", {})
        click.echo(
            f"[{role['slug']}] source={role['source']} "
            f"candidates={role['n_candidates']} "
            f"events={counts.get('events', 0)} "
            f"votes={counts.get('vote_events', 0)} "
            f"comments={counts.get('comment_events', 0)} "
            f"ptpts={counts.get('participants', 0)}")
    materialised = [g for g in result["generated"] if g.get("dir")]
    click.echo(f"generated: {len(materialised)} fixture dir(s) materialised, "
               f"{len(result['generated']) - len(materialised)} declared only")
    click.echo(f"private survey -> {survey_path}")
    click.echo("role->zid mapping stays in certify_provenance_rows.json (restricted)")


if __name__ == "__main__":
    cli()
