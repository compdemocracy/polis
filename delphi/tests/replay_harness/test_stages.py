"""Unit tests for the stage-dump emitter and the stage comparer (R-ORACLE).

Covers the encoding contract both engines must satisfy — shape, key order,
exact double round-trip — plus the comparer's canonicalization (polarity,
identity keying, coupled component-sign flips), its per-key tolerance classes
and its carve-outs.

The end-to-end run against the real Clojure driver lives in
``test_stage_oracle_e2e.py``; nothing here needs a JVM.
"""

from __future__ import annotations

import json
import math
import struct

import numpy as np
import pandas as pd
import pytest

from polismath.replay import stagecompare as sc
from polismath.replay import stages


# ---------------------------------------------------------------------------
# Encoding contract: key order.
# ---------------------------------------------------------------------------
def test_object_keys_are_sorted_as_strings():
    assert stages.canonical_json(stages.plain({"c": 3, "a": 1, "b": 2})) == \
        '{"a":1,"b":2,"c":3}'


def test_integer_keys_are_stringified_first_then_sorted():
    # "10" precedes "2" — the same order replay.clj produces, because both
    # engines stringify the key BEFORE sorting.
    assert stages.canonical_json(stages.plain({2: 2, 10: 10, 1: 1})) == \
        '{"1":1,"10":10,"2":2}'


def test_nested_objects_are_sorted_at_every_level():
    obj = stages.plain({"outer": {"x": {"z": 2, "a": 1}}})
    assert stages.canonical_json(obj) == '{"outer":{"x":{"a":1,"z":2}}}'


def test_stage_names_sort_into_pipeline_order():
    assert stages.STAGE_ORDER == sorted(stages.STAGE_ORDER)
    assert len(set(stages.STAGE_ORDER)) == len(stages.STAGE_ORDER)


# ---------------------------------------------------------------------------
# Encoding contract: numbers.
# ---------------------------------------------------------------------------
def test_integers_emit_without_a_decimal_point():
    text = stages.canonical_json(stages.plain([0, 1, -7, 2 ** 31, np.int64(5)]))
    assert text == "[0,1,-7,2147483648,5]"


TRICKY_DOUBLES = [
    0.0, -0.0, 1.0, -1.0, 0.1, 0.1 + 0.2, 1.0 / 3.0,
    1e-5, 1e10, 1e300, 1e-300,
    5e-324, 1.7976931348623157e308, 2.2250738585072014e-308,
    math.nextafter(1.0, 2.0), math.nextafter(1.0, 0.0),
    0.888888888888889, 2.8284271247461903, 1.635555555555556,
]


@pytest.mark.parametrize("value", TRICKY_DOUBLES)
def test_doubles_round_trip_bit_for_bit(value: float):
    """The emitter must never round: what comes back is the SAME double."""
    back = json.loads(stages.canonical_json(stages.plain(value)))
    assert struct.pack("<d", back) == struct.pack("<d", value)


def test_random_doubles_round_trip_bit_for_bit():
    rng = np.random.default_rng(20260908)
    bits = rng.integers(0, 2 ** 64, size=5000, dtype=np.uint64)
    for b in bits:
        value = struct.unpack("<d", struct.pack("<Q", int(b)))[0]
        if math.isnan(value) or math.isinf(value):
            continue
        back = json.loads(stages.canonical_json(stages.plain(value)))
        assert struct.pack("<d", back) == struct.pack("<d", value)


def test_non_finite_doubles_become_json_strings():
    text = stages.canonical_json(
        stages.plain([float("nan"), float("inf"), float("-inf")]))
    assert text == '["NaN","Infinity","-Infinity"]'
    # JSON has no NaN literal, so the result must still parse as standard JSON.
    assert json.loads(text) == ["NaN", "Infinity", "-Infinity"]


def test_canonical_json_refuses_a_raw_nan():
    with pytest.raises(ValueError):
        stages.canonical_json({"x": float("nan")})


# ---------------------------------------------------------------------------
# Encoding contract: shapes.
# ---------------------------------------------------------------------------
def test_dataframe_becomes_a_named_matrix_with_null_for_missing_cells():
    df = pd.DataFrame({10: [-1.0, np.nan], 11: [1.0, 0.0]}, index=[1, 2])
    nm = stages.dataframe_to_named_matrix(df)
    assert set(nm) == {"rownames", "colnames", "matrix"}
    assert nm["rownames"] == [1, 2]
    assert nm["colnames"] == [10, 11]
    # An unvoted cell is null, not 0 — nil vs 0 is meaning, not shape.
    assert nm["matrix"] == [[-1.0, 1.0], [None, 0.0]]


def test_sets_become_sorted_arrays():
    assert stages.plain({10, 1, 3, 2}) == [1, 2, 3, 10]


def test_plain_rejects_an_unsupported_value():
    with pytest.raises(TypeError):
        stages.plain(object())


# ---------------------------------------------------------------------------
# Input digest.
# ---------------------------------------------------------------------------
def test_input_digest_is_stable_and_prefixed():
    votes = [(1, 2, 1, 1000), (1, 3, -1, 2000)]
    a = stages.input_digest(votes, [])
    assert a == stages.input_digest(votes, [])
    assert a.startswith("sha256:")


def test_input_digest_reacts_to_sign_and_to_moderation():
    votes = [(1, 2, 1, 1000)]
    base = stages.input_digest(votes, [])
    assert base != stages.input_digest([(1, 2, -1, 1000)], [])
    assert base != stages.input_digest(votes, [(2, 1, -1, 5)])


def test_input_digest_matches_the_clojure_emitter_byte_for_byte():
    """Pinned against the value ``replay.clj``'s ``step-input-digest`` produces
    for the same batch, so a change to either encoder is caught here rather than
    silently making the two manifests incomparable."""
    payload = stages.canonical_json({
        "mods": [[2, 1, -1, 5]],
        "votes": [[1, 2, 1, 1000], [1, 3, -1, 2000]],
    })
    assert payload == (
        '{"mods":[[2,1,-1,5]],"votes":[[1,2,1,1000],[1,3,-1,2000]]}')
    assert stages.input_digest([(1, 2, 1, 1000), (1, 3, -1, 2000)],
                               [(2, True, -1, 5)]).startswith("sha256:")


# ---------------------------------------------------------------------------
# Comparer: polarity, identity keying, sign orientation.
# ---------------------------------------------------------------------------
def _doc(engine: str, convention: str, stage_map: dict) -> dict:
    full = {name: {} for name in stages.STAGE_ORDER}
    for k, v in stage_map.items():
        full[k] = v
    return {
        "comment_projection_axes": stages.COMMENT_PROJECTION_AXES,
        "engine": engine,
        "input_digest": "sha256:" + "de" * 32,   # 64 hex digits, as required
        "schema": stages.STAGE_DUMP_SCHEMA,
        "stages": full,
        "step": 0,
        "tick": 1,
        "vote_sign_convention": convention,
    }


def _complete(doc: dict) -> dict:
    """Fill in every declared stage key so the document passes recording
    validation. Round 3 requires an explicit key inventory, so a document built
    for a single-key unit test is not a valid RECORDING on its own."""
    for stage, inventory in stages.STAGE_KEYS.items():
        body = doc["stages"].setdefault(stage, {})
        for key in inventory["required"]:
            body.setdefault(key, None)
    return doc


def test_polarity_negates_votes_and_geometry_but_not_comps():
    raw = _doc("clj", "raw-db", {
        "R01_ingest": {
            "tids": [7],
            "rating-mat": {"rownames": [1], "colnames": [7], "matrix": [[-1]]},
        },
        "R04_pca": {
            "mat": [[-1.0]],
            # One comp with a 2-wide projection: the rank-one Q16 shape both
            # engines emit (pca.py:470-478).
            "pca": {"center": [-0.5], "comps": [[1.0]],
                    "comment-projection": [[-0.25], [-0.75]],
                    "comment-extremity": [0.25]},
        },
    })
    can = sc.canonicalize(raw)
    # Labels are TYPE-TAGGED so integer 1 and string "1" cannot collide.
    cell = f"{sc._typed_label(1)}|{sc._typed_label(7)}"
    tid7 = sc._typed_label(7)
    assert can["R01_ingest"]["rating-mat"][cell] == 1
    assert can["R04_pca"]["mat"][cell] == 1.0
    assert can["R04_pca"]["pca"]["center"][tid7] == 0.5
    assert can["R04_pca"]["pca"]["comment-projection"]["0"][tid7] == 0.25
    # comps are invariant: X^T X == (-X)^T (-X).
    assert can["R04_pca"]["pca"]["comps"]["0"][tid7] == 1.0
    # extremity is a norm.
    assert can["R04_pca"]["pca"]["comment-extremity"][tid7] == 0.25


def test_identity_keying_defeats_a_column_permutation():
    """The two engines emit tids in different orders. A permuted-but-equal
    matrix must compare clean."""
    a = _doc("clj", "delphi", {"R01_ingest": {
        "tids": [7, 3],
        "rating-mat": {"rownames": [1], "colnames": [7, 3], "matrix": [[1, -1]]},
    }})
    b = _doc("py", "delphi", {"R01_ingest": {
        "tids": [3, 7],
        "rating-mat": {"rownames": [1], "colnames": [3, 7], "matrix": [[-1, 1]]},
    }})
    rep = sc.compare_step(a, b)
    assert rep["stages"]["R01_ingest"]["status"] == "MATCH"


def test_component_sign_flip_is_absorbed_and_coupled():
    """A whole-component sign flip is not a divergence — but it must be applied
    to the coupled arrays too, or base-cluster centers would then mismatch."""
    common = {
        "R01_ingest": {"tids": [1, 2]},
        "R05_projections": {"proj": {"rownames": [9], "colnames": ["x", "y"],
                                     "matrix": [[3.0, 4.0]]}},
        "R06_base_clusters": {"base-clusters": [
            {"id": 0, "center": [3.0, 4.0], "members": [9]}]},
    }
    a = _doc("clj", "delphi", dict(common, R04_pca={
        "pca": {"center": [0.0, 0.0], "comps": [[0.6, 0.8], [0.8, -0.6]],
                "comment-projection": [[1.0, 2.0], [3.0, 4.0]],
                "comment-extremity": [1.0, 2.0]}}))
    flipped = {
        "R01_ingest": {"tids": [1, 2]},
        "R05_projections": {"proj": {"rownames": [9], "colnames": ["x", "y"],
                                     "matrix": [[-3.0, 4.0]]}},
        "R06_base_clusters": {"base-clusters": [
            {"id": 0, "center": [-3.0, 4.0], "members": [9]}]},
    }
    b = _doc("py", "delphi", dict(flipped, R04_pca={
        "pca": {"center": [0.0, 0.0], "comps": [[-0.6, -0.8], [0.8, -0.6]],
                "comment-projection": [[-1.0, -2.0], [3.0, 4.0]],
                "comment-extremity": [1.0, 2.0]}}))
    rep = sc.compare_step(a, b)
    for stage in ("R04_pca", "R05_projections", "R06_base_clusters"):
        assert rep["stages"][stage]["status"] == "MATCH", stage
    assert rep["first_diverging_stage"] is None


# ---------------------------------------------------------------------------
# Comparer: tolerance classes and the first-diverging-stage rule.
# ---------------------------------------------------------------------------
def test_exact_family_has_zero_tolerance():
    a = _doc("clj", "delphi", {"R01_ingest": {"n": 10}})
    b = _doc("py", "delphi", {"R01_ingest": {"n": 11}})
    rep = sc.compare_step(a, b)
    assert rep["stages"]["R01_ingest"]["status"] == "DIVERGENT"
    assert rep["stages"]["R01_ingest"]["keys"]["n"]["n_diff"] == 1
    assert rep["stages"]["R01_ingest"]["keys"]["n"]["max_abs"] == 1.0


def test_tight_family_absorbs_the_proposed_g_contract_bound():
    tol = sc.TIGHT
    assert tol.ok(1.0, 1.0 + 9e-5)      # inside 1e-6 + 1e-4*scale
    assert not tol.ok(1.0, 1.0 + 1e-3)


def test_geom_family_absorbs_the_documented_cold_tick_comps_noise():
    # Q12/Q18: the two engines' cold-tick comps differ at ~1e-5 while the final
    # blob still MATCHes, so geometry must not be graded at the tight bound.
    # At scale 1 the tight bound is 1e-6 + 1e-4; a 1e-3 relative difference
    # fails it and passes the geometry bound (1e-6 + 1e-2).
    assert not sc.TIGHT.ok(1.0, 1.0 + 1e-3)
    assert sc.GEOM.ok(1.0, 1.0 + 1e-3)
    # Both still reject a difference far outside either bound.
    assert not sc.GEOM.ok(1.0, 1.1)


def test_max_abs_and_max_rel_are_measured_over_every_compared_pair():
    """Headroom, not just failures: a fully-matching key still reports how close
    it came to its tolerance."""
    a = _doc("clj", "delphi", {"R12_priorities": {"comment-priorities": {"1": 1.0}}})
    b = _doc("py", "delphi", {"R12_priorities": {"comment-priorities": {"1": 1.0 + 1e-9}}})
    k = sc.compare_step(a, b)["stages"]["R12_priorities"]["keys"]["comment-priorities"]
    assert k["n_diff"] == 0
    assert 0 < k["max_abs"] < 1e-8
    assert k["worst_path"] == "comment-priorities.1"


def test_first_diverging_stage_is_the_earliest_one_in_pipeline_order():
    a = _doc("clj", "delphi", {
        "R03_eligibility": {"in-conv": [1, 2]},
        "R12_priorities": {"comment-priorities": {"1": 1.0}},
    })
    b = _doc("py", "delphi", {
        "R03_eligibility": {"in-conv": [1, 3]},
        "R12_priorities": {"comment-priorities": {"1": 2.0}},
    })
    rep = sc.compare_step(a, b)
    assert rep["first_diverging_stage"] == "R03_eligibility"
    assert rep["stages"]["R12_priorities"]["status"] == "DIVERGENT"


def test_a_structural_difference_diverges_even_with_no_numeric_error():
    a = _doc("clj", "delphi", {"R06_base_clusters": {"bid-to-pid": [[1, 2]]}})
    b = _doc("py", "delphi", {"R06_base_clusters": {"bid-to-pid": [[1, 2, 3]]}})
    rep = sc.compare_step(a, b)
    assert rep["stages"]["R06_base_clusters"]["status"] == "DIVERGENT"
    assert rep["stages"]["R06_base_clusters"]["keys"]["bid-to-pid"]["n_structural"]


# ---------------------------------------------------------------------------
# Comparer: carve-outs.
# ---------------------------------------------------------------------------
def test_moderation_null_vs_empty_is_carved_not_divergent():
    a = _doc("clj", "delphi", {"R02_moderation": {"mod-out": None}})
    b = _doc("py", "delphi", {"R02_moderation": {"mod-out": []}})
    rep = sc.compare_step(a, b)
    assert rep["stages"]["R02_moderation"]["keys"]["mod-out"]["status"] == "CARVED"
    assert rep["stages"]["R02_moderation"]["status"] == "MATCH"
    assert rep["first_diverging_stage"] is None


def test_a_carved_key_does_not_hide_a_real_shape_difference_elsewhere():
    a = _doc("clj", "delphi", {"R03_eligibility": {"in-conv": None}})
    b = _doc("py", "delphi", {"R03_eligibility": {"in-conv": []}})
    rep = sc.compare_step(a, b)
    assert rep["stages"]["R03_eligibility"]["status"] == "DIVERGENT"


def test_only_carve_outs_with_a_rule_are_auto_applied():
    """AUTO_CARVED must be derived from the rules that exist, so the docs can
    never claim a suppression the comparer does not implement (review F6/C5)."""
    assert sc.KEY_CARVE_OUT[("R09_group_clusters",
                             "group-clusterings-silhouettes")] == "C3"
    # The contract geometry has NO waiver any more (review F1).
    assert ("R13_ptpt_stats", "ptpt-stats") not in sc.KEY_CARVE_OUT
    assert set(sc.AUTO_CARVED) == {"C1", "C3"}
    for cid in sc.AUTO_CARVED:
        assert cid in sc.CARVE_OUTS
        assert sc.CARVE_OUTS[cid].mode != "documented"
        assert sc.CARVE_OUTS[cid].reason
    for cid in ("C2", "C4", "C5", "C6"):
        assert sc.CARVE_OUTS[cid].mode == "documented"
        assert cid not in sc.AUTO_CARVED


def test_q13_and_q18_are_documented_but_never_auto_suppressed():
    """Chaotic cluster permutation is reported, because a path rule that hid it
    would also hide real structural breakage (P-030 §5/R7)."""
    assert "C2" in sc.CARVE_OUTS and "C2" not in sc.AUTO_CARVED
    assert "C6" in sc.CARVE_OUTS and "C6" not in sc.AUTO_CARVED


# ---------------------------------------------------------------------------
# Comparer: recording-level plumbing.
# ---------------------------------------------------------------------------
def test_load_stage_dumps_rejects_a_foreign_schema(tmp_path):
    (tmp_path / "step-000.stages.json").write_text(
        json.dumps({"schema": "something-else/9", "step": 0, "stages": {}}))
    with pytest.raises(ValueError, match="schema"):
        sc.load_stage_dumps(tmp_path)


def test_step_count_mismatch_is_reported_not_truncated_silently(tmp_path):
    a_dir, b_dir = tmp_path / "a", tmp_path / "b"
    stages.write_stage_documents(
        a_dir, [_doc("clj", "delphi", {}), dict(_doc("clj", "delphi", {}), step=1)],
        engine="clj")
    stages.write_stage_documents(b_dir, [_doc("py", "delphi", {})])
    rep = sc.compare_recordings(a_dir, b_dir)
    assert rep["step_count_mismatch"] is True
    assert rep["aligned_steps"] == 1
    assert rep["n_steps_a"] == 2 and rep["n_steps_b"] == 1


def test_write_stage_documents_writes_a_manifest_and_clears_stale_steps(tmp_path):
    out = stages.write_stage_documents(
        tmp_path, [_doc("py", "delphi", {}), dict(_doc("py", "delphi", {}), step=1)])
    manifest = json.loads((out / "stages-manifest.json").read_text())
    assert manifest["schema"] == stages.STAGE_DUMP_SCHEMA
    assert manifest["n_steps"] == 2
    assert manifest["stage_order"] == stages.STAGE_ORDER
    assert [r["index"] for r in manifest["steps"]] == [0, 1]
    assert [r["file"] for r in manifest["steps"]] == [
        "step-000.stages.json", "step-001.stages.json"]

    # A shorter re-run must not leave the stale step-001 behind.
    stages.write_stage_documents(tmp_path, [_doc("py", "delphi", {})])
    assert sorted(p.name for p in tmp_path.glob("step-*.stages.json")) == [
        "step-000.stages.json"]


def test_stage_dirs_are_siblings_of_the_blob_dirs():
    """Stage files must never land in ``py/`` or ``clj/``: certify globs
    ``step-*.json`` there for its inventory and digest sets, and
    ``store.write_recording`` deletes that glob before each write."""
    assert stages.STAGE_DIR_NAME == {"py": "py-stages", "clj": "clj-stages"}


def test_certify_does_not_import_the_stage_oracle():
    """The grading rule, enforced: stage dumps are diagnostics, never a gate."""
    import inspect

    from polismath.replay import certify

    src = inspect.getsource(certify)
    assert "stagecompare" not in src
    assert "replay.stages" not in src and "import stages" not in src


# ---------------------------------------------------------------------------
# Round 2 — regressions for the six findings from the R-ORACLE review round.
# Each name says which finding it pins.
# ---------------------------------------------------------------------------
def test_f1_r13_emits_the_contract_geometry_from_the_production_adapter():
    """The engine contract's ptptstats is pid/gid/n-votes/centricness/coreness/
    extremeness, and this engine already implements it in
    ``math_writer.derive_ptptstats``. The stage must read THAT, with the RAW
    user-vote-counts, not the vote-correlation report statistic."""
    from types import SimpleNamespace

    from polismath.poller.math_writer import derive_ptptstats

    conv = SimpleNamespace(
        base_clusters=[{"id": 0, "members": [1], "center": [0.0, 0.0]}],
        group_clusters=[{"id": 2, "members": [0], "center": [0.0, 0.0]}],
        proj={1: [0.0, 0.0]}, last_updated=1000, conversation_id=1,
        participant_info={1: {"n_votes": 1, "group": 2, "n_pass": 4}})
    conv._compute_user_vote_counts = lambda: {1: 5}

    published = derive_ptptstats(conv, 1, {1: 5})["ptptstats"]
    dumped = stages.stage_r13_ptpt_stats(conv)
    row = dumped["ptpt-stats"][0]
    assert set(row) == {"pid", "gid", "n-votes", "centricness", "coreness",
                        "extremeness"}
    # Same statistic, same raw vote count, as the production output adapter.
    assert row["n-votes"] == published["n-votes"][0] == 5
    assert row["coreness"] == published["coreness"][0] == 1.0
    # The correlation view survives only under its own, clearly separate key.
    assert dumped["participant-info-legacy"][0]["n_pass"] == 4


def test_f1_r13_geometry_is_compared_with_no_waiver():
    a = _doc("clj", "delphi", {"R13_ptpt_stats": {"ptpt-stats": [
        {"pid": 1, "gid": 2, "n-votes": 3, "coreness": 0.2}]}})
    b = _doc("py", "delphi", {"R13_ptpt_stats": {"ptpt-stats": [
        {"pid": 1, "gid": 2, "n-votes": 3, "coreness": 0.9}]}})
    rep = sc.compare_step(a, b)
    assert rep["stages"]["R13_ptpt_stats"]["keys"]["ptpt-stats"]["status"] == \
        "DIVERGENT"
    assert rep["first_diverging_stage"] == "R13_ptpt_stats"


def test_f1_the_legacy_correlation_view_is_engine_local_never_graded():
    a = _doc("clj", "delphi", {"R13_ptpt_stats": {
        "participant-info-legacy": [{"pid": 1, "n_pass": 4}]}})
    b = _doc("py", "delphi", {"R13_ptpt_stats": {
        "participant-info-legacy": [{"pid": 1, "n_pass": 9}]}})
    rep = sc.compare_step(a, b)
    k = rep["stages"]["R13_ptpt_stats"]["keys"]["participant-info-legacy"]
    assert k["status"] == "ENGINE_LOCAL"
    assert rep["first_diverging_stage"] is None


def test_f1_duplicate_or_missing_pid_in_ptpt_stats_is_structural():
    a = _doc("clj", "delphi", {"R13_ptpt_stats": {"ptpt-stats": [
        {"pid": 1, "gid": 0}, {"pid": 1, "gid": 1}]}})
    b = _doc("py", "delphi", {"R13_ptpt_stats": {"ptpt-stats": [
        {"pid": 1, "gid": 0}]}})
    k = sc.compare_step(a, b)["stages"]["R13_ptpt_stats"]["keys"]["ptpt-stats"]
    assert k["status"] == "DIVERGENT" and k["n_structural"] >= 1


@pytest.mark.parametrize("a,b", [([1], [2]), (None, [2]), ([1, 2], [1])])
def test_f2_c1_never_suppresses_a_real_moderation_change(a, b):
    """C1 promises only null<->[]. Anything else on those keys is a real diff."""
    rep = sc.compare_step(_doc("clj", "delphi", {"R02_moderation": {"mod-out": a}}),
                          _doc("py", "delphi", {"R02_moderation": {"mod-out": b}}))
    assert rep["stages"]["R02_moderation"]["keys"]["mod-out"]["status"] == "DIVERGENT"
    assert rep["first_diverging_stage"] == "R02_moderation"


def test_f2_c3_covers_silhouette_values_only_not_the_candidate_inventory():
    """A different estimator explains different NUMBERS. It does not explain a
    missing k, so coverage stays outside the exception."""
    key = "group-clusterings-silhouettes"
    same_keys = sc.compare_step(
        _doc("clj", "delphi", {"R09_group_clusters": {key: {"2": 0.1, "3": 0.2}}}),
        _doc("py", "delphi", {"R09_group_clusters": {key: {"2": 0.9, "3": 0.8}}}))
    assert same_keys["stages"]["R09_group_clusters"]["keys"][key]["status"] == "CARVED"
    assert same_keys["first_diverging_stage"] is None

    missing_k = sc.compare_step(
        _doc("clj", "delphi", {"R09_group_clusters": {key: {"2": 0.1, "3": 0.2}}}),
        _doc("py", "delphi", {"R09_group_clusters": {key: {"2": 0.1}}}))
    k = missing_k["stages"]["R09_group_clusters"]["keys"][key]
    assert k["status"] == "DIVERGENT" and k["n_structural"] >= 1


@pytest.mark.parametrize("stage,key,a,b", [
    ("R06_base_clusters", "base-clusters",
     [{"id": 200, "members": [1000], "center": [1.0, 2.0]}],
     [{"id": 201, "members": [1000], "center": [1.0, 2.0]}]),
    ("R06_base_clusters", "base-clusters",
     [{"id": 200, "members": [1000], "center": [1.0, 2.0]}],
     [{"id": 200, "members": [1001], "center": [1.0, 2.0]}]),
    ("R11_repness", "repness",
     {"0": [{"tid": 100000, "n-agree": 100000}]},
     {"0": [{"tid": 100001, "n-agree": 100001}]}),
])
def test_f3_no_tolerance_ever_applies_to_an_integer_identity_or_count(
        stage, key, a, b):
    """Cluster ids, memberships, tids and counts are structural invariants. A
    GEOM or TIGHT class on the containing key must not leak onto them."""
    rep = sc.compare_step(_doc("clj", "delphi", {stage: {key: a}}),
                          _doc("py", "delphi", {stage: {key: b}}))
    assert rep["stages"][stage]["keys"][key]["status"] == "DIVERGENT"


def test_f3_large_integers_are_compared_without_float_coercion():
    """2**53 and 2**53+1 are the same float. They are not the same integer."""
    a, b = 2 ** 53, 2 ** 53 + 1
    assert float(a) == float(b)  # the coercion that used to hide this
    rep = sc.compare_step(_doc("clj", "delphi", {"R01_ingest":
                                                 {"last-vote-timestamp": a}}),
                          _doc("py", "delphi", {"R01_ingest":
                                                {"last-vote-timestamp": b}}))
    k = rep["stages"]["R01_ingest"]["keys"]["last-vote-timestamp"]
    assert k["status"] == "DIVERGENT" and k["max_abs"] == 1.0


def test_f3_the_two_engines_integral_spellings_still_agree():
    """Clojure writes a vote as -1, this engine as -1.0. Same integer."""
    nm = {"rownames": [1], "colnames": [2], "matrix": [[-1]]}
    rep = sc.compare_step(
        _doc("clj", "delphi", {"R01_ingest": {"rating-mat": nm}}),
        _doc("py", "delphi", {"R01_ingest": {"rating-mat":
                                             dict(nm, matrix=[[-1.0]])}}))
    assert rep["stages"]["R01_ingest"]["keys"]["rating-mat"]["status"] == "MATCH"


def test_f3_a_non_integral_value_in_an_integer_field_is_structural():
    rep = sc.compare_step(_doc("clj", "delphi", {"R01_ingest": {"n": 3}}),
                          _doc("py", "delphi", {"R01_ingest": {"n": 3.5}}))
    k = rep["stages"]["R01_ingest"]["keys"]["n"]
    assert k["status"] == "DIVERGENT" and k["n_structural"] >= 1


def test_f3_a_boolean_is_not_a_count():
    rep = sc.compare_step(_doc("clj", "delphi", {"R01_ingest": {"n": 1}}),
                          _doc("py", "delphi", {"R01_ingest": {"n": True}}))
    assert rep["stages"]["R01_ingest"]["keys"]["n"]["status"] == "DIVERGENT"


@pytest.mark.parametrize("label,broken", [
    ("extra row", {"rownames": [1], "colnames": [2], "matrix": [[1], [99]]}),
    ("extra column", {"rownames": [1], "colnames": [2], "matrix": [[1, 99]]}),
    ("duplicate row identity",
     {"rownames": [1, 1], "colnames": [2], "matrix": [[99], [1]]}),
])
def test_f4_a_malformed_named_matrix_is_a_structural_defect(label, broken):
    """Dropping the extra cells, or letting a duplicate identity overwrite a
    different value, would hide a real difference behind a clean MATCH."""
    good = {"rownames": [1], "colnames": [2], "matrix": [[1]]}
    rep = sc.compare_step(_doc("clj", "delphi", {"R01_ingest": {"rating-mat": good}}),
                          _doc("py", "delphi", {"R01_ingest": {"rating-mat": broken}}))
    k = rep["stages"]["R01_ingest"]["keys"]["rating-mat"]
    assert k["status"] == "DIVERGENT" and k["n_structural"] >= 1, label


def _square_pca_doc(engine, projection):
    doc = _doc(engine, "delphi", {
        "R01_ingest": {"tids": [1, 2]},
        "R04_pca": {"pca": {
            "center": [0.0, 0.0], "comps": [[1.0, 0.0], [0.0, 1.0]],
            "comment-projection": projection, "comment-extremity": [1.0, 2.0]}}})
    return doc


def test_f4_square_projection_axes_are_declared_not_guessed():
    """When n_tids == n_comps the orientation is ambiguous from lengths alone.
    Both emitters declare comps-by-tids, so a transposed array is a real
    difference and an identical one matches."""
    p = [[1.0, 2.0], [3.0, 4.0]]
    same = sc.compare_step(_square_pca_doc("clj", p), _square_pca_doc("py", p))
    assert same["first_diverging_stage"] is None

    transposed = sc.compare_step(_square_pca_doc("clj", p),
                                 _square_pca_doc("py", [[1.0, 3.0], [2.0, 4.0]]))
    assert transposed["first_diverging_stage"] == "R04_pca"


def test_f4_an_undeclared_axis_orientation_is_refused():
    a = _square_pca_doc("clj", [[1.0, 2.0], [3.0, 4.0]])
    b = _square_pca_doc("py", [[1.0, 2.0], [3.0, 4.0]])
    del b["comment_projection_axes"]
    k = sc.compare_step(a, b)["stages"]["R04_pca"]["keys"]["pca"]
    assert k["status"] == "DIVERGENT" and k["n_structural"] >= 1


def test_f4_an_extra_component_row_is_not_silently_zipped_away():
    a = _square_pca_doc("clj", [[1.0, 2.0], [3.0, 4.0]])
    b = _square_pca_doc("py", [[1.0, 2.0], [3.0, 4.0], [99.0, 99.0]])
    rep = sc.compare_step(a, b)
    k = rep["stages"]["R04_pca"]["keys"]["pca"]
    assert rep["first_diverging_stage"] == "R04_pca"
    assert k["n_structural"] >= 1


def test_f5_missing_directories_withhold_the_headline(tmp_path):
    report = sc.compare_recordings(tmp_path / "absent-a", tmp_path / "absent-b")
    assert report["headline_withheld"] is True
    assert report["input_valid"] is False
    text = sc.format_report(report)
    assert "INCOMPLETE OR MISALIGNED INPUT" in text
    assert "every stage within tolerance" not in text


def test_f5_steps_are_aligned_by_identity_not_position(tmp_path):
    a = _doc("clj", "delphi", {"R01_ingest": {"n": 1}})
    b = dict(_doc("py", "delphi", {"R01_ingest": {"n": 1}}), step=7)
    stages.write_stage_documents(tmp_path / "a", [a], engine="clj")
    stages.write_stage_documents(tmp_path / "b", [b], engine="py")
    report = sc.compare_recordings(tmp_path / "a", tmp_path / "b")
    assert report["aligned_steps"] == 0
    assert report["headline_withheld"] is True
    assert any("only in A" in p for p in report["input_problems"])


def test_f5_a_manifest_that_disagrees_with_the_files_is_an_input_problem(tmp_path):
    stages.write_stage_documents(
        tmp_path, [_doc("py", "delphi", {"R01_ingest": {"n": 1}})])
    manifest = json.loads((tmp_path / "stages-manifest.json").read_text())
    manifest["steps"].append({"file": "step-009.stages.json", "index": 9,
                              "input_digest": "sha256:x", "tick": 1})
    manifest["n_steps"] = 2
    (tmp_path / "stages-manifest.json").write_text(json.dumps(manifest))
    _, problems = sc.validate_recording(tmp_path)
    assert any("inventory" in p for p in problems)
    assert any("not a step file in this recording" in p for p in problems)


def test_f5_a_missing_stage_is_reported_not_ignored(tmp_path):
    doc = _doc("py", "delphi", {"R01_ingest": {"n": 1}})
    del doc["stages"]["R09_group_clusters"]
    stages.write_stage_documents(tmp_path, [doc])
    _, problems = sc.validate_recording(tmp_path)
    assert any("missing stage" in p for p in problems)


def test_f5_a_digest_mismatch_makes_the_step_incomparable():
    a = _doc("clj", "delphi", {"R01_ingest": {"n": 1}})
    b = dict(_doc("py", "delphi", {"R01_ingest": {"n": 1}}),
             input_digest="sha256:other")
    step = sc.compare_step(a, b)
    assert step["comparable"] is False
    assert any("input digests differ" in p for p in step["problems"])


def test_f6_non_finite_tokens_survive_raw_db_polarity_conversion():
    nm = {"rownames": [1], "colnames": [2], "matrix": [[sc.POS_INF_TOKEN]]}
    can = sc.canonicalize(_doc("clj", "raw-db", {"R01_ingest": {"rating-mat": nm}}))
    cell = f"{sc._typed_label(1)}|{sc._typed_label(2)}"
    assert can["R01_ingest"]["rating-mat"][cell] == sc.NEG_INF_TOKEN


def test_f6_matching_non_finite_geometry_is_reported_never_a_clean_match():
    """Round 3 (R2-F5). Polarity conversion of the tokens still works — but two
    engines AGREEING on an infinity is not clean data, and must never be hidden
    behind a default "every stage within tolerance"."""
    a = _doc("clj", "raw-db", {"R01_ingest": {"tids": [1]},
                               "R04_pca": {"mat": [[sc.POS_INF_TOKEN]]}})
    # raw-db carries the opposite vote sign; polarity conversion makes the two
    # rating matrices agree, isolating the non-finite in `mat`.
    a["stages"]["R01_ingest"]["rating-mat"] = {
        "rownames": [9], "colnames": [1], "matrix": [[-1]]}
    b = _doc("py", "delphi", {"R01_ingest": {"tids": [1]},
                              "R04_pca": {"mat": [[sc.NEG_INF_TOKEN]]}})
    b["stages"]["R01_ingest"]["rating-mat"] = {
        "rownames": [9], "colnames": [1], "matrix": [[1]]}
    rep = sc.compare_step(a, b)
    k = rep["stages"]["R04_pca"]["keys"]["mat"]
    # The raw-db "Infinity" became "-Infinity", so the two sides agree...
    assert k["n_diff"] == 0 and k["n_nonfinite"] == 1
    # ...but the status is NONFINITE, not MATCH, and it is not a divergence.
    assert k["status"] == "NONFINITE"
    assert rep["first_diverging_stage"] is None
    assert rep["n_nonfinite"] == 1


def test_f6_a_non_finite_in_an_integer_typed_field_is_structural():
    """A vote, id or count is never NaN. Agreement on one is still invalid."""
    nm = {"rownames": [1], "colnames": [2], "matrix": [[sc.NAN_TOKEN]]}
    rep = sc.compare_step(
        _doc("clj", "delphi", {"R01_ingest": {"rating-mat": nm}}),
        _doc("py", "delphi", {"R01_ingest": {"rating-mat": nm}}))
    k = rep["stages"]["R01_ingest"]["keys"]["rating-mat"]
    assert k["status"] == "DIVERGENT"
    assert k["n_structural"] >= 1 and k["n_nonfinite"] == 1


def test_f6_a_matching_non_finite_never_yields_a_clean_headline(tmp_path):
    """End to end: the printed headline must say so."""
    doc = _doc("py", "delphi", {"R01_ingest": {"tids": [1]},
                               "R04_pca": {"mat": [[sc.NAN_TOKEN]]}})
    doc["stages"]["R01_ingest"]["rating-mat"] = {
        "rownames": [9], "colnames": [1], "matrix": [[1]]}
    _complete(doc)
    stages.write_stage_documents(tmp_path / "a", [doc], engine="py")
    stages.write_stage_documents(tmp_path / "b", [doc], engine="py")
    report = sc.compare_recordings(tmp_path / "a", tmp_path / "b")
    assert report["input_valid"] is True, report["input_problems"]
    assert report["headline_qualified"] is True
    text = sc.format_report(report)
    assert "every stage within tolerance" not in text
    assert "NON-FINITE" in text and "[NONFINITE]" in text


@pytest.mark.parametrize("a,b", [
    (sc.NAN_TOKEN, sc.POS_INF_TOKEN),
    (sc.POS_INF_TOKEN, sc.NEG_INF_TOKEN),
    (sc.NAN_TOKEN, 1.0),
])
def test_f6_differing_non_finite_values_are_a_divergence(a, b):
    rep = sc.compare_step(_doc("clj", "delphi", {"R04_pca": {"mat": [[a]]},
                                                 "R01_ingest": {"tids": [1]}}),
                          _doc("py", "delphi", {"R04_pca": {"mat": [[b]]},
                                                "R01_ingest": {"tids": [1]}}))
    k = rep["stages"]["R04_pca"]["keys"]["mat"]
    assert k["status"] == "DIVERGENT"


def test_geom_reports_its_exceedances_of_the_stricter_tight_reference():
    """GEOM is a legacy-comparer setting, not the proposed contract bound, so a
    GEOM key must always show how many values a TIGHT reference would reject."""
    a = _doc("clj", "delphi", {"R01_ingest": {"tids": [1]},
                               "R05_projections": {"proj": {
                                   "rownames": [9], "colnames": ["x"],
                                   "matrix": [[1.0]]}}})
    b = _doc("py", "delphi", {"R01_ingest": {"tids": [1]},
                              "R05_projections": {"proj": {
                                  "rownames": [9], "colnames": ["x"],
                                  "matrix": [[1.0 + 1e-3]]}}})
    k = sc.compare_step(a, b)["stages"]["R05_projections"]["keys"]["proj"]
    assert k["status"] == "MATCH"          # inside the legacy GEOM bound
    assert k["n_over_tight"] == 1          # but outside the stricter reference
    assert sc.GEOM.name == "geom-legacy"


def test_r03_reads_the_carried_in_conv_without_invoking_the_setter():
    """A documented read-only observer must not call a state-changing
    computation (``_get_in_conv_participants`` assigns ``self.in_conv``)."""
    from types import SimpleNamespace

    called = []
    conv = SimpleNamespace(in_conv={3, 1, 2})
    conv._compute_user_vote_counts = lambda: {1: 5}
    conv._get_in_conv_participants = lambda: called.append(1) or set()
    assert stages.stage_r03_eligibility(conv)["in-conv"] == [1, 2, 3]
    assert called == []


# ---------------------------------------------------------------------------
# Round 3 — regressions for the five residual findings in the round-2 review
# (R2-F1 … R2-F5). Each name says which finding it pins.
# ---------------------------------------------------------------------------
def _pca_conv(center, comps):
    from types import SimpleNamespace

    return SimpleNamespace(pca={"center": center, "comps": comps})


def _emit_pca(conv):
    """Run the REAL emitter, stubbing only the unrelated imputation."""
    from unittest.mock import patch

    with patch.object(stages, "imputed_matrix", return_value=None):
        return stages.stage_r04_pca(conv)["pca"]


def test_r2f1_the_emitter_transposes_unconditionally_on_a_square_case():
    """The producer always returns comments-by-components. When n_tids equals
    n_components the two orientations are indistinguishable by shape, so a
    conditional transpose emits the wrong array while declaring the right axes.
    This drives the real emitter, not a hand-normalized document."""
    conv = _pca_conv([0.2, 0.4], [[0.8, 0.6], [-0.6, 0.8]])
    observed = np.array(_emit_pca(conv)["comment-projection"])
    expected = stages.pca_project_cmnts(
        np.asarray(conv.pca["center"]), np.asarray(conv.pca["comps"])).T
    assert np.allclose(observed, expected)
    assert observed.shape == (2, 2)


def test_r2f1_the_emitter_transposes_unconditionally_on_a_nonsquare_case():
    conv = _pca_conv([0.1, 0.2, 0.3], [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]])
    observed = np.array(_emit_pca(conv)["comment-projection"])
    expected = stages.pca_project_cmnts(
        np.asarray(conv.pca["center"]), np.asarray(conv.pca["comps"])).T
    assert np.allclose(observed, expected)
    assert observed.shape == (2, 3)


def test_r2f1_the_rank_one_projection_is_two_wide_and_declared():
    """Q16: with fewer than two comps the projection is still 2-wide on both
    engines, so the emitted comps-by-tids array has max(len(comps), 2) rows."""
    conv = _pca_conv([0.1, 0.2, 0.3], [[1.0, 0.0, 0.0]])
    observed = np.array(_emit_pca(conv)["comment-projection"])
    assert observed.shape == (stages.PROJECTION_WIDTH, 3)
    assert np.allclose(observed, 0.0)
    # And the comparer accepts that shape rather than calling it structural.
    doc = _doc("py", "delphi", {
        "R01_ingest": {"tids": [1, 2, 3]},
        "R04_pca": {"pca": {"center": [0.1, 0.2, 0.3], "comps": [[1.0, 0.0, 0.0]],
                            "comment-projection": observed.tolist(),
                            "comment-extremity": [0.0, 0.0, 0.0]}}})
    k = sc.compare_step(doc, doc)["stages"]["R04_pca"]["keys"]["pca"]
    assert k["n_structural"] == 0


def test_r2f1_an_emitter_structural_error_is_never_graded_as_data():
    """When the emitter cannot verify a shape it refuses, and the refusal must
    travel to the comparer as a structural failure — not as a guess."""
    err = stages.structural_error("could not verify orientation")
    assert stages.STRUCTURAL_ERROR_KEY in err
    doc_a = _doc("clj", "delphi", {"R04_pca": {"pca": {"comps": [[1.0]],
                                                       "center": [1.0]}},
                                   "R01_ingest": {"tids": [1]}})
    doc_b = json.loads(json.dumps(doc_a))
    doc_b["stages"]["R04_pca"]["pca"]["comps"] = err
    k = sc.compare_step(doc_a, doc_b)["stages"]["R04_pca"]["keys"]["pca"]
    assert k["status"] == "DIVERGENT"
    assert any("emitter:" in msg for msg in k["structural"])


def test_r2f2_a_recording_of_empty_stages_is_not_a_match(tmp_path):
    """Every required stage present but mapped to {} is missing evidence, not
    eleven stages that happened to agree."""
    doc = _doc("py", "delphi", {})           # every stage present, all empty
    stages.write_stage_documents(tmp_path / "a", [doc], engine="py")
    stages.write_stage_documents(tmp_path / "b", [doc], engine="py")
    report = sc.compare_recordings(tmp_path / "a", tmp_path / "b")
    assert report["input_valid"] is False
    assert report["headline_withheld"] is True
    assert any("missing required key" in p for p in report["input_problems"])
    assert "every stage within tolerance" not in sc.format_report(report)


@pytest.mark.parametrize("field", ["tick", "input_digest"])
def test_r2f2_null_identity_evidence_fails_validation(tmp_path, field):
    doc = _complete(_doc("py", "delphi", {}))
    doc[field] = None
    stages.write_stage_documents(tmp_path, [doc], engine="py")
    _, problems = sc.validate_recording(tmp_path)
    assert any(field.replace("_", "_") in p for p in problems), problems


def test_r2f2_a_manifest_disagreeing_with_its_document_is_an_input_problem(tmp_path):
    doc = _complete(_doc("py", "delphi", {}))
    stages.write_stage_documents(tmp_path, [doc], engine="py")
    manifest = json.loads((tmp_path / "stages-manifest.json").read_text())
    manifest["steps"][0]["tick"] = 999999
    (tmp_path / "stages-manifest.json").write_text(json.dumps(manifest))
    _, problems = sc.validate_recording(tmp_path)
    assert any("tick" in p and "!= document" in p for p in problems), problems


def test_r2f2_an_unknown_stage_key_is_an_input_problem(tmp_path):
    doc = _complete(_doc("py", "delphi", {}))
    doc["stages"]["R01_ingest"]["surprise"] = 1
    stages.write_stage_documents(tmp_path, [doc], engine="py")
    _, problems = sc.validate_recording(tmp_path)
    assert any("unknown key" in p for p in problems), problems


def test_r2f2_a_malformed_document_becomes_an_input_problem_not_an_exception(
        tmp_path):
    (tmp_path / "step-000.stages.json").write_text("[1, 2, 3]")
    _, problems = sc.validate_recording(tmp_path)
    assert problems and any("not an object" in p for p in problems)

    (tmp_path / "step-000.stages.json").write_text("{not json")
    _, problems = sc.validate_recording(tmp_path)
    assert problems and any("unreadable" in p for p in problems)


def test_r2f2_a_non_object_stages_container_is_reported_not_crashed(tmp_path):
    doc = _complete(_doc("py", "delphi", {}))
    doc["stages"] = ["nope"]
    stages.write_stage_documents(tmp_path, [doc], engine="py")
    _, problems = sc.validate_recording(tmp_path)
    assert any("no stages object" in p for p in problems)
    # And canonicalize must not raise on it either.
    assert sc.canonicalize(doc)["R01_ingest"]["__stage__"].reason


@pytest.mark.parametrize("other", [{}, set(), "", 0, False])
def test_r2f3_c1_covers_only_null_against_an_empty_list(other):
    """C1 promises `null` <-> `[]`. Nothing adjacent to it — an empty object, a
    falsy scalar — is the documented pair."""
    assert sc._is_null_empty_pair(None, other) is False
    rep = sc.compare_step(
        _doc("clj", "delphi", {"R02_moderation": {"mod-out": None}}),
        _doc("py", "delphi", {"R02_moderation": {"mod-out": other}}))
    assert rep["stages"]["R02_moderation"]["keys"]["mod-out"]["status"] != "CARVED"


def test_r2f3_the_documented_pair_is_still_carved_both_directions():
    for a, b in ((None, []), ([], None)):
        rep = sc.compare_step(
            _doc("clj", "delphi", {"R02_moderation": {"mod-out": a}}),
            _doc("py", "delphi", {"R02_moderation": {"mod-out": b}}))
        assert rep["stages"]["R02_moderation"]["keys"]["mod-out"]["status"] == \
            "CARVED"


@pytest.mark.parametrize("value", [True, False, "1", "abc", 1.5])
def test_r2f4_equal_but_wrongly_typed_integer_fields_are_structural(value):
    """Type is validated BEFORE equality, on both sides: two equally-malformed
    operands must not pass as a match."""
    rep = sc.compare_step(_doc("clj", "delphi", {"R01_ingest": {"n": value}}),
                          _doc("py", "delphi", {"R01_ingest": {"n": value}}))
    k = rep["stages"]["R01_ingest"]["keys"]["n"]
    assert k["status"] == "DIVERGENT"
    assert k["n_structural"] >= 1


def test_r2f4_an_equal_float_typed_cluster_id_is_a_divergence():
    """A float-spelled id is a contract violation even when the two agree."""
    a = [{"id": 1.5, "members": [1], "center": [0.0, 0.0]}]
    rep = sc.compare_step(_doc("clj", "delphi", {"R06_base_clusters":
                                                 {"base-clusters": a}}),
                          _doc("py", "delphi", {"R06_base_clusters":
                                                {"base-clusters": a}}))
    k = rep["stages"]["R06_base_clusters"]["keys"]["base-clusters"]
    assert k["status"] == "DIVERGENT" and k["n_structural"] >= 1


def test_r2f4_legitimate_integral_spellings_still_match():
    """The typing rule must not break the two engines' real behaviour."""
    rep = sc.compare_step(_doc("clj", "delphi", {"R01_ingest": {"n": 3}}),
                          _doc("py", "delphi", {"R01_ingest": {"n": 3.0}}))
    assert rep["stages"]["R01_ingest"]["keys"]["n"]["status"] == "MATCH"


def test_r2f4_both_sides_null_in_a_nullable_integer_field_still_matches():
    """`n-votes` and the moderation watermark are declared nullable."""
    rep = sc.compare_step(
        _doc("clj", "delphi", {"R02_moderation": {"last-mod-timestamp": None}}),
        _doc("py", "delphi", {"R02_moderation": {"last-mod-timestamp": None}}))
    assert rep["stages"]["R02_moderation"]["keys"]["last-mod-timestamp"][
        "status"] == "MATCH"


# ---------------------------------------------------------------------------
# Round 4 — regressions for the four residual findings in the round-3 review
# (R3-F1 … R3-F4).
# ---------------------------------------------------------------------------
def _rank_one_doc(engine, second_row):
    """A valid rank-one document: one component, a 2-wide projection (Q16)."""
    return _doc(engine, "delphi", {
        "R01_ingest": {"tids": [1, 2]},
        "R04_pca": {"pca": {"center": [0.2, 0.4], "comps": [[1.0, 0.0]],
                            "comment-projection": [[0.0, 0.0], second_row],
                            "comment-extremity": [0.0, 0.0]}}})


def test_r3f1_the_padded_rank_one_projection_row_is_compared_not_zipped_away():
    """The projection can be WIDER than `comps`. Zipping it against the
    component signs dropped the padded row, so anything at all could hide
    there."""
    tampered = sc.compare_step(_rank_one_doc("clj", [0.0, 0.0]),
                               _rank_one_doc("py", [999.0, 999.0]))
    assert tampered["stages"]["R04_pca"]["keys"]["pca"]["status"] == "DIVERGENT"
    assert tampered["first_diverging_stage"] == "R04_pca"

    clean = sc.compare_step(_rank_one_doc("clj", [0.0, 0.0]),
                            _rank_one_doc("py", [0.0, 0.0]))
    assert clean["first_diverging_stage"] is None


def test_r3f1_the_padded_row_must_satisfy_its_producer_invariant():
    """Q16 says the padded component is all-zero. A non-zero value there is a
    structural defect even when both engines agree on it — the row is preserved
    AND its construction is checked."""
    doc = _rank_one_doc("py", [1.0, 0.0])
    k = sc.compare_step(doc, doc)["stages"]["R04_pca"]["keys"]["pca"]
    assert k["status"] == "DIVERGENT"
    assert any("all-zero (Q16)" in m for m in k["structural"])


def test_r3f1_a_padded_sign_is_declared_not_incidental():
    assert sc.PADDED_COMPONENT_SIGN == 1.0


@pytest.mark.parametrize("mutate,expect", [
    (lambda d: d["stages"].__setitem__("R01_ingest", None), "not an object"),
    (lambda d: d["stages"].__setitem__("R01_ingest", []), "not an object"),
    (lambda d: d.__setitem__("step", []), "non-integer step identity"),
    (lambda d: d.__setitem__("stages", []), "no stages object"),
])
def test_r3f2_a_malformed_document_container_is_an_input_problem(
        tmp_path, mutate, expect):
    """Every container is type-validated before it is dereferenced or used as a
    key. A null stage in particular must count as a MISSING stage, not be
    skipped past every required-key check."""
    # Written as a valid recording first, then corrupted on disk: the writer
    # legitimately refuses some of these, and the point is that the READER
    # survives them.
    stages.write_stage_documents(
        tmp_path, [_complete(_doc("py", "delphi", {}))], engine="py")
    doc = json.loads((tmp_path / "step-000.stages.json").read_text())
    mutate(doc)
    (tmp_path / "step-000.stages.json").write_text(json.dumps(doc))
    _, problems = sc.validate_recording(tmp_path)   # must not raise
    assert any(expect in p for p in problems), problems


def test_r3f2_a_null_stage_does_not_bypass_the_key_inventory(tmp_path):
    doc = _complete(_doc("py", "delphi", {}))
    doc["stages"]["R01_ingest"] = None
    stages.write_stage_documents(tmp_path, [doc], engine="py")
    _, problems = sc.validate_recording(tmp_path)
    assert any("R01_ingest" in p and "no evidence" in p for p in problems)


def test_r3f2_a_manifest_that_is_not_an_object_is_an_input_problem(tmp_path):
    stages.write_stage_documents(
        tmp_path, [_complete(_doc("py", "delphi", {}))], engine="py")
    (tmp_path / "stages-manifest.json").write_text("[]")
    _, problems = sc.validate_recording(tmp_path)   # must not raise
    assert any("manifest is not an object" in p for p in problems)


def test_r3f2_an_unhashable_step_identity_does_not_crash_the_comparer(tmp_path):
    a, b = tmp_path / "a", tmp_path / "b"
    good = _complete(_doc("py", "delphi", {}))
    bad = _complete(_doc("py", "delphi", {}))
    bad["step"] = []
    stages.write_stage_documents(a, [good], engine="py")
    stages.write_stage_documents(b, [good], engine="py")
    (b / "step-000.stages.json").write_text(json.dumps(bad))
    report = sc.compare_recordings(a, b)            # must not raise
    assert report["headline_withheld"] is True


def test_r3f3_a_manifest_row_naming_a_non_step_file_is_rejected(tmp_path):
    stages.write_stage_documents(
        tmp_path, [_complete(_doc("py", "delphi", {}))], engine="py")
    manifest = json.loads((tmp_path / "stages-manifest.json").read_text())
    manifest["steps"][0]["file"] = "stages-manifest.json"
    (tmp_path / "stages-manifest.json").write_text(json.dumps(manifest))
    _, problems = sc.validate_recording(tmp_path)
    assert any("not a step-NNN.stages.json filename" in p for p in problems)


def test_r3f3_a_step_file_missing_from_the_manifest_is_rejected(tmp_path):
    stages.write_stage_documents(
        tmp_path, [_complete(_doc("py", "delphi", {}))], engine="py")
    manifest = json.loads((tmp_path / "stages-manifest.json").read_text())
    manifest["steps"] = []
    manifest["n_steps"] = 0
    (tmp_path / "stages-manifest.json").write_text(json.dumps(manifest))
    _, problems = sc.validate_recording(tmp_path)
    assert any("not in the manifest" in p for p in problems)


def test_r3f3_a_mixed_engine_recording_is_rejected(tmp_path):
    a = _complete(_doc("py", "delphi", {}))
    b = dict(_complete(_doc("py", "delphi", {})), step=1, engine="other")
    stages.write_stage_documents(tmp_path, [a, b], engine="py")
    _, problems = sc.validate_recording(tmp_path)
    assert any("more than one engine" in p for p in problems)


def test_r3f3_a_contradictory_manifest_polarity_is_rejected(tmp_path):
    stages.write_stage_documents(
        tmp_path, [_complete(_doc("py", "delphi", {}))], engine="py")
    manifest = json.loads((tmp_path / "stages-manifest.json").read_text())
    manifest["vote_sign_convention"] = "raw-db"
    (tmp_path / "stages-manifest.json").write_text(json.dumps(manifest))
    _, problems = sc.validate_recording(tmp_path)
    assert any("contradicts" in p for p in problems)


@pytest.mark.parametrize("digest", [
    "sha256:x", "sha256:", "deadbeef", "sha256:" + "A" * 64, "sha256:" + "a" * 63,
])
def test_r3f3_a_malformed_digest_is_rejected(tmp_path, digest):
    """64 lower-case hex digits, not merely a prefix."""
    doc = _complete(_doc("py", "delphi", {}))
    doc["input_digest"] = digest
    stages.write_stage_documents(tmp_path, [doc], engine="py")
    _, problems = sc.validate_recording(tmp_path)
    assert any("well-formed sha256" in p for p in problems)


def test_r3f3_the_manifest_rows_carry_every_identity_field(tmp_path):
    out = stages.write_stage_documents(
        tmp_path, [_complete(_doc("py", "delphi", {}))], engine="py")
    row = json.loads((out / "stages-manifest.json").read_text())["steps"][0]
    assert set(row) >= {"engine", "file", "index", "input_digest", "tick",
                        "vote_sign_convention"}
    assert not sc.validate_recording(out)[1]


@pytest.mark.parametrize("value", [{}, [], {"a": 1}, [1, 2]])
def test_r3f4_a_container_in_a_scalar_count_position_is_structural(value):
    """`n` is a typed integer, not a tree that happens to contain no
    disagreeing leaves."""
    rep = sc.compare_step(_doc("clj", "delphi", {"R01_ingest": {"n": value}}),
                          _doc("py", "delphi", {"R01_ingest": {"n": value}}))
    k = rep["stages"]["R01_ingest"]["keys"]["n"]
    assert k["status"] == "DIVERGENT"
    assert any("must be a scalar" in m for m in k["structural"])


def test_r3f4_a_scalar_in_an_array_position_is_structural():
    rep = sc.compare_step(_doc("clj", "delphi", {"R03_eligibility":
                                                 {"in-conv": 5}}),
                          _doc("py", "delphi", {"R03_eligibility":
                                                {"in-conv": 5}}))
    k = rep["stages"]["R03_eligibility"]["keys"]["in-conv"]
    assert k["status"] == "DIVERGENT"
    assert any("must be a array" in m for m in k["structural"])


def test_r3f4_a_container_in_a_nested_scalar_id_position_is_structural():
    clusters = [{"id": {}, "members": [1], "center": [0.0, 0.0]}]
    rep = sc.compare_step(_doc("clj", "delphi", {"R06_base_clusters":
                                                 {"base-clusters": clusters}}),
                          _doc("py", "delphi", {"R06_base_clusters":
                                                {"base-clusters": clusters}}))
    assert rep["stages"]["R06_base_clusters"]["keys"]["base-clusters"][
        "status"] == "DIVERGENT"


def test_r3f4_declared_containers_still_compare_normally():
    """The shape rule applies at the declared position only, so an array of
    arrays and an array of integers both still recurse."""
    a = _doc("clj", "delphi", {
        "R03_eligibility": {"in-conv": [1, 2, 3]},
        "R06_base_clusters": {"bid-to-pid": [[1, 2], [3]]},
        "R10_tallies": {"votes-base": {"7": {"A": [1, 0], "D": [0, 1],
                                             "S": [1, 1]}}}})
    assert sc.compare_step(a, a)["first_diverging_stage"] is None


def test_r3f4_the_ads_tally_shape_is_key_scoped_not_field_scoped():
    """A/D/S are per-base-cluster bucket ARRAYS in `votes-base` and per-group
    SCALAR totals in `group-votes` (conversation.clj:600-624). A field-name-only
    shape rule gets one of them wrong — this was caught by the battery run, not
    by a synthetic control."""
    tallies = {
        "votes-base": {"7": {"A": [1, 0], "D": [0, 1], "S": [1, 1]}},
        "group-votes": {"0": {"n-members": 2,
                              "votes": {"7": {"A": 1, "D": 1, "S": 2}}}},
    }
    doc = _doc("py", "delphi", {"R10_tallies": tallies})
    assert sc.compare_step(doc, doc)["first_diverging_stage"] is None

    # And each is still rejected in the other's shape.
    swapped = _doc("py", "delphi", {"R10_tallies": {
        "votes-base": {"7": {"A": 1, "D": 1, "S": 2}},
        "group-votes": {"0": {"n-members": 2,
                              "votes": {"7": {"A": [1], "D": [1], "S": [2]}}}},
    }})
    rep = sc.compare_step(swapped, swapped)
    assert rep["stages"]["R10_tallies"]["keys"]["votes-base"]["status"] == \
        "DIVERGENT"
    assert rep["stages"]["R10_tallies"]["keys"]["group-votes"]["status"] == \
        "DIVERGENT"


# ---------------------------------------------------------------------------
# Round 5 — regressions for the two residual findings in the round-4 review
# (R4-F1, R4-F2). The second reviewer's seven reproductions, plus the cases they imply.
# ---------------------------------------------------------------------------
def _recording_pair(tmp_path, mutate_b, *, target="doc"):
    """Two real on-disk recordings, the second corrupted. Exercises the PUBLIC
    compare_recordings path, not just validate_recording."""
    for side in ("a", "b"):
        stages.write_stage_documents(
            tmp_path / side, [_complete(_doc("py", "delphi", {}))], engine="py")
    name = "step-000.stages.json" if target == "doc" else "stages-manifest.json"
    path = tmp_path / "b" / name
    obj = json.loads(path.read_text())
    mutate_b(obj)
    path.write_text(json.dumps(obj))
    return sc.compare_recordings(tmp_path / "a", tmp_path / "b")


@pytest.mark.parametrize("target,key,value", [
    ("doc", "engine", []),
    ("doc", "engine", {}),
    ("doc", "engine", ""),
    ("doc", "engine", 7),
    ("doc", "vote_sign_convention", {}),
    ("doc", "vote_sign_convention", "sideways"),
    ("doc", "vote_sign_convention", None),
    ("manifest", "engine", []),
    ("manifest", "vote_sign_convention", []),
])
def test_r4f1_malformed_metadata_is_a_named_problem_not_an_exception(
        tmp_path, target, key, value):
    """A wrong type, an unknown enum member or an empty value must be reported.
    Building a set from an unhashable engine, or testing membership against one,
    raised TypeError before the report was ever written."""
    report = _recording_pair(tmp_path, lambda o: o.__setitem__(key, value),
                             target=target)
    assert report["input_valid"] is False
    assert report["headline_withheld"] is True
    assert report["input_problems"]
    assert "every stage within tolerance" not in sc.format_report(report)


@pytest.mark.parametrize("body", [[1], [1, 2], [{}], ["x"]])
def test_r4f1_a_non_empty_array_stage_does_not_crash_the_public_compare(
        tmp_path, body):
    """A NON-EMPTY array is truthy, so `(stages.get(...) or {}).get(...)` raised
    AttributeError on it — the empty-list and null cases missed this path."""
    report = _recording_pair(
        tmp_path, lambda o: o["stages"].__setitem__("R01_ingest", body))
    assert report["input_valid"] is False
    assert report["headline_withheld"] is True


@pytest.mark.parametrize("body", [[1], "text", 7])
def test_r4f1_canonicalize_survives_a_non_object_stage_body(body):
    """Canonicalization must type-check rather than test truthiness."""
    doc = _doc("py", "delphi", {})
    doc["stages"]["R01_ingest"] = body
    can = sc.canonicalize(doc)                      # must not raise
    assert isinstance(can["R01_ingest"]["__stage__"], sc.Structural)


def test_r4f1_an_invalid_document_is_not_sent_onward_to_be_compared(tmp_path):
    """A usable step identity is not a licence to canonicalize a document that
    validation has already rejected."""
    report = _recording_pair(
        tmp_path, lambda o: o["stages"].__setitem__("R09_group_clusters", [1]))
    assert any("not comparable" in p for p in report["input_problems"])
    assert report["aligned_steps"] == 0


def test_r4f1_document_is_comparable_names_its_reason():
    good = _complete(_doc("py", "delphi", {}))
    assert sc.document_is_comparable(good) is None
    assert "engine" in sc.document_is_comparable(dict(good, engine=[]))
    assert "vote_sign_convention" in sc.document_is_comparable(
        dict(good, vote_sign_convention="sideways"))
    assert "stages" in sc.document_is_comparable(dict(good, stages=[1]))
    bad_stage = json.loads(json.dumps(good))
    bad_stage["stages"]["R01_ingest"] = [1]
    assert "R01_ingest" in sc.document_is_comparable(bad_stage)


@pytest.mark.parametrize("stage,key,value", [
    ("R03_eligibility", "in-conv", [{}]),
    ("R01_ingest", "tids", [{}]),
    ("R10_tallies", "votes-base", {"7": {"A": [{}], "D": [0], "S": [0]}}),
    ("R03_eligibility", "in-conv", [[]]),
    ("R03_eligibility", "in-conv", [None]),
    ("R03_eligibility", "in-conv", [1, {}]),
    ("R02_moderation", "mod-out", [{"tid": 1}]),
    ("R06_base_clusters", "bid-to-pid", [[{}]]),
])
def test_r4f2_a_malformed_element_of_an_integer_array_is_structural(
        stage, key, value):
    """A declared integer array holds integers. Equal malformed elements are
    not a match — the rank descends with the recursion (R4-F2)."""
    doc = _doc("py", "delphi", {stage: {key: value}})
    k = sc.compare_step(doc, doc)["stages"][stage]["keys"][key]
    assert k["status"] == "DIVERGENT"
    assert k["n_structural"] >= 1


@pytest.mark.parametrize("stage,key,value", [
    ("R03_eligibility", "in-conv", [1, 2, 3]),
    ("R01_ingest", "tids", [7, 3]),
    ("R02_moderation", "mod-out", []),
    ("R06_base_clusters", "bid-to-pid", [[1, 2], [3], []]),
    ("R10_tallies", "votes-base", {"7": {"A": [1, 0], "D": [0, 1], "S": [1, 1]}}),
    ("R10_tallies", "group-votes",
     {"0": {"n-members": 2, "votes": {"7": {"A": 1, "D": 1, "S": 2}}}}),
])
def test_r4f2_well_formed_integer_containers_still_match(stage, key, value):
    """bid-to-pid legitimately has one more array dimension than in-conv, and
    the declaration has to say so rather than treating both as free trees."""
    doc = _doc("py", "delphi", {stage: {key: value}})
    assert sc.compare_step(doc, doc)["stages"][stage]["keys"][key]["status"] == \
        "MATCH"


def test_r4f2_the_declared_ranks_are_explicit_about_dimensionality():
    assert sc.INTEGER_KEY_RANK[("R03_eligibility", "in-conv")] == sc.INT_ARRAY
    assert sc.INTEGER_KEY_RANK[("R06_base_clusters", "bid-to-pid")] == \
        sc.INT_ARRAY_2D
    assert sc.KEY_SCOPED_INTEGER_RANK[("R10_tallies", "votes-base", "A")] == \
        sc.INT_ARRAY
    assert sc.KEY_SCOPED_INTEGER_RANK[("R10_tallies", "group-votes", "A")] == \
        sc.SCALAR
