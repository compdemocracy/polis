//! A stalled comment insert does not delay a vote.
//!
//! The comment handler and the vote writer run in one process and write to
//! one database. They share no pool (each has its own writer, admission and
//! notification pools), no in-process queue or lane, and no database lock: a
//! comment takes the conversation's comment-number lock, which a vote never
//! takes. This test holds that lock so that every connection of the comment
//! handler's insert pool is stuck inside an insert, in the conversation the
//! votes are cast in, and then casts votes through the real route. Each vote
//! must be stored and answered without once waiting for a connection.
use super::*;
use crate::post_comments::tests::database as comments;

#[test]
fn stalled_comment_inserts_do_not_delay_votes() {
    let db = Database::exclusive("comment_isolation");
    db.connect()
        .batch_execute(
            "INSERT INTO users(uid) VALUES(1);
             INSERT INTO conversations(zid,is_active,modified) VALUES(1,true,0);
             INSERT INTO zinvites(zid,zinvite) VALUES(1,'2fixture');
             ALTER TABLE participants DISABLE TRIGGER USER;
             INSERT INTO participants(zid,pid,uid,nsli) VALUES(1,0,1,3);
             ALTER TABLE participants ENABLE TRIGGER USER;",
        )
        .unwrap();
    // The comment-number trigger that holds its lock to commit, as every
    // migrated database has it. With the older trigger, which released the
    // lock before the commit, the four comments released together at the end
    // of this test could be given the same number, and one would fail.
    db.connect()
        .batch_execute(include_str!(
            "../../../server/postgres/migrations/000042_tid_auto_transaction_lock.sql"
        ))
        .unwrap();
    db.connect()
        .batch_execute(comments::PATIENT_INSERTS)
        .unwrap();
    let rsa = openssl::rsa::Rsa::generate(2048).unwrap();
    let public = rsa.public_key_to_pem().unwrap();
    let key = EncodingKey::from_rsa_pem(&rsa.private_key_to_pem().unwrap()).unwrap();
    let now = (crate::clock::now_ms() / 1000.0) as u64;
    let token = encode(
        &Header::new(Algorithm::RS256),
        &json!({
            "uid":1,"pid":0,"conversation_id":"2fixture","sub":"anon:1",
            "iss":"fixture","aud":"fixture","exp":now+3600,"iat":now,
            "anonymous_participant":true
        }),
        &key,
    )
    .unwrap();
    let connector = || Connector::Plain(Box::new(db.config.clone()));
    let limits = db::Limits {
        size: 4,
        acquire_timeout: Duration::from_millis(100),
        statement_timeout: Duration::from_secs(1),
        max_lifetime: Duration::from_secs(300),
    };
    let cfg = config::Config {
        listen: String::new(),
        math_env: "test".into(),
        cache_size: 10,
        pca_cache_size: 10,
        pca_cache_bytes: crate::pca::DEFAULT_CACHE_BYTES,
        dev_mode: false,
        use_network_host: false,
        production: true,
        pool: limits.clone(),
    };
    let mut app = App::new(&cfg, db::Pool::new(connector(), read_limits()));
    // The vote writer with its production bounds.
    app.post_votes = Some(Writer {
        pool: db::Pool::writer(connector(), limits.clone()),
        reads: db::Pool::new(connector(), read_limits()),
        background: NotificationPool::new(db::Pool::writer(
            connector(),
            db::Limits { size: 2, ..limits },
        )),
        verifier: participant::Verifier::new(&public, "fixture", "fixture").unwrap(),
        admins: vec![],
        priorities: Arc::default(),
        follow_on: Arc::new(FollowOnLane::default()),
    });
    // The comment handler, with only its statement bound lifted so that an
    // insert held at the comment-number lock stays held.
    app.post_comments = Some(comments::writer_on(
        &db.config,
        &public,
        vec![],
        comments::patient_insert_limits(),
    ));
    let app = Arc::new(app);
    let request = |body: serde_json::Value, path: &str| {
        let mut request = req(&body.to_string());
        request.target = path.into();
        request.headers = Headers::from_raw([
            ("host", "localhost"),
            ("content-type", "application/json"),
            ("x-forwarded-proto", "https"),
            ("authorization", &format!("Bearer {token}")),
        ]);
        request
    };
    let vote = |tid: i32| {
        request(
            json!({"conversation_id":"2fixture","tid":tid,"vote":crate::votes::WIRE_AGREE}),
            PATH,
        )
    };
    let comment = |n: usize| {
        request(
            json!({"conversation_id":"2fixture","txt":format!("Generated stalled comment {n}")}),
            crate::post_comments::PATH,
        )
    };
    let rt = runtime();
    rt.block_on(async {
        let votes = app.post_votes.as_ref().unwrap();
        let [comment_inserts, comment_reads, comment_background] =
            app.post_comments.as_ref().unwrap().startup_pools();
        // No pool of either is a pool of the other.
        for mine in [&votes.pool, &votes.reads, &votes.background.pool] {
            for theirs in [comment_inserts, comment_reads, comment_background] {
                assert!(!Arc::ptr_eq(mine, theirs));
            }
        }
        warm_pool(&votes.reads, 2).await;
        warm_pool(&votes.pool, 4).await;
        warm_pool(&votes.background.pool, 2).await;
        warm_pool(comment_inserts, 4).await;
        warm_pool(comment_reads, 2).await;
        // A control vote, before anything is stalled.
        let started = tokio::time::Instant::now();
        let control = route::handle(app.clone(), vote(100)).await;
        let control_time = started.elapsed();
        assert_eq!(control.status, 200);

        // Another writer holds the conversation's comment-number lock; four
        // comments then fill the comment handler's insert pool, each inside
        // its insert.
        let holder_config = db.config.clone();
        let mut holder = tokio::task::spawn_blocking(move || {
            comments::hold_comment_number_lock(&holder_config, 1)
        })
        .await
        .unwrap();
        let stalled: Vec<_> = (0..4)
            .map(|n| tokio::spawn(route::handle(app.clone(), comment(n))))
            .collect();
        wait_for_sql(
            &db,
            "select count(*) = 4 from pg_locks where locktype = 'advisory' and not granted".into(),
        )
        .await;
        let available = |pool: &Arc<db::Pool>| {
            serde_json::from_str::<serde_json::Value>(&js::stringify(&pool.health(true))).unwrap()
                ["available"]
                .as_u64()
                .unwrap()
        };
        assert_eq!(available(comment_inserts), 0, "every comment insert slot is held");

        // Votes in the same conversation, while the inserts stay stalled.
        let before = [
            votes.pool.evidence.snapshot(),
            votes.reads.evidence.snapshot(),
        ];
        let mut times = vec![];
        for tid in 0..12 {
            let started = tokio::time::Instant::now();
            let response = route::handle(app.clone(), vote(tid)).await;
            times.push(started.elapsed());
            assert_eq!(response.status, 200, "vote {tid} while comments are stalled");
            let body = accepted_body(&response);
            assert_eq!(body.vote.tid, tid);
            assert!(!body.vote.replayed);
            assert_eq!(available(comment_inserts), 0, "a comment insert slot was freed");
        }
        for (name, pool, before) in [
            ("writer", &votes.pool, before[0]),
            ("reads", &votes.reads, before[1]),
        ] {
            let after = pool.evidence.snapshot();
            assert_eq!(after[1], before[1], "a vote waited for a {name} connection");
            assert_eq!(after[2], before[2], "a vote timed out acquiring {name}");
            assert_eq!(after[4], before[4], "a vote's {name} work failed");
        }
        let stored_config = db.config.clone();
        let stored = tokio::task::spawn_blocking(move || {
            let mut c = stored_config.connect(postgres::NoTls).unwrap();
            let votes: i64 = c
                .query_one("select count(*) from votes where zid = 1 and pid = 0", &[])
                .unwrap()
                .get(0);
            let comments: i64 = c
                .query_one("select count(*) from comments where zid = 1", &[])
                .unwrap()
                .get(0);
            (votes, comments)
        })
        .await
        .unwrap();
        assert_eq!(stored, (13, 0), "every vote is stored; no comment is yet");
        assert_eq!(
            wait_for_count(&db, "select count(*) from pg_locks where locktype = 'advisory' and not granted").await,
            4,
            "the comment inserts are still waiting"
        );
        let message = format!(
            "comment isolation: ASSERTED; control_vote={control_time:?}; votes_with_4_stalled_comment_inserts={times:?}\n"
        );
        std::io::Write::write_all(&mut std::io::stdout(), message.as_bytes()).unwrap();

        // Released, the comments are stored: nothing was lost on either side.
        tokio::task::spawn_blocking(move || holder.batch_execute("ROLLBACK").unwrap())
            .await
            .unwrap();
        for task in stalled {
            // Answered at the reply deadline or after the insert; never a
            // hand-back once the insert was dispatched.
            assert_ne!(task.await.unwrap().status, 502);
        }
        wait_for_sql(&db, "select count(*) = 4 from comments where zid = 1".into()).await;
        wait_for("comment notification work", || {
            available(comment_background) == 2 && available(comment_inserts) == 4
        })
        .await;
        wait_for_idle(votes).await;
    });
    drop(app);
    drop(rt);
}

async fn wait_for_count(db: &Database, sql: &'static str) -> i64 {
    let config = db.config.clone();
    tokio::task::spawn_blocking(move || {
        let mut c = config.connect(postgres::NoTls).unwrap();
        c.query_one(sql, &[]).unwrap().get(0)
    })
    .await
    .unwrap()
}
