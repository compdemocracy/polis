"""The naming step for a run whose job names a namer (umap_narrative/topic_namer.py).

Nothing here makes a model call or reads a key. The program the step runs
(polis-topic-names) is replaced by a small stand-in executable written by
these tests: it reads hierarchy.json and writes the names.json each test asks
for (a saved reply's names, or one failure outcome), or exits as asked.

The Bowling Green 2050 fixture (tests/fixtures/topic_names/, public data;
see its README) is the hierarchy the 2026-11-22 naming study built for that
conversation, which the step must build again from the same layout.
"""
import json
import os
import stat
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

from polismath import step_log

DELPHI_ROOT = Path(__file__).resolve().parents[1]
FIXTURES = Path(__file__).resolve().parent / "fixtures" / "topic_names"
UMAP_DIR = str(DELPHI_ROOT / "umap_narrative")

topic_namer = pytest.importorskip("umap_narrative.topic_namer")

HAIKU = {"model": "claude-haiku-5-5", "prompt": "polis-topic-names/1", "thinking": "default"}
HAIKU_ARG = '{"model":"claude-haiku-5-5","prompt":"polis-topic-names/1","thinking":"default"}'
FAILURES = ["no_key", "over_run_cap", "too_large", "http_429", "http_500", "timeout", "connect_error",
            "refused", "truncated", "bad_json", "bad_cover", "repeated_names", "bad_length",
            "wrong_language"]

# The stand-in for polis-topic-names. It never reads its environment beyond
# the STUB_* settings below, and never makes a network call.
STUB = r'''#!PYTHON
import json, os, sys, time
args = sys.argv[1:]
log = os.environ.get("STUB_ARGV_LOG")
if log:
    with open(log, "a") as f:
        f.write(json.dumps(args) + "\n")
    # What it was sent, kept beside the log (the step removes its own files).
    with open(args[2], encoding="utf-8") as f, open(log + ".hierarchy.json", "w", encoding="utf-8") as g:
        g.write(f.read())
if os.environ.get("STUB_SLEEP"):
    time.sleep(float(os.environ["STUB_SLEEP"]))
if os.environ.get("STUB_EXIT"):
    sys.exit(int(os.environ["STUB_EXIT"]))
assert args[0] == "name" and args[1] == "--in" and args[3] == "--out" and args[5] == "--namer", args
hierarchy = json.load(open(args[2], encoding="utf-8"))
namer = json.loads(args[6])
outcome = os.environ.get("STUB_OUTCOME", "named")
if outcome == "named":
    names = json.load(open(os.environ["STUB_NAMES"], encoding="utf-8")) if os.environ.get("STUB_NAMES") else {
        tid: "Generated name " + tid for tid in hierarchy["topics"]}
    if os.environ.get("STUB_DROP"):
        names.pop(os.environ["STUB_DROP"])
    doc = {"schema": "polis-topic-names.names/1", "outcome": "named", "reason": None, "names": names,
           "record": dict(namer, tokens_in=25445, tokens_out=10962, dollars=0.0080)}
elif outcome == "garbage":
    open(args[4], "w").write("not json")
    sys.exit(0)
else:
    answered = outcome not in ("no_key", "over_run_cap", "too_large", "connect_error")
    doc = {"schema": "polis-topic-names.names/1", "outcome": outcome, "reason": "stand-in " + outcome,
           "names": {}, "record": dict(namer, tokens_in=1200 if answered else None,
                                       tokens_out=40 if answered else None,
                                       dollars=0.0001 if answered else None)}
json.dump(doc, open(args[4], "w", encoding="utf-8"), ensure_ascii=False)
'''


@pytest.fixture
def stub(tmp_path, monkeypatch):
    path = tmp_path / "bin" / "polis-topic-names"
    path.parent.mkdir()
    path.write_text(STUB.replace("PYTHON", sys.executable, 1))
    path.chmod(path.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv(topic_namer.BINARY, str(path))
    monkeypatch.setenv("STUB_ARGV_LOG", str(tmp_path / "argv.log"))
    for name in ("STUB_SLEEP", "STUB_EXIT", "STUB_OUTCOME", "STUB_NAMES", "STUB_DROP"):
        monkeypatch.delenv(name, raising=False)
    return tmp_path


def stub_argv(tmp_path):
    log = tmp_path / "argv.log"
    return [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []


# --- the Bowling Green 2050 hierarchy ---------------------------------------

def bg2050():
    """The study's layout for Bowling Green 2050 as the pipeline holds it:
    comments in comment order, the 2D map, one cluster array per layer, the
    layer keywords, and the text of every comment the study sampled (any
    other comment's text is a placeholder no sample can equal)."""
    layout = json.loads((FIXTURES / "bg2050_layout.json").read_text())
    texts = json.loads((FIXTURES / "bg2050_sample_comments.json").read_text(encoding="utf-8"))
    expected = json.loads((FIXTURES / "bg2050_hierarchy.json").read_text(encoding="utf-8"))
    ids = layout["comment_id"]
    comment_texts = [texts.get(str(cid), f"(comment {cid}: text not in this fixture)") for cid in ids]
    document_map = np.column_stack([layout["x"], layout["y"]])
    layers = sorted(layout["clusters"], key=int)
    cluster_layers = [np.asarray(layout["clusters"][layer]) for layer in layers]
    layer_data = {int(layer): {"characteristics": {}} for layer in layers}
    for t in expected["topics"].values():
        layer_data[t["layer"]]["characteristics"][t["cluster"]] = {"top_words": t["keywords"] + ["more"]}
    return layer_data, cluster_layers, comment_texts, document_map, expected


def test_the_bowling_green_hierarchy_is_the_one_the_study_built():
    layer_data, cluster_layers, comment_texts, document_map, expected = bg2050()
    built = topic_namer.build_hierarchy(layer_data, cluster_layers, comment_texts, document_map)
    assert len(built["topics"]) == 185
    assert built["layers"] == expected["layers"] == [0, 1, 2, 3]
    # Ids, layers, sizes, parents, the five keywords and the three sample
    # comments, topic by topic, then the whole document.
    assert list(built["topics"]) == sorted(expected["topics"], key=lambda i: tuple(map(int, i.split("_"))))
    for tid, want in expected["topics"].items():
        assert built["topics"][tid] == want, tid
    assert built == expected


def test_the_hierarchy_holds_comment_text_and_keywords_only():
    layer_data, cluster_layers, comment_texts, document_map, _ = bg2050()
    built = topic_namer.build_hierarchy(layer_data, cluster_layers, comment_texts, document_map)
    assert set(built) == {"schema", "layers", "topics"}
    for t in built["topics"].values():
        assert set(t) == {"id", "layer", "cluster", "size", "keywords", "parent", "samples3"}
        assert len(t["keywords"]) <= 5 and len(t["samples3"]) <= 3
        assert all(s in comment_texts for s in t["samples3"])


def test_a_topic_whose_comments_are_all_noise_above_has_no_parent():
    layers = [np.array([0, 0, 1, 1, 2, -1]), np.array([5, 5, -1, -1, 5, 5])]
    texts = [f"c{i}" for i in range(6)]
    data = {0: {"characteristics": {0: {"top_words": ["a"]}}}, 1: {"characteristics": {}}}
    built = topic_namer.build_hierarchy(data, layers, texts, np.zeros((6, 2)))
    assert {t: v["parent"] for t, v in built["topics"].items()} == {"0_0": "1_5", "0_1": None, "0_2": "1_5",
                                                                    "1_5": None}
    assert built["topics"]["0_0"]["keywords"] == ["a"] and built["topics"]["1_5"]["keywords"] == []
    assert built["topics"]["1_5"]["samples3"] == ["c0", "c1", "c4"]


# --- the namer and its refusals ---------------------------------------------

def test_a_namer_is_exactly_model_prompt_and_thinking():
    assert topic_namer.parse_namer(HAIKU_ARG) == HAIKU
    assert topic_namer.namer_argument(dict(reversed(list(HAIKU.items())))) == HAIKU_ARG
    for bad in ["", "null", "[]", '{"model":"claude-haiku-5-5"}',
                HAIKU_ARG.replace("haiku", "opus"), HAIKU_ARG.replace("/1", "/2"),
                HAIKU_ARG.replace("default", "high"), HAIKU_ARG[:-1] + ',"names_of":"j"}']:
        with pytest.raises(topic_namer.NamerRefused):
            topic_namer.parse_namer(bad)


@pytest.mark.parametrize("selection", [None, "all_comments/1", "all_but_moderated_out/1"])
def test_a_namer_under_any_other_comment_rule_is_refused(selection):
    with pytest.raises(topic_namer.NamerRefused):
        topic_namer.check_selection(HAIKU, selection)
    topic_namer.check_selection(None, selection)
    topic_namer.check_selection(HAIKU, "participant_visible/1")


# --- running the program ----------------------------------------------------

def small_hierarchy():
    layers = [np.array([0, 0, 1, 1, -1]), np.array([0, 0, 0, 0, -1])]
    data = {0: {"characteristics": {0: {"top_words": ["a"]}, 1: {"top_words": ["b"]}}},
            1: {"characteristics": {0: {"top_words": ["c"]}}}}
    return topic_namer.build_hierarchy(data, layers, ["t0", "t1", "t2", "t3", "t4"], np.zeros((5, 2)))


def test_named_the_programs_names_are_believed(stub):
    work = stub / "work"
    result = topic_namer.run_namer(HAIKU, small_hierarchy(), str(work))
    assert result["outcome"] == "named" and result["reason"] is None
    assert result["names"] == {"0_0": "Generated name 0_0", "0_1": "Generated name 0_1", "1_0": "Generated name 1_0"}
    assert (result["tokens_in"], result["tokens_out"]) == (25445, 10962)
    [argv] = stub_argv(stub)
    assert argv == ["name", "--in", str(work / "hierarchy.json"), "--out", str(work / "names.json"),
                    "--namer", HAIKU_ARG]
    assert json.loads((stub / "argv.log.hierarchy.json").read_text()) == small_hierarchy()
    # Read, the step's two files are removed.
    assert os.listdir(work) == []


def test_a_saved_reply_for_bowling_green_names_every_topic(stub, monkeypatch, tmp_path):
    layer_data, cluster_layers, comment_texts, document_map, _ = bg2050()
    hierarchy = topic_namer.build_hierarchy(layer_data, cluster_layers, comment_texts, document_map)
    saved = json.loads((FIXTURES / "bg2050_names_haiku.json").read_text(encoding="utf-8"))
    (tmp_path / "names.json").write_text(json.dumps(saved["names"]))
    monkeypatch.setenv("STUB_NAMES", str(tmp_path / "names.json"))
    result = topic_namer.run_namer(HAIKU, hierarchy, str(tmp_path / "work"))
    assert result["outcome"] == "named" and result["names"] == saved["names"]
    assert len(result["names"]) == 185


@pytest.mark.parametrize("outcome", FAILURES)
def test_each_failure_the_program_reports_is_kept_with_its_reason(stub, monkeypatch, outcome):
    monkeypatch.setenv("STUB_OUTCOME", outcome)
    result = topic_namer.run_namer(HAIKU, small_hierarchy(), str(stub / "work"))
    assert result["outcome"] == outcome and result["names"] == {}
    assert result["reason"] == "stand-in " + outcome


@pytest.mark.parametrize("setting,value,reason", [
    ("STUB_EXIT", "1", "exit_1"), ("STUB_EXIT", "2", "exit_2"), ("STUB_EXIT", "101", "exit_101"),
    ("STUB_OUTCOME", "garbage", "names.json is unreadable (JSONDecodeError)"),
    ("STUB_OUTCOME", "namer_failed", "names.json names an unknown outcome"),
    ("STUB_OUTCOME", "http_42", "names.json names an unknown outcome"),
    ("STUB_DROP", "0_1", "names.json does not name exactly the hierarchy's topics"),
])
def test_a_program_that_fails_or_breaks_its_contract_is_namer_failed(stub, monkeypatch, setting, value, reason):
    monkeypatch.setenv(setting, value)
    result = topic_namer.run_namer(HAIKU, small_hierarchy(), str(stub / "work"))
    assert (result["outcome"], result["reason"], result["names"]) == ("namer_failed", reason, {})


def test_a_name_too_long_is_namer_failed(stub, monkeypatch):
    names = {"0_0": "x" * 51, "0_1": "b", "1_0": "c"}
    (stub / "names.json").write_text(json.dumps(names))
    monkeypatch.setenv("STUB_NAMES", str(stub / "names.json"))
    assert topic_namer.run_namer(HAIKU, small_hierarchy(), str(stub / "work"))["outcome"] == "namer_failed"


def test_a_program_that_does_not_finish_is_stopped(stub, monkeypatch):
    monkeypatch.setenv("STUB_SLEEP", "30")
    result = topic_namer.run_namer(HAIKU, small_hierarchy(), str(stub / "work"), timeout=1)
    assert (result["outcome"], result["reason"]) == ("namer_failed", "timeout_waiting_for_program")


def test_no_program_no_call(tmp_path, monkeypatch):
    monkeypatch.delenv(topic_namer.BINARY, raising=False)
    monkeypatch.setenv("PATH", str(tmp_path))
    result = topic_namer.run_namer(HAIKU, small_hierarchy(), str(tmp_path / "work"))
    assert (result["outcome"], result["reason"]) == ("namer_failed", "not_installed")


def test_a_hierarchy_with_no_topic_is_not_sent(stub):
    empty = {"schema": topic_namer.HIERARCHY_SCHEMA, "layers": [0], "topics": {}}
    result = topic_namer.run_namer(HAIKU, empty, str(stub / "work"))
    assert (result["outcome"], result["reason"]) == ("namer_failed", "no_topics")
    assert stub_argv(stub) == []


# --- the pipeline's naming step ---------------------------------------------

@pytest.fixture
def pipeline(monkeypatch):
    # The run's record of its steps, kept only for this test.
    monkeypatch.setattr(step_log, "_record", None)
    monkeypatch.delenv(step_log.SWITCH, raising=False)
    if UMAP_DIR not in sys.path:
        sys.path.insert(0, UMAP_DIR)
    import run_pipeline

    def no_provider(*a, **kw):
        raise AssertionError("the older provider path must not run for a run given a namer")

    monkeypatch.setattr(run_pipeline, "generate_cluster_topic_labels", no_provider)
    monkeypatch.setattr(run_pipeline, "create_visualizations", lambda *a, **kw: "index.html")
    monkeypatch.setenv("DELPHI_SKIP_DATAMAPPLOT", "1")
    yield run_pipeline
    step_log._record = None


class Names:
    """A stand-in for the run's names family writer: what it was asked to store."""

    def __init__(self):
        self.rows = []

    def batch_create_llm_topic_names(self, models):
        self.rows.extend(models)
        return {"success": len(models), "failure": 0}


# 60 comments in three topics at layer 0 and one at layer 1, as the topic map
# step's tests write them (tests/test_topic_map_step.py _write_run).
LAYERS = [np.array([tid % 3 for tid in range(60)]), np.zeros(60, dtype=int)]
CHARACTERISTICS = {0: {0: {"top_words": ["water", "land"], "sample_comments": ["c0"]},
                       1: {"top_words": ["roads"], "sample_comments": ["c1"]},
                       2: {"top_words": [], "sample_comments": []}},
                   1: {0: {"top_words": ["town"], "sample_comments": ["c0"]}}}


DEFAULT_DIR = object()


def run_naming(pipeline, monkeypatch, tmp_path, namer, storage=None, record_fd=None, namer_dir=DEFAULT_DIR):
    monkeypatch.setattr(pipeline, "process_layers_and_store_characteristics",
                        lambda *a, **kw: {l: {"characteristics": c, "numeric_topic_names": {}}
                                          for l, c in CHARACTERISTICS.items()})
    out = tmp_path / "out"
    out.mkdir(exist_ok=True)
    naming = {}
    step_log.record()
    pipeline.process_layers_and_create_visualizations(
        "7", "c", np.zeros((60, 2)), LAYERS, [f"c{i}" for i in range(60)], str(out),
        name_topics=True, dynamo_storage=storage, job_id="job", namer=namer,
        namer_dir=str(tmp_path / "naming") if namer_dir is DEFAULT_DIR else namer_dir, naming=naming,
        naming_record_fd=record_fd)
    labels = {layer: json.loads((out / f"7_comment_layer_{layer}_labels.json").read_text()) for layer in (0, 1)}
    notes = [e for e in step_log.recorded() if e.get("note") == "topic_names"]
    return labels, notes, naming


def test_named_the_models_names_are_the_labels_recorded_as_the_models(pipeline, stub, monkeypatch, tmp_path):
    storage = Names()
    exchange = topic_namer.RecordExchange()
    labels, notes, naming = run_naming(pipeline, monkeypatch, tmp_path, HAIKU, storage, record_fd=exchange.child_fd)
    assert labels == {0: {"0": "0_0: Generated name 0_0", "1": "0_1: Generated name 0_1",
                          "2": "0_2: Generated name 0_2"}, 1: {"0": "1_0: Generated name 1_0"}}
    assert [(n["layer"], n["model"], n["outcome"], n["model_clusters"], n["written_by_model"], n["fallback"])
            for n in notes] == [(0, "claude-haiku-5-5", "named", [0, 1, 2], 3, 0),
                                (1, "claude-haiku-5-5", "named", [0], 1, 0)]
    assert notes[0]["provider"] == "polis-topic-names" and notes[0]["namer"] == HAIKU_ARG
    assert (notes[0]["prompt"], notes[0]["thinking"], notes[0]["reason"]) == ("polis-topic-names/1", "default", None)
    assert naming["outcome"] == "named" and "names" not in naming
    assert {r.model_name for r in storage.rows} == {"claude-haiku-5-5"}
    record, _ = exchange.finish()
    assert record == naming and record["tokens_in"] == 25445
    # The step's scratch files are gone once read.
    assert sorted(os.listdir(tmp_path / "naming")) == []


def test_without_a_namer_the_naming_is_todays_and_the_program_never_runs(pipeline, stub, monkeypatch, tmp_path):
    calls = []

    def provider(characteristics, **kw):
        calls.append(kw["layer_idx"])
        kw["origins"].update({c: "model" for c in characteristics})
        return {c: f"{kw['layer_idx']}_{c}: provider name" for c in characteristics}

    monkeypatch.setattr(pipeline, "generate_cluster_topic_labels", provider)
    monkeypatch.setenv("LLM_PROVIDER", "anthropic")
    monkeypatch.setenv("ANTHROPIC_TOPIC_MODEL", "none")
    monkeypatch.setattr(pipeline, "process_layers_and_store_characteristics",
                        lambda *a, **kw: {l: {"characteristics": c, "numeric_topic_names": {}}
                                          for l, c in CHARACTERISTICS.items()})
    step_log.record()
    out = tmp_path / "out"
    out.mkdir()
    pipeline.process_layers_and_create_visualizations(
        "7", "c", np.zeros((60, 2)), LAYERS, [f"c{i}" for i in range(60)], str(out), name_topics=True)
    assert calls == [0, 1] and stub_argv(stub) == []
    notes = [e for e in step_log.recorded() if e.get("note") == "topic_names"]
    assert [set(n) for n in notes] == [{"note", "layer", "provider", "model", "clusters", "written_by_model",
                                        "fallback", "origin_unknown", "model_clusters"}] * 2
    assert (notes[0]["provider"], notes[0]["model"]) == ("anthropic", "none")
    assert not (tmp_path / "naming").exists()


@pytest.mark.parametrize("outcome", FAILURES + ["exit"])
def test_any_other_outcome_keeps_the_keyword_labels_and_records_why(pipeline, stub, monkeypatch, tmp_path, outcome):
    if outcome == "exit":
        monkeypatch.setenv("STUB_EXIT", "1")
    else:
        monkeypatch.setenv("STUB_OUTCOME", outcome)
    from umap_narrative.topic_naming import _conventional_labels

    storage = Names()
    labels, notes, naming = run_naming(pipeline, monkeypatch, tmp_path, HAIKU, storage)
    for layer in (0, 1):
        assert labels[layer] == {str(k): v for k, v in _conventional_labels(CHARACTERISTICS[layer]).items()}
    word = "namer_failed" if outcome == "exit" else outcome
    for n in notes:
        # Recorded under "keywords", never under the model that was asked.
        assert (n["model"], n["outcome"], n["model_clusters"], n["written_by_model"]) == ("keywords", word, [], 0)
        assert n["namer"] == HAIKU_ARG and n["reason"]
    assert naming["outcome"] == word
    assert {r.model_name for r in storage.rows} == {"keywords"}


@pytest.mark.skipif(not (os.environ.get("DELPHI_TOPIC_MAP_BIN") or __import__("shutil").which("polis-topic-map")),
                    reason="polis-topic-map is not installed")
def test_the_stored_map_keeps_the_models_names_as_written(pipeline, stub, monkeypatch, tmp_path):
    """The names the step wrote, with the run's record of them, drawn by the
    real generator: every name is kept as written under names/3."""
    from polismath.delphi_storage import topic_map
    from tests.test_topic_map_step import _spooled, _write_run, _writer

    labels, _, naming = run_naming(pipeline, monkeypatch, tmp_path, HAIKU)
    execution = topic_map.execution_record(step_log.recorded(), "participant_visible/1")
    monkeypatch.setenv(topic_map.SWITCH, "1")
    writer = _writer(tmp_path, monkeypatch)
    _write_run(writer)
    for layer, by_cluster in labels.items():
        for cluster, label in by_cluster.items():
            writer.Table("Delphi_CommentClustersLLMTopicNames").put_item(Item={
                "conversation_id": "7", "topic_key": f"job#{layer}#{cluster}", "layer_id": layer,
                "cluster_id": int(cluster), "topic_name": label, "model_name": "claude-haiku-5-5"})
    from polismath.job_child import full_pipeline_models
    models = full_pipeline_models(naming)
    assert models["topic"] == "claude-haiku-5-5"
    topic_map.store_run_map(7, "participant_visible/1", models, writer=writer, execution=execution)
    rows = {r["part"]["S"]: r for r in _spooled(writer)[0][topic_map.TOPIC_MAP_FAMILY][1]}
    doc = json.loads(rows["document"]["body"]["S"])
    assert {t["id"]: t["name"] for t in doc["topics"]} == {
        "0_0": "0_0: Generated name 0_0", "0_1": "0_1: Generated name 0_1", "0_2": "0_2: Generated name 0_2",
        "1_0": "1_0: Generated name 1_0"}
    assert doc["provenance"]["names"] == {"rule": "polis-topic-map.names/3", "written_by_model": 4, "generic": 0,
                                          "keywords": 0, "replaced": 0}


# --- the manifest -----------------------------------------------------------

def test_the_manifest_names_the_model_only_when_it_named():
    from polismath import job_child

    today = job_child.full_pipeline_models()
    named = job_child.full_pipeline_models({"outcome": "named", "namer": HAIKU})
    kept = job_child.full_pipeline_models({"outcome": "http_429", "namer": HAIKU})
    assert named == dict(today, topic="claude-haiku-5-5")
    assert kept == dict(today, topic="keywords")
    assert job_child.full_pipeline_models({}) == dict(today, topic="keywords")
    assert job_child.naming_cost({"tokens_in": 25445, "tokens_out": 10962}) == {
        "llm_tokens_in": 25445, "llm_tokens_out": 10962, "provider_batches": None}
    assert job_child.naming_cost({"tokens_in": None, "tokens_out": True}) == {
        "llm_tokens_in": None, "llm_tokens_out": None, "provider_batches": None}


@pytest.mark.parametrize("naming,topic,tokens", [
    (None, None, (None, None)),
    ({"outcome": "named", "namer": HAIKU, "tokens_in": 25445, "tokens_out": 10962}, "claude-haiku-5-5",
     (25445, 10962)),
    ({"outcome": "wrong_language", "namer": HAIKU, "tokens_in": 25445, "tokens_out": 10962}, "keywords",
     (25445, 10962)),
    ({}, "keywords", (None, None)),
])
def test_the_manifest_of_a_run_without_a_namer_is_todays(monkeypatch, naming, topic, tokens):
    import run_delphi
    from polismath import job_child
    from polismath.job_child import census

    built = {}
    monkeypatch.setattr(census, "count_full_pipeline_outputs", lambda *a, **kw: [])
    monkeypatch.setattr(census, "default_dynamodb", lambda region: None)
    monkeypatch.setattr(job_child, "build_manifest", lambda job, **kw: built.update(kw) or kw)
    monkeypatch.setattr(job_child, "write_manifest", lambda job, manifest: None)
    job = type("Job", (), {"inputs": {}})()
    if naming is None:
        run_delphi._finish_daemon_job(job, 7, "us-east-1")
        assert built["models"] == job_child.full_pipeline_models()
        assert built["cost"] == {"llm_tokens_in": None, "llm_tokens_out": None, "provider_batches": None}
    else:
        run_delphi._finish_daemon_job(job, 7, "us-east-1", naming=naming)
        assert built["models"] == dict(job_child.full_pipeline_models(), topic=topic)
        assert (built["cost"]["llm_tokens_in"], built["cost"]["llm_tokens_out"]) == tokens


# --- run_delphi.py's arguments ----------------------------------------------

PIPELINE_STUB = '''import json, os, sys
with open(os.environ["PIPELINE_ARGV"], "a") as f:
    f.write(json.dumps(sys.argv[1:]) + "\\n")
for a in sys.argv[1:]:
    if a.startswith("--namer-dir="):
        d = a.split("=", 1)[1]
        os.makedirs(d)
        open(os.path.join(d, "hierarchy.json"), "w").write("{}")
        open(os.environ["PIPELINE_ARGV"] + ".dir", "w").write(d)
    if a.startswith("--naming-record-fd="):
        os.write(int(a.split("=", 1)[1]), (json.dumps({"schema": "polis-topic-names.run-record/1",
                 "outcome": "named", "namer": {"model": "claude-haiku-5-5"}}) + "\\n").encode())
'''


@pytest.fixture
def delphi_app(tmp_path, monkeypatch):
    from tests.test_run_delphi_exit_codes import STAGES, STUB

    app = tmp_path / "app"
    for name, rel in STAGES.items():
        path = app / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(STUB.format(name=name))
    (app / "umap_narrative" / "run_pipeline.py").write_text(PIPELINE_STUB)
    (app / "run_delphi.py").symlink_to(DELPHI_ROOT / "run_delphi.py")
    bin_dir = tmp_path / "pybin"
    bin_dir.mkdir()
    shim = bin_dir / "python"
    shim.write_text(f'#!/bin/sh\nexec "{sys.executable}" "$@"\n')
    shim.chmod(shim.stat().st_mode | stat.S_IEXEC)
    for key, value in dict(PATH=f"{bin_dir}{os.pathsep}{os.environ['PATH']}", DELPHI_APP_PATH=str(app),
                           STAGE_LOG=str(tmp_path / "stages.log"), PIPELINE_ARGV=str(tmp_path / "argv.log"),
                           LLM_PROVIDER="anthropic", DELPHI_SKIP_DATAMAPPLOT="1").items():
        monkeypatch.setenv(key, value)
    for key in ("DELPHI_OUTPUT_MANIFEST", "DELPHI_RESULT_BACKEND", "DELPHI_LOCAL_OUTPUT_CLEANUP"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.chdir(app)
    return app


def run_delphi_with(app, *extra):
    return subprocess.run([sys.executable, str(app / "run_delphi.py"), "--zid=7", "--include_moderation=False",
                           "--exclude_comment_selections=False", "--selection=participant_visible/1", *extra],
                          cwd=app, capture_output=True, text=True, timeout=120)


def test_without_a_namer_the_pipeline_is_called_as_today(delphi_app, tmp_path):
    done = run_delphi_with(delphi_app)
    assert done.returncode == 0, done.stdout + done.stderr
    [argv] = [json.loads(line) for line in (tmp_path / "argv.log").read_text().splitlines()]
    assert argv == ["--zid=7", "--include_moderation=False", "--exclude_comment_selections=False",
                    "--name-topics", "--selection=participant_visible/1"]


def test_with_a_namer_the_pipeline_is_told_and_its_directory_is_removed(delphi_app, tmp_path):
    done = run_delphi_with(delphi_app, '--namer={"thinking":"default","prompt":"polis-topic-names/1",'
                                       '"model":"claude-haiku-5-5"}')
    assert done.returncode == 0, done.stdout + done.stderr
    [argv] = [json.loads(line) for line in (tmp_path / "argv.log").read_text().splitlines()]
    namer_dir = (tmp_path / "argv.log.dir").read_text()
    assert argv[:-1] == ["--zid=7", "--include_moderation=False", "--exclude_comment_selections=False",
                         "--name-topics", "--selection=participant_visible/1", f"--namer={HAIKU_ARG}",
                         f"--namer-dir={namer_dir}"]
    assert argv[-1].startswith("--naming-record-fd=") and argv[-1].split("=", 1)[1].isdigit()
    assert not os.path.exists(namer_dir)


@pytest.mark.parametrize("extra", [
    ("--selection=all_comments/1", f"--namer={HAIKU_ARG}"),
    ("--selection=all_but_moderated_out/1", f"--namer={HAIKU_ARG}"),
    (f"--namer={HAIKU_ARG.replace('haiku', 'opus')}",),
])
def test_a_namer_this_version_does_not_name_runs_nothing(delphi_app, tmp_path, extra):
    done = run_delphi_with(delphi_app, *extra)
    assert done.returncode == 2 and "--namer refused" in done.stderr
    assert not (tmp_path / "argv.log").exists() and not (tmp_path / "stages.log").exists()
