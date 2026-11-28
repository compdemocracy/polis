//! A naming call writes its request to the provider at most once, through
//! either provider. A local stub on 127.0.0.1 counts every request it
//! receives, and keeps listening after its scripted reply so that a request
//! sent again would be counted, not refused. Each failure after the request
//! was written is that failure, with exactly one request seen; only a failure
//! before anything was written is followed by a second try to connect.

#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use polis_topic_names::client::{self, AwsCredentials, Sent, Settings};
use polis_topic_names::{
    Access, GivenPrice, Hierarchy, Namer, NamesFile, RunCap, name_topics_with,
};
use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;
use support::{Reply, Stub, fixture, hierarchy, settings};

const VT_SONNET: &str = "replies/vtaiwan/sonnet-default-r1.json";
/// How long the stub keeps counting after its scripted reply.
const GRACE: Duration = Duration::from_millis(1500);

#[derive(Clone, Copy, Debug)]
enum Via {
    ClaudeApi,
    Bedrock,
}

const BOTH: [Via; 2] = [Via::ClaudeApi, Via::Bedrock];

fn namer(via: Via) -> Namer {
    let provider = match via {
        Via::ClaudeApi => "",
        Via::Bedrock => r#""provider":"bedrock","#,
    };
    Namer::from_json(&format!(
        r#"{{{provider}"model":"claude-sonnet-5-5","prompt":"polis-topic-names/1","thinking":"default"}}"#
    ))
    .unwrap()
}

fn name(via: Via, h: &Hierarchy, cap: f64, s: &Settings) -> NamesFile {
    let n = namer(via);
    match via {
        Via::ClaudeApi => {
            name_topics_with(h, &n, Access::Key(Some("test-key")), RunCap::Usd(cap), s)
        }
        Via::Bedrock => {
            let creds = AwsCredentials::Given {
                access_key_id: "AKIDEXAMPLENOTREAL02".into(),
                secret_access_key: "made-up-secret-for-the-offline-tests-only".into(),
                session_token: None,
            };
            let price =
                GivenPrice::from_settings(Some("2.2"), Some("11"), Some("made-up test price"));
            name_topics_with(
                h,
                &n,
                Access::Bedrock {
                    region: Some("us-east-1"),
                    credentials: &creds,
                    price: &price,
                },
                RunCap::Usd(cap),
                s,
            )
        }
    }
}

/// One failure after the request was written: its outcome, and the one
/// request the stub saw.
fn sent_once(via: Via, reply: Reply, timeout: Option<Duration>) -> NamesFile {
    let h = hierarchy("vtaiwan");
    let stub = Stub::start_counting(vec![reply], GRACE);
    let mut s = settings(&stub.url);
    if let Some(t) = timeout {
        s.timeout = t;
    }
    let file = name(via, &h, 5.0, &s);
    let seen = stub.finish().len();
    assert_eq!(seen, 1, "{via:?} {}: requests seen", file.outcome);
    assert!(file.record.request_sent, "{via:?} {}", file.outcome);
    assert_eq!(file.record.attempts, 1, "{via:?} {}", file.outcome);
    assert!(file.names.is_empty(), "{via:?} {}", file.outcome);
    file
}

#[test]
fn a_slow_answer_past_the_timeout_is_timeout_after_one_request() {
    for via in BOTH {
        let file = sent_once(
            via,
            Reply::Hang(Duration::from_secs(2)),
            Some(Duration::from_millis(400)),
        );
        assert_eq!(file.outcome, "timeout", "{via:?}");
    }
}

#[test]
fn a_reset_after_the_request_is_one_request() {
    for via in BOTH {
        let file = sent_once(via, Reply::Reset, None);
        assert_eq!(file.outcome, "connect_error", "{via:?}");
        assert!(
            file.reason
                .as_deref()
                .is_some_and(|r| r.contains("after the request was sent")),
            "{via:?} {:?}",
            file.reason
        );
    }
}

#[test]
fn a_close_with_no_reply_is_one_request() {
    for via in BOTH {
        let file = sent_once(via, Reply::Close, None);
        assert_eq!(file.outcome, "connect_error", "{via:?}");
    }
}

#[test]
fn a_500_503_529_or_429_is_its_status_after_one_request() {
    for via in BOTH {
        for status in [500, 503, 529, 429] {
            let file = sent_once(via, Reply::status(status, Some("0")), None);
            assert_eq!(file.outcome, format!("http_{status}"), "{via:?}");
            assert_eq!(file.record.http_status, Some(status), "{via:?}");
            assert_eq!(file.record.dollars, None, "{via:?}");
        }
    }
}

#[test]
fn a_truncated_body_is_one_request() {
    for via in BOTH {
        let file = sent_once(via, Reply::Truncated(fixture(VT_SONNET).into_bytes()), None);
        assert_eq!(file.outcome, "connect_error", "{via:?}");
        assert_eq!(file.record.http_status, Some(200), "{via:?}");
    }
}

#[test]
fn a_malformed_answer_is_bad_json_after_one_request() {
    for via in BOTH {
        let whole = fixture(VT_SONNET);
        let half = whole[..whole.len() / 2].to_string();
        let file = sent_once(via, Reply::ok(half), None);
        assert_eq!(file.outcome, "bad_json", "{via:?}");
    }
}

#[test]
fn a_refused_connection_sends_nothing_and_tries_twice() {
    for via in BOTH {
        let port = {
            let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap().port()
        };
        let h = hierarchy("vtaiwan");
        let file = name(
            via,
            &h,
            5.0,
            &settings(&format!("http://127.0.0.1:{port}/v1")),
        );
        assert_eq!(file.outcome, "connect_error", "{via:?}");
        assert_eq!(
            file.record.attempts,
            client::MAX_CONNECT_ATTEMPTS,
            "{via:?}"
        );
        assert!(!file.record.request_sent, "{via:?}");
        assert!(
            file.reason
                .as_deref()
                .is_some_and(|r| r.contains("nothing was sent")),
            "{via:?}"
        );
    }
}

/// A resolver whose first lookup fails and whose later lookups give the stub.
struct FailsFirst {
    addr: SocketAddr,
    lookups: AtomicUsize,
}

impl Resolve for FailsFirst {
    fn resolve(&self, _name: Name) -> Resolving {
        let n = self.lookups.fetch_add(1, Ordering::SeqCst);
        let addr = self.addr;
        Box::pin(async move {
            if n == 0 {
                Err("made-up lookup failure".into())
            } else {
                Ok(Box::new(std::iter::once(addr)) as Addrs)
            }
        })
    }
}

#[test]
fn a_failed_lookup_before_sending_is_tried_again_and_then_sent_once() {
    for via in BOTH {
        let h = hierarchy("vtaiwan");
        let stub = Stub::start_counting(vec![Reply::ok(fixture(VT_SONNET))], GRACE);
        let resolver = Arc::new(FailsFirst {
            addr: SocketAddr::from(([127, 0, 0, 1], stub.port)),
            lookups: AtomicUsize::new(0),
        });
        let mut s = settings(&format!("http://naming-stub.invalid:{}/v1", stub.port));
        s.resolver = Some(Arc::clone(&resolver) as Arc<dyn Resolve>);
        let file = name(via, &h, 5.0, &s);
        assert_eq!(stub.finish().len(), 1, "{via:?}");
        assert_eq!(resolver.lookups.load(Ordering::SeqCst), 2, "{via:?}");
        assert_eq!(file.outcome, "named", "{via:?}");
        assert_eq!(file.record.attempts, 2, "{via:?}");
        assert!(file.record.request_sent, "{via:?}");
    }
}

#[test]
fn the_price_check_runs_before_the_one_request() {
    for via in BOTH {
        let h = hierarchy("vtaiwan");
        let stub = Stub::start_counting(vec![], GRACE);
        let file = name(via, &h, 0.0001, &settings(&stub.url));
        assert_eq!(file.outcome, "over_run_cap", "{via:?}");
        assert_eq!(file.record.attempts, 0, "{via:?}");
        assert!(!file.record.request_sent, "{via:?}");
        assert_eq!(stub.finish().len(), 0, "{via:?}");
    }
}

#[test]
fn the_client_says_whether_its_request_was_sent() {
    let stub = Stub::start_counting(vec![Reply::status(500, Some("0"))], GRACE);
    let call = client::call(&settings(&stub.url), "made-up-key", "{}");
    assert_eq!(call.ended, client::Ended::Status(500));
    assert_eq!(call.sent, Sent::Once);
    assert_eq!(call.attempts, 1);
    assert_eq!(stub.finish().len(), 1);

    let port = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap().port()
    };
    let call = client::call(
        &settings(&format!("http://127.0.0.1:{port}/v1")),
        "made-up-key",
        "{}",
    );
    assert_eq!(call.ended, client::Ended::Connect);
    assert_eq!(call.sent, Sent::No);
    assert_eq!(call.attempts, client::MAX_CONNECT_ATTEMPTS);
}
