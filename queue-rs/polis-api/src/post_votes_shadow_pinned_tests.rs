//! The shadow service as it runs today, pinned byte for byte: the vote
//! observer built, the comment observer off, no read lane. What it prints
//! for a vote copy, what its `/health` says, what it answers a GET, and the
//! pools its startup builds are written out here as literals, so a change to
//! the shadow listener that was meant to add something cannot also change
//! what was there.
//!
//! The literals were taken from the code before the listener learned copies
//! of reads, and this file passes unchanged on that code and on this.
use super::*;

/// The line or body with every value that differs from run to run made the
/// same: the times, and the two counters that belong to the whole process
/// (other tests of this binary move them).
fn settled(printed: &str) -> String {
    let mut out = printed.to_owned();
    for key in [
        "queue_ms",
        "admission_ms",
        "total_ms",
        "duration_ms",
        "headRefused",
        "bodyUnread",
    ] {
        let marker = format!("\"{key}\":");
        let Some(at) = out.find(&marker) else {
            continue;
        };
        let start = at + marker.len();
        let end = out[start..]
            .find(|c: char| !(c.is_ascii_digit() || c == '.'))
            .map_or(out.len(), |n| start + n);
        if end > start {
            out.replace_range(start..end, "0");
        }
    }
    out
}

fn printed_access_line(id_free_marker: &str) -> Option<String> {
    shadow::recorded()
        .into_iter()
        .rev()
        .find(|line| line.contains("\"message\":\"http_request\"") && line.contains(id_free_marker))
}

const ID_NO_TOKEN: &str = "70000000000000000000000000000001";
const ID_SHAPE: &str = "70000000000000000000000000000002";
const ID_PASSED: &str = "70000000000000000000000000000003";
const ID_SHED: &str = "70000000000000000000000000000004";
const ID_NOT_OBSERVED: &str = "70000000000000000000000000000005";

/// The general pool's size when no setting names one.
const GENERAL_POOL_SIZE: u32 = 8;

fn vote_line_literal(env: &str, id: &str, outcome: &str, status: &str, reason: &str) -> String {
    format!(
        "{{\"message\":\"shadow_observation\",\"listener\":\"shadow\",\"service\":\"polis-api-shadow\",\"env\":\"{env}\",\"shadow\":\"votesShadow\",\"route\":\"POST /api/v3/votes\",\"request_id\":\"{id}\",\"outcome\":\"{outcome}\",\"admitted\":0,\"status\":{status},\"reason\":\"{reason}\",\"queue_ms\":{times},\"admission_ms\":null,\"selection_ms\":null,\"total_ms\":{times},\"readback_s\":null,\"zid\":null,\"starred_present\":false,\"lang_present\":false,\"append\":\"not_modelled\",\"follow_on\":null,\"remaining\":null,\"total\":null,\"candidates\":null,\"weights_tick\":null,\"prev\":null,\"node_vote\":\"not_checked\"}}",
        times = if status == "null" { "null" } else { "0" },
    )
}

/// The vote observer's lines, in full.
#[tokio::test]
async fn the_vote_lines_are_these_bytes() {
    let keys = signing();
    let member = token(&keys);
    let app = shadow_app(closed, &keys.public, true, false, 1000);
    let unconfigured = shadow_app(closed, &keys.public, false, false, 1000);
    let lane = shadow::Lane::new(1000);
    for (app, id, body, token, outcome, status, reason) in [
        (
            &app,
            ID_NO_TOKEN,
            vote_body(3, VoteChoice::Agree),
            None,
            "would_hand_back",
            "502",
            "no_token",
        ),
        (
            &app,
            ID_SHAPE,
            "{\"conversation_id\":".to_owned(),
            Some(member.as_str()),
            "would_hand_back",
            "502",
            "shape_json",
        ),
        (
            &unconfigured,
            ID_NOT_OBSERVED,
            vote_body(3, VoteChoice::Agree),
            None,
            "not_observed",
            "null",
            "unconfigured",
        ),
    ] {
        let out = shadow::accept(app.clone(), lane.clone(), vote_copy(&body, token, id)).await;
        assert_eq!(out.status, 204);
        vote_line(id).await;
        assert_eq!(
            settled(&printed_vote_line(id).unwrap()),
            vote_line_literal(app.dd_env(), id, outcome, status, reason)
        );
    }
    // A lane of one copy a second: the second copy is shed.
    let slow = shadow::Lane::new(1);
    for id in [ID_PASSED, ID_SHED] {
        let copy = vote_copy(&vote_body(3, VoteChoice::Agree), None, id);
        assert_eq!(
            shadow::accept(app.clone(), slow.clone(), copy).await.status,
            204
        );
    }
    vote_line(ID_PASSED).await;
    assert_eq!(
        settled(&printed_vote_line(ID_SHED).unwrap()),
        vote_line_literal(app.dd_env(), ID_SHED, "shed", "null", "rate_cap")
    );
    // The listener's own access line for a copy.
    assert_eq!(
        settled(&printed_access_line("\"url\":\"/api/v3/votes\"").unwrap()),
        format!(
            "{{\"level\":\"info\",\"message\":\"http_request\",\"service\":\"polis-api-shadow\",\"listener\":\"shadow\",\"env\":\"{}\",\"http\":{{\"method\":\"POST\",\"url\":\"/api/v3/votes\",\"route\":\"/api/v3/votes\",\"status_code\":204}},\"duration_ms\":0,\"cache\":\"none\",\"db_connect\":{{\"count\":0,\"failed\":0,\"ms\":0.000,\"in_flight\":0}}}}",
            app.dd_env()
        )
    );
}

/// `/health` of the shadow as production runs it, in full.
#[tokio::test]
async fn health_is_these_bytes() {
    let keys = signing();
    let app = shadow_app(closed, &keys.public, true, false, 1000);
    let lane = shadow::Lane::new(8);
    let out = shadow::health(&app, &lane).await;
    assert_eq!(
        out.status, 503,
        "the read-back pool points at a closed port"
    );
    assert_eq!(
        out.headers,
        [
            ("Content-Type".to_owned(), "application/json".to_owned()),
            ("Cache-Control".to_owned(), "no-cache".to_owned()),
            (
                "Content-Length".to_owned(),
                match &out.body {
                    crate::http::Body::Fixed(bytes) => bytes.len().to_string(),
                    _ => panic!("fixed JSON expected"),
                }
            ),
        ]
    );
    let pool = |reachable: bool, limit: u32| {
        format!(
            "{{\"readOnly\":true,\"reachable\":{reachable},\"limit\":{limit},\"available\":{limit},\"acquireTimeoutMs\":100,\"statementTimeoutMs\":100,\"maxLifetimeMs\":300000}}"
        )
    };
    assert_eq!(
        settled(&health_body(out)),
        format!(
            "{{\"role\":\"shadow\",\"status\":\"degraded\",\"version\":\"{version}\",\"commit\":\"{commit}\",\"postVotes\":{{\"enabled\":false,\"mode\":\"observe\",\"observed\":0,\"wouldServe\":0,\"wouldHandBack\":0,\"wouldFail\":0,\"shed\":0,\"notObserved\":0,\"readbackSame\":0,\"readbackAmbiguous\":0,\"readbackDifferent\":0,\"readbackAbsent\":0,\"pools\":{{\"reads\":{reads},\"readback\":{readback}}}}},\"shadow\":{{\"listening\":false,\"address\":null,\"inFlight\":0,\"capacity\":32,\"maxPerSecond\":8,\"readbackWaiting\":0,\"headRefused\":0,\"bodyUnread\":0}}}}",
            version = env!("POLIS_VERSION"),
            commit = env!("GIT_HASH"),
            reads = pool(true, 2),
            readback = pool(false, 1),
        )
    );
}

/// A GET is not a copy of anything this process observes, whatever selector
/// name it carries and whatever its query holds: 404, the same bytes, and no
/// line of any kind.
#[tokio::test]
async fn a_get_is_answered_404_and_leaves_no_line() {
    let keys = signing();
    let member = token(&keys);
    let app = shadow_app(closed, &keys.public, true, false, 1000);
    let lane = shadow::Lane::new(1000);
    let mut ids = vec![];
    for path in ["/api/v3/votes", "/api/v3/comments", "/api/v3/nextComment"] {
        for selector in [
            None,
            Some("votesShadow"),
            Some("commentsShadow"),
            Some("votesReadShadow"),
            Some("commentsReadShadow"),
            Some("nextCommentShadow"),
        ] {
            let id = request_id();
            let target = format!("{path}?conversation_id=2fixture&pid=918273&xid=external918273");
            let req = mirrored("GET", &target, selector, "", Some(member.as_str()), &id);
            let out = shadow::accept(app.clone(), lane.clone(), req).await;
            assert_eq!(out.status, 404, "{path} {selector:?}");
            assert_eq!(
                out.headers,
                [
                    (
                        "Content-Type".to_owned(),
                        "text/plain; charset=utf-8".to_owned()
                    ),
                    ("Content-Length".to_owned(), "10".to_owned()),
                ]
            );
            let crate::http::Body::Fixed(bytes) = out.body else {
                panic!("a fixed body expected")
            };
            assert_eq!(bytes, b"Not Found\n");
            ids.push(id);
        }
    }
    // A vote copy sent after them is observed and printed; by then a line
    // for any of the GETs would have been printed too.
    let last = request_id();
    let copy = vote_copy(&vote_body(3, VoteChoice::Agree), None, &last);
    assert_eq!(
        shadow::accept(app.clone(), lane.clone(), copy).await.status,
        204
    );
    vote_line(&last).await;
    let printed = shadow::recorded();
    for id in &ids {
        assert!(
            printed.iter().all(|line| !line.contains(id.as_str())),
            "a GET left a line"
        );
    }
    for line in &printed {
        assert!(!line.contains("918273"), "a query reached a line: {line}");
    }
    assert_eq!(lane.in_flight(), 0);
    let health: Value =
        serde_json::from_str(&health_body(shadow::health(&app, &lane).await)).unwrap();
    assert_eq!(health["postVotes"]["observed"], 1);
    assert_eq!(health["postVotes"]["shed"], 0);
    assert_eq!(health["postVotes"]["notObserved"], 0);
}

/// The pools the shadow's startup builds from the environment Compose gives
/// it today (the vote observer's switch at observe, the comment observer's
/// empty), with a read route's switch at every value an env file could hold
/// for the main role: the process's general pool and the vote observer's two,
/// each a read-only session, and nothing else.
#[test]
fn the_production_shadow_builds_three_read_only_pools() {
    const CHILD: &str = "POLIS_SHADOW_PINNED_STARTUP_TEST";
    if std::env::var_os(CHILD).is_some() {
        let pools = db::POOLS_BUILT.load(Ordering::SeqCst);
        let writers = db::WRITER_POOLS_BUILT.load(Ordering::SeqCst);
        let built = match shadow::configure() {
            Ok(configured) => {
                let app = &configured.app;
                let observer = app.post_votes_observe.as_ref().unwrap();
                let limits = observer
                    .startup_pools()
                    .iter()
                    .map(|(name, pool)| {
                        format!("{name}={}", crate::js::stringify(&pool.health(true)))
                    })
                    .collect::<Vec<_>>()
                    .join(";");
                format!(
                    "votes=true comments={} live={} read_pools={} participant_reads={} oidc={} general={} {limits}",
                    app.post_comments_observe.is_some(),
                    app.post_votes.is_some() || app.post_comments.is_some(),
                    [
                        &app.votes_read_db,
                        &app.votes_read_auth_db,
                        &app.comments_db,
                        &app.comments_count_db,
                        &app.next_comment_db,
                    ]
                    .iter()
                    .filter(|pool| pool.is_some())
                    .count(),
                    app.participant_verifier.is_some(),
                    app.read_oidc.is_some(),
                    crate::js::stringify(&app.db.health(true)),
                )
            }
            Err(error) => format!("error: {error:#}"),
        };
        println!(
            "PINNED {built} pools={} writers={}",
            db::POOLS_BUILT.load(Ordering::SeqCst) - pools,
            db::WRITER_POOLS_BUILT.load(Ordering::SeqCst) - writers
        );
        return;
    }
    let rsa = openssl::rsa::Rsa::generate(2048).unwrap();
    let pem = String::from_utf8(rsa.public_key_to_pem().unwrap()).unwrap();
    let url = "postgres://postgres@127.0.0.1:9/postgres";
    let compose: Vec<(&str, &str)> = vec![
        ("POLIS_API_ROLE", "shadow"),
        ("POLIS_API_SHADOW_LISTEN", "0.0.0.0:5101"),
        ("POLIS_API_SHADOW_MAX_PER_SECOND", "8"),
        ("POLIS_API_POST_VOTES", "observe"),
        ("POLIS_API_POST_VOTES_DATABASE_URL", url),
        ("POLIS_API_POST_COMMENTS", ""),
        ("POLIS_API_SHADOW_COMMENTS_MAX_PER_SECOND", "5"),
        ("POLIS_API_POST_COMMENTS_DATABASE_URL", url),
        ("TOPICAL_COMMENT_RATIO", "0"),
        ("SHOULD_USE_TRANSLATION_API", "false"),
        ("POLIS_API_WRITER_PRIORITIES_CACHE_BYTES", "134217728"),
        ("JWT_PRIVATE_KEY", ""),
        ("JWT_PRIVATE_KEY_PATH", ""),
        ("JWT_PUBLIC_KEY", pem.as_str()),
        ("POLIS_API_DATABASE_URL", url),
        ("DATABASE_URL", url),
        ("POLIS_API_DB_TRANSPORT", "loopback"),
        ("POLIS_JWT_ISSUER", "fixture"),
        ("POLIS_JWT_AUDIENCE", "fixture"),
        ("MATH_ENV", "prod"),
        ("NODE_ENV", "production"),
        // What a main role would need for its read routes: present in the
        // env file both services read, and not the shadow's to use.
        ("POLIS_API_VOTES_READ_DATABASE_URL", url),
        ("POLIS_API_COMMENTS_DATABASE_URL", url),
        ("POLIS_API_NEXT_COMMENT_DATABASE_URL", url),
    ];
    let pool = |limit: u32, acquire: u32, statement: u32| {
        format!(
            "{{\"readOnly\":true,\"reachable\":true,\"limit\":{limit},\"available\":{limit},\"acquireTimeoutMs\":{acquire},\"statementTimeoutMs\":{statement},\"maxLifetimeMs\":300000}}"
        )
    };
    let expected = format!(
        "PINNED votes=true comments=false live=false read_pools=0 participant_reads=false oidc=false general={} reads={};readback={} pools=3 writers=0",
        pool(GENERAL_POOL_SIZE, 2000, 3000),
        pool(2, 100, 100),
        pool(1, 100, 100)
    );
    for value in [
        None,
        Some(""),
        Some("0"),
        Some("1"),
        Some("true"),
        Some("on"),
    ] {
        let mut command = std::process::Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "post_votes::tests::two_route_shadow::pinned::the_production_shadow_builds_three_read_only_pools",
                "--nocapture",
            ])
            .env_clear()
            .env(CHILD, "1")
            .envs(compose.iter().copied());
        if let Some(value) = value {
            for switch in [
                "POLIS_API_VOTES_READS",
                "POLIS_API_COMMENT_READS",
                "POLIS_API_NEXT_COMMENT_READS",
                "POLIS_API_PARTICIPANT_READS",
            ] {
                command.env(switch, value);
            }
        }
        let output = command.output().unwrap();
        let printed = String::from_utf8_lossy(&output.stdout).into_owned();
        assert!(
            output.status.success(),
            "{value:?}: {printed}{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let line = printed
            .lines()
            .find_map(|line| line.find("PINNED ").map(|at| &line[at..]))
            .unwrap_or_else(|| panic!("{value:?}: no result: {printed}"));
        assert_eq!(line, expected, "{value:?}");
    }
}
