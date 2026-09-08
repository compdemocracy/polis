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

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema": self.schema, "profile": self.profile,
            "field_policy_sha256": self.field_policy_sha256,
            "approvals": list(self.approvals),
            "replacement_assertions": list(self.replacement_assertions),
            "required_controls": list(self.required_controls),
            "clock": self.clock, "raw_sha256": self.raw_sha256,
        }


def load_policy(path: str | Path) -> Policy:
    """Load and validate a closed ``p045-policy/1`` file. It is NEVER derived
    from observed errors; a wrong schema/profile or a missing required field is a
    hard configuration failure, not a downgrade."""
    p = Path(path)
    raw = p.read_bytes()
    try:
        obj = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise BridgeError("policy", f"policy is not valid JSON: {exc}") from exc
    if not isinstance(obj, dict):
        raise BridgeError("policy", "policy must be a JSON object")
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
    if not isinstance(obj["field_policy_sha256"], str) or len(obj["field_policy_sha256"]) != 64:
        raise BridgeError("policy", "policy.field_policy_sha256 must be a 64-hex sha256")
    return Policy(
        schema=POLICY_SCHEMA, profile=profile,
        field_policy_sha256=obj["field_policy_sha256"],
        approvals=tuple(obj["approvals"]),
        replacement_assertions=tuple(obj["replacement_assertions"]),
        required_controls=tuple(obj["required_controls"]),
        clock=obj["clock"],
        raw_sha256=hashlib.sha256(raw).hexdigest(),
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
