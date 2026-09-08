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

import pytest

from polismath.poller.math_writer import derive_bidtopid
from polismath.replay import coordinator_driver as cd


def _canon(data):
    # Delegate to the ported Rust storage_digest (no duplicate implementation).
    return cd._canonical_payload_digest(data)


def _set(b, name, data):
    raw = json.dumps(data)
    dg = hashlib.sha256(raw.encode()).hexdigest()
    b[name] = dict(b.get(name, {}), math_tick=b["ticks"]["math_tick"], data=data,
                   original_bytes=raw, original_sha256=dg)
    b["ticks"]["original_digests"][name] = dg
    ckpt = b["ticks"].get("input_checkpoint")
    if isinstance(ckpt, dict):  # keep the store checkpoint's digests in sync
        if isinstance(ckpt.get("original_digests"), dict):
            ckpt["original_digests"][name] = dg
        if isinstance(ckpt.get("payload_digests"), dict):
            ckpt["payload_digests"][name] = _canon(data)


def _bundle(tick=0, epoch=5, op="op-1"):
    """A coherent, REAL-shaped bundle: main carries base-clusters and bidtopid is
    the writer's {zid, bidToPid, lastVoteTimestamp} wrapper positionally aligned to
    it (derive_bidtopid), plus a full polis-coordinator/1 store input_checkpoint
    (schema, operation, epoch, original + canonical payload digests, cursors) — so
    observer AND readback grade it clean."""
    conv = SimpleNamespace(base_clusters=[{"id": 2, "members": [1, 2]},
                                          {"id": 8, "members": [3, 4]}], last_updated=1000)
    b = {"zid": 1, "math_env": "rustproto",
         "ticks": {"math_tick": tick, "caching_tick": 42, "publisher_epoch": epoch,
                   "operation_id": op, "original_digests": {}}}
    _set(b, "main", {"base-clusters": {"id": [2, 8], "members": [[1, 2], [3, 4]], "count": [2, 2]}})
    _set(b, "bidtopid", derive_bidtopid(conv, 1))
    _set(b, "ptptstats", {"1": {"a": 1}})
    b["main"]["caching_tick"] = 42
    b["ticks"]["input_checkpoint"] = {
        "schema": "polis-coordinator/1", "operation_id": op, "publisher_epoch": epoch,
        "original_digests": dict(b["ticks"]["original_digests"]),
        "payload_digests": {n: _canon(b[n]["data"]) for n in ("main", "bidtopid", "ptptstats")},
        "cursors": {"votes": {"slot": 0, "sha256": "a" * 64},
                    "moderation": {"slot": 0, "sha256": "b" * 64}},
    }
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
    b["ticks"]["input_checkpoint"]["payload_digests"]["main"] = _canon({"x": 1.0})
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
    b = _bundle(tick=0)  # already carries a full valid store checkpoint
    ckpt = b["ticks"]["input_checkpoint"]
    assert _V(b) == []
    assert _V(b, expected_input_checkpoint=dict(ckpt)) == []
    assert _V(b, expected_input_checkpoint=dict(ckpt, operation_id="OTHER"))


def test_input_checkpoint_operation_mismatch_rejected():
    b = _bundle(tick=0)
    b["ticks"]["input_checkpoint"]["operation_id"] = "WRONG"
    assert any("operation_id" in f for f in _V(b))


# ---------------------------------------------------------------------------
# Round 4 correction 2: persisted store-checkpoint custody + typed cursors.
# ---------------------------------------------------------------------------
def test_absent_input_checkpoint_rejected():
    b = _bundle(tick=0)
    del b["ticks"]["input_checkpoint"]
    assert any("input_checkpoint" in f and "required" in f for f in _V(b))


def test_operation_only_checkpoint_rejected():
    b = _bundle(tick=0)
    b["ticks"]["input_checkpoint"] = {"operation_id": "op-1"}
    assert _V(b)  # missing schema/original_digests/cursors


def test_wrong_store_checkpoint_schema_rejected():
    b = _bundle(tick=0)
    b["ticks"]["input_checkpoint"]["schema"] = "polis-candidate-checkpoint/1"
    assert any("input_checkpoint.schema" in f for f in _V(b))


def test_boolean_cursor_slot_rejected():
    """A boolean cursor slot must not equal an expected integer checkpoint."""
    b = _bundle(tick=0)
    expected = {k: (dict(v) if isinstance(v, dict) else v)
                for k, v in b["ticks"]["input_checkpoint"].items()}
    expected["cursors"] = {"votes": {"slot": 1}, "moderation": {"slot": 0}}
    b["ticks"]["input_checkpoint"]["cursors"]["votes"]["slot"] = True
    # rejected both by cursor typing and by type-aware expected equality
    assert _V(b)
    assert _V(b, expected_input_checkpoint=expected)


def test_input_checkpoint_original_digests_mismatch_rejected():
    b = _bundle(tick=0)
    b["ticks"]["input_checkpoint"]["original_digests"] = {"main": "0" * 64}
    assert any("original_digests" in f for f in _V(b))


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
    fails = cd.observe_bundle_coherence(b)
    assert fails and any("bidtopid" in f for f in fails)


def _real_bundle_with(main_base, groups=None):
    """A bundle whose main.base-clusters is `main_base` and whose bidtopid wrapper
    is positionally derived from the same members — so a shape/positional check
    passes and only the membership INVARIANTS decide the verdict."""
    b = _bundle(tick=0)
    main = {"base-clusters": main_base}
    if groups is not None:
        main["group-clusters"] = groups
    ids, members = main_base["id"], main_base["members"]
    conv = SimpleNamespace(base_clusters=[{"id": i, "members": m} for i, m in zip(ids, members)],
                           last_updated=1000)
    _set(b, "main", main)
    b["main"]["caching_tick"] = 42
    _set(b, "bidtopid", derive_bidtopid(conv, 1))
    return b


def test_observer_rejects_duplicate_and_overlapping_real_buckets():
    """Round 4 correction 1, on the REAL wrapper: `[[1,1],[1,4]]` has an intra-
    bucket duplicate AND a participant (1) in two buckets."""
    b = _real_bundle_with({"id": [2, 8], "members": [[1, 1], [1, 4]], "count": [2, 2]})
    assert pub_reject(b)


def test_observer_rejects_wrong_base_counts():
    b = _real_bundle_with({"id": [2, 8], "members": [[1, 2], [3, 4]], "count": [999, 0]})
    assert any("count" in f for f in cd.observe_bundle_coherence(b))


def test_observer_rejects_duplicate_base_ids():
    b = _real_bundle_with({"id": [2, 2], "members": [[1, 2], [3, 4]], "count": [2, 2]})
    assert any("base-clusters.id has duplicates" in f for f in cd.observe_bundle_coherence(b))


def test_observer_rejects_unknown_group_bid():
    b = _real_bundle_with({"id": [2, 8], "members": [[1, 2], [3, 4]], "count": [2, 2]},
                          groups=[{"id": 0, "members": [999]}])
    assert any("unknown base bid" in f for f in cd.observe_bundle_coherence(b))


def test_observer_accepts_valid_group_reference():
    b = _real_bundle_with({"id": [2, 8], "members": [[1, 2], [3, 4]], "count": [2, 2]},
                          groups=[{"id": 0, "members": [2, 8]}])
    assert cd.observe_bundle_coherence(b) == []


def pub_reject(b):
    return cd.observe_bundle_coherence(b) != []


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


# ---------------------------------------------------------------------------
# Round 5 (board [440]): total membership admission — graded, never a TypeError.
# ---------------------------------------------------------------------------
def _obs_reject(main):
    b = _bundle(tick=0)
    _set(b, "main", main)
    assert _V(b) == [], "byte custody must still pass"
    return cd.observe_bundle_coherence(b)


def _main_base(**over):
    base = {"id": [2, 8], "members": [[1, 2], [3, 4]], "count": [2, 2]}
    base.update(over)
    return {"base-clusters": base}


def test_observer_rejects_boolean_main_pid():
    # main members [True,2] must not alias companion integer [1,2] via 1==True
    m = _main_base(members=[[True, 2], [3, 4]])
    assert _obs_reject(m)


@pytest.mark.parametrize("groups", [
    [{"id": 0, "members": [2.0]}],   # float bid aliases integer base id
    {},                              # wrong container (not a list)
    [7],                             # scalar group row (not an object)
])
def test_observer_rejects_malformed_groups(groups):
    m = _main_base()
    m["group-clusters"] = groups
    assert _obs_reject(m)


@pytest.mark.parametrize("mutate", [
    lambda m: m["base-clusters"].__setitem__("members", [7, [3, 4]]),   # scalar membership (was TypeError)
    lambda m: m.__setitem__("group-clusters", [{"id": 0, "members": [[]]}]),  # unhashable bid (was TypeError)
])
def test_observer_total_admission_never_raises(mutate):
    m = _main_base()
    mutate(m)
    # must be a graded rejection, not an exception
    fails = _obs_reject(m)
    assert fails


# ---------------------------------------------------------------------------
# Round 5: persisted checkpoint epoch / canonical-digest / cursor binding.
# ---------------------------------------------------------------------------
def test_checkpoint_missing_epoch_or_payload_digests_rejected():
    for field in ("publisher_epoch", "payload_digests"):
        b = _bundle(tick=0)
        b["ticks"]["input_checkpoint"].pop(field)
        assert _V(b, expected_input_checkpoint=copy.deepcopy(b["ticks"]["input_checkpoint"])), field


def test_checkpoint_foreign_embedded_epoch_rejected():
    b = _bundle(tick=0)
    b["ticks"]["input_checkpoint"]["publisher_epoch"] = 999
    assert any("publisher_epoch" in f for f in _V(b, expected_input_checkpoint=copy.deepcopy(b["ticks"]["input_checkpoint"])))


def test_checkpoint_wrong_payload_digests_rejected():
    b = _bundle(tick=0)
    b["ticks"]["input_checkpoint"]["payload_digests"] = {"main": "bad"}
    assert any("payload_digests" in f for f in _V(b, expected_input_checkpoint=copy.deepcopy(b["ticks"]["input_checkpoint"])))


def test_checkpoint_unknown_cursor_stream_rejected():
    b = _bundle(tick=0)
    b["ticks"]["input_checkpoint"]["cursors"] = {"unrelated": {"slot": 0}}
    assert _V(b, expected_input_checkpoint=copy.deepcopy(b["ticks"]["input_checkpoint"]))


# ---------------------------------------------------------------------------
# Round 6 (board [445]): graded outer-container admission; store digest / cursors.
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("bad", [None, [], "x", 7])
def test_readback_nonobject_bundle_is_graded(bad):
    fails = cd.validate_readback(bad, expected_prior_tick=None, operation_id="op-1", publisher_epoch=5)
    assert isinstance(fails, list) and fails and all(isinstance(f, str) for f in fails)


@pytest.mark.parametrize("bad", [None, [], "x", 7])
def test_observer_nonobject_bundle_is_graded(bad):
    fails = cd.observe_bundle_coherence(bad)
    assert isinstance(fails, list) and fails


def test_readback_nonobject_row_is_graded():
    fails = _V(dict(_bundle(), main=[1]))       # a list-valued row must not crash
    assert fails and all(isinstance(f, str) for f in fails)


def test_observer_nonobject_row_is_graded():
    assert cd.observe_bundle_coherence(dict(_bundle(), main=[1]))


@pytest.mark.parametrize("obj", [{"x": 1.0}, {"x": -0.0}, {"x": 1e-7}, {"x": "é"}])
def test_store_bound_normalized_digest_accepted(obj):
    """The ported digest normalizes PG-equal numbers and Unicode exactly like the
    Rust store, so a store-bound checkpoint digest for a normalized payload is
    ACCEPTED (was rejected under compact-JSON hashing)."""
    b = _bundle(tick=0)
    _set(b, "main", obj)
    b["main"]["caching_tick"] = 42
    assert _V(b) == []
    # the checkpoint digest equals the ported (store) digest
    assert b["ticks"]["input_checkpoint"]["payload_digests"]["main"] == cd._canonical_payload_digest(obj)


def test_digest_normalizes_one_and_one_point_zero_and_negative_zero():
    assert cd._canonical_payload_digest({"x": 1}) == cd._canonical_payload_digest({"x": 1.0})
    assert cd._canonical_payload_digest({"x": 0}) == cd._canonical_payload_digest({"x": -0.0})
    # ...but distinct from a genuinely different number
    assert cd._canonical_payload_digest({"x": 1}) != cd._canonical_payload_digest({"x": 2})


@pytest.mark.parametrize("mutate", [
    lambda c: c["cursors"]["votes"].pop("sha256"),   # missing stored cursor hash
    lambda c: c["cursors"]["votes"].__setitem__("sha256", []),  # malformed
    lambda c: c["cursors"]["votes"].__setitem__("sha256", "x" * 63),  # not 64-hex
])
def test_store_cursor_hash_required_and_typed(mutate):
    b = _bundle(tick=0)
    mutate(b["ticks"]["input_checkpoint"])
    assert _V(b, expected_input_checkpoint=copy.deepcopy(b["ticks"]["input_checkpoint"]))


# ---------------------------------------------------------------------------
# Round 7 (board [449]): every remaining row dereference is graded, not raised.
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("row,value", [
    ("ticks", [1]), ("bidtopid", [1]), ("ptptstats", [1]), ("main", 7),
    ("ticks", 7), ("bidtopid", "x"), ("ptptstats", None),
])
def test_readback_malformed_row_is_graded_not_raised(row, value):
    b = _bundle()
    b[row] = value
    fails = _V(b)  # must not raise
    assert isinstance(fails, list) and fails and all(isinstance(f, str) for f in fails)


@pytest.mark.parametrize("row,value", [
    ("ticks", [1]), ("bidtopid", [1]), ("ptptstats", [1]), ("main", 7),
])
def test_observer_malformed_row_is_graded_not_raised(row, value):
    b = _bundle()
    b[row] = value
    assert cd.observe_bundle_coherence(b)  # graded, no exception


def test_integer_boundary_digest_is_serde_dispatched():
    """Python ints beyond i64/u64 take serde's f64 representation, so 2**64 and
    2**64+1 (both f64 -> same value) share a digest distinct from the exact int
    string; u64::MAX and i64::MIN stay exact."""
    assert cd._canonical_payload_digest({"x": 2 ** 64}) == cd._canonical_payload_digest({"x": 2 ** 64 + 1})
    assert cd._canonical_payload_digest({"x": 2 ** 64 - 1}) != cd._canonical_payload_digest({"x": 2 ** 64})
    # exact integers in range are byte-for-byte their decimal spelling
    assert cd._canonical_payload_digest(2 ** 64 - 1) != cd._canonical_payload_digest(2 ** 64)
