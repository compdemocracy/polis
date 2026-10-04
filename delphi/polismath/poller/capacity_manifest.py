"""The capacity manifest: the small poller's routed conversations, handed to
the large memory class (P-073 §4.2).

One private JSON object, written only by the small poller's primary (the
holder of the served label's single-writer lock) and read by the large
worker. It names zids, so it lives only in a private store: never in a log
line, a metric or a receipt.

Two backends behind one interface (``ManifestStore``):

  ``s3://<bucket>/<key>``  an object in an existing private bucket (the bucket
                           the Delphi service already uses, ``AWS_S3_BUCKET_NAME``;
                           the recommended key is ``math-capacity/<label>/manifest.json``).
                           The client follows the existing Delphi pattern:
                           ``AWS_S3_ENDPOINT`` (MinIO under docker) and
                           ``AWS_REGION``; credentials from the environment
                           or the instance role.
  ``file:///<path>``       a local file (tests, and docker runs that share a
  (or an absolute path)    volume). Same conditional-write semantics, under
                           an exclusive ``fcntl`` lock beside the file.

Writes are conditional: ``If-Match`` on the ETag the writer last read, or
``If-None-Match: *`` to create. A precondition failure raises
``ManifestConflict`` and nothing is written. Reads can be conditional too
(``If-None-Match``): an unchanged object returns ``NOT_MODIFIED``.

The pinned boto3 (1.34.x) predates the ``IfMatch``/``IfNoneMatch`` parameters
on ``PutObject``, so the S3 backend sets the two headers itself through
botocore's event hooks (they are ordinary HTTP preconditions; S3 and MinIO
honour them and answer 412).
"""

from __future__ import annotations

import errno
import hashlib
import json
import os
import re
import threading
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

MANIFEST_SCHEMA = "polis-math-capacity-manifest/1"
MAX_BYTES = 4 * 1024 * 1024
MAX_ENTRIES = 1000

_HEX12 = re.compile(r"[0-9a-f]{12}")
_HEX16 = re.compile(r"[0-9a-f]{16}")
_HEX40 = re.compile(r"[0-9a-f]{40}")
_NONCE = re.compile(r"[0-9a-f]{16,64}")
_LABEL = re.compile(r"[A-Za-z0-9_.-]{1,64}")

ENTRY_KEYS = ("zid", "votes", "voters", "comments", "need_bytes", "input_through_ms",
              "first_unresolved_ms", "exceeds_largest")
WRITER_KEYS = ("label", "run", "source_commit", "binding", "small_capacity_bytes",
               "large_budget_bytes")
TOP_KEYS = ("schema", "generation", "written_ms", "writer", "staged_label", "restage", "entries")


class ManifestError(ValueError):
    """The manifest does not have the closed shape."""


class ManifestConflict(RuntimeError):
    """A conditional write lost: the object changed (or exists) since it was read."""


class _NotModified:
    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return "NOT_MODIFIED"


NOT_MODIFIED = _NotModified()


# --------------------------------------------------------------------------- #
# The document
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class Entry:
    zid: int
    need_bytes: int
    votes: Optional[int] = None
    voters: Optional[int] = None
    comments: Optional[int] = None
    input_through_ms: Optional[int] = None
    first_unresolved_ms: Optional[int] = None
    exceeds_largest: bool = False

    def as_dict(self) -> Dict[str, Any]:
        return {k: getattr(self, k) for k in ENTRY_KEYS}


@dataclass(frozen=True)
class Writer:
    label: str
    binding: str
    run: Optional[str] = None
    source_commit: Optional[str] = None
    small_capacity_bytes: Optional[int] = None
    large_budget_bytes: Optional[int] = None

    def as_dict(self) -> Dict[str, Any]:
        return {k: getattr(self, k) for k in WRITER_KEYS}


@dataclass(frozen=True)
class Manifest:
    generation: int
    written_ms: int
    writer: Writer
    staged_label: str
    entries: Tuple[Entry, ...] = field(default_factory=tuple)
    restage: Optional[str] = None

    def as_dict(self) -> Dict[str, Any]:
        return {
            "schema": MANIFEST_SCHEMA, "generation": self.generation,
            "written_ms": self.written_ms, "writer": self.writer.as_dict(),
            "staged_label": self.staged_label, "restage": self.restage,
            "entries": [e.as_dict() for e in sorted(self.entries, key=lambda e: e.zid)],
        }

    def encode(self) -> bytes:
        return json.dumps(self.as_dict(), sort_keys=True, separators=(",", ":"),
                          allow_nan=False).encode()

    def content_key(self) -> str:
        """What a reader acts on: everything but the generation and the write
        time. A writer skips a write that would not change it."""
        body = self.as_dict()
        body.pop("generation")
        body.pop("written_ms")
        return json.dumps(body, sort_keys=True, separators=(",", ":"))


def _int(v: Any, nullable: bool = False) -> bool:
    return (v is None and nullable) or (type(v) is int and v >= 0)


def _closed(obj: Any, keys) -> None:
    if not isinstance(obj, dict) or set(obj) != set(keys):
        raise ManifestError(f"expected keys {sorted(keys)}")


def parse(raw: bytes) -> Manifest:
    """The validated manifest; ManifestError for anything else."""
    if len(raw) > MAX_BYTES:
        raise ManifestError("manifest too large")
    try:
        body = json.loads(raw)
    except (ValueError, UnicodeDecodeError) as exc:
        raise ManifestError("manifest is not JSON") from exc
    _closed(body, TOP_KEYS)
    if body["schema"] != MANIFEST_SCHEMA:
        raise ManifestError("unknown manifest schema")
    if not _int(body["generation"]) or not _int(body["written_ms"]):
        raise ManifestError("bad generation or written_ms")
    if not isinstance(body["staged_label"], str) or not _LABEL.fullmatch(body["staged_label"]):
        raise ManifestError("bad staged_label")
    if body["restage"] is not None and not (isinstance(body["restage"], str)
                                            and _NONCE.fullmatch(body["restage"])):
        raise ManifestError("bad restage nonce")
    w = body["writer"]
    _closed(w, WRITER_KEYS)
    if not isinstance(w["label"], str) or not _LABEL.fullmatch(w["label"]):
        raise ManifestError("bad writer label")
    if not isinstance(w["binding"], str) or not _HEX16.fullmatch(w["binding"]):
        raise ManifestError("bad writer binding")
    if w["run"] is not None and not (isinstance(w["run"], str) and _HEX12.fullmatch(w["run"])):
        raise ManifestError("bad writer run")
    if w["source_commit"] is not None and not (isinstance(w["source_commit"], str)
                                               and _HEX40.fullmatch(w["source_commit"])):
        raise ManifestError("bad writer source_commit")
    for k in ("small_capacity_bytes", "large_budget_bytes"):
        if not _int(w[k], nullable=True):
            raise ManifestError(f"bad writer {k}")
    rows = body["entries"]
    if not isinstance(rows, list) or len(rows) > MAX_ENTRIES:
        raise ManifestError("bad entries")
    entries: List[Entry] = []
    seen = set()
    for row in rows:
        _closed(row, ENTRY_KEYS)
        if not _int(row["zid"]) or not _int(row["need_bytes"]):
            raise ManifestError("bad entry zid or need_bytes")
        for k in ("votes", "voters", "comments", "input_through_ms", "first_unresolved_ms"):
            if not _int(row[k], nullable=True):
                raise ManifestError(f"bad entry {k}")
        if type(row["exceeds_largest"]) is not bool:
            raise ManifestError("bad entry exceeds_largest")
        if row["zid"] in seen:
            raise ManifestError("duplicate entry zid")
        seen.add(row["zid"])
        entries.append(Entry(**row))
    return Manifest(
        generation=body["generation"], written_ms=body["written_ms"],
        writer=Writer(**w), staged_label=body["staged_label"],
        entries=tuple(entries), restage=body["restage"])


def etag_of(raw: bytes) -> str:
    return '"' + hashlib.md5(raw).hexdigest() + '"'  # noqa: S324 - an ETag, not security


# --------------------------------------------------------------------------- #
# Stores
# --------------------------------------------------------------------------- #
class ManifestStore:
    """``read(if_none_match)`` -> (raw bytes or None when absent, etag) or
    NOT_MODIFIED; ``write(raw, if_match)`` -> new etag. ``if_match`` None means
    create-only. Raises ManifestConflict when the precondition fails."""

    uri: str = ""

    def read(self, if_none_match: Optional[str] = None):  # pragma: no cover - interface
        raise NotImplementedError

    def write(self, raw: bytes, if_match: Optional[str]) -> str:  # pragma: no cover
        raise NotImplementedError

    def describe(self) -> str:
        """The backend without the location (the location names a bucket)."""
        return self.__class__.__name__


class FileManifestStore(ManifestStore):
    """A local file with the same conditional semantics as the S3 object.
    The ETag is the MD5 of the bytes (as S3 reports for a single-part put)."""

    def __init__(self, path: str) -> None:
        self.path = path
        self.uri = "file://" + path
        self._lock_path = path + ".lock"
        self._thread_lock = threading.Lock()

    def _read_raw(self) -> Optional[bytes]:
        try:
            with open(self.path, "rb") as fh:
                raw = fh.read(MAX_BYTES + 1)
        except OSError as exc:
            if exc.errno == errno.ENOENT:
                return None
            raise
        return raw

    def read(self, if_none_match: Optional[str] = None):
        raw = self._read_raw()
        if raw is None:
            return None, None
        tag = etag_of(raw)
        if if_none_match is not None and if_none_match == tag:
            return NOT_MODIFIED
        return raw, tag

    def write(self, raw: bytes, if_match: Optional[str]) -> str:
        import fcntl

        if len(raw) > MAX_BYTES:
            raise ManifestError("manifest too large")
        directory = os.path.dirname(self.path) or "."
        os.makedirs(directory, exist_ok=True)
        with self._thread_lock, open(self._lock_path, "a+") as lock:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
            try:
                current = self._read_raw()
                if if_match is None:
                    if current is not None:
                        raise ManifestConflict("manifest exists")
                elif current is None or etag_of(current) != if_match:
                    raise ManifestConflict("manifest changed since it was read")
                tmp = f"{self.path}.{os.getpid()}.{threading.get_ident()}.tmp"
                with open(tmp, "wb") as fh:
                    fh.write(raw)
                    fh.flush()
                    os.fsync(fh.fileno())
                os.replace(tmp, self.path)
            finally:
                fcntl.flock(lock.fileno(), fcntl.LOCK_UN)
        return etag_of(raw)


_COND_KEYS = ("PolisIfMatch", "PolisIfNoneMatch")
_COND_HEADERS = {"PolisIfMatch": "If-Match", "PolisIfNoneMatch": "If-None-Match"}


def _stash_conditions(params: Dict[str, Any], context: Dict[str, Any], **_kw: Any) -> None:
    """before-parameter-build: move our condition keys out of the API params
    (parameter validation would refuse them) into the request context."""
    for key in _COND_KEYS:
        if key in params:
            context[key] = params.pop(key)


def _apply_conditions(params: Dict[str, Any], context: Dict[str, Any], **_kw: Any) -> None:
    """before-call: the conditions become HTTP headers (signed with the rest)."""
    for key, header in _COND_HEADERS.items():
        value = context.get(key)
        if value is not None:
            params.setdefault("headers", {})[header] = value


def install_conditional_put(client: Any) -> Any:
    """Teach a boto3 S3 client the ``PolisIfMatch``/``PolisIfNoneMatch``
    PutObject parameters. Idempotent per client."""
    if getattr(client, "_polis_conditional_put", False):
        return client
    events = client.meta.events
    events.register("before-parameter-build.s3.PutObject", _stash_conditions)
    events.register("before-call.s3.PutObject", _apply_conditions)
    client._polis_conditional_put = True
    return client


def default_s3_client() -> Any:
    """The existing Delphi pattern: AWS_S3_ENDPOINT (MinIO locally) and
    AWS_REGION; path-style addressing against a custom endpoint; short
    timeouts so a slow store never holds a poller thread for long."""
    import boto3
    from botocore.config import Config

    endpoint = (os.environ.get("AWS_S3_ENDPOINT") or "").strip() or None
    config = Config(connect_timeout=5, read_timeout=15, retries={"max_attempts": 2},
                    signature_version="s3v4",
                    s3={"addressing_style": "path"} if endpoint else None)
    kwargs: Dict[str, Any] = {"region_name": os.environ.get("AWS_REGION", "us-east-1"),
                              "config": config}
    if endpoint:
        kwargs["endpoint_url"] = endpoint
    return boto3.client("s3", **kwargs)


def _error_code(exc: BaseException) -> str:
    response = getattr(exc, "response", None) or {}
    code = str((response.get("Error") or {}).get("Code") or "")
    status = (response.get("ResponseMetadata") or {}).get("HTTPStatusCode")
    return code or (str(status) if status is not None else "")


class S3ManifestStore(ManifestStore):
    def __init__(self, bucket: str, key: str, client: Any = None) -> None:
        if not bucket or not key:
            raise ValueError("an s3 manifest URI needs a bucket and a key")
        self.bucket = bucket
        self.key = key
        self.uri = f"s3://{bucket}/{key}"
        self._client = client

    @property
    def client(self) -> Any:
        if self._client is None:
            self._client = default_s3_client()
        return install_conditional_put(self._client)

    def read(self, if_none_match: Optional[str] = None):
        kwargs: Dict[str, Any] = {"Bucket": self.bucket, "Key": self.key}
        if if_none_match is not None:
            kwargs["IfNoneMatch"] = if_none_match
        try:
            resp = self.client.get_object(**kwargs)
        except Exception as exc:  # noqa: BLE001 - classified below
            code = _error_code(exc)
            if code in ("304", "NotModified"):
                return NOT_MODIFIED
            if code in ("NoSuchKey", "404", "NotFound"):
                return None, None
            raise
        body = resp["Body"]
        try:
            raw = body.read(MAX_BYTES + 1)
        finally:
            close = getattr(body, "close", None)
            if close is not None:
                close()
        return raw, resp.get("ETag") or etag_of(raw)

    def write(self, raw: bytes, if_match: Optional[str]) -> str:
        if len(raw) > MAX_BYTES:
            raise ManifestError("manifest too large")
        kwargs: Dict[str, Any] = {"Bucket": self.bucket, "Key": self.key, "Body": raw,
                                  "ContentType": "application/json"}
        if if_match is None:
            kwargs["PolisIfNoneMatch"] = "*"
        else:
            kwargs["PolisIfMatch"] = if_match
        try:
            resp = self.client.put_object(**kwargs)
        except Exception as exc:  # noqa: BLE001 - classified below
            if _error_code(exc) in ("PreconditionFailed", "412", "ConditionalRequestConflict",
                                    "409"):
                raise ManifestConflict("manifest changed since it was read") from exc
            raise
        return resp.get("ETag") or etag_of(raw)


def open_store(uri: str, *, s3_client: Any = None) -> ManifestStore:
    """``s3://bucket/key``, ``file:///abs/path`` or an absolute path."""
    uri = (uri or "").strip()
    if uri.startswith("s3://"):
        bucket, _, key = uri[len("s3://"):].partition("/")
        return S3ManifestStore(bucket, key, client=s3_client)
    if uri.startswith("file://"):
        path = uri[len("file://"):]
    else:
        path = uri
    if not path.startswith("/"):
        raise ValueError("a manifest URI is s3://bucket/key, file:///abs/path or an absolute path")
    return FileManifestStore(path)


__all__ = [
    "Entry", "FileManifestStore", "MANIFEST_SCHEMA", "Manifest", "ManifestConflict",
    "ManifestError", "ManifestStore", "NOT_MODIFIED", "S3ManifestStore", "Writer", "etag_of",
    "install_conditional_put", "open_store", "parse",
]
