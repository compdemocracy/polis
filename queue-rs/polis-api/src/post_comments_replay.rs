//! Every recorded Node response for POST /api/v3/comments, replayed through
//! the real route and HTTP serializer against a database of this test's own.
//!
//! For each recorded request the conversation is put in the state the
//! recording's driver gave it (closed, strict, Treevite, xid rules, the
//! comment numbers already used, an injected failure) and the request is
//! sent with a token of the recorded kind. Then either the handler hands the
//! request back, and nothing in the database has changed; or it answers, and
//! its complete HTTP response equals Node's recorded bytes and the rows it
//! wrote equal the rows Node wrote. A strict conversation's comment is
//! handed back by the live handler; its modelled decision is compared with
//! what Node stored and answered.
//!
//! One recorded response is outside the handler's configuration: the
//! recording driver's language provider returns a detected language there,
//! and the handler refuses to start unless that provider is off. It is
//! replayed with the handler absent.
use super::{database::*, *};
use crate::http;
use base64::{Engine, engine::general_purpose::STANDARD};
use jsonwebtoken::EncodingKey;
use std::collections::BTreeMap;

fn recorded() -> Vec<Value> {
    let mut cases: Vec<Value> = Vec::new();
    for text in [
        include_str!("../../../server/characterization/post-comments/golden/cases.json"),
        include_str!("../../../server/characterization/post-comments/golden/additional/cases.json"),
        include_str!("../../../server/characterization/post-comments/golden/disabled/cases.json"),
    ] {
        cases.extend(serde_json::from_str::<Vec<Value>>(text).unwrap());
    }
    let concurrent: Vec<Value> = serde_json::from_str(include_str!(
        "../../../server/characterization/post-comments/golden/concurrent.json"
    ))
    .unwrap();
    for pair in concurrent {
        cases.extend(pair["responses"].as_array().unwrap().iter().cloned());
    }
    cases
}

/// The token the recording driver's actor presents, by kind.
fn authorization(actor: &str, key: &EncodingKey) -> Option<String> {
    let anonymous = |uid: i32, pid: i32| {
        let mut claims = member();
        claims["uid"] = json!(uid);
        claims["pid"] = json!(pid);
        claims["sub"] = json!(format!("anon:{uid}"));
        claims
    };
    Some(match actor {
        "unauthenticated" => return None,
        "bad" => "Bearer generated-invalid-token".to_owned(),
        "participant" => bearer(key, &member()),
        "pid0" => bearer(key, &anonymous(1, 0)),
        "standard" => bearer(key, &standard(3, 2)),
        "site-moderator" => bearer(key, &standard(100004, 3)),
        "standard-nonmember" => bearer(key, &standard(100005, 0)),
        "xid" => {
            let mut claims = member();
            claims
                .as_object_mut()
                .unwrap()
                .remove("anonymous_participant");
            claims["xid_participant"] = json!(true);
            claims["xid"] = json!("generated-member");
            claims["sub"] = json!("xid:generated-member");
            bearer(key, &claims)
        }
        "foreign" => {
            let mut claims = member();
            claims["conversation_id"] = json!("2p027foreign");
            bearer(key, &claims)
        }
        "expired" => {
            let mut claims = member();
            claims["exp"] = json!(1600000001_u64);
            bearer(key, &claims)
        }
        "signature" => format!("{}invalid", bearer(key, &member())),
        // An account's own token, as the admin console and a signed-in
        // participant present it.
        actor
            if actor == "owner"
                || actor == "admin"
                || actor.starts_with("comments-owner")
                || actor.starts_with("oidc-") =>
        {
            bearer(
                key,
                &json!({"iss":"fixture-oidc","aud":"users","sub":format!("account:{actor}"),
                    "iat":1600000000_u64,"exp":4100000000_u64,"scope":"openid profile email"}),
            )
        }
        other => panic!("unknown recorded actor {other}"),
    })
}

/// The conversation's settings for a recorded case, as the driver set them.
fn settings(name: &str) -> &'static str {
    let name = name.split('/').next().unwrap();
    if name.ends_with("-closed") || name == "duplicate-before-closed" {
        "is_active = false"
    } else if name.ends_with("-strict")
        || name == "moderation-count-failure"
        || name == "site-moderator-recipient"
    {
        "strict_moderation = true"
    } else if name.starts_with("treevite-") {
        "treevite_enabled = true"
    } else if name == "xid-required" {
        "xid_required = true"
    } else if name == "xid-whitelisted" || name == "xid-refused" {
        "use_xid_whitelist = true"
    } else {
        "is_active = true"
    }
}

/// The driver's injected failures that an admitted request can meet.
fn fault(c: &mut Client, name: &str) {
    let (table, event) = match name {
        "author-vote-failure-after-commit" => ("votes", "INSERT"),
        "notification-task-failure" => ("notification_tasks", "INSERT"),
        "notification-interaction-failure" => ("participants", "UPDATE"),
        _ => return,
    };
    c.batch_execute(&format!(
        "CREATE FUNCTION replay_failure() RETURNS trigger LANGUAGE plpgsql AS
         $$ BEGIN RAISE EXCEPTION 'recorded failure'; END $$;
         CREATE TRIGGER replay_failure BEFORE {event} ON {table}
         FOR EACH ROW EXECUTE FUNCTION replay_failure();"
    ))
    .unwrap();
}

/// The fixture before one recorded request: the recordings' conversation
/// with its members, the comment numbers below `next_tid` used, and, for a
/// recorded duplicate, the text already there.
fn arrange(db: &Database, c: &mut Client, case: &Value, next_tid: Option<i64>) {
    c.batch_execute("DROP FUNCTION IF EXISTS replay_failure() CASCADE")
        .unwrap();
    db.seed(c, 0);
    c.batch_execute("ALTER TABLE comments DISABLE TRIGGER USER")
        .unwrap();
    let name = case["case"].as_str().unwrap();
    let last = next_tid.unwrap_or(2) as i32 - 1;
    if last >= 0 {
        c.execute(
            "INSERT INTO comments(zid, pid, uid, txt, tid) VALUES (1, 0, 1, 'Generated earlier', $1)",
            &[&last],
        )
        .unwrap();
    }
    if case["response"]["status"] == 409 {
        let text = case["request"]["body"]["txt"].as_str().unwrap();
        c.execute(
            "INSERT INTO comments(zid, pid, uid, txt, tid) VALUES (1, 0, 1, $1, $2)",
            &[&text.trim_matches(' '), &(last + 1)],
        )
        .unwrap();
    }
    c.batch_execute(&format!(
        "ALTER TABLE comments ENABLE TRIGGER USER;
         UPDATE conversations SET {} WHERE zid = 1",
        settings(name)
    ))
    .unwrap();
    fault(c, name);
}

/// Node's complete recorded response, as bytes.
fn recorded_bytes(wire: &Value) -> (Vec<u8>, String) {
    let recorded = &wire["response"];
    let headers = recorded["headers"].as_array().unwrap();
    let date = headers
        .iter()
        .find(|h| h["name"].as_str().unwrap().eq_ignore_ascii_case("date"))
        .unwrap()["value"]
        .as_str()
        .unwrap()
        .to_owned();
    let status = recorded["status"].as_u64().unwrap() as u16;
    let mut bytes = format!("HTTP/1.1 {status} {}\r\n", http::reason_text(status)).into_bytes();
    for header in headers {
        bytes.extend(
            format!(
                "{}: {}\r\n",
                header["name"].as_str().unwrap(),
                header["value"].as_str().unwrap()
            )
            .as_bytes(),
        );
    }
    bytes.extend(b"\r\n");
    for chunk in recorded["body"].as_array().unwrap() {
        bytes.extend(
            STANDARD
                .decode(chunk["bytes"]["base64"].as_str().unwrap())
                .unwrap(),
        );
    }
    (bytes, date)
}

fn rows(c: &mut Client, sql: &str) -> Vec<Value> {
    c.query(sql, &[])
        .unwrap()
        .iter()
        .map(|row| serde_json::from_str(&row.get::<_, String>(0)).unwrap())
        .collect()
}

/// A stored row against the recorded one: every recorded column equal. An
/// installation older than the migrations has one more column, with its
/// default.
fn assert_row(name: &str, stored: &Value, recorded: &Value) {
    for (column, value) in recorded.as_object().unwrap() {
        assert_eq!(&stored[column], value, "{name}: {column}");
    }
    for column in stored.as_object().unwrap().keys() {
        assert!(
            recorded.get(column).is_some() || column == "curation",
            "{name}: a column Node's row does not have: {column}"
        );
    }
}

fn added<'a>(case: &'a Value, table: &str) -> &'a [Value] {
    case["effects"]["db"][table]["added"]
        .as_array()
        .map_or(&[], Vec::as_slice)
}

#[test]
fn recorded_responses_are_exact_where_admitted_and_untouched_where_handed_back() {
    let db = Database::new("replay");
    let mut c = db.connect();
    let rt = runtime();
    let connector =
        || polis_queue_adapter::jobs::transport::Connector::Plain(Box::new(db.config.clone()));
    let (writer, key) = writer(&db, vec![]);
    let mut on = App::new(&app_config(), db::Pool::new(connector(), read_limits()));
    on.post_comments = Some(writer);
    // The recording stack sets DOMAIN_OVERRIDE, so Node writes its CORS
    // headers on every response.
    on.cors = crate::cors::Cors::for_test(true);
    let on = Arc::new(on);
    let mut off = App::new(&app_config(), db::Pool::new(connector(), read_limits()));
    off.cors = crate::cors::Cors::for_test(true);
    let off = Arc::new(off);
    let writer = on.post_comments.as_ref().unwrap();

    let cases = recorded();
    assert_eq!(cases.len(), 157);
    let mut exact: BTreeMap<u16, u32> = BTreeMap::new();
    let mut handed_back: BTreeMap<&'static str, u32> = BTreeMap::new();
    let mut strict_modelled = 0;
    for case in &cases {
        let name = case["case"].as_str().unwrap();
        let comment_row = added(case, "pg:comments").iter().find(|row| {
            row["txt"].as_str().map(|t| t.trim_matches(' '))
                == case["request"]["body"]["txt"]
                    .as_str()
                    .map(|t| t.trim_matches(' '))
        });
        arrange(
            &db,
            &mut c,
            case,
            comment_row.map(|row| row["tid"].as_i64().unwrap()),
        );
        let wire = &case["wire"];
        let actor = case["auth"].as_str().unwrap();
        let token = authorization(actor, &key);
        let make = || {
            let mut request = req(&case["request"]["body"].to_string());
            if !wire.is_null() {
                request.body = wire["request"]["body"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .flat_map(|chunk| {
                        STANDARD
                            .decode(chunk["bytes"]["base64"].as_str().unwrap())
                            .unwrap()
                    })
                    .collect();
            }
            request.headers = Headers::from_raw(
                [
                    ("host", "localhost:5000"),
                    ("content-type", "application/json"),
                    ("x-forwarded-proto", "https"),
                ]
                .into_iter()
                .chain(token.as_deref().map(|token| ("authorization", token))),
            );
            request
        };
        let detected = comment_row.is_some_and(|row| !row["lang"].is_null());
        let reasons_before: BTreeMap<&'static str, u64> = writer.reasons.lock().unwrap().clone();
        let before = snapshot(&mut c);
        // A strict conversation's modelled decision, read before the request.
        let strict_decision = (settings(name) == "strict_moderation = true" && !detected)
            .then(|| rt.block_on(prepare(writer.admission(), &make())).ok())
            .flatten();
        let response = rt.block_on(route::handle(
            if detected { off.clone() } else { on.clone() },
            make(),
        ));
        settle(&rt, &on);
        if response.status == 502 {
            assert_eq!(
                snapshot(&mut c),
                before,
                "{name}: handed back after a write"
            );
            let reason = if detected {
                "unconfigured (the recording's language provider answered)"
            } else {
                let after = writer.reasons.lock().unwrap().clone();
                let changed: Vec<&'static str> = after
                    .iter()
                    .filter(|(reason, count)| {
                        reasons_before.get(*reason).copied().unwrap_or(0) != **count
                    })
                    .map(|(reason, _)| *reason)
                    .collect();
                assert_eq!(changed.len(), 1, "{name}: {changed:?}");
                changed[0]
            };
            *handed_back.entry(reason).or_default() += 1;
            if let Some(prepared) = strict_decision {
                // Node stored this comment and answered 200; the decision is
                // that row and that reply.
                let stored = comment_row.unwrap_or_else(|| panic!("{name}: Node stored a comment"));
                let decision = &prepared.decision;
                assert!(decision.strict, "{name}");
                assert_eq!(decision.status(), case["response"]["status"], "{name}");
                let Outcome::Store(store) = &decision.outcome else {
                    panic!("{name}: Node stores this comment");
                };
                assert!(matches!(store, Store::Strict(_)));
                let row = store.row();
                assert_eq!(json!(row.zid), stored["zid"], "{name}");
                assert_eq!(json!(row.pid), stored["pid"], "{name}");
                assert_eq!(json!(row.uid), stored["uid"], "{name}");
                assert!(row.text.same_as(stored["txt"].as_str().unwrap()), "{name}");
                assert_eq!(json!(Row::ACTIVE), stored["active"], "{name}");
                assert_eq!(json!(Row::ANON), stored["anon"], "{name}");
                assert_eq!(json!(Row::IS_SEED), stored["is_seed"], "{name}");
                assert_eq!(
                    json!(crate::post_comments_decision::UNMODERATED),
                    stored["mod"],
                    "{name}"
                );
                assert_eq!(
                    f64::from(crate::post_comments_decision::VELOCITY),
                    stored["velocity"].as_f64().unwrap(),
                    "{name}"
                );
                assert!(stored["lang"].is_null() && stored["lang_confidence"].is_null());
                assert_eq!(row.vote.is_some(), !added(case, "pg:votes").is_empty());
                assert_eq!(
                    json!(row.pid),
                    case["response"]["body"]["currentPid"],
                    "{name}"
                );
                strict_modelled += 1;
            }
            continue;
        }
        // Admitted: Node's bytes.
        if wire.is_null() {
            // The concurrent recordings keep the parsed response.
            assert_eq!(response.status, case["response"]["status"], "{name}");
            assert_eq!(
                serde_json::from_str::<Value>(&body_of(&response)).unwrap(),
                case["response"]["body"],
                "{name}"
            );
        } else {
            let (expected, date) = recorded_bytes(wire);
            let actual = http::write_response(&response, false, true, &date).unwrap();
            assert_eq!(
                String::from_utf8_lossy(&actual),
                String::from_utf8_lossy(&expected),
                "{name}"
            );
        }
        // And Node's rows.
        match comment_row {
            None => assert_eq!(snapshot(&mut c), before, "{name}: nothing is stored"),
            Some(recorded_row) => {
                let tid = recorded_row["tid"].as_i64().unwrap();
                let stored = rows(
                    &mut c,
                    &format!(
                        "select row_to_json(t)::text from comments t where zid = 1 and tid = {tid}"
                    ),
                );
                assert_eq!(stored.len(), 1, "{name}");
                assert_row(name, &stored[0], recorded_row);
                for (table, effect) in [
                    ("votes", "pg:votes"),
                    ("votes_latest_unique", "pg:votes_latest_unique"),
                ] {
                    let stored = rows(
                        &mut c,
                        &format!(
                            "select row_to_json(t)::text from {table} t where zid = 1 and tid = {tid}"
                        ),
                    );
                    let recorded_rows = added(case, effect);
                    assert_eq!(stored.len(), recorded_rows.len(), "{name}: {table}");
                    for (stored, recorded_row) in stored.iter().zip(recorded_rows) {
                        assert_row(name, stored, recorded_row);
                    }
                }
                // The two best-effort writes, unless Node's failed or were
                // skipped behind a failed vote.
                let task = rows(
                    &mut c,
                    "select row_to_json(t)::text from notification_tasks t where zid = 1",
                );
                let touched = rows(
                    &mut c,
                    "select row_to_json(t)::text from participants t
                     where zid = 1 and last_interaction = 1700000000000",
                );
                let base = name.split('/').next().unwrap();
                let vote_failed = base == "author-vote-failure-after-commit";
                assert_eq!(
                    task.len(),
                    usize::from(!vote_failed && base != "notification-task-failure"),
                    "{name}: notification task"
                );
                assert_eq!(
                    touched.len(),
                    usize::from(!vote_failed && base != "notification-interaction-failure"),
                    "{name}: last interaction"
                );
                if let Some(task) = task.first() {
                    assert_eq!(task["modified"], json!(1700000000000_i64), "{name}");
                }
            }
        }
        *exact.entry(response.status).or_default() += 1;
    }
    let admitted: u32 = exact.values().sum();
    let returned: u32 = handed_back.values().sum();
    println!(
        "recorded comments: {} responses; {admitted} answered with Node's bytes and rows {exact:?}; \
         {returned} handed back with nothing written {handed_back:?}; \
         {strict_modelled} strict decisions equal to Node's stored row and reply",
        cases.len()
    );
    assert_eq!(admitted + returned, 157);
    assert_eq!(
        EXPECTED_EXACT.to_vec(),
        exact.into_iter().collect::<Vec<_>>()
    );
    assert_eq!(
        EXPECTED_HANDED_BACK.to_vec(),
        handed_back.into_iter().collect::<Vec<_>>()
    );
    assert_eq!(strict_modelled, EXPECTED_STRICT);
    drop(on);
    drop(off);
    drop(rt);
}

/// What the replay finds, pinned: a change in what the handler admits, or in
/// the reason it hands a recorded request back, shows here.
const EXPECTED_EXACT: [(u16, u32); 3] = [(200, 24), (403, 2), (409, 4)];
const EXPECTED_HANDED_BACK: [(&str, u32); 19] = [
    // The recorded failure of the author's vote: Node left the comment
    // without it; here both are rolled back and Node is asked.
    ("author_vote_refused", 1),
    ("is_seed", 29),
    ("is_seed_invalid", 1),
    ("moderator", 14),
    ("no_token", 8),
    ("not_a_participant", 2),
    ("shape_conversation_id", 1),
    ("shape_keys", 1),
    ("strict_moderation", 4),
    ("token_oidc", 27),
    ("token_other_conversation", 2),
    ("token_refused", 3),
    ("token_xid", 8),
    ("treevite", 3),
    ("txt_empty", 2),
    ("txt_invalid", 8),
    (
        "unconfigured (the recording's language provider answered)",
        1,
    ),
    ("vote_invalid", 6),
    ("xid_key", 6),
];
const EXPECTED_STRICT: u32 = 4;
