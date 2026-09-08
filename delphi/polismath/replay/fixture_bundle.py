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

Immutability is enforced by the PUBLISHER, not by S3 versioning: :func:`push`
refuses to write any key that already exists with different bytes, and refuses
a bundle id whose manifest already exists with different bytes. S3 versioning
only lets a reader pin the exact bytes it verified.

:func:`pull` verifies EVERY hash before any engine may use the data, and
rejects path traversal, absolute paths and symlinks in both the object keys and
the destination tree. :func:`verify` fails on corrupted, truncated, missing AND
extra files.

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
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Sequence

MANIFEST_SCHEMA_VERSION = "certify-fixture-manifest/1"
PROVENANCE_SCHEMA_VERSION = "certify-fixture-provenance/1"
PINS_SCHEMA_VERSION = "certify-fixture-pins/1"

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


class VerificationError(BundleError):
    """A file is missing, extra, truncated or does not match its recorded hash."""


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
) -> dict[str, Any]:
    """The PRIVATE manifest. It records everything P-022 A lists EXCEPT the
    role -> zid mapping, which lives in the separate restricted provenance
    object (:func:`build_provenance`) because ordinary test execution does not
    need identities."""
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
        "polarity": {
            "storage_agree_value": -1,
            "export_agree_value": 1,
            "boundaries": [
                "storage: server/postgres/migrations/000000_initial.sql votes.vote",
                "export: polismath/replay/prodclone.py format_votes_rows negates the sign",
                "ingress: polismath/database/postgres.py conversion site",
            ],
        },
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
        ],
        "retention": "Retained for the supported lifetime of the certificate. "
                     "Retirement requires an explicit privacy-approved decision, "
                     "never a short artifact TTL.",
    }


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
    """Minimal versioned-object interface used by push/pull."""

    def exists(self, key: str) -> bool:  # pragma: no cover - interface
        raise NotImplementedError

    def get(self, key: str, version_id: str | None = None) -> tuple[bytes, str]:  # pragma: no cover
        raise NotImplementedError

    def put(self, key: str, data: bytes) -> PutResult:  # pragma: no cover
        raise NotImplementedError


class LocalStore(ObjectStore):
    """Filesystem stand-in for S3, used by the test suite and by an air-gapped
    orchestrator. Version ids are content digests, which is exactly the pinning
    property the S3 VersionId provides."""

    def __init__(self, root: Path):
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


class S3Store(ObjectStore):
    """Real S3. The publisher needs ``s3:PutObject``/``s3:GetObject`` on
    ``<bucket>/<bundle-id>/*``; test readers need ``s3:GetObject`` and
    ``s3:GetObjectVersion`` ONLY — never PutObject or DeleteObject, so a reader
    cannot overwrite or delete a bundle."""

    def __init__(self, bucket: str, prefix: str = "", client=None):
        import boto3

        self.bucket = bucket
        self.prefix = prefix.rstrip("/") + "/" if prefix else ""
        self.client = client or boto3.client("s3")

    def _key(self, key: str) -> str:
        return self.prefix + key

    def exists(self, key: str) -> bool:
        try:
            self.client.head_object(Bucket=self.bucket, Key=self._key(key))
            return True
        except Exception:  # noqa: BLE001 - any head failure means "not readable"
            return False

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
    """Write ``key`` only if it does not already exist with DIFFERENT bytes."""
    if store.exists(key):
        existing, version = store.get(key)
        if existing == data:
            return PutResult(key=key, version_id=version, sha256=sha256_bytes(data))
        raise ImmutabilityError(
            f"refusing to republish {key}: it already exists with different bytes "
            f"(existing sha256 {sha256_bytes(existing)}, new {sha256_bytes(data)}). "
            "Publish a NEW bundle id instead."
        )
    return store.put(key, data)


def push(
    store: ObjectStore, *, bundle_id: str, payload_root: Path,
    manifest: dict[str, Any], provenance: dict[str, Any],
) -> dict[str, Any]:
    """Publish a bundle immutably and return the pins record.

    Every data object is uploaded first (so ``pins.json`` can name their exact
    version ids), then the manifest, then the restricted provenance object, then
    ``pins.json`` last. Any key that already exists with different bytes aborts
    the whole publication.
    """
    if manifest["bundle_id"] != bundle_id or provenance["bundle_id"] != bundle_id:
        raise BundleError("bundle_id mismatch between arguments and manifest/provenance")

    payload_root = Path(payload_root).resolve()
    objects: dict[str, dict[str, str]] = {}

    for entry in manifest["files"]:
        rel = assert_safe_relpath(entry["path"])
        local = safe_join(payload_root, rel)
        data = local.read_bytes()
        if sha256_bytes(data) != entry["sha256"]:
            raise VerificationError(
                f"payload changed under us: {rel} no longer matches its manifest hash")
        result = _put_immutable(store, f"{bundle_id}/{DATA_PREFIX}{rel}", data)
        objects[result.key] = {"version_id": result.version_id, "sha256": result.sha256}

    manifest_bytes = canonical_json(manifest)
    m = _put_immutable(store, f"{bundle_id}/{MANIFEST_KEY}", manifest_bytes)
    objects[m.key] = {"version_id": m.version_id, "sha256": m.sha256}

    provenance_bytes = canonical_json(provenance)
    p = _put_immutable(store, f"{bundle_id}/{PROVENANCE_KEY}", provenance_bytes)
    objects[p.key] = {"version_id": p.version_id, "sha256": p.sha256}

    pins = {
        "schema_version": PINS_SCHEMA_VERSION,
        "bundle_id": bundle_id,
        "root_digest": manifest["root_digest"],
        "manifest_sha256": m.sha256,
        "provenance_sha256": p.sha256,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "objects": objects,
    }
    pins_result = _put_immutable(store, f"{bundle_id}/{PINS_KEY}", canonical_json(pins))
    pins["pins_object_version_id"] = pins_result.version_id
    return pins


def verify(payload_root: Path, manifest: dict[str, Any]) -> None:
    """Verify a LOCAL payload tree against ``manifest``.

    Fails on corrupted, truncated, missing AND extra files; a truncated file
    fails on both its size and its hash, and each is reported.
    """
    payload_root = Path(payload_root).resolve()
    expected = {e["path"]: e for e in manifest["files"]}
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

    if problems:
        raise VerificationError(
            f"bundle {manifest['bundle_id']} failed verification:\n  - "
            + "\n  - ".join(problems))


def pull(
    store: ObjectStore, *, bundle_id: str, dest: Path,
    pins: dict[str, Any] | None = None, with_provenance: bool = False,
) -> dict[str, Any]:
    """Download and VERIFY a bundle into an empty ``dest``.

    Every object is fetched at its pinned version id, its sha256 is checked
    against the manifest BEFORE it is written, and every destination path is
    re-validated against traversal and symlinks. The manifest itself is verified
    against ``pins.json`` before any payload path from it is trusted.
    """
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
        (dest / PROVENANCE_KEY).write_bytes(data)
        result["provenance_pulled"] = True

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


def scan_for_identifiers(text: str, planted: Iterable[str]) -> list[str]:
    """Return every planted synthetic identifier that appears in ``text``.

    Used by the redaction tests: seed the DB with recognisable synthetic zids /
    report ids, then assert this returns EMPTY for every public output.
    """
    return [needle for needle in planted if needle and needle in text]


def collect_schedule_hashes(schedules_dir: Path) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    if not schedules_dir.is_dir():
        return out
    for path in sorted(schedules_dir.glob("*.json")):
        data = json.loads(path.read_text())
        cuts = data.get("cuts", {}).get("at", [])
        out.append({
            "path": f"schedules/{path.name}",
            "sha256": sha256_file(path),
            "schedule_id": data.get("schedule_id"),
            "dataset": data.get("dataset"),
            "expected_checkpoints": len(cuts) if cuts else 1,
            "restart_after": data.get("restart_after"),
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
