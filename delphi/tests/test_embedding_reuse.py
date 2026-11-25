"""A full-pipeline run embeds only the comments whose vector is not already stored.

The job daemon hands the child its conversation's stored vectors
(``inputs/embeddings.spool``, named by ``frame.inputs.embeddings``,
``delphi-embedding-reuse/1``). These tests drive ``run_pipeline._embed`` and
``_embeddings_to_store`` with a fake model and a frame written here; the three
runs in a row use a small model of the embeddings table's own rules (one row per
comment id, a put keeps an existing row for the same text and refuses another
text, a set closes only when a run hands over rows).
"""

import hashlib
import importlib
import json
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

from polismath import embedding_model as em
from polismath import step_log
from polismath.delphi_storage.embedding_spool import write_spool
from polismath.job_child import embedding_reuse

ZID = 4242
DIMS = 4


@pytest.fixture(scope="module")
def stages():
    narrative_dir = Path(__file__).resolve().parents[1] / "umap_narrative"
    with pytest.MonkeyPatch.context() as patch:
        patch.syspath_prepend(str(narrative_dir))
        patch.setenv("MPLBACKEND", "Agg")
        yield SimpleNamespace(pipeline=importlib.import_module("umap_narrative.run_pipeline"))


def sha(text):
    return hashlib.sha256(text.encode("utf-8")).digest()


def vector_of(text):
    """The fake model's vector: a function of the text only."""
    return [float(len(text)), float(sum(map(ord, text)) % 97), 0.5, -1.0]


class Model:
    """Counts loads and encodes; a load can be forbidden."""

    def __init__(self, monkeypatch, stores_as):
        self.loads = 0
        self.encoded = []
        self.forbid_load = False
        resolved = em.Resolved("/models/fake", True, None, None, stores_as)

        def load(*args, **kwargs):
            if self.forbid_load:
                raise AssertionError("the model was loaded")
            self.loads += 1
            return object(), resolved

        def encode(model, texts, **kwargs):
            self.encoded.append(list(texts))
            return np.array([vector_of(t) for t in texts], dtype=np.float32).reshape(len(texts), DIMS)

        monkeypatch.setattr(em, "DIMS", DIMS)
        monkeypatch.setattr(em, "load", load)
        monkeypatch.setattr(em, "encode", encode)
        monkeypatch.setattr(em, "resolve", lambda: resolved)


@pytest.fixture
def model_name(stages):
    return stages.pipeline.DynamoDBStorage._GRANITE_EMBEDDING_MODEL


@pytest.fixture
def model(monkeypatch, model_name):
    return Model(monkeypatch, model_name)


@pytest.fixture
def recorded(monkeypatch):
    monkeypatch.setattr(step_log, "_record", [])
    monkeypatch.delenv("DELPHI_STEP_LOG", raising=False)
    embedding_reuse._offered.clear()
    yield lambda: {e["step"]: {k: v for k, v in e.items() if k != "seconds"} for e in step_log.recorded()}
    embedding_reuse._offered.clear()


def write_frame(tmp_path, monkeypatch, rows, model, *, ref=None, spool=None, frame_extra=None):
    """A frame offering ``rows`` ((tid, text_sha, vector), tid order) under ``model``."""
    attempt = tmp_path / "attempt"
    (attempt / "inputs").mkdir(parents=True, exist_ok=True)
    data = spool if spool is not None else (write_spool(model, DIMS, rows) if rows else None)
    path = attempt / "inputs" / "embeddings.spool"
    if path.exists():
        path.unlink()
    if data is not None:
        path.write_bytes(data)
        value = {"schema": "delphi-embedding-reuse/1", "file": "inputs/embeddings.spool",
                 "sha256": hashlib.sha256(data).hexdigest(), "rows": len(rows), "model": model,
                 "model_id": 2, "dims": DIMS, "env": "shadow-test", "zid": ZID, "reason": None}
    else:
        value = {"schema": "delphi-embedding-reuse/1", "file": None, "sha256": None, "rows": None,
                 "model": model, "model_id": None, "dims": None, "env": "shadow-test", "zid": ZID,
                 "reason": "empty"}
    value.update(ref or {})
    frame = {"schema": "polis-jobs.frame/1", "env": "shadow-test", "zid": ZID,
             "inputs": {"math_env": None, "requested_math_tick": None, "embeddings": value}}
    frame.update(frame_extra or {})
    (attempt / "frame.json").write_text(json.dumps(frame))
    monkeypatch.setenv("DELPHI_FRAME", str(attempt / "frame.json"))
    embedding_reuse._offered.clear()


def stored(texts_by_tid):
    return [(tid, sha(text), vector_of(text)) for tid, text in sorted(texts_by_tid.items())]


TEXTS = ["first comment", "second comment", "third, longer comment", "fourth"]
IDS = [3, 7, 11, 20]


def test_every_comment_stored_means_the_model_is_never_loaded(stages, model, model_name, recorded,
                                                                tmp_path, monkeypatch):
    write_frame(tmp_path, monkeypatch, stored(dict(zip(IDS, TEXTS))), model_name)
    model.forbid_load = True
    vectors = stages.pipeline._embed(TEXTS, IDS)
    assert model.loads == 0 and model.encoded == []
    assert vectors.dtype == np.float32 and vectors.shape == (4, DIMS)
    assert np.array_equal(vectors, np.array([vector_of(t) for t in TEXTS], dtype=np.float32))
    steps = recorded()
    assert steps["embed_load"]["model_source"] == "none" and steps["embed_load"]["model"] == model_name
    assert (steps["embed_encode"]["embeddings_reused"], steps["embed_encode"]["embeddings_encoded"]) == (4, 0)
    assert "embeddings_reuse" not in steps["embed_encode"]


def test_a_mix_encodes_exactly_the_missing_texts_once_in_order(stages, model, model_name, recorded,
                                                                tmp_path, monkeypatch):
    # Stored: 3 and 11, plus a comment this run does not have (ignored).
    write_frame(tmp_path, monkeypatch, stored({3: TEXTS[0], 11: TEXTS[2], 99: "gone"}), model_name)
    vectors = stages.pipeline._embed(TEXTS, IDS)
    assert model.loads == 1 and model.encoded == [[TEXTS[1], TEXTS[3]]]
    assert np.array_equal(vectors, np.array([vector_of(t) for t in TEXTS], dtype=np.float32))
    assert vectors.dtype == np.float32
    facts = recorded()["embed_encode"]
    assert (facts["embeddings_reused"], facts["embeddings_encoded"], facts["n_comments"], facts["dims"]) == (2, 2, 4, DIMS)


def test_a_comment_stored_under_another_text_is_encoded_and_kept_for_conflict_check(stages, model, model_name, recorded,
                                                                              tmp_path, monkeypatch):
    write_frame(tmp_path, monkeypatch, stored({3: TEXTS[0], 7: "the text it had", 11: TEXTS[2], 20: TEXTS[3]}),
                model_name)
    vectors = stages.pipeline._embed(TEXTS, IDS)
    assert model.encoded == [[TEXTS[1]]]
    assert np.array_equal(vectors[1], np.array(vector_of(TEXTS[1]), dtype=np.float32))
    facts = recorded()["embed_encode"]
    assert (facts["embeddings_reused"], facts["embeddings_encoded"], facts["embeddings_text_changed"]) == (3, 1, 1)
    texts, ids, kept = stages.pipeline._embeddings_to_store(TEXTS, IDS, vectors)
    assert ids is IDS and texts is TEXTS
    assert kept is vectors


def test_another_model_encodes_everything(stages, model, recorded, tmp_path, monkeypatch):
    write_frame(tmp_path, monkeypatch, stored(dict(zip(IDS, TEXTS))), "sentence-transformers/all-MiniLM-L6-v2")
    stages.pipeline._embed(TEXTS, IDS)
    assert model.loads == 1 and model.encoded == [TEXTS]
    facts = recorded()["embed_encode"]
    assert (facts["embeddings_reused"], facts["embeddings_encoded"], facts["embeddings_reuse"]) == (0, 4, "model")


MINILM = "sentence-transformers/all-MiniLM-L6-v2"


def test_the_shipped_model_name_pins_its_computation_and_a_bare_name_does_not(model_name):
    assert embedding_reuse.pinned(model_name)
    for name in (MINILM, "all-MiniLM-L6-v2", "org/model", "org/model:384", "org/model@main:384",
                 "org/model@" + "0" * 39 + ":384", "org/model@" + "A" * 40 + ":384", "org/model@" + "0" * 40,
                 "org/model@" + "0" * 40 + ":0384", "@" + "0" * 40 + ":384", "a@b@" + "0" * 40 + ":384",
                 "", None, 384):
        assert not embedding_reuse.pinned(name), name


def test_an_unpinned_model_is_never_reused_even_when_offered(stages, monkeypatch, recorded, tmp_path):
    """The run stores under all-MiniLM-L6-v2 and the file is for exactly that name,
    well formed: the vectors are still encoded, not reused."""
    model = Model(monkeypatch, MINILM)
    write_frame(tmp_path, monkeypatch, stored(dict(zip(IDS, TEXTS))), MINILM)
    stages.pipeline._embed(TEXTS, IDS)
    assert model.loads == 1 and model.encoded == [TEXTS]
    facts = recorded()["embed_encode"]
    assert (facts["embeddings_reused"], facts["embeddings_encoded"], facts["embeddings_reuse"]) == (0, 4, "unpinned")


def test_a_file_over_the_bound_is_not_read(stages, model, model_name, recorded, tmp_path, monkeypatch):
    monkeypatch.setattr(embedding_reuse, "MAX_FILE_BYTES", 64)
    write_frame(tmp_path, monkeypatch, stored(dict(zip(IDS, TEXTS))), model_name)
    stages.pipeline._embed(TEXTS, IDS)
    assert model.encoded == [TEXTS]
    assert recorded()["embed_encode"]["embeddings_reuse"] == "file"


def _bad(case, rows, model_name):
    """(ref overrides, spool bytes or None, reason) for one bad offer."""
    good = write_spool(model_name, DIMS, rows)
    if case == "sha256":
        return {"sha256": "0" * 64}, None, "file"
    if case == "truncated":
        cut = good[:-3]
        return {"sha256": hashlib.sha256(cut).hexdigest()}, cut, "file"
    if case == "rows":
        return {"rows": len(rows) + 1}, None, "file"
    if case == "frame_dims":
        return {"dims": DIMS + 1}, None, "dims"
    if case == "spool_dims":
        narrow = write_spool(model_name, DIMS - 1, [(t, s, v[:-1]) for t, s, v in rows])
        return {"sha256": hashlib.sha256(narrow).hexdigest()}, narrow, "dims"
    if case == "spool_model":
        other = write_spool("sentence-transformers/all-MiniLM-L6-v2", DIMS, rows)
        return {"sha256": hashlib.sha256(other).hexdigest()}, other, "model"
    if case == "not_finite":
        bad = write_spool(model_name, DIMS, [(t, s, [float("nan")] + v[1:]) for t, s, v in rows])
        return {"sha256": hashlib.sha256(bad).hexdigest()}, bad, "vector"
    if case == "file_key":
        return {"file": "../elsewhere.spool"}, None, "frame"
    if case == "schema":
        return {"schema": "delphi-embedding-reuse/2"}, None, "frame"
    if case == "zid":
        return {"zid": ZID + 1}, None, "frame"
    if case == "env":
        return {"env": "shadow-other"}, None, "frame"
    raise AssertionError(case)


@pytest.mark.parametrize("case", ["sha256", "truncated", "rows", "frame_dims", "spool_dims", "spool_model",
                                  "not_finite", "file_key", "schema", "zid", "env"])
def test_each_bad_offer_encodes_everything_and_the_run_goes_on(stages, model, model_name, recorded,
                                                               tmp_path, monkeypatch, case):
    rows = stored(dict(zip(IDS, TEXTS)))
    ref, spool, reason = _bad(case, rows, model_name)
    write_frame(tmp_path, monkeypatch, rows, model_name, ref=ref, spool=spool)
    vectors = stages.pipeline._embed(TEXTS, IDS)
    assert model.encoded == [TEXTS] and vectors.shape == (4, DIMS)
    facts = recorded()["embed_encode"]
    assert (facts["embeddings_reused"], facts["embeddings_encoded"], facts["embeddings_reuse"]) == (0, 4, reason)
    texts, ids, kept = stages.pipeline._embeddings_to_store(TEXTS, IDS, vectors)
    assert (texts, ids, kept) == (TEXTS, IDS, vectors)


def test_a_missing_file_and_a_reason_word_encode_everything(stages, model, model_name, recorded,
                                                            tmp_path, monkeypatch):
    write_frame(tmp_path, monkeypatch, stored(dict(zip(IDS, TEXTS))), model_name)
    (tmp_path / "attempt" / "inputs" / "embeddings.spool").unlink()
    embedding_reuse._offered.clear()
    stages.pipeline._embed(TEXTS, IDS)
    assert recorded()["embed_encode"]["embeddings_reuse"] == "file"
    write_frame(tmp_path, monkeypatch, [], model_name)  # the daemon said: empty
    stages.pipeline._embed(TEXTS, IDS)
    assert model.encoded == [TEXTS, TEXTS]
    assert recorded()["embed_encode"]["embeddings_reuse"] == "empty"


class Table:
    """The embeddings table's rules, as migration 000038 and the daemon apply them."""

    def __init__(self):
        self.rows = {}       # tid -> (text_sha, vector, batch)
        self.closed = set()  # batches whose set is closed

    def store(self, batch, ids, texts, vectors):
        for tid, text, vector in zip(ids, texts, vectors):
            prior = self.rows.get(int(tid))
            if prior is not None and prior[0] != sha(text):
                raise ValueError("embedding text conflict")
            if prior is None:  # ON CONFLICT DO NOTHING
                self.rows[int(tid)] = (sha(text), [float(v) for v in np.asarray(vector, dtype=np.float32)], batch)
        if ids:  # the daemon routes, and closes, only a non-empty spool
            self.closed.add(batch)

    def offered(self):
        """What the daemon reads for the next run: rows whose own attempt closed its set."""
        return [(tid, s, v) for tid, (s, v, b) in sorted(self.rows.items()) if b in self.closed]


def test_three_runs_in_a_row_store_once_and_reuse_everything(stages, model, model_name, recorded,
                                                             tmp_path, monkeypatch):
    table = Table()
    comments = dict(zip(IDS[:3], TEXTS[:3]))

    def run(batch):
        write_frame(tmp_path, monkeypatch, table.offered(), model_name)
        ids, texts = list(comments), list(comments.values())
        vectors = stages.pipeline._embed(texts, ids)
        assert np.array_equal(vectors, np.array([vector_of(t) for t in texts], dtype=np.float32))
        t, i, v = stages.pipeline._embeddings_to_store(texts, ids, vectors)
        table.store(batch, i, t, v)
        facts = recorded()["embed_encode"]
        return facts["embeddings_reused"], facts["embeddings_encoded"], facts.get("embeddings_reuse")

    assert run("attempt-1") == (0, 3, "empty")          # all new
    comments[IDS[3]] = TEXTS[3]
    assert run("attempt-2") == (3, 1, None)             # one comment added
    assert model.encoded == [TEXTS[:3], [TEXTS[3]]]
    model.forbid_load = True
    assert run("attempt-3") == (4, 0, None)             # nothing added: no model
    # The next run's file holds every comment's newest vector, each stored once.
    assert [(tid, s) for tid, s, _ in table.offered()] == [(tid, sha(t)) for tid, t in zip(IDS, TEXTS)]
    assert {b for _, _, b in table.rows.values()} == {"attempt-1", "attempt-2"}
    assert table.closed == {"attempt-1", "attempt-2", "attempt-3"}


@pytest.mark.parametrize("frame", ["unset", "no_key"])
def test_with_no_offer_the_run_is_what_it_was(stages, model, model_name, recorded, tmp_path, monkeypatch, frame):
    if frame == "unset":
        monkeypatch.delenv("DELPHI_FRAME", raising=False)
    else:
        (tmp_path / "frame.json").write_text(json.dumps(
            {"schema": "polis-jobs.frame/1", "zid": ZID, "inputs": {"math_env": None, "requested_math_tick": None}}))
        monkeypatch.setenv("DELPHI_FRAME", str(tmp_path / "frame.json"))
    vectors = stages.pipeline._embed(TEXTS, IDS)
    assert model.loads == 1 and model.encoded == [TEXTS]
    steps = recorded()
    assert steps["embed_load"] == {"model_source": "image", "model": model_name, "step": "embed_load",
                                   "status": "ok"}
    assert steps["embed_encode"] == {"n_comments": 4, "dims": DIMS, "step": "embed_encode", "status": "ok"}
    stored_triple = stages.pipeline._embeddings_to_store(TEXTS, IDS, vectors)
    assert stored_triple[0] is TEXTS and stored_triple[1] is IDS and stored_triple[2] is vectors
