//! The map a run stores (`Delphi_TopicMapDocument`), made from the public
//! fixtures stored as a run stores them: its rows, its size limit, the
//! reasons a run stores no map, the refusals, the command the pipeline's step
//! runs, and the run-record reading of the backfill command.
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use polis_topic_map::from_run;
use polis_topic_map::stored::{self, NoMap, Outcome, Wires};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::io::Read as _;
use std::process::Command;

fn wires(r: &support::Run) -> Wires<'_> {
    Wires {
        positions: &r.positions,
        assignments: &r.assignments,
        names: &r.names,
    }
}

fn rows(wire: &str) -> Vec<Value> {
    let mut lines = wire.strip_suffix('\n').unwrap().split('\n');
    assert_eq!(
        lines.next().unwrap(),
        r#"{"codec":"delphi-storage-codec/1","family":"Delphi_TopicMapDocument","key":["conversation_id","part"]}"#
    );
    lines.map(|l| serde_json::from_str(l).unwrap()).collect()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[test]
fn a_run_stores_its_document_its_gzip_and_its_digest_in_three_rows() {
    for (set, zid) in [("biodiversity", 1424), ("bg2050", 2050)] {
        let run = support::run(set, zid, None);
        let id = support::identity(zid);
        let made = stored::store(&id, &wires(&run)).unwrap();
        let rows = rows(&made.wire);
        let parts: Vec<&str> = rows
            .iter()
            .map(|r| r["part"]["S"].as_str().unwrap())
            .collect();
        assert_eq!(
            parts,
            ["document", "document.gz", "execution", "sha256"],
            "{set}"
        );
        for r in &rows {
            assert_eq!(r["conversation_id"]["S"], zid.to_string());
            assert_eq!(r["job_id"]["S"], support::JOB);
            assert!(r.to_string().len() <= stored::ROW_LIMIT);
        }
        let document = rows[0]["body"]["S"].as_str().unwrap();
        assert_eq!(Some(document), made.document.as_deref());
        assert_eq!(rows[0]["schema"]["S"], "polis-topic-map/1");
        assert_eq!(rows[0]["bytes"]["N"], document.len().to_string());
        let sha = hex(&Sha256::digest(document.as_bytes()));
        assert_eq!(rows[3]["body"]["S"], sha.as_str());
        // The execution row is the run's record, as the provenance holds it.
        let execution: Value =
            serde_json::from_str(rows[2]["body"]["S"].as_str().unwrap()).unwrap();
        assert_eq!(execution, support::execution());
        // The gzip is the document.
        use base64::Engine as _;
        let gz = base64::engine::general_purpose::STANDARD
            .decode(rows[1]["body"]["B"].as_str().unwrap())
            .unwrap();
        assert_eq!(rows[1]["bytes"]["N"], gz.len().to_string());
        let mut back = String::new();
        flate2::read::GzDecoder::new(&gz[..])
            .read_to_string(&mut back)
            .unwrap();
        assert_eq!(back, document);
        let Outcome::Map {
            document: bytes,
            gzip,
            sha256,
        } = &made.outcome
        else {
            panic!("{:?}", made.outcome)
        };
        assert_eq!(
            (*bytes, *gzip, sha256.as_str()),
            (document.len(), gz.len(), sha.as_str())
        );
        println!(
            "{set}: {} comments, document {} bytes, gzip {} bytes, family file {} bytes",
            run.comments,
            document.len(),
            gz.len(),
            made.wire.len()
        );

        // The document: no comment text, no title, every comment, and its
        // provenance last, naming the run, its rule, models and inputs.
        let doc: Value = serde_json::from_str(document).unwrap();
        assert_eq!(doc["schema"], "polis-topic-map/1");
        assert_eq!(doc["title"], "");
        assert_eq!(doc["attribution"], "");
        assert_eq!(doc["points"]["text"], json!([]));
        assert_eq!(doc["points"]["id"].as_array().unwrap().len(), run.comments);
        assert_eq!(doc["run"]["jobId"], support::JOB);
        assert!(
            document.ends_with('}')
                && document.rfind("\"provenance\":").unwrap()
                    > document.rfind("\"points\":").unwrap()
        );
        let p = &doc["provenance"];
        assert_eq!(p["schema"], "polis-topic-map.provenance/1");
        assert_eq!(p["env"], "shadow-delphi-1");
        assert_eq!(p["jobId"], support::JOB);
        assert_eq!(p["runId"], id.run_id.as_str());
        assert_eq!(p["batchId"], id.batch_id.as_str());
        assert_eq!(p["scope"], "delphi");
        assert_eq!(p["selection"], "participant_visible/1");
        assert_eq!(p["models"], support::models());
        assert_eq!(p["execution"], support::execution());
        // The fixtures' names are a model's free-form names: none is a shape
        // the rule can check, so each is shown as `Topic <n>` and counted.
        assert_eq!(p["names"]["rule"], "polis-topic-map.names/2");
        let topics = doc["topics"].as_array().unwrap();
        let counted = ["generic", "keywords", "replaced"].map(|k| p["names"][k].as_u64().unwrap());
        assert_eq!(counted.iter().sum::<u64>(), topics.len() as u64);
        assert!(counted[2] > 0);
        assert_eq!(p["names"]["keywords"], 0);
        assert!(
            p["names"].get("model").is_none(),
            "the counts never claim who wrote a name"
        );
        assert_eq!(
            p["generator"],
            json!({"name": "polis-topic-map", "version": env!("CARGO_PKG_VERSION")})
        );
        let inputs = p["inputs"].as_array().unwrap();
        for (input, (family, wire)) in inputs.iter().zip([
            (stored::POSITIONS, &run.positions),
            (stored::ASSIGNMENTS, &run.assignments),
            (stored::NAMES, &run.names),
        ]) {
            assert_eq!(input["family"], family);
            assert_eq!(input["sha256"], hex(&Sha256::digest(wire.as_bytes())));
            assert_eq!(input["rows"], (wire.lines().count() - 1) as u64);
        }
        // Nothing in the document is comment text: the fixture's topic names
        // are the only words, and they are names, not comments.
        assert!(!document.contains("Comment "));
    }
}

#[test]
fn the_same_run_makes_the_same_bytes_and_another_rule_makes_another_map() {
    let run = support::run("biodiversity", 1424, None);
    let id = support::identity(1424);
    let a = stored::store(&id, &wires(&run)).unwrap();
    let b = stored::store(&id, &wires(&run)).unwrap();
    assert_eq!(a.wire, b.wire);
    // The same conversation under another rule is another run with its own
    // job, batch and scope: its rows and provenance name that run.
    let mut other = id.clone();
    other.job_id = "0000a001-0000-4000-8000-000000000002".into();
    other.batch_id = "0000a001-0000-4000-8000-0000000000b2".into();
    other.scope = "delphi:all_comments".into();
    other.selection = Some("all_comments/1".into());
    let c = stored::store(&other, &wires(&run)).unwrap();
    assert_ne!(a.wire, c.wire);
    let doc: Value = serde_json::from_str(c.document.as_deref().unwrap()).unwrap();
    assert_eq!(doc["provenance"]["scope"], "delphi:all_comments");
    assert_eq!(doc["provenance"]["selection"], "all_comments/1");
    assert!(
        rows(&c.wire)
            .iter()
            .all(|r| r["job_id"]["S"] == other.job_id.as_str())
    );
}

#[test]
fn a_run_with_nothing_to_draw_stores_one_typed_no_map_row() {
    let id = support::identity(1424);
    let full = support::run("biodiversity", 1424, None);
    let check = |made: stored::Stored, reason: NoMap| {
        let rows = rows(&made.wire);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[1]["part"]["S"], "no_map");
        assert_eq!(rows[0]["part"]["S"], "execution");
        let rows = [rows[1].clone()];
        assert_eq!(rows[0]["reason"]["S"], reason.as_str());
        assert_eq!(rows[0]["job_id"]["S"], support::JOB);
        assert!(made.document.is_none());
        rows[0].clone()
    };
    // Two comments: no first view.
    let two = support::run("biodiversity", 1424, Some(2));
    check(
        stored::store(&id, &wires(&two)).unwrap(),
        NoMap::TooFewComments,
    );
    // No topic names.
    let header_only = |wire: &str| format!("{}\n", wire.lines().next().unwrap());
    let names = header_only(&full.names);
    let no_names = Wires {
        names: &names,
        ..wires(&full)
    };
    check(stored::store(&id, &no_names).unwrap(), NoMap::NoTopics);
    // No positions at all.
    let (positions, assignments) = (header_only(&full.positions), header_only(&full.assignments));
    let empty = Wires {
        positions: &positions,
        assignments: &assignments,
        names: &full.names,
    };
    check(stored::store(&id, &empty).unwrap(), NoMap::NoPositions);
}

#[test]
fn a_document_over_the_row_limit_is_stored_as_too_large() {
    let run = support::run("biodiversity", 1424, None);
    let id = support::identity(1424);
    let made = stored::store(&id, &wires(&run)).unwrap();
    let bytes = made.document.as_ref().unwrap().len();
    let small = stored::store_with_limit(&id, &wires(&run), bytes).unwrap();
    let rows = rows(&small.wire);
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["part"]["S"], "execution");
    let rows = [rows[1].clone()];
    assert_eq!(rows[0]["part"]["S"], "no_map");
    assert_eq!(rows[0]["reason"]["S"], "too_large");
    assert_eq!(rows[0]["bytes"]["N"], bytes.to_string());
    assert_eq!(
        small.outcome,
        Outcome::NoMap {
            reason: NoMap::TooLarge,
            document: Some(bytes)
        }
    );
    // At the default limit the same run fits.
    assert_eq!(stored::ROW_LIMIT, 1_048_576);
    assert!(matches!(made.outcome, Outcome::Map { .. }));
}

#[test]
fn families_that_are_not_what_a_run_writes_are_refused() {
    let id = support::identity(1424);
    let run = support::run("biodiversity", 1424, None);
    // Another conversation's rows.
    let elsewhere = support::run("biodiversity", 999, None);
    let mixed = Wires {
        positions: &elsewhere.positions,
        ..wires(&run)
    };
    assert!(
        stored::store(&id, &mixed)
            .unwrap_err()
            .contains("another conversation")
    );
    // A family under another family's header.
    let swapped = Wires {
        positions: &run.names,
        ..wires(&run)
    };
    assert!(
        stored::store(&id, &swapped)
            .unwrap_err()
            .contains("codec header")
    );
    // Positions and clusters of different comments.
    let fewer = support::run("biodiversity", 1424, Some(40));
    let unequal = Wires {
        positions: &fewer.positions,
        ..wires(&run)
    };
    assert!(
        stored::store(&id, &unequal)
            .unwrap_err()
            .contains("different comments")
    );
    // No trailing newline.
    let cut = run.names.trim_end().to_owned();
    let truncated = Wires {
        names: &cut,
        ..wires(&run)
    };
    assert!(stored::store(&id, &truncated).is_err());
}

#[test]
fn the_step_command_writes_the_librarys_bytes() {
    let dir = std::path::PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("stored-map-step");
    std::fs::create_dir_all(&dir).unwrap();
    let run = support::run("bg2050", 2050, None);
    let id = support::identity(2050);
    for (name, text) in [
        ("positions", &run.positions),
        ("assignments", &run.assignments),
        ("names", &run.names),
    ] {
        std::fs::write(dir.join(format!("{name}.jsonl")), text).unwrap();
    }
    std::fs::write(dir.join("models.json"), support::models().to_string()).unwrap();
    std::fs::write(dir.join("execution.json"), support::execution().to_string()).unwrap();
    let out = dir.join("Delphi_TopicMapDocument.jsonl");
    let p = |name: &str| dir.join(name).display().to_string();
    let status = Command::new(env!("CARGO_BIN_EXE_polis-topic-map"))
        .args([
            "store", "--env", &id.env, "--job", &id.job_id, "--run", &id.run_id,
        ])
        .args([
            "--batch",
            &id.batch_id,
            "--conversation",
            "2050",
            "--scope",
            &id.scope,
        ])
        .args([
            "--selection",
            "participant_visible/1",
            "--models",
            &p("models.json"),
            "--execution",
            &p("execution.json"),
        ])
        .args([
            "--positions",
            &p("positions.jsonl"),
            "--assignments",
            &p("assignments.jsonl"),
        ])
        .args([
            "--names",
            &p("names.jsonl"),
            "--out",
            &out.display().to_string(),
        ])
        .output()
        .unwrap();
    assert!(
        status.status.success(),
        "{}",
        String::from_utf8_lossy(&status.stderr)
    );
    let made = stored::store(&id, &wires(&run)).unwrap();
    assert_eq!(std::fs::read_to_string(&out).unwrap(), made.wire);
    assert!(String::from_utf8_lossy(&status.stderr).contains("map, document"));
}

/// A run record as `pd_run_record` returns one for a succeeded full run.
fn record() -> Value {
    let family = |name: &str| {
        json!({"family": name, "batch_id": "0000a001-0000-4000-8000-0000000000b1",
               "job_id": support::JOB, "run_id": "0000a001-0000-4000-8000-0000000000a1", "origin": "queued",
               "content_sha256": "a".repeat(64), "row_count": 3, "scope": "delphi", "generation": 1,
               "served": true, "artifact_id": "0000a001-0000-4000-8000-0000000000c1"})
    };
    json!({
        "job_id": support::JOB, "zid": 1424, "run_id": "0000a001-0000-4000-8000-0000000000a1",
        "status": "succeeded", "state": "succeeded",
        "config_effective": {"result_backend": "postgres", "result_scope": "delphi", "selection": "participant_visible/1"},
        "manifest": {"inputs": {}, "models": support::models(), "cost": {}},
        "families": [family(stored::ASSIGNMENTS), family(stored::NAMES), family(stored::POSITIONS),
                     family("Delphi_UMAPConversationConfig")],
    })
}

#[test]
fn the_backfill_reads_the_runs_identity_from_its_record_as_the_step_has_it() {
    let plan = from_run::plan("shadow-delphi-1", support::JOB, &record()).unwrap();
    // The record cannot hold the execution: the backfill reads it from the
    // run's own stored map, else says the run has none.
    assert_eq!(
        plan.run,
        stored::RunIdentity {
            execution: stored::execution_unavailable(from_run::BEFORE_THE_STEP),
            ..support::identity(1424)
        }
    );
    assert_eq!(plan.inputs.len(), 3);
    assert!(plan.stored.is_none());
    // A map the run stored itself is found; one carried from an earlier run is not the run's.
    let mut with_map = record();
    let mut map = with_map["families"][0].clone();
    map["family"] = json!(stored::FAMILY);
    with_map["families"]
        .as_array_mut()
        .unwrap()
        .push(map.clone());
    assert!(
        from_run::plan("shadow-delphi-1", support::JOB, &with_map)
            .unwrap()
            .stored
            .is_some()
    );
    map["job_id"] = json!("0000a001-0000-4000-8000-000000000009");
    with_map["families"].as_array_mut().unwrap().pop();
    with_map["families"].as_array_mut().unwrap().push(map);
    assert!(
        from_run::plan("shadow-delphi-1", support::JOB, &with_map)
            .unwrap()
            .stored
            .is_none()
    );
}

#[test]
fn the_backfill_refuses_a_run_whose_record_is_not_one_runs_own_families() {
    let refused = |r: Value| from_run::plan("shadow-delphi-1", support::JOB, &r).unwrap_err();
    assert!(refused(Value::Null).contains("no job"));
    let mut running = record();
    running["state"] = json!("running");
    assert!(refused(running).contains("not succeeded"));
    let mut carried = record();
    carried["families"][1]["job_id"] = json!("0000a001-0000-4000-8000-000000000009");
    assert!(refused(carried).contains("did not produce its own"));
    let mut split = record();
    split["families"][2]["batch_id"] = json!("0000a001-0000-4000-8000-0000000000b9");
    assert!(refused(split).contains("different batches"));
    let mut missing = record();
    missing["families"].as_array_mut().unwrap().remove(2);
    assert!(refused(missing).contains("stored no"));
    let mut scopeless = record();
    scopeless["config_effective"] = json!({});
    assert!(refused(scopeless).contains("result scope"));
}

/// The keyword fallback's labels as `_conventional_labels` writes them
/// (`umap_narrative/topic_naming.py`), one per cluster of layer 0 of the
/// fixture, every one carrying a generated example comment.
fn with_names(run: &support::Run, label: impl Fn(i64) -> String) -> String {
    let mut lines = run.names.lines();
    let mut out = format!("{}\n", lines.next().unwrap());
    for line in lines {
        let mut row: Value = serde_json::from_str(line).unwrap();
        let cluster: i64 = row["cluster_id"]["N"].as_str().unwrap().parse().unwrap();
        row["topic_name"] = json!({"S": label(cluster)});
        out.push_str(&serde_json::to_string(&row).unwrap());
        out.push('\n');
    }
    out
}

#[test]
fn no_example_comment_of_a_keyword_label_reaches_the_document() {
    const MARKER: &str = "generated-only-example";
    let run = support::run("biodiversity", 1424, None);
    let id = support::identity(1424);
    // The four shapes the fallback writes, cut at 50 characters as it cuts.
    type Label = Box<dyn Fn(i64) -> String>;
    let shapes: [(&str, Label); 4] = [
        ("example only", Box::new(|_| format!("Example: {MARKER}"))),
        (
            "keywords and example",
            Box::new(|_| {
                format!(
                    "{}...",
                    &format!("Keywords: water, land | Example: {MARKER}")[..47]
                )
            }),
        ),
        (
            "cut inside the marker",
            Box::new(|_| "Keywords: alpha, beta, gamma, delta, epsil | Ex...".to_owned()),
        ),
        (
            "unrecognised",
            Box::new(|_| format!("{MARKER} said nothing else")),
        ),
    ];
    for (what, label) in shapes {
        let names = with_names(&run, label);
        let made = stored::store(
            &id,
            &Wires {
                names: &names,
                ..wires(&run)
            },
        )
        .unwrap();
        let document = made.document.unwrap();
        assert!(!document.contains("generated-only"), "{what}");
        assert!(!document.contains("Example"), "{what}");
        let doc: Value = serde_json::from_str(&document).unwrap();
        let names: Vec<&str> = doc["topics"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap())
            .collect();
        let counts = &doc["provenance"]["names"];
        match what {
            "example only" | "unrecognised" => {
                assert!(
                    names.iter().all(|n| n.starts_with("Topic ")),
                    "{what}: {names:?}"
                );
                assert!(counts["replaced"].as_u64().unwrap() > 0, "{what}");
            }
            "keywords and example" => {
                assert!(
                    names.iter().all(|n| *n == "Keywords: water, land"),
                    "{what}: {names:?}"
                );
                assert_eq!(counts["replaced"], 0, "{what}");
            }
            _ => assert!(
                names
                    .iter()
                    .all(|n| *n == "Keywords: alpha, beta, gamma, delta, epsil"),
                "{what}: {names:?}"
            ),
        }
    }
}

#[test]
fn only_generic_names_and_checked_keywords_are_kept() {
    use stored::{NameKind, safe_name};
    let kept = |l, c, n: &str, want: &str, kind| {
        assert_eq!(safe_name(l, c, n), (Some(want.to_owned()), kind), "{n}");
    };
    let replaced =
        |l, c, n: &str| assert_eq!(safe_name(l, c, n), (None, NameKind::Replaced), "{n}");
    // Generic names, prefixed or not: the pipeline's own fallback.
    kept(0, 3, "Topic 3", "Topic 3", NameKind::Generic);
    kept(0, 3, "0_3: Topic 3", "0_3: Topic 3", NameKind::Generic);
    kept(1, 0, "1_0:", "1_0:", NameKind::Generic);
    // A prefix is not proof of what a name holds, nor of who wrote it.
    replaced(0, 3, "0_3: Water rights");
    replaced(0, 0, "0_0: Example: generated-only-example");
    replaced(0, 3, "0_3: Topic 4");
    replaced(0, 4, "0_3: Topic 3");
    // Keyword labels, as `_conventional_labels` writes them.
    kept(
        0,
        3,
        "Keywords: water, rights, river",
        "Keywords: water, rights, river",
        NameKind::Keywords,
    );
    kept(
        0,
        3,
        "Keywords: water",
        "Keywords: water",
        NameKind::Keywords,
    );
    kept(
        0,
        3,
        "Keywords: wa, rights | Example: anything at all",
        "Keywords: wa, rights",
        NameKind::Keywords,
    );
    // Cut at 50 characters: inside the example, inside its marker, inside
    // the ` | `, and inside the last keyword.
    for (label, want) in [
        (
            "Keywords: alpha, beta | Example: generated-only...",
            "Keywords: alpha, beta",
        ),
        (
            "Keywords: alpha, beta, gamma, delta, epsilon | ...",
            "Keywords: alpha, beta, gamma, delta, epsilon",
        ),
        (
            "Keywords: alpha, beta, gamma, delta, epsilonn |...",
            "Keywords: alpha, beta, gamma, delta, epsilonn",
        ),
        (
            "Keywords: alpha, beta, gamma, delta, epsilonnn ...",
            "Keywords: alpha, beta, gamma, delta, epsilonnn",
        ),
        (
            "Keywords: alphabetical, betamaxed, gammaraysx, ...",
            "Keywords: alphabetical, betamaxed, gammaraysx",
        ),
        (
            "Keywords: alphabetical, betamaxed, gammaray, de...",
            "Keywords: alphabetical, betamaxed, gammaray, de",
        ),
    ] {
        assert_eq!(label.chars().count(), 50, "{label}");
        kept(0, 3, label, want, NameKind::Keywords);
    }
    // Not the keyword shape: replaced, whatever follows.
    replaced(0, 3, "Keywords: Example: generated-only-example");
    replaced(0, 3, "Keywords:  | Example: x");
    replaced(0, 3, "Keywords: water rights");
    replaced(0, 3, "Keywords: Water, rights");
    replaced(0, 3, "Keywords: water, rights | they said water is a right");
    replaced(0, 3, "Keywords: a, b, c, d, e, f");
    replaced(0, 3, "Keywords: water, x");
    replaced(0, 3, "Keywords: water, rights...");
    replaced(0, 3, "Example: anything a participant wrote");
}
