//! Public-client authorization code flow. Access tokens are verified by the API,
//! never decoded locally as identity. Refresh credentials remain bound to the profile.
use crate::profiles::{self, Config};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use polis_contracts::{Error, Result};
use reqwest::blocking::{Client, Response};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Write},
    net::TcpListener,
    time::{Duration, Instant},
};
use url::Url;

fn failure(code: &'static str, message: &str) -> Error {
    Error::new(code, message, "Check the configured issuer, public client ID, audience and loopback callback registration; then run auth login again.", 3)
}
fn endpoint(raw: &str) -> Result<Url> {
    let u = Url::parse(raw).map_err(|_| failure("oauth_configuration", "Invalid OAuth URL."))?;
    if !(u.scheme() == "https"
        || (u.scheme() == "http"
            && matches!(u.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))))
        || u.host_str().is_none()
        || !u.username().is_empty()
        || u.password().is_some()
        || u.fragment().is_some()
    {
        return Err(failure(
            "oauth_configuration",
            "OAuth URLs require HTTPS (HTTP only on loopback), without credentials or fragments.",
        ));
    }
    Ok(u)
}
fn document(response: Response) -> Result<Value> {
    let (success, value) = response_document(response)?;
    if !success {
        return Err(failure(
            "oauth_rejected",
            "The issuer rejected the OAuth request. No token was saved.",
        ));
    }
    Ok(value)
}
fn response_document(response: Response) -> Result<(bool, Value)> {
    let success = response.status().is_success();
    let mut data = Vec::new();
    response
        .take(131_073)
        .read_to_end(&mut data)
        .map_err(|_| failure("oauth_transport", "Cannot read issuer response."))?;
    if data.len() > 131_072 {
        return Err(failure("oauth_response", "Issuer response is too large."));
    }
    serde_json::from_slice(&data)
        .map(|value| (success, value))
        .map_err(|_| failure("oauth_response", "Issuer response is not JSON."))
}
fn random() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}
fn challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

// Ignore unrelated connections without reflecting any query or OAuth secret.
fn callback(target: &str, expected_state: &str, issuer: &str) -> Result<Option<String>> {
    if !target.starts_with("/oauth/callback?") {
        return Ok(None);
    }
    let u = Url::parse(&format!("http://127.0.0.1{target}"))
        .map_err(|_| failure("oauth_callback", "Invalid callback."))?;
    let mut params = std::collections::BTreeMap::new();
    for (key, value) in u.query_pairs() {
        if params
            .insert(key.into_owned(), value.into_owned())
            .is_some()
        {
            return Ok(None);
        }
    }
    if params.get("state").map(String::as_str) != Some(expected_state) {
        return Ok(None);
    }
    if params.get("iss").is_some_and(|v| v != issuer) {
        return Err(failure(
            "oauth_issuer_mismatch",
            "Callback issuer does not match configuration.",
        ));
    }
    if params.contains_key("error") {
        return Err(failure(
            "oauth_denied",
            "Browser authorization was denied or cancelled. No token was saved.",
        ));
    }
    let code = params
        .remove("code")
        .filter(|v| !v.is_empty() && v.len() <= 4096 && !v.chars().any(char::is_control))
        .ok_or_else(|| {
            failure(
                "oauth_callback",
                "Authorization callback has no valid code.",
            )
        })?;
    Ok(Some(code))
}
fn wait(listener: TcpListener, state: &str, issuer: &str, timeout: Duration) -> Result<String> {
    listener
        .set_nonblocking(true)
        .map_err(|_| failure("oauth_listener", "Cannot configure loopback listener."))?;
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        let (mut stream, _) = match listener.accept() {
            Ok(v) => v,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(25));
                continue;
            }
            Err(_) => return Err(failure("oauth_listener", "Loopback listener failed.")),
        };
        stream.set_nonblocking(false).ok();
        stream
            .set_read_timeout(Some(Duration::from_millis(300)))
            .ok();
        stream
            .set_write_timeout(Some(Duration::from_millis(300)))
            .ok();
        let mut request = Vec::new();
        let request_deadline = Instant::now() + Duration::from_secs(2);
        let mut byte = [0u8; 1];
        while request.len() < 8192 && Instant::now() < deadline && Instant::now() < request_deadline
        {
            if stream.read(&mut byte).unwrap_or(0) != 1 {
                break;
            }
            request.push(byte[0]);
            if request.ends_with(b"\r\n\r\n") {
                break;
            }
        }
        let text = String::from_utf8_lossy(&request);
        let parts: Vec<_> = text
            .lines()
            .next()
            .unwrap_or("")
            .split_whitespace()
            .collect();
        let result = if request.ends_with(b"\r\n\r\n") && parts.len() == 3 && parts[0] == "GET" {
            callback(parts[1], state, issuer)
        } else {
            Ok(None)
        };
        let accepted = matches!(&result, Ok(Some(_)));
        let (status, body) = if accepted {
            (
                "200 OK",
                "Authorization received. Return to the terminal to check sign-in.",
            )
        } else {
            (
                "400 Bad Request",
                "Authorization callback rejected. Return to the terminal.",
            )
        };
        let _ = write!(stream, "HTTP/1.1 {status}\r\nContent-Type: text/plain\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}", body.len());
        if let Some(code) = result? {
            return Ok(code);
        }
    }
    Err(failure(
        "oauth_timeout",
        "Browser sign-in timed out. No token was saved.",
    ))
}
struct Provider {
    http: Client,
    metadata: Value,
}
fn provider(auth: &profiles::AuthConfig, timeout: u64) -> Result<Provider> {
    if auth.issuer.is_empty() || auth.client_id.is_empty() {
        return Err(failure("oauth_unconfigured", "Configure an issuer and public native client ID in profiles.json or profile-specific POLIS_AUTH_* developer variables."));
    }
    let issuer = endpoint(&auth.issuer)?;
    if issuer.query().is_some() {
        return Err(failure(
            "oauth_configuration",
            "Issuer must not contain a query.",
        ));
    }
    let mut builder = Client::builder()
        .timeout(Duration::from_secs(timeout))
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never());
    if let Some(path) = &auth.ca_file {
        let bytes = std::fs::read(path)
            .map_err(|_| failure("oauth_configuration", "Cannot read CA file."))?;
        let cert = reqwest::Certificate::from_pem(&bytes)
            .map_err(|_| failure("oauth_configuration", "Invalid CA file."))?;
        builder = builder.add_root_certificate(cert);
    }
    let http = builder
        .build()
        .map_err(|_| failure("oauth_transport", "Cannot initialize TLS."))?;
    let metadata_url = format!(
        "{}/.well-known/openid-configuration",
        auth.issuer.trim_end_matches('/')
    );
    let metadata = document(
        http.get(metadata_url)
            .send()
            .map_err(|_| failure("oauth_transport", "Cannot read configured issuer metadata."))?,
    )?;
    if metadata["issuer"].as_str() != Some(auth.issuer.as_str()) {
        return Err(failure(
            "oauth_issuer_mismatch",
            "Metadata issuer does not exactly match configuration.",
        ));
    }
    Ok(Provider { http, metadata })
}
pub fn login(config: &Config, site: &str, timeout: u64, no_browser: bool) -> Result<Value> {
    let auth = config.auth(site)?;
    let Provider { http, metadata } = provider(&auth, timeout)?;
    if metadata
        .get("code_challenge_methods_supported")
        .is_some_and(|v| !v.as_array().is_some_and(|a| a.iter().any(|v| v == "S256")))
    {
        return Err(failure(
            "oauth_pkce_unsupported",
            "Issuer does not advertise S256 support.",
        ));
    }
    let mut authorize = endpoint(metadata["authorization_endpoint"].as_str().unwrap_or(""))?;
    let token_url = endpoint(metadata["token_endpoint"].as_str().unwrap_or(""))?;
    let listener = TcpListener::bind(("127.0.0.1", auth.callback_port)).map_err(|_| {
        failure(
            "oauth_listener",
            "Cannot bind the configured loopback callback port.",
        )
    })?;
    let redirect = format!(
        "http://127.0.0.1:{}/oauth/callback",
        listener
            .local_addr()
            .map_err(|_| failure("oauth_listener", "Cannot inspect callback port."))?
            .port()
    );
    let verifier = random();
    let state = random();
    authorize.query_pairs_mut().extend_pairs([
        ("response_type", "code"),
        ("client_id", auth.client_id.as_str()),
        ("redirect_uri", redirect.as_str()),
        ("scope", "openid profile email offline_access"),
        ("state", state.as_str()),
        ("code_challenge", challenge(&verifier).as_str()),
        ("code_challenge_method", "S256"),
    ]);
    if !auth.audience.is_empty() {
        authorize
            .query_pairs_mut()
            .append_pair("audience", &auth.audience);
    }
    // stderr keeps stdout a single stable JSON result for agents. No password/token/code is printed.
    eprintln!("Open this URL on this machine to sign in:\n{authorize}");
    if !no_browser {
        let _ = std::process::Command::new("/usr/bin/open")
            .arg(authorize.as_str())
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
    let code = wait(listener, &state, &auth.issuer, Duration::from_secs(180))?;
    let mut fields = vec![
        ("grant_type", "authorization_code"),
        ("client_id", auth.client_id.as_str()),
        ("code", code.as_str()),
        ("redirect_uri", redirect.as_str()),
        ("code_verifier", verifier.as_str()),
    ];
    if !auth.audience.is_empty() {
        fields.push(("audience", auth.audience.as_str()));
    }
    let response = document(http.post(token_url).form(&fields).send().map_err(|_| {
        failure(
            "oauth_transport",
            "Token exchange failed; restart sign-in. No automatic retry.",
        )
    })?)?;
    finish_login(
        config,
        site,
        timeout,
        &auth,
        response,
        "authorization_code_pkce_s256",
    )
}
fn now() -> Result<u64> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .map_err(|_| failure("oauth_clock", "System clock is before the Unix epoch."))
}
fn tokens(
    response: &Value,
    auth: &profiles::AuthConfig,
    previous_refresh: Option<String>,
) -> Result<(String, profiles::Session)> {
    if response.get("error").is_some()
        || !response["token_type"]
            .as_str()
            .is_some_and(|s| s.eq_ignore_ascii_case("Bearer"))
    {
        return Err(failure(
            "oauth_response",
            "Issuer did not return a Bearer access token.",
        ));
    }
    let token = response["access_token"]
        .as_str()
        .ok_or_else(|| failure("oauth_response", "Issuer did not return an access token."))?;
    profiles::validate_token(token)?;
    let expires = response["expires_in"]
        .as_u64()
        .filter(|n| *n > 0 && *n <= 31_536_000)
        .ok_or_else(|| {
            failure(
                "oauth_response",
                "Issuer did not return a valid token lifetime.",
            )
        })?;
    let refresh = match response.get("refresh_token") {
        None => previous_refresh,
        Some(v) => {
            let value = v
                .as_str()
                .ok_or_else(|| failure("oauth_response", "Invalid refresh credential."))?;
            profiles::validate_token(value)?;
            Some(value.into())
        }
    };
    Ok((
        token.into(),
        profiles::Session {
            issuer: auth.issuer.clone(),
            client_id: auth.client_id.clone(),
            audience: auth.audience.clone(),
            expires_at: now()?.saturating_add(expires),
            refresh_token: refresh,
        },
    ))
}
fn finish_login(
    config: &Config,
    site: &str,
    timeout: u64,
    auth: &profiles::AuthConfig,
    response: Value,
    flow: &str,
) -> Result<Value> {
    let (token, session) = tokens(&response, auth, None)?;
    let origin = config.url(site)?;
    polis_client::Client::with_ca(
        origin,
        Some(token.clone()),
        timeout,
        auth.ca_file.as_deref(),
    )?
    .request("GET", "/api/v3/users", &[], None, false)?;
    let refresh_available = session.refresh_token.is_some();
    let _lock = profiles::credential_lock(site, origin)?;
    profiles::store_session(site, origin, &token, session)?;
    Ok(
        json!({"state":"authenticated","origin":origin,"flow":flow,"storage":"owner-only file (0600)",
        "expires_in":response["expires_in"],"verified_by":"GET /api/v3/users","refresh_available":refresh_available}),
    )
}
pub fn access_token(config: &Config, site: &str, timeout: u64) -> Result<Option<String>> {
    let origin = config.url(site)?;
    // Explicit bearer overrides never read/refresh/erase a stored session.
    if std::env::var_os(profiles::token_env(site)).is_some() {
        return profiles::token(site, origin);
    }
    let _lock = profiles::credential_lock(site, origin)?;
    let Some((token, session)) = profiles::session(site, origin)? else {
        return profiles::token(site, origin);
    };
    let auth = config.auth(site)?;
    if session.issuer != auth.issuer
        || session.client_id != auth.client_id
        || session.audience != auth.audience
    {
        return Err(failure("oauth_session_mismatch", "Saved session belongs to different issuer, client or audience settings. Sign in again."));
    }
    if session.expires_at > now()?.saturating_add(30) {
        return Ok(Some(token));
    }
    let refresh = session.refresh_token.ok_or_else(|| {
        failure(
            "oauth_login_required",
            "Access token expired and no refresh credential is available. Sign in again.",
        )
    })?;
    let Provider { http, metadata } = provider(&auth, timeout)?;
    let token_url = endpoint(metadata["token_endpoint"].as_str().unwrap_or(""))?;
    let (success, response) = response_document(
        http.post(token_url)
            .form(&[
                ("grant_type", "refresh_token"),
                ("client_id", auth.client_id.as_str()),
                ("refresh_token", refresh.as_str()),
            ])
            .send()
            .map_err(|_| {
                failure(
                    "oauth_transport",
                    "Refresh exchange failed. No API request was sent; no automatic retry.",
                )
            })?,
    )?;
    if response["error"] == "invalid_grant" {
        profiles::clear_session(site, origin)?;
        return Err(failure("oauth_login_required", "Refresh credential expired or was revoked; the stored session was cleared. Sign in again."));
    }
    if !success || response.get("error").is_some() {
        return Err(failure(
            "oauth_refresh_rejected",
            "Issuer rejected refresh. No API request was sent; sign in again if this persists.",
        ));
    }
    let (token, session) = tokens(&response, &auth, Some(refresh))?;
    // Persist rotation before any API request, which might fail after the issuer consumed the old token.
    profiles::store_session(site, origin, &token, session)?;
    Ok(Some(token))
}
pub fn device_login(config: &Config, site: &str, timeout: u64) -> Result<Value> {
    let auth = config.auth(site)?;
    let Provider { http, metadata } = provider(&auth, timeout)?;
    let device_url = metadata["device_authorization_endpoint"]
        .as_str()
        .ok_or_else(|| {
            failure(
                "oauth_device_unsupported",
                "Issuer does not advertise device authorization.",
            )
        })?;
    let device_url = endpoint(device_url)?;
    let token_url = endpoint(metadata["token_endpoint"].as_str().unwrap_or(""))?;
    let mut fields = vec![
        ("client_id", auth.client_id.as_str()),
        ("scope", "openid profile email offline_access"),
    ];
    if !auth.audience.is_empty() {
        fields.push(("audience", auth.audience.as_str()));
    }
    let response = document(
        http.post(device_url)
            .form(&fields)
            .send()
            .map_err(|_| failure("oauth_transport", "Device authorization request failed."))?,
    )?;
    let code = response["device_code"]
        .as_str()
        .ok_or_else(|| failure("oauth_response", "Missing device code."))?;
    profiles::validate_token(code)?;
    let user_code = response["user_code"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 128 && !s.chars().any(char::is_control))
        .ok_or_else(|| failure("oauth_response", "Missing or invalid user code."))?;
    let verification = endpoint(response["verification_uri"].as_str().unwrap_or(""))?;
    let expires = response["expires_in"]
        .as_u64()
        .filter(|v| *v > 0 && *v <= 3600)
        .ok_or_else(|| failure("oauth_response", "Invalid device authorization lifetime."))?;
    let mut interval = match response.get("interval") {
        None => 5,
        Some(v) => v
            .as_u64()
            .filter(|v| *v > 0 && *v <= 3600)
            .ok_or_else(|| failure("oauth_response", "Invalid device polling interval."))?,
    };
    eprintln!("On a device with a browser, open:\n{verification}\nEnter code: {user_code}");
    let deadline = Instant::now() + Duration::from_secs(expires);
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining <= Duration::from_secs(interval) {
            return Err(failure(
                "oauth_device_expired",
                "Device authorization expired. Start sign-in again.",
            ));
        }
        std::thread::sleep(Duration::from_secs(interval));
        let remaining = deadline.saturating_duration_since(Instant::now());
        let response = http
            .post(token_url.clone())
            .timeout(remaining.min(Duration::from_secs(timeout)))
            .form(&[
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
                ("client_id", auth.client_id.as_str()),
                ("device_code", code),
            ])
            .send();
        let response = match response {
            Ok(response) => response,
            Err(e) if e.is_timeout() || e.is_connect() => {
                interval = interval.saturating_mul(2); // RFC 8628: back off on connection timeouts.
                continue;
            }
            Err(_) => {
                return Err(failure(
                    "oauth_transport",
                    "Device polling failed. Start sign-in again.",
                ))
            }
        };
        let (success, response) = response_document(response)?;
        match response["error"].as_str() {
            Some("authorization_pending") => continue,
            Some("slow_down") => {
                interval = interval.saturating_add(5);
                continue;
            }
            Some("access_denied") => {
                return Err(failure(
                    "oauth_denied",
                    "Device authorization was denied. No token was saved.",
                ))
            }
            Some("expired_token") => {
                return Err(failure(
                    "oauth_device_expired",
                    "Device authorization expired. Start sign-in again.",
                ))
            }
            Some(_) => {
                return Err(failure(
                    "oauth_rejected",
                    "Issuer rejected device authorization. No token was saved.",
                ))
            }
            None if !success => {
                return Err(failure(
                    "oauth_rejected",
                    "Device polling failed. No token was saved.",
                ))
            }
            None => return finish_login(config, site, timeout, &auth, response, "device_code"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rfc7636_challenge() {
        assert_eq!(
            challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }
    #[test]
    fn callback_binding() {
        for target in [
            "/other?state=s&code=c",
            "/oauth/callback?state=x&code=c",
            "/oauth/callback?state=s&state=s&code=c",
            "/oauth/callback?state=s&code=c&code=d",
        ] {
            assert!(callback(target, "s", "https://issuer.invalid/")
                .unwrap()
                .is_none());
        }
        assert_eq!(
            callback(
                "/oauth/callback?state=s&code=c",
                "s",
                "https://issuer.invalid/"
            )
            .unwrap(),
            Some("c".into())
        );
        assert_eq!(
            callback(
                "/oauth/callback?state=s&error=denied",
                "s",
                "https://issuer.invalid/"
            )
            .unwrap_err()
            .code,
            "oauth_denied"
        );
        assert!(callback(
            "/oauth/callback?state=s&code=c&iss=https%3A%2F%2Fother.invalid%2F",
            "s",
            "https://issuer.invalid/"
        )
        .is_err());
    }
    #[test]
    fn endpoint_transport_rules() {
        for v in [
            "http://issuer.invalid/",
            "https://user:password@issuer.invalid/",
            "https://issuer.invalid/#token",
            "file:///tmp/oauth",
        ] {
            assert!(endpoint(v).is_err());
        }
        assert!(endpoint("http://127.0.0.1:1234/tenant/").is_ok());
        assert!(endpoint("https://issuer.invalid/tenant/").is_ok());
    }
}
