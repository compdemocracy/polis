//! Exercise startup and dispatch in a clean process; no manually assembled App.
use super::*;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use postgres::{Client, NoTls};
use serde_json::{Value, json};
use std::{path::PathBuf, process::Command};

// Every optional pool is enabled, including the pools inside writers and refresh.
const SWITCHES: &[&str] = &[
    "POLIS_API_ADMIN_PAGE_READS",
    "POLIS_API_ALL_CONVERSATIONS_READS",
    "POLIS_API_BID_READS",
    "POLIS_API_BID_TO_PID_READS",
    "POLIS_API_COLLECTIVE_STATEMENT_READS",
    "POLIS_API_COMMENT_READS",
    "POLIS_API_CONNECTION_READS",
    "POLIS_API_CONTEXTS_READS",
    "POLIS_API_CONVERSATION_PAGE_READS",
    "POLIS_API_CONVERSATION_PRELOAD_READS",
    "POLIS_API_CONVERSATION_STATS_READS",
    "POLIS_API_DATABASE_READS",
    "POLIS_API_DELPHI_LOGS_READS",
    "POLIS_API_DELPHI_READS",
    "POLIS_API_DELPHI_REPORTS_READS",
    "POLIS_API_DELPHI_RESULT_READS",
    "POLIS_API_DELPHI_RUN_READS",
    "POLIS_API_DELPHI_VISUALIZATIONS_READS",
    "POLIS_API_DOMAIN_WHITELIST_READS",
    "POLIS_API_EINVITES_READ_READS",
    "POLIS_API_INTEGRATE_PAGE_READS",
    "POLIS_API_LEGACY_CONVERSATIONS_READS",
    "POLIS_API_LOCATIONS_READS",
    "POLIS_API_METADATA_ANSWERS_READS",
    "POLIS_API_METADATA_CHOICES_READS",
    "POLIS_API_METADATA_QUERY_READS",
    "POLIS_API_METADATA_QUESTIONS_READS",
    "POLIS_API_METADATA_READS",
    "POLIS_API_MODERATION_COMMENTS_READS",
    "POLIS_API_REPORT_COMMENTS_READS",
    "POLIS_API_MY_INVITES_CSV_READS",
    "POLIS_API_NEXT_COMMENT_READS",
    "POLIS_API_OPS_CATCHALL_READS",
    "POLIS_API_OPS_PAGE_READS",
    "POLIS_API_OPS_WHOAMI_READS",
    "POLIS_API_OWNER_LIST",
    "POLIS_API_PARTICIPANTS_READS",
    "POLIS_API_PARTICIPANT_COMMENTS_READS",
    "POLIS_API_PARTICIPANT_READS",
    "POLIS_API_PARTICIPATION_READS",
    "POLIS_API_PERF_STATS_READS",
    "POLIS_API_POST_TREEVITE_WAVES",
    "POLIS_API_POST_VOTES",
    "POLIS_API_POST_COMMENTS",
    "POLIS_API_PTPTOIS_READS",
    "POLIS_API_RECENT_ACTIVITY_READS",
    "POLIS_API_RECENT_STARTED_READS",
    "POLIS_API_REPORTS_READ_READS",
    "POLIS_API_REPORT_EXPORT_READS",
    "POLIS_API_ROBOTS_READS",
    "POLIS_API_STATEMENT_IMPORTANCE_READS",
    "POLIS_API_TOPIC_PRIORITIZE_READS",
    "POLIS_API_TOPIC_SELECTIONS_READS",
    "POLIS_API_TOPIC_SELECTION_WRITES",
    "POLIS_API_TOPIC_STATS_READS",
    "POLIS_API_TREEVITE_CODE_WRITES",
    "POLIS_API_TREEVITE_CSV_READS",
    "POLIS_API_TREEVITE_INVITES_READS",
    "POLIS_API_TREEVITE_ME_READS",
    "POLIS_API_TREEVITE_MY_INVITES_READS",
    "POLIS_API_TREEVITE_WAVES_READS",
    "POLIS_API_TREEVITE_WRITE",
    "POLIS_API_USERS_READS",
    "POLIS_API_VERSION_READS",
    "POLIS_API_VOTES_FAMOUS_READS",
    "POLIS_API_VOTES_READS",
    "POLIS_API_XID_REPORT_READS",
];
const DATABASES: &[&str] = &[
    "POLIS_API_DATABASE_PROBE_URL",
    "DATABASE_URL",
    "POLIS_API_ALL_CONVERSATIONS_DATABASE_URL",
    "POLIS_API_BID_DATABASE_URL",
    "POLIS_API_BID_TO_PID_DATABASE_URL",
    "POLIS_API_COLLECTIVE_STATEMENT_DATABASE_URL",
    "POLIS_API_COMMENTS_DATABASE_URL",
    "POLIS_API_CONTEXTS_DATABASE_URL",
    "POLIS_API_CONVERSATION_PAGES_DATABASE_URL",
    "POLIS_API_CONVERSATION_PRELOAD_DATABASE_URL",
    "POLIS_API_CONVERSATION_STATS_DATABASE_URL",
    "POLIS_API_DELPHI_DATABASE_URL",
    "POLIS_API_DELPHI_LOGS_AUTH_DATABASE_URL",
    "POLIS_API_DELPHI_LOGS_DATABASE_URL",
    "POLIS_API_DELPHI_NARRATIVES_DATABASE_URL",
    "POLIS_API_DELPHI_REPORTS_DATABASE_URL",
    "POLIS_API_DELPHI_RESULT_AUTH_DATABASE_URL",
    "POLIS_API_DELPHI_RESULT_DATABASE_URL",
    "POLIS_API_DELPHI_RUN_AUTH_DATABASE_URL",
    "POLIS_API_DELPHI_RUN_DATABASE_URL",
    "POLIS_API_DELPHI_TOPICS_DATABASE_URL",
    "POLIS_API_DELPHI_VISUALIZATIONS_DATABASE_URL",
    "POLIS_API_DELPHI_VISUALIZATIONS_RESULTS_DATABASE_URL",
    "POLIS_API_DOMAIN_WHITELIST_DATABASE_URL",
    "POLIS_API_EINVITES_READ_DATABASE_URL",
    "POLIS_API_LEGACY_CONVERSATIONS_DATABASE_URL",
    "POLIS_API_LOCATIONS_DATABASE_URL",
    "POLIS_API_METADATA_ANSWERS_DATABASE_URL",
    "POLIS_API_METADATA_CHOICES_DATABASE_URL",
    "POLIS_API_METADATA_DATABASE_URL",
    "POLIS_API_METADATA_QUERY_DATABASE_URL",
    "POLIS_API_METADATA_QUESTIONS_DATABASE_URL",
    "POLIS_API_MODERATION_COMMENTS_DATABASE_URL",
    "POLIS_API_REPORT_COMMENTS_DATABASE_URL",
    "POLIS_API_MY_INVITES_CSV_DATABASE_URL",
    "POLIS_API_NEXT_COMMENT_DATABASE_URL",
    "POLIS_API_OWNER_DATABASE_URL",
    "POLIS_API_PARTICIPANTS_DATABASE_URL",
    "POLIS_API_PARTICIPANT_COMMENTS_DATABASE_URL",
    "POLIS_API_PARTICIPATION_DATABASE_URL",
    "POLIS_API_POST_TREEVITE_WAVES_DATABASE_URL",
    "POLIS_API_POST_VOTES_DATABASE_URL",
    "POLIS_API_POST_COMMENTS_DATABASE_URL",
    "POLIS_API_PTPTOIS_DATABASE_URL",
    "POLIS_API_RECENT_ACTIVITY_DATABASE_URL",
    "POLIS_API_RECENT_STARTED_DATABASE_URL",
    "POLIS_API_REPORTS_READ_DATABASE_URL",
    "POLIS_API_REPORT_EXPORT_DATABASE_URL",
    "POLIS_API_REVOCATION_DATABASE_URL",
    "POLIS_API_STATEMENT_IMPORTANCE_DATABASE_URL",
    "POLIS_API_TEST_DATABASE_URL",
    "POLIS_API_TOPIC_PRIORITIZE_DATABASE_URL",
    "POLIS_API_TOPIC_SELECTIONS_DATABASE_URL",
    "POLIS_API_TOPIC_SELECTION_WRITES_DATABASE_URL",
    "POLIS_API_TOPIC_STATS_DATABASE_URL",
    "POLIS_API_TREEVITE_CODE_DATABASE_URL",
    "POLIS_API_TREEVITE_CSV_DATABASE_URL",
    "POLIS_API_TREEVITE_INVITES_DATABASE_URL",
    "POLIS_API_TREEVITE_ME_DATABASE_URL",
    "POLIS_API_TREEVITE_MY_INVITES_DATABASE_URL",
    "POLIS_API_TREEVITE_WAVES_DATABASE_URL",
    "POLIS_API_TREEVITE_WRITE_DATABASE_URL",
    "POLIS_API_VOTES_FAMOUS_DATABASE_URL",
    "POLIS_API_VOTES_READ_DATABASE_URL",
    "POLIS_API_XID_REPORT_DATABASE_URL",
    "READ_ONLY_DATABASE_URL",
];

struct Fixture {
    db: Client,
    schema: String,
    keys: PathBuf,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self
            .db
            .batch_execute(&format!("DROP SCHEMA {} CASCADE", self.schema));
        let _ = std::fs::remove_dir_all(&self.keys);
    }
}

#[test]
fn configured_pools_keep_next_statement_separate() {
    const CHILD: &str = "POLIS_API_STARTUP_TEST_CHILD";
    if std::env::var_os(CHILD).is_some() {
        tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(check_startup());
        return;
    }
    let database = std::env::var("POLIS_API_TEST_DATABASE_URL").unwrap();
    let schema = format!("startup_wiring_{}", std::process::id());
    let keys = std::env::temp_dir().join(&schema);
    std::fs::create_dir(&keys).unwrap();
    let mut fixture = Fixture {
        db: Client::connect(&database, NoTls).unwrap(),
        schema,
        keys,
    };
    fixture
        .db
        .batch_execute(&format!(
            r#"
        CREATE SCHEMA {schema}; SET search_path={schema};
        CREATE TABLE zinvites(zid integer,zinvite text);
        CREATE TABLE conversations(zid integer,strict_moderation boolean);
        CREATE TABLE comments(zid integer,tid integer,txt text,created bigint,quote_src_url text,
            is_seed boolean,is_meta boolean,lang text,pid integer,original_id uuid,
            active boolean,velocity real,mod integer);
        CREATE TABLE votes_latest_unique(zid integer,pid integer,tid integer,vote integer);
        CREATE TABLE math_main(zid integer,math_env text,math_tick bigint,data jsonb);
        CREATE TABLE treevite_login_codes(zid integer,pid integer,revoked boolean);
        CREATE FUNCTION get_visible_comments(integer) RETURNS TABLE(tid integer)
            LANGUAGE SQL AS 'select tid from comments where zid=$1 AND active=true AND mod>=0';
        INSERT INTO zinvites VALUES(1,'generated-wiring');
        INSERT INTO conversations VALUES(1,false);
    "#,
            schema = fixture.schema
        ))
        .unwrap();
    let mut url = url::Url::parse(&database).unwrap();
    url.query_pairs_mut()
        .append_pair("options", &format!("-csearch_path={}", fixture.schema));
    let rsa = openssl::rsa::Rsa::generate(2048).unwrap();
    let public = rsa.public_key_to_pem().unwrap();
    let public_path = fixture.keys.join("public.pem");
    let jwks_path = fixture.keys.join("public.json");
    std::fs::write(&public_path, &public).unwrap();
    std::fs::write(
        &jwks_path,
        serde_json::to_vec(&json!({"keys":[{
            "kty":"RSA", "kid":"startup-test", "use":"sig", "alg":"RS256",
            "n":URL_SAFE_NO_PAD.encode(rsa.n().to_vec()),
            "e":URL_SAFE_NO_PAD.encode(rsa.e().to_vec())
        }]}))
        .unwrap(),
    )
    .unwrap();
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args([
            "--exact",
            "startup_wiring_tests::configured_pools_keep_next_statement_separate",
            "--nocapture",
            "--test-threads=1",
        ])
        .env_clear()
        .env(CHILD, "1")
        .env(
            "JWT_PRIVATE_KEY",
            String::from_utf8(rsa.private_key_to_pem().unwrap()).unwrap(),
        )
        .env("JWT_PUBLIC_KEY", String::from_utf8(public).unwrap())
        .env("POLIS_API_PARTICIPANT_PUBLIC_KEY_FILE", &public_path)
        .env("POLIS_API_READ_JWKS_FILE", &jwks_path)
        .env("POLIS_API_OWNER_JWKS_FILE", &jwks_path)
        .envs([
            ("POLIS_API_DB_TRANSPORT", "loopback"),
            ("MATH_ENV", "test"),
            ("POLIS_API_LISTEN", "127.0.0.1:0"),
            ("TOPICAL_COMMENT_RATIO", "0"),
            ("SHOULD_USE_TRANSLATION_API", "false"),
            ("POLIS_JWT_ISSUER", "https://issuer.example"),
            ("POLIS_JWT_AUDIENCE", "test"),
            ("AUTH_ISSUER", "https://issuer.example"),
            ("AUTH_AUDIENCE", "test"),
            ("DELPHI_RESULT_BACKEND", "postgres"),
            ("DELPHI_RESULT_ENV", "test"),
            ("STATIC_FILES_HOST", "127.0.0.1"),
            ("STATIC_FILES_PORT", "9"),
            ("ADMIN_UIDS", "[]"),
            ("NODE_ENV", "production"),
            ("DEV_MODE", "true"),
            ("TZ", "UTC"),
        ]);
    for switch in SWITCHES {
        command.env(switch, "1");
    }
    for database in DATABASES {
        command.env(database, url.as_str());
    }
    let output = command.output().unwrap();
    drop(fixture);
    assert!(
        output.status.success(),
        "startup process failed: {}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

async fn check_startup() {
    let Startup {
        cfg,
        app,
        owner,
        refresh_task,
    } = startup().await.unwrap();
    assert_eq!(cfg.listen, "127.0.0.1:0");
    // The snapshot was loaded by startup. Stop its periodic task before observing
    // request acquisitions so a background refresh cannot change the baseline.
    let task = refresh_task.expect("refresh task configured");
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    let next = app
        .next_comment_db
        .as_ref()
        .expect("next comment configured");
    let mut others = app.startup_pools();
    others.retain(|(name, _)| *name != "next_comment_db");
    for pool in owner.as_ref().expect("owner configured").startup_pools() {
        others.push(("owner", pool));
    }
    for (name, pool) in &others {
        assert!(
            !Arc::ptr_eq(next, pool),
            "next statement shares the {name} pool"
        );
    }
    // The vote writer and the comment handler as this startup built them:
    // three pools each, and no pool of one is a pool of the other.
    let pools_of = |owner: &str| -> Vec<_> {
        others
            .iter()
            .filter(|(name, _)| *name == owner)
            .map(|(_, pool)| *pool)
            .collect()
    };
    let (vote_pools, comment_pools) = (pools_of("post_votes"), pools_of("post_comments"));
    assert_eq!((vote_pools.len(), comment_pools.len()), (3, 3));
    for vote_pool in &vote_pools {
        for comment_pool in &comment_pools {
            assert!(
                !Arc::ptr_eq(vote_pool, comment_pool),
                "the vote writer and the comment handler share a pool"
            );
        }
    }
    let limits: Value = serde_json::from_str(&js::stringify(&next.health(true))).unwrap();
    assert_eq!(
        limits,
        json!({"readOnly":true,"reachable":true,"limit":2,"available":2,
        "acquireTimeoutMs":1,"statementTimeoutMs":50,"maxLifetimeMs":300000})
    );
    let before: Vec<_> = others
        .iter()
        .map(|(_, pool)| pool.evidence.snapshot())
        .collect();
    assert_eq!(next.evidence.snapshot(), [0; 6]);
    let response = dispatch(
        app.clone(),
        owner.clone(),
        request("/api/v3/nextComment?conversation_id=generated-wiring"),
    )
    .await;
    assert_eq!(
        response.status, 200,
        "next statement must execute successfully"
    );
    assert_eq!(body(response), json!({}));
    assert_eq!(next.evidence.snapshot(), [1, 0, 0, 1, 0, 0]);
    for ((name, pool), previous) in others.iter().zip(&before) {
        assert_eq!(
            &pool.evidence.snapshot(),
            previous,
            "next statement acquired {name}"
        );
    }
    let response = dispatch(
        app.clone(),
        owner.clone(),
        request("/api/v3/comments?conversation_id=generated-wiring&limit=1&offset=0"),
    )
    .await;
    assert_eq!(response.status, 200, "comments must execute successfully");
    assert_eq!(
        body(response),
        json!({"comments":[],"pagination":{
        "limit":1,"offset":0,"total":0,"hasMore":false}})
    );
    assert_eq!(
        next.evidence.snapshot(),
        [1, 0, 0, 1, 0, 0],
        "comments acquired the next-statement pool"
    );
    for ((name, pool), previous) in others.iter().zip(before) {
        let acquisitions = match *name {
            "comments_db" => 2,
            "comments_count_db" => 1,
            _ => 0,
        };
        let mut expected = previous;
        expected[0] += acquisitions;
        expected[3] += acquisitions;
        assert_eq!(
            pool.evidence.snapshot(),
            expected,
            "comments acquisition evidence for {name}"
        );
    }
}

fn request(target: &str) -> Request {
    Request {
        method: "GET".into(),
        target: target.into(),
        headers: http::Headers::default(),
        body: vec![],
    }
}
fn body(response: http::Outgoing) -> Value {
    let bytes = match response.body {
        http::Body::Empty => vec![],
        http::Body::Fixed(bytes) => bytes,
        http::Body::Chunked(chunks) => chunks.concat(),
    };
    serde_json::from_slice(&bytes).unwrap()
}
