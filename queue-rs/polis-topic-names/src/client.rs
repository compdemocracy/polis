//! The one HTTP call to the Messages API, with its timeout and at most one
//! retry.
//!
//! Headers sent: `content-type`, `anthropic-version` and `x-api-key` (marked
//! sensitive), and whatever the HTTP client itself adds (`accept`, `host`,
//! `content-length`). No user agent and nothing that names a project or a
//! conversation.

use std::time::Duration;

/// The provider's API version the measurement sent.
pub const ANTHROPIC_VERSION: &str = "2026-10-21";
/// The provider's API base.
pub const DEFAULT_API_BASE: &str = "https://api.anthropic.com/v1";

/// The most bytes of an HTTP 200 reply body that are read. A reply of 32,000
/// output tokens is far smaller; a longer body is not read to its end.
pub const MAX_REPLY_BYTES: usize = 4 * 1024 * 1024;

/// Statuses after which the call is made once more.
pub const RETRY_STATUSES: [u16; 6] = [429, 500, 502, 503, 504, 529];

/// How the call is made. [`Settings::default`] is production's.
#[derive(Debug, Clone)]
pub struct Settings {
    pub api_base: String,
    /// The bound on one attempt, from connecting to the last byte of the reply.
    pub timeout: Duration,
    pub connect_timeout: Duration,
    /// The wait before the retry when the reply gives no `retry-after`.
    pub retry_wait_default: Duration,
    /// The longest wait before the retry, whatever `retry-after` says.
    pub retry_wait_cap: Duration,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            api_base: DEFAULT_API_BASE.into(),
            timeout: Duration::from_secs(300),
            connect_timeout: Duration::from_secs(30),
            retry_wait_default: Duration::from_secs(10),
            retry_wait_cap: Duration::from_secs(60),
        }
    }
}

/// How the call ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Ended {
    /// HTTP 200 and its body.
    Answered(Vec<u8>),
    /// HTTP 200 with a body longer than [`MAX_REPLY_BYTES`].
    Oversize,
    /// Any other HTTP status.
    Status(u16),
    /// An attempt passed its timeout.
    Timeout,
    /// No connection, or the connection failed before a status came back.
    Connect,
    /// The key cannot be sent as a header value.
    BadKey,
}

/// The call's result and how many attempts it took.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Call {
    pub ended: Ended,
    pub attempts: u32,
    pub http_status: Option<u16>,
}

enum Attempt {
    Done(Ended, Option<u16>),
    Retry(Ended, Option<u16>, Option<Duration>),
}

/// Makes the call: one attempt, and one more only after a status in
/// [`RETRY_STATUSES`] or a failed connection.
pub fn call(settings: &Settings, key: &str, body: &str) -> Call {
    call_with_retry(settings, key, body, true)
}

/// Makes a second attempt only when the caller reserved its cost.
pub(crate) fn call_with_retry(
    settings: &Settings,
    key: &str,
    body: &str,
    allow_retry: bool,
) -> Call {
    let Ok(rt) = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    else {
        return Call {
            ended: Ended::Connect,
            attempts: 0,
            http_status: None,
        };
    };
    rt.block_on(call_async(settings, key, body, allow_retry))
}

async fn call_async(settings: &Settings, key: &str, body: &str, allow_retry: bool) -> Call {
    let Ok(mut key_value) = reqwest::header::HeaderValue::from_str(key) else {
        return Call {
            ended: Ended::BadKey,
            attempts: 0,
            http_status: None,
        };
    };
    key_value.set_sensitive(true);
    let Ok(client) = reqwest::Client::builder()
        .timeout(settings.timeout)
        .connect_timeout(settings.connect_timeout)
        .redirect(reqwest::redirect::Policy::none())
        .build()
    else {
        return Call {
            ended: Ended::Connect,
            attempts: 0,
            http_status: None,
        };
    };
    let url = format!("{}/messages", settings.api_base.trim_end_matches('/'));
    let mut attempts = 0;
    loop {
        attempts += 1;
        match attempt(&client, &url, &key_value, body).await {
            Attempt::Done(ended, http_status) => {
                return Call {
                    ended,
                    attempts,
                    http_status,
                };
            }
            Attempt::Retry(ended, http_status, after) => {
                if !allow_retry || attempts >= 2 {
                    return Call {
                        ended,
                        attempts,
                        http_status,
                    };
                }
                let wait = after
                    .unwrap_or(settings.retry_wait_default)
                    .min(settings.retry_wait_cap);
                tokio::time::sleep(wait).await;
            }
        }
    }
}

async fn attempt(
    client: &reqwest::Client,
    url: &str,
    key: &reqwest::header::HeaderValue,
    body: &str,
) -> Attempt {
    let sent = client
        .post(url)
        .header("content-type", "application/json")
        .header("anthropic-version", ANTHROPIC_VERSION)
        .header("x-api-key", key.clone())
        .body(body.to_string())
        .send()
        .await;
    let resp = match sent {
        Ok(r) => r,
        Err(e) => return transport_failure(&e),
    };
    let status = resp.status().as_u16();
    let after = resp
        .headers()
        .get("retry-after")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse::<u64>().ok())
        .map(Duration::from_secs);
    if status != 200 {
        if RETRY_STATUSES.contains(&status) {
            return Attempt::Retry(Ended::Status(status), Some(status), after);
        }
        return Attempt::Done(Ended::Status(status), Some(status));
    }
    if resp
        .content_length()
        .is_some_and(|n| n > MAX_REPLY_BYTES as u64)
    {
        return Attempt::Done(Ended::Oversize, Some(200));
    }
    let mut resp = resp;
    let mut body = Vec::new();
    loop {
        match resp.chunk().await {
            Ok(Some(chunk)) => {
                if body.len() + chunk.len() > MAX_REPLY_BYTES {
                    return Attempt::Done(Ended::Oversize, Some(200));
                }
                body.extend_from_slice(&chunk);
            }
            Ok(None) => return Attempt::Done(Ended::Answered(body), Some(200)),
            Err(e) if e.is_timeout() => return Attempt::Done(Ended::Timeout, Some(200)),
            Err(_) => return Attempt::Done(Ended::Connect, Some(200)),
        }
    }
}

fn transport_failure(e: &reqwest::Error) -> Attempt {
    if e.is_connect() {
        Attempt::Retry(Ended::Connect, None, None)
    } else if e.is_timeout() {
        Attempt::Done(Ended::Timeout, None)
    } else {
        Attempt::Done(Ended::Connect, None)
    }
}
