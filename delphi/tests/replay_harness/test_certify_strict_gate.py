"""Negative controls: a passing synthetic battery must fail when coverage breaks.

Producers are local fakes, but schedule resolution, store validation, cache
manifests, numeric comparison, run manifest and CLI exit paths are real.
"""
import hashlib
import importlib.util
import json
import subprocess
from pathlib import Path

import pytest
from click.testing import CliRunner

from polismath.replay import certify as cert, schedule as sched
from polismath.replay.crosslang import PREP_MAIN_KEYS
from polismath.replay.driver import run_replay
from polismath.replay.types import ReplayDataset

EMPTY = {"n": 0, "n-cmts": 0, "tids": [], "in-conv": []}

#: Blob mutations applied IDENTICALLY to both engines' checkpoints (P-022 B1
#: review, P1). Each produces byte-identical malformed recordings, so the
#: acceptance projection stays nonempty and the two per-engine hashes are
#: EQUAL — the hash-first shortcut used to short-circuit them to MATCH and
#: certify PASS with strict exit 0. Every one of these must now FAIL at
#: ``checkpoint-schema`` with the offending field named. Values are
#: ``(mutate, field_named_in_reason)``.
PAIRED_MALFORMED = {
    "nan-count": (lambda b: {**b, "n": float("nan")}, "n"),
    "inf-count": (lambda b: {**b, "n": float("-inf")}, "n"),
    "string-count": (lambda b: {**b, "n": "invalid-count"}, "n"),
    "float-count": (lambda b: {**b, "n": 1.5}, "n"),
    "negative-count": (lambda b: {**b, "n": -1}, "n"),
    "missing-count": (lambda b: {k: v for k, v in b.items() if k != "n"}, "n"),
    "string-tid": (lambda b: {**b, "tids": ["1"]}, "tids"),
    "scalar-tids": (lambda b: {**b, "tids": 1}, "tids"),
    "container-zid": (lambda b: {**b, "zid": {"nope": 1}}, "zid"),
    "list-pca": (lambda b: {**b, "pca": [1, 2]}, "pca"),
    "nested-nan": (lambda b: {**b, "pca": {"center": [0.0, float("nan")]}}, "pca.center[1]"),
    "nested-inf": (lambda b: {**b, "base-clusters": {"x": [float("inf")]}}, "base-clusters.x[0]"),
}


def latest_manifest(root):
    """Read the run manifest the ``latest`` pointer names. Manifests are keyed
    by run id so a later run cannot overwrite an earlier one, so there is no
    fixed path to read — everything goes through the pointer."""
    pointer = json.loads((Path(root) / cert.RUN_MANIFEST_LATEST).read_text())
    return json.loads(Path(pointer["run_manifest"]).read_text())


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
        manifest = latest_manifest(root)
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
            # Paired malformation: BOTH engines emit the same broken value, so
            # the recordings are byte-identical and hash equal.
            paired = PAIRED_MALFORMED.get(state["mutation"])
            if paired is not None:
                blob = paired[0](blob)
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
            elif mutation == "py-only-nan":
                # Asymmetric control: only py is malformed, so the hashes
                # DIFFER — validation must still name py, not fall through to
                # the comparer and report a mere divergence.
                payload = json.loads(first.read_text())
                payload["blob"]["n"] = float("nan")
                first.write_text(json.dumps(payload))
            elif mutation == "absent-empty":
                # The real Clojure/Python empty-blob divergence in miniature: the
                # contract's key is not wrong, it is simply not emitted at all.
                payload = json.loads(first.read_text()); payload["blob"].pop("n")
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
    manifest = latest_manifest(root)
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
    # The message must name what actually differs. pc-zerovote-01 fails here on
    # a genuine, unreconciled engine output contract, and a bare "violates
    # empty_output" would read as a harness regression instead.
    reason = report["battery"][0]["reason"]
    assert "empty_output contract" in reason and "wrong values {'n': 1}" in reason

    state["mutation"] = "absent-empty"
    report = run([entry], refresh_py=True)
    assert report["battery"][0]["stage"] == "empty-output"
    assert "absent keys ['n']" in report["battery"][0]["reason"]


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
    manifest = latest_manifest(root)
    assert manifest["partial"] and manifest["verdict"] == "INCONCLUSIVE"


@pytest.mark.parametrize("config", [[], {}, [{"dataset": "synthetic", "preset": "single-cut", "typo": True}], "{"])
def test_cli_malformed_battery_writes_failure_manifest(tmp_path, config):
    path = tmp_path / "battery.json"
    path.write_text(config if isinstance(config, str) else json.dumps(config))
    root = tmp_path / "out"
    result = CliRunner().invoke(cli_module().cli, ["run", "--strict", "--battery", str(path), "--root", str(root)])
    assert result.exit_code == 1
    assert latest_manifest(root)["verdict"] == "FAIL"


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
    manifest = latest_manifest(root)
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


# ---------------------------------------------------------------------------
# P-022 §B negative controls for the remaining INPUT classes: a change to only
# the comments, only the restart seam, or only a vote's polarity must reach the
# gate. Each is carried by a recording-cache key (comments CSV sha256, schedule
# hash via restart_after, votes CSV sha256) — the mechanism exists, but nothing
# asserted it, so a loosened key would silently re-certify the previous run's
# recordings and report its stale MATCH.
# ---------------------------------------------------------------------------
def _stamp(*parts):
    """A small integer fingerprint of the inputs, carried in an acceptance field
    so a stale recording is visibly stale rather than merely old."""
    return 1 + int(hashlib.sha256(repr(parts).encode()).hexdigest()[:8], 16) % 9973


@pytest.fixture
def input_change(tmp_path, monkeypatch):
    """A green battery whose fake producers stamp every input into the recorded
    blob. Returns ``(run, state, root, blob_stamps)``."""
    votes = tmp_path / "synthetic-votes.csv"
    comments = tmp_path / "synthetic-comments.csv"
    schedule = tmp_path / "input-change.json"
    root = tmp_path / "recordings"
    state = {"calls": 0, "polarity": -1, "restart_after": 0}
    comments.write_text("tid,mod\n1,1\n")

    def write_inputs():
        votes.write_text("timestamp,participant,comment,vote\n"
                         f"10,1,1,1\n20,2,1,{state['polarity']}\n30,3,1,1\n40,4,1,1\n")
        schedule.write_text(json.dumps({
            "dataset": "synthetic", "schedule_id": "input-change",
            "cuts": {"mode": "vote-count", "at": [2, 3, 4]},
            "moderation": [{"t_ms": 15, "tid": 1, "mod": 1}],
            "restart_after": state["restart_after"], "coverage": "full-stream",
        }))

    def dataset(_name=None):
        return ReplayDataset.build([(10, 1, 1, 1), (20, 2, 1, state["polarity"]),
                                    (30, 3, 1, 1), (40, 4, 1, 1)])

    write_inputs()
    monkeypatch.setattr(cert, "dataset_available", lambda name: name == "synthetic")
    monkeypatch.setattr(cert, "votes_csv_path", lambda name: votes)
    monkeypatch.setattr(cert, "comments_csv_path", lambda name: comments)
    monkeypatch.setattr(cert.real_data, "load_export_votes", dataset)
    monkeypatch.setattr(cert, "_clj_source_hashes", lambda: ("clj-source", "math-source"))
    monkeypatch.setattr(cert, "_engine_tree_hash_cached", lambda: "python-source")

    def produce(spec_path, engine):
        state["calls"] += 1
        spec = sched.ScheduleSpec.from_json_file(spec_path)
        steps = sched.slice_schedule(dataset(), spec)
        out = root / spec.dataset / spec.schedule_id / engine
        out.mkdir(parents=True, exist_ok=True)
        stamp = _stamp(comments.read_text(), spec.restart_after, state["polarity"])
        for step in steps:
            meta = {"index": step.index, "prev_slot": step.prev_slot,
                    "cut_slot": step.cut_slot, "batch_size": len(step.vote_events),
                    "cut_time_ms": step.cut_time_ms}
            blob = {"n": step.cut_slot, "n-cmts": stamp, "tids": [1], "in-conv": [1]}
            stem = f"step-{step.index:03d}"
            if engine == "clj":
                (out / (stem + ".blob.json")).write_text(json.dumps(blob))
                (out / (stem + ".meta.json")).write_text(json.dumps(meta))
            else:
                (out / (stem + ".json")).write_text(json.dumps({**meta, "blob": blob}))
        return subprocess.CompletedProcess([], 0, "", "")

    monkeypatch.setattr(cert, "run_clj_driver", lambda spec, v, **kw: produce(spec, "clj"))
    monkeypatch.setattr(cert, "run_py_driver", lambda spec, **kw: produce(spec, "py"))

    def run():
        entry = cert.parse_battery_entry({"dataset": "synthetic", "schedule": str(schedule)})
        return cert.run_battery([entry], root=root, ledger_path=tmp_path / "ledger.json")

    def stamps():
        recorded = sorted((root / "synthetic").rglob("step-*.blob.json"))
        assert recorded, "no clj checkpoints recorded"
        return {json.loads(p.read_text())["n-cmts"] for p in recorded}

    return run, state, root, comments, write_inputs, stamps


@pytest.mark.parametrize("changed", ["comments", "restart", "polarity"])
def test_single_input_change_cannot_be_served_from_cache(input_change, changed):
    run, state, root, comments, write_inputs, stamps = input_change
    assert_pass(run())
    before = stamps()
    assert len(before) == 1

    # A re-run with IDENTICAL inputs is served from cache — this is the control
    # that makes the assertions below meaningful rather than trivially true.
    assert_pass(run())
    assert state["calls"] == 2
    assert stamps() == before

    if changed == "comments":
        comments.write_text("tid,mod\n1,-1\n")   # moderation source only
    elif changed == "restart":
        state["restart_after"] = 1               # schedule seam only
    else:
        state["polarity"] = 1                    # one vote's polarity only
    write_inputs()

    report = run()
    assert_pass(report)
    # Both engines re-recorded, and the recordings describe the NEW inputs: a
    # cache key blind to this change would leave calls at 2 and stamps stale.
    assert state["calls"] == 4, f"{changed}-only change did not invalidate the cache"
    assert stamps() != before, f"{changed}-only change left a stale recording in place"
    entry = latest_manifest(root)["entries"][0]
    assert entry["cache"] == {"clj": "miss", "py": "miss"}


# ---------------------------------------------------------------------------
# P-022 B1 review, P1 — a nonempty projection is not a valid checkpoint.
#
# Before this, `validate_recording_inventory` only asked for a nonempty
# acceptance projection and `compare_recording_pair` short-circuited equal
# per-engine hashes to MATCH before anything read the values. Two producers
# emitting the SAME malformed blob (`{"n": NaN}`, `{"n": "invalid-count"}`)
# therefore produced a complete run manifest with verdict PASS and strict exit
# 0. These controls are red until raw validation runs on every checkpoint of
# both engines, ahead of projection, hashing and any cached verdict.
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("mutation", sorted(PAIRED_MALFORMED))
def test_identical_malformed_blobs_on_both_engines_fail(battery, mutation):
    entry, state, root, ds, run = battery
    assert_pass(run())
    state["mutation"] = mutation
    report = run(refresh_clj=True, refresh_py=True)
    assert report["verdict"] == "FAIL", report
    result = report["battery"][0]
    assert result["stage"] == "checkpoint-schema", result
    # The reason must NAME the offending field, not just say "schema".
    assert PAIRED_MALFORMED[mutation][1] in result["reason"], result["reason"]
    assert cert.battery_exit_code(report, strict=True) == 1
    assert latest_manifest(root)["entries"][0]["status"] == "FAIL"


def test_paired_malformed_blobs_would_have_hash_matched(battery):
    """Control that makes the parametrized failures above non-vacuous: the two
    engines' malformed recordings really are identical, their acceptance
    projections really are nonempty, and their acceptance hashes really are
    equal — i.e. every pre-fix admission criterion is still satisfied and only
    the new raw validation rejects them."""
    entry, state, root, ds, run = battery
    assert_pass(run())
    state["mutation"] = "nan-count"
    assert run(refresh_clj=True, refresh_py=True)["verdict"] == "FAIL"

    rec = root / entry.dataset / entry.schedule_id
    clj = json.loads((rec / "clj" / "step-000.blob.json").read_text())
    py = json.loads((rec / "py" / "step-000.json").read_text())["blob"]
    assert clj == py or (repr(clj) == repr(py))  # NaN != NaN, compare by repr
    assert cert.project_acceptance(clj) and cert.project_acceptance(py)
    assert cert._canonical_hash(cert.project_acceptance(clj)) == \
        cert._canonical_hash(cert.project_acceptance(py))


@pytest.mark.parametrize("mutation", ["nan-count", "string-count", "inf-count", "string-tid"])
def test_compare_recording_pair_rejects_identical_malformed_blobs(tmp_path, mutation):
    """The standalone comparer entry point must reject them too — it is the
    function that owns the hash short-circuit."""
    blob = PAIRED_MALFORMED[mutation][0](
        {"n": 2, "n-cmts": 1, "tids": [1], "in-conv": [1]})
    clj, py = tmp_path / "clj", tmp_path / "py"
    clj.mkdir(); py.mkdir()
    (clj / "step-000.blob.json").write_text(json.dumps(blob))
    (py / "step-000.json").write_text(json.dumps({"index": 0, "blob": blob}))
    with pytest.raises(cert.CertifyError) as excinfo:
        cert.compare_recording_pair(clj, py, cache_root=tmp_path)
    assert excinfo.value.stage == "checkpoint-schema"
    assert PAIRED_MALFORMED[mutation][1] in str(excinfo.value)


def test_malformed_blob_fails_even_when_the_other_engine_is_valid(battery):
    """Symmetry: validation is per engine, so a malformed blob fails whatever
    the other engine emitted — a valid partner cannot rescue it."""
    entry, state, root, ds, run = battery
    assert_pass(run())
    state["mutation"] = "py-only-nan"
    report = run(refresh_clj=True, refresh_py=True)
    assert report["verdict"] == "FAIL"
    assert report["battery"][0]["stage"] == "checkpoint-schema"
    assert "py:" in report["battery"][0]["reason"]


def test_cached_recordings_are_revalidated(battery):
    """Validation must run on recording-cache HITS too: a cached malformed
    recording is exactly the stale-MATCH failure mode the gate exists to stop."""
    entry, state, root, ds, run = battery
    assert_pass(run())
    rec = root / entry.dataset / entry.schedule_id
    for path in (rec / "clj" / "step-000.blob.json", rec / "py" / "step-000.json"):
        payload = json.loads(path.read_text())
        target = payload if path.name.endswith(".blob.json") else payload["blob"]
        target["n"] = float("nan")
        path.write_text(json.dumps(payload))
    # No refresh: both manifests are re-validated against the (now tampered)
    # files, so this fails at the integrity check or the schema check — never
    # a served MATCH.
    report = run()
    assert report["verdict"] == "FAIL", report
    assert report["battery"][0]["stage"] in ("recording-integrity", "checkpoint-schema")


# ---------------------------------------------------------------------------
# validate_checkpoint_blob directly.
# ---------------------------------------------------------------------------
def test_validate_checkpoint_blob_accepts_the_committed_real_blobs():
    """Ground the contract in reality: every committed math blob (the shape the
    engines actually emit) must validate clean, or the gate is over-strict."""
    real_dir = Path(cert.__file__).resolve().parents[2] / "real_data"
    blobs = sorted(real_dir.glob("*/*math_blob*.json"))
    assert blobs, "no committed real math blobs to validate against"
    for path in blobs:
        cert.validate_checkpoint_blob(json.loads(path.read_text()), path.name)


@pytest.mark.parametrize("blob,needle", [
    ({"n": 1, "n-cmts": 1, "tids": [1]}, "in-conv"),
    ({"n": 1, "n-cmts": True, "tids": [], "in-conv": []}, "n-cmts"),
    ({"n": 1, "n-cmts": 1, "tids": [], "in-conv": [], "lastVoteTimestamp": "x"},
     "lastVoteTimestamp"),
    ({"n": 1, "n-cmts": 1, "tids": [], "in-conv": [], "group-clusters": {}},
     "group-clusters"),
    ({"n": 1, "n-cmts": 1, "tids": [], "in-conv": [], "repness": []}, "repness"),
    ("not-an-object", "JSON object"),
])
def test_validate_checkpoint_blob_rejects_and_names_the_field(blob, needle):
    with pytest.raises(cert.CertifyError) as excinfo:
        cert.validate_checkpoint_blob(blob, "clj: step-000")
    assert excinfo.value.stage == "checkpoint-schema"
    assert needle in str(excinfo.value)
    assert "clj: step-000" in str(excinfo.value)


def test_validate_checkpoint_blob_accepts_nullable_and_snake_spellings():
    cert.validate_checkpoint_blob(
        {"n": 0, "n_cmts": 0, "tids": [], "in_conv": [], "mod-in": None,
         "mod-out": None, "meta-tids": None, "lastModTimestamp": None,
         "zid": "synthetic"},
        "py: step-000")


def test_validate_checkpoint_blob_require_keys_false_still_checks_values():
    cert.validate_checkpoint_blob({"n": 0}, "clj: step-000", require_keys=False)
    with pytest.raises(cert.CertifyError, match="'n'"):
        cert.validate_checkpoint_blob(
            {"n": float("nan")}, "clj: step-000", require_keys=False)


def test_checkpoint_contract_keys_come_from_the_crosslang_whitelist():
    """The contract must not invent field names: every key it constrains is one
    crosslang's canonicalization whitelist actually emits."""
    named = set(cert._REQUIRED_CHECKPOINT_KEYS) | set(cert._COUNT_CHECKPOINT_KEYS) \
        | set(cert._TIMESTAMP_CHECKPOINT_KEYS) | set(cert._ID_LIST_CHECKPOINT_KEYS) \
        | set(cert._MAPPING_CHECKPOINT_KEYS) | set(cert._SEQUENCE_CHECKPOINT_KEYS) \
        | set(cert._ID_SCALAR_CHECKPOINT_KEYS)
    assert named <= PREP_MAIN_KEYS
    assert set(cert._REQUIRED_CHECKPOINT_KEYS) <= cert.ACCEPTANCE_KEYS


# ---------------------------------------------------------------------------
# P-022 B1 review, P2 — the temporary schedule path must be collision-free.
# ---------------------------------------------------------------------------
def _spec(dataset, schedule_id):
    return sched.ScheduleSpec(dataset=dataset, schedule_id=schedule_id,
                              cuts={"mode": "vote-count", "at": [1]})


def test_temp_schedule_path_does_not_collide_for_valid_component_pairs(tmp_path):
    """``f"{dataset}__{schedule_id}.json"`` mapped these two VALID pairs onto one
    path, so the second entry's write silently handed its schedule to the
    first entry's producer."""
    a = _spec("synthetic__a", "b-clojure-legacy")
    b = _spec("synthetic", "a__b-clojure-legacy")
    pa = cert._write_temp_schedule(a, tmp_path)
    pb = cert._write_temp_schedule(b, tmp_path)
    assert pa != pb
    assert json.loads(pa.read_text())["dataset"] == "synthetic__a"
    assert json.loads(pb.read_text())["dataset"] == "synthetic"
    assert json.loads(pa.read_text())["schedule_id"] == "b-clojure-legacy"
    assert json.loads(pb.read_text())["schedule_id"] == "a__b-clojure-legacy"


def test_temp_schedule_path_is_stable_for_the_same_pair(tmp_path):
    a = _spec("synthetic", "every-vote-clojure-legacy")
    assert cert._write_temp_schedule(a, tmp_path) == cert._write_temp_schedule(a, tmp_path)


def test_temp_schedule_write_leaves_no_staging_files(tmp_path):
    cert._write_temp_schedule(_spec("synthetic", "s"), tmp_path)
    tmp_dir = tmp_path / ".certify_cache" / "tmp_schedules"
    assert [p.name for p in sorted(tmp_dir.rglob("*")) if p.is_file()] == ["s.json"]


@pytest.mark.parametrize("dataset,schedule_id", [
    ("../escape", "s"), ("d", "../escape"), ("", "s"), ("d", ""),
    ("d/e", "s"), ("d", "e/f"), ("..", "s"), (".", "s"),
])
def test_temp_schedule_rejects_ambiguous_or_traversing_components(
    tmp_path, dataset, schedule_id
):
    with pytest.raises(cert.CertifyError) as excinfo:
        cert._write_temp_schedule(_spec(dataset, schedule_id), tmp_path)
    assert excinfo.value.stage == "schedule-path"
