"""The comment-embeddings spool, byte-for-byte the same layout as the daemon's
Rust ``jobs::embedding`` (migration 000038). One bounded, regular file carries
embeddings in both directions behind the flag:

  * the writer (``graph_embed``, the legacy pipeline) packs the comments it just
    embedded and the daemon routes them into ``pd_embedding_put``/``close``;
  * the daemon streams a closed set out by binary COPY, rewrites it here, and the
    reader (``graph_cluster``) reads it instead of the codec family.

Stdlib only (``struct``/``hashlib``), so the sandboxed graph stage can load it the
same way it loads the codec. No float is ever reserialized as JSON.

Layout (little-endian), matching ``queue-rs/src/jobs/embedding.rs``:
    magic      8 bytes  b"PLEMBSP1"
    dims       uint16   1..=2000
    row_count  uint32
    model_len  uint16   1..=200
    model      model_len bytes, UTF-8
    then row_count rows, each:
      tid        int32   >= 0
      text_sha   32 bytes
      vector     dims * float32
"""
from __future__ import annotations

import struct

MAGIC = b"PLEMBSP1"
MAX_SPOOL_BYTES = 268_435_456
MAX_DIMS = 2000
MAX_MODEL = 200
PUT_CHUNK = 4096


def write_spool(model, dims, rows):
    """Pack ``rows`` (each ``(tid:int, text_sha:bytes[32], vector:sequence[float])``)
    into the spool bytes. Vectors narrow to float32, exactly as the table stores
    them, so the daemon's digest over the stored rows reproduces."""
    if not 1 <= dims <= MAX_DIMS:
        raise ValueError("embedding spool dims out of range")
    model_bytes = model.encode("utf-8")
    if not 1 <= len(model_bytes) <= MAX_MODEL:
        raise ValueError("embedding spool model out of range")
    rows = list(rows)
    out = bytearray(MAGIC)
    out += struct.pack("<HIH", dims, len(rows), len(model_bytes))
    out += model_bytes
    packer = struct.Struct("<%df" % dims)
    for tid, text_sha, vector in rows:
        if tid < 0:
            raise ValueError("embedding spool tid negative")
        if len(text_sha) != 32:
            raise ValueError("embedding spool text_sha must be 32 bytes")
        if len(vector) != dims:
            raise ValueError("embedding spool vector width")
        out += struct.pack("<i", tid)
        out += text_sha
        out += packer.pack(*vector)
    if len(out) > MAX_SPOOL_BYTES:
        raise ValueError("embedding spool byte limit")
    return bytes(out)


def read_spool(data):
    """Parse spool bytes into ``(model, dims, rows)`` where each row is
    ``{"tid", "text_sha" (bytes), "vector" (list[float])}``. Refuses any
    unexpected magic, bound, width or trailing byte."""
    if len(data) > MAX_SPOOL_BYTES:
        raise ValueError("embedding spool byte limit")
    if data[:8] != MAGIC:
        raise ValueError("embedding spool magic")
    dims, row_count, model_len = struct.unpack_from("<HIH", data, 8)
    if not 1 <= dims <= MAX_DIMS:
        raise ValueError("embedding spool dims out of range")
    if not 1 <= model_len <= MAX_MODEL:
        raise ValueError("embedding spool model out of range")
    at = 16
    model = data[at : at + model_len].decode("utf-8")
    at += model_len
    unpacker = struct.Struct("<%df" % dims)
    stride = 4 + 32 + dims * 4
    rows = []
    for _ in range(row_count):
        (tid,) = struct.unpack_from("<i", data, at)
        if tid < 0:
            raise ValueError("embedding spool tid negative")
        text_sha = data[at + 4 : at + 36]
        vector = list(unpacker.unpack_from(data, at + 36))
        rows.append({"tid": tid, "text_sha": text_sha, "vector": vector})
        at += stride
    if at != len(data):
        raise ValueError("embedding spool trailing bytes")
    return model, dims, rows
