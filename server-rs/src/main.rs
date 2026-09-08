mod cors;
mod db;
mod json;
mod model;
mod transport;
use axum::{
    Router,
    body::{Body, Bytes},
    extract::{RawQuery, State},
    http::{HeaderMap, Method, Response},
    routing::get,
};
use base64::Engine;
use cors::Cors;
use db::Pool;
use model::{MathData, PcaData, Subset};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, VecDeque},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::sync::Mutex;
type Error = Box<dyn std::error::Error + Send + Sync>;
/// A stored blob that the pinned model does not describe. The recording has no cell
/// for it, so the route refuses the request under a named code instead of guessing a
/// body; the refusal is counted and surfaced on /health rather than lost in a 500.
#[derive(Debug)]
struct ContractViolation {
    detail: String,
}
impl std::fmt::Display for ContractViolation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.detail)
    }
}
impl std::error::Error for ContractViolation {}
#[derive(Default)]
struct Metrics {
    contract_violations: AtomicU64,
}
#[derive(Clone)]
struct App {
    db: Arc<Pool>,
    math_env: String,
    cors: Arc<Cors>,
    cache: Arc<Mutex<Cache>>,
    /// `pcaResultsExistForZid` (`math.ts:29`), keyed by (math_env, zid) as Node keys it.
    results_exist: Arc<Mutex<HashMap<(String, i32), bool>>>,
    metrics: Arc<Metrics>,
}
#[derive(Default)]
struct Cache {
    entries: HashMap<(String, i32), Arc<Cached>>,
    order: VecDeque<(String, i32)>,
}
struct Cached {
    data: MathData,
    gzip: Vec<u8>,
    expires: u64,
}
fn now() -> u64 {
    #[cfg(feature = "characterization")]
    if let Ok(clock) = std::env::var("P032_FIXTURE_CLOCK") {
        return clock.parse().expect("fixture clock integer");
    }
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock after epoch")
        .as_millis() as u64
}
impl App {
    /// `getPca` (`pca.ts:325-419`). `requested` is the tick the caller asks to beat;
    /// -1 is the "latest" sentinel `math.ts` substitutes for an absent `math_tick`.
    /// Returning None is Node's `undefined`, which `math.ts` turns into a 304.
    ///
    /// The cache is filled ONLY on the two paths that fill it in Node. The earlier
    /// unconditional fill could serve up to 3s of staleness in a window where Node
    /// re-queries, which is a behaviour change the recording cannot see.
    async fn get_pca(&self, zid: i32, requested: f64) -> Result<Option<Arc<Cached>>, Error> {
        let key = (self.math_env.clone(), zid);
        let mut cache = self.cache.lock().await;
        if let Some(item) = cache
            .entries
            .get(&key)
            .filter(|item| item.expires >= now())
            .cloned()
        {
            cache.order.retain(|k| k != &key);
            cache.order.push_back(key);
            // The latest-requested branch returns the cached item without comparing.
            if requested == -1.0 || (item.data.math_tick as f64) > requested {
                return Ok(Some(item));
            }
            return Ok(None);
        }
        let db = self.db.get().await?;
        let row = db.query_opt("select (data - 'zid' - 'subgroup-votes' - 'subgroup-repness' - 'subgroup-clusters')::text, math_tick from math_main where zid=$1 and math_env=$2", &[&zid, &self.math_env]).await?;
        let mut data = if let Some(row) = row {
            let tick: i64 = row.get(1);
            // `item.math_tick <= (math_tick || 0)`: JS coerces a falsy requested tick
            // — 0 and NaN alike — to 0 here, unlike the cache-hit comparison above.
            let floor = if requested == 0.0 || requested.is_nan() {
                0.0
            } else {
                requested
            };
            if (tick as f64) <= floor {
                // Node returns undefined WITHOUT populating the cache on this path.
                return Ok(None);
            }
            let text: String = row.get(0);
            let mut data: MathData = serde_json::from_str(&text).map_err(|e| {
                self.metrics
                    .contract_violations
                    .fetch_add(1, Ordering::Relaxed);
                // Structured, greppable, and free of stored content: only the model's
                // own complaint and the row's identity are recorded.
                eprintln!(
                    "{}",
                    serde_json::json!({
                        "event": "pca2_contract_violation",
                        "math_env": self.math_env,
                        "zid": zid,
                        "line": e.line(),
                        "column": e.column(),
                        "detail": e.to_string(),
                    })
                );
                Error::from(ContractViolation {
                    detail: e.to_string(),
                })
            })?;
            // Column is authoritative even at zero; never use the blob's engine-local tick.
            data.math_tick = tick.try_into()?;
            for (id, group) in &mut data.group_dash_votes {
                group.id = u64::from(*id);
            }
            // ensureCompletePcaStructure appends a missing key after every other extra;
            // a blob that carries the key keeps it at its own position.
            if data.mod_dash_in.is_none() {
                data.mod_dash_in_appended = Some(Vec::new());
            }
            if data.mod_dash_out.is_none() {
                data.mod_dash_out_appended = Some(Vec::new());
            }
            if data.meta_dash_tids.is_none() {
                data.meta_dash_tids_appended = Some(Vec::new());
            }
            data
        } else {
            if requested != -1.0 {
                // No row and an explicit tick: undefined, and again no cache fill.
                return Ok(None);
            }
            let tids: Vec<u64> = db
                .query(
                    "select tid from comments where zid=$1 and mod>=1 order by tid",
                    &[&zid],
                )
                .await?
                .iter()
                .map(|r| r.get::<_, i32>(0) as u64)
                .collect();
            MathData {
                n_dash_cmts: tids.len() as u64,
                pca: PcaData {
                    comps: vec![vec![], vec![]],
                    center: vec![0.0, 0.0],
                    comment_dash_extremity: vec![0.0; tids.len()],
                    ..Default::default()
                },
                tids,
                lastvotetimestamp: now(),
                ..Default::default()
            }
        };
        if data.lastvotetimestamp == 0 {
            data.lastvotetimestamp = now();
        }
        // Cache owns the served gzip buffer. Full requests never decode or recompress it.
        let gzip = json::gzip(&json::encode(&data)?)?;
        let item = Arc::new(Cached {
            data,
            gzip,
            expires: now() + 3000,
        });
        // Match isTrueOrBlank: unset/blank/true enables the 300-entry LRU.
        let enabled = std::env::var("CACHE_MATH_RESULTS").unwrap_or_default();
        let capacity = if enabled.is_empty() || enabled == "true" {
            300
        } else {
            1
        };
        cache.order.retain(|k| k != &key);
        cache.entries.insert(key.clone(), item.clone());
        cache.order.push_back(key);
        while cache.entries.len() > capacity {
            if let Some(old) = cache.order.pop_front() {
                cache.entries.remove(&old);
            }
        }
        Ok(Some(item))
    }
}
// Typed request carriers retain scalar/array distinctions; no arbitrary success JSON.
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
enum Param {
    Text(String),
    Number(f64),
    Bool(bool),
    Array(Vec<Param>),
    Object(HashMap<String, Param>),
    Null,
}
impl Param {
    fn string(&self) -> Option<&str> {
        if let Self::Text(s) = self {
            Some(s)
        } else {
            None
        }
    }
    fn truthy(&self) -> bool {
        match self {
            Self::Null => false,
            Self::Bool(b) => *b,
            Self::Number(n) => *n != 0.0,
            Self::Text(s) => !s.is_empty(),
            Self::Array(_) => true,
            Self::Object(values) => {
                let _ = values.len();
                true
            }
        }
    }
}
fn parameters(query: Option<String>, body: &[u8]) -> Result<HashMap<String, Param>, Error> {
    let mut result: HashMap<String, Param> = if body.is_empty() {
        HashMap::new()
    } else {
        serde_json::from_slice(body)?
    };
    let mut parsed = HashMap::<String, Param>::new();
    for (k, v) in url::form_urlencoded::parse(query.as_deref().unwrap_or("").as_bytes()) {
        let key = k.strip_suffix("[]").unwrap_or(&k).to_string();
        let value = Param::Text(v.into_owned());
        if let Some(existing) = parsed.get_mut(&key) {
            if let Param::Array(a) = existing {
                a.push(value)
            } else {
                *existing = Param::Array(vec![existing.clone(), value]);
            }
        } else if k.ends_with("[]") {
            parsed.insert(key, Param::Array(vec![value]));
        } else {
            parsed.insert(key, value);
        }
    }
    result.extend(parsed); // moveToBody: query wins over JSON body.
    Ok(result)
}
fn parse_tick(p: &Param) -> Option<f64> {
    match p {
        Param::Number(n) if n.fract() == 0.0 => Some(*n),
        Param::Text(s) => {
            let s = s.trim_start();
            let end = s
                .char_indices()
                .take_while(|(i, c)| c.is_ascii_digit() || (*i == 0 && (*c == '-' || *c == '+')))
                .map(|(i, c)| i + c.len_utf8())
                .last()?;
            s[..end].parse().ok()
        }
        _ => None,
    }
}
fn conditional_tick(header: &str) -> f64 {
    if header.contains('*') {
        return 0.0;
    }
    header
        .split(',')
        .map(|s| {
            let s = s.trim();
            let s = s
                .strip_prefix("W/")
                .or_else(|| s.strip_prefix("w/"))
                .unwrap_or(s);
            let s = s.strip_prefix('"').unwrap_or(s);
            let s = s.strip_suffix('"').unwrap_or(s).trim();
            if s.is_empty() {
                0.0
            } else {
                s.parse().unwrap_or(f64::NAN)
            }
        })
        .fold(f64::INFINITY, |a, b| {
            if a.is_nan() || b.is_nan() {
                f64::NAN
            } else {
                a.min(b)
            }
        })
}
#[derive(Clone)]
pub struct OrderedHeaders(pub Vec<(String, String)>);
fn response(status: u16, body: Vec<u8>, headers: Vec<(String, String)>) -> Response<Body> {
    let mut r = Response::builder()
        .status(status)
        .body(Body::from(body))
        .unwrap();
    r.extensions_mut().insert(OrderedHeaders(headers));
    r
}
/// writeDefaultHead then addCorsHeader. The four CORS headers are emitted only
/// when addCorsHeader resolved a non-empty origin, exactly as Node does.
fn base_headers(origin: Option<&str>, media: Option<&str>) -> Vec<(String, String)> {
    let mut h = Vec::new();
    if let Some(media) = media {
        h.push(("Content-Type".into(), media.into()));
    }
    h.push(("Cache-Control".into(), "no-cache".into()));
    h.push(("Connection".into(), "keep-alive".into()));
    if let Some(origin) = origin {
        h.push(("Access-Control-Allow-Origin".into(), origin.into()));
        h.extend(
            [
                ("Access-Control-Allow-Credentials", "true"),
                (
                    "Access-Control-Allow-Headers",
                    "Cache-Control, Pragma, Origin, Authorization, Content-Type, X-Requested-With",
                ),
                (
                    "Access-Control-Allow-Methods",
                    "GET, PUT, POST, DELETE, OPTIONS",
                ),
            ]
            .map(|(k, v)| (k.into(), v.into())),
        );
    }
    h
}
fn add(h: &mut Vec<(String, String)>, k: &str, v: impl ToString) {
    h.push((k.into(), v.to_string()));
}
fn bad_request(origin: Option<&str>) -> Response<Body> {
    let mut h = base_headers(origin, Some("text/html; charset=utf-8"));
    add(&mut h, "X-Content-Type-Options", "nosniff");
    add(&mut h, "Content-Length", 12);
    add(&mut h, "Vary", "Accept-Encoding");
    response(400, b"Bad Request\n".to_vec(), h)
}
/// `next("unauthorized domain: " + origin)` -> connect finalhandler. The headers
/// writeDefaultHead already set survive; the CORS headers were never reached.
fn unauthorized_domain(refusal: &cors::UnauthorizedDomain) -> Response<Body> {
    let production = std::env::var("NODE_ENV").unwrap_or("development".into()) == "production";
    let body = if production {
        "Internal Server Error\n".to_string()
    } else {
        // finalhandler escapes the message, then maps newlines and double spaces.
        let escaped = format!("unauthorized domain: {}", refusal.origin)
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
            .replace('"', "&quot;")
            .replace('\'', "&#39;");
        format!(
            "{}\n",
            escaped.replace('\n', "<br>").replace("  ", " &nbsp;")
        )
    };
    let mut h = base_headers(None, Some("text/html; charset=utf-8"));
    add(&mut h, "X-Content-Type-Options", "nosniff");
    add(&mut h, "Content-Length", body.len());
    add(&mut h, "Vary", "Accept-Encoding");
    response(500, body.into_bytes(), h)
}
#[derive(Serialize)]
struct Failure<'a> {
    error: &'a str,
    message: &'a str,
    status: u16,
}
/// Express 3's pinned etag module is MD5-based, unlike newer Express releases.
fn weak_etag(body: &[u8]) -> String {
    let digest = base64::engine::general_purpose::STANDARD_NO_PAD.encode(md5::compute(body).0);
    format!("W/\"{:x}-{}\"", body.len(), digest)
}
/// `middleware_check_if_options` (`server-middleware.ts:107-116`) answers OPTIONS
/// with `res.send(204)`. Express measures and ETags the status text "No Content",
/// then the 204 branch strips Content-Type and Content-Length and empties the body,
/// so the ETag it computed survives on a bodyless response.
async fn options_route(State(app): State<App>, headers: HeaderMap) -> Response<Body> {
    options_response(&app.cors, &headers)
}
fn options_response(cors: &Cors, headers: &HeaderMap) -> Response<Body> {
    let origin = match cors.resolve(headers) {
        Ok(origin) => origin,
        Err(refusal) => return unauthorized_domain(&refusal),
    };
    let mut h = base_headers(origin.as_deref(), None);
    add(&mut h, "ETag", weak_etag(b"No Content"));
    add(&mut h, "Vary", "Accept-Encoding");
    response(204, Vec::new(), h)
}
fn fail(origin: Option<&str>, status: u16, message: &str) -> Response<Body> {
    let body = json::encode(&Failure {
        error: message,
        message,
        status,
    })
    .unwrap();
    let mut h = base_headers(origin, Some("application/json; charset=utf-8"));
    add(&mut h, "Content-Length", body.len());
    add(&mut h, "ETag", weak_etag(&body));
    add(&mut h, "Vary", "Accept-Encoding");
    response(status, body, h)
}
/// The installed `compression` middleware, in its own order: it never transforms a
/// response that already carries an encoding (full mode sets one in the route), one
/// below the 1024-byte threshold, or a HEAD (`compression/index.js:192`).
fn should_compress(method: &Method, full: bool, len: usize, accept: Option<&str>) -> bool {
    !full
        && method != Method::HEAD
        && len >= 1024
        && accept.is_some_and(|v| v.split(',').any(|x| x.trim() == "gzip"))
}
async fn route(
    State(app): State<App>,
    method: Method,
    RawQuery(query): RawQuery,
    headers: HeaderMap,
    body: Bytes,
) -> Response<Body> {
    let origin = match app.cors.resolve(&headers) {
        Ok(origin) => origin,
        // Node answers the refusal from connect's final handler, which has no status
        // to respect and defaults to 500. No CORS header is emitted on this path.
        Err(refusal) => return unauthorized_domain(&refusal),
    };
    match handle(&app, origin.as_deref(), &method, query, headers, &body).await {
        Ok(r) => r,
        // The recording pins no cell for a blob the model does not describe, so the
        // gap is refused explicitly (upstream data, hence 502) under its own code
        // rather than dressed up as the route's generic 500.
        Err(e) if e.is::<ContractViolation>() => {
            fail(origin.as_deref(), 502, "polis_err_pca2_contract_violation")
        }
        Err(e) => {
            eprintln!("pca2 request failed: {e}");
            fail(origin.as_deref(), 500, "polis_err_pca2")
        }
    }
}
async fn handle(
    app: &App,
    origin: Option<&str>,
    method: &Method,
    query: Option<String>,
    headers: HeaderMap,
    body: &[u8],
) -> Result<Response<Body>, Error> {
    let Ok(params) = parameters(query, body) else {
        return Ok(bad_request(origin));
    };
    let cap = params.get("conversation_id").and_then(Param::string);
    if params.get("zid").is_some_and(Param::truthy)
        && !params.get("conversation_id").is_some_and(Param::truthy)
    {
        let mut h = base_headers(origin, Some("application/json"));
        let protocol = headers
            .get("x-forwarded-proto")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("http");
        let host = headers
            .get("host")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("localhost");
        add(&mut h, "Location", format!("{protocol}://{host}/about"));
        add(&mut h, "Vary", "Accept-Encoding");
        add(&mut h, "Content-Length", 0);
        return Ok(response(302, vec![], h));
    }
    let Some(cap) = cap.filter(|s| !s.is_empty() && s.len() <= 100) else {
        return Ok(bad_request(origin));
    };
    let Some(row) = app
        .db
        .get()
        .await?
        .query_opt("select zid from zinvites where zinvite=$1", &[&cap])
        .await?
    else {
        return Ok(bad_request(origin));
    };
    let zid: i32 = row.get(0);
    let tick = params
        .get("math_tick")
        .filter(|p| !matches!(p, Param::Null));
    let mut requested = if let Some(t) = tick {
        let Some(n) = parse_tick(t) else {
            return Ok(bad_request(origin));
        };
        n
    } else {
        -1.0
    };
    let keys = match params.get("keys") {
        None | Some(Param::Null) => vec![],
        Some(Param::Text(s)) => s.split(',').map(|s| s.trim().to_owned()).collect(),
        Some(Param::Array(a)) => a
            .iter()
            .filter_map(|p| match p {
                Param::Text(s) => Some(s.clone()),
                Param::Number(n) => Some(ryu_js::Buffer::new().format(*n).to_owned()),
                _ => None,
            })
            .collect(),
        _ => return Ok(bad_request(origin)),
    };
    let etag = headers
        .get("if-none-match")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("");
    if etag.len() > 1000 {
        return Ok(bad_request(origin));
    }
    if !etag.is_empty() {
        if tick.is_some() {
            return Ok(fail(
                origin,
                400,
                "Expected either math_tick param or If-Not-Match header, but not both.",
            ));
        }
        requested = conditional_tick(etag);
    }
    let item = match app.get_pca(zid, requested).await? {
        Some(item) => item,
        None => {
            // math.ts:120-134. The first miss for a cache key re-queries from the
            // latest sentinel to learn whether any math exists, which is also what
            // warms the empty structure for the next request. Both branches of
            // finishWith304or404 send 304; its 404 is commented out at the source.
            let seen = app
                .results_exist
                .lock()
                .await
                .get(&(app.math_env.clone(), zid))
                .copied();
            if seen.is_none() {
                let exists = app.get_pca(zid, -1.0).await?.is_some();
                app.results_exist
                    .lock()
                    .await
                    .insert((app.math_env.clone(), zid), exists);
            }
            let mut h = base_headers(origin, Some("application/json"));
            add(&mut h, "Vary", "Accept-Encoding");
            return Ok(response(304, vec![], h));
        }
    };
    let full = keys.is_empty();
    let mut h = base_headers(
        origin,
        if etag == "*" {
            None
        } else if full {
            Some("application/json")
        } else {
            Some("application/json; charset=utf-8")
        },
    );
    if full {
        add(&mut h, "Content-Encoding", "gzip");
    }
    add(&mut h, "Etag", format!("\"{}\"", item.data.math_tick));
    if etag == "*" {
        return Ok(response(304, vec![], h));
    }
    let bytes = if full {
        item.gzip.clone()
    } else {
        json::encode(&Subset {
            data: &item.data,
            keys: &keys,
        })?
    };
    let compress = should_compress(
        method,
        full,
        bytes.len(),
        headers.get("accept-encoding").and_then(|v| v.to_str().ok()),
    );
    if compress {
        add(&mut h, "Vary", "Accept-Encoding");
        add(&mut h, "Content-Encoding", "gzip");
        add(&mut h, "Transfer-Encoding", "chunked");
        Ok(response(200, json::gzip(&bytes)?, h))
    } else {
        add(&mut h, "Content-Length", bytes.len());
        add(&mut h, "Vary", "Accept-Encoding");
        Ok(response(200, bytes, h))
    }
}
#[derive(Serialize)]
struct Health {
    status: &'static str,
    #[serde(rename = "mathEnv")]
    math_env: String,
    #[serde(rename = "poolIdle")]
    pool_idle: usize,
    #[serde(rename = "poolOpened")]
    pool_opened: u64,
    #[serde(rename = "poolFailed")]
    pool_failed: u64,
    #[serde(rename = "contractViolations")]
    contract_violations: u64,
}
/// Not a Node route. It exists so a reconnect, a pool starved of connections, and
/// the contract-violation rate are observable rather than inferred from 5xx counts.
async fn health(State(app): State<App>) -> Response<Body> {
    let reachable = match app.db.get().await {
        Ok(db) => db.query_one("select 1", &[]).await.is_ok(),
        Err(_) => false,
    };
    let (idle, opened, failed) = app.db.stats();
    let body = json::encode(&Health {
        status: if reachable { "ok" } else { "degraded" },
        math_env: app.math_env.clone(),
        pool_idle: idle,
        pool_opened: opened,
        pool_failed: failed,
        contract_violations: app.metrics.contract_violations.load(Ordering::Relaxed),
    })
    .expect("health encodes");
    let mut h = vec![
        ("Content-Type".to_string(), "application/json".to_string()),
        ("Cache-Control".to_string(), "no-cache".to_string()),
        ("Connection".to_string(), "keep-alive".to_string()),
    ];
    add(&mut h, "Content-Length", body.len());
    response(if reachable { 200 } else { 503 }, body, h)
}
#[tokio::main]
async fn main() -> Result<(), Error> {
    // Config.mathEnv has no default. An unset variable makes Node match no rows;
    // defaulting it here would silently serve another namespace's math instead.
    let math_env = std::env::var("MATH_ENV")
        .ok()
        .filter(|v| !v.is_empty())
        .ok_or("MATH_ENV is required and has no default")?;
    let pool_size = std::env::var("PG_POOL_SIZE")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(16);
    let app = App {
        db: Pool::open(std::env::var("DATABASE_URL")?, pool_size).await?,
        math_env,
        cors: Arc::new(Cors::from_env()),
        cache: Default::default(),
        results_exist: Default::default(),
        metrics: Default::default(),
    };
    let router = Router::new()
        .route(
            "/api/v3/math/pca2",
            get(route).head(route).options(options_route),
        )
        .route("/health", get(health))
        .with_state(app);
    let listener = tokio::net::TcpListener::bind(
        std::env::var("LISTEN_ADDR").unwrap_or("127.0.0.1:5000".into()),
    )
    .await?;
    eprintln!("polis-api listening {}", listener.local_addr()?);
    transport::serve(listener, router).await
}
/// B1 gate. Decodes stored `math_main.data` blobs through the pinned model and
/// reports every key and type the model does not cover.
///
/// It grades a corpus, so it fails closed: an unreadable directory, an unreadable
/// or malformed file, a record that is not an object, a file it does not know how
/// to grade, and an empty admitted set are all census FAILURES, never skips. A
/// file may be left ungraded only by naming it in `census-exclusions.json` with a
/// reason, which is reported. `cargo test` reports the gate as ignored rather than
/// as a pass, because a census with no corpus is not evidence:
/// `P032_CENSUS_DIR=<dir> cargo test --locked -- --ignored census`.
///
/// Records may be bare blobs or envelopes `{"source", "math_env", "data"}`, so a
/// restored all-row dump can be graded and its coverage reported per math_env.
#[cfg(test)]
mod census {
    use super::model::MathData;
    use serde_json::Value;
    use std::collections::{BTreeMap, BTreeSet};
    use std::path::Path;
    // Mirrors the route's SQL projection: these four are stripped before the model sees them.
    const STRIPPED: [&str; 4] = [
        "zid",
        "subgroup-votes",
        "subgroup-repness",
        "subgroup-clusters",
    ];
    const EXCLUSIONS: &str = "census-exclusions.json";
    const UNLABELLED: &str = "(unlabelled)";
    #[derive(Default)]
    pub struct Report {
        pub graded: usize,
        pub records: usize,
        pub excluded: Vec<(String, String)>,
        pub coverage: BTreeMap<(String, String), usize>,
        pub keys: BTreeMap<String, BTreeSet<String>>,
        pub errors: Vec<String>,
    }
    impl Report {
        fn fail(&mut self, what: &str, why: impl std::fmt::Display) {
            self.errors.push(format!("{what}: {why}"));
        }
        pub fn print(&self) {
            for (key, kinds) in &self.keys {
                println!("census key {key}: {kinds:?}");
            }
            for ((source, env), n) in &self.coverage {
                println!("census coverage source={source} math_env={env} records={n}");
            }
            for (file, reason) in &self.excluded {
                println!("census excluded {file}: {reason}");
            }
            println!(
                "census files {} graded, {} excluded; records {}; failures {}",
                self.graded,
                self.excluded.len(),
                self.records,
                self.errors.len()
            );
        }
    }
    fn kind(value: &Value) -> &'static str {
        match value {
            Value::Null => "null",
            Value::Bool(_) => "boolean",
            Value::Number(n) if n.is_f64() && n.as_i64().is_none() => "number",
            Value::Number(_) => "integer",
            Value::String(_) => "string",
            Value::Array(_) => "array",
            Value::Object(_) => "object",
        }
    }
    fn exclusions(dir: &Path, report: &mut Report) -> BTreeMap<String, String> {
        let path = dir.join(EXCLUSIONS);
        if !path.exists() {
            return BTreeMap::new();
        }
        match std::fs::read_to_string(&path)
            .map_err(|e| e.to_string())
            .and_then(|t| {
                serde_json::from_str::<BTreeMap<String, String>>(&t).map_err(|e| e.to_string())
            }) {
            Ok(map) => map,
            Err(e) => {
                report.fail(EXCLUSIONS, e);
                BTreeMap::new()
            }
        }
    }
    /// Splits an envelope into its labels and the blob, or labels the record by file.
    fn unwrap_record(file: &str, value: Value) -> Result<(String, String, Value), String> {
        let Value::Object(map) = value else {
            return Err(format!("record is {}, expected an object", kind(&value)));
        };
        let envelope = map.contains_key("data")
            && map
                .keys()
                .all(|k| matches!(k.as_str(), "data" | "source" | "math_env"));
        if !envelope {
            return Ok((file.to_string(), UNLABELLED.to_string(), Value::Object(map)));
        }
        let label = |k: &str, fallback: &str| {
            map.get(k)
                .and_then(Value::as_str)
                .unwrap_or(fallback)
                .to_string()
        };
        let source = label("source", file);
        let env = label("math_env", UNLABELLED);
        Ok((source, env, map["data"].clone()))
    }
    fn grade(file: &str, index: Option<usize>, value: Value, report: &mut Report) {
        let name = match index {
            Some(i) => format!("{file}#{i}"),
            None => file.to_string(),
        };
        let (source, env, mut blob) = match unwrap_record(file, value) {
            Ok(parts) => parts,
            Err(e) => return report.fail(&name, e),
        };
        let Some(object) = blob.as_object_mut() else {
            return report.fail(
                &name,
                format!("blob is {}, expected an object", kind(&blob)),
            );
        };
        report.records += 1;
        *report.coverage.entry((source, env)).or_default() += 1;
        for key in STRIPPED {
            object.remove(key);
        }
        for (key, member) in object.iter() {
            report
                .keys
                .entry(key.clone())
                .or_default()
                .insert(kind(member).to_string());
        }
        if let Err(e) = serde_json::from_value::<MathData>(blob) {
            report.fail(&name, e);
        }
    }
    pub fn run(dir: &Path) -> Report {
        let mut report = Report::default();
        let entries = match std::fs::read_dir(dir) {
            Ok(entries) => entries,
            Err(e) => {
                report.fail(&dir.display().to_string(), e);
                return report;
            }
        };
        let excluded = exclusions(dir, &mut report);
        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(e) => {
                    report.fail("directory entry", e);
                    continue;
                }
            };
            let path = entry.path();
            let file = path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned();
            if file == EXCLUSIONS {
                continue;
            }
            if let Some(reason) = excluded.get(&file) {
                report.excluded.push((file, reason.clone()));
                continue;
            }
            if path.is_dir() {
                report.fail(
                    &file,
                    "directories are not graded; exclude it with a reason",
                );
                continue;
            }
            let text = match std::fs::read_to_string(&path) {
                Ok(text) => text,
                Err(e) => {
                    report.fail(&file, e);
                    continue;
                }
            };
            report.graded += 1;
            match path.extension().and_then(|e| e.to_str()) {
                Some("jsonl") => {
                    for (i, line) in text.lines().enumerate() {
                        if line.trim().is_empty() {
                            continue;
                        }
                        match serde_json::from_str::<Value>(line) {
                            Ok(value) => grade(&file, Some(i), value, &mut report),
                            Err(e) => report.fail(&format!("{file}#{i}"), e),
                        }
                    }
                }
                Some("json") => match serde_json::from_str::<Value>(&text) {
                    Ok(Value::Array(rows)) => {
                        for (i, value) in rows.into_iter().enumerate() {
                            grade(&file, Some(i), value, &mut report);
                        }
                    }
                    Ok(value) => grade(&file, None, value, &mut report),
                    Err(e) => report.fail(&file, e),
                },
                _ => report.fail(
                    &file,
                    "unknown census input; use .json/.jsonl or exclude it with a reason",
                ),
            }
        }
        if report.records == 0 {
            report.fail(
                "corpus",
                "census admitted no blobs; an empty census is not evidence",
            );
        }
        report
    }
    #[test]
    #[ignore = "needs a stored-blob corpus: P032_CENSUS_DIR=<dir> cargo test --locked -- --ignored census"]
    fn stored_blobs_decode_through_the_model() {
        let dir = std::env::var("P032_CENSUS_DIR")
            .expect("P032_CENSUS_DIR must name a directory of stored math_main blobs");
        let report = run(Path::new(&dir));
        report.print();
        assert!(
            report.errors.is_empty(),
            "census failures:\n{}",
            report.errors.join("\n")
        );
    }
    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("p032-census-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }
    fn write(dir: &Path, name: &str, body: &str) {
        std::fs::write(dir.join(name), body).expect("scratch file");
    }
    /// The grader must never report success for input it did not actually grade.
    /// Each case here was a silent skip and a PASS before this change.
    #[test]
    fn the_census_fails_closed() {
        let empty = scratch("empty");
        assert!(
            run(&empty)
                .errors
                .iter()
                .any(|e| e.contains("admitted no blobs")),
            "an empty corpus must fail"
        );
        let missing = empty.join("does-not-exist");
        assert!(
            !run(&missing).errors.is_empty(),
            "an unreadable directory must fail"
        );
        let mixed = scratch("mixed");
        write(&mixed, "valid.json", "{}");
        write(&mixed, "bad.json", "{");
        write(&mixed, "scalar.json", "42");
        let report = run(&mixed);
        assert_eq!(report.records, 1, "only the object is a record");
        assert_eq!(report.graded, 3, "every file is graded, not skipped");
        assert_eq!(report.errors.len(), 2, "{:?}", report.errors);
        assert!(report.errors.iter().any(|e| e.starts_with("bad.json")));
        assert!(report.errors.iter().any(|e| e.starts_with("scalar.json")));
        let other = scratch("other");
        write(&other, "notes.txt", "not a blob");
        write(&other, "valid.json", "{}");
        let report = run(&other);
        assert!(
            report.errors.iter().any(|e| e.starts_with("notes.txt")),
            "an ungraded file must fail rather than vanish: {:?}",
            report.errors
        );
        // ...unless it is excluded on the record, with a reason.
        write(
            &other,
            EXCLUSIONS,
            r#"{"notes.txt":"operator notes, not a blob"}"#,
        );
        let report = run(&other);
        assert!(report.errors.is_empty(), "{:?}", report.errors);
        assert_eq!(report.excluded.len(), 1);
        assert_eq!(report.records, 1);
        for dir in [empty, mixed, other] {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
    #[test]
    fn the_census_grades_shapes_and_reports_coverage() {
        let dir = scratch("coverage");
        write(
            &dir,
            "rows.jsonl",
            concat!(
                r#"{"source":"prodclone","math_env":"prod","data":{"n":1,"zid":9}}"#,
                "\n",
                r#"{"source":"prodclone","math_env":"other","data":{"n":2}}"#,
                "\n",
                r#"{"source":"prodclone","math_env":"prod","data":{"a-future-key":1}}"#,
                "\n",
            ),
        );
        let report = run(&dir);
        assert_eq!(report.records, 3);
        assert_eq!(report.coverage[&("prodclone".into(), "prod".into())], 2);
        assert_eq!(report.coverage[&("prodclone".into(), "other".into())], 1);
        // The route strips zid in SQL, so it must not count as an unmodelled key.
        assert!(!report.keys.contains_key("zid"));
        assert_eq!(report.errors.len(), 1, "{:?}", report.errors);
        assert!(report.errors[0].contains("a-future-key"));
        let _ = std::fs::remove_dir_all(dir);
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    /// The seeded corpus never carries a non-null `lastModTimestamp`, and every
    /// populated fixture carries all three of mod-in/mod-out/meta-tids. Both gaps
    /// are covered here so the model is judged against the source, not the seed.
    #[test]
    fn source_declared_shapes_decode_and_reserialize() {
        let numeric: MathData =
            serde_json::from_str(r#"{"lastModTimestamp":1700000000000}"#).expect("number decodes");
        assert_eq!(numeric.lastmodtimestamp, Some(1700000000000));
        let null: MathData = serde_json::from_str(r#"{"lastModTimestamp":null}"#).expect("null");
        assert_eq!(null.lastmodtimestamp, None);
        let absent: MathData = serde_json::from_str("{}").expect("absent");
        let wire = String::from_utf8(json::encode(&absent).unwrap()).unwrap();
        assert!(wire.contains("\"lastModTimestamp\":null"));
    }
    #[test]
    fn unmodelled_key_is_a_refusal_not_a_guess() {
        let e = serde_json::from_str::<MathData>(r#"{"n":0,"a-future-key":1}"#).unwrap_err();
        assert!(e.to_string().contains("a-future-key"), "{e}");
    }
    /// M4: with the key absent from the blob it must appear AFTER every other extra,
    /// because `ensureCompletePcaStructure` writes it after the object spread.
    #[test]
    fn absent_mod_keys_serialize_after_every_other_extra() {
        let mut data: MathData =
            serde_json::from_str(r#"{"comment_count":7,"mod-out":[1]}"#).expect("blob");
        data.mod_dash_in_appended = Some(Vec::new());
        data.meta_dash_tids_appended = Some(Vec::new());
        let wire = String::from_utf8(json::encode(&data).unwrap()).unwrap();
        let at = |k: &str| {
            wire.find(k)
                .unwrap_or_else(|| panic!("{k} missing from {wire}"))
        };
        assert!(at("\"mod-out\"") < at("\"comment_count\""));
        assert!(at("\"comment_count\"") < at("\"mod-in\""));
        assert!(at("\"mod-in\"") < at("\"meta-tids\""));
        let keys = [
            "mod-in".to_string(),
            "mod-out".to_string(),
            "meta-tids".to_string(),
        ];
        let subset = String::from_utf8(
            json::encode(&Subset {
                data: &data,
                keys: &keys,
            })
            .unwrap(),
        )
        .unwrap();
        assert_eq!(subset, r#"{"mod-in":[],"mod-out":[1],"meta-tids":[]}"#);
    }
    fn names(h: &[(String, String)]) -> Vec<&str> {
        h.iter().map(|(k, _)| k.as_str()).collect()
    }
    fn value<'a>(h: &'a [(String, String)], key: &str) -> &'a str {
        h.iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
            .unwrap_or_default()
    }
    /// B2: the exact header set Node emits, which is conditional on the origin
    /// addCorsHeader resolved — not four headers on every response.
    #[test]
    fn cors_headers_follow_the_resolved_origin() {
        let with = base_headers(Some("https://embed.pol.is"), Some("application/json"));
        assert_eq!(
            names(&with),
            [
                "Content-Type",
                "Cache-Control",
                "Connection",
                "Access-Control-Allow-Origin",
                "Access-Control-Allow-Credentials",
                "Access-Control-Allow-Headers",
                "Access-Control-Allow-Methods",
            ]
        );
        assert_eq!(
            value(&with, "Access-Control-Allow-Origin"),
            "https://embed.pol.is"
        );
        assert_eq!(value(&with, "Access-Control-Allow-Credentials"), "true");
        assert_eq!(
            value(&with, "Access-Control-Allow-Headers"),
            "Cache-Control, Pragma, Origin, Authorization, Content-Type, X-Requested-With"
        );
        assert_eq!(
            value(&with, "Access-Control-Allow-Methods"),
            "GET, PUT, POST, DELETE, OPTIONS"
        );
        // No Origin and no Referer: Node's `if (origin)` guard emits nothing.
        let without = base_headers(None, Some("application/json"));
        assert_eq!(
            names(&without),
            ["Content-Type", "Cache-Control", "Connection"]
        );
        // M1: writeDefaultHead pins keep-alive; the transport no longer overrides it.
        assert_eq!(value(&without, "Connection"), "keep-alive");
    }
    #[test]
    fn refused_origin_answers_the_final_handler_without_cors() {
        let r = unauthorized_domain(&cors::UnauthorizedDomain {
            origin: "https://evil.example".into(),
        });
        assert_eq!(r.status(), 500);
        let h = &r
            .extensions()
            .get::<OrderedHeaders>()
            .expect("ordered headers")
            .0;
        assert!(!names(h).iter().any(|k| k.starts_with("Access-Control-")));
        assert_eq!(value(h, "Content-Type"), "text/html; charset=utf-8");
        assert_eq!(value(h, "X-Content-Type-Options"), "nosniff");
    }
    #[test]
    fn head_is_never_compressed_by_the_middleware() {
        let gzip = Some("gzip");
        assert!(should_compress(&Method::GET, false, 2048, gzip));
        assert!(!should_compress(&Method::HEAD, false, 2048, gzip));
        assert!(!should_compress(&Method::GET, false, 1023, gzip));
        assert!(!should_compress(&Method::GET, true, 2048, gzip));
        assert!(!should_compress(&Method::GET, false, 2048, Some("deflate")));
    }
    /// B3: `app.all("/api/v3/*", middleware_check_if_options)` answers before the
    /// router, so a preflight never reaches the route's parameter middleware.
    #[tokio::test]
    async fn options_answers_204_with_nodes_headers() {
        let r = options_response(&Cors::for_test(&["pol.is"]), &HeaderMap::new());
        assert_eq!(r.status(), 204);
        let h = &r
            .extensions()
            .get::<OrderedHeaders>()
            .expect("ordered headers")
            .0;
        // 204 strips Content-Type and Content-Length; the computed ETag survives.
        assert_eq!(names(h), ["Cache-Control", "Connection", "ETag", "Vary"]);
        assert_eq!(value(h, "ETag"), weak_etag(b"No Content"));
        assert_eq!(value(h, "Vary"), "Accept-Encoding");
        assert_eq!(
            axum::body::to_bytes(r.into_body(), 16).await.unwrap().len(),
            0
        );
    }
    #[test]
    fn options_carries_the_cors_headers_when_an_origin_resolves() {
        let mut headers = HeaderMap::new();
        headers.insert("origin", "https://embed.pol.is".parse().unwrap());
        let r = options_response(&Cors::for_test(&["pol.is"]), &headers);
        let h = &r
            .extensions()
            .get::<OrderedHeaders>()
            .expect("ordered headers")
            .0;
        assert_eq!(
            names(h),
            [
                "Cache-Control",
                "Connection",
                "Access-Control-Allow-Origin",
                "Access-Control-Allow-Credentials",
                "Access-Control-Allow-Headers",
                "Access-Control-Allow-Methods",
                "ETag",
                "Vary",
            ]
        );
    }
    #[test]
    fn conditionals() {
        assert_eq!(conditional_tick("\"2\", W/\"0\""), 0.0);
        assert_eq!(conditional_tick("w/\"1\""), 1.0);
        assert_eq!(conditional_tick("*"), 0.0);
        assert!(conditional_tick("bad").is_nan());
    }
    #[test]
    fn parameter_precedence() {
        let p = parameters(
            Some("keys=&math_tick=0tail".into()),
            br#"{"keys":[],"math_tick":9}"#,
        )
        .unwrap();
        assert_eq!(p["keys"].string(), Some(""));
        assert_eq!(parse_tick(&p["math_tick"]), Some(0.0));
    }
}
