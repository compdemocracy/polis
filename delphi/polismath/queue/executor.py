"""Standalone transitional executor for polis-queue/1 synthetic ``noop`` jobs.

P-024 first slice. Claims a job with ``pq_claim``, renews its lease with
``pq_heartbeat``, and finalizes with ``pq_finalize``; reserves one bounded
reaper opportunity per cycle through ``pq_due`` plus one committed
``pq_reap_one`` per job. Nothing else.

Boundaries this module keeps, all of them deliberate:

* It touches neither existing poller. ``polismath.poller`` and
  ``scripts/job_poller.py`` neither import this nor are imported by it, so
  rollback is stopping a process.
* The stage is ``noop`` and its output is exactly its fixed synthetic input
  descriptor. It never follows the input URI, reads a file named by a job,
  starts a child process, loads science code or calls a provider. A job whose
  descriptor is not the expected synthetic one is failed permanently rather
  than executed.
* It refuses to run on a broad database login. Every connection asserts
  membership in ``polis_queue_executor``, the absence of ANY table-level or
  column-level privilege on all five queue tables, and the inability to reach
  ``polis_queue_owner`` by inheritance or SET ROLE. One denied UPDATE on one
  table would not be proof of the boundary: executor membership plus UPDATE on
  ``polis_queue_heads`` would pass that and still move a published pointer
  behind the functions' backs.
* One active job and one connection at a time. Every RPC opens and commits its
  own short transaction, including the reaper's per-job mutations.
* The set of statements it can issue is a closed inventory with fixed argument
  casts. Values are always bound, never interpolated.

Not claimed: the Rust adapter, gates A1-A8, a severed-COMMIT certificate, or a
recovery certificate. The reaper cursor lives in memory, so a restart begins a
pass again, which is safe because every mutation rechecks current state.

Run it directly; see docs/queue-substrate.md.
"""

import argparse
import hashlib
import logging
import os
import re
import sys
import time
import uuid
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional, Tuple

import psycopg2

logger = logging.getLogger(__name__)

SCHEMA_VERSION = "polis-queue/1"

#: SHA-256 of ``server/postgres/migrations/000019_create_polis_queue.sql`` as
#: this adapter was written against it. Round 4 requires both adapters to pin
#: the SQL so that neither is silently upgraded by a schema change; the Node
#: adapter pins the same value in ``server/src/queue/protocol.ts``. This pins
#: the repository file, and is not runtime attestation about the live catalog.
QUEUE_SQL_SHA256 = "2d8e205f1d36e0e2e6a4fc63d1d03cbf8837ca57ccaac503c88238fa2a14a055"

#: The fixed synthetic input descriptor of the /1 noop stage. The enqueuer pins
#: it and this executor refuses anything else.
NOOP_URI = "synthetic:polis-queue-noop/1"
NOOP_SHA256 = hashlib.sha256(b"polis-queue-noop/1\n").hexdigest()
NOOP_IMAGE = "synthetic-noop/1"

#: Repeating weighted lane slots. 0 is most urgent; the cycle guarantees lane 2
#: is visited at least once every six claim opportunities.
LANES: Tuple[int, ...] = (0, 0, 0, 1, 1, 2)

#: Closed field set of an ordinary reply.
ORDINARY_FIELDS = frozenset(
    "schema_version outcome env job_id run_id attempt_id owner_id lease_epoch "
    "version mgmt_version locked_until state output_sha256 published stage "
    "stage_instance attempt_count max_attempts parked_attempt_count eligible_at "
    "first_parked_at last_error_code input".split()
)
INPUT_FIELDS = frozenset(("uri", "sha256", "config_sha256", "code_image_digest"))

#: Closed field set of the separate head-status envelope.
HEAD_STATUS_FIELDS = frozenset(
    "schema_version outcome env product_key found desired_run_id desired_state "
    "published_run_id published_generation published_sha256".split()
)

#: Closed statement inventory with fixed casts. There is no path to arbitrary
#: SQL: a name outside this mapping raises before any connection is opened.
RPC: Dict[str, Tuple[str, ...]] = {
    "pq_claim": ("text", "smallint", "uuid", "uuid", "integer"),
    "pq_heartbeat": ("text", "uuid", "uuid", "uuid", "bigint", "integer"),
    "pq_finalize": ("text", "uuid", "uuid", "uuid", "bigint", "text", "text"),
    "pq_fail": ("text", "uuid", "uuid", "uuid", "bigint", "boolean", "text"),
    "pq_release": ("text", "uuid", "uuid", "uuid", "bigint"),
    "pq_park": ("text", "uuid", "uuid", "uuid", "bigint", "text"),
    "pq_job_status": ("text", "uuid"),
    "pq_head_status": ("text", "text"),
    "pq_due": ("text", "uuid", "integer"),
    "pq_reap_one": ("text", "uuid"),
}

#: Transient SQLSTATEs the design document admits for a bounded retry.
RETRYABLE_SQLSTATES = frozenset(("40001", "40P01", "55P03", "57014"))
MAX_RETRIES = 3

#: dev or test, optionally suffixed for per-run isolation in tests.
_ENV_NAMESPACE = re.compile(r"^(dev|test)(-[a-z0-9][a-z0-9-]{0,48})?$")
_TRUTHY = frozenset(("true", "1", "yes", "on"))

_SESSION_POLICY = (
    "SET LOCAL TIME ZONE 'UTC';"
    " SET LOCAL lock_timeout='500ms';"
    " SET LOCAL statement_timeout='5s';"
    " SET LOCAL idle_in_transaction_session_timeout='5s';"
    " SELECT set_config('transaction_timeout','10s',true)"
    " WHERE current_setting('server_version_num')::int >= 170000"
)

#: Every table the executor must reach only through the granted RPCs.
QUEUE_TABLES = (
    "public.polis_queue_runs",
    "public.polis_queue_heads",
    "public.polis_queue_jobs",
    "public.polis_queue_attempts",
    "public.polis_queue_requests",
)

#: The admission gate, re-checked on every connection. A single denied UPDATE on
#: one table is not proof of the grant boundary: a login with executor
#: membership plus UPDATE on polis_queue_heads would pass that and still be able
#: to move a published pointer behind the functions' backs. So this asks, for
#: each of the five tables, whether the login holds ANY table-level or
#: column-level privilege, and separately whether it can reach polis_queue_owner
#: by inheritance or SET ROLE, which would hand it everything anyway.
_BOUNDARY_SQL = (
    "SELECT pg_has_role(current_user,'polis_queue_executor','MEMBER') AS member,"
    " (SELECT COALESCE(bool_or("
    "   has_table_privilege(current_user,t,"
    "     'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')"
    "   OR has_any_column_privilege(current_user,t,"
    "     'SELECT,INSERT,UPDATE,REFERENCES')),false)"
    "  FROM unnest(%s::text[]) t) AS direct_access,"
    " pg_has_role(current_user,'polis_queue_owner','USAGE')"
    "  OR pg_has_role(current_user,'polis_queue_owner','MEMBER') AS owner_escape"
)


class ProtocolError(ValueError):
    """A reply that is not an ordinary polis-queue/1 result."""


class ExecutorRefused(RuntimeError):
    """A precondition that must never be worked around at runtime."""


class CommitOutcomeUnknown(RuntimeError):
    """A COMMIT that did not report success.

    The transaction may or may not be durable. Keep the SELECT's reply so the
    caller can reconcile the identity it already holds; never infer a rollback.
    """

    def __init__(self, reply: Any) -> None:
        super().__init__("queue_commit_outcome_unknown")
        self.reply = reply


def validate(reply: Any) -> Dict[str, Any]:
    """Reject a reply that is not an ordinary polis-queue/1 result.

    Missing and unknown fields both fail: the field set is frozen by the
    migration, not by the version string.
    """
    if not isinstance(reply, dict) or set(reply) != ORDINARY_FIELDS:
        raise ProtocolError("queue_wire_fields")
    if reply["schema_version"] != SCHEMA_VERSION:
        raise ProtocolError("queue_wire_version")
    if type(reply["published"]) is not bool:
        raise ProtocolError("queue_wire_published")
    for key in ("lease_epoch", "version", "mgmt_version"):
        value = reply[key]
        if value is not None and (
            not isinstance(value, str) or re.fullmatch(r"[0-9]+", value) is None
        ):
            raise ProtocolError("queue_wire_counter")
    for key in ("attempt_count", "max_attempts", "parked_attempt_count"):
        value = reply[key]
        if value is not None and (
            type(value) is not int or not 0 <= value <= 2147483647
        ):
            raise ProtocolError("queue_wire_count")
    for key in ("locked_until", "eligible_at", "first_parked_at"):
        value = reply[key]
        if value is not None and (
            not isinstance(value, str) or not value.endswith("+00:00")
        ):
            raise ProtocolError("queue_wire_timestamp")
    for key in (
        "env",
        "job_id",
        "run_id",
        "attempt_id",
        "owner_id",
        "state",
        "output_sha256",
        "stage",
        "stage_instance",
        "last_error_code",
        "outcome",
    ):
        if reply[key] is not None and not isinstance(reply[key], str):
            raise ProtocolError("queue_wire_text")
    descriptor = reply["input"]
    if descriptor is not None and (
        not isinstance(descriptor, dict)
        or set(descriptor) != INPUT_FIELDS
        or not all(isinstance(v, str) for v in descriptor.values())
    ):
        raise ProtocolError("queue_wire_input")
    return reply


def validate_head_status(reply: Any) -> Dict[str, Any]:
    """Reject a reply that is not the closed pq_head_status envelope."""
    if not isinstance(reply, dict) or set(reply) != HEAD_STATUS_FIELDS:
        raise ProtocolError("queue_wire_head_fields")
    if reply["schema_version"] != SCHEMA_VERSION or reply["outcome"] != "head_status":
        raise ProtocolError("queue_wire_head_version")
    if type(reply["found"]) is not bool:
        raise ProtocolError("queue_wire_head_found")
    generation = reply["published_generation"]
    if generation is not None and (
        not isinstance(generation, str) or re.fullmatch(r"[0-9]+", generation) is None
    ):
        raise ProtocolError("queue_wire_head_generation")
    return reply


def _enabled() -> bool:
    if os.environ.get("NODE_ENV") == "production":
        return False
    return os.environ.get("POLIS_QUEUE_SUBSTRATE_ENABLED", "").lower() in _TRUTHY


@dataclass(frozen=True)
class Settings:
    """Connection and environment settings for one executor process.

    ``dsn`` must name a login that is a member of ``polis_queue_executor``; the
    boundary is verified on every connection, not only at startup.
    """

    dsn: str
    env: str
    connect_timeout: int = 5

    def check(self) -> None:
        if not _enabled():
            raise ExecutorRefused(
                "queue_noop_disabled: set POLIS_QUEUE_SUBSTRATE_ENABLED outside production"
            )
        if _ENV_NAMESPACE.fullmatch(self.env) is None:
            raise ExecutorRefused("queue_noop_environment")
        if not self.dsn:
            raise ExecutorRefused("queue_noop_dsn")


class Database:
    """One short transaction per call, on its own connection.

    A connection is never pooled or reused across calls: a session whose
    transaction outcome is uncertain must not be handed to the next statement.
    """

    def __init__(self, settings: Settings) -> None:
        settings.check()
        self.settings = settings

    def call(self, name: str, args: List[Any]) -> Any:
        casts = RPC[name]  # KeyError here is a programming error, not input
        if len(args) != len(casts):
            raise ValueError("queue_rpc_arity")
        placeholders = ",".join("%s::" + cast for cast in casts)
        statement = (
            "SELECT "
            + ("job_id FROM " if name == "pq_due" else "")
            + "public."
            + name
            + "("
            + placeholders
            + ")"
        )
        conn = psycopg2.connect(
            self.settings.dsn,
            connect_timeout=self.settings.connect_timeout,
            application_name="polis-queue-noop/1",
        )
        try:
            conn.set_session(isolation_level="READ COMMITTED")
            with conn.cursor() as cur:
                cur.execute(_SESSION_POLICY)
                cur.execute(_BOUNDARY_SQL, [list(QUEUE_TABLES)])
                member, direct_access, owner_escape = cur.fetchone()
                if not member:
                    raise ExecutorRefused("queue_noop_requires_executor_membership")
                if direct_access:
                    raise ExecutorRefused("queue_noop_login_has_direct_table_access")
                if owner_escape:
                    raise ExecutorRefused("queue_noop_login_can_become_queue_owner")
                cur.execute(statement, args)
                if name == "pq_due":
                    reply: Any = [str(row[0]) for row in cur.fetchall()]
                else:
                    reply = cur.fetchone()[0]
                    if reply is None:
                        # Only pq_reap_one is specified to return SQL NULL.
                        if name != "pq_reap_one":
                            raise ProtocolError("queue_unexpected_null_reply")
                    elif name == "pq_head_status":
                        validate_head_status(reply)
                    else:
                        validate(reply)
            try:
                conn.commit()
            except psycopg2.Error as exc:
                raise CommitOutcomeUnknown(reply) from exc
            return reply
        finally:
            conn.close()


class Executor:
    """One executor process: at most one active job, one connection at a time."""

    def __init__(
        self,
        database: Database,
        env: str,
        sleep: Callable[[float], None] = time.sleep,
        lease_seconds: int = 60,
    ) -> None:
        if _ENV_NAMESPACE.fullmatch(env) is None:
            raise ExecutorRefused("queue_noop_environment")
        self.db = database
        self.env = env
        self.sleep = sleep
        self.lease_seconds = lease_seconds
        self.owner = str(uuid.uuid4())
        self.slot = 0
        self.after_job: Optional[str] = None

    def call(self, name: str, args: List[Any], reconcile: bool = True) -> Any:
        """Call one RPC, retrying a bounded number of transient failures.

        The retry always repeats the SAME identity. ``reconcile=False`` is for
        pq_claim, whose uncertain COMMIT must never be repeated: see run_once.
        """
        for retry in range(MAX_RETRIES + 1):
            try:
                return self.db.call(name, args)
            except CommitOutcomeUnknown:
                if not reconcile or retry == MAX_RETRIES:
                    raise
            except psycopg2.Error as exc:
                if exc.pgcode not in RETRYABLE_SQLSTATES or retry == MAX_RETRIES:
                    raise
            self.sleep(
                min(300, 5 * 2**retry) + uuid.UUID(self.owner).bytes[-1] % 5
            )
        raise AssertionError("unreachable")

    def token(self, job: Dict[str, Any]) -> List[Any]:
        """The active token: (env, job, owner, attempt, lease_epoch)."""
        return [
            self.env,
            job["job_id"],
            self.owner,
            job["attempt_id"],
            job["lease_epoch"],
        ]

    def reap_page(self) -> int:
        """One bounded reaper pass: discovery commits, then one tx per job."""
        ids = self.call("pq_due", [self.env, self.after_job, 100])
        for job_id in ids:
            self.call("pq_reap_one", [self.env, job_id])
        # Persist the cursor only after the page is handled, and reset it on a
        # short page so a following empty page starts the next pass over.
        self.after_job = ids[-1] if len(ids) == 100 else None
        return len(ids)

    def run_once(self) -> str:
        """Reserve maintenance, then claim and complete at most one job."""
        self.reap_page()
        preferred = LANES[self.slot]
        self.slot = (self.slot + 1) % len(LANES)
        lanes = [preferred] + [lane for lane in range(3) if lane != preferred]
        for priority in lanes:
            attempt = str(uuid.uuid4())
            try:
                job = self.call(
                    "pq_claim",
                    [self.env, priority, self.owner, attempt, self.lease_seconds],
                    reconcile=False,
                )
            except CommitOutcomeUnknown as exc:
                # Never repeat pq_claim: its first COMMIT may already have taken
                # ownership of a job, and a second claim would take a second one
                # while the first lease runs unattended. Renew the exact token
                # the uncertain reply named instead, on a fresh connection.
                # The identity of that reply is checked BEFORE it is used as a
                # token, not after.
                job = validate(exc.reply)
                if job["outcome"] != "owned":
                    raise
                self._assert_claim_identity(job, attempt)
                job = self.call("pq_heartbeat", self.token(job) + [self.lease_seconds])
                if job["outcome"] != "owned":
                    return str(job["outcome"])
            if job["outcome"] == "none":
                continue
            if job["outcome"] == "fenced":
                return "fenced"
            self._assert_claim_identity(job, attempt)
            return self._execute(job)
        return "none"

    def _assert_claim_identity(self, job: Dict[str, Any], attempt: str) -> None:
        """The reply must name the token this process asked for.

        The attempt UUID is minted here and is half of the fence, so a reply
        carrying a different one is not this claim's job and its token must not
        be used. Comparing the finalize reply against an already-wrong claim
        reply is not equivalent: the two would simply agree with each other.
        """
        if (
            job["outcome"] != "owned"
            or job["env"] != self.env
            or job["owner_id"] != self.owner
            or job["attempt_id"] != attempt
        ):
            raise ProtocolError("queue_claim_identity")

    def _execute(self, job: Dict[str, Any]) -> str:
        expected = {
            "uri": NOOP_URI,
            "sha256": NOOP_SHA256,
            "config_sha256": NOOP_SHA256,
            "code_image_digest": NOOP_IMAGE,
        }
        if (
            job["stage"] != "noop"
            or job["stage_instance"] is not None
            or job["input"] != expected
        ):
            # Refuse rather than execute: this executor admits exactly one
            # synthetic descriptor and never dereferences a job-supplied URI.
            return str(
                self.call(
                    "pq_fail",
                    self.token(job) + [True, "invalid_synthetic_descriptor"],
                )["outcome"]
            )
        renewed = self.call("pq_heartbeat", self.token(job) + [self.lease_seconds])
        if renewed["outcome"] == "fenced":
            return "fenced"
        if renewed["outcome"] != "owned":
            raise ProtocolError("queue_renewal_outcome")
        # The noop stage's output is exactly its fixed input. No long work, no
        # child process, no network call is performed while holding this lease.
        result = self.call(
            "pq_finalize", self.token(job) + [NOOP_URI, NOOP_SHA256]
        )
        outcome = str(result["outcome"])
        if outcome not in {"succeeded", "already_succeeded", "fenced", "invalid_output"}:
            raise ProtocolError("queue_finalize_outcome")
        if outcome in {"succeeded", "already_succeeded"} and (
            result["job_id"] != job["job_id"]
            or result["attempt_id"] != job["attempt_id"]
            or result["output_sha256"] != NOOP_SHA256
        ):
            # Success must match identity AND content, not merely a succeeded
            # state: another attempt's success cannot be borrowed.
            raise ProtocolError("queue_finalize_identity")
        return outcome


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="polis-queue/1 noop executor")
    parser.add_argument(
        "--dsn",
        required=True,
        help="libpq DSN for a login that is a member of polis_queue_executor",
    )
    parser.add_argument("--env", required=True, help="queue env namespace: dev or test")
    parser.add_argument(
        "--once", action="store_true", help="run one cycle and exit"
    )
    parser.add_argument("--interval", type=float, default=1.0)
    args = parser.parse_args(argv)
    try:
        executor = Executor(Database(Settings(args.dsn, args.env)), args.env)
        while True:
            outcome = executor.run_once()
            print(outcome, flush=True)
            if args.once:
                return 0 if outcome in {"succeeded", "already_succeeded", "none"} else 3
            time.sleep(args.interval)
    except KeyboardInterrupt:
        # No external effect is in flight; a mid-attempt interrupt leaves its
        # lease to expire and be reaped.
        return 0
    except Exception as exc:  # noqa: BLE001 - never echo DSN or bound values
        print(f"queue_noop_error:{type(exc).__name__}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
