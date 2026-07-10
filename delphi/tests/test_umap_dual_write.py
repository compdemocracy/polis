"""P7c (Storage V2 design §4.2, §6.1 M1, §7): UMAP 500s stage dual-write.

Contract under test:

- build_* functions derive v2 artifact payloads from the SAME Pydantic model
  lists the legacy DynamoDBStorage writes (serialize-once by construction —
  the models carry baked datetime fields, so re-instantiating them would be
  the math_tick trap all over again):
  umap#meta, umap#embeddings#<chunk>, umap#graph#<chunk>,
  umap#assignments#<chunk>, umap#keywords#<layer>, umap#features#<layer>,
  umap#topic#<layer>#<cluster>.
- DualWriteUmapStorage duck-types the 7 DynamoDBStorage write methods used by
  run_pipeline: legacy write (when an inner storage is present) AND v2
  artifact write from the same lists, per DELPHI_WRITE_MODE policy
  (both → v2 failures logged never raised; v2 → raised; old → passthrough).
- make_umap_storage builds the right stack for (export_dynamo, write_mode).
- verify_umap_dual_write reads legacy tables and v2 artifacts back
  INDEPENDENTLY and compares numerically.
"""

import os
import sys

import pytest

from delphi_storage.backends.memory import MemoryDelphiStore
from delphi_storage.codec import decode_payload
from delphi_storage.write_mode import WriteMode

DELPHI_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
UMAP_DIR = os.path.join(DELPHI_DIR, "umap_narrative")
for path in (DELPHI_DIR, UMAP_DIR):
    if path not in sys.path:
        sys.path.insert(0, path)

from polismath_commentgraph.schemas.dynamo_models import (  # noqa: E402
    ClusterCharacteristic,
    ClusterLayer,
    ClusterTopic,
    CommentCluster,
    CommentEmbedding,
    ConversationMeta,
    Coordinates,
    Embedding,
    EVOCParameters,
    LLMTopicName,
    UMAPGraphEdge,
    UMAPParameters,
)
from v2_artifacts import (  # noqa: E402  (umap_narrative/v2_artifacts.py)
    DualWriteUmapStorage,
    build_core_umap_artifacts,
    build_features_artifacts,
    build_topic_artifacts,
    make_umap_storage,
)

ZID = "42"


def _models():
    meta = ConversationMeta(
        conversation_id=ZID,
        processed_date="2026-07-07T00:00:00",
        num_comments=3,
        num_participants=5,
        embedding_model="test-model",
        umap_parameters=UMAPParameters(),
        evoc_parameters=EVOCParameters(),
        cluster_layers=[ClusterLayer(layer_id=0, num_clusters=2, description="test layer")],
    )
    embeddings = [
        CommentEmbedding(
            conversation_id=ZID, comment_id=i,
            embedding=Embedding(vector=[0.1 * i, -0.2 * i], dimensions=2, model="test-model"),
        )
        for i in range(3)
    ]
    edges = [
        UMAPGraphEdge(
            conversation_id=ZID, edge_id=f"{i}_{i}", source_id=i, target_id=i,
            weight=1.0, distance=0.0, position=Coordinates(x=float(i), y=-float(i)),
        )
        for i in range(3)
    ]
    clusters = [
        CommentCluster(conversation_id=ZID, comment_id=i, layer0_cluster_id=i % 2)
        for i in range(3)
    ]
    topics = [
        ClusterTopic(
            conversation_id=ZID, cluster_key=f"layer0_{c}", layer_id=0, cluster_id=c,
            topic_label=f"t{c}", size=2, sample_comments=["a"],
            centroid_coordinates=Coordinates(x=0.5, y=0.5),
        )
        for c in range(2)
    ]
    characteristics = [
        ClusterCharacteristic(
            conversation_id=ZID, layer_id=0, cluster_id=c, size=2,
            top_words=["w1"], top_tfidf_scores=[0.9], sample_comments=["a"],
        )
        for c in range(2)
    ]
    llm_topics = [
        LLMTopicName(
            conversation_id=ZID, topic_key=f"job-x#0#{c}", layer_id=0, cluster_id=c,
            topic_name=f"Topic {c}", model_name="llama-test",
            created_at="2026-07-07T00:00:01",
        )
        for c in range(2)
    ]
    return meta, embeddings, edges, clusters, topics, characteristics, llm_topics


class TestBuilders:
    def test_core_artifact_keys_and_payloads(self):
        meta, embeddings, edges, clusters, topics, *_ = _models()
        artifacts = dict(
            build_core_umap_artifacts(
                meta, embeddings, edges, clusters, topics, chunk_size=2
            )
        )
        assert set(artifacts) == {
            "umap#meta",
            "umap#embeddings#00000", "umap#embeddings#00001",
            "umap#graph#00000", "umap#graph#00001",
            "umap#assignments#00000", "umap#assignments#00001",
            "umap#keywords#0",
        }
        assert artifacts["umap#meta"]["num_comments"] == 3
        assert artifacts["umap#embeddings#00000"][0]["embedding"]["vector"] == [0.0, -0.0]
        assert len(artifacts["umap#embeddings#00000"]) == 2
        assert len(artifacts["umap#embeddings#00001"]) == 1
        assert artifacts["umap#keywords#0"][0]["cluster_key"] == "layer0_0"

    def test_features_and_topics_per_layer_and_cluster(self):
        *_, characteristics, llm_topics = _models()
        features = dict(build_features_artifacts(characteristics))
        assert set(features) == {"umap#features#0"}
        assert [row["cluster_id"] for row in features["umap#features#0"]] == [0, 1]
        topics = dict(build_topic_artifacts(llm_topics))
        assert set(topics) == {"umap#topic#0#0", "umap#topic#0#1"}
        assert topics["umap#topic#0#1"]["topic_name"] == "Topic 1"
        assert topics["umap#topic#0#1"]["topic_key"] == "job-x#0#1"


class _FakeLegacy:
    """Records calls; mimics DynamoDBStorage's result shape."""

    def __init__(self):
        self.calls = []

    def _record(self, name, arg):
        self.calls.append((name, arg))
        return {"success": len(arg) if isinstance(arg, list) else 1, "failure": 0}

    def create_conversation_meta(self, meta):
        return self._record("meta", meta)

    def batch_create_comment_embeddings(self, models):
        return self._record("embeddings", models)

    def batch_create_graph_edges(self, models):
        return self._record("graph", models)

    def batch_create_comment_clusters(self, models):
        return self._record("clusters", models)

    def batch_create_cluster_topics(self, models):
        return self._record("topics", models)

    def batch_create_cluster_characteristics(self, models):
        return self._record("features", models)

    def batch_create_llm_topic_names(self, models):
        return self._record("llm", models)


def _drive(storage):
    meta, embeddings, edges, clusters, topics, characteristics, llm_topics = _models()
    storage.create_conversation_meta(meta)
    storage.batch_create_comment_embeddings(embeddings)
    storage.batch_create_graph_edges(edges)
    storage.batch_create_comment_clusters(clusters)
    storage.batch_create_cluster_topics(topics)
    storage.batch_create_cluster_characteristics(characteristics)
    storage.batch_create_llm_topic_names(llm_topics)


class TestDualWriteWrapper:
    def test_both_mode_writes_both_sides_from_same_lists(self):
        legacy = _FakeLegacy()
        store = MemoryDelphiStore()
        wrapper = DualWriteUmapStorage(
            legacy, store=store, job_id="uj-1", write_mode=WriteMode.BOTH
        )
        _drive(wrapper)
        assert [name for name, _ in legacy.calls] == [
            "meta", "embeddings", "graph", "clusters", "topics", "features", "llm",
        ]
        sks = [item.sk for item in store.query_prefix("artifacts", "uj-1", "umap#")]
        assert "umap#meta" in sks
        assert any(sk.startswith("umap#embeddings#") for sk in sks)
        assert "umap#keywords#0" in sks
        assert "umap#features#0" in sks
        assert "umap#topic#0#1" in sks

    def test_v2_only_skips_legacy_and_synthesizes_results(self):
        store = MemoryDelphiStore()
        wrapper = DualWriteUmapStorage(
            None, store=store, job_id="uj-2", write_mode=WriteMode.V2
        )
        meta, embeddings, *_ = _models()
        result = wrapper.batch_create_comment_embeddings(embeddings)
        assert result == {"success": 3, "failure": 0}
        assert store.query_prefix("artifacts", "uj-2", "umap#embeddings#") != []

    def test_both_mode_v2_failure_logged_not_raised(self):
        legacy = _FakeLegacy()

        class BrokenStore:
            def put(self, *a, **k):
                raise RuntimeError("store down")

        wrapper = DualWriteUmapStorage(
            legacy, store=BrokenStore(), job_id="uj-3", write_mode=WriteMode.BOTH
        )
        meta, embeddings, *_ = _models()
        result = wrapper.batch_create_comment_embeddings(embeddings)
        assert result["success"] == 3  # legacy result returned; no raise

    def test_v2_mode_failure_raises(self):
        class BrokenStore:
            def put(self, *a, **k):
                raise RuntimeError("store down")

        wrapper = DualWriteUmapStorage(
            None, store=BrokenStore(), job_id="uj-4", write_mode=WriteMode.V2
        )
        meta, *_ = _models()
        with pytest.raises(RuntimeError):
            wrapper.create_conversation_meta(meta)

    def test_finalize_records_manifest_bookkeeping(self):
        from delphi_storage.manifest import ensure_run, mark_running
        from delphi_storage.models import JobType

        store = MemoryDelphiStore()
        ensure_run(store, job_id="uj-5", job_type=JobType.FULL_PIPELINE, zid=42)
        mark_running(store, "uj-5")
        wrapper = DualWriteUmapStorage(
            None, store=store, job_id="uj-5", write_mode=WriteMode.V2
        )
        _drive(wrapper)
        wrapper.finalize()
        run = store.get_run("uj-5")
        assert run.stage_status["umap"]["artifacts"] >= 7
        assert store.query_prefix("artifacts", "uj-5", "log#") != []


class TestFactory:
    def test_old_mode_returns_plain_legacy(self, monkeypatch):
        legacy = _FakeLegacy()
        storage = make_umap_storage(legacy, job_id="j", write_mode=WriteMode.OLD)
        assert storage is legacy  # zero-overhead passthrough

    def test_both_mode_wraps(self):
        legacy = _FakeLegacy()
        store = MemoryDelphiStore()
        storage = make_umap_storage(
            legacy, job_id="j", write_mode=WriteMode.BOTH, store=store
        )
        assert isinstance(storage, DualWriteUmapStorage)

    def test_v2_mode_needs_no_legacy(self):
        store = MemoryDelphiStore()
        storage = make_umap_storage(
            None, job_id="j", write_mode=WriteMode.V2, store=store
        )
        assert isinstance(storage, DualWriteUmapStorage)


class TestRunPipelineWiring:
    def test_run_pipeline_uses_the_factory_and_gates_legacy(self):
        """Source-level pin: the storage-init block routes through
        make_umap_storage and old_writes_enabled (full e2e wiring is covered
        by the verify test + CI)."""
        import importlib

        run_pipeline = importlib.import_module("run_pipeline")
        import inspect

        source = inspect.getsource(run_pipeline.process_conversation)
        assert "make_umap_storage" in source
        assert "old_writes_enabled" in source
        assert "resolve_write_mode" in source


class TestVerifyUmapDualWrite:
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
        monkeypatch.setenv("AWS_ACCESS_KEY_ID", "dummy")
        monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "dummy")
        monkeypatch.setenv("DYNAMODB_ENDPOINT", endpoint)
        import boto3

        import create_dynamodb_tables as cdt
        from polismath_commentgraph.utils.storage import DynamoDBStorage
        from scripts.verify_dual_write import verify_umap_dual_write

        resource = boto3.Session(region_name="us-east-1").resource(
            "dynamodb", endpoint_url=endpoint
        )
        cdt.create_evoc_tables(resource)

        legacy = DynamoDBStorage(region_name="us-east-1", endpoint_url=endpoint)
        store = MemoryDelphiStore()
        wrapper = DualWriteUmapStorage(
            legacy, store=store, job_id="uvj-1", write_mode=WriteMode.BOTH
        )
        _drive(wrapper)

        report = verify_umap_dual_write(
            store, job_id="uvj-1", zid=ZID, endpoint_url=endpoint
        )
        assert report["ok"], report

        # corrupt one v2 payload → must be caught
        from delphi_storage.codec import encode_payload
        from delphi_storage.models import StoreItem

        item = store.get("artifacts", "uvj-1", "umap#meta")
        payload = decode_payload(item.attributes, item.blob)
        payload["num_comments"] = 999
        enc = encode_payload(payload)
        store.put("artifacts", StoreItem(pk="uvj-1", sk="umap#meta",
                                         attributes=enc.meta, blob=enc.blob))
        report = verify_umap_dual_write(
            store, job_id="uvj-1", zid=ZID, endpoint_url=endpoint
        )
        assert not report["ok"]
        assert any("meta" in mismatch for mismatch in report["mismatches"])
