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
from typing import TYPE_CHECKING, Any, Iterable, Sequence

if TYPE_CHECKING:  # psycopg2 is a runtime dependency of the CALLER, not of this
    # module: it only ever receives an already-open connection/cursor.
    from psycopg2.extensions import connection as PgConnection
    from psycopg2.extensions import cursor as PgCursor

from polismath.replay import prodclone as pc
from polismath.utils.vote_convention import (
    EXPORT_AGREE_VALUE,
    STORAGE_AGREE_VALUE,
    validate_storage_agree_value,
)

#: Bumped to /2 by the lossless correction: ``weight_x_32767`` and ``vote`` are
#: NULLABLE in the stream. /1 coerced a NULL weight to 0, which silently
#: rewrote a distinct storage fact.
EVENT_STREAM_SCHEMA_VERSION = "certify-events/2"

#: Raw storage sign of an AGREE vote (``server/postgres/migrations/000000_initial.sql``:
#: "-1 = Agree, 1 = Disagree, 0 = Pass/Unsure"), and the export CSV's own
#: (semantic) sign. Both are RE-EXPORTED from the ONE authoritative definition
#: (``polismath.utils.vote_convention``) rather than restated as literals here
#: — P-022-G rev4 allows exactly one Python definition, and every consumer
#: takes the value through a validated argument. Production extraction remains
#: -1 until the separately approved P-023 storage migration.

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


#: Only a TOTAL, unconditional, always-defined unique key can promise that two
#: extractions of the same rows tie-break identically. The catalog query is
#: therefore narrow on purpose:
#:
#: * ``i.indisvalid AND i.indislive`` — an index still being built, or left
#:   INVALID by a failed CONCURRENTLY build, enforces nothing;
#: * ``i.indpred IS NULL`` — a PARTIAL unique index is unique only over the rows
#:   it covers, so it is not a key for the table;
#: * ``i.indexprs IS NULL`` — an EXPRESSION index keys a computed value, which
#:   is not a column ordering the extractor can emit;
#: * ``k.ord <= i.indnkeyatts`` — INCLUDE columns are payload, not key columns,
#:   and must not be mistaken for part of the uniqueness guarantee;
#: * ``bool_and(a.attnotnull)`` — in Postgres, NULLs are DISTINCT by default, so
#:   a unique index over a nullable column does not exclude duplicate NULL rows.
#:
#: Anything that fails these tests leaves the guarantee at
#: ``frozen-extract-order``, which is honest, rather than claiming a stronger
#: one the schema does not provide.
_SQL_UNIQUE_INDEXES = """
    SELECT i.indisprimary,
           array_agg(a.attname ORDER BY k.ord) AS cols,
           bool_and(a.attnotnull) AS all_not_null
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
    WHERE c.relname = %s AND n.nspname = 'public'
      AND i.indisunique
      AND i.indisvalid
      AND i.indislive
      AND i.indpred IS NULL
      AND i.indexprs IS NULL
      AND k.ord <= i.indnkeyatts
      AND a.attnum > 0
      AND NOT a.attisdropped
    GROUP BY i.indexrelid, i.indisprimary
    HAVING bool_and(a.attnotnull)
    ORDER BY i.indisprimary DESC
"""

#: An identity/serial DEFAULT is not a uniqueness constraint: a serial column
#: accepts an explicit duplicate value and a NULL unless something else forbids
#: it. A surrogate column is only accepted as the tie key when a qualifying
#: unique index above is keyed on exactly that column.
_SQL_SURROGATE_COLUMNS = """
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = %s
      AND (is_identity = 'YES' OR column_default LIKE 'nextval(%%')
      AND is_nullable = 'NO'
    ORDER BY ordinal_position
"""


def detect_tie_key(conn: PgConnection, table: str = "votes") -> dict[str, Any]:
    """Inspect the LIVE schema for a stable tie key on ``table``.

    Returns ``{"available", "columns", "method", "order_by", "guarantee",
    "note"}``. ``order_by`` is the SQL fragment the extractor must use.
    """
    with conn.cursor() as cur:
        cur.execute(_SQL_UNIQUE_INDEXES, (table,))
        uniques = [(bool(r[0]), list(r[1])) for r in cur.fetchall()]
        cur.execute(_SQL_SURROGATE_COLUMNS, (table,))
        surrogates = [r[0] for r in cur.fetchall()]

    # A surrogate column is a tie key ONLY when a qualifying unique key is keyed
    # on exactly that column. An identity/serial default alone guarantees
    # nothing: an explicit INSERT can repeat the value.
    unique_single_cols = {cols[0] for _, cols in uniques if len(cols) == 1}
    for col in surrogates:
        if col in unique_single_cols:
            return {
                "available": True,
                "columns": [col],
                "method": "identity-or-serial-column",
                "order_by": f"created ASC, {col} ASC",
                "guarantee": "stable-tie-key",
                "note": f"{table}.{col} is an identity/serial surrogate AND is "
                        "covered by a valid, unconditional, non-nullable unique "
                        "index; it is a portable event identity and survives a "
                        "re-restore of the snapshot.",
            }
    for is_primary, cols in uniques:
        return {
            "available": True,
            "columns": cols,
            "method": "primary-key" if is_primary else "unique-index",
            "order_by": "created ASC, " + ", ".join(f"{c} ASC" for c in cols),
            "guarantee": "stable-tie-key",
            "note": f"{table} has a valid, unconditional, non-partial, "
                    f"non-expression, NOT NULL "
                    f"{'primary key' if is_primary else 'unique index'} on {cols} "
                    "(INCLUDE columns excluded); used as the portable tie key.",
        }
    if surrogates:
        # Present but unqualified: say so, rather than silently reporting the
        # generic no-key note and hiding the near miss from the next reviewer.
        return {
            "available": False,
            "columns": [],
            "method": "physical-ctid",
            "order_by": "created ASC, ctid ASC",
            "guarantee": "frozen-extract-order",
            "note": (
                f"{table} has identity/serial column(s) {surrogates} but NO valid, "
                "unconditional, non-nullable unique index keyed on one of them, so "
                "they are not a uniqueness guarantee and are NOT used as a tie key. "
                "The extract order (created ASC, ctid ASC) is FROZEN into the bundle "
                "bytes and is authoritative for every replay; re-restoring the "
                "snapshot need not reproduce ctid order."
            ),
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
            # NULL is a DISTINCT storage fact and survives as null. `or 0`
            # collapsed NULL and 0 into the same value; a weight of 0 is also
            # falsy, so it collapsed a real zero weight too.
            "vote": None if row["vote"] is None else int(row["vote"]),
            "weight_x_32767": (None if row["weight_x_32767"] is None
                               else int(row["weight_x_32767"])),
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
        # A NULL vote is an UNKNOWN value, not an opposite one: counting it as a
        # disagreement would inflate the ambiguity census with rows that carry
        # no direction at all. It is counted separately instead.
        "opposite_votes": sum(
            1 for v in by_cell.values()
            if len({x for x in v if x is not None}) > 1),
        "null_votes": sum(1 for v in by_cell.values() for x in v if x is None),
        "cells_with_null_vote": sum(
            1 for v in by_cell.values() if any(x is None for x in v)),
        "unit": "(pid, tid, created) GROUPS, not vote events; "
                "second-truncated collisions are a different, larger population "
                "and are never measured from the compatibility CSVs",
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
    storage_agree_value: int = STORAGE_AGREE_VALUE,
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
            "storage_agree_value": storage_agree_value,
            "export_agree_value": EXPORT_AGREE_VALUE,
            "events_carry": "raw storage sign, unmodified",
            "compat_csv_carries": "semantic sign (raw x storage_agree_value), "
                                  "matching the production export",
        },
        "nullability": {
            "vote": "NULLABLE. votes.vote has no NOT NULL constraint; a NULL "
                    "survives into this stream as JSON null and is NEVER coerced "
                    "to 0 (which would mean 'pass'). The compatibility CSV cannot "
                    "represent it — see compat_csv.null_vote_policy.",
            "weight_x_32767": "NULLABLE. A NULL weight survives as JSON null. It "
                              "is a distinct storage fact from a weight of 0 and "
                              "the two must not be merged. The compatibility CSV "
                              "has no weight column at all, so the event stream "
                              "is the only lossless carrier.",
            "created": "NOT NULL in practice and required by the stream; an "
                       "absent created would fail extraction rather than default.",
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


#: What the compatibility CSV does with a NULL ``votes.vote``. The event stream
#: keeps the null; the CSV cannot.
COMPAT_NULL_VOTE_POLICY = "drop-counted"


def compat_rows_from_events(
    events: Sequence[dict[str, Any]],
    *, storage_agree_value: int = STORAGE_AGREE_VALUE,
) -> tuple[list[dict[str, str]], list[dict[str, str]], dict[str, Any]]:
    """Derive the compatibility votes/comments CSV rows FROM the event stream
    (never from a second query), reusing the existing formatters so the export
    format and the polarity flip stay in one place.

    Returns ``(votes_rows, comments_rows, compat_census)``.

    NULL VOTES. ``votes.vote`` is nullable in the production schema and the
    event stream keeps the null verbatim. The compatibility CSV cannot: its only
    consumers parse the column as an integer —
    ``real_data.load_export_votes`` does ``int(row["vote"])`` and the Clojure
    replay driver reads the same file — so an empty cell or a ``null`` marker
    would be a parse error at every reader, and any placeholder integer would be
    a FABRICATED vote (0 is "pass", not "unknown").

    The policy is therefore ``drop-counted``: NULL-vote rows are OMITTED from
    the compatibility CSV and COUNTED. The count is recorded in
    ``events.meta.json`` and in the manifest role entry, and a nonzero count
    makes the compatibility export NON-CERTIFYING — :func:`fixture_bundle.
    admit_manifest` rejects the bundle unless an operator has explicitly
    accepted the drop. NULL never becomes pass, and never silently disappears.
    """
    vote_events = [e for e in events if e["kind"] == "vote"]
    comment_events = [e for e in events if e["kind"] == "comment"]

    votable = [e for e in vote_events if e["vote"] is not None]
    null_vote_events = [e for e in vote_events if e["vote"] is None]

    agree = validate_storage_agree_value(storage_agree_value)
    votes_rows = pc.format_votes_rows([
        {"tid": e["tid"], "pid": e["pid"], "vote": e["vote"], "created": e["created"]}
        for e in votable
    ], storage_agree_value=agree)

    compat_census = {
        "null_vote_policy": COMPAT_NULL_VOTE_POLICY,
        "storage_agree_value": agree,
        "null_votes_dropped": len(null_vote_events),
        "null_vote_ordinals": [e["ord"] for e in null_vote_events[:64]],
        "null_vote_cells": sorted({(e["pid"], e["tid"]) for e in null_vote_events})[:64],
        "vote_rows_written": len(votes_rows),
        "certifying": not null_vote_events,
        "note": "the authoritative event stream keeps every NULL vote; the "
                "compatibility CSV omits them because its readers parse the "
                "column as an integer, and a nonzero drop count makes this "
                "export non-certifying",
        "null_weight_mapping": "the compatibility CSV has NO weight column at "
                               "all; weight (including NULL) lives only in the "
                               "event stream, which is authoritative",
    }

    counts: dict[int, list[int]] = {}
    for e in votable:
        entry = counts.setdefault(e["tid"], [0, 0])
        if e["vote"] == agree:
            entry[0] += 1
        elif e["vote"] == -agree:
            entry[1] += 1
    vote_counts = {tid: (a, d) for tid, (a, d) in counts.items()}

    comments_rows = pc.format_comments_rows([
        {"tid": e["tid"], "pid": e["pid"], "created": e["created"],
         "mod": e["mod"], "is_meta": e["is_meta"], "modified": e["modified"]}
        for e in comment_events
    ], vote_counts)
    return votes_rows, comments_rows, compat_census


# ---------------------------------------------------------------------------
# DB-facing extraction of one conversation.
# ---------------------------------------------------------------------------


def _rows_as_dicts(cur: PgCursor) -> list[dict[str, Any]]:
    columns = [d[0] for d in cur.description]
    return [dict(zip(columns, row)) for row in cur.fetchall()]


def fetch_conversation(conn: PgConnection, zid: int, tie_key: dict[str, Any]) -> dict[str, list]:
    with conn.cursor() as cur:
        cur.execute(sql_vote_events(tie_key["order_by"]), (zid,))
        votes = _rows_as_dicts(cur)
        cur.execute(sql_comment_rows(), (zid,))
        comments = _rows_as_dicts(cur)
        cur.execute(sql_participant_flags(), (zid,))
        participants = _rows_as_dicts(cur)
    return {"votes": votes, "comments": comments, "participants": participants}


def extract_conversation(
    conn: PgConnection, *, zid: int, slug: str, role: str, payload_root: Path, guard_root: Path,
    dir_name: str, tie_key: dict[str, Any], measured: dict[str, Any] | None = None,
    storage_agree_value: int = STORAGE_AGREE_VALUE,
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
                       n_participants=len(raw["participants"]),
                       storage_agree_value=storage_agree_value)

    target.mkdir(parents=True, exist_ok=True)
    write_events_jsonl(target / "events.jsonl", events)
    (target / "events.meta.json").write_text(
        json.dumps(meta, indent=2, sort_keys=True) + "\n")
    write_participants_csv(target / "participants.csv", raw["participants"])

    votes_rows, comments_rows, compat = compat_rows_from_events(
        events, storage_agree_value=storage_agree_value)
    meta["compat_csv"] = compat
    (target / "events.meta.json").write_text(
        json.dumps(meta, indent=2, sort_keys=True) + "\n")
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
        "compat": {k: v for k, v in compat.items()
                   if k in ("null_vote_policy", "null_votes_dropped",
                            "vote_rows_written", "certifying")},
        "nullable": meta["nullability"],
    }
    if measured is not None:
        summary["measured_metrics"] = {k: v for k, v in measured.items() if k != "zid"}
    return summary


# ---------------------------------------------------------------------------
# Whole-config extraction: ONE transaction, survey -> select -> extract.
# ---------------------------------------------------------------------------


def extract_from_config(
    conn: PgConnection, *, config: dict[str, Any], payload_root: Path, guard_root: Path,
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

    # A synthetic substitute is not a substitute until it EXISTS. Materialise
    # every generator case a synthetic role depends on, whatever --no-generated
    # or the non-heavy default would otherwise do, and pin its directory into
    # the role entry so the manifest cannot record a role with dir:null.
    required_cases = sorted({
        sel.synthetic_replacement for sel in selections
        if sel.zid is None and sel.synthetic_replacement
    })
    generated_summaries: list[dict[str, Any]] = fg.write_all(
        config["generated"], payload_root, guard_root,
        include_heavy=include_heavy,
        only=None if include_generated else [],
        force=required_cases,
    )
    case_by_id = {c["id"]: c for c in config["generated"]["cases"]}
    substitute_dirs = {
        case_id: fg.generate_case_dirs(case_by_id[case_id])[0]
        for case_id in required_cases if case_id in case_by_id
    }
    substitute_metrics = {
        case_id: next(
            (s.get("measured_metrics", {}) for s in generated_summaries
             if s.get("dir") == substitute_dirs.get(case_id)), {})
        for case_id in required_cases
    }

    role_summaries: list[dict[str, Any]] = []
    provenance_rows: list[dict[str, Any]] = []
    for sel in selections:
        if sel.zid is None:
            case_id = sel.synthetic_replacement
            case = case_by_id.get(case_id, {})
            role_summaries.append({
                "slug": sel.slug, "role": sel.role, "group": sel.group,
                "rank": sel.rank,
                "dir": substitute_dirs.get(case_id),
                "source": "synthetic-replacement",
                "synthetic_replacement": case_id,
                "approval": "explicitly accepted by the operator "
                            "(--accept-synthetic); production supplied no candidate",
                "failed_production_predicate": [
                    dict(p) for p in
                    next((r["predicates"] for r in config["roles"]
                          if r["slug"] == sel.slug), [])
                ],
                "generator": {
                    "generator_id": config["generated"]["generator_id"],
                    "generator_version": config["generated"]["generator_version"],
                    "seed": config["generated"]["seed"],
                    "case_id": case_id,
                    "shape": case.get("shape"),
                },
                "measured_metrics": substitute_metrics.get(case_id, {}),
                "coverage_limits":
                    "SYNTHETIC. This case exercises the declared stress predicate; "
                    "it is NOT evidence that production carries the same geometry.",
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
