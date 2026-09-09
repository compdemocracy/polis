"""Private, immutable certification fixture bundles.

P-022 section A ("Manifest and privacy"). A bundle is a logical version id plus
a content digest, published once and never republished with different bytes:

``<bundle-id>/data/<relpath>``   every fixture file, content-addressed
``<bundle-id>/manifest.json``    the PRIVATE manifest (no role -> zid mapping)
``<bundle-id>/provenance.json``  the RESTRICTED role -> zid mapping, separate
                                 object so ordinary test execution never reads it
``<bundle-id>/pins.json``        exact object VERSION IDs of every object above,
                                 written last; this is the single pin the public
                                 record cites alongside bundle id + root digest

Immutability is enforced by the PUBLISHER, not by S3 versioning, and it is
enforced with a CONDITIONAL CREATE rather than a check followed by a write.
:func:`push` claims the bundle id by creating ``manifest.json`` with
``If-None-Match: *`` (``O_CREAT | O_EXCL`` in the filesystem stand-in) BEFORE it
writes a single payload object; because the manifest carries the root digest of
the whole payload, a second publication of the same id with different bytes is
refused at that first write, with nothing published. Two concurrent publishers
therefore produce exactly one winner. A store that cannot answer authoritatively
about a key — access denied, a transient failure — raises
:class:`StoreUnavailableError`: an unreadable key is NEVER treated as absent.
``pins.json`` is written last and is the commit marker, so an interrupted or
losing publication leaves an unadmitted prefix, not a mixed bundle.

:func:`verify` proves bytes: it fails on corrupted, truncated, missing AND extra
files, and refuses an unversioned or empty manifest outright.
:func:`admit_manifest` proves MEANING — schema version, closed field set, every
configured role present, materialised and inside the rule it claims, synthetic
substitutes actually generated and pinned, checkpoint counts derived from the
schedules, polarity declared. Both run on push and on pull; hashes alone never
certify coverage.

:func:`pull` fetches every object at its pinned version id and rejects path
traversal, absolute paths and symlinks in both the object keys and the
destination tree. The restricted provenance object needs a DISTINCT IAM
principal from the payload and an explicit ``provenance_role`` argument, and is
written 0600.

:func:`public_pin` renders the ONLY bundle facts that may appear publicly:
bundle id, root digest, selector/policy/schedule hashes, role names and
coverage. Never a zid, report id, participant id, timeline, vote row or blob.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import threading
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from collections.abc import Iterator
from typing import Any, Iterable, Sequence

from polismath.utils.vote_convention import (
    ADMISSIBLE_STORAGE_AGREE_VALUES,
    EXPORT_AGREE_VALUE,
    STORAGE_AGREE_VALUE,
    validate_storage_agree_value,
)

#: Bumped to /3 by P-023: ``polarity.storage_agree_value`` is now a DECLARED
#: per-bundle value admitted for exactly -1 or +1 (it was hard-pinned to -1, so
#: the flipped side of a compensated polarity pair was inadmissible by
#: construction and could be neither pushed nor pulled), and the manifest
#: carries a closed ``transform`` block binding a derived fixture to the
#: original it was involuted from. Production-source bundles remain -1 by
#: RELEASE POLICY — a separate predicate, not a schema pin.
#: /2 was the lossless correction: NULL ``weight_x_32767`` and NULL
#: ``votes.vote`` survive extraction as nulls instead of becoming 0, and the
#: manifest carries an ``admission`` block stating the release policy that
#: :func:`admit_manifest` enforces. A /1 manifest is NOT admissible; a /2
#: manifest IS, unchanged, on its original bytes — see
#: :data:`ADMISSIBLE_MANIFEST_SCHEMA_VERSIONS`.
MANIFEST_SCHEMA_VERSION = "certify-fixture-manifest/3"
#: The PREVIOUS closed manifest schema. It stays verifiable and admissible
#: BYTE-FOR-BYTE (review #2730 F-compat): a /2 manifest carries no
#: ``transform`` key at all and its polarity block already spells out the -1 it
#: was pinned to, so the /3 rules evaluate on it unchanged once the absent
#: ``transform`` is read as the "original capture" declaration it is. New
#: bundles are always written at /3; nothing re-issues an existing bundle.
LEGACY_MANIFEST_SCHEMA_VERSION = "certify-fixture-manifest/2"
ADMISSIBLE_MANIFEST_SCHEMA_VERSIONS = (
    LEGACY_MANIFEST_SCHEMA_VERSION, MANIFEST_SCHEMA_VERSION)
PROVENANCE_SCHEMA_VERSION = "certify-fixture-provenance/1"
PINS_SCHEMA_VERSION = "certify-fixture-pins/1"
#: Bumped to /2 by the r2 admission correction: the policy fields carry CLOSED
#: enum tokens (:data:`ADMISSION_POLICY_ENUMS`) instead of prose that only had
#: to be truthy, the prose moved to ``admission.notes``, and the tie policy is
#: derived from — and checked against — the ordering guarantee.
ADMISSION_SCHEMA_VERSION = "certify-fixture-admission/2"

DEFAULT_BUCKET = "polis-certification-data"

MANIFEST_KEY = "manifest.json"
PROVENANCE_KEY = "provenance.json"
PINS_KEY = "pins.json"
DATA_PREFIX = "data/"

#: A relative path is safe only if every segment is a plain name. Anything with
#: a drive letter, a leading separator, a ``..`` segment, a backslash or a
#: control character is rejected outright.
_SAFE_SEGMENT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


class BundleError(RuntimeError):
    """Base class for bundle publication/verification failures."""


class UnsafePathError(BundleError):
    """A path in an archive/manifest would escape the destination tree."""


class ImmutabilityError(BundleError):
    """A bundle id (or one of its objects) already exists with different bytes."""


class ObjectExistsError(BundleError):
    """A CONDITIONAL create lost the race: the key already exists.

    Internal to :func:`_put_immutable`, which then fetches the existing bytes
    and decides between idempotent republication and :class:`ImmutabilityError`.
    """


class StoreUnavailableError(BundleError):
    """The object store could not answer AUTHORITATIVELY about a key.

    Access denied, a transient 5xx, a network failure: none of these mean
    "absent". Publication FAILS CLOSED on them — an unreadable key is never
    treated as free to overwrite.
    """


class VerificationError(BundleError):
    """A file is missing, extra, truncated or does not match its recorded hash."""


class AdmissionError(BundleError):
    """A manifest is byte-consistent but not SEMANTICALLY admissible: wrong or
    missing schema version, unknown fields, a role whose measured metrics fall
    outside the config rule it claims, an unmaterialised role, an inconsistent
    checkpoint declaration, undeclared polarity."""


# ---------------------------------------------------------------------------
# Path safety + hashing.
# ---------------------------------------------------------------------------


def assert_safe_relpath(relpath: str) -> str:
    """Validate a manifest/object relative path. Raises :class:`UnsafePathError`."""
    if not relpath or relpath != relpath.strip():
        raise UnsafePathError(f"empty or padded path: {relpath!r}")
    if "\\" in relpath or "\x00" in relpath:
        raise UnsafePathError(f"illegal character in path: {relpath!r}")
    if relpath.startswith("/") or re.match(r"^[A-Za-z]:", relpath):
        raise UnsafePathError(f"absolute path: {relpath!r}")
    segments = relpath.split("/")
    for seg in segments:
        if seg in ("", ".", ".."):
            raise UnsafePathError(f"illegal path segment {seg!r} in {relpath!r}")
        if not _SAFE_SEGMENT.match(seg):
            raise UnsafePathError(f"illegal path segment {seg!r} in {relpath!r}")
    return relpath


def safe_join(dest: Path, relpath: str) -> Path:
    """Join ``relpath`` under ``dest``, refusing traversal and refusing to
    follow a symlink at any level of the destination tree."""
    assert_safe_relpath(relpath)
    dest = dest.resolve()
    target = dest
    for seg in relpath.split("/"):
        target = target / seg
        if target.is_symlink():
            raise UnsafePathError(f"refusing to write through symlink: {target}")
    resolved_parent = target.parent.resolve() if target.parent.exists() else target.parent
    if dest != resolved_parent and dest not in resolved_parent.parents:
        raise UnsafePathError(f"path escapes destination: {relpath!r}")
    return target


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def count_rows(path: Path) -> int | None:
    """Row count for row-oriented files (``.jsonl`` = lines, ``.csv`` = lines
    minus the header). ``None`` for anything else."""
    suffix = path.suffix.lower()
    if suffix not in (".jsonl", ".csv"):
        return None
    with open(path, "rb") as fh:
        lines = sum(1 for _ in fh)
    return lines - 1 if suffix == ".csv" and lines else lines


def scan_files(root: Path) -> list[dict[str, Any]]:
    """Content inventory of ``root``: relative path, size, row count, sha256.

    Symlinks are REJECTED (never packaged), and every relative path must pass
    :func:`assert_safe_relpath` so an unsafe name cannot enter the manifest.
    """
    root = root.resolve()
    entries: list[dict[str, Any]] = []
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise UnsafePathError(f"symlink in bundle payload: {path}")
        if not path.is_file():
            continue
        rel = path.relative_to(root).as_posix()
        assert_safe_relpath(rel)
        entries.append({
            "path": rel,
            "size": path.stat().st_size,
            "rows": count_rows(path),
            "sha256": sha256_file(path),
        })
    return entries


def root_digest(files: Sequence[dict[str, Any]]) -> str:
    """Single digest over the whole payload: sha256 of ``path\\0sha256\\0size``
    lines in path order. Two bundles with this digest hold identical bytes."""
    h = hashlib.sha256()
    for entry in sorted(files, key=lambda e: e["path"]):
        h.update(f"{entry['path']}\0{entry['sha256']}\0{entry['size']}\n".encode("utf-8"))
    return h.hexdigest()


def git_commit(repo_root: Path) -> str | None:
    try:
        out = subprocess.run(
            ["git", "-C", str(repo_root), "rev-parse", "HEAD"],
            capture_output=True, text=True, check=True,
        )
        return out.stdout.strip()
    except Exception:  # noqa: BLE001 - provenance is best-effort, never fatal
        return None


# ---------------------------------------------------------------------------
# Manifest construction.
# ---------------------------------------------------------------------------


def build_manifest(
    *, bundle_id: str, payload_root: Path, config: dict[str, Any],
    config_bytes: bytes, selections: Sequence[dict[str, Any]],
    generated_summaries: Sequence[dict[str, Any]],
    snapshot: dict[str, Any], transaction_guarantee: dict[str, Any],
    tie_key: dict[str, Any], schedules: Sequence[dict[str, Any]],
    owner: str, extraction_commit: str | None = None,
    source_commit: str | None = None, archive: dict[str, Any] | None = None,
    coverage_report: dict[str, Any] | None = None,
    accepted_null_vote_drops: bool = False,
    storage_agree_value: int = STORAGE_AGREE_VALUE,
    transform: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """The PRIVATE manifest. It records everything P-022 A lists EXCEPT the
    role -> zid mapping, which lives in the separate restricted provenance
    object (:func:`build_provenance`) because ordinary test execution does not
    need identities.

    ``storage_agree_value`` is the bundle's OWN declared raw storage sign of
    agreement, -1 or +1 (P-023). It defaults to the authoritative production
    value and is validated here, so a manifest can never carry a convention
    nobody declared. ``transform`` is :func:`build_transform_block` for a
    DERIVED pair fixture and ``None`` for an original capture; a derived bundle
    binds the original's digests, never the other way round.
    """
    validate_storage_agree_value(storage_agree_value)
    # P-052 §4.5. Derived from the role summaries rather than passed in, so no
    # caller has to remember it and no caller can misdeclare it. When no role
    # captured the served rows the manifest is byte-for-byte what it was before
    # the capture existed.
    served_math_captured = any(
        isinstance(entry, dict) and entry.get("served_math")
        for entry in selections)
    if transform is not None:
        bad = _validate_transform_shape(transform, storage_agree_value, bundle_id)
        if bad:
            raise BundleError("; ".join(bad))
    files = scan_files(payload_root)
    return {
        "schema_version": MANIFEST_SCHEMA_VERSION,
        "bundle_id": bundle_id,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "owner": owner,
        "commits": {
            "extraction_commit": extraction_commit,
            "source_commit": source_commit,
            "config_version": config["config_version"],
            "config_sha256": sha256_bytes(config_bytes),
            "config_schema_version": config["schema_version"],
        },
        "snapshot": snapshot,
        "transaction_guarantee": transaction_guarantee,
        "ordering": {
            "tie_key_available": tie_key["available"],
            "tie_key_columns": tie_key["columns"],
            "tie_key_method": tie_key["method"],
            "votes_order_by": tie_key["order_by"],
            "guarantee": tie_key["guarantee"],
            "note": tie_key["note"],
        },
        "timestamp_precision": "integer milliseconds since the unix epoch "
                               "(the compatibility CSVs remain second-resolution and "
                               "are derived from the millisecond stream)",
        "admission": _admission_block(
            ordering_guarantee=tie_key["guarantee"],
            accepted_null_vote_drops=accepted_null_vote_drops),
        "polarity": {
            "storage_agree_value": storage_agree_value,
            "export_agree_value": REQUIRED_EXPORT_AGREE_VALUE,
            "boundaries": [
                "storage: server/postgres/migrations/000000_initial.sql votes.vote",
                "export: polismath/replay/prodclone.py format_votes_rows converts "
                "raw x storage_agree_value",
                "ingress: polismath/database/postgres.py conversion site",
                "convention: polismath/utils/vote_convention.py STORAGE_AGREE_VALUE",
            ],
        },
        "transform": transform,
        "roles": list(selections),
        "generated": {
            "generator_id": config["generated"]["generator_id"],
            "generator_version": config["generated"]["generator_version"],
            "seed": config["generated"]["seed"],
            "cases": list(generated_summaries),
        },
        "workloads": config["workloads"],
        "coverage_role_map": config.get("coverage_role_map", {}),
        "coverage_report": coverage_report or {},
        "schedules": list(schedules),
        "files": files,
        "root_digest": root_digest(files),
        "archive": archive,
        "redactions": [
            "comments.txt is never selected by any extraction query",
            "the compatibility comments CSV keeps an always-empty comment-body column",
            "no zid, report id, uid, topic or description appears in any payload file",
            "fixture directory names are RANDOM opaque prefixes assigned here, not a "
            "salted hash of the zid",
            "role -> zid mapping is confined to the restricted provenance object",
        ] + ([
            # The blanket claim above is about what the EXTRACTOR selects and
            # writes, and it stays true of every query: no served capture reads
            # a zid column either. What a verbatim served blob CONTAINS is a
            # different fact, and it would be dishonest to leave it implied by
            # the line above, so it is stated here whenever such a blob is in
            # the payload.
            "served math_main blobs (served-math-NNN.blob.json) are captured "
            "VERBATIM and therefore retain whatever Clojure's prep-main "
            "whitelist published inside them, INCLUDING the conversation's own "
            "'zid' key; they are private-tier payload, are never published, and "
            "the qualifier above about payload files applies to the extractor's "
            "own columns, not to the contents of a served blob",
            "the served capture selects no zid column and writes none: "
            "served_math.json carries math_env, the tick counters, the "
            "watermark and digests only",
        ] if served_math_captured else []),
        "retention": "Retained for the supported lifetime of the certificate. "
                     "Retirement requires an explicit privacy-approved decision, "
                     "never a short artifact TTL.",
    }


# ---------------------------------------------------------------------------
# manifest/3: the pair/transform block (P-023).
# ---------------------------------------------------------------------------

TRANSFORM_SCHEMA_VERSION = "certify-fixture-transform/1"

#: The ONE declared transform: T(V, s) = (-V, -s), negating every non-null raw
#: vote leaf and re-declaring the convention, changing nothing else. It is its
#: own inverse, which is what "involution" asserts here.
VOTE_POLARITY_TRANSFORM = "vote-polarity-involution/1"
KNOWN_TRANSFORMS = frozenset({VOTE_POLARITY_TRANSFORM})

#: Closed key sets. A transform block is evidence, so an unreviewed field in it
#: is exactly as bad as an unreviewed top-level manifest field.
TRANSFORM_KEYS = frozenset({
    "schema_version", "transform_id", "involution", "bijective_verified",
    "source", "notes",
})
TRANSFORM_SOURCE_KEYS = frozenset({
    "bundle_id", "root_digest", "manifest_sha256", "storage_agree_value",
})

_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


def build_transform_block(
    *, transform_id: str = VOTE_POLARITY_TRANSFORM,
    source_bundle_id: str, source_root_digest: str, source_manifest_sha256: str,
    source_storage_agree_value: int, bijective_verified: bool,
    notes: str = "",
) -> dict[str, Any]:
    """The derived fixture's binding to the fixture it was involuted from.

    The binding is deliberately ONE-WAY and therefore non-circular: the derived
    manifest names the original's final digests, and the original — which was
    published first and is immutable — names nothing. A copied manifest with an
    edited sign and stale hashes is not an admitted pair, which is why the
    original's ``root_digest`` AND its ``manifest.json`` digest are both bound
    — as DECLARATIONS. Neither is independently fetched and re-derived here;
    see :func:`build_derived_manifest` for what that deferral does and does not
    leave certified.

    ``bijective_verified`` is NOT coerced (review #2730 F3): ``bool("false")``
    is ``True``, so coercion turned an unverified — or misspelled — declaration
    into a verified one. It must already be a real boolean, and admission
    requires it to be ``True``.
    """
    if type(bijective_verified) is not bool:
        raise BundleError(
            f"bijective_verified must be a real boolean, got "
            f"{type(bijective_verified).__name__} {bijective_verified!r}: a "
            f"declaration in a closed admission contract is never coerced")
    if not isinstance(notes, str):
        raise BundleError(f"transform notes must be a string, got "
                          f"{type(notes).__name__}")
    return {
        "schema_version": TRANSFORM_SCHEMA_VERSION,
        "transform_id": transform_id,
        "involution": True,
        "bijective_verified": bijective_verified,
        "source": {
            "bundle_id": source_bundle_id,
            "root_digest": source_root_digest,
            "manifest_sha256": source_manifest_sha256,
            "storage_agree_value": source_storage_agree_value,
        },
        "notes": notes,
    }


def _validate_transform_shape(
    transform: Any, storage_agree_value: int, bundle_id: str,
) -> list[str]:
    """Structural + cross-field checks on a transform block. Returns the list
    of problems (empty when the block is well formed) so both
    :func:`build_manifest` (which raises) and :func:`admit_manifest` (which
    collects) can use it."""
    problems: list[str] = []
    if not isinstance(transform, dict):
        return [f"transform must be an object or null, got "
                f"{type(transform).__name__}"]
    keys = set(transform)
    for missing in sorted(TRANSFORM_KEYS - keys - {"notes"}):
        problems.append(f"transform.{missing} is missing")
    for unknown in sorted(keys - TRANSFORM_KEYS):
        problems.append(f"unknown transform field (nothing validates it): {unknown}")
    if transform.get("schema_version") != TRANSFORM_SCHEMA_VERSION:
        problems.append(
            f"transform.schema_version is {transform.get('schema_version')!r}, "
            f"expected {TRANSFORM_SCHEMA_VERSION!r}: an unreviewed transform "
            f"schema validates nothing")
    if not isinstance(transform.get("notes", ""), str):
        problems.append(
            f"transform.notes must be a string, got "
            f"{type(transform.get('notes')).__name__}")
    if transform.get("transform_id") not in KNOWN_TRANSFORMS:
        problems.append(
            f"transform.transform_id is {transform.get('transform_id')!r}, not one "
            f"of {sorted(KNOWN_TRANSFORMS)}")
    if transform.get("involution") is not True:
        problems.append("transform.involution must be True: the declared "
                        "polarity transform is its own inverse")
    if type(transform.get("bijective_verified")) is not bool \
            or transform.get("bijective_verified") is not True:
        problems.append(
            "transform.bijective_verified must be True: both directions are "
            "verified independently BEFORE any engine launch, and an "
            "unverified transform is not a pair")
    source = transform.get("source")
    if not isinstance(source, dict):
        problems.append("transform.source must be an object naming the original "
                        "bundle and its final digests")
        return problems
    for missing in sorted(TRANSFORM_SOURCE_KEYS - set(source)):
        problems.append(f"transform.source.{missing} is missing")
    for unknown in sorted(set(source) - TRANSFORM_SOURCE_KEYS):
        problems.append(
            f"unknown transform.source field (nothing validates it): {unknown}")
    for digest_field in ("root_digest", "manifest_sha256"):
        value = source.get(digest_field)
        if not isinstance(value, str) or not _SHA256_RE.match(value):
            problems.append(
                f"transform.source.{digest_field} must be a sha256 hex digest; a "
                f"stale or absent digest binds nothing")
    if not isinstance(source.get("bundle_id"), str) or not source["bundle_id"]:
        problems.append("transform.source.bundle_id must be a non-empty string")
    if source.get("bundle_id") == bundle_id:
        problems.append(
            "transform.source.bundle_id is this bundle: the pair descriptor must "
            "be non-circular, and a bundle is not derived from itself")
    src_sign = source.get("storage_agree_value")
    if type(src_sign) is not int or src_sign not in ADMISSIBLE_STORAGE_AGREE_VALUES:
        problems.append(
            f"transform.source.storage_agree_value must be exactly the integer "
            f"-1 or +1, got {type(src_sign).__name__} {src_sign!r}")
    elif src_sign != -storage_agree_value:
        problems.append(
            f"transform.source.storage_agree_value is {src_sign!r} and this "
            f"bundle declares {storage_agree_value!r}: the declared involution "
            f"changes the convention, so the two must be opposite")
    return problems


def build_provenance(
    *, bundle_id: str, root_digest_value: str,
    selections: Sequence[dict[str, Any]], owner: str,
) -> dict[str, Any]:
    """The RESTRICTED provenance object: the role -> zid mapping and nothing
    else that ordinary test execution needs. Stored as a separate object so it
    can carry a stricter access policy than the manifest."""
    return {
        "schema_version": PROVENANCE_SCHEMA_VERSION,
        "bundle_id": bundle_id,
        "root_digest": root_digest_value,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "owner": owner,
        "access": "RESTRICTED — identities. Ordinary certification runs must not "
                  "read this object.",
        "role_to_zid": [
            {
                "role": s["role"],
                "slug": s["slug"],
                "dir": s.get("dir"),
                "zid": s["zid"],
            }
            for s in selections
        ],
    }


def derived_role(entry: dict[str, Any], *, source_bundle_id: str) -> dict[str, Any]:
    """One role of a DERIVED bundle: the same role, same directory, same
    measured metrics, with its source recorded as :data:`DERIVED_ROLE_SOURCE`
    and the original role's own source RETAINED under ``derived_from``.

    The involution changes raw vote signs and nothing else — not the
    conversation a role was selected from, not the metrics it was selected
    under, not its coverage. So the derived role keeps all of that and adds the
    binding that says where it came from; it never claims to be a fresh
    production extraction or an approved synthetic replacement.
    """
    original_source = entry.get("source")
    if original_source not in ORIGINAL_ROLE_SOURCES:
        raise BundleError(
            f"role {entry.get('slug')!r} has source {original_source!r}; only "
            f"{sorted(ORIGINAL_ROLE_SOURCES)} can be derived from (a derived "
            f"bundle is not itself a derivation source)")
    derived = dict(entry)
    derived["source"] = DERIVED_ROLE_SOURCE
    derived["derived_from"] = {
        "bundle_id": source_bundle_id,
        "slug": entry.get("slug"),
        "source": original_source,
    }
    compat = derived.get("compat")
    if isinstance(compat, dict) and "storage_agree_value" in compat:
        compat = dict(compat)
        compat["storage_agree_value"] = -compat["storage_agree_value"]
        derived["compat"] = compat
    return derived


def build_derived_manifest(
    source_manifest: dict[str, Any], *, bundle_id: str, payload_root: Path,
    source_manifest_sha256: str, bijective_verified: bool,
    owner: str | None = None, notes: str = "",
) -> dict[str, Any]:
    """The manifest of the FLIPPED side of a P-023 polarity pair.

    This is the derived-source path admission needs to have something to
    accept: it takes an ADMITTED original manifest and the derived payload tree
    (the same fixtures with every non-null raw vote negated), and produces a
    manifest that declares the opposite convention, re-scans the derived files,
    binds the original through :func:`build_transform_block`, and re-labels
    every role through :func:`derived_role`.

    The original is never mutated and never learns about the derivative: the
    pair descriptor points one way only. ``source_manifest_sha256`` is the
    digest of the original's published ``manifest.json`` bytes.

    DEFERRED, and NOT claimed by this function or by any round-trip test built
    on it: the source digests recorded here are DECLARATIONS. Nothing in this
    slice fetches the original bundle's bytes and re-derives those digests, and
    nothing independently verifies that this payload really is the bijective
    involution of the source payload. Admission checks the block's shape and
    its cross-field consistency — opposite conventions, a non-circular binding,
    a known transform id, a strictly boolean verification flag, and the origin
    rules each derived role inherits. A verify/admit/push/pull round trip of a
    derived bundle therefore proves that it is internally consistent and
    publishable, NOT that its stated source is real or that the transform was
    performed correctly. The independent source-fetch and bijection gate
    remains required before certifying an actual derived bundle.
    """
    if source_manifest.get("schema_version") not in ADMISSIBLE_MANIFEST_SCHEMA_VERSIONS:
        raise BundleError(
            f"cannot derive from schema_version "
            f"{source_manifest.get('schema_version')!r}")
    if source_manifest.get("transform") is not None:
        raise BundleError(
            "cannot derive from a bundle that is itself derived: the pair is "
            "two sides, not a chain")
    source_sign = validate_storage_agree_value(
        source_manifest["polarity"]["storage_agree_value"],
        field="source polarity.storage_agree_value")

    files = scan_files(payload_root)
    derived = dict(source_manifest)
    derived.update(
        schema_version=MANIFEST_SCHEMA_VERSION,
        bundle_id=bundle_id,
        created_at=datetime.now(timezone.utc).isoformat(),
        owner=owner or source_manifest["owner"],
        files=files,
        root_digest=root_digest(files),
        polarity={**source_manifest["polarity"],
                  "storage_agree_value": -source_sign},
        roles=[derived_role(r, source_bundle_id=source_manifest["bundle_id"])
               for r in source_manifest["roles"]],
        transform=build_transform_block(
            source_bundle_id=source_manifest["bundle_id"],
            source_root_digest=source_manifest["root_digest"],
            source_manifest_sha256=source_manifest_sha256,
            source_storage_agree_value=source_sign,
            bijective_verified=bijective_verified,
            notes=notes),
    )
    return derived


def canonical_json(obj: Any) -> bytes:
    return (json.dumps(obj, indent=2, sort_keys=True) + "\n").encode("utf-8")


# ---------------------------------------------------------------------------
# Object stores.
# ---------------------------------------------------------------------------


@dataclass
class PutResult:
    key: str
    version_id: str
    sha256: str


class ObjectStore:
    """Minimal versioned-object interface used by push/pull.

    :meth:`put_if_absent` is the ONLY write path the publisher uses. It must be
    ATOMIC — a conditional create at the store boundary, not a read followed by
    a write — because two publishers can otherwise both observe "absent" before
    either writes. An implementation that cannot offer a conditional create
    cannot back an immutable bundle.
    """

    def exists(self, key: str) -> bool:  # pragma: no cover - interface
        """``True``/``False`` ONLY when the store answered authoritatively.
        Raise :class:`StoreUnavailableError` for anything else."""
        raise NotImplementedError

    def get(self, key: str, version_id: str | None = None) -> tuple[bytes, str]:  # pragma: no cover
        raise NotImplementedError

    def put(self, key: str, data: bytes) -> PutResult:  # pragma: no cover
        """UNCONDITIONAL write. Never used by :func:`push`; present for test
        fixtures and for stores used as scratch space."""
        raise NotImplementedError

    def put_if_absent(self, key: str, data: bytes) -> PutResult:  # pragma: no cover
        """Atomically create ``key``. Raise :class:`ObjectExistsError` if it
        already exists, :class:`StoreUnavailableError` if the store could not
        answer. MUST NOT overwrite under any circumstance."""
        raise NotImplementedError


class LocalStore(ObjectStore):
    """Filesystem stand-in for S3, used by the test suite and by an air-gapped
    orchestrator. Version ids are content digests, which is exactly the pinning
    property the S3 VersionId provides."""

    def __init__(self, root: Path) -> None:
        self.root = Path(root)

    def _path(self, key: str) -> Path:
        for seg in key.split("/"):
            if seg in ("", ".", ".."):
                raise UnsafePathError(f"illegal object key: {key!r}")
        return self.root / key

    def exists(self, key: str) -> bool:
        return self._path(key).is_file()

    def get(self, key: str, version_id: str | None = None) -> tuple[bytes, str]:
        path = self._path(key)
        if not path.is_file():
            raise VerificationError(f"object not found: {key}")
        data = path.read_bytes()
        actual = sha256_bytes(data)
        if version_id is not None and version_id != actual:
            raise VerificationError(
                f"object {key} version mismatch: pinned {version_id}, store has {actual}")
        return data, actual

    def put(self, key: str, data: bytes) -> PutResult:
        path = self._path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return PutResult(key=key, version_id=sha256_bytes(data), sha256=sha256_bytes(data))

    def put_if_absent(self, key: str, data: bytes) -> PutResult:
        """``O_CREAT | O_EXCL`` — the filesystem's own conditional create, so
        two concurrent publishers racing on the same key produce exactly one
        winner (this is what the two-writer test exercises)."""
        path = self._path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError as exc:
            raise ObjectExistsError(f"object already exists: {key}") from exc
        except OSError as exc:  # pragma: no cover - disk-level failure
            raise StoreUnavailableError(f"store could not create {key}: {exc}") from exc
        try:
            os.write(fd, data)
        finally:
            os.close(fd)
        return PutResult(key=key, version_id=sha256_bytes(data), sha256=sha256_bytes(data))


#: S3 error codes that mean "the key is definitely absent". EVERYTHING else —
#: ``AccessDenied``, ``SlowDown``, ``InternalError``, a socket failure — is an
#: unavailable store, not an absent object.
_S3_ABSENT_CODES = frozenset({"404", "NoSuchKey", "NotFound"})

#: S3 error codes returned when a conditional create (``If-None-Match: *``)
#: loses to an object that already exists, or races another conditional write.
_S3_CONDITIONAL_CONFLICT_CODES = frozenset({
    "PreconditionFailed", "412", "ConditionalRequestConflict", "409",
})


#: botocore event id of the conditional-create signing hook. Registration under
#: a unique id is IDEMPOTENT (``HierarchicalEmitter._register_section`` returns
#: early when the id is already present), so every :class:`S3Store` sharing a
#: client re-registers harmlessly and NOBODY ever unregisters it.
_IF_NONE_MATCH_HOOK_ID = "certify-if-none-match"

#: Per-THREAD depth of "this thread is inside a conditional create". botocore
#: emits ``before-sign`` synchronously on the thread that called ``put_object``,
#: so a thread-local is exactly the per-request context the hook needs. This
#: replaces a register/unregister pair around each call, which was a race: with
#: two overlapping conditional puts on one shared client, the first call's
#: ``unregister`` ran before the second call signed, and the second PutObject
#: went out with NO ``If-None-Match`` — an unconditional overwrite, defeating
#: the immutability the whole publisher rests on.
_conditional_put = threading.local()


def _stamp_if_none_match(request: Any, **_kwargs: Any) -> None:
    """Signing-time hook: stamp ``If-None-Match: *`` on the PutObject this
    thread is issuing as a conditional create, and on nothing else.

    Permanently registered, so it can never be missing while a sibling thread
    signs; gated on the thread-local depth, so an ordinary :meth:`S3Store.put`
    (or any other caller's PutObject on the same client) is untouched.
    """
    if getattr(_conditional_put, "depth", 0) > 0:
        if "If-None-Match" not in request.headers:  # never duplicate on retry
            request.headers.add_header("If-None-Match", "*")


def _s3_error_code(exc: Exception) -> str | None:
    """The S3 error code of a botocore ``ClientError``, or ``None`` if ``exc``
    is not a structured S3 error at all (a socket error, a fake client raising
    ``PermissionError``, ...) — which is exactly the ambiguous case that must
    fail closed."""
    response = getattr(exc, "response", None)
    if not isinstance(response, dict):
        return None
    error = response.get("Error")
    if not isinstance(error, dict):
        return None
    code = error.get("Code")
    return str(code) if code is not None else None


class S3Store(ObjectStore):
    """Real S3, with the publisher's immutability enforced by a CONDITIONAL
    create (``If-None-Match: *``) rather than by a read-then-write.

    IAM, three distinct principals (see ``delphi/docs/CERTIFICATION.md``):

    * **publisher** — ``s3:PutObject`` + ``s3:GetObject`` on
      ``<bucket>/<bundle-id>/*``. No ``s3:DeleteObject``,
      no ``s3:PutObjectVersion`` override, no bucket policy edit.
    * **payload reader** — ``s3:GetObject``/``s3:GetObjectVersion`` on
      ``<bucket>/<bundle-id>/data/*``, ``manifest.json`` and ``pins.json``
      ONLY, with an explicit ``Deny`` on ``<bundle-id>/provenance.json``.
    * **provenance reader** — a SEPARATE role whose only extra grant is
      ``s3:GetObject``/``s3:GetObjectVersion`` on
      ``<bucket>/<bundle-id>/provenance.json``. Holding the payload role must
      never be sufficient to read identities.
    """

    def __init__(self, bucket: str, prefix: str = "", client: Any = None) -> None:
        import boto3

        self.bucket = bucket
        self.prefix = prefix.rstrip("/") + "/" if prefix else ""
        self.client = client or boto3.client("s3")

    def _key(self, key: str) -> str:
        return self.prefix + key

    def exists(self, key: str) -> bool:
        """Authoritative presence check. A denied or failing HEAD raises
        :class:`StoreUnavailableError` — it is NEVER reported as absent, which
        is what previously let a publication overwrite bytes it could not
        read."""
        try:
            self.client.head_object(Bucket=self.bucket, Key=self._key(key))
            return True
        except Exception as exc:  # noqa: BLE001
            code = _s3_error_code(exc)
            if code in _S3_ABSENT_CODES:
                return False
            raise StoreUnavailableError(
                f"cannot determine whether {key} exists ({code or type(exc).__name__}: "
                f"{exc}); refusing to write, because an unreadable key is not an "
                "absent key"
            ) from exc

    def put_if_absent(self, key: str, data: bytes) -> PutResult:
        """Conditional create. Two guards, in order:

        1. an AUTHORITATIVE :meth:`exists` probe, which fails closed on a denied
           or failing HEAD rather than assuming the key is free; and
        2. ``If-None-Match: *`` on the write itself, which is what actually
           settles a race between two publishers that both saw "absent".
        """
        if self.exists(key):
            raise ObjectExistsError(f"object already exists: {key}")
        try:
            with self._if_none_match():
                resp = self.client.put_object(
                    Bucket=self.bucket, Key=self._key(key), Body=data,
                    ChecksumAlgorithm="SHA256",
                )
        except Exception as exc:  # noqa: BLE001
            code = _s3_error_code(exc)
            if code in _S3_CONDITIONAL_CONFLICT_CODES:
                raise ObjectExistsError(f"object already exists: {key}") from exc
            raise StoreUnavailableError(f"conditional put failed for {key}: {exc}") from exc
        return PutResult(key=key, version_id=resp.get("VersionId", "null"),
                         sha256=sha256_bytes(data))

    @contextmanager
    def _if_none_match(self) -> Iterator[None]:
        """Add ``If-None-Match: *`` to the PutObject inside this block, on this
        thread, REGARDLESS of what other threads are doing to the same client.

        Injected as a signing-time header rather than passed as a parameter:
        ``IfNoneMatch`` only appeared in the botocore S3 model in the 1.35
        series, and this tree pins botocore 1.34.162 (``delphi/uv.lock``), whose
        PutObject shape has no such member — passing it would raise
        ``ParamValidationError``, and quietly dropping it would be exactly the
        unconditional overwrite this is here to prevent. The header is
        understood by S3 regardless of the local model version.

        The hook is registered ONCE per client and never removed
        (:func:`_stamp_if_none_match`); what this block toggles is the
        per-thread flag the hook reads. The previous register/unregister pair
        was scoped to the CLIENT, so two overlapping conditional puts shared one
        registration and the first one's ``unregister`` stripped the
        precondition from the second one's write.
        """
        events = getattr(getattr(self.client, "meta", None), "events", None)
        if events is None:
            # An unconditional PutObject is NOT an acceptable fallback: it is
            # the overwrite the conditional create exists to prevent.
            raise StoreUnavailableError(
                "the S3 client exposes no botocore event emitter, so the "
                "If-None-Match precondition cannot be attached; refusing to "
                "publish with an UNCONDITIONAL write")
        events.register_first("before-sign.s3.PutObject", _stamp_if_none_match,
                              unique_id=_IF_NONE_MATCH_HOOK_ID)
        _conditional_put.depth = getattr(_conditional_put, "depth", 0) + 1
        try:
            yield
        finally:
            _conditional_put.depth -= 1

    def get(self, key: str, version_id: str | None = None) -> tuple[bytes, str]:
        kwargs: dict[str, Any] = {"Bucket": self.bucket, "Key": self._key(key)}
        if version_id:
            kwargs["VersionId"] = version_id
        try:
            resp = self.client.get_object(**kwargs)
        except Exception as exc:  # noqa: BLE001
            raise VerificationError(f"object not readable: {key}: {exc}") from exc
        return resp["Body"].read(), resp.get("VersionId", "null")

    def put(self, key: str, data: bytes) -> PutResult:
        resp = self.client.put_object(
            Bucket=self.bucket, Key=self._key(key), Body=data,
            ChecksumAlgorithm="SHA256",
        )
        return PutResult(key=key, version_id=resp.get("VersionId", "null"),
                         sha256=sha256_bytes(data))


# ---------------------------------------------------------------------------
# Push / pull / verify.
# ---------------------------------------------------------------------------


def _put_immutable(store: ObjectStore, key: str, data: bytes) -> PutResult:
    """CONDITIONALLY create ``key``; tolerate only a byte-identical re-run.

    The write is attempted first, as an atomic conditional create, so there is
    no check-then-write window for a second publisher to slip through. Only
    when the conditional create loses do we read the existing bytes and decide:

    * identical bytes -> idempotent, the caller is re-running a publication;
    * different bytes -> :class:`ImmutabilityError`, the logical id is spent.

    A store that cannot answer authoritatively raises
    :class:`StoreUnavailableError` and the publication FAILS CLOSED.
    """
    try:
        return store.put_if_absent(key, data)
    except ObjectExistsError:
        pass
    existing, version = store.get(key)
    if existing == data:
        return PutResult(key=key, version_id=version, sha256=sha256_bytes(data))
    raise ImmutabilityError(
        f"refusing to republish {key}: it already exists with different bytes "
        f"(existing sha256 {sha256_bytes(existing)}, new {sha256_bytes(data)}). "
        "Publish a NEW bundle id instead."
    )


def push(
    store: ObjectStore, *, bundle_id: str, payload_root: Path,
    manifest: dict[str, Any], provenance: dict[str, Any],
    config: dict[str, Any] | None = None, config_bytes: bytes | None = None,
    config_path: Path | None = None, admit: bool = True,
) -> dict[str, Any]:
    """Publish a bundle immutably and return the pins record.

    Publication order — the reason a second push of DIFFERENT bytes cannot
    write a single object:

    0. **Admission.** :func:`admit_manifest` (unless ``admit=False``): schema
       version, closed field set, role/metric conformance, materialisation,
       schedule/checkpoint consistency, declared polarity.
    1. **Pre-flight.** Every payload file named by the manifest is read and
       re-digested locally and the root digest is recomputed. Nothing has been
       written yet, so a payload that drifted since the manifest was built
       fails before it can occupy the logical id.
    2. **Claim.** ``manifest.json`` is created CONDITIONALLY. Because the
       manifest carries the root digest of the whole payload, different bytes
       anywhere in the bundle mean different manifest bytes, so a second
       publication of this id is refused HERE — before any data object exists.
       A byte-identical re-run passes through and resumes.
    3. **Payload**, then the restricted provenance object, each conditionally.
    4. **Commit.** ``pins.json`` is written LAST, conditionally. It is the
       admission marker: :func:`pull` requires it, so an interrupted or
       conflicting upload leaves an INCOMPLETE, unadmitted prefix rather than a
       mixed bundle that looks published.
    """
    if manifest["bundle_id"] != bundle_id or provenance["bundle_id"] != bundle_id:
        raise BundleError("bundle_id mismatch between arguments and manifest/provenance")

    payload_root = Path(payload_root).resolve()
    objects: dict[str, dict[str, str]] = {}

    if admit:
        admit_manifest(manifest, config=config, config_bytes=config_bytes,
                       config_path=config_path, payload_root=payload_root)

    _verify_served_payloads(payload_root, manifest)

    # 1. Pre-flight: verify EVERY payload digest against the manifest before a
    #    single byte is published.
    payloads: list[tuple[str, bytes]] = []
    for entry in manifest["files"]:
        rel = assert_safe_relpath(entry["path"])
        local = safe_join(payload_root, rel)
        data = local.read_bytes()
        if sha256_bytes(data) != entry["sha256"] or len(data) != entry["size"]:
            raise VerificationError(
                f"payload changed under us: {rel} no longer matches its manifest "
                "entry; nothing was published")
        payloads.append((rel, data))
    staged_digest = root_digest([
        {"path": rel, "sha256": sha256_bytes(data), "size": len(data)}
        for rel, data in payloads
    ])
    if staged_digest != manifest["root_digest"]:
        raise VerificationError(
            f"root digest mismatch before publication: manifest says "
            f"{manifest['root_digest']}, staged payload is {staged_digest}; "
            "nothing was published")

    # 2. Claim the logical id with the manifest itself.
    manifest_bytes = canonical_json(manifest)
    m = _put_immutable(store, f"{bundle_id}/{MANIFEST_KEY}", manifest_bytes)
    objects[m.key] = {"version_id": m.version_id, "sha256": m.sha256}

    # 3. Payload, then the restricted provenance object.
    for rel, data in payloads:
        result = _put_immutable(store, f"{bundle_id}/{DATA_PREFIX}{rel}", data)
        objects[result.key] = {"version_id": result.version_id, "sha256": result.sha256}

    provenance_bytes = canonical_json(provenance)
    p = _put_immutable(store, f"{bundle_id}/{PROVENANCE_KEY}", provenance_bytes)
    objects[p.key] = {"version_id": p.version_id, "sha256": p.sha256}

    # pins.json is a PURE FUNCTION of the published content (no wall-clock
    # field): re-running an identical publication is idempotent, while any real
    # content change still trips the immutability guard. The bundle's creation
    # time lives in the manifest.
    pins = {
        "schema_version": PINS_SCHEMA_VERSION,
        "bundle_id": bundle_id,
        "root_digest": manifest["root_digest"],
        "manifest_sha256": m.sha256,
        "provenance_sha256": p.sha256,
        "objects": objects,
    }
    # 4. Commit marker, last.
    pins_result = _put_immutable(store, f"{bundle_id}/{PINS_KEY}", canonical_json(pins))
    pins["pins_object_version_id"] = pins_result.version_id
    return pins


def verify(payload_root: Path, manifest: dict[str, Any], *,
           allow_partial: bool = False) -> None:
    """Verify a LOCAL payload tree against ``manifest``.

    Fails on corrupted, truncated, missing AND extra files; a truncated file
    fails on both its size and its hash, and each is reported.

    This is the INTEGRITY primitive, not release admission (see
    :func:`admit_manifest`) — but it is no longer willing to call an
    unidentified object a manifest: the schema version must be the one this
    module writes, the bundle must be named, and an EMPTY payload is refused.
    ``allow_partial=True`` lifts only the empty-payload refusal, for diagnostic
    use of a half-built payload tree that is never going to be published.
    """
    payload_root = Path(payload_root).resolve()

    if not isinstance(manifest, dict):
        raise VerificationError("manifest is not an object")
    version = manifest.get("schema_version")
    if version not in ADMISSIBLE_MANIFEST_SCHEMA_VERSIONS:
        raise VerificationError(
            f"manifest schema_version is {version!r}, expected one of "
            f"{list(ADMISSIBLE_MANIFEST_SCHEMA_VERSIONS)}; an unversioned or "
            "foreign manifest is not verifiable")
    if not isinstance(manifest.get("bundle_id"), str) or not manifest["bundle_id"]:
        raise VerificationError("manifest has no bundle_id")
    if not isinstance(manifest.get("files"), list):
        raise VerificationError("manifest has no file inventory")
    if not manifest["files"] and not allow_partial:
        raise VerificationError(
            f"manifest {manifest['bundle_id']} lists NO files: an empty inventory "
            "trivially matches an empty directory and certifies nothing "
            "(pass allow_partial=True for diagnostic use of a partial payload)")
    if "root_digest" not in manifest:
        raise VerificationError("manifest has no root_digest")

    expected = {e["path"]: e for e in manifest["files"]}
    if len(expected) != len(manifest["files"]):
        raise VerificationError("manifest lists the same path more than once")
    actual = {e["path"]: e for e in scan_files(payload_root)}

    problems: list[str] = []
    for rel in sorted(set(expected) - set(actual)):
        problems.append(f"missing file: {rel}")
    for rel in sorted(set(actual) - set(expected)):
        problems.append(f"extra file not in manifest: {rel}")
    for rel in sorted(set(expected) & set(actual)):
        want, have = expected[rel], actual[rel]
        if want["size"] != have["size"]:
            problems.append(
                f"size mismatch: {rel} expected {want['size']} bytes, got {have['size']}")
        if want["sha256"] != have["sha256"]:
            problems.append(
                f"hash mismatch: {rel} expected {want['sha256']}, got {have['sha256']}")
        if want.get("rows") != have.get("rows"):
            problems.append(
                f"row-count mismatch: {rel} expected {want.get('rows')}, got {have.get('rows')}")

    digest = root_digest(list(actual.values()))
    if digest != manifest["root_digest"]:
        problems.append(
            f"root digest mismatch: expected {manifest['root_digest']}, got {digest}")

    try:
        _verify_served_payloads(payload_root, manifest)
    except VerificationError as exc:
        problems.append(str(exc))

    if problems:
        raise VerificationError(
            f"bundle {manifest['bundle_id']} failed verification:\n  - "
            + "\n  - ".join(problems))


def _verify_served_payloads(payload_root: Path, manifest: dict[str, Any]) -> None:
    from polismath.replay.served_math import CaptureError, read_capture

    named = set()
    for role in manifest.get("roles", []):
        if "served_math" not in role:
            continue
        try:
            directory = safe_join(payload_root, role["dir"])
            read_capture(directory, expected_summary=role["served_math"])
            named.add(f"{role['dir']}/served_math.json")
        except (CaptureError, KeyError, TypeError, ValueError) as exc:
            raise VerificationError(f"served_math: {exc}") from exc
    actual = {p.relative_to(payload_root).as_posix()
              for p in payload_root.rglob("served_math.json")}
    if actual != named:
        raise VerificationError("served metadata file census differs from manifest roles")


# ---------------------------------------------------------------------------
# Semantic admission — what the hashes cannot tell you.
# ---------------------------------------------------------------------------

#: Exactly the top-level manifest keys :func:`build_manifest` writes. Admission
#: is a CLOSED set in both directions: a missing key is an incomplete manifest,
#: an unknown key is an unreviewed field that no gate is checking.
MANIFEST_TOP_LEVEL_KEYS = frozenset({
    "schema_version", "bundle_id", "created_at", "owner", "commits", "snapshot",
    "transaction_guarantee", "ordering", "timestamp_precision", "polarity",
    "roles", "generated", "workloads", "coverage_role_map", "coverage_report",
    "schedules", "files", "root_digest", "archive", "redactions", "retention",
    "admission",
    # manifest/3 (P-023): the pair/transform provenance of a DERIVED fixture,
    # explicitly null for an original capture. Required at /3 rather than
    # optional — the set is closed in both directions, so "no transform block"
    # has to be a stated fact, not an omission nobody noticed. A /2 manifest
    # predates the field and is read with it ABSENT, which means the same
    # thing: an original capture.
    "transform",
})

#: /3 fields the /2 schema did not have. Absent from a /2 manifest, and their
#: /2 defaults are applied so an existing bundle admits on its original bytes.
MANIFEST_KEYS_ADDED_IN_V3 = frozenset({"transform"})

MANIFEST_TOP_LEVEL_KEYS_BY_VERSION: dict[str, frozenset[str]] = {
    LEGACY_MANIFEST_SCHEMA_VERSION: MANIFEST_TOP_LEVEL_KEYS - MANIFEST_KEYS_ADDED_IN_V3,
    MANIFEST_SCHEMA_VERSION: MANIFEST_TOP_LEVEL_KEYS,
}

#: Ordering guarantee -> the ONE tie-order policy token that guarantee permits.
#: Admission compares the two: a manifest that declares ``frozen-extract-order``
#: in its ordering block and a different tie policy in its admission block is
#: contradicting itself, and a contradiction is not a policy.
TIE_ORDER_POLICIES: dict[str, str] = {
    "frozen-extract-order": "frozen-extract-bytes-authoritative",
    "stable-tie-key": "stable-tie-key-total-order",
}

ORDERING_GUARANTEES = frozenset(TIE_ORDER_POLICIES)

#: The role source of a DERIVED bundle: this role's fixture is the declared
#: involution of an ADMITTED bundle's role, not a new production extraction and
#: not an approved synthetic replacement (review #2730 F1).
#:
#: Without it no flipped bundle could exist at all: 15 of the 17 required roles
#: carry ``on_missing: fail``, so admission forbids substituting them, and the
#: production release policy forbids a production-source role from declaring
#: +1. Relabelling them "synthetic-replacement" only moves the failure. The
#: derived source is the missing third case, and it is NOT a weakening: a
#: derived role must name the transform's source bundle and RETAIN the original
#: role's own source, so the provenance of the underlying capture survives the
#: involution instead of being laundered by it.
DERIVED_ROLE_SOURCE = "derived"

#: What a derived role may have been derived FROM.
ORIGINAL_ROLE_SOURCES = frozenset({"production", "synthetic-replacement"})

ROLE_SOURCES = ORIGINAL_ROLE_SOURCES | frozenset({DERIVED_ROLE_SOURCE})

#: Closed key set of a derived role's provenance binding.
DERIVED_FROM_KEYS = frozenset({"bundle_id", "source", "slug"})

#: The compatibility-CSV NULL-vote policy the extractor writes
#: (``fixture_extract.COMPAT_NULL_VOTE_POLICY``). Restated here because
#: admission must not import the extractor; a test asserts the two agree.
REQUIRED_COMPAT_NULL_VOTE_POLICY = "drop-counted"

#: The served-math capture (P-052 §4.5) is OPTIONAL: a role entry either
#: carries the block or does not, and an absent block means the bundle simply
#: did not capture what the engine served. When the block IS present it is
#: validated as strictly as everything else here — a closed key set, digests
#: that name files the inventory actually holds, and the standing rule that the
#: watermark consistency check is a DIAGNOSTIC and never a gate.
#:
#: Restated rather than imported, exactly like the NULL-vote policy above:
#: admission does not import the extractor, and a test asserts the two agree.
REQUIRED_SERVED_MATH_SCHEMA_VERSION = "certify-served-math/1"
REQUIRED_SERVED_MATH_META_FILENAME = "served_math.json"

#: Closed key set of a role's served-math block.
SERVED_MATH_KEYS = frozenset({
    "schema_version", "captured", "meta_file", "meta_sha256",
    "logical_digest_sha256", "math_envs", "math_main_rows", "math_ticks_rows",
    "blobs", "consistency",
})

#: Closed key set of one blob entry inside it.
SERVED_MATH_BLOB_KEYS = frozenset({"math_env", "file", "sha256", "bytes"})

_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")

#: Closed enums for the declared release policy. Every value is a VERSIONED
#: token, not prose: a truthiness check on a free-text sentence admitted
#: "same-input ties may differ arbitrarily" as a tie-order policy. The prose
#: lives in ``admission.notes``, which no gate reads.
ADMISSION_POLICY_ENUMS: dict[str, frozenset[str]] = {
    "null_weight_policy": frozenset({"nullable-preserved"}),
    "null_vote_policy": frozenset({
        "event-stream-nullable+compat-csv-drop-counted"}),
    "synthetic_substitution_policy": frozenset({
        "explicit-approval-and-materialised"}),
    "tie_order_policy": frozenset(TIE_ORDER_POLICIES.values()),
    "equal_time_policy": frozenset({"census-counted-ambiguity"}),
    "schedule_coverage": frozenset({"file-schedules-only"}),
}

#: The token in ``admission.null_vote_policy`` that says the compatibility CSV
#: omits NULL votes under a COUNTED policy — which is what makes a per-role
#: census mandatory rather than optional.
COMPAT_DROP_COUNTED_POLICY = "event-stream-nullable+compat-csv-drop-counted"

#: Raw storage sign of AGREE and the export sign it becomes.
#:
#: P-023 replaced the hard pin. ``storage_agree_value`` is now a DECLARED
#: per-manifest value admitted for exactly the integer -1 or +1
#: (``ADMISSIBLE_STORAGE_AGREE_VALUES``, bool excluded), because the flipped
#: side of a compensated polarity pair is a legitimate fixture and the old
#: ``== -1`` predicate made it inadmissible by construction: neither ``push``
#: nor ``pull`` would accept it, so the pair could not be certified at all.
#:
#: What is NOT relaxed is the RELEASE POLICY: a bundle carrying a PRODUCTION
#: capture must still declare -1 until the separately approved storage
#: migration lands. That is a policy predicate over the declared roles, not a
#: schema pin over every manifest — see :data:`PRODUCTION_STORAGE_AGREE_VALUE`.
#: The export sign is unconditional: it is a separate tagged format and does
#: not move with storage.
PRODUCTION_STORAGE_AGREE_VALUE = STORAGE_AGREE_VALUE
REQUIRED_EXPORT_AGREE_VALUE = EXPORT_AGREE_VALUE


def _admission_block(*, ordering_guarantee: str,
                     accepted_null_vote_drops: bool = False) -> dict[str, Any]:
    """The manifest's declared, machine-checked release policy.

    Every policy is a token from :data:`ADMISSION_POLICY_ENUMS`; the prose that
    used to BE the policy value is demoted to ``notes``, which nothing checks.
    ``tie_order_policy`` is derived from the ordering guarantee the extract
    actually achieved, so the block cannot contradict the ordering block.
    """
    if ordering_guarantee not in TIE_ORDER_POLICIES:
        raise BundleError(
            f"unknown ordering guarantee {ordering_guarantee!r}; expected one of "
            f"{sorted(TIE_ORDER_POLICIES)}")
    return {
        "schema_version": ADMISSION_SCHEMA_VERSION,
        "null_weight_policy": "nullable-preserved",
        "null_vote_policy": COMPAT_DROP_COUNTED_POLICY,
        "accepted_null_vote_drops": bool(accepted_null_vote_drops),
        "synthetic_substitution_policy": "explicit-approval-and-materialised",
        "tie_order_policy": TIE_ORDER_POLICIES[ordering_guarantee],
        "equal_time_policy": "census-counted-ambiguity",
        "schedule_coverage": "file-schedules-only",
        "notes": {
            "null_weight_policy":
                "a NULL votes.weight_x_32767 survives as JSON null; it is a "
                "distinct storage fact from a weight of 0",
            "null_vote_policy":
                "the event stream keeps every NULL votes.vote; the compatibility "
                "CSV omits them and COUNTS them per role, which makes that export "
                "non-certifying until an operator records an acceptance",
            "synthetic_substitution_policy":
                "allowed only with an explicit --accept-synthetic approval, and "
                "only when the replacement generator case is MATERIALISED and "
                "pinned in this manifest; a dir:null substitute is an unfilled "
                "role",
            "tie_order_policy":
                "the frozen extract bytes are authoritative; equal-input ties "
                "resolve identically on every engine given the same frozen order",
            "equal_time_policy":
                "historical same-millisecond opposite votes are a narrow, "
                "census-counted ambiguity, never an invented order",
            "schedule_coverage":
                "file schedules under scripts/schedules only; the battery's "
                "inline presets are NOT hashed here (section B)",
        },
    }


def _admission_problem(problems: list[str], cond: bool, message: str) -> None:
    if not cond:
        problems.append(message)


def _is_count(value: Any) -> bool:
    """A real non-negative integer count. ``bool`` is excluded on purpose: a
    census field carrying ``True`` is a typing accident, not a count of one."""
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def _canonical_config(config: Any) -> str:
    """Canonical serialisation used to compare a caller's parsed config with the
    parse of the hashed bytes. Key order and whitespace are not meaning; a
    changed threshold is."""
    return json.dumps(config, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=True)


def admit_manifest(
    manifest: dict[str, Any], *, config: dict[str, Any] | None = None,
    config_bytes: bytes | None = None, config_path: Path | None = None,
    payload_root: Path | None = None,
) -> None:
    """Admit structure and, when served capture is present, its actual payload.

    A served logical digest cannot be verified from the manifest alone. The
    private pull preflight checks structure before download; full admission
    checks the downloaded payload before making it available to consumers.
    """
    _admit_manifest_structure(manifest, config=config, config_bytes=config_bytes,
                              config_path=config_path)
    if any("served_math" in row for row in manifest["roles"]):
        if payload_root is None:
            raise AdmissionError("served_math admission requires payload_root")
        try:
            verify(payload_root, manifest)
        except VerificationError as exc:
            raise AdmissionError(str(exc)) from exc


def _admit_manifest_structure(
    manifest: dict[str, Any], *, config: dict[str, Any] | None = None,
    config_bytes: bytes | None = None, config_path: Path | None = None,
) -> None:
    """SEMANTIC admission. Raises :class:`AdmissionError` listing every defect.

    :func:`verify` proves the bytes on disk are the bytes the manifest names.
    That is necessary and nowhere near sufficient: it says nothing about which
    roles the bundle claims, whether the conversation behind a role actually
    satisfies the rule it was selected under, whether a synthetic substitute
    was ever materialised, whether the declared checkpoint counts match the
    schedules, or whether the polarity that every downstream comparison depends
    on was declared at all. This function is that gate, and ``push``/``pull``
    both run it.

    ``config_bytes`` — the exact bytes of the selection config the bundle was
    BUILT from; ``config_path`` (default: the committed ``certify_datasets.json``)
    is where they are read from when they are not passed. The digest binding is
    NOT optional: the bytes must hash to the ``config_sha256`` the manifest
    recorded, so a bundle can never be admitted against a different revision of
    the rules.

    There is exactly ONE authority here. That byte buffer is parsed and
    validated once, and the resulting object is the rule set every predicate,
    threshold and generator field below is evaluated against — the digest and
    the rules actually applied cannot name different revisions. The optional
    parsed ``config`` is a convenience only: it must be canonically equal to the
    parse of the hashed bytes or admission fails, because a caller could
    otherwise keep the committed file's digest on the certificate while
    admitting under a schema-valid config whose thresholds were weakened. For
    the same reason an explicit ``config_path`` supplied ALONGSIDE
    ``config_bytes`` is read once and must contain those bytes, so the hashed
    revision and the file supplying the predicates cannot diverge.
    """
    from polismath.replay import fixture_config as fc

    if not isinstance(manifest, dict):
        raise AdmissionError("manifest is not an object")
    problems: list[str] = []
    P = lambda cond, msg: _admission_problem(problems, cond, msg)  # noqa: E731

    # --- identity + closed field set -------------------------------------
    schema_version = manifest.get("schema_version")
    P(schema_version in ADMISSIBLE_MANIFEST_SCHEMA_VERSIONS,
      f"schema_version is {schema_version!r}, expected one of "
      f"{list(ADMISSIBLE_MANIFEST_SCHEMA_VERSIONS)}")
    # A /2 manifest is admitted on its ORIGINAL BYTES: its closed key set is the
    # /2 one (no `transform`), and the /3 field it predates takes its /2 default
    # below. Only /3 may carry a transform block at all.
    expected_keys = MANIFEST_TOP_LEVEL_KEYS_BY_VERSION.get(
        schema_version, MANIFEST_TOP_LEVEL_KEYS)
    keys = set(manifest)
    for missing in sorted(expected_keys - keys):
        P(False, f"missing required manifest field: {missing}")
    for unknown in sorted(keys - expected_keys):
        P(False, f"unknown manifest field (nothing validates it): {unknown}")
    if problems:
        # Everything below indexes into fields whose presence is in doubt.
        raise AdmissionError(_admission_message(manifest, problems))

    P(bool(manifest["bundle_id"]) and isinstance(manifest["bundle_id"], str),
      "bundle_id must be a non-empty string")
    P(bool(manifest["owner"]) and isinstance(manifest["owner"], str),
      "owner must be a non-empty string (an unowned bundle cannot be retired)")
    P(bool(manifest["created_at"]), "created_at is empty")

    # --- provenance of the rules -----------------------------------------
    commits = manifest["commits"]
    for field in ("config_version", "config_sha256", "config_schema_version"):
        P(bool(commits.get(field)), f"commits.{field} is missing")
    P(bool(commits.get("extraction_commit")),
      "commits.extraction_commit is missing: a bundle with no source-commit "
      "evidence cannot become a certificate")

    # The config digest binding runs on EVERY path, including the defaults, and
    # the bytes that are hashed are the ONLY rules that get evaluated below.
    source = Path(config_path) if config_path is not None else fc.DEFAULT_CONFIG_PATH
    if config_bytes is None:
        try:
            config_bytes = source.read_bytes()
        except OSError as exc:
            raise AdmissionError(
                f"cannot read the selection config at {source} to bind its "
                f"digest ({exc}); admission without a config digest is refused"
            ) from exc
    elif config_path is not None:
        # An explicit path AND explicit bytes: the file is read ONCE, here, and
        # must BE those bytes. Otherwise the digest names one revision of the
        # rules while a different file supplies the predicates.
        try:
            on_disk = source.read_bytes()
        except OSError as exc:
            raise AdmissionError(
                f"cannot read the selection config at {source} to confirm it is "
                f"the buffer whose digest is being bound ({exc})"
            ) from exc
        if on_disk != config_bytes:
            raise AdmissionError(
                f"config_path {source} does not contain the config_bytes whose "
                "digest is bound: the hashed revision of the selection rules and "
                "the file supplying the predicates are different objects"
            )
    # Parse and validate the hashed buffer exactly once; this parsed object, and
    # nothing else, is the rule set every predicate below is evaluated against.
    try:
        hashed_config = json.loads(config_bytes.decode("utf-8"))
        fc.validate_config(hashed_config)
    except (UnicodeDecodeError, json.JSONDecodeError, fc.ConfigError) as exc:
        raise AdmissionError(
            f"the config bytes being hashed are not a valid selection config "
            f"({exc}); an unparseable rule set cannot admit anything"
        ) from exc
    if config is not None and _canonical_config(config) != _canonical_config(
            hashed_config):
        raise AdmissionError(
            "the parsed config supplied for admission is not the config whose "
            "bytes are hashed: a bundle cannot be admitted under one rule set "
            "while its certificate names the digest of another")
    config = hashed_config
    actual = sha256_bytes(config_bytes)
    P(actual == commits.get("config_sha256"),
      f"config bytes hash to {actual}, manifest recorded "
      f"{commits.get('config_sha256')}: this bundle was built from a "
      "different revision of the selection rules")
    P(config.get("config_version") == commits.get("config_version"),
      f"config_version {commits.get('config_version')!r} does not match the "
      f"config supplied for admission ({config.get('config_version')!r})")

    # --- integrity fields the semantic gate also depends on ---------------
    files = manifest["files"]
    P(isinstance(files, list) and bool(files),
      "files is empty: an empty inventory certifies nothing")
    paths = [f.get("path") for f in files] if isinstance(files, list) else []
    P(len(set(paths)) == len(paths), "duplicate path in the file inventory")
    for path in paths:
        # A traversal path is not a defect to list next to the others: stop.
        assert_safe_relpath(str(path))
    if isinstance(files, list) and files:
        P(root_digest(files) == manifest["root_digest"],
          "root_digest does not match the file inventory")
    dirs_present = {str(p).split("/", 1)[0] for p in paths if "/" in str(p)}
    # path -> recorded sha256, so a role's own digest claim can be checked
    # against the inventory the root digest is computed over.
    sha256_by_path = {
        str(f.get("path")): f.get("sha256") for f in files
        if isinstance(f, dict)
    }

    # --- ordering, precision, polarity ------------------------------------
    ordering = manifest["ordering"]
    P(ordering.get("guarantee") in ORDERING_GUARANTEES,
      f"ordering.guarantee {ordering.get('guarantee')!r} is not one of "
      f"{sorted(ORDERING_GUARANTEES)}")
    for field in ("tie_key_available", "tie_key_method", "votes_order_by", "note"):
        P(field in ordering, f"ordering.{field} is missing")
    P(str(manifest["timestamp_precision"]).startswith("integer milliseconds"),
      "timestamp_precision must declare integer milliseconds")

    polarity = manifest["polarity"]
    declared_sign = polarity.get("storage_agree_value")
    # MATHEMATICAL admission: exactly the integer -1 or +1. `type(x) is int`
    # rather than isinstance, because bool is an int subclass and `True == 1`
    # would otherwise admit a convention nobody declared (P-023 control 7).
    P(type(declared_sign) is int
      and declared_sign in ADMISSIBLE_STORAGE_AGREE_VALUES,
      f"polarity.storage_agree_value must be exactly the integer -1 or +1 "
      f"(bool, float and str excluded), got "
      f"{type(declared_sign).__name__} {declared_sign!r}")
    P(polarity.get("export_agree_value") == REQUIRED_EXPORT_AGREE_VALUE,
      f"polarity.export_agree_value must be {REQUIRED_EXPORT_AGREE_VALUE}: the "
      f"export is a separately tagged semantic format and does not move with "
      f"storage")
    P(bool(polarity.get("boundaries")),
      "polarity.boundaries must name the storage/export/ingress sites")

    # RELEASE POLICY, kept separate from the schema: a production CAPTURE must
    # still declare the production convention until the P-023 storage
    # migration is separately approved. A derived pair fixture, whose roles
    # declare source "derived" and retain their original provenance, is not a
    # capture and is unaffected.
    production_roles = sorted(
        str(r.get("slug")) for r in manifest["roles"]
        if isinstance(r, dict) and r.get("source") == "production")
    derived_roles = sorted(
        str(r.get("slug")) for r in manifest["roles"]
        if isinstance(r, dict) and r.get("source") == DERIVED_ROLE_SOURCE)
    if production_roles and declared_sign in ADMISSIBLE_STORAGE_AGREE_VALUES:
        P(declared_sign == PRODUCTION_STORAGE_AGREE_VALUE,
          f"polarity.storage_agree_value is {declared_sign!r}, but this bundle "
          f"carries production-source role(s) {production_roles} and production "
          f"storage is still {PRODUCTION_STORAGE_AGREE_VALUE}: a production "
          f"capture may not declare the flipped convention before the storage "
          f"migration is approved (release policy, not schema)")

    # manifest/3 pair provenance. `null` — or, on a /2 manifest, the absent
    # field — is the positive declaration that this is an ORIGINAL capture; a
    # block must bind the original it was involuted from, with that original's
    # final digests and the opposite convention.
    transform = manifest.get("transform")
    if transform is not None:
        for problem in _validate_transform_shape(
                transform,
                declared_sign if declared_sign in ADMISSIBLE_STORAGE_AGREE_VALUES
                else PRODUCTION_STORAGE_AGREE_VALUE,
                str(manifest["bundle_id"])):
            P(False, problem)
        P(not production_roles,
          f"this manifest declares a transform block AND production-source "
          f"role(s) {production_roles}: a derived fixture is built from an "
          f"admitted bundle's bytes, never re-extracted from production")
        P(bool(derived_roles),
          "this manifest declares a transform block but no role declares "
          f"source {DERIVED_ROLE_SOURCE!r}: a derived bundle's roles are "
          "derivations, and a transform nothing was derived under is not "
          "provenance")
    else:
        P(not derived_roles,
          f"role(s) {derived_roles} declare source {DERIVED_ROLE_SOURCE!r} but "
          f"the manifest declares no transform block, so nothing says what they "
          f"were derived from or under which transform")

    # --- declared release policy ------------------------------------------
    # Every policy is a CLOSED enum token, and the tie policy must agree with
    # the ordering guarantee the extract actually achieved. A truthiness check
    # on free text admitted "same-input ties may differ arbitrarily" as a
    # policy; a contradiction between the two blocks is not a policy at all.
    admission = manifest["admission"]
    P(admission.get("schema_version") == ADMISSION_SCHEMA_VERSION,
      f"admission.schema_version is {admission.get('schema_version')!r}, expected "
      f"{ADMISSION_SCHEMA_VERSION!r}")
    for field, allowed in ADMISSION_POLICY_ENUMS.items():
        P(admission.get(field) in allowed,
          f"admission.{field} is {admission.get(field)!r}, which is not one of "
          f"{sorted(allowed)}: a free-text policy is not a checkable declaration")
    P(isinstance(admission.get("accepted_null_vote_drops"), bool),
      "admission.accepted_null_vote_drops must be an explicit boolean")
    notes = admission.get("notes")
    P(isinstance(notes, dict)
      and set(ADMISSION_POLICY_ENUMS) <= set(notes or {}),
      "admission.notes must carry the prose for every declared policy")

    guarantee = ordering.get("guarantee")
    required_tie_policy = TIE_ORDER_POLICIES.get(str(guarantee))
    P(required_tie_policy is not None
      and admission.get("tie_order_policy") == required_tie_policy,
      f"admission.tie_order_policy {admission.get('tie_order_policy')!r} "
      f"CONTRADICTS ordering.guarantee {guarantee!r}, which admits only "
      f"{required_tie_policy!r}")
    if guarantee == "frozen-extract-order":
        P(ordering.get("tie_key_available") is False,
          "ordering.guarantee is 'frozen-extract-order' but "
          "ordering.tie_key_available is not False: the manifest claims a frozen "
          "byte order AND a source tie key at the same time")
    elif guarantee == "stable-tie-key":
        P(ordering.get("tie_key_available") is True
          and bool(ordering.get("tie_key_columns")),
          "ordering.guarantee is 'stable-tie-key' but the manifest names no "
          "available tie key columns to order by")

    # --- generated cases ---------------------------------------------------
    generated = manifest["generated"]
    gen_cfg = config["generated"]
    P(generated.get("generator_id") == gen_cfg["generator_id"],
      "generated.generator_id does not match the config")
    P(generated.get("generator_version") == gen_cfg["generator_version"],
      "generated.generator_version does not match the config")
    P(generated.get("seed") == gen_cfg["seed"], "generated.seed does not match the config")
    cases = generated.get("cases") or []
    case_slugs = [c.get("slug") for c in cases]
    P(len(set(case_slugs)) == len(case_slugs), "duplicate generated case slug")
    materialised_cases: set[str] = set()
    for case in cases:
        slug = case.get("slug")
        if case.get("dir"):
            if case["dir"] in dirs_present:
                materialised_cases.add(str(slug))
            else:
                P(False, f"generated case {slug!r} claims dir {case['dir']!r} but no "
                         "file in the inventory lives there")
        else:
            P(case.get("materialised") is False,
              f"generated case {slug!r} has no dir and does not say why")
    # A generator case id can expand into several cohort directories.
    materialised_case_ids = set(materialised_cases)
    for case in cases:
        ident = (case.get("generated") or {}).get("case_id")
        if ident and case.get("dir") and case["dir"] in dirs_present:
            materialised_case_ids.add(str(ident))

    # --- roles: declared, ruled, materialised ------------------------------
    roles = manifest["roles"]
    by_slug: dict[str, dict[str, Any]] = {}
    for entry in roles:
        slug = entry.get("slug")
        P(slug not in by_slug, f"role slug {slug!r} appears twice")
        by_slug[str(slug)] = entry
    config_roles = {r["slug"]: r for r in config["roles"]}
    for slug in sorted(set(config_roles) - set(by_slug)):
        P(False, f"required role {slug!r} ({config_roles[slug]['role']}) is not in "
                 "the manifest")
    for slug in sorted(set(by_slug) - set(config_roles)):
        P(False, f"manifest declares role {slug!r}, which the config does not define")

    for slug, rule in sorted(config_roles.items()):
        entry = by_slug.get(slug)
        if entry is None:
            continue
        P(entry.get("role") == rule["role"],
          f"role {slug!r} is named {entry.get('role')!r}, config says {rule['role']!r}")
        source = entry.get("source")
        P(source in ROLE_SOURCES, f"role {slug!r} has unknown source {source!r}")
        directory = entry.get("dir")
        P(bool(directory),
          f"role {slug!r} has no fixture directory: a role with dir:null is NOT "
          "filled, whatever it is named")
        if directory:
            P(str(directory) in dirs_present,
              f"role {slug!r} names directory {directory!r}, which holds no file in "
              "the inventory: the role is declared but not materialised")
        # Both a production conversation and a synthetic substitute have to be
        # MEASURED inside the rule the role is named for. A substitute claimed
        # from a case's name, without numbers, is not a substitute.
        metrics = entry.get("measured_metrics")
        P(isinstance(metrics, dict) and bool(metrics),
          f"role {slug!r} records no measured metrics, so nothing shows it "
          "satisfies its own selection rule")
        if isinstance(metrics, dict) and metrics:
            P(fc.evaluate_predicates(metrics, rule["predicates"]),
              f"role {slug!r} measured metrics do NOT satisfy the config "
              f"predicates it claims to have been selected under: "
              f"{_failed_predicates(metrics, rule['predicates'])}")
        # The EFFECTIVE source: for a derived role, the source of the role it
        # was derived FROM. Every rule that governed the original governs the
        # derivation too (review #2730 R2-F1) — retaining a binding that
        # NAMES a synthetic origin, while skipping the offer/approval/generator
        # rules that make a synthetic role admissible, let a manifest claim an
        # origin its own policy forbids, and the whole verify/admit/push/pull
        # path accepted it.
        binding = entry.get("derived_from")
        effective_source = source
        if source == DERIVED_ROLE_SOURCE and isinstance(binding, dict):
            effective_source = binding.get("source")
        if source == DERIVED_ROLE_SOURCE:
            # A derived role is admitted for ANY role, including the 15 whose
            # rule says on_missing:fail — because nothing was substituted. It
            # is the SAME fixture with its raw vote signs involuted, so its
            # measured metrics (checked above, unchanged by a sign flip) still
            # satisfy the rule it was selected under. What must be present is
            # the binding that keeps the original provenance visible.
            P(isinstance(binding, dict) and bool(binding),
              f"derived role {slug!r} carries no derived_from binding: a role "
              f"with no stated origin is an unprovenanced fixture, not a "
              f"derivation")
            if isinstance(binding, dict):
                for unknown in sorted(set(binding) - DERIVED_FROM_KEYS):
                    P(False, f"derived role {slug!r} derived_from carries "
                             f"unknown field {unknown!r}")
                for missing in sorted(DERIVED_FROM_KEYS - set(binding)):
                    P(False, f"derived role {slug!r} derived_from is missing "
                             f"{missing!r}")
                P(binding.get("source") in ORIGINAL_ROLE_SOURCES,
                  f"derived role {slug!r} derived_from.source is "
                  f"{binding.get('source')!r}: it must RETAIN the original "
                  f"role's own source, one of {sorted(ORIGINAL_ROLE_SOURCES)}")
                P(binding.get("slug") == slug,
                  f"derived role {slug!r} claims to derive from role "
                  f"{binding.get('slug')!r}: the involution changes vote signs, "
                  f"never which conversation filled a role")
                if isinstance(transform, dict):
                    expected_source = (transform.get("source") or {}).get(
                        "bundle_id")
                    P(binding.get("bundle_id") == expected_source,
                      f"derived role {slug!r} names origin bundle "
                      f"{binding.get('bundle_id')!r}, but the transform block "
                      f"binds {expected_source!r}: one manifest cannot be "
                      f"derived from two different bundles")
        if effective_source == "synthetic-replacement":
            # Applied to a fresh substitute AND to a derivation of one: the
            # involution changes vote signs, never whether a substitution was
            # offered, approved, materialised or pinned to a generator.
            origin = ("derived synthetic role" if source == DERIVED_ROLE_SOURCE
                      else "synthetic role")
            replacement = rule.get("synthetic_replacement")
            P(rule.get("on_missing") == "fail_with_synthetic_replacement_offer",
              f"role {slug!r} is a synthetic replacement but its rule does not "
              "offer one")
            P(bool(entry.get("approval")),
              f"{origin} {slug!r} carries no recorded operator approval")
            P(entry.get("synthetic_replacement") == replacement,
              f"{origin} {slug!r} names generator case "
              f"{entry.get('synthetic_replacement')!r}, config offers "
              f"{replacement!r}")
            P(str(entry.get("synthetic_replacement")) in materialised_case_ids
              or str(directory) in dirs_present,
              f"{origin} {slug!r} substitutes generator case "
              f"{entry.get('synthetic_replacement')!r}, which is NOT materialised "
              "in this bundle")
            P(bool(entry.get("coverage_limits")),
              f"{origin} {slug!r} does not state its coverage limits")
            P(bool((entry.get("generator") or {}).get("case_id")),
              f"{origin} {slug!r} does not pin the generator that produced it")
        # The role's own extract meta must not contradict the manifest-level
        # ordering declaration it was published under.
        P(entry.get("ordering_guarantee") == guarantee,
          f"role {slug!r} records ordering guarantee "
          f"{entry.get('ordering_guarantee')!r}, but the manifest declares "
          f"{guarantee!r}: the extract and the declaration disagree")

        # OPTIONAL served-math capture (P-052 §4.5). An absent block is a
        # complete statement — this bundle did not capture what the engine
        # served — so nothing is required here. A block that IS present must
        # bind real files with real digests.
        if "served_math" in entry:
            _admit_served_math(
                problems, slug=str(slug), block=entry.get("served_math"),
                directory=str(directory) if directory else None,
                sha256_by_path=sha256_by_path)

        # A per-role NULL-vote census is MANDATORY under the counted drop
        # policy. Omission previously defaulted to zero drops and passed, so a
        # role could lose NULL votes from its compatibility CSV silently.
        compat = entry.get("compat")
        if admission.get("null_vote_policy") == COMPAT_DROP_COUNTED_POLICY:
            P(isinstance(compat, dict) and bool(compat),
              f"role {slug!r} carries NO compatibility census while the admission "
              f"block declares {COMPAT_DROP_COUNTED_POLICY!r}: an omitted census "
              "is not a census of zero")
        if not isinstance(compat, dict):
            continue
        # A sign-sensitive census is derived from the manifest's OWN declared
        # sign (P-023 rev3). A role counted under -1 inside a bundle declaring
        # +1 counted agreements as disagreements. Older censuses predate the
        # field and are unaffected.
        if "storage_agree_value" in compat:
            census_sign = compat.get("storage_agree_value")
            # TYPE before equality (review #2730 R2-F2), the same
            # strictness the C9 ids get: `True == 1` and `1.0 == 1`, so an
            # equality test alone admitted a bool and a float as a declared
            # convention.
            if type(census_sign) is not int \
                    or census_sign not in ADMISSIBLE_STORAGE_AGREE_VALUES:
                P(False,
                  f"role {slug!r} compat census storage_agree_value must be "
                  f"exactly the integer -1 or +1 (bool, float and str "
                  f"excluded), got {type(census_sign).__name__} {census_sign!r}")
            else:
                P(census_sign == declared_sign,
                  f"role {slug!r} compat census was counted under storage agree "
                  f"{census_sign!r} but the manifest declares {declared_sign!r}")
        P(compat.get("null_vote_policy") == REQUIRED_COMPAT_NULL_VOTE_POLICY,
          f"role {slug!r} compat census declares NULL-vote policy "
          f"{compat.get('null_vote_policy')!r}, expected "
          f"{REQUIRED_COMPAT_NULL_VOTE_POLICY!r}")
        dropped = compat.get("null_votes_dropped")
        P(_is_count(dropped),
          f"role {slug!r} compat census has no integer null_votes_dropped "
          f"(got {dropped!r})")
        P(_is_count(compat.get("vote_rows_written")),
          f"role {slug!r} compat census has no integer vote_rows_written "
          f"(got {compat.get('vote_rows_written')!r})")
        if _is_count(dropped):
            P(compat.get("certifying") is (dropped == 0),
              f"role {slug!r} compat census says certifying="
              f"{compat.get('certifying')!r} with {dropped} dropped NULL vote(s): "
              "a compatibility export that lost rows is NOT certifying")
            if dropped:
                P(admission.get("accepted_null_vote_drops") is True,
                  f"role {slug!r} dropped {dropped} NULL-vote row(s) from its "
                  "compatibility CSV; that is a NON-CERTIFYING extraction and "
                  "needs an explicit recorded acceptance "
                  "(admission.accepted_null_vote_drops)")

    # --- schedules and expected checkpoints --------------------------------
    schedules = manifest["schedules"]
    P(isinstance(schedules, list) and bool(schedules),
      "no schedules are pinned: the bundle declares no checkpoint inventory")
    seen_paths: set[str] = set()
    for sched in schedules if isinstance(schedules, list) else []:
        path = sched.get("path")
        P(path not in seen_paths, f"schedule {path!r} is pinned twice")
        seen_paths.add(str(path))
        P(bool(sched.get("schedule_id")), f"schedule {path!r} has no schedule_id")
        P(bool(sched.get("sha256")), f"schedule {path!r} has no sha256")
        n_cuts = sched.get("n_cuts")
        expected = sched.get("expected_checkpoints")
        P(sched.get("cuts_resolvable_without_dataset") is True,
          f"schedule {path!r} has cuts that only a dataset can resolve "
          f"({sched.get('cuts_mode')!r}), so its checkpoint inventory was never "
          "derived; a count nobody could compute cannot be certified")
        P(_is_count(n_cuts) and n_cuts >= 1,
          f"schedule {path!r} declares no cuts")
        P(expected == n_cuts,
          f"schedule {path!r} declares {expected} expected checkpoint(s) but "
          f"{n_cuts} cut(s): the checkpoint count must be derived from the "
          "resolved cuts, not asserted")
        # ZERO-BASED, the replay driver's convention: driver.run_replay compares
        # step.index (0..steps-1) against restart_after and requires at least
        # one step AFTER the seam, else the restart is never observed. The
        # manifest previously used a one-based range, which both rejected the
        # legal index 0 and admitted the nonexistent index n_cuts.
        restart = sched.get("restart_after")
        if restart is not None:
            P(sched.get("restart_index_base") == RESTART_INDEX_BASE,
              f"schedule {path!r} does not declare the {RESTART_INDEX_BASE} "
              "convention for restart_after")
            P(_is_count(n_cuts) and _is_count(restart)
              and 0 <= restart <= n_cuts - 2,
              f"schedule {path!r} restarts after step {restart!r}: the replay "
              f"driver takes a zero-based step index with at least one step "
              f"after it, so with {n_cuts!r} checkpoint(s) the legal range is "
              f"0..{(n_cuts - 2) if _is_count(n_cuts) else '?'}")

    if problems:
        raise AdmissionError(_admission_message(manifest, problems))


def _admit_served_math(
    problems: list[str], *, slug: str, block: Any, directory: str | None,
    sha256_by_path: dict[str, Any],
) -> None:
    """Admit one role's OPTIONAL served-math block (P-052 §4.5).

    What is checked is what a later off-policy comparison would otherwise have
    to take on trust: the block names a schema version this code understands,
    its key set is closed, every file it claims is in the inventory under the
    digest it claims, the per-``math_env`` counts agree with the blob list, and
    the watermark consistency record still declares itself a DIAGNOSTIC. That
    last check is the important one — a consistency record that quietly became
    a gate would start failing extractions for the ordinary case of votes
    arriving after the last publish.
    """
    P = lambda cond, msg: _admission_problem(problems, cond, msg)  # noqa: E731

    if not isinstance(block, dict) or not block:
        P(False, f"role {slug!r} carries an empty or non-object served_math "
                 f"block; omit the block entirely to say the served rows were "
                 f"not captured")
        return
    for unknown in sorted(set(block) - SERVED_MATH_KEYS):
        P(False, f"role {slug!r} served_math carries unknown field {unknown!r} "
                 "(nothing validates it)")
    for missing in sorted(SERVED_MATH_KEYS - set(block)):
        P(False, f"role {slug!r} served_math is missing {missing!r}")
    P(block.get("schema_version") == REQUIRED_SERVED_MATH_SCHEMA_VERSION,
      f"role {slug!r} served_math.schema_version is "
      f"{block.get('schema_version')!r}, expected "
      f"{REQUIRED_SERVED_MATH_SCHEMA_VERSION!r}")
    P(block.get("captured") is True,
      f"role {slug!r} served_math.captured is {block.get('captured')!r}: a "
      "block that is present declares a capture that happened")
    P(block.get("meta_file") == REQUIRED_SERVED_MATH_META_FILENAME,
      f"role {slug!r} served_math.meta_file is {block.get('meta_file')!r}, "
      f"expected {REQUIRED_SERVED_MATH_META_FILENAME!r}")

    def _digest_binds(label: str, filename: Any, digest: Any) -> None:
        P(isinstance(digest, str) and bool(_SHA256_RE.match(digest)),
          f"role {slug!r} served_math {label} digest {digest!r} is not a "
          "lower-case sha256")
        if directory is None or not isinstance(filename, str):
            P(False, f"role {slug!r} served_math {label} names no file inside a "
                     "fixture directory")
            return
        assert_safe_relpath(filename)
        rel = f"{directory}/{filename}"
        recorded = sha256_by_path.get(rel)
        P(recorded is not None,
          f"role {slug!r} served_math {label} names {rel!r}, which is not in "
          "the file inventory: the block is declared but not materialised")
        if recorded is not None:
            P(recorded == digest,
              f"role {slug!r} served_math {label} claims digest {digest!r} for "
              f"{rel!r}, the inventory records {recorded!r}")

    _digest_binds("meta_file", block.get("meta_file"), block.get("meta_sha256"))
    P(isinstance(block.get("logical_digest_sha256"), str)
      and bool(_SHA256_RE.match(str(block.get("logical_digest_sha256")))),
      f"role {slug!r} served_math.logical_digest_sha256 is not a lower-case "
      f"sha256 (got {block.get('logical_digest_sha256')!r})")

    blobs = block.get("blobs")
    P(isinstance(blobs, list),
      f"role {slug!r} served_math.blobs is not a list (got {type(blobs).__name__})")
    blobs = blobs if isinstance(blobs, list) else []
    envs = block.get("math_envs")
    P(isinstance(envs, list),
      f"role {slug!r} served_math.math_envs is not a list")
    envs = envs if isinstance(envs, list) else []
    P(len(set(map(str, envs))) == len(envs),
      f"role {slug!r} served_math.math_envs repeats a math_env: math_main is "
      "UNIQUE(zid, math_env), so one environment cannot have served two rows")
    P(_is_count(block.get("math_main_rows"))
      and block.get("math_main_rows") == len(blobs),
      f"role {slug!r} served_math declares {block.get('math_main_rows')!r} "
      f"math_main row(s) but lists {len(blobs)} blob(s): every served row "
      "carries exactly one blob")
    P(list(map(str, envs)) == [str(b.get("math_env")) for b in blobs
                               if isinstance(b, dict)],
      f"role {slug!r} served_math.math_envs {envs!r} does not match the blob "
      "list's environments in order")
    P(_is_count(block.get("math_ticks_rows")),
      f"role {slug!r} served_math.math_ticks_rows is not a count "
      f"(got {block.get('math_ticks_rows')!r})")

    seen_files: set[str] = set()
    for i, blob in enumerate(blobs):
        where = f"blobs[{i}]"
        if not isinstance(blob, dict):
            P(False, f"role {slug!r} served_math {where} is not an object")
            continue
        for unknown in sorted(set(blob) - SERVED_MATH_BLOB_KEYS):
            P(False, f"role {slug!r} served_math {where} carries unknown field "
                     f"{unknown!r}")
        for missing in sorted(SERVED_MATH_BLOB_KEYS - set(blob)):
            P(False, f"role {slug!r} served_math {where} is missing {missing!r}")
        name = blob.get("file")
        P(isinstance(name, str) and name not in seen_files,
          f"role {slug!r} served_math {where} names file {name!r} twice")
        seen_files.add(str(name))
        P(_is_count(blob.get("bytes")) and blob.get("bytes") != 0,
          f"role {slug!r} served_math {where} declares {blob.get('bytes')!r} "
          "bytes: an empty blob is not a served output")
        _digest_binds(where, name, blob.get("sha256"))

    consistency = block.get("consistency")
    P(isinstance(consistency, dict),
      f"role {slug!r} served_math.consistency is not an object")
    if isinstance(consistency, dict):
        P(consistency.get("gate") is False and consistency.get("kind") == "diagnostic",
          f"role {slug!r} served_math.consistency declares "
          f"kind={consistency.get('kind')!r} gate={consistency.get('gate')!r}: "
          "the served watermark check is a DIAGNOSTIC and must never be "
          "recorded as a gate — math_main is a latest-only upsert, so votes "
          "arriving after the last publish are the ordinary production case")
        per_env = consistency.get("per_math_env")
        P(isinstance(per_env, list) and len(per_env) == len(blobs),
          f"role {slug!r} served_math.consistency covers "
          f"{len(per_env) if isinstance(per_env, list) else '?'} environment(s) "
          f"for {len(blobs)} served row(s)")


def _failed_predicates(
    metrics: dict[str, Any], predicates: Sequence[dict[str, Any]],
) -> str:
    from polismath.replay import fixture_config as fc

    failed = [
        f"{p['metric']} {p['op']} {p['value']} (measured {metrics.get(p['metric'])!r})"
        for p in predicates
        if not fc.evaluate_predicates(metrics, [p])
    ]
    return "; ".join(failed) or "none"


def _admission_message(manifest: dict[str, Any], problems: Sequence[str]) -> str:
    name = manifest.get("bundle_id", "<unnamed>") if isinstance(manifest, dict) else "?"
    return (f"bundle {name} is NOT admissible:\n  - " + "\n  - ".join(problems))


def pull(
    store: ObjectStore, *, bundle_id: str, dest: Path,
    pins: dict[str, Any] | None = None, with_provenance: bool = False,
    provenance_role: str | None = None,
    config: dict[str, Any] | None = None, config_bytes: bytes | None = None,
    config_path: Path | None = None, admit: bool = True,
) -> dict[str, Any]:
    """Download, ADMIT and VERIFY a bundle into an empty ``dest``.

    Every object is fetched at its pinned version id, its sha256 is checked
    against the manifest BEFORE it is written, and every destination path is
    re-validated against traversal and symlinks. The manifest itself is verified
    against ``pins.json`` and then put through :func:`admit_manifest` before any
    payload path from it is trusted — hashes prove the bytes, admission proves
    the bytes are a bundle anyone should run.

    ``provenance_role`` is REQUIRED alongside ``with_provenance``: reading the
    restricted role->zid object needs a DIFFERENT IAM principal from reading the
    payload (see :class:`S3Store`), and the caller has to name the one it is
    exercising so the request is attributable. Payload-only pulls never touch
    the object.
    """
    if with_provenance and not provenance_role:
        raise BundleError(
            "pulling the restricted provenance object requires an explicit "
            "provenance_role: it is a SEPARATE IAM grant from payload read "
            "access, and the payload reader role is denied it")
    if provenance_role and not with_provenance:
        raise BundleError(
            "provenance_role was supplied without with_provenance; refusing to "
            "guess whether identities were wanted")
    dest = Path(dest)
    dest.mkdir(parents=True, exist_ok=True)
    if any(dest.iterdir()):
        raise BundleError(f"destination is not empty: {dest}")
    dest = dest.resolve()

    if pins is None:
        pins_bytes, _ = store.get(f"{bundle_id}/{PINS_KEY}")
        pins = json.loads(pins_bytes)
    if pins["bundle_id"] != bundle_id:
        raise VerificationError(
            f"pins name bundle {pins['bundle_id']!r}, asked for {bundle_id!r}")
    objects = pins["objects"]

    manifest_key = f"{bundle_id}/{MANIFEST_KEY}"
    manifest_bytes, _ = store.get(
        manifest_key, objects.get(manifest_key, {}).get("version_id"))
    if sha256_bytes(manifest_bytes) != pins["manifest_sha256"]:
        raise VerificationError("manifest hash does not match the pinned value")
    manifest = json.loads(manifest_bytes)
    if manifest["root_digest"] != pins["root_digest"]:
        raise VerificationError("manifest root digest does not match the pinned value")

    # Admission BEFORE any payload byte is written: a bundle that cannot be
    # admitted must not leave a half-populated workspace behind that an engine
    # could pick up.
    if admit:
        _admit_manifest_structure(manifest, config=config, config_bytes=config_bytes,
                                  config_path=config_path)

    payload_root = dest / "payload"
    payload_root.mkdir()
    for entry in manifest["files"]:
        rel = assert_safe_relpath(entry["path"])
        key = f"{bundle_id}/{DATA_PREFIX}{rel}"
        pin = objects.get(key)
        if pin is None:
            raise VerificationError(f"manifest file {rel} has no pinned object version")
        data, _ = store.get(key, pin["version_id"])
        actual = sha256_bytes(data)
        if actual != entry["sha256"] or actual != pin["sha256"]:
            raise VerificationError(
                f"hash mismatch for {rel}: manifest {entry['sha256']}, pin "
                f"{pin['sha256']}, downloaded {actual}")
        if len(data) != entry["size"]:
            raise VerificationError(
                f"size mismatch for {rel}: expected {entry['size']}, got {len(data)}")
        target = safe_join(payload_root, rel)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)

    (dest / MANIFEST_KEY).write_bytes(manifest_bytes)
    (dest / PINS_KEY).write_bytes(canonical_json(
        {k: v for k, v in pins.items() if k != "pins_object_version_id"}))

    verify(payload_root, manifest)

    result = {"bundle_id": bundle_id, "dest": str(dest),
              "payload_root": str(payload_root),
              "root_digest": manifest["root_digest"],
              "n_files": len(manifest["files"]),
              "provenance_pulled": False}

    if with_provenance:
        key = f"{bundle_id}/{PROVENANCE_KEY}"
        data, _ = store.get(key, objects.get(key, {}).get("version_id"))
        if sha256_bytes(data) != pins["provenance_sha256"]:
            raise VerificationError("provenance hash does not match the pinned value")
        # Identities on a shared runner disk: 0600, like the extractor writes
        # them, NEVER whatever the ambient umask happens to allow.
        os_umask_safe_write(dest / PROVENANCE_KEY, data)
        result["provenance_pulled"] = True
        result["provenance_role"] = provenance_role

    return result


# ---------------------------------------------------------------------------
# Public pin — the ONLY bundle facts that may be published.
# ---------------------------------------------------------------------------

#: Keys allowed to appear in the public pin. Anything else is a leak.
PUBLIC_PIN_KEYS = (
    "bundle_id", "root_digest", "config_sha256", "config_version",
    "schedule_hashes", "role_names", "coverage", "generator",
    "ordering_guarantee", "polarity",
)


def public_pin(manifest: dict[str, Any]) -> dict[str, Any]:
    """Render the public pin: bundle id, root digest, selector/policy/schedule
    hashes, role names and coverage obligations. NO zid, report id, participant
    id, timeline, vote row, blob or error dump — and no measured metric, which
    could fingerprint a conversation."""
    return {
        "bundle_id": manifest["bundle_id"],
        "root_digest": manifest["root_digest"],
        "config_version": manifest["commits"]["config_version"],
        "config_sha256": manifest["commits"]["config_sha256"],
        "schedule_hashes": {s["path"]: s["sha256"] for s in manifest.get("schedules", [])},
        "role_names": [r["role"] for r in manifest["roles"]],
        "coverage": {
            "roles_required": len(manifest["roles"]),
            "roles_resolved": sum(1 for r in manifest["roles"] if r.get("dir")),
            "coverage_role_map": manifest.get("coverage_role_map", {}),
            "generated_cases": [c["slug"] for c in manifest["generated"]["cases"]],
        },
        "generator": {
            "generator_id": manifest["generated"]["generator_id"],
            "generator_version": manifest["generated"]["generator_version"],
            "seed": manifest["generated"]["seed"],
        },
        "ordering_guarantee": manifest["ordering"]["guarantee"],
        "polarity": manifest["polarity"],
    }


def render_public_pin_markdown(pin: dict[str, Any]) -> str:
    """The block pasted into ``delphi/docs/CERTIFICATION.md``."""
    lines = [
        "<!-- BEGIN certification-bundle-pin (generated by "
        "`uv run python scripts/certify_data.py pin`) -->",
        f"- **Bundle id:** `{pin['bundle_id']}`",
        f"- **Root digest (sha256):** `{pin['root_digest']}`",
        f"- **Selector config:** `{pin['config_version']}` "
        f"sha256 `{pin['config_sha256']}`",
        f"- **Ordering guarantee:** `{pin['ordering_guarantee']}`",
        f"- **Storage/export polarity:** storage agree = "
        f"`{pin['polarity']['storage_agree_value']}`, export agree = "
        f"`{pin['polarity']['export_agree_value']}`",
        f"- **Generator:** `{pin['generator']['generator_id']}` "
        f"v`{pin['generator']['generator_version']}` seed `{pin['generator']['seed']}`",
        f"- **Coverage:** {pin['coverage']['roles_resolved']}/"
        f"{pin['coverage']['roles_required']} roles resolved; "
        f"{len(pin['coverage']['generated_cases'])} generated cases",
        "- **Schedule hashes:**",
    ]
    for path, digest in sorted(pin["schedule_hashes"].items()):
        lines.append(f"  - `{path}` sha256 `{digest}`")
    lines.append("- **Role names (coverage obligations):**")
    for name in pin["role_names"]:
        lines.append(f"  - `{name}`")
    lines.append("- **Retired coverage role -> new role:**")
    for old, new in sorted(pin["coverage"]["coverage_role_map"].items()):
        lines.append(f"  - `{old}` -> `{new}`")
    lines.append("<!-- END certification-bundle-pin -->")
    return "\n".join(lines) + "\n"


#: Hex runs of 16+ characters are SHA-256 digests and opaque directory
#: prefixes. They are not a channel through which an identifier can leak, and
#: a long decimal identifier will coincidentally appear inside enough random
#: hex to make an unfiltered scan flaky, so :func:`scan_public_output` removes
#: them before looking for planted identifiers.
_DIGEST_RE = re.compile(r"\b[0-9a-f]{16,}\b")


def scan_for_identifiers(text: str, planted: Iterable[str]) -> list[str]:
    """Return every planted synthetic identifier that appears in ``text``.

    Used by the redaction tests: seed the DB with recognisable synthetic zids /
    report ids, then assert this returns EMPTY for every public output.
    """
    return [needle for needle in planted if needle and needle in text]


def scan_public_output(text: str, planted: Iterable[str]) -> list[str]:
    """:func:`scan_for_identifiers` with SHA-256 digests and opaque directory
    prefixes removed first."""
    return scan_for_identifiers(_DIGEST_RE.sub("<digest>", text), planted)


#: ``restart_after`` is a ZERO-BASED index into the replay driver's resolved
#: steps, the convention ``polismath.replay.schedule.ReplayStep.index`` and
#: ``driver.run_replay`` already use (``driver.py`` compares
#: ``step.index == spec.restart_after``). The manifest and this module use the
#: SAME convention: index 0 is a legal seam after the first step, and the last
#: legal seam is ``expected_checkpoints - 2``, because a restart with no step
#: after it can never be observed.
RESTART_INDEX_BASE = "zero-based-step-index"


def collect_schedule_hashes(schedules_dir: Path) -> list[dict[str, Any]]:
    """Pin every FILE schedule, with its checkpoint count DERIVED from the same
    cut resolution the replay driver runs, rather than asserted.

    ``expected_checkpoints`` comes from
    :func:`polismath.replay.schedule.resolved_cut_count`, so duplicate and
    degenerate cut entries collapse here exactly as they do in
    :func:`~polismath.replay.schedule.slice_schedule`. Cut modes that resolve
    against ``dataset.n`` (``"end"``, ``timestamp``, ``fraction``) cannot be
    counted without the dataset; those entries record ``None`` and say so, and
    admission refuses to certify a checkpoint inventory it could not derive.

    ``restart_after`` is recorded and validated as a ZERO-BASED step index
    (:data:`RESTART_INDEX_BASE`).

    Coverage limit, recorded in the manifest's ``admission.schedule_coverage``
    and re-stated here so it cannot be forgotten: the certification battery also
    runs inline preset schedules, which are not files and are therefore not
    hashed by this function. Wiring the presets into the pinned inventory is
    section B's work; until then a bundle pins the file schedules only.
    """
    from polismath.replay import schedule as sched

    out: list[dict[str, Any]] = []
    if not schedules_dir.is_dir():
        return out
    for path in sorted(schedules_dir.glob("*.json")):
        data = json.loads(path.read_text())
        cuts = data.get("cuts", {})
        resolved = sched.resolved_cut_count(cuts)
        out.append({
            "path": f"schedules/{path.name}",
            "sha256": sha256_file(path),
            "schedule_id": data.get("schedule_id"),
            "dataset": data.get("dataset"),
            "cuts_mode": cuts.get("mode"),
            "n_cuts": resolved,
            # Derived by schedule.py's own resolution: one checkpoint per step.
            "expected_checkpoints": resolved,
            "cuts_resolvable_without_dataset": resolved is not None,
            "restart_after": data.get("restart_after"),
            "restart_index_base": RESTART_INDEX_BASE,
            "moderation": data.get("moderation"),
        })
    return out


def os_umask_safe_write(path: Path, data: bytes) -> None:
    """Write private artefacts 0600 so a shared runner disk does not leak them."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(fd, data)
    finally:
        os.close(fd)
