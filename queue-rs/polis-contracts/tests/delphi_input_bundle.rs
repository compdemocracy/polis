//! delphi-input-bundle/1: the committed schemas are the generated ones, the
//! golden bundle is exactly what the encoder writes, every file validates
//! against its schema, the manifest's digests bind the files, and every rule
//! refuses what it names.
//!
//! `POLIS_CONTRACTS_WRITE_SCHEMAS=1` rewrites the committed schemas and the
//! golden bundle instead of comparing them.
mod support;

use polis_contracts::delphi_input_bundle::{
    all_but_moderated_out, all_comments, comment_set_sha256, participant_visible, select,
    sha256_hex, Bundle, Comment, Conversation, Manifest, ReportCommentSelection, Role,
    ALL_BUT_MODERATED_OUT, ALL_COMMENTS, CONTRACT_VERSION, MANIFEST_FILE, PARTICIPANT_VISIBLE,
    RULES, SELECTIONS, SELECTION_FORMAT,
};
use polis_contracts::delphi_input_bundle_schema::{
    comments_document, conversation_document, documents, manifest_document,
    report_comment_selections_document,
};
use polis_contracts::wire::Json;
use serde_json::Value;
use support::{read, repo, violations};

/// Shared with the Delphi tests (delphi/tests/test_input_bundle.py) and the
/// polis-jobs writer's unit test, which read the same files.
const GOLDEN: &str = "delphi/tests/fixtures/input_bundle/basic";
/// The selection's rows and what it keeps of them, read by the Python
/// selection's test (delphi/tests/test_selection.py) so both languages keep
/// the same comments with the same digest.
const SELECTION_GOLDEN: &str = "delphi/tests/fixtures/selection/participant_visible.json";
/// The same rows and what `all_comments/1` and `all_but_moderated_out/1` keep
/// of them, read by delphi/tests/test_shadow_comment_rules.py.
const ALL_COMMENTS_GOLDEN: &str = "delphi/tests/fixtures/selection/all_comments.json";
const ALL_BUT_MODERATED_OUT_GOLDEN: &str =
    "delphi/tests/fixtures/selection/all_but_moderated_out.json";

fn writing() -> bool {
    std::env::var("POLIS_CONTRACTS_WRITE_SCHEMAS").as_deref() == Ok("1")
}

fn compare_or_write(relative: &str, bytes: &[u8]) {
    let path = repo().join(relative);
    if writing() {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, bytes).unwrap();
        return;
    }
    let committed = std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    assert!(
        committed == bytes,
        "{relative} differs from what the Rust source generates"
    );
}

fn comment(tid: i64, pid: i64, txt: &str, m: i64, active: bool) -> Comment {
    Comment {
        tid,
        zid: 4242,
        pid,
        txt: txt.to_owned(),
        created: Some(1_700_000_000_000 + tid * 1000),
        r#mod: m,
        active,
        velocity: None,
    }
}

/// The golden conversation: moderated, inactive, blank, non-ASCII and
/// control-character texts; selections excluding and including comments in
/// two reports; a math tick pair and a vote high-water mark.
fn golden() -> Bundle {
    Bundle {
        conversation: Conversation {
            zid: 4242,
            topic: Some("Transit – café “north” line".to_owned()),
            description: None,
            created: Some(1_699_999_000_000),
            modified: Some(1_700_000_500_000),
            owner: Some(17),
            strict_moderation: None,
        },
        comments: vec![
            comment(0, 1, "Build the north line first.", 1, true),
            comment(
                1,
                2,
                "Fares should be free\tfor students\nand seniors.",
                0,
                true,
            ),
            comment(2, 3, "Spam: buy now", -1, true),
            comment(
                3,
                1,
                "Bus lanes before rail — «faster» and cheaper 🚌",
                0,
                true,
            ),
            comment(4, 4, "   ", 0, true),
            comment(5, 5, "Close the old depot \"quietly\"", 0, false),
        ],
        report_comment_selections: vec![
            ReportCommentSelection {
                rid: 7,
                tid: 1,
                selection: 1,
                zid: 4242,
                modified: Some(1_700_000_100_000),
            },
            ReportCommentSelection {
                rid: 7,
                tid: 3,
                selection: -1,
                zid: 4242,
                modified: Some(1_700_000_200_000),
            },
            ReportCommentSelection {
                rid: 9,
                tid: 0,
                selection: -1,
                zid: 4242,
                modified: None,
            },
        ],
        math_env: "prod".to_owned(),
        math_tick: Some(31),
        math_caching_tick: Some(12),
        vote_hwm: Some(1_700_000_400_000),
    }
}

fn json(bytes: &[u8]) -> Json {
    serde_json::from_slice(bytes).unwrap()
}

#[test]
fn the_committed_schemas_are_the_generated_ones() {
    for (path, text) in documents() {
        compare_or_write(path, text.as_bytes());
    }
}

#[test]
fn the_golden_bundle_is_what_the_encoder_writes() {
    let encoded = golden().encode().unwrap();
    for (role, bytes) in &encoded.files {
        compare_or_write(&format!("{GOLDEN}/{}", role.file_name()), bytes);
    }
    compare_or_write(
        &format!("{GOLDEN}/{MANIFEST_FILE}"),
        &encoded.manifest_bytes,
    );
}

#[test]
fn every_golden_file_validates_against_its_schema() {
    let schema = |s: polis_contracts::schema::Schema| s.to_json();
    let cases = [
        (MANIFEST_FILE, schema(manifest_document())),
        (
            Role::Conversation.file_name(),
            schema(conversation_document()),
        ),
        (Role::Comments.file_name(), schema(comments_document())),
        (
            Role::ReportCommentSelections.file_name(),
            schema(report_comment_selections_document()),
        ),
    ];
    for (file, schema) in cases {
        let value = json(read(&format!("{GOLDEN}/{file}")).as_bytes());
        assert_eq!(violations(&schema, &value), Vec::<String>::new(), "{file}");
    }
}

#[test]
fn the_manifest_round_trips_and_binds_every_file() {
    let text = read(&format!("{GOLDEN}/{MANIFEST_FILE}"));
    let manifest: Manifest = serde_json::from_str(&text).unwrap();
    manifest.check().unwrap();
    let mut again = serde_json::to_string(&manifest).unwrap();
    again.push('\n');
    assert_eq!(again, text);
    assert_eq!(manifest.schema, CONTRACT_VERSION);
    let order: Vec<Role> = manifest.files.iter().map(|f| f.role).collect();
    assert_eq!(order, Role::ALL.to_vec());
    for entry in &manifest.files {
        let bytes = std::fs::read(repo().join(GOLDEN).join(&entry.path)).unwrap();
        assert_eq!(entry.sha256, sha256_hex(&bytes), "{}", entry.path);
        assert_eq!(entry.bytes, bytes.len() as u64, "{}", entry.path);
        let rows = match serde_json::from_slice::<Value>(&bytes).unwrap() {
            Value::Array(a) => a.len() as u64,
            Value::Object(_) => 1,
            other => panic!("{}: {other}", entry.path),
        };
        assert_eq!(entry.rows, rows, "{}", entry.path);
    }
    let comments: Vec<Comment> =
        serde_json::from_str(&read(&format!("{GOLDEN}/comments.json"))).unwrap();
    assert_eq!(
        manifest.inputs.comment_set_sha256,
        comment_set_sha256(&comments)
    );
}

/// The census digest (`census.py`, `comment_set_sha256`) for two comments out
/// of order and for none. delphi/tests/test_input_bundle.py pins the same two
/// values against the Python function, so the two cannot drift apart.
#[test]
fn the_comment_set_digest_is_the_census_digest() {
    let rows = vec![comment(2, 9, "b", -1, false), comment(1, 9, "a", 0, true)];
    assert_eq!(
        comment_set_sha256(&rows),
        "99403c230e9bf8ec2bbc8ef2ca09eac5e28e768b33c76e5645807baa447d4bb5"
    );
    assert_eq!(
        comment_set_sha256(&[]),
        sha256_hex(b"polis-jobs.comment-set/1\n")
    );
}

fn manifest_value() -> Value {
    serde_json::from_str(&read(&format!("{GOLDEN}/{MANIFEST_FILE}"))).unwrap()
}

/// One edit of a valid manifest that a rule must refuse.
type Damage = Box<dyn Fn(&mut Value)>;

fn refused(v: &Value) -> Option<String> {
    match serde_json::from_value::<Manifest>(v.clone()) {
        Err(e) => Some(format!("decode: {e}")),
        Ok(m) => m.check().err().map(|e| e.0),
    }
}

#[test]
fn every_rule_refuses_what_it_names() {
    let cases: Vec<(&str, Damage)> = vec![
        (
            "schema",
            Box::new(|v| v["schema"] = "delphi-input-bundle/2".into()),
        ),
        ("zid", Box::new(|v| v["zid"] = (-1).into())),
        (
            "inputs.math_env",
            Box::new(|v| v["inputs"]["math_env"] = "".into()),
        ),
        (
            "inputs.comment_set_sha256",
            Box::new(|v| v["inputs"]["comment_set_sha256"] = "AB".repeat(32).into()),
        ),
        (
            "files",
            Box::new(|v| {
                v["files"].as_array_mut().unwrap().pop();
            }),
        ),
        (
            "files.role",
            Box::new(|v| v["files"].as_array_mut().unwrap().swap(1, 2)),
        ),
        (
            "files.path",
            Box::new(|v| v["files"][1]["path"] = "../comments.json".into()),
        ),
        (
            "files.schema",
            Box::new(|v| v["files"][1]["schema"] = "comments/2".into()),
        ),
        (
            "files.sha256",
            Box::new(|v| v["files"][0]["sha256"] = "0".repeat(63).into()),
        ),
        ("files.rows", Box::new(|v| v["files"][0]["rows"] = 2.into())),
        ("decode", Box::new(|v| v["extra"] = true.into())),
        ("decode", Box::new(|v| v["inputs"]["vote_count"] = 3.into())),
        (
            "decode",
            Box::new(|v| v["files"][2]["role"] = "votes".into()),
        ),
    ];
    assert!(refused(&manifest_value()).is_none());
    for (rule, edit) in cases {
        let mut v = manifest_value();
        edit(&mut v);
        let why = refused(&v).unwrap_or_else(|| panic!("{rule}: accepted"));
        assert!(why.starts_with(rule), "{rule}: refused for {why}");
    }
}

#[test]
fn the_encoder_refuses_rows_out_of_order_or_of_another_conversation() {
    let mut b = golden();
    b.comments.swap(0, 1);
    assert_eq!(b.encode().unwrap_err().0, "comments order");
    let mut b = golden();
    b.comments[0].zid = 1;
    assert_eq!(b.encode().unwrap_err().0, "comments zid");
    let mut b = golden();
    b.report_comment_selections.swap(0, 2);
    assert_eq!(b.encode().unwrap_err().0, "report_comment_selections order");
    let mut b = golden();
    b.report_comment_selections[1].zid = 1;
    assert_eq!(b.encode().unwrap_err().0, "report_comment_selections zid");
    let mut b = golden();
    b.math_env = String::new();
    assert_eq!(b.encode().unwrap_err().0, "inputs.math_env");
}

/// A comment with its velocity, as a bundle for a run that names a selection
/// holds it.
fn moderated(tid: i64, txt: &str, m: i64, active: bool, velocity: f64) -> Comment {
    Comment {
        velocity: Some(velocity),
        ..comment(tid, tid + 1, txt, m, active)
    }
}

/// Every moderation state a comment can be in, the muted and inactive ones
/// among them, out of tid order.
fn moderation_states() -> Vec<Comment> {
    vec![
        moderated(3, "Accepted, and muted", 1, true, 0.0),
        moderated(0, "Accepted", 1, true, 1.0),
        moderated(1, "Not yet moderated", 0, true, 1.0),
        moderated(2, "Rejected", -1, true, 1.0),
        moderated(4, "Accepted, inactive", 1, false, 1.0),
        moderated(5, "Unmoderated, slowed but shown", 0, true, 0.25),
        moderated(6, "Rejected and inactive", -1, false, 1.0),
        moderated(7, "Accepted — «café» 🚌", 1, true, 1.0),
        moderated(8, "Unmoderated, below zero", 0, true, -1.0),
    ]
}

/// The rule of the comment list participants are served
/// (`participantVisibleClause`, server/src/comment.ts): active, velocity
/// above 0, and accepted under strict moderation or not rejected otherwise.
#[test]
fn participant_visible_is_the_list_participants_are_served() {
    for strict in [false, true] {
        for active in [false, true] {
            for velocity in [-1.0, 0.0, 0.25, 1.0] {
                for m in [-1, 0, 1] {
                    let shown = active && velocity > 0.0 && if strict { m == 1 } else { m != -1 };
                    assert_eq!(
                        participant_visible(active, velocity, m, strict),
                        shown,
                        "strict {strict} active {active} velocity {velocity} mod {m}"
                    );
                }
            }
        }
    }
}

#[test]
fn a_selection_keeps_the_participant_visible_comments_under_its_digest() {
    let rows = moderation_states();
    let open = select(PARTICIPANT_VISIBLE, &rows, false).unwrap();
    assert_eq!(open.name, PARTICIPANT_VISIBLE);
    assert_eq!(
        open.tids,
        vec![0, 1, 5, 7],
        "rejected, inactive and muted drop out"
    );
    let strict = select(PARTICIPANT_VISIBLE, &rows, true).unwrap();
    assert_eq!(
        strict.tids,
        vec![0, 7],
        "under strict moderation only the accepted"
    );
    assert_ne!(strict.sha256, open.sha256);
    // The digest: the header, the name, then tid and the text's sha256.
    let mut text = format!("{SELECTION_FORMAT}\n{PARTICIPANT_VISIBLE}\n");
    for tid in &strict.tids {
        let c = rows.iter().find(|c| c.tid == *tid).unwrap();
        text.push_str(&format!("{tid}\t{}\n", sha256_hex(c.txt.as_bytes())));
    }
    assert_eq!(strict.sha256, sha256_hex(text.as_bytes()));
    // Moderation that keeps the same comments keeps the digest: an
    // unmoderated comment accepted, a rejected comment added.
    let mut same = rows.clone();
    same.iter_mut().find(|c| c.tid == 1).unwrap().r#mod = 1;
    same.push(moderated(9, "Another rejected", -1, true, 1.0));
    assert_eq!(select(PARTICIPANT_VISIBLE, &same, false).unwrap(), open);
    // One that drops a comment, or keeps another, changes it.
    let mut fewer = rows.clone();
    fewer.iter_mut().find(|c| c.tid == 0).unwrap().r#mod = -1;
    assert_ne!(
        select(PARTICIPANT_VISIBLE, &fewer, false).unwrap().sha256,
        open.sha256
    );
    let mut unmuted = rows.clone();
    unmuted.iter_mut().find(|c| c.tid == 3).unwrap().velocity = Some(1.0);
    assert_ne!(
        select(PARTICIPANT_VISIBLE, &unmuted, false).unwrap().sha256,
        open.sha256
    );
    // Every comment's set changes in all three; the digests differ in kind.
    assert_ne!(comment_set_sha256(&same), comment_set_sha256(&rows));
    assert_ne!(open.sha256, comment_set_sha256(&rows));
    // Only a named selection, and only with every velocity.
    assert_eq!(
        SELECTIONS,
        [PARTICIPANT_VISIBLE, ALL_COMMENTS, ALL_BUT_MODERATED_OUT]
    );
    assert!(select("all/1", &rows, false).is_err());
    let mut unknown = rows.clone();
    unknown[0].velocity = None;
    assert!(select(PARTICIPANT_VISIBLE, &unknown, false).is_err());
}

/// The rows above and what the selection keeps of them, open and strict, for
/// the Python selection to agree with.
#[test]
fn the_selection_golden_is_what_the_contract_selects() {
    let rows = moderation_states();
    let case = |strict: bool| {
        let s = select(PARTICIPANT_VISIBLE, &rows, strict).unwrap();
        serde_json::json!({"strict_moderation": strict, "tids": s.tids, "sha256": s.sha256})
    };
    let golden = serde_json::json!({
        "selection": PARTICIPANT_VISIBLE,
        "comments": rows,
        "cases": [case(false), case(true)],
    });
    let mut bytes = serde_json::to_vec_pretty(&golden).unwrap();
    bytes.push(b'\n');
    compare_or_write(SELECTION_GOLDEN, &bytes);
}

/// A bundle for a run that names a selection carries the two columns, and
/// they validate; a bundle without them is byte for byte the golden one.
#[test]
fn the_selection_columns_are_only_in_a_bundle_that_names_one() {
    let plain = golden().encode().unwrap();
    let mut b = golden();
    b.conversation.strict_moderation = Some(true);
    for c in &mut b.comments {
        c.velocity = Some(1.0);
    }
    let with = b.encode().unwrap();
    assert_eq!(plain.files[2], with.files[2], "report selections unchanged");
    let value = |bytes: &[u8]| serde_json::from_slice::<Value>(bytes).unwrap();
    assert_eq!(value(&with.files[1].1)[0]["velocity"], 1.0);
    let comments = json(&with.files[1].1);
    assert!(violations(&comments_document().to_json(), &comments).is_empty());
    assert_eq!(value(&with.files[0].1)["strict_moderation"], true);
    let conversation = json(&with.files[0].1);
    assert!(violations(&conversation_document().to_json(), &conversation).is_empty());
    assert!(value(&plain.files[1].1)[0].get("velocity").is_none());
    assert!(value(&plain.files[0].1).get("strict_moderation").is_none());
}

/// `all_comments/1` keeps every comment, whatever its state: there is no
/// combination of the four columns it leaves out. `all_but_moderated_out/1`
/// leaves out exactly the moderated-out ones, whatever the rest says.
#[test]
fn the_two_report_rules_keep_every_comment_and_every_comment_not_moderated_out() {
    for strict in [false, true] {
        for active in [false, true] {
            for velocity in [-1.0, 0.0, 0.25, 1.0] {
                for m in [-1, 0, 1] {
                    let case =
                        format!("strict {strict} active {active} velocity {velocity} mod {m}");
                    assert!(all_comments(active, velocity, m, strict), "{case}");
                    assert_eq!(
                        all_but_moderated_out(active, velocity, m, strict),
                        m != -1,
                        "{case}"
                    );
                }
            }
        }
    }
}

/// Each selection is decided by its one rule in the table, and the table is
/// the list of selections an admission may name.
#[test]
fn every_selection_is_decided_by_its_rule_in_the_table() {
    assert_eq!(RULES.map(|(name, _)| name), SELECTIONS);
    let rows = moderation_states();
    for (name, rule) in RULES {
        for strict in [false, true] {
            let mut by_rule: Vec<i64> = rows
                .iter()
                .filter(|c| rule(c.active, c.velocity.unwrap(), c.r#mod, strict))
                .map(|c| c.tid)
                .collect();
            by_rule.sort_unstable();
            assert_eq!(select(name, &rows, strict).unwrap().tids, by_rule, "{name}");
        }
    }
}

#[test]
fn all_comments_keeps_the_moderated_in_the_unmoderated_and_the_moderated_out() {
    let rows = moderation_states();
    let every: Vec<i64> = (0..=8).collect();
    let open = select(ALL_COMMENTS, &rows, false).unwrap();
    let strict = select(ALL_COMMENTS, &rows, true).unwrap();
    assert_eq!(open.name, ALL_COMMENTS);
    assert_eq!(
        open.tids, every,
        "rejected, unmoderated, inactive and muted all kept"
    );
    assert_eq!(strict, open, "strict moderation changes nothing it keeps");
    // The digest: the header, its own name, then tid and the text's sha256.
    let mut text = format!("{SELECTION_FORMAT}\n{ALL_COMMENTS}\n");
    for tid in &every {
        let c = rows.iter().find(|c| c.tid == *tid).unwrap();
        text.push_str(&format!("{tid}\t{}\n", sha256_hex(c.txt.as_bytes())));
    }
    assert_eq!(open.sha256, sha256_hex(text.as_bytes()));
    // Two selections that keep the same comments still differ by name: a
    // conversation whose comments are all shown has two digests, so a run of
    // one is never taken for a run of the other.
    let shown: Vec<Comment> = rows
        .iter()
        .filter(|c| participant_visible(c.active, c.velocity.unwrap(), c.r#mod, false))
        .cloned()
        .collect();
    let (a, p) = (
        select(ALL_COMMENTS, &shown, false).unwrap(),
        select(PARTICIPANT_VISIBLE, &shown, false).unwrap(),
    );
    assert_eq!(a.tids, p.tids);
    assert_ne!(a.sha256, p.sha256);
    // Any moderation leaves it as it was (it keeps every comment either way);
    // a new comment, or a comment's new text, changes it.
    let mut moderated = rows.clone();
    for c in &mut moderated {
        c.r#mod = -c.r#mod;
        c.active = !c.active;
        c.velocity = Some(0.0);
    }
    assert_eq!(select(ALL_COMMENTS, &moderated, true).unwrap(), open);
    let mut more = rows.clone();
    more.push(moderated_comment(9, "Another rejected", -1));
    assert_ne!(
        select(ALL_COMMENTS, &more, false).unwrap().sha256,
        open.sha256
    );
    let mut edited = rows.clone();
    edited[0].txt.push('!');
    assert_ne!(
        select(ALL_COMMENTS, &edited, false).unwrap().sha256,
        open.sha256
    );
    // Like every selection, it needs every velocity.
    let mut unknown = rows.clone();
    unknown[0].velocity = None;
    assert!(select(ALL_COMMENTS, &unknown, false).is_err());
}

fn moderated_comment(tid: i64, txt: &str, m: i64) -> Comment {
    moderated(tid, txt, m, true, 1.0)
}

#[test]
fn all_but_moderated_out_keeps_the_unmoderated_and_the_moderated_in_whatever_strict_says() {
    let rows = moderation_states();
    let open = select(ALL_BUT_MODERATED_OUT, &rows, false).unwrap();
    let strict = select(ALL_BUT_MODERATED_OUT, &rows, true).unwrap();
    assert_eq!(open.name, ALL_BUT_MODERATED_OUT);
    assert_eq!(
        open.tids,
        vec![0, 1, 3, 4, 5, 7, 8],
        "the two moderated out (2 and 6) leave; inactive and muted stay"
    );
    assert_eq!(strict, open, "strict moderation changes nothing it keeps");
    // The three rules on one conversation holding all three moderation
    // states: three different sets of comments, three digests.
    let every = select(ALL_COMMENTS, &rows, false).unwrap();
    let shown = select(PARTICIPANT_VISIBLE, &rows, true).unwrap();
    assert_eq!(every.tids, (0..=8).collect::<Vec<_>>());
    assert_eq!(shown.tids, vec![0, 7]);
    let digests = [&every.sha256, &open.sha256, &shown.sha256];
    assert!(digests[0] != digests[1] && digests[1] != digests[2] && digests[0] != digests[2]);
    // Moderating a comment in keeps its digest; moderating one out, or back
    // in, changes it.
    let mut accepted = rows.clone();
    accepted.iter_mut().find(|c| c.tid == 1).unwrap().r#mod = 1;
    assert_eq!(
        select(ALL_BUT_MODERATED_OUT, &accepted, false).unwrap(),
        open
    );
    let mut out = rows.clone();
    out.iter_mut().find(|c| c.tid == 1).unwrap().r#mod = -1;
    assert_ne!(
        select(ALL_BUT_MODERATED_OUT, &out, false).unwrap().sha256,
        open.sha256
    );
    let mut back = rows.clone();
    back.iter_mut().find(|c| c.tid == 2).unwrap().r#mod = 0;
    assert_ne!(
        select(ALL_BUT_MODERATED_OUT, &back, false).unwrap().sha256,
        open.sha256
    );
}

/// The rows of the participant_visible golden and what `all_comments/1` and
/// `all_but_moderated_out/1` keep of them, open and strict, for the Python
/// rules to agree with.
#[test]
fn the_report_rules_goldens_are_what_the_contract_selects() {
    let rows = moderation_states();
    for (name, path) in [
        (ALL_COMMENTS, ALL_COMMENTS_GOLDEN),
        (ALL_BUT_MODERATED_OUT, ALL_BUT_MODERATED_OUT_GOLDEN),
    ] {
        let case = |strict: bool| {
            let s = select(name, &rows, strict).unwrap();
            serde_json::json!({"strict_moderation": strict, "tids": s.tids, "sha256": s.sha256})
        };
        let golden = serde_json::json!({
            "selection": name,
            "comments": rows,
            "cases": [case(false), case(true)],
        });
        let mut bytes = serde_json::to_vec_pretty(&golden).unwrap();
        bytes.push(b'\n');
        compare_or_write(path, &bytes);
    }
}
