"""The Delphi shadow's selection: every comment embedded, only what
participants are shown laid out, clustered, named and stored.

The rows are the selection golden (tests/fixtures/selection/participant_visible.json),
written by the Rust contract test from the contract's own rule: every
moderation state a comment can be in (accepted, unmoderated, rejected), with
inactive and muted (velocity 0 or below) comments among them. Here:

- the Python rule keeps the same comments under the same digest as the Rust
  one, open and under strict moderation;
- a run that names the selection embeds every comment and gives the layout,
  the clustering, every stored family and the naming only the selected ones,
  through the input bundle a shadow run reads;
- a run that names none (the served path: the poller pins include_moderation
  to true and passes no selection) embeds and lays out the same comments, the
  ones it always did, and its pipeline arguments are byte for byte today's.

The embedding model, the layout and the store are recorders; the real run is
the shadow rehearsal's.
"""

import json
import os
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

from polismath import selection
from polismath.job_child import input_bundle
from tests.test_run_delphi_exit_codes import app_dir  # noqa: F401  (fixture)

DELPHI_ROOT = Path(__file__).resolve().parents[1]
UMAP_DIR = str(DELPHI_ROOT / "umap_narrative")
if UMAP_DIR not in sys.path:
    sys.path.insert(0, UMAP_DIR)

GOLDEN = json.loads((DELPHI_ROOT / "tests/fixtures/selection/participant_visible.json").read_text("utf-8"))
ZID = 4242
ALL = sorted(c["tid"] for c in GOLDEN["comments"])


def rows(strict):
    """The golden rows as a bundle written for a selection holds them."""
    conversation = {"zid": ZID, "topic": "Generated fixture", "description": None, "created": 1,
                    "modified": 2, "owner": 17, "strict_moderation": strict}
    comments = sorted((dict(c) for c in GOLDEN["comments"]), key=lambda c: c["tid"])
    return conversation, comments


def expected(strict):
    return next(c for c in GOLDEN["cases"] if c["strict_moderation"] is strict)


# --- the rule, in both languages ---------------------------------------------

@pytest.mark.parametrize("strict", [False, True])
def test_python_keeps_what_the_rust_contract_keeps(strict):
    chosen = selection.select(GOLDEN["selection"], GOLDEN["comments"], strict)
    case = expected(strict)
    assert list(chosen.tids) == case["tids"]
    assert chosen.sha256 == case["sha256"]


def test_the_rule_is_the_list_participants_are_served():
    # participantVisibleClause, server/src/comment.ts: active, velocity above 0,
    # and accepted under strict moderation or not rejected otherwise.
    for strict in (False, True):
        for active in (False, True):
            for velocity in (-1.0, 0.0, 0.25, 1.0):
                for mod in (-1, 0, 1):
                    shown = active and velocity > 0 and (mod == 1 if strict else mod != -1)
                    assert selection.participant_visible(active, velocity, mod, strict) is shown


def test_left_out_by_the_first_reason_that_holds():
    open_ = selection.select(selection.PARTICIPANT_VISIBLE, GOLDEN["comments"], False)
    assert open_.left_out == {"inactive": 2, "muted": 2, "rejected": 1, "unaccepted": 0}
    strict = selection.select(selection.PARTICIPANT_VISIBLE, GOLDEN["comments"], True)
    assert strict.left_out == {"inactive": 2, "muted": 2, "rejected": 1, "unaccepted": 2}


def test_a_moderation_that_keeps_the_same_comments_keeps_the_digest():
    base = [dict(c) for c in GOLDEN["comments"]]
    first = selection.select(selection.PARTICIPANT_VISIBLE, base, False)
    accepted = [dict(c, mod=1) if c["tid"] == 1 else dict(c) for c in base]
    shown = next(c for c in base if c["tid"] == 0)
    added = base + [dict(shown, tid=99, txt="Another rejected", mod=-1)]
    for same in (accepted, added):
        again = selection.select(selection.PARTICIPANT_VISIBLE, same, False)
        assert (again.tids, again.sha256) == (first.tids, first.sha256)
    rejected = [dict(c, mod=-1) if c["tid"] == 0 else dict(c) for c in base]
    assert selection.select(selection.PARTICIPANT_VISIBLE, rejected, False).sha256 != first.sha256


def test_only_a_named_selection_and_only_with_every_velocity():
    with pytest.raises(ValueError):
        selection.select("all/1", GOLDEN["comments"], False)
    missing = [dict(c) for c in GOLDEN["comments"]]
    del missing[0]["velocity"]
    with pytest.raises(ValueError):
        selection.select(selection.PARTICIPANT_VISIBLE, missing, False)
    assert selection.SELECTIONS == ("participant_visible/1", "all_comments/1", "all_but_moderated_out/1")


# --- the pipeline -------------------------------------------------------------

class Store:
    """The run's store, recording what each family is given."""

    def __init__(self, *args, **kwargs):
        self.calls = {}
        Store.last = self

    def embeddings_table_enabled(self):
        return True

    def create_conversation_meta(self, meta):
        self.calls["meta"] = meta

    def put_comment_embeddings_table(self, conversation_id, comment_ids, text_shas, vectors, model):
        self.calls["embeddings"] = [int(t) for t in comment_ids]
        return {"success": len(comment_ids), "failure": 0}

    def batch_create_graph_edges(self, edges):
        self.calls["edges"] = edges
        return {"success": len(edges), "failure": 0}

    def batch_create_comment_clusters(self, clusters):
        self.calls["clusters"] = clusters
        return {"success": len(clusters), "failure": 0}

    def batch_create_cluster_topics(self, topics):
        self.calls["topics"] = topics
        return {"success": len(topics), "failure": 0}


@pytest.fixture
def pipeline(monkeypatch, tmp_path):
    """run_pipeline with a recorded model, layout and store, reading the rows
    through a verified input bundle as a shadow run does."""
    import run_pipeline
    from polismath import embedding_model
    from umap_narrative import numerical_stages

    seen = {"layout": [], "named": [], "selected_path": 0}

    def encode(model, texts, show_progress_bar=False):
        seen["encoded"] = list(texts)
        return np.array([[float(len(t)), float(i), 1.0, 0.5] for i, t in enumerate(texts)], dtype=np.float32)

    def project_and_cluster(vectors):
        n = len(vectors)
        seen["layout"].append(n)
        rng = np.random.default_rng(42)
        return rng.random((n, 2)), [np.arange(n) % 2, np.zeros(n, dtype=int)]

    def layers(conversation_id, conversation_name, document_map, cluster_layers, comment_texts,
               output_dir, **kwargs):
        seen["named"].append(list(comment_texts))
        assert len(document_map) == len(comment_texts)
        assert all(len(layer) == len(comment_texts) for layer in cluster_layers)

    real = run_pipeline.process_selected_comments

    def selected_path(*args, **kwargs):
        seen["selected_path"] += 1
        return real(*args, **kwargs)

    monkeypatch.setattr(embedding_model, "load",
                        lambda: (None, SimpleNamespace(local=True, model="generated-model", arg="fixture")))
    monkeypatch.setattr(embedding_model, "encode", encode)
    monkeypatch.setattr(embedding_model, "resolve", lambda: SimpleNamespace(model="all-MiniLM-L6-v2"))
    monkeypatch.setattr(numerical_stages, "project_and_cluster", project_and_cluster)
    monkeypatch.setattr(run_pipeline, "process_layers_and_create_visualizations", layers)
    monkeypatch.setattr(run_pipeline, "process_selected_comments", selected_path)
    monkeypatch.setattr(run_pipeline, "DynamoDBStorage", Store)
    monkeypatch.setattr(run_pipeline, "PostgresClient", None)  # no stage may read PostgreSQL

    def use(strict):
        conversation, comments = rows(strict)
        bundle = input_bundle.InputBundle(ZID, {}, {"conversation": conversation, "comments": comments,
                                                    "report_comment_selections": []})
        monkeypatch.setattr(input_bundle, "load", lambda zid=None, environ=None: bundle)

    def run(**flags):
        out = tmp_path / "out"
        out.mkdir(exist_ok=True)
        assert run_pipeline._process_conversation(ZID, str(out), True, False, total={}, **flags)
        return Store.last.calls

    return SimpleNamespace(module=run_pipeline, seen=seen, use=use, run=run)


def ids_of(calls):
    """Every comment id each family was given."""
    edges = calls["edges"]
    nodes = {int(e.source_id) for e in edges if e.source_id == e.target_id}
    ends = {int(x) for e in edges for x in (e.source_id, e.target_id)}
    clusters = {int(c.comment_id) for c in calls["clusters"]}
    return nodes, ends, clusters


@pytest.mark.parametrize("strict", [False, True])
def test_a_selection_run_embeds_every_comment_and_lays_out_only_the_selected(pipeline, strict):
    pipeline.use(strict)
    calls = pipeline.run(include_moderation=False, exclude_comment_selections=False,
                         selection=selection.PARTICIPANT_VISIBLE)
    kept = expected(strict)["tids"]
    texts = {c["tid"]: c["txt"] for c in GOLDEN["comments"]}
    # Embedded: every comment (each has text).
    assert calls["embeddings"] == ALL
    assert pipeline.seen["encoded"] == [texts[t] for t in ALL]
    # Laid out, clustered, named and stored: exactly the selection.
    assert pipeline.seen["layout"] == [len(kept)]
    nodes, ends, clusters = ids_of(calls)
    assert nodes == set(kept) and ends <= set(kept)
    assert clusters == set(kept)
    assert calls["meta"].num_comments == len(kept)
    assert pipeline.seen["named"] == [[texts[t] for t in kept]]
    assert pipeline.seen["selected_path"] == 1


def test_the_selection_counts_are_the_runs_facts(pipeline):
    pipeline.use(False)
    facts = {}
    comments, _, kept = pipeline.module._read_selected_inputs(ZID, selection.PARTICIPANT_VISIBLE, facts)
    assert sorted(kept) == expected(False)["tids"] and len(comments) == len(ALL)
    assert facts == {"comments_read": 9, "selection": "participant_visible/1", "strict_moderation": False,
                     "comments_embedded": 9, "comments_selected": 4, "comments_used": 4,
                     "left_out_inactive": 2, "left_out_muted": 2, "left_out_rejected": 1,
                     "left_out_unaccepted": 0}


def test_a_selection_is_the_whole_rule(pipeline):
    pipeline.use(False)
    for flags in ({"include_moderation": True, "exclude_comment_selections": False},
                  {"include_moderation": False, "exclude_comment_selections": True}):
        with pytest.raises(ValueError):
            pipeline.run(selection=selection.PARTICIPANT_VISIBLE, **flags)


def test_a_bundle_not_written_for_a_selection_is_refused(pipeline):
    pipeline.use(False)
    bundle = input_bundle.load()
    del bundle._rows["conversation"]["strict_moderation"]
    with pytest.raises(input_bundle.BundleError):
        pipeline.module.fetch_selection_columns(ZID)


def test_the_served_run_lays_out_what_it_embeds_as_it_always_did(pipeline):
    """The poller's pins: include_moderation true, the report filter on, no
    selection. It embeds and lays out the same comments: every one not
    rejected, inactive and muted ones included."""
    pipeline.use(False)
    calls = pipeline.run(include_moderation=True, exclude_comment_selections=True)
    laid = sorted(c["tid"] for c in GOLDEN["comments"] if c["mod"] > -1)
    assert calls["embeddings"] == laid
    nodes, _, clusters = ids_of(calls)
    assert nodes == clusters == set(laid)
    assert pipeline.seen["layout"] == [len(laid)]
    assert calls["meta"].num_comments == len(laid)
    assert pipeline.seen["selected_path"] == 0


def test_run_pipeline_takes_a_selection_only_alone(monkeypatch):
    import run_pipeline

    seen = {}
    monkeypatch.setattr(run_pipeline, "setup_environment", lambda **kw: None)
    monkeypatch.setattr(run_pipeline, "process_conversation", lambda zid, **kw: seen.update(kw) or True)
    monkeypatch.setattr(sys, "argv", ["run_pipeline.py", "--zid=1", "--include_moderation=False",
                                      "--exclude_comment_selections=False",
                                      "--selection=participant_visible/1"])
    run_pipeline.main()
    assert seen["selection"] == "participant_visible/1"
    monkeypatch.setattr(sys, "argv", ["run_pipeline.py", "--zid=1"])
    run_pipeline.main()
    assert seen["selection"] is None
    for argv in (["--selection=participant_visible/1"],
                 ["--selection=all/1", "--include_moderation=False", "--exclude_comment_selections=False"]):
        monkeypatch.setattr(sys, "argv", ["run_pipeline.py", "--zid=1", *argv])
        with pytest.raises(SystemExit):
            run_pipeline.main()


@pytest.mark.parametrize("flags, selected", [
    (["--include_moderation=True", "--exclude_comment_selections=True"], None),
    (["--include_moderation=False", "--exclude_comment_selections=False", "--selection=participant_visible/1"],
     "participant_visible/1"),
])
def test_run_delphi_passes_a_selection_only_when_named(app_dir, monkeypatch, flags, selected):
    argv_log = Path(os.environ["STAGE_LOG"]).with_name("argv.log")
    monkeypatch.setenv("ARGV_LOG", str(argv_log))
    stub = app_dir / "umap_narrative/run_pipeline.py"
    stub.write_text(
        "import json, os, sys\n"
        "open(os.environ['ARGV_LOG'], 'a').write(json.dumps(sys.argv[1:]) + '\\n')\n"
    )
    result = subprocess.run([sys.executable, str(app_dir / "run_delphi.py"), "--zid=1", *flags],
                            cwd=app_dir, capture_output=True, text=True, timeout=120)
    assert result.returncode == 0, result.stdout + result.stderr
    (argv,) = [json.loads(line) for line in argv_log.read_text().splitlines()]
    if selected is None:
        # The served path's arguments, byte for byte.
        assert argv == ["--zid=1", "--include_moderation=True", "--exclude_comment_selections=True",
                        "--name-topics"]
    else:
        assert argv == ["--zid=1", "--include_moderation=False", "--exclude_comment_selections=False",
                        "--name-topics", f"--selection={selected}"]
