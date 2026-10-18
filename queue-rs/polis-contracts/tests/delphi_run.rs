//! delphi-run/1: golden fixtures round trip byte for byte, every closed set
//! is the executor's own (read from the migrations), and every rule of
//! `DelphiRun::new` refuses what it names.
mod support;

use polis_contracts::delphi_run::{
    AttemptOutcome, DelphiRun, FamilyState, JobKind, LegacyFamily, Origin, ProviderRequestState,
    ResultFamily, RunFamily, Stage, StageState,
};
use polis_contracts::wire::{to_json, to_json_pretty};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use support::{fixtures, minify, read};

const FIXTURES: [&str; 11] = [
    "graph-node",
    "graph-root",
    "legacy-import",
    "math-rebuild-lease-expired",
    "narrative-parked",
    "synchronous-edit",
    "writer-cancelled-queued",
    "writer-cancelled-running",
    "writer-dead",
    "writer-running",
    "writer-succeeded",
];

fn fixture(name: &str) -> Value {
    serde_json::from_str(&read(&format!(
        "queue-rs/polis-contracts/tests/fixtures/delphi-run/{name}.json"
    )))
    .unwrap()
}

fn decode(v: &Value) -> Result<DelphiRun, String> {
    serde_json::from_str::<DelphiRun>(&serde_json::to_string(v).unwrap()).map_err(|e| e.to_string())
}

#[test]
fn the_golden_fixture_set_is_complete() {
    let names: Vec<String> = fixtures("delphi-run").into_iter().map(|(n, _)| n).collect();
    assert_eq!(names, FIXTURES);
}

#[test]
fn every_golden_fixture_round_trips_byte_for_byte() {
    for (name, text) in fixtures("delphi-run") {
        let run: DelphiRun = serde_json::from_str(&text).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(
            format!("{}\n", to_json_pretty(&run).unwrap()),
            text,
            "{name}"
        );
        assert_eq!(to_json(&run).unwrap(), minify(&text), "{name}");
        let again = DelphiRun::new(run.clone().into_fields()).unwrap();
        assert_eq!(again, run, "{name}");
    }
}

#[test]
fn the_fixtures_cover_every_state_and_outcome() {
    let mut states = BTreeSet::new();
    let mut outcomes = BTreeSet::new();
    let mut stages = BTreeSet::new();
    let mut family_states = BTreeSet::new();
    let mut origins = BTreeSet::new();
    for name in FIXTURES {
        let run = decode(&fixture(name)).unwrap();
        origins.insert(run.origin);
        states.insert(run.state);
        outcomes.extend(run.attempt.as_ref().map(|a| a.outcome));
        stages.extend(run.stage);
        for node in &run.nodes {
            states.insert(node.state);
            stages.insert(node.stage);
            outcomes.extend(node.attempt.as_ref().map(|a| a.outcome));
        }
        for output in run.outputs.families.iter() {
            family_states.insert(match output.state {
                FamilyState::NotStarted => "not_started",
                FamilyState::Running(_) => "running",
                FamilyState::Succeeded { .. } => "succeeded",
                FamilyState::Failed { .. } => "failed",
                FamilyState::Superseded { .. } => "superseded",
            });
        }
    }
    assert_eq!(states, StageState::ALL.iter().copied().collect());
    assert_eq!(outcomes, AttemptOutcome::ALL.iter().copied().collect());
    assert_eq!(stages, Stage::ALL.iter().copied().collect());
    assert_eq!(origins, Origin::ALL.iter().copied().collect());
    assert_eq!(
        family_states,
        [
            "failed",
            "not_started",
            "running",
            "succeeded",
            "superseded"
        ]
        .into_iter()
        .collect()
    );
}

/// The quoted values of the first `IN (…)` list after `marker` in a migration.
fn sql_set(migration: &str, marker: &str) -> Vec<String> {
    let text = read(&format!("server/postgres/migrations/{migration}"));
    let at = text
        .find(marker)
        .unwrap_or_else(|| panic!("{marker} in {migration}"));
    let rest = &text[at + marker.len()..];
    let list = &rest[..rest.find(')').unwrap()];
    list.split(',')
        .map(|v| v.trim().trim_matches('\'').to_owned())
        .collect()
}

fn spellings<T: Copy>(all: &[T], name: impl Fn(T) -> &'static str) -> Vec<String> {
    all.iter().map(|v| name(*v).to_owned()).collect()
}

#[test]
fn every_closed_set_is_the_executor_s_own() {
    let states = spellings(StageState::ALL, StageState::as_str);
    assert_eq!(
        sql_set(
            "000019_create_polis_queue.sql",
            "DEFAULT 'queued' CHECK(state IN ("
        ),
        states
    );
    assert_eq!(
        sql_set(
            "000023_create_delphi_foundation.sql",
            "status text NOT NULL CHECK(status IN ("
        ),
        states
    );
    assert_eq!(
        sql_set("000019_create_polis_queue.sql", "CHECK(outcome IN ("),
        spellings(AttemptOutcome::ALL, AttemptOutcome::as_str)
    );
    let mut stages = sql_set(
        "000029_extend_delphi_graph_stages.sql",
        "ADD CHECK(stage IN (",
    );
    assert_eq!(
        stages.remove(0),
        "noop",
        "noop is the queue's test-only stage"
    );
    assert_eq!(stages, spellings(Stage::ALL, Stage::as_str));
    assert_eq!(
        sql_set(
            "000029_extend_delphi_graph_stages.sql",
            "ADD CHECK(kind IN ("
        ),
        spellings(JobKind::ALL, JobKind::as_str)
    );
    assert_eq!(
        sql_set("000023_create_delphi_foundation.sql", "CHECK(origin IN ("),
        spellings(Origin::ALL, Origin::as_str)
    );
    assert_eq!(
        sql_set(
            "000023_create_delphi_foundation.sql",
            "state text NOT NULL CHECK(state IN ("
        ),
        spellings(ProviderRequestState::ALL, ProviderRequestState::as_str)
    );
    let catalog = read("server/postgres/migrations/000028_create_delphi_results.sql");
    let start = catalog
        .find("INSERT INTO public.delphi_result_catalog VALUES")
        .unwrap();
    let rows = &catalog[start..catalog[start..].find(";\n").unwrap() + start];
    let mut families: Vec<String> = rows
        .lines()
        .skip(1)
        .map(|l| {
            l.trim_start_matches("('")
                .split('\'')
                .next()
                .unwrap()
                .to_owned()
        })
        .collect();
    assert_eq!(families.len(), 18);
    families.sort();
    let mut ours: Vec<String> = ResultFamily::all()
        .filter(|f| f.in_catalog())
        .map(|f| f.as_str().to_owned())
        .collect();
    ours.sort();
    assert_eq!(
        families, ours,
        "run and legacy families together are the catalog"
    );
    let outside: Vec<&str> = ResultFamily::all()
        .filter(|f| !f.in_catalog())
        .map(|f| f.as_str())
        .collect();
    assert_eq!(outside, ["topic_stats", "visualizations"]);
    // Delphi's own math stage and its priorities are legacy, never run output.
    for retired in [
        "Delphi_PCAConversationConfig",
        "Delphi_PCAResults",
        "Delphi_KMeansClusters",
        "Delphi_CommentRouting",
        "Delphi_RepresentativeComments",
        "Delphi_PCAParticipantProjections",
    ] {
        assert!(matches!(
            ResultFamily::parse(retired),
            Some(ResultFamily::Legacy(_))
        ));
    }
}

#[test]
fn every_enum_variant_round_trips() {
    fn each<T>(all: &[T], name: impl Fn(T) -> &'static str)
    where
        T: Copy + PartialEq + std::fmt::Debug + serde::Serialize + serde::de::DeserializeOwned,
    {
        for v in all {
            let text = to_json(v).unwrap();
            assert_eq!(text, format!("\"{}\"", name(*v)));
            assert_eq!(serde_json::from_str::<T>(&text).unwrap(), *v);
        }
        assert!(serde_json::from_str::<T>("\"not_a_variant\"").is_err());
    }
    each(StageState::ALL, StageState::as_str);
    each(AttemptOutcome::ALL, AttemptOutcome::as_str);
    each(Stage::ALL, Stage::as_str);
    each(JobKind::ALL, JobKind::as_str);
    each(Origin::ALL, Origin::as_str);
    each(ProviderRequestState::ALL, ProviderRequestState::as_str);
    each(RunFamily::ALL, RunFamily::as_str);
    each(LegacyFamily::ALL, LegacyFamily::as_str);
    for f in ResultFamily::all() {
        let text = to_json(&f).unwrap();
        assert_eq!(text, format!("\"{}\"", f.as_str()));
        assert_eq!(serde_json::from_str::<ResultFamily>(&text).unwrap(), f);
    }
    assert!(serde_json::from_str::<ResultFamily>("\"Delphi_JobQueue\"").is_err());
    for stage in Stage::ALL {
        assert!(JobKind::ALL.contains(&stage.kind()));
    }
}

#[test]
fn the_family_dependencies_are_declared_and_acyclic() {
    use RunFamily as F;
    for (family, upstream) in [
        (F::NarrativeReports, F::CommentClustersLlmTopicNames),
        (F::CollectiveStatement, F::CommentClustersLlmTopicNames),
        (F::Visualizations, F::UmapGraph),
        (
            F::CommentClustersLlmTopicNames,
            F::CommentHierarchicalClusterAssignments,
        ),
        (
            F::CommentHierarchicalClusterAssignments,
            F::CommentEmbeddings,
        ),
        (F::UmapGraph, F::CommentEmbeddings),
    ] {
        assert!(family.upstream().contains(&upstream), "{family:?}");
    }
    for legacy in LegacyFamily::ALL {
        assert!(ResultFamily::Legacy(*legacy).upstream().is_empty());
    }
    fn depth(f: RunFamily, seen: &mut Vec<RunFamily>) -> usize {
        assert!(!seen.contains(&f), "a cycle through {f:?}");
        seen.push(f);
        let d = f
            .upstream()
            .iter()
            .map(|u| depth(*u, seen) + 1)
            .max()
            .unwrap_or(0);
        seen.pop();
        d
    }
    for f in RunFamily::ALL {
        let mut listed = f.upstream().to_vec();
        listed.dedup();
        assert_eq!(listed.len(), f.upstream().len());
        assert!(!f.upstream().contains(f));
        depth(*f, &mut Vec::new());
    }
    assert_eq!(depth(F::NarrativeReports, &mut Vec::new()), 3);
    assert_eq!(depth(F::CommentEmbeddings, &mut Vec::new()), 0);
}

#[test]
fn the_inputs_digest_is_the_sha256_of_the_five_inputs() {
    let v = fixture("writer-succeeded");
    let i = &v["inputs"];
    let five = format!(
        "{{\"math_env\":{},\"math_tick\":{},\"math_caching_tick\":{},\"comment_set_sha256\":{},\"vote_hwm\":{}}}",
        i["math_env"], i["math_tick"], i["math_caching_tick"], i["comment_set_sha256"], i["vote_hwm"]
    );
    let hex: String = Sha256::digest(five.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    assert_eq!(i["inputs_sha256"], json!(hex));
    let run = decode(&v).unwrap();
    assert_eq!(run.inputs.as_ref().unwrap().digest().as_str(), hex);
}

fn edit(name: &str, f: impl Fn(&mut Value)) -> Value {
    let mut v = fixture(name);
    f(&mut v);
    v
}

fn family<'a>(v: &'a mut Value, name: &str) -> &'a mut Value {
    v["outputs"]["families"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|f| f["family"] == name)
        .unwrap()
}

#[test]
fn every_rule_refuses_what_it_names() {
    const E: &str = "Delphi_CommentEmbeddings";
    const T: &str = "Delphi_CommentClustersLLMTopicNames";
    const N: &str = "Delphi_NarrativeReports";
    const K: &str = "Delphi_KMeansClusters";
    let other = "0000d001-0000-4000-8000-0000000000ff";
    let cases: Vec<(&str, Value)> = vec![
        (
            "another contract version",
            edit("writer-succeeded", |v| {
                v["contract_version"] = json!("delphi-run/2")
            }),
        ),
        (
            "an unknown key",
            edit("writer-succeeded", |v| v["publication"] = json!(null)),
        ),
        (
            "an unknown attempt key",
            edit("writer-succeeded", |v| {
                v["attempt"]["owner_id"] = json!(other)
            }),
        ),
        (
            "an unknown family key",
            edit("writer-succeeded", |v| {
                family(v, E)["produced_here"] = json!(true)
            }),
        ),
        (
            "an unknown node key",
            edit("graph-root", |v| v["nodes"][0]["key"] = json!("cluster")),
        ),
        (
            "a missing nullable key",
            edit("writer-succeeded", |v| {
                v.as_object_mut().unwrap().remove("graph_id");
            }),
        ),
        (
            "an uppercase uuid",
            edit("writer-succeeded", |v| {
                v["job_id"] = json!("0000D001-0000-4000-8000-000000000001")
            }),
        ),
        (
            "a job id that is not a uuid",
            edit("writer-succeeded", |v| {
                v["job_id"] = json!("batch_report_r1_1_x")
            }),
        ),
        (
            "a digest that is not hex",
            edit("writer-succeeded", |v| {
                v["outputs"]["manifest_sha256"] = json!("x".repeat(64))
            }),
        ),
        (
            "a time without a zone",
            edit("writer-succeeded", |v| {
                v["created_at"] = json!("2026-10-18T19:59:58.000000")
            }),
        ),
        (
            "an unknown stage",
            edit("writer-succeeded", |v| v["stage"] = json!("noop")),
        ),
        (
            "an unknown family",
            edit("writer-succeeded", |v| {
                family(v, E)["family"] = json!("Delphi_JobQueue")
            }),
        ),
        (
            "attempt number 0",
            edit("writer-succeeded", |v| v["attempt"]["number"] = json!(0)),
        ),
        (
            "lease epoch 0",
            edit("writer-succeeded", |v| {
                v["attempt"]["lease_epoch"] = json!(0)
            }),
        ),
        (
            "max_attempts 0",
            edit("writer-succeeded", |v| {
                v["attempt"]["max_attempts"] = json!(0)
            }),
        ),
        (
            "max_attempts 101",
            edit("writer-succeeded", |v| {
                v["attempt"]["max_attempts"] = json!(101)
            }),
        ),
        (
            "generation 0",
            edit("writer-succeeded", |v| {
                family(v, E)["publication"]["generation"] = json!(0)
            }),
        ),
        (
            "a scope over 128 characters",
            edit("writer-succeeded", |v| {
                family(v, E)["publication"]["scope"] = json!("s".repeat(129))
            }),
        ),
        (
            "a tampered inputs digest",
            edit("writer-succeeded", |v| {
                v["inputs"]["vote_hwm"] = json!(1760817600001u64)
            }),
        ),
        // Origin.
        (
            "a legacy import with a run id",
            edit("legacy-import", |v| v["run_id"] = json!(other)),
        ),
        (
            "a legacy import with a stage",
            edit("legacy-import", |v| {
                v["stage"] = json!("delphi_full_pipeline")
            }),
        ),
        (
            "a legacy import that is not terminal",
            edit("legacy-import", |v| v["state"] = json!("queued")),
        ),
        (
            "a queued job without a run id",
            edit("writer-succeeded", |v| v["run_id"] = json!(null)),
        ),
        (
            "a queued job without a stage",
            edit("writer-succeeded", |v| v["stage"] = json!(null)),
        ),
        (
            "a kind that does not follow from the stage",
            edit("writer-succeeded", |v| v["kind"] = json!("narrative")),
        ),
        // Graph position.
        (
            "a job that is its own parent",
            edit("graph-node", |v| v["parent_job_id"] = v["job_id"].clone()),
        ),
        (
            "a parent outside a graph",
            edit("writer-succeeded", |v| v["parent_job_id"] = json!(other)),
        ),
        (
            "a parent that is not the root",
            edit("graph-node", |v| v["parent_job_id"] = json!(other)),
        ),
        (
            "a root that is another job without a parent",
            edit("writer-succeeded", |v| v["root_job_id"] = json!(other)),
        ),
        (
            "a graph stage outside a graph",
            edit("graph-root", |v| v["graph_id"] = json!(null)),
        ),
        (
            "a writer stage inside a graph",
            edit("writer-succeeded", |v| v["graph_id"] = json!(other)),
        ),
        (
            "nodes on a non-root record",
            edit("graph-node", |v| {
                v["nodes"] = fixture("graph-root")["nodes"].clone()
            }),
        ),
        (
            "a node running a writer stage",
            edit("graph-root", |v| {
                v["nodes"][1]["stage"] = json!("delphi_full_pipeline")
            }),
        ),
        (
            "a node listed twice",
            edit("graph-root", |v| {
                let n = v["nodes"][1].clone();
                v["nodes"].as_array_mut().unwrap().push(n);
            }),
        ),
        (
            "a running node without a running attempt",
            edit("graph-root", |v| v["nodes"][1]["state"] = json!("running")),
        ),
        // State, attempt, failure.
        (
            "a running job whose attempt is not running",
            edit("writer-running", |v| {
                v["attempt"]["outcome"] = json!("expired")
            }),
        ),
        (
            "a running attempt on a job that is not running",
            edit("writer-cancelled-running", |v| {
                v["attempt"]["outcome"] = json!("running");
                v["attempt"]["ended_at"] = json!(null);
            }),
        ),
        (
            "a succeeded job whose attempt did not succeed",
            edit("writer-succeeded", |v| {
                v["attempt"]["outcome"] = json!("dead")
            }),
        ),
        (
            "a succeeded queued job without an attempt",
            edit("synchronous-edit", |v| v["attempt"] = json!(null)),
        ),
        (
            "a running attempt that has ended",
            edit("writer-running", |v| {
                v["attempt"]["ended_at"] = json!("2026-10-18T21:00:06.000000+00:00")
            }),
        ),
        (
            "completed_at on a running job",
            edit("writer-running", |v| {
                v["completed_at"] = json!("2026-10-18T21:00:06.000000+00:00")
            }),
        ),
        (
            "a failure on a succeeded job",
            edit("writer-succeeded", |v| {
                v["failure"] = fixture("writer-dead")["failure"].clone()
            }),
        ),
        (
            "a cancelled code on a dead job",
            edit("writer-dead", |v| v["failure"]["code"] = json!("cancelled")),
        ),
        (
            "a dead code on a cancelled job",
            edit("writer-cancelled-running", |v| {
                v["failure"]["code"] = json!("stage_failed")
            }),
        ),
        (
            "a failure naming another attempt",
            edit("writer-dead", |v| v["failure"]["attempt"] = json!(2)),
        ),
        (
            "a failure carrying log text",
            edit("writer-dead", |v| {
                v["failure"]["message"] = json!("Traceback")
            }),
        ),
        // Models and cost.
        (
            "a clustering seed without a clustering model",
            edit("graph-node", |v| v["models"]["cluster"] = json!(null)),
        ),
        (
            "a submitted provider request without a batch id",
            edit("narrative-parked", |v| {
                v["cost"]["provider_requests"][0]["batch_id"] = json!(null)
            }),
        ),
        (
            "a provider request listed twice",
            edit("narrative-parked", |v| {
                let r = v["cost"]["provider_requests"][0].clone();
                v["cost"]["provider_requests"]
                    .as_array_mut()
                    .unwrap()
                    .push(r);
            }),
        ),
        // Families.
        (
            "a family listed twice",
            edit("writer-succeeded", |v| {
                let f = family(v, E).clone();
                v["outputs"]["families"].as_array_mut().unwrap().push(f);
            }),
        ),
        (
            "an upstream family missing",
            edit("writer-succeeded", |v| {
                family(v, T)["upstream"].as_array_mut().unwrap().pop();
            }),
        ),
        (
            "an undeclared upstream family",
            edit("writer-succeeded", |v| {
                let u = json!({"family": E, "job_id": v["job_id"], "run_id": v["run_id"]});
                family(v, E)["upstream"].as_array_mut().unwrap().push(u);
            }),
        ),
        (
            "an upstream family named twice",
            edit("writer-succeeded", |v| {
                let u = family(v, N)["upstream"][0].clone();
                family(v, N)["upstream"].as_array_mut().unwrap().push(u);
            }),
        ),
        (
            "a family produced here under another run id",
            edit("writer-succeeded", |v| {
                family(v, E)["producer"]["run_id"] = json!(other)
            }),
        ),
        (
            "a family produced here in another attempt's batch",
            edit("writer-succeeded", |v| {
                family(v, E)["batch"]["batch_id"] = json!(other)
            }),
        ),
        (
            "a family published by a job that has not succeeded",
            edit("writer-running", |v| {
                let f = family(v, E);
                f["state"] = json!("succeeded");
                f["batch"] = json!({"batch_id": "0000d001-0000-4000-8000-0000000000b2", "content_sha256": "a".repeat(64), "row_count": 1});
                f["publication"] = json!({"scope": "pipeline", "generation": 3});
            }),
        ),
        (
            "another run's family listed as running",
            edit("writer-succeeded", |v| {
                let f = family(v, N);
                f["state"] = json!("running");
                f.as_object_mut().unwrap().remove("batch");
                f.as_object_mut().unwrap().remove("publication");
            }),
        ),
        (
            "a succeeded family without its publication",
            edit("writer-succeeded", |v| {
                family(v, E).as_object_mut().unwrap().remove("publication");
            }),
        ),
        (
            "a superseded family without its batch",
            edit("synchronous-edit", |v| {
                family(v, "Delphi_CollectiveStatement")
                    .as_object_mut()
                    .unwrap()
                    .remove("batch");
            }),
        ),
        (
            "a not-started family with a producer",
            edit("writer-running", |v| {
                let p = family(v, E)["producer"].clone();
                let f = family(v, T);
                f["producer"] = p;
                f["upstream"] = json!([]);
            }),
        ),
        (
            "a running family with a batch",
            edit(
                "writer-running",
                |v| family(v, E)["batch"] = json!({"batch_id": "0000d001-0000-4000-8000-0000000000b2", "content_sha256": "a".repeat(64), "row_count": 1}),
            ),
        ),
        (
            "a failed family without its reason",
            edit("writer-dead", |v| {
                family(v, E).as_object_mut().unwrap().remove("failure");
            }),
        ),
        (
            "a failed family with an open reason",
            edit("writer-dead", |v| {
                family(v, E)["failure"]["reason"] = json!("oom")
            }),
        ),
        (
            "a family state outside the set",
            edit("writer-running", |v| family(v, E)["state"] = json!("stale")),
        ),
        (
            "a producer without upstream",
            edit("writer-running", |v| {
                family(v, E).as_object_mut().unwrap().remove("upstream");
            }),
        ),
        // Legacy families and the math snapshot.
        (
            "a legacy family produced by a new run",
            edit("writer-succeeded", |v| {
                let r = json!({"job_id": v["job_id"], "run_id": v["run_id"]});
                let f = family(v, K);
                f["producer"] = r;
                f["batch"]["batch_id"] = json!("0000d001-0000-4000-8000-0000000000b1");
            }),
        ),
        (
            "a legacy family being computed",
            edit("legacy-import", |v| {
                let f = family(v, "Delphi_CommentExtremity");
                f["state"] = json!("running");
                f.as_object_mut().unwrap().remove("batch");
                f.as_object_mut().unwrap().remove("publication");
            }),
        ),
        (
            "a legacy family with an upstream run",
            edit("writer-succeeded", |v| {
                let u = json!({"family": E, "job_id": v["job_id"], "run_id": v["run_id"]});
                family(v, K)["upstream"] = json!([u]);
            }),
        ),
        (
            "a retired family as an upstream",
            edit("writer-succeeded", |v| {
                family(v, N)["upstream"][0]["family"] = json!(K);
            }),
        ),
        (
            "a run that read another math tick",
            edit("writer-succeeded", |v| {
                v["math_snapshot"]["math_tick"] = json!(4241)
            }),
        ),
        (
            "a run that read another math label",
            edit("writer-succeeded", |v| {
                v["math_snapshot"]["math_env"] = json!("python")
            }),
        ),
        (
            "an unticked math snapshot",
            edit("writer-succeeded", |v| {
                v["math_snapshot"]["math_tick"] = json!(-1)
            }),
        ),
        (
            "an unknown math snapshot key",
            edit("writer-succeeded", |v| {
                v["math_snapshot"]["modified"] = json!(1)
            }),
        ),
    ];
    assert_eq!(cases.len(), 73);
    for (name, value) in &cases {
        assert!(decode(value).is_err(), "accepted {name}");
    }
}
