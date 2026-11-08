use super::*;

#[test]
fn populated_priorities_admit_three_votes_and_another_conversation() {
    let db = Database::exclusive("priority_capacity");
    let (mut app, _) = setup(&db);
    let rsa = openssl::rsa::Rsa::generate(2048).unwrap();
    let key = EncodingKey::from_rsa_pem(&rsa.private_key_to_pem().unwrap()).unwrap();
    Arc::get_mut(&mut app)
        .unwrap()
        .post_votes
        .as_mut()
        .unwrap()
        .verifier =
        participant::Verifier::new(&rsa.public_key_to_pem().unwrap(), "fixture", "fixture")
            .unwrap();
    db.connect().batch_execute("INSERT INTO users(uid) VALUES(2),(3),(4),(5);
        INSERT INTO conversations(zid,is_active,modified) VALUES(2,true,0);
        INSERT INTO zinvites(zid,zinvite) VALUES(2,'3fixture');
        ALTER TABLE participants DISABLE TRIGGER USER;
        INSERT INTO participants(zid,pid,uid,nsli) VALUES(1,1,2,0),(1,2,3,0),(1,3,4,0),(2,0,5,0);
        ALTER TABLE participants ENABLE TRIGGER USER;
        ALTER TABLE comments DISABLE TRIGGER USER;
        INSERT INTO comments(zid,tid,pid,uid,txt,lang,created)
        SELECT 1,t,0,1,'Generated statement '||t,'en',1700000000000+t FROM generate_series(0,20000) t;
        INSERT INTO comments(zid,tid,pid,uid,txt,lang,created) VALUES(2,0,0,5,'Other conversation','en',10);
        ALTER TABLE comments ENABLE TRIGGER USER;
        INSERT INTO math_main(zid,math_env,math_tick,last_vote_timestamp,data)
        SELECT 1,'test',0,0,jsonb_build_object('comment-priorities',jsonb_object_agg(t::text,1.25)) FROM generate_series(0,19999) t;
        ANALYZE comments; ANALYZE participants;").unwrap();
    let now = (crate::clock::now_ms() / 1000.0) as u64;
    let request = |uid: i32, pid: i32, cid: &str, tid: i32| {
        let token = encode(&Header::new(Algorithm::RS256), &json!({
            "uid":uid,"pid":pid,"conversation_id":cid,"sub":format!("anon:{uid}"),
            "iss":"fixture","aud":"fixture","exp":now+3600,"iat":now,"anonymous_participant":true
        }), &key).unwrap();
        let mut r = req(
            &json!({"conversation_id":cid,"tid":tid,"vote":VoteChoice::Agree.wire()}).to_string(),
        );
        r.headers = Headers::from_raw([
            ("host", "localhost"),
            ("content-type", "application/json"),
            ("x-forwarded-proto", "https"),
            ("authorization", &format!("Bearer {token}")),
        ]);
        r
    };
    let requests = (2..=4)
        .map(|uid| request(uid, uid - 1, "2fixture", 20000))
        .collect::<Vec<_>>();
    runtime().block_on(async {
        use std::{future::Future, time::Instant};
        let mut pending = Vec::new();
        let mut observations = Vec::new();
        for r in requests {
            let app = app.clone();
            let observation = DispatchObservation::default();
            observations.push(observation.clone());
            pending.push(tokio::spawn(async move {
                let mut call = Box::pin(route::handle(app, r));
                std::future::poll_fn(|cx| observing_dispatch(&observation, || call.as_mut().poll(cx))).await
            }));
        }
        let overlapping = || observations.iter().filter(|o| {
            let o = o.lock().unwrap();
            o.receipt.as_ref().is_some_and(|r| r.lock().unwrap().is_some()) && !o.finished
        }).count();
        wait_for("two committed follow-ons or refused leaders", || overlapping() >= 2 || pending.iter().all(|p|p.is_finished())).await;
        let active = overlapping();
        let fourth_observation = DispatchObservation::default();
        let mut fourth = Box::pin(route::handle(app.clone(), request(5,0,"3fixture",0)));
        let start = Instant::now();
        let mut admission = None;
        let fourth = std::future::poll_fn(|cx| {
            let result = observing_dispatch(&fourth_observation, || fourth.as_mut().poll(cx));
            if fourth_observation.lock().unwrap().created && admission.is_none() { admission = Some(start.elapsed()); }
            result
        }).await;
        let mut statuses = Vec::new();
        for task in pending { statuses.push(task.await.unwrap().status); }
        wait_for_idle(app.post_votes.as_ref().unwrap()).await;
        let evidence = app.post_votes.as_ref().unwrap().reads.evidence.snapshot();
        eprintln!("populated priorities: statuses={statuses:?} reads={evidence:?} follow_ons={active} fourth={} admission={admission:?}", fourth.status);
        assert_eq!(statuses, vec![200,200,200], "all populated-priority votes must be admitted and stored");
        assert!(active >= 2, "fourth request must overlap two committed follow-ons");
        assert_eq!(fourth.status,200);
        assert!(admission.unwrap() < ADMISSION_DEADLINE);
    });
    let mut c = db.connect();
    assert_eq!(
        c.query_one("SELECT count(*) FROM votes", &[])
            .unwrap()
            .get::<_, i64>(0),
        4
    );
    assert_eq!(
        c.query_one("SELECT count(*) FROM votes_latest_unique", &[])
            .unwrap()
            .get::<_, i64>(0),
        4
    );
    for (zid, pid) in [(1, 1), (1, 2), (1, 3), (2, 0)] {
        let row = c
            .query_one(
                "SELECT vote FROM votes WHERE zid=$1 AND pid=$2",
                &[&zid, &pid],
            )
            .unwrap();
        assert_eq!(
            i32::from(row.get::<_, i16>(0)),
            contract::stored_vote(VoteChoice::Agree)
        );
    }
}

#[cfg(feature = "db-tests")]
#[test]
fn generation_reads_revalidate_without_reparsing_and_isolate_conversations() {
    use crate::post_votes::writer_priorities::Cache;
    let db = Database::new("priority_generations");
    let mut c = db.connect();
    c.batch_execute("INSERT INTO conversations(zid,is_active,modified) VALUES(1,true,0),(2,true,0); INSERT INTO math_main(zid,math_env,math_tick,last_vote_timestamp,data)
            VALUES(1,'test',0,0,'{\"comment-priorities\":{\"0\":2}}'),(2,'test',0,0,'{\"comment-priorities\":{\"0\":3}}');").unwrap();
    let cache = Arc::new(Cache::default());
    let first = cache
        .snapshot(&mut c, 1, "test")
        .unwrap()
        .validate()
        .unwrap();
    let same = cache
        .snapshot(&mut c, 1, "test")
        .unwrap()
        .validate()
        .unwrap();
    assert!(Arc::ptr_eq(&first, &same));
    assert_eq!(first.select(&[0], 0.5).unwrap().1, 1.0);
    assert_eq!(
        cache
            .snapshot(&mut c, 2, "test")
            .unwrap()
            .validate()
            .unwrap()
            .select(&[0], 0.5)
            .unwrap()
            .1,
        1.5
    );
    c.batch_execute(
        "UPDATE math_main SET math_tick=1,data='{\"comment-priorities\":{\"0\":4}}' WHERE zid=1",
    )
    .unwrap();
    let next = cache
        .snapshot(&mut c, 1, "test")
        .unwrap()
        .validate()
        .unwrap();
    assert!(!Arc::ptr_eq(&first, &next));
    assert_eq!(next.select(&[0], 0.5).unwrap().1, 2.0);
    c.batch_execute("UPDATE math_main SET math_tick=-1 WHERE zid=1")
        .unwrap();
    assert_eq!(
        cache
            .snapshot(&mut c, 1, "test")
            .unwrap()
            .validate()
            .unwrap()
            .select(&[0], 0.5)
            .unwrap()
            .1,
        0.5
    );
}

#[cfg(not(debug_assertions))]
fn sustained_fixture(c: &mut Client, size: i32, participants: usize) {
    let last_priority = size.saturating_sub(1);
    c.batch_execute(&format!(
        "ALTER TABLE comments DISABLE TRIGGER USER;
        INSERT INTO comments(zid,tid,pid,uid,txt,lang,created)
        SELECT 1,t,0,1,'Generated statement ' || t,'en',1700000000000+t
        FROM generate_series(0,{size}) t ORDER BY t;
        ALTER TABLE comments ENABLE TRIGGER USER;
        INSERT INTO users(uid) SELECT u FROM generate_series(2,{n}) u;
        ALTER TABLE participants DISABLE TRIGGER USER;
        INSERT INTO participants(zid,pid,uid,nsli) SELECT 1,u-1,u,0 FROM generate_series(2,{n}) u;
        ALTER TABLE participants ENABLE TRIGGER USER;
        INSERT INTO math_main(zid,math_env,math_tick,last_vote_timestamp,data)
        SELECT 1,'test',0,0,jsonb_build_object('comment-priorities',jsonb_object_agg(t::text,0.5+(t%101)::double precision/107)) FROM generate_series(0,{last_priority}) t;
        ANALYZE comments; ANALYZE participants; ANALYZE users;",
        n = participants + 1
    ))
    .unwrap();
}

// Throughput is measured with optimized selection, as in the deployed binary.
// The local/hosted check entry point runs this release-only test explicitly.
#[cfg(not(debug_assertions))]
#[test]
fn sustained_votes_keep_delivering_next_statements_above_lane_capacity() {
    // Judge the queue by this run's own full selections, not a machine's
    // absolute speed. At least 80% must reach their waiting participant in
    // each steady-state arrival cohort; selecting nothing cannot pass.
    let size: i32 = 20_000;
    let rate = 80.0;
    let seconds = 8.0;
    let total = 640;
    let db = Database::exclusive("sustained_follow_on");
    let (mut app, _) = setup(&db);
    let rsa = openssl::rsa::Rsa::generate(2048).unwrap();
    let key = EncodingKey::from_rsa_pem(&rsa.private_key_to_pem().unwrap()).unwrap();
    Arc::get_mut(&mut app)
        .unwrap()
        .post_votes
        .as_mut()
        .unwrap()
        .verifier =
        participant::Verifier::new(&rsa.public_key_to_pem().unwrap(), "fixture", "fixture")
            .unwrap();
    sustained_fixture(&mut db.connect(), size, total);
    let now = (crate::clock::now_ms() / 1000.0) as u64;
    let tokens: Vec<String> = (2..=(total as i32 + 1))
        .map(|uid| {
            encode(
                &Header::new(Algorithm::RS256),
                &json!({"uid":uid,"pid":uid-1,"conversation_id":"2fixture","sub":format!("anon:{uid}"),
                    "iss":"fixture","aud":"fixture","exp":now+3600,"iat":now,"anonymous_participant":true}),
                &key,
            )
            .unwrap()
        })
        .collect();
    runtime().block_on(async {
        let writer = app.post_votes.as_ref().unwrap();
        let cache = writer.priorities.clone();
        let snap = writer
            .reads
            .with({
                let cache = cache.clone();
                move |c| cache.snapshot(c, 1, "test")
            })
            .await
            .unwrap();
        let _lease = tokio::task::spawn_blocking(move || snap.validate())
            .await
            .unwrap()
            .unwrap();
        let start = tokio::time::Instant::now();
        let mut tasks = Vec::new();
        for (id, token) in tokens.iter().enumerate() {
            let at = start + Duration::from_secs_f64(id as f64 / rate);
            tokio::time::sleep_until(at).await;
            let mut r = req(
                &json!({"conversation_id":"2fixture","tid":size,"vote":VoteChoice::Agree.wire()})
                    .to_string(),
            );
            r.headers = Headers::from_raw([
                ("host", "localhost"),
                ("content-type", "application/json"),
                ("x-forwarded-proto", "https"),
                ("authorization", &format!("Bearer {token}")),
            ]);
            let app = app.clone();
            let second = (id as f64 / rate) as usize;
            tasks.push(tokio::spawn(async move {
                let sent = std::time::Instant::now();
                use std::future::Future;
                let observation = DispatchObservation::default();
                let mut call = Box::pin(route::handle(app, r));
                let out = std::future::poll_fn(|cx| observing_dispatch(&observation, || call.as_mut().poll(cx))).await;
                (second, out, sent.elapsed().as_secs_f64() * 1000.0, observation)
            }));
        }
        let mut rows = std::collections::BTreeMap::<usize, [usize; 5]>::new();
        let mut late = Vec::new();
        let mut observations = Vec::new();
        for task in tasks {
            let (second, out, ms, observation) = task.await.unwrap();
            observations.push((second, observation));
            let row = rows.entry(second).or_default();
            match out.status {
                200 => match accepted_body(&out).follow_on.next_comment {
                    FollowOnState::Complete => {
                        assert!(accepted_body(&out).next_comment.is_some());
                        row[0] += 1;
                    },
                    FollowOnState::Degraded => row[1] += 1,
                    _ => row[2] += 1,
                },
                502 => row[3] += 1,
                _ => row[4] += 1,
            }
            late.push(ms);
        }
        let finished_at = start.elapsed().as_secs_f64();
        wait_for("rate drained", || IN_FLIGHT.load(Ordering::SeqCst) == 0).await;
        let drained_at = start.elapsed().as_secs_f64();
        late.sort_by(f64::total_cmp);
        let mut selections = std::collections::BTreeMap::<usize, usize>::new();
        for (second, observation) in observations {
            *selections.entry(second).or_default() += usize::from(observation.lock().unwrap().selection_started);
        }
        let per_second: Vec<_> = rows
            .iter()
            .map(|(s, r)| json!({"second": s, "complete": r[0], "full_selections": selections[s], "degraded": r[1], "absent": r[2], "handed_back": r[3], "other": r[4]}))
            .collect();
        let sum = |i: usize| rows.values().map(|r| r[i]).sum::<usize>();
        println!(
            "SUSTAINED_FOLLOW_ON {}",
            json!({"size": size, "rate_per_s": rate, "seconds": seconds, "votes": total,
                "complete": sum(0), "degraded": sum(1), "absent": sum(2), "handed_back": sum(3), "other": sum(4),
                "response_p50_ms": late[late.len()/2], "response_max_ms": late[late.len()-1],
                "last_reply_s": finished_at, "lane_drained_s": drained_at, "per_second": per_second})
        );
        let stored: i64 = writer
            .reads
            .with(|c| Ok(c.query_one("select count(*) from votes", &[])?.get(0)))
            .await
            .unwrap();
        println!("SUSTAINED_STORED {stored}");
        assert_eq!(stored as usize, total, "every vote must be stored");
        assert_eq!(sum(3), 0, "no vote may be handed back");
        assert_eq!(sum(4), 0, "every vote must have a durable 200 receipt");
        assert_eq!(sum(2), 0, "eligible comments remain for every participant");
        let stored_agree = contract::stored_vote(VoteChoice::Agree) as i16;
        let (latest, correct) = writer.reads.with(move |c| {
            Ok((c.query_one("select count(*) from votes_latest_unique", &[])?.get::<_, i64>(0),
                c.query_one("select count(*) from votes where vote=$1", &[&stored_agree])?.get::<_, i64>(0)))
        }).await.unwrap();
        assert_eq!(latest as usize, total);
        assert_eq!(correct as usize, total);
        for second in 3..8 {
            let full = selections[&second];
            assert!(full > 0, "second {second}: the lane must perform full selections");
            assert!(rows[&second][0] * 5 >= full * 4,
                "second {second}: {} of {full} full selections reached the participant; floor is 80%", rows[&second][0]);
        }
    });
}
