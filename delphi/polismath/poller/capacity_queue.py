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

The depth read. ``pq_class_depth(env, 'large')`` (000024) answers
``{queued, leased, parked, dead, oldest_unresolved_created_at}``: the counts
the scale alarms watch (``large_demand`` = queued + retry_wait, ``large_leased``
= leased), read once per readiness interval and published on the small
poller's capacity line. The decoder accepts exactly that reply; anything else
is a protocol error, which the readiness tick reports as missing data.

Scope release. The guard a job holds is released by the daemon after a
terminal attempt whose exit it proved (``pd_release_scope``, which re-checks
every condition). When an admission hands this poller a terminal job still
holding its guard (a cancel of a job nobody claimed, a daemon lost between its
terminal reply and the release), the poller calls the same guarded function
and asks once more. Terminal status alone releases nothing: a refused release
leaves the job as it is, and the daemon's recovery finishes it.

The poison latch is the contract's: when a scope's last three jobs all died
under the code image being admitted now, ``pd_enqueue`` answers ``poisoned``
(naming the latest dead job) and admits nothing; the poller parks the record
with that reason (``CapacityRouter.park_poisoned``) and stops asking until
the source commit changes or the restage nonce (the operator's ruling)
un-parks it. ``large_poisoned`` on the capacity line counts those records.

The receipt. A staged bundle is promoted only on the receipt of the job that
produced it: ``pq_job_status`` says ``succeeded`` with an ``output_sha256``,
the attempt's manifest row (``pq_attempt_logs``, stream ``manifest``) hashes
to that digest, names the job, and its ``inputs`` (``math_env``, ``math_tick``,
``vote_hwm``) are the staged bundle's fingerprint. A bundle a child committed
before the daemon finalized the attempt, or whose manifest failed, has no
receipt and is not served.

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
from types import MappingProxyType
from typing import Any, Dict, List, Mapping, Optional, Tuple

import psycopg2

logger = logging.getLogger(__name__)

STAGE_MATH_REBUILD = "math_rebuild"
WORKER_CLASS_LARGE = "large"
ADMISSION_SCHEMA = "polis-jobs.admission/1"
FRAME_URI_PREFIX = "frame://inline/"
DEPTH_OUTCOME = "class_depth"

#: Reply schema versions a job reply may carry: 000024 answers
#: ``polis-queue/3`` for a math_rebuild job; ``/2`` is the Delphi stages'.
REPLY_VERSIONS = frozenset(("polis-queue/2", "polis-queue/3"))
#: The depth read exists only from 000024 and answers its own version.
DEPTH_VERSION = "polis-queue/3"

#: The closed statement inventory with fixed casts (``executor.RPC`` pattern).
#: ``pd_enqueue`` is the one admission RPC (000023, admitting math_rebuild
#: from 000024); ``pd_release_scope`` the guarded release (000023);
#: ``pq_class_depth`` the /3 read; ``pq_job_status`` and ``pq_cancel`` the
#: 000019 management reads; ``pq_attempt_logs`` (000023) the manifest row.
RPC: Dict[str, Tuple[str, ...]] = {
    "pd_enqueue": ("text", "integer", "text", "text", "text", "text", "uuid", "uuid", "text",
                   "text", "text", "text", "smallint", "integer", "text", "text", "text",
                   "jsonb"),
    "pd_release_scope": ("text", "text"),
    "pq_class_depth": ("text", "text"),
    "pq_job_status": ("text", "uuid"),
    "pq_cancel": ("text", "uuid", "bigint"),
    "pq_attempt_logs": ("text", "uuid", "bigint", "integer"),
}
#: Set-returning functions, read with ``SELECT <columns> FROM``; the rest
#: answer one jsonb (or, for ``pd_release_scope``, one boolean).
TABLE_RPC: Dict[str, Tuple[str, ...]] = {"pq_attempt_logs": ("seq", "stream", "line")}
#: The manifest row's log stream (queue-rs ``logs.rs``) and its schema.
MANIFEST_STREAM = "manifest"
MANIFEST_SCHEMA = "polis-jobs.output-manifest/1"
#: Log rows read per page when looking for the manifest row, and the pages.
LOG_PAGE = 1000
LOG_PAGES = 64

#: Closed field set of an ordinary job reply (``pq_result``).
JOB_FIELDS = frozenset(
    "schema_version outcome env job_id run_id attempt_id owner_id lease_epoch "
    "version mgmt_version locked_until state output_sha256 published stage "
    "stage_instance attempt_count max_attempts parked_attempt_count eligible_at "
    "first_parked_at last_error_code input".split()
)
#: Closed field set of the depth reply: 000024's ``pq_class_depth``, exactly.
DEPTH_FIELDS = frozenset(
    "schema_version outcome env worker_class queued leased parked dead "
    "oldest_unresolved_created_at".split()
)
DEPTH_COUNTS = ("queued", "leased", "parked", "dead")
ENQUEUE_OUTCOMES = frozenset(("enqueued", "existing", "conflict", "poisoned"))
#: Job states the guard counts as active (the scope is occupied).
ACTIVE_STATES = frozenset(("queued", "retry_wait", "running", "parked"))
#: Job states after which nothing more happens to the job.
TERMINAL_STATES = frozenset(("succeeded", "dead", "cancelled"))

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

@dataclass(frozen=True)
class StagePolicy:
    """What the queue is told about a stage at admission (P-082): the lane
    (``priority`` 0-2; a worker claims lane 0, then 1, then 2), the attempt
    budget (``max_attempts``, the row's own ceiling) and the worker class."""

    lane: int
    max_attempts: int
    worker_class: str


#: The one closed table of scheduling constants (cost-reduction P-082, day
#: one). Math rebuilds ride lane 1 (lane 0 is kept for operator re-runs, lane
#: 2 for bulk work), three attempts per job, class large. Nothing else in the
#: poller chooses a lane or a budget; a stage not in this table cannot be
#: enqueued. tests/poller/test_capacity_queue.py pins it.
STAGE_POLICY: Mapping[str, StagePolicy] = MappingProxyType({
    STAGE_MATH_REBUILD: StagePolicy(lane=1, max_attempts=3, worker_class=WORKER_CLASS_LARGE),
})


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
    """Reject a reply that is not 000024's depth envelope, exactly."""
    if not isinstance(reply, dict) or set(reply) != DEPTH_FIELDS:
        raise QueueProtocolError("queue_wire_depth_fields")
    if reply["schema_version"] != DEPTH_VERSION or reply["outcome"] != DEPTH_OUTCOME:
        raise QueueProtocolError("queue_wire_depth_version")
    if reply["worker_class"] not in ("delphi", "large") or not isinstance(reply["env"], str):
        raise QueueProtocolError("queue_wire_depth_class")
    for key in DEPTH_COUNTS:
        value = reply[key]
        if type(value) is not int or value < 0:
            raise QueueProtocolError("queue_wire_depth_count")
    oldest = reply["oldest_unresolved_created_at"]
    if oldest is not None and not isinstance(oldest, str):
        raise QueueProtocolError("queue_wire_depth_timestamp")
    return reply


def validate_release(reply: Any) -> bool:
    """``pd_release_scope`` answers one boolean."""
    if type(reply) is not bool:
        raise QueueProtocolError("queue_wire_release")
    return reply


def validate_log_rows(rows: Any) -> List[Dict[str, Any]]:
    """``pq_attempt_logs`` rows: (seq, stream, line), each typed."""
    out = []
    for row in rows:
        if (not isinstance(row, dict) or set(row) != set(TABLE_RPC["pq_attempt_logs"])
                or type(row["seq"]) is not int or not isinstance(row["stream"], str)
                or not isinstance(row["line"], str)):
            raise QueueProtocolError("queue_wire_log_row")
        out.append(row)
    return out


@dataclass(frozen=True)
class Receipt:
    """What authorizes serving a staged bundle: the job's terminal state and,
    when it succeeded, the finalized manifest's naming of the bundle."""

    job_id: str
    state: str
    output_sha256: Optional[str]
    math_env: Optional[str] = None
    math_tick: Optional[int] = None
    vote_hwm: Optional[int] = None

    @property
    def finalized(self) -> bool:
        return self.state == "succeeded" and self.output_sha256 is not None and \
            self.math_tick is not None

    def binds(self, staged: Any, label: str) -> bool:
        """The receipt names exactly this staged bundle (its label, tick and
        newest vote)."""
        return (self.finalized and self.math_env == label
                and self.math_tick == getattr(staged, "math_tick", None)
                and self.vote_hwm == getattr(staged, "lvt", None))


def receipt_of(job_id: str, status: Dict[str, Any], manifest_line: Optional[str]) -> Receipt:
    """The receipt from a job status reply and the manifest row that hashes
    to its output digest (None when there is none). A manifest that does not
    hash to the digest, name the job or carry typed inputs is no receipt."""
    state, sha = str(status["state"]), status.get("output_sha256")
    bare = Receipt(job_id=job_id, state=state, output_sha256=sha)
    if state != "succeeded" or not isinstance(sha, str) or manifest_line is None:
        return bare
    if sha256_hex(manifest_line.encode("utf-8")) != sha:
        return bare
    try:
        m = json.loads(manifest_line)
    except ValueError:
        return bare
    inputs = m.get("inputs") if isinstance(m, dict) else None
    if (not isinstance(m, dict) or m.get("schema") != MANIFEST_SCHEMA
            or m.get("job_id") != job_id or m.get("stage") != STAGE_MATH_REBUILD
            or m.get("outcome") != "succeeded" or not isinstance(inputs, dict)):
        return bare
    tick, hwm, env = inputs.get("math_tick"), inputs.get("vote_hwm"), inputs.get("math_env")
    if type(tick) is not int or type(hwm) is not int or not isinstance(env, str):
        return bare
    return Receipt(job_id=job_id, state=state, output_sha256=sha, math_env=env,
                   math_tick=tick, vote_hwm=hwm)


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
        columns = TABLE_RPC.get(name)
        if columns is None:
            statement = "SELECT public." + name + "(" + placeholders + ")"
        else:
            statement = ("SELECT " + ",".join(columns) + " FROM public." + name + "("
                         + placeholders + ")")
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
                if columns is None:
                    reply = cur.fetchone()[0]
                else:
                    reply = [dict(zip(columns, row)) for row in cur.fetchall()]
            if reply is None:
                raise QueueProtocolError("queue_unexpected_null_reply")
            if name == "pq_class_depth":
                validate_depth(reply)
            elif name == "pd_release_scope":
                validate_release(reply)
            elif name == "pq_attempt_logs":
                validate_log_rows(reply)
            else:
                validate_job(reply)
            conn.commit()
            return reply
        finally:
            conn.close()

    # -- the calls ---------------------------------------------------------- #
    def enqueue_math_rebuild(self, zid: int, *, config: Dict[str, Any], staged_label: str,
                             target_label: str) -> Tuple[str, str]:
        """One ``math_rebuild`` job of class ``large`` for ``zid``, idempotent
        under the scope guard. Returns ``(outcome, job_id)``: ``enqueued`` a
        new job; ``existing``/``conflict`` the active one; ``poisoned`` the
        latest dead job, nothing admitted. A terminal job still holding the
        guard is released through the guarded ``pd_release_scope`` and the
        admission asked once more; a refused release leaves it to the daemon."""
        if not _LABEL.fullmatch(staged_label or "") or not _LABEL.fullmatch(target_label or ""):
            raise ValueError("queue_label")
        policy = STAGE_POLICY[STAGE_MATH_REBUILD]
        outcome, reply = self._admit(zid, config=config, staged_label=staged_label,
                                     target_label=target_label, priority=policy.lane,
                                     max_attempts=policy.max_attempts)
        if outcome in ("existing", "conflict") and reply["state"] in TERMINAL_STATES:
            # Finding 2: the guard outlived its job (a cancel nobody ran, a
            # daemon lost before its release). The SQL re-checks every
            # condition; a refusal is the daemon's recovery to finish.
            if self.release_scope(target_label, zid):
                logger.info("capacity: zid=%s released the scope of %s job %s; asking again",
                            zid, reply["state"], str(reply["job_id"])[:8])
                outcome, reply = self._admit(zid, config=config, staged_label=staged_label,
                                             target_label=target_label, priority=policy.lane,
                                             max_attempts=policy.max_attempts)
            else:
                logger.warning("capacity: zid=%s %s job %s still holds its scope (exit "
                               "unproven or provider work open); left to the daemon",
                               zid, reply["state"], str(reply["job_id"])[:8])
        return outcome, str(reply["job_id"])

    def _admit(self, zid: int, *, config: Dict[str, Any], staged_label: str,
               target_label: str, priority: int, max_attempts: int) -> Tuple[str, Dict[str, Any]]:
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
        return outcome, reply

    def release_scope(self, target_label: str, zid: int) -> bool:
        """The guarded release of ``math:<label>:<zid>``: true when the
        database agreed (every job of the scope terminal, every exit proven,
        no provider work), false when it refused or there was nothing."""
        return bool(self.call("pd_release_scope", [self.settings.env,
                                                   scope_key(target_label, zid)]))

    def receipt(self, job_id: str) -> Receipt:
        """The job's receipt (finding 4): its state, and when it succeeded
        and was finalized, the manifest row that hashes to its output digest
        with the staged bundle it names."""
        status = self.job_status(job_id)
        state = str(status["state"])
        attempt = status.get("attempt_id")
        if state != "succeeded" or not isinstance(status.get("output_sha256"), str) \
                or not isinstance(attempt, str):
            return receipt_of(job_id, status, None)
        return receipt_of(job_id, status, self._manifest_line(attempt, status["output_sha256"]))

    def _manifest_line(self, attempt_id: str, sha: str) -> Optional[str]:
        """The manifest row of the attempt that hashes to ``sha``, paging the
        attempt's log rows; None when no row does."""
        after: Optional[int] = None
        for _ in range(LOG_PAGES):
            rows = self.call("pq_attempt_logs", [self.settings.env, str(uuid.UUID(attempt_id)),
                                                 after, LOG_PAGE])
            for row in rows:
                if row["stream"] == MANIFEST_STREAM and sha256_hex(
                        row["line"].encode("utf-8")) == sha:
                    return row["line"]
            if len(rows) < LOG_PAGE:
                return None
            after = int(rows[-1]["seq"])
        return None

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
    if not isinstance(source_commit, str) or not source_commit:
        # The child refuses a frame without a commit and the daemon refuses
        # an admission without one: asking would only make dead jobs.
        raise QueueRefused("queue_source_commit_missing")
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
    if outcome == "poisoned":
        # The scope's last jobs all died under this source commit: parked
        # with the reason, not asked again until the commit changes.
        router.park_poisoned(zid, job_id, source_commit)
        logger.warning("capacity: zid=%s is poisoned (its last math_rebuild jobs died under "
                       "this source commit, latest %s); parked until a new deploy or a ruling",
                       zid, job_id[:8])
        return job_id
    router.set_job(zid, job_id)
    logger.info("capacity: zid=%s math_rebuild job %s (%s)", zid, outcome, job_id[:8])
    return job_id


__all__ = [
    "ACTIVE_STATES", "ADMISSION_SCHEMA", "DEPTH_COUNTS", "DEPTH_FIELDS", "DEPTH_VERSION",
    "JOB_FIELDS", "MANIFEST_SCHEMA", "MANIFEST_STREAM", "QueueClient", "QueueProtocolError",
    "QueueRefused", "QueueSettings", "RPC", "Receipt", "STAGE_MATH_REBUILD", "STAGE_POLICY",
    "StagePolicy", "TABLE_RPC",
    "TERMINAL_STATES", "WORKER_CLASS_LARGE", "admission", "canonical_bytes",
    "decode_frame_uri", "encode_frame_uri", "enqueue_routed", "receipt_of", "scope_key",
    "sha256_hex", "validate_depth", "validate_job", "validate_log_rows", "validate_release",
]
