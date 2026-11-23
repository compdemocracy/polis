#![cfg(feature = "db-tests")]
#![allow(clippy::unwrap_used, clippy::expect_used)]
//! `admit_then`: the caller's statements inside the admission transaction,
//! after the person's rows and before COMMIT.
#[path = "support/admission.rs"]
mod support;
use polis_auth::{Uid, admission::*};
use postgres::error::SqlState;
use std::{
    sync::{Mutex, MutexGuard, mpsc},
    thread,
    time::{Duration, Instant},
};
use support::*;

/// The participant-number lock is keyed by the conversation number, not by
/// the schema each fixture makes, so every test here (all in conversation 1)
/// would contend for one lock and, at a 100 ms bound, fail for another test's
/// hold. They run one at a time.
static SERIAL: Mutex<()> = Mutex::new(());

fn serial() -> MutexGuard<'static, ()> {
    SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The vote writer's first-contact bounds: a 100 ms lock wait, one second per
/// statement and idle, two seconds in all.
const BOUNDS: Bounds = Bounds {
    statement: Duration::from_millis(1000),
    lock: Duration::from_millis(100),
    idle: Duration::from_millis(1000),
    transaction: Duration::from_millis(2000),
};

/// A table the callback writes, referencing the person admission created.
fn with_callback_rows(f: &mut Fixture) {
    f.db.batch_execute(
        "CREATE TABLE callback_rows(zid int, pid int, uid int references users(uid), \
         foreign key(zid,pid) references participants(zid,pid))",
    )
    .unwrap();
}

fn count(f: &mut Fixture, table: &str) -> i64 {
    f.db.query_one(&format!("SELECT count(*) FROM {table}"), &[])
        .unwrap()
        .get(0)
}

fn write_row(tx: &mut postgres::Transaction<'_>, a: &Admitted) -> Result<(), postgres::Error> {
    tx.execute(
        "INSERT INTO callback_rows(zid,pid,uid) VALUES(1,$1,$2)",
        &[&(a.pid.0 as i32), &a.uid.0],
    )
    .map(|_| ())
}

#[test]
fn a_failing_callback_leaves_no_user_extended_row_or_participant() {
    let _serial = serial();
    let mut f = Fixture::new();
    with_callback_rows(&mut f);
    let mut calls = 0;
    let result = admit_then(
        &mut f.db,
        &request(Identity::Anonymous),
        &BOUNDS,
        |tx, a| {
            calls += 1;
            write_row(tx, a).unwrap();
            Err::<(), _>("the caller's own failure")
        },
    );
    assert_eq!(result, Err(ThenError::Callback("the caller's own failure")));
    assert_eq!(calls, 1);
    f.assert_clean();
    assert_eq!(count(&mut f, "callback_rows"), 0);
}

#[test]
fn a_unique_violation_in_the_callback_is_returned_once_and_not_retried() {
    let _serial = serial();
    let mut f = Fixture::new();
    f.db.batch_execute(
        "CREATE TABLE callback_unique(k int unique); INSERT INTO callback_unique VALUES(7)",
    )
    .unwrap();
    let mut calls = 0;
    let result = admit_then(
        &mut f.db,
        &request(Identity::Anonymous),
        &BOUNDS,
        |tx, _| {
            calls += 1;
            tx.execute("INSERT INTO callback_unique VALUES(7)", &[])
        },
    );
    match result {
        Err(ThenError::Callback(error)) => {
            assert_eq!(error.code(), Some(&SqlState::UNIQUE_VIOLATION));
        }
        other => panic!("expected the callback's unique violation, got {other:?}"),
    }
    assert_eq!(
        calls, 1,
        "a callback's unique violation must not be retried"
    );
    f.assert_clean();
}

#[test]
fn the_participant_number_lock_is_held_through_the_callback_until_commit() {
    let _serial = serial();
    let mut f = Fixture::new();
    let mut first = f.connect();
    let (entered, paused) = mpsc::channel();
    let (release, held) = mpsc::channel::<()>();
    let creator = thread::spawn(move || {
        admit_then(
            &mut first,
            &request(Identity::Anonymous),
            &BOUNDS,
            |_, a| {
                entered.send(()).unwrap();
                held.recv_timeout(Duration::from_secs(5)).unwrap();
                Ok::<_, ()>(a.pid)
            },
        )
    });
    paused.recv_timeout(Duration::from_secs(5)).unwrap();
    // The first creator is inside its callback, its participant written.
    let mut probe = f.connect();
    assert!(
        !probe
            .query_one("SELECT pg_try_advisory_xact_lock(873791983,1)", &[])
            .unwrap()
            .get::<_, bool>(0),
        "the participant-number lock must still be held inside the callback"
    );
    let mut second = f.connect();
    let started = Instant::now();
    let waited = admit_within(&mut second, &request(Identity::Anonymous), &BOUNDS);
    let elapsed = started.elapsed();
    assert_eq!(waited, Err(Error::Unavailable));
    assert!(
        elapsed >= BOUNDS.lock && elapsed < Duration::from_millis(900),
        "the second creator must wait for the lock and give up at its bound: {elapsed:?}"
    );
    release.send(()).unwrap();
    let Ok(Then::Created { admitted, value }) = creator.join().unwrap() else {
        panic!("the paused creator must commit");
    };
    assert_eq!(value, admitted.pid);
    // After the commit the second creator gets the next number.
    let later = admit_within(&mut second, &request(Identity::Anonymous), &BOUNDS)
        .unwrap()
        .unwrap();
    assert_ne!(later.pid, admitted.pid);
    assert_eq!(count(&mut f, "participants"), 2);
}

#[test]
fn the_callback_sees_the_created_ids_and_its_row_commits_with_the_person() {
    let _serial = serial();
    let mut f = Fixture::new();
    with_callback_rows(&mut f);
    let result = admit_then(
        &mut f.db,
        &request(Identity::Anonymous),
        &BOUNDS,
        |tx, a| {
            write_row(tx, a)?;
            // The person's rows are visible to the callback's own statements.
            tx.query_one(
                "SELECT pid FROM participants WHERE zid=1 AND uid=$1",
                &[&a.uid.0],
            )?
            .try_get::<_, i32>(0)
        },
    );
    let Ok(Then::Created { admitted, value }) = result else {
        panic!("expected a created person, got {result:?}");
    };
    assert!(admitted.new_user && admitted.new_participant);
    assert_eq!(value, admitted.pid.0 as i32);
    assert_eq!(f.counts(), vec![4, 1, 1, 0, 0]);
    let row =
        f.db.query_one("SELECT pid, uid FROM callback_rows WHERE zid=1", &[])
            .unwrap();
    assert_eq!(row.get::<_, i32>(0), admitted.pid.0 as i32);
    assert_eq!(row.get::<_, i32>(1), admitted.uid.0);
}

#[test]
fn a_failed_commit_is_commit_unknown_with_the_transaction_id() {
    let _serial = serial();
    let mut f = Fixture::new();
    f.db.batch_execute("CREATE FUNCTION fail_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'commit fault'; END $$; CREATE CONSTRAINT TRIGGER fail_commit AFTER INSERT ON participants DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fail_commit()").unwrap();
    let result = admit_then(&mut f.db, &request(Identity::Anonymous), &BOUNDS, |_, _| {
        Ok::<_, ()>(())
    });
    let Err(ThenError::CommitUnknown { transaction }) = result else {
        panic!("expected an unknown commit, got {result:?}");
    };
    // The id is the one `txid_status` answers about.
    let status: Option<String> =
        f.db.query_one("SELECT txid_status($1)", &[&transaction])
            .unwrap()
            .get(0);
    assert_eq!(status.as_deref(), Some("aborted"));
    f.assert_clean();
}

#[test]
fn an_existing_participant_does_not_run_the_callback_and_nothing_is_written() {
    let _serial = serial();
    let mut f = Fixture::new();
    let member = polis_auth::admission::admit(&mut f.db, &request(Identity::Account(Uid(2))))
        .unwrap()
        .unwrap();
    let before = f.counts();
    let mut calls = 0;
    let result = admit_then(
        &mut f.db,
        &request(Identity::Account(Uid(2))),
        &BOUNDS,
        |_, _| {
            calls += 1;
            Ok::<_, ()>(())
        },
    );
    let Ok(Then::NotCreated(Some(found))) = result else {
        panic!("expected the existing member, got {result:?}");
    };
    assert_eq!((found.uid, found.pid), (member.uid, member.pid));
    assert!(!found.new_user && !found.new_participant);
    // An entry that does not create finds nobody: the callback does not run.
    let mut r = request(Identity::Anonymous);
    r.entry = Entry::Participation {
        create_if_missing: false,
    };
    let nobody = admit_then(&mut f.db, &r, &BOUNDS, |_, _| {
        calls += 1;
        Ok::<_, ()>(())
    });
    assert_eq!(nobody, Ok(Then::NotCreated(None)));
    assert_eq!(calls, 0);
    assert_eq!(f.counts(), before);
}

#[test]
fn the_statement_bound_applies_to_the_callbacks_statements() {
    let _serial = serial();
    let mut f = Fixture::new();
    let bounds = Bounds {
        statement: Duration::from_millis(200),
        ..BOUNDS
    };
    let started = Instant::now();
    let result = admit_then(
        &mut f.db,
        &request(Identity::Anonymous),
        &bounds,
        |tx, _| tx.execute("SELECT pg_sleep(2)", &[]),
    );
    match result {
        Err(ThenError::Callback(error)) => {
            assert_eq!(error.code(), Some(&SqlState::QUERY_CANCELED));
        }
        other => panic!("expected the callback's statement to be cut, got {other:?}"),
    }
    assert!(started.elapsed() < Duration::from_secs(1));
    f.assert_clean();
}

#[test]
fn a_callback_that_swallows_a_statement_error_is_not_reported_as_committed() {
    let _serial = serial();
    let mut f = Fixture::new();
    let result = admit_then(
        &mut f.db,
        &request(Identity::Anonymous),
        &BOUNDS,
        |tx, _| {
            assert!(tx.execute("SELECT 1/0", &[]).is_err());
            Ok::<_, ()>(())
        },
    );
    assert_eq!(result, Err(ThenError::Unavailable));
    f.assert_clean();
}
