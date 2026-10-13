"""The embeddings spool and the one flag (migration 000038), off by default.

The spool layout is shared byte for byte with the daemon's Rust
``jobs::embedding``; the cross-language digest is pinned on both sides.
"""
import hashlib

import pytest

from polismath.job_child import embeddings_table_enabled, validate_manifest, ManifestError
from polismath.delphi_storage.embedding_spool import read_spool, write_spool


def _rows():
    return [
        (0, bytes([1]) * 32, [0.5, -1.0, 2.25]),
        (7, bytes([2]) * 32, [0.0, 1.5, -3.5]),
    ]


def test_round_trip_and_cross_language_digest():
    data = write_spool("conformance", 3, _rows())
    assert len(data) == 123
    # The identical input gives this digest from the Rust writer
    # (queue-rs/src/jobs/embedding.rs spool_bytes_match_the_python_writer).
    assert (
        hashlib.sha256(data).hexdigest()
        == "acae4b4261be36be2696fa8ddd959467d0f031ed6ede05e9d8b692b9d4fda893"
    )
    model, dims, rows = read_spool(data)
    assert model == "conformance" and dims == 3 and len(rows) == 2
    assert rows[0]["tid"] == 0 and rows[0]["text_sha"] == bytes([1]) * 32
    assert rows[1]["vector"] == [0.0, 1.5, -3.5]


def test_spool_refusals():
    with pytest.raises(ValueError):
        write_spool("", 3, _rows())
    with pytest.raises(ValueError):
        write_spool("m", 0, _rows())
    with pytest.raises(ValueError):
        write_spool("m", 3, [(0, bytes(32), [1.0])])
    with pytest.raises(ValueError):
        write_spool("m", 3, [(-1, bytes(32), [1.0, 2.0, 3.0])])
    good = write_spool("m", 3, _rows())
    with pytest.raises(ValueError):
        read_spool(b"XXXXXXXX" + good[8:])
    with pytest.raises(ValueError):
        read_spool(good + b"\x00")


def test_flag_is_off_by_default_and_reads_both_carriers():
    assert embeddings_table_enabled({}) is False
    assert embeddings_table_enabled({"stage": "graph_embed"}) is False
    assert embeddings_table_enabled({"embeddings_table": True}) is True
    assert embeddings_table_enabled({"config": {"embeddings_table": True}}) is True
    assert embeddings_table_enabled({"config": {"result_backend": "postgres"}}) is False


def _writer_manifest(extra=None):
    manifest = {
        "schema": "polis-jobs.output-manifest/2",
        "job_id": "00000000-0000-4000-8000-000000000001",
        "attempt_id": "00000000-0000-4000-8000-000000000002",
        "stage": "delphi_full_pipeline",
        "phase": "run",
        "outcome": "succeeded",
        "inputs": {"math_env": "dev", "math_tick": 1, "math_caching_tick": 1,
                   "comment_set_sha256": "0" * 64, "vote_hwm": 1},
        "outputs": [],
        "models": {"embed": None, "topic": None, "narrative": None},
        "cost": {"llm_tokens_in": None, "llm_tokens_out": None, "provider_batches": None},
        "recheck_after": None,
        "duration_ms": 1,
        "family_spool": {},
    }
    if extra:
        manifest.update(extra)
    return manifest


def test_writer_manifest_optional_embedding_spool():
    # Absent: today's key set, accepted.
    validate_manifest(_writer_manifest())
    good = {"file": "embeddings.spool", "sha256": "a" * 64,
            "model": "sentence-transformers/all-MiniLM-L6-v2", "dims": 384, "rows": 5}
    validate_manifest(_writer_manifest({"embedding_spool": good}))
    # A malformed descriptor is refused.
    for bad in [
        {**good, "file": "evil.spool"},
        {**good, "sha256": "nothex"},
        {**good, "dims": 0},
        {**good, "rows": -1},
        {k: v for k, v in good.items() if k != "model"},
    ]:
        with pytest.raises(ManifestError):
            validate_manifest(_writer_manifest({"embedding_spool": bad}))
