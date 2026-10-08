//! `GET /api/v3/math/pca2`, reproduced through the same middleware chain the
//! Node server runs it behind (`server/app.ts`):
//!
//! `redirectIfNotHttps` -> `bodyParser` -> `writeDefaultHead` -> `compress`
//! -> `addCorsHeader` -> `middleware_check_if_options` -> `moveToBody` ->
//! `redirectIfHasZidButNoConversationId` -> `need("conversation_id")` ->
//! `want("math_tick")` -> `want("keys")` -> `wantHeader("If-None-Match")` ->
//! `handle_GET_math_pca2` (`server/src/routes/math.ts`).
//!
//! Express 3's `res.send`/`res.json`, its weak ETag and freshness check, the
//! `compression` middleware's header hook and connect's final error handler
//! are emulated in [`Res`] and the functions below it, because each of them
//! decides headers or bytes on this route.

use crate::{
    compress,
    config::Config,
    cors::Cors,
    db::{self, Pool},
    http::{Body, Outgoing, Request},
    js::{self, Js, Obj, number_to_string},
    lru::Lru,
    negotiate::{self, Coding},
    params,
    pca::Pca,
};
use base64::Engine;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicU64, Ordering},
};

pub const PATH: &str = "/api/v3/math/pca2";

pub struct App {
    pub math_env: String,
    pub dev_mode: bool,
    pub use_network_host: bool,
    pub production: bool,
    pub cors: Cors,
    pub db: Arc<Pool>,
    pub pca: Pca,
    /// `conversationIdToZidCache` (conversation.ts), 1000 entries.
    zids: Mutex<Lru<String, i32>>,
    pub served: AtomicU64,
    pub failed: AtomicU64,
    /// `Config.ddEnv || "prod"`, as the server's request log labels itself.
    dd_env: String,
}

impl App {
    pub fn new(cfg: &Config, db: Arc<Pool>) -> Self {
        Self {
            math_env: cfg.math_env.clone(),
            dev_mode: cfg.dev_mode,
            use_network_host: cfg.use_network_host,
            production: cfg.production,
            cors: Cors::from_env(),
            pca: Pca::new(db.clone(), cfg.math_env.clone(), cfg.cache_size),
            db,
            zids: Mutex::new(Lru::new(1000)),
            served: AtomicU64::new(0),
            failed: AtomicU64::new(0),
            dd_env: std::env::var("DD_ENV")
                .ok()
                .filter(|v| !v.is_empty())
                .unwrap_or_else(|| "prod".into()),
        }
    }
}

// ------------------------------------------------------- Express emulation

/// The headers a Node `ServerResponse` holds, in Node's order: a header keeps
/// the position of its first `setHeader` and the casing of its last.
struct Res {
    status: u16,
    headers: Vec<(String, String)>,
}

impl Res {
    fn new(status: u16) -> Self {
        Self {
            status,
            headers: Vec::new(),
        }
    }

    fn set(&mut self, name: &str, value: impl Into<String>) {
        let value = value.into();
        match self
            .headers
            .iter_mut()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
        {
            Some(slot) => *slot = (name.to_string(), value),
            None => self.headers.push((name.to_string(), value)),
        }
    }

    fn get(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    fn remove(&mut self, name: &str) {
        self.headers.retain(|(k, _)| !k.eq_ignore_ascii_case(name));
    }
}

/// `writeDefaultHead` (domain.ts) followed by `addCorsHeader`'s headers.
fn default_head(origin: Option<&str>) -> Res {
    let mut res = Res::new(200);
    res.set("Content-Type", "application/json");
    res.set("Cache-Control", "no-cache");
    res.set("Connection", "keep-alive");
    if let Some(origin) = origin {
        res.set("Access-Control-Allow-Origin", origin);
        res.set("Access-Control-Allow-Credentials", "true");
        res.set(
            "Access-Control-Allow-Headers",
            "Cache-Control, Pragma, Origin, Authorization, Content-Type, X-Requested-With",
        );
        res.set(
            "Access-Control-Allow-Methods",
            "GET, PUT, POST, DELETE, OPTIONS",
        );
    }
    res
}

/// Express 3 `utils.wetag` over `etag@1.7.0`: weak, length in hex, MD5 in
/// unpadded base64.
fn weak_etag(body: &[u8]) -> String {
    let digest = base64::engine::general_purpose::STANDARD_NO_PAD.encode(md5::compute(body).0);
    format!("W/\"{:x}-{}\"", body.len(), digest)
}

/// `utils.setCharset(type, "utf-8")`: content-type's parse and format.
fn with_utf8_charset(content_type: &str) -> String {
    let mut parts = content_type.split(';');
    let base = parts.next().unwrap_or_default().trim().to_ascii_lowercase();
    let mut params: Vec<(String, String)> = parts
        .filter_map(|p| {
            let (k, v) = p.split_once('=')?;
            Some((
                k.trim().to_ascii_lowercase(),
                v.trim().trim_matches('"').to_string(),
            ))
        })
        .filter(|(k, _)| k != "charset")
        .collect();
    params.push(("charset".into(), "utf-8".into()));
    params.sort();
    let mut out = base;
    for (k, v) in params {
        out.push_str(&format!("; {k}={v}"));
    }
    out
}

/// The `compressible` check the compression middleware's filter applies.
fn compressible(content_type: &str) -> bool {
    let media = content_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    media.starts_with("text/")
        || media == "application/json"
        || media.ends_with("+json")
        || media.ends_with("+text")
        || media.ends_with("+xml")
        || media == "application/javascript"
        || media == "application/xml"
}

/// JavaScript `Number(header)`; `Number(undefined)` is NaN.
fn number(value: Option<&str>) -> f64 {
    value.map_or(f64::NAN, js::string_to_number)
}

enum Ending {
    /// `res.end(chunk)` with no earlier `writeHead`.
    End(Vec<u8>),
    /// `res.writeHead(status, headers)` and then `res.end()`.
    WriteHeadThenEnd,
}

/// The compression middleware's `onHeaders` hook (`compression@1.5.2`, the
/// copy connect resolves), then Node's framing. `installed` is false for the
/// responses sent before `express.compress()` is in the chain.
fn finish(req: &Request, mut res: Res, ending: Ending, installed: bool) -> Outgoing {
    let (chunk, length) = match &ending {
        Ending::End(chunk) => {
            let estimate = res.get("Content-Length").is_none().then_some(chunk.len());
            (chunk.clone(), estimate)
        }
        Ending::WriteHeadThenEnd => (Vec::new(), None),
    };
    let mut coding = Coding::Identity;
    if installed && res.get("Content-Type").is_some_and(compressible) {
        match res.get("Vary") {
            None => res.set("Vary", "Accept-Encoding"),
            Some(v)
                if v.split(',').any(|f| {
                    f.trim() == "*" || f.trim().eq_ignore_ascii_case("accept-encoding")
                }) => {}
            Some(v) => {
                let joined = format!("{v}, Accept-Encoding");
                res.set("Vary", joined);
            }
        }
        let below = number(res.get("Content-Length")) < 1024.0 || length.is_some_and(|l| l < 1024);
        let encoded = res.get("Content-Encoding").is_some_and(|e| e != "identity");
        if !below && !encoded && req.method != "HEAD" {
            coding = negotiate::encoding(req.headers.get("accept-encoding"));
            if coding != Coding::Identity {
                res.set(
                    "Content-Encoding",
                    if coding == Coding::Gzip {
                        "gzip"
                    } else {
                        "deflate"
                    },
                );
                res.remove("Content-Length");
            }
        }
    }
    let compressed = match coding {
        Coding::Identity => None,
        Coding::Gzip => compress::node_stream(&chunk, true).ok(),
        Coding::Deflate => compress::node_stream(&chunk, false).ok(),
    };
    let body = match (compressed, ending) {
        (Some(chunks), _) => Body::Chunked(chunks),
        (None, Ending::WriteHeadThenEnd) => Body::Chunked(Vec::new()),
        (None, Ending::End(chunk)) if res.get("Content-Length").is_some() => Body::Fixed(chunk),
        (None, Ending::End(chunk)) if chunk.is_empty() => Body::Empty,
        (None, Ending::End(chunk)) => {
            // Node measures a lone `res.end(chunk)` itself.
            res.set("Content-Length", chunk.len().to_string());
            Body::Fixed(chunk)
        }
    };
    Outgoing {
        status: res.status,
        headers: res.headers,
        body,
        close: false,
    }
}

/// `fresh@0.3.0` as Express 3's `req.fresh` calls it.
fn fresh(req: &Request, res: &Res) -> bool {
    if req.method != "GET" && req.method != "HEAD" {
        return false;
    }
    if !((200..300).contains(&res.status) || res.status == 304) {
        return false;
    }
    let since = req
        .headers
        .get("if-modified-since")
        .filter(|v| !v.is_empty());
    let none_match = req.headers.get("if-none-match").filter(|v| !v.is_empty());
    if since.is_none() && none_match.is_none() {
        return false;
    }
    if req
        .headers
        .get("cache-control")
        .is_some_and(|cc| cc.contains("no-cache"))
    {
        return false;
    }
    let mut etag_matches = true;
    if let Some(none_match) = none_match {
        let etag = res.get("ETag");
        let weak = format!("W/{}", etag.unwrap_or("undefined"));
        // `noneMatch.split(/ *, */)`: spaces around each comma only.
        let parts: Vec<&str> = none_match.split(',').collect();
        let last = parts.len() - 1;
        etag_matches = parts.iter().enumerate().any(|(i, p)| {
            let p = if i > 0 { p.trim_start_matches(' ') } else { p };
            let p = if i < last { p.trim_end_matches(' ') } else { p };
            p == "*" || Some(p) == etag || p == weak
        });
    }
    // With If-Modified-Since, `new Date(undefined) <= since` is false: this
    // route never sets Last-Modified, so such a request is never fresh.
    etag_matches && since.is_none()
}

enum Payload {
    Text(String),
    Bytes(Vec<u8>),
}

/// Express 3 `res.send(body)`, with the compression middleware installed.
fn send(req: &Request, res: Res, payload: Payload) -> Outgoing {
    send_in(req, res, payload, true)
}

/// Express 3 `res.send(body)`; `installed` as in [`finish`].
fn send_in(req: &Request, mut res: Res, payload: Payload, installed: bool) -> Outgoing {
    let bytes = match payload {
        Payload::Text(text) => {
            if res.get("Content-Type").is_none() {
                res.set("Content-Type", "text/html; charset=utf-8");
            }
            if let Some(t) = res.get("Content-Type") {
                let t = with_utf8_charset(t);
                res.set("Content-Type", t);
            }
            text.into_bytes()
        }
        Payload::Bytes(bytes) => {
            if res.get("Content-Type").is_none() {
                res.set("Content-Type", "application/octet-stream");
            }
            bytes
        }
    };
    if res.get("Content-Length").is_none() {
        res.set("Content-Length", bytes.len().to_string());
    }
    if res.get("ETag").is_none() {
        res.set("ETag", weak_etag(&bytes));
    }
    if fresh(req, &res) {
        res.status = 304;
    }
    let bytes = if res.status == 204 || res.status == 304 {
        res.remove("Content-Type");
        res.remove("Content-Length");
        res.remove("Transfer-Encoding");
        Vec::new()
    } else {
        bytes
    };
    finish(req, res, Ending::End(bytes), installed)
}

/// Express 3 `res.json(value)`.
fn json(req: &Request, mut res: Res, value: &Js) -> Outgoing {
    if res.get("Content-Type").is_none() {
        res.set("Content-Type", "application/json");
    }
    send(req, res, Payload::Text(js::stringify(value)))
}

/// `failJson(res, status, message)` (utils/fail.ts).
fn fail_json(req: &Request, mut res: Res, status: u16, message: Js) -> Outgoing {
    let mut body = Obj::new();
    body.set("error", message.clone());
    body.set("message", message);
    body.set("status", Js::Num(f64::from(status)));
    res.status = status;
    json(req, res, &Js::Obj(body))
}

/// escape-html.
fn escape_html(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

/// connect's `finalhandler@0.4.0` answering `next(err)` (`err` a string) or,
/// with `err` absent, the 404 for an unmatched route.
fn final_handler(
    app: &App,
    req: &Request,
    mut res: Res,
    err: Option<&str>,
    installed: bool,
) -> Outgoing {
    let (status, msg) = match err {
        Some(err) => {
            let status = if res.status < 400 { 500 } else { res.status };
            let text = if app.production {
                crate::http::reason_text(status).to_string()
            } else {
                err.to_string()
            };
            (
                status,
                format!(
                    "{}\n",
                    escape_html(&text)
                        .replace('\n', "<br>")
                        .replace("  ", " &nbsp;")
                ),
            )
        }
        None => (
            404,
            format!(
                "Cannot {} {}\n",
                escape_html(&req.method),
                escape_html(&req.target)
            ),
        ),
    };
    res.status = status;
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Content-Type", "text/html; charset=utf-8");
    res.set("Content-Length", msg.len().to_string());
    finish(req, res, Ending::End(msg.into_bytes()), installed)
}

/// `need`/`want` parse failure text, `polis_err_param_parse_failed_<name>`.
fn parse_failed(name: &str, val: &Js, err: &str) -> String {
    format!(
        "polis_err_param_parse_failed_{name} (val='{}', error={err})",
        val.to_js_string()
    )
}

/// UTF-16 length, which is what a JavaScript string's `.length` counts.
fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `getStringLimitLength(min, max)` after its checks: leading and trailing
/// spaces (only spaces) removed.
fn strip_spaces(s: &str) -> String {
    s.trim_matches(' ').to_string()
}

/// JavaScript `String.prototype.trim`.
fn js_trim(s: &str) -> &str {
    s.trim_matches(js::is_js_whitespace)
}

/// `_integerOrUndefined` + `getInt` (utils/parameter.ts).
fn get_int(value: &Js) -> Option<f64> {
    match value {
        Js::Str(s) if !js_trim(s).is_empty() => {
            // parseInt(s, 10): optional sign, then the longest digit prefix.
            let t = js_trim(s);
            let (sign, rest) = match t.as_bytes()[0] {
                b'-' => (-1.0, &t[1..]),
                b'+' => (1.0, &t[1..]),
                _ => (1.0, t),
            };
            let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
            if digits.is_empty() {
                return None;
            }
            digits.parse::<f64>().ok().map(|n| sign * n)
        }
        Js::Num(n) if n.is_finite() && n.fract() == 0.0 => Some(*n),
        _ => None,
    }
}

/// `encodeURIComponent`.
fn encode_uri_component(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// `pca2EntityTag(mathTick)` (routes/math.ts): the served label and the
/// generation, e.g. `"python-57"`.
fn entity_tag(math_env: &str, math_tick: f64) -> String {
    format!(
        "\"{}-{}\"",
        encode_uri_component(math_env),
        number_to_string(math_tick)
    )
}

/// Property names `key in obj` finds on `Object.prototype`. `_.pick` copies
/// them, but their values are functions (or the prototype itself, for
/// `__proto__`), which `JSON.stringify` never prints.
const PROTOTYPE_KEYS: [&str; 12] = [
    "constructor",
    "__defineGetter__",
    "__defineSetter__",
    "hasOwnProperty",
    "__lookupGetter__",
    "__lookupSetter__",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toString",
    "valueOf",
    "__proto__",
    "toLocaleString",
];

fn flatten_into(out: &mut Vec<String>, v: &Js) {
    match v {
        Js::Arr(items) => items.iter().for_each(|i| flatten_into(out, i)),
        other => out.push(other.to_js_string()),
    }
}

/// `_.pick(pojo, keys)` (underscore 1.13.7), as JSON would print it.
fn pick(pojo: &Obj, keys: &[Js]) -> Obj {
    let mut names = Vec::new();
    keys.iter().for_each(|k| flatten_into(&mut names, k));
    let mut out = Obj::new();
    for name in names {
        // An own `__proto__` goes through the prototype setter, never onto
        // the result.
        if name == "__proto__" {
            continue;
        }
        if let Some(v) = pojo.get(&name) {
            out.set(&name, v.clone());
        } else if PROTOTYPE_KEYS.contains(&name.as_str()) {
            // Present via the prototype, printed as nothing.
        }
    }
    out
}

// ----------------------------------------------------------------- route

fn host(req: &Request) -> &str {
    req.headers.get("host").unwrap_or("undefined")
}

/// A 502 that nginx turns into the Node server's answer
/// (`proxy_intercept_errors` with `error_page 502`). Also the answer for a
/// request path this process does not serve: nginx forwards the raw URI, so
/// a path nginx normalised to the route (`//`, `%70ca2`) arrives here
/// unnormalised and goes back to Node, which answers it as it always has.
pub fn bad_gateway() -> Outgoing {
    let bytes = b"Bad Gateway\n".to_vec();
    Outgoing {
        status: 502,
        headers: vec![
            ("Content-Type".into(), "text/plain; charset=utf-8".into()),
            ("Content-Length".into(), bytes.len().to_string()),
        ],
        body: Body::Fixed(bytes),
        close: false,
    }
}

pub async fn handle(app: Arc<App>, req: Request) -> Outgoing {
    let started = std::time::Instant::now();
    let (out, cache) = crate::pca::CACHE_OUTCOME
        .scope(std::cell::Cell::new("none"), async {
            let out = serve(&app, &req).await;
            (out, crate::pca::CACHE_OUTCOME.with(std::cell::Cell::get))
        })
        .await;
    if out.status >= 500 {
        app.failed.fetch_add(1, Ordering::Relaxed);
    } else {
        app.served.fetch_add(1, Ordering::Relaxed);
    }
    access_log(&app, &req, out.status, started.elapsed(), cache);
    out
}

/// One line per request, in the shape family of the Node server's
/// `http_request` log (`middleware_http_json_logger`). The path only: no
/// query string, no headers, nothing a credential could ride in.
fn access_log(app: &App, req: &Request, status: u16, took: std::time::Duration, cache: &str) {
    let level = match status {
        500.. => "error",
        400.. => "warn",
        _ => "info",
    };
    let mut http = Obj::new();
    http.set("method", Js::Str(req.method.clone()));
    http.set("url", Js::Str(req.path().to_string()));
    http.set("route", Js::Str(PATH.into()));
    http.set("status_code", Js::Num(f64::from(status)));
    let mut line = Obj::new();
    line.set("level", Js::Str(level.into()));
    line.set("message", Js::Str("http_request".into()));
    line.set("service", Js::Str("polis-api".into()));
    line.set("env", Js::Str(app.dd_env.clone()));
    line.set("http", Js::Obj(http));
    line.set(
        "duration_ms",
        Js::Num((took.as_secs_f64() * 1000.0 * 1000.0).round() / 1000.0),
    );
    line.set("cache", Js::Str(cache.into()));
    println!("{}", js::stringify(&Js::Obj(line)));
}

async fn serve(app: &App, req: &Request) -> Outgoing {
    // redirectIfNotHttps (domain.ts), ahead of every other middleware.
    if !app.dev_mode && req.path() != "/api/v3/testConnection" && !app.use_network_host {
        let https = req.headers.get("x-forwarded-proto") == Some("https");
        if !https {
            if req.method == "GET" {
                let mut res = Res::new(302);
                res.set("Location", format!("https://{}{}", host(req), req.target));
                return finish(req, res, Ending::WriteHeadThenEnd, false);
            }
            // Node sends this, then keeps running the chain against a
            // finished response and ends up destroying the socket. It runs
            // before `express.compress()`, so no `Vary` is added.
            let mut out = send_in(
                req,
                Res::new(400),
                Payload::Text("Please use HTTPS when submitting data.".into()),
                false,
            );
            out.close = true;
            return out;
        }
    }
    // bodyParser: a body it cannot parse is answered before writeDefaultHead.
    let has_body = req.headers.get("transfer-encoding").is_some()
        || req
            .headers
            .get("content-length")
            .is_some_and(|v| !js::string_to_number(v).is_nan());
    if has_body
        && !params::body_is_modelled(
            req.headers.get("content-type"),
            req.headers.get("content-encoding"),
        )
    {
        return bad_gateway();
    }
    let body = match params::parse_body(req.headers.get("content-type"), has_body, &req.body) {
        params::Body::Parsed(v) => v,
        params::Body::Invalid => {
            let mut res = Res::new(400);
            let msg = "Bad Request\n".to_string();
            res.set("X-Content-Type-Options", "nosniff");
            res.set("Content-Type", "text/html; charset=utf-8");
            res.set("Content-Length", msg.len().to_string());
            return finish(req, res, Ending::End(msg.into_bytes()), false);
        }
    };
    // writeDefaultHead, compress, addCorsHeader.
    let origin = match app.cors.resolve(&req.headers) {
        Ok(origin) => origin,
        Err(refusal) => {
            let err = format!("unauthorized domain: {}", refusal.origin);
            return final_handler(app, req, default_head(None), Some(&err), true);
        }
    };
    let res = default_head(origin.as_deref());
    // middleware_check_if_options: `res.send(204)`.
    if req.method.eq_ignore_ascii_case("options") {
        let mut res = res;
        res.status = 204;
        return send(req, res, Payload::Text("No Content".into()));
    }
    if req.method != "GET" && req.method != "HEAD" {
        return final_handler(app, req, res, None, true);
    }
    match pca2(app, req, &body, res).await {
        Ok(out) => out,
        Err(e) if db::is_unavailable(&e) => {
            eprintln!(
                "{{\"event\":\"pca2_database_unavailable\",\"detail\":{:?}}}",
                format!("{e:#}")
            );
            bad_gateway()
        }
        Err(e) => {
            eprintln!(
                "{{\"event\":\"pca2_failed\",\"detail\":{:?}}}",
                format!("{e:#}")
            );
            // failJson(res, 500, err) with an Error object: it prints as {}.
            let res = default_head(origin.as_deref());
            fail_json(req, res, 500, Js::Obj(Obj::new()))
        }
    }
}

async fn pca2(app: &App, req: &Request, body: &Js, mut res: Res) -> anyhow::Result<Outgoing> {
    // moveToBody
    let p = params::merged(body, &params::parse_query(req.query().unwrap_or_default()));
    let truthy = |k: &str| p.get(k).is_some_and(Js::truthy);
    // redirectIfHasZidButNoConversationId
    if truthy("zid") && !truthy("conversation_id") {
        let protocol = req
            .headers
            .get("x-forwarded-proto")
            .filter(|v| !v.is_empty())
            .unwrap_or("http");
        res.status = 302;
        res.set("Location", format!("{protocol}://{}/about", host(req)));
        return Ok(finish(req, res, Ending::WriteHeadThenEnd, true));
    }
    let present = |k: &str| p.get(k).filter(|v| !matches!(v, Js::Null));
    let reject = |res: Res, msg: String| {
        let mut res = res;
        res.status = 400;
        Ok(final_handler(app, req, res, Some(&msg), true))
    };
    // need("conversation_id", getConversationIdFetchZid)
    let Some(cid) = present("conversation_id") else {
        return reject(res, "polis_err_param_missing_conversation_id".into());
    };
    let conversation_id = match cid {
        Js::Str(s) if js_len(s) > 100 => {
            return reject(
                res,
                parse_failed("conversation_id", cid, "polis_fail_parse_string_too_long"),
            );
        }
        Js::Str(s) => strip_spaces(s),
        _ => {
            return reject(
                res,
                parse_failed("conversation_id", cid, "polis_fail_parse_string_missing"),
            );
        }
    };
    let cached = app
        .zids
        .lock()
        .map_err(|_| anyhow::anyhow!("zid cache lock"))?
        .get(&conversation_id);
    let zid = match cached {
        Some(zid) => zid,
        None => {
            let key = conversation_id.clone();
            match app
                .db
                .with(move |c| db::zid_for_conversation_id(c, &key))
                .await
            {
                Ok(Some(zid)) => {
                    app.zids
                        .lock()
                        .map_err(|_| anyhow::anyhow!("zid cache lock"))?
                        .set(conversation_id, zid);
                    zid
                }
                Ok(None) => {
                    return reject(
                        res,
                        parse_failed(
                            "conversation_id",
                            cid,
                            "polis_err_fetching_zid_for_conversation_id",
                        ),
                    );
                }
                // A database failure is not the client's fault: 502, so nginx
                // asks Node.
                Err(e) => return Err(e),
            }
        }
    };
    // want("math_tick", getInt)
    let math_tick = match present("math_tick") {
        None => None,
        Some(v) => match get_int(v) {
            Some(n) => Some(n),
            None => {
                let err = format!("polis_fail_parse_int {}", v.to_js_string());
                return reject(res, parse_failed("math_tick", v, &err));
            }
        },
    };
    // want("keys", getArrayOfString)
    let keys: Vec<Js> = match present("keys") {
        None => Vec::new(),
        Some(Js::Arr(items)) => items.clone(),
        Some(Js::Str(s)) => s
            .split(',')
            .map(|k| Js::Str(js_trim(k).to_string()))
            .collect(),
        Some(v) => {
            return reject(
                res,
                parse_failed("keys", v, "polis_fail_parse_string_array"),
            );
        }
    };
    // wantHeader("If-None-Match", getStringLimitLength(1000))
    let if_none_match = match req.headers.get("if-none-match") {
        None => None,
        Some(v) if js_len(v) > 1000 => {
            let val = Js::Str(v.to_string());
            return reject(
                res,
                parse_failed("If-None-Match", &val, "polis_fail_parse_string_too_long"),
            );
        }
        Some(v) => Some(strip_spaces(v)),
    };

    // handle_GET_math_pca2
    let mut held: Option<Vec<String>> = None;
    let tick = match if_none_match.filter(|v| !v.is_empty()) {
        Some(inm) => {
            if math_tick.is_some() {
                let msg = "Expected either math_tick param or If-Not-Match header, but not both.";
                return Ok(fail_json(req, res, 400, Js::Str(msg.into())));
            }
            if inm.contains('*') {
                0.0
            } else {
                held = Some(
                    inm.split(',')
                        .map(|x| {
                            let x = js_trim(x);
                            x.strip_prefix("W/")
                                .or_else(|| x.strip_prefix("w/"))
                                .unwrap_or(x)
                                .to_string()
                        })
                        .filter(|x| !x.is_empty())
                        .collect(),
                );
                -1.0
            }
        }
        None => math_tick.unwrap_or(-1.0),
    };

    let data = app.pca.get_pca(zid, tick).await?;
    let synthesized = data.as_ref().is_some_and(|d| d.synthesized);
    let data = match data {
        Some(d) => Some(app.pca.present(zid, d).await?),
        None => None,
    };
    let etag = data
        .as_ref()
        .filter(|_| !synthesized)
        .map(|d| entity_tag(&app.math_env, d.math_tick()));
    if let (Some(etag), Some(held)) = (&etag, &held)
        && held.contains(etag)
    {
        res.set("Content-Type", "application/json");
        res.set("Etag", etag.clone());
        res.status = 304;
        return Ok(finish(req, res, Ending::End(Vec::new()), true));
    }
    let Some(data) = data else {
        if app.pca.results_exist(zid)?.is_none() {
            let exists = app.pca.get_pca(zid, -1.0).await?.is_some();
            app.pca.set_results_exist(zid, exists)?;
        }
        // Both branches of finishWith304or404 answer 304.
        res.status = 304;
        return Ok(finish(req, res, Ending::End(Vec::new()), true));
    };
    if !keys.is_empty() {
        res.set("Content-Type", "application/json");
        if let Some(etag) = etag {
            res.set("Etag", etag);
        }
        let picked = pick(&data.pojo, &keys);
        return Ok(json(req, res, &Js::Obj(picked)));
    }
    res.set("Content-Type", "application/json");
    res.set("Content-Encoding", "gzip");
    if let Some(etag) = etag {
        res.set("Etag", etag);
    }
    Ok(send(req, res, Payload::Bytes(data.gzip.clone())))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::Headers;

    fn request(method: &str, headers: &[(&str, &str)]) -> Request {
        Request {
            method: method.into(),
            target: PATH.into(),
            headers: Headers::from_raw(headers.iter().copied()),
            body: Vec::new(),
        }
    }

    #[test]
    fn weak_etags_match_express() {
        assert_eq!(weak_etag(b""), "W/\"0-1B2M2Y8AsgTpgAmY7PhCfg\"");
        assert_eq!(weak_etag(b"No Content"), "W/\"a-oQDOV50e1MN2H/N8GYi+8w\"");
    }

    #[test]
    fn freshness_follows_fresh_0_3_0() {
        let mut res = Res::new(200);
        res.set("Etag", "\"p027-1\"");
        let r = |v: &str| request("GET", &[("if-none-match", v)]);
        assert!(fresh(&r("\"p027-1\""), &res));
        assert!(fresh(&r("W/\"p027-1\""), &res));
        assert!(fresh(&r("\"x\" ,  \"p027-1\""), &res));
        assert!(fresh(&r("*"), &res));
        assert!(!fresh(&r("w/\"p027-1\""), &res));
        assert!(!fresh(&r("\"x\"\t, \"y\""), &res));
        let r = request(
            "GET",
            &[("if-none-match", "*"), ("cache-control", "no-cache")],
        );
        assert!(!fresh(&r, &res));
        let r = request(
            "GET",
            &[
                ("if-none-match", "*"),
                ("if-modified-since", "Tue, 14 Nov 2023 22:13:20 GMT"),
            ],
        );
        assert!(!fresh(&r, &res));
        assert!(!fresh(&request("POST", &[("if-none-match", "*")]), &res));
    }

    #[test]
    fn json_content_type_gains_charset_like_express() {
        assert_eq!(
            with_utf8_charset("application/json"),
            "application/json; charset=utf-8"
        );
        assert_eq!(
            with_utf8_charset("text/html; charset=UTF-8"),
            "text/html; charset=utf-8"
        );
    }

    /// An app whose database is unreachable (nothing listens on port 1).
    fn app(dev_mode: bool) -> Arc<App> {
        let cfg = Config {
            listen: String::new(),
            math_env: "p".into(),
            cache_size: 300,
            dev_mode,
            use_network_host: false,
            production: true,
            pool: crate::db::Limits {
                size: 1,
                acquire_timeout: std::time::Duration::from_millis(500),
                statement_timeout: std::time::Duration::from_millis(500),
                max_lifetime: std::time::Duration::from_secs(60),
            },
        };
        let mut pg: postgres::Config = "postgresql://u@127.0.0.1:1/d".parse().unwrap();
        pg.connect_timeout(std::time::Duration::from_secs(2));
        let pool = Pool::new(
            polis_queue_adapter::jobs::transport::Connector::Plain(Box::new(pg)),
            cfg.pool.clone(),
        );
        Arc::new(App::new(&cfg, pool))
    }

    fn header<'a>(out: &'a Outgoing, name: &str) -> Option<&'a str> {
        out.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    /// With its database unreachable the route answers 502 (nginx then asks
    /// Node), never the 400 or 500 a lookup failure would otherwise produce.
    #[tokio::test]
    async fn an_unreachable_database_is_a_502() {
        let app = app(true);
        let mut req = request("GET", &[("host", "h"), ("x-forwarded-proto", "https")]);
        req.target = format!("{PATH}?conversation_id=abc");
        let out = handle(app, req).await;
        assert_eq!(out.status, 502);
    }

    /// Plain-HTTP HEAD, OPTIONS and POST: Node's `redirectIfNotHttps` answers
    /// 400 before the compression middleware, so there is no `Vary` header.
    #[tokio::test]
    async fn the_https_refusal_is_sent_before_compression() {
        for method in ["HEAD", "OPTIONS", "POST"] {
            let out = handle(app(false), request(method, &[("host", "h")])).await;
            assert_eq!(out.status, 400, "{method}");
            assert!(out.close, "{method}");
            assert_eq!(header(&out, "Vary"), None, "{method}");
            assert_eq!(
                header(&out, "Content-Type"),
                Some("text/html; charset=utf-8"),
                "{method}"
            );
        }
        let out = handle(app(false), request("GET", &[("host", "h")])).await;
        assert_eq!(out.status, 302);
        assert_eq!(header(&out, "Location"), Some("https://h/api/v3/math/pca2"));
    }

    /// A body this process does not reproduce Node's handling of is answered
    /// 502, which nginx turns into Node's answer; a UTF-8 JSON body is not.
    #[tokio::test]
    async fn bodies_outside_the_model_go_back_to_node() {
        let https = [("host", "h"), ("x-forwarded-proto", "https")];
        let cases: [(&[(&str, &str)], u16); 5] = [
            (
                &[
                    ("content-type", "application/json"),
                    ("content-encoding", "gzip"),
                ],
                502,
            ),
            (
                &[
                    ("content-type", "application/json"),
                    ("content-encoding", "x-unknown"),
                ],
                502,
            ),
            (
                &[("content-type", "application/json; charset=iso-8859-1")],
                502,
            ),
            (&[("content-type", "multipart/form-data; boundary=x")], 502),
            (&[("content-type", "application/json; charset=utf-8")], 204),
        ];
        for (headers, want) in cases {
            let mut all: Vec<(&str, &str)> = https.to_vec();
            all.extend_from_slice(headers);
            all.push(("content-length", "2"));
            let mut req = request("OPTIONS", &all);
            req.body = b"{}".to_vec();
            let out = handle(app(true), req).await;
            assert_eq!(out.status, want, "{headers:?}");
        }
    }

    #[test]
    fn trimming_uses_javascript_whitespace() {
        assert_eq!(js_trim("\u{85}x\u{FEFF} "), "\u{85}x");
    }

    #[test]
    fn get_int_is_parse_int_on_trimmed_text() {
        assert_eq!(get_int(&Js::Str("12abc".into())), Some(12.0));
        assert_eq!(get_int(&Js::Str(" -3".into())), Some(-3.0));
        assert_eq!(get_int(&Js::Str("  ".into())), None);
        assert_eq!(get_int(&Js::Str("x1".into())), None);
        assert_eq!(get_int(&Js::Num(2.0)), Some(2.0));
        assert_eq!(get_int(&Js::Num(2.5)), None);
        assert_eq!(get_int(&Js::Arr(vec![])), None);
    }

    #[test]
    fn entity_tags_bind_label_and_generation() {
        assert_eq!(entity_tag("python", 57.0), "\"python-57\"");
        assert_eq!(entity_tag("a b/é", 0.0), "\"a%20b%2F%C3%A9-0\"");
    }

    #[test]
    fn pick_follows_underscore() {
        let pojo = js::parse(r#"{"tids":[1],"n-cmts":1,"toString":2}"#).unwrap();
        let pojo = pojo.as_obj().unwrap();
        let keys = [
            Js::Str("n-cmts".into()),
            Js::Arr(vec![Js::Str("tids".into()), Js::Str("constructor".into())]),
            Js::Str("toString".into()),
            Js::Str("__proto__".into()),
            Js::Str("tids".into()),
            Js::Str("missing".into()),
        ];
        assert_eq!(
            js::stringify(&Js::Obj(pick(pojo, &keys))),
            r#"{"n-cmts":1,"tids":[1],"toString":2}"#
        );
    }

    #[test]
    fn compression_hook_adds_vary_and_respects_threshold() {
        let req = request("GET", &[("accept-encoding", "gzip")]);
        let mut res = default_head(None);
        res.set("Content-Length", "5");
        let out = finish(&req, res, Ending::End(b"{\"a\"}".to_vec()), true);
        assert!(
            out.headers
                .iter()
                .any(|(k, v)| k == "Vary" && v == "Accept-Encoding")
        );
        assert!(matches!(out.body, Body::Fixed(_)));
        let mut res = default_head(None);
        let big = vec![b'a'; 2000];
        res.set("Content-Length", "2000");
        let out = finish(&req, res, Ending::End(big), true);
        assert!(
            out.headers
                .iter()
                .any(|(k, v)| k == "Content-Encoding" && v == "gzip")
        );
        assert!(!out.headers.iter().any(|(k, _)| k == "Content-Length"));
        assert!(matches!(out.body, Body::Chunked(_)));
    }
}
