"""P-045 slice 2 (half): S1 closed-identity validation on a candidate checkpoint.

Pure controls. The real DB-side identity (persisted checkpoint, publisher epoch)
is graded by the P-026 coordinator suite against real Postgres; this pins the
bridge validator that the slice-3 real-readback controls will reuse.
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
        "admission": admission, "protocol": "polis-engine/1", "fixture_id": 1,
        "run_id": "r", "session_id": "s", "compute_id": "compute-0",
        "checkpoint_id": "checkpoint-0", "output_schema": "polis-candidate-math-output/1",
        "state_schema": "rebuild-prefix/1", "profile": "candidate-profile",
        "persistence": False,
    }
    m.update(over)
    return m


def test_identity_intact():
    assert cd.validate_s1_identity(_manifest()) == []


def test_wrong_candidate_schema_rejected():
    fails = cd.validate_s1_identity(_manifest(admission={"candidate_schema": "polis-candidate-input/2"}))
    assert any("candidate_schema" in f for f in fails)


def test_wrong_engine_version_is_not_accepted_as_s1():
    fails = cd.validate_s1_identity(_manifest(admission={"engine_version": "python-conversation/p026-s2"}))
    assert any("engine_version" in f and "negotiate" in f for f in fails)


@pytest.mark.parametrize("field", cd.S1_ADMISSION_FIELDS)
def test_missing_admission_field_rejected(field):
    m = _manifest()
    m["admission"].pop(field)
    assert any(field in f for f in cd.validate_s1_identity(m))


@pytest.mark.parametrize("field", cd.S1_CHECKPOINT_FIELDS)
def test_missing_checkpoint_field_rejected(field):
    m = _manifest()
    m.pop(field)
    assert any(field in f for f in cd.validate_s1_identity(m))


def test_non_string_digest_rejected():
    fails = cd.validate_s1_identity(_manifest(admission={"input_digest": 123}))
    assert any("input_digest" in f for f in fails)


def test_missing_admission_block():
    assert cd.validate_s1_identity({}) == ["admission block missing or not an object"]


def test_campaign_cut_binding_distinguishes_plan_hash_from_schedule_digest():
    """S1 resets names to compute-0/checkpoint-0 in a fresh session; the sidecar
    binds each such local identity to ONE global cut, keeping the campaign plan
    hash distinct from S1's per-session schedule_digest."""
    b = cd.bind_campaign_cut(compute_id="compute-0", checkpoint_id="checkpoint-0",
                             global_cut_index=5, schedule_digest="sha256:s1sched",
                             campaign_plan_sha256="sha256:campaign")
    assert b["global_cut_index"] == 5
    assert b["s1_schedule_digest"] != b["campaign_plan_sha256"]
