"""Run-manifest lifecycle helpers (design §4.2 entity 1, §6.1 M1).

Thin, idempotent wrappers over the store's semantic ops, callable from BOTH
the poller and run_delphi without coordination: during the migration window
the OLD job queue remains the single master (§6.2 invariant 3) and the v2
run row is a MIRROR that becomes the manifest as the job executes. Real v2
claim semantics (claim_next_run with leases) activate at the enqueue flip
(P11); until then runs are created directly in their observed state.
"""

from typing import Any, Optional, Union

from delphi_storage.interface import AlreadyExists, DelphiStore, NotFound
from delphi_storage.keys import now_ts
from delphi_storage.models import JobType, RunManifest, RunStatus


def ensure_run(
    store: DelphiStore,
    *,
    job_id: str,
    job_type: Union[JobType, str],
    zid: Optional[int] = None,
    rid: Optional[int] = None,
    priority: int = 0,
    config_requested: Optional[dict] = None,
) -> RunManifest:
    """Create the run row if absent (idempotent — poller and run_delphi may
    both call this for the same job)."""
    run = RunManifest(
        job_id=job_id,
        job_type=JobType(job_type),
        enqueued_at=now_ts(),
        zid=zid,
        rid=rid,
        priority=priority,
        config_requested=config_requested or {},
    )
    try:
        store.enqueue_run(run)
    except AlreadyExists:
        pass
    existing = store.get_run(job_id)
    if existing is None:  # belt-and-braces: enqueued or pre-existing above
        raise NotFound(f"run {job_id!r} vanished right after ensure_run")
    return existing


def mark_running(store: DelphiStore, job_id: str) -> RunManifest:
    return store.update_run_status(job_id, RunStatus.RUNNING)


def record_input_fingerprints(
    store: DelphiStore, job_id: str, fingerprints: dict[str, Any]
) -> RunManifest:
    return store.merge_run_fields(job_id, {"input_fingerprints": fingerprints})


def mark_completed(store: DelphiStore, job_id: str) -> RunManifest:
    """complete_run is idempotent and crash-healing; the latest pointer is
    the commit point (flipped last)."""
    return store.complete_run(job_id)


def mark_failed(store: DelphiStore, job_id: str, error: Optional[str] = None) -> RunManifest:
    return store.update_run_status(job_id, RunStatus.FAILED, error=error)
