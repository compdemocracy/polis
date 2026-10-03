"""The codec's golden corpus: one generated file per family, every value kind.

``python3 -m polismath.delphi_storage.golden_corpus`` (from ``delphi/``)
rewrites ``golden/<family>.jsonl`` and ``golden/SHA256SUMS``. The committed
files are the cross-language contract: the Python test regenerates them and
requires identical bytes; the server's Node test decodes and re-encodes them and
requires identical bytes. Every item is a generated fixture; no conversation
content, no production data. Attribute names follow each table's current
writers (P-076 catalog), so the corpus doubles as the shape record per family.

``cross_items()`` is the small item set the Node test builds independently in
TypeScript and writes to ``golden/cross/written-by-node.jsonl``; the Python
test decodes that file and compares it with this definition (TS writes ->
Python reads). Python writes -> TS reads is the main corpus.
"""

from __future__ import annotations

import hashlib
import pathlib
import sys
from decimal import Decimal as D
from typing import Any, Dict, List

if __package__ in (None, ""):
    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

from polismath.delphi_storage.codec import FAMILIES, encode_family, item_from_python  # noqa: E402

GOLDEN = pathlib.Path(__file__).resolve().parent / "golden"

# Hand-tagged values the resource form cannot express or that need exact text.
EDGE = {
    "empty_string": {"S": ""},
    "nul_and_controls": {"S": "a\u0000b\u0001c\u001fd\u007fe\b\f\n\r\t\"\\/"},
    "unicode": {"S": "caf\u00e9 \u4e2d\u6587 \U0001f600 \u2028\u2029"},
    "json_text": {"S": '{"id":"generated","paragraphs":[{"title":"A"}]}'},
    "truncated_json_text": {"S": '{"id":"generated","paragraphs":[{"tit'},
    "null": {"NULL": True},
    "true": {"BOOL": True},
    "false": {"BOOL": False},
    "binary": {"B": b"\x00\x01\xfe\xff generated"},
    "numbers": {"L": [{"N": "0"}, {"N": "-1"}, {"N": "0.000001"}, {"N": "123456.789"},
                      {"N": "12345678901234567890123456789012345678"},
                      {"N": "-0.0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001"},
                      {"N": "99999999999999999999999999999999999999" + "0" * 88}]},
    "string_set": {"SS": ["b", "a", "\u00e9", "A", "\U0001f600"]},
    "number_set": {"NS": ["10", "9", "-1", "0.5"]},
    "binary_set": {"BS": [b"\x02", b"\x01", b"\x00\x00"]},
    "nested": {"M": {"z": {"L": [{"M": {}}, {"L": []}, {"NULL": True}]}, "a": {"M": {"b": {"S": "c"}}}}},
}


def _job_queue() -> List[Dict[str, Any]]:
    base = {
        "status": "COMPLETED", "created_at": "2023-11-14T20:00:00.000000", "updated_at": "2023-11-14T20:30:00.000000",
        "started_at": "2023-11-14T20:01:00.000000", "completed_at": "2023-11-14T20:30:00.000000",
        "conversation_id": "9001", "job_type": "FULL_PIPELINE", "priority": 50, "version": 3,
        "worker_id": "generated-worker-1", "report_id": "r9001generated",
        "job_config": '{"stages":[]}', "job_results": '{"result_type":"FULL_PIPELINE","status":"completed"}',
        "logs": '{"entries":[{"timestamp":"2023-11-14T20:30:00","level":"INFO","message":"generated"}]}',
        "retry_count": 0, "max_retries": 3, "timeout_seconds": 7200,
    }
    items = [item_from_python({**base, "job_id": "00000000-0000-4000-8000-000000009001"})]
    items.append(item_from_python({
        **base, "job_id": "batch_report_9001_1700000000_generated", "job_type": "CREATE_NARRATIVE_BATCH",
        "status": "PROCESSING", "batch_id": "msgbatch_generated", "process_exit_confirmed": False,
        "checker_schedule_failed": False, "superseded_by": None,
    }))
    edge = item_from_python({**base, "job_id": "00000000-0000-4000-8000-000000009002", "status": "FAILED"})
    edge.update({k: v for k, v in EDGE.items()})
    items.append(edge)
    return items


def corpus() -> Dict[str, List[Dict[str, Any]]]:
    zid, rid = "9001", "r9001generated"
    tick = "9001:7"
    c: Dict[str, List[Dict[str, Any]]] = {}
    c["Delphi_PCAConversationConfig"] = [item_from_python({
        "zid": zid, "latest_math_tick": 7, "participant_count": 12, "comment_count": 6, "group_count": 2,
        "last_updated": 1700000000000})]
    c["Delphi_PCAResults"] = [item_from_python({
        "zid": zid, "math_tick": 7, "timestamp": 1700000000000, "participant_count": 12, "comment_count": 6,
        "pca": {"center": [D("0.25"), D("-0.125"), D("0")], "components": [[D("0.6"), D("-0.8")], [D("0.8"), D("0.6")]]},
        "consensus_comments": {"agree": [{"tid": 1, "p-success": D("0.9")}], "disagree": []}})]
    c["Delphi_KMeansClusters"] = [item_from_python({
        "zid_tick": tick, "group_id": g, "zid": zid, "center": [D("0.5") * (g + 1), D("-0.25")],
        "member_count": 3, "members": [g * 3 + i for i in range(3)]}) for g in range(2)]
    c["Delphi_CommentRouting"] = [item_from_python({
        "zid_tick": tick, "comment_id": str(t), "zid": zid, "priority": D("0.75") - D(t) / 10,
        "stats": {"agree": t, "disagree": 1, "pass": 0}, "consensus_score": D("0.125")}) for t in range(3)]
    c["Delphi_RepresentativeComments"] = [item_from_python({
        "zid_tick_gid": f"{tick}:0", "comment_id": str(t), "zid": zid, "group_id": 0,
        "repness": D("1.5") + t}) for t in range(2)]
    c["Delphi_PCAParticipantProjections"] = [item_from_python({
        "zid_tick": tick, "participant_id": str(p), "zid": zid, "coordinates": [D("0.1") * p, D("-0.2")],
        "group_id": p % 2}) for p in range(3)]
    c["Delphi_UMAPConversationConfig"] = [item_from_python({
        "conversation_id": zid, "processed_date": "2023-11-14T20:10:00", "num_comments": 6,
        "num_participants": 12, "embedding_model": "generated-embedding-model",
        "umap_parameters": {"n_components": 2, "metric": "cosine", "n_neighbors": 15, "min_dist": D("0.1")},
        "evoc_parameters": {"min_samples": 5}, "cluster_layers": [6, 3],
        "metadata": {"generated": True, "notes": None}})]
    c["Delphi_CommentEmbeddings"] = [item_from_python({
        "conversation_id": zid, "comment_id": t,
        "embedding": {"vector": [D("0.0123456789"), D("-0.5"), D("1")], "dimensions": 3,
                      "model": "generated-embedding-model"}}) for t in range(3)]
    c["Delphi_CommentHierarchicalClusterAssignments"] = [item_from_python({
        "conversation_id": zid, "comment_id": t, "is_outlier": t == 2,
        "layer0_cluster_id": -1 if t == 2 else t % 2, "layer1_cluster_id": 0,
        "distance_to_centroid": {"0": D("0.123"), "1": D("0.5")},
        "cluster_confidence": {"0": D("0.95"), "1": D("0.87")}}) for t in range(3)]
    c["Delphi_CommentHierarchicalClusterAssignments"][1]["layer2_cluster_id"] = {"NULL": True}
    c["Delphi_CommentClustersStructureKeywords"] = [item_from_python({
        "conversation_id": zid, "cluster_key": f"layer0_{k}", "layer_id": 0, "cluster_id": k,
        "topic_label": f"Generated label {k}", "size": 2, "sample_comments": [f"generated {k}a", f"generated {k}b"],
        "centroid_coordinates": {"x": D("1.25"), "y": D("-3.5")}, "top_words": ["alpha", "beta"],
        "top_tfidf_scores": [D("0.5"), D("0.25")], "parent_cluster": {"layer_id": 1, "cluster_id": 0},
        "child_clusters": []}) for k in range(2)]
    c["Delphi_UMAPGraph"] = [
        item_from_python({"conversation_id": zid, "edge_id": "0_0", "source_id": 0, "target_id": 0,
                          "weight": 1, "distance": 0, "is_nearest_neighbor": True,
                          "shared_cluster_layers": [], "position": {"x": D("1.5"), "y": D("-2.25")}}),
        item_from_python({"conversation_id": zid, "edge_id": "0_1", "source_id": 0, "target_id": 1,
                          "weight": D("0.75"), "distance": D("0.25"), "is_nearest_neighbor": False,
                          "shared_cluster_layers": [0, 1]}),
    ]
    c["Delphi_CommentClustersFeatures"] = [item_from_python({
        "conversation_id": zid, "cluster_key": "layer0_0", "layer_id": 0, "cluster_id": 0, "size": 2,
        "top_words": ["alpha"], "top_tfidf_scores": [D("0.5")], "sample_comments": ["generated"]})]
    c["Delphi_CommentClustersLLMTopicNames"] = [
        item_from_python({"conversation_id": zid, "topic_key": "00000000-0000-4000-8000-000000009001#0#0",
                          "layer_id": 0, "cluster_id": 0, "topic_name": "Generated topic",
                          "model_name": "generated-model-a", "created_at": "2023-11-14T20:20:00.000000",
                          "job_id": "00000000-0000-4000-8000-000000009001"}),
        item_from_python({"conversation_id": zid, "topic_key": "layer0_1", "layer_id": 0, "cluster_id": 1,
                          "topic_name": "Generated legacy-key topic", "model_name": "unknown",
                          "created_at": "2023-11-13T08:00:00"}),
    ]
    c["Delphi_NarrativeReports"] = [
        item_from_python({"rid_section_model": f"{rid}#group_informed_consensus#generated-model-a",
                          "timestamp": "2023-11-14T20:40:00.000000", "report_id": rid,
                          "section": "group_informed_consensus", "model": "generated-model-a",
                          "job_id": "batch_report_9001_1700000000_generated", "batch_id": "msgbatch_generated",
                          "metadata": {"tokens": 1234, "generated": True}}),
        item_from_python({"rid_section_model": f"{rid}#topic_x#generated-model-a",
                          "timestamp": "2023-11-14T20:41:00.000000", "report_id": rid,
                          "section": "topic_x", "model": "generated-model-a"}),
    ]
    c["Delphi_NarrativeReports"][0]["report_data"] = EDGE["json_text"]
    c["Delphi_NarrativeReports"][1]["report_data"] = {"M": {"paragraphs": {"L": []}, "id": {"S": "map form"}}}
    c["Delphi_JobQueue"] = _job_queue()
    c["Delphi_JobActiveGuard"] = [
        item_from_python({"guard_key": "scope#FULL_PIPELINE#9001#r9001generated", "job_id": "00000000-0000-4000-8000-000000009001",
                          "job_type": "FULL_PIPELINE", "conversation_id": zid, "report_id": rid,
                          "config_hash": "generated-hash", "version": 1,
                          "created_at": "2023-11-14T20:00:00.000Z", "updated_at": "2023-11-14T20:00:00.000Z"}),
        item_from_python({"guard_key": "idem#generated-key", "job_id": "00000000-0000-4000-8000-000000009001",
                          "scope_guard_key": "scope#FULL_PIPELINE#9001#r9001generated", "conversation_id": zid,
                          "report_id": rid, "job_type": "FULL_PIPELINE", "config_hash": "generated-hash", "version": 1,
                          "created_at": "2023-11-14T20:00:00.000Z", "updated_at": "2023-11-14T20:00:00.000Z",
                          "binding_expires_at": "2023-11-15T20:00:00.000Z"}),
    ]
    c["Delphi_CommentExtremity"] = [item_from_python({
        "conversation_id": zid, "comment_id": str(t), "extremity_value": D("0.5") + t,
        "calculation_method": "pca_based", "calculation_timestamp": "2023-11-14T20:05:00",
        "component_values": {"pc1": D("0.25")}}) for t in range(2)]
    c["Delphi_TopicAgendaSelections"] = [item_from_python({
        "conversation_id": zid, "participant_id": "3", "selections": [{"layer_id": 0, "cluster_id": 1}]})]
    c["Delphi_CollectiveStatement"] = [item_from_python({
        "zid_topic_jobid": f"{zid}#00000000-0000-4000-8000-000000009001#0#0#00000000-0000-4000-8000-0000000c0001",
        "zid": zid, "topic_key": "00000000-0000-4000-8000-000000009001#0#0", "topic_name": "Generated topic",
        "statement_data": '{"paragraphs":[{"id":"p1","title":"Generated","sentences":[]}]}',
        "comments_data": '[{"comment_id":1,"comment_text":"generated"}]',
        "created_at": "2023-11-14T21:00:00.000Z", "model": "generated-model-a"})]
    c["report_narrative_store"] = [
        item_from_python({"rid_section_model": f"{rid}#group_informed_consensus#openai",
                          "timestamp": "2023-11-14T21:30:00.000Z", "report_id": rid, "model": "openai",
                          "report_data": '{"id":"generated"}', "errors": None}),
        item_from_python({"rid_section_model": f"{rid}#topics", "timestamp": "2023-11-14T21:31:00.000Z",
                          "report_data": '[{"name":"generated"}]'}),
    ]
    assert set(c) == set(FAMILIES), set(FAMILIES) ^ set(c)
    return c


def cross_items() -> List[Dict[str, Any]]:
    """Built identically by the Node test (server/__tests__/unit/delphiStorageCodec.test.ts)."""
    return [
        {"job_id": {"S": "cross-1"}, "n": {"N": "-12.5"}, "s": {"S": "caf\u00e9\u0000\U0001f600"},
         "b": {"B": b"\x00\xff"}, "ss": {"SS": ["z", "a"]}, "ns": {"NS": ["2", "10"]},
         "bs": {"BS": [b"\x09", b"\x01"]}, "l": {"L": [{"BOOL": False}, {"NULL": True}]},
         "m": {"M": {"k2": {"N": "1"}, "k1": {"S": "{\"json\":true}"}}}},
        {"job_id": {"S": "cross-0"}, "empty": {"S": ""}},
    ]


def write() -> None:
    GOLDEN.mkdir(exist_ok=True)
    sums = []
    for family, items in sorted(corpus().items()):
        data = encode_family(family, items)
        (GOLDEN / f"{family}.jsonl").write_bytes(data)
        sums.append(f"{hashlib.sha256(data).hexdigest()}  {family}.jsonl\n")
    (GOLDEN / "SHA256SUMS").write_text("".join(sums))


if __name__ == "__main__":
    write()
