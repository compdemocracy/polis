use serde_json::Value;
use std::process::Command;
fn run(args: &[&str]) -> (i32, Value) {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("profiles.json"),
        r#"{"default":"local","sites":{"local":"http://127.0.0.1:9"}}"#,
    )
    .unwrap();
    let o = Command::new(env!("CARGO_BIN_EXE_polis"))
        .env("POLIS_CONFIG_DIR", dir.path())
        .args(args)
        .arg("--json")
        .output()
        .unwrap();
    (
        o.status.code().unwrap(),
        serde_json::from_slice(&o.stdout).unwrap(),
    )
}
#[test]
fn participant_reads_are_comment_commands_and_collective_statements_remain() {
    for args in [
        vec!["help", "comment", "list"],
        vec!["help", "comment", "view"],
        vec!["help", "report", "comments", "list"],
        vec!["help", "collective", "statements"],
    ] {
        let (exit, v) = run(&args);
        assert_eq!(exit, 0, "{args:?} {v}");
    }
}
#[test]
fn next_is_discoverable_with_its_existing_participant_read_contract() {
    let (exit, v) = run(&["schema", "comment", "next"]);
    assert_eq!(exit, 0, "{v}");
    assert_eq!(v["data"]["implemented"], true);
    assert!(v["data"]["description"]
        .as_str()
        .unwrap()
        .contains("without casting a vote"));
    assert_eq!(run(&["comment", "next", "--conversation", "bad/id"]).0, 2);
}
#[test]
fn old_participant_read_names_no_longer_parse() {
    for args in [
        vec!["help", "statement", "list"],
        vec!["help", "report", "statements", "list"],
    ] {
        assert_eq!(run(&args).0, 2, "{args:?}");
    }
}
