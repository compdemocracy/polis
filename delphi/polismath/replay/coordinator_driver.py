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
    profile = getattr(plan, "profile", None) or (plan.get("profile") if isinstance(plan, dict) else None) or ""
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
    record=lambda plan, entry, out_dir: _legacy_receipt(
        "clj", "clj", getattr(plan, "profile", "") or "", entry),
)
PY = DriverSpec(
    id="py", loader="py", implementation_digest="",
    capabilities=(PROFILE_BATTERY_CHAIN, PROFILE_SNAPSHOT_REBUILD),
    record=lambda plan, entry, out_dir: _legacy_receipt(
        "py", "py", getattr(plan, "profile", "") or "", entry),
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
def three_producer_inventory(expected: cert.ExpectedEntry, profile: str) -> list[dict[str, Any]]:
    """Per-entry inventory rows for clj/py/rust on ``profile``.

    The legacy two rows are byte-identical to ``ExpectedEntry.inventory()``; the
    rust row is appended. A driver that does not advertise ``profile`` is marked
    UNSUPPORTED_PROFILE up front so the row exists as a visible non-pass."""
    if profile not in PROFILES:
        raise BridgeError("profile", f"unknown profile {profile!r} (allowed: {PROFILES})")
    rows: list[dict[str, Any]] = []
    for engine in DRIVER_IDS:
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
    "profile": S1_PROFILE_WIRE, "persistence": "bool",
}


def _nonempty_str(v: Any) -> bool:
    return isinstance(v, str) and len(v) > 0


def _plain_int(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def validate_s1_identity(manifest: dict[str, Any]) -> list[str]:
    """Check S1's closed, VERSIONED identity on a candidate checkpoint manifest.

    Binds the checkpoint schema (``polis-candidate-checkpoint/1``); requires the
    admission block to hold EXACTLY the five fields (no unknown keys) with
    candidate_schema/engine_version at the pinned S1 constants and
    input_digest/schedule_digest/operation_id NONEMPTY strings; and binds each
    retained checkpoint field to its expected value/type (nonempty strings,
    non-boolean fixture_id, boolean persistence, the pinned output/state/profile
    wire values). A different engine_version is never accepted as "implements a
    capability S1 never advertised". Returns failures (empty == identity intact).
    """
    fails: list[str] = []
    if manifest.get("schema") != S1_CHECKPOINT_SCHEMA:
        fails.append(f"checkpoint schema must be {S1_CHECKPOINT_SCHEMA!r}, "
                     f"got {manifest.get('schema')!r}")
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
    for f in ("input_digest", "schedule_digest", "operation_id"):
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
        elif expect == "bool" and not isinstance(val, bool):
            fails.append(f"checkpoint.{f} must be a boolean, got {val!r}")
        elif expect not in ("str+", "int", "bool") and val != expect:
            fails.append(f"checkpoint.{f} must be {expect!r}, got {val!r}")
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
                      expected_math_env: Optional[str] = None) -> list[str]:
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

    # 3. operation / epoch binding
    if ticks.get("operation_id") != operation_id:
        fails.append(f"ticks.operation_id {ticks.get('operation_id')!r} != {operation_id!r}")
    if ticks.get("publisher_epoch") != publisher_epoch:
        fails.append(f"ticks.publisher_epoch {ticks.get('publisher_epoch')!r} != {publisher_epoch!r}")

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


def _valid_bid_index_pid(mapping: Any) -> bool:
    """A bid->index->pid map: a NONEMPTY dict whose keys are integer bids and
    whose values are lists of (non-boolean) integer pids. ``{"garbage":"..."}``
    and an empty map are rejected."""
    if not isinstance(mapping, dict) or not mapping:
        return False
    for k, v in mapping.items():
        try:
            int(k)
        except (TypeError, ValueError):
            return False
        if not isinstance(v, list) or not all(_plain_int(x) for x in v):
            return False
    return True


def observe_bundle_coherence(bundle: ReadbackBundle,
                             fold_check: Optional[Callable[..., list[str]]] = None) -> list[str]:
    """Independent post-cut coherence of a published bundle (brief §4/§5 observer).

    Refuses ABSENT evidence: ticks and all four rows must be present, each with a
    non-boolean integer ``math_tick`` in one agreeing generation and JSONB
    ``data``; an empty ``{}`` bundle fails rather than trivially passing four
    absent-equals-absent ticks. It actually inspects the bid->index->pid mapping
    (a well-formed dict of integer bids -> integer-pid lists), not merely a
    list-typed member field. ``fold_check`` (e.g. the recovery oracle's
    ``check_published_against_fold``) is the OPTIONAL full latest-cell fold,
    injected so it can be reused without importing a pinned asset. Returns
    failures (empty == coherent). A live mid-publication observer remains a
    slice-3 integration obligation; this pure helper does not claim it."""
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
    bid = (bundle.get("bidtopid") or {}).get("data")
    if not _valid_bid_index_pid(bid):
        fails.append("observer: bidtopid is not a well-formed bid->index->pid mapping")
    if fold_check is not None:
        main = (bundle.get("main") or {}).get("data")
        try:
            fails.extend(fold_check(main) or [])
        except Exception as exc:  # noqa: BLE001 - a fold failure is a finding, not a crash
            fails.append(f"observer: fold raised {exc!r}")
    return fails


# ---------------------------------------------------------------------------
# Same-invocation stage sibling (p045-stage-binding/1) + stage context.
# ---------------------------------------------------------------------------
#: Full session/plan-scoped identity of one stage-context entry. Scoping to the
#: complete identity (not the S1-reused compute-0/checkpoint-0 local names) is
#: what stops two fresh sessions from colliding, and keeps the campaign plan
#: digest distinct from S1's per-session schedule.
StageContextKey = tuple[str, str, str, str]  # (plan_sha256, session_id, compute_id, checkpoint_id)


class StageContextEntry(TypedDict, total=False):
    plan_sha256: str
    run_id: str
    session_id: str
    compute_id: str
    checkpoint_id: str
    global_cut_index: int
    semantic_input_digest: str   # R-ORACLE digest the worker must reproduce
    profile: str


_STAGE_CONTEXT_REQUIRED = ("plan_sha256", "run_id", "session_id", "compute_id",
                           "checkpoint_id", "global_cut_index", "semantic_input_digest",
                           "profile")


def load_stage_context(path: str | Path) -> dict[StageContextKey, StageContextEntry]:
    """Load a closed ``p045-stage-context/1`` map keyed on the FULL identity
    ``(plan_sha256, session_id, compute_id, checkpoint_id)``.

    Each entry must carry every required field; ``global_cut_index`` must be a
    non-boolean nonnegative integer; ``profile`` must be a known campaign profile;
    ``semantic_input_digest`` a nonempty string. DUPLICATE keys are rejected
    BEFORE insertion (S1 reuses compute-0/checkpoint-0 across fresh sessions, so a
    permissive last-writer-wins loader would silently drop a cut). A wrong schema
    fails."""
    obj = json.loads(Path(path).read_bytes())
    if not isinstance(obj, dict) or obj.get("schema") != STAGE_CONTEXT_SCHEMA:
        raise BridgeError("stage-context", f"stage context schema must be {STAGE_CONTEXT_SCHEMA!r}")
    out: dict[StageContextKey, StageContextEntry] = {}
    for i, ent in enumerate(obj.get("entries", [])):
        if not isinstance(ent, dict):
            raise BridgeError("stage-context", f"entry {i} is not an object")
        missing = [k for k in _STAGE_CONTEXT_REQUIRED if k not in ent]
        if missing:
            raise BridgeError("stage-context", f"entry {i} missing {missing}")
        cut = ent["global_cut_index"]
        if not _plain_int(cut) or cut < 0:
            raise BridgeError("stage-context", f"entry {i} global_cut_index must be a nonnegative integer")
        if ent["profile"] not in PROFILES:
            raise BridgeError("stage-context", f"entry {i} profile {ent['profile']!r} not in {PROFILES}")
        if not _nonempty_str(ent["semantic_input_digest"]):
            raise BridgeError("stage-context", f"entry {i} semantic_input_digest must be nonempty")
        key: StageContextKey = (ent["plan_sha256"], ent["session_id"],
                                 ent["compute_id"], ent["checkpoint_id"])
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
                        expected_profile: Optional[str] = None,
                        expected_cut_index: Optional[int] = None) -> list[str]:
    """The worker derives the semantic digest from the inputs it ACTUALLY applied
    and checks it against the plan-bound context, addressed by the FULL identity.
    A foreign identity, a mismatched digest, or (when supplied) a wrong
    profile/cut is rejected — the plan's expected hash is never stamped onto an
    unverified source."""
    key: StageContextKey = (plan_sha256, session_id, compute_id, checkpoint_id)
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

