"""What a named run stores and what its manifest records agree on every
failure of the naming's record between the pipeline and run_delphi.py, and a
run stopped by hand leaves nothing of its naming behind.

The rule: the pipeline writes the model's names only after its record was
sent whole; run_delphi.py records a naming only from a record it received
whole. A record that does not arrive (unreadable pipe, none sent, part of
one) fails the run, so no manifest names a naming its labels disagree with;
the call's token counts stay in the pipeline's own log line."""
import json
import os
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

import pytest

from polismath import step_log
from tests.test_topic_namer import (HAIKU, HAIKU_ARG, Names, delphi_app, pipeline, run_delphi_with,  # noqa: F401
                                    run_naming, stub, topic_namer)

import run_delphi


def _call_facts():
    [facts] = [e for e in step_log.recorded() if e.get("step") == "topic_names_call"]
    return facts


def test_a_record_the_parent_cannot_read_is_not_received(pipeline, stub, monkeypatch, tmp_path):
    # The sequence the review found: the record is sent whole, the model's
    # names are stored, then reading the pipe fails.
    read_end, write_end = os.pipe()
    try:
        storage = Names()
        _, _, naming = run_naming(pipeline, monkeypatch, tmp_path, HAIKU, storage, record_fd=write_end)
        assert {row.model_name for row in storage.rows} == {HAIKU["model"]}
        real_read = os.read

        def read(fd, n):
            if fd == read_end:
                raise OSError("the pipe cannot be read in this test")
            return real_read(fd, n)

        monkeypatch.setattr(os, "read", read)
        assert run_delphi.receive_naming(read_end) == (None, "record_unreadable (OSError)")
        # The call's cost is in the pipeline's own log line.
        assert _call_facts()["tokens_in"] == naming["tokens_in"] == 25445
    finally:
        os.close(read_end)
        os.close(write_end)


def test_a_record_that_is_never_sent_whole_leaves_keywords_and_the_cost_in_the_log(
        pipeline, stub, monkeypatch, tmp_path):
    def refuse(fd, result):
        raise OSError("the record pipe is refused for this test")

    monkeypatch.setattr(topic_namer, "send_record", refuse)
    read_end, write_end = os.pipe()
    try:
        storage = Names()
        _, _, naming = run_naming(pipeline, monkeypatch, tmp_path, HAIKU, storage, record_fd=write_end)
        assert {row.model_name for row in storage.rows} == {"keywords"}
        assert naming["outcome"] == "namer_failed" and naming["reason"].startswith("record_unsent")
        assert run_delphi.receive_naming(read_end) == (None, "record_missing")
        assert _call_facts()["tokens_in"] == 25445
    finally:
        os.close(read_end)
        os.close(write_end)


def test_a_record_not_sent_after_another_outcome_is_sent_again(pipeline, stub, monkeypatch, tmp_path):
    monkeypatch.setenv("STUB_OUTCOME", "timeout")
    real = topic_namer.send_record
    calls = []

    def first_fails(fd, result):
        calls.append(result["outcome"])
        if len(calls) == 1:
            raise OSError("the record pipe is refused once for this test")
        real(fd, result)

    monkeypatch.setattr(topic_namer, "send_record", first_fails)
    read_end, write_end = os.pipe()
    try:
        storage = Names()
        run_naming(pipeline, monkeypatch, tmp_path, HAIKU, storage, record_fd=write_end)
        record, unreceived = run_delphi.receive_naming(read_end)
        assert calls == ["timeout", "timeout"] and unreceived is None
        assert record["outcome"] == "timeout" and "record_unsent" in record["reason"]
        assert {row.model_name for row in storage.rows} == {"keywords"}
    finally:
        os.close(read_end)
        os.close(write_end)


# What the stand-in pipeline sends on the record pipe: nothing, or a whole
# record without its final newline (part of one).
SENDS = {
    "nothing": "",
    "part": json.dumps({"schema": "polis-topic-names.run-record/1", "outcome": "named",
                        "namer": {"model": "claude-haiku-5-5"}}),
}


@pytest.mark.parametrize("sent", sorted(SENDS))
def test_a_run_that_receives_no_whole_record_fails(delphi_app, sent):
    script = delphi_app / "umap_narrative" / "run_pipeline.py"
    text = script.read_text()
    start = text.index('    if a.startswith("--naming-record-fd=")')
    script.write_text(text[:start] + '    if a.startswith("--naming-record-fd="):\n'
                      f'        os.write(int(a.split("=", 1)[1]), {SENDS[sent]!r}.encode())\n')
    done = run_delphi_with(delphi_app, f"--namer={HAIKU_ARG}")
    assert done.returncode == 1, done.stdout + done.stderr
    assert "naming record (record_missing)" in done.stdout
    assert "Pipeline completed successfully" not in done.stdout


@pytest.mark.parametrize("step_log_on", [False, True])
def test_a_hand_run_stopped_with_sigterm_stops_its_pipeline_and_leaves_no_scratch(
        delphi_app, tmp_path, monkeypatch, step_log_on):
    # Only run_delphi.py is sent SIGTERM; the stand-in pipeline would, a
    # second later, make the scratch directory again.
    if step_log_on:
        monkeypatch.setenv("DELPHI_STEP_LOG", "1")
    else:
        monkeypatch.delenv("DELPHI_STEP_LOG", raising=False)
    script = delphi_app / "umap_narrative" / "run_pipeline.py"
    script.write_text(script.read_text() + (
        "\nimport time\ntime.sleep(1)\nos.makedirs(d, exist_ok=True)\n"
        "open(os.path.join(d, 'hierarchy.json'), 'w').write('{}')\n"
        "open(os.environ['PIPELINE_ARGV'] + '.again', 'w').write('late')\ntime.sleep(30)\n"))
    child = subprocess.Popen([sys.executable, str(delphi_app / "run_delphi.py"), "--zid=7",
                              "--include_moderation=False", "--exclude_comment_selections=False",
                              "--selection=participant_visible/1", f"--namer={HAIKU_ARG}"],
                             cwd=delphi_app, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                             start_new_session=True)
    scratch = None
    try:
        marker = tmp_path / "argv.log.dir"
        deadline = time.monotonic() + 30
        while not marker.exists() and child.poll() is None and time.monotonic() < deadline:
            time.sleep(0.02)
        assert marker.exists()
        scratch = Path(marker.read_text())
        child.send_signal(signal.SIGTERM)
        child.wait(timeout=20)
        time.sleep(2)
        assert not (tmp_path / "argv.log.again").exists(), "the pipeline outlived its run"
        assert not scratch.exists()
    finally:
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        child.wait(timeout=10)
        if scratch and scratch.exists():
            shutil.rmtree(scratch)


PROGRAM = """#!/bin/sh
echo $$ > "$PROGRAM_PID"
exec sleep 30
"""

STOPPED_PIPELINE = """import os, sys
from umap_narrative import topic_namer
topic_namer.exit_on_sigterm()
hierarchy = {"schema": topic_namer.HIERARCHY_SCHEMA, "layers": [0],
             "topics": {"0_0": {"id": "0_0", "layer": 0, "cluster": 0, "size": 1, "keywords": [],
                                "parent": None, "samples3": ["x"]}}}
topic_namer.run_namer(topic_namer.parse_namer(sys.argv[1]), hierarchy, sys.argv[2])
"""


def test_a_pipeline_stopped_with_sigterm_stops_the_naming_program_first(tmp_path):
    program = tmp_path / "polis-topic-names"
    program.write_text(PROGRAM)
    program.chmod(0o755)
    pid_file = tmp_path / "program.pid"
    env = dict(os.environ, DELPHI_TOPIC_NAMES_BIN=str(program), PROGRAM_PID=str(pid_file),
               PYTHONPATH=str(Path(run_delphi.__file__).resolve().parent))
    child = subprocess.Popen([sys.executable, "-c", STOPPED_PIPELINE, HAIKU_ARG, str(tmp_path / "naming")],
                             env=env, start_new_session=True)
    pid = None
    try:
        deadline = time.monotonic() + 30
        while not (pid_file.exists() and pid_file.read_text().strip()) and time.monotonic() < deadline:
            time.sleep(0.02)
        pid = int(pid_file.read_text())
        child.send_signal(signal.SIGTERM)
        assert child.wait(timeout=20) == 128 + signal.SIGTERM
        with pytest.raises(ProcessLookupError):
            os.kill(pid, 0)
    finally:
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        child.wait(timeout=10)
