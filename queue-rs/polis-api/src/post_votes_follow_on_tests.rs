use super::*;

// Exercises the star_deadline case of
// post_commit_failures_and_follow_on_deadline_keep_the_vote_and_retry_receipt,
// with every follow-on made FOLLOW_ON_SLOW_MS x 2 slower by two statements that
// each stay under the reads pool's 100 ms statement bound.
#[test]
fn two_released_slow_follow_ons_both_record_exhaustion() {
    let slow: u64 = std::env::var("FOLLOW_ON_SLOW_MS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(60);
    let db = Database::new("slow_follow_on");
    let (app, mut request) = setup_with_statement_timeout(&db, EVENT_WATCHDOG);
    let mut body: serde_json::Value = serde_json::from_slice(&request.body).unwrap();
    body["starred"] = json!(true);
    request.body = body.to_string().into_bytes();
    let secs = slow as f64 / 1000.0;
    db.connect().batch_execute("CREATE OR REPLACE FUNCTION now_as_millis() RETURNS bigint LANGUAGE sql AS 'SELECT 1700000000000::bigint'").unwrap();
    db.connect()
        .batch_execute(&format!(
            "ALTER TABLE math_main RENAME TO review_math_main;
         CREATE FUNCTION review_slow_math() RETURNS SETOF review_math_main LANGUAGE plpgsql AS
           $$ BEGIN PERFORM pg_sleep({secs}); RETURN QUERY SELECT * FROM review_math_main; END $$;
         CREATE VIEW math_main AS SELECT * FROM review_slow_math();
         CREATE OR REPLACE FUNCTION get_visible_comments(the_zid integer)
           RETURNS TABLE(tid integer, mod integer, strict_moderation boolean)
           LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep({secs}); RETURN; END $$;"
        ))
        .unwrap();
    let mut held_star = Some(SqlGate::new(&db, "stars", "INSERT", 1));
    runtime().block_on(async {
        let first_task = tokio::spawn(handle_after_admission(app.clone(), copy_request(&request)));
        held_star.as_ref().unwrap().entered(&db).await;
        let first = first_task.await.unwrap();
        assert_eq!(first.status, 200);
        let again = handle_after_admission(app.clone(), copy_request(&request)).await;
        assert_eq!(again.status, 200);
        assert!(accepted_body(&again).vote.replayed);
        let start = std::time::Instant::now();
        held_star.take().unwrap().release().await;
        // Both dispatches (star, follow-on, scheduling) must end before the
        // notification lane is drained and the rows are counted.
        wait_for("both dispatches finished", || {
            IN_FLIGHT.load(Ordering::SeqCst) == 0
        })
        .await;
        wait_for_idle(app.post_votes.as_ref().unwrap()).await;
        let events: i64 = app
            .post_votes
            .as_ref()
            .unwrap()
            .reads
            .with(|c| {
                Ok(
                    c.query_one("select count(*) from event_ptpt_no_more_comments", &[])?
                        .get(0),
                )
            })
            .await
            .unwrap();
        eprintln!(
            "REVIEW_FOLLOW_ON slow_ms={slow} events={events} after_release_ms={}",
            start.elapsed().as_millis()
        );
        assert_eq!(events, 2, "both released follow-ons must record exhaustion");
    });
}

#[test]
fn full_follow_on_queue_keeps_vote_admission_and_durable_receipt() {
    let db = Database::new("full_follow_on_queue");
    let (app, request) = setup(&db);
    let lane = app.post_votes.as_ref().unwrap().follow_on.clone();
    let pending = lane
        .pending
        .clone()
        .try_acquire_many_owned(FOLLOW_ON_MAX_PENDING as u32)
        .unwrap();
    runtime().block_on(async {
        let response = handle_after_admission(app.clone(), request).await;
        assert_eq!(response.status, 200);
        assert_eq!(
            accepted_body(&response).follow_on.next_comment,
            FollowOnState::Degraded
        );
        wait_for_idle(app.post_votes.as_ref().unwrap()).await;
    });
    assert_eq!(
        db.connect()
            .query_one("select count(*) from votes", &[])
            .unwrap()
            .get::<_, i64>(0),
        1
    );
    assert_eq!(lane.running.available_permits(), 1);
    drop(pending);
    assert_eq!(lane.pending.available_permits(), FOLLOW_ON_MAX_PENDING);
}

#[test]
fn waiting_follow_on_holds_no_reads_slot_and_releases_capacity_on_cancel() {
    let db = Database::new("waiting_follow_on");
    let (app, _) = setup(&db);
    let writer = app.post_votes.as_ref().unwrap();
    let lane = writer.follow_on.clone();
    runtime().block_on(async {
        let occupied = lane.acquire().await.unwrap();
        let next_lane = lane.clone();
        let waiting = tokio::spawn(async move { next_lane.acquire().await });
        wait_for("follow-on waiting", || {
            lane.pending.available_permits() == FOLLOW_ON_MAX_PENDING - 2
        })
        .await;
        assert_eq!(writer.reads.evidence.snapshot()[2], 0);
        writer
            .reads
            .with(|c| {
                c.simple_query("select 1")?;
                Ok(())
            })
            .await
            .unwrap();
        waiting.abort();
        assert!(waiting.await.unwrap_err().is_cancelled());
        assert_eq!(lane.pending.available_permits(), FOLLOW_ON_MAX_PENDING - 1);
        drop(occupied);
        assert_eq!(lane.pending.available_permits(), FOLLOW_ON_MAX_PENDING);
        assert_eq!(lane.running.available_permits(), 1);
    });
}

#[test]
fn expired_replies_check_exhaustion_without_selection_dependencies() {
    for has_next in [true, false] {
        let db = Database::new(if has_next {
            "expired_remaining"
        } else {
            "expired_exhausted"
        });
        let (app, request) = setup(&db);
        if has_next {
            db.connect().batch_execute("ALTER TABLE comments DISABLE TRIGGER USER;
                INSERT INTO comments(zid,tid,pid,uid,txt,active,velocity,mod) VALUES(1,8,0,1,'Still available',true,1,0);
                ALTER TABLE comments ENABLE TRIGGER USER;").unwrap();
        }
        runtime().block_on(async {
            let writer = app.post_votes.as_ref().unwrap();
            let occupied = writer.follow_on.acquire().await.unwrap();
            let (response, _, observation) = observed_handle_with_completion(app.clone(), request).await;
            assert_eq!(response.status, 200);
            assert_eq!(accepted_body(&response).follow_on.next_comment, FollowOnState::Degraded);
            assert!(!observation.lock().unwrap().finished);
            let config = db.config.clone();
            tokio::task::spawn_blocking(move || {
                config.connect(postgres::NoTls).unwrap().batch_execute(
                    "ALTER TABLE math_main RENAME TO unavailable_math;
                     CREATE FUNCTION unavailable_priorities() RETURNS SETOF unavailable_math LANGUAGE plpgsql AS
                     $$ BEGIN RAISE EXCEPTION 'expired selection must not read priorities'; END $$;
                     CREATE VIEW math_main AS SELECT * FROM unavailable_priorities();
                     CREATE OR REPLACE FUNCTION get_visible_comments(the_zid integer)
                     RETURNS TABLE(tid integer, mod integer, strict_moderation boolean) LANGUAGE plpgsql AS
                     $$ BEGIN RAISE EXCEPTION 'expired selection must not count comments'; END $$;"
                ).unwrap();
            }).await.unwrap();
            drop(occupied);
            wait_for("expired follow-on completed", || observation.lock().unwrap().finished).await;
            wait_for_idle(writer).await;
            let events: i64 = writer.reads.with(|c| Ok(c.query_one("select count(*) from event_ptpt_no_more_comments", &[])?.get(0))).await.unwrap();
            assert_eq!(events, i64::from(!has_next), "expired follow-on must check actual eligibility");
        });
    }
}

#[test]
fn follow_on_lane_drains_expired_then_selects_earliest_live_deadline() {
    let lane = Arc::new(FollowOnLane::default());
    runtime().block_on(async {
        let occupied = lane.acquire().await.unwrap();
        let now = tokio::time::Instant::now();
        let queued = |deadline| {
            let lane = lane.clone();
            tokio::spawn(async move { lane.acquire_until(deadline).await.unwrap() })
        };
        let older = queued(now + Duration::from_secs(10));
        let expired = queued(now - Duration::from_secs(1));
        let newer = queued(now + Duration::from_secs(20));
        wait_for("three waiting follow-ons", || {
            lane.waiting.lock().unwrap().len() == 3
        })
        .await;
        drop(occupied);
        let first = tokio::time::timeout(EVENT_WATCHDOG, expired)
            .await
            .unwrap()
            .unwrap();
        assert!(!older.is_finished());
        assert!(!newer.is_finished());
        drop(first);
        let second = tokio::time::timeout(EVENT_WATCHDOG, older)
            .await
            .unwrap()
            .unwrap();
        assert!(!newer.is_finished());
        drop(second);
        drop(
            tokio::time::timeout(EVENT_WATCHDOG, newer)
                .await
                .unwrap()
                .unwrap(),
        );
        assert!(lane.waiting.lock().unwrap().is_empty());
        assert_eq!(lane.pending.available_permits(), FOLLOW_ON_MAX_PENDING);
        assert_eq!(lane.running.available_permits(), 1);
    });
}

#[test]
fn exhaustion_uses_candidate_visibility_and_the_participants_votes() {
    let db = Database::new("exhaustion_filters");
    let (app, _) = setup(&db);
    let mut c = db.connect();
    c.batch_execute(
        "ALTER TABLE comments DISABLE TRIGGER USER;
        INSERT INTO comments(zid,tid,pid,uid,txt,active,velocity,mod)
        VALUES(1,7,0,1,'Candidate',true,1,0);
        ALTER TABLE comments ENABLE TRIGGER USER;",
    )
    .unwrap();
    let a = database::actor();
    for (update, expected) in [
        ("UPDATE comments SET active=true,velocity=1,mod=0", false),
        ("UPDATE comments SET active=false", true),
        ("UPDATE comments SET active=true,velocity=0", true),
        ("UPDATE comments SET velocity=1,mod=-1", true),
        (
            "UPDATE comments SET mod=0; UPDATE conversations SET strict_moderation=true",
            true,
        ),
        ("UPDATE comments SET mod=1", false),
    ] {
        c.batch_execute(update).unwrap();
        assert_eq!(exhausted(&mut c, &a).unwrap(), expected, "{update}");
    }
    append(&mut c, &a, &database::fields(VoteChoice::Agree)).unwrap();
    assert!(exhausted(&mut c, &a).unwrap());
    let mut other = a.clone();
    other.pid = 1;
    assert!(!exhausted(&mut c, &other).unwrap());
    drop(app);
}

#[test]
fn earliest_deadline_starts_without_waiting_for_expiry() {
    use std::{future::Future, task::Poll};
    let lane = Arc::new(FollowOnLane::default());
    runtime().block_on(async {
        let occupied = lane.acquire().await.unwrap();
        let expires = tokio::time::Instant::now() + Duration::from_secs(10);
        let mut older = Box::pin(lane.acquire_until(expires));
        let mut newer = Box::pin(lane.acquire_until(expires + Duration::from_secs(10)));
        std::future::poll_fn(|cx| {
            assert!(older.as_mut().poll(cx).is_pending());
            assert!(newer.as_mut().poll(cx).is_pending());
            Poll::Ready(())
        })
        .await;
        drop(occupied);
        std::future::poll_fn(|cx| {
            assert!(newer.as_mut().poll(cx).is_pending());
            Poll::Ready(())
        })
        .await;
        let first = tokio::time::timeout(Duration::from_secs(1), older)
            .await
            .unwrap()
            .unwrap();
        assert!(tokio::time::Instant::now() < expires);
        drop(first);
        drop(
            tokio::time::timeout(Duration::from_secs(1), newer)
                .await
                .unwrap()
                .unwrap(),
        );
        assert_eq!(lane.pending.available_permits(), FOLLOW_ON_MAX_PENDING);
    });
}

#[test]
fn selection_estimate_sheds_only_unfinishable_work_and_expires() {
    let lane = FollowOnLane::default();
    let now = tokio::time::Instant::now();
    assert!(!lane.can_finish(now));
    assert!(lane.can_finish(now + Duration::from_secs(10)));
    lane.record_selection(Duration::from_secs(2));
    assert!(!lane.can_finish(now + Duration::from_secs(1)));
    assert!(lane.can_finish(now + Duration::from_secs(10)));
    let mut estimate = lane.selection.lock().unwrap();
    assert_eq!(estimate.unwrap().1, Duration::from_millis(2500));
    estimate.as_mut().unwrap().0 = now - DISPATCH_DEADLINE;
    drop(estimate);
    assert!(lane.can_finish(now + Duration::from_secs(1)));
}

#[test]
fn unfinishable_live_reply_checks_exhaustion_without_selection() {
    let db = Database::new("unfinishable_live");
    let (app, request) = setup(&db);
    runtime().block_on(async {
        let writer = app.post_votes.as_ref().unwrap();
        // The deadline is still live, but recent selection work cannot fit.
        writer.follow_on.record_selection(Duration::from_secs(2));
        let (response, _, observation) =
            observed_handle_with_completion(app.clone(), request).await;
        assert_eq!(response.status, 200);
        assert_eq!(
            accepted_body(&response).follow_on.next_comment,
            FollowOnState::Degraded
        );
        assert!(!observation.lock().unwrap().selection_started);
        wait_for_idle(writer).await;
        let events: i64 = writer
            .reads
            .with(|c| {
                Ok(
                    c.query_one("select count(*) from event_ptpt_no_more_comments", &[])?
                        .get(0),
                )
            })
            .await
            .unwrap();
        assert_eq!(
            events, 1,
            "live work that cannot finish must still record exhaustion"
        );
    });
}
