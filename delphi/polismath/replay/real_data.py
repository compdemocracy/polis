"""Loaders for real exported datasets (public, under ``delphi/real_data``).

Export vote CSVs have columns ``timestamp,datetime,comment-id,voter-id,vote``
with **second**-resolution timestamps.

Sign caveat (era A only): export CSVs carry *flipped* signs relative to the
raw DB votes the math consumed (the flip is export-only —
math/src/polismath/darwin/export.clj:106-113). Era-B inference ignores signs
entirely (dom membership only). Before using era-A weights on export data,
audit the mapping; until then :func:`load_export_votes` stores the export
sign verbatim and era-A runs on export data are marked diagnostic-only.

Datasets are located by slug glob (``real_data/*-<slug>``) so report-id
directory names never appear in code.
"""

import csv
from pathlib import Path

from polismath.replay.types import ReplayDataset

REAL_DATA_ROOT = Path(__file__).resolve().parents[2] / "real_data"


def dataset_dir(slug: str) -> Path | None:
    """Locate a dataset directory by slug — public (``real_data/*-<slug>``)
    first, then private (``real_data/.local/*-<slug>``, gitignored). A public
    match wins a slug collision."""
    hits = sorted(REAL_DATA_ROOT.glob(f"*-{slug}"))
    if not hits:
        hits = sorted(REAL_DATA_ROOT.glob(f".local/*-{slug}"))
    return hits[0] if hits else None


def load_export_votes(slug: str) -> ReplayDataset:
    """Load an exported votes CSV into a ReplayDataset.

    Comment creation times are inferred as first-vote times (lower bound on
    availability; adequate because a comment is unobservable in the mark
    likelihood before its first vote anyway).
    """
    d = dataset_dir(slug)
    if d is None:
        raise FileNotFoundError(f"no dataset directory matching *-{slug}")
    votes_csvs = sorted(d.glob("*-votes.csv"))
    if not votes_csvs:
        raise FileNotFoundError(f"no *-votes.csv in {d.name}")
    raw: list[tuple[int, int, int, int]] = []
    with open(votes_csvs[0], newline="") as fh:
        for row in csv.DictReader(fh):
            raw.append(
                (
                    int(row["timestamp"]) * 1000,
                    int(row["voter-id"]),
                    int(row["comment-id"]),
                    int(row["vote"]),
                )
            )
    return ReplayDataset.build(raw)
