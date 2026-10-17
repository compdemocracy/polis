//! Bounded same-origin HTTP with no automatic redirect or request retry.
use polis_contracts::{Error, Result};
use reqwest::{blocking::Client as Http, Method};
use serde_json::{json, Value};
use std::{io::Read, time::Duration};
use url::Url;

const MAX_BODY: u64 = 8 * 1024 * 1024;
pub struct Client {
    http: Http,
    base: Url,
    token: Option<String>,
}

/// The checks every request path passes, before any credential is used: the
/// /api/v3/ prefix on the selected origin, no fragment or control characters, no
/// unsafe legacy admission route, no participant seed flag. Returns the URL.
pub fn check_request(
    base: &Url,
    method: &str,
    path: &str,
    query: &[(String, String)],
    body: Option<&Value>,
) -> Result<Url> {
    // Never allow an escape hatch to route credentials to another origin.
    if !path.starts_with("/api/v3/")
        || path.contains('#')
        || path.contains('\\')
        || path.chars().any(char::is_control)
    {
        return Err(Error::input(
            "API path must start with /api/v3/ and contain no fragment or control characters.",
        ));
    }
    let url = base
        .join(path)
        .map_err(|_| Error::input("Invalid API path."))?;
    if url.origin() != base.origin() || !url.path().starts_with("/api/v3/") {
        return Err(Error::input(
            "API path must remain inside the selected site's /api/v3/ prefix.",
        ));
    }
    let route = url.path().trim_end_matches('/');
    if route.eq_ignore_ascii_case("/api/v3/joinWithInvite")
        || (method.eq_ignore_ascii_case("POST")
            && route.eq_ignore_ascii_case("/api/v3/participants"))
    {
        return Err(Error::input(
            "Unsafe legacy admission route is unavailable. Use join, vote or comment.",
        ));
    }
    if route.eq_ignore_ascii_case("/api/v3/comments")
        && (body.is_some_and(|b| b.get("is_seed").is_some())
            || query.iter().any(|(key, _)| key == "is_seed")
            || url.query_pairs().any(|(key, _)| key == "is_seed"))
    {
        return Err(Error::input(
            "Participant comments cannot send is_seed. Use the administrator seed commands for seed imports.",
        ));
    }
    Ok(url)
}

pub fn base_url(raw: &str) -> Result<Url> {
    let u = Url::parse(raw).map_err(|_| Error::input("Invalid site URL."))?;
    let local = matches!(u.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if !(u.scheme() == "https" || (u.scheme() == "http" && local))
        || u.host_str().is_none()
        || !u.username().is_empty()
        || u.password().is_some()
        || u.query().is_some()
        || u.fragment().is_some()
        || u.path() != "/"
    {
        return Err(Error::input("Site URL must be an HTTPS origin (HTTP allowed only on loopback), without credentials, path, query or fragment."));
    }
    Ok(u)
}
impl Client {
    pub fn new(base: &str, token: Option<String>, timeout: u64) -> Result<Self> {
        Self::with_ca(base, token, timeout, None)
    }
    pub fn with_ca(
        base: &str,
        token: Option<String>,
        timeout: u64,
        ca_file: Option<&str>,
    ) -> Result<Self> {
        if !(1..=300).contains(&timeout) {
            return Err(Error::input("Timeout must be 1–300 seconds."));
        }
        let mut builder = Http::builder()
            .timeout(Duration::from_secs(timeout))
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never());
        if let Some(path) = ca_file {
            let pem =
                std::fs::read(path).map_err(|_| Error::input("Cannot read configured CA file."))?;
            let cert = reqwest::Certificate::from_pem(&pem)
                .map_err(|_| Error::input("Invalid CA PEM."))?;
            builder = builder.add_root_certificate(cert);
        }
        let http = builder.build().map_err(|_| {
            Error::new(
                "transport_unavailable",
                "Cannot initialize HTTP client.",
                "Check local TLS configuration.",
                6,
            )
        })?;
        Ok(Self {
            http,
            base: base_url(base)?,
            token,
        })
    }
    pub fn request(
        &self,
        method: &str,
        path: &str,
        query: &[(String, String)],
        body: Option<Value>,
        effect: bool,
    ) -> Result<Value> {
        let (status, content_type, bytes) =
            self.exchange(method, path, query, body, effect, false)?;
        if status == 204 {
            return Ok(json!({"state":"no_content"}));
        }
        if !content_type.contains("application/json") && !content_type.contains("+json") {
            return Err(protocol(
                effect,
                "Expected JSON; the site may be serving a login page or frontend.",
            ));
        }
        serde_json::from_slice(&bytes)
            .map_err(|_| protocol(effect, "Site returned malformed JSON."))
    }
    /// Bounded bytes for dedicated existing API operations (CSV or an HTML
    /// success receipt). Error bodies still use the normal safe error mapping.
    pub fn operation_bytes(
        &self,
        method: &str,
        path: &str,
        query: &[(String, String)],
        body: Option<Value>,
        effect: bool,
    ) -> Result<Vec<u8>> {
        self.exchange(method, path, query, body, effect, false)
            .map(|(_, _, bytes)| bytes)
    }
    /// This existing export route issues a signed redirect, not artifact bytes.
    /// Return the capability only to the private-file caller; never follow it.
    pub fn export_capability(&self, query: &[(String, String)]) -> Result<String> {
        let url = self
            .base
            .join("/api/v3/dataExport/results")
            .expect("fixed API path");
        let mut request = self
            .http
            .get(url)
            .query(query)
            .header("User-Agent", "polis-cli/0.1.0");
        if let Some(token) = &self.token {
            request = request.bearer_auth(token);
        }
        let response = request
            .send()
            .map_err(|e| transport(false, e.is_connect()))?;
        let status = response.status().as_u16();
        let unavailable = || {
            let mut e = Error::new("export_capability_unavailable", "The site did not issue a valid export download capability.", "Check the conversation, export filename and account permissions; no redirect was followed.", match status {401=>3,403=>4,500..=599=>6,_=>1});
            e.upstream = json!({"status":status});
            e
        };
        if status != 302 {
            return Err(unavailable());
        }
        let location = response
            .headers()
            .get("location")
            .and_then(|v| v.to_str().ok())
            .filter(|v| v.len() <= 8192)
            .ok_or_else(unavailable)?;
        let target = Url::parse(location).map_err(|_| unavailable())?;
        if target.scheme() != "https"
            || target.host_str().is_none()
            || !target.username().is_empty()
            || target.password().is_some()
            || target.fragment().is_some()
        {
            return Err(unavailable());
        }
        Ok(location.to_owned())
    }
    /// CSV operations reject HTML or JSON success pages before saving a file.
    pub fn operation_csv(&self, path: &str, query: &[(String, String)]) -> Result<Vec<u8>> {
        let (status, content_type, bytes) =
            self.exchange("GET", path, query, None, false, false)?;
        if status != 200
            || !matches!(
                content_type.split(';').next().map(str::trim),
                Some("text/csv" | "application/csv")
            )
        {
            return Err(protocol(false, "Expected a CSV response."));
        }
        Ok(bytes)
    }
    /// Public documents outside the API prefix. These exact paths never receive
    /// credentials, follow redirects, evaluate HTML, or open a browser.
    pub fn public_document(&self, path: &str) -> Result<Vec<u8>> {
        let parts = path.split('/').collect::<Vec<_>>();
        let feed = matches!(parts.len(), 3 | 4)
            && parts.get(1) == Some(&"feeds")
            && parts[2].len() <= 300
            && !parts[2].is_empty()
            && parts[2].bytes().all(|b| b.is_ascii_alphanumeric())
            && (parts.len() == 3 || matches!(parts[3], "consensus" | "topics"));
        if !feed && path != "/perfStats_9182738127" {
            return Err(Error::input("Unsupported public document path."));
        }
        let url = self
            .base
            .join(path)
            .map_err(|_| Error::input("Invalid public document path."))?;
        if url.origin() != self.base.origin() {
            return Err(Error::input("Public document must stay on this site."));
        }
        let response = self
            .http
            .get(url)
            .header("User-Agent", "polis-cli/0.1.0")
            .send()
            .map_err(|e| transport(false, e.is_connect()))?;
        let status = response.status().as_u16();
        if !(200..300).contains(&status) {
            let mut e = Error::new(
                "document_unavailable",
                "The site did not return the requested public document.",
                "Check this report and site; no redirects or retries were followed.",
                if status >= 500 { 6 } else { 1 },
            );
            e.upstream = json!({"status":status});
            return Err(e);
        }
        let mut bytes = Vec::new();
        response
            .take(MAX_BODY + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| transport(false, false))?;
        if bytes.len() as u64 > MAX_BODY {
            return Err(protocol(false, "Public document exceeds the 8 MiB limit."));
        }
        Ok(bytes)
    }
    /// Allocate an ID; the legacy route does not create a conversation or bind an owner.
    pub fn reserve_conversation(&self) -> Result<Value> {
        let (status, content_type, bytes) = self.exchange(
            "POST",
            "/api/v3/reserve_conversation_id",
            &[],
            Some(json!({})),
            true,
            false,
        )?;
        if status != 200
            || !(content_type.contains("application/json") || content_type.contains("+json"))
        {
            return Err(protocol(
                true,
                "Conversation reservation must return HTTP 200 JSON.",
            ));
        }
        serde_json::from_slice(&bytes)
            .map_err(|_| protocol(true, "Site returned malformed reservation receipt JSON."))
    }
    /// Update only the authenticated account's existing preference row.
    pub fn set_participant_preferences(&self, body: Value) -> Result<Value> {
        let (status, content_type, bytes) = self.exchange(
            "PUT",
            "/api/v3/participants_extended",
            &[],
            Some(body),
            true,
            false,
        )?;
        if status != 200
            || !(content_type.contains("application/json") || content_type.contains("+json"))
        {
            return Err(protocol(
                true,
                "Participant preference update must return HTTP 200 JSON.",
            ));
        }
        serde_json::from_slice(&bytes)
            .map_err(|_| protocol(true, "Site returned malformed preference receipt JSON."))
    }
    /// Read only the existing public participant-location route.
    pub fn participant_locations(&self, query: &[(String, String)]) -> Result<Value> {
        let (status, content_type, bytes) =
            self.exchange("GET", "/api/v3/locations", query, None, false, false)?;
        if status != 200
            || !(content_type.contains("application/json") || content_type.contains("+json"))
        {
            return Err(protocol(
                false,
                "Participant locations must return HTTP 200 JSON.",
            ));
        }
        serde_json::from_slice(&bytes)
            .map_err(|_| protocol(false, "Site returned malformed participant location JSON."))
    }
    /// Read the existing participant profiles endpoint without changing moderation.
    pub fn participant_highlights(&self, query: &[(String, String)]) -> Result<Value> {
        let (status, content_type, bytes) =
            self.exchange("GET", "/api/v3/ptptois", query, None, false, false)?;
        if status != 200
            || !(content_type.contains("application/json") || content_type.contains("+json"))
        {
            return Err(protocol(
                false,
                "Participant profiles must return HTTP 200 JSON.",
            ));
        }
        serde_json::from_slice(&bytes)
            .map_err(|_| protocol(false, "Site returned malformed participant profile JSON."))
    }
    /// Read only the existing public base-cluster membership route.
    pub fn base_cluster_membership(&self, conversation: &str) -> Result<Value> {
        let (status, content_type, bytes) = self.exchange(
            "GET",
            "/api/v3/bidToPid",
            &[("conversation_id".into(), conversation.into())],
            None,
            false,
            false,
        )?;
        if status != 200
            || !(content_type.contains("application/json") || content_type.contains("+json"))
        {
            return Err(protocol(false, "Membership must return HTTP 200 JSON."));
        }
        serde_json::from_slice(&bytes)
            .map_err(|_| protocol(false, "Site returned malformed membership JSON."))
    }
    /// Read the fixed PCA presentation route, with bounded gzip support.
    pub fn math_presentation(&self, query: &[(String, String)]) -> Result<Value> {
        let (status, content_type, bytes) =
            self.exchange("GET", "/api/v3/math/pca2", query, None, false, true)?;
        if status != 200
            || !(content_type.contains("application/json") || content_type.contains("+json"))
        {
            return Err(protocol(
                false,
                "Math presentation must return HTTP 200 JSON.",
            ));
        }
        serde_json::from_slice(&bytes)
            .map_err(|_| protocol(false, "Site returned malformed math JSON."))
    }
    /// Only the fixed public report export route is eligible for text downloads.
    pub fn report_export(&self, report: &str, kind: &str) -> Result<Vec<u8>> {
        if report.is_empty()
            || !report.bytes().all(|b| b.is_ascii_alphanumeric())
            || !matches!(
                kind,
                "summary.csv"
                    | "comments.csv"
                    | "votes.csv"
                    | "participant-votes.csv"
                    | "participant-importance.csv"
                    | "comment-groups.csv"
                    | "comment-clusters.csv"
                    | "format.json"
            )
        {
            return Err(Error::input("Invalid report export identifier or type."));
        }
        let (status, content_type, bytes) = self.exchange(
            "GET",
            &format!("/api/v3/reportExport/{report}/{kind}"),
            &[],
            None,
            false,
            false,
        )?;
        let valid = if kind == "format.json" {
            content_type.contains("application/json")
                && serde_json::from_slice::<Value>(&bytes).is_ok()
        } else {
            content_type.contains("text/csv") || content_type.contains("application/csv")
        };
        if status != 200 || !valid {
            return Err(protocol(
                false,
                "Export did not return the requested CSV or JSON format.",
            ));
        }
        Ok(bytes)
    }
    /// Moderator-authorized XID CSV. Never interprets this as a full roster.
    pub fn participant_export(&self, conversation: &str) -> Result<Vec<u8>> {
        if conversation.is_empty() || !conversation.bytes().all(|b| b.is_ascii_alphanumeric()) {
            return Err(Error::input("Invalid conversation ID."));
        }
        let (status, content_type, bytes) = self.exchange(
            "GET",
            "/api/v3/xids/csv",
            &[("conversation_id".into(), conversation.into())],
            None,
            false,
            false,
        )?;
        if status != 200
            || !(content_type.contains("text/csv") || content_type.contains("application/csv"))
        {
            return Err(protocol(false, "Participant export did not return CSV."));
        }
        Ok(bytes)
    }
    /// Download the fixed owner-invite CSV endpoint, preserving bytes and media type.
    pub fn invite_export(&self, conversation: &str) -> Result<(String, Vec<u8>)> {
        if conversation.is_empty()
            || conversation.len() > 300
            || !conversation.bytes().all(|b| b.is_ascii_alphanumeric())
        {
            return Err(Error::input("Invalid conversation ID."));
        }
        let (status, kind, bytes) = self.exchange(
            "GET",
            "/api/v3/treevite/invites/csv",
            &[("conversation_id".into(), conversation.into())],
            None,
            false,
            false,
        )?;
        if status != 200
            || !kind
                .split(';')
                .next()
                .is_some_and(|s| s.trim().eq_ignore_ascii_case("text/csv"))
        {
            return Err(protocol(false, "Invite export did not return CSV."));
        }
        Ok((kind, bytes))
    }
    fn exchange(
        &self,
        method: &str,
        path: &str,
        query: &[(String, String)],
        body: Option<Value>,
        effect: bool,
        decode_math_gzip: bool,
    ) -> Result<(u16, String, Vec<u8>)> {
        let url = check_request(&self.base, method, path, query, body.as_ref())?;
        let method = Method::from_bytes(method.as_bytes())
            .map_err(|_| Error::input("Invalid HTTP method."))?;
        let mut request = self
            .http
            .request(method, url)
            .query(query)
            .header("Accept", "application/json")
            .header("User-Agent", "polis-cli/0.1.0");
        if let Some(token) = &self.token {
            request = request.bearer_auth(token);
        }
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request
            .send()
            .map_err(|e| transport(effect, e.is_connect()))?;
        let status = response.status().as_u16();
        let content_type = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_owned();
        let request_id = response
            .headers()
            .get("x-request-id")
            .and_then(|v| v.to_str().ok())
            // Correlation metadata is untrusted too: never reflect bearer values.
            .filter(|v| {
                !v.is_empty()
                    && v.len() <= 128
                    && v.bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
                    && !self
                        .token
                        .as_ref()
                        .is_some_and(|token| !token.is_empty() && v.contains(token))
            })
            .map(str::to_owned);
        let encoding = response
            .headers()
            .get("content-encoding")
            .map(|v| v.to_str().unwrap_or("invalid").trim().to_ascii_lowercase());
        let mut bytes = Vec::new();
        response
            .take(MAX_BODY + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| transport(effect, false))?;
        if bytes.len() as u64 > MAX_BODY {
            return Err(protocol(effect, "Response exceeds the 8 MiB limit."));
        }
        if decode_math_gzip {
            match encoding.as_deref() {
                None | Some("identity") => {}
                Some("gzip") => {
                    let mut decoded = Vec::new();
                    flate2::read::MultiGzDecoder::new(bytes.as_slice())
                        .take(MAX_BODY + 1)
                        .read_to_end(&mut decoded)
                        .map_err(|_| {
                            protocol(false, "Math response has invalid or truncated gzip.")
                        })?;
                    if decoded.len() as u64 > MAX_BODY {
                        return Err(protocol(
                            false,
                            "Decoded math response exceeds the 8 MiB limit.",
                        ));
                    }
                    bytes = decoded;
                }
                _ => {
                    return Err(protocol(
                        false,
                        "Math response uses an unsupported content encoding.",
                    ))
                }
            }
        }
        let data = serde_json::from_slice::<Value>(&bytes).ok().or_else(|| {
            std::str::from_utf8(&bytes).ok().and_then(|text| {
                polis_contracts::upstream::known(text.trim()).map(|code| json!(code))
            })
        });
        let upstream_code = data.as_ref().and_then(polis_contracts::upstream::code_from);
        if !(200..300).contains(&status)
            || upstream_code.is_some()
            || data.as_ref().is_some_and(has_error)
        {
            let (code, action, exit) = match status {
                401 => ("auth_invalid", "Run polis auth login for this site.", 3),
                403 => (
                    "forbidden",
                    "Check this account's permission for the resource.",
                    4,
                ),
                409 => (
                    "conflict",
                    "Read the resource before attempting another change.",
                    5,
                ),
                429 => (
                    "rate_limited",
                    "Wait before trying again; no automatic retry was made.",
                    6,
                ),
                304 => (
                    "not_modified",
                    "No representation returned. Request again without conditional headers.",
                    1,
                ),
                // The site may have stored a write before redirecting.
                300..=399 if effect => (
                    "redirect_outcome_unknown",
                    "Read back before retrying; the site may have stored this change before redirecting. The redirect was not followed and credentials were not forwarded.",
                    7,
                ),
                300..=399 => (
                    "redirect_refused",
                    "Check the site's configured API origin; credentials were not forwarded.",
                    1,
                ),
                500..=599 => (
                    "server_error",
                    "Check site health. Read back any attempted change before retrying.",
                    6,
                ),
                _ => (
                    "operation_failed",
                    "Check the request and resource; read back attempted changes before retrying.",
                    1,
                ),
            };
            // Do not echo arbitrary upstream error bodies: they can contain submitted secrets.
            let mut err = Error::new(
                code,
                format!("Site returned HTTP {status}; operation did not report success."),
                action,
                exit,
            );
            err.upstream = json!({"status":status,"request_id":request_id});
            if let Some(code) = upstream_code {
                let advice = polis_contracts::upstream::guidance(code);
                err.code = advice.code;
                err.message = advice.message.into();
                err.action = advice.action;
                err.upstream["code"] = json!(advice.upstream_code);
            }
            let redirect = (300..400).contains(&status) && status != 304;
            err.outcome = if effect && (status >= 500 || (200..300).contains(&status) || redirect) {
                err.exit = 7;
                "unknown"
            } else {
                "rejected"
            };
            return Err(err);
        }
        Ok((status, content_type, bytes))
    }
}
fn has_error(v: &Value) -> bool {
    v.get("ok") == Some(&Value::Bool(false))
        || v.get("success") == Some(&Value::Bool(false))
        || v.get("error")
            .is_some_and(|x| !x.is_null() && x != false && x != "")
        || v.get("status")
            .and_then(Value::as_str)
            .is_some_and(|x| x == "error" || x == "failed")
        || v.as_str().is_some_and(|x| x.starts_with("polis_err_"))
}
fn transport(effect: bool, not_sent: bool) -> Error {
    let unknown = effect && !not_sent;
    let mut e = Error::new(
        if unknown {
            "outcome_unknown"
        } else {
            "transport_unavailable"
        },
        "Could not complete the HTTP exchange.",
        "Check the site URL and connectivity. Read back attempted changes before retrying.",
        if unknown { 7 } else { 6 },
    );
    e.outcome = if unknown { "unknown" } else { "not_sent" };
    e
}
fn protocol(effect: bool, message: &str) -> Error {
    let mut e = Error::new(
        "invalid_response",
        message,
        "Check site compatibility. Read back attempted changes before retrying.",
        if effect { 7 } else { 1 },
    );
    e.outcome = if effect { "unknown" } else { "rejected" };
    e
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::net::TcpListener;

    fn response(status: u16, body: &str, effect: bool) -> Error {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let text = body.to_owned();
        let thread = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut buf = [0; 8192];
            assert!(socket.read(&mut buf).unwrap() > 0);
            write!(socket,"HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{text}",text.len()).unwrap();
        });
        let result = Client::new(&base, None, 5).unwrap().request(
            "GET",
            "/api/v3/example",
            &[],
            None,
            effect,
        );
        thread.join().unwrap();
        result.unwrap_err()
    }

    #[test]
    fn narrative_errors_have_recovery_actions_and_safe_codes() {
        for (code, kind, action) in [
            (
                "STALE_NARRATIVE_INPUTS",
                "stale_narrative_inputs",
                "Export fresh",
            ),
            ("IMPORT_CONFLICT", "narrative_conflict", "View the existing"),
            (
                "INVALID_NARRATIVE",
                "invalid_narrative",
                "result.schema.json",
            ),
            ("OWNER_REQUIRED", "owner_required", "conversation owner"),
            (
                "NARRATIVE_INPUTS_UNAVAILABLE",
                "narrative_inputs_unavailable",
                "private input service",
            ),
        ] {
            let err = response(
                409,
                &json!({"status":"error","code":code,"message":"private-bearer-value"}).to_string(),
                true,
            );
            assert_eq!(err.code, kind);
            assert_eq!(err.upstream["code"], code);
            assert!(err.action.contains(action));
            assert!(!serde_json::to_string(&err)
                .unwrap()
                .contains("private-bearer-value"));
            assert_eq!(err.outcome, "rejected");
        }
    }

    #[test]
    fn success_status_with_error_is_not_success_or_safe_to_retry() {
        for body in [
            r#"{"error":"polis_err_conversation_is_closed"}"#,
            r#"{"code":"polis_err_conversation_is_closed"}"#,
            "polis_err_conversation_is_closed",
        ] {
            let err = response(200, body, true);
            assert_eq!(err.code, "conversation_closed");
            assert_eq!(err.outcome, "unknown");
            assert_eq!(err.exit, 7);
            assert!(!err.retryable);
        }
    }

    #[test]
    fn opaque_error_keeps_http_fallback_without_leaking_body() {
        let err = response(
            503,
            r#"{"code":"private-secret","error":{"detail":"private-secret"}}"#,
            true,
        );
        assert_eq!(err.code, "server_error");
        assert_eq!(err.outcome, "unknown");
        assert!(!serde_json::to_string(&err)
            .unwrap()
            .contains("private-secret"));
    }
}

#[cfg(test)]
mod math_gzip_tests {
    use super::*;
    use std::{io::Write, net::TcpListener};
    fn gzip(bytes: &[u8]) -> Vec<u8> {
        let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        enc.write_all(bytes).unwrap();
        enc.finish().unwrap()
    }
    fn read(body: Vec<u8>, encoding: Option<&str>, math: bool) -> Result<Value> {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", l.local_addr().unwrap());
        let enc = encoding
            .map(|v| format!("Content-Encoding: {v}\r\n"))
            .unwrap_or_default();
        let t = std::thread::spawn(move || {
            let (mut s, _) = l.accept().unwrap();
            s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut buf = [0; 8192];
            assert!(s.read(&mut buf).unwrap() > 0);
            let head=format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n{enc}Content-Length: {}\r\nConnection: close\r\n\r\n",body.len());
            // A bounded client can close while an oversized body is still sent.
            let _ = s
                .write_all(head.as_bytes())
                .and_then(|_| s.write_all(&body));
        });
        let c = Client::new(&url, None, 5).unwrap();
        let result = if math {
            c.math_presentation(&[])
        } else {
            c.request("GET", "/api/v3/math/pca2", &[], None, false)
        };
        t.join().unwrap();
        result
    }
    #[test]
    fn typed_math_decodes_gzip_without_changing_raw_api() {
        let v = br#"{"math_tick":0,"pca":{"center":[0.125,-0.25]}}"#;
        assert_eq!(read(gzip(v), Some("gzip"), true).unwrap()["math_tick"], 0);
        assert_eq!(read(v.to_vec(), None, true).unwrap()["math_tick"], 0);
        assert_eq!(
            read(v.to_vec(), Some("identity"), true).unwrap()["math_tick"],
            0
        );
        assert_eq!(
            read(gzip(v), Some("gzip"), false).unwrap_err().code,
            "invalid_response"
        );
    }
    #[test]
    fn gzip_crc_truncation_and_unsupported_encoding_fail_closed() {
        let v = br#"{"math_tick":0}"#;
        let mut bad = gzip(v);
        let n = bad.len();
        bad[n - 8] ^= 1;
        for bytes in [b"invalid".to_vec(), gzip(v)[..8].to_vec(), bad] {
            assert_eq!(
                read(bytes, Some("gzip"), true).unwrap_err().code,
                "invalid_response"
            );
        }
        for enc in ["br", "gzip, gzip", "invalid"] {
            assert_eq!(
                read(v.to_vec(), Some(enc), true).unwrap_err().code,
                "invalid_response"
            );
        }
    }
    #[test]
    fn encoded_and_decoded_size_limits_apply_independently() {
        let bytes = vec![b' '; MAX_BODY as usize + 1];
        assert!(read(bytes.clone(), None, true)
            .unwrap_err()
            .message
            .contains("8 MiB"));
        assert!(read(gzip(&bytes), Some("gzip"), true)
            .unwrap_err()
            .message
            .contains("Decoded"));
    }
    #[test]
    fn gzip_multiple_members_cannot_hide_trailing_junk() {
        let mut bytes = gzip(br#"{"math_tick":0}"#);
        bytes.extend(gzip(b"junk"));
        assert_eq!(
            read(bytes, Some("gzip"), true).unwrap_err().code,
            "invalid_response"
        );
        let mut bytes = gzip(br#"{"math_tick":0}"#);
        bytes.extend(b"junk");
        assert_eq!(
            read(bytes, Some("gzip"), true).unwrap_err().code,
            "invalid_response"
        );
    }
}

#[cfg(test)]
mod document_scope_tests {
    use super::*;
    #[test]
    fn public_document_whitelist_rejects_escapes_before_network() {
        let c = Client::new("http://127.0.0.1:9", Some("generated-token".into()), 1).unwrap();
        for path in [
            "//example.invalid/feeds/rabc",
            "/feeds/../users",
            "/feeds/rabc?token=x",
            "/feeds/rabc/other",
            "/api/v3/users",
            "/feeds/%2e%2e/topics",
        ] {
            assert_eq!(c.public_document(path).unwrap_err().exit, 2, "{path}");
        }
    }
}
