"""P-042 slice 0 — Python side of the completion-safe math source journal.

Design: ``cost-reduction/04-plans/P-042-commit-ordered-cursor.md`` (Astra rev 5),
schema installed by ``server/postgres/migrations/000020_create_math_source_journal.sql``.

SLICE 0 SCOPE. This module is *dormant plumbing*. It carries the discovery SQL
(as SQLAlchemy named binds equivalent to the design's numbered binds), the typed
result shapes, and a client that can run one commit-ordered discovery cycle on a
single pinned connection in one transaction. It is gated behind
``POLIS_MATH_SOURCE_JOURNAL_ENABLED`` (default OFF).

What slice 0 deliberately does NOT do (left for later slices):

* It is NOT imported or called by ``polismath/poller/service.py``; the live
  poller path is byte-for-byte unchanged. When the flag is OFF nothing here runs
  at all, and even with it ON slice 0 wires no cursor advancement into the poller.
* It registers NO consumer at import or flag-on time. Per the design's normative
  R2-N3 rule, no consumer may be registered until the P-047 identity bootstrap
  completes. ``register_consumer`` exists for slice-1 wiring and tests only.

xid values travel as decimal **text** and are cast ``text -> xid8`` server-side
(never a signed 64-bit int or a float), exactly as the design requires.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import Any, List, Optional

import sqlalchemy as sa
from sqlalchemy.engine import Connection, Engine

logger = logging.getLogger(__name__)

# --------------------------------------------------------------------------- #
# Feature flag
# --------------------------------------------------------------------------- #
SOURCE_JOURNAL_ENABLED_ENV = "POLIS_MATH_SOURCE_JOURNAL_ENABLED"

_TRUE_VALUES = frozenset({"1", "true", "yes", "on"})
_FALSE_VALUES = frozenset({"", "0", "false", "no", "off"})


def source_journal_enabled() -> bool:
    """Resolve the journal feature flag AT CALL TIME (default OFF).

    Read at call time (never at import) so operators and tests can flip the env
    var without re-importing. An unrecognised value logs a warning and falls back
    to OFF: a typo in a deployment env must never silently enable discovery.
    """
    raw = os.environ.get(SOURCE_JOURNAL_ENABLED_ENV)
    if raw is None:
        return False
    value = raw.strip().lower()
    if value in _TRUE_VALUES:
        return True
    if value in _FALSE_VALUES:
        return False
    logger.warning(
        "%s=%r is not a recognised boolean; defaulting to OFF",
        SOURCE_JOURNAL_ENABLED_ENV, raw,
    )
    return False


# --------------------------------------------------------------------------- #
# Discovery SQL — SQLAlchemy named binds equivalent to the design's $n binds.
# The bodies match the labelled blocks in the design markdown one-for-one.
# --------------------------------------------------------------------------- #
# p042:horizon — primary-only completed-prefix boundary + cluster identity.
HORIZON_SQL = sa.text(
    "SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS x, "
    "(SELECT system_identifier::text FROM pg_control_system()) AS system_identifier, "
    "(SELECT incarnation::text FROM public.math_source_database WHERE singleton) "
    "AS database_incarnation "
    "WHERE NOT pg_is_in_recovery()"
)

# p042:lock — lock the consumer row and check primary/incarnation (raises in SQL).
LOCK_SQL = sa.text(
    "SELECT c.next_xid::text AS next_xid, c.through_xid::text AS through_xid, "
    "c.after_event_id AS after_event_id "
    "FROM public.p042_checked_consumer(:consumer_id) c"
)

# p042:open — open an interval up to a fresh horizon (raises on regression/reopen).
OPEN_SQL = sa.text(
    "SELECT public.p042_open(:consumer_id, CAST(CAST(:through_xid AS text) AS xid8)) AS through_xid"
)

# p042:page — materialise one journal page, coalesce zids into pending, advance.
PAGE_SQL = sa.text(
    "SELECT * FROM public.p042_page(:consumer_id, CAST(:page_size AS integer))"
)

# p042:close — advance C to the drained interval upper bound (raises if not drained).
CLOSE_SQL = sa.text(
    "SELECT public.p042_close(:consumer_id) AS next_xid"
)

# p042:pending — fair, capped, backoff-ordered due work selection.
PENDING_SQL = sa.text(
    "SELECT zid, dirty_version, first_dirty_at, attempts, next_attempt_at "
    "FROM public.math_source_pending "
    "WHERE consumer_id=:consumer_id AND next_attempt_at <= clock_timestamp() "
    "ORDER BY next_attempt_at, first_dirty_at, zid NULLS FIRST "
    "LIMIT LEAST(1000, GREATEST(1, COALESCE(CAST(:limit AS integer), 100)))"
)

# p042:ack — delete a pending row only if the version still matches (ABA-safe).
ACK_SQL = sa.text(
    "DELETE FROM public.math_source_pending "
    "WHERE consumer_id=:consumer_id AND zid IS NOT DISTINCT FROM CAST(:zid AS integer) "
    "AND dirty_version=:dirty_version"
)

# p042:fail — version-bound bounded backoff; a fresh delivery keeps the backoff.
FAIL_SQL = sa.text(
    "UPDATE public.math_source_pending "
    "SET attempts=attempts+1, "
    "next_attempt_at=clock_timestamp()+make_interval(secs => CAST(:backoff_secs AS double precision)) "
    "WHERE consumer_id=:consumer_id AND zid IS NOT DISTINCT FROM CAST(:zid AS integer) "
    "AND dirty_version=:dirty_version "
    "AND CAST(:backoff_secs AS double precision) BETWEEN 1 AND 3600 "
    "RETURNING dirty_version"
)

# Per-zid authoritative source reads (full snapshots, not "since" patches).
# p042:legacy-votes
READ_VOTES_SQL = sa.text(
    "SELECT zid, tid, pid, vote, created, weight_x_32767 "
    "FROM public.votes WHERE zid=:zid ORDER BY zid, tid, pid, created"
)
# p042:comments
READ_COMMENTS_SQL = sa.text(
    "SELECT zid, tid, modified, mod, is_meta "
    "FROM public.comments WHERE zid=:zid ORDER BY zid, tid, modified"
)
# p042:participants
READ_PARTICIPANTS_SQL = sa.text(
    "SELECT zid, pid, mod FROM public.participants WHERE zid=:zid ORDER BY pid"
)
# p042:conversation
READ_CONVERSATION_SQL = sa.text(
    "SELECT * FROM public.conversations WHERE zid=:zid"
)

# Consumer registration (slice-1 / test use only — see module docstring).
_REGISTER_CONSUMER_SQL = sa.text(
    "INSERT INTO public.math_source_consumers "
    "(consumer_id, engine, math_env, scope_digest, system_identifier, "
    " database_incarnation, next_xid) "
    "VALUES (:consumer_id, :engine, :math_env, :scope_digest, :system_identifier, "
    " CAST(:database_incarnation AS uuid), CAST(CAST(:next_xid AS text) AS xid8))"
)
_REGISTER_BOOTSTRAP_PENDING_SQL = sa.text(
    "INSERT INTO public.math_source_pending (consumer_id, zid) "
    "VALUES (:consumer_id, NULL)"
)


# --------------------------------------------------------------------------- #
# Typed result shapes
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class HorizonSnapshot:
    """One primary-only completed-prefix boundary plus cluster identity."""

    x: str
    system_identifier: str
    database_incarnation: str


@dataclass(frozen=True)
class ConsumerCursor:
    """The persisted cursor for a consumer, as returned by p042_checked_consumer."""

    next_xid: str
    through_xid: Optional[str]
    after_event_id: int

    @property
    def interval_open(self) -> bool:
        return self.through_xid is not None


@dataclass(frozen=True)
class PageResult:
    """Result of one p042_page call."""

    n: int
    dirtied: int
    advanced: int


@dataclass(frozen=True)
class PendingItem:
    """One due unit of pending work; ``zid`` NULL means a full-sweep request."""

    zid: Optional[int]
    dirty_version: int
    first_dirty_at: Any
    attempts: int
    next_attempt_at: Any


# --------------------------------------------------------------------------- #
# Discovery client
# --------------------------------------------------------------------------- #
class SourceJournalClient:
    """Commit-ordered discovery against the P-042 journal.

    The client never holds a discovery lock across a source snapshot, queue lease
    or publication (the design forbids it). Callers run one discovery cycle inside
    a single short transaction on a pinned connection; ``discover_page`` wraps that
    for tests and future poller wiring.
    """

    def __init__(self, engine: Engine, consumer_id: str) -> None:
        self._engine = engine
        self.consumer_id = consumer_id

    # -- primitives (each takes an explicit connection = one transaction) ----- #
    def horizon(self, conn: Connection) -> HorizonSnapshot:
        """Capture X on the primary. Exactly one row, else the caller aborts."""
        rows = conn.execute(HORIZON_SQL).mappings().all()
        if len(rows) != 1:
            raise SourceJournalError(
                f"horizon must return exactly one row on a primary, got {len(rows)}"
            )
        r = rows[0]
        return HorizonSnapshot(
            x=r["x"],
            system_identifier=r["system_identifier"],
            database_incarnation=r["database_incarnation"],
        )

    def lock(self, conn: Connection) -> ConsumerCursor:
        """Lock the consumer row; raises P042_* in SQL on identity/primary faults."""
        r = conn.execute(
            LOCK_SQL, {"consumer_id": self.consumer_id}
        ).mappings().one()
        return ConsumerCursor(
            next_xid=r["next_xid"],
            through_xid=r["through_xid"],
            after_event_id=r["after_event_id"],
        )

    def open(self, conn: Connection, through_xid: str) -> str:
        """Open an interval up to ``through_xid`` (decimal text)."""
        return conn.execute(
            OPEN_SQL,
            {"consumer_id": self.consumer_id, "through_xid": str(through_xid)},
        ).scalar_one()

    def page(self, conn: Connection, page_size: int) -> PageResult:
        r = conn.execute(
            PAGE_SQL,
            {"consumer_id": self.consumer_id, "page_size": int(page_size)},
        ).mappings().one()
        return PageResult(n=r["n"], dirtied=r["dirtied"], advanced=r["advanced"])

    def close(self, conn: Connection) -> str:
        return conn.execute(
            CLOSE_SQL, {"consumer_id": self.consumer_id}
        ).scalar_one()

    def pending(self, conn: Connection, limit: int = 100) -> List[PendingItem]:
        rows = conn.execute(
            PENDING_SQL, {"consumer_id": self.consumer_id, "limit": int(limit)}
        ).mappings().all()
        return [
            PendingItem(
                zid=r["zid"],
                dirty_version=r["dirty_version"],
                first_dirty_at=r["first_dirty_at"],
                attempts=r["attempts"],
                next_attempt_at=r["next_attempt_at"],
            )
            for r in rows
        ]

    def ack(self, conn: Connection, zid: Optional[int], dirty_version: int) -> int:
        result = conn.execute(
            ACK_SQL,
            {
                "consumer_id": self.consumer_id,
                "zid": zid,
                "dirty_version": int(dirty_version),
            },
        )
        return result.rowcount

    def fail(
        self,
        conn: Connection,
        zid: Optional[int],
        dirty_version: int,
        backoff_secs: float,
    ) -> Optional[int]:
        rows = conn.execute(
            FAIL_SQL,
            {
                "consumer_id": self.consumer_id,
                "zid": zid,
                "dirty_version": int(dirty_version),
                "backoff_secs": float(backoff_secs),
            },
        ).scalars().all()
        return rows[0] if rows else None

    # -- authoritative per-zid source reads ----------------------------------- #
    def read_votes(self, conn: Connection, zid: int) -> List[dict]:
        return [dict(r) for r in conn.execute(
            READ_VOTES_SQL, {"zid": zid}).mappings().all()]

    def read_comments(self, conn: Connection, zid: int) -> List[dict]:
        return [dict(r) for r in conn.execute(
            READ_COMMENTS_SQL, {"zid": zid}).mappings().all()]

    def read_participants(self, conn: Connection, zid: int) -> List[dict]:
        return [dict(r) for r in conn.execute(
            READ_PARTICIPANTS_SQL, {"zid": zid}).mappings().all()]

    def read_conversation(self, conn: Connection, zid: int) -> Optional[dict]:
        rows = conn.execute(
            READ_CONVERSATION_SQL, {"zid": zid}).mappings().all()
        return dict(rows[0]) if rows else None

    # -- one whole discovery cycle in one transaction ------------------------- #
    def discover_page(self, page_size: int = 100) -> PageResult:
        """Run lock -> (open if needed) -> one page -> (close if drained) in ONE
        transaction on a pinned connection, committing page+pending+offset
        together. Returns the page result.

        NOTE: slice 0 does not call this from the live poller; it is here for the
        Python-side acceptance tests and future slice-1 wiring. A fresh horizon is
        captured on the same primary connection when the interval is not yet open.
        """
        with self._engine.connect() as conn:
            with conn.begin():
                cursor = self.lock(conn)
                if not cursor.interval_open:
                    snap = self.horizon(conn)
                    self.open(conn, snap.x)
                result = self.page(conn, page_size)
                if result.n == 0:
                    self.close(conn)
                return result


class SourceJournalError(RuntimeError):
    """A discovery invariant the SQL layer could not itself enforce."""


def register_consumer(
    engine: Engine,
    consumer_id: str,
    engine_name: str,
    math_env: str,
    scope_digest: str,
) -> HorizonSnapshot:
    """Register a NEW durable consumer with C=X and a NULL-zid bootstrap item.

    Captures X first, then inserts the consumer and its bootstrap pending item in
    the SAME transaction (design: "capture X first ... insert ... in that same
    transaction"). Slice-1 / test use ONLY — slice 0 registers no consumer.
    """
    client = SourceJournalClient(engine, consumer_id)
    with engine.connect() as conn:
        with conn.begin():
            snap = client.horizon(conn)
            conn.execute(
                _REGISTER_CONSUMER_SQL,
                {
                    "consumer_id": consumer_id,
                    "engine": engine_name,
                    "math_env": math_env,
                    "scope_digest": scope_digest,
                    "system_identifier": snap.system_identifier,
                    "database_incarnation": snap.database_incarnation,
                    "next_xid": snap.x,
                },
            )
            conn.execute(
                _REGISTER_BOOTSTRAP_PENDING_SQL, {"consumer_id": consumer_id}
            )
    return snap


def maybe_source_journal_client(
    engine: Engine, consumer_id: str
) -> Optional[SourceJournalClient]:
    """Construct a client only when the flag is ON; otherwise return None.

    This is the single flag gate the poller would consult. In slice 0 the poller
    does not consult it at all, so when the flag is OFF nothing here ever runs.
    """
    if not source_journal_enabled():
        return None
    return SourceJournalClient(engine, consumer_id)
