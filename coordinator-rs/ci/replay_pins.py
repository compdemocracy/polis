"""Explicit historical replay admission; never learn a pin from fresh output."""
import copy
import hashlib
import json
from pathlib import Path
import platform
import os
import re

WITNESSES = {"polarity-public-fixture.json", "polarity-vw.json", "polarity-biodiversity.json",
             "polarity-rebuild-schedule.json", "semantic-tie-key.json",
             "d4-node-reader.json", "d4-node-reader-empty.json"}
REQUIRED_WORKERS = {
    'tests/coordinator/test_equivalence.py::test_vw_dual_namespace_live_equivalence': 3,
    'tests/coordinator/test_node_reader.py::test_real_node_reader_serves_identical_bytes_for_both_writers': 4,
}
KERNEL_CONTROL = 'tests/coordinator/test_hosted_controls.py::test_actual_bridge_child_preserves_requested_kernel'


def child_runtimes(directory, campaign_runtime):
    """Require fresh computing-worker observations, including both regressions."""
    counts = dict.fromkeys(REQUIRED_WORKERS, 0)
    files = sorted(Path(directory).glob('*.json'))
    if not files:
        raise ValueError('REPLAY_CHILD_KERNEL_MISSING')
    identities, kernels = set(), set()
    for path in files:
        if path.is_symlink():
            raise ValueError('REPLAY_CHILD_KERNEL_INVALID: symlink')
        record = json.loads(path.read_text())
        case = record.get('test_case')
        requested = campaign_runtime['forced_kernel']
        if case == KERNEL_CONTROL + '[None]':
            requested = 'not-forced'  # explicit absence control, never pin evidence
        elif case == KERNEL_CONTROL + '[Haswell]':
            requested = 'Haswell'
        if (record.get('schema') != 'polis-worker-runtime-observation/1'
                or record.get('requested_kernel') != requested
                or type(record.get('parent_pid')) is not int
                or not record.get('observations')):
            raise ValueError('REPLAY_CHILD_KERNEL_INVALID: observation')
        for observation in record['observations']:
            runtime = observation['runtime']
            pid = observation['worker_pid']
            identity = (record['parent_pid'], pid)
            if (type(pid) is not int or pid <= 0 or pid == record['parent_pid']
                    or runtime.get('worker_pid') != pid or identity in identities
                    or runtime.get('forced_kernel') != requested
                    or any(runtime.get(key) != campaign_runtime[key] for key in ('system', 'machine'))
                    or not runtime.get('blas_observed') or not runtime.get('blas')
                    or any(row.get('num_threads') != 1 or row.get('internal_api') != 'openblas'
                           for row in runtime['blas'])):
                raise ValueError('REPLAY_CHILD_KERNEL_MISMATCH')
            identities.add(identity)
            if (runtime['system'], runtime['machine']) == ('Linux', 'x86_64') and requested != 'not-forced':
                validate_kernel(runtime)
            kernels.add((runtime['forced_kernel'], tuple(row.get('architecture') for row in runtime['blas'])))
            if case in counts:
                counts[case] += 1
    if counts != REQUIRED_WORKERS:
        raise ValueError('REPLAY_CHILD_KERNEL_MISSING: required computing workers')
    return {'files': len(files), 'workers': len(identities), 'required_cases': counts,
            'kernels': [{'requested': k[0], 'observed': list(k[1])} for k in sorted(kernels)],
            'sha256': {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in files}}


def kernel_environment(environment, system, machine):
    """Select before numerical imports in every campaign child. No CPU fallback."""
    result = dict(environment)
    result.pop('OPENBLAS_CORETYPE', None)
    if (system, machine) == ('Linux', 'x86_64'):
        result['OPENBLAS_CORETYPE'] = 'Haswell'
    return result


def validate_kernel(runtime):
    requested = runtime.get('forced_kernel')
    if type(requested) is not str or not requested:
        raise ValueError('REPLAY_KERNEL_NOT_HONOURED: missing requested kernel')
    if requested == 'not-forced':
        # Retired unforced Linux evidence is never a selectable runtime.
        if (runtime['system'], runtime['machine']) == ('Linux', 'x86_64'):
            raise ValueError('REPLAY_KERNEL_NOT_HONOURED: Linux requires Haswell')
        return
    rows = runtime.get('blas', [])
    if (requested != 'Haswell' or (runtime['system'],runtime['machine']) != ('Linux','x86_64')
            or {row.get('prefix') for row in rows} != {'libopenblas','libscipy_openblas'}
            or len(rows) != 2 or any(row.get('internal_api') != 'openblas'
                or row.get('architecture','').lower() != requested.lower()
                or row.get('num_threads') != 1 for row in rows)):
        raise ValueError('REPLAY_KERNEL_NOT_HONOURED: observed BLAS kernel mismatch')


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
    cpu_model = None
    if platform.system() == 'Linux':
        for line in Path('/proc/cpuinfo').read_text().splitlines():
            key, _, value = line.partition(':')
            if key.strip() == 'model name':
                cpu_model = value.strip()
                break
    return {"forced_kernel": os.environ.get("OPENBLAS_CORETYPE") or "not-forced",
            "system": platform.system(), "machine": platform.machine(),
            "platform": platform.platform(), "python": platform.python_version(),
            "cpu_model": cpu_model, "blas": libraries, "blas_observed": bool(libraries)}


def select_pin(runtime, path):
    raw = Path(path).read_bytes()
    registry = json.loads(raw)
    if registry.get("schema") != "polis-replay-platform-pins/2":
        raise ValueError("REPLAY_PLATFORM_PINS_INVALID: schema")
    pins = registry["pins"]
    keys = [(p["system"], p["machine"], p["forced_kernel"]) for p in pins]
    ids = [p["id"] for p in pins]
    if not pins or len(keys) != len(set(keys)) or len(ids) != len(set(ids)):
        raise ValueError("REPLAY_PLATFORM_PINS_INVALID: duplicate or empty registry")
    validate_kernel(runtime)
    key = (runtime["system"], runtime["machine"], runtime["forced_kernel"])
    if key not in keys:
        raise ValueError(f"REPLAY_PLATFORM_UNADMITTED: system={key[0]} machine={key[1]} forced_kernel={key[2]}")
    pin = copy.deepcopy(pins[keys.index(key)])
    if set(pin["witnesses"]) != WITNESSES or set(pin["witness_sha256"]) != WITNESSES:
        raise ValueError("REPLAY_PLATFORM_PINS_INVALID: witnesses")
    rows = pin["checkpoints"]
    if ([(c["cut"], c["tick"]) for c in rows] != [(1170, 0), (2341, 1), (4683, 2)]
            or any(re.fullmatch(r"[0-9a-f]{64}", c["rust"]) is None for c in rows)):
        raise ValueError("REPLAY_PLATFORM_PINS_INVALID: checkpoints")
    return {"pin": pin, "registry_sha256": hashlib.sha256(raw).hexdigest(),
            "runtime": copy.deepcopy(runtime), "key_fields": ["system", "machine", "forced_kernel"],
            "blas_role": "requested kernel must match both observed Linux OpenBLAS kernels; no automatic admission"}


if __name__ == "__main__":
    print(json.dumps(runtime_identity(), sort_keys=True))
