"""Delphi Storage V2 — backend-neutral repository for runs, inputs, artifacts,
and latest pointers (design: docs/STORAGE_V2_DESIGN.md).

Public surface:

    from delphi_storage import get_store
    store = get_store()  # DELPHI_STORAGE_BACKEND=dynamodb|postgres|memory
"""

from delphi_storage.factory import get_store
from delphi_storage.interface import (
    AlreadyExists,
    DelphiStore,
    Invalid,
    NotFound,
    StorageError,
)
from delphi_storage.models import (
    AdvanceResult,
    JobType,
    LatestPointer,
    RunManifest,
    RunStatus,
    StoreItem,
)

__all__ = [
    "AdvanceResult",
    "AlreadyExists",
    "DelphiStore",
    "Invalid",
    "JobType",
    "LatestPointer",
    "NotFound",
    "RunManifest",
    "RunStatus",
    "StorageError",
    "StoreItem",
    "get_store",
]
