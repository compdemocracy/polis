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
    pub domain_whitelist_db: Option<Arc<Pool>>,
    pub domain_whitelist_auth_db: Option<Arc<Pool>>,
    pub domain_whitelist_served: AtomicU64,
    pub domain_whitelist_fallback: AtomicU64,
    pub metadata_questions_db: Option<Arc<Pool>>,
    pub metadata_questions_auth_db: Option<Arc<Pool>>,
    pub metadata_questions_served: AtomicU64,
    pub metadata_questions_fallback: AtomicU64,
    pub metadata_answers_db: Option<Arc<Pool>>,
    pub metadata_answers_auth_db: Option<Arc<Pool>>,
    pub metadata_answers_served: AtomicU64,
    pub metadata_answers_fallback: AtomicU64,
    pub metadata_read_db: Option<Arc<Pool>>,
    pub metadata_read_auth_db: Option<Arc<Pool>>,
    pub metadata_read_served: AtomicU64,
    pub metadata_read_fallback: AtomicU64,
    pub metadata_choices_db: Option<Arc<Pool>>,
    pub metadata_choices_auth_db: Option<Arc<Pool>>,
    pub metadata_choices_served: AtomicU64,
    pub metadata_choices_fallback: AtomicU64,
    pub legacy_admin_uids: Vec<i32>,
    pub recent_started_db: Option<Arc<Pool>>,
    pub recent_started_auth_db: Option<Arc<Pool>>,
    pub recent_started_served: AtomicU64,
    pub recent_started_fallback: AtomicU64,
    pub recent_activity_db: Option<Arc<Pool>>,
    pub recent_activity_auth_db: Option<Arc<Pool>>,
    pub recent_activity_served: AtomicU64,
    pub recent_activity_fallback: AtomicU64,
    pub legacy_pca_reads: bool,
    pub legacy_pca_served: AtomicU64,
    pub legacy_pca_fallback: AtomicU64,
    pub treevite_waves_db: Option<Arc<Pool>>,
    pub treevite_waves_auth_db: Option<Arc<Pool>>,
    pub treevite_waves_served: AtomicU64,
    pub treevite_waves_fallback: AtomicU64,
    pub treevite_invites_db: Option<Arc<Pool>>,
    pub treevite_invites_auth_db: Option<Arc<Pool>>,
    pub treevite_invites_served: AtomicU64,
    pub treevite_invites_fallback: AtomicU64,
    pub treevite_csv_db: Option<Arc<Pool>>,
    pub treevite_csv_auth_db: Option<Arc<Pool>>,
    pub treevite_csv_served: AtomicU64,
    pub treevite_csv_fallback: AtomicU64,
    pub conversation_preload_db: Option<Arc<Pool>>,
    pub conversation_preload_served: AtomicU64,
    pub conversation_preload_fallback: AtomicU64,
    pub participation_read_db: Option<Arc<Pool>>,
    pub participation_read_auth_db: Option<Arc<Pool>>,
    pub participation_read_served: AtomicU64,
    pub participation_read_fallback: AtomicU64,
    pub all_conversations_db: Option<Arc<Pool>>,
    pub all_conversations_auth_db: Option<Arc<Pool>>,
    pub all_conversations_served: AtomicU64,
    pub all_conversations_fallback: AtomicU64,
    pub reports_read_db: Option<Arc<Pool>>,
    pub reports_read_auth_db: Option<Arc<Pool>>,
    pub reports_read_served: AtomicU64,
    pub reports_read_fallback: AtomicU64,
    pub bid_to_pid_db: Option<Arc<Pool>>,
    pub bid_to_pid_auth_db: Option<Arc<Pool>>,
    pub bid_to_pid_served: AtomicU64,
    pub bid_to_pid_fallback: AtomicU64,
    pub conversation_stats_db: Option<Arc<Pool>>,
    pub conversation_stats_auth_db: Option<Arc<Pool>>,
    pub conversation_stats_served: AtomicU64,
    pub conversation_stats_fallback: AtomicU64,
    pub topic_selections_db: Option<Arc<Pool>>,
    pub topic_selections_served: AtomicU64,
    pub topic_selections_fallback: AtomicU64,
    pub treevite_my_invites_db: Option<Arc<Pool>>,
    pub treevite_my_invites_auth_db: Option<Arc<Pool>>,
    pub treevite_my_invites_served: AtomicU64,
    pub treevite_my_invites_fallback: AtomicU64,
    pub topic_prioritize_db: Option<Arc<Pool>>,
    pub topic_prioritize_served: AtomicU64,
    pub topic_prioritize_fallback: AtomicU64,
    pub legacy_conversations_db: Option<Arc<Pool>>,
    pub legacy_conversations_auth_db: Option<Arc<Pool>>,
    pub legacy_conversations_served: AtomicU64,
    pub legacy_conversations_fallback: AtomicU64,
    pub treevite_me_db: Option<Arc<Pool>>,
    pub treevite_me_auth_db: Option<Arc<Pool>>,
    pub treevite_me_served: AtomicU64,
    pub treevite_me_fallback: AtomicU64,
    pub xid_report_db: Option<Arc<Pool>>,
    pub xid_report_auth_db: Option<Arc<Pool>>,
    pub xid_report_served: AtomicU64,
    pub xid_report_fallback: AtomicU64,
    pub einvites_read_db: Option<Arc<Pool>>,
    pub einvites_read_served: AtomicU64,
    pub einvites_read_fallback: AtomicU64,
    pub contexts_db: Option<Arc<Pool>>,
    pub contexts_auth_db: Option<Arc<Pool>>,
    pub read_oidc: Option<Arc<crate::hybrid_read::Oidc>>,
    pub contexts_served: AtomicU64,
    pub contexts_fallback: AtomicU64,
    pub delphi_reports_db: Option<Arc<Pool>>,
    pub delphi_reports_served: AtomicU64,
    pub delphi_reports_fallback: AtomicU64,
    pub delphi_visualizations_db: Option<Arc<Pool>>,
    pub delphi_visualizations_served: AtomicU64,
    pub delphi_visualizations_fallback: AtomicU64,
    pub topic_stats_db: Option<Arc<Pool>>,
    pub topic_stats_served: AtomicU64,
    pub topic_stats_fallback: AtomicU64,
    pub delphi_run_db: Option<Arc<Pool>>,
    pub delphi_run_auth_db: Option<Arc<Pool>>,
    pub delphi_run_env: String,
    pub delphi_run_served: AtomicU64,
    pub delphi_run_fallback: AtomicU64,
    pub delphi_result_db: Option<Arc<Pool>>,
    pub delphi_result_auth_db: Option<Arc<Pool>>,
    pub delphi_result_env: String,
    pub delphi_result_served: AtomicU64,
    pub delphi_result_fallback: AtomicU64,
    pub collective_statement_db: Option<Arc<Pool>>,
    pub collective_statement_served: AtomicU64,
    pub collective_statement_fallback: AtomicU64,
    pub delphi_read_db: Option<Arc<Pool>>,
    pub delphi_read_served: AtomicU64,
    pub delphi_read_fallback: AtomicU64,
    pub database_db: Option<Arc<Pool>>,
    pub database_served: AtomicU64,
    pub database_fallback: AtomicU64,
    pub settings_page_reads: bool,
    pub settings_page_served: AtomicU64,
    pub settings_page_fallback: AtomicU64,
    pub other_conversations_page: Option<crate::admin_page::Client>,
    pub other_conversations_page_served: AtomicU64,
    pub other_conversations_page_fallback: AtomicU64,
    pub integrate_page: Option<crate::admin_page::Client>,
    pub integrate_page_served: AtomicU64,
    pub integrate_page_fallback: AtomicU64,
    pub admin_page: Option<crate::admin_page::Client>,
    pub admin_page_served: AtomicU64,
    pub admin_page_fallback: AtomicU64,
    pub user_logout_page_reads: bool,
    pub user_logout_page_served: AtomicU64,
    pub user_logout_page_fallback: AtomicU64,
    pub user_login_page_reads: bool,
    pub user_login_page_served: AtomicU64,
    pub user_login_page_fallback: AtomicU64,
    pub user_create_page_reads: bool,
    pub user_create_page_served: AtomicU64,
    pub user_create_page_fallback: AtomicU64,
    pub create_page_reads: bool,
    pub create_page_served: AtomicU64,
    pub create_page_fallback: AtomicU64,
    pub ops_catchall_reads: bool,
    pub ops_catchall_served: AtomicU64,
    pub ops_catchall_fallback: AtomicU64,
    pub ops_page_reads: bool,
    pub ops_page_served: AtomicU64,
    pub ops_page_fallback: AtomicU64,
    pub ops_whoami_reads: bool,
    pub ops_whoami_served: AtomicU64,
    pub ops_whoami_fallback: AtomicU64,
    pub about_reads: bool,
    pub about_served: AtomicU64,
    pub about_fallback: AtomicU64,
    pub robots_reads: bool,
    pub robots_served: AtomicU64,
    pub robots_fallback: AtomicU64,
    pub connection_reads: bool,
    pub connection_served: AtomicU64,
    pub connection_fallback: AtomicU64,
    pub participant_verifier: Option<Arc<polis_auth::participant::Verifier>>,
    pub participant_served: AtomicU64,
    pub participant_fallback: AtomicU64,
    pub next_comment_served: AtomicU64,
    pub next_comment_fallback: AtomicU64,
    pub next_comment_priorities: Arc<crate::next_comment::Priorities>,
    pub next_comment_db: Option<Arc<Pool>>,
    pub next_comment_plain: bool,
    pub comments_db: Option<Arc<Pool>>,
    pub comments_count_db: Option<Arc<Pool>>,
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
            domain_whitelist_db: None,
            domain_whitelist_auth_db: None,
            domain_whitelist_served: AtomicU64::new(0),
            domain_whitelist_fallback: AtomicU64::new(0),
            metadata_questions_db: None,
            metadata_questions_auth_db: None,
            metadata_questions_served: AtomicU64::new(0),
            metadata_questions_fallback: AtomicU64::new(0),
            metadata_answers_db: None,
            metadata_answers_auth_db: None,
            metadata_answers_served: AtomicU64::new(0),
            metadata_answers_fallback: AtomicU64::new(0),
            metadata_read_db: None,
            metadata_read_auth_db: None,
            metadata_read_served: AtomicU64::new(0),
            metadata_read_fallback: AtomicU64::new(0),
            metadata_choices_db: None,
            metadata_choices_auth_db: None,
            metadata_choices_served: AtomicU64::new(0),
            metadata_choices_fallback: AtomicU64::new(0),
            legacy_admin_uids: Vec::new(),
            recent_started_db: None,
            recent_started_auth_db: None,
            recent_started_served: AtomicU64::new(0),
            recent_started_fallback: AtomicU64::new(0),
            recent_activity_db: None,
            recent_activity_auth_db: None,
            recent_activity_served: AtomicU64::new(0),
            recent_activity_fallback: AtomicU64::new(0),
            legacy_pca_reads: false,
            legacy_pca_served: AtomicU64::new(0),
            legacy_pca_fallback: AtomicU64::new(0),
            treevite_waves_db: None,
            treevite_waves_auth_db: None,
            treevite_waves_served: AtomicU64::new(0),
            treevite_waves_fallback: AtomicU64::new(0),
            treevite_invites_db: None,
            treevite_invites_auth_db: None,
            treevite_invites_served: AtomicU64::new(0),
            treevite_invites_fallback: AtomicU64::new(0),
            treevite_csv_db: None,
            treevite_csv_auth_db: None,
            treevite_csv_served: AtomicU64::new(0),
            treevite_csv_fallback: AtomicU64::new(0),
            conversation_preload_db: None,
            conversation_preload_served: AtomicU64::new(0),
            conversation_preload_fallback: AtomicU64::new(0),
            participation_read_db: None,
            participation_read_auth_db: None,
            participation_read_served: AtomicU64::new(0),
            participation_read_fallback: AtomicU64::new(0),
            all_conversations_db: None,
            all_conversations_auth_db: None,
            all_conversations_served: AtomicU64::new(0),
            all_conversations_fallback: AtomicU64::new(0),
            reports_read_db: None,
            reports_read_auth_db: None,
            reports_read_served: AtomicU64::new(0),
            reports_read_fallback: AtomicU64::new(0),
            bid_to_pid_db: None,
            bid_to_pid_auth_db: None,
            bid_to_pid_served: AtomicU64::new(0),
            bid_to_pid_fallback: AtomicU64::new(0),
            conversation_stats_db: None,
            conversation_stats_auth_db: None,
            conversation_stats_served: AtomicU64::new(0),
            conversation_stats_fallback: AtomicU64::new(0),
            topic_selections_db: None,
            topic_selections_served: AtomicU64::new(0),
            topic_selections_fallback: AtomicU64::new(0),
            treevite_my_invites_db: None,
            treevite_my_invites_auth_db: None,
            treevite_my_invites_served: AtomicU64::new(0),
            treevite_my_invites_fallback: AtomicU64::new(0),
            topic_prioritize_db: None,
            topic_prioritize_served: AtomicU64::new(0),
            topic_prioritize_fallback: AtomicU64::new(0),
            legacy_conversations_db: None,
            legacy_conversations_auth_db: None,
            legacy_conversations_served: AtomicU64::new(0),
            legacy_conversations_fallback: AtomicU64::new(0),
            treevite_me_db: None,
            treevite_me_auth_db: None,
            treevite_me_served: AtomicU64::new(0),
            treevite_me_fallback: AtomicU64::new(0),
            xid_report_db: None,
            xid_report_auth_db: None,
            xid_report_served: AtomicU64::new(0),
            xid_report_fallback: AtomicU64::new(0),
            einvites_read_db: None,
            einvites_read_served: AtomicU64::new(0),
            einvites_read_fallback: AtomicU64::new(0),
            contexts_db: None,
            contexts_auth_db: None,
            read_oidc: None,
            contexts_served: AtomicU64::new(0),
            contexts_fallback: AtomicU64::new(0),
            delphi_reports_db: None,
            delphi_reports_served: AtomicU64::new(0),
            delphi_reports_fallback: AtomicU64::new(0),
            delphi_visualizations_db: None,
            delphi_visualizations_served: AtomicU64::new(0),
            delphi_visualizations_fallback: AtomicU64::new(0),
            topic_stats_db: None,
            topic_stats_served: AtomicU64::new(0),
            topic_stats_fallback: AtomicU64::new(0),
            delphi_run_db: None,
            delphi_run_auth_db: None,
            delphi_run_env: String::new(),
            delphi_run_served: AtomicU64::new(0),
            delphi_run_fallback: AtomicU64::new(0),
            delphi_result_db: None,
            delphi_result_auth_db: None,
            delphi_result_env: String::new(),
            delphi_result_served: AtomicU64::new(0),
            delphi_result_fallback: AtomicU64::new(0),
            collective_statement_db: None,
            collective_statement_served: AtomicU64::new(0),
            collective_statement_fallback: AtomicU64::new(0),
            delphi_read_db: None,
            delphi_read_served: AtomicU64::new(0),
            delphi_read_fallback: AtomicU64::new(0),
            database_db: None,
            database_served: AtomicU64::new(0),
            database_fallback: AtomicU64::new(0),
            settings_page_reads: false,
            settings_page_served: AtomicU64::new(0),
            settings_page_fallback: AtomicU64::new(0),
            other_conversations_page: None,
            other_conversations_page_served: AtomicU64::new(0),
            other_conversations_page_fallback: AtomicU64::new(0),
            integrate_page: None,
            integrate_page_served: AtomicU64::new(0),
            integrate_page_fallback: AtomicU64::new(0),
            admin_page: None,
            admin_page_served: AtomicU64::new(0),
            admin_page_fallback: AtomicU64::new(0),
            user_logout_page_reads: false,
            user_logout_page_served: AtomicU64::new(0),
            user_logout_page_fallback: AtomicU64::new(0),
            user_login_page_reads: false,
            user_login_page_served: AtomicU64::new(0),
            user_login_page_fallback: AtomicU64::new(0),
            user_create_page_reads: false,
            user_create_page_served: AtomicU64::new(0),
            user_create_page_fallback: AtomicU64::new(0),
            create_page_reads: false,
            create_page_served: AtomicU64::new(0),
            create_page_fallback: AtomicU64::new(0),
            ops_catchall_reads: false,
            ops_catchall_served: AtomicU64::new(0),
            ops_catchall_fallback: AtomicU64::new(0),
            ops_page_reads: false,
            ops_page_served: AtomicU64::new(0),
            ops_page_fallback: AtomicU64::new(0),
            ops_whoami_reads: false,
            ops_whoami_served: AtomicU64::new(0),
            ops_whoami_fallback: AtomicU64::new(0),
            about_reads: false,
            about_served: AtomicU64::new(0),
            about_fallback: AtomicU64::new(0),
            robots_reads: false,
            robots_served: AtomicU64::new(0),
            robots_fallback: AtomicU64::new(0),
            connection_reads: false,
            connection_served: AtomicU64::new(0),
            connection_fallback: AtomicU64::new(0),
            participant_verifier: None,
            participant_served: AtomicU64::new(0),
            participant_fallback: AtomicU64::new(0),
            next_comment_served: AtomicU64::new(0),
            next_comment_fallback: AtomicU64::new(0),
            next_comment_priorities: Arc::new(crate::next_comment::Priorities::new(cfg.cache_size)),
            next_comment_db: None,
            next_comment_plain: false,
            comments_db: None,
            comments_count_db: None,
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
pub(crate) struct Res {
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
pub(crate) fn json(req: &Request, mut res: Res, value: &Js) -> Outgoing {
    if res.get("Content-Type").is_none() {
        res.set("Content-Type", "application/json");
    }
    send(req, res, Payload::Text(js::stringify(value)))
}

/// writeHead(302, {Location}) followed by end, after normal middleware.
pub(crate) fn redirect(req: &Request, mut res: Res, location: &str) -> Outgoing {
    res.status = 302;
    res.set("Location", location);
    finish(req, res, Ending::WriteHeadThenEnd, true)
}

/// Static HTML stream, after the route has bounded and checked its upstream.
pub(crate) fn admin_html(req: &Request, mut res: Res, chunks: Vec<Vec<u8>>) -> Outgoing {
    res.set("Content-Type", "text/html");
    let mut out = finish(req, res, Ending::WriteHeadThenEnd, true);
    out.body = Body::Chunked(chunks);
    out
}

/// Express status(...).json(...) retaining the normal response envelope.
pub(crate) fn json_status(req: &Request, mut res: Res, status: u16, value: &Js) -> Outgoing {
    res.status = status;
    json(req, res, value)
}

/// Express status(...).json(...) for a body already encoded by a contract
/// type (its own byte-stable JSON), retaining the normal response envelope.
pub(crate) fn json_text(req: &Request, mut res: Res, status: u16, body: String) -> Outgoing {
    res.status = status;
    if res.get("Content-Type").is_none() {
        res.set("Content-Type", "application/json");
    }
    send(req, res, Payload::Text(body))
}

/// Operations refusals use private cache headers before Express JSON encoding.
pub(crate) fn ops_not_found(req: &Request, mut res: Res, value: &Js) -> Outgoing {
    res.set("Cache-Control", "private, no-store");
    res.set("Vary", "Authorization");
    res.set("X-Content-Type-Options", "nosniff");
    json_status(req, res, 404, value)
}

/// Express status(...).end() without a response body.
pub(crate) fn empty_end(req: &Request, mut res: Res, status: u16) -> Outgoing {
    res.status = status;
    finish(req, res, Ending::End(Vec::new()), true)
}

/// Express text send, retaining the headers installed by writeDefaultHead.
pub(crate) fn text(req: &Request, res: Res, value: &str) -> Outgoing {
    send(req, res, Payload::Text(value.into()))
}

/// Express CSV send with its normal ETag, freshness and compression envelope.
pub(crate) fn csv(req: &Request, mut res: Res, value: &str) -> Outgoing {
    res.set("Content-Type", "text/csv");
    send(req, res, Payload::Text(value.into()))
}

/// `failJson(res, status, message)` (utils/fail.ts).
pub(crate) fn fail_json(req: &Request, mut res: Res, status: u16, message: Js) -> Outgoing {
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
pub(crate) fn get_int(value: &Js) -> Option<f64> {
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
    if req.path() == crate::domain_whitelist::PATH {
        if out.status == 502 {
            app.domain_whitelist_fallback
                .fetch_add(1, Ordering::Relaxed);
        } else {
            app.domain_whitelist_served.fetch_add(1, Ordering::Relaxed);
        }
    }
    if req.path() == crate::metadata_questions::PATH {
        if out.status == 502 {
            app.metadata_questions_fallback
                .fetch_add(1, Ordering::Relaxed);
        } else {
            app.metadata_questions_served
                .fetch_add(1, Ordering::Relaxed);
        }
    }
    if req.path() == crate::metadata_answers::PATH {
        if out.status == 502 {
            app.metadata_answers_fallback
                .fetch_add(1, Ordering::Relaxed);
        } else {
            app.metadata_answers_served.fetch_add(1, Ordering::Relaxed);
        }
    }
    if req.path() == crate::metadata_read::PATH {
        if out.status == 502 {
            app.metadata_read_fallback.fetch_add(1, Ordering::Relaxed);
        } else {
            app.metadata_read_served.fetch_add(1, Ordering::Relaxed);
        }
    }
    if req.path() == crate::metadata_choices::PATH {
        if out.status == 502 {
            app.metadata_choices_fallback
                .fetch_add(1, Ordering::Relaxed);
        } else {
            app.metadata_choices_served.fetch_add(1, Ordering::Relaxed);
        }
    }
    if req.path() == crate::recent_started::PATH {
        if out.status == 502 {
            app.recent_started_fallback.fetch_add(1, Ordering::Relaxed);
        } else {
            app.recent_started_served.fetch_add(1, Ordering::Relaxed);
        }
    }
    if req.path() == crate::recent_activity::PATH {
        if out.status == 502 {
            app.recent_activity_fallback.fetch_add(1, Ordering::Relaxed);
        } else {
            app.recent_activity_served.fetch_add(1, Ordering::Relaxed);
        }
    }
    if req.path() == crate::legacy_pca::PATH {
        if out.status == 502 {
            app.legacy_pca_fallback.fetch_add(1, Ordering::Relaxed);
        } else {
            app.legacy_pca_served.fetch_add(1, Ordering::Relaxed);
        }
    }
    if req.path() == crate::treevite_waves::PATH {
        if out.status == 502 {
            app.treevite_waves_fallback.fetch_add(1, Ordering::Relaxed);
        } else {
            app.treevite_waves_served.fetch_add(1, Ordering::Relaxed);
        }
    }
    if req.path() == crate::treevite_invites::PATH {
        if out.status == 502 {
            app.treevite_invites_fallback
                .fetch_add(1, Ordering::Relaxed);
        } else {
            app.treevite_invites_served.fetch_add(1, Ordering::Relaxed);
        }
    }
    if req.path() == crate::treevite_csv::PATH {
        if out.status == 502 {
            app.treevite_csv_fallback.fetch_add(1, Ordering::Relaxed);
        } else {
            app.treevite_csv_served.fetch_add(1, Ordering::Relaxed);
        }
    }
    if req.path() == crate::conversation_preload::PATH {
        if out.status == 502 {
            app.conversation_preload_fallback
                .fetch_add(1, Ordering::Relaxed);
        } else {
            app.conversation_preload_served
                .fetch_add(1, Ordering::Relaxed);
        }
    }
    if req.path() == crate::participation_read::PATH {
        if out.status == 502 {
            app.participation_read_fallback
                .fetch_add(1, Ordering::Relaxed);
        } else {
            app.participation_read_served
                .fetch_add(1, Ordering::Relaxed);
        }
    }
    if req.path() == crate::all_conversations::PATH {
        if out.status == 502 {
            app.all_conversations_fallback
                .fetch_add(1, Ordering::Relaxed);
        } else {
            app.all_conversations_served.fetch_add(1, Ordering::Relaxed);
        }
    }
    if req.path() == crate::reports_read::PATH {
        if out.status == 502 {
            app.reports_read_fallback.fetch_add(1, Ordering::Relaxed);
        } else {
            app.reports_read_served.fetch_add(1, Ordering::Relaxed);
        }
    }
    if req.path() == crate::bid_to_pid::PATH {
        if out.status == 502 {
            app.bid_to_pid_fallback.fetch_add(1, Ordering::Relaxed);
        } else {
            app.bid_to_pid_served.fetch_add(1, Ordering::Relaxed);
        }
    }
    if req.path() == crate::conversation_stats::PATH {
        if out.status == 502 {
            app.conversation_stats_fallback
                .fetch_add(1, Ordering::Relaxed);
        } else {
            app.conversation_stats_served
                .fetch_add(1, Ordering::Relaxed);
        }
    }
    if req.path() == crate::topic_selections::PATH {
        if out.status == 502 {
            app.topic_selections_fallback
                .fetch_add(1, Ordering::Relaxed);
        } else {
            app.topic_selections_served.fetch_add(1, Ordering::Relaxed);
        }
    }
    if req.path() == crate::treevite_my_invites::PATH {
        if out.status == 502 {
            app.treevite_my_invites_fallback
                .fetch_add(1, Ordering::Relaxed);
        } else {
            app.treevite_my_invites_served
                .fetch_add(1, Ordering::Relaxed);
        }
    }
    if req.path() == crate::topic_prioritize::PATH {
        if out.status == 502 {
            app.topic_prioritize_fallback
                .fetch_add(1, Ordering::Relaxed);
        } else {
            app.topic_prioritize_served.fetch_add(1, Ordering::Relaxed);
        }
    }
    if req.path() == crate::legacy_conversations::PATH {
        if out.status == 502 {
            app.legacy_conversations_fallback
                .fetch_add(1, Ordering::Relaxed);
        } else {
            app.legacy_conversations_served
                .fetch_add(1, Ordering::Relaxed);
        }
    }
    if req.path() == crate::treevite_me::PATH {
        if out.status == 502 {
            app.treevite_me_fallback.fetch_add(1, Ordering::Relaxed);
        } else {
            app.treevite_me_served.fetch_add(1, Ordering::Relaxed);
        }
    }
    if crate::xid_report::matches(req.path()) {
        if out.status == 502 {
            app.xid_report_fallback.fetch_add(1, Ordering::Relaxed);
        } else {
            app.xid_report_served.fetch_add(1, Ordering::Relaxed);
        }
    }
    if req.path() == crate::einvites_read::PATH {
        if out.status == 502 {
            app.einvites_read_fallback.fetch_add(1, Ordering::Relaxed);
        } else {
            app.einvites_read_served.fetch_add(1, Ordering::Relaxed);
        }
    }
    if req.path() == crate::contexts::PATH {
        if out.status == 502 {
            app.contexts_fallback.fetch_add(1, Ordering::Relaxed);
        } else {
            app.contexts_served.fetch_add(1, Ordering::Relaxed);
        }
    }
    if req.path() == crate::delphi_reports::PATH {
        if out.status == 502 {
            app.delphi_reports_fallback.fetch_add(1, Ordering::Relaxed);
        } else {
            app.delphi_reports_served.fetch_add(1, Ordering::Relaxed);
        }
    }
    if req.path() == crate::delphi_visualizations::PATH {
        if out.status == 502 {
            app.delphi_visualizations_fallback
                .fetch_add(1, Ordering::Relaxed);
        } else {
            app.delphi_visualizations_served
                .fetch_add(1, Ordering::Relaxed);
        }
    }
    if req.path() == crate::topic_stats::PATH {
        if out.status == 502 {
            app.topic_stats_fallback.fetch_add(1, Ordering::Relaxed);
        } else {
            app.topic_stats_served.fetch_add(1, Ordering::Relaxed);
        }
    }
    if req.path() == crate::delphi_run_read::PATH {
        if out.status == 502 {
            app.delphi_run_fallback.fetch_add(1, Ordering::Relaxed);
        } else {
            app.delphi_run_served.fetch_add(1, Ordering::Relaxed);
        }
    }
    if crate::delphi_result_read::matches(req.path()) {
        if out.status == 502 {
            app.delphi_result_fallback.fetch_add(1, Ordering::Relaxed);
        } else {
            app.delphi_result_served.fetch_add(1, Ordering::Relaxed);
        }
    }
    if req.path() == crate::collective_statement::PATH {
        if out.status == 502 {
            app.collective_statement_fallback
                .fetch_add(1, Ordering::Relaxed);
        } else {
            app.collective_statement_served
                .fetch_add(1, Ordering::Relaxed);
        }
    }
    if req.path() == crate::delphi_read::PATH {
        if out.status == 502 {
            app.delphi_read_fallback.fetch_add(1, Ordering::Relaxed);
        } else {
            app.delphi_read_served.fetch_add(1, Ordering::Relaxed);
        }
    }
    if req.path() == crate::database::PATH {
        if out.status == 502 {
            app.database_fallback.fetch_add(1, Ordering::Relaxed);
        } else {
            app.database_served.fetch_add(1, Ordering::Relaxed);
        }
    }
    if crate::settings_page::matches(req.path()) {
        if out.status == 502 {
            app.settings_page_fallback.fetch_add(1, Ordering::Relaxed);
        } else {
            app.settings_page_served.fetch_add(1, Ordering::Relaxed);
        }
    }
    if crate::other_conversations_page::matches(req.path()) {
        if out.status == 502 {
            app.other_conversations_page_fallback
                .fetch_add(1, Ordering::Relaxed);
        } else {
            app.other_conversations_page_served
                .fetch_add(1, Ordering::Relaxed);
        }
    }
    if crate::integrate_page::matches(req.path()) {
        if out.status == 502 {
            app.integrate_page_fallback.fetch_add(1, Ordering::Relaxed);
        } else {
            app.integrate_page_served.fetch_add(1, Ordering::Relaxed);
        }
    }
    if crate::admin_page::matches(req.path()) {
        if out.status == 502 {
            app.admin_page_fallback.fetch_add(1, Ordering::Relaxed);
        } else {
            app.admin_page_served.fetch_add(1, Ordering::Relaxed);
        }
    }
    if crate::user_logout_page::matches(req.path()) {
        if out.status == 502 {
            app.user_logout_page_fallback
                .fetch_add(1, Ordering::Relaxed);
        } else {
            app.user_logout_page_served.fetch_add(1, Ordering::Relaxed);
        }
    }
    if crate::user_login_page::matches(req.path()) {
        if out.status == 502 {
            app.user_login_page_fallback.fetch_add(1, Ordering::Relaxed);
        } else {
            app.user_login_page_served.fetch_add(1, Ordering::Relaxed);
        }
    }
    if crate::user_create_page::matches(req.path()) {
        if out.status == 502 {
            app.user_create_page_fallback
                .fetch_add(1, Ordering::Relaxed);
        } else {
            app.user_create_page_served.fetch_add(1, Ordering::Relaxed);
        }
    }
    if crate::create_page::matches(req.path()) {
        if out.status == 502 {
            app.create_page_fallback.fetch_add(1, Ordering::Relaxed);
        } else {
            app.create_page_served.fetch_add(1, Ordering::Relaxed);
        }
    }
    if crate::ops_catchall::matches(req.path()) {
        if out.status == 502 {
            app.ops_catchall_fallback.fetch_add(1, Ordering::Relaxed);
        } else {
            app.ops_catchall_served.fetch_add(1, Ordering::Relaxed);
        }
    }
    if crate::ops_page::matches(req.path()) {
        if out.status == 502 {
            app.ops_page_fallback.fetch_add(1, Ordering::Relaxed);
        } else {
            app.ops_page_served.fetch_add(1, Ordering::Relaxed);
        }
    }
    if req.path() == crate::ops_whoami::PATH {
        if out.status == 502 {
            app.ops_whoami_fallback.fetch_add(1, Ordering::Relaxed);
        } else {
            app.ops_whoami_served.fetch_add(1, Ordering::Relaxed);
        }
    }
    if req.path() == crate::about::PATH {
        if out.status == 502 {
            app.about_fallback.fetch_add(1, Ordering::Relaxed);
        } else {
            app.about_served.fetch_add(1, Ordering::Relaxed);
        }
    }
    if req.path() == crate::robots::PATH {
        if out.status == 502 {
            app.robots_fallback.fetch_add(1, Ordering::Relaxed);
        } else {
            app.robots_served.fetch_add(1, Ordering::Relaxed);
        }
    }
    if req.path() == crate::connection::PATH {
        if out.status == 502 {
            app.connection_fallback.fetch_add(1, Ordering::Relaxed);
        } else {
            app.connection_served.fetch_add(1, Ordering::Relaxed);
        }
    }
    if req.path() == crate::next_comment::PATH {
        if out.status == 502 {
            app.next_comment_fallback.fetch_add(1, Ordering::Relaxed);
        } else {
            app.next_comment_served.fetch_add(1, Ordering::Relaxed);
        }
    }
    if matches!(
        req.path(),
        crate::comments::PATH | crate::next_comment::PATH
    ) && req.headers.get("authorization").is_some()
    {
        if out.status == 502 {
            app.participant_fallback.fetch_add(1, Ordering::Relaxed);
        } else {
            app.participant_served.fetch_add(1, Ordering::Relaxed);
        }
    }
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
    http.set("route", Js::Str(req.path().into()));
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
    if crate::settings_page::matches(req.path()) && crate::settings_page::parse(app, req).is_none()
    {
        return bad_gateway();
    }
    if crate::other_conversations_page::matches(req.path())
        && crate::other_conversations_page::parse(app, req).is_none()
    {
        return bad_gateway();
    }
    if crate::integrate_page::matches(req.path())
        && crate::integrate_page::parse(app, req).is_none()
    {
        return bad_gateway();
    }
    if crate::admin_page::matches(req.path()) && crate::admin_page::parse(app, req).is_none() {
        return bad_gateway();
    }
    if crate::user_logout_page::matches(req.path())
        && crate::user_logout_page::parse(app, req).is_none()
    {
        return bad_gateway();
    }
    if crate::user_login_page::matches(req.path())
        && crate::user_login_page::parse(app, req).is_none()
    {
        return bad_gateway();
    }
    if crate::user_create_page::matches(req.path())
        && crate::user_create_page::parse(app, req).is_none()
    {
        return bad_gateway();
    }
    if crate::create_page::matches(req.path()) && crate::create_page::parse(app, req).is_none() {
        return bad_gateway();
    }
    if req.path() == crate::einvites_read::PATH && crate::einvites_read::parse(app, req).is_none() {
        return bad_gateway();
    }
    if crate::xid_report::matches(req.path()) && crate::xid_report::parse(app, req).is_none() {
        return bad_gateway();
    }
    if req.path() == crate::treevite_me::PATH && crate::treevite_me::parse(app, req).is_none() {
        return bad_gateway();
    }
    if req.path() == crate::treevite_my_invites::PATH
        && crate::treevite_my_invites::parse(app, req).is_none()
    {
        return bad_gateway();
    }
    if req.path() == crate::legacy_conversations::PATH
        && crate::legacy_conversations::parse(app, req).is_none()
    {
        return bad_gateway();
    }
    if req.path() == crate::topic_prioritize::PATH
        && crate::topic_prioritize::parse(app, req).is_none()
    {
        return bad_gateway();
    }
    if req.path() == crate::topic_selections::PATH
        && crate::topic_selections::parse(app, req).is_none()
    {
        return bad_gateway();
    }
    if req.path() == crate::conversation_stats::PATH
        && crate::conversation_stats::parse(app, req).is_none()
    {
        return bad_gateway();
    }
    if req.path() == crate::bid_to_pid::PATH && crate::bid_to_pid::parse(app, req).is_none() {
        return bad_gateway();
    }
    if req.path() == crate::reports_read::PATH && crate::reports_read::parse(app, req).is_none() {
        return bad_gateway();
    }
    if req.path() == crate::all_conversations::PATH
        && crate::all_conversations::parse(app, req).is_none()
    {
        return bad_gateway();
    }
    if req.path() == crate::participation_read::PATH
        && crate::participation_read::parse(app, req).is_none()
    {
        return bad_gateway();
    }
    if req.path() == crate::conversation_preload::PATH
        && crate::conversation_preload::parse(app, req).is_none()
    {
        return bad_gateway();
    }
    if req.path() == crate::treevite_csv::PATH && crate::treevite_csv::parse(app, req).is_none() {
        return bad_gateway();
    }
    if req.path() == crate::treevite_invites::PATH
        && crate::treevite_invites::parse(app, req).is_none()
    {
        return bad_gateway();
    }
    if req.path() == crate::treevite_waves::PATH && crate::treevite_waves::parse(app, req).is_none()
    {
        return bad_gateway();
    }
    if req.path() == crate::legacy_pca::PATH && crate::legacy_pca::parse(app, req).is_none() {
        return bad_gateway();
    }
    if req.path() == crate::recent_activity::PATH
        && crate::recent_activity::parse(app, req).is_none()
    {
        return bad_gateway();
    }
    if req.path() == crate::recent_started::PATH && crate::recent_started::parse(app, req).is_none()
    {
        return bad_gateway();
    }
    if req.path() == crate::metadata_choices::PATH
        && crate::metadata_choices::parse(app, req).is_none()
    {
        return bad_gateway();
    }
    if req.path() == crate::metadata_read::PATH && crate::metadata_read::parse(app, req).is_none() {
        return bad_gateway();
    }
    if req.path() == crate::metadata_answers::PATH
        && crate::metadata_answers::parse(app, req).is_none()
    {
        return bad_gateway();
    }
    if req.path() == crate::metadata_questions::PATH
        && crate::metadata_questions::parse(app, req).is_none()
    {
        return bad_gateway();
    }
    if req.path() == crate::domain_whitelist::PATH
        && crate::domain_whitelist::parse(app, req).is_none()
    {
        return bad_gateway();
    }
    if req.path() == crate::contexts::PATH && crate::contexts::parse(app, req).is_none() {
        return bad_gateway();
    }
    if req.path() == crate::delphi_reports::PATH && crate::delphi_reports::parse(app, req).is_none()
    {
        return bad_gateway();
    }
    if req.path() == crate::delphi_visualizations::PATH
        && crate::delphi_visualizations::parse(app, req).is_none()
    {
        return bad_gateway();
    }
    if req.path() == crate::topic_stats::PATH && crate::topic_stats::parse(app, req).is_none() {
        return bad_gateway();
    }
    if req.path() == crate::delphi_run_read::PATH
        && crate::delphi_run_read::parse(app, req).is_none()
    {
        return bad_gateway();
    }
    if crate::delphi_result_read::matches(req.path())
        && crate::delphi_result_read::parse(app, req).is_none()
    {
        return bad_gateway();
    }
    if req.path() == crate::collective_statement::PATH
        && crate::collective_statement::parse(app, req).is_none()
    {
        return bad_gateway();
    }
    if req.path() == crate::delphi_read::PATH && crate::delphi_read::parse(app, req).is_none() {
        return bad_gateway();
    }
    if req.path() == crate::database::PATH && crate::database::parse(app, req).is_none() {
        return bad_gateway();
    }
    if crate::ops_catchall::matches(req.path()) && crate::ops_catchall::parse(app, req).is_none() {
        return bad_gateway();
    }
    if crate::ops_page::matches(req.path()) && crate::ops_page::parse(app, req).is_none() {
        return bad_gateway();
    }
    if req.path() == crate::ops_whoami::PATH && crate::ops_whoami::parse(app, req).is_none() {
        return bad_gateway();
    }
    if req.path() == crate::about::PATH && crate::about::parse(app, req).is_none() {
        return bad_gateway();
    }
    if req.path() == crate::robots::PATH && crate::robots::parse(app, req).is_none() {
        return bad_gateway();
    }
    if req.path() == crate::connection::PATH && crate::connection::parse(app, req).is_none() {
        return bad_gateway();
    }
    if req.path() == crate::next_comment::PATH && !crate::next_comment::eligible(app, req) {
        return bad_gateway();
    }
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
    let origin = match if matches!(req.path(), crate::robots::PATH | crate::about::PATH)
        || crate::create_page::matches(req.path())
        || crate::settings_page::matches(req.path())
        || crate::other_conversations_page::matches(req.path())
        || crate::integrate_page::matches(req.path())
        || crate::admin_page::matches(req.path())
        || crate::user_logout_page::matches(req.path())
        || crate::user_login_page::matches(req.path())
        || crate::user_create_page::matches(req.path())
    {
        Ok(None)
    } else {
        app.cors.resolve(&req.headers)
    } {
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
    if req.path() == crate::next_comment::PATH {
        return crate::next_comment::handle(app, req, res).await;
    }
    if crate::settings_page::matches(req.path()) {
        return crate::settings_page::handle(app, req, res);
    }
    if crate::other_conversations_page::matches(req.path()) {
        return crate::other_conversations_page::handle(app, req, res).await;
    }
    if crate::integrate_page::matches(req.path()) {
        return crate::integrate_page::handle(app, req, res).await;
    }
    if crate::admin_page::matches(req.path()) {
        return crate::admin_page::handle(app, req, res).await;
    }
    if crate::user_logout_page::matches(req.path()) {
        return crate::user_logout_page::handle(app, req, res);
    }
    if crate::user_login_page::matches(req.path()) {
        return crate::user_login_page::handle(app, req, res);
    }
    if crate::user_create_page::matches(req.path()) {
        return crate::user_create_page::handle(app, req, res);
    }
    if crate::create_page::matches(req.path()) {
        return crate::create_page::handle(app, req, res);
    }
    if crate::ops_catchall::matches(req.path()) {
        return crate::ops_catchall::handle(app, req, res);
    }
    if crate::ops_page::matches(req.path()) {
        return crate::ops_page::handle(app, req, res);
    }
    if req.path() == crate::ops_whoami::PATH {
        return crate::ops_whoami::handle(app, req, res);
    }
    if req.path() == crate::about::PATH {
        return crate::about::handle(app, req, res);
    }
    if req.path() == crate::robots::PATH {
        return crate::robots::handle(app, req, res);
    }
    if req.path() == crate::connection::PATH {
        return crate::connection::handle(app, req, res);
    }
    if req.path() == crate::delphi_reports::PATH {
        return crate::delphi_reports::handle(app, req, res).await;
    }
    if req.path() == crate::delphi_visualizations::PATH {
        return crate::delphi_visualizations::handle(app, req, res).await;
    }
    if req.path() == crate::topic_stats::PATH {
        return crate::topic_stats::handle(app, req, res).await;
    }
    if req.path() == crate::delphi_run_read::PATH {
        return crate::delphi_run_read::handle(app, req, res).await;
    }
    if crate::delphi_result_read::matches(req.path()) {
        return crate::delphi_result_read::handle(app, req, res).await;
    }
    if req.path() == crate::collective_statement::PATH {
        return crate::collective_statement::handle(app, req, res).await;
    }
    if req.path() == crate::delphi_read::PATH {
        return crate::delphi_read::handle(app, req, res).await;
    }
    if req.path() == crate::database::PATH {
        return crate::database::handle(app, req, res).await;
    }
    if req.path() == crate::contexts::PATH {
        return crate::contexts::handle(app, req, res).await;
    }
    if req.path() == crate::einvites_read::PATH {
        return crate::einvites_read::handle(app, req, res).await;
    }
    if crate::xid_report::matches(req.path()) {
        return crate::xid_report::handle(app, req, res).await;
    }
    if req.path() == crate::treevite_me::PATH {
        return crate::treevite_me::handle(app, req, res).await;
    }
    if req.path() == crate::treevite_my_invites::PATH {
        return crate::treevite_my_invites::handle(app, req, res).await;
    }
    if req.path() == crate::legacy_conversations::PATH {
        return crate::legacy_conversations::handle(app, req, res).await;
    }
    if req.path() == crate::topic_prioritize::PATH {
        return crate::topic_prioritize::handle(app, req, res).await;
    }
    if req.path() == crate::topic_selections::PATH {
        return crate::topic_selections::handle(app, req, res).await;
    }
    if req.path() == crate::conversation_stats::PATH {
        return crate::conversation_stats::handle(app, req, res).await;
    }
    if req.path() == crate::bid_to_pid::PATH {
        return crate::bid_to_pid::handle(app, req, res).await;
    }
    if req.path() == crate::reports_read::PATH {
        return crate::reports_read::handle(app, req, res).await;
    }
    if req.path() == crate::all_conversations::PATH {
        return crate::all_conversations::handle(app, req, res).await;
    }
    if req.path() == crate::participation_read::PATH {
        return crate::participation_read::handle(app, req, res).await;
    }
    if req.path() == crate::conversation_preload::PATH {
        return crate::conversation_preload::handle(app, req, res).await;
    }
    if req.path() == crate::treevite_csv::PATH {
        return crate::treevite_csv::handle(app, req, res).await;
    }
    if req.path() == crate::treevite_invites::PATH {
        return crate::treevite_invites::handle(app, req, res).await;
    }
    if req.path() == crate::treevite_waves::PATH {
        return crate::treevite_waves::handle(app, req, res).await;
    }
    if req.path() == crate::legacy_pca::PATH {
        return crate::legacy_pca::handle(app, req, res);
    }
    if req.path() == crate::recent_activity::PATH {
        return crate::recent_activity::handle(app, req, res).await;
    }
    if req.path() == crate::recent_started::PATH {
        return crate::recent_started::handle(app, req, res).await;
    }
    if req.path() == crate::metadata_choices::PATH {
        return crate::metadata_choices::handle(app, req, res).await;
    }
    if req.path() == crate::metadata_read::PATH {
        return crate::metadata_read::handle(app, req, res).await;
    }
    if req.path() == crate::metadata_answers::PATH {
        return crate::metadata_answers::handle(app, req, res).await;
    }
    if req.path() == crate::metadata_questions::PATH {
        return crate::metadata_questions::handle(app, req, res).await;
    }
    if req.path() == crate::domain_whitelist::PATH {
        return crate::domain_whitelist::handle(app, req, res).await;
    }
    if req.path() == crate::comments::PATH {
        return crate::comments::handle(app, req, &body, res).await;
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

    #[tokio::test]
    async fn database_probe_is_off_and_unreachable_database_is_a_handoff() {
        let mut state = app(true);
        let probe = || {
            let mut req = request("GET", &[("host", "localhost")]);
            req.target = crate::database::PATH.into();
            req
        };
        assert!(state.database_db.is_none());
        assert_eq!(handle(state.clone(), probe()).await.status, 502);
        let pool = state.db.clone(); // This test's existing pool points at refused port 1.
        Arc::get_mut(&mut state).unwrap().database_db = Some(pool);
        assert_eq!(handle(state.clone(), probe()).await.status, 502);
        assert_eq!(state.database_served.load(Ordering::Relaxed), 0);
        assert_eq!(state.database_fallback.load(Ordering::Relaxed), 2);
        let mut secure = app(false);
        let pool = secure.db.clone();
        Arc::get_mut(&mut secure).unwrap().database_db = Some(pool);
        let redirect = handle(secure, probe()).await;
        assert_eq!(redirect.status, 302); // Ordinary HTTPS middleware, unlike testConnection.
    }

    #[cfg(feature = "db-tests")]
    #[tokio::test]
    async fn database_probe_reads_empty_and_populated_tables_and_sheds_contention() {
        use polis_queue_adapter::jobs::transport::Connector;
        use std::time::Duration;
        let url = std::env::var("POLIS_API_TEST_DATABASE_URL").unwrap();
        let schema = format!("database_probe_test_{}", std::process::id());
        let setup_url = url.clone();
        let setup_schema = schema.clone();
        tokio::task::spawn_blocking(move || {
            let mut c = postgres::Client::connect(&setup_url, postgres::NoTls).unwrap();
            c.batch_execute(&format!(
                "CREATE SCHEMA {setup_schema}; CREATE TABLE {setup_schema}.users (uid integer);"
            ))
            .unwrap();
        })
        .await
        .unwrap();
        let make_pool = || {
            let mut cfg: postgres::Config = url.parse().unwrap();
            cfg.options(&format!("-c search_path={schema}"));
            Pool::new(
                Connector::Plain(Box::new(cfg)),
                crate::database::pool_limits(),
            )
        };
        let probe_pool = make_pool();
        let participant_pool = make_pool();
        let mut state = app(true);
        Arc::get_mut(&mut state).unwrap().database_db = Some(probe_pool.clone());
        Arc::get_mut(&mut state).unwrap().next_comment_db = Some(participant_pool.clone());
        let probe = || {
            let mut req = request("GET", &[("host", "localhost")]);
            req.target = crate::database::PATH.into();
            req
        };
        let out = handle(state.clone(), probe()).await;
        assert_eq!(out.status, 200);
        assert!(matches!(out.body, Body::Fixed(ref b) if b == br#"{"status":"ok"}"#));
        let update_url = url.clone();
        let update_schema = schema.clone();
        tokio::task::spawn_blocking(move || {
            let mut c = postgres::Client::connect(&update_url, postgres::NoTls).unwrap();
            c.batch_execute(&format!("INSERT INTO {update_schema}.users VALUES (1)"))
                .unwrap();
        })
        .await
        .unwrap();
        assert_eq!(handle(state.clone(), probe()).await.status, 200);
        // Hold the probe's users table exclusively, then prove its stalled query
        // sheds itself while the separate next-statement pool can still answer.
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let lock_url = url.clone();
        let lock_schema = schema.clone();
        let lock = tokio::task::spawn_blocking(move || {
            let mut c = postgres::Client::connect(&lock_url, postgres::NoTls).unwrap();
            c.batch_execute(&format!(
                "BEGIN; LOCK TABLE {lock_schema}.users IN ACCESS EXCLUSIVE MODE"
            ))
            .unwrap();
            ready_tx.send(()).unwrap();
            release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            c.batch_execute("ROLLBACK").unwrap();
        });
        ready_rx.await.unwrap();
        let stalled_state = state.clone();
        let stalled = tokio::spawn(async move {
            let mut req = request("GET", &[("host", "localhost")]);
            req.target = crate::database::PATH.into();
            handle(stalled_state, req).await
        });
        assert!(participant_pool.ping().await);
        assert_eq!(stalled.await.unwrap().status, 502);
        release_tx.send(()).unwrap();
        lock.await.unwrap();
        assert_eq!(handle(state.clone(), probe()).await.status, 200);
        assert_eq!(state.database_served.load(Ordering::Relaxed), 3);
        assert_eq!(state.database_fallback.load(Ordering::Relaxed), 1);
        let err = probe_pool
            .with(|c| Ok(c.batch_execute("INSERT INTO users VALUES (2)")?))
            .await
            .unwrap_err();
        assert!(format!("{err:#}").contains("read-only"));
        tokio::task::spawn_blocking(move || {
            drop(state);
            drop(probe_pool);
            drop(participant_pool);
            let mut c = postgres::Client::connect(&url, postgres::NoTls).unwrap();
            c.batch_execute(&format!("DROP SCHEMA {schema} CASCADE"))
                .unwrap();
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn database_boundaries_are_counted_node_handoffs() {
        let mut state = app(true);
        let pool = state.db.clone();
        Arc::get_mut(&mut state).unwrap().database_db = Some(pool);
        for (method, target, headers) in [
            ("POST", crate::database::PATH, vec![]),
            ("OPTIONS", crate::database::PATH, vec![]),
            ("GET", "/api/v3/testDatabase?unknown=1", vec![]),
            (
                "GET",
                crate::database::PATH,
                vec![("authorization", "Bearer fixture")],
            ),
            ("GET", crate::database::PATH, vec![("cookie", "fixture=1")]),
            ("GET", crate::database::PATH, vec![("content-length", "1")]),
        ] {
            let mut req = request(method, &headers);
            req.target = target.into();
            assert_eq!(handle(state.clone(), req).await.status, 502);
        }
        assert_eq!(state.database_served.load(Ordering::Relaxed), 0);
        assert_eq!(state.database_fallback.load(Ordering::Relaxed), 6);
    }

    #[tokio::test]
    async fn contexts_read_is_off_and_unreachable_database_is_a_handoff() {
        let mut state = app(true);
        let probe = || {
            let mut req = request("GET", &[("host", "localhost")]);
            req.target = crate::contexts::PATH.into();
            req
        };
        assert!(state.contexts_db.is_none());
        assert_eq!(handle(state.clone(), probe()).await.status, 502);
        let pool = state.db.clone(); // This test's existing pool points at refused port 1.
        Arc::get_mut(&mut state).unwrap().contexts_db = Some(pool);
        assert_eq!(handle(state.clone(), probe()).await.status, 502);
        assert_eq!(state.contexts_served.load(Ordering::Relaxed), 0);
        assert_eq!(state.contexts_fallback.load(Ordering::Relaxed), 2);
        let mut secure = app(false);
        let pool = secure.db.clone();
        Arc::get_mut(&mut secure).unwrap().contexts_db = Some(pool);
        let redirect = handle(secure, probe()).await;
        assert_eq!(redirect.status, 302); // Ordinary HTTPS middleware, unlike testConnection.
    }

    #[cfg(feature = "db-tests")]
    #[tokio::test]
    async fn contexts_read_reads_empty_and_populated_tables_and_sheds_contention() {
        use polis_queue_adapter::jobs::transport::Connector;
        use std::time::Duration;
        let url = std::env::var("POLIS_API_TEST_DATABASE_URL").unwrap();
        let schema = format!("contexts_read_test_{}", std::process::id());
        let setup_url = url.clone();
        let setup_schema = schema.clone();
        tokio::task::spawn_blocking(move || {
            let mut c = postgres::Client::connect(&setup_url, postgres::NoTls).unwrap();
            c.batch_execute(&format!(
                "CREATE SCHEMA {setup_schema}; CREATE TABLE {setup_schema}.contexts (name text, is_public boolean);"
            ))
            .unwrap();
        })
        .await
        .unwrap();
        let make_pool = || {
            let mut cfg: postgres::Config = url.parse().unwrap();
            cfg.options(&format!("-c search_path={schema}"));
            Pool::new(
                Connector::Plain(Box::new(cfg)),
                crate::contexts::pool_limits(),
            )
        };
        let probe_pool = make_pool();
        let participant_pool = make_pool();
        let mut state = app(true);
        Arc::get_mut(&mut state).unwrap().contexts_db = Some(probe_pool.clone());
        Arc::get_mut(&mut state).unwrap().next_comment_db = Some(participant_pool.clone());
        let probe = || {
            let mut req = request("GET", &[("host", "localhost")]);
            req.target = crate::contexts::PATH.into();
            req
        };
        Arc::get_mut(&mut state).unwrap().contexts_auth_db = Some(make_pool());
        let out = handle(state.clone(), probe()).await;
        assert_eq!(out.status, 200);
        assert!(matches!(out.body, Body::Fixed(ref b) if b == b"[]"));
        let update_url = url.clone();
        let update_schema = schema.clone();
        tokio::task::spawn_blocking(move || {
            let mut c = postgres::Client::connect(&update_url, postgres::NoTls).unwrap();
            c.batch_execute(&format!("INSERT INTO {update_schema}.contexts VALUES ('visible',true),(NULL,true),('hidden',false)"))
                .unwrap();
        })
        .await
        .unwrap();
        let populated = handle(state.clone(), probe()).await;
        assert_eq!(populated.status, 200);
        assert!(
            matches!(populated.body, Body::Fixed(ref b) if b==br#"[{"name":"visible"},{"name":null}]"#)
        );
        // Hold the probe's contexts table exclusively, then prove its stalled query
        // sheds itself while the separate next-statement pool can still answer.
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let lock_url = url.clone();
        let lock_schema = schema.clone();
        let lock = tokio::task::spawn_blocking(move || {
            let mut c = postgres::Client::connect(&lock_url, postgres::NoTls).unwrap();
            c.batch_execute(&format!(
                "BEGIN; LOCK TABLE {lock_schema}.contexts IN ACCESS EXCLUSIVE MODE"
            ))
            .unwrap();
            ready_tx.send(()).unwrap();
            release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            c.batch_execute("ROLLBACK").unwrap();
        });
        ready_rx.await.unwrap();
        let stalled_state = state.clone();
        let stalled = tokio::spawn(async move {
            let mut req = request("GET", &[("host", "localhost")]);
            req.target = crate::contexts::PATH.into();
            handle(stalled_state, req).await
        });
        assert!(participant_pool.ping().await);
        assert_eq!(stalled.await.unwrap().status, 502);
        release_tx.send(()).unwrap();
        lock.await.unwrap();
        assert_eq!(handle(state.clone(), probe()).await.status, 200);
        assert_eq!(state.contexts_served.load(Ordering::Relaxed), 3);
        assert_eq!(state.contexts_fallback.load(Ordering::Relaxed), 1);
        let err = probe_pool
            .with(|c| Ok(c.batch_execute("INSERT INTO contexts VALUES ('write',true)")?))
            .await
            .unwrap_err();
        assert!(format!("{err:#}").contains("read-only"));
        tokio::task::spawn_blocking(move || {
            drop(state);
            drop(probe_pool);
            drop(participant_pool);
            let mut c = postgres::Client::connect(&url, postgres::NoTls).unwrap();
            c.batch_execute(&format!("DROP SCHEMA {schema} CASCADE"))
                .unwrap();
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn contexts_boundaries_are_counted_node_handoffs() {
        let mut state = app(true);
        let pool = state.db.clone();
        Arc::get_mut(&mut state).unwrap().contexts_db = Some(pool);
        for (method, target, headers) in [
            ("POST", crate::contexts::PATH, vec![]),
            ("OPTIONS", crate::contexts::PATH, vec![]),
            ("GET", "/api/v3/contexts?unknown=1", vec![]),
            (
                "GET",
                crate::contexts::PATH,
                vec![("authorization", "Bearer fixture")],
            ),
            ("GET", crate::contexts::PATH, vec![("cookie", "fixture=1")]),
            ("GET", crate::contexts::PATH, vec![("content-length", "1")]),
        ] {
            let mut req = request(method, &headers);
            req.target = target.into();
            assert_eq!(handle(state.clone(), req).await.status, 502);
        }
        assert_eq!(state.contexts_served.load(Ordering::Relaxed), 0);
        assert_eq!(state.contexts_fallback.load(Ordering::Relaxed), 6);
    }

    #[tokio::test]
    async fn domain_whitelist_is_off_and_unreachable_database_is_a_handoff() {
        let mut state = app(true);
        let probe = || {
            let mut req = request("GET", &[("host", "localhost")]);
            req.target = crate::domain_whitelist::PATH.into();
            req
        };
        assert!(state.domain_whitelist_db.is_none());
        assert_eq!(handle(state.clone(), probe()).await.status, 502);
        let pool = state.db.clone(); // This test's existing pool points at refused port 1.
        Arc::get_mut(&mut state).unwrap().domain_whitelist_db = Some(pool);
        assert_eq!(handle(state.clone(), probe()).await.status, 502);
        assert_eq!(state.domain_whitelist_served.load(Ordering::Relaxed), 0);
        assert_eq!(state.domain_whitelist_fallback.load(Ordering::Relaxed), 2);
        let mut secure = app(false);
        let pool = secure.db.clone();
        Arc::get_mut(&mut secure).unwrap().domain_whitelist_db = Some(pool);
        let redirect = handle(secure, probe()).await;
        assert_eq!(redirect.status, 302); // Ordinary HTTPS middleware, unlike testConnection.
    }

    #[tokio::test]
    async fn domain_whitelist_boundaries_are_counted_node_handoffs() {
        let mut state = app(true);
        let pool = state.db.clone();
        Arc::get_mut(&mut state).unwrap().domain_whitelist_db = Some(pool);
        for (method, target, headers) in [
            ("POST", crate::domain_whitelist::PATH, vec![]),
            ("OPTIONS", crate::domain_whitelist::PATH, vec![]),
            ("GET", "/api/v3/domainWhitelist?unknown=1", vec![]),
            (
                "GET",
                crate::domain_whitelist::PATH,
                vec![("authorization", "Bearer fixture")],
            ),
            (
                "GET",
                crate::domain_whitelist::PATH,
                vec![("cookie", "fixture=1")],
            ),
            (
                "GET",
                crate::domain_whitelist::PATH,
                vec![("content-length", "1")],
            ),
        ] {
            let mut req = request(method, &headers);
            req.target = target.into();
            assert_eq!(handle(state.clone(), req).await.status, 502);
        }
        assert_eq!(state.domain_whitelist_served.load(Ordering::Relaxed), 0);
        assert_eq!(state.domain_whitelist_fallback.load(Ordering::Relaxed), 6);
    }

    #[tokio::test]
    async fn metadata_questions_is_off_and_unreachable_database_is_a_handoff() {
        let mut state = app(true);
        let probe = || {
            let mut req = request("GET", &[("host", "localhost")]);
            req.target = format!(
                "{}?conversation_id=fixture",
                crate::metadata_questions::PATH
            );
            req
        };
        assert!(state.metadata_questions_db.is_none());
        assert_eq!(handle(state.clone(), probe()).await.status, 502);
        let pool = state.db.clone(); // This test's existing pool points at refused port 1.
        Arc::get_mut(&mut state).unwrap().metadata_questions_db = Some(pool);
        assert_eq!(handle(state.clone(), probe()).await.status, 502);
        assert_eq!(state.metadata_questions_served.load(Ordering::Relaxed), 0);
        assert_eq!(state.metadata_questions_fallback.load(Ordering::Relaxed), 2);
        let mut secure = app(false);
        let pool = secure.db.clone();
        Arc::get_mut(&mut secure).unwrap().metadata_questions_db = Some(pool);
        let redirect = handle(secure, probe()).await;
        assert_eq!(redirect.status, 302); // Ordinary HTTPS middleware, unlike testConnection.
    }

    #[tokio::test]
    async fn metadata_questions_boundaries_are_counted_node_handoffs() {
        let mut state = app(true);
        let pool = state.db.clone();
        Arc::get_mut(&mut state).unwrap().metadata_questions_db = Some(pool);
        for (method, target, headers) in [
            ("POST", crate::metadata_questions::PATH, vec![]),
            ("OPTIONS", crate::metadata_questions::PATH, vec![]),
            ("GET", "/api/v3/metadata/questions?unknown=1", vec![]),
            (
                "GET",
                crate::metadata_questions::PATH,
                vec![("authorization", "Bearer fixture")],
            ),
            (
                "GET",
                crate::metadata_questions::PATH,
                vec![("cookie", "fixture=1")],
            ),
            (
                "GET",
                crate::metadata_questions::PATH,
                vec![("content-length", "1")],
            ),
        ] {
            let mut req = request(method, &headers);
            req.target = target.into();
            assert_eq!(handle(state.clone(), req).await.status, 502);
        }
        assert_eq!(state.metadata_questions_served.load(Ordering::Relaxed), 0);
        assert_eq!(state.metadata_questions_fallback.load(Ordering::Relaxed), 6);
    }

    #[tokio::test]
    async fn conversation_preload_is_off_and_unreachable_database_is_a_handoff() {
        let mut state = app(true);
        let probe = || {
            let mut req = request("GET", &[("host", "localhost")]);
            req.target = format!(
                "{}?conversation_id=fixture",
                crate::conversation_preload::PATH
            );
            req
        };
        assert!(state.conversation_preload_db.is_none());
        assert_eq!(handle(state.clone(), probe()).await.status, 502);
        let pool = state.db.clone(); // This test's existing pool points at refused port 1.
        Arc::get_mut(&mut state).unwrap().conversation_preload_db = Some(pool);
        assert_eq!(handle(state.clone(), probe()).await.status, 502);
        assert_eq!(state.conversation_preload_served.load(Ordering::Relaxed), 0);
        assert_eq!(
            state.conversation_preload_fallback.load(Ordering::Relaxed),
            2
        );
        let mut secure = app(false);
        let pool = secure.db.clone();
        Arc::get_mut(&mut secure).unwrap().conversation_preload_db = Some(pool);
        let redirect = handle(secure, probe()).await;
        assert_eq!(redirect.status, 302); // Ordinary HTTPS middleware, unlike testConnection.
    }

    #[tokio::test]
    async fn conversation_preload_boundaries_are_counted_node_handoffs() {
        let mut state = app(true);
        let pool = state.db.clone();
        Arc::get_mut(&mut state).unwrap().conversation_preload_db = Some(pool);
        for (method, target, headers) in [
            ("POST", crate::conversation_preload::PATH, vec![]),
            ("OPTIONS", crate::conversation_preload::PATH, vec![]),
            ("GET", "/api/v3/conversations/preload?unknown=1", vec![]),
            (
                "GET",
                crate::conversation_preload::PATH,
                vec![("authorization", "Bearer fixture")],
            ),
            (
                "GET",
                crate::conversation_preload::PATH,
                vec![("cookie", "fixture=1")],
            ),
            (
                "GET",
                crate::conversation_preload::PATH,
                vec![("content-length", "1")],
            ),
        ] {
            let mut req = request(method, &headers);
            req.target = target.into();
            assert_eq!(handle(state.clone(), req).await.status, 502);
        }
        assert_eq!(state.conversation_preload_served.load(Ordering::Relaxed), 0);
        assert_eq!(
            state.conversation_preload_fallback.load(Ordering::Relaxed),
            6
        );
    }

    #[tokio::test]
    async fn treevite_waves_is_off_and_unreachable_database_is_a_handoff() {
        let mut state = app(true);
        let probe = || {
            let mut req = request(
                "GET",
                &[("host", "localhost"), ("authorization", "Bearer fixture")],
            );
            req.target = format!("{}?conversation_id=fixture", crate::treevite_waves::PATH);
            req
        };
        assert!(state.treevite_waves_db.is_none());
        assert_eq!(handle(state.clone(), probe()).await.status, 502);
        let pool = state.db.clone(); // This test's existing pool points at refused port 1.
        Arc::get_mut(&mut state).unwrap().treevite_waves_db = Some(pool);
        assert_eq!(handle(state.clone(), probe()).await.status, 502);
        assert_eq!(state.treevite_waves_served.load(Ordering::Relaxed), 0);
        assert_eq!(state.treevite_waves_fallback.load(Ordering::Relaxed), 2);
        let mut secure = app(false);
        let pool = secure.db.clone();
        Arc::get_mut(&mut secure).unwrap().treevite_waves_db = Some(pool);
        let redirect = handle(secure, probe()).await;
        assert_eq!(redirect.status, 302); // Ordinary HTTPS middleware, unlike testConnection.
    }

    #[tokio::test]
    async fn treevite_waves_boundaries_are_counted_node_handoffs() {
        let mut state = app(true);
        let pool = state.db.clone();
        Arc::get_mut(&mut state).unwrap().treevite_waves_db = Some(pool);
        for (method, target, headers) in [
            ("POST", crate::treevite_waves::PATH, vec![]),
            ("OPTIONS", crate::treevite_waves::PATH, vec![]),
            ("GET", "/api/v3/treevite/waves?unknown=1", vec![]),
            (
                "GET",
                crate::treevite_waves::PATH,
                vec![("authorization", "Bearer fixture")],
            ),
            (
                "GET",
                crate::treevite_waves::PATH,
                vec![("cookie", "fixture=1")],
            ),
            (
                "GET",
                crate::treevite_waves::PATH,
                vec![("content-length", "1")],
            ),
        ] {
            let mut req = request(method, &headers);
            req.target = target.into();
            assert_eq!(handle(state.clone(), req).await.status, 502);
        }
        assert_eq!(state.treevite_waves_served.load(Ordering::Relaxed), 0);
        assert_eq!(state.treevite_waves_fallback.load(Ordering::Relaxed), 6);
    }

    #[tokio::test]
    async fn participation_read_is_off_and_unreachable_database_is_a_handoff() {
        let mut state = app(true);
        let probe = || {
            let mut req = request(
                "GET",
                &[("host", "localhost"), ("authorization", "Bearer fixture")],
            );
            req.target = format!(
                "{}?conversation_id=fixture",
                crate::participation_read::PATH
            );
            req
        };
        assert!(state.participation_read_db.is_none());
        assert_eq!(handle(state.clone(), probe()).await.status, 502);
        let pool = state.db.clone(); // This test's existing pool points at refused port 1.
        Arc::get_mut(&mut state).unwrap().participation_read_db = Some(pool);
        assert_eq!(handle(state.clone(), probe()).await.status, 502);
        assert_eq!(state.participation_read_served.load(Ordering::Relaxed), 0);
        assert_eq!(state.participation_read_fallback.load(Ordering::Relaxed), 2);
        let mut secure = app(false);
        let pool = secure.db.clone();
        Arc::get_mut(&mut secure).unwrap().participation_read_db = Some(pool);
        let redirect = handle(secure, probe()).await;
        assert_eq!(redirect.status, 302); // Ordinary HTTPS middleware, unlike testConnection.
    }

    #[tokio::test]
    async fn participation_read_boundaries_are_counted_node_handoffs() {
        let mut state = app(true);
        let pool = state.db.clone();
        Arc::get_mut(&mut state).unwrap().participation_read_db = Some(pool);
        for (method, target, headers) in [
            ("POST", crate::participation_read::PATH, vec![]),
            ("OPTIONS", crate::participation_read::PATH, vec![]),
            ("GET", "/api/v3/participation?unknown=1", vec![]),
            (
                "GET",
                crate::participation_read::PATH,
                vec![("authorization", "Bearer fixture")],
            ),
            (
                "GET",
                crate::participation_read::PATH,
                vec![("cookie", "fixture=1")],
            ),
            (
                "GET",
                crate::participation_read::PATH,
                vec![("content-length", "1")],
            ),
        ] {
            let mut req = request(method, &headers);
            req.target = target.into();
            assert_eq!(handle(state.clone(), req).await.status, 502);
        }
        assert_eq!(state.participation_read_served.load(Ordering::Relaxed), 0);
        assert_eq!(state.participation_read_fallback.load(Ordering::Relaxed), 6);
    }

    #[tokio::test]
    async fn treevite_csv_is_off_and_unreachable_database_is_a_handoff() {
        let mut state = app(true);
        let probe = || {
            let mut req = request(
                "GET",
                &[("host", "localhost"), ("authorization", "Bearer fixture")],
            );
            req.target = format!("{}?conversation_id=fixture", crate::treevite_csv::PATH);
            req
        };
        assert!(state.treevite_csv_db.is_none());
        assert_eq!(handle(state.clone(), probe()).await.status, 502);
        let pool = state.db.clone(); // This test's existing pool points at refused port 1.
        Arc::get_mut(&mut state).unwrap().treevite_csv_db = Some(pool);
        assert_eq!(handle(state.clone(), probe()).await.status, 502);
        assert_eq!(state.treevite_csv_served.load(Ordering::Relaxed), 0);
        assert_eq!(state.treevite_csv_fallback.load(Ordering::Relaxed), 2);
        let mut secure = app(false);
        let pool = secure.db.clone();
        Arc::get_mut(&mut secure).unwrap().treevite_csv_db = Some(pool);
        let redirect = handle(secure, probe()).await;
        assert_eq!(redirect.status, 302); // Ordinary HTTPS middleware, unlike testConnection.
    }

    #[tokio::test]
    async fn treevite_csv_boundaries_are_counted_node_handoffs() {
        let mut state = app(true);
        let pool = state.db.clone();
        Arc::get_mut(&mut state).unwrap().treevite_csv_db = Some(pool);
        for (method, target, headers) in [
            ("POST", crate::treevite_csv::PATH, vec![]),
            ("OPTIONS", crate::treevite_csv::PATH, vec![]),
            ("GET", "/api/v3/treevite/invites/csv?unknown=1", vec![]),
            (
                "GET",
                crate::treevite_csv::PATH,
                vec![("authorization", "Bearer fixture")],
            ),
            (
                "GET",
                crate::treevite_csv::PATH,
                vec![("cookie", "fixture=1")],
            ),
            (
                "GET",
                crate::treevite_csv::PATH,
                vec![("content-length", "1")],
            ),
        ] {
            let mut req = request(method, &headers);
            req.target = target.into();
            assert_eq!(handle(state.clone(), req).await.status, 502);
        }
        assert_eq!(state.treevite_csv_served.load(Ordering::Relaxed), 0);
        assert_eq!(state.treevite_csv_fallback.load(Ordering::Relaxed), 6);
    }

    #[tokio::test]
    async fn treevite_invites_is_off_and_unreachable_database_is_a_handoff() {
        let mut state = app(true);
        let probe = || {
            let mut req = request(
                "GET",
                &[("host", "localhost"), ("authorization", "Bearer fixture")],
            );
            req.target = format!("{}?conversation_id=fixture", crate::treevite_invites::PATH);
            req
        };
        assert!(state.treevite_invites_db.is_none());
        assert_eq!(handle(state.clone(), probe()).await.status, 502);
        let pool = state.db.clone(); // This test's existing pool points at refused port 1.
        Arc::get_mut(&mut state).unwrap().treevite_invites_db = Some(pool);
        assert_eq!(handle(state.clone(), probe()).await.status, 502);
        assert_eq!(state.treevite_invites_served.load(Ordering::Relaxed), 0);
        assert_eq!(state.treevite_invites_fallback.load(Ordering::Relaxed), 2);
        let mut secure = app(false);
        let pool = secure.db.clone();
        Arc::get_mut(&mut secure).unwrap().treevite_invites_db = Some(pool);
        let redirect = handle(secure, probe()).await;
        assert_eq!(redirect.status, 302); // Ordinary HTTPS middleware, unlike testConnection.
    }

    #[tokio::test]
    async fn treevite_invites_boundaries_are_counted_node_handoffs() {
        let mut state = app(true);
        let pool = state.db.clone();
        Arc::get_mut(&mut state).unwrap().treevite_invites_db = Some(pool);
        for (method, target, headers) in [
            ("POST", crate::treevite_invites::PATH, vec![]),
            ("OPTIONS", crate::treevite_invites::PATH, vec![]),
            ("GET", "/api/v3/treevite/invites?unknown=1", vec![]),
            (
                "GET",
                crate::treevite_invites::PATH,
                vec![("authorization", "Bearer fixture")],
            ),
            (
                "GET",
                crate::treevite_invites::PATH,
                vec![("cookie", "fixture=1")],
            ),
            (
                "GET",
                crate::treevite_invites::PATH,
                vec![("content-length", "1")],
            ),
        ] {
            let mut req = request(method, &headers);
            req.target = target.into();
            assert_eq!(handle(state.clone(), req).await.status, 502);
        }
        assert_eq!(state.treevite_invites_served.load(Ordering::Relaxed), 0);
        assert_eq!(state.treevite_invites_fallback.load(Ordering::Relaxed), 6);
    }

    #[tokio::test]
    async fn metadata_choices_gate_and_missing_auth_configuration_hand_back() {
        let mut state = app(true);
        let probe = || {
            let mut req = request(
                "GET",
                &[("host", "localhost"), ("authorization", "Bearer fixture")],
            );
            req.target = format!("{}?conversation_id=fixture", crate::metadata_choices::PATH);
            req
        };
        assert!(state.metadata_choices_db.is_none());
        assert_eq!(handle(state.clone(), probe()).await.status, 502);
        let pool = state.db.clone(); // This test's existing pool points at refused port 1.
        Arc::get_mut(&mut state).unwrap().metadata_choices_db = Some(pool);
        assert_eq!(handle(state.clone(), probe()).await.status, 502);
        assert_eq!(state.metadata_choices_served.load(Ordering::Relaxed), 0);
        assert_eq!(state.metadata_choices_fallback.load(Ordering::Relaxed), 2);
        let mut secure = app(false);
        let pool = secure.db.clone();
        Arc::get_mut(&mut secure).unwrap().metadata_choices_db = Some(pool);
        let redirect = handle(secure, probe()).await;
        assert_eq!(redirect.status, 302); // Ordinary HTTPS middleware, unlike testConnection.
    }

    #[tokio::test]
    async fn metadata_choices_boundaries_are_counted_node_handoffs() {
        let mut state = app(true);
        let pool = state.db.clone();
        Arc::get_mut(&mut state).unwrap().metadata_choices_db = Some(pool);
        for (method, target, headers) in [
            ("POST", crate::metadata_choices::PATH, vec![]),
            ("OPTIONS", crate::metadata_choices::PATH, vec![]),
            ("GET", "/api/v3/metadata/choices?unknown=1", vec![]),
            (
                "GET",
                crate::metadata_choices::PATH,
                vec![("authorization", "Bearer fixture")],
            ),
            (
                "GET",
                crate::metadata_choices::PATH,
                vec![("cookie", "fixture=1")],
            ),
            (
                "GET",
                crate::metadata_choices::PATH,
                vec![("content-length", "1")],
            ),
        ] {
            let mut req = request(method, &headers);
            req.target = target.into();
            assert_eq!(handle(state.clone(), req).await.status, 502);
        }
        assert_eq!(state.metadata_choices_served.load(Ordering::Relaxed), 0);
        assert_eq!(state.metadata_choices_fallback.load(Ordering::Relaxed), 6);
    }

    #[tokio::test]
    async fn legacy_cid_parameters_preserve_node_length_boundaries() {
        let mut state = app(true);
        let pool = state.db.clone();
        Arc::get_mut(&mut state).unwrap().metadata_questions_db = Some(pool.clone());
        Arc::get_mut(&mut state).unwrap().metadata_answers_db = Some(pool.clone());
        Arc::get_mut(&mut state).unwrap().metadata_read_db = Some(pool.clone());
        Arc::get_mut(&mut state).unwrap().metadata_choices_db = Some(pool.clone());
        Arc::get_mut(&mut state).unwrap().treevite_waves_db = Some(pool.clone());
        Arc::get_mut(&mut state).unwrap().treevite_invites_db = Some(pool.clone());
        Arc::get_mut(&mut state).unwrap().treevite_csv_db = Some(pool.clone());
        Arc::get_mut(&mut state).unwrap().participation_read_db = Some(pool.clone());
        Arc::get_mut(&mut state).unwrap().reports_read_db = Some(pool.clone());
        Arc::get_mut(&mut state).unwrap().bid_to_pid_db = Some(pool.clone());
        Arc::get_mut(&mut state).unwrap().conversation_stats_db = Some(pool.clone());
        Arc::get_mut(&mut state).unwrap().topic_selections_db = Some(pool.clone());
        Arc::get_mut(&mut state).unwrap().topic_prioritize_db = Some(pool.clone());
        Arc::get_mut(&mut state).unwrap().treevite_my_invites_db = Some(pool.clone());
        Arc::get_mut(&mut state).unwrap().treevite_me_db = Some(pool.clone());
        let mut mismatches = Vec::<String>::new();
        macro_rules! check {
            ($module:ident,$auth:expr) => {
                for (length, encoded, accepted) in [
                    (100, false, true),
                    (100, true, true),
                    (101, false, false),
                    (101, true, false),
                    (300, false, false),
                ] {
                    let headers = if $auth {
                        vec![("host", "localhost"), ("authorization", "Bearer fixture")]
                    } else {
                        vec![("host", "localhost")]
                    };
                    let mut req = request("GET", &headers);
                    let cid = if encoded {
                        "%61".repeat(length)
                    } else {
                        "a".repeat(length)
                    };
                    req.target = format!("{}?conversation_id={cid}", crate::$module::PATH);
                    if crate::$module::parse(&state, &req).is_some() != accepted {
                        mismatches.push(format!(
                            "{}:{length}:encoded={encoded}",
                            stringify!($module)
                        ));
                    }
                }
            };
        }
        check!(metadata_questions, true);
        check!(metadata_answers, true);
        check!(metadata_read, true);
        check!(metadata_choices, true);
        check!(treevite_waves, true);
        check!(treevite_invites, true);
        check!(treevite_csv, true);
        check!(participation_read, true);
        check!(reports_read, true);
        check!(bid_to_pid, true);
        check!(conversation_stats, true);
        check!(topic_selections, true);
        check!(topic_prioritize, false);
        check!(treevite_my_invites, true);
        check!(treevite_me, true);
        assert_eq!(mismatches, Vec::<String>::new());
    }

    #[tokio::test]
    async fn recent_started_gate_and_missing_auth_configuration_hand_back() {
        let mut state = app(true);
        let probe = || {
            let mut req = request(
                "GET",
                &[("host", "localhost"), ("authorization", "Bearer fixture")],
            );
            req.target = format!(
                "{}?sinceUnixTimestamp=9007199254740",
                crate::recent_started::PATH
            );
            req
        };
        assert!(state.recent_started_db.is_none());
        assert_eq!(handle(state.clone(), probe()).await.status, 502);
        let pool = state.db.clone(); // This test's existing pool points at refused port 1.
        Arc::get_mut(&mut state).unwrap().recent_started_db = Some(pool);
        assert_eq!(handle(state.clone(), probe()).await.status, 502);
        assert_eq!(state.recent_started_served.load(Ordering::Relaxed), 0);
        assert_eq!(state.recent_started_fallback.load(Ordering::Relaxed), 2);
        let mut secure = app(false);
        let pool = secure.db.clone();
        Arc::get_mut(&mut secure).unwrap().recent_started_db = Some(pool);
        let redirect = handle(secure, probe()).await;
        assert_eq!(redirect.status, 302); // Ordinary HTTPS middleware, unlike testConnection.
    }

    #[tokio::test]
    async fn recent_started_boundaries_are_counted_node_handoffs() {
        let mut state = app(true);
        let pool = state.db.clone();
        Arc::get_mut(&mut state).unwrap().recent_started_db = Some(pool);
        for (method, target, headers) in [
            ("POST", crate::recent_started::PATH, vec![]),
            ("OPTIONS", crate::recent_started::PATH, vec![]),
            (
                "GET",
                "/api/v3/conversations/recently_started?unknown=1",
                vec![],
            ),
            (
                "GET",
                crate::recent_started::PATH,
                vec![("authorization", "Bearer fixture")],
            ),
            (
                "GET",
                crate::recent_started::PATH,
                vec![("cookie", "fixture=1")],
            ),
            (
                "GET",
                crate::recent_started::PATH,
                vec![("content-length", "1")],
            ),
        ] {
            let mut req = request(method, &headers);
            req.target = target.into();
            assert_eq!(handle(state.clone(), req).await.status, 502);
        }
        assert_eq!(state.recent_started_served.load(Ordering::Relaxed), 0);
        assert_eq!(state.recent_started_fallback.load(Ordering::Relaxed), 6);
    }

    #[tokio::test]
    async fn treevite_me_gate_and_missing_auth_configuration_hand_back() {
        let mut state = app(true);
        let probe = || {
            let mut req = request(
                "GET",
                &[("host", "localhost"), ("authorization", "Bearer fixture")],
            );
            req.target = format!("{}?conversation_id=fixture", crate::treevite_me::PATH);
            req
        };
        assert!(state.treevite_me_db.is_none());
        assert_eq!(handle(state.clone(), probe()).await.status, 502);
        let pool = state.db.clone(); // This test's existing pool points at refused port 1.
        Arc::get_mut(&mut state).unwrap().treevite_me_db = Some(pool);
        assert_eq!(handle(state.clone(), probe()).await.status, 502);
        assert_eq!(state.treevite_me_served.load(Ordering::Relaxed), 0);
        assert_eq!(state.treevite_me_fallback.load(Ordering::Relaxed), 2);
        let mut secure = app(false);
        let pool = secure.db.clone();
        Arc::get_mut(&mut secure).unwrap().treevite_me_db = Some(pool);
        let redirect = handle(secure, probe()).await;
        assert_eq!(redirect.status, 302); // Ordinary HTTPS middleware, unlike testConnection.
    }

    #[tokio::test]
    async fn treevite_me_boundaries_are_counted_node_handoffs() {
        let mut state = app(true);
        let pool = state.db.clone();
        Arc::get_mut(&mut state).unwrap().treevite_me_db = Some(pool);
        for (method, target, headers) in [
            ("POST", crate::treevite_me::PATH, vec![]),
            ("OPTIONS", crate::treevite_me::PATH, vec![]),
            ("GET", "/api/v3/treevite/me?unknown=1", vec![]),
            (
                "GET",
                crate::treevite_me::PATH,
                vec![("authorization", "Bearer fixture")],
            ),
            (
                "GET",
                crate::treevite_me::PATH,
                vec![("cookie", "fixture=1")],
            ),
            (
                "GET",
                crate::treevite_me::PATH,
                vec![("content-length", "1")],
            ),
        ] {
            let mut req = request(method, &headers);
            req.target = target.into();
            assert_eq!(handle(state.clone(), req).await.status, 502);
        }
        assert_eq!(state.treevite_me_served.load(Ordering::Relaxed), 0);
        assert_eq!(state.treevite_me_fallback.load(Ordering::Relaxed), 6);
        for method in ["GET", "HEAD"] {
            for (length, encoded, accepted) in [
                (100, false, true),
                (100, true, true),
                (101, false, false),
                (101, true, false),
                (300, false, false),
            ] {
                let cid = if encoded {
                    "%61".repeat(length)
                } else {
                    "a".repeat(length)
                };
                let mut req = request(method, &[("authorization", "Bearer fixture")]);
                req.target = format!("{}?conversation_id={cid}", crate::treevite_me::PATH);
                assert_eq!(crate::treevite_me::parse(&state, &req).is_some(), accepted);
            }
        }
    }

    #[tokio::test]
    async fn treevite_my_invites_gate_and_missing_auth_configuration_hand_back() {
        let mut state = app(true);
        let probe = || {
            let mut req = request(
                "GET",
                &[("host", "localhost"), ("authorization", "Bearer fixture")],
            );
            req.target = format!(
                "{}?conversation_id=fixture",
                crate::treevite_my_invites::PATH
            );
            req
        };
        assert!(state.treevite_my_invites_db.is_none());
        assert_eq!(handle(state.clone(), probe()).await.status, 502);
        let pool = state.db.clone(); // This test's existing pool points at refused port 1.
        Arc::get_mut(&mut state).unwrap().treevite_my_invites_db = Some(pool);
        assert_eq!(handle(state.clone(), probe()).await.status, 502);
        assert_eq!(state.treevite_my_invites_served.load(Ordering::Relaxed), 0);
        assert_eq!(
            state.treevite_my_invites_fallback.load(Ordering::Relaxed),
            2
        );
        let mut secure = app(false);
        let pool = secure.db.clone();
        Arc::get_mut(&mut secure).unwrap().treevite_my_invites_db = Some(pool);
        let redirect = handle(secure, probe()).await;
        assert_eq!(redirect.status, 302); // Ordinary HTTPS middleware, unlike testConnection.
    }

    #[tokio::test]
    async fn treevite_my_invites_boundaries_are_counted_node_handoffs() {
        let mut state = app(true);
        let pool = state.db.clone();
        Arc::get_mut(&mut state).unwrap().treevite_my_invites_db = Some(pool);
        for (method, target, headers) in [
            ("POST", crate::treevite_my_invites::PATH, vec![]),
            ("OPTIONS", crate::treevite_my_invites::PATH, vec![]),
            ("GET", "/api/v3/treevite/myInvites?unknown=1", vec![]),
            (
                "GET",
                crate::treevite_my_invites::PATH,
                vec![("authorization", "Bearer fixture")],
            ),
            (
                "GET",
                crate::treevite_my_invites::PATH,
                vec![("cookie", "fixture=1")],
            ),
            (
                "GET",
                crate::treevite_my_invites::PATH,
                vec![("content-length", "1")],
            ),
        ] {
            let mut req = request(method, &headers);
            req.target = target.into();
            assert_eq!(handle(state.clone(), req).await.status, 502);
        }
        assert_eq!(state.treevite_my_invites_served.load(Ordering::Relaxed), 0);
        assert_eq!(
            state.treevite_my_invites_fallback.load(Ordering::Relaxed),
            6
        );
    }

    #[tokio::test]
    async fn legacy_conversations_gate_and_missing_auth_configuration_hand_back() {
        let mut state = app(true);
        let probe = || {
            let mut req = request(
                "GET",
                &[("host", "localhost"), ("authorization", "Bearer fixture")],
            );
            req.target = format!("{}?limit=9999", crate::legacy_conversations::PATH);
            req
        };
        assert!(state.legacy_conversations_db.is_none());
        assert_eq!(handle(state.clone(), probe()).await.status, 502);
        let pool = state.db.clone(); // This test's existing pool points at refused port 1.
        Arc::get_mut(&mut state).unwrap().legacy_conversations_db = Some(pool);
        assert_eq!(handle(state.clone(), probe()).await.status, 502);
        assert_eq!(state.legacy_conversations_served.load(Ordering::Relaxed), 0);
        assert_eq!(
            state.legacy_conversations_fallback.load(Ordering::Relaxed),
            2
        );
        let mut secure = app(false);
        let pool = secure.db.clone();
        Arc::get_mut(&mut secure).unwrap().legacy_conversations_db = Some(pool);
        let redirect = handle(secure, probe()).await;
        assert_eq!(redirect.status, 302); // Ordinary HTTPS middleware, unlike testConnection.
    }

    #[tokio::test]
    async fn legacy_conversations_boundaries_are_counted_node_handoffs() {
        let mut state = app(true);
        let pool = state.db.clone();
        Arc::get_mut(&mut state).unwrap().legacy_conversations_db = Some(pool);
        for (method, target, headers) in [
            ("POST", crate::legacy_conversations::PATH, vec![]),
            ("OPTIONS", crate::legacy_conversations::PATH, vec![]),
            ("GET", "/api/v3/conversations?unknown=1", vec![]),
            (
                "GET",
                crate::legacy_conversations::PATH,
                vec![("authorization", "Bearer fixture")],
            ),
            (
                "GET",
                crate::legacy_conversations::PATH,
                vec![("cookie", "fixture=1")],
            ),
            (
                "GET",
                crate::legacy_conversations::PATH,
                vec![("content-length", "1")],
            ),
        ] {
            let mut req = request(method, &headers);
            req.target = target.into();
            assert_eq!(handle(state.clone(), req).await.status, 502);
        }
        assert_eq!(state.legacy_conversations_served.load(Ordering::Relaxed), 0);
        assert_eq!(
            state.legacy_conversations_fallback.load(Ordering::Relaxed),
            6
        );
    }

    #[test]
    fn xid_report_requires_auth_before_admission() {
        let mut state = app(true);
        let pool = state.db.clone();
        Arc::get_mut(&mut state).unwrap().xid_report_db = Some(pool.clone());
        Arc::get_mut(&mut state).unwrap().xid_report_auth_db = Some(pool);
        for method in ["GET", "HEAD"] {
            let mut signed = request(method, &[("authorization", "Bearer fixture.invalid")]);
            signed.target = "/api/v3/xid/12345678-1234-1234-1234-123456789abc-xid.csv".into();
            assert!(crate::xid_report::parse(&state, &signed).is_some());
            let mut unsigned = request(method, &[]);
            unsigned.target = signed.target;
            assert!(crate::xid_report::parse(&state, &unsigned).is_none());
        }
    }

    #[tokio::test]
    async fn xid_report_boundaries_are_counted_handoffs() {
        let mut state = app(true);
        let pool = state.db.clone();
        Arc::get_mut(&mut state).unwrap().xid_report_db = Some(pool.clone());
        Arc::get_mut(&mut state).unwrap().xid_report_auth_db = Some(pool);
        let base = "/api/v3/xid/12345678-1234-1234-1234-123456789abc-xid.csv";
        for (method, target, headers) in [
            ("POST", base.to_string(), vec![]),
            ("OPTIONS", base.to_string(), vec![]),
            ("GET", format!("{base}?xid_report=override"), vec![]),
            (
                "GET",
                base.to_string(),
                vec![("authorization", "Bearer fixture")],
            ),
            ("GET", base.to_string(), vec![("cookie", "fixture=1")]),
            ("GET", base.to_string(), vec![("content-length", "1")]),
            ("GET", base.replace("12345678", "%312345678"), vec![]),
            ("GET", base.replace("12345678", "x2345678"), vec![]),
            ("GET", format!("{base}-xid.csv"), vec![]),
        ] {
            let mut req = request(method, &headers);
            req.target = target;
            assert_eq!(handle(state.clone(), req).await.status, 502);
        }
        assert_eq!(state.xid_report_served.load(Ordering::Relaxed), 0);
        assert_eq!(state.xid_report_fallback.load(Ordering::Relaxed), 9);
    }

    #[tokio::test]
    async fn topic_prioritize_gate_and_missing_auth_configuration_hand_back() {
        let mut state = app(true);
        let probe = || {
            let mut req = request("GET", &[("host", "localhost")]);
            req.target = format!("{}?conversation_id=fixture", crate::topic_prioritize::PATH);
            req
        };
        assert!(state.topic_prioritize_db.is_none());
        assert_eq!(handle(state.clone(), probe()).await.status, 502);
        let pool = state.db.clone(); // This test's existing pool points at refused port 1.
        Arc::get_mut(&mut state).unwrap().topic_prioritize_db = Some(pool);
        assert_eq!(handle(state.clone(), probe()).await.status, 502);
        assert_eq!(state.topic_prioritize_served.load(Ordering::Relaxed), 0);
        assert_eq!(state.topic_prioritize_fallback.load(Ordering::Relaxed), 2);
        let mut secure = app(false);
        let pool = secure.db.clone();
        Arc::get_mut(&mut secure).unwrap().topic_prioritize_db = Some(pool);
        let redirect = handle(secure, probe()).await;
        assert_eq!(redirect.status, 302); // Ordinary HTTPS middleware, unlike testConnection.
    }

    #[tokio::test]
    async fn einvites_read_parameter_and_method_boundaries() {
        let mut state = app(true);
        let pool = state.db.clone();
        Arc::get_mut(&mut state).unwrap().einvites_read_db = Some(pool);
        for code in [
            "a".to_string(),
            "a".repeat(100),
            "fixture_1-2".into(),
            "%66ixture".into(),
        ] {
            let mut req = request("GET", &[]);
            req.target = format!("/api/v3/einvites?einvite={code}");
            assert!(crate::einvites_read::parse(&state, &req).is_some());
        }
        for (method, query, headers) in [
            ("POST", "einvite=fixture".into(), vec![]),
            ("OPTIONS", "einvite=fixture".into(), vec![]),
            ("GET", "einvite=".into(), vec![]),
            ("GET", format!("einvite={}", "a".repeat(101)), vec![]),
            ("GET", "einvite=x&einvite=y".into(), vec![]),
            ("GET", "einvite[]=x".into(), vec![]),
            ("GET", "einvite=fixture&unknown=1".into(), vec![]),
            ("GET", "einvite=%FF".into(), vec![]),
            (
                "GET",
                "einvite=fixture".into(),
                vec![("cookie", "fixture=1")],
            ),
            (
                "GET",
                "einvite=fixture".into(),
                vec![("authorization", "Bearer fixture")],
            ),
            (
                "GET",
                "einvite=fixture".into(),
                vec![("content-length", "1")],
            ),
        ] {
            let mut req = request(method, &headers);
            req.target = format!("/api/v3/einvites?{query}");
            assert_eq!(handle(state.clone(), req).await.status, 502);
        }
        assert_eq!(state.einvites_read_served.load(Ordering::Relaxed), 0);
        assert_eq!(state.einvites_read_fallback.load(Ordering::Relaxed), 11);
    }

    #[tokio::test]
    async fn xid_report_gate_and_missing_auth_configuration_hand_back() {
        let mut state = app(true);
        let probe = || {
            let mut req = request("GET", &[("host", "localhost")]);
            req.target = "/api/v3/xid/12345678-1234-1234-1234-123456789abc-xid.csv".into();
            req
        };
        assert!(state.xid_report_db.is_none());
        assert_eq!(handle(state.clone(), probe()).await.status, 502);
        let pool = state.db.clone(); // This test's existing pool points at refused port 1.
        Arc::get_mut(&mut state).unwrap().xid_report_db = Some(pool);
        assert_eq!(handle(state.clone(), probe()).await.status, 502);
        assert_eq!(state.xid_report_served.load(Ordering::Relaxed), 0);
        assert_eq!(state.xid_report_fallback.load(Ordering::Relaxed), 2);
        let mut secure = app(false);
        let pool = secure.db.clone();
        Arc::get_mut(&mut secure).unwrap().xid_report_db = Some(pool);
        // Unsupported requests hand back before HTTPS middleware.
        assert_eq!(handle(secure.clone(), probe()).await.status, 502);
        assert_eq!(secure.xid_report_served.load(Ordering::Relaxed), 0);
        assert_eq!(secure.xid_report_fallback.load(Ordering::Relaxed), 1);
        // Eligible requests retain the ordinary HTTPS redirect.
        let pool = secure.db.clone();
        Arc::get_mut(&mut secure).unwrap().xid_report_auth_db = Some(pool);
        let mut admitted = request(
            "GET",
            &[("host", "localhost"), ("authorization", "Bearer fixture")],
        );
        admitted.target = probe().target;
        let redirect = handle(secure, admitted).await;
        assert_eq!(redirect.status, 302);
    }

    #[tokio::test]
    async fn einvites_read_gate_and_unreachable_database_hand_back() {
        let mut state = app(true);
        let probe = || {
            let mut req = request("GET", &[("host", "localhost")]);
            req.target = "/api/v3/einvites?einvite=fixture".into();
            req
        };
        assert!(state.einvites_read_db.is_none());
        assert_eq!(handle(state.clone(), probe()).await.status, 502);
        let pool = state.db.clone(); // This test's existing pool points at refused port 1.
        Arc::get_mut(&mut state).unwrap().einvites_read_db = Some(pool);
        assert_eq!(handle(state.clone(), probe()).await.status, 502);
        assert_eq!(state.einvites_read_served.load(Ordering::Relaxed), 0);
        assert_eq!(state.einvites_read_fallback.load(Ordering::Relaxed), 2);
        let mut secure = app(false);
        let pool = secure.db.clone();
        Arc::get_mut(&mut secure).unwrap().einvites_read_db = Some(pool);
        let redirect = handle(secure, probe()).await;
        assert_eq!(redirect.status, 302); // Ordinary HTTPS middleware, unlike testConnection.
    }

    #[tokio::test]
    async fn topic_prioritize_boundaries_are_counted_node_handoffs() {
        let mut state = app(true);
        let pool = state.db.clone();
        Arc::get_mut(&mut state).unwrap().topic_prioritize_db = Some(pool);
        for (method, target, headers) in [
            ("POST", crate::topic_prioritize::PATH, vec![]),
            ("OPTIONS", crate::topic_prioritize::PATH, vec![]),
            (
                "GET",
                "/api/v3/participation/topicPrioritize?unknown=1",
                vec![],
            ),
            (
                "GET",
                crate::topic_prioritize::PATH,
                vec![("authorization", "Bearer fixture")],
            ),
            (
                "GET",
                crate::topic_prioritize::PATH,
                vec![("cookie", "fixture=1")],
            ),
            (
                "GET",
                crate::topic_prioritize::PATH,
                vec![("content-length", "1")],
            ),
        ] {
            let mut req = request(method, &headers);
            req.target = target.into();
            assert_eq!(handle(state.clone(), req).await.status, 502);
        }
        assert_eq!(state.topic_prioritize_served.load(Ordering::Relaxed), 0);
        assert_eq!(state.topic_prioritize_fallback.load(Ordering::Relaxed), 6);
    }

    #[tokio::test]
    async fn topic_selections_gate_and_missing_auth_configuration_hand_back() {
        let mut state = app(true);
        let probe = || {
            let mut req = request(
                "GET",
                &[("host", "localhost"), ("authorization", "Bearer fixture")],
            );
            req.target = format!("{}?conversation_id=fixture", crate::topic_selections::PATH);
            req
        };
        assert!(state.topic_selections_db.is_none());
        assert_eq!(handle(state.clone(), probe()).await.status, 502);
        let pool = state.db.clone(); // This test's existing pool points at refused port 1.
        Arc::get_mut(&mut state).unwrap().topic_selections_db = Some(pool);
        assert_eq!(handle(state.clone(), probe()).await.status, 502);
        assert_eq!(state.topic_selections_served.load(Ordering::Relaxed), 0);
        assert_eq!(state.topic_selections_fallback.load(Ordering::Relaxed), 2);
        let mut secure = app(false);
        let pool = secure.db.clone();
        Arc::get_mut(&mut secure).unwrap().topic_selections_db = Some(pool);
        let redirect = handle(secure, probe()).await;
        assert_eq!(redirect.status, 302); // Ordinary HTTPS middleware, unlike testConnection.
    }

    #[tokio::test]
    async fn topic_selections_boundaries_are_counted_node_handoffs() {
        let mut state = app(true);
        let pool = state.db.clone();
        Arc::get_mut(&mut state).unwrap().topic_selections_db = Some(pool);
        for (method, target, headers) in [
            ("POST", crate::topic_selections::PATH, vec![]),
            ("OPTIONS", crate::topic_selections::PATH, vec![]),
            ("GET", "/api/v3/topicAgenda/selections?unknown=1", vec![]),
            (
                "GET",
                crate::topic_selections::PATH,
                vec![("authorization", "Bearer fixture")],
            ),
            (
                "GET",
                crate::topic_selections::PATH,
                vec![("cookie", "fixture=1")],
            ),
            (
                "GET",
                crate::topic_selections::PATH,
                vec![("content-length", "1")],
            ),
        ] {
            let mut req = request(method, &headers);
            req.target = target.into();
            assert_eq!(handle(state.clone(), req).await.status, 502);
        }
        assert_eq!(state.topic_selections_served.load(Ordering::Relaxed), 0);
        assert_eq!(state.topic_selections_fallback.load(Ordering::Relaxed), 6);
    }

    #[tokio::test]
    async fn conversation_stats_gate_and_missing_auth_configuration_hand_back() {
        let mut state = app(true);
        let probe = || {
            let mut req = request(
                "GET",
                &[("host", "localhost"), ("authorization", "Bearer fixture")],
            );
            req.target = format!(
                "{}?conversation_id=fixture",
                crate::conversation_stats::PATH
            );
            req
        };
        assert!(state.conversation_stats_db.is_none());
        assert_eq!(handle(state.clone(), probe()).await.status, 502);
        let pool = state.db.clone(); // This test's existing pool points at refused port 1.
        Arc::get_mut(&mut state).unwrap().conversation_stats_db = Some(pool);
        assert_eq!(handle(state.clone(), probe()).await.status, 502);
        assert_eq!(state.conversation_stats_served.load(Ordering::Relaxed), 0);
        assert_eq!(state.conversation_stats_fallback.load(Ordering::Relaxed), 2);
        let mut secure = app(false);
        let pool = secure.db.clone();
        Arc::get_mut(&mut secure).unwrap().conversation_stats_db = Some(pool);
        let redirect = handle(secure, probe()).await;
        assert_eq!(redirect.status, 302); // Ordinary HTTPS middleware, unlike testConnection.
    }

    #[tokio::test]
    async fn conversation_stats_boundaries_are_counted_node_handoffs() {
        let mut state = app(true);
        let pool = state.db.clone();
        Arc::get_mut(&mut state).unwrap().conversation_stats_db = Some(pool);
        for (method, target, headers) in [
            ("POST", crate::conversation_stats::PATH, vec![]),
            ("OPTIONS", crate::conversation_stats::PATH, vec![]),
            ("GET", "/api/v3/conversationStats?unknown=1", vec![]),
            (
                "GET",
                crate::conversation_stats::PATH,
                vec![("authorization", "Bearer fixture")],
            ),
            (
                "GET",
                crate::conversation_stats::PATH,
                vec![("cookie", "fixture=1")],
            ),
            (
                "GET",
                crate::conversation_stats::PATH,
                vec![("content-length", "1")],
            ),
        ] {
            let mut req = request(method, &headers);
            req.target = target.into();
            assert_eq!(handle(state.clone(), req).await.status, 502);
        }
        assert_eq!(state.conversation_stats_served.load(Ordering::Relaxed), 0);
        assert_eq!(state.conversation_stats_fallback.load(Ordering::Relaxed), 6);
    }

    #[tokio::test]
    async fn bid_to_pid_gate_and_missing_auth_configuration_hand_back() {
        let mut state = app(true);
        let probe = || {
            let mut req = request(
                "GET",
                &[("host", "localhost"), ("authorization", "Bearer fixture")],
            );
            req.target = format!("{}?conversation_id=fixture", crate::bid_to_pid::PATH);
            req
        };
        assert!(state.bid_to_pid_db.is_none());
        assert_eq!(handle(state.clone(), probe()).await.status, 502);
        let pool = state.db.clone(); // This test's existing pool points at refused port 1.
        Arc::get_mut(&mut state).unwrap().bid_to_pid_db = Some(pool);
        assert_eq!(handle(state.clone(), probe()).await.status, 502);
        assert_eq!(state.bid_to_pid_served.load(Ordering::Relaxed), 0);
        assert_eq!(state.bid_to_pid_fallback.load(Ordering::Relaxed), 2);
        let mut secure = app(false);
        let pool = secure.db.clone();
        Arc::get_mut(&mut secure).unwrap().bid_to_pid_db = Some(pool);
        let redirect = handle(secure, probe()).await;
        assert_eq!(redirect.status, 302); // Ordinary HTTPS middleware, unlike testConnection.
    }

    #[tokio::test]
    async fn bid_to_pid_boundaries_are_counted_node_handoffs() {
        let mut state = app(true);
        let pool = state.db.clone();
        Arc::get_mut(&mut state).unwrap().bid_to_pid_db = Some(pool);
        for (method, target, headers) in [
            ("POST", crate::bid_to_pid::PATH, vec![]),
            ("OPTIONS", crate::bid_to_pid::PATH, vec![]),
            ("GET", "/api/v3/bidToPid?unknown=1", vec![]),
            (
                "GET",
                crate::bid_to_pid::PATH,
                vec![("authorization", "Bearer fixture")],
            ),
            (
                "GET",
                crate::bid_to_pid::PATH,
                vec![("cookie", "fixture=1")],
            ),
            (
                "GET",
                crate::bid_to_pid::PATH,
                vec![("content-length", "1")],
            ),
        ] {
            let mut req = request(method, &headers);
            req.target = target.into();
            assert_eq!(handle(state.clone(), req).await.status, 502);
        }
        assert_eq!(state.bid_to_pid_served.load(Ordering::Relaxed), 0);
        assert_eq!(state.bid_to_pid_fallback.load(Ordering::Relaxed), 6);
    }

    #[tokio::test]
    async fn reports_read_gate_and_missing_auth_configuration_hand_back() {
        let mut state = app(true);
        let probe = || {
            let mut req = request(
                "GET",
                &[("host", "localhost"), ("authorization", "Bearer fixture")],
            );
            req.target = crate::reports_read::PATH.to_owned();
            req
        };
        assert!(state.reports_read_db.is_none());
        assert_eq!(handle(state.clone(), probe()).await.status, 502);
        let pool = state.db.clone(); // This test's existing pool points at refused port 1.
        Arc::get_mut(&mut state).unwrap().reports_read_db = Some(pool);
        assert_eq!(handle(state.clone(), probe()).await.status, 502);
        assert_eq!(state.reports_read_served.load(Ordering::Relaxed), 0);
        assert_eq!(state.reports_read_fallback.load(Ordering::Relaxed), 2);
        let mut secure = app(false);
        let pool = secure.db.clone();
        Arc::get_mut(&mut secure).unwrap().reports_read_db = Some(pool);
        let redirect = handle(secure, probe()).await;
        assert_eq!(redirect.status, 302); // Ordinary HTTPS middleware, unlike testConnection.
    }

    #[tokio::test]
    async fn reports_read_boundaries_are_counted_node_handoffs() {
        let mut state = app(true);
        let pool = state.db.clone();
        Arc::get_mut(&mut state).unwrap().reports_read_db = Some(pool);
        for (method, target, headers) in [
            ("POST", crate::reports_read::PATH, vec![]),
            ("OPTIONS", crate::reports_read::PATH, vec![]),
            ("GET", "/api/v3/reports?unknown=1", vec![]),
            (
                "GET",
                crate::reports_read::PATH,
                vec![("authorization", "Bearer fixture")],
            ),
            (
                "GET",
                crate::reports_read::PATH,
                vec![("cookie", "fixture=1")],
            ),
            (
                "GET",
                crate::reports_read::PATH,
                vec![("content-length", "1")],
            ),
        ] {
            let mut req = request(method, &headers);
            req.target = target.into();
            assert_eq!(handle(state.clone(), req).await.status, 502);
        }
        assert_eq!(state.reports_read_served.load(Ordering::Relaxed), 0);
        assert_eq!(state.reports_read_fallback.load(Ordering::Relaxed), 6);
    }

    #[tokio::test]
    async fn all_conversations_gate_and_missing_auth_configuration_hand_back() {
        let mut state = app(true);
        let probe = || {
            let mut req = request(
                "GET",
                &[("host", "localhost"), ("authorization", "Bearer fixture")],
            );
            req.target = format!(
                "{}?owner_email=fixtureAbsentMarker",
                crate::all_conversations::PATH
            );
            req
        };
        assert!(state.all_conversations_db.is_none());
        assert_eq!(handle(state.clone(), probe()).await.status, 502);
        let pool = state.db.clone(); // This test's existing pool points at refused port 1.
        Arc::get_mut(&mut state).unwrap().all_conversations_db = Some(pool);
        let mut parsed = probe();
        parsed.target="/api/v3/all_conversations?owner_email=++Owner%40fixture.invalid++&limit=9999&offset=99999999".into();
        let query = crate::all_conversations::parse(&state, &parsed).unwrap();
        assert_eq!(query.owner_email.as_deref(), Some("Owner@fixture.invalid"));
        assert_eq!((query.limit, query.offset), (500, 99_999_999));
        parsed.target = "/api/v3/all_conversations?owner_email=+++".into();
        assert_eq!(
            crate::all_conversations::parse(&state, &parsed)
                .unwrap()
                .owner_email
                .as_deref(),
            Some("")
        );
        assert_eq!(handle(state.clone(), probe()).await.status, 502);
        assert_eq!(state.all_conversations_served.load(Ordering::Relaxed), 0);
        assert_eq!(state.all_conversations_fallback.load(Ordering::Relaxed), 2);
        let mut secure = app(false);
        let pool = secure.db.clone();
        Arc::get_mut(&mut secure).unwrap().all_conversations_db = Some(pool);
        let redirect = handle(secure, probe()).await;
        assert_eq!(redirect.status, 302); // Ordinary HTTPS middleware, unlike testConnection.
    }

    #[tokio::test]
    async fn all_conversations_boundaries_are_counted_node_handoffs() {
        let mut state = app(true);
        let pool = state.db.clone();
        Arc::get_mut(&mut state).unwrap().all_conversations_db = Some(pool);
        for (method, target, headers) in [
            ("POST", crate::all_conversations::PATH, vec![]),
            ("OPTIONS", crate::all_conversations::PATH, vec![]),
            ("GET", "/api/v3/all_conversations?unknown=1", vec![]),
            (
                "GET",
                crate::all_conversations::PATH,
                vec![("authorization", "Bearer fixture")],
            ),
            (
                "GET",
                crate::all_conversations::PATH,
                vec![("cookie", "fixture=1")],
            ),
            (
                "GET",
                crate::all_conversations::PATH,
                vec![("content-length", "1")],
            ),
        ] {
            let mut req = request(method, &headers);
            req.target = target.into();
            assert_eq!(handle(state.clone(), req).await.status, 502);
        }
        assert_eq!(state.all_conversations_served.load(Ordering::Relaxed), 0);
        assert_eq!(state.all_conversations_fallback.load(Ordering::Relaxed), 6);
    }

    #[tokio::test]
    async fn recent_activity_gate_and_missing_auth_configuration_hand_back() {
        let mut state = app(true);
        let probe = || {
            let mut req = request(
                "GET",
                &[("host", "localhost"), ("authorization", "Bearer fixture")],
            );
            req.target = format!(
                "{}?sinceUnixTimestamp=9007199254740",
                crate::recent_activity::PATH
            );
            req
        };
        assert!(state.recent_activity_db.is_none());
        assert_eq!(handle(state.clone(), probe()).await.status, 502);
        let pool = state.db.clone(); // This test's existing pool points at refused port 1.
        Arc::get_mut(&mut state).unwrap().recent_activity_db = Some(pool);
        assert_eq!(handle(state.clone(), probe()).await.status, 502);
        assert_eq!(state.recent_activity_served.load(Ordering::Relaxed), 0);
        assert_eq!(state.recent_activity_fallback.load(Ordering::Relaxed), 2);
        let mut secure = app(false);
        let pool = secure.db.clone();
        Arc::get_mut(&mut secure).unwrap().recent_activity_db = Some(pool);
        let redirect = handle(secure, probe()).await;
        assert_eq!(redirect.status, 302); // Ordinary HTTPS middleware, unlike testConnection.
    }

    #[tokio::test]
    async fn recent_activity_boundaries_are_counted_node_handoffs() {
        let mut state = app(true);
        let pool = state.db.clone();
        Arc::get_mut(&mut state).unwrap().recent_activity_db = Some(pool);
        for (method, target, headers) in [
            ("POST", crate::recent_activity::PATH, vec![]),
            ("OPTIONS", crate::recent_activity::PATH, vec![]),
            (
                "GET",
                "/api/v3/conversations/recent_activity?unknown=1",
                vec![],
            ),
            (
                "GET",
                crate::recent_activity::PATH,
                vec![("authorization", "Bearer fixture")],
            ),
            (
                "GET",
                crate::recent_activity::PATH,
                vec![("cookie", "fixture=1")],
            ),
            (
                "GET",
                crate::recent_activity::PATH,
                vec![("content-length", "1")],
            ),
        ] {
            let mut req = request(method, &headers);
            req.target = target.into();
            assert_eq!(handle(state.clone(), req).await.status, 502);
        }
        assert_eq!(state.recent_activity_served.load(Ordering::Relaxed), 0);
        assert_eq!(state.recent_activity_fallback.load(Ordering::Relaxed), 6);
    }

    #[tokio::test]
    async fn metadata_read_gate_and_missing_auth_configuration_hand_back() {
        let mut state = app(true);
        let probe = || {
            let mut req = request(
                "GET",
                &[("host", "localhost"), ("authorization", "Bearer fixture")],
            );
            req.target = format!("{}?conversation_id=fixture", crate::metadata_read::PATH);
            req
        };
        assert!(state.metadata_read_db.is_none());
        assert_eq!(handle(state.clone(), probe()).await.status, 502);
        let pool = state.db.clone(); // This test's existing pool points at refused port 1.
        Arc::get_mut(&mut state).unwrap().metadata_read_db = Some(pool);
        assert_eq!(handle(state.clone(), probe()).await.status, 502);
        assert_eq!(state.metadata_read_served.load(Ordering::Relaxed), 0);
        assert_eq!(state.metadata_read_fallback.load(Ordering::Relaxed), 2);
        let mut secure = app(false);
        let pool = secure.db.clone();
        Arc::get_mut(&mut secure).unwrap().metadata_read_db = Some(pool);
        let redirect = handle(secure, probe()).await;
        assert_eq!(redirect.status, 302); // Ordinary HTTPS middleware, unlike testConnection.
    }

    #[tokio::test]
    async fn metadata_read_boundaries_are_counted_node_handoffs() {
        let mut state = app(true);
        let pool = state.db.clone();
        Arc::get_mut(&mut state).unwrap().metadata_read_db = Some(pool);
        for (method, target, headers) in [
            ("POST", crate::metadata_read::PATH, vec![]),
            ("OPTIONS", crate::metadata_read::PATH, vec![]),
            ("GET", "/api/v3/metadata?unknown=1", vec![]),
            (
                "GET",
                crate::metadata_read::PATH,
                vec![("authorization", "Bearer fixture")],
            ),
            (
                "GET",
                crate::metadata_read::PATH,
                vec![("cookie", "fixture=1")],
            ),
            (
                "GET",
                crate::metadata_read::PATH,
                vec![("content-length", "1")],
            ),
        ] {
            let mut req = request(method, &headers);
            req.target = target.into();
            assert_eq!(handle(state.clone(), req).await.status, 502);
        }
        assert_eq!(state.metadata_read_served.load(Ordering::Relaxed), 0);
        assert_eq!(state.metadata_read_fallback.load(Ordering::Relaxed), 6);
    }

    #[tokio::test]
    async fn metadata_answers_is_off_and_unreachable_database_is_a_handoff() {
        let mut state = app(true);
        let probe = || {
            let mut req = request("GET", &[("host", "localhost")]);
            req.target = format!("{}?conversation_id=fixture", crate::metadata_answers::PATH);
            req
        };
        assert!(state.metadata_answers_db.is_none());
        assert_eq!(handle(state.clone(), probe()).await.status, 502);
        let pool = state.db.clone(); // This test's existing pool points at refused port 1.
        Arc::get_mut(&mut state).unwrap().metadata_answers_db = Some(pool);
        assert_eq!(handle(state.clone(), probe()).await.status, 502);
        assert_eq!(state.metadata_answers_served.load(Ordering::Relaxed), 0);
        assert_eq!(state.metadata_answers_fallback.load(Ordering::Relaxed), 2);
        let mut secure = app(false);
        let pool = secure.db.clone();
        Arc::get_mut(&mut secure).unwrap().metadata_answers_db = Some(pool);
        let redirect = handle(secure, probe()).await;
        assert_eq!(redirect.status, 302); // Ordinary HTTPS middleware, unlike testConnection.
    }

    #[tokio::test]
    async fn metadata_answers_boundaries_are_counted_node_handoffs() {
        let mut state = app(true);
        let pool = state.db.clone();
        Arc::get_mut(&mut state).unwrap().metadata_answers_db = Some(pool);
        for (method, target, headers) in [
            ("POST", crate::metadata_answers::PATH, vec![]),
            ("OPTIONS", crate::metadata_answers::PATH, vec![]),
            ("GET", "/api/v3/metadata/answers?unknown=1", vec![]),
            (
                "GET",
                crate::metadata_answers::PATH,
                vec![("authorization", "Bearer fixture")],
            ),
            (
                "GET",
                crate::metadata_answers::PATH,
                vec![("cookie", "fixture=1")],
            ),
            (
                "GET",
                crate::metadata_answers::PATH,
                vec![("content-length", "1")],
            ),
        ] {
            let mut req = request(method, &headers);
            req.target = target.into();
            assert_eq!(handle(state.clone(), req).await.status, 502);
        }
        assert_eq!(state.metadata_answers_served.load(Ordering::Relaxed), 0);
        assert_eq!(state.metadata_answers_fallback.load(Ordering::Relaxed), 6);
    }

    #[tokio::test]
    async fn connection_probe_is_off_by_default_and_needs_no_database() {
        let mut state = app(false);
        let probe = |method| {
            let mut req = request(method, &[("host", "localhost")]);
            req.target = crate::connection::PATH.into();
            req
        };
        assert_eq!(handle(state.clone(), probe("GET")).await.status, 502);
        Arc::get_mut(&mut state).unwrap().connection_reads = true;
        let out = handle(state.clone(), probe("GET")).await;
        assert_eq!(out.status, 200); // No HTTPS redirect and no DB wait.
        assert!(matches!(out.body, Body::Fixed(ref b) if b == br#"{"status":"ok"}"#));
        assert_eq!(handle(state.clone(), probe("HEAD")).await.status, 200);
        assert_eq!(state.connection_served.load(Ordering::Relaxed), 2);
        assert_eq!(state.connection_fallback.load(Ordering::Relaxed), 1);
    }
    #[tokio::test]
    async fn connection_boundaries_are_counted_node_handoffs() {
        let mut state = app(true);
        Arc::get_mut(&mut state).unwrap().connection_reads = true;
        for (method, target, headers) in [
            ("POST", crate::connection::PATH, vec![]),
            ("OPTIONS", crate::connection::PATH, vec![]),
            ("GET", "/api/v3/testConnection?unknown=1", vec![]),
            (
                "GET",
                crate::connection::PATH,
                vec![("authorization", "Bearer fixture")],
            ),
            (
                "GET",
                crate::connection::PATH,
                vec![("cookie", "fixture=1")],
            ),
            (
                "GET",
                crate::connection::PATH,
                vec![("content-length", "1")],
            ),
        ] {
            let mut req = request(method, &headers);
            req.target = target.into();
            assert_eq!(handle(state.clone(), req).await.status, 502);
        }
        assert_eq!(state.connection_served.load(Ordering::Relaxed), 0);
        assert_eq!(state.connection_fallback.load(Ordering::Relaxed), 6);
    }

    #[tokio::test]
    async fn robots_probe_is_off_by_default_and_needs_no_database() {
        let mut state = app(true);
        let probe = |method| {
            let mut req = request(method, &[("host", "localhost")]);
            req.target = crate::robots::PATH.into();
            req
        };
        assert_eq!(handle(state.clone(), probe("GET")).await.status, 502);
        Arc::get_mut(&mut state).unwrap().robots_reads = true;
        let out = handle(state.clone(), probe("GET")).await;
        assert_eq!(out.status, 200); // No DB wait.
        assert!(matches!(out.body, Body::Fixed(ref b) if b == b"User-agent: *\nDisallow: /api/"));
        assert_eq!(handle(state.clone(), probe("HEAD")).await.status, 200);
        assert_eq!(state.robots_served.load(Ordering::Relaxed), 2);
        assert_eq!(state.robots_fallback.load(Ordering::Relaxed), 1);
        let mut secure = app(false);
        Arc::get_mut(&mut secure).unwrap().robots_reads = true;
        assert_eq!(handle(secure.clone(), probe("GET")).await.status, 302);
        let mut req = probe("GET");
        req.headers = Headers::from_raw([
            ("host", "localhost"),
            ("x-forwarded-proto", "https"),
            ("origin", "https://example.invalid"),
        ]);
        let out = handle(secure, req).await;
        assert_eq!(out.status, 200);
        assert_eq!(header(&out, "Access-Control-Allow-Origin"), None);
    }
    #[tokio::test]
    async fn robots_boundaries_are_counted_node_handoffs() {
        let mut state = app(true);
        Arc::get_mut(&mut state).unwrap().robots_reads = true;
        for (method, target, headers) in [
            ("POST", crate::robots::PATH, vec![]),
            ("OPTIONS", crate::robots::PATH, vec![]),
            ("GET", "/robots.txt?unknown=1", vec![]),
            (
                "GET",
                crate::robots::PATH,
                vec![("authorization", "Bearer fixture")],
            ),
            ("GET", crate::robots::PATH, vec![("cookie", "fixture=1")]),
            ("GET", crate::robots::PATH, vec![("content-length", "1")]),
        ] {
            let mut req = request(method, &headers);
            req.target = target.into();
            assert_eq!(handle(state.clone(), req).await.status, 502);
        }
        assert_eq!(state.robots_served.load(Ordering::Relaxed), 0);
        assert_eq!(state.robots_fallback.load(Ordering::Relaxed), 6);
    }

    #[tokio::test]
    async fn legacy_pca_has_no_database_work_and_preserves_304_end() {
        let mut state = app(true);
        let probe = |method: &str| {
            let mut req = request(method, &[("host", "localhost")]);
            req.target = format!(
                "{}?conversation_id=fixture&math_tick=7",
                crate::legacy_pca::PATH
            );
            req
        };
        assert_eq!(handle(state.clone(), probe("GET")).await.status, 502);
        Arc::get_mut(&mut state).unwrap().legacy_pca_reads = true;
        for method in ["GET", "HEAD"] {
            let out = handle(state.clone(), probe(method)).await;
            assert_eq!(out.status, 304);
            assert!(matches!(out.body, Body::Empty));
            assert!(out.headers.iter().any(|(k,v)|k.eq_ignore_ascii_case("content-type") && v=="application/json"));
            assert!(
                !out.headers
                    .iter()
                    .any(|(k, _)| k.eq_ignore_ascii_case("etag"))
            );
        }
        assert_eq!(state.legacy_pca_served.load(Ordering::Relaxed), 2);
        assert_eq!(state.legacy_pca_fallback.load(Ordering::Relaxed), 1);
        let mut secure = app(false);
        Arc::get_mut(&mut secure).unwrap().legacy_pca_reads = true;
        assert_eq!(handle(secure, probe("GET")).await.status, 302);
    }
    #[tokio::test]
    async fn legacy_pca_boundaries_are_counted_handoffs() {
        let mut state = app(true);
        Arc::get_mut(&mut state).unwrap().legacy_pca_reads = true;
        for (method, headers) in [
            ("POST", vec![]),
            ("OPTIONS", vec![]),
            ("GET", vec![("authorization", "Bearer fixture")]),
            ("GET", vec![("cookie", "fixture=1")]),
            ("GET", vec![("content-length", "1")]),
        ] {
            let mut req = request(method, &headers);
            req.target = crate::legacy_pca::PATH.into();
            assert_eq!(handle(state.clone(), req).await.status, 502);
        }
        assert_eq!(state.legacy_pca_served.load(Ordering::Relaxed), 0);
        assert_eq!(state.legacy_pca_fallback.load(Ordering::Relaxed), 5);
    }

    #[tokio::test]
    async fn about_probe_is_off_by_default_and_needs_no_database() {
        let mut state = app(true);
        let probe = |method| {
            let mut req = request(method, &[("host", "localhost")]);
            req.target = crate::about::PATH.into();
            req
        };
        assert_eq!(handle(state.clone(), probe("GET")).await.status, 502);
        Arc::get_mut(&mut state).unwrap().about_reads = true;
        let out = handle(state.clone(), probe("GET")).await;
        assert_eq!(out.status, 302); // No DB wait.
        assert_eq!(header(&out, "Location"), Some("http://localhost/home"));
        assert_eq!(handle(state.clone(), probe("HEAD")).await.status, 302);
        assert_eq!(state.about_served.load(Ordering::Relaxed), 2);
        assert_eq!(state.about_fallback.load(Ordering::Relaxed), 1);
        let mut secure = app(false);
        Arc::get_mut(&mut secure).unwrap().about_reads = true;
        assert_eq!(handle(secure.clone(), probe("GET")).await.status, 302);
        let mut req = probe("GET");
        req.headers = Headers::from_raw([
            ("host", "localhost"),
            ("x-forwarded-proto", "https"),
            ("origin", "https://example.invalid"),
        ]);
        let out = handle(secure, req).await;
        assert_eq!(out.status, 302);
        assert_eq!(header(&out, "Access-Control-Allow-Origin"), None);
    }
    #[tokio::test]
    async fn about_boundaries_are_counted_node_handoffs() {
        let mut state = app(true);
        Arc::get_mut(&mut state).unwrap().about_reads = true;
        for (method, target, headers) in [
            ("POST", crate::about::PATH, vec![]),
            ("OPTIONS", crate::about::PATH, vec![]),
            ("GET", "/about?unknown=1", vec![]),
            (
                "GET",
                crate::about::PATH,
                vec![("authorization", "Bearer fixture")],
            ),
            ("GET", crate::about::PATH, vec![("cookie", "fixture=1")]),
            ("GET", crate::about::PATH, vec![("content-length", "1")]),
        ] {
            let mut req = request(method, &headers);
            req.target = target.into();
            assert_eq!(handle(state.clone(), req).await.status, 502);
        }
        assert_eq!(state.about_served.load(Ordering::Relaxed), 0);
        assert_eq!(state.about_fallback.load(Ordering::Relaxed), 6);
    }

    #[tokio::test]
    async fn create_page_redirect_gate_and_wire() {
        let mut state = app(true);
        let probe = |method, path: &str, ua: &str| {
            let mut req = request(method, &[("host", "localhost:5000"), ("user-agent", ua)]);
            req.target = path.into();
            req
        };
        assert_eq!(
            handle(
                state.clone(),
                probe("GET", "/conversation/create", "MSIE 8.0")
            )
            .await
            .status,
            502
        );
        Arc::get_mut(&mut state).unwrap().create_page_reads = true;
        for path in [
            "/conversation/create",
            "/conversation/create/step",
            "/conversation/createSuffix",
        ] {
            for method in ["GET", "HEAD"] {
                let out = handle(state.clone(), probe(method, path, "MSIE 9.0")).await;
                assert_eq!(out.status, 302);
                assert_eq!(
                    header(&out, "Location"),
                    Some(format!("https://localhost:5000/#{path}").as_str())
                );
                assert_eq!(header(&out, "Content-Type"), Some("application/json"));
                assert_eq!(header(&out, "ETag"), None);
            }
        }
        assert_eq!(state.create_page_served.load(Ordering::Relaxed), 6);
        for ua in [
            "Mozilla/5.0",
            "MSIE 7.0",
            "MSIE 10.0",
            "msie 8.0",
            "MSIE 8.0 MSIE 6.0",
            "",
        ] {
            assert_eq!(
                handle(state.clone(), probe("GET", "/conversation/create", ua))
                    .await
                    .status,
                502
            );
        }
        for (method, path) in [
            ("POST", "/conversation/create"),
            ("OPTIONS", "/conversation/create"),
            ("GET", "/conversation/create?x=1"),
            ("GET", "/conversation/create/%20"),
        ] {
            assert_eq!(
                handle(state.clone(), probe(method, path, "MSIE 8.0"))
                    .await
                    .status,
                502
            );
        }
        assert_eq!(state.create_page_fallback.load(Ordering::Relaxed), 11);
        let mut secure = app(false);
        Arc::get_mut(&mut secure).unwrap().create_page_reads = true;
        let mut req = probe("GET", "/conversation/create", "MSIE 8.0");
        req.headers = Headers::from_raw([
            ("host", "localhost"),
            ("user-agent", "MSIE 8.0"),
            ("x-forwarded-proto", "https"),
            ("origin", "https://example.invalid"),
        ]);
        let out = handle(secure, req).await;
        assert_eq!(out.status, 302);
        assert_eq!(
            header(&out, "Location"),
            Some("https://localhost/#/conversation/create")
        );
        assert_eq!(header(&out, "Access-Control-Allow-Origin"), None);
    }
    #[tokio::test]
    async fn create_page_headers_and_body_stay_on_node() {
        let mut state = app(true);
        Arc::get_mut(&mut state).unwrap().create_page_reads = true;
        for extra in [
            ("cookie", "fixture=1"),
            ("authorization", "Bearer fixture"),
            ("content-length", "1"),
            ("transfer-encoding", "chunked"),
        ] {
            let mut req = request(
                "GET",
                &[("host", "localhost"), ("user-agent", "MSIE 8.0"), extra],
            );
            req.target = "/conversation/create".into();
            assert_eq!(handle(state.clone(), req).await.status, 502);
        }
        let mut req = request("GET", &[("host", "localhost"), ("user-agent", "MSIE 8.0")]);
        req.target = "/conversation/create".into();
        req.body = vec![b'x'];
        assert_eq!(handle(state.clone(), req).await.status, 502);
        assert_eq!(state.create_page_fallback.load(Ordering::Relaxed), 5);
    }
    #[tokio::test]
    async fn user_create_page_redirect_gate_and_wire() {
        assert!(crate::user_create_page::matches("/user/create"));
        assert!(crate::user_create_page::matches("/user/create/step"));
        assert!(!crate::user_create_page::matches("/user/createSuffix"));
        assert!(!crate::user_create_page::matches("/user/creat"));
        let mut state = app(true);
        let probe = |method, path: &str, ua: &str| {
            let mut req = request(method, &[("host", "localhost:5000"), ("user-agent", ua)]);
            req.target = path.into();
            req
        };
        assert_eq!(
            handle(state.clone(), probe("GET", "/user/create", "MSIE 8.0"))
                .await
                .status,
            502
        );
        Arc::get_mut(&mut state).unwrap().user_create_page_reads = true;
        for path in ["/user/create", "/user/create/step", "/user/create/"] {
            for method in ["GET", "HEAD"] {
                let out = handle(state.clone(), probe(method, path, "MSIE 9.0")).await;
                assert_eq!(out.status, 302);
                assert_eq!(
                    header(&out, "Location"),
                    Some(format!("https://localhost:5000/#{path}").as_str())
                );
                assert_eq!(header(&out, "Content-Type"), Some("application/json"));
                assert_eq!(header(&out, "ETag"), None);
            }
        }
        assert_eq!(state.user_create_page_served.load(Ordering::Relaxed), 6);
        for ua in [
            "Mozilla/5.0",
            "MSIE 7.0",
            "MSIE 10.0",
            "msie 8.0",
            "MSIE 8.0 MSIE 6.0",
            "",
        ] {
            assert_eq!(
                handle(state.clone(), probe("GET", "/user/create", ua))
                    .await
                    .status,
                502
            );
        }
        for (method, path) in [
            ("POST", "/user/create"),
            ("OPTIONS", "/user/create"),
            ("GET", "/user/create?x=1"),
            ("GET", "/user/create/%20"),
        ] {
            assert_eq!(
                handle(state.clone(), probe(method, path, "MSIE 8.0"))
                    .await
                    .status,
                502
            );
        }
        assert_eq!(state.user_create_page_fallback.load(Ordering::Relaxed), 11);
        let mut secure = app(false);
        Arc::get_mut(&mut secure).unwrap().user_create_page_reads = true;
        let mut req = probe("GET", "/user/create", "MSIE 8.0");
        req.headers = Headers::from_raw([
            ("host", "localhost"),
            ("user-agent", "MSIE 8.0"),
            ("x-forwarded-proto", "https"),
            ("origin", "https://example.invalid"),
        ]);
        let out = handle(secure, req).await;
        assert_eq!(out.status, 302);
        assert_eq!(
            header(&out, "Location"),
            Some("https://localhost/#/user/create")
        );
        assert_eq!(header(&out, "Access-Control-Allow-Origin"), None);
    }
    #[tokio::test]
    async fn user_create_page_headers_and_body_stay_on_node() {
        let mut state = app(true);
        Arc::get_mut(&mut state).unwrap().user_create_page_reads = true;
        for extra in [
            ("cookie", "fixture=1"),
            ("authorization", "Bearer fixture"),
            ("content-length", "1"),
            ("transfer-encoding", "chunked"),
        ] {
            let mut req = request(
                "GET",
                &[("host", "localhost"), ("user-agent", "MSIE 8.0"), extra],
            );
            req.target = "/user/create".into();
            assert_eq!(handle(state.clone(), req).await.status, 502);
        }
        let mut req = request("GET", &[("host", "localhost"), ("user-agent", "MSIE 8.0")]);
        req.target = "/user/create".into();
        req.body = vec![b'x'];
        assert_eq!(handle(state.clone(), req).await.status, 502);
        assert_eq!(state.user_create_page_fallback.load(Ordering::Relaxed), 5);
    }
    #[tokio::test]
    async fn user_login_page_redirect_gate_and_wire() {
        assert!(crate::user_login_page::matches("/user/login"));
        assert!(crate::user_login_page::matches("/user/login/step"));
        assert!(!crate::user_login_page::matches("/user/loginSuffix"));
        assert!(!crate::user_login_page::matches("/user/logi"));
        let mut state = app(true);
        let probe = |method, path: &str, ua: &str| {
            let mut req = request(method, &[("host", "localhost:5000"), ("user-agent", ua)]);
            req.target = path.into();
            req
        };
        assert_eq!(
            handle(state.clone(), probe("GET", "/user/login", "MSIE 8.0"))
                .await
                .status,
            502
        );
        Arc::get_mut(&mut state).unwrap().user_login_page_reads = true;
        for path in ["/user/login", "/user/login/step", "/user/login/"] {
            for method in ["GET", "HEAD"] {
                let out = handle(state.clone(), probe(method, path, "MSIE 9.0")).await;
                assert_eq!(out.status, 302);
                assert_eq!(
                    header(&out, "Location"),
                    Some(format!("https://localhost:5000/#{path}").as_str())
                );
                assert_eq!(header(&out, "Content-Type"), Some("application/json"));
                assert_eq!(header(&out, "ETag"), None);
            }
        }
        assert_eq!(state.user_login_page_served.load(Ordering::Relaxed), 6);
        for ua in [
            "Mozilla/5.0",
            "MSIE 7.0",
            "MSIE 10.0",
            "msie 8.0",
            "MSIE 8.0 MSIE 6.0",
            "",
        ] {
            assert_eq!(
                handle(state.clone(), probe("GET", "/user/login", ua))
                    .await
                    .status,
                502
            );
        }
        for (method, path) in [
            ("POST", "/user/login"),
            ("OPTIONS", "/user/login"),
            ("GET", "/user/login?x=1"),
            ("GET", "/user/login/%20"),
        ] {
            assert_eq!(
                handle(state.clone(), probe(method, path, "MSIE 8.0"))
                    .await
                    .status,
                502
            );
        }
        assert_eq!(state.user_login_page_fallback.load(Ordering::Relaxed), 11);
        let mut secure = app(false);
        Arc::get_mut(&mut secure).unwrap().user_login_page_reads = true;
        let mut req = probe("GET", "/user/login", "MSIE 8.0");
        req.headers = Headers::from_raw([
            ("host", "localhost"),
            ("user-agent", "MSIE 8.0"),
            ("x-forwarded-proto", "https"),
            ("origin", "https://example.invalid"),
        ]);
        let out = handle(secure, req).await;
        assert_eq!(out.status, 302);
        assert_eq!(
            header(&out, "Location"),
            Some("https://localhost/#/user/login")
        );
        assert_eq!(header(&out, "Access-Control-Allow-Origin"), None);
    }
    #[tokio::test]
    async fn user_login_page_headers_and_body_stay_on_node() {
        let mut state = app(true);
        Arc::get_mut(&mut state).unwrap().user_login_page_reads = true;
        for extra in [
            ("cookie", "fixture=1"),
            ("authorization", "Bearer fixture"),
            ("content-length", "1"),
            ("transfer-encoding", "chunked"),
        ] {
            let mut req = request(
                "GET",
                &[("host", "localhost"), ("user-agent", "MSIE 8.0"), extra],
            );
            req.target = "/user/login".into();
            assert_eq!(handle(state.clone(), req).await.status, 502);
        }
        let mut req = request("GET", &[("host", "localhost"), ("user-agent", "MSIE 8.0")]);
        req.target = "/user/login".into();
        req.body = vec![b'x'];
        assert_eq!(handle(state.clone(), req).await.status, 502);
        assert_eq!(state.user_login_page_fallback.load(Ordering::Relaxed), 5);
    }
    #[tokio::test]
    async fn user_logout_page_redirect_gate_and_wire() {
        assert!(crate::user_logout_page::matches("/user/logout"));
        assert!(crate::user_logout_page::matches("/user/logout/step"));
        assert!(!crate::user_logout_page::matches("/user/logoutSuffix"));
        assert!(!crate::user_logout_page::matches("/user/logou"));
        let mut state = app(true);
        let probe = |method, path: &str, ua: &str| {
            let mut req = request(method, &[("host", "localhost:5000"), ("user-agent", ua)]);
            req.target = path.into();
            req
        };
        assert_eq!(
            handle(state.clone(), probe("GET", "/user/logout", "MSIE 8.0"))
                .await
                .status,
            502
        );
        Arc::get_mut(&mut state).unwrap().user_logout_page_reads = true;
        for path in ["/user/logout", "/user/logout/step", "/user/logout/"] {
            for method in ["GET", "HEAD"] {
                let out = handle(state.clone(), probe(method, path, "MSIE 9.0")).await;
                assert_eq!(out.status, 302);
                assert_eq!(
                    header(&out, "Location"),
                    Some(format!("https://localhost:5000/#{path}").as_str())
                );
                assert_eq!(header(&out, "Content-Type"), Some("application/json"));
                assert_eq!(header(&out, "ETag"), None);
            }
        }
        assert_eq!(state.user_logout_page_served.load(Ordering::Relaxed), 6);
        for ua in [
            "Mozilla/5.0",
            "MSIE 7.0",
            "MSIE 10.0",
            "msie 8.0",
            "MSIE 8.0 MSIE 6.0",
            "",
        ] {
            assert_eq!(
                handle(state.clone(), probe("GET", "/user/logout", ua))
                    .await
                    .status,
                502
            );
        }
        for (method, path) in [
            ("POST", "/user/logout"),
            ("OPTIONS", "/user/logout"),
            ("GET", "/user/logout?x=1"),
            ("GET", "/user/logout/%20"),
        ] {
            assert_eq!(
                handle(state.clone(), probe(method, path, "MSIE 8.0"))
                    .await
                    .status,
                502
            );
        }
        assert_eq!(state.user_logout_page_fallback.load(Ordering::Relaxed), 11);
        let mut secure = app(false);
        Arc::get_mut(&mut secure).unwrap().user_logout_page_reads = true;
        let mut req = probe("GET", "/user/logout", "MSIE 8.0");
        req.headers = Headers::from_raw([
            ("host", "localhost"),
            ("user-agent", "MSIE 8.0"),
            ("x-forwarded-proto", "https"),
            ("origin", "https://example.invalid"),
        ]);
        let out = handle(secure, req).await;
        assert_eq!(out.status, 302);
        assert_eq!(
            header(&out, "Location"),
            Some("https://localhost/#/user/logout")
        );
        assert_eq!(header(&out, "Access-Control-Allow-Origin"), None);
    }
    #[tokio::test]
    async fn user_logout_page_headers_and_body_stay_on_node() {
        let mut state = app(true);
        Arc::get_mut(&mut state).unwrap().user_logout_page_reads = true;
        for extra in [
            ("cookie", "fixture=1"),
            ("authorization", "Bearer fixture"),
            ("content-length", "1"),
            ("transfer-encoding", "chunked"),
        ] {
            let mut req = request(
                "GET",
                &[("host", "localhost"), ("user-agent", "MSIE 8.0"), extra],
            );
            req.target = "/user/logout".into();
            assert_eq!(handle(state.clone(), req).await.status, 502);
        }
        let mut req = request("GET", &[("host", "localhost"), ("user-agent", "MSIE 8.0")]);
        req.target = "/user/logout".into();
        req.body = vec![b'x'];
        assert_eq!(handle(state.clone(), req).await.status, 502);
        assert_eq!(state.user_logout_page_fallback.load(Ordering::Relaxed), 5);
    }
    #[tokio::test]
    async fn settings_page_redirect_gate_and_wire() {
        assert!(crate::settings_page::matches("/settings"));
        assert!(crate::settings_page::matches("/settings/step"));
        assert!(!crate::settings_page::matches("/settingsSuffix"));
        assert!(!crate::settings_page::matches("/setting"));
        let mut state = app(true);
        let probe = |method, path: &str, ua: &str| {
            let mut req = request(method, &[("host", "localhost:5000"), ("user-agent", ua)]);
            req.target = path.into();
            req
        };
        assert_eq!(
            handle(state.clone(), probe("GET", "/settings", "MSIE 8.0"))
                .await
                .status,
            502
        );
        Arc::get_mut(&mut state).unwrap().settings_page_reads = true;
        for path in ["/settings", "/settings/step", "/settings/"] {
            for method in ["GET", "HEAD"] {
                let out = handle(state.clone(), probe(method, path, "MSIE 9.0")).await;
                assert_eq!(out.status, 302);
                assert_eq!(
                    header(&out, "Location"),
                    Some(format!("https://localhost:5000/#{path}").as_str())
                );
                assert_eq!(header(&out, "Content-Type"), Some("application/json"));
                assert_eq!(header(&out, "ETag"), None);
            }
        }
        assert_eq!(state.settings_page_served.load(Ordering::Relaxed), 6);
        for ua in [
            "Mozilla/5.0",
            "MSIE 7.0",
            "MSIE 10.0",
            "msie 8.0",
            "MSIE 8.0 MSIE 6.0",
            "",
        ] {
            assert_eq!(
                handle(state.clone(), probe("GET", "/settings", ua))
                    .await
                    .status,
                502
            );
        }
        for (method, path) in [
            ("POST", "/settings"),
            ("OPTIONS", "/settings"),
            ("GET", "/settings?x=1"),
            ("GET", "/settings/%20"),
        ] {
            assert_eq!(
                handle(state.clone(), probe(method, path, "MSIE 8.0"))
                    .await
                    .status,
                502
            );
        }
        assert_eq!(state.settings_page_fallback.load(Ordering::Relaxed), 11);
        let mut secure = app(false);
        Arc::get_mut(&mut secure).unwrap().settings_page_reads = true;
        let mut req = probe("GET", "/settings", "MSIE 8.0");
        req.headers = Headers::from_raw([
            ("host", "localhost"),
            ("user-agent", "MSIE 8.0"),
            ("x-forwarded-proto", "https"),
            ("origin", "https://example.invalid"),
        ]);
        let out = handle(secure, req).await;
        assert_eq!(out.status, 302);
        assert_eq!(
            header(&out, "Location"),
            Some("https://localhost/#/settings")
        );
        assert_eq!(header(&out, "Access-Control-Allow-Origin"), None);
    }
    #[tokio::test]
    async fn settings_page_headers_and_body_stay_on_node() {
        let mut state = app(true);
        Arc::get_mut(&mut state).unwrap().settings_page_reads = true;
        for extra in [
            ("cookie", "fixture=1"),
            ("authorization", "Bearer fixture"),
            ("content-length", "1"),
            ("transfer-encoding", "chunked"),
        ] {
            let mut req = request(
                "GET",
                &[("host", "localhost"), ("user-agent", "MSIE 8.0"), extra],
            );
            req.target = "/settings".into();
            assert_eq!(handle(state.clone(), req).await.status, 502);
        }
        let mut req = request("GET", &[("host", "localhost"), ("user-agent", "MSIE 8.0")]);
        req.target = "/settings".into();
        req.body = vec![b'x'];
        assert_eq!(handle(state.clone(), req).await.status, 502);
        assert_eq!(state.settings_page_fallback.load(Ordering::Relaxed), 5);
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
    #[tokio::test]
    async fn admin_page_gate_boundaries_and_wire() {
        let mut state = app(true);
        let mut req = request("GET", &[("host", "localhost")]);
        req.target = "/m/2test".into();
        assert_eq!(
            handle(
                state.clone(),
                Request {
                    method: req.method.clone(),
                    target: req.target.clone(),
                    headers: req.headers.clone(),
                    body: req.body.clone()
                }
            )
            .await
            .status,
            502
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        Arc::get_mut(&mut state).unwrap().admin_page =
            Some(crate::admin_page::Client::new("127.0.0.1".into(), port).unwrap());
        let task = tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            for _ in 0..2 {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut b = [0; 4096];
                let n = socket.read(&mut b).await.unwrap();
                let body = if b[..n].starts_with(b"HEAD ") {
                    ""
                } else {
                    "html"
                };
                socket
                    .write_all(
                        format!("HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\n{body}").as_bytes(),
                    )
                    .await
                    .unwrap();
            }
        });
        for method in ["GET", "HEAD"] {
            req.method = method.into();
            let out = handle(
                state.clone(),
                Request {
                    method: req.method.clone(),
                    target: req.target.clone(),
                    headers: req.headers.clone(),
                    body: req.body.clone(),
                },
            )
            .await;
            assert_eq!(out.status, 200);
            assert_eq!(header(&out, "Content-Type"), Some("text/html"));
            assert_eq!(header(&out, "Vary"), Some("Accept-Encoding"));
            let bytes = crate::http::write_response(&out, method == "HEAD", false, "D").unwrap();
            let expected = if method == "HEAD" {
                "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\nVary: Accept-Encoding\r\nDate: D\r\n\r\n"
            } else {
                "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\nVary: Accept-Encoding\r\nDate: D\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nhtml\r\n0\r\n\r\n"
            };
            assert_eq!(bytes, expected.as_bytes());
        }
        task.await.unwrap();
        for extra in [
            ("cookie", "a=b"),
            ("authorization", "Bearer fixture"),
            ("range", "bytes=0-1"),
            ("if-none-match", "*"),
            ("accept-encoding", "gzip"),
            ("x-unknown", "1"),
            ("content-length", "1"),
        ] {
            let mut bad = request("GET", &[("host", "localhost"), extra]);
            bad.target = "/m/2test".into();
            assert_eq!(handle(state.clone(), bad).await.status, 502);
        }
        for (method, path) in [
            ("POST", "/m/2test"),
            ("GET", "/m/2test?x=1"),
            ("GET", "/m/2test/%20"),
        ] {
            let mut bad = Request {
                method: req.method.clone(),
                target: req.target.clone(),
                headers: req.headers.clone(),
                body: req.body.clone(),
            };
            bad.method = method.into();
            bad.target = path.into();
            assert_eq!(handle(state.clone(), bad).await.status, 502);
        }
        assert_eq!(state.admin_page_served.load(Ordering::Relaxed), 2);
        assert_eq!(state.admin_page_fallback.load(Ordering::Relaxed), 11);
    }
    #[tokio::test]
    async fn integrate_page_gate_boundaries_and_wire() {
        let mut state = app(true);
        let mut req = request("GET", &[("host", "localhost")]);
        req.target = "/integrate".into();
        assert_eq!(
            handle(
                state.clone(),
                Request {
                    method: req.method.clone(),
                    target: req.target.clone(),
                    headers: req.headers.clone(),
                    body: req.body.clone()
                }
            )
            .await
            .status,
            502
        );
        Arc::get_mut(&mut state).unwrap().admin_page =
            Some(crate::admin_page::Client::new("127.0.0.1".into(), 1).unwrap());
        assert!(crate::integrate_page::parse(&state, &req).is_none());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        Arc::get_mut(&mut state).unwrap().integrate_page =
            Some(crate::admin_page::Client::new("127.0.0.1".into(), port).unwrap());
        let task = tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            for _ in 0..2 {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut b = [0; 4096];
                let n = socket.read(&mut b).await.unwrap();
                let body = if b[..n].starts_with(b"HEAD ") {
                    ""
                } else {
                    "html"
                };
                socket
                    .write_all(
                        format!("HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\n{body}").as_bytes(),
                    )
                    .await
                    .unwrap();
            }
        });
        for method in ["GET", "HEAD"] {
            req.method = method.into();
            let out = handle(
                state.clone(),
                Request {
                    method: req.method.clone(),
                    target: req.target.clone(),
                    headers: req.headers.clone(),
                    body: req.body.clone(),
                },
            )
            .await;
            assert_eq!(out.status, 200);
            assert_eq!(header(&out, "Content-Type"), Some("text/html"));
            assert_eq!(header(&out, "Vary"), Some("Accept-Encoding"));
            let bytes = crate::http::write_response(&out, method == "HEAD", false, "D").unwrap();
            let expected = if method == "HEAD" {
                "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\nVary: Accept-Encoding\r\nDate: D\r\n\r\n"
            } else {
                "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\nVary: Accept-Encoding\r\nDate: D\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nhtml\r\n0\r\n\r\n"
            };
            assert_eq!(bytes, expected.as_bytes());
        }
        task.await.unwrap();
        for extra in [
            ("cookie", "a=b"),
            ("authorization", "Bearer fixture"),
            ("range", "bytes=0-1"),
            ("if-none-match", "*"),
            ("accept-encoding", "gzip"),
            ("x-unknown", "1"),
            ("content-length", "1"),
        ] {
            let mut bad = request("GET", &[("host", "localhost"), extra]);
            bad.target = "/integrate".into();
            assert_eq!(handle(state.clone(), bad).await.status, 502);
        }
        for (method, path) in [
            ("POST", "/integrate"),
            ("GET", "/integrate?x=1"),
            ("GET", "/integrate/%20"),
        ] {
            let mut bad = Request {
                method: req.method.clone(),
                target: req.target.clone(),
                headers: req.headers.clone(),
                body: req.body.clone(),
            };
            bad.method = method.into();
            bad.target = path.into();
            assert_eq!(handle(state.clone(), bad).await.status, 502);
        }
        assert_eq!(state.integrate_page_served.load(Ordering::Relaxed), 2);
        assert_eq!(state.integrate_page_fallback.load(Ordering::Relaxed), 11);
    }
    #[tokio::test]
    async fn other_conversations_page_gate_boundaries_and_wire() {
        let mut state = app(true);
        let mut req = request("GET", &[("host", "localhost")]);
        req.target = "/other-conversations".into();
        assert_eq!(
            handle(
                state.clone(),
                Request {
                    method: req.method.clone(),
                    target: req.target.clone(),
                    headers: req.headers.clone(),
                    body: req.body.clone()
                }
            )
            .await
            .status,
            502
        );
        Arc::get_mut(&mut state).unwrap().integrate_page =
            Some(crate::admin_page::Client::new("127.0.0.1".into(), 1).unwrap());
        assert!(crate::other_conversations_page::parse(&state, &req).is_none());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        Arc::get_mut(&mut state).unwrap().other_conversations_page =
            Some(crate::admin_page::Client::new("127.0.0.1".into(), port).unwrap());
        let task = tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            for _ in 0..2 {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut b = [0; 4096];
                let n = socket.read(&mut b).await.unwrap();
                let body = if b[..n].starts_with(b"HEAD ") {
                    ""
                } else {
                    "html"
                };
                socket
                    .write_all(
                        format!("HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\n{body}").as_bytes(),
                    )
                    .await
                    .unwrap();
            }
        });
        for method in ["GET", "HEAD"] {
            req.method = method.into();
            let out = handle(
                state.clone(),
                Request {
                    method: req.method.clone(),
                    target: req.target.clone(),
                    headers: req.headers.clone(),
                    body: req.body.clone(),
                },
            )
            .await;
            assert_eq!(out.status, 200);
            assert_eq!(header(&out, "Content-Type"), Some("text/html"));
            assert_eq!(header(&out, "Vary"), Some("Accept-Encoding"));
            let bytes = crate::http::write_response(&out, method == "HEAD", false, "D").unwrap();
            let expected = if method == "HEAD" {
                "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\nVary: Accept-Encoding\r\nDate: D\r\n\r\n"
            } else {
                "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\nVary: Accept-Encoding\r\nDate: D\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nhtml\r\n0\r\n\r\n"
            };
            assert_eq!(bytes, expected.as_bytes());
        }
        task.await.unwrap();
        for extra in [
            ("cookie", "a=b"),
            ("authorization", "Bearer fixture"),
            ("range", "bytes=0-1"),
            ("if-none-match", "*"),
            ("accept-encoding", "gzip"),
            ("x-unknown", "1"),
            ("content-length", "1"),
        ] {
            let mut bad = request("GET", &[("host", "localhost"), extra]);
            bad.target = "/other-conversations".into();
            assert_eq!(handle(state.clone(), bad).await.status, 502);
        }
        for (method, path) in [
            ("POST", "/other-conversations"),
            ("GET", "/other-conversations?x=1"),
            ("GET", "/other-conversations/%20"),
        ] {
            let mut bad = Request {
                method: req.method.clone(),
                target: req.target.clone(),
                headers: req.headers.clone(),
                body: req.body.clone(),
            };
            bad.method = method.into();
            bad.target = path.into();
            assert_eq!(handle(state.clone(), bad).await.status, 502);
        }
        assert_eq!(
            state
                .other_conversations_page_served
                .load(Ordering::Relaxed),
            2
        );
        assert_eq!(
            state
                .other_conversations_page_fallback
                .load(Ordering::Relaxed),
            11
        );
    }
    #[tokio::test]
    async fn delphi_validation_gate_boundaries_and_missing_without_database() {
        let mut state = app(true);
        let req = |target: &str| {
            let mut r = request("GET", &[("host", "localhost")]);
            r.target = target.into();
            r
        };
        assert_eq!(
            handle(state.clone(), req("/api/v3/delphi")).await.status,
            502
        );
        let pool = state.db.clone();
        Arc::get_mut(&mut state).unwrap().delphi_read_db = Some(pool);
        for target in [
            "/api/v3/delphi",
            "/api/v3/delphi?",
            "/api/v3/delphi?report_id=",
            "/api/v3/delphi?report_id",
        ] {
            let out = handle(state.clone(), req(target)).await;
            assert_eq!(out.status, 400);
            assert!(
                matches!(out.body,Body::Fixed(ref b) if b==br#"{"status":"error","message":"report_id is required"}"#)
            );
        }
        for target in [
            "/api/v3/delphi?report_id=fixture",
            "/api/v3/delphi?unknown=1",
            "/api/v3/delphi?report_id=a&report_id=b",
            "/api/v3/delphi?report_id[]=a",
            "/api/v3/delphi?report_id[x]=a",
            "/api/v3/delphi?report_id=%E9%9B%AA",
            "/api/v3/delphi?job_id=x",
        ] {
            assert_eq!(handle(state.clone(), req(target)).await.status, 502);
        }
        for header in [
            ("authorization", "Bearer fixture.invalid"),
            ("cookie", "fixture=1"),
            ("content-length", "1"),
            ("transfer-encoding", "chunked"),
        ] {
            let mut r = request("GET", &[("host", "localhost"), header]);
            r.target = "/api/v3/delphi".into();
            assert_eq!(handle(state.clone(), r).await.status, 502);
        }
        for method in ["POST", "OPTIONS"] {
            let mut r = req("/api/v3/delphi");
            r.method = method.into();
            assert_eq!(handle(state.clone(), r).await.status, 502);
        }
        assert_eq!(state.delphi_read_served.load(Ordering::Relaxed), 4);
        assert_eq!(state.delphi_read_fallback.load(Ordering::Relaxed), 14);
    }
    #[cfg(feature = "db-tests")]
    #[tokio::test]
    async fn delphi_unknown_reports_use_independent_bounded_read_only_pool() {
        use polis_queue_adapter::jobs::transport::Connector;
        use std::time::Duration;
        let url = std::env::var("POLIS_API_TEST_DATABASE_URL").unwrap();
        let schema = format!("delphi_validation_test_{}", std::process::id());
        let setup_url = url.clone();
        let setup_schema = schema.clone();
        tokio::task::spawn_blocking(move||{let mut c=postgres::Client::connect(&setup_url,postgres::NoTls).unwrap();c.batch_execute(&format!("CREATE SCHEMA {setup_schema}; CREATE TABLE {setup_schema}.reports(report_id text,zid integer); INSERT INTO {setup_schema}.reports VALUES ('exists',1),('zero',0),('null',NULL),('duplicate',1),('duplicate',2);")).unwrap();}).await.unwrap();
        let make_pool = || {
            let mut cfg: postgres::Config = url.parse().unwrap();
            cfg.options(&format!("-c search_path={schema}"));
            Pool::new(
                Connector::Plain(Box::new(cfg)),
                crate::delphi_read::pool_limits(),
            )
        };
        let probe_pool = make_pool();
        let participant_pool = make_pool();
        let mut state = app(true);
        Arc::get_mut(&mut state).unwrap().delphi_read_db = Some(probe_pool.clone());
        Arc::get_mut(&mut state).unwrap().next_comment_db = Some(participant_pool.clone());
        let req = |id: &str| {
            let mut r = request("GET", &[("host", "localhost")]);
            r.target = format!("/api/v3/delphi?report_id={id}");
            r
        };
        let out = handle(state.clone(), req("missing")).await;
        assert_eq!(out.status, 404);
        assert!(
            matches!(out.body,Body::Fixed(ref b) if b==br#"{"status":"error","message":"Could not find conversation for report_id","report_id":"missing"}"#)
        );
        for id in ["exists", "zero", "null", "duplicate"] {
            assert_eq!(handle(state.clone(), req(id)).await.status, 502);
        }
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let lock_url = url.clone();
        let lock_schema = schema.clone();
        let lock = tokio::task::spawn_blocking(move || {
            let mut c = postgres::Client::connect(&lock_url, postgres::NoTls).unwrap();
            c.batch_execute(&format!(
                "BEGIN; LOCK TABLE {lock_schema}.reports IN ACCESS EXCLUSIVE MODE"
            ))
            .unwrap();
            ready_tx.send(()).unwrap();
            release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            c.batch_execute("ROLLBACK").unwrap();
        });
        ready_rx.await.unwrap();
        // A real blocked report query sheds itself. The participation pool stays
        // independently usable; this is isolation evidence, not a load claim.
        assert!(participant_pool.ping().await);
        assert_eq!(handle(state.clone(), req("missing")).await.status, 502);
        release_tx.send(()).unwrap();
        lock.await.unwrap();
        assert_eq!(handle(state.clone(), req("missing")).await.status, 404);
        let err = probe_pool
            .with(|c| Ok(c.batch_execute("INSERT INTO reports VALUES ('forbidden',1)")?))
            .await
            .unwrap_err();
        assert!(format!("{err:#}").contains("read-only"));
        tokio::task::spawn_blocking(move || {
            drop(state);
            drop(probe_pool);
            drop(participant_pool);
            let mut c = postgres::Client::connect(&url, postgres::NoTls).unwrap();
            c.batch_execute(&format!("DROP SCHEMA {schema} CASCADE"))
                .unwrap();
        })
        .await
        .unwrap();
    }
    #[tokio::test]
    async fn delphi_reports_validation_gate_boundaries_and_missing_without_database() {
        let mut state = app(true);
        let req = |target: &str| {
            let mut r = request("GET", &[("host", "localhost")]);
            r.target = target.into();
            r
        };
        assert_eq!(
            handle(state.clone(), req("/api/v3/delphi/reports"))
                .await
                .status,
            502
        );
        let pool = state.db.clone();
        Arc::get_mut(&mut state).unwrap().delphi_reports_db = Some(pool);
        for target in [
            "/api/v3/delphi/reports",
            "/api/v3/delphi/reports?",
            "/api/v3/delphi/reports?report_id=",
            "/api/v3/delphi/reports?report_id",
        ] {
            let out = handle(state.clone(), req(target)).await;
            assert_eq!(out.status, 200);
            assert!(
                matches!(out.body,Body::Fixed(ref b) if b==br#"{"status":"error","message":"report_id (requestReportId) is required"}"#)
            );
        }
        for target in [
            "/api/v3/delphi/reports?report_id=fixture",
            "/api/v3/delphi/reports?unknown=1",
            "/api/v3/delphi/reports?report_id=a&report_id=b",
            "/api/v3/delphi/reports?report_id[]=a",
            "/api/v3/delphi/reports?report_id[x]=a",
            "/api/v3/delphi/reports?report_id=%E9%9B%AA",
            "/api/v3/delphi/reports?job_id=x",
        ] {
            assert_eq!(handle(state.clone(), req(target)).await.status, 502);
        }
        for header in [
            ("authorization", "Bearer fixture.invalid"),
            ("cookie", "fixture=1"),
            ("content-length", "1"),
            ("transfer-encoding", "chunked"),
        ] {
            let mut r = request("GET", &[("host", "localhost"), header]);
            r.target = "/api/v3/delphi/reports".into();
            assert_eq!(handle(state.clone(), r).await.status, 502);
        }
        for method in ["POST", "OPTIONS"] {
            let mut r = req("/api/v3/delphi/reports");
            r.method = method.into();
            assert_eq!(handle(state.clone(), r).await.status, 502);
        }
        assert_eq!(state.delphi_reports_served.load(Ordering::Relaxed), 4);
        assert_eq!(state.delphi_reports_fallback.load(Ordering::Relaxed), 14);
    }
    #[cfg(feature = "db-tests")]
    #[tokio::test]
    async fn delphi_reports_unknown_reports_use_independent_bounded_read_only_pool() {
        use polis_queue_adapter::jobs::transport::Connector;
        use std::time::Duration;
        let url = std::env::var("POLIS_API_TEST_DATABASE_URL").unwrap();
        let schema = format!("delphi_reports_validation_test_{}", std::process::id());
        let setup_url = url.clone();
        let setup_schema = schema.clone();
        tokio::task::spawn_blocking(move||{let mut c=postgres::Client::connect(&setup_url,postgres::NoTls).unwrap();c.batch_execute(&format!("CREATE SCHEMA {setup_schema}; CREATE TABLE {setup_schema}.reports(report_id text,zid integer); INSERT INTO {setup_schema}.reports VALUES ('exists',1),('zero',0),('null',NULL),('duplicate',1),('duplicate',2);")).unwrap();}).await.unwrap();
        let make_pool = || {
            let mut cfg: postgres::Config = url.parse().unwrap();
            cfg.options(&format!("-c search_path={schema}"));
            Pool::new(
                Connector::Plain(Box::new(cfg)),
                crate::delphi_reports::pool_limits(),
            )
        };
        let probe_pool = make_pool();
        let participant_pool = make_pool();
        let mut state = app(true);
        Arc::get_mut(&mut state).unwrap().delphi_reports_db = Some(probe_pool.clone());
        Arc::get_mut(&mut state).unwrap().next_comment_db = Some(participant_pool.clone());
        let req = |id: &str| {
            let mut r = request("GET", &[("host", "localhost")]);
            r.target = format!("/api/v3/delphi/reports?report_id={id}");
            r
        };
        let out = handle(state.clone(), req("missing")).await;
        assert_eq!(out.status, 200);
        assert!(
            matches!(out.body,Body::Fixed(ref b) if b==br#"{"status":"error","message":"Could not find a valid identifier for the report_id to query DynamoDB.","request_report_id":"missing"}"#)
        );
        for id in ["exists", "zero", "null", "duplicate"] {
            assert_eq!(handle(state.clone(), req(id)).await.status, 502);
        }
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let lock_url = url.clone();
        let lock_schema = schema.clone();
        let lock = tokio::task::spawn_blocking(move || {
            let mut c = postgres::Client::connect(&lock_url, postgres::NoTls).unwrap();
            c.batch_execute(&format!(
                "BEGIN; LOCK TABLE {lock_schema}.reports IN ACCESS EXCLUSIVE MODE"
            ))
            .unwrap();
            ready_tx.send(()).unwrap();
            release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            c.batch_execute("ROLLBACK").unwrap();
        });
        ready_rx.await.unwrap();
        // A real blocked report query sheds itself. The participation pool stays
        // independently usable; this is isolation evidence, not a load claim.
        assert!(participant_pool.ping().await);
        assert_eq!(handle(state.clone(), req("missing")).await.status, 502);
        release_tx.send(()).unwrap();
        lock.await.unwrap();
        assert_eq!(handle(state.clone(), req("missing")).await.status, 200);
        let err = probe_pool
            .with(|c| Ok(c.batch_execute("INSERT INTO reports VALUES ('forbidden',1)")?))
            .await
            .unwrap_err();
        assert!(format!("{err:#}").contains("read-only"));
        tokio::task::spawn_blocking(move || {
            drop(state);
            drop(probe_pool);
            drop(participant_pool);
            let mut c = postgres::Client::connect(&url, postgres::NoTls).unwrap();
            c.batch_execute(&format!("DROP SCHEMA {schema} CASCADE"))
                .unwrap();
        })
        .await
        .unwrap();
    }
    #[tokio::test]
    async fn delphi_visualizations_validation_gate_boundaries_and_missing_without_database() {
        let mut state = app(true);
        let req = |target: &str| {
            let mut r = request("GET", &[("host", "localhost")]);
            r.target = target.into();
            r
        };
        assert_eq!(
            handle(state.clone(), req("/api/v3/delphi/visualizations"))
                .await
                .status,
            502
        );
        let pool = state.db.clone();
        Arc::get_mut(&mut state).unwrap().delphi_visualizations_db = Some(pool);
        for target in [
            "/api/v3/delphi/visualizations",
            "/api/v3/delphi/visualizations?",
            "/api/v3/delphi/visualizations?report_id=",
            "/api/v3/delphi/visualizations?report_id",
        ] {
            let out = handle(state.clone(), req(target)).await;
            assert_eq!(out.status, 400);
            assert!(
                matches!(out.body,Body::Fixed(ref b) if b==br#"{"status":"error","message":"report_id is required"}"#)
            );
        }
        for target in [
            "/api/v3/delphi/visualizations?report_id=fixture",
            "/api/v3/delphi/visualizations?unknown=1",
            "/api/v3/delphi/visualizations?report_id=a&report_id=b",
            "/api/v3/delphi/visualizations?report_id[]=a",
            "/api/v3/delphi/visualizations?report_id[x]=a",
            "/api/v3/delphi/visualizations?report_id=%E9%9B%AA",
            "/api/v3/delphi/visualizations?job_id=x",
        ] {
            assert_eq!(handle(state.clone(), req(target)).await.status, 502);
        }
        for header in [
            ("authorization", "Bearer fixture.invalid"),
            ("cookie", "fixture=1"),
            ("content-length", "1"),
            ("transfer-encoding", "chunked"),
        ] {
            let mut r = request("GET", &[("host", "localhost"), header]);
            r.target = "/api/v3/delphi/visualizations".into();
            assert_eq!(handle(state.clone(), r).await.status, 502);
        }
        for method in ["POST", "OPTIONS"] {
            let mut r = req("/api/v3/delphi/visualizations");
            r.method = method.into();
            assert_eq!(handle(state.clone(), r).await.status, 502);
        }
        assert_eq!(
            state.delphi_visualizations_served.load(Ordering::Relaxed),
            4
        );
        assert_eq!(
            state.delphi_visualizations_fallback.load(Ordering::Relaxed),
            14
        );
    }
    #[cfg(feature = "db-tests")]
    #[tokio::test]
    async fn delphi_visualizations_unknown_reports_use_independent_bounded_read_only_pool() {
        use polis_queue_adapter::jobs::transport::Connector;
        use std::time::Duration;
        let url = std::env::var("POLIS_API_TEST_DATABASE_URL").unwrap();
        let schema = format!(
            "delphi_visualizations_validation_test_{}",
            std::process::id()
        );
        let setup_url = url.clone();
        let setup_schema = schema.clone();
        tokio::task::spawn_blocking(move||{let mut c=postgres::Client::connect(&setup_url,postgres::NoTls).unwrap();c.batch_execute(&format!("CREATE SCHEMA {setup_schema}; CREATE TABLE {setup_schema}.reports(report_id text,zid integer); INSERT INTO {setup_schema}.reports VALUES ('exists',1),('zero',0),('null',NULL),('duplicate',1),('duplicate',2);")).unwrap();}).await.unwrap();
        let make_pool = || {
            let mut cfg: postgres::Config = url.parse().unwrap();
            cfg.options(&format!("-c search_path={schema}"));
            Pool::new(
                Connector::Plain(Box::new(cfg)),
                crate::delphi_visualizations::pool_limits(),
            )
        };
        let probe_pool = make_pool();
        let participant_pool = make_pool();
        let mut state = app(true);
        Arc::get_mut(&mut state).unwrap().delphi_visualizations_db = Some(probe_pool.clone());
        Arc::get_mut(&mut state).unwrap().next_comment_db = Some(participant_pool.clone());
        let req = |id: &str| {
            let mut r = request("GET", &[("host", "localhost")]);
            r.target = format!("/api/v3/delphi/visualizations?report_id={id}");
            r
        };
        let out = handle(state.clone(), req("missing")).await;
        assert_eq!(out.status, 404);
        assert!(
            matches!(out.body,Body::Fixed(ref b) if b==br#"{"status":"error","message":"Could not find conversation for report_id","report_id":"missing"}"#)
        );
        for id in ["exists", "zero", "null", "duplicate"] {
            assert_eq!(handle(state.clone(), req(id)).await.status, 502);
        }
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let lock_url = url.clone();
        let lock_schema = schema.clone();
        let lock = tokio::task::spawn_blocking(move || {
            let mut c = postgres::Client::connect(&lock_url, postgres::NoTls).unwrap();
            c.batch_execute(&format!(
                "BEGIN; LOCK TABLE {lock_schema}.reports IN ACCESS EXCLUSIVE MODE"
            ))
            .unwrap();
            ready_tx.send(()).unwrap();
            release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            c.batch_execute("ROLLBACK").unwrap();
        });
        ready_rx.await.unwrap();
        // A real blocked report query sheds itself. The participation pool stays
        // independently usable; this is isolation evidence, not a load claim.
        assert!(participant_pool.ping().await);
        assert_eq!(handle(state.clone(), req("missing")).await.status, 502);
        release_tx.send(()).unwrap();
        lock.await.unwrap();
        assert_eq!(handle(state.clone(), req("missing")).await.status, 404);
        let err = probe_pool
            .with(|c| Ok(c.batch_execute("INSERT INTO reports VALUES ('forbidden',1)")?))
            .await
            .unwrap_err();
        assert!(format!("{err:#}").contains("read-only"));
        tokio::task::spawn_blocking(move || {
            drop(state);
            drop(probe_pool);
            drop(participant_pool);
            let mut c = postgres::Client::connect(&url, postgres::NoTls).unwrap();
            c.batch_execute(&format!("DROP SCHEMA {schema} CASCADE"))
                .unwrap();
        })
        .await
        .unwrap();
    }
    #[tokio::test]
    async fn topic_stats_validation_gate_boundaries_and_missing_without_database() {
        let mut state = app(true);
        let req = |target: &str| {
            let mut r = request("GET", &[("host", "localhost")]);
            r.target = target.into();
            r
        };
        assert_eq!(
            handle(state.clone(), req("/api/v3/topicStats"))
                .await
                .status,
            502
        );
        let pool = state.db.clone();
        Arc::get_mut(&mut state).unwrap().topic_stats_db = Some(pool);
        for target in [
            "/api/v3/topicStats",
            "/api/v3/topicStats?",
            "/api/v3/topicStats?report_id=",
            "/api/v3/topicStats?report_id",
        ] {
            let out = handle(state.clone(), req(target)).await;
            assert_eq!(out.status, 400);
            assert!(
                matches!(out.body,Body::Fixed(ref b) if b==br#"{"status":"error","message":"report_id is required"}"#)
            );
        }
        for target in [
            "/api/v3/topicStats?report_id=fixture",
            "/api/v3/topicStats?unknown=1",
            "/api/v3/topicStats?report_id=a&report_id=b",
            "/api/v3/topicStats?report_id[]=a",
            "/api/v3/topicStats?report_id[x]=a",
            "/api/v3/topicStats?report_id=%E9%9B%AA",
            "/api/v3/topicStats?job_id=x",
        ] {
            assert_eq!(handle(state.clone(), req(target)).await.status, 502);
        }
        for header in [
            ("authorization", "Bearer fixture.invalid"),
            ("cookie", "fixture=1"),
            ("content-length", "1"),
            ("transfer-encoding", "chunked"),
        ] {
            let mut r = request("GET", &[("host", "localhost"), header]);
            r.target = "/api/v3/topicStats".into();
            assert_eq!(handle(state.clone(), r).await.status, 502);
        }
        for method in ["POST", "OPTIONS"] {
            let mut r = req("/api/v3/topicStats");
            r.method = method.into();
            assert_eq!(handle(state.clone(), r).await.status, 502);
        }
        assert_eq!(state.topic_stats_served.load(Ordering::Relaxed), 4);
        assert_eq!(state.topic_stats_fallback.load(Ordering::Relaxed), 14);
    }
    #[cfg(feature = "db-tests")]
    #[tokio::test]
    async fn topic_stats_unknown_reports_use_independent_bounded_read_only_pool() {
        use polis_queue_adapter::jobs::transport::Connector;
        use std::time::Duration;
        let url = std::env::var("POLIS_API_TEST_DATABASE_URL").unwrap();
        let schema = format!("topic_stats_validation_test_{}", std::process::id());
        let setup_url = url.clone();
        let setup_schema = schema.clone();
        tokio::task::spawn_blocking(move||{let mut c=postgres::Client::connect(&setup_url,postgres::NoTls).unwrap();c.batch_execute(&format!("CREATE SCHEMA {setup_schema}; CREATE TABLE {setup_schema}.reports(report_id text,zid integer); INSERT INTO {setup_schema}.reports VALUES ('exists',1),('zero',0),('null',NULL),('duplicate',1),('duplicate',2);")).unwrap();}).await.unwrap();
        let make_pool = || {
            let mut cfg: postgres::Config = url.parse().unwrap();
            cfg.options(&format!("-c search_path={schema}"));
            Pool::new(
                Connector::Plain(Box::new(cfg)),
                crate::topic_stats::pool_limits(),
            )
        };
        let probe_pool = make_pool();
        let participant_pool = make_pool();
        let mut state = app(true);
        Arc::get_mut(&mut state).unwrap().topic_stats_db = Some(probe_pool.clone());
        Arc::get_mut(&mut state).unwrap().next_comment_db = Some(participant_pool.clone());
        let req = |id: &str| {
            let mut r = request("GET", &[("host", "localhost")]);
            r.target = format!("/api/v3/topicStats?report_id={id}");
            r
        };
        let out = handle(state.clone(), req("missing")).await;
        assert_eq!(out.status, 404);
        assert!(
            matches!(out.body,Body::Fixed(ref b) if b==br#"{"status":"error","message":"Could not find conversation for report_id","report_id":"missing"}"#)
        );
        for id in ["exists", "zero", "null", "duplicate"] {
            assert_eq!(handle(state.clone(), req(id)).await.status, 502);
        }
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let lock_url = url.clone();
        let lock_schema = schema.clone();
        let lock = tokio::task::spawn_blocking(move || {
            let mut c = postgres::Client::connect(&lock_url, postgres::NoTls).unwrap();
            c.batch_execute(&format!(
                "BEGIN; LOCK TABLE {lock_schema}.reports IN ACCESS EXCLUSIVE MODE"
            ))
            .unwrap();
            ready_tx.send(()).unwrap();
            release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            c.batch_execute("ROLLBACK").unwrap();
        });
        ready_rx.await.unwrap();
        // A real blocked report query sheds itself. The participation pool stays
        // independently usable; this is isolation evidence, not a load claim.
        assert!(participant_pool.ping().await);
        assert_eq!(handle(state.clone(), req("missing")).await.status, 502);
        release_tx.send(()).unwrap();
        lock.await.unwrap();
        assert_eq!(handle(state.clone(), req("missing")).await.status, 404);
        let err = probe_pool
            .with(|c| Ok(c.batch_execute("INSERT INTO reports VALUES ('forbidden',1)")?))
            .await
            .unwrap_err();
        assert!(format!("{err:#}").contains("read-only"));
        tokio::task::spawn_blocking(move || {
            drop(state);
            drop(probe_pool);
            drop(participant_pool);
            let mut c = postgres::Client::connect(&url, postgres::NoTls).unwrap();
            c.batch_execute(&format!("DROP SCHEMA {schema} CASCADE"))
                .unwrap();
        })
        .await
        .unwrap();
    }
    #[tokio::test]
    async fn collective_statement_validation_gate_boundaries_and_missing_without_database() {
        let mut state = app(true);
        let req = |target: &str| {
            let mut r = request("GET", &[("host", "localhost")]);
            r.target = target.into();
            r
        };
        assert_eq!(
            handle(state.clone(), req("/api/v3/collectiveStatement"))
                .await
                .status,
            502
        );
        let pool = state.db.clone();
        Arc::get_mut(&mut state).unwrap().collective_statement_db = Some(pool);
        for target in [
            "/api/v3/collectiveStatement",
            "/api/v3/collectiveStatement?",
            "/api/v3/collectiveStatement?report_id=",
            "/api/v3/collectiveStatement?report_id",
        ] {
            let out = handle(state.clone(), req(target)).await;
            assert_eq!(out.status, 400);
            assert!(
                matches!(out.body,Body::Fixed(ref b) if b==br#"{"status":"error","message":"statement_id or report_id is required"}"#)
            );
        }
        for target in [
            "/api/v3/collectiveStatement?report_id=fixture",
            "/api/v3/collectiveStatement?unknown=1",
            "/api/v3/collectiveStatement?report_id=a&report_id=b",
            "/api/v3/collectiveStatement?report_id[]=a",
            "/api/v3/collectiveStatement?report_id[x]=a",
            "/api/v3/collectiveStatement?report_id=%E9%9B%AA",
            "/api/v3/collectiveStatement?job_id=x",
            "/api/v3/collectiveStatement?statement_id=generated",
            "/api/v3/collectiveStatement?statement_id=",
            "/api/v3/collectiveStatement?report_id=missing&statement_id=generated",
        ] {
            assert_eq!(handle(state.clone(), req(target)).await.status, 502);
        }
        for header in [
            ("authorization", "Bearer fixture.invalid"),
            ("cookie", "fixture=1"),
            ("content-length", "1"),
            ("transfer-encoding", "chunked"),
        ] {
            let mut r = request("GET", &[("host", "localhost"), header]);
            r.target = "/api/v3/collectiveStatement".into();
            assert_eq!(handle(state.clone(), r).await.status, 502);
        }
        for method in ["POST", "OPTIONS"] {
            let mut r = req("/api/v3/collectiveStatement");
            r.method = method.into();
            assert_eq!(handle(state.clone(), r).await.status, 502);
        }
        assert_eq!(state.collective_statement_served.load(Ordering::Relaxed), 4);
        assert_eq!(
            state.collective_statement_fallback.load(Ordering::Relaxed),
            17
        );
    }
    #[cfg(feature = "db-tests")]
    #[tokio::test]
    async fn collective_statement_unknown_reports_use_independent_bounded_read_only_pool() {
        use polis_queue_adapter::jobs::transport::Connector;
        use std::time::Duration;
        let url = std::env::var("POLIS_API_TEST_DATABASE_URL").unwrap();
        let schema = format!(
            "collective_statement_validation_test_{}",
            std::process::id()
        );
        let setup_url = url.clone();
        let setup_schema = schema.clone();
        tokio::task::spawn_blocking(move||{let mut c=postgres::Client::connect(&setup_url,postgres::NoTls).unwrap();c.batch_execute(&format!("CREATE SCHEMA {setup_schema}; CREATE TABLE {setup_schema}.reports(report_id text,zid integer); INSERT INTO {setup_schema}.reports VALUES ('exists',1),('zero',0),('null',NULL),('duplicate',1),('duplicate',2);")).unwrap();}).await.unwrap();
        let make_pool = || {
            let mut cfg: postgres::Config = url.parse().unwrap();
            cfg.options(&format!("-c search_path={schema}"));
            Pool::new(
                Connector::Plain(Box::new(cfg)),
                crate::collective_statement::pool_limits(),
            )
        };
        let probe_pool = make_pool();
        let participant_pool = make_pool();
        let mut state = app(true);
        Arc::get_mut(&mut state).unwrap().collective_statement_db = Some(probe_pool.clone());
        Arc::get_mut(&mut state).unwrap().next_comment_db = Some(participant_pool.clone());
        let req = |id: &str| {
            let mut r = request("GET", &[("host", "localhost")]);
            r.target = format!("/api/v3/collectiveStatement?report_id={id}");
            r
        };
        let out = handle(state.clone(), req("missing")).await;
        assert_eq!(out.status, 404);
        assert!(
            matches!(out.body,Body::Fixed(ref b) if b==br#"{"status":"error","message":"Could not find conversation for report_id"}"#)
        );
        for id in ["exists", "zero", "null", "duplicate"] {
            assert_eq!(handle(state.clone(), req(id)).await.status, 502);
        }
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let lock_url = url.clone();
        let lock_schema = schema.clone();
        let lock = tokio::task::spawn_blocking(move || {
            let mut c = postgres::Client::connect(&lock_url, postgres::NoTls).unwrap();
            c.batch_execute(&format!(
                "BEGIN; LOCK TABLE {lock_schema}.reports IN ACCESS EXCLUSIVE MODE"
            ))
            .unwrap();
            ready_tx.send(()).unwrap();
            release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            c.batch_execute("ROLLBACK").unwrap();
        });
        ready_rx.await.unwrap();
        // A real blocked report query sheds itself. The participation pool stays
        // independently usable; this is isolation evidence, not a load claim.
        assert!(participant_pool.ping().await);
        assert_eq!(handle(state.clone(), req("missing")).await.status, 502);
        release_tx.send(()).unwrap();
        lock.await.unwrap();
        assert_eq!(handle(state.clone(), req("missing")).await.status, 404);
        let err = probe_pool
            .with(|c| Ok(c.batch_execute("INSERT INTO reports VALUES ('forbidden',1)")?))
            .await
            .unwrap_err();
        assert!(format!("{err:#}").contains("read-only"));
        tokio::task::spawn_blocking(move || {
            drop(state);
            drop(probe_pool);
            drop(participant_pool);
            let mut c = postgres::Client::connect(&url, postgres::NoTls).unwrap();
            c.batch_execute(&format!("DROP SCHEMA {schema} CASCADE"))
                .unwrap();
        })
        .await
        .unwrap();
    }
    #[tokio::test]
    async fn ops_whoami_disabled_response_needs_no_database() {
        let mut state = app(true);
        let probe = |method| {
            let mut req = request(method, &[("host", "localhost")]);
            req.target = crate::ops_whoami::PATH.into();
            req
        };
        assert_eq!(handle(state.clone(), probe("GET")).await.status, 502);
        Arc::get_mut(&mut state).unwrap().ops_whoami_reads = true;
        let out = handle(state.clone(), probe("GET")).await;
        assert_eq!(out.status, 404);
        assert_eq!(header(&out, "Cache-Control"), Some("private, no-store"));
        assert_eq!(header(&out, "X-Content-Type-Options"), Some("nosniff"));
        assert_eq!(header(&out, "Vary"), Some("Authorization, Accept-Encoding"));
        assert!(matches!(out.body, Body::Fixed(ref b) if b == br#"{"error":"not_found"}"#));
        let head = handle(state.clone(), probe("HEAD")).await;
        assert_eq!(head.status, 404);
        let wire = crate::http::write_response(&head, true, false, "D").unwrap();
        assert!(wire.ends_with(b"\r\n\r\n"));
        assert!(!wire.windows(9).any(|w| w == b"not_found"));
        assert_eq!(state.ops_whoami_served.load(Ordering::Relaxed), 2);
        assert_eq!(state.ops_whoami_fallback.load(Ordering::Relaxed), 1);
    }
    #[tokio::test]
    async fn ops_whoami_boundaries_are_counted_node_handoffs() {
        let mut state = app(true);
        Arc::get_mut(&mut state).unwrap().ops_whoami_reads = true;
        for (method, target, headers) in [
            ("POST", crate::ops_whoami::PATH, vec![]),
            ("OPTIONS", crate::ops_whoami::PATH, vec![]),
            ("GET", "/api/v3/ops/whoami?unknown=1", vec![]),
            (
                "GET",
                crate::ops_whoami::PATH,
                vec![("authorization", "Bearer fixture")],
            ),
            (
                "GET",
                crate::ops_whoami::PATH,
                vec![("cookie", "fixture=1")],
            ),
            (
                "GET",
                crate::ops_whoami::PATH,
                vec![("content-length", "1")],
            ),
        ] {
            let mut req = request(method, &headers);
            req.target = target.into();
            assert_eq!(handle(state.clone(), req).await.status, 502);
        }
        assert_eq!(state.ops_whoami_served.load(Ordering::Relaxed), 0);
        assert_eq!(state.ops_whoami_fallback.load(Ordering::Relaxed), 6);
    }
    #[tokio::test]
    async fn ops_page_disabled_response_needs_no_database() {
        let mut state = app(true);
        let probe = |method| {
            let mut req = request(method, &[("host", "localhost")]);
            req.target = "/api/v3/ops/page/fixture".into();
            req
        };
        assert_eq!(handle(state.clone(), probe("GET")).await.status, 502);
        Arc::get_mut(&mut state).unwrap().ops_page_reads = true;
        let out = handle(state.clone(), probe("GET")).await;
        assert_eq!(out.status, 404);
        assert_eq!(header(&out, "Cache-Control"), Some("private, no-store"));
        assert_eq!(header(&out, "X-Content-Type-Options"), Some("nosniff"));
        assert_eq!(header(&out, "Vary"), Some("Authorization, Accept-Encoding"));
        assert!(matches!(out.body, Body::Fixed(ref b) if b == br#"{"error":"not_found"}"#));
        let head = handle(state.clone(), probe("HEAD")).await;
        assert_eq!(head.status, 404);
        let wire = crate::http::write_response(&head, true, false, "D").unwrap();
        assert!(wire.ends_with(b"\r\n\r\n"));
        assert!(!wire.windows(9).any(|w| w == b"not_found"));
        assert_eq!(state.ops_page_served.load(Ordering::Relaxed), 2);
        assert_eq!(state.ops_page_fallback.load(Ordering::Relaxed), 1);
    }
    #[tokio::test]
    async fn ops_page_boundaries_are_counted_node_handoffs() {
        let mut state = app(true);
        Arc::get_mut(&mut state).unwrap().ops_page_reads = true;
        for (method, target, headers) in [
            ("POST", "/api/v3/ops/page/fixture", vec![]),
            ("OPTIONS", "/api/v3/ops/page/fixture", vec![]),
            ("GET", "/api/v3/ops/page/fixture?unknown=1", vec![]),
            (
                "GET",
                "/api/v3/ops/page/fixture",
                vec![("authorization", "Bearer fixture")],
            ),
            (
                "GET",
                "/api/v3/ops/page/fixture",
                vec![("cookie", "fixture=1")],
            ),
            (
                "GET",
                "/api/v3/ops/page/fixture",
                vec![("content-length", "1")],
            ),
        ] {
            let mut req = request(method, &headers);
            req.target = target.into();
            assert_eq!(handle(state.clone(), req).await.status, 502);
        }
        assert_eq!(state.ops_page_served.load(Ordering::Relaxed), 0);
        assert_eq!(state.ops_page_fallback.load(Ordering::Relaxed), 6);
    }
    #[tokio::test]
    async fn ops_catchall_disabled_response_needs_no_database() {
        let mut state = app(true);
        let probe = |method| {
            let mut req = request(method, &[("host", "localhost")]);
            req.target = "/api/v3/ops/unknown".into();
            req
        };
        assert_eq!(handle(state.clone(), probe("GET")).await.status, 502);
        Arc::get_mut(&mut state).unwrap().ops_catchall_reads = true;
        let out = handle(state.clone(), probe("GET")).await;
        assert_eq!(out.status, 404);
        assert_eq!(header(&out, "Cache-Control"), Some("private, no-store"));
        assert_eq!(header(&out, "X-Content-Type-Options"), Some("nosniff"));
        assert_eq!(header(&out, "Vary"), Some("Authorization, Accept-Encoding"));
        assert!(matches!(out.body, Body::Fixed(ref b) if b == br#"{"error":"not_found"}"#));
        let head = handle(state.clone(), probe("HEAD")).await;
        assert_eq!(head.status, 404);
        let wire = crate::http::write_response(&head, true, false, "D").unwrap();
        assert!(wire.ends_with(b"\r\n\r\n"));
        assert!(!wire.windows(9).any(|w| w == b"not_found"));
        assert_eq!(state.ops_catchall_served.load(Ordering::Relaxed), 2);
        assert_eq!(state.ops_catchall_fallback.load(Ordering::Relaxed), 1);
    }
    #[tokio::test]
    async fn ops_catchall_boundaries_are_counted_node_handoffs() {
        let mut state = app(true);
        Arc::get_mut(&mut state).unwrap().ops_catchall_reads = true;
        for (method, target, headers) in [
            ("POST", "/api/v3/ops/unknown", vec![]),
            ("OPTIONS", "/api/v3/ops/unknown", vec![]),
            ("GET", "/api/v3/ops/unknown?unknown=1", vec![]),
            (
                "GET",
                "/api/v3/ops/unknown",
                vec![("authorization", "Bearer fixture")],
            ),
            ("GET", "/api/v3/ops/unknown", vec![("cookie", "fixture=1")]),
            ("GET", "/api/v3/ops/unknown", vec![("content-length", "1")]),
        ] {
            let mut req = request(method, &headers);
            req.target = target.into();
            assert_eq!(handle(state.clone(), req).await.status, 502);
        }
        assert_eq!(state.ops_catchall_served.load(Ordering::Relaxed), 0);
        assert_eq!(state.ops_catchall_fallback.load(Ordering::Relaxed), 6);
    }
    #[tokio::test]
    async fn delphi_run_gate_boundaries_and_refusals_without_database() {
        let mut state = app(true);
        let req = |target: &str, headers: &[(&str, &str)]| {
            let mut r = request("GET", headers);
            r.target = target.into();
            r
        };
        let host = ("host", "localhost");
        let run = "/api/v3/delphi/run?job_id=00000000-0000-4000-8000-000000000001";
        // Off by default: every request is Node's.
        assert_eq!(handle(state.clone(), req(run, &[host])).await.status, 502);
        let pool = state.db.clone();
        {
            let app = Arc::get_mut(&mut state).unwrap();
            app.delphi_run_db = Some(pool.clone());
            app.delphi_run_auth_db = Some(pool);
            app.delphi_run_env = "local".into();
        }
        // No bearer token: hybridAuth's 401, before any read (this database
        // is unreachable), with or without a job id.
        for (target, auth) in [
            (run, None),
            ("/api/v3/delphi/run", None),
            ("/api/v3/delphi/run?job_id=", None),
            (run, Some("Basic eDp4")),
            (run, Some("bearer x.y.z")),
        ] {
            let mut headers = vec![host];
            if let Some(a) = auth {
                headers.push(("authorization", a));
            }
            let out = handle(state.clone(), req(target, &headers)).await;
            assert_eq!(out.status, 401, "{target} {auth:?}");
            assert!(
                matches!(out.body, Body::Fixed(ref b) if b == br#"{"error":"No authentication token found"}"#)
            );
        }
        let mut head = req(run, &[host]);
        head.method = "HEAD".into();
        // The writer drops a HEAD answer's body on the wire (http.rs).
        assert_eq!(handle(state.clone(), head).await.status, 401);
        // A token this process cannot verify builds no identity: Node's.
        let out = handle(
            state.clone(),
            req(run, &[host, ("authorization", "Bearer x.y.z")]),
        )
        .await;
        assert_eq!(out.status, 502);
        // Query shapes, bodies and methods the route does not model: Node's.
        for target in [
            &format!("{run}&report_id=r"),
            &format!("{run}&job_id=00000000-0000-4000-8000-000000000001"),
            "/api/v3/delphi/run?job_id[]=x",
            "/api/v3/delphi/run?jobid=x",
            &format!("/api/v3/delphi/run?job_id={}", "a".repeat(101)),
        ] {
            assert_eq!(
                handle(state.clone(), req(target, &[host])).await.status,
                502,
                "{target}"
            );
        }
        for header in [("content-length", "1"), ("transfer-encoding", "chunked")] {
            assert_eq!(
                handle(state.clone(), req(run, &[host, header]))
                    .await
                    .status,
                502
            );
        }
        for method in ["POST", "OPTIONS", "PUT"] {
            let mut r = req(run, &[host]);
            r.method = method.into();
            assert_eq!(handle(state.clone(), r).await.status, 502, "{method}");
        }
        assert_eq!(state.delphi_run_served.load(Ordering::Relaxed), 6);
        assert_eq!(state.delphi_run_fallback.load(Ordering::Relaxed), 12);
    }
    #[cfg(feature = "db-tests")]
    #[tokio::test]
    async fn delphi_run_moderators_get_the_record_others_get_node_refusals_on_independent_pools() {
        use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
        use openssl::rsa::Rsa;
        use serde_json::json;
        const CONVERSATION: &str = "local-dynamo-1424";
        const RECORD: &str = include_str!("../conformance/delphi-run-fixtures/second.record.json");
        const GOLDEN: &str = include_str!("../conformance/delphi-run-fixtures/second.json");
        let url = std::env::var("POLIS_API_TEST_DATABASE_URL").unwrap();
        let schema = format!("delphi_run_test_{}", std::process::id());
        let job: String = serde_json::from_str::<serde_json::Value>(RECORD).unwrap()["job_id"]
            .as_str()
            .unwrap()
            .to_owned();
        let setup_url = url.clone();
        let setup_schema = schema.clone();
        let setup_job = job.clone();
        let record = RECORD.trim_end().replace('\'', "''");
        tokio::task::spawn_blocking(move || {
            let mut c = postgres::Client::connect(&setup_url, postgres::NoTls).unwrap();
            c.batch_execute(&format!(
                "CREATE SCHEMA {setup_schema}; SET search_path={setup_schema};
                 CREATE TABLE users(uid integer,site_id text);
                 CREATE TABLE oidc_user_mappings(uid integer,oidc_sub text);
                 CREATE TABLE conversations(zid integer,owner integer,treevite_enabled boolean);
                 CREATE TABLE zinvites(zid integer,zinvite text,created bigint);
                 CREATE TABLE participants(zid integer,uid integer,pid integer);
                 CREATE TABLE run_records(env text,job_id uuid,doc jsonb);
                 INSERT INTO users VALUES(1424,'owner-site'),(100000,'other-site'),(100002,'owner-site');
                 INSERT INTO conversations VALUES(1424,1424,false);
                 INSERT INTO zinvites VALUES(1424,'{CONVERSATION}',2),(1424,'a-later-code',3);
                 INSERT INTO participants VALUES(1424,1424,0),(1424,100000,1),(1424,100002,2);
                 INSERT INTO run_records VALUES('local','{setup_job}','{record}');
                 CREATE FUNCTION pd_run_record(p_env text,p_job uuid) RETURNS jsonb LANGUAGE sql STABLE
                  AS 'SELECT doc FROM {setup_schema}.run_records WHERE env=p_env AND job_id=p_job';"
            ))
            .unwrap();
        })
        .await
        .unwrap();
        let make_pool = |limits: crate::db::Limits| {
            let mut cfg: postgres::Config = url.parse().unwrap();
            cfg.options(&format!("-c search_path={schema}"));
            crate::db::Pool::new(
                polis_queue_adapter::jobs::transport::Connector::Plain(Box::new(cfg)),
                limits,
            )
        };
        let run_pool = make_pool(crate::delphi_run_read::pool_limits());
        let auth_pool = make_pool(crate::delphi_run_read::auth_pool_limits());
        let participation = make_pool(crate::delphi_run_read::auth_pool_limits());
        let rsa = Rsa::generate(2048).unwrap();
        let key = EncodingKey::from_rsa_pem(&rsa.private_key_to_pem().unwrap()).unwrap();
        let verifier = polis_auth::participant::Verifier::new(
            &rsa.public_key_to_pem().unwrap(),
            "participants",
            "participants",
        )
        .unwrap();
        let mut state = app(true);
        {
            let app = Arc::get_mut(&mut state).unwrap();
            app.delphi_run_db = Some(run_pool.clone());
            app.delphi_run_auth_db = Some(auth_pool.clone());
            app.delphi_run_env = "local".into();
            app.participant_verifier = Some(Arc::new(verifier));
            app.next_comment_db = Some(participation.clone());
        }
        let now = (crate::clock::now_ms() / 1000.0) as u64;
        let token = |uid: i32, pid: i32| {
            let claims = json!({"uid":uid,"pid":pid,"sub":format!("anon:{uid}"),"conversation_id":CONVERSATION,
                "iss":"participants","aud":"participants","exp":now+300,"iat":now,"anonymous_participant":true});
            format!(
                "Bearer {}",
                encode(&Header::new(Algorithm::RS256), &claims, &key).unwrap()
            )
        };
        let get = |state: &Arc<App>, target: String, auth: Option<String>, method: &str| {
            let state = state.clone();
            let mut r = match &auth {
                Some(a) => request(method, &[("host", "localhost"), ("authorization", a)]),
                None => request(method, &[("host", "localhost")]),
            };
            r.target = target;
            async move { handle(state, r).await }
        };
        let body = |out: &Outgoing| match &out.body {
            Body::Fixed(b) => String::from_utf8(b.clone()).unwrap(),
            _ => panic!("expected a fixed body"),
        };
        let run = format!("/api/v3/delphi/run?job_id={job}");
        // The owner (a moderator of their own site's conversation): the record.
        let out = get(&state, run.clone(), Some(token(1424, 0)), "GET").await;
        assert_eq!(out.status, 200);
        assert_eq!(body(&out), GOLDEN.trim_end());
        // A moderator of the same site, through their participant token.
        let out = get(&state, run.clone(), Some(token(100002, 2)), "GET").await;
        assert_eq!(out.status, 200);
        // Another site's participant: Node's refusal shape.
        let out = get(&state, run.clone(), Some(token(100000, 1)), "GET").await;
        assert_eq!(out.status, 403);
        assert_eq!(
            body(&out),
            r#"{"status":"error","message":"polis_err_delphi_run_auth"}"#
        );
        // A token naming a pid the participant does not hold builds no identity.
        let out = get(&state, run.clone(), Some(token(100000, 7)), "GET").await;
        assert_eq!(out.status, 502);
        let out = get(&state, run.clone(), None, "GET").await;
        assert_eq!(out.status, 401);
        let out = get(
            &state,
            "/api/v3/delphi/run".into(),
            Some(token(1424, 0)),
            "GET",
        )
        .await;
        assert_eq!(out.status, 400);
        let out = get(
            &state,
            "/api/v3/delphi/run?job_id=00000000-0000-4000-8000-000000000000".into(),
            Some(token(1424, 0)),
            "GET",
        )
        .await;
        assert_eq!(out.status, 404);
        assert_eq!(
            body(&out),
            r#"{"status":"error","message":"Job not found"}"#
        );
        // A configured administrator passes the moderator rule.
        Arc::get_mut(&mut state).unwrap().legacy_admin_uids = vec![100000];
        let out = get(&state, run.clone(), Some(token(100000, 1)), "GET").await;
        assert_eq!(out.status, 200);
        assert_eq!(body(&out), GOLDEN.trim_end());
        // A blocked record read sheds itself within the route's deadline; the
        // participation pool stays usable. Isolation evidence, not a load claim.
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let lock_url = url.clone();
        let lock_schema = schema.clone();
        let lock = tokio::task::spawn_blocking(move || {
            let mut c = postgres::Client::connect(&lock_url, postgres::NoTls).unwrap();
            c.batch_execute(&format!(
                "BEGIN; LOCK TABLE {lock_schema}.run_records IN ACCESS EXCLUSIVE MODE"
            ))
            .unwrap();
            ready_tx.send(()).unwrap();
            release_rx
                .recv_timeout(std::time::Duration::from_secs(10))
                .unwrap();
            c.batch_execute("ROLLBACK").unwrap();
        });
        ready_rx.await.unwrap();
        let blocked = tokio::spawn(get(&state, run.clone(), Some(token(1424, 0)), "GET"));
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        assert!(participation.ping().await);
        assert_eq!(blocked.await.unwrap().status, 502);
        release_tx.send(()).unwrap();
        lock.await.unwrap();
        assert_eq!(
            get(&state, run.clone(), Some(token(1424, 0)), "GET")
                .await
                .status,
            200
        );
        // Both pools refuse writes.
        for pool in [&run_pool, &auth_pool] {
            let err = pool
                .with(|c| Ok(c.batch_execute("DELETE FROM run_records")?))
                .await
                .unwrap_err();
            assert!(format!("{err:#}").contains("read-only"));
        }
        tokio::task::spawn_blocking(move || {
            drop(state);
            drop(run_pool);
            drop(auth_pool);
            drop(participation);
            let mut c = postgres::Client::connect(&url, postgres::NoTls).unwrap();
            c.batch_execute(&format!("DROP SCHEMA {schema} CASCADE"))
                .unwrap();
        })
        .await
        .unwrap();
    }
    #[cfg(feature = "db-tests")]
    #[tokio::test]
    async fn delphi_result_moderators_get_the_record_others_get_node_refusals_on_independent_pools()
    {
        use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
        use openssl::rsa::Rsa;
        use serde_json::json;
        const CONVERSATION: &str = "local-dynamo-1424";
        const RECORD: &str = include_str!("../conformance/delphi-run-fixtures/second.record.json");

        let url = std::env::var("POLIS_API_TEST_DATABASE_URL").unwrap();
        let schema = format!("delphi_result_test_{}", std::process::id());
        let job: String = serde_json::from_str::<serde_json::Value>(RECORD).unwrap()["job_id"]
            .as_str()
            .unwrap()
            .to_owned();
        let setup_url = url.clone();
        let setup_schema = schema.clone();
        let setup_job = job.clone();
        let artifact = serde_json::from_str::<serde_json::Value>(RECORD).unwrap()["families"]
            .as_array()
            .unwrap()
            .iter()
            .find(|f| f["family"] == "Delphi_CommentHierarchicalClusterAssignments")
            .unwrap()["artifact_id"]
            .as_str()
            .unwrap()
            .to_owned();
        let count = serde_json::from_str::<serde_json::Value>(RECORD).unwrap()["families"]
            .as_array()
            .unwrap()
            .iter()
            .find(|f| f["family"] == "Delphi_CommentHierarchicalClusterAssignments")
            .unwrap()["row_count"]
            .as_u64()
            .unwrap();
        let items=serde_json::to_string(&(0..count).map(|tid| json!({"conversation_id":{"S":"1424"},"comment_id":{"N":tid.to_string()},"layer0_cluster_id":{"N":"0"}})).collect::<Vec<_>>()).unwrap();
        let record = RECORD.trim_end().replace('\'', "''");
        tokio::task::spawn_blocking(move || {
            let mut c = postgres::Client::connect(&setup_url, postgres::NoTls).unwrap();
            c.batch_execute(&format!(
                "CREATE SCHEMA {setup_schema}; SET search_path={setup_schema};
                 CREATE TABLE users(uid integer,site_id text);
                 CREATE TABLE oidc_user_mappings(uid integer,oidc_sub text);
                 CREATE TABLE conversations(zid integer,owner integer,treevite_enabled boolean);
                 CREATE TABLE zinvites(zid integer,zinvite text,created bigint);
                 CREATE TABLE participants(zid integer,uid integer,pid integer);
                 CREATE TABLE run_records(env text,job_id uuid,doc jsonb);
                 INSERT INTO users VALUES(1424,'owner-site'),(100000,'other-site'),(100002,'owner-site');
                 INSERT INTO conversations VALUES(1424,1424,false);
                 INSERT INTO zinvites VALUES(1424,'{CONVERSATION}',2),(1424,'a-later-code',3);
                 INSERT INTO participants VALUES(1424,1424,0),(1424,100000,1),(1424,100002,2);
                 INSERT INTO run_records VALUES('local','{setup_job}','{record}');
                 CREATE FUNCTION pd_run_record(p_env text,p_job uuid) RETURNS jsonb LANGUAGE sql STABLE
                  AS 'SELECT doc FROM {setup_schema}.run_records WHERE env=p_env AND job_id=p_job';
                 CREATE TABLE family_rows(items jsonb); INSERT INTO family_rows VALUES('{items}');
                 CREATE FUNCTION pd_result_artifact_family(p_env text,p_artifact uuid,p_family text) RETURNS jsonb LANGUAGE sql STABLE AS 'SELECT items FROM {setup_schema}.family_rows WHERE p_env=''local'' AND p_artifact=''{artifact}''::uuid AND p_family=''Delphi_CommentHierarchicalClusterAssignments''';"
            ))
            .unwrap();
        })
        .await
        .unwrap();
        let make_pool = |limits: crate::db::Limits| {
            let mut cfg: postgres::Config = url.parse().unwrap();
            cfg.options(&format!("-c search_path={schema}"));
            crate::db::Pool::new(
                polis_queue_adapter::jobs::transport::Connector::Plain(Box::new(cfg)),
                limits,
            )
        };
        let run_pool = make_pool(crate::delphi_result_read::pool_limits());
        let auth_pool = make_pool(crate::delphi_result_read::auth_pool_limits());
        let participation = make_pool(crate::delphi_result_read::auth_pool_limits());
        let rsa = Rsa::generate(2048).unwrap();
        let key = EncodingKey::from_rsa_pem(&rsa.private_key_to_pem().unwrap()).unwrap();
        let verifier = polis_auth::participant::Verifier::new(
            &rsa.public_key_to_pem().unwrap(),
            "participants",
            "participants",
        )
        .unwrap();
        let mut state = app(true);
        {
            let app = Arc::get_mut(&mut state).unwrap();
            app.delphi_result_db = Some(run_pool.clone());
            app.delphi_result_auth_db = Some(auth_pool.clone());
            app.delphi_result_env = "local".into();
            app.participant_verifier = Some(Arc::new(verifier));
            app.next_comment_db = Some(participation.clone());
        }
        let now = (crate::clock::now_ms() / 1000.0) as u64;
        let token = |uid: i32, pid: i32| {
            let claims = json!({"uid":uid,"pid":pid,"sub":format!("anon:{uid}"),"conversation_id":CONVERSATION,
                "iss":"participants","aud":"participants","exp":now+300,"iat":now,"anonymous_participant":true});
            format!(
                "Bearer {}",
                encode(&Header::new(Algorithm::RS256), &claims, &key).unwrap()
            )
        };
        let get = |state: &Arc<App>, target: String, auth: Option<String>, method: &str| {
            let state = state.clone();
            let mut r = match &auth {
                Some(a) => request(method, &[("host", "localhost"), ("authorization", a)]),
                None => request(method, &[("host", "localhost")]),
            };
            r.target = target;
            async move { handle(state, r).await }
        };
        let body = |out: &Outgoing| match &out.body {
            Body::Fixed(b) => String::from_utf8(b.clone()).unwrap(),
            _ => panic!("expected a fixed body"),
        };
        let run = format!("/api/v3/delphi/runs/{job}?families=assignments");
        // The owner (a moderator of their own site's conversation): the record.
        let out = get(&state, run.clone(), Some(token(1424, 0)), "GET").await;
        assert_eq!(out.status, 200);
        let result: serde_json::Value = serde_json::from_str(&body(&out)).unwrap();
        assert_eq!(result["job_id"], job);
        assert_eq!(
            result["outputs"]["assignments"].as_object().unwrap().len(),
            count as usize
        );
        assert_eq!(result["omitted"].as_array().unwrap().len(), 8);
        // Lift the assignments from each ready legacy-recording state and
        // serve them through the authenticated handler. These are fixture
        // function seams; delphi-result-run.sh separately uses release SQL
        // with artifacts published by actual local workers.
        for (name, recording) in [
            (
                "completed",
                include_str!(
                    "../../../server/characterization/delphi/recordings/completed/topicMod-proximity.json"
                ),
            ),
            (
                "two_models",
                include_str!(
                    "../../../server/characterization/delphi/recordings/two_models/topicMod-proximity.json"
                ),
            ),
            (
                "rerun_after_votes",
                include_str!(
                    "../../../server/characterization/delphi/recordings/rerun_after_votes/topicMod-proximity.json"
                ),
            ),
            (
                "zero_vote",
                include_str!(
                    "../../../server/characterization/delphi/recordings/zero_vote/topicMod-proximity.json"
                ),
            ),
            (
                "truncated_narrative",
                include_str!(
                    "../../../server/characterization/delphi/recordings/truncated_narrative/topicMod-proximity.json"
                ),
            ),
        ] {
            let recorded: serde_json::Value = serde_json::from_str(recording).unwrap();
            let payload: serde_json::Value =
                serde_json::from_str(recorded["response"]["body"].as_str().unwrap()).unwrap();
            let rows = payload["proximity_data"].as_array().unwrap();
            let mut expected = serde_json::Map::new();
            let lifted: Vec<_> = rows
                .iter()
                .map(|r| {
                    let tid = r["comment_id"].as_u64().unwrap().to_string();
                    expected.insert(tid.clone(), r["clusters"].clone());
                    let mut item = json!({"conversation_id":{"S":"1424"},"comment_id":{"N":tid}});
                    for (layer, cluster) in r["clusters"].as_object().unwrap() {
                        item[format!("layer{layer}_cluster_id")] = json!({"N":cluster.to_string()});
                    }
                    item
                })
                .collect();
            let mut document: serde_json::Value = serde_json::from_str(RECORD).unwrap();
            document["families"]
                .as_array_mut()
                .unwrap()
                .iter_mut()
                .find(|f| f["family"] == "Delphi_CommentHierarchicalClusterAssignments")
                .unwrap()["row_count"] = json!(rows.len());
            let fixture_url = url.clone();
            let fixture_schema = schema.clone();
            tokio::task::spawn_blocking(move || {
                let mut c = postgres::Client::connect(&fixture_url, postgres::NoTls).unwrap();
                c.execute(
                    &format!("UPDATE {fixture_schema}.run_records SET doc=($1::text)::jsonb"),
                    &[&document.to_string()],
                )
                .unwrap();
                c.execute(
                    &format!("UPDATE {fixture_schema}.family_rows SET items=($1::text)::jsonb"),
                    &[&serde_json::to_string(&lifted).unwrap()],
                )
                .unwrap();
            })
            .await
            .unwrap();
            let answer = get(&state, run.clone(), Some(token(1424, 0)), "GET").await;
            assert_eq!(answer.status, 200, "{name}");
            let envelope: serde_json::Value = serde_json::from_str(&body(&answer)).unwrap();
            assert_eq!(
                envelope["outputs"]["assignments"],
                serde_json::Value::Object(expected),
                "{name}"
            );
            crate::delphi_job_result::DelphiJobResult::from_json(&body(&answer)).unwrap();
        }
        let fixture_url = url.clone();
        let fixture_schema = schema.clone();
        tokio::task::spawn_blocking(move || {
            let mut c=postgres::Client::connect(&fixture_url,postgres::NoTls).unwrap();
            c.execute(&format!("UPDATE {fixture_schema}.run_records SET doc=($1::text)::jsonb"),&[&RECORD]).unwrap();
            let rows:Vec<_>=(0..count).map(|tid|json!({"conversation_id":{"S":"1424"},"comment_id":{"N":tid.to_string()},"layer0_cluster_id":{"N":"0"}})).collect();
            c.execute(&format!("UPDATE {fixture_schema}.family_rows SET items=($1::text)::jsonb"),&[&serde_json::to_string(&rows).unwrap()]).unwrap();
        }).await.unwrap();
        // A moderator of the same site, through their participant token.
        let out = get(&state, run.clone(), Some(token(100002, 2)), "GET").await;
        assert_eq!(out.status, 200);
        // Another site's participant: Node's refusal shape.
        let out = get(&state, run.clone(), Some(token(100000, 1)), "GET").await;
        assert_eq!(out.status, 403);
        assert_eq!(
            body(&out),
            r#"{"status":"error","message":"polis_err_delphi_result_auth"}"#
        );
        // A token naming a pid the participant does not hold builds no identity.
        let out = get(&state, run.clone(), Some(token(100000, 7)), "GET").await;
        assert_eq!(out.status, 502);
        let out = get(&state, run.clone(), None, "GET").await;
        assert_eq!(out.status, 401);
        let out = get(
            &state,
            "/api/v3/delphi/runs/x?families=assignments".into(),
            Some(token(1424, 0)),
            "GET",
        )
        .await;
        assert_eq!(out.status, 404);
        let out = get(
            &state,
            "/api/v3/delphi/runs/00000000-0000-4000-8000-000000000000?families=assignments".into(),
            Some(token(1424, 0)),
            "GET",
        )
        .await;
        assert_eq!(out.status, 404);
        assert_eq!(
            body(&out),
            r#"{"status":"error","message":"Job not found"}"#
        );
        // A configured administrator passes the moderator rule.
        Arc::get_mut(&mut state).unwrap().legacy_admin_uids = vec![100000];
        let out = get(&state, run.clone(), Some(token(100000, 1)), "GET").await;
        assert_eq!(out.status, 200);
        let result: serde_json::Value = serde_json::from_str(&body(&out)).unwrap();
        assert_eq!(result["job_id"], job);
        assert_eq!(
            result["outputs"]["assignments"].as_object().unwrap().len(),
            count as usize
        );
        assert_eq!(result["omitted"].as_array().unwrap().len(), 8);
        // A blocked record read sheds itself within the route's deadline; the
        // participation pool stays usable. Isolation evidence, not a load claim.
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let lock_url = url.clone();
        let lock_schema = schema.clone();
        let lock = tokio::task::spawn_blocking(move || {
            let mut c = postgres::Client::connect(&lock_url, postgres::NoTls).unwrap();
            c.batch_execute(&format!(
                "BEGIN; LOCK TABLE {lock_schema}.run_records IN ACCESS EXCLUSIVE MODE"
            ))
            .unwrap();
            ready_tx.send(()).unwrap();
            release_rx
                .recv_timeout(std::time::Duration::from_secs(10))
                .unwrap();
            c.batch_execute("ROLLBACK").unwrap();
        });
        ready_rx.await.unwrap();
        let blocked = tokio::spawn(get(&state, run.clone(), Some(token(1424, 0)), "GET"));
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        assert!(participation.ping().await);
        assert_eq!(blocked.await.unwrap().status, 502);
        release_tx.send(()).unwrap();
        lock.await.unwrap();
        assert_eq!(
            get(&state, run.clone(), Some(token(1424, 0)), "GET")
                .await
                .status,
            200
        );
        // Both pools refuse writes.
        for pool in [&run_pool, &auth_pool] {
            let err = pool
                .with(|c| Ok(c.batch_execute("DELETE FROM run_records")?))
                .await
                .unwrap_err();
            assert!(format!("{err:#}").contains("read-only"));
        }
        tokio::task::spawn_blocking(move || {
            drop(state);
            drop(run_pool);
            drop(auth_pool);
            drop(participation);
            let mut c = postgres::Client::connect(&url, postgres::NoTls).unwrap();
            c.batch_execute(&format!("DROP SCHEMA {schema} CASCADE"))
                .unwrap();
        })
        .await
        .unwrap();
    }
    #[tokio::test]
    async fn delphi_result_defaults_off_and_rejects_unsupported_selectors_and_paths() {
        let mut state = app(true);
        let target =
            "/api/v3/delphi/runs/00000000-0000-4000-8000-000000000001?families=assignments";
        let req = |target: &str| {
            let mut r = request("GET", &[("host", "localhost")]);
            r.target = target.into();
            r
        };
        assert_eq!(handle(state.clone(), req(target)).await.status, 502);
        let pool = state.db.clone();
        {
            let a = Arc::get_mut(&mut state).unwrap();
            a.delphi_result_db = Some(pool.clone());
            a.delphi_result_auth_db = Some(pool);
        }
        assert_eq!(handle(state.clone(), req(target)).await.status, 401);
        for target in [
            target.replace("?families=assignments", ""),
            target.replace("assignments", "narratives"),
            format!("{target}&families=assignments"),
            target.replace("families=", "families[]="),
            format!("{target}&job_id=x"),
            target.replace("?families", "/nested?families"),
        ] {
            assert_eq!(
                handle(state.clone(), req(&target)).await.status,
                502,
                "{target}"
            );
        }
        for method in ["POST", "OPTIONS", "DELETE"] {
            let mut r = req(target);
            r.method = method.into();
            assert_eq!(handle(state.clone(), r).await.status, 502);
        }
        let mut r = req(target);
        r.body = b"{}".to_vec();
        assert_eq!(handle(state.clone(), r).await.status, 502);
        assert_eq!(state.delphi_result_served.load(Ordering::Relaxed), 1);
        assert_eq!(state.delphi_result_fallback.load(Ordering::Relaxed), 11);
    }
}
