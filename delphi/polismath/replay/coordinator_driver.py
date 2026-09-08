"""P-045 bridge: a third certify PRODUCER (``rust``) beside ``clj`` and ``py``.

``rust`` means the Rust coordinator + the pinned Python science worker + actual
Postgres publication (P-044/P-045). It does NOT mean Rust math, and it is never
the debug ``publish-fixture`` lane (that is ``store-fixture``). Each public
battery entry keeps explicit clj/py/rust producer rows and pairwise results;
creating a row is not evidence that it passes.

This module is HARNESS-ONLY. It is listed in :data:`certify._ENGINE_TREE_EXCLUDE`
(slice 1), exactly like the four sibling harness files already there, so editing
it never re-keys the Python engine recording cache and never changes
``run_provenance.engine_tree_sha256`` for a legacy two-driver command. That is
the mechanism the engine hash was built for (see ``engine_tree_hash``'s
docstring), not a weakening of it: a Rust coordinator driver is not the Python
engine surface.

DELIBERATELY ABSENT here (slice 3, BLOCKED on Colin's lifecycle decision and on
the closed ``p045-replay-plan/1`` schema + ordered-ingress DDL that P-045 §rev2
records as undefined):

* the ``once --replay-plan FILE --checkpoint INT --evidence-dir DIR`` forced
  compute path and the ``replay`` warm session (P026_INCREMENTAL=0 does NOT force
  a compute — ``process_owned`` still skips an unchanged fingerprint);
* the real Rust binary launch, real Postgres publication and the 20 fresh
  reference repetitions.

Until those land, :func:`RUST.record` returns an honest UNSUPPORTED_PROFILE /
INCONCLUSIVE receipt for every entry rather than a fabricated pass, and the Rust
producer is NEVER implemented by calling ``ensure_py_recording`` and relabelling.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Callable, Optional, TypedDict

from polismath.replay import certify as cert

# ---------------------------------------------------------------------------
# Closed schema / identifier constants.
# ---------------------------------------------------------------------------
#: The SINGLE policy name used by BOTH P-044 and P-045. The previous ``p044``
#: spelling is NOT a second accepted wire format.
POLICY_SCHEMA = "p045-policy/1"
DRIVER_CAPABILITIES_SCHEMA = "p045-driver-capabilities/1"
STAGE_BINDING_SCHEMA = "p045-stage-binding/1"
STAGE_CONTEXT_SCHEMA = "p045-stage-context/1"
#: New report schema for the three-producer run; ``/1`` is preserved untouched
#: for legacy two-driver invocations (see certify.run_battery).
CERTIFICATION_RUN_SCHEMA_V2 = "polis-certification-run/2"
#: Bridge recording-cache identity version. Bumping it invalidates only bridge
#: recordings, never the legacy clj/py recording caches.
BRIDGE_CACHE_SCHEMA = "p045-bridge-cache/1"

#: Producer IDs are EXACTLY these three. Unknown/repeated/empty values fail
#: configuration; Rust certification requires both references (clj AND py).
DRIVER_IDS: tuple[str, ...] = ("clj", "py", "rust")
LEGACY_DRIVER_IDS: tuple[str, ...] = ("clj", "py")

#: Campaign profiles. ``battery-chain/1`` needs the warm-worker lifecycle that
#: S1 does not advertise (slice 3); ``snapshot-rebuild/1`` is the rebuild-each-cut
#: profile S1 actually implements. Neither is a production default.
PROFILE_BATTERY_CHAIN = "battery-chain/1"
PROFILE_SNAPSHOT_REBUILD = "snapshot-rebuild/1"
PROFILES: tuple[str, ...] = (PROFILE_BATTERY_CHAIN, PROFILE_SNAPSHOT_REBUILD)

#: S1's closed admission fields (engine_adapter.CANDIDATE_SCHEMA / ENGINE_VERSION).
#: A changed worker/profile must NEGOTIATE a new version, not claim these bytes
#: implement a capability S1 never advertised.
S1_CANDIDATE_SCHEMA = "polis-candidate-input/1"
S1_ENGINE_VERSION = "python-conversation/p026-s1"
S1_ADMISSION_FIELDS: tuple[str, ...] = (
    "candidate_schema", "engine_version", "input_digest", "schedule_digest",
    "operation_id",
)


class ProducerStatus(str, Enum):
    """Row-level status. Creating a row is never a pass; a missing capability is
    UNSUPPORTED_PROFILE and an absent-but-buildable result is INCONCLUSIVE."""

    PASS = "PASS"
    FAIL = "FAIL"
    INCONCLUSIVE = "INCONCLUSIVE"
    UNSUPPORTED_PROFILE = "UNSUPPORTED_PROFILE"


class BridgeError(RuntimeError):
    """A bridge configuration/contract failure. Carries a stable ``stage``."""

    def __init__(self, stage: str, message: str) -> None:
        super().__init__(message)
        self.stage = stage


# ---------------------------------------------------------------------------
# Driver registry.
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class DriverReceipt:
    """What one producer's ``record`` actually produced for one entry."""

    driver: str
    loader: str
    profile: str
    status: ProducerStatus
    reason: str
    required_cuts: int
    observed_cuts: int
    out_dir: Optional[str] = None
    evidence_sha256: Optional[str] = None
    cache_provenance: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "driver": self.driver, "loader": self.loader, "profile": self.profile,
            "status": self.status.value, "reason": self.reason,
            "required_cuts": self.required_cuts, "observed_cuts": self.observed_cuts,
            "out_dir": self.out_dir, "evidence_sha256": self.evidence_sha256,
            "cache_provenance": self.cache_provenance,
        }


# record(plan, entry, out_dir) -> DriverReceipt. Plan/entry are kept ``Any`` so
# the registry does not depend on the (slice-3, undefined) p045-replay-plan/1
# object shape; the concrete Rust launcher binds them once that schema lands.
RecordFn = Callable[[Any, Any, Path], DriverReceipt]


@dataclass(frozen=True)
class DriverSpec:
    """id, loader, executable/implementation digest, advertised capabilities and
    the record function. ``loader`` is the recording SHAPE on disk; it is a
    distinct axis from producer identity so a producer is never certified by
    borrowing another's loader (the brief's "do not relabel Rust as py")."""

    id: str
    loader: str
    implementation_digest: str
    capabilities: tuple[str, ...]
    record: RecordFn

    def supports(self, profile: str) -> bool:
        return profile in self.capabilities


def _plan_profile(plan: Any) -> str:
    """The selected profile, whether ``plan`` is the (dict) bridge plan or an
    object with a ``.profile`` attribute. The runner passes a dict, so reading it
    only as an attribute would leave every receipt profile empty beneath a row
    that says snapshot-rebuild/1."""
    if isinstance(plan, dict):
        return plan.get("profile") or ""
    return getattr(plan, "profile", "") or ""


def _legacy_receipt(driver: str, loader: str, profile: str, entry: Any) -> DriverReceipt:
    """clj/py are the pinned references. Their real recording still runs through
    :func:`certify.ensure_clj_recording`/:func:`certify.ensure_py_recording`
    (unchanged, byte-for-byte); the registry only NAMES them as producers so the
    three-producer inventory and pairing can address them uniformly. Without a
    resolved plan (slice 3) this returns an INCONCLUSIVE placeholder rather than
    launching an engine."""
    required = _required_cuts(entry)
    return DriverReceipt(
        driver=driver, loader=loader, profile=profile,
        status=ProducerStatus.INCONCLUSIVE,
        reason="reference recording not yet run in this bridge invocation",
        required_cuts=required, observed_cuts=0,
    )


def _rust_record(plan: Any, entry: Any, out_dir: Path) -> DriverReceipt:
    """The Rust producer. It NEVER borrows ``ensure_py_recording``.

    Without the closed ``p045-replay-plan/1`` schema and the plan-gated
    ``once --replay-plan`` forced-compute path (slice 3, BLOCKED), there is no way
    to require a real publication per scheduled cut, so every entry records
    UNSUPPORTED_PROFILE with the reason named. This is the honest non-passing row
    the brief mandates, not a fabricated pass."""
    required = _required_cuts(entry)
    profile = _plan_profile(plan)
    reason = (
        "rust producer requires the slice-3 p045-replay-plan/1 schema and the "
        "plan-gated once --replay-plan forced-compute path, both BLOCKED on "
        "Colin's lifecycle decision; P026_INCREMENTAL=0 alone does not force a "
        "compute"
    )
    return DriverReceipt(
        driver="rust", loader="rust", profile=profile,
        status=ProducerStatus.UNSUPPORTED_PROFILE, reason=reason,
        required_cuts=required, observed_cuts=0, out_dir=str(out_dir),
    )


def _required_cuts(entry: Any) -> int:
    for attr in ("checkpoints",):
        val = getattr(entry, attr, None)
        if val is not None:
            try:
                return len(val)
            except TypeError:
                pass
    if isinstance(entry, dict) and isinstance(entry.get("checkpoints"), list):
        return len(entry["checkpoints"])
    return 0


CLJ = DriverSpec(
    id="clj", loader="clj", implementation_digest="",
    capabilities=(PROFILE_BATTERY_CHAIN, PROFILE_SNAPSHOT_REBUILD),
    record=lambda plan, entry, out_dir: _legacy_receipt("clj", "clj", _plan_profile(plan), entry),
)
PY = DriverSpec(
    id="py", loader="py", implementation_digest="",
    capabilities=(PROFILE_BATTERY_CHAIN, PROFILE_SNAPSHOT_REBUILD),
    record=lambda plan, entry, out_dir: _legacy_receipt("py", "py", _plan_profile(plan), entry),
)
#: Rust advertises NO campaign profile today: its capabilities are empty until a
#: reviewed build + capabilities --json reply pins them (slice 2/3). An empty
#: capability set yields UNSUPPORTED_PROFILE, never a speculative engine run.
RUST = DriverSpec(
    id="rust", loader="rust", implementation_digest="",
    capabilities=(), record=_rust_record,
)

REGISTRY: dict[str, DriverSpec] = {"clj": CLJ, "py": PY, "rust": RUST}


def parse_drivers(value: str) -> tuple[str, ...]:
    """``--drivers clj,py,rust`` -> validated, order-preserving, unique tuple.
    Unknown/repeated/empty tokens fail configuration; rust requires both refs."""
    tokens = [t for t in value.split(",")]
    if any(t == "" for t in tokens) or not tokens:
        raise BridgeError("drivers", f"empty driver id in {value!r}")
    seen: set[str] = set()
    out: list[str] = []
    for t in tokens:
        if t not in REGISTRY:
            raise BridgeError("drivers", f"unknown driver id {t!r} (allowed: {DRIVER_IDS})")
        if t in seen:
            raise BridgeError("drivers", f"repeated driver id {t!r}")
        seen.add(t)
        out.append(t)
    if "rust" in seen and not {"clj", "py"} <= seen:
        raise BridgeError("drivers", "rust certification requires both clj and py references")
    return tuple(out)


# ---------------------------------------------------------------------------
# Reviewed policy (p045-policy/1).
# ---------------------------------------------------------------------------
_HEX = frozenset("0123456789abcdef")


def _is_hex64(value: Any) -> bool:
    return isinstance(value, str) and len(value) == 64 and set(value) <= _HEX


#: The complete closed key set of a p045-policy/1 object. Unknown keys are
#: rejected — a "closed" schema that silently ignores extra fields is not closed.
_POLICY_KEYS: frozenset[str] = frozenset({
    "schema", "profile", "field_policy_sha256", "approvals",
    "replacement_assertions", "required_controls", "clock",
})


@dataclass(frozen=True)
class Policy:
    schema: str
    profile: str
    field_policy_sha256: str
    approvals: tuple[str, ...]
    replacement_assertions: tuple[str, ...]
    required_controls: tuple[str, ...]
    clock: dict[str, Any]
    raw_sha256: str
    #: The p045-policy/1 BODY is still undefined (slice 3, BLOCKED). This loader
    #: validates shape only; it NEVER certifies a run. ``admitting`` stays False
    #: until the reviewed policy schema exists, so nothing can mistake a
    #: shape-valid file for slice-3 admission.
    admitting: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema": self.schema, "profile": self.profile,
            "field_policy_sha256": self.field_policy_sha256,
            "approvals": list(self.approvals),
            "replacement_assertions": list(self.replacement_assertions),
            "required_controls": list(self.required_controls),
            "clock": self.clock, "raw_sha256": self.raw_sha256,
            "admitting": self.admitting,
        }


def load_policy(path: str | Path) -> Policy:
    """Load and shape-validate a ``p045-policy/1`` file as NON-ADMITTING
    scaffolding (the policy body is still undefined — slice 3, BLOCKED). It is
    NEVER derived from observed errors; a wrong schema/profile, a missing or
    mistyped field, a non-hex digest OR an unknown key is a hard configuration
    failure. The returned Policy has ``admitting == False``: shape-valid is not
    slice-3 admission."""
    p = Path(path)
    raw = p.read_bytes()
    try:
        obj = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise BridgeError("policy", f"policy is not valid JSON: {exc}") from exc
    if not isinstance(obj, dict):
        raise BridgeError("policy", "policy must be a JSON object")
    unknown = set(obj) - _POLICY_KEYS
    if unknown:
        raise BridgeError("policy", f"policy has unknown key(s): {sorted(unknown)}")
    if obj.get("schema") != POLICY_SCHEMA:
        raise BridgeError("policy", f"policy schema must be {POLICY_SCHEMA!r}, got {obj.get('schema')!r}")
    profile = obj.get("profile")
    if profile not in PROFILES:
        raise BridgeError("policy", f"policy profile must be one of {PROFILES}, got {profile!r}")
    required = ("field_policy_sha256", "approvals", "replacement_assertions",
                "required_controls", "clock")
    missing = [k for k in required if k not in obj]
    if missing:
        raise BridgeError("policy", f"policy missing required field(s): {missing}")
    for list_field in ("approvals", "replacement_assertions", "required_controls"):
        if not isinstance(obj[list_field], list) or not all(isinstance(x, str) for x in obj[list_field]):
            raise BridgeError("policy", f"policy.{list_field} must be a list of strings")
    if not isinstance(obj["clock"], dict):
        raise BridgeError("policy", "policy.clock must be an object")
    if not _is_hex64(obj["field_policy_sha256"]):
        raise BridgeError("policy", "policy.field_policy_sha256 must be a 64-char lowercase hex sha256")
    return Policy(
        schema=POLICY_SCHEMA, profile=profile,
        field_policy_sha256=obj["field_policy_sha256"],
        approvals=tuple(obj["approvals"]),
        replacement_assertions=tuple(obj["replacement_assertions"]),
        required_controls=tuple(obj["required_controls"]),
        clock=obj["clock"],
        raw_sha256=hashlib.sha256(raw).hexdigest(),
        admitting=False,
    )


# ---------------------------------------------------------------------------
# Bridge recording-cache key.
# ---------------------------------------------------------------------------
class BridgeCacheInputs(TypedDict, total=False):
    driver_id: str
    loader_id: str
    binary_tree_sha256: str
    worker_tree_sha256: str
    votes_sha256: str
    comments_sha256: Optional[str]
    moderation_sha256: Optional[str]
    convention: str
    schedule_sha256: str
    profile: str
    initialization_schema: str
    restore_schema: str
    migration_sha256: str
    policy_sha256: str
    comparer_cfg_sha256: str
    stage_binding_version: str
    serialization_profile: str


def bridge_cache_key(inputs: BridgeCacheInputs) -> dict[str, Any]:
    """Compose the bridge recording-cache identity.

    It binds driver AND loader IDs, the binary and worker tree hashes, all
    input/comment/moderation hashes, convention, resolved schedule and profile,
    initialization and restore schema, migrations, policy/comparer hashes, and
    the stage-capture/serialization profile — exactly the fields the brief §2
    lists. Returns ``{"schema", "key", "bound": {...}}``; ``key`` is a sha256 over
    the canonicalised bound fields.

    The bridge cache is SEPARATE from the legacy clj/py caches: it never shares
    their namespace, so a bridge run cannot invalidate or be satisfied by a
    two-driver recording."""
    bound = {
        "driver_id": inputs["driver_id"],
        "loader_id": inputs["loader_id"],
        "binary_tree_sha256": inputs["binary_tree_sha256"],
        "worker_tree_sha256": inputs["worker_tree_sha256"],
        "votes_sha256": inputs["votes_sha256"],
        "comments_sha256": inputs.get("comments_sha256"),
        "moderation_sha256": inputs.get("moderation_sha256"),
        "convention": inputs["convention"],
        "schedule_sha256": inputs["schedule_sha256"],
        "profile": inputs["profile"],
        "initialization_schema": inputs["initialization_schema"],
        "restore_schema": inputs["restore_schema"],
        "migration_sha256": inputs["migration_sha256"],
        "policy_sha256": inputs["policy_sha256"],
        "comparer_cfg_sha256": inputs["comparer_cfg_sha256"],
        "stage_binding_version": inputs.get("stage_binding_version", STAGE_BINDING_SCHEMA),
        "serialization_profile": inputs["serialization_profile"],
        "cache_schema": BRIDGE_CACHE_SCHEMA,
    }
    canon = json.dumps(bound, sort_keys=True, separators=(",", ":")).encode()
    return {"schema": BRIDGE_CACHE_SCHEMA, "key": hashlib.sha256(canon).hexdigest(), "bound": bound}


# ---------------------------------------------------------------------------
# Three-producer inventory rows (never hashed; purely additive).
# ---------------------------------------------------------------------------
def three_producer_inventory(expected: cert.ExpectedEntry, profile: str,
                             drivers: tuple[str, ...] = DRIVER_IDS) -> list[dict[str, Any]]:
    """Per-entry inventory rows for the SELECTED ``drivers`` on ``profile``.

    With the default clj/py/rust the legacy two rows are byte-identical to
    ``ExpectedEntry.inventory()`` and the rust row is appended; a narrower
    selection emits exactly those producers (so the report never claims to have
    invoked a driver the invocation did not select). A driver that does not
    advertise ``profile`` is marked UNSUPPORTED_PROFILE up front."""
    if profile not in PROFILES:
        raise BridgeError("profile", f"unknown profile {profile!r} (allowed: {PROFILES})")
    rows: list[dict[str, Any]] = []
    for engine in drivers:
        spec = REGISTRY[engine]
        rows.append({
            "dataset": expected.entry.dataset,
            "schedule_id": expected.entry.schedule_id,
            "role": expected.entry.role or f"{expected.entry.dataset}:{expected.entry.schedule_id}",
            "engine": engine,
            "loader": spec.loader,
            "profile": profile,
            "coverage": expected.spec.coverage,
            "stream_end": expected.stream_end,
            "checkpoints": expected.checkpoints,
            "advertised": spec.supports(profile),
            "status": (ProducerStatus.INCONCLUSIVE if spec.supports(profile)
                       else ProducerStatus.UNSUPPORTED_PROFILE).value,
        })
    return rows


# ===========================================================================
# P-045 slice 2 (identity / readback / observer / stage sibling).
#
# These grade a `rust` producer on the ONLY profile the binary implements today,
# snapshot-rebuild/1 — the scoped rebuild verdict both P-044 and P-045 refuse to
# call a battery-chain PASS. They are PURE validators over readback/checkpoint
# dicts, so they run with neither Postgres nor the binary; the real DB readback,
# the live observer and the actual worker launch are slice 3 (BLOCKED). The
# once --replay-plan/--checkpoint/--evidence-dir forced-compute path is NOT
# touched here and stays as it is on the S1 binary.
# ===========================================================================

#: S1's closed candidate-checkpoint wire values (engine_adapter.snapshot). The
#: bridge BINDS these, not just key presence: the adapter emits exactly this
#: versioned identity, and a changed worker must NEGOTIATE a new version.
S1_CHECKPOINT_SCHEMA = "polis-candidate-checkpoint/1"
#: The STORE's persisted checkpoint envelope (Rust ResultsStore, store.rs) — a
#: DIFFERENT object from the worker's polis-candidate-checkpoint/1.
STORE_CHECKPOINT_SCHEMA = "polis-coordinator/1"
S1_PROTOCOL = "polis-engine/1"
S1_OUTPUT_SCHEMA = "polis-candidate-math-output/1"
S1_STATE_SCHEMA = "rebuild-prefix/1"
S1_PROFILE_WIRE = "candidate-profile"

#: Retained checkpoint fields (brief §5), each with the concrete check applied.
#: "str+" = nonempty string; "int" = int and not bool; "bool" = bool; a literal
#: string = that exact value.
S1_CHECKPOINT_FIELDS: tuple[str, ...] = (
    "protocol", "fixture_id", "run_id", "session_id", "compute_id",
    "checkpoint_id", "output_schema", "state_schema", "profile", "persistence",
)
_S1_CHECKPOINT_EXPECT: dict[str, Any] = {
    "protocol": S1_PROTOCOL, "fixture_id": "int", "run_id": "str+",
    "session_id": "str+", "compute_id": "str+", "checkpoint_id": "str+",
    "output_schema": S1_OUTPUT_SCHEMA, "state_schema": S1_STATE_SCHEMA,
    "profile": S1_PROFILE_WIRE, "persistence": "false",
}

#: Identity fields the caller may bind expected values for (per-run, not global).
#: fixture_id is bound too (a checkpoint for fixture 999 must not pass when the
#: caller expects fixture 1).
S1_EXPECTED_IDENTITY_FIELDS = ("fixture_id", "run_id", "session_id", "compute_id", "checkpoint_id")
S1_EXPECTED_ADMISSION_FIELDS = ("input_digest", "schedule_digest", "operation_id")

#: The COMPLETE closed key set of the worker's polis-candidate-checkpoint/1
#: envelope (engine_adapter.snapshot). All 15 are mandatory; unknown top-level
#: keys are rejected.
S1_CHECKPOINT_CLOSED_KEYS = frozenset({
    "schema", "protocol", "run_id", "session_id", "fixture_id", "checkpoint_id",
    "compute_id", "profile", "admission", "output_schema", "state_schema",
    "persistence", "math_input_cursors", "observed_state_cursors", "files",
})
#: The four output files the worker snapshots (emit_payloads + restore), each a
#: {path, bytes, sha256} descriptor.
S1_FILE_KEYS = ("main", "bidtopid", "ptptstats", "restore")
_CURSOR_STREAMS = ("votes", "moderation")


def _valid_descriptor(d: Any) -> bool:
    return (isinstance(d, dict) and _nonempty_str(d.get("path"))
            and _plain_int(d.get("bytes")) and _nonempty_str(d.get("sha256")))


def _cursor_fails(cursors: Any, label: str) -> list[str]:
    """A cursor map is {votes,moderation} -> {slot: int-non-bool, sha256: str}."""
    if not isinstance(cursors, dict) or set(cursors) != set(_CURSOR_STREAMS):
        return [f"{label} must be an object with keys {list(_CURSOR_STREAMS)}"]
    out: list[str] = []
    for stream in _CURSOR_STREAMS:
        cur = cursors[stream]
        if not isinstance(cur, dict) or not _plain_int(cur.get("slot")) or not _nonempty_str(cur.get("sha256")):
            out.append(f"{label}.{stream} must carry a (non-boolean) integer slot and a sha256")
    return out


def _nonempty_str(v: Any) -> bool:
    return isinstance(v, str) and len(v) > 0


def _plain_int(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def validate_s1_identity(manifest: dict[str, Any], *,
                         expected_admission: Optional[dict[str, Any]] = None,
                         expected_identity: Optional[dict[str, Any]] = None) -> list[str]:
    """Check S1's closed, VERSIONED identity on a candidate checkpoint manifest.

    Binds the checkpoint schema (``polis-candidate-checkpoint/1``); requires the
    admission block to hold EXACTLY the five fields (no unknown keys) with
    candidate_schema/engine_version at the pinned S1 constants and
    input_digest/schedule_digest/operation_id NONEMPTY strings; and binds each
    retained checkpoint field to its expected value/type — nonempty strings,
    non-boolean fixture_id, ``persistence`` EXACTLY False (pinned engine.rs
    requires false), and the pinned output/state/profile wire values.

    Per-run EXPECTED identity is bound when supplied: ``expected_admission``
    (``input_digest``/``schedule_digest``/``operation_id`` expected values) and
    ``expected_identity`` (``run_id``/``session_id``/``compute_id``/
    ``checkpoint_id`` expected values). Without them a manifest is validated for
    the closed ENVELOPE only; a real acceptance MUST supply the operation
    identity so a well-typed FOREIGN session/digest is rejected, not accepted.
    A different engine_version is never accepted as "implements a capability S1
    never advertised". Returns failures (empty == identity intact)."""
    fails: list[str] = []
    if manifest.get("schema") != S1_CHECKPOINT_SCHEMA:
        fails.append(f"checkpoint schema must be {S1_CHECKPOINT_SCHEMA!r}, "
                     f"got {manifest.get('schema')!r}")
    # The full 15-field worker envelope is CLOSED: every field mandatory, no
    # unknown top-level keys.
    missing_env = sorted(S1_CHECKPOINT_CLOSED_KEYS - set(manifest))
    unknown_env = sorted(set(manifest) - S1_CHECKPOINT_CLOSED_KEYS)
    if missing_env:
        fails.append(f"checkpoint missing envelope field(s): {missing_env}")
    if unknown_env:
        fails.append(f"checkpoint has unknown top-level field(s): {unknown_env}")
    # Snapshot file descriptors and both cursor maps (mandatory in the envelope,
    # separately checked by the Rust compute path).
    files = manifest.get("files")
    if not isinstance(files, dict) or set(files) != set(S1_FILE_KEYS):
        fails.append(f"checkpoint.files must map exactly {list(S1_FILE_KEYS)}")
    else:
        for k in S1_FILE_KEYS:
            if not _valid_descriptor(files[k]):
                fails.append(f"checkpoint.files.{k} must be a {{path, bytes, sha256}} descriptor")
    fails.extend(_cursor_fails(manifest.get("math_input_cursors"), "math_input_cursors"))
    fails.extend(_cursor_fails(manifest.get("observed_state_cursors"), "observed_state_cursors"))
    admission = manifest.get("admission")
    if not isinstance(admission, dict):
        return fails + ["admission block missing or not an object"]
    unknown = set(admission) - set(S1_ADMISSION_FIELDS)
    if unknown:
        fails.append(f"admission has unknown key(s): {sorted(unknown)}")
    for f in S1_ADMISSION_FIELDS:
        if f not in admission:
            fails.append(f"admission missing {f}")
    if admission.get("candidate_schema") != S1_CANDIDATE_SCHEMA:
        fails.append(f"candidate_schema must be {S1_CANDIDATE_SCHEMA!r}, "
                     f"got {admission.get('candidate_schema')!r}")
    if admission.get("engine_version") != S1_ENGINE_VERSION:
        fails.append(f"engine_version must be {S1_ENGINE_VERSION!r}, "
                     f"got {admission.get('engine_version')!r} (negotiate a new "
                     f"version rather than claim S1 bytes)")
    for f in S1_EXPECTED_ADMISSION_FIELDS:
        if f in admission and not _nonempty_str(admission[f]):
            fails.append(f"admission.{f} must be a nonempty string")
    for f in S1_CHECKPOINT_FIELDS:
        if f not in manifest:
            fails.append(f"checkpoint missing {f}")
            continue
        expect, val = _S1_CHECKPOINT_EXPECT[f], manifest[f]
        if expect == "str+" and not _nonempty_str(val):
            fails.append(f"checkpoint.{f} must be a nonempty string, got {val!r}")
        elif expect == "int" and not _plain_int(val):
            fails.append(f"checkpoint.{f} must be a (non-boolean) integer, got {val!r}")
        elif expect == "false" and val is not False:
            fails.append(f"checkpoint.{f} must be exactly False, got {val!r}")
        elif expect not in ("str+", "int", "false") and val != expect:
            fails.append(f"checkpoint.{f} must be {expect!r}, got {val!r}")
    # Per-run expected-identity binding (rejects a well-typed FOREIGN identity).
    if expected_admission is not None:
        for f in S1_EXPECTED_ADMISSION_FIELDS:
            if f in expected_admission and admission.get(f) != expected_admission[f]:
                fails.append(f"admission.{f} {admission.get(f)!r} != expected {expected_admission[f]!r}")
    if expected_identity is not None:
        for f in S1_EXPECTED_IDENTITY_FIELDS:
            if f in expected_identity and manifest.get(f) != expected_identity[f]:
                fails.append(f"checkpoint.{f} {manifest.get(f)!r} != expected {expected_identity[f]!r}")
    return fails


def bind_campaign_cut(*, compute_id: str, checkpoint_id: str, global_cut_index: int,
                      schedule_digest: str, campaign_plan_sha256: str) -> dict[str, Any]:
    """The campaign sidecar entry binding S1's per-session identity to ONE global
    cut. S1 resets names to compute-0/checkpoint-0 in a fresh session, so local
    name reuse across different sessions is legal; this record makes the mapping
    explicit and distinguishes the campaign plan hash from S1's schedule_digest."""
    return {
        "compute_id": compute_id, "checkpoint_id": checkpoint_id,
        "global_cut_index": int(global_cut_index),
        "s1_schedule_digest": schedule_digest,
        "campaign_plan_sha256": campaign_plan_sha256,
    }


# ---------------------------------------------------------------------------
# Four-row publication readback (main/bidtopid/ptptstats/ticks).
# ---------------------------------------------------------------------------
class TableRow(TypedDict, total=False):
    math_tick: int
    caching_tick: Optional[int]
    data: dict          # parsed JSONB — correspondence ONLY, never the origin
    original_bytes: str  # the exact bytes the worker emitted (origin of truth)
    original_sha256: str


class TicksRow(TypedDict, total=False):
    math_tick: int
    caching_tick: Optional[int]
    publisher_epoch: int
    operation_id: str
    original_digests: dict   # {"main","bidtopid","ptptstats"}


class ReadbackBundle(TypedDict, total=False):
    zid: int
    math_env: str
    main: TableRow
    bidtopid: TableRow
    ptptstats: TableRow
    ticks: TicksRow


_COMPANIONS = ("bidtopid", "ptptstats")
_PAYLOAD_TABLES = ("main", "bidtopid", "ptptstats")


def _json_type_equal(a: Any, b: Any) -> bool:
    """Type-aware JSON equality: PostgreSQL is allowed to normalize NUMBER
    spelling (1 vs 1.0), but a JSON boolean is NEVER equal to an integer —
    Python's ``1 == True`` must not launder a bool into a faithful integer
    payload. Recurses structurally; dict key sets and list lengths must match."""
    if isinstance(a, bool) or isinstance(b, bool):
        return isinstance(a, bool) and isinstance(b, bool) and a == b
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return a == b
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(_json_type_equal(a[k], b[k]) for k in a)
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(_json_type_equal(x, y) for x, y in zip(a, b))
    return type(a) is type(b) and a == b


def validate_readback(bundle: ReadbackBundle, *, expected_prior_tick: Optional[int],
                      operation_id: str, publisher_epoch: int,
                      expected_zid: Optional[int] = None,
                      expected_math_env: Optional[str] = None,
                      expected_input_checkpoint: Optional[dict[str, Any]] = None) -> list[str]:
    """Grade a Rust producer's own readback of the four math rows (brief §4).

    Requires: publication SCOPE (a non-boolean integer ``zid`` and a nonempty
    ``math_env``, bound to ``expected_zid``/``expected_math_env`` when supplied);
    all four ``math_tick`` present as NON-BOOLEAN integers and in agreement;
    expected prior->next tick (first publication 0 when ``expected_prior_tick is
    None``); both companions present with ``data``; epoch/operation binding;
    per-table original-byte hashes matching the row's own ``original_sha256`` AND
    ``ticks.original_digests``; and TYPE-AWARE JSONB correspondence to those exact
    original bytes.

    JSONB evidence (``data``) is REQUIRED per table; ``data::text`` is never
    original evidence (a row without ``original_bytes`` fails rather than falling
    back to its rendering). ``caching_tick`` is inspected only on ``math_main``;
    neither companion carries one. Cross-producer allocation values/owner UUIDs
    are out of scope (they need not match); the logical cut mapping that must
    match is graded by the campaign sidecar."""
    fails: list[str] = []

    # 0. publication scope
    zid = bundle.get("zid")
    if not _plain_int(zid):
        fails.append(f"bundle zid must be a (non-boolean) integer, got {zid!r}")
    elif expected_zid is not None and zid != expected_zid:
        fails.append(f"bundle zid {zid!r} != expected {expected_zid!r}")
    env = bundle.get("math_env")
    if not _nonempty_str(env):
        fails.append(f"bundle math_env must be a nonempty string, got {env!r}")
    elif expected_math_env is not None and env != expected_math_env:
        fails.append(f"bundle math_env {env!r} != expected {expected_math_env!r}")

    ticks = bundle.get("ticks") or {}
    tick_val = ticks.get("math_tick")

    # 1. next-tick allocation (non-boolean integer)
    if not _plain_int(tick_val):
        fails.append(f"ticks.math_tick must be a (non-boolean) integer, got {tick_val!r}")
    elif expected_prior_tick is None:
        if tick_val != 0:
            fails.append(f"first publication math_tick must be 0, got {tick_val!r}")
    elif tick_val != expected_prior_tick + 1:
        fails.append(f"math_tick must be prior+1 ({expected_prior_tick}+1), got {tick_val!r}")

    # 2. four-row tick agreement + companion presence + JSONB present
    for name in _PAYLOAD_TABLES:
        row = bundle.get(name)
        if not row:
            fails.append(f"{name}: row absent")
            continue
        rt = row.get("math_tick")
        if not _plain_int(rt):
            fails.append(f"{name}: math_tick must be a (non-boolean) integer, got {rt!r}")
        elif rt != tick_val:
            fails.append(f"{name}: math_tick {rt!r} != ticks {tick_val!r}")
        if not isinstance(row.get("data"), (dict, list)):
            fails.append(f"{name}: JSONB data (correspondence evidence) is required")
    for name in _COMPANIONS:
        row = bundle.get(name) or {}
        if row.get("caching_tick") is not None:
            fails.append(f"{name}: companion must not carry a caching_tick")
    if bundle.get("main") and "caching_tick" not in (bundle.get("main") or {}):
        fails.append("main: caching_tick absent where it must exist")

    # 3. operation / epoch binding (epoch TYPED before comparison: a JSON bool
    # must not match an expected integer via Python's True == 1)
    if ticks.get("operation_id") != operation_id:
        fails.append(f"ticks.operation_id {ticks.get('operation_id')!r} != {operation_id!r}")
    epoch = ticks.get("publisher_epoch")
    if not _plain_int(epoch):
        fails.append(f"ticks.publisher_epoch must be a (non-boolean) integer, got {epoch!r}")
    elif epoch != publisher_epoch:
        fails.append(f"ticks.publisher_epoch {epoch!r} != {publisher_epoch!r}")

    # 3b. persisted store checkpoint (polis-coordinator/1) custody. It is
    # REQUIRED — the real store rejects absent checkpoints (store.rs) — a foreign
    # or operation-only object is rejected, cursor slots are TYPED (a boolean slot
    # must not equal an expected integer), and an expected checkpoint binds by
    # TYPE-AWARE equality (preserving PG number spelling, keeping bools distinct).
    ckpt = ticks.get("input_checkpoint")
    if not isinstance(ckpt, dict):
        fails.append("ticks.input_checkpoint (persisted store checkpoint) is required and must be an object")
    else:
        if ckpt.get("schema") != STORE_CHECKPOINT_SCHEMA:
            fails.append(f"input_checkpoint.schema must be {STORE_CHECKPOINT_SCHEMA!r}, "
                         f"got {ckpt.get('schema')!r}")
        if ckpt.get("operation_id") != operation_id:
            fails.append(f"input_checkpoint.operation_id {ckpt.get('operation_id')!r} != {operation_id!r}")
        cdig = ckpt.get("original_digests")
        if not isinstance(cdig, dict) or not _json_type_equal(cdig, ticks.get("original_digests") or {}):
            fails.append("input_checkpoint.original_digests missing or disagree with ticks.original_digests")
        cursors = ckpt.get("cursors")
        if not isinstance(cursors, dict) or not cursors:
            fails.append("input_checkpoint.cursors is required")
        else:
            for stream, cur in cursors.items():
                if not isinstance(cur, dict) or not _plain_int(cur.get("slot")):
                    fails.append(f"input_checkpoint.cursors.{stream}.slot must be a (non-boolean) integer")
        if expected_input_checkpoint is not None and not _json_type_equal(ckpt, expected_input_checkpoint):
            fails.append("input_checkpoint does not equal the expected checkpoint (type-aware)")

    # 4. original-byte custody + TYPE-AWARE JSONB correspondence, per table
    original_digests = ticks.get("original_digests") or {}
    for name in _PAYLOAD_TABLES:
        row = bundle.get(name)
        if not row:
            continue
        raw = row.get("original_bytes")
        if raw is None:
            fails.append(f"{name}: original_bytes absent — data::text is not original evidence")
            continue
        raw_bytes = raw.encode() if isinstance(raw, str) else bytes(raw)
        digest = hashlib.sha256(raw_bytes).hexdigest()
        if row.get("original_sha256") != digest:
            fails.append(f"{name}: original_sha256 does not match its original_bytes")
        if original_digests.get(name) != digest:
            fails.append(f"{name}: ticks.original_digests[{name}] does not match original_bytes")
        try:
            parsed = json.loads(raw_bytes)
        except (ValueError, TypeError):
            fails.append(f"{name}: original_bytes is not valid JSON")
            continue
        if "data" in row and not _json_type_equal(parsed, row["data"]):
            fails.append(f"{name}: JSONB data does not correspond to the original bytes")
    return fails


#: The actual companion wrapper math_writer.derive_bidtopid emits (verified
#: against math_writer.py:32-84): a positional vector of member vectors aligned
#: to main.base-clusters.id, NOT a {bid: [pid]} dict.
_BIDTOPID_KEYS = frozenset({"zid", "bidToPid", "lastVoteTimestamp"})


def _check_bidtopid_against_main(main: Any, bid: Any, zid: Any) -> list[str]:
    """Resolve bids through ``main.base-clusters.id`` into the real ``bidToPid``
    wrapper and compare the ordered membership relationships. A wrapper that is
    not the writer's ``{zid, bidToPid, lastVoteTimestamp}`` shape, or whose
    positional buckets do not equal ``base-clusters.members``, does NOT belong to
    this bundle and is rejected; an empty generation (no base clusters, empty
    bidToPid) is valid."""
    if not isinstance(bid, dict) or not isinstance(main, dict):
        return ["observer: bidtopid/main data missing for bid->index->pid check"]
    if set(bid) != _BIDTOPID_KEYS:
        return [f"observer: bidtopid is not the writer wrapper {sorted(_BIDTOPID_KEYS)} "
                f"(got keys {sorted(bid)})"]
    btp = bid["bidToPid"]
    base = main.get("base-clusters")
    if not isinstance(base, dict):
        return ["observer: main.base-clusters missing for bid->index->pid check"]
    ids, members = base.get("id"), base.get("members")
    counts = base.get("count")
    if not (isinstance(btp, list) and isinstance(ids, list) and isinstance(members, list)):
        return ["observer: bidToPid / base-clusters.id / base-clusters.members must be lists"]
    if not (len(btp) == len(ids) == len(members)):
        return [f"observer: bidToPid ({len(btp)}) not aligned to base-clusters "
                f"id/members ({len(ids)}/{len(members)})"]
    fails: list[str] = []
    if zid is not None and bid.get("zid") != zid:
        fails.append(f"observer: bidtopid.zid {bid.get('zid')!r} != bundle zid {zid!r}")

    # base-cluster ids: typed and UNIQUE
    if not all(_plain_int(x) for x in ids):
        fails.append("observer: base-clusters.id must be integers")
    elif len(set(ids)) != len(ids):
        fails.append(f"observer: base-clusters.id has duplicates: {ids}")

    # counts (when present): one per cluster, equal to that cluster's membership size
    if counts is not None:
        if not isinstance(counts, list) or len(counts) != len(members):
            fails.append("observer: base-clusters.count is not one entry per cluster")
        else:
            for i, (c, mem) in enumerate(zip(counts, members)):
                if c != (len(mem) if isinstance(mem, list) else None):
                    fails.append(f"observer: base-clusters.count[{i}]={c!r} != len(members)="
                                 f"{len(mem) if isinstance(mem, list) else '?'}")

    # membership is a PARTITION of the clustered participants: each bucket a list
    # of integer pids, unique within a bucket and DISJOINT across buckets; and
    # bidToPid[i] equals base-clusters.members[i] positionally.
    seen: set = set()
    for i, (bucket, mem) in enumerate(zip(btp, members)):
        if not isinstance(bucket, list) or not all(_plain_int(x) for x in bucket):
            fails.append(f"observer: bidToPid[{i}] is not a list of integer pids")
            continue
        if list(bucket) != list(mem):
            fails.append(f"observer: bidToPid[{i}]={bucket} != base-clusters.members[{i}]={mem} "
                         f"(positional bid membership mismatch)")
        if len(set(bucket)) != len(bucket):
            fails.append(f"observer: base cluster {i} has duplicate participant(s): {bucket}")
        overlap = seen & set(bucket)
        if overlap:
            fails.append(f"observer: participant(s) {sorted(overlap)} appear in more than one base cluster")
        seen |= set(bucket)

    # group clusters (when present): every group bid must reference an existing
    # base cluster id.
    groups = main.get("group-clusters")
    if isinstance(groups, list):
        idset = set(x for x in ids if _plain_int(x))
        for g in groups:
            for gbid in (g.get("members") or []) if isinstance(g, dict) else []:
                if gbid not in idset:
                    fails.append(f"observer: group cluster references unknown base bid {gbid!r}")
    return fails


def observe_bundle_coherence(bundle: ReadbackBundle,
                             fold_check: Optional[Callable[..., list[str]]] = None) -> list[str]:
    """Independent post-cut coherence of a published bundle (brief §4/§5 observer).

    Refuses ABSENT evidence: ticks and all four rows must be present, each with a
    non-boolean integer ``math_tick`` in one agreeing generation and JSONB
    ``data``; an empty ``{}`` bundle fails rather than trivially passing four
    absent-equals-absent ticks. It validates the ACTUAL serialized companion:
    ``bidtopid.data`` is the writer's ``{zid, bidToPid, lastVoteTimestamp}``
    wrapper, resolved positionally through ``main.base-clusters.id`` and required
    to equal ``base-clusters.members`` bucket for bucket — so an unrelated invented
    map and duplicate/overlapping buckets are rejected, and a legitimate empty
    generation is accepted. ``fold_check`` (e.g. the recovery oracle's
    ``check_published_against_fold``) is the OPTIONAL full latest-cell fold.
    Returns failures (empty == coherent). A live mid-publication observer remains
    a slice-3 integration obligation; this pure helper does not claim it."""
    fails: list[str] = []
    ticks = bundle.get("ticks")
    if not isinstance(ticks, dict) or not _plain_int(ticks.get("math_tick")):
        fails.append("observer: ticks.math_tick absent or not a non-boolean integer")
        tick_val: Optional[int] = None
    else:
        tick_val = ticks["math_tick"]
    for name in _PAYLOAD_TABLES:
        row = bundle.get(name)
        if not isinstance(row, dict) or not row:
            fails.append(f"observer: {name} row absent")
            continue
        rt = row.get("math_tick")
        if not _plain_int(rt):
            fails.append(f"observer: {name} math_tick absent or not a non-boolean integer")
        elif tick_val is not None and rt != tick_val:
            fails.append(f"observer: {name} at a different generation than ticks")
        if not isinstance(row.get("data"), (dict, list)):
            fails.append(f"observer: {name} data absent")
    main = (bundle.get("main") or {}).get("data")
    bid = (bundle.get("bidtopid") or {}).get("data")
    fails.extend(_check_bidtopid_against_main(main, bid, bundle.get("zid")))
    if fold_check is not None:
        try:
            fails.extend(fold_check(main) or [])
        except Exception as exc:  # noqa: BLE001 - a fold failure is a finding, not a crash
            fails.append(f"observer: fold raised {exc!r}")
    return fails


# ---------------------------------------------------------------------------
# Same-invocation stage sibling (p045-stage-binding/1) + stage context.
# ---------------------------------------------------------------------------
#: Full run/session/plan-scoped identity of one stage-context entry. Scoping to
#: the COMPLETE identity (including run_id, not just the S1-reused
#: compute-0/checkpoint-0 local names) is what stops two fresh runs/sessions from
#: colliding, and keeps the campaign plan digest distinct from S1's per-session
#: schedule.
StageContextKey = tuple[str, str, str, str, str]  # (plan_sha256, run_id, session_id, compute_id, checkpoint_id)

#: The nonempty-string identity fields, in key order.
_STAGE_CONTEXT_IDENTITY = ("plan_sha256", "run_id", "session_id", "compute_id", "checkpoint_id")


class StageContextEntry(TypedDict, total=False):
    plan_sha256: str
    run_id: str
    session_id: str
    compute_id: str
    checkpoint_id: str
    global_cut_index: int
    semantic_input_digest: str   # R-ORACLE digest the worker must reproduce
    profile: str


_STAGE_CONTEXT_KEYS = frozenset(_STAGE_CONTEXT_IDENTITY) | {
    "global_cut_index", "semantic_input_digest", "profile"}


def load_stage_context(path: str | Path) -> dict[StageContextKey, StageContextEntry]:
    """Load a closed ``p045-stage-context/1`` map keyed on the FULL identity
    ``(plan_sha256, run_id, session_id, compute_id, checkpoint_id)``.

    Every entry is fully TYPED before its key is built: the container is an
    object, the key set is exactly the closed set (no missing/unknown keys), the
    five identity fields are NONEMPTY strings (a null or a list-valued identity is
    a graded BridgeError, never an ungraded TypeError), ``global_cut_index`` is a
    non-boolean nonnegative integer, ``profile`` is a known campaign profile, and
    ``semantic_input_digest`` is nonempty. DUPLICATE full identities are rejected
    before insertion. A wrong schema fails."""
    obj = json.loads(Path(path).read_bytes())
    if not isinstance(obj, dict) or obj.get("schema") != STAGE_CONTEXT_SCHEMA:
        raise BridgeError("stage-context", f"stage context schema must be {STAGE_CONTEXT_SCHEMA!r}")
    entries = obj.get("entries")
    if not isinstance(entries, list):
        raise BridgeError("stage-context", "entries must be a list")
    out: dict[StageContextKey, StageContextEntry] = {}
    for i, ent in enumerate(entries):
        if not isinstance(ent, dict):
            raise BridgeError("stage-context", f"entry {i} is not an object")
        if set(ent) != _STAGE_CONTEXT_KEYS:
            raise BridgeError("stage-context", f"entry {i} key set must be exactly "
                              f"{sorted(_STAGE_CONTEXT_KEYS)}, got {sorted(ent)}")
        for f in _STAGE_CONTEXT_IDENTITY:
            if not _nonempty_str(ent[f]):
                raise BridgeError("stage-context", f"entry {i} {f} must be a nonempty string")
        cut = ent["global_cut_index"]
        if not _plain_int(cut) or cut < 0:
            raise BridgeError("stage-context", f"entry {i} global_cut_index must be a nonnegative integer")
        if ent["profile"] not in PROFILES:
            raise BridgeError("stage-context", f"entry {i} profile {ent['profile']!r} not in {PROFILES}")
        if not _nonempty_str(ent["semantic_input_digest"]):
            raise BridgeError("stage-context", f"entry {i} semantic_input_digest must be nonempty")
        key: StageContextKey = tuple(ent[f] for f in _STAGE_CONTEXT_IDENTITY)  # type: ignore[assignment]
        if key in out:
            raise BridgeError("stage-context", f"duplicate stage-context identity {key}")
        out[key] = {
            "plan_sha256": ent["plan_sha256"], "run_id": ent["run_id"],
            "session_id": ent["session_id"], "compute_id": ent["compute_id"],
            "checkpoint_id": ent["checkpoint_id"], "global_cut_index": cut,
            "semantic_input_digest": ent["semantic_input_digest"], "profile": ent["profile"],
        }
    return out


def check_stage_context(context: dict[StageContextKey, StageContextEntry], *,
                        plan_sha256: str, session_id: str, compute_id: str,
                        checkpoint_id: str, derived_semantic_digest: str,
                        run_id: Optional[str] = None,
                        expected_profile: Optional[str] = None,
                        expected_cut_index: Optional[int] = None) -> list[str]:
    """The worker derives the semantic digest from the inputs it ACTUALLY applied
    and checks it against the plan-bound context, addressed by the FULL identity
    INCLUDING run_id — a foreign run with the same local session/compute/checkpoint
    names does not match. run binding is MANDATORY: omitting ``run_id`` fails
    closed (an unbound consumer cannot certify a run). A foreign identity, a
    mismatched digest, or (when supplied) a wrong profile/cut is rejected — the
    plan's expected hash is never stamped onto an unverified source."""
    if not _nonempty_str(run_id):
        return ["stage context requires a nonempty run_id for run binding"]
    key: StageContextKey = (plan_sha256, run_id, session_id, compute_id, checkpoint_id)
    entry = context.get(key)
    if entry is None:
        return [f"foreign stage context: {key} not in the plan"]
    fails: list[str] = []
    if entry["semantic_input_digest"] != derived_semantic_digest:
        fails.append(f"semantic input digest mismatch: derived {derived_semantic_digest!r} "
                     f"!= context {entry['semantic_input_digest']!r}")
    if expected_profile is not None and entry["profile"] != expected_profile:
        fails.append(f"stage-context profile {entry['profile']!r} != expected {expected_profile!r}")
    if expected_cut_index is not None and entry["global_cut_index"] != expected_cut_index:
        fails.append(f"stage-context cut {entry['global_cut_index']!r} != expected {expected_cut_index!r}")
    return fails


def stage_binding_manifest(*, run_id: str, session_id: str, compute_id: str,
                           checkpoint_id: str, operation_id: str,
                           input_digest: str, schedule_digest: str,
                           semantic_input_digest: str, stage_file_sha256: str,
                           output_file_sha256s: dict[str, str],
                           binary_sha256: str, worker_tree_sha256: str,
                           profile: str) -> dict[str, Any]:
    """The closed ``p045-stage-binding/1`` SIBLING manifest — never appended to
    S1's closed four-file checkpoint. Its sidecar identifies producer ``rust``
    and binds it to its binary/worker hashes; the stage engine label stays ``py``
    (the Python science worker), so nobody relabels Python mathematics as Rust.
    The publication receipt must match this record."""
    return {
        "schema": STAGE_BINDING_SCHEMA,
        "producer": "rust",
        "stage_engine": "py",
        "run_id": run_id, "session_id": session_id,
        "compute_id": compute_id, "checkpoint_id": checkpoint_id,
        "operation_id": operation_id,
        "input_digest": input_digest,
        "schedule_digest": schedule_digest,
        "semantic_input_digest": semantic_input_digest,
        "stage_file_sha256": stage_file_sha256,
        "output_file_sha256s": dict(output_file_sha256s),
        "binary_sha256": binary_sha256,
        "worker_tree_sha256": worker_tree_sha256,
        "profile": profile,
    }


def capture_rust_stage_sibling(conv: Any, blob: dict[str, Any] | None, *,
                               step_index: int, semantic_input_digest: str,
                               out_dir: str | Path, tick: Any = None,
                               run_root: str | Path | None = None) -> Path:
    """Write ONE IMMUTABLE stage sibling for a Rust snapshot, using the very
    ``conv`` and already-emitted raw ``blob`` from that operation (brief §5).

    Immutability is enforced, not just implied by distinct directories: the file
    is created EXCLUSIVELY; if one already exists for this operation/cut, an
    identical retry is idempotent but ANY differing content is refused (a second
    snapshot for the same cut can never truncate and replace the first). When
    ``run_root`` is given the operation directory must be confined within it.
    Reuses ``stages.stage_document`` with the ``py`` engine label; never calls
    ``write_stage_documents`` (delete-then-write) or ``run_stage_dump`` (a second
    replay). Returns the path to the written stage document."""
    from polismath.replay import stages
    if not _plain_int(step_index) or step_index < 0:
        raise BridgeError("stage-evidence", f"step_index must be a nonnegative integer, got {step_index!r}")
    op_dir = Path(out_dir)
    if run_root is not None:
        rr = Path(run_root).resolve()
        try:
            op_dir.resolve().relative_to(rr)
        except ValueError:
            raise BridgeError("stage-evidence", f"operation dir {op_dir} escapes the run root {rr}")
    op_dir.mkdir(parents=True, exist_ok=True)
    doc = stages.stage_document(conv, step_index=step_index,
                                digest=semantic_input_digest, tick=tick, blob=blob,
                                engine=stages.PY_STAGE_ENGINE)
    payload = stages.canonical_json(doc)
    data = payload.encode() if isinstance(payload, str) else bytes(payload)
    dest = op_dir / f"step-{step_index:03d}.stages.json"
    try:
        with open(dest, "xb") as fh:
            fh.write(data)
    except FileExistsError:
        if dest.read_bytes() != data:
            raise BridgeError(
                "stage-evidence",
                f"refusing to overwrite immutable stage evidence at {dest}: a differing "
                f"sibling already exists for this operation") from None
    return dest


# ===========================================================================
# Slice-1 reachable reporting path (correction 1).
#
# A REAL runner + report so the `rust` producer can be invoked end-to-end the
# way clj/py can, emitting the required per-entry rows into a
# polis-certification-run/2 report — WITHOUT the blocked forced-compute or warm
# path. Unsupported computations stay non-passing: rust records
# UNSUPPORTED_PROFILE, the references record INCONCLUSIVE (their real recording
# is the existing certify.ensure_*_recording path, not re-run here), and every
# pair is non-passing. A bridge run ALWAYS writes a terminal manifest.
#
# STILL OUTSTANDING for full slice 1 (named, not faked): the Clojure three-table
# companion sink (real cm/prep-main / prep-bidToPid / prep-ptpt-stats capture
# through the pg-json/upload-math-* path) is a real-engine change to
# math/dev/replay.clj and cannot run without the JVM; it is not implemented here.
# ===========================================================================

BRIDGE_RUN_MANIFEST = "bridge_run_manifest-{run_id}.json"


def _entry_producer_rows(expected: Optional["cert.ExpectedEntry"], entry: Any,
                         profile: str, plan: dict[str, Any], out_root: Path,
                         drivers: tuple[str, ...]) -> list[dict[str, Any]]:
    """Producer rows for one entry, for EXACTLY the selected ``drivers`` — the
    report must not iterate all three when a subset was requested. Works whether
    or not the entry prepared."""
    if expected is not None:
        inv = {r["engine"]: r for r in three_producer_inventory(expected, profile, drivers)}
    else:
        role = getattr(entry, "role", None) or f"{getattr(entry, 'dataset', '?')}:{getattr(entry, 'schedule_id', '?')}"
        inv = {eng: {"dataset": getattr(entry, "dataset", None),
                     "schedule_id": getattr(entry, "schedule_id", None), "role": role,
                     "engine": eng, "loader": REGISTRY[eng].loader, "profile": profile,
                     "coverage": None, "stream_end": None, "checkpoints": [],
                     "advertised": REGISTRY[eng].supports(profile),
                     "status": (ProducerStatus.INCONCLUSIVE if REGISTRY[eng].supports(profile)
                                else ProducerStatus.UNSUPPORTED_PROFILE).value}
              for eng in drivers}
    rows: list[dict[str, Any]] = []
    for eng in drivers:
        row = dict(inv[eng])
        receipt = REGISTRY[eng].record(plan, expected if expected is not None else entry,
                                       out_root / eng)
        row["receipt"] = receipt.to_dict()
        row["status"] = receipt.status.value
        rows.append(row)
    return rows


def _pair_rows(entry_rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Pair rows for every UNORDERED pair among the producers actually present in
    ``entry_rows`` (so a subset selection yields only its own pairs). A pair is
    non-passing unless BOTH sides produced a PASS producer row (none can today)."""
    by_eng = {r["engine"]: r for r in entry_rows}
    present = [e for e in DRIVER_IDS if e in by_eng]
    pairs = []
    for i, a in enumerate(present):
        for b in present[i + 1:]:
            sa, sb = by_eng[a]["status"], by_eng[b]["status"]
            status = (ProducerStatus.PASS.value if sa == sb == ProducerStatus.PASS.value
                      else ProducerStatus.UNSUPPORTED_PROFILE.value
                      if ProducerStatus.UNSUPPORTED_PROFILE.value in (sa, sb)
                      else ProducerStatus.INCONCLUSIVE.value)
            pairs.append({"a": a, "b": b, "a_status": sa, "b_status": sb, "status": status})
    return pairs


def run_bridge_battery(entries: list[Any], *, root: str | Path, profile: str,
                       drivers: tuple[str, ...] = DRIVER_IDS,
                       policy_path: Optional[str | Path] = None,
                       battery_path: Optional[str | Path] = None) -> dict[str, Any]:
    """Run the three-producer bridge over ``entries`` and write a terminal
    polis-certification-run/2 report to ``<root>/certify_report_bridge.json``.

    No engine is launched and no database is touched; every producer row is
    non-passing (rust UNSUPPORTED_PROFILE; references INCONCLUSIVE). Returns the
    report dict. Raises BridgeError only on CONFIGURATION failure (bad drivers,
    unknown profile, bad policy) — a per-entry preparation failure becomes a
    non-passing row, not a crash, and the manifest is still written."""
    import uuid as _uuid
    from datetime import datetime, timezone
    drivers = parse_drivers(",".join(drivers)) if not isinstance(drivers, str) else parse_drivers(drivers)
    if profile not in PROFILES:
        raise BridgeError("profile", f"unknown profile {profile!r} (allowed: {PROFILES})")
    policy = load_policy(policy_path) if policy_path is not None else None
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    plan = {"profile": profile, "drivers": list(drivers)}
    run_id = str(_uuid.uuid4())

    producers: list[dict[str, Any]] = []
    pairs: list[dict[str, Any]] = []
    inventory: list[dict[str, Any]] = []
    for entry in entries:
        try:
            expected: Optional[cert.ExpectedEntry] = cert.prepare_entry(entry)
        except Exception as exc:  # noqa: BLE001 - a bad entry is a non-passing row
            expected = None
            plan_entry_err = str(exc)
        else:
            plan_entry_err = None
        rows = _entry_producer_rows(expected, entry, profile, plan, root / run_id, drivers)
        if plan_entry_err is not None:
            for r in rows:
                if r["engine"] != "rust":
                    r["status"] = ProducerStatus.INCONCLUSIVE.value
                    r["reason"] = f"prepare failed: {plan_entry_err}"
        producers.extend(rows)
        inventory.extend({k: r[k] for k in ("dataset", "schedule_id", "engine", "loader",
                                            "profile", "advertised", "status")} for r in rows)
        pairs.extend({"dataset": getattr(entry, "dataset", None),
                      "schedule_id": getattr(entry, "schedule_id", None), **p}
                     for p in _pair_rows(rows))

    all_pass = bool(producers) and all(r["status"] == ProducerStatus.PASS.value for r in producers)
    verdict = ProducerStatus.PASS.value if all_pass else ProducerStatus.INCONCLUSIVE.value
    report = {
        "schema": CERTIFICATION_RUN_SCHEMA_V2,
        "run_id": run_id,
        "finished_at": datetime.now(timezone.utc).isoformat(),
        "profile": profile,
        "drivers": list(drivers),
        "battery_path": str(battery_path) if battery_path is not None else None,
        "policy": policy.to_dict() if policy is not None else None,
        "inventory": inventory,
        "producers": producers,
        "pairs": pairs,
        "verdict": verdict,
        "terminal": True,
        "notes": ["rust producer UNSUPPORTED_PROFILE until the slice-3 "
                  "p045-replay-plan/1 forced-compute path exists",
                  "reference producers INCONCLUSIVE: their real recording is the "
                  "existing certify.ensure_*_recording path, not re-run here",
                  "Clojure three-table companion sink is a real-engine change not "
                  "implemented in this reachable-path slice"],
    }
    manifest_path = root / "certify_report_bridge.json"
    manifest_path.write_text(json.dumps(report, indent=2, sort_keys=True, default=str))
    (root / BRIDGE_RUN_MANIFEST.format(run_id=run_id)).write_text(
        json.dumps(report, indent=2, sort_keys=True, default=str))
    report["report_path"] = str(manifest_path)
    return report


def render_bridge_lines(report: dict[str, Any]) -> list[str]:
    """Human summary of a bridge report for the CLI."""
    lines = [f"bridge {report['schema']} verdict={report['verdict']} "
             f"profile={report['profile']} drivers={','.join(report['drivers'])}"]
    for r in report["producers"]:
        lines.append(f"  {r['dataset']}:{r['schedule_id']} {r['engine']:>4} -> {r['status']}")
    return lines


def bridge_exit_code(report: dict[str, Any]) -> int:
    """0 PASS, 1 FAIL, 2 INCONCLUSIVE (incl. UNSUPPORTED_PROFILE)."""
    v = report.get("verdict")
    if v == ProducerStatus.PASS.value:
        return 0
    if v == ProducerStatus.FAIL.value:
        return 1
    return 2
