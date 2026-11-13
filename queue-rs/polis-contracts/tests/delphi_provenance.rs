//! The run a Delphi result came from, read as types: the job inside a topic
//! key, the run record that job has (or does not have), and the families of
//! a published bundle that were computed from another run than the one
//! published beside them. The run records are the recorded bytes of a real
//! local sequence (a full pipeline run, a collective-statement save over its
//! topics, a second full pipeline run).
mod support;

use polis_contracts::delphi_job_result::{
    Cluster, DelphiJobResult, LayerId, PublicJobId, TopicKey,
};
use polis_contracts::delphi_provenance::{InputFromAnotherRun, TopicKeyParts};
use polis_contracts::delphi_run::{DelphiRun, JobId, ResultFamily, RunFamily};
use support::read;

fn key(text: &str) -> TopicKey {
    TopicKey::new(text).unwrap()
}

fn recorded(name: &str) -> DelphiRun {
    serde_json::from_str(&read(&format!(
        "queue-rs/polis-api/conformance/delphi-run-fixtures/{name}.json"
    )))
    .unwrap()
}

#[test]
fn a_topic_key_names_the_job_that_named_the_topic() {
    let k = key("0000a001-0000-4000-8000-000000000001#0#1");
    assert_eq!(
        k.producer().unwrap().as_str(),
        "0000a001-0000-4000-8000-000000000001"
    );
    let parts = k.parts().unwrap();
    assert_eq!(
        parts,
        TopicKeyParts {
            job: PublicJobId::new("0000a001-0000-4000-8000-000000000001").unwrap(),
            layer: LayerId::new(0),
            cluster: Cluster::Id(1),
        }
    );
    // The key is exactly its parts: writing them gives the key back.
    assert_eq!(parts.to_string(), k.as_str());
    // A job that is not a uuid (a legacy alias) is still the key's job.
    let parts = key("run-1#2#0").parts().unwrap();
    assert_eq!(parts.job.as_str(), "run-1");
    assert_eq!(parts.layer, LayerId::new(2));
    assert_eq!(parts.cluster, Cluster::Id(0));
    // -1 is the unassigned cluster, as everywhere in the contract.
    let parts = key("job#0#-1").parts().unwrap();
    assert_eq!(parts.cluster, Cluster::Unassigned);
    assert_eq!(parts.to_string(), "job#0#-1");
}

#[test]
fn a_key_in_another_shape_is_never_given_invented_parts() {
    // No separator: no job is named.
    assert_eq!(key("layer0_5").producer(), None);
    assert_eq!(key("layer0_5").parts(), None);
    // An empty job is no job.
    assert_eq!(key("#0#1").producer(), None);
    assert_eq!(key("#0#1").parts(), None);
    // The job is the text before the first separator, whatever follows;
    // the parts are given only for exactly job, layer and cluster, each
    // number in the one spelling the pipeline writes.
    for text in [
        "job#x",
        "job#0",
        "job#0#1#extra",
        "job#00#1",
        "job#0#01",
        "job#0#-2",
        "job#0#+1",
        "job#0#",
        "job##1",
        "job#0#1.0",
        "job#4294967296#0",
    ] {
        assert_eq!(key(text).producer().unwrap().as_str(), "job", "{text}");
        assert_eq!(key(text).parts(), None, "{text}");
    }
}

#[test]
fn only_a_uuid_job_has_a_run_record_to_ask_for() {
    let job = PublicJobId::new("404137c3-e1e5-4d7a-a13e-2c41ff2fcece").unwrap();
    assert_eq!(
        job.run_record_id(),
        Some(JobId::new("404137c3-e1e5-4d7a-a13e-2c41ff2fcece").unwrap())
    );
    // A legacy alias, and any spelling PostgreSQL would not write, name none.
    for text in [
        "run-1",
        "batch_report_r1_1700000000_ab12",
        "404137C3-E1E5-4D7A-A13E-2C41FF2FCECE",
        "404137c3e1e54d7aa13e2c41ff2fcece",
    ] {
        assert_eq!(
            PublicJobId::new(text).unwrap().run_record_id(),
            None,
            "{text}"
        );
    }
}

#[test]
fn the_job_in_a_topic_key_is_the_job_that_named_the_topic_not_the_job_asked_about() {
    // result name -> (the result's job, the job its topic keys name)
    let mut seen = std::collections::BTreeMap::new();
    let mut keys = 0;
    for (name, text) in support::fixtures("delphi-job-result") {
        let Ok(DelphiJobResult::Ready(ready)) = DelphiJobResult::from_json(&text) else {
            continue;
        };
        let Some(layers) = &ready.outputs.topics_by_layer else {
            continue;
        };
        for (layer, topics) in layers.iter() {
            for topic in topics {
                let parts = topic.topic_key.parts().unwrap_or_else(|| panic!("{name}"));
                assert_eq!(parts.layer, *layer, "{name}");
                assert_eq!(parts.layer, topic.layer_id, "{name}");
                assert_eq!(parts.cluster, topic.cluster_id, "{name}");
                assert_eq!(
                    topic.topic_key.producer(),
                    Some(parts.job.clone()),
                    "{name}"
                );
                seen.insert(name.clone(), (ready.job_id.clone(), parts.job));
                keys += 1;
            }
        }
    }
    assert_eq!(keys, 21, "the golden results' topics");
    // A run that named its own topics.
    let (asked, named_by) = &seen["ready"];
    assert_eq!(asked, named_by);
    // A run after new votes that kept an earlier run's topics: the result is
    // the later job's, and every key still names the job that named the topic.
    let (asked, named_by) = &seen["rerun-after-votes"];
    assert_eq!(asked.as_str(), "0000a001-0000-4000-8000-000000000003");
    assert_eq!(named_by.as_str(), "0000a001-0000-4000-8000-000000000001");
}

#[test]
fn a_run_record_says_which_families_were_computed_from_another_run() {
    // A first full run: everything it publishes it computed from itself.
    let first = recorded("first");
    assert_eq!(first.inputs_from_other_runs(), vec![]);
    // A collective statement saved over the first run's topics: the bundle
    // it published holds the first run's topic names, the ones it read.
    let statement = recorded("statement");
    assert_eq!(statement.inputs_from_other_runs(), vec![]);
    // A second full run publishes its own topic names. The collective
    // statement published beside them was written over the first run's.
    let second = recorded("second");
    let topics = ResultFamily::Run(RunFamily::CommentClustersLlmTopicNames);
    let named_by = second
        .outputs
        .families
        .get(topics)
        .and_then(|f| f.state.computation())
        .map(|c| c.producer.clone())
        .unwrap();
    assert_eq!(named_by.job_id, second.job_id);
    let mixed = second.inputs_from_other_runs();
    assert_eq!(mixed.len(), 1);
    let InputFromAnotherRun {
        family,
        upstream,
        computed_from,
        published,
    } = &mixed[0];
    assert_eq!(*family, ResultFamily::Run(RunFamily::CollectiveStatement));
    assert_eq!(*upstream, RunFamily::CommentClustersLlmTopicNames);
    assert_eq!(computed_from.job_id, first.job_id);
    assert_eq!(computed_from.run_id, first.run_id);
    assert_eq!(*published, named_by);
    // The same fact, from the key a client holds: a topic key of the second
    // run names the job whose run record this is.
    let k = key(&format!("{}#0#3", second.job_id.as_str()));
    assert_eq!(
        k.producer().and_then(|job| job.run_record_id()),
        Some(second.job_id.clone())
    );
}
