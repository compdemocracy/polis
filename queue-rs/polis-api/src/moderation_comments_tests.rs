use super::*;
use crate::{config::Config, db::Pool, http::Headers};
use std::sync::Arc;

#[test]
fn visibility_projection_and_pagination_on_postgres() {
    let url = std::env::var("POLIS_API_TEST_DATABASE_URL").unwrap();
    let mut c = postgres::Client::connect(&url, postgres::NoTls).unwrap();
    c.batch_execute("CREATE TEMP TABLE comments(zid integer,tid integer,txt text,is_meta boolean,velocity real,mod integer,active boolean);
        INSERT INTO comments VALUES
        (1,0,'accepted',true,0.1,1,true),(1,1,'pending',false,1,0,true),
        (1,2,'rejected',false,0,-1,false),(1,3,NULL,NULL,NULL,1,NULL),
        (1,4,'hidden',false,-1,1,false),(1,5,'null mod',false,1,NULL,true),
        (2,6,'foreign',false,1,1,true);").unwrap();
    let mut query = contract::Request {
        conversation_id: "fixture".into(),
        r#mod: 1,
        limit: 50,
        offset: 0.0,
    };
    for (status, expected) in [(0, vec![1]), (1, vec![0, 3, 4]), (-1, vec![2])] {
        query.r#mod = status;
        let body = read(&mut c, 1, &query).unwrap();
        assert_eq!(
            body.comments.iter().map(|c| c.tid).collect::<Vec<_>>(),
            expected
        );
        assert_eq!(body.pagination.total, expected.len() as i64);
        assert!(!body.pagination.has_more);
    }
    query.r#mod = 1;
    query.limit = 1;
    let first = read(&mut c, 1, &query).unwrap();
    assert_eq!(
        encode(&first).unwrap(),
        r#"{"comments":[{"txt":"accepted","tid":0,"is_meta":true,"velocity":0.1,"mod":1,"active":true,"conversation_id":"fixture"}],"pagination":{"limit":1,"offset":0,"total":3,"hasMore":true}}"#
    );
    query.offset = 1.0;
    assert_eq!(read(&mut c, 1, &query).unwrap().comments[0].txt, None);
    query.offset = 3.0;
    let empty = read(&mut c, 1, &query).unwrap();
    assert!(empty.comments.is_empty());
    assert_eq!(empty.pagination.total, 3);
    assert!(!empty.pagination.has_more);
    for offset in [2_147_483_648.0, 9_007_199_254_740_992.0] {
        query.offset = offset;
        let page = read(&mut c, 1, &query).unwrap();
        assert!(page.comments.is_empty());
        assert_eq!(page.pagination.offset, offset as i64);
        assert!(!page.pagination.has_more);
    }
}

#[tokio::test]
async fn authority_precedes_every_list_pool_acquisition() {
    use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
    let url = std::env::var("POLIS_API_TEST_DATABASE_URL").unwrap();
    let schema = format!("moderation_comments_test_{}", std::process::id());
    let setup_url = url.clone();
    let setup_schema = schema.clone();
    tokio::task::spawn_blocking(move || {
        let mut c = postgres::Client::connect(&setup_url, postgres::NoTls).unwrap();
        c.batch_execute(&format!(
            "CREATE SCHEMA {setup_schema}; SET search_path={setup_schema};
            CREATE TABLE users(uid integer,site_id text);
            CREATE TABLE conversations(zid integer,owner integer,treevite_enabled boolean);
            CREATE TABLE participants(zid integer,uid integer,pid integer);
            CREATE TABLE zinvites(zid integer,zinvite text);
            INSERT INTO users VALUES(1,'site'),(2,'site'),(3,'other'),(4,NULL),(5,NULL);
            INSERT INTO conversations VALUES(1,1,false),(2,4,false);
            INSERT INTO zinvites VALUES(1,'fixture'),(2,'nullsite');
            INSERT INTO participants SELECT 1,n,n FROM generate_series(1,5)n;
            INSERT INTO participants VALUES(2,4,4);"
        ))
        .unwrap();
        // Exact Node predicate, including its NULL-site owner behavior.
        for (uid, zid, expected) in [
            (1, 1, true),
            (2, 1, true),
            (3, 1, false),
            (4, 2, false),
            (5, 1, true),
        ] {
            assert_eq!(
                crate::treevite_read::permits(&mut c, zid, polis_auth::Uid(uid), &[5]).unwrap(),
                expected
            );
        }
    })
    .await
    .unwrap();
    let mut pg: postgres::Config = url.parse().unwrap();
    pg.options(&format!("-c search_path={schema}"));
    let pool = || {
        Pool::new(
            polis_queue_adapter::jobs::transport::Connector::Plain(Box::new(pg.clone())),
            pool_limits(),
        )
    };
    let cfg = Config {
        listen: String::new(),
        math_env: "test".into(),
        cache_size: 1,
        dev_mode: true,
        use_network_host: false,
        production: true,
        pool: pool_limits(),
    };
    let mut app = App::new(&cfg, pool());
    app.moderation_comments_db = Some(pool());
    app.moderation_comments_auth_db = Some(pool());
    app.legacy_admin_uids = vec![5];
    let rsa = openssl::rsa::Rsa::generate(2048).unwrap();
    let key = EncodingKey::from_rsa_pem(&rsa.private_key_to_pem().unwrap()).unwrap();
    app.participant_verifier = Some(Arc::new(
        polis_auth::participant::Verifier::new(
            &rsa.public_key_to_pem().unwrap(),
            "issuer",
            "participants",
        )
        .unwrap(),
    ));
    let app = Arc::new(app);
    let sign = |uid, cid: &str| {
        let now = (crate::clock::now_ms() / 1000.0) as u64;
        format!("Bearer {}", encode(&Header::new(Algorithm::RS256), &serde_json::json!({"uid":uid,"pid":uid,"sub":format!("anon:{uid}"),"conversation_id":cid,"iss":"issuer","aud":"participants","iat":now,"exp":now+300,"anonymous_participant":true}), &key).unwrap())
    };
    // This schema intentionally has no comments table: only authorized calls
    // may reach it. Pool evidence also detects attempts before a failed query.
    for (uid, token_cid, target_cid) in [
        (0, "fixture", "fixture"),
        (3, "fixture", "fixture"),
        (1, "other", "fixture"),
        (4, "nullsite", "nullsite"),
    ] {
        let auth = sign(uid, token_cid);
        let headers = if uid == 0 {
            vec![("host", "localhost")]
        } else {
            vec![("host", "localhost"), ("authorization", auth.as_str())]
        };
        let response = route::handle(
            app.clone(),
            Request {
                method: "GET".into(),
                target: format!("{PATH}?conversation_id={target_cid}&mod=0&limit=50&offset=0"),
                headers: Headers::from_raw(headers),
                body: vec![],
            },
        )
        .await;
        assert_eq!(response.status, 403);
        assert_eq!(
            app.moderation_comments_db
                .as_ref()
                .unwrap()
                .evidence
                .snapshot(),
            [0; 6]
        );
    }
    for uid in [1, 2, 5] {
        let auth = sign(uid, "fixture");
        let response = route::handle(
            app.clone(),
            Request {
                method: "GET".into(),
                target: format!("{PATH}?conversation_id=fixture&mod=0&limit=50&offset=0"),
                headers: Headers::from_raw([
                    ("host", "localhost"),
                    ("authorization", auth.as_str()),
                ]),
                body: vec![],
            },
        )
        .await;
        assert_eq!(response.status, 502); // authorized, deliberately absent statement table
    }
    assert_eq!(
        app.moderation_comments_db
            .as_ref()
            .unwrap()
            .evidence
            .snapshot()[0],
        3
    );
    drop(app);
    tokio::task::spawn_blocking(move || {
        let mut c = postgres::Client::connect(&url, postgres::NoTls).unwrap();
        c.batch_execute(&format!("DROP SCHEMA {schema} CASCADE"))
            .unwrap();
    })
    .await
    .unwrap();
}

fn parsed(tail: &str) -> Result<contract::Request, ParseError> {
    parse_query(&format!("conversation_id=fixture&{tail}"))
}

#[test]
fn pagination_defaults_and_clamp_follow_node() {
    let omitted = parsed("mod=0&limit=50").unwrap();
    assert_eq!((omitted.limit, omitted.offset), (50, 0.0));
    for value in ["0", "-1", "-2", "-2147483649"] {
        let q = parsed(&format!("mod=0&limit={value}&offset={value}")).unwrap();
        assert_eq!((q.limit, q.offset), (50, 0.0));
    }
    for value in ["501", "2147483648", "9007199254740992"] {
        let q = parsed(&format!("mod=0&limit={value}&offset={value}")).unwrap();
        assert_eq!(q.limit, 500);
        assert_eq!(q.offset, value.parse::<f64>().unwrap());
    }
}

#[test]
fn integer_prefixes_follow_node_in_all_three_parameters() {
    for value in [
        "1.5",
        "01",
        "%2B1",
        "1abc",
        "%20%091.9",
        "%EF%BB%BF1",
        "1e9",
    ] {
        let q = parsed(&format!("mod={value}&limit={value}&offset={value}")).unwrap();
        assert_eq!((q.r#mod, q.limit, q.offset), (1, 1, 1.0), "{value}");
    }
    let q = parsed("mod=-0&limit=0x10&offset=-0").unwrap();
    assert_eq!((q.r#mod, q.limit, q.offset), (0, 50, 0.0));
    // JavaScript rounds the integer prefix before PostgreSQL sees it.
    assert_eq!(
        parsed("mod=0&limit=50&offset=9007199254740993")
            .unwrap()
            .offset,
        9_007_199_254_740_992.0
    );
}

#[test]
fn malformed_and_duplicated_supported_parameters_are_bad_requests() {
    for key in ["mod", "limit", "offset"] {
        for value in ["", "abc", "%20", "+", "--1", ".5", "Infinity", "NaN"] {
            let q = "mod=0&limit=50&offset=0".replace(
                &format!("{key}={}", if key == "limit" { "50" } else { "0" }),
                &format!("{key}={value}"),
            );
            assert_eq!(parsed(&q), Err(ParseError::BadRequest), "{key}={value}");
        }
        for suffix in [
            format!("{key}=1"),
            format!("{key}[]=1"),
            format!("{key}[x]=1"),
        ] {
            assert_eq!(
                parsed(&format!("mod=0&limit=50&offset=0&{suffix}")),
                Err(ParseError::BadRequest)
            );
        }
    }
    for raw in [
        "mod=0&limit=50",
        "conversation_id=fixture&conversation_id=fixture&mod=0",
    ] {
        assert_eq!(parse_query(raw), Err(ParseError::BadRequest));
    }
}

#[test]
fn omitted_limit_or_mod_is_outside_the_typed_domain() {
    for tail in ["mod=0&offset=0", "limit=50&offset=0", "offset=0"] {
        assert_eq!(parsed(tail), Err(ParseError::Handback));
    }
}

#[test]
fn numeric_mod_outside_the_typed_domain_is_a_handback() {
    for value in ["-2", "2", "2147483648", "-2147483649", "9007199254740992"] {
        assert_eq!(
            parsed(&format!("mod={value}&limit=50&offset=0")),
            Err(ParseError::Handback)
        );
    }
}

#[tokio::test]
async fn malformed_query_returns_node_bytes_without_pool_acquisition() {
    let limits = pool_limits();
    let pool = Pool::new(
        polis_queue_adapter::jobs::transport::Connector::Plain(Box::new(
            "postgres://localhost:1/unused".parse().unwrap(),
        )),
        limits.clone(),
    );
    let cfg = Config {
        listen: String::new(),
        math_env: "test".into(),
        cache_size: 1,
        dev_mode: true,
        use_network_host: false,
        production: true,
        pool: limits,
    };
    let mut app = App::new(&cfg, pool.clone());
    app.moderation_comments_db = Some(pool.clone());
    app.moderation_comments_auth_db = Some(pool.clone());
    let app = Arc::new(app);
    for (method, body) in [
        ("GET", b"Bad Request\n".as_slice()),
        ("HEAD", b"".as_slice()),
    ] {
        for tail in [
            "mod=abc&limit=50",
            "mod=0&limit=abc",
            "mod=0&offset=abc",
            "mod=0&mod=1",
            "mod=0&limit=1&limit=2",
            "mod=0&offset=1&offset=2",
        ] {
            let response = route::handle(
                app.clone(),
                Request {
                    method: method.into(),
                    target: format!("{PATH}?conversation_id=fixture&{tail}"),
                    headers: Headers::from_raw([("host", "localhost")]),
                    body: vec![],
                },
            )
            .await;
            assert_eq!(response.status, 400);
            let wire =
                crate::http::write_response(&response, method == "HEAD", false, "fixture date")
                    .unwrap();
            let split = wire.windows(4).position(|w| w == b"\r\n\r\n").unwrap() + 4;
            assert_eq!(&wire[split..], body);
            for (name, value) in [
                ("Content-Type", "text/html; charset=utf-8"),
                ("Content-Length", "12"),
                ("X-Content-Type-Options", "nosniff"),
            ] {
                assert!(
                    response
                        .headers
                        .iter()
                        .any(|(k, v)| k.eq_ignore_ascii_case(name) && v == value)
                );
            }
        }
    }
    // These omissions select Node's unbounded or all-state list. Neither may
    // acquire even the identity pool on the bounded, single-state typed route.
    for tail in ["mod=0&offset=0", "limit=50&offset=0", "offset=0"] {
        let response = route::handle(
            app.clone(),
            Request {
                method: "GET".into(),
                target: format!("{PATH}?conversation_id=fixture&{tail}"),
                headers: Headers::from_raw([("host", "localhost")]),
                body: vec![],
            },
        )
        .await;
        assert_eq!(response.status, 502);
        let wire = crate::http::write_response(&response, false, false, "fixture date").unwrap();
        assert!(wire.ends_with(b"\r\n\r\nBad Gateway\n"));
    }
    assert_eq!(pool.evidence.snapshot(), [0; 6]);
}
