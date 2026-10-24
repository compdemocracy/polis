use serde_json::Value;
use std::process::Command;
fn run(args: &[&str]) -> (i32, Value) {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("profiles.json"), "invalid-profile").unwrap();
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
fn questions_are_offline_and_cover_the_ten_patterns_in_order() {
    let (exit, v) = run(&["questions"]);
    assert_eq!(exit, 0, "{v}");
    assert_eq!(v["data"]["schema"], "polis-questions/1");
    let rows = v["data"]["questions"].as_array().unwrap();
    assert_eq!(rows.len(), 10);
    let ids: Vec<_> = rows.iter().map(|v| v["id"].as_str().unwrap()).collect();
    assert_eq!(
        ids,
        [
            "shared-ground",
            "division",
            "groups",
            "distinctive-beliefs",
            "importance",
            "new-comments",
            "needs-votes",
            "change-over-time",
            "collective-statements",
            "participant-against-room"
        ]
    );
    for row in rows {
        assert!(!row["look_for"].as_str().unwrap().is_empty());
        assert!(!row["commands"].as_array().unwrap().is_empty());
    }
    assert!(v["data"]["help"]
        .as_str()
        .unwrap()
        .contains("data.convention"));
    assert!(v["data"]["help"]
        .as_str()
        .unwrap()
        .contains("does not yet provide an automatic consensus timeline"));
}
#[test]
fn every_suggested_command_parses_without_loading_a_profile() {
    let (exit, v) = run(&["questions"]);
    assert_eq!(exit, 0, "{v}");
    for row in v["data"]["questions"].as_array().unwrap() {
        for c in row["commands"].as_array().unwrap() {
            let example = c
                .as_str()
                .unwrap()
                .replace("CONV", "convA")
                .replace("REPORT", "repA")
                .replace("UNTIL_MS", "1700000000000")
                .replace("PID", "0");
            let mut args: Vec<_> = example
                .split_whitespace()
                .skip(1)
                .filter(|s| *s != "--json")
                .collect();
            args.push("--help");
            let (exit, v) = run(&args);
            assert_eq!(exit, 0, "{example}: {v}");
        }
    }
}
#[test]
fn guide_is_discoverable_in_top_help_schema_and_its_own_help() {
    for args in [
        vec!["--help"],
        vec!["help"],
        vec!["schema", "questions"],
        vec!["questions", "--help"],
    ] {
        let (exit, v) = run(&args);
        assert_eq!(exit, 0, "{v}");
        assert!(v.to_string().contains("questions"));
        if args == ["questions", "--help"] {
            assert!(v.to_string().contains("What divided us"));
        }
    }
}
