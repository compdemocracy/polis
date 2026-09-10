"""Explicit historical replay admission; never learn a pin from fresh output."""
import copy
import hashlib
import json
from pathlib import Path
import platform
import re

WITNESSES = {"polarity-public-fixture.json", "polarity-vw.json", "polarity-biodiversity.json",
             "polarity-rebuild-schedule.json", "semantic-tie-key.json",
             "d4-node-reader.json", "d4-node-reader-empty.json"}


def runtime_identity():
    # Load both numerical backends in the same Python and thread environment
    # used by the campaign children. BLAS is diagnostic, not a fallback key.
    import numpy
    import scipy.linalg
    from threadpoolctl import threadpool_info

    numpy.dot(numpy.ones((2, 2)), numpy.ones((2, 2)))
    scipy.linalg.blas.dgemm(1, numpy.eye(2), numpy.eye(2))
    libraries = [{k: row[k] for k in (
        "user_api", "internal_api", "prefix", "version", "threading_layer",
        "architecture", "num_threads") if k in row}
        for row in threadpool_info() if row["user_api"] == "blas"]
    return {"system": platform.system(), "machine": platform.machine(),
            "platform": platform.platform(), "python": platform.python_version(),
            "blas": libraries, "blas_observed": bool(libraries)}


def select_pin(runtime, path):
    raw = Path(path).read_bytes()
    registry = json.loads(raw)
    if registry.get("schema") != "polis-replay-platform-pins/1":
        raise ValueError("REPLAY_PLATFORM_PINS_INVALID: schema")
    pins = registry["pins"]
    keys = [(p["system"], p["machine"]) for p in pins]
    ids = [p["id"] for p in pins]
    if not pins or len(keys) != len(set(keys)) or len(ids) != len(set(ids)):
        raise ValueError("REPLAY_PLATFORM_PINS_INVALID: duplicate or empty registry")
    key = (runtime["system"], runtime["machine"])
    if key not in keys:
        raise ValueError(f"REPLAY_PLATFORM_UNADMITTED: system={key[0]} machine={key[1]}")
    pin = copy.deepcopy(pins[keys.index(key)])
    if set(pin["witnesses"]) != WITNESSES or set(pin["witness_sha256"]) != WITNESSES:
        raise ValueError("REPLAY_PLATFORM_PINS_INVALID: witnesses")
    rows = pin["checkpoints"]
    if ([(c["cut"], c["tick"]) for c in rows] != [(1170, 0), (2341, 1), (4683, 2)]
            or any(re.fullmatch(r"[0-9a-f]{64}", c["rust"]) is None for c in rows)):
        raise ValueError("REPLAY_PLATFORM_PINS_INVALID: checkpoints")
    return {"pin": pin, "registry_sha256": hashlib.sha256(raw).hexdigest(),
            "runtime": copy.deepcopy(runtime), "key_fields": ["system", "machine"],
            "blas_role": "observed only; no fallback or automatic admission"}


if __name__ == "__main__":
    print(json.dumps(runtime_identity(), sort_keys=True))
