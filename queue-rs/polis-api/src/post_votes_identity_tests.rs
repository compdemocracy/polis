//! Identity observation on a copy of a vote: which copies it decides for,
//! the keys it adds to the vote copy's line and the closed sets their values
//! come from, the rule for sending an external id to the database, and the
//! comparison of a decision with what Node left.
//!
//! "Node" in the database tests is the staged admission itself
//! (`polis_auth::admission::admit`) on a writable connection, with a vote
//! stored through the vote writer's own sign-aware `append`. The observer
//! under test holds no such connection.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::string_slice
)]
use super::*;
use crate::shadow;
use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
use polis_queue_adapter::jobs::transport::Connector;
use serde_json::{Value, json};

/// The vote copy's keys as the vote observer prints them, in their order.
/// The comparison tool reads these by name; identity adds its keys after
/// them and changes none.
const VOTE_KEYS: [&str; 27] = [
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
    "selection_ms",
    "total_ms",
    "readback_s",
    "zid",
    "starred_present",
    "lang_present",
    "append",
    "follow_on",
    "remaining",
    "total",
    "candidates",
    "weights_tick",
    "prev",
    "node_vote",
];

/// Every word an identity key may carry.
const WORDS: [(&str, &[&str]); 13] = [
    ("id_basis", &["one_instant_reads"]),
    (
        "id_entry",
        &[
            "none",
            "xid",
            "anonymous_token",
            "xid_token",
            "standard_user_token",
            "foreign_token",
            "refused_token",
        ],
    ),
    ("id_token_scope", &["this", "other"]),
    (
        "id_decision",
        &[
            "create_user_and_participant",
            "create_participant",
            "found",
            "refuse",
            "cannot_decide",
            "unavailable",
            "shed",
        ],
    ),
    (
        "id_refusal",
        &[
            "closed",
            "xid_required",
            "xid_not_allowed",
            "xid_account",
            "treevite",
            "unknown_conversation",
            "xid_invalid",
            "other",
        ],
    ),
    (
        "id_why",
        &[
            "token_unverified",
            "xid_lookup_disabled",
            "logging_settings_unread",
            "reads_failed",
            "waiting_full",
        ],
    ),
    ("id_xid", &["none", "bound", "unbound", "not_looked_up"]),
    (
        "id_member_row",
        &["matches", "absent", "differs", "unknown"],
    ),
    (
        "id_node",
        &[
            "created",
            "found",
            "none",
            "ambiguous",
            "unavailable",
            "no_anchor",
            "not_checked",
        ],
    ),
    (
        "id_node_xid",
        &[
            "bound_here",
            "bound_elsewhere",
            "bound_no_number",
            "unbound",
        ],
    ),
    (
        "id_node_vote",
        &[
            "same",
            "ambiguous",
            "different",
            "absent",
            "unavailable",
            "not_checked",
        ],
    ),
    ("id_timing", &["before_node", "after_node"]),
    (
        "id_compare",
        &[
            "agree",
            "agree_by_number",
            "expected_difference",
            "differs",
            "unknown",
        ],
    ),
];
const FLAGS: [&str; 6] = [
    "id_xid_required",
    "id_xid_allowlist",
    "id_treevite",
    "id_member",
    "id_member_treevite",
    "id_fields",
];
const NUMBERS: [&str; 3] = ["id_zid", "id_decision_ms", "id_readback_s"];

/// The statement the copies of these tests are about.
const TID: i32 = 1;

/// Refuses an identity value that is not null, a boolean where a boolean
/// belongs, a number where a number belongs, or a word of its key's set.
fn identity_values(line: &Value) -> Result<(), String> {
    for key in LINE_KEYS {
        let value = line
            .get(key)
            .ok_or_else(|| format!("{key} is not on the line"))?;
        let allowed = if value.is_null() {
            true
        } else if FLAGS.contains(&key) {
            value.is_boolean()
        } else if NUMBERS.contains(&key) {
            value.is_number()
        } else {
            WORDS
                .iter()
                .find(|(name, _)| *name == key)
                .is_some_and(|(_, words)| value.as_str().is_some_and(|word| words.contains(&word)))
        };
        if !allowed {
            return Err(format!("{key} carries {value}"));
        }
    }
    Ok(())
}

#[test]
fn every_identity_key_is_a_flag_a_number_or_a_word_of_a_closed_set() {
    // Every key is of exactly one kind.
    for key in LINE_KEYS {
        let kinds = usize::from(FLAGS.contains(&key))
            + usize::from(NUMBERS.contains(&key))
            + usize::from(WORDS.iter().any(|(name, _)| *name == key));
        assert_eq!(kinds, 1, "{key}");
    }
    assert_eq!(FLAGS.len() + NUMBERS.len() + WORDS.len(), LINE_KEYS.len());
    // Every word the module can print is in its key's set, and every word of
    // a set is one the module prints.
    let words = |key: &str| WORDS.iter().find(|(name, _)| *name == key).unwrap().1;
    let same = |key: &str, printed: Vec<&'static str>| {
        let mut printed = printed;
        let mut listed = words(key).to_vec();
        printed.sort_unstable();
        listed.sort_unstable();
        assert_eq!(printed, listed, "{key}");
    };
    same(
        "id_entry",
        [
            Entry::Nothing,
            Entry::Xid,
            Entry::AnonymousToken,
            Entry::XidToken,
            Entry::StandardUserToken,
            Entry::ForeignToken,
            Entry::RefusedToken,
        ]
        .map(Entry::as_str)
        .to_vec(),
    );
    same(
        "id_decision",
        [
            Decided::CreateUserAndParticipant,
            Decided::CreateParticipant,
            Decided::Found,
            Decided::Refuse,
            Decided::CannotDecide,
            Decided::Unavailable,
            Decided::Shed,
        ]
        .map(Decided::as_str)
        .to_vec(),
    );
    same(
        "id_refusal",
        [
            Refused::Closed,
            Refused::XidRequired,
            Refused::XidNotAllowed,
            Refused::XidAccount,
            Refused::Treevite,
            Refused::UnknownConversation,
            Refused::XidInvalid,
            Refused::Other,
        ]
        .map(Refused::as_str)
        .to_vec(),
    );
    same(
        "id_why",
        [
            Why::TokenUnverified,
            Why::XidLookupDisabled,
            Why::LoggingSettingsUnread,
            Why::ReadsFailed,
            Why::WaitingFull,
        ]
        .map(Why::as_str)
        .to_vec(),
    );
    same(
        "id_xid",
        [
            XidSeen::NotNamed,
            XidSeen::Bound,
            XidSeen::Unbound,
            XidSeen::NotReached,
        ]
        .map(xid_word)
        .to_vec(),
    );
    same(
        "id_member_row",
        [Row::Matches, Row::Absent, Row::Differs, Row::Unknown]
            .map(Row::as_str)
            .to_vec(),
    );
    same(
        "id_node",
        [
            Node::Created,
            Node::Found,
            Node::None,
            Node::Ambiguous,
            Node::Unavailable,
            Node::NoAnchor,
            Node::NotChecked,
        ]
        .map(Node::as_str)
        .to_vec(),
    );
    same(
        "id_node_xid",
        [
            NodeXid::BoundHere,
            NodeXid::BoundElsewhere,
            NodeXid::BoundNoNumber,
            NodeXid::Unbound,
        ]
        .map(NodeXid::as_str)
        .to_vec(),
    );
    same(
        "id_node_vote",
        [
            NodeVote::Same,
            NodeVote::Ambiguous,
            NodeVote::Different,
            NodeVote::Absent,
            NodeVote::Unavailable,
            NodeVote::NotChecked,
        ]
        .map(NodeVote::as_str)
        .to_vec(),
    );
    same(
        "id_timing",
        [Timing::BeforeNode, Timing::AfterNode]
            .map(Timing::as_str)
            .to_vec(),
    );
    same(
        "id_compare",
        [
            Compare::Agree,
            Compare::AgreeByNumber,
            Compare::ExpectedDifference,
            Compare::Differs,
            Compare::Unknown,
        ]
        .map(Compare::as_str)
        .to_vec(),
    );
    // The check itself refuses what does not belong.
    let mut line = js::Obj::new();
    let mut observed = Observed::undecided(Some(Entry::Xid), Decided::Refuse, Why::ReadsFailed);
    observed.zid = Some(7);
    observed.fields = Some(true);
    print_keys(&mut line, Some(&observed));
    let printed: Value = serde_json::from_str(&js::stringify(&Js::Obj(line))).unwrap();
    assert_eq!(identity_values(&printed), Ok(()));
    for (key, value) in [
        ("id_entry", json!("an external id")),
        ("id_entry", json!(7)),
        ("id_decision", json!({"created": true})),
        ("id_refusal", json!(["closed"])),
        ("id_fields", json!("true")),
        ("id_zid", json!("7")),
        ("id_node", json!("created by 7654321")),
        ("id_basis", json!("anything")),
    ] {
        let mut altered = printed.clone();
        altered[key] = value;
        assert!(identity_values(&altered).is_err(), "{key}");
    }
    let mut missing = printed.clone();
    missing.as_object_mut().unwrap().remove("id_compare");
    assert!(identity_values(&missing).is_err());
    // A copy that is no identity copy carries each key as null.
    let mut line = js::Obj::new();
    print_keys(&mut line, None);
    let printed: Value = serde_json::from_str(&js::stringify(&Js::Obj(line))).unwrap();
    assert!(LINE_KEYS.iter().all(|key| printed[*key].is_null()));
}

/// What "agree" means for a creation, for every pairing of a decision with
/// what the read-back found, and by how the read-back found it.
#[test]
fn a_decision_is_compared_with_what_node_left_on_one_question() {
    use Compare::{Agree, AgreeByNumber, Differs, ExpectedDifference, Unknown};
    let creates = [
        Decided::CreateUserAndParticipant,
        Decided::CreateParticipant,
    ];
    let votes = [
        None,
        Some(NodeVote::Same),
        Some(NodeVote::Different),
        Some(NodeVote::Ambiguous),
        Some(NodeVote::Absent),
    ];
    for tied in [false, true] {
        for vote in votes {
            // None, ambiguous, unavailable, no anchor and not checked are
            // unknown whatever was decided.
            for node in [
                Node::None,
                Node::Ambiguous,
                Node::Unavailable,
                Node::NoAnchor,
                Node::NotChecked,
            ] {
                for decided in [
                    Decided::CreateUserAndParticipant,
                    Decided::CreateParticipant,
                    Decided::Found,
                    Decided::Refuse,
                    Decided::CannotDecide,
                    Decided::Unavailable,
                    Decided::Shed,
                ] {
                    assert_eq!(
                        compare(decided, Some(Refused::Closed), node, vote, None, tied),
                        Unknown
                    );
                }
            }
            // Nothing decided: unknown whatever was found.
            for decided in [Decided::CannotDecide, Decided::Unavailable, Decided::Shed] {
                for node in [Node::Created, Node::Found] {
                    assert_eq!(compare(decided, None, node, vote, None, tied), Unknown);
                }
            }
        }
    }
    for decided in creates {
        // Would create, and Node created: agreement only when the row was
        // found by the request's own identity, whatever the stored vote.
        for vote in votes {
            assert_eq!(
                compare(decided, None, Node::Created, vote, None, true),
                Agree
            );
        }
        // Found only by a new participant's vote on the same statement: a
        // word of its own when that vote is the copy's, and nothing at all
        // when it is not. Never the plain agreement.
        assert_eq!(
            compare(
                decided,
                None,
                Node::Created,
                Some(NodeVote::Same),
                None,
                false
            ),
            AgreeByNumber
        );
        for vote in [
            None,
            Some(NodeVote::Different),
            Some(NodeVote::Ambiguous),
            Some(NodeVote::Absent),
            Some(NodeVote::Unavailable),
            Some(NodeVote::NotChecked),
        ] {
            assert_eq!(
                compare(decided, None, Node::Created, vote, None, false),
                Unknown
            );
        }
        // Would create, and the row found by the request's own identity is
        // older than the request: a disagreement.
        assert_eq!(
            compare(decided, None, Node::Found, None, None, true),
            Differs
        );
        assert_eq!(
            compare(decided, None, Node::Found, None, None, false),
            Unknown
        );
    }
    // Would find: an older row agrees; a row Node created that the decision
    // already saw is right for its instant and silent about the one before.
    assert_eq!(
        compare(Decided::Found, None, Node::Found, None, None, true),
        Agree
    );
    assert_eq!(
        compare(
            Decided::Found,
            None,
            Node::Created,
            None,
            Some(Timing::AfterNode),
            true
        ),
        Unknown
    );
    assert_eq!(
        compare(
            Decided::Found,
            None,
            Node::Created,
            None,
            Some(Timing::BeforeNode),
            true
        ),
        Differs
    );
    // Would refuse: nobody created agrees. A participant created in a closed
    // conversation is the known, expected difference; under any other rule
    // it is a disagreement, when the row is tied to the request.
    assert_eq!(
        compare(
            Decided::Refuse,
            Some(Refused::Closed),
            Node::Found,
            None,
            None,
            true
        ),
        Agree
    );
    assert_eq!(
        compare(
            Decided::Refuse,
            Some(Refused::Closed),
            Node::Created,
            None,
            Some(Timing::BeforeNode),
            true
        ),
        ExpectedDifference
    );
    for refusal in [
        Refused::XidRequired,
        Refused::XidNotAllowed,
        Refused::XidAccount,
        Refused::Treevite,
        Refused::UnknownConversation,
        Refused::XidInvalid,
        Refused::Other,
    ] {
        assert_eq!(
            compare(
                Decided::Refuse,
                Some(refusal),
                Node::Created,
                None,
                Some(Timing::BeforeNode),
                true
            ),
            Differs,
            "{refusal:?}"
        );
    }
    for vote in votes {
        assert_eq!(
            compare(
                Decided::Refuse,
                Some(Refused::XidRequired),
                Node::Created,
                vote,
                None,
                false
            ),
            Unknown
        );
    }
}

/// The rule for sending an external id as a query parameter: only when no
/// setting of the server can write a parameter, a plan or a parse tree into
/// its log. A setting that is missing counts as unsafe.
#[test]
fn an_external_id_is_sent_only_when_no_setting_can_log_a_parameter() {
    let settings = |changes: &[(&str, Option<&str>)]| {
        let mut all: Vec<(String, String)> = [
            ("debug_print_parse", "off"),
            ("debug_print_plan", "off"),
            ("debug_print_rewritten", "off"),
            ("local_preload_libraries", ""),
            ("log_min_duration_sample", "-1"),
            ("log_min_duration_statement", "-1"),
            ("log_min_error_statement", "error"),
            ("log_min_messages", "warning"),
            ("log_parameter_max_length", "-1"),
            ("log_parameter_max_length_on_error", "0"),
            ("log_statement", "none"),
            ("log_transaction_sample_rate", "0"),
            ("session_preload_libraries", ""),
            ("shared_preload_libraries", "pg_stat_statements"),
        ]
        .map(|(name, value)| (name.to_owned(), value.to_owned()))
        .to_vec();
        for (name, value) in changes {
            all.retain(|(key, _)| key != name);
            if let Some(value) = value {
                all.push(((*name).to_owned(), (*value).to_owned()));
            }
        }
        all
    };
    // PostgreSQL's defaults, with the statement statistics library loaded.
    assert_eq!(xid_lookup_rule(&settings(&[])), XidLookup::Enabled);
    // The statement reads exactly the settings the rule names.
    for (name, _) in settings(&[]) {
        assert!(LOGGING_SETTINGS.contains(&format!("'{name}'")), "{name}");
    }
    assert_eq!(
        LOGGING_SETTINGS.matches('\'').count(),
        2 * settings(&[]).len()
    );
    // Statements may be logged when their parameters never are.
    for logged in [
        ("log_statement", "all"),
        ("log_min_duration_statement", "0"),
        ("log_min_duration_sample", "50"),
        ("log_transaction_sample_rate", "1"),
    ] {
        assert_eq!(
            xid_lookup_rule(&settings(&[
                (logged.0, Some(logged.1)),
                ("log_parameter_max_length", Some("0"))
            ])),
            XidLookup::Enabled,
            "{logged:?}"
        );
    }
    for statements in ["ddl", "mod"] {
        assert_eq!(
            xid_lookup_rule(&settings(&[("log_statement", Some(statements))])),
            XidLookup::Enabled
        );
    }
    for level in ["info", "notice", "error", "log", "fatal", "panic"] {
        assert_eq!(
            xid_lookup_rule(&settings(&[("log_min_messages", Some(level))])),
            XidLookup::Enabled
        );
    }
    let on_error = "log_parameter_max_length_on_error";
    for (name, value, because) in [
        (on_error, Some("-1"), on_error),
        (on_error, Some("64"), on_error),
        (on_error, None, on_error),
        ("log_parameter_max_length", None, "log_parameter_max_length"),
        ("log_statement", Some("all"), "log_statement"),
        ("log_statement", None, "log_statement"),
        (
            "log_min_duration_statement",
            Some("0"),
            "log_min_duration_statement",
        ),
        (
            "log_min_duration_statement",
            Some("250"),
            "log_min_duration_statement",
        ),
        (
            "log_min_duration_statement",
            None,
            "log_min_duration_statement",
        ),
        (
            "log_min_duration_sample",
            Some("100"),
            "log_min_duration_sample",
        ),
        ("log_min_duration_sample", None, "log_min_duration_sample"),
        // A sampled transaction logs each of its statements with its
        // parameters, and every identity read runs in a transaction.
        (
            "log_transaction_sample_rate",
            Some("1"),
            "log_transaction_sample_rate",
        ),
        (
            "log_transaction_sample_rate",
            Some("0.01"),
            "log_transaction_sample_rate",
        ),
        (
            "log_transaction_sample_rate",
            None,
            "log_transaction_sample_rate",
        ),
        // A plan holds a bound parameter as a constant.
        ("debug_print_plan", Some("on"), "debug_print"),
        ("debug_print_plan", None, "debug_print"),
        ("debug_print_parse", Some("on"), "debug_print"),
        ("debug_print_parse", None, "debug_print"),
        ("debug_print_rewritten", Some("on"), "debug_print"),
        ("debug_print_rewritten", None, "debug_print"),
        ("log_min_messages", Some("debug1"), "log_min_messages"),
        ("log_min_messages", Some("debug5"), "log_min_messages"),
        ("log_min_messages", None, "log_min_messages"),
        (
            "shared_preload_libraries",
            Some("pg_stat_statements,auto_explain"),
            "preload_libraries",
        ),
        (
            "shared_preload_libraries",
            Some("pgaudit"),
            "preload_libraries",
        ),
        ("shared_preload_libraries", None, "preload_libraries"),
        (
            "session_preload_libraries",
            Some("auto_explain"),
            "preload_libraries",
        ),
        ("session_preload_libraries", None, "preload_libraries"),
        // The third way a library is loaded.
        (
            "local_preload_libraries",
            Some("auto_explain"),
            "preload_libraries",
        ),
        (
            "local_preload_libraries",
            Some("pgaudit"),
            "preload_libraries",
        ),
        ("local_preload_libraries", None, "preload_libraries"),
    ] {
        assert_eq!(
            xid_lookup_rule(&settings(&[(name, value)])),
            XidLookup::Disabled(because),
            "{name} {value:?}"
        );
    }
    // The plan and the trees are written whether or not parameters are.
    assert_eq!(
        xid_lookup_rule(&settings(&[
            ("debug_print_plan", Some("on")),
            ("log_parameter_max_length", Some("0"))
        ])),
        XidLookup::Disabled("debug_print")
    );
    assert_eq!(
        xid_lookup_rule(&[]),
        XidLookup::Disabled("log_parameter_max_length_on_error")
    );
}

static LINES: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

/// Every vote copy's line printed with the identity keys in this process.
pub(crate) fn record_line(line: &str) {
    LINES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .push(line.to_owned());
}

fn recorded() -> Vec<String> {
    LINES.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

pub(super) const PANIC_IN_DECISION: &str = "POLIS_IDENTITY_OBSERVE_TEST_PANIC";

/// A panic in the middle of a decision whose message holds what the decision
/// holds: the copy's body, with its external id and names, and its token.
pub(super) fn panic_point(req: &Request) {
    if std::env::var_os(PANIC_IN_DECISION).is_some() {
        panic!(
            "forced panic in the identity decision: {} {}",
            String::from_utf8_lossy(&req.body),
            req.headers.get("authorization").unwrap_or_default()
        );
    }
}

struct Signing {
    public: Vec<u8>,
    private: EncodingKey,
}

fn signing() -> Signing {
    let rsa = openssl::rsa::Rsa::generate(2048).unwrap();
    Signing {
        public: rsa.public_key_to_pem().unwrap(),
        private: EncodingKey::from_rsa_pem(&rsa.private_key_to_pem().unwrap()).unwrap(),
    }
}

fn sign(keys: &Signing, claims: &Value) -> String {
    encode(&Header::new(Algorithm::RS256), claims, &keys.private).unwrap()
}

fn base_claims(uid: i32, pid: i32, cid: &str) -> Value {
    json!({"uid": uid, "pid": pid, "conversation_id": cid, "iss": "fixture", "aud": "fixture",
        "iat": 1_600_000_000_u64, "exp": 4_100_000_000_u64})
}

fn anonymous(keys: &Signing, uid: i32, pid: i32, cid: &str) -> String {
    let mut claims = base_claims(uid, pid, cid);
    claims["sub"] = json!(format!("anon:{uid}"));
    claims["anonymous_participant"] = json!(true);
    sign(keys, &claims)
}

#[cfg(feature = "db-tests")]
fn xid_token(keys: &Signing, uid: i32, pid: i32, cid: &str, xid: &str) -> String {
    let mut claims = base_claims(uid, pid, cid);
    claims["sub"] = json!(format!("xid:{xid}"));
    claims["xid"] = json!(xid);
    claims["xid_participant"] = json!(true);
    sign(keys, &claims)
}

#[cfg(feature = "db-tests")]
fn standard_user(keys: &Signing, uid: i32, pid: i32, cid: &str) -> String {
    let mut claims = base_claims(uid, pid, cid);
    claims["sub"] = json!("user:fixture|account");
    claims["oidc_sub"] = json!("fixture|account");
    claims["standard_user_participant"] = json!(true);
    sign(keys, &claims)
}

/// A request id nginx could have made, of letters only, so that no test's
/// search for a number can meet one by chance.
fn request_id() -> String {
    (0..32)
        .map(|_| char::from(b'a' + rand::random::<u8>() % 6))
        .collect()
}

fn vote_body(cid: &str, tid: i32, choice: VoteChoice) -> Value {
    json!({"conversation_id": cid, "tid": tid, "vote": choice.wire()})
}

/// A request as nginx's mirror sends it to the shadow service.
fn copy(body: &Value, token: Option<&str>, id: &str) -> Request {
    let authorization = token.map(|token| format!("Bearer {token}"));
    let mut headers = vec![
        ("host", "localhost"),
        ("content-type", "application/json"),
        ("x-forwarded-proto", "https"),
        ("x-request-id", id),
        ("x-polis-shadow", "votesShadow"),
    ];
    if let Some(authorization) = authorization.as_deref() {
        headers.push(("authorization", authorization));
    }
    Request {
        method: "POST".into(),
        target: PATH.into(),
        headers: crate::http::Headers::from_raw(headers),
        body: body.to_string().into_bytes(),
    }
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
        pool: read_limits(),
    }
}

fn closed() -> Connector {
    Connector::Plain(Box::new("postgresql://u@127.0.0.1:1/d".parse().unwrap()))
}

fn test_timing() -> ReadbackTiming {
    ReadbackTiming {
        first: Duration::from_millis(50),
        retry: Duration::from_millis(150),
    }
}

/// The vote observer on `vote` connections, with identity observed on an
/// `identity` connection when one is given.
fn observer_on(
    vote: impl Fn() -> Connector,
    identity: Option<(Connector, db::Limits)>,
    public: &[u8],
) -> Observer {
    let mut observer = Observer::new(
        participant::Verifier::new(public, "fixture", "fixture").unwrap(),
        db::Pool::new(vote(), read_limits()),
        db::Pool::new(vote(), observe::readback_limits()),
        vec![],
        Arc::default(),
    );
    observer.timing = test_timing();
    observer.identity = identity.map(|(connector, limits)| {
        let mut identity = IdentityObserver::new(db::Pool::new(connector, limits));
        identity.timing = test_timing();
        Box::new(identity)
    });
    observer
}

fn shadow_app(observer: Observer) -> Arc<App> {
    let mut app = App::new(&app_config(), db::Pool::new(closed(), read_limits()));
    app.post_votes_observe = Some(observer);
    Arc::new(app)
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

/// The line of one copy, with the identity keys or (identity off) without.
fn printed_line(id: &str) -> Option<String> {
    let marker = format!("\"request_id\":\"{id}\"");
    recorded()
        .into_iter()
        .chain(shadow::recorded())
        .find(|line| line.contains(&marker) && line.contains("\"shadow_observation\""))
}

async fn printed(id: &str) -> String {
    tokio::time::timeout(Duration::from_secs(60), async {
        loop {
            if let Some(line) = printed_line(id) {
                return line;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("no observation line for {id}"))
}

/// The line of a copy observed with identity on: the vote observer's keys in
/// their order, then the identity keys in theirs, and every identity value
/// from its closed set.
async fn observation(id: &str) -> Value {
    let line = printed(id).await;
    let mut expected: Vec<&str> = VOTE_KEYS.to_vec();
    expected.extend(LINE_KEYS);
    assert_eq!(
        printed_keys(&line),
        expected,
        "the line's keys in their order"
    );
    let value: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(identity_values(&value), Ok(()), "{line}");
    value
}

async fn send(
    app: &Arc<App>,
    lane: &Arc<shadow::Lane>,
    body: &Value,
    token: Option<&str>,
) -> Value {
    let id = request_id();
    assert_eq!(
        shadow::accept(app.clone(), lane.clone(), copy(body, token, &id))
            .await
            .status,
        204
    );
    observation(&id).await
}

/// Which copies are identity copies, and what is read out of them.
#[test]
fn a_copy_is_an_identity_copy_by_the_vote_observers_own_reason() {
    let body = vote_body("2open", TID, VoteChoice::Agree);
    let plain = copy(&body, None, &request_id());
    for reason in ["no_token", "token_refused", "not_a_participant"] {
        let read = read(&plain, Some(reason)).unwrap();
        assert_eq!(read.cid, "2open");
        assert!(matches!(read.named, Named::Nothing));
        assert!(read.fields_valid && read.fields.is_some());
    }
    // Every other reason, and a served copy, is the vote observer's alone.
    for reason in [
        None,
        Some("admin"),
        Some("closed"),
        Some("xid_required"),
        Some("xid_allowlist"),
        Some("unknown_conversation"),
        Some("admission_unavailable"),
        Some("admission_timeout"),
        Some("shape_json"),
        Some("shape_content_type"),
        Some("parameter"),
        Some("revoked"),
        Some("site_owner_standard_user"),
    ] {
        assert!(read(&plain, reason).is_none(), "{reason:?}");
    }
    // The shape check refuses a body with an external id; identity reads it
    // without those keys, by the same shape check.
    let named = |extra: Value| {
        let mut body = body.clone();
        for (key, value) in extra.as_object().unwrap() {
            body[key] = value.clone();
        }
        copy(&body, None, &request_id())
    };
    let with_xid = named(json!({"xid": " external ", "x_name": "A Name",
        "x_profile_image_url": "https://example.invalid/a.png", "x_email": "a@example.invalid"}));
    assert_eq!(request_reasoned(&with_xid).err(), Some("shape_keys"));
    let read_xid = read(&with_xid, Some("shape_keys")).unwrap();
    assert!(matches!(&read_xid.named, Named::Xid(xid) if xid.parameter() == "external"));
    assert_eq!(read_xid.cid, "2open");
    // Absent, null or only whitespace names nothing, as for Node.
    for nothing in [
        json!({"x_name": "A Name"}),
        json!({"xid": null}),
        json!({"xid": "   "}),
        json!({"xid": "\u{feff}\t"}),
    ] {
        let read = read(&named(nothing.clone()), Some("shape_keys")).unwrap();
        assert!(matches!(read.named, Named::Nothing), "{nothing}");
    }
    // Not a string, or longer than 999 units: Node answers 400.
    for invalid in [
        json!(12),
        json!(["a"]),
        json!({"a": 1}),
        json!("x".repeat(1000)),
    ] {
        let read = read(&named(json!({"xid": invalid})), Some("shape_keys")).unwrap();
        assert!(matches!(read.named, Named::Invalid), "{invalid}");
    }
    // A key the shape check refuses for another reason stays refused.
    assert!(
        read(
            &named(json!({"xid": "external", "unknown": true})),
            Some("shape_keys")
        )
        .is_none()
    );
    assert!(read(&named(json!({"unknown": true})), Some("shape_keys")).is_none());
    // Fields that do not parse are said so; the copy is still decided.
    let mut bad = body.clone();
    bad["tid"] = json!("not a number");
    let read_bad = read(&copy(&bad, None, &request_id()), Some("no_token")).unwrap();
    assert!(!read_bad.fields_valid && read_bad.fields.is_none());
}

/// With identity observation off, a copy's line is the vote observer's and
/// nothing else: the same keys in the same order, and no identity pool.
/// With it on, the same keys come first, unchanged, and the identity keys
/// follow.
#[tokio::test]
async fn identity_keys_follow_the_vote_keys_and_are_absent_when_identity_is_off() {
    let keys = signing();
    let lane = shadow::Lane::new(1000);
    let body = vote_body("2open", TID, VoteChoice::Agree);
    let off = shadow_app(observer_on(closed, None, &keys.public));
    let on = shadow_app(observer_on(
        closed,
        Some((closed(), limits())),
        &keys.public,
    ));
    let id = request_id();
    assert_eq!(
        shadow::accept(off.clone(), lane.clone(), copy(&body, None, &id))
            .await
            .status,
        204
    );
    let without = printed(&id).await;
    assert_eq!(printed_keys(&without), VOTE_KEYS, "identity off");
    let without: Value = serde_json::from_str(&without).unwrap();
    let with = send(&on, &lane, &body, None).await;
    // Every key of the vote observer's that does not measure time carries
    // the same value with identity on as with it off.
    for key in VOTE_KEYS {
        if matches!(
            key,
            "request_id" | "queue_ms" | "admission_ms" | "selection_ms" | "total_ms"
        ) {
            continue;
        }
        assert_eq!(with[key], without[key], "{key}");
    }
    assert_eq!(with["outcome"], "would_hand_back");
    assert_eq!(with["reason"], "no_token");
    // No database answers here: the decision says so and guesses nothing.
    assert_eq!(with["id_basis"], "one_instant_reads");
    assert_eq!(with["id_entry"], "none");
    assert_eq!(with["id_decision"], "unavailable");
    assert_eq!(with["id_why"], "reads_failed");
    assert_eq!(with["id_node"], "not_checked");
    assert_eq!(with["id_compare"], "unknown");
    assert_eq!(with["id_fields"], true);
    // Health: identity has a key of its own when on, and none when off; the
    // vote observer's pools are its two in both.
    let health = |app: Arc<App>| {
        let lane = lane.clone();
        async move {
            let out = shadow::health(&app, &lane).await;
            let crate::http::Body::Fixed(bytes) = out.body else {
                panic!("health has a body");
            };
            serde_json::from_slice::<Value>(&bytes).unwrap()
        }
    };
    let off_health = health(off).await;
    let on_health = health(on).await;
    assert!(off_health.get("postVotesIdentity").is_none());
    for health in [&off_health, &on_health] {
        let mut pools: Vec<&str> = health["postVotes"]["pools"]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        pools.sort_unstable();
        assert_eq!(pools, ["readback", "reads"]);
    }
    let identity = &on_health["postVotesIdentity"];
    assert_eq!(identity["mode"], "observe");
    assert_eq!(identity["pools"]["identity"]["readOnly"], true);
    assert_eq!(identity["pools"]["identity"]["limit"], 1);
    assert_eq!(identity["waitingCapacity"], WAITING);
    assert_eq!(identity["xidLookup"], "unread");
    assert!(identity["xidLookupReadAt"].is_null());
    assert_eq!(identity["decided"], 1);
    assert_eq!(identity["unavailable"], 1);
    // The same top-level keys otherwise.
    let mut on_keys: Vec<&String> = on_health.as_object().unwrap().keys().collect();
    on_keys.retain(|key| *key != "postVotesIdentity");
    let off_keys: Vec<&String> = off_health.as_object().unwrap().keys().collect();
    assert_eq!(on_keys, off_keys);
}

/// What is decided with no database: a token this process cannot verify, an
/// external id it may not send, a malformed external id. And a copy that is
/// not an identity copy, or is not observed at all, carries each identity
/// key as null.
#[tokio::test]
async fn copies_decided_without_a_read_and_copies_that_are_not_identity_copies() {
    let keys = signing();
    let stranger = signing();
    let lane = shadow::Lane::new(1000);
    let app = shadow_app(observer_on(
        closed,
        Some((closed(), limits())),
        &keys.public,
    ));
    let body = vote_body("2open", TID, VoteChoice::Agree);
    // A provider's token: none of the participant claims, another key.
    let provider = sign(
        &stranger,
        &json!({"sub": "provider|subject", "iss": "https://provider.invalid/",
            "aud": "fixture", "exp": 4_100_000_000_u64, "iat": 1_600_000_000_u64}),
    );
    let line = send(&app, &lane, &body, Some(&provider)).await;
    assert_eq!(line["reason"], "token_refused");
    assert_eq!(line["id_entry"], "foreign_token");
    assert_eq!(line["id_decision"], "cannot_decide");
    assert_eq!(line["id_why"], "token_unverified");
    assert!(line["id_token_scope"].is_null() && line["id_zid"].is_null());
    // A participant token signed with another key.
    let forged = anonymous(&stranger, 2, 0, "2open");
    let line = send(&app, &lane, &body, Some(&forged)).await;
    assert_eq!(line["id_entry"], "refused_token");
    assert_eq!(line["id_decision"], "cannot_decide");
    // An external id, with no database to read the settings from or to ask.
    let mut named = body.clone();
    named["xid"] = json!("external");
    let line = send(&app, &lane, &named, None).await;
    assert_eq!(line["outcome"], "would_hand_back");
    assert_eq!(line["reason"], "shape_keys");
    assert_eq!(line["id_entry"], "xid");
    assert_eq!(line["id_decision"], "unavailable");
    assert_eq!(line["id_why"], "reads_failed");
    // An external id that is not a string is refused by both engines.
    named["xid"] = json!(12);
    let line = send(&app, &lane, &named, None).await;
    assert_eq!(line["id_decision"], "refuse");
    assert_eq!(line["id_refusal"], "xid_invalid");
    assert!(line["id_why"].is_null());
    // Not identity copies: another refused key, a malformed body, and a
    // member's token whose admission could not be read.
    let mut unknown = body.clone();
    unknown["unknown"] = json!(true);
    let member = anonymous(&keys, 2, 0, "2open");
    for (body, token, reason) in [
        (unknown, None, "shape_keys"),
        (body.clone(), Some(member.as_str()), "admission_unavailable"),
    ] {
        let line = send(&app, &lane, &body, token).await;
        assert_eq!(line["reason"], reason);
        assert!(LINE_KEYS.iter().all(|key| line[*key].is_null()), "{line}");
    }
    // Shed by the lane: not observed, and no identity copy.
    let slow = shadow::Lane::new(1);
    let (first, second) = (request_id(), request_id());
    for id in [&first, &second] {
        shadow::accept(app.clone(), slow.clone(), copy(&body, None, id)).await;
    }
    assert_eq!(observation(&first).await["outcome"], "would_hand_back");
    let shed = observation(&second).await;
    assert_eq!(shed["outcome"], "shed");
    assert!(LINE_KEYS.iter().all(|key| shed[*key].is_null()), "{shed}");
}

#[cfg(feature = "db-tests")]
#[path = "post_votes_identity_database_tests.rs"]
pub(crate) mod database;
