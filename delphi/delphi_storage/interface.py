"""The backend-neutral Delphi Storage V2 repository interface.

Neither DynamoDB nor PostgreSQL is privileged (design §2): every backend
implements this ABC and must pass the shared conformance suite
(delphi_storage/conformance/). The TypeScript twin lives in
server/src/storage/delphi/interface.ts.
"""

from abc import ABC, abstractmethod
from typing import Any, Optional, Sequence, Union

from delphi_storage.codec import canonical_json_dumps
from delphi_storage.keys import (
    CHUNK_MARKER,
    GENERIC_ENTITIES,
    log_sk,
    now_ts,
    scopes_for_run,
    validate_ts,
)
from delphi_storage.models import (
    AdvanceResult,
    JobType,
    LatestPointer,
    RunManifest,
    RunStatus,
    StoreItem,
)


class StorageError(Exception):
    """Base class; ``code`` is the cross-language error name used by the
    conformance cases."""

    code = "storage_error"


class AlreadyExists(StorageError):
    code = "already_exists"


class NotFound(StorageError):
    code = "not_found"


class Invalid(StorageError):
    code = "invalid"


def validate_generic_write(entity: str, item: StoreItem) -> None:
    """Contract checks shared by every backend's generic write path."""
    if entity not in GENERIC_ENTITIES:
        raise Invalid(
            f"entity {entity!r} is not writable through generic ops "
            f"(allowed: {', '.join(GENERIC_ENTITIES)})"
        )
    if not item.pk:
        raise Invalid("pk must be non-empty")
    if not item.sk:
        raise Invalid("sk must be non-empty")
    if CHUNK_MARKER in item.sk or CHUNK_MARKER in item.pk:
        raise Invalid("keys must not contain U+007F (reserved chunk marker)")
    for key in item.attributes:
        if key.startswith("_"):
            raise Invalid(f"attribute {key!r}: top-level '_' prefix is reserved for backends")
    try:
        canonical_json_dumps(item.attributes)
    except (TypeError, ValueError) as e:
        raise Invalid(f"attributes must be JSON-safe (no NaN/Infinity): {e}") from e


def validate_generic_read(entity: str) -> None:
    if entity not in GENERIC_ENTITIES:
        raise Invalid(f"entity {entity!r} is not readable through generic ops")


def coerce_run_status(status: Union[RunStatus, str]) -> RunStatus:
    """Backends validate every externally supplied status (a typo'd status
    silently persisted would make a run permanently unclaimable)."""
    try:
        return RunStatus(status)
    except ValueError as e:
        raise Invalid(str(e)) from e


def coerce_job_type(job_type: Union[JobType, str]) -> JobType:
    try:
        return JobType(job_type)
    except ValueError as e:
        raise Invalid(str(e)) from e


def validate_enqueueable(run: RunManifest) -> None:
    """Contract checks shared by every backend's enqueue_run: status must be
    QUEUED and the job_type↔zid/rid coupling must already be satisfiable, so
    a run can never reach COMPLETED and then fail to derive its latest scopes
    (that would leave it stuck: completed but never published)."""
    if run.status != RunStatus.QUEUED:
        raise Invalid(f"enqueued runs must be QUEUED, got {run.status}")
    try:
        scopes_for_run(run)
    except ValueError as e:
        raise Invalid(str(e)) from e


class DelphiStore(ABC):
    """Neutral repository over runs / run_inputs / artifacts / latest /
    topic_moderation / collective_statements (design §4.2-4.3)."""

    # ---- generic operations (run_inputs, artifacts, topic_moderation,
    # ---- collective_statements) ----

    @abstractmethod
    def put(self, entity: str, item: StoreItem) -> None:
        """Upsert one item. Blobs round-trip bit-exactly regardless of size."""

    def put_batch(self, entity: str, items: Sequence[StoreItem]) -> None:
        for item in items:
            self.put(entity, item)

    @abstractmethod
    def get(self, entity: str, pk: str, sk: str) -> Optional[StoreItem]:
        """Fetch one item (blob fully reassembled), or None."""

    @abstractmethod
    def query_prefix(self, entity: str, pk: str, sk_prefix: str = "") -> list[StoreItem]:
        """All items in a partition whose sk starts with the prefix, in UTF-8
        byte order."""

    @abstractmethod
    def query_between(self, entity: str, pk: str, sk_from: str, sk_to: str) -> list[StoreItem]:
        """All items with sk_from <= sk <= sk_to (inclusive), in UTF-8 byte order."""

    @abstractmethod
    def delete_partition(self, entity: str, pk: str) -> int:
        """Delete every item in the partition; returns the number of logical
        items removed."""

    # ---- runs / queue ----

    @abstractmethod
    def enqueue_run(self, run: RunManifest) -> None:
        """Create a QUEUED run. Raises AlreadyExists for a duplicate job_id,
        Invalid if the manifest's status is not QUEUED."""

    @abstractmethod
    def get_run(self, job_id: str) -> Optional[RunManifest]: ...

    @abstractmethod
    def claim_next_run(
        self,
        worker_id: str,
        lease_seconds: int,
        now: Optional[str] = None,
    ) -> Optional[RunManifest]:
        """Atomically claim the QUEUED run with the smallest claim order
        (priority desc, then FIFO); None when nothing is claimable. Two
        claimants can never claim the same run."""

    @abstractmethod
    def extend_lease(
        self,
        job_id: str,
        worker_id: str,
        lease_seconds: int,
        now: Optional[str] = None,
    ) -> bool:
        """True iff the run is RUNNING and owned by worker_id."""

    @abstractmethod
    def update_run_status(
        self,
        job_id: str,
        status: Union[RunStatus, str],
        error: Optional[str] = None,
        now: Optional[str] = None,
    ) -> RunManifest:
        """Set the run status (no latest flip); terminal statuses stamp
        completed_at. Raises NotFound."""

    @abstractmethod
    def merge_run_fields(self, job_id: str, fields: dict[str, Any]) -> RunManifest:
        """Shallow-merge provenance fields (config_effective, seeds, ...) into
        the manifest. Raises NotFound; Invalid for non-mergeable fields."""

    @abstractmethod
    def advance_latest(
        self,
        scope: str,
        job_id: str,
        job_type: Union[JobType, str],
        only_if_absent_or_imported: bool = False,
        now: Optional[str] = None,
    ) -> AdvanceResult:
        """Advance the latest pointer for a scope: seq is monotonic (+1 per
        advance). Advancing to the already-referenced job is a successful
        no-op. With only_if_absent_or_imported (backfill importer mode,
        design §6.2 invariant 1) the advance is refused unless the current
        pointer is absent or references an IMPORTED run."""

    @abstractmethod
    def get_latest(self, scope: str) -> Optional[LatestPointer]: ...

    @abstractmethod
    def list_runs(
        self,
        zid: Optional[int] = None,
        rid: Optional[int] = None,
        status: Optional[Union[RunStatus, str]] = None,
        limit: int = 100,
    ) -> list[RunManifest]:
        """Runs for a conversation (zid) or report (rid), newest-first by
        enqueued_at (job_id desc as tiebreak). Exactly one of zid/rid."""

    # ---- concrete semantics shared by all backends ----

    def complete_run(self, job_id: str, now: Optional[str] = None) -> RunManifest:
        """Mark COMPLETED then advance latest for the run's scopes — the
        pointer is the commit point, written last (design §4.2). Idempotent
        and crash-healing: re-completing re-attempts the pointer advance
        without double-incrementing seq. Raises Invalid on FAILED runs."""
        now = validate_ts(now) if now is not None else now_ts()
        run = self.get_run(job_id)
        if run is None:
            raise NotFound(f"run {job_id!r} not found")
        if run.status == RunStatus.FAILED:
            raise Invalid(f"run {job_id!r} is FAILED and cannot be completed")
        try:
            # Derive scopes BEFORE flipping the status: a run that cannot
            # publish must fail cleanly, not end up COMPLETED-but-unpublished.
            scopes = scopes_for_run(run)
        except ValueError as e:
            raise Invalid(str(e)) from e
        if run.status != RunStatus.COMPLETED:
            run = self.update_run_status(job_id, RunStatus.COMPLETED, now=now)
        for scope in scopes:
            self.advance_latest(scope, run.job_id, run.job_type, now=now)
        return run

    def append_log(self, job_id: str, message: str, now: Optional[str] = None) -> int:
        """Append-only run log as artifacts items (replaces the old
        truncate-to-50 job log). Returns the 1-based seq."""
        now = validate_ts(now) if now is not None else now_ts()
        seq = self._increment_log_seq(job_id)
        self.put(
            "artifacts",
            StoreItem(pk=job_id, sk=log_sk(seq), attributes={"ts": now, "message": message}),
        )
        return seq

    @abstractmethod
    def _increment_log_seq(self, job_id: str) -> int:
        """Atomically allocate the next log seq for a run. Raises NotFound."""
