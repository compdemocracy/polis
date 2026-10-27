//! Only loopback HTTP; generated RSA keys and an in-process fake provider.
#![allow(clippy::unwrap_used, clippy::expect_used)]
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
use polis_auth::{
    observability::Counters,
    provider::{Error, Settings, Verifier},
};
use serde_json::{Value, json};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

struct Fake {
    uri: String,
    response: Arc<Mutex<(u16, String)>>,
    calls: Arc<AtomicUsize>,
    task: tokio::task::JoinHandle<()>,
}
impl Fake {
    async fn new(body: String) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let uri = format!("http://{}/keys", listener.local_addr().unwrap());
        let response = Arc::new(Mutex::new((200, body)));
        let calls = Arc::new(AtomicUsize::new(0));
        let (r, c) = (response.clone(), calls.clone());
        let task = tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut buf = [0; 4096];
                let _ = socket.read(&mut buf).await.unwrap();
                c.fetch_add(1, Ordering::SeqCst);
                let (status, body) = r.lock().unwrap().clone();
                let reply = format!(
                    "HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                socket.write_all(reply.as_bytes()).await.unwrap();
            }
        });
        Self {
            uri,
            response,
            calls,
            task,
        }
    }
    fn reply(&self, status: u16, body: String) {
        *self.response.lock().unwrap() = (status, body);
    }
}
impl Drop for Fake {
    fn drop(&mut self) {
        self.task.abort();
    }
}
fn settings(uri: &str) -> Settings {
    Settings {
        issuer: "https://issuer.invalid/".into(),
        audience: "users".into(),
        namespace: "ns/".into(),
        jwks_uri: uri.into(),
    }
}
fn keypair() -> (EncodingKey, Value) {
    let rsa = openssl::rsa::Rsa::generate(2048).unwrap();
    let jwk = json!({"kty":"RSA","use":"sig","alg":"RS256","kid":"old","n":URL_SAFE_NO_PAD.encode(rsa.n().to_vec()),"e":URL_SAFE_NO_PAD.encode(rsa.e().to_vec())});
    (
        EncodingKey::from_rsa_pem(&rsa.private_key_to_pem().unwrap()).unwrap(),
        jwk,
    )
}
fn set(key: &Value, kid: &str) -> String {
    let mut key = key.clone();
    key["kid"] = json!(kid);
    json!({"keys":[key]}).to_string()
}
fn token(key: &EncodingKey, kid: &str, changes: Value) -> String {
    let mut c = json!({"iss":"https://issuer.invalid/","aud":["users"],"exp":2000,"sub":"test","email":"test@example.invalid"});
    for (k, v) in changes.as_object().unwrap() {
        c[k] = v.clone();
    }
    let mut header = Header::new(Algorithm::RS256);
    header.kid = Some(kid.into());
    format!("Bearer {}", encode(&header, &c, key).unwrap())
}
fn count(c: &Counters, label: &str) -> u64 {
    c.snapshot().find(|(k, _)| *k == label).unwrap().1
}
async fn until(mut done: impl FnMut() -> bool) {
    for _ in 0..50000 {
        if done() {
            return;
        }
        tokio::task::yield_now().await;
    }
    panic!("background task did not finish");
}
async fn settle() {
    for _ in 0..100 {
        tokio::task::yield_now().await;
    }
}

#[tokio::test(start_paused = true)]
async fn misses_refuse_without_fetch_then_background_rotates_with_global_rate_limit() {
    // Keep the paused runtime runnable: only explicit advance moves the clock,
    // never auto-advance while real loopback I/O is being delivered by the OS.
    let clock_guard = tokio::spawn(async {
        loop {
            tokio::task::yield_now().await;
        }
    });
    let (key, jwk) = keypair();
    let (next_key, next_jwk) = keypair();
    let server = Fake::new(set(&next_jwk, "next")).await;
    let counters = Arc::new(Counters::new());
    let (v, worker) = Verifier::from_snapshot(
        settings(&server.uri),
        set(&jwk, "old").as_bytes(),
        counters.clone(),
    )
    .unwrap();
    let old = token(&key, "old", json!({}));
    let next = token(&next_key, "next", json!({}));
    assert!(v.verify_at(&old, 1000).is_ok());
    for _ in 0..100 {
        assert_eq!(v.verify_at(&next, 1000), Err(Error::UnknownKey));
    }
    assert_eq!(server.calls.load(Ordering::SeqCst), 0);
    assert_eq!(count(&counters, "oidc_jwks_misses"), 100);
    let task = tokio::spawn(worker.run(Duration::from_secs(300)));
    until(|| count(&counters, "oidc_jwks_refresh_successes") == 1).await;
    assert!(v.verify_at(&next, 1000).is_ok());
    assert_eq!(v.verify_at(&old, 1000), Err(Error::UnknownKey)); // replacement, not union
    for _ in 0..100 {
        let _ = v.verify_at(&old, 1000);
    }
    settle().await;
    tokio::time::advance(Duration::from_secs(59)).await;
    settle().await;
    assert_eq!(server.calls.load(Ordering::SeqCst), 1);
    server.reply(503, "unavailable".into());
    tokio::time::advance(Duration::from_secs(1)).await;
    until(|| count(&counters, "oidc_jwks_refresh_failures") == 1).await;
    assert_eq!(server.calls.load(Ordering::SeqCst), 2);
    assert!(v.verify_at(&next, 1000).is_ok());
    // Bad JSON, duplicate ids, oversized bodies and unusable sets all retain
    // the last good snapshot and consume the same one-minute attempt budget.
    for (i, body) in [
        "broken".into(),
        json!({"keys":[jwk.clone(),jwk.clone()]}).to_string(),
        "x".repeat(65537),
        json!({"keys":[]}).to_string(),
    ]
    .into_iter()
    .enumerate()
    {
        server.reply(200, body);
        assert_eq!(v.verify_at(&old, 1000), Err(Error::UnknownKey));
        settle().await;
        tokio::time::advance(Duration::from_secs(60)).await;
        until(|| count(&counters, "oidc_jwks_refresh_failures") == i as u64 + 2).await;
        assert!(v.verify_at(&next, 1000).is_ok());
    }
    // Scheduled refresh succeeds without another request or unknown-key signal.
    server.reply(200, set(&jwk, "scheduled"));
    settle().await;
    tokio::time::advance(Duration::from_secs(300)).await;
    until(|| count(&counters, "oidc_jwks_refresh_successes") == 2).await;
    assert!(
        v.verify_at(&token(&key, "scheduled", json!({})), 1000)
            .is_ok()
    );
    task.abort();
    clock_guard.abort();
}
#[test]
fn boot_and_verification_fail_closed() {
    let (key, jwk) = keypair();
    let s = settings("http://127.0.0.1:1/keys");
    for raw in [
        "broken".to_string(),
        json!({"keys":[]}).to_string(),
        json!({"keys":[jwk.clone(),jwk.clone()]}).to_string(),
    ] {
        assert!(
            Verifier::from_snapshot(s.clone(), raw.as_bytes(), Arc::new(Counters::new())).is_err()
        );
    }
    let (v, _) =
        Verifier::from_snapshot(s, set(&jwk, "old").as_bytes(), Arc::new(Counters::new())).unwrap();
    for changes in [
        json!({"exp":1000}),
        json!({"nbf":1001}),
        json!({"nbf":null}),
        json!({"sub":""}),
        json!({"iss":"other"}),
        json!({"aud":"other"}),
        json!({"exp":"2000"}),
    ] {
        assert_eq!(
            v.verify_at(&token(&key, "old", changes), 1000),
            Err(Error::InvalidToken)
        );
    }
    let (other, _) = keypair();
    assert_eq!(
        v.verify_at(&token(&other, "old", json!({})), 1000),
        Err(Error::InvalidToken)
    );
    assert!(
        v.verify_at(&token(&key, "old", json!({"nbf":1000})), 1000)
            .is_ok()
    );
}
