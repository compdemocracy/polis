#![cfg(feature = "db-tests")]
#![allow(clippy::unwrap_used, clippy::expect_used)]
#[path = "support/admission.rs"]
mod support;
use polis_auth::{Pid, Refusal, Uid, Zid, admission::*};
use std::{
    sync::{Arc, Barrier},
    thread,
    time::{Duration, Instant},
};
use support::*;

fn refused(result: Result<Option<Admitted>, Error>, status: u16, code: &'static str) {
    assert_eq!(result, Err(Error::Refused(Refusal { status, code })));
}
#[test]
fn anonymous_first_returning_and_cross_conversation_are_scoped() {
    let mut f = Fixture::new();
    let first = admit(&mut f.db, &request(Identity::Anonymous))
        .unwrap()
        .unwrap();
    assert_eq!(first.pid, Pid(0));
    assert!(first.new_user && first.new_participant);
    let mut r = request(Identity::AnonymousParticipant {
        uid: first.uid,
        conversation: Zid(1),
    });
    let repeat = admit(&mut f.db, &r).unwrap().unwrap();
    assert_eq!((repeat.uid, repeat.pid), (first.uid, first.pid));
    assert!(!repeat.new_user && !repeat.new_participant);
    r.zid = Zid(2);
    let other = admit(&mut f.db, &r).unwrap().unwrap();
    assert_ne!(other.uid, first.uid);
    assert_eq!(other.pid, Pid(0));
}
#[test]
fn xid_first_returning_owner_namespace_and_optional_first_contact() {
    let mut f = Fixture::new();
    let mut r = request(Identity::Xid {
        xid: "member",
        uid: None,
    });
    r.entry = Entry::Participation {
        create_if_missing: false,
    };
    r.x_name = Some("Name");
    let first = admit(&mut f.db, &r).unwrap().unwrap();
    let repeat = admit(&mut f.db, &r).unwrap().unwrap();
    assert_eq!((repeat.uid, repeat.pid), (first.uid, first.pid));
    r.zid = Zid(2);
    assert_eq!(admit(&mut f.db, &r).unwrap().unwrap().uid, first.uid);
    f.db.batch_execute("UPDATE conversations SET owner=2 WHERE zid=3")
        .unwrap();
    r.zid = Zid(3);
    assert_ne!(admit(&mut f.db, &r).unwrap().unwrap().uid, first.uid);
    let row =
        f.db.query_one("SELECT uid,zid,pid,x_name FROM xids WHERE owner=1", &[])
            .unwrap();
    assert_eq!(row.get::<_, i32>(0), first.uid.0);
    assert_eq!((row.get::<_, i32>(1), row.get::<_, i32>(2)), (1, 0));
    assert_eq!(row.get::<_, String>(3), "Name");
}
#[test]
fn xid_allow_list_is_owner_wide_and_applies_to_returning_tokens() {
    let mut f = Fixture::new();
    f.db.batch_execute("UPDATE conversations SET use_xid_whitelist=true; INSERT INTO xid_whitelist VALUES(1,'allowed',2)").unwrap();
    refused(
        admit(
            &mut f.db,
            &request(Identity::Xid {
                xid: "denied",
                uid: None,
            }),
        ),
        403,
        "polis_err_xid_not_allowed",
    );
    f.assert_clean();
    let p = admit(
        &mut f.db,
        &request(Identity::Xid {
            xid: "allowed",
            uid: None,
        }),
    )
    .unwrap()
    .unwrap();
    f.db.batch_execute("DELETE FROM xid_whitelist").unwrap();
    refused(
        admit(
            &mut f.db,
            &request(Identity::Xid {
                xid: "allowed",
                uid: Some(p.uid),
            }),
        ),
        403,
        "polis_err_xid_not_allowed",
    );
}
#[test]
fn anonymous_optional_read_and_xid_required_gate() {
    let mut f = Fixture::new();
    f.db.batch_execute("UPDATE conversations SET xid_required=true")
        .unwrap();
    let mut r = request(Identity::Anonymous);
    refused(admit(&mut f.db, &r), 403, "polis_err_xid_required");
    r.entry = Entry::Participation {
        create_if_missing: false,
    };
    assert_eq!(admit(&mut f.db, &r), Ok(None));
    f.assert_clean();
}
#[test]
fn treevite_gate_owner_bypass_and_existing_membership() {
    let mut f = Fixture::new();
    f.db.batch_execute("UPDATE conversations SET treevite_enabled=true,xid_required=true")
        .unwrap();
    let mut r = request(Identity::Anonymous);
    refused(admit(&mut f.db, &r), 403, "polis_err_xid_required");
    f.db.batch_execute("UPDATE conversations SET xid_required=false")
        .unwrap();
    refused(
        admit(&mut f.db, &r),
        401,
        "polis_err_treevite_auth_required",
    );
    f.assert_clean();
    // Moderator and ADMIN_UIDS are deliberately not owner bypasses.
    f.db.batch_execute("UPDATE users SET site_id='owner' WHERE uid=2")
        .unwrap();
    r.identity = Identity::Account(Uid(2));
    r.admin_uids = &[Uid(2)];
    refused(
        admit(&mut f.db, &r),
        401,
        "polis_err_treevite_auth_required",
    );
    r.identity = Identity::Account(Uid(1));
    assert_eq!(admit(&mut f.db, &r).unwrap().unwrap().pid, Pid(0));
    f.db.batch_execute("INSERT INTO participants(zid,uid) VALUES(1,2)")
        .unwrap();
    r.identity = Identity::Account(Uid(2));
    assert_eq!(admit(&mut f.db, &r).unwrap().unwrap().pid, Pid(1));
}
#[test]
fn oidc_and_standard_account_join_keep_uid_across_conversations() {
    let mut f = Fixture::new();
    f.db.batch_execute("INSERT INTO oidc_user_mappings VALUES('verified-account',2)")
        .unwrap();
    let mut r = request(Identity::Account(Uid(2)));
    for zid in [1, 2] {
        r.zid = Zid(zid);
        let p = admit(&mut f.db, &r).unwrap().unwrap();
        assert_eq!(p.uid, Uid(2));
        assert!(!p.new_user);
    }
    assert!(!admit(&mut f.db, &r).unwrap().unwrap().new_participant);
}
#[test]
fn every_owner_bound_xid_class_is_refused_without_writes() {
    for setup in [
        "UPDATE conversations SET owner=2 WHERE zid=3",
        "UPDATE users SET is_owner=true WHERE uid=2",
        "UPDATE users SET site_id='owner' WHERE uid=2",
        "INSERT INTO oidc_user_mappings VALUES('oidc',2)",
        "SELECT 1",
    ] {
        let mut f = Fixture::new();
        f.db.batch_execute(setup).unwrap();
        f.db.batch_execute("INSERT INTO xids(owner,uid,xid) VALUES(1,2,'bound')")
            .unwrap();
        let before = f.counts();
        let mut r = request(Identity::Xid {
            xid: "bound",
            uid: None,
        });
        if setup == "SELECT 1" {
            r.admin_uids = &[Uid(2)];
        }
        refused(admit(&mut f.db, &r), 403, "polis_err_xid_owner_account");
        // Same guard when a verified XID token already carries this UID.
        r.identity = Identity::Xid {
            xid: "bound",
            uid: Some(Uid(2)),
        };
        refused(admit(&mut f.db, &r), 403, "polis_err_xid_owner_account");
        assert_eq!(f.counts(), before);
    }
}
#[test]
fn newly_allocated_xid_cannot_take_a_configured_administrator_uid() {
    let mut f = Fixture::new();
    let mut r = request(Identity::Xid {
        xid: "new",
        uid: None,
    });
    r.admin_uids = &[Uid(4)];
    refused(admit(&mut f.db, &r), 403, "polis_err_xid_owner_account");
    f.assert_clean();
}
#[test]
fn closed_conversation_refuses_even_owner_and_invitee_without_writes() {
    let mut f = Fixture::new();
    f.db.batch_execute("UPDATE conversations SET is_active=false")
        .unwrap();
    for identity in [
        Identity::Anonymous,
        Identity::Account(Uid(1)),
        Identity::Xid {
            xid: "new",
            uid: None,
        },
    ] {
        refused(
            admit(&mut f.db, &request(identity)),
            403,
            "polis_err_conversation_is_closed",
        );
    }
    let mut r = request(Identity::Anonymous);
    r.entry = invite();
    refused(
        admit(&mut f.db, &r),
        403,
        "polis_err_conversation_is_closed",
    );
    f.assert_clean();
}
#[test]
fn treevite_invitee_login_consumed_invite_and_revocation() {
    let mut f = Fixture::new();
    f.db.batch_execute("UPDATE conversations SET treevite_enabled=true,xid_required=true")
        .unwrap();
    let mut r = request(Identity::Anonymous);
    r.entry = invite();
    let p = admit(&mut f.db, &r).unwrap().unwrap();
    assert_eq!(p.pid, Pid(0));
    assert_eq!(p.invite, Some((1, 1)));
    assert_eq!(f.counts(), vec![4, 1, 0, 0, 1]);
    assert!(
        !f.db
            .query_one("SELECT site_owner FROM users WHERE uid=$1", &[&p.uid.0])
            .unwrap()
            .get::<_, bool>(0)
    );
    refused(
        admit(&mut f.db, &r),
        400,
        "polis_err_treevite_invalid_or_used_invite",
    );
    r.entry = Entry::Login(VerifiedLogin {
        lookup: "generated-lookup",
        bcrypt_hash: "prepared-on-crypto-worker",
    });
    let login = admit(&mut f.db, &r).unwrap().unwrap();
    assert_eq!((login.uid, login.pid), (p.uid, p.pid));
    assert!(
        f.db.query_one(
            "SELECT last_used_at IS NOT NULL FROM treevite_login_codes",
            &[]
        )
        .unwrap()
        .get::<_, bool>(0)
    );
    f.db.batch_execute("UPDATE treevite_login_codes SET login_code_hash='replaced'")
        .unwrap();
    refused(
        admit(&mut f.db, &r),
        401,
        "polis_err_treevite_login_code_invalid",
    );
    f.db.batch_execute(
        "UPDATE treevite_login_codes SET login_code_hash='prepared-on-crypto-worker',revoked=true",
    )
    .unwrap();
    refused(
        admit(&mut f.db, &r),
        401,
        "polis_err_treevite_login_code_invalid",
    );
}
#[test]
fn pid_zero_invitee_is_reused_and_failed_reaccept_preserves_recovery() {
    let mut f = Fixture::new();
    let mut r = request(Identity::Anonymous);
    r.entry = invite();
    let first = admit(&mut f.db, &r).unwrap().unwrap();
    assert_eq!(first.pid, Pid(0));
    f.db.batch_execute("INSERT INTO treevite_invites(zid,wave_id,invite_code) VALUES(1,1,'another'); CREATE FUNCTION reject_consume() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'consume fault'; END $$; CREATE TRIGGER reject_consume AFTER UPDATE ON treevite_invites FOR EACH ROW EXECUTE FUNCTION reject_consume()").unwrap();
    r.identity = Identity::AnonymousParticipant {
        uid: first.uid,
        conversation: Zid(1),
    };
    r.entry = Entry::Invite {
        code: "another",
        recovery: PreparedRecovery {
            code: "replacement",
            bcrypt_hash: "replacement",
            lookup: "replacement",
            fingerprint_key: b"generated-key",
        },
    };
    assert_eq!(admit(&mut f.db, &r), Err(Error::Unavailable));
    assert_eq!(f.counts(), vec![4, 1, 0, 0, 1]);
    assert_eq!(
        f.db.query_one("SELECT login_code_hash FROM treevite_login_codes", &[])
            .unwrap()
            .get::<_, String>(0),
        "prepared-on-crypto-worker"
    );
    f.db.batch_execute("DROP TRIGGER reject_consume ON treevite_invites")
        .unwrap();
    let repeat = admit(&mut f.db, &r).unwrap().unwrap();
    assert_eq!((repeat.uid, repeat.pid), (first.uid, first.pid));
    assert!(!repeat.new_user && !repeat.new_participant);
}
#[test]
fn failures_at_each_write_boundary_roll_back_all_rows_and_allocator() {
    for table in [
        "users",
        "participants_extended",
        "participants",
        "xids",
        "treevite_login_codes",
        "treevite_invites",
    ] {
        let mut f = Fixture::new();
        // An actual SQL exception, after the chosen write, exercises rollback
        // rather than a mock transaction. The allocator has already fired for
        // participant and all later boundaries.
        f.db.batch_execute(&format!("CREATE FUNCTION fail_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected write failure'; END $$; CREATE TRIGGER fail_write AFTER INSERT OR UPDATE ON {table} FOR EACH ROW EXECUTE FUNCTION fail_write()")).unwrap();
        let mut r = request(Identity::Xid {
            xid: "new",
            uid: None,
        });
        if ["treevite_login_codes", "treevite_invites"].contains(&table) {
            r.entry = invite();
        }
        assert_eq!(admit(&mut f.db, &r), Err(Error::Unavailable), "{table}");
        f.assert_clean();
    }
}
#[test]
fn deferred_commit_failure_leaves_no_rows_and_is_not_blindly_retried() {
    let mut f = Fixture::new();
    f.db.batch_execute("CREATE FUNCTION fail_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'commit fault'; END $$; CREATE CONSTRAINT TRIGGER fail_commit AFTER INSERT ON participants DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fail_commit()").unwrap();
    assert_eq!(
        admit(&mut f.db, &request(Identity::Anonymous)),
        Err(Error::CommitUnknown)
    );
    f.assert_clean();
}
#[test]
fn concurrent_close_before_allocation_rolls_back_the_new_identity() {
    let mut f = Fixture::new();
    let mut blocker = f.connect();
    let mut held = blocker.transaction().unwrap();
    held.query_one("SELECT pg_advisory_xact_lock(873791983,1)", &[])
        .unwrap();
    let mut worker = f.connect();
    let join = thread::spawn(move || admit(&mut worker, &request(Identity::Anonymous)));
    f.wait_for_locks(1);
    f.db.execute("UPDATE conversations SET is_active=false WHERE zid=1", &[])
        .unwrap();
    held.commit().unwrap();
    refused(
        join.join().unwrap(),
        403,
        "polis_err_conversation_is_closed",
    );
    f.assert_clean();
}
#[test]
fn invite_race_has_one_winner_and_loser_writes_nothing() {
    // Repeat with anonymous first contacts and recoverable existing identities:
    // the latter was the membership bypass in the nontransactional flow.
    for existing in [false, true] {
        let mut f = Fixture::new();
        if existing {
            f.db.batch_execute("INSERT INTO participants(zid,uid) VALUES(2,1),(2,2),(2,3); INSERT INTO xids(owner,uid,xid,zid,pid) VALUES(1,2,'two',2,1),(1,3,'three',2,2)").unwrap();
        }
        f.db.batch_execute("UPDATE conversations SET treevite_enabled=true")
            .unwrap();
        let mut holder = f.connect();
        let mut held = holder.transaction().unwrap();
        held.query_one("SELECT id FROM treevite_invites WHERE id=1 FOR UPDATE", &[])
            .unwrap();
        let barrier = Arc::new(Barrier::new(3));
        let workers: Vec<_> = (2..=3)
            .map(|uid| {
                let mut db = f.connect();
                let barrier = barrier.clone();
                thread::spawn(move || {
                    let mut r = request(if existing {
                        Identity::Xid {
                            xid: if uid == 2 { "two" } else { "three" },
                            uid: None,
                        }
                    } else {
                        Identity::Anonymous
                    });
                    r.entry = invite();
                    barrier.wait();
                    admit(&mut db, &r)
                })
            })
            .collect();
        barrier.wait();
        f.wait_for_locks(2);
        held.commit().unwrap();
        let results: Vec<_> = workers.into_iter().map(|w| w.join().unwrap()).collect();
        assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter(|r| **r
                    == Err(Error::Refused(Refusal {
                        status: 400,
                        code: "polis_err_treevite_invalid_or_used_invite"
                    })))
                .count(),
            1
        );
        assert_eq!(
            f.counts(),
            vec![
                if existing { 3 } else { 4 },
                if existing { 4 } else { 1 },
                0,
                if existing { 2 } else { 0 },
                1
            ]
        );
        assert_eq!(
            f.db.query_one(
                "SELECT participant_count FROM conversations WHERE zid=1",
                &[]
            )
            .unwrap()
            .get::<_, i32>(0),
            1
        );
        if existing {
            let p = results
                .iter()
                .find_map(|r| r.as_ref().ok().copied().flatten())
                .unwrap();
            let loser = if p.uid == Uid(2) { Uid(3) } else { Uid(2) };
            refused(
                admit(
                    &mut f.db,
                    &request(Identity::Xid {
                        xid: if loser == Uid(2) { "two" } else { "three" },
                        uid: None,
                    }),
                ),
                401,
                "polis_err_treevite_auth_required",
            );
        }
    }
}
#[test]
fn concurrent_xid_and_account_joins_resolve_the_winner_without_orphans() {
    for xid in [false, true] {
        let mut f = Fixture::new();
        let barrier = Arc::new(Barrier::new(5));
        let workers: Vec<_> = (0..4)
            .map(|_| {
                let mut db = f.connect();
                let b = barrier.clone();
                thread::spawn(move || {
                    b.wait();
                    admit(
                        &mut db,
                        &request(if xid {
                            Identity::Xid {
                                xid: "same",
                                uid: None,
                            }
                        } else {
                            Identity::Account(Uid(2))
                        }),
                    )
                    .unwrap()
                    .unwrap()
                })
            })
            .collect();
        barrier.wait();
        let results: Vec<_> = workers.into_iter().map(|w| w.join().unwrap()).collect();
        assert!(
            results
                .iter()
                .all(|p| p.uid == results[0].uid && p.pid == Pid(0))
        );
        assert_eq!(
            f.counts(),
            vec![if xid { 4 } else { 3 }, 1, 1, if xid { 1 } else { 0 }, 0]
        );
        assert_eq!(
            f.db.query_one(
                "SELECT participant_count FROM conversations WHERE zid=1",
                &[]
            )
            .unwrap()
            .get::<_, i32>(0),
            1
        );
    }
}
#[test]
fn allocator_lock_is_held_to_commit_and_unrelated_conversation_can_join() {
    let mut f = Fixture::new();
    let mut holder = f.connect();
    let mut tx = holder.transaction().unwrap();
    tx.execute("INSERT INTO participants(zid,uid) VALUES(1,2)", &[])
        .unwrap();
    let mut other = f.connect();
    assert!(
        !other
            .query_one("SELECT pg_try_advisory_xact_lock(873791983,1)", &[])
            .unwrap()
            .get::<_, bool>(0)
    );
    let started = Instant::now();
    let mut r = request(Identity::Anonymous);
    r.zid = Zid(2);
    assert!(admit(&mut other, &r).is_ok());
    assert!(started.elapsed() < Duration::from_secs(2));
    tx.commit().unwrap();
    let p = admit(&mut f.db, &request(Identity::Anonymous))
        .unwrap()
        .unwrap();
    assert_eq!(p.pid, Pid(1));
}
