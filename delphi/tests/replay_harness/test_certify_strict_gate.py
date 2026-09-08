"""Negative controls: a passing synthetic battery must fail when coverage breaks.

Producers are local fakes, but schedule resolution, store validation, cache
manifests, numeric comparison, run manifest and CLI exit paths are real.
"""
import importlib.util
import json
import subprocess
from pathlib import Path

import pytest
from click.testing import CliRunner

from polismath.replay import certify as cert, schedule as sched
from polismath.replay.driver import run_replay
from polismath.replay.types import ReplayDataset

EMPTY = {"n": 0, "n-cmts": 0, "tids": [], "in-conv": []}


@pytest.fixture
def battery(tmp_path, monkeypatch):
    ds = ReplayDataset.build([(10, 1, 1, 1), (20, 2, 1, -1)])
    votes = tmp_path / "synthetic-votes.csv"
    votes.write_text("timestamp,participant,comment,vote\n10,1,1,1\n20,2,1,-1\n")
    monkeypatch.setattr(cert, "dataset_available", lambda name: name == "synthetic")
    monkeypatch.setattr(cert, "votes_csv_path", lambda name: votes)
    monkeypatch.setattr(cert.real_data, "load_export_votes", lambda name: ds)
    monkeypatch.setattr(cert, "_clj_source_hashes", lambda: ("clj-source", "math-source"))
    monkeypatch.setattr(cert, "_engine_tree_hash_cached", lambda: "python-source")
    entry = cert.parse_battery_entry({"dataset": "synthetic", "preset": "every-vote"})
    state = {"mutation": None, "calls": 0}
    root = tmp_path / "recordings"

    def produce(spec_path, engine):
        state["calls"] += 1
        manifest = json.loads((root / "run_manifest.json").read_text())
        assert manifest["verdict"] == "INCONCLUSIVE"
        assert len(manifest["inventory"]) >= 2  # written BEFORE first producer
        spec = sched.ScheduleSpec.from_json_file(spec_path)
        steps = sched.slice_schedule(ds, spec)
        out = root / spec.dataset / spec.schedule_id / engine
        out.mkdir(parents=True, exist_ok=True)
        if state["mutation"] == "timeout":
            raise subprocess.TimeoutExpired("synthetic-producer", 1)
        if state["mutation"] == "producer-failure":
            return subprocess.CompletedProcess([], 1, "", "synthetic failure")
        for step in steps:
            meta = {"index": step.index, "prev_slot": step.prev_slot,
                    "cut_slot": step.cut_slot, "batch_size": len(step.vote_events),
                    "cut_time_ms": step.cut_time_ms}
            blob = EMPTY if step.cut_slot == 0 else {
                "n": step.cut_slot, "n-cmts": 1, "tids": [1], "in-conv": [1]}
            stem = f"step-{step.index:03d}"
            if engine == "clj":
                (out / (stem + ".blob.json")).write_text(json.dumps(blob))
                (out / (stem + ".meta.json")).write_text(json.dumps(meta))
            else:
                (out / (stem + ".json")).write_text(json.dumps({**meta, "blob": blob}))
        mutation = state["mutation"]
        if mutation == "empty-both" or (mutation == "empty-py" and engine == "py"):
            for path in out.glob("step-*.json"):
                path.unlink()
        if engine == "py":
            first = out / "step-000.json"
            if mutation == "remove":
                (out / "step-001.json").unlink()
            elif mutation == "duplicate":
                (out / "step-002.json").write_text(first.read_text())
            elif mutation == "identity":
                payload = json.loads(first.read_text()); payload["cut_slot"] = 999
                first.write_text(json.dumps(payload))
            elif mutation == "duplicate-index":
                payload = json.loads((out / "step-001.json").read_text()); payload["index"] = 0
                (out / "step-001.json").write_text(json.dumps(payload))
            elif mutation == "malformed-step":
                first.write_text("{")
            elif mutation == "empty-blob":
                payload = json.loads(first.read_text()); payload["blob"] = {}
                first.write_text(json.dumps(payload))
            elif mutation == "wrong-empty":
                payload = json.loads(first.read_text()); payload["blob"]["n"] = 1
                first.write_text(json.dumps(payload))
        return subprocess.CompletedProcess([], 0, "", "")

    monkeypatch.setattr(cert, "run_clj_driver", lambda spec, votes, **kw: produce(spec, "clj"))
    monkeypatch.setattr(cert, "run_py_driver", lambda spec, **kw: produce(spec, "py"))

    def run(entries=None, **kwargs):
        return cert.run_battery(entries if entries is not None else [entry], root=root,
                                ledger_path=tmp_path / "ledger.json", **kwargs)
    return entry, state, root, ds, run


def assert_pass(report):
    assert report["verdict"] == "PASS", report
    assert cert.battery_exit_code(report, strict=True) == 0


@pytest.mark.parametrize("mutation,stage", [
    ("remove", "checkpoint-inventory"), ("duplicate", "checkpoint-inventory"),
    ("empty-both", "checkpoint-inventory"), ("empty-py", "checkpoint-inventory"),
    ("identity", "checkpoint-identity"), ("duplicate-index", "checkpoint-identity"),
    ("malformed-step", "setup"), ("empty-blob", "checkpoint-schema"),
    ("timeout", "setup"), ("producer-failure", "clj-driver"),
])
def test_damaged_producer_turns_pass_to_fail(battery, mutation, stage):
    entry, state, root, ds, run = battery
    assert_pass(run())
    state["mutation"] = mutation
    report = run(refresh_clj=True, refresh_py=True)
    assert report["verdict"] == "FAIL"
    assert report["battery"][0]["stage"] == stage
    assert cert.battery_exit_code(report, strict=True) == 1
    manifest = json.loads((root / "run_manifest.json").read_text())
    assert manifest["entries"][0]["status"] == "FAIL"
    assert manifest["finished_at"] is not None


def test_inventory_exact_and_cached_pass(battery):
    entry, state, root, ds, run = battery
    report = run(); assert_pass(report)
    inventory = report["inventory"]
    assert [i["engine"] for i in inventory] == ["clj", "py"]
    assert all([c["cut_slot"] for c in i["checkpoints"]] == [1, 2] for i in inventory)
    assert_pass(run())
    assert state["calls"] == 2


@pytest.mark.parametrize("mutation,stage", [("hash", "recording-integrity"),
                                            ("json", "recording-manifest"),
                                            ("unknown-field", "recording-manifest")])
def test_corrupt_cached_recording_rejected(battery, mutation, stage):
    entry, state, root, ds, run = battery
    assert_pass(run())
    py = root / entry.dataset / entry.schedule_id / "py"
    if mutation == "hash":
        (py / "step-000.json").write_text("{}")
    elif mutation == "json":
        (py / "cache_manifest.json").write_text("{")
    else:
        p = py / "cache_manifest.json"; d = json.loads(p.read_text()); d["typo"] = True
        p.write_text(json.dumps(d))
    report = run()
    assert report["verdict"] == "FAIL"
    assert report["battery"][0]["stage"] == stage


def test_missing_dataset_required_fails_optional_is_inconclusive(battery, monkeypatch):
    entry, state, root, ds, run = battery
    assert_pass(run())
    monkeypatch.setattr(cert, "dataset_available", lambda name: False)
    report = run()
    assert report["verdict"] == "FAIL"
    assert report["battery"][0]["stage"] == "dataset-unavailable"
    optional = cert.parse_battery_entry({"dataset": "synthetic", "preset": "every-vote", "optional": True})
    report = run([optional])
    assert report["verdict"] == "INCONCLUSIVE"
    assert report["battery"][0]["verdict"] == "SKIPPED"
    assert cert.battery_exit_code(report, strict=True) == 1


def test_empty_and_duplicate_batteries_rejected_before_producers(battery):
    entry, state, root, ds, run = battery
    for entries in ([], [entry, entry]):
        report = run(entries)
        assert report["verdict"] == "FAIL"
        assert report["configuration_errors"]
    assert state["calls"] == 0


def test_only_is_partial_even_if_filter_selects_entire_battery(battery):
    entry, state, root, ds, run = battery
    assert_pass(run())
    report = run(only="synthetic")
    assert report["partial"] is True
    assert report["verdict"] == "INCONCLUSIVE"
    assert cert.battery_exit_code(report, strict=True) == 1
    assert "PARTIAL RUN, NOT A GATE" in "\n".join(cert.render_run_lines(report))
    assert run(only="absent")["verdict"] == "FAIL"


def make_schedule(tmp_path, at, **extra):
    path = tmp_path / "schedule.json"
    path.write_text(json.dumps({"dataset": "synthetic", "schedule_id": "custom",
                               "cuts": {"mode": "vote-count", "at": at}, **extra}))
    return cert.parse_battery_entry({"dataset": "synthetic", "schedule": str(path)})


def test_zero_vote_requires_explicit_checkpoint_and_empty_contract(battery, tmp_path):
    entry, state, root, ds, run = battery
    ds.votes.clear()
    explicit = make_schedule(tmp_path, [0], cuts={"mode": "vote-count", "at": [0],
                                                "empty_checkpoint": True}, empty_output=EMPTY)
    report = run([explicit]); assert_pass(report)
    assert report["inventory"][0]["checkpoints"] == [{
        "index": 0, "prev_slot": 0, "cut_slot": 0, "batch_size": 0, "cut_time_ms": 0}]
    for at in ([], ["end"]):
        missing = make_schedule(tmp_path, at)
        report = run([missing])
        assert report["verdict"] == "FAIL"
        assert "nonzero expected" in report["battery"][0]["reason"] or "empty_checkpoint" in report["battery"][0]["reason"]
    no_contract = make_schedule(tmp_path, [0], cuts={"mode": "vote-count", "at": [0], "empty_checkpoint": True})
    assert "empty_output" in run([no_contract])["battery"][0]["reason"]


def test_zero_checkpoint_checks_declared_output(battery, tmp_path):
    entry, state, root, ds, run = battery
    ds.votes.clear()
    entry = make_schedule(tmp_path, [0], cuts={"mode": "vote-count", "at": [0], "empty_checkpoint": True}, empty_output=EMPTY)
    assert_pass(run([entry]))
    state["mutation"] = "wrong-empty"
    report = run([entry], refresh_py=True)
    assert report["battery"][0]["stage"] == "empty-output"


def test_real_python_driver_records_zero_compute():
    spec = sched.ScheduleSpec("synthetic", "empty", {"mode": "vote-count", "at": [0], "empty_checkpoint": True}, empty_output=EMPTY)
    records = run_replay(ReplayDataset.build([]), spec)
    assert len(records) == 1
    assert records[0].cut_slot == 0 and records[0].batch_size == 0
    projected = cert.project_acceptance(records[0].blob)
    assert {k: projected[k] for k in EMPTY} == EMPTY


@pytest.mark.parametrize("cuts,reason", [
    ({"mode": "vote-count", "at": [1, 1, 2]}, "duplicate"),
    ({"mode": "vote-count", "at": [2, 1]}, "strictly increasing"),
    ({"mode": "vote-count", "at": [0, 2]}, "empty_checkpoint"),
])
def test_schedule_never_silently_discards_cuts(cuts, reason):
    ds = ReplayDataset.build([(10, 1, 1, 1), (20, 2, 1, -1)])
    with pytest.raises(ValueError, match=reason):
        sched.resolve_cut_slots(ds, cuts)


def test_prefix_requires_full_stream_companion(battery, tmp_path):
    entry, state, root, ds, run = battery
    short = make_schedule(tmp_path, [1])
    assert "stream end" in run([short])["battery"][0]["reason"]
    prefix = make_schedule(tmp_path, [1], coverage="prefix-diagnostic")
    assert "companion" in run([prefix])["battery"][0]["reason"]
    assert_pass(run([prefix, entry]))


def cli_module():
    path = Path(cert.__file__).parents[2] / "scripts" / "certify.py"
    spec = importlib.util.spec_from_file_location("strict_certify_cli", path)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


def test_cli_strict_partial_fails_with_manifest(battery, monkeypatch):
    entry, state, root, ds, run = battery
    module = cli_module()
    monkeypatch.setattr(module.cert, "load_battery", lambda path: [entry])
    monkeypatch.setattr(module.cert, "default_ledger_path", lambda: root / "ledger.json")
    result = CliRunner().invoke(module.cli, ["run", "--strict", "--root", str(root), "--only", "synthetic"])
    assert result.exit_code == 1, result.output
    assert "PARTIAL RUN, NOT A GATE" in result.output
    manifest = json.loads((root / "run_manifest.json").read_text())
    assert manifest["partial"] and manifest["verdict"] == "INCONCLUSIVE"


@pytest.mark.parametrize("config", [[], {}, [{"dataset": "synthetic", "preset": "single-cut", "typo": True}], "{"])
def test_cli_malformed_battery_writes_failure_manifest(tmp_path, config):
    path = tmp_path / "battery.json"
    path.write_text(config if isinstance(config, str) else json.dumps(config))
    root = tmp_path / "out"
    result = CliRunner().invoke(cli_module().cli, ["run", "--strict", "--battery", str(path), "--root", str(root)])
    assert result.exit_code == 1
    assert json.loads((root / "run_manifest.json").read_text())["verdict"] == "FAIL"


@pytest.mark.parametrize("counts", [(0, 0), (1, 0), (1, 2)])
def test_standalone_compare_and_focus_reject_empty_or_unequal(tmp_path, counts):
    rec = tmp_path / "synthetic" / "single"
    for engine, count in zip(("clj", "py"), counts):
        directory = rec / engine; directory.mkdir(parents=True)
        for index in range(count):
            suffix = ".blob.json" if engine == "clj" else ".json"
            payload = EMPTY if engine == "clj" else {"index": index, "blob": EMPTY}
            (directory / f"step-{index:03d}{suffix}").write_text(json.dumps(payload))
    with pytest.raises(cert.CertifyError, match="nonempty|steps"):
        cert.compare_recording_pair(rec / "clj", rec / "py", cache_root=tmp_path)
    assert cert.run_focus("synthetic", "single", root=tmp_path, ledger_path=tmp_path / "ledger.json")["verdict"] == "ERROR"


def test_missing_manifest_version_is_malformed(battery):
    entry, state, root, ds, run = battery
    assert_pass(run())
    path = root / entry.dataset / entry.schedule_id / "py" / "cache_manifest.json"
    path.write_text('{}')
    report = run()
    assert report["verdict"] == "FAIL"
    assert report["battery"][0]["stage"] == "recording-manifest"


def test_empty_acceptance_blobs_do_not_match(tmp_path):
    clj, py = tmp_path / "clj", tmp_path / "py"
    clj.mkdir(); py.mkdir()
    (clj / "step-000.blob.json").write_text('{}')
    (py / "step-000.json").write_text('{"index":0,"blob":{}}')
    with pytest.raises(cert.CertifyError, match="empty acceptance blob"):
        cert.compare_recording_pair(clj, py, cache_root=tmp_path)


def test_only_keeps_full_inventory_and_marks_unselected_entries(battery):
    entry, state, root, ds, run = battery
    companion = cert.parse_battery_entry({"dataset": "synthetic", "preset": "single-cut"})
    report = run([entry, companion], only=f"synthetic:{entry.schedule_id}")
    assert len(report["inventory"]) == 4
    manifest = json.loads((root / "run_manifest.json").read_text())
    assert [e["status"] for e in manifest["entries"]] == ["PASS", "INCONCLUSIVE"]
    assert manifest["verdict"] == "INCONCLUSIVE"
    assert state["calls"] == 2


def test_unknown_schedule_and_cut_fields_fail_before_producers(battery, tmp_path):
    entry, state, root, ds, run = battery
    for extra in ({"typo": True}, {"cuts": {"mode": "vote-count", "at": [2], "typo": True}}):
        entry = make_schedule(tmp_path, [2], **extra)
        report = run([entry])
        assert report["verdict"] == "FAIL"
        assert "unknown" in report["battery"][0]["reason"]
    assert state["calls"] == 0
