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


@pytest.mark.parametrize("setup_failure", [False, True])
@pytest.mark.parametrize("step_log_on", [False, True])
def test_a_hand_run_stopped_with_sigterm_stops_its_pipeline_and_leaves_no_scratch(
        delphi_app, tmp_path, monkeypatch, step_log_on, setup_failure):
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
    command = [sys.executable, str(delphi_app / "run_delphi.py"), "--zid=7",
               "--include_moderation=False", "--exclude_comment_selections=False",
               "--selection=participant_visible/1", f"--namer={HAIKU_ARG}"]
    if setup_failure:
        inject = """import sys, runpy
from umap_narrative import topic_namer
def broken(): raise OSError("injected setup failure")
topic_namer.socket.socketpair = broken
sys.argv = sys.argv[1:]
runpy.run_path(sys.argv[0], run_name="__main__")
"""
        command = [sys.executable, "-c", inject, *command[1:]]
    child = subprocess.Popen(command, cwd=delphi_app, stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL, start_new_session=True)
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


def test_retry_does_not_acknowledge_the_interrupted_model_record(pipeline, stub, monkeypatch, tmp_path):
    import select

    exchange = topic_namer.RecordExchange()
    real = os.write
    sends = 0
    def write(fd, data):
        nonlocal sends
        if fd != exchange.child_fd:
            return real(fd, data)
        sends += 1
        if sends == 1:
            # Real short write: all JSON, but not its trailing newline.
            return real(fd, data[:-1])
        if sends == 2:
            raise OSError('injected error before the final newline')
        if sends == 3:
            # Split the resend immediately after its first newline. Give the
            # receiving thread a turn before the new JSON is sent.
            n = bytes(data).index(b'\n') + 1
            sent = real(fd, data[:n])
            select.select([fd], [], [], 0.25)
            return sent
        return real(fd, data)
    monkeypatch.setattr(os, 'write', write)
    storage = Names()
    try:
        _, _, naming = run_naming(pipeline, monkeypatch, tmp_path, HAIKU, storage, record_fd=exchange.child_fd)
    finally:
        record, reason = exchange.finish()
    code, manifest = run_delphi.recorded_naming(topic_namer.exit_status(), record, reason, HAIKU)
    print('retry:', json.dumps(dict(child_exit=topic_namer.exit_status(), parent_exit=code,
          storage=sorted({r.model_name for r in storage.rows}), child=naming['outcome'],
          parent=manifest['outcome'], reason=manifest.get('reason'))))
    assert code == 0
    assert {r.model_name for r in storage.rows} == {full_pipeline_models(manifest)['topic']}
    assert manifest['reason'].startswith('record_unsent')



@pytest.mark.parametrize("point", ["socket", "thread"])
def test_exchange_setup_failure_completes_with_keywords(delphi_app, tmp_path, monkeypatch, point):
    # Real parent, child launch and manifest writer; external data reads are
    # stand-ins. These two setup faults used to exit before the child ran.
    manifest = tmp_path / "manifest.json"
    monkeypatch.setenv("DELPHI_OUTPUT_MANIFEST", str(manifest))
    fault = ("topic_namer.socket.socketpair" if point == "socket"
             else "topic_namer.threading.Thread.start")
    kind = "OSError" if point == "socket" else "RuntimeError"
    script = f'''import sys, time, run_delphi
from umap_narrative import topic_namer
from polismath import job_child
from polismath.job_child import census
def broken(*args, **kwargs): raise {kind}("injected setup failure")
{fault} = broken
job = job_child.JobContext(job_id="00000000-0000-4000-8000-000000000007",
    run_id="00000000-0000-4000-8000-000000000008",
    attempt_id="00000000-0000-4000-8000-000000000009", lease_epoch=1,
    stage=job_child.STAGE_FULL_PIPELINE, phase=job_child.PHASE_RUN,
    manifest_path={str(manifest)!r}, frame_path="unused", frame={{}}, started_monotonic=time.monotonic())
run_delphi._start_daemon_job = lambda zid: job
census.default_dynamodb = lambda region: None
census.count_full_pipeline_outputs = lambda *a: []
sys.argv = [{str(delphi_app / "run_delphi.py")!r}, "--zid=7", "--include_moderation=False",
    "--exclude_comment_selections=False", "--selection=participant_visible/1", "--namer=" + {HAIKU_ARG!r}]
run_delphi.main()
'''
    done = subprocess.run([sys.executable, "-c", script], cwd=delphi_app,
                          capture_output=True, text=True, timeout=30)
    assert done.returncode == 0, done.stdout + done.stderr
    assert "Topic naming recorded by keywords (record_exchange_unavailable)" in done.stdout
    assert "Pipeline completed successfully" in done.stdout
    [argv] = [json.loads(line) for line in Path(os.environ["PIPELINE_ARGV"]).read_text().splitlines()]
    assert "--namer=" + HAIKU_ARG in argv
    assert "--naming-keywords-only" in argv
    assert not any(arg.startswith("--naming-record-fd=") for arg in argv)
    saved = json.loads(manifest.read_text())
    assert saved["outcome"] == "succeeded" and saved["models"]["topic"] == "keywords"
    assert saved["cost"]["llm_tokens_in"] is None and saved["cost"]["llm_tokens_out"] is None
    scratch = Path(Path(os.environ["PIPELINE_ARGV"] + ".dir").read_text())
    assert not scratch.exists()


def test_setup_fallback_stores_keywords_without_building_or_calling_a_namer(
        pipeline, stub, monkeypatch, tmp_path):
    def forbidden(*a, **kw):
        pytest.fail("setup fallback must not prepare or call a model")

    monkeypatch.setattr(topic_namer, "build_hierarchy", forbidden)
    monkeypatch.setattr(pipeline, "_call_namer", forbidden)
    storage = Names()
    labels, notes, naming = run_naming(pipeline, monkeypatch, tmp_path, HAIKU, storage,
                                       naming_keywords_only=True)
    assert _models(storage) == {"keywords"}
    assert labels[0]["0"] == "Keywords: water, land | Example: c0"
    assert labels[1]["0"] == "Keywords: town | Example: c0"
    assert naming["outcome"] == "namer_failed"
    assert naming["reason"] == "record_exchange_unavailable"
    assert all(note["model"] == "keywords" for note in notes)
    assert naming == topic_namer.record_of(topic_namer.exchange_unavailable(HAIKU))
    assert topic_namer.exit_status() == 0
    assert not (stub / "argv.log").exists() and not (tmp_path / "naming").exists()


@pytest.mark.parametrize("point", ["event", "thread", "start"])
def test_exchange_setup_closes_both_sockets_on_failure(monkeypatch, point):
    sockets = socket.socketpair()
    monkeypatch.setattr(topic_namer.socket, "socketpair", lambda: sockets)

    def broken(*a, **kw):
        raise RuntimeError("injected setup failure")

    if point == "event":
        monkeypatch.setattr(topic_namer.threading, "Event", broken)
    elif point == "thread":
        monkeypatch.setattr(topic_namer.threading, "Thread", broken)
    else:
        monkeypatch.setattr(topic_namer.threading.Thread, "start", broken)
    try:
        with pytest.raises(RuntimeError, match="injected setup failure"):
            topic_namer.RecordExchange()
        assert [sock.fileno() for sock in sockets] == [-1, -1]
    finally:
        for sock in sockets:
            sock.close()


def test_pipeline_cli_carries_the_explicit_keyword_fallback(pipeline, monkeypatch):
    seen = {}
    monkeypatch.setattr(pipeline, "setup_environment", lambda **kw: None)
    monkeypatch.setattr(pipeline, "process_conversation", lambda *a, **kw: seen.update(kw) or True)
    monkeypatch.setattr(sys, "argv", ["run_pipeline.py", "--zid=7", "--include_moderation=False",
        "--exclude_comment_selections=False", "--selection=participant_visible/1",
        "--namer=" + HAIKU_ARG, "--naming-keywords-only"])
    with pytest.raises(SystemExit) as exited:
        pipeline.main()
    assert exited.value.code == 0
    assert seen["namer"] == HAIKU and seen["naming_keywords_only"] is True
    assert seen["naming_record_fd"] is None


@pytest.mark.parametrize("args", [[], ["--namer=" + HAIKU_ARG, "--naming-record-fd=0"]])
def test_keyword_fallback_cli_rejects_ambiguous_modes(pipeline, monkeypatch, args):
    monkeypatch.setattr(sys, "argv", ["run_pipeline.py", "--zid=7", "--include_moderation=False",
        "--exclude_comment_selections=False", "--selection=participant_visible/1",
        "--naming-keywords-only", *args])
    with pytest.raises(SystemExit) as exited:
        pipeline.main()
    assert exited.value.code == 2
