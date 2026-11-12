//! The shadow listener's read lanes. A copy of `GET /api/v3/votes`,
//! `GET /api/v3/comments` or `GET /api/v3/nextComment` is answered 204 before
//! any database work, runs through the live prelude and handler on its own
//! lane's pools, and prints one line: would the live handler serve it, and if
//! not, why not, as one word of a closed set.
//!
//! Every copy here carries, in its query string, its token and its cookie,
//! values no other field could hold. No line, event or access line may hold
//! any of them.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::string_slice
)]
use super::*;
use crate::http::Headers;
use crate::shadow;
use polis_queue_adapter::jobs::transport::Connector;
use serde_json::{Value, json};

/// The line's complete key set, in the order it is printed: the same for the
/// three routes. No key names a participant, a comment or a user, and none
/// holds the query string, text, a digest or a length.
const LINE_KEYS: &[&str] = &[
    "message",
    "listener",
    "service",
    "env",
    "shadow",
    "route",
    "request_id",
    "outcome",
    "status",
    "reason",
    "queue_ms",
    "handler_ms",
    "db_ms",
    "total_ms",
    "zid",
    "rows",
    "selected",
    "remaining",
    "total",
    "weights_tick",
];

const OUTCOMES: &[&str] = &[
    "would_serve",
    "would_answer",
    "would_hand_back",
    "would_fail",
    "shed",
];

/// Every reason a line of any read lane can carry.
const REASONS: &[&str] = &[
    // The lane.
    "rate_cap",
    "lane_full",
    // The route prelude.
    "revoked",
    "not_https",
    "body_unmodelled",
    "parameter",
    // Any handler.
    "unconfigured",
    "shape_method",
    "shape_body",
    "cookie",
    "no_conversation_id",
    "shape_conversation_id",
    "unknown_conversation",
    "not_a_participant",
    "pool_busy",
    "database",
    "deadline",
    // The credential, where the handler resolves an identity.
    "credential_shape",
    "credential_scope",
    "credential_kind",
    "participant_reads_off",
    "participant_token",
    "oidc_off",
    "oidc_token",
    // GET /api/v3/votes.
    "shape_path",
    "me_no_token",
    "no_query",
    "query_size",
    "query_repeated",
    "query_key",
    "xid",
    "param_pid",
    "param_tid",
    "me_no_user",
    "me_membership",
    "ambiguous_membership",
    "many_rows",
    "conversation_code",
    "schema",
    // GET /api/v3/comments.
    "report_id",
    "param_moderation",
    "moderation_body",
    "identity_parameter",
    "moderation_key",
    "param_mod_in",
    "param_voting_patterns",
    "param_mod_gt",
    "moderation_mod_gt",
    "moderation_pid",
    "param_tids",
    "param_mod",
    "param_limit",
    "param_offset",
    "negative_offset",
    // GET /api/v3/nextComment.
    "lang",
    "pid_parameter",
    "lang_and_pid",
    "param_without",
    "param_initial_tid",
    "plain_off",
    "token_refused",
    "account_token",
    "initial_voted",
];

/// A conversation code, a participant number, an external id and a cookie
/// that no other field of a line could hold.
const CODE: &str = "2readlanesentinel";
const PID: &str = "1918273645";
const XID: &str = "external-id-sentinel-7f3a";
const COOKIE: &str = "cookie-sentinel-51c9";

/// Set in a child process to make an observation panic while it holds a
/// copy, with the copy's own request line in the panic's message.
const PANIC_IN_OBSERVATION: &str = "POLIS_READ_OBSERVE_TEST_PANIC";

/// A panic in the middle of an observation whose message is the copy's own
/// target, query string and all.
pub(super) fn panic_point(req: &Request) {
    if std::env::var_os(PANIC_IN_OBSERVATION).is_some() {
        panic!("forced panic in the read observation: {}", req.target);
    }
}

fn request_id() -> String {
    format!("{:032x}", rand::random::<u128>())
}

fn app_config() -> config::Config {
    config::Config {
        listen: String::new(),
        math_env: "test".into(),
        cache_size: 10,
        pca_cache_size: 10,
        pca_cache_bytes: crate::pca::DEFAULT_CACHE_BYTES,
        dev_mode: false,
        use_network_host: false,
        production: true,
        pool: crate::votes_read::pool_limits(),
    }
}

fn closed() -> Connector {
    Connector::Plain(Box::new("postgresql://u@127.0.0.1:1/d".parse().unwrap()))
}

struct Signing {
    public: Vec<u8>,
    private: jsonwebtoken::EncodingKey,
}

fn signing() -> Signing {
    let rsa = openssl::rsa::Rsa::generate(2048).unwrap();
    Signing {
        public: rsa.public_key_to_pem().unwrap(),
        private: jsonwebtoken::EncodingKey::from_rsa_pem(&rsa.private_key_to_pem().unwrap())
            .unwrap(),
    }
}

fn bearer(keys: &Signing, claims: &Value) -> String {
    format!(
        "Bearer {}",
        jsonwebtoken::encode(
            &jsonwebtoken::Header::new(jsonwebtoken::Algorithm::RS256),
            claims,
            &keys.private
        )
        .unwrap()
    )
}

/// A participant's token for `cid`.
fn participant(keys: &Signing, cid: &str) -> String {
    bearer(
        keys,
        &json!({"uid":41,"pid":0,"conversation_id":cid,"sub":"anon:41",
            "iss":"fixture","aud":"fixture","iat":1600000000_u64,"exp":4100000000_u64,
            "anonymous_participant":true}),
    )
}

/// A shadow process's state with the given read lanes, each on `connector`,
/// and with participant tokens verified when `public` is given.
fn lanes_app(
    connector: impl Fn() -> Connector,
    routes: &[Route],
    max_per_second: u32,
    public: Option<&[u8]>,
) -> App {
    let mut app = App::new(
        &app_config(),
        db::Pool::new(connector(), crate::votes_read::pool_limits()),
    );
    for route in routes {
        install(&mut app, *route, max_per_second, |_, _| Ok(connector())).unwrap();
    }
    app.next_comment_plain = true;
    if let Some(public) = public {
        app.participant_verifier = Some(Arc::new(
            polis_auth::participant::Verifier::new(public, "fixture", "fixture").unwrap(),
        ));
    }
    app
}

/// A read as nginx's mirror sends it to the shadow service: the query string
/// carried, no body.
fn copy(route: Route, query: Option<&str>, extra: &[(&str, &str)], id: &str) -> Request {
    let mut headers = vec![
        ("host", "localhost"),
        ("x-forwarded-proto", "https"),
        ("x-request-id", id),
        ("x-polis-shadow", route.selector()),
    ];
    for (name, value) in extra {
        headers.retain(|(existing, _)| existing != name);
        headers.push((name, value));
    }
    Request {
        method: "GET".into(),
        target: match query {
            Some(query) => format!("{}?{query}", route.path()),
            None => route.path().to_owned(),
        },
        headers: Headers::from_raw(headers),
        body: vec![],
    }
}

/// The keys of a printed line in their printed order.
fn printed_keys(line: &str) -> Vec<String> {
    let value: Value = serde_json::from_str(line).unwrap();
    let mut keys: Vec<(usize, String)> = value
        .as_object()
        .unwrap()
        .keys()
        .map(|key| (line.find(&format!("\"{key}\":")).unwrap(), key.clone()))
        .collect();
    keys.sort();
    keys.into_iter().map(|(_, key)| key).collect()
}

/// The object printed under `key` in `body`, as it was printed.
fn printed_object<'a>(body: &'a str, key: &str) -> &'a str {
    let start = body.find(&format!("\"{key}\":{{")).unwrap() + key.len() + 3;
    let mut depth = 0;
    for (at, c) in body[start..].char_indices() {
        match c {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return &body[start..=start + at];
                }
            }
            _ => {}
        }
    }
    panic!("an unclosed object under {key}")
}

fn printed_line(id: &str) -> Option<String> {
    let marker = format!("\"request_id\":\"{id}\"");
    recorded().into_iter().find(|line| line.contains(&marker))
}

/// The copy's line, once it is printed.
async fn observation(id: &str) -> Value {
    let printed = tokio::time::timeout(Duration::from_secs(60), async {
        loop {
            if let Some(line) = printed_line(id) {
                return line;
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("no observation line for {id}"));
    assert_line_shape(&printed);
    serde_json::from_str(&printed).unwrap()
}

/// Whether `printed` holds anything of a copy that must stay in process.
fn leaks(printed: &str) -> bool {
    [
        CODE,
        PID,
        XID,
        COOKIE,
        "Bearer",
        "eyJ",
        "conversation_id=",
        "?",
    ]
    .iter()
    .any(|secret| printed.contains(secret))
}

/// The line's contract: exactly the allowed keys in their order, and every
/// value a number this module measured, the conversation number, a boolean,
/// null, or a word of a closed set, so that no part of a query string, no
/// token and no number of a person or a comment can be on it.
fn assert_line_shape(printed: &str) {
    assert_eq!(printed_keys(printed), LINE_KEYS, "{printed}");
    assert!(!leaks(printed), "{printed}");
    let line: Value = serde_json::from_str(printed).unwrap();
    for key in line.as_object().unwrap().keys() {
        assert!(
            ![
                "pid", "uid", "xid", "tid", "txt", "query", "url", "bytes", "length", "digest"
            ]
            .iter()
            .any(|part| key == part || key.ends_with(&format!("_{part}"))),
            "{key} names what a line may not carry: {printed}"
        );
    }
    assert_eq!(line["message"], "shadow_observation");
    assert_eq!(line["listener"], "shadow");
    assert_eq!(line["service"], "polis-api-shadow");
    let route = Route::ALL
        .into_iter()
        .find(|route| line["shadow"] == route.selector())
        .unwrap_or_else(|| panic!("an unknown selector: {printed}"));
    assert_eq!(line["route"], route.name());
    assert!(
        line["request_id"].is_null()
            || line["request_id"].as_str().is_some_and(|id| id.len() == 32
                && id
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))),
        "{printed}"
    );
    let word = |key: &str, words: &[&str], nullable: bool| {
        assert!(
            (nullable && line[key].is_null())
                || line[key].as_str().is_some_and(|w| words.contains(&w)),
            "{key}: {printed}"
        );
    };
    word("outcome", OUTCOMES, false);
    word("reason", REASONS, true);
    word("rows", &["none", "one", "many"], true);
    for key in [
        "status",
        "queue_ms",
        "handler_ms",
        "db_ms",
        "total_ms",
        "zid",
        "remaining",
        "total",
        "weights_tick",
    ] {
        assert!(
            line[key].is_null() || line[key].is_number(),
            "{key}: {printed}"
        );
    }
    assert!(line["selected"].is_null() || line["selected"].is_boolean());
    // A route's own keys are null on the other routes' lines.
    if route != Route::NextComment {
        for key in ["selected", "remaining", "total", "weights_tick"] {
            assert!(line[key].is_null(), "{key}: {printed}");
        }
    }
    if route == Route::NextComment {
        assert!(line["rows"].is_null(), "{printed}");
    }
    if line["outcome"] == "would_serve" {
        assert!(line["reason"].is_null(), "{printed}");
    } else {
        assert!(line["reason"].is_string(), "{printed}");
    }
}

async fn accept_copy(app: &Arc<App>, votes: &Arc<shadow::Lane>, req: Request) -> u16 {
    shadow::accept(app.clone(), votes.clone(), req).await.status
}

/// The table: a request is a copy of a read when its method is GET and its
/// selector name and its path are that route's, and its lane is built.
/// Anything else is not a copy: 404, and no line.
#[tokio::test]
async fn a_read_copy_is_a_get_with_its_routes_selector_on_its_routes_path() {
    let app = Arc::new(lanes_app(closed, &Route::ALL, 1000, None));
    let only_votes = Arc::new(lanes_app(closed, &[Route::Votes], 1000, None));
    let votes = shadow::Lane::new(1000);
    let query = Some("conversation_id=2abc");
    let mut unanswered = vec![];
    for route in Route::ALL {
        let id = request_id();
        assert_eq!(
            accept_copy(&app, &votes, copy(route, query, &[], &id)).await,
            204
        );
        let line = observation(&id).await;
        assert_eq!(line["shadow"], route.selector());
        // A lane that is not built serves nothing.
        if route != Route::Votes {
            let id = request_id();
            assert_eq!(
                accept_copy(&only_votes, &votes, copy(route, query, &[], &id)).await,
                404
            );
            unanswered.push(id);
        }
        for other in Route::ALL.into_iter().filter(|other| *other != route) {
            // Another route's selector on this route's path.
            let id = request_id();
            let mut req = copy(route, query, &[], &id);
            req.headers = Headers::from_raw([
                ("host", "localhost"),
                ("x-forwarded-proto", "https"),
                ("x-request-id", id.as_str()),
                ("x-polis-shadow", other.selector()),
            ]);
            assert_eq!(accept_copy(&app, &votes, req).await, 404);
            unanswered.push(id);
        }
        for method in ["POST", "HEAD", "PUT", "OPTIONS"] {
            let id = request_id();
            let mut req = copy(route, query, &[], &id);
            req.method = method.into();
            assert_eq!(accept_copy(&app, &votes, req).await, 404, "{method}");
            unanswered.push(id);
        }
        // The vote and comment selectors are not a read's.
        for selector in ["votesShadow", "commentsShadow", "", "votesRead"] {
            let id = request_id();
            let req = copy(route, query, &[("x-polis-shadow", selector)], &id);
            assert_eq!(accept_copy(&app, &votes, req).await, 404, "{selector}");
            unanswered.push(id);
        }
        // A longer path is another route.
        let id = request_id();
        let mut req = copy(route, query, &[], &id);
        req.target = format!("{}/me?conversation_id=2abc", route.path());
        assert_eq!(accept_copy(&app, &votes, req).await, 404);
        unanswered.push(id);
    }
    // A copy sent after them is printed; a line for any of the others would
    // have been printed by then.
    let last = request_id();
    assert_eq!(
        accept_copy(&app, &votes, copy(Route::Votes, query, &[], &last)).await,
        204
    );
    observation(&last).await;
    for id in unanswered {
        assert!(
            printed_line(&id).is_none(),
            "a request that is no copy left a line"
        );
    }
    // The vote lane took none of them.
    assert_eq!(votes.in_flight(), 0);
}

/// One case of the reasons test: the route, the copy's query, its extra
/// headers, and the outcome, status and reason its line must carry.
type Case<'a> = (
    Route,
    Option<String>,
    Vec<(&'a str, String)>,
    &'a str,
    u16,
    &'a str,
);

/// Every hand-back a read handler makes without the database, and the one it
/// makes when the database does not answer, each with its reason: one word of
/// the closed set, on a line that holds nothing of the query string, the
/// token or the cookie the copy carried.
#[tokio::test]
async fn each_hand_back_has_its_reason_and_the_line_holds_nothing_of_the_request() {
    let keys = signing();
    let stranger = signing();
    let verified = Arc::new(lanes_app(closed, &Route::ALL, 1000, Some(&keys.public)));
    let unverified = Arc::new(lanes_app(closed, &Route::ALL, 1000, None));
    let mut topical = lanes_app(closed, &Route::ALL, 1000, None);
    topical.next_comment_plain = false;
    let topical = Arc::new(topical);
    let votes = shadow::Lane::new(1000);
    let member = participant(&keys, CODE);
    let elsewhere = participant(&keys, "2another");
    let forged = participant(&stranger, CODE);
    let external = bearer(
        &keys,
        &json!({"uid":41,"xid":XID,"conversation_id":CODE,"sub":"xid:41",
            "iss":"fixture","aud":"fixture","iat":1600000000_u64,"exp":4100000000_u64,
            "xid_participant":true}),
    );
    let account = bearer(
        &keys,
        &json!({"sub":"account|41","iss":"issuer","aud":"audience",
            "iat":1600000000_u64,"exp":4100000000_u64,"email":"fixture@example.invalid"}),
    );
    let base = format!("conversation_id={CODE}");
    let with = |more: &str| Some(format!("{base}&{more}"));
    let auth = |token: &str| vec![("authorization", token.to_owned())];
    let cookie = || vec![("cookie", format!("session={COOKIE}"))];
    let long = "a".repeat(101);
    let cases: Vec<(&Arc<App>, Case)> = vec![
        // ------------------------------------------------- GET /api/v3/votes
        (
            &verified,
            (
                Route::Votes,
                with(&format!("pid={PID}")),
                cookie(),
                "would_hand_back",
                502,
                "cookie",
            ),
        ),
        (
            &verified,
            (
                Route::Votes,
                None,
                vec![],
                "would_hand_back",
                502,
                "no_query",
            ),
        ),
        (
            &verified,
            (
                Route::Votes,
                Some(format!("{base}&pad={}", "a".repeat(4096))),
                vec![],
                "would_hand_back",
                502,
                "query_size",
            ),
        ),
        (
            &verified,
            (
                Route::Votes,
                with("lang=en"),
                vec![],
                "would_hand_back",
                502,
                "query_key",
            ),
        ),
        (
            &verified,
            (
                Route::Votes,
                with(&format!("xid={XID}")),
                vec![],
                "would_hand_back",
                502,
                "xid",
            ),
        ),
        (
            &verified,
            (
                Route::Votes,
                with(&format!("pid={PID}x")),
                vec![],
                "would_hand_back",
                502,
                "param_pid",
            ),
        ),
        (
            &verified,
            (
                Route::Votes,
                with("tid=1.5"),
                vec![],
                "would_hand_back",
                502,
                "param_tid",
            ),
        ),
        (
            &verified,
            (
                Route::Votes,
                with(&format!("pid=3&pid={PID}")),
                vec![],
                "would_hand_back",
                502,
                "query_repeated",
            ),
        ),
        (
            &verified,
            (
                Route::Votes,
                Some(format!("pid={PID}")),
                vec![],
                "would_hand_back",
                502,
                "no_conversation_id",
            ),
        ),
        (
            &verified,
            (
                Route::Votes,
                Some(format!("conversation_id={CODE}-x")),
                vec![],
                "would_hand_back",
                502,
                "shape_conversation_id",
            ),
        ),
        (
            &verified,
            (
                Route::Votes,
                with(&format!("pid={PID}")),
                vec![("content-length", "3".to_owned())],
                "would_hand_back",
                502,
                "shape_body",
            ),
        ),
        (
            &verified,
            (
                Route::Votes,
                with(&format!("pid={PID}")),
                vec![("x-forwarded-proto", "http".to_owned())],
                "would_answer",
                302,
                "not_https",
            ),
        ),
        (
            &verified,
            (
                Route::Votes,
                with(&format!("pid={PID}")),
                vec![("authorization", "Basic abc".to_owned())],
                "would_hand_back",
                502,
                "credential_shape",
            ),
        ),
        (
            &verified,
            (
                Route::Votes,
                with(&format!("pid={PID}")),
                auth(&elsewhere),
                "would_hand_back",
                502,
                "credential_scope",
            ),
        ),
        (
            &verified,
            (
                Route::Votes,
                with(&format!("pid={PID}")),
                auth(&external),
                "would_hand_back",
                502,
                "credential_kind",
            ),
        ),
        (
            &unverified,
            (
                Route::Votes,
                with(&format!("pid={PID}")),
                auth(&member),
                "would_hand_back",
                502,
                "participant_reads_off",
            ),
        ),
        (
            &verified,
            (
                Route::Votes,
                with(&format!("pid={PID}")),
                auth(&forged),
                "would_hand_back",
                502,
                "participant_token",
            ),
        ),
        // A token that verifies, whose lookup the database does not answer:
        // the database's reason, not a refused credential.
        (
            &verified,
            (
                Route::Votes,
                with(&format!("pid={PID}")),
                auth(&member),
                "would_hand_back",
                502,
                "database",
            ),
        ),
        (
            &verified,
            (
                Route::Votes,
                with(&format!("pid={PID}")),
                auth(&account),
                "would_hand_back",
                502,
                "oidc_off",
            ),
        ),
        (
            &verified,
            (
                Route::Votes,
                with(&format!("pid={PID}")),
                vec![],
                "would_hand_back",
                502,
                "database",
            ),
        ),
        // ---------------------------------------------- GET /api/v3/comments
        (
            &verified,
            (
                Route::Comments,
                Some(base.clone()),
                cookie(),
                "would_hand_back",
                502,
                "cookie",
            ),
        ),
        (
            &verified,
            (
                Route::Comments,
                with(&format!("report_id=r{PID}")),
                vec![],
                "would_hand_back",
                502,
                "report_id",
            ),
        ),
        (
            &verified,
            (
                Route::Comments,
                with("moderation=maybe"),
                vec![],
                "would_hand_back",
                502,
                "param_moderation",
            ),
        ),
        (
            &verified,
            (
                Route::Comments,
                with("modIn=maybe"),
                vec![],
                "would_hand_back",
                502,
                "param_mod_in",
            ),
        ),
        (
            &verified,
            (
                Route::Comments,
                with("include_voting_patterns=maybe"),
                vec![],
                "would_hand_back",
                502,
                "param_voting_patterns",
            ),
        ),
        (
            &verified,
            (
                Route::Comments,
                with("mod_gt=x"),
                vec![],
                "would_hand_back",
                502,
                "param_mod_gt",
            ),
        ),
        (
            &verified,
            (
                Route::Comments,
                with("moderation=true&mod_gt=1"),
                vec![],
                "would_hand_back",
                502,
                "moderation_mod_gt",
            ),
        ),
        (
            &verified,
            (
                Route::Comments,
                with(&format!("moderation=true&pid={PID}")),
                vec![],
                "would_hand_back",
                502,
                "moderation_pid",
            ),
        ),
        (
            &verified,
            (
                Route::Comments,
                with(&format!("pid=x{PID}")),
                vec![],
                "would_hand_back",
                502,
                "param_pid",
            ),
        ),
        (
            &verified,
            (
                Route::Comments,
                Some(format!("pid={PID}")),
                vec![],
                "would_hand_back",
                502,
                "no_conversation_id",
            ),
        ),
        (
            &verified,
            (
                Route::Comments,
                Some(format!("conversation_id={long}")),
                vec![],
                "would_hand_back",
                502,
                "shape_conversation_id",
            ),
        ),
        (
            &verified,
            (
                Route::Comments,
                with("mod=x"),
                vec![],
                "would_hand_back",
                502,
                "param_mod",
            ),
        ),
        (
            &verified,
            (
                Route::Comments,
                with("limit=x"),
                vec![],
                "would_hand_back",
                502,
                "param_limit",
            ),
        ),
        (
            &verified,
            (
                Route::Comments,
                with("offset=x"),
                vec![],
                "would_hand_back",
                502,
                "param_offset",
            ),
        ),
        (
            &verified,
            (
                Route::Comments,
                with("offset=-2"),
                vec![],
                "would_hand_back",
                502,
                "negative_offset",
            ),
        ),
        (
            &verified,
            (
                Route::Comments,
                with(&format!("pid={PID}")),
                auth(&member),
                "would_hand_back",
                502,
                "identity_parameter",
            ),
        ),
        (
            &verified,
            (
                Route::Comments,
                with(&format!("moderation=true&xid={XID}")),
                auth(&member),
                "would_hand_back",
                502,
                "moderation_key",
            ),
        ),
        (
            &unverified,
            (
                Route::Comments,
                Some(base.clone()),
                auth(&member),
                "would_hand_back",
                502,
                "participant_reads_off",
            ),
        ),
        (
            &verified,
            (
                Route::Comments,
                Some(base.clone()),
                auth(&forged),
                "would_hand_back",
                502,
                "participant_token",
            ),
        ),
        (
            &verified,
            (
                Route::Comments,
                Some(base.clone()),
                auth(&member),
                "would_hand_back",
                502,
                "database",
            ),
        ),
        (
            &verified,
            (
                Route::Comments,
                Some(base.clone()),
                auth(&account),
                "would_hand_back",
                502,
                "oidc_off",
            ),
        ),
        (
            &verified,
            (
                Route::Comments,
                Some(base.clone()),
                vec![("x-forwarded-proto", "http".to_owned())],
                "would_answer",
                302,
                "not_https",
            ),
        ),
        (
            &verified,
            (
                Route::Comments,
                with(&format!("pid={PID}&xid={XID}")),
                vec![],
                "would_hand_back",
                502,
                "database",
            ),
        ),
        // ------------------------------------------- GET /api/v3/nextComment
        (
            &verified,
            (
                Route::NextComment,
                with("lang=en"),
                vec![],
                "would_hand_back",
                502,
                "lang",
            ),
        ),
        (
            &verified,
            (
                Route::NextComment,
                with(&format!("not_voted_by_pid={PID}")),
                vec![],
                "would_hand_back",
                502,
                "pid_parameter",
            ),
        ),
        (
            &verified,
            (
                Route::NextComment,
                with(&format!("pid={PID}&lang=en")),
                vec![],
                "would_hand_back",
                502,
                "lang_and_pid",
            ),
        ),
        (
            &verified,
            (
                Route::NextComment,
                with(&format!("lang=en&xid={XID}&pid={PID}")),
                vec![],
                "would_hand_back",
                502,
                "xid",
            ),
        ),
        (
            &verified,
            (
                Route::NextComment,
                with(&format!("lang=en&other={PID}")),
                vec![],
                "would_hand_back",
                502,
                "query_key",
            ),
        ),
        (
            &verified,
            (
                Route::NextComment,
                Some(base.clone()),
                cookie(),
                "would_hand_back",
                502,
                "cookie",
            ),
        ),
        (
            &verified,
            (
                Route::NextComment,
                Some(base.clone()),
                vec![("content-length", "0".to_owned())],
                "would_hand_back",
                502,
                "shape_body",
            ),
        ),
        (
            &verified,
            (
                Route::NextComment,
                Some("without=1".to_owned()),
                vec![],
                "would_hand_back",
                502,
                "no_conversation_id",
            ),
        ),
        (
            &verified,
            (
                Route::NextComment,
                Some(format!("conversation_id={long}")),
                vec![],
                "would_hand_back",
                502,
                "shape_conversation_id",
            ),
        ),
        (
            &verified,
            (
                Route::NextComment,
                with("initial_tid=x"),
                vec![],
                "would_hand_back",
                502,
                "param_initial_tid",
            ),
        ),
        (
            &topical,
            (
                Route::NextComment,
                Some(base.clone()),
                vec![],
                "would_hand_back",
                502,
                "plain_off",
            ),
        ),
        (
            &unverified,
            (
                Route::NextComment,
                Some(base.clone()),
                auth(&member),
                "would_hand_back",
                502,
                "participant_reads_off",
            ),
        ),
        (
            &verified,
            (
                Route::NextComment,
                Some(base.clone()),
                auth(&forged),
                "would_hand_back",
                502,
                "token_refused",
            ),
        ),
        // A token the verifier cannot place is classed by its kind: the share
        // of each is what the line is for.
        (
            &verified,
            (
                Route::NextComment,
                Some(base.clone()),
                auth(&external),
                "would_hand_back",
                502,
                "credential_kind",
            ),
        ),
        (
            &verified,
            (
                Route::NextComment,
                Some(base.clone()),
                auth(&account),
                "would_hand_back",
                502,
                "account_token",
            ),
        ),
        (
            &verified,
            (
                Route::NextComment,
                Some(base.clone()),
                auth(&elsewhere),
                "would_hand_back",
                502,
                "credential_scope",
            ),
        ),
        (
            &verified,
            (
                Route::NextComment,
                Some(base.clone()),
                vec![("authorization", "Basic abc".to_owned())],
                "would_hand_back",
                502,
                "credential_shape",
            ),
        ),
        (
            &verified,
            (
                Route::NextComment,
                Some(base.clone()),
                vec![("x-forwarded-proto", "http".to_owned())],
                "would_answer",
                302,
                "not_https",
            ),
        ),
        (
            &verified,
            (
                Route::NextComment,
                Some(base.clone()),
                vec![],
                "would_hand_back",
                502,
                "database",
            ),
        ),
    ];
    let mut seen = std::collections::BTreeSet::new();
    for (app, (route, query, extra, outcome, status, reason)) in &cases {
        let id = request_id();
        let extra: Vec<(&str, &str)> = extra.iter().map(|(k, v)| (*k, v.as_str())).collect();
        let req = copy(*route, query.as_deref(), &extra, &id);
        assert_eq!(accept_copy(app, &votes, req).await, 204);
        let line = observation(&id).await;
        let case = format!("{} {query:?} {reason}", route.name());
        assert_eq!(line["shadow"], route.selector(), "{case}");
        assert_eq!(line["outcome"], *outcome, "{case}: {line}");
        assert_eq!(line["status"], *status, "{case}: {line}");
        assert_eq!(line["reason"], *reason, "{case}: {line}");
        assert_eq!(line["request_id"], id);
        // Without the database nothing reads a conversation, a row or a draw.
        for key in [
            "zid",
            "rows",
            "selected",
            "remaining",
            "total",
            "weights_tick",
        ] {
            assert!(line[key].is_null(), "{key}: {line}");
        }
        assert_eq!(
            line["db_ms"].is_number(),
            *reason == "database",
            "{case}: {line}"
        );
        assert!(REASONS.contains(reason));
        seen.insert(*reason);
    }
    assert_eq!(seen.len(), 39, "the reasons these cases exercise");
    // A request id that is not 32 lowercase hex is recorded as null.
    let odd = copy(
        Route::Votes,
        Some(&base),
        &[("x-request-id", "0123456789ABCDEF0123456789ABCDEF")],
        "unused",
    );
    assert_eq!(accept_copy(&verified, &votes, odd).await, 204);
    let last = request_id();
    assert_eq!(
        accept_copy(&verified, &votes, copy(Route::Votes, None, &[], &last)).await,
        204
    );
    observation(&last).await;
    // Everything the read lanes printed in this process, and everything the
    // listener printed beside it (its access lines, its events).
    for printed in recorded() {
        assert_line_shape(&printed);
    }
    let mut access_lines = 0;
    for printed in shadow::recorded() {
        for secret in [CODE, PID, XID, COOKIE, "eyJ", "Bearer"] {
            assert!(!printed.contains(secret), "{printed}");
        }
        if printed.contains("\"message\":\"http_request\"")
            && Route::ALL
                .iter()
                .any(|route| printed.contains(&format!("\"url\":\"{}\"", route.path())))
        {
            assert!(!printed.contains('?'), "{printed}");
            access_lines += 1;
        }
    }
    assert!(
        access_lines >= cases.len(),
        "the listener's own access lines"
    );
    assert_eq!(votes.in_flight(), 0);
}

/// A lane has its own bound on copies observed at once and its own rate
/// bucket: copies beyond either are shed with their own line and still
/// answered 204, and the other lanes take the same copies meanwhile.
#[tokio::test]
async fn a_read_lane_sheds_by_count_and_by_rate_and_only_itself() {
    let app = Arc::new(lanes_app(closed, &Route::ALL, 1000, None));
    let votes = shadow::Lane::new(1000);
    let query = Some("conversation_id=2abc");
    let full = app.read_lanes.get(Route::Votes).unwrap();
    let parked = full.park().await;
    let mut held = vec![];
    for _ in 0..CAPACITY {
        let id = request_id();
        assert_eq!(
            accept_copy(&app, &votes, copy(Route::Votes, query, &[], &id)).await,
            204
        );
        held.push(id);
    }
    assert_eq!(full.in_flight(), CAPACITY);
    let over = request_id();
    assert_eq!(
        accept_copy(&app, &votes, copy(Route::Votes, query, &[], &over)).await,
        204
    );
    let printed = printed_line(&over).expect("a shed copy is recorded at once");
    assert_line_shape(&printed);
    let line: Value = serde_json::from_str(&printed).unwrap();
    assert_eq!(line["outcome"], "shed");
    assert_eq!(line["reason"], "lane_full");
    assert!(line["status"].is_null() && line["handler_ms"].is_null());
    // The other two lanes are not full: each observes its copy to the end
    // while every slot of this one is held.
    for route in [Route::Comments, Route::NextComment] {
        let id = request_id();
        assert_eq!(
            accept_copy(&app, &votes, copy(route, query, &[], &id)).await,
            204
        );
        let line = observation(&id).await;
        assert_eq!(line["outcome"], "would_hand_back", "{line}");
        assert_eq!(line["reason"], "database", "{line}");
    }
    for id in &held {
        assert!(printed_line(id).is_none(), "a parked copy was observed");
    }
    drop(parked);
    for id in &held {
        assert_eq!(observation(id).await["reason"], "database");
    }
    assert_eq!(full.in_flight(), 0);
    // The rate: one copy a second on each lane of another process. The copy
    // after the first is shed.
    let slow = Arc::new(lanes_app(closed, &Route::ALL, 1, None));
    for route in Route::ALL {
        let lane = slow.read_lanes.get(route).unwrap();
        let parked = lane.park().await;
        let passed = request_id();
        assert_eq!(
            accept_copy(&slow, &votes, copy(route, query, &[], &passed)).await,
            204
        );
        let id = request_id();
        assert_eq!(
            accept_copy(&slow, &votes, copy(route, query, &[], &id)).await,
            204
        );
        let line: Value = serde_json::from_str(&printed_line(&id).unwrap()).unwrap();
        assert_eq!(line["outcome"], "shed", "{}", route.name());
        assert_eq!(line["reason"], "rate_cap");
        drop(parked);
        observation(&passed).await;
    }
    let health = health_of(&slow, &votes).await;
    for route in Route::ALL {
        let lane = &health[route.health_key()];
        assert_eq!(lane["shed"], 1, "{}", route.name());
        assert_eq!(lane["observed"], 1);
        assert_eq!(lane["wouldHandBack"], 1);
    }
    assert_eq!(votes.in_flight(), 0);
}

async fn health_of(app: &Arc<App>, votes: &Arc<shadow::Lane>) -> Value {
    let out = shadow::health(app, votes).await;
    let crate::http::Body::Fixed(bytes) = out.body else {
        panic!("fixed JSON expected")
    };
    serde_json::from_slice(&bytes).unwrap()
}

/// `/health` with read lanes built: one key for each, after the observers'
/// and before the listener's, with the lane's counters, its bound, its rate
/// and its pools by name. Every key that was there keeps its place and its
/// value.
#[tokio::test]
async fn health_reports_each_read_lane_under_its_own_key() {
    let votes = shadow::Lane::new(8);
    let none = Arc::new(lanes_app(closed, &[], 4, None));
    let all = Arc::new(lanes_app(closed, &Route::ALL, 4, None));
    let body = |app: Arc<App>| {
        let votes = votes.clone();
        async move {
            let out = shadow::health(&app, &votes).await;
            let crate::http::Body::Fixed(bytes) = out.body else {
                panic!("fixed JSON expected")
            };
            (out.status, String::from_utf8(bytes).unwrap())
        }
    };
    let (status_none, without) = body(none.clone()).await;
    let (status_all, with) = body(all.clone()).await;
    assert_eq!(
        printed_keys(&without),
        ["role", "status", "version", "commit", "postVotes", "shadow"]
    );
    assert_eq!(
        printed_keys(&with),
        [
            "role",
            "status",
            "version",
            "commit",
            "postVotes",
            "getVotes",
            "getComments",
            "getNextComment",
            "shadow"
        ]
    );
    // No lane has been asked for its database yet: the status is what it is
    // without them, and the first part of the body is the same bytes.
    assert_eq!((status_none, status_all), (200, 200));
    let cut = |body: &str, key: &str| body[..body.find(&format!("\"{key}\":")).unwrap()].to_owned();
    assert_eq!(cut(&without, "shadow"), cut(&with, "getVotes"));
    let tail = |body: &str| body[body.find("\"shadow\":").unwrap()..].to_owned();
    assert_eq!(tail(&without), tail(&with));
    let health: Value = serde_json::from_str(&with).unwrap();
    for (route, pools) in [
        (
            Route::Votes,
            vec![("reads", 1, 15, 50), ("auth", 1, 15, 50)],
        ),
        (
            Route::Comments,
            vec![("reads", 2, 100, 1000), ("count", 1, 100, 1000)],
        ),
        (Route::NextComment, vec![("reads", 2, 1, 50)]),
    ] {
        let lane = &health[route.health_key()];
        assert_eq!(
            printed_keys(printed_object(&with, route.health_key())),
            [
                "enabled",
                "mode",
                "selector",
                "observed",
                "wouldServe",
                "wouldAnswer",
                "wouldHandBack",
                "wouldFail",
                "shed",
                "inFlight",
                "capacity",
                "maxPerSecond",
                "pools"
            ]
        );
        assert_eq!(lane["enabled"], false);
        assert_eq!(lane["mode"], "observe");
        assert_eq!(lane["selector"], route.selector());
        assert_eq!(lane["capacity"], CAPACITY);
        assert_eq!(lane["maxPerSecond"], 4);
        let names: Vec<String> = printed_keys(printed_object(
            printed_object(&with, route.health_key()),
            "pools",
        ));
        assert_eq!(
            names,
            pools.iter().map(|(name, ..)| *name).collect::<Vec<_>>()
        );
        for (name, limit, acquire, statement) in pools {
            let pool = &lane["pools"][name];
            assert_eq!(pool["readOnly"], true, "{name}");
            assert_eq!(pool["reachable"], true, "{name}");
            assert_eq!(pool["limit"], limit, "{name}");
            assert_eq!(pool["available"], limit, "{name}");
            assert_eq!(pool["acquireTimeoutMs"], acquire, "{name}");
            assert_eq!(pool["statementTimeoutMs"], statement, "{name}");
        }
    }
    // A lane's database that does not answer its startup probe, or a copy,
    // degrades the status; `/health` itself never asks a lane's pool.
    let lane = all.read_lanes.get(Route::NextComment).unwrap();
    assert!(!lane.probe().await);
    let (status, degraded) = body(all.clone()).await;
    assert_eq!(status, 503);
    let degraded: Value = serde_json::from_str(&degraded).unwrap();
    assert_eq!(degraded["status"], "degraded");
    assert_eq!(
        degraded["getNextComment"]["pools"]["reads"]["reachable"],
        false
    );
    assert_eq!(degraded["getVotes"]["pools"]["reads"]["reachable"], true);
    // Then the copies say: one connection or statement that fails does not
    // mean the database is gone; UNREACHABLE of them in a row do.
    let comments = all.read_lanes.get(Route::Comments).unwrap();
    for n in 1..=UNREACHABLE {
        let id = request_id();
        let req = copy(Route::Comments, Some("conversation_id=2abc"), &[], &id);
        assert_eq!(accept_copy(&all, &votes, req).await, 204);
        assert_eq!(observation(&id).await["reason"], "database");
        assert_eq!(comments.reachable(), n < UNREACHABLE, "after {n}");
    }
}

/// The lanes' pools are each lane's own: no pool is shared between two
/// lanes, with the process's general pool, or held twice.
#[test]
fn every_lane_holds_its_own_pools() {
    let app = lanes_app(closed, &Route::ALL, 4, None);
    let mut seen: Vec<*const db::Pool> = vec![Arc::as_ptr(&app.db)];
    let mut count = 0;
    for lane in app.read_lanes.built() {
        for (_, pool) in lane.pools() {
            let pointer = Arc::as_ptr(pool);
            assert!(!seen.contains(&pointer), "a pool is held twice");
            seen.push(pointer);
            count += 1;
        }
    }
    assert_eq!(count, 5);
    // They are the pools the handlers read from, and no other.
    let handlers = [
        &app.votes_read_db,
        &app.votes_read_auth_db,
        &app.comments_db,
        &app.comments_count_db,
        &app.next_comment_db,
    ];
    for pool in handlers {
        assert!(seen.contains(&Arc::as_ptr(pool.as_ref().unwrap())));
    }
}

// ---------------------------------------------------------------- startup

const STARTUP_CHILD: &str = "POLIS_READ_LANES_STARTUP_TEST";

fn describe_startup() -> String {
    let pools = db::POOLS_BUILT.load(Ordering::SeqCst);
    let writers = db::WRITER_POOLS_BUILT.load(Ordering::SeqCst);
    let built = match shadow::configure() {
        Ok(configured) => {
            let app = &configured.app;
            let lanes = app
                .read_lanes
                .built()
                .map(|lane| {
                    let health: Value =
                        serde_json::from_str(&js::stringify(&health(lane))).unwrap();
                    let pools = lane
                        .pools()
                        .iter()
                        .map(|(name, _)| {
                            let pool = &health["pools"][*name];
                            format!(
                                "{name}:{}:{}:{}:{}",
                                pool["readOnly"],
                                pool["limit"],
                                pool["acquireTimeoutMs"],
                                pool["statementTimeoutMs"]
                            )
                        })
                        .collect::<Vec<_>>()
                        .join(",");
                    format!(
                        "{}@{}[{pools}]",
                        lane.route.selector(),
                        health["maxPerSecond"]
                    )
                })
                .collect::<Vec<_>>()
                .join(" ");
            format!(
                "lanes={lanes} tokens={} oidc={} plain={} votes={} comments={}",
                app.participant_verifier.is_some(),
                app.read_oidc.is_some(),
                app.next_comment_plain,
                app.post_votes_observe.is_some(),
                app.post_comments_observe.is_some(),
            )
        }
        Err(error) => format!("error: {error:#}"),
    };
    format!(
        "{built} pools={} writers={}",
        db::POOLS_BUILT.load(Ordering::SeqCst) - pools,
        db::WRITER_POOLS_BUILT.load(Ordering::SeqCst) - writers
    )
}

/// The switch values, each in a process of its own: only the word `observe`
/// on a read handler's own switch builds its lane, with the pools the main
/// role builds for that handler, read-only, and no writer pool; the lane's
/// rate and its database are required; and participant tokens are verified
/// only when the participant-read switch says `observe` too.
#[test]
fn only_the_word_observe_builds_a_read_lane_and_what_it_builds() {
    if std::env::var_os(STARTUP_CHILD).is_some() {
        println!("STARTUP {}", describe_startup());
        return;
    }
    let rsa = openssl::rsa::Rsa::generate(2048).unwrap();
    let pem = String::from_utf8(rsa.public_key_to_pem().unwrap()).unwrap();
    let url = "postgres://postgres@127.0.0.1:9/postgres";
    let base: Vec<(&str, &str)> = vec![
        ("POLIS_API_ROLE", "shadow"),
        ("POLIS_API_SHADOW_LISTEN", "127.0.0.1:0"),
        ("POLIS_API_SHADOW_MAX_PER_SECOND", "8"),
        ("POLIS_API_DATABASE_URL", url),
        ("DATABASE_URL", url),
        ("POLIS_API_DB_TRANSPORT", "loopback"),
        ("MATH_ENV", "prod"),
        ("NODE_ENV", "production"),
        ("JWT_PUBLIC_KEY", pem.as_str()),
        ("POLIS_JWT_ISSUER", "fixture"),
        ("POLIS_JWT_AUDIENCE", "fixture"),
        ("TOPICAL_COMMENT_RATIO", "0"),
        ("POLIS_API_VOTES_READ_DATABASE_URL", url),
        ("POLIS_API_COMMENTS_DATABASE_URL", url),
        ("POLIS_API_NEXT_COMMENT_DATABASE_URL", url),
        ("POLIS_API_SHADOW_VOTES_READ_MAX_PER_SECOND", "4"),
        ("POLIS_API_SHADOW_COMMENTS_READ_MAX_PER_SECOND", "3"),
        ("POLIS_API_SHADOW_NEXT_COMMENT_MAX_PER_SECOND", "2"),
    ];
    let run = |changes: &[(&str, Option<&str>)]| {
        let mut env = base.clone();
        for (name, value) in changes {
            env.retain(|(existing, _)| existing != name);
            if let Some(value) = value {
                env.push((name, value));
            }
        }
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "shadow::reads::read_tests::only_the_word_observe_builds_a_read_lane_and_what_it_builds",
                "--nocapture",
            ])
            .env_clear()
            .env(STARTUP_CHILD, "1")
            .envs(env)
            .output()
            .unwrap();
        let printed = String::from_utf8_lossy(&output.stdout).into_owned();
        assert!(
            output.status.success(),
            "{changes:?}: {printed}{}",
            String::from_utf8_lossy(&output.stderr)
        );
        printed
            .lines()
            .find_map(|line| {
                line.split_once("STARTUP ")
                    .map(|(_, result)| result.to_owned())
            })
            .unwrap_or_else(|| panic!("{changes:?}: no result: {printed}"))
    };
    let switches = [
        "POLIS_API_VOTES_READS",
        "POLIS_API_COMMENT_READS",
        "POLIS_API_NEXT_COMMENT_READS",
        "POLIS_API_PARTICIPANT_READS",
    ];
    // Nothing but the process's general pool, whatever else the switches
    // hold: the value the main role reads, and words that are not the word.
    let nothing =
        "lanes= tokens=false oidc=false plain=false votes=false comments=false pools=1 writers=0";
    for value in [
        None,
        Some(""),
        Some("0"),
        Some("1"),
        Some("true"),
        Some("OBSERVE"),
        Some("observed"),
        Some(" observe"),
    ] {
        let changes: Vec<(&str, Option<&str>)> =
            switches.iter().map(|switch| (*switch, value)).collect();
        assert_eq!(run(&changes), nothing, "{value:?}");
    }
    // The participant-read switch alone builds nothing either.
    assert_eq!(
        run(&[("POLIS_API_PARTICIPANT_READS", Some("observe"))]),
        nothing
    );
    // Each lane alone.
    let votes = "votesReadShadow@4[reads:true:1:15:50,auth:true:1:15:50]";
    let comments = "commentsReadShadow@3[reads:true:2:100:1000,count:true:1:100:1000]";
    let next = "nextCommentShadow@2[reads:true:2:1:50]";
    for (switch, lane, pools, plain) in [
        ("POLIS_API_VOTES_READS", votes, 3, false),
        ("POLIS_API_COMMENT_READS", comments, 3, false),
        ("POLIS_API_NEXT_COMMENT_READS", next, 2, true),
    ] {
        assert_eq!(
            run(&[(switch, Some("observe"))]),
            format!(
                "lanes={lane} tokens=false oidc=false plain={plain} votes=false comments=false pools={pools} writers=0"
            ),
            "{switch}"
        );
    }
    // All three, with participant tokens verified.
    let all: Vec<(&str, Option<&str>)> = switches
        .iter()
        .map(|switch| (*switch, Some("observe")))
        .collect();
    assert_eq!(
        run(&all),
        format!(
            "lanes={votes} {comments} {next} tokens=true oidc=false plain=true votes=false comments=false pools=6 writers=0"
        )
    );
    // Ordinary selection is not assumed: the shared setting must say so.
    let mut topical = all.clone();
    topical.push(("TOPICAL_COMMENT_RATIO", None));
    assert!(run(&topical).contains(" plain=false "));
    // What a lane requires, each named when it is missing or out of range.
    for (switch, setting, value) in [
        (
            "POLIS_API_VOTES_READS",
            "POLIS_API_SHADOW_VOTES_READ_MAX_PER_SECOND",
            None,
        ),
        (
            "POLIS_API_VOTES_READS",
            "POLIS_API_SHADOW_VOTES_READ_MAX_PER_SECOND",
            Some("0"),
        ),
        (
            "POLIS_API_VOTES_READS",
            "POLIS_API_SHADOW_VOTES_READ_MAX_PER_SECOND",
            Some("10001"),
        ),
        (
            "POLIS_API_VOTES_READS",
            "POLIS_API_VOTES_READ_DATABASE_URL",
            None,
        ),
        (
            "POLIS_API_COMMENT_READS",
            "POLIS_API_SHADOW_COMMENTS_READ_MAX_PER_SECOND",
            None,
        ),
        (
            "POLIS_API_COMMENT_READS",
            "POLIS_API_COMMENTS_DATABASE_URL",
            Some(""),
        ),
        (
            "POLIS_API_NEXT_COMMENT_READS",
            "POLIS_API_SHADOW_NEXT_COMMENT_MAX_PER_SECOND",
            Some("many"),
        ),
        (
            "POLIS_API_NEXT_COMMENT_READS",
            "POLIS_API_NEXT_COMMENT_DATABASE_URL",
            None,
        ),
    ] {
        let result = run(&[(switch, Some("observe")), (setting, value)]);
        assert!(
            result.starts_with("error: ") && result.contains(setting) && result.contains(switch),
            "{switch} {setting} {value:?}: {result}"
        );
        assert!(result.ends_with("writers=0"), "{result}");
    }
    // Participant tokens need the participant key and its issuer.
    for missing in ["JWT_PUBLIC_KEY", "POLIS_JWT_ISSUER", "POLIS_JWT_AUDIENCE"] {
        let mut changes = all.clone();
        changes.push((missing, None));
        let result = run(&changes);
        assert!(
            result.starts_with("error: ") && result.contains("POLIS_API_PARTICIPANT_READS"),
            "{missing}: {result}"
        );
    }
    // Beside the vote observer the lanes change nothing of it.
    let mut beside = all.clone();
    beside.extend([
        ("POLIS_API_POST_VOTES", Some("observe")),
        ("POLIS_API_POST_VOTES_DATABASE_URL", Some(url)),
        ("SHOULD_USE_TRANSLATION_API", Some("false")),
    ]);
    assert_eq!(
        run(&beside),
        format!(
            "lanes={votes} {comments} {next} tokens=true oidc=false plain=true votes=true comments=false pools=8 writers=0"
        )
    );
}

// ------------------------------------------------ what the process prints

const OUTPUT_CHILD: &str = "POLIS_READ_LANES_OUTPUT_TEST";

/// The child of the output test: the shadow role's own startup and listener,
/// with the three lanes built from the environment, answering copies sent
/// over a socket.
async fn serve_copies_as_the_process_does() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let configured = shadow::configure().unwrap();
    shadow::install_panic_hook();
    report_startup(&configured.app).await;
    let app = Arc::new(configured.app);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(shadow::serve(
        listener,
        app.clone(),
        configured.lane.clone(),
    ));
    let token = std::env::var("FIXTURE_TOKEN").unwrap();
    let mut sent = 0_u64;
    for route in Route::ALL {
        for query in [
            format!("conversation_id={CODE}&pid={PID}"),
            format!("conversation_id={CODE}&xid={XID}&lang=en"),
            format!("conversation_id={CODE}&not_voted_by_pid={PID}&without={PID}"),
            format!("pid={PID}&xid={XID}"),
        ] {
            for authorization in [None, Some(token.as_str())] {
                for cookie in [false, true] {
                    let mut head = format!(
                        "GET {}?{query} HTTP/1.1\r\nHost: localhost\r\nX-Forwarded-Proto: https\r\nX-Request-Id: {}\r\nX-Polis-Shadow: {}\r\nConnection: close\r\n",
                        route.path(),
                        request_id(),
                        route.selector()
                    );
                    if let Some(authorization) = authorization {
                        head.push_str(&format!("Authorization: {authorization}\r\n"));
                    }
                    if cookie {
                        head.push_str(&format!("Cookie: session={COOKIE}\r\n"));
                    }
                    head.push_str("\r\n");
                    let mut client = tokio::net::TcpStream::connect(address).await.unwrap();
                    client.write_all(head.as_bytes()).await.unwrap();
                    let mut response = Vec::new();
                    client.read_to_end(&mut response).await.unwrap();
                    assert!(
                        response.starts_with(b"HTTP/1.1 204 "),
                        "{}",
                        String::from_utf8_lossy(&response)
                    );
                    sent += 1;
                }
            }
        }
    }
    // Every copy has ended: printed its line, or panicked where it was told
    // to, when no lane holds one any more.
    let panicking = std::env::var_os(PANIC_IN_OBSERVATION).is_some();
    tokio::time::timeout(Duration::from_secs(60), async {
        loop {
            let ended = if panicking {
                shadow::recorded()
                    .iter()
                    .filter(|line| line.contains("\"shadow_panic\""))
                    .count() as u64
            } else {
                recorded().len() as u64
            };
            if ended >= sent && app.read_lanes.built().all(|lane| lane.in_flight() == 0) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    })
    .await
    .expect("every copy ends");
    server.abort();
    println!("OUTPUT-DONE sent={sent}");
}

/// Everything the process prints for copies of reads, on both streams, as a
/// log collector would read it: a child process runs the shadow role's own
/// startup and listener with the three lanes built, and is sent copies over
/// a socket whose query strings, tokens and cookies hold values nothing else
/// could. No byte of them is in what it printed. Once more with every
/// observation panicking with its copy's request line as the message: the
/// panic hook prints where, and nothing of the message.
#[test]
fn nothing_the_process_prints_holds_a_query_string_a_token_or_a_cookie() {
    if std::env::var_os(OUTPUT_CHILD).is_some() {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap()
            .block_on(serve_copies_as_the_process_does());
        return;
    }
    let keys = signing();
    let pem = String::from_utf8(keys.public.clone()).unwrap();
    let token = participant(&keys, CODE);
    let url = "postgres://postgres@127.0.0.1:9/postgres";
    for panicking in [false, true] {
        let mut command = std::process::Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "shadow::reads::read_tests::nothing_the_process_prints_holds_a_query_string_a_token_or_a_cookie",
                "--nocapture",
            ])
            .env_clear()
            .env(OUTPUT_CHILD, "1")
            .envs([
                ("POLIS_API_ROLE", "shadow"),
                ("POLIS_API_SHADOW_LISTEN", "127.0.0.1:0"),
                ("POLIS_API_SHADOW_MAX_PER_SECOND", "8"),
                ("POLIS_API_DATABASE_URL", url),
                ("DATABASE_URL", url),
                ("POLIS_API_DB_TRANSPORT", "loopback"),
                ("MATH_ENV", "prod"),
                ("NODE_ENV", "production"),
                ("JWT_PUBLIC_KEY", pem.as_str()),
                ("POLIS_JWT_ISSUER", "fixture"),
                ("POLIS_JWT_AUDIENCE", "fixture"),
                ("TOPICAL_COMMENT_RATIO", "0"),
                ("POLIS_API_VOTES_READS", "observe"),
                ("POLIS_API_COMMENT_READS", "observe"),
                ("POLIS_API_NEXT_COMMENT_READS", "observe"),
                ("POLIS_API_PARTICIPANT_READS", "observe"),
                ("POLIS_API_VOTES_READ_DATABASE_URL", url),
                ("POLIS_API_COMMENTS_DATABASE_URL", url),
                ("POLIS_API_NEXT_COMMENT_DATABASE_URL", url),
                ("POLIS_API_SHADOW_VOTES_READ_MAX_PER_SECOND", "1000"),
                ("POLIS_API_SHADOW_COMMENTS_READ_MAX_PER_SECOND", "1000"),
                ("POLIS_API_SHADOW_NEXT_COMMENT_MAX_PER_SECOND", "1000"),
                ("FIXTURE_TOKEN", token.as_str()),
            ]);
        if panicking {
            command.env(PANIC_IN_OBSERVATION, "1");
        }
        let output = command.output().unwrap();
        let printed = format!(
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(output.status.success(), "{printed}");
        assert!(printed.contains("OUTPUT-DONE sent=48"), "{printed}");
        // The whole of both streams.
        let bare = token.trim_start_matches("Bearer ");
        for secret in [
            CODE,
            PID,
            XID,
            COOKIE,
            bare,
            "eyJ",
            "Bearer",
            "conversation_id=",
        ] {
            assert!(
                !printed.contains(secret),
                "{secret} was printed (panicking: {panicking})"
            );
        }
        // Every line the process itself printed is one of three kinds, each
        // marked as the shadow's.
        let (mut observations, mut access, mut panics, mut lanes) = (0, 0, 0, 0);
        for line in printed.lines().filter(|line| line.starts_with('{')) {
            let value: Value = serde_json::from_str(line).unwrap_or_else(|_| panic!("{line}"));
            if value["message"] == "shadow_observation" {
                assert_line_shape(line);
                observations += 1;
            } else if value["message"] == "http_request" {
                assert_eq!(value["listener"], "shadow");
                assert_eq!(
                    printed_keys(printed_object(line, "http")),
                    ["method", "url", "route", "status_code"]
                );
                assert!(
                    Route::ALL
                        .iter()
                        .any(|route| value["http"]["url"] == route.path()),
                    "{line}"
                );
                assert_eq!(value["http"]["url"], value["http"]["route"]);
                access += 1;
            } else {
                let event = value["event"].as_str().unwrap_or_else(|| panic!("{line}"));
                assert!(event.starts_with("shadow_"), "{line}");
                assert_eq!(value["listener"], "shadow");
                match event {
                    "shadow_panic" => {
                        assert_eq!(
                            printed_keys(line),
                            ["event", "listener", "service", "location"]
                        );
                        assert!(
                            value["location"]
                                .as_str()
                                .is_some_and(|at| at.contains("shadow_reads_tests.rs:")),
                            "{line}"
                        );
                        panics += 1;
                    }
                    "shadow_read_lane" => {
                        assert_eq!(
                            printed_keys(line),
                            [
                                "event",
                                "listener",
                                "service",
                                "shadow",
                                "route",
                                "max_per_second",
                                "capacity",
                                "database",
                                "participant_tokens"
                            ]
                        );
                        assert_eq!(value["database"], "failed");
                        assert_eq!(value["participant_tokens"], "verified");
                        lanes += 1;
                    }
                    other => panic!("an event this test does not know: {other}"),
                }
            }
        }
        assert_eq!(access, 48, "{printed}");
        assert_eq!(lanes, 3, "{printed}");
        if panicking {
            assert_eq!((observations, panics), (0, 48), "{printed}");
            assert!(!printed.contains("forced panic"), "{printed}");
        } else {
            assert_eq!((observations, panics), (48, 0), "{printed}");
        }
    }
}

/// Outside an observation, which is every live request, a hand-back with a
/// reason is `route::bad_gateway()` in every field: the status, the headers,
/// the body and whether the connection stays open.
#[test]
fn a_live_hand_back_is_the_bad_gateway_answer_in_every_field() {
    assert!(!observing());
    let (answer, bare) = (handback("cookie"), route::bad_gateway());
    assert_eq!(answer.status, 502);
    assert_eq!(answer.status, bare.status);
    assert_eq!(answer.headers, bare.headers);
    assert_eq!(answer.close, bare.close);
    let (crate::http::Body::Fixed(answer), crate::http::Body::Fixed(bare)) =
        (answer.body, bare.body)
    else {
        panic!("a fixed body expected")
    };
    assert_eq!(answer, bare);
}

#[cfg(feature = "db-tests")]
#[path = "shadow_reads_database_tests.rs"]
mod database;
