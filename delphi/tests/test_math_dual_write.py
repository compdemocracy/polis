"""P7b (Storage V2 design §4.2 artifacts, §6.1 M1, §7): MATH stage dual-write.

Contract under test:

- build_math_artifacts derives the v2 artifact payloads from the SAME objects
  the legacy writer consumes (`conv.to_dynamo_dict()` output + `conv.proj` +
  `conv.group_clusters`), converting Decimals back to floats by value:
  math#pca, math#kmeans, math#repness, math#routing#<chunk>,
  math#projections#<chunk> (logical chunking for the per-participant table).
- write_math_artifacts stores them as codec envelopes under pk=job_id,
  records math_tick_legacy on the manifest and appends a log line
  (best-effort: a standalone run may have no manifest).
- persist_math_results gates BOTH writers on DELPHI_WRITE_MODE:
  old → legacy export only (byte-identical behavior); both → legacy AND v2,
  v2 failures logged never raised; v2 → v2 only (legacy tables untouched),
  v2 failures raise.
- scripts/verify_dual_write.py compares the legacy table rows against the
  decoded v2 artifacts NUMERICALLY (Decimal vs float by value) and reports
  per-table pass/fail — it reads both sides independently, so a bug in the
  builder's join logic cannot hide.
"""

import os
import sys
from decimal import Decimal
from types import SimpleNamespace

import pytest

from delphi_storage.backends.memory import MemoryDelphiStore
from delphi_storage.codec import decode_payload
from delphi_storage.manifest import ensure_run, mark_running
from delphi_storage.models import JobType
from delphi_storage.write_mode import WriteMode

DELPHI_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if DELPHI_DIR not in sys.path:
    sys.path.insert(0, DELPHI_DIR)

from polismath.database.v2_artifacts import (  # noqa: E402
    build_math_artifacts,
    write_math_artifacts,
)
from polismath.run_math_pipeline import persist_math_results  # noqa: E402


def _fake_conv(n_participants=5):
    """Minimal stand-in exposing exactly what the write path consumes."""
    dynamo_data = {
        "math_tick": 27042,
        "participant_count": n_participants,
        "comment_count": 3,
        "group_count": 2,
        "pca": {
            "center": [Decimal("0.1"), Decimal("-0.2")],
            "components": [[Decimal("0.5"), Decimal("0.5")],
                           [Decimal("-0.5"), Decimal("0.5")]],
        },
        "consensus": {"agree": [{"tid": 1, "p-success": Decimal("0.9")}], "disagree": []},
        "group_clusters": [
            {"id": 0, "members": [0, 2], "center": [Decimal("1.0"), Decimal("0.0")]},
            {"id": 1, "members": [1, 3, 4], "center": [Decimal("-1.0"), Decimal("0.0")]},
        ],
        "votes_base": {
            "1": {"agree": 2, "disagree": 1, "total": 3},
            "2": {"agree": 1, "disagree": 0, "total": 1},
            "3": {"agree": 0, "disagree": 2, "total": 2},
        },
        "comment_priorities": {"1": 7, "2": 3},
        "group_consensus": {"1": Decimal("0.75"), "3": Decimal("0.25")},
        "repness": {
            "comment_repness": [
                {"group_id": 0, "comment_id": "1", "repness": Decimal("2.5")},
                {"group_id": 1, "comment_id": "3", "repness": Decimal("1.5")},
            ]
        },
    }
    # proj keyed by the RAW member values (ints here) — the legacy group map
    # is raw-keyed, so matching types resolve groups; mismatched types are
    # the -1 quirk covered by its own test below.
    proj = {i: [float(i), -float(i)] for i in range(n_participants)}
    conv = SimpleNamespace(
        conversation_id="42",
        proj=proj,
        group_clusters=dynamo_data["group_clusters"],
        serialize_calls=0,
    )

    def to_dynamo_dict():
        conv.serialize_calls += 1
        return dynamo_data

    conv.to_dynamo_dict = to_dynamo_dict
    return conv, dynamo_data


class TestBuildMathArtifacts:
    def test_artifact_keys_and_decimal_conversion(self):
        conv, dynamo_data = _fake_conv()
        artifacts = dict(build_math_artifacts(conv, dynamo_data))
        assert set(artifacts) == {
            "math#pca",
            "math#kmeans",
            "math#repness",
            "math#routing#00000",
            "math#projections#00000",
        }
        pca = artifacts["math#pca"]
        assert pca["math_tick"] == 27042
        assert pca["pca"]["center"] == [0.1, -0.2]  # floats, not Decimals
        assert isinstance(pca["pca"]["center"][0], float)
        assert pca["participant_count"] == 5
        kmeans = artifacts["math#kmeans"]
        assert [g["id"] for g in kmeans] == [0, 1]
        assert kmeans[0]["center"] == [1.0, 0.0]
        repness = artifacts["math#repness"]
        assert repness[0] == {"group_id": 0, "comment_id": "1", "repness": 2.5}

    def test_routing_join_matches_legacy_semantics(self):
        """One row per votes_base comment; priority/consensus joined with the
        same defaults the legacy writer uses (absent → 0, never omitted)."""
        conv, dynamo_data = _fake_conv()
        artifacts = dict(build_math_artifacts(conv, dynamo_data))
        routing = {row["comment_id"]: row for row in artifacts["math#routing#00000"]}
        assert set(routing) == {"1", "2", "3"}
        assert routing["1"]["priority"] == 7
        assert routing["1"]["consensus_score"] == 0.75
        assert routing["1"]["stats"] == {"agree": 2, "disagree": 1, "total": 3}
        assert routing["2"]["consensus_score"] == 0  # legacy default, not omitted
        assert routing["3"]["priority"] == 0  # legacy default, not omitted

    def test_projections_carry_group_ids_and_chunk(self):
        conv, dynamo_data = _fake_conv(n_participants=5)
        artifacts = dict(build_math_artifacts(conv, dynamo_data, projections_chunk_size=2))
        chunks = sorted(k for k in artifacts if k.startswith("math#projections#"))
        assert chunks == [
            "math#projections#00000",
            "math#projections#00001",
            "math#projections#00002",
        ]
        rows = [row for key in chunks for row in artifacts[key]]
        assert len(rows) == 5
        by_pid = {row["participant_id"]: row for row in rows}
        assert by_pid["0"]["group_id"] == 0
        assert by_pid["1"]["group_id"] == 1
        assert by_pid["4"]["group_id"] == 1
        assert by_pid["2"]["coordinates"] == [2.0, -2.0]

    def test_participants_without_group_get_minus_one(self):
        conv, dynamo_data = _fake_conv(n_participants=6)  # pid 5 in no cluster
        artifacts = dict(build_math_artifacts(conv, dynamo_data))
        rows = artifacts["math#projections#00000"]
        by_pid = {row["participant_id"]: row for row in rows}
        assert by_pid["5"]["group_id"] == -1

    def test_str_int_key_mismatch_reproduces_legacy_minus_one_quirk(self):
        """The legacy group map is raw-keyed: str proj keys never match int
        cluster members, so every row gets -1. Quirk parity — the v2 side
        must diverge from 'correct' exactly like the legacy side does."""
        conv, dynamo_data = _fake_conv()
        conv.proj = {str(pid): coords for pid, coords in conv.proj.items()}
        artifacts = dict(build_math_artifacts(conv, dynamo_data))
        rows = artifacts["math#projections#00000"]
        assert all(row["group_id"] == -1 for row in rows)


class TestNumpySafety:
    def test_numpy_arrays_and_scalars_are_encodable(self):
        """Production conv.proj values are numpy arrays and dynamo_data mixes
        numpy scalars in — the builder must emit plain JSON values."""
        np = pytest.importorskip("numpy")
        conv, dynamo_data = _fake_conv()
        conv.proj = {pid: np.array(coords) for pid, coords in conv.proj.items()}
        dynamo_data["pca"]["center"] = np.array([0.1, -0.2])
        dynamo_data["participant_count"] = np.int64(5)
        artifacts = dict(build_math_artifacts(conv, dynamo_data))
        pca = artifacts["math#pca"]
        assert pca["pca"]["center"] == [0.1, -0.2]
        assert isinstance(pca["participant_count"], int)
        rows = artifacts["math#projections#00000"]
        assert isinstance(rows[0]["coordinates"], list)
        # and the codec accepts the payloads end to end
        store = MemoryDelphiStore()
        assert write_math_artifacts(store, "np-job", conv, dynamo_data) == 5


class TestWriteMathArtifacts:
    def test_writes_envelopes_and_manifest(self):
        store = MemoryDelphiStore()
        ensure_run(store, job_id="mj-1", job_type=JobType.FULL_PIPELINE, zid=42)
        mark_running(store, "mj-1")
        conv, dynamo_data = _fake_conv()
        written = write_math_artifacts(store, "mj-1", conv, dynamo_data)
        assert written == 5
        items = store.query_prefix("artifacts", "mj-1", "math#")
        assert len(items) == 5
        pca_item = store.get("artifacts", "mj-1", "math#pca")
        decoded = decode_payload(pca_item.attributes, pca_item.blob)
        assert decoded["pca"]["center"] == [0.1, -0.2]
        run = store.get_run("mj-1")
        assert run.math_tick_legacy == 27042
        logs = store.query_prefix("artifacts", "mj-1", "log#")
        assert len(logs) == 1

    def test_no_manifest_is_tolerated(self):
        """Standalone dev runs may have no run row — artifacts still land."""
        store = MemoryDelphiStore()
        conv, dynamo_data = _fake_conv()
        written = write_math_artifacts(store, "loose-job", conv, dynamo_data)
        assert written == 5
        assert store.get("artifacts", "loose-job", "math#pca") is not None


class TestPersistModeGating:
    def _setup(self, monkeypatch, mode):
        conv, dynamo_data = _fake_conv()
        calls = {"old": 0, "v2": 0}

        def fake_old_export(conv_arg, dynamo_data_arg):
            calls["old"] += 1
            calls["old_dynamo_data"] = dynamo_data_arg
            return True

        rmp = sys.modules["polismath.run_math_pipeline"]
        monkeypatch.setattr(rmp, "_export_to_legacy_dynamo", fake_old_export)

        store = MemoryDelphiStore()
        monkeypatch.setattr(rmp, "_get_v2_store", lambda: store)
        return rmp, conv, calls, store

    def test_old_mode_only_legacy(self, monkeypatch):
        rmp, conv, calls, store = self._setup(monkeypatch, "old")
        ok = persist_math_results(conv, job_id="j", write_mode=WriteMode.OLD)
        assert ok and calls["old"] == 1
        assert store.query_prefix("artifacts", "j", "math#") == []

    def test_both_mode_writes_both(self, monkeypatch):
        rmp, conv, calls, store = self._setup(monkeypatch, "both")
        ok = persist_math_results(conv, job_id="j", write_mode=WriteMode.BOTH)
        assert ok and calls["old"] == 1
        assert len(store.query_prefix("artifacts", "j", "math#")) == 5

    def test_single_serialization_shared_by_both_writers(self, monkeypatch):
        """math_tick is time-derived inside to_dynamo_dict — TWO independent
        calls would tag the legacy tables and v2 artifacts with different
        ticks and turn verify_dual_write permanently red on real runs."""
        rmp, conv, calls, store = self._setup(monkeypatch, "both")
        persist_math_results(conv, job_id="j", write_mode=WriteMode.BOTH)
        assert conv.serialize_calls == 1
        # and the very same dict object reached the legacy writer
        pca_item = store.get("artifacts", "j", "math#pca")
        assert calls["old_dynamo_data"]["math_tick"] == 27042

    def test_both_mode_v2_failure_is_swallowed(self, monkeypatch):
        rmp, conv, calls, store = self._setup(monkeypatch, "both")

        def boom():
            raise RuntimeError("v2 store down")

        monkeypatch.setattr(rmp, "_get_v2_store", boom)
        ok = persist_math_results(conv, job_id="j", write_mode=WriteMode.BOTH)
        assert ok and calls["old"] == 1  # old path served

    def test_v2_mode_skips_legacy_and_raises_on_failure(self, monkeypatch):
        rmp, conv, calls, store = self._setup(monkeypatch, "v2")
        ok = persist_math_results(conv, job_id="j", write_mode=WriteMode.V2)
        assert ok and calls["old"] == 0
        assert len(store.query_prefix("artifacts", "j", "math#")) == 5

        def boom():
            raise RuntimeError("v2 store down")

        monkeypatch.setattr(rmp, "_get_v2_store", boom)
        with pytest.raises(RuntimeError):
            persist_math_results(conv, job_id="j2", write_mode=WriteMode.V2)


class TestVerifyDualWrite:
    """End-to-end parity: legacy tables written by the REAL DynamoDBClient vs
    v2 artifacts — compared by the independent verifier."""

    def _dynamo_available(self):
        endpoint = os.environ.get("DYNAMODB_ENDPOINT", "http://localhost:8000")
        import boto3
        from botocore.config import Config as BotoConfig

        try:
            client = boto3.client(
                "dynamodb", endpoint_url=endpoint, region_name="us-east-1",
                aws_access_key_id=os.environ.get("AWS_ACCESS_KEY_ID", "dummy"),
                aws_secret_access_key=os.environ.get("AWS_SECRET_ACCESS_KEY", "dummy"),
                config=BotoConfig(connect_timeout=3, read_timeout=3,
                                  retries={"max_attempts": 0}),
            )
            client.list_tables(Limit=1)
            return endpoint
        except Exception as e:  # noqa: BLE001
            if os.environ.get("GITHUB_ACTIONS") == "true":
                pytest.fail(f"DynamoDB must be available in GitHub Actions: {e}")
            pytest.skip(f"DynamoDB unavailable: {e}")

    def test_verify_passes_then_catches_corruption(self, monkeypatch):
        endpoint = self._dynamo_available()
        from polismath.database.dynamodb import DynamoDBClient
        from scripts.verify_dual_write import verify_math_dual_write

        monkeypatch.setenv("AWS_ACCESS_KEY_ID", "dummy")
        monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "dummy")
        conv, dynamo_data = _fake_conv()
        client = DynamoDBClient(endpoint_url=endpoint, region_name="us-east-1")
        client.initialize()
        assert client.write_conversation(conv) is True

        store = MemoryDelphiStore()
        write_math_artifacts(store, "vj-1", conv, dynamo_data)

        report = verify_math_dual_write(
            store, job_id="vj-1", zid=42, endpoint_url=endpoint
        )
        assert report["ok"], report

        # corrupt one v2 value → the verifier must catch it
        from delphi_storage.models import StoreItem
        from delphi_storage.codec import encode_payload

        payloads = dict(build_math_artifacts(conv, dynamo_data))
        pca = payloads["math#pca"]
        pca["pca"]["center"][0] = 999.0
        enc = encode_payload(pca)
        store.put("artifacts", StoreItem(pk="vj-1", sk="math#pca",
                                         attributes=enc.meta, blob=enc.blob))
        report = verify_math_dual_write(
            store, job_id="vj-1", zid=42, endpoint_url=endpoint
        )
        assert not report["ok"]
        assert any("pca" in mismatch for mismatch in report["mismatches"])
