//! Formatting authentication for diagnostics must not disclose credentials.
#![allow(clippy::unwrap_used)]
use polis_topic_names::{
    Access,
    client::{Auth, AwsCredentials},
};

const KEY: &str = "made-up-diagnostic-key";
const SECRET: &str = "made-up-diagnostic-secret";
const TOKEN: &str = "made-up-diagnostic-token";

fn credentials() -> AwsCredentials {
    AwsCredentials::Given {
        access_key_id: KEY.into(),
        secret_access_key: SECRET.into(),
        session_token: Some(TOKEN.into()),
    }
}

fn redacted(text: &str) {
    for value in [KEY, SECRET, TOKEN] {
        assert!(!text.contains(value), "credential appeared in diagnostics");
    }
}

#[test]
fn aws_credentials_debug_redacts_every_value() {
    redacted(&format!("{:?}", credentials()));
}

#[test]
fn auth_debug_redacts_keys_and_aws_credentials() {
    let credentials = credentials();
    redacted(&format!("{:?}", Auth::ApiKey(KEY)));
    redacted(&format!(
        "{:?}",
        Auth::Bedrock {
            region: "us-east-1",
            credentials: &credentials
        }
    ));
}

#[test]
fn access_debug_redacts_keys_and_aws_credentials() {
    let credentials = credentials();
    redacted(&format!("{:?}", Access::Key(Some(KEY))));
    redacted(&format!(
        "{:?}",
        Access::Bedrock {
            region: Some("us-east-1"),
            credentials: &credentials
        }
    ));
}
