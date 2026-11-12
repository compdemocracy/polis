#![allow(clippy::unwrap_used, clippy::expect_used)]
use super::*;
use crate::http::Headers;
#[cfg(feature = "db-tests")]
use crate::post_comments_decision::{AfterInsert, Outcome, Store};
use serde_json::{Value, json};

const CID: &str = "2p027generated";
/// The participant number the jQuery participation client puts in every
/// request body: "not known".
const NO_PID: i32 = -1;

fn req(body: &str) -> Request {
    typed(body, Some("application/json"))
}

fn typed(body: &str, content_type: Option<&str>) -> Request {
    let mut headers = vec![("x-forwarded-proto", "https")];
    if let Some(content_type) = content_type {
        headers.push(("content-type", content_type));
    }
    Request {
        method: "POST".into(),
        target: PATH.into(),
        headers: Headers::from_raw(headers),
        body: body.as_bytes().to_vec(),
    }
}

fn comment(extra: Value) -> String {
    let mut body = json!({"conversation_id": CID, "txt": "Generated ordinary comment"});
    for (key, value) in extra.as_object().unwrap() {
        body[key] = value.clone();
    }
    body.to_string()
}

fn reason(body: &str) -> Option<&'static str> {
    request_reasoned(&req(body)).err()
}

/// Every refusal of the request's shape has its own reason, and each is
/// decided without the token or the database.
#[test]
fn every_shape_refusal_has_its_own_reason() {
    let agree = crate::votes::WIRE_AGREE;
    for (body, expected) in [
        ("{}".to_owned(), Some("shape_conversation_id")),
        ("[]".to_owned(), Some("shape_json")),
        ("{".to_owned(), Some("shape_json")),
        (comment(json!({})), None),
        (comment(json!({"vote": agree})), None),
        (comment(json!({"vote": null, "is_seed": null})), None),
        (comment(json!({"is_seed": false})), None),
        (comment(json!({"is_seed": "OFF"})), None),
        (
            comment(json!({"conversation_id": "a/b"})),
            Some("shape_conversation_id"),
        ),
        (
            comment(json!({"conversation_id": null})),
            Some("shape_conversation_id"),
        ),
        (
            comment(json!({"conversation_id": ""})),
            Some("shape_conversation_id"),
        ),
        // What Node answers 400 for stays Node's.
        (
            json!({"conversation_id": CID}).to_string(),
            Some("txt_invalid"),
        ),
        (comment(json!({"txt": null})), Some("txt_invalid")),
        (comment(json!({"txt": 7})), Some("txt_invalid")),
        (
            comment(json!({"txt": "x".repeat(998)})),
            Some("txt_invalid"),
        ),
        (
            comment(json!({"txt": "😀".repeat(499)})),
            Some("txt_invalid"),
        ),
        (comment(json!({"txt": ""})), Some("txt_empty")),
        (comment(json!({"txt": "   "})), Some("txt_empty")),
        (comment(json!({"txt": "a\u{0}b"})), Some("txt_nul")),
        (comment(json!({"vote": 2})), Some("vote_invalid")),
        (comment(json!({"vote": 0.5})), Some("vote_invalid")),
        (comment(json!({"vote": true})), Some("vote_invalid")),
        (
            comment(json!({"is_seed": " true "})),
            Some("is_seed_invalid"),
        ),
        // Node's order: the text, the vote, the seed flag, then the empty text.
        (
            comment(json!({"txt": 7, "vote": 2, "is_seed": "bad"})),
            Some("txt_invalid"),
        ),
        (
            comment(json!({"txt": "", "vote": 2, "is_seed": "bad"})),
            Some("vote_invalid"),
        ),
        (
            comment(json!({"txt": "", "is_seed": "bad"})),
            Some("is_seed_invalid"),
        ),
        (
            comment(json!({"txt": "", "is_seed": true})),
            Some("txt_empty"),
        ),
        (comment(json!({"is_seed": true})), Some("is_seed")),
        (comment(json!({"is_seed": 2})), Some("is_seed")),
        (comment(json!({"is_seed": "ON"})), Some("is_seed")),
    ] {
        assert_eq!(reason(&body), expected, "{body}");
    }
    let admitted = comment(json!({}));
    let mut r = req(&admitted);
    r.method = "GET".into();
    assert_eq!(request_reasoned(&r).err(), Some("shape_method"));
    let mut r = req(&admitted);
    r.target.push_str("?xid=external");
    assert_eq!(request_reasoned(&r).err(), Some("shape_query"));
    let mut r = req(&comment(json!({"txt": "x".repeat(900)})));
    r.body.extend(std::iter::repeat_n(b' ', MAX_BODY_BYTES));
    assert_eq!(request_reasoned(&r).err(), Some("shape_size"));
}

/// The text keeps Node's rule: at most 997 UTF-16 units, then leading and
/// trailing ASCII spaces removed and nothing else.
#[test]
fn text_length_and_trimming_are_nodes() {
    for (text, bytes) in [
        ("x".repeat(997), Some(997)),
        ("😀".repeat(498) + "x", Some(498 * 4 + 1)),
        ("  Generated trimmed text  ".to_owned(), Some(22)),
        ("\t".to_owned(), Some(1)),
        (" \u{a0}x ".to_owned(), Some(3)),
        ("x".repeat(998), None),
    ] {
        let parsed = request_reasoned(&req(&comment(json!({"txt": text}))));
        assert_eq!(
            parsed
                .as_ref()
                .ok()
                .map(|(_, comment)| comment.text.bytes()),
            bytes,
            "{} units",
            text.encode_utf16().count()
        );
    }
}

/// Each body key the browser clients send, one by one. `pid` and `agid` are
/// not parameters of this route in Node: whatever they hold, the request is
/// the request without them. `xid` selects another identity and is handed
/// back under its own reason; so are the profile keys that travel with it;
/// any other key is one no client sends.
#[test]
fn body_keys_the_clients_send_are_each_accounted_for() {
    let agree = crate::votes::WIRE_AGREE;
    let plain = comment(json!({"vote": agree}));
    let (cid, original) = request_reasoned(&req(&plain)).unwrap();
    for hint in [
        json!(0),
        json!(NO_PID),
        json!(999),
        json!("untrusted"),
        Value::Null,
        json!({"nested": [true]}),
    ] {
        for keys in [vec!["pid"], vec!["agid"], vec!["pid", "agid"]] {
            let mut body: Value = serde_json::from_str(&plain).unwrap();
            for key in keys {
                body[key] = hint.clone();
            }
            let (with_cid, with) = request_reasoned(&req(&body.to_string())).unwrap();
            assert_eq!(with_cid, cid);
            assert_eq!(with.vote, original.vote);
            assert_eq!(with.text.bytes(), original.text.bytes());
        }
    }
    // The jQuery client's body, and the alpha client's.
    for body in [
        json!({"txt": "Generated", "pid": NO_PID, "conversation_id": CID, "vote": agree, "agid": 1}),
        json!({"txt": "Generated", "conversation_id": CID, "pid": 4, "vote": agree}),
    ] {
        assert!(request_reasoned(&req(&body.to_string())).is_ok(), "{body}");
    }
    for (extra, expected) in [
        (json!({"xid": "external"}), "xid_key"),
        (json!({"xid": null}), "xid_key"),
        (json!({"xid": 3}), "xid_key"),
        (json!({"x_name": "Name"}), "xid_profile_key"),
        (
            json!({"x_profile_image_url": "https://example.invalid/a.png"}),
            "xid_profile_key",
        ),
        (json!({"x_email": "a@example.invalid"}), "xid_profile_key"),
        // The identity key decides the reason when the profile keys are there too.
        (
            json!({"xid": "external", "x_name": "Name", "unknown": 1}),
            "xid_key",
        ),
        (json!({"x_name": "Name", "unknown": 1}), "xid_profile_key"),
        (json!({"uid": 999}), "shape_keys"),
        (json!({"tid": 999}), "shape_keys"),
        (json!({"lang": "fr"}), "shape_keys"),
        (json!({"weight": 123}), "shape_keys"),
        (json!({"unknown": true}), "shape_keys"),
    ] {
        assert_eq!(reason(&comment(extra.clone())), Some(expected), "{extra}");
    }
}

/// The three forms the clients send (the command-line client, the `fetch`
/// client, and the jQuery client as XMLHttpRequest rewrites its charset) are
/// admitted; every other form stays Node's, and so does an encoded body.
#[test]
fn content_types_of_the_three_clients_are_admitted_and_no_other() {
    let body = comment(json!({}));
    for content_type in [
        "application/json",
        "application/json; charset=utf-8",
        "application/json; charset=UTF-8",
    ] {
        assert!(
            request_reasoned(&typed(&body, Some(content_type))).is_ok(),
            "{content_type}"
        );
        for encoding in ["gzip", "identity"] {
            let mut r = typed(&body, Some(content_type));
            r.headers = Headers::from_raw([
                ("x-forwarded-proto", "https"),
                ("content-type", content_type),
                ("content-encoding", encoding),
            ]);
            assert_eq!(request_reasoned(&r).err(), Some("shape_encoding"));
        }
    }
    for content_type in [
        Some("application/json;charset=UTF-8"),
        Some("application/json;charset=utf-8"),
        Some("application/json; charset=Utf-8"),
        Some("application/json; charset=\"utf-8\""),
        Some("Application/JSON"),
        Some("application/vnd.api+json"),
        Some("application/json; charset=utf-16"),
        Some("application/json; charset=utf-8; boundary=x"),
        Some("application/x-www-form-urlencoded"),
        Some("application/json; charset=iso-8859-1"),
        Some("application/json;"),
        Some("text/plain;charset=UTF-8"),
        Some(""),
        None,
    ] {
        assert_eq!(
            request_reasoned(&typed(&body, content_type)).err(),
            Some("shape_content_type"),
            "{content_type:?}"
        );
    }
}

/// Cookies neither authenticate nor disqualify: the jQuery client sends
/// whatever the browser holds for the site.
#[test]
fn a_cookie_changes_nothing_about_the_shape() {
    let body = comment(json!({}));
    let mut r = req(&body);
    r.headers = Headers::from_raw([
        ("x-forwarded-proto", "https"),
        ("content-type", "application/json"),
        ("cookie", "token2=generated; uid2=generated"),
    ]);
    assert!(request_reasoned(&r).is_ok());
}

/// Off for unset, empty and 0; live for 1; observe for observe; anything
/// else stops the process. Each role refuses the other's mode.
#[test]
fn the_switch_has_three_values_and_each_role_refuses_the_others_mode() {
    use crate::shadow::Role;
    for (value, expected) in [
        (None, Some(Switch::Off)),
        (Some(""), Some(Switch::Off)),
        (Some("0"), Some(Switch::Off)),
        (Some("1"), Some(Switch::Live)),
        (Some("observe"), Some(Switch::Observe)),
        (Some("true"), None),
        (Some("false"), None),
        (Some("on"), None),
        (Some("OBSERVE"), None),
        (Some(" 1"), None),
        (Some("2"), None),
    ] {
        assert_eq!(parse_switch(value).ok(), expected, "{value:?}");
    }
    for (role, switch, accepted) in [
        (Role::Main, Switch::Off, true),
        (Role::Main, Switch::Live, true),
        (Role::Main, Switch::Observe, false),
        (Role::Shadow, Switch::Off, true),
        (Role::Shadow, Switch::Live, false),
        (Role::Shadow, Switch::Observe, true),
    ] {
        assert_eq!(mode(role, switch).ok(), accepted.then_some(switch));
    }
}

/// `configure` in a process of its own, for each role and switch value: what
/// it builds, and that the shadow role's `observe` builds the observer, with
/// no pool that can write, under the live handler's own startup conditions
/// (`post_comments_observe_tests.rs` holds what the observer is).
#[test]
fn configure_builds_the_live_handler_only_in_the_main_role() {
    const CHILD: &str = "POLIS_COMMENT_CONFIGURE_TEST";
    if let Ok(role) = std::env::var(CHILD) {
        let role = if role == "shadow" {
            crate::shadow::Role::Shadow
        } else {
            crate::shadow::Role::Main
        };
        let before = db::WRITER_POOLS_BUILT.load(Ordering::SeqCst);
        let built = match configure(role, None) {
            Ok(Configured::Off) => "off".to_owned(),
            Ok(Configured::Live(_)) => "live".to_owned(),
            Ok(Configured::Observe(_)) => "observe".to_owned(),
            Err(error) => format!("error: {error}"),
        };
        println!(
            "configured={built};writers={}",
            db::WRITER_POOLS_BUILT.load(Ordering::SeqCst) - before
        );
        return;
    }
    let rsa = openssl::rsa::Rsa::generate(2048).unwrap();
    let dir = std::env::temp_dir().join(format!("comment-configure-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let key = dir.join("public.pem");
    std::fs::write(&key, rsa.public_key_to_pem().unwrap()).unwrap();
    let run = |role: &str, switch: Option<&str>, translation: Option<&str>, complete: bool| {
        let mut child = std::process::Command::new(std::env::current_exe().unwrap());
        child
            .args([
                "--exact",
                "post_comments::tests::configure_builds_the_live_handler_only_in_the_main_role",
                "--nocapture",
            ])
            .env_clear()
            .env(CHILD, role);
        if let Some(switch) = switch {
            child.env("POLIS_API_POST_COMMENTS", switch);
        }
        if let Some(translation) = translation {
            child.env("SHOULD_USE_TRANSLATION_API", translation);
        }
        if complete {
            child
                .env(
                    "POLIS_API_POST_COMMENTS_DATABASE_URL",
                    "postgres://postgres@127.0.0.1:9/postgres",
                )
                .env("POLIS_API_DB_TRANSPORT", "loopback")
                .env("POLIS_API_PARTICIPANT_PUBLIC_KEY_FILE", &key)
                .env("POLIS_JWT_ISSUER", "fixture")
                .env("POLIS_JWT_AUDIENCE", "fixture")
                .env("POLIS_API_SHADOW_COMMENTS_MAX_PER_SECOND", "2");
        }
        let output = child.output().unwrap();
        let text = String::from_utf8_lossy(&output.stdout).into_owned();
        assert!(output.status.success(), "{text}");
        text.lines()
            .find(|line| line.contains("configured="))
            .map(|line| line[line.find("configured=").unwrap()..].to_owned())
            .unwrap_or(text)
    };
    for switch in [None, Some(""), Some("0")] {
        for role in ["main", "shadow"] {
            assert_eq!(run(role, switch, None, false), "configured=off;writers=0");
        }
    }
    // Live: the main role only, with every prerequisite stated.
    assert_eq!(
        run("main", Some("1"), Some("false"), true),
        "configured=live;writers=2"
    );
    for translation in [None, Some(""), Some("true"), Some("1")] {
        let built = run("main", Some("1"), translation, true);
        assert!(
            built.starts_with("configured=error: ")
                && built.contains("SHOULD_USE_TRANSLATION_API")
                && built.ends_with(";writers=0"),
            "{translation:?}: {built}"
        );
    }
    let built = run("main", Some("1"), Some("false"), false);
    assert!(
        built.starts_with("configured=error: ") && built.ends_with(";writers=0"),
        "{built}"
    );
    let built = run("shadow", Some("1"), Some("false"), true);
    assert!(
        built.contains("the shadow role never builds the live comment writer")
            && built.ends_with(";writers=0"),
        "{built}"
    );
    // Observe: the shadow role only, with every prerequisite of the live
    // handler stated, and no pool that can write.
    assert_eq!(
        run("shadow", Some("observe"), Some("false"), true),
        "configured=observe;writers=0"
    );
    for (translation, complete) in [(None, true), (Some("true"), true), (Some("false"), false)] {
        let built = run("shadow", Some("observe"), translation, complete);
        assert!(
            built.starts_with("configured=error: ") && built.ends_with(";writers=0"),
            "{translation:?} {complete}: {built}"
        );
    }
    let built = run("main", Some("observe"), Some("false"), true);
    assert!(
        built.contains("accepted only by the shadow role") && built.ends_with(";writers=0"),
        "{built}"
    );
    for role in ["main", "shadow"] {
        for other in ["true", "on", "2", "live", "OBSERVE"] {
            let built = run(role, Some(other), Some("false"), true);
            assert!(
                built.contains("must be unset, 0, 1 or observe") && built.ends_with(";writers=0"),
                "{role} {other}: {built}"
            );
        }
    }
    std::fs::remove_dir_all(dir).unwrap();
}

fn unsigned(claims: Value) -> String {
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    format!(
        "Bearer e30.{}.signature",
        URL_SAFE_NO_PAD.encode(claims.to_string())
    )
}

/// A refused token's reason is a label read from its unverified payload.
#[test]
fn a_refused_token_is_named_by_its_kind() {
    for (claims, expected) in [
        (
            json!({"uid":3,"pid":2,"conversation_id":CID,"anonymous_participant":true}),
            "token_refused",
        ),
        (
            json!({"uid":3,"pid":2,"conversation_id":"2another","anonymous_participant":true}),
            "token_other_conversation",
        ),
        (
            json!({"uid":3,"pid":2,"conversation_id":"2another","standard_user_participant":true,"oidc_sub":"s"}),
            "token_other_conversation",
        ),
        (
            json!({"uid":3,"pid":2,"conversation_id":CID,"xid_participant":true,"xid":"x"}),
            "token_xid",
        ),
        (
            json!({"uid":3,"pid":2,"conversation_id":"2another","xid_participant":true,"xid":"x"}),
            "token_xid",
        ),
        (
            json!({"iss":"https://issuer.invalid/","sub":"account","aud":"users"}),
            "token_oidc",
        ),
    ] {
        assert_eq!(
            token_reason(&unsigned(claims.clone()), CID),
            expected,
            "{claims}"
        );
    }
    for raw in ["Bearer broken", "Basic secret", ""] {
        assert_eq!(token_reason(raw, CID), "token_refused");
    }
}

/// A text marker with characters JSON escapes and no word in it, to look
/// for in output.
pub(crate) const MARKER: &str = "kq7Xw93-zvJ4\"hT2q\\Lm8Rw-ZZ41pfe8";

/// True when `output` holds the marker, its JSON-escaped form, or any eight
/// consecutive characters of either.
pub(crate) fn leaks(output: &str) -> bool {
    let escaped = serde_json::to_string(MARKER).unwrap();
    [MARKER, escaped.as_str()].iter().any(|form| {
        form.as_bytes()
            .windows(8)
            .any(|window| output.contains(std::str::from_utf8(window).unwrap()))
    })
}

/// Set in a child process to make the write panic, formatting what it holds:
/// `panic` before anything is sent, `between` after the comment's insert and
/// before the author's vote.
const PANIC_IN_WRITE: &str = "POLIS_COMMENT_TEST_PANIC_IN_WRITE";

fn panic_requested(at: &str) -> bool {
    std::env::var(PANIC_IN_WRITE).is_ok_and(|requested| requested == at)
}

/// A panic in the dispatched write, formatting every value in scope the way
/// a careless `expect` or `dbg!` would.
pub(super) fn panic_point(writable: &Writable) {
    if panic_requested("panic") {
        panic!(
            "forced panic in the comment write: {writable:?} {:?} {:#?}",
            writable.row(),
            writable.row().text
        );
    }
}

/// A panic with the comment inserted and its author's vote not yet sent.
pub(super) fn panic_between(writable: &Writable) {
    if panic_requested("between") {
        panic!("forced panic between the comment and its vote: {writable:?}");
    }
}

/// Everything the handler holds of a request, formatted: the text is a byte
/// count in each.
#[test]
fn nothing_the_handler_holds_formats_the_text() {
    let body = comment(json!({"txt": MARKER, "vote": crate::votes::WIRE_AGREE}));
    let (_, parsed) = request_reasoned(&req(&body)).unwrap();
    let admitted = Admitted {
        zid: 1,
        pid: 2,
        uid: 3,
        active: true,
        strict: false,
        existing: None,
    };
    let mut printed = format!("{parsed:?} {parsed:#?}");
    for strict in [false, true] {
        let decision = decide(
            &Admitted {
                strict,
                ..admitted.clone()
            },
            parsed.text.clone(),
            parsed.vote,
        );
        printed.push_str(&format!("{decision:?} {decision:#?}"));
        let prepared = Prepared {
            decision: decision.clone(),
            admission: Duration::ZERO,
        };
        printed.push_str(&format!("{prepared:?} {:?}", decision.live()));
    }
    assert!(!leaks(&printed), "{printed}");
    assert!(printed.contains(&format!("CommentText({} bytes)", MARKER.len())));
}

/// A panic that formats what the handler holds prints no payload: run in a
/// child process, with everything it writes captured.
#[test]
fn a_panic_while_holding_a_comment_prints_no_text() {
    const CHILD: &str = "POLIS_COMMENT_PANIC_TEST";
    if std::env::var_os(CHILD).is_some() {
        let body = comment(json!({"txt": MARKER}));
        let parsed = request_reasoned(&req(&body)).unwrap();
        // The default panic hook prints the message of `expect`: the Debug
        // form of the error it was given.
        let refused: Result<(), _> = std::hint::black_box(Err(parsed));
        refused.expect("forced panic while holding a parsed comment");
        return;
    }
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "post_comments::tests::a_panic_while_holding_a_comment_prints_no_text",
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
    assert!(!output.status.success(), "the child must have panicked");
    assert!(
        printed.contains("forced panic while holding a parsed comment")
            && printed.contains("CommentText("),
        "the panic was not captured: {printed}"
    );
    assert!(!leaks(&printed), "{printed}");
}

#[cfg(feature = "db-tests")]
pub(crate) mod database {
    use super::*;
    use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
    use polis_queue_adapter::jobs::transport::Connector;
    use postgres::NoTls;

    /// A database of this test's own, built from the migrations that make
    /// the tables a comment touches: the first, the vote rule, the vote
    /// priority column, the original id column and the comment-number
    /// trigger that holds its lock to commit. In the second pass of the suite the tables take the shape of
    /// an installation older than the migrations as they are created.
    pub(crate) struct Database {
        admin: Client,
        name: String,
        pub(crate) config: postgres::Config,
    }

    impl Database {
        pub(crate) fn new(label: &str) -> Self {
            let mut config: postgres::Config = std::env::var("POLIS_API_TEST_DATABASE_URL")
                .unwrap()
                .parse()
                .unwrap();
            let mut admin = config.connect(NoTls).unwrap();
            let name = format!("post_comments_{label}_{}", std::process::id());
            admin
                .batch_execute(&format!("CREATE DATABASE {name}"))
                .unwrap();
            config.dbname(&name);
            let db = Self {
                admin,
                name,
                config,
            };
            let mut c = db.connect();
            for migration in [
                include_str!("../../../server/postgres/migrations/000000_initial.sql"),
                include_str!("../../../server/postgres/migrations/000006_update_votes_rule.sql"),
                include_str!("../../../server/postgres/migrations/000008_add_comment_priority.sql"),
                include_str!("../../../server/postgres/migrations/000016_add_orig_id.sql"),
                include_str!(
                    "../../../server/postgres/migrations/000042_tid_auto_transaction_lock.sql"
                ),
            ] {
                c.batch_execute(migration).unwrap();
            }
            c.batch_execute(
                "ALTER TABLE conversations ADD treevite_enabled boolean DEFAULT false;
                 ALTER TABLE conversations ADD xid_required boolean NOT NULL DEFAULT false;
                 CREATE OR REPLACE FUNCTION now_as_millis() RETURNS bigint LANGUAGE sql
                 AS 'SELECT 1700000000000::bigint';",
            )
            .unwrap();
            db.seed(&mut c, 2);
            db
        }

        pub(crate) fn connect(&self) -> Client {
            self.config.connect(NoTls).unwrap()
        }

        /// The conversation of the recordings: its owner (uid 1, pid 0), a
        /// member on a site of their own (uid 2, pid 1), a participant (uid
        /// 3, pid 2), a user on the owner's site (uid 100004, pid 3), a user
        /// with no membership (uid 100005), and
        /// `comments` existing comments numbered from 0.
        pub(crate) fn seed(&self, c: &mut Client, comments: i32) {
            c.batch_execute(
                "TRUNCATE users, conversations, participants, comments, zinvites,
                     notification_tasks, votes, votes_latest_unique CASCADE;
                 INSERT INTO users(uid, site_id) VALUES (1, 'p027-owner'), (2, 'generated-admin'),
                     (3, 'generated-participant'), (100004, 'p027-owner'),
                     (100005, 'generated-first-standard');
                 INSERT INTO conversations(zid, owner, is_active) VALUES (1, 1, true), (2, 1, true);
                 INSERT INTO zinvites(zid, zinvite) VALUES (1, '2p027generated'), (2, '2p027foreign');
                 ALTER TABLE participants DISABLE TRIGGER USER;
                 INSERT INTO participants(zid, uid, pid) VALUES (1, 1, 0), (1, 2, 1), (1, 3, 2), (1, 100004, 3);
                 ALTER TABLE participants ENABLE TRIGGER USER;",
            )
            .unwrap();
            for tid in 0..comments {
                c.execute(
                    "INSERT INTO comments(zid, pid, uid, txt) VALUES (1, 2, 3, $1)",
                    &[&format!("Generated existing {tid}")],
                )
                .unwrap();
            }
        }
    }

    impl Drop for Database {
        fn drop(&mut self) {
            self.admin
                .batch_execute(&format!("DROP DATABASE {} WITH (FORCE)", self.name))
                .unwrap();
        }
    }

    pub(crate) struct Fixture {
        pub(crate) app: Arc<App>,
        pub(crate) key: EncodingKey,
    }

    pub(crate) fn app_config() -> config::Config {
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

    /// The live comment handler on `db`, with a signing key of its own.
    pub(crate) fn writer(db: &Database, admins: Vec<i32>) -> (Writer, EncodingKey) {
        writer_with(db, admins, writer_limits())
    }

    /// As `writer`, with other bounds on the insert's pool.
    pub(crate) fn writer_with(
        db: &Database,
        admins: Vec<i32>,
        insert_limits: db::Limits,
    ) -> (Writer, EncodingKey) {
        let rsa = openssl::rsa::Rsa::generate(2048).unwrap();
        (
            writer_on(
                &db.config,
                &rsa.public_key_to_pem().unwrap(),
                admins,
                insert_limits,
            ),
            EncodingKey::from_rsa_pem(&rsa.private_key_to_pem().unwrap()).unwrap(),
        )
    }

    /// The live comment handler on any database, verifying tokens with
    /// `public_pem` (issuer and audience `fixture`).
    pub(crate) fn writer_on(
        config: &postgres::Config,
        public_pem: &[u8],
        admins: Vec<i32>,
        insert_limits: db::Limits,
    ) -> Writer {
        let connector = || Connector::Plain(Box::new(config.clone()));
        Writer {
            budget: insert_limits.statement_timeout,
            pool: db::Pool::writer(connector(), insert_limits),
            reads: db::Pool::new(connector(), read_limits()),
            background: Background::new(db::Pool::writer(connector(), background_limits())),
            verifier: participant::Verifier::new(public_pem, "fixture", "fixture").unwrap(),
            admins,
            reasons: Mutex::default(),
        }
    }

    /// The insert pool's bounds with a statement bound no test reaches, for
    /// the tests that hold an insert at the comment-number lock.
    pub(crate) fn patient_insert_limits() -> db::Limits {
        db::Limits {
            statement_timeout: Duration::from_secs(60),
            ..writer_limits()
        }
    }

    /// Lets this database's comment inserts wait for the comment-number lock
    /// as long as it is held: the trigger runs before the comment-number
    /// trigger (by name) and lifts the pool's lock bound for the statement.
    pub(crate) const PATIENT_INSERTS: &str =
        "CREATE FUNCTION patient() RETURNS trigger LANGUAGE plpgsql AS
         $$ BEGIN PERFORM set_config('lock_timeout', '0', true); RETURN NEW; END $$;
         CREATE TRIGGER a_patient BEFORE INSERT ON comments
         FOR EACH ROW EXECUTE FUNCTION patient();";

    /// Another writer holding conversation `zid`'s comment-number lock.
    pub(crate) fn hold_comment_number_lock(config: &postgres::Config, zid: i32) -> Client {
        let mut holder = config.connect(NoTls).unwrap();
        holder
            .batch_execute(&format!(
                "BEGIN; SELECT pg_advisory_xact_lock(873791984, {zid});"
            ))
            .unwrap();
        holder
    }

    pub(crate) fn fixture_of(db: &Database, writer: Writer, key: EncodingKey) -> Fixture {
        let mut app = App::new(
            &app_config(),
            db::Pool::new(Connector::Plain(Box::new(db.config.clone())), read_limits()),
        );
        app.post_comments = Some(writer);
        Fixture {
            app: Arc::new(app),
            key,
        }
    }

    pub(crate) fn setup_with(db: &Database, admins: Vec<i32>) -> Fixture {
        let (writer, key) = writer(db, admins);
        fixture_of(db, writer, key)
    }

    pub(crate) fn setup(db: &Database) -> Fixture {
        setup_with(db, vec![])
    }

    /// The participant's token: uid 3, pid 2, this conversation.
    pub(crate) fn member() -> Value {
        json!({"uid":3,"pid":2,"conversation_id":CID,"sub":"anon:3","iss":"fixture",
            "aud":"fixture","iat":1600000000_u64,"exp":4100000000_u64,
            "anonymous_participant":true})
    }

    pub(crate) fn standard(uid: i32, pid: i32) -> Value {
        json!({"uid":uid,"pid":pid,"conversation_id":CID,"sub":"user:generated-standard",
            "iss":"fixture","aud":"fixture","iat":1600000000_u64,"exp":4100000000_u64,
            "standard_user_participant":true,"oidc_sub":"generated-standard"})
    }

    pub(crate) fn bearer(key: &EncodingKey, claims: &Value) -> String {
        format!(
            "Bearer {}",
            encode(&Header::new(Algorithm::RS256), claims, key).unwrap()
        )
    }

    pub(crate) fn signed(key: &EncodingKey, claims: &Value, body: &str) -> Request {
        let mut r = req(body);
        r.headers = Headers::from_raw([
            ("host", "localhost:5000"),
            ("content-type", "application/json"),
            ("x-forwarded-proto", "https"),
            ("authorization", &bearer(key, claims)),
        ]);
        r
    }

    pub(crate) fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap()
    }

    pub(crate) fn body_of(out: &Outgoing) -> String {
        match &out.body {
            crate::http::Body::Empty => String::new(),
            crate::http::Body::Fixed(bytes) => String::from_utf8(bytes.clone()).unwrap(),
            crate::http::Body::Chunked(chunks) => String::from_utf8(chunks.concat()).unwrap(),
        }
    }

    /// The durable tables a comment can touch, as text, for "nothing was
    /// written" comparisons.
    pub(crate) fn snapshot(c: &mut Client) -> Vec<String> {
        [
            "users",
            "conversations",
            "participants",
            "participants_extended",
            "comments",
            "notification_tasks",
            "votes",
            "votes_latest_unique",
            "zinvites",
            "xids",
        ]
        .iter()
        .map(|table| {
            c.query_one(
                &format!("select coalesce(json_agg(t order by t::text),'[]')::text from {table} t"),
                &[],
            )
            .unwrap()
            .get(0)
        })
        .collect()
    }

    /// Waits for the notification lane to finish what it was given.
    pub(crate) fn settle(rt: &tokio::runtime::Runtime, app: &App) {
        let lane = &app.post_comments.as_ref().unwrap().background;
        rt.block_on(async {
            tokio::time::timeout(Duration::from_secs(10), async {
                while lane.admitted.available_permits() != BACKGROUND_MAX_PENDING {
                    tokio::time::sleep(Duration::from_millis(2)).await;
                }
            })
            .await
            .expect("notification work did not finish");
        });
    }

    pub(crate) fn send(
        rt: &tokio::runtime::Runtime,
        fixture: &Fixture,
        claims: &Value,
        body: &str,
    ) -> Outgoing {
        let out = rt.block_on(route::handle(
            fixture.app.clone(),
            signed(&fixture.key, claims, body),
        ));
        settle(rt, &fixture.app);
        out
    }

    fn count(c: &mut Client, sql: &str) -> i64 {
        c.query_one(sql, &[]).unwrap().get(0)
    }

    fn marked(out: &Outgoing, how: &str) -> bool {
        let marks: Vec<&str> = out
            .headers
            .iter()
            .filter(|(k, _)| k == "X-Polis-Comment-Dispatch")
            .map(|(_, v)| v.as_str())
            .collect();
        out.status == 502 && marks == [how]
    }

    /// Handed back before the write was dispatched.
    fn handed_back(out: &Outgoing) -> bool {
        marked(out, "not-started")
    }

    /// Handed back after the database refused the write: nothing is stored.
    fn refused_by_database(out: &Outgoing) -> bool {
        marked(out, "refused")
    }

    /// An ordinary comment by a member: Node's reply, Node's row, Node's two
    /// best-effort writes, and no vote the request did not carry.
    #[test]
    fn a_members_comment_is_stored_as_node_stores_it() {
        let db = Database::new("stored");
        let mut c = db.connect();
        let rt = runtime();
        let fixture = setup(&db);
        c.batch_execute("UPDATE participants SET last_interaction = 5, nsli = 3 WHERE uid = 3")
            .unwrap();
        let out = send(
            &rt,
            &fixture,
            &member(),
            &comment(json!({"txt": "  Generated stored comment  ", "pid": NO_PID, "agid": 1})),
        );
        assert_eq!(out.status, 200);
        assert_eq!(body_of(&out), r#"{"tid":2,"currentPid":2}"#);
        let row = c
            .query_one(
                "select pid, uid, txt, velocity, active, mod, anon, is_seed, lang,
                 lang_confidence, created, is_meta from comments where zid = 1 and tid = 2",
                &[],
            )
            .unwrap();
        assert_eq!(row.get::<_, i32>(0), 2);
        assert_eq!(row.get::<_, i32>(1), 3);
        assert_eq!(row.get::<_, String>(2), "Generated stored comment");
        assert_eq!(row.get::<_, Option<f32>>(3), Some(1.0));
        assert!(row.get::<_, bool>(4));
        assert_eq!(row.get::<_, i32>(5), 0);
        assert!(!row.get::<_, bool>(6));
        assert!(!row.get::<_, bool>(7));
        assert_eq!(row.get::<_, Option<String>>(8), None);
        assert_eq!(row.get::<_, Option<f32>>(9), None);
        assert_eq!(row.get::<_, Option<i64>>(10), Some(1700000000000));
        assert!(!row.get::<_, bool>(11));
        assert_eq!(count(&mut c, "select count(*) from votes"), 0);
        assert_eq!(count(&mut c, "select count(*) from votes_latest_unique"), 0);
        assert_eq!(
            count(
                &mut c,
                "select count(*) from notification_tasks where zid = 1 and modified = 1700000000000"
            ),
            1
        );
        let touched = c
            .query_one(
                "select last_interaction, nsli from participants where zid = 1 and uid = 3",
                &[],
            )
            .unwrap();
        assert_eq!(touched.get::<_, i64>(0), 1700000000000);
        assert_eq!(touched.get::<_, i16>(1), 0);
        // The same text again is Node's 409, and a closed conversation its
        // 403; the duplicate is answered first.
        let again = send(
            &rt,
            &fixture,
            &member(),
            &comment(json!({"txt": "Generated stored comment"})),
        );
        assert_eq!(again.status, 409);
        assert_eq!(
            body_of(&again),
            r#"{"error":"polis_err_post_comment_duplicate","message":"polis_err_post_comment_duplicate","status":409}"#
        );
        c.batch_execute("UPDATE conversations SET is_active = false WHERE zid = 1")
            .unwrap();
        let before = snapshot(&mut c);
        let closed_duplicate = send(
            &rt,
            &fixture,
            &member(),
            &comment(json!({"txt": "Generated stored comment"})),
        );
        assert_eq!(closed_duplicate.status, 409);
        let closed = send(
            &rt,
            &fixture,
            &member(),
            &comment(json!({"txt": "Generated closed"})),
        );
        assert_eq!(closed.status, 403);
        assert_eq!(
            body_of(&closed),
            r#"{"error":"polis_err_conversation_is_closed","message":"polis_err_conversation_is_closed","status":403}"#
        );
        assert_eq!(snapshot(&mut c), before);
        drop(fixture);
        drop(rt);
    }

    /// The author's vote: stored only when the request carries one, after
    /// the comment, with the value the vote convention gives for the choice,
    /// weight 0 and no priority, and the latest-vote row the table's rule
    /// keeps. Each wire value Node accepts is read as the same choice.
    #[test]
    fn the_authors_vote_is_stored_through_the_convention() {
        let db = Database::new("author_vote");
        let mut c = db.connect();
        let rt = runtime();
        let fixture = setup(&db);
        for (index, choice) in [VoteChoice::Agree, VoteChoice::Disagree, VoteChoice::Pass]
            .into_iter()
            .enumerate()
        {
            let out = send(
                &rt,
                &fixture,
                &member(),
                &comment(json!({"txt": format!("Generated voted {index}"), "vote": choice.wire()})),
            );
            assert_eq!(out.status, 200);
            let tid = 2 + index as i32;
            assert_eq!(body_of(&out), format!(r#"{{"tid":{tid},"currentPid":2}}"#));
            let history = c
                .query(
                    "select vote, weight_x_32767, high_priority, created from votes
                     where zid = 1 and pid = 2 and tid = $1",
                    &[&tid],
                )
                .unwrap();
            assert_eq!(history.len(), 1, "{choice:?}");
            let stored = history[0].get::<_, Option<i16>>(0).map(i32::from);
            assert_eq!(stored, contract::author_vote(Some(choice)));
            assert_eq!(StorageConvention::CURRENT.decode(stored), Some(choice));
            assert_eq!(history[0].get::<_, Option<i16>>(1), Some(0));
            assert!(!history[0].get::<_, bool>(2));
            assert_eq!(history[0].get::<_, Option<i64>>(3), Some(1700000000000));
            let latest = c
                .query(
                    "select vote, modified from votes_latest_unique
                     where zid = 1 and pid = 2 and tid = $1",
                    &[&tid],
                )
                .unwrap();
            assert_eq!(latest.len(), 1);
            assert_eq!(latest[0].get::<_, Option<i16>>(0).map(i32::from), stored);
        }
        // Node's integer parser reads a prefix; a null vote is no vote.
        let pass = VoteChoice::Pass.wire();
        for (text, vote, expected) in [
            (
                "prefix",
                json!(format!("{pass}suffix")),
                Some(VoteChoice::Pass),
            ),
            (
                "fraction",
                json!(format!("{pass}.9")),
                Some(VoteChoice::Pass),
            ),
            ("null", Value::Null, None),
        ] {
            let out = send(
                &rt,
                &fixture,
                &member(),
                &comment(json!({"txt": format!("Generated {text}"), "vote": vote})),
            );
            assert_eq!(out.status, 200, "{text}");
            let tid: i32 = serde_json::from_str::<Value>(&body_of(&out)).unwrap()["tid"]
                .as_i64()
                .unwrap() as i32;
            let stored: Vec<Option<VoteChoice>> = c
                .query("select vote from votes where zid = 1 and tid = $1", &[&tid])
                .unwrap()
                .iter()
                .map(|row| {
                    StorageConvention::CURRENT.decode(row.get::<_, Option<i16>>(0).map(i32::from))
                })
                .collect();
            assert_eq!(stored, expected.map(Some).into_iter().collect::<Vec<_>>());
        }
        drop(fixture);
        drop(rt);
    }

    /// The handler's own write of the author's vote, from the choice, under
    /// each of the two storage conventions: the value stored is that
    /// convention's for the choice, and reads back as the choice under that
    /// convention and no other (but for pass, which both store alike). One of
    /// the two conventions has other numbers than the wire, so a write that
    /// stored the wire value in place of the convention's fails here; the
    /// test through the route cannot see that while the current convention
    /// and the wire give the same numbers.
    #[test]
    fn the_authors_vote_follows_either_storage_convention() {
        let db = Database::new("conventions");
        let mut c = db.connect();
        let current = StorageConvention::CURRENT;
        // The other convention's agree value is this one's disagree value.
        let other = StorageConvention {
            agree: current.encode(VoteChoice::Disagree),
        };
        assert_ne!(current.agree, other.agree);
        let choices = [VoteChoice::Agree, VoteChoice::Disagree, VoteChoice::Pass];
        // Exactly one of the two stores agree and disagree as other numbers
        // than the wire's.
        let unlike_the_wire = |convention: StorageConvention| {
            choices
                .iter()
                .any(|choice| convention.encode(*choice) != i32::from(choice.wire()))
        };
        assert_ne!(unlike_the_wire(current), unlike_the_wire(other));
        // A row the handler may write: the participant's, in the open
        // conversation that is not strict.
        let Live::Write(row) = decide(
            &Admitted {
                zid: 1,
                pid: 2,
                uid: 3,
                active: true,
                strict: false,
                existing: None,
            },
            CommentText::new("unused".into()),
            None,
        )
        .live() else {
            panic!("an open conversation that is not strict is written");
        };
        let mut tid = 100;
        for (convention, opposite) in [(current, other), (other, current)] {
            for choice in choices {
                tid += 1;
                author_vote_under(&mut c, &row, tid, choice, convention).unwrap();
                for table in ["votes", "votes_latest_unique"] {
                    let read = c
                        .query_one(
                            &format!(
                                "select vote from {table} where zid = 1 and pid = 2 and tid = $1"
                            ),
                            &[&tid],
                        )
                        .unwrap()
                        .get::<_, Option<i16>>(0)
                        .map(i32::from);
                    assert_eq!(read, Some(convention.encode(choice)), "{table} {choice:?}");
                    assert_eq!(convention.decode(read), Some(choice), "{table}");
                    assert_eq!(
                        opposite.decode(read) == Some(choice),
                        choice == VoteChoice::Pass,
                        "{table} {choice:?}"
                    );
                }
            }
        }
        // The live path writes under the current convention, the value the
        // comment contract gives for the choice.
        for choice in choices {
            tid += 1;
            author_vote(&mut c, &row, tid, choice).unwrap();
            let read = c
                .query_one(
                    "select vote from votes where zid = 1 and pid = 2 and tid = $1",
                    &[&tid],
                )
                .unwrap()
                .get::<_, Option<i16>>(0)
                .map(i32::from);
            assert_eq!(read, contract::author_vote(Some(choice)));
            assert_eq!(read, Some(current.encode(choice)));
        }
        assert_eq!(contract::author_vote(None), None);
        // A closed conversation refuses the vote under any convention.
        c.batch_execute("UPDATE conversations SET is_active = false WHERE zid = 1")
            .unwrap();
        assert!(author_vote_under(&mut c, &row, tid + 1, VoteChoice::Agree, other).is_err());
        assert_eq!(
            c.query_one(
                "select count(*) from votes where zid = 1 and tid = $1",
                &[&(tid + 1)]
            )
            .unwrap()
            .get::<_, i64>(0),
            0
        );
    }

    /// The comment and its author's vote are one transaction. A vote that
    /// fails after the comment's insert rolls both back: nothing is stored,
    /// and the request is handed back to Node, marked as refused by the
    /// database, so that Node answers it in its own way. No comment is left
    /// without its author's vote by this handler.
    #[test]
    fn a_failed_authors_vote_stores_nothing_and_is_handed_back() {
        let db = Database::new("vote_failure");
        let mut c = db.connect();
        let rt = runtime();
        let fixture = setup(&db);
        let writer = fixture.app.post_comments.as_ref().unwrap();
        let body = comment(json!({
            "txt": "Generated with a failing vote", "vote": crate::votes::WIRE_AGREE
        }));
        for (code, reason) in [
            ("XX000", "author_vote_refused"),
            ("55P03", "author_vote_lock_timeout"),
            ("57014", "author_vote_canceled"),
        ] {
            c.batch_execute(&format!(
                "CREATE FUNCTION vote_fault() RETURNS trigger LANGUAGE plpgsql AS
                 $$ BEGIN RAISE EXCEPTION 'generated vote failure' USING ERRCODE='{code}'; END $$;
                 CREATE TRIGGER vote_fault BEFORE INSERT ON votes
                 FOR EACH ROW EXECUTE FUNCTION vote_fault();"
            ))
            .unwrap();
            let before = snapshot(&mut c);
            let out = send(&rt, &fixture, &member(), &body);
            assert!(refused_by_database(&out), "{code}: {}", out.status);
            assert_eq!(writer.counted(reason), 1, "{code}");
            assert_eq!(snapshot(&mut c), before, "{code}: something was stored");
            c.batch_execute("DROP FUNCTION vote_fault() CASCADE")
                .unwrap();
        }
        // The same request once the vote can be stored: both rows, together.
        let out = send(&rt, &fixture, &member(), &body);
        assert_eq!(out.status, 200);
        assert_eq!(
            count(
                &mut c,
                "select count(*) from comments m join votes v using (zid, tid)
                 where m.txt = 'Generated with a failing vote'"
            ),
            1
        );
        drop(fixture);
        drop(rt);
    }

    /// The transaction's statements share the insert pool's one second. An
    /// insert that used most of it leaves the vote's statements the rest, so
    /// a vote the database then cannot store in time is refused, rolled back
    /// with its comment and handed back before the reply deadline answers
    /// "unknown". With a second for each statement the refusal would come
    /// after the deadline, as a 500 with nothing stored.
    #[test]
    fn a_slow_vote_after_a_slow_insert_is_handed_back_before_the_reply_deadline() {
        let db = Database::new("shared_second");
        let mut c = db.connect();
        let rt = runtime();
        let fixture = setup(&db);
        let writer = fixture.app.post_comments.as_ref().unwrap();
        // The insert takes 0.7 s of the second; the vote's insert never ends.
        c.batch_execute(
            "CREATE FUNCTION slow_insert() RETURNS trigger LANGUAGE plpgsql AS
             $$ BEGIN PERFORM pg_sleep(0.7); RETURN NEW; END $$;
             CREATE TRIGGER slow_insert BEFORE INSERT ON comments
             FOR EACH ROW EXECUTE FUNCTION slow_insert();
             CREATE FUNCTION slow_vote() RETURNS trigger LANGUAGE plpgsql AS
             $$ BEGIN PERFORM pg_sleep(30); RETURN NEW; END $$;
             CREATE TRIGGER slow_vote BEFORE INSERT ON votes
             FOR EACH ROW EXECUTE FUNCTION slow_vote();",
        )
        .unwrap();
        let body = comment(json!({
            "txt": "Generated slow insert and slower vote", "vote": crate::votes::WIRE_AGREE
        }));
        let before = snapshot(&mut c);
        let started = std::time::Instant::now();
        let out = send(&rt, &fixture, &member(), &body);
        let elapsed = started.elapsed();
        assert!(
            refused_by_database(&out),
            "{} after {elapsed:?}",
            out.status
        );
        assert!(elapsed < DISPATCH_DEADLINE, "{elapsed:?}");
        assert_eq!(writer.counted("author_vote_canceled"), 1);
        assert_eq!(snapshot(&mut c), before);
        drop(fixture);
        drop(rt);
    }

    /// Node's vote function reads the conversation again and refuses a
    /// closed one. Inside the transaction that refusal rolls the comment
    /// back too: nothing is stored and the request is handed back.
    #[test]
    fn a_conversation_closed_before_the_vote_stores_nothing_and_is_handed_back() {
        let db = Database::new("vote_closed");
        let mut c = db.connect();
        let rt = runtime();
        let fixture = setup(&db);
        let writer = fixture.app.post_comments.as_ref().unwrap();
        c.batch_execute(
            "CREATE FUNCTION close_after_comment() RETURNS trigger LANGUAGE plpgsql AS
             $$ BEGIN UPDATE conversations SET is_active = false WHERE zid = NEW.zid; RETURN NEW; END $$;
             CREATE TRIGGER close_after_comment AFTER INSERT ON comments
             FOR EACH ROW EXECUTE FUNCTION close_after_comment();",
        )
        .unwrap();
        let before = snapshot(&mut c);
        let out = send(
            &rt,
            &fixture,
            &member(),
            &comment(json!({"txt": "Generated closing", "vote": crate::votes::WIRE_PASS})),
        );
        assert!(refused_by_database(&out), "{}", out.status);
        assert_eq!(writer.counted("closed_before_vote"), 1);
        // The comment, and in this fixture the close its trigger made, are
        // rolled back with the transaction.
        assert_eq!(snapshot(&mut c), before);
        // Without a vote there is no second read: the comment is stored.
        let out = send(
            &rt,
            &fixture,
            &member(),
            &comment(json!({"txt": "Generated closing without a vote"})),
        );
        assert_eq!(out.status, 200);
        drop(fixture);
        drop(rt);
    }

    /// A conversation with strict moderation reaches a decision: the row
    /// Node would store (the same row as anywhere else), Node's reply, and
    /// the moderator email in place of the notification task. The live
    /// handler hands it back with its own reason and writes nothing.
    #[test]
    fn a_strict_conversation_is_decided_and_never_written_by_the_live_handler() {
        let db = Database::new("strict");
        let mut c = db.connect();
        let rt = runtime();
        let fixture = setup(&db);
        c.batch_execute("UPDATE conversations SET strict_moderation = true WHERE zid = 1")
            .unwrap();
        let writer = fixture.app.post_comments.as_ref().unwrap();
        for vote in [None, Some(VoteChoice::Agree), Some(VoteChoice::Pass)] {
            let body = comment(json!({
                "txt": "Generated strict comment", "vote": vote.map(VoteChoice::wire)
            }));
            let request = signed(&fixture.key, &member(), &body);
            let prepared = rt
                .block_on(prepare(writer.admission(), &request))
                .expect("a strict conversation reaches a decision");
            assert!(prepared.decision.strict);
            assert_eq!(prepared.decision.zid, 1);
            assert_eq!(prepared.decision.status(), 200);
            let Outcome::Store(store) = &prepared.decision.outcome else {
                panic!("Node stores this comment");
            };
            assert!(matches!(store, Store::Strict(_)));
            assert_eq!(store.after_insert(), AfterInsert::ModeratorEmail);
            let row = store.row();
            assert_eq!((row.zid, row.pid, row.uid, row.vote), (1, 2, 3, vote));
            assert_eq!(row.text.bytes(), "Generated strict comment".len());
            assert!(matches!(
                prepared.decision.live(),
                Live::HandBack("strict_moderation")
            ));
            // Through the route: handed back before dispatch, nothing written.
            let before = snapshot(&mut c);
            let counted = writer.counted("strict_moderation");
            let out = send(&rt, &fixture, &member(), &body);
            assert!(handed_back(&out), "{}", out.status);
            assert_eq!(writer.counted("strict_moderation"), counted + 1);
            assert_eq!(snapshot(&mut c), before);
        }
        // A duplicate and a closed conversation are Node's own answers in a
        // strict conversation too: nothing is stored and no email is sent.
        let duplicate = send(
            &rt,
            &fixture,
            &member(),
            &comment(json!({"txt": "Generated existing 0"})),
        );
        assert_eq!(duplicate.status, 409);
        c.batch_execute("UPDATE conversations SET is_active = false WHERE zid = 1")
            .unwrap();
        let closed = send(
            &rt,
            &fixture,
            &member(),
            &comment(json!({"txt": "Generated strict closed"})),
        );
        assert_eq!(closed.status, 403);
        // The same request in a conversation that is not strict is written.
        c.batch_execute(
            "UPDATE conversations SET is_active = true, strict_moderation = false WHERE zid = 1",
        )
        .unwrap();
        let out = send(
            &rt,
            &fixture,
            &member(),
            &comment(json!({"txt": "Generated strict comment"})),
        );
        assert_eq!(out.status, 200);
        drop(fixture);
        drop(rt);
    }

    /// Everything that stays Node's, each under its own reason, with nothing
    /// written.
    #[test]
    fn every_hand_back_has_its_own_reason_and_writes_nothing() {
        let db = Database::new("handbacks");
        let mut c = db.connect();
        let rt = runtime();
        let fixture = setup_with(&db, vec![424242]);
        let writer = fixture.app.post_comments.as_ref().unwrap();
        let plain = comment(json!({}));
        let check = |label: &str, c: &mut Client, request: Request, expected: &'static str| {
            let before = snapshot(c);
            let counted = writer.counted(expected);
            let out = rt.block_on(route::handle(fixture.app.clone(), request));
            settle(&rt, &fixture.app);
            assert!(handed_back(&out), "{label}: {}", out.status);
            assert_eq!(writer.counted(expected), counted + 1, "{label}: {expected}");
            assert_eq!(snapshot(c), before, "{label}");
        };
        // No token: a person's first action, or a client that holds none.
        let mut anonymous = req(&plain);
        anonymous.headers = Headers::from_raw([
            ("content-type", "application/json"),
            ("x-forwarded-proto", "https"),
            ("cookie", "token2=generated"),
        ]);
        check("no token", &mut c, anonymous, "no_token");
        // Tokens the verifier does not accept.
        let mut oidc = req(&plain);
        oidc.headers = Headers::from_raw([
            ("content-type", "application/json"),
            ("x-forwarded-proto", "https"),
            (
                "authorization",
                &unsigned(json!({"iss":"https://issuer.invalid/","sub":"account"})),
            ),
        ]);
        check("OIDC token", &mut c, oidc, "token_oidc");
        let mut xid = member();
        xid.as_object_mut().unwrap().remove("anonymous_participant");
        xid["xid_participant"] = json!(true);
        xid["xid"] = json!("generated-member");
        xid["sub"] = json!("xid:generated-member");
        check(
            "XID token",
            &mut c,
            signed(&fixture.key, &xid, &plain),
            "token_xid",
        );
        let mut foreign = member();
        foreign["conversation_id"] = json!("2p027foreign");
        check(
            "token for another conversation",
            &mut c,
            signed(&fixture.key, &foreign, &plain),
            "token_other_conversation",
        );
        let mut expired = member();
        expired["exp"] = json!(1600000001_u64);
        check(
            "expired token",
            &mut c,
            signed(&fixture.key, &expired, &plain),
            "token_refused",
        );
        // A listed admin.
        let mut admin = member();
        admin["uid"] = json!(424242);
        admin["sub"] = json!("anon:424242");
        check(
            "admin",
            &mut c,
            signed(&fixture.key, &admin, &plain),
            "admin",
        );
        // No existing membership: creating a participant stays Node's.
        check(
            "no membership",
            &mut c,
            signed(&fixture.key, &standard(100005, 0), &plain),
            "not_a_participant",
        );
        let mut wrong_pid = member();
        wrong_pid["pid"] = json!(5);
        check(
            "another pid than the member's",
            &mut c,
            signed(&fixture.key, &wrong_pid, &plain),
            "not_a_participant",
        );
        // The owner, and a user on the owner's site: moderators.
        let mut owner = member();
        owner["uid"] = json!(1);
        owner["pid"] = json!(0);
        owner["sub"] = json!("anon:1");
        check(
            "owner",
            &mut c,
            signed(&fixture.key, &owner, &plain),
            "moderator",
        );
        check(
            "user on the owner's site",
            &mut c,
            signed(&fixture.key, &standard(100004, 3), &plain),
            "moderator",
        );
        // Conversation settings.
        for (setting, expected) in [
            ("treevite_enabled", "treevite"),
            ("xid_required", "xid_required"),
            ("use_xid_whitelist", "xid_allowlist"),
        ] {
            c.batch_execute(&format!(
                "UPDATE conversations SET {setting} = true WHERE zid = 1"
            ))
            .unwrap();
            check(
                setting,
                &mut c,
                signed(&fixture.key, &member(), &plain),
                expected,
            );
            c.batch_execute(&format!(
                "UPDATE conversations SET {setting} = false WHERE zid = 1"
            ))
            .unwrap();
        }
        // The request's own content.
        for (extra, expected) in [
            (json!({"is_seed": true}), "is_seed"),
            (json!({"txt": ""}), "txt_empty"),
            (json!({"txt": "x".repeat(998)}), "txt_invalid"),
            (json!({"vote": 2}), "vote_invalid"),
            (json!({"xid": "generated-member"}), "xid_key"),
            (json!({"x_name": "Generated"}), "xid_profile_key"),
            (json!({"unknown": true}), "shape_keys"),
        ] {
            check(
                expected,
                &mut c,
                signed(&fixture.key, &member(), &comment(extra)),
                expected,
            );
        }
        let mut insecure = signed(&fixture.key, &member(), &plain);
        insecure.headers = Headers::from_raw([
            ("content-type", "application/json"),
            ("authorization", &bearer(&fixture.key, &member())),
        ]);
        check("not https", &mut c, insecure, "not_https");
        // Admission that cannot read: the participants table is locked.
        let before = snapshot(&mut c);
        let mut blocker = db.connect();
        blocker
            .batch_execute("BEGIN; LOCK TABLE participants IN ACCESS EXCLUSIVE MODE")
            .unwrap();
        let out = rt.block_on(route::handle(
            fixture.app.clone(),
            signed(&fixture.key, &member(), &plain),
        ));
        assert!(handed_back(&out));
        assert_eq!(
            writer.counted("admission_unavailable") + writer.counted("admission_timeout"),
            1
        );
        blocker.batch_execute("ROLLBACK").unwrap();
        assert_eq!(snapshot(&mut c), before);
        // And the same member's ordinary comment is served.
        assert_eq!(send(&rt, &fixture, &member(), &plain).status, 200);
        // Switched off: every request is handed back, with nothing built.
        let mut off = App::new(
            &app_config(),
            db::Pool::new(Connector::Plain(Box::new(db.config.clone())), read_limits()),
        );
        off.post_comments = None;
        let before = snapshot(&mut c);
        let out = rt.block_on(route::handle(
            Arc::new(off),
            signed(
                &fixture.key,
                &member(),
                &comment(json!({"txt": "Generated off"})),
            ),
        ));
        assert!(handed_back(&out));
        assert_eq!(snapshot(&mut c), before);
        drop(fixture);
        drop(rt);
    }

    /// Node's answers to a failed insert, and never a hand-back once the
    /// insert is dispatched. The text's unique key has one name in a database
    /// built from the migrations and another in an older installation; both
    /// are a duplicate, and the comment-number key is not.
    #[test]
    fn a_failed_insert_is_answered_as_node_answers_it_and_never_handed_back() {
        let db = Database::new("faults");
        let mut c = db.connect();
        let rt = runtime();
        let fixture = setup(&db);
        for (code, constraint, status, error) in [
            (
                "23505",
                "comments_zid_txt_key",
                409,
                "polis_err_post_comment_duplicate",
            ),
            (
                "23505",
                "comments_txt_unique_constraint",
                409,
                "polis_err_post_comment_duplicate",
            ),
            (
                "23505",
                "comments_zid_tid_key",
                500,
                "polis_err_post_comment",
            ),
            (
                "23505",
                "comments_tid_unique_constraint",
                500,
                "polis_err_post_comment",
            ),
            (
                "23503",
                "comments_zid_pid_fkey",
                500,
                "polis_err_post_comment_participant_race_condition",
            ),
            (
                "23503",
                "comments_zid_fkey",
                500,
                "polis_err_post_comment_constraint_violation",
            ),
            ("XX000", "other", 500, "polis_err_post_comment"),
        ] {
            c.batch_execute(&format!(
                "CREATE FUNCTION writer_fault() RETURNS trigger LANGUAGE plpgsql AS
                 $$ BEGIN RAISE EXCEPTION 'generated failure' USING ERRCODE='{code}', CONSTRAINT='{constraint}'; END $$;
                 CREATE TRIGGER writer_fault BEFORE INSERT ON comments
                 FOR EACH ROW EXECUTE FUNCTION writer_fault();"
            ))
            .unwrap();
            let before = snapshot(&mut c);
            let out = send(
                &rt,
                &fixture,
                &member(),
                &comment(json!({"txt": "Generated fault"})),
            );
            assert_eq!(out.status, status, "{constraint}");
            assert_eq!(
                body_of(&out),
                format!(r#"{{"error":"{error}","message":"{error}","status":{status}}}"#)
            );
            assert_eq!(snapshot(&mut c), before);
            c.batch_execute("DROP FUNCTION writer_fault() CASCADE")
                .unwrap();
        }
        // The real key, under the name an older installation gives it: a
        // comment that appears between admission and the insert.
        c.batch_execute(
            "ALTER TABLE comments RENAME CONSTRAINT comments_zid_txt_key TO comments_txt_unique_constraint;
             CREATE FUNCTION racing_comment() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
               IF NEW.txt = 'Generated race' AND pg_trigger_depth() = 1 THEN
                 INSERT INTO comments(zid, pid, uid, txt, tid) VALUES (NEW.zid, NEW.pid, NEW.uid, NEW.txt, 900);
               END IF;
               RETURN NEW; END $$;
             CREATE TRIGGER a_racing_comment BEFORE INSERT ON comments
             FOR EACH ROW EXECUTE FUNCTION racing_comment();",
        )
        .unwrap();
        let out = send(
            &rt,
            &fixture,
            &member(),
            &comment(json!({"txt": "Generated race"})),
        );
        assert_eq!(out.status, 409);
        assert_eq!(
            body_of(&out),
            r#"{"error":"polis_err_post_comment_duplicate","message":"polis_err_post_comment_duplicate","status":409}"#
        );
        c.batch_execute("DROP FUNCTION racing_comment() CASCADE")
            .unwrap();
        assert_eq!(
            send(
                &rt,
                &fixture,
                &member(),
                &comment(json!({"txt": "Generated after faults"}))
            )
            .status,
            200
        );
        drop(fixture);
        drop(rt);
    }

    /// With every writer connection busy, no statement of this comment is
    /// sent, so Node can still be asked: the request is handed back, marked,
    /// and nothing is stored. A comment is not refused for want of a slot.
    #[test]
    fn a_full_writer_pool_hands_back_before_anything_is_sent() {
        let db = Database::new("writer_full");
        let mut c = db.connect();
        let rt = runtime();
        let fixture = setup(&db);
        let writer = fixture.app.post_comments.as_ref().unwrap();
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let mut releases = Vec::new();
        let mut held = Vec::new();
        for _ in 0..writer_limits().size {
            let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
            releases.push(release_tx);
            let entered_tx = entered_tx.clone();
            let pool = writer.pool.clone();
            held.push(rt.spawn(async move {
                pool.with(move |_| {
                    entered_tx.send(()).unwrap();
                    let _ = release_rx.recv_timeout(Duration::from_secs(20));
                    Ok(())
                })
                .await
            }));
        }
        for _ in 0..writer_limits().size {
            entered_rx.recv_timeout(Duration::from_secs(10)).unwrap();
        }
        let before = snapshot(&mut c);
        let out = send(
            &rt,
            &fixture,
            &member(),
            &comment(json!({"txt": "Generated no slot"})),
        );
        assert!(handed_back(&out), "{}", out.status);
        assert_eq!(writer.counted("writer_unavailable"), 1);
        assert_eq!(snapshot(&mut c), before);
        drop(releases);
        for task in held {
            rt.block_on(task).unwrap().unwrap();
        }
        assert_eq!(
            send(
                &rt,
                &fixture,
                &member(),
                &comment(json!({"txt": "Generated no slot"}))
            )
            .status,
            200
        );
        drop(fixture);
        drop(rt);
    }

    /// An insert that outlives the reply deadline is answered 500, never a
    /// hand-back, and is not cancelled: the comment is stored when the
    /// database lets it through.
    #[test]
    fn a_reply_deadline_is_unknown_never_a_hand_back_and_the_insert_completes() {
        let db = Database::new("deadline");
        let mut c = db.connect();
        let rt = runtime();
        // This test's inserts wait as long as they must.
        let (writer, key) = writer_with(&db, vec![], patient_insert_limits());
        let fixture = fixture_of(&db, writer, key);
        c.batch_execute(PATIENT_INSERTS).unwrap();
        // The conversation's comment-number lock, held by another writer.
        let mut holder = hold_comment_number_lock(&db.config, 1);
        let started = std::time::Instant::now();
        let out = rt.block_on(route::handle(
            fixture.app.clone(),
            signed(
                &fixture.key,
                &member(),
                &comment(json!({"txt": "Generated slow"})),
            ),
        ));
        assert!(started.elapsed() >= DISPATCH_DEADLINE);
        assert_eq!(out.status, 500);
        assert!(!handed_back(&out));
        assert_eq!(
            body_of(&out),
            r#"{"error":"polis_err_post_comment","message":"polis_err_post_comment","status":500}"#
        );
        assert_eq!(
            count(
                &mut c,
                "select count(*) from comments where txt = 'Generated slow'"
            ),
            0
        );
        holder.batch_execute("ROLLBACK").unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(20);
        while count(
            &mut c,
            "select count(*) from comments where txt = 'Generated slow'",
        ) == 0
        {
            assert!(
                std::time::Instant::now() < deadline,
                "the insert never completed"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
        settle(&rt, &fixture.app);
        drop(fixture);
        drop(rt);
    }

    /// The pool's own bound on the comment-number lock. Node has no such
    /// bound: it waits and stores the comment. So an insert PostgreSQL
    /// refuses at the lock wait is handed back to Node, marked as refused by
    /// the database, with nothing stored; it is never answered 500.
    #[test]
    fn an_insert_refused_at_the_lock_wait_is_handed_back_with_nothing_stored() {
        let db = Database::new("lock_wait");
        let mut c = db.connect();
        let rt = runtime();
        let fixture = setup(&db);
        let writer = fixture.app.post_comments.as_ref().unwrap();
        let body = comment(json!({"txt": "Generated waiting", "vote": crate::votes::WIRE_AGREE}));
        let mut holder = hold_comment_number_lock(&db.config, 1);
        let before = snapshot(&mut c);
        let out = send(&rt, &fixture, &member(), &body);
        assert!(refused_by_database(&out), "{}", out.status);
        assert_eq!(writer.counted("insert_lock_timeout"), 1);
        assert_eq!(snapshot(&mut c), before);
        // What Node then does with the request it was handed: it waits. The
        // same request again, once the lock is free, is stored.
        holder.batch_execute("ROLLBACK").unwrap();
        assert_eq!(send(&rt, &fixture, &member(), &body).status, 200);
        assert_eq!(count(&mut c, "select count(*) from votes"), 1);
        drop(fixture);
        drop(rt);
    }

    /// The pool's own bound on a statement, with the handler's real bounds:
    /// an insert PostgreSQL cancels at the statement timeout is handed back
    /// with nothing stored, and the reply deadline is long enough for that
    /// refusal to arrive before it.
    #[test]
    fn an_insert_cancelled_at_the_statement_bound_is_handed_back_with_nothing_stored() {
        let db = Database::new("statement_bound");
        let mut c = db.connect();
        let rt = runtime();
        let fixture = setup(&db);
        let writer = fixture.app.post_comments.as_ref().unwrap();
        assert!(
            DISPATCH_DEADLINE
                >= writer_limits().acquire_timeout
                    + writer_limits().statement_timeout
                    + Duration::from_millis(250)
        );
        c.batch_execute(
            "CREATE FUNCTION slow() RETURNS trigger LANGUAGE plpgsql AS
             $$ BEGIN PERFORM pg_sleep(30); RETURN NEW; END $$;
             CREATE TRIGGER slow BEFORE INSERT ON comments
             FOR EACH ROW EXECUTE FUNCTION slow();",
        )
        .unwrap();
        let body = comment(json!({"txt": "Generated slow insert"}));
        let before = snapshot(&mut c);
        let started = std::time::Instant::now();
        let out = send(&rt, &fixture, &member(), &body);
        assert!(refused_by_database(&out), "{}", out.status);
        assert!(started.elapsed() >= writer_limits().statement_timeout);
        assert_eq!(writer.counted("insert_canceled"), 1);
        assert_eq!(snapshot(&mut c), before);
        c.batch_execute("DROP FUNCTION slow() CASCADE").unwrap();
        assert_eq!(send(&rt, &fixture, &member(), &body).status, 200);
        drop(fixture);
        drop(rt);
    }

    /// A COMMIT that PostgreSQL refuses before it has ended the transaction
    /// leaves the session inside the aborted transaction, and the driver
    /// sends no ROLLBACK after a failed COMMIT. On a pooled connection the
    /// next comment could then not begin its transaction. The handler ends
    /// that state after any failed commit; where the transaction is already
    /// over, doing so changes nothing.
    #[test]
    fn a_failed_commit_never_leaves_the_connection_inside_a_transaction() {
        use postgres::error::SqlState;
        let db = Database::new("failed_commit");
        let mut c = db.connect();
        let mut check = db.connect();
        let writable = |text: &str| {
            let Live::Write(writable) = decide(
                &Admitted {
                    zid: 1,
                    pid: 2,
                    uid: 3,
                    active: true,
                    strict: false,
                    existing: None,
                },
                CommentText::new(text.into()),
                Some(VoteChoice::Agree),
            )
            .live() else {
                panic!("an open conversation that is not strict is written");
            };
            writable
        };
        let budget = writer_limits().statement_timeout;
        // The session as such a COMMIT leaves it: inside the transaction,
        // which is aborted and accepts nothing but its end.
        c.batch_execute("BEGIN").unwrap();
        assert!(c.batch_execute("SELECT 1/0").is_err());
        assert_eq!(
            c.batch_execute("SELECT 1").unwrap_err().code(),
            Some(&SqlState::IN_FAILED_SQL_TRANSACTION)
        );
        // Left like that, the next comment on this connection is a server
        // error with nothing stored.
        assert_eq!(
            store(&mut c, &writable("Generated after a failed commit"), budget),
            Stored::Failed(500, "polis_err_post_comment")
        );
        assert_eq!(count(&mut check, "select count(*) from comments"), 2);
        // Ended, the same connection stores the comment and its vote.
        end_failed_commit(&mut c);
        assert_eq!(
            store(&mut c, &writable("Generated after a failed commit"), budget),
            Stored::Tid(2)
        );
        // Where the transaction is already over it changes nothing.
        end_failed_commit(&mut c);
        assert_eq!(
            store(&mut c, &writable("Generated after that"), budget),
            Stored::Tid(3)
        );
        assert_eq!(count(&mut check, "select count(*) from comments"), 4);
        assert_eq!(count(&mut check, "select count(*) from votes"), 2);
    }

    /// What is not proof that nothing is stored is never handed back: Node
    /// asked to repeat a stored comment would answer its author "duplicate".
    #[test]
    fn a_failure_that_does_not_prove_nothing_is_stored_is_never_handed_back() {
        let db = Database::new("ambiguous");
        let mut c = db.connect();
        let rt = runtime();
        let fixture = setup(&db);
        let writer = fixture.app.post_comments.as_ref().unwrap();
        let answered_500 = |out: &Outgoing| {
            out.status == 500
                && !out
                    .headers
                    .iter()
                    .any(|(k, _)| k == "X-Polis-Comment-Dispatch")
                && body_of(out)
                    == r#"{"error":"polis_err_post_comment","message":"polis_err_post_comment","status":500}"#
        };
        // The connection ends inside the insert: the server's last word is a
        // fatal error, not a refusal of the statement.
        c.batch_execute(
            "CREATE FUNCTION dying() RETURNS trigger LANGUAGE plpgsql AS
             $$ BEGIN PERFORM pg_terminate_backend(pg_backend_pid()); PERFORM pg_sleep(5); RETURN NEW; END $$;
             CREATE TRIGGER dying BEFORE INSERT ON comments
             FOR EACH ROW EXECUTE FUNCTION dying();",
        )
        .unwrap();
        let out = send(
            &rt,
            &fixture,
            &member(),
            &comment(json!({"txt": "Generated broken"})),
        );
        assert!(answered_500(&out), "{} {}", out.status, body_of(&out));
        c.batch_execute("DROP FUNCTION dying() CASCADE").unwrap();
        // The pool finds out that connection is gone on its next use.
        let recovered = (0..3).any(|n| {
            let text = format!("Generated recovery {n}");
            send(&rt, &fixture, &member(), &comment(json!({"txt": text}))).status == 200
        });
        assert!(recovered);
        // A commit that fails is never handed back: the handler does not
        // reason about what a failed commit left behind.
        c.batch_execute(
            "CREATE FUNCTION at_commit() RETURNS trigger LANGUAGE plpgsql AS
             $$ BEGIN RAISE EXCEPTION 'generated commit failure' USING ERRCODE='55P03'; END $$;
             CREATE CONSTRAINT TRIGGER at_commit AFTER INSERT ON comments
             DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION at_commit();",
        )
        .unwrap();
        let out = send(
            &rt,
            &fixture,
            &member(),
            &comment(json!({"txt": "Generated failing commit", "vote": crate::votes::WIRE_AGREE})),
        );
        assert!(answered_500(&out), "{} {}", out.status, body_of(&out));
        c.batch_execute("DROP FUNCTION at_commit() CASCADE")
            .unwrap();
        // Another error of the insert itself keeps Node's answer.
        c.batch_execute(
            "CREATE FUNCTION other() RETURNS trigger LANGUAGE plpgsql AS
             $$ BEGIN RAISE EXCEPTION 'generated failure' USING ERRCODE='53200'; END $$;
             CREATE TRIGGER other BEFORE INSERT ON comments FOR EACH ROW EXECUTE FUNCTION other();",
        )
        .unwrap();
        let out = send(
            &rt,
            &fixture,
            &member(),
            &comment(json!({"txt": "Generated other"})),
        );
        assert!(answered_500(&out), "{} {}", out.status, body_of(&out));
        for reason in ["insert_lock_timeout", "insert_canceled"] {
            assert_eq!(writer.counted(reason), 0, "{reason}");
        }
        drop(fixture);
        drop(rt);
    }

    /// Notification work that cannot run is dropped and counted; the comment
    /// is stored and answered all the same, on the writer's own connections.
    #[test]
    fn a_full_notification_lane_never_holds_up_a_comment() {
        let db = Database::new("lane_full");
        let mut c = db.connect();
        let rt = runtime();
        let fixture = setup(&db);
        let lane = &fixture.app.post_comments.as_ref().unwrap().background;
        let permits = lane
            .admitted
            .clone()
            .try_acquire_many_owned(BACKGROUND_MAX_PENDING as u32)
            .unwrap();
        assert!(!rt.block_on(async { lane.schedule(|_| panic!("overflow must not run")) }));
        let out = rt.block_on(route::handle(
            fixture.app.clone(),
            signed(
                &fixture.key,
                &member(),
                &comment(json!({"txt": "Generated lane full"})),
            ),
        ));
        assert_eq!(out.status, 200);
        assert!(lane.dropped.load(Ordering::Relaxed) >= 3);
        assert_eq!(count(&mut c, "select count(*) from notification_tasks"), 0);
        drop(permits);
        drop(fixture);
        drop(rt);
    }

    /// Every pool the handler builds is its own, with its own bounds, and
    /// only the writer and the notification pool can write.
    #[test]
    fn the_handlers_pools_are_its_own_and_only_two_can_write() {
        let db = Database::new("pools");
        let rt = runtime();
        let fixture = setup(&db);
        let writer = fixture.app.post_comments.as_ref().unwrap();
        let pools = writer.startup_pools();
        for (i, a) in pools.iter().enumerate() {
            assert!(!Arc::ptr_eq(a, &fixture.app.db));
            for b in &pools[i + 1..] {
                assert!(!Arc::ptr_eq(a, b));
            }
        }
        for (name, pool) in ["writer", "reads", "notifications"].into_iter().zip(pools) {
            let health: Value =
                serde_json::from_str(&crate::js::stringify(&pool.health(true))).unwrap();
            let (read_only, limit, statement) = match name {
                "writer" => (false, 4, 1000),
                "reads" => (true, 2, 100),
                _ => (false, 2, 1000),
            };
            assert_eq!(health["readOnly"], read_only, "{name}");
            assert_eq!(health["limit"], limit, "{name}");
            assert_eq!(health["acquireTimeoutMs"], 100, "{name}");
            assert_eq!(health["statementTimeoutMs"], statement, "{name}");
            let refused = rt.block_on(pool.with(|c| {
                Ok(
                    c.batch_execute("CREATE TEMP TABLE writable_probe(n integer)")
                        .is_err(),
                )
            }));
            assert_eq!(refused.unwrap(), read_only, "{name}");
        }
        drop(fixture);
        drop(rt);
    }

    /// Every statement the handler sends is prepared on this run's database
    /// shape with the parameter types the handler binds, and each read is
    /// planned on an index: the text lookup on the unique key on (zid, txt),
    /// the others on a primary or unique key. The plans are printed.
    #[test]
    fn every_statement_prepares_and_every_read_is_index_bounded() {
        use postgres::types::Type;
        let db = Database::new("plans");
        let mut c = db.connect();
        // Enough rows that a plan is a choice, in two conversations.
        c.batch_execute(
            "ALTER TABLE comments DISABLE TRIGGER USER;
             INSERT INTO comments(zid, pid, uid, txt, tid)
               SELECT 1, 2, 3, 'Generated bulk ' || n, 1000 + n FROM generate_series(1, 20000) n;
             INSERT INTO users(uid, site_id) SELECT 200000 + n, 'bulk-' || n FROM generate_series(1, 5000) n;
             INSERT INTO conversations(zid, owner, is_active) SELECT 1000 + n, 200000 + n, true FROM generate_series(1, 5000) n;
             INSERT INTO zinvites(zid, zinvite) SELECT 1000 + n, 'bulk' || n FROM generate_series(1, 5000) n;
             ALTER TABLE participants DISABLE TRIGGER USER;
             INSERT INTO participants(zid, uid, pid) SELECT 1, 200000 + n, 100 + n FROM generate_series(1, 5000) n;
             ALTER TABLE participants ENABLE TRIGGER USER;
             ALTER TABLE comments ENABLE TRIGGER USER;
             ANALYZE;",
        )
        .unwrap();
        let statements: [(&str, &str, Vec<Type>, Option<&str>); 9] = [
            (
                "conversation",
                "select zid from zinvites where zinvite = ($1)",
                vec![Type::TEXT],
                Some("'2p027generated'"),
            ),
            (
                "member",
                "select p.pid from participants p join conversations c on c.zid=p.zid where p.zid=$1 and p.uid=$2 and c.treevite_enabled is not true",
                vec![Type::INT4, Type::INT4],
                Some("1, 3"),
            ),
            ("treevite", TREEVITE, vec![Type::INT4], Some("1")),
            (
                "admission",
                ADMISSION,
                vec![Type::INT4, Type::INT4, Type::TEXT],
                Some("1, 3, 'Generated bulk 777'"),
            ),
            (
                "insert",
                "insert into comments
                 (pid, zid, txt, velocity, active, mod, uid, anon, is_seed, created, tid, lang, lang_confidence)
                 values ($1, $2, $3, $4, $5, $6, $7, $8, $9, default, null, null, null)
                 returning tid",
                vec![
                    Type::INT4, Type::INT4, Type::TEXT, Type::FLOAT4, Type::BOOL, Type::INT4,
                    Type::INT4, Type::BOOL, Type::BOOL,
                ],
                None,
            ),
            (
                "vote: conversation",
                "select is_active from conversations where zid = $1",
                vec![Type::INT4],
                Some("1"),
            ),
            (
                "vote",
                "insert into votes (pid, zid, tid, vote, weight_x_32767, high_priority, created)
                 values ($1, $2, $3, $4, $5, $6, default)",
                vec![Type::INT4, Type::INT4, Type::INT4, Type::INT2, Type::INT2, Type::BOOL],
                None,
            ),
            (
                "notification task",
                "insert into notification_tasks (zid) values ($1)
                 on conflict (zid) do update set modified = now_as_millis()",
                vec![Type::INT4],
                None,
            ),
            (
                "last interaction",
                "update participants set last_interaction = now_as_millis(), nsli = 0
                 where zid = $1 and uid = $2",
                vec![Type::INT4, Type::INT4],
                Some("1, 3"),
            ),
        ];
        let shape = std::env::var("POLIS_API_TEST_DATABASE_SHAPE").unwrap_or("migrations".into());
        for (name, sql, bound, arguments) in statements {
            // The driver binds what the server infers; it must accept what
            // the handler passes.
            let prepared = c.prepare(sql).unwrap_or_else(|e| panic!("{name}: {e}"));
            assert_eq!(prepared.params().len(), bound.len(), "{name}");
            for (inferred, passed) in prepared.params().iter().zip(&bound) {
                let compatible =
                    inferred == passed || (*passed == Type::TEXT && *inferred == Type::VARCHAR);
                assert!(compatible, "{name}: inferred {inferred}, passed {passed}");
            }
            let Some(arguments) = arguments else { continue };
            c.batch_execute("DEALLOCATE ALL").unwrap();
            c.batch_execute(&format!("PREPARE planned AS {sql}"))
                .unwrap();
            let plan: Vec<String> = c
                .query(
                    &format!("EXPLAIN (COSTS OFF) EXECUTE planned({arguments})"),
                    &[],
                )
                .unwrap()
                .iter()
                .map(|row| row.get(0))
                .collect();
            println!("plan on the {shape} shape: {name}\n  {}", plan.join("\n  "));
            let plan = plan.join("\n");
            assert!(!plan.contains("Seq Scan"), "{name}: {plan}");
            assert!(
                !plan.contains("Merge") && !plan.contains("Hash"),
                "{name}: {plan}"
            );
            if name == "admission" {
                assert_eq!(plan.matches("Index Cond: (uid = ").count(), 2, "{plan}");
                assert!(
                    plan.contains("Index Scan using comments_zid_txt_key on comments m")
                        && plan.contains(
                            "Index Cond: ((zid = 1) AND ((txt)::text = 'Generated bulk 777'::text))"
                        ),
                    "{plan}"
                );
            }
        }
        // The columns the handler names exist on this shape with the types
        // it reads; an older installation has `curation` besides, with a
        // default, and lets `velocity` be null.
        let columns: Vec<String> = c
            .query(
                "select attname || ' ' || format_type(atttypid, atttypmod)
                 from pg_attribute where attrelid = 'comments'::regclass and attnum > 0
                 and not attisdropped order by attnum",
                &[],
            )
            .unwrap()
            .iter()
            .map(|row| row.get(0))
            .collect();
        println!("comments on the {shape} shape: {}", columns.join(", "));
        assert!(columns.contains(&"txt character varying(1000)".to_owned()));
        assert_eq!(
            columns.contains(&"curation smallint".to_owned()),
            shape == "older"
        );
    }

    /// The process-level check of the text: a child process stores comments
    /// whose text carries a marker while the database raises errors that
    /// quote the text and the write panics formatting what it holds; nothing
    /// the child prints contains the marker.
    #[test]
    fn nothing_a_failing_or_panicking_write_prints_contains_the_text() {
        const CHILD: &str = "POLIS_COMMENT_OUTPUT_TEST";
        if let Ok(phase) = std::env::var(CHILD) {
            let db = Database::new("output");
            let mut c = db.connect();
            let rt = runtime();
            let fixture = setup(&db);
            let body = comment(json!({"txt": MARKER, "vote": crate::votes::WIRE_AGREE}));
            if phase == "errors" {
                // The server's message and detail both quote the text.
                for (code, constraint) in [("23505", "comments_zid_txt_key"), ("XX000", "other")] {
                    c.batch_execute(&format!(
                        "CREATE FUNCTION quoting() RETURNS trigger LANGUAGE plpgsql AS
                         $$ BEGIN RAISE EXCEPTION 'failure quoting %', NEW.txt USING ERRCODE='{code}',
                            CONSTRAINT='{constraint}', DETAIL='Key (zid, txt)=(' || NEW.zid || ', ' || NEW.txt || ') already exists.'; END $$;
                         CREATE TRIGGER quoting BEFORE INSERT ON comments FOR EACH ROW EXECUTE FUNCTION quoting();"
                    ))
                    .unwrap();
                    let out = send(&rt, &fixture, &member(), &body);
                    println!("answered {} {}", out.status, body_of(&out));
                    c.batch_execute("DROP FUNCTION quoting() CASCADE").unwrap();
                }
                // The vote's failure quotes the stored text too.
                c.batch_execute(
                    "CREATE FUNCTION quoting_vote() RETURNS trigger LANGUAGE plpgsql AS
                     $$ BEGIN RAISE EXCEPTION 'vote failure quoting %',
                        (SELECT txt FROM comments WHERE zid = NEW.zid AND tid = NEW.tid); END $$;
                     CREATE TRIGGER quoting_vote BEFORE INSERT ON votes FOR EACH ROW EXECUTE FUNCTION quoting_vote();",
                )
                .unwrap();
                let out = send(&rt, &fixture, &member(), &body);
                println!("answered {} {}", out.status, body_of(&out));
                // Rolled back with its comment. Once the vote can be
                // stored, the same request is stored whole.
                c.batch_execute("DROP FUNCTION quoting_vote() CASCADE")
                    .unwrap();
                let out = send(&rt, &fixture, &member(), &body);
                println!("answered {} {}", out.status, body_of(&out));
                // Admission that fails while holding the text.
                c.batch_execute("ALTER TABLE comments RENAME COLUMN txt TO renamed")
                    .unwrap();
                let out = send(&rt, &fixture, &member(), &body);
                println!("answered {} {}", out.status, body_of(&out));
                println!("health {}", crate::js::stringify(&health(&fixture.app)));
            } else {
                // PANIC_IN_WRITE is set: the write panics before it sends
                // ("panic"), or between the comment's insert and the vote
                // ("between"), as a process stopped there would leave it.
                let out = send(&rt, &fixture, &member(), &body);
                println!("answered {} {}", out.status, body_of(&out));
                println!(
                    "stored comments={} votes={}",
                    c.query_one("select count(*) from comments where txt = $1", &[&MARKER])
                        .unwrap()
                        .get::<_, i64>(0),
                    count(&mut c, "select count(*) from votes")
                );
            }
            drop(fixture);
            drop(rt);
            return;
        }
        let run = |phase: &str| {
            let mut child = std::process::Command::new(std::env::current_exe().unwrap());
            child
                .args([
                    "--exact",
                    "post_comments::tests::database::nothing_a_failing_or_panicking_write_prints_contains_the_text",
                    "--nocapture",
                ])
                .env(CHILD, phase);
            if phase != "errors" {
                child.env(PANIC_IN_WRITE, phase);
            }
            let output = child.output().unwrap();
            assert!(output.status.success(), "{phase}: the child failed");
            format!(
                "{}{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            )
        };
        let errors = run("errors");
        for answered in [
            "answered 409 {\"error\":\"polis_err_post_comment_duplicate\"",
            "answered 500 {\"error\":\"polis_err_post_comment\"",
            "answered 502 ",
            "health {",
        ] {
            assert!(errors.contains(answered), "{answered}: {errors}");
        }
        // The duplicate, the server error, the failed vote (rolled back and
        // handed back), the same request stored, admission failing.
        for (answer, times) in [("409", 1), ("500", 1), ("502", 2), ("200", 1)] {
            assert_eq!(
                errors.matches(&format!("answered {answer}")).count(),
                times,
                "{answer}: {errors}"
            );
        }
        assert!(!leaks(&errors), "{errors}");
        let panicked = run("panic");
        assert!(
            panicked.contains("forced panic in the comment write")
                && panicked.contains(&format!("CommentText({} bytes)", MARKER.len()))
                && panicked.contains("answered 500 {\"error\":\"polis_err_post_comment\""),
            "{panicked}"
        );
        assert!(!leaks(&panicked), "{panicked}");
        // A stop between the comment's insert and its author's vote leaves
        // neither: the transaction never committed.
        let between = run("between");
        assert!(
            between.contains("forced panic between the comment and its vote")
                && between.contains("answered 500 {\"error\":\"polis_err_post_comment\"")
                && between.contains("stored comments=0 votes=0"),
            "{between}"
        );
        assert!(!leaks(&between), "{between}");
    }
}

#[cfg(feature = "db-tests")]
#[path = "post_comments_replay.rs"]
mod replay;
