"""Captured-cut adapter for a separately authorized shadow replay process.

The read-only collector must not inherit this process's control/publisher login.
Only actual bridge publication and actual child provenance produce a handoff;
this module never produces a daily PASS or substitutes a compute-only publisher.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import time

LIMIT = 64 * 1024 * 1024
LOG_LIMIT = 8 * 1024 * 1024
SHA = re.compile(r"[a-f0-9]{64}")
FIELDS = {"schema", "host", "legacy_namespace", "namespace", "zid", "cut_bytes",
          "cut_sha256", "history_sha256", "expected_tick", "prior_bundle_sha256",
          "storage_agree_value", "reference"}
ENVIRONMENT = {"PATH", "PYTHONPATH", "VIRTUAL_ENV", "SYSTEMROOT", "TMPDIR",
               "DATABASE_URL", "COORDINATOR_PUBLISHER_DATABASE_URL",
               "COORDINATOR_DB_CA_BUNDLE", "COORDINATOR_DB_HOST_ALLOWLIST",
               "COORDINATOR_DB_PASSWORD_FILE", "P026_PYTHON", "MATH_ENV",
               "POLL_ALLOWLIST", "POLL_SHARD_COUNT", "POLL_SHARD_INDEX",
               "STORAGE_AGREE_VALUE", "P026_LEASE_SECONDS", "P026_COMMIT_MARGIN_SECONDS",
               "P026_RESERVATION_BYTES", "P026_ENVIRONMENT", "OPENBLAS_CORETYPE"}


def fail(code):
    raise ValueError(code)


def closed(value, keys):
    if type(value) is not dict or set(value) != set(keys):
        fail("SHADOW_BRIDGE_SCHEMA")


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def strict(raw):
    def pairs(items):
        out = {}
        for key, value in items:
            if key in out:
                fail("SHADOW_BRIDGE_DUPLICATE")
            out[key] = value
        return out
    def nonfinite(_):
        fail("SHADOW_BRIDGE_NONFINITE")
    return json.loads(raw, object_pairs_hook=pairs, parse_constant=nonfinite)


def encode(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False, allow_nan=False).encode()


def admit_request(request, expected):
    """Expected bindings come from the admitted capture custodian, not this call.

    A hash cannot prove the unchanged legacy writer consumed the named history.
    Missing that independent evidence must stop the caller before this function.
    """
    closed(request, FIELDS)
    closed(expected, FIELDS - {"schema", "cut_bytes"})
    if request["schema"] != "polis-shadow-replay-input/1":
        fail("SHADOW_BRIDGE_SCHEMA")
    if any(request[key] != expected[key] for key in expected):
        fail("SHADOW_BRIDGE_BINDING")
    for key in ("cut_sha256", "history_sha256"):
        if not isinstance(request[key], str) or not SHA.fullmatch(request[key]):
            fail("SHADOW_BRIDGE_HASH")
    if request["namespace"] in ("prod", "preprod", "dev", request["legacy_namespace"]):
        fail("SHADOW_BRIDGE_NAMESPACE")
    if type(request["zid"]) is not int or not 0 < request["zid"] <= 2**31-1:
        fail("SHADOW_BRIDGE_IDENTITY")
    if type(request["storage_agree_value"]) is not int or request["storage_agree_value"] not in (-1, 1):
        fail("SHADOW_BRIDGE_POLARITY")
    tick = request["expected_tick"]
    if tick is None:
        if request["prior_bundle_sha256"] is not None:
            fail("SHADOW_BRIDGE_PRIOR")
    elif (type(tick) is not int or not 0 <= tick <= 9007199254740990
          or not isinstance(request["prior_bundle_sha256"], str)
          or not SHA.fullmatch(request["prior_bundle_sha256"])):
        fail("SHADOW_BRIDGE_PRIOR")
    for key in ("host", "namespace", "legacy_namespace", "reference"):
        if not isinstance(request[key], str) or not 0 < len(request[key]) <= (128 if key == "reference" else 999):
            fail("SHADOW_BRIDGE_IDENTITY")
    if not isinstance(request["cut_bytes"], str):
        fail("SHADOW_BRIDGE_CUT")
    raw = request["cut_bytes"].encode()
    if not raw or len(raw) > LIMIT or digest(raw) != request["cut_sha256"]:
        fail("SHADOW_BRIDGE_CUT")
    rows = strict(raw)
    closed(rows, ("votes", "comments", "participants", "ordering"))
    # Rust independently validates row shapes, declared normalization and byte identity.
    if encode(rows) != raw:
        fail("SHADOW_BRIDGE_CUT_ENCODING")
    for key in ("votes", "comments", "participants"):
        if type(rows[key]) is not list or len(rows[key]) > 1_000_000:
            fail("SHADOW_BRIDGE_SOURCE_LIMIT")
    return encode(request)


def admit_result(raw, log, request, runtime_profile):
    """Read only an actual process result and its matching bounded runtime event.

    The private handoff still needs immutable paired Node database views; this
    validator cannot attest arbitrary caller data or produce served-byte parity.
    """
    if len(raw) > LIMIT or len(log) > LOG_LIMIT:
        fail("SHADOW_BRIDGE_OUTPUT_LIMIT")
    result = strict(raw)
    closed(result, ("schema", "host", "namespace", "zid", "cut_sha256", "history_sha256",
                   "lifecycle", "input_sha256", "bundle_sha256", "bundle_bytes",
                   "reference", "retained", "parent_pid"))
    if result["schema"] != "polis-shadow-replay-result/1" or result["lifecycle"] != "poller-rebuild-prefix/1":
        fail("SHADOW_BRIDGE_RESULT")
    for key in ("host", "namespace", "zid", "cut_sha256", "history_sha256", "reference"):
        if result[key] != request[key]:
            fail("SHADOW_BRIDGE_BINDING")
    if (result["retained"] is not True or type(result["zid"]) is not int
            or type(result["parent_pid"]) is not int or result["parent_pid"] <= 0):
        fail("SHADOW_BRIDGE_RETENTION")
    if not isinstance(result["bundle_bytes"], str) or digest(result["bundle_bytes"].encode()) != result["bundle_sha256"]:
        fail("SHADOW_BRIDGE_BUNDLE")
    bundle = strict(result["bundle_bytes"])
    closed(bundle, ("payloads", "math_tick", "caching_tick", "checkpoint", "publisher_epoch", "operation_id"))
    checkpoint = bundle["checkpoint"]
    if (type(checkpoint) is not dict or type(bundle["publisher_epoch"]) is not int
            or bundle["publisher_epoch"] <= 0 or type(bundle["caching_tick"]) is not int
            or not 1 <= bundle["caching_tick"] <= 9007199254740991
            or not isinstance(bundle["operation_id"], str) or not 0 < len(bundle["operation_id"]) <= 128
            or not isinstance(result["input_sha256"], str) or not SHA.fullmatch(result["input_sha256"])):
        fail("SHADOW_BRIDGE_GENERATION")
    expected_tick = request["expected_tick"]
    if (type(bundle["math_tick"]) is not int or bundle["math_tick"] != (0 if expected_tick is None else expected_tick+1)
            or checkpoint.get("input_sha256") != result["input_sha256"]
            or checkpoint.get("source_fingerprint") != request["cut_sha256"]
            or checkpoint.get("lifecycle") != "poller-rebuild-prefix/1"
            or checkpoint.get("operation_id") != bundle["operation_id"]
            or checkpoint.get("publisher_epoch") != bundle["publisher_epoch"]):
        fail("SHADOW_BRIDGE_GENERATION")
    payloads = bundle["payloads"]
    closed(payloads, ("originals", "main", "bidtopid", "ptptstats"))
    closed(checkpoint.get("original_digests"), ("main", "bidtopid", "ptptstats"))
    originals = payloads.get("originals", {})
    closed(originals, ("main", "bidtopid", "ptptstats"))
    for kind, octets in originals.items():
        if (type(octets) is not list or any(type(n) is not int or not 0 <= n <= 255 for n in octets)
                or not octets or digest(bytes(octets)) != checkpoint.get("original_digests", {}).get(kind)
                or strict(bytes(octets)) != payloads.get(kind)):
            fail("SHADOW_BRIDGE_ORIGINALS")
    matches = []
    for line in log.splitlines():
        if not line.strip():
            continue
        event = strict(line)
        fields = event.get("fields", {})
        if fields.get("message") == "python_worker_runtime" and fields.get("operation_id") == bundle["operation_id"]:
            matches.append(fields)
    if len(matches) != 1:
        fail("SHADOW_BRIDGE_RUNTIME_MISSING")
    fields = matches[0]
    runtime = strict(fields["numerical_runtime"]) if isinstance(fields.get("numerical_runtime"), str) else fields.get("numerical_runtime")
    closed(runtime, ("forced_kernel", "system", "machine", "worker_pid", "blas", "blas_observed"))
    closed(runtime_profile, ("forced_kernel", "system", "machine", "blas", "blas_observed"))
    if (type(runtime["worker_pid"]) is not int or runtime["worker_pid"] <= 0
            or runtime["worker_pid"] != fields.get("worker_pid") or runtime["worker_pid"] == result["parent_pid"]
            or runtime["blas_observed"] is not True or not runtime["blas"]
            or any(type(lib) is not dict or type(lib.get("num_threads")) is not int or lib["num_threads"] != 1 for lib in runtime["blas"])
            or {k: runtime[k] for k in runtime_profile} != runtime_profile):
        fail("SHADOW_BRIDGE_RUNTIME")
    result["computing_pid"] = runtime["worker_pid"]
    result["runtime"] = dict(observed=True, threads=1, kernel=runtime["forced_kernel"], libraries=runtime["blas"])
    return result


def run_replay(request, expected, runtime_profile, *, binary, binary_sha256,
               environment, private_directory, timeout=660):
    """Run exactly one admitted writer attempt; never auto-retry uncertain output.

    Receipts/logs remain on approved private scratch. The caller owns subsequent
    reconciliation and retention release; neither is a collector read privilege.
    """
    raw = admit_request(request, expected)
    closed(runtime_profile, ("forced_kernel", "system", "machine", "blas", "blas_observed"))
    if runtime_profile["blas_observed"] is not True or not runtime_profile["blas"]:
        fail("SHADOW_BRIDGE_RUNTIME")
    binary = Path(binary).resolve(strict=True)
    if not SHA.fullmatch(binary_sha256) or digest(binary.read_bytes()) != binary_sha256:
        fail("SHADOW_BRIDGE_BINARY")
    if set(environment) - ENVIRONMENT or type(timeout) not in (int, float) or not 0 < timeout <= 3600:
        fail("SHADOW_BRIDGE_ENVIRONMENT")
    root = Path(private_directory)
    if root.is_symlink() or root.exists():
        fail("SHADOW_BRIDGE_OUTPUT_EXISTS")
    root.mkdir(mode=0o700, parents=False)
    if stat.S_IMODE(root.stat().st_mode) != 0o700:
        fail("SHADOW_BRIDGE_PRIVATE_MODE")
    env = dict(environment, SHADOW_REPLAY_ENABLE="captured-input/1", P026_METRICS="off",
               SHADOW_REPLAY_HOST=request["host"], SHADOW_REPLAY_CUT_SHA256=request["cut_sha256"],
               SHADOW_REPLAY_HISTORY_SHA256=request["history_sha256"])
    # The external expected object is checked above before these bindings are forwarded.
    input_path, output_path, log_path = (root/name for name in ("input.json", "result.json", "runtime.jsonl"))
    input_path.write_bytes(raw)
    for path in (input_path, output_path, log_path):
        if not path.exists():
            path.touch(mode=0o600)
        path.chmod(0o600)
    with input_path.open("rb") as inp, output_path.open("wb") as out, log_path.open("wb") as log:
        process = subprocess.Popen([str(binary), "--execute"], stdin=inp, stdout=out, stderr=log,
                                   env=env, start_new_session=True)
        deadline = time.monotonic() + timeout
        try:
            while process.poll() is None:
                if time.monotonic() >= deadline or output_path.stat().st_size > LIMIT or log_path.stat().st_size > LOG_LIMIT:
                    fail("SHADOW_BRIDGE_UNRESOLVED")
                time.sleep(.05)
        except BaseException:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()
            raise
        if process.returncode:
            fail("SHADOW_BRIDGE_UNRESOLVED")
    if output_path.stat().st_size > LIMIT or log_path.stat().st_size > LOG_LIMIT:
        fail("SHADOW_BRIDGE_OUTPUT_LIMIT")
    return admit_result(output_path.read_bytes(), log_path.read_bytes(), request, runtime_profile)
