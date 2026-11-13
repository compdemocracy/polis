//! Observe mode and the shadow role. The vote writer runs on a copy of a vote
//! Node is answering: it admits and selects exactly as live, writes nothing,
//! answers 204 before any database work and prints one line per copy.
//!
//! Every valid fixture vote is written through `append`, the writer's own
//! sign-aware path (the vote-sign rules); no vote value is ever logged.
#![allow(clippy::unwrap_used, clippy::expect_used)]
#[cfg(feature = "db-tests")]
use super::database::{Database, actor};
use super::*;
#[cfg(feature = "db-tests")]
use crate::http::Body;
use crate::{shadow, votes::VoteChoice};
use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
use polis_queue_adapter::jobs::transport::Connector;
use serde_json::{Value, json};
use std::process::Command;

/// The observation line's complete key set (design section 2).
const LINE_KEYS: &[&str] = &[
    "message",
    "listener",
    "service",
    "env",
    "shadow",
    "route",
    "request_id",
    "outcome",
    "admitted",
    "status",
    "reason",
    "queue_ms",
    "admission_ms",
    "selection_ms",
    "total_ms",
    "readback_s",
    "zid",
    "starred_present",
    "lang_present",
    "append",
    "follow_on",
    "remaining",
    "total",
    "candidates",
    "weights_tick",
    "prev",
    "node_vote",
];

struct Signing {
    public: Vec<u8>,
    private: EncodingKey,
    pem: String,
}

fn signing() -> Signing {
    let rsa = openssl::rsa::Rsa::generate(2048).unwrap();
    Signing {
        public: rsa.public_key_to_pem().unwrap(),
        private: EncodingKey::from_rsa_pem(&rsa.private_key_to_pem().unwrap()).unwrap(),
        pem: String::from_utf8(rsa.public_key_to_pem().unwrap()).unwrap(),
    }
}

fn token(keys: &Signing, cid: &str) -> String {
    let now = (crate::clock::now_ms() / 1000.0) as u64;
    encode(
        &Header::new(Algorithm::RS256),
        &json!({
            "uid":1,"pid":0,"conversation_id":cid,"sub":"anon:1",
            "iss":"fixture","aud":"fixture","exp":now+3600,"iat":now,
            "anonymous_participant":true
        }),
        &keys.private,
    )
    .unwrap()
}

fn request_id() -> String {
    format!("{:032x}", rand::random::<u128>())
}

fn vote_body(cid: &str, tid: i32, choice: VoteChoice) -> Value {
    json!({"conversation_id": cid, "tid": tid, "vote": choice.wire()})
}

/// A request as nginx's mirror sends it to the shadow service.
fn copy(body: &Value, token: Option<&str>, id: &str) -> Request {
    let auth = token.map(|t| format!("Bearer {t}"));
    let mut headers = vec![
        ("host", "localhost"),
        ("content-type", "application/json"),
        ("x-forwarded-proto", "https"),
        ("x-request-id", id),
        ("x-polis-shadow", "votesShadow"),
    ];
    if let Some(auth) = auth.as_deref() {
        headers.push(("authorization", auth));
    }
    Request {
        method: "POST".into(),
        target: PATH.into(),
        headers: crate::http::Headers::from_raw(headers),
        body: body.to_string().into_bytes(),
    }
}

fn cfg(dev_mode: bool) -> config::Config {
    config::Config {
        listen: String::new(),
        math_env: "test".into(),
        cache_size: 10,
        pca_cache_size: 10,
        pca_cache_bytes: crate::pca::DEFAULT_CACHE_BYTES,
        dev_mode,
        use_network_host: false,
        production: true,
        pool: read_limits(),
    }
}

fn closed() -> Connector {
    Connector::Plain(Box::new("postgresql://u@127.0.0.1:1/d".parse().unwrap()))
}

fn observer_on(connector: impl Fn() -> Connector, public: &[u8]) -> Observer {
    Observer::new(
        participant::Verifier::new(public, "fixture", "fixture").unwrap(),
        db::Pool::new(connector(), read_limits()),
        db::Pool::new(connector(), observe::readback_limits()),
        vec![],
        Arc::default(),
    )
}

fn shadow_app(connector: impl Fn() -> Connector, observer: Option<Observer>) -> Arc<App> {
    let mut app = App::new(&cfg(false), db::Pool::new(connector(), read_limits()));
    app.post_votes_observe = observer;
    Arc::new(app)
}

/// The keys of a printed line in their printed order. The values of these
/// lines are flat (no nested objects), so a key is a quoted word then a colon
/// at object depth one.
fn printed_keys(line: &str) -> Vec<String> {
    let value: Value = serde_json::from_str(line).unwrap();
    let mut keys: Vec<(usize, String)> = value
        .as_object()
        .unwrap()
        .keys()
        .map(|key| (line.find(&format!("\"{key}\":")).unwrap(), key.clone()))
        .collect();
    keys.sort();
    keys.into_iter().map(|(_, key)| key).collect()
}

fn observation_line(id: &str) -> Option<Value> {
    let marker = format!("\"request_id\":\"{id}\"");
    let line = shadow::recorded()
        .into_iter()
        .find(|line| line.contains(&marker) && line.contains("\"shadow_observation\""))?;
    assert_eq!(
        printed_keys(&line),
        LINE_KEYS,
        "observation keys in their order"
    );
    Some(serde_json::from_str(&line).unwrap())
}

async fn observation(id: &str) -> Value {
    tokio::time::timeout(Duration::from_secs(60), async {
        loop {
            if let Some(line) = observation_line(id) {
                return line;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("no observation line for {id}"))
}

/// No key of the line names a statement: not the one a copy votes on, not the
/// one that would be served next.
fn assert_names_no_statement(line: &Value) {
    for key in line.as_object().unwrap().keys() {
        assert!(
            key != "tid" && !key.ends_with("_tid") && !key.contains("statement"),
            "{key} names a statement: {line}"
        );
    }
}

fn assert_line_shape(line: &Value) {
    let mut keys: Vec<&str> = line
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    let mut expected = LINE_KEYS.to_vec();
    keys.sort_unstable();
    expected.sort_unstable();
    assert_eq!(keys, expected, "observation keys");
    assert_names_no_statement(line);
    assert_eq!(line["message"], "shadow_observation");
    assert_eq!(line["listener"], "shadow");
    assert_eq!(line["service"], "polis-api-shadow");
    assert_eq!(line["shadow"], "votesShadow");
    assert_eq!(line["route"], "POST /api/v3/votes");
    assert_eq!(line["append"], "not_modelled");
}

// ---------------------------------------------------------------- startup

const CHILD: &str = "POLIS_SHADOW_STARTUP_CHILD";

fn describe(result: Result<Configured>) -> String {
    match result {
        Ok(Configured::Off) => "off".into(),
        Ok(Configured::Live(_)) => "live".into(),
        Ok(Configured::Observe(observer)) => {
            let pools = observer
                .startup_pools()
                .iter()
                .map(|(name, pool)| {
                    let health: Value =
                        serde_json::from_str(&crate::js::stringify(&pool.health(false))).unwrap();
                    format!("{name}:{}", health["readOnly"])
                })
                .collect::<Vec<_>>()
                .join(",");
            // Identity observation, when its switch is on, has a pool of its
            // own; without it the answer is the two pools above.
            let identity = observer
                .identity
                .as_deref()
                .map(|identity| {
                    identity
                        .startup_pools()
                        .iter()
                        .map(|(name, pool)| {
                            let health: Value =
                                serde_json::from_str(&crate::js::stringify(&pool.health(false)))
                                    .unwrap();
                            format!(" {name}:{}", health["readOnly"])
                        })
                        .collect::<String>()
                })
                .unwrap_or_default();
            format!("observe {pools}{identity}")
        }
        Err(error) => format!("err {error:#}"),
    }
}

/// Runs one startup scenario in a clean process, so no test changes the
/// environment of another. The parent reads the one result line.
#[test]
fn startup_child() {
    let Ok(scenario) = std::env::var(CHILD) else {
        return;
    };
    let keys = polis_auth::keys::Keys::from_env_optional().unwrap();
    let role = shadow::role();
    let result = match scenario.as_str() {
        "main" => describe(configure(shadow::Role::Main, keys.as_ref())),
        "shadow" => describe(configure(shadow::Role::Shadow, keys.as_ref())),
        "role" => format!("{role:?}"),
        "writer-pools" => {
            let before = db::WRITER_POOLS_BUILT.load(Ordering::SeqCst);
            let mode = describe(configure(
                if std::env::var("POLIS_API_ROLE").ok().as_deref() == Some("shadow") {
                    shadow::Role::Shadow
                } else {
                    shadow::Role::Main
                },
                keys.as_ref(),
            ));
            let built = db::WRITER_POOLS_BUILT.load(Ordering::SeqCst) - before;
            format!("{mode} writer_pools_built={built}")
        }
        "verify" => {
            let token = std::env::var("FIXTURE_TOKEN").unwrap();
            let verified = |verifier: &participant::Verifier| {
                verifier
                    .verify(
                        &format!("Bearer {token}"),
                        "2fixture",
                        (crate::clock::now_ms() / 1000.0) as u64,
                    )
                    .is_some()
            };
            let role = if std::env::var("POLIS_API_ROLE").ok().as_deref() == Some("shadow") {
                shadow::Role::Shadow
            } else {
                shadow::Role::Main
            };
            match configure(role, keys.as_ref()) {
                Ok(Configured::Live(writer)) => {
                    format!("live verified={}", verified(&writer.verifier))
                }
                Ok(Configured::Observe(observer)) => {
                    format!("observe verified={}", verified(&observer.verifier))
                }
                other => describe(other),
            }
        }
        "shadow-app" => match shadow::configure() {
            Ok(configured) => format!(
                "ok observer={} writer={} comments={} next={} participant_reads={}",
                configured.app.post_votes_observe.is_some(),
                configured.app.post_votes.is_some(),
                configured.app.comments_db.is_some(),
                configured.app.next_comment_db.is_some(),
                configured.app.participant_verifier.is_some(),
            ),
            Err(error) => format!("err {error:#}"),
        },
        other => panic!("unknown scenario {other}"),
    };
    println!("CHILD-RESULT {result}");
}

fn child(scenario: &str, env: &[(&str, &str)]) -> String {
    let output = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "post_votes::tests::observe_tests::startup_child",
            "--nocapture",
            "--test-threads=1",
        ])
        .env_clear()
        .env(CHILD, scenario)
        .envs(env.iter().copied())
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        output.status.success(),
        "{scenario} {env:?}\n{stdout}\n{}",
        String::from_utf8_lossy(&output.stderr)
    );
    stdout
        .lines()
        .find_map(|line| line.split_once("CHILD-RESULT ").map(|(_, result)| result))
        .unwrap_or_else(|| panic!("no result for {scenario}: {stdout}"))
        .to_owned()
}

struct KeyFile {
    dir: std::path::PathBuf,
    path: String,
}
impl KeyFile {
    fn new(label: &str, keys: &Signing) -> Self {
        let dir = std::env::temp_dir().join(format!("shadow-{label}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("public.pem");
        std::fs::write(&path, &keys.public).unwrap();
        Self {
            path: path.to_string_lossy().into_owned(),
            dir,
        }
    }
}
impl Drop for KeyFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// The writer's startup environment, without its participant key.
fn writer_env(switch: &str) -> Vec<(&'static str, String)> {
    vec![
        ("POLIS_API_POST_VOTES", switch.into()),
        ("TOPICAL_COMMENT_RATIO", "0".into()),
        ("SHOULD_USE_TRANSLATION_API", "false".into()),
        (
            "POLIS_API_POST_VOTES_DATABASE_URL",
            "postgres://postgres@127.0.0.1:9/postgres".into(),
        ),
        ("POLIS_API_DB_TRANSPORT", "loopback".into()),
        ("POLIS_JWT_ISSUER", "fixture".into()),
        ("POLIS_JWT_AUDIENCE", "fixture".into()),
    ]
}

fn run(scenario: &str, env: &[(&'static str, String)]) -> String {
    let env: Vec<(&str, &str)> = env.iter().map(|(k, v)| (*k, v.as_str())).collect();
    child(scenario, &env)
}

fn with(
    mut env: Vec<(&'static str, String)>,
    key: &'static str,
    value: Option<&str>,
) -> Vec<(&'static str, String)> {
    env.retain(|(k, _)| *k != key);
    if let Some(value) = value {
        env.push((key, value.into()));
    }
    env
}

/// Test 4. Observe mode builds exactly the two read-only pools and never a
/// writer pool. The live writer in the same environment builds its two.
#[test]
fn observe_mode_builds_no_writer_pool() {
    let keys = signing();
    let file = KeyFile::new("pools", &keys);
    let observe = with(
        with(writer_env("observe"), "POLIS_API_ROLE", Some("shadow")),
        "POLIS_API_PARTICIPANT_PUBLIC_KEY_FILE",
        Some(&file.path),
    );
    assert_eq!(
        run("writer-pools", &observe),
        "observe reads:true,readback:true writer_pools_built=0"
    );
    let live = with(
        writer_env("1"),
        "POLIS_API_PARTICIPANT_PUBLIC_KEY_FILE",
        Some(&file.path),
    );
    assert_eq!(run("writer-pools", &live), "live writer_pools_built=2");
}

/// The identity switch: unset, empty or 0 leaves observe mode exactly as it
/// is, with its two pools; `observe` adds one read-only pool and no writer;
/// another value stops the shadow role; it is refused without the vote
/// observer; and the main role never reads it.
#[test]
fn the_identity_switch_adds_one_read_only_pool_in_the_shadow_role_only() {
    let keys = signing();
    let file = KeyFile::new("identity", &keys);
    let shadow_env = |votes: &str, identity: Option<&str>| {
        with(
            with(
                with(writer_env(votes), "POLIS_API_ROLE", Some("shadow")),
                "POLIS_API_PARTICIPANT_PUBLIC_KEY_FILE",
                Some(&file.path),
            ),
            "POLIS_API_POST_VOTES_IDENTITY",
            identity,
        )
    };
    for off in [None, Some(""), Some("0")] {
        assert_eq!(
            run("writer-pools", &shadow_env("observe", off)),
            "observe reads:true,readback:true writer_pools_built=0",
            "{off:?}"
        );
    }
    assert_eq!(
        run("writer-pools", &shadow_env("observe", Some("observe"))),
        "observe reads:true,readback:true identity:true writer_pools_built=0"
    );
    for value in ["1", "on", "true", "OBSERVE", "live"] {
        let result = run("shadow", &shadow_env("observe", Some(value)));
        assert!(
            result.contains("POLIS_API_POST_VOTES_IDENTITY must be unset, 0 or observe"),
            "{value}: {result}"
        );
    }
    // Not without the vote observer.
    let result = run("shadow", &shadow_env("0", Some("observe")));
    assert!(
        result.contains(
            "POLIS_API_POST_VOTES_IDENTITY=observe requires POLIS_API_POST_VOTES=observe"
        ),
        "{result}"
    );
    // The main role does not read it, whatever it holds.
    for value in ["observe", "anything"] {
        let main = with(
            with(
                writer_env("1"),
                "POLIS_API_PARTICIPANT_PUBLIC_KEY_FILE",
                Some(&file.path),
            ),
            "POLIS_API_POST_VOTES_IDENTITY",
            Some(value),
        );
        assert_eq!(run("writer-pools", &main), "live writer_pools_built=2");
        assert_eq!(
            run("main", &with(main, "POLIS_API_POST_VOTES", Some("0"))),
            "off"
        );
    }
}

/// Test 5. The switch's values, the two roles, the startup conditions shared
/// by live and observe, the shadow role's indifference to read switches, and
/// the participant key's fallback from the file to the key the process loads.
#[test]
fn startup_conditions_and_roles() {
    let keys = signing();
    let other = signing();
    let file = KeyFile::new("roles", &keys);
    let keyed = |env: Vec<(&'static str, String)>| {
        with(
            env,
            "POLIS_API_PARTICIPANT_PUBLIC_KEY_FILE",
            Some(&file.path),
        )
    };
    let shadow_env =
        |env: Vec<(&'static str, String)>| with(keyed(env), "POLIS_API_ROLE", Some("shadow"));
    // Switch values.
    for (value, expected) in [
        (None, "off"),
        (Some(""), "off"),
        (Some("0"), "off"),
        (Some("1"), "live"),
    ] {
        let env = with(keyed(writer_env("1")), "POLIS_API_POST_VOTES", value);
        assert_eq!(run("main", &env), expected, "{value:?}");
    }
    for value in ["observed", "true", "on", "2", "OBSERVE"] {
        let env = with(keyed(writer_env("1")), "POLIS_API_POST_VOTES", Some(value));
        let result = run("main", &env);
        assert!(
            result.starts_with("err ") && result.contains("POLIS_API_POST_VOTES"),
            "{value}: {result}"
        );
    }
    // Roles.
    for (value, expected) in [
        (None, "Ok(Main)"),
        (Some("main"), "Ok(Main)"),
        (Some("shadow"), "Ok(Shadow)"),
    ] {
        let env = with(vec![], "POLIS_API_ROLE", value);
        assert_eq!(run("role", &env), expected);
    }
    let unknown = run("role", &with(vec![], "POLIS_API_ROLE", Some("mirror")));
    assert!(unknown.contains("POLIS_API_ROLE"), "{unknown}");
    let observe_main = run("main", &keyed(writer_env("observe")));
    assert!(
        observe_main.starts_with("err ") && observe_main.contains("shadow role"),
        "{observe_main}"
    );
    let live_shadow = run("shadow", &shadow_env(writer_env("1")));
    assert!(
        live_shadow.starts_with("err ") && live_shadow.contains("shadow role"),
        "{live_shadow}"
    );
    assert_eq!(
        run("shadow", &shadow_env(writer_env("observe"))),
        "observe reads:true,readback:true"
    );
    assert_eq!(run("shadow", &shadow_env(writer_env("0"))), "off");
    // Live and observe keep the same startup conditions.
    for switch in ["1", "observe"] {
        let base = if switch == "1" {
            keyed(writer_env(switch))
        } else {
            shadow_env(writer_env(switch))
        };
        let scenario = if switch == "1" { "main" } else { "shadow" };
        for topical in [None, Some(""), Some("1"), Some("0.5")] {
            let result = run(
                scenario,
                &with(base.clone(), "TOPICAL_COMMENT_RATIO", topical),
            );
            assert!(
                result.contains("ordinary next-statement selection"),
                "{switch} {topical:?}: {result}"
            );
        }
        for translation in [None, Some(""), Some("true"), Some("0")] {
            let result = run(
                scenario,
                &with(base.clone(), "SHOULD_USE_TRANSLATION_API", translation),
            );
            assert!(
                result.contains("SHOULD_USE_TRANSLATION_API"),
                "{switch} {translation:?}: {result}"
            );
        }
        let result = run(
            scenario,
            &with(base.clone(), "POLIS_API_POST_VOTES_DATABASE_URL", None),
        );
        assert!(
            result.contains("explicit primary database"),
            "{switch}: {result}"
        );
        let result = run(scenario, &with(base.clone(), "POLIS_JWT_ISSUER", None));
        assert!(result.starts_with("err "), "{switch}: {result}");
    }
    // The participant key: the file when set, else the key the process loads,
    // for live and observe alike; with neither, startup fails.
    let token_a = token(&keys, "2fixture");
    let token_b = token(&other, "2fixture");
    for (role, switch) in [(None, "1"), (Some("shadow"), "observe")] {
        let mode = if switch == "1" { "live" } else { "observe" };
        let base = with(writer_env(switch), "POLIS_API_ROLE", role);
        let file_and_loaded = with(
            with(
                base.clone(),
                "POLIS_API_PARTICIPANT_PUBLIC_KEY_FILE",
                Some(&file.path),
            ),
            "JWT_PUBLIC_KEY",
            Some(&other.pem),
        );
        for (token, verified) in [(&token_a, true), (&token_b, false)] {
            let env = with(file_and_loaded.clone(), "FIXTURE_TOKEN", Some(token));
            assert_eq!(
                run("verify", &env),
                format!("{mode} verified={verified}"),
                "file wins"
            );
        }
        let loaded_only = with(base.clone(), "JWT_PUBLIC_KEY", Some(&other.pem));
        for (token, verified) in [(&token_b, true), (&token_a, false)] {
            let env = with(loaded_only.clone(), "FIXTURE_TOKEN", Some(token));
            assert_eq!(
                run("verify", &env),
                format!("{mode} verified={verified}"),
                "loaded key"
            );
        }
        let neither = with(base.clone(), "FIXTURE_TOKEN", Some(&token_a));
        let result = run("verify", &neither);
        assert!(
            result.starts_with("err ") && result.contains("participant public key"),
            "{mode}: {result}"
        );
    }
    // The shadow role reads none of the read-route switches it inherits.
    let shadow_app_env = with(
        with(
            with(
                with(
                    with(
                        with(shadow_env(writer_env("observe")), "MATH_ENV", Some("test")),
                        "POLIS_API_SHADOW_LISTEN",
                        Some("127.0.0.1:0"),
                    ),
                    "POLIS_API_SHADOW_MAX_PER_SECOND",
                    Some("4"),
                ),
                "DATABASE_URL",
                Some("postgres://postgres@127.0.0.1:9/postgres"),
            ),
            "POLIS_API_COMMENT_READS",
            Some("1"),
        ),
        "POLIS_API_NEXT_COMMENT_READS",
        Some("1"),
    );
    let shadow_app_env = with(
        with(shadow_app_env, "POLIS_API_PARTICIPANT_READS", Some("1")),
        "NODE_ENV",
        Some("production"),
    );
    assert_eq!(
        run("shadow-app", &shadow_app_env),
        "ok observer=true writer=false comments=false next=false participant_reads=false"
    );
    for missing in ["POLIS_API_SHADOW_LISTEN", "POLIS_API_SHADOW_MAX_PER_SECOND"] {
        let result = run("shadow-app", &with(shadow_app_env.clone(), missing, None));
        assert!(
            result.starts_with("err ") && result.contains(missing),
            "{missing}: {result}"
        );
    }
    let result = run(
        "shadow-app",
        &with(
            shadow_app_env.clone(),
            "POLIS_API_SHADOW_MAX_PER_SECOND",
            Some("0"),
        ),
    );
    assert!(result.starts_with("err "), "{result}");
}

/// Test 6. The shadow's /health says observe and not enabled, and lists only
/// its two read-only pools; the main role's says off in the same environment.
#[tokio::test]
async fn shadow_health_reports_observe() {
    let keys = signing();
    let app = shadow_app(closed, Some(observer_on(closed, &keys.public)));
    let lane = shadow::Lane::new(4);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(shadow::serve(listener, app.clone(), lane.clone()));
    let mut client = tokio::net::TcpStream::connect(address).await.unwrap();
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    client
        .write_all(b"GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
        .await
        .unwrap();
    let mut response = Vec::new();
    tokio::time::timeout(Duration::from_secs(10), client.read_to_end(&mut response))
        .await
        .unwrap()
        .unwrap();
    server.abort();
    let response = String::from_utf8(response).unwrap();
    let (_, body) = response.split_once("\r\n\r\n").unwrap();
    let health: Value = serde_json::from_str(body).unwrap();
    assert_eq!(health["role"], "shadow");
    assert_eq!(health["version"], env!("POLIS_VERSION"));
    assert_eq!(health["commit"], env!("GIT_HASH"));
    // The readback pool answers the status; this one points at a closed port.
    assert_eq!(health["status"], "degraded");
    let votes = &health["postVotes"];
    assert_eq!(votes["enabled"], false);
    assert_eq!(votes["mode"], "observe");
    for key in [
        "observed",
        "wouldServe",
        "wouldHandBack",
        "wouldFail",
        "shed",
        "notObserved",
        "readbackSame",
        "readbackAmbiguous",
        "readbackDifferent",
        "readbackAbsent",
    ] {
        assert_eq!(votes[key], 0, "{key}");
    }
    let pools = votes["pools"].as_object().unwrap();
    assert_eq!(printed_keys(&votes["pools"].to_string()).len(), 2);
    let mut names: Vec<&String> = pools.keys().collect();
    names.sort();
    assert_eq!(names, ["readback", "reads"]);
    for pool in pools.values() {
        assert_eq!(pool["readOnly"], true);
    }
    assert_eq!(pools["reads"]["limit"], 2);
    assert_eq!(pools["readback"]["limit"], 1);
    assert_eq!(pools["readback"]["reachable"], false);
    let lane_health = &health["shadow"];
    assert_eq!(lane_health["listening"], true);
    assert_eq!(lane_health["address"], address.to_string());
    assert_eq!(lane_health["inFlight"], 0);
    assert_eq!(lane_health["capacity"], 32);
    assert_eq!(lane_health["maxPerSecond"], 4);
    // The main role in the same environment, the role aside: off.
    let main = App::new(&cfg(false), db::Pool::new(closed(), read_limits()));
    let body: Value = serde_json::from_str(&crate::js::stringify(&health_for(&main))).unwrap();
    assert_eq!(body["enabled"], false);
    assert_eq!(body["mode"], "off");
}

/// The shadow listener drops a request head it cannot parse without an
/// answer, exactly as the main listener does (a header value that is not
/// UTF-8, more than 128 header lines), but counts each one by kind, so the
/// shadow measures how often a live writer would drop a vote that way.
#[tokio::test]
async fn shadow_listener_counts_refused_heads() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let keys = signing();
    let app = shadow_app(closed, Some(observer_on(closed, &keys.public)));
    let lane = shadow::Lane::new(4);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(shadow::serve(listener, app.clone(), lane.clone()));
    let refused = |health: &Value| health["shadow"]["headRefused"].as_u64().unwrap();
    let health = || async { body_of(shadow::health(&app, &lane).await) };
    let before = refused(&health().await);
    let body = vote_body("2fixture", 1, VoteChoice::Pass).to_string();
    let mut utf8 = format!(
        "POST /api/v3/votes HTTP/1.0\r\nHost: localhost\r\nX-Polis-Shadow: votesShadow\r\nContent-Type: application/json\r\nContent-Length: {}\r\nX-Note: ",
        body.len()
    )
    .into_bytes();
    utf8.extend_from_slice(&[0x63, 0x61, 0x66, 0xe9]);
    utf8.extend_from_slice(b"\r\n\r\n");
    utf8.extend_from_slice(body.as_bytes());
    let mut many = format!(
        "POST /api/v3/votes HTTP/1.0\r\nHost: localhost\r\nX-Polis-Shadow: votesShadow\r\nContent-Type: application/json\r\nContent-Length: {}\r\n",
        body.len()
    );
    for n in 0..130 {
        many.push_str(&format!("X-Extra-{n}: 1\r\n"));
    }
    many.push_str("\r\n");
    many.push_str(&body);
    for raw in [utf8, many.into_bytes()] {
        let mut client = tokio::net::TcpStream::connect(address).await.unwrap();
        client.write_all(&raw).await.unwrap();
        let mut response = Vec::new();
        let _ =
            tokio::time::timeout(Duration::from_secs(10), client.read_to_end(&mut response)).await;
        assert!(
            response.is_empty(),
            "a refused head gets no answer: {response:?}"
        );
    }
    tokio::time::timeout(Duration::from_secs(10), async {
        while refused(&health().await) < before + 2 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("both refused heads are counted");
    server.abort();
    let events: Vec<Value> = shadow::recorded()
        .iter()
        .filter(|line| line.contains("\"shadow_http_head_refused\""))
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    for class in ["header_utf8", "too_many_headers"] {
        assert!(
            events
                .iter()
                .any(|e| e["class"] == class && e["listener"] == "shadow"),
            "{class}"
        );
    }
}

fn body_of(out: Outgoing) -> Value {
    let crate::http::Body::Fixed(bytes) = out.body else {
        panic!("fixed JSON expected")
    };
    serde_json::from_slice(&bytes).unwrap()
}

fn health_for(app: &App) -> crate::js::Js {
    health(app)
}

/// Test 10. Copies beyond the 32 in flight are shed as lane_full, and copies
/// beyond the per-process rate as rate_cap; both still answer 204.
#[tokio::test]
async fn shadow_lane_sheds_by_count_and_rate() {
    let keys = signing();
    let app = shadow_app(closed, Some(observer_on(closed, &keys.public)));
    let lane = shadow::Lane::new(1000);
    let parked = lane.park().await;
    let body = vote_body("2fixture", 1, VoteChoice::Pass);
    let mut ids = vec![];
    for _ in 0..32 {
        let id = request_id();
        let out = shadow::accept(app.clone(), lane.clone(), copy(&body, None, &id)).await;
        assert_eq!(out.status, 204);
        ids.push(id);
    }
    assert_eq!(lane.in_flight(), 32);
    let id = request_id();
    let out = shadow::accept(app.clone(), lane.clone(), copy(&body, None, &id)).await;
    assert_eq!(out.status, 204);
    let line = observation_line(&id).expect("a shed copy is recorded at once");
    assert_line_shape(&line);
    assert_eq!(line["outcome"], "shed");
    assert_eq!(line["reason"], "lane_full");
    assert_eq!(line["admitted"], 0);
    let rate = shadow::Lane::new(2);
    let rate_parked = rate.park().await;
    let mut rate_ids = vec![];
    for _ in 0..2 {
        let id = request_id();
        assert_eq!(
            shadow::accept(app.clone(), rate.clone(), copy(&body, None, &id))
                .await
                .status,
            204
        );
        rate_ids.push(id);
    }
    let id = request_id();
    assert_eq!(
        shadow::accept(app.clone(), rate.clone(), copy(&body, None, &id))
            .await
            .status,
        204
    );
    let line = observation_line(&id).expect("a rate-capped copy is recorded at once");
    assert_eq!(line["outcome"], "shed");
    assert_eq!(line["reason"], "rate_cap");
    for id in ids.iter().chain(&rate_ids) {
        assert!(
            observation_line(id).is_none(),
            "parked observations are still pending"
        );
    }
    drop(parked);
    drop(rate_parked);
    for id in ids.iter().chain(&rate_ids) {
        let line = observation(id).await;
        assert_eq!(line["outcome"], "would_hand_back");
        assert_eq!(line["reason"], "no_token");
    }
    assert_eq!(lane.in_flight(), 0);
}

/// Test 11. The observation line carries exactly the allowlisted keys: no
/// vote, no pid, no text, no token. Every line and event the shadow prints
/// says it is the shadow's.
#[tokio::test]
async fn observation_line_carries_only_allowed_keys() {
    let keys = signing();
    let stranger = signing();
    let app = shadow_app(closed, Some(observer_on(closed, &keys.public)));
    let unconfigured = shadow_app(closed, None);
    let lane = shadow::Lane::new(1000);
    let good = token(&keys, "2fixture");
    let refused = token(&stranger, "2fixture");
    let body = vote_body("2fixture", 3, VoteChoice::Agree);
    let mut extra = body.clone();
    extra["unknown"] = json!(true);
    let mut starred = body.clone();
    starred["starred"] = json!(true);
    starred["lang"] = json!("fr");
    let mut plain = copy(&body, Some(good.as_str()), &request_id());
    plain.headers = crate::http::Headers::from_raw([
        ("host", "localhost"),
        ("content-type", "application/json"),
        ("x-forwarded-proto", "http"),
        ("x-request-id", "0123456789abcdef0123456789abcdef"),
        ("x-polis-shadow", "votesShadow"),
    ]);
    let cases: Vec<(Arc<App>, Request, &str, &str)> = vec![
        (
            unconfigured.clone(),
            copy(&body, Some(good.as_str()), &request_id()),
            "not_observed",
            "unconfigured",
        ),
        (
            app.clone(),
            copy(&body, None, &request_id()),
            "would_hand_back",
            "no_token",
        ),
        (
            app.clone(),
            copy(&body, Some(refused.as_str()), &request_id()),
            "would_hand_back",
            "token_refused",
        ),
        (
            app.clone(),
            copy(&extra, Some(good.as_str()), &request_id()),
            "would_hand_back",
            "shape_keys",
        ),
        (
            app.clone(),
            copy(&starred, None, &request_id()),
            "would_hand_back",
            "no_token",
        ),
        (app.clone(), plain, "would_hand_back", "not_https"),
    ];
    let mut lines = vec![];
    for (app, req, outcome, reason) in cases {
        let id = req.headers.get("x-request-id").unwrap().to_owned();
        assert_eq!(shadow::accept(app, lane.clone(), req).await.status, 204);
        let line = observation(&id).await;
        assert_line_shape(&line);
        assert_eq!(line["outcome"], outcome, "{line}");
        assert_eq!(line["reason"], reason, "{line}");
        assert_eq!(line["node_vote"], "not_checked");
        assert_eq!(line["request_id"], id);
        lines.push(line);
    }
    assert_eq!(lines[4]["starred_present"], true);
    assert_eq!(lines[4]["lang_present"], true);
    assert_eq!(lines[1]["starred_present"], false);
    // A request id that is not 32 lowercase hex is recorded as null.
    let mut odd = copy(&body, None, "NOT-HEX");
    odd.headers = crate::http::Headers::from_raw([
        ("host", "localhost"),
        ("content-type", "application/json"),
        ("x-forwarded-proto", "https"),
        ("x-request-id", "0123456789ABCDEF0123456789ABCDEF"),
        ("x-polis-shadow", "votesShadow"),
    ]);
    assert_eq!(
        shadow::accept(app.clone(), lane.clone(), odd).await.status,
        204
    );
    let recorded = shadow::recorded();
    for line in &recorded {
        let value: Value = serde_json::from_str(line).unwrap();
        for secret in [good.as_str(), refused.as_str(), "Bearer", "authorization"] {
            assert!(!line.contains(secret), "{line}");
        }
        let object = value.as_object().unwrap();
        for key in ["vote", "pid", "txt", "currentPid", "uid"] {
            assert!(!object.contains_key(key), "{key} in {line}");
        }
        let marked = value["listener"] == "shadow"
            || value["event"]
                .as_str()
                .is_some_and(|e| e.starts_with("shadow_"));
        assert!(marked, "an unmarked shadow line: {line}");
        if value["message"] == "shadow_observation" {
            assert_line_shape(&value);
            assert_eq!(
                printed_keys(line),
                LINE_KEYS,
                "observation keys in their order"
            );
            assert!(
                value["request_id"].is_null()
                    || value["request_id"].as_str().is_some_and(|id| id.len() == 32
                        && id
                            .bytes()
                            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))),
                "{line}"
            );
        }
    }
    assert!(
        recorded
            .iter()
            .any(|line| line.contains("\"message\":\"http_request\"")
                && line.contains("\"service\":\"polis-api-shadow\"")
                && line.contains("\"listener\":\"shadow\"")),
        "the shadow's own access line"
    );
}

/// A copy of a vote from each client gets past the Content-Type check (it
/// carries no token, so the next reason is recorded), and its body is read
/// (the line says it carries a star). A copy under a form no client sends
/// stops at that check. Each copy has the Content-Length nginx sends, so the
/// route's body parser runs too.
#[tokio::test]
async fn copies_from_each_client_pass_the_content_type_check() {
    let keys = signing();
    let app = shadow_app(closed, Some(observer_on(closed, &keys.public)));
    let lane = shadow::Lane::new(1000);
    let mut body = vote_body("2fixture", 3, VoteChoice::Agree);
    body["starred"] = json!(true);
    let length = body.to_string().len().to_string();
    for (content_type, reason) in [
        // The command-line client.
        (Some("application/json"), "no_token"),
        // The participation client built on fetch.
        (Some("application/json; charset=utf-8"), "no_token"),
        // The participation client built on jQuery, as a browser sends it.
        (Some("application/json; charset=UTF-8"), "no_token"),
        (Some("application/json;charset=UTF-8"), "shape_content_type"),
        (Some("text/plain;charset=UTF-8"), "shape_content_type"),
        (None, "shape_content_type"),
    ] {
        let id = request_id();
        let mut req = copy(&body, None, &id);
        let mut headers = vec![
            ("host", "localhost"),
            ("content-length", length.as_str()),
            ("x-forwarded-proto", "https"),
            ("x-request-id", id.as_str()),
            ("x-polis-shadow", "votesShadow"),
        ];
        if let Some(content_type) = content_type {
            headers.push(("content-type", content_type));
        }
        req.headers = crate::http::Headers::from_raw(headers);
        assert_eq!(
            shadow::accept(app.clone(), lane.clone(), req).await.status,
            204
        );
        let line = observation(&id).await;
        assert_line_shape(&line);
        assert_eq!(line["outcome"], "would_hand_back", "{line}");
        assert_eq!(line["reason"], reason, "{content_type:?}: {line}");
        assert_eq!(
            line["starred_present"],
            reason == "no_token",
            "{content_type:?}: {line}"
        );
    }
}

/// The line never names a statement, whatever became of the copy: not the
/// one it votes on, not the one that would be served next. A statement number
/// beside the conversation number and the time picks out one row of a
/// conversation's public votes, and with it a participant. What needs the
/// number (the readback of Node's stored vote, the membership class) uses it
/// in process and prints a class.
#[tokio::test]
async fn observation_line_names_no_statement() {
    // A statement number no other field of these lines can hold.
    const STATEMENT: i32 = 918_273;
    assert!(
        LINE_KEYS
            .iter()
            .all(|key| *key != "tid" && !key.ends_with("_tid")),
        "the line's contract names a statement"
    );
    let keys = signing();
    let member = token(&keys, "2fixture");
    let app = shadow_app(closed, Some(observer_on(closed, &keys.public)));
    let unconfigured = shadow_app(closed, None);
    let body = vote_body("2fixture", STATEMENT, VoteChoice::Agree);
    let mut starred = body.clone();
    starred["starred"] = json!(true);
    starred["lang"] = json!("fr");
    // A lane of one copy a second: the copy after the first is shed.
    let slow = shadow::Lane::new(1);
    let lane = shadow::Lane::new(1000);
    // Every copy is accepted before any line is awaited, so the slow lane's
    // second copy arrives within its first second.
    let mut accepted = vec![];
    for (app, lane, body, token, outcome) in [
        // Handed back before admission: no token.
        (&app, &lane, &body, None, "would_hand_back"),
        // A member's copy, read as far as admission (no database here).
        (
            &app,
            &lane,
            &starred,
            Some(member.as_str()),
            "would_hand_back",
        ),
        (
            &unconfigured,
            &lane,
            &body,
            Some(member.as_str()),
            "not_observed",
        ),
        (&app, &slow, &body, None, "would_hand_back"),
        (&app, &slow, &body, None, "shed"),
    ] {
        let id = request_id();
        assert_eq!(
            shadow::accept(app.clone(), lane.clone(), copy(body, token, &id))
                .await
                .status,
            204
        );
        accepted.push((id, outcome));
    }
    for (id, outcome) in accepted {
        let marker = format!("\"request_id\":\"{id}\"");
        let printed = tokio::time::timeout(Duration::from_secs(60), async {
            loop {
                let found = shadow::recorded()
                    .into_iter()
                    .find(|line| line.contains(&marker) && line.contains("\"shadow_observation\""));
                if let Some(line) = found {
                    return line;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("no observation line for {id}"));
        let line: Value = serde_json::from_str(&printed).unwrap();
        assert_eq!(line["outcome"], outcome, "{printed}");
        assert_names_no_statement(&line);
        assert!(
            !printed.contains(&STATEMENT.to_string()),
            "the statement voted on is on the line: {printed}"
        );
        assert_eq!(printed_keys(&printed), LINE_KEYS, "{printed}");
    }
}

/// Test 8 needs no database: the main role, with the writer off, hands a vote
/// back with the marker and records no observation, whatever headers it has.
#[tokio::test]
async fn main_role_hands_back_without_writer() {
    let app = Arc::new(App::new(
        &cfg(false),
        db::Pool::new(closed(), read_limits()),
    ));
    let id = request_id();
    let out = route::handle(
        app,
        copy(&vote_body("2fixture", 1, VoteChoice::Pass), None, &id),
    )
    .await;
    assert_eq!(out.status, 502);
    assert!(
        out.headers
            .iter()
            .any(|(k, v)| k == "X-Polis-Vote-Dispatch" && v == "not-started")
    );
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(observation_line(&id).is_none());
}

// --------------------------------------------------------------- database

#[cfg(feature = "db-tests")]
mod database_tests {
    use super::*;
    use postgres::error::SqlState;

    // The synchronous PostgreSQL client starts its own runtime, so fixtures
    // and digests run on this thread (outside the test's runtime) or on a
    // blocking thread, never on the runtime's own threads.
    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
    }

    async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> T {
        tokio::task::spawn_blocking(f).await.unwrap()
    }

    fn connector(db: &Database) -> impl Fn() -> Connector + '_ {
        || Connector::Plain(Box::new(db.config.clone()))
    }

    /// One conversation, a participant with prior votes and math priorities,
    /// a closed conversation, and statements of every moderation state.
    fn fixture(label: &str) -> Database {
        let db = Database::new(label);
        let mut c = db.connect();
        c.batch_execute(
            "INSERT INTO users(uid) VALUES(1);
             INSERT INTO conversations(zid,is_active,modified) VALUES(1,true,0),(2,false,0);
             INSERT INTO zinvites(zid,zinvite) VALUES(1,'2fixture'),(2,'3closed');
             ALTER TABLE participants DISABLE TRIGGER USER;
             INSERT INTO participants(zid,pid,uid,nsli) VALUES(1,0,1,3),(2,0,1,0);
             ALTER TABLE participants ENABLE TRIGGER USER;
             INSERT INTO comments(zid,pid,uid,txt,lang,created)
             SELECT 1,0,1,'Statement ' || t,'en',1700000000000+t FROM generate_series(0,13) t ORDER BY t;
             INSERT INTO comments(zid,pid,uid,txt,lang,created) VALUES(2,0,1,'Closed statement','en',1);
             UPDATE comments SET mod=-1 WHERE zid=1 AND tid=3;
             UPDATE comments SET velocity=0 WHERE zid=1 AND tid=5;
             UPDATE comments SET active=false WHERE zid=1 AND tid=8;
             INSERT INTO comment_translations(zid,tid,src,txt,lang) VALUES(1,2,-1,'Traduit','fr');",
        )
        .unwrap();
        let priorities =
            json!({"comment-priorities": {"0": 2, "1": 0.5, "2": 3, "4": 1.5, "9": 4}});
        c.execute(
            "INSERT INTO math_main(zid,math_env,math_tick,last_vote_timestamp,data) VALUES(1,'test',7,0,$1::text::jsonb)",
            &[&priorities.to_string()],
        )
        .unwrap();
        for (tid, choice) in [(0, VoteChoice::Agree), (1, VoteChoice::Disagree)] {
            append(&mut c, &actor(), &field(tid, choice)).unwrap();
        }
        db
    }

    fn field(tid: i32, choice: VoteChoice) -> ParsedFields {
        ParsedFields {
            tid: f64::from(tid),
            vote: choice,
            starred: None,
            high_priority: false,
            lang: None,
        }
    }

    fn digest(config: &postgres::Config) -> Vec<String> {
        let mut c = config.connect(postgres::NoTls).unwrap();
        [
            "select count(*)::text || ':' || coalesce(md5(string_agg(v::text, ',' order by v::text)), '') from votes v",
            "select count(*)::text || ':' || coalesce(md5(string_agg(v::text, ',' order by v::text)), '') from votes_latest_unique v",
            "select count(*)::text || ':' || coalesce(md5(string_agg(s::text, ',' order by s::text)), '') from stars s",
            "select count(*)::text || ':' || coalesce(sum(last_interaction), 0)::text || ':' || coalesce(sum(nsli), 0)::text from participants",
            "select count(*)::text || ':' || coalesce(md5(string_agg(e::text, ',' order by e::text)), '') from event_ptpt_no_more_comments e",
            "select count(*)::text || ':' || coalesce(md5(string_agg(t::text, ',' order by t::text)), '') from comment_translations t",
        ]
        .iter()
        .map(|sql| c.query_one(*sql, &[]).unwrap().get::<_, String>(0))
        .collect()
    }

    async fn digest_now(config: &postgres::Config) -> Vec<String> {
        let config = config.clone();
        blocking(move || digest(&config)).await
    }

    async fn append_now(config: &postgres::Config, tid: i32, choice: VoteChoice) {
        let config = config.clone();
        blocking(move || {
            let mut c = config.connect(postgres::NoTls).unwrap();
            append(&mut c, &actor(), &field(tid, choice)).unwrap();
        })
        .await;
    }

    fn observer_for(db: &Database, keys: &Signing) -> Observer {
        let mut observer = observer_on(connector(db), &keys.public);
        observer.timing = observe::ReadbackTiming {
            first: Duration::from_millis(50),
            retry: Duration::from_millis(150),
        };
        observer
    }

    /// A member's vote is admitted and its next statement selected whether
    /// `math_main.data` is jsonb (a database built from the migrations) or
    /// json (an installation older than them), with the same observation.
    #[test]
    fn observe_mode_admits_and_selects_on_either_math_column_type() {
        let keys = signing();
        let member = token(&keys, "2fixture");
        let mut seen = vec![];
        for column_type in ["jsonb", "json"] {
            let db = fixture(&format!("observe_{column_type}")).math_data(column_type);
            let app = shadow_app(connector(&db), Some(observer_for(&db, &keys)));
            let line = runtime().block_on(async {
                let lane = shadow::Lane::new(1000);
                let id = request_id();
                let req = copy(
                    &vote_body("2fixture", 2, VoteChoice::Agree),
                    Some(member.as_str()),
                    &id,
                );
                assert_eq!(
                    shadow::accept(app.clone(), lane.clone(), req).await.status,
                    204
                );
                observation(&id).await
            });
            assert_line_shape(&line);
            assert!(line["reason"].is_null(), "{column_type}: {line}");
            seen.push(json!([
                line["outcome"],
                line["admitted"],
                line["status"],
                line["zid"],
                line["follow_on"],
                line["weights_tick"],
                line["candidates"],
                line["remaining"],
                line["total"],
            ]));
        }
        assert_eq!(
            seen[0],
            json!(["would_serve", 1, 200, 1, "complete", 7, 8, 9, 12])
        );
        assert_eq!(seen[1], seen[0], "json differs from jsonb");
    }

    /// Test 1. Admission and selection as live, and no row changes: a member
    /// with prior votes and priorities, a closed conversation, an exhausting
    /// vote, starred with a language, and no token.
    #[test]
    fn observe_mode_admits_selects_and_changes_no_rows() {
        let keys = signing();
        let db = fixture("observe_rows");
        let app = shadow_app(connector(&db), Some(observer_for(&db, &keys)));
        let config = db.config.clone();
        runtime().block_on(async move {
            let lane = shadow::Lane::new(1000);
            let member = token(&keys, "2fixture");
            let closed_member = token(&keys, "3closed");
            let before = digest_now(&config).await;
            let mut starred = vote_body("2fixture", 2, VoteChoice::Agree);
            starred["starred"] = json!(true);
            starred["lang"] = json!("fr");
            let cases: Vec<(Value, Option<&str>, &str, Value, &str)> = vec![
                (
                    vote_body("2fixture", 2, VoteChoice::Agree),
                    Some(member.as_str()),
                    "would_serve",
                    json!(200),
                    "complete",
                ),
                (
                    vote_body("3closed", 0, VoteChoice::Disagree),
                    Some(closed_member.as_str()),
                    "would_serve",
                    json!(403),
                    "",
                ),
                (
                    starred,
                    Some(member.as_str()),
                    "would_serve",
                    json!(200),
                    "complete",
                ),
                (
                    vote_body("2fixture", 4, VoteChoice::Pass),
                    None,
                    "would_hand_back",
                    json!(502),
                    "",
                ),
            ];
            let mut lines = vec![];
            for (body, token, outcome, status, follow_on) in cases {
                let id = request_id();
                let out = shadow::accept(app.clone(), lane.clone(), copy(&body, token, &id)).await;
                assert_eq!(out.status, 204);
                assert!(matches!(out.body, Body::Empty));
                let line = observation(&id).await;
                assert_line_shape(&line);
                assert_eq!(line["outcome"], outcome, "{line}");
                assert_eq!(line["status"], status, "{line}");
                match status.as_i64() {
                    Some(200) => {
                        assert_eq!(line["admitted"], 1);
                        assert!(line["reason"].is_null());
                        assert_eq!(line["zid"], 1);
                        assert_eq!(line["follow_on"], follow_on);
                        assert_eq!(line["weights_tick"], 7);
                        // Eligible: 0..13 less moderated 3, muted 5, inactive 8;
                        // less the prior votes 0 and 1 and the voted 2.
                        assert_eq!(line["candidates"], 8);
                        // get_visible_comments counts the muted statement too.
                        assert_eq!(line["remaining"], 9);
                        assert_eq!(line["total"], 12);
                        // Node wrote nothing in this test, so its row is absent.
                        assert_eq!(line["node_vote"], "absent");
                        assert!(line["readback_s"].as_f64().is_some());
                        assert!(line["admission_ms"].as_f64().is_some());
                        assert!(line["selection_ms"].as_f64().is_some());
                    }
                    Some(403) => {
                        assert_eq!(line["admitted"], 1);
                        assert_eq!(line["reason"], "closed");
                        assert_eq!(line["zid"], 2);
                        assert!(line["follow_on"].is_null());
                        assert_eq!(line["node_vote"], "absent");
                    }
                    _ => {
                        assert_eq!(line["admitted"], 0);
                        assert_eq!(line["reason"], "no_token");
                        assert_eq!(line["node_vote"], "not_checked");
                    }
                }
                lines.push(line);
            }
            // The membership memo: nothing stored before the first selection;
            // the second vote on 2 was not among the candidates offered after
            // the first (2 counted as voted), and Node never stored it.
            assert_eq!(lines[0]["prev"], "none");
            assert!(lines[1]["prev"].is_null());
            assert_eq!(lines[2]["prev"], "miss");
            assert_eq!(digest_now(&config).await, before, "observe changed a row");
            // An exhausting vote: every remaining candidate voted but one.
            for tid in [2, 4, 6, 7, 9, 10, 11, 12] {
                append_now(&config, tid, VoteChoice::Pass).await;
            }
            let before_exhausting = digest_now(&config).await;
            let id = request_id();
            let body = vote_body("2fixture", 13, VoteChoice::Disagree);
            let out = shadow::accept(
                app.clone(),
                lane.clone(),
                copy(&body, Some(member.as_str()), &id),
            )
            .await;
            assert_eq!(out.status, 204);
            let line = observation(&id).await;
            assert_eq!(line["outcome"], "would_serve");
            assert_eq!(line["follow_on"], "absent");
            assert_eq!(line["candidates"], 0);
            // The member's last selection here offered 13: a hit.
            assert_eq!(line["prev"], "hit");
            assert_eq!(
                digest_now(&config).await,
                before_exhausting,
                "observe changed a row"
            );
            assert_ne!(
                before, before_exhausting,
                "the fixture's own votes are visible"
            );
            let health = body_of(shadow::health(&app, &lane).await);
            assert_eq!(health["status"], "ok");
            assert_eq!(health["postVotes"]["wouldServe"], 4);
            assert_eq!(health["postVotes"]["wouldHandBack"], 1);
            assert_eq!(health["postVotes"]["readbackAbsent"], 4);
        });
    }

    /// Row counts of every table a vote can touch are the same before and
    /// after a hundred observed votes (starred, with a language, on every
    /// statement, closed and open, some arriving together).
    #[test]
    fn a_hundred_observed_votes_leave_row_counts_unchanged() {
        let keys = signing();
        let db = fixture("observe_hundred");
        let app = shadow_app(connector(&db), Some(observer_for(&db, &keys)));
        let counts = |config: &postgres::Config| -> Vec<i64> {
            let mut c = config.connect(postgres::NoTls).unwrap();
            [
                "votes",
                "votes_latest_unique",
                "stars",
                "participants",
                "event_ptpt_no_more_comments",
            ]
            .iter()
            .map(|table| {
                c.query_one(&format!("select count(*) from {table}"), &[])
                    .unwrap()
                    .get::<_, i64>(0)
            })
            .collect()
        };
        let before = counts(&db.config);
        let before_digest = digest(&db.config);
        let member = token(&keys, "2fixture");
        let closed_member = token(&keys, "3closed");
        let ids = runtime().block_on(async {
            let lane = shadow::Lane::new(1000);
            let mut ids = vec![];
            for n in 0..100 {
                let choice = [VoteChoice::Agree, VoteChoice::Disagree, VoteChoice::Pass][n % 3];
                let (cid, token) = if n % 10 == 9 {
                    ("3closed", closed_member.as_str())
                } else {
                    ("2fixture", member.as_str())
                };
                let mut body = vote_body(cid, (n % 14) as i32, choice);
                if n % 4 == 0 {
                    body["starred"] = json!(n % 8 == 0);
                }
                if n % 5 == 0 {
                    body["lang"] = json!("fr");
                }
                let id = request_id();
                let out =
                    shadow::accept(app.clone(), lane.clone(), copy(&body, Some(token), &id)).await;
                assert_eq!(out.status, 204);
                ids.push(id);
                // Some copies arrive together; most one after another.
                if n % 7 != 0 {
                    tokio::time::timeout(Duration::from_secs(10), async {
                        while lane.in_flight() != 0 {
                            tokio::time::sleep(Duration::from_millis(1)).await;
                        }
                    })
                    .await
                    .unwrap();
                }
            }
            for id in &ids {
                let line = observation(id).await;
                assert_line_shape(&line);
                assert_ne!(line["outcome"], "would_fail", "{line}");
                assert_ne!(line["outcome"], "shed", "{line}");
            }
            ids
        });
        assert_eq!(ids.len(), 100);
        assert_eq!(
            counts(&db.config),
            before,
            "row counts changed under observe"
        );
        assert_eq!(
            digest(&db.config),
            before_digest,
            "rows changed under observe"
        );
    }

    /// Test 2. Observe selects what live selects after its commit, whether or
    /// not Node's commit is visible yet, for the same draw.
    #[test]
    fn observe_selection_equals_live_selection() {
        let live_db = fixture("observe_equal_live");
        let shadow_db = fixture("observe_equal_shadow");
        let mut live = live_db.connect();
        let mut shadow_side = shadow_db.connect();
        // Votes on candidates, a muted and a moderated-out statement, a
        // repeated vote, and the vote that exhausts the candidates.
        let votes = [
            (2, VoteChoice::Agree),
            (5, VoteChoice::Disagree),
            (4, VoteChoice::Pass),
            (3, VoteChoice::Agree),
            (0, VoteChoice::Disagree),
            (9, VoteChoice::Agree),
            (6, VoteChoice::Disagree),
            (7, VoteChoice::Pass),
            (10, VoteChoice::Agree),
            (11, VoteChoice::Agree),
            (12, VoteChoice::Disagree),
            (13, VoteChoice::Pass),
        ];
        let mut exhausted = 0;
        for (case, (tid, choice)) in votes.into_iter().enumerate() {
            for unit in [0.0, 0.37, 0.91, 0.9999] {
                let a = actor();
                let f = field(tid, choice);
                if unit == 0.0 {
                    // The live writer commits, then selects.
                    append(&mut live, &a, &f).unwrap();
                }
                let expected = complete(&mut live, &a, "test", unit, None)
                    .unwrap()
                    .next_comment
                    .map(|n| serde_json::to_value(n).unwrap());
                let visible = case % 2 == 0;
                if visible && unit == 0.0 {
                    append(&mut shadow_side, &a, &f).unwrap();
                }
                let mut selection = Selection::new(tid);
                let observed = next_selecting(
                    &mut shadow_side,
                    &a,
                    "test",
                    unit,
                    None,
                    Some(&mut selection),
                )
                .unwrap();
                assert_eq!(
                    observed.is_some(),
                    expected.is_some(),
                    "case {case} unit {unit}"
                );
                match expected {
                    Some(next) => {
                        assert_eq!(selection.next_tid, next["tid"].as_i64().map(|t| t as i32));
                        assert_eq!(selection.remaining, next["remaining"].as_i64());
                        assert_eq!(selection.total, next["total"].as_i64());
                        let observed: Value =
                            serde_json::from_str(&js::stringify(&observed.unwrap())).unwrap();
                        assert_eq!(observed, next, "case {case} unit {unit}");
                    }
                    None => {
                        exhausted += 1;
                        assert_eq!(selection.next_tid, None);
                        assert!(selection.candidates.is_empty());
                    }
                }
                if !visible && unit == 0.9999 {
                    // Node's commit lands after the copy was observed.
                    append(&mut shadow_side, &a, &f).unwrap();
                }
            }
        }
        assert_eq!(exhausted, 4, "the last vote exhausts both sides");
    }

    /// Test 3. Both observe pools are read-only sessions: PostgreSQL refuses
    /// the writer's notification update and its star insert.
    #[test]
    fn observe_pools_refuse_writes() {
        let keys = signing();
        let db = fixture("observe_refuse");
        let observer = observer_for(&db, &keys);
        let before = digest(&db.config);
        runtime().block_on(async {
            for pool in [&observer.reads, &observer.readback] {
                let (state, starred, setting) = pool
                    .with(|c| {
                        let code = |e: anyhow::Error| {
                            e.downcast_ref::<postgres::Error>()
                                .and_then(postgres::Error::code)
                                .cloned()
                        };
                        let state = notification_state(c, &actor()).err().and_then(code);
                        let mut f = field(2, VoteChoice::Pass);
                        f.starred = Some(true);
                        let starred = star(c, &actor(), &f, 0).err().and_then(code);
                        let setting: String = c
                            .query_one(
                                "select current_setting('default_transaction_read_only')",
                                &[],
                            )?
                            .get(0);
                        Ok((state, starred, setting))
                    })
                    .await
                    .unwrap();
                assert_eq!(state, Some(SqlState::READ_ONLY_SQL_TRANSACTION));
                assert_eq!(starred, Some(SqlState::READ_ONLY_SQL_TRANSACTION));
                assert_eq!(setting, "on");
            }
        });
        drop(observer);
        assert_eq!(digest(&db.config), before);
    }

    /// Test 7. The shadow never dispatches a copy to a live writer: with only
    /// a live writer, or both, a copy is not observed and nothing changes.
    #[test]
    fn shadow_role_never_dispatches_live() {
        let keys = signing();
        let file = KeyFile::new("never-live", &keys);
        let refused = run(
            "shadow",
            &with(
                with(writer_env("1"), "POLIS_API_ROLE", Some("shadow")),
                "POLIS_API_PARTICIPANT_PUBLIC_KEY_FILE",
                Some(&file.path),
            ),
        );
        assert!(refused.starts_with("err "), "{refused}");
        let db = fixture("observe_never_live");
        let live = || Writer {
            pool: db::Pool::writer(connector(&db)(), read_limits()),
            background: NotificationPool::new(db::Pool::writer(connector(&db)(), read_limits())),
            verifier: participant::Verifier::new(&keys.public, "fixture", "fixture").unwrap(),
            reads: db::Pool::new(connector(&db)(), read_limits()),
            admins: vec![],
            priorities: Arc::default(),
            follow_on: Arc::new(FollowOnLane::default()),
        };
        let before = digest(&db.config);
        let member = token(&keys, "2fixture");
        let mut apps = vec![];
        for both in [false, true] {
            let mut app = App::new(&cfg(false), db::Pool::new(connector(&db)(), read_limits()));
            app.post_votes = Some(live());
            if both {
                app.post_votes_observe = Some(observer_for(&db, &keys));
            }
            apps.push(Arc::new(app));
        }
        runtime().block_on(async {
            let lane = shadow::Lane::new(1000);
            for app in &apps {
                let id = request_id();
                let body = vote_body("2fixture", 2, VoteChoice::Agree);
                let out = shadow::accept(
                    app.clone(),
                    lane.clone(),
                    copy(&body, Some(member.as_str()), &id),
                )
                .await;
                assert_eq!(out.status, 204);
                let line = observation(&id).await;
                assert_eq!(line["outcome"], "not_observed");
                assert_eq!(line["reason"], "unconfigured");
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        });
        drop(apps);
        assert_eq!(digest(&db.config), before);
    }

    async fn park(pool: &Arc<db::Pool>, size: usize) -> Vec<std::sync::mpsc::Sender<()>> {
        let (ready, mut receive) = tokio::sync::mpsc::unbounded_channel();
        let mut releases = vec![];
        for _ in 0..size {
            let pool = pool.clone();
            let ready = ready.clone();
            let (release, held) = std::sync::mpsc::channel::<()>();
            releases.push(release);
            tokio::spawn(async move {
                let _ = pool
                    .with(move |_| {
                        ready.send(()).unwrap();
                        let _ = held.recv_timeout(Duration::from_secs(30));
                        Ok(())
                    })
                    .await;
            });
        }
        for _ in 0..size {
            tokio::time::timeout(Duration::from_secs(30), receive.recv())
                .await
                .unwrap()
                .unwrap();
        }
        releases
    }

    fn available(pool: &db::Pool) -> Value {
        let health: Value = serde_json::from_str(&js::stringify(&pool.health(true))).unwrap();
        health["available"].clone()
    }

    /// Test 9. The 204 comes back while the observation is still waiting on
    /// the database.
    #[test]
    fn shadow_reply_precedes_database_work() {
        let keys = signing();
        let db = fixture("observe_reply_first");
        let app = shadow_app(connector(&db), Some(observer_for(&db, &keys)));
        runtime().block_on(async {
            let lane = shadow::Lane::new(1000);
            let observer = app.post_votes_observe.as_ref().unwrap();
            let held_reads = park(&observer.reads, 2).await;
            let held_readback = park(&observer.readback, 1).await;
            let before = observer.readback.evidence.snapshot();
            let id = request_id();
            let body = vote_body("2fixture", 2, VoteChoice::Agree);
            let member = token(&keys, "2fixture");
            let out = shadow::accept(
                app.clone(),
                lane.clone(),
                copy(&body, Some(member.as_str()), &id),
            )
            .await;
            assert_eq!(out.status, 204);
            assert_eq!(lane.in_flight(), 1, "the observation is still pending");
            assert!(observation_line(&id).is_none());
            // The observation is waiting for the held readback slot (its anchor).
            tokio::time::timeout(Duration::from_secs(10), async {
                while observer.readback.evidence.snapshot()[1] == before[1] {
                    tokio::time::sleep(Duration::from_millis(1)).await;
                }
            })
            .await
            .unwrap();
            drop(held_reads);
            drop(held_readback);
            let line = observation(&id).await;
            assert_line_shape(&line);
            assert_eq!(lane.in_flight(), 0);
        });
    }

    /// Test 12. Node's stored vote is read back through the storage
    /// convention, anchored on database time, with one retry.
    #[test]
    fn readback_classifies_node_votes() {
        let keys = signing();
        let db = fixture("observe_readback");
        let mut observer = observer_for(&db, &keys);
        observer.timing = observe::ReadbackTiming {
            first: Duration::from_millis(100),
            retry: Duration::from_millis(900),
        };
        let config = db.config.clone();
        runtime().block_on(async move {
            let anchor = observer.anchor().await.unwrap();
            append_now(&config, 4, VoteChoice::Agree).await;
            append_now(&config, 6, VoteChoice::Disagree).await;
            append_now(&config, 7, VoteChoice::Agree).await;
            append_now(&config, 7, VoteChoice::Disagree).await;
            let key = (1, 0);
            for (tid, expected, class, retried) in [
                (4, VoteChoice::Agree, "same", false),
                (6, VoteChoice::Agree, "different", false),
                (7, VoteChoice::Agree, "ambiguous", false),
                (9, VoteChoice::Pass, "absent", true),
            ] {
                let (vote, delay) = observer
                    .read_back(key, tid, expected, anchor, tokio::time::Instant::now())
                    .await;
                assert_eq!(vote.as_str(), class, "{tid}");
                assert_eq!(delay, Some(if retried { 0.9 } else { 0.1 }), "{tid}");
            }
            // A row that appears only after the first try is found by the retry.
            let late_config = config.clone();
            let late = std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(400));
                let mut c = late_config.connect(postgres::NoTls).unwrap();
                append(&mut c, &actor(), &field(10, VoteChoice::Pass)).unwrap();
            });
            let (vote, delay) = observer
                .read_back(
                    key,
                    10,
                    VoteChoice::Pass,
                    anchor,
                    tokio::time::Instant::now(),
                )
                .await;
            late.join().unwrap();
            assert_eq!(vote.as_str(), "same");
            assert_eq!(delay, Some(0.9));
        });
    }

    /// Test 13. Observations waiting for their readback hold no priority
    /// generation and no connection: 128 conversations' generations fill the
    /// cache, and an admission needing a new one succeeds during the wait.
    #[test]
    fn observation_releases_lease_and_connections() {
        let keys = signing();
        let db = Database::new("observe_release");
        db.connect()
            .batch_execute(
                "INSERT INTO users(uid) VALUES(1);
                 INSERT INTO conversations(zid,is_active,modified) SELECT z,true,0 FROM generate_series(1,129) z;
                 INSERT INTO zinvites(zid,zinvite) SELECT z,'c' || z FROM generate_series(1,129) z;
                 ALTER TABLE participants DISABLE TRIGGER USER;
                 INSERT INTO participants(zid,pid,uid) SELECT z,0,1 FROM generate_series(1,129) z;
                 ALTER TABLE participants ENABLE TRIGGER USER;
                 INSERT INTO comments(zid,pid,uid,txt,lang,created)
                 SELECT z,0,1,'Statement ' || z || '.' || t,'en',t FROM generate_series(1,129) z, generate_series(0,2) t ORDER BY z,t;
                 INSERT INTO math_main(zid,math_env,math_tick,last_vote_timestamp,data)
                 SELECT z,'test',0,0,'{\"comment-priorities\":{\"1\":2}}'::jsonb FROM generate_series(1,129) z;",
            )
            .unwrap();
        let mut observer = observer_on(connector(&db), &keys.public);
        observer.timing = observe::ReadbackTiming {
            first: Duration::from_secs(15),
            retry: Duration::from_secs(16),
        };
        let app = shadow_app(connector(&db), Some(observer));
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let observer = app.post_votes_observe.as_ref().unwrap();
            let lane = shadow::Lane::new(1000);
            let mut ids = vec![];
            for zid in 1..=128 {
                let cid = format!("c{zid}");
                let id = request_id();
                let body = vote_body(&cid, 0, VoteChoice::Agree);
                let member = token(&keys, &cid);
                let out = shadow::accept(
                    app.clone(),
                    lane.clone(),
                    copy(&body, Some(member.as_str()), &id),
                )
                .await;
                assert_eq!(out.status, 204);
                // One at a time, so no admission waits on another.
                tokio::time::timeout(Duration::from_secs(10), async {
                    while lane.in_flight() != 0 {
                        tokio::time::sleep(Duration::from_millis(1)).await;
                    }
                })
                .await
                .unwrap();
                ids.push(id);
            }
            tokio::time::timeout(Duration::from_secs(10), async {
                while lane.readback_waiting() != 128 {
                    tokio::time::sleep(Duration::from_millis(1)).await;
                }
            })
            .await
            .expect("every observation waits for its readback");
            assert_eq!(available(&observer.reads), 2, "no reads connection is held");
            assert_eq!(
                available(&observer.readback),
                1,
                "no readback connection is held"
            );
            // An admission for a 129th generation must evict one of the 128.
            let identity = observer
                .verifier
                .verify(
                    &format!("Bearer {}", token(&keys, "c129")),
                    "c129",
                    (crate::clock::now_ms() / 1000.0) as u64,
                )
                .unwrap();
            let cache = observer.priorities.clone();
            let follow_on = observer.follow_on.clone();
            let admitted = observer
                .reads
                .with(move |c| admit(c, "c129", &identity, "test", cache, follow_on))
                .await
                .unwrap()
                .unwrap_or_else(|reason| panic!("the 129th conversation is refused: {reason}"));
            let (_admitted, snapshot) = admitted;
            assert!(
                tokio::task::spawn_blocking(move || snapshot.validate())
                    .await
                    .unwrap()
                    .is_ok(),
                "a waiting observation pinned a priority generation"
            );
            for id in &ids {
                assert!(observation_line(id).is_none(), "still waiting for readback");
            }
        });
        // Dropping the runtime cancels the waiting readbacks.
        drop(runtime);
    }

    /// Test 14. In the main role, a parked writer reads pool does not reach the
    /// routes the same process serves (version and pca2).
    #[test]
    fn shadow_lane_cannot_occupy_other_pools() {
        let keys = signing();
        let db = fixture("observe_isolation");
        db.connect()
            .batch_execute("UPDATE math_main SET data='{\"lastVoteTimestamp\":123,\"n\":2}'::jsonb")
            .unwrap();
        crate::version::initialize();
        let common = db::Pool::new(connector(&db)(), read_limits());
        let mut app = App::new(&cfg(true), common.clone());
        app.version_reads = true;
        app.post_votes = Some(Writer {
            pool: db::Pool::writer(connector(&db)(), read_limits()),
            background: NotificationPool::new(db::Pool::writer(connector(&db)(), read_limits())),
            verifier: participant::Verifier::new(&keys.public, "fixture", "fixture").unwrap(),
            reads: db::Pool::new(connector(&db)(), read_limits()),
            admins: vec![],
            priorities: Arc::default(),
            follow_on: Arc::new(FollowOnLane::default()),
        });
        let app = Arc::new(app);
        runtime().block_on(async {
            let writer = app.post_votes.as_ref().unwrap();
            let held = park(&writer.reads, 2).await;
            let get = |target: &str| Request {
                method: "GET".into(),
                target: target.into(),
                headers: crate::http::Headers::from_raw([("host", "localhost")]),
                body: vec![],
            };
            for _ in 0..3 {
                let version = route::handle(app.clone(), get("/api/v3/version")).await;
                assert_eq!(version.status, 200);
                let pca = route::handle(
                    app.clone(),
                    get("/api/v3/math/pca2?conversation_id=2fixture"),
                )
                .await;
                assert_eq!(pca.status, 200);
                assert_eq!(
                    writer.reads.evidence.snapshot(),
                    [2, 0, 0, 0, 0, 0],
                    "the writer reads pool stays parked"
                );
                assert_eq!(available(&writer.reads), 0);
            }
            assert_eq!(
                common.evidence.snapshot()[2],
                0,
                "pca2 never waited for a common slot"
            );
            drop(held);
        });
    }
}
