"""Negative controls for exact-case, zero-skip and historical-source admission."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import xml.etree.ElementTree as ET

import pytest
import yaml

CI = Path(__file__).resolve().parents[1]
ROOT = CI.parents[1]
sys.path.insert(0, str(CI))
from verify import comparisons, empty_observations, exact, jest_cases, python_cases, rust_cases, sha, source_pins, stage_audit

INV = json.loads((CI / "inventory-v1.json").read_text())


def junit(tmp_path):
    root = ET.Element("testsuites")
    suite = ET.SubElement(root, "testsuite", tests=str(len(INV["python_junit"])), failures="0", errors="0", skipped="0")
    for classname, name in INV["python_junit"]:
        ET.SubElement(suite, "testcase", classname=classname, name=name)
    return root, suite


@pytest.mark.parametrize("mutation", ["missing", "duplicate", "renamed", "skip", "failure", "error", "bad-total", "empty"])
def test_junit_rejects_missing_substituted_or_nonpassing_cases(tmp_path, mutation):
    root, suite = junit(tmp_path)
    if mutation == "missing":
        suite.remove(suite[0])
        suite.set("tests", str(len(suite)))
    elif mutation == "duplicate":
        suite[0].set("name", suite[1].get("name"))
    elif mutation == "renamed":
        suite[0].set("name", "unreviewed-replacement")
    elif mutation in ("skip", "failure", "error"):
        ET.SubElement(suite[0], {"skip": "skipped"}.get(mutation, mutation))
    elif mutation == "bad-total":
        suite.set("tests", "999")
    else:
        suite.clear()
    path = tmp_path / "junit.xml"
    ET.ElementTree(root).write(path)
    with pytest.raises((ValueError, KeyError)):
        python_cases(path, INV)


def test_complete_junit_passes(tmp_path):
    root, _ = junit(tmp_path)
    path = tmp_path / "junit.xml"
    ET.ElementTree(root).write(path)
    assert python_cases(path, INV) == 151


@pytest.mark.parametrize("mutation", ["subset", "duplicate", "substitution"])
def test_collection_hook_refuses_inventory_drift(mutation):
    # Invoke the real hook, including the entirely-uncollected crate case.
    spec = importlib.util.spec_from_file_location("required_inventory", CI / "required_inventory.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    nodes = list(INV["python_nodeids"])
    if mutation == "subset":
        nodes = []
    elif mutation == "duplicate":
        nodes[0] = nodes[1]
    else:
        nodes[0] = "tests/coordinator/test_fake.py::test_fake"
    from types import SimpleNamespace
    with pytest.raises(pytest.UsageError, match="collection"):
        module.pytest_collection_finish(SimpleNamespace(items=[SimpleNamespace(nodeid=n) for n in nodes]))


def rust_log():
    return "\n".join(f"test {n} ... ok" for n in INV["rust_tests"]) + \
        "\ntest result: ok. 31 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out;\n"


@pytest.mark.parametrize("mutation", ["missing", "duplicate", "ignored", "filtered", "late-failure"])
def test_rust_refuses_filtered_or_substituted_results(mutation):
    log = rust_log()
    if mutation == "missing":
        log = log.replace(f"test {INV['rust_tests'][0]} ... ok\n", "")
    elif mutation == "duplicate":
        log = log.replace(INV["rust_tests"][0], INV["rust_tests"][1])
    elif mutation == "ignored":
        log = log.replace("0 ignored", "1 ignored")
    elif mutation == "filtered":
        log = log.replace("0 filtered", "1 filtered")
    else:
        log += "test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out;\n"
    with pytest.raises(ValueError):
        rust_cases(log, INV)


def jest_report():
    report = dict(success=True, numFailedTestSuites=0, numFailedTests=0, numPendingTestSuites=0,
                  numPendingTests=0, numRuntimeErrorTestSuites=0, numTodoTests=0,
                  numPassedTests=37, numTotalTests=37, numPassedTestSuites=3, numTotalTestSuites=3,
                  testResults=[])
    for file in sorted({p for p, _ in INV["jest_cases"]}):
        report["testResults"].append(dict(name="/synthetic/server/" + file, status="passed",
             assertionResults=[dict(fullName=n, status="passed", failureMessages=[]) for p, n in INV["jest_cases"] if p == file]))
    return report


@pytest.mark.parametrize("mutation", ["missing", "substitute", "skip", "todo", "suite-error"])
def test_jest_refuses_incomplete_bundle_selection(mutation):
    report = jest_report()
    cases = report["testResults"][0]["assertionResults"]
    if mutation == "missing":
        cases.pop()
    elif mutation == "substitute":
        cases[0]["fullName"] = "unreviewed-replacement"
    elif mutation == "skip":
        cases[0]["status"] = "pending"
    elif mutation == "todo":
        report["numTodoTests"] = 1
    else:
        report["testResults"][0]["status"] = "failed"
    with pytest.raises(ValueError):
        jest_cases(report, INV)


def test_exact_rust_and_jest_inventories_pass():
    assert rust_cases(rust_log(), INV) == 31
    assert jest_cases(jest_report(), INV) == 37


@pytest.mark.parametrize("mutation", ["missing", "unreached", "lost-pin-admission", "closed-contract"])
def test_stage_and_source_admission_cannot_be_waived(mutation):
    report = json.loads((ROOT / "coordinator-rs/evidence/stage-inventory.json").read_text())
    if mutation == "missing":
        report["stages"].pop()
    elif mutation == "unreached":
        report["stages"][0]["status"] = "required-but-unreached"
    elif mutation == "lost-pin-admission":
        report["partial_conditions"] = []
    else:
        report["full_contract_gate"] = "PASS"
    with pytest.raises(ValueError):
        stage_audit(report, INV)


def test_stale_source_pin_rejected(tmp_path):
    directory = tmp_path / "coordinator-rs/evidence"
    directory.mkdir(parents=True)
    source = tmp_path / "source.py"
    source.write_text("original")
    for name in ("s1-closure.json", "s2-closure.json", "s2-production-reader.json"):
        (directory / name).write_text(json.dumps({"sha256": {"source.py": sha(source)}}))
    assert source_pins(tmp_path)
    source.write_text("changed")
    with pytest.raises(ValueError, match="stale source pin"):
        source_pins(tmp_path)


@pytest.mark.parametrize("mutation", ["missing-replay", "zero-observer", "changed-replay", "changed-polarity", "stale-d4", "weakened-d4"])
def test_comparison_requires_fresh_complete_unchanged_evidence(tmp_path, mutation):
    evidence = ROOT / "coordinator-rs/evidence"
    baseline = {p.name: p.read_bytes() for p in evidence.glob("*.json")}
    artifacts = tmp_path / "artifacts"
    fresh = tmp_path / "evidence"
    artifacts.mkdir()
    fresh.mkdir()
    for name, data in baseline.items():
        (artifacts / name).write_bytes(data)
        (fresh / name).write_bytes(data)
    replay = json.loads(baseline["vw-equivalence.json"])
    if mutation == "missing-replay":
        (artifacts / "vw-equivalence.json").unlink()
    elif mutation == "zero-observer":
        replay["observations"] = 0
        (artifacts / "vw-equivalence.json").write_text(json.dumps(replay))
    elif mutation == "changed-replay":
        replay["checkpoints"][0]["deltas"] = ["synthetic drift"]
        (artifacts / "vw-equivalence.json").write_text(json.dumps(replay))
    elif mutation == "changed-polarity":
        (artifacts / "polarity-vw.json").write_text("{}")
    elif mutation == "stale-d4":
        # A historical file in baseline cannot stand in for an absent fresh file.
        (fresh / "d4-node-reader.json").unlink()
    else:
        (fresh / "d4-node-reader.json").write_text('{"differences": {}}')
    with pytest.raises((ValueError, FileNotFoundError)):
        comparisons(artifacts, fresh, baseline)


@pytest.mark.parametrize("mutation", ["stable-field", "published-byte", "inconsistent-observation", "missing-hash"])
def test_empty_clock_observation_does_not_waive_stable_or_published_fields(mutation):
    import copy
    baseline = json.loads((ROOT / "coordinator-rs/evidence/d4-node-reader-empty.json").read_text())
    current = copy.deepcopy(baseline)
    view = current["served"]["python"]
    view["last_vote_timestamp"] += 1000
    assert len(empty_observations(current, baseline)) == 9
    if mutation == "stable-field":
        view["tids"] = []
    elif mutation == "published-byte":
        current["served"]["rustproto"]["asJSON_sha256"] = "0" * 64
    elif mutation == "inconsistent-observation":
        view["gzip_sha256"] = "0" * 64
    else:
        view["raw"]["asJSON_sha256"] = ""
    with pytest.raises(ValueError):
        empty_observations(current, baseline)


def test_real_pytest_selected_subset_is_rejected_before_execution(tmp_path):
    import os
    env = dict(os.environ, PYTHONPATH=str(CI) + os.pathsep + str(ROOT / "delphi"), PYTEST_DISABLE_PLUGIN_AUTOLOAD="1")
    result = subprocess.run([sys.executable, "-m", "pytest", "-o", "addopts=", "-p", "no:cacheprovider",
        "-p", "required_inventory", "--confcutdir=delphi/tests/coordinator", "--collect-only", "-q",
        "delphi/tests/coordinator/test_adapter.py::test_contract_empty_snapshot"],
        cwd=ROOT, env=env, capture_output=True, text=True)
    (tmp_path / "selected-subset.log").write_text(result.stdout + result.stderr)
    assert result.returncode == 4, result.stdout + result.stderr
    assert "collection: missing=" in result.stderr
    assert "fatal:" not in result.stderr


def reference_asset_function(root, reference):
    """Load the real loader without importing the DB/process fixture setup."""
    import ast
    tree = ast.parse((ROOT / "delphi/tests/coordinator/conftest.py").read_text())
    function = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "asset")
    scope = dict(ROOT=root, REFERENCE=reference, subprocess=subprocess, pytest=pytest)
    exec(compile(ast.Module(body=[function], type_ignores=[]), "reference-loader", "exec"), scope)
    return scope["asset"]


@pytest.mark.parametrize("reference", ["HEAD", "0" * 40])
def test_reference_missing_at_ref_refuses_even_with_untracked_disk_copy(tmp_path, reference):
    # Point a disposable directory at the read-only repository. No Git mutation,
    # alternate object store, or locally available historical oracle is needed.
    git_dir = subprocess.check_output(["git", "rev-parse", "--absolute-git-dir"], cwd=ROOT, text=True).strip()
    (tmp_path / ".git").write_text(f"gitdir: {git_dir}\n")
    name = "synthetic-untracked-oracle-761.py"
    path = "delphi/tests/poller/recovery/" + name
    disk_copy = tmp_path / path
    disk_copy.parent.mkdir(parents=True)
    disk_copy.write_text("raise AssertionError('disk fallback must never execute')\n")
    with pytest.raises(pytest.UsageError) as error:
        reference_asset_function(tmp_path, reference)(name)
    assert str(error.value) == f"collection: missing={[f'{reference}:{path}']}; pinned reference unavailable"
    assert disk_copy.read_text().startswith("raise AssertionError")


def test_reference_loader_preserves_exact_git_bytes(tmp_path, monkeypatch):
    raw = "# pinned oracle\nanswer = 42\n"
    calls = []
    def show(argv, **kwargs):
        calls.append((argv, kwargs))
        return raw
    monkeypatch.setattr(subprocess, "check_output", show)
    assert reference_asset_function(tmp_path, "reviewed-ref")("fold.py") == raw
    assert calls == [(["git", "show", "reviewed-ref:delphi/tests/poller/recovery/fold.py"],
                      dict(cwd=tmp_path, text=True, stderr=subprocess.PIPE))]


@pytest.mark.parametrize("opt", ["P026_NODE_READER_OPTIONAL", "PYTEST_ADDOPTS", "PYTHONOPTIMIZE"])
def test_runner_refuses_skip_and_assertion_escape_before_starting_docker(tmp_path, opt):
    import os
    env = dict(os.environ, COMPOSE_PROJECT_NAME="coordinator-control-test", POLIS_RECOVERY_PG_PORT="55492", RECOVERY_PG_PORT="55492")
    env[opt] = "1"
    result = subprocess.run([sys.executable, str(CI / "run.py"), "--output", str(tmp_path / "new")],
                            env=env, capture_output=True, text=True)
    assert result.returncode != 0
    assert not (tmp_path / "new").exists()
    assert {"P026_NODE_READER_OPTIONAL": "Node opt-out", "PYTEST_ADDOPTS": "PYTEST_ADDOPTS", "PYTHONOPTIMIZE": "optimized Python"}[opt] in result.stderr


def test_workflow_cannot_filter_out_the_required_job_or_skip_failure():
    workflow = yaml.load((ROOT / ".github/workflows/coordinator-ci.yml").read_text(), Loader=yaml.BaseLoader)
    assert set(workflow["on"]) == {"pull_request", "push", "merge_group", "workflow_dispatch"}
    assert workflow["on"]["pull_request"] == ""
    assert workflow["permissions"] == {"contents": "read"}
    job = workflow["jobs"]["coordinator-required"]
    assert "if" not in job and "continue-on-error" not in job
    steps = job["steps"]
    assert steps[0]["with"] == {"fetch-depth": "0", "persist-credentials": "false"}
    for step in steps:
        assert "continue-on-error" not in step
        if "uses" in step:
            assert len(step["uses"].split("@")[1]) == 40
    run_steps = "\n".join(s.get("run", "") for s in steps)
    assert "npm ci --prefix server" in run_steps
    assert "python coordinator-rs/ci/run.py" in run_steps
    assert "record_s1.py" not in run_steps and "record_s2.py" not in run_steps


def test_inventory_preserves_the_reviewed_baseline_without_replacement():
    assert INV["schema"] == "polis-coordinator-ci-inventory/1"
    assert len(INV["python_nodeids"]) == len(INV["python_junit"]) == 151
    assert len(INV["rust_tests"]) == 31 and len(INV["jest_cases"]) == 37 and len(INV["stages"]) == 25
    assert INV["extensions"] == []
    exact(INV["python_nodeids"], INV["python_nodeids"], "unique inventory")


def test_bridge_inventory_preserves_every_baseline_identity():
    extended=json.loads((CI/"inventory-v2.json").read_text())
    assert set(INV["python_nodeids"]) < set(extended["python_nodeids"])
    assert len(extended["python_nodeids"])==206
    assert len(extended["python_nodeids"])==len(set(extended["python_nodeids"]))
    assert len(extended["python_junit"])==206
    assert extended["rust_tests"]==INV["rust_tests"]
    assert extended["jest_cases"]==INV["jest_cases"]
    assert extended["stages"]==INV["stages"]


def test_bridge_inventory_requires_twenty_each_schedule():
    extended=json.loads((CI/"inventory-v2.json").read_text())
    added=set(extended["python_nodeids"])-set(INV["python_nodeids"])
    for name in ("test_stale_python_child_after_parent_death_is_fenced",
                 "test_final_python_margin_after_rpc_rolls_back"):
        assert {f"tests/coordinator/test_bridge.py::{name}[{i}]" for i in range(20)} <= added
    assert len(added)==55
    assert sorted(added)==extended["extensions"][0]["added_nodeids"]


def test_collection_accepts_only_the_extended_campaign():
    spec=importlib.util.spec_from_file_location("required_inventory",CI/"required_inventory.py")
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    from types import SimpleNamespace
    def session(nodes):
        return SimpleNamespace(items=[SimpleNamespace(nodeid=n) for n in nodes])
    extended=json.loads((CI/"inventory-v2.json").read_text())
    module.pytest_collection_finish(session(extended["python_nodeids"]))
    with pytest.raises(pytest.UsageError,match="collection"):
        module.pytest_collection_finish(session(INV["python_nodeids"]))
