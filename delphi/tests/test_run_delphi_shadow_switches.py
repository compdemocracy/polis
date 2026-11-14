"""The two run_delphi.py switches a shadow run sets, and their defaults.

DELPHI_SKIP_DATAMAPPLOT=1 leaves out the per-layer datamapplot step (the step
that uploads a page holding comment text to the S3 bucket) and the UMAP
stage's local layer pages; DELPHI_LOCAL_OUTPUT_CLEANUP=1 removes what a run
wrote under polis_data/<zid> and visualizations/<zid> when it ends. Unset,
empty, "0" or any other value is off, and a run is what it was: the stage
order and the files are the ones test_run_delphi_exit_codes.py pins.

The fixture is the one test_run_delphi_exit_codes.py uses: an app directory
whose stage scripts are stubs. The UMAP stub also writes a file where the real
stage writes its outputs, so the cleanup has something to remove.
"""

import os
import sys
from pathlib import Path

import pytest

from tests.test_run_delphi_exit_codes import (  # noqa: F401 - the fixture
    ALL_STAGES,
    app_dir,
    ran_stages,
    run_delphi,
)

DELPHI_ROOT = Path(__file__).resolve().parents[1]

UMAP_STUB_WITH_OUTPUT = '''import os, sys
with open(os.environ["STAGE_LOG"], "a") as f:
    f.write("umap\\n")
out = os.path.join("polis_data", "1", "python_output", "comments_enhanced_multilayer")
os.makedirs(out, exist_ok=True)
open(os.path.join(out, "1_metadata.json"), "w").write("{}")
os.makedirs(os.path.join("visualizations", "1"), exist_ok=True)
open(os.path.join("visualizations", "1", "page.html"), "w").write("<html></html>")
sys.exit(int(os.environ.get("STUB_EXIT_UMAP", "0")))
'''


@pytest.fixture
def writing_app(app_dir, monkeypatch):  # noqa: F811 - pytest fixture chaining
    (app_dir / "umap_narrative" / "run_pipeline.py").write_text(UMAP_STUB_WITH_OUTPUT)
    # Another conversation's files, which no switch may touch.
    other = app_dir / "polis_data" / "2"
    other.mkdir(parents=True)
    (other / "keep.json").write_text("{}")
    for name in ("DELPHI_SKIP_DATAMAPPLOT", "DELPHI_LOCAL_OUTPUT_CLEANUP"):
        monkeypatch.delenv(name, raising=False)
    return app_dir


@pytest.mark.parametrize("value", [None, "", "0", "true", "yes", " 2"])
def test_off_runs_every_stage_and_keeps_the_files(writing_app, monkeypatch, value):
    for name in ("DELPHI_SKIP_DATAMAPPLOT", "DELPHI_LOCAL_OUTPUT_CLEANUP"):
        if value is None:
            monkeypatch.delenv(name, raising=False)
        else:
            monkeypatch.setenv(name, value)
    result = run_delphi(writing_app)
    assert result.returncode == 0, result.stdout + result.stderr
    assert ran_stages(writing_app) == ALL_STAGES
    assert "Skipping the datamapplot" not in result.stdout
    assert (writing_app / "polis_data" / "1" / "python_output").is_dir()
    assert (writing_app / "visualizations" / "1" / "page.html").is_file()


def test_skip_leaves_out_the_datamapplot_step_and_nothing_else(writing_app, monkeypatch):
    monkeypatch.setenv("DELPHI_SKIP_DATAMAPPLOT", "1")
    result = run_delphi(writing_app)
    assert result.returncode == 0, result.stdout + result.stderr
    assert ran_stages(writing_app) == ["reset", "umap"]
    assert "Skipping the datamapplot visualizations (DELPHI_SKIP_DATAMAPPLOT=1)" in result.stdout
    assert "Pipeline completed successfully!" in result.stdout


def test_skip_does_not_hide_a_failed_umap_stage(writing_app, monkeypatch):
    monkeypatch.setenv("DELPHI_SKIP_DATAMAPPLOT", "1")
    monkeypatch.setenv("STUB_EXIT_UMAP", "1")
    result = run_delphi(writing_app)
    assert result.returncode != 0
    assert ran_stages(writing_app) == ["reset", "umap"]
    assert "UMAP narrative pipeline (exit code 1)" in result.stdout


@pytest.mark.parametrize("umap_exit", ["0", "1"])
def test_cleanup_removes_this_conversations_files_only(writing_app, monkeypatch, umap_exit):
    monkeypatch.setenv("DELPHI_LOCAL_OUTPUT_CLEANUP", "1")
    monkeypatch.setenv("STUB_EXIT_UMAP", umap_exit)
    result = run_delphi(writing_app)
    assert (result.returncode == 0) == (umap_exit == "0"), result.stdout + result.stderr
    assert not (writing_app / "polis_data" / "1").exists()
    assert not (writing_app / "visualizations" / "1").exists()
    assert (writing_app / "polis_data" / "2" / "keep.json").is_file()


def test_the_cleanup_paths_are_built_from_an_integer_conversation_id(tmp_path, monkeypatch):
    sys.path.insert(0, str(DELPHI_ROOT))
    import run_delphi as module

    monkeypatch.chdir(tmp_path)
    paths = module.local_output_dirs("17", str(tmp_path))
    assert paths == [str(tmp_path.resolve() / "polis_data" / "17"),
                     str(tmp_path.resolve() / "visualizations" / "17")]
    for bad in ("../1", "1/..", "", "x"):
        with pytest.raises(ValueError):
            module.local_output_dirs(bad, str(tmp_path))


def test_run_pipeline_writes_no_layer_page_when_skipped(monkeypatch, tmp_path):
    umap_dir = str(DELPHI_ROOT / "umap_narrative")
    if umap_dir not in sys.path:
        sys.path.insert(0, umap_dir)
    import numpy as np
    import run_pipeline

    calls = []
    monkeypatch.setattr(run_pipeline, "create_visualizations", lambda *a, **kw: calls.append(1) or "index.html")
    monkeypatch.setattr(run_pipeline, "process_layers_and_store_characteristics",
                        lambda *a, **kw: {0: {"characteristics": {}, "numeric_topic_names": {}}})
    layers = [np.array([0, 0, 1, 1, -1])]
    texts = ["a b", "a c", "d e", "d f", "g"]
    for value, expected in ((None, 1), ("1", 0)):
        calls.clear()
        if value is None:
            monkeypatch.delenv("DELPHI_SKIP_DATAMAPPLOT", raising=False)
        else:
            monkeypatch.setenv("DELPHI_SKIP_DATAMAPPLOT", value)
        index = run_pipeline.process_layers_and_create_visualizations(
            "1", "c", np.zeros((5, 2)), layers, texts, str(tmp_path), name_topics=False)
        assert len(calls) == expected
        assert index == ("index.html" if expected else None)
