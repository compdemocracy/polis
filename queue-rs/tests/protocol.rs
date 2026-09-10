use polis_queue_adapter::{Database, Request, validate};
use serde_json::{Value, json};

fn ordinary() -> Value {
    let mut value = json!({});
    for key in "schema_version outcome env job_id run_id attempt_id owner_id lease_epoch version mgmt_version locked_until state output_sha256 published stage stage_instance attempt_count max_attempts parked_attempt_count eligible_at first_parked_at last_error_code input".split_whitespace() {
        value[key] = Value::Null;
    }
    value["schema_version"] = json!("polis-queue/1");
    value["outcome"] = json!("none");
    value["published"] = json!(false);
    value
}

#[test]
fn closed_reply_fields_and_counters() {
    let value = ordinary();
    assert!(validate("pq_claim", &value).is_ok());
    for (key, replacement) in [
        ("extra", json!(1)),
        ("lease_epoch", json!(1)),
        ("version", json!("-1")),
        ("attempt_count", json!(true)),
        ("locked_until", json!("2026-01-01T00:00:00-08:00")),
        ("input", json!({"uri":"public:noop"})),
        ("schema_version", json!("polis-queue/2")),
    ] {
        let mut invalid = value.clone();
        invalid[key] = replacement;
        assert!(validate("pq_claim", &invalid).is_err(), "{key}");
    }
    let mut missing = value;
    if let Some(object) = missing.as_object_mut() {
        object.remove("outcome");
    }
    assert!(validate("pq_claim", &missing).is_err());
}

#[test]
fn null_and_due_envelopes_are_separate() {
    assert!(validate("pq_reap_one", &Value::Null).is_ok());
    assert!(validate("pq_claim", &Value::Null).is_err());
    assert!(validate("pq_due", &json!([])).is_ok());
    assert!(validate("pq_due", &json!(["not-a-uuid"])).is_err());
    assert!(
        validate(
            "pq_due",
            &json!(vec!["00000000-0000-0000-0000-000000000001"; 101])
        )
        .is_err()
    );
}

#[test]
fn local_opt_in_boundary() {
    let dsn = "postgresql://queue@127.0.0.1:1/test";
    for (env, enabled, production) in [
        ("prod", true, false),
        ("test", false, false),
        ("test", true, true),
        ("test-", true, false),
        ("test/a", true, false),
    ] {
        assert!(Database::new(dsn, env, enabled, production).is_err());
    }
    assert!(Database::new(dsn, "test-local", true, false).is_ok());
    assert!(Database::new(dsn, "test-UPPER", true, false).is_err());
    assert!(Database::new(dsn, "test--start", true, false).is_err());
    assert!(Database::new(dsn, &format!("test-{}", "x".repeat(50)), true, false).is_err());
    assert!(
        Database::new(
            "postgresql://queue@example.invalid/test",
            "test",
            true,
            false
        )
        .is_err()
    );
}

#[test]
fn unknown_rpc_or_bad_type_refuses_before_connection() {
    let db = match Database::new("postgresql://queue@127.0.0.1:1/test", "test", true, false) {
        Ok(db) => db,
        Err(error) => panic!("{error}"),
    };
    for request in [
        Request {
            name: "pq_reap".into(),
            args: vec![],
        },
        Request {
            name: "pq_claim".into(),
            args: vec![
                json!("test"),
                json!(32768),
                json!(null),
                json!(null),
                json!(60),
            ],
        },
        Request {
            name: "pq_job_status".into(),
            args: vec![json!("dev"), json!(null)],
        },
    ] {
        let error = match db.call(&request) {
            Ok(_) => panic!("unexpected success"),
            Err(e) => e,
        };
        assert!(
            error.downcast_ref::<postgres::Error>().is_none(),
            "opened a connection before validation"
        );
    }
    assert!(
        serde_json::from_value::<Request>(json!({"name":"pq_claim","args":[],"extra":1})).is_err()
    );
}
