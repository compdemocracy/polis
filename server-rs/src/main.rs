mod json;
mod model;
mod transport;
use axum::{
    Router,
    body::{Body, Bytes},
    extract::{RawQuery, State},
    http::{HeaderMap, Response},
    routing::get,
};
use base64::Engine;
use model::{MathData, PcaData, Subset};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, VecDeque},
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::sync::Mutex;
use tokio_postgres::{Client, NoTls};
type Error = Box<dyn std::error::Error + Send + Sync>;
#[derive(Clone)]
struct App {
    db: Arc<Client>,
    math_env: String,
    origin: String,
    cache: Arc<Mutex<Cache>>,
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
    async fn load(&self, zid: i32) -> Result<Option<Arc<Cached>>, Error> {
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
            return Ok(Some(item));
        }
        let row = self.db.query_opt("select (data - 'zid' - 'subgroup-votes' - 'subgroup-repness' - 'subgroup-clusters')::text, math_tick from math_main where zid=$1 and math_env=$2", &[&zid, &self.math_env]).await?;
        let mut data = if let Some(row) = row {
            let tick: i64 = row.get(1);
            if tick < 0 {
                return Ok(None);
            }
            let text: String = row.get(0);
            let mut data: MathData = serde_json::from_str(&text)?;
            // Column is authoritative even at zero; never use the blob's engine-local tick.
            data.math_tick = tick.try_into()?;
            for (id, group) in &mut data.group_dash_votes {
                group.id = u64::from(*id);
            }
            data.mod_dash_in.get_or_insert_with(Vec::new);
            data.mod_dash_out.get_or_insert_with(Vec::new);
            data.meta_dash_tids.get_or_insert_with(Vec::new);
            data
        } else {
            let tids: Vec<u64> = self
                .db
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
fn base_headers(app: &App, media: Option<&str>) -> Vec<(String, String)> {
    let mut h = Vec::new();
    if let Some(media) = media {
        h.push(("Content-Type".into(), media.into()));
    }
    h.extend(
        [
            ("Cache-Control", "no-cache"),
            ("Access-Control-Allow-Origin", app.origin.as_str()),
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
    h
}
fn add(h: &mut Vec<(String, String)>, k: &str, v: impl ToString) {
    h.push((k.into(), v.to_string()));
}
fn bad_request(app: &App) -> Response<Body> {
    let mut h = base_headers(app, Some("text/html; charset=utf-8"));
    add(&mut h, "X-Content-Type-Options", "nosniff");
    add(&mut h, "Content-Length", 12);
    add(&mut h, "Vary", "Accept-Encoding");
    response(400, b"Bad Request\n".to_vec(), h)
}
#[derive(Serialize)]
struct Failure<'a> {
    error: &'a str,
    message: &'a str,
    status: u16,
}
fn fail(app: &App, status: u16, message: &str) -> Response<Body> {
    let body = json::encode(&Failure {
        error: message,
        message,
        status,
    })
    .unwrap();
    let mut h = base_headers(app, Some("application/json; charset=utf-8"));
    add(&mut h, "Content-Length", body.len());
    // The pinned Express 3 etag module uses MD5, unlike newer Express releases.
    let digest = base64::engine::general_purpose::STANDARD_NO_PAD.encode(md5::compute(&body).0);
    add(&mut h, "ETag", format!("W/\"{:x}-{}\"", body.len(), digest));
    add(&mut h, "Vary", "Accept-Encoding");
    response(status, body, h)
}
async fn route(
    State(app): State<App>,
    RawQuery(query): RawQuery,
    headers: HeaderMap,
    body: Bytes,
) -> Response<Body> {
    match handle(&app, query, headers, &body).await {
        Ok(r) => r,
        Err(e) => {
            eprintln!("pca2 request failed: {e}");
            fail(&app, 500, "polis_err_pca2")
        }
    }
}
async fn handle(
    app: &App,
    query: Option<String>,
    headers: HeaderMap,
    body: &[u8],
) -> Result<Response<Body>, Error> {
    let Ok(params) = parameters(query, body) else {
        return Ok(bad_request(app));
    };
    let cap = params.get("conversation_id").and_then(Param::string);
    if params.get("zid").is_some_and(Param::truthy)
        && !params.get("conversation_id").is_some_and(Param::truthy)
    {
        let mut h = base_headers(app, Some("application/json"));
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
        return Ok(bad_request(app));
    };
    let Some(row) = app
        .db
        .query_opt("select zid from zinvites where zinvite=$1", &[&cap])
        .await?
    else {
        return Ok(bad_request(app));
    };
    let zid: i32 = row.get(0);
    let tick = params
        .get("math_tick")
        .filter(|p| !matches!(p, Param::Null));
    let mut requested = if let Some(t) = tick {
        let Some(n) = parse_tick(t) else {
            return Ok(bad_request(app));
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
        _ => return Ok(bad_request(app)),
    };
    let etag = headers
        .get("if-none-match")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("");
    if etag.len() > 1000 {
        return Ok(bad_request(app));
    }
    if !etag.is_empty() {
        if tick.is_some() {
            return Ok(fail(
                app,
                400,
                "Expected either math_tick param or If-Not-Match header, but not both.",
            ));
        }
        requested = conditional_tick(etag);
    }
    let item = app.load(zid).await?;
    if item
        .as_ref()
        .is_none_or(|item| item.data.math_tick as f64 <= requested)
    {
        let mut h = base_headers(app, Some("application/json"));
        add(&mut h, "Vary", "Accept-Encoding");
        return Ok(response(304, vec![], h));
    }
    let item = item.expect("returned 304 for missing math");
    let full = keys.is_empty();
    let mut h = base_headers(
        app,
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
    let compress = !full
        && bytes.len() >= 1024
        && headers
            .get("accept-encoding")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.split(',').any(|x| x.trim() == "gzip"));
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
#[tokio::main]
async fn main() -> Result<(), Error> {
    let (db, connection) = tokio_postgres::connect(&std::env::var("DATABASE_URL")?, NoTls).await?;
    tokio::spawn(async move {
        if let Err(e) = connection.await {
            eprintln!("database connection failed: {e}");
            std::process::exit(1);
        }
    });
    let app = App {
        db: Arc::new(db),
        math_env: std::env::var("MATH_ENV").unwrap_or("dev".into()),
        origin: std::env::var("P032_CORS_ORIGIN").unwrap_or("https://localhost".into()),
        cache: Default::default(),
    };
    let router = Router::new()
        .route(
            "/api/v3/math/pca2",
            get(route).head(|| async { axum::http::StatusCode::METHOD_NOT_ALLOWED }),
        )
        .with_state(app);
    let listener = tokio::net::TcpListener::bind(
        std::env::var("LISTEN_ADDR").unwrap_or("127.0.0.1:5000".into()),
    )
    .await?;
    eprintln!("polis-api listening {}", listener.local_addr()?);
    transport::serve(listener, router).await
}
#[cfg(test)]
mod tests {
    use super::*;
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
