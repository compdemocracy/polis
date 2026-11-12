//! Observe mode for comments, and its line. The comment handler's admission
//! runs on a copy of a comment Node is answering: it reaches the decision the
//! live handler would, writes nothing, reads back what Node stored, and one
//! line is printed for the copy.
//!
//! Where a test needs a comment and its author's vote stored the way Node
//! stores them, the live handler stores them: its write is the sign-aware
//! path. No vote value, text, participant, comment or conversation number is
//! ever on a line.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::string_slice
)]
use super::*;
use crate::post_comments::tests::{MARKER, leaks};
use crate::post_comments_decision::Existing;
use crate::post_comments_text::{Compared, TextDifference};
use crate::shadow;
use crate::votes::StorageConvention;
use polis_queue_adapter::jobs::transport::Connector;
use serde_json::{Value, json};

const CID: &str = "2p027generated";
/// The participant number the jQuery participation client puts in every
/// request body: "not known".
const NO_PID: i32 = -1;

/// The observation line's complete key set, in the order it is printed. No
/// key names a conversation, a comment, a participant or a user, and none
/// holds text.
pub(crate) const LINE_KEYS: &[&str] = &[
    "message",
    "listener",
    "service",
    "env",
    "shadow",
    "route",
    "request_id",
    "outcome",
    "admitted",
    "status",
    "reason",
    "queue_ms",
    "admission_ms",
    "total_ms",
    "readback_s",
    "strict",
    "vote_present",
    "seed_present",
    "body_class",
    "write",
    "text_row",
    "node_comment",
    "node_txt",
    "node_txt_difference",
    "txt_units",
    "node_txt_units",
    "txt_bytes",
    "node_txt_bytes",
    "node_author",
    "node_row",
    "node_lang",
    "node_vote",
];

const OUTCOMES: &[&str] = &[
    "would_serve",
    "would_answer",
    "would_hand_back",
    "would_fail",
    "unknown",
    "shed",
    "not_observed",
];

/// Every reason a line can carry.
const REASONS: &[&str] = &[
    // The lane.
    "rate_cap",
    "lane_full",
    "unconfigured",
    // The route prelude and the request's shape.
    "revoked",
    "not_production",
    "not_https",
    "body_unmodelled",
    "parameter",
    "shape_method",
    "shape_query",
    "shape_size",
    "shape_encoding",
    "shape_content_type",
    "shape_json",
    "shape_keys",
    "shape_conversation_id",
    "xid_key",
    "xid_profile_key",
    "txt_invalid",
    "vote_invalid",
    "is_seed_invalid",
    "txt_empty",
    "txt_nul",
    "is_seed",
    // The token and admission.
    "no_token",
    "token_oidc",
    "token_xid",
    "token_other_conversation",
    "token_refused",
    "admin",
    "unknown_conversation",
    "treevite",
    "not_a_participant",
    "moderator",
    "xid_required",
    "xid_allowlist",
    "admission_unavailable",
    "admission_timeout",
    // The decision.
    "strict_moderation",
    "duplicate",
    "closed",
    "no_anchor",
];

/// Set in a child process to make the observation panic while it holds a
/// comment, with the request's own bytes in the panic's message.
pub(crate) const PANIC_IN_OBSERVATION: &str = "POLIS_COMMENT_OBSERVE_TEST_PANIC";

/// A panic in the middle of an observation whose message is the copy's own
/// bytes, the way a string cut off a character boundary prints the string.
pub(super) fn panic_point(req: &Request) {
    if std::env::var_os(PANIC_IN_OBSERVATION).is_some() {
        panic!(
            "forced panic in the comment observation: {}",
            String::from_utf8_lossy(&req.body)
        );
    }
}

fn request_id() -> String {
    format!("{:032x}", rand::random::<u128>())
}

pub(crate) fn closed() -> Connector {
    Connector::Plain(Box::new("postgresql://u@127.0.0.1:1/d".parse().unwrap()))
}

fn app_config() -> config::Config {
    config::Config {
        listen: String::new(),
        math_env: "generated".into(),
        cache_size: 10,
        pca_cache_size: 10,
        pca_cache_bytes: crate::pca::DEFAULT_CACHE_BYTES,
        dev_mode: false,
        use_network_host: false,
        production: true,
        pool: read_limits(),
    }
}

/// The comment observer on the given connections, verifying tokens with
/// `public_pem` (issuer and audience `fixture`).
pub(crate) fn observer_with(
    reads: Connector,
    readback: Connector,
    public_pem: &[u8],
    admins: Vec<i32>,
    max_per_second: u32,
) -> Observer {
    let mut observer = Observer::new(
        participant::Verifier::new(public_pem, "fixture", "fixture").unwrap(),
        db::Pool::new(reads, read_limits()),
        db::Pool::new(readback, readback_limits()),
        admins,
        max_per_second,
    );
    observer.timing = crate::post_votes::observe::ReadbackTiming {
        first: Duration::from_millis(50),
        retry: Duration::from_millis(150),
    };
    observer
}

pub(crate) fn shadow_app(observer: Option<Observer>) -> Arc<App> {
    let mut app = App::new(&app_config(), db::Pool::new(closed(), read_limits()));
    app.post_comments_observe = observer;
    Arc::new(app)
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

fn claims(uid: i32, pid: i32, cid: &str) -> Value {
    json!({"uid":uid,"pid":pid,"conversation_id":cid,"sub":format!("anon:{uid}"),
        "iss":"fixture","aud":"fixture","iat":1600000000_u64,"exp":4100000000_u64,
        "anonymous_participant":true})
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

fn body(cid: &str, text: &str, extra: Value) -> String {
    let mut body = json!({"conversation_id": cid, "txt": text});
    for (key, value) in extra.as_object().unwrap() {
        body[key] = value.clone();
    }
    body.to_string()
}

/// A comment as nginx's mirror sends it to the shadow service.
pub(crate) fn copy(body: &str, authorization: Option<&str>, id: &str) -> Request {
    let mut headers = vec![
        ("host", "localhost"),
        ("content-type", "application/json"),
        ("x-forwarded-proto", "https"),
        ("x-request-id", id),
        ("x-polis-shadow", "commentsShadow"),
    ];
    if let Some(authorization) = authorization {
        headers.push(("authorization", authorization));
    }
    Request {
        method: "POST".into(),
        target: PATH.into(),
        headers: crate::http::Headers::from_raw(headers),
        body: body.as_bytes().to_vec(),
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

fn printed_line(id: &str) -> Option<String> {
    let marker = format!("\"request_id\":\"{id}\"");
    shadow::comments::recorded()
        .into_iter()
        .find(|line| line.contains(&marker) && line.contains("\"shadow_observation\""))
}

pub(crate) async fn observation(id: &str) -> Value {
    let printed = tokio::time::timeout(Duration::from_secs(60), async {
        loop {
            if let Some(line) = printed_line(id) {
                return line;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("no observation line for {id}"));
    assert_line_shape(&printed);
    serde_json::from_str(&printed).unwrap()
}

fn one_of(line: &Value, key: &str, words: &[&str], nullable: bool) {
    let value = &line[key];
    assert!(
        (nullable && value.is_null()) || value.as_str().is_some_and(|word| words.contains(&word)),
        "{key} is {value}: {line}"
    );
}

/// The line's contract: exactly the allowed keys in their order; no key that
/// names a conversation, a comment, a participant, a user or an external id;
/// and every value a number, a boolean, null or a word from a closed set, so
/// that no text, token or number of a row can be on it.
pub(crate) fn assert_line_shape(printed: &str) {
    assert_eq!(printed_keys(printed), LINE_KEYS, "{printed}");
    let line: Value = serde_json::from_str(printed).unwrap();
    for key in line.as_object().unwrap().keys() {
        let named = [
            "zid",
            "tid",
            "pid",
            "uid",
            "xid",
            "txt",
            "vote",
            "token",
            "conversation_id",
            "address",
            "user_agent",
        ];
        assert!(
            !named.contains(&key.as_str())
                && !["_zid", "_tid", "_pid", "_uid", "_xid"]
                    .iter()
                    .any(|suffix| key.ends_with(suffix)),
            "{key} names a row: {printed}"
        );
    }
    assert_eq!(line["message"], "shadow_observation");
    assert_eq!(line["listener"], "shadow");
    assert_eq!(line["service"], "polis-api-shadow");
    assert_eq!(line["shadow"], "commentsShadow");
    assert_eq!(line["route"], "POST /api/v3/comments");
    assert_eq!(line["write"], "not_modelled");
    assert!(
        line["request_id"].is_null()
            || line["request_id"].as_str().is_some_and(|id| id.len() == 32
                && id
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))),
        "{printed}"
    );
    one_of(&line, "outcome", OUTCOMES, false);
    one_of(&line, "reason", REASONS, true);
    one_of(
        &line,
        "body_class",
        &["le_1k", "le_4k", "le_10k", "over_10k"],
        false,
    );
    one_of(
        &line,
        "text_row",
        &["none", "own", "other", "unknown"],
        true,
    );
    one_of(
        &line,
        "node_comment",
        &[
            "own",
            "other",
            "absent",
            "unknown",
            "unavailable",
            "not_checked",
        ],
        false,
    );
    one_of(&line, "node_txt", &["same", "different"], true);
    one_of(
        &line,
        "node_txt_difference",
        &["space", "control", "case", "truncated", "other"],
        true,
    );
    one_of(&line, "node_author", &["same", "different"], true);
    one_of(
        &line,
        "node_row",
        &[
            "as_expected",
            "mod",
            "active",
            "is_seed",
            "velocity",
            "anon",
        ],
        true,
    );
    one_of(&line, "node_lang", &["unset", "set"], true);
    one_of(
        &line,
        "node_vote",
        &[
            "same",
            "different",
            "ambiguous",
            "absent",
            "not_sent",
            "unavailable",
            "not_checked",
        ],
        false,
    );
    assert!(line["admitted"] == 0 || line["admitted"] == 1, "{printed}");
    assert!(
        line["status"].is_null()
            || [200, 400, 401, 403, 409, 500, 502]
                .iter()
                .any(|status| line["status"] == *status),
        "{printed}"
    );
    for key in ["vote_present", "seed_present"] {
        assert!(line[key].is_boolean(), "{key}: {printed}");
    }
    assert!(
        line["strict"].is_null() || line["strict"].is_boolean(),
        "{printed}"
    );
    for key in ["queue_ms", "admission_ms", "total_ms", "readback_s"] {
        assert!(
            line[key].is_null() || line[key].is_number(),
            "{key}: {printed}"
        );
    }
    // The four lengths are there only beside a difference.
    for key in ["txt_units", "node_txt_units", "txt_bytes", "node_txt_bytes"] {
        assert_eq!(
            line[key].is_number(),
            line["node_txt"] == "different",
            "{key}: {printed}"
        );
        assert!(line[key].is_number() || line[key].is_null(), "{printed}");
    }
    // `env` is the process's own label; nothing else is free text.
    assert!(line["env"].is_string(), "{printed}");
}

// ------------------------------------------------------------ classifiers

/// The text match of admission: no row; this participant's row inside the
/// window after the copy's database-time anchor (Node's row for this very
/// request); any other row; and, when the anchor could not be read, unknown
/// for this participant's row, never a guess.
#[test]
fn the_text_match_is_none_own_other_or_unknown() {
    let anchor = 1_700_000_000_000_i64;
    let row = |pid: i32, created: Option<i64>| {
        Some(Existing {
            tid: 7,
            pid,
            created,
        })
    };
    for (existing, anchor, expected) in [
        (None, Some(anchor), "none"),
        (None, None, "none"),
        // This participant's row.
        (row(2, Some(anchor)), Some(anchor), "own"),
        (row(2, Some(anchor + 9_000)), Some(anchor), "own"),
        (row(2, Some(anchor - OWN_WINDOW_MS)), Some(anchor), "own"),
        (
            row(2, Some(anchor - OWN_WINDOW_MS - 1)),
            Some(anchor),
            "other",
        ),
        (row(2, Some(0)), Some(anchor), "other"),
        (row(2, None), Some(anchor), "other"),
        // Another participant's row is never this request's, anchor or not.
        (row(3, Some(anchor)), Some(anchor), "other"),
        (row(3, Some(anchor)), None, "other"),
        // No anchor: this participant's row may or may not be this request's.
        (row(2, Some(anchor)), None, "unknown"),
        (row(2, Some(0)), None, "unknown"),
        (row(2, None), None, "unknown"),
    ] {
        assert_eq!(
            TextRow::classify(existing, 2, anchor).as_str(),
            expected,
            "{existing:?} {anchor:?}"
        );
    }
    assert_eq!(OWN_WINDOW_MS, 5000);
}

/// Node's stored vote rows against the choice the request carried, through
/// the storage convention: every row the choice, none of them, or some.
#[test]
fn the_authors_stored_vote_is_classified_through_the_convention() {
    let stored = |choice: VoteChoice| {
        Some(i16::try_from(StorageConvention::CURRENT.encode(choice)).unwrap())
    };
    let choices = [VoteChoice::Agree, VoteChoice::Disagree, VoteChoice::Pass];
    for expected in choices {
        assert_eq!(
            AuthorVote::classify(&[stored(expected)], expected).as_str(),
            "same"
        );
        assert_eq!(
            AuthorVote::classify(&[stored(expected), stored(expected)], expected).as_str(),
            "same"
        );
        for other in choices.into_iter().filter(|other| *other != expected) {
            assert_eq!(
                AuthorVote::classify(&[stored(other)], expected).as_str(),
                "different",
                "{other:?} stored, {expected:?} sent"
            );
            assert_eq!(
                AuthorVote::classify(&[stored(other), stored(expected)], expected).as_str(),
                "ambiguous"
            );
        }
        // A stored NULL is no choice at all.
        assert_eq!(
            AuthorVote::classify(&[None], expected).as_str(),
            "different"
        );
        assert_eq!(AuthorVote::classify(&[], expected).as_str(), "absent");
    }
    for (class, word) in [
        (AuthorVote::NotSent, "not_sent"),
        (AuthorVote::Unavailable, "unavailable"),
        (AuthorVote::NotChecked, "not_checked"),
    ] {
        assert_eq!(class.as_str(), word);
    }
}

/// The stored row's columns against what the live insert would store: `mod`
/// 0, active, not a seed, `velocity` 1, not anonymous. The first column that
/// differs is named.
#[test]
fn a_stored_row_is_compared_with_the_row_live_would_store() {
    let expected = (Some(0), Some(true), Some(false), Some(1.0_f32), Some(false));
    let class = |(moderation, active, is_seed, velocity, anon)| {
        row_class(moderation, active, is_seed, velocity, anon)
    };
    assert_eq!(class(expected), "as_expected");
    for (row, column) in [
        (
            (Some(1), expected.1, expected.2, expected.3, expected.4),
            "mod",
        ),
        (
            (None, expected.1, expected.2, expected.3, expected.4),
            "mod",
        ),
        (
            (expected.0, Some(false), expected.2, expected.3, expected.4),
            "active",
        ),
        (
            (expected.0, expected.1, Some(true), expected.3, expected.4),
            "is_seed",
        ),
        (
            (expected.0, expected.1, expected.2, Some(0.0), expected.4),
            "velocity",
        ),
        (
            (expected.0, expected.1, expected.2, None, expected.4),
            "velocity",
        ),
        (
            (expected.0, expected.1, expected.2, expected.3, Some(true)),
            "anon",
        ),
        // The first that differs, in the order of the list.
        ((Some(1), Some(false), Some(true), None, Some(true)), "mod"),
        (
            (expected.0, expected.1, Some(true), None, Some(true)),
            "is_seed",
        ),
    ] {
        assert_eq!(class(row), column, "{row:?}");
    }
}

// ------------------------------------------------------------------ line

async fn accepted(app: &Arc<App>, votes: &Arc<shadow::Lane>, req: Request) -> u16 {
    shadow::accept(app.clone(), votes.clone(), req).await.status
}

/// The line carries exactly the allowed keys, and every value on it is a
/// number, a boolean or a word from a closed set, whatever becomes of the
/// copy: shed, not observed, handed back for its shape, its token or its
/// admission. The copies' text is a marker; no line holds any part of it.
#[tokio::test]
async fn the_line_carries_only_allowed_keys_and_words_from_closed_sets() {
    let keys = signing();
    let stranger = signing();
    let votes = shadow::Lane::new(1000);
    let app = shadow_app(Some(observer_with(
        closed(),
        closed(),
        &keys.public,
        vec![],
        1000,
    )));
    let member = bearer(&keys, &claims(3, 2, CID));
    let refused = bearer(&stranger, &claims(3, 2, CID));
    let agree = crate::votes::WIRE_AGREE;
    let plain = body(CID, MARKER, json!({}));
    let voting = body(
        CID,
        MARKER,
        json!({"vote": agree, "pid": NO_PID, "agid": 1}),
    );
    let mut insecure = copy(&plain, Some(member.as_str()), &request_id());
    insecure.headers = crate::http::Headers::from_raw([
        ("host", "localhost"),
        ("content-type", "application/json"),
        ("x-forwarded-proto", "http"),
        ("x-request-id", "0123456789abcdef0123456789abcdef"),
        ("x-polis-shadow", "commentsShadow"),
    ]);
    let mut form = copy(&plain, Some(member.as_str()), &request_id());
    form.headers = crate::http::Headers::from_raw([
        ("host", "localhost"),
        ("content-type", "text/plain;charset=UTF-8"),
        ("x-forwarded-proto", "https"),
        ("x-request-id", "fedcba9876543210fedcba9876543210"),
        ("x-polis-shadow", "commentsShadow"),
    ]);
    let long = format!("{MARKER}{}", "x".repeat(1000));
    let cases: Vec<(Request, &str, &str)> = vec![
        (
            copy(&plain, None, &request_id()),
            "would_hand_back",
            "no_token",
        ),
        (
            copy(&voting, None, &request_id()),
            "would_hand_back",
            "no_token",
        ),
        (
            copy(&plain, Some(refused.as_str()), &request_id()),
            "would_hand_back",
            "token_refused",
        ),
        (
            copy(
                &body(CID, MARKER, json!({"unknown": MARKER})),
                Some(member.as_str()),
                &request_id(),
            ),
            "would_hand_back",
            "shape_keys",
        ),
        (
            copy(
                &body(CID, MARKER, json!({"xid": MARKER, "x_name": MARKER})),
                Some(member.as_str()),
                &request_id(),
            ),
            "would_hand_back",
            "xid_key",
        ),
        (
            copy(
                &body(CID, &long, json!({})),
                Some(member.as_str()),
                &request_id(),
            ),
            "would_hand_back",
            "txt_invalid",
        ),
        (
            copy(
                &body(CID, &format!("{MARKER}\u{0}"), json!({})),
                Some(member.as_str()),
                &request_id(),
            ),
            "would_hand_back",
            "txt_nul",
        ),
        (
            copy(
                &body(CID, MARKER, json!({"is_seed": true})),
                Some(member.as_str()),
                &request_id(),
            ),
            "would_hand_back",
            "is_seed",
        ),
        (
            copy(
                &format!("{{\"conversation_id\":\"{CID}\",\"txt\":\"{MARKER}"),
                Some(member.as_str()),
                &request_id(),
            ),
            "would_hand_back",
            "shape_json",
        ),
        (insecure, "would_hand_back", "not_https"),
        (form, "would_hand_back", "shape_content_type"),
        // A member's copy with no database behind it: admission cannot run.
        (
            copy(&voting, Some(member.as_str()), &request_id()),
            "would_hand_back",
            "admission_unavailable",
        ),
    ];
    let mut lines = vec![];
    for (req, outcome, reason) in cases {
        let id = req.headers.get("x-request-id").unwrap().to_owned();
        assert_eq!(accepted(&app, &votes, req).await, 204);
        let line = observation(&id).await;
        assert_eq!(line["outcome"], outcome, "{line}");
        assert_eq!(line["reason"], reason, "{line}");
        assert_eq!(line["status"], 502, "{line}");
        assert_eq!(line["admitted"], 0, "{line}");
        assert_eq!(line["request_id"], id);
        assert_eq!(line["node_comment"], "not_checked", "{line}");
        assert_eq!(line["node_vote"], "not_checked", "{line}");
        assert!(line["text_row"].is_null(), "{line}");
        assert!(line["strict"].is_null(), "{line}");
        assert!(line["readback_s"].is_null(), "{line}");
        lines.push(line);
    }
    // What a copy says about itself, whatever its shape.
    assert_eq!(lines[0]["vote_present"], false);
    assert_eq!(lines[0]["seed_present"], false);
    assert_eq!(lines[1]["vote_present"], true);
    assert_eq!(lines[7]["seed_present"], true);
    assert_eq!(lines[0]["body_class"], "le_1k");
    assert_eq!(lines[5]["body_class"], "le_4k");
    // A request id that is not 32 lowercase hex is recorded as null.
    let mut odd = copy(&plain, None, "NOT-HEX");
    odd.headers = crate::http::Headers::from_raw([
        ("host", "localhost"),
        ("content-type", "application/json"),
        ("x-forwarded-proto", "https"),
        ("x-request-id", "0123456789ABCDEF0123456789ABCDEF"),
        ("x-polis-shadow", "commentsShadow"),
    ]);
    let before = shadow::comments::recorded().len();
    assert_eq!(accepted(&app, &votes, odd).await, 204);
    tokio::time::timeout(Duration::from_secs(60), async {
        while shadow::comments::recorded().len() == before {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("the copy without a usable request id is still recorded");
    // A process that also holds a live comment handler observes nothing.
    let mut both = App::new(&app_config(), db::Pool::new(closed(), read_limits()));
    both.post_comments_observe = Some(observer_with(
        closed(),
        closed(),
        &keys.public,
        vec![],
        1000,
    ));
    both.post_comments = Some(
        Writer::new(
            |_| Ok(closed()),
            participant::Verifier::new(&keys.public, "fixture", "fixture").unwrap(),
            vec![],
        )
        .unwrap(),
    );
    let both = Arc::new(both);
    let id = request_id();
    assert_eq!(
        accepted(&both, &votes, copy(&voting, Some(member.as_str()), &id)).await,
        204
    );
    let line = observation(&id).await;
    assert_eq!(line["outcome"], "not_observed");
    assert_eq!(line["reason"], "unconfigured");
    assert!(line["status"].is_null());
    assert_eq!(line["vote_present"], true);
    // Every line the comment observer printed in this process keeps the
    // contract, and none holds the marker, a token or a header name.
    let recorded = shadow::comments::recorded();
    assert!(recorded.len() > lines.len());
    for line in &recorded {
        assert_line_shape(line);
        assert!(!leaks(line), "{line}");
        for secret in [member.as_str(), refused.as_str(), "Bearer", "authorization"] {
            assert!(!line.contains(secret), "{line}");
        }
    }
    // The shadow's own access line for a comment copy names the path only.
    assert!(
        shadow::recorded()
            .iter()
            .any(|line| line.contains("\"message\":\"http_request\"")
                && line.contains("\"service\":\"polis-api-shadow\"")
                && line.contains("\"url\":\"/api/v3/comments\"")),
        "the shadow's access line for a comment copy"
    );
    for line in shadow::recorded() {
        assert!(!leaks(&line), "{line}");
    }
}

/// The comment lane has its own bound on observations in admission at once
/// and its own rate bucket: copies beyond either are shed and still answered
/// 204.
#[tokio::test]
async fn the_comment_lane_sheds_by_count_and_by_rate() {
    let keys = signing();
    let votes = shadow::Lane::new(1000);
    let app = shadow_app(Some(observer_with(
        closed(),
        closed(),
        &keys.public,
        vec![],
        1000,
    )));
    let lane = app.post_comments_observe.as_ref().unwrap().lane.clone();
    let parked = lane.park().await;
    let comment = body(CID, "Generated lane comment", json!({}));
    let mut ids = vec![];
    for _ in 0..shadow::comments::CAPACITY {
        let id = request_id();
        assert_eq!(accepted(&app, &votes, copy(&comment, None, &id)).await, 204);
        ids.push(id);
    }
    assert_eq!(lane.in_flight(), shadow::comments::CAPACITY);
    let id = request_id();
    assert_eq!(accepted(&app, &votes, copy(&comment, None, &id)).await, 204);
    let line = observation(&id).await;
    assert_eq!(line["outcome"], "shed");
    assert_eq!(line["reason"], "lane_full");
    assert_eq!(line["admitted"], 0);
    assert!(line["status"].is_null());
    // Its own rate bucket: two a second.
    let slow = shadow_app(Some(observer_with(
        closed(),
        closed(),
        &keys.public,
        vec![],
        2,
    )));
    let slow_lane = slow.post_comments_observe.as_ref().unwrap().lane.clone();
    let slow_parked = slow_lane.park().await;
    let mut slow_ids = vec![];
    for _ in 0..2 {
        let id = request_id();
        assert_eq!(
            accepted(&slow, &votes, copy(&comment, None, &id)).await,
            204
        );
        slow_ids.push(id);
    }
    let id = request_id();
    assert_eq!(
        accepted(&slow, &votes, copy(&comment, None, &id)).await,
        204
    );
    let line = observation(&id).await;
    assert_eq!(line["outcome"], "shed");
    assert_eq!(line["reason"], "rate_cap");
    for id in ids.iter().chain(&slow_ids) {
        assert!(printed_line(id).is_none(), "a parked observation printed");
    }
    // Nothing of the comment lane was taken from the vote lane.
    assert_eq!(votes.in_flight(), 0);
    drop(parked);
    drop(slow_parked);
    for id in ids.iter().chain(&slow_ids) {
        let line = observation(id).await;
        assert_eq!(line["outcome"], "would_hand_back");
        assert_eq!(line["reason"], "no_token");
    }
    assert_eq!(lane.in_flight(), 0);
    assert_eq!(shadow::comments::CAPACITY, 8);
    assert_eq!(shadow::comments::READBACK_WAITING, 64);
}

fn body_of(out: Outgoing) -> Value {
    let crate::http::Body::Fixed(bytes) = out.body else {
        panic!("fixed JSON expected")
    };
    serde_json::from_slice(&bytes).unwrap()
}

/// The shadow's /health with the comment observer built: a key of its own
/// beside the vote observer's, with its own pools, counters and lane.
#[tokio::test]
async fn health_reports_the_comment_observer_under_its_own_key() {
    let keys = signing();
    let votes = shadow::Lane::new(4);
    let app = shadow_app(Some(observer_with(
        closed(),
        closed(),
        &keys.public,
        vec![],
        3,
    )));
    let out = shadow::health(&app, &votes).await;
    assert_eq!(out.status, 503, "its read-back database does not answer");
    let health = body_of(out);
    assert_eq!(health["status"], "degraded");
    let mut top: Vec<&str> = health
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    top.sort_unstable();
    assert_eq!(
        top,
        [
            "commit",
            "postComments",
            "postVotes",
            "role",
            "shadow",
            "status",
            "version"
        ]
    );
    assert_eq!(health["postVotes"]["mode"], "off");
    let comments = &health["postComments"];
    let mut names: Vec<&str> = comments
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    names.sort_unstable();
    let mut expected = vec![
        "enabled",
        "mode",
        "observed",
        "wouldServe",
        "wouldAnswer",
        "wouldHandBack",
        "wouldFail",
        "unknown",
        "shed",
        "notObserved",
        "readbackOwn",
        "readbackOther",
        "readbackAbsent",
        "textDifferent",
        "voteSame",
        "voteAmbiguous",
        "voteDifferent",
        "voteAbsent",
        "inFlight",
        "capacity",
        "maxPerSecond",
        "readbackWaiting",
        "readbackCapacity",
        "pools",
    ];
    expected.sort_unstable();
    assert_eq!(names, expected);
    assert_eq!(comments["enabled"], false);
    assert_eq!(comments["mode"], "observe");
    assert_eq!(comments["capacity"], 8);
    assert_eq!(comments["readbackCapacity"], 64);
    assert_eq!(comments["maxPerSecond"], 3);
    assert_eq!(comments["inFlight"], 0);
    assert_eq!(comments["observed"], 0);
    let pools = comments["pools"].as_object().unwrap();
    let mut pool_names: Vec<&String> = pools.keys().collect();
    pool_names.sort();
    assert_eq!(pool_names, ["readback", "reads"]);
    for pool in pools.values() {
        assert_eq!(pool["readOnly"], true);
        assert_eq!(pool["acquireTimeoutMs"], 100);
        assert_eq!(pool["statementTimeoutMs"], 100);
    }
    assert_eq!(pools["reads"]["limit"], 2);
    assert_eq!(pools["readback"]["limit"], 1);
    assert_eq!(pools["readback"]["reachable"], false);
    // The vote lane's own numbers are the vote lane's.
    assert_eq!(health["shadow"]["maxPerSecond"], 4);
    assert_eq!(health["shadow"]["capacity"], 32);
}

/// The shadow listener itself, over a socket: a comment copy is answered
/// 204 and observed; a copy whose body the handler would not read (chunked,
/// or longer than the handler's bound) is answered 204 unread, counted, and
/// never observed, as a vote copy is.
#[tokio::test]
async fn the_listener_answers_an_unread_comment_body_204_and_counts_it() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let keys = signing();
    let votes = shadow::Lane::new(4);
    let app = shadow_app(Some(observer_with(
        closed(),
        closed(),
        &keys.public,
        vec![],
        1000,
    )));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(shadow::serve(listener, app.clone(), votes.clone()));
    let unread = |health: &Value| health["shadow"]["bodyUnread"].as_u64().unwrap();
    let health = || async { body_of(shadow::health(&app, &votes).await) };
    let before = unread(&health().await);
    let exchange = |raw: Vec<u8>| async move {
        let mut client = tokio::net::TcpStream::connect(address).await.unwrap();
        client.write_all(&raw).await.unwrap();
        let mut response = Vec::new();
        let _ =
            tokio::time::timeout(Duration::from_secs(10), client.read_to_end(&mut response)).await;
        String::from_utf8_lossy(&response).into_owned()
    };
    let head = |id: &str, framing: &str| {
        format!(
            "POST /api/v3/comments HTTP/1.1\r\nHost: localhost\r\nX-Polis-Shadow: commentsShadow\r\nX-Forwarded-Proto: https\r\nX-Request-Id: {id}\r\nContent-Type: application/json\r\nConnection: close\r\n{framing}\r\n\r\n"
        )
    };
    // An ordinary copy: 204, and its line.
    let comment = body(CID, "Generated over a socket", json!({}));
    let id = request_id();
    let mut raw = head(&id, &format!("Content-Length: {}", comment.len())).into_bytes();
    raw.extend_from_slice(comment.as_bytes());
    let response = exchange(raw).await;
    assert!(response.starts_with("HTTP/1.1 204 "), "{response}");
    let line = observation(&id).await;
    assert_eq!(line["outcome"], "would_hand_back");
    assert_eq!(line["reason"], "no_token");
    // A chunked copy, and one longer than the handler reads.
    let chunked = request_id();
    let mut raw = head(&chunked, "Transfer-Encoding: chunked").into_bytes();
    raw.extend_from_slice(format!("{:x}\r\n{comment}\r\n0\r\n\r\n", comment.len()).as_bytes());
    let long = request_id();
    let long_body = body(CID, MARKER, json!({"pid": "x".repeat(MAX_BODY_BYTES)}));
    let mut long_raw = head(&long, &format!("Content-Length: {}", long_body.len())).into_bytes();
    long_raw.extend_from_slice(long_body.as_bytes());
    for raw in [raw, long_raw] {
        let response = exchange(raw).await;
        assert!(response.starts_with("HTTP/1.1 204 "), "{response}");
        assert!(!leaks(&response));
    }
    assert_eq!(unread(&health().await), before + 2);
    tokio::time::sleep(Duration::from_millis(50)).await;
    server.abort();
    for id in [&chunked, &long] {
        assert!(printed_line(id).is_none(), "an unread copy was observed");
    }
}

// --------------------------------------------------------------- startup

/// The observer's startup, each case in a process of its own: what the
/// shadow role builds for `observe`, that it is two read-only pools and no
/// writer pool, and that every startup condition of the live handler is
/// required of it too.
#[test]
fn observe_mode_builds_two_read_only_pools_and_no_writer_pool() {
    const CHILD: &str = "POLIS_COMMENT_OBSERVE_STARTUP_TEST";
    if let Ok(scenario) = std::env::var(CHILD) {
        let before = db::WRITER_POOLS_BUILT.load(Ordering::SeqCst);
        let keys = polis_auth::keys::Keys::from_env_optional().unwrap();
        let built = match scenario.as_str() {
            "configure" => match configure(crate::shadow::Role::Shadow, keys.as_ref()) {
                Ok(Configured::Off) => "off".to_owned(),
                Ok(Configured::Live(_)) => "live".to_owned(),
                Ok(Configured::Observe(observer)) => {
                    let pools = observer
                        .startup_pools()
                        .iter()
                        .map(|(name, pool)| {
                            let health: Value =
                                serde_json::from_str(&crate::js::stringify(&pool.health(false)))
                                    .unwrap();
                            format!("{name}:{}:{}", health["readOnly"], health["limit"])
                        })
                        .collect::<Vec<_>>()
                        .join(",");
                    let lane: Value = serde_json::from_str(&crate::js::stringify(
                        &shadow::comments::health(&observer, false),
                    ))
                    .unwrap();
                    format!("observe {pools} max_per_second={}", lane["maxPerSecond"])
                }
                Err(error) => format!("error: {error:#}"),
            },
            "shadow" => match shadow::configure() {
                Ok(configured) => format!(
                    "votes={} comments={} live_votes={} live_comments={}",
                    configured.app.post_votes_observe.is_some(),
                    configured.app.post_comments_observe.is_some(),
                    configured.app.post_votes.is_some(),
                    configured.app.post_comments.is_some(),
                ),
                Err(error) => format!("error: {error:#}"),
            },
            other => panic!("unknown scenario {other}"),
        };
        println!(
            "configured={built};writers={}",
            db::WRITER_POOLS_BUILT.load(Ordering::SeqCst) - before
        );
        return;
    }
    let rsa = openssl::rsa::Rsa::generate(2048).unwrap();
    let dir = std::env::temp_dir().join(format!("comment-observe-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let key = dir.join("public.pem");
    std::fs::write(&key, rsa.public_key_to_pem().unwrap()).unwrap();
    let key = key.to_string_lossy().into_owned();
    let complete: Vec<(&str, &str)> = vec![
        ("POLIS_API_POST_COMMENTS", "observe"),
        ("SHOULD_USE_TRANSLATION_API", "false"),
        (
            "POLIS_API_POST_COMMENTS_DATABASE_URL",
            "postgres://postgres@127.0.0.1:9/postgres",
        ),
        ("POLIS_API_DB_TRANSPORT", "loopback"),
        ("POLIS_API_PARTICIPANT_PUBLIC_KEY_FILE", key.as_str()),
        ("POLIS_JWT_ISSUER", "fixture"),
        ("POLIS_JWT_AUDIENCE", "fixture"),
        ("POLIS_API_SHADOW_COMMENTS_MAX_PER_SECOND", "3"),
    ];
    let run = |scenario: &str, env: &[(&str, &str)]| {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "post_comments::observe::tests::observe_mode_builds_two_read_only_pools_and_no_writer_pool",
                "--nocapture",
            ])
            .env_clear()
            .env(CHILD, scenario)
            .envs(env.iter().copied())
            .output()
            .unwrap();
        let text = String::from_utf8_lossy(&output.stdout).into_owned();
        assert!(output.status.success(), "{text}");
        text.lines()
            .find(|line| line.contains("configured="))
            .map(|line| line[line.find("configured=").unwrap()..].to_owned())
            .unwrap_or(text)
    };
    let without = |name: &str| -> Vec<(&str, &str)> {
        complete
            .iter()
            .copied()
            .filter(|(key, _)| *key != name)
            .collect()
    };
    let with = |name: &'static str, value: &'static str| -> Vec<(&str, &str)> {
        let mut env = without(name);
        env.push((name, value));
        env
    };
    assert_eq!(
        run("configure", &complete),
        "configured=observe reads:true:2,readback:true:1 max_per_second=3;writers=0"
    );
    // Every startup condition of the live handler, and the lane's rate.
    for (missing, named) in [
        ("SHOULD_USE_TRANSLATION_API", "SHOULD_USE_TRANSLATION_API"),
        (
            "POLIS_API_POST_COMMENTS_DATABASE_URL",
            "explicit primary database",
        ),
        (
            "POLIS_API_PARTICIPANT_PUBLIC_KEY_FILE",
            "participant public key",
        ),
        ("POLIS_JWT_ISSUER", ""),
        ("POLIS_JWT_AUDIENCE", ""),
        (
            "POLIS_API_SHADOW_COMMENTS_MAX_PER_SECOND",
            "POLIS_API_SHADOW_COMMENTS_MAX_PER_SECOND",
        ),
    ] {
        let built = run("configure", &without(missing));
        assert!(
            built.starts_with("configured=error: ")
                && built.contains(named)
                && built.ends_with(";writers=0"),
            "{missing}: {built}"
        );
    }
    for (name, value) in [
        ("SHOULD_USE_TRANSLATION_API", "true"),
        ("POLIS_API_SHADOW_COMMENTS_MAX_PER_SECOND", "0"),
        ("POLIS_API_SHADOW_COMMENTS_MAX_PER_SECOND", "10001"),
        ("POLIS_API_SHADOW_COMMENTS_MAX_PER_SECOND", "fast"),
    ] {
        let built = run("configure", &with(name, value));
        assert!(
            built.starts_with("configured=error: ") && built.ends_with(";writers=0"),
            "{name}={value}: {built}"
        );
    }
    // The shadow role as a whole: the comment observer beside the vote
    // observer, each built only when its own switch says observe.
    let mut shadow_env = complete.clone();
    shadow_env.extend([
        ("POLIS_API_ROLE", "shadow"),
        ("MATH_ENV", "test"),
        ("NODE_ENV", "production"),
        ("POLIS_API_SHADOW_LISTEN", "127.0.0.1:0"),
        ("POLIS_API_SHADOW_MAX_PER_SECOND", "4"),
        ("DATABASE_URL", "postgres://postgres@127.0.0.1:9/postgres"),
    ]);
    assert_eq!(
        run("shadow", &shadow_env),
        "configured=votes=false comments=true live_votes=false live_comments=false;writers=0"
    );
    let mut both = shadow_env.clone();
    both.extend([
        ("POLIS_API_POST_VOTES", "observe"),
        ("TOPICAL_COMMENT_RATIO", "0"),
        (
            "POLIS_API_POST_VOTES_DATABASE_URL",
            "postgres://postgres@127.0.0.1:9/postgres",
        ),
    ]);
    assert_eq!(
        run("shadow", &both),
        "configured=votes=true comments=true live_votes=false live_comments=false;writers=0"
    );
    // The vote shadow as it runs today, with no comment switch: nothing of
    // the comment observer is built, and its rate setting is not asked for.
    let votes_only: Vec<(&str, &str)> = both
        .iter()
        .copied()
        .filter(|(key, _)| {
            !matches!(
                *key,
                "POLIS_API_POST_COMMENTS"
                    | "POLIS_API_POST_COMMENTS_DATABASE_URL"
                    | "POLIS_API_SHADOW_COMMENTS_MAX_PER_SECOND"
            )
        })
        .collect();
    assert_eq!(
        run("shadow", &votes_only),
        "configured=votes=true comments=false live_votes=false live_comments=false;writers=0"
    );
    let live: Vec<(&str, &str)> = both
        .iter()
        .copied()
        .map(|(key, value)| {
            if key == "POLIS_API_POST_COMMENTS" {
                (key, "1")
            } else {
                (key, value)
            }
        })
        .collect();
    let refused = run("shadow", &live);
    assert!(
        refused.contains("the shadow role never builds the live comment writer")
            && refused.ends_with(";writers=0"),
        "{refused}"
    );
    std::fs::remove_dir_all(dir).unwrap();
}

/// The shadow role's panic hook prints where a panic happened and never
/// what it said: a child process panics with the marker as its message, the
/// way a string sliced off a character boundary prints the string.
#[test]
fn the_shadow_panic_hook_prints_a_location_and_never_the_message() {
    const CHILD: &str = "POLIS_COMMENT_OBSERVE_PANIC_HOOK_TEST";
    if std::env::var_os(CHILD).is_some() {
        shadow::install_panic_hook();
        let caught = std::panic::catch_unwind(|| {
            panic!("forced panic quoting {MARKER}");
        });
        println!("caught={}", caught.is_err());
        return;
    }
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "post_comments::observe::tests::the_shadow_panic_hook_prints_a_location_and_never_the_message",
            "--nocapture",
        ])
        .env(CHILD, "1")
        .output()
        .unwrap();
    let printed = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.status.success(), "{printed}");
    assert!(printed.contains("caught=true"), "{printed}");
    let event = printed
        .lines()
        .find(|line| line.contains("\"shadow_panic\""))
        .unwrap_or_else(|| panic!("no shadow_panic event: {printed}"));
    let event: Value = serde_json::from_str(event).unwrap();
    assert_eq!(event["listener"], "shadow");
    assert_eq!(event["service"], "polis-api-shadow");
    assert!(
        event["location"]
            .as_str()
            .is_some_and(|location| location.contains("post_comments_observe_tests.rs:")),
        "{event}"
    );
    assert!(!printed.contains("forced panic quoting"), "{printed}");
    assert!(!leaks(&printed), "{printed}");
}

#[cfg(feature = "db-tests")]
#[path = "post_comments_observe_database_tests.rs"]
pub(crate) mod database;

/// Formatted the way a careless `expect` or `dbg!` would format them, the
/// classes the observer keeps are words and numbers.
#[test]
fn the_classes_the_observer_keeps_format_as_words_and_numbers() {
    let text = CommentText::new(MARKER.into());
    let other = format!("{MARKER} and more");
    let compared = text.compare(&other);
    assert!(matches!(
        compared,
        Compared::Different {
            class: TextDifference::Truncated,
            ..
        }
    ));
    let printed = format!(
        "{compared:?} {:?} {:?} {:?} {:?}",
        TextRow::Own,
        AuthorVote::Different,
        NodeComment::Own,
        text
    );
    assert!(!leaks(&printed), "{printed}");
}
