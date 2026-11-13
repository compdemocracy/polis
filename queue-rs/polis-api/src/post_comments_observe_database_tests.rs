//! The comment observer on PostgreSQL: the decision it reaches for every
//! kind of request, the read-back of what Node stored, the statements it
//! sends, and the proof that none of it writes.
//!
//! "Node" in these tests is the live comment handler on the same database:
//! it stores a comment and its author's vote as Node stores them, and its
//! vote write is the sign-aware path.
use super::*;
use crate::post_comments::tests::database::{self as live, Database};
use postgres::{Client, NoTls, error::SqlState};
use std::collections::BTreeSet;

/// The fixed time the test databases' `now_as_millis()` answers.
const NOW: i64 = 1_700_000_000_000;
/// The participant number the jQuery participation client puts in every
/// request body: "not known".
const NO_PID: i32 = -1;

fn plain(config: &postgres::Config) -> Connector {
    Connector::Plain(Box::new(config.clone()))
}

struct Stage {
    rt: tokio::runtime::Runtime,
    keys: Signing,
    /// The shadow: the comment observer on this database.
    app: Arc<App>,
    /// The live comment handler on the same database, standing in for Node.
    node: live::Fixture,
    votes: Arc<shadow::Lane>,
    db: Database,
}

fn stage(label: &str) -> Stage {
    let db = Database::new(label);
    let keys = signing();
    let observer = observer_with(
        plain(&db.config),
        plain(&db.config),
        &keys.public,
        vec![],
        1000,
    );
    stage_of(db, keys, observer)
}

fn stage_of(db: Database, keys: Signing, observer: Observer) -> Stage {
    let node = live::fixture_of(
        &db,
        live::writer_on(&db.config, &keys.public, vec![], writer_limits()),
        keys.private.clone(),
    );
    Stage {
        rt: live::runtime(),
        app: shadow_app(Some(observer)),
        node,
        votes: shadow::Lane::new(1000),
        keys,
        db,
    }
}

impl Stage {
    fn observer(&self) -> &Observer {
        self.app.post_comments_observe.as_ref().unwrap()
    }

    /// One copy through the shadow listener, and its line.
    fn observe(&self, claims: Option<&Value>, body: &str) -> Value {
        self.observe_on(&self.app, claims, body)
    }

    fn observe_on(&self, app: &Arc<App>, claims: Option<&Value>, body: &str) -> Value {
        let authorization = claims.map(|claims| bearer(&self.keys, claims));
        let id = request_id();
        let req = copy(body, authorization.as_deref(), &id);
        self.rt.block_on(async {
            assert_eq!(accepted(app, &self.votes, req).await, 204);
            observation(&id).await
        })
    }

    /// Node answers a comment: the live handler stores it, and its author's
    /// vote when the body carries one.
    fn node_stores(&self, claims: &Value, body: &str) -> i32 {
        let out = live::send(&self.rt, &self.node, claims, body);
        assert_eq!(out.status, 200, "{}", live::body_of(&out));
        let reply: Value = serde_json::from_str(&live::body_of(&out)).unwrap();
        reply["tid"].as_i64().unwrap() as i32
    }

    fn health(&self) -> Value {
        self.rt
            .block_on(async { body_of(shadow::health(&self.app, &self.votes).await) })
    }
}

fn member() -> Value {
    claims(3, 2, CID)
}

fn agree() -> Value {
    json!({"vote": crate::votes::WIRE_AGREE, "pid": NO_PID, "agid": 1})
}

/// The author votes again on their own comment, through the handler's own
/// vote write.
fn votes_again(c: &mut Client, tid: i32, choice: VoteChoice) {
    votes_as(c, 2, 3, tid, choice);
}

/// A participant of conversation 1 votes on a comment, through the
/// handler's own vote write.
fn votes_as(c: &mut Client, pid: i32, uid: i32, tid: i32, choice: VoteChoice) {
    let admitted = Admitted {
        zid: 1,
        pid,
        uid,
        active: true,
        strict: false,
        existing: None,
    };
    let Live::Write(writable) =
        decide(&admitted, CommentText::new("unused".into()), Some(choice)).live()
    else {
        panic!("an open conversation's comment is writable");
    };
    author_vote(c, &writable, tid, choice).unwrap();
}

/// Conversations of every kind admission tells apart, each with the
/// participant (uid 3) as a member, pid 0.
const CONVERSATIONS: &str = "
    INSERT INTO conversations(zid, owner, is_active) VALUES (3, 1, false);
    INSERT INTO conversations(zid, owner, is_active, strict_moderation) VALUES (4, 1, true, true);
    INSERT INTO conversations(zid, owner, is_active, treevite_enabled) VALUES (5, 1, true, true);
    INSERT INTO conversations(zid, owner, is_active, xid_required) VALUES (6, 1, true, true);
    INSERT INTO conversations(zid, owner, is_active, use_xid_whitelist) VALUES (7, 1, true, true);
    INSERT INTO zinvites(zid, zinvite) VALUES (3, '3closed'), (4, '4strict'), (5, '5treevite'),
        (6, '6xidrequired'), (7, '7xidlist');
    ALTER TABLE participants DISABLE TRIGGER USER;
    INSERT INTO participants(zid, uid, pid) VALUES (3, 3, 0), (4, 3, 0), (5, 3, 0), (6, 3, 0), (7, 3, 0);
    ALTER TABLE participants ENABLE TRIGGER USER;
    INSERT INTO comments(zid, pid, uid, txt) VALUES (1, 1, 2, 'Generated by another participant');
    INSERT INTO comments(zid, pid, uid, txt, created) VALUES (3, 0, 3, 'Generated closed existing', 1),
        (4, 0, 3, 'Generated strict existing', 1);";

/// Every kind of request, with no comment stored by Node: the decision the
/// live handler would reach, named on the line, and not one row changed in
/// any table a comment can touch.
#[test]
fn observe_reaches_the_live_decision_for_every_request_and_changes_no_row() {
    let stage = stage("observe_decisions");
    let mut c = stage.db.connect();
    c.batch_execute(CONVERSATIONS).unwrap();
    let before = live::snapshot(&mut c);
    let new = "Generated observed comment";
    // (conversation, uid, pid, text, extra keys), then what the line says:
    // outcome, status, reason, admitted, strict, text_row, node_comment.
    type Expected = (
        &'static str,
        u16,
        Option<&'static str>,
        u8,
        Option<bool>,
        Option<&'static str>,
        &'static str,
    );
    type Sent = (&'static str, i32, i32, &'static str, Value);
    let cases: Vec<(Sent, Expected)> = vec![
        (
            (CID, 3, 2, new, json!({})),
            (
                "would_serve",
                200,
                None,
                1,
                Some(false),
                Some("none"),
                "absent",
            ),
        ),
        (
            (CID, 3, 2, new, agree()),
            (
                "would_serve",
                200,
                None,
                1,
                Some(false),
                Some("none"),
                "absent",
            ),
        ),
        (
            (CID, 3, 2, "Generated by another participant", agree()),
            (
                "would_answer",
                409,
                Some("duplicate"),
                1,
                Some(false),
                Some("other"),
                "other",
            ),
        ),
        (
            ("3closed", 3, 0, new, agree()),
            (
                "would_answer",
                403,
                Some("closed"),
                1,
                Some(false),
                Some("none"),
                "absent",
            ),
        ),
        // Node's order: the duplicate is answered before the closed check.
        (
            ("3closed", 3, 0, "Generated closed existing", agree()),
            (
                "would_answer",
                409,
                Some("duplicate"),
                1,
                Some(false),
                Some("other"),
                "other",
            ),
        ),
        // Strict moderation: Node stores the same row and emails the
        // moderators. Live hands it back; observe compares it as a write.
        (
            ("4strict", 3, 0, new, agree()),
            (
                "would_serve",
                200,
                None,
                1,
                Some(true),
                Some("none"),
                "absent",
            ),
        ),
        (
            ("4strict", 3, 0, "Generated strict existing", agree()),
            (
                "would_answer",
                409,
                Some("duplicate"),
                1,
                Some(true),
                Some("other"),
                "other",
            ),
        ),
        (
            (CID, 100004, 3, new, agree()),
            (
                "would_hand_back",
                502,
                Some("moderator"),
                0,
                None,
                None,
                "not_checked",
            ),
        ),
        (
            (CID, 1, 0, new, json!({})),
            (
                "would_hand_back",
                502,
                Some("moderator"),
                0,
                None,
                None,
                "not_checked",
            ),
        ),
        (
            (CID, 100005, 0, new, agree()),
            (
                "would_hand_back",
                502,
                Some("not_a_participant"),
                0,
                None,
                None,
                "not_checked",
            ),
        ),
        (
            ("5treevite", 3, 0, new, agree()),
            (
                "would_hand_back",
                502,
                Some("treevite"),
                0,
                None,
                None,
                "not_checked",
            ),
        ),
        (
            ("6xidrequired", 3, 0, new, agree()),
            (
                "would_hand_back",
                502,
                Some("xid_required"),
                0,
                None,
                None,
                "not_checked",
            ),
        ),
        (
            ("7xidlist", 3, 0, new, agree()),
            (
                "would_hand_back",
                502,
                Some("xid_allowlist"),
                0,
                None,
                None,
                "not_checked",
            ),
        ),
        (
            ("9unknown", 3, 0, new, agree()),
            (
                "would_hand_back",
                502,
                Some("unknown_conversation"),
                0,
                None,
                None,
                "not_checked",
            ),
        ),
        (
            (CID, 3, 2, new, json!({"is_seed": true})),
            (
                "would_hand_back",
                502,
                Some("is_seed"),
                0,
                None,
                None,
                "not_checked",
            ),
        ),
    ];
    let mut served = 0;
    for ((cid, uid, pid, text, extra), expected) in cases {
        let carried_vote = extra.get("vote").is_some();
        let line = stage.observe(Some(&claims(uid, pid, cid)), &body(cid, text, extra));
        let (outcome, status, reason, admitted, strict, text_row, node_comment) = expected;
        assert_eq!(line["outcome"], outcome, "{line}");
        assert_eq!(line["status"], status, "{line}");
        assert_eq!(line["reason"], json!(reason), "{line}");
        assert_eq!(line["admitted"], admitted, "{line}");
        // The conversation's number: on an admitted copy's line, whatever
        // the handler would do with it, and on no other. A copy handed back
        // before it is admitted names no conversation, known or not.
        if admitted == 1 {
            let zid = match cid {
                CID => 1,
                "3closed" => 3,
                "4strict" => 4,
                other => panic!("no conversation number is expected for {other}"),
            };
            assert_eq!(line["zid"], zid, "{line}");
        } else {
            assert!(line["zid"].is_null(), "{line}");
        }
        assert_eq!(line["strict"], json!(strict), "{line}");
        // What Node does after the insert, on the copies Node stores.
        let after = match (outcome, strict) {
            ("would_serve", Some(true)) => json!("moderator_email"),
            ("would_serve", _) => json!("notification_task"),
            _ => Value::Null,
        };
        assert_eq!(line["after_insert"], after, "{line}");
        assert_eq!(line["text_row"], json!(text_row), "{line}");
        assert_eq!(line["node_comment"], node_comment, "{line}");
        assert_eq!(line["vote_present"], carried_vote, "{line}");
        // Nothing of Node's is there to compare with.
        assert!(line["node_txt"].is_null(), "{line}");
        assert_eq!(line["node_vote"], "not_checked", "{line}");
        assert!(line["queue_ms"].is_number() && line["total_ms"].is_number());
        assert_eq!(line["admission_ms"].is_number(), reason != Some("is_seed"));
        if node_comment == "absent" {
            // Looked for at the first wait and once more at the second.
            assert_eq!(line["readback_s"], 0.15, "{line}");
        }
        if node_comment == "other" {
            assert_eq!(line["readback_s"], 0.05, "{line}");
        }
        served += usize::from(outcome == "would_serve");
    }
    assert_eq!(served, 3);
    let no_token = stage.observe(None, &body(CID, new, agree()));
    assert_eq!(no_token["reason"], "no_token");
    // A listed admin is handed back before admission.
    let admin = shadow_app(Some(observer_with(
        plain(&stage.db.config),
        plain(&stage.db.config),
        &stage.keys.public,
        vec![3],
        1000,
    )));
    let line = stage.observe_on(&admin, Some(&member()), &body(CID, new, agree()));
    assert_eq!(line["outcome"], "would_hand_back");
    assert_eq!(line["reason"], "admin");
    assert!(line["admission_ms"].is_null());
    assert_eq!(live::snapshot(&mut c), before, "observe changed a row");
    let health = stage.health();
    assert_eq!(health["status"], "ok");
    let comments = &health["postComments"];
    assert_eq!(comments["observed"], 16);
    assert_eq!(comments["wouldServe"], 3);
    assert_eq!(comments["wouldAnswer"], 4);
    assert_eq!(comments["wouldHandBack"], 9);
    assert_eq!(comments["wouldFail"], 0);
    assert_eq!(comments["unknown"], 0);
    assert_eq!(comments["readbackAbsent"], 4);
    assert_eq!(comments["readbackOther"], 3);
    assert_eq!(comments["readbackOwn"], 0);
    drop(admin);
}

/// Node stores the comment before the copy's admission reads: the row is
/// this participant's and inside the window, so it is Node's row for this
/// very request and not a duplicate. The read-back then compares it, and its
/// author's vote, with what live would have stored.
#[test]
fn a_text_node_has_already_stored_is_its_own_row_and_is_read_back() {
    let stage = stage("observe_own");
    let mut c = stage.db.connect();
    let text = "Generated stored by Node";
    let stored = stage.node_stores(&member(), &body(CID, text, agree()));
    let before = live::snapshot(&mut c);
    let line = stage.observe(Some(&member()), &body(CID, text, agree()));
    assert_eq!(line["outcome"], "would_serve", "{line}");
    assert_eq!(line["status"], 200);
    assert!(line["reason"].is_null());
    assert_eq!(line["text_row"], "own");
    assert_eq!(line["node_comment"], "own");
    assert_eq!(line["node_txt"], "same");
    assert!(line["node_txt_difference"].is_null());
    assert_eq!(line["node_author"], "same");
    assert_eq!(line["node_row"], "as_expected");
    assert_eq!(line["node_lang"], "unset");
    assert_eq!(line["node_vote"], "same");
    assert_eq!(line["readback_s"], 0.05);
    // The same row against a copy that carried another choice, and one that
    // carried none.
    let disagree = json!({"vote": VoteChoice::Disagree.wire()});
    let line = stage.observe(Some(&member()), &body(CID, text, disagree));
    assert_eq!(line["text_row"], "own");
    assert_eq!(line["node_vote"], "different", "{line}");
    let line = stage.observe(Some(&member()), &body(CID, text, json!({})));
    assert_eq!(line["node_comment"], "own");
    assert_eq!(line["node_vote"], "not_sent", "{line}");
    // The author changed their vote inside the wait: some rows match.
    votes_again(&mut c, stored, VoteChoice::Pass);
    let line = stage.observe(Some(&member()), &body(CID, text, agree()));
    assert_eq!(line["node_vote"], "ambiguous", "{line}");
    // A comment Node stored without a vote, against a copy that carried one:
    // looked for twice, then absent.
    let bare = "Generated stored without a vote";
    stage.node_stores(&member(), &body(CID, bare, json!({})));
    let line = stage.observe(Some(&member()), &body(CID, bare, agree()));
    assert_eq!(line["node_comment"], "own");
    assert_eq!(line["node_vote"], "absent", "{line}");
    assert_eq!(line["readback_s"], 0.15);
    // What Node stored that live would not have: named by its first column.
    c.batch_execute(&format!(
        "UPDATE comments SET mod = 1, is_seed = true, lang = 'en', lang_confidence = 0.9, uid = 2
         WHERE zid = 1 AND tid = {stored}"
    ))
    .unwrap();
    let line = stage.observe(Some(&member()), &body(CID, text, json!({})));
    assert_eq!(line["node_comment"], "own");
    assert_eq!(line["node_row"], "mod", "{line}");
    assert_eq!(line["node_lang"], "set");
    assert_eq!(line["node_author"], "different");
    assert_eq!(line["node_txt"], "same");
    // The same participant's row from before the window is somebody's
    // earlier comment: a duplicate, as it is for Node.
    c.batch_execute(&format!(
        "UPDATE comments SET created = {} WHERE zid = 1 AND tid = {stored}",
        NOW - OWN_WINDOW_MS - 1
    ))
    .unwrap();
    let after_fixture = live::snapshot(&mut c);
    let line = stage.observe(Some(&member()), &body(CID, text, agree()));
    assert_eq!(line["outcome"], "would_answer", "{line}");
    assert_eq!(line["status"], 409);
    assert_eq!(line["reason"], "duplicate");
    assert_eq!(line["text_row"], "other");
    assert_eq!(line["node_comment"], "other");
    assert!(line["node_txt"].is_null() && line["node_row"].is_null());
    assert_eq!(line["node_vote"], "not_checked");
    assert_eq!(
        live::snapshot(&mut c),
        after_fixture,
        "observe changed a row"
    );
    assert_ne!(
        before, after_fixture,
        "the fixture's own changes are visible"
    );
    let health = stage.health();
    let comments = &health["postComments"];
    assert_eq!(comments["readbackOwn"], 6);
    assert_eq!(comments["readbackOther"], 1);
    assert_eq!(comments["voteSame"], 1);
    assert_eq!(comments["voteDifferent"], 1);
    assert_eq!(comments["voteAmbiguous"], 1);
    assert_eq!(comments["voteAbsent"], 1);
    assert_eq!(comments["textDifferent"], 0);
}

/// A comment in a conversation with strict moderation is observed as the
/// write Node makes, and what Node stored is compared with the row the
/// handler models, as in any conversation. The line says the conversation is
/// strict and that the moderators' email follows the insert. The live
/// handler, on the same database, still hands that comment back and writes
/// nothing.
#[test]
fn a_strict_conversations_comment_is_observed_and_compared_and_live_still_hands_it_back() {
    let stage = stage("observe_strict");
    let mut c = stage.db.connect();
    // Node's row and its author's vote, stored the way Node stores them. A
    // strict conversation's comment gets the row any other gets, so the live
    // handler writes it while the conversation is not yet strict.
    let text = "Generated strict comment stored by Node";
    stage.node_stores(&member(), &body(CID, text, agree()));
    c.batch_execute("UPDATE conversations SET strict_moderation = true WHERE zid = 1")
        .unwrap();
    let before = live::snapshot(&mut c);
    let line = stage.observe(Some(&member()), &body(CID, text, agree()));
    assert_eq!(line["outcome"], "would_serve", "{line}");
    assert_eq!(line["status"], 200, "{line}");
    assert!(line["reason"].is_null(), "{line}");
    assert_eq!(line["admitted"], 1);
    assert_eq!(line["zid"], 1);
    assert_eq!(line["strict"], true);
    assert_eq!(line["after_insert"], "moderator_email");
    assert_eq!(line["text_row"], "own");
    assert_eq!(line["node_comment"], "own");
    assert_eq!(line["node_txt"], "same");
    assert_eq!(line["node_author"], "same");
    assert_eq!(line["node_row"], "as_expected");
    assert_eq!(line["node_lang"], "unset");
    assert_eq!(line["node_vote"], "same", "{line}");
    assert_eq!(line["readback_s"], 0.05);
    // A stored vote that is not the copy's choice is seen here as anywhere.
    let disagree = json!({"vote": VoteChoice::Disagree.wire()});
    let line = stage.observe(Some(&member()), &body(CID, text, disagree));
    assert_eq!(line["outcome"], "would_serve", "{line}");
    assert_eq!(line["node_comment"], "own");
    assert_eq!(line["node_vote"], "different", "{line}");
    // A comment Node has not stored: looked for twice, then absent.
    let line = stage.observe(
        Some(&member()),
        &body(CID, "Generated strict comment not stored", agree()),
    );
    assert_eq!(line["outcome"], "would_serve", "{line}");
    assert_eq!(line["after_insert"], "moderator_email");
    assert_eq!(line["text_row"], "none");
    assert_eq!(line["node_comment"], "absent");
    assert_eq!(line["readback_s"], 0.15);
    // Another participant's text in a strict conversation: a duplicate, as
    // for Node, and nothing follows an insert that does not happen.
    let line = stage.observe(Some(&claims(2, 1, CID)), &body(CID, text, agree()));
    assert_eq!(line["outcome"], "would_answer", "{line}");
    assert_eq!(line["status"], 409);
    assert_eq!(line["reason"], "duplicate");
    assert_eq!(line["strict"], true);
    assert!(line["after_insert"].is_null(), "{line}");
    assert_eq!(live::snapshot(&mut c), before, "observe changed a row");
    // The live handler on the same database: the same kind of comment is
    // handed back to Node, with nothing written.
    let out = live::send(
        &stage.rt,
        &stage.node,
        &member(),
        &body(
            CID,
            "Generated strict comment for the live handler",
            agree(),
        ),
    );
    assert_eq!(out.status, 502, "{}", live::body_of(&out));
    assert_eq!(
        live::snapshot(&mut c),
        before,
        "live wrote a strict comment"
    );
    let health = stage.health();
    let comments = &health["postComments"];
    assert_eq!(comments["wouldServe"], 3);
    assert_eq!(comments["wouldAnswer"], 1);
    assert_eq!(comments["wouldHandBack"], 0);
    assert_eq!(comments["readbackOwn"], 2);
    assert_eq!(comments["readbackAbsent"], 1);
    assert_eq!(comments["readbackOther"], 1);
    assert_eq!(comments["voteSame"], 1);
    assert_eq!(comments["voteDifferent"], 1);
}

/// A moderator who approves or rejects the comment between Node's insert and
/// the read-back changes `mod` (and may change `active`) with Node's
/// moderation statement, which stamps `modified`. The read-back says
/// `moderated`: not the row the insert stored otherwise, so never a
/// disagreement of the handler's. In a strict conversation, where the
/// moderators are emailed about every comment, and in any other. A column
/// the moderation statement does not write still names itself, and so does
/// a change that leaves `modified` as the insert set it.
#[test]
fn a_comment_moderated_before_the_read_back_is_moderated_not_a_difference() {
    let stage = stage("observe_moderated");
    let mut c = stage.db.connect();
    // Node's moderation statement (`PUT /api/v3/comments`), with `modified`
    // kept later than the insert's even when both fall in one millisecond.
    let moderate = |c: &mut Client, tid: i32, active: bool, moderation: i32| {
        c.execute(
            "UPDATE comments SET active = $1, mod = $2, is_meta = false,
             modified = greatest(now_as_millis(), created + 1)
             WHERE zid = 1 AND tid = $3",
            &[&active, &moderation, &tid],
        )
        .unwrap();
    };
    let ordinary = "Generated comment rejected before the read-back";
    let tid = stage.node_stores(&member(), &body(CID, ordinary, agree()));
    moderate(&mut c, tid, true, -1);
    let line = stage.observe(Some(&member()), &body(CID, ordinary, agree()));
    assert_eq!(line["outcome"], "would_serve", "{line}");
    assert_eq!(line["strict"], false, "{line}");
    assert_eq!(line["node_comment"], "own", "{line}");
    assert_eq!(line["node_row"], "moderated", "{line}");
    assert_eq!(line["node_vote"], "same", "{line}");
    let approved = "Generated strict comment approved before the read-back";
    let rejected = "Generated strict comment rejected before the read-back";
    let approved_tid = stage.node_stores(&member(), &body(CID, approved, agree()));
    let rejected_tid = stage.node_stores(&member(), &body(CID, rejected, agree()));
    c.batch_execute("UPDATE conversations SET strict_moderation = true WHERE zid = 1")
        .unwrap();
    moderate(&mut c, approved_tid, true, 1);
    moderate(&mut c, rejected_tid, false, -1);
    for text in [approved, rejected] {
        let line = stage.observe(Some(&member()), &body(CID, text, agree()));
        assert_eq!(line["outcome"], "would_serve", "{line}");
        assert_eq!(line["after_insert"], "moderator_email", "{line}");
        assert_eq!(line["node_comment"], "own", "{line}");
        assert_eq!(line["node_row"], "moderated", "{line}");
    }
    // Moderated, and stored as a seed: the insert's own difference is named.
    c.execute(
        "UPDATE comments SET is_seed = true WHERE zid = 1 AND tid = $1",
        &[&approved_tid],
    )
    .unwrap();
    let line = stage.observe(Some(&member()), &body(CID, approved, agree()));
    assert_eq!(line["node_row"], "mod", "{line}");
    // `mod` changed with `modified` left as the insert set it: not a
    // moderation Node makes, so the column is named as before.
    let unstamped = "Generated comment changed without a stamp";
    c.batch_execute("UPDATE conversations SET strict_moderation = false WHERE zid = 1")
        .unwrap();
    let tid = stage.node_stores(&member(), &body(CID, unstamped, agree()));
    c.execute(
        "UPDATE comments SET mod = 1 WHERE zid = 1 AND tid = $1",
        &[&tid],
    )
    .unwrap();
    let line = stage.observe(Some(&member()), &body(CID, unstamped, agree()));
    assert_eq!(line["node_row"], "mod", "{line}");
}

fn subject(text: &str, vote: Option<VoteChoice>) -> Subject {
    Subject {
        zid: 1,
        pid: 2,
        uid: 3,
        text: CommentText::new(text.into()),
        vote,
    }
}

/// A read-back in which the test changes the database between the two looks,
/// placed there by order and never by time.
///
/// The read-back pool has one connection and a first-come queue for it, so
/// the connection is the baton. The test holds it; the first look asks for it
/// and waits; a second holder asks for it behind that look; the test lets go.
/// The first look runs, and when it has ended the connection passes to the
/// second holder, which was asked for before the second look can ask (a
/// read-back asks for its second look only after its first has ended). The
/// change is made while the second holder has the connection, and the second
/// look runs only after the change is committed and the holder lets go.
///
/// The observer here differs from the stage's in one bound: a look may wait
/// for the connection as long as the test holds it. The read-back's two
/// waits, its statement bound and everything it reads are the stage's.
struct BetweenLooks {
    observer: Observer,
}

impl BetweenLooks {
    fn new(stage: &Stage) -> Self {
        let mut observer = Observer::new(
            participant::Verifier::new(&stage.keys.public, "fixture", "fixture").unwrap(),
            db::Pool::new(plain(&stage.db.config), read_limits()),
            db::Pool::new(
                plain(&stage.db.config),
                db::Limits {
                    acquire_timeout: Duration::from_secs(60),
                    ..readback_limits()
                },
            ),
            vec![],
            1000,
        );
        observer.timing = stage.observer().timing;
        Self { observer }
    }

    /// Asks for the read-back connection and holds it, once granted, until
    /// the returned sender is dropped. The receiver answers when it is held.
    fn hold(
        &self,
    ) -> (
        std::sync::mpsc::Sender<()>,
        tokio::sync::oneshot::Receiver<()>,
    ) {
        let (granted, when_granted) = tokio::sync::oneshot::channel();
        let (release, held) = std::sync::mpsc::channel::<()>();
        let pool = self.observer.readback.clone();
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

    /// Waits until `count` requests in all have had to wait for the
    /// read-back connection.
    async fn waiting(&self, count: usize) {
        tokio::time::timeout(Duration::from_secs(60), async {
            while self.observer.readback.evidence.snapshot()[1] < count {
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        })
        .await
        .expect("a request waits for the read-back connection");
    }

    /// One read-back of `text`, with `change` (one SQL script) committed
    /// after its first look has ended and before its second begins.
    fn read(
        &self,
        stage: &Stage,
        text: &str,
        vote: Option<VoteChoice>,
        change: &'static str,
    ) -> (Stored, Option<f64>) {
        let subject = subject(text, vote);
        let mut client = stage.db.config.connect(NoTls).unwrap();
        let observer = &self.observer;
        stage.rt.block_on(async {
            let anchor = observer.anchor().await.unwrap();
            assert_eq!(anchor, NOW);
            let (first, first_held) = self.hold();
            first_held.await.unwrap();
            let waited = observer.readback.evidence.snapshot()[1];
            let (read, ()) = tokio::join!(
                observer.read_back(&subject, anchor, tokio::time::Instant::now()),
                async {
                    // The first look waits for the connection, and the second
                    // holder waits behind it.
                    self.waiting(waited + 1).await;
                    let (second, second_held) = self.hold();
                    self.waiting(waited + 2).await;
                    drop(first);
                    // The first look has ended: the connection is the second
                    // holder's, and the second look cannot run.
                    second_held.await.unwrap();
                    tokio::task::spawn_blocking(move || client.batch_execute(change).unwrap())
                        .await
                        .unwrap();
                    drop(second);
                }
            );
            read
        })
    }
}

/// The read-back itself: a row that is not there at either wait, a row that
/// arrives between them, each class of the stored row and of the author's
/// vote, a row that is another participant's, and a read that fails.
#[test]
fn the_read_back_classifies_what_node_stored() {
    let stage = stage("observe_readback");
    let mut c = stage.db.connect();
    let observer = stage.observer();
    let read = |text: &str, vote: Option<VoteChoice>| {
        let subject = subject(text, vote);
        stage.rt.block_on(async {
            let anchor = observer.anchor().await.unwrap();
            assert_eq!(anchor, NOW);
            observer
                .read_back(&subject, anchor, tokio::time::Instant::now())
                .await
        })
    };
    // Nothing stored: both waits, then absent.
    let (stored, delay) = read("Generated never stored", Some(VoteChoice::Agree));
    assert_eq!(stored.comment.as_str(), "absent");
    assert_eq!(stored.vote.as_str(), "not_checked");
    assert!(stored.text.is_none() && stored.author.is_none() && stored.row.is_none());
    assert_eq!(delay, Some(0.15));
    // A row that appears only after the first look is found by the second.
    // The row is stored between the two looks by order, not by time.
    let between_looks = BetweenLooks::new(&stage);
    let (stored, delay) = between_looks.read(
        &stage,
        "Generated late comment",
        None,
        "INSERT INTO comments(zid, pid, uid, txt) VALUES (1, 2, 3, 'Generated late comment')",
    );
    assert_eq!(stored.comment.as_str(), "own");
    assert_eq!(stored.text, Some(Compared::Same));
    assert_eq!(stored.author, Some(true));
    assert_eq!(stored.row, Some("as_expected"));
    assert_eq!(stored.lang, Some(false));
    assert_eq!(stored.vote.as_str(), "not_sent");
    assert_eq!(delay, Some(0.15));
    // Each column live would have stored otherwise, one at a time.
    for (change, restore, column) in [
        ("mod = 1", "mod = 0", "mod"),
        ("mod = -1", "mod = 0", "mod"),
        ("active = false", "active = true", "active"),
        ("is_seed = true", "is_seed = false", "is_seed"),
        ("velocity = 0", "velocity = 1", "velocity"),
        ("anon = true", "anon = false", "anon"),
    ] {
        c.batch_execute(&format!(
            "UPDATE comments SET {change} WHERE txt = 'Generated late comment'"
        ))
        .unwrap();
        let (stored, delay) = read("Generated late comment", None);
        assert_eq!(stored.row, Some(column), "{change}");
        assert_eq!(delay, Some(0.05));
        c.batch_execute(&format!(
            "UPDATE comments SET {restore} WHERE txt = 'Generated late comment'"
        ))
        .unwrap();
    }
    c.batch_execute("UPDATE comments SET lang = 'fr' WHERE txt = 'Generated late comment'")
        .unwrap();
    assert_eq!(read("Generated late comment", None).0.lang, Some(true));
    // The author's vote, each class, stored through the handler's vote write.
    let tid: i32 = c
        .query_one(
            "select tid from comments where txt = 'Generated late comment'",
            &[],
        )
        .unwrap()
        .get(0);
    votes_again(&mut c, tid, VoteChoice::Disagree);
    for (sent, class) in [
        (Some(VoteChoice::Disagree), "same"),
        (Some(VoteChoice::Agree), "different"),
        (Some(VoteChoice::Pass), "different"),
        (None, "not_sent"),
    ] {
        let (stored, _) = read("Generated late comment", sent);
        assert_eq!(stored.vote.as_str(), class, "{sent:?}");
    }
    votes_again(&mut c, tid, VoteChoice::Agree);
    for sent in [VoteChoice::Disagree, VoteChoice::Agree] {
        let (stored, _) = read("Generated late comment", Some(sent));
        assert_eq!(stored.vote.as_str(), "ambiguous");
    }
    // Another participant's vote on the comment is not its author's.
    votes_as(&mut c, 1, 2, 0, VoteChoice::Agree);
    let (stored, delay) = read("Generated existing 0", Some(VoteChoice::Agree));
    assert_eq!(stored.comment.as_str(), "own");
    assert_eq!(stored.vote.as_str(), "absent");
    assert_eq!(delay, Some(0.15), "an absent vote is looked for twice");
    // A row that is another participant's, or older than the window.
    c.batch_execute(
        "INSERT INTO comments(zid, pid, uid, txt) VALUES (1, 1, 2, 'Generated by another');
         UPDATE comments SET created = 1 WHERE txt = 'Generated existing 1';",
    )
    .unwrap();
    for text in ["Generated by another", "Generated existing 1"] {
        let (stored, delay) = read(text, Some(VoteChoice::Agree));
        assert_eq!(stored.comment.as_str(), "other", "{text}");
        assert!(stored.text.is_none() && stored.row.is_none() && stored.lang.is_none());
        assert_eq!(stored.vote.as_str(), "not_checked");
        assert_eq!(delay, Some(0.05));
    }
    // A second look the database refuses keeps what the first look found and
    // says the vote could not be read: never that Node stored none.
    // The column the read-back names is renamed between the two looks.
    let (stored, delay) = between_looks.read(
        &stage,
        "Generated existing 0",
        Some(VoteChoice::Agree),
        "ALTER TABLE comments RENAME COLUMN anon TO renamed",
    );
    assert_eq!(stored.comment.as_str(), "own");
    assert_eq!(stored.text, Some(Compared::Same));
    assert_eq!(stored.vote.as_str(), "unavailable");
    assert_eq!(delay, Some(0.15));
    // A read the database refuses at the first look.
    let (stored, delay) = read("Generated late comment", Some(VoteChoice::Agree));
    assert_eq!(stored.comment.as_str(), "unavailable");
    assert_eq!(stored.vote.as_str(), "not_checked");
    assert_eq!(delay, Some(0.05));
}

/// A stored text that is not the parsed text can be found only where the
/// column's own equality is not byte equality. On such a column the row is
/// found, compared in process, and the line says different, with the kind of
/// difference and the four lengths and nothing of either text.
#[test]
fn a_stored_text_that_differs_is_named_by_class_and_lengths_only() {
    let stage = stage("observe_different");
    let mut c = stage.db.connect();
    c.batch_execute(
        "CREATE COLLATION ignoring_case (provider = icu, locale = 'und-u-ks-level2', deterministic = false);
         ALTER TABLE comments ALTER COLUMN txt TYPE varchar(1000) COLLATE ignoring_case;
         INSERT INTO comments(zid, pid, uid, txt) VALUES (1, 2, 3, 'Généré With Capitals');",
    )
    .unwrap();
    let before = live::snapshot(&mut c);
    let line = stage.observe(
        Some(&member()),
        &body(CID, "généré with capitals", json!({})),
    );
    assert_eq!(line["outcome"], "would_serve", "{line}");
    assert_eq!(line["text_row"], "own");
    assert_eq!(line["node_comment"], "own");
    assert_eq!(line["node_txt"], "different", "{line}");
    assert_eq!(line["node_txt_difference"], "case");
    assert_eq!(line["txt_units"], 20);
    assert_eq!(line["node_txt_units"], 20);
    assert_eq!(line["txt_bytes"], 23);
    assert_eq!(line["node_txt_bytes"], 23);
    assert_eq!(line["node_row"], "as_expected");
    assert_eq!(stage.health()["postComments"]["textDifferent"], 1);
    assert_eq!(live::snapshot(&mut c), before);
}

/// Without the database-time anchor the observer cannot tell Node's row for
/// this request from the same participant's earlier comment. It says so:
/// the copy is unknown, with no would-be status, and is never guessed
/// either way. A copy whose decision does not depend on the anchor is
/// decided as usual; nothing is read back for any of them.
#[test]
fn without_an_anchor_a_text_match_is_unknown_and_never_guessed() {
    let db = Database::new("observe_no_anchor");
    let keys = signing();
    // Admission answers; the read-back pool, which reads the anchor, does not.
    let observer = observer_with(plain(&db.config), closed(), &keys.public, vec![], 1000);
    let stage = stage_of(db, keys, observer);
    let mut c = stage.db.connect();
    c.batch_execute(
        "INSERT INTO comments(zid, pid, uid, txt) VALUES (1, 1, 2, 'Generated by another participant')",
    )
    .unwrap();
    let before = live::snapshot(&mut c);
    assert!(stage.rt.block_on(stage.observer().anchor()).is_none());
    // This participant's own earlier text: own or other cannot be told.
    let line = stage.observe(Some(&member()), &body(CID, "Generated existing 0", agree()));
    assert_eq!(line["outcome"], "unknown", "{line}");
    assert!(line["status"].is_null());
    assert_eq!(line["reason"], "no_anchor");
    assert_eq!(line["admitted"], 1);
    assert_eq!(line["text_row"], "unknown");
    assert_eq!(line["node_comment"], "unknown");
    assert_eq!(line["node_vote"], "not_checked");
    assert!(line["readback_s"].is_null());
    // No row with this text: the decision needs no anchor.
    let line = stage.observe(Some(&member()), &body(CID, "Generated new", agree()));
    assert_eq!(line["outcome"], "would_serve", "{line}");
    assert_eq!(line["status"], 200);
    assert_eq!(line["text_row"], "none");
    assert_eq!(line["node_comment"], "unknown");
    assert!(line["readback_s"].is_null());
    // Another participant's row is a duplicate whatever the time.
    let line = stage.observe(
        Some(&member()),
        &body(CID, "Generated by another participant", agree()),
    );
    assert_eq!(line["outcome"], "would_answer", "{line}");
    assert_eq!(line["status"], 409);
    assert_eq!(line["text_row"], "other");
    assert_eq!(line["node_comment"], "unknown");
    assert_eq!(live::snapshot(&mut c), before);
    let health = stage.health();
    assert_eq!(health["status"], "degraded");
    assert_eq!(health["postComments"]["unknown"], 1);
    assert_eq!(
        health["postComments"]["pools"]["readback"]["reachable"],
        false
    );
}

/// Both of the observer's pools are read-only sessions: PostgreSQL refuses
/// each of the live handler's four writes on each of them, and the observer
/// holds no other pool.
#[test]
fn every_observer_pool_refuses_each_of_the_handlers_writes() {
    let stage = stage("observe_refuse");
    let mut c = stage.db.connect();
    let before = live::snapshot(&mut c);
    let observer = stage.observer();
    let pools = observer.startup_pools();
    assert_eq!(pools.map(|(name, _)| name), ["reads", "readback"]);
    assert!(!Arc::ptr_eq(pools[0].1, pools[1].1));
    for (name, pool) in pools {
        let health: Value =
            serde_json::from_str(&crate::js::stringify(&pool.health(true))).unwrap();
        assert_eq!(health["readOnly"], true, "{name}");
        let refused = stage
            .rt
            .block_on(pool.with(|c| {
                let admitted = Admitted {
                    zid: 1,
                    pid: 2,
                    uid: 3,
                    active: true,
                    strict: false,
                    existing: None,
                };
                let Live::Write(writable) = decide(
                    &admitted,
                    CommentText::new("Generated refused write".into()),
                    Some(VoteChoice::Agree),
                )
                .live() else {
                    anyhow::bail!("an open conversation's comment is writable");
                };
                let code = |error: &postgres::Error| error.code().cloned();
                let comment = insert(c, &writable).err().as_ref().and_then(code);
                let vote = insert_author_vote(
                    c,
                    &writable,
                    0,
                    i16::try_from(StorageConvention::CURRENT.encode(VoteChoice::Agree))?,
                )
                .err()
                .and_then(|error| error.downcast_ref::<postgres::Error>().and_then(code));
                let task = c
                    .execute(
                        "insert into notification_tasks (zid) values ($1)
                         on conflict (zid) do update set modified = now_as_millis()",
                        &[&1_i32],
                    )
                    .err()
                    .as_ref()
                    .and_then(code);
                let interaction = c
                    .execute(
                        "update participants set last_interaction = now_as_millis(), nsli = 0
                         where zid = $1 and uid = $2",
                        &[&1_i32, &3_i32],
                    )
                    .err()
                    .as_ref()
                    .and_then(code);
                let setting: String = c
                    .query_one(
                        "select current_setting('default_transaction_read_only')",
                        &[],
                    )?
                    .get(0);
                Ok((comment, vote, task, interaction, setting))
            }))
            .unwrap();
        let read_only = Some(SqlState::READ_ONLY_SQL_TRANSACTION);
        assert_eq!(refused.0, read_only, "{name}: the comment's insert");
        assert_eq!(refused.1, read_only, "{name}: the author's vote");
        assert_eq!(refused.2, read_only, "{name}: the notification task");
        assert_eq!(refused.3, read_only, "{name}: the last interaction");
        assert_eq!(refused.4, "on", "{name}");
    }
    assert_eq!(live::snapshot(&mut c), before);
}

/// A loopback relay between the observer's pools and PostgreSQL that keeps
/// the text of every statement the observer sends: the simple-query and
/// parse messages of the wire protocol. No server setting or extension is
/// involved, so what it records is what was sent.
pub(crate) struct Recorder {
    port: u16,
    sent: Arc<Mutex<Vec<String>>>,
}

impl Recorder {
    pub(crate) fn start(backend: &postgres::Config) -> Self {
        use std::net::{TcpListener, TcpStream};
        let host = match &backend.get_hosts()[0] {
            postgres::config::Host::Tcp(host) => host.clone(),
            #[allow(unreachable_patterns)]
            _ => panic!("a TCP test database is required"),
        };
        let backend_port = backend.get_ports()[0];
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let sent = Arc::new(Mutex::new(Vec::new()));
        let log = sent.clone();
        std::thread::spawn(move || {
            for client in listener.incoming() {
                let Ok(client) = client else { break };
                let Ok(server) = TcpStream::connect((host.as_str(), backend_port)) else {
                    continue;
                };
                let log = log.clone();
                std::thread::spawn(move || relay(client, server, log));
            }
        });
        Self { port, sent }
    }

    /// The backend's database, reached through the relay.
    pub(crate) fn config(&self, backend: &postgres::Config) -> postgres::Config {
        let mut config = postgres::Config::new();
        config
            .host("127.0.0.1")
            .port(self.port)
            .user(backend.get_user().unwrap())
            .dbname(backend.get_dbname().unwrap());
        if let Some(password) = backend.get_password() {
            config.password(password);
        }
        config
    }

    /// Every statement sent so far, with runs of whitespace as one space.
    pub(crate) fn statements(&self) -> Vec<String> {
        self.sent
            .lock()
            .unwrap()
            .iter()
            .map(|sql| sql.split_whitespace().collect::<Vec<_>>().join(" "))
            .collect()
    }
}

fn relay(
    mut client: std::net::TcpStream,
    mut server: std::net::TcpStream,
    log: Arc<Mutex<Vec<String>>>,
) {
    use std::io::{Read, Write};
    let _ = client.set_nodelay(true);
    let _ = server.set_nodelay(true);
    let (mut from_server, mut to_client) =
        (server.try_clone().unwrap(), client.try_clone().unwrap());
    std::thread::spawn(move || {
        let _ = std::io::copy(&mut from_server, &mut to_client);
        let _ = to_client.shutdown(std::net::Shutdown::Both);
    });
    let mut forward = || -> std::io::Result<()> {
        // These pools use no TLS: the first message is the startup message.
        let mut length = [0_u8; 4];
        client.read_exact(&mut length)?;
        let mut rest = vec![0_u8; u32::from_be_bytes(length) as usize - 4];
        client.read_exact(&mut rest)?;
        server.write_all(&length)?;
        server.write_all(&rest)?;
        loop {
            let mut head = [0_u8; 5];
            client.read_exact(&mut head)?;
            let length = u32::from_be_bytes([head[1], head[2], head[3], head[4]]) as usize;
            let mut payload = vec![0_u8; length - 4];
            client.read_exact(&mut payload)?;
            if matches!(head[0], b'P' | b'Q') {
                let mut parts = payload.split(|byte| *byte == 0);
                if head[0] == b'P' {
                    // The prepared statement's name comes first.
                    parts.next();
                }
                if let Some(sql) = parts.next() {
                    log.lock()
                        .unwrap()
                        .push(String::from_utf8_lossy(sql).into_owned());
                }
            }
            server.write_all(&head)?;
            server.write_all(&payload)?;
        }
    };
    let _ = forward();
    let _ = server.shutdown(std::net::Shutdown::Both);
}

/// Every statement the comment observer may send, as text. Nothing else may
/// cross the wire from its pools.
const ALLOWED: &[&str] = &[
    // Each connection, once: the read-only session and its statement bound.
    "SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY; SET statement_timeout = 100",
    // The copy's database-time anchor.
    "select now_as_millis()",
    // Admission, as the live handler runs it.
    "select zid from zinvites where zinvite = ($1)",
    "select p.pid from participants p join conversations c on c.zid=p.zid where p.zid=$1 and p.uid=$2 and c.treevite_enabled is not true",
    "select treevite_enabled from conversations where zid = $1",
    "select c.is_active, c.strict_moderation, c.xid_required, c.use_xid_whitelist, (select site_id from users where uid = $2) = (select site_id from users where uid = c.owner), m.tid, m.pid, m.created from conversations c left join comments m on m.zid = c.zid and m.txt = $3 where c.zid = $1",
    // The read-back of what Node stored: the comment by its text, then its
    // author's vote.
    "select tid, pid, uid, txt, created, mod, active, is_seed, velocity, anon, (lang is not null or lang_confidence is not null), (modified is distinct from created) from comments where zid = $1 and txt = $2",
    "select vote from votes where zid=$1 and pid=$2 and tid=$3 and created >= $4::bigint - 5000 order by created",
    // /health, and the one read of the server's logging settings at startup.
    "select 1",
    "select name, setting from pg_settings where name in ('log_min_duration_statement', 'log_min_duration_sample', 'log_statement', 'log_parameter_max_length', 'log_parameter_max_length_on_error', 'log_min_error_statement', 'shared_preload_libraries') order by name",
];

/// Words that would make a statement more than a read. A read-only session
/// refuses a write, but it allows an advisory lock and a notification, so
/// "read-only" is proven here by what was sent.
pub(crate) fn asks_for_more_than_a_read(sql: &str) -> Option<String> {
    let lower = sql.to_lowercase();
    for part in ["advisory", "nextval", "setval", "notify"] {
        if lower.contains(part) {
            return Some(part.to_owned());
        }
    }
    let words: Vec<&str> = lower
        .split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .filter(|word| !word.is_empty())
        .collect();
    for word in [
        "insert",
        "update",
        "delete",
        "merge",
        "truncate",
        "copy",
        "lock",
        "listen",
        "unlisten",
        "create",
        "alter",
        "drop",
        "grant",
        "revoke",
        "call",
        "do",
        "begin",
        "commit",
        "rollback",
        "savepoint",
        "prepare",
        "execute",
        "share",
        "write",
        "into",
        "vacuum",
        "refresh",
        "reindex",
        "cluster",
        "discard",
        "reset",
        "comment",
    ] {
        if words.contains(&word) {
            return Some(word.to_owned());
        }
    }
    None
}

/// Every statement the observer sends, recorded from the wire across every
/// kind of copy, the read-back, /health and the startup read, is one of a
/// fixed list, and each statement of the list was sent. No statement asks
/// for a lock, a sequence value, a notification or a write.
#[test]
fn the_observer_sends_only_the_statements_on_its_list() {
    let db = Database::new("observe_wire");
    let keys = signing();
    let recorder = Recorder::start(&db.config);
    let through = recorder.config(&db.config);
    let observer = observer_with(plain(&through), plain(&through), &keys.public, vec![], 1000);
    let stage = stage_of(db, keys, observer);
    let mut c = stage.db.connect();
    c.batch_execute(CONVERSATIONS).unwrap();
    let new = "Generated wire comment";
    // Node's row with its author's vote, then copies of every outcome.
    let stored = "Generated wire stored by Node";
    stage.node_stores(&member(), &body(CID, stored, agree()));
    let before = live::snapshot(&mut c);
    for (claims, text, cid) in [
        (member(), stored, CID),
        (member(), new, CID),
        (member(), "Generated by another participant", CID),
        (claims(3, 0, "3closed"), new, "3closed"),
        (claims(3, 0, "4strict"), new, "4strict"),
        (claims(3, 0, "5treevite"), new, "5treevite"),
        (claims(3, 0, "6xidrequired"), new, "6xidrequired"),
        (claims(100004, 3, CID), new, CID),
        (claims(100005, 0, CID), new, CID),
        (claims(3, 0, "9unknown"), new, "9unknown"),
    ] {
        let line = stage.observe(Some(&claims), &body(cid, text, agree()));
        assert_ne!(line["outcome"], "would_fail", "{line}");
    }
    stage.observe(None, &body(CID, new, agree()));
    assert_eq!(stage.health()["status"], "ok");
    let settings = stage
        .rt
        .block_on(stage.observer().logging_settings())
        .expect("the server's logging settings are readable");
    let names: Vec<&str> = settings.iter().map(|(name, _)| name.as_str()).collect();
    for name in [
        "log_min_duration_statement",
        "log_min_error_statement",
        "log_parameter_max_length",
        "log_parameter_max_length_on_error",
        "log_statement",
    ] {
        assert!(names.contains(&name), "{name}: {names:?}");
    }
    assert_eq!(live::snapshot(&mut c), before, "observe changed a row");
    let sent: BTreeSet<String> = recorder.statements().into_iter().collect();
    let allowed: BTreeSet<String> = ALLOWED.iter().map(|sql| (*sql).to_owned()).collect();
    println!(
        "the observer sent {} statements, {} distinct:",
        recorder.statements().len(),
        sent.len()
    );
    for sql in &sent {
        println!("  {sql}");
    }
    assert_eq!(sent, allowed, "the statements sent are not the list");
    for sql in &sent {
        if sql.starts_with("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY;") {
            continue;
        }
        assert_eq!(asks_for_more_than_a_read(sql), None, "{sql}");
        assert!(sql.to_lowercase().starts_with("select "), "{sql}");
    }
    // The check itself: it sees what a read-only session would allow.
    for sql in [
        "select pg_advisory_xact_lock(873791984, 1)",
        "NOTIFY comments",
        "select nextval('comments_tid_seq')",
        "select tid from comments where zid = $1 for update",
        "select tid from comments where zid = $1 for share",
        "insert into comments (zid) values ($1)",
        "SET TRANSACTION READ WRITE",
    ] {
        assert!(asks_for_more_than_a_read(sql).is_some(), "{sql}");
    }
}

/// Every statement the observer sends is prepared on this run's database
/// shape with the parameter types the observer binds, and each read of a
/// table is planned on an index: the comment by the unique key on
/// (zid, txt), the author's vote by an index on votes. The plans are printed.
#[test]
fn every_observer_statement_prepares_and_every_read_is_index_bounded() {
    use postgres::types::Type;
    let db = Database::new("observe_plans");
    let mut c = db.connect();
    // Enough rows that a plan is a choice.
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
         ALTER TABLE comments ENABLE TRIGGER USER;",
    )
    .unwrap();
    // The author's votes on three thousand comments, and three hundred other
    // participants' votes on one of them, each through the handler's own
    // vote write.
    {
        let mut tx = c.transaction().unwrap();
        let mut vote = |pid: i32, uid: i32, tid: i32| {
            let admitted = Admitted {
                zid: 1,
                pid,
                uid,
                active: true,
                strict: false,
                existing: None,
            };
            let choice = VoteChoice::Agree;
            let Live::Write(writable) =
                decide(&admitted, CommentText::new("unused".into()), Some(choice)).live()
            else {
                panic!("an open conversation's comment is writable");
            };
            author_vote(&mut tx, &writable, tid, choice).unwrap();
        };
        for n in 1..=3000 {
            vote(2, 3, 1000 + n);
        }
        for n in 1..=300 {
            vote(100 + n, 200000 + n, 1777);
        }
        tx.commit().unwrap();
    }
    c.batch_execute("ANALYZE").unwrap();
    let statements: [(&str, &str, Vec<Type>, Option<&str>); 9] = [
        ("anchor", ANCHOR, vec![], Some("")),
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
            "read-back: the comment",
            READBACK,
            vec![Type::INT4, Type::TEXT],
            Some("1, 'Generated bulk 777'"),
        ),
        (
            "read-back: the author's vote",
            READBACK_VOTE,
            vec![Type::INT4, Type::INT4, Type::INT4, Type::INT8],
            Some("1, 2, 1777, 1700000000000"),
        ),
        ("health", "select 1", vec![], Some("")),
        ("logging settings", LOGGING_SETTINGS, vec![], None),
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
            "observer plan on the {shape} shape: {name}\n  {}",
            plan.join("\n  ")
        );
        let plan = plan.join("\n");
        assert!(!plan.contains("Seq Scan"), "{name}: {plan}");
        assert!(
            !plan.contains("Merge") && !plan.contains("Hash"),
            "{name}: {plan}"
        );
        if name == "read-back: the comment" {
            assert!(
                plan.contains("Index Scan using comments_zid_txt_key on comments")
                    && plan.contains(
                        "Index Cond: ((zid = 1) AND ((txt)::text = 'Generated bulk 777'::text))"
                    ),
                "{plan}"
            );
        }
        if name == "read-back: the author's vote" {
            // The index on (zid, tid), the one on (zid, pid), or both.
            assert!(
                plan.contains("votes_latest_unique_zid_tid_idx")
                    || plan.contains("votes_zid_pid_idx"),
                "{plan}"
            );
        }
    }
    // The columns the read-back names exist on this shape with types it reads.
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
    for column in [
        "tid integer",
        "pid integer",
        "uid integer",
        "txt character varying(1000)",
        "created bigint",
        "mod integer",
        "active boolean",
        "is_seed boolean",
        "velocity real",
        "anon boolean",
    ] {
        assert!(
            columns.contains(&column.to_owned()),
            "{column}: {columns:?}"
        );
    }
}

/// The 204 comes back while the observation is still waiting on the
/// database, and the copy holds a lane slot only until its admission ends.
#[test]
fn the_reply_to_a_copy_precedes_all_database_work() {
    let stage = stage("observe_reply_first");
    let observer = stage.observer();
    let held = stage.rt.block_on(async {
        let mut held = park(&observer.reads, 2).await;
        held.extend(park(&observer.readback, 1).await);
        held
    });
    let id = request_id();
    let authorization = bearer(&stage.keys, &member());
    let req = copy(
        &body(CID, "Generated while the database waits", agree()),
        Some(authorization.as_str()),
        &id,
    );
    stage.rt.block_on(async {
        // Every new observation is held at its start, so anything the pools
        // record before the 204 comes back was asked for by the reply's own
        // path. Nothing is: no connection asked for, waited for or timed out.
        let start = observer.lane.park().await;
        let asked = || {
            [
                observer.reads.evidence.snapshot(),
                observer.readback.evidence.snapshot(),
            ]
        };
        let before = asked();
        assert_eq!(accepted(&stage.app, &stage.votes, req).await, 204);
        assert_eq!(asked(), before, "the reply waited on the database");
        drop(start);
        assert_eq!(observer.lane.in_flight(), 1, "the observation is pending");
        assert!(printed_line(&id).is_none());
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(printed_line(&id).is_none());
    });
    drop(held);
    let line = stage.rt.block_on(observation(&id));
    assert_ne!(line["outcome"], "would_fail", "{line}");
    assert_eq!(observer.lane.in_flight(), 0);
}

async fn park(pool: &Arc<db::Pool>, size: usize) -> Vec<std::sync::mpsc::Sender<()>> {
    let (ready, mut receive) = tokio::sync::mpsc::unbounded_channel();
    let mut releases = vec![];
    for _ in 0..size {
        let pool = pool.clone();
        let ready = ready.clone();
        let (release, held) = std::sync::mpsc::channel::<()>();
        releases.push(release);
        tokio::spawn(async move {
            let _ = pool
                .with(move |_| {
                    ready.send(()).unwrap();
                    let _ = held.recv_timeout(Duration::from_secs(30));
                    Ok(())
                })
                .await;
        });
    }
    for _ in 0..size {
        tokio::time::timeout(Duration::from_secs(30), receive.recv())
            .await
            .unwrap()
            .unwrap();
    }
    releases
}

fn available(pool: &db::Pool) -> Value {
    let health: Value = serde_json::from_str(&crate::js::stringify(&pool.health(true))).unwrap();
    health["available"].clone()
}

/// Observations waiting for their read-back hold no connection and no lane
/// slot, and at most 64 wait at once: a copy beyond that is not read back,
/// and says so at once.
#[test]
fn observations_waiting_for_their_read_back_are_bounded_and_hold_no_connection() {
    let db = Database::new("observe_waiting");
    let keys = signing();
    let mut observer = observer_with(
        plain(&db.config),
        plain(&db.config),
        &keys.public,
        vec![],
        1000,
    );
    observer.timing = crate::post_votes::observe::ReadbackTiming {
        first: Duration::from_secs(20),
        retry: Duration::from_secs(21),
    };
    let stage = stage_of(db, keys, observer);
    let mut c = stage.db.connect();
    let before = live::snapshot(&mut c);
    let observer = stage.observer();
    let authorization = bearer(&stage.keys, &member());
    let waiting = shadow::comments::READBACK_WAITING;
    stage.rt.block_on(async {
        let mut ids = vec![];
        for n in 0..waiting + 6 {
            let id = request_id();
            let req = copy(
                &body(CID, &format!("Generated waiting comment {n}"), agree()),
                Some(authorization.as_str()),
                &id,
            );
            assert_eq!(accepted(&stage.app, &stage.votes, req).await, 204);
            // One at a time, so no admission waits on another.
            tokio::time::timeout(Duration::from_secs(10), async {
                while observer.lane.in_flight() != 0 {
                    tokio::time::sleep(Duration::from_millis(1)).await;
                }
            })
            .await
            .unwrap();
            ids.push(id);
        }
        assert_eq!(observer.lane.readback_waiting(), waiting);
        assert_eq!(available(&observer.reads), 2, "no reads connection is held");
        assert_eq!(
            available(&observer.readback),
            1,
            "no read-back connection is held"
        );
        for (n, id) in ids.iter().enumerate() {
            if n < waiting {
                assert!(
                    printed_line(id).is_none(),
                    "{n} is waiting for its read-back"
                );
            } else {
                let line = observation(id).await;
                assert_eq!(line["outcome"], "would_serve", "{line}");
                assert_eq!(line["node_comment"], "not_checked", "{line}");
                assert!(line["readback_s"].is_null());
            }
        }
    });
    assert_eq!(live::snapshot(&mut c), before);
    // Dropping the stage's runtime cancels the waiting read-backs.
}

/// A process that holds a live comment handler never observes: the copy is
/// answered 204, recorded as not observed, and nothing is written.
#[test]
fn a_copy_never_reaches_a_live_comment_handler() {
    let db = Database::new("observe_never_live");
    let keys = signing();
    let mut app = App::new(
        &app_config(),
        db::Pool::new(plain(&db.config), read_limits()),
    );
    app.post_comments = Some(live::writer_on(
        &db.config,
        &keys.public,
        vec![],
        writer_limits(),
    ));
    app.post_comments_observe = Some(observer_with(
        plain(&db.config),
        plain(&db.config),
        &keys.public,
        vec![],
        1000,
    ));
    let app = Arc::new(app);
    let mut c = db.connect();
    let before = live::snapshot(&mut c);
    let rt = live::runtime();
    let votes = shadow::Lane::new(1000);
    let authorization = bearer(&keys, &member());
    let id = request_id();
    let req = copy(
        &body(CID, "Generated for a live handler", agree()),
        Some(authorization.as_str()),
        &id,
    );
    let line = rt.block_on(async {
        assert_eq!(accepted(&app, &votes, req).await, 204);
        let line = observation(&id).await;
        tokio::time::sleep(Duration::from_millis(200)).await;
        line
    });
    assert_eq!(line["outcome"], "not_observed");
    assert_eq!(line["reason"], "unconfigured");
    assert_eq!(live::snapshot(&mut c), before);
    drop(app);
    drop(rt);
}

/// The process-level check of the text. A child process observes copies
/// whose text, external id and name carry a marker: every outcome, a row of
/// Node's with that text, reads that fail with a server error quoting the
/// text, and (in a second run, with the shadow role's panic hook) a panic
/// whose message is the request's own bytes. Nothing the child prints, its
/// /health included, contains any part of the marker.
#[test]
fn nothing_a_failing_or_panicking_observation_prints_contains_the_text() {
    const CHILD: &str = "POLIS_COMMENT_OBSERVE_OUTPUT_TEST";
    if let Ok(phase) = std::env::var(CHILD) {
        if phase == "panic" {
            shadow::install_panic_hook();
        }
        let db = Database::new("observe_output");
        let keys = signing();
        // A comparison operator that, given the marker, fails quoting both of
        // its operands, as a server error that quotes a parameter does. Only
        // a session whose search path names its schema resolves to it.
        db.connect()
            .batch_execute(
                "CREATE SCHEMA quoting;
                 CREATE FUNCTION quoting.equal(varchar, varchar) RETURNS boolean LANGUAGE plpgsql AS
                 $$ BEGIN
                    IF $2 LIKE 'kq7Xw93%' THEN
                        RAISE EXCEPTION 'comparison quoting % and %', $1, $2
                        USING DETAIL = 'Key (zid, txt)=(' || $2 || ') already exists.';
                    END IF;
                    RETURN $1::text = $2::text;
                 END $$;
                 CREATE OPERATOR quoting.= (LEFTARG = varchar, RIGHTARG = varchar, FUNCTION = quoting.equal);",
            )
            .unwrap();
        let mut failing = db.config.clone();
        failing.options("-c search_path=quoting,public");
        let ordinary = observer_with(
            plain(&db.config),
            plain(&db.config),
            &keys.public,
            vec![],
            1000,
        );
        let failing_admission = shadow_app(Some(observer_with(
            plain(&failing),
            plain(&db.config),
            &keys.public,
            vec![],
            1000,
        )));
        let failing_read_back = shadow_app(Some(observer_with(
            plain(&db.config),
            plain(&failing),
            &keys.public,
            vec![],
            1000,
        )));
        let stage = stage_of(db, keys, ordinary);
        let mut c = stage.db.connect();
        c.batch_execute(CONVERSATIONS).unwrap();
        let marked = body(CID, MARKER, agree());
        let say = |what: &str, line: &Value| {
            println!(
                "observed {what}: {} {} {} {}",
                line["outcome"], line["reason"], line["node_comment"], line["node_vote"]
            );
        };
        if phase == "panic" {
            let id = request_id();
            let authorization = bearer(&stage.keys, &member());
            let req = copy(&marked, Some(authorization.as_str()), &id);
            stage.rt.block_on(async {
                assert_eq!(accepted(&stage.app, &stage.votes, req).await, 204);
                tokio::time::sleep(Duration::from_millis(500)).await;
            });
            println!(
                "after the panic: line={} in_flight={}",
                printed_line(&id).is_some(),
                stage.observer().lane.in_flight()
            );
            return;
        }
        // Every outcome, with the marker as the text.
        say("new", &stage.observe(Some(&member()), &marked));
        stage.node_stores(&member(), &marked);
        say("own", &stage.observe(Some(&member()), &marked));
        say("other", &stage.observe(Some(&claims(2, 1, CID)), &marked));
        for cid in ["3closed", "4strict", "5treevite"] {
            say(
                cid,
                &stage.observe(Some(&claims(3, 0, cid)), &body(cid, MARKER, agree())),
            );
        }
        say(
            "moderator",
            &stage.observe(Some(&claims(1, 0, CID)), &marked),
        );
        say("no token", &stage.observe(None, &marked));
        // The marker in every place a body can carry one.
        for (what, body) in [
            (
                "xid",
                body(
                    CID,
                    MARKER,
                    json!({"xid": MARKER, "x_name": MARKER, "x_email": MARKER}),
                ),
            ),
            ("unknown key", body(CID, MARKER, json!({MARKER: MARKER}))),
            ("over the limit", body(CID, &MARKER.repeat(40), json!({}))),
            (
                "at the limit",
                body(CID, &format!("{MARKER}{}", "é".repeat(997 - 32)), agree()),
            ),
            (
                "a NUL",
                body(CID, &format!("{MARKER}\u{0}{MARKER}"), json!({})),
            ),
            (
                "a lone surrogate",
                format!(
                    "{{\"conversation_id\":\"{CID}\",\"txt\":\"\\ud800 {}\"}}",
                    serde_json::to_string(MARKER).unwrap().trim_matches('"')
                ),
            ),
            (
                "malformed",
                format!("{{\"conversation_id\":\"{CID}\",\"txt\":\"{MARKER}"),
            ),
            (
                "a vote that is text",
                body(CID, MARKER, json!({"vote": MARKER})),
            ),
        ] {
            say(what, &stage.observe(Some(&member()), &body));
        }
        // Reads that fail with the server quoting the text.
        say(
            "failing admission",
            &stage.observe_on(&failing_admission, Some(&member()), &marked),
        );
        say(
            "failing read-back",
            &stage.observe_on(&failing_read_back, Some(&member()), &marked),
        );
        for app in [&stage.app, &failing_admission, &failing_read_back] {
            let health = stage
                .rt
                .block_on(async { body_of(shadow::health(app, &stage.votes).await) });
            println!("health {health}");
        }
        println!(
            "stored comments={}",
            c.query_one("select count(*) from comments where txt = $1", &[&MARKER])
                .unwrap()
                .get::<_, i64>(0)
        );
        return;
    }
    let run = |phase: &str| {
        let mut child = std::process::Command::new(std::env::current_exe().unwrap());
        child
            .args([
                "--exact",
                "post_comments::observe::tests::database::nothing_a_failing_or_panicking_observation_prints_contains_the_text",
                "--nocapture",
            ])
            .env(CHILD, phase);
        if phase == "panic" {
            child.env(PANIC_IN_OBSERVATION, "1");
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
        printed
    };
    let errors = run("errors");
    for observed in [
        "observed new: \"would_serve\" null \"absent\" \"not_checked\"",
        "observed own: \"would_serve\" null \"own\" \"same\"",
        "observed other: \"would_answer\" \"duplicate\" \"other\" \"not_checked\"",
        "observed 3closed: \"would_answer\" \"closed\" \"absent\" \"not_checked\"",
        "observed 4strict: \"would_serve\" null \"absent\" \"not_checked\"",
        "observed 5treevite: \"would_hand_back\" \"treevite\" \"not_checked\" \"not_checked\"",
        "observed moderator: \"would_hand_back\" \"moderator\"",
        "observed no token: \"would_hand_back\" \"no_token\"",
        "observed xid: \"would_hand_back\" \"xid_key\"",
        "observed unknown key: \"would_hand_back\" \"shape_keys\"",
        "observed over the limit: \"would_hand_back\" \"txt_invalid\"",
        "observed at the limit: \"would_serve\" null \"absent\"",
        "observed a NUL: \"would_hand_back\" \"txt_nul\"",
        "observed a lone surrogate: \"would_hand_back\" \"shape_json\"",
        "observed malformed: \"would_hand_back\" \"shape_json\"",
        "observed a vote that is text: \"would_hand_back\" \"vote_invalid\"",
        "observed failing admission: \"would_hand_back\" \"admission_unavailable\"",
        "observed failing read-back: \"would_serve\" null \"unavailable\" \"not_checked\"",
        "stored comments=1",
    ] {
        assert!(errors.contains(observed), "{observed}: {errors}");
    }
    assert_eq!(errors.matches("health {").count(), 3, "{errors}");
    assert!(
        errors.matches("\"shadow_observation\"").count() >= 18,
        "the child's lines were not captured: {errors}"
    );
    assert!(!leaks(&errors), "{errors}");
    let panicked = run("panic");
    assert!(
        panicked.contains("\"shadow_panic\"")
            && panicked.contains("post_comments_observe_tests.rs:")
            && panicked.contains("after the panic: line=false in_flight=0"),
        "{panicked}"
    );
    assert!(!panicked.contains("forced panic"), "{panicked}");
    assert!(!leaks(&panicked), "{panicked}");
}

/// The shadow role's own process path, `shadow::run`, in a child process on
/// a real database with both switches at observe: it prints the server's
/// logging settings once, says it is listening with both observers, and then
/// serves /health, a vote copy and a comment copy over its socket.
#[test]
fn the_shadow_role_runs_both_observers_and_reports_the_servers_logging_settings() {
    const CHILD: &str = "POLIS_COMMENT_OBSERVE_RUN_TEST";
    /// The message of the panic the child forces after `shadow::run` has
    /// started. It must reach no output.
    const RUN_PANIC: &str = "vq4Nb81-run-path-panic-message";
    if std::env::var_os(CHILD).is_some() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let rt = live::runtime();
        rt.block_on(async {
            let running = tokio::spawn(shadow::run());
            let event = |name: &'static str| async move {
                let marker = format!("\"event\":\"{name}\"");
                let found = tokio::time::timeout(Duration::from_secs(30), async {
                    loop {
                        if let Some(line) = shadow::recorded()
                            .into_iter()
                            .find(|line| line.contains(&marker))
                        {
                            return line;
                        }
                        tokio::time::sleep(Duration::from_millis(10)).await;
                    }
                })
                .await;
                found.map(|line| serde_json::from_str::<Value>(&line).unwrap())
            };
            let Ok(listening) = event("shadow_listening").await else {
                println!("RUN failed: {:?}", running.await);
                return;
            };
            let logging = event("shadow_post_comments_database_logging").await.unwrap();
            let address = listening["address"].as_str().unwrap().to_owned();
            let exchange = |raw: String| {
                let address = address.clone();
                async move {
                    let mut client = tokio::net::TcpStream::connect(address).await.unwrap();
                    client.write_all(raw.as_bytes()).await.unwrap();
                    let mut response = Vec::new();
                    let _ = tokio::time::timeout(
                        Duration::from_secs(10),
                        client.read_to_end(&mut response),
                    )
                    .await;
                    String::from_utf8_lossy(&response).into_owned()
                }
            };
            let post = |path: &str, name: &str, id: &str, body: &str| {
                format!(
                    "POST {path} HTTP/1.1\r\nHost: localhost\r\nX-Polis-Shadow: {name}\r\nX-Forwarded-Proto: https\r\nX-Request-Id: {id}\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}",
                    body.len()
                )
            };
            let comment_id = request_id();
            let comment = exchange(post(
                PATH,
                "commentsShadow",
                &comment_id,
                &body(CID, "Generated for the running shadow", agree()),
            ))
            .await;
            let vote_id = request_id();
            let vote = exchange(post(
                crate::post_votes::PATH,
                "votesShadow",
                &vote_id,
                &json!({"conversation_id": CID, "tid": 0, "vote": crate::votes::WIRE_AGREE})
                    .to_string(),
            ))
            .await;
            let comment_line = observation(&comment_id).await;
            let vote_marker = format!("\"request_id\":\"{vote_id}\"");
            let vote_line = tokio::time::timeout(Duration::from_secs(30), async {
                loop {
                    if let Some(line) = shadow::recorded()
                        .into_iter()
                        .find(|line| line.contains(&vote_marker) && line.contains("shadow_observation"))
                    {
                        return serde_json::from_str::<Value>(&line).unwrap();
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap();
            let health = exchange(
                "GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n".into(),
            )
            .await;
            let (head, health) = health.split_once("\r\n\r\n").unwrap();
            let health: Value = serde_json::from_str(health).unwrap();
            println!(
                "RUN listening mode={} post_comments={}",
                listening["mode"], listening["post_comments"]
            );
            println!("RUN logging {logging}");
            println!(
                "RUN copies comment={} {} {} vote={} {} {}",
                comment.lines().next().unwrap_or_default(),
                comment_line["outcome"],
                comment_line["reason"],
                vote.lines().next().unwrap_or_default(),
                vote_line["outcome"],
                vote_line["reason"]
            );
            println!(
                "RUN health {} status={} votes={} {} comments={} {} {} {}",
                head.lines().next().unwrap_or_default(),
                health["status"],
                health["postVotes"]["mode"],
                health["postVotes"]["pools"]["readback"]["readOnly"],
                health["postComments"]["mode"],
                health["postComments"]["pools"]["reads"]["readOnly"],
                health["postComments"]["pools"]["readback"]["readOnly"],
                health["postComments"]["maxPerSecond"],
            );
            // The role's own path installed the panic hook: a panic in this
            // process prints where it happened and never what it said.
            let panicked = tokio::spawn(async {
                let message: &str = RUN_PANIC;
                assert!(message.is_empty(), "{message}");
            })
            .await;
            println!("RUN panicked {}", panicked.is_err());
            running.abort();
        });
        return;
    }
    let db = Database::new("observe_run");
    db.connect()
        .batch_execute(include_str!(
            "../../../server/postgres/migrations/000013_create_treevite.sql"
        ))
        .unwrap();
    let before = live::snapshot(&mut db.connect());
    let rsa = openssl::rsa::Rsa::generate(2048).unwrap();
    let dir = std::env::temp_dir().join(format!("comment-observe-run-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let key = dir.join("public.pem");
    std::fs::write(&key, rsa.public_key_to_pem().unwrap()).unwrap();
    let host = match &db.config.get_hosts()[0] {
        postgres::config::Host::Tcp(host) => host.clone(),
        #[allow(unreachable_patterns)]
        _ => panic!("a TCP test database is required"),
    };
    let credentials = match db.config.get_password() {
        Some(password) => format!(
            "{}:{}",
            db.config.get_user().unwrap(),
            String::from_utf8_lossy(password)
        ),
        None => db.config.get_user().unwrap().to_owned(),
    };
    let dsn = format!(
        "postgres://{credentials}@{host}:{}/{}",
        db.config.get_ports()[0],
        db.config.get_dbname().unwrap()
    );
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "post_comments::observe::tests::database::the_shadow_role_runs_both_observers_and_reports_the_servers_logging_settings",
            "--nocapture",
        ])
        .env_clear()
        .env(CHILD, "1")
        .env("POLIS_API_ROLE", "shadow")
        .env("POLIS_API_SHADOW_LISTEN", "127.0.0.1:0")
        .env("POLIS_API_SHADOW_MAX_PER_SECOND", "8")
        .env("POLIS_API_SHADOW_COMMENTS_MAX_PER_SECOND", "2")
        .env("POLIS_API_POST_VOTES", "observe")
        .env("POLIS_API_POST_COMMENTS", "observe")
        .env("POLIS_API_POST_VOTES_DATABASE_URL", &dsn)
        .env("POLIS_API_POST_COMMENTS_DATABASE_URL", &dsn)
        .env("DATABASE_URL", &dsn)
        .env("POLIS_API_DB_TRANSPORT", "loopback")
        .env("POLIS_API_PARTICIPANT_PUBLIC_KEY_FILE", &key)
        .env("POLIS_JWT_ISSUER", "fixture")
        .env("POLIS_JWT_AUDIENCE", "fixture")
        .env("TOPICAL_COMMENT_RATIO", "0")
        .env("SHOULD_USE_TRANSLATION_API", "false")
        .env("MATH_ENV", "test")
        .env("NODE_ENV", "production")
        .output()
        .unwrap();
    let printed = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    std::fs::remove_dir_all(dir).unwrap();
    assert!(output.status.success(), "{printed}");
    for expected in [
        "RUN listening mode=\"observe\" post_comments=\"observe\"",
        "RUN copies comment=HTTP/1.1 204 No Content \"would_hand_back\" \"no_token\" vote=HTTP/1.1 204 No Content \"would_hand_back\" \"no_token\"",
        "RUN health HTTP/1.1 200 OK status=\"ok\" votes=\"observe\" true comments=\"observe\" true true 2",
    ] {
        assert!(printed.contains(expected), "{expected}: {printed}");
    }
    let logging = printed
        .lines()
        .find_map(|line| line.strip_prefix("RUN logging "))
        .unwrap_or_else(|| panic!("no logging settings: {printed}"));
    let logging: Value = serde_json::from_str(logging).unwrap();
    assert_eq!(logging["listener"], "shadow");
    assert_eq!(logging["read"], "ok");
    for name in [
        "log_min_duration_statement",
        "log_min_duration_sample",
        "log_statement",
        "log_parameter_max_length",
        "log_parameter_max_length_on_error",
        "log_min_error_statement",
        "shared_preload_libraries",
    ] {
        assert!(logging[name].is_string(), "{name}: {logging}");
    }
    // `shadow::run` itself installs the hook when it builds the comment
    // observer: the child's panic is printed as a location, without its
    // message.
    assert!(
        printed.contains("RUN panicked true") && printed.contains("\"shadow_panic\""),
        "{printed}"
    );
    assert!(!printed.contains(RUN_PANIC), "{printed}");
    assert_eq!(live::snapshot(&mut db.connect()), before);
}
