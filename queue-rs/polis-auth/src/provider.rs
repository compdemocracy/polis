//! Staged provider verification and refresh. No serving caller starts this task.
//! Verification only reads an immutable in-memory snapshot. Only the background
//! worker owns an HTTP client; neither a request nor a database transaction fetches.
use crate::observability::{Counters, Event};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode, decode_header, jwk::JwkSet};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, RwLock},
    time::Duration,
};
use tokio::{sync::Notify, time::Instant};

const MAX_JWKS: usize = 65536;
const MIN_REFRESH: Duration = Duration::from_secs(60);
const LOG_PERIOD: Duration = Duration::from_secs(3600);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    Configuration,
    InvalidToken,
    UnknownKey,
    Unavailable,
}

/// Capture these settings once at boot from the same environment document as
/// Node. JWKS_URI is Node's explicit issuer JWKS endpoint, not token input.
#[derive(Clone)]
pub struct Settings {
    pub issuer: String,
    pub audience: String,
    pub namespace: String,
    pub jwks_uri: String,
}
impl Settings {
    pub fn from_env() -> Result<Self, Error> {
        Self::from_lookup(|name| std::env::var(name).ok())
    }
    pub fn from_lookup(mut get: impl FnMut(&str) -> Option<String>) -> Result<Self, Error> {
        let mut required = |name| {
            get(name)
                .filter(|s| !s.is_empty())
                .ok_or(Error::Configuration)
        };
        let s = Self {
            issuer: required("AUTH_ISSUER")?,
            audience: required("AUTH_AUDIENCE")?,
            namespace: required("AUTH_NAMESPACE")?,
            jwks_uri: required("JWKS_URI")?,
        };
        s.validate()?;
        Ok(s)
    }
    fn validate(&self) -> Result<(), Error> {
        if self.issuer.is_empty() || self.audience.is_empty() || self.namespace.is_empty() {
            return Err(Error::Configuration);
        }
        let url = reqwest::Url::parse(&self.jwks_uri).map_err(|_| Error::Configuration)?;
        // Plain HTTP is only for a local fake provider. No downgrade, redirects,
        // token-controlled endpoint, ambient proxy, or credentials in the URL.
        let local = matches!(url.host_str(), Some("127.0.0.1" | "[::1]" | "localhost"));
        if !(url.scheme() == "https" || (url.scheme() == "http" && local))
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
        {
            return Err(Error::Configuration);
        }
        Ok(())
    }
}
struct Keys(HashMap<String, DecodingKey>);
impl Keys {
    fn parse(bytes: &[u8]) -> Result<Self, Error> {
        if bytes.len() > MAX_JWKS {
            return Err(Error::Configuration);
        }
        let raw: Value = serde_json::from_slice(bytes).map_err(|_| Error::Configuration)?;
        let entries = raw["keys"].as_array().ok_or(Error::Configuration)?;
        if entries.is_empty() || entries.len() > 32 {
            return Err(Error::Configuration);
        }
        for key in entries {
            let modulus = key["n"]
                .as_str()
                .and_then(|s| URL_SAFE_NO_PAD.decode(s).ok())
                .ok_or(Error::Configuration)?;
            let exponent = key["e"]
                .as_str()
                .and_then(|s| URL_SAFE_NO_PAD.decode(s).ok())
                .ok_or(Error::Configuration)?;
            if !(256..=1024).contains(&modulus.len())
                || modulus[0] & 0x80 == 0
                || modulus.last().is_none_or(|b| b & 1 == 0)
                || exponent.is_empty()
            {
                return Err(Error::Configuration);
            }
            if exponent.len() > 5 || exponent[0] == 0 {
                return Err(Error::Configuration);
            }
            let e = exponent.iter().fold(0u64, |n, b| (n << 8) | u64::from(*b));
            if !(3..=0x1_ffff_ffff).contains(&e) || e & 1 == 0 {
                return Err(Error::Configuration);
            }
            if key["kty"] != "RSA"
                || key.get("alg").is_some_and(|v| v != "RS256")
                || key.get("use").is_some_and(|v| v != "sig")
                || key.get("key_ops").is_some_and(|v| {
                    v.as_array()
                        .is_none_or(|a| !a.iter().any(|x| x == "verify"))
                })
            {
                return Err(Error::Configuration);
            }
        }
        let set: JwkSet = serde_json::from_value(raw).map_err(|_| Error::Configuration)?;
        let mut keys = HashMap::new();
        for key in &set.keys {
            let kid = key
                .common
                .key_id
                .as_ref()
                .filter(|s| !s.is_empty())
                .ok_or(Error::Configuration)?;
            let decoding = DecodingKey::from_jwk(key).map_err(|_| Error::Configuration)?;
            if keys.insert(kid.clone(), decoding).is_some() {
                return Err(Error::Configuration);
            }
        }
        Ok(Self(keys))
    }
}

struct Shared {
    keys: RwLock<Arc<Keys>>,
    refresh: Notify,
    logs: Mutex<HashMap<[u8; 32], Instant>>,
    counters: CounterSink,
}
enum CounterSink {
    Process,
    Shared(Arc<Counters>),
}
impl CounterSink {
    fn record(&self, event: Event) {
        match self {
            Self::Process => crate::observability::PROCESS.record(event),
            Self::Shared(counters) => counters.record(event),
        }
    }
}
/// Cloneable request-side verifier. A snapshot swap only holds the lock long
/// enough to replace an Arc; HTTP, parsing and signature work hold no key lock.
#[derive(Clone)]
pub struct Verifier {
    shared: Arc<Shared>,
    validation: Validation,
    namespace: String,
}
impl Verifier {
    /// Read Node's environment settings once at boot and use the same process
    /// counters exposed by polis-api health. This still starts no task or route.
    pub fn from_environment(snapshot: &[u8]) -> Result<(Self, Refresh), Error> {
        Self::initialize(Settings::from_env()?, snapshot, CounterSink::Process)
    }
    /// Parse the baked snapshot before starting any background work. Bad or
    /// missing boot keys fail closed; there is no boot-time network fallback.
    pub fn from_snapshot(
        settings: Settings,
        snapshot: &[u8],
        counters: Arc<Counters>,
    ) -> Result<(Self, Refresh), Error> {
        Self::initialize(settings, snapshot, CounterSink::Shared(counters))
    }
    fn initialize(
        settings: Settings,
        snapshot: &[u8],
        counters: CounterSink,
    ) -> Result<(Self, Refresh), Error> {
        settings.validate()?;
        let shared = Arc::new(Shared {
            keys: RwLock::new(Arc::new(Keys::parse(snapshot)?)),
            refresh: Notify::new(),
            logs: Mutex::new(HashMap::new()),
            counters,
        });
        let mut validation = Validation::new(Algorithm::RS256);
        validation.set_issuer(&[&settings.issuer]);
        validation.set_audience(&[&settings.audience]);
        validation.set_required_spec_claims(&["sub", "iss", "aud", "exp"]);
        validation.validate_exp = false;
        validation.validate_nbf = false;
        validation.leeway = 0;
        Ok((
            Self {
                shared: shared.clone(),
                validation,
                namespace: settings.namespace,
            },
            Refresh {
                shared,
                uri: settings.jwks_uri,
            },
        ))
    }
    pub fn namespace(&self) -> &str {
        &self.namespace
    }
    /// The caller supplies its clock. Return verified original claims so the
    /// provisioning mapper can preserve both standard and namespaced profiles.
    pub fn verify_at(&self, authorization: &str, now: u64) -> Result<Value, Error> {
        let (scheme, token) = authorization.split_once(' ').ok_or(Error::InvalidToken)?;
        if !scheme.eq_ignore_ascii_case("Bearer") || token.is_empty() || token.len() > 16384 {
            return Err(Error::InvalidToken);
        }
        let header = decode_header(token).map_err(|_| Error::InvalidToken)?;
        if header.alg != Algorithm::RS256 {
            return Err(Error::InvalidToken);
        }
        let kid = header
            .kid
            .filter(|s| !s.is_empty())
            .ok_or(Error::InvalidToken)?;
        let keys = self
            .shared
            .keys
            .read()
            .map_err(|_| Error::Unavailable)?
            .clone();
        let Some(key) = keys.0.get(&kid) else {
            self.shared.counters.record(Event::OidcJwksMiss);
            self.shared.refresh.notify_one();
            // Hash the untrusted identifier: bounded, inert diagnostic data,
            // never a raw token, arbitrary log line, subject or email.
            let digest: [u8; 32] = Sha256::digest(kid.as_bytes()).into();
            if should_log(
                &mut *self.shared.logs.lock().map_err(|_| Error::Unavailable)?,
                digest,
                Instant::now(),
            ) {
                tracing::warn!(kid_sha256 = ?digest, "OIDC provider key unknown; token refused");
            }
            return Err(Error::UnknownKey);
        };
        let claims = decode::<Value>(token, key, &self.validation)
            .map_err(|_| Error::InvalidToken)?
            .claims;
        if claims["exp"].as_u64().is_none_or(|exp| exp <= now)
            || claims
                .get("nbf")
                .is_some_and(|nbf| nbf.as_u64().is_none_or(|n| n > now))
            || claims["sub"]
                .as_str()
                .is_none_or(|s| s.is_empty() || s.len() > 255)
        {
            return Err(Error::InvalidToken);
        }
        Ok(claims)
    }
}
fn should_log(logs: &mut HashMap<[u8; 32], Instant>, kid: [u8; 32], now: Instant) -> bool {
    logs.retain(|_, at| now.duration_since(*at) < LOG_PERIOD);
    // A random-kid flood cannot grow memory without bound. Excess distinct
    // kids remain counted; logs are suppressed until an hourly slot expires.
    if logs.contains_key(&kid) || logs.len() >= 4096 {
        return false;
    }
    logs.insert(kid, now);
    true
}

/// Owned background task. On shutdown abort and await the spawned JoinHandle;
/// dropping a handle alone detaches it. Construction starts no task.
pub struct Refresh {
    shared: Arc<Shared>,
    uri: String,
}
impl Refresh {
    /// Schedule and unknown-kid signals share a global one-minute attempt cap,
    /// including failures. Signals coalesce; a throttled miss remains pending.
    pub async fn run(self, schedule: Duration) -> Result<(), Error> {
        if schedule < MIN_REFRESH {
            return Err(Error::Configuration);
        }
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(10))
            .build()
            .map_err(|_| Error::Configuration)?;
        let mut next_scheduled = Instant::now() + schedule;
        let mut next_allowed = Instant::now();
        loop {
            tokio::select! {
                _=tokio::time::sleep_until(next_scheduled)=>{},
                _=self.shared.refresh.notified()=>{},
            }
            tokio::time::sleep_until(next_allowed).await;
            next_allowed = Instant::now() + MIN_REFRESH;
            match self.fetch(&client).await {
                Ok(keys) => {
                    *self.shared.keys.write().map_err(|_| Error::Unavailable)? = Arc::new(keys);
                    self.shared.counters.record(Event::OidcJwksRefreshSuccess);
                }
                Err(_) => {
                    self.shared.counters.record(Event::OidcJwksRefreshFailure);
                    tracing::warn!("OIDC provider key refresh failed; keeping previous keys");
                }
            }
            next_scheduled = Instant::now() + schedule;
        }
    }
    async fn fetch(&self, client: &reqwest::Client) -> Result<Keys, Error> {
        let mut response = client
            .get(&self.uri)
            .send()
            .await
            .map_err(|_| Error::Unavailable)?;
        if !response.status().is_success()
            || response
                .content_length()
                .is_some_and(|n| n > MAX_JWKS as u64)
        {
            return Err(Error::Unavailable);
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| Error::Unavailable)? {
            if bytes.len() + chunk.len() > MAX_JWKS {
                return Err(Error::Unavailable);
            }
            bytes.extend_from_slice(&chunk);
        }
        Keys::parse(&bytes)
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    #[test]
    fn settings_read_once_and_log_suppression_is_per_kid_and_bounded() {
        let mut names = vec![];
        let s = Settings::from_lookup(|name| {
            names.push(name.to_owned());
            Some(
                match name {
                    "JWKS_URI" => "http://127.0.0.1:1234/keys",
                    _ => "value",
                }
                .into(),
            )
        })
        .unwrap();
        assert_eq!(
            names,
            vec!["AUTH_ISSUER", "AUTH_AUDIENCE", "AUTH_NAMESPACE", "JWKS_URI"]
        );
        assert_eq!(s.audience, "value");
        let mut logs = HashMap::new();
        let now = Instant::now();
        assert!(should_log(&mut logs, [1; 32], now));
        assert!(!should_log(
            &mut logs,
            [1; 32],
            now + Duration::from_secs(3599)
        ));
        assert!(should_log(&mut logs, [2; 32], now));
        assert!(should_log(&mut logs, [1; 32], now + LOG_PERIOD));
        for i in 0u32..5000 {
            should_log(
                &mut logs,
                Sha256::digest(i.to_le_bytes()).into(),
                now + LOG_PERIOD,
            );
        }
        assert_eq!(logs.len(), 4096);
    }
}
