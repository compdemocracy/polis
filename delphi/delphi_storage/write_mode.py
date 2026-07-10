"""DELPHI_WRITE_MODE — the migration's writer tri-state (design §4.3, §6.1).

- ``old``  — M0: only the legacy tables are written (today's behavior).
- ``both`` — M1..M5: legacy tables exactly as today AND v2
  runs/inputs/artifacts/latest. The whole migration window runs here; it is
  what makes the M4 flip-back lossless (§6.2 invariant 2).
- ``v2``   — M6+ / fresh deployments: v2 only.

FAIL-LOUD when unset (locked design decision): a silently-defaulted writer
would break invariant 2 undetected. Deployments must set it explicitly;
example.env and the test compose file carry ``old`` so dev/test environments
keep working. An explicit tri-state (not a boolean) so its meaning never
inverts mid-migration.
"""

import os
from enum import Enum

from delphi_storage.interface import Invalid

ENV_VAR = "DELPHI_WRITE_MODE"


class WriteMode(str, Enum):
    OLD = "old"
    BOTH = "both"
    V2 = "v2"


def resolve_write_mode() -> WriteMode:
    raw = os.environ.get(ENV_VAR)
    if raw is None:
        raise Invalid(
            f"{ENV_VAR} is not set. This deployment must state its migration "
            f"write mode explicitly (old|both|v2) — a silently-defaulted "
            f"writer would undermine the flip-back guarantee "
            f"(STORAGE_V2_DESIGN.md §4.3/§6.2). Set {ENV_VAR}=old for "
            f"pre-migration (M0) behavior."
        )
    try:
        return WriteMode(raw.strip().lower())
    except ValueError as e:
        raise Invalid(
            f"{ENV_VAR}={raw!r} is not a valid write mode (expected old|both|v2)"
        ) from e


def v2_writes_enabled(mode: WriteMode) -> bool:
    return mode in (WriteMode.BOTH, WriteMode.V2)


def old_writes_enabled(mode: WriteMode) -> bool:
    return mode in (WriteMode.OLD, WriteMode.BOTH)
