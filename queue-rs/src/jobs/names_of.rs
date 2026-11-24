//! A run that names another run's topics (`config.names_of`).
//!
//! A named run takes the layout and the clusters of a finished keyword run of
//! the same conversation and comment rule, and only names them: the two runs
//! hold the same positions and assignments, byte for byte, and differ in their
//! names. Before such a child starts, the daemon reads the source run's record
//! (`pd_run_record`) and the codec files of its two families
//! (`pd_result_artifact_wire`, each checked against the batch and digest the
//! record names) with the queue login, and writes them into
//! `inputs/names_of/` of the attempt directory; the frame names them in
//! `names_of`. Nothing is read from a file an earlier run left on a box: the
//! source's stored results in Postgres are the only source.
//!
//! Every way the source can be unusable is a refusal word, recorded as the
//! job's outcome before any child starts, never a crash and never a fresh
//! clustering: no such run, a run that has not succeeded, a run of another
//! conversation or comment rule, a run that is itself a named run, a run that
//! did not store its own two families in one batch, and a run whose stored
//! families were removed or replaced. Without `names_of` nothing here runs and
//! the frame is unchanged.
use anyhow::Result;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::path::Path;

/// The two families a named run copies, in this order.
pub const POSITIONS: &str = "Delphi_UMAPGraph";
pub const ASSIGNMENTS: &str = "Delphi_CommentHierarchicalClusterAssignments";
pub const FAMILIES: [&str; 2] = [POSITIONS, ASSIGNMENTS];
/// The files' directory inside the attempt directory.
pub const DIRECTORY: &str = "inputs/names_of";
/// The frame's `names_of` value names this schema.
pub const SCHEMA: &str = "polis-jobs.names-of/1";
/// The only comment rule a named run, and its source, can be under: the
/// comments participants are shown. No other rule's text reaches a model.
pub const SELECTION: &str = super::inputs::contract::PARTICIPANT_VISIBLE;

/// Why a source run cannot be named. Each is the job's recorded outcome.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    /// `names_of` is not a job id.
    NotAJob,
    /// `names_of` without a model namer: there would be nothing to name.
    WithoutNamer,
    /// The named run itself is under another comment rule.
    RuleNotNamed,
    /// No run record for the source job.
    Missing,
    /// The source has not succeeded (queued, running, dead or cancelled).
    Unfinished,
    /// The source is of another conversation.
    OtherConversation,
    /// The source is under another comment rule.
    OtherRule,
    /// The source is itself a named run: only a keyword run is named.
    Named,
    /// The source did not store its own positions and assignments in one batch.
    Incomplete,
    /// The source's stored families are gone or are not the batch it names.
    Removed,
    /// The queue could not be read (not permanent: the attempt may retry).
    Unreadable,
}

impl Refusal {
    pub fn word(self) -> &'static str {
        match self {
            Self::NotAJob => "names_of_not_a_job",
            Self::WithoutNamer => "names_of_without_namer",
            Self::RuleNotNamed => "names_of_selection_not_named",
            Self::Missing => "names_of_source_missing",
            Self::Unfinished => "names_of_source_unfinished",
            Self::OtherConversation => "names_of_source_other_conversation",
            Self::OtherRule => "names_of_source_other_rule",
            Self::Named => "names_of_source_named",
            Self::Incomplete => "names_of_source_incomplete",
            Self::Removed => "names_of_source_removed",
            Self::Unreadable => "names_of_source_unreadable",
        }
    }

    /// Whether a retry could change it: only a failed read.
    pub fn permanent(self) -> bool {
        self != Self::Unreadable
    }
}

/// The source job a run's configuration names, if any. A `names_of` is only
/// accepted with a model namer and the participant-shown rule.
pub fn source(config: &Value) -> Result<Option<String>, Refusal> {
    let job = match config.get("names_of") {
        None | Some(Value::Null) => return Ok(None),
        Some(Value::String(s)) => s,
        Some(_) => return Err(Refusal::NotAJob),
    };
    let job = uuid::Uuid::parse_str(job).map_err(|_| Refusal::NotAJob)?;
    if config["naming"]["by"] != "model" {
        return Err(Refusal::WithoutNamer);
    }
    if config["selection"] != SELECTION {
        return Err(Refusal::RuleNotNamed);
    }
    Ok(Some(job.hyphenated().to_string()))
}

/// One family of the source, as its record names it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Family {
    pub family: &'static str,
    pub artifact_id: String,
    pub batch_id: String,
    pub sha256: String,
}

/// What the source's record says, checked.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Plan {
    pub job_id: String,
    pub run_id: String,
    pub batch_id: String,
    pub families: Vec<Family>,
}

/// Check the source's run record (`pd_run_record(env, job)`, `Value::Null`
/// when there is none) for the named run of conversation `zid`.
pub fn plan(job: &str, zid: i64, record: &Value) -> Result<Plan, Refusal> {
    if record.is_null() || record["job_id"] != job {
        return Err(Refusal::Missing);
    }
    let state = record["state"]
        .as_str()
        .or_else(|| record["status"].as_str())
        .unwrap_or_default();
    if state != "succeeded" {
        return Err(Refusal::Unfinished);
    }
    if record["zid"].as_i64() != Some(zid) {
        return Err(Refusal::OtherConversation);
    }
    let config = &record["config_effective"];
    if config["selection"] != SELECTION {
        return Err(Refusal::OtherRule);
    }
    if !config["names_of"].is_null() || config["naming"]["by"] == "model" {
        return Err(Refusal::Named);
    }
    let listed = record["families"].as_array().ok_or(Refusal::Incomplete)?;
    let mut families = Vec::new();
    for name in FAMILIES {
        let mut found = listed.iter().filter(|f| f["family"] == name);
        let f = found.next().ok_or(Refusal::Incomplete)?;
        if found.next().is_some() || f["job_id"] != job {
            return Err(Refusal::Incomplete);
        }
        let text = |key: &str| {
            f[key]
                .as_str()
                .map(str::to_owned)
                .ok_or(Refusal::Incomplete)
        };
        families.push(Family {
            family: name,
            artifact_id: text("artifact_id")?,
            batch_id: text("batch_id")?,
            sha256: text("content_sha256")?,
        });
    }
    let batch_id = families[0].batch_id.clone();
    if families.iter().any(|f| f.batch_id != batch_id) {
        return Err(Refusal::Incomplete);
    }
    Ok(Plan {
        job_id: job.to_owned(),
        run_id: record["run_id"]
            .as_str()
            .ok_or(Refusal::Missing)?
            .to_owned(),
        batch_id,
        families,
    })
}

/// The source, read: its plan and each family's codec file.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Source {
    pub plan: Plan,
    pub wires: Vec<String>,
}

/// Read the source through `call` (a committed queue call by name, as
/// `Rpc::committed` makes it): the record, then each family's wire, each
/// checked against the batch and digest the record names. A stored batch is
/// immutable, so the checks make the separate reads one consistent source.
pub fn read(
    mut call: impl FnMut(&str, &[Value]) -> Result<Value>,
    env: &str,
    job: &str,
    zid: i64,
) -> Result<Source, Refusal> {
    let record =
        call("pd_run_record", &[json!(env), json!(job)]).map_err(|_| Refusal::Unreadable)?;
    let plan = plan(job, zid, &record)?;
    let mut wires = Vec::new();
    for f in &plan.families {
        let w = call(
            "pd_result_artifact_wire",
            &[json!(env), json!(f.artifact_id), json!(f.family)],
        )
        .map_err(|_| Refusal::Unreadable)?;
        let wire = w["wire"].as_str().ok_or(Refusal::Removed)?;
        if w["batch_id"] != f.batch_id.as_str()
            || w["sha256"] != f.sha256.as_str()
            || sha256_hex(wire.as_bytes()) != f.sha256
        {
            return Err(Refusal::Removed);
        }
        wires.push(wire.to_owned());
    }
    Ok(Source { plan, wires })
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Write the source's files into `attempt_dir/inputs/names_of/` and return
/// the frame's `names_of` value.
pub fn write(attempt_dir: &Path, source: &Source) -> Result<Value> {
    let dir = attempt_dir.join(DIRECTORY);
    std::fs::create_dir_all(&dir)?;
    let mut families = serde_json::Map::new();
    for (f, wire) in source.plan.families.iter().zip(&source.wires) {
        let file = format!("{}.jsonl", f.family);
        std::fs::write(dir.join(&file), wire)?;
        families.insert(
            f.family.to_owned(),
            json!({"file": format!("{DIRECTORY}/{file}"), "sha256": f.sha256}),
        );
    }
    Ok(json!({
        "schema": SCHEMA,
        "job_id": source.plan.job_id,
        "run_id": source.plan.run_id,
        "batch_id": source.plan.batch_id,
        "families": families,
    }))
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::type_complexity)]
mod tests {
    use super::*;

    const JOB: &str = "00000000-0000-4000-8000-00000000000a";

    fn record() -> Value {
        let family = |name: &str, artifact: &str| {
            json!({"family": name, "job_id": JOB, "artifact_id": artifact,
                   "batch_id": "b1", "content_sha256": sha256_hex(name.as_bytes())})
        };
        json!({
            "job_id": JOB, "run_id": "r1", "state": "succeeded", "zid": 7,
            "config_effective": {"selection": SELECTION, "result_scope": "delphi"},
            "families": [family(POSITIONS, "a1"), family(ASSIGNMENTS, "a1"),
                         family("Delphi_CommentClustersLLMTopicNames", "a1")],
        })
    }

    fn named(source: &str) -> Value {
        json!({"names_of": source, "selection": SELECTION,
               "naming": {"by": "model", "model": "claude-haiku-5-5",
                          "prompt": "polis-topic-names/1", "thinking": "default"}})
    }

    #[test]
    fn a_run_without_names_of_has_no_source() {
        assert_eq!(source(&json!({"selection": SELECTION})), Ok(None));
        assert_eq!(source(&json!({"names_of": null})), Ok(None));
    }

    #[test]
    fn names_of_needs_a_job_id_a_model_namer_and_the_shown_rule() {
        assert_eq!(source(&named(JOB)), Ok(Some(JOB.to_owned())));
        assert_eq!(source(&named("not a job")), Err(Refusal::NotAJob));
        assert_eq!(
            source(&json!({"names_of": 3, "selection": SELECTION})),
            Err(Refusal::NotAJob)
        );
        let mut keywords = named(JOB);
        keywords["naming"] = json!({"by": "keywords"});
        assert_eq!(source(&keywords), Err(Refusal::WithoutNamer));
        keywords["naming"] = Value::Null;
        assert_eq!(source(&keywords), Err(Refusal::WithoutNamer));
        for rule in ["all_comments/1", "all_but_moderated_out/1"] {
            let mut other = named(JOB);
            other["selection"] = json!(rule);
            assert_eq!(source(&other), Err(Refusal::RuleNotNamed), "{rule}");
        }
    }

    #[test]
    fn a_finished_keyword_run_of_the_conversation_is_planned() {
        let p = plan(JOB, 7, &record()).unwrap();
        assert_eq!(p.batch_id, "b1");
        assert_eq!(
            p.families.iter().map(|f| f.family).collect::<Vec<_>>(),
            FAMILIES
        );
    }

    #[test]
    fn every_unusable_source_is_its_own_refusal() {
        let cases: Vec<(Box<dyn Fn(&mut Value)>, Refusal)> = vec![
            (Box::new(|r| *r = Value::Null), Refusal::Missing),
            (
                Box::new(|r| r["job_id"] = json!("another")),
                Refusal::Missing,
            ),
            (
                Box::new(|r| r["state"] = json!("running")),
                Refusal::Unfinished,
            ),
            (
                Box::new(|r| r["state"] = json!("dead")),
                Refusal::Unfinished,
            ),
            (
                Box::new(|r| r["zid"] = json!(8)),
                Refusal::OtherConversation,
            ),
            (
                Box::new(|r| r["config_effective"]["selection"] = json!("all_comments/1")),
                Refusal::OtherRule,
            ),
            (
                Box::new(|r| r["config_effective"]["selection"] = Value::Null),
                Refusal::OtherRule,
            ),
            (
                Box::new(|r| r["config_effective"]["names_of"] = json!(JOB)),
                Refusal::Named,
            ),
            (
                Box::new(|r| r["config_effective"]["naming"] = json!({"by": "model"})),
                Refusal::Named,
            ),
            (
                Box::new(|r| r["families"][0]["job_id"] = json!("earlier")),
                Refusal::Incomplete,
            ),
            (
                Box::new(|r| r["families"][1]["batch_id"] = json!("b0")),
                Refusal::Incomplete,
            ),
            (
                Box::new(|r| {
                    r["families"].as_array_mut().unwrap().remove(1);
                }),
                Refusal::Incomplete,
            ),
        ];
        for (change, refusal) in cases {
            let mut r = record();
            change(&mut r);
            assert_eq!(plan(JOB, 7, &r), Err(refusal));
        }
    }

    fn reader(
        record: Value,
        wire: impl Fn(&str) -> Value,
    ) -> impl FnMut(&str, &[Value]) -> Result<Value> {
        move |name, args| match name {
            "pd_run_record" => Ok(record.clone()),
            "pd_result_artifact_wire" => Ok(wire(args[2].as_str().unwrap())),
            _ => anyhow::bail!("unexpected {name}"),
        }
    }

    #[test]
    fn the_read_checks_each_wire_against_the_record() {
        let good =
            |f: &str| json!({"wire": f, "batch_id": "b1", "sha256": sha256_hex(f.as_bytes())});
        let s = read(reader(record(), good), "e", JOB, 7).unwrap();
        assert_eq!(s.wires, vec![POSITIONS.to_owned(), ASSIGNMENTS.to_owned()]);

        // Removed by retention: the wire function finds nothing.
        let gone = |_: &str| json!({"wire": null, "batch_id": null, "sha256": null});
        assert_eq!(
            read(reader(record(), gone), "e", JOB, 7),
            Err(Refusal::Removed)
        );
        // Another batch's bytes, or bytes that are not the digest.
        let other =
            |f: &str| json!({"wire": f, "batch_id": "b2", "sha256": sha256_hex(f.as_bytes())});
        assert_eq!(
            read(reader(record(), other), "e", JOB, 7),
            Err(Refusal::Removed)
        );
        let changed =
            |f: &str| json!({"wire": "x", "batch_id": "b1", "sha256": sha256_hex(f.as_bytes())});
        assert_eq!(
            read(reader(record(), changed), "e", JOB, 7),
            Err(Refusal::Removed)
        );
        // A failed read may be retried; nothing else may.
        let fail = |_: &str, _: &[Value]| -> Result<Value> { anyhow::bail!("down") };
        assert_eq!(read(fail, "e", JOB, 7), Err(Refusal::Unreadable));
        assert!(!Refusal::Unreadable.permanent() && Refusal::Removed.permanent());
    }

    #[test]
    fn the_files_are_the_wires_and_the_frame_names_them() -> Result<()> {
        let dir = std::env::temp_dir().join(format!("polis-names-of-{}", uuid::Uuid::new_v4()));
        let good =
            |f: &str| json!({"wire": f, "batch_id": "b1", "sha256": sha256_hex(f.as_bytes())});
        let s = read(reader(record(), good), "e", JOB, 7).unwrap();
        let frame = write(&dir, &s)?;
        assert_eq!(frame["schema"], SCHEMA);
        assert_eq!(frame["job_id"], JOB);
        for f in FAMILIES {
            let entry = &frame["families"][f];
            let bytes = std::fs::read(dir.join(entry["file"].as_str().unwrap()))?;
            assert_eq!(bytes, f.as_bytes());
            assert_eq!(entry["sha256"], sha256_hex(f.as_bytes()));
        }
        std::fs::remove_dir_all(&dir)?;
        Ok(())
    }
}
