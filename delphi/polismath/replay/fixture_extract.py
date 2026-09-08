"""Lossless private event-stream extraction for the certification bundle.

P-022 section A ("Retain original full revote history"). The existing exporter
(:mod:`polismath.replay.prodclone`) rounds milliseconds to seconds in CSV and
orders by ``created, ctid``; ctid is a PHYSICAL locator, not a portable event
identity, and seconds cannot test the polling boundary. This module adds the
lossless stream and derives the compatibility CSVs FROM it, so the two can
never disagree.

Per selected conversation the extractor writes, into one opaque directory:

``events.jsonl``
    One JSON object per event, in extraction order. Integer-millisecond
    ``created``, original typed ``pid``/``tid``, explicit ``ord`` ordinal, and
    ``src`` provenance (source table + row index within its ordered query).
    Vote and moderation events share the stream.
``events.meta.json``
    Stream schema version, the ordering key actually used, the TIE-ORDER
    GUARANTEE (see below), timestamp precision, storage/export polarity, the
    equal-time ambiguity census, and the logical digest.
``participants.csv``
    Participant moderation flags (``pid``, ``mod``, ``created``) — state the
    votes/comments CSV pair cannot independently exercise.
``<dir>-votes.csv`` / ``<dir>-comments.csv``
    The compatibility export CSVs the existing replay tools read, generated
    from the event stream. Comment text is blanked (column present, always
    empty).

TIE ORDER. :func:`detect_tie_key` inspects the LIVE schema for a stable tie
key on ``votes`` (a primary key, a unique index, or an identity/serial
surrogate column). If one exists it is used and recorded as
``guarantee = "stable-tie-key"``. If none exists the extract order is FROZEN
into the bundle bytes and recorded as ``guarantee = "frozen-extract-order"``,
with the explicit statement that re-restoring the snapshot need not reproduce
ctid order. The frozen bytes remain fully reproducible as test inputs.

Equal-time opposite votes are counted, never reordered: the census in
``events.meta.json`` is the input to the separately specified contract/test.
No historical order is invented.
"""

from __future__ import annotations

import hashlib
import json
import secrets
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Sequence

from polismath.replay import prodclone as pc

EVENT_STREAM_SCHEMA_VERSION = "certify-events/1"

#: Raw storage sign of an AGREE vote (``server/postgres/migrations/000000_initial.sql``:
#: "-1 = Agree, 1 = Disagree, 0 = Pass/Unsure"). The export CSV negates it.
STORAGE_AGREE_VALUE = -1
EXPORT_AGREE_VALUE = 1

_OPAQUE_PREFIX_BYTES = 8  # 16 hex characters


class TieOrderUnstable(RuntimeError):
    """Raised only when a caller demanded a stable tie key and none exists."""


# ---------------------------------------------------------------------------
# Opaque fixture directory names.
# ---------------------------------------------------------------------------


def mint_opaque_dir(slug: str) -> str:
    """A RANDOM opaque fixture directory name, ``<16 hex>-<slug>``.

    Random, not a fixed-salt hash of the zid: a public salt makes the old
    prefix a trivially checkable function of a guessed zid. The assignment is
    recorded in the immutable manifest, so a repeat extraction reuses the
    name rather than minting a new one. The ``-<slug>`` suffix keeps
    ``real_data.dataset_dir``'s ``*-<slug>`` glob working unchanged.
    """
    return f"{secrets.token_hex(_OPAQUE_PREFIX_BYTES)}-{slug}"


# ---------------------------------------------------------------------------
# Live-schema tie-key discovery.
# ---------------------------------------------------------------------------


_SQL_UNIQUE_INDEXES = """
    SELECT i.indisprimary,
           array_agg(a.attname ORDER BY k.ord) AS cols
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
    WHERE c.relname = %s AND n.nspname = 'public' AND i.indisunique
    GROUP BY i.indexrelid, i.indisprimary
    ORDER BY i.indisprimary DESC
"""

_SQL_SURROGATE_COLUMNS = """
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = %s
      AND (is_identity = 'YES' OR column_default LIKE 'nextval(%%')
    ORDER BY ordinal_position
"""


def detect_tie_key(conn, table: str = "votes") -> dict[str, Any]:
    """Inspect the LIVE schema for a stable tie key on ``table``.

    Returns ``{"available", "columns", "method", "order_by", "guarantee",
    "note"}``. ``order_by`` is the SQL fragment the extractor must use.
    """
    with conn.cursor() as cur:
        cur.execute(_SQL_UNIQUE_INDEXES, (table,))
        uniques = [(bool(r[0]), list(r[1])) for r in cur.fetchall()]
        cur.execute(_SQL_SURROGATE_COLUMNS, (table,))
        surrogates = [r[0] for r in cur.fetchall()]

    if surrogates:
        col = surrogates[0]
        return {
            "available": True,
            "columns": [col],
            "method": "identity-or-serial-column",
            "order_by": f"created ASC, {col} ASC",
            "guarantee": "stable-tie-key",
            "note": f"{table}.{col} is an identity/serial surrogate; it is a portable "
                    "event identity and survives a re-restore of the snapshot.",
        }
    for is_primary, cols in uniques:
        return {
            "available": True,
            "columns": cols,
            "method": "primary-key" if is_primary else "unique-index",
            "order_by": "created ASC, " + ", ".join(f"{c} ASC" for c in cols),
            "guarantee": "stable-tie-key",
            "note": f"{table} has a {'primary key' if is_primary else 'unique index'} "
                    f"on {cols}; used as the portable tie key.",
        }
    return {
        "available": False,
        "columns": [],
        "method": "physical-ctid",
        "order_by": "created ASC, ctid ASC",
        "guarantee": "frozen-extract-order",
        "note": (
            f"{table} has no primary key, unique index or identity/serial column, so "
            "there is NO portable event identity. The extract order (created ASC, "
            "ctid ASC) is FROZEN into the bundle bytes and is authoritative for every "
            "replay; re-restoring the snapshot need not reproduce ctid order. Equal-"
            "time events are therefore ordered by a physical locator, and equal-time "
            "opposite votes are counted in the ambiguity census rather than assigned "
            "an invented historical order."
        ),
    }


# ---------------------------------------------------------------------------
# SQL — lossless, numeric/flag columns only (never txt).
# ---------------------------------------------------------------------------


def sql_vote_events(order_by: str) -> str:
    """Full revote history for one conversation, LOSSLESS: integer-ms
    ``created``, raw storage vote sign, weight. ``order_by`` comes from
    :func:`detect_tie_key` (validated by the caller — never user input)."""
    return f"""
        SELECT pid, tid, vote, weight_x_32767, created
        FROM votes
        WHERE zid = %s
        ORDER BY {order_by}
    """


def sql_comment_rows() -> str:
    """Comment state + latest modification time. NOTE: this is CURRENT STATE,
    not a history of every moderation action (``prodclone.py:144``). ``txt`` is
    never selected."""
    return """
        SELECT tid, pid, created, modified, mod, is_meta
        FROM comments
        WHERE zid = %s
        ORDER BY tid ASC
    """


def sql_participant_flags() -> str:
    return """
        SELECT pid, mod, created
        FROM participants
        WHERE zid = %s
        ORDER BY pid ASC
    """


# ---------------------------------------------------------------------------
# Event construction — pure.
# ---------------------------------------------------------------------------


def build_events(
    vote_rows: Sequence[dict[str, Any]],
    comment_rows: Sequence[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Build the ordered lossless event stream.

    Vote events come first in source order (the frozen/tie-keyed votes order),
    then the moderation events derived from comment CURRENT STATE in ``tid``
    order. ``ord`` is an explicit global ordinal; ``src`` records the source
    table and the row's index within its own ordered query, so an event can
    always be traced back to the row it came from.
    """
    events: list[dict[str, Any]] = []
    for i, row in enumerate(vote_rows):
        events.append({
            "ord": len(events),
            "kind": "vote",
            "created": int(row["created"]),
            "pid": int(row["pid"]),
            "tid": int(row["tid"]),
            "vote": int(row["vote"]) if row["vote"] is not None else None,
            "weight_x_32767": int(row["weight_x_32767"] or 0),
            "src": {"table": "votes", "row": i},
        })
    for i, row in enumerate(comment_rows):
        modified = row.get("modified")
        events.append({
            "ord": len(events),
            "kind": "comment",
            "created": int(row["created"]),
            "modified": None if modified is None else int(modified),
            "pid": int(row["pid"]),
            "tid": int(row["tid"]),
            "mod": int(row["mod"]),
            "is_meta": bool(row["is_meta"]),
            "src": {"table": "comments", "row": i},
        })
    return events


def equal_time_census(events: Iterable[dict[str, Any]]) -> dict[str, Any]:
    """Count equal-``created`` ambiguity WITHOUT reordering anything.

    ``opposite_votes`` counts (pid, tid, created) groups holding more than one
    DISTINCT vote value — the ambiguous equal-time opposite votes the spec
    requires a separately specified contract for.
    """
    by_cell: dict[tuple[int, int, int], list[int]] = {}
    by_time: dict[int, int] = {}
    for e in events:
        if e["kind"] != "vote":
            continue
        by_time[e["created"]] = by_time.get(e["created"], 0) + 1
        by_cell.setdefault((e["pid"], e["tid"], e["created"]), []).append(e["vote"])
    return {
        "vote_events": sum(by_time.values()),
        "distinct_created_values": len(by_time),
        "created_values_with_ties": sum(1 for n in by_time.values() if n > 1),
        "cells_repeated_at_same_created": sum(1 for v in by_cell.values() if len(v) > 1),
        "opposite_votes": sum(1 for v in by_cell.values() if len(set(v)) > 1),
    }


def logical_digest(events: Sequence[dict[str, Any]]) -> str:
    """SHA-256 over the LOGICAL content of the stream — ordinal plus the fields
    that carry meaning, excluding ``src`` provenance. Two extractions of the
    same snapshot under the declared tie-order guarantee must produce the same
    digest; a differing ``src`` row index alone does not."""
    h = hashlib.sha256()
    for e in events:
        h.update(json.dumps(
            {k: v for k, v in e.items() if k != "src"},
            sort_keys=True, separators=(",", ":"),
        ).encode("utf-8"))
        h.update(b"\n")
    return h.hexdigest()


def stream_meta(
    *, slug: str, role: str, tie_key: dict[str, Any],
    events: Sequence[dict[str, Any]], n_participants: int,
) -> dict[str, Any]:
    vote_events = [e for e in events if e["kind"] == "vote"]
    comment_events = [e for e in events if e["kind"] == "comment"]
    return {
        "schema_version": EVENT_STREAM_SCHEMA_VERSION,
        "slug": slug,
        "role": role,
        "timestamp_precision": "integer milliseconds since the unix epoch",
        "ordering": {
            "votes_order_by": tie_key["order_by"],
            "comments_order_by": "tid ASC",
            "stream_order": "all vote events in source order, then all comment "
                            "(moderation-state) events in tid order",
            "tie_key_available": tie_key["available"],
            "tie_key_columns": tie_key["columns"],
            "tie_key_method": tie_key["method"],
            "guarantee": tie_key["guarantee"],
            "note": tie_key["note"],
        },
        "polarity": {
            "storage_agree_value": STORAGE_AGREE_VALUE,
            "export_agree_value": EXPORT_AGREE_VALUE,
            "events_carry": "raw storage sign, unmodified",
            "compat_csv_carries": "negated sign, matching the production export",
        },
        "moderation": {
            "source": "comments current state (mod, is_meta, modified)",
            "synthesized": False,
            "note": "This is CURRENT STATE and a latest-modification time, NOT a "
                    "history of every moderation action. Any moderation TIMELINE a "
                    "schedule weaves from it is SYNTHESIZED by deterministic rule and "
                    "must be labelled as such; it is not reconstructed production "
                    "history.",
        },
        "counts": {
            "events": len(events),
            "vote_events": len(vote_events),
            "comment_events": len(comment_events),
            "participants": n_participants,
        },
        "equal_time_census": equal_time_census(events),
        "logical_digest_sha256": logical_digest(events),
        "redactions": [
            "comments.txt never selected and never written",
            "compatibility comments CSV keeps an always-empty comment-body column",
            "no zid, report id, topic, description or uid appears in any fixture file",
        ],
    }


# ---------------------------------------------------------------------------
# Writers.
# ---------------------------------------------------------------------------


def write_events_jsonl(path: Path, events: Sequence[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", newline="\n") as fh:
        for e in events:
            fh.write(json.dumps(e, sort_keys=True, separators=(",", ":")) + "\n")


def write_participants_csv(path: Path, rows: Sequence[dict[str, Any]]) -> None:
    import csv

    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=["participant-id", "moderation", "created"])
        writer.writeheader()
        for row in rows:
            writer.writerow({
                "participant-id": int(row["pid"]),
                "moderation": int(row["mod"]),
                "created": "" if row["created"] is None else int(row["created"]),
            })


def compat_rows_from_events(
    events: Sequence[dict[str, Any]],
) -> tuple[list[dict[str, str]], list[dict[str, str]]]:
    """Derive the compatibility votes/comments CSV rows FROM the event stream
    (never from a second query), reusing the existing formatters so the export
    format and the polarity flip stay in one place."""
    vote_events = [e for e in events if e["kind"] == "vote"]
    comment_events = [e for e in events if e["kind"] == "comment"]

    votes_rows = pc.format_votes_rows([
        {"tid": e["tid"], "pid": e["pid"], "vote": e["vote"], "created": e["created"]}
        for e in vote_events
    ])

    counts: dict[int, list[int]] = {}
    for e in vote_events:
        entry = counts.setdefault(e["tid"], [0, 0])
        if e["vote"] == STORAGE_AGREE_VALUE:
            entry[0] += 1
        elif e["vote"] == -STORAGE_AGREE_VALUE:
            entry[1] += 1
    vote_counts = {tid: (a, d) for tid, (a, d) in counts.items()}

    comments_rows = pc.format_comments_rows([
        {"tid": e["tid"], "pid": e["pid"], "created": e["created"],
         "mod": e["mod"], "is_meta": e["is_meta"], "modified": e["modified"]}
        for e in comment_events
    ], vote_counts)
    return votes_rows, comments_rows


# ---------------------------------------------------------------------------
# DB-facing extraction of one conversation.
# ---------------------------------------------------------------------------


def _rows_as_dicts(cur) -> list[dict[str, Any]]:
    columns = [d[0] for d in cur.description]
    return [dict(zip(columns, row)) for row in cur.fetchall()]


def fetch_conversation(conn, zid: int, tie_key: dict[str, Any]) -> dict[str, list]:
    with conn.cursor() as cur:
        cur.execute(sql_vote_events(tie_key["order_by"]), (zid,))
        votes = _rows_as_dicts(cur)
        cur.execute(sql_comment_rows(), (zid,))
        comments = _rows_as_dicts(cur)
        cur.execute(sql_participant_flags(), (zid,))
        participants = _rows_as_dicts(cur)
    return {"votes": votes, "comments": comments, "participants": participants}


def extract_conversation(
    conn, *, zid: int, slug: str, role: str, payload_root: Path, guard_root: Path,
    dir_name: str, tie_key: dict[str, Any], measured: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Extract ONE conversation into ``<payload_root>/<dir_name>/``.

    ``guard_root`` is the real_data root whose ``.local/`` subtree every write
    must stay inside; ``prodclone.assert_under_local`` is the hard guard and is
    never bypassed. Returns a manifest-safe summary — it contains NO zid.
    """
    target = pc.assert_under_local(payload_root / dir_name, guard_root)
    raw = fetch_conversation(conn, zid, tie_key)
    events = build_events(raw["votes"], raw["comments"])
    meta = stream_meta(slug=slug, role=role, tie_key=tie_key, events=events,
                       n_participants=len(raw["participants"]))

    target.mkdir(parents=True, exist_ok=True)
    write_events_jsonl(target / "events.jsonl", events)
    (target / "events.meta.json").write_text(
        json.dumps(meta, indent=2, sort_keys=True) + "\n")
    write_participants_csv(target / "participants.csv", raw["participants"])

    votes_rows, comments_rows = compat_rows_from_events(events)
    pc.write_votes_csv(target / f"{dir_name}-votes.csv", votes_rows)
    pc.write_comments_csv(target / f"{dir_name}-comments.csv", comments_rows)

    summary = {
        "slug": slug,
        "role": role,
        "dir": dir_name,
        "extracted_at": datetime.now(timezone.utc).isoformat(),
        "counts": meta["counts"],
        "logical_digest_sha256": meta["logical_digest_sha256"],
        "ordering_guarantee": meta["ordering"]["guarantee"],
        "equal_time_census": meta["equal_time_census"],
    }
    if measured is not None:
        summary["measured_metrics"] = {k: v for k, v in measured.items() if k != "zid"}
    return summary


# ---------------------------------------------------------------------------
# Whole-config extraction: ONE transaction, survey -> select -> extract.
# ---------------------------------------------------------------------------


def extract_from_config(
    conn, *, config: dict[str, Any], payload_root: Path, guard_root: Path,
    snapshot_id: str | None = None, writers_disabled: bool = False,
    dir_names: dict[str, str] | None = None,
    accept_synthetic: Sequence[str] = (),
    include_generated: bool = True, include_heavy: bool = False,
) -> dict[str, Any]:
    """Survey, select and extract every configured role in ONE read-only
    repeatable-read transaction.

    Doing all three inside a single transaction is what makes the manifest's
    transaction guarantee true: the metrics a role was selected on and the rows
    that were extracted come from exactly the same snapshot.

    ``dir_names`` — the opaque directory assignment from a PREVIOUS manifest.
    Supplying it makes a repeat extraction reuse the same names (and therefore
    the same paths) so its bytes can be compared with the original; omitting it
    mints fresh random names.

    Returns a private result dict. It contains zids (in ``provenance_rows``) and
    must be confined to ``real_data/.local/``.
    """
    from polismath.replay import fixture_generate as fg
    from polismath.replay import fixture_survey as fs

    dir_names = dict(dir_names or {})
    guarantee = fs.open_readonly_repeatable_read(
        conn, snapshot_id=snapshot_id, writers_disabled=writers_disabled)
    rows = fs.fetch_metrics(conn)
    migration_marker = None  # probing rolls back; do it outside this txn
    survey = fs.build_survey(rows, guarantee, snapshot_id=snapshot_id,
                             schema_version_marker=migration_marker)
    coverage = fs.coverage_report(config, rows)
    selections = fs.resolve_roles(config, rows, accept_synthetic=accept_synthetic)
    tie_key = detect_tie_key(conn)

    role_summaries: list[dict[str, Any]] = []
    provenance_rows: list[dict[str, Any]] = []
    for sel in selections:
        if sel.zid is None:
            role_summaries.append({
                "slug": sel.slug, "role": sel.role, "group": sel.group,
                "rank": sel.rank, "dir": None,
                "source": "synthetic-replacement",
                "synthetic_replacement": sel.synthetic_replacement,
                "approval": "explicitly accepted by the operator "
                            "(--accept-synthetic); production supplied no candidate",
                "n_candidates": sel.n_candidates,
            })
            continue
        dir_name = dir_names.setdefault(sel.slug, mint_opaque_dir(sel.slug))
        summary = extract_conversation(
            conn, zid=sel.zid, slug=sel.slug, role=sel.role,
            payload_root=payload_root, guard_root=guard_root,
            dir_name=dir_name, tie_key=tie_key, measured=sel.metrics,
        )
        summary.update({
            "group": sel.group, "rank": sel.rank, "source": "production",
            "n_candidates": sel.n_candidates, "overlaps_with": sel.overlaps_with,
        })
        role_summaries.append(summary)
        provenance_rows.append({
            "role": sel.role, "slug": sel.slug, "dir": dir_name, "zid": sel.zid})

    generated_summaries: list[dict[str, Any]] = []
    if include_generated:
        generated_summaries = fg.write_all(
            config["generated"], payload_root, guard_root,
            include_heavy=include_heavy)

    return {
        "survey": survey,
        "coverage_report": coverage,
        "transaction_guarantee": guarantee,
        "tie_key": tie_key,
        "roles": role_summaries,
        "generated": generated_summaries,
        "dir_names": dir_names,
        "provenance_rows": provenance_rows,
    }
