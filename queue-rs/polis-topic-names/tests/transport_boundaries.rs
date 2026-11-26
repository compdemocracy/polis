#![allow(clippy::unwrap_used, clippy::expect_used)]
mod support;
use polis_topic_names::{Access, GivenPrice, Namer, RunCap, client, name_topics_with};
use support::{Reply, Stub, hierarchy, settings};

#[test]
fn a_positive_price_that_underflows_per_token_is_refused() {
    for (input, output) in [("1e-320", "10"), ("2", "1e-320")] {
        assert!(
            GivenPrice::from_settings(Some(input), Some(output), Some("made-up price")).is_err()
        );
    }
}

#[test]
fn a_direct_price_value_cannot_bypass_validation() {
    let h = hierarchy("vtaiwan");
    let n = Namer::from_json(r#"{"provider":"bedrock","model":"claude-sonnet-5-5","prompt":"polis-topic-names/1","thinking":"default"}"#).unwrap();
    let creds = client::AwsCredentials::Given {
        access_key_id: "made-up-key".into(),
        secret_access_key: "made-up-secret".into(),
        session_token: None,
    };
    for (input, output, source) in [
        (0.0, 0.0, "s"),
        (-1.0, -1.0, "s"),
        (f64::NAN, 1.0, "s"),
        (101.0, 1.0, "s"),
        (2.0, 10.0, " "),
    ] {
        let price = Ok(GivenPrice {
            input_usd_per_mtok: input,
            output_usd_per_mtok: output,
            source: source.into(),
        });
        let stub = Stub::start(vec![]);
        let file = name_topics_with(
            &h,
            &n,
            Access::Bedrock {
                region: Some("us-east-1"),
                credentials: &creds,
                price: &price,
            },
            RunCap::Usd(10.0),
            &settings(&stub.url),
        );
        assert_eq!(file.outcome, "no_price");
        assert_eq!(file.record.attempts, 0);
        assert!(file.record.price.is_none());
        assert!(serde_json::to_value(&file).unwrap()["record"]["worst_case_usd"].is_null());
        assert!(stub.finish().is_empty());
    }
}

#[test]
fn the_claude_api_keeps_its_status_only_403_result() {
    let stub = Stub::start(vec![Reply::status(403, None)]);
    let result = client::call(&settings(&stub.url), "made-up-key", "{}");
    assert_eq!(result.ended, client::Ended::Status(403));
    assert_eq!(stub.finish().len(), 1);
}
