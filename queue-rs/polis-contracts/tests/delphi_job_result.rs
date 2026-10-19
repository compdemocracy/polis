//! delphi-job-result/1: the Rust port against the Node contract.
//!
//! - The Rust-rendered schema is the committed server file and both client
//!   copies, byte for byte.
//! - Every fixture recorded from the Node contract's own fixtures
//!   (tests/fixtures/delphi-job-result, written by record.cjs with Node's
//!   JSON.stringify) decodes, and encodes back to the same bytes, pretty and
//!   compact.
//! - Every value the Node contract test rejects is refused by the Rust type
//!   and by the schema; the few values Rust refuses that the schema accepts
//!   are listed here, and in the README, by name.
mod support;

use polis_contracts::delphi_job_result::{
    schema_json, schema_json_alpha, schema_value, DelphiFamily, DelphiJobResult, FailureCode,
    NarrativeInvalidReason, Ready,
};
use polis_contracts::wire::{to_json, to_json_pretty, Json};
use serde_json::{json, Value};
use support::{fixtures, minify, read, violations};

const JOB: &str = "0000a001-0000-4000-8000-000000000001";

fn decode(text: &str) -> Result<DelphiJobResult, String> {
    let by_status = DelphiJobResult::from_json(text).map_err(|e| e.to_string());
    let untagged = serde_json::from_str::<DelphiJobResult>(text).map_err(|e| e.to_string());
    assert_eq!(
        by_status.is_ok(),
        untagged.is_ok(),
        "the two decoders agree"
    );
    if let (Ok(a), Ok(b)) = (&by_status, &untagged) {
        assert_eq!(a, b);
    }
    by_status
}

fn schema_errors(text: &str) -> Vec<String> {
    let value: Json = serde_json::from_str(text).unwrap();
    violations(&schema_value(), &value)
}

fn fixture(name: &str) -> Value {
    let text = read(&format!(
        "queue-rs/polis-contracts/tests/fixtures/delphi-job-result/{name}.json"
    ));
    serde_json::from_str(&text).unwrap()
}

#[test]
fn the_schema_is_the_committed_server_file_byte_for_byte() {
    assert_eq!(
        schema_json(),
        read("server/src/contracts/delphiJobResult.schema.json")
    );
}

#[test]
fn the_schema_is_the_client_report_copy_byte_for_byte() {
    assert_eq!(
        schema_json(),
        read("client-report/src/contract/delphiJobResult.schema.json")
    );
}

#[test]
fn the_schema_is_the_participation_alpha_copy_byte_for_byte() {
    assert_eq!(
        schema_json_alpha().as_deref(),
        Some(
            read("client-participation-alpha/src/api/contract/delphiJobResult.schema.json")
                .as_str()
        )
    );
}

#[test]
fn the_recorded_fixture_set_is_complete() {
    let names: Vec<String> = fixtures("delphi-job-result")
        .into_iter()
        .map(|(n, _)| n)
        .collect();
    let mut expected: Vec<String> = [
        "ready",
        "pending",
        "running",
        "failed",
        "empty",
        "two-models-beta",
        "rerun-after-votes",
        "truncated-narrative",
        "zero-vote",
        "wire-edges",
    ]
    .iter()
    .map(|s| (*s).to_owned())
    .chain(
        DelphiFamily::ALL
            .iter()
            .map(|f| format!("only-{}", f.as_str().replace('_', "-"))),
    )
    .collect();
    expected.sort();
    assert_eq!(names, expected);
}

#[test]
fn every_recorded_node_fixture_round_trips_byte_for_byte() {
    let all = fixtures("delphi-job-result");
    assert!(!all.is_empty());
    for (name, text) in all {
        assert_eq!(schema_errors(&text), Vec::<String>::new(), "{name}");
        let value = decode(&text).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(
            format!("{}\n", to_json_pretty(&value).unwrap()),
            text,
            "{name}"
        );
        assert_eq!(to_json(&value).unwrap(), minify(&text), "{name}");
        let again = decode(&to_json(&value).unwrap()).unwrap();
        assert_eq!(again, value, "{name}");
        let status = fixture(&name)["status"].as_str().unwrap().to_owned();
        assert_eq!(value.status(), status, "{name}");
    }
}

#[test]
fn every_family_served_alone_omits_exactly_the_others() {
    for family in DelphiFamily::ALL {
        let name = format!("only-{}", family.as_str().replace('_', "-"));
        let text = read(&format!(
            "queue-rs/polis-contracts/tests/fixtures/delphi-job-result/{name}.json"
        ));
        let DelphiJobResult::Ready(ready) = decode(&text).unwrap() else {
            panic!("{name} is ready");
        };
        let ready: &Ready = &ready;
        let present: Vec<DelphiFamily> = DelphiFamily::ALL
            .into_iter()
            .filter(|f| ready.outputs.has(*f))
            .collect();
        assert_eq!(present, vec![family]);
        assert_eq!(ready.outputs.omitted().len(), DelphiFamily::ALL.len() - 1);
    }
}

/// Refused by the Rust type and by the schema.
fn refused(name: &str, value: &Value) {
    let text = serde_json::to_string(value).unwrap();
    assert!(decode(&text).is_err(), "Rust accepts {name}");
    assert!(
        !schema_errors(&text).is_empty(),
        "the schema accepts {name}"
    );
}

#[test]
fn the_node_contract_rejections_are_refused() {
    // delphiJobResultContract.test.ts "rejects …", case for case.
    let ready = || fixture("ready");
    let pending = || fixture("pending");
    let running = || fixture("running");
    let failed = || fixture("failed");
    let empty = || fixture("empty");
    let all_but_first: Vec<&str> = DelphiFamily::ALL[1..].iter().map(|f| f.as_str()).collect();
    let section = format!("{JOB}_0_0");
    let edit = |mut v: Value, f: &dyn Fn(&mut Value)| {
        f(&mut v);
        v
    };
    let cases: Vec<(&str, Value)> = vec![
        (
            "another contract version",
            edit(ready(), &|v| {
                v["contract_version"] = json!("delphi-job-result/2")
            }),
        ),
        (
            "status error inside a body",
            edit(ready(), &|v| v["status"] = json!("error")),
        ),
        (
            "an unknown envelope key",
            edit(ready(), &|v| v["runs"] = json!({})),
        ),
        (
            "as_of without a time zone",
            edit(ready(), &|v| {
                v["as_of"] = json!("2023-11-14T19:20:01.000000")
            }),
        ),
        (
            "a ready envelope with an attempt",
            edit(ready(), &|v| v["attempt"] = json!(1)),
        ),
        (
            "an unknown family in outputs",
            edit(ready(), &|v| v["outputs"] = json!({"report_data": "{}"})),
        ),
        (
            "a family listed twice in omitted",
            edit(ready(), &|v| v["omitted"] = json!(["umap", "umap"])),
        ),
        (
            "an unknown family in omitted",
            edit(ready(), &|v| v["omitted"] = json!(["available_tables"])),
        ),
        (
            "pending with outputs",
            edit(pending(), &|v| {
                v["outputs"] = json!({"umap": {"nodes": []}})
            }),
        ),
        (
            "pending missing a family in omitted",
            edit(pending(), &|v| v["omitted"] = json!(all_but_first)),
        ),
        (
            "running at attempt 0",
            edit(running(), &|v| v["attempt"] = json!(0)),
        ),
        (
            "running with a failure",
            edit(running(), &|v| {
                v["failure"] = fixture("failed")["failure"].clone()
            }),
        ),
        (
            "failed without a failure",
            edit(failed(), &|v| v["failure"] = Value::Null),
        ),
        (
            "failed with an open failure code",
            edit(failed(), &|v| v["failure"]["code"] = json!("error")),
        ),
        (
            "failed carrying log text",
            edit(failed(), &|v| {
                v["failure"]["message"] = json!("Traceback (most recent call last)")
            }),
        ),
        (
            "empty with a job id",
            edit(empty(), &|v| v["job_id"] = json!(JOB)),
        ),
        (
            "empty that is pinned",
            edit(empty(), &|v| v["pinned"] = json!(true)),
        ),
        (
            "a topic without member_tids",
            edit(ready(), &|v| {
                v["outputs"]["topics_by_layer"]["0"][0]
                    .as_object_mut()
                    .unwrap()
                    .remove("member_tids");
            }),
        ),
        (
            "a topic with a string cluster id",
            edit(ready(), &|v| {
                v["outputs"]["topics_by_layer"]["0"][0]["cluster_id"] = json!("0")
            }),
        ),
        (
            "a valid narrative without parsed",
            edit(ready(), &|v| {
                v["outputs"]["narratives"]["group_informed_consensus"]["parsed"] = Value::Null
            }),
        ),
        (
            "an invalid narrative with parsed text",
            edit(ready(), &|v| {
                v["outputs"]["narratives"][&section]["parsed"] = json!({"paragraphs": []})
            }),
        ),
        (
            "an invalid narrative with an open reason",
            edit(ready(), &|v| {
                v["outputs"]["narratives"][&section]["invalid_reason"] = json!("jsonrepair")
            }),
        ),
        (
            "a narrative serving its raw text",
            edit(ready(), &|v| {
                v["outputs"]["narratives"]["group_informed_consensus"]["report_data"] = json!("{}")
            }),
        ),
        (
            "a citation that is not a tid",
            edit(ready(), &|v| {
                v["outputs"]["narratives"]["group_informed_consensus"]["parsed"]["paragraphs"][0]
                    ["sentences"][0]["clauses"][0]["citations"] = json!(["0"]);
            }),
        ),
        (
            "a umap node carrying comment text",
            edit(ready(), &|v| {
                v["outputs"]["umap"]["nodes"][0]["comment_text"] = json!("participant text")
            }),
        ),
        (
            "a visualization without a layer",
            edit(ready(), &|v| {
                v["outputs"]["visualizations"][0]
                    .as_object_mut()
                    .unwrap()
                    .remove("layer_id");
            }),
        ),
        (
            "a statement without its inputs",
            edit(ready(), &|v| {
                v["outputs"]["collective_statements"][0]
                    .as_object_mut()
                    .unwrap()
                    .remove("inputs");
            }),
        ),
        (
            "topic stats without seen",
            edit(ready(), &|v| {
                v["outputs"]["topic_stats"][format!("{JOB}#0#0")]
                    .as_object_mut()
                    .unwrap()
                    .remove("seen");
            }),
        ),
        (
            "consensus inputs without repness",
            edit(ready(), &|v| {
                v["outputs"]["consensus_inputs"]
                    .as_object_mut()
                    .unwrap()
                    .remove("repness");
            }),
        ),
        (
            "inputs without prompt versions",
            edit(ready(), &|v| {
                v["inputs"]
                    .as_object_mut()
                    .unwrap()
                    .remove("prompt_version");
            }),
        ),
    ];
    assert_eq!(cases.len(), 30);
    for (name, value) in &cases {
        refused(name, value);
    }
}

#[test]
fn a_missing_required_key_is_refused_even_where_null_is_allowed() {
    for (state, key) in [
        ("ready", "run_id"),
        ("ready", "report_id"),
        ("ready", "label"),
        ("pending", "as_of"),
        ("pending", "inputs"),
        ("empty", "job_id"),
        ("failed", "attempt"),
    ] {
        let mut v = fixture(state);
        v.as_object_mut().unwrap().remove(key);
        refused(&format!("{state} without {key}"), &v);
    }
    let mut v = fixture("ready");
    v["inputs"]["model"]
        .as_object_mut()
        .unwrap()
        .remove("embedding");
    refused("models without embedding", &v);
    let mut v = fixture("only-umap");
    v["outputs"]["umap"]["nodes"][0]["weight"] = Value::Null;
    refused("an optional weight sent as null", &v);
}

/// Refused by the Rust type although the schema accepts it: each is a rule
/// the schema states in prose, or a value JavaScript cannot write back with
/// the same bytes. The README lists the same cases.
#[test]
fn rust_is_narrower_than_the_schema_only_where_documented() {
    let narrower = |name: &str, v: Value| {
        let text = serde_json::to_string(&v).unwrap();
        assert_eq!(
            schema_errors(&text),
            Vec::<String>::new(),
            "the schema refuses {name}"
        );
        assert!(decode(&text).is_err(), "Rust accepts {name}");
    };
    let mut v = fixture("ready");
    v["omitted"] = json!(["umap"]);
    narrower("omitted naming a family outputs carries", v);
    let mut v = fixture("only-umap");
    v["omitted"] = json!(["topics_by_layer"]);
    narrower("omitted missing families outputs does not carry", v);
    let mut v = fixture("ready");
    v["outputs"]["topic_stats"][format!("{JOB}#0#0")]["seen"] = json!(21);
    narrower("seen that is not agree + disagree + pass", v);
    let mut v = fixture("ready");
    v["outputs"]["assignments"]["0"]["0"] = json!(-2);
    narrower("a cluster below -1", v);
    let mut v = fixture("ready");
    v["outputs"]["topics_by_layer"]["0"][0]["cluster_id"] = json!(-2);
    narrower("a topic cluster below -1", v);
    let mut v = fixture("ready");
    let a = v["outputs"]["assignments"]["0"].clone();
    v["outputs"]["assignments"]["01"] = a;
    narrower("a tid key that is not a canonical decimal", v);
    let mut v = fixture("ready");
    v["outputs"]["consensus_inputs"]["group_votes"]["g1"] = json!({"votes": {}});
    narrower("a group id key that is not a number", v);
    let mut v = fixture("ready");
    v["outputs"]["keywords"][""] = json!([]);
    narrower("an empty topic_key key", v);
    let mut v = fixture("ready");
    v["outputs"]["narratives"]["group_informed_consensus"]["parsed"]["paragraphs"][0]["7"] =
        json!(true);
    narrower("an additional key that is an array index", v);

    // Duplicate keys: JSON.parse keeps the last; Rust refuses the text.
    let text = read("queue-rs/polis-contracts/tests/fixtures/delphi-job-result/ready.json")
        .replacen(
            "\"pinned\": true,",
            "\"pinned\": true,\n  \"pinned\": false,",
            1,
        );
    assert!(decode(&text).is_err(), "Rust accepts a duplicate key");
    let text = read("queue-rs/polis-contracts/tests/fixtures/delphi-job-result/ready.json")
        .replacen(
            "\"group_informed_consensus\": {",
            "\"group_informed_consensus\": {\"x\": 1},\n      \"group_informed_consensus\": {",
            1,
        );
    assert!(
        decode(&text).is_err(),
        "Rust accepts a duplicate record key"
    );
    // An unpaired surrogate: JSON.stringify can write one; a Rust string cannot hold it.
    let text = read("queue-rs/polis-contracts/tests/fixtures/delphi-job-result/ready.json")
        .replacen("Generated topic 0.1", "Generated topic \\ud800", 1);
    assert!(text.contains("\\ud800"));
    assert!(decode(&text).is_err(), "Rust accepts an unpaired surrogate");
}

fn consts(schema: &Value) -> Vec<String> {
    schema["anyOf"]
        .as_array()
        .unwrap()
        .iter()
        .map(|b| b["const"].as_str().unwrap().to_owned())
        .collect()
}

#[test]
fn every_enum_is_spelled_as_the_committed_schema_spells_it() {
    let schema: Value =
        serde_json::from_str(&read("server/src/contracts/delphiJobResult.schema.json")).unwrap();
    let ready = &schema["anyOf"][0]["properties"];
    let families = consts(&ready["omitted"]["items"]);
    let codes = consts(&schema["anyOf"][3]["properties"]["failure"]["properties"]["code"]);
    let reasons = consts(
        &ready["outputs"]["properties"]["narratives"]["patternProperties"]["^(.*)$"]["anyOf"][1]
            ["properties"]["invalid_reason"],
    );
    let statuses: Vec<String> = schema["anyOf"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| {
            s["properties"]["status"]["const"]
                .as_str()
                .unwrap()
                .to_owned()
        })
        .collect();

    fn round_trip<T>(all: &[T], spelling: impl Fn(&T) -> &'static str) -> Vec<String>
    where
        T: serde::Serialize + serde::de::DeserializeOwned + PartialEq + std::fmt::Debug,
    {
        all.iter()
            .map(|v| {
                let text = to_json(v).unwrap();
                assert_eq!(text, format!("\"{}\"", spelling(v)));
                assert_eq!(&serde_json::from_str::<T>(&text).unwrap(), v);
                spelling(v).to_owned()
            })
            .collect()
    }
    assert_eq!(round_trip(&DelphiFamily::ALL, |f| f.as_str()), families);
    assert_eq!(round_trip(&FailureCode::ALL, |c| c.as_str()), codes);
    assert_eq!(
        round_trip(&NarrativeInvalidReason::ALL, |r| r.as_str()),
        reasons
    );
    assert_eq!(statuses, ["ready", "pending", "running", "failed", "empty"]);
    for family in DelphiFamily::ALL {
        let mut sources = family.sources().to_vec();
        sources.dedup();
        assert_eq!(sources.len(), family.sources().len());
    }
}
