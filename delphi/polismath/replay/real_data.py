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

SERVED MATH ROWS. A private fixture bundle extracted with the optional
served-math capture (P-052 §4.5,
:mod:`polismath.replay.fixture_extract`) also carries, per conversation
directory, ``served_math.json`` and one verbatim ``served-math-NNN.blob.json``
per ``math_env`` — what the Clojure engine actually PUBLISHED, as opposed to
what it was fed. :func:`load_served_math` reads them back so certify-side code
can compare a candidate engine's final blob against the served one, and
:func:`check_served_math_against_dataset` re-derives the watermark consistency
DIAGNOSTIC from the votes actually loaded. A dataset without the capture
returns ``None``: an absent capture is a complete statement, not an error.
"""

from __future__ import annotations

import csv
import hashlib
import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

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
    mapping = os.environ.get("POLIS_REPLAY_INPUT_MAP")
    if mapping:
        bindings = json.loads(Path(mapping).read_text())
        if not isinstance(bindings, dict) or slug not in bindings:
            raise ValueError("input map must bind every requested dataset")
        path = Path(bindings[slug])
        if not path.is_absolute() or not path.is_dir():
            raise ValueError("input map values must be existing absolute directories")
        return path
    hits = sorted(REAL_DATA_ROOT.glob(f"*-{slug}"))
    if not hits:
        hits = sorted(REAL_DATA_ROOT.glob(f".local/*-{slug}"))
    if len(hits) > 1:
        raise ValueError("ambiguous dataset directory")
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
    if (d / "events.jsonl").exists():
        from polismath.replay.event_ingress import load_events
        return load_events(d / "events.jsonl")
    votes_csvs = sorted(d.glob("*-votes.csv"))
    if not votes_csvs:
        raise FileNotFoundError(f"no *-votes.csv in {d.name}")

    mod_events: list[ModEvent] = []
    mod_events_skipped = 0
    comments_csvs = sorted(d.glob("*-comments.csv"))
    if comments_csvs:
        mod_events, mod_events_skipped = _load_mod_events(comments_csvs[0])

    dataset = load_votes_csv(votes_csvs[0], mod_events=mod_events)
    dataset.mod_events_skipped = mod_events_skipped
    return dataset


def read_export_vote_rows(path: str | Path) -> list[tuple[int, int, int, int]]:
    """Parse ONE export votes CSV into the raw ``(t_ms, pid, tid, sign)`` rows
    :meth:`ReplayDataset.build` consumes. Second-resolution timestamps are
    widened to milliseconds; the vote column is taken VERBATIM, because the
    export format is already semantic (agree = +1) and negating it here would
    be the double flip P-023 forbids."""
    raw: list[tuple[int, int, int, int]] = []
    with open(path, newline="") as fh:
        for row in csv.DictReader(fh):
            raw.append(
                (
                    int(row["timestamp"]) * 1000,
                    int(row["voter-id"]),
                    int(row["comment-id"]),
                    int(row["vote"]),
                )
            )
    return raw


def load_votes_csv(
    path: str | Path, *, mod_events: list[ModEvent] | None = None,
) -> ReplayDataset:
    """Load ONE export votes CSV (by path) into a ReplayDataset — the ingress
    :func:`load_export_votes` performs, factored out so a caller holding a
    freshly written CSV (e.g. the P-023 polarity pair, which formats raw rows
    through ``prodclone.format_votes_rows`` under a declared storage
    convention) runs the SAME parse rather than a copy of it."""
    return ReplayDataset.build(read_export_vote_rows(path),
                               mod_events=list(mod_events or []))


# ---------------------------------------------------------------------------
# Served math rows — the output side of a private fixture bundle (P-052 §4.5).
# ---------------------------------------------------------------------------

SERVED_MATH_META_FILENAME = "served_math.json"


class ServedMathError(RuntimeError):
    """A served-math capture is present but does not read back intact."""


@dataclass(frozen=True)
class ServedMathRow:
    """One ``math_main`` row as production served it, for one ``math_env``.

    ``blob_text`` is the blob VERBATIM — the exact bytes ``data::text`` handed
    the extractor. :meth:`blob` parses it for convenience; the text is the
    authority, and nothing here rewrites it.
    """

    math_env: str
    last_vote_timestamp: int | None
    math_tick: int | None
    caching_tick: int | None
    modified: int | None
    blob_file: str
    blob_sha256: str
    blob_bytes: int
    blob_last_vote_timestamp: int | None
    blob_watermark_absent_because: str | None
    blob_text: str

    def blob(self) -> dict[str, Any]:
        parsed = json.loads(self.blob_text)
        if not isinstance(parsed, dict):
            raise ServedMathError(
                f"served blob for math_env {self.math_env!r} is a JSON "
                f"{type(parsed).__name__}, not an object")
        return parsed


@dataclass(frozen=True)
class ServedMathTick:
    """One raw ``math_ticks`` row. P-1 assumes default initialization and an
    uninterrupted row lifecycle; it is not a recompute history. Missing optional
    columns are distinguished from SQL NULL by ``ServedMath.meta.source_columns``."""

    math_env: str
    math_tick: int | None
    caching_tick: int | None
    modified: int | None


@dataclass(frozen=True)
class ServedMath:
    """Everything one conversation's served-math capture holds."""

    path: Path
    schema_version: str
    math_envs_present: tuple[str, ...]
    math_envs_captured: tuple[str, ...]
    rows: tuple[ServedMathRow, ...]
    ticks: tuple[ServedMathTick, ...]
    consistency: dict[str, Any]
    meta: dict[str, Any]

    def row(self, math_env: str) -> ServedMathRow | None:
        """The served row for one environment, or ``None`` if not captured."""
        return next((r for r in self.rows if r.math_env == math_env), None)

    def tick(self, math_env: str) -> ServedMathTick | None:
        return next((t for t in self.ticks if t.math_env == math_env), None)


def read_served_math(
    directory: str | Path, *, verify_digests: bool = True,
) -> ServedMath | None:
    """Read a served-math capture out of ONE fixture directory.

    Returns ``None`` when the directory holds no capture. ``verify_digests``
    validates metadata, census and the event-timestamp diagnostic, then hashes
    and sizes every blob. Pass ``False`` only to inspect changed blob bytes;
    metadata and path validation remain required. Bundle verification separately
    binds this metadata to the manifest.
    """
    from polismath.replay.served_math import CaptureError, read_capture

    directory = Path(directory)
    try:
        capture = read_capture(directory, verify_digests=verify_digests)
    except CaptureError as exc:
        raise ServedMathError(str(exc)) from exc
    if capture is None:
        return None
    meta, raw_blobs = capture
    rows: list[ServedMathRow] = []
    for entry in meta.get("math_main", []):
        blob_file = str(entry["blob_file"])
        raw = raw_blobs[blob_file]
        rows.append(ServedMathRow(
            math_env=str(entry["math_env"]),
            last_vote_timestamp=entry.get("last_vote_timestamp"),
            math_tick=entry.get("math_tick"),
            caching_tick=entry.get("caching_tick"),
            modified=entry.get("modified"),
            blob_file=blob_file,
            blob_sha256=str(entry.get("blob_sha256")),
            blob_bytes=int(entry.get("blob_bytes", len(raw))),
            blob_last_vote_timestamp=entry.get("blob_last_vote_timestamp"),
            blob_watermark_absent_because=entry.get(
                "blob_watermark_absent_because"),
            blob_text=raw.decode("utf-8"),
        ))

    ticks = tuple(
        ServedMathTick(
            math_env=str(t["math_env"]), math_tick=t.get("math_tick"),
            caching_tick=t.get("caching_tick"), modified=t.get("modified"))
        for t in meta.get("math_ticks", [])
    )
    return ServedMath(
        path=directory,
        schema_version=str(meta.get("schema_version")),
        math_envs_present=tuple(meta.get("math_envs_present") or ()),
        math_envs_captured=tuple(meta.get("math_envs_captured") or ()),
        rows=tuple(rows),
        ticks=ticks,
        consistency=dict(meta.get("consistency") or {}),
        meta=meta,
    )


def load_served_math(
    slug: str, *, verify_digests: bool = True,
) -> ServedMath | None:
    """Locate a dataset by slug and read its served-math capture, if any."""
    directory = dataset_dir(slug)
    if directory is None:
        raise FileNotFoundError(f"no dataset directory matching *-{slug}")
    return read_served_math(directory, verify_digests=verify_digests)


def check_served_math_against_dataset(
    served: ServedMath, dataset: ReplayDataset,
) -> dict[str, Any]:
    """Re-derive the served watermark DIAGNOSTIC from the votes actually loaded.

    A DIAGNOSTIC, never a gate — the same rule the extractor records the
    capture under, and for the same reason: ``math_main`` is a latest-only
    upsert, so votes arriving after the last publish are ordinary. The value of
    running it again here is that the capture's own record was computed against
    the private millisecond event stream, while a replay may be driven from the
    second-resolution compatibility CSV; a disagreement between the two is a
    fact about the ingress, and it should be visible rather than assumed away.

    Reuses the extractor's implementation so there is exactly one definition of
    the timestamp relation.
    """
    from polismath.replay import fixture_extract as fx

    rows = [{
        "math_env": r.math_env,
        "last_vote_timestamp": r.last_vote_timestamp,
        "blob_last_vote_timestamp": r.blob_last_vote_timestamp,
        "blob_watermark_absent_because": r.blob_watermark_absent_because,
    } for r in served.rows]
    result = fx.served_math_consistency(rows, [v.t_ms for v in dataset.votes])
    result["recomputed_from"] = "the loaded ReplayDataset's vote timestamps"
    result["capture_recorded"] = served.consistency
    return result
