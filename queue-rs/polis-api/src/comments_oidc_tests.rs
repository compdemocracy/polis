use super::*;
use crate::{
    config,
    http::{Body, Headers, Request},
    route::{self, App},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
use serde_json::json;
use std::time::Duration;

fn bytes(out: crate::http::Outgoing) -> Vec<u8> {
    match out.body {
        Body::Fixed(b) => b,
        _ => panic!("expected fixed JSON body"),
    }
}

#[tokio::test]
async fn comments_oidc_existing_subjects_read_plain_lists_without_membership_or_privilege() {
    let url = std::env::var("POLIS_API_TEST_DATABASE_URL").unwrap();
    let schema = format!("comments_oidc_{}", std::process::id());
    let setup_url = url.clone();
    let setup_schema = schema.clone();
    tokio::task::spawn_blocking(move || {
        let mut c = postgres::Client::connect(&setup_url, postgres::NoTls).unwrap();
        c.batch_execute(&format!("CREATE SCHEMA {setup_schema}; SET search_path={setup_schema};
          CREATE TABLE users(uid integer,site_id text);
          CREATE TABLE oidc_user_mappings(uid integer,oidc_sub text);
          CREATE TABLE zinvites(zid integer,zinvite text);
          CREATE TABLE participants(zid integer,uid integer,pid integer);
          CREATE TABLE conversations(zid integer,strict_moderation boolean,owner integer,xid_required boolean,use_xid_whitelist boolean,treevite_enabled boolean);
          CREATE TABLE comments(zid integer,tid integer,txt text,created bigint,quote_src_url text,is_seed boolean,is_meta boolean,lang text,pid integer,original_id uuid,active boolean,velocity real,mod integer);
          INSERT INTO users VALUES(3,'shared'),(4,'shared'),(5,'foreign'),(6,null);
          INSERT INTO oidc_user_mappings VALUES(3,'owner'),(4,'same-site'),(5,'foreign'),(6,'admin');
          INSERT INTO zinvites VALUES(1,'plain'),(2,'restricted');
          INSERT INTO conversations VALUES(1,false,3,false,false,false),(2,true,3,true,true,true);
          INSERT INTO comments SELECT z,0,'visible',10,null,false,false,'en',0,null,true,1,1 FROM generate_series(1,2) z;
          INSERT INTO comments SELECT z,1,'rejected',20,null,false,false,'en',0,null,true,1,-1 FROM generate_series(1,2) z;
          INSERT INTO comments SELECT z,2,'pending',30,null,false,false,'en',0,null,true,1,0 FROM generate_series(1,2) z;")).unwrap();
    }).await.unwrap();
    let limits = db::Limits {
        size: 2,
        acquire_timeout: Duration::from_millis(100),
        statement_timeout: Duration::from_millis(1000),
        max_lifetime: Duration::from_secs(300),
    };
    let make = || {
        let mut pg: postgres::Config = url.parse().unwrap();
        pg.options(&format!("-c search_path={schema}"));
        db::Pool::new(
            polis_queue_adapter::jobs::transport::Connector::Plain(Box::new(pg)),
            limits.clone(),
        )
    };
    let cfg = config::Config {
        listen: String::new(),
        math_env: "test".into(),
        cache_size: 10,
        pca_cache_size: 10,
        pca_cache_bytes: crate::pca::DEFAULT_CACHE_BYTES,
        dev_mode: true,
        use_network_host: false,
        production: true,
        pool: limits.clone(),
    };
    let rsa = openssl::rsa::Rsa::generate(2048).unwrap();
    let key = EncodingKey::from_rsa_pem(&rsa.private_key_to_pem().unwrap()).unwrap();
    let jwks = serde_json::from_value(json!({"keys":[{"kty":"RSA","alg":"RS256","use":"sig","kid":"fixture","n":URL_SAFE_NO_PAD.encode(rsa.n().to_vec()),"e":URL_SAFE_NO_PAD.encode(rsa.e().to_vec())}]})).unwrap();
    let mut app = App::new(&cfg, make());
    app.comments_db = Some(make());
    app.comments_count_db = Some(make());
    app.participant_verifier = Some(Arc::new(
        polis_auth::participant::Verifier::new(
            &rsa.public_key_to_pem().unwrap(),
            "participants",
            "participants",
        )
        .unwrap(),
    ));
    app.read_oidc = Some(Arc::new(Oidc {
        verifier: owner::Verifier::new(jwks, "issuer", "audience").unwrap(),
        namespace: "namespace/".into(),
    }));
    app.legacy_admin_uids = vec![6];
    let app = Arc::new(app);
    let now = (crate::clock::now_ms() / 1000.0) as u64;
    let claims = json!({"sub":"owner","iss":"issuer","aud":"audience","exp":now+300,"email":"fixture@example.invalid"});
    let sign = |v: &Value| {
        let mut header = Header::new(Algorithm::RS256);
        header.kid = Some("fixture".into());
        format!("Bearer {}", encode(&header, v, &key).unwrap())
    };
    let request = |cid: &str, query: &str, token: Option<&str>| Request {
        method: "GET".into(),
        target: format!("/api/v3/comments?conversation_id={cid}{query}"),
        headers: Headers::from_raw(token.map(|s| ("authorization", s))),
        body: vec![],
    };
    for cid in ["plain", "restricted"] {
        for query in [
            "",
            "&limit=0",
            "&limit=-1",
            "&limit=2",
            "&offset=1",
            "&tids=0,2",
            "&moderation=false",
            "&mod=0",
            "&modIn=true",
            "&modIn=false",
            "&mod_gt=0",
            "&include_voting_patterns=true",
            "&unknown=value",
        ] {
            let anonymous = route::handle(app.clone(), request(cid, query, None)).await;
            assert_eq!(anonymous.status, 200);
            let expected = bytes(anonymous);
            for subject in ["owner", "same-site", "foreign", "admin"] {
                let mut c = claims.clone();
                c["sub"] = json!(subject);
                // Untrusted token uid must never select a different local record.
                c["uid"] = json!(999);
                let response =
                    route::handle(app.clone(), request(cid, query, Some(&sign(&c)))).await;
                assert_eq!(response.status, 200, "{subject} {cid} {query}");
                assert_eq!(bytes(response), expected, "{subject} {cid} {query}");
            }
        }
    }
    for (body, query) in [(r#"{"tids":[]}"#, ""), (r#"{"limit":2}"#, "&limit=1")] {
        let mut req = request("plain", query, None);
        req.body = body.as_bytes().to_vec();
        let length = req.body.len().to_string();
        let token = sign(&claims);
        req.headers = Headers::from_raw([
            ("authorization", token.as_str()),
            ("content-type", "application/json"),
            ("content-length", length.as_str()),
        ]);
        let response = route::handle(app.clone(), req).await;
        assert_eq!(response.status, 200);
        let value: Value = serde_json::from_slice(&bytes(response)).unwrap();
        if query.is_empty() {
            assert_eq!(value, json!([]));
        } else {
            assert_eq!(value["pagination"]["limit"], json!(1));
            assert_eq!(value["comments"].as_array().unwrap().len(), 1);
        }
    }
    // Each refusal starts with valid JSON and a verified, mapped caller. The
    // adjacent accepted request proves the body condition is the only refusal.
    let token = sign(&claims);
    let json_request = |query: &str, body: Vec<u8>, length: usize| {
        let mut req = request("plain", query, Some(&token));
        let length = length.to_string();
        req.headers = Headers::from_raw([
            ("authorization", token.as_str()),
            ("content-type", "application/json"),
            ("content-length", length.as_str()),
        ]);
        req.body = body;
        req
    };
    let padded_json = |length: usize| {
        let mut body = b"{}".to_vec();
        body.resize(length, b' ');
        body
    };
    let moderation = route::handle(
        app.clone(),
        request("plain", "&moderation=true", Some(&token)),
    )
    .await;
    assert_eq!(moderation.status, 200);
    for (label, req) in [
        (
            "moderation body",
            json_request("&moderation=true", b"{}".to_vec(), 2),
        ),
        ("short content length", json_request("", b"{}".to_vec(), 1)),
        ("long content length", json_request("", b"{}".to_vec(), 3)),
        (
            "body over 64 KiB",
            json_request("", padded_json(65537), 65537),
        ),
    ] {
        let served = app.served.load(std::sync::atomic::Ordering::Relaxed);
        let participant_served = app
            .participant_served
            .load(std::sync::atomic::Ordering::Relaxed);
        let handed_back = app
            .participant_fallback
            .load(std::sync::atomic::Ordering::Relaxed);
        let pools = [
            &app.db,
            app.comments_db.as_ref().unwrap(),
            app.comments_count_db.as_ref().unwrap(),
        ];
        let before = pools.map(|pool| pool.evidence.snapshot());
        let response = route::handle(app.clone(), req).await;
        assert_eq!(response.status, 502, "{label}");
        // Reads use the 502/plain-text response as their Node hand-back marker.
        assert!(
            response
                .headers
                .iter()
                .any(|(name, value)| name.eq_ignore_ascii_case("content-type")
                    && value == "text/plain; charset=utf-8"),
            "{label}"
        );
        assert_eq!(bytes(response), b"Bad Gateway\n", "{label}");
        assert_eq!(
            app.served.load(std::sync::atomic::Ordering::Relaxed),
            served,
            "{label}"
        );
        assert_eq!(
            app.participant_served
                .load(std::sync::atomic::Ordering::Relaxed),
            participant_served,
            "{label}"
        );
        assert_eq!(
            app.participant_fallback
                .load(std::sync::atomic::Ordering::Relaxed),
            handed_back + 1,
            "{label}"
        );
        assert_eq!(
            pools.map(|pool| pool.evidence.snapshot()),
            before,
            "{label}: refusal must precede database work"
        );
    }
    let expected = bytes(route::handle(app.clone(), request("plain", "", Some(&token))).await);
    for length in [2, 65536] {
        let response =
            route::handle(app.clone(), json_request("", padded_json(length), length)).await;
        assert_eq!(response.status, 200, "accepted body length {length}");
        assert_eq!(bytes(response), expected, "accepted body length {length}");
    }
    let mut disabled = App::new(&cfg, make());
    disabled.comments_db = Some(make());
    disabled.comments_count_db = Some(make());
    disabled.read_oidc = app.read_oidc.clone();
    assert_eq!(
        route::handle(
            Arc::new(disabled),
            request("plain", "", Some(&sign(&claims)))
        )
        .await
        .status,
        502
    );
    for (field, value) in [
        ("sub", json!("missing")),
        ("email", json!(null)),
        ("email", json!(1)),
        ("exp", json!(now)),
        ("iss", json!("wrong")),
        ("xid", json!("other")),
    ] {
        let mut c = claims.clone();
        c[field] = value;
        assert_eq!(
            route::handle(app.clone(), request("plain", "", Some(&sign(&c))))
                .await
                .status,
            502,
            "{field}"
        );
    }
    for query in [
        "&report_id=report",
        "&moderation=true&mod_gt=1",
        "&xid=other",
        "&pid=0",
        "&limit=1&limit=2",
    ] {
        assert_eq!(
            route::handle(app.clone(), request("plain", query, Some(&sign(&claims))))
                .await
                .status,
            502,
            "{query}"
        );
    }
    let pool = app.comments_db.as_ref().unwrap();
    assert_eq!(
        pool.with(|c| Ok(c
            .query_one("SELECT count(*) FROM participants", &[])?
            .get::<_, i64>(0)))
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        pool.with(|c| Ok(c
            .query_one("SELECT count(*) FROM users", &[])?
            .get::<_, i64>(0)))
            .await
            .unwrap(),
        4
    );
    assert_eq!(
        pool.with(|c| Ok(c
            .query_one("SELECT count(*) FROM oidc_user_mappings", &[])?
            .get::<_, i64>(0)))
            .await
            .unwrap(),
        4
    );
    tokio::task::spawn_blocking(move || {
        drop(app);
        let mut c = postgres::Client::connect(&url, postgres::NoTls).unwrap();
        c.batch_execute(&format!("DROP SCHEMA {schema} CASCADE"))
            .unwrap();
    })
    .await
    .unwrap();
}
