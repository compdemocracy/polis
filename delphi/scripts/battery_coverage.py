#!/usr/bin/env python3
"""Which ``certify_battery.json`` entries have BOTH engines' recordings on disk.

Every consumer of the recording store — the P-044 G12 numerical measurement,
the CI recordings manifest, an operator asking "did that dispatch actually give
me the four entries I paid for?" — needs the same answer: enumerate the battery,
resolve each entry to its on-disk ``<dataset>/<schedule_id>`` directory, and say
which entries have a usable Clojure↔Python pair and which do not, *by name*.
Hard-coding the entry list is what made the G12 measurement silently keep
reporting two of six after new recordings landed: an absent entry looked exactly
like an entry nobody asked for.

Coverage here means a *pair*: a Python step set, a Clojure step set, and the two
agreeing on step count. Anything else is reported as missing WITH ITS REASON, so
a caller can distinguish "the run never produced it" from "the Clojure driver
failed halfway" — never by inferring absence from a swallowed error.

## Stdlib only, on purpose

This module is imported by ``ci/p022_recordings_manifest.py``, which runs on the
disposable CI worker under the system ``python3`` with no virtualenv and no
delphi dependencies installed. So it must not import :mod:`polismath` — whose
package ``__init__`` pulls in the config stack, and whose
``polismath.replay.certify`` pulls numpy/sklearn/torch. The schedule-id
derivation is therefore restated here rather than imported, and
``delphi/tests/replay_harness/test_battery_coverage.py`` pins it against the
real :func:`polismath.replay.certify.derive_schedule_id` /
:func:`~polismath.replay.certify.load_battery` so the two cannot drift.

Layout it reads (``polismath/replay/store.py:1-23``)::

    <root>/<dataset>/<schedule_id>/
      schedule.json
      provenance.json
      py/step-NNN.json               # Python driver
      clj/step-NNN.blob.json         # Clojure driver (+ step-NNN.meta.json)

Usage::

    python3 delphi/scripts/battery_coverage.py            # human summary
    python3 delphi/scripts/battery_coverage.py --json     # machine-readable
    python3 delphi/scripts/battery_coverage.py --dataset vw --dataset biodiversity
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

# scripts/battery_coverage.py -> scripts -> delphi
_DELPHI_ROOT = Path(__file__).resolve().parents[1]

DEFAULT_BATTERY_PATH = _DELPHI_ROOT / "scripts" / "certify_battery.json"
DEFAULT_REPLAYS_ROOT = _DELPHI_ROOT / "real_data" / ".local" / "replays"

#: Frozen suffix every battery schedule id carries on disk. Historical (minted
#: while the engine still had a mode flag) and deliberately NOT part of the
#: identity the battery file uses — mirrors ``certify._LEGACY_SUFFIX``.
LEGACY_SUFFIX = "clojure-legacy"

#: Presets whose id embeds a cut count; mirrors ``certify._NCUTS_PRESETS``.
NCUTS_PRESETS = frozenset({"uniform", "front-loaded", "back-loaded"})
#: Mirrors ``certify._VALID_PRESETS``.
VALID_PRESETS = NCUTS_PRESETS | frozenset({"single-cut", "every-vote", "per-day"})

#: How to count one engine's steps. The Clojure driver writes a ``.blob.json``
#: AND a ``.meta.json`` per step (``math/dev/replay.clj:326-330``), so globbing
#: ``step-*.json`` there would double every count.
ENGINE_STEP_GLOB = {"py": "step-*.json", "clj": "step-*.blob.json"}
ENGINES = ("clj", "py")


class BatteryError(ValueError):
    """A battery file this module refuses to guess about."""


@dataclass(frozen=True)
class BatteryRef:
    """One battery entry, resolved to the directory name it records under."""

    dataset: str
    schedule_id: str
    preset: str | None = None
    n_cuts: int | None = None
    schedule: str | None = None
    notes: str = ""
    optional: bool = False
    role: str | None = None

    @property
    def key(self) -> str:
        """``<dataset>/<schedule_id>`` — how an entry is named in reports."""
        return f"{self.dataset}/{self.schedule_id}"

    def as_dict(self) -> dict[str, Any]:
        return {
            "dataset": self.dataset,
            "schedule_id": self.schedule_id,
            "preset": self.preset,
            "n_cuts": self.n_cuts,
            "schedule": self.schedule,
            "optional": self.optional,
            "role": self.role,
        }


def derive_schedule_id(
    *,
    preset: str | None = None,
    n_cuts: int | None = None,
    base_schedule_id: str | None = None,
) -> str:
    """``{base}-clojure-legacy`` — byte-identical to certify's derivation."""
    if base_schedule_id is not None:
        base = base_schedule_id
    elif preset in NCUTS_PRESETS:
        if n_cuts is None:
            raise BatteryError(f"preset {preset!r} requires n_cuts to derive a schedule_id")
        base = f"{preset}{n_cuts}"
    else:
        base = preset
    return f"{base}-{LEGACY_SUFFIX}"


def _safe_component(name: Any, *, label: str) -> str:
    """Reject anything that would escape the store root (mirrors store.py)."""
    if (
        not isinstance(name, str)
        or not name
        or name in (".", "..")
        or "/" in name
        or "\\" in name
    ):
        raise BatteryError(f"unsafe {label} for recording path: {name!r}")
    return name


def parse_entry(entry: dict[str, Any], *, battery_dir: Path) -> BatteryRef:
    """Parse one entry — ``{"schedule": path}`` or ``{"preset", "n_cuts"}``."""
    if not isinstance(entry, dict):
        raise BatteryError("battery entries must be objects")
    dataset = _safe_component(entry.get("dataset"), label="dataset")
    optional = bool(entry.get("optional", False))
    role = entry.get("role")
    notes = entry.get("notes", "")
    if "schedule" in entry and "preset" in entry:
        raise BatteryError(f"entry {dataset!r} declares schedule AND preset")

    if "schedule" in entry:
        rel = entry["schedule"]
        path = Path(rel)
        if not path.is_absolute():
            path = battery_dir / path
        try:
            spec = json.loads(path.read_text())
        except OSError as exc:
            raise BatteryError(f"cannot read schedule {rel!r}: {exc}") from exc
        base_id = spec.get("schedule_id")
        if not base_id:
            raise BatteryError(f"schedule {rel!r} declares no schedule_id")
        schedule_id = derive_schedule_id(base_schedule_id=base_id)
        _safe_component(schedule_id, label="schedule_id")
        return BatteryRef(dataset=dataset, schedule_id=schedule_id, schedule=str(rel),
                          notes=notes, optional=optional, role=role)

    preset = entry.get("preset")
    if preset not in VALID_PRESETS:
        raise BatteryError(f"unknown preset {preset!r} for dataset {dataset!r}")
    n_cuts = entry.get("n_cuts")
    if n_cuts is not None and (type(n_cuts) is not int or n_cuts <= 0):
        raise BatteryError("n_cuts must be a positive integer")
    schedule_id = derive_schedule_id(preset=preset, n_cuts=n_cuts)
    _safe_component(schedule_id, label="schedule_id")
    return BatteryRef(dataset=dataset, schedule_id=schedule_id, preset=preset,
                      n_cuts=n_cuts, notes=notes, optional=optional, role=role)


def load_battery(path: str | Path = DEFAULT_BATTERY_PATH) -> list[BatteryRef]:
    """Every entry in ``certify_battery.json``, in file order."""
    path = Path(path)
    data = json.loads(path.read_text())
    if not isinstance(data, list):
        raise BatteryError(f"{path} must contain a list of entries")
    return [parse_entry(e, battery_dir=path.parent) for e in data]


# ---------------------------------------------------------------------------
# Coverage.
# ---------------------------------------------------------------------------
@dataclass
class EngineCoverage:
    """One engine's step files under ``<rec_dir>/<engine>/``."""

    engine: str
    present: bool
    steps: int
    bytes: int
    files: list[Path] = field(default_factory=list)


def engine_coverage(rec_dir: Path, engine: str) -> EngineCoverage:
    """Count and size one engine's step files. Absent dir is 0 steps, not an error."""
    if engine not in ENGINE_STEP_GLOB:
        raise BatteryError(f"unknown engine {engine!r}")
    step_dir = rec_dir / engine
    if not step_dir.is_dir():
        return EngineCoverage(engine=engine, present=False, steps=0, bytes=0)
    files = sorted(p for p in step_dir.glob(ENGINE_STEP_GLOB[engine]) if p.is_file())
    total = sum(p.stat().st_size for p in files)
    return EngineCoverage(engine=engine, present=bool(files), steps=len(files),
                          bytes=total, files=files)


def entry_coverage(ref: BatteryRef, root: Path) -> dict[str, Any]:
    """Resolve one entry against a replays root.

    ``reasons`` is empty exactly when the entry is covered. Every non-covered
    outcome names itself: ``no-recording-dir``, ``missing-clj``, ``missing-py``,
    ``step-count-mismatch``.
    """
    rec_dir = root / ref.dataset / ref.schedule_id
    engines = {name: engine_coverage(rec_dir, name) for name in ENGINES}
    reasons: list[str] = []
    if not rec_dir.is_dir():
        reasons.append("no-recording-dir")
    for name in ENGINES:
        if not engines[name].present:
            reasons.append(f"missing-{name}")
    if not reasons and engines["clj"].steps != engines["py"].steps:
        # certify refuses a pair whose step sets differ (certify.py:1415-1420);
        # a half-written recording must not read as coverage here either.
        reasons.append("step-count-mismatch")
    return {
        "key": ref.key,
        "entry": ref.as_dict(),
        "path": rec_dir,
        "covered": not reasons,
        "reasons": reasons,
        "steps": engines["py"].steps if not reasons else None,
        "engines": {
            name: {"present": cov.present, "steps": cov.steps, "bytes": cov.bytes}
            for name, cov in engines.items()
        },
        "_engines": engines,
    }


def coverage(
    *,
    battery: str | Path = DEFAULT_BATTERY_PATH,
    root: str | Path = DEFAULT_REPLAYS_ROOT,
    datasets: list[str] | None = None,
    include_optional: bool = True,
) -> dict[str, Any]:
    """Enumerate the battery and split it into covered / missing entries.

    ``datasets`` restricts the enumeration (the CI battery is public fixtures
    only); ``None`` means every entry in the file. Both lists are always
    reported — a caller that only reads ``covered`` is the bug this replaces.
    """
    root = Path(root)
    refs = load_battery(battery)
    if datasets is not None:
        wanted = set(datasets)
        refs = [r for r in refs if r.dataset in wanted]
    if not include_optional:
        refs = [r for r in refs if not r.optional]

    covered, missing = [], []
    for ref in refs:
        row = entry_coverage(ref, root)
        (covered if row["covered"] else missing).append(row)
    return {
        "battery": str(battery),
        "root": str(root),
        "datasets": sorted(datasets) if datasets is not None else None,
        "enumerated": len(refs),
        "covered": covered,
        "missing": missing,
        "covered_keys": [r["key"] for r in covered],
        "missing_keys": [r["key"] for r in missing],
    }


def format_report(report: dict[str, Any]) -> str:
    """A human summary that names both halves, never just the good one."""
    lines = [
        f"battery: {report['battery']}",
        f"replays root: {report['root']}",
        f"entries enumerated: {report['enumerated']}"
        + ("" if report["datasets"] is None else f" (datasets: {', '.join(report['datasets'])})"),
        f"covered: {len(report['covered'])}/{report['enumerated']}",
    ]
    for row in report["covered"]:
        lines.append(
            f"  + {row['key']}  steps={row['steps']}"
            f"  clj={row['engines']['clj']['bytes']}B py={row['engines']['py']['bytes']}B"
        )
    lines.append(f"missing: {len(report['missing'])}/{report['enumerated']}")
    for row in report["missing"]:
        lines.append(f"  - {row['key']}  {','.join(row['reasons'])}")
    return "\n".join(lines)


def _jsonable(report: dict[str, Any]) -> dict[str, Any]:
    def strip(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        out = []
        for row in rows:
            clean = {k: v for k, v in row.items() if k != "_engines"}
            clean["path"] = str(clean["path"])
            out.append(clean)
        return out

    return {**report, "covered": strip(report["covered"]), "missing": strip(report["missing"])}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=(__doc__ or "").splitlines()[0])
    ap.add_argument("--battery", default=str(DEFAULT_BATTERY_PATH),
                    help="certify_battery.json (default: delphi/scripts/certify_battery.json)")
    ap.add_argument("--root", default=str(DEFAULT_REPLAYS_ROOT),
                    help="replays root (default: delphi/real_data/.local/replays)")
    ap.add_argument("--dataset", action="append", default=None, dest="datasets",
                    help="restrict to this dataset slug (repeatable)")
    ap.add_argument("--skip-optional", action="store_true",
                    help="ignore entries marked optional")
    ap.add_argument("--json", action="store_true", help="emit the report as JSON")
    ap.add_argument("--require-complete", action="store_true",
                    help="exit 1 if any enumerated entry is missing a recording")
    args = ap.parse_args(argv)

    try:
        report = coverage(battery=args.battery, root=args.root, datasets=args.datasets,
                          include_optional=not args.skip_optional)
    except (BatteryError, OSError, ValueError) as exc:
        print(f"battery_coverage: {exc}", file=sys.stderr)
        return 2

    if args.json:
        json.dump(_jsonable(report), sys.stdout, indent=1, sort_keys=True, default=str)
        sys.stdout.write("\n")
    else:
        print(format_report(report))
    if args.require_complete and report["missing"]:
        print(f"battery_coverage: {len(report['missing'])} entry/entries without a "
              f"clj+py pair: {', '.join(report['missing_keys'])}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
