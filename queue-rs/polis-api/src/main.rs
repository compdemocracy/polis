//! `polis-api`: one Rust process serving `GET /api/v3/math/pca2` with the
//! bytes, headers and statuses the Node server produces for it. Everything
//! else stays on Node; nginx sends this one path here only when
//! `RUST_API_ROUTES` names it (see README).
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]

mod clock;
mod compress;
mod config;
mod cors;
mod db;
mod http;
mod js;
mod lru;
mod negotiate;
mod params;
mod pca;
mod route;

use anyhow::{Context, Result};
use http::{Body, Outgoing, Request};
use std::sync::{Arc, atomic::Ordering};

/// Not a Node route: liveness for the container and the operator.
async fn health(app: &route::App) -> Outgoing {
    let reachable = app.db.ping().await;
    let mut body = js::Obj::new();
    body.set(
        "status",
        js::Js::Str(if reachable { "ok" } else { "degraded" }.into()),
    );
    body.set("mathEnv", js::Js::Str(app.math_env.clone()));
    body.set(
        "served",
        js::Js::Num(app.served.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "failed",
        js::Js::Num(app.failed.load(Ordering::Relaxed) as f64),
    );
    let bytes = js::stringify(&js::Js::Obj(body)).into_bytes();
    Outgoing {
        status: if reachable { 200 } else { 503 },
        headers: vec![
            ("Content-Type".into(), "application/json".into()),
            ("Cache-Control".into(), "no-cache".into()),
            ("Content-Length".into(), bytes.len().to_string()),
        ],
        body: Body::Fixed(bytes),
        close: false,
    }
}

fn not_found() -> Outgoing {
    let bytes = b"Not Found\n".to_vec();
    Outgoing {
        status: 404,
        headers: vec![
            ("Content-Type".into(), "text/plain; charset=utf-8".into()),
            ("Content-Length".into(), bytes.len().to_string()),
        ],
        body: Body::Fixed(bytes),
        close: false,
    }
}

async fn dispatch(app: Arc<route::App>, req: Request) -> Outgoing {
    match req.path() {
        route::PATH => route::handle(app, req).await,
        "/health" if req.method == "GET" => health(&app).await,
        _ => not_found(),
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let cfg = config::Config::from_env()?;
    let connector = config::db_connector()?;
    let pool = db::Pool::new(connector, cfg.pool_size, cfg.acquire_timeout);
    let app = Arc::new(route::App::new(&cfg, pool));
    let listener = tokio::net::TcpListener::bind(&cfg.listen)
        .await
        .with_context(|| format!("bind {}", cfg.listen))?;
    eprintln!(
        "{{\"event\":\"polis_api_listening\",\"addr\":\"{}\",\"math_env\":{:?}}}",
        listener.local_addr()?,
        cfg.math_env
    );
    let handler = Arc::new(move |req: Request| dispatch(app.clone(), req));
    tokio::select! {
        r = http::serve(listener, handler) => r,
        _ = tokio::signal::ctrl_c() => Ok(()),
    }
}
