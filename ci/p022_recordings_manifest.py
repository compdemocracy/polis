#!/usr/bin/env python3
"""P-022 §E — pack the battery's recordings, with an inventory that pins them.

## Why this exists

As merged, the run proved the public battery passed and then destroyed the box
that held its output: `ci/p022_ec2_run.sh` runs certify with
`--root "$LOG_DIR/certify-run"` but bundles only `$ART_DIR`, so the
Clojure↔Python recording pairs — the one artefact of the run that cannot be
recomputed without paying for another instance — died with the instance. A
dispatch returned a verdict and no recordings.

This script turns that recording root into a shippable, self-describing bundle:
one gzipped tar per battery entry plus a manifest that names, for every entry,
its dataset, schedule id, per-engine step count, the sha256 of every step file,
and total bytes. A downloader can then say exactly what it got, and prove the
bytes were not reshaped in transit, without trusting this run's prose.

## What it will and will not pack

* Only entries the PUBLIC battery selected. `--selection battery-selection.json`
  is the same six-entry inventory the run pins with its digest, so the manifest
  cannot claim recordings for an entry the battery never admitted. The battery's
  `inventory_digest` is copied into the manifest verbatim, binding the two.
* Only an ALLOWLIST of file names inside each recording directory
  (`schedule.json`, `provenance.json`, `{clj,py}/step-*`, `{clj,py}/cache_manifest.json`).
  A stray file in a recording directory is not shipped and is reported as
  `unlisted`, rather than silently enlarging the artifact — the same
  deny-by-default discipline `status()` applies to the box's stdout.
* Nothing outside `--replays-root`: symlinks are refused, not followed.

Recordings of public fixtures carry no private data — the worker's instance role
cannot read any — so this is a scope change, not a data-boundary change.

## Fail-closed

With `--require-complete` (what the battery path passes), an entry the battery
selected but did not record makes this exit non-zero. Missing evidence is a
failure, never an inferred "there was nothing to ship".

  usage: p022_recordings_manifest.py --replays-root DIR --out DIR
                                     [--battery FILE] [--selection FILE]
                                     [--require-complete]
         p022_recordings_manifest.py --verify DIR
"""

from __future__ import annotations

import argparse
import fnmatch
import hashlib
import importlib.util
import json
import sys
import tarfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SCHEMA = "polis-certification-recordings/1"
MANIFEST_NAME = "recordings-manifest.json"
ENTRIES_DIR = "entries"

#: File names shipped out of a recording directory, relative to it. Everything
#: else stays on the box. `.edn` full-fidelity dumps (math/dev/replay.clj:340)
#: are deliberately NOT here: they are an order of magnitude larger than the
#: blobs and no consumer of these recordings reads them.
FILE_ALLOWLIST = (
    "schedule.json",
    "provenance.json",
    "clj/cache_manifest.json",
    "clj/step-*.blob.json",
    "clj/step-*.meta.json",
    "py/cache_manifest.json",
    "py/step-*.json",
)

# ci/p022_recordings_manifest.py -> ci -> repo root
_REPO_ROOT = Path(__file__).resolve().parents[1]
_COVERAGE_PATH = _REPO_ROOT / "delphi" / "scripts" / "battery_coverage.py"


def _load_coverage_module(path: Path = _COVERAGE_PATH):
    """Import delphi/scripts/battery_coverage.py by path.

    The worker runs this under the system python3 with no delphi virtualenv, so
    `import polismath...` is not available — and the enumeration must not be
    restated here, because a second copy of "which entries exist" is exactly the
    drift that let the G12 measurement report two of six forever.
    """
    name = "p022_battery_coverage"
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise SystemExit(f"cannot load battery coverage module at {path}")
    module = importlib.util.module_from_spec(spec)
    # Registered BEFORE exec: @dataclass resolves annotations through
    # sys.modules[cls.__module__], and a module that is not there yet fails.
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def _canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _selected_keys(selection: dict[str, Any]) -> tuple[set[str], set[str]]:
    """(public dataset slugs, canonical rows) the battery actually admitted."""
    slugs = {s for s in selection.get("public_slugs", []) if isinstance(s, str)}
    rows = {
        _canonical_json({f: e.get(f) for f in ("dataset", "preset", "n_cuts", "schedule")})
        for e in selection.get("selected", [])
        if isinstance(e, dict)
    }
    return slugs, rows


def _ref_row(ref) -> str:
    return _canonical_json({
        "dataset": ref.dataset,
        "preset": ref.preset,
        "n_cuts": ref.n_cuts,
        "schedule": ref.schedule,
    })


def _listed_files(rec_dir: Path) -> tuple[list[Path], list[str]]:
    """Split a recording directory into (allowlisted files, unlisted names).

    Traversal is refused rather than sanitised: a symlink or a path that does
    not resolve inside `rec_dir` is reported unlisted and left behind.
    """
    listed: list[Path] = []
    unlisted: list[str] = []
    root = str(rec_dir.resolve())
    for path in sorted(rec_dir.rglob("*")):
        if path.is_dir():
            continue
        rel = path.relative_to(rec_dir).as_posix()
        if path.is_symlink():
            unlisted.append(rel)
            continue
        try:
            resolved = str(path.resolve(strict=True))
        except OSError:
            unlisted.append(rel)
            continue
        if not resolved.startswith(root + "/"):
            unlisted.append(rel)
            continue
        if any(fnmatch.fnmatch(rel, pattern) for pattern in FILE_ALLOWLIST):
            listed.append(path)
        else:
            unlisted.append(rel)
    return listed, unlisted


def _pack_entry(rec_dir: Path, ref, out_dir: Path) -> dict[str, Any]:
    """Write one `<dataset>__<schedule_id>.tar.gz` and describe what went in.

    Members are stored as `<dataset>/<schedule_id>/...` so extracting straight
    into `delphi/real_data/.local/replays` reproduces the canonical store layout
    (`polismath/replay/store.py:1-23`) with no path rewriting by the operator.
    """
    listed, unlisted = _listed_files(rec_dir)
    archives = out_dir / ENTRIES_DIR
    archives.mkdir(parents=True, exist_ok=True)
    archive = archives / f"{ref.dataset}__{ref.schedule_id}.tar.gz"

    files: dict[str, str] = {}
    sizes: dict[str, int] = {}
    prefix = f"{ref.dataset}/{ref.schedule_id}"
    # A fixed mtime/uid/gid keeps the archive reproducible for a given step set,
    # so two runs that recorded the same bytes produce the same archive digest.
    def _reset(info: tarfile.TarInfo) -> tarfile.TarInfo:
        info.uid = info.gid = 0
        info.uname = info.gname = ""
        info.mtime = 0
        info.mode = 0o644
        return info

    with tarfile.open(archive, "w:gz", compresslevel=9) as tar:
        for path in listed:
            rel = path.relative_to(rec_dir).as_posix()
            files[rel] = sha256_file(path)
            sizes[rel] = path.stat().st_size
            tar.add(path, arcname=f"{prefix}/{rel}", filter=_reset)

    def _engine_rows(engine: str) -> dict[str, Any]:
        glob = f"{engine}/" + ("step-*.blob.json" if engine == "clj" else "step-*.json")
        steps = {k: v for k, v in files.items() if fnmatch.fnmatch(k, glob)}
        engine_files = {k: v for k, v in files.items() if k.startswith(f"{engine}/")}
        return {
            "steps": len(steps),
            "bytes": sum(sizes[k] for k in engine_files),
            "step_sha256": dict(sorted(steps.items())),
            "file_sha256": dict(sorted(engine_files.items())),
        }

    return {
        "dataset": ref.dataset,
        "schedule_id": ref.schedule_id,
        "preset": ref.preset,
        "n_cuts": ref.n_cuts,
        "schedule": ref.schedule,
        "archive": f"{ENTRIES_DIR}/{archive.name}",
        "archive_sha256": sha256_file(archive),
        "archive_bytes": archive.stat().st_size,
        "bytes": sum(sizes.values()),
        "file_count": len(files),
        "engines": {engine: _engine_rows(engine) for engine in ("clj", "py")},
        "root_sha256": {k: v for k, v in sorted(files.items()) if "/" not in k},
        "unlisted": unlisted,
    }


def build(
    *,
    replays_root: Path,
    out_dir: Path,
    battery: Path,
    selection: Path | None,
    require_complete: bool,
) -> tuple[dict[str, Any], int]:
    """Pack every selected, covered entry; report both halves; return (manifest, rc)."""
    cov = _load_coverage_module()
    datasets: list[str] | None = None
    admitted: set[str] | None = None
    inventory_digest = ""
    selected_count = None
    if selection is not None:
        sel = json.loads(selection.read_text())
        slugs, rows = _selected_keys(sel)
        datasets = sorted(slugs)
        admitted = rows
        raw_digest = str(sel.get("inventory_digest", ""))
        inventory_digest = raw_digest if len(raw_digest) == 64 else ""
        selected_count = sel.get("selected_count")

    # Enumerate the WHOLE battery and then gate, so every entry this run did not
    # ship is named with the reason it did not — a shorter list with no
    # explanation is how "we only measured two of six" survived for months.
    report = cov.coverage(battery=battery, root=replays_root, datasets=None)
    out_dir.mkdir(parents=True, exist_ok=True)
    packed: list[dict[str, Any]] = []
    missing: list[dict[str, Any]] = []
    not_public: list[str] = []
    not_admitted: list[str] = []

    for row in report["covered"] + report["missing"]:
        ref = cov.BatteryRef(**{k: v for k, v in row["entry"].items()})
        if datasets is not None and ref.dataset not in datasets:
            # Gate 1: public fixtures only, from certify_datasets.json. Nothing
            # else can be on this box, and nothing else may be shipped from it.
            not_public.append(row["key"])
            continue
        if admitted is not None and _ref_row(ref) not in admitted:
            # Gate 2: the battery inventory is the authority on what this run
            # ran. An entry outside it is not evidence of this run.
            not_admitted.append(row["key"])
            continue
        if row["covered"]:
            packed.append(_pack_entry(Path(row["path"]), ref, out_dir))
        else:
            missing.append({
                "dataset": ref.dataset,
                "schedule_id": ref.schedule_id,
                "reasons": row["reasons"],
                "engines": row["engines"],
            })

    entries = sorted(packed, key=lambda e: (e["dataset"], e["schedule_id"]))
    manifest = {
        "schema": SCHEMA,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "battery": Path(battery).name,
        "battery_inventory_digest": inventory_digest,
        "battery_selected_count": selected_count,
        "layout": "extract each archive into delphi/real_data/.local/replays/",
        "entries": entries,
        "missing": sorted(missing, key=lambda e: (e["dataset"], e["schedule_id"])),
        "skipped_not_public": sorted(not_public),
        "skipped_not_in_inventory": sorted(not_admitted),
        "totals": {
            "entries": len(entries),
            "missing": len(missing),
            "step_files": sum(e["engines"]["clj"]["steps"] + e["engines"]["py"]["steps"]
                              for e in entries),
            "bytes": sum(e["bytes"] for e in entries),
            "archive_bytes": sum(e["archive_bytes"] for e in entries),
        },
    }
    # Binds the manifest to the exact bytes it describes: one digest an operator
    # can quote, over every entry's archive digest and step digests.
    manifest["manifest_digest"] = hashlib.sha256(
        _canonical_json({
            "schema": SCHEMA,
            "battery_inventory_digest": inventory_digest,
            "entries": [
                {"dataset": e["dataset"], "schedule_id": e["schedule_id"],
                 "archive_sha256": e["archive_sha256"],
                 "engines": {k: v["step_sha256"] for k, v in e["engines"].items()}}
                for e in entries
            ],
        }).encode("utf-8")
    ).hexdigest()

    (out_dir / MANIFEST_NAME).write_text(json.dumps(manifest, indent=1, sort_keys=True))
    rc = 1 if (require_complete and missing) else 0
    return manifest, rc


def verify(bundle_dir: Path) -> int:
    """Re-hash a downloaded bundle against its own manifest. 0 iff every byte matches."""
    manifest_path = bundle_dir / MANIFEST_NAME
    try:
        manifest = json.loads(manifest_path.read_text())
    except OSError as exc:
        print(f"verify: cannot read {manifest_path}: {exc}", file=sys.stderr)
        return 2
    if manifest.get("schema") != SCHEMA:
        print(f"verify: unexpected schema {manifest.get('schema')!r}", file=sys.stderr)
        return 2
    bad = 0
    for entry in manifest.get("entries", []):
        archive = bundle_dir / entry["archive"]
        if not archive.is_file():
            print(f"verify: MISSING {entry['archive']}", file=sys.stderr)
            bad += 1
            continue
        got = sha256_file(archive)
        if got != entry["archive_sha256"]:
            print(f"verify: DIGEST MISMATCH {entry['archive']}", file=sys.stderr)
            bad += 1
            continue
        print(f"verify: ok {entry['dataset']}/{entry['schedule_id']} "
              f"clj={entry['engines']['clj']['steps']} py={entry['engines']['py']['steps']} "
              f"{entry['archive_bytes']}B")
    if manifest.get("missing"):
        print(f"verify: manifest reports {len(manifest['missing'])} entry/entries WITHOUT "
              f"recordings: {', '.join(m['dataset'] + '/' + m['schedule_id'] for m in manifest['missing'])}",
              file=sys.stderr)
    return 1 if bad else 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="pack + inventory the battery's recordings")
    ap.add_argument("--replays-root", help="certify --root used by the battery")
    ap.add_argument("--out", help="directory to write the manifest and per-entry archives")
    ap.add_argument("--battery", default=str(_REPO_ROOT / "delphi" / "scripts" / "certify_battery.json"))
    ap.add_argument("--selection", default=None,
                    help="battery-selection.json — restricts packing to the admitted inventory")
    ap.add_argument("--require-complete", action="store_true",
                    help="exit 1 if a selected entry has no clj+py recording pair")
    ap.add_argument("--verify", default=None, help="verify a downloaded bundle directory instead")
    args = ap.parse_args(argv)

    if args.verify:
        return verify(Path(args.verify))
    if not args.replays_root or not args.out:
        ap.error("--replays-root and --out are required unless --verify is given")

    manifest, rc = build(
        replays_root=Path(args.replays_root),
        out_dir=Path(args.out),
        battery=Path(args.battery),
        selection=Path(args.selection) if args.selection else None,
        require_complete=args.require_complete,
    )
    totals = manifest["totals"]
    print(f"packed {totals['entries']} entry/entries, {totals['step_files']} step files, "
          f"{totals['bytes']} B raw, {totals['archive_bytes']} B compressed")
    for entry in manifest["missing"]:
        print(f"NO RECORDING: {entry['dataset']}/{entry['schedule_id']} "
              f"({','.join(entry['reasons'])})", file=sys.stderr)
    return rc


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
