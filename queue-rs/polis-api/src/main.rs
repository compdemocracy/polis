//! `polis-api`: one Rust process serving `GET /api/v3/math/pca2` with the
//! bytes, headers and statuses the Node server produces for it. Everything
//! else stays on Node; nginx sends this one path here only when
//! `RUST_API_ROUTES` names it (see README).
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]

mod about;
mod admin_page;
mod all_conversations;
mod bid_to_pid;
mod clock;
mod collective_statement;
mod comments;
mod compress;
mod config;
mod connection;
mod contexts;
mod conversation_pages;
mod conversation_preload;
mod conversation_stats;
mod cors;
mod create_page;
mod database;
mod db;
mod perf_stats;
mod version;
// The Delphi run-record contract (delphi-run/1) and the modules it is built
// on, compiled from the contracts crate as the route contracts are. The
// run-record route uses only part of them. rustfmt leaves them to their own
// crate's (2021) style.
#[allow(dead_code)]
#[rustfmt::skip]
#[path = "../../polis-contracts/src/delphi_job_result.rs"]
mod delphi_job_result;
#[allow(dead_code)]
#[rustfmt::skip]
#[path = "../../polis-contracts/src/delphi_run.rs"]
mod delphi_run;
mod delphi_logs;
mod delphi_narratives;
mod delphi_read;
mod delphi_reports;
mod delphi_result_read;
mod delphi_run_read;
mod delphi_topics;
mod delphi_visualizations;
mod domain_whitelist;
mod einvites_read;
mod http;
mod hybrid_read;
mod identity_observability;
mod integrate_page;
mod js;
mod legacy_conversations;
mod legacy_pca;
mod link_pages;
mod lru;
mod metadata_answers;
#[allow(dead_code)]
#[rustfmt::skip]
#[path = "../../polis-contracts/src/votes.rs"]
mod votes;
mod math_bundle;
mod math_membership;
mod metadata_choices;
mod metadata_query;
mod metadata_questions;
mod metadata_read;
mod my_invites_csv;
mod negotiate;
mod next_comment;
mod ops_catchall;
mod ops_page;
mod ops_whoami;
mod other_conversations_page;
mod owner;
mod params;
mod participants_read;
mod participation_read;
mod pca;
mod post_votes;
#[allow(dead_code)]
#[rustfmt::skip]
#[path = "../../polis-contracts/src/auth_envelope.rs"]
mod auth_envelope;
#[allow(dead_code, clippy::collapsible_if)]
#[rustfmt::skip]
#[path = "../../polis-contracts/src/post_votes.rs"]
mod post_votes_contract;
mod ptptois;
mod recent_activity;
mod recent_started;
mod report_export;
mod reports_read;
mod robots;
mod route;
mod votes_read;
#[allow(dead_code)]
#[rustfmt::skip]
#[path = "../../polis-contracts/src/schema.rs"]
mod schema;
mod revocation;
mod settings_page;
mod statement_importance;
mod topic_prioritize;
mod topic_selection_writes;
mod topic_selections;
mod topic_stats;
mod treevite_codes;
mod treevite_csv;
mod treevite_invites;
mod treevite_me;
mod treevite_my_invites;
mod treevite_read;
mod treevite_waves;
mod user_create_page;
mod user_login_page;
mod user_logout_page;
#[allow(dead_code)]
#[rustfmt::skip]
#[path = "../../polis-contracts/src/wire.rs"]
mod wire;
mod xid_report;

use anyhow::{Context, Result};
use http::{Body, Outgoing, Request};
use std::sync::{Arc, atomic::Ordering};

/// Not a Node route: liveness for the container and the operator.
async fn health(app: &route::App) -> Outgoing {
    health_observed(app, &polis_auth::observability::PROCESS).await
}

async fn health_observed(
    app: &route::App,
    counters: &polis_auth::observability::Counters,
) -> Outgoing {
    let reachable = app.db.ping().await;
    health_response(
        app,
        counters,
        reachable,
        std::env::var("RUST_API_ROUTES").unwrap_or_default(),
        std::env::vars(),
    )
}

fn health_response(
    app: &route::App,
    counters: &polis_auth::observability::Counters,
    reachable: bool,
    configured_routes: String,
    environment: impl Iterator<Item = (String, String)>,
) -> Outgoing {
    let mut body = js::Obj::new();
    body.set("version", js::Js::Str(env!("POLIS_VERSION").into()));
    body.set("commit", js::Js::Str(env!("GIT_HASH").into()));
    let mut pools = js::Obj::new();
    pools.set("common", app.db.health(reachable));
    body.set("pools", js::Js::Obj(pools));
    let mut routing = js::Obj::new();
    routing.set("configuredRoutes", js::Js::Str(configured_routes));
    // These are explicit process switches, not the effective nginx map. The
    // deploy's health check compares configured routes with nginx's environment.
    let mut switches: Vec<_> = environment
        .filter_map(|(key, value)| {
            (key.starts_with("POLIS_API_")
                && value == "1"
                && (key.ends_with("_READS")
                    || key.ends_with("_WRITES")
                    || key == "POLIS_API_OWNER_LIST"
                    || key == "POLIS_API_POST_VOTES"))
                .then_some(js::Js::Str(key))
        })
        .collect();
    switches.sort_by_key(js::stringify);
    routing.set("enabledSwitches", js::Js::Arr(switches));
    body.set("routing", js::Js::Obj(routing));
    body.set("identity", identity_observability::snapshot(counters));
    body.set("postVotes", post_votes::health(app));
    body.set("treeviteRevocations", revocation::health(app));
    body.set(
        "treeviteCodeWrites",
        js::Js::Bool(app.treevite_codes.is_some()),
    );
    body.set(
        "participantKeysLoaded",
        js::Js::Bool(app.participant_keys.is_some()),
    );
    body.set(
        "participantPublicKeyFingerprint",
        app.participant_keys
            .as_ref()
            .map(|keys| js::Js::Str(keys.fingerprint().into()))
            .unwrap_or(js::Js::Null),
    );
    for (i, name) in [
        "conversationPage",
        "explorePage",
        "sharePage",
        "summaryPage",
        "oneTimePage",
    ]
    .into_iter()
    .enumerate()
    {
        body.set(
            &format!("{name}Served"),
            js::Js::Num(app.conversation_page_served[i].load(Ordering::Relaxed) as f64),
        );
        body.set(
            &format!("{name}Fallback"),
            js::Js::Num(app.conversation_page_fallback[i].load(Ordering::Relaxed) as f64),
        );
    }
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
        "reportExportServed",
        js::Js::Num(app.report_export_served.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "reportExportFallback",
        js::Js::Num(app.report_export_fallback.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "perfStatsServed",
        js::Js::Num(app.perf_stats_served.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "perfStatsFallback",
        js::Js::Num(app.perf_stats_fallback.load(Ordering::Relaxed) as f64),
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
        "opsCatchallServed",
        js::Js::Num(app.ops_catchall_served.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "opsCatchallFallback",
        js::Js::Num(app.ops_catchall_fallback.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "opsPageServed",
        js::Js::Num(app.ops_page_served.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "opsPageFallback",
        js::Js::Num(app.ops_page_fallback.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "opsWhoamiServed",
        js::Js::Num(app.ops_whoami_served.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "opsWhoamiFallback",
        js::Js::Num(app.ops_whoami_fallback.load(Ordering::Relaxed) as f64),
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
        "delphiReportsServed",
        js::Js::Num(app.delphi_reports_served.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "delphiReportsFallback",
        js::Js::Num(app.delphi_reports_fallback.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "delphiVisualizationsServed",
        js::Js::Num(app.delphi_visualizations_served.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "delphiVisualizationsFallback",
        js::Js::Num(app.delphi_visualizations_fallback.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "topicStatsServed",
        js::Js::Num(app.topic_stats_served.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "topicStatsFallback",
        js::Js::Num(app.topic_stats_fallback.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "delphiLogsServed",
        js::Js::Num(app.delphi_logs_served.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "delphiLogsFallback",
        js::Js::Num(app.delphi_logs_fallback.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "delphiRunServed",
        js::Js::Num(app.delphi_run_served.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "delphiRunFallback",
        js::Js::Num(app.delphi_run_fallback.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "delphiResultServed",
        js::Js::Num(app.delphi_result_served.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "delphiResultFallback",
        js::Js::Num(app.delphi_result_fallback.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "collectiveStatementServed",
        js::Js::Num(app.collective_statement_served.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "collectiveStatementFallback",
        js::Js::Num(app.collective_statement_fallback.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "delphiReadServed",
        js::Js::Num(app.delphi_read_served.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "delphiReadFallback",
        js::Js::Num(app.delphi_read_fallback.load(Ordering::Relaxed) as f64),
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
    for (name, counter) in [
        ("iipServed", &app.iip_served),
        ("iipFallback", &app.iip_fallback),
        ("iimServed", &app.iim_served),
        ("iimFallback", &app.iim_fallback),
    ] {
        body.set(name, js::Js::Num(counter.load(Ordering::Relaxed) as f64));
    }
    body.set(
        "participantsReadServed",
        js::Js::Num(app.participants_read_served.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "participantsReadFallback",
        js::Js::Num(app.participants_read_fallback.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "ptptoisServed",
        js::Js::Num(app.ptptois_served.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "ptptoisFallback",
        js::Js::Num(app.ptptois_fallback.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "myInvitesCsvServed",
        js::Js::Num(app.my_invites_csv_served.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "myInvitesCsvFallback",
        js::Js::Num(app.my_invites_csv_fallback.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "bidServed",
        js::Js::Num(app.bid_served.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "bidFallback",
        js::Js::Num(app.bid_fallback.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "locationsServed",
        js::Js::Num(app.locations_served.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "locationsFallback",
        js::Js::Num(app.locations_fallback.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "votesReadServed",
        js::Js::Num(app.votes_read_served.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "votesReadFallback",
        js::Js::Num(app.votes_read_fallback.load(Ordering::Relaxed) as f64),
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
        "metadataQueryServed",
        js::Js::Num(app.metadata_query_served.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "metadataQueryFallback",
        js::Js::Num(app.metadata_query_fallback.load(Ordering::Relaxed) as f64),
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
    body.set(
        "treeviteInvitesServed",
        js::Js::Num(app.treevite_invites_served.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "treeviteInvitesFallback",
        js::Js::Num(app.treevite_invites_fallback.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "treeviteCsvServed",
        js::Js::Num(app.treevite_csv_served.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "treeviteCsvFallback",
        js::Js::Num(app.treevite_csv_fallback.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "conversationPreloadServed",
        js::Js::Num(app.conversation_preload_served.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "conversationPreloadFallback",
        js::Js::Num(app.conversation_preload_fallback.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "participationReadServed",
        js::Js::Num(app.participation_read_served.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "participationReadFallback",
        js::Js::Num(app.participation_read_fallback.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "allConversationsServed",
        js::Js::Num(app.all_conversations_served.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "allConversationsFallback",
        js::Js::Num(app.all_conversations_fallback.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "reportsReadServed",
        js::Js::Num(app.reports_read_served.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "reportsReadFallback",
        js::Js::Num(app.reports_read_fallback.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "bidToPidServed",
        js::Js::Num(app.bid_to_pid_served.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "bidToPidFallback",
        js::Js::Num(app.bid_to_pid_fallback.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "conversationStatsServed",
        js::Js::Num(app.conversation_stats_served.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "conversationStatsFallback",
        js::Js::Num(app.conversation_stats_fallback.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "statementImportanceServed",
        js::Js::Num(app.statement_importance_served.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "statementImportanceFallback",
        js::Js::Num(app.statement_importance_fallback.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "topicSelectionsServed",
        js::Js::Num(app.topic_selections_served.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "topicSelectionsFallback",
        js::Js::Num(app.topic_selections_fallback.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "treeviteMyInvitesServed",
        js::Js::Num(app.treevite_my_invites_served.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "treeviteMyInvitesFallback",
        js::Js::Num(app.treevite_my_invites_fallback.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "topicPrioritizeServed",
        js::Js::Num(app.topic_prioritize_served.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "topicPrioritizeFallback",
        js::Js::Num(app.topic_prioritize_fallback.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "legacyConversationsServed",
        js::Js::Num(app.legacy_conversations_served.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "legacyConversationsFallback",
        js::Js::Num(app.legacy_conversations_fallback.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "treeviteMeServed",
        js::Js::Num(app.treevite_me_served.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "treeviteMeFallback",
        js::Js::Num(app.treevite_me_fallback.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "xidReportServed",
        js::Js::Num(app.xid_report_served.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "xidReportFallback",
        js::Js::Num(app.xid_report_fallback.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "einvitesReadServed",
        js::Js::Num(app.einvites_read_served.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "einvitesReadFallback",
        js::Js::Num(app.einvites_read_fallback.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "settingsPageServed",
        js::Js::Num(app.settings_page_served.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "settingsPageFallback",
        js::Js::Num(app.settings_page_fallback.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "otherConversationsPageServed",
        js::Js::Num(app.other_conversations_page_served.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "otherConversationsPageFallback",
        js::Js::Num(
            app.other_conversations_page_fallback
                .load(Ordering::Relaxed) as f64,
        ),
    );
    body.set(
        "integratePageServed",
        js::Js::Num(app.integrate_page_served.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "integratePageFallback",
        js::Js::Num(app.integrate_page_fallback.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "adminPageServed",
        js::Js::Num(app.admin_page_served.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "adminPageFallback",
        js::Js::Num(app.admin_page_fallback.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "userLogoutPageServed",
        js::Js::Num(app.user_logout_page_served.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "userLogoutPageFallback",
        js::Js::Num(app.user_logout_page_fallback.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "userLoginPageServed",
        js::Js::Num(app.user_login_page_served.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "userLoginPageFallback",
        js::Js::Num(app.user_login_page_fallback.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "userCreatePageServed",
        js::Js::Num(app.user_create_page_served.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "userCreatePageFallback",
        js::Js::Num(app.user_create_page_fallback.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "createPageServed",
        js::Js::Num(app.create_page_served.load(Ordering::Relaxed) as f64),
    );
    body.set(
        "createPageFallback",
        js::Js::Num(app.create_page_fallback.load(Ordering::Relaxed) as f64),
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
    #[cfg(feature = "fixture-clock")]
    {
        let fixture_clock = req.headers.get("x-polis-fixture-clock").map(str::to_owned);
        clock::for_request(fixture_clock.as_deref(), dispatch_at_clock(app, owner, req)).await
    }
    #[cfg(not(feature = "fixture-clock"))]
    dispatch_at_clock(app, owner, req).await
}

async fn dispatch_at_clock(
    app: Arc<route::App>,
    owner: Option<Arc<owner::App>>,
    req: Request,
) -> Outgoing {
    match req.path() {
        owner::PATH => match owner {
            Some(owner) => owner.handle(req).await,
            None => owner::error(503, "owner_list_unavailable"),
        },
        route::PATH
        | comments::PATH
        | next_comment::PATH
        | version::PATH
        | connection::PATH
        | perf_stats::PATH
        | robots::PATH
        | about::PATH
        | ops_whoami::PATH
        | legacy_pca::PATH
        | delphi_read::PATH
        | collective_statement::PATH
        | topic_stats::PATH
        | delphi_logs::PATH
        | delphi_run_read::PATH
        | delphi_visualizations::PATH
        | delphi_reports::PATH
        | database::PATH
        | contexts::PATH
        | conversation_preload::PATH
        | domain_whitelist::PATH
        | metadata_questions::PATH
        | treevite_codes::REVOKE_PATH
        | treevite_codes::REISSUE_PATH
        | treevite_waves::PATH
        | math_membership::BID_PATH
        | math_membership::LOCATIONS_PATH
        | participants_read::PATH
        | ptptois::PATH
        | my_invites_csv::PATH
        | participation_read::PATH
        | treevite_csv::PATH
        | treevite_invites::PATH
        | metadata_choices::PATH
        | recent_started::PATH
        | treevite_me::PATH
        | treevite_my_invites::PATH
        | legacy_conversations::PATH
        | einvites_read::PATH
        | topic_prioritize::PATH
        | statement_importance::PATH
        | topic_selections::PATH
        | conversation_stats::PATH
        | bid_to_pid::PATH
        | reports_read::PATH
        | all_conversations::PATH
        | recent_activity::PATH
        | metadata_read::PATH
        | metadata_query::PATH
        | votes_read::PATH
        | votes_read::ME_PATH
        | metadata_answers::PATH => route::handle(app, req).await,
        path if conversation_pages::matches(path) => route::handle(app, req).await,
        path if link_pages::matches(path) => route::handle(app, req).await,
        path if delphi_result_read::matches(path) => route::handle(app, req).await,
        path if ops_page::matches(path) => route::handle(app, req).await,
        path if ops_catchall::matches(path) => route::handle(app, req).await,
        path if settings_page::matches(path) => route::handle(app, req).await,
        path if other_conversations_page::matches(path) => route::handle(app, req).await,
        path if integrate_page::matches(path) => route::handle(app, req).await,
        path if admin_page::matches(path) => route::handle(app, req).await,
        path if user_logout_page::matches(path) => route::handle(app, req).await,
        path if user_login_page::matches(path) => route::handle(app, req).await,
        path if user_create_page::matches(path) => route::handle(app, req).await,
        path if create_page::matches(path) => route::handle(app, req).await,
        path if report_export::matches(path) => route::handle(app, req).await,
        path if xid_report::matches(path) => route::handle(app, req).await,
        "/health" if req.method == "GET" => health(&app).await,
        // Not a path this process serves: nginx gives the request to Node.
        _ => route::bad_gateway(),
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    // The participant signing keys are required whenever a route that verifies
    // participant tokens is selected; otherwise their absence is reported on
    // the health document rather than refusing to boot (a box that routes
    // nothing to this service must still start it).
    let participant_reads =
        std::env::var("POLIS_API_PARTICIPANT_READS").ok().as_deref() == Some("1");
    let participant_keys = if participant_reads {
        Some(polis_auth::keys::Keys::from_env()?)
    } else {
        polis_auth::keys::Keys::from_env_optional()?
    };
    if participant_keys.is_none() {
        eprintln!(
            "participant signing keys not configured (JWT_PRIVATE_KEY or JWT_PRIVATE_KEY_PATH, JWT_PUBLIC_KEY or JWT_PUBLIC_KEY_PATH); participant token routes cannot be selected"
        );
    }
    let cfg = config::Config::from_env()?;
    let connector = config::db_connector()?;
    let pool = db::Pool::new(connector, cfg.pool.clone());
    let mut state = route::App::new(&cfg, pool);
    state.participant_keys = participant_keys;
    for (i, switch) in [
        "POLIS_API_CONVERSATION_PAGE_READS",
        "POLIS_API_EXPLORE_PAGE_READS",
        "POLIS_API_SHARE_PAGE_READS",
        "POLIS_API_SUMMARY_PAGE_READS",
        "POLIS_API_ONE_TIME_PAGE_READS",
    ]
    .into_iter()
    .enumerate()
    {
        if std::env::var(switch).ok().as_deref() == Some("1") {
            let dsn = std::env::var("POLIS_API_CONVERSATION_PAGES_DATABASE_URL")
                .context("POLIS_API_CONVERSATION_PAGES_DATABASE_URL required")?;
            let read_dsn = std::env::var("READ_ONLY_DATABASE_URL")
                .ok()
                .filter(|s| !s.is_empty())
                .unwrap_or(dsn);
            state.conversation_page_dbs[i] = Some(db::Pool::new(
                config::connector_for_dsn(&read_dsn, "polis-api-conversation-page/1")?,
                conversation_pages::pool_limits(),
            ));
            state.conversation_pages[i] = conversation_pages::Client::from_env_for(switch).await?;
        }
    }
    state.post_votes = post_votes::Writer::from_env()?;
    if std::env::var("POLIS_API_COMMENT_READS").ok().as_deref() == Some("1") {
        state.read_oidc = hybrid_read::Oidc::from_env()?;
        let admins = std::env::var("ADMIN_UIDS")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "[]".into());
        state.legacy_admin_uids = recent_started::admin_uids(&admins)?;
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
    state.topic_selection_writer = topic_selection_writes::Writer::from_env()?;
    if std::env::var("POLIS_API_PARTICIPANT_READS").ok().as_deref() == Some("1") {
        state.participant_verifier = Some(Arc::new(
            state
                .participant_keys
                .as_ref()
                .context("participant keys required")?
                .verifier(
                    &std::env::var("POLIS_JWT_ISSUER")?,
                    &std::env::var("POLIS_JWT_AUDIENCE")?,
                )
                .context("POLIS_JWT_ISSUER and POLIS_JWT_AUDIENCE must not be empty")?,
        ));
    }

    state.perf_stats_reads =
        std::env::var("POLIS_API_PERF_STATS_READS").ok().as_deref() == Some("1");
    if std::env::var("POLIS_API_REPORT_EXPORT_READS")
        .ok()
        .as_deref()
        == Some("1")
    {
        let dsn = std::env::var("POLIS_API_REPORT_EXPORT_DATABASE_URL")
            .context("POLIS_API_REPORT_EXPORT_DATABASE_URL required")?;
        let read_dsn = std::env::var("READ_ONLY_DATABASE_URL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| dsn.clone());
        state.report_export_db = Some(db::Pool::new(
            config::connector_for_dsn(&dsn, "polis-api-report-export/1")?,
            report_export::pool_limits(),
        ));
        state.report_export_lookup_db = Some(db::Pool::new(
            config::connector_for_dsn(&read_dsn, "polis-api-report-export-lookup/1")?,
            report_export::pool_limits(),
        ));
        state.report_export_utc = std::env::var("TZ").ok().as_deref() == Some("UTC");
    }
    version::initialize();
    state.version_reads = std::env::var("POLIS_API_VERSION_READS").ok().as_deref() == Some("1");
    state.connection_reads =
        std::env::var("POLIS_API_CONNECTION_READS").ok().as_deref() == Some("1");
    state.robots_reads = std::env::var("POLIS_API_ROBOTS_READS").ok().as_deref() == Some("1");
    state.settings_page_reads = std::env::var("POLIS_API_SETTINGS_PAGE_READS")
        .ok()
        .as_deref()
        == Some("1");
    state.user_logout_page_reads = std::env::var("POLIS_API_USER_LOGOUT_PAGE_READS")
        .ok()
        .as_deref()
        == Some("1");
    state.user_login_page_reads = std::env::var("POLIS_API_USER_LOGIN_PAGE_READS")
        .ok()
        .as_deref()
        == Some("1");
    state.user_create_page_reads = std::env::var("POLIS_API_USER_CREATE_PAGE_READS")
        .ok()
        .as_deref()
        == Some("1");
    state.create_page_reads =
        std::env::var("POLIS_API_CREATE_PAGE_READS").ok().as_deref() == Some("1");
    state.about_reads = std::env::var("POLIS_API_ABOUT_READS").ok().as_deref() == Some("1");
    state.ops_whoami_reads = ops_whoami::configured(
        std::env::var("POLIS_API_OPS_WHOAMI_READS").ok().as_deref(),
        std::env::var("OPS_ENABLED").ok().as_deref(),
    );

    state.ops_page_reads = ops_page::configured(
        std::env::var("POLIS_API_OPS_PAGE_READS").ok().as_deref(),
        std::env::var("OPS_ENABLED").ok().as_deref(),
    );

    state.ops_catchall_reads = ops_catchall::configured(
        std::env::var("POLIS_API_OPS_CATCHALL_READS")
            .ok()
            .as_deref(),
        std::env::var("OPS_ENABLED").ok().as_deref(),
    );
    if std::env::var("POLIS_API_DELPHI_REPORTS_READS")
        .ok()
        .as_deref()
        == Some("1")
    {
        let dsn = std::env::var("POLIS_API_DELPHI_REPORTS_DATABASE_URL").context(
            "POLIS_API_DELPHI_REPORTS_DATABASE_URL is required for Delphi narrative report validation reads",
        )?;
        state.delphi_reports_db = Some(db::Pool::new(
            config::connector_for_dsn(&dsn, "polis-api-delphi-reports/1")?,
            delphi_reports::pool_limits(),
        ));
        if std::env::var("DELPHI_RESULT_BACKEND").ok().as_deref() == Some("postgres") {
            let dsn = std::env::var("POLIS_API_DELPHI_NARRATIVES_DATABASE_URL").context(
                "POLIS_API_DELPHI_NARRATIVES_DATABASE_URL required for PostgreSQL narrative reads",
            )?;
            state.delphi_narratives_env =
                std::env::var("DELPHI_RESULT_ENV").context("DELPHI_RESULT_ENV required")?;
            anyhow::ensure!(
                !state.delphi_narratives_env.is_empty(),
                "DELPHI_RESULT_ENV cannot be empty"
            );
            state.delphi_narratives_scope = std::env::var("DELPHI_RESULT_SCOPE")
                .ok()
                .filter(|s| !s.is_empty());
            state.delphi_narratives_db = Some(db::Pool::new(
                config::connector_for_dsn(&dsn, "polis-api-delphi-narratives/1")?,
                delphi_narratives::pool_limits(),
            ));
        }
    }
    if std::env::var("POLIS_API_DELPHI_VISUALIZATIONS_READS")
        .ok()
        .as_deref()
        == Some("1")
    {
        let dsn = std::env::var("POLIS_API_DELPHI_VISUALIZATIONS_DATABASE_URL").context(
            "POLIS_API_DELPHI_VISUALIZATIONS_DATABASE_URL is required for Delphi visualization validation reads",
        )?;
        state.delphi_visualizations_db = Some(db::Pool::new(
            config::connector_for_dsn(&dsn, "polis-api-delphi-visualizations/1")?,
            delphi_visualizations::pool_limits(),
        ));
        if std::env::var("DELPHI_RESULT_BACKEND").ok().as_deref() == Some("postgres") {
            state.delphi_visualizations_env = std::env::var("DELPHI_RESULT_ENV")
                .ok()
                .filter(|s| !s.is_empty())
                .context("DELPHI_RESULT_ENV is required for visualization jobs")?;
            state.delphi_visualizations_scope = std::env::var("DELPHI_RESULT_SCOPE")
                .ok()
                .filter(|s| !s.is_empty());
            let results = std::env::var("POLIS_API_DELPHI_VISUALIZATIONS_RESULTS_DATABASE_URL")
                .context("a primary result database is required for visualization jobs")?;
            state.delphi_visualizations_result_db = Some(db::Pool::new(
                config::connector_for_dsn(&results, "polis-api-delphi-visualizations-results/1")?,
                delphi_visualizations::result_pool_limits(),
            ));
        }
    }
    if std::env::var("POLIS_API_TOPIC_STATS_READS").ok().as_deref() == Some("1") {
        let dsn = std::env::var("POLIS_API_TOPIC_STATS_DATABASE_URL").context(
            "POLIS_API_TOPIC_STATS_DATABASE_URL is required for Topic statistics validation reads",
        )?;
        state.topic_stats_db = Some(db::Pool::new(
            config::connector_for_dsn(&dsn, "polis-api-topic-stats/1")?,
            topic_stats::pool_limits(),
        ));
    }
    if std::env::var("POLIS_API_DELPHI_LOGS_READS").ok().as_deref() == Some("1") {
        anyhow::ensure!(
            std::env::var("DELPHI_RESULT_BACKEND").ok().as_deref() == Some("postgres"),
            "Delphi logs require the Postgres result backend"
        );
        state.delphi_logs_scope = std::env::var("DELPHI_RESULT_SCOPE")
            .ok()
            .filter(|s| !s.is_empty());
        // The record function's login: a member of polis_queue_executor.
        let dsn = std::env::var("POLIS_API_DELPHI_LOGS_DATABASE_URL")
            .context("POLIS_API_DELPHI_LOGS_DATABASE_URL is required for Delphi log reads")?;
        // Identity and the moderator rule read Node's tables with Node's read
        // login unless a dedicated one is given.
        let auth_dsn = [
            "POLIS_API_DELPHI_LOGS_AUTH_DATABASE_URL",
            "READ_ONLY_DATABASE_URL",
        ]
        .iter()
        .find_map(|k| std::env::var(k).ok().filter(|s| !s.is_empty()))
        .or_else(|| std::env::var("DATABASE_URL").ok())
        .context("a database for Delphi log identity reads is required")?;
        state.delphi_logs_env = std::env::var("DELPHI_RESULT_ENV")
            .ok()
            .filter(|s| !s.is_empty())
            .context("DELPHI_RESULT_ENV is required for Delphi log reads")?;
        state.delphi_logs_db = Some(db::Pool::new(
            config::connector_for_dsn(&dsn, "polis-api-delphi-logs/1")?,
            delphi_logs::pool_limits(),
        ));
        state.delphi_logs_auth_db = Some(db::Pool::new(
            config::connector_for_dsn(&auth_dsn, "polis-api-delphi-logs-auth/1")?,
            delphi_logs::auth_pool_limits(),
        ));
        state.read_oidc = hybrid_read::Oidc::from_env()?;
        let admins = std::env::var("ADMIN_UIDS")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "[]".into());
        state.legacy_admin_uids = recent_started::admin_uids(&admins)?;
    }
    if std::env::var("POLIS_API_DELPHI_RUN_READS").ok().as_deref() == Some("1") {
        // The record function's login: a member of polis_queue_executor.
        let dsn = std::env::var("POLIS_API_DELPHI_RUN_DATABASE_URL")
            .context("POLIS_API_DELPHI_RUN_DATABASE_URL is required for Delphi run-record reads")?;
        // Identity and the moderator rule read Node's tables with Node's read
        // login unless a dedicated one is given.
        let auth_dsn = [
            "POLIS_API_DELPHI_RUN_AUTH_DATABASE_URL",
            "READ_ONLY_DATABASE_URL",
        ]
        .iter()
        .find_map(|k| std::env::var(k).ok().filter(|s| !s.is_empty()))
        .or_else(|| std::env::var("DATABASE_URL").ok())
        .context("a database for Delphi run-record identity reads is required")?;
        state.delphi_run_env = std::env::var("DELPHI_RESULT_ENV")
            .ok()
            .filter(|s| !s.is_empty())
            .context("DELPHI_RESULT_ENV is required for Delphi run-record reads")?;
        state.delphi_run_db = Some(db::Pool::new(
            config::connector_for_dsn(&dsn, "polis-api-delphi-run/1")?,
            delphi_run_read::pool_limits(),
        ));
        state.delphi_run_auth_db = Some(db::Pool::new(
            config::connector_for_dsn(&auth_dsn, "polis-api-delphi-run-auth/1")?,
            delphi_run_read::auth_pool_limits(),
        ));
        state.read_oidc = hybrid_read::Oidc::from_env()?;
        let admins = std::env::var("ADMIN_UIDS")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "[]".into());
        state.legacy_admin_uids = recent_started::admin_uids(&admins)?;
    }
    if std::env::var("POLIS_API_DELPHI_RESULT_READS")
        .ok()
        .as_deref()
        == Some("1")
    {
        // The record function's login: a member of polis_queue_executor.
        let dsn = std::env::var("POLIS_API_DELPHI_RESULT_DATABASE_URL")
            .context("POLIS_API_DELPHI_RESULT_DATABASE_URL is required for Delphi result reads")?;
        // Identity and the moderator rule read Node's tables with Node's read
        // login unless a dedicated one is given.
        let auth_dsn = [
            "POLIS_API_DELPHI_RESULT_AUTH_DATABASE_URL",
            "READ_ONLY_DATABASE_URL",
        ]
        .iter()
        .find_map(|k| std::env::var(k).ok().filter(|s| !s.is_empty()))
        .or_else(|| std::env::var("DATABASE_URL").ok())
        .context("a database for Delphi result identity reads is required")?;
        state.delphi_result_env = std::env::var("DELPHI_RESULT_ENV")
            .ok()
            .filter(|s| !s.is_empty())
            .context("DELPHI_RESULT_ENV is required for Delphi result reads")?;
        state.delphi_result_db = Some(db::Pool::new(
            config::connector_for_dsn(&dsn, "polis-api-delphi-result/1")?,
            delphi_result_read::pool_limits(),
        ));
        state.delphi_result_auth_db = Some(db::Pool::new(
            config::connector_for_dsn(&auth_dsn, "polis-api-delphi-result-auth/1")?,
            delphi_result_read::auth_pool_limits(),
        ));
        state.read_oidc = hybrid_read::Oidc::from_env()?;
        let admins = std::env::var("ADMIN_UIDS")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "[]".into());
        state.legacy_admin_uids = recent_started::admin_uids(&admins)?;
    }
    if std::env::var("POLIS_API_COLLECTIVE_STATEMENT_READS")
        .ok()
        .as_deref()
        == Some("1")
    {
        let dsn = std::env::var("POLIS_API_COLLECTIVE_STATEMENT_DATABASE_URL").context(
            "POLIS_API_COLLECTIVE_STATEMENT_DATABASE_URL is required for Collective statement validation reads",
        )?;
        state.collective_statement_db = Some(db::Pool::new(
            config::connector_for_dsn(&dsn, "polis-api-collective-statement/1")?,
            collective_statement::pool_limits(),
        ));
    }
    if std::env::var("POLIS_API_DELPHI_READS").ok().as_deref() == Some("1") {
        let dsn = std::env::var("POLIS_API_DELPHI_DATABASE_URL").context(
            "POLIS_API_DELPHI_DATABASE_URL is required for Delphi report validation reads",
        )?;
        state.delphi_read_db = Some(db::Pool::new(
            config::connector_for_dsn(&dsn, "polis-api-delphi-read/1")?,
            delphi_read::pool_limits(),
        ));
        if std::env::var("DELPHI_RESULT_BACKEND").ok().as_deref() == Some("postgres") {
            let dsn = std::env::var("POLIS_API_DELPHI_TOPICS_DATABASE_URL")
                .context("POLIS_API_DELPHI_TOPICS_DATABASE_URL required for PostgreSQL topics")?;
            state.delphi_topics_env = std::env::var("DELPHI_RESULT_ENV")
                .context("DELPHI_RESULT_ENV required for PostgreSQL topics")?;
            anyhow::ensure!(
                !state.delphi_topics_env.is_empty(),
                "DELPHI_RESULT_ENV cannot be empty"
            );
            state.delphi_topics_scope = std::env::var("DELPHI_RESULT_SCOPE")
                .ok()
                .filter(|s| !s.is_empty());
            state.delphi_topics_db = Some(db::Pool::new(
                config::connector_for_dsn(&dsn, "polis-api-delphi-topics/1")?,
                delphi_topics::pool_limits(),
            ));
        }
    }
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
    for (switch, slot, name) in [
        ("POLIS_API_IIP_READS", &mut state.iip_db, "polis-api-iip/1"),
        ("POLIS_API_IIM_READS", &mut state.iim_db, "polis-api-iim/1"),
    ] {
        if std::env::var(switch).ok().as_deref() == Some("1") {
            let dsn = std::env::var("POLIS_API_LINK_PAGES_DATABASE_URL")
                .context("POLIS_API_LINK_PAGES_DATABASE_URL required")?;
            *slot = Some(db::Pool::new(
                config::connector_for_dsn(&dsn, name)?,
                link_pages::pool_limits(),
            ));
        }
    }
    if std::env::var("POLIS_API_PARTICIPANTS_READS")
        .ok()
        .as_deref()
        == Some("1")
    {
        let dsn = std::env::var("POLIS_API_PARTICIPANTS_DATABASE_URL")
            .context("POLIS_API_PARTICIPANTS_DATABASE_URL required")?;
        let read_dsn = std::env::var("READ_ONLY_DATABASE_URL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| dsn.clone());
        state.participants_read_db = Some(db::Pool::new(
            config::connector_for_dsn(&read_dsn, "polis-api-participants/1")?,
            participants_read::pool_limits(),
        ));
        state.participants_read_auth_db = Some(db::Pool::new(
            config::connector_for_dsn(&dsn, "polis-api-participants-auth/1")?,
            participants_read::pool_limits(),
        ));
        state.read_oidc = hybrid_read::Oidc::from_env()?;
    }
    if std::env::var("POLIS_API_PTPTOIS_READS").ok().as_deref() == Some("1") {
        let dsn = std::env::var("POLIS_API_PTPTOIS_DATABASE_URL")
            .context("POLIS_API_PTPTOIS_DATABASE_URL required")?;
        let read_dsn = std::env::var("READ_ONLY_DATABASE_URL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| dsn.clone());
        state.ptptois_db = Some(db::Pool::new(
            config::connector_for_dsn(&read_dsn, "polis-api-ptptois/1")?,
            ptptois::pool_limits(),
        ));
        state.ptptois_auth_db = Some(db::Pool::new(
            config::connector_for_dsn(&dsn, "polis-api-ptptois-auth/1")?,
            ptptois::pool_limits(),
        ));
        state.read_oidc = hybrid_read::Oidc::from_env()?;
        state.legacy_admin_uids = recent_started::admin_uids(
            &std::env::var("ADMIN_UIDS").unwrap_or_else(|_| "[]".into()),
        )?;
    }
    if std::env::var("POLIS_API_MY_INVITES_CSV_READS")
        .ok()
        .as_deref()
        == Some("1")
    {
        let dsn = std::env::var("POLIS_API_MY_INVITES_CSV_DATABASE_URL")
            .context("POLIS_API_MY_INVITES_CSV_DATABASE_URL required")?;
        let read_dsn = std::env::var("READ_ONLY_DATABASE_URL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| dsn.clone());
        state.my_invites_csv_db = Some(db::Pool::new(
            config::connector_for_dsn(&read_dsn, "polis-api-my-invites-csv/1")?,
            my_invites_csv::pool_limits(),
        ));
        state.my_invites_csv_auth_db = Some(db::Pool::new(
            config::connector_for_dsn(&dsn, "polis-api-my-invites-csv-auth/1")?,
            my_invites_csv::pool_limits(),
        ));
        state.read_oidc = hybrid_read::Oidc::from_env()?;
    }
    if std::env::var("POLIS_API_BID_READS").ok().as_deref() == Some("1") {
        let dsn = std::env::var("POLIS_API_BID_DATABASE_URL")
            .context("POLIS_API_BID_DATABASE_URL required")?;
        let read_dsn = std::env::var("READ_ONLY_DATABASE_URL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| dsn.clone());
        state.bid_db = Some(db::Pool::new(
            config::connector_for_dsn(&read_dsn, "polis-api-bid/1")?,
            math_membership::pool_limits(),
        ));
        state.bid_auth_db = Some(db::Pool::new(
            config::connector_for_dsn(&dsn, "polis-api-bid-auth/1")?,
            math_membership::pool_limits(),
        ));
        state.read_oidc = hybrid_read::Oidc::from_env()?;
    }
    if std::env::var("POLIS_API_LOCATIONS_READS").ok().as_deref() == Some("1") {
        let dsn = std::env::var("POLIS_API_LOCATIONS_DATABASE_URL")
            .context("POLIS_API_LOCATIONS_DATABASE_URL required")?;
        let read_dsn = std::env::var("READ_ONLY_DATABASE_URL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| dsn.clone());
        state.locations_db = Some(db::Pool::new(
            config::connector_for_dsn(&read_dsn, "polis-api-locations/1")?,
            math_membership::pool_limits(),
        ));
        state.locations_auth_db = Some(db::Pool::new(
            config::connector_for_dsn(&dsn, "polis-api-locations-auth/1")?,
            math_membership::pool_limits(),
        ));
        state.read_oidc = hybrid_read::Oidc::from_env()?;
    }
    if std::env::var("POLIS_API_VOTES_READS").ok().as_deref() == Some("1") {
        let dsn = std::env::var("POLIS_API_VOTES_READ_DATABASE_URL")
            .context("POLIS_API_VOTES_READ_DATABASE_URL required")?;
        let read_dsn = std::env::var("READ_ONLY_DATABASE_URL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| dsn.clone());
        state.votes_read_db = Some(db::Pool::new(
            config::connector_for_dsn(&read_dsn, "polis-api-votes-read/1")?,
            votes_read::pool_limits(),
        ));
        state.votes_read_auth_db = Some(db::Pool::new(
            config::connector_for_dsn(&dsn, "polis-api-votes-read-auth/1")?,
            votes_read::pool_limits(),
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
    if std::env::var("POLIS_API_METADATA_QUERY_READS")
        .ok()
        .as_deref()
        == Some("1")
    {
        let dsn = std::env::var("POLIS_API_METADATA_QUERY_DATABASE_URL")
            .context("POLIS_API_METADATA_QUERY_DATABASE_URL required")?;
        let read_dsn = std::env::var("READ_ONLY_DATABASE_URL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| dsn.clone());
        state.metadata_query_db = Some(db::Pool::new(
            config::connector_for_dsn(&read_dsn, "polis-api-metadata-query/1")?,
            metadata_query::pool_limits(),
        ));
        state.metadata_query_auth_db = Some(db::Pool::new(
            config::connector_for_dsn(&dsn, "polis-api-metadata-query-auth/1")?,
            metadata_query::pool_limits(),
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
    if std::env::var("POLIS_API_TREEVITE_INVITES_READS")
        .ok()
        .as_deref()
        == Some("1")
    {
        let dsn = std::env::var("POLIS_API_TREEVITE_INVITES_DATABASE_URL")
            .context("POLIS_API_TREEVITE_INVITES_DATABASE_URL required")?;
        let read_dsn = std::env::var("READ_ONLY_DATABASE_URL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| dsn.clone());
        state.treevite_invites_db = Some(db::Pool::new(
            config::connector_for_dsn(&read_dsn, "polis-api-treevite-invites/1")?,
            treevite_invites::pool_limits(),
        ));
        state.treevite_invites_auth_db = Some(db::Pool::new(
            config::connector_for_dsn(&dsn, "polis-api-treevite-invites-auth/1")?,
            treevite_invites::pool_limits(),
        ));
        state.read_oidc = hybrid_read::Oidc::from_env()?;
        let admins = std::env::var("ADMIN_UIDS")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "[]".into());
        state.legacy_admin_uids = recent_started::admin_uids(&admins)?;
    }
    if std::env::var("POLIS_API_TREEVITE_CSV_READS")
        .ok()
        .as_deref()
        == Some("1")
    {
        let dsn = std::env::var("POLIS_API_TREEVITE_CSV_DATABASE_URL")
            .context("POLIS_API_TREEVITE_CSV_DATABASE_URL required")?;
        let read_dsn = std::env::var("READ_ONLY_DATABASE_URL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| dsn.clone());
        state.treevite_csv_db = Some(db::Pool::new(
            config::connector_for_dsn(&read_dsn, "polis-api-treevite-csv/1")?,
            treevite_csv::pool_limits(),
        ));
        state.treevite_csv_auth_db = Some(db::Pool::new(
            config::connector_for_dsn(&dsn, "polis-api-treevite-csv-auth/1")?,
            treevite_csv::pool_limits(),
        ));
        state.read_oidc = hybrid_read::Oidc::from_env()?;
        let admins = std::env::var("ADMIN_UIDS")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "[]".into());
        state.legacy_admin_uids = recent_started::admin_uids(&admins)?;
    }
    if std::env::var("POLIS_API_CONVERSATION_PRELOAD_READS")
        .ok()
        .as_deref()
        == Some("1")
    {
        let dsn = std::env::var("POLIS_API_CONVERSATION_PRELOAD_DATABASE_URL")
            .context("POLIS_API_CONVERSATION_PRELOAD_DATABASE_URL required")?;
        state.conversation_preload_db = Some(db::Pool::new(
            config::connector_for_dsn(&dsn, "polis-api-conversation-preload/1")?,
            conversation_preload::pool_limits(),
        ));
    }
    if std::env::var("POLIS_API_PARTICIPATION_READS")
        .ok()
        .as_deref()
        == Some("1")
    {
        let dsn = std::env::var("POLIS_API_PARTICIPATION_DATABASE_URL")
            .context("POLIS_API_PARTICIPATION_DATABASE_URL required")?;
        let read_dsn = std::env::var("READ_ONLY_DATABASE_URL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| dsn.clone());
        state.participation_read_db = Some(db::Pool::new(
            config::connector_for_dsn(&read_dsn, "polis-api-participation-read/1")?,
            participation_read::pool_limits(),
        ));
        state.participation_read_auth_db = Some(db::Pool::new(
            config::connector_for_dsn(&dsn, "polis-api-participation-read-auth/1")?,
            participation_read::pool_limits(),
        ));
        state.read_oidc = hybrid_read::Oidc::from_env()?;
    }
    if std::env::var("POLIS_API_ALL_CONVERSATIONS_READS")
        .ok()
        .as_deref()
        == Some("1")
    {
        let dsn = std::env::var("POLIS_API_ALL_CONVERSATIONS_DATABASE_URL")
            .context("POLIS_API_ALL_CONVERSATIONS_DATABASE_URL required")?;
        let read_dsn = std::env::var("READ_ONLY_DATABASE_URL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| dsn.clone());
        state.all_conversations_db = Some(db::Pool::new(
            config::connector_for_dsn(&read_dsn, "polis-api-all-conversations/1")?,
            all_conversations::pool_limits(),
        ));
        state.all_conversations_auth_db = Some(db::Pool::new(
            config::connector_for_dsn(&dsn, "polis-api-all-conversations-auth/1")?,
            all_conversations::pool_limits(),
        ));
        state.read_oidc = hybrid_read::Oidc::from_env()?;
        let admins = std::env::var("ADMIN_UIDS")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "[]".into());
        state.legacy_admin_uids = recent_started::admin_uids(&admins)?;
    }
    if std::env::var("POLIS_API_REPORTS_READ_READS")
        .ok()
        .as_deref()
        == Some("1")
    {
        let dsn = std::env::var("POLIS_API_REPORTS_READ_DATABASE_URL")
            .context("POLIS_API_REPORTS_READ_DATABASE_URL required")?;
        let read_dsn = std::env::var("READ_ONLY_DATABASE_URL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| dsn.clone());
        state.reports_read_db = Some(db::Pool::new(
            config::connector_for_dsn(&read_dsn, "polis-api-reports-read/1")?,
            reports_read::pool_limits(),
        ));
        state.reports_read_auth_db = Some(db::Pool::new(
            config::connector_for_dsn(&dsn, "polis-api-reports-read-auth/1")?,
            reports_read::pool_limits(),
        ));
        state.read_oidc = hybrid_read::Oidc::from_env()?;
        let admins = std::env::var("ADMIN_UIDS")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "[]".into());
        state.legacy_admin_uids = recent_started::admin_uids(&admins)?;
    }
    if std::env::var("POLIS_API_BID_TO_PID_READS").ok().as_deref() == Some("1") {
        let dsn = std::env::var("POLIS_API_BID_TO_PID_DATABASE_URL")
            .context("POLIS_API_BID_TO_PID_DATABASE_URL required")?;
        let read_dsn = std::env::var("READ_ONLY_DATABASE_URL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| dsn.clone());
        state.bid_to_pid_db = Some(db::Pool::new(
            config::connector_for_dsn(&read_dsn, "polis-api-bid-to-pid/1")?,
            bid_to_pid::pool_limits(),
        ));
        state.bid_to_pid_auth_db = Some(db::Pool::new(
            config::connector_for_dsn(&dsn, "polis-api-bid-to-pid-auth/1")?,
            bid_to_pid::pool_limits(),
        ));
        state.read_oidc = hybrid_read::Oidc::from_env()?;
    }
    if std::env::var("POLIS_API_CONVERSATION_STATS_READS")
        .ok()
        .as_deref()
        == Some("1")
    {
        let dsn = std::env::var("POLIS_API_CONVERSATION_STATS_DATABASE_URL")
            .context("POLIS_API_CONVERSATION_STATS_DATABASE_URL required")?;
        let read_dsn = std::env::var("READ_ONLY_DATABASE_URL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| dsn.clone());
        state.conversation_stats_db = Some(db::Pool::new(
            config::connector_for_dsn(&read_dsn, "polis-api-conversation-stats/1")?,
            conversation_stats::pool_limits(),
        ));
        state.conversation_stats_auth_db = Some(db::Pool::new(
            config::connector_for_dsn(&dsn, "polis-api-conversation-stats-auth/1")?,
            conversation_stats::pool_limits(),
        ));
        state.read_oidc = hybrid_read::Oidc::from_env()?;
        let admins = std::env::var("ADMIN_UIDS")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "[]".into());
        state.legacy_admin_uids = recent_started::admin_uids(&admins)?;
    }
    if std::env::var("POLIS_API_STATEMENT_IMPORTANCE_READS")
        .ok()
        .as_deref()
        == Some("1")
    {
        let dsn = std::env::var("POLIS_API_STATEMENT_IMPORTANCE_DATABASE_URL")
            .context("POLIS_API_STATEMENT_IMPORTANCE_DATABASE_URL required")?;
        state.statement_importance_db = Some(db::Pool::new(
            config::connector_for_dsn(&dsn, "polis-api-statement-importance/1")?,
            statement_importance::pool_limits(),
        ));
    }
    if std::env::var("POLIS_API_TOPIC_SELECTIONS_READS")
        .ok()
        .as_deref()
        == Some("1")
    {
        let dsn = std::env::var("POLIS_API_TOPIC_SELECTIONS_DATABASE_URL")
            .context("POLIS_API_TOPIC_SELECTIONS_DATABASE_URL required")?;
        state.topic_selections_db = Some(db::Pool::new(
            config::connector_for_dsn(&dsn, "polis-api-topic-selections/1")?,
            topic_selections::pool_limits(),
        ));
    }
    if std::env::var("POLIS_API_TREEVITE_MY_INVITES_READS")
        .ok()
        .as_deref()
        == Some("1")
    {
        let dsn = std::env::var("POLIS_API_TREEVITE_MY_INVITES_DATABASE_URL")
            .context("POLIS_API_TREEVITE_MY_INVITES_DATABASE_URL required")?;
        let read_dsn = std::env::var("READ_ONLY_DATABASE_URL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| dsn.clone());
        state.treevite_my_invites_db = Some(db::Pool::new(
            config::connector_for_dsn(&read_dsn, "polis-api-treevite-my-invites/1")?,
            treevite_my_invites::pool_limits(),
        ));
        state.treevite_my_invites_auth_db = Some(db::Pool::new(
            config::connector_for_dsn(&dsn, "polis-api-treevite-my-invites-auth/1")?,
            treevite_my_invites::pool_limits(),
        ));
        state.read_oidc = hybrid_read::Oidc::from_env()?;
        let admins = std::env::var("ADMIN_UIDS")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "[]".into());
        state.legacy_admin_uids = recent_started::admin_uids(&admins)?;
    }
    if std::env::var("POLIS_API_TOPIC_PRIORITIZE_READS")
        .ok()
        .as_deref()
        == Some("1")
    {
        let dsn = std::env::var("POLIS_API_TOPIC_PRIORITIZE_DATABASE_URL")
            .context("POLIS_API_TOPIC_PRIORITIZE_DATABASE_URL required")?;
        state.topic_prioritize_db = Some(db::Pool::new(
            config::connector_for_dsn(&dsn, "polis-api-topic-prioritize/1")?,
            topic_prioritize::pool_limits(),
        ));
    }
    if std::env::var("POLIS_API_LEGACY_CONVERSATIONS_READS")
        .ok()
        .as_deref()
        == Some("1")
    {
        let dsn = std::env::var("POLIS_API_LEGACY_CONVERSATIONS_DATABASE_URL")
            .context("POLIS_API_LEGACY_CONVERSATIONS_DATABASE_URL required")?;
        let read_dsn = std::env::var("READ_ONLY_DATABASE_URL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| dsn.clone());
        state.legacy_conversations_db = Some(db::Pool::new(
            config::connector_for_dsn(&read_dsn, "polis-api-legacy-conversations/1")?,
            legacy_conversations::pool_limits(),
        ));
        state.legacy_conversations_auth_db = Some(db::Pool::new(
            config::connector_for_dsn(&dsn, "polis-api-legacy-conversations-auth/1")?,
            legacy_conversations::pool_limits(),
        ));
        state.read_oidc = hybrid_read::Oidc::from_env()?;
        let admins = std::env::var("ADMIN_UIDS")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "[]".into());
        state.legacy_admin_uids = recent_started::admin_uids(&admins)?;
    }
    if std::env::var("POLIS_API_TREEVITE_ME_READS").ok().as_deref() == Some("1") {
        let dsn = std::env::var("POLIS_API_TREEVITE_ME_DATABASE_URL")
            .context("POLIS_API_TREEVITE_ME_DATABASE_URL required")?;
        let read_dsn = std::env::var("READ_ONLY_DATABASE_URL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| dsn.clone());
        state.treevite_me_db = Some(db::Pool::new(
            config::connector_for_dsn(&read_dsn, "polis-api-treevite-me/1")?,
            treevite_me::pool_limits(),
        ));
        state.treevite_me_auth_db = Some(db::Pool::new(
            config::connector_for_dsn(&dsn, "polis-api-treevite-me-auth/1")?,
            treevite_me::pool_limits(),
        ));
        state.read_oidc = hybrid_read::Oidc::from_env()?;
        let admins = std::env::var("ADMIN_UIDS")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "[]".into());
        state.legacy_admin_uids = recent_started::admin_uids(&admins)?;
    }
    if std::env::var("POLIS_API_XID_REPORT_READS").ok().as_deref() == Some("1") {
        let dsn = std::env::var("POLIS_API_XID_REPORT_DATABASE_URL")
            .context("POLIS_API_XID_REPORT_DATABASE_URL required")?;
        let read_dsn = std::env::var("READ_ONLY_DATABASE_URL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| dsn.clone());
        state.xid_report_db = Some(db::Pool::new(
            config::connector_for_dsn(&read_dsn, "polis-api-xid-report/1")?,
            xid_report::pool_limits(),
        ));
        state.xid_report_auth_db = Some(db::Pool::new(
            config::connector_for_dsn(&dsn, "polis-api-xid-report-auth/1")?,
            xid_report::pool_limits(),
        ));
        state.read_oidc = hybrid_read::Oidc::from_env()?;
        let admins = std::env::var("ADMIN_UIDS")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "[]".into());
        state.legacy_admin_uids = recent_started::admin_uids(&admins)?;
    }
    if std::env::var("POLIS_API_EINVITES_READ_READS")
        .ok()
        .as_deref()
        == Some("1")
    {
        let dsn = std::env::var("POLIS_API_EINVITES_READ_DATABASE_URL")
            .context("POLIS_API_EINVITES_READ_DATABASE_URL required")?;
        state.einvites_read_db = Some(db::Pool::new(
            config::connector_for_dsn(&dsn, "polis-api-einvites-read/1")?,
            einvites_read::pool_limits(),
        ));
    }
    state.other_conversations_page =
        admin_page::Client::from_env_for("POLIS_API_OTHER_CONVERSATIONS_PAGE_READS").await?;
    state.integrate_page =
        admin_page::Client::from_env_for("POLIS_API_INTEGRATE_PAGE_READS").await?;
    state.admin_page = admin_page::Client::from_env().await?;
    state.treevite_codes = treevite_codes::Writer::from_env()?;
    let refresh_task = revocation::configure(&mut state).await?;
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
    let result = tokio::select! {
        r = http::serve(listener, handler) => r,
        _ = tokio::signal::ctrl_c() => Ok(()),
    };
    if let Some(task) = refresh_task {
        task.abort();
        let _ = task.await;
    }
    result
}

#[cfg(test)]
mod health_tests {
    use super::*;
    use polis_queue_adapter::jobs::transport::Connector;
    use serde_json::{Value, json};
    use std::time::Duration;

    fn app() -> route::App {
        let cfg = config::Config {
            listen: String::new(),
            math_env: "python".into(),
            cache_size: 1,
            dev_mode: false,
            use_network_host: false,
            production: true,
            pool: db::Limits {
                size: 8,
                acquire_timeout: Duration::from_millis(2000),
                statement_timeout: Duration::from_millis(3000),
                max_lifetime: Duration::from_millis(300000),
            },
        };
        let pg = "postgresql://u@127.0.0.1:1/d".parse().unwrap();
        let pool = db::Pool::new(Connector::Plain(Box::new(pg)), cfg.pool.clone());
        let mut app = route::App::new(&cfg, pool);
        let rsa = openssl::rsa::Rsa::generate(2048).unwrap();
        let private = String::from_utf8(rsa.private_key_to_pem().unwrap()).unwrap();
        let public = String::from_utf8(rsa.public_key_to_pem().unwrap()).unwrap();
        app.participant_keys = Some(
            polis_auth::keys::Keys::from_environment(|name| match name {
                "JWT_PRIVATE_KEY" => Some(private.clone().into()),
                "JWT_PUBLIC_KEY" => Some(public.clone().into()),
                _ => None,
            })
            .unwrap(),
        );
        app
    }

    fn json_body(response: Outgoing, status: u16) -> Value {
        assert_eq!(response.status, status);
        let Body::Fixed(bytes) = response.body else {
            panic!("health must be fixed JSON")
        };
        serde_json::from_slice(&bytes).unwrap()
    }

    #[test]
    fn health_reports_the_fields_used_by_deploy_validation() {
        let app = app();
        for reachable in [true, false] {
            let body = json_body(
                health_response(
                    &app,
                    &polis_auth::observability::PROCESS,
                    reachable,
                    String::new(),
                    std::iter::empty(),
                ),
                if reachable { 200 } else { 503 },
            );
            assert_eq!(body.as_object().unwrap().len(), 148);
            assert_eq!(body["participantKeysLoaded"], true);
            assert_eq!(
                body["participantPublicKeyFingerprint"],
                app.participant_keys.as_ref().unwrap().fingerprint()
            );
            assert_eq!(body["version"], env!("POLIS_VERSION"));
            assert_eq!(body["commit"], env!("GIT_HASH"));
            assert_eq!(body["status"], if reachable { "ok" } else { "degraded" });
            assert_eq!(body["mathEnv"], "python");
            assert_eq!(
                body["routing"],
                json!({"configuredRoutes": "", "enabledSwitches": []})
            );
            assert_eq!(
                body["pools"]["common"],
                json!({
                    "readOnly": true, "reachable": reachable, "limit": 8, "available": 8,
                    "acquireTimeoutMs": 2000, "statementTimeoutMs": 3000, "maxLifetimeMs": 300000
                })
            );
        }
    }

    #[test]
    fn health_reports_only_explicit_route_switches_in_sorted_order() {
        let environment = [
            ("POLIS_API_ROBOTS_READS", "1"),
            ("POLIS_API_POST_VOTES", "1"),
            ("POLIS_API_OWNER_LIST", "1"),
            ("POLIS_API_TOPIC_SELECTION_WRITES", "1"),
            ("POLIS_API_START", "1"),
            ("POLIS_API_USERS_READS", "true"),
            ("POLIS_API_VOTES_READS", "0"),
            ("OTHER_READS", "1"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_owned(), v.to_owned()));
        let body = json_body(
            health_response(
                &app(),
                &polis_auth::observability::PROCESS,
                true,
                "pca2,robots".into(),
                environment,
            ),
            200,
        );
        assert_eq!(
            body["routing"],
            json!({
                "configuredRoutes": "pca2,robots",
                "enabledSwitches": ["POLIS_API_OWNER_LIST", "POLIS_API_POST_VOTES", "POLIS_API_ROBOTS_READS", "POLIS_API_TOPIC_SELECTION_WRITES"]
            })
        );
    }
}
