//! The one HTTP call to the Messages API, with its timeout and at most one
//! retry.
//!
//! Headers sent to the Claude API: `content-type`, `anthropic-version` and
//! `x-api-key` (marked sensitive), and whatever the HTTP client itself adds
//! (`accept`, `host`, `content-length`). No user agent and nothing that names
//! a project or a conversation.
//!
//! Through Amazon Bedrock ([`Auth::Bedrock`]) the same body and the same two
//! content headers go to the region's `bedrock-mantle` endpoint, with no
//! `x-api-key`: the request is signed with AWS Signature Version 4 (signing
//! name `bedrock-mantle`), which adds `authorization`, `x-amz-date` and, with
//! temporary credentials, `x-amz-security-token` (the last two marked
//! sensitive with the first). The credentials are read from the default AWS
//! credential chain when the call is made, held only in memory for its
//! attempts, and never written anywhere.

use aws_credential_types::Credentials;
use aws_credential_types::provider::ProvideCredentials;
use std::time::{Duration, SystemTime};

/// The provider's API version the measurement sent.
pub const ANTHROPIC_VERSION: &str = "2026-10-21";
/// The provider's API base.
pub const DEFAULT_API_BASE: &str = "https://api.anthropic.com/v1";

/// The most bytes of an HTTP 200 reply body that are read. A reply of 32,000
/// output tokens is far smaller; a longer body is not read to its end.
pub const MAX_REPLY_BYTES: usize = 4 * 1024 * 1024;

/// Statuses after which the call is made once more.
pub const RETRY_STATUSES: [u16; 6] = [429, 500, 502, 503, 504, 529];

/// The Signature Version 4 signing name of Claude in Amazon Bedrock.
pub const BEDROCK_SIGNING_NAME: &str = "bedrock-mantle";

/// The API base of Claude in Amazon Bedrock in one region; the call is made to
/// `<base>/messages`, that is `https://bedrock-mantle.<region>.api.aws/anthropic/v1/messages`.
pub fn bedrock_api_base(region: &str) -> String {
    format!("https://bedrock-mantle.{region}.api.aws/anthropic/v1")
}

/// Whether a region name can go into the endpoint's host name: lowercase
/// letters, digits and single hyphens, such as `us-east-1`.
pub fn valid_region(region: &str) -> bool {
    !region.is_empty()
        && region.len() <= 32
        && region
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !region.starts_with('-')
        && !region.ends_with('-')
        && !region.contains("--")
}

/// Where AWS credentials come from.
#[derive(Clone)]
pub enum AwsCredentials {
    /// The default AWS credential chain, read when the call is made: the
    /// environment, the shared profile files, the container's credentials,
    /// then the instance role through the instance metadata service.
    DefaultChain,
    /// Credentials given by the caller. The offline tests use made-up ones.
    Given {
        access_key_id: String,
        secret_access_key: String,
        session_token: Option<String>,
    },
}

// Credentials must stay redacted even in a caller's debug diagnostics.
impl std::fmt::Debug for AwsCredentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::DefaultChain => "DefaultChain",
            Self::Given { .. } => "Given { .. }",
        })
    }
}

/// How a call is authenticated.
#[derive(Clone, Copy)]
pub enum Auth<'a> {
    /// The Claude API: the key goes in `x-api-key`.
    ApiKey(&'a str),
    /// Amazon Bedrock: a Signature Version 4 signature for `region`.
    Bedrock {
        region: &'a str,
        credentials: &'a AwsCredentials,
    },
}

impl std::fmt::Debug for Auth<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::ApiKey(_) => "ApiKey(..)",
            Self::Bedrock { .. } => "Bedrock { .. }",
        })
    }
}

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
    /// Bedrock: the credential chain gave no credentials (none configured,
    /// none reachable, or none within the connect timeout).
    NoCredentials,
    /// Bedrock: the credentials or the region could not sign the request.
    CannotSign,
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
    call_with_auth(settings, Auth::ApiKey(key), body, allow_retry)
}

/// Makes the call with either provider's authentication; a second attempt
/// only when the caller reserved its cost.
pub(crate) fn call_with_auth(
    settings: &Settings,
    auth: Auth<'_>,
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
    rt.block_on(call_async(settings, auth, body, allow_retry))
}

/// What signs each attempt.
enum Signer {
    Key(reqwest::header::HeaderValue),
    Bedrock { region: String, creds: Credentials },
}

fn ended(ended: Ended) -> Call {
    Call {
        ended,
        attempts: 0,
        http_status: None,
    }
}

/// Reads credentials from the default chain, bounded by `limit`.
async fn chain_credentials(region: &str, limit: Duration) -> Option<Credentials> {
    let read = async {
        let config = aws_config::defaults(aws_config::BehaviorVersion::latest())
            .region(aws_config::Region::new(region.to_string()))
            .load()
            .await;
        let provider = config.credentials_provider()?;
        provider.provide_credentials().await.ok()
    };
    tokio::time::timeout(limit, read).await.ok().flatten()
}

async fn signer(settings: &Settings, auth: Auth<'_>) -> Result<Signer, Ended> {
    match auth {
        Auth::ApiKey(key) => {
            let mut v = reqwest::header::HeaderValue::from_str(key).map_err(|_| Ended::BadKey)?;
            v.set_sensitive(true);
            Ok(Signer::Key(v))
        }
        Auth::Bedrock {
            region,
            credentials,
        } => {
            if !valid_region(region) {
                return Err(Ended::CannotSign);
            }
            let creds = match credentials {
                AwsCredentials::Given {
                    access_key_id,
                    secret_access_key,
                    session_token,
                } => Credentials::new(
                    access_key_id.clone(),
                    secret_access_key.clone(),
                    session_token.clone(),
                    None,
                    "given",
                ),
                AwsCredentials::DefaultChain => chain_credentials(region, settings.connect_timeout)
                    .await
                    .ok_or(Ended::NoCredentials)?,
            };
            Ok(Signer::Bedrock {
                region: region.to_string(),
                creds,
            })
        }
    }
}

/// The SigV4 headers for one attempt: `authorization`, `x-amz-date` and, with
/// a session token, `x-amz-security-token`. The signature covers the method,
/// the path, the host, the two content headers and the body's SHA-256.
pub(crate) fn sigv4_headers(
    creds: &Credentials,
    region: &str,
    url: &str,
    body: &str,
    now: SystemTime,
) -> Option<Vec<(String, String)>> {
    use aws_sigv4::http_request::{SignableBody, SignableRequest, SigningSettings, sign};
    let identity: aws_smithy_runtime_api::client::identity::Identity = creds.clone().into();
    let params = aws_sigv4::sign::v4::SigningParams::builder()
        .identity(&identity)
        .region(region)
        .name(BEDROCK_SIGNING_NAME)
        .time(now)
        .settings(SigningSettings::default())
        .build()
        .ok()?
        .into();
    let signed = [
        ("content-type", "application/json"),
        ("anthropic-version", ANTHROPIC_VERSION),
    ];
    let request = SignableRequest::new(
        "POST",
        url,
        signed.into_iter(),
        SignableBody::Bytes(body.as_bytes()),
    )
    .ok()?;
    let (instructions, _signature) = sign(request, &params).ok()?.into_parts();
    let (headers, _params) = instructions.into_parts();
    Some(
        headers
            .into_iter()
            .map(|h| (h.name().to_string(), h.value().to_string()))
            .collect(),
    )
}

impl Signer {
    /// The headers of one attempt, signed at the moment it is made.
    fn headers(&self, url: &str, body: &str) -> Option<reqwest::header::HeaderMap> {
        use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
        let mut h = HeaderMap::new();
        h.insert("content-type", HeaderValue::from_static("application/json"));
        h.insert(
            "anthropic-version",
            HeaderValue::from_static(ANTHROPIC_VERSION),
        );
        match self {
            Self::Key(key) => {
                h.insert("x-api-key", key.clone());
            }
            Self::Bedrock { region, creds } => {
                for (k, v) in sigv4_headers(creds, region, url, body, SystemTime::now())? {
                    let name = HeaderName::from_bytes(k.as_bytes()).ok()?;
                    let mut value = HeaderValue::from_str(&v).ok()?;
                    value.set_sensitive(true);
                    h.insert(name, value);
                }
            }
        }
        Some(h)
    }
}

async fn call_async(settings: &Settings, auth: Auth<'_>, body: &str, allow_retry: bool) -> Call {
    let signer = match signer(settings, auth).await {
        Ok(s) => s,
        Err(e) => return ended(e),
    };
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
        let Some(headers) = signer.headers(&url, body) else {
            return Call {
                ended: Ended::CannotSign,
                attempts,
                http_status: None,
            };
        };
        attempts += 1;
        match attempt(&client, &url, headers, body).await {
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
    headers: reqwest::header::HeaderMap,
    body: &str,
) -> Attempt {
    let sent = client
        .post(url)
        .headers(headers)
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
