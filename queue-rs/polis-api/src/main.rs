//! `polis-api`: one Rust process serving `GET /api/v3/math/pca2` with the
//! bytes, headers and statuses the Node server produces for it. Everything
//! else stays on Node; nginx sends this one path here only when
//! `RUST_API_ROUTES` names it (see README).
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]

mod about;
mod clock;
mod comments;
mod compress;
mod config;
mod connection;
mod cors;
mod db;
mod http;
mod js;
mod lru;
mod negotiate;
mod next_comment;
mod owner;
mod params;
mod pca;
mod robots;
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
    body.set(
        "participantServed",
        js::Js::Num(app.participant_served.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "participantFallback",
        js::Js::Num(app.participant_fallback.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "connectionServed",
        js::Js::Num(app.connection_served.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "connectionFallback",
        js::Js::Num(app.connection_fallback.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "robotsServed",
        js::Js::Num(app.robots_served.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "robotsFallback",
        js::Js::Num(app.robots_fallback.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "aboutServed",
        js::Js::Num(app.about_served.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "aboutFallback",
        js::Js::Num(app.about_fallback.load(Ordering::Relaxed) as f64),
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
    body.set(
        "nextCommentServed",
        js::Js::Num(app.next_comment_served.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "nextCommentFallback",
        js::Js::Num(app.next_comment_fallback.load(Ordering::Relaxed) as f64),
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

async fn dispatch(app: Arc<route::App>, owner: Option<Arc<owner::App>>, req: Request) -> Outgoing {
    match req.path() {
        owner::PATH => match owner {
            Some(owner) => owner.handle(req).await,
            None => owner::error(503, "owner_list_unavailable"),
        },
        route::PATH
        | comments::PATH
        | next_comment::PATH
        | connection::PATH
        | robots::PATH
        | about::PATH => route::handle(app, req).await,
        "/health" if req.method == "GET" => health(&app).await,
        // Not a path this process serves: nginx gives the request to Node.
        _ => route::bad_gateway(),
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let cfg = config::Config::from_env()?;
    let connector = config::db_connector()?;
    let pool = db::Pool::new(connector, cfg.pool.clone());
    let mut state = route::App::new(&cfg, pool);
    if std::env::var("POLIS_API_COMMENT_READS").ok().as_deref() == Some("1") {
        let dsn = std::env::var("POLIS_API_COMMENTS_DATABASE_URL")
            .context("POLIS_API_COMMENTS_DATABASE_URL is required for comment reads")?;
        let read_dsn = std::env::var("READ_ONLY_DATABASE_URL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| dsn.clone());
        state.comments_count_db = Some(db::Pool::new(
            config::connector_for_dsn(&read_dsn, "polis-api-comment-count/1")?,
            db::Limits {
                size: 1,
                acquire_timeout: std::time::Duration::from_millis(100),
                statement_timeout: std::time::Duration::from_millis(1000),
                max_lifetime: std::time::Duration::from_secs(300),
            },
        ));
        state.comments_db = Some(db::Pool::new(
            config::connector_for_dsn(&dsn, "polis-api-comments/1")?,
            db::Limits {
                size: 2,
                acquire_timeout: std::time::Duration::from_millis(100),
                statement_timeout: std::time::Duration::from_millis(1000),
                max_lifetime: std::time::Duration::from_secs(300),
            },
        ));
    }
    if std::env::var("POLIS_API_NEXT_COMMENT_READS")
        .ok()
        .as_deref()
        == Some("1")
    {
        let dsn = std::env::var("POLIS_API_NEXT_COMMENT_DATABASE_URL")
            .context("POLIS_API_NEXT_COMMENT_DATABASE_URL is required for next comment reads")?;
        state.next_comment_db = Some(db::Pool::new(
            config::connector_for_dsn(&dsn, "polis-api-next-comment/1")?,
            next_comment::pool_limits(),
        ));
        // Must match Node. Fail closed unless the shared setting explicitly
        // disables topical routing; the initial-statement branch bypasses it.
        state.next_comment_plain =
            std::env::var("TOPICAL_COMMENT_RATIO").ok().as_deref() == Some("0");
    }
    if std::env::var("POLIS_API_PARTICIPANT_READS").ok().as_deref() == Some("1") {
        let path = std::env::var("POLIS_API_PARTICIPANT_PUBLIC_KEY_FILE")
            .context("participant public key file required")?;
        let key = std::fs::read(path).context("read participant public key")?;
        state.participant_verifier = Some(Arc::new(
            polis_auth::participant::Verifier::new(
                &key,
                &std::env::var("POLIS_JWT_ISSUER")?,
                &std::env::var("POLIS_JWT_AUDIENCE")?,
            )
            .context("invalid participant verifier configuration")?,
        ));
    }
    state.connection_reads =
        std::env::var("POLIS_API_CONNECTION_READS").ok().as_deref() == Some("1");
    state.robots_reads = std::env::var("POLIS_API_ROBOTS_READS").ok().as_deref() == Some("1");
    state.about_reads = std::env::var("POLIS_API_ABOUT_READS").ok().as_deref() == Some("1");
    let app = Arc::new(state);
    let owner = owner::App::from_env()?;
    let listener = tokio::net::TcpListener::bind(&cfg.listen)
        .await
        .with_context(|| format!("bind {}", cfg.listen))?;
    eprintln!(
        "{{\"event\":\"polis_api_listening\",\"addr\":\"{}\",\"math_env\":{:?}}}",
        listener.local_addr()?,
        cfg.math_env
    );
    let handler = Arc::new(move |req: Request| dispatch(app.clone(), owner.clone(), req));
    tokio::select! {
        r = http::serve(listener, handler) => r,
        _ = tokio::signal::ctrl_c() => Ok(()),
    }
}
