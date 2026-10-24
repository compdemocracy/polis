//! Replay every serial capture and concurrent response under its recorded
//! provider configuration. Only the disabled-provider profile is admitted.
use super::{database::*, *};
use crate::http;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::Value;
fn snapshot(c: &mut Client) -> Vec<String> {
    [
        "users",
        "conversations",
        "participants",
        "participants_extended",
        "comments",
        "notification_tasks",
        "votes",
        "votes_latest_unique",
        "zinvites",
        "xids",
    ]
    .iter()
    .map(|table| {
        c.query_one(
            &format!("select coalesce(json_agg(t order by t::text),'[]')::text from {table} t"),
            &[],
        )
        .unwrap()
        .get(0)
    })
    .collect()
}
#[test]
fn recorded_responses_are_exact_or_have_no_mutation_on_handoff() {
    let db = Database::new("replay");
    let mut c = db.connect();
    let rt = runtime();
    let (mut app, key) = setup(&db);
    let writer = app.post_comments.take().unwrap();
    let off = Arc::new(app);
    let (mut on, _) = setup(&db);
    on.post_comments = Some(writer);
    let on = Arc::new(on);
    let mut cases: Vec<(Value, bool)> = Vec::new();
    for (text, disabled) in [
        (
            include_str!("../../../server/characterization/post-comments/golden/cases.json"),
            false,
        ),
        (
            include_str!(
                "../../../server/characterization/post-comments/golden/additional/cases.json"
            ),
            false,
        ),
        (
            include_str!(
                "../../../server/characterization/post-comments/golden/disabled/cases.json"
            ),
            true,
        ),
    ] {
        let values: Vec<Value> = serde_json::from_str(text).unwrap();
        cases.extend(values.into_iter().map(|c| (c, disabled)));
    }
    let concurrent: Vec<Value> = serde_json::from_str(include_str!(
        "../../../server/characterization/post-comments/golden/concurrent.json"
    ))
    .unwrap();
    for pair in concurrent {
        cases.extend(
            pair["responses"]
                .as_array()
                .unwrap()
                .iter()
                .cloned()
                .map(|c| (c, false)),
        );
    }
    assert_eq!(cases.len(), 157);
    let mut exact = 0;
    let mut handed_back = 0;
    for (case, disabled) in cases {
        assert_eq!(
            configuration_enabled(Some("1"), Some(if disabled { "false" } else { "true" })),
            disabled
        );
        db.seed(&mut c);
        let wire = &case["wire"];
        let mut request = signed(&key, case["request"]["body"].clone());
        request.method = case["request"]["method"].as_str().unwrap().into();
        if !wire.is_null() {
            request.target = String::from_utf8(
                STANDARD
                    .decode(wire["request"]["target"]["base64"].as_str().unwrap())
                    .unwrap(),
            )
            .unwrap();
            request.body = wire["request"]["body"]
                .as_array()
                .unwrap()
                .iter()
                .flat_map(|chunk| {
                    STANDARD
                        .decode(chunk["bytes"]["base64"].as_str().unwrap())
                        .unwrap()
                })
                .collect();
        }
        let before = snapshot(&mut c);
        let response = rt.block_on(crate::clock::for_request(
            Some("1700000000000"),
            route::handle(if disabled { on.clone() } else { off.clone() }, request),
        ));
        rt.block_on(async {
            for _ in 0..100 {
                if on
                    .post_comments
                    .as_ref()
                    .unwrap()
                    .background
                    .admitted
                    .available_permits()
                    == 64
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        });
        if !disabled {
            assert_eq!(response.status, 502, "{}", case["case"]);
            assert_eq!(snapshot(&mut c), before, "{}", case["case"]);
            handed_back += 1;
            continue;
        }
        let recorded = &wire["response"];
        let headers = recorded["headers"].as_array().unwrap();
        let date = headers
            .iter()
            .find(|h| h["name"].as_str().unwrap().eq_ignore_ascii_case("date"))
            .unwrap()["value"]
            .as_str()
            .unwrap();
        let actual = http::write_response(&response, false, true, date).unwrap();
        let status = recorded["status"].as_u64().unwrap() as u16;
        let mut expected =
            format!("HTTP/1.1 {status} {}\r\n", http::reason_text(status)).into_bytes();
        for h in headers {
            expected.extend(
                format!(
                    "{}: {}\r\n",
                    h["name"].as_str().unwrap(),
                    h["value"].as_str().unwrap()
                )
                .as_bytes(),
            );
        }
        expected.extend(b"\r\n");
        for chunk in recorded["body"].as_array().unwrap() {
            expected.extend(
                STANDARD
                    .decode(chunk["bytes"]["base64"].as_str().unwrap())
                    .unwrap(),
            );
        }
        assert_eq!(
            String::from_utf8_lossy(&actual),
            String::from_utf8_lossy(&expected)
        );
        let added: String = c
            .query_one(
                "select row_to_json(t)::text from comments t where tid=2 and zid=1",
                &[],
            )
            .unwrap()
            .get(0);
        assert_eq!(
            serde_json::from_str::<Value>(&added).unwrap(),
            case["effects"]["db"]["pg:comments"]["added"][0]
        );
        let tasks: String = c
            .query_one(
                "select row_to_json(t)::text from notification_tasks t where zid=1",
                &[],
            )
            .unwrap()
            .get(0);
        assert_eq!(
            serde_json::from_str::<Value>(&tasks).unwrap(),
            case["effects"]["db"]["pg:notification_tasks"]["added"][0]
        );
        let participant: String = c
            .query_one(
                "select row_to_json(t)::text from participants t where zid=1 and pid=2",
                &[],
            )
            .unwrap()
            .get(0);
        assert_eq!(
            serde_json::from_str::<Value>(&participant).unwrap(),
            case["effects"]["db"]["pg:participants"]["added"][0]
        );
        assert_eq!(
            c.query_one("select count(*) from votes", &[])
                .unwrap()
                .get::<_, i64>(0),
            0
        );
        exact += 1;
    }
    assert_eq!((exact, handed_back), (1, 156));
    println!(
        "recorded comments: 157 responses, 1 byte-exact and effects-exact, 156 pre-write handbacks (provider enabled)"
    );
}
