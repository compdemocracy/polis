"""The child side of the ``polis-jobs`` daemon protocol (P-077 P1-b).

When the jobs daemon runs a Delphi script it sets a closed set of environment
variables (``JOB_ENV_KEYS``). This module reads and checks them, builds and
writes the *output manifest* (``polis-jobs.output-manifest/1``) as the child's
last act on success, and runs the *provider-intent* file handshake that must
complete before any paid provider call.

Activation is a single rule: daemon mode is on exactly when
``DELPHI_OUTPUT_MANIFEST`` is set and non-empty (``requested()``). The legacy
DynamoDB poller never sets it, so on that path none of this module is imported
and the scripts behave as before. ``DELPHI_JOB_ID`` alone does not activate
anything: the legacy poller sets it too.

File formats (all UTF-8 JSON, keys sorted, no insignificant whitespace, one
trailing ``\\n``; every file is written to a temporary name in the same
directory, fsynced, then renamed into place, so a reader never sees a partial
file):

* the manifest, at ``$DELPHI_OUTPUT_MANIFEST``, written only when the run
  succeeded (or parked); its sha256 is computed over the exact file bytes;
* ``provider_intent.json`` in the attempt directory (the manifest's parent),
  written before the provider call;
* ``provider_intent.ack`` in the same directory, written by the daemon after its
  intent record has committed: ``{"schema":"polis-jobs.provider-intent-ack/1",
  "request_id":<string>,"intent_sha256":<hex of the intent file bytes>}``.

Exit codes a child uses in daemon mode (``EXIT_*``): 0 success with a manifest
written; 1 a stage failed; 2 the daemon environment or frame was refused before
any stage ran; 4 the math export failed (later stages still ran); 5 the stages
succeeded but the manifest could not be built or written; 6 the provider intent
was not acknowledged, so no provider call was made.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import sys
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional

MANIFEST_SCHEMA = "polis-jobs.output-manifest/1"
FRAME_SCHEMA = "polis-jobs.frame/1"
INTENT_SCHEMA = "polis-jobs.provider-intent/1"
ACK_SCHEMA = "polis-jobs.provider-intent-ack/1"

INTENT_FILE = "provider_intent.json"
ACK_FILE = "provider_intent.ack"

# The daemon inserts the manifest's bytes as one log row; the row is capped at 1 MiB.
MANIFEST_MAX_BYTES = 1 << 20

STAGE_FULL_PIPELINE = "delphi_full_pipeline"
STAGE_NARRATIVE = "delphi_narrative"
# The large memory class as a queue child (P-073 r2; polismath.poller.rebuild_child).
STAGE_MATH_REBUILD = "math_rebuild"
STAGES = (STAGE_FULL_PIPELINE, STAGE_NARRATIVE, STAGE_MATH_REBUILD)
PHASE_RUN = "run"
PHASE_SUBMIT = "submit"
PHASE_RECHECK = "recheck"

EXIT_OK = 0
EXIT_STAGE_FAILED = 1
EXIT_JOB_ENV_INVALID = 2
EXIT_MATH_EXPORT_FAILED = 4
EXIT_MANIFEST_UNBUILDABLE = 5
EXIT_PROVIDER_INTENT_REFUSED = 6

MANIFEST_ENV = "DELPHI_OUTPUT_MANIFEST"
JOB_ENV_KEYS = (
    "DELPHI_JOB_ID",
    "DELPHI_RUN_ID",
    "DELPHI_ATTEMPT_ID",
    "DELPHI_LEASE_EPOCH",
    "DELPHI_STAGE",
    MANIFEST_ENV,
    "DELPHI_FRAME",
)
PHASE_ENV = "DELPHI_PHASE"
ACK_TIMEOUT_ENV = "DELPHI_PROVIDER_ACK_TIMEOUT_SECONDS"
DEFAULT_ACK_TIMEOUT_SECONDS = 600.0

# Every DynamoDB family a Delphi child can report. The names are the family ids
# of the frozen storage codec (delphi-storage-codec/1, catalog T01-T20): the
# family id is the table name.
DYNAMODB_FAMILIES = (
    "Delphi_PCAConversationConfig",
    "Delphi_PCAResults",
    "Delphi_KMeansClusters",
    "Delphi_CommentRouting",
    "Delphi_RepresentativeComments",
    "Delphi_PCAParticipantProjections",
    "Delphi_UMAPConversationConfig",
    "Delphi_CommentEmbeddings",
    "Delphi_CommentHierarchicalClusterAssignments",
    "Delphi_CommentClustersStructureKeywords",
    "Delphi_UMAPGraph",
    "Delphi_CommentClustersFeatures",
    "Delphi_CommentClustersLLMTopicNames",
    "Delphi_NarrativeReports",
    "Delphi_JobQueue",
    "Delphi_JobActiveGuard",
    "Delphi_CommentExtremity",
    "Delphi_TopicAgendaSelections",
    "Delphi_CollectiveStatement",
    "report_narrative_store",
)

INPUT_KEYS = ("math_env", "math_tick", "math_caching_tick", "comment_set_sha256", "vote_hwm")
MODEL_KEYS = ("embed", "topic", "narrative")
MANIFEST_KEYS = (
    "schema", "job_id", "attempt_id", "stage", "phase", "outcome", "inputs",
    "outputs", "models", "cost", "recheck_after", "duration_ms",
)

_DECIMAL = re.compile(r"^(0|[1-9][0-9]*)$")
_HEX64 = re.compile(r"^[0-9a-f]{64}$")


class JobEnvError(Exception):
    """The daemon environment or the frame is unusable; nothing has run."""


class ManifestError(Exception):
    """The manifest could not be built, validated or written."""


class ProviderIntentRefused(Exception):
    """The daemon did not acknowledge the provider intent; no provider call may be made."""


def requested(environ: Optional[Dict[str, str]] = None) -> bool:
    """True when the jobs daemon is running this child (the one activation rule)."""
    environ = os.environ if environ is None else environ
    return bool(environ.get(MANIFEST_ENV, "").strip())


def effective_math_env(environ: Optional[Dict[str, str]] = None) -> str:
    """The math_env the stages read: MATH_ENV, else ConfigManager's default 'prod'."""
    environ = os.environ if environ is None else environ
    return environ.get("MATH_ENV") or "prod"


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def canonical_bytes(value: Any) -> bytes:
    """Sorted keys, no whitespace, raw UTF-8, one trailing newline."""
    text = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
    return (text + "\n").encode("utf-8")


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _fsync_dir(path: str) -> None:
    try:
        fd = os.open(path, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


def write_atomic(path: str, data: bytes) -> None:
    """Write ``data`` to ``path`` via a temporary file in the same directory and a rename."""
    directory = os.path.dirname(os.path.abspath(path))
    tmp = os.path.join(directory, f".{os.path.basename(path)}.{os.getpid()}.{uuid.uuid4().hex}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    _fsync_dir(directory)


def _is_uuid(value: str) -> bool:
    try:
        return str(uuid.UUID(value)) == value.lower()
    except (ValueError, AttributeError, TypeError):
        return False


class JobContext:
    """The daemon's identity for this attempt, checked against the frame."""

    def __init__(self, *, job_id, run_id, attempt_id, lease_epoch, stage, phase,
                 manifest_path, frame_path, frame, started_monotonic):
        self.job_id = job_id
        self.run_id = run_id
        self.attempt_id = attempt_id
        self.lease_epoch = lease_epoch
        self.stage = stage
        self.phase = phase
        self.manifest_path = manifest_path
        self.frame_path = frame_path
        self.frame = frame
        self.started_monotonic = started_monotonic
        self.inputs = empty_inputs()
        self.ack_timeout_seconds = DEFAULT_ACK_TIMEOUT_SECONDS

    @property
    def attempt_dir(self) -> str:
        return os.path.dirname(self.manifest_path)

    @property
    def report_id(self) -> Optional[str]:
        rid = self.frame.get("report_id")
        return None if rid is None else str(rid)

    @property
    def provider_batch_id(self) -> Optional[str]:
        provider = self.frame.get("provider")
        if isinstance(provider, dict) and provider.get("batch_id"):
            return str(provider["batch_id"])
        return None

    def duration_ms(self) -> int:
        return max(0, int((time.monotonic() - self.started_monotonic) * 1000))

    @classmethod
    def from_env(cls, *, expected_stage: str, zid: Any, allowed_phases, default_phase: str,
                 environ: Optional[Dict[str, str]] = None) -> "JobContext":
        started = time.monotonic()
        environ = os.environ if environ is None else environ
        missing = [k for k in JOB_ENV_KEYS if not environ.get(k, "").strip()]
        if missing:
            raise JobEnvError(f"daemon environment incomplete; missing {', '.join(missing)}")
        job_id = environ["DELPHI_JOB_ID"]
        attempt_id = environ["DELPHI_ATTEMPT_ID"]
        run_id = environ["DELPHI_RUN_ID"]
        lease_epoch = environ["DELPHI_LEASE_EPOCH"]
        stage = environ["DELPHI_STAGE"]
        manifest_path = environ[MANIFEST_ENV]
        frame_path = environ["DELPHI_FRAME"]
        if not _is_uuid(job_id):
            raise JobEnvError("DELPHI_JOB_ID is not a uuid")
        if not _is_uuid(attempt_id):
            raise JobEnvError("DELPHI_ATTEMPT_ID is not a uuid")
        if not _is_uuid(run_id):
            raise JobEnvError("DELPHI_RUN_ID is not a uuid")
        ack_timeout = parse_ack_timeout(environ.get(ACK_TIMEOUT_ENV))
        if not _DECIMAL.match(lease_epoch):
            raise JobEnvError("DELPHI_LEASE_EPOCH is not a decimal integer")
        if stage != expected_stage:
            raise JobEnvError(f"DELPHI_STAGE is {stage!r}; this script runs {expected_stage!r}")
        if not os.path.isabs(manifest_path):
            raise JobEnvError("DELPHI_OUTPUT_MANIFEST must be an absolute path")
        if not os.path.isdir(os.path.dirname(manifest_path)):
            raise JobEnvError("the directory of DELPHI_OUTPUT_MANIFEST does not exist")
        if os.path.lexists(manifest_path):
            raise JobEnvError("DELPHI_OUTPUT_MANIFEST already exists; an attempt directory is never reused")

        try:
            with open(frame_path, "rb") as f:
                frame = json.loads(f.read().decode("utf-8"))
        except (OSError, ValueError) as e:
            raise JobEnvError(f"DELPHI_FRAME is unreadable: {e}") from e
        if not isinstance(frame, dict) or frame.get("schema") != FRAME_SCHEMA:
            raise JobEnvError(f"DELPHI_FRAME is not a {FRAME_SCHEMA} document")
        for key, value in (("job_id", job_id), ("attempt_id", attempt_id), ("run_id", run_id), ("stage", stage)):
            if str(frame.get(key)) != value:
                raise JobEnvError(f"frame {key} does not match {('DELPHI_' + key.upper())}")
        if not isinstance(frame.get("lease_epoch"), str) or frame["lease_epoch"] != lease_epoch:
            raise JobEnvError("frame lease_epoch must be a decimal string equal to DELPHI_LEASE_EPOCH")
        if zid is not None and str(frame.get("zid")) != str(zid):
            raise JobEnvError(f"frame zid {frame.get('zid')!r} does not match the command line {zid!r}")

        env_rid = environ.get("DELPHI_REPORT_ID") or None
        if env_rid and frame.get("report_id") is not None and str(frame["report_id"]) != env_rid:
            raise JobEnvError("frame report_id does not match DELPHI_REPORT_ID")

        env_phase = environ.get(PHASE_ENV) or None
        frame_phase = frame.get("phase") or None
        if env_phase and frame_phase and env_phase != frame_phase:
            raise JobEnvError("DELPHI_PHASE does not match the frame phase")
        phase = env_phase or frame_phase or default_phase
        if phase not in allowed_phases:
            raise JobEnvError(f"phase {phase!r} is not one of {sorted(allowed_phases)}")

        inputs = frame.get("inputs")
        if isinstance(inputs, dict) and inputs.get("math_env") is not None:
            if str(inputs["math_env"]) != effective_math_env(environ):
                raise JobEnvError(
                    f"frame math_env {inputs['math_env']!r} differs from the stages' MATH_ENV "
                    f"{effective_math_env(environ)!r}"
                )

        ctx = cls(job_id=job_id, run_id=run_id, attempt_id=attempt_id, lease_epoch=lease_epoch,
                  stage=stage, phase=phase, manifest_path=manifest_path, frame_path=frame_path,
                  frame=frame, started_monotonic=started)
        ctx.ack_timeout_seconds = ack_timeout
        return ctx


def parse_ack_timeout(raw: Optional[str]) -> float:
    """DELPHI_PROVIDER_ACK_TIMEOUT_SECONDS: a finite, positive number of seconds, else refused."""
    if raw is None or not raw.strip():
        return DEFAULT_ACK_TIMEOUT_SECONDS
    try:
        value = float(raw)
    except ValueError:
        raise JobEnvError(f"{ACK_TIMEOUT_ENV} is not a number") from None
    if not math.isfinite(value) or value <= 0:
        raise JobEnvError(f"{ACK_TIMEOUT_ENV} must be a finite number of seconds above zero")
    return value


def refuse(message: str) -> None:
    """Report a refused daemon environment on stderr and exit 2 before any stage runs."""
    print(f"polis-jobs child: refused: {message}", file=sys.stderr, flush=True)
    sys.exit(EXIT_JOB_ENV_INVALID)


# --- the manifest -----------------------------------------------------------

def empty_inputs() -> Dict[str, Any]:
    return {k: None for k in INPUT_KEYS}


def build_manifest(ctx: JobContext, *, outcome: str, inputs: Dict[str, Any],
                   outputs: List[Dict[str, Any]], models: Dict[str, Any],
                   cost: Dict[str, Any], recheck_after: Optional[str] = None) -> Dict[str, Any]:
    manifest = {
        "schema": MANIFEST_SCHEMA,
        "job_id": ctx.job_id,
        "attempt_id": ctx.attempt_id,
        "stage": ctx.stage,
        "phase": ctx.phase,
        "outcome": outcome,
        "inputs": dict(inputs),
        "outputs": list(outputs),
        "models": dict(models),
        "cost": dict(cost),
        "recheck_after": recheck_after,
        "duration_ms": ctx.duration_ms(),
    }
    validate_manifest(manifest)
    return manifest


def _nullable(value, kind, what):
    if value is None:
        return
    if kind is int:
        if not isinstance(value, int) or isinstance(value, bool):
            raise ManifestError(f"{what} must be an integer or null")
    elif not isinstance(value, kind):
        raise ManifestError(f"{what} must be {kind.__name__} or null")


def validate_manifest(m: Any) -> None:
    """The output-manifest/1 shape: closed key sets, typed values."""
    writer = isinstance(m, dict) and m.get("schema") == "polis-jobs.output-manifest/2"
    expected_keys = set(MANIFEST_KEYS) | ({"family_spool"} if "family_spool" in m else {"results"}) if writer else set(MANIFEST_KEYS)
    if not isinstance(m, dict) or set(m) != expected_keys:
        raise ManifestError(f"manifest keys must be exactly {sorted(MANIFEST_KEYS)}")
    if m["schema"] != MANIFEST_SCHEMA and not writer:
        raise ManifestError("wrong manifest schema")
    for key in ("job_id", "attempt_id"):
        if not _is_uuid(m[key]):
            raise ManifestError(f"{key} must be a uuid")
    if m["stage"] not in STAGES:
        raise ManifestError("unknown stage")
    _nullable(m["phase"], str, "phase")
    if m["outcome"] not in ("succeeded", "parked"):
        raise ManifestError("outcome must be 'succeeded' or 'parked'")

    inputs = m["inputs"]
    if not isinstance(inputs, dict) or set(inputs) != set(INPUT_KEYS):
        raise ManifestError(f"inputs keys must be exactly {sorted(INPUT_KEYS)}")
    _nullable(inputs["math_env"], str, "inputs.math_env")
    for key in ("math_tick", "math_caching_tick", "vote_hwm"):
        _nullable(inputs[key], int, f"inputs.{key}")
    if inputs["comment_set_sha256"] is not None and not _HEX64.match(str(inputs["comment_set_sha256"])):
        raise ManifestError("inputs.comment_set_sha256 must be 64 lowercase hex characters or null")

    outputs = m["outputs"]
    if not isinstance(outputs, list):
        raise ManifestError("outputs must be a list")
    for i, out in enumerate(outputs):
        where = f"outputs[{i}]"
        if not isinstance(out, dict):
            raise ManifestError(f"{where} must be an object")
        has_prefix, has_keys = "key_prefix" in out, "keys" in out
        if has_prefix == has_keys:
            raise ManifestError(f"{where} needs exactly one of key_prefix or keys")
        expected = {"store", "family", "table", "rows", "key_prefix" if has_prefix else "keys"}
        if set(out) != expected:
            raise ManifestError(f"{where} keys must be exactly {sorted(expected)}")
        if out["store"] != ("postgres" if writer else "dynamodb"):
            raise ManifestError(f"{where}.store must be 'dynamodb' in output-manifest/1")
        if out["family"] not in DYNAMODB_FAMILIES:
            raise ManifestError(f"{where}.family {out['family']!r} is not a codec family")
        if not isinstance(out["table"], str) or not out["table"]:
            raise ManifestError(f"{where}.table must be a non-empty string")
        if not isinstance(out["rows"], int) or isinstance(out["rows"], bool) or out["rows"] < 0:
            raise ManifestError(f"{where}.rows must be a non-negative integer")
        partitions = [out["key_prefix"]] if has_prefix else out["keys"]
        if not isinstance(partitions, list):
            raise ManifestError(f"{where}.keys must be a list")
        for p in partitions:
            if not isinstance(p, dict) or not p or not all(
                isinstance(k, str) and isinstance(v, str) for k, v in p.items()
            ):
                raise ManifestError(f"{where}: a key is a non-empty object of attribute -> string value")

    models = m["models"]
    if not isinstance(models, dict) or set(models) != set(MODEL_KEYS):
        raise ManifestError(f"models keys must be exactly {sorted(MODEL_KEYS)}")
    for key in MODEL_KEYS:
        _nullable(models[key], str, f"models.{key}")

    cost = m["cost"]
    if not isinstance(cost, dict) or set(cost) != {"llm_tokens_in", "llm_tokens_out", "provider_batches"}:
        raise ManifestError("cost keys must be exactly llm_tokens_in, llm_tokens_out, provider_batches")
    _nullable(cost["llm_tokens_in"], int, "cost.llm_tokens_in")
    _nullable(cost["llm_tokens_out"], int, "cost.llm_tokens_out")
    batches = cost["provider_batches"]
    if batches is not None:
        if not isinstance(batches, list):
            raise ManifestError("cost.provider_batches must be a list or null")
        for b in batches:
            if not isinstance(b, dict) or set(b) != {"provider", "batch_id", "submitted_at"} or not all(
                isinstance(b[k], str) and b[k] for k in b
            ):
                raise ManifestError("a provider batch is {provider, batch_id, submitted_at}, all non-empty strings")

    _nullable(m["recheck_after"], str, "recheck_after")
    if (m["outcome"] == "parked") != (m["recheck_after"] is not None):
        raise ManifestError("recheck_after is set exactly when the outcome is 'parked'")
    if not isinstance(m["duration_ms"], int) or isinstance(m["duration_ms"], bool) or m["duration_ms"] < 0:
        raise ManifestError("duration_ms must be a non-negative integer")


def encode_manifest(manifest: Dict[str, Any]) -> bytes:
    validate_manifest(manifest)
    data = canonical_bytes(manifest)
    if len(data) > MANIFEST_MAX_BYTES:
        raise ManifestError(f"manifest is {len(data)} bytes; the limit is {MANIFEST_MAX_BYTES}")
    return data


def write_manifest(ctx: JobContext, manifest: Dict[str, Any]) -> str:
    """Write the manifest atomically at DELPHI_OUTPUT_MANIFEST; return the sha256 of its bytes."""
    if os.environ.get("DELPHI_RESULT_BACKEND") == "postgres":
        from polismath.delphi_storage.writer import WriterResource
        resource = WriterResource()
        manifest = dict(manifest, schema="polis-jobs.output-manifest/2",
                        outputs=[dict(o, store="postgres") for o in manifest["outputs"]],
                        family_spool=resource.spool() if manifest["outcome"] == "succeeded" else {})
    data = encode_manifest(manifest)
    if os.path.lexists(ctx.manifest_path):
        raise ManifestError("the manifest already exists")
    write_atomic(ctx.manifest_path, data)
    digest = sha256_hex(data)
    print(f"polis-jobs child: manifest written outcome={manifest['outcome']} bytes={len(data)} sha256={digest}",
          file=sys.stderr, flush=True)
    return digest


# --- the provider-intent handshake ------------------------------------------

def request_provider_intent(ctx: JobContext, *, provider: str, model: str, batch: Dict[str, Any],
                            timeout_seconds: Optional[float] = None, poll_seconds: float = 0.2,
                            sleep: Callable[[float], None] = time.sleep,
                            clock: Callable[[], float] = time.monotonic) -> Dict[str, Any]:
    """Write provider_intent.json and wait for the daemon's provider_intent.ack.

    Returns the parsed acknowledgement. Raises ProviderIntentRefused (and the
    caller must not call the provider) when an intent file already exists, the
    acknowledgement does not arrive in time, or it does not name this intent.
    """
    intent_path = os.path.join(ctx.attempt_dir, INTENT_FILE)
    ack_path = os.path.join(ctx.attempt_dir, ACK_FILE)
    if os.path.lexists(intent_path) or os.path.lexists(ack_path):
        raise ProviderIntentRefused("a provider intent already exists in this attempt directory")
    intent = {
        "schema": INTENT_SCHEMA,
        "job_id": ctx.job_id,
        "run_id": ctx.run_id,
        "attempt_id": ctx.attempt_id,
        "lease_epoch": ctx.lease_epoch,
        "stage": ctx.stage,
        "phase": ctx.phase,
        "provider": provider,
        "model": model,
        "batch": batch,
    }
    data = canonical_bytes(intent)
    digest = sha256_hex(data)
    write_atomic(intent_path, data)
    print(f"polis-jobs child: provider intent written sha256={digest}; waiting for the acknowledgement",
          file=sys.stderr, flush=True)

    if timeout_seconds is None:
        timeout_seconds = ctx.ack_timeout_seconds
    deadline = clock() + timeout_seconds
    while True:
        if os.path.exists(ack_path):
            try:
                with open(ack_path, "rb") as f:
                    ack = json.loads(f.read().decode("utf-8"))
            except (OSError, ValueError) as e:
                raise ProviderIntentRefused(f"the acknowledgement is unreadable: {e}") from e
            if not isinstance(ack, dict) or ack.get("schema") != ACK_SCHEMA:
                raise ProviderIntentRefused(f"the acknowledgement is not a {ACK_SCHEMA} document")
            if ack.get("intent_sha256") != digest:
                raise ProviderIntentRefused("the acknowledgement names a different intent")
            if not isinstance(ack.get("request_id"), str) or not ack["request_id"]:
                raise ProviderIntentRefused("the acknowledgement has no request_id")
            print(f"polis-jobs child: provider intent acknowledged request_id={ack['request_id']}",
                  file=sys.stderr, flush=True)
            return ack
        if clock() >= deadline:
            raise ProviderIntentRefused(f"no acknowledgement within {timeout_seconds:g} s")
        sleep(poll_seconds)


def requests_sha256(requests: Any) -> str:
    """A digest of the exact request list about to be sent, for the intent record."""
    return sha256_hex(canonical_bytes(requests))
