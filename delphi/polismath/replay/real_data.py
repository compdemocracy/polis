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
import re
from pathlib import Path

from polismath.replay.types import ModEvent, ReplayDataset

REAL_DATA_ROOT = Path(__file__).resolve().parents[2] / "real_data"

# Slug allow-list — same precedent as prodclone.py's minted-slug regex
# (``_SLUG_RE_TEMPLATE``): a slug flows unsanitized into a ``Path.glob()``
# pattern below, so without this guard a slug containing glob metacharacters
# (``*``, ``?``, ``[...]``) or path separators (``../``) could escape the
# intended directory or match unintended files.
_SLUG_RE = re.compile(r"^[A-Za-z0-9_-]+$")

# Comments-CSV columns a moderation-history-carrying export must have before
# we attempt to weave mod events out of it — MOD_RESTART_PORT_SPEC.md "Python
# ports" item 3. Older comments CSVs (pre-dating this port) lack "modified"
# and are left alone: no mod events, no error. "is-meta" is optional and
# defaults to False when absent, mirroring the clj reader; "comment-id" and
# "moderated" ARE required — the row loop reads them unconditionally, so a
# header missing either takes the graceful no-events path instead of a
# KeyError mid-row (#2656 review finding 3).
_MOD_EVENT_REQUIRED_COLUMNS = frozenset({"modified", "comment-id", "moderated"})
_TRUE_STRINGS = frozenset({"1", "true", "t", "yes"})


def _parse_bool(value: str | None) -> bool:
    if value is None:
        return False
    return value.strip().lower() in _TRUE_STRINGS


def _load_mod_events(comments_csv: Path) -> tuple[list[ModEvent], int]:
    """Build ``ModEvent``s from a comments CSV carrying the moderation-history
    columns, alongside the existing ``comment-id``/``moderated`` columns
    (modified->t_ms, comment-id->tid, moderated->mod, is-meta->is_meta).

    Returns ``([], 0)`` when the required columns are absent (a header-level
    check — this is a format detection, not a per-row guess). Rows with no
    ``modified`` value cannot be woven into a replay schedule (nothing to
    interleave on) — SKIPPED; the count is returned for provenance (surfaced
    via :attr:`~polismath.replay.types.ReplayDataset.mod_events_skipped`).
    """
    with open(comments_csv, newline="") as fh:
        reader = csv.DictReader(fh)
        fieldnames = set(reader.fieldnames or [])
        if not _MOD_EVENT_REQUIRED_COLUMNS <= fieldnames:
            return [], 0

        events: list[ModEvent] = []
        skipped = 0
        for row in reader:
            modified = (row.get("modified") or "").strip()
            if not modified:
                skipped += 1
                continue
            events.append(
                ModEvent(
                    t_ms=int(modified),
                    tid=int(row["comment-id"]),
                    mod=int(row["moderated"]),
                    is_meta=_parse_bool(row.get("is-meta")),
                )
            )
    return events, skipped


def dataset_dir(slug: str) -> Path | None:
    """Locate a dataset directory by slug — public (``real_data/*-<slug>``)
    first, then private (``real_data/.local/*-<slug>``, gitignored). A public
    match wins a slug collision."""
    if not _SLUG_RE.match(slug):
        return None
    hits = sorted(REAL_DATA_ROOT.glob(f"*-{slug}"))
    if not hits:
        hits = sorted(REAL_DATA_ROOT.glob(f".local/*-{slug}"))
    return hits[0] if hits else None


def load_export_votes(slug: str) -> ReplayDataset:
    """Load an exported votes CSV into a ReplayDataset.

    Comment creation times are inferred as first-vote times (lower bound on
    availability; adequate because a comment is unobservable in the mark
    likelihood before its first vote anyway).

    If a ``*-comments.csv`` sits alongside the votes CSV AND carries the
    moderation-history columns (``modified``, ``is-meta``), the dataset's
    ``mod_events`` are built from it (see :func:`_load_mod_events`) — older
    comments CSVs, or datasets with no comments CSV at all, yield no mod
    events (unchanged from before this was wired up).
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

    mod_events: list[ModEvent] = []
    mod_events_skipped = 0
    comments_csvs = sorted(d.glob("*-comments.csv"))
    if comments_csvs:
        mod_events, mod_events_skipped = _load_mod_events(comments_csvs[0])

    dataset = ReplayDataset.build(raw, mod_events=mod_events)
    dataset.mod_events_skipped = mod_events_skipped
    return dataset
