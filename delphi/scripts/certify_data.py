#!/usr/bin/env python3
"""Private immutable certification-fixture bundles: survey, push, pull, verify.

P-022 section A. The bundle lives at
``s3://polis-certification-data/<bundle-id>/`` (override with ``--store``);
``polismath.replay.fixture_bundle`` holds the mechanics and the full layout.

Commands (run from ``delphi/``)::

    # 1. Survey a restored prodclone WITHOUT extracting anything. Prints
    #    coverage counts only; the private survey (which holds zids) is written
    #    under real_data/.local/.
    uv run python scripts/certify_data.py survey \\
        --database-url postgresql://... --out real_data/.local/survey-run

    # 2. Extract (see scripts/prodclone_extract.py from-config), then publish:
    uv run python scripts/certify_data.py push \\
        --bundle-id pcb-2026-09-07-a \\
        --payload real_data/.local/bundle-staging \\
        --extract-json real_data/.local/bundle-staging.private/certify_extract.json \\
        --provenance-json real_data/.local/bundle-staging.private/certify_provenance_rows.json \\
        --owner 'polis-certification' \\
        --store s3://polis-certification-data

    # 3. A SECOND operator, empty workspace, no other input:
    uv run python scripts/certify_data.py pull \\
        --bundle-id pcb-2026-09-07-a --dest /tmp/bundle \\
        --store s3://polis-certification-data

    #    Identities (SEPARATE IAM role; the payload reader is denied this):
    uv run python scripts/certify_data.py pull \\
        --bundle-id pcb-2026-09-07-a --dest /tmp/bundle-prov \\
        --with-provenance --provenance-role polis-certification-provenance-reader

    # 4. Re-verify a local tree at any time:
    uv run python scripts/certify_data.py verify \\
        --payload /tmp/bundle/payload --manifest /tmp/bundle/manifest.json

    # 5. Render the PUBLIC pin block for delphi/docs/CERTIFICATION.md:
    uv run python scripts/certify_data.py pin --manifest /tmp/bundle/manifest.json

Privacy. ``survey``/``push`` print COUNTS ONLY: no zid, no report id, no
role -> directory mapping. The role -> zid mapping is published as a SEPARATE
restricted object and is never written to stdout. ``pin`` emits only bundle
id, root digest, policy/schedule hashes, role names and coverage.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import click

from polismath.replay import fixture_bundle as fb
from polismath.replay import fixture_config as fc
from polismath.replay import fixture_survey as fs
from polismath.replay import prodclone as pc

REPO_ROOT = Path(__file__).resolve().parents[2]
SCHEDULES_DIR = Path(__file__).resolve().parent / "schedules"


def _store_from_url(url: str) -> fb.ObjectStore:
    """``s3://bucket[/prefix]`` -> :class:`S3Store`; anything else is a local
    directory (:class:`LocalStore`), which is also what the test suite and an
    air-gapped orchestrator use."""
    if url.startswith("s3://"):
        rest = url[len("s3://"):]
        bucket, _, prefix = rest.partition("/")
        return fb.S3Store(bucket=bucket, prefix=prefix)
    return fb.LocalStore(Path(url))


def _guard_root_for(path: Path) -> Path:
    parts = path.resolve().parts
    if ".local" not in parts:
        raise click.ClickException(
            f"{path} must live under a real_data root's .local/ subtree")
    return Path(*parts[: parts.index(".local")])


@click.group()
def cli() -> None:
    """Certification fixture bundle: survey, push, pull, verify, pin."""


# ---------------------------------------------------------------------------
# survey
# ---------------------------------------------------------------------------


@cli.command()
@click.option("--database-url", required=True)
@click.option("--config", "config_path", type=click.Path(path_type=Path), default=None,
              help=f"Selection config (default: {fc.DEFAULT_CONFIG_PATH}).")
@click.option("--out", "out_dir", type=click.Path(path_type=Path), required=True,
              help="PRIVATE output directory; must be under a real_data .local/.")
@click.option("--snapshot-id", default=None,
              help="pg_export_snapshot() id to pin this transaction to.")
@click.option("--writers-disabled", is_flag=True, default=False)
@click.option("--redacted-out", type=click.Path(path_type=Path), default=None,
              help="Optional path for the identity-free distribution summary "
                   "(safe to attach to a rule-revision proposal).")
def survey(database_url: str, config_path: Path | None, out_dir: Path,
           snapshot_id: str | None, writers_disabled: bool,
           redacted_out: Path | None) -> None:
    """Compute the committed metrics for EVERY conversation in one read-only
    repeatable-read transaction and report per-role candidate COUNTS.

    Does not extract and does not select a bundle; use it to check coverage
    before committing to an extraction, or to propose a reviewed rule revision.
    """
    import psycopg2

    config = fc.load_config(config_path)
    out_dir = Path(out_dir).resolve()
    guard_root = _guard_root_for(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    pc.assert_under_local(out_dir, guard_root)

    conn = psycopg2.connect(database_url)
    try:
        guarantee = fs.open_readonly_repeatable_read(
            conn, snapshot_id=snapshot_id, writers_disabled=writers_disabled)
        rows = fs.fetch_metrics(conn)
        conn.rollback()
        marker = fs.schema_migration_version(conn)
    finally:
        conn.close()

    result = fs.build_survey(rows, guarantee, snapshot_id=snapshot_id,
                             schema_version_marker=marker)
    coverage = fs.coverage_report(config, rows)

    survey_path = pc.assert_under_local(out_dir / "certify_survey.json", guard_root)
    fb.os_umask_safe_write(survey_path, fb.canonical_json(result))
    coverage_path = pc.assert_under_local(out_dir / "certify_coverage.json", guard_root)
    fb.os_umask_safe_write(coverage_path, fb.canonical_json(coverage))

    click.echo(f"transaction: {guarantee['isolation_level']} / {guarantee['access_mode']}"
               f"  writers_disabled={guarantee['writers_disabled_on_clone']}")
    click.echo(f"schema migration marker: {marker}")
    click.echo(f"surveyed {result['n_conversations']} conversation(s)")
    unsatisfied = []
    for slug, info in coverage.items():
        state = "OK " if info["satisfied"] else "MISSING"
        if not info["satisfied"]:
            unsatisfied.append(info["role"])
        click.echo(f"  {state} {slug:28s} rank={info['rank']:<3d} "
                   f"candidates={info['n_candidates']}")
    click.echo(f"private survey -> {survey_path}")
    if redacted_out is not None:
        Path(redacted_out).write_bytes(fb.canonical_json(fs.redact_survey(result)))
        click.echo(f"redacted summary -> {redacted_out}")
    if unsatisfied:
        raise click.ClickException(
            "unsatisfied role(s), bundle construction would FAIL: "
            + ", ".join(unsatisfied))


# ---------------------------------------------------------------------------
# push
# ---------------------------------------------------------------------------


@cli.command()
@click.option("--bundle-id", required=True,
              help="Immutable logical bundle id. Republishing it with different "
                   "bytes is REFUSED; publish a new id instead.")
@click.option("--payload", type=click.Path(path_type=Path), required=True,
              help="Extraction payload directory (the tree that gets hashed).")
@click.option("--extract-json", type=click.Path(path_type=Path), required=True,
              help="certify_extract.json written by prodclone_extract from-config.")
@click.option("--provenance-json", type=click.Path(path_type=Path), required=True,
              help="certify_provenance_rows.json (role->zid). Published to the "
                   "SEPARATE restricted provenance object, never to the manifest.")
@click.option("--config", "config_path", type=click.Path(path_type=Path), default=None)
@click.option("--owner", required=True, help="Owning team/role for the manifest.")
@click.option("--snapshot-identifier", required=True,
              help="RDS snapshot identifier the prodclone was restored from.")
@click.option("--snapshot-time", required=True, help="Snapshot creation time (ISO-8601).")
@click.option("--schema-migration-version", default=None)
@click.option("--archive-sha256", default=None,
              help="SHA-256 of the archived runnable Clojure oracle image/source.")
@click.option("--archive-object-version", default=None)
@click.option("--store", default=f"s3://{fb.DEFAULT_BUCKET}", show_default=True)
@click.option("--manifest-out", type=click.Path(path_type=Path), default=None,
              help="Also write the manifest locally (for review before/after push).")
@click.option("--accept-null-vote-drops", is_flag=True, default=False,
              help="Record an EXPLICIT acceptance that some compatibility CSV "
                   "omitted NULL-vote rows. Without it, admission refuses a "
                   "bundle whose extraction dropped any; with it, the bundle is "
                   "published as a NON-CERTIFYING compatibility export.")
@click.option("--dry-run", is_flag=True, default=False,
              help="Build, verify and ADMIT the manifest; upload nothing.")
def push(bundle_id: str, payload: Path, extract_json: Path, provenance_json: Path,
         config_path: Path | None, owner: str, snapshot_identifier: str,
         snapshot_time: str, schema_migration_version: str | None,
         archive_sha256: str | None, archive_object_version: str | None,
         store: str, manifest_out: Path | None, accept_null_vote_drops: bool,
         dry_run: bool) -> None:
    """Build the manifest + restricted provenance object and publish the bundle
    immutably, pinning every object's version id."""
    config_path = config_path or fc.DEFAULT_CONFIG_PATH
    config = fc.load_config(config_path)
    config_bytes = Path(config_path).read_bytes()
    extract = json.loads(Path(extract_json).read_text())
    provenance_rows = json.loads(Path(provenance_json).read_text())
    payload = Path(payload).resolve()

    manifest = fb.build_manifest(
        bundle_id=bundle_id, payload_root=payload, config=config,
        config_bytes=config_bytes, selections=extract["roles"],
        generated_summaries=extract["generated"],
        snapshot={
            "identifier": snapshot_identifier,
            "created_at": snapshot_time,
            "schema_migration_version": schema_migration_version,
        },
        transaction_guarantee=extract["transaction_guarantee"],
        tie_key=extract["tie_key"],
        schedules=fb.collect_schedule_hashes(SCHEDULES_DIR),
        owner=owner,
        extraction_commit=fb.git_commit(REPO_ROOT),
        source_commit=fb.git_commit(REPO_ROOT),
        archive=None if not archive_sha256 else {
            "sha256": archive_sha256, "object_version": archive_object_version},
        coverage_report=extract.get("coverage_report"),
        accepted_null_vote_drops=accept_null_vote_drops,
    )
    fb.verify(payload, manifest)
    try:
        fb.admit_manifest(manifest, config=config, config_bytes=config_bytes)
    except fb.AdmissionError as exc:
        raise click.ClickException(str(exc)) from exc

    provenance = fb.build_provenance(
        bundle_id=bundle_id, root_digest_value=manifest["root_digest"],
        selections=provenance_rows, owner=owner,
    )

    if manifest_out is not None:
        Path(manifest_out).write_bytes(fb.canonical_json(manifest))
        click.echo(f"manifest -> {manifest_out}")

    click.echo(f"bundle_id      : {bundle_id}")
    click.echo(f"root_digest    : {manifest['root_digest']}")
    click.echo(f"files          : {len(manifest['files'])}")
    click.echo(f"roles          : {len(manifest['roles'])}")
    click.echo(f"generated cases: {len(manifest['generated']['cases'])}")
    click.echo(f"ordering       : {manifest['ordering']['guarantee']}")

    if dry_run:
        click.echo("admitted; dry run: nothing uploaded")
        return

    try:
        pins = fb.push(_store_from_url(store), bundle_id=bundle_id,
                       payload_root=payload, manifest=manifest,
                       provenance=provenance, config=config,
                       config_bytes=config_bytes)
    except fb.BundleError as exc:
        raise click.ClickException(str(exc)) from exc
    click.echo(f"published {len(pins['objects'])} pinned object(s) to {store}/{bundle_id}/")
    click.echo(f"pins object version: {pins.get('pins_object_version_id')}")


# ---------------------------------------------------------------------------
# pull / verify / pin
# ---------------------------------------------------------------------------


@cli.command()
@click.option("--bundle-id", required=True)
@click.option("--dest", type=click.Path(path_type=Path), required=True,
              help="EMPTY destination directory.")
@click.option("--store", default=f"s3://{fb.DEFAULT_BUCKET}", show_default=True)
@click.option("--config", "config_path", type=click.Path(path_type=Path), default=None,
              help="Selection config to ADMIT the manifest against (default: the "
                   "committed one). Its sha256 must match the manifest.")
@click.option("--with-provenance", is_flag=True, default=False,
              help="Also fetch the RESTRICTED role->zid object. Ordinary "
                   "certification runs do not need it, and the payload-reader "
                   "IAM role is DENIED it.")
@click.option("--provenance-role", default=None,
              help="REQUIRED with --with-provenance: the distinct IAM role/"
                   "principal being exercised to read identities. Payload read "
                   "access is never sufficient; see delphi/docs/CERTIFICATION.md.")
def pull(bundle_id: str, dest: Path, store: str, config_path: Path | None,
         with_provenance: bool, provenance_role: str | None) -> None:
    """Download a bundle into an empty workspace: every hash verified and the
    manifest ADMITTED before any engine may use it, path traversal and symlinks
    rejected."""
    config_path = config_path or fc.DEFAULT_CONFIG_PATH
    try:
        result = fb.pull(_store_from_url(store), bundle_id=bundle_id, dest=Path(dest),
                         with_provenance=with_provenance,
                         provenance_role=provenance_role,
                         config=fc.load_config(config_path),
                         config_bytes=Path(config_path).read_bytes())
    except fb.BundleError as exc:
        raise click.ClickException(str(exc)) from exc
    click.echo(f"verified and admitted {result['n_files']} file(s) into "
               f"{result['payload_root']}")
    click.echo(f"root_digest: {result['root_digest']}")
    if result["provenance_pulled"]:
        click.echo("restricted provenance object pulled (identities on disk, mode "
                   f"0600) as role {result['provenance_role']}")


@cli.command()
@click.option("--payload", type=click.Path(path_type=Path), required=True)
@click.option("--manifest", "manifest_path", type=click.Path(path_type=Path), required=True)
@click.option("--config", "config_path", type=click.Path(path_type=Path), default=None,
              help="Selection config to admit against (default: the committed one).")
@click.option("--admit/--no-admit", default=True, show_default=True,
              help="Also run SEMANTIC admission (schema version, role coverage "
                   "and rule conformance, materialisation, schedules, polarity). "
                   "--no-admit is a bytes-only integrity check and never "
                   "certifies a bundle.")
def verify(payload: Path, manifest_path: Path, config_path: Path | None,
           admit: bool) -> None:
    """Verify a local payload tree against its manifest, and ADMIT the manifest.

    Corrupted, truncated, missing AND extra files all fail the integrity pass;
    a manifest that is byte-consistent but semantically inadmissible (wrong
    schema version, a role outside its own rule, an unmaterialised substitute,
    an inconsistent checkpoint count, undeclared polarity) fails the second."""
    manifest = json.loads(Path(manifest_path).read_text())
    config_path = config_path or fc.DEFAULT_CONFIG_PATH
    try:
        fb.verify(Path(payload), manifest)
        if admit:
            fb.admit_manifest(manifest, config=fc.load_config(config_path),
                              config_bytes=Path(config_path).read_bytes())
    except fb.BundleError as exc:
        click.echo(str(exc), err=True)
        sys.exit(1)
    click.echo(f"OK: {len(manifest['files'])} file(s) match manifest "
               f"{manifest['bundle_id']} (root digest {manifest['root_digest']})"
               + ("; manifest ADMITTED" if admit else "; NOT admitted (--no-admit)"))


@cli.command()
@click.option("--manifest", "manifest_path", type=click.Path(path_type=Path), required=True)
@click.option("--json", "as_json", is_flag=True, default=False)
def pin(manifest_path: Path, as_json: bool) -> None:
    """Render the PUBLIC pin for delphi/docs/CERTIFICATION.md.

    Bundle id, root digest, selector/policy/schedule hashes, role names and
    coverage only — never a zid, report id, participant id, timeline, vote row,
    blob or measured metric.
    """
    manifest = json.loads(Path(manifest_path).read_text())
    public = fb.public_pin(manifest)
    if as_json:
        click.echo(json.dumps(public, indent=2, sort_keys=True))
    else:
        click.echo(fb.render_public_pin_markdown(public), nl=False)


if __name__ == "__main__":
    cli()
