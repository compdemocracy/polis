#![allow(clippy::unwrap_used, clippy::expect_used)]
use super::*;
use polis_auth::{Pid, Uid};

fn writer() -> Arc<Writer> {
    let rsa = openssl::rsa::Rsa::generate(2048).unwrap();
    let private = String::from_utf8(rsa.private_key_to_pem().unwrap()).unwrap();
    let public = String::from_utf8(rsa.public_key_to_pem().unwrap()).unwrap();
    let keys = polis_auth::keys::Keys::from_environment(|key| match key {
        "JWT_PRIVATE_KEY" => Some(private.clone().into()),
        "JWT_PUBLIC_KEY" => Some(public.clone().into()),
        _ => None,
    })
    .unwrap();
    let config: postgres::Config = "host=127.0.0.1 port=1 user=unused connect_timeout=1"
        .parse()
        .unwrap();
    let pool = || {
        db::Pool::writer(
            polis_queue_adapter::jobs::transport::Connector::Plain(Box::new(config.clone())),
            limits(1),
        )
    };
    Arc::new(Writer {
        pool: pool(),
        children: pool(),
        crypto: Arc::new(Semaphore::new(CRYPTO_WORKERS)),
        dispatches: Arc::new(Semaphore::new(DISPATCH_LIMIT)),
        verifier: keys.verifier("issuer", "audience").unwrap(),
        keys,
        issuer: "issuer".into(),
        audience: "audience".into(),
        pepper: "pepper".into(),
        fingerprint: b"fingerprint".to_vec(),
        admins: vec![],
    })
}
#[test]
fn both_pepper_chains_preserve_nonempty_precedence_and_source_fallbacks() {
    for (login, encryption, expected_login, expected_fp) in [
        (
            None,
            None,
            "polis_treevite_pepper",
            "polis_treevite_fingerprint_key",
        ),
        (
            Some(""),
            Some(""),
            "polis_treevite_pepper",
            "polis_treevite_fingerprint_key",
        ),
        (
            Some("login"),
            None,
            "login",
            "polis_treevite_fingerprint_key",
        ),
        (None, Some("encrypt"), "encrypt", "encrypt"),
        (Some("login"), Some("encrypt"), "login", "encrypt"),
    ] {
        let actual = peppers(|name| {
            if name == "LOGIN_CODE_PEPPER" {
                login
            } else {
                encryption
            }
            .map(str::to_owned)
        });
        assert_eq!(
            actual,
            (expected_login.into(), expected_fp.as_bytes().to_vec())
        );
    }
    assert_eq!(
        lookup("code", "pepper"),
        "0fbca9e8d7039c97e74bcc142887d6b26d770aeac4cc818da6fd49c2690c3ccc"
    );
}
#[test]
fn sessions_have_node_claim_order_and_exactly_one_day_lifetime() {
    let w = writer();
    let admitted = admission::Admitted {
        uid: Uid(4),
        pid: Pid(0),
        new_user: true,
        new_participant: true,
        invite: Some((1, 1)),
    };
    let auth = sign(&w, "alias", admitted).unwrap();
    assert_eq!(auth.expires_in, 86400);
    let parts: Vec<_> = auth.token.split('.').collect();
    assert_eq!(
        URL_SAFE_NO_PAD.decode(parts[0]).unwrap(),
        br#"{"alg":"RS256","typ":"JWT"}"#
    );
    let payload = URL_SAFE_NO_PAD.decode(parts[1]).unwrap();
    let text = String::from_utf8(payload).unwrap();
    assert!(text.starts_with(r#"{"aud":"audience","iss":"issuer","pid":0,"uid":4,"exp":"#));
    assert!(
        text.ends_with(r#""conversation_id":"alias","sub":"anon:4","anonymous_participant":true}"#)
    );
    let value: serde_json::Value = serde_json::from_str(&text).unwrap();
    let now = value["iat"].as_u64().unwrap();
    assert_eq!(value["exp"].as_u64().unwrap() - now, 86400);
    assert!(
        w.verifier
            .verify(&format!("Bearer {}", auth.token), "alias", now + 86399)
            .is_some()
    );
    assert!(
        w.verifier
            .verify(&format!("Bearer {}", auth.token), "alias", now + 86400)
            .is_none()
    );
}
#[tokio::test]
async fn abandoned_crypto_waiter_does_not_release_its_worker_capacity() {
    let w = writer();
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let (finish_tx, finish_rx) = std::sync::mpsc::channel();
    let w2 = w.clone();
    let task = tokio::spawn(async move {
        w2.crypto(move || {
            started_tx.send(()).unwrap();
            finish_rx.recv().unwrap();
            Ok(())
        })
        .await
    });
    started_rx.await.unwrap();
    task.abort();
    assert_eq!(w.crypto.available_permits(), CRYPTO_WORKERS - 1);
    finish_tx.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(1), async {
        while w.crypto.available_permits() != CRYPTO_WORKERS {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}
#[test]
fn treevite_resources_are_separate_from_participation() {
    let w = writer();
    assert!(!Arc::ptr_eq(&w.pool, &w.children));
    assert_eq!(w.dispatches.available_permits(), 8);
    assert_eq!(w.crypto.available_permits(), 4);
    assert_eq!(DISPATCH_DEADLINE, Duration::from_secs(1));
}
#[test]
fn generator_keeps_node_alphabets_and_bcrypt_cost() {
    let raw = code(LOGIN_ALPHABET, 16);
    assert_eq!(raw.len(), 16);
    assert!(raw.bytes().all(|b| LOGIN_ALPHABET.contains(&b)));
    let hash = bcrypt::hash(&raw, 10).unwrap();
    assert!(hash.starts_with("$2b$10$"));
    assert!(bcrypt::verify(&raw, &hash).unwrap());
    assert!(!bcrypt::verify("invalid", &hash).unwrap());
    let invite = code(INVITE_ALPHABET, 10);
    assert_eq!(invite.len(), 10);
    assert!(invite.bytes().all(|b| INVITE_ALPHABET.contains(&b)));
}

#[tokio::test]
async fn switch_is_off_and_enabled_database_failures_never_hand_back() {
    let w = writer();
    let cfg = config::Config {
        listen: String::new(),
        math_env: "python".into(),
        cache_size: 1,
        dev_mode: false,
        use_network_host: false,
        production: true,
        pool: limits(1),
    };
    let mut app = App::new(&cfg, w.pool.clone());
    let request = || Request {
        method: "POST".into(),
        target: contract::ACCEPT_PATH.into(),
        headers: crate::http::Headers::from_raw([
            ("content-type", "application/json"),
            ("content-length", "48"),
            ("x-forwarded-proto", "https"),
        ]),
        body: br#"{"conversation_id":"fixture","invite_code":"test"}"#.to_vec(),
    };
    assert!(app.treevite_write.is_none());
    assert_eq!(route::handle(Arc::new(app), request()).await.status, 502);
    app = App::new(&cfg, w.pool.clone());
    app.treevite_write = Some(w);
    assert_eq!(route::handle(Arc::new(app), request()).await.status, 503);
}

#[cfg(feature = "db-tests")]
#[path = "../../polis-auth/tests/support/admission.rs"]
mod admission_fixture;

#[cfg(feature = "db-tests")]
#[test]
fn child_wave_topup_is_post_commit_idempotent_and_counts_revoked_codes() {
    let mut f = admission_fixture::Fixture::new();
    let mut r = admission_fixture::request(Identity::Anonymous);
    r.entry = admission_fixture::invite();
    let admitted = admission::admit(&mut f.db, &r).unwrap().unwrap();
    f.db.batch_execute("INSERT INTO treevite_waves(zid,wave,parent_wave,invites_per_user,owner_invites) VALUES(1,2,1,2,0)").unwrap();
    let mut blocker = f.connect();
    let mut held = blocker.transaction().unwrap();
    held.query_one("SELECT pg_advisory_xact_lock(873791983,1)", &[])
        .unwrap();
    let (invite, wave) = admitted.invite.unwrap();
    // Child issuance does not reacquire the participant allocator's lock.
    issue_children(&mut f.db, Zid(1), admitted.pid.0 as i32, wave, invite).unwrap();
    f.db.batch_execute("UPDATE treevite_invites SET status=2 WHERE invite_owner_pid IS NOT NULL")
        .unwrap();
    issue_children(&mut f.db, Zid(1), admitted.pid.0 as i32, wave, invite).unwrap();
    let row=f.db.query_one("SELECT count(*),count(*) FILTER(WHERE status=2) FROM treevite_invites WHERE invite_owner_pid=$1",&[&(admitted.pid.0 as i32)]).unwrap();
    assert_eq!(row.get::<_, i64>(0), 2);
    assert_eq!(row.get::<_, i64>(1), 2);
    held.rollback().unwrap();
}

#[cfg(feature = "db-tests")]
fn database_writer(f: &admission_fixture::Fixture) -> Arc<Writer> {
    let mut w = writer();
    let mut pg: postgres::Config = f.url.parse().unwrap();
    pg.options(&format!("-c search_path={}", f.schema));
    let pool = |size| {
        db::Pool::writer(
            polis_queue_adapter::jobs::transport::Connector::Plain(Box::new(pg.clone())),
            limits(size),
        )
    };
    let inner = Arc::get_mut(&mut w).unwrap();
    inner.pool = pool(8);
    inner.children = pool(2);
    w
}

#[cfg(feature = "db-tests")]
#[test]
fn signing_failure_returns_committed_recovery_and_never_retries_admission() {
    let mut f = admission_fixture::Fixture::new();
    let mut w = database_writer(&f);
    let public = String::from_utf8(
        openssl::rsa::Rsa::generate(2048)
            .unwrap()
            .public_key_to_pem()
            .unwrap(),
    )
    .unwrap();
    Arc::get_mut(&mut w).unwrap().keys = polis_auth::keys::Keys::from_environment(|name| {
        (name == "JWT_PUBLIC_KEY").then(|| public.clone().into())
    })
    .unwrap();
    let receipt = Arc::new(Mutex::new(None));
    let rt = tokio::runtime::Runtime::new().unwrap();
    let result = rt.block_on(dispatch(
        w.clone(),
        Operation::Accept,
        Zid(1),
        "fixture".into(),
        Evidence::Anonymous,
        "invite".into(),
        receipt.clone(),
    ));
    let Ok(contract::Success::Pending(pending)) = result else {
        panic!("committed recovery receipt required")
    };
    assert_eq!(
        pending.error,
        "polis_err_treevite_accepted_token_unavailable"
    );
    assert_eq!(pending.retry, "login_with_saved_code");
    let row =
        f.db.query_one(
            "SELECT login_code_hash,login_code_lookup FROM treevite_login_codes",
            &[],
        )
        .unwrap();
    assert!(bcrypt::verify(&pending.login_code, &row.get::<_, String>(0)).unwrap());
    assert_eq!(
        row.get::<_, String>(1),
        lookup(&pending.login_code, &w.pepper)
    );
    assert!(matches!(
        *receipt.lock().unwrap(),
        Some(contract::Success::Pending(_))
    ));
    let retry = rt.block_on(dispatch(
        w,
        Operation::Accept,
        Zid(1),
        "fixture".into(),
        Evidence::Anonymous,
        "invite".into(),
        Arc::new(Mutex::new(None)),
    ));
    assert!(matches!(
        retry,
        Err(Refused {
            status: 400,
            code: "polis_err_treevite_invalid_or_used_invite"
        })
    ));
    assert_eq!(
        f.db.query_one("SELECT count(*) FROM participants", &[])
            .unwrap()
            .get::<_, i64>(0),
        1
    );
}

#[cfg(feature = "db-tests")]
#[test]
fn dispatched_deadline_is_terminal_and_retains_capacity_until_commit() {
    let mut f = admission_fixture::Fixture::new();
    f.db.batch_execute(
        "CREATE TABLE zinvites(zid int,zinvite text); INSERT INTO zinvites VALUES(1,'fixture')",
    )
    .unwrap();
    let w = database_writer(&f);
    let cfg = config::Config {
        listen: String::new(),
        math_env: "test".into(),
        cache_size: 1,
        dev_mode: false,
        use_network_host: false,
        production: true,
        pool: limits(1),
    };
    let mut app = App::new(&cfg, w.pool.clone());
    app.treevite_write = Some(w.clone());
    let app = Arc::new(app);
    let req = Request {
        method: "POST".into(),
        target: contract::ACCEPT_PATH.into(),
        headers: crate::http::Headers::from_raw([
            ("content-type", "application/json"),
            ("content-length", "48"),
            ("x-forwarded-proto", "https"),
        ]),
        body: br#"{"conversation_id":"fixture","invite_code":"invite"}"#.to_vec(),
    };
    let mut blocker = f.connect();
    let mut tx = blocker.transaction().unwrap();
    tx.query_one("SELECT id FROM treevite_invites WHERE id=1 FOR UPDATE", &[])
        .unwrap();
    let rt = tokio::runtime::Runtime::new().unwrap();
    // Exercise the real outer route dispatch, including its disabled switch.
    let response = rt.block_on(crate::dispatch(app, None, req));
    assert_eq!(response.status, 202);
    let crate::http::Body::Fixed(body) = response.body else {
        panic!("fixed response required")
    };
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&body).unwrap()["acceptance"],
        "unknown"
    );
    assert_eq!(w.dispatches.available_permits(), DISPATCH_LIMIT - 1);
    assert_eq!(
        f.db.query_one("SELECT count(*) FROM participants", &[])
            .unwrap()
            .get::<_, i64>(0),
        0
    );
    tx.commit().unwrap();
    rt.block_on(async {
        tokio::time::timeout(Duration::from_secs(3), async {
            while w.dispatches.available_permits() != DISPATCH_LIMIT {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    });
    assert_eq!(
        f.db.query_one("SELECT count(*) FROM participants", &[])
            .unwrap()
            .get::<_, i64>(0),
        1
    );
    assert_eq!(
        f.db.query_one("SELECT count(*) FROM treevite_login_codes", &[])
            .unwrap()
            .get::<_, i64>(0),
        1
    );
}

#[cfg(feature = "db-tests")]
#[test]
fn saturated_treevite_workers_do_not_use_participation_pool_capacity() {
    let f = admission_fixture::Fixture::new();
    let w = database_writer(&f);
    let participation = database_writer(&f).pool.clone();
    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        let capacity = w
            .dispatches
            .clone()
            .acquire_many_owned(DISPATCH_LIMIT as u32)
            .await
            .unwrap();
        let crypto = w
            .crypto
            .clone()
            .acquire_many_owned(CRYPTO_WORKERS as u32)
            .await
            .unwrap();
        assert!(w.dispatches.clone().try_acquire_owned().is_err());
        assert!(participation.ping().await);
        drop((capacity, crypto));
    });
}

#[test]
fn bcrypt_verifies_node_legacy_utf8_nul_and_truncation_vectors() {
    // bcryptjs cost-10 fixtures, with a fixed generated salt. Lookup still
    // hashes the whole input even when bcrypt truncates it at 72 bytes.
    let vectors = [
        (
            "legacy\0code".to_owned(),
            "$2a$10$abcdefghijklmnopqrstuudvjSPflBXRZOoZqvHqYBj94tXoIKXli",
        ),
        (
            "café😀".to_owned(),
            "$2a$10$abcdefghijklmnopqrstuu2yojgNMTbzTa8W89C4TQW/lMcv3Heg6",
        ),
        (
            "x".repeat(72),
            "$2a$10$abcdefghijklmnopqrstuuhBb/0dYbuuS1CS8hp30IXhlFBW2VAWG",
        ),
        (
            format!("{}tail", "x".repeat(72)),
            "$2a$10$abcdefghijklmnopqrstuuhBb/0dYbuuS1CS8hp30IXhlFBW2VAWG",
        ),
    ];
    for (raw, hash) in vectors {
        for prefix in ["$2a$", "$2b$", "$2y$"] {
            assert!(bcrypt::verify(&raw, &hash.replacen("$2a$", prefix, 1)).unwrap());
        }
    }
    assert_ne!(
        lookup(&"x".repeat(72), "pepper"),
        lookup(&format!("{}tail", "x".repeat(72)), "pepper")
    );
}

#[cfg(feature = "db-tests")]
#[test]
fn child_failure_keeps_the_credential_and_login_repairs_only_missing_codes() {
    let mut f = admission_fixture::Fixture::new();
    f.db.batch_execute("INSERT INTO treevite_waves(id,zid,wave,parent_wave,invites_per_user,owner_invites) VALUES(1002,1,2,1,2,0)").unwrap();
    let w = database_writer(&f);
    let mut blocker = f.connect();
    let mut held = blocker.transaction().unwrap();
    let child: i64 =
        f.db.query_one("SELECT id FROM treevite_waves WHERE wave=2", &[])
            .unwrap()
            .get(0);
    held.query_one("SELECT pg_advisory_xact_lock(hashtextextended(jsonb_build_array('treevite:per-user-codes', $1::bigint, $2::int)::text,0))", &[&child, &0i32]).unwrap();
    let rt = tokio::runtime::Runtime::new().unwrap();
    let result = rt.block_on(dispatch(
        w.clone(),
        Operation::Accept,
        Zid(1),
        "fixture".into(),
        Evidence::Anonymous,
        "invite".into(),
        Arc::new(Mutex::new(None)),
    ));
    let Ok(contract::Success::Accepted(accepted)) = result else {
        panic!("child failure must retain successful acceptance")
    };
    assert_eq!(
        f.db.query_one(
            "SELECT count(*) FROM treevite_invites WHERE invite_owner_pid IS NOT NULL",
            &[]
        )
        .unwrap()
        .get::<_, i64>(0),
        0
    );
    held.rollback().unwrap();
    for _ in 0..2 {
        let login = rt.block_on(dispatch(
            w.clone(),
            Operation::Login,
            Zid(1),
            "fixture".into(),
            Evidence::Anonymous,
            accepted.login_code.clone(),
            Arc::new(Mutex::new(None)),
        ));
        assert!(matches!(login, Ok(contract::Success::LoggedIn(_))));
        assert_eq!(
            f.db.query_one(
                "SELECT count(*) FROM treevite_invites WHERE invite_owner_pid IS NOT NULL",
                &[]
            )
            .unwrap()
            .get::<_, i64>(0),
            2
        );
    }
}

#[cfg(feature = "db-tests")]
#[test]
fn refused_accepts_repair_committed_child_gaps_once() {
    for second_invite in [false, true] {
        let mut f = admission_fixture::Fixture::new();
        f.db.batch_execute("INSERT INTO treevite_waves(id,zid,wave,parent_wave,invites_per_user,owner_invites) VALUES(1003,1,2,1,2,0); INSERT INTO treevite_invites(zid,wave_id,invite_code) VALUES(1,1,'second')").unwrap();
        let mut r = admission_fixture::request(Identity::Anonymous);
        r.entry = admission_fixture::invite();
        // Stop at the acknowledged admission commit, before child expansion.
        let first = admission::admit(&mut f.db, &r).unwrap().unwrap();
        let w = database_writer(&f);
        let rt = tokio::runtime::Runtime::new().unwrap();
        for retry in 0..2 {
            let result = rt.block_on(dispatch(
                w.clone(),
                Operation::Accept,
                Zid(1),
                "fixture".into(),
                if second_invite {
                    Evidence::Participant(first.uid, Zid(1))
                } else {
                    Evidence::Anonymous
                },
                if second_invite { "second" } else { "invite" }.into(),
                Arc::new(Mutex::new(None)),
            ));
            let expected = if second_invite && retry == 0 {
                "polis_err_treevite_login_code_exists"
            } else {
                "polis_err_treevite_invalid_or_used_invite"
            };
            assert!(matches!(result, Err(r) if r.code == expected));
            let count: i64 = f.db.query_one("SELECT count(*) FROM treevite_invites WHERE wave_id=1003 AND invite_owner_pid=$1", &[&(first.pid.0 as i32)]).unwrap().get(0);
            assert_eq!(count, 2);
            f.db.batch_execute("UPDATE treevite_invites SET status=2 WHERE wave_id=1003")
                .unwrap();
        }
    }
}

#[cfg(feature = "db-tests")]
#[test]
fn reconciliation_is_bounded_and_completed_allocations_do_not_starve_gaps() {
    let mut f = admission_fixture::Fixture::new();
    let mut r = admission_fixture::request(Identity::Anonymous);
    r.entry = admission_fixture::invite();
    let first = admission::admit(&mut f.db, &r).unwrap().unwrap();
    f.db.batch_execute("INSERT INTO treevite_waves(id,zid,wave,parent_wave,invites_per_user,owner_invites) SELECT 2000+n,1,n+1,1,2,0 FROM generate_series(1,12) n").unwrap();
    for expected in [20, 24, 24] {
        reconcile_children(&mut f.db, Zid(1), "invite", None).unwrap();
        let count: i64 =
            f.db.query_one(
                "SELECT count(*) FROM treevite_invites WHERE invite_owner_pid=$1",
                &[&(first.pid.0 as i32)],
            )
            .unwrap()
            .get(0);
        assert_eq!(count, expected);
    }
}
