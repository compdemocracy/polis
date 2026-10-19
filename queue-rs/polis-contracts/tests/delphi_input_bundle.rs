//! delphi-input-bundle/1: the committed schemas are the generated ones, the
//! golden bundle is exactly what the encoder writes, every file validates
//! against its schema, the manifest's digests bind the files, and every rule
//! refuses what it names.
//!
//! `POLIS_CONTRACTS_WRITE_SCHEMAS=1` rewrites the committed schemas and the
//! golden bundle instead of comparing them.
mod support;

use polis_contracts::delphi_input_bundle::{
    comment_set_sha256, sha256_hex, Bundle, Comment, Conversation, Manifest,
    ReportCommentSelection, Role, CONTRACT_VERSION, MANIFEST_FILE,
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
