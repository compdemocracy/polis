"""Storage V2 artifact builder/writer for the MATH stage (P7b, design §4.2).

Derives the v2 artifacts from the SAME objects the legacy writer consumes —
``conv.to_dynamo_dict()`` output (already Decimal-ized), ``conv.proj`` and
``conv.group_clusters`` — so the two write paths cannot see different data.
The parity checker (scripts/verify_dual_write.py) reads BOTH stores back
independently, so a bug in this module's join logic surfaces there instead
of hiding.

Artifact keys (design §4.2): math#pca, math#kmeans, math#repness,
math#routing#<chunk>, math#projections#<chunk>. Projections are logically
chunked (per-participant rows; 18k+ participants happen in production —
Pakistan) on top of the byte-level auto-chunking the DynamoDB backend
already does for >300KB blobs.
"""

import logging
from decimal import Decimal
from typing import Any

from delphi_storage.codec import encode_payload
from delphi_storage.interface import DelphiStore, NotFound
from delphi_storage.models import StoreItem

logger = logging.getLogger(__name__)


def _jsonable(value: Any) -> Any:
    """Decimal AND numpy → plain JSON values, recursively. Production
    conv.proj values are numpy arrays (the legacy writer runs _numpy_to_list
    on them) and dynamo_data mixes Decimals with numpy scalars — the codec's
    canonical JSON rejects both."""
    if isinstance(value, Decimal):
        as_int = int(value)
        return as_int if value == as_int else float(value)
    if hasattr(value, "tolist"):  # numpy arrays AND numpy scalars
        return _jsonable(value.tolist())
    if isinstance(value, dict):
        return {key: _jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(item) for item in value]
    return value

#: Participants per math#projections#<chunk> artifact (~0.1KB/row → ~500KB
#: JSON pre-zstd at the default; the backend byte-chunker handles the rest).
PROJECTIONS_CHUNK_SIZE = 5000

#: Comments per math#routing#<chunk> artifact (usually a single chunk).
ROUTING_CHUNK_SIZE = 5000


def _chunked(rows: list, size: int) -> list:
    return [rows[i : i + size] for i in range(0, max(len(rows), 1), size)]


def _participant_groups(group_clusters) -> dict:
    """participant -> group_id, EXACTLY as the legacy writer builds it:
    keyed by the RAW member values with no type coercion. If conv.proj keys
    and cluster members disagree on type (str vs int), lookups miss and the
    row gets -1 — that is legacy behavior, reproduced deliberately so
    verify_dual_write holds (quirk parity, see IMPLEMENTATION_NOTES §1)."""
    mapping: dict = {}
    for cluster in group_clusters or []:
        group_id = cluster.get("id", 0)
        for member in cluster.get("members", []):
            mapping[member] = group_id
    return mapping


def build_math_artifacts(
    conv,
    dynamo_data: dict[str, Any],
    *,
    projections_chunk_size: int = PROJECTIONS_CHUNK_SIZE,
    routing_chunk_size: int = ROUTING_CHUNK_SIZE,
) -> list[tuple[str, Any]]:
    """(artifact_key, JSON-safe payload) pairs for one math run."""
    artifacts: list[tuple[str, Any]] = []

    artifacts.append((
        "math#pca",
        {
            "math_tick": _jsonable(dynamo_data.get("math_tick")),
            "participant_count": _jsonable(dynamo_data.get("participant_count")),
            "comment_count": _jsonable(dynamo_data.get("comment_count")),
            "group_count": _jsonable(dynamo_data.get("group_count")),
            "pca": _jsonable(dynamo_data.get("pca", {})),
            "consensus": _jsonable(dynamo_data.get("consensus", {})),
        },
    ))

    artifacts.append(("math#kmeans", _jsonable(dynamo_data.get("group_clusters", []))))

    artifacts.append((
        "math#repness",
        _jsonable(dynamo_data.get("repness", {}).get("comment_repness", [])),
    ))

    # Routing: one row per votes_base comment, joined with priorities and
    # group consensus — the same join the legacy writer performs (absent
    # values stay None; the legacy rows simply omit them).
    votes_base = dynamo_data.get("votes_base", {})
    priorities = dynamo_data.get("comment_priorities", {})
    group_consensus = dynamo_data.get("group_consensus", {})
    # Defaults mirror the legacy writer: priority 0 and consensus 0 when
    # absent (the legacy rows always carry both attributes).
    routing_rows = [
        {
            "comment_id": str(comment_id),
            "priority": _jsonable(priorities.get(comment_id, 0)),
            "consensus_score": _jsonable(group_consensus.get(comment_id, 0)),
            "stats": _jsonable(stats),
        }
        for comment_id, stats in votes_base.items()
    ]
    routing_rows.sort(key=lambda row: row["comment_id"])
    for index, chunk in enumerate(_chunked(routing_rows, routing_chunk_size)):
        artifacts.append((f"math#routing#{index:05d}", chunk))

    # Projections: per-participant rows from conv.proj (NOT in dynamo_data —
    # the legacy serializer skips them "for efficiency") + the group map.
    participant_groups = _participant_groups(conv.group_clusters)
    projection_rows = [
        {
            "participant_id": str(participant_id),
            "coordinates": _jsonable(coordinates),
            # raw-key lookup, -1 default — exactly the legacy semantics
            "group_id": _jsonable(participant_groups.get(participant_id, -1)),
        }
        for participant_id, coordinates in conv.proj.items()
    ]
    projection_rows.sort(key=lambda row: row["participant_id"])
    for index, chunk in enumerate(_chunked(projection_rows, projections_chunk_size)):
        artifacts.append((f"math#projections#{index:05d}", chunk))

    return artifacts


def write_math_artifacts(
    store: DelphiStore,
    job_id: str,
    conv,
    dynamo_data: dict[str, Any],
    *,
    projections_chunk_size: int = PROJECTIONS_CHUNK_SIZE,
) -> int:
    """Write the math artifacts as codec envelopes under pk=job_id; record
    math_tick_legacy on the manifest and append a log line (best-effort —
    a standalone dev run may have no manifest row). Returns the artifact
    count."""
    artifacts = build_math_artifacts(
        conv, dynamo_data, projections_chunk_size=projections_chunk_size
    )
    for artifact_key, payload in artifacts:
        encoded = encode_payload(payload)
        store.put(
            "artifacts",
            StoreItem(pk=job_id, sk=artifact_key, attributes=encoded.meta, blob=encoded.blob),
        )
    math_tick = dynamo_data.get("math_tick")
    try:
        if math_tick is not None:
            store.merge_run_fields(job_id, {"math_tick_legacy": int(math_tick)})
        store.append_log(
            job_id, f"math stage wrote {len(artifacts)} v2 artifacts (tick {math_tick})"
        )
    except NotFound:
        logger.info(
            f"No run manifest for job {job_id!r} (standalone run) — "
            f"artifacts written without manifest bookkeeping"
        )
    return len(artifacts)
