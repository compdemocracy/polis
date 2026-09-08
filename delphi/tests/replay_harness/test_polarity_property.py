"""P-023 polarity: the algebra controls, N, the marker, and the real pair.

The plan's ten algebra controls and the review's nine composition/misuse
controls, executed here as pytest rather than as a scratch script — against the
REAL ``project_prep_main``, the REAL ``certify.validate_checkpoint_blob``, the
REAL ``Conversation.from_dict`` and a REAL Python-driver blob replayed from the
committed biodiversity dataset (the one that carries both group-cluster
spellings and ``proj``, which is what makes controls 13-18 evidence rather than
restatement).

Numbering follows the review so a reader can line each test up with the control
it discharges:

  1-9   the algebra of ``semantic = v x s`` and of ``T(V, s) = (-V, -s)``
  10-12 N: involution, invariants, and its distinction from PCA orientation
  13-16 N composed with the shipped raw gate on a real driver blob
  17-18 the projected-to-restore misuse, which rev3 R3-1 requires a MARKER to
        catch (the raw schema alone cannot: control 18 shows what the marker
        prevents)
"""

import copy
import csv
import json
import math
import os
import shutil
from pathlib import Path

import pytest

from polismath.conversation.conversation import Conversation
from polismath.replay import certify as cert
from polismath.replay import polarity as pol
from polismath.replay import prodclone as pc
from polismath.replay import real_data as rd
from polismath.replay import schedule as sched
from polismath.replay.crosslang import PREP_MAIN_KEYS, project_prep_main
from polismath.replay.driver import run_replay
from polismath.replay.types import ReplayDataset
from polismath.utils import output_profile as op
from polismath.utils import vote_convention as vc
from polismath.utils.general import postgres_vote_to_delphi

RAW_DOMAIN = (-1, 0, 1)
SIGNS = (-1, 1)


# ---------------------------------------------------------------------------
# 1-9 — the algebra of the storage convention and of T.
# ---------------------------------------------------------------------------


def test_control_01_semantic_is_v_times_s_over_the_whole_domain():
    """Control 1. agree = +1, disagree = -1, pass = 0, for both conventions."""
    for s in SIGNS:
        assert vc.semantic_vote(s, s) == vc.SEMANTIC_AGREE
        assert vc.semantic_vote(-s, s) == vc.SEMANTIC_DISAGREE
        assert vc.semantic_vote(0, s) == vc.SEMANTIC_PASS
        for v in RAW_DOMAIN:
            assert vc.semantic_vote(v, s) == v * s


def test_control_02_T_preserves_semantics_for_every_raw_value():
    """Control 2. semantic(T(V, s)) == semantic(V, s)."""
    for s in SIGNS:
        for v in RAW_DOMAIN:
            assert vc.semantic_vote(-v, vc.flipped(s)) == vc.semantic_vote(v, s)


def test_control_03_T_is_its_own_inverse():
    """Control 3. On the votes and on the constant."""
    rows = [{"created": 1, "pid": 0, "tid": 0, "vote": -1},
            {"created": 2, "pid": 1, "tid": 0, "vote": 1},
            {"created": 3, "pid": 2, "tid": 0, "vote": 0},
            {"created": 4, "pid": 3, "tid": 0, "vote": None}]
    assert pol.flip_raw_votes(pol.flip_raw_votes(rows)) == rows
    for s in SIGNS:
        assert vc.flipped(vc.flipped(s)) == s


def test_control_04_pass_stays_the_literal_zero_on_both_sides():
    """Control 4."""
    rows = [{"created": 1, "pid": 0, "tid": 0, "vote": 0}]
    flipped = pol.flip_raw_votes(rows)
    assert flipped[0]["vote"] == 0
    assert type(flipped[0]["vote"]) is int


def test_control_05_null_is_preserved_by_T_and_is_not_pass():
    """Control 5. NULL is a distinct storage state; the converter refuses it
    rather than reading it as a pass."""
    rows = [{"created": 1, "pid": 0, "tid": 0, "vote": None}]
    assert pol.flip_raw_votes(rows)[0]["vote"] is None
    with pytest.raises(vc.VoteConventionError, match="NULL"):
        vc.semantic_vote(None, -1)


def test_control_06_a_missing_cell_stays_absent_under_T():
    """Control 6. T touches vote leaves; it never materialises a cell."""
    rows = [{"created": 1, "pid": 0, "tid": 0, "vote": -1},
            {"created": 2, "pid": 0, "tid": 1, "vote": 1}]
    flipped = pol.flip_raw_votes(rows)
    assert [(r["pid"], r["tid"]) for r in flipped] == [(0, 0), (0, 1)]
    assert len(flipped) == len(rows)


@pytest.mark.parametrize(
    "bad", [True, False, None, 0, -1.0, 1.0, "-1", "+1", [-1], 2, -2])
def test_control_07_storage_agree_value_rejects_everything_but_int_pm1(bad):
    """Control 7. bool included: True == 1 would otherwise declare +1."""
    with pytest.raises(vc.VoteConventionError):
        vc.validate_storage_agree_value(bad)


def test_control_08_the_frozen_order_gives_the_same_semantic_winner():
    """Control 8. Later (created_ms, source_ordinal) wins, and the winner's
    MEANING is identical across the pair when the frozen order is kept."""
    rows = [{"created": 1000, "pid": 0, "tid": 0, "vote": -1},
            {"created": 1000, "pid": 0, "tid": 0, "vote": 1}]
    s = -1
    winner_a = vc.semantic_vote(rows[-1]["vote"], s)
    flipped_rows = pol.flip_raw_votes(rows)
    winner_b = vc.semantic_vote(flipped_rows[-1]["vote"], vc.flipped(s))
    assert winner_a == winner_b


def test_control_09_negative_resorting_by_raw_sign_changes_the_winner():
    """Control 9 (NEGATIVE). The load-bearing one: re-sorting by raw sign
    picks a DIFFERENT equal-time winner on the two sides, which is why 'use
    exactly the same frozen tie order on both sides' is a requirement and not
    defensive prose."""
    rows = [{"created": 1000, "pid": 0, "tid": 0, "vote": -1},
            {"created": 1000, "pid": 0, "tid": 0, "vote": 1}]
    s = -1
    by_sign_a = sorted(rows, key=lambda r: (r["created"], r["vote"]))
    by_sign_b = sorted(pol.flip_raw_votes(rows),
                       key=lambda r: (r["created"], r["vote"]))
    assert (vc.semantic_vote(by_sign_a[-1]["vote"], s)
            != vc.semantic_vote(by_sign_b[-1]["vote"], vc.flipped(s)))


# ---------------------------------------------------------------------------
# 10-12 — N itself.
# ---------------------------------------------------------------------------


def _projected(blob):
    return pol.comparison_view(blob, project=project_prep_main)


GEOMETRY_BLOB = {
    "zid": "t", "n": 4, "n-cmts": 2, "tids": [0, 1], "in-conv": [0, 1, 2, 3],
    "pca": {
        "center": [0.5, -0.25],
        "comps": [[1.0, 0.0], [0.0, 1.0]],
        "comment-projection": [[0.3, -0.4], [0.1, 0.2]],
        "comment-extremity": [0.5, 0.22],
    },
    "base-clusters": {"id": [0, 1], "members": [[0, 1], [2, 3]],
                      "x": [1.5, -2.5], "y": [-0.5, 0.25], "count": [2, 2]},
    "group-clusters": [{"id": 0, "members": [0], "center": [1.5, -0.5]},
                       {"id": 1, "members": [1], "center": [-2.5, 0.25]}],
    "repness": {}, "consensus": {}, "group-votes": {}, "votes-base": {},
    "user-vote-counts": {}, "comment-priorities": {},
    "group-aware-consensus": {},
}


def test_control_10_N_is_an_involution_on_the_declared_field_set():
    """Control 10. N(N(view)) == view exactly, marker included."""
    view = _projected(GEOMETRY_BLOB)
    once = pol.vote_axis_involution(view)
    twice = pol.vote_axis_involution(once)
    assert twice == view
    assert once != view
    assert once[op.OUTPUT_PROFILE_KEY]["vote_axis"] == op.VOTE_AXIS_NEGATED
    assert twice[op.OUTPUT_PROFILE_KEY]["vote_axis"] == op.VOTE_AXIS_AS_EMITTED


def test_control_10b_N_negates_exactly_the_declared_fields():
    view = _projected(GEOMETRY_BLOB)
    n_view = pol.vote_axis_involution(view)
    assert n_view["pca"]["center"] == [-0.5, 0.25]
    assert n_view["pca"]["comment-projection"] == [[-0.3, 0.4], [-0.1, -0.2]]
    assert n_view["base-clusters"]["x"] == [-1.5, 2.5]
    assert n_view["base-clusters"]["y"] == [0.5, -0.25]
    assert [g["center"] for g in n_view["group-clusters"]] == [
        [-1.5, 0.5], [2.5, -0.25]]


def test_control_11_N_leaves_comps_extremity_counts_and_ids_invariant():
    """Control 11, and the plan's 'apply N to comps or extremity' control:
    those fields must NOT move."""
    view = _projected(GEOMETRY_BLOB)
    n_view = pol.vote_axis_involution(view)
    pol.assert_n_invariants(view, n_view)
    assert n_view["pca"]["comps"] == view["pca"]["comps"]
    assert n_view["pca"]["comment-extremity"] == view["pca"]["comment-extremity"]
    assert n_view["base-clusters"]["members"] == view["base-clusters"]["members"]
    assert [g["members"] for g in n_view["group-clusters"]] == [
        g["members"] for g in view["group-clusters"]]


def test_control_11b_a_partial_N_is_caught_by_the_invariant_check():
    """The plan's 'flip only one coupled output field' control. A hand-rolled
    partial N leaves comps alone (fine) but also changes an invariant when the
    implementer negates the wrong family — assert_n_invariants names it."""
    view = _projected(GEOMETRY_BLOB)
    bad = copy.deepcopy(view)
    bad["pca"]["comps"] = [[-c for c in row] for row in bad["pca"]["comps"]]
    with pytest.raises(pol.PolarityError, match="pca.comps"):
        pol.assert_n_invariants(view, bad)


def test_control_12_N_changes_the_mean_pca_orientation_never_does():
    """Control 12. Orientation flips a component AND its coupled projections
    and leaves pca.center alone; N moves the mean and leaves comps alone. The
    two operations must never be confused — that is how a wrong mean passes."""
    view = _projected(GEOMETRY_BLOB)
    n_view = pol.vote_axis_involution(view)
    assert n_view["pca"]["center"] != view["pca"]["center"]
    assert n_view["pca"]["comps"] == view["pca"]["comps"]

    # An orientation flip, spelled out here as the contrast case.
    oriented = copy.deepcopy(view)
    oriented["pca"]["comps"][0] = [-c for c in oriented["pca"]["comps"][0]]
    oriented["pca"]["comment-projection"][0] = [
        -c for c in oriented["pca"]["comment-projection"][0]]
    assert oriented["pca"]["center"] == view["pca"]["center"]
    assert oriented["pca"]["comps"] != view["pca"]["comps"]


def test_N_refuses_a_raw_blob_and_a_view_carrying_raw_extensions():
    """N 'is never a raw serializer or restore transform'."""
    with pytest.raises(pol.PolarityError, match="PROJECTED"):
        pol.vote_axis_involution(dict(GEOMETRY_BLOB))
    smuggled = _projected(GEOMETRY_BLOB)
    smuggled["group_clusters"] = [{"id": 0, "members": [0], "center": [1.0, 1.0]}]
    with pytest.raises(pol.PolarityError, match="group_clusters"):
        pol.vote_axis_involution(smuggled)


# ---------------------------------------------------------------------------
# 13-18 — the real driver blob: N composed with the shipped gate, and the
# projected-to-restore misuse.
# ---------------------------------------------------------------------------

BIODIVERSITY = "biodiversity"


@pytest.fixture(scope="module")
def real_driver_blob():
    """A REAL ``Conversation.to_dict()`` blob from the committed biodiversity
    dataset, replayed through the real Python driver. It carries both
    group-cluster spellings and ``proj`` — the raw extensions the whole
    post-projection argument turns on — so these controls are evidence rather
    than a restatement of the design."""
    directory = rd.dataset_dir(BIODIVERSITY)
    if directory is None:
        pytest.skip("biodiversity dataset not present")
    votes_csv = sorted(directory.glob("*-votes.csv"))[0]
    raw = rd.read_export_vote_rows(votes_csv)[:1200]
    dataset = ReplayDataset.build(raw)
    spec = sched.ScheduleSpec(dataset=BIODIVERSITY, schedule_id="polarity-real",
                              cuts={"mode": "vote-count", "at": ["end"]})
    records = run_replay(dataset, spec)
    blob = records[-1].blob
    assert "group-clusters" in blob and "group_clusters" in blob, (
        "the real driver blob must carry BOTH spellings, or controls 13-18 "
        "prove nothing")
    assert "proj" in blob
    assert blob["group-clusters"], "the fixture must have at least one group"
    return blob


def _gate_verdict(blob):
    """The shipped raw gate's verdict, as data. Deliberately NOT asserted to be
    'accepted': the alias policy's treatment of the real twin pair is the
    subject of a separate campaign (#2725). What these controls assert is that
    N does not CHANGE this verdict, because it never touches the raw blob."""
    try:
        cert.validate_checkpoint_blob(blob, "real: step-000")
        return "accepted"
    except cert.CertifyError as exc:
        return f"rejected:{exc.args[0]}"


def test_control_13_15_N_leaves_the_raw_blob_and_its_gate_verdict_untouched(
        real_driver_blob):
    """Controls 13 and 15. The raw blob is byte-identical before and after N
    runs on its projected view, so its verdict under the shipped gate cannot
    move — which is exactly what makes ``from_dict`` safe."""
    before = json.dumps(real_driver_blob, sort_keys=True)
    verdict_before = _gate_verdict(real_driver_blob)

    view = _projected(real_driver_blob)
    pol.vote_axis_involution(view)

    assert json.dumps(real_driver_blob, sort_keys=True) == before
    assert _gate_verdict(real_driver_blob) == verdict_before


def test_control_14a_the_projected_view_carries_no_twin_and_no_proj(
        real_driver_blob):
    """Control 14a — the round-1 defect, closed by rev2/rev3's post-projection
    N. ``project_prep_main`` drops ``group_clusters`` (exact kebab wins) and
    ``proj`` (outside the whitelist) BEFORE N runs, so post-projection N cannot
    violate the C9 sign relation: the relation is never evaluated on anything N
    has touched."""
    view = pol.payload(_projected(real_driver_blob))
    assert "group_clusters" not in view
    assert "proj" not in view
    assert set(view) <= PREP_MAIN_KEYS


def test_control_14b_from_dict_still_restores_the_twin_in_internal_sign(
        real_driver_blob):
    """Control 14b. The raw blob is unmodified, so ``from_dict``'s
    ``data.get('group_clusters')`` still reads the producer's internal sign —
    no double-negation path exists, and the C9 relation could not have seen one
    if it did (both twins would have flipped consistently)."""
    view = _projected(real_driver_blob)
    pol.vote_axis_involution(view)
    restored = Conversation.from_dict(real_driver_blob)
    assert restored.group_clusters == real_driver_blob["group_clusters"]
    assert restored.group_clusters, "the twin must restore a nonempty group set"


def test_control_16_N_is_an_involution_on_the_real_view_and_stays_in_prep_main(
        real_driver_blob):
    """Control 16."""
    view = _projected(real_driver_blob)
    once = pol.vote_axis_involution(view)
    assert pol.vote_axis_involution(once) == view
    changed = [k for k in pol.payload(view)
               if pol.payload(once)[k] != pol.payload(view)[k]]
    assert set(changed) <= {"pca", "base-clusters", "group-clusters"}
    assert set(pol.payload(once)) <= PREP_MAIN_KEYS


def test_control_17_the_projected_view_is_refused_at_both_restore_boundaries(
        real_driver_blob):
    """Control 17 — the round-3 P3, now CLOSED. On the reviewed baseline the
    gate did NOT reject a projected+N view fed back as raw: it is a legal
    kebab-only blob, no alias pair exists, so C9 never runs. The
    output-profile marker is what makes the control fire, at both boundaries."""
    view = pol.vote_axis_involution(_projected(real_driver_blob))

    with pytest.raises(cert.CertifyError, match="output-profile marker"):
        cert.validate_checkpoint_blob(view, "misuse: projected view as raw")

    with pytest.raises(op.OutputProfileError, match="PROJECTED"):
        Conversation.from_dict(view)


MALFORMED_MARKERS = [
    None, False, True, 0, "projected", [], {},
    {"profile": "made-up/9", "restorable": False,
     "vote_axis": op.VOTE_AXIS_AS_EMITTED, "transforms": ["project_prep_main"]},
    {"profile": op.PROJECTED_PROFILE, "restorable": False,
     "vote_axis": "sideways", "transforms": ["project_prep_main"]},
    {"profile": op.PROJECTED_PROFILE, "restorable": "false",
     "vote_axis": op.VOTE_AXIS_AS_EMITTED, "transforms": ["project_prep_main"]},
    {"profile": op.PROJECTED_PROFILE, "restorable": False,
     "vote_axis": op.VOTE_AXIS_AS_EMITTED, "transforms": ["hand-rolled"]},
    {"profile": op.PROJECTED_PROFILE, "restorable": False,
     "vote_axis": op.VOTE_AXIS_AS_EMITTED, "transforms": []},
    {"profile": op.PROJECTED_PROFILE, "restorable": False,
     "vote_axis": op.VOTE_AXIS_AS_EMITTED, "transforms": ["project_prep_main"],
     "surprise": 1},
    {"profile": op.PROJECTED_PROFILE, "restorable": False,
     "vote_axis": op.VOTE_AXIS_AS_EMITTED},
]


@pytest.mark.parametrize("malformed", MALFORMED_MARKERS)
def test_control_17b_a_malformed_marker_does_not_bypass_either_boundary(
        real_driver_blob, malformed):
    """Astra #2730 F2. Both guards keyed on a well-formed dict, so replacing the
    marker value with null, false, a string or an array made the projected view
    read as unmarked RAW data: it passed the checkpoint gate and restored a
    conversation with zero groups. Malformed provenance is not the absence of
    provenance — the reserved key is refused whenever it is present."""
    view = pol.payload(pol.vote_axis_involution(_projected(real_driver_blob)))
    view[op.OUTPUT_PROFILE_KEY] = malformed

    with pytest.raises(cert.CertifyError, match="output-profile marker"):
        cert.validate_checkpoint_blob(view, "malformed marker")
    with pytest.raises(op.OutputProfileError):
        Conversation.from_dict(view)


@pytest.mark.parametrize("malformed", MALFORMED_MARKERS)
def test_N_refuses_a_malformed_marker_at_the_comparison_boundary(malformed):
    """The comparison boundary validates the marker's VALUES, not just its
    presence: N must not translate a view whose declared output convention is
    unreviewed or corrupted."""
    view = _projected(GEOMETRY_BLOB)
    view[op.OUTPUT_PROFILE_KEY] = malformed
    with pytest.raises(pol.PolarityError):
        pol.vote_axis_involution(view)


def test_a_well_formed_marker_round_trips_through_the_validator():
    view = _projected(GEOMETRY_BLOB)
    assert op.marker_problems(view[op.OUTPUT_PROFILE_KEY]) == []
    assert op.assert_valid_marker(view)["profile"] == op.PROJECTED_PROFILE
    assert op.has_marker(view) and op.is_projected_view(view)
    assert not op.has_marker(pol.payload(view))


def test_control_18_the_marker_is_what_prevents_the_silent_empty_restore(
        real_driver_blob):
    """Control 18 — the hazard the marker prevents, demonstrated. Strip the
    marker and the projected view restores a conversation that has LOST every
    group, with no error anywhere: ``data.get('group_clusters', [])``."""
    view = pol.payload(pol.vote_axis_involution(_projected(real_driver_blob)))
    assert op.OUTPUT_PROFILE_KEY not in view

    cert.validate_checkpoint_blob(view, "unmarked projected view")  # no error
    restored = Conversation.from_dict(view)
    assert restored.group_clusters == []
    assert real_driver_blob["group_clusters"] != []


# ---------------------------------------------------------------------------
# The property itself: the compensated pair through both real ingress paths.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("ingress", pol.INGRESS_PATHS)
@pytest.mark.parametrize("case_index", range(4))
def test_the_compensated_pair_holds_on_every_case_and_ingress(ingress, case_index):
    case = pol.default_cases()[case_index]
    result = pol.check_polarity_pair(case, ingress=ingress)
    assert result["verdict"] == "PASS", result["problems"]
    assert result["checkpoints"] > 0
    assert result["run_ids"][0] != result["run_ids"][1]


@pytest.mark.parametrize("declared", [-1, 1])
@pytest.mark.parametrize("ingress", pol.INGRESS_PATHS)
@pytest.mark.parametrize("control", pol.FAILING_CONTROLS)
def test_every_negative_control_reaches_its_gate_and_fails(ingress, control, declared):
    """Under BOTH declarations (Astra #2730 F4). The double-conversion control
    was injected unconditionally on the original side, which is the identity
    at s = +1: the "broken" pair passed on both ingress paths and the mandatory
    control proved nothing."""
    if control == pol.CONTROL_NULL_TO_PASS and ingress == pol.INGRESS_DB_ROWS:
        pytest.skip("NULL is INVALID_INPUT at the computing ingress; see the "
                    "rejection test below")
    case = pol.control_case(control)
    result = pol.check_polarity_pair(case, ingress=ingress, control=control,
                                     storage_agree_value=declared)
    assert result["verdict"] == "FAIL", result
    assert result["problems"], "a control must fail for a NAMED reason"
    assert result["checkpoints"] > 0, (
        "a control that collected zero comparisons failed setup, not its gate")


def test_the_computing_ingress_rejects_null_before_any_mutation():
    """G's v1 computing profile: INVALID_INPUT before mutation, never NULL->0."""
    case = pol.control_case(pol.CONTROL_NULL_TO_PASS)
    with pytest.raises(pol.PolarityError, match="INVALID_INPUT"):
        pol.check_polarity_pair(case, ingress=pol.INGRESS_DB_ROWS)


def test_the_pair_runs_from_a_declared_plus_one_convention_too():
    """The property is about the DECLARED convention, not about -1: it must
    hold with s = +1 declared on the original side as well."""
    result = pol.check_polarity_pair(pol.default_cases()[0], storage_agree_value=1)
    assert result["verdict"] == "PASS", result["problems"]
    assert result["conventions"]["original"]["storage_agree_value"] == 1
    assert result["conventions"]["flipped"]["storage_agree_value"] == -1


@pytest.mark.parametrize("declared", [-1, 1])
def test_the_standing_property_passes_and_carries_its_controls(declared):
    report = pol.run_standing_property(storage_agree_value=declared)
    assert report["verdict"] == "PASS", report["problems"]
    assert report["storage_agree_value"] == declared
    assert len(report["pairs"]) == 8
    assert len(report["controls"]) == 11
    assert all(r["verdict"] == "FAIL" for r in report["controls"])


def test_a_broken_ingress_conversion_fails_the_standing_property(monkeypatch):
    """The property must be SENSITIVE: break the one conversion the ingress
    performs and the gate has to go red, or it is decoration."""
    monkeypatch.setattr(pol, "semantic_vote", lambda v, s: v)
    monkeypatch.setattr(pc, "semantic_vote", lambda v, s: v)
    result = pol.check_polarity_pair(pol.default_cases()[0],
                                     ingress=pol.INGRESS_EXPORT_CSV)
    assert result["verdict"] == "FAIL"


# ---------------------------------------------------------------------------
# Descriptors, the recording cache, and the fixture manifest pin.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("kwargs", [
    {"storage_agree_value": True},
    {"pair_side": "whichever"},
    {"output_convention": ""},
    {"input_convention": ""},
    # "Unknown convention fails admission" is a predicate, not a sentiment:
    # a truthiness check accepted these (Astra #2730 F2).
    {"input_convention": "unknown-input/99"},
    {"output_convention": "unknown-output/99"},
])
def test_the_convention_descriptor_refuses_an_undeclared_convention(kwargs):
    with pytest.raises((pol.PolarityError, vc.VoteConventionError)):
        pol.ConventionDescriptor(**kwargs)


def test_the_convention_descriptor_flip_is_an_involution():
    assert pol.DEFAULT_CONVENTIONS.flip().flip() == pol.DEFAULT_CONVENTIONS


def test_changing_s_alone_forces_execution_rather_than_a_cache_hit(tmp_path):
    """Correction 7. Same votes file, same schedule, same engine tree — the
    ONLY difference is the declared convention. Under manifest/3 that was a
    cache hit and the control never reached its gate."""
    manifest_path = tmp_path / "cache_manifest.json"
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    (tmp_path / "step-000.json").write_text("{}")
    base = {
        "manifest_version": cert._RECORDING_MANIFEST_VERSION,
        "votes_sha256": "v", "schedule_hash": "s", "engine_tree_sha256": "e",
        **pol.DEFAULT_CONVENTIONS.cache_fields(),
    }
    cert._write_manifest(manifest_path, base)
    assert cert._manifest_matches(manifest_path, base)

    # Only the declared convention differs. The cached recording must NOT be
    # reused: _manifest_matches returns False, which is the "re-run the
    # producer" path, so the control executes instead of reading a stale run.
    other = dict(base, **pol.DEFAULT_CONVENTIONS.flip().cache_fields())
    assert other["storage_agree_value"] != base["storage_agree_value"]
    assert cert._manifest_matches(manifest_path, other) is False


def test_an_older_recording_manifest_is_never_reused(tmp_path):
    manifest_path = tmp_path / "cache_manifest.json"
    (tmp_path / "step-000.json").write_text("{}")
    for old in (1, 2, 3):
        cert._write_manifest(manifest_path, {"manifest_version": old})
        assert cert._manifest_matches(manifest_path, {"manifest_version": old}) is False


# ---------------------------------------------------------------------------
# Optional: the REAL Clojure driver on both sides of the pair.
# ---------------------------------------------------------------------------
@pytest.mark.skipif(
    shutil.which("clojure") is None or os.environ.get("RUN_CLJ_INTEGRATION") != "1",
    reason="opt-in: needs the clojure CLI on PATH and RUN_CLJ_INTEGRATION=1 "
           "(runs the REAL clojure driver on both sides of the pair)",
)
def test_the_pair_holds_through_the_real_clojure_driver(tmp_path):
    """The property on the OTHER engine, with its repeatability precondition.

    Two facts, in order:

    1. The compensated pair CONVERGES AT THE EXPORT BOUNDARY: side A formats
       raw ``V`` under ``s = -1`` and side B formats ``-V`` under ``s = +1``,
       and the two CSVs are byte-identical. That is the property's real content
       for a semantic-ingress engine — everything downstream is then a question
       about the engine's determinism, not its polarity.
    2. Whether the engine reproduces its own output. P-023: "Nondeterministic
       repeatability outside the pinned profile is INCONCLUSIVE until
       separately characterized, not a reason to weaken this invariant." So
       side A is replayed TWICE first. If those two runs of one identical input
       disagree, this profile cannot certify anything about polarity and the
       test reports INCONCLUSIVE rather than a PASS or a false FAIL.

    Observed while writing this (2026-09-08, local clojure CLI): on the small
    synthetic grid the Clojure driver's step 0 is stable (the pinned cold-start
    PCA) but its warm ticks are NOT bit-repeatable across runs of identical
    input, so this test reports INCONCLUSIVE there. The Python side of the
    property, which is deterministic, is certified by the tests above.
    """
    case = pol.default_cases()[0]
    spec_path = tmp_path / "schedule.json"
    spec_path.write_text(json.dumps(case.spec().to_dict()))

    def write_side(name, rows, s):
        side = tmp_path / name
        side.mkdir()
        votes_csv = side / "votes.csv"
        pc.write_votes_csv(
            votes_csv, pc.format_votes_rows(rows, storage_agree_value=s))
        return votes_csv

    csv_a = write_side("a", list(case.rows), -1)
    csv_b = write_side("b", pol.flip_raw_votes(case.rows), 1)
    assert csv_a.read_bytes() == csv_b.read_bytes(), (
        "the compensated pair must converge to identical SEMANTIC input at the "
        "export boundary; if it does not, the declared convention is not being "
        "read at that boundary")

    def replay(tag, votes_csv):
        out = tmp_path / f"out-{tag}"
        out.mkdir()
        result = cert.run_clj_driver(spec_path, votes_csv, out_dir=out)
        assert result.returncode == 0, (result.stderr or result.stdout)[:2000]
        blobs = sorted(out.rglob("step-*.blob.json"))
        assert blobs, "the clojure driver recorded no checkpoint"
        return [pol.payload(pol.comparison_view(json.loads(p.read_text())))
                for p in blobs]

    first = replay("a1", csv_a)
    repeat = replay("a2", csv_a)
    if first != repeat:
        pytest.skip(
            "INCONCLUSIVE: the Clojure driver is not bit-repeatable on this "
            "profile — two replays of one identical input disagree, so a "
            "polarity pair here would measure nondeterminism, not polarity. "
            "Characterize repeatability separately (P-023); this is never a "
            "reason to weaken the invariant.")

    other = replay("b1", csv_b)
    assert len(other) == len(first) > 0
    for i, (a, b) in enumerate(zip(first, other)):
        assert a == b, f"clojure pair diverged at step {i}"
