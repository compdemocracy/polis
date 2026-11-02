//! Replay the external, sealed Node corpus through the real route and HTTP
//! serializer against a private PostgreSQL database. Fixture-clock builds only.
#![allow(clippy::unwrap_used, clippy::expect_used)]
use super::{database::Database, *};
use crate::{http, votes::StorageConvention};
use base64::{Engine, engine::general_purpose::STANDARD};
use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
use serde_json::{Value, json};

fn insert_rows(c: &mut Client, table: &str, rows: &Value) {
    assert!(matches!(
        table,
        "users"
            | "conversations"
            | "participants"
            | "comments"
            | "zinvites"
            | "math_main"
            | "stars"
            | "event_ptpt_no_more_comments"
    ));
    // The corpus contains generated rows, with original PostgreSQL field names.
    // json_populate_record ignores fields introduced after the minimal baseline.
    c.execute(&format!(
        "insert into {table} select * from json_populate_recordset(null::{table},$1::text::json)"
    ), &[&rows.to_string()]).unwrap();
}

fn seed(c: &mut Client, case: &Value) {
    c.batch_execute(
        "TRUNCATE users,conversations,participants,comments,zinvites,
        math_main,votes,votes_latest_unique,stars,event_ptpt_no_more_comments CASCADE;
        ALTER TABLE participants DISABLE TRIGGER USER;
        ALTER TABLE comments DISABLE TRIGGER USER;
        CREATE OR REPLACE FUNCTION now_as_millis() RETURNS bigint LANGUAGE sql
        AS 'SELECT 1700000000000::bigint';",
    )
    .unwrap();
    for table in [
        "users",
        "conversations",
        "participants",
        "comments",
        "zinvites",
        "math_main",
        "stars",
        "event_ptpt_no_more_comments",
    ] {
        insert_rows(c, table, &case["before"][table]);
    }
    c.batch_execute(
        "ALTER TABLE participants ENABLE TRIGGER USER;
        ALTER TABLE comments ENABLE TRIGGER USER;",
    )
    .unwrap();
    // Every valid history row crosses the shared storage convention, then the
    // original INSERT rule; preexisting repeated history must remain intact.
    for row in case["before"]["votes"].as_array().unwrap() {
        let a = Admitted {
            zid: row["zid"].as_i64().unwrap() as i32,
            pid: row["pid"].as_i64().unwrap() as i32,
            uid: 1,
            active: true,
        };
        let choice = StorageConvention::CURRENT
            .decode(row["vote"].as_i64().map(|v| v as i32))
            .unwrap();
        let fields = ParsedFields {
            tid: row["tid"].as_f64().unwrap(),
            vote: choice,
            high_priority: row["high_priority"].as_bool().unwrap(),
            starred: None,
            lang: None,
        };
        let stored = i16::try_from(contract::stored_vote(fields.vote)).unwrap();
        c.execute("insert into votes(zid,pid,tid,vote,weight_x_32767,high_priority,created) values($1,$2,$3,$4,$5,$6,$7)",
            &[&a.zid,&a.pid,&(fields.tid as i32),&stored,
                &(row["weight_x_32767"].as_i64().unwrap() as i16),&fields.high_priority,
                &row["created"].as_i64().unwrap()]).unwrap();
    }
    for row in case["before"]["votes_latest_unique"].as_array().unwrap() {
        c.execute("update votes_latest_unique set modified=$4,weight_x_32767=$5 where zid=$1 and pid=$2 and tid=$3",
            &[&(row["zid"].as_i64().unwrap() as i32), &(row["pid"].as_i64().unwrap() as i32),
              &(row["tid"].as_i64().unwrap() as i32), &row["modified"].as_i64().unwrap(),
              &(row["weight_x_32767"].as_i64().unwrap() as i16)]).unwrap();
    }
}

fn fault(c: &mut Client, case: &str) {
    match case {
        "vote-failure" | "duplicate-sqlstate" | "star-failure-after-commit" => {
            let table = if case == "star-failure-after-commit" {
                "stars"
            } else {
                "votes"
            };
            let code = if case == "duplicate-sqlstate" {
                "23505"
            } else {
                "XX000"
            };
            c.batch_execute(&format!(
                "CREATE FUNCTION replay_failure() RETURNS trigger LANGUAGE plpgsql AS
                 $$ BEGIN RAISE EXCEPTION 'recorded failure' USING ERRCODE='{code}'; END $$;
                 CREATE TRIGGER replay_failure BEFORE INSERT ON {table}
                 FOR EACH ROW EXECUTE FUNCTION replay_failure();"
            ))
            .unwrap();
        }
        "next-failure-after-commit" | "star-saved-before-next-failure" => {
            c.batch_execute(
                "CREATE OR REPLACE FUNCTION get_visible_comments(the_zid integer)
                RETURNS TABLE(tid integer, mod integer, strict_moderation boolean)
                LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'recorded next failure'; END $$",
            )
            .unwrap();
        }
        _ => {}
    }
}

fn clear_fault(c: &mut Client) {
    c.batch_execute(
        "DROP FUNCTION IF EXISTS replay_failure() CASCADE;
        CREATE OR REPLACE FUNCTION get_visible_comments(the_zid integer)
        RETURNS TABLE(tid integer, mod integer, strict_moderation boolean)
        LANGUAGE sql AS $$
        select comments.tid, comments.mod, conversations.strict_moderation
        from comments left join conversations on comments.zid=conversations.zid
        where active=true and mod >= (case when strict_moderation=true then 1 else 0 end)
        and comments.zid=the_zid $$",
    )
    .unwrap();
}

fn durable_state(c: &mut Client) -> Vec<Vec<String>> {
    [
        "users",
        "conversations",
        "participants",
        "participants_extended",
        "comments",
        "zinvites",
        "xids",
        "votes",
        "votes_latest_unique",
        "stars",
        "event_ptpt_no_more_comments",
    ]
    .iter()
    .map(|table| {
        let mut rows = c
            .query(&format!("select row_to_json(t)::text from {table} t"), &[])
            .unwrap()
            .iter()
            .map(|row| row.get::<_, String>(0))
            .collect::<Vec<_>>();
        rows.sort();
        rows
    })
    .collect()
}

fn token(case: &Value, key: &EncodingKey) -> Option<String> {
    let actor = case["auth"].as_str().unwrap();
    if actor == "unauthenticated" {
        return None;
    }
    if actor == "bad" {
        return Some("Bearer generated-invalid-token".into());
    }
    let (uid, pid) = match actor {
        "pid0" => (1, 0),
        "site-moderator" => (100004, 7),
        "missing-member" => (100006, 70),
        "revoked-member" => (100006, 8),
        "standard-nonmember" => (100005, -1),
        "foreign-xid-other-owner" => (100004, 0),
        _ => (3, 2),
    };
    let mut claims = json!({
        "uid":uid, "pid":pid, "conversation_id":"2p027generated",
        "sub":format!("anon:{uid}"), "iss":"fixture", "aud":"fixture",
        "exp":1800000000_u64, "iat":1600000000_u64, "anonymous_participant":true
    });
    match actor {
        a if a.starts_with("standard") || a == "foreign-standard" || a == "site-moderator" => {
            claims
                .as_object_mut()
                .unwrap()
                .remove("anonymous_participant");
            claims["standard_user_participant"] = json!(true);
            claims["oidc_sub"] = json!("generated-standard");
            claims["sub"] = json!("user:generated-standard");
        }
        a if a.starts_with("xid") || a.starts_with("foreign-xid") => {
            claims
                .as_object_mut()
                .unwrap()
                .remove("anonymous_participant");
            claims["xid_participant"] = json!(true);
            claims["xid"] = json!("generated-member");
            claims["sub"] = json!("xid:generated-member");
        }
        "foreign" => claims["conversation_id"] = json!("2p027foreign"),
        "expired" => claims["exp"] = json!(1600000001_u64),
        a if a == "owner"
            || a == "admin"
            || a.starts_with("comments-owner")
            || a.starts_with("oidc-") =>
        {
            claims = json!({"iss":"fixture-oidc","aud":"users",
                "sub":format!("account:{actor}"),"iat":1600000000_u64,
                "exp":1800000000_u64,"scope":"openid profile email"});
        }
        _ => {}
    }
    if actor.starts_with("foreign-") {
        claims["conversation_id"] = json!(if actor == "foreign-xid-other-owner" {
            "2generatedotherowner"
        } else {
            "2p027foreign"
        });
    }
    if actor == "standard-no-pid" {
        claims.as_object_mut().unwrap().remove("pid");
    }
    if actor.ends_with("-expired") {
        claims["exp"] = json!(1);
    }
    if actor.ends_with("-issuer") {
        claims["iss"] = json!("other");
    }
    if actor.ends_with("-audience") {
        claims["aud"] = json!("other");
    }
    let mut signed = encode(&Header::new(Algorithm::RS256), &claims, key).unwrap();
    if actor == "signature" || actor.ends_with("-signature") {
        signed.push_str("invalid");
    }
    Some(format!("Bearer {signed}"))
}

#[test]
fn recorded_votes_pin_node_differences_or_pre_mutation_handoff() {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    let input = std::env::var("POLIS_API_VOTE_RECORDINGS").expect("sealed vote corpus required");
    let corpus: Value = serde_json::from_slice(&std::fs::read(input).unwrap()).unwrap();
    assert_eq!(
        corpus["source_convention"]["storage_agree"],
        serde_json::json!(StorageConvention::CURRENT.agree),
        "recording source convention"
    );
    let db = Database::new("replay");
    let rsa = openssl::rsa::Rsa::generate(2048).unwrap();
    let public = rsa.public_key_to_pem().unwrap();
    let key = EncodingKey::from_rsa_pem(&rsa.private_key_to_pem().unwrap()).unwrap();
    let limits = db::Limits {
        size: 4,
        acquire_timeout: Duration::from_millis(100),
        statement_timeout: Duration::from_millis(1000),
        max_lifetime: Duration::from_secs(300),
    };
    let connector =
        || polis_queue_adapter::jobs::transport::Connector::Plain(Box::new(db.config.clone()));
    let cfg = config::Config {
        listen: String::new(),
        math_env: "p027".into(),
        cache_size: 300,
        dev_mode: false,
        use_network_host: false,
        production: true,
        pool: limits.clone(),
    };
    let mut app = App::new(&cfg, db::Pool::new(connector(), limits.clone()));
    assert!(
        app.post_votes.is_none(),
        "default app must not contain a writer"
    );
    assert_eq!(
        runtime
            .block_on(route::handle(
                Arc::new(app),
                req(r#"{"conversation_id":"a"}"#)
            ))
            .status,
        502
    );
    app = App::new(&cfg, db::Pool::new(connector(), limits.clone()));
    app.post_votes = Some(Writer {
        pool: db::Pool::writer(connector(), limits.clone()),
        background: NotificationPool::new(db::Pool::writer(
            connector(),
            db::Limits { size: 2, ..limits },
        )),
        verifier: participant::Verifier::new(&public, "fixture", "fixture").unwrap(),
        reads: db::Pool::new(connector(), read_limits()),
        admins: vec![],
    });
    let mut c = db.connect();
    let app = Arc::new(app);
    let mut results = vec![];
    for case in corpus["cases"].as_array().unwrap() {
        clear_fault(&mut c);
        seed(&mut c, case);
        let name = case["case"].as_str().unwrap();
        fault(&mut c, name);
        let mut request = req(&case["request"]["body"].to_string());
        let auth = token(case, &key);
        let mut headers = vec![
            ("host", "localhost:5000"),
            (
                "content-type",
                case["request"]["headers"]["content-type"].as_str().unwrap(),
            ),
            ("x-forwarded-proto", "https"),
            ("transfer-encoding", "chunked"),
            ("x-polis-fixture-seed", case["seed"].as_str().unwrap()),
        ];
        if let Some(encoding) = case["request"]["headers"]["content-encoding"].as_str() {
            headers.push(("content-encoding", encoding));
        }
        if let Some(auth) = &auth {
            headers.push(("authorization", auth));
        }
        request.headers = Headers::from_raw(headers);
        let before: i64 = c
            .query_one("select count(*) from votes", &[])
            .unwrap()
            .get(0);
        let before_state = durable_state(&mut c);
        let stars_before = c
            .query_one("select count(*) from stars", &[])
            .unwrap()
            .get::<_, i64>(0);
        let events_before = c
            .query_one("select count(*) from event_ptpt_no_more_comments", &[])
            .unwrap()
            .get::<_, i64>(0);
        let response = runtime.block_on(crate::clock::for_request(
            Some("1700000000000"),
            route::handle(
                if case["topical"] == true {
                    Arc::new(App::new(&cfg, db::Pool::new(connector(), read_limits())))
                } else {
                    app.clone()
                },
                request,
            ),
        ));
        runtime.block_on(async {
            tokio::time::sleep(Duration::from_millis(200)).await;
        });
        let after: i64 = c
            .query_one("select count(*) from votes", &[])
            .unwrap()
            .get(0);
        let expected_admitted = case["admitted"].as_bool().unwrap();
        let mut failures = vec![];
        if expected_admitted {
            let recorded = &case["wire"];
            let date = recorded["headers"]
                .as_array()
                .unwrap()
                .iter()
                .find(|h| h["name"].as_str().unwrap().eq_ignore_ascii_case("date"))
                .unwrap()["value"]
                .as_str()
                .unwrap();
            // Date is an injected transport clock for this exact serialization
            // comparison. It is not an assertion that live requests share time.
            let actual = http::write_response(&response, false, true, date).unwrap();
            let mut expected = format!(
                "HTTP/1.1 {} {}\r\n",
                recorded["status"],
                http::reason_text(recorded["status"].as_u64().unwrap() as u16)
            )
            .into_bytes();
            for header in recorded["headers"].as_array().unwrap() {
                expected.extend_from_slice(
                    format!(
                        "{}: {}\r\n",
                        header["name"].as_str().unwrap(),
                        header["value"].as_str().unwrap()
                    )
                    .as_bytes(),
                );
            }
            expected.extend_from_slice(b"\r\n");
            for chunk in recorded["body"].as_array().unwrap() {
                expected.extend(
                    STANDARD
                        .decode(chunk["bytes"]["base64"].as_str().unwrap())
                        .unwrap(),
                );
            }
            let pid = if case["auth"] == "pid0" { 0_i32 } else { 2_i32 };
            let fields =
                serde_json::from_value::<contract::Request>(case["request"]["body"].clone())
                    .unwrap()
                    .parse_fields();
            let prior = fields.as_ref().ok().and_then(|fields| {
                case["before"]["votes_latest_unique"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|v| {
                        v["zid"] == 1 && v["pid"] == pid && v["tid"].as_f64() == Some(fields.tid)
                    })
            });
            let repeated = prior.is_some_and(|v| {
                v["vote"].as_i64()
                    == fields
                        .as_ref()
                        .ok()
                        .map(|f| i64::from(contract::stored_vote(f.vote)))
            });
            let durable = case["history_added"].as_i64().unwrap() > 0
                || repeated && matches!(name, "vote-failure" | "duplicate-sqlstate");
            if durable {
                let http::Body::Fixed(bytes) = &response.body else {
                    panic!("fixed durable body")
                };
                let body = contract::DurableSuccess::decode(bytes).unwrap();
                let fields = fields.as_ref().unwrap();
                let created = if repeated {
                    prior.unwrap()["modified"].as_i64().unwrap()
                } else {
                    1_700_000_000_000
                };
                if response.status != 200
                    || body.current_pid != pid
                    || body.vote.tid != fields.tid as i32
                    || body.vote.vote != fields.vote.wire()
                    || body.vote.created != created
                    || body.vote.replayed != repeated
                {
                    failures.push("durable_receipt");
                }
                let degraded_star = name == "star-failure-after-commit";
                let degraded_next = degraded_star
                    || matches!(
                        name,
                        "next-failure-after-commit" | "star-saved-before-next-failure"
                    );
                if body.follow_on.star
                    != if degraded_star {
                        FollowOnState::Degraded
                    } else if fields.starred.is_some() {
                        FollowOnState::Complete
                    } else {
                        FollowOnState::Absent
                    }
                    || (body.follow_on.next_comment == FollowOnState::Degraded) != degraded_next
                    || body.follow_on.notifications != NotificationState::BestEffort
                {
                    failures.push("follow_on");
                }
                if recorded["status"] == 200 {
                    // Only the new receipt/followOn fields are removed. Preserve
                    // raw nextComment bytes and the original envelope order.
                    let legacy = contract::Success {
                        next_comment: body.next_comment,
                        current_pid: body.current_pid,
                        auth: None,
                    };
                    let recorded_body: Vec<u8> = recorded["body"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .flat_map(|chunk| {
                            STANDARD
                                .decode(chunk["bytes"]["base64"].as_str().unwrap())
                                .unwrap()
                        })
                        .collect();
                    if serde_json::to_vec(&legacy).unwrap() != recorded_body {
                        failures.push("unchanged_next_comment_bytes");
                    }
                } else if !(recorded["status"] == 500 && degraded_next
                    || repeated && matches!(name, "vote-failure" | "duplicate-sqlstate"))
                {
                    failures.push("unapproved_status_difference");
                }
            } else if actual != expected {
                failures.push("status_headers_body");
            }
            let history_added = if repeated {
                0
            } else {
                case["history_added"].as_i64().unwrap()
            };
            if after - before != history_added {
                failures.push("history");
            }
            if durable {
                let pid = if case["auth"] == "pid0" { 0_i32 } else { 2_i32 };
                let fields =
                    serde_json::from_value::<contract::Request>(case["request"]["body"].clone())
                        .unwrap()
                        .parse_fields()
                        .unwrap();
                let latest = c.query_one("select vote,modified,weight_x_32767 from votes_latest_unique where zid=1 and pid=$1 and tid=$2",
                    &[&pid, &(fields.tid as i32)]).unwrap();
                if i32::from(latest.get::<_, i16>(0)) != contract::stored_vote(fields.vote)
                    || latest.get::<_, i64>(1)
                        != if repeated {
                            prior.unwrap()["modified"].as_i64().unwrap()
                        } else {
                            1_700_000_000_000
                        }
                {
                    failures.push("latest");
                }
                let prior_weight = case["before"]["votes_latest_unique"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|v| {
                        v["zid"] == 1 && v["pid"] == pid && v["tid"].as_f64() == Some(fields.tid)
                    })
                    .map_or(0, |v| v["weight_x_32767"].as_i64().unwrap() as i16);
                if latest.get::<_, i16>(2) != prior_weight {
                    failures.push("retained_weight");
                }
                let participant = c
                    .query_opt(
                        "select vote_count from participants where zid=1 and pid=$1",
                        &[&pid],
                    )
                    .unwrap();
                let original = case["before"]["participants"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|p| p["zid"] == 1 && p["pid"] == pid)
                    .unwrap();
                if participant.unwrap().get::<_, i32>(0)
                    != original["vote_count"].as_i64().unwrap() as i32
                {
                    failures.push("unexpected_stored_count_write");
                }
                let modified = c
                    .query_one("select modified from conversations where zid=1", &[])
                    .unwrap()
                    .get::<_, i64>(0);
                let original = case["before"]["conversations"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|c| c["zid"] == 1)
                    .unwrap();
                if modified != original["modified"].as_i64().unwrap() {
                    failures.push("unexpected_activity_write");
                }
                let expected_stars =
                    i64::from(fields.starred.is_some() && name != "star-failure-after-commit");
                if c.query_one("select count(*) from stars", &[])
                    .unwrap()
                    .get::<_, i64>(0)
                    - stars_before
                    != expected_stars
                {
                    failures.push("stars");
                }
                let exhausted = response.status == 200
                    && match &response.body {
                        http::Body::Fixed(bytes) => {
                            serde_json::from_slice::<Value>(bytes).unwrap()["followOn"]["nextComment"]
                                == "absent"
                        }
                        _ => false,
                    };
                if c.query_one("select count(*) from event_ptpt_no_more_comments", &[])
                    .unwrap()
                    .get::<_, i64>(0)
                    - events_before
                    != i64::from(exhausted)
                {
                    failures.push("exhausted_event");
                }
            }
            let dir =
                std::path::PathBuf::from(std::env::var("POLIS_API_VOTE_REPLAY_OUTPUT").unwrap());
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join(format!("{name}.actual.http")), &actual).unwrap();
            std::fs::write(dir.join(format!("{name}.expected.http")), &expected).unwrap();
        } else {
            if response.status != 502 {
                failures.push("not_handed_back");
            }
            if after != before {
                failures.push("mutated_on_handoff");
            }
            if durable_state(&mut c) != before_state {
                failures.push("durable_mutation_on_handoff");
            }
        }
        results.push(json!({"case":name,"admitted":expected_admitted,
            "result":if expected_admitted && response.status == 200 {"durable acceptance: deliberate difference"} else if expected_admitted {"byte parity"} else {"handed back to Node"},
            "node_status":case["wire"]["status"], "node_history_added":case["history_added"],
            "status":response.status,"history_added":after-before,"passed":failures.is_empty(),"failures":failures}));
    }
    let path = std::env::var("POLIS_API_VOTE_RESULTS").unwrap();
    std::fs::write(path, serde_json::to_vec_pretty(&results).unwrap()).unwrap();
    let failed: Vec<_> = results
        .iter()
        .filter(|r| !r["failures"].as_array().unwrap().is_empty())
        .collect();
    assert!(failed.is_empty(), "{failed:#?}");
}
