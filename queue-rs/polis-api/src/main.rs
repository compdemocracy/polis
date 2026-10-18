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
mod contexts;
mod cors;
mod database;
mod db;
mod domain_whitelist;
mod http;
mod hybrid_read;
mod js;
mod legacy_pca;
mod lru;
mod metadata_answers;
mod metadata_choices;
mod metadata_questions;
mod metadata_read;
mod negotiate;
mod next_comment;
mod owner;
mod params;
mod pca;
mod recent_activity;
mod recent_started;
mod robots;
mod route;
mod treevite_read;
mod treevite_waves;

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
    body.set(
        "databaseServed",
        js::Js::Num(app.database_served.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "databaseFallback",
        js::Js::Num(app.database_fallback.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "contextsServed",
        js::Js::Num(app.contexts_served.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "contextsFallback",
        js::Js::Num(app.contexts_fallback.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "domainWhitelistServed",
        js::Js::Num(app.domain_whitelist_served.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "domainWhitelistFallback",
        js::Js::Num(app.domain_whitelist_fallback.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "metadataQuestionsServed",
        js::Js::Num(app.metadata_questions_served.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "metadataQuestionsFallback",
        js::Js::Num(app.metadata_questions_fallback.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "metadataAnswersServed",
        js::Js::Num(app.metadata_answers_served.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "metadataAnswersFallback",
        js::Js::Num(app.metadata_answers_fallback.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "metadataReadServed",
        js::Js::Num(app.metadata_read_served.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "metadataReadFallback",
        js::Js::Num(app.metadata_read_fallback.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "metadataChoicesServed",
        js::Js::Num(app.metadata_choices_served.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "metadataChoicesFallback",
        js::Js::Num(app.metadata_choices_fallback.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "recentStartedServed",
        js::Js::Num(app.recent_started_served.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "recentStartedFallback",
        js::Js::Num(app.recent_started_fallback.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "recentActivityServed",
        js::Js::Num(app.recent_activity_served.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "recentActivityFallback",
        js::Js::Num(app.recent_activity_fallback.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "legacyPcaServed",
        js::Js::Num(app.legacy_pca_served.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "legacyPcaFallback",
        js::Js::Num(app.legacy_pca_fallback.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "treeviteWavesServed",
        js::Js::Num(app.treevite_waves_served.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "treeviteWavesFallback",
        js::Js::Num(app.treevite_waves_fallback.load(Ordering::Relaxed) as f64),
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
        | about::PATH
        | legacy_pca::PATH
        | database::PATH
        | contexts::PATH
        | domain_whitelist::PATH
        | metadata_questions::PATH
        | treevite_waves::PATH
        | metadata_choices::PATH
        | recent_started::PATH
        | recent_activity::PATH
        | metadata_read::PATH
        | metadata_answers::PATH => route::handle(app, req).await,
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
    if std::env::var("POLIS_API_DATABASE_READS").ok().as_deref() == Some("1") {
        let dsn = std::env::var("POLIS_API_DATABASE_PROBE_URL")
            .context("POLIS_API_DATABASE_PROBE_URL is required for database probe reads")?;
        state.database_db = Some(db::Pool::new(
            config::connector_for_dsn(&dsn, "polis-api-database-probe/1")?,
            database::pool_limits(),
        ));
    }
    if std::env::var("POLIS_API_CONTEXTS_READS").ok().as_deref() == Some("1") {
        let dsn = std::env::var("POLIS_API_CONTEXTS_DATABASE_URL")
            .context("POLIS_API_CONTEXTS_DATABASE_URL required")?;
        let read_dsn = std::env::var("READ_ONLY_DATABASE_URL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| dsn.clone());
        state.contexts_db = Some(db::Pool::new(
            config::connector_for_dsn(&read_dsn, "polis-api-contexts/1")?,
            contexts::pool_limits(),
        ));
        state.contexts_auth_db = Some(db::Pool::new(
            config::connector_for_dsn(&dsn, "polis-api-contexts-auth/1")?,
            contexts::pool_limits(),
        ));
        state.read_oidc = hybrid_read::Oidc::from_env()?;
    }
    if std::env::var("POLIS_API_DOMAIN_WHITELIST_READS")
        .ok()
        .as_deref()
        == Some("1")
    {
        let dsn = std::env::var("POLIS_API_DOMAIN_WHITELIST_DATABASE_URL")
            .context("POLIS_API_DOMAIN_WHITELIST_DATABASE_URL required")?;
        state.domain_whitelist_db = Some(db::Pool::new(
            config::connector_for_dsn(&dsn, "polis-api-domain-whitelist/1")?,
            domain_whitelist::pool_limits(),
        ));
        state.domain_whitelist_auth_db = Some(db::Pool::new(
            config::connector_for_dsn(&dsn, "polis-api-domain-whitelist-auth/1")?,
            domain_whitelist::pool_limits(),
        ));
        state.read_oidc = hybrid_read::Oidc::from_env()?;
    }
    if std::env::var("POLIS_API_METADATA_QUESTIONS_READS")
        .ok()
        .as_deref()
        == Some("1")
    {
        let dsn = std::env::var("POLIS_API_METADATA_QUESTIONS_DATABASE_URL")
            .context("POLIS_API_METADATA_QUESTIONS_DATABASE_URL required")?;
        let read_dsn = std::env::var("READ_ONLY_DATABASE_URL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| dsn.clone());
        state.metadata_questions_db = Some(db::Pool::new(
            config::connector_for_dsn(&read_dsn, "polis-api-metadata-questions/1")?,
            metadata_questions::pool_limits(),
        ));
        state.metadata_questions_auth_db = Some(db::Pool::new(
            config::connector_for_dsn(&dsn, "polis-api-metadata-questions-auth/1")?,
            metadata_questions::pool_limits(),
        ));
        state.read_oidc = hybrid_read::Oidc::from_env()?;
    }
    if std::env::var("POLIS_API_METADATA_ANSWERS_READS")
        .ok()
        .as_deref()
        == Some("1")
    {
        let dsn = std::env::var("POLIS_API_METADATA_ANSWERS_DATABASE_URL")
            .context("POLIS_API_METADATA_ANSWERS_DATABASE_URL required")?;
        let read_dsn = std::env::var("READ_ONLY_DATABASE_URL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| dsn.clone());
        state.metadata_answers_db = Some(db::Pool::new(
            config::connector_for_dsn(&read_dsn, "polis-api-metadata-answers/1")?,
            metadata_answers::pool_limits(),
        ));
        state.metadata_answers_auth_db = Some(db::Pool::new(
            config::connector_for_dsn(&dsn, "polis-api-metadata-answers-auth/1")?,
            metadata_answers::pool_limits(),
        ));
        state.read_oidc = hybrid_read::Oidc::from_env()?;
    }
    if std::env::var("POLIS_API_METADATA_READS").ok().as_deref() == Some("1") {
        let dsn = std::env::var("POLIS_API_METADATA_DATABASE_URL")
            .context("POLIS_API_METADATA_DATABASE_URL required")?;
        let read_dsn = std::env::var("READ_ONLY_DATABASE_URL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| dsn.clone());
        state.metadata_read_db = Some(db::Pool::new(
            config::connector_for_dsn(&read_dsn, "polis-api-metadata-read/1")?,
            metadata_read::pool_limits(),
        ));
        state.metadata_read_auth_db = Some(db::Pool::new(
            config::connector_for_dsn(&dsn, "polis-api-metadata-read-auth/1")?,
            metadata_read::pool_limits(),
        ));
        state.read_oidc = hybrid_read::Oidc::from_env()?;
    }
    if std::env::var("POLIS_API_METADATA_CHOICES_READS")
        .ok()
        .as_deref()
        == Some("1")
    {
        let dsn = std::env::var("POLIS_API_METADATA_CHOICES_DATABASE_URL")
            .context("POLIS_API_METADATA_CHOICES_DATABASE_URL required")?;
        let read_dsn = std::env::var("READ_ONLY_DATABASE_URL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| dsn.clone());
        state.metadata_choices_db = Some(db::Pool::new(
            config::connector_for_dsn(&read_dsn, "polis-api-metadata-choices/1")?,
            metadata_choices::pool_limits(),
        ));
        state.metadata_choices_auth_db = Some(db::Pool::new(
            config::connector_for_dsn(&dsn, "polis-api-metadata-choices-auth/1")?,
            metadata_choices::pool_limits(),
        ));
        state.read_oidc = hybrid_read::Oidc::from_env()?;
    }
    if std::env::var("POLIS_API_RECENT_STARTED_READS")
        .ok()
        .as_deref()
        == Some("1")
    {
        let dsn = std::env::var("POLIS_API_RECENT_STARTED_DATABASE_URL")
            .context("POLIS_API_RECENT_STARTED_DATABASE_URL required")?;
        let read_dsn = std::env::var("READ_ONLY_DATABASE_URL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| dsn.clone());
        state.recent_started_db = Some(db::Pool::new(
            config::connector_for_dsn(&read_dsn, "polis-api-recent-started/1")?,
            recent_started::pool_limits(),
        ));
        state.recent_started_auth_db = Some(db::Pool::new(
            config::connector_for_dsn(&dsn, "polis-api-recent-started-auth/1")?,
            recent_started::pool_limits(),
        ));
        state.read_oidc = hybrid_read::Oidc::from_env()?;
        let admins = std::env::var("ADMIN_UIDS")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "[]".into());
        state.legacy_admin_uids = recent_started::admin_uids(&admins)?;
    }
    if std::env::var("POLIS_API_RECENT_ACTIVITY_READS")
        .ok()
        .as_deref()
        == Some("1")
    {
        let dsn = std::env::var("POLIS_API_RECENT_ACTIVITY_DATABASE_URL")
            .context("POLIS_API_RECENT_ACTIVITY_DATABASE_URL required")?;
        let read_dsn = std::env::var("READ_ONLY_DATABASE_URL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| dsn.clone());
        state.recent_activity_db = Some(db::Pool::new(
            config::connector_for_dsn(&read_dsn, "polis-api-recent-activity/1")?,
            recent_activity::pool_limits(),
        ));
        state.recent_activity_auth_db = Some(db::Pool::new(
            config::connector_for_dsn(&dsn, "polis-api-recent-activity-auth/1")?,
            recent_activity::pool_limits(),
        ));
        state.read_oidc = hybrid_read::Oidc::from_env()?;
        let admins = std::env::var("ADMIN_UIDS")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "[]".into());
        state.legacy_admin_uids = recent_started::admin_uids(&admins)?;
    }
    state.legacy_pca_reads =
        std::env::var("POLIS_API_LEGACY_PCA_READS").ok().as_deref() == Some("1");
    if std::env::var("POLIS_API_TREEVITE_WAVES_READS")
        .ok()
        .as_deref()
        == Some("1")
    {
        let dsn = std::env::var("POLIS_API_TREEVITE_WAVES_DATABASE_URL")
            .context("POLIS_API_TREEVITE_WAVES_DATABASE_URL required")?;
        let read_dsn = std::env::var("READ_ONLY_DATABASE_URL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| dsn.clone());
        state.treevite_waves_db = Some(db::Pool::new(
            config::connector_for_dsn(&read_dsn, "polis-api-treevite-waves/1")?,
            treevite_waves::pool_limits(),
        ));
        state.treevite_waves_auth_db = Some(db::Pool::new(
            config::connector_for_dsn(&dsn, "polis-api-treevite-waves-auth/1")?,
            treevite_waves::pool_limits(),
        ));
        state.read_oidc = hybrid_read::Oidc::from_env()?;
        let admins = std::env::var("ADMIN_UIDS")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "[]".into());
        state.legacy_admin_uids = recent_started::admin_uids(&admins)?;
    }
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
