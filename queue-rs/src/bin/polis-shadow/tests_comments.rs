//! Tests of the comment route, of the two routes side by side, and of the
//! rules that hold for both: a window is read only once it has settled, a
//! join is run in slices and never reported from part of its window, and
//! nothing printed names a request, a person, a conversation, a comment or a
//! text. No AWS: fixture lines in each producer's format, the compiled
//! queries run over them through `eval.rs`.
use crate::aws::Window;
use crate::eval::{self, Line};
use crate::query::{self, Agg, Bounds, Key};
use crate::report::{self, Mark, Verdict};
use crate::report_comments::need;
use crate::route::{COMMENTS, Route, SLICE_MAX_REQUESTS, VOTES};
use crate::route_comments as words;
use crate::tests::{
    Case, FakeAws, Fixture, Next, edge, golden_fixtures, id, now, passing_fixture, quiet_metrics,
    reply, run, run_args, window,
};
use crate::{RunArgs, slices, time};
use serde_json::{Value, json};
use std::collections::BTreeSet;

// ------------------------------------------------- the observer's own words

/// The comment observer's tests, which pin its line: the key list in order
/// and every closed set of words.
const OBSERVER_TESTS: &str = include_str!("../../../polis-api/src/post_comments_observe_tests.rs");
/// The observer's document.
const OBSERVER_DOC: &str = include_str!("../../../../docs/post-comments-rust-handler.md");

/// The string literals of a piece of Rust source, in order.
fn literals(source: &str) -> Vec<String> {
    source
        .split('"')
        .skip(1)
        .step_by(2)
        .map(str::to_owned)
        .collect()
}

/// A `const NAME: &[&str] = &[ ... ];` of the observer's tests.
fn observer_list(name: &str) -> Vec<String> {
    let start = OBSERVER_TESTS
        .find(&format!("const {name}: &[&str] = &["))
        .unwrap_or_else(|| panic!("the observer's tests have no list {name}"));
    let rest = &OBSERVER_TESTS[start..];
    let body = &rest[rest.find("&[&str] = &[").unwrap()..rest.find("];").unwrap()];
    // Comments in a list hold no quotes; a word holds none either.
    literals(&body["&[&str] = &[".len()..])
}

/// The closed set the observer's line contract gives one key: the words of
/// its `one_of(&line, "<key>", &[...], ...)`.
fn observer_set(key: &str) -> Vec<String> {
    let contract = &OBSERVER_TESTS[OBSERVER_TESTS.find("fn assert_line_shape").unwrap()..];
    for call in contract.split("one_of(").skip(1) {
        let call = &call[..call.find(");").unwrap()];
        let mut words = literals(call);
        if words.first().map(String::as_str) == Some(key) {
            words.remove(0);
            return words;
        }
    }
    panic!("the observer's line contract has no set for {key}");
}

/// The shadow's `shadow_observation` keys for a comment, in its order.
const COMMENT_KEYS: [&str; 33] = [
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
    "total_ms",
    "readback_s",
    "zid",
    "strict",
    "vote_present",
    "seed_present",
    "body_class",
    "write",
    "text_row",
    "node_comment",
    "node_txt",
    "node_txt_difference",
    "txt_units",
    "node_txt_units",
    "txt_bytes",
    "node_txt_bytes",
    "node_author",
    "node_row",
    "node_lang",
    "node_vote",
];

/// The fixture line, the tool's word lists and the observer cannot drift
/// apart: the 33 keys and every closed set are read from the observer's own
/// tests and compared, and the observer's document names each of them.
#[test]
fn the_comment_line_is_the_observers_key_for_key_and_word_for_word() {
    let strs = |words: &[&str]| words.iter().map(|w| (*w).to_owned()).collect::<Vec<_>>();
    assert_eq!(observer_list("LINE_KEYS"), strs(&COMMENT_KEYS));
    assert_eq!(observer_list("OUTCOMES"), strs(&words::OUTCOMES));
    assert_eq!(observer_list("REASONS"), strs(&words::REASONS));
    for (key, set) in [
        ("body_class", strs(&words::BODY_CLASS)),
        ("text_row", strs(&words::TEXT_ROW)),
        ("node_comment", strs(&words::NODE_COMMENT)),
        ("node_txt", strs(&words::NODE_TXT)),
        ("node_txt_difference", strs(&words::NODE_TXT_DIFFERENCE)),
        ("node_author", strs(&words::NODE_AUTHOR)),
        ("node_row", strs(&words::NODE_ROW)),
        ("node_lang", strs(&words::NODE_LANG)),
        ("node_vote", strs(&words::NODE_VOTE)),
    ] {
        assert_eq!(observer_set(key), set, "{key}");
    }
    // Every word the tool sorts into a class is one of the observer's.
    for (subset, set) in [
        (&words::OBSERVED[..], &words::OUTCOMES[..]),
        (&words::NOT_READ[..], &words::NODE_COMMENT[..]),
        (&words::ROW_DIFFERS[..], &words::NODE_ROW[..]),
        (&words::VOTE_NOT_COMPARED[..], &words::NODE_VOTE[..]),
        (&[words::STRICT][..], &words::REASONS[..]),
    ] {
        for word in subset {
            assert!(set.contains(word), "{word}");
        }
    }
    // The document names every key the tool reads and every class word, as
    // a word of its own.
    let named = |word: &str| {
        OBSERVER_DOC.match_indices(word).any(|(at, _)| {
            let inside = |c: char| c.is_ascii_alphanumeric() || c == '_';
            !OBSERVER_DOC[..at].chars().next_back().is_some_and(inside)
                && !OBSERVER_DOC[at + word.len()..]
                    .chars()
                    .next()
                    .is_some_and(inside)
        })
    };
    for key in COMMENT_KEYS.iter().filter(|key| {
        ![
            "message",
            "listener",
            "service",
            "env",
            "shadow",
            "route",
            "request_id",
            "outcome",
            "write",
            "txt_units",
            "node_txt_units",
            "txt_bytes",
            "node_txt_bytes",
            "node_txt_difference",
        ]
        .contains(key)
    }) {
        assert!(named(key), "the document does not name {key}");
    }
    for word in words::OUTCOMES
        .iter()
        .chain(&words::TEXT_ROW)
        .chain(&words::NODE_COMMENT)
        .chain(&words::NODE_VOTE)
        .chain(&words::ROW_DIFFERS)
        .chain(&words::NODE_TXT_DIFFERENCE)
        .chain(&["strict_moderation", "duplicate", "closed", "no_anchor"])
    {
        assert!(named(word), "the document does not name {word}");
    }
    assert!(OBSERVER_DOC.contains("commentsShadow"));
}

// ---------------------------------------------------------------- producers

const COMMENT_ROUTE: &str = "POST /api/v3/comments";
/// The conversations a fixture's admitted copies are in: this many, numbered
/// from the first. No report prints one of these numbers.
const FIRST_ZID: i64 = 81_001;
const CONVERSATIONS: u64 = 40;
const COMMENT_PATH: &str = "/api/v3/comments";

/// What is planted in fixture lines and must never be printed.
const PLANTED_ADDRESS: &str = "203.0.113.77";
const PLANTED_AGENT: &str = "PlantedAgent/7.7";
const PLANTED_CODE: &str = "7plantedcode";
const PLANTED_TEXT: &str = "a planted comment text";
const PLANTED_NUMBER: i64 = 918_273;

/// nginx's `polis_shadow_edge` line for any shadowed route.
fn edge_of(route: &str, id: &str, at: i64, status: u16) -> (i64, String) {
    (
        at,
        json!({
            "message": "shadow_edge", "listener": "shadow", "service": "nginx-proxy",
            "route": route, "request_id": id, "edge_status": status,
            "edge_upstream_status": status.to_string(), "edge_upstream_s": "0.020",
            "edge_request_s": 0.021, "time": "2026-11-09T10:00:00+00:00"
        })
        .to_string(),
    )
}

/// nginx's `polis_shadow_mirror` line for any shadow.
fn mirror_of(shadow: &str, id: &str, at: i64, status: u16, upstream: &str) -> (i64, String) {
    (
        at,
        json!({
            "message": "shadow_mirror", "listener": "shadow", "service": "nginx-proxy",
            "shadow": shadow, "request_id": id, "mirror_status": status,
            "mirror_upstream_status": upstream,
            "mirror_s": if upstream == "504" { 0.004 } else { 0.001 },
            "time": "2026-11-09T10:00:00+00:00"
        })
        .to_string(),
    )
}

/// Node's `http_request` line as winston writes it, for any method and
/// route: with an address, a user agent and the conversation's code in the
/// URL, as Node's line has them.
fn access_of(
    method: &str,
    path: Option<&str>,
    id: Option<&str>,
    at: i64,
    status: u16,
) -> (i64, String) {
    let mut http = json!({
        "method": method,
        "url": format!("{}?conversation_id={PLANTED_CODE}", path.unwrap_or("/api/v3/unrouted")),
        "status_code": status
    });
    if let Some(path) = path {
        http["route"] = json!(path);
    }
    let mut line = json!({
        "level": if status >= 500 { "error" } else if status >= 400 { "warn" } else { "info" },
        "message": "http_request http_request",
        "service": "server", "env": "prod", "http": http,
        "network": {"client": {"ip": PLANTED_ADDRESS}}, "useragent": PLANTED_AGENT,
        "duration_ms": 18.5, "timestamp": "2026-11-09T10:00:00.012Z"
    });
    if let Some(id) = id {
        line["request_id"] = json!(id);
    }
    (at, line.to_string())
}

/// What a comment observation carries, as the shadow would print it.
#[derive(Clone)]
struct Obs {
    outcome: &'static str,
    admitted: bool,
    status: Option<u16>,
    reason: Option<&'static str>,
    queue_ms: f64,
    readback_s: Option<f64>,
    /// The conversation's number: on an admitted copy's line only.
    zid: Option<i64>,
    strict: Option<bool>,
    vote_present: bool,
    text_row: Option<&'static str>,
    node_comment: &'static str,
    node_txt: Option<&'static str>,
    node_txt_difference: Option<&'static str>,
    node_author: Option<&'static str>,
    node_row: Option<&'static str>,
    node_lang: Option<&'static str>,
    node_vote: &'static str,
}

impl Obs {
    /// The handler would store the comment; Node's own row is as expected.
    fn serve() -> Self {
        Obs {
            outcome: "would_serve",
            admitted: true,
            status: Some(200),
            reason: None,
            queue_ms: 0.4,
            readback_s: Some(2.0),
            zid: Some(FIRST_ZID),
            strict: Some(false),
            vote_present: true,
            text_row: Some("none"),
            node_comment: "own",
            node_txt: Some("same"),
            node_txt_difference: None,
            node_author: Some("same"),
            node_row: Some("as_expected"),
            node_lang: Some("unset"),
            node_vote: "same",
        }
    }
    /// Nothing of Node's own row was read.
    fn unread(mut self, node_comment: &'static str) -> Self {
        self.node_comment = node_comment;
        self.node_txt = None;
        self.node_author = None;
        self.node_row = None;
        self.node_lang = None;
        self.node_vote = "not_checked";
        self
    }
    /// Handed back only because the conversation has strict moderation.
    fn strict() -> Self {
        Obs {
            outcome: "would_hand_back",
            status: Some(502),
            reason: Some("strict_moderation"),
            strict: Some(true),
            ..Obs::serve()
        }
    }
    /// Handed back before admission accepted it.
    fn hand_back(reason: &'static str) -> Self {
        Obs {
            outcome: "would_hand_back",
            admitted: false,
            status: Some(502),
            reason: Some(reason),
            readback_s: None,
            zid: None,
            strict: None,
            text_row: None,
            ..Obs::serve().unread("not_checked")
        }
    }
    /// The handler would answer without writing.
    fn answer(status: u16, reason: &'static str) -> Self {
        Obs {
            outcome: "would_answer",
            status: Some(status),
            reason: Some(reason),
            ..Obs::serve().unread("absent")
        }
    }
    fn duplicate() -> Self {
        Obs {
            text_row: Some("other"),
            ..Obs::answer(409, "duplicate").unread("other")
        }
    }
    /// A copy that was not observed.
    fn unobserved(outcome: &'static str, reason: &'static str) -> Self {
        Obs {
            outcome,
            status: None,
            ..Obs::hand_back(reason)
        }
    }
}

fn observation_line(id: &str, at: i64, o: &Obs) -> (i64, String) {
    let word = |v: Option<&str>| v.map_or(Value::Null, |v| json!(v));
    let different = o.node_txt == Some("different");
    let length = |n: i64| if different { json!(n) } else { Value::Null };
    let values: Vec<(&str, Value)> = vec![
        ("message", json!("shadow_observation")),
        ("listener", json!("shadow")),
        ("service", json!("polis-api-shadow")),
        ("env", json!("prod")),
        ("shadow", json!("commentsShadow")),
        ("route", json!(COMMENT_ROUTE)),
        ("request_id", json!(id)),
        ("outcome", json!(o.outcome)),
        ("admitted", json!(if o.admitted { 1 } else { 0 })),
        ("status", o.status.map_or(Value::Null, |s| json!(s))),
        ("reason", word(o.reason)),
        ("queue_ms", json!(o.queue_ms)),
        ("admission_ms", json!(4.0)),
        ("total_ms", json!(6.0)),
        ("readback_s", o.readback_s.map_or(Value::Null, |s| json!(s))),
        // The observer prints the number only for a copy it admitted.
        (
            "zid",
            o.zid
                .filter(|_| o.admitted)
                .map_or(Value::Null, |z| json!(z)),
        ),
        ("strict", o.strict.map_or(Value::Null, |s| json!(s))),
        ("vote_present", json!(o.vote_present)),
        ("seed_present", json!(false)),
        ("body_class", json!("le_1k")),
        ("write", json!("not_modelled")),
        ("text_row", word(o.text_row)),
        ("node_comment", json!(o.node_comment)),
        ("node_txt", word(o.node_txt)),
        ("node_txt_difference", word(o.node_txt_difference)),
        ("txt_units", length(41)),
        ("node_txt_units", length(40)),
        ("txt_bytes", length(41)),
        ("node_txt_bytes", length(40)),
        ("node_author", word(o.node_author)),
        ("node_row", word(o.node_row)),
        ("node_lang", word(o.node_lang)),
        ("node_vote", json!(o.node_vote)),
    ];
    // Written key by key, in the shadow's order.
    let printed = format!(
        "{{{}}}",
        values
            .iter()
            .map(|(key, value)| format!("{}:{value}", json!(key)))
            .collect::<Vec<_>>()
            .join(",")
    );
    assert_comment_line(&printed);
    (at, printed)
}

/// The keys of a printed line, in the order they were written.
fn printed_keys(printed: &str) -> Vec<&str> {
    let mut keys: Vec<(usize, &str)> = COMMENT_KEYS
        .iter()
        .filter_map(|key| printed.find(&format!("\"{key}\":")).map(|at| (at, *key)))
        .collect();
    keys.sort_unstable();
    keys.into_iter().map(|(_, key)| key).collect()
}

/// The observer's contract for its line, held on every fixture line: exactly
/// its keys in its order, and every value a number, a boolean, null or a word
/// of the closed set the observer's own tests give that key.
fn assert_comment_line(printed: &str) {
    let line: serde_json::Map<String, Value> = serde_json::from_str(printed).unwrap();
    assert_eq!(line.len(), COMMENT_KEYS.len(), "{printed}");
    assert_eq!(printed_keys(printed), COMMENT_KEYS, "{printed}");
    let one_of = |key: &str, set: &[&str], nullable: bool| {
        let value = &line[key];
        assert!(
            (nullable && value.is_null()) || value.as_str().is_some_and(|w| set.contains(&w)),
            "{key}: {printed}"
        );
    };
    one_of("outcome", &words::OUTCOMES, false);
    one_of("reason", &words::REASONS, true);
    one_of("body_class", &words::BODY_CLASS, false);
    one_of("text_row", &words::TEXT_ROW, true);
    one_of("node_comment", &words::NODE_COMMENT, false);
    one_of("node_txt", &words::NODE_TXT, true);
    one_of("node_txt_difference", &words::NODE_TXT_DIFFERENCE, true);
    one_of("node_author", &words::NODE_AUTHOR, true);
    one_of("node_row", &words::NODE_ROW, true);
    one_of("node_lang", &words::NODE_LANG, true);
    one_of("node_vote", &words::NODE_VOTE, false);
    assert!(line["admitted"] == 0 || line["admitted"] == 1);
    // The conversation's number: on an admitted copy's line, and on no other.
    assert_eq!(line["zid"].is_i64(), line["admitted"] == 1, "{printed}");
    assert!(line["zid"].is_i64() || line["zid"].is_null(), "{printed}");
    assert!(line["status"].is_null() || line["status"].is_u64());
    assert!(line["strict"].is_null() || line["strict"].is_boolean());
    assert!(line["vote_present"].is_boolean() && line["seed_present"].is_boolean());
    for key in ["queue_ms", "admission_ms", "total_ms", "readback_s"] {
        assert!(line[key].is_null() || line[key].is_number(), "{key}");
    }
    for key in ["txt_units", "node_txt_units", "txt_bytes", "node_txt_bytes"] {
        assert_eq!(line[key].is_number(), line["node_txt"] == "different");
    }
    assert_eq!(line["shadow"], "commentsShadow");
    assert_eq!(line["route"], COMMENT_ROUTE);
    assert_eq!(line["write"], "not_modelled");
}

// ---------------------------------------------------------------- scenarios

/// One copied comment, by what Node answered and what the shadow printed.
#[derive(Clone, Copy)]
enum C {
    /// Node 200; the handler would store it; Node's row is as expected.
    Plain,
    /// The same, from a client that sends no vote.
    PlainNoVote,
    /// Node 200 in a conversation with strict moderation: handed back, and
    /// read back all the same.
    Strict,
    /// Handed back before admission, Node answering as given.
    HandBack(&'static str, u16),
    /// Node 409; a would-be 409.
    Duplicate,
    /// Node 200; a would-be 409 on a copy observed six seconds late.
    DuplicateLate,
    /// Node 200; a would-be 409 on a copy observed at once.
    DuplicateContradicted,
    /// Node 403; a would-be 403.
    Closed,
    /// Node 401; the prelude would refuse the revoked session.
    Revoked,
    /// The same text twice within five seconds: Node 409, the shadow reads
    /// the first row as this request's own.
    Repeat,
    /// Node 200 and no row with the parsed text ten seconds later.
    Absent,
    /// Node 200 and the row with the text is not this request's.
    OtherRow,
    TextDiffers,
    AuthorDiffers,
    ColumnDiffers,
    LanguageSet,
    VoteDiffers,
    /// Node 200, the comment stored, no author's vote.
    VoteAbsent,
    VoteAmbiguous,
    /// The read-back failed.
    ReadFailed,
    /// More read-backs were waiting than the lane holds.
    NotChecked,
    /// This participant's row with the text, and no anchor to place it by.
    NoAnchor,
    /// Node stored the comment, failed on the vote, and answered 500.
    Node500Stored,
    /// Node answered 500 and stored nothing.
    Node500Nothing,
    /// The handler would store it; Node refused with this status.
    NodeRefused(u16),
    /// Node 409 for a text the shadow found no row for at admission.
    NodeDuplicateUnseen,
    Shed(&'static str),
    NotObserved,
    WouldFail,
    /// Outside the copy's body bound.
    NotCopied,
    /// The shadow is down: nginx answered the copy 502 itself.
    HostAbsent,
    /// Copied, the copy timed out, no observation.
    Uncovered,
    /// Observed, and Node's access line names no route (refused before its
    /// router): no Node line.
    NoNodeLine,
    /// The participant went away (nginx 499); Node finished with 200.
    ClientGone,
    /// A strict-moderation copy whose stored vote differs.
    StrictVoteDiffers,
}

/// One copied comment's lines. The ids come from the fixture's own counter,
/// so comments and votes in one fixture never share one.
fn comment(fx: &mut Fixture, case: C) -> String {
    let n = fx.next;
    fx.next += 1;
    fx.at += 7_000;
    let (t, id) = (fx.at, id(n));
    let lines = &mut fx.lines;
    let both = |status: u16, o: Obs| (status, status, o);
    let (edge, node, o) = match case {
        C::Plain => both(200, Obs::serve()),
        C::PlainNoVote => both(
            200,
            Obs {
                vote_present: false,
                node_vote: "not_sent",
                ..Obs::serve()
            },
        ),
        C::Strict => both(200, Obs::strict()),
        C::HandBack(reason, status) => both(status, Obs::hand_back(reason)),
        C::Duplicate => both(409, Obs::duplicate()),
        C::DuplicateLate => both(
            200,
            Obs {
                queue_ms: 6_000.0,
                ..Obs::duplicate()
            },
        ),
        C::DuplicateContradicted => both(200, Obs::duplicate()),
        C::Closed => both(403, Obs::answer(403, "closed")),
        C::Revoked => both(
            401,
            Obs {
                admitted: false,
                strict: None,
                text_row: None,
                readback_s: None,
                ..Obs::answer(401, "revoked").unread("not_checked")
            },
        ),
        C::Repeat => both(
            409,
            Obs {
                text_row: Some("own"),
                ..Obs::serve()
            },
        ),
        C::Absent => both(
            200,
            Obs {
                readback_s: Some(10.0),
                ..Obs::serve().unread("absent")
            },
        ),
        C::OtherRow => both(200, Obs::serve().unread("other")),
        C::TextDiffers => both(
            200,
            Obs {
                node_txt: Some("different"),
                node_txt_difference: Some("space"),
                ..Obs::serve()
            },
        ),
        C::AuthorDiffers => both(
            200,
            Obs {
                node_author: Some("different"),
                ..Obs::serve()
            },
        ),
        C::ColumnDiffers => both(
            200,
            Obs {
                node_row: Some("mod"),
                ..Obs::serve()
            },
        ),
        C::LanguageSet => both(
            200,
            Obs {
                node_lang: Some("set"),
                ..Obs::serve()
            },
        ),
        C::VoteDiffers => both(
            200,
            Obs {
                node_vote: "different",
                ..Obs::serve()
            },
        ),
        C::VoteAbsent => both(
            200,
            Obs {
                node_vote: "absent",
                readback_s: Some(10.0),
                ..Obs::serve()
            },
        ),
        C::VoteAmbiguous => both(
            200,
            Obs {
                node_vote: "ambiguous",
                ..Obs::serve()
            },
        ),
        C::ReadFailed => both(200, Obs::serve().unread("unavailable")),
        C::NotChecked => both(
            200,
            Obs {
                readback_s: None,
                ..Obs::serve().unread("not_checked")
            },
        ),
        C::NoAnchor => both(
            200,
            Obs {
                outcome: "unknown",
                status: None,
                reason: Some("no_anchor"),
                text_row: Some("unknown"),
                readback_s: None,
                ..Obs::serve().unread("unknown")
            },
        ),
        C::Node500Stored => both(
            500,
            Obs {
                node_vote: "absent",
                readback_s: Some(10.0),
                ..Obs::serve()
            },
        ),
        C::Node500Nothing => both(
            500,
            Obs {
                readback_s: Some(10.0),
                ..Obs::serve().unread("absent")
            },
        ),
        C::NodeRefused(status) => both(
            status,
            Obs {
                readback_s: Some(10.0),
                ..Obs::serve().unread("absent")
            },
        ),
        C::NodeDuplicateUnseen => both(409, Obs::serve().unread("other")),
        C::Shed(reason) => both(200, Obs::unobserved("shed", reason)),
        C::NotObserved => both(200, Obs::unobserved("not_observed", "unconfigured")),
        C::WouldFail => both(
            200,
            Obs {
                outcome: "would_fail",
                status: Some(500),
                ..Obs::hand_back("parameter")
            },
        ),
        C::NotCopied => {
            lines.push(edge_of(COMMENT_ROUTE, &id, t, 200));
            lines.push(mirror_of("commentsShadow", &id, t, 204, ""));
            lines.push(access_of("POST", Some(COMMENT_PATH), Some(&id), t, 200));
            return id;
        }
        C::HostAbsent => {
            lines.push(edge_of(COMMENT_ROUTE, &id, t, 200));
            lines.push(mirror_of("commentsShadow", &id, t, 502, ""));
            lines.push(access_of("POST", Some(COMMENT_PATH), Some(&id), t, 200));
            return id;
        }
        C::Uncovered => {
            lines.push(edge_of(COMMENT_ROUTE, &id, t, 200));
            lines.push(mirror_of("commentsShadow", &id, t, 504, "504"));
            lines.push(access_of("POST", Some(COMMENT_PATH), Some(&id), t, 200));
            return id;
        }
        C::NoNodeLine => {
            lines.push(edge_of(COMMENT_ROUTE, &id, t, 400));
            lines.push(mirror_of("commentsShadow", &id, t, 204, "204"));
            // Node's line for a request refused before its router: no route.
            lines.push(access_of("POST", None, Some(&id), t, 400));
            lines.push(observation_line(
                &id,
                t + 1_000,
                &Obs::hand_back("shape_json"),
            ));
            return id;
        }
        C::ClientGone => (499, 200, Obs::serve()),
        C::StrictVoteDiffers => both(
            200,
            Obs {
                node_vote: "different",
                ..Obs::strict()
            },
        ),
    };
    // Admitted copies are spread over the fixture's conversations in turn.
    let o = Obs {
        zid: o.zid.map(|_| FIRST_ZID + (n % CONVERSATIONS) as i64),
        ..o
    };
    lines.push(edge_of(COMMENT_ROUTE, &id, t, edge));
    lines.push(mirror_of("commentsShadow", &id, t, 204, "204"));
    lines.push(access_of("POST", Some(COMMENT_PATH), Some(&id), t, node));
    let after = o.readback_s.map_or(1_000, |s| (s * 1000.0) as i64 + 500);
    lines.push(observation_line(&id, t + after, &o));
    id
}

/// A fixture of comments alone, with ids of its own.
fn comments_fixture() -> Fixture {
    let mut fx = Fixture::new();
    fx.next = 5_000_000;
    fx
}

/// Enough of every class, and nothing to explain: exactly the minimum of
/// each judged class, and a few of each kind that is never judged.
fn passing_cases() -> Vec<C> {
    let mut cases = vec![];
    // 300 the handler would store, 300 more under strict moderation: 600
    // stored comments read back, 600 votes compared.
    for i in 0..need::WOULD_SERVE {
        cases.push(if i % 50 == 0 { C::ClientGone } else { C::Plain });
    }
    for _ in 0..need::STORED - need::WOULD_SERVE {
        cases.push(C::Strict);
    }
    for _ in 0..need::DUPLICATES {
        cases.push(C::Duplicate);
    }
    for i in 0..370 {
        let (reason, status) = [("moderator", 200), ("token_oidc", 200), ("no_token", 200)][i % 3];
        cases.push(C::HandBack(reason, status));
    }
    cases.extend([
        C::Closed,
        C::Revoked,
        C::Repeat,
        C::DuplicateLate,
        C::VoteAmbiguous,
        C::ReadFailed,
        C::NotChecked,
        C::NoAnchor,
        C::Node500Stored,
        C::Node500Nothing,
        C::NotCopied,
        C::Shed("rate_cap"),
        C::NoNodeLine,
    ]);
    cases
}

fn passing_comments() -> Fixture {
    let mut fx = comments_fixture();
    for case in passing_cases() {
        comment(&mut fx, case);
    }
    fx
}

fn comments(fx: &Fixture) -> FakeAws {
    let mut fake = FakeAws::new(fx);
    fake.route = COMMENTS;
    fake
}

/// A report straight from the compiled queries over a window in one piece:
/// no slices, no stand-in for AWS.
fn whole(route: Route, lines: &[Line]) -> report::Report {
    whole_over(route, lines, window())
}

fn whole_over(route: Route, lines: &[Line], w: Window) -> report::Report {
    let mut results = report::Results::new();
    let stop = crate::route::stop_span(w);
    for q in route.queries() {
        let span = if q.recent { stop } else { w };
        results.insert(
            q.name.into(),
            Ok(eval::run(&q, lines, span.from_s, span.to_s)),
        );
        if q.previous_week {
            let before = span.earlier(crate::tests::WEEK_S);
            results.insert(
                format!("{}_previous", q.name),
                Ok(eval::run(&q, lines, before.from_s, before.to_s)),
            );
        }
    }
    let metrics = quiet_metrics(stop)
        .into_iter()
        .map(|(k, v)| (k, Ok(v)))
        .collect();
    report::build(&report::Inputs {
        route,
        window: w,
        results: &results,
        metrics: &metrics,
    })
}

/// Lines of routes that are neither votes nor comments, and of the comments
/// path under other methods: a third mirrored route's nginx, Node and shadow
/// lines with request ids, and a GET and a PUT on the comments path.
fn other_routes(fx: &mut Fixture) {
    for i in 0..40u64 {
        let id = id(9_000_000 + i);
        let t = window().from_s * 1000 + 90_000 + i as i64 * 11_000;
        fx.lines
            .push(edge_of("POST /api/v3/participationInit", &id, t, 200));
        fx.lines.push(mirror_of("initShadow", &id, t, 204, "204"));
        fx.lines.push(access_of(
            "POST",
            Some("/api/v3/participationInit"),
            Some(&id),
            t,
            200,
        ));
        let mut line: Value =
            serde_json::from_str(&observation_line(&id, t + 2_500, &Obs::serve()).1).unwrap();
        line["shadow"] = json!("initShadow");
        line["route"] = json!("POST /api/v3/participationInit");
        fx.lines.push((t + 2_500, line.to_string()));
        // The comments path, read and moderated: not a comment being posted.
        fx.lines
            .push(access_of("GET", Some(COMMENT_PATH), Some(&id), t, 200));
        fx.lines
            .push(access_of("PUT", Some(COMMENT_PATH), Some(&id), t, 200));
        fx.lines
            .push(access_of("GET", Some("/api/v3/votes"), Some(&id), t, 200));
    }
}

// ---------------------------------------------------------------- the two routes

/// A comment's lines can never be counted in the vote report, nor a vote's
/// in the comment report: each report over a log that holds both routes, and
/// a third, is byte for byte the report over its own route's lines alone.
#[test]
fn neither_route_counts_the_others_lines() {
    let goldens = golden_fixtures();
    let votes = &goldens[1].1;
    let mut own_comments = comments_fixture();
    for case in every_case() {
        comment(&mut own_comments, case);
    }
    let mut mixed = comments_fixture();
    for case in every_case() {
        comment(&mut mixed, case);
    }
    mixed.lines.extend(votes.lines.iter().cloned());
    other_routes(&mut mixed);

    let vote_report = run(&FakeAws::new(votes));
    assert_eq!(run(&FakeAws::new(&mixed)).text, vote_report.text);
    assert_eq!(
        vote_report.text,
        include_str!("fixtures/votes-classes.txt"),
        "the vote report over the mixed log is the report the tool printed before it knew comments"
    );
    let comment_report = run(&comments(&own_comments));
    assert_eq!(run(&comments(&mixed)).text, comment_report.text);
    assert!(
        comment_report
            .text
            .contains("shadowed comments (one nginx line in the window) 37;"),
        "{}",
        comment_report.text
    );

    // And query by query: a route's queries count nothing in a log that
    // holds only the other route's lines and the third's.
    let w = window();
    let mut only_comments = comments_fixture();
    for case in every_case() {
        comment(&mut only_comments, case);
    }
    other_routes(&mut only_comments);
    let mut only_votes = Fixture::new();
    only_votes.lines.extend(votes.lines.iter().cloned());
    other_routes(&mut only_votes);
    for (route, lines) in [
        (VOTES, only_comments.eval_lines()),
        (COMMENTS, only_votes.eval_lines()),
    ] {
        for q in route.queries() {
            for row in eval::run(&q, &lines, w.from_s, w.to_s) {
                for key in ["n", "lines", "ids", "edge_lines"] {
                    assert!(
                        row.get(key).is_none_or(|v| v == "0"),
                        "{} {}: {key} = {:?}",
                        route.key,
                        q.name,
                        row.get(key)
                    );
                }
            }
        }
    }
}

fn every_case() -> Vec<C> {
    vec![
        C::Plain,
        C::PlainNoVote,
        C::Strict,
        C::HandBack("moderator", 200),
        C::HandBack("no_token", 200),
        C::Duplicate,
        C::DuplicateLate,
        C::DuplicateContradicted,
        C::Closed,
        C::Revoked,
        C::Repeat,
        C::Absent,
        C::OtherRow,
        C::TextDiffers,
        C::AuthorDiffers,
        C::ColumnDiffers,
        C::LanguageSet,
        C::VoteDiffers,
        C::VoteAbsent,
        C::VoteAmbiguous,
        C::ReadFailed,
        C::NotChecked,
        C::NoAnchor,
        C::Node500Stored,
        C::Node500Nothing,
        C::NodeRefused(403),
        C::NodeRefused(400),
        C::NodeDuplicateUnseen,
        C::Shed("rate_cap"),
        C::Shed("lane_full"),
        C::NotObserved,
        C::WouldFail,
        C::NotCopied,
        C::HostAbsent,
        C::Uncovered,
        C::NoNodeLine,
        C::ClientGone,
    ]
}

// ---------------------------------------------------------------- the comment report

/// Every outcome and class of the line, once each, and what the join makes
/// of them.
#[test]
fn the_comment_join_classes_every_outcome() {
    let mut fx = comments_fixture();
    for case in every_case() {
        comment(&mut fx, case);
    }
    comment(&mut fx, C::StrictVoteDiffers);
    let w = window();
    let join = eval::run(
        &COMMENTS
            .queries()
            .into_iter()
            .find(|q| q.name == "join")
            .unwrap(),
        &fx.eval_lines(),
        w.from_s,
        w.to_s,
    );
    let total = |key: &str| {
        join.iter()
            .map(|r| r[key].parse::<u64>().unwrap())
            .sum::<u64>()
    };
    let cell = |node: &str, would: Option<&str>, key: &str| {
        join.iter()
            .filter(|r| {
                r.get("http_st").map(String::as_str) == Some(node)
                    && r.get("rust_st").map(String::as_str) == would
            })
            .map(|r| r[key].parse::<u64>().unwrap())
            .sum::<u64>()
    };
    assert_eq!(total("comments"), 38);
    assert_eq!(total("edge_lines"), 38);
    assert_eq!(total("repeated"), 0);
    assert_eq!(total("without_edge"), 0);
    // Not copied 1, the host absent 1, copied and timed out 1.
    assert_eq!(total("copied"), 36);
    assert_eq!(total("not_copied"), 1);
    assert_eq!(total("host_absent"), 1);
    assert_eq!(total("covered"), 35);
    // Every request but the one refused before the router has a Node line;
    // three have no observation, one of them copied.
    assert_eq!(total("node_lines"), 37);
    assert_eq!(total("no_node"), 1);
    assert_eq!(total("no_obs"), 3);
    assert_eq!(total("no_obs_copied"), 1);
    assert_eq!(total("paired"), 34);
    // The participant who went away: nginx 499 beside Node's 200.
    assert_eq!(total("http_edge_mismatch"), 1);
    // Would store, beside Node's 200: Plain, PlainNoVote and ClientGone are
    // clean; eight differ; three were not read.
    assert_eq!(cell("200", Some("200"), "serve"), 14);
    assert_eq!(cell("200", Some("200"), "serve_clean"), 3);
    assert_eq!(cell("200", Some("200"), "serve_diff"), 8);
    // Beside Node's 409: the repeat, and the duplicate the shadow never saw.
    assert_eq!(cell("409", Some("200"), "serve"), 2);
    assert_eq!(cell("409", Some("200"), "serve_any_own"), 1);
    assert_eq!(cell("500", Some("200"), "serve"), 2);
    assert_eq!(cell("500", Some("200"), "serve_own"), 1);
    assert_eq!(cell("403", Some("200"), "serve"), 1);
    assert_eq!(cell("400", Some("200"), "serve"), 1);
    // Would answer: a duplicate agreed, one late, one contradicted, a closed
    // conversation, a revoked session.
    assert_eq!(cell("409", Some("409"), "answer"), 1);
    assert_eq!(cell("200", Some("409"), "answer"), 2);
    assert_eq!(cell("200", Some("409"), "answer_late"), 1);
    assert_eq!(cell("403", Some("403"), "answer"), 1);
    assert_eq!(cell("401", Some("401"), "answer"), 1);
    // Not judged: two hand-backs before admission and two for strict
    // moderation, the copy with no anchor, three not observed, one failing.
    assert_eq!(total("hand"), 4);
    assert_eq!(total("unknown"), 1);
    assert_eq!(total("unobserved"), 3);
    assert_eq!(total("failed"), 1);
    // Read back beside Node's 200: the fourteen and the two strict ones.
    assert_eq!(
        cell("200", Some("200"), "read") + cell("200", Some("502"), "read"),
        16
    );
    assert_eq!(total("read_v_diff"), 2);
    assert_eq!(cell("500", Some("200"), "read_v_absent"), 1);

    let report = run(&comments(&fx));
    if std::env::var_os("POLIS_SHADOW_PRINT").is_some() {
        println!("{}", report.text);
    }
    let text = &report.text;
    for line in [
        "would store the comment (would_serve) 20: agree 3 (Node 200 and its own row stored as the handler would store it); disagree 11 (Node 200 and stored otherwise 8, Node's status contradicts 3); not known 4 (the stored comment or its vote not read 3, the same text twice within five seconds 1, no status on Node's line 0); Node answered 5xx 2 (the comment stored all the same 1)",
        "would answer without writing (would_answer) 5: agree 3 (duplicate 409 1, closed 403 1); Node's status contradicts 1; not known 1 (a would-be duplicate beside Node's 200 on a copy observed more than 2000 ms late 1, the same text twice within five seconds 0, no status on Node's line 0); Node answered 5xx 0",
        "     Node 200    shadow 409    1",
        "     Node 400    shadow 200    1",
        "     Node 403    shadow 200    1",
        "     Node 409    shadow 200    1",
        "stored comments read back where Node answered 200 (would store, or handed back for strict moderation) 16: as the handler would store it 4; otherwise 9 (a column 1, a language set 1, a row that is not this request's 1, no author's vote 1, no row with the text 1, the author 1, the author's vote 2, the text 1); not known 3",
        "the author's vote on those: same 7, different 2, absent 1, not compared 1; a stored vote that differs on any line 2",
        "Node answered 5xx with the comment stored 1 (without its author's vote 1)",
        "paired (one nginx line, one Node access line, one observation) 34; observations with no Node line 1; Node lines with no observation 3 (of them copied 1); Node's status differs from nginx's on 1",
        "paired and not judged: handed back to Node 4, not known for want of an anchor 1, shed or not observed 3, would fail 1",
        "a row with the copy's text at admission (text_row): none 22, own 1, other 3, unknown 1",
        "Node's stored comment, read back (node_comment): own 14, other 5, absent 5, unknown 1, unavailable 1, not_checked 1",
        "stored texts that differ, by kind: space 1, control 0, case 0, truncated 0, other 0",
        "would_fail 1; would-be 5xx other than a hand-back's 502: 1",
        "     409    duplicate                  3",
        "     403    closed                     1",
        "     401    revoked                    1",
        "     strict_moderation          2",
        "     no_anchor                  1",
        "     lane_full                  1",
    ] {
        assert!(text.contains(line), "missing: {line}\n{text}");
    }
    for (name, mark) in [
        ("would serve", Mark::Stop),
        ("would answer", Mark::Stop),
        ("stored comment", Mark::Stop),
        ("author's vote", Mark::Stop),
        ("would-be failures", Mark::Stop),
        ("observed copies", Mark::Short),
        ("coverage", Mark::Miss),
        ("pairing", Mark::Info),
    ] {
        assert_eq!(report.mark(name), Some(mark), "{name}\n{text}");
    }
    assert_eq!(report.verdict, Verdict::Stop);
}

#[test]
fn verdict_pass_at_exactly_the_minimum_counts() {
    let fx = passing_comments();
    let report = run(&comments(&fx));
    assert_eq!(report.verdict, Verdict::Pass, "{}", report.text);
    for c in &report.criteria {
        assert!(
            matches!(c.mark, Mark::Pass | Mark::Info),
            "{} {:?}: {}",
            c.name,
            c.mark,
            c.value
        );
    }
    let text = &report.text;
    for line in [
        "would serve                pass                 agree 300, disagree 0, not known 4, Node 5xx 2; judged 300 (minimum 300)",
        "would answer               pass                 agree 22, contradicted 0, not known 1; duplicates judged 20 (minimum 20)",
        "stored comment             pass                 as the handler would store it 600, otherwise 0, not known 3; a stored text that differs on any line 0; judged 600 (minimum 600)",
        "author's vote              pass                 same 600, different 0 (on any line 0), absent 0, not compared 1; compared 600 (minimum 300)",
        "Enough evidence is a count of judged observations for each class, whatever span of time it takes; no number of days stands in for it.",
        "VERDICT: PASS",
    ] {
        assert!(text.contains(line), "missing: {line}\n{text}");
    }
    assert!(!text.contains("Not enough observations yet"));
}

/// One observation short of a class's minimum is not enough for that class,
/// and the verdict is never PASS: each class by itself.
#[test]
fn a_count_below_its_minimum_is_too_little_evidence_and_never_a_pass() {
    // The passing fixture with one of a kind left out.
    let without = |skip: fn(&C) -> bool| {
        let mut fx = comments_fixture();
        let mut skipped = false;
        for case in passing_cases() {
            if !skipped && skip(&case) {
                skipped = true;
                // Keep the count of observed copies where it was.
                comment(&mut fx, C::HandBack("moderator", 200));
                continue;
            }
            comment(&mut fx, case);
        }
        assert!(skipped);
        run(&comments(&fx))
    };
    for (skip, short, says) in [
        (
            (|c| matches!(c, C::Plain)) as fn(&C) -> bool,
            vec!["would serve", "stored comment"],
            "judged 299 of the 300 needed",
        ),
        (
            |c| matches!(c, C::Strict),
            vec!["stored comment"],
            "judged 599 of the 600 needed",
        ),
        (
            |c| matches!(c, C::Duplicate),
            vec!["would answer"],
            "duplicates judged 19 of the 20 needed",
        ),
    ] {
        let report = without(skip);
        assert_eq!(report.verdict, Verdict::TooLittle, "{}", report.text);
        for c in &report.criteria {
            let expected = if short.contains(&c.name) {
                Mark::Short
            } else if c.mark == Mark::Info {
                Mark::Info
            } else {
                Mark::Pass
            };
            assert_eq!(c.mark, expected, "{}: {}", c.name, c.value);
        }
        assert!(report.text.contains(says), "{says}\n{}", report.text);
        assert!(
            report.text.contains(&format!(
                "Not enough observations yet for: {}. Until each minimum is reached, an agreement share above is a count, not a result, and the verdict cannot be PASS.",
                short.join(", ")
            )),
            "{}",
            report.text
        );
    }
    // Observed copies: the passing fixture without its hand-backs.
    let mut fx = comments_fixture();
    for i in 0..need::WOULD_SERVE {
        comment(&mut fx, if i % 2 == 0 { C::Plain } else { C::PlainNoVote });
    }
    for _ in 0..need::STORED - need::WOULD_SERVE {
        comment(&mut fx, C::Strict);
    }
    for _ in 0..need::DUPLICATES {
        comment(&mut fx, C::Duplicate);
    }
    let report = run(&comments(&fx));
    assert_eq!(report.mark("observed copies"), Some(Mark::Short));
    // Half the plain comments carried no vote: 450 votes compared is enough,
    // and a comment without a vote is stored as expected all the same.
    assert_eq!(
        report.mark("author's vote"),
        Some(Mark::Pass),
        "{}",
        report.text
    );
    assert_eq!(report.mark("stored comment"), Some(Mark::Pass));
    assert_eq!(report.verdict, Verdict::TooLittle);
    assert!(
        report.text.contains("620 of the 1000 needed"),
        "{}",
        report.text
    );
    // No lines at all: too little evidence, never a pass.
    let empty = run(&comments(&comments_fixture()));
    assert_eq!(empty.verdict, Verdict::TooLittle, "{}", empty.text);
}

/// The reviewer's rule (a): a would-be 409 for another's row beside Node's
/// 200 is not known when the copy was observed late, and a disagreement to
/// explain when it was not.
#[test]
fn a_late_copys_duplicate_is_not_known_and_a_prompt_ones_is_a_stop() {
    let mut late = passing_comments();
    for _ in 0..3 {
        comment(&mut late, C::DuplicateLate);
    }
    let report = run(&comments(&late));
    assert_eq!(report.verdict, Verdict::Pass, "{}", report.text);
    assert!(
        report
            .text
            .contains("on a copy observed more than 2000 ms late 4,"),
        "{}",
        report.text
    );
    assert!(
        report
            .text
            .contains("agree 22, contradicted 0, not known 4;")
    );

    let mut prompt = passing_comments();
    comment(&mut prompt, C::DuplicateContradicted);
    let report = run(&comments(&prompt));
    assert_eq!(
        report.mark("would answer"),
        Some(Mark::Stop),
        "{}",
        report.text
    );
    assert!(report.text.contains("     Node 200    shadow 409    1"));
    assert!(report.text.contains("duplicates judged 21 (minimum 20)"));
    assert_eq!(report.verdict, Verdict::Stop);
    // The bound is on the copy's own queue time: two seconds exactly is not late.
    assert_eq!(words::LATE_COPY_MS, 2_000);
}

/// The reviewer's rule (b): no row with the parsed text beside Node's 200 is
/// a definite class and a disagreement to explain, never filed as not known.
#[test]
fn no_stored_row_beside_nodes_200_is_a_disagreement() {
    let mut fx = passing_comments();
    comment(&mut fx, C::Absent);
    let report = run(&comments(&fx));
    assert_eq!(
        report.mark("stored comment"),
        Some(Mark::Stop),
        "{}",
        report.text
    );
    assert_eq!(report.mark("would serve"), Some(Mark::Stop));
    assert!(
        report.text.contains(
            "as the handler would store it 600; otherwise 1 (no row with the text 1); not known 3"
        ),
        "{}",
        report.text
    );
    assert!(report.text.contains("agree 300, disagree 1, not known 4"));
    assert_eq!(report.verdict, Verdict::Stop);
}

/// The reviewer's rule (c): the same text twice within five seconds reads as
/// this request's own row beside Node's 409. Not known: never a disagreement,
/// and never an agreement.
#[test]
fn the_same_text_twice_is_not_known() {
    let base = run(&comments(&passing_comments()));
    let mut fx = passing_comments();
    for _ in 0..5 {
        comment(&mut fx, C::Repeat);
    }
    let report = run(&comments(&fx));
    assert_eq!(report.verdict, Verdict::Pass, "{}", report.text);
    assert!(
        report
            .text
            .contains("the same text twice within five seconds 6, no status on Node's line 0); Node answered 5xx 2"),
        "{}",
        report.text
    );
    // Not one agreement more than without them.
    assert!(base.text.contains("agree 300, disagree 0, not known 4,"));
    assert!(report.text.contains("agree 300, disagree 0, not known 9,"));
    // A Node 409 for a text the shadow found no row for is not this class.
    let mut unseen = passing_comments();
    comment(&mut unseen, C::NodeDuplicateUnseen);
    let report = run(&comments(&unseen));
    assert_eq!(
        report.mark("would serve"),
        Some(Mark::Stop),
        "{}",
        report.text
    );
    assert!(report.text.contains("     Node 409    shadow 200    1"));
}

/// The reviewer's rule (d): unknown, unavailable, ambiguous and "no anchor"
/// are never agreement and never disagreement, however many there are.
#[test]
fn what_is_not_known_is_never_agreement_and_never_disagreement() {
    let base = run(&comments(&passing_comments()));
    let mut fx = passing_comments();
    for _ in 0..200 {
        for case in [
            C::VoteAmbiguous,
            C::ReadFailed,
            C::NotChecked,
            C::NoAnchor,
            C::DuplicateLate,
            C::Repeat,
        ] {
            comment(&mut fx, case);
        }
    }
    let report = run(&comments(&fx));
    // Every judged count is what it was; only "not known" grew.
    for (name, was, is) in [
        (
            "would serve",
            "agree 300, disagree 0, not known 4, Node 5xx 2; judged 300 (minimum 300)",
            "agree 300, disagree 0, not known 804, Node 5xx 2; judged 300 (minimum 300)",
        ),
        (
            "would answer",
            "agree 22, contradicted 0, not known 1; duplicates judged 20 (minimum 20)",
            "agree 22, contradicted 0, not known 201; duplicates judged 20 (minimum 20)",
        ),
        (
            "stored comment",
            "as the handler would store it 600, otherwise 0, not known 3;",
            "as the handler would store it 600, otherwise 0, not known 603;",
        ),
    ] {
        let value = |r: &report::Report| {
            r.criteria
                .iter()
                .find(|c| c.name == name)
                .unwrap()
                .value
                .clone()
        };
        assert!(value(&base).contains(was), "{name}: {}", value(&base));
        assert!(value(&report).contains(is), "{name}: {}", value(&report));
        // Never a stop and never short of a minimum. But a pass over 300
        // judged beside 804 not known says nothing of the 804: where more
        // than one in twenty of a class is not known, it is to be examined.
        assert_eq!(
            report.mark(name),
            Some(if name == "would answer" {
                Mark::Pass
            } else {
                Mark::Miss
            }),
            "{name}"
        );
    }
    assert_eq!(report.verdict, Verdict::Examine, "{}", report.text);
    // At one in twenty it is a pass; one more is to be examined. The passing
    // fixture has 300 judged and 4 not known: 12 more make 16 of 316 (5.06 %),
    // 11 more make 15 of 315 (4.76 %).
    let with_unread = |more: usize| {
        let mut fx = passing_comments();
        for _ in 0..more {
            comment(&mut fx, C::ReadFailed);
        }
        let report = run(&comments(&fx));
        (report.mark("would serve"), report.verdict)
    };
    assert_eq!(with_unread(11), (Some(Mark::Pass), Verdict::Pass));
    assert_eq!(with_unread(12), (Some(Mark::Miss), Verdict::Examine));

    // And they never stand in for evidence: two thousand of them and one
    // short of the plain comments is still too little.
    let mut thin = comments_fixture();
    for _ in 0..need::WOULD_SERVE - 1 {
        comment(&mut thin, C::Plain);
    }
    for _ in 0..500 {
        for case in [C::VoteAmbiguous, C::ReadFailed, C::NotChecked, C::NoAnchor] {
            comment(&mut thin, case);
        }
    }
    let report = run(&comments(&thin));
    assert_eq!(
        report.mark("would serve"),
        Some(Mark::Short),
        "{}",
        report.text
    );
    assert!(report.text.contains("judged 299 of the 300 needed"));
    assert_eq!(report.verdict, Verdict::TooLittle);
}

/// Each definite disagreement is a stop by itself, however much agrees.
#[test]
fn every_definite_disagreement_is_a_stop() {
    for (case, criteria, says) in [
        (
            C::VoteDiffers,
            vec!["author's vote", "stored comment", "would serve"],
            "different 1 (on any line 1)",
        ),
        (
            C::StrictVoteDiffers,
            vec!["author's vote", "stored comment"],
            "different 1 (on any line 1)",
        ),
        (
            C::TextDiffers,
            vec!["stored comment", "would serve"],
            "a stored text that differs on any line 1",
        ),
        (
            C::AuthorDiffers,
            vec!["stored comment", "would serve"],
            "otherwise 1 (the author 1)",
        ),
        (
            C::ColumnDiffers,
            vec!["stored comment", "would serve"],
            "otherwise 1 (a column 1)",
        ),
        (
            C::LanguageSet,
            vec!["stored comment", "would serve"],
            "otherwise 1 (a language set 1)",
        ),
        (
            C::OtherRow,
            vec!["stored comment", "would serve"],
            "otherwise 1 (a row that is not this request's 1)",
        ),
        (
            C::VoteAbsent,
            vec!["stored comment", "would serve"],
            "otherwise 1 (no author's vote 1)",
        ),
        (
            C::NodeRefused(403),
            vec!["would serve"],
            "     Node 403    shadow 200    1",
        ),
        (
            C::NodeRefused(400),
            vec!["would serve"],
            "     Node 400    shadow 200    1",
        ),
        (C::WouldFail, vec!["would-be failures"], "would_fail 1"),
    ] {
        let mut fx = passing_comments();
        comment(&mut fx, case);
        let report = run(&comments(&fx));
        assert_eq!(report.verdict, Verdict::Stop, "{says}\n{}", report.text);
        assert!(report.text.contains(says), "{says}\n{}", report.text);
        for c in &report.criteria {
            let expected = if criteria.contains(&c.name) {
                Mark::Stop
            } else if c.mark == Mark::Info {
                Mark::Info
            } else {
                Mark::Pass
            };
            assert_eq!(c.mark, expected, "{says}: {} {}", c.name, c.value);
        }
    }
    // A stored vote that differs on a line that pairs with nothing is still
    // a stop: the line is the shadow's own reading of the database.
    let mut fx = passing_comments();
    let t = fx.at + 3_000;
    fx.lines.push(observation_line(
        &id(77_000_001),
        t,
        &Obs {
            node_vote: "different",
            ..Obs::serve()
        },
    ));
    let report = run(&comments(&fx));
    assert_eq!(
        report.mark("author's vote"),
        Some(Mark::Stop),
        "{}",
        report.text
    );
    assert!(report.text.contains("different 0 (on any line 1)"));
    assert!(report.text.contains("ids with no nginx line 1"));
}

/// Node's own failure is not the handler's disagreement, and a comment Node
/// stored before failing on its author's vote is its own class.
#[test]
fn a_node_5xx_is_its_own_class() {
    let mut fx = passing_comments();
    for _ in 0..4 {
        comment(&mut fx, C::Node500Stored);
    }
    let report = run(&comments(&fx));
    assert_eq!(report.verdict, Verdict::Pass, "{}", report.text);
    assert!(
        report
            .text
            .contains("Node answered 5xx 6 (the comment stored all the same 5)")
    );
    assert!(
        report
            .text
            .contains("Node answered 5xx with the comment stored 5 (without its author's vote 5)")
    );
}

/// A down shadow, and observations that never came, count against coverage;
/// requests that pair with no Node line or no observation are counted and
/// never judged.
#[test]
fn unpaired_requests_are_counted_and_never_judged() {
    let mut fx = passing_comments();
    for _ in 0..3 {
        comment(&mut fx, C::NoNodeLine);
    }
    for _ in 0..6 {
        comment(&mut fx, C::Uncovered);
    }
    for _ in 0..2 {
        comment(&mut fx, C::HostAbsent);
    }
    let report = run(&comments(&fx));
    assert!(
        report.text.contains(
            "observations with no Node line 4; Node lines with no observation 9 (of them copied 6)"
        ),
        "{}",
        report.text
    );
    assert_eq!(report.mark("coverage"), Some(Mark::Miss));
    assert!(report.text.contains("the shadow's host absent 2,"));
    // The six copies that timed out held the connection 4 ms each: within
    // the copy's bar, so the miss is coverage's alone.
    assert_eq!(
        report.mark("the copy's cost"),
        Some(Mark::Pass),
        "{}",
        report.text
    );
    assert_eq!(report.verdict, Verdict::Examine);
}

// ---------------------------------------------------------------- the window

/// The window rule: a window is read only when it ended at least 310 s ago
/// (10 s for the shadow's second read-back, 300 s for the log's delivery).
/// Nearer the present, nothing is asked of AWS at all.
#[test]
fn a_window_that_has_not_settled_is_refused_before_any_query() {
    assert_eq!(crate::READBACK_MAX_S, 10);
    assert_eq!(crate::DELIVERY_LAG_S, 300);
    assert_eq!(crate::SETTLE_S, 310);
    for route in [VOTES, COMMENTS] {
        let fx = if route.key == "votes" {
            passing_fixture()
        } else {
            passing_comments()
        };
        let mut fake = FakeAws::new(&fx);
        fake.route = route;
        let args = RunArgs {
            route: route.key,
            ..run_args()
        };
        for early in [window().to_s - 3_600, window().to_s, window().to_s + 309] {
            let refused = crate::run(&fake, &args, early, &mut std::io::sink());
            let why = format!(
                "{:#}",
                refused.err().expect("an unsettled window is refused")
            );
            assert!(why.contains("its lines may still be arriving"), "{why}");
            assert!(why.contains("at least 310 s ago"), "{why}");
            assert!(fake.issued.borrow().is_empty(), "a query was issued");
        }
        let settled = crate::run(&fake, &args, window().to_s + 310, &mut std::io::sink());
        assert_eq!(settled.unwrap().verdict, Verdict::Pass);
    }
    // The refusal names the latest end that can be read.
    let why = format!(
        "{:#}",
        crate::settled(
            (0, time::parse("2026-11-10T00:00:00Z").unwrap()),
            time::parse("2026-11-10T00:02:00Z").unwrap()
        )
        .unwrap_err()
    );
    assert!(
        why.contains("The latest --to that can be read now is 2026-11-09T23:56:50Z"),
        "{why}"
    );
}

/// The mistake the rule exists for: the shadow's line is written two or ten
/// seconds after its request, so a window read while its last lines are in
/// delivery holds Node lines whose observations have not arrived. When lines
/// arrive between two of a run's queries, the join is withheld, not printed.
#[test]
fn lines_that_arrive_between_two_queries_withhold_the_join() {
    let fx = passing_comments();
    let mut fake = comments(&fx);
    // Twelve more requests' nginx lines become visible after the fifth
    // query (the count by five minutes) has been answered.
    let at = fx.at + 60_000;
    for i in 0..12 {
        let (t, line) = edge_of(COMMENT_ROUTE, &id(8_000_000 + i), at + i as i64, 200);
        fake.late.push((5, eval::line(t, &line)));
    }
    let report = run(&fake);
    assert!(
        report.text.contains("join: withheld: slice 1 of 1 joined 1015 requests where nginx logged 1003; a result was cut off, or lines were still arriving between the two queries"),
        "{}",
        report.text
    );
    for name in [
        "would serve",
        "would answer",
        "stored comment",
        "author's vote",
        "coverage",
    ] {
        assert_eq!(report.mark(name), Some(Mark::NotEvaluated), "{name}");
    }
    assert_eq!(report.verdict, Verdict::TooLittle);
    assert!(report.text.contains("criteria could not be evaluated"));
}

/// A request whose nginx line is written in the very second the window
/// ends belongs to the next window. A query's time range takes that second
/// in; the count by five minutes and the join both leave the line out, by
/// the same test, so they agree and nothing is withheld.
#[test]
fn a_request_in_the_windows_last_second_is_the_next_windows() {
    // A window that ends between two five-minute marks, after the fixture.
    let w = Window {
        from_s: window().from_s,
        to_s: window().from_s + 3 * 3_600 + 100,
    };
    let mut fx = passing_comments();
    let end = w.to_s * 1000;
    let id = id(8_100_000);
    fx.lines.push(edge_of(COMMENT_ROUTE, &id, end, 200));
    fx.lines
        .push(mirror_of("commentsShadow", &id, end, 204, "204"));
    fx.lines
        .push(access_of("POST", Some(COMMENT_PATH), Some(&id), end, 200));
    fx.lines
        .push(observation_line(&id, end + 2_500, &Obs::serve()));
    let mut fake = comments(&fx);
    fake.window = w;
    fake.metrics = quiet_metrics(w);
    let args = RunArgs {
        route: "comments",
        window: (w.from_s, w.to_s),
        ..run_args()
    };
    let report = crate::run(&fake, &args, w.to_s + 86_400, &mut std::io::sink()).unwrap();
    assert!(
        report
            .text
            .contains("shadowed comments (one nginx line in the window) 1003;"),
        "{}",
        report.text
    );
    assert!(!report.text.contains("withheld"), "{}", report.text);
    for name in ["would serve", "would answer", "stored comment", "coverage"] {
        assert_eq!(report.mark(name), Some(Mark::Pass), "{name}");
    }
}

/// The stop rule's fifth rule compares Node's p99 with the same span a week
/// earlier where both hold at least 20 requests. Comments run at about eight
/// an hour, so for comments the span is a day, not an hour; and when not one
/// span is comparable the rule has read nothing and says so: it is "not
/// evaluated", never a pass.
#[test]
fn the_latency_rule_is_read_by_day_for_comments_and_not_at_all_without_a_comparable_day() {
    let day = 86_400;
    let w = Window {
        from_s: window().from_s,
        to_s: window().from_s + 5 * day,
    };
    // Thirty comments on each of five days, and the same a week earlier (the
    // stand-in copies Node's lines there); on the slow days thirty more of
    // Node's answers take 900 ms.
    let report = |slow_days: &[i64]| {
        let mut fx = comments_fixture();
        for d in 0..5 {
            fx.at = (w.from_s + d * day) * 1000 + 3_600_000;
            for _ in 0..30 {
                comment(&mut fx, C::Plain);
            }
        }
        let mut fake = comments(&fx);
        fake.window = w;
        fake.metrics = quiet_metrics(w);
        for d in slow_days {
            for i in 0..30 {
                let at = (w.from_s + d * day) * 1000 + 7_200_000 + i * 1000;
                let (at, line) = access_of("POST", Some(COMMENT_PATH), None, at, 200);
                assert!(line.contains("\"duration_ms\":18.5"));
                fake.push((
                    at,
                    line.replace("\"duration_ms\":18.5", "\"duration_ms\":900.0"),
                ));
            }
        }
        let args = RunArgs {
            route: "comments",
            window: (w.from_s, w.to_s),
            ..run_args()
        };
        crate::run(&fake, &args, w.to_s + day, &mut std::io::sink()).unwrap()
    };
    let quiet = report(&[]);
    assert!(
        quiet.text.contains("5. comment p99 (Node's duration_ms): 0 of 5 comparable days more than 20 % and 50 ms above a week earlier, longest run 0; stops at 3 in a row"),
        "{}",
        quiet.text
    );
    assert_eq!(quiet.mark("stop rule"), Some(Mark::Pass));
    let two = report(&[1, 2]);
    assert!(
        two.text.contains(
            "2 of 5 comparable days more than 20 % and 50 ms above a week earlier, longest run 2;"
        ),
        "{}",
        two.text
    );
    assert_eq!(two.mark("stop rule"), Some(Mark::Pass));
    let three = report(&[1, 2, 3]);
    assert_eq!(three.mark("stop rule"), Some(Mark::Stop), "{}", three.text);
    assert!(three.text.contains("fired: comment p99, sustained"));
    // Slow days that are not in a row do not stop.
    assert_eq!(report(&[0, 2, 4]).mark("stop rule"), Some(Mark::Pass));

    // Fifteen comments in the window: no day holds twenty in both weeks.
    let mut fx = comments_fixture();
    for _ in 0..15 {
        comment(&mut fx, C::Plain);
    }
    let thin = run(&comments(&fx));
    assert!(
        thin.text.contains("5. comment p99 (Node's duration_ms): no day holds 20 requests in both weeks; the rule is not evaluated"),
        "{}",
        thin.text
    );
    assert_eq!(thin.mark("stop rule"), Some(Mark::NotEvaluated));
    assert!(thin.text.contains("not read: comment p99"), "{}", thin.text);
    // And for votes, by the hour: fifteen votes, no comparable hour.
    let mut votes = Fixture::new();
    for _ in 0..15 {
        votes.vote(90_001, Case::Agree);
    }
    let thin = run(&FakeAws::new(&votes));
    assert!(
        thin.text.contains("5. vote p99 (Node's duration_ms): no hour holds 20 requests in both weeks; the rule is not evaluated"),
        "{}",
        thin.text
    );
    assert_eq!(thin.mark("stop rule"), Some(Mark::NotEvaluated));
}

// ---------------------------------------------------------------- the row limit

#[test]
fn a_window_is_cut_into_slices_of_whole_bins_that_cover_it_once() {
    let w = Window {
        from_s: 1_000_200,
        to_s: 1_003_000,
    };
    // Bins of five minutes; the first begins before the window does.
    let bins = vec![
        (1_000_200, 900),
        (1_000_500, 900),
        (1_000_800, 300),
        (1_001_100, 1_000),
        (1_002_900, 10),
    ];
    let plan = slices::plan(w, &bins, 2_000).unwrap();
    let bounds: Vec<(i64, i64)> = plan.iter().map(|s| (s.from_s, s.to_s)).collect();
    assert_eq!(bounds, [(1_000_200, 1_000_800), (1_000_800, 1_003_000)]);
    let held: Vec<u64> = plan
        .iter()
        .map(|s| slices::expected(w, *s, &bins))
        .collect();
    assert_eq!(held, [1_800, 1_310]);
    let plan = slices::plan(w, &bins, 1_000).unwrap();
    let bounds: Vec<(i64, i64)> = plan.iter().map(|s| (s.from_s, s.to_s)).collect();
    assert_eq!(
        bounds,
        [
            (1_000_200, 1_000_500),
            (1_000_500, 1_000_800),
            (1_000_800, 1_001_100),
            (1_001_100, 1_002_900),
            (1_002_900, 1_003_000)
        ]
    );
    // Everything in one slice when it fits; nothing at all is one slice too.
    assert_eq!(slices::plan(w, &bins, 4_000).unwrap().len(), 1);
    assert_eq!(slices::plan(w, &[], 4_000).unwrap().len(), 1);
    // A bin that alone is over the bound cannot be joined completely.
    let why = slices::plan(w, &[(1_000_500, 4_001)], 4_000).unwrap_err();
    assert!(
        why.contains("one five-minute span holds 4001 requests"),
        "{why}"
    );
    // A bin that begins before the window is counted from the window's start.
    let early = slices::plan(w, &[(1_000_000, 1_500), (1_000_500, 1_500)], 2_000).unwrap();
    assert_eq!(early.len(), 2);
    assert_eq!((early[0].from_s, early[0].to_s), (1_000_200, 1_000_500));
    // Rows add up by group; a group one slice lacks keeps the other's count.
    let row = |edge: &str, n: &str| {
        crate::aws::Row::from([
            ("edge_st".to_owned(), edge.to_owned()),
            ("votes".to_owned(), n.to_owned()),
        ])
    };
    let merged = slices::merge(
        &["edge_st", "rust_st"],
        vec![
            vec![row("200", "5"), row("500", "1")],
            vec![row("200", "7")],
        ],
    );
    assert_eq!(merged, vec![row("200", "12"), row("500", "1")]);
    // Only counts add: a query with a percentile or a maximum is not sliced.
    for route in [VOTES, COMMENTS] {
        for q in route.queries() {
            assert_eq!(q.sliced, q.name == "join", "{}", q.name);
            if q.sliced {
                assert!(q.additive() && q.two_stage(), "{}", q.name);
                assert!(
                    q.stages[1]
                        .aggs
                        .iter()
                        .any(|(name, agg)| *name == slices::TOTAL
                            && matches!(agg, Agg::Total("n_edge_in"))),
                    "{}",
                    q.name
                );
                assert!(
                    route
                        .queries()
                        .iter()
                        .any(|b| b.name == "edge_bins" && b.stages[0].by == [Key::FiveMinutes]),
                    "{}",
                    route.key
                );
            }
        }
    }
}

/// A busy day: 12,500 votes, more request ids than Logs Insights returns
/// rows. The join runs in slices, none holding more than 4,000 requests, and
/// the report is byte for byte the report of a join over the whole day in
/// one piece. In an account that keeps only 10,000 rows of a first stage, the
/// sliced report is still that report, where one query over the day would
/// have lost a fifth of the votes.
#[test]
fn a_busy_day_of_votes_is_joined_completely() {
    let mut fx = Fixture::new();
    for i in 0..12_500u64 {
        // Six seconds apart: 20 hours and 50 minutes of the day.
        fx.at -= 1_000;
        fx.vote(
            73_001 + (i % 60) as i64,
            if i % 500 == 0 {
                Case::Exhausted
            } else {
                Case::Agree
            },
        );
    }
    // At every five-minute mark of the day, where a slice may end: an id
    // nginx logged twice, two seconds either side of the mark, and a Node
    // line whose id nginx never logged, two seconds before it. Each is read
    // by the slices on both sides of a cut, and counted by one.
    let marks = oddities_at_every_mark(
        &mut fx,
        |id, at| {
            vec![
                edge(id, at - 2_000, 200, "0.012"),
                edge(id, at + 2_000, 200, "0.012"),
            ]
        },
        |id, at| reply(id, at - 2_000, 73_001, 200, Some(Next::None)),
    );
    let fake = FakeAws::new(&fx);
    let report = run(&fake);
    let complete = whole(VOTES, &fake.lines);
    assert!(
        complete.text.contains(&format!(
            "shadowed votes (one nginx line in the window) 12500; ids with a line repeated {marks}; Node lines with no nginx line {marks}"
        )),
        "{}",
        complete.text
    );
    assert_eq!(report.text, complete.text);
    assert_eq!(report.verdict, Verdict::Pass, "{}", report.text);
    let asked = fake.asked.borrow();
    let pieces: Vec<_> = asked.iter().filter(|a| a.0 == "join").collect();
    assert_eq!(pieces.len(), 4, "{pieces:?}");
    let w = window();
    for piece in &pieces {
        let held = fx
            .lines
            .iter()
            .filter(|(at, line)| {
                line.contains(r#""message":"shadow_edge""#)
                    && *at >= piece.1 * 1000
                    && *at < piece.2 * 1000
            })
            .count() as u64;
        assert!(held <= SLICE_MAX_REQUESTS, "{held}");
        assert!(piece.1 >= w.from_s && piece.2 <= w.to_s);
    }

    // The account that cuts a first stage at 10,000 rows.
    let mut capped = FakeAws::new(&fx);
    capped.first_stage_cap = Some(10_000);
    assert_eq!(run(&capped).text, complete.text);
    // What one query over the day would have made of it there: 10,000 of the
    // 12,500, caught by the join's own check and withheld, never printed.
    let w = window();
    let mut results = report::Results::new();
    for q in VOTES.queries() {
        results.insert(
            q.name.into(),
            Ok(eval::run_capped(
                &q,
                &capped.lines,
                w.from_s,
                w.to_s,
                Some(10_000),
            )),
        );
    }
    let metrics = quiet_metrics(w)
        .into_iter()
        .map(|(k, v)| (k, Ok(v)))
        .collect();
    let cut = report::build(&report::Inputs {
        route: VOTES,
        window: w,
        results: &results,
        metrics: &metrics,
    });
    assert!(
        cut.text.contains(&format!(
            "the two-stage total of nginx lines (10000) does not match the one-stage count ({}); the joined comparison is withheld",
            12_500 + 2 * marks
        )),
        "{}",
        cut.text
    );
}

/// Ids that are not requests of the window, at every five-minute mark from
/// the fixture's first line to its last: `repeated` gives the nginx lines of
/// an id logged twice around the mark, `unanchored` a line whose id nginx
/// never logged. Returns how many marks there were.
fn oddities_at_every_mark(
    fx: &mut Fixture,
    repeated: impl Fn(&str, i64) -> Vec<(i64, String)>,
    unanchored: impl Fn(&str, i64) -> (i64, String),
) -> u64 {
    let (first, last) = (window().from_s * 1000 + 600_000, fx.at);
    let mut marks = 0;
    let mut at = first;
    while at < last {
        fx.lines.extend(repeated(&id(7_000_000 + marks), at));
        fx.lines.push(unanchored(&id(7_500_000 + marks), at));
        marks += 1;
        at += 300_000;
    }
    marks
}

/// The comment join in slices: 4,400 comments, more than one join query is
/// given, with an id that is not a request of the window at every place a
/// slice may end. The report is the report of the day in one piece.
#[test]
fn a_day_of_comments_in_slices_is_the_day_in_one_piece() {
    let mut fx = comments_fixture();
    for i in 0..4_400u64 {
        fx.at -= 1_000;
        comment(
            &mut fx,
            match i % 40 {
                0 => C::Strict,
                1 => C::Duplicate,
                2 => C::HandBack("moderator", 200),
                3 => C::NoNodeLine,
                4 => C::Uncovered,
                _ => C::Plain,
            },
        );
    }
    let marks = oddities_at_every_mark(
        &mut fx,
        |id, at| {
            vec![
                edge_of(COMMENT_ROUTE, id, at - 2_000, 200),
                edge_of(COMMENT_ROUTE, id, at + 2_000, 200),
            ]
        },
        |id, at| access_of("POST", Some(COMMENT_PATH), Some(id), at - 2_000, 200),
    );
    let fake = comments(&fx);
    let report = run(&fake);
    let complete = whole(COMMENTS, &fake.lines);
    assert!(
        complete.text.contains(&format!(
            "shadowed comments (one nginx line in the window) 4400; ids with a line repeated {marks}; ids with no nginx line {marks}"
        )),
        "{}",
        complete.text
    );
    assert_eq!(report.text, complete.text);
    assert_eq!(
        fake.asked.borrow().iter().filter(|a| a.0 == "join").count(),
        2
    );
}

/// A comments window may be months long, and then holds more five-minute
/// bins than Logs Insights returns rows: the count of requests by five
/// minutes is read thirty days at a time, the pieces cover the window once,
/// and the report is the report of the window in one piece.
#[test]
fn a_long_window_counts_its_requests_thirty_days_at_a_time() {
    let w = Window {
        from_s: window().from_s,
        to_s: window().from_s + 75 * 86_400,
    };
    let pieces: Vec<(i64, i64)> = slices::chunks(w, crate::route::BINS_CHUNK_S)
        .iter()
        .map(|p| (p.from_s, p.to_s))
        .collect();
    let day = 86_400;
    assert_eq!(
        pieces,
        [
            (w.from_s, w.from_s + 30 * day),
            (w.from_s + 30 * day, w.from_s + 60 * day),
            (w.from_s + 60 * day, w.to_s)
        ]
    );
    assert_eq!(
        slices::chunks(window(), crate::route::BINS_CHUNK_S).len(),
        1
    );
    assert_eq!(slices::chunks(w, 0).len(), 1);
    // The passing comments, and as many again 70 days later.
    let mut fx = passing_comments();
    fx.at = (w.from_s + 70 * day) * 1000;
    for case in passing_cases() {
        comment(&mut fx, case);
    }
    // The stop rule is read over the window's last eight days and no
    // further back: the metrics exist for those days only, as five-minute
    // database CPU does not exist for a span months old, and the rule is
    // read whole.
    let stop = crate::route::stop_span(w);
    assert_eq!((stop.from_s, stop.to_s), (w.to_s - 8 * day, w.to_s));
    assert_eq!(
        crate::route::stop_span(window()).from_s,
        window().from_s,
        "a window of eight days or less is read whole"
    );
    let mut fake = comments(&fx);
    fake.window = w;
    fake.metrics = quiet_metrics(stop);
    let args = RunArgs {
        route: "comments",
        window: (w.from_s, w.to_s),
        ..run_args()
    };
    let report = crate::run(&fake, &args, w.to_s + day, &mut std::io::sink()).unwrap();
    let complete = whole_over(COMMENTS, &fake.lines, w);
    assert_eq!(report.text, complete.text);
    assert!(
        report
            .text
            .contains("shadowed comments (one nginx line in the window) 2006;"),
        "{}",
        report.text
    );
    assert_eq!(
        report.mark("stop rule"),
        Some(Mark::Pass),
        "{}",
        report.text
    );
    assert!(
        report.text.contains(
            "   read over the last 8 days of the window, 2027-01-15T00:00:00Z to 2027-01-23T00:00:00Z:"
        ),
        "{}",
        report.text
    );
    assert!(report.text.contains("0 of 1 comparable days"));
    let asked = fake.asked.borrow();
    let bins: Vec<(i64, i64)> = asked
        .iter()
        .filter(|a| a.0 == "edge_bins")
        .map(|a| (a.1, a.2))
        .collect();
    assert_eq!(bins, pieces);
    // Node's lines for the stop rule: the last eight days, and the eight
    // before them a week earlier; every other query the whole window.
    let node: Vec<(i64, i64)> = asked
        .iter()
        .filter(|a| a.0 == "node_requests")
        .map(|a| (a.1, a.2))
        .collect();
    assert_eq!(
        node,
        [
            (stop.from_s, stop.to_s),
            (stop.from_s - 7 * day, stop.to_s - 7 * day)
        ]
    );
    assert!(
        asked
            .iter()
            .filter(|a| a.0 == "mirror_hours" || a.0 == "observations")
            .all(|a| (a.1, a.2) == (w.from_s, w.to_s))
    );
    drop(asked);
    // A piece that may be cut off spoils the count, and the join is not run.
    let mut fake = comments(&fx);
    fake.window = w;
    fake.metrics = quiet_metrics(stop);
    fake.resize = Some(("edge_bins", 10_000));
    let report = crate::run(&fake, &args, w.to_s + day, &mut std::io::sink()).unwrap();
    assert!(
        report
            .text
            .contains("is not usable (its result may be cut off)")
    );
    // The route's bound is on what a run reads; it is no measure of evidence.
    assert!(
        crate::parse_args(
            "run --route comments --from 2026-08-01T00:00:00Z --to 2026-11-01T00:00:00Z --log-group g --db-instance d --load-balancer l"
                .split_whitespace()
                .map(str::to_owned)
        )
        .is_ok()
    );
}

/// A result that reaches the most rows Logs Insights returns may be cut off:
/// the report says so and reports nothing from it, for either route, whether
/// the result is a one-stage query's or a slice of the join.
#[test]
fn a_result_that_may_be_cut_off_is_said_to_be_and_not_reported() {
    for (route, fx) in [(VOTES, passing_fixture()), (COMMENTS, passing_comments())] {
        let mut fake = FakeAws::new(&fx);
        fake.route = route;
        fake.resize = Some(("observations", 10_000));
        let report = run(&fake);
        assert!(
            report.text.contains("observations: 10000 rows, the most Logs Insights returns; the result may be cut off"),
            "{}",
            report.text
        );
        assert_eq!(report.mark("would-be failures"), Some(Mark::NotEvaluated));
        assert_eq!(report.verdict, Verdict::TooLittle);

        let mut fake = FakeAws::new(&fx);
        fake.route = route;
        fake.resize = Some(("join", 10_000));
        let report = run(&fake);
        assert!(
            report.text.contains("join: slice 1 of ")
                && report.text.contains(
                    ": 10000 rows, the most Logs Insights returns; the result may be cut off"
                ),
            "{}",
            report.text
        );
        assert_eq!(report.verdict, Verdict::TooLittle);

        // The count the slices are planned from, cut off: the join is not run.
        let mut fake = FakeAws::new(&fx);
        fake.route = route;
        fake.resize = Some(("edge_bins", 10_000));
        let report = run(&fake);
        assert!(
            report.text.contains("join: not run: the count of requests by five minutes, which the slices are planned from, is not usable (its result may be cut off)"),
            "{}",
            report.text
        );
        assert!(!fake.asked.borrow().iter().any(|a| a.0 == "join"));
        assert_eq!(report.verdict, Verdict::TooLittle);
    }
    // More requests in five minutes than one join query is given: not run,
    // and said so, never joined in part.
    let mut fx = comments_fixture();
    for _ in 0..SLICE_MAX_REQUESTS + 1 {
        fx.at -= 6_950;
        comment(&mut fx, C::Plain);
    }
    let report = run(&comments(&fx));
    assert!(
        report.text.contains("join: not run: the count of requests by five minutes, which the slices are planned from, is not usable (one five-minute span holds 4001 requests, more than the 4000 a join query is given, so the join would be cut off)"),
        "{}",
        report.text
    );
    assert_eq!(report.verdict, Verdict::TooLittle);
}

/// `report` reads a join saved in slices and adds them up.
#[test]
fn report_adds_up_a_join_saved_in_slices() {
    let fx = passing_comments();
    let fake = comments(&fx);
    let from_run = run(&fake);
    let w = window();
    let dir = std::env::temp_dir().join(format!("polis-shadow-slices-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let save = |name: &str, rows: &[crate::aws::Row]| {
        let results: Vec<Value> = rows
            .iter()
            .map(|row| {
                Value::Array(
                    row.iter()
                        .map(|(k, v)| json!({"field": k, "value": v}))
                        .collect(),
                )
            })
            .collect();
        std::fs::write(
            dir.join(format!("{name}.json")),
            json!({"status": "Complete", "results": results}).to_string(),
        )
        .unwrap();
    };
    let half = (w.from_s + w.to_s) / 2;
    for q in COMMENTS.queries() {
        if q.sliced {
            save("join.0", &eval::run(&q, &fake.lines, w.from_s, half));
            save("join.1", &eval::run(&q, &fake.lines, half, w.to_s));
            continue;
        }
        save(q.name, &eval::run(&q, &fake.lines, w.from_s, w.to_s));
        if q.previous_week {
            let before = w.earlier(crate::tests::WEEK_S);
            save(
                &format!("{}_previous", q.name),
                &eval::run(&q, &fake.lines, before.from_s, before.to_s),
            );
        }
    }
    for (name, points) in quiet_metrics(w) {
        let key = if name.starts_with("lb") {
            "ExtendedStatistics"
        } else if name == "db_cpu" {
            "Average"
        } else {
            "Sum"
        };
        let points: Vec<Value> = points
            .iter()
            .map(|(t, v)| {
                let value = if key == "ExtendedStatistics" {
                    json!({"p99": v})
                } else {
                    json!(v)
                };
                json!({"Timestamp": time::format(*t), key: value})
            })
            .collect();
        std::fs::write(
            dir.join(format!("metric-{name}.json")),
            json!({"Datapoints": points}).to_string(),
        )
        .unwrap();
    }
    let report = crate::report_from(COMMENTS, &dir, (w.from_s, w.to_s)).unwrap();
    assert_eq!(report.text, from_run.text);
    // A saved slice that is not a result, or one whose status holds anything
    // at all, is reported without a word of the file.
    std::fs::write(dir.join("join.1.json"), format!("not json {PLANTED_TEXT}")).unwrap();
    std::fs::write(
        dir.join("facts.json"),
        json!({"status": PLANTED_TEXT, "results": []}).to_string(),
    )
    .unwrap();
    let report = crate::report_from(COMMENTS, &dir, (w.from_s, w.to_s)).unwrap();
    std::fs::remove_dir_all(&dir).unwrap();
    assert!(
        report
            .text
            .contains("join: slice 2: not a get-query-results output"),
        "{}",
        report.text
    );
    assert!(
        report
            .text
            .contains("facts: saved with a status that is not Complete")
    );
    assert!(!report.text.contains(PLANTED_TEXT));
    assert_eq!(report.verdict, Verdict::TooLittle);
}

// ---------------------------------------------------------------- privacy

/// Nothing the tool prints names a request, an address, a user agent, a
/// conversation, a comment, a participant or a text: not in either report,
/// not in what `run` prints as it goes, not in a refusal, not in the queries
/// it lists. Planted in the log: every request id, an address and a user
/// agent and a conversation's code on Node's lines, conversation numbers on
/// the vote lines, and lines that carry what no real line does (a comment
/// number, a participant number, a text, a number where a class word or a
/// status belongs).
#[test]
fn nothing_planted_in_the_log_is_ever_printed() {
    let mut fx = comments_fixture();
    for case in every_case() {
        comment(&mut fx, case);
    }
    for case in [
        Case::Agree,
        Case::Exhausted,
        Case::HandBack("no_token"),
        Case::Shed,
        Case::Cors,
        Case::ClosedDisagree,
    ] {
        fx.vote(PLANTED_NUMBER, case);
    }
    other_routes(&mut fx);
    // Lines no producer writes: each route's observation with a conversation,
    // a comment and a participant number and a text added, and with a text or
    // a number where a word of a closed set belongs.
    let mut ids = vec![];
    for (i, shadow) in ["commentsShadow", "votesShadow"].into_iter().enumerate() {
        for (j, field) in [
            "reason",
            "outcome",
            "node_row",
            "node_comment",
            "text_row",
            "node_vote",
            "body_class",
            "status",
            "node_txt_difference",
        ]
        .into_iter()
        .enumerate()
        {
            let n = 6_000_000 + (i * 100 + j) as u64;
            fx.at += 7_000;
            let (t, id) = (fx.at, id(n));
            ids.push(id.clone());
            let route = if i == 0 {
                COMMENT_ROUTE
            } else {
                "POST /api/v3/votes"
            };
            let path = if i == 0 {
                COMMENT_PATH
            } else {
                "/api/v3/votes"
            };
            fx.lines.push(edge_of(route, &id, t, 200));
            fx.lines.push(mirror_of(shadow, &id, t, 204, "204"));
            fx.lines
                .push(access_of("POST", Some(path), Some(&id), t, 200));
            let mut line: Value =
                serde_json::from_str(&observation_line(&id, t + 2_500, &Obs::serve()).1).unwrap();
            line["shadow"] = json!(shadow);
            line["route"] = json!(route);
            line["zid"] = json!(PLANTED_NUMBER);
            line["tid"] = json!(PLANTED_NUMBER + 1);
            line["pid"] = json!(PLANTED_NUMBER + 2);
            line["txt"] = json!(PLANTED_TEXT);
            if field == "reason" {
                // A reason is printed for a hand-back.
                line["outcome"] = json!("would_hand_back");
            }
            line[field] = if j % 2 == 0 {
                json!(PLANTED_TEXT)
            } else {
                json!(PLANTED_NUMBER + 3)
            };
            if field != "node_txt_difference" {
                line["node_txt"] = json!("different");
                line["node_txt_difference"] = json!(PLANTED_TEXT);
            }
            line["txt_units"] = json!(PLANTED_NUMBER + 4);
            line["node_txt_bytes"] = json!(PLANTED_NUMBER + 5);
            fx.lines.push((t + 2_500, line.to_string()));
        }
    }
    let mut planted: BTreeSet<String> = (0..10).map(|k| (PLANTED_NUMBER + k).to_string()).collect();
    planted.extend(
        [
            PLANTED_ADDRESS,
            PLANTED_AGENT,
            PLANTED_CODE,
            PLANTED_TEXT,
            "planted",
            "Planted",
        ]
        .map(str::to_owned),
    );
    planted.extend(ids);
    for (_, line) in &fx.lines {
        let value: Value = serde_json::from_str(line).unwrap();
        if let Some(id) = value["request_id"].as_str() {
            planted.insert(id.to_owned());
        }
    }
    assert!(planted.len() > 100);

    let mut printed = String::new();
    for route in [VOTES, COMMENTS] {
        let mut fake = FakeAws::new(&fx);
        fake.route = route;
        let args = RunArgs {
            route: route.key,
            ..run_args()
        };
        let mut progress: Vec<u8> = vec![];
        let report = crate::run(&fake, &args, now(), &mut progress).unwrap();
        printed.push_str(&report.text);
        for c in &report.criteria {
            printed.push_str(&c.value);
        }
        printed.push_str(&String::from_utf8(progress).unwrap());
        // The same log with every result withheld, cut off or refused.
        for (query, length) in [
            ("join", 10_000),
            ("edge_bins", 10_000),
            ("readback", 10_000),
        ] {
            let mut fake = FakeAws::new(&fx);
            fake.route = route;
            fake.resize = Some((query, length));
            printed.push_str(&run(&fake).text);
        }
        let mut fake = FakeAws::new(&fx);
        fake.route = route;
        fake.refuse_two_stage = true;
        printed.push_str(&run(&fake).text);
        let refused = crate::run(&fake, &args, window().to_s, &mut std::io::sink());
        printed.push_str(&format!("{:#}", refused.err().unwrap()));
        for q in route.queries() {
            printed.push_str(&q.text(Bounds::Placeholders));
            printed.push_str(q.about);
        }
        printed.push_str(&whole(route, &fake.lines).text);
    }
    assert!(printed.len() > 20_000);
    for value in &planted {
        assert!(!printed.contains(value.as_str()), "printed: {value}");
    }
    // What stood where a word belonged was counted, not printed.
    assert!(printed.contains("(unrecognised)"), "{printed}");
    assert!(printed.contains("(not a reason word)"));
    // No run of 32 hex digits anywhere: no request id of any kind.
    let hex: Vec<&str> = printed
        .split(|c: char| !c.is_ascii_hexdigit())
        .filter(|run| run.len() >= 32)
        .collect();
    assert!(hex.is_empty(), "{hex:?}");
}

/// The comment queries read the fields the comparison needs and no other:
/// no conversation, comment, participant or user number, no text, no address
/// or user agent, no URL, none of the text's lengths. The request id is read
/// only to require one and to group a first stage, which stays in AWS.
#[test]
fn the_comment_queries_read_only_the_fields_they_need() {
    let needed: BTreeSet<&str> = BTreeSet::from([
        // What says whose a line is.
        "message",
        "listener",
        "service",
        "shadow",
        "route",
        "http.method",
        "http.route",
        "request_id",
        // nginx.
        "edge_status",
        "edge_upstream_s",
        "edge_request_s",
        "mirror_status",
        "mirror_upstream_status",
        "mirror_s",
        // Node.
        "http.status_code",
        "duration_ms",
        // The shadow.
        "outcome",
        "admitted",
        "status",
        "reason",
        "queue_ms",
        "admission_ms",
        "total_ms",
        "readback_s",
        // The conversation's number: counted, never returned.
        "zid",
        "strict",
        "vote_present",
        "seed_present",
        "body_class",
        "text_row",
        "node_comment",
        "node_txt",
        "node_txt_difference",
        "node_author",
        "node_row",
        "node_lang",
        "node_vote",
    ]);
    let mut read: BTreeSet<&str> = BTreeSet::new();
    for q in COMMENTS.queries() {
        assert_eq!(query::refusal(&q), None, "{}", q.name);
        let mut defined: BTreeSet<&str> = q.fields.iter().map(|(name, _)| *name).collect();
        let mut names = query::names(&q.filter);
        for (i, stage) in q.stages.iter().enumerate() {
            let mut here = vec![];
            for (_, agg) in &stage.aggs {
                match agg {
                    Agg::Count => {}
                    Agg::Sum(e) => here.extend(query::names(e)),
                    Agg::Max(f)
                    | Agg::Min(f)
                    | Agg::Total(f)
                    | Agg::Pct(f, _)
                    | Agg::CountDistinct(f) => here.push(*f),
                }
            }
            for key in &stage.by {
                if let Key::Field(name) = key {
                    here.push(*name);
                    // The request id groups a first stage and nothing else.
                    assert!(
                        *name != "request_id" || (i == 0 && q.two_stage()),
                        "{}",
                        q.name
                    );
                }
            }
            names.extend(here.into_iter().filter(|name| !defined.contains(name)));
            defined.extend(stage.aggs.iter().map(|(name, _)| *name));
        }
        read.extend(names);
        // The request id appears only where a line must have one and where
        // a first stage groups by it.
        let text = q
            .text(Bounds::Placeholders)
            .replace("ispresent(request_id)", "")
            .replace(" by request_id\n", "\n");
        assert!(!text.contains("request_id"), "{}: {text}", q.name);
    }
    assert_eq!(
        read,
        needed,
        "\nread and not needed: {:?}\nneeded and not read: {:?}",
        read.difference(&needed).collect::<Vec<_>>(),
        needed.difference(&read).collect::<Vec<_>>()
    );
    // The conversation's number is read by one query, and only to count:
    // how many admitted lines carry one, and how many distinct ones. It is
    // never a filter's value, a group key, a maximum or a minimum, so no
    // conversation's number is in any row a query returns.
    for q in COMMENTS.queries() {
        let text = q.text(Bounds::Placeholders);
        if q.name == "conversations" {
            assert_eq!(text.matches("zid").count(), 2, "{text}");
            assert!(
                text.contains(
                    "sum(ispresent(zid)) as named, count_distinct(zid) as conversations\n"
                ),
                "{text}"
            );
            assert!(q.stages.iter().all(|stage| stage.by.is_empty()), "{text}");
        } else {
            assert!(!text.contains("zid"), "{}: {text}", q.name);
        }
    }
    for never in [
        "tid",
        "pid",
        "uid",
        "xid",
        "txt",
        "vote",
        "useragent",
        "network.client.ip",
        "http.url",
        "txt_units",
        "node_txt_units",
        "txt_bytes",
        "node_txt_bytes",
        "env",
        "write",
    ] {
        assert!(!read.contains(never), "{never}");
    }
    // And the allowlist refuses a query that would bring a length out.
    for field in ["txt_units", "node_txt_units", "txt_bytes", "node_txt_bytes"] {
        let q = query::Query {
            name: "bad",
            about: "",
            filter: query::is("listener", "shadow"),
            fields: vec![],
            stages: vec![query::Stats {
                aggs: vec![("n", Agg::Sum(query::num_is(field, 41)))],
                by: vec![],
            }],
            pad_s: 0,
            previous_week: false,
            recent: false,
            chunk_s: 0,
            sliced: false,
        };
        assert!(query::refusal(&q).is_some(), "{field}");
    }
}

/// The comment report as a reader sees it, on the fixture of every outcome
/// beside enough of the ordinary ones: printed when the tests run with
/// `POLIS_SHADOW_PRINT=1 --nocapture`, and in any case free of anything but
/// counts, classes and the tool's own words.
#[test]
fn the_comment_report_on_the_passing_fixture() {
    let report = run(&comments(&passing_comments()));
    if std::env::var_os("POLIS_SHADOW_PRINT").is_some() {
        println!("{}", report.text);
    }
    assert!(report.text.starts_with(
        "polis-shadow: POST /api/v3/comments (commentsShadow)\nwindow: 2026-11-09T00:00:00Z to 2026-11-10T00:00:00Z (UTC, end excluded)\n"
    ));
    for heading in [
        "\n1. Lines in the window\n",
        "\n2. The copy (nginx)\n",
        "\n3. Node's answers to shadowed comments, as nginx saw them\n",
        "\n4. The shadow's observations\n",
        "\n5. What the shadow read in the database (admitted copies)\n",
        "\n6. Paired with Node by request id\n",
        "\n7. The shadow's latency on admitted copies (the write is not modelled)\n",
        "\n8. The stop rule\n",
        "\n9. Criteria\n",
        "\nWhat this cannot show:\n",
    ] {
        assert!(report.text.contains(heading), "{heading}");
    }
    for limit in [
        "no line carries a comment number",
        "No class is counted by conversation",
        "it reads only as no row beside Node's 200",
        "Email and notifications",
    ] {
        assert!(report.text.contains(limit), "{limit}");
    }
    assert!(
        report
            .text
            .contains("4. comment errors (Node's 5xx on POST /api/v3/comments): 2 of 1002 (0.20 %) against 2 of 1002 (0.20 %) a week earlier: within it")
    );
}

/// A fixture's lines with each observation of an admitted comment copy
/// rewritten, or left alone when `change` answers no.
fn rewritten(fx: &Fixture, mut change: impl FnMut(usize, &mut Value) -> bool) -> (Fixture, usize) {
    let mut out = Fixture {
        lines: fx.lines.clone(),
        next: fx.next,
        at: fx.at,
    };
    let (mut admitted, mut changed) = (0, 0);
    for (_, json) in &mut out.lines {
        let mut line: Value = serde_json::from_str(json).unwrap();
        if line["message"] != "shadow_observation" || line["admitted"] != 1 {
            continue;
        }
        admitted += 1;
        if change(admitted, &mut line) {
            *json = line.to_string();
            changed += 1;
        }
    }
    (out, changed)
}

/// How many conversations the admitted copies are in is counted and reported
/// with no threshold, and no conversation's number is printed.
#[test]
fn admitted_copies_are_counted_by_the_conversations_they_span() {
    let fx = passing_comments();
    let (_, admitted) = rewritten(&fx, |_, _| true);
    let report = run(&comments(&fx));
    assert_eq!(report.verdict, Verdict::Pass, "{}", report.text);
    assert!(
        report.text.contains(&format!(
            "\n   admitted copies span {CONVERSATIONS} conversations\n"
        )),
        "{}",
        report.text
    );
    let value = |report: &report::Report| {
        report
            .criteria
            .iter()
            .find(|c| c.name == "conversations")
            .map(|c| c.value.clone())
    };
    assert_eq!(report.mark("conversations"), Some(Mark::Info));
    assert_eq!(
        value(&report),
        Some(format!(
            "{admitted} admitted copies across {CONVERSATIONS} conversations"
        ))
    );
    for zid in FIRST_ZID..FIRST_ZID + CONVERSATIONS as i64 {
        assert!(!report.text.contains(&zid.to_string()), "{zid}");
    }
    // Every admitted copy in one conversation: said, and no threshold.
    let (one, _) = rewritten(&fx, |_, line| {
        line["zid"] = json!(FIRST_ZID);
        true
    });
    let report = run(&comments(&one));
    assert_eq!(report.verdict, Verdict::Pass, "{}", report.text);
    assert!(
        report
            .text
            .contains("\n   admitted copies span 1 conversations\n"),
        "{}",
        report.text
    );
    assert_eq!(report.mark("conversations"), Some(Mark::Info));
    assert!(!report.text.contains(&FIRST_ZID.to_string()));
    // No admitted copy: nothing to say of conversations.
    let mut none = comments_fixture();
    for _ in 0..5 {
        comment(&mut none, C::HandBack("no_token", 200));
    }
    let report = run(&comments(&none));
    assert!(
        report
            .text
            .contains("\n   admitted copies span 0 conversations\n"),
        "{}",
        report.text
    );
    assert_eq!(report.mark("conversations"), Some(Mark::NotEvaluated));
}

/// A window that reaches back before the observer printed the conversation's
/// number holds admitted lines of both shapes: with the number and, written
/// earlier, without the key at all. The count of conversations is of the
/// lines that carry one, the report says how many carry none, and every
/// other line of the report is the one the new shape alone gives.
#[test]
fn a_window_holding_lines_without_the_conversation_number_says_so() {
    let fx = passing_comments();
    let new = run(&comments(&fx));
    assert_eq!(new.verdict, Verdict::Pass, "{}", new.text);
    // Every other admitted line is in the shape written before.
    let (mixed, old) = rewritten(&fx, |nth, line| {
        if nth % 2 == 0 {
            return false;
        }
        let keys = line.as_object_mut().unwrap();
        keys.remove("zid");
        assert_eq!(keys.len(), COMMENT_KEYS.len() - 1);
        true
    });
    let (_, admitted) = rewritten(&fx, |_, _| true);
    assert!(old > 300 && admitted - old > 300, "{old} of {admitted}");
    // The conversations the lines that still carry a number are in.
    let mut named = BTreeSet::new();
    rewritten(&mixed, |_, line| {
        if let Some(zid) = line["zid"].as_i64() {
            named.insert(zid);
        }
        false
    });
    assert!(named.len() > 1 && named.len() <= CONVERSATIONS as usize);
    let report = run(&comments(&mixed));
    assert_eq!(report.verdict, Verdict::Pass, "{}", report.text);
    assert!(
        report.text.contains(&format!(
            "\n   admitted copies span {} conversations; {old} of the {admitted} admitted name none (their lines carry no conversation number) and are in none of that count\n",
            named.len()
        )),
        "{}",
        report.text
    );
    assert_eq!(report.mark("conversations"), Some(Mark::Info));
    assert!(
        report.text.contains(&format!(
            "{} admitted copies across {} conversations; {old} more admitted name none",
            admitted - old,
            named.len()
        )),
        "{}",
        report.text
    );
    let apart = |text: &str| -> Vec<String> {
        text.lines()
            .filter(|line| {
                !line.contains("admitted copies span")
                    && !line.trim_start().starts_with("conversations ")
            })
            .map(str::to_owned)
            .collect()
    };
    assert_eq!(apart(&report.text), apart(&new.text));
    // A window wholly before the change: every admitted line names none.
    let (before, _) = rewritten(&fx, |_, line| {
        line.as_object_mut().unwrap().remove("zid");
        true
    });
    let report = run(&comments(&before));
    assert_eq!(report.verdict, Verdict::Pass, "{}", report.text);
    assert!(
        report.text.contains(&format!(
            "\n   admitted copies span 0 conversations; {admitted} of the {admitted} admitted name none"
        )),
        "{}",
        report.text
    );
}

// ---------------------------------------------------------------- found in review

/// One copied comment written line by line: nginx's status, Node's status
/// (None: no Node line at all), whether Node's line names the route, and the
/// observation, with a last change to its printed text.
fn raw(
    fx: &mut Fixture,
    edge: u16,
    node: Option<u16>,
    routed: bool,
    o: &Obs,
    tweak: impl Fn(String) -> String,
) -> String {
    let n = fx.next;
    fx.next += 1;
    fx.at += 7_000;
    let (t, id) = (fx.at, id(n));
    fx.lines.push(edge_of(COMMENT_ROUTE, &id, t, edge));
    fx.lines
        .push(mirror_of("commentsShadow", &id, t, 204, "204"));
    if let Some(node) = node {
        fx.lines.push(access_of(
            "POST",
            routed.then_some(COMMENT_PATH),
            Some(&id),
            t,
            node,
        ));
    }
    let (at, line) = observation_line(&id, t + 2_500, o);
    fx.lines.push((at, tweak(line)));
    id
}

/// The same text sent twice in quick succession (a double submit): the second
/// copy's admission can run before Node has stored the first, so it finds no
/// row (`text_row: none`) and the read-back then finds the first request's
/// row, this participant's and inside the window (`node_comment: own`),
/// beside Node's 409. That is the same case as the one admission sees, and
/// is not known; it is not "Node found a duplicate the handler would miss".
/// A 409 from Node with no row of the text at all stays a disagreement.
#[test]
fn a_double_submit_seen_only_by_the_read_back_is_not_known() {
    let mut fx = passing_comments();
    for _ in 0..3 {
        raw(&mut fx, 409, Some(409), true, &Obs::serve(), |line| line);
    }
    let report = run(&comments(&fx));
    assert_eq!(report.verdict, Verdict::Pass, "{}", report.text);
    assert!(
        report
            .text
            .contains("the same text twice within five seconds 4, no status on Node's line 0); Node answered 5xx 2"),
        "{}",
        report.text
    );
    assert!(report.text.contains("agree 300, disagree 0, not known 7,"));

    let mut absent = passing_comments();
    raw(
        &mut absent,
        409,
        Some(409),
        true,
        &Obs::serve().unread("absent"),
        |line| line,
    );
    let report = run(&comments(&absent));
    assert_eq!(
        report.mark("would serve"),
        Some(Mark::Stop),
        "{}",
        report.text
    );
    let mut other = passing_comments();
    raw(
        &mut other,
        409,
        Some(409),
        true,
        &Obs::serve().unread("other"),
        |line| line,
    );
    assert_eq!(run(&comments(&other)).mark("would serve"), Some(Mark::Stop));
}

/// A word on a line that is in none of the tool's sets (the shadow learned
/// one after this tool was built) puts the line in no class. One such word
/// anywhere, and the verdict is never a pass.
#[test]
fn a_word_the_tool_does_not_know_is_never_a_pass() {
    let known = run(&comments(&passing_comments()));
    assert_eq!(known.mark("words on the lines"), Some(Mark::Pass));
    assert_eq!(known.verdict, Verdict::Pass);
    for (from, to) in [
        (
            r#""outcome":"would_serve""#,
            r#""outcome":"would_redirect""#,
        ),
        (r#""node_row":"as_expected""#, r#""node_row":"renamed""#),
        (r#""node_vote":"same""#, r#""node_vote":"flipped""#),
        (r#""node_comment":"own""#, r#""node_comment":"moved""#),
        (r#""node_txt":"same""#, r#""node_txt":"alike""#),
        (r#""node_author":"same""#, r#""node_author":"merged""#),
        (r#""node_lang":"unset""#, r#""node_lang":"guessed""#),
        (r#""text_row":"none""#, r#""text_row":"pending""#),
        (r#""body_class":"le_1k""#, r#""body_class":"le_2k""#),
        (r#""reason":null"#, r#""reason":"a_new_reason""#),
    ] {
        let mut fx = passing_comments();
        raw(&mut fx, 200, Some(200), true, &Obs::serve(), |line| {
            assert!(line.contains(from), "{from}");
            line.replace(from, to)
        });
        let report = run(&comments(&fx));
        assert_eq!(
            report.mark("words on the lines"),
            Some(Mark::NotEvaluated),
            "{to}\n{}",
            report.text
        );
        assert_eq!(report.verdict, Verdict::TooLittle, "{to}");
        // The word itself is never printed.
        let word = to.rsplit('"').nth(1).unwrap();
        assert!(!report.text.contains(word), "{word}");
    }
}

/// An observation with no Node line is never judged, and must not pass
/// unseen when nginx's status says Node and the handler cannot both be
/// right: a request Node refused before its router matched the route (its
/// access line names no route) that the handler would have stored.
#[test]
fn an_unpaired_observation_at_odds_with_nginx_is_examined() {
    let pairing = |edge: u16, node: Option<u16>, o: Obs| {
        let mut fx = passing_comments();
        raw(&mut fx, edge, node, false, &o, |line| line);
        let report = run(&comments(&fx));
        (report.mark("pairing"), report.verdict, report.text)
    };
    // Would store; Node refused 400 before its router.
    let (mark, verdict, text) = pairing(400, Some(400), Obs::serve().unread("absent"));
    assert_eq!(mark, Some(Mark::Miss), "{text}");
    assert_eq!(verdict, Verdict::Examine);
    assert!(text.contains(
        "where the handler would store or answer and nginx saw another status from Node: 1 "
    ));
    assert!(text.contains("agree 300, disagree 0, not known 4,"));
    // Would answer 409; nginx saw 200 and there is no Node line at all.
    let (mark, _, text) = pairing(200, None, Obs::duplicate());
    assert_eq!(mark, Some(Mark::Miss), "{text}");
    // Nothing at odds: the same statuses, a participant who went away, a
    // 5xx, and a request the handler would hand back.
    for (edge, o) in [
        (200, Obs::serve()),
        (409, Obs::duplicate()),
        (499, Obs::serve()),
        (502, Obs::serve().unread("absent")),
        (400, Obs::hand_back("shape_json")),
    ] {
        let (mark, verdict, text) = pairing(edge, Some(edge), o);
        assert_eq!(mark, Some(Mark::Info), "{edge}\n{text}");
        assert_eq!(verdict, Verdict::Pass, "{edge}");
    }
}

/// CloudWatch answers a wrong resource name, and a span older than it keeps
/// a period for, with no datapoints and no error. A stop rule that was read
/// for none of the window, or for part of it, is not read: never "never
/// fired". A breach in what was read still stops.
#[test]
fn a_stop_rule_metric_with_too_few_datapoints_is_not_read() {
    let stop = |fake: &FakeAws| {
        let report = run(fake);
        (report.mark("stop rule"), report.verdict, report.text)
    };
    for route in [VOTES, COMMENTS] {
        let fake = || {
            if route.key == "votes" {
                FakeAws::new(&passing_fixture())
            } else {
                comments(&passing_comments())
            }
        };
        assert_eq!(stop(&fake()).1, Verdict::Pass);
        // Nothing read at all.
        let mut empty = fake();
        empty.metrics.values_mut().for_each(Vec::clear);
        let (mark, verdict, text) = stop(&empty);
        assert_eq!(mark, Some(Mark::NotEvaluated), "{text}");
        assert_eq!(verdict, Verdict::TooLittle);
        assert!(text.contains(
            "1. database CPU: 0 of the window's 288 five-minute averages were read; the rule is not evaluated"
        ));
        assert!(text.contains(
            "3. load balancer p99, all routes: 0 of the window's 24 hours have a p99 in both weeks; the rule is not evaluated"
        ));
        assert!(text.contains("not read: database CPU, load balancer p99"));
        // Half the window, for each metric in turn.
        let mid = (window().from_s + window().to_s) / 2;
        for name in ["db_cpu", "lb_p99", "lb_p99_previous"] {
            let mut half = fake();
            let cut = if name == "lb_p99_previous" {
                mid - crate::tests::WEEK_S
            } else {
                mid
            };
            half.metrics.get_mut(name).unwrap().retain(|p| p.0 >= cut);
            let (mark, verdict, text) = stop(&half);
            assert_eq!(mark, Some(Mark::NotEvaluated), "{name}\n{text}");
            assert_eq!(verdict, Verdict::TooLittle, "{name}");
        }
        // Nineteen in twenty is read: a few datapoints short is not a gap.
        let mut most = fake();
        most.metrics.get_mut("db_cpu").unwrap().truncate(274);
        assert_eq!(stop(&most).0, Some(Mark::Pass));
        most.metrics.get_mut("db_cpu").unwrap().truncate(273);
        assert_eq!(stop(&most).0, Some(Mark::NotEvaluated));
        // What was read and breaches still stops.
        let mut thin = fake();
        let cpu = thin.metrics.get_mut("db_cpu").unwrap();
        cpu.truncate(10);
        cpu[3].1 = 75.0;
        cpu[4].1 = 75.0;
        let (mark, verdict, text) = stop(&thin);
        assert_eq!(mark, Some(Mark::Stop), "{text}");
        assert_eq!(verdict, Verdict::Stop);
    }
}

/// nginx's request id is one per request, but nothing in the tool may lean
/// on that: lines of the other route that carry the very same request ids
/// change no byte of either report.
#[test]
fn a_request_id_on_both_routes_is_each_routes_own() {
    let before = run(&FakeAws::new(&passing_fixture()));
    let mut mixed = passing_fixture();
    let keep = mixed.next;
    mixed.next = 1;
    mixed.at = window().from_s * 1000 + 60_000;
    for case in [
        C::Plain,
        C::Duplicate,
        C::Absent,
        C::NodeRefused(400),
        C::Strict,
        C::NoNodeLine,
    ] {
        comment(&mut mixed, case);
    }
    mixed.next = keep;
    assert_eq!(run(&FakeAws::new(&mixed)).text, before.text);

    let before = run(&comments(&passing_comments()));
    let mut mixed = passing_comments();
    mixed.next = 5_000_000;
    mixed.at = window().from_s * 1000 + 60_000;
    for case in [
        Case::Agree,
        Case::Different,
        Case::ClosedDisagree,
        Case::MiddlewareRefusal,
    ] {
        mixed.vote(73_001, case);
    }
    assert_eq!(run(&comments(&mixed)).text, before.text);
}

/// Logs Insights takes a query string of at most 10,000 characters. The two
/// joins are the long ones; a join that outgrew the limit would be refused
/// on every run.
#[test]
fn every_query_fits_the_query_string_limit() {
    for route in [VOTES, COMMENTS] {
        for q in route.queries() {
            let length = q.text(window().bounds()).len();
            assert!(length <= 8_000, "{} {}: {length}", route.key, q.name);
        }
    }
}

/// The check that matters most in a sliced join is the direction a cut-off
/// takes: a slice that joined fewer requests than nginx logged. An account
/// whose Logs Insights keeps fewer rows of a first stage than a slice holds
/// must get "withheld", never a report from the rows that were kept.
#[test]
fn a_slice_that_joined_fewer_requests_than_nginx_logged_is_withheld() {
    for route in [VOTES, COMMENTS] {
        let mut fake = if route.key == "votes" {
            FakeAws::new(&passing_fixture())
        } else {
            comments(&passing_comments())
        };
        assert_eq!(run(&fake).verdict, Verdict::Pass);
        // Fewer rows than any slice of either fixture has request ids, and
        // nowhere near the 10,000 that would be said to be cut off.
        fake.first_stage_cap = Some(900);
        let report = run(&fake);
        assert!(
            report.text.contains("withheld: slice 1 of ")
                && report.text.contains("requests where nginx logged"),
            "{}",
            report.text
        );
        assert_eq!(report.mark("coverage"), Some(Mark::NotEvaluated));
        assert_eq!(report.verdict, Verdict::TooLittle, "{}", report.text);
    }
}

/// `report` reads saved results and has no count by five minutes to hold
/// each slice to: there the join's own total of nginx lines against the
/// one-stage count is the only check, for both routes. A join saved from
/// part of the window (a slice's file missing) is withheld.
#[test]
fn a_saved_join_that_covers_part_of_the_window_is_withheld() {
    for (route, fx, judged) in [
        (VOTES, passing_fixture(), "status agreement"),
        (COMMENTS, passing_comments(), "would serve"),
    ] {
        let lines = FakeAws::new(&fx).lines;
        let w = window();
        let build = |join_to_s: i64| {
            let mut results = report::Results::new();
            for q in route.queries() {
                let to_s = if q.name == "join" { join_to_s } else { w.to_s };
                results.insert(q.name.into(), Ok(eval::run(&q, &lines, w.from_s, to_s)));
                if q.previous_week {
                    let before = w.earlier(crate::tests::WEEK_S);
                    results.insert(
                        format!("{}_previous", q.name),
                        Ok(eval::run(&q, &lines, before.from_s, before.to_s)),
                    );
                }
            }
            let metrics = quiet_metrics(w)
                .into_iter()
                .map(|(k, v)| (k, Ok(v)))
                .collect();
            report::build(&report::Inputs {
                route,
                window: w,
                results: &results,
                metrics: &metrics,
            })
        };
        let whole = build(w.to_s);
        assert_eq!(whole.verdict, Verdict::Pass, "{}", whole.text);
        // The join of the window's first forty minutes only.
        let part = build(w.from_s + 2_400);
        assert!(
            part.text.contains("does not match the one-stage count"),
            "{}",
            part.text
        );
        assert_eq!(part.mark(judged), Some(Mark::NotEvaluated), "{}", part.text);
        assert_eq!(part.verdict, Verdict::TooLittle);
    }
}

/// Rules 4 and 5 of the stop rule compare Node's access lines for the route
/// with the same hours a week earlier. With no such line in one of the two
/// weeks nothing was compared: "not evaluated", never "within it".
#[test]
fn the_stop_rules_on_nodes_lines_are_not_read_without_both_weeks() {
    for route in [VOTES, COMMENTS] {
        let mut fake = if route.key == "votes" {
            FakeAws::new(&passing_fixture())
        } else {
            comments(&passing_comments())
        };
        let from_ms = (window().from_s * 1000) as f64;
        fake.lines.retain(
            |line| !matches!(line.get("@timestamp"), Some(eval::V::Num(t)) if *t < from_ms),
        );
        let report = run(&fake);
        assert_eq!(
            report.mark("stop rule"),
            Some(Mark::NotEvaluated),
            "{}",
            report.text
        );
        assert!(report.text.contains(
            "were found in the window and not in the week before it; the rules are not evaluated"
        ));
        assert_eq!(report.verdict, Verdict::TooLittle);
    }
}

/// "Three in a row" means three spans next to each other. A span that could
/// not be compared (under 20 requests in it) is not in the list of compared
/// spans at all, and the slow spans on either side of it are not in a row:
/// three slow days around such a day do not stop, and three with no gap do.
#[test]
fn slow_days_around_a_day_that_could_not_be_compared_are_not_in_a_row() {
    let day = 86_400;
    let w = Window {
        from_s: window().from_s,
        to_s: window().from_s + 6 * day,
    };
    // Thirty comments a day, ten on the quiet day; thirty slow answers of
    // Node's on each slow day.
    let report = |quiet_day: i64, slow_days: &[i64]| {
        let mut fx = comments_fixture();
        for d in 0..6 {
            fx.at = (w.from_s + d * day) * 1000 + 3_600_000;
            for _ in 0..if d == quiet_day { 10 } else { 30 } {
                comment(&mut fx, C::Plain);
            }
        }
        let mut fake = comments(&fx);
        fake.window = w;
        fake.metrics = quiet_metrics(w);
        for d in slow_days {
            for i in 0..30 {
                let at = (w.from_s + d * day) * 1000 + 7_200_000 + i * 1000;
                let (at, line) = access_of("POST", Some(COMMENT_PATH), None, at, 200);
                fake.push((
                    at,
                    line.replace("\"duration_ms\":18.5", "\"duration_ms\":900.0"),
                ));
            }
        }
        let args = RunArgs {
            route: "comments",
            window: (w.from_s, w.to_s),
            ..run_args()
        };
        crate::run(&fake, &args, w.to_s + day, &mut std::io::sink()).unwrap()
    };
    // Days 1, 3 and 4 slow; day 2 had ten comments and is not compared.
    let gap = report(2, &[1, 3, 4]);
    assert!(
        gap.text.contains(
            "3 of 5 comparable days more than 20 % and 50 ms above a week earlier, longest run 2;"
        ),
        "{}",
        gap.text
    );
    assert_eq!(gap.mark("stop rule"), Some(Mark::Pass));
    // The same three slow days with the quiet day elsewhere: in a row.
    let row = report(0, &[3, 4, 5]);
    assert_eq!(row.mark("stop rule"), Some(Mark::Stop), "{}", row.text);
}
