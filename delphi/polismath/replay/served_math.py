"""Shared validation of private served-math capture bytes and metadata.

Stdlib only. Admission does not import the database extractor. Watermarks
compare timestamps; they do not establish visibility, consumed prefixes, or
recompute schedules. No diagnostic result is an engine acceptance gate.
"""
from __future__ import annotations
import hashlib
import json
import re
from pathlib import Path
from typing import Any, Sequence

SERVED_MATH_SCHEMA_VERSION = "certify-served-math/1"
SERVED_MATH_META_FILENAME = "served_math.json"
SERVED_BLOB_WATERMARK_KEY = "lastVoteTimestamp"
MAIN_COLUMNS = ("math_env", "data", "last_vote_timestamp", "caching_tick", "math_tick", "modified")
TICK_COLUMNS = ("math_env", "math_tick", "caching_tick", "modified")

def blob_watermark(blob_text: str) -> tuple[int | None, str | None]:
    """The blob's own ``lastVoteTimestamp``, and why it is absent when it is.

    The blob is captured verbatim and is NOT rewritten by this parse; the parse
    exists only to read one scalar for the consistency diagnostic. A blob that
    does not parse, or that carries a non-integer watermark, yields
    ``(None, reason)`` and is reported — never silently coerced.
    """
    try:
        parsed = json.loads(blob_text)
    except (json.JSONDecodeError, ValueError) as exc:
        return None, f"blob is not parseable JSON: {exc}"
    if not isinstance(parsed, dict):
        return None, f"blob is a JSON {type(parsed).__name__}, not an object"
    if SERVED_BLOB_WATERMARK_KEY not in parsed:
        return None, f"blob carries no {SERVED_BLOB_WATERMARK_KEY!r} key"
    value = parsed[SERVED_BLOB_WATERMARK_KEY]
    if isinstance(value, bool) or not isinstance(value, int):
        return None, (f"blob {SERVED_BLOB_WATERMARK_KEY!r} is "
                      f"{type(value).__name__} {value!r}, not an integer")
    return value, None


def served_math_consistency(
    rows: Sequence[dict[str, Any]], vote_created_ms: Sequence[int],
) -> dict[str, Any]:
    """Compare extracted event timestamps to a recorded watermark; never a gate.

    Equality means the maximum extracted timestamp equals the watermark. Counts
    at/before and after it do not identify consumed votes: same-ms ordering,
    transaction visibility, poll cursors and moderation history remain unknown.
    A latest-only row cannot recover the recompute schedule (P-052 uses an
    ensemble of explicitly simulated schedules).
    """
    times = sorted(int(t) for t in vote_created_ms)
    max_ms = times[-1] if times else None
    per_env: list[dict[str, Any]] = []
    for row in rows:
        watermark = row.get("last_vote_timestamp")
        blob_watermark_value = row.get("blob_last_vote_timestamp")
        entry: dict[str, Any] = {
            "math_env": row.get("math_env"),
            "last_vote_timestamp": watermark,
            "blob_last_vote_timestamp": blob_watermark_value,
            "column_matches_blob": (
                None if blob_watermark_value is None or watermark is None
                else blob_watermark_value == watermark),
            "blob_watermark_absent_because": row.get("blob_watermark_absent_because"),
        }
        if watermark is None:
            entry.update({
                "verdict": "no-watermark-column",
                "votes_at_or_before_watermark": None,
                "votes_after_watermark": None,
                "watermark_minus_max_vote_ms": None,
                "watermark_is_a_vote_timestamp": None,
            })
        elif not times:
            entry.update({
                "verdict": "no-votes-extracted",
                "votes_at_or_before_watermark": 0,
                "votes_after_watermark": 0,
                "watermark_minus_max_vote_ms": None,
                "watermark_is_a_vote_timestamp": False,
            })
        else:
            at_or_before = sum(1 for t in times if t <= watermark)
            after = len(times) - at_or_before
            assert max_ms is not None
            if after:
                verdict = "vote-timestamps-after-the-served-watermark"
            elif watermark > max_ms:
                verdict = "watermark-ahead-of-every-extracted-vote"
            else:
                verdict = "watermark-equals-max-vote-timestamp"
            entry.update({
                "verdict": verdict,
                "votes_at_or_before_watermark": at_or_before,
                "votes_after_watermark": after,
                "watermark_minus_max_vote_ms": watermark - max_ms,
                "watermark_is_a_vote_timestamp": watermark in set(times),
            })
        per_env.append(entry)
    return {
        "kind": "diagnostic",
        "gate": False,
        "vote_events": len(times),
        "min_vote_created_ms": times[0] if times else None,
        "max_vote_created_ms": max_ms,
        "per_math_env": per_env,
        "note": "DIAGNOSTIC ONLY, never a gate. Counts compare extracted event "
                "timestamps with the recorded watermark. They do not establish "
                "transaction visibility, same-ms ordering, the consumed vote "
                "prefix, historical moderation, or the recompute schedule. "
                "Those uncertainties remain for P-052's schedule ensemble.",
    }


def served_math_logical_digest(meta: dict[str, Any]) -> str:
    """SHA-256 over the served capture's LOGICAL content — the per-``math_env``
    scalars and blob digests plus the tick rows, excluding the diagnostic and
    the prose. Two extractions of the same snapshot agree on it; a changed
    note does not move it, and a changed blob does."""
    projection = {
        "schema_version": meta["schema_version"],
        "math_main": [{
            "index": e["index"],
            "math_env": e["math_env"],
            "last_vote_timestamp": e["last_vote_timestamp"],
            "math_tick": e["math_tick"],
            "caching_tick": e["caching_tick"],
            "modified": e["modified"],
            "blob_sha256": e["blob_sha256"],
            "blob_bytes": e["blob_bytes"],
        } for e in meta["math_main"]],
        "math_ticks": meta["math_ticks"],
        "source_columns": meta["source_columns"],
        "math_envs_present_by_table": meta["math_envs_present_by_table"],
        "math_envs_present": meta["math_envs_present"],
        "math_envs_captured": meta["math_envs_captured"],
        "requested_math_envs": meta["requested_math_envs"],
    }
    return hashlib.sha256(json.dumps(
        projection, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def served_math_summary(meta: dict[str, Any], meta_sha256: str) -> dict[str, Any]:
    """The MANIFEST-SAFE projection of a served capture: digests, counts and
    the diagnostic. Carries no zid and no blob content.

    A blob file holds the verbatim blob text and NOTHING else — no trailing
    newline — so ``blob_sha256`` is at once the digest of the blob and the
    digest of the file that carries it, and there is no second number for the
    two to disagree on. ``meta_sha256`` is the digest of ``served_math.json``
    as written, which does end in a newline like every other JSON file here.
    """
    return {
        "schema_version": meta["schema_version"],
        "captured": True,
        "meta_file": SERVED_MATH_META_FILENAME,
        "meta_sha256": meta_sha256,
        "logical_digest_sha256": meta["logical_digest_sha256"],
        "math_envs": list(meta["math_envs_captured"]),
        "math_main_rows": len(meta["math_main"]),
        "math_ticks_rows": len(meta["math_ticks"]),
        "blobs": [{
            "math_env": entry["math_env"],
            "file": entry["blob_file"],
            "sha256": entry["blob_sha256"],
            "bytes": entry["blob_bytes"],
        } for entry in meta["math_main"]],
        "consistency": meta["consistency"],
    }


class CaptureError(ValueError):
    """Present capture metadata or bytes do not agree."""


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise CaptureError(message)


def _strings(value: Any, label: str) -> list[str]:
    _require(isinstance(value, list) and all(isinstance(v, str) for v in value),
             f"{label} must be a string list")
    _require(len(set(value)) == len(value), f"{label} repeats an environment")
    return value


def _integer(value: Any, label: str, *, nullable: bool = True) -> None:
    _require(type(value) is int or (nullable and value is None),
             f"{label} must be an integer" + (" or null" if nullable else ""))


def validate_metadata(meta: Any) -> None:
    """Strict shape, scalar, schema, logical digest and row-census validation."""
    keys = {"schema_version", "captured", "source_tables", "source_columns", "access",
            "requested_math_envs", "math_envs_present", "math_envs_present_by_table",
            "math_envs_captured", "math_main", "math_ticks", "consistency",
            "blob_handling", "disclosures", "logical_digest_sha256"}
    _require(isinstance(meta, dict) and set(meta) == keys, "served metadata field set mismatch")
    _require(meta["schema_version"] == SERVED_MATH_SCHEMA_VERSION, "served schema_version mismatch")
    _require(meta["captured"] is True, "served captured must be true")
    _require(meta["source_tables"] == ["math_main", "math_ticks"], "source_tables mismatch")
    for field in ("access", "blob_handling"):
        _require(isinstance(meta[field], str), f"{field} must be text")
    _strings(meta["disclosures"], "disclosures")
    columns = meta["source_columns"]
    _require(isinstance(columns, dict) and set(columns) == {"math_main", "math_ticks"},
             "source_columns mismatch")
    _require(columns["math_main"] == list(MAIN_COLUMNS), "math_main column set mismatch")
    tick_columns = _strings(columns["math_ticks"], "math_ticks columns")
    _require(set(tick_columns) <= set(TICK_COLUMNS) and
             {"math_env", "math_tick", "modified"} <= set(tick_columns), "math_ticks column set mismatch")
    _require(tick_columns == [c for c in TICK_COLUMNS if c in tick_columns], "math_ticks column order mismatch")
    present = _strings(meta["math_envs_present"], "math_envs_present")
    captured = _strings(meta["math_envs_captured"], "math_envs_captured")
    by_table = meta["math_envs_present_by_table"]
    _require(isinstance(by_table, dict) and set(by_table) == {"math_main", "math_ticks"},
             "math_envs_present_by_table mismatch")
    for table in by_table:
        _strings(by_table[table], table + " environments present")
    _require(present == sorted(set(by_table["math_main"]) | set(by_table["math_ticks"])),
             "present environment census mismatch")
    requested = meta["requested_math_envs"]
    if requested is not None:
        _strings(requested, "requested_math_envs")
    for table in ("math_main", "math_ticks"):
        rows = meta[table]
        _require(isinstance(rows, list) and all(isinstance(row, dict) for row in rows),
                 f"{table} rows must be objects")
        envs = [row.get("math_env") for row in rows]
        _strings(envs, table + " row environments")
        expected = sorted(e for e in by_table[table] if requested is None or e in requested)
        _require(envs == expected, f"{table} captured environment census mismatch")
        if table == "math_main":
            _require(captured == envs, "math_envs_captured differs from blob rows")
        for index, row in enumerate(rows):
            if table == "math_ticks":
                _require(set(row) == set(tick_columns), "tick row differs from captured columns")
                for key in tick_columns:
                    if key != "math_env":
                        _integer(row[key], "math_ticks." + key)
                continue
            expected_keys = {"index", "math_env", "last_vote_timestamp", "math_tick", "caching_tick",
                             "modified", "blob_file", "blob_sha256", "blob_bytes",
                             "blob_last_vote_timestamp", "blob_watermark_absent_because"}
            _require(set(row) == expected_keys, "math_main row field set mismatch")
            _require(type(row["index"]) is int and row["index"] == index, "blob row index mismatch")
            for key in ("last_vote_timestamp", "math_tick", "caching_tick", "modified", "blob_last_vote_timestamp"):
                _integer(row[key], "math_main." + key)
            _require(row["blob_file"] == f"served-math-{index:03d}.blob.json", "blob filename/index mismatch")
            _require(isinstance(row["blob_sha256"], str) and
                     re.fullmatch(r"[0-9a-f]{64}", row["blob_sha256"]) is not None, "blob digest malformed")
            _integer(row["blob_bytes"], "blob_bytes", nullable=False)
            _require(row["blob_bytes"] > 0, "blob_bytes must be positive")
            reason = row["blob_watermark_absent_because"]
            _require(reason is None or isinstance(reason, str), "blob watermark reason must be text or null")
    consistency = meta["consistency"]
    _require(isinstance(consistency, dict) and consistency.get("gate") is False and
             consistency.get("kind") == "diagnostic", "consistency must be diagnostic with gate:false")
    _require(meta["logical_digest_sha256"] == served_math_logical_digest(meta),
             "logical_digest_sha256 differs from recomputed content")


def read_capture(directory: Path, *, verify_digests: bool = True,
                 expected_summary: dict[str, Any] | None = None) -> tuple[dict[str, Any], dict[str, bytes]] | None:
    """Validate a fixture's capture, optionally binding its admitted manifest block.

    The diagnostic is recomputed from the retained millisecond event stream.
    ``verify_digests=False`` is only a loader debugging escape for changed blob
    bytes; it still validates metadata, paths, census and diagnostic shape.
    """
    directory = Path(directory)
    meta_path = directory / SERVED_MATH_META_FILENAME
    try:
        _require(not any(p.is_symlink() for p in (directory, *directory.parents, meta_path)), "symlink served capture")
        if not meta_path.exists():
            _require(expected_summary is None, "served metadata is missing")
            _require(not list(directory.glob("served-math-*.blob.json")), "blob files without metadata")
            return None
        raw_meta = meta_path.read_bytes()
        meta = json.loads(raw_meta)
        validate_metadata(meta)
        files = {row["blob_file"] for row in meta["math_main"]}
        _require(files == {p.name for p in directory.glob("served-math-*.blob.json")},
                 "blob file census mismatch: a claimed file is missing or an extra exists")
        raw_blobs = {}
        for row in meta["math_main"]:
            path = directory / row["blob_file"]
            _require(not path.is_symlink(), "symlink served blob")
            raw = path.read_bytes()
            raw_blobs[path.name] = raw
            if verify_digests:
                digest = hashlib.sha256(raw).hexdigest()
                _require(digest == row["blob_sha256"], f"served blob hashes to {digest}, differs from metadata")
                _require(len(raw) == row["blob_bytes"], "blob length differs from blob_bytes")
                watermark, reason = blob_watermark(raw.decode("utf-8"))
                _require((watermark, reason) == (row["blob_last_vote_timestamp"], row["blob_watermark_absent_because"]),
                         "blob watermark metadata differs from content")
        events_path = directory / "events.jsonl"
        _require(not events_path.is_symlink(), "symlink event stream")
        events = [json.loads(line) for line in events_path.read_text().splitlines() if line]
        times = [event["created"] for event in events if event["kind"] == "vote"]
        for value in times:
            _integer(value, "vote created", nullable=False)
        diagnostic = served_math_consistency(meta["math_main"], times)
        _require(json.dumps(diagnostic, sort_keys=True) == json.dumps(meta["consistency"], sort_keys=True),
                 "consistency differs from recomputed watermark diagnostic")
        if expected_summary is not None:
            actual = served_math_summary(meta, hashlib.sha256(raw_meta).hexdigest())
            _require(json.dumps(actual, sort_keys=True) == json.dumps(expected_summary, sort_keys=True),
                     "served manifest summary differs from verified metadata")
        return meta, raw_blobs
    except (OSError, ValueError, KeyError, TypeError) as exc:
        if isinstance(exc, CaptureError):
            raise
        raise CaptureError(f"invalid served capture: {exc}") from exc
