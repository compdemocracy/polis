"""The committed zero-vote schedule is the single empty-output contract.

Wheel builds copy that schedule verbatim into this package. Source checkouts
read the original file; no independent table of empty values is maintained.
"""
from copy import deepcopy
from functools import lru_cache
import hashlib
import json
from pathlib import Path
from typing import Any


@lru_cache(maxsize=1)
def _schedule() -> dict[str, Any]:
    packaged = Path(__file__).with_name("empty_output_schedule.json")
    source = Path(__file__).resolve().parents[1] / "scripts/schedules/pc-zerovote-01-empty.json"
    return json.loads((packaged if packaged.is_file() else source).read_text())


def empty_contract() -> dict[str, Any]:
    """Return isolated values: serializers must not mutate the contract."""
    return deepcopy(_schedule()["empty_output"])


def legacy_absent_keys() -> tuple[str, ...]:
    return tuple(_schedule()["legacy_absent_keys"])


def contract_sha256() -> str:
    value = {key: _schedule()[key] for key in ("empty_output", "legacy_absent_keys")}
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"),
                                     allow_nan=False).encode()).hexdigest()


def apply_empty_contract(main: dict[str, Any]) -> dict[str, Any]:
    """Apply declared fields only; retain identity and non-contract metadata."""
    for path, value in empty_contract().items():
        if path.startswith("pca."):
            main.setdefault("pca", {})[path.split(".", 1)[1]] = value
        else:
            main[path] = value
    main["pca"].setdefault("comps", [[], []])
    return main
