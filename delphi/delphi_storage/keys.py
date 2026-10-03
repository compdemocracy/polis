"""Key construction and shared constants for Delphi Storage V2.

The rules here are part of the cross-language conformance contract
(delphi_storage/conformance/README.md); server/src/storage/delphi/keys.ts
mirrors them exactly.
"""

import re
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING, Union

if TYPE_CHECKING:  # pragma: no cover - typing only, avoids a runtime cycle
    from delphi_storage.models import JobType, RunManifest

ENTITY_RUNS = "runs"
ENTITY_RUN_INPUTS = "run_inputs"
ENTITY_ARTIFACTS = "artifacts"
ENTITY_LATEST = "latest"
ENTITY_TOPIC_MODERATION = "topic_moderation"
ENTITY_COLLECTIVE_STATEMENTS = "collective_statements"

# Entities addressable through the generic put/get/query/delete operations.
# `runs` and `latest` are mutated exclusively through the semantic ops so
# their invariants (optimistic lock, monotonic seq) cannot be bypassed.
GENERIC_ENTITIES = (
    ENTITY_RUN_INPUTS,
    ENTITY_ARTIFACTS,
    ENTITY_TOPIC_MODERATION,
    ENTITY_COLLECTIVE_STATEMENTS,
)

ALL_ENTITIES = (ENTITY_RUNS, ENTITY_LATEST) + GENERIC_ENTITIES

# Reserved for backend-internal chunk rows (DynamoDB 400KB item limit);
# forbidden in user-supplied keys.
CHUNK_MARKER = "\x7f"

KEY_SEPARATOR = "#"

LOG_PREFIX = "log#"

_TS_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
_TS_FORMAT = "%Y-%m-%dT%H:%M:%S.%fZ"


def validate_ts(ts: str) -> str:
    """Validate the canonical timestamp format YYYY-MM-DDTHH:MM:SS.mmmZ."""
    if not isinstance(ts, str) or not _TS_RE.match(ts):
        raise ValueError(f"timestamp must be YYYY-MM-DDTHH:MM:SS.mmmZ, got {ts!r}")
    datetime.strptime(ts, _TS_FORMAT)  # reject e.g. month 13
    return ts


def format_ts(dt: datetime) -> str:
    dt = dt.astimezone(timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def now_ts() -> str:
    return format_ts(datetime.now(timezone.utc))


def ts_add_seconds(ts: str, seconds: float) -> str:
    validate_ts(ts)
    dt = datetime.strptime(ts, _TS_FORMAT).replace(tzinfo=timezone.utc)
    return format_ts(dt + timedelta(seconds=seconds))


def _job_type_value(job_type: Union[str, "JobType"]) -> str:
    return getattr(job_type, "value", job_type)


def claim_order(priority: int, enqueued_at: str, job_id: str) -> str:
    """Claim-order string: ascending sort = highest priority first, then FIFO,
    then job_id as tiebreak."""
    p = min(max(int(priority), 0), 9999)
    return f"{9999 - p:04d}#{enqueued_at}#{job_id}"


def scope_for_zid(zid: int, job_type: Union[str, "JobType"]) -> str:
    return f"zid#{zid}#{_job_type_value(job_type)}"


def scope_for_rid(rid: int, job_type: Union[str, "JobType"]) -> str:
    return f"rid#{rid}#{_job_type_value(job_type)}"


def scopes_for_run(run: "RunManifest") -> list[str]:
    """Latest-pointer scopes a completed run flips (design §4.2 entity 4).

    IMPORTED runs never auto-flip: the backfill importer advances pointers
    explicitly under the no-clobber invariant (design §6.2 invariant 1).
    """
    job_type = _job_type_value(run.job_type)
    if job_type == "FULL_PIPELINE":
        if run.zid is None:
            raise ValueError(f"run {run.job_id}: FULL_PIPELINE requires zid")
        return [scope_for_zid(run.zid, job_type)]
    if job_type in ("NARRATIVE_BATCH", "SERVER_NARRATIVE"):
        if run.rid is None:
            raise ValueError(f"run {run.job_id}: {job_type} requires rid")
        return [scope_for_rid(run.rid, job_type)]
    if job_type == "IMPORTED":
        return []
    raise ValueError(f"run {run.job_id}: unknown job_type {job_type!r}")


def log_sk(seq: int) -> str:
    return f"{LOG_PREFIX}{seq:08d}"


def artifact_key(*parts: Union[str, int]) -> str:
    """Compose an artifact sort key from parts using the existing '#'
    composite convention (e.g. artifact_key('umap', 'topic', 0, 3))."""
    strs = [str(p) for p in parts]
    for s in strs:
        if not s:
            raise ValueError("artifact key parts must be non-empty")
        if CHUNK_MARKER in s:
            raise ValueError("artifact key parts must not contain U+007F")
    return KEY_SEPARATOR.join(strs)
