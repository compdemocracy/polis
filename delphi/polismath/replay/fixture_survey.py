"""Certification-fixture survey: compute the committed metrics for EVERY
conversation in one repeatable-read transaction, then resolve the committed
selection rules to zids deterministically.

P-022 section A ("Extraction and selection"). Two halves:

* SQL + metric derivation (:func:`sql_conversation_metrics`,
  :func:`derive_metrics`, :func:`fetch_metrics`) — one aggregate query, one row
  per conversation, numeric columns ONLY. No topic, description or comment text
  is ever selected, so a survey artefact can never leak conversation content.
* Rule resolution (:func:`resolve_roles`) — pure, deterministic, and it FAILS
  naming the missing role rather than downgrading to a smaller case.

Transaction guarantee. :func:`open_readonly_repeatable_read` puts the session
in ``REPEATABLE READ``/``READ ONLY`` and (optionally) imports an exported
snapshot id so a separate orchestrator session can pin survey and extraction to
the same snapshot. The chosen guarantee is returned as a record for the bundle
manifest — the alternative ("all writers disabled on the clone") is expressed
by passing ``writers_disabled=True``.

Privacy. The survey result is PRIVATE: it contains zids. Callers must confine
it to ``real_data/.local/`` (``prodclone.assert_under_local``) and must use
:func:`redact_survey` before anything is printed, logged or uploaded.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Iterable, Sequence

from polismath.replay.fixture_config import evaluate_predicates, sort_key_for

SURVEY_SCHEMA_VERSION = "certify-survey/1"

#: Executable counterpart of the config's ``metrics`` block. Keys must match
#: ``fixture_config.KNOWN_METRICS`` exactly; tests/test_certify_datasets_config.py
#: cross-checks these three sources against each other.
METRIC_DEFINITIONS: dict[str, str] = {
    "V": "COUNT(*) over votes rows (revotes included)",
    "U": "COUNT(DISTINCT (pid, tid)) over votes rows",
    "P": "COUNT(DISTINCT pid) over votes rows",
    "C": "COUNT(DISTINCT tid) over votes rows",
    "revote_share": "(V - U) / V; denominator V; None when V = 0",
    "density": "U / (P * C); denominator matrix_area; None when P * C = 0",
    "matrix_area": "P * C",
    "mod_out_share": "comments with mod = -1 / all_comments; None when all_comments = 0",
    "meta_share": "comments with is_meta / all_comments; None when all_comments = 0",
    "registered_participants": "COUNT(*) over participants rows",
    "all_comments": "COUNT(*) over comments rows",
    "math_eligible_comments": "COUNT(*) over comments with mod <> -1 AND is_meta = false",
    "eligible_participants": "COUNT(DISTINCT pid) over votes on math-eligible comments",
    "banned_voters": "COUNT(DISTINCT pid) over votes whose participants row has mod = -1",
    "mod_out_or_meta_comments": "COUNT(*) over comments with is_meta OR mod = -1 (the engine's mod-out set)",
    "zid": "the conversation's numeric identifier; tie-break only, never published",
}


class RoleUnsatisfied(RuntimeError):
    """Raised when a committed rule has no candidate at its required rank.

    Bundle construction stops here BY DESIGN: the spec forbids silently picking
    a smaller case, skipping the role, or reusing an old result.
    """

    def __init__(self, role: str, slug: str, reason: str,
                 synthetic_replacement: str | None = None):
        self.role = role
        self.slug = slug
        self.reason = reason
        self.synthetic_replacement = synthetic_replacement
        msg = f"missing role {role!r} (slug {slug}): {reason}"
        if synthetic_replacement:
            msg += (
                f"; the config offers deterministic synthetic case "
                f"{synthetic_replacement!r} as a replacement, which requires an "
                "explicit recorded approval (--accept-synthetic)"
            )
        super().__init__(msg)


# ---------------------------------------------------------------------------
# SQL — numeric columns only.
# ---------------------------------------------------------------------------


def sql_conversation_metrics() -> str:
    """One aggregate row per conversation covering every committed metric.

    Column names are the raw counts; the derived ratios are computed in Python
    by :func:`derive_metrics` so the denominators live in exactly one place.

    Schema note (verified against ``server/postgres/migrations/000000_initial.sql``):
    ``votes(zid, pid, tid, vote, weight_x_32767, created)``,
    ``comments(tid, zid, pid, uid, created, modified, mod, is_meta, ...)``,
    ``participants(pid, uid, zid, ..., mod, created)``,
    ``conversations(zid, ...)``.
    """
    return """
        SELECT
            c.zid                                     AS zid,
            COALESCE(v.v_events, 0)                   AS v_events,
            COALESCE(v.u_cells, 0)                    AS u_cells,
            COALESCE(v.p_voters, 0)                   AS p_voters,
            COALESCE(v.c_voted_comments, 0)           AS c_voted_comments,
            COALESCE(p.registered_participants, 0)    AS registered_participants,
            COALESCE(cm.all_comments, 0)              AS all_comments,
            COALESCE(cm.mod_out_comments, 0)          AS mod_out_comments,
            COALESCE(cm.meta_comments, 0)             AS meta_comments,
            COALESCE(cm.math_eligible_comments, 0)    AS math_eligible_comments,
            COALESCE(cm.mod_out_or_meta_comments, 0)  AS mod_out_or_meta_comments,
            COALESCE(e.eligible_participants, 0)      AS eligible_participants,
            COALESCE(b.banned_voters, 0)              AS banned_voters
        FROM conversations c
        LEFT JOIN (
            SELECT zid,
                   COUNT(*)                        AS v_events,
                   COUNT(DISTINCT (pid, tid))      AS u_cells,
                   COUNT(DISTINCT pid)             AS p_voters,
                   COUNT(DISTINCT tid)             AS c_voted_comments
            FROM votes
            GROUP BY zid
        ) v ON v.zid = c.zid
        LEFT JOIN (
            SELECT zid, COUNT(*) AS registered_participants
            FROM participants
            GROUP BY zid
        ) p ON p.zid = c.zid
        LEFT JOIN (
            SELECT zid,
                   COUNT(*)                                                       AS all_comments,
                   COUNT(*) FILTER (WHERE mod = -1)                               AS mod_out_comments,
                   COUNT(*) FILTER (WHERE is_meta)                                AS meta_comments,
                   COUNT(*) FILTER (WHERE mod <> -1 AND NOT is_meta)               AS math_eligible_comments,
                   COUNT(*) FILTER (WHERE is_meta OR mod = -1)                     AS mod_out_or_meta_comments
            FROM comments
            GROUP BY zid
        ) cm ON cm.zid = c.zid
        LEFT JOIN (
            SELECT v2.zid, COUNT(DISTINCT v2.pid) AS eligible_participants
            FROM votes v2
            JOIN comments c2
              ON c2.zid = v2.zid AND c2.tid = v2.tid
             AND c2.mod <> -1 AND NOT c2.is_meta
            GROUP BY v2.zid
        ) e ON e.zid = c.zid
        LEFT JOIN (
            SELECT v3.zid, COUNT(DISTINCT v3.pid) AS banned_voters
            FROM votes v3
            JOIN participants pp
              ON pp.zid = v3.zid AND pp.pid = v3.pid AND pp.mod = -1
            GROUP BY v3.zid
        ) b ON b.zid = c.zid
        ORDER BY c.zid ASC
    """


def derive_metrics(row: dict[str, Any]) -> dict[str, Any]:
    """Turn one raw aggregate row into the full committed metrics row.

    Ratios are ``None`` (never 0.0) when their denominator is zero — see the
    ``null_when`` fields of the config's ``metrics`` block. ``None`` fails every
    predicate (``fixture_config.evaluate_predicates``) and sorts last.
    """
    v = int(row["v_events"])
    u = int(row["u_cells"])
    p = int(row["p_voters"])
    c = int(row["c_voted_comments"])
    all_comments = int(row["all_comments"])
    area = p * c
    return {
        "zid": int(row["zid"]),
        "V": v,
        "U": u,
        "P": p,
        "C": c,
        "matrix_area": area,
        "revote_share": ((v - u) / v) if v else None,
        "density": (u / area) if area else None,
        "registered_participants": int(row["registered_participants"]),
        "all_comments": all_comments,
        "math_eligible_comments": int(row["math_eligible_comments"]),
        "mod_out_or_meta_comments": int(row["mod_out_or_meta_comments"]),
        "eligible_participants": int(row["eligible_participants"]),
        "banned_voters": int(row["banned_voters"]),
        "mod_out_share": (int(row["mod_out_comments"]) / all_comments) if all_comments else None,
        "meta_share": (int(row["meta_comments"]) / all_comments) if all_comments else None,
    }


# ---------------------------------------------------------------------------
# Transaction guarantee.
# ---------------------------------------------------------------------------


def open_readonly_repeatable_read(
    conn, *, snapshot_id: str | None = None, writers_disabled: bool = False,
) -> dict[str, Any]:
    """Begin ONE read-only repeatable-read transaction on ``conn`` and return
    the guarantee record for the manifest.

    ``snapshot_id`` — a value from ``pg_export_snapshot()`` held open by the
    orchestrator's session; ``SET TRANSACTION SNAPSHOT`` pins this transaction
    to exactly the same visible rows, which is how survey and extraction share
    one snapshot across separate processes.

    ``writers_disabled`` — record that the clone additionally had all writers
    disabled (the spec's alternative guarantee). It does NOT relax the
    isolation level; both are recorded when both are true.
    """
    conn.rollback()  # ensure we are not inside an implicitly-started txn
    with conn.cursor() as cur:
        cur.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        if snapshot_id is not None:
            cur.execute("SET TRANSACTION SNAPSHOT %s", (snapshot_id,))
        cur.execute("SELECT txid_current_if_assigned(), now()")
        _, txn_started_at = cur.fetchone()
    return {
        "isolation_level": "repeatable read",
        "access_mode": "read only",
        "single_transaction": True,
        "imported_snapshot_id": snapshot_id,
        "writers_disabled_on_clone": bool(writers_disabled),
        "transaction_started_at": txn_started_at.isoformat()
        if hasattr(txn_started_at, "isoformat") else str(txn_started_at),
    }


def _rows_as_dicts(cur) -> list[dict[str, Any]]:
    columns = [d[0] for d in cur.description]
    return [dict(zip(columns, row)) for row in cur.fetchall()]


def fetch_metrics(conn) -> list[dict[str, Any]]:
    """Run :func:`sql_conversation_metrics` and derive every committed metric.

    MUST be called inside the transaction opened by
    :func:`open_readonly_repeatable_read`.
    """
    with conn.cursor() as cur:
        cur.execute(sql_conversation_metrics())
        raw = _rows_as_dicts(cur)
    return [derive_metrics(row) for row in raw]


def schema_migration_version(conn) -> str | None:
    """Best-effort migration marker for the manifest: the highest applied
    migration recorded by the server's migration table, when one exists.
    Returns ``None`` (recorded as unknown) rather than failing the run."""
    for statement in (
        "SELECT max(version::text) FROM schema_migrations",
        "SELECT max(name) FROM migrations",
    ):
        try:
            with conn.cursor() as cur:
                cur.execute(statement)
                value = cur.fetchone()[0]
            if value is not None:
                return str(value)
        except Exception:  # noqa: BLE001 - probing optional tables
            conn.rollback()
    return None


# ---------------------------------------------------------------------------
# Rule resolution — deterministic, fail-loud.
# ---------------------------------------------------------------------------


@dataclass
class Selection:
    """One resolved role. ``zid`` is PRIVATE and belongs only in the restricted
    provenance object; ``metrics`` minus ``zid`` is manifest-safe."""

    role: str
    slug: str
    group: str
    rank: int
    zid: int
    metrics: dict[str, Any]
    n_candidates: int
    overlaps_with: list[str] = field(default_factory=list)

    def manifest_metrics(self) -> dict[str, Any]:
        return {k: v for k, v in self.metrics.items() if k != "zid"}


def rank_candidates(
    rows: Iterable[dict[str, Any]], role: dict[str, Any], *, exclude: set[int],
) -> list[dict[str, Any]]:
    """Ordered candidate list for ``role``: predicate filter, then ``exclude``
    (conversations already reserved by earlier replacement roles — the spec's
    "among remaining"), then ``order_by`` with zid ascending last."""
    candidates = [
        row for row in rows
        if row["zid"] not in exclude and evaluate_predicates(row, role["predicates"])
    ]
    candidates.sort(key=lambda row: sort_key_for(row, role["order_by"]))
    return candidates


def resolve_roles(
    config: dict[str, Any], rows: Sequence[dict[str, Any]],
) -> list[Selection]:
    """Resolve every role in ``config`` against the survey ``rows``.

    Replacement roles are resolved first, in config order, each excluding the
    conversations earlier replacement roles took. Stress roles are then resolved
    with NO exclusion — they may reuse a conversation, and the reuse is recorded
    in :attr:`Selection.overlaps_with` so the manifest discloses the overlap.

    Raises :class:`RoleUnsatisfied` for the FIRST role with no candidate at its
    rank. There is no fallback, no downgrade and no skip.
    """
    rows = list(rows)
    selections: list[Selection] = []
    taken: dict[int, list[str]] = {}
    reserved: set[int] = set()

    for group in ("replacement", "stress"):
        for role in config["roles"]:
            if role["group"] != group:
                continue
            exclude = reserved if group == "replacement" else set()
            candidates = rank_candidates(rows, role, exclude=exclude)
            rank = role["rank"]
            if len(candidates) < rank:
                raise RoleUnsatisfied(
                    role["role"], role["slug"],
                    f"rule matched {len(candidates)} conversation(s) but rank {rank} "
                    "was required",
                    synthetic_replacement=role.get("synthetic_replacement"),
                )
            chosen = candidates[rank - 1]
            zid = chosen["zid"]
            selections.append(Selection(
                role=role["role"], slug=role["slug"], group=group, rank=rank,
                zid=zid, metrics=chosen, n_candidates=len(candidates),
                overlaps_with=list(taken.get(zid, [])),
            ))
            taken.setdefault(zid, []).append(role["slug"])
            if group == "replacement":
                reserved.add(zid)

    return selections


# ---------------------------------------------------------------------------
# Survey artefact (private) + its redacted public form.
# ---------------------------------------------------------------------------


def build_survey(
    rows: Sequence[dict[str, Any]], guarantee: dict[str, Any], *,
    snapshot_id: str | None = None, schema_version_marker: str | None = None,
) -> dict[str, Any]:
    """The PRIVATE survey artefact: every conversation's metrics, no text.

    Confine it to ``real_data/.local/``; it contains zids.
    """
    return {
        "schema_version": SURVEY_SCHEMA_VERSION,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "snapshot_id": snapshot_id,
        "schema_migration_version": schema_version_marker,
        "transaction_guarantee": guarantee,
        "metric_definitions": METRIC_DEFINITIONS,
        "n_conversations": len(rows),
        "conversations": list(rows),
    }


def redact_survey(survey: dict[str, Any]) -> dict[str, Any]:
    """Distribution-safe view of a survey: per-metric distribution summary and
    rule-eligibility counts, with every zid removed. This is what may be shown
    when proposing a v1 rule revision "with the coverage change shown publicly
    without identities"."""
    rows = survey.get("conversations", [])
    numeric = [m for m in METRIC_DEFINITIONS if m != "zid"]
    summary: dict[str, Any] = {}
    for metric in numeric:
        values = sorted(r[metric] for r in rows if r.get(metric) is not None)
        if not values:
            summary[metric] = {"n_defined": 0}
            continue
        summary[metric] = {
            "n_defined": len(values),
            "min": values[0],
            "p50": values[len(values) // 2],
            "max": values[-1],
        }
    return {
        "schema_version": survey["schema_version"],
        "generated_at": survey["generated_at"],
        "n_conversations": survey.get("n_conversations", len(rows)),
        "metric_definitions": METRIC_DEFINITIONS,
        "metric_summary": summary,
    }


def coverage_report(config: dict[str, Any], rows: Sequence[dict[str, Any]]) -> dict[str, Any]:
    """Per-role candidate COUNTS with no identities — publishable evidence that
    a rule revision changed coverage, and the diagnostic printed when
    :class:`RoleUnsatisfied` fires."""
    out: dict[str, Any] = {}
    reserved: set[int] = set()
    for group in ("replacement", "stress"):
        for role in config["roles"]:
            if role["group"] != group:
                continue
            exclude = reserved if group == "replacement" else set()
            candidates = rank_candidates(rows, role, exclude=exclude)
            out[role["slug"]] = {
                "role": role["role"],
                "group": group,
                "rank": role["rank"],
                "n_candidates": len(candidates),
                "satisfied": len(candidates) >= role["rank"],
            }
            if group == "replacement" and len(candidates) >= role["rank"]:
                reserved.add(candidates[role["rank"] - 1]["zid"])
    return out
