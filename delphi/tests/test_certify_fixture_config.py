"""Unit tests for the certification fixture SELECTION config and rule engine.

Covers ``delphi/scripts/certify_datasets.json``, its JSON Schema, the
dependency-free Draft-07 subset validator and the seven semantic rules in
``polismath.replay.fixture_config``, plus the deterministic rule resolution in
``polismath.replay.fixture_survey``.

Everything here runs on SYNTHETIC metric rows invented for this file. No real
zid, report id, topic or vote appears anywhere.
"""

from __future__ import annotations

import copy
import json

import pytest

from polismath.replay import fixture_bundle as fb
from polismath.replay import fixture_config as fc
from polismath.replay import fixture_survey as fs


@pytest.fixture(scope="module")
def schema():
    return fc.load_schema()


@pytest.fixture(scope="module")
def config():
    return json.loads(fc.DEFAULT_CONFIG_PATH.read_text())


# ---------------------------------------------------------------------------
# The shipped config.
# ---------------------------------------------------------------------------


def test_shipped_config_validates():
    fc.load_config()  # raises ConfigError on any defect


def test_shipped_config_has_every_spec_role(config):
    roles = {r["role"] for r in config["roles"]}
    required = {
        "revote-heavy", "banned-participant", "zero-vote", "small-mix", "mid-mix",
        "moderation-heavy", "meta-rich-cold", "meta-rich-warm",
        "large-shape-rank-1", "large-shape-rank-2", "large-shape-rank-4",
        "large-shape-rank-8", "large-shape-rank-16",
        "participant-heavy-under-5k-comments", "max-matrix-area-under-5k-comments",
        "dense-max-area", "dense-max-density",
    }
    assert required <= roles
    replacement = [r for r in config["roles"] if r["group"] == "replacement"]
    assert len(replacement) == 13, "the spec's table has exactly thirteen roles"


def test_shipped_config_has_every_boundary_case(config):
    ids = {c["id"] for c in config["generated"]["cases"]}
    for needed in (
        "gen-v1-ptpt-9999", "gen-v1-ptpt-10000", "gen-v1-ptpt-10001",
        "gen-v1-cmt-4999", "gen-v1-cmt-5000", "gen-v1-cmt-5001",
        "gen-v1-one-voter", "gen-v1-two-voters", "gen-v1-too-few-voters",
        "gen-v1-all-pass", "gen-v1-constant-column",
        "gen-v1-no-eligible-comments", "gen-v1-repeated-timestamps",
        "gen-v1-out-of-order-commits", "gen-v1-dormant",
        "gen-v1-lru-cohort", "gen-v1-scale-33422x783",
    ):
        assert needed in ids, f"missing boundary case {needed}"


def test_config_contains_no_identifiers(config):
    """The config is committed to a PUBLIC repository: it must carry no zid,
    report id or free text that could identify a conversation."""
    text = json.dumps(config)
    assert '"zid":' not in text.replace('"zid": {', "")  # only the metric DEFINITION
    for role in config["roles"]:
        assert set(role) <= {
            "role", "slug", "group", "rank", "selection_group", "predicates",
            "order_by", "on_missing", "synthetic_replacement", "exercise", "notes",
        }
        for pred in role["predicates"]:
            assert isinstance(pred["value"], (int, float))


def test_metric_sources_agree(config):
    assert set(config["metrics"]) == fc.KNOWN_METRICS
    assert set(fs.METRIC_DEFINITIONS) == fc.KNOWN_METRICS


def test_every_metric_declares_a_denominator(config):
    for name, spec in config["metrics"].items():
        assert spec["definition"], name
        assert "denominator" in spec, f"{name} must state its denominator"


# ---------------------------------------------------------------------------
# Schema-subset validator.
# ---------------------------------------------------------------------------


def test_validator_rejects_unsupported_schema_keyword():
    with pytest.raises(fc.ConfigError, match="unsupported keyword"):
        fc.validate_against_schema({}, {"type": "object", "maxProperties": 1})


def test_validator_reports_every_error_not_just_the_first():
    errors = fc.validate_against_schema(
        {"a": 1}, {"type": "object", "required": ["b", "c"],
                   "properties": {"a": {"type": "string"}},
                   "additionalProperties": False})
    assert len(errors) == 3


def _broken(config, mutate):
    bad = copy.deepcopy(config)
    mutate(bad)
    return bad


@pytest.mark.parametrize("mutate,needle", [
    (lambda c: c["roles"][0].update(slug="PC_V1_REVOTE"), "does not match"),
    (lambda c: c["roles"][0].update(unexpected=True), "unexpected property"),
    (lambda c: c["roles"][0].pop("exercise"), "missing required property"),
    (lambda c: c.update(schema_version="certify-datasets/2"), "expected const"),
    (lambda c: c["roles"][0]["predicates"][0].update(op="approx"), "not in enum"),
    (lambda c: c["generated"].update(seed=-1), "minimum"),
])
def test_structural_rejections(config, schema, mutate, needle):
    errors = fc.validate_against_schema(_broken(config, mutate), schema)
    assert any(needle in e for e in errors), errors


@pytest.mark.parametrize("mutate,needle", [
    # Rule 2 — the zid tie-break must be last and unique.
    (lambda c: c["roles"][0]["order_by"].pop(),
     "must end with the zid-ascending tie-break"),
    (lambda c: c["roles"][0]["order_by"].insert(
        0, {"metric": "zid", "direction": "asc"}),
     "zid may only appear as the final tie-break"),
    (lambda c: c["roles"][0]["order_by"].__setitem__(
        -1, {"metric": "zid", "direction": "desc"}),
     "must end with the zid-ascending tie-break"),
    # Rule 1 — unknown metric.
    (lambda c: c["roles"][0]["predicates"][0].update(metric="vibes"),
     "is not declared in $.metrics"),
    # Rule 3 — duplicate slug.
    (lambda c: c["roles"][1].update(slug=c["roles"][0]["slug"]),
     "duplicate slug"),
    # Rule 4 — synthetic replacement discipline.
    (lambda c: c["roles"][0].update(
        on_missing="fail_with_synthetic_replacement_offer"),
     "requires synthetic_replacement"),
    (lambda c: c["roles"][0].update(synthetic_replacement="gen-v1-one-voter"),
     "only meaningful with"),
    # Rule 5 — a replacement role may not follow a stress role.
    (lambda c: c["roles"].insert(0, dict(c["roles"][-1], slug="pc-v1-early-stress",
                                         role="early-stress")),
     "appears after a group=stress role"),
    # Rule 6 — workload references.
    (lambda c: c["workloads"][0]["references"].append("pc-v1-nope"),
     "references unknown role slug"),
    # Rule 7 — generated cases.
    (lambda c: next(x for x in c["generated"]["cases"]
                    if x["shape"] == "lru-cohort").pop("cohort_size"),
     "shape=lru-cohort requires cohort_size"),
    (lambda c: c["generated"]["cases"][0].update(cohort_size=3),
     "only meaningful for shape=lru-cohort"),
])
def test_semantic_rejections(config, mutate, needle):
    with pytest.raises(fc.ConfigError, match=needle.replace("$", r"\$")):
        fc.validate_config(_broken(config, mutate))


@pytest.mark.parametrize("mutate,needle", [
    (lambda c: next(r for r in c["roles"]
                    if r.get("selection_group"))["predicates"].append(
        {"metric": "V", "op": "ge", "value": 1}),
     "must share identical predicates"),
    (lambda c: next(r for r in c["roles"]
                    if r.get("selection_group"))["order_by"].insert(
        0, {"metric": "P", "direction": "desc"}),
     "must share identical order_by"),
    (lambda c: next(r for r in c["roles"]
                    if r.get("selection_group")).update(
        rank=next(r for r in reversed(c["roles"])
                  if r.get("selection_group"))["rank"]),
     "must have distinct ranks"),
    (lambda c: c["roles"].insert(
        next(i for i, r in enumerate(c["roles"]) if r.get("selection_group")) + 1,
        dict(c["roles"][0], slug="pc-v1-interloper", role="interloper")),
     "must be contiguous"),
])
def test_selection_group_rejections(config, mutate, needle):
    with pytest.raises(fc.ConfigError, match=needle):
        fc.validate_config(_broken(config, mutate))


def test_selection_group_members_rank_into_one_shared_list():
    """The spec's large-shape rule selects ranks 1/2/4/8/16 from ONE ordering;
    an earlier rank must not shift a later one."""
    cfg = copy.deepcopy(_MINI_CONFIG)
    template = cfg["roles"][0]
    cfg["roles"] = [
        dict(template, slug=f"pc-v1-r{k}", role=f"r{k}", rank=k,
             selection_group="shared")
        for k in (1, 2, 4)
    ]
    rows = [_row(z, V=1000 - z) for z in range(1, 9)]
    sels = {s.slug: s.zid for s in fs.resolve_roles(cfg, rows)}
    assert sels == {"pc-v1-r1": 1, "pc-v1-r2": 2, "pc-v1-r4": 4}


def test_unknown_synthetic_replacement_is_rejected(config):
    def mutate(c):
        role = next(r for r in c["roles"]
                    if r["on_missing"] == "fail_with_synthetic_replacement_offer")
        role["synthetic_replacement"] = "gen-v1-does-not-exist"

    with pytest.raises(fc.ConfigError, match="is not a generated case id"):
        fc.validate_config(_broken(config, mutate))


# ---------------------------------------------------------------------------
# Rule engine.
# ---------------------------------------------------------------------------


def test_null_metric_fails_every_predicate():
    row = {"density": None, "V": 10}
    assert not fc.evaluate_predicates(row, [{"metric": "density", "op": "ge", "value": 0}])
    assert not fc.evaluate_predicates(row, [{"metric": "density", "op": "lt", "value": 1}])
    assert fc.evaluate_predicates(row, [{"metric": "V", "op": "ge", "value": 10}])


def test_null_metric_sorts_last_in_both_directions():
    rows = [{"m": None, "zid": 1}, {"m": 5, "zid": 2}]
    for direction in ("asc", "desc"):
        order = [{"metric": "m", "direction": direction},
                 {"metric": "zid", "direction": "asc"}]
        assert sorted(rows, key=lambda r: fc.sort_key_for(r, order))[0]["m"] == 5


def test_zid_ascending_breaks_ties():
    order = [{"metric": "V", "direction": "desc"}, {"metric": "zid", "direction": "asc"}]
    rows = [{"V": 10, "zid": 9}, {"V": 10, "zid": 3}, {"V": 10, "zid": 7}]
    assert [r["zid"] for r in sorted(rows, key=lambda r: fc.sort_key_for(r, order))] \
        == [3, 7, 9]


# ---------------------------------------------------------------------------
# Deterministic role resolution.
# ---------------------------------------------------------------------------


def _row(zid, **over):
    base = dict(zid=zid, V=0, U=0, P=0, C=0, matrix_area=0, revote_share=None,
                density=None, registered_participants=0, all_comments=0,
                math_eligible_comments=0, mod_out_or_meta_comments=0,
                eligible_participants=0, banned_voters=0, mod_out_share=None,
                meta_share=None)
    base.update(over)
    return base


_MINI_CONFIG = {
    "schema_version": "certify-datasets/1",
    "config_version": "test",
    "metrics": {m: {"definition": "test"} for m in fc.KNOWN_METRICS},
    "roles": [
        {"role": "big", "slug": "pc-v1-big", "group": "replacement", "rank": 1,
         "predicates": [{"metric": "V", "op": "ge", "value": 100}],
         "order_by": [{"metric": "V", "direction": "desc"},
                      {"metric": "zid", "direction": "asc"}],
         "on_missing": "fail", "exercise": "x"},
        {"role": "big2", "slug": "pc-v1-big2", "group": "replacement", "rank": 1,
         "predicates": [{"metric": "V", "op": "ge", "value": 100}],
         "order_by": [{"metric": "V", "direction": "desc"},
                      {"metric": "zid", "direction": "asc"}],
         "on_missing": "fail", "exercise": "x"},
        {"role": "reuse", "slug": "pc-v1-reuse", "group": "stress", "rank": 1,
         "predicates": [{"metric": "V", "op": "ge", "value": 100}],
         "order_by": [{"metric": "V", "direction": "desc"},
                      {"metric": "zid", "direction": "asc"}],
         "on_missing": "fail", "exercise": "x"},
        {"role": "impossible", "slug": "pc-v1-impossible", "group": "stress", "rank": 1,
         "predicates": [{"metric": "V", "op": "ge", "value": 10 ** 9}],
         "order_by": [{"metric": "V", "direction": "desc"},
                      {"metric": "zid", "direction": "asc"}],
         "on_missing": "fail_with_synthetic_replacement_offer",
         "synthetic_replacement": "gen-v1-dense-stress", "exercise": "x"},
    ],
    "workloads": [],
    "generated": {"generator_id": "t", "generator_version": "1", "seed": 1,
                  "cases": [{"id": "gen-v1-dense-stress", "boundary": "b",
                             "participants": 1, "comments": 1, "shape": "dense-block"}]},
}


def test_mini_config_is_itself_valid():
    fc.validate_config(_MINI_CONFIG)


def test_replacement_roles_reserve_conversations_stress_roles_reuse():
    rows = [_row(11, V=500), _row(12, V=400), _row(13, V=300)]
    cfg = copy.deepcopy(_MINI_CONFIG)
    cfg["roles"] = cfg["roles"][:3]
    sels = {s.slug: s for s in fs.resolve_roles(cfg, rows)}
    assert sels["pc-v1-big"].zid == 11
    # big2 EXCLUDES 11 because an earlier replacement role took it ("among
    # remaining"), so it gets the next-ranked conversation.
    assert sels["pc-v1-big2"].zid == 12
    # The stress role does NOT exclude, so it reuses 11 and discloses overlap.
    assert sels["pc-v1-reuse"].zid == 11
    assert sels["pc-v1-reuse"].overlaps_with == ["pc-v1-big"]


def test_missing_role_fails_loudly_and_names_the_role():
    rows = [_row(11, V=500), _row(12, V=400)]
    with pytest.raises(fs.RoleUnsatisfied) as exc:
        fs.resolve_roles(_MINI_CONFIG, rows)
    assert exc.value.role == "impossible"
    assert exc.value.synthetic_replacement == "gen-v1-dense-stress"
    assert "--accept-synthetic" in str(exc.value)


def test_synthetic_replacement_requires_explicit_acceptance():
    rows = [_row(11, V=500), _row(12, V=400)]
    sels = fs.resolve_roles(_MINI_CONFIG, rows,
                            accept_synthetic=["pc-v1-impossible"])
    sub = next(s for s in sels if s.slug == "pc-v1-impossible")
    assert sub.zid is None
    assert sub.synthetic_replacement == "gen-v1-dense-stress"


def test_rank_indexes_into_the_remaining_ordered_list():
    cfg = copy.deepcopy(_MINI_CONFIG)
    cfg["roles"] = [dict(cfg["roles"][0], rank=3, slug="pc-v1-r3", role="r3")]
    rows = [_row(z, V=1000 - z) for z in range(1, 8)]
    assert fs.resolve_roles(cfg, rows)[0].zid == 3


def test_coverage_report_carries_no_identities():
    rows = [_row(11, V=500), _row(12, V=400)]
    report = fs.coverage_report(_MINI_CONFIG, rows)
    text = json.dumps(report)
    assert "11" not in text.replace('"rank": 1', "").replace('"n_candidates": 1', "")
    assert report["pc-v1-impossible"]["satisfied"] is False
    assert report["pc-v1-big"]["n_candidates"] == 2


# ---------------------------------------------------------------------------
# Metric derivation.
# ---------------------------------------------------------------------------


def test_derive_metrics_denominators_and_nulls():
    m = fs.derive_metrics({
        "zid": 7, "v_events": 10, "u_cells": 8, "p_voters": 4, "c_voted_comments": 5,
        "registered_participants": 9, "all_comments": 5, "mod_out_comments": 1,
        "meta_comments": 2, "math_eligible_comments": 2,
        "mod_out_or_meta_comments": 3, "eligible_participants": 3, "banned_voters": 1,
    })
    assert m["revote_share"] == pytest.approx((10 - 8) / 10)
    assert m["matrix_area"] == 20
    assert m["density"] == pytest.approx(8 / 20)
    assert m["mod_out_share"] == pytest.approx(1 / 5)
    assert m["meta_share"] == pytest.approx(2 / 5)
    # Registered participants are recorded but are NOT the matrix rows.
    assert m["registered_participants"] == 9 and m["P"] == 4


def test_derive_metrics_empty_conversation_has_null_ratios():
    m = fs.derive_metrics({
        "zid": 1, "v_events": 0, "u_cells": 0, "p_voters": 0, "c_voted_comments": 0,
        "registered_participants": 3, "all_comments": 0, "mod_out_comments": 0,
        "meta_comments": 0, "math_eligible_comments": 0,
        "mod_out_or_meta_comments": 0, "eligible_participants": 0, "banned_voters": 0,
    })
    assert m["revote_share"] is None and m["density"] is None
    assert m["mod_out_share"] is None and m["meta_share"] is None


def test_redacted_survey_drops_every_zid():
    planted = (987654321, 876543219)
    rows = [_row(planted[0], V=5), _row(planted[1], V=7)]
    survey = fs.build_survey(rows, {"isolation_level": "repeatable read"})
    redacted = fs.redact_survey(survey)
    text = json.dumps(redacted)
    assert not fb.scan_for_identifiers(text, [str(z) for z in planted])
    assert "zid" not in redacted["metric_summary"]
    assert redacted["n_conversations"] == 2
