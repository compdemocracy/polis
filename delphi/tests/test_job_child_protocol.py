"""The child side of the polis-jobs daemon protocol (P-077 P1-b).

A fake daemon harness built from generated fixtures: it mints the daemon's
environment (DELPHI_JOB_ID, DELPHI_RUN_ID, DELPHI_ATTEMPT_ID,
DELPHI_LEASE_EPOCH, DELPHI_STAGE, DELPHI_OUTPUT_MANIFEST, DELPHI_FRAME) and a
per-attempt directory, runs the real run_delphi.py against stub stage scripts,
and plays the daemon's side of the provider-intent handshake for the narrative
scripts. Nothing here talks to AWS, Postgres or a provider: the census reads
are replaced with recorded values, and the provider client is a fake that
records when it was called.

Covered: the manifest's shape and sha256 (over the exact file bytes), the
atomic write, the exit codes, the intent-before-call order, and that the legacy
path (no DELPHI_OUTPUT_MANIFEST) writes nothing and prints what it printed
before.
"""

import asyncio
import hashlib
import importlib
import json
import os
import re
import stat
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path
from types import SimpleNamespace

import pytest

from polismath import job_child
from polismath.job_child import census

DELPHI_ROOT = Path(__file__).resolve().parents[1]
RUN_DELPHI = DELPHI_ROOT / "run_delphi.py"

STAGES = {
    "reset": "umap_narrative/reset_conversation.py",
    "math": "polismath/run_math_pipeline.py",
    "umap": "umap_narrative/run_pipeline.py",
    "extremity": "umap_narrative/501_calculate_comment_extremity.py",
    "priority": "umap_narrative/502_calculate_priorities.py",
    "visualization": "umap_narrative/700_datamapplot_for_layer.py",
}
ALL_STAGES = ["reset", "math", "umap", "extremity", "priority", "visualization"]

STUB = '''import os, sys
name = {name!r}
with open(os.environ["STAGE_LOG"], "a") as f:
    f.write(name + "\\n")
sys.exit(int(os.environ.get("STUB_EXIT_" + name.upper(), "0")))
'''

# Loaded by every interpreter in the subprocess tests (PYTHONPATH). When the
# test points JOB_CHILD_TEST_CENSUS at a JSON file, the census reads return its
# recorded values instead of touching Postgres or DynamoDB.
SITECUSTOMIZE = '''import json, os, sys
_path = os.environ.get("JOB_CHILD_TEST_CENSUS")
if _path:
    sys.path.insert(0, os.environ["JOB_CHILD_TEST_DELPHI_ROOT"])
    from polismath.job_child import census as _census
    with open(_path) as _f:
        _spec = json.load(_f)

    def _observe(zid, math_env, pg_query):
        if _spec.get("inputs_error"):
            raise _census.CensusError("generated fixture: inputs unreadable")
        return dict(_spec["inputs"], math_env=math_env)

    def _count(zid, dynamodb):
        if _spec.get("outputs_error"):
            raise _census.CensusError("generated fixture: outputs uncountable")
        return _spec["outputs"]

    _census.default_pg_query = lambda: None
    _census.default_dynamodb = lambda region=None: None
    _census.observe_inputs = _observe
    _census.count_full_pipeline_outputs = _count
'''

FIXTURE_INPUTS = {
    "math_tick": 41,
    "math_caching_tick": 7,
    "comment_set_sha256": hashlib.sha256(b"generated fixture comments").hexdigest(),
    "vote_hwm": 1700000000123,
    # A math rebuild's receipt binding (#677); null for the Delphi stages.
    "math_modified_ms": None,
    "target_label": None,
    "source_commit": None,
}
FIXTURE_OUTPUTS = [
    {"store": "dynamodb", "family": "Delphi_PCAResults", "table": "Delphi_PCAResults",
     "key_prefix": {"zid": "1"}, "rows": 1},
    {"store": "dynamodb", "family": "Delphi_RepresentativeComments", "table": "Delphi_RepresentativeComments",
     "keys": [{"zid_tick_gid": "1:41:0"}, {"zid_tick_gid": "1:41:1"}], "rows": 9},
    {"store": "dynamodb", "family": "Delphi_CommentClustersLLMTopicNames",
     "table": "Delphi_CommentClustersLLMTopicNames", "key_prefix": {"conversation_id": "1"}, "rows": 4},
]


# --- the fake daemon --------------------------------------------------------

class FakeDaemon:
    """Mints one attempt's environment and frame the way the polis-jobs daemon does."""

    def __init__(self, root: Path, *, stage, zid="1", phase=None, report_id=None, batch_id=None,
                 math_env=None):
        self.job_id = str(uuid.uuid4())
        self.run_id = str(uuid.uuid4())
        self.attempt_id = str(uuid.uuid4())
        self.lease_epoch = "3"
        self.stage = stage
        self.attempt_dir = root / f"attempt-{self.attempt_id}"
        self.attempt_dir.mkdir(parents=True)
        self.manifest = self.attempt_dir / "output-manifest.json"
        self.frame_path = self.attempt_dir / "frame.json"
        self.frame = {
            "schema": "polis-jobs.frame/1", "env": "dev", "zid": int(zid), "report_id": report_id,
            "job_id": self.job_id, "run_id": self.run_id, "attempt_id": self.attempt_id,
            "lease_epoch": self.lease_epoch, "stage": stage, "phase": phase,
            "config": {"include_moderation": False, "exclude_comment_selections": True,
                       "model": "generated-fixture-model", "batch_size": 5},
            "inputs": {"math_env": math_env, "requested_math_tick": None},
            "provider": {"batch_id": batch_id},
        }
        self.frame_path.write_text(json.dumps(self.frame))

    def env(self):
        return {
            "DELPHI_JOB_ID": self.job_id,
            "DELPHI_RUN_ID": self.run_id,
            "DELPHI_ATTEMPT_ID": self.attempt_id,
            "DELPHI_LEASE_EPOCH": self.lease_epoch,
            "DELPHI_STAGE": self.stage,
            "DELPHI_OUTPUT_MANIFEST": str(self.manifest),
            "DELPHI_FRAME": str(self.frame_path),
        }

    def apply(self, monkeypatch):
        for k, v in self.env().items():
            monkeypatch.setenv(k, v)

    def manifest_bytes(self):
        return self.manifest.read_bytes()

    def leftovers(self):
        """Temporary files left in the attempt directory (an atomic write leaves none)."""
        return sorted(p.name for p in self.attempt_dir.iterdir() if p.name.endswith(".tmp"))


def clear_daemon_env(monkeypatch):
    for k in job_child.JOB_ENV_KEYS + (job_child.PHASE_ENV, "DELPHI_REPORT_ID"):
        monkeypatch.delenv(k, raising=False)


def manifest_sha_from_stderr(stderr):
    m = re.search(r"manifest written outcome=\w+ bytes=\d+ sha256=([0-9a-f]{64})", stderr)
    return m.group(1) if m else None


# --- the run_delphi.py harness ----------------------------------------------

@pytest.fixture
def app_dir(tmp_path, monkeypatch):
    app = tmp_path / "app"
    for name, rel in STAGES.items():
        path = app / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(STUB.format(name=name))
    (app / "run_delphi.py").symlink_to(RUN_DELPHI)

    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    shim = bin_dir / "python"
    shim.write_text(f'#!/bin/sh\nexec "{sys.executable}" "$@"\n')
    shim.chmod(shim.stat().st_mode | stat.S_IEXEC)

    site = tmp_path / "site"
    site.mkdir()
    (site / "sitecustomize.py").write_text(SITECUSTOMIZE)
    census_spec = tmp_path / "census.json"
    census_spec.write_text(json.dumps({"inputs": FIXTURE_INPUTS, "outputs": FIXTURE_OUTPUTS}))

    log = tmp_path / "stages.log"
    log.write_text("")
    for name in STAGES:
        monkeypatch.delenv("STUB_EXIT_" + name.upper(), raising=False)
    clear_daemon_env(monkeypatch)
    monkeypatch.delenv("MATH_ENV", raising=False)
    monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}{os.environ['PATH']}")
    monkeypatch.setenv("PYTHONPATH", str(site))
    monkeypatch.setenv("JOB_CHILD_TEST_CENSUS", str(census_spec))
    monkeypatch.setenv("JOB_CHILD_TEST_DELPHI_ROOT", str(DELPHI_ROOT))
    monkeypatch.setenv("DELPHI_APP_PATH", str(app))
    monkeypatch.setenv("STAGE_LOG", str(log))
    monkeypatch.setenv("LLM_PROVIDER", "anthropic")
    monkeypatch.setenv("DYNAMODB_ENDPOINT", "http://127.0.0.1:1")
    monkeypatch.setenv("AWS_MAX_ATTEMPTS", "1")
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "dummy")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "dummy")
    monkeypatch.chdir(app)
    return SimpleNamespace(path=app, root=tmp_path, census_spec=census_spec, log=log)


def ran_stages(app):
    return app.log.read_text().split()


def run_delphi(app, *extra):
    return subprocess.run(
        [sys.executable, str(app.path / "run_delphi.py"), "--zid=1", *extra],
        cwd=app.path, capture_output=True, text=True, timeout=120,
    )


def test_daemon_success_writes_a_valid_manifest_whose_sha_is_over_the_file_bytes(app_dir, monkeypatch):
    daemon = FakeDaemon(app_dir.root, stage="delphi_full_pipeline")
    daemon.apply(monkeypatch)
    result = run_delphi(app_dir)
    assert result.returncode == 0, result.stdout + result.stderr
    assert ran_stages(app_dir) == ALL_STAGES

    data = daemon.manifest_bytes()
    manifest = json.loads(data)
    job_child.validate_manifest(manifest)
    assert data == job_child.canonical_bytes(manifest)  # canonical: sorted keys, one trailing newline
    assert manifest_sha_from_stderr(result.stderr) == hashlib.sha256(data).hexdigest()
    assert manifest["schema"] == "polis-jobs.output-manifest/1"
    assert (manifest["job_id"], manifest["attempt_id"]) == (daemon.job_id, daemon.attempt_id)
    assert (manifest["stage"], manifest["phase"], manifest["outcome"]) == ("delphi_full_pipeline", "run", "succeeded")
    assert manifest["inputs"] == dict(FIXTURE_INPUTS, math_env="prod")
    assert manifest["outputs"] == FIXTURE_OUTPUTS
    assert manifest["models"] == {"embed": "all-MiniLM-L6-v2", "topic": "claude-haiku-4-5-20251001", "narrative": None}
    assert manifest["recheck_after"] is None
    assert daemon.leftovers() == []


def test_daemon_mode_leaves_stdout_exactly_as_the_legacy_path_prints_it(app_dir, monkeypatch):
    legacy = run_delphi(app_dir)
    daemon = FakeDaemon(app_dir.root, stage="delphi_full_pipeline")
    daemon.apply(monkeypatch)
    run = run_delphi(app_dir)
    assert legacy.returncode == run.returncode == 0
    assert run.stdout == legacy.stdout
    assert "polis-jobs" not in legacy.stdout + legacy.stderr


def test_legacy_path_writes_nothing_even_with_the_poller_job_id(app_dir, monkeypatch):
    # The DynamoDB poller sets DELPHI_JOB_ID and DELPHI_REPORT_ID, never DELPHI_OUTPUT_MANIFEST.
    monkeypatch.setenv("DELPHI_JOB_ID", "batch_report_r1_1700000000_abcd1234")
    monkeypatch.setenv("DELPHI_REPORT_ID", "r1")
    before = sorted(p.name for p in app_dir.root.iterdir())
    result = run_delphi(app_dir)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "polis-jobs" not in result.stdout + result.stderr
    assert sorted(p.name for p in app_dir.root.iterdir()) == before


def test_legacy_failure_exit_code_is_unchanged_for_the_math_export(app_dir, monkeypatch):
    monkeypatch.setenv("STUB_EXIT_MATH", "4")
    result = run_delphi(app_dir)
    assert result.returncode == 1  # the legacy poller only distinguishes zero from non-zero
    assert ran_stages(app_dir) == ALL_STAGES


@pytest.mark.parametrize(
    "stub, code, stages",
    [
        ({"STUB_EXIT_UMAP": "1"}, 1, ["reset", "math", "umap", "extremity", "priority"]),
        ({"STUB_EXIT_EXTREMITY": "2"}, 1, ALL_STAGES),
        ({"STUB_EXIT_VISUALIZATION": "2"}, 1, ALL_STAGES),
        ({"STUB_EXIT_MATH": "4"}, 4, ALL_STAGES),
        ({"STUB_EXIT_MATH": "4", "STUB_EXIT_PRIORITY": "1"}, 4, ALL_STAGES),
        ({"STUB_EXIT_MATH": "1"}, 1, ["reset", "math"]),
        ({"STUB_EXIT_MATH": "137"}, 1, ["reset", "math"]),  # a killed stage: any other code is 1
        ({"STUB_EXIT_MATH": "2"}, 1, ["reset", "math"]),  # never confused with "environment refused"
        ({"STUB_EXIT_RESET": "3"}, 1, ["reset"]),
        ({"STUB_EXIT_RESET": "6"}, 1, ["reset"]),
    ],
)
def test_daemon_failure_exit_codes_and_no_manifest(app_dir, monkeypatch, stub, code, stages):
    daemon = FakeDaemon(app_dir.root, stage="delphi_full_pipeline")
    daemon.apply(monkeypatch)
    for k, v in stub.items():
        monkeypatch.setenv(k, v)
    result = run_delphi(app_dir)
    assert result.returncode == code, result.stdout + result.stderr
    assert ran_stages(app_dir) == stages
    assert not daemon.manifest.exists()
    assert daemon.leftovers() == []


def test_daemon_output_census_failure_exits_5_without_a_manifest(app_dir, monkeypatch):
    app_dir.census_spec.write_text(json.dumps({"inputs": FIXTURE_INPUTS, "outputs_error": True}))
    daemon = FakeDaemon(app_dir.root, stage="delphi_full_pipeline")
    daemon.apply(monkeypatch)
    result = run_delphi(app_dir)
    assert result.returncode == job_child.EXIT_MANIFEST_UNBUILDABLE
    assert ran_stages(app_dir) == ALL_STAGES
    assert not daemon.manifest.exists()


def test_daemon_input_census_failure_exits_5_before_any_stage(app_dir, monkeypatch):
    app_dir.census_spec.write_text(json.dumps({"inputs_error": True, "outputs": []}))
    daemon = FakeDaemon(app_dir.root, stage="delphi_full_pipeline")
    daemon.apply(monkeypatch)
    result = run_delphi(app_dir)
    assert result.returncode == job_child.EXIT_MANIFEST_UNBUILDABLE
    assert ran_stages(app_dir) == []


@pytest.mark.parametrize(
    "breakage",
    ["missing_attempt", "wrong_stage", "frame_job_mismatch", "frame_zid_mismatch", "math_env_mismatch",
     "manifest_exists", "relative_manifest", "bad_epoch", "run_id_not_uuid", "frame_epoch_number",
     "ack_timeout_nan", "ack_timeout_inf", "ack_timeout_text", "ack_timeout_zero"],
)
def test_daemon_refuses_a_bad_environment_before_any_stage(app_dir, monkeypatch, breakage):
    daemon = FakeDaemon(app_dir.root, stage="delphi_full_pipeline",
                        math_env="python" if breakage == "math_env_mismatch" else None)
    daemon.apply(monkeypatch)
    if breakage == "missing_attempt":
        monkeypatch.delenv("DELPHI_ATTEMPT_ID")
    elif breakage == "wrong_stage":
        monkeypatch.setenv("DELPHI_STAGE", "delphi_narrative")
    elif breakage == "frame_job_mismatch":
        monkeypatch.setenv("DELPHI_JOB_ID", str(uuid.uuid4()))
    elif breakage == "frame_zid_mismatch":
        daemon.frame["zid"] = 2
        daemon.frame_path.write_text(json.dumps(daemon.frame))
    elif breakage == "manifest_exists":
        daemon.manifest.write_text("{}")
    elif breakage == "relative_manifest":
        monkeypatch.setenv("DELPHI_OUTPUT_MANIFEST", "output-manifest.json")
    elif breakage == "bad_epoch":
        monkeypatch.setenv("DELPHI_LEASE_EPOCH", "3.0")
    elif breakage == "run_id_not_uuid":
        monkeypatch.setenv("DELPHI_RUN_ID", "run-1")
        daemon.frame["run_id"] = "run-1"
        daemon.frame_path.write_text(json.dumps(daemon.frame))
    elif breakage == "frame_epoch_number":
        daemon.frame["lease_epoch"] = 3
        daemon.frame_path.write_text(json.dumps(daemon.frame))
    elif breakage.startswith("ack_timeout_"):
        monkeypatch.setenv(job_child.ACK_TIMEOUT_ENV,
                           {"nan": "nan", "inf": "inf", "text": "ten", "zero": "0"}[breakage.rsplit("_", 1)[1]])
    result = run_delphi(app_dir)
    assert result.returncode == job_child.EXIT_JOB_ENV_INVALID, result.stderr
    assert "polis-jobs child: refused:" in result.stderr
    assert ran_stages(app_dir) == []
    if breakage != "manifest_exists":
        assert not daemon.manifest.exists()


# --- the manifest module ----------------------------------------------------

def _ctx(tmp_path, monkeypatch, **kw):
    daemon = FakeDaemon(tmp_path, **kw)
    clear_daemon_env(monkeypatch)
    monkeypatch.delenv("MATH_ENV", raising=False)
    daemon.apply(monkeypatch)
    phases = {"delphi_full_pipeline": ({"run"}, "run")}.get(kw["stage"], ({"submit", "recheck"}, "submit"))
    ctx = job_child.JobContext.from_env(expected_stage=kw["stage"], zid=kw.get("zid", "1"),
                                        allowed_phases=phases[0], default_phase=phases[1])
    return daemon, ctx


def _manifest(ctx, **over):
    args = dict(outcome="succeeded", inputs=dict(FIXTURE_INPUTS, math_env="prod"), outputs=FIXTURE_OUTPUTS,
                models={"embed": None, "topic": None, "narrative": None},
                cost={"llm_tokens_in": None, "llm_tokens_out": None, "provider_batches": None})
    args.update(over)
    return job_child.build_manifest(ctx, **args)


def test_write_manifest_is_atomic_and_leaves_nothing_on_failure(tmp_path, monkeypatch):
    daemon, ctx = _ctx(tmp_path, monkeypatch, stage="delphi_full_pipeline")
    manifest = _manifest(ctx)

    def broken_replace(src, dst):
        raise OSError("generated fixture: rename failed")

    monkeypatch.setattr(job_child.os, "replace", broken_replace)
    with pytest.raises(OSError):
        job_child.write_manifest(ctx, manifest)
    assert not daemon.manifest.exists()
    assert daemon.leftovers() == []

    monkeypatch.undo()
    daemon.apply(monkeypatch)
    digest = job_child.write_manifest(ctx, manifest)
    assert digest == hashlib.sha256(daemon.manifest_bytes()).hexdigest()
    assert daemon.leftovers() == []
    with pytest.raises(job_child.ManifestError):
        job_child.write_manifest(ctx, manifest)  # never overwritten


@pytest.mark.parametrize(
    "mutate",
    [
        lambda m: m.update(schema="polis-jobs.output-manifest/2"),
        lambda m: m.update(extra=1),
        lambda m: m.update(outcome="failed"),
        lambda m: m.update(outcome="parked"),  # parked without recheck_after
        lambda m: m["outputs"].append({"store": "file", "family": "Delphi_PCAResults", "table": "x",
                                       "key_prefix": {"zid": "1"}, "rows": 1}),
        lambda m: m["outputs"].append({"store": "dynamodb", "family": "Delphi_Unknown", "table": "x",
                                       "key_prefix": {"zid": "1"}, "rows": 1}),
        lambda m: m["outputs"].append({"store": "dynamodb", "family": "Delphi_PCAResults",
                                       "table": "Delphi_PCAResults", "rows": 1}),
        lambda m: m["outputs"].append({"store": "dynamodb", "family": "Delphi_PCAResults",
                                       "table": "Delphi_PCAResults", "key_prefix": {"zid": 1}, "rows": 1}),
        lambda m: m["inputs"].update(math_tick="41"),
        lambda m: m["inputs"].pop("vote_hwm"),
        lambda m: m["inputs"].pop("math_modified_ms"),
        lambda m: m["inputs"].__setitem__("source_commit", "abc123"),
        lambda m: m["inputs"].__setitem__("source_commit", "A" * 40),
        lambda m: m["inputs"].__setitem__("target_label", 7),
        lambda m: m["inputs"].__setitem__("math_modified_ms", "1"),
        lambda m: m["cost"].update(provider_batches=[{"provider": "anthropic", "batch_id": ""}]),
        lambda m: m.update(duration_ms=-1),
        lambda m: m.update(job_id="not-a-uuid"),
    ],
)
def test_validate_manifest_rejects(tmp_path, monkeypatch, mutate):
    _, ctx = _ctx(tmp_path, monkeypatch, stage="delphi_full_pipeline")
    manifest = json.loads(json.dumps(_manifest(ctx)))
    mutate(manifest)
    with pytest.raises(job_child.ManifestError):
        job_child.validate_manifest(manifest)


def test_oversized_manifest_is_refused(tmp_path, monkeypatch):
    _, ctx = _ctx(tmp_path, monkeypatch, stage="delphi_full_pipeline")
    keys = [{"rid_section_model": "r" * 200 + str(i), "timestamp": "t"} for i in range(6000)]
    manifest = _manifest(ctx, outputs=[{"store": "dynamodb", "family": "Delphi_NarrativeReports",
                                        "table": "Delphi_NarrativeReports", "keys": keys, "rows": len(keys)}])
    with pytest.raises(job_child.ManifestError, match="limit"):
        job_child.encode_manifest(manifest)


def test_family_names_are_codec_family_ids():
    try:
        codec = importlib.import_module("polismath.delphi_storage.codec")
    except ImportError:
        pytest.skip("the storage codec (P-077 P2-0) is not on this branch")
    assert set(job_child.DYNAMODB_FAMILIES) == set(codec.FAMILIES)


# --- the census against recorded clients ------------------------------------

class FakeTable:
    def __init__(self, partitions, key_attr):
        self.partitions = partitions  # hash value -> list of items
        self.key_attr = key_attr

    def query(self, KeyConditionExpression, Select=None, ProjectionExpression=None, ExclusiveStartKey=None):
        value = KeyConditionExpression.get_expression()["values"][1]
        items = self.partitions.get(value, [])
        start = ExclusiveStartKey or 0
        page = items[start:start + 2]  # pages of two, to exercise LastEvaluatedKey
        resp = {"Count": len(page)} if Select == "COUNT" else {"Items": page, "Count": len(page)}
        if start + 2 < len(items):
            resp["LastEvaluatedKey"] = start + 2
        return resp

    def get_item(self, Key):
        items = self.partitions.get(next(iter(Key.values())), [])
        return {"Item": items[0]} if items else {}


class FakeDynamo:
    def __init__(self, tables):
        self.tables = tables

    def Table(self, name):
        return self.tables.get(name, FakeTable({}, "conversation_id"))


def test_count_full_pipeline_outputs_lists_every_family_with_its_partitions():
    tables = {
        "Delphi_PCAConversationConfig": FakeTable({"7": [{"zid": "7", "latest_math_tick": 41}]}, "zid"),
        "Delphi_PCAResults": FakeTable({"7": [{}]}, "zid"),
        "Delphi_KMeansClusters": FakeTable({"7:41": [{"group_id": 0}, {"group_id": 1}, {"group_id": 2}]}, "zid_tick"),
        "Delphi_CommentRouting": FakeTable({"7:41": [{}] * 5}, "zid_tick"),
        "Delphi_RepresentativeComments": FakeTable({"7:41:0": [{}] * 3, "7:41:2": [{}]}, "zid_tick_gid"),
        "Delphi_CommentEmbeddings": FakeTable({"7": [{}] * 5}, "conversation_id"),
    }
    outputs = census.count_full_pipeline_outputs(7, FakeDynamo(tables))
    by_family = {o["family"]: o for o in outputs}
    assert set(by_family) == set(census.ZID_FAMILIES + census.ZID_TICK_FAMILIES + (census.GROUP_FAMILY,)
                                 + census.CONVERSATION_FAMILIES)
    assert by_family["Delphi_PCAResults"] == {"store": "dynamodb", "family": "Delphi_PCAResults",
                                              "table": "Delphi_PCAResults", "key_prefix": {"zid": "7"}, "rows": 1}
    assert by_family["Delphi_CommentRouting"]["key_prefix"] == {"zid_tick": "7:41"}
    assert by_family["Delphi_CommentRouting"]["rows"] == 5
    assert by_family["Delphi_RepresentativeComments"]["keys"] == [
        {"zid_tick_gid": "7:41:0"}, {"zid_tick_gid": "7:41:1"}, {"zid_tick_gid": "7:41:2"}]
    assert by_family["Delphi_RepresentativeComments"]["rows"] == 4
    assert by_family["Delphi_CommentEmbeddings"]["rows"] == 5
    assert by_family["Delphi_UMAPGraph"]["rows"] == 0


def test_count_without_a_math_tick_lists_tick_families_empty():
    outputs = census.count_full_pipeline_outputs(7, FakeDynamo({}))
    by_family = {o["family"]: o for o in outputs}
    for family in census.ZID_TICK_FAMILIES + (census.GROUP_FAMILY,):
        assert by_family[family]["keys"] == [] and by_family[family]["rows"] == 0


def test_observe_inputs_digest_and_marks():
    calls = []

    def pg(sql, params):
        calls.append((sql.split()[1], params))
        if "FROM comments" in sql:
            return [{"tid": 2, "txt": "b", "mod": 1, "active": True}, {"tid": 1, "txt": "a", "mod": 0, "active": False}]
        if "FROM votes" in sql:
            return [{"hwm": 1700000000123}]
        return [{"math_tick": 41, "caching_tick": 7}]

    got = census.observe_inputs("7", "python", pg)
    lines = "polis-jobs.comment-set/1\n" + "".join(
        f"{t}\t{m}\t{a}\t{hashlib.sha256(x.encode()).hexdigest()}\n" for t, m, a, x in [(1, 0, 0, "a"), (2, 1, 1, "b")])
    assert got == {"math_env": "python", "math_tick": 41, "math_caching_tick": 7,
                   "comment_set_sha256": hashlib.sha256(lines.encode()).hexdigest(), "vote_hwm": 1700000000123,
                   "math_modified_ms": None, "target_label": None, "source_commit": None}
    assert all(p["zid"] == 7 for _, p in calls)

    def broken(sql, params):
        raise RuntimeError("generated fixture: connection refused")

    with pytest.raises(census.CensusError):
        census.observe_inputs("7", "python", broken)


# --- the provider-intent handshake ------------------------------------------

class AckingDaemon(threading.Thread):
    """Watches the attempt directory; records the intent, then writes the acknowledgement."""

    def __init__(self, attempt_dir, events, *, ack=True, wrong_digest=False):
        super().__init__(daemon=True)
        self.attempt_dir = Path(attempt_dir)
        self.events = events
        self.ack = ack
        self.wrong_digest = wrong_digest
        self.intent_bytes = None
        self.stop = threading.Event()

    def run(self):
        intent = self.attempt_dir / job_child.INTENT_FILE
        while not self.stop.is_set():
            if intent.exists():
                self.intent_bytes = intent.read_bytes()
                self.events.append("daemon: intent recorded")
                if self.ack:
                    digest = "0" * 64 if self.wrong_digest else hashlib.sha256(self.intent_bytes).hexdigest()
                    body = json.dumps({"schema": job_child.ACK_SCHEMA, "request_id": "req-1", "intent_sha256": digest})
                    tmp = self.attempt_dir / ".ack.tmp"
                    tmp.write_text(body)
                    os.replace(tmp, self.attempt_dir / job_child.ACK_FILE)
                    self.events.append("daemon: ack written")
                return
            time.sleep(0.01)


def test_handshake_writes_the_intent_and_returns_only_after_the_ack(tmp_path, monkeypatch):
    daemon, ctx = _ctx(tmp_path, monkeypatch, stage="delphi_narrative", phase="submit")
    events = []
    acker = AckingDaemon(daemon.attempt_dir, events)
    acker.start()
    ack = job_child.request_provider_intent(ctx, provider="anthropic", model="m", batch={"request_count": 3},
                                            timeout_seconds=10, poll_seconds=0.01)
    events.append("child: provider call")
    acker.join(5)
    assert events == ["daemon: intent recorded", "daemon: ack written", "child: provider call"]
    assert ack["request_id"] == "req-1"
    intent = json.loads(acker.intent_bytes)
    assert intent["schema"] == job_child.INTENT_SCHEMA
    assert (intent["provider"], intent["model"], intent["batch"]) == ("anthropic", "m", {"request_count": 3})
    assert (intent["job_id"], intent["attempt_id"], intent["lease_epoch"]) == (daemon.job_id, daemon.attempt_id, "3")
    assert acker.intent_bytes == job_child.canonical_bytes(intent)


@pytest.mark.parametrize("ack, wrong_digest", [(False, False), (True, True)])
def test_handshake_refuses_without_a_matching_ack(tmp_path, monkeypatch, ack, wrong_digest):
    daemon, ctx = _ctx(tmp_path, monkeypatch, stage="delphi_narrative", phase="submit")
    acker = AckingDaemon(daemon.attempt_dir, [], ack=ack, wrong_digest=wrong_digest)
    acker.start()
    with pytest.raises(job_child.ProviderIntentRefused):
        job_child.request_provider_intent(ctx, provider="anthropic", model="m", batch={},
                                          timeout_seconds=0.5, poll_seconds=0.01)
    acker.stop.set()


# --- 801 (narrative submit) and 803 (recheck) in daemon mode ----------------

@pytest.fixture(scope="module")
def narrative_modules():
    narrative_dir = DELPHI_ROOT / "umap_narrative"
    with pytest.MonkeyPatch.context() as patch:
        patch.syspath_prepend(str(narrative_dir))
        yield SimpleNamespace(
            submit=importlib.import_module("umap_narrative.801_narrative_report_batch"),
            check=importlib.import_module("umap_narrative.803_check_batch_status"),
        )


class RecordingJobTable:
    def __init__(self):
        self.writes = []

    def update_item(self, **kw):
        self.writes.append(("update_item", kw.get("Key")))
        return {}

    def put_item(self, **kw):
        self.writes.append(("put_item", kw.get("Item", {}).get("job_id")))
        return {}

    def get_item(self, **kw):
        return {"Item": {"job_id": kw["Key"]["job_id"], "batch_id": "b"}}

    table_status = "ACTIVE"


def fake_anthropic_module(events, attempt_dir):
    class Batches:
        def create(self, requests):
            ack_present = attempt_dir is not None and (Path(attempt_dir) / job_child.ACK_FILE).exists()
            events.append(("provider: batch created", ack_present, len(requests)))
            return SimpleNamespace(id="msgbatch_generated_fixture", processing_status="in_progress")

    class Anthropic:
        def __init__(self, api_key):
            self.beta = SimpleNamespace(messages=SimpleNamespace(batches=Batches()))

    errors = {n: type(n, (Exception,), {}) for n in
              ("APIError", "APIConnectionError", "APIResponseValidationError", "APIStatusError")}
    return SimpleNamespace(Anthropic=Anthropic, **errors)


def make_generator(mod, job, job_table):
    gen = object.__new__(mod.BatchReportGenerator)
    gen.conversation_id = "1"
    gen.model = "generated-fixture-model"
    gen.max_batch_size = 5
    gen.job_id = job.job_id if job else "legacy-job"
    gen.report_id = "r1"
    gen.job = job
    gen.provider_refused = False
    gen.submitted_at = None
    gen.dynamodb = SimpleNamespace(Table=lambda name: job_table)

    async def prepare():
        return [{"system": "s", "messages": [{"role": "user", "content": f"c{i}"}], "max_tokens": 8000,
                 "metadata": {"section_name": f"topic_{i}"}} for i in range(3)]

    gen.prepare_batch_requests = prepare
    return gen


def test_801_daemon_submit_records_the_intent_before_the_provider_call(tmp_path, monkeypatch, narrative_modules):
    daemon, ctx = _ctx(tmp_path, monkeypatch, stage="delphi_narrative", phase="submit", report_id="r1")
    events, job_table = [], RecordingJobTable()
    monkeypatch.setitem(sys.modules, "anthropic", fake_anthropic_module(events, daemon.attempt_dir))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "generated-fixture-key")
    acker = AckingDaemon(daemon.attempt_dir, events)
    acker.start()
    gen = make_generator(narrative_modules.submit, ctx, job_table)
    batch_id = asyncio.run(gen.submit_batch())
    acker.join(5)

    assert batch_id == "msgbatch_generated_fixture"
    assert events == ["daemon: intent recorded", "daemon: ack written", ("provider: batch created", True, 3)]
    assert job_table.writes == []  # the daemon owns the job row; nothing writes Delphi_JobQueue
    intent = json.loads(acker.intent_bytes)
    assert intent["batch"]["request_count"] == 3 and intent["batch"]["max_tokens"] == 8000

    ctx.inputs = dict(FIXTURE_INPUTS, math_env="prod")
    with pytest.raises(SystemExit) as exit_info:
        narrative_modules.submit._finish_daemon_job(ctx, gen, batch_id)
    assert exit_info.value.code == 0
    manifest = json.loads(daemon.manifest_bytes())
    job_child.validate_manifest(manifest)
    assert (manifest["stage"], manifest["phase"], manifest["outcome"]) == ("delphi_narrative", "submit", "parked")
    assert manifest["recheck_after"] is not None
    assert manifest["outputs"] == []
    assert manifest["models"]["narrative"] == "generated-fixture-model"
    [batch] = manifest["cost"]["provider_batches"]
    assert (batch["provider"], batch["batch_id"]) == ("anthropic", "msgbatch_generated_fixture")


def test_801_daemon_submit_without_an_ack_never_calls_the_provider(tmp_path, monkeypatch, narrative_modules):
    daemon, ctx = _ctx(tmp_path, monkeypatch, stage="delphi_narrative", phase="submit", report_id="r1")
    events, job_table = [], RecordingJobTable()
    monkeypatch.setitem(sys.modules, "anthropic", fake_anthropic_module(events, daemon.attempt_dir))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "generated-fixture-key")
    ctx.ack_timeout_seconds = 0.3  # parsed from DELPHI_PROVIDER_ACK_TIMEOUT_SECONDS at start
    gen = make_generator(narrative_modules.submit, ctx, job_table)
    assert asyncio.run(gen.submit_batch()) is None
    assert events == [] and gen.provider_refused
    assert job_table.writes == []
    with pytest.raises(SystemExit) as exit_info:
        narrative_modules.submit._finish_daemon_job(ctx, gen, None)
    assert exit_info.value.code == job_child.EXIT_PROVIDER_INTENT_REFUSED
    assert not daemon.manifest.exists()


def test_801_daemon_submit_intent_write_error_is_exit_6(tmp_path, monkeypatch, narrative_modules):
    daemon, ctx = _ctx(tmp_path, monkeypatch, stage="delphi_narrative", phase="submit", report_id="r1")
    events, job_table = [], RecordingJobTable()
    monkeypatch.setitem(sys.modules, "anthropic", fake_anthropic_module(events, daemon.attempt_dir))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "generated-fixture-key")

    def broken_write(path, data):
        raise OSError("generated fixture: disk full")

    monkeypatch.setattr(job_child, "write_atomic", broken_write)
    gen = make_generator(narrative_modules.submit, ctx, job_table)
    assert asyncio.run(gen.submit_batch()) is None
    assert events == [] and gen.provider_refused
    with pytest.raises(SystemExit) as exit_info:
        narrative_modules.submit._finish_daemon_job(ctx, gen, None)
    assert exit_info.value.code == job_child.EXIT_PROVIDER_INTENT_REFUSED


def test_801_legacy_submit_is_unchanged(tmp_path, monkeypatch, narrative_modules):
    clear_daemon_env(monkeypatch)
    events, job_table = [], RecordingJobTable()
    monkeypatch.setitem(sys.modules, "anthropic", fake_anthropic_module(events, None))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "generated-fixture-key")
    gen = make_generator(narrative_modules.submit, None, job_table)
    assert asyncio.run(gen.submit_batch()) == "msgbatch_generated_fixture"
    assert events == [("provider: batch created", False, 3)]
    # The legacy writes: the batch id onto the root row, then the checker row.
    assert [w[0] for w in job_table.writes] == ["update_item", "put_item"]
    assert not any(p.name == job_child.INTENT_FILE for p in tmp_path.rglob("*"))


class FakeResults:
    def __init__(self, status, entries=()):
        self.status = status
        self.entries = entries

    def retrieve(self, batch_id):
        return SimpleNamespace(processing_status=self.status, created_at=None if self.status == "x" else
                               __import__("datetime").datetime(2026, 10, 3, 12, 0, 0))

    def results(self, batch_id):
        return iter(self.entries)


def result_entry(custom_id, text):
    message = SimpleNamespace(model="generated-fixture-model", stop_reason="end_turn",
                              content=[SimpleNamespace(type="text", text=text)],
                              usage=SimpleNamespace(input_tokens=100, output_tokens=20))
    return SimpleNamespace(custom_id=custom_id, result=SimpleNamespace(type="succeeded", message=message))


def make_checker(mod, batches, report_table, job_table):
    def factory():
        checker = object.__new__(mod.BatchStatusChecker)
        checker.anthropic = SimpleNamespace(beta=SimpleNamespace(messages=SimpleNamespace(batches=batches)))
        checker.job_table = job_table
        checker.report_table = report_table
        checker.tokens_in = 0
        checker.tokens_out = 0
        return checker
    return factory


class StoreTable:
    def __init__(self):
        self.items = []

    def put_item(self, Item):
        self.items.append(Item)


def test_803_daemon_recheck_parks_while_the_batch_runs(tmp_path, monkeypatch, narrative_modules):
    daemon, ctx = _ctx(tmp_path, monkeypatch, stage="delphi_narrative", phase="recheck", report_id="r1",
                       batch_id="msgbatch_generated_fixture")
    job_table = RecordingJobTable()
    code = asyncio.run(narrative_modules.check.run_daemon_recheck(
        daemon.job_id, make_checker(narrative_modules.check, FakeResults("in_progress"), StoreTable(), job_table)))
    assert code == 0
    manifest = json.loads(daemon.manifest_bytes())
    job_child.validate_manifest(manifest)
    assert (manifest["phase"], manifest["outcome"]) == ("recheck", "parked")
    assert manifest["cost"]["provider_batches"][0]["batch_id"] == "msgbatch_generated_fixture"
    assert job_table.writes == []


def test_803_daemon_recheck_stores_results_and_lists_their_keys(tmp_path, monkeypatch, narrative_modules):
    daemon, ctx = _ctx(tmp_path, monkeypatch, stage="delphi_narrative", phase="recheck", report_id="r1",
                       batch_id="msgbatch_generated_fixture")
    job_table, store = RecordingJobTable(), StoreTable()
    batches = FakeResults("ended", [result_entry("1_topic_0", "{}"), result_entry("1_topic_1", "{}")])
    code = asyncio.run(narrative_modules.check.run_daemon_recheck(
        daemon.job_id, make_checker(narrative_modules.check, batches, store, job_table)))
    assert code == 0
    manifest = json.loads(daemon.manifest_bytes())
    job_child.validate_manifest(manifest)
    assert manifest["outcome"] == "succeeded"
    [out] = manifest["outputs"]
    assert (out["family"], out["rows"]) == ("Delphi_NarrativeReports", 2)
    assert sorted(k["rid_section_model"] for k in out["keys"]) == [
        "r1#topic_0#generated-fixture-model", "r1#topic_1#generated-fixture-model"]
    assert len(store.items) == 2 and all(i["job_id"] == daemon.job_id for i in store.items)
    assert (manifest["cost"]["llm_tokens_in"], manifest["cost"]["llm_tokens_out"]) == (200, 40)
    assert job_table.writes == []


def test_803_legacy_results_do_not_touch_usage(narrative_modules):
    store, job_table = StoreTable(), RecordingJobTable()
    checker = make_checker(narrative_modules.check, FakeResults("ended", [result_entry("1_topic_0", "{}")]),
                           store, job_table)()
    checker.count_usage = False
    assert asyncio.run(checker.process_batch_results({"job_id": "legacy", "batch_id": "b", "report_id": "r1"}))
    assert (checker.tokens_in, checker.tokens_out) == (0, 0)
    assert len(store.items) == 1 and job_table.writes[0][0] == "update_item"


@pytest.mark.parametrize("status", ["failed", "cancelled", "unknown"])
def test_803_daemon_recheck_failure_exits_1_without_a_manifest(tmp_path, monkeypatch, narrative_modules, status):
    daemon, ctx = _ctx(tmp_path, monkeypatch, stage="delphi_narrative", phase="recheck", report_id="r1",
                       batch_id="msgbatch_generated_fixture")
    code = asyncio.run(narrative_modules.check.run_daemon_recheck(
        daemon.job_id, make_checker(narrative_modules.check, FakeResults(status), StoreTable(), RecordingJobTable())))
    assert code == 1
    assert not daemon.manifest.exists()


def test_803_daemon_recheck_refuses_without_a_batch_id(tmp_path, monkeypatch, narrative_modules):
    daemon, ctx = _ctx(tmp_path, monkeypatch, stage="delphi_narrative", phase="recheck", report_id="r1")
    with pytest.raises(SystemExit) as exit_info:
        asyncio.run(narrative_modules.check.run_daemon_recheck(daemon.job_id))
    assert exit_info.value.code == job_child.EXIT_JOB_ENV_INVALID
