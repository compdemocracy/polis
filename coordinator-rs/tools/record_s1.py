"""Record the completed local S1 gate; refuse missing, skipped or failed evidence.

Run after the full commands in README/report, from any directory. The closure
binds the current source and binaries to the saved gate outputs. It certifies
only this candidate campaign, never G01-G16 or Rust/Clojure equivalence.
"""
from collections import Counter
import hashlib
import importlib.metadata
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
    assert counts["test_s1_identity"] == 15 and counts["test_adapter"] == 31, counts
    assert len(cases) == 131, len(cases)
    rust_counts = {}
    for profile in ("default", "fault"):
        log = (ARTIFACTS / f"s1-cargo-{profile}.log").read_text()
        counts_in_log = re.findall(r"test result: ok\. (\d+) passed; 0 failed; 0 ignored", log)
        assert sum(map(int, counts_in_log)) == 31
        assert "uncertain_commit_requires_own_epoch_even_at_identical_tick_and_checkpoint ... ok" in log
        rust_counts[profile] = 31
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
    paths = list((ROOT / "coordinator-rs/src").glob("*.rs"))
    paths += list((ROOT / "coordinator-rs/tests").glob("*.rs"))
    paths += list((ROOT / "coordinator-rs/schemas").glob("*.json"))
    paths += list((ROOT / "delphi/tests/coordinator").glob("*.py"))
    paths += list((ROOT / "delphi/polismath").rglob("*.py"))
    paths += [ROOT / "coordinator-rs/evidence/python-requirements.txt", Path(__file__), junit]
    paths += [ROOT / f"coordinator-rs/{name}" for name in ("migration.sql", "Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "target/release/polis-coordinator", "target/fault/debug/polis-coordinator")]
    paths += [ARTIFACTS / name for name in ("s1-cargo-default.log", "s1-cargo-fault.log", "s1-clippy-default.log", "s1-clippy-fault.log", "s1-release.log", "s1-fault-build.log", "s1-pytest.log")]
    closure = dict(id="O8", scope="P-026 step-4 S1 candidate identity and original-byte custody",
        g01_g16_certified=False, rust_equals_clojure_claimed=False,
        candidate_schema="polis-candidate-input/1", engine_version="python-conversation/p026-s1",
        junit=str(junit.relative_to(ROOT)), python_tests=len(cases), rust_tests=rust_counts,
        runtime=dict(python=platform.python_version(), packages={name: importlib.metadata.version(name)
            for name in ("numpy", "scipy", "pandas", "scikit-learn", "psycopg2-binary", "pytest")}),
        sha256={str(path.relative_to(ROOT)): sha(path) for path in sorted(set(paths))})
    (EVIDENCE / "s1-closure.json").write_text(json.dumps(closure, indent=2) + "\n")
    audit = subprocess.run([sys.executable, str(ROOT / "delphi/tests/coordinator/audit_stages.py")], capture_output=True, text=True)
    assert audit.returncode == 1, (audit.stdout, audit.stderr)
    inventory = json.loads((EVIDENCE / "stage-inventory.json").read_text())
    assert inventory["reached"] == 25 and inventory["stage_inventory_gate"] == "PASS"
    assert inventory["condition_states"]["O8"].startswith("CLOSED"), audit.stderr
    assert len(inventory["open_conditions"]) == 7 and inventory["full_contract_gate"] == "FAIL"
    summary = dict(run="P-026 step 4 / S1 (Astra)", python_full_suite=dict(passed=len(cases), failed=0, errors=0, skipped=0,
        by_module=dict(counts), junit=str(junit.relative_to(ROOT))), rust_tests=rust_counts,
        clippy="both feature sets: PASS --all-targets -D warnings",
        builds=dict(release="PASS", debug_fault_injection="PASS", release_fault_injection="EXPECTED REFUSAL asserted in Python suite"),
        stage_audit={k: inventory[k] for k in ("reached", "stage_inventory_gate", "full_contract_gate", "open_conditions", "condition_states", "closed_conditions")},
        replay_comparison=dict(checkpoints=3, deltas=[0, 0, 0], hashes_identical_to_previous_evidence=True,
            observer_errors=0, observations=replay["observations"]),
        polarity="four artifacts and semantic tie control unchanged; compensated pairs equal, negative controls differ",
        node_d4="0 differences; generation-zero route 200 / ETag 0 / conditional 304; no loadBundle claim",
        scope="Rust versus Python rebuild-prefix campaign; Clojure remains the live production writer; no Rust/Clojure comparison",
        compose_project="p026s1x-c84e", postgres_port=55864, uncommitted=True)
    (EVIDENCE / "test-summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(dict(python=131, rust=rust_counts, stages="25/25", replay="0/0/0", open_conditions=7, O8="CLOSED (S1 scope)", full_contract_gate="FAIL")))


if __name__ == "__main__":
    main()
