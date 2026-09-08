"""P-045 slice 2 (half): four-row readback + independent observer validators.

Pure controls over synthetic readback bundles — no Postgres, no Rust binary. The
slice-3 N05/N10/N11 real-mutation controls (corrupt each table, sever a COMMIT,
substitute foreign-env rows) will drive THIS validator against a real Rust
publication; here it is graded on hand-built bundles and their mutations.

Round 3 (board [418]) corrections 2 and 1: readback binds the full
input_checkpoint and types the epoch; the observer models the ACTUAL
math_writer.derive_bidtopid wrapper shape.
"""

from __future__ import annotations

import copy
import hashlib
import json
from types import SimpleNamespace

from polismath.poller.math_writer import derive_bidtopid
from polismath.replay import coordinator_driver as cd


def _set(b, name, data):
    raw = json.dumps(data)
    b[name] = dict(b.get(name, {}), math_tick=b["ticks"]["math_tick"], data=data,
                   original_bytes=raw, original_sha256=hashlib.sha256(raw.encode()).hexdigest())
    b["ticks"]["original_digests"][name] = b[name]["original_sha256"]


def _bundle(tick=0, epoch=5, op="op-1"):
    """A coherent, REAL-shaped bundle: main carries base-clusters and bidtopid is
    the writer's {zid, bidToPid, lastVoteTimestamp} wrapper positionally aligned to
    it (derive_bidtopid), so observer AND readback grade it clean."""
    conv = SimpleNamespace(base_clusters=[{"id": 2, "members": [1, 2]},
                                          {"id": 8, "members": [3, 4]}], last_updated=1000)
    b = {"zid": 1, "math_env": "rustproto",
         "ticks": {"math_tick": tick, "caching_tick": 42, "publisher_epoch": epoch,
                   "operation_id": op, "original_digests": {}}}
    _set(b, "main", {"base-clusters": {"id": [2, 8], "members": [[1, 2], [3, 4]], "count": [2, 2]}})
    _set(b, "bidtopid", derive_bidtopid(conv, 1))
    _set(b, "ptptstats", {"1": {"a": 1}})
    b["main"]["caching_tick"] = 42
    return b


def _V(b, **kw):
    kw.setdefault("expected_prior_tick", None)
    kw.setdefault("operation_id", "op-1")
    kw.setdefault("publisher_epoch", 5)
    return cd.validate_readback(b, **kw)


def test_first_publication_tick_zero_passes():
    assert _V(_bundle(tick=0)) == []


def test_prior_to_next_tick():
    b = _bundle(tick=3)
    assert _V(b, expected_prior_tick=2) == []
    assert any("prior+1" in f for f in _V(b, expected_prior_tick=5))


def test_first_publication_must_be_zero():
    assert any("must be 0" in f for f in _V(_bundle(tick=1)))


def test_tick_disagreement_detected():
    b = _bundle(tick=0)
    b["bidtopid"]["math_tick"] = 1
    assert any("bidtopid" in f for f in _V(b))


def test_missing_companion_detected():
    b = _bundle(tick=0)
    b["ptptstats"] = {}
    assert any("ptptstats" in f for f in _V(b))


def test_wrong_epoch_and_operation_detected():
    b = _bundle(tick=0)
    fails = _V(b, operation_id="OTHER", publisher_epoch=99)
    assert any("operation_id" in f for f in fails) and any("publisher_epoch" in f for f in fails)


def test_data_text_is_not_original_evidence():
    b = _bundle(tick=0)
    b["main"].pop("original_bytes")
    assert any("original_bytes absent" in f for f in _V(b))


def test_original_byte_mutation_detected():
    b = _bundle(tick=0)
    b["main"]["original_bytes"] = json.dumps({"base-clusters": {"id": [2, 8], "x": 0}})
    assert _V(b)


def test_jsonb_non_correspondence_detected():
    b = _bundle(tick=0)
    b["main"]["data"] = {"base-clusters": {"id": [9, 9]}}  # disagrees with original_bytes
    assert any("correspond" in f for f in _V(b))


def test_companion_caching_tick_rejected():
    b = _bundle(tick=0)
    b["bidtopid"]["caching_tick"] = 3
    assert any("companion must not carry a caching_tick" in f for f in _V(b))


def test_main_missing_caching_tick_rejected():
    b = _bundle(tick=0)
    b["main"].pop("caching_tick")
    assert any("caching_tick absent" in f for f in _V(b))


# ---------------------------------------------------------------------------
# Round 2 correction 4 (kept): readback false accepts.
# ---------------------------------------------------------------------------
def test_missing_jsonb_evidence_rejected():
    b = _bundle(tick=0)
    for name in ("main", "bidtopid", "ptptstats"):
        del b[name]["data"]
    assert _V(b)


def test_boolean_math_ticks_rejected():
    b = _bundle(tick=0)
    for name in ("main", "bidtopid", "ptptstats", "ticks"):
        b[name]["math_tick"] = False
    assert any("non-boolean" in f for f in _V(b))


def test_publication_scope_absent_rejected():
    b = _bundle(tick=0)
    del b["zid"], b["math_env"]
    fails = _V(b)
    assert any("zid" in f for f in fails) and any("math_env" in f for f in fails)


def test_integer_vs_boolean_correspondence_rejected():
    b = _bundle(tick=0)
    _set(b, "main", {"value": 1})
    b["main"]["caching_tick"] = 42
    b["main"]["data"] = {"value": True}
    assert any("correspond" in f for f in _V(b))


def test_expected_zid_and_env_binding():
    b = _bundle(tick=0)
    assert _V(b, expected_zid=1, expected_math_env="rustproto") == []
    assert _V(b, expected_zid=999)
    assert _V(b, expected_math_env="python")


def test_pg_numeric_normalization_still_allowed():
    b = _bundle(tick=0)
    _set(b, "main", {"x": 1})
    b["main"]["caching_tick"] = 42
    b["main"]["data"] = {"x": 1.0}
    assert _V(b) == []


# ---------------------------------------------------------------------------
# Round 3 correction 2: epoch typing + full input_checkpoint custody.
# ---------------------------------------------------------------------------
def test_boolean_epoch_rejected_against_integer_one():
    b = _bundle(tick=0)
    b["ticks"]["publisher_epoch"] = True
    assert any("publisher_epoch" in f for f in _V(b, publisher_epoch=1))


def test_foreign_input_checkpoint_rejected():
    b = _bundle(tick=0)
    b["ticks"]["input_checkpoint"] = {"foreign": True}
    assert any("input_checkpoint" in f for f in _V(b))


def test_coherent_input_checkpoint_accepted_and_bound():
    b = _bundle(tick=0)
    ckpt = {"operation_id": "op-1", "original_digests": b["ticks"]["original_digests"]}
    b["ticks"]["input_checkpoint"] = ckpt
    assert _V(b) == []
    assert _V(b, expected_input_checkpoint=ckpt) == []
    assert _V(b, expected_input_checkpoint={"operation_id": "op-1", "original_digests": {}})


def test_input_checkpoint_operation_mismatch_rejected():
    b = _bundle(tick=0)
    b["ticks"]["input_checkpoint"] = {"operation_id": "WRONG"}
    assert any("operation_id" in f for f in _V(b))


# ---------------------------------------------------------------------------
# Round 3 correction 1: observer models the ACTUAL derive_bidtopid wrapper.
# ---------------------------------------------------------------------------
def test_observer_accepts_real_writer_wrapper():
    assert cd.observe_bundle_coherence(_bundle(tick=0)) == []


def test_observer_accepts_valid_empty_generation():
    b = _bundle(tick=0)
    _set(b, "main", {"base-clusters": {"id": [], "members": [], "count": []}})
    b["main"]["caching_tick"] = 42
    _set(b, "bidtopid", derive_bidtopid(SimpleNamespace(base_clusters=[], last_updated=0), 1))
    assert cd.observe_bundle_coherence(b) == []


def test_observer_rejects_unrelated_invented_map():
    b = _bundle(tick=0)
    _set(b, "bidtopid", {"2": [999], "8": [1]})
    assert any("writer wrapper" in f for f in cd.observe_bundle_coherence(b))


def test_observer_rejects_overlapping_duplicate_buckets():
    b = _bundle(tick=0)
    _set(b, "bidtopid", {"2": [1, 1], "8": [1]})
    assert cd.observe_bundle_coherence(b)


def test_observer_rejects_positional_membership_mismatch():
    b = _bundle(tick=0)
    _set(b, "bidtopid", {"zid": 1, "bidToPid": [[9, 9], [3, 4]], "lastVoteTimestamp": 1000})
    assert any("positional bid membership mismatch" in f for f in cd.observe_bundle_coherence(b))


def test_observer_rejects_bidtopid_zid_mismatch():
    b = _bundle(tick=0)
    d = derive_bidtopid(SimpleNamespace(base_clusters=[{"id": 2, "members": [1, 2]},
                                                       {"id": 8, "members": [3, 4]}], last_updated=1000), 999)
    _set(b, "bidtopid", d)
    assert any("zid" in f for f in cd.observe_bundle_coherence(b))


def test_observer_rejects_absent_bundle():
    assert cd.observe_bundle_coherence({})


def test_observer_detects_mixed_generation():
    b = _bundle(tick=0)
    b["bidtopid"]["math_tick"] = 1
    assert any("different generation" in f for f in cd.observe_bundle_coherence(b))


def test_observer_requires_row_presence():
    b = _bundle(tick=0)
    del b["ptptstats"]
    assert any("ptptstats" in f for f in cd.observe_bundle_coherence(b))


def test_observer_injected_fold_runs():
    b = _bundle(tick=0)
    calls = {}

    def fold(main):
        calls["main"] = main
        return ["fold: synthetic finding"]

    fails = cd.observe_bundle_coherence(b, fold_check=fold)
    assert calls and any("synthetic finding" in f for f in fails)


def test_observer_fold_exception_is_a_finding_not_a_crash():
    def fold(_main):
        raise RuntimeError("boom")

    assert any("boom" in f for f in cd.observe_bundle_coherence(_bundle(tick=0), fold_check=fold))


def test_bundle_mutations_are_independent():
    a, b = _bundle(), _bundle()
    a["main"]["math_tick"] = 99
    assert b["main"]["math_tick"] == 0
    assert copy.deepcopy(a) == a
