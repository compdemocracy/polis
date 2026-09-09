"""Record the S2 reader slice as a PARTIAL O1 result; refuse missing evidence.

S2 is the reader half of O1: a candidate coherent-read `loadBundle` that closes
the old-main/new-mapping torn read the existing separate-read server reader
allows, with missing/mismatched-companion admission and math_env scoping, plus
the Node D4 job made unconditional. It does not deliver the production
`server/src` Bundle rewrite (threaded through getPidsForGid/doFamousQuery/
report.ts with a bounded whole-Bundle cache) or full application boot, so it is
recorded as PARTIAL and O1 stays open.

Run after the full Python suite and record_s1. Like record_s1, this pins only
committed repository sources so `audit_stages.py` can re-verify the record on any
checkout of this commit, and derives its facts from the JUnit report and the
witness evidence rather than asserting literals. It records only this candidate
reader witness, never CO04 conformance.
"""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[2]
ARTIFACTS = ROOT / "coordinator-rs/artifacts"
EVIDENCE = ROOT / "coordinator-rs/evidence"


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    # The reader tests must have actually run, with nothing skipped: the Node job
    # is unconditional now, so a skip is a failure, not an absence of evidence.
    junit = ARTIFACTS / "s1-pytest.xml"
    suites = ET.parse(junit).getroot().findall("testsuite")
    assert suites and all(int(s.attrib[k]) == 0 for s in suites for k in ("failures", "errors", "skipped")), \
        "the Node reader job must run unconditionally with zero skips"
    cases = [case for suite in suites for case in suite.findall("testcase")]
    modules = {case.attrib["classname"].rsplit(".", 1)[-1] for case in cases}
    for module in ("test_bundle_reader", "test_node_reader"):
        assert module in modules, f"{module} contributed no cases"

    # The witness the slice exists to produce, checked for its reproducible facts
    # (the random operation id / publisher epoch are per-run and not asserted).
    witness = json.loads((EVIDENCE / "d4-bundle-reader.json").read_text())
    torn = witness["separate_read_path"]
    assert torn["torn"] is True and torn["bidtopid_tick"] == torn["main_tick"] + 1, torn
    bundle = witness["load_bundle"]
    assert bundle["admission"] == "ok" and bundle["coherent"] is True, bundle
    assert bundle["main_tick"] == bundle["bidtopid_tick"] == bundle["ptptstats_tick"] == bundle["ticks_tick"], bundle
    assert any(bundle["pids_for_gid"].values()), bundle
    assert witness["missing_companion_refused"]["admission"] == "REFUSED", witness
    assert witness["mismatched_companion_refused"]["admission"] == "REFUSED", witness
    assert witness["repaired_after_republish"]["admission"] == "ok", witness
    # The existing real-Node byte-equality path is retained and still exact.
    assert json.loads((EVIDENCE / "d4-node-reader.json").read_text())["differences"] == {}

    # Committed inputs only, so the record re-verifies on any checkout of this commit.
    paths = [
        ROOT / "coordinator-rs/tools/bundle_reader.cjs",
        ROOT / "coordinator-rs/tools/record_s2.py",
        ROOT / "delphi/tests/coordinator/test_bundle_reader.py",
        ROOT / "delphi/tests/coordinator/test_node_reader.py",
        ROOT / "delphi/tests/coordinator/_node_gate.py",
        ROOT / "delphi/tests/coordinator/audit_stages.py",
    ]
    source_pins = {str(path.relative_to(ROOT)): sha(path) for path in sorted(set(paths))}
    closure = dict(id="O1", state="PARTIAL",
        scope="P-026 step-4 S2 reader: candidate loadBundle whole-Bundle atomicity",
        production_loadbundle_certified=False, rust_equals_clojure_claimed=False,
        recorded=[
            "a candidate coherent-read loadBundle reads main + bidtopid + ptptstats + the"
            " math_ticks checkpoint in one REPEATABLE READ READ ONLY snapshot in the real Node runtime",
            "the separate-read path (getPca then getBidIndexToPidMapping) is shown to tear under an"
            " interleaved publish while loadBundle stays coherent at one generation",
            "a missing or tick-mismatched companion fails admission, and a valid replacement is"
            " observed once the coordinator republishes from source",
            "the pure mapping accessor derives pids from the Bundle's own rows, and the reads are"
            " scoped by math_env",
            "the Node D4 reader job is unconditional: absent server modules fail rather than skip",
            "the existing real-Node getPca/getBidIndexToPidMapping byte-equality path is retained at 0 differences",
        ],
        remaining_obligations=[
            "the production server/src loadBundle: request-scoped Bundle threaded through"
            " getPidsForGid, doFamousQuery and report.ts, with a bounded whole-Bundle cache and"
            " the characterized 3s TTL / response order preserved",
            "full application boot, auth, report/CSV joins and the private 2,884-case served corpus (S5)",
            "the C7 no-row-to-published-empty transition once the contract owner admits the comparison clock (S5)",
        ],
        candidate_reader="coordinator-rs/tools/bundle_reader.cjs",
        witness="coordinator-rs/evidence/d4-bundle-reader.json",
        integrity_model=(
            "this is a candidate reader in the Node runtime for the experiment's harness, not the"
            " production server reader; the atomicity property is demonstrated against the real"
            " test PostgreSQL, it does not certify CO04's Bundle rewrite or the served corpus"),
        pins_are_committed_sources=True,
        python_cases=len(cases), sha256=source_pins)
    (EVIDENCE / "s2-closure.json").write_text(json.dumps(closure, indent=2) + "\n")

    audit = subprocess.run([sys.executable, str(ROOT / "delphi/tests/coordinator/audit_stages.py")],
                           capture_output=True, text=True)
    assert audit.returncode == 1, (audit.stdout, audit.stderr)
    inventory = json.loads((EVIDENCE / "stage-inventory.json").read_text())
    assert inventory["condition_states"]["O1"].startswith("PARTIAL"), audit.stderr
    assert inventory["condition_states"]["O8"].startswith("PARTIAL"), audit.stderr
    assert inventory["closed_conditions"] == [] and len(inventory["partial_conditions"]) == 2
    assert len(inventory["open_conditions"]) == 8 and inventory["full_contract_gate"] == "FAIL"

    # Keep test-summary.json's stage_audit consistent with the fresh inventory
    # (record_s1 wrote it with only O8 partial), so the plan checker sees the same
    # open/closed/partial accounting in both evidence files.
    summary_path = EVIDENCE / "test-summary.json"
    summary = json.loads(summary_path.read_text())
    summary["stage_audit"] = {k: inventory[k] for k in
        ("reached", "stage_inventory_gate", "full_contract_gate",
         "open_conditions", "condition_states", "closed_conditions", "partial_conditions")}
    summary["s2_reader"] = dict(
        slice="P-026 step 4 / S2 reader",
        candidate_loadBundle=True, node_job_unconditional=True,
        witness="coordinator-rs/evidence/d4-bundle-reader.json",
        torn_read_shown=torn["torn"], coherent_bundle=bundle["coherent"],
        admission_refusals=[witness["missing_companion_refused"]["reason"],
                            witness["mismatched_companion_refused"]["reason"]],
        node_d4_differences=0, O1="PARTIAL", python_cases=len(cases))
    summary_path.write_text(json.dumps(summary, indent=2) + "\n")

    print(json.dumps(dict(python=len(cases), O1=inventory["condition_states"]["O1"],
        open_conditions=len(inventory["open_conditions"]),
        partials=[p["id"] for p in inventory["partial_conditions"]],
        node_d4_differences=0, full_contract_gate="FAIL")))


if __name__ == "__main__":
    main()
