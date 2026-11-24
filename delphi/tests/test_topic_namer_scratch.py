"""Scratch-file failures do not turn a naming failure into a run failure, and
no naming scratch outlives its run."""
import pytest
from tests.test_topic_namer import HAIKU, delphi_app, pipeline, small_hierarchy, stub, stub_argv, topic_namer


@pytest.mark.parametrize("blocked", ["work", "hierarchy.json", "names.json"])
def test_scratch_failure_keeps_keywords(stub, blocked):
    work = stub / "work"
    if blocked == "work":
        work.write_text("occupied")
    else:
        work.mkdir()
        (work / blocked).mkdir()
    result = topic_namer.run_namer(HAIKU, small_hierarchy(), str(work))
    assert result["outcome"] == "namer_failed"
    assert result["names"] == {}
    assert stub_argv(stub) == []


def test_scratch_that_cannot_be_removed_keeps_keywords_and_the_tokens(stub, monkeypatch):
    def refuse(work_dir):
        raise PermissionError("removal refused for this test")

    monkeypatch.setattr(topic_namer, "remove_scratch", refuse)
    result = topic_namer.run_namer(HAIKU, small_hierarchy(), str(stub / "work"))
    assert result["outcome"] == "namer_failed" and result["names"] == {}
    assert result["reason"] == "scratch_unavailable (PermissionError)"
    # The call was made: its token counts stay in the record.
    assert result["tokens_in"] == 25445


def test_a_temporary_directory_that_cannot_be_made_keeps_keywords(pipeline, stub, monkeypatch, tmp_path):
    from tests.test_topic_namer import CHARACTERISTICS, Names, run_naming
    from umap_narrative.topic_naming import _conventional_labels

    def refuse(*args, **kwargs):
        raise OSError("no temporary directory for this test")

    monkeypatch.setattr(pipeline.tempfile, "TemporaryDirectory", refuse)
    storage = Names()
    labels, _, naming = run_naming(pipeline, monkeypatch, tmp_path, HAIKU, storage, namer_dir=None)
    assert naming["outcome"] == "namer_failed" and naming["reason"] == "scratch_unavailable (OSError)"
    assert labels[0] == {str(k): v for k, v in _conventional_labels(CHARACTERISTICS[0]).items()}
    assert {row.model_name for row in storage.rows} == {"keywords"}
    assert stub_argv(stub) == []


def test_under_the_daemon_the_scratch_is_inside_the_attempt_directory(monkeypatch, tmp_path):
    import os
    import tempfile
    import run_delphi

    attempt = tmp_path / "attempt"
    monkeypatch.setenv("DELPHI_OUTPUT_MANIFEST", str(attempt / "output-manifest.json"))
    inside = run_delphi.namer_scratch_path()
    # The daemon removes the attempt directory after reaping the child group,
    # so even a SIGKILL leaves no naming scratch behind.
    assert os.path.dirname(inside) == str(attempt) and not os.path.exists(inside)
    monkeypatch.delenv("DELPHI_OUTPUT_MANIFEST")
    alone = run_delphi.namer_scratch_path()
    assert os.path.dirname(alone) == tempfile.gettempdir() and alone != run_delphi.namer_scratch_path()


def test_a_terminated_run_removes_its_naming_scratch(delphi_app, tmp_path):
    import os
    import shutil
    import signal
    import subprocess
    import sys
    import time
    from pathlib import Path
    from tests.test_topic_namer import HAIKU_ARG

    script = delphi_app / "umap_narrative" / "run_pipeline.py"
    script.write_text(script.read_text() + "\nimport time\ntime.sleep(60)\n")
    child = subprocess.Popen([
        sys.executable, str(delphi_app / "run_delphi.py"), "--zid=7",
        "--include_moderation=False", "--exclude_comment_selections=False",
        "--selection=participant_visible/1", f"--namer={HAIKU_ARG}",
    ], cwd=delphi_app, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    scratch = None
    try:
        marker = tmp_path / "argv.log.dir"
        deadline = time.monotonic() + 30
        while not marker.exists() and child.poll() is None and time.monotonic() < deadline:
            time.sleep(0.02)
        assert marker.exists()
        scratch = Path(marker.read_text())
        assert (scratch / "hierarchy.json").exists()
        os.killpg(child.pid, signal.SIGTERM)
        child.wait(timeout=10)
        assert not scratch.exists()
    finally:
        if child.poll() is None:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait(timeout=10)
        if scratch and scratch.exists():
            shutil.rmtree(scratch)


def test_a_names_file_read_error_has_the_scratch_failure_reason(tmp_path):
    path = tmp_path / "names.json"
    path.mkdir()
    result = topic_namer.read_names(str(path), small_hierarchy(), HAIKU)
    assert result["outcome"] == "namer_failed"
    assert result["reason"] == "scratch_unavailable (IsADirectoryError)"
