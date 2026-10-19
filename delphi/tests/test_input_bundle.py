"""delphi-input-bundle/1 on the Python side.

The golden bundle (tests/fixtures/input_bundle/basic) is written by the Rust
contract test and reproduced byte for byte by the polis-jobs writer's unit
test. Here: it reads back as the rows the stages' own Postgres queries return;
every read site of the full pipeline gives the same result from the bundle as
from Postgres, without touching Postgres; the run's inputs block is
byte-equal between the two modes; and every check refuses what it names.
"""

import hashlib
import importlib
import json
import shutil
from pathlib import Path
from types import SimpleNamespace

import pytest

from polismath import job_child
from polismath.job_child import census, input_bundle

GOLDEN = Path(__file__).resolve().parent / "fixtures" / "input_bundle" / "basic"
ZID = 4242


def golden(name):
    return json.loads((GOLDEN / name).read_text("utf-8"))


def sha(data):
    return hashlib.sha256(data).hexdigest()


class GoldenPostgres:
    """The stages' PostgresClient over the golden rows, as Postgres returns them:
    the conversation row with more columns than the stages read (SELECT *)."""

    def __init__(self, *args, **kwargs):
        pass

    def initialize(self):
        pass

    def shutdown(self):
        pass

    def get_conversation_by_id(self, zid):
        assert int(zid) == ZID
        return {**golden("conversation.json"), "is_active": True, "link_url": None, "strict_moderation": False}

    def get_comments_by_conversation(self, zid):
        assert int(zid) == ZID
        return golden("comments.json")

    def get_report_comment_selections(self, zid, rid=None):
        assert int(zid) == ZID and rid is None
        return golden("report_comment_selections.json")


class NoPostgres:
    def __init__(self, *args, **kwargs):
        raise AssertionError("a stage given an input bundle connected to Postgres")


def census_query(sql, params):
    """census.observe_inputs's three queries, answered from the golden rows."""
    assert params["zid"] == ZID
    inputs = golden("manifest.json")["inputs"]
    if "FROM comments" in sql:
        return [{k: c[k] for k in ("tid", "txt", "mod", "active")} for c in golden("comments.json")]
    if "FROM votes" in sql:
        return [{"hwm": inputs["vote_hwm"]}]
    assert params["math_env"] == inputs["math_env"]
    return [{"math_tick": inputs["math_tick"], "caching_tick": inputs["math_caching_tick"]}]


@pytest.fixture
def attempt(tmp_path, monkeypatch):
    """An attempt directory holding the golden bundle under inputs/ and a frame
    naming it, as polis-jobs writes them; ``frame(**changes)`` rewrites the frame."""
    shutil.copytree(GOLDEN, tmp_path / "inputs")

    def frame(**changes):
        ref = {"manifest": "inputs/manifest.json", "schema": "delphi-input-bundle/1",
               "sha256": sha((tmp_path / "inputs" / "manifest.json").read_bytes())}
        ref.update(changes)
        doc = {"schema": "polis-jobs.frame/1", "zid": ZID,
               "inputs": {"math_env": None, "requested_math_tick": None, "bundle": ref}}
        (tmp_path / "frame.json").write_text(json.dumps(doc))
        monkeypatch.setenv("DELPHI_FRAME", str(tmp_path / "frame.json"))
        input_bundle._loaded.clear()

    frame()
    yield SimpleNamespace(dir=tmp_path, frame=frame)
    input_bundle._loaded.clear()


@pytest.fixture
def no_frame(monkeypatch):
    monkeypatch.delenv("DELPHI_FRAME", raising=False)
    input_bundle._loaded.clear()
    yield
    input_bundle._loaded.clear()


@pytest.fixture(scope="module")
def stages():
    """run_pipeline.py and 700_datamapplot_for_layer.py, imported the way the
    other stage tests import the numbered scripts."""
    narrative_dir = Path(__file__).resolve().parents[1] / "umap_narrative"
    with pytest.MonkeyPatch.context() as patch:
        patch.syspath_prepend(str(narrative_dir))
        patch.setenv("MPLBACKEND", "Agg")
        yield SimpleNamespace(
            pipeline=importlib.import_module("umap_narrative.run_pipeline"),
            datamap=importlib.import_module("umap_narrative.700_datamapplot_for_layer"),
        )


def test_without_a_bundle_in_the_frame_nothing_is_read(no_frame, tmp_path, monkeypatch):
    assert input_bundle.load(ZID) is None
    (tmp_path / "frame.json").write_text(json.dumps({"schema": "polis-jobs.frame/1", "zid": ZID,
                                                     "inputs": {"math_env": None, "requested_math_tick": None}}))
    monkeypatch.setenv("DELPHI_FRAME", str(tmp_path / "frame.json"))
    assert input_bundle.load(ZID) is None


def test_the_golden_bundle_reads_back_as_the_postgres_rows(attempt):
    bundle = input_bundle.load(ZID)
    assert bundle.conversation() == golden("conversation.json")
    assert bundle.comments() == GoldenPostgres().get_comments_by_conversation(ZID)
    assert bundle.report_comment_selections() == GoldenPostgres().get_report_comment_selections(ZID)
    # The keys and types the stages' own query returns, ordered by tid.
    assert [c["tid"] for c in bundle.comments()] == sorted(c["tid"] for c in bundle.comments())
    assert all(set(c) == {"tid", "zid", "pid", "txt", "created", "mod", "active"} for c in bundle.comments())


def test_the_inputs_block_is_byte_equal_in_both_modes(attempt):
    from_postgres = census.observe_inputs(ZID, "prod", census_query)
    from_bundle = census.observe_inputs_from_bundle(input_bundle.load(ZID), "prod")
    assert job_child.canonical_bytes(from_bundle) == job_child.canonical_bytes(from_postgres)
    # The digest polis-jobs computed in Rust is the census's own.
    assert golden("manifest.json")["inputs"]["comment_set_sha256"] == census.comment_set_sha256(golden("comments.json"))


def test_the_census_digest_known_answers():
    """The same values the Rust contract test pins (the_comment_set_digest_is_the_census_digest)."""
    rows = [{"tid": 2, "txt": "b", "mod": -1, "active": False}, {"tid": 1, "txt": "a", "mod": 0, "active": True}]
    assert census.comment_set_sha256(rows) == "99403c230e9bf8ec2bbc8ef2ca09eac5e28e768b33c76e5645807baa447d4bb5"
    assert census.comment_set_sha256([]) == sha(b"polis-jobs.comment-set/1\n")


def test_fetch_conversation_data_is_equal_in_both_modes(stages, no_frame, attempt, monkeypatch):
    monkeypatch.delenv("DELPHI_FRAME")
    input_bundle._loaded.clear()
    monkeypatch.setattr(stages.pipeline, "PostgresClient", GoldenPostgres)
    from_postgres = stages.pipeline.fetch_conversation_data(ZID)
    attempt.frame()
    monkeypatch.setattr(stages.pipeline, "PostgresClient", NoPostgres)
    from_bundle = stages.pipeline.fetch_conversation_data(ZID)
    assert from_postgres[0] is not None
    assert from_bundle == from_postgres


def test_load_comment_texts_is_equal_in_both_modes(stages, no_frame, attempt, monkeypatch):
    monkeypatch.delenv("DELPHI_FRAME")
    input_bundle._loaded.clear()
    monkeypatch.setattr(stages.datamap, "PostgresClient", GoldenPostgres)
    from_postgres = stages.datamap.load_comment_texts(ZID)
    attempt.frame()
    monkeypatch.setattr(stages.datamap, "PostgresClient", NoPostgres)
    from_bundle = stages.datamap.load_comment_texts(ZID)
    assert from_postgres
    assert from_bundle == from_postgres


def test_the_excluded_comments_are_equal_in_both_modes(attempt):
    excluded = lambda rows: {s["tid"] for s in rows if s.get("selection") == -1}  # noqa: E731
    from_bundle = excluded(input_bundle.load(ZID).report_comment_selections())
    assert from_bundle == excluded(GoldenPostgres().get_report_comment_selections(ZID))
    assert from_bundle


def _rewrite(path, edit):
    value = json.loads(path.read_text("utf-8"))
    edit(value)
    path.write_text(json.dumps(value, separators=(",", ":"), ensure_ascii=False) + "\n")


@pytest.mark.parametrize("name,damage", [
    ("frame digest", lambda a: a.frame(sha256="0" * 64)),
    ("frame schema", lambda a: a.frame(schema="delphi-input-bundle/2")),
    ("frame path", lambda a: a.frame(manifest="../inputs/manifest.json")),
    ("frame extra key", lambda a: a.frame(rows=3)),
    ("comments bytes", lambda a: (a.dir / "inputs" / "comments.json").write_text("[]\n")),
    ("missing file", lambda a: (a.dir / "inputs" / "report_comment_selections.json").unlink()),
    ("manifest zid", lambda a: (_rewrite(a.dir / "inputs" / "manifest.json", lambda m: m.update(zid=7)), a.frame())),
    ("manifest roles", lambda a: (_rewrite(a.dir / "inputs" / "manifest.json",
                                           lambda m: m["files"].reverse()), a.frame())),
    ("manifest inputs", lambda a: (_rewrite(a.dir / "inputs" / "manifest.json",
                                            lambda m: m["inputs"].update(vote_count=3)), a.frame())),
])
def test_a_damaged_bundle_is_refused(attempt, name, damage):
    damage(attempt)
    input_bundle._loaded.clear()
    with pytest.raises(input_bundle.BundleError):
        input_bundle.load(ZID)


def test_a_bundle_for_another_conversation_or_math_env_or_digest_is_refused(attempt):
    with pytest.raises(input_bundle.BundleError):
        input_bundle.load(ZID + 1)
    with pytest.raises(census.CensusError):
        census.observe_inputs_from_bundle(input_bundle.load(ZID), "python")
    _rewrite(attempt.dir / "inputs" / "manifest.json",
             lambda m: m["inputs"].update(comment_set_sha256="0" * 64))
    attempt.frame()
    with pytest.raises(census.CensusError):
        census.observe_inputs_from_bundle(input_bundle.load(ZID), "prod")
