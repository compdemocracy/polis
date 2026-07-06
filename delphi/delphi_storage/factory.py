"""Backend selection for Delphi Storage V2 (design §4.3).

Config surface:

- ``DELPHI_STORAGE_BACKEND``      — ``dynamodb`` (default) | ``postgres`` | ``memory``
- ``DELPHI_STORAGE_TABLE_PREFIX`` — DynamoDB table prefix (default ``Delphi2_``)
- ``DELPHI_STORAGE_PG_SCHEMA``    — PostgreSQL schema (default ``delphi``)
- ``DELPHI_STORAGE_PG_URL``       — PostgreSQL URL (falls back to ``DATABASE_URL``)
- ``DYNAMODB_ENDPOINT`` / ``AWS_REGION`` — existing vocabulary, reused as-is
"""

import os
from typing import Optional

from delphi_storage.interface import DelphiStore, Invalid


def get_store(backend: Optional[str] = None, **overrides) -> DelphiStore:
    backend = backend or os.environ.get("DELPHI_STORAGE_BACKEND", "dynamodb")
    if backend == "memory":
        from delphi_storage.backends.memory import MemoryDelphiStore

        return MemoryDelphiStore()
    if backend == "dynamodb":
        from delphi_storage.backends.dynamodb import DynamoDelphiStore

        return DynamoDelphiStore(**overrides)
    if backend == "postgres":
        from delphi_storage.backends.postgres import PostgresDelphiStore

        return PostgresDelphiStore(**overrides)
    raise Invalid(
        f"unknown DELPHI_STORAGE_BACKEND {backend!r} (expected dynamodb|postgres|memory)"
    )
