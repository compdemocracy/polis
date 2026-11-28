//! The one HTTP call to the Messages API, with its timeout. The request is
//! written at most once: a failure before any byte of it could have reached
//! the provider may be followed by one more try to connect; any failure after
//! that is the call's outcome and the request is never sent again (see
//! [`one`]).
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

/// The most times one naming call tries to reach the provider: the first try
/// and, only when that try failed before any byte of the request could have
/// been written (see [`Sent`]), one more. A request is written at most once.
pub const MAX_CONNECT_ATTEMPTS: u32 = 2;

/// How the call is made. [`Settings::default`] is production's.
#[derive(Clone)]
pub struct Settings {
    pub api_base: String,
    /// The bound on the request, from connecting to the last byte of the reply.
    pub timeout: Duration,
    pub connect_timeout: Duration,
    /// The wait before the second try to connect, after a first try that
    /// failed before anything was sent.
    pub reconnect_wait: Duration,
    /// Resolves host names in place of the system resolver. `None` (the
    /// default, and production's) is the system resolver; the offline tests
    /// set one to fail a name lookup without any network.
    pub resolver: Option<std::sync::Arc<dyn reqwest::dns::Resolve>>,
}

impl std::fmt::Debug for Settings {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Settings")
            .field("api_base", &self.api_base)
            .field("timeout", &self.timeout)
            .field("connect_timeout", &self.connect_timeout)
            .field("reconnect_wait", &self.reconnect_wait)
            .field("resolver", &self.resolver.as_ref().map(|_| ".."))
            .finish()
    }
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            api_base: DEFAULT_API_BASE.into(),
            timeout: Duration::from_secs(300),
            connect_timeout: Duration::from_secs(30),
            reconnect_wait: Duration::from_secs(10),
            resolver: None,
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
    /// HTTP 403, with the response's own error type when it names one (the
    /// `x-amzn-ErrorType` header, or the body's `error.type`), reduced to a
    /// bare identifier. No other part of the response is kept.
    Forbidden(Option<String>),
    /// Any other HTTP status.
    Status(u16),
    /// The request was sent and no complete reply came within the timeout.
    Timeout,
    /// The request was sent (in whole or in part) and the connection then
    /// failed: a reset, a close before the reply, or a reply body cut short.
    Dropped,
    /// No connection after [`MAX_CONNECT_ATTEMPTS`] tries, each failing before
    /// any byte of the request was written (name resolution, a refused
    /// connection, the TLS handshake, the connect timeout).
    Connect,
    /// The key cannot be sent as a header value.
    BadKey,
    /// Bedrock: the credential chain gave no credentials (none configured,
    /// none reachable, or none within the connect timeout).
    NoCredentials,
    /// Bedrock: the credentials or the region could not sign the request.
    CannotSign,
}

/// Whether the call's request was written to the provider.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sent {
    /// No byte of the request could have reached the provider: nothing was
    /// done or charged for.
    No,
    /// The request was written, in whole or in part, exactly once. The
    /// provider may have done the work and charged for it whether or not an
    /// answer came back, so the request is never written again.
    Once,
}

/// The call's result: how it ended, whether its request was sent, and how
/// many tries to reach the provider it took.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Call {
    pub ended: Ended,
    pub sent: Sent,
    pub attempts: u32,
    pub http_status: Option<u16>,
}

impl Call {
    fn not_sent(why: NotSent, attempts: u32) -> Self {
        Self {
            ended: match why {
                NotSent::Connect => Ended::Connect,
                NotSent::BadKey => Ended::BadKey,
                NotSent::NoCredentials => Ended::NoCredentials,
                NotSent::CannotSign => Ended::CannotSign,
            },
            sent: Sent::No,
            attempts,
            http_status: None,
        }
    }

    fn sent(answer: Answer, attempts: u32) -> Self {
        let (ended, http_status) = match answer {
            Answer::Answered(body) => (Ended::Answered(body), Some(200)),
            Answer::Oversize => (Ended::Oversize, Some(200)),
            Answer::Forbidden(t) => (Ended::Forbidden(t), Some(403)),
            Answer::Status(s) => (Ended::Status(s), Some(s)),
            Answer::Timeout(status) => (Ended::Timeout, status),
            Answer::Dropped(status) => (Ended::Dropped, status),
        };
        Self {
            ended,
            sent: Sent::Once,
            attempts,
            http_status,
        }
    }
}

/// Why a call ended with nothing sent.
enum NotSent {
    Connect,
    BadKey,
    NoCredentials,
    CannotSign,
}

/// What came back once the request had been written. The status, when one
/// came, rides on the failures that can follow it.
enum Answer {
    Answered(Vec<u8>),
    Oversize,
    Forbidden(Option<String>),
    Status(u16),
    Timeout(Option<u16>),
    Dropped(Option<u16>),
}

/// Makes the call: the request is written at most once; a try that failed
/// before writing anything is made once more.
pub fn call(settings: &Settings, key: &str, body: &str) -> Call {
    call_with_auth(settings, Auth::ApiKey(key), body)
}

/// Makes the call with either provider's authentication.
pub(crate) fn call_with_auth(settings: &Settings, auth: Auth<'_>, body: &str) -> Call {
    let Ok(rt) = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    else {
        return Call::not_sent(NotSent::Connect, 0);
    };
    rt.block_on(call_async(settings, auth, body))
}

/// What signs each attempt.
enum Signer {
    Key(reqwest::header::HeaderValue),
    Bedrock { region: String, creds: Credentials },
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

async fn signer(settings: &Settings, auth: Auth<'_>) -> Result<Signer, NotSent> {
    match auth {
        Auth::ApiKey(key) => {
            let mut v = reqwest::header::HeaderValue::from_str(key).map_err(|_| NotSent::BadKey)?;
            v.set_sensitive(true);
            Ok(Signer::Key(v))
        }
        Auth::Bedrock {
            region,
            credentials,
        } => {
            if !valid_region(region) {
                return Err(NotSent::CannotSign);
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
                    .ok_or(NotSent::NoCredentials)?,
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

async fn call_async(settings: &Settings, auth: Auth<'_>, body: &str) -> Call {
    let signer = match signer(settings, auth).await {
        Ok(s) => s,
        Err(why) => return Call::not_sent(why, 0),
    };
    // No retry inside the HTTP library: reqwest's own policy (by default it
    // resends after some HTTP/2 refusals) is switched off, and with no idle
    // connection kept, hyper never reuses one, so its resend of a request
    // canceled on a reused connection cannot happen either. No redirect is
    // followed (a redirect would be a second request).
    let mut builder = reqwest::Client::builder()
        .timeout(settings.timeout)
        .connect_timeout(settings.connect_timeout)
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .pool_max_idle_per_host(0);
    if let Some(r) = &settings.resolver {
        builder = builder.dns_resolver2(std::sync::Arc::clone(r));
    }
    let Ok(client) = builder.build() else {
        return Call::not_sent(NotSent::Connect, 0);
    };
    let url = format!("{}/messages", settings.api_base.trim_end_matches('/'));
    let Some(headers) = signer.headers(&url, body) else {
        return Call::not_sent(NotSent::CannotSign, 0);
    };
    let inspect_forbidden = matches!(signer, Signer::Bedrock { .. });
    // The call's one request. `send` consumes it; only a try that failed
    // before writing anything hands it back.
    let mut request = one::Request::new(url, headers, body.to_string());
    let mut attempts = 0;
    loop {
        attempts += 1;
        match request.send(&client, inspect_forbidden).await {
            one::Delivery::Sent(answer) => return Call::sent(answer, attempts),
            one::Delivery::NotSent(unsent) => {
                if attempts >= MAX_CONNECT_ATTEMPTS {
                    return Call::not_sent(NotSent::Connect, attempts);
                }
                tokio::time::sleep(settings.reconnect_wait).await;
                request = unsent;
            }
        }
    }
}

/// The one request of a naming call, and the line between "nothing sent" and
/// "sent".
///
/// A [`Request`](one::Request) is not `Clone` and its fields are private to
/// this module. [`send`](one::Request::send) takes it by value. A
/// [`Delivery::Sent`](one::Delivery::Sent) holds no request, so once any byte
/// may have been written the request is gone and cannot be sent again; only
/// [`Delivery::NotSent`](one::Delivery::NotSent) gives it back.
///
/// The line: reqwest marks an error as a connect error (`is_connect`) only
/// when it came from the connector (name resolution, the TCP connection, the
/// TLS handshake, a proxy tunnel, the connect timeout) or from checking out a
/// connection, all of which happen before hyper writes the first byte of the
/// request on a connection. Every other failure (the overall timeout, a reset,
/// a close before the reply, a status, a body cut short) is on the sent side,
/// including the ones where the request may only have been written in part:
/// the provider may have read it.
mod one {
    use super::{Answer, MAX_REPLY_BYTES, forbidden_type};

    pub(super) struct Request {
        url: String,
        headers: reqwest::header::HeaderMap,
        body: String,
    }

    pub(super) enum Delivery {
        /// Nothing of the request was written; here it is, unsent.
        NotSent(Request),
        /// The request was written, in whole or in part.
        Sent(Answer),
    }

    impl Request {
        pub(super) fn new(url: String, headers: reqwest::header::HeaderMap, body: String) -> Self {
            Self { url, headers, body }
        }

        pub(super) async fn send(
            self,
            client: &reqwest::Client,
            inspect_forbidden: bool,
        ) -> Delivery {
            let sent = client
                .post(&self.url)
                .headers(self.headers.clone())
                .body(self.body.clone())
                .send()
                .await;
            let resp = match sent {
                Ok(r) => r,
                // Before the first byte: the request comes back.
                Err(e) if e.is_connect() || e.is_builder() => return Delivery::NotSent(self),
                Err(e) if e.is_timeout() => return Delivery::Sent(Answer::Timeout(None)),
                Err(_) => return Delivery::Sent(Answer::Dropped(None)),
            };
            drop(self);
            Delivery::Sent(read_answer(resp, inspect_forbidden).await)
        }
    }

    async fn read_answer(mut resp: reqwest::Response, inspect_forbidden: bool) -> Answer {
        let status = resp.status().as_u16();
        if status == 403 && inspect_forbidden {
            return Answer::Forbidden(forbidden_type(resp).await);
        }
        if status != 200 {
            return Answer::Status(status);
        }
        if resp
            .content_length()
            .is_some_and(|n| n > MAX_REPLY_BYTES as u64)
        {
            return Answer::Oversize;
        }
        let mut body = Vec::new();
        loop {
            match resp.chunk().await {
                Ok(Some(chunk)) => {
                    if body.len() + chunk.len() > MAX_REPLY_BYTES {
                        return Answer::Oversize;
                    }
                    body.extend_from_slice(&chunk);
                }
                Ok(None) => return Answer::Answered(body),
                Err(e) if e.is_timeout() => return Answer::Timeout(Some(200)),
                Err(_) => return Answer::Dropped(Some(200)),
            }
        }
    }
}

/// The most of a 403 body read to find its error type.
const MAX_ERROR_BODY_BYTES: usize = 16 * 1024;

/// A 403 response's error type: the `x-amzn-ErrorType` header's name part,
/// else the JSON body's `error.type` or `__type`, kept only when it is an
/// identifier of at most 64 letters, digits and underscores. The body's text
/// (which may say anything) is never kept.
async fn forbidden_type(mut resp: reqwest::Response) -> Option<String> {
    fn identifier(raw: &str) -> Option<String> {
        // `AccessDeniedException:http://...` or `namespace#AccessDeniedException`.
        let name = raw.split(':').next()?.rsplit('#').next()?.trim();
        let ok = !name.is_empty()
            && name.len() <= 64
            && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_');
        ok.then(|| name.to_string())
    }
    if let Some(t) = resp
        .headers()
        .get("x-amzn-errortype")
        .and_then(|v| v.to_str().ok())
        .and_then(identifier)
    {
        return Some(t);
    }
    let mut body = Vec::new();
    while let Ok(Some(chunk)) = resp.chunk().await {
        if body.len() + chunk.len() > MAX_ERROR_BODY_BYTES {
            return None;
        }
        body.extend_from_slice(&chunk);
    }
    let v: serde_json::Value = serde_json::from_slice(&body).ok()?;
    let t = v
        .get("error")
        .and_then(|e| e.get("type"))
        .or_else(|| v.get("__type"))
        .and_then(|t| t.as_str())?;
    identifier(t)
}
