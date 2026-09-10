use polis_coordinator::{
    engine::{AdmissionError, CANDIDATE_SCHEMA, ENGINE_VERSION, admit_candidate},
    store::{Bundle, CommitReadback, Current, OriginalPayloads, Payloads, classify_commit},
};
use serde_json::{Value, json};
fn requested() -> Value {
    json!({"candidate_schema":CANDIDATE_SCHEMA,"engine_version":ENGINE_VERSION,
        "input_digest":"a".repeat(64),"schedule_digest":"b".repeat(64),"operation_id":"public-fixture-op"})
}
#[test]
fn matching_candidate_is_admitted() {
    assert_eq!(admit_candidate(&requested(), &requested()), Ok(()));
}
macro_rules! refusal {
    ($name:ident, $key:literal, $value:expr, $reason:ident) => {
        #[test]
        fn $name() {
            let mut actual = requested();
            actual[$key] = json!($value);
            assert_eq!(
                admit_candidate(&actual, &requested()),
                Err(AdmissionError::$reason)
            );
        }
    };
}
refusal!(
    reserved_schema_refused,
    "candidate_schema",
    "polis-input/1",
    Schema
);
refusal!(
    engine_version_refused,
    "engine_version",
    "foreign/1",
    Engine
);
refusal!(input_digest_refused, "input_digest", "0".repeat(64), Input);
refusal!(
    schedule_digest_refused,
    "schedule_digest",
    "0".repeat(64),
    Schedule
);
refusal!(operation_refused, "operation_id", "other-op", Operation);
refusal!(unknown_field_refused, "extra", "field", Malformed);
refusal!(wrong_type_refused, "engine_version", 1, Malformed);
#[test]
fn missing_and_malformed_identity_refused() {
    for actual in [
        Value::Null,
        json!([]),
        json!({}),
        json!({"candidate_schema":CANDIDATE_SCHEMA}),
    ] {
        assert_eq!(
            admit_candidate(&actual, &requested()),
            Err(AdmissionError::Malformed)
        );
    }
}
fn current(epoch: i64, operation: &str) -> Current {
    Current::Coherent(Box::new(Bundle {
        payloads: Payloads::from_originals(OriginalPayloads {
            main: b"{}".to_vec(),
            bidtopid: b"{}".to_vec(),
            ptptstats: b"{}".to_vec(),
        })
        .unwrap_or_else(|e| panic!("{e}")),
        publisher_epoch: epoch,
        operation_id: operation.into(),
        math_tick: 0,
        caching_tick: 1,
        checkpoint: json!({"public-fixture":"identical deterministic checkpoint"}),
    }))
}
#[test]
fn uncertain_commit_requires_own_epoch_even_at_identical_tick_and_checkpoint() {
    let checkpoint = json!({"public-fixture":"identical deterministic checkpoint"});
    assert_eq!(
        classify_commit(&current(7, "op"), &checkpoint, 7, "op", 0),
        CommitReadback::Own(0)
    );
    assert_eq!(
        classify_commit(&current(8, "op"), &checkpoint, 7, "op", 0),
        CommitReadback::Lost
    );
}
#[test]
fn uncertain_commit_requires_own_operation_tick_and_checkpoint() {
    let checkpoint = json!({"public-fixture":"identical deterministic checkpoint"});
    assert_eq!(
        classify_commit(&current(7, "other"), &checkpoint, 7, "op", 0),
        CommitReadback::Lost
    );
    assert_eq!(
        classify_commit(&current(7, "op"), &checkpoint, 7, "op", 1),
        CommitReadback::Lost
    );
    assert_eq!(
        classify_commit(&current(7, "op"), &json!({}), 7, "op", 0),
        CommitReadback::Lost
    );
    assert_eq!(
        classify_commit(&Current::Inconsistent, &checkpoint, 7, "op", 0),
        CommitReadback::Lost
    );
}

#[test]
fn checkpoint_envelope_rejects_unknown_missing_and_foreign_fields() -> anyhow::Result<()> {
    use polis_coordinator::engine::admit_checkpoint;
    let identity =
        json!({"fixture_id":1,"run_id":"r","session_id":"s","checkpoint_id":"c","compute_id":"m"});
    let mut candidate = identity.clone();
    for (key, value) in json!({"schema":"polis-candidate-checkpoint/1","protocol":"polis-engine/1",
        "profile":"candidate-profile","admission":requested(),"output_schema":"polis-candidate-math-output/1",
        "state_schema":"rebuild-prefix/1","persistence":false,"math_input_cursors":{},
        "observed_state_cursors":{},"files":{"main":{},"bidtopid":{},"ptptstats":{},"restore":{}}})
        .as_object().ok_or_else(|| anyhow::anyhow!("test object"))? { candidate[key] = value.clone(); }
    admit_checkpoint(&candidate, &requested(), &identity)?;
    for (key, value, reason) in [
        ("unexpected", json!(1), AdmissionError::Malformed),
        ("fixture_id", json!(2), AdmissionError::Operation),
        (
            "schema",
            json!("polis-checkpoint/1"),
            AdmissionError::Malformed,
        ),
    ] {
        let mut bad = candidate.clone();
        bad[key] = value;
        let error = admit_checkpoint(&bad, &requested(), &identity)
            .err()
            .ok_or_else(|| anyhow::anyhow!("accepted corruption"))?;
        assert_eq!(error.downcast_ref::<AdmissionError>(), Some(&reason));
    }
    assert!(admit_checkpoint(&json!({}), &requested(), &identity).is_err());
    Ok(())
}
