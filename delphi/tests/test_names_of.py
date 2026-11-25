"""A run that names another run's topics: the source's files (the frame's
``names_of``), the layout read back from them, the copy of the source's rows
into the named run's own batch (the same bytes), and the pipeline's branch,
which never makes a fresh layout and sends nothing when a comment of the
source's layout is no longer shown. Offline; no model, no database."""
import hashlib
import json
import os
from pathlib import Path

import numpy as np
import pytest

from polismath.delphi_storage.codec import encode_family
from polismath.job_child import names_of

# The checkout (in the Delphi test image, the checkout-shaped copy the check
# makes at $POLIS_CHECKOUT_DIR, which holds this input).
ROOT = Path(os.environ.get("POLIS_CHECKOUT_DIR") or Path(__file__).resolve().parents[2])
PROXIMITY = ROOT / "queue-rs/polis-topic-map/tests/fixtures/bg2050/proximity.json"
ZID = 4242


def _number(x):
    # The codec makes every number its canonical text.
    return repr(float(x))


def _wires(keep=None):
    points = sorted(json.loads(PROXIMITY.read_text())["proximity_data"], key=lambda p: p["comment_id"])
    if keep:
        points = points[:keep]
    z = str(ZID)
    nodes, rows = [], []
    for i, p in enumerate(points):
        t = str(p["comment_id"])
        nodes.append({"conversation_id": {"S": z}, "edge_id": {"S": f"{t}_{t}"},
                      "source_id": {"N": t}, "target_id": {"N": t}, "weight": {"N": "1"},
                      "position": {"M": {"x": {"N": _number(p["umap_x"])}, "y": {"N": _number(p["umap_y"])}}}})
        if i + 1 < len(points):
            o = str(points[i + 1]["comment_id"])
            nodes.append({"conversation_id": {"S": z}, "edge_id": {"S": f"{t}_{o}"},
                          "source_id": {"N": t}, "target_id": {"N": o}, "weight": {"N": "0.5"}})
        row = {"conversation_id": {"S": z}, "comment_id": {"N": t}}
        for layer in range(5):
            c = p["clusters"].get(str(layer))
            row[f"layer{layer}_cluster_id"] = {"NULL": True} if c is None else {"N": str(c)}
        rows.append(row)
    return (encode_family(names_of.POSITIONS, nodes), encode_family(names_of.ASSIGNMENTS, rows), points)


def _frame(tmp_path, positions, assignments, sha=None):
    inputs = tmp_path / "inputs/names_of"
    inputs.mkdir(parents=True)
    families = {}
    for family, wire in ((names_of.POSITIONS, positions), (names_of.ASSIGNMENTS, assignments)):
        (inputs / f"{family}.jsonl").write_bytes(wire)
        families[family] = {"file": f"inputs/names_of/{family}.jsonl",
                            "sha256": sha or hashlib.sha256(wire).hexdigest()}
    frame = {"env": "e", "job_id": "j", "run_id": "r", "attempt_id": "a", "lease_epoch": "1", "zid": ZID,
             "config": {"result_backend": "postgres"},
             "writer_base": {"schema": "delphi-writer-base/1", "zid": ZID, "families": {}},
             "names_of": {"schema": names_of.SCHEMA, "job_id": "s-job", "run_id": "s-run",
                          "batch_id": "s-batch", "families": families}}
    path = tmp_path / "frame.json"
    path.write_text(json.dumps(frame))
    return path


def test_without_a_frame_or_a_source_there_is_none(tmp_path):
    assert names_of.load({}) is None
    path = tmp_path / "frame.json"
    path.write_text(json.dumps({"config": {}}))
    assert names_of.load({"DELPHI_FRAME": str(path)}) is None


def test_the_layout_is_the_sources_comments_positions_and_clusters(tmp_path):
    positions, assignments, points = _wires()
    source = names_of.load({"DELPHI_FRAME": str(_frame(tmp_path, positions, assignments))})
    assert (source.job_id, source.batch_id) == ("s-job", "s-batch")
    assert source.comment_ids == [p["comment_id"] for p in points]
    assert np.allclose(source.document_map, [[p["umap_x"], p["umap_y"]] for p in points])
    layers = 1 + max(int(k) for p in points for k, c in p["clusters"].items() if c >= 0)
    assert len(source.cluster_layers) == layers
    for layer, labels in enumerate(source.cluster_layers):
        assert list(labels) == [p["clusters"].get(str(layer), -1) for p in points]


def test_a_file_that_is_not_its_digest_or_is_missing_is_refused(tmp_path):
    positions, assignments, _ = _wires(keep=20)
    with pytest.raises(names_of.SourceError):
        names_of.load({"DELPHI_FRAME": str(_frame(tmp_path / "a", positions, assignments, sha="0" * 64))})
    path = _frame(tmp_path / "b", positions, assignments)
    (path.parent / f"inputs/names_of/{names_of.POSITIONS}.jsonl").unlink()
    with pytest.raises(names_of.SourceError):
        names_of.load({"DELPHI_FRAME": str(path)})


def test_families_of_different_comments_are_refused():
    positions, _, _ = _wires(keep=10)
    _, assignments, _ = _wires(keep=11)
    from polismath.delphi_storage.codec import decode_family, to_python
    rows = lambda w: [{k: to_python(v) for k, v in r.items()} for r in decode_family(w)[1]]
    with pytest.raises(names_of.SourceError):
        names_of.layout(rows(positions), rows(assignments))


def test_the_copy_through_the_writer_is_the_sources_bytes(tmp_path, monkeypatch):
    from polismath.delphi_storage.writer import WriterResource
    positions, assignments, _ = _wires()
    path = _frame(tmp_path, positions, assignments)
    for k, v in {"DELPHI_FRAME": str(path), "DELPHI_OUTPUT_MANIFEST": str(tmp_path / "output-manifest.json"),
                 "DELPHI_JOB_ID": "j", "DELPHI_ATTEMPT_ID": "a", "DELPHI_RUN_ID": "r"}.items():
        monkeypatch.setenv(k, v)
    source = names_of.load()
    writer = WriterResource()
    for family in names_of.FAMILIES:
        for item in source.rows[family]:
            writer.Table(family).put_item(Item=item)
    assert writer.family_wire(names_of.POSITIONS) == positions
    assert writer.family_wire(names_of.ASSIGNMENTS) == assignments


def test_a_comment_no_longer_shown_is_listed():
    positions, assignments, points = _wires(keep=8)
    from polismath.delphi_storage.codec import decode_family, to_python
    rows = lambda w: [{k: to_python(v) for k, v in r.items()} for r in decode_family(w)[1]]
    source = names_of.Source("s", "r", "b")
    source.comment_ids, source.document_map, source.cluster_layers = names_of.layout(rows(positions), rows(assignments))
    tids = [p["comment_id"] for p in points]
    texts = {t: f"comment {t}" for t in tids}
    assert names_of.not_shown(source, set(tids), texts) == []
    assert names_of.not_shown(source, set(tids[1:]), texts) == [tids[0]]
    texts[tids[2]] = " "
    assert names_of.not_shown(source, set(tids), texts) == [tids[2]]


def _pipeline(monkeypatch, tmp_path, selected_of, namer):
    # As the pipeline runs: its own directory on the path (tests/test_topic_namer.py).
    umap_dir = str(ROOT / "delphi/umap_narrative")
    monkeypatch.syspath_prepend(umap_dir)
    from polismath import step_log
    monkeypatch.setattr(step_log, "_record", None)
    monkeypatch.delenv(step_log.SWITCH, raising=False)
    import run_pipeline
    positions, assignments, points = _wires(keep=30)
    monkeypatch.setenv("DELPHI_FRAME", str(_frame(tmp_path, positions, assignments)))
    comments = [{"tid": p["comment_id"], "txt": f"comment {p['comment_id']}", "mod": 1, "active": True}
                for p in points]
    tids = [c["tid"] for c in comments]

    def inputs(zid, selection, facts):
        facts["comments_selected"] = len(tids)
        return comments, {"conversation_name": "x"}, selected_of(tids)

    def never(*a, **k):
        raise AssertionError("a named run never embeds, lays out or clusters")

    seen = {}
    monkeypatch.setattr(run_pipeline, "_read_selected_inputs", inputs)
    monkeypatch.setattr(run_pipeline, "process_selected_comments", never)
    monkeypatch.setattr(run_pipeline, "process_comments", never)
    monkeypatch.setattr(run_pipeline, "_embed", never)
    monkeypatch.setattr(run_pipeline, "_store_base", never)
    monkeypatch.setattr(run_pipeline, "process_layers_and_create_visualizations",
                        lambda *a, **k: seen.update(args=a, kwargs=dict(k, naming=dict(k.get("naming") or {}))))
    ok = run_pipeline._process_conversation(ZID, str(tmp_path), False, False, False, False, {},
                                            selection="participant_visible/1", namer=namer,
                                            namer_dir=str(tmp_path))
    return ok, seen, points


NAMER = {"model": "claude-haiku-5-5", "prompt": "polis-topic-names/1", "thinking": "default"}


def test_the_pipeline_names_the_sources_layout_and_makes_none(monkeypatch, tmp_path):
    ok, seen, points = _pipeline(monkeypatch, tmp_path, set, NAMER)
    assert ok
    document_map, cluster_layers, comment_texts = seen["args"][2], seen["args"][3], seen["args"][4]
    assert np.allclose(document_map, [[p["umap_x"], p["umap_y"]] for p in points])
    assert comment_texts == [f"comment {p['comment_id']}" for p in points]
    assert seen["kwargs"]["naming"] == {}


def test_a_comment_no_longer_shown_sends_nothing(monkeypatch, tmp_path):
    ok, seen, _ = _pipeline(monkeypatch, tmp_path, lambda tids: set(tids[1:]), NAMER)
    assert ok
    assert seen["kwargs"]["naming"] == {"source_refused": "source_comment_not_shown"}


def test_a_source_without_a_namer_is_never_a_fresh_layout(monkeypatch, tmp_path):
    with pytest.raises(ValueError):
        _pipeline(monkeypatch, tmp_path, set, None)



def test_a_comment_no_longer_shown_sends_its_keyword_record_and_leaves_nothing(monkeypatch, tmp_path):
    # Through the naming step itself, as run_delphi.py runs it: the record of
    # a refused naming is sent on the record socket before any label is
    # written, the labels are the keywords, the program never runs, no
    # scratch is made.
    import stat
    import sys

    from polismath import step_log
    from tests.test_topic_namer import CHARACTERISTICS, HAIKU, LAYERS, STUB, Names, stub_argv, topic_namer

    monkeypatch.setattr(step_log, "_record", None)
    monkeypatch.delenv(step_log.SWITCH, raising=False)
    monkeypatch.syspath_prepend(str(ROOT / "delphi/umap_narrative"))
    import run_pipeline

    def never(*a, **k):
        raise AssertionError("the older provider path never runs for a named run")

    monkeypatch.setattr(run_pipeline, "generate_cluster_topic_labels", never)
    monkeypatch.setattr(run_pipeline, "create_visualizations", lambda *a, **k: "index.html")
    monkeypatch.setattr(run_pipeline, "process_layers_and_store_characteristics",
                        lambda *a, **k: {l: {"characteristics": c, "numeric_topic_names": {}}
                                         for l, c in CHARACTERISTICS.items()})
    monkeypatch.setenv("DELPHI_SKIP_DATAMAPPLOT", "1")
    program = tmp_path / "bin" / "polis-topic-names"
    program.parent.mkdir()
    program.write_text(STUB.replace("PYTHON", sys.executable, 1))
    program.chmod(program.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv(topic_namer.BINARY, str(program))
    monkeypatch.setenv("STUB_ARGV_LOG", str(tmp_path / "argv.log"))

    naming = {"source_refused": "source_comment_not_shown"}
    storage = Names()
    out = tmp_path / "out"
    out.mkdir()
    exchange = topic_namer.RecordExchange()
    step_log.record()
    try:
        run_pipeline.process_layers_and_create_visualizations(
            "7", "c", np.zeros((60, 2)), LAYERS, [f"c{i}" for i in range(60)], str(out),
            name_topics=True, dynamo_storage=storage, job_id="job", namer=HAIKU,
            namer_dir=str(tmp_path / "naming"), naming=naming, naming_record_fd=exchange.child_fd)
    finally:
        step_log._record = None
        record, _ = exchange.finish()

    assert stub_argv(tmp_path) == []
    assert not (tmp_path / "naming").exists()
    assert (record["outcome"], record["reason"]) == ("namer_failed", "source_comment_not_shown")
    assert record == naming
    assert {row.model_name for row in storage.rows} == {"keywords"}
    labels = json.loads((out / "7_comment_layer_0_labels.json").read_text())
    assert labels and not any("Generated name" in label for label in labels.values())
