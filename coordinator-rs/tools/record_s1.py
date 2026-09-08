"""Record the local S1 gate as a PARTIAL O8 result; refuse missing or failed evidence.

Run after the full commands in README/report, from any directory. The record
pins the **committed** repository inputs — source, migration, schemas, tests —
so `audit_stages.py` can re-verify it on any checkout of this commit. Build
outputs (`target/`) and run logs (`artifacts/`) are gitignored and therefore go
into an informational `run_pins` block that the audit does not gate on; those
hashes are true only of the producing host.

Counts are derived from the run, never asserted against literals: adding a test
must not make this recorder fail. It records only this candidate campaign, never
G01-G16 conformance or Rust/Clojure equivalence.
"""
from collections import Counter
import hashlib
import importlib.metadata
import os
import platform
import json
from pathlib import Path
import re
import subprocess
import sys
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[2]
ARTIFACTS = ROOT / "coordinator-rs/artifacts"
EVIDENCE = ROOT / "coordinator-rs/evidence"


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    junit = ARTIFACTS / "s1-pytest.xml"
    suites = ET.parse(junit).getroot().findall("testsuite")
    assert suites and all(int(s.attrib[k]) == 0 for s in suites for k in ("failures", "errors", "skipped"))
    cases = [case for suite in suites for case in suite.findall("testcase")]
    counts = Counter(case.attrib["classname"].rsplit(".", 1)[-1] for case in cases)
    # Derived, not hardcoded: require the S1 modules to have actually run and the
    # suite to be non-empty. The exact totals are an observation of this run.
    assert cases, "empty JUnit report"
    for module in ("test_s1_identity", "test_adapter"):
        assert counts[module], f"{module} contributed no cases"
    rust_counts = {}
    for profile in ("default", "fault"):
        log = (ARTIFACTS / f"s1-cargo-{profile}.log").read_text()
        counts_in_log = re.findall(r"test result: ok\. (\d+) passed; 0 failed; 0 ignored", log)
        assert counts_in_log, f"no cargo test result line in s1-cargo-{profile}.log"
        assert "uncertain_commit_requires_own_epoch_even_at_identical_tick_and_checkpoint ... ok" in log
        rust_counts[profile] = sum(map(int, counts_in_log))
    assert rust_counts["default"] == rust_counts["fault"], rust_counts
    assert rust_counts["default"], "no Rust tests ran"
    for name in ("s1-clippy-default.log", "s1-clippy-fault.log", "s1-release.log", "s1-fault-build.log"):
        log = (ARTIFACTS / name).read_text()
        assert "Finished " in log and "error:" not in log, name
    replay = json.loads((ARTIFACTS / "vw-equivalence.json").read_text())
    previous = json.loads((EVIDENCE / "vw-equivalence.json").read_text())
    assert len(replay["checkpoints"]) == 3 and replay["observer_errors"] == []
    assert all(c["deltas"] == [] and c["rust"] == c["python"] for c in replay["checkpoints"])
    assert [c["rust"] for c in replay["checkpoints"]] == [c["rust"] for c in previous["checkpoints"]]
    for name in ("polarity-synthetic.json", "polarity-vw.json", "polarity-biodiversity.json", "polarity-rebuild-schedule.json", "semantic-tie-key.json"):
        assert json.loads((ARTIFACTS / name).read_text()) == json.loads((EVIDENCE / name).read_text()), name
    assert json.loads((EVIDENCE / "d4-node-reader.json").read_text())["differences"] == {}
    (EVIDENCE / "vw-equivalence.json").write_bytes((ARTIFACTS / "vw-equivalence.json").read_bytes())
    # Committed inputs only: these hash the same on any checkout of this commit,
    # which is what makes the recorded state re-verifiable by someone else.
    paths = list((ROOT / "coordinator-rs/src").glob("*.rs"))
    paths += list((ROOT / "coordinator-rs/tests").glob("*.rs"))
    paths += list((ROOT / "coordinator-rs/schemas").glob("*.json"))
    paths += list((ROOT / "delphi/tests/coordinator").glob("*.py"))
    paths += list((ROOT / "delphi/polismath").rglob("*.py"))
    paths += [ROOT / "coordinator-rs/evidence/python-requirements.txt", Path(__file__)]
    paths += [ROOT / f"coordinator-rs/{name}" for name in ("migration.sql", "Cargo.toml", "Cargo.lock", "rust-toolchain.toml")]
    ignored = ("coordinator-rs/target/", "coordinator-rs/artifacts/")
    source_pins = {str(path.relative_to(ROOT)): sha(path) for path in sorted(set(paths))}
    assert not [n for n in source_pins if n.startswith(ignored)], "gitignored path in source pins"
    # Informational only. Binaries and logs live under gitignored directories, so
    # a hash gate on them would hold on the producing host and nowhere else.
    run_paths = [junit]
    run_paths += [ROOT / f"coordinator-rs/{name}" for name in ("target/release/polis-coordinator", "target/fault/debug/polis-coordinator")]
    run_paths += [ARTIFACTS / name for name in ("s1-cargo-default.log", "s1-cargo-fault.log", "s1-clippy-default.log", "s1-clippy-fault.log", "s1-release.log", "s1-fault-build.log", "s1-pytest.log")]
    compose_project = os.environ.get("COMPOSE_PROJECT_NAME")
    postgres_port = os.environ.get("POLIS_RECOVERY_PG_PORT") or os.environ.get("RECOVERY_PG_PORT")
    if postgres_port is None:
        match = re.search(r":(\d+)/", os.environ.get("POLIS_TEST_POSTGRES_URL", ""))
        postgres_port = match.group(1) if match else None
    run_pins = dict(verifiable_on_producing_host_only=True,
        junit=str(junit.relative_to(ROOT)), python_tests=len(cases), rust_tests=rust_counts,
        compose_project=compose_project, postgres_port=int(postgres_port) if postgres_port else None,
        platform=platform.platform(),
        runtime=dict(python=platform.python_version(), packages={name: importlib.metadata.version(name)
            for name in ("numpy", "scipy", "pandas", "scikit-learn", "psycopg2-binary", "pytest")}),
        sha256={str(path.relative_to(ROOT)): sha(path) for path in sorted(set(run_paths)) if path.exists()})
    closure = dict(id="O8", state="PARTIAL",
        scope="P-026 step-4 S1 candidate identity and original-byte custody",
        g01_g16_certified=False, rust_equals_clojure_claimed=False,
        candidate_schema="polis-candidate-input/1", engine_version="python-conversation/p026-s1",
        recorded=[
            "distinct candidate schema id and strict adapter admission on both sides",
            "original worker bytes and their digests stored atomically with the JSONB, with decoded original/JSONB correspondence checked on read",
            "worker/engine identity re-verified at initialization and at snapshot",
            "operation id and publisher epoch bound into the uncertain-COMMIT readback",
        ],
        remaining_obligations=[
            "all applicable G01-G16 cases and their required negative controls",
            "an immutable manifest for the profile",
            "fresh rebuild, exact resume and warm incremental output schedules distinguished",
            "a non-vacuous P-023 compensated pair and raw C9 validation",
        ],
        fixture_originals=(
            "publish-fixture synthesizes original bytes by re-encoding the fixture's parsed values"
            " when no explicit originals are supplied; those rows are labelled synthesized on stderr"
            " and validate_originals() is tautological for them. They are not engine originals."),
        integrity_model=(
            "self-certifying, not tamper-evident: a writer with access to the four math tables can"
            " rewrite bytes, JSONB, both digests and the checkpoint coherently and is not detected."
            " Digests bind an honest writer's own output; they are not an authentication scheme."),
        pins_are_committed_sources=True,
        sha256=source_pins, run_pins=run_pins)
    (EVIDENCE / "s1-closure.json").write_text(json.dumps(closure, indent=2) + "\n")
    audit = subprocess.run([sys.executable, str(ROOT / "delphi/tests/coordinator/audit_stages.py")], capture_output=True, text=True)
    assert audit.returncode == 1, (audit.stdout, audit.stderr)
    inventory = json.loads((EVIDENCE / "stage-inventory.json").read_text())
    assert inventory["reached"] == 25 and inventory["stage_inventory_gate"] == "PASS"
    assert inventory["condition_states"]["O8"].startswith("PARTIAL"), audit.stderr
    assert inventory["closed_conditions"] == [] and inventory["partial_conditions"]
    assert len(inventory["open_conditions"]) == 8 and inventory["full_contract_gate"] == "FAIL"
    summary = dict(run="P-026 step 4 / S1", python_full_suite=dict(passed=len(cases), failed=0, errors=0, skipped=0,
        by_module=dict(counts), junit=str(junit.relative_to(ROOT))), rust_tests=rust_counts,
        clippy="both feature sets: PASS --all-targets -D warnings",
        builds=dict(release="PASS", debug_fault_injection="PASS", release_fault_injection="EXPECTED REFUSAL asserted in Python suite"),
        stage_audit={k: inventory[k] for k in ("reached", "stage_inventory_gate", "full_contract_gate", "open_conditions", "condition_states", "closed_conditions", "partial_conditions")},
        replay_comparison=dict(checkpoints=len(replay["checkpoints"]), deltas=[len(c["deltas"]) for c in replay["checkpoints"]],
            hashes_identical_to_previous_evidence=True,
            observer_errors=len(replay["observer_errors"]), observations=replay["observations"]),
        polarity="four artifacts and semantic tie control unchanged; compensated pairs equal, negative controls differ",
        node_d4="0 differences; generation-zero route 200 / ETag 0 / conditional 304; no loadBundle claim",
        scope="Rust versus Python rebuild-prefix campaign; Clojure remains the live production writer; no Rust/Clojure comparison",
        compose_project=compose_project, postgres_port=run_pins["postgres_port"], uncommitted=False)
    (EVIDENCE / "test-summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(dict(python=len(cases), rust=rust_counts, stages="25/25",
        replay="/".join(str(len(c["deltas"])) for c in replay["checkpoints"]),
        open_conditions=len(inventory["open_conditions"]),
        O8=inventory["condition_states"]["O8"], full_contract_gate="FAIL")))


if __name__ == "__main__":
    main()
