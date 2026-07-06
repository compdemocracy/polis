"""Wire codec for Delphi Storage V2 payloads.

Cross-language contract (mirrored by server/src/storage/delphi/codec.ts and
pinned by delphi_storage/conformance/cases/codec_*.json):

- canonical JSON: sorted keys, compact separators, UTF-8, no NaN/Infinity;
- packed floats: little-endian IEEE-754 float64;
- compression: zstd frames (with content size);
- payload envelopes: ``meta`` (JSON attributes) + optional binary ``blob``:
    - ``{"enc": "json", "body": <value>}``            — inline, no blob
    - ``{"enc": "json+zstd", "bytes", "sha256"}``     — blob = zstd(canonical JSON)
    - ``{"enc": "f64+zstd", "count", "bytes", "sha256"}`` — blob = zstd(packed f64)
  ``bytes``/``sha256`` describe the UNCOMPRESSED payload (compressed bytes are
  never compared or hashed: zstd output varies across implementations).

DynamoDB number helpers (``to_dynamo``/``from_dynamo``) follow the existing
Decimal(str(x)) convention (polismath/database/dynamodb.py,
umap_narrative .../utils/converter.py) — numbers round-trip by value.
"""

import hashlib
import json
import math
import struct
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any, Optional, Sequence

import zstandard

#: Canonical-JSON bodies up to this many UTF-8 bytes are stored inline;
#: larger ones are zstd-compressed into the blob.
INLINE_LIMIT = 65536

_ZSTD_LEVEL = 3


def canonical_json_dumps(obj: Any) -> str:
    return json.dumps(
        obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False
    )


def pack_f64(values: Sequence[float]) -> bytes:
    return struct.pack(f"<{len(values)}d", *values)


def unpack_f64(data: bytes) -> list[float]:
    if len(data) % 8:
        raise ValueError(f"packed f64 length must be a multiple of 8, got {len(data)}")
    return list(struct.unpack(f"<{len(data) // 8}d", data))


def compress(data: bytes) -> bytes:
    return zstandard.ZstdCompressor(level=_ZSTD_LEVEL).compress(data)


def decompress(data: bytes) -> bytes:
    return zstandard.ZstdDecompressor().decompress(data)


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


@dataclass
class F64:
    """Marker wrapper: encode this payload as a packed float64 array."""

    values: list[float] = field(default_factory=list)


@dataclass
class EncodedPayload:
    meta: dict[str, Any]
    blob: Optional[bytes]


def encode_payload(value: Any, force: Optional[str] = None) -> EncodedPayload:
    """Encode a payload for storage. ``force`` pins the encoding
    ('json', 'json+zstd'); by default small JSON stays inline."""
    if isinstance(value, F64):
        packed = pack_f64(value.values)
        return EncodedPayload(
            meta={
                "enc": "f64+zstd",
                "count": len(value.values),
                "bytes": len(packed),
                "sha256": _sha256(packed),
            },
            blob=compress(packed),
        )
    raw = canonical_json_dumps(value).encode("utf-8")
    if force == "json" or (force is None and len(raw) <= INLINE_LIMIT):
        return EncodedPayload(meta={"enc": "json", "body": value}, blob=None)
    if force not in (None, "json+zstd"):
        raise ValueError(f"unknown forced encoding {force!r}")
    return EncodedPayload(
        meta={"enc": "json+zstd", "bytes": len(raw), "sha256": _sha256(raw)},
        blob=compress(raw),
    )


def decode_payload(meta: dict[str, Any], blob: Optional[bytes]) -> Any:
    enc = meta.get("enc")
    if enc == "json":
        return meta["body"]
    if enc in ("json+zstd", "f64+zstd"):
        if blob is None:
            raise ValueError(f"encoding {enc} requires a blob")
        raw = decompress(blob)
        expected_sha = meta.get("sha256")
        if expected_sha is not None and _sha256(raw) != expected_sha:
            raise ValueError("payload sha256 mismatch — corrupt blob")
        expected_bytes = meta.get("bytes")
        if expected_bytes is not None and len(raw) != expected_bytes:
            raise ValueError("payload length mismatch — corrupt blob")
        if enc == "json+zstd":
            return json.loads(raw.decode("utf-8"))
        return unpack_f64(raw)
    raise ValueError(f"unknown payload encoding {enc!r}")


def to_dynamo(obj: Any) -> Any:
    """Recursively convert floats to Decimal(str(x)) for DynamoDB writes."""
    if isinstance(obj, bool):
        return obj
    if isinstance(obj, float):
        if not math.isfinite(obj):
            raise ValueError(f"non-finite float not storable: {obj!r}")
        return Decimal(str(obj))
    if isinstance(obj, dict):
        return {k: to_dynamo(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [to_dynamo(v) for v in obj]
    return obj


def from_dynamo(obj: Any) -> Any:
    """Recursively convert DynamoDB Decimals back to int/float by value."""
    if isinstance(obj, Decimal):
        as_int = int(obj)
        return as_int if obj == as_int else float(obj)
    if isinstance(obj, dict):
        return {k: from_dynamo(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [from_dynamo(v) for v in obj]
    return obj
