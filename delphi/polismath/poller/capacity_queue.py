"""The small poller's side of the Postgres job queue (P-073 r2).

An oversized conversation is a job. When the small poller's estimator decides
a cold rebuild would not fit (``polismath.poller.capacity``: disposition
``large``), the poller inserts one ``math_rebuild`` job of worker class
``large`` through the queue's SQL contract, and the large box's ``polis-jobs``
daemon runs ``scripts/math_poller.py --job`` as a child for that one
conversation, which stages the bundle under the staged label
(``python-large``). The small poller promotes it as before
(``polismath.poller.promotion``).

The contract. The queue is reached only through a closed inventory of SQL
functions (``RPC``, the pattern of ``polismath.queue.executor``): one short
transaction per call, on its own connection, every value bound with a fixed
cast; a name outside the inventory raises before any connection is opened.
The login (``MATH_CAPACITY_QUEUE_DSN``) must be a member of
``polis_queue_executor`` with no direct table access and no way to become the
queue owner; that boundary is re-checked on every connection, so nothing in
the poller can touch a queue table. The poller's publication path keeps its
own ``DATABASE_URL`` connection.

Idempotence is the queue's: ``pd_enqueue`` keys the job by scope
``math:<label>:<zid>`` under the one-active-job-per-scope guard, so a second
insert while a job is queued, waiting or running returns the existing job
(``existing``; ``conflict`` when the active job was admitted for an older
input, which is treated the same: the active job is left alone and the next
promotion pass asks again once it has finished).

The admission frame. The daemon cannot read the run's zid; it reaches the
child only through the run's ``input_uri`` (``frame://inline/`` + base64url
of the admission JSON) bound by ``input_sha256`` (``queue-rs``
``jobs/child.rs``). The admission's ``inputs.math_env`` is the staged label,
so the child's ``MATH_ENV`` is bound to it, and its ``config`` carries what
the child checks and what the operator reads on the row: the two labels, the
estimated need, the input mark, the sizing binding and the small poller's
source commit.

The depth read. ``pq_class_depth(env, 'large')`` gives the counts the scale
alarms watch (``large_demand`` = queued + retry_wait, ``large_leased`` =
running), read once per readiness interval and published on the small
poller's capacity line.

Nothing here runs unless ``MATH_CAPACITY_ROUTING=1`` and a queue DSN is set.
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import re
import uuid
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

import psycopg2

logger = logging.getLogger(__name__)

STAGE_MATH_REBUILD = "math_rebuild"
WORKER_CLASS_LARGE = "large"
ADMISSION_SCHEMA = "polis-jobs.admission/1"
FRAME_URI_PREFIX = "frame://inline/"
DEPTH_OUTCOME = "class_depth"

#: Reply schema versions the contract may answer with: 000023 answers
#: ``polis-queue/2`` for every non-noop stage; the /3 migration may bump it.
REPLY_VERSIONS = frozenset(("polis-queue/2", "polis-queue/3"))

#: The closed statement inventory with fixed casts (``executor.RPC`` pattern).
#: ``pd_enqueue`` is the one admission RPC of 000023; ``pq_class_depth`` is the
#: /3 read; ``pq_job_status`` and ``pq_cancel`` are the 000019 management reads.
RPC: Dict[str, Tuple[str, ...]] = {
    "pd_enqueue": ("text", "integer", "text", "text", "text", "text", "uuid", "uuid", "text",
                   "text", "text", "text", "smallint", "integer", "text", "text", "text",
                   "jsonb"),
    "pq_class_depth": ("text", "text"),
    "pq_job_status": ("text", "uuid"),
    "pq_cancel": ("text", "uuid", "bigint"),
}

#: Closed field set of an ordinary job reply (``pq_result``).
JOB_FIELDS = frozenset(
    "schema_version outcome env job_id run_id attempt_id owner_id lease_epoch "
    "version mgmt_version locked_until state output_sha256 published stage "
    "stage_instance attempt_count max_attempts parked_attempt_count eligible_at "
    "first_parked_at last_error_code input".split()
)
#: Closed field set of the depth reply (the plan's ``pq_class_depth``).
DEPTH_FIELDS = frozenset(
    "schema_version outcome env worker_class queued running dead oldest_created_at".split()
)
ENQUEUE_OUTCOMES = frozenset(("enqueued", "existing", "conflict"))
#: Job states the guard counts as active (the scope is occupied).
ACTIVE_STATES = frozenset(("queued", "retry_wait", "running", "parked"))

#: The queue env namespace: the daemon's ``QUEUE_ENV`` shape.
_ENV_NAMESPACE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
_LABEL = re.compile(r"[A-Za-z0-9_.-]{1,64}")

#: Every table the poller must reach only through the granted RPCs: the five
#: queue tables of 000019 and the two foundation tables its calls touch.
QUEUE_TABLES = (
    "public.polis_queue_runs",
    "public.polis_queue_heads",
    "public.polis_queue_jobs",
    "public.polis_queue_attempts",
    "public.polis_queue_requests",
    "public.delphi_jobs",
    "public.delphi_job_guards",
)

_SESSION_POLICY = (
    "SET LOCAL TIME ZONE 'UTC';"
    " SET LOCAL lock_timeout='500ms';"
    " SET LOCAL statement_timeout='5s';"
    " SET LOCAL idle_in_transaction_session_timeout='5s';"
    " SELECT set_config('transaction_timeout','10s',true)"
    " WHERE current_setting('server_version_num')::int >= 170000"
)

# The admission gate (``executor._BOUNDARY_SQL``), re-checked on every
# connection: membership, no table- or column-level privilege on any of the
# tables, and no path to the owner role by inheritance or SET ROLE.
_BOUNDARY_SQL = (
    "SELECT pg_has_role(current_user,'polis_queue_executor','MEMBER') AS member,"
    " (SELECT COALESCE(bool_or("
    "   has_table_privilege(current_user,t,"
    "     'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')"
    "   OR has_any_column_privilege(current_user,t,"
    "     'SELECT,INSERT,UPDATE,REFERENCES')),false)"
    "  FROM unnest(%s::text[]) t WHERE to_regclass(t) IS NOT NULL) AS direct_access,"
    " pg_has_role(current_user,'polis_queue_owner','USAGE')"
    "  OR pg_has_role(current_user,'polis_queue_owner','MEMBER') AS owner_escape"
)

DEFAULT_PRIORITY = 1
DEFAULT_MAX_ATTEMPTS = 3


class QueueProtocolError(ValueError):
    """A reply that is not the closed shape the contract promises."""


class QueueRefused(RuntimeError):
    """A precondition that is never worked around at runtime."""


def canonical_bytes(value: Any) -> bytes:
    """Sorted keys, no whitespace, raw UTF-8, one trailing newline (the job
    child's canonical form)."""
    text = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
                      allow_nan=False)
    return (text + "\n").encode("utf-8")


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def encode_frame_uri(admission_bytes: bytes) -> str:
    """``frame://inline/`` + unpadded base64url (``queue-rs`` ``child.rs``)."""
    return FRAME_URI_PREFIX + base64.urlsafe_b64encode(admission_bytes).rstrip(b"=").decode()


def decode_frame_uri(uri: str) -> bytes:
    if not uri.startswith(FRAME_URI_PREFIX):
        raise QueueProtocolError("queue_frame_uri")
    payload = uri[len(FRAME_URI_PREFIX):]
    return base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4))


def scope_key(target_label: str, zid: int) -> str:
    """``math:<label>:<zid>``: the product key, the scope and the head."""
    return f"math:{target_label}:{int(zid)}"


def actor_scope(target_label: str) -> str:
    return f"math-poller:{target_label}"


def admission(zid: int, *, staged_label: str, config: Dict[str, Any]) -> Dict[str, Any]:
    """The admission frame the daemon decodes for the child."""
    return {
        "schema": ADMISSION_SCHEMA,
        "zid": int(zid),
        "report_id": None,
        "config": dict(config),
        "inputs": {"math_env": staged_label, "requested_math_tick": None},
    }


def validate_job(reply: Any) -> Dict[str, Any]:
    """Reject a reply that is not an ordinary job result."""
    if not isinstance(reply, dict) or set(reply) != JOB_FIELDS:
        raise QueueProtocolError("queue_wire_fields")
    if reply["schema_version"] not in REPLY_VERSIONS:
        raise QueueProtocolError("queue_wire_version")
    for key in ("outcome", "env", "job_id", "state", "stage"):
        if not isinstance(reply[key], str) or not reply[key]:
            raise QueueProtocolError("queue_wire_text")
    return reply


def validate_depth(reply: Any) -> Dict[str, Any]:
    """Reject a reply that is not the closed depth envelope."""
    if not isinstance(reply, dict) or set(reply) != DEPTH_FIELDS:
        raise QueueProtocolError("queue_wire_depth_fields")
    if reply["schema_version"] not in REPLY_VERSIONS or reply["outcome"] != DEPTH_OUTCOME:
        raise QueueProtocolError("queue_wire_depth_version")
    for key in ("queued", "running", "dead"):
        value = reply[key]
        if type(value) is not int or value < 0:
            raise QueueProtocolError("queue_wire_depth_count")
    oldest = reply["oldest_created_at"]
    if oldest is not None and not isinstance(oldest, str):
        raise QueueProtocolError("queue_wire_depth_timestamp")
    return reply


@dataclass(frozen=True)
class QueueSettings:
    """``MATH_CAPACITY_QUEUE_DSN`` (an executor-member login) and
    ``MATH_CAPACITY_QUEUE_ENV`` (the queue env namespace)."""

    dsn: str
    env: str
    connect_timeout: int = 5

    def check(self) -> None:
        if not self.dsn:
            raise QueueRefused("queue_dsn_missing")
        if _ENV_NAMESPACE.fullmatch(self.env or "") is None:
            raise QueueRefused("queue_env_namespace")


class QueueClient:
    """One short transaction per call, on its own connection, never pooled."""

    def __init__(self, settings: QueueSettings) -> None:
        settings.check()
        self.settings = settings

    @classmethod
    def from_capacity(cls, settings: Any) -> Optional["QueueClient"]:
        """The client for the capacity settings, or None without a DSN."""
        dsn = getattr(settings, "queue_dsn", None)
        if not dsn:
            return None
        return cls(QueueSettings(dsn=dsn, env=getattr(settings, "queue_env", None) or ""))

    def describe(self) -> str:
        """For logs: never the DSN."""
        return f"env={self.settings.env}"

    # -- the wire ----------------------------------------------------------- #
    def call(self, name: str, args: List[Any]) -> Any:
        casts = RPC[name]  # KeyError here is a programming error, not input
        if len(args) != len(casts):
            raise ValueError("queue_rpc_arity")
        placeholders = ",".join("%s::" + cast for cast in casts)
        statement = "SELECT public." + name + "(" + placeholders + ")"
        conn = psycopg2.connect(
            self.settings.dsn,
            connect_timeout=self.settings.connect_timeout,
            application_name="math-poller-capacity-queue",
        )
        try:
            conn.set_session(isolation_level="READ COMMITTED")
            with conn.cursor() as cur:
                cur.execute(_SESSION_POLICY)
                cur.execute(_BOUNDARY_SQL, [list(QUEUE_TABLES)])
                member, direct_access, owner_escape = cur.fetchone()
                if not member:
                    raise QueueRefused("queue_login_requires_executor_membership")
                if direct_access:
                    raise QueueRefused("queue_login_has_direct_table_access")
                if owner_escape:
                    raise QueueRefused("queue_login_can_become_queue_owner")
                cur.execute(statement, args)
                reply = cur.fetchone()[0]
            if reply is None:
                raise QueueProtocolError("queue_unexpected_null_reply")
            if name == "pq_class_depth":
                validate_depth(reply)
            else:
                validate_job(reply)
            conn.commit()
            return reply
        finally:
            conn.close()

    # -- the calls ---------------------------------------------------------- #
    def enqueue_math_rebuild(self, zid: int, *, config: Dict[str, Any], staged_label: str,
                             target_label: str, priority: int = DEFAULT_PRIORITY,
                             max_attempts: int = DEFAULT_MAX_ATTEMPTS) -> Tuple[str, str]:
        """One ``math_rebuild`` job of class ``large`` for ``zid``, idempotent
        under the scope guard. Returns ``(outcome, job_id)``: ``enqueued`` a
        new job, ``existing``/``conflict`` the active one."""
        if not _LABEL.fullmatch(staged_label or "") or not _LABEL.fullmatch(target_label or ""):
            raise ValueError("queue_label")
        body = canonical_bytes(admission(zid, staged_label=staged_label, config=config))
        job_id, run_id = str(uuid.uuid4()), str(uuid.uuid4())
        scope = scope_key(target_label, zid)
        image = config.get("source_commit") or "unknown"
        reply = self.call("pd_enqueue", [
            self.settings.env, int(zid), scope, actor_scope(target_label), job_id,
            sha256_hex(body), run_id, job_id, encode_frame_uri(body), sha256_hex(body),
            sha256_hex(canonical_bytes(dict(config))), image, int(priority), int(max_attempts),
            STAGE_MATH_REBUILD, None, scope, json.dumps(config, sort_keys=True),
        ])
        outcome = str(reply["outcome"])
        if outcome not in ENQUEUE_OUTCOMES:
            raise QueueProtocolError("queue_enqueue_outcome")
        if outcome == "enqueued" and (reply["job_id"] != job_id
                                      or reply["stage"] != STAGE_MATH_REBUILD):
            raise QueueProtocolError("queue_enqueue_identity")
        return outcome, str(reply["job_id"])

    def class_depth(self, worker_class: str = WORKER_CLASS_LARGE) -> Dict[str, Any]:
        """The counts of one worker class in this env."""
        return self.call("pq_class_depth", [self.settings.env, worker_class])

    def job_status(self, job_id: str) -> Dict[str, Any]:
        return self.call("pq_job_status", [self.settings.env, str(uuid.UUID(job_id))])

    def cancel(self, job_id: str, mgmt_version: int) -> Dict[str, Any]:
        return self.call("pq_cancel", [self.settings.env, str(uuid.UUID(job_id)),
                                       int(mgmt_version)])


# --------------------------------------------------------------------------- #
# The small poller's enqueue
# --------------------------------------------------------------------------- #
def enqueue_routed(queue: Any, router: Any, zid: int, *, staged_label: str,
                   target_label: str, source_commit: Optional[str]) -> Optional[str]:
    """One job for a conversation the router holds as ``large``: the record's
    estimate and input mark ride on the admission config; the job id is kept
    on the record. Returns the job id, or None when the record is not large.
    Raises on a queue failure (the caller contains it)."""
    from polismath.poller.capacity import LARGE

    rec = router.record(zid)
    if rec is None or rec.disposition != LARGE:
        return None
    config = {
        "staged_label": staged_label,
        "target_label": target_label,
        "need_bytes": int(rec.need_bytes),
        "input_through_ms": rec.input_through_ms,
        "binding": rec.binding,
        "source_commit": source_commit,
    }
    outcome, job_id = queue.enqueue_math_rebuild(zid, config=config, staged_label=staged_label,
                                                 target_label=target_label)
    router.set_job(zid, job_id)
    logger.info("capacity: zid=%s math_rebuild job %s (%s)", zid, outcome, job_id[:8])
    return job_id


__all__ = [
    "ACTIVE_STATES", "ADMISSION_SCHEMA", "DEPTH_FIELDS", "JOB_FIELDS", "QueueClient",
    "QueueProtocolError", "QueueRefused", "QueueSettings", "RPC", "STAGE_MATH_REBUILD",
    "WORKER_CLASS_LARGE", "admission", "canonical_bytes", "decode_frame_uri",
    "encode_frame_uri", "enqueue_routed", "scope_key", "sha256_hex", "validate_depth",
    "validate_job",
]
