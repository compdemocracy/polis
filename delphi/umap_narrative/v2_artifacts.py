"""Storage V2 artifact builder/writer for the UMAP 500s stage (P7c, design
§4.2). Twin of polismath/database/v2_artifacts.py for the umap side.

The dual-write seam is a duck-typed WRAPPER over the legacy DynamoDBStorage:
run_pipeline calls the same seven write methods it always has, and the
wrapper feeds the SAME already-materialized Pydantic model lists to both the
legacy tables and the v2 artifact store. That guarantees the serialize-once
invariant (P7b lesson: the models carry baked datetime fields —
ConversationMeta.processed_date, LLMTopicName.created_at — so
re-instantiating them for a second write path would tag the two stores
differently, exactly the math_tick trap).

Artifact keys (design §4.2): umap#meta, umap#embeddings#<chunk>,
umap#graph#<chunk>, umap#assignments#<chunk>, umap#keywords#<layer>,
umap#features#<layer>, umap#topic#<layer>#<cluster>.
"""

import json
import logging
from typing import Any, Optional

from delphi_storage.codec import encode_payload
from delphi_storage.interface import DelphiStore, NotFound
from delphi_storage.models import StoreItem
from delphi_storage.write_mode import WriteMode
from polismath.database.v2_artifacts import _jsonable

logger = logging.getLogger(__name__)

#: Rows per chunk artifact. Embeddings rows are the fat ones (vector of
#: hundreds of floats); graph/assignments rows are small. The backend
#: byte-chunks any blob >300KB regardless — these bounds keep individual
#: artifacts readable.
EMBEDDINGS_CHUNK_SIZE = 500
GRAPH_CHUNK_SIZE = 5000
ASSIGNMENTS_CHUNK_SIZE = 5000


def _chunked(rows: list, size: int) -> list:
    return [rows[i : i + size] for i in range(0, max(len(rows), 1), size)]


def _model_payload(model) -> dict:
    """The SAME serialization the legacy path uses (storage.py):
    model_dump_json with the Pydantic-v1 fallback — pre-Decimal values."""
    try:
        raw = model.model_dump_json()
    except AttributeError:  # pydantic v1 models
        raw = model.json()
    return _jsonable(json.loads(raw))


def _model_payloads(models) -> list:
    return [_model_payload(model) for model in models]


def build_core_umap_artifacts(
    meta,
    embedding_models,
    edge_models,
    cluster_models,
    topic_models,
    *,
    chunk_size: Optional[int] = None,
) -> list:
    """(artifact_key, payload) pairs for the five core 500s outputs.
    chunk_size overrides all three chunk sizes (tests); production uses the
    per-kind defaults."""
    artifacts: list = []
    artifacts.append(("umap#meta", _model_payload(meta)))

    for index, chunk in enumerate(
        _chunked(_model_payloads(embedding_models), chunk_size or EMBEDDINGS_CHUNK_SIZE)
    ):
        artifacts.append((f"umap#embeddings#{index:05d}", chunk))
    for index, chunk in enumerate(
        _chunked(_model_payloads(edge_models), chunk_size or GRAPH_CHUNK_SIZE)
    ):
        artifacts.append((f"umap#graph#{index:05d}", chunk))
    for index, chunk in enumerate(
        _chunked(_model_payloads(cluster_models), chunk_size or ASSIGNMENTS_CHUNK_SIZE)
    ):
        artifacts.append((f"umap#assignments#{index:05d}", chunk))

    by_layer: dict = {}
    for payload in _model_payloads(topic_models):
        by_layer.setdefault(payload.get("layer_id"), []).append(payload)
    for layer_id in sorted(by_layer):
        rows = sorted(by_layer[layer_id], key=lambda row: row.get("cluster_id", 0))
        artifacts.append((f"umap#keywords#{layer_id}", rows))
    return artifacts


def build_features_artifacts(characteristic_models) -> list:
    """umap#features#<layer> — one artifact per layer."""
    by_layer: dict = {}
    for payload in _model_payloads(characteristic_models):
        by_layer.setdefault(payload.get("layer_id"), []).append(payload)
    return [
        (
            f"umap#features#{layer_id}",
            sorted(by_layer[layer_id], key=lambda row: row.get("cluster_id", 0)),
        )
        for layer_id in sorted(by_layer)
    ]


def build_topic_artifacts(llm_topic_models) -> list:
    """umap#topic#<layer>#<cluster> — one artifact per LLM topic name."""
    return [
        (f"umap#topic#{payload.get('layer_id')}#{payload.get('cluster_id')}", payload)
        for payload in _model_payloads(llm_topic_models)
    ]


class DualWriteUmapStorage:
    """Duck-typed stand-in for DynamoDBStorage's seven write methods used by
    run_pipeline (and ONLY those — anything else raises loudly). Writes the
    legacy tables through the wrapped storage (when present) and the v2
    artifacts from the same model lists, per DELPHI_WRITE_MODE policy:
    both → v2 failures logged, never raised (old path keeps serving);
    v2 → raised (there is no old copy)."""

    def __init__(
        self,
        legacy_storage,
        *,
        store: DelphiStore,
        job_id: str,
        write_mode: WriteMode,
    ) -> None:
        self._legacy = legacy_storage
        self._store = store
        self._job_id = job_id
        self._write_mode = write_mode
        self._artifact_count = 0

    # ---- v2 side ----

    def _write_artifacts(self, artifacts) -> None:
        try:
            for artifact_key, payload in artifacts:
                encoded = encode_payload(payload)
                self._store.put(
                    "artifacts",
                    StoreItem(
                        pk=self._job_id,
                        sk=artifact_key,
                        attributes=encoded.meta,
                        blob=encoded.blob,
                    ),
                )
                self._artifact_count += 1
        except Exception as e:
            if self._write_mode is WriteMode.V2:
                raise
            logger.error(
                f"v2 umap artifact write failed for job {self._job_id} "
                f"(write mode 'both': old path keeps serving): {e}"
            )

    def _result(self, legacy_result, models) -> dict:
        if legacy_result is not None:
            return legacy_result
        count = len(models) if isinstance(models, list) else 1
        return {"success": count, "failure": 0}

    # ---- the seven legacy write methods, same signatures ----

    def create_conversation_meta(self, meta):
        legacy_result = (
            self._legacy.create_conversation_meta(meta) if self._legacy else None
        )
        self._write_artifacts([("umap#meta", _model_payload(meta))])
        return self._result(legacy_result, meta)

    def batch_create_comment_embeddings(self, models):
        legacy_result = (
            self._legacy.batch_create_comment_embeddings(models) if self._legacy else None
        )
        self._write_artifacts(
            (f"umap#embeddings#{i:05d}", chunk)
            for i, chunk in enumerate(
                _chunked(_model_payloads(models), EMBEDDINGS_CHUNK_SIZE)
            )
        )
        return self._result(legacy_result, models)

    def batch_create_graph_edges(self, models):
        legacy_result = (
            self._legacy.batch_create_graph_edges(models) if self._legacy else None
        )
        self._write_artifacts(
            (f"umap#graph#{i:05d}", chunk)
            for i, chunk in enumerate(_chunked(_model_payloads(models), GRAPH_CHUNK_SIZE))
        )
        return self._result(legacy_result, models)

    def batch_create_comment_clusters(self, models):
        legacy_result = (
            self._legacy.batch_create_comment_clusters(models) if self._legacy else None
        )
        self._write_artifacts(
            (f"umap#assignments#{i:05d}", chunk)
            for i, chunk in enumerate(
                _chunked(_model_payloads(models), ASSIGNMENTS_CHUNK_SIZE)
            )
        )
        return self._result(legacy_result, models)

    def batch_create_cluster_topics(self, models):
        legacy_result = (
            self._legacy.batch_create_cluster_topics(models) if self._legacy else None
        )
        by_layer: dict = {}
        for payload in _model_payloads(models):
            by_layer.setdefault(payload.get("layer_id"), []).append(payload)
        self._write_artifacts(
            (
                f"umap#keywords#{layer_id}",
                sorted(by_layer[layer_id], key=lambda row: row.get("cluster_id", 0)),
            )
            for layer_id in sorted(by_layer)
        )
        return self._result(legacy_result, models)

    def batch_create_cluster_characteristics(self, models):
        legacy_result = (
            self._legacy.batch_create_cluster_characteristics(models)
            if self._legacy
            else None
        )
        self._write_artifacts(build_features_artifacts(models))
        return self._result(legacy_result, models)

    def batch_create_llm_topic_names(self, models):
        legacy_result = (
            self._legacy.batch_create_llm_topic_names(models) if self._legacy else None
        )
        self._write_artifacts(build_topic_artifacts(models))
        return self._result(legacy_result, models)

    # ---- manifest bookkeeping ----

    def finalize(self) -> None:
        """Record stage status + a log line on the run manifest (best-effort:
        standalone runs may have no manifest row)."""
        try:
            self._store.merge_run_fields(
                self._job_id, {"stage_status": {"umap": {"artifacts": self._artifact_count}}}
            )
            self._store.append_log(
                self._job_id, f"umap stage wrote {self._artifact_count} v2 artifacts"
            )
        except NotFound:
            logger.info(
                f"No run manifest for job {self._job_id!r} (standalone run) — "
                f"umap artifacts written without manifest bookkeeping"
            )
        except Exception as e:
            if self._write_mode is WriteMode.V2:
                raise
            logger.error(f"umap manifest bookkeeping failed for {self._job_id}: {e}")


def make_umap_storage(
    legacy_storage,
    *,
    job_id: str,
    write_mode: WriteMode,
    store: Optional[DelphiStore] = None,
):
    """The storage stack for (legacy_storage, write_mode): plain legacy in
    old mode (zero overhead, byte-identical behavior), the dual-write wrapper
    otherwise. `store` defaults to the configured v2 store."""
    if write_mode is WriteMode.OLD:
        return legacy_storage
    if store is None:
        from delphi_storage import get_store

        store = get_store()
    return DualWriteUmapStorage(
        legacy_storage, store=store, job_id=job_id, write_mode=write_mode
    )
