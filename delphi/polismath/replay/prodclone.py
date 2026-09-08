"""Prodclone extractor — pull feature-classified real conversations out of a
"prodclone" Postgres database (a clone of the production polis DB) into the
replay-dataset export format, for Clojure↔Python math parity certification.

See ``delphi/scripts/prodclone_extract.py`` for the CLI. This module holds
the PURE building blocks (SQL builders, feature classifiers, CSV row
formatters, slug minting, path-safety guard, prodclone_map merge-update) plus
the thin DB-facing helpers that wire them together. The pure functions are
unit-tested without a database; ``fetch_*``/``run_survey``/``run_extract``
need a live connection and are covered by ONE integration test.

CRITICAL privacy rules (see delphi/tests/test_prodclone_extract.py and the
project CLAUDE.md for the full policy):

- Output goes ONLY under ``<out_root>/.local/`` (the caller-supplied root —
  ``REAL_DATA_ROOT`` by default, overridable for tests) — :func:`assert_under_local`
  is the hard guard; every write path routes through it.
- Minted slugs are neutral (``pc-<feature>-<NN>``); the on-disk directory
  prefix is a salted hash of the zid (:func:`fake_report_prefix`), never the
  real report id.
- The slug→zid mapping lives ONLY in ``prodclone_map.json`` (merge-update,
  never clobber — see :func:`merge_prodclone_map`).
- Comment text is REDACTED in the export (``comment-body`` column present but
  always empty) — the math pipeline never reads it.
"""

from __future__ import annotations

import csv
import hashlib
import json
import re
from pathlib import Path
from typing import Any, Iterable


class NullVoteError(ValueError):
    """A raw ``votes.vote`` was NULL where an export row was being formatted.

    The export CSV column is parsed as an integer by every consumer
    (``real_data.load_export_votes`` and the Clojure replay driver), and every
    integer already means something — 0 is "pass", not "unknown" — so there is
    no value that can stand in for a NULL. This is a typed refusal raised
    BEFORE any row is written, not a ``TypeError`` from unary negation partway
    through a file.
    """


# ---------------------------------------------------------------------------
# Feature classes + thresholds (module constants — the single source of truth
# for both the classifier and the prodclone_map.json "filters" audit trail).
# ---------------------------------------------------------------------------

FEATURES: tuple[str, ...] = (
    "modheavy", "revote", "banned", "meta", "zerovote", "smallmix", "midmix",
)

MODHEAVY_MIN_FRAC = 0.20
"""A conversation qualifies as modheavy when >=20% of its comments are
moderated-out (comments.mod = -1)."""

REVOTE_MIN_FRAC = 0.10
"""A conversation qualifies as revote-heavy when >=10% of its votes are
revotes (a later occurrence of an already-seen (pid, tid) pair)."""

SMALL_MAX_VOTES = 5_000
"""Upper bound (inclusive) of the 'small' conversation size class."""

MEDIUM_MAX_VOTES = 50_000
"""Upper bound (inclusive) of the 'medium' conversation size class."""

FAKE_PREFIX_SALT = "polis-prodclone-extract-v1"
"""Fixed salt for :func:`fake_report_prefix`. Not a secret — it just keeps the
fake report-id prefix from being a trivial function of the zid alone; the
real zid↔slug mapping lives only in prodclone_map.json."""

_FAKE_PREFIX_HEX_LEN = 12

_SLUG_RE_TEMPLATE = r"^pc-{feature}-(\d+)$"


def _thresholds() -> dict[str, Any]:
    """Snapshot of the threshold constants, for the prodclone_map.json audit
    trail (so a future reader can see what filters produced a given slug
    without re-reading this module's source)."""
    return {
        "modheavy_min_frac": MODHEAVY_MIN_FRAC,
        "revote_min_frac": REVOTE_MIN_FRAC,
        "small_max_votes": SMALL_MAX_VOTES,
        "medium_max_votes": MEDIUM_MAX_VOTES,
    }


# ---------------------------------------------------------------------------
# SQL builders — pure string construction, no DB required to test.
# ---------------------------------------------------------------------------


def sql_conversation_stats() -> str:
    """One aggregate query, one row per conversation, covering every stat the
    feature classifiers need. No zid parameter — the caller filters/classifies
    in Python (keeps the classifier pure and DB-independent)."""
    return """
        SELECT
            c.zid AS zid,
            COALESCE(v.n_votes, 0) AS n_votes,
            COALESCE(v.n_revotes, 0) AS n_revotes,
            COALESCE(p.n_ptpts, 0) AS n_ptpts,
            COALESCE(cm.n_comments, 0) AS n_comments,
            COALESCE(cm.n_mod_out, 0) AS n_mod_out,
            COALESCE(cm.has_meta, false) AS has_meta,
            COALESCE(b.has_banned_voter, false) AS has_banned_voter
        FROM conversations c
        LEFT JOIN (
            SELECT zid,
                   COUNT(*) AS n_votes,
                   COUNT(*) - COUNT(DISTINCT (pid, tid)) AS n_revotes
            FROM votes
            GROUP BY zid
        ) v ON v.zid = c.zid
        LEFT JOIN (
            SELECT zid, COUNT(*) AS n_ptpts
            FROM participants
            GROUP BY zid
        ) p ON p.zid = c.zid
        LEFT JOIN (
            SELECT zid,
                   COUNT(*) AS n_comments,
                   COUNT(*) FILTER (WHERE mod = -1) AS n_mod_out,
                   BOOL_OR(is_meta) AS has_meta
            FROM comments
            GROUP BY zid
        ) cm ON cm.zid = c.zid
        LEFT JOIN (
            SELECT DISTINCT v2.zid, true AS has_banned_voter
            FROM votes v2
            JOIN participants pp ON pp.zid = v2.zid AND pp.pid = v2.pid
            WHERE pp.mod = -1
        ) b ON b.zid = c.zid
    """


def sql_votes_export() -> str:
    """FULL revote history for one conversation, ordered by created ASC with
    a ``ctid`` tiebreak for deterministic chronological ordering on ties
    (mirrors the ``ORDER BY created ASC, ctid ASC`` convention already used
    elsewhere in this codebase, e.g. tests/test_generator_vote_copy.py). No
    dedup — every row survives."""
    return """
        SELECT tid, pid, vote, created
        FROM votes
        WHERE zid = %s
        ORDER BY created ASC, ctid ASC
    """


def sql_comments_export() -> str:
    """``is_meta``/``modified`` are additive (MOD_RESTART_PORT_SPEC.md "Data"
    bullet) — the replay harness's moderation-interleave source
    (real_data.py's mod-event loader reads them as ``is-meta``/``modified``
    on the exported CSV)."""
    return """
        SELECT tid, pid, created, mod, is_meta, modified
        FROM comments
        WHERE zid = %s
        ORDER BY tid ASC
    """


def sql_comment_vote_counts() -> str:
    """Agrees/disagrees per comment, counted over ALL vote rows (including
    revotes) — mirrors server/src/report.ts's sendCommentSummary, which
    increments per raw vote row with no dedup."""
    return """
        SELECT tid,
               COUNT(*) FILTER (WHERE vote = -1) AS agrees,
               COUNT(*) FILTER (WHERE vote = 1) AS disagrees
        FROM votes
        WHERE zid = %s
        GROUP BY tid
    """


# ---------------------------------------------------------------------------
# Feature classifiers — pure functions over aggregate stats dicts.
# ---------------------------------------------------------------------------


def classify_conversation(stats: dict[str, Any]) -> dict[str, float | None]:
    """Classify one conversation's aggregate stats against every feature
    class. Returns ``{feature: metric_or_None}`` — ``None`` means the
    conversation does not qualify for that feature; a float is the
    "suitability" metric used to sort candidates within the class.

    ``stats`` keys: zid, n_votes, n_ptpts, n_comments, n_mod_out, n_revotes,
    has_banned_voter, has_meta (see :func:`sql_conversation_stats`).
    """
    n_votes = stats["n_votes"]
    n_comments = stats["n_comments"]
    n_mod_out = stats["n_mod_out"]
    n_revotes = stats["n_revotes"]
    n_ptpts = stats["n_ptpts"]
    has_banned_voter = bool(stats["has_banned_voter"])
    has_meta = bool(stats["has_meta"])

    mod_frac = (n_mod_out / n_comments) if n_comments else 0.0
    revote_frac = (n_revotes / n_votes) if n_votes else 0.0

    is_modheavy = n_comments > 0 and mod_frac >= MODHEAVY_MIN_FRAC
    is_revote = n_votes > 0 and revote_frac >= REVOTE_MIN_FRAC
    is_banned = has_banned_voter
    is_meta = has_meta
    is_zerovote = n_votes == 0

    # "unremarkable" = none of the other interesting features apply — the
    # smallmix/midmix classes exist for plain volume coverage, not to
    # double-count conversations that are already interesting for another
    # reason.
    is_unremarkable = not (is_modheavy or is_revote or is_banned or is_meta)
    is_smallmix = is_unremarkable and 0 < n_votes <= SMALL_MAX_VOTES
    is_midmix = (
        is_unremarkable and SMALL_MAX_VOTES < n_votes <= MEDIUM_MAX_VOTES
    )

    return {
        "modheavy": mod_frac if is_modheavy else None,
        "revote": revote_frac if is_revote else None,
        # Banned/meta are presence classes (no natural fraction) — use
        # n_votes/n_comments as a "more data is more useful" tiebreak metric.
        "banned": float(n_votes) if is_banned else None,
        "meta": float(n_comments) if is_meta else None,
        # zerovote's metric is n_ptpts; survey_candidates sorts it ASCENDING
        # (fewest participants = the simplest, cleanest zero-vote exemplar).
        "zerovote": float(n_ptpts) if is_zerovote else None,
        "smallmix": float(n_votes) if is_smallmix else None,
        "midmix": float(n_votes) if is_midmix else None,
    }


# Features whose candidate list is sorted ascending by metric (simplest
# exemplar first) rather than the default descending (most-pronounced /
# most-data first).
_ASCENDING_FEATURES = frozenset({"zerovote"})


def survey_candidates(rows: Iterable[dict[str, Any]], limit: int) -> dict[str, list[dict[str, Any]]]:
    """Classify + sort + truncate a list of per-conversation stats rows.

    Returns ``{feature: [{zid, n_votes, n_ptpts, n_comments, metric}, ...]}``
    with every list already sorted by suitability and capped at ``limit``.
    No topic/description/text ever touches this function — only the numeric
    columns the spec allows in survey output.
    """
    rows = list(rows)
    result: dict[str, list[dict[str, Any]]] = {f: [] for f in FEATURES}
    for stats in rows:
        metrics = classify_conversation(stats)
        for feature, metric in metrics.items():
            if metric is None:
                continue
            result[feature].append({
                "zid": stats["zid"],
                "n_votes": stats["n_votes"],
                "n_ptpts": stats["n_ptpts"],
                "n_comments": stats["n_comments"],
                "metric": metric,
            })
    for feature in FEATURES:
        reverse = feature not in _ASCENDING_FEATURES
        result[feature].sort(key=lambda c: c["metric"], reverse=reverse)
        result[feature] = result[feature][:limit]
    return result


def size_class_counts(rows: Iterable[dict[str, Any]]) -> dict[str, int]:
    """Counts of conversations by vote-count size bucket (informational —
    printed alongside the per-feature survey, independent of feature class)."""
    small = medium = large = 0
    for stats in rows:
        n = stats["n_votes"]
        if n <= SMALL_MAX_VOTES:
            small += 1
        elif n <= MEDIUM_MAX_VOTES:
            medium += 1
        else:
            large += 1
    return {"small": small, "medium": medium, "large": large}


# ---------------------------------------------------------------------------
# Slug minting + fake report-id prefix.
# ---------------------------------------------------------------------------


def next_free_slug(feature: str, existing_slugs: Iterable[str]) -> str:
    """Mint the next free ``pc-<feature>-NN`` slug — the smallest 2-digit
    (or wider, once >99) number not already used for this feature."""
    pattern = re.compile(_SLUG_RE_TEMPLATE.format(feature=re.escape(feature)))
    used: set[int] = set()
    for slug in existing_slugs:
        m = pattern.match(slug)
        if m:
            used.add(int(m.group(1)))
    n = 1
    while n in used:
        n += 1
    width = 2 if n < 100 else len(str(n))
    return f"pc-{feature}-{n:0{width}d}"


def fake_report_prefix(zid: int, salt: str = FAKE_PREFIX_SALT) -> str:
    """Deterministic, non-reversible-looking stand-in for a real report id.

    NEVER a function of the zid alone in an obviously-invertible way, and
    NEVER the actual report id — the true zid↔slug mapping is recorded only
    in prodclone_map.json (gitignored)."""
    digest = hashlib.sha256(f"{salt}:{zid}".encode("utf-8")).hexdigest()
    return f"pcx{digest[:_FAKE_PREFIX_HEX_LEN]}"


# ---------------------------------------------------------------------------
# Path-safety guard — the hard privacy constraint.
# ---------------------------------------------------------------------------


def assert_under_local(path: Path, root: Path) -> Path:
    """Resolve ``path`` and assert it lives inside ``<root>/.local/``.

    Raises ``ValueError`` for anything else — including the real_data root
    itself, sibling directories, and ``..`` traversal escapes. This is the
    ONE guard every write path in this module routes through; never bypass
    it, even when the caller "knows" the path is safe (belt-and-braces)."""
    local_root = (root / ".local").resolve()
    resolved = path.resolve()
    if resolved != local_root and local_root not in resolved.parents:
        raise ValueError(
            f"refusing to write outside {local_root} (.local): {resolved}"
        )
    return resolved


def compute_extract_dir(out_root: Path, prefix: str, slug: str) -> Path:
    """Compute (but do not create) the extraction target directory, confined
    to ``<out_root>/.local/`` by construction and re-verified defensively via
    :func:`assert_under_local`."""
    candidate = out_root / ".local" / f"{prefix}-{slug}"
    return assert_under_local(candidate, out_root)


# ---------------------------------------------------------------------------
# CSV row formatters — mirror server/src/report.ts's export format.
# ---------------------------------------------------------------------------


def format_export_datetime(created_ms: int) -> str:
    """Human-readable rendering of a created-ms timestamp. Not parsed by any
    loader (only the numeric "timestamp" column is) — the format here just
    visually mirrors the JS ``Date.toString()`` shape seen in existing export
    samples, e.g. 'Tue Nov 19 2024 15:06:00 GMT+0000 (Coordinated Universal Time)'."""
    import time

    return time.strftime(
        "%a %b %d %Y %H:%M:%S GMT+0000 (Coordinated Universal Time)",
        time.gmtime(created_ms / 1000),
    )


def format_votes_rows(raw_rows: Iterable[dict[str, Any]]) -> list[dict[str, str]]:
    """``raw_rows``: dicts with keys tid, pid, vote (RAW db sign), created (ms).
    Returns export-format row dicts, one per input row, in the SAME order —
    no sorting, no dedup (full revote history survives verbatim). The vote
    sign is flipped (raw AGREE=-1 -> export +1), mirroring the production
    export's ``String(-row.vote)``."""
    out = []
    for row in raw_rows:
        if row["vote"] is None:
            # votes.vote is nullable. The export column is parsed as an integer
            # by every consumer, so there is no honest CSV representation of an
            # unknown vote: refuse loudly instead of raising TypeError from
            # unary negation halfway through writing the file. Callers that have
            # a declared policy filter first (see
            # fixture_extract.compat_rows_from_events).
            raise NullVoteError(
                f"votes.vote is NULL for (tid={row.get('tid')}, "
                f"pid={row.get('pid')}, created={row.get('created')}); the "
                "compatibility CSV has no representation for it and must not "
                "invent one. Apply an explicit NULL-vote policy before "
                "formatting.")
        created = row["created"]
        out.append({
            "timestamp": str(created // 1000),
            "datetime": format_export_datetime(created),
            "comment-id": str(row["tid"]),
            "voter-id": str(row["pid"]),
            "vote": str(-row["vote"]),
        })
    return out


def format_comments_rows(
    raw_rows: Iterable[dict[str, Any]],
    vote_counts: dict[int, tuple[int, int]],
) -> list[dict[str, str]]:
    """``raw_rows``: dicts with keys tid, pid, created, mod (is_meta/modified
    optional — default to False/empty so this stays usable with rows that
    don't carry them yet). ``vote_counts``: {tid: (agrees, disagrees)},
    counted over ALL vote rows (see :func:`sql_comment_vote_counts`); missing
    tids default to (0, 0).

    ``comment-body`` is ALWAYS the empty string — comment text is redacted
    per the privacy rules; the column is present (mirroring the export
    format) but never populated. ``is-meta``/``modified`` are ADDITIVE
    columns (MOD_RESTART_PORT_SPEC.md "Data" bullet) appended after the
    pre-existing ones — the replay harness's moderation-interleave source
    (real_data.py's mod-event loader)."""
    out = []
    for row in raw_rows:
        agrees, disagrees = vote_counts.get(row["tid"], (0, 0))
        created = row["created"]
        modified = row.get("modified")
        out.append({
            "timestamp": str(created // 1000),
            "datetime": format_export_datetime(created),
            "comment-id": str(row["tid"]),
            "author-id": str(row["pid"]),
            "agrees": str(agrees),
            "disagrees": str(disagrees),
            "moderated": str(row["mod"]),
            "comment-body": "",
            "is-meta": str(bool(row.get("is_meta", False))),
            "modified": "" if modified is None else str(modified),
        })
    return out


_VOTES_FIELDNAMES = ["timestamp", "datetime", "comment-id", "voter-id", "vote"]
_COMMENTS_FIELDNAMES = [
    "timestamp", "datetime", "comment-id", "author-id",
    "agrees", "disagrees", "moderated", "comment-body",
    "is-meta", "modified",
]


def write_votes_csv(path: Path, rows: list[dict[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=_VOTES_FIELDNAMES)
        writer.writeheader()
        writer.writerows(rows)


def write_comments_csv(path: Path, rows: list[dict[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=_COMMENTS_FIELDNAMES)
        writer.writeheader()
        writer.writerows(rows)


# ---------------------------------------------------------------------------
# prodclone_map.json — merge-update, never clobber.
# ---------------------------------------------------------------------------


def merge_prodclone_map(
    existing: dict[str, Any], slug: str, entry: dict[str, Any]
) -> dict[str, Any]:
    """Return a NEW dict: ``existing`` with ``slug: entry`` set/overwritten.
    Does not mutate ``existing`` — callers read-modify-write the JSON file
    with this as the pure "modify" step, so a crash between read and write
    never partially corrupts the in-memory map."""
    merged = dict(existing)
    merged[slug] = entry
    return merged


def load_prodclone_map(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    return json.loads(path.read_text())


def save_prodclone_map(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")


# ---------------------------------------------------------------------------
# DB-facing helpers — need a live psycopg2 connection.
# ---------------------------------------------------------------------------


def _rows_as_dicts(cur) -> list[dict[str, Any]]:
    columns = [d[0] for d in cur.description]
    return [dict(zip(columns, row)) for row in cur.fetchall()]


def fetch_conversation_stats(conn) -> list[dict[str, Any]]:
    """Run :func:`sql_conversation_stats` and return one dict per conversation."""
    with conn.cursor() as cur:
        cur.execute(sql_conversation_stats())
        return _rows_as_dicts(cur)


def fetch_votes(conn, zid: int) -> list[dict[str, Any]]:
    with conn.cursor() as cur:
        cur.execute(sql_votes_export(), (zid,))
        return _rows_as_dicts(cur)


def fetch_comments(conn, zid: int) -> list[dict[str, Any]]:
    with conn.cursor() as cur:
        cur.execute(sql_comments_export(), (zid,))
        return _rows_as_dicts(cur)


def fetch_comment_vote_counts(conn, zid: int) -> dict[int, tuple[int, int]]:
    with conn.cursor() as cur:
        cur.execute(sql_comment_vote_counts(), (zid,))
        return {row["tid"]: (row["agrees"], row["disagrees"]) for row in _rows_as_dicts(cur)}


def run_survey(conn, limit: int) -> dict[str, Any]:
    """Fetch stats for every conversation, classify, and return the full
    survey result (candidates per feature + size-class counts + the
    threshold constants used, for the audit-trail JSON)."""
    from datetime import datetime, timezone

    stats = fetch_conversation_stats(conn)
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "n_conversations": len(stats),
        "size_classes": {
            "small_max_votes": SMALL_MAX_VOTES,
            "medium_max_votes": MEDIUM_MAX_VOTES,
            "counts": size_class_counts(stats),
        },
        "thresholds": _thresholds(),
        "candidates": survey_candidates(stats, limit=limit),
    }


def run_extract(
    conn, *, zid: int, feature: str, out_root: Path, map_path: Path | None = None,
) -> dict[str, Any]:
    """Extract one conversation's votes + comments into
    ``<out_root>/.local/<fake-prefix>-<slug>/`` and merge-update
    prodclone_map.json. Returns ``{slug, dir, entry}``.

    ``map_path`` defaults to ``<out_root>/.local/prodclone_map.json``.
    """
    if feature not in FEATURES:
        raise ValueError(f"unknown feature {feature!r}; must be one of {FEATURES}")
    if out_root.exists() and not out_root.is_dir():
        raise NotADirectoryError(f"out_root must be a directory: {out_root}")
    if map_path is None:
        map_path = out_root / ".local" / "prodclone_map.json"

    existing_map = load_prodclone_map(map_path)
    slug = next_free_slug(feature, existing_map.keys())
    prefix = fake_report_prefix(zid)
    target_dir = compute_extract_dir(out_root, prefix, slug)

    votes_raw = fetch_votes(conn, zid)
    comments_raw = fetch_comments(conn, zid)
    vote_counts = fetch_comment_vote_counts(conn, zid)

    votes_rows = format_votes_rows(votes_raw)
    comments_rows = format_comments_rows(comments_raw, vote_counts)

    dir_name = target_dir.name  # "<prefix>-<slug>"
    write_votes_csv(target_dir / f"{dir_name}-votes.csv", votes_rows)
    write_comments_csv(target_dir / f"{dir_name}-comments.csv", comments_rows)

    from datetime import datetime, timezone

    entry = {
        "zid": zid,
        "feature": feature,
        "extracted_at": datetime.now(timezone.utc).isoformat(),
        "n_votes": len(votes_rows),
        "n_comments": len(comments_rows),
        "filters": _thresholds(),
    }
    merged_map = merge_prodclone_map(existing_map, slug, entry)
    save_prodclone_map(map_path, merged_map)

    return {"slug": slug, "dir": str(target_dir), "entry": entry}
