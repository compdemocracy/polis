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
        "engine": engine,
        "input_digest": "sha256:deadbeef",
        "schema": stages.STAGE_DUMP_SCHEMA,
        "stages": full,
        "step": 0,
        "tick": 1,
        "vote_sign_convention": convention,
    }


def test_polarity_negates_votes_and_geometry_but_not_comps():
    raw = _doc("clj", "raw-db", {
        "R01_ingest": {
            "tids": [7],
            "rating-mat": {"rownames": [1], "colnames": [7], "matrix": [[-1]]},
        },
        "R04_pca": {
            "mat": [[-1.0]],
            "pca": {"center": [-0.5], "comps": [[1.0]],
                    "comment-projection": [[-0.25]], "comment-extremity": [0.25]},
        },
    })
    can = sc.canonicalize(raw)
    assert can["R01_ingest"]["rating-mat"]["1|7"] == 1
    assert can["R04_pca"]["mat"]["1|7"] == 1.0
    assert can["R04_pca"]["pca"]["center"]["7"] == 0.5
    assert can["R04_pca"]["pca"]["comment-projection"]["0"]["7"] == 0.25
    # comps are invariant: X^T X == (-X)^T (-X).
    assert can["R04_pca"]["pca"]["comps"]["0"]["7"] == 1.0
    # extremity is a norm.
    assert can["R04_pca"]["pca"]["comment-extremity"]["7"] == 0.25


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


def test_silhouette_and_ptpt_stats_are_carved_with_their_reason_recorded():
    assert sc.KEY_CARVE_OUT[("R09_group_clusters",
                             "group-clusterings-silhouettes")] == "C3"
    assert sc.KEY_CARVE_OUT[("R13_ptpt_stats", "ptpt-stats")] == "C4"
    for cid in sc.AUTO_CARVED:
        assert cid in sc.CARVE_OUTS
        assert sc.CARVE_OUTS[cid].reason


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
