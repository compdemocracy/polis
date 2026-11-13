//! The proofs: every statement identity observation sends, recorded from the
//! wire; that its pool can only read; the plan each statement gets on this
//! run's database shape; that nothing it prints holds what a copy carried;
//! that a member's vote is observed as before under a flood of identity
//! copies; and that an external id is not sent where the server could log it.
use super::*;
use crate::post_comments::observe::tests::database::{Recorder, asks_for_more_than_a_read};
use std::collections::BTreeSet;

fn one_line(sql: &str) -> String {
    sql.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The staged admission's own reads for the participation entry, as text.
const CONVERSATION: &str = "SELECT owner,is_active,treevite_enabled,use_xid_whitelist,xid_required FROM conversations WHERE zid=$1";
const ALLOWLIST: &str = "SELECT 1 FROM xid_whitelist WHERE owner=$1 AND xid=$2";
const BOUND: &str = "SELECT uid FROM xids WHERE owner=$1 AND xid=$2";
const ACCOUNT: &str = "SELECT u.is_owner, EXISTS (SELECT 1 FROM conversations c WHERE c.owner=u.uid), EXISTS (SELECT 1 FROM users owner_user JOIN conversations c ON c.owner=owner_user.uid WHERE owner_user.site_id=u.site_id), EXISTS (SELECT 1 FROM oidc_user_mappings m WHERE m.uid=u.uid) FROM users u WHERE u.uid=$1";
const MEMBER: &str = "SELECT pid FROM participants WHERE zid=$1 AND uid=$2";
const MEMBERSHIP: &str = "SELECT c.treevite_enabled, p.pid FROM conversations c LEFT JOIN participants p ON p.zid=c.zid AND p.uid=$2 WHERE c.zid=$1";

/// What makes a connection's session read-only, and what opens, bounds and
/// ends each read-only transaction. These are named exactly; everything else
/// on the wire must be a plain read.
const SESSION: &str =
    "SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY; SET statement_timeout = 100";
const BEGIN: &str = "START TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY";
const BOUNDS: &str = "SET LOCAL statement_timeout = 100; SET LOCAL lock_timeout = 100; SET LOCAL idle_in_transaction_session_timeout = 1000; SELECT set_config('transaction_timeout', '2000', true) WHERE current_setting('server_version_num')::int >= 170000";
const END: &str = "ROLLBACK";

/// Every read identity observation may send.
fn reads() -> Vec<String> {
    [
        ZID,
        CONVERSATION,
        ALLOWLIST,
        BOUND,
        ACCOUNT,
        MEMBER,
        polis_auth::xid_account::SQL,
        MEMBERSHIP,
        TOP,
        NEWEST_PARTICIPANTS,
        PARTICIPANT,
        BINDING,
        VOTE,
        // /health, and the read of the server's logging settings.
        "select 1",
        LOGGING_SETTINGS,
    ]
    .map(one_line)
    .to_vec()
}

/// Every statement identity observation sends, recorded from the wire across
/// every kind of copy, the read-back, a read that fails, /health and the
/// settings read, is one of a fixed list, and each statement of the list was
/// sent. No statement asks for a lock, a sequence value, a notification or a
/// write, and none holds an external id in its text.
#[test]
fn identity_observation_sends_only_the_statements_on_its_list() {
    let db = Database::new("wire");
    let keys = signing();
    let recorder = Recorder::start(&db.config);
    let through = recorder.config(&db.config);
    let observer = observer_on(
        || plain(&db.config),
        Some((plain(&through), limits())),
        &keys.public,
    );
    let stage = stage_of(db, keys, observer);
    let keys = &stage.keys;
    let mut c = stage.db.connect();
    let agree = |cid: &str| vote_body(cid, TID, VoteChoice::Agree);
    stage
        .rt
        .block_on(stage.identity().report_logging_settings());
    // Node has just created a person who voted, so a read-back by the newest
    // participants has a vote to read.
    arrives_and_votes(&mut c, 6, TID, VoteChoice::Agree);
    let before = state(&mut c);
    let bound = xid_token(keys, 4, 8123457, "2open", "known");
    let member = anonymous(keys, 2, 0, "6treevite");
    let rowless = anonymous(keys, 6, 3, "2open");
    for (body, token) in [
        (agree("2open"), None),
        (agree("7other"), None),
        (agree("3closed"), None),
        (agree("4xidreq"), None),
        (agree("6treevite"), None),
        (agree("9nothing"), None),
        (named("2open", json!("fresh")), None),
        (named("2open", json!("known")), None),
        (named("7other", json!("known")), None),
        (named("5allow", json!("unlisted")), None),
        (named("5allow", json!("listed")), None),
        (named("2open", json!("ownerxid")), None),
        (named("2open", json!(12)), None),
        (agree("2open"), Some(bound.as_str())),
        (named("2open", json!("known")), Some(bound.as_str())),
        (agree("7other"), Some(bound.as_str())),
        (agree("6treevite"), Some(member.as_str())),
        (agree("2open"), Some(rowless.as_str())),
    ] {
        let line = stage.observe(&body, token);
        assert_ne!(line["id_decision"], "unavailable", "{line}");
        assert_ne!(line["id_node"], "unavailable", "{line}");
    }
    // A read that fails: the table is locked against every reader, and the
    // decision's read of it is cut at its lock bound.
    {
        let mut locker = stage.db.connect();
        let mut held = locker.transaction().unwrap();
        held.batch_execute("LOCK TABLE participants IN ACCESS EXCLUSIVE MODE")
            .unwrap();
        let line = stage.observe(&agree("2open"), None);
        held.rollback().unwrap();
        assert_eq!(line["id_decision"], "unavailable");
        assert_eq!(line["id_why"], "reads_failed");
    }
    assert_eq!(
        stage.health()["postVotesIdentity"]["pools"]["identity"]["reachable"],
        true
    );
    assert_eq!(state(&mut c), before, "an observed copy changed a row");
    let sent: BTreeSet<String> = recorder.statements().into_iter().collect();
    let control: BTreeSet<String> = [SESSION, BEGIN, BOUNDS, END]
        .iter()
        .map(|sql| (*sql).to_owned())
        .collect();
    let allowed: BTreeSet<String> = control.iter().cloned().chain(reads()).collect();
    println!(
        "identity observation sent {} statements, {} distinct:",
        recorder.statements().len(),
        sent.len()
    );
    for sql in &sent {
        println!("  {sql}");
    }
    assert_eq!(sent, allowed, "the statements sent are not the list");
    for sql in &sent {
        // No statement's text holds an external id: each goes as a parameter.
        for xid in ["fresh", "known", "unlisted", "listed", "ownerxid"] {
            assert!(!sql.contains(xid), "{sql}");
        }
        if control.contains(sql) {
            continue;
        }
        assert_eq!(asks_for_more_than_a_read(sql), None, "{sql}");
        assert!(sql.to_lowercase().starts_with("select "), "{sql}");
    }
    // The transaction's own statements: read-only, and nothing but settings.
    assert!(BEGIN.ends_with("READ ONLY") && SESSION.contains("TRANSACTION READ ONLY"));
    for part in BOUNDS.split(';') {
        let part = part.trim();
        assert!(
            part.starts_with("SET LOCAL ")
                || part.starts_with("SELECT set_config('transaction_timeout'"),
            "{part}"
        );
    }
}

/// The identity pool's session is read-only: PostgreSQL refuses each write of
/// a creation on it with SQLSTATE 25006, inside the decision's transaction
/// and outside it. An advisory lock is not a write and a read-only session
/// allows one, which is why the list above is the proof and this the
/// backstop.
#[test]
fn the_identity_pool_refuses_every_write_of_a_creation() {
    let stage = stage("readonly");
    let mut c = stage.db.connect();
    let before = state(&mut c);
    let pool = stage.identity().pool.clone();
    let writes = [
        "INSERT INTO users(created) VALUES(default)",
        "INSERT INTO participants_extended(zid,uid) VALUES(1,3)",
        "INSERT INTO participants(pid,zid,uid,created) VALUES(NULL,1,3,default)",
        "INSERT INTO xids(owner,uid,xid) VALUES(1,3,'refused')",
        "UPDATE conversations SET participant_count = participant_count + 1 WHERE zid = 1",
        "INSERT INTO oidc_user_mappings(oidc_sub,uid,created) VALUES('refused',3,0)",
        "INSERT INTO auth_tokens(token,uid) VALUES('refused',3)",
        "DELETE FROM participants WHERE zid = 1",
        "SELECT nextval('users_uid_seq')",
        "SELECT is_active FROM conversations WHERE zid = 1 FOR SHARE",
        "SELECT pid FROM participants WHERE zid = 1 FOR UPDATE",
    ];
    for inside in [false, true] {
        for sql in writes {
            let refused = stage.rt.block_on(pool.with(move |c| {
                if inside {
                    let mut reads =
                        polis_auth::admission::snapshot(c, &polis_auth::admission::Bounds::OBSERVE)
                            .map_err(|_| anyhow::anyhow!("no snapshot"))?;
                    let error = reads.client().batch_execute(sql).err();
                    reads.end();
                    Ok(error.and_then(|e| e.code().map(|code| code.code().to_owned())))
                } else {
                    let error = c.batch_execute(sql).err();
                    Ok(error.and_then(|e| e.code().map(|code| code.code().to_owned())))
                }
            }));
            assert_eq!(
                refused.unwrap().as_deref(),
                Some("25006"),
                "{sql} (inside the transaction: {inside})"
            );
        }
    }
    assert_eq!(state(&mut c), before);
}

/// Every statement identity observation sends is prepared on this run's
/// database shape with the parameter types it binds, and each read of a
/// table is planned on an index. The plans are printed.
#[test]
fn every_identity_statement_prepares_and_every_read_is_index_bounded() {
    use postgres::types::Type;
    let db = Database::new("plans");
    let mut c = db.connect();
    // Enough rows that a plan is a choice.
    c.batch_execute(
        "INSERT INTO users(uid, site_id) SELECT 200000 + n, 'bulk-' || n FROM generate_series(1, 20000) n;
         INSERT INTO conversations(zid, owner, is_active) SELECT 1000 + n, 200000 + n, true FROM generate_series(1, 5000) n;
         INSERT INTO zinvites(zid, zinvite) SELECT 1000 + n, 'bulk' || n FROM generate_series(1, 5000) n;
         ALTER TABLE participants DISABLE TRIGGER USER;
         INSERT INTO participants(zid, uid, pid, created) SELECT 1, 200000 + n, 100 + n, 1 FROM generate_series(1, 20000) n;
         ALTER TABLE participants ENABLE TRIGGER USER;
         INSERT INTO xids(owner, uid, xid, zid, pid) SELECT 1, 200000 + n, 'bulk-' || n, 1, 100 + n FROM generate_series(1, 20000) n;
         INSERT INTO xid_whitelist(owner, xid) SELECT 1, 'bulk-' || n FROM generate_series(1, 20000) n;
         INSERT INTO oidc_user_mappings(oidc_sub, uid, created) SELECT 'bulk|' || n, 200000 + n, 0 FROM generate_series(1, 5000) n;",
    )
    .unwrap();
    // One participant's choices on two thousand statements, and three hundred
    // participants' on one of them, each through the sign-aware write.
    {
        let mut tx = c.transaction().unwrap();
        let mut stores = |pid: i32, uid: i32, tid: i32| {
            let member = Admitted {
                zid: 1,
                pid,
                uid,
                active: true,
                _priority_lease: None,
                priorities: Arc::default(),
                follow_on: Arc::new(FollowOnLane::default()),
            };
            let fields = ParsedFields {
                tid: f64::from(tid),
                vote: VoteChoice::Agree,
                starred: None,
                high_priority: false,
                lang: None,
            };
            append_in_transaction(&mut tx, &member, &fields).unwrap();
        };
        for n in 0..2000 {
            stores(101, 200001, 1001 + n);
        }
        for n in 2..=300 {
            stores(100 + n, 200000 + n, 1777);
        }
        tx.commit().unwrap();
    }
    c.batch_execute("ANALYZE").unwrap();
    let statements: [(&str, &str, Vec<Type>, Option<&str>); 15] = [
        (
            "the conversation of a code",
            ZID,
            vec![Type::TEXT],
            Some("'bulk777'"),
        ),
        (
            "the conversation's rules",
            CONVERSATION,
            vec![Type::INT4],
            Some("1"),
        ),
        (
            "the allow-list",
            ALLOWLIST,
            vec![Type::INT4, Type::TEXT],
            Some("1, 'bulk-777'"),
        ),
        (
            "the binding of an external id",
            BOUND,
            vec![Type::INT4, Type::TEXT],
            Some("1, 'bulk-777'"),
        ),
        (
            "the account check",
            ACCOUNT,
            vec![Type::INT4],
            Some("200777"),
        ),
        (
            "membership",
            MEMBER,
            vec![Type::INT4, Type::INT4],
            Some("1, 200777"),
        ),
        (
            "the account check of a token bound to an external id",
            polis_auth::xid_account::SQL,
            vec![Type::INT4],
            Some("200777"),
        ),
        (
            "why the membership read refused",
            MEMBERSHIP,
            vec![Type::INT4, Type::INT4],
            Some("1, 200777"),
        ),
        (
            "the highest participant number",
            TOP,
            vec![Type::INT4],
            Some("1"),
        ),
        (
            "read-back: the newest participants",
            NEWEST_PARTICIPANTS,
            vec![Type::INT4, Type::INT8],
            Some("1, 8"),
        ),
        (
            "read-back: a user's participant row",
            PARTICIPANT,
            vec![Type::INT4, Type::INT4],
            Some("1, 200777"),
        ),
        (
            "read-back: the binding",
            BINDING,
            vec![Type::INT4, Type::TEXT],
            Some("1, 'bulk-777'"),
        ),
        (
            "read-back: the stored choice",
            VOTE,
            vec![Type::INT4, Type::INT4, Type::INT4, Type::INT8],
            Some("1, 101, 1777, 1700000000000"),
        ),
        ("health", "select 1", vec![], Some("")),
        (
            "the server's logging settings",
            LOGGING_SETTINGS,
            vec![],
            None,
        ),
    ];
    let shape = std::env::var("POLIS_API_TEST_DATABASE_SHAPE").unwrap_or("migrations".into());
    for (name, sql, bound, arguments) in statements {
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
        let execute = if arguments.is_empty() {
            "EXECUTE planned".to_owned()
        } else {
            format!("EXECUTE planned({arguments})")
        };
        let plan: Vec<String> = c
            .query(&format!("EXPLAIN (COSTS OFF) {execute}"), &[])
            .unwrap()
            .iter()
            .map(|row| row.get(0))
            .collect();
        println!(
            "identity plan on the {shape} shape: {name}\n  {}",
            plan.join("\n  ")
        );
        let plan = plan.join("\n");
        assert!(!plan.contains("Seq Scan"), "{name}: {plan}");
    }
    // The columns the reads name exist on this shape with the types they read.
    for (table, columns) in [
        (
            "participants",
            vec![
                "pid integer",
                "uid integer",
                "zid integer",
                "created bigint",
            ],
        ),
        (
            "xids",
            vec![
                "uid integer",
                "owner integer",
                "xid text",
                "zid integer",
                "pid integer",
            ],
        ),
        ("xid_whitelist", vec!["owner integer", "xid text"]),
        (
            "conversations",
            vec![
                "owner integer",
                "is_active boolean",
                "treevite_enabled boolean",
                "use_xid_whitelist boolean",
                "xid_required boolean",
            ],
        ),
        ("users", vec!["uid integer", "is_owner boolean"]),
    ] {
        let present: Vec<String> = c
            .query(
                "select attname || ' ' || format_type(atttypid, atttypmod)
                 from pg_attribute where attrelid = $1::text::regclass and attnum > 0
                 and not attisdropped order by attnum",
                &[&table],
            )
            .unwrap()
            .iter()
            .map(|row| row.get(0))
            .collect();
        for column in columns {
            assert!(
                present.contains(&column.to_owned()),
                "{table}: {column}: {present:?}"
            );
        }
    }
}

/// What a copy carries that may never be printed.
const XID_MARK: &str = "kq7Xw93ExternalIdMarkZp4Lm8";
const NAME_MARK: &str = "Vb5Tn2NameMarkQr9Hd6Wy3";
const IMAGE_MARK: &str = "https://images.example.invalid/Gx8Kc4ImageMarkJf2Ns7.png";
const EMAIL_MARK: &str = "Mz6Rp1EmailMarkTw8Bv5@example.invalid";
/// A user and two participant numbers no other number of a line can be.
const MARKED_UID: i32 = 7654001;
const MARKED_PIDS: [i32; 2] = [8123998, 8123999];

/// Every run of `length` characters of `text`.
fn runs(text: &str, length: usize) -> Vec<String> {
    let characters: Vec<char> = text.chars().collect();
    characters
        .windows(length)
        .map(|run| run.iter().collect())
        .collect()
}

/// Whether `output` holds any eight consecutive characters of `secret`: as
/// it is, as JSON writes it, percent-encoded, or in base64 at any of the
/// three alignments (a token bound to an external id carries it that way).
fn leaks(output: &str, secret: &str) -> bool {
    use base64::Engine;
    let mut forms = vec![
        secret.to_owned(),
        // Without the quotes JSON puts around it: they are not the secret's.
        serde_json::to_string(secret)
            .unwrap()
            .trim_matches('"')
            .to_owned(),
        url::form_urlencoded::byte_serialize(secret.as_bytes()).collect(),
    ];
    for lead in ["", "a", "ab"] {
        for engine in [
            &base64::engine::general_purpose::STANDARD,
            &base64::engine::general_purpose::URL_SAFE,
        ] {
            let encoded = engine.encode(format!("{lead}{secret}"));
            // The first and last groups depend on what surrounds the secret.
            let inner: String = encoded
                .chars()
                .skip(4)
                .take(encoded.len().saturating_sub(8))
                .collect();
            forms.push(inner);
        }
    }
    forms
        .iter()
        .flat_map(|form| runs(form, 8))
        .any(|run| output.contains(&run))
}

/// Whether `output` holds any twelve consecutive characters of a token's
/// claims or of its signature.
fn leaks_token(output: &str, token: &str) -> bool {
    token
        .split('.')
        .skip(1)
        .flat_map(|part| runs(part, 12))
        .any(|run| output.contains(&run))
}

#[test]
fn the_leak_check_finds_a_secret_in_every_form() {
    use base64::Engine;
    let token = "aGVhZGVy.Y2xhaW1zLWNsYWltcy1jbGFpbXM.c2lnbmF0dXJlLXNpZ25hdHVyZQ";
    assert!(leaks(&format!("x {XID_MARK} y"), XID_MARK));
    assert!(leaks(&format!("x {} y", &XID_MARK[9..19]), XID_MARK));
    assert!(leaks(
        &serde_json::to_string(IMAGE_MARK).unwrap(),
        IMAGE_MARK
    ));
    assert!(leaks("Mz6Rp1EmailMarkTw8Bv5%40example.invalid", EMAIL_MARK));
    for lead in ["", "sub:", "{\"xid\":\""] {
        let claims = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(format!("{lead}{XID_MARK}\",\"more\":true"));
        assert!(leaks(&claims, XID_MARK), "{lead}");
    }
    assert!(leaks_token(
        "Bearer aGVhZGVy.Y2xhaW1zLWNsYWltcy1jbGFpbXM",
        token
    ));
    assert!(leaks_token("c2lnbmF0dXJlLXNpZ25h", token));
    assert!(!leaks(
        "\"id_entry\":\"xid\",\"id_decision\":\"found\"",
        XID_MARK
    ));
    assert!(!leaks_token("\"id_entry\":\"xid_token\"", token));
}

/// The process-level check. A child process observes copies whose external
/// id, name, image address, email and tokens are marked, for a user and
/// participants with marked numbers: every way of joining, reads that fail
/// with the server quoting the external id, a read cut at its lock bound,
/// and (in a second run, with the shadow role's panic hook) a panic whose
/// message is the copy's own body and token. Nothing the child prints, its
/// /health and its startup event included, holds any part of a marked value.
#[test]
fn nothing_a_failing_or_panicking_identity_observation_prints_holds_what_it_was_given() {
    const CHILD: &str = "POLIS_IDENTITY_OBSERVE_OUTPUT_TEST";
    let marked_body = |cid: &str, xid: Value| {
        let mut body = vote_body(cid, TID, VoteChoice::Agree);
        body["xid"] = xid;
        body["x_name"] = json!(NAME_MARK);
        body["x_profile_image_url"] = json!(IMAGE_MARK);
        body["x_email"] = json!(EMAIL_MARK);
        body
    };
    if let Ok(phase) = std::env::var(CHILD) {
        if phase == "panic" {
            shadow::install_panic_hook();
        }
        let db = Database::new("output");
        let keys = signing();
        // An equality that, given the marked external id, fails quoting both
        // of its operands, as a server error that quotes a key does. Only a
        // session whose search path puts its schema first resolves to it.
        db.connect()
            .batch_execute(&format!(
                "CREATE SCHEMA quoting;
                 CREATE FUNCTION quoting.equal(text, text) RETURNS boolean LANGUAGE plpgsql AS
                 $$ BEGIN
                    IF $2 LIKE 'kq7Xw93%' THEN
                        RAISE EXCEPTION 'comparison quoting % and %', $1, $2
                        USING DETAIL = 'Key (owner, xid)=(1, ' || $2 || ') already exists.';
                    END IF;
                    RETURN pg_catalog.texteq($1, $2);
                 END $$;
                 CREATE OPERATOR quoting.= (LEFTARG = text, RIGHTARG = text, FUNCTION = quoting.equal);
                 INSERT INTO users(uid, site_id) VALUES ({MARKED_UID}, 'marked-site');
                 ALTER TABLE participants DISABLE TRIGGER USER;
                 INSERT INTO participants(zid, uid, pid, created) VALUES (1, {MARKED_UID}, {}, 1), (5, {MARKED_UID}, {}, 1);
                 ALTER TABLE participants ENABLE TRIGGER USER;
                 INSERT INTO xids(owner, uid, xid, zid, pid) VALUES (1, {MARKED_UID}, '{XID_MARK}', 1, {});",
                MARKED_PIDS[1], MARKED_PIDS[0], MARKED_PIDS[1]
            ))
            .unwrap();
        let mut failing = db.config.clone();
        failing.options("-c search_path=quoting,public,pg_catalog");
        let ordinary = observer_on(
            || plain(&db.config),
            Some((plain(&db.config), limits())),
            &keys.public,
        );
        let quoting = shadow_app(observer_on(
            || plain(&db.config),
            Some((plain(&failing), limits())),
            &keys.public,
        ));
        let stage = stage_of(db, keys, ordinary);
        let keys = &stage.keys;
        let bound = xid_token(keys, MARKED_UID, MARKED_PIDS[1], "2open", XID_MARK);
        let member = anonymous(keys, MARKED_UID, MARKED_PIDS[0], "6treevite");
        let elsewhere = anonymous(keys, MARKED_UID, MARKED_PIDS[1], "2open");
        let account = standard_user(keys, MARKED_UID, MARKED_PIDS[1], "7other");
        let provider = sign(
            &signing(),
            &json!({"sub": XID_MARK, "email": EMAIL_MARK, "name": NAME_MARK,
                "iss": "https://provider.invalid/", "aud": "fixture",
                "exp": 4_100_000_000_u64, "iat": 1_600_000_000_u64}),
        );
        for token in [&bound, &member, &elsewhere, &account, &provider] {
            println!("TOKEN {token}");
        }
        let say = |what: &str, line: &Value| {
            println!(
                "observed {what}: {} {} {} {} {}",
                line["reason"],
                line["id_entry"],
                line["id_decision"],
                line["id_why"],
                line["id_node"]
            );
        };
        let first = |cid: &str| vote_body(cid, TID, VoteChoice::Agree);
        let marked = marked_body("2open", json!(XID_MARK));
        if phase == "panic" {
            let id = request_id();
            let req = copy(&marked, Some(&bound), &id);
            stage.rt.block_on(async {
                assert_eq!(
                    shadow::accept(stage.app.clone(), stage.lane.clone(), req)
                        .await
                        .status,
                    204
                );
                // Until the hook has reported the panic: never a fixed time.
                until("the panic is reported", || {
                    shadow::recorded()
                        .iter()
                        .any(|line| line.contains("\"shadow_panic\""))
                })
                .await;
            });
            println!(
                "after the panic: line={} waiting={}",
                printed_line(&id).is_some(),
                stage.identity().waiting()
            );
            return;
        }
        stage
            .rt
            .block_on(stage.identity().report_logging_settings());
        // Every way of joining, with every value marked.
        say("a bound external id", &stage.observe(&marked, None));
        say(
            "a new external id",
            &stage.observe(
                &marked_body("7other", json!(format!("{XID_MARK}-new"))),
                None,
            ),
        );
        say("a token bound to it", &stage.observe(&marked, Some(&bound)));
        say("a first arrival", &stage.observe(&first("2open"), None));
        say(
            "a Treevite member",
            &stage.observe(&first("6treevite"), Some(&member)),
        );
        say(
            "a token for another conversation",
            &stage.observe(&first("7other"), Some(&elsewhere)),
        );
        say(
            "an account",
            &stage.observe(&first("3closed"), Some(&account)),
        );
        say(
            "a provider's token",
            &stage.observe(&first("2open"), Some(&provider)),
        );
        // The mark in every place a body can carry one.
        say(
            "an external id that is a list",
            &stage.observe(&marked_body("2open", json!([XID_MARK])), None),
        );
        say(
            "an external id over the limit",
            &stage.observe(&marked_body("2open", json!(XID_MARK.repeat(40))), None),
        );
        let mut unknown = marked.clone();
        unknown[XID_MARK] = json!(NAME_MARK);
        say("an unknown key", &stage.observe(&unknown, None));
        // A decision whose read fails with the server quoting the external id.
        let line = stage
            .rt
            .block_on(send(&quoting, &stage.lane, &marked, None));
        say("a quoting decision", &line);
        // A read-back whose read fails the same way: decided on the ordinary
        // connection, read back on the quoting one.
        let looks = Looks::new(&stage);
        let failing_identity = quoting
            .post_votes_observe
            .as_ref()
            .unwrap()
            .identity
            .as_deref()
            .unwrap();
        let pending = looks.decide(&stage, &marked, None, "shape_keys");
        let at = anchor(&mut stage.db.connect());
        let observed = stage.rt.block_on(failing_identity.read_back(
            pending,
            Some(at),
            tokio::time::Instant::now(),
        ));
        let mut keys_of_line = js::Obj::new();
        print_keys(&mut keys_of_line, Some(&observed));
        let printed: Value = serde_json::from_str(&js::stringify(&Js::Obj(keys_of_line))).unwrap();
        println!("{printed}");
        say("a quoting read-back", &printed);
        // A read cut at its lock bound.
        {
            let mut locker = stage.db.connect();
            let mut held = locker.transaction().unwrap();
            held.batch_execute("LOCK TABLE xids IN ACCESS EXCLUSIVE MODE")
                .unwrap();
            say("a locked decision", &stage.observe(&marked, None));
            held.rollback().unwrap();
        }
        for app in [&stage.app, &quoting] {
            let health = stage.rt.block_on(async {
                let out = shadow::health(app, &stage.lane).await;
                let crate::http::Body::Fixed(bytes) = out.body else {
                    panic!("health has a body");
                };
                String::from_utf8(bytes).unwrap()
            });
            println!("health {health}");
        }
        return;
    }
    let run = |phase: &str| {
        let mut child = std::process::Command::new(std::env::current_exe().unwrap());
        child
            .args([
                "--exact",
                "post_votes::identity::tests::database::proofs::nothing_a_failing_or_panicking_identity_observation_prints_holds_what_it_was_given",
                "--nocapture",
            ])
            .env(CHILD, phase);
        if phase == "panic" {
            child.env(PANIC_IN_DECISION, "1");
        }
        let output = child.output().unwrap();
        let printed = format!(
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            output.status.success(),
            "{phase}: the child failed: {printed}"
        );
        // The child says which tokens it signed, on lines of their own; those
        // lines are the test's and are taken out before the search.
        let tokens: Vec<String> = printed
            .lines()
            .filter_map(|line| line.strip_prefix("TOKEN ").map(str::to_owned))
            .collect();
        assert_eq!(tokens.len(), 5, "{printed}");
        let output: String = printed
            .lines()
            .filter(|line| !line.starts_with("TOKEN "))
            .collect::<Vec<_>>()
            .join("\n");
        (output, tokens)
    };
    let clean = |phase: &str, output: &str, tokens: &[String]| {
        for secret in [XID_MARK, NAME_MARK, IMAGE_MARK, EMAIL_MARK] {
            assert!(!leaks(output, secret), "{phase}: {secret}: {output}");
        }
        for token in tokens {
            assert!(!leaks_token(output, token), "{phase}: a token: {output}");
        }
        for number in [MARKED_UID, MARKED_PIDS[0], MARKED_PIDS[1]] {
            assert!(
                !output.contains(&number.to_string()),
                "{phase}: {number}: {output}"
            );
        }
    };
    let (errors, tokens) = run("errors");
    for observed in [
        "observed a bound external id: \"shape_keys\" \"xid\" \"found\" null \"found\"",
        "observed a new external id: \"shape_keys\" \"xid\" \"create_user_and_participant\" null \"none\"",
        "observed a token bound to it: \"shape_keys\" \"xid_token\" \"found\" null \"found\"",
        "observed a first arrival: \"no_token\" \"none\" \"create_user_and_participant\" null \"none\"",
        "observed a Treevite member: \"not_a_participant\" \"anonymous_token\" \"found\" null \"found\"",
        "observed a token for another conversation: \"token_refused\" \"anonymous_token\" \"create_user_and_participant\" null \"none\"",
        "observed an account: \"token_refused\" \"standard_user_token\" \"refuse\" null \"none\"",
        "observed a provider's token: \"token_refused\" \"foreign_token\" \"cannot_decide\" \"token_unverified\" \"not_checked\"",
        "observed an external id that is a list: \"shape_keys\" \"none\" \"refuse\" null \"not_checked\"",
        "observed an external id over the limit: \"shape_keys\" \"none\" \"refuse\" null \"not_checked\"",
        "observed an unknown key: \"shape_keys\" null null null null",
        "observed a quoting decision: \"shape_keys\" \"xid\" \"unavailable\" \"reads_failed\" \"not_checked\"",
        "observed a quoting read-back: null \"xid\" \"found\" null \"unavailable\"",
        "observed a locked decision: \"shape_keys\" \"xid\" \"unavailable\" \"reads_failed\" \"not_checked\"",
    ] {
        assert!(errors.contains(observed), "{observed}: {errors}");
    }
    assert_eq!(errors.matches("health {").count(), 2, "{errors}");
    assert!(
        errors.matches("\"shadow_observation\"").count() >= 13,
        "the child's lines were not captured: {errors}"
    );
    assert!(
        errors.contains("\"shadow_post_votes_identity_database_logging\"")
            && errors.contains("\"xid_lookup\":\"enabled\""),
        "{errors}"
    );
    clean("errors", &errors, &tokens);
    let (panicked, tokens) = run("panic");
    assert!(
        panicked.contains("\"shadow_panic\"")
            && panicked.contains("post_votes_identity_tests.rs:")
            && panicked.contains("after the panic: line=false waiting=0"),
        "{panicked}"
    );
    assert!(!panicked.contains("forced panic"), "{panicked}");
    clean("panic", &panicked, &tokens);
}

/// A flood of identity copies beside a member's choices. The member's copies
/// are observed exactly as they are with identity observation off: the same
/// number of observations, the same outcome, reason and classes for each,
/// the same look of the read-back deciding each, and the same use of the
/// existing observer's two pools. Identity copies wait in a queue of their
/// own, on a connection of their own, and hold no place in the lane while
/// they wait.
///
/// Nothing is placed by time. In each round the identity connection is held,
/// so that every identity copy of the round is waiting for it. The round's
/// copies, more than the lane can hold at once, are sent in waves; each wave
/// is sent only when the lane is empty again, which it can only be if a copy
/// waiting for its identity decision has given its place in the lane back.
/// When the existing observer's two pools have finished what the copies ask
/// of them, the member's copy is sent and observed, with the whole round's
/// identity work still queued and the lane empty. Then the connection is let
/// go and the round's identity copies finish before the next round.
#[test]
fn a_flood_of_identity_copies_leaves_a_members_copies_observed_as_before() {
    const WAVE: usize = 16;
    const WAVES: usize = 3;
    /// More than the lane's 32 places.
    const BURST: usize = WAVE * WAVES;
    /// The copies of a round that carry a token admission reads for.
    const ADMITTED: usize = BURST / 3;
    const ROUNDS: i32 = 3;
    let attempts = |pool: &Arc<db::Pool>| {
        let [acquired, _, timeouts, ..] = pool.evidence.snapshot();
        acquired + timeouts
    };
    let idle = |pool: &Arc<db::Pool>| {
        let [acquired, _, _, completed, ..] = pool.evidence.snapshot();
        acquired == completed
    };
    let run = |identity: bool| {
        let db = Database::new(if identity { "flood_on" } else { "flood_off" });
        let keys = signing();
        let observer = observer_on(
            || plain(&db.config),
            identity.then(|| {
                (
                    plain(&db.config),
                    // A copy may wait for the connection as long as the test
                    // holds it.
                    db::Limits {
                        acquire_timeout: Duration::from_secs(60),
                        ..limits()
                    },
                )
            }),
            &keys.public,
        );
        let stage = stage_of(db, keys, observer);
        let keys = &stage.keys;
        let lane = &stage.lane;
        let observer = stage.app.post_votes_observe.as_ref().unwrap();
        let member = anonymous(keys, 2, 8123456, "2open");
        let treevite = anonymous(keys, 2, 0, "6treevite");
        let mut flood = Vec::new();
        let mut members = Vec::new();
        let lines = stage.rt.block_on(async {
            for tid in 0..ROUNDS {
                let asked = (attempts(&observer.readback), attempts(&observer.reads));
                let held = match observer.identity.as_deref() {
                    None => None,
                    Some(identity) => {
                        let (release, granted) = hold(&identity.pool);
                        granted.await.unwrap();
                        Some((release, identity.pool.evidence.snapshot()[1]))
                    }
                };
                // The flood: first arrivals, external ids and Treevite
                // members, a wave at once and none awaited.
                for wave in 0..WAVES {
                    for n in 0..WAVE {
                        let id = request_id();
                        let (body, token) = match (wave * WAVE + n) % 3 {
                            0 => (vote_body("2open", tid, VoteChoice::Agree), None),
                            2 => (
                                vote_body("6treevite", tid, VoteChoice::Agree),
                                Some(treevite.as_str()),
                            ),
                            _ => (named("2open", json!("fresh")), None),
                        };
                        let out = shadow::accept(
                            stage.app.clone(),
                            lane.clone(),
                            copy(&body, token, &id),
                        )
                        .await;
                        assert_eq!(out.status, 204);
                        flood.push(id);
                    }
                    // Every copy of the wave has left the lane, though with
                    // identity on each still waits for its decision.
                    until("the wave's copies leave the lane", || lane.in_flight() == 0).await;
                }
                until("the existing pools finish the round's copies", || {
                    attempts(&observer.readback) >= asked.0 + BURST
                        && attempts(&observer.reads) >= asked.1 + ADMITTED
                        && idle(&observer.readback)
                        && idle(&observer.reads)
                })
                .await;
                if let (Some(identity), Some((_, waited))) = (observer.identity.as_deref(), &held) {
                    until("every identity copy of the round waits", || {
                        identity.pool.evidence.snapshot()[1] >= waited + BURST
                    })
                    .await;
                    assert_eq!(identity.waiting(), BURST);
                }
                assert_eq!(lane.in_flight(), 0);
                // The member's copy, with the round's identity work queued.
                let id = request_id();
                let body = vote_body("2open", tid, VoteChoice::Disagree);
                let out = shadow::accept(
                    stage.app.clone(),
                    lane.clone(),
                    copy(&body, Some(member.as_str()), &id),
                )
                .await;
                assert_eq!(out.status, 204);
                members.push(serde_json::from_str::<Value>(&printed(&id).await).unwrap());
                drop(held);
                if let Some(identity) = observer.identity.as_deref() {
                    until("the round's identity copies finish", || {
                        identity.waiting() == 0
                    })
                    .await;
                }
            }
            let mut lines = Vec::new();
            for id in &flood {
                lines.push(serde_json::from_str::<Value>(&printed(id).await).unwrap());
            }
            lines
        });
        let pools = [
            observer.reads.evidence.snapshot(),
            observer.readback.evidence.snapshot(),
        ];
        (members, lines, pools, stage.health())
    };
    let (off_members, off_flood, off_pools, off_health) = run(false);
    let (on_members, on_flood, on_pools, on_health) = run(true);
    // The member's copies: one observation each, the same in every key that
    // is not a duration or the copy's own id.
    assert_eq!(off_members.len(), ROUNDS as usize);
    assert_eq!(on_members.len(), off_members.len());
    for (on, off) in on_members.iter().zip(&off_members) {
        for key in VOTE_KEYS {
            if matches!(
                key,
                "request_id" | "queue_ms" | "admission_ms" | "selection_ms" | "total_ms"
            ) {
                continue;
            }
            assert_eq!(on[key], off[key], "{key}: {on} / {off}");
        }
        assert_eq!(on["outcome"], "would_serve");
        assert_eq!(on["status"], 200);
        assert_eq!(on["follow_on"], "complete");
        // The same look of the read-back decided it.
        assert_eq!(on["readback_s"], off["readback_s"]);
        assert!(LINE_KEYS.iter().all(|key| on[*key].is_null()), "{on}");
    }
    // The existing observer's own pools were asked for the same work in both
    // runs (connections granted and requests that gave up waiting, together),
    // finished what they were granted, and failed nothing.
    for (on, off) in on_pools.iter().zip(&off_pools) {
        for [acquired, _waited, _timeouts, completed, errors, _deadlines] in [*on, *off] {
            assert_eq!(acquired, completed);
            assert_eq!(errors, 0);
        }
        assert_eq!(on[0] + on[2], off[0] + off[2], "{on:?} / {off:?}");
    }
    assert_eq!(on_health["postVotes"], off_health["postVotes"]);
    // The flood itself: the existing part of each line is the same in both
    // runs, and with identity on every copy is decided or says it was not.
    assert_eq!(on_flood.len(), ROUNDS as usize * BURST);
    for (on, off) in on_flood.iter().zip(&off_flood) {
        for key in ["outcome", "admitted", "status", "reason", "zid"] {
            assert_eq!(on[key], off[key], "{key}");
        }
        assert_eq!(on["outcome"], "would_hand_back");
        assert!(off.get("id_decision").is_none());
        assert_eq!(identity_values(on), Ok(()));
        assert!(
            ["create_user_and_participant", "found"].contains(&on["id_decision"].as_str().unwrap()),
            "{on}"
        );
    }
    let identity = &on_health["postVotesIdentity"];
    assert_eq!(identity["decided"], (ROUNDS as usize * BURST) as u64);
    assert_eq!(identity["waiting"], 0);
    assert!(identity["wouldCreate"].as_u64().unwrap() > 0);
    assert!(identity["wouldFind"].as_u64().unwrap() > 0);
}

/// More identity copies than may wait at once: the rest are not decided, and
/// say so at once, and none of them holds the identity connection.
#[test]
fn identity_copies_beyond_the_waiting_bound_are_not_decided() {
    let stage = stage("bound");
    let looks = Looks::new(&stage);
    let body = vote_body("2open", TID, VoteChoice::Agree);
    stage.rt.block_on(async {
        // The connection is held, so every decision waits for it.
        let (held, granted) = looks.hold();
        granted.await.unwrap();
        let verifier = &looks.verifier;
        let identity = &looks.identity;
        let requests: Vec<Request> = (0..WAITING + 5)
            .map(|_| copy(&body, None, &request_id()))
            .collect();
        // Each decision is polled once, in order: the first WAITING take a
        // place and wait for the connection; the rest are answered at once.
        let mut shed = 0;
        let mut waiting = Vec::new();
        for req in &requests {
            let mut decision = Box::pin(identity.decide(verifier, &[], req, Some("no_token")));
            match poll_once(&mut decision).await {
                Some(done) => {
                    let done = done.expect("an identity copy");
                    assert_eq!(done.observed.decided, Decided::Shed);
                    assert_eq!(done.observed.why, Some(Why::WaitingFull));
                    shed += 1;
                }
                None => waiting.push(decision),
            }
        }
        assert_eq!(shed, 5);
        assert_eq!(waiting.len(), WAITING);
        assert_eq!(identity.waiting(), WAITING);
        drop(held);
        for decision in waiting {
            let done = decision.await.expect("an identity copy");
            assert_eq!(done.observed.decided, Decided::CreateUserAndParticipant);
        }
        assert_eq!(identity.waiting(), 0);
    });
}

/// Polls a future once: its answer if it is ready, None if it waits.
async fn poll_once<F: std::future::Future + Unpin>(future: &mut F) -> Option<F::Output> {
    std::future::poll_fn(|cx| {
        std::task::Poll::Ready(match std::pin::Pin::new(&mut *future).poll(cx) {
            std::task::Poll::Ready(output) => Some(output),
            std::task::Poll::Pending => None,
        })
    })
    .await
}

/// Where a setting of the server could write a parameter into its log, no
/// external id is sent to it: the copies that name one read unavailable, the
/// statements that would carry one never cross the wire, every other copy is
/// decided as usual, and the startup event names the setting.
#[test]
fn an_external_id_is_not_sent_to_a_server_that_could_log_it() {
    let db = Database::new("logging");
    db.connect()
        .batch_execute(&format!(
            "ALTER DATABASE {} SET log_min_duration_statement = 0",
            db.name
        ))
        .unwrap();
    let keys = signing();
    let recorder = Recorder::start(&db.config);
    let through = recorder.config(&db.config);
    let observer = observer_on(
        || plain(&db.config),
        Some((plain(&through), limits())),
        &keys.public,
    );
    let stage = stage_of(db, keys, observer);
    let keys = &stage.keys;
    stage
        .rt
        .block_on(stage.identity().report_logging_settings());
    let event = shadow::recorded()
        .into_iter()
        .rev()
        .find(|line| line.contains("\"shadow_post_votes_identity_database_logging\""))
        .expect("the startup event");
    let event: Value = serde_json::from_str(&event).unwrap();
    assert_eq!(event["read"], "ok");
    assert_eq!(event["xid_lookup"], "disabled");
    assert_eq!(event["because"], "log_min_duration_statement");
    let bound = xid_token(keys, 4, 8123457, "2open", "known");
    let first = |cid: &str| vote_body(cid, TID, VoteChoice::Agree);
    for (what, body, token) in [
        ("an external id", named("2open", json!("known")), None),
        ("a token bound to one", first("2open"), Some(bound.as_str())),
        (
            "a token bound to one, in another conversation",
            first("7other"),
            Some(bound.as_str()),
        ),
    ] {
        let line = stage.observe(&body, token);
        expect(
            what,
            &line,
            &[
                ("id_decision", json!("unavailable")),
                ("id_why", json!("xid_lookup_disabled")),
                ("id_zid", Value::Null),
                ("id_node", json!("not_checked")),
                ("id_compare", json!("unknown")),
            ],
        );
    }
    // A copy that names none is decided as usual.
    let line = stage.observe(&first("2open"), None);
    assert_eq!(line["id_decision"], "create_user_and_participant");
    assert_eq!(stage.health()["postVotesIdentity"]["xidLookup"], "disabled");
    let sent = recorder.statements();
    assert!(sent.contains(&one_line(LOGGING_SETTINGS)));
    assert!(sent.contains(&one_line(CONVERSATION)));
    for sql in &sent {
        let lower = sql.to_lowercase();
        assert!(
            !lower.contains("from xids") && !lower.contains("from xid_whitelist"),
            "a statement that carries an external id was sent: {sql}"
        );
    }
}

/// The server's logging settings are read again, in the same transaction and
/// just before each statement that binds an external id: a setting turned on
/// while the process runs stops the very next external id from being sent,
/// and /health says so. Seen from the wire.
#[test]
fn a_logging_setting_turned_on_later_stops_the_next_external_id() {
    let db = Database::new("later");
    let keys = signing();
    let recorder = Recorder::start(&db.config);
    let through = recorder.config(&db.config);
    let observer = observer_on(
        || plain(&db.config),
        Some((plain(&through), limits())),
        &keys.public,
    );
    let stage = stage_of(db, keys, observer);
    let mut c = stage.db.connect();
    let carries_an_external_id = |recorder: &Recorder| {
        recorder
            .statements()
            .iter()
            .filter(|sql| {
                let lower = sql.to_lowercase();
                lower.contains("from xids") || lower.contains("from xid_whitelist")
            })
            .count()
    };
    stage
        .rt
        .block_on(stage.identity().report_logging_settings());
    // While no setting can log a parameter, an external id is looked up.
    let line = stage.observe(&named("2open", json!("known")), None);
    assert_eq!(line["id_decision"], "found");
    assert_eq!(stage.health()["postVotesIdentity"]["xidLookup"], "enabled");
    let sent_before = carries_an_external_id(&recorder);
    assert!(sent_before > 0);
    // The setting is turned on for this database, and the sessions that were
    // open are ended, as a server whose configuration changes ends or renews
    // them: the process is the same process, with its first reading in hand.
    c.batch_execute(&format!(
        "ALTER DATABASE {} SET log_min_duration_statement = 0;
         SELECT pg_terminate_backend(pid) FROM pg_stat_activity
         WHERE datname = current_database() AND pid <> pg_backend_pid()",
        stage.db.name
    ))
    .unwrap();
    // A copy that names no external id is decided once a connection is back.
    let first = |cid: &str| vote_body(cid, TID, VoteChoice::Agree);
    let mut decided = false;
    for _ in 0..20 {
        if stage.observe(&first("2open"), None)["id_decision"] == "create_user_and_participant" {
            decided = true;
            break;
        }
    }
    assert!(decided, "the identity connection came back");
    // The next external id is not sent.
    let line = stage.observe(&named("2open", json!("known")), None);
    expect(
        "an external id after the setting changed",
        &line,
        &[
            ("id_decision", json!("unavailable")),
            ("id_why", json!("xid_lookup_disabled")),
            ("id_node", json!("not_checked")),
        ],
    );
    assert_eq!(
        carries_an_external_id(&recorder),
        sent_before,
        "a statement that carries an external id was sent after the setting changed"
    );
    let health = stage.health();
    assert_eq!(health["postVotesIdentity"]["xidLookup"], "disabled");
    assert!(
        health["postVotesIdentity"]["xidLookupReadAt"]
            .as_f64()
            .is_some()
    );
}

/// Each look of the read-back reads the server's logging settings itself: a
/// setting turned on after a copy was decided stops that copy's look from
/// sending its external id, whatever the decision's own reading was. Seen
/// from the wire.
#[test]
fn a_logging_setting_turned_on_after_the_decision_stops_the_look() {
    let stage = stage("look_later");
    let recorder = Recorder::start(&stage.db.config);
    let through = recorder.config(&stage.db.config);
    let mut identity = IdentityObserver::new(db::Pool::new(
        plain(&through),
        db::Limits {
            acquire_timeout: Duration::from_secs(60),
            ..limits()
        },
    ));
    identity.timing = test_timing();
    let looks = Looks {
        identity,
        verifier: participant::Verifier::new(&stage.keys.public, "fixture", "fixture").unwrap(),
    };
    let mut c = stage.db.connect();
    let carries_an_external_id = |recorder: &Recorder| {
        recorder
            .statements()
            .iter()
            .filter(|sql| {
                let lower = sql.to_lowercase();
                lower.contains("from xids") || lower.contains("from xid_whitelist")
            })
            .count()
    };
    let at = anchor(&mut c);
    // Decided while no setting can log a parameter: the external id is looked
    // up, and the copy waits for its read-back with it in hand.
    let pending = looks.decide(&stage, &named("2open", json!("known")), None, "shape_keys");
    assert_eq!(pending.observed.decided, Decided::Found);
    let sent_before = carries_an_external_id(&recorder);
    assert!(sent_before > 0);
    // The setting is turned on for this database and the open sessions are
    // ended, between the decision and its read-back.
    c.batch_execute(&format!(
        "ALTER DATABASE {} SET log_min_duration_statement = 0;
         SELECT pg_terminate_backend(pid) FROM pg_stat_activity
         WHERE datname = current_database() AND pid <> pg_backend_pid()",
        stage.db.name
    ))
    .unwrap();
    // The identity connection is back once a copy that names no external id
    // is decided on it.
    let first = vote_body("2open", TID, VoteChoice::Agree);
    let mut back = false;
    for _ in 0..20 {
        let probe = looks.decide(&stage, &first, None, "no_token");
        if probe.observed.decided == Decided::CreateUserAndParticipant {
            back = true;
            break;
        }
    }
    assert!(back, "the identity connection came back");
    // The look reads the settings, and does not send the external id.
    let observed = looks.read_back(&stage, pending, Some(at));
    assert_eq!(observed.node, Node::Unavailable);
    assert_eq!(observed.node_xid, None);
    assert_eq!(observed.compare, Compare::Unknown);
    assert_eq!(
        carries_an_external_id(&recorder),
        sent_before,
        "a look sent a statement that carries an external id after the setting changed"
    );
}
