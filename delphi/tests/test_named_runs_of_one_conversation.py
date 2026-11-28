"""Three runs of one conversation, end to end: a keyword-named run, then two
runs that name its topics (``names_of``), one by claude-haiku-5-5 and one by
claude-sonnet-5-5, each carried through to its stored topic map by the
pipeline's own stored-map step and the real generator (polis-topic-map).

The conversation is Bowling Green 2050 from the public fixtures
(tests/fixtures/topic_names/, see its README): its layout and clusters, and
the text of the comments the naming study sampled. What the run does not
compute here is what needs a model or the database: the embedding, UMAP and
EVoC of the keyword run are replaced by that layout, and the conversation's
comments are given instead of read. Everything after that is the pipeline's:
the keyword run's writes, its keyword labels, its execution record and its
map; the named runs' copy of the keyword run's two families (the files the
job's frame names, as the daemon writes them from the keyword run's stored
batch), their keywords, the naming step and their maps.

No model is called and no key is read: polis-topic-names is the stand-in of
tests/test_topic_namer.py, which writes the names a saved reply of the
2026-11-22 naming study gave (Haiku: bg2050_names_haiku.json; Sonnet: the
reply queue-rs/polis-topic-names/tests/fixtures/replies/bg2050/
sonnet-default-r1.json), or a failure outcome.

Needs the polis-topic-map binary (on PATH, or named by DELPHI_TOPIC_MAP_BIN);
without it the test is skipped.
"""
import hashlib
import json
import os
import shutil
import stat
import sys
import uuid
from pathlib import Path

import numpy as np
import pytest

from polismath import step_log
from polismath.delphi_storage import topic_map
from polismath.delphi_storage.codec import decode_family
from polismath.job_child import names_of

# The checkout (in the Delphi test image, the checkout-shaped copy the check
# makes at $POLIS_CHECKOUT_DIR, which holds the saved reply).
ROOT = Path(os.environ.get("POLIS_CHECKOUT_DIR") or Path(__file__).resolve().parents[2])
FIXTURES = Path(__file__).resolve().parent / "fixtures" / "topic_names"
SONNET_REPLY = ROOT / "queue-rs/polis-topic-names/tests/fixtures/replies/bg2050/sonnet-default-r1.json"
ZID = 4242
SELECTION = "participant_visible/1"
HAIKU = {"model": "claude-haiku-5-5", "prompt": "polis-topic-names/1", "thinking": "default"}
SONNET = {"model": "claude-sonnet-5-5", "prompt": "polis-topic-names/1", "thinking": "default"}
NAMES_FAMILY = "Delphi_CommentClustersLLMTopicNames"

topic_namer = pytest.importorskip("umap_narrative.topic_namer")


def _generator():
    import os
    return os.environ.get(topic_map.BINARY) or shutil.which("polis-topic-map")


pytestmark = pytest.mark.skipif(_generator() is None, reason="polis-topic-map is not installed")


def haiku_names():
    return json.loads((FIXTURES / "bg2050_names_haiku.json").read_text(encoding="utf-8"))["names"]


def sonnet_names():
    """The names of the saved Sonnet reply: its last text block is the JSON
    the prompt asks for, one entry per topic."""
    reply = json.loads(SONNET_REPLY.read_text(encoding="utf-8"))
    text = [c for c in reply["content"] if c["type"] == "text"][-1]["text"]
    return {t["id"]: t["name"] for t in json.loads(text)["topics"]}


def bg2050():
    """Bowling Green 2050 as the pipeline holds it after UMAP and EVoC:
    comments in comment order, the 2D map, one cluster array per layer, and
    each comment's text (a placeholder for a comment the study did not sample)."""
    layout = json.loads((FIXTURES / "bg2050_layout.json").read_text())
    texts = json.loads((FIXTURES / "bg2050_sample_comments.json").read_text(encoding="utf-8"))
    ids = [int(c) for c in layout["comment_id"]]
    comments = [{"tid": t, "txt": texts.get(str(t), f"placeholder for comment {t}"), "mod": 1, "active": True}
                for t in ids]
    document_map = np.column_stack([layout["x"], layout["y"]]).astype(float)
    cluster_layers = [np.asarray(layout["clusters"][l]) for l in sorted(layout["clusters"], key=int)]
    return comments, ids, document_map, cluster_layers


class Run:
    """One run's job frame, environment and directory, as the daemon gives
    them to the child: its own attempt (so its own result batch), its scope,
    and for a named run the source's files under ``names_of``."""

    def __init__(self, root, monkeypatch, scope, source=None):
        self.dir = root
        self.dir.mkdir(parents=True)
        self.job_id, self.run_id, self.attempt_id = [str(uuid.uuid4()) for _ in range(3)]
        frame = dict(schema="polis-jobs.frame/1", env="shadow-proof", zid=ZID, job_id=self.job_id,
                     run_id=self.run_id, attempt_id=self.attempt_id, lease_epoch="1",
                     config={"result_backend": "postgres", "result_scope": scope, "selection": SELECTION},
                     writer_base={"schema": "delphi-writer-base/1", "zid": ZID, "families": {}})
        if source is not None:
            inputs = self.dir / "inputs/names_of"
            inputs.mkdir(parents=True)
            families = {}
            for family in names_of.FAMILIES:
                wire = source.writer.family_wire(family)
                (inputs / f"{family}.jsonl").write_bytes(wire)
                families[family] = {"file": f"inputs/names_of/{family}.jsonl",
                                    "sha256": hashlib.sha256(wire).hexdigest()}
            frame["names_of"] = {"schema": names_of.SCHEMA, "job_id": source.job_id, "run_id": source.run_id,
                                 "batch_id": source.attempt_id, "families": families}
        (self.dir / "frame.json").write_text(json.dumps(frame))
        for key, value in dict(DELPHI_RESULT_BACKEND="postgres",
                               DELPHI_OUTPUT_MANIFEST=str(self.dir / "manifest.json"),
                               DELPHI_FRAME=str(self.dir / "frame.json"), DELPHI_JOB_ID=self.job_id,
                               DELPHI_RUN_ID=self.run_id, DELPHI_ATTEMPT_ID=self.attempt_id,
                               DELPHI_RESULT_SCOPE=scope).items():
            monkeypatch.setenv(key, value)
        from polismath.delphi_storage.writer import WriterResource
        self.writer = WriterResource()

    def spooled(self):
        # The attempt's files, written once, as the child writes them at its end.
        if not hasattr(self, "_spooled"):
            files = self.writer.spool()
            self._spooled = {family: decode_family((self.writer.directory / d["file"]).read_bytes())
                             for family, d in files.items()}
        return self._spooled

    def document(self):
        rows = {r["part"]["S"]: r for r in self.spooled()[topic_map.TOPIC_MAP_FAMILY][1]}
        assert "document" in rows, sorted(rows)
        return json.loads(rows["document"]["body"]["S"])


@pytest.fixture
def pipeline(tmp_path, monkeypatch):
    """run_pipeline as the shadow runs it (docker-compose.yml's delphi-shadow:
    the step log on, no layer pages, the topic map step on, Anthropic named
    with model ``none`` and no key), with the model calls and the
    conversation read replaced."""
    monkeypatch.syspath_prepend(str(ROOT / "delphi/umap_narrative"))
    monkeypatch.setattr(step_log, "_record", None)
    monkeypatch.delenv(step_log.SWITCH, raising=False)
    for key, value in dict(DELPHI_SKIP_DATAMAPPLOT="1", LLM_PROVIDER="anthropic", ANTHROPIC_TOPIC_MODEL="none",
                           **{topic_map.SWITCH: "1"}).items():
        monkeypatch.setenv(key, value)
    for key in ("ANTHROPIC_API_KEY", "ANTHROPIC_MODEL", "DELPHI_EMBEDDINGS_TABLE", "DYNAMODB_ENDPOINT"):
        monkeypatch.delenv(key, raising=False)
    import run_pipeline

    comments, ids, document_map, cluster_layers = bg2050()

    def inputs(zid, selection, facts):
        assert (zid, selection) == (ZID, SELECTION)
        facts["comments_read"] = facts["comments_embedded"] = len(comments)
        facts["comments_selected"] = facts["comments_used"] = len(comments)
        return comments, {"conversation_name": "Bowling Green 2050"}, set(ids)

    def layout(selected_comments, conversation_id, selected):
        # In place of the embedding, UMAP and EVoC: the study's layout.
        texts = [c["txt"] for c in selected_comments]
        vectors = np.zeros((len(ids), 8))
        return (texts, ids, vectors), document_map, vectors, cluster_layers, texts, ids

    def no_key(*a, **kw):
        # What the shadow's provider does with no key: it fails, so every
        # layer keeps its keyword labels.
        raise RuntimeError("no key")

    monkeypatch.setattr(run_pipeline, "_read_selected_inputs", inputs)
    monkeypatch.setattr(run_pipeline, "process_selected_comments", layout)
    monkeypatch.setitem(run_pipeline.generate_cluster_topic_labels.__globals__, "get_model_provider", no_key)

    stub = tmp_path / "bin" / "polis-topic-names"
    stub.parent.mkdir()
    from tests.test_topic_namer import STUB
    stub.write_text(STUB.replace("PYTHON", sys.executable, 1))
    stub.chmod(stub.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv(topic_namer.BINARY, str(stub))
    for key in ("STUB_SLEEP", "STUB_EXIT", "STUB_OUTCOME", "STUB_NAMES", "STUB_DROP", "STUB_ARGV_LOG"):
        monkeypatch.delenv(key, raising=False)

    real_send = topic_namer.send_record

    def run(name, scope, namer=None, source=None, names=None, outcome=None, refused_sends=0):
        r = Run(tmp_path / name, monkeypatch, scope, source)
        r.record = None
        sends = []

        def send(fd, result):
            # The first refused_sends sends of the record fail, as a write to
            # a pipe whose reader is gone does.
            sends.append(result["outcome"])
            if len(sends) <= refused_sends:
                raise OSError("the record pipe is refused for this test")
            real_send(fd, result)

        monkeypatch.setattr(topic_namer, "send_record", send)
        r.sends = sends
        if names is not None:
            (r.dir / "saved-names.json").write_text(json.dumps(names))
            monkeypatch.setenv("STUB_NAMES", str(r.dir / "saved-names.json"))
        else:
            monkeypatch.delenv("STUB_NAMES", raising=False)
        if outcome is not None:
            monkeypatch.setenv("STUB_OUTCOME", outcome)
        else:
            monkeypatch.delenv("STUB_OUTCOME", raising=False)
        step_log._record = None
        step_log.record()
        out = r.dir / "out"
        out.mkdir()
        extra = {}
        if namer is not None:
            # As run_delphi.py gives them: the attempt's naming directory and
            # the socket the naming's record is sent and acknowledged on.
            (r.dir / "naming").mkdir()
            exchange = topic_namer.RecordExchange()
            extra = dict(namer_dir=str(r.dir / "naming"), naming_record_fd=exchange.child_fd)
        try:
            assert run_pipeline._process_conversation(
                ZID, str(out), True, True, False, False, {}, selection=SELECTION, namer=namer, **extra)
        finally:
            if extra:
                r.record, _ = exchange.finish()
                topic_namer.set_acknowledged(True)
        if namer is not None:
            # Nothing of the naming is left in the attempt's directory.
            assert os.listdir(r.dir / "naming") == []
        r.steps = step_log.recorded()
        step_log._record = None
        return r

    yield run
    step_log._record = None


def structure(doc):
    """Everything of a stored map but its names and its record of the run:
    the bounds, the levels, every point (id, position, order, topic per
    level) and every topic (id, level, cluster, size, centre, parent, colours)."""
    topics = [{k: v for k, v in t.items() if k not in ("name", "key")} for t in doc["topics"]]
    rest = {k: v for k, v in doc.items() if k not in ("topics", "provenance", "run")}
    return rest, topics


def names(doc):
    return {t["id"]: t["name"] for t in doc["topics"]}


def topic_notes(run):
    return [e for e in run.steps if e.get("note") == "topic_names"]


def test_a_keyword_run_and_its_haiku_and_sonnet_namings_share_one_map_and_differ_in_their_names(pipeline):
    keyword = pipeline("keyword", "delphi")
    haiku = pipeline("haiku", "delphi:names:claude-haiku-5-5.p1.default", HAIKU, keyword, haiku_names())
    sonnet = pipeline("sonnet", "delphi:names:claude-sonnet-5-5.p1.default", SONNET, keyword, sonnet_names())
    runs = {"keyword": keyword, "haiku": haiku, "sonnet": sonnet}
    docs = {k: r.document() for k, r in runs.items()}

    # Three jobs, three result batches.
    assert len({r.job_id for r in runs.values()}) == len({r.attempt_id for r in runs.values()}) == 3
    for k, r in runs.items():
        assert docs[k]["run"]["jobId"] == docs[k]["provenance"]["jobId"] == r.job_id
        assert docs[k]["provenance"]["batchId"] == r.attempt_id

    # The named runs hold the keyword run's positions and clusters, byte for
    # byte, and laid out nothing: no embedding, no UMAP, no EVoC.
    source_wires = {f: keyword.writer.family_wire(f) for f in names_of.FAMILIES}
    for r in (haiku, sonnet):
        assert {f: r.writer.family_wire(f) for f in names_of.FAMILIES} == source_wires
        steps = [e["step"] for e in r.steps if "step" in e]
        assert "names_of" in steps and "embed" not in steps
        copied = next(e for e in r.steps if e.get("step") == "names_of")
        assert (copied["source_job"], copied["source_batch"], copied["not_shown"]) == (
            keyword.job_id, keyword.attempt_id, 0)
    inputs = {k: {i["family"]: i["sha256"] for i in d["provenance"]["inputs"]} for k, d in docs.items()}
    for family in names_of.FAMILIES:
        assert inputs["keyword"][family] == inputs["haiku"][family] == inputs["sonnet"][family]

    # One map: the points (ids, positions, order, topic per level), the
    # levels, the topics (ids, levels, clusters, sizes, centres, parents).
    assert structure(docs["haiku"]) == structure(docs["keyword"]) == structure(docs["sonnet"])
    points = docs["keyword"]["points"]
    assert len(points["id"]) == 3162 and len(docs["keyword"]["topics"]) == 185
    assert [lvl["level"] for lvl in docs["keyword"]["levels"]] == [0, 1, 2, 3]

    # Different names: the keyword labels, then exactly each saved reply's.
    assert names(docs["haiku"]) == {tid: f"{tid}: {n}" for tid, n in haiku_names().items()}
    assert names(docs["sonnet"]) == {tid: f"{tid}: {n}" for tid, n in sonnet_names().items()}
    assert all(n.startswith("Keywords: ") for n in names(docs["keyword"]).values())
    # Every model name differs from its topic's keyword label; the two
    # models agree on a few topics' names (both call 0_0 "SKyPAC
    # Performances and Bookings") and differ on most.
    for tid, label in names(docs["keyword"]).items():
        assert names(docs["haiku"])[tid] != label and names(docs["sonnet"])[tid] != label, tid
    same = [tid for tid in names(docs["haiku"]) if names(docs["haiku"])[tid] == names(docs["sonnet"])[tid]]
    assert 0 < len(same) < 185 // 4, same
    assert docs["keyword"]["provenance"]["names"] == {"rule": "polis-topic-map.names/3", "written_by_model": 0,
                                                      "generic": 0, "keywords": 185, "replaced": 0}
    for k in ("haiku", "sonnet"):
        assert docs[k]["provenance"]["names"] == {"rule": "polis-topic-map.names/3", "written_by_model": 185,
                                                  "generic": 0, "keywords": 0, "replaced": 0}

    # Who named each map. provenance.models.topic is the run's manifest
    # model (job_child.full_pipeline_models): the model when it named, else
    # what a run without a namer has always recorded (here the shadow's
    # ANTHROPIC_TOPIC_MODEL, ``none``). run.topicModel is the names rows'
    # model_name, and each layer's naming is in the execution record.
    assert {k: d["provenance"]["models"]["topic"] for k, d in docs.items()} == {
        "keyword": "none", "haiku": "claude-haiku-5-5", "sonnet": "claude-sonnet-5-5"}
    assert {k: d["run"]["topicModel"] for k, d in docs.items()} == {
        "keyword": "none", "haiku": "claude-haiku-5-5", "sonnet": "claude-sonnet-5-5"}
    for k, namer in (("haiku", HAIKU), ("sonnet", SONNET)):
        layers = docs[k]["provenance"]["execution"]["algorithms"]["topic_names"]
        assert [(n["layer"], n["model"], n["outcome"], n["reason"], n["fallback"]) for n in layers] == [
            (layer, namer["model"], "named", None, 0) for layer in range(4)]
        assert sum(len(n["model_clusters"]) for n in layers) == 185
    keyword_layers = docs["keyword"]["provenance"]["execution"]["algorithms"]["topic_names"]
    assert [(n["layer"], n["model"], n["model_clusters"]) for n in keyword_layers] == [
        (layer, "none", []) for layer in range(4)]

    # The record each named run sent to run_delphi.py (for its manifest),
    # once, before any label was written, says what the map says. A run
    # without a namer sends none.
    from polismath.job_child import full_pipeline_models
    assert keyword.record is None and keyword.sends == []
    for k, namer in (("haiku", HAIKU), ("sonnet", SONNET)):
        record = runs[k].record
        assert runs[k].sends == ["named"]
        assert (record["outcome"], record["reason"], record["namer"]) == ("named", None, namer)
        assert "names" not in record
        assert full_pipeline_models(record)["topic"] == docs[k]["provenance"]["models"]["topic"]


def test_a_named_run_whose_namer_fails_stores_the_sources_keyword_names_under_keywords(pipeline):
    keyword = pipeline("keyword", "delphi")
    failed = pipeline("failed", "delphi:names:claude-haiku-5-5.p1.default", HAIKU, keyword, outcome="http_429")
    source, doc = keyword.document(), failed.document()

    assert structure(doc) == structure(source)
    assert names(doc) == names(source)
    assert doc["provenance"]["names"] == source["provenance"]["names"]
    # Recorded as keywords with the reason, never under the model it asked.
    assert doc["provenance"]["models"]["topic"] == doc["run"]["topicModel"] == "keywords"
    layers = doc["provenance"]["execution"]["algorithms"]["topic_names"]
    assert [(n["layer"], n["model"], n["outcome"], n["reason"], n["model_clusters"]) for n in layers] == [
        (layer, "keywords", "http_429", "stand-in http_429", []) for layer in range(4)]
    assert all(n["namer"] == topic_namer.namer_argument(HAIKU) for n in layers)
    assert {r["model_name"]["S"] for r in failed.spooled()[NAMES_FAMILY][1]} == {"keywords"}
    # The record sent for the manifest says the same, with the reason.
    from polismath.job_child import full_pipeline_models
    assert failed.sends == ["http_429"]
    assert (failed.record["outcome"], failed.record["reason"]) == ("http_429", "stand-in http_429")
    assert full_pipeline_models(failed.record)["topic"] == "keywords"


def test_a_named_run_whose_record_cannot_be_sent_stores_the_sources_keyword_names_with_the_cost(pipeline):
    # The model answered, but its record could not reach run_delphi.py: its
    # names are never published; the source's keyword names are, recorded as
    # keywords with the reason and the call's token counts.
    keyword = pipeline("keyword", "delphi")
    unsent = pipeline("unsent", "delphi:names:claude-haiku-5-5.p1.default", HAIKU, keyword, haiku_names(),
                      refused_sends=1)
    source, doc = keyword.document(), unsent.document()

    assert unsent.sends == ["named", "namer_failed"]
    assert structure(doc) == structure(source)
    assert names(doc) == names(source)
    assert doc["provenance"]["names"] == source["provenance"]["names"]
    assert doc["provenance"]["models"]["topic"] == doc["run"]["topicModel"] == "keywords"
    layers = doc["provenance"]["execution"]["algorithms"]["topic_names"]
    assert [(n["layer"], n["model"], n["outcome"], n["reason"], n["model_clusters"]) for n in layers] == [
        (layer, "keywords", "namer_failed", "record_unsent (OSError)", []) for layer in range(4)]
    assert {r["model_name"]["S"] for r in unsent.spooled()[NAMES_FAMILY][1]} == {"keywords"}
    record = unsent.record
    assert (record["outcome"], record["reason"]) == ("namer_failed", "record_unsent (OSError)")
    assert (record["tokens_in"], record["tokens_out"]) == (25445, 10962)
