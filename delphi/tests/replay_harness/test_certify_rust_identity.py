"""P-045 slice 2 (half): S1 closed, VERSIONED identity on a candidate checkpoint.

Pure controls. Round 2 (board [398]) correction 3: the validator binds the
checkpoint schema and every retained field's expected value/type, rejects null
identity fields, empty admission strings and unknown admission keys. The real
DB-side identity is graded by the P-026 coordinator suite against Postgres.
"""

from __future__ import annotations

import pytest

from polismath.replay import coordinator_driver as cd


def _manifest(**over):
    admission = {
        "candidate_schema": cd.S1_CANDIDATE_SCHEMA,
        "engine_version": cd.S1_ENGINE_VERSION,
        "input_digest": "sha256:i", "schedule_digest": "sha256:s",
        "operation_id": "op-1",
    }
    admission.update(over.pop("admission", {}))
    m = {
        "schema": cd.S1_CHECKPOINT_SCHEMA, "admission": admission,
        "protocol": cd.S1_PROTOCOL, "fixture_id": 1, "run_id": "r",
        "session_id": "s", "compute_id": "compute-0", "checkpoint_id": "checkpoint-0",
        "output_schema": cd.S1_OUTPUT_SCHEMA, "state_schema": cd.S1_STATE_SCHEMA,
        "profile": cd.S1_PROFILE_WIRE, "persistence": False,
    }
    m.update(over)
    return m


def test_identity_intact():
    assert cd.validate_s1_identity(_manifest()) == []


def test_checkpoint_schema_required():
    assert any("schema" in f for f in cd.validate_s1_identity(_manifest(schema="other/1")))


def test_all_null_checkpoint_fields_rejected():
    """Correction 3 reproduction, inverted: null retained fields + empty admission
    strings + an extra admission key must NOT pass."""
    m = {k: None for k in cd.S1_CHECKPOINT_FIELDS}
    m["schema"] = cd.S1_CHECKPOINT_SCHEMA
    m["admission"] = dict(candidate_schema=cd.S1_CANDIDATE_SCHEMA,
                          engine_version=cd.S1_ENGINE_VERSION, input_digest="",
                          schedule_digest="", operation_id="", extra=True)
    fails = cd.validate_s1_identity(m)
    assert fails
    assert any("unknown key" in f for f in fails)
    assert any("nonempty string" in f for f in fails)


def test_wrong_candidate_schema_rejected():
    assert any("candidate_schema" in f for f in
               cd.validate_s1_identity(_manifest(admission={"candidate_schema": "polis-candidate-input/2"})))


def test_wrong_engine_version_is_not_accepted_as_s1():
    fails = cd.validate_s1_identity(_manifest(admission={"engine_version": "python-conversation/p026-s2"}))
    assert any("engine_version" in f and "negotiate" in f for f in fails)


def test_unknown_admission_key_rejected():
    assert any("unknown key" in f for f in
               cd.validate_s1_identity(_manifest(admission={"surprise": 1})))


@pytest.mark.parametrize("field", cd.S1_ADMISSION_FIELDS)
def test_missing_admission_field_rejected(field):
    m = _manifest()
    m["admission"].pop(field)
    assert any(field in f for f in cd.validate_s1_identity(m))


@pytest.mark.parametrize("field", ["input_digest", "schedule_digest", "operation_id"])
def test_empty_admission_digest_rejected(field):
    assert any(field in f for f in cd.validate_s1_identity(_manifest(admission={field: ""})))


@pytest.mark.parametrize("field", cd.S1_CHECKPOINT_FIELDS)
def test_missing_checkpoint_field_rejected(field):
    m = _manifest()
    m.pop(field)
    assert any(field in f for f in cd.validate_s1_identity(m))


@pytest.mark.parametrize("field,bad", [
    ("output_schema", "polis-candidate-math-output/2"),
    ("state_schema", "rebuild-prefix/2"),
    ("profile", "not-candidate"),
    ("protocol", "polis-engine/2"),
    ("fixture_id", True),      # bool is not a plain int
    ("fixture_id", "1"),
    ("persistence", "no"),
    ("run_id", ""),
])
def test_bound_checkpoint_value_rejected(field, bad):
    assert any(field in f for f in cd.validate_s1_identity(_manifest(**{field: bad})))


def test_missing_admission_block():
    fails = cd.validate_s1_identity({"schema": cd.S1_CHECKPOINT_SCHEMA})
    assert any("admission block missing" in f for f in fails)


def test_campaign_cut_binding_distinguishes_plan_hash_from_schedule_digest():
    b = cd.bind_campaign_cut(compute_id="compute-0", checkpoint_id="checkpoint-0",
                             global_cut_index=5, schedule_digest="sha256:s1sched",
                             campaign_plan_sha256="sha256:campaign")
    assert b["global_cut_index"] == 5
    assert b["s1_schedule_digest"] != b["campaign_plan_sha256"]
