//! The decision by reads alone (`Snapshot::decide`): that it writes nothing
//! and takes no lock, what it reports beside the outcome, what it cannot
//! know, the membership read, and the bounds the server puts on its
//! transaction. That it names what `admit` then does is asserted for every
//! participation request of `admission.rs` and for every recorded case of
//! `admission_recordings.rs`, through `support::decided_then_admitted`.
#![cfg(feature = "db-tests")]
#![allow(clippy::unwrap_used, clippy::expect_used)]
#[path = "support/admission.rs"]
mod support;
use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
use polis_auth::{
    Pid, Refusal, Uid, Unavailable, Zid,
    admission::*,
    participant::{Verified, Verifier},
};
use postgres::Client;
use std::time::{Duration, Instant};
use support::*;

fn decide(db: &mut Client, identity: &Identity<'_>, zid: i32) -> Decision {
    let mut reads = snapshot(db, &Bounds::OBSERVE).unwrap();
    let decision = reads
        .decide(&Participation {
            zid: Zid(zid),
            identity,
            create_if_missing: true,
            admin_uids: &[],
        })
        .unwrap();
    reads.end();
    decision
}

/// Everything a creation would change, as one comparable value: the rows of
/// every table `admit` writes, the conversation's participant count, and the
/// user-number sequence.
fn state(db: &mut Client) -> Vec<String> {
    [
        "SELECT count(*)::text FROM users",
        "SELECT count(*)::text FROM participants",
        "SELECT count(*)::text FROM participants_extended",
        "SELECT count(*)::text FROM xids",
        "SELECT count(*)::text FROM xid_whitelist",
        "SELECT count(*)::text FROM oidc_user_mappings",
        "SELECT string_agg(participant_count::text, ',' ORDER BY zid) FROM conversations",
        "SELECT last_value::text || ':' || is_called::text FROM users_uid_seq",
    ]
    .iter()
    .map(|sql| db.query_one(*sql, &[]).unwrap().get::<_, String>(0))
    .collect()
}

#[test]
fn a_decision_reads_and_changes_nothing() {
    let mut f = Fixture::new();
    f.db.batch_execute(
        "INSERT INTO participants(zid,uid) VALUES(1,2);
         INSERT INTO xids(owner,uid,xid,zid,pid) VALUES(1,2,'bound',1,0);
         INSERT INTO conversations(zid,owner,is_active) VALUES(4,1,false);
         INSERT INTO conversations(zid,owner,xid_required) VALUES(5,1,true);
         INSERT INTO conversations(zid,owner,use_xid_whitelist) VALUES(6,1,true);
         INSERT INTO conversations(zid,owner,treevite_enabled) VALUES(7,1,true);",
    )
    .unwrap();
    let before = state(&mut f.db);
    let mut other = f.connect();
    let deciding = backend(&mut f.db);
    let cases: Vec<(Identity<'_>, i32, Outcome, XidSeen)> = vec![
        (
            Identity::Anonymous,
            1,
            Outcome::CreateUserAndParticipant,
            XidSeen::NotNamed,
        ),
        (
            Identity::AnonymousParticipant {
                uid: Uid(2),
                conversation: Zid(1),
            },
            1,
            Outcome::Found,
            XidSeen::NotNamed,
        ),
        (
            Identity::Account(Uid(3)),
            1,
            Outcome::CreateParticipant,
            XidSeen::NotNamed,
        ),
        (
            Identity::Xid {
                xid: "bound",
                uid: None,
            },
            1,
            Outcome::Found,
            XidSeen::Bound,
        ),
        (
            Identity::Xid {
                xid: "bound",
                uid: None,
            },
            2,
            Outcome::CreateParticipant,
            XidSeen::Bound,
        ),
        (
            Identity::Xid {
                xid: "new",
                uid: None,
            },
            1,
            Outcome::CreateUserAndParticipant,
            XidSeen::Unbound,
        ),
        (
            Identity::Anonymous,
            4,
            Outcome::Refused(Refusal {
                status: 403,
                code: "polis_err_conversation_is_closed",
            }),
            XidSeen::NotNamed,
        ),
        (
            Identity::Anonymous,
            5,
            Outcome::Refused(Refusal {
                status: 403,
                code: "polis_err_xid_required",
            }),
            XidSeen::NotNamed,
        ),
        (
            Identity::Xid {
                xid: "unlisted",
                uid: None,
            },
            6,
            Outcome::Refused(Refusal {
                status: 403,
                code: "polis_err_xid_not_allowed",
            }),
            XidSeen::NotReached,
        ),
        (
            Identity::Anonymous,
            7,
            Outcome::Refused(Refusal {
                status: 401,
                code: "polis_err_treevite_auth_required",
            }),
            XidSeen::NotNamed,
        ),
        (
            Identity::Anonymous,
            99,
            Outcome::Refused(Refusal {
                status: 404,
                code: "polis_err_fetching_zid_for_conversation_id",
            }),
            XidSeen::NotNamed,
        ),
    ];
    for (identity, zid, outcome, xid) in &cases {
        let decision = decide(&mut f.db, identity, *zid);
        assert_eq!(decision.outcome, *outcome, "conversation {zid}");
        assert_eq!(decision.xid, *xid, "conversation {zid}");
        // The session holds nothing once the decision has ended: no advisory
        // lock, no lock on a table, no open transaction.
        let held: i64 = other
            .query_one("SELECT count(*) FROM pg_locks WHERE pid = $1", &[&deciding])
            .unwrap()
            .get(0);
        assert_eq!(held, 0, "conversation {zid}: a lock outlived the decision");
    }
    assert_eq!(state(&mut f.db), before, "a decision changed a row");
    // What it reports beside the outcome.
    let found = decide(
        &mut f.db,
        &Identity::Xid {
            xid: "bound",
            uid: None,
        },
        1,
    );
    assert_eq!(found.uid(), Some(Uid(2)));
    assert_eq!(found.pid(), Some(Pid(0)));
    assert_eq!(found.owner(), Some(Uid(1)));
    assert_eq!(
        found.rules,
        Some(RulesSeen {
            treevite: false,
            xid_required: false,
            allowlist: false
        })
    );
    let treevite = decide(&mut f.db, &Identity::Anonymous, 7);
    assert_eq!(treevite.rules.map(|rules| rules.treevite), Some(true));
    // A closed conversation is refused before its rules are read.
    let closed = decide(&mut f.db, &Identity::Anonymous, 4);
    assert!(closed.rules.is_none() && closed.uid().is_none() && closed.owner().is_none());
}

/// The same statements `admit` sends for its reads, and no others: the
/// decision is those reads, in a transaction that can only read.
#[test]
fn a_decision_runs_in_a_read_only_transaction() {
    let mut f = Fixture::new();
    let mut reads = snapshot(&mut f.db, &Bounds::OBSERVE).unwrap();
    for (sql, state) in [
        ("INSERT INTO users(created) VALUES(default)", "25006"),
        ("UPDATE conversations SET participant_count = 1", "25006"),
        ("DELETE FROM participants", "25006"),
        (
            "SELECT is_active FROM conversations WHERE zid=1 FOR SHARE",
            "25006",
        ),
        ("SELECT nextval('users_uid_seq')", "25006"),
    ] {
        let tx = reads.client();
        let mut inner = tx.savepoint("attempt").unwrap();
        let error = inner.batch_execute(sql).unwrap_err();
        assert_eq!(error.code().map(|code| code.code()), Some(state), "{sql}");
        inner.rollback().unwrap();
    }
    reads.end();
    f.assert_clean();
}

/// What a decision by reads cannot know: the user number a new user would
/// be given. `admit` checks it against the configured administrators after
/// the insert and refuses; the decision, taken before any insert, says a
/// user would be created.
#[test]
fn a_decision_cannot_know_the_user_number_a_new_user_would_get() {
    let mut f = Fixture::new();
    let admins = [Uid(4)];
    let identity = Identity::Xid {
        xid: "new",
        uid: None,
    };
    let mut reads = snapshot(&mut f.db, &Bounds::OBSERVE).unwrap();
    let decision = reads
        .decide(&Participation {
            zid: Zid(1),
            identity: &identity,
            create_if_missing: true,
            admin_uids: &admins,
        })
        .unwrap();
    reads.end();
    assert_eq!(decision.outcome, Outcome::CreateUserAndParticipant);
    let mut r = request(Identity::Xid {
        xid: "new",
        uid: None,
    });
    r.admin_uids = &admins;
    assert_eq!(
        admit(&mut f.db, &r),
        Err(Error::Refused(Refusal {
            status: 403,
            code: "polis_err_xid_owner_account",
        }))
    );
    f.assert_clean();
}

fn member_token(uid: i32, pid: i32) -> (Verifier, String) {
    let rsa = openssl::rsa::Rsa::generate(2048).unwrap();
    let verifier = Verifier::new(&rsa.public_key_to_pem().unwrap(), "issuer", "audience").unwrap();
    let key = EncodingKey::from_rsa_pem(&rsa.private_key_to_pem().unwrap()).unwrap();
    let claims = serde_json::json!({
        "uid": uid, "pid": pid, "conversation_id": "2fixture", "sub": format!("anon:{uid}"),
        "iss": "issuer", "aud": "audience", "exp": 200, "iat": 100, "anonymous_participant": true
    });
    let token = encode(&Header::new(Algorithm::RS256), &claims, &key).unwrap();
    (verifier, format!("Bearer {token}"))
}

fn verified(uid: i32, pid: i32) -> Verified {
    let (verifier, token) = member_token(uid, pid);
    verifier.verify_unobserved(&token, "2fixture", 150).unwrap()
}

/// Why the membership read finds no member for a verified token: the
/// conversation uses Treevite (every member, whatever their row), or the
/// row is absent, or it carries another participant number.
#[test]
fn the_membership_read_says_treevite_and_how_the_row_compares() {
    let mut f = Fixture::new();
    f.db.batch_execute(
        "INSERT INTO participants(zid,uid) VALUES(1,2),(1,3);
         INSERT INTO conversations(zid,owner,treevite_enabled) VALUES(7,1,true);
         INSERT INTO participants(zid,uid) VALUES(7,2);",
    )
    .unwrap();
    let before = state(&mut f.db);
    let mut read = |zid: i32, uid: i32, pid: i32| {
        let identity = verified(uid, pid);
        let mut reads = snapshot(&mut f.db, &Bounds::OBSERVE).unwrap();
        let membership = reads.membership(Zid(zid), &identity).unwrap();
        reads.end();
        membership
    };
    for (zid, uid, pid, expected) in [
        (1, 2, 0, Some((false, MemberRow::Matches))),
        (1, 3, 1, Some((false, MemberRow::Matches))),
        (1, 3, 0, Some((false, MemberRow::Differs))),
        (1, 1, 0, Some((false, MemberRow::Absent))),
        (7, 2, 0, Some((true, MemberRow::Matches))),
        (7, 2, 5, Some((true, MemberRow::Differs))),
        (7, 3, 0, Some((true, MemberRow::Absent))),
        (99, 2, 0, None),
    ] {
        assert_eq!(
            read(zid, uid, pid).map(|membership| (membership.treevite, membership.row)),
            expected,
            "conversation {zid}, user {uid}, token number {pid}"
        );
    }
    assert_eq!(
        state(&mut f.db),
        before,
        "the membership read changed a row"
    );
}

fn backend(db: &mut Client) -> i32 {
    db.query_one("SELECT pg_backend_pid()", &[]).unwrap().get(0)
}

/// Polls until the session `backend` holds no lock on `conversations`, and
/// answers how long that took. The server, not the caller, ends the wait.
fn released(other: &mut Client, backend: i32) -> Duration {
    let started = Instant::now();
    loop {
        let held: i64 = other
            .query_one(
                "SELECT count(*) FROM pg_locks WHERE pid = $1 AND locktype = 'relation'
                 AND relation = 'conversations'::regclass",
                &[&backend],
            )
            .unwrap()
            .get(0);
        if held == 0 {
            return started.elapsed();
        }
        assert!(
            started.elapsed() < Duration::from_secs(30),
            "the server did not end the stalled transaction"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

/// A caller that stops between two reads of a decision does not keep its
/// transaction, or the lock its first read took on `conversations`: the
/// server ends the session when the transaction has been idle for the bound.
/// The caller sends nothing more; the bound is the server's own.
#[test]
fn the_server_ends_a_decision_that_stalls_between_two_reads() {
    let mut f = Fixture::new();
    let mut other = f.connect();
    let mut stalled = f.connect();
    let pid = backend(&mut stalled);
    let bounds = Bounds {
        idle: Duration::from_millis(300),
        ..Bounds::OBSERVE
    };
    let mut reads = snapshot(&mut stalled, &bounds).unwrap();
    reads
        .client()
        .query_opt("SELECT owner FROM conversations WHERE zid=1", &[])
        .unwrap();
    let held: i64 = other
        .query_one(
            "SELECT count(*) FROM pg_locks WHERE pid = $1 AND locktype = 'relation'
             AND relation = 'conversations'::regclass AND mode = 'AccessShareLock'",
            &[&pid],
        )
        .unwrap()
        .get(0);
    assert_eq!(
        held, 1,
        "the first read holds its lock while the transaction is open"
    );
    // The observer stalls here. Nothing is sent on its connection.
    released(&mut other, pid);
    // The session is gone: the next read of the decision cannot run.
    let next = reads.decide(&Participation {
        zid: Zid(1),
        identity: &Identity::Anonymous,
        create_if_missing: true,
        admin_uids: &[],
    });
    assert!(matches!(next, Err(Unavailable)));
    f.assert_clean();
}

/// A decision that keeps reading is ended by the server too: no transaction
/// of the observer's outlives the transaction bound, however busy it is.
#[test]
fn the_server_ends_a_decision_that_outlives_its_transaction_bound() {
    let mut f = Fixture::new();
    let mut busy = f.connect();
    let bounds = Bounds {
        transaction: Duration::from_millis(300),
        ..Bounds::OBSERVE
    };
    let mut reads = snapshot(&mut busy, &bounds).unwrap();
    let started = Instant::now();
    let error = loop {
        match reads
            .client()
            .query_opt("SELECT owner FROM conversations WHERE zid=1", &[])
        {
            Ok(_) => assert!(
                started.elapsed() < Duration::from_secs(30),
                "the server did not end the transaction"
            ),
            Err(error) => break error,
        }
    };
    // 25P04: transaction_timeout. A connection the server has already closed
    // answers with no SQLSTATE at all.
    assert!(
        error
            .code()
            .is_none_or(|code| code.code() == "25P04" || code.code() == "57P01"),
        "{error}"
    );
    f.assert_clean();
}

/// One slow read is cut by the statement bound, and the decision says the
/// database could not answer; it never guesses an outcome.
#[test]
fn a_read_over_the_statement_bound_is_unavailable() {
    let mut f = Fixture::new();
    let mut slow = f.connect();
    // A conversations relation whose read takes longer than the bound.
    slow.batch_execute(
        "DROP SCHEMA IF EXISTS slow_reads CASCADE; CREATE SCHEMA slow_reads;
         CREATE FUNCTION slow_reads.wait() RETURNS boolean LANGUAGE sql AS 'SELECT pg_sleep(5) IS NOT NULL';",
    )
    .unwrap();
    slow.batch_execute(&format!(
        "CREATE VIEW slow_reads.conversations AS SELECT c.* FROM {}.conversations c WHERE slow_reads.wait();
         SET search_path TO slow_reads, {}",
        f.schema, f.schema
    ))
    .unwrap();
    let mut reads = snapshot(&mut slow, &Bounds::OBSERVE).unwrap();
    let started = Instant::now();
    let decision = reads.decide(&Participation {
        zid: Zid(1),
        identity: &Identity::Anonymous,
        create_if_missing: true,
        admin_uids: &[],
    });
    assert!(matches!(decision, Err(Unavailable)));
    assert!(
        started.elapsed() < Duration::from_secs(4),
        "the read was not cut"
    );
    reads.end();
    slow.batch_execute("DROP SCHEMA slow_reads CASCADE")
        .unwrap();
    f.assert_clean();
}
