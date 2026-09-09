"""Record the S2 reader slice as a PARTIAL O1 result; refuse missing evidence.

This is the **candidate-reader portion** of S2's O1 obligation: a candidate
coherent-read `loadBundle` that serves one snapshot generation's exact mapping
and closes the old-main/new-mapping torn read, with admission refusals and
math_env scoping, plus a local Node-reader failure guard. The rest of S2 — the
production `server/src` loadBundle, its bounded whole-Bundle cache, request-context
propagation through getPidsForGid/doFamousQuery/report.ts, and the comment-owned
empty presentation — is a still-open S2 remainder (dispatched separately), NOT
S5; only the combined full-app and private campaigns are S5. O1 stays PARTIAL/open.

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

    # The witness, checked for its DISCRIMINATING facts, not merely non-empty
    # membership: the reader returns the snapshot generation A's *exact* per-group
    # pids (compared in the test against an independent Python re-derivation over
    # the published blobs, so a fabricating reader fails), the interleaved snapshot
    # returns exactly A while a later read returns exactly B, A and B are
    # distinguishable, and a wrong-namespace companion does not leak in.
    witness = json.loads((EVIDENCE / "d4-bundle-reader.json").read_text())
    for key in ("snapshot_equals_a_exactly", "snapshot_mapping_sha256_equals_a",
                "later_read_equals_b_exactly", "a_and_b_distinguishable",
                "wrong_namespace_rustproto_unaffected"):
        assert witness[key] is True, (key, witness)
    a, b = witness["expected_pids_for_gid_a"], witness["expected_pids_for_gid_b"]
    assert a and b and a != b, witness
    all_pids = {p for mapping in (a, b) for v in mapping.values() for p in v}
    assert all_pids and 999 not in all_pids, ("real fixture pids, never fabricated", witness)
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
            "under an interleaved publish the reader returns snapshot generation A exactly (all four"
            " row ticks equal, and A's exact per-group pids), not the B the interleave committed; a"
            " later read returns B exactly, and A and B are distinguishable",
            "the returned per-group pids are compared against an independent Python re-derivation over"
            " the published blobs, so a reader that fabricates pids fails",
            "a missing or tick-mismatched companion fails admission, a valid replacement is observed"
            " after republication, the reads are scoped by math_env, and a wrong-namespace companion"
            " does not leak in",
            "the Node reader tests are a local failure guard (absent server modules fail rather than"
            " skip); the existing real-module getPca/getBidIndexToPidMapping byte-equality path is"
            " retained at 0 differences",
        ],
        remaining_obligations=[
            "S2 remainder (separately dispatched, still open, NOT deferred to S5): the production"
            " server/src loadBundle, request-scoped and threaded through"
            " getPidsForGid/doFamousQuery/report.ts, with a bounded whole-Bundle cache and the"
            " characterized 3s TTL / response order preserved, and the comment-owned empty presentation",
            "the torn baseline here is a copied SQL-shaped autocommit model on one client, not a call"
            " through the real getPca/getBidIndexToPidMapping (which dispatch via Promise.all)",
            "S5 (later): the combined full-app/auth/report/CSV campaign and the private 2,884-case"
            " served corpus; the C7 comparison clock is already admitted (plan rev2 C2, freeze then"
            " advance the logical request clock), only its execution campaign is open",
        ],
        outstanding_required_ci=[
            "no workflow is changed by this slice: _node_gate.py fails absent modules locally, but"
            " there is no coordinator-rs CI job, no pinned server-module provisioning, and no enforced"
            " zero-skip required run",
            "the exact HTTP and Bundle case set is not asserted present by a required job; a selected"
            " subset plus old evidence must not be treated as required-job completion",
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
        slice="P-026 step 4 / S2 reader (candidate-reader portion; production reader still open)",
        candidate_loadBundle=True, node_local_failure_guard=True, required_ci_job=False,
        witness="coordinator-rs/evidence/d4-bundle-reader.json",
        snapshot_returns_a_exactly=witness["snapshot_equals_a_exactly"],
        later_read_returns_b_exactly=witness["later_read_equals_b_exactly"],
        a_and_b_distinguishable=witness["a_and_b_distinguishable"],
        wrong_namespace_unaffected=witness["wrong_namespace_rustproto_unaffected"],
        node_d4_differences=0, O1="PARTIAL", python_cases=len(cases))
    summary_path.write_text(json.dumps(summary, indent=2) + "\n")

    print(json.dumps(dict(python=len(cases), O1=inventory["condition_states"]["O1"],
        open_conditions=len(inventory["open_conditions"]),
        partials=[p["id"] for p in inventory["partial_conditions"]],
        node_d4_differences=0, full_contract_gate="FAIL")))


if __name__ == "__main__":
    main()
