"""In-memory reference implementation of the Delphi Storage V2 interface.

The executable specification: the smallest honest implementation of the
conformance contract, used by unit tests and as a test double. Thread-safe
via a single lock (claim atomicity comes for free)."""

import copy
import threading
from typing import Any, Optional, Union

from delphi_storage.interface import (
    AlreadyExists,
    coerce_job_type,
    coerce_run_status,
    DelphiStore,
    Invalid,
    NotFound,
    validate_enqueueable,
    validate_generic_read,
    validate_generic_write,
)
from delphi_storage.keys import claim_order, now_ts, validate_ts, ts_add_seconds
from delphi_storage.models import (
    AdvanceResult,
    JobType,
    LatestPointer,
    RunManifest,
    RunStatus,
    StoreItem,
    TERMINAL_STATUSES,
)

MERGEABLE_DICT_FIELDS = frozenset(
    {
        "config_requested",
        "config_effective",
        "code_version",
        "seeds",
        "input_fingerprints",
        "stage_status",
    }
)
MERGEABLE_SCALAR_FIELDS = frozenset(
    {"math_tick_legacy", "replay_of", "provenance", "replayable", "imported_scope_type"}
)


def _utf8_key(sk: str) -> bytes:
    return sk.encode("utf-8")


def merge_manifest_fields(run: RunManifest, fields: dict[str, Any]) -> RunManifest:
    """Shared shallow-merge semantics (also used by other backends)."""
    updates: dict[str, Any] = {}
    for key, value in fields.items():
        if key in MERGEABLE_DICT_FIELDS:
            if not isinstance(value, dict):
                raise Invalid(f"field {key!r} must be a dict")
            merged = dict(getattr(run, key))
            merged.update(value)
            updates[key] = merged
        elif key in MERGEABLE_SCALAR_FIELDS:
            updates[key] = value
        else:
            raise Invalid(f"field {key!r} is not mergeable")
    return run.model_copy(update=updates)


class MemoryDelphiStore(DelphiStore):
    def __init__(self) -> None:
        self._lock = threading.RLock()
        # entity -> pk -> sk -> (attributes, blob)
        self._kv: dict[str, dict[str, dict[str, tuple[dict, Optional[bytes]]]]] = {}
        self._runs: dict[str, RunManifest] = {}
        self._latest: dict[str, LatestPointer] = {}

    # ---- generic ----

    def put(self, entity: str, item: StoreItem) -> None:
        validate_generic_write(entity, item)
        with self._lock:
            partition = self._kv.setdefault(entity, {}).setdefault(item.pk, {})
            partition[item.sk] = (copy.deepcopy(item.attributes), item.blob)

    def get(self, entity: str, pk: str, sk: str) -> Optional[StoreItem]:
        validate_generic_read(entity)
        with self._lock:
            found = self._kv.get(entity, {}).get(pk, {}).get(sk)
            if found is None:
                return None
            attributes, blob = found
            return StoreItem(pk=pk, sk=sk, attributes=copy.deepcopy(attributes), blob=blob)

    def query_prefix(self, entity: str, pk: str, sk_prefix: str = "") -> list[StoreItem]:
        validate_generic_read(entity)
        with self._lock:
            partition = self._kv.get(entity, {}).get(pk, {})
            sks = sorted((sk for sk in partition if sk.startswith(sk_prefix)), key=_utf8_key)
            return [
                StoreItem(
                    pk=pk, sk=sk, attributes=copy.deepcopy(partition[sk][0]), blob=partition[sk][1]
                )
                for sk in sks
            ]

    def query_between(self, entity: str, pk: str, sk_from: str, sk_to: str) -> list[StoreItem]:
        validate_generic_read(entity)
        lo, hi = _utf8_key(sk_from), _utf8_key(sk_to)
        with self._lock:
            partition = self._kv.get(entity, {}).get(pk, {})
            sks = sorted((sk for sk in partition if lo <= _utf8_key(sk) <= hi), key=_utf8_key)
            return [
                StoreItem(
                    pk=pk, sk=sk, attributes=copy.deepcopy(partition[sk][0]), blob=partition[sk][1]
                )
                for sk in sks
            ]

    def delete_partition(self, entity: str, pk: str) -> int:
        validate_generic_read(entity)
        with self._lock:
            partition = self._kv.get(entity, {}).pop(pk, {})
            return len(partition)

    # ---- runs / queue ----

    def enqueue_run(self, run: RunManifest) -> None:
        validate_enqueueable(run)
        with self._lock:
            if run.job_id in self._runs:
                raise AlreadyExists(f"run {run.job_id!r} already exists")
            self._runs[run.job_id] = run.model_copy(deep=True)

    def get_run(self, job_id: str) -> Optional[RunManifest]:
        with self._lock:
            run = self._runs.get(job_id)
            return run.model_copy(deep=True) if run else None

    def claim_next_run(
        self, worker_id: str, lease_seconds: int, now: Optional[str] = None
    ) -> Optional[RunManifest]:
        now = validate_ts(now) if now is not None else now_ts()
        with self._lock:
            queued = [r for r in self._runs.values() if r.status == RunStatus.QUEUED]
            if not queued:
                return None
            run = min(queued, key=lambda r: claim_order(r.priority, r.enqueued_at, r.job_id))
            claimed = run.model_copy(
                update={
                    "status": RunStatus.RUNNING,
                    "worker_id": worker_id,
                    "started_at": now,
                    "lease_expires_at": ts_add_seconds(now, lease_seconds),
                    "version": run.version + 1,
                }
            )
            self._runs[run.job_id] = claimed
            return claimed.model_copy(deep=True)

    def extend_lease(
        self, job_id: str, worker_id: str, lease_seconds: int, now: Optional[str] = None
    ) -> bool:
        now = validate_ts(now) if now is not None else now_ts()
        with self._lock:
            run = self._runs.get(job_id)
            if run is None or run.status != RunStatus.RUNNING or run.worker_id != worker_id:
                return False
            self._runs[job_id] = run.model_copy(
                update={
                    "lease_expires_at": ts_add_seconds(now, lease_seconds),
                    "version": run.version + 1,
                }
            )
            return True

    def update_run_status(
        self,
        job_id: str,
        status: Union[RunStatus, str],
        error: Optional[str] = None,
        now: Optional[str] = None,
    ) -> RunManifest:
        status = coerce_run_status(status)
        now = validate_ts(now) if now is not None else now_ts()
        with self._lock:
            run = self._runs.get(job_id)
            if run is None:
                raise NotFound(f"run {job_id!r} not found")
            updates: dict[str, Any] = {"status": status, "version": run.version + 1}
            if error is not None:
                updates["error"] = error
            if status in TERMINAL_STATUSES and run.completed_at is None:
                updates["completed_at"] = now
            updated = run.model_copy(update=updates)
            self._runs[job_id] = updated
            return updated.model_copy(deep=True)

    def merge_run_fields(self, job_id: str, fields: dict[str, Any]) -> RunManifest:
        with self._lock:
            run = self._runs.get(job_id)
            if run is None:
                raise NotFound(f"run {job_id!r} not found")
            merged = merge_manifest_fields(run, fields).model_copy(
                update={"version": run.version + 1}
            )
            self._runs[job_id] = merged
            return merged.model_copy(deep=True)

    def advance_latest(
        self,
        scope: str,
        job_id: str,
        job_type: Union[JobType, str],
        only_if_absent_or_imported: bool = False,
        now: Optional[str] = None,
    ) -> AdvanceResult:
        job_type = coerce_job_type(job_type)
        now = validate_ts(now) if now is not None else now_ts()
        with self._lock:
            current = self._latest.get(scope)
            if current is not None:
                if current.job_id == job_id:
                    return AdvanceResult(advanced=False, pointer=current.model_copy())
                if only_if_absent_or_imported and current.job_type != JobType.IMPORTED:
                    return AdvanceResult(advanced=False, pointer=current.model_copy())
            pointer = LatestPointer(
                scope=scope,
                job_id=job_id,
                seq=(current.seq + 1 if current else 1),
                job_type=job_type,
                updated_at=now,
            )
            self._latest[scope] = pointer
            return AdvanceResult(advanced=True, pointer=pointer.model_copy())

    def get_latest(self, scope: str) -> Optional[LatestPointer]:
        with self._lock:
            pointer = self._latest.get(scope)
            return pointer.model_copy() if pointer else None

    def list_runs(
        self,
        zid: Optional[int] = None,
        rid: Optional[int] = None,
        status: Optional[Union[RunStatus, str]] = None,
        limit: int = 100,
    ) -> list[RunManifest]:
        if (zid is None) == (rid is None):
            raise Invalid("exactly one of zid/rid is required")
        status = coerce_run_status(status) if status is not None else None
        with self._lock:
            if zid is not None:
                runs = [r for r in self._runs.values() if r.zid == zid]
            else:
                runs = [r for r in self._runs.values() if r.rid == rid]
            if status is not None:
                runs = [r for r in runs if r.status == status]
            runs.sort(key=lambda r: (r.enqueued_at, r.job_id), reverse=True)
            return [r.model_copy(deep=True) for r in runs[:limit]]

    def _increment_log_seq(self, job_id: str) -> int:
        with self._lock:
            run = self._runs.get(job_id)
            if run is None:
                raise NotFound(f"run {job_id!r} not found")
            seq = run.log_seq + 1
            self._runs[job_id] = run.model_copy(
                update={"log_seq": seq, "version": run.version + 1}
            )
            return seq
