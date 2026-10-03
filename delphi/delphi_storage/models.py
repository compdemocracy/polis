"""Pydantic models for Delphi Storage V2 (design: docs/STORAGE_V2_DESIGN.md §4.2).

All timestamps are strings, exactly ``YYYY-MM-DDTHH:MM:SS.mmmZ`` (UTC,
millisecond precision) so lexicographic order equals time order — see
delphi_storage/conformance/README.md.
"""

from enum import Enum
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator

from delphi_storage.keys import validate_ts


class RunStatus(str, Enum):
    QUEUED = "QUEUED"
    RUNNING = "RUNNING"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"


TERMINAL_STATUSES = frozenset({RunStatus.COMPLETED, RunStatus.FAILED})


class JobType(str, Enum):
    FULL_PIPELINE = "FULL_PIPELINE"
    NARRATIVE_BATCH = "NARRATIVE_BATCH"
    SERVER_NARRATIVE = "SERVER_NARRATIVE"
    IMPORTED = "IMPORTED"


class StoreItem(BaseModel):
    """One logical item in a generic entity: JSON attributes + optional blob."""

    model_config = ConfigDict(extra="forbid")

    pk: str
    sk: str
    attributes: dict[str, Any] = Field(default_factory=dict)
    blob: Optional[bytes] = None


class RunManifest(BaseModel):
    """Queue row and run manifest in one — the row becomes the manifest as the
    job executes (design §4.2 entity 1)."""

    model_config = ConfigDict(extra="ignore")

    job_id: str = Field(min_length=1)
    job_type: JobType
    enqueued_at: str
    status: RunStatus = RunStatus.QUEUED
    zid: Optional[int] = None
    rid: Optional[int] = None
    priority: int = 0
    version: int = 0
    worker_id: Optional[str] = None
    started_at: Optional[str] = None
    completed_at: Optional[str] = None
    lease_expires_at: Optional[str] = None
    error: Optional[str] = None
    replay_of: Optional[str] = None
    provenance: str = "pipeline"
    replayable: bool = True
    imported_scope_type: Optional[str] = None
    math_tick_legacy: Optional[int] = None
    log_seq: int = 0
    config_requested: dict[str, Any] = Field(default_factory=dict)
    config_effective: dict[str, Any] = Field(default_factory=dict)
    code_version: dict[str, Any] = Field(default_factory=dict)
    seeds: dict[str, Any] = Field(default_factory=dict)
    input_fingerprints: dict[str, Any] = Field(default_factory=dict)
    stage_status: dict[str, Any] = Field(default_factory=dict)

    @field_validator("enqueued_at")
    @classmethod
    def _valid_enqueued_at(cls, v: str) -> str:
        return validate_ts(v)

    @field_validator("started_at", "completed_at", "lease_expires_at")
    @classmethod
    def _valid_optional_ts(cls, v: Optional[str]) -> Optional[str]:
        return None if v is None else validate_ts(v)


class LatestPointer(BaseModel):
    """First-class 'latest successful run' pointer (design §4.2 entity 4)."""

    scope: str
    job_id: str
    seq: int
    job_type: JobType
    updated_at: str


class AdvanceResult(BaseModel):
    advanced: bool
    pointer: LatestPointer
