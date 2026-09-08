"""P-045 slice 2 (half): S1 closed, VERSIONED identity on a candidate checkpoint.

Pure controls. Round 2 (board [398]) correction 3: the validator binds the
checkpoint schema and every retained field's expected value/type, rejects null
identity fields, empty admission strings and unknown admission keys. The real
DB-side identity is graded by the P-026 coordinator suite against Postgres.
"""

from __future__ import annotations

import pytest

from polismath.replay import coordinator_driver as cd


def _cursors():
    return {"votes": {"slot": 0, "sha256": "a" * 64},
            "moderation": {"slot": 0, "sha256": "b" * 64}}


def _files():
    return {k: {"path": f"checkpoint-0/{k}.json", "bytes": 12, "sha256": "c" * 64}
            for k in cd.S1_FILE_KEYS}


def _manifest(**over):
    """The FULL 15-field polis-candidate-checkpoint/1 envelope emitted by
    engine_adapter.snapshot (files + both cursor maps included)."""
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
        "math_input_cursors": _cursors(), "observed_state_cursors": _cursors(),
        "files": _files(),
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
    ("persistence", True),     # round 3: persistence must be EXACTLY False
    ("run_id", ""),
])
def test_bound_checkpoint_value_rejected(field, bad):
    assert any(field in f for f in cd.validate_s1_identity(_manifest(**{field: bad})))


# ---------------------------------------------------------------------------
# Round 3 correction 2: per-run expected admission/identity binding.
# ---------------------------------------------------------------------------
_EXPECTED_ADMISSION = {"input_digest": "sha256:i", "schedule_digest": "sha256:s",
                       "operation_id": "op-1"}
_EXPECTED_IDENTITY = {"run_id": "r", "session_id": "s", "compute_id": "compute-0",
                      "checkpoint_id": "checkpoint-0"}


def test_expected_binding_accepts_matching_identity():
    assert cd.validate_s1_identity(_manifest(), expected_admission=_EXPECTED_ADMISSION,
                                   expected_identity=_EXPECTED_IDENTITY) == []


def test_expected_binding_rejects_foreign_session():
    fails = cd.validate_s1_identity(_manifest(session_id="foreign-session"),
                                    expected_identity=_EXPECTED_IDENTITY)
    assert any("session_id" in f and "expected" in f for f in fails)


def test_expected_binding_rejects_changed_input_digest():
    fails = cd.validate_s1_identity(_manifest(admission={"input_digest": "sha256:CHANGED"}),
                                    expected_admission=_EXPECTED_ADMISSION)
    assert any("input_digest" in f and "expected" in f for f in fails)


# ---------------------------------------------------------------------------
# Round 4 correction 2: full worker envelope + fixture binding.
# ---------------------------------------------------------------------------
def test_full_envelope_positive_fixture_accepted():
    """The full 15-field emitted shape validates clean (positive control)."""
    assert cd.validate_s1_identity(_manifest()) == []


@pytest.mark.parametrize("field", ["files", "math_input_cursors", "observed_state_cursors"])
def test_missing_envelope_field_rejected(field):
    m = _manifest()
    m.pop(field)
    assert any("envelope" in f or field in f for f in cd.validate_s1_identity(m))


def test_unknown_top_level_field_rejected():
    assert any("unknown key" in f for f in cd.validate_s1_identity(_manifest(surprise=True)))


@pytest.mark.parametrize("mutate", [
    lambda m: m["files"].pop("restore"),
    lambda m: m["files"]["main"].pop("sha256"),
    lambda m: m["files"]["main"].update(bytes="10"),   # bytes must be a plain int
    lambda m: m["math_input_cursors"]["votes"].update(slot=True),   # boolean cursor slot
    lambda m: m["observed_state_cursors"].pop("moderation"),
])
def test_malformed_files_or_cursors_rejected(mutate):
    m = _manifest()
    mutate(m)
    assert cd.validate_s1_identity(m)


def test_expected_fixture_binding_rejects_foreign_fixture():
    """Round 4: fixture_id is bound — a checkpoint for fixture 999 must not pass
    when the caller expects fixture 1."""
    expected = dict(_EXPECTED_IDENTITY, fixture_id=1)
    fails = cd.validate_s1_identity(_manifest(fixture_id=999), expected_identity=expected)
    assert any("fixture_id" in f and "expected" in f for f in fails)


def test_missing_admission_block():
    fails = cd.validate_s1_identity({"schema": cd.S1_CHECKPOINT_SCHEMA})
    assert any("missing admission" in f for f in fails)


def test_campaign_cut_binding_distinguishes_plan_hash_from_schedule_digest():
    b = cd.bind_campaign_cut(compute_id="compute-0", checkpoint_id="checkpoint-0",
                             global_cut_index=5, schedule_digest="sha256:s1sched",
                             campaign_plan_sha256="sha256:campaign")
    assert b["global_cut_index"] == 5
    assert b["s1_schedule_digest"] != b["campaign_plan_sha256"]


# ---------------------------------------------------------------------------
# Round 5 (board [440]): worker cursor/file custody bound by VALUE, not shape.
# ---------------------------------------------------------------------------
def test_input_and_observed_cursors_must_agree():
    m = _manifest()
    m["observed_state_cursors"]["votes"]["slot"] = 999   # input stays 0
    fails = cd.validate_s1_identity(m, expected_admission=m["admission"], expected_identity=m)
    assert any("disagree" in f for f in fails)


@pytest.mark.parametrize("mutate", [
    lambda m: m["files"]["main"].update(bytes=-1),          # negative descriptor length
    lambda m: m["files"]["main"].update(sha256="not-a-digest"),
    lambda m: m["math_input_cursors"]["votes"].update(slot=-1),  # negative cursor slot
    lambda m: m["math_input_cursors"]["votes"].update(sha256="not-a-digest"),
])
def test_negative_lengths_and_invalid_digests_rejected(mutate):
    m = _manifest()
    mutate(m)
    assert cd.validate_s1_identity(m)


def test_expected_cursors_and_files_binding():
    m = _manifest()
    good_cursors = _cursors()
    assert cd.validate_s1_identity(m, expected_cursors=good_cursors) == []
    other = _cursors()
    other["votes"]["slot"] = 7
    assert cd.validate_s1_identity(m, expected_cursors=other)
    assert cd.validate_s1_identity(m, expected_files={"nope": 1})


# ---------------------------------------------------------------------------
# Round 6 (board [445]): graded outer-container admission.
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("bad", [None, [], "x", 7])
def test_validate_s1_identity_nonobject_is_graded(bad):
    fails = cd.validate_s1_identity(bad)
    assert isinstance(fails, list) and fails and all(isinstance(f, str) for f in fails)
