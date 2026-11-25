"""What a named run stores and what its manifest records agree on every
failure of the exchange of the naming's record between the pipeline and
run_delphi.py, and a run stopped by hand leaves nothing of its naming behind.

The rule: the pipeline writes the model's names only after run_delphi.py
acknowledged that it holds their record whole. With no acknowledgement (the
record could not be sent or read, the acknowledgement was lost or did not
come) the pipeline writes keyword labels and run_delphi.py records keywords
with the reason; the run completes and is never failed or re-run for it. The
call's token counts are in the manifest when run_delphi.py holds the record,
and always in the pipeline's own log line."""
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest

from polismath import step_log
from polismath.job_child import full_pipeline_models, naming_cost
from tests.test_topic_namer import (HAIKU, HAIKU_ARG, Names, delphi_app, pipeline, run_delphi_with,  # noqa: F401
                                    run_naming, stub, topic_namer)

import run_delphi


def _call_facts():
    [facts] = [e for e in step_log.recorded() if e.get("step") == "topic_names_call"]
    return facts


def _models(storage):
    return {row.model_name for row in storage.rows}


@pytest.fixture
def quick_ack(monkeypatch):
    # The pipeline waits this long for an acknowledgement that will not come.
    monkeypatch.setattr(topic_namer, "ACK_SECONDS", 0.5)
    yield
    topic_namer.set_acknowledged(True)


def _fails_on(monkeypatch, fd):
    real_read = os.read

    def read(f, n):
        if f == fd:
            raise OSError("this end cannot be read in this test")
        return real_read(f, n)

    monkeypatch.setattr(os, "read", read)


def test_an_acknowledged_record_stores_the_models_names_and_the_manifest_names_the_model(
        pipeline, stub, monkeypatch, tmp_path):
    exchange = topic_namer.RecordExchange()
    storage = Names()
    _, _, naming = run_naming(pipeline, monkeypatch, tmp_path, HAIKU, storage, record_fd=exchange.child_fd)
    record, unreceived = exchange.finish()
    assert (record, unreceived) == (naming, None) and _models(storage) == {HAIKU["model"]}
    assert topic_namer.exit_status() == 0
    assert run_delphi.recorded_naming(0, record, unreceived, HAIKU) == (0, naming)


def test_a_record_the_parent_cannot_read_leaves_keywords_recorded_as_keywords(
        pipeline, stub, monkeypatch, tmp_path, quick_ack):
    # The sequence the review found: the record is sent whole, then reading
    # it fails. The model's names are never stored.
    exchange = topic_namer.RecordExchange()
    _fails_on(monkeypatch, exchange._mine.fileno())
    storage = Names()
    _, _, naming = run_naming(pipeline, monkeypatch, tmp_path, HAIKU, storage, record_fd=exchange.child_fd)
    assert _models(storage) == {"keywords"}
    assert naming["outcome"] == "namer_failed" and naming["reason"] == "record_unacknowledged (timeout)"
    assert topic_namer.exit_status() == topic_namer.UNACKNOWLEDGED_EXIT
    record, unreceived = exchange.finish()
    assert (record, unreceived) == (None, "record_unreadable (OSError)")
    code, recorded = run_delphi.recorded_naming(topic_namer.exit_status(), record, unreceived, HAIKU)
    assert code == 0 and full_pipeline_models(recorded)["topic"] == "keywords"
    assert recorded["reason"] == "record_unreadable (OSError)"
    # The call's cost is in the pipeline's own log line.
    assert _call_facts()["tokens_in"] == naming["tokens_in"] == 25445


def test_an_acknowledgement_lost_on_the_way_leaves_keywords_and_the_manifest_keeps_the_cost(
        pipeline, stub, monkeypatch, tmp_path, quick_ack):
    # run_delphi.py holds the record and answers; the pipeline cannot read
    # the answer. Model names are not stored, and the record held says
    # "named": the exit status overrules it.
    exchange = topic_namer.RecordExchange()
    _fails_on(monkeypatch, exchange.child_fd)
    storage = Names()
    _, _, naming = run_naming(pipeline, monkeypatch, tmp_path, HAIKU, storage, record_fd=exchange.child_fd)
    assert _models(storage) == {"keywords"}
    assert naming["reason"] == "record_unacknowledged (OSError)"
    record, unreceived = exchange.finish()
    assert record["outcome"] == "named" and unreceived is None
    code, recorded = run_delphi.recorded_naming(topic_namer.exit_status(), record, unreceived, HAIKU)
    assert code == 0 and full_pipeline_models(recorded)["topic"] == "keywords"
    assert (recorded["outcome"], recorded["reason"]) == ("namer_failed", "record_unacknowledged")
    assert naming_cost(recorded)["llm_tokens_in"] == 25445


def test_an_acknowledgement_that_does_not_come_leaves_keywords(pipeline, stub, monkeypatch, tmp_path, quick_ack):
    mine, theirs = socket.socketpair()
    try:
        storage = Names()
        _, _, naming = run_naming(pipeline, monkeypatch, tmp_path, HAIKU, storage, record_fd=theirs.fileno())
        assert _models(storage) == {"keywords"}
        assert naming["reason"] == "record_unacknowledged (timeout)" and naming["tokens_in"] == 25445
        assert topic_namer.exit_status() == topic_namer.UNACKNOWLEDGED_EXIT
        # Whatever reached the other end says "named"; the exit status overrules it.
        record = topic_namer.receive_record(mine.fileno())
        assert record["outcome"] == "named"
        _, recorded = run_delphi.recorded_naming(topic_namer.UNACKNOWLEDGED_EXIT, record, None, HAIKU)
        assert full_pipeline_models(recorded)["topic"] == "keywords"
    finally:
        mine.close()
        theirs.close()


def test_a_parent_that_is_gone_leaves_keywords_without_waiting(pipeline, stub, monkeypatch, tmp_path):
    mine, theirs = socket.socketpair()
    mine.close()
    monkeypatch.setattr(topic_namer, "ACK_SECONDS", 30)
    try:
        storage = Names()
        started = time.monotonic()
        _, _, naming = run_naming(pipeline, monkeypatch, tmp_path, HAIKU, storage, record_fd=theirs.fileno())
        assert time.monotonic() - started < 20
        assert _models(storage) == {"keywords"} and naming["reason"].startswith("record_unsent")
        assert topic_namer.exit_status() == topic_namer.UNACKNOWLEDGED_EXIT
        assert _call_facts()["tokens_in"] == 25445
    finally:
        theirs.close()
        topic_namer.set_acknowledged(True)


def test_a_record_that_is_never_sent_whole_leaves_keywords_and_the_cost_in_the_log(
        pipeline, stub, monkeypatch, tmp_path):
    def refuse(fd, result):
        raise OSError("the record pipe is refused for this test")

    monkeypatch.setattr(topic_namer, "send_record", refuse)
    exchange = topic_namer.RecordExchange()
    storage = Names()
    _, _, naming = run_naming(pipeline, monkeypatch, tmp_path, HAIKU, storage, record_fd=exchange.child_fd)
    assert {row.model_name for row in storage.rows} == {"keywords"}
    assert naming["outcome"] == "namer_failed" and naming["reason"].startswith("record_unsent")
    assert exchange.finish() == (None, "record_missing")
    assert _call_facts()["tokens_in"] == 25445
    topic_namer.set_acknowledged(True)


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
    exchange = topic_namer.RecordExchange()
    storage = Names()
    run_naming(pipeline, monkeypatch, tmp_path, HAIKU, storage, record_fd=exchange.child_fd)
    record, unreceived = exchange.finish()
    assert calls == ["timeout", "timeout"] and unreceived is None
    assert record["outcome"] == "timeout" and "record_unsent" in record["reason"]
    assert {row.model_name for row in storage.rows} == {"keywords"}


# What the stand-in pipeline sends on the record socket, and its exit status:
# nothing; a whole record without its final newline (part of one); a whole
# named record, then the status of a pipeline whose acknowledgement did not
# come; a whole named record, acknowledged.
SENDS = {
    "nothing": ("", 0, "keywords (record_missing)"),
    "part": (json.dumps({"schema": "polis-topic-names.run-record/1", "outcome": "named",
                         "namer": {"model": "claude-haiku-5-5"}}), 0, "keywords (record_missing)"),
    "unacknowledged": (json.dumps({"schema": "polis-topic-names.run-record/1", "outcome": "named",
                                   "namer": HAIKU, "tokens_in": 9}) + "\n", 75,
                       "keywords (record_unacknowledged)"),
    "acknowledged": (json.dumps({"schema": "polis-topic-names.run-record/1", "outcome": "named",
                                 "namer": HAIKU, "tokens_in": 9}) + "\n", 0, "claude-haiku-5-5"),
}


@pytest.mark.parametrize("sent", sorted(SENDS))
def test_a_run_whatever_its_record_completes_and_records_what_was_stored(delphi_app, sent):
    text, status, recorded = SENDS[sent]
    script = delphi_app / "umap_narrative" / "run_pipeline.py"
    source = script.read_text()
    start = source.index('    if a.startswith("--naming-record-fd=")')
    script.write_text(source[:start] + '    if a.startswith("--naming-record-fd="):\n'
                      f'        os.write(int(a.split("=", 1)[1]), {text!r}.encode())\n'
                      f'sys.exit({status})\n')
    done = run_delphi_with(delphi_app, f"--namer={HAIKU_ARG}")
    assert done.returncode == 0, done.stdout + done.stderr
    assert f"Topic naming recorded by {recorded}\n" in done.stdout
    assert "Pipeline completed successfully" in done.stdout


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
