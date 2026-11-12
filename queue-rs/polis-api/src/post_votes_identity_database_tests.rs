//! Identity observation on PostgreSQL, on a database built from every
//! migration (and, in the suite's second pass, in the shape of an
//! installation older than them): the decision for every way of joining, the
//! read-back of what Node left, the statements sent, the plans they get, and
//! the proofs that nothing is written, locked or logged.
use super::*;
use polis_auth::{
    Zid,
    admission::{Entry as Join, Identity as Joining, Request as JoinRequest, admit},
};
use postgres::{Client, NoTls};

/// Conversations of every kind admission tells apart, all of one owner
/// (user 1), with their members created long before any copy. Conversation
/// 1 numbers its participants from 8123456 and new users are numbered from
/// 7654321, so that either number is recognisable wherever it is printed.
const FIXTURE: &str = "
    INSERT INTO users(uid, is_owner, site_id) VALUES (1, true, 'owner-site'), (2, false, 'site-2'),
        (3, false, 'site-3'), (4, false, 'site-4'), (5, false, 'site-5'), (6, false, 'site-6');
    SELECT setval('users_uid_seq', 7654320);
    INSERT INTO conversations(zid, owner, is_active) VALUES (1, 1, true), (2, 1, false), (6, 1, true);
    INSERT INTO conversations(zid, owner, is_active, xid_required) VALUES (3, 1, true, true);
    INSERT INTO conversations(zid, owner, is_active, use_xid_whitelist) VALUES (4, 1, true, true);
    INSERT INTO conversations(zid, owner, is_active, treevite_enabled) VALUES (5, 1, true, true);
    INSERT INTO zinvites(zid, zinvite) VALUES (1, '2open'), (2, '3closed'), (3, '4xidreq'),
        (4, '5allow'), (5, '6treevite'), (6, '7other');
    ALTER TABLE participants DISABLE TRIGGER USER;
    INSERT INTO participants(zid, uid, pid, created) VALUES (1, 2, 8123456, 1), (1, 4, 8123457, 1),
        (5, 2, 0, 1), (5, 3, 1, 1);
    ALTER TABLE participants ENABLE TRIGGER USER;
    INSERT INTO xids(owner, uid, xid, zid, pid) VALUES (1, 4, 'known', 1, 8123457);
    INSERT INTO xids(owner, uid, xid) VALUES (1, 1, 'ownerxid');
    INSERT INTO xid_whitelist(owner, xid) VALUES (1, 'listed');
    INSERT INTO comments(zid, pid, uid, txt)
        SELECT 1, 8123456, 2, 'Statement ' || t FROM generate_series(0, 3) t ORDER BY t;";

pub(crate) struct Database {
    // Held until the database is dropped, as the vote fixtures hold it: the
    // tests that measure time never run beside this one's migrations.
    _fixture_lock: Box<dyn std::any::Any>,
    admin: Client,
    name: String,
    pub(crate) config: postgres::Config,
}

impl Database {
    /// A database of this test's own, built from every migration in order,
    /// with the fixture above.
    pub(crate) fn new(label: &str) -> Self {
        let fixture_lock = crate::post_votes::tests::database::shared_fixture_lock();
        let mut config: postgres::Config = std::env::var("POLIS_API_TEST_DATABASE_URL")
            .unwrap()
            .parse()
            .unwrap();
        let mut admin = config.connect(NoTls).unwrap();
        let name = format!("identity_{label}_{}", std::process::id());
        admin
            .batch_execute(&format!("CREATE DATABASE {name}"))
            .unwrap();
        config.dbname(&name);
        let db = Self {
            _fixture_lock: fixture_lock,
            admin,
            name,
            config,
        };
        let mut c = db.connect();
        for (file, sql) in crate::older_database_shape_tests::migrations() {
            crate::older_database_shape_tests::apply(&mut c, &sql)
                .unwrap_or_else(|error| panic!("{file}: {error:?}"));
        }
        c.batch_execute(FIXTURE).unwrap();
        db
    }

    pub(crate) fn connect(&self) -> Client {
        self.config.connect(NoTls).unwrap()
    }
}

impl Drop for Database {
    fn drop(&mut self) {
        let _ = self
            .admin
            .batch_execute(&format!("DROP DATABASE {} WITH (FORCE)", self.name));
    }
}

fn plain(config: &postgres::Config) -> Connector {
    Connector::Plain(Box::new(config.clone()))
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
}

/// Every table Node's creation path writes (`users`, `participants_extended`,
/// `participants`, `conversations` through the participant-number trigger,
/// `xids`, `oidc_user_mappings` for an account, `participant_metadata_choices`
/// for a join with answers), the vote tables, `auth_tokens`, and the rest a
/// vote or a join can touch; the user-number sequence; and the advisory
/// locks held by anyone. One comparable value.
fn state(c: &mut Client) -> Vec<String> {
    let mut state = Vec::new();
    for table in [
        "users",
        "participants",
        "participants_extended",
        "xids",
        "xid_whitelist",
        "votes",
        "votes_latest_unique",
        "auth_tokens",
        "oidc_user_mappings",
        "participant_metadata_choices",
        "conversations",
        "zinvites",
        "comments",
        "stars",
        "event_ptpt_no_more_comments",
    ] {
        let exists: bool = c
            .query_one("select to_regclass('public.' || $1) is not null", &[&table])
            .unwrap()
            .get(0);
        assert!(exists, "{table} is not a table of this database");
        let digest: String = c
            .query_one(
                &format!(
                    "select count(*)::text || ':' || coalesce(md5(string_agg(t::text, ',' order by t::text)), '') from {table} t"
                ),
                &[],
            )
            .unwrap()
            .get(0);
        state.push(format!("{table} {digest}"));
    }
    for sql in [
        "select 'users_uid_seq ' || last_value::text || ':' || is_called::text from users_uid_seq",
        "select 'advisory locks ' || count(*)::text from pg_locks where locktype = 'advisory'
             and database = (select oid from pg_database where datname = current_database())",
    ] {
        state.push(c.query_one(sql, &[]).unwrap().get(0));
    }
    state
}

/// Node, for these tests: the staged admission on a writable connection.
fn joins(c: &mut Client, zid: i32, identity: Joining<'_>) -> polis_auth::admission::Admitted {
    admit(
        c,
        &JoinRequest {
            zid: Zid(zid),
            identity,
            entry: Join::Participation {
                create_if_missing: true,
            },
            admin_uids: &[],
            x_name: None,
            x_email: None,
            x_profile_image_url: None,
        },
    )
    .unwrap()
    .unwrap()
}

/// A participant's vote, stored through the vote writer's own sign-aware
/// write.
fn stores(c: &mut Client, zid: i32, pid: i32, uid: i32, tid: i32, choice: VoteChoice) {
    let member = Admitted {
        zid,
        pid,
        uid,
        active: true,
        _priority_lease: None,
        priorities: Arc::default(),
        follow_on: Arc::new(FollowOnLane::default()),
    };
    let fields = ParsedFields {
        tid: f64::from(tid),
        vote: choice,
        starred: None,
        high_priority: false,
        lang: None,
    };
    append(c, &member, &fields).unwrap();
}

/// A new person arrives without a token and votes, as Node stores it.
fn arrives_and_votes(c: &mut Client, zid: i32, tid: i32, choice: VoteChoice) {
    let joined = joins(c, zid, Joining::Anonymous);
    stores(c, zid, joined.pid.0 as i32, joined.uid.0, tid, choice);
}

struct Stage {
    rt: tokio::runtime::Runtime,
    keys: Signing,
    db: Database,
    app: Arc<App>,
    lane: Arc<shadow::Lane>,
}

fn stage(label: &str) -> Stage {
    let db = Database::new(label);
    let keys = signing();
    let observer = observer_on(
        || plain(&db.config),
        Some((plain(&db.config), limits())),
        &keys.public,
    );
    stage_of(db, keys, observer)
}

fn stage_of(db: Database, keys: Signing, observer: Observer) -> Stage {
    Stage {
        rt: runtime(),
        app: shadow_app(observer),
        lane: shadow::Lane::new(1000),
        keys,
        db,
    }
}

impl Stage {
    /// One copy through the shadow listener, and its line.
    fn observe(&self, body: &Value, token: Option<&str>) -> Value {
        self.rt.block_on(send(&self.app, &self.lane, body, token))
    }

    fn identity(&self) -> &IdentityObserver {
        self.app
            .post_votes_observe
            .as_ref()
            .unwrap()
            .identity
            .as_deref()
            .unwrap()
    }

    fn health(&self) -> Value {
        self.rt.block_on(async {
            let out = shadow::health(&self.app, &self.lane).await;
            let crate::http::Body::Fixed(bytes) = out.body else {
                panic!("health has a body");
            };
            serde_json::from_slice(&bytes).unwrap()
        })
    }
}

fn named(cid: &str, xid: Value) -> Value {
    let mut body = vote_body(cid, TID, VoteChoice::Agree);
    body["xid"] = xid;
    body["x_name"] = json!("A Name");
    body["x_profile_image_url"] = json!("https://example.invalid/picture.png");
    body
}

fn expect(what: &str, line: &Value, expected: &[(&str, Value)]) {
    for (key, value) in expected {
        assert_eq!(line[*key], *value, "{what}: {key} in {line}");
    }
}

/// Every way a request can identify itself on the vote route, with Node
/// having done nothing: what admission would decide, named on the line, and
/// not one row, sequence value or lock changed.
#[test]
fn every_way_of_joining_is_decided_by_reads_and_changes_nothing() {
    let stage = stage("joining");
    let keys = &stage.keys;
    let mut c = stage.db.connect();
    let before = state(&mut c);
    let agree = |cid: &str| vote_body(cid, TID, VoteChoice::Agree);
    let f = json!(false);
    let t = json!(true);
    let null = Value::Null;
    // A first vote with no token and no external id.
    let line = stage.observe(&agree("2open"), None);
    expect(
        "an anonymous first vote",
        &line,
        &[
            ("outcome", json!("would_hand_back")),
            ("reason", json!("no_token")),
            ("zid", null.clone()),
            ("id_basis", json!("one_instant_reads")),
            ("id_entry", json!("none")),
            ("id_token_scope", null.clone()),
            ("id_decision", json!("create_user_and_participant")),
            ("id_refusal", null.clone()),
            ("id_why", null.clone()),
            ("id_zid", json!(1)),
            ("id_xid_required", f.clone()),
            ("id_xid_allowlist", f.clone()),
            ("id_treevite", f.clone()),
            ("id_xid", json!("none")),
            ("id_member", f.clone()),
            ("id_member_treevite", null.clone()),
            ("id_member_row", null.clone()),
            ("id_fields", t.clone()),
            ("id_node", json!("none")),
            ("id_node_xid", null.clone()),
            ("id_node_vote", null.clone()),
            ("id_timing", null.clone()),
            ("id_compare", json!("unknown")),
        ],
    );
    assert!(line["id_decision_ms"].as_f64().is_some());
    assert!(line["id_readback_s"].as_f64().is_some());
    // Refused before anyone would be created.
    for (what, cid, refusal, zid, rule) in [
        ("closed", "3closed", "closed", json!(2), None),
        (
            "an external id is required",
            "4xidreq",
            "xid_required",
            json!(3),
            Some("id_xid_required"),
        ),
        (
            "an allow-list implies an external id",
            "5allow",
            "xid_required",
            json!(4),
            Some("id_xid_allowlist"),
        ),
        (
            "Treevite",
            "6treevite",
            "treevite",
            json!(5),
            Some("id_treevite"),
        ),
        (
            "no such conversation",
            "9nothing",
            "unknown_conversation",
            null.clone(),
            None,
        ),
    ] {
        let line = stage.observe(&agree(cid), None);
        expect(
            what,
            &line,
            &[
                ("reason", json!("no_token")),
                ("id_decision", json!("refuse")),
                ("id_refusal", json!(refusal)),
                ("id_zid", zid),
                ("id_compare", json!("unknown")),
            ],
        );
        match rule {
            Some(rule) => assert_eq!(line[rule], true, "{what}"),
            // Refused before the conversation's rules are read.
            None => assert!(line["id_treevite"].is_null(), "{what}"),
        }
    }
    // An external id and no token. The vote observer hands the copy back at
    // its shape check, as before; identity reads it all the same.
    for (what, body, expected) in [
        (
            "a new external id",
            named("2open", json!("fresh")),
            vec![
                ("id_decision", json!("create_user_and_participant")),
                ("id_xid", json!("unbound")),
                ("id_member", f.clone()),
                ("id_node", json!("none")),
                ("id_node_xid", json!("unbound")),
                ("id_compare", json!("unknown")),
            ],
        ),
        (
            "a bound external id, a member here",
            named("2open", json!("known")),
            vec![
                ("id_decision", json!("found")),
                ("id_xid", json!("bound")),
                ("id_member", t.clone()),
                ("id_node", json!("found")),
                ("id_node_xid", json!("bound_here")),
                ("id_node_vote", json!("absent")),
                ("id_compare", json!("agree")),
            ],
        ),
        (
            "a bound external id, new to this conversation of the owner",
            named("7other", json!("known")),
            vec![
                ("id_decision", json!("create_participant")),
                ("id_xid", json!("bound")),
                ("id_member", f.clone()),
                ("id_node", json!("none")),
                ("id_node_xid", json!("bound_elsewhere")),
                ("id_compare", json!("unknown")),
            ],
        ),
        (
            "an external id not on the allow-list",
            named("5allow", json!("unlisted")),
            vec![
                ("id_decision", json!("refuse")),
                ("id_refusal", json!("xid_not_allowed")),
                ("id_xid", json!("not_looked_up")),
                ("id_xid_allowlist", t.clone()),
            ],
        ),
        (
            "an external id on the allow-list",
            named("5allow", json!("listed")),
            vec![
                ("id_decision", json!("create_user_and_participant")),
                ("id_xid", json!("unbound")),
            ],
        ),
        (
            "an external id bound to the conversation's owner",
            named("2open", json!("ownerxid")),
            vec![
                ("id_decision", json!("refuse")),
                ("id_refusal", json!("xid_account")),
                ("id_xid", json!("bound")),
            ],
        ),
        (
            "an external id in a conversation that requires one",
            named("4xidreq", json!("fresh")),
            vec![
                ("id_decision", json!("create_user_and_participant")),
                ("id_xid_required", t.clone()),
            ],
        ),
    ] {
        let line = stage.observe(&body, None);
        expect(
            what,
            &line,
            &[
                ("outcome", json!("would_hand_back")),
                ("reason", json!("shape_keys")),
                ("admitted", json!(0)),
                ("id_entry", json!("xid")),
                ("id_token_scope", null.clone()),
            ],
        );
        expect(what, &line, &expected);
    }
    // Tokens the vote writer's verifier refuses.
    let bound = xid_token(keys, 4, 8123457, "2open", "known");
    for (what, body, token, expected) in [
        (
            "a token bound to an external id",
            agree("2open"),
            bound.clone(),
            vec![
                ("reason", json!("token_refused")),
                ("id_entry", json!("xid_token")),
                ("id_token_scope", json!("this")),
                ("id_decision", json!("found")),
                ("id_xid", json!("bound")),
                ("id_node", json!("found")),
                ("id_node_xid", json!("bound_here")),
                ("id_compare", json!("agree")),
            ],
        ),
        (
            "that token, with its external id in the body",
            named("2open", json!("known")),
            bound.clone(),
            vec![
                ("reason", json!("shape_keys")),
                ("id_entry", json!("xid_token")),
                ("id_token_scope", json!("this")),
                ("id_decision", json!("found")),
            ],
        ),
        (
            "that token in another conversation of the owner",
            agree("7other"),
            bound.clone(),
            vec![
                ("reason", json!("token_refused")),
                ("id_entry", json!("xid_token")),
                ("id_token_scope", json!("other")),
                ("id_decision", json!("create_participant")),
                ("id_xid", json!("bound")),
            ],
        ),
        (
            "a token bound to an external id, signed for the conversation's owner",
            agree("2open"),
            xid_token(keys, 1, 0, "2open", "ownerxid"),
            vec![
                ("reason", json!("token_refused")),
                ("id_entry", json!("xid_token")),
                ("id_token_scope", json!("this")),
                ("id_decision", json!("refuse")),
                ("id_refusal", json!("xid_account")),
                ("id_node", json!("none")),
            ],
        ),
        (
            "an anonymous token for another conversation",
            agree("2open"),
            anonymous(keys, 2, 0, "6treevite"),
            vec![
                ("reason", json!("token_refused")),
                ("id_entry", json!("anonymous_token")),
                ("id_token_scope", json!("other")),
                ("id_decision", json!("create_user_and_participant")),
                ("id_member", f.clone()),
            ],
        ),
        (
            "an account's participant token for another conversation",
            agree("2open"),
            standard_user(keys, 5, 0, "7other"),
            vec![
                ("reason", json!("token_refused")),
                ("id_entry", json!("standard_user_token")),
                ("id_token_scope", json!("other")),
                ("id_decision", json!("create_participant")),
                ("id_node", json!("none")),
            ],
        ),
        (
            "that account, a first vote into a closed conversation",
            agree("3closed"),
            standard_user(keys, 5, 0, "7other"),
            vec![
                ("id_decision", json!("refuse")),
                ("id_refusal", json!("closed")),
                ("id_node", json!("none")),
                ("id_compare", json!("unknown")),
            ],
        ),
    ] {
        let line = stage.observe(&body, Some(&token));
        expect(what, &line, &[("outcome", json!("would_hand_back"))]);
        expect(what, &line, &expected);
    }
    // A verified token for this very conversation that the membership read
    // refuses: the two fields that say why, and admission's own answer.
    for (what, cid, token, expected) in [
        (
            "a Treevite member whose row matches the token",
            "6treevite",
            anonymous(keys, 2, 0, "6treevite"),
            vec![
                ("id_member_treevite", t.clone()),
                ("id_member_row", json!("matches")),
                ("id_decision", json!("found")),
                ("id_treevite", t.clone()),
                ("id_node", json!("found")),
                ("id_node_vote", json!("absent")),
                ("id_compare", json!("agree")),
            ],
        ),
        (
            "a Treevite member whose row carries another number",
            "6treevite",
            anonymous(keys, 3, 9, "6treevite"),
            vec![
                ("id_member_treevite", t.clone()),
                ("id_member_row", json!("differs")),
                ("id_decision", json!("found")),
            ],
        ),
        (
            "a Treevite token with no row",
            "6treevite",
            anonymous(keys, 6, 4, "6treevite"),
            vec![
                ("id_member_treevite", t.clone()),
                ("id_member_row", json!("absent")),
                ("id_decision", json!("refuse")),
                ("id_refusal", json!("treevite")),
            ],
        ),
        (
            "a token with no row",
            "2open",
            anonymous(keys, 6, 3, "2open"),
            vec![
                ("id_member_treevite", f.clone()),
                ("id_member_row", json!("absent")),
                ("id_decision", json!("create_participant")),
                ("id_node", json!("none")),
                ("id_compare", json!("unknown")),
            ],
        ),
        (
            "a token whose row carries another number",
            "2open",
            anonymous(keys, 2, 5, "2open"),
            vec![
                ("id_member_treevite", f.clone()),
                ("id_member_row", json!("differs")),
                ("id_decision", json!("found")),
            ],
        ),
    ] {
        let line = stage.observe(&agree(cid), Some(&token));
        expect(
            what,
            &line,
            &[
                ("outcome", json!("would_hand_back")),
                ("reason", json!("not_a_participant")),
                ("admitted", json!(0)),
                ("zid", null.clone()),
                ("node_vote", json!("not_checked")),
                ("id_entry", json!("anonymous_token")),
                ("id_token_scope", json!("this")),
            ],
        );
        expect(what, &line, &expected);
    }
    // Fields that do not parse: said so, and still decided.
    let mut malformed = agree("2open");
    malformed["tid"] = json!("not a number");
    let line = stage.observe(&malformed, None);
    expect(
        "a first vote whose fields do not parse",
        &line,
        &[
            ("id_decision", json!("create_user_and_participant")),
            ("id_fields", f.clone()),
            ("id_node", json!("not_checked")),
        ],
    );
    // A member's own vote is no identity copy: the vote observer's line, with
    // each identity key null.
    let member = anonymous(keys, 2, 8123456, "2open");
    let line = stage.observe(&agree("2open"), Some(&member));
    expect(
        "a member's vote",
        &line,
        &[
            ("outcome", json!("would_serve")),
            ("status", json!(200)),
            ("admitted", json!(1)),
            ("zid", json!(1)),
            ("node_vote", json!("absent")),
        ],
    );
    assert!(LINE_KEYS.iter().all(|key| line[*key].is_null()), "{line}");
    assert_eq!(state(&mut c), before, "an observed copy changed a row");
    let health = stage.health();
    let identity = &health["postVotesIdentity"];
    assert_eq!(identity["xidLookup"], "enabled");
    assert_eq!(identity["decided"], 26);
    assert_eq!(identity["wouldCreate"], 10);
    assert_eq!(identity["wouldFind"], 6);
    assert_eq!(identity["wouldRefuse"], 10);
    assert_eq!(identity["unavailable"], 0);
    assert_eq!(identity["waiting"], 0);
    assert_eq!(identity["compareDiffers"], 0);
    assert_eq!(health["status"], "ok");
}

/// The decision names what admission then does, on this database's shape:
/// each request is decided by reads and then admitted on a writable
/// connection, and the two agree. This is also the staged admission's own
/// writes, run on the shape of this pass.
#[test]
fn a_decision_names_what_admission_then_does_on_this_shape() {
    use polis_auth::admission::{Bounds, Error, Outcome, Participation, snapshot};
    let db = Database::new("admits");
    let mut c = db.connect();
    let refused = |status, code| Outcome::Refused(polis_auth::Refusal { status, code });
    let cases: Vec<(&str, i32, Joining<'_>, Outcome)> = vec![
        (
            "a first vote",
            1,
            Joining::Anonymous,
            Outcome::CreateUserAndParticipant,
        ),
        (
            "an account's first vote here",
            1,
            Joining::Account(Uid(5)),
            Outcome::CreateParticipant,
        ),
        (
            "that account again",
            1,
            Joining::Account(Uid(5)),
            Outcome::Found,
        ),
        (
            "a member",
            1,
            Joining::AnonymousParticipant {
                uid: Uid(2),
                conversation: Zid(1),
            },
            Outcome::Found,
        ),
        (
            "a new external id",
            1,
            Joining::Xid {
                xid: "fresh",
                uid: None,
            },
            Outcome::CreateUserAndParticipant,
        ),
        (
            "that external id again",
            1,
            Joining::Xid {
                xid: "fresh",
                uid: None,
            },
            Outcome::Found,
        ),
        (
            "that external id in another conversation of the owner",
            6,
            Joining::Xid {
                xid: "fresh",
                uid: None,
            },
            Outcome::CreateParticipant,
        ),
        (
            "an external id on the allow-list",
            4,
            Joining::Xid {
                xid: "listed",
                uid: None,
            },
            Outcome::CreateUserAndParticipant,
        ),
        (
            "an external id not on the allow-list",
            4,
            Joining::Xid {
                xid: "unlisted",
                uid: None,
            },
            refused(403, "polis_err_xid_not_allowed"),
        ),
        (
            "an external id bound to the owner",
            1,
            Joining::Xid {
                xid: "ownerxid",
                uid: None,
            },
            refused(403, "polis_err_xid_owner_account"),
        ),
        (
            "a closed conversation",
            2,
            Joining::Anonymous,
            refused(403, "polis_err_conversation_is_closed"),
        ),
        (
            "an external id is required",
            3,
            Joining::Anonymous,
            refused(403, "polis_err_xid_required"),
        ),
        (
            "Treevite",
            5,
            Joining::Anonymous,
            refused(401, "polis_err_treevite_auth_required"),
        ),
        (
            "Treevite, its owner",
            5,
            Joining::Account(Uid(1)),
            Outcome::CreateParticipant,
        ),
        (
            "Treevite, a member",
            5,
            Joining::AnonymousParticipant {
                uid: Uid(3),
                conversation: Zid(5),
            },
            Outcome::Found,
        ),
    ];
    for (what, zid, identity, expected) in &cases {
        let before = state(&mut c);
        let mut reads = snapshot(&mut c, &Bounds::OBSERVE).unwrap();
        let decision = reads
            .decide(&Participation {
                zid: Zid(*zid),
                identity,
                create_if_missing: true,
                admin_uids: &[],
            })
            .unwrap();
        reads.end();
        assert_eq!(decision.outcome, *expected, "{what}");
        assert_eq!(state(&mut c), before, "{what}: the decision changed a row");
        let admitted = admit(
            &mut c,
            &JoinRequest {
                zid: Zid(*zid),
                identity: match identity {
                    Joining::Anonymous => Joining::Anonymous,
                    Joining::AnonymousParticipant { uid, conversation } => {
                        Joining::AnonymousParticipant {
                            uid: *uid,
                            conversation: *conversation,
                        }
                    }
                    Joining::Account(uid) => Joining::Account(*uid),
                    Joining::Xid { xid, uid } => Joining::Xid { xid, uid: *uid },
                },
                entry: Join::Participation {
                    create_if_missing: true,
                },
                admin_uids: &[],
                x_name: None,
                x_email: None,
                x_profile_image_url: None,
            },
        );
        let did = match &admitted {
            Ok(Some(admitted)) if admitted.new_user => Outcome::CreateUserAndParticipant,
            Ok(Some(admitted)) if admitted.new_participant => Outcome::CreateParticipant,
            Ok(Some(_)) => Outcome::Found,
            Ok(None) => Outcome::Nobody,
            Err(Error::Refused(refusal)) => Outcome::Refused(*refusal),
            Err(other) => panic!("{what}: admission answered {other:?}"),
        };
        assert_eq!(did, *expected, "{what}: admission");
        if let Ok(Some(admitted)) = &admitted {
            if !admitted.new_user {
                assert_eq!(decision.uid(), Some(admitted.uid), "{what}");
            }
            if !admitted.new_participant {
                assert_eq!(decision.pid(), Some(admitted.pid), "{what}");
            }
        }
    }
    // What admission wrote is what the fixture numbers promise.
    let created: i64 = c
        .query_one("select count(*) from users where uid > 7654320", &[])
        .unwrap()
        .get(0);
    assert_eq!(created, 3);
}

/// An identity observer of the stage's database whose connection a test may
/// hold: a look may wait for it as long as the test holds it. Its waits, its
/// statement bound and everything it reads are the observer's own.
struct Looks {
    identity: IdentityObserver,
    verifier: participant::Verifier,
}

impl Looks {
    fn new(stage: &Stage) -> Self {
        let mut identity = IdentityObserver::new(db::Pool::new(
            plain(&stage.db.config),
            db::Limits {
                acquire_timeout: Duration::from_secs(60),
                ..limits()
            },
        ));
        identity.timing = test_timing();
        Self {
            identity,
            verifier: participant::Verifier::new(&stage.keys.public, "fixture", "fixture").unwrap(),
        }
    }

    /// The decision for one copy, as the shadow listener would ask for it.
    fn decide(
        &self,
        stage: &Stage,
        body: &Value,
        token: Option<&str>,
        reason: &'static str,
    ) -> Pending {
        let req = copy(body, token, &request_id());
        stage
            .rt
            .block_on(
                self.identity
                    .decide(&self.verifier, &[], &req, Some(reason)),
            )
            .expect("an identity copy")
    }

    fn hold(
        &self,
    ) -> (
        std::sync::mpsc::Sender<()>,
        tokio::sync::oneshot::Receiver<()>,
    ) {
        hold(&self.identity.pool)
    }

    /// Waits until `count` requests in all have had to wait for the
    /// connection.
    async fn waiting(&self, count: usize) {
        tokio::time::timeout(Duration::from_secs(60), async {
            while self.identity.pool.evidence.snapshot()[1] < count {
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        })
        .await
        .expect("a request waits for the identity connection");
    }

    /// One read-back with nothing changed while it runs.
    fn read_back(&self, stage: &Stage, pending: Pending, anchor: Option<i64>) -> Observed {
        stage.rt.block_on(
            self.identity
                .read_back(pending, anchor, tokio::time::Instant::now()),
        )
    }

    /// One read-back, with `change` committed after its first look has ended
    /// and before its second begins: placed there by order, never by time.
    ///
    /// The pool has one connection and a first-come queue for it, so the
    /// connection is the baton. The test holds it; the first look asks for it
    /// and waits; a second holder asks behind that look; the test lets go.
    /// The first look runs, and when it has ended the connection passes to
    /// the second holder, which asked before the second look could (a
    /// read-back asks for its second look only after its first has ended).
    /// The change is made while the second holder has the connection.
    fn read_back_changing(
        &self,
        stage: &Stage,
        pending: Pending,
        anchor: i64,
        change: impl FnOnce(&mut Client) + Send + 'static,
    ) -> Observed {
        let config = stage.db.config.clone();
        stage.rt.block_on(async {
            let (first, first_held) = self.hold();
            first_held.await.unwrap();
            let waited = self.identity.pool.evidence.snapshot()[1];
            let (observed, ()) = tokio::join!(
                self.identity
                    .read_back(pending, Some(anchor), tokio::time::Instant::now()),
                async {
                    self.waiting(waited + 1).await;
                    let (second, second_held) = self.hold();
                    self.waiting(waited + 2).await;
                    drop(first);
                    second_held.await.unwrap();
                    tokio::task::spawn_blocking(move || {
                        let mut client = config.connect(NoTls).unwrap();
                        change(&mut client);
                    })
                    .await
                    .unwrap();
                    drop(second);
                }
            );
            observed
        })
    }
}

/// Asks for a connection of `pool` and holds it, once granted, until the
/// returned sender is dropped. The receiver answers when it is held.
fn hold(
    pool: &Arc<db::Pool>,
) -> (
    std::sync::mpsc::Sender<()>,
    tokio::sync::oneshot::Receiver<()>,
) {
    let (granted, when_granted) = tokio::sync::oneshot::channel();
    let (release, held) = std::sync::mpsc::channel::<()>();
    let pool = pool.clone();
    tokio::spawn(async move {
        let _ = pool
            .with(move |_| {
                let _ = granted.send(());
                let _ = held.recv_timeout(Duration::from_secs(60));
                Ok(())
            })
            .await;
    });
    (release, when_granted)
}

/// Waits for `condition`, which the database and the pools make true: never
/// a fixed time.
async fn until(what: &str, condition: impl Fn() -> bool) {
    tokio::time::timeout(Duration::from_secs(60), async {
        while !condition() {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("{what}"));
}

fn anchor(c: &mut Client) -> i64 {
    c.query_one("select now_as_millis()", &[]).unwrap().get(0)
}

fn classes(
    observed: &Observed,
) -> (
    Node,
    Option<NodeXid>,
    Option<NodeVote>,
    Option<Timing>,
    Compare,
) {
    (
        observed.node,
        observed.node_xid,
        observed.node_vote,
        observed.timing,
        observed.compare,
    )
}

/// The read-back: what Node left, found by the request's own identity where
/// it has one and otherwise among the conversation's newest participants;
/// every class of it, and every one that is unknown.
#[test]
fn the_read_back_classifies_what_node_left() {
    let stage = stage("readback");
    let looks = Looks::new(&stage);
    let keys = &stage.keys;
    let mut c = stage.db.connect();
    let agree = |cid: &str| vote_body(cid, TID, VoteChoice::Agree);
    let first = Some(test_timing().first.as_secs_f64());
    let retry = Some(test_timing().retry.as_secs_f64());

    // A first vote with no identity, and Node does nothing: no row at either
    // look. Unknown, never agreement.
    let at = anchor(&mut c);
    let pending = looks.decide(&stage, &agree("7other"), None, "no_token");
    let observed = looks.read_back(&stage, pending, Some(at));
    assert_eq!(observed.decided, Decided::CreateUserAndParticipant);
    assert_eq!(
        classes(&observed),
        (Node::None, None, None, None, Compare::Unknown)
    );
    assert_eq!(observed.readback_s, retry);

    // Node creates the person and stores the vote between the two looks: the
    // decision was taken before Node's row was there.
    let pending = looks.decide(&stage, &agree("7other"), None, "no_token");
    let observed = looks.read_back_changing(&stage, pending, at, |c| {
        arrives_and_votes(c, 6, TID, VoteChoice::Agree);
    });
    assert_eq!(
        classes(&observed),
        (
            Node::Created,
            None,
            Some(NodeVote::Same),
            Some(Timing::BeforeNode),
            Compare::AgreeByNumber
        )
    );
    assert_eq!(observed.readback_s, retry);

    // The same arrival, decided after Node's row was there: found at the
    // first look, and the timing says the decision saw it.
    let pending = looks.decide(&stage, &agree("7other"), None, "no_token");
    let observed = looks.read_back(&stage, pending, Some(at));
    assert_eq!(
        classes(&observed),
        (
            Node::Created,
            None,
            Some(NodeVote::Same),
            Some(Timing::AfterNode),
            Compare::AgreeByNumber
        )
    );
    assert_eq!(observed.readback_s, first);

    // A second new person votes on the same statement inside the window: two
    // rows could be this request's. Ambiguous, never a guess.
    arrives_and_votes(&mut c, 6, TID, VoteChoice::Disagree);
    let pending = looks.decide(&stage, &agree("7other"), None, "no_token");
    let observed = looks.read_back(&stage, pending, Some(at));
    assert_eq!(
        classes(&observed),
        (Node::Ambiguous, None, None, None, Compare::Unknown)
    );

    // A new person whose vote on the statement is another choice.
    let at = anchor(&mut c);
    let pending = looks.decide(&stage, &agree("5allow"), None, "no_token");
    assert_eq!(pending.observed.refusal, Some(Refused::XidRequired));
    c.batch_execute("UPDATE conversations SET use_xid_whitelist = false WHERE zid = 4")
        .unwrap();
    arrives_and_votes(&mut c, 4, TID, VoteChoice::Pass);
    let observed = looks.read_back(&stage, pending, Some(at));
    // Rust would refuse and somebody new voted there: not tied to this
    // request, so unknown and never a disagreement.
    assert_eq!(
        classes(&observed),
        (
            Node::Created,
            None,
            Some(NodeVote::Different),
            Some(Timing::BeforeNode),
            Compare::Unknown
        )
    );

    // More new participants than a look reads: older new rows may lie beyond
    // it, so nothing is concluded.
    let pending = looks.decide(&stage, &agree("5allow"), None, "no_token");
    for _ in 0..NEWEST {
        joins(&mut c, 4, Joining::Anonymous);
    }
    let observed = looks.read_back(&stage, pending, Some(at));
    assert_eq!(
        classes(&observed),
        (Node::Ambiguous, None, None, None, Compare::Unknown)
    );

    // No anchor: a new row could not be told from an older one.
    let pending = looks.decide(&stage, &agree("2open"), None, "no_token");
    let observed = looks.read_back(&stage, pending, None);
    assert_eq!(
        classes(&observed),
        (Node::NoAnchor, None, None, None, Compare::Unknown)
    );
    assert_eq!(observed.readback_s, None);

    // A new external id: Node creates the user, the participant and the
    // binding and stores the vote between the looks.
    let at = anchor(&mut c);
    let pending = looks.decide(&stage, &named("2open", json!("fresh")), None, "shape_keys");
    assert_eq!(pending.observed.xid, Some(XidSeen::Unbound));
    let observed = looks.read_back_changing(&stage, pending, at, |c| {
        let joined = joins(
            c,
            1,
            Joining::Xid {
                xid: "fresh",
                uid: None,
            },
        );
        stores(
            c,
            1,
            joined.pid.0 as i32,
            joined.uid.0,
            TID,
            VoteChoice::Agree,
        );
    });
    assert_eq!(
        classes(&observed),
        (
            Node::Created,
            Some(NodeXid::BoundHere),
            Some(NodeVote::Same),
            Some(Timing::BeforeNode),
            Compare::Agree
        )
    );
    // Decided again, after Node: admission would find the member Node just
    // made. Right for its instant, and silent about the one before.
    let pending = looks.decide(&stage, &named("2open", json!("fresh")), None, "shape_keys");
    assert_eq!(pending.observed.decided, Decided::Found);
    let observed = looks.read_back(&stage, pending, Some(at));
    assert_eq!(
        classes(&observed),
        (
            Node::Created,
            Some(NodeXid::BoundHere),
            Some(NodeVote::Same),
            Some(Timing::AfterNode),
            Compare::Unknown
        )
    );

    // A binding Node stored with no participant number, and one that names
    // another conversation of the owner.
    c.batch_execute("UPDATE xids SET pid = NULL, zid = NULL WHERE xid = 'fresh'")
        .unwrap();
    let pending = looks.decide(&stage, &named("2open", json!("fresh")), None, "shape_keys");
    let observed = looks.read_back(&stage, pending, Some(at));
    assert_eq!(observed.node_xid, Some(NodeXid::BoundNoNumber));
    let pending = looks.decide(&stage, &named("7other", json!("known")), None, "shape_keys");
    let observed = looks.read_back_changing(&stage, pending, at, |c| {
        joins(
            c,
            6,
            Joining::Xid {
                xid: "known",
                uid: None,
            },
        );
    });
    assert_eq!(
        classes(&observed),
        (
            Node::Created,
            Some(NodeXid::BoundElsewhere),
            Some(NodeVote::Absent),
            Some(Timing::BeforeNode),
            Compare::Agree
        )
    );

    // A Treevite member's vote: Node stores it under the token's number, and
    // the member's row is from long before.
    let at = anchor(&mut c);
    let member = anonymous(keys, 2, 0, "6treevite");
    let pending = looks.decide(
        &stage,
        &agree("6treevite"),
        Some(&member),
        "not_a_participant",
    );
    assert_eq!(pending.observed.member_row, Some(Row::Matches));
    let observed = looks.read_back_changing(&stage, pending, at, |c| {
        stores(c, 5, 0, 2, TID, VoteChoice::Agree);
    });
    assert_eq!(
        classes(&observed),
        (
            Node::Found,
            None,
            Some(NodeVote::Same),
            None,
            Compare::Agree
        )
    );
    assert_eq!(observed.readback_s, retry);

    // A token with no row: Node stores the vote under the token's number all
    // the same, and no participant is behind it.
    let rowless = anonymous(keys, 6, 3, "2open");
    let pending = looks.decide(&stage, &agree("2open"), Some(&rowless), "not_a_participant");
    assert_eq!(pending.observed.member_row, Some(Row::Absent));
    stores(&mut c, 1, 3, 6, TID, VoteChoice::Agree);
    let observed = looks.read_back(&stage, pending, Some(at));
    assert_eq!(
        classes(&observed),
        (
            Node::None,
            None,
            Some(NodeVote::Same),
            None,
            Compare::Unknown
        )
    );

    // An account's first vote into a closed conversation: Rust refuses before
    // creating anyone; Node creates the participant and then refuses. Found
    // by the account's own user: the known, expected difference.
    let at = anchor(&mut c);
    let account = standard_user(keys, 5, 0, "7other");
    let pending = looks.decide(&stage, &agree("3closed"), Some(&account), "token_refused");
    assert_eq!(pending.observed.refusal, Some(Refused::Closed));
    let observed = looks.read_back_changing(&stage, pending, at, |c| {
        c.batch_execute("INSERT INTO participants(zid, uid) VALUES (2, 5)")
            .unwrap();
    });
    assert_eq!(
        classes(&observed),
        (
            Node::Created,
            None,
            Some(NodeVote::Absent),
            Some(Timing::BeforeNode),
            Compare::ExpectedDifference
        )
    );

    // A read that fails: unavailable, and unknown.
    let pending = looks.decide(&stage, &agree("2open"), None, "no_token");
    let mut locker = stage.db.connect();
    let mut held = locker.transaction().unwrap();
    held.batch_execute("LOCK TABLE participants IN ACCESS EXCLUSIVE MODE")
        .unwrap();
    let observed = looks.read_back(&stage, pending, Some(at));
    held.rollback().unwrap();
    assert_eq!(
        classes(&observed),
        (Node::Unavailable, None, None, None, Compare::Unknown)
    );
    assert_eq!(observed.readback_s, first);
    // Nothing is left waiting, and the identity connection is free again.
    assert_eq!(looks.identity.waiting(), 0);
    assert!(stage.rt.block_on(looks.identity.ping()));
}

/// A first vote with no token is found only by inference: a new participant
/// with a vote on the same statement, who may be somebody else. Node may have
/// created nobody for this request at all: it failed and the person sent it
/// again, or it was refused and one other new person voted on that statement.
/// Such a match is never the plain agreement: it has a word and a counter of
/// its own, it is unknown when the matched vote is not the copy's, and an
/// unknown adds to no agreement counter in /health.
#[test]
fn an_agreement_found_only_by_number_has_its_own_word_and_counter() {
    let stage = stage("bynumber");
    let looks = Looks::new(&stage);
    let keys = &stage.keys;
    let mut c = stage.db.connect();
    let agree = |cid: &str| vote_body(cid, TID, VoteChoice::Agree);
    let health = |looks: &Looks| -> Value {
        serde_json::from_str(&js::stringify(&looks.identity.health(true))).unwrap()
    };
    // A failed attempt followed by its retry. Node creates nobody for the
    // first attempt; the retry arrives inside the window and Node creates one
    // person, with the same vote. The first attempt's copy finds that person.
    let at = anchor(&mut c);
    let failed = looks.decide(&stage, &agree("7other"), None, "no_token");
    let observed = looks.read_back_changing(&stage, failed, at, |c| {
        arrives_and_votes(c, 6, TID, VoteChoice::Agree);
    });
    assert_eq!(observed.node, Node::Created);
    assert_eq!(observed.node_vote, Some(NodeVote::Same));
    assert_eq!(observed.compare.as_str(), "agree_by_number");
    // A request Node did not create anyone for, beside one other new person
    // whose vote on the statement is another choice: nothing is concluded.
    c.batch_execute("UPDATE conversations SET use_xid_whitelist = false WHERE zid = 4")
        .unwrap();
    let at = anchor(&mut c);
    let beside = looks.decide(&stage, &agree("5allow"), None, "no_token");
    assert_eq!(beside.observed.decided, Decided::CreateUserAndParticipant);
    let observed = looks.read_back_changing(&stage, beside, at, |c| {
        arrives_and_votes(c, 4, TID, VoteChoice::Disagree);
    });
    assert_eq!(observed.node, Node::Created);
    assert_eq!(observed.node_vote, Some(NodeVote::Different));
    assert_eq!(observed.compare.as_str(), "unknown");
    // Nothing found at all: unknown.
    let nothing = looks.decide(&stage, &agree("2open"), None, "no_token");
    let observed = looks.read_back(&stage, nothing, Some(at));
    assert_eq!(observed.compare.as_str(), "unknown");
    // An agreement found by the request's own identity is the plain one.
    let tied = looks.decide(&stage, &named("2open", json!("known")), None, "shape_keys");
    let observed = looks.read_back(&stage, tied, Some(at));
    assert_eq!(observed.compare.as_str(), "agree");
    // The known, expected difference, found by an account's own user.
    let account = standard_user(keys, 5, 0, "7other");
    let closed = looks.decide(&stage, &agree("3closed"), Some(&account), "token_refused");
    let observed = looks.read_back_changing(&stage, closed, at, |c| {
        c.batch_execute("INSERT INTO participants(zid, uid) VALUES (2, 5)")
            .unwrap();
    });
    assert_eq!(observed.compare.as_str(), "expected_difference");
    // /health: each comparison is counted once under its own word, and the
    // two unknowns are counted under none.
    let health = health(&looks);
    assert_eq!(health["decided"], 5);
    assert_eq!(health["compareAgree"], 1);
    assert_eq!(health["compareAgreeByNumber"], 1);
    assert_eq!(health["compareExpectedDifference"], 1);
    assert_eq!(health["compareDiffers"], 0);
}

#[path = "post_votes_identity_proof_tests.rs"]
mod proofs;
