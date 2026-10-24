use super::*;
use serde_json::{Value, json};

// Compare the entire key set as well as every value's JSON type. Nullability is
// exercised with both variants, rather than accepting any value for null fields.
fn fields(value: &Value, strings: &[&str], rest: &[(&str, &str)]) {
    let object = value.as_object().unwrap();
    let expected: BTreeSet<_> = strings
        .iter()
        .copied()
        .chain(rest.iter().map(|(k, _)| *k))
        .collect();
    assert_eq!(
        object.keys().map(String::as_str).collect::<BTreeSet<_>>(),
        expected
    );
    for key in strings {
        assert!(object[*key].is_string(), "{key}");
    }
    for (key, kind) in rest {
        let v = &object[*key];
        assert!(
            match *kind {
                "null" => v.is_null(),
                "string" => v.is_string(),
                "bool" => v.is_boolean(),
                "u64" => v.as_u64().is_some(),
                "strings" => v.as_array().is_some_and(|a| a.iter().all(Value::is_string)),
                "integers" => v
                    .as_array()
                    .is_some_and(|a| a.iter().all(|v| v.as_u64().is_some())),
                "objects" => v.as_array().is_some_and(|a| a.iter().all(Value::is_object)),
                _ => panic!("unknown contract type {kind}"),
            },
            "{key}: {v}"
        );
    }
}

#[test]
fn seed_exact_contract() {
    let seed: Seed = serde_json::from_str(SEED).unwrap();
    let value = serde_json::to_value(seed).unwrap();
    fields(
        &value,
        &[
            "schema",
            "version",
            "stable_commit",
            "source_commit",
            "date",
        ],
        &[("promotion_pr", "u64")],
    );
    assert_eq!(value["schema"], "polis.release-seed/1");
    assert_eq!(value, serde_json::from_str::<Value>(SEED).unwrap());
    let mut extra = value.clone();
    extra["extra"] = json!(true);
    assert!(serde_json::from_value::<Seed>(extra).is_err());
    for key in value.as_object().unwrap().keys() {
        let mut missing = value.clone();
        missing.as_object_mut().unwrap().remove(key);
        assert!(serde_json::from_value::<Seed>(missing).is_err(), "{key}");
        let mut null = value.clone();
        null[key] = Value::Null;
        assert!(serde_json::from_value::<Seed>(null).is_err(), "{key}");
    }
}

#[test]
fn plan_exact_contract_and_nullability() {
    let mut p = Plan {
        schema: "polis.release-plan/1",
        rule: Rule::Effective.name(),
        kind: "promotion".into(),
        version: "2.42.0".into(),
        previous_version: "2.41.0".into(),
        bump: "minor".into(),
        reason: "new selected migrations".into(),
        release_lines: vec!["000001_one.sql".into()],
        previous_stable_commit: "a".repeat(40),
        candidate_commit: "b".repeat(40),
        previous_tree: "c".repeat(40),
        candidate_tree: "d".repeat(40),
        previous_manifest_blob: None,
        candidate_manifest_blob: None,
        previous_tag: None,
        new_number: true,
    };
    for kind in ["null", "string"] {
        if kind == "string" {
            p.previous_manifest_blob = Some("e".repeat(40));
            p.candidate_manifest_blob = Some("f".repeat(40));
            p.previous_tag = Some("v2.41.0".into());
        }
        let v = serde_json::to_value(&p).unwrap();
        fields(
            &v,
            &[
                "schema",
                "rule",
                "kind",
                "version",
                "previous_version",
                "bump",
                "reason",
                "previous_stable_commit",
                "candidate_commit",
                "previous_tree",
                "candidate_tree",
            ],
            &[
                ("release_lines", "strings"),
                ("previous_manifest_blob", kind),
                ("candidate_manifest_blob", kind),
                ("previous_tag", kind),
                ("new_number", "bool"),
            ],
        );
        assert_eq!(v["schema"], "polis.release-plan/1");
        assert_eq!(v["new_number"], true);
    }
}

#[test]
fn history_and_promotion_exact_contract_and_seed_semantics() {
    let mut row = Promotion {
        version: "2.34.0".into(),
        previous_version: None,
        date: "2026-10-04T16:27:11-07:00".into(),
        stable_commit: "a".repeat(40),
        source_commit: "b".repeat(40),
        migrations_shipped: vec!["000001_one.sql".into()],
        bump_lines: vec![],
        migrations_removed: vec![],
        bump: "seed".into(),
        selection_evidence: "committed manifest".into(),
        manifest_blob: None,
        promotion_pr: Some(3),
        pr_count: 2,
        prs: vec![1, 2],
    };
    for nullable in [true, false] {
        if !nullable {
            row.previous_version = Some("2.34.0".into());
            row.version = "2.35.0".into();
            row.bump = "minor".into();
            row.bump_lines = row.migrations_shipped.clone();
            row.manifest_blob = Some("c".repeat(40));
            row.promotion_pr = None;
        }
        let v = serde_json::to_value(&row).unwrap();
        fields(
            &v,
            &[
                "version",
                "date",
                "stable_commit",
                "source_commit",
                "bump",
                "selection_evidence",
            ],
            &[
                ("previous_version", if nullable { "null" } else { "string" }),
                ("manifest_blob", if nullable { "null" } else { "string" }),
                ("promotion_pr", if nullable { "u64" } else { "null" }),
                ("pr_count", "u64"),
                ("prs", "integers"),
                ("migrations_shipped", "strings"),
                ("bump_lines", "strings"),
                ("migrations_removed", "strings"),
            ],
        );
        assert_eq!(v["pr_count"], v["prs"].as_array().unwrap().len());
        if nullable {
            assert_eq!(v["bump"], "seed");
            assert_eq!(v["bump_lines"], json!([]));
        }
        let h = serde_json::to_value(History {
            schema: "polis.release-history/1",
            rule: Rule::Literal.name(),
            seed_sha256: "a".repeat(64),
            promotions: vec![row.clone()],
        })
        .unwrap();
        fields(
            &h,
            &["schema", "rule", "seed_sha256"],
            &[("promotions", "objects")],
        );
        assert_eq!(h["schema"], "polis.release-history/1");
        assert_eq!(h["promotions"][0], v);
    }
}
