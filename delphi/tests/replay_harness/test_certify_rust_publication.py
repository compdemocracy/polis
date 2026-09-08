"""P-045 slice 2 (half): four-row readback + independent observer validators.

Pure controls over synthetic readback bundles — no Postgres, no Rust binary. The
slice-3 N05/N10/N11 real-mutation controls (corrupt each table, sever a COMMIT,
substitute foreign-env rows) will drive THIS validator against a real Rust
publication; here it is graded on hand-built bundles and their mutations.
"""

from __future__ import annotations

import copy
import hashlib
import json

from polismath.replay import coordinator_driver as cd


def _bundle(tick=0, epoch=5, op="op-1"):
    raw = {"main": json.dumps({"tids": [0, 1], "gen": tick}).encode(),
           "bidtopid": json.dumps({"0": [1, 2]}).encode(),
           "ptptstats": json.dumps({"1": {"a": 1}}).encode()}
    dg = {k: hashlib.sha256(v).hexdigest() for k, v in raw.items()}
    return {
        "zid": 1, "math_env": "rustproto",
        "main": {"math_tick": tick, "caching_tick": 42, "data": json.loads(raw["main"]),
                 "original_bytes": raw["main"].decode(), "original_sha256": dg["main"]},
        "bidtopid": {"math_tick": tick, "data": json.loads(raw["bidtopid"]),
                     "original_bytes": raw["bidtopid"].decode(), "original_sha256": dg["bidtopid"]},
        "ptptstats": {"math_tick": tick, "data": json.loads(raw["ptptstats"]),
                      "original_bytes": raw["ptptstats"].decode(), "original_sha256": dg["ptptstats"]},
        "ticks": {"math_tick": tick, "caching_tick": 42, "publisher_epoch": epoch,
                  "operation_id": op, "original_digests": dg},
    }


def test_first_publication_tick_zero_passes():
    assert cd.validate_readback(_bundle(tick=0), expected_prior_tick=None,
                                operation_id="op-1", publisher_epoch=5) == []


def test_prior_to_next_tick():
    b = _bundle(tick=3)
    assert cd.validate_readback(b, expected_prior_tick=2, operation_id="op-1", publisher_epoch=5) == []
    bad = cd.validate_readback(b, expected_prior_tick=5, operation_id="op-1", publisher_epoch=5)
    assert any("prior+1" in f for f in bad)


def test_first_publication_must_be_zero():
    fails = cd.validate_readback(_bundle(tick=1), expected_prior_tick=None,
                                 operation_id="op-1", publisher_epoch=5)
    assert any("must be 0" in f for f in fails)


def test_tick_disagreement_detected():
    b = _bundle(tick=0)
    b["bidtopid"]["math_tick"] = 1
    assert any("bidtopid" in f for f in cd.validate_readback(
        b, expected_prior_tick=None, operation_id="op-1", publisher_epoch=5))


def test_missing_companion_detected():
    b = _bundle(tick=0)
    b["ptptstats"] = {}
    assert any("ptptstats" in f for f in cd.validate_readback(
        b, expected_prior_tick=None, operation_id="op-1", publisher_epoch=5))


def test_wrong_epoch_and_operation_detected():
    b = _bundle(tick=0)
    fails = cd.validate_readback(b, expected_prior_tick=None, operation_id="OTHER", publisher_epoch=99)
    assert any("operation_id" in f for f in fails) and any("publisher_epoch" in f for f in fails)


def test_data_text_is_not_original_evidence():
    """A row with only JSONB (data) and no original_bytes must FAIL, not fall
    back to data::text as the origin."""
    b = _bundle(tick=0)
    b["main"].pop("original_bytes")
    assert any("original_bytes absent" in f for f in cd.validate_readback(
        b, expected_prior_tick=None, operation_id="op-1", publisher_epoch=5))


def test_original_byte_mutation_detected():
    b = _bundle(tick=0)
    # Change spelling but keep parsed JSON equal → original_sha256/digests catch it.
    b["main"]["original_bytes"] = json.dumps({"tids": [0, 1], "gen": 0, "x": 0}).encode().decode()
    assert cd.validate_readback(b, expected_prior_tick=None, operation_id="op-1", publisher_epoch=5)


def test_jsonb_non_correspondence_detected():
    b = _bundle(tick=0)
    b["main"]["data"] = {"tids": [9, 9], "gen": 0}  # disagrees with original_bytes
    assert any("correspond" in f for f in cd.validate_readback(
        b, expected_prior_tick=None, operation_id="op-1", publisher_epoch=5))


def test_companion_caching_tick_rejected():
    b = _bundle(tick=0)
    b["bidtopid"]["caching_tick"] = 3
    assert any("companion must not carry a caching_tick" in f for f in cd.validate_readback(
        b, expected_prior_tick=None, operation_id="op-1", publisher_epoch=5))


def test_main_missing_caching_tick_rejected():
    b = _bundle(tick=0)
    b["main"].pop("caching_tick")
    assert any("caching_tick absent" in f for f in cd.validate_readback(
        b, expected_prior_tick=None, operation_id="op-1", publisher_epoch=5))


# ---------------------------------------------------------------------------
# Independent observer.
# ---------------------------------------------------------------------------
def test_observer_coherent_bundle():
    assert cd.observe_bundle_coherence(_bundle(tick=0)) == []


def test_observer_detects_mixed_generation():
    b = _bundle(tick=0)
    b["bidtopid"]["math_tick"] = 1
    assert any("different generation" in f for f in cd.observe_bundle_coherence(b))


def test_observer_injected_fold_runs():
    b = _bundle(tick=0)
    calls = {}

    def fold(main):
        calls["main"] = main
        return ["fold: synthetic finding"]

    fails = cd.observe_bundle_coherence(b, fold_check=fold)
    assert calls and any("synthetic finding" in f for f in fails)


def test_observer_fold_exception_is_a_finding_not_a_crash():
    b = _bundle(tick=0)

    def fold(_main):
        raise RuntimeError("boom")

    fails = cd.observe_bundle_coherence(b, fold_check=fold)
    assert any("boom" in f for f in fails)


def test_bundle_mutations_are_independent():
    # copy.deepcopy sanity: helper builds fresh bundles per call.
    a, b = _bundle(), _bundle()
    a["main"]["math_tick"] = 99
    assert b["main"]["math_tick"] == 0
    assert copy.deepcopy(a) == a


# ---------------------------------------------------------------------------
# Round 2 (board [398]) correction 4: readback false accepts, inverted.
# ---------------------------------------------------------------------------
def test_missing_jsonb_evidence_rejected():
    """Removing every table's `data` must fail (JSONB correspondence evidence
    is required), not pass."""
    b = _bundle(tick=0)
    for name in ("main", "bidtopid", "ptptstats"):
        del b[name]["data"]
    assert cd.validate_readback(b, expected_prior_tick=None, operation_id="op-1", publisher_epoch=5)


def test_boolean_math_ticks_rejected():
    b = _bundle(tick=0)
    for name in ("main", "bidtopid", "ptptstats", "ticks"):
        b[name]["math_tick"] = False
    fails = cd.validate_readback(b, expected_prior_tick=None, operation_id="op-1", publisher_epoch=5)
    assert any("non-boolean" in f for f in fails)


def test_publication_scope_absent_rejected():
    b = _bundle(tick=0)
    del b["zid"], b["math_env"]
    fails = cd.validate_readback(b, expected_prior_tick=None, operation_id="op-1", publisher_epoch=5)
    assert any("zid" in f for f in fails) and any("math_env" in f for f in fails)


def test_integer_vs_boolean_correspondence_rejected():
    """original `{"value":1}` vs JSONB `{"value":true}` must be a mismatch, not
    laundered by Python's 1 == True."""
    b = _bundle(tick=0)
    b["main"]["original_bytes"] = '{"value": 1}'
    b["main"]["original_sha256"] = __import__("hashlib").sha256(b'{"value": 1}').hexdigest()
    b["ticks"]["original_digests"]["main"] = b["main"]["original_sha256"]
    b["main"]["data"] = {"value": True}
    assert any("correspond" in f for f in cd.validate_readback(
        b, expected_prior_tick=None, operation_id="op-1", publisher_epoch=5))


def test_expected_zid_and_env_binding():
    b = _bundle(tick=0)
    assert cd.validate_readback(b, expected_prior_tick=None, operation_id="op-1",
                                publisher_epoch=5, expected_zid=1, expected_math_env="rustproto") == []
    assert cd.validate_readback(b, expected_prior_tick=None, operation_id="op-1",
                                publisher_epoch=5, expected_zid=999)
    assert cd.validate_readback(b, expected_prior_tick=None, operation_id="op-1",
                                publisher_epoch=5, expected_math_env="python")


def test_pg_numeric_normalization_still_allowed():
    """1 vs 1.0 is allowed PostgreSQL numeric normalization; only bool-vs-int is
    rejected."""
    b = _bundle(tick=0)
    b["main"]["original_bytes"] = '{"x": 1}'
    b["main"]["original_sha256"] = __import__("hashlib").sha256(b'{"x": 1}').hexdigest()
    b["ticks"]["original_digests"]["main"] = b["main"]["original_sha256"]
    b["main"]["data"] = {"x": 1.0}
    assert cd.validate_readback(b, expected_prior_tick=None, operation_id="op-1", publisher_epoch=5) == []


# ---------------------------------------------------------------------------
# Correction 5: observer false accepts, inverted.
# ---------------------------------------------------------------------------
def test_observer_rejects_absent_bundle():
    assert cd.observe_bundle_coherence({})


def test_observer_rejects_garbage_bid_mapping():
    b = _bundle(tick=0)
    b["main"]["data"] = {"base-clusters": {"members": [[0]]}}
    b["bidtopid"]["data"] = {"garbage": "not a bid-index-pid map"}
    assert any("bid->index->pid" in f for f in cd.observe_bundle_coherence(b))


def test_observer_requires_row_and_tick_presence():
    b = _bundle(tick=0)
    del b["ptptstats"]
    assert any("ptptstats" in f for f in cd.observe_bundle_coherence(b))
