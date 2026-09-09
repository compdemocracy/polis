"""Certification battery runner — Clojure<->Python math parity (SPEC A).

The replay harness (schedule.py/driver.py/store.py/stepcompare.py, Phase H-A)
and the Clojure cross-language bridge (crosslang.py, Phase H-B) already let a
human run ONE (dataset, schedule) replay through both engines and diff the
result. This module turns that into a repeatable, cheap-to-re-run BATTERY:

- A committed battery config (``scripts/certify_battery.json``) declares which
  (dataset, schedule) pairs to certify. Since the mode collapse (2026-07-27)
  the engine has exactly ONE code path — Clojure-exact legacy semantics — so
  the battery needs no per-entry mode; schedule ids keep their historical
  ``-clojure-legacy`` suffix so recordings and ledger keys stay valid.
- Both engines' recordings are CACHED on disk, keyed by content hashes (votes
  CSV, resolved schedule, and — for Python — the ``polismath`` source tree, or
  — for Clojure — ``dev/replay.clj`` + the ``math/src`` tree). Re-running
  certify after an unrelated code change should cost near-zero: cache hits
  short-circuit the (slow) driver subprocess entirely.
- Comparison is HASH-FIRST: each step's post-acceptance-projection blob is
  content-hashed per engine; equal hashes mean an exact MATCH with zero
  diffing. Only a hash MISMATCH falls back to the (cached, by hash-pair) full
  :class:`~polismath.replay.stepcompare.StepComparer` run.
- Acceptance projection is the prep-main 23-key whitelist (crosslang.py) MINUS
  the dead ``subgroup-*`` trio (subgroup-clusters/subgroup-votes/subgroup-repness
  — see CLOJURE_QUIRKS.md Q7). This is never silent: every certify run prints
  :data:`ACCEPTANCE_NOTICE`.
- Every divergence is FINGERPRINTED (index/step-stripped path pattern + family
  + frozen legacy suffix -> 10 hex chars) and tracked in a committed ledger
  (``docs/divergences.json``) so recurring, already-diagnosed divergences are
  annotated instead of re-discovered cold every run.

Design note — the clj cache is scoped PER (dataset, schedule_id) directory
(as literally specified), not globally content-addressed across schedules
with identical cuts.
"""

from __future__ import annotations

import functools
import hashlib
import json
import math
import os
import re
import subprocess
import threading
import uuid
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from polismath.replay import real_data
from polismath.replay import schedule as sched
from polismath.replay import store as st
from polismath.replay.crosslang import (
    PREP_MAIN_KEYS,
    _kebab,
    canonicalize_blob,
    load_clj_blobs,
    project_prep_main,
)
from polismath.replay.polarity import (
    DEFAULT_CONVENTIONS,
    ConventionDescriptor,
    run_standing_property,
)
from polismath.replay.stepcompare import DEFAULT_TOLERANT_STAT_KEYS, StepComparer
from polismath.replay.types import ReplayDataset
from polismath.utils.output_profile import (
    OUTPUT_PROFILE_KEY,
    has_marker,
    marker_problems,
)

#: Frozen schedule-id suffix + fingerprint component. Battery schedule ids
#: and ledger fingerprint keys were minted while the engine still had a mode
#: flag; this literal keeps recording directories and the historical
#: divergences.json keys stable across the mode collapse (2026-07-27).
_LEGACY_SUFFIX = "clojure-legacy"

# ---------------------------------------------------------------------------
# Paths.
# ---------------------------------------------------------------------------
# certify.py -> replay -> polismath -> delphi -> repo root (mirrors store.py).
_DELPHI_ROOT = Path(__file__).resolve().parents[2]
_REPO_ROOT = _DELPHI_ROOT.parents[0]
_MATH_ROOT = _REPO_ROOT / "math"

DEFAULT_BATTERY_PATH = _DELPHI_ROOT / "scripts" / "certify_battery.json"


def default_ledger_path() -> Path:
    return _DELPHI_ROOT / "docs" / "divergences.json"


# ---------------------------------------------------------------------------
# Acceptance projection: prep-main whitelist MINUS the dead subgroup-* trio.
# ---------------------------------------------------------------------------
ACCEPTANCE_EXCLUDED_KEYS = frozenset({"subgroup-clusters", "subgroup-votes", "subgroup-repness"})
ACCEPTANCE_KEYS = PREP_MAIN_KEYS - ACCEPTANCE_EXCLUDED_KEYS
ACCEPTANCE_NOTICE = (
    "subgroup-* keys excluded from acceptance (CLOJURE_QUIRKS.md Q7); "
    "large-conv mini-batch PCA disabled in the clj driver — full-PCA path "
    "certified at every size (Q10)"
)


def project_acceptance(blob: dict[str, Any]) -> dict[str, Any]:
    """Project a math_main blob onto :data:`ACCEPTANCE_KEYS` (kebab-canonical).

    Reuses :func:`polismath.replay.crosslang.project_prep_main` for the
    snake/kebab canonicalisation, drops the dead subgroup-* trio, then
    order-canonicalizes via :func:`polismath.replay.crosslang.canonicalize_blob`
    so cross-engine-arbitrary array orderings (Clojure hash order vs Python
    sorted) neither diverge in the comparer nor break the hash-first shortcut.
    """
    proj = project_prep_main(blob)
    return canonicalize_blob(
        {k: v for k, v in proj.items() if k not in ACCEPTANCE_EXCLUDED_KEYS}
    )


# ---------------------------------------------------------------------------
# Raw checkpoint validation (P-022 B1 review, P1).
# ---------------------------------------------------------------------------
# A NONEMPTY acceptance projection is not a valid checkpoint. `json.dumps`
# round-trips NaN/Infinity by default (allow_nan=True), and
# :func:`compare_recording_pair` short-circuits equal per-engine hashes to
# MATCH *before* anything inspects the values — so two producers emitting the
# SAME malformed blob (``{"n": NaN}``, ``{"n": "invalid-count"}``) certified
# PASS with strict exit 0. Correct cursor metadata and valid file hashes do not
# make the payload valid.
#
# Every checkpoint of BOTH engines is now validated RAW — before projection,
# before hashing, before any cached step verdict, and on recording-cache hits
# too — so a malformed value fails its entry regardless of what the other
# engine emitted, and the reason names the offending field.
#
# Deliberately NOT a full schema: the versioned per-field B/G blob schema is a
# later slice. Key names come from crosslang's ``PREP_MAIN_KEYS`` whitelist
# (the single source of truth for prep-main spelling); this layer pins only
# presence, integrality, finiteness and container/ID types.

#: Required on every checkpoint whose cut slot is nonzero. The ZERO checkpoint
#: is deliberately excluded: the engines' empty-compute representations are not
#: reconciled (Clojure omits n/n-cmts/tids/in-conv where Python emits their
#: empty values) and that checkpoint is governed by the schedule's declared
#: ``empty_output`` contract instead — see validate_recording_inventory.
_REQUIRED_CHECKPOINT_KEYS: tuple[str, ...] = ("n", "n-cmts", "tids", "in-conv")

#: Integer-valued (never float, never bool, never a numeric string) and >= 0.
_COUNT_CHECKPOINT_KEYS: tuple[str, ...] = ("n", "n-cmts")

#: Epoch-millisecond stamps: integral or null.
_TIMESTAMP_CHECKPOINT_KEYS: tuple[str, ...] = ("lastVoteTimestamp", "lastModTimestamp")

#: Lists of integral ids. ``tids``/``in-conv`` are always emitted as lists;
#: the set-semantic trio is nullable on both engines (see the committed
#: real_data cold-start blobs, where mod-in/mod-out/meta-tids are null).
_ID_LIST_CHECKPOINT_KEYS: tuple[str, ...] = ("tids", "in-conv", "mod-in", "mod-out", "meta-tids")
_NULLABLE_CHECKPOINT_KEYS: frozenset[str] = frozenset(
    {"mod-in", "mod-out", "meta-tids", "lastVoteTimestamp", "lastModTimestamp"}
)

#: Object-valued containers (JSON objects on both engines).
_MAPPING_CHECKPOINT_KEYS: tuple[str, ...] = (
    "pca", "base-clusters", "repness", "consensus", "group-votes", "votes-base",
    "user-vote-counts", "comment-priorities", "group-aware-consensus",
)

#: Array-valued containers.
_SEQUENCE_CHECKPOINT_KEYS: tuple[str, ...] = ("group-clusters",)

#: ``zid`` is an identifier, not a number to compute with: int or str, never a
#: float/container. (The battery's synthetic fixtures use string zids.)
_ID_SCALAR_CHECKPOINT_KEYS: tuple[str, ...] = ("zid",)

# Every name above must be a real prep-main key: no ad-hoc field invented here
# can drift away from the canonicalization whitelist.
assert set(
    _REQUIRED_CHECKPOINT_KEYS + _COUNT_CHECKPOINT_KEYS + _TIMESTAMP_CHECKPOINT_KEYS
    + _ID_LIST_CHECKPOINT_KEYS + _MAPPING_CHECKPOINT_KEYS + _SEQUENCE_CHECKPOINT_KEYS
    + _ID_SCALAR_CHECKPOINT_KEYS
) <= PREP_MAIN_KEYS, "checkpoint contract names a key prep-main does not emit"


def _is_integral(value: Any) -> bool:
    """True for a JSON integer. ``bool`` is a Python int but not a count, and a
    float (even 3.0) is not how either engine spells an integral field."""
    return type(value) is int


#: The versioned alias policy (P-022 B1 review round 3; role rule corrected in
#: P-022 alias-twin-real-driver). ``_kebab`` maps a raw snake key onto its kebab
#: spelling, so two DISTINCT raw keys can normalize to the same canonical name.
#: Collapsing them into one dict silently drops one of the two values — and the
#: dropped one never reaches the type/finiteness checks below, which is how
#: ``{"n_cmts": "invalid-count", "n-cmts": 1}`` and ``{"hidden_value": NaN,
#: "hidden-value": 0}`` certified PASS. Alias collisions are therefore rejected,
#: with ONE declared exception, spelled out in :data:`_DECLARED_ALIAS_FIELDS`.
#:
#: v1 admitted that exception only while the two spellings carried DEEPLY EQUAL
#: values, on the premise that ``Conversation.to_dict`` emits both from one
#: value. That premise holds only for the pre-legacy-shape dict
#: (conversation/conversation.py:2229-2233): ``_apply_legacy_blob_shape``
#: (conversation/conversation.py:1781, called unconditionally at :2469) then
#: OVERWRITES the kebab key with Clojure's folded form — members are
#: BASE-CLUSTER ids and centers carry Clojure's sign — while the snake key keeps
#: Python's unfolded view (members are PARTICIPANT ids, Delphi's sign), the view
#: ``tests/test_serialization_unfolding.py`` pins. So the twins are DIFFERENT BY
#: CONSTRUCTION in every blob the real Python driver emits, and v1 failed all of
#: them at ``checkpoint-schema`` — invisible in CI, where the Clojure
#: integration battery is off.
#:
#: v2 keeps the property B1 was actually protecting — no raw value may escape
#: validation by losing the canonical collapse — and drops the false
#: equal-values premise, exactly as the engine contract provides for
#: (P-022-G-engine-contract rev4, "External canonicalization and comparison":
#: *conflicting snake/kebab aliases fail unless the schema defines the two as
#: distinct fields with distinct roles*). The two roles and the mechanical
#: relation between them are pinned here, in :data:`_DECLARED_ALIAS_FIELDS` and
#: :func:`_check_declared_alias_pair`, and BOTH raw views are validated against
#: the raw schema before projection — so nothing escapes validation by losing
#: the canonical collapse. Anything else — an undeclared pair, a declared pair
#: that fails the schema or the relation, a three-way collision — fails naming
#: every raw spelling involved. When the legacy twin is finally dropped, delete
#: the entry and this policy becomes "no collisions at all".
#:
#: v2 round 2 (P-022 alias-twin review, F1/F2). Equal group ``id`` lists
#: plus a prose role label are NOT the schema the contract asks for: a producer
#: could still ship ``group_clusters`` entries with ``members="not-members"``,
#: no ``center``, ``id=False`` beside a canonical ``id=0`` (``False == 0`` in
#: Python), or well-typed but WRONG participant lists / un-flipped centers, and
#: certify returned PASS with strict exit 0. Both views now go through
#: :func:`_validate_group_cluster_view` (required fields, strict-int ids
#: excluding bool, unique ids, integer member lists, finite 2-vector centers)
#: and then through the producer's own relation: the unfolded members are the
#: concatenation of the folded members' base-cluster member lists, in group and
#: member order, and the unfolded centers are the exact sign negation of the
#: folded ones. The relation is a deterministic serialization transform
#: (``_unfolded_group_clusters`` at conversation/conversation.py:1042-1059 and
#: the negation at :1781), so it is checked EXACTLY — no numeric tolerance.
_ALIAS_POLICY_VERSION = "v2"

#: The pinned geometry width of a group-cluster ``center`` in the legacy blob:
#: the 2-D projection plane, the same plane ``base-clusters`` spells as x/y
#: columns. Every committed oracle and both engines emit exactly two
#: coordinates.
_GROUP_CENTER_DIM = 2

#: Canonical key -> (the ONE extra raw spelling admitted alongside it, the role
#: that makes the two distinct fields rather than a lossy duplicate).
_DECLARED_ALIAS_FIELDS: dict[str, tuple[str, str]] = {
    "group-clusters": (
        "group_clusters",
        "Python-only unfolded view of the same groups (participant-id members, "
        "Delphi-sign centers) alongside the Clojure-parity folded view",
    ),
}
_ALIASED_CHECKPOINT_KEYS: frozenset[str] = frozenset(_DECLARED_ALIAS_FIELDS)


def _validate_group_cluster_view(value: Any, key: str, label: str) -> list[dict]:
    """Raw schema of ONE group-cluster array, canonical or aliased. Returns the
    validated groups; raises :class:`CertifyError` naming ``key`` and the
    offending index/field.

    Required per group: ``id`` (strict int, ``bool`` rejected — ``False == 0``
    would otherwise satisfy an id comparison against a real group 0), ``members``
    (array of strict ints) and ``center`` (array of exactly
    :data:`_GROUP_CENTER_DIM` finite reals). Group ids are unique and members are
    unique within a group. An empty array is a legitimate state (a conversation
    with no groups) and passes.
    """
    where = f"{label}: field {key!r}"
    if not isinstance(value, list):
        raise CertifyError(
            "checkpoint-schema",
            f"{where} must be a JSON array of group objects, got "
            f"{type(value).__name__}")
    groups: list[dict] = []
    seen_ids: set[Any] = set()
    for i, group in enumerate(value):
        if not isinstance(group, dict):
            raise CertifyError(
                "checkpoint-schema",
                f"{where}[{i}] must be a JSON object, got {type(group).__name__}")
        missing = [f for f in ("id", "members", "center") if f not in group]
        if missing:
            raise CertifyError(
                "checkpoint-schema",
                f"{where}[{i}] is missing required field(s) {missing}")
        gid = group["id"]
        if not _is_integral(gid):
            raise CertifyError(
                "checkpoint-schema",
                f"{where}[{i}].id must be an integer group id, got "
                f"{type(gid).__name__} {gid!r}")
        if gid in seen_ids:
            raise CertifyError(
                "checkpoint-schema",
                f"{where}[{i}].id {gid!r} is a duplicate group id")
        seen_ids.add(gid)
        members = group["members"]
        if not isinstance(members, list):
            raise CertifyError(
                "checkpoint-schema",
                f"{where}[{i}].members must be a JSON array of integer ids, got "
                f"{type(members).__name__}")
        for j, member in enumerate(members):
            if not _is_integral(member):
                raise CertifyError(
                    "checkpoint-schema",
                    f"{where}[{i}].members[{j}] must be an integer id, got "
                    f"{type(member).__name__} {member!r}")
        if len(set(members)) != len(members):
            raise CertifyError(
                "checkpoint-schema",
                f"{where}[{i}].members contains duplicate ids")
        center = group["center"]
        if not isinstance(center, list) or len(center) != _GROUP_CENTER_DIM:
            raise CertifyError(
                "checkpoint-schema",
                f"{where}[{i}].center must be an array of {_GROUP_CENTER_DIM} "
                f"finite numbers, got "
                f"{type(center).__name__}"
                f"{'' if not isinstance(center, list) else f' of length {len(center)}'}")
        for j, coord in enumerate(center):
            if isinstance(coord, bool) or not isinstance(coord, (int, float)):
                raise CertifyError(
                    "checkpoint-schema",
                    f"{where}[{i}].center[{j}] must be a finite number, got "
                    f"{type(coord).__name__} {coord!r}")
            if not math.isfinite(coord):
                raise CertifyError(
                    "checkpoint-schema",
                    f"{where}[{i}].center[{j}] must be finite, got {coord!r}")
        groups.append(group)
    return groups


def _bid_to_pids(blob: dict, label: str, where: str) -> dict[Any, list[Any]]:
    """The blob's base-cluster id -> ordered participant ids mapping, read from
    the columnar ``base-clusters`` the legacy blob emits (``_fold_base_clusters``:
    ``{'id': [...], 'members': [[pid, ...], ...], 'x': [...], 'y': [...],
    'count': [...]}``). Raises when it is absent or unusable, because without it
    the declared unfolding relation cannot be evaluated at all — and an
    unevaluated relation is exactly the hole this policy closes.

    The mapping is the relation's TRUSTED INPUT, so it is typed with exactly the
    same strictness as the two group views (review round 2, R2-F1). Left
    untyped, ``False == 0`` and ``0.0 == 0`` reappeared one level below the
    views — a folded member ``0`` resolved a base-cluster ``id`` of ``False`` or
    ``0.0``, and an unfolded participant ``0`` matched a mapped ``False``, so all
    three variants certified PASS with strict exit 0 — and an array-valued
    ``id`` raised an uncaught ``TypeError`` at dict membership instead of a
    ``checkpoint-schema`` failure. Every non-conforming shape is a named gate
    failure here; nothing escapes as an exception.
    """
    bc = _canonical_view(blob).get("base-clusters")
    if not isinstance(bc, dict) or not isinstance(bc.get("id"), list) \
            or not isinstance(bc.get("members"), list) \
            or len(bc["id"]) != len(bc["members"]):
        raise CertifyError(
            "checkpoint-schema",
            f"{where}: the declared alias relation needs the blob's columnar "
            f"'base-clusters' (id/members of equal length) to unfold "
            f"base-cluster ids to participant ids; got "
            f"{type(bc).__name__}")
    mapping: dict[Any, list[Any]] = {}
    seen_pids: dict[Any, Any] = {}
    for i, (bid, members) in enumerate(zip(bc["id"], bc["members"])):
        # Type BEFORE hashing: an unhashable (array/object) id would otherwise
        # raise TypeError, and a bool/float id would silently alias a real one.
        if not _is_integral(bid):
            raise CertifyError(
                "checkpoint-schema",
                f"{where}: 'base-clusters'.id[{i}] must be an integer "
                f"base-cluster id, got {type(bid).__name__} {bid!r}")
        if bid in mapping:
            raise CertifyError(
                "checkpoint-schema",
                f"{where}: 'base-clusters' declares base-cluster id {bid!r} twice, "
                f"so the unfolding relation is ambiguous")
        if not isinstance(members, list):
            raise CertifyError(
                "checkpoint-schema",
                f"{where}: 'base-clusters'.members for base-cluster id {bid!r} "
                f"must be a JSON array, got {type(members).__name__}")
        for j, pid in enumerate(members):
            if not _is_integral(pid):
                raise CertifyError(
                    "checkpoint-schema",
                    f"{where}: 'base-clusters'.members for base-cluster id "
                    f"{bid!r} element [{j}] must be an integer participant id, "
                    f"got {type(pid).__name__} {pid!r}")
            # A participant belongs to exactly one base cluster: the fold is a
            # partition (`_fold_base_clusters`). A pid in two clusters would
            # make the unfolding relation satisfiable by two different folded
            # member lists.
            if pid in seen_pids:
                raise CertifyError(
                    "checkpoint-schema",
                    f"{where}: 'base-clusters' places participant id {pid!r} in "
                    f"base clusters {seen_pids[pid]!r} and {bid!r}; the fold must "
                    f"be a partition for the unfolding relation to be well defined")
            seen_pids[pid] = bid
        mapping[bid] = list(members)
    return mapping


def _check_declared_alias_pair(
    blob: dict, canonical: str, aliased: str, role: str, label: str,
) -> None:
    """The ONE declared distinct-role pair. Both raw views go through the raw
    schema, then through the relation the serializer defines:

    - ``group_clusters[i].members`` is the concatenation of
      ``base-clusters.members[bid]`` for each ``bid`` in
      ``group-clusters[i].members``, in group order and member order
      (``Conversation._unfolded_group_clusters``);
    - ``group_clusters[i].center`` is the exact coordinate-wise negation of
      ``group-clusters[i].center`` (``_apply_legacy_blob_shape``).

    Both are deterministic serialization transforms of one internal value, so
    they are compared EXACTLY — widening a tolerance here would re-open the hole.
    """
    where = (f"{label}: raw keys {canonical!r}, {aliased!r} normalize to the "
             f"declared alias {canonical!r} ({role}) [alias policy "
             f"{_ALIAS_POLICY_VERSION}]")
    folded = _validate_group_cluster_view(blob[canonical], canonical, label)
    unfolded = _validate_group_cluster_view(blob[aliased], aliased, label)
    if len(folded) != len(unfolded):
        raise CertifyError(
            "checkpoint-schema",
            f"{where}: the two views describe a different number of groups "
            f"({len(folded)} vs {len(unfolded)})")
    if [g["id"] for g in folded] != [g["id"] for g in unfolded]:
        raise CertifyError(
            "checkpoint-schema",
            f"{where}: the two views do not describe the same groups: "
            f"{canonical!r} ids {[g['id'] for g in folded]!r}, "
            f"{aliased!r} ids {[g['id'] for g in unfolded]!r}")
    if not folded:
        return
    mapping = _bid_to_pids(blob, label, where)
    for f, u in zip(folded, unfolded):
        unknown = [b for b in f["members"] if b not in mapping]
        if unknown:
            raise CertifyError(
                "checkpoint-schema",
                f"{where}: group {f['id']!r} of {canonical!r} names base-cluster "
                f"id(s) {unknown!r} that 'base-clusters' does not declare, so the "
                f"unfolding relation cannot hold")
        expected: list[Any] = []
        for bid in f["members"]:
            expected.extend(mapping[bid])
        if u["members"] != expected:
            raise CertifyError(
                "checkpoint-schema",
                f"{where}: group {f['id']!r} of {aliased!r} is not the unfolding "
                f"of {canonical!r} through 'base-clusters' "
                f"({len(u['members'])} participant id(s), expected "
                f"{len(expected)}; first difference at index "
                f"{_first_difference(u['members'], expected)})")
        if u["center"] != [-c for c in f["center"]]:
            raise CertifyError(
                "checkpoint-schema",
                f"{where}: group {f['id']!r} of {aliased!r} has center "
                f"{u['center']!r}, which is not the exact sign negation of "
                f"{canonical!r}'s {f['center']!r}")


def _first_difference(a: list, b: list) -> Any:
    """Index of the first differing element of two lists, or their common
    length when one is a prefix of the other. Diagnostics only."""
    for i, (x, y) in enumerate(zip(a, b)):
        if x != y:
            return i
    return min(len(a), len(b))


def _canonical_view(blob: dict) -> dict[Any, Any]:
    """Canonical-name view of ``blob``. An exact kebab spelling wins over a
    declared snake alias — the SAME arbitration :func:`project_prep_main` uses
    (crosslang.py) — so the value validated under a canonical name is the value
    the cross-engine comparison actually reads. A plain
    ``{_kebab(k): v for ...}`` comprehension is last-writer-wins, which for the
    declared pair means whichever spelling ``to_dict`` happened to emit second.
    """
    canon: dict[Any, Any] = {}
    for k, v in blob.items():
        ck = _kebab(k)
        if ck not in canon or k == ck:
            canon[ck] = v
    return canon


def _raw_alias_groups(blob: dict) -> dict[Any, list[Any]]:
    """Canonical key -> the raw keys that normalize onto it, in blob order."""
    groups: dict[Any, list[Any]] = {}
    for k in blob:
        groups.setdefault(_kebab(k), []).append(k)
    return groups


def _check_alias_collisions(blob: dict, label: str) -> None:
    """Reject aliased raw keys BEFORE the canonical dict is built (see
    :data:`_ALIAS_POLICY_VERSION`). Snake-only and kebab-only blobs, which have
    no collision at all, are unaffected."""
    for canonical, raw_keys in _raw_alias_groups(blob).items():
        if len(raw_keys) == 1:
            continue
        spellings = ", ".join(repr(k) for k in raw_keys)
        quantifier = "both" if len(raw_keys) == 2 else "all"
        declared = _DECLARED_ALIAS_FIELDS.get(canonical)
        if declared is None or set(raw_keys) != {canonical, declared[0]}:
            raise CertifyError(
                "checkpoint-schema",
                f"{label}: raw keys {spellings} {quantifier} normalize to {canonical!r}; "
                f"alias collisions are rejected (alias policy "
                f"{_ALIAS_POLICY_VERSION}) — one value would be dropped before "
                f"validation")
        # Declared distinct-role pair: validate BOTH raw values here, so
        # neither escapes by losing the canonical collapse. The two views may
        # differ in member id-space and center sign — that IS the declared role
        # difference — but each must satisfy the raw group schema and the two
        # must satisfy the relation the serializer defines between them.
        _check_declared_alias_pair(blob, canonical, declared[0], declared[1], label)


def _find_nonfinite(value: Any, path: str) -> str | None:
    """Depth-first search for a NaN/Infinity float anywhere under ``value``,
    returning its dotted path (or ``None``). json.dumps' ``allow_nan`` default
    lets these round-trip through a recording file and hash equal on both
    engines, so nothing downstream would ever notice them."""
    if isinstance(value, float):
        return path if not math.isfinite(value) else None
    if isinstance(value, dict):
        for k, v in value.items():
            found = _find_nonfinite(v, f"{path}.{k}")
            if found is not None:
                return found
        return None
    if isinstance(value, (list, tuple)):
        for i, v in enumerate(value):
            found = _find_nonfinite(v, f"{path}[{i}]")
            if found is not None:
                return found
        return None
    return None


def validate_checkpoint_blob(
    blob: Any, label: str, *, require_keys: bool = True,
) -> None:
    """Raw validation of ONE checkpoint blob. Raises :class:`CertifyError`
    (stage ``checkpoint-schema``) naming the offending field.

    ``label`` identifies the checkpoint in the message (e.g. ``"clj: step-002"``).
    ``require_keys=False`` skips only the required-key presence check — used for
    the zero/empty checkpoint and for the standalone comparer, which has no cut
    metadata to tell an empty checkpoint from a truncated one. Type,
    alias-collision and finiteness checks always run.

    Not a full schema (see the module comment): presence, integrality,
    finiteness, container and ID types only.
    """
    if not isinstance(blob, dict):
        raise CertifyError(
            "checkpoint-schema",
            f"{label}: checkpoint blob must be a JSON object, got {type(blob).__name__}")

    # A PROJECTED comparison view is not a checkpoint (P-023 rev3, R3-1). It is
    # a legal kebab-only blob — no alias pair, so C9 never runs — and every
    # remaining field is well typed, so nothing below would object; recorded or
    # restored, it would silently lose the raw extensions (the group_clusters
    # twin, proj) that the restore path reads. The output-profile marker is the
    # only thing that distinguishes it, so it is refused here as well as at
    # Conversation.from_dict.
    # Presence, not validity: a malformed marker value is a corrupted projected
    # view, and treating it as unmarked raw data is how all four of
    # {null, false, "projected", []} walked straight through this gate (review
    # #2730 F2). The reserved key is refused whenever it appears.
    if has_marker(blob):
        marked = blob[OUTPUT_PROFILE_KEY]
        problems = marker_problems(marked)
        detail = ("; ".join(problems) if problems else
                  f"{marked.get('profile')!r}, vote_axis "
                  f"{marked.get('vote_axis')!r}")
        raise CertifyError(
            "checkpoint-schema",
            f"{label}: blob carries the reserved output-profile marker "
            f"{OUTPUT_PROFILE_KEY!r} ({detail}): a projected comparison view — "
            f"malformed or not — is never a raw checkpoint")

    # UNTOUCHED-RAW checks first, before any normalization (P-022 B1 review,
    # round 3). Building the canonical dict is lossy: aliased raw keys collapse
    # onto one entry and the loser's value escapes every check below, so both
    # the alias policy and the finiteness scan run against `blob` itself.
    _check_alias_collisions(blob, label)

    # json.dumps' allow_nan default lets NaN/Infinity round-trip through a
    # recording file and hash EQUAL on both engines, so nothing downstream would
    # ever notice them. Scanning the raw blob (not the canonical dict, not the
    # acceptance projection) means a non-finite under an unprojected or aliased
    # key still fails: the producer computed garbage either way.
    nonfinite = _find_nonfinite(blob, "")
    if nonfinite is not None:
        raise CertifyError(
            "checkpoint-schema",
            f"{label}: non-finite number (NaN/Infinity) at field '{nonfinite.lstrip('.')}'")

    # Collision-free by the check above: every canonical key has exactly one raw
    # value, or the ONE declared distinct-role pair whose two spellings were
    # both validated there. Each accepted field is type-checked through its
    # unique canonical identity, reading the same spelling the comparer does.
    canon = _canonical_view(blob)

    if require_keys:
        missing = [k for k in _REQUIRED_CHECKPOINT_KEYS if k not in canon]
        if missing:
            raise CertifyError(
                "checkpoint-schema",
                f"{label}: checkpoint blob is missing required field(s) {missing}")

    def present(keys: tuple[str, ...]):
        for k in keys:
            if k in canon:
                yield k, canon[k]

    for key, value in present(_COUNT_CHECKPOINT_KEYS):
        if not _is_integral(value) or value < 0:
            raise CertifyError(
                "checkpoint-schema",
                f"{label}: field {key!r} must be a non-negative integer, got "
                f"{type(value).__name__} {value!r}")

    for key, value in present(_TIMESTAMP_CHECKPOINT_KEYS):
        if value is None:
            continue
        if not _is_integral(value):
            raise CertifyError(
                "checkpoint-schema",
                f"{label}: field {key!r} must be an integer or null, got "
                f"{type(value).__name__} {value!r}")

    for key, value in present(_ID_LIST_CHECKPOINT_KEYS):
        if value is None and key in _NULLABLE_CHECKPOINT_KEYS:
            continue
        if not isinstance(value, list):
            raise CertifyError(
                "checkpoint-schema",
                f"{label}: field {key!r} must be an array of integer ids, got "
                f"{type(value).__name__}")
        for i, element in enumerate(value):
            if not _is_integral(element):
                raise CertifyError(
                    "checkpoint-schema",
                    f"{label}: field {key!r}[{i}] must be an integer id, got "
                    f"{type(element).__name__} {element!r}")

    for key, value in present(_MAPPING_CHECKPOINT_KEYS):
        if not isinstance(value, dict):
            raise CertifyError(
                "checkpoint-schema",
                f"{label}: field {key!r} must be a JSON object, got "
                f"{type(value).__name__}")

    for key, value in present(_SEQUENCE_CHECKPOINT_KEYS):
        if not isinstance(value, list):
            raise CertifyError(
                "checkpoint-schema",
                f"{label}: field {key!r} must be a JSON array, got "
                f"{type(value).__name__}")

    for key, value in present(_ID_SCALAR_CHECKPOINT_KEYS):
        if not (_is_integral(value) or isinstance(value, str)):
            raise CertifyError(
                "checkpoint-schema",
                f"{label}: field {key!r} must be an integer or string id, got "
                f"{type(value).__name__} {value!r}")


def _acceptance_projecting_comparer(**kwargs: Any) -> StepComparer:
    """A :class:`StepComparer` that projects both blobs onto acceptance keys
    before diffing — the comparer used for the (cached) hash-mismatch path."""
    tolerant = frozenset(_kebab(k) for k in DEFAULT_TOLERANT_STAT_KEYS) - ACCEPTANCE_EXCLUDED_KEYS

    class _AcceptanceProjectingComparer(StepComparer):
        def compare_step(self, blob_a: dict, blob_b: dict, index: int) -> dict[str, Any]:
            return super().compare_step(
                project_acceptance(blob_a), project_acceptance(blob_b), index
            )

    return _AcceptanceProjectingComparer(tolerant_stat_keys=tolerant, **kwargs)


# ---------------------------------------------------------------------------
# Battery config: parsing + collision-free schedule-id derivation.
# ---------------------------------------------------------------------------
_NCUTS_PRESETS = frozenset({"uniform", "front-loaded", "back-loaded"})
_VALID_PRESETS = _NCUTS_PRESETS | frozenset({"single-cut", "every-vote", "per-day"})


@dataclass(frozen=True)
class BatteryEntry:
    """One parsed ``certify_battery.json`` entry (either preset- or
    schedule-file-based), with its collision-free ``schedule_id`` already
    resolved (see :func:`derive_schedule_id`)."""

    dataset: str
    schedule_id: str
    preset: str | None = None
    n_cuts: int | None = None
    schedule_path: Path | None = None
    notes: str = ""
    optional: bool = False
    role: str | None = None


def derive_schedule_id(
    *, preset: str | None = None, n_cuts: int | None = None,
    base_schedule_id: str | None = None,
) -> str:
    """Collision-free schedule id: ``{base}-clojure-legacy``
    (:data:`_LEGACY_SUFFIX` — historical, keeps recording dirs stable).

    ``base`` is either an explicit ``base_schedule_id`` (schedule-file-based
    entries — the id the file itself declares) or ``{preset}{n_cuts}`` for
    presets that take a cut count (``uniform8``, ``front-loaded6``, …) or bare
    ``preset`` for those that don't (``single-cut``, ``every-vote``, ``per-day``).
    Distinct (preset, n_cuts) pairs always yield distinct ids because the
    preset name is embedded verbatim in ``base``.
    """
    if base_schedule_id is not None:
        base = base_schedule_id
    elif preset in _NCUTS_PRESETS:
        if n_cuts is None:
            raise ValueError(f"preset {preset!r} requires n_cuts to derive a schedule_id")
        base = f"{preset}{n_cuts}"
    else:
        base = preset
    return f"{base}-{_LEGACY_SUFFIX}"


def parse_battery_entry(e: dict[str, Any], *, battery_dir: Path | None = None) -> BatteryEntry:
    """Parse one battery entry — either ``{"schedule": "<path>"}`` (base id
    read verbatim from the referenced schedule.json) or ``{"preset": ...,
    "n_cuts": ...}``."""
    if not isinstance(e, dict):
        raise ValueError("battery entries must be objects")
    unknown = set(e) - {"dataset", "schedule", "preset", "n_cuts", "notes", "optional", "role"}
    if unknown:
        raise ValueError(f"unknown battery fields: {sorted(unknown)}")
    dataset = e["dataset"]
    st._safe_path_component(dataset, label="dataset")
    if type(e.get("optional", False)) is not bool:
        raise ValueError("optional must be boolean")
    if "schedule" in e and "preset" in e:
        raise ValueError("declare schedule or preset, not both")
    extra = {"optional": e.get("optional", False), "role": e.get("role")}

    if "schedule" in e:
        schedule_path = Path(e["schedule"])
        if battery_dir is not None and not schedule_path.is_absolute():
            schedule_path = battery_dir / schedule_path
        schedule_json = json.loads(schedule_path.read_text())
        schedule_dataset = schedule_json.get("dataset")
        if schedule_dataset is not None and schedule_dataset != dataset:
            raise ValueError(
                f"battery entry dataset {dataset!r} does not match schedule file "
                f"{schedule_path}'s dataset {schedule_dataset!r} — drivers and certify "
                f"would disagree on which dataset's votes to replay/cache"
            )
        base_id = schedule_json["schedule_id"]
        schedule_id = derive_schedule_id(base_schedule_id=base_id)
        return BatteryEntry(dataset=dataset, schedule_id=schedule_id,
                             schedule_path=schedule_path, notes=e.get("notes", ""), **extra)

    preset = e.get("preset")
    if preset not in _VALID_PRESETS:
        raise ValueError(
            f"unknown preset {preset!r} in battery entry {e!r}; expected one of "
            f"{sorted(_VALID_PRESETS)}"
        )
    n_cuts = e.get("n_cuts")
    if preset in _NCUTS_PRESETS and n_cuts is None:
        raise ValueError(f"preset {preset!r} requires n_cuts in battery entry {e!r}")
    if n_cuts is not None and (type(n_cuts) is not int or n_cuts <= 0):
        raise ValueError("n_cuts must be a positive integer")
    schedule_id = derive_schedule_id(preset=preset, n_cuts=n_cuts)
    return BatteryEntry(dataset=dataset, schedule_id=schedule_id,
                         preset=preset, n_cuts=n_cuts, notes=e.get("notes", ""), **extra)


def load_battery(path: str | Path = DEFAULT_BATTERY_PATH) -> list[BatteryEntry]:
    path = Path(path)
    data = json.loads(path.read_text())
    if not isinstance(data, list) or not data:
        raise ValueError("battery must be a nonempty list")
    return [parse_battery_entry(e, battery_dir=path.parent) for e in data]


# ---------------------------------------------------------------------------
# Dataset availability + effective schedule construction.
# ---------------------------------------------------------------------------
def dataset_available(dataset: str) -> bool:
    return real_data.dataset_dir(dataset) is not None


def votes_csv_path(dataset: str) -> Path | None:
    d = real_data.dataset_dir(dataset)
    if d is None:
        return None
    hits = sorted(d.glob("*-votes.csv"))
    return hits[0] if hits else None


def comments_csv_path(dataset: str) -> Path | None:
    """Locate a dataset's comments CSV the same way :func:`votes_csv_path`
    locates its votes CSV. ``None`` when the dataset (or its comments CSV)
    isn't there — moderation-interleaving datasets have one, but not every
    dataset does (MOD_RESTART_PORT_SPEC.md "Python ports" item 5)."""
    d = real_data.dataset_dir(dataset)
    if d is None:
        return None
    hits = sorted(d.glob("*-comments.csv"))
    return hits[0] if hits else None


def _spec_from_preset(entry: BatteryEntry, ds: ReplayDataset) -> sched.ScheduleSpec:
    n = ds.n
    if entry.preset == "uniform":
        return sched.preset_uniform(entry.dataset, n, n_cuts=entry.n_cuts)
    if entry.preset == "front-loaded":
        return sched.preset_front_loaded(entry.dataset, n, n_cuts=entry.n_cuts)
    if entry.preset == "back-loaded":
        return sched.preset_back_loaded(entry.dataset, n, n_cuts=entry.n_cuts)
    if entry.preset == "every-vote":
        return sched.preset_every_vote(entry.dataset, n)
    if entry.preset == "single-cut":
        return sched.preset_single_cut(entry.dataset, n)
    if entry.preset == "per-day":
        return sched.preset_per_day(entry.dataset, ds)
    raise ValueError(f"unknown preset {entry.preset!r}")


def build_effective_spec(entry: BatteryEntry, ds: ReplayDataset) -> sched.ScheduleSpec:
    """The :class:`ScheduleSpec` actually run, with ``schedule_id`` overridden
    to ``entry.schedule_id`` (the collision-free suffixed id) so the
    recording lands in the right directory regardless of preset or file origin.
    """
    base = (sched.ScheduleSpec.from_json_file(entry.schedule_path) if entry.schedule_path
            else _spec_from_preset(entry, ds))
    d = base.to_dict()
    d["schedule_id"] = entry.schedule_id
    return sched.ScheduleSpec.from_dict(d)


# ---------------------------------------------------------------------------
# Hashing helpers.
# ---------------------------------------------------------------------------
def sha256_file(path: str | Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def sha256_tree(root: str | Path, pattern: str = "**/*", *,
                exclude: tuple[str, ...] = ()) -> str:
    """sha256 over sorted (relpath, content) pairs of every FILE matching
    ``pattern`` under ``root`` — deterministic regardless of filesystem
    iteration order, sensitive to both a file's path and its content.

    ``exclude`` entries are posix relpaths under ``root``: a trailing ``/``
    excludes that whole subtree, otherwise the exact file is excluded."""
    root = Path(root)
    h = hashlib.sha256()
    for p in sorted(root.glob(pattern)):
        if not p.is_file():
            continue
        rel = p.relative_to(root).as_posix()
        if any(rel == e or (e.endswith("/") and rel.startswith(e)) for e in exclude):
            continue
        h.update(rel.encode())
        h.update(b"\0")
        h.update(p.read_bytes())
        h.update(b"\0")
    return h.hexdigest()


def _canonical_json(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), default=str)


def _canonical_hash(obj: Any) -> str:
    return hashlib.sha256(_canonical_json(obj).encode()).hexdigest()


def canonical_schedule_hash(spec: sched.ScheduleSpec) -> str:
    """Hash of the parts of a schedule that affect the REPLAY — deliberately
    excludes ``schedule_id``/``notes`` (descriptive metadata) so two
    differently-named but content-identical schedules hash equal.

    M3 (P-019): this MUST include EVERY execution-affecting field, not just
    cuts/moderation/source. ``restart_after`` controls the restart seam
    (schedule.py: after that step the driver rebuilds the conversation the way a
    Clojure worker restart would) and ``clojure`` carries warm-start options that
    steer the Clojure reference run. Omitting them let a schedule edited from
    "no restart" to "restart" under the SAME schedule_id reuse both stale
    recordings and report their old MATCH. ``getattr`` defaults keep the hash
    robust to specs that predate a field."""
    payload = {
        "cuts": spec.cuts,
        "moderation": spec.moderation,
        "source": spec.source,
        "restart_after": getattr(spec, "restart_after", None),
        "clojure": getattr(spec, "clojure", None),
        "coverage": spec.coverage,
        "empty_output": spec.empty_output,
    }
    return _canonical_hash(payload)


def _comparer_code_hash() -> str:
    """Hash of the comparison-logic SOURCE files. Folded into the verdict
    cache key so a bugfix to the comparer (with unchanged tolerances) busts
    cached step verdicts instead of silently serving stale MATCH/DIVERGENCE
    results — for a certification tool a stale MATCH is the worst failure
    mode. (Review finding, 2026-07-22.)"""
    import polismath.regression.comparer as _comparer_mod
    from polismath.replay import crosslang as _crosslang_mod
    from polismath.replay import stepcompare as _stepcompare_mod

    h = hashlib.sha256()
    for mod in (_stepcompare_mod, _crosslang_mod, _comparer_mod):
        h.update(Path(mod.__file__).read_bytes())
    h.update(Path(__file__).read_bytes())
    return h.hexdigest()


def _comparer_cfg_hash(cmp: StepComparer) -> str:
    cfg = {
        "abs_tol": cmp._cmp.abs_tol,
        "rel_tol": cmp._cmp.rel_tol,
        "ignore_pca_sign_flip": cmp._cmp.ignore_pca_sign_flip,
        "outlier_fraction": cmp._cmp.outlier_fraction,
        "tolerant_keys": sorted(cmp._tolerant_keys),
        "code": _comparer_code_hash(),
    }
    return _canonical_hash(cfg)


# ---------------------------------------------------------------------------
# Fingerprints.
# ---------------------------------------------------------------------------
_STEP_PREFIX_RE = re.compile(r"^step_\d+\.")
_BRACKET_IDX_RE = re.compile(r"\[\d+\]")


def normalize_path(path: str) -> str:
    """Strip the ``step_N.`` prefix, collapse bracket indices to ``[]``, and
    collapse purely-numeric dotted segments (dict keys, e.g. a tid) to ``N`` —
    so two divergences at the same structural location (different step,
    different list index, different dict key) fingerprint identically.

    ``step_3.pca.comps[0][1]`` -> ``pca.comps[][]`` (spec example, verbatim).
    """
    p = _STEP_PREFIX_RE.sub("", path or "")
    p = _BRACKET_IDX_RE.sub("[]", p)
    parts = ["N" if part.isdigit() else part for part in p.split(".")]
    return ".".join(parts)


def _fp_from_normalized(norm_path: str, family: str) -> str:
    # _LEGACY_SUFFIX is baked into the digest so every historical
    # divergences.json key stays valid across the mode collapse.
    digest = hashlib.sha1(f"{norm_path}|{family}|{_LEGACY_SUFFIX}".encode()).hexdigest()
    return digest[:10]


def compute_fingerprint(path: str, family: str) -> str:
    return _fp_from_normalized(normalize_path(path), family)


def fingerprint_key_for(path_pattern: str, family: str) -> str:
    """Ledger key for an ALREADY-normalized path pattern."""
    return f"FP-{_fp_from_normalized(path_pattern, family)}"


def fingerprint_key(path: str, family: str) -> str:
    return fingerprint_key_for(normalize_path(path), family)


def _abbrev(value: Any) -> Any:
    """Abbreviate a float to a short string; pass through everything else."""
    if isinstance(value, float):
        return f"{value:.6g}"
    return value


# ---------------------------------------------------------------------------
# Ledger (docs/divergences.json).
# ---------------------------------------------------------------------------
def load_ledger(path: str | Path | None = None) -> dict[str, Any]:
    path = Path(path) if path is not None else default_ledger_path()
    if not path.exists():
        return {}
    return json.loads(path.read_text())


def save_ledger(ledger: dict[str, Any], path: str | Path | None = None) -> None:
    path = Path(path) if path is not None else default_ledger_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as fh:
        json.dump(ledger, fh, indent=2, sort_keys=True)
        fh.write("\n")


def update_ledger(ledger: dict[str, Any], observations: list[dict[str, Any]]) -> dict[str, Any]:
    """Append fingerprints newly observed in ``observations`` as
    ``status=open``. NEVER overwrites an existing entry — a human-entered
    ``diagnosis``/``status`` on a known fingerprint is always preserved.

    Each observation: ``{"path_pattern", "family", "dataset",
    "schedule_id", "step"}`` (``path_pattern`` already normalized).
    (Historical ledger entries carry a mode field from before the collapse;
    it is preserved on disk and simply no longer written for new entries.)
    """
    updated = dict(ledger)
    for obs in observations:
        key = fingerprint_key_for(obs["path_pattern"], obs["family"])
        if key in updated:
            continue
        updated[key] = {
            "path_pattern": obs["path_pattern"],
            "family": obs["family"],
            "first_seen": {"dataset": obs["dataset"], "schedule": obs["schedule_id"],
                            "step": obs["step"]},
            "status": "open",
            "diagnosis": None,
        }
    return updated


def annotate_by_key(ledger: dict[str, Any], key: str) -> str | None:
    entry = ledger.get(key)
    if entry is None:
        return None
    diagnosis = entry.get("diagnosis")
    if diagnosis:
        return f"[known {key}: {diagnosis[:60]}]"
    return f"[known {key}: status={entry.get('status', 'open')}]"


# ---------------------------------------------------------------------------
# Subprocess drivers — `_run_subprocess` is the single mockable seam; tests
# NEVER invoke real clojure or the real py driver (monkeypatch this).
# ---------------------------------------------------------------------------
class CertifyError(RuntimeError):
    """A battery entry failed at a specific stage (driver subprocess, setup)."""

    def __init__(self, stage: str, message: str):
        super().__init__(message)
        self.stage = stage


# Generous ceilings — driver runs are ~10s (clj, JVM-startup-bound) to a few
# minutes (py warm-start chains); these exist so a hung JVM or Python driver
# fails the ENTRY instead of blocking an unattended battery run forever.
# (Review finding, 2026-07-22.)
DRIVER_TIMEOUT_SEC = 3600.0


def _run_subprocess(cmd: list[str], *, cwd: Path, env: dict[str, str],
                    timeout: float = DRIVER_TIMEOUT_SEC) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, cwd=str(cwd), env=env, capture_output=True,
                          text=True, timeout=timeout)


def run_py_driver(spec_path: Path, *, out_root: Path) -> subprocess.CompletedProcess:
    """Runs ``scripts/replay_driver.py run --schedule <spec_path> --out
    <out_root>`` in a SUBPROCESS (cwd=delphi/) with ``OMP_NUM_THREADS`` /
    ``OPENBLAS_NUM_THREADS`` pinned to 1."""
    env = dict(os.environ)
    env["OMP_NUM_THREADS"] = "1"
    env["OPENBLAS_NUM_THREADS"] = "1"
    cmd = ["uv", "run", "python", "scripts/replay_driver.py", "run",
           "--schedule", str(spec_path), "--out", str(out_root)]
    try:
        return _run_subprocess(cmd, cwd=_DELPHI_ROOT, env=env)
    except OSError as exc:
        raise CertifyError("py-driver-launch", str(exc)) from exc


def run_clj_driver(
    spec_path: Path, votes_csv: Path, *, out_dir: Path, comments_csv: Path | None = None,
) -> subprocess.CompletedProcess:
    """Runs ``clojure -M:replay --schedule <spec_path> --votes <votes_csv>
    --out <out_dir>`` in a SUBPROCESS with cwd=math/ (dev/replay.clj:57).

    ``comments_csv`` adds ``--comments <comments_csv>`` — the clj driver's
    moderation-interleave source (MOD_RESTART_PORT_SPEC.md "Python ports"
    item 5). Omitted (``None``, the default) for every schedule that doesn't
    request moderation interleaving, so existing recordings' invocation is
    byte-for-byte unchanged."""
    cmd = ["clojure", "-M:replay", "--schedule", str(spec_path), "--votes", str(votes_csv),
           "--out", str(out_dir)]
    if comments_csv is not None:
        cmd += ["--comments", str(comments_csv)]
    try:
        return _run_subprocess(cmd, cwd=_MATH_ROOT, env=dict(os.environ))
    except OSError as exc:
        raise CertifyError("clj-driver-launch", str(exc)) from exc


# Reject anything that would make the (dataset, schedule_id) -> path mapping
# ambiguous or let it escape the scratch directory. "/" is the one delimiter
# that cannot appear in either component, which is exactly what makes the
# nested layout in _write_temp_schedule injective — so it must be rejected,
# along with the platform separator, traversal and empty/dot names.
def _validate_path_component(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value:
        raise CertifyError("schedule-path",
                           f"{field} must be a nonempty string, got {value!r}")
    if value in (".", "..") or "/" in value or os.sep in value or "\0" in value:
        raise CertifyError("schedule-path",
                           f"{field} must not contain a path separator or traversal: {value!r}")
    return value


def _write_temp_schedule(spec: sched.ScheduleSpec, root: Path) -> Path:
    """Write ``spec`` (with its final, collision-free schedule_id already
    baked in) to a scratch file used purely as the driver CLI's ``--schedule``
    input.

    The path is UNAMBIGUOUS in (dataset, schedule_id). The previous
    ``f"{dataset}__{schedule_id}.json"`` flattening was not: the valid pairs
    ``("synthetic__a", "b-clojure-legacy")`` and ``("synthetic", "a__b-clojure-legacy")``
    produced the same filename, so whichever entry wrote second silently handed
    the OTHER entry's schedule to a producer (P-022 B1 review, P2). Distinct
    recording directories do not isolate this shared input file.

    Both components are validated to contain no path separator, so ``/`` — the
    one delimiter that cannot occur inside either — makes the nested layout
    ``<dataset>/<schedule_id>.json`` injective. The write is atomic (tmp +
    ``os.replace``) so a concurrent battery worker reaching the same key can
    never observe a torn file as its ``--schedule`` input.
    """
    dataset = _validate_path_component(spec.dataset, "schedule dataset")
    schedule_id = _validate_path_component(spec.schedule_id, "schedule_id")
    tmp_dir = root / ".certify_cache" / "tmp_schedules" / dataset
    tmp_dir.mkdir(parents=True, exist_ok=True)
    p = tmp_dir / f"{schedule_id}.json"
    staging = p.with_name(f"{schedule_id}.tmp-{os.getpid()}-{threading.get_ident()}")
    spec.write_json(staging)
    os.replace(staging, p)
    return p


#: Recording-cache manifest schema version. BUMP this to invalidate every
#: existing cached recording at once. Version 4 (P-023) adds the DECLARED
#: polarity conventions — storage_agree_value, input/output convention and pair
#: side — to the read/write cache predicate: without them P-023's mandatory
#: "change s without votes" control is a CACHE HIT (same votes file, same
#: schedule, same engine tree) and returns the stale recording instead of
#: executing, so the control never reaches its gate. The bump is what forces
#: every existing recording to be re-produced rather than accepted under an
#: undeclared convention; a documentation-only key change is insufficient.
#: Version 3 adds checkpoint content hashes
#: and requires cursor metadata on both engines. Version 2 (M3/P-019): the py
#: manifest now keys on the comments CSV (moderation events Python loads from
#: it), and the schedule hash now covers restart_after/clojure — recordings made
#: under the old keys must not be reused, or a comments-only or restart-only edit
#: would compare a fresh run against a stale one and report its old MATCH.
_RECORDING_MANIFEST_VERSION = 4


def _recording_hashes(directory: Path) -> dict[str, str]:
    return {p.name: sha256_file(p) for p in sorted(directory.glob("step-*")) if p.is_file()}


def _clear_recording(directory: Path) -> None:
    """A producer must not inherit old steps or a success marker on failure."""
    for p in directory.glob("step-*"):
        if p.is_file():
            p.unlink()
    (directory / "cache_manifest.json").unlink(missing_ok=True)


def _manifest_matches(manifest_path: Path, expected: dict[str, Any]) -> bool:
    if not manifest_path.exists():
        return False
    try:
        existing = json.loads(manifest_path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise CertifyError("recording-manifest", f"malformed recording manifest: {manifest_path}") from exc
    if not isinstance(existing, dict):
        raise CertifyError("recording-manifest", "recording manifest must be an object")
    # Old versions require a fresh producer run, never acceptance of old steps.
    if existing.get("manifest_version") in (1, 2, 3):
        return False
    if type(existing.get("manifest_version")) is not int or existing["manifest_version"] != _RECORDING_MANIFEST_VERSION:
        raise CertifyError("recording-manifest", "unknown or missing recording manifest version")
    hashes = existing.pop("checkpoint_sha256", None)
    if not isinstance(hashes, dict) or set(existing) != set(expected):
        raise CertifyError("recording-manifest", "malformed recording manifest fields")
    if hashes != _recording_hashes(manifest_path.parent):
        raise CertifyError("recording-integrity", "checkpoint files differ from recording manifest")
    return existing == expected


def _write_manifest(manifest_path: Path, manifest: dict[str, Any]) -> None:
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    with open(manifest_path, "w") as fh:
        json.dump({**manifest, "checkpoint_sha256": _recording_hashes(manifest_path.parent)},
                  fh, indent=2, sort_keys=True)


#: Pure-harness paths (relative to ``polismath/``) excluded from the py
#: recording cache key: none of them is reachable from the replay subprocess
#: import graph (``scripts/replay_driver.py`` → driver/schedule/real_data/
#: store/stepcompare/types → the engine), so editing them cannot change
#: replay outputs (Julien ruling 2026-07-27, GOAL_CUTOVER_READY.md Phase 0a).
#: Trailing ``/`` = whole subtree. driver.py/schedule.py/real_data.py DO
#: shape replays and deliberately stay in the hash.
_ENGINE_TREE_EXCLUDE: tuple[str, ...] = (
    "poller/",
    "replay/certify.py",
    "replay/poller_equiv.py",
    "replay/prodclone.py",
    "replay/shard_bench.py",
)


def engine_tree_hash(polismath_root: str | Path | None = None) -> str:
    """Tree hash of the ENGINE surface: every ``polismath/**/*.py`` except
    :data:`_ENGINE_TREE_EXCLUDE` — the py recording cache key. Harness-only
    edits therefore keep recordings cached (the ~36-min full py re-replay is
    reserved for actual engine changes). Uncached because tests mutate trees;
    the battery hot path goes through :func:`_engine_tree_hash_cached`."""
    root = Path(polismath_root) if polismath_root is not None else _DELPHI_ROOT / "polismath"
    return sha256_tree(root, "**/*.py", exclude=_ENGINE_TREE_EXCLUDE)


@functools.lru_cache(maxsize=1)
def _engine_tree_hash_cached() -> str:
    return engine_tree_hash()


@functools.lru_cache(maxsize=1)
def _clj_source_hashes() -> tuple[str, str]:
    """(sha256 of dev/replay.clj, sha256 of the math/src tree) — cached since
    both are read-only per process and re-hashing the whole math/src tree on
    every battery entry is wasted work."""
    return (
        sha256_file(_MATH_ROOT / "dev" / "replay.clj"),
        sha256_tree(_MATH_ROOT / "src", "**/*"),
    )


def run_provenance(root: Path, battery_path: str | Path | None = None) -> dict[str, Any]:
    """Everything this runner can attest about WHAT produced a verdict: the
    Clojure driver and math source it replayed against, the Python engine tree,
    and the comparer configuration + code. A run manifest without these records
    only that *a* verdict was reached, not by which engine, driver or comparer —
    which is most of the manifest's purpose.

    These are deliberately the SAME hashes the recording cache keys on
    (:func:`ensure_clj_recording`, :func:`ensure_py_recording`,
    :func:`_comparer_cfg_hash`), so a manifest and the recordings it judged
    cannot silently disagree about their provenance.

    Deliberately NOT attested here — P-022 defers them to a later slice:
    interpreter/JVM/BLAS versions, architecture, container image digests and
    dependency-lock fingerprints."""
    replay_clj_sha256, math_src_sha256 = _clj_source_hashes()
    return {
        "engine_tree_sha256": _engine_tree_hash_cached(),
        "replay_clj_sha256": replay_clj_sha256,
        "math_src_sha256": math_src_sha256,
        "comparer_cfg_sha256": _comparer_cfg_hash(_acceptance_projecting_comparer()),
        "recording_manifest_version": _RECORDING_MANIFEST_VERSION,
        "conventions": DEFAULT_CONVENTIONS.cache_fields(),
        "battery_path": str(battery_path) if battery_path is not None else None,
        "root": str(root),
        "deferred": ["runtime_versions", "architecture", "image_digest",
                     "jvm", "blas", "dependency_lock_sha256"],
    }


def ensure_py_recording(
    entry: BatteryEntry, spec: sched.ScheduleSpec, votes_sha: str, *, root: Path,
    refresh: bool = False, comments_csv: Path | None = None,
    conventions: ConventionDescriptor = DEFAULT_CONVENTIONS,
) -> tuple[Path, bool]:
    """Reuse ``<root>/<ds>/<sid>/py/`` iff its cache manifest matches (votes
    sha256, schedule hash, ENGINE-scoped tree hash, and — when ``comments_csv``
    is given — its sha256); else (re)run the Python driver in a subprocess.
    Returns ``(py_dir, was_cached)``.

    M3 (P-019): the comments CSV is a real INPUT to the Python replay — Python
    loads moderation events from it (real_data.py) — so its content MUST be part
    of the cache key, exactly as the Clojure side already does (see
    :func:`ensure_clj_recording`). Without it, a comments-only mutation left the
    py recording cached and compared a fresh Clojure run against a stale Python
    one. Entries that never pass ``comments_csv`` (moderation="none") are
    unaffected by that field, but ALL entries are re-keyed once by the bumped
    :data:`_RECORDING_MANIFEST_VERSION`.

    The 2026-07-27 switch from the full-``polismath`` tree hash to the
    engine-scoped one (key renamed ``py_tree_sha256`` → ``engine_tree_sha256``)
    deliberately invalidated every existing py recording ONCE — that forced
    re-replay doubled as the timed A/B run for the parallel battery."""
    rec_dir = st.recording_dir(entry.dataset, entry.schedule_id, root=root)
    py_dir = rec_dir / "py"
    manifest_path = py_dir / "cache_manifest.json"
    expected = {
        "manifest_version": _RECORDING_MANIFEST_VERSION,
        "votes_sha256": votes_sha,
        "schedule_hash": canonical_schedule_hash(spec),
        "engine_tree_sha256": _engine_tree_hash_cached(),
        **conventions.cache_fields(),
    }
    if comments_csv is not None:
        expected["comments_csv_sha256"] = sha256_file(comments_csv)
    if not refresh and _manifest_matches(manifest_path, expected):
        return py_dir, True

    tmp_schedule = _write_temp_schedule(spec, root)
    _clear_recording(py_dir)
    result = run_py_driver(tmp_schedule, out_root=root)
    if result.returncode != 0:
        raise CertifyError(
            "py-driver", (result.stderr or result.stdout or "non-zero exit").strip()[:1000]
        )
    _write_manifest(manifest_path, expected)
    return py_dir, False


def ensure_clj_recording(
    entry: BatteryEntry, spec: sched.ScheduleSpec, votes_sha: str, votes_csv: Path, *,
    root: Path, refresh: bool = False, comments_csv: Path | None = None,
    conventions: ConventionDescriptor = DEFAULT_CONVENTIONS,
) -> tuple[Path, bool]:
    """Reuse ``<root>/<ds>/<sid>/clj/`` iff its cache manifest matches (votes
    sha256, schedule hash, sha256 of dev/replay.clj, sha256 of math/src, and
    — when ``comments_csv`` is given — its sha256 too); else (re)run the
    Clojure driver in a subprocess (cwd=math/). Returns ``(clj_dir,
    was_cached)``. Engine_mode plays no part in the Clojure reference, so it
    is deliberately NOT one of the cache keys.

    ``comments_csv`` (when given) is forwarded to :func:`run_clj_driver` as
    ``--comments`` AND its sha256 is added to the cache manifest (STRICT —
    this deliberately invalidates existing mod-entry clj recordings once; the
    nightly battery re-records). Entries that never pass it (moderation="none")
    keep their existing cache key and are unaffected by this parameter."""
    rec_dir = st.recording_dir(entry.dataset, entry.schedule_id, root=root)
    clj_dir = rec_dir / "clj"
    manifest_path = clj_dir / "cache_manifest.json"
    replay_clj_sha256, math_src_sha256 = _clj_source_hashes()
    expected = {
        "manifest_version": _RECORDING_MANIFEST_VERSION,
        "votes_sha256": votes_sha,
        "schedule_hash": canonical_schedule_hash(spec),
        "replay_clj_sha256": replay_clj_sha256,
        "math_src_sha256": math_src_sha256,
        **conventions.cache_fields(),
    }
    if comments_csv is not None:
        expected["comments_csv_sha256"] = sha256_file(comments_csv)
    if not refresh and _manifest_matches(manifest_path, expected):
        return clj_dir, True

    tmp_schedule = _write_temp_schedule(spec, root)
    _clear_recording(clj_dir)
    rec_dir.mkdir(parents=True, exist_ok=True)
    result = run_clj_driver(tmp_schedule, votes_csv, out_dir=rec_dir, comments_csv=comments_csv)
    if result.returncode != 0:
        raise CertifyError(
            "clj-driver", (result.stderr or result.stdout or "non-zero exit").strip()[:1000]
        )
    _write_manifest(manifest_path, expected)
    return clj_dir, False


# ---------------------------------------------------------------------------
# Hash-first compare + step-verdict cache.
# ---------------------------------------------------------------------------
def _step_verdict_cache_path(cache_root: Path, clj_hash: str, py_hash: str, cfg_hash: str) -> Path:
    key = hashlib.sha256(f"{clj_hash}{py_hash}{cfg_hash}".encode()).hexdigest()
    return cache_root / ".certify_cache" / "stepverdicts" / f"{key}.json"


def compare_recording_pair(
    clj_dir: str | Path, py_dir: str | Path, *, cache_root: str | Path,
    comparer: StepComparer | None = None,
) -> dict[str, Any]:
    """Hash-first, cached comparison of one clj/py recording pair.

    Each aligned step is projected onto :data:`ACCEPTANCE_KEYS` and hashed
    PER ENGINE; equal hashes short-circuit to a zero-cost MATCH. A mismatch
    consults the on-disk step-verdict cache (keyed on the hash pair + comparer
    config) before running the (acceptance-projecting) :class:`StepComparer`.
    """
    clj_blobs = load_clj_blobs(Path(clj_dir))
    py_blobs = st.load_step_blobs(Path(py_dir))
    if not clj_blobs or not py_blobs:
        raise CertifyError("empty-recording", "both engines must produce nonempty recordings")
    if len(clj_blobs) != len(py_blobs):
        raise CertifyError("step-count-mismatch",
                           f"clj={len(clj_blobs)} steps, py={len(py_blobs)} steps")
    # Even the standalone comparer/focuser must reject gaps and renamed copies.
    for directory, suffix in ((Path(clj_dir), ".blob.json"), (Path(py_dir), ".json")):
        names = sorted(p.name for p in directory.glob(f"step-*{suffix}"))
        if names != sorted(f"step-{i:03d}{suffix}" for i in range(len(clj_blobs))):
            raise CertifyError("checkpoint-identity", "checkpoint filenames must be contiguous")
    aligned = len(clj_blobs)
    cmp = comparer if comparer is not None else _acceptance_projecting_comparer()
    cfg_hash = _comparer_cfg_hash(cmp)
    cache_root = Path(cache_root)

    per_step: list[dict[str, Any]] = []
    for i in range(aligned):
        # RAW validation first, per engine, BEFORE projection/hash/cached
        # verdict: equal hashes short-circuit to MATCH below, so two producers
        # emitting the same malformed value would otherwise certify clean
        # (P-022 B1 review, P1). require_keys=False — the standalone comparer
        # has no cursor metadata and so cannot tell a legitimate empty
        # checkpoint from a truncated one; the certify path enforces presence
        # in validate_recording_inventory, where cut slots are known.
        validate_checkpoint_blob(clj_blobs[i], f"clj: step-{i:03d}", require_keys=False)
        validate_checkpoint_blob(py_blobs[i], f"py: step-{i:03d}", require_keys=False)
        clj_proj = project_acceptance(clj_blobs[i])
        py_proj = project_acceptance(py_blobs[i])
        if not clj_proj or not py_proj:
            raise CertifyError("checkpoint-schema", "empty acceptance blob")
        clj_hash = _canonical_hash(clj_proj)
        py_hash = _canonical_hash(py_proj)

        if clj_hash == py_hash:
            per_step.append({
                "step": i, "match": True, "n_divergences": 0,
                "families": {"exact": [], "tolerant": []}, "sign_flips": [],
                "hash_match": True,
            })
            continue

        cache_path = _step_verdict_cache_path(cache_root, clj_hash, py_hash, cfg_hash)
        report = None
        if cache_path.exists():
            try:
                report = json.loads(cache_path.read_text())
            except (OSError, json.JSONDecodeError):
                report = None
        if report is None:
            report = cmp.compare_step(clj_proj, py_proj, i)
            cache_path.parent.mkdir(parents=True, exist_ok=True)
            # Atomic write (tmp + rename): parallel battery workers may reach
            # the same hash-pair key concurrently; a reader must never see a
            # torn file served as a cached verdict.
            tmp_path = cache_path.with_suffix(
                f".tmp-{os.getpid()}-{threading.get_ident()}"
            )
            with open(tmp_path, "w") as fh:
                json.dump(report, fh, indent=2, sort_keys=True, default=str)
            os.replace(tmp_path, cache_path)
        report = dict(report)
        report["hash_match"] = False
        per_step.append(report)

    return {
        "n_steps_clj": len(clj_blobs),
        "n_steps_py": len(py_blobs),
        "aligned_steps": aligned,
        "step_count_mismatch": len(clj_blobs) != len(py_blobs),
        "per_step": per_step,
    }


def _summarize_divergences(cmp_result: dict[str, Any]) -> dict[str, Any]:
    """Aggregate ALL divergences across every divergent step into distinct
    (normalized path, family) patterns, ranked by frequency (ties broken
    alphabetically for determinism) — top ≤3 for display, full set for the
    ledger."""
    per_step = cmp_result["per_step"]
    div_steps = [s for s in per_step if not s["match"]]
    first_div_step = div_steps[0]["step"] if div_steps else None

    counts: dict[tuple[str, str], int] = {}
    examples: dict[tuple[str, str], tuple[Any, Any]] = {}
    first_step_seen: dict[tuple[str, str], int] = {}
    for step in div_steps:
        for fam in ("exact", "tolerant"):
            for d in step["families"][fam]:
                key = (normalize_path(d.get("path") or ""), fam)
                counts[key] = counts.get(key, 0) + 1
                if key not in examples:
                    examples[key] = (d.get("a"), d.get("b"))
                    first_step_seen[key] = step["step"]

    ranked = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
    top_paths = [
        {
            "path_pattern": path_pattern, "family": fam, "count": count,
            "fingerprint": fingerprint_key_for(path_pattern, fam),
            "a": _abbrev(examples[(path_pattern, fam)][0]),
            "b": _abbrev(examples[(path_pattern, fam)][1]),
        }
        for (path_pattern, fam), count in ranked[:3]
    ]
    all_observed = [
        {"path_pattern": path_pattern, "family": fam, "step": first_step_seen[(path_pattern, fam)]}
        for (path_pattern, fam) in counts
    ]
    return {
        "first_div_step": first_div_step,
        "n_div_steps": len(div_steps),
        "top_paths": top_paths,
        "all_observed": all_observed,
    }


# ---------------------------------------------------------------------------
# Per-entry certification.
# ---------------------------------------------------------------------------
@dataclass
class ExpectedEntry:
    entry: BatteryEntry
    spec: sched.ScheduleSpec
    votes_csv: Path
    votes_sha: str
    comments_csv: Path | None
    comments_sha: str | None
    stream_end: int
    checkpoints: list[dict[str, int]]

    def inventory(self) -> list[dict[str, Any]]:
        return [{
            "dataset": self.entry.dataset, "schedule_id": self.entry.schedule_id,
            "role": self.entry.role or f"{self.entry.dataset}:{self.entry.schedule_id}",
            "engine": engine, "coverage": self.spec.coverage,
            "stream_end": self.stream_end, "checkpoints": self.checkpoints,
        } for engine in ("clj", "py")]


def prepare_entry(entry: BatteryEntry) -> ExpectedEntry:
    """Resolve inputs and checkpoint identities before any producer can run."""
    st.recording_dir(entry.dataset, entry.schedule_id)
    if not dataset_available(entry.dataset):
        raise CertifyError("dataset-unavailable", "dataset-unavailable")
    votes_csv = votes_csv_path(entry.dataset)
    if votes_csv is None:
        raise CertifyError("dataset-unavailable", "no votes CSV found")
    votes_sha = sha256_file(votes_csv)
    ds = real_data.load_export_votes(entry.dataset)
    spec = build_effective_spec(entry, ds)
    if spec.dataset != entry.dataset:
        raise CertifyError("inventory", "schedule dataset does not match battery")
    steps = sched.slice_schedule(ds, spec)
    if not steps:
        raise CertifyError("inventory", "nonzero expected checkpoints required")
    if spec.coverage not in ("full-stream", "prefix-diagnostic"):
        raise CertifyError("inventory", "unknown schedule coverage")
    if spec.coverage == "full-stream" and steps[-1].cut_slot != ds.n:
        raise CertifyError("inventory", "final cut must reach stream end")
    if spec.coverage == "full-stream" and len(sched._resolve_mod_events(ds, spec)) != sum(
        len(s.mod_events) for s in steps
    ):
        raise CertifyError("inventory", "final cut leaves moderation events unconsumed")
    if spec.restart_after is not None and (
        type(spec.restart_after) is not int or not 0 <= spec.restart_after < len(steps) - 1
    ):
        raise CertifyError("inventory", "restart_after requires a subsequent checkpoint")
    if steps[0].cut_slot == 0:
        if not isinstance(spec.empty_output, dict) or not spec.empty_output:
            raise CertifyError("inventory", "zero checkpoint requires a nonempty empty_output contract")
        if not set(spec.empty_output) <= ACCEPTANCE_KEYS:
            raise CertifyError("inventory", "empty_output must name acceptance fields")
    comments = comments_csv_path(entry.dataset) if spec.moderation != "none" else None
    if spec.moderation == "interleave-by-timestamp" and comments is None:
        raise CertifyError("dataset-unavailable", "moderation schedule requires comments CSV")
    checkpoints = [{"index": s.index, "prev_slot": s.prev_slot, "cut_slot": s.cut_slot,
                    "batch_size": len(s.vote_events), "cut_time_ms": s.cut_time_ms}
                   for s in steps]
    # Pass resolved absolute cursors to BOTH engines. Neither driver gets to
    # independently round fractions or silently change the expected inventory.
    resolved = spec.to_dict()
    resolved["cuts"] = {"mode": "vote-count", "at": [s.cut_slot for s in steps]}
    if steps[0].cut_slot == 0:
        resolved["cuts"]["empty_checkpoint"] = True
    return ExpectedEntry(entry, sched.ScheduleSpec.from_dict(resolved), votes_csv, votes_sha,
                         comments, sha256_file(comments) if comments else None, ds.n, checkpoints)


def validate_recording_inventory(directory: Path, engine: str, expected: ExpectedEntry) -> None:
    """Exact file and cursor equality, independently for each engine."""
    suffixes = (".blob.json", ".meta.json") if engine == "clj" else (".json",)
    names = {f"step-{c['index']:03d}{suffix}" for c in expected.checkpoints for suffix in suffixes}
    actual = {p.name for p in directory.glob("step-*.json")}
    if actual != names:
        raise CertifyError("checkpoint-inventory",
                           f"{engine}: missing={sorted(names - actual)}, unexpected={sorted(actual - names)}")
    for checkpoint in expected.checkpoints:
        stem = f"step-{checkpoint['index']:03d}"
        meta_path = directory / (stem + (".meta.json" if engine == "clj" else ".json"))
        meta = json.loads(meta_path.read_text())
        if not isinstance(meta, dict) or any(
            type(meta.get(k)) is not int or meta[k] != v for k, v in checkpoint.items()
        ):
            raise CertifyError("checkpoint-identity", f"{engine}: metadata differs at {stem}")
        blob = (json.loads((directory / (stem + ".blob.json")).read_text())
                if engine == "clj" else meta.get("blob"))
        if not isinstance(blob, dict) or not project_acceptance(blob):
            raise CertifyError("checkpoint-schema", f"{engine}: missing acceptance blob at {stem}")
        # Raw field validation, independently per engine and on cache hits too:
        # a nonempty projection says nothing about the VALUES in it (P-022 B1
        # review, P1). The zero checkpoint is exempted from required-key
        # presence only — the empty_output contract below governs it — but its
        # types and finiteness are still checked.
        validate_checkpoint_blob(blob, f"{engine}: {stem}",
                                 require_keys=checkpoint["cut_slot"] != 0)
        if checkpoint["cut_slot"] == 0:
            projected = project_acceptance(blob)
            missing = sorted(k for k in expected.spec.empty_output if k not in projected)
            wrong = sorted(k for k, v in expected.spec.empty_output.items()
                           if k in projected and projected[k] != v)
            if missing or wrong:
                # Name the offending keys: the two engines' empty prep-main blobs
                # genuinely disagree (Clojure omits n/n-cmts/tids/in-conv where
                # Python emits their empty values), and that is an OUTPUT-CONTRACT
                # question for P-022, not a harness defect. A bare "violates
                # declared empty_output" reads like a regression; this does not.
                raise CertifyError(
                    "empty-output",
                    f"{engine}: {stem} does not satisfy the schedule's declared "
                    f"empty_output contract — absent keys {missing}, wrong values "
                    f"{ {k: projected[k] for k in wrong} } (expected "
                    f"{ {k: expected.spec.empty_output[k] for k in wrong} }). The "
                    f"engines' empty-compute representations are not yet reconciled; "
                    f"see the schedule's notes.")


def _entry_error(entry: BatteryEntry, exc: Exception) -> dict[str, Any]:
    stage = exc.stage if isinstance(exc, CertifyError) else "setup"
    optional_missing = entry.optional and stage == "dataset-unavailable"
    return {"dataset": entry.dataset, "schedule_id": entry.schedule_id,
            "verdict": "SKIPPED" if optional_missing else "ERROR",
            "optional": entry.optional, "stage": stage, "reason": str(exc)}


def _certify_entry_heavy(
    entry: BatteryEntry, *, root: Path, refresh_clj: bool = False, refresh_py: bool = False,
    expected: ExpectedEntry | None = None,
) -> dict[str, Any]:
    """The parallel-safe part of certifying one entry: ensure both recordings
    and run the hash-first compare — NO ledger access, so a whole battery can
    fan these out across workers. Terminal verdicts (SKIPPED/ERROR/MATCH) come
    back complete; a divergence carries its summary under ``"_summary"`` for
    the strictly-serial ledger fold (:func:`_fold_entry_into_ledger`)."""
    try:
        expected = expected or prepare_entry(entry)
        votes_csv, votes_sha, spec = expected.votes_csv, expected.votes_sha, expected.spec

        # --comments only when the schedule actually requests moderation
        # (interleaving or an explicit list) AND the dataset has a comments
        # CSV to weave from — existing moderation="none" entries never pass
        # it, so their recordings/caches are untouched (MOD_RESTART_PORT_
        # SPEC.md "Python ports" item 5).
        comments_csv = expected.comments_csv

        clj_dir, clj_cached = ensure_clj_recording(entry, spec, votes_sha, votes_csv, root=root,
                                                   refresh=refresh_clj, comments_csv=comments_csv)
        # M3 (P-019): the comments CSV is an input to the PYTHON replay too, so it
        # must be part of the py cache key, mirroring the clj side above.
        py_dir, py_cached = ensure_py_recording(entry, spec, votes_sha, root=root,
                                                refresh=refresh_py, comments_csv=comments_csv)
        # Recorded in the run manifest: a verdict reached entirely from cache is
        # a different provenance claim than one that re-ran both engines.
        cache = {"clj": "hit" if clj_cached else "miss",
                 "py": "hit" if py_cached else "miss"}
        if sha256_file(votes_csv) != votes_sha or (
            comments_csv is not None and sha256_file(comments_csv) != expected.comments_sha
        ):
            raise CertifyError("input-changed", "inputs changed after inventory construction")
        validate_recording_inventory(clj_dir, "clj", expected)
        validate_recording_inventory(py_dir, "py", expected)
        cmp_result = compare_recording_pair(clj_dir, py_dir, cache_root=root)
    except Exception as exc:  # noqa: BLE001 - one bad entry must not crash the battery
        return _entry_error(entry, exc)

    div_steps = [s for s in cmp_result["per_step"] if not s["match"]]
    if not div_steps:
        return {"dataset": entry.dataset, "schedule_id": entry.schedule_id,
                "verdict": "MATCH", "n_steps": cmp_result["aligned_steps"], "cache": cache}

    summary = _summarize_divergences(cmp_result)
    return {"dataset": entry.dataset, "schedule_id": entry.schedule_id,
            "verdict": "DIVERGENCE", "cache": cache,
            "first_div_step": summary["first_div_step"],
            "n_div_steps": summary["n_div_steps"], "_summary": summary}


def _fold_entry_into_ledger(
    result: dict[str, Any], ledger: dict[str, Any],
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Serial half of certifying an entry: annotate a divergence's top paths
    against the (accumulating) ledger, then record its observations. Annotate
    BEFORE update — a fingerprint first seen in THIS entry reads as new, not
    known — exactly matching the pre-parallel serial semantics."""
    summary = result.pop("_summary", None)
    if summary is None:
        return result, ledger

    for p in summary["top_paths"]:
        p["known"] = annotate_by_key(ledger, p["fingerprint"])

    observations = [
        {"path_pattern": o["path_pattern"], "family": o["family"],
         "dataset": result["dataset"],
         "schedule_id": result["schedule_id"], "step": o["step"]}
        for o in summary["all_observed"]
    ]
    ledger = update_ledger(ledger, observations)
    result["top_paths"] = summary["top_paths"]
    return result, ledger


def certify_entry(
    entry: BatteryEntry, *, root: Path, refresh_clj: bool = False, refresh_py: bool = False,
    ledger: dict[str, Any] | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Certify one battery entry: ensure both recordings, hash-first compare,
    fingerprint + ledger any divergences. Returns ``(result, updated_ledger)``
    — the ledger is threaded explicitly (not saved here) so a whole-battery
    run persists it exactly once.
    """
    ledger = dict(ledger) if ledger is not None else load_ledger()
    heavy = _certify_entry_heavy(entry, root=root, refresh_clj=refresh_clj,
                                 refresh_py=refresh_py)
    return _fold_entry_into_ledger(heavy, ledger)


# ---------------------------------------------------------------------------
# Battery-level orchestration.
# ---------------------------------------------------------------------------
def _filter_only(entries: list[BatteryEntry], only: str) -> list[BatteryEntry]:
    if ":" in only:
        ds, sid = only.split(":", 1)
        return [e for e in entries if e.dataset == ds and e.schedule_id == sid]
    return [e for e in entries if e.dataset == only]


#: Name of the pointer file naming the most recent run manifest in a root. The
#: manifests themselves are per-run (:func:`run_manifest_path`) — a later debug
#: run must never be able to destroy a release run's manifest.
RUN_MANIFEST_LATEST = "run_manifest_latest.json"


def run_manifest_path(root: Path, run_id: str) -> Path:
    """``<root>/run_manifest-<run_id>.json``. Manifests are per-run and never
    overwritten: a run against an already-used root (a debug re-run, a retry,
    anything sharing the recording store) would otherwise silently clobber the
    manifest that attested a release."""
    return Path(root) / f"run_manifest-{run_id}.json"


def _write_run_manifest(root: Path, manifest: dict[str, Any]) -> Path:
    """Write the manifest under its own run id and repoint ``latest``. The
    pointer is a convenience for humans and tooling; the per-run file is the
    record of truth."""
    path = run_manifest_path(root, manifest["run_id"])
    _write_json(path, manifest)
    _write_json(Path(root) / RUN_MANIFEST_LATEST, {
        "schema": "polis-certification-run-pointer/1",
        "run_id": manifest["run_id"],
        "verdict": manifest["verdict"],
        "finished_at": manifest["finished_at"],
        "run_manifest": str(path),
    })
    return path


#: The standing property's verdict for one engine tree, memoized per PROCESS.
#: It is a property of the ENGINE, not of a battery entry or a run: replaying
#: it for every ``run_battery`` call in one process re-proves the same fact
#: about the same bytes (the key is the engine tree hash the recording cache
#: already keys on), and a battery that certifies many entries would pay for it
#: many times over.
@functools.lru_cache(maxsize=4)
def _standing_polarity_property(engine_tree_sha256: str) -> dict[str, Any]:
    try:
        return run_standing_property(project=project_acceptance)
    except Exception as exc:  # noqa: BLE001 — a broken property is a FAIL
        return {"property": "P-023 compensated polarity pair",
                "verdict": "FAIL", "pairs": [], "controls": [],
                "storage_agree_value": None,
                "problems": [f"{type(exc).__name__}: {exc}"]}


def run_battery(
    entries: list[BatteryEntry], *, root: Path | None = None, refresh_clj: bool = False,
    refresh_py: bool = False, ledger_path: str | Path | None = None, only: str | None = None,
    workers: int = 1, battery_path: str | Path | None = None,
    standing_properties: bool = True,
) -> dict[str, Any]:
    """Certify every (filtered) entry, persist the ledger once, and write the
    machine report to ``<root>/certify_report.json``. Does NOT print — see
    :func:`render_run_lines` for the stdout rendering.

    ``workers`` > 1 fans the per-entry heavy work (driver subprocesses +
    hash-first compare) across threads — entries are independent by
    construction (disjoint recording dirs, atomic verdict-cache writes). The
    ledger fold stays strictly serial and in battery order, so the report and
    ledger are identical to a ``workers=1`` run.

    STANDING PROPERTIES. Every run also executes P-023's compensated polarity
    property — ``E(V, s) == E(-V, -s)`` through both real ingress paths, from
    fresh state, plus every mandatory negative control — and a FAIL there fails
    the gate exactly like a divergent entry. It is a standing property, not a
    per-entry check: it holds of the ENGINE, so it must run even on a battery
    whose entries all come back from cache (which is otherwise the case where
    nothing executes at all). ``standing_properties=False`` is for tests that
    exercise the battery plumbing itself."""
    root = root or st.replays_root()
    ledger_path = ledger_path or default_ledger_path()
    ledger = load_ledger(ledger_path)
    selected = _filter_only(entries, only) if only is not None else entries
    prepared: dict[tuple[str, str], ExpectedEntry] = {}
    errors: dict[tuple[str, str], dict[str, Any]] = {}
    inventory = []
    configuration_errors = []
    if not entries:
        configuration_errors.append("battery has zero entries")
    if not selected:
        configuration_errors.append("selection has zero entries")
    seen = set()
    # Resolve the WHOLE battery before dispatching even the first worker.
    for entry in entries:
        key = (entry.dataset, entry.schedule_id)
        if key in seen:
            configuration_errors.append(f"duplicate battery entry: {key}")
            continue
        seen.add(key)
        try:
            expected = prepare_entry(entry)
            prepared[key] = expected
            inventory.extend(expected.inventory())
        except Exception as exc:
            errors[key] = _entry_error(entry, exc)
    full_datasets = {p.entry.dataset for p in prepared.values() if p.spec.coverage == "full-stream"}
    for p in prepared.values():
        if p.spec.coverage == "prefix-diagnostic" and p.entry.dataset not in full_datasets:
            errors[(p.entry.dataset, p.entry.schedule_id)] = _entry_error(
                p.entry, CertifyError("inventory", "prefix diagnostic requires a full-stream companion"))
    standing: list[dict[str, Any]] = []
    if standing_properties:
        polarity = _standing_polarity_property(_engine_tree_hash_cached())
        standing.append({
            "property": polarity["property"],
            "verdict": polarity["verdict"],
            "problems": polarity["problems"],
            "pairs": len(polarity.get("pairs", [])),
            "controls": len(polarity.get("controls", [])),
            "storage_agree_value": polarity.get("storage_agree_value"),
        })

    run_id = str(uuid.uuid4())
    started = datetime.now(timezone.utc).isoformat()
    manifest = {
        "schema": "polis-certification-run/1", "run_id": run_id, "started_at": started,
        "entry_statuses": ["PASS", "FAIL", "INCONCLUSIVE", "APPROVED_DIFFERENCE"],
        "finished_at": None, "verdict": "INCONCLUSIVE", "partial": only is not None,
        "configuration": {"only": only, "refresh_clj": refresh_clj,
                          "refresh_py": refresh_py, "workers": workers,
                          "battery_path": str(battery_path) if battery_path is not None else None,
                          "root": str(root)},
        "provenance": run_provenance(root, battery_path),
        "standing_properties": standing,
        "configuration_errors": configuration_errors, "inventory": inventory,
        "entries": [{"dataset": e.dataset, "schedule_id": e.schedule_id,
                     "role": e.role or f"{e.dataset}:{e.schedule_id}", "optional": e.optional,
                     "status": "INCONCLUSIVE", "reason": "not completed"} for e in entries],
        "resolved_schedules": [{"dataset": p.entry.dataset, "schedule_id": p.entry.schedule_id,
                                "schedule": p.spec.to_dict(), "votes_sha256": p.votes_sha,
                                "comments_sha256": p.comments_sha} for p in prepared.values()],
    }
    manifest_path = _write_run_manifest(root, manifest)

    def _heavy(entry: BatteryEntry) -> dict[str, Any]:
        key = (entry.dataset, entry.schedule_id)
        if key in errors:
            return errors[key]
        if configuration_errors:
            return _entry_error(entry, CertifyError("inventory", "; ".join(configuration_errors)))
        return _certify_entry_heavy(entry, root=root, refresh_clj=refresh_clj,
                                    refresh_py=refresh_py, expected=prepared[key])

    if workers > 1 and len(selected) > 1:
        with ThreadPoolExecutor(max_workers=min(workers, len(selected))) as pool:
            heavies = list(pool.map(_heavy, selected))
    else:
        heavies = [_heavy(e) for e in selected]

    results = []
    for heavy in heavies:
        result, ledger = _fold_entry_into_ledger(heavy, ledger)
        results.append(result)

    save_ledger(ledger, ledger_path)
    by_key = {(r["dataset"], r["schedule_id"]): r for r in results}
    for item in manifest["entries"]:
        result = by_key.get((item["dataset"], item["schedule_id"]))
        if result is None:
            item["reason"] = "not selected: PARTIAL RUN, NOT A GATE"
        else:
            item["status"] = {"MATCH": "PASS", "ERROR": "FAIL", "DIVERGENCE": "FAIL",
                              "SKIPPED": "INCONCLUSIVE"}[result["verdict"]]
            item["reason"] = result.get("reason", result["verdict"])
            item["cache"] = result.get("cache")
            item["result"] = result
    verdict = "PASS"
    if (configuration_errors
            or any(e["status"] == "FAIL" for e in manifest["entries"])
            or any(p["verdict"] != "PASS" for p in standing)):
        verdict = "FAIL"
    elif only is not None or any(e["status"] != "PASS" for e in manifest["entries"]):
        verdict = "INCONCLUSIVE"
    manifest.update(verdict=verdict, finished_at=datetime.now(timezone.utc).isoformat())
    manifest_path = _write_run_manifest(root, manifest)
    report = {"battery": results, "root": str(root), "verdict": verdict,
              "partial": only is not None, "inventory": inventory,
              "configuration_errors": configuration_errors,
              "standing_properties": standing,
              "run_id": run_id, "run_manifest": str(manifest_path)}
    _write_json(root / "certify_report.json", report)
    return report


def battery_exit_code(results: list[dict[str, Any]] | dict[str, Any], *, strict: bool) -> int:
    if isinstance(results, dict):
        if strict:
            return int(results.get("verdict") != "PASS" or results.get("partial", False))
        return int(results.get("verdict") == "FAIL" or
                   battery_exit_code(results["battery"], strict=False))
    return int(not results or any(
        r["verdict"] != "MATCH" and not (
            not strict and r["verdict"] == "SKIPPED" and r.get("optional") is True
        ) for r in results))


def _write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(f".tmp-{os.getpid()}-{threading.get_ident()}")
    with open(tmp, "w") as fh:
        json.dump(data, fh, indent=2, sort_keys=True, default=str)
        fh.write("\n")
    os.replace(tmp, path)


# ---------------------------------------------------------------------------
# Rendering (pure — CLI just echoes the returned lines).
# ---------------------------------------------------------------------------
def _format_entry_line(result: dict[str, Any]) -> str:
    tag = f"{result['dataset']}:{result['schedule_id']}"
    verdict = result["verdict"]
    if verdict == "MATCH":
        return f"  {tag}  MATCH  ({result['n_steps']} steps)"
    if verdict == "SKIPPED":
        return f"  {tag}  SKIPPED  {result['reason']}"
    if verdict == "ERROR":
        return f"  {tag}  ERROR  [{result['stage']}] {result['reason']}"
    # DIVERGENCE
    paths = ", ".join(
        f"{p['path_pattern']}({p['family']})" + (f" {p['known']}" if p.get("known") else "")
        for p in result["top_paths"]
    )
    return (f"  {tag}  DIVERGENCE  first_div_step={result['first_div_step']} "
            f"n_div_steps={result['n_div_steps']}  top=[{paths}]")


def _format_footer(results: list[dict[str, Any]]) -> str:
    from collections import Counter

    counts = Counter(r["verdict"] for r in results)
    return (f"certify: {len(results)} entries — MATCH={counts.get('MATCH', 0)} "
            f"DIVERGENCE={counts.get('DIVERGENCE', 0)} SKIPPED={counts.get('SKIPPED', 0)} "
            f"ERROR={counts.get('ERROR', 0)}")


def render_run_lines(report: dict[str, Any], *, max_lines: int = 40) -> list[str]:
    """Render ``run_battery``'s report to ≤``max_lines`` stdout lines: the
    acceptance notice, a header, one line per entry (truncated with a
    '+N more' line if the battery is too large to fit), and a footer."""
    header = [ACCEPTANCE_NOTICE, f"certify: {len(report['battery'])} entries  root={report['root']}"]
    footer = [_format_footer(report["battery"])]
    for prop in report.get("standing_properties", []):
        footer.append(
            f"standing property: {prop['property']} {prop['verdict']} "
            f"({prop['pairs']} pairs, {prop['controls']} negative controls, "
            f"storage agree = {prop['storage_agree_value']})"
            + ("" if prop["verdict"] == "PASS"
               else "  " + "; ".join(prop["problems"][:2])))
    if report.get("partial"):
        header.append("PARTIAL RUN, NOT A GATE (--only)")
    if "verdict" in report:
        footer.append(f"gate verdict: {report['verdict']}  manifest={report.get('run_manifest')}")
    budget = max_lines - len(header) - len(footer)
    entries = report["battery"]
    if len(entries) <= budget:
        body = [_format_entry_line(r) for r in entries]
    else:
        shown = entries[: max(budget - 1, 0)]
        body = [_format_entry_line(r) for r in shown]
        body.append(f"  … +{len(entries) - len(shown)} more entries — see certify_report.json")
    return header + body + footer


# ---------------------------------------------------------------------------
# Focuser: first-divergence-only inspection of an EXISTING recording pair.
# ---------------------------------------------------------------------------
def run_focus(
    dataset: str, schedule_id: str, *, root: Path | None = None,
    ledger_path: str | Path | None = None,
) -> dict[str, Any]:
    """Inspect the EARLIEST divergent step of an existing (dataset,
    schedule_id) recording pair. Does NOT run the drivers — `certify run`
    (or a manual replay) must have produced ``clj/`` and ``py/`` already.
    Writes the full per-step detail to ``<root>/<ds>/<sid>/focus-report.json``
    and returns a result dict for :func:`render_focus_lines`. ``ledger_path``
    defaults to the committed ``docs/divergences.json`` — override for tests.
    """
    root = root or st.replays_root()
    rec_dir = st.recording_dir(dataset, schedule_id, root=root)
    clj_dir, py_dir = rec_dir / "clj", rec_dir / "py"
    if not clj_dir.is_dir() or not py_dir.is_dir():
        return {"dataset": dataset, "schedule_id": schedule_id, "verdict": "ERROR",
                "stage": "recording-missing",
                "reason": f"expected clj/ and py/ both present under {rec_dir}"}

    ledger = load_ledger(ledger_path)
    try:
        cmp_result = compare_recording_pair(clj_dir, py_dir, cache_root=root)
    except (CertifyError, ValueError, TypeError, OSError) as exc:
        return {"dataset": dataset, "schedule_id": schedule_id, "verdict": "ERROR",
                "stage": getattr(exc, "stage", "recording-schema"), "reason": str(exc)}
    div_steps = [s for s in cmp_result["per_step"] if not s["match"]]

    _write_json(rec_dir / "focus-report.json", {
        "dataset": dataset, "schedule_id": schedule_id,
        "n_steps_clj": cmp_result["n_steps_clj"], "n_steps_py": cmp_result["n_steps_py"],
        "step_count_mismatch": cmp_result["step_count_mismatch"],
        "first_divergent_step": div_steps[0]["step"] if div_steps else None,
        "per_step": cmp_result["per_step"],
    })

    if not div_steps:
        return {"dataset": dataset, "schedule_id": schedule_id,
                "verdict": "MATCH", "n_steps": cmp_result["aligned_steps"],
                "focus_report_path": str(rec_dir / "focus-report.json")}

    step = div_steps[0]
    families: dict[str, list[dict[str, Any]]] = {"exact": [], "tolerant": []}
    observations = []
    for fam in ("exact", "tolerant"):
        for d in step["families"][fam]:
            path = d.get("path") or ""
            norm = normalize_path(path)
            key = fingerprint_key_for(norm, fam)
            families[fam].append({
                "path": path, "path_pattern": norm, "a": _abbrev(d.get("a")),
                "b": _abbrev(d.get("b")), "fingerprint": key,
                "known": annotate_by_key(ledger, key),
            })
            observations.append({"path_pattern": norm, "family": fam,
                                  "dataset": dataset, "schedule_id": schedule_id,
                                  "step": step["step"]})

    ledger = update_ledger(ledger, observations)
    save_ledger(ledger, ledger_path)

    return {"dataset": dataset, "schedule_id": schedule_id,
            "verdict": "DIVERGENCE", "step": step["step"], "families": families,
            "focus_report_path": str(rec_dir / "focus-report.json")}


def render_focus_lines(
    result: dict[str, Any], *, max_per_family: int = 5, max_lines: int = 40,
) -> list[str]:
    """Render :func:`run_focus`'s result to ≤``max_lines`` stdout lines:
    divergent key-paths ONLY, grouped by family, with a/b values shown for up
    to ``max_per_family`` divergences per family (floats abbreviated)."""
    lines = [ACCEPTANCE_NOTICE]
    tag = f"{result['dataset']}:{result['schedule_id']}"
    if result["verdict"] == "ERROR":
        lines.append(f"focus: {tag} — ERROR [{result['stage']}] {result['reason']}")
        return lines
    if result["verdict"] == "MATCH":
        lines.append(f"focus: {tag} — no divergence in {result['n_steps']} steps (MATCH)")
        return lines

    lines.append(f"focus: {tag} — earliest divergence at step {result['step']}")
    for fam in ("exact", "tolerant"):
        diffs = result["families"][fam]
        if not diffs:
            continue
        lines.append(f"  [{fam}] {len(diffs)} divergence(s)")
        shown = diffs[:max_per_family]
        for d in shown:
            suffix = f"  {d['known']}" if d.get("known") else ""
            lines.append(f"    {d['path']}: a={d['a']} b={d['b']}{suffix}")
        if len(diffs) > len(shown):
            lines.append(f"    … +{len(diffs) - len(shown)} more (see focus-report.json)")

    if len(lines) > max_lines:
        lines = lines[: max_lines - 1] + [f"… output truncated at {max_lines} lines — see focus-report.json"]
    return lines
