"""Generated fixture standing in for the Delphi scripts under the polis-jobs daemon.

It honours the daemon's child protocol (DELPHI_* environment, the frame, the
output manifest, the provider-intent handshake) and does no science. The
behaviour is chosen by FAKE_DELPHI_MODE. It never talks to the database.
"""
import hashlib
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone

INTENT_SCHEMA = "polis-jobs.provider-intent/1"
ACK_SCHEMA = "polis-jobs.provider-intent-ack/1"


def canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n").encode()


def write_atomic(path, data):
    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def record(name, line):
    path = os.environ.get(name)
    if path:
        with open(path, "a") as f:
            f.write(line + "\n")


def manifest(outcome, phase, batches=None, recheck_after=None):
    stage = os.environ["DELPHI_STAGE"]
    return {
        "schema": "polis-jobs.output-manifest/1",
        "job_id": os.environ["DELPHI_JOB_ID"],
        "attempt_id": os.environ["DELPHI_ATTEMPT_ID"],
        "stage": stage,
        "phase": phase,
        "outcome": outcome,
        "inputs": {"math_env": "test", "math_tick": 3, "math_caching_tick": 3,
                   "comment_set_sha256": "0" * 64, "vote_hwm": 9},
        # A rebuild publishes no DynamoDB rows: its bundle is staged in Postgres.
        "outputs": [] if stage == "math_rebuild" else [
            {"store": "dynamodb", "family": "Delphi_UMAPGraph", "table": "Delphi_UMAPGraph",
             "key_prefix": {"conversation_id": "1"}, "rows": 4}],
        "models": {"embed": "fixture-embed", "topic": None, "narrative": None},
        "cost": {"llm_tokens_in": 10, "llm_tokens_out": 20, "provider_batches": batches},
        "recheck_after": recheck_after,
        "duration_ms": 5,
    }


def intent_handshake(attempt_dir):
    intent = {
        "schema": INTENT_SCHEMA, "job_id": os.environ["DELPHI_JOB_ID"],
        "run_id": os.environ["DELPHI_RUN_ID"], "attempt_id": os.environ["DELPHI_ATTEMPT_ID"],
        "lease_epoch": os.environ["DELPHI_LEASE_EPOCH"], "stage": os.environ["DELPHI_STAGE"],
        "phase": os.environ.get("DELPHI_PHASE"), "provider": "anthropic", "model": "fixture-model",
        "batch": {"requests": 2},
    }
    data = canonical(intent)
    digest = hashlib.sha256(data).hexdigest()
    write_atomic(os.path.join(attempt_dir, "provider_intent.json"), data)
    ack_path = os.path.join(attempt_dir, "provider_intent.ack")
    deadline = time.time() + 30
    while time.time() < deadline:
        if os.path.exists(ack_path):
            ack = json.load(open(ack_path))
            if ack.get("schema") != ACK_SCHEMA or ack.get("intent_sha256") != digest:
                print("fake child: acknowledgement names a different intent", file=sys.stderr)
                sys.exit(6)
            print("fake child: intent acknowledged request_id=" + ack["request_id"], flush=True)
            return ack
        if os.path.exists(os.path.join(attempt_dir, "provider_intent.refused")):
            print("fake child: intent refused", file=sys.stderr)
            sys.exit(6)
        time.sleep(0.02)
    sys.exit(6)


def main(script):
    mode = os.environ.get("FAKE_DELPHI_MODE", "success")
    phase = os.environ.get("DELPHI_PHASE", "run")
    out = os.environ["DELPHI_OUTPUT_MANIFEST"]
    attempt_dir = os.path.dirname(out)
    frame = json.load(open(os.environ["DELPHI_FRAME"]))
    stdin_frame = json.loads(sys.stdin.readline())
    assert stdin_frame == frame, "stdin frame differs from DELPHI_FRAME"
    runs_path = os.environ.get("FAKE_DELPHI_RUNS")
    earlier_runs = len(open(runs_path).read().splitlines()) if runs_path and os.path.exists(runs_path) else 0
    if mode == "sleep_first":
        # The first run of the job hangs; any later run succeeds, on whichever daemon.
        mode = "sleep" if earlier_runs == 0 else "success"
    record("FAKE_DELPHI_RUNS", f"{os.environ['DELPHI_ATTEMPT_ID']} {script} {phase} {os.getpid()}")
    for key in ("DELPHI_JOB_ID", "DELPHI_RUN_ID", "DELPHI_ATTEMPT_ID", "DELPHI_LEASE_EPOCH",
                "DELPHI_STAGE", "DELPHI_PHASE"):
        print(f"{key}={os.environ.get(key)}", flush=True)
    print("argv=" + " ".join(sys.argv[1:]), flush=True)
    if script == "math_poller":
        # The job entry of the math poller: the zid comes from the frame, never argv.
        assert sys.argv[1:] == ["--job"], sys.argv[1:]
        assert frame["stage"] == "math_rebuild" and frame["zid"] > 0, frame
        # The typed math config crosses the daemon boundary whole (P-073 r2):
        # exactly these six keys, each of its type, as the real child checks.
        config = frame["config"]
        assert set(config) == {"staged_label", "target_label", "need_bytes", "input_through_ms",
                               "binding", "source_commit"}, sorted(config)
        assert isinstance(config["staged_label"], str) and config["staged_label"], config
        assert isinstance(config["target_label"], str) and config["target_label"], config
        assert config["staged_label"] != config["target_label"], config
        assert config["staged_label"] == frame["inputs"]["math_env"], (config, frame["inputs"])
        assert type(config["need_bytes"]) is int and config["need_bytes"] > 0, config
        assert config["input_through_ms"] is None or type(config["input_through_ms"]) is int, config
        assert isinstance(config["binding"], str) and config["binding"], config
        assert isinstance(config["source_commit"], str) and config["source_commit"], config
        print(f"rebuild zid={frame['zid']}", flush=True)
        print("math_config=" + json.dumps(config, sort_keys=True), flush=True)
    print("queue_dsn_visible=" + str("QUEUE_DATABASE_URL" in os.environ), flush=True)
    print("fake child stderr line", file=sys.stderr, flush=True)
    if os.environ.get("FAKE_DELPHI_LONG") == "1":
        print("L" * (1536 * 1024), flush=True)
        for i in range(10):
            print(f"short line {i}", flush=True)
    if script == "803":
        # The recheck: the batch finished; publish the narrative.
        write_atomic(out, canonical(manifest("succeeded", "recheck",
                     batches=[{"provider": "anthropic", "batch_id": frame["provider"]["batch_id"],
                               "submitted_at": iso(datetime.now(timezone.utc))}])))
        return 0
    if mode.startswith("invalid:"):
        # Schema-invalid manifests that must never finalize.
        m = manifest("succeeded", phase)
        mutation = mode.split(":", 1)[1]
        if mutation == "empty_inputs":
            m["inputs"] = {}
        if mutation == "bad_tick":
            m["inputs"]["math_tick"] = "unusable"
        if mutation == "empty_models":
            m["models"] = {}
        if mutation == "missing_duration":
            del m["duration_ms"]
        if mutation == "extra_key":
            m["unexpected"] = True
        if mutation == "wrong_identity":
            m["job_id"] = "00000000-0000-4000-8000-000000000099"
        write_atomic(out, canonical(m))
        return 0
    if mode == "success":
        write_atomic(out, canonical(manifest("succeeded", phase)))
        return 0
    if mode == "no_manifest":
        return 0
    if mode.startswith("exit:"):
        return int(mode.split(":", 1)[1])
    if mode == "sleep":
        grandchild = subprocess.Popen(["sleep", "300"])
        record("FAKE_DELPHI_PIDS", f"{os.getpid()} {grandchild.pid}")
        time.sleep(300)
        return 0
    if mode == "sleep_then_success":
        time.sleep(float(os.environ.get("FAKE_DELPHI_SLEEP", "2")))
        write_atomic(out, canonical(manifest("succeeded", phase)))
        return 0
    if mode == "parity":
        record("FAKE_DELPHI_PIDS", f"{os.getpid()} 0")
        time.sleep(float(os.environ.get("FAKE_DELPHI_SLEEP", "6")))
        intent_handshake(attempt_dir)
        batch = "batch-" + os.environ["DELPHI_ATTEMPT_ID"][:8]
        write_atomic(out, canonical(manifest("succeeded", phase, batches=[
            {"provider": "anthropic", "batch_id": batch, "submitted_at": iso(datetime.now(timezone.utc))}])))
        return 0
    if mode == "intent_submit":
        intent_handshake(attempt_dir)
        mark = os.environ.get("FAKE_DELPHI_MARK")
        if mark:
            write_atomic(mark, b"acked\n")
        time.sleep(float(os.environ.get("FAKE_DELPHI_HOLD", "3")))
        now = datetime.now(timezone.utc)
        batch = "batch-" + os.environ["DELPHI_ATTEMPT_ID"][:8]
        write_atomic(out, canonical(manifest("parked", "submit",
                     batches=[{"provider": "anthropic", "batch_id": batch, "submitted_at": iso(now)}],
                     recheck_after=iso(now + timedelta(seconds=2)))))
        return 0
    if mode == "bad_recheck":
        # A parked manifest whose recheck_after is not a timestamp.
        m = manifest("parked", phase, batches=[{"provider": "anthropic", "batch_id": "b",
                     "submitted_at": iso(datetime.now(timezone.utc))}],
                     recheck_after="2026-10-03T12:00:0\u00e9+00:00")
        write_atomic(out, canonical(m))
        return 0
    if mode == "intent_crash":
        intent_handshake(attempt_dir)
        return 1
    print("fake child: unknown mode " + mode, file=sys.stderr)
    return 2
