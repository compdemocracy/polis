//! Startup-only route inventory. These are process capabilities and explicit
//! environment switches, not the nginx map or a promise that a request is eligible.
//! Keep this catalog alongside changes to dispatch; its tests check both layers.
use serde_json::json;

struct Route {
    family: &'static str,
    methods: &'static [&'static str],
    path: &'static str,
    pattern: bool,
    switches: &'static [&'static str],
    #[cfg(test)]
    example: &'static str,
    #[cfg(test)]
    dispatch_key: &'static str,
}

macro_rules! exact {
    ($family:ident, [$($method:literal),+], $path:path, [$($switch:literal),*], $key:literal) => {
        Route {
            family: stringify!($family), methods: &[$($method),+], path: $path,
            pattern: false, switches: &[$($switch),*],
            #[cfg(test)] example: $path,
            #[cfg(test)] dispatch_key: $key,
        }
    };
}
macro_rules! pattern {
    ($family:ident, $path:literal, $example:literal, $switch:literal) => {
        Route {
            family: stringify!($family),
            methods: &["GET", "HEAD"],
            path: $path,
            pattern: true,
            switches: &[$switch],
            #[cfg(test)]
            example: $example,
            #[cfg(test)]
            dispatch_key: concat!(stringify!($family), "::matches"),
        }
    };
}

// Patterns describe the dispatch predicates, including their intentionally broad
// prefixes. Individual handlers impose narrower validation. OPTIONS responses are
// middleware behavior, not separate handlers in this catalog.
const ROUTES: &[Route] = &[
    exact!(
        owner,
        ["GET", "HEAD"],
        crate::owner::PATH,
        ["POLIS_API_OWNER_LIST"],
        "owner::PATH"
    ),
    exact!(
        route,
        ["GET", "HEAD"],
        crate::route::PATH,
        [],
        "route::PATH"
    ),
    exact!(
        comments,
        ["GET", "HEAD"],
        crate::comments::PATH,
        ["POLIS_API_COMMENT_READS"],
        "comments::PATH"
    ),
    exact!(
        next_comment,
        ["GET", "HEAD"],
        crate::next_comment::PATH,
        ["POLIS_API_NEXT_COMMENT_READS"],
        "next_comment::PATH"
    ),
    exact!(
        version,
        ["GET", "HEAD"],
        crate::version::PATH,
        ["POLIS_API_VERSION_READS"],
        "version::PATH"
    ),
    exact!(
        connection,
        ["GET", "HEAD"],
        crate::connection::PATH,
        ["POLIS_API_CONNECTION_READS"],
        "connection::PATH"
    ),
    exact!(
        perf_stats,
        ["GET", "HEAD"],
        crate::perf_stats::PATH,
        ["POLIS_API_PERF_STATS_READS"],
        "perf_stats::PATH"
    ),
    exact!(
        robots,
        ["GET", "HEAD"],
        crate::robots::PATH,
        ["POLIS_API_ROBOTS_READS"],
        "robots::PATH"
    ),
    exact!(
        ops_whoami,
        ["GET", "HEAD"],
        crate::ops_whoami::PATH,
        ["POLIS_API_OPS_WHOAMI_READS"],
        "ops_whoami::PATH"
    ),
    exact!(
        delphi_read,
        ["GET", "HEAD"],
        crate::delphi_read::PATH,
        ["POLIS_API_DELPHI_READS"],
        "delphi_read::PATH"
    ),
    exact!(
        collective_statement,
        ["GET", "HEAD"],
        crate::collective_statement::PATH,
        ["POLIS_API_COLLECTIVE_STATEMENT_READS"],
        "collective_statement::PATH"
    ),
    exact!(
        topic_stats,
        ["GET", "HEAD"],
        crate::topic_stats::PATH,
        ["POLIS_API_TOPIC_STATS_READS"],
        "topic_stats::PATH"
    ),
    exact!(
        delphi_logs,
        ["GET", "HEAD"],
        crate::delphi_logs::PATH,
        ["POLIS_API_DELPHI_LOGS_READS"],
        "delphi_logs::PATH"
    ),
    exact!(
        delphi_run_read,
        ["GET", "HEAD"],
        crate::delphi_run_read::PATH,
        ["POLIS_API_DELPHI_RUN_READS"],
        "delphi_run_read::PATH"
    ),
    exact!(
        delphi_visualizations,
        ["GET", "HEAD"],
        crate::delphi_visualizations::PATH,
        ["POLIS_API_DELPHI_VISUALIZATIONS_READS"],
        "delphi_visualizations::PATH"
    ),
    exact!(
        delphi_reports,
        ["GET", "HEAD"],
        crate::delphi_reports::PATH,
        ["POLIS_API_DELPHI_REPORTS_READS"],
        "delphi_reports::PATH"
    ),
    exact!(
        database,
        ["GET", "HEAD"],
        crate::database::PATH,
        ["POLIS_API_DATABASE_READS"],
        "database::PATH"
    ),
    exact!(
        contexts,
        ["GET", "HEAD"],
        crate::contexts::PATH,
        ["POLIS_API_CONTEXTS_READS"],
        "contexts::PATH"
    ),
    exact!(
        conversation_preload,
        ["GET", "HEAD"],
        crate::conversation_preload::PATH,
        ["POLIS_API_CONVERSATION_PRELOAD_READS"],
        "conversation_preload::PATH"
    ),
    exact!(
        domain_whitelist,
        ["GET", "HEAD"],
        crate::domain_whitelist::PATH,
        ["POLIS_API_DOMAIN_WHITELIST_READS"],
        "domain_whitelist::PATH"
    ),
    exact!(
        metadata_questions,
        ["GET", "HEAD"],
        crate::metadata_questions::PATH,
        ["POLIS_API_METADATA_QUESTIONS_READS"],
        "metadata_questions::PATH"
    ),
    exact!(
        treevite_codes,
        ["POST"],
        crate::treevite_codes::REVOKE_PATH,
        ["POLIS_API_TREEVITE_CODE_WRITES"],
        "treevite_codes::REVOKE_PATH"
    ),
    exact!(
        treevite_codes,
        ["POST"],
        crate::treevite_codes::REISSUE_PATH,
        ["POLIS_API_TREEVITE_CODE_WRITES"],
        "treevite_codes::REISSUE_PATH"
    ),
    exact!(
        treevite_waves,
        ["GET", "HEAD"],
        crate::treevite_waves::PATH,
        ["POLIS_API_TREEVITE_WAVES_READS"],
        "treevite_waves::PATH"
    ),
    exact!(
        math_membership,
        ["GET", "HEAD"],
        crate::math_membership::BID_PATH,
        ["POLIS_API_BID_READS"],
        "math_membership::BID_PATH"
    ),
    exact!(
        math_membership,
        ["GET", "HEAD"],
        crate::math_membership::LOCATIONS_PATH,
        ["POLIS_API_LOCATIONS_READS"],
        "math_membership::LOCATIONS_PATH"
    ),
    exact!(
        report_comments,
        ["GET", "HEAD"],
        crate::report_comments::PATH,
        ["POLIS_API_REPORT_COMMENTS_READS"],
        "report_comments::PATH"
    ),
    exact!(
        moderation_comments,
        ["GET", "HEAD"],
        crate::moderation_comments::PATH,
        ["POLIS_API_MODERATION_COMMENTS_READS"],
        "moderation_comments::PATH"
    ),
    exact!(
        participant_comments,
        ["GET", "HEAD"],
        crate::participant_comments::PATH,
        ["POLIS_API_PARTICIPANT_COMMENTS_READS"],
        "participant_comments::PATH"
    ),
    exact!(
        participants_read,
        ["GET", "HEAD"],
        crate::participants_read::PATH,
        ["POLIS_API_PARTICIPANTS_READS"],
        "participants_read::PATH"
    ),
    exact!(
        ptptois,
        ["GET", "HEAD"],
        crate::ptptois::PATH,
        ["POLIS_API_PTPTOIS_READS"],
        "ptptois::PATH"
    ),
    exact!(
        my_invites_csv,
        ["GET", "HEAD"],
        crate::my_invites_csv::PATH,
        ["POLIS_API_MY_INVITES_CSV_READS"],
        "my_invites_csv::PATH"
    ),
    exact!(
        participation_read,
        ["GET", "HEAD"],
        crate::participation_read::PATH,
        ["POLIS_API_PARTICIPATION_READS"],
        "participation_read::PATH"
    ),
    exact!(
        treevite_csv,
        ["GET", "HEAD"],
        crate::treevite_csv::PATH,
        ["POLIS_API_TREEVITE_CSV_READS"],
        "treevite_csv::PATH"
    ),
    exact!(
        treevite_invites,
        ["GET", "HEAD"],
        crate::treevite_invites::PATH,
        ["POLIS_API_TREEVITE_INVITES_READS"],
        "treevite_invites::PATH"
    ),
    exact!(
        metadata_choices,
        ["GET", "HEAD"],
        crate::metadata_choices::PATH,
        ["POLIS_API_METADATA_CHOICES_READS"],
        "metadata_choices::PATH"
    ),
    exact!(
        recent_started,
        ["GET", "HEAD"],
        crate::recent_started::PATH,
        ["POLIS_API_RECENT_STARTED_READS"],
        "recent_started::PATH"
    ),
    exact!(
        treevite_me,
        ["GET", "HEAD"],
        crate::treevite_me::PATH,
        ["POLIS_API_TREEVITE_ME_READS"],
        "treevite_me::PATH"
    ),
    exact!(
        treevite_my_invites,
        ["GET", "HEAD"],
        crate::treevite_my_invites::PATH,
        ["POLIS_API_TREEVITE_MY_INVITES_READS"],
        "treevite_my_invites::PATH"
    ),
    exact!(
        legacy_conversations,
        ["GET", "HEAD"],
        crate::legacy_conversations::PATH,
        ["POLIS_API_LEGACY_CONVERSATIONS_READS"],
        "legacy_conversations::PATH"
    ),
    exact!(
        einvites_read,
        ["GET", "HEAD"],
        crate::einvites_read::PATH,
        ["POLIS_API_EINVITES_READ_READS"],
        "einvites_read::PATH"
    ),
    exact!(
        topic_prioritize,
        ["GET", "HEAD"],
        crate::topic_prioritize::PATH,
        ["POLIS_API_TOPIC_PRIORITIZE_READS"],
        "topic_prioritize::PATH"
    ),
    exact!(
        statement_importance,
        ["GET", "HEAD"],
        crate::statement_importance::PATH,
        ["POLIS_API_STATEMENT_IMPORTANCE_READS"],
        "statement_importance::PATH"
    ),
    exact!(
        topic_selections,
        ["GET", "HEAD"],
        crate::topic_selections::PATH,
        ["POLIS_API_TOPIC_SELECTIONS_READS"],
        "topic_selections::PATH"
    ),
    exact!(
        conversation_stats,
        ["GET", "HEAD"],
        crate::conversation_stats::PATH,
        ["POLIS_API_CONVERSATION_STATS_READS"],
        "conversation_stats::PATH"
    ),
    exact!(
        bid_to_pid,
        ["GET", "HEAD"],
        crate::bid_to_pid::PATH,
        ["POLIS_API_BID_TO_PID_READS"],
        "bid_to_pid::PATH"
    ),
    exact!(
        reports_read,
        ["GET", "HEAD"],
        crate::reports_read::PATH,
        ["POLIS_API_REPORTS_READ_READS"],
        "reports_read::PATH"
    ),
    exact!(
        all_conversations,
        ["GET", "HEAD"],
        crate::all_conversations::PATH,
        ["POLIS_API_ALL_CONVERSATIONS_READS"],
        "all_conversations::PATH"
    ),
    exact!(
        recent_activity,
        ["GET", "HEAD"],
        crate::recent_activity::PATH,
        ["POLIS_API_RECENT_ACTIVITY_READS"],
        "recent_activity::PATH"
    ),
    exact!(
        metadata_read,
        ["GET", "HEAD"],
        crate::metadata_read::PATH,
        ["POLIS_API_METADATA_READS"],
        "metadata_read::PATH"
    ),
    exact!(
        metadata_query,
        ["POST"],
        crate::metadata_query::PATH,
        ["POLIS_API_METADATA_QUERY_READS"],
        "metadata_query::PATH"
    ),
    exact!(
        votes_read,
        ["GET", "HEAD"],
        crate::votes_read::PATH,
        ["POLIS_API_VOTES_READS"],
        "votes_read::PATH"
    ),
    exact!(
        votes_read,
        ["GET", "HEAD"],
        crate::votes_read::ME_PATH,
        ["POLIS_API_VOTES_READS"],
        "votes_read::ME_PATH"
    ),
    exact!(
        metadata_answers,
        ["GET", "HEAD"],
        crate::metadata_answers::PATH,
        ["POLIS_API_METADATA_ANSWERS_READS"],
        "metadata_answers::PATH"
    ),
    exact!(
        treevite_write,
        ["POST"],
        crate::treevite_write_contract::ACCEPT_PATH,
        ["POLIS_API_TREEVITE_WRITE"],
        "treevite_write::matches"
    ),
    exact!(
        treevite_write,
        ["POST"],
        crate::treevite_write_contract::LOGIN_PATH,
        ["POLIS_API_TREEVITE_WRITE"],
        "treevite_write::matches"
    ),
    pattern!(
        conversation_pages,
        "^/[0-9][A-Za-z0-9]+",
        "/2fixture",
        "POLIS_API_CONVERSATION_PAGE_READS"
    ),
    pattern!(
        delphi_result_read,
        "^/api/v3/delphi/runs/",
        "/api/v3/delphi/runs/fixture",
        "POLIS_API_DELPHI_RESULT_READS"
    ),
    pattern!(
        ops_page,
        "^/api/v3/ops/page/",
        "/api/v3/ops/page/fixture",
        "POLIS_API_OPS_PAGE_READS"
    ),
    pattern!(
        ops_catchall,
        "^/api/v3/ops(?:$|/(?![Ww][Hh][Oo][Aa][Mm][Ii](?:/|$)|[Pp][Aa][Gg][Ee](?:/|$)))",
        "/api/v3/ops/fixture",
        "POLIS_API_OPS_CATCHALL_READS"
    ),
    pattern!(
        integrate_page,
        "^/integrate",
        "/integrate",
        "POLIS_API_INTEGRATE_PAGE_READS"
    ),
    pattern!(
        admin_page,
        "^/m/[0-9][A-Za-z0-9]",
        "/m/2fixture",
        "POLIS_API_ADMIN_PAGE_READS"
    ),
    pattern!(
        report_export,
        "^/api/v3/reportExport/[^/]*/",
        "/api/v3/reportExport/fixture/comments",
        "POLIS_API_REPORT_EXPORT_READS"
    ),
    pattern!(
        xid_report,
        "^/api/v3/xid/[^/]+$",
        "/api/v3/xid/00000000-0000-4000-8000-000000000000-xid.csv",
        "POLIS_API_XID_REPORT_READS"
    ),
    exact!(
        post_votes,
        ["POST"],
        crate::post_votes::PATH,
        ["POLIS_API_POST_VOTES"],
        "votes_read::PATH"
    ),
    exact!(
        post_comments,
        ["POST"],
        crate::post_comments::PATH,
        ["POLIS_API_POST_COMMENTS"],
        "comments::PATH"
    ),
    exact!(
        post_treevite_waves,
        ["POST"],
        crate::post_treevite_waves::PATH,
        ["POLIS_API_POST_TREEVITE_WAVES"],
        "treevite_waves::PATH"
    ),
    exact!(
        topic_selection_writes,
        ["POST", "PUT", "DELETE"],
        crate::topic_selections::PATH,
        ["POLIS_API_TOPIC_SELECTION_WRITES"],
        "topic_selections::PATH"
    ),
    Route {
        family: "health",
        methods: &["GET"],
        path: "/health",
        pattern: false,
        switches: &[],
        #[cfg(test)]
        example: "/health",
        #[cfg(test)]
        dispatch_key: "/health",
    },
];

/// Read only the fixed switch allowlist; never enumerate or print the environment.
/// Like startup configuration, only the exact value `1` means on. These states
/// don't include prerequisites such as signing keys, databases or OPS_ENABLED.
pub fn line(
    addr: std::net::SocketAddr,
    math_env: &str,
    mut lookup: impl FnMut(&str) -> Option<String>,
) -> String {
    let routes: Vec<_> = ROUTES
        .iter()
        .map(|route| {
            let switches: serde_json::Map<_, _> = route
                .switches
                .iter()
                .map(|name| {
                    let state = if lookup(name).as_deref() == Some("1") {
                        "on"
                    } else {
                        "off"
                    };
                    ((*name).to_owned(), json!(state))
                })
                .collect();
            json!({"family": route.family, "methods": route.methods,
            "path": route.path, "pattern": route.pattern, "switches": switches})
        })
        .collect();
    json!({"event": "polis_api_listening", "addr": addr.to_string(),
        "math_env": math_env, "routes": routes})
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    #[test]
    fn all_off_line_lists_routes_and_switches() {
        let line = line("0.0.0.0:8080".parse().unwrap(), "python", |_| None);
        let value: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(value["event"], "polis_api_listening");
        assert_eq!(value["addr"], "0.0.0.0:8080");
        assert_eq!(value["math_env"], "python");
        let routes = value["routes"]
            .as_array()
            .expect("startup must enumerate routes");
        assert!(routes.iter().any(|r| r["path"] == "/api/v3/math/pca2"));
        for route in routes {
            for state in route["switches"].as_object().unwrap().values() {
                assert_eq!(state, "off");
            }
        }
        assert!(!line.contains('\n'));
        assert_eq!(routes.len(), ROUTES.len());
        for (actual, expected) in routes.iter().zip(ROUTES) {
            assert_eq!(actual["family"], expected.family);
            assert_eq!(actual["methods"], json!(expected.methods));
            assert_eq!(actual["path"], expected.path);
            assert_eq!(actual["pattern"], expected.pattern);
            assert_eq!(
                actual["switches"].as_object().unwrap().len(),
                expected.switches.len()
            );
        }
        // Explicit zero and an absent environment have the same disabled states.
        assert_eq!(
            value,
            serde_json::from_str::<Value>(&super::line(
                "0.0.0.0:8080".parse().unwrap(),
                "python",
                |_| Some("0".into())
            ))
            .unwrap()
        );
    }
    #[test]
    fn mixed_line_reads_only_allowlisted_names_and_requires_exact_one() {
        let mut queried = std::collections::BTreeSet::new();
        let line = line("127.0.0.1:8080".parse().unwrap(), "python", |key| {
            assert!(
                ROUTES.iter().any(|r| r.switches.contains(&key)),
                "unexpected environment read: {key}"
            );
            queried.insert(key.to_owned());
            Some(
                match key {
                    "POLIS_API_POST_VOTES" => "1",
                    "POLIS_API_VOTES_READS" => "true",
                    _ => "0",
                }
                .into(),
            )
        });
        let value: Value = serde_json::from_str(&line).unwrap();
        let routes = value["routes"]
            .as_array()
            .expect("startup must enumerate routes");
        let write = routes.iter().find(|r| r["family"] == "post_votes").unwrap();
        let read = routes.iter().find(|r| r["family"] == "votes_read").unwrap();
        assert_eq!(write["switches"]["POLIS_API_POST_VOTES"], "on");
        assert_eq!(read["switches"]["POLIS_API_VOTES_READS"], "off");
        assert_eq!(
            queried,
            ROUTES
                .iter()
                .flat_map(|r| r.switches.iter().map(|s| (*s).to_owned()))
                .collect()
        );
        assert!(!line.contains("DATABASE_URL"));
        assert!(!line.contains("JWT"));
        for raw in ["true", "01", " 1", "1 ", "", "planted-secret-value"] {
            let output = super::line("[::1]:8080".parse().unwrap(), "python", |_| {
                Some(raw.into())
            });
            let value: Value = serde_json::from_str(&output).unwrap();
            assert_eq!(value["addr"], "[::1]:8080");
            assert!(value["routes"].as_array().unwrap().iter().all(|r| {
                r["switches"]
                    .as_object()
                    .unwrap()
                    .values()
                    .all(|v| v == "off")
            }));
            assert!(!output.contains("planted-secret-value"));
        }
    }
}

#[cfg(test)]
#[path = "startup_routes_tests.rs"]
pub(crate) mod dispatch_tests;
