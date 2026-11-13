//! The clustering a Delphi result belongs to, read as types: the label
//! inside a topic key or a narrative section's name, the families whose
//! batch names a producer and the families whose batch names only their
//! last writer, and, for the second kind, the clustering each row was
//! written over, read from the row itself.
//!
//! The run records are the recorded bytes of real local sequences: a full
//! pipeline run, a collective-statement save over its topics and a second
//! full pipeline run (`first`, `statement`, `second`); and, from a later
//! recording of the same sequence carried one step further, a second
//! collective-statement save after the second run (`statement-after-second`),
//! with the stored rows of the bundle that save published.
mod support;

use polis_contracts::delphi_job_result::{
    Cluster, DelphiJobResult, LayerId, PublicJobId, SectionKey, TopicKey,
};
use polis_contracts::delphi_provenance::{
    ClusteringLabel, FamilyRows, GlobalSection, InputFromAnotherRun, PublishedLabels,
    RowClustering, RowLabel, RowStanding, SectionReading, TopicKeyParts, UnlabelledTopic,
    WrittenBy,
};
use polis_contracts::delphi_run::{
    DelphiRun, FamilyBatch, FamilyState, JobId, LegacyFamily, ResultFamily, RunFamily,
};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use support::read;

const FIXTURES: &str = "queue-rs/polis-api/conformance/delphi-run-fixtures";

fn key(text: &str) -> TopicKey {
    TopicKey::new(text).unwrap()
}

fn section(text: &str) -> SectionKey {
    SectionKey::new(text).unwrap()
}

fn label(text: &str) -> ClusteringLabel {
    ClusteringLabel::new(text).unwrap()
}

fn recorded(name: &str) -> DelphiRun {
    serde_json::from_str(&read(&format!("{FIXTURES}/{name}.json"))).unwrap()
}

/// Every string of up to `longest` characters over `alphabet`.
fn every_short_string(alphabet: &[char], longest: usize) -> Vec<String> {
    let mut all = vec![String::new()];
    let mut last = all.clone();
    for _ in 0..longest {
        let mut longer = Vec::new();
        for text in &last {
            for c in alphabet {
                longer.push(format!("{text}{c}"));
            }
        }
        all.extend(longer.iter().cloned());
        last = longer;
    }
    all
}

#[test]
fn a_topic_key_carries_a_clustering_label_a_layer_and_a_cluster() {
    let k = key("0000a001-0000-4000-8000-000000000001#0#1");
    assert_eq!(
        k.clustering_label().unwrap().as_str(),
        "0000a001-0000-4000-8000-000000000001"
    );
    let parts = k.parts().unwrap();
    assert_eq!(
        parts,
        TopicKeyParts {
            label: label("0000a001-0000-4000-8000-000000000001"),
            layer: LayerId::new(0),
            cluster: Cluster::Id(1),
        }
    );
    // The key is exactly its parts: writing them gives the key back.
    assert_eq!(parts.to_string(), k.as_str());
    // A label that is no uuid (the pipeline run by hand, a run given no job
    // id, a legacy alias) is still the key's label.
    for text in [
        "pipeline_run_0000a001-0000-4000-8000-000000000001",
        "unknown_job",
        "run-1",
    ] {
        let parts = key(&format!("{text}#2#0")).parts().unwrap();
        assert_eq!(parts.label.as_str(), text);
        assert_eq!(parts.layer, LayerId::new(2));
        assert_eq!(parts.cluster, Cluster::Id(0));
    }
    // -1 is the unassigned cluster, as everywhere in the contract.
    let parts = key("job#0#-1").parts().unwrap();
    assert_eq!(parts.cluster, Cluster::Unassigned);
    assert_eq!(parts.to_string(), "job#0#-1");
    // As what a row's key says of its clustering, the key names its label.
    assert_eq!(
        key("job#0#-1").clustering(),
        RowClustering::Label(label("job"))
    );
}

#[test]
fn a_key_in_another_shape_is_never_given_invented_parts() {
    // No separator: no label.
    assert_eq!(key("layer0_5").clustering_label(), None);
    assert_eq!(key("layer0_5").parts(), None);
    // An empty label is no label, and the key is in no form read here.
    assert_eq!(key("#0#1").clustering_label(), None);
    assert_eq!(key("#0#1").parts(), None);
    assert_eq!(key("#0#1").unlabelled(), None);
    assert_eq!(key("#0#1").clustering(), RowClustering::Unread);
    // The label is the text before the first separator, whatever follows;
    // the parts are given only for exactly label, layer and cluster, each
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
        assert_eq!(
            key(text).clustering_label().unwrap().as_str(),
            "job",
            "{text}"
        );
        assert_eq!(key(text).parts(), None, "{text}");
        assert_eq!(key(text).unlabelled(), None, "{text}");
        assert_eq!(
            key(text).clustering(),
            RowClustering::Label(label("job")),
            "{text}"
        );
    }
}

/// `layer<L>_<C>` is the key the pipeline's models write when they are
/// given no key. It names a topic by layer and cluster and names no
/// clustering: none is invented for it, and it is told apart from a key in
/// no known form.
#[test]
fn a_key_written_without_a_label_names_a_topic_and_no_clustering() {
    for (text, layer, cluster) in [
        ("layer0_5", 0, Cluster::Id(5)),
        ("layer2_0", 2, Cluster::Id(0)),
        ("layer10_123", 10, Cluster::Id(123)),
        ("layer0_-1", 0, Cluster::Unassigned),
    ] {
        let k = key(text);
        let topic = UnlabelledTopic {
            layer: LayerId::new(layer),
            cluster,
        };
        assert_eq!(k.unlabelled(), Some(topic), "{text}");
        assert_eq!(topic.to_string(), text);
        assert_eq!(k.clustering_label(), None, "{text}");
        assert_eq!(k.parts(), None, "{text}");
        assert_eq!(k.clustering(), RowClustering::NoLabel, "{text}");
    }
    // Any other spelling is not that form, and nothing is read from it.
    for text in [
        "layer0",
        "layer_5",
        "layer0_",
        "layer00_5",
        "layer0_05",
        "layer0_-2",
        "layer0_+5",
        "layer0_5_1",
        "layer0_5 ",
        "Layer0_5",
        "xlayer0_5",
        "layer-1_5",
        "layer4294967296_0",
        "0_5",
        "topic",
    ] {
        assert_eq!(key(text).unlabelled(), None, "{text}");
        assert_eq!(key(text).clustering(), RowClustering::Unread, "{text}");
    }
    // With a separator the text before it is a label, whatever it looks like.
    assert_eq!(
        key("layer0_5#0#1").clustering(),
        RowClustering::Label(label("layer0_5"))
    );
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

/// A narrative topic section is named with its topic key, each separator
/// written as an underscore. Labels the pipeline writes hold underscores
/// themselves, so the layer and the cluster are the last two parts and the
/// label is everything before them.
#[test]
fn a_narrative_topic_section_is_read_from_the_right() {
    for (name, text, layer, cluster) in [
        (
            "0000a001-0000-4000-8000-000000000001_0_3",
            "0000a001-0000-4000-8000-000000000001",
            0,
            Cluster::Id(3),
        ),
        (
            "pipeline_run_0000a001-0000-4000-8000-000000000001_1_12",
            "pipeline_run_0000a001-0000-4000-8000-000000000001",
            1,
            Cluster::Id(12),
        ),
        ("unknown_job_0_0", "unknown_job", 0, Cluster::Id(0)),
        ("unknown_job_2_-1", "unknown_job", 2, Cluster::Unassigned),
        // A label that ends in a number keeps it.
        ("run_1_2_0", "run_1", 2, Cluster::Id(0)),
        // A label that looks like the form without a label is still a label.
        ("layer0_5_1", "layer0", 5, Cluster::Id(1)),
    ] {
        let parts = TopicKeyParts {
            label: label(text),
            layer: LayerId::new(layer),
            cluster,
        };
        assert_eq!(
            section(name).reading(),
            SectionReading::Topic(parts.clone()),
            "{name}"
        );
        // As a row's clustering the label is the section's, except the one
        // text that is no clustering's label (see the test of `unknown_job`).
        let clustering = if text == "unknown_job" {
            RowClustering::NoLabel
        } else {
            RowClustering::Label(label(text))
        };
        assert_eq!(section(name).clustering(), clustering, "{name}");
        // The parts write the topic key the section was named with, and
        // that key's own parts are the same.
        assert_eq!(key(&parts.to_string()).parts(), Some(parts), "{name}");
    }
    // Reading from the left would give another label, layer and cluster.
    let from_the_left = "unknown_job_0_0".split('_').collect::<Vec<_>>();
    assert_eq!(from_the_left[0], "unknown");
    assert_ne!(from_the_left[1], "0");
}

/// `unknown_job` is what the pipeline writes in place of a job id it was not
/// given (a run started with an empty `DELPHI_JOB_ID`). Every such run writes
/// the same text, so two clusterings can carry it: it is the first part of
/// the key and it is no one clustering's label. Read as a row's clustering,
/// a key or a name that carries it names a topic and no clustering, and it
/// is never counted among the labels published topic names carry.
#[test]
fn the_text_written_for_a_run_given_no_job_id_is_no_one_clusterings_label() {
    let k = key("unknown_job#0#3");
    // The key's first part is still that text: nothing printed from it changes.
    let first_part = k.clustering_label().unwrap();
    assert_eq!(first_part.as_str(), "unknown_job");
    assert_eq!(k.parts().unwrap().label, first_part);
    assert!(!first_part.names_one_clustering());
    for text in ["unknown_job_2", "Unknown_job", "unknown", "job", "run-1"] {
        assert!(label(text).names_one_clustering(), "{text}");
    }
    // As a row's own key or name: a topic, and no clustering.
    assert_eq!(k.clustering(), RowClustering::NoLabel);
    assert_eq!(key("unknown_job#x").clustering(), RowClustering::NoLabel);
    assert_eq!(
        section("unknown_job_0_3").clustering(),
        RowClustering::NoLabel
    );
    // The section's parts are still read, and write the key back.
    let SectionReading::Topic(parts) = section("unknown_job_0_3").reading() else {
        panic!()
    };
    assert_eq!(parts.to_string(), k.as_str());

    // Two runs given no job id, one after the other. The second one's topic
    // names are published; a collective statement written over cluster 3 of
    // the first is still stored. Its key is the key of a published topic,
    // character for character, and the row is not reported as written over
    // the published clustering.
    let names = [
        key("unknown_job#0#0"),
        key("unknown_job#0#3"),
        key("unknown_job#1#0"),
    ];
    let published = PublishedLabels::of(&names);
    assert_eq!(published.labels().count(), 0);
    assert_eq!((published.unlabelled(), published.unread()), (3, 0));
    assert_eq!(published.standing(&k.clustering()), RowStanding::NoLabel);
    // Beside a labelled run's names it changes nothing about them.
    let names = [key("run-a#0#0"), key("unknown_job#0#3")];
    let mixed = PublishedLabels::of(&names);
    assert_eq!(mixed.labels().collect::<Vec<_>>(), [&label("run-a")]);
    assert_eq!((mixed.unlabelled(), mixed.unread()), (1, 0));
    assert_eq!(
        mixed.standing(&key("run-a#0#0").clustering()),
        RowStanding::PublishedClustering
    );
    assert_eq!(mixed.standing(&k.clustering()), RowStanding::NoLabel);
    // And a row clustering built by hand with that text matches nothing.
    assert_eq!(
        published.standing(&RowClustering::Label(first_part.clone())),
        RowStanding::AnotherClustering
    );
    assert_eq!(
        mixed.standing(&RowClustering::Label(first_part)),
        RowStanding::AnotherClustering
    );
}

/// The section name a provider batch stores: the batch writer builds a
/// request id `<conversation id>_<section name>`, writes every character
/// outside `A-Z a-z 0-9 _ -` as `_`, cuts the id at 64 characters, and the
/// result reader takes what follows the first `_`.
fn name_stored_by_a_provider_batch(conversation_id: &str, section_name: &str) -> String {
    let id: String = format!("{conversation_id}_{section_name}")
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .take(64)
        .collect();
    id.split_once('_').unwrap().1.to_owned()
}

/// For the labels the pipeline itself writes, the name a provider batch
/// stores never reads as another label. A job id (a uuid) is not altered,
/// and is not cut while the conversation id, the layer and the cluster have
/// 25 digits or fewer together: here, any conversation id and any cluster a
/// 32-bit number spells, with a layer of up to five digits.
/// `pipeline_run_<uuid>` is cut only when the three together have thirteen
/// digits or more, and what is left reads as the same label (with a shorter
/// cluster) or as nothing.
#[test]
fn a_provider_batch_never_turns_a_label_the_pipeline_writes_into_another_label() {
    let job = "0000a001-0000-4000-8000-000000000001";
    let by_hand = format!("pipeline_run_{job}");
    let (mut names, mut cut, mut cut_and_read) = (0, 0, 0);
    for text in [job, by_hand.as_str()] {
        for conversation_id in ["1", "1424", "9999999", "2147483647"] {
            for layer in ["0", "3", "12", "99999"] {
                for cluster in ["0", "7", "42", "999", "12345", "4294967295", "-1"] {
                    let written = format!("{text}_{layer}_{cluster}");
                    let stored = name_stored_by_a_provider_batch(conversation_id, &written);
                    names += 1;
                    if stored == written {
                        let SectionReading::Topic(parts) = section(&stored).reading() else {
                            panic!("{stored}")
                        };
                        assert_eq!(
                            parts.to_string(),
                            format!("{text}#{layer}#{cluster}"),
                            "{stored}"
                        );
                        continue;
                    }
                    // Cut: never a job id's name.
                    assert_eq!(text, by_hand, "{conversation_id} {written}");
                    assert!(conversation_id.len() + layer.len() + cluster.len() >= 13);
                    cut += 1;
                    match section(&stored).reading() {
                        SectionReading::Topic(parts) => {
                            assert_eq!(parts.label.as_str(), text, "{stored}");
                            cut_and_read += 1;
                        }
                        SectionReading::Unread => {}
                        other => panic!("{stored}: {other:?}"),
                    }
                }
            }
        }
    }
    assert_eq!(names, 2 * 4 * 4 * 7);
    assert!(cut > 0 && cut_and_read > 0, "{cut} {cut_and_read}");
}

/// The same is not true of every text a label could be. A label that is
/// another label followed by `_<digits>`, in a name long enough to be cut
/// after its layer, is stored as a name that reads as the shorter label; and
/// two labels that differ only in a character the batch rewrites are stored
/// as one. So a section's label is the label of the name as stored: for
/// labels of other shapes than the pipeline's it is not proof of the
/// clustering the section was written over.
#[test]
fn a_provider_batch_can_turn_a_label_of_another_shape_into_another_label() {
    let shorter = "x".repeat(55);
    let longer = format!("{shorter}_7");
    let stored = name_stored_by_a_provider_batch("1424", &format!("{longer}_0_12"));
    assert_eq!(stored, format!("{shorter}_7_0"));
    assert_eq!(
        section(&stored).reading(),
        SectionReading::Topic(TopicKeyParts {
            label: label(&shorter),
            layer: LayerId::new(7),
            cluster: Cluster::Id(0),
        })
    );
    assert_eq!(
        name_stored_by_a_provider_batch("1424", "run.a_0_1"),
        name_stored_by_a_provider_batch("1424", "run_a_0_1")
    );
}

#[test]
fn a_section_name_in_another_form_is_never_given_an_invented_label() {
    // A global section names no topic, and so no clustering: bare, as the
    // legacy name, and behind the narrative job's id or its first eight
    // characters.
    for (name, global) in [
        ("groups", GlobalSection::Groups),
        (
            "group_informed_consensus",
            GlobalSection::GroupInformedConsensus,
        ),
        ("uncertainty", GlobalSection::Uncertainty),
        ("global_groups", GlobalSection::Groups),
        ("0000b002_global_groups", GlobalSection::Groups),
        ("batch_re_global_uncertainty", GlobalSection::Uncertainty),
        (
            "0000b002-0000-4000-8000-000000000002_global_group_informed_consensus",
            GlobalSection::GroupInformedConsensus,
        ),
    ] {
        assert_eq!(
            section(name).reading(),
            SectionReading::Global(global),
            "{name}"
        );
        assert_eq!(section(name).clustering(), RowClustering::NoTopic, "{name}");
    }
    // The form without a label names a topic and no clustering.
    assert_eq!(
        section("layer0_5").reading(),
        SectionReading::UnlabelledTopic(UnlabelledTopic {
            layer: LayerId::new(0),
            cluster: Cluster::Id(5)
        })
    );
    assert_eq!(section("layer0_5").clustering(), RowClustering::NoLabel);
    // Anything else is read as nothing.
    for name in [
        "",
        "7",
        "summary",
        "job",
        "job_0",
        "_0_1",
        "job_00_1",
        "job_0_01",
        "job_0_-2",
        "job_0_1_",
        "job_x_1",
        "job_0_x",
        "job_4294967296_0",
        "job#0#1",
        "_global_groups",
        "global_",
        "job_global_other",
        "groups_extra",
        "topic_housing_costs",
        "unknown_section",
    ] {
        assert_eq!(section(name).reading(), SectionReading::Unread, "{name:?}");
        assert_eq!(
            section(name).clustering(),
            RowClustering::Unread,
            "{name:?}"
        );
    }
}

/// For every short label over an alphabet that holds the section's own
/// separator, two digits, a letter, the key's separator and a sign, and for
/// three topics: the section name written for a topic reads back as that
/// topic. And every short name that reads as a topic is the name its parts
/// write, so nothing else is read as a topic.
#[test]
fn reading_a_topic_section_inverts_writing_it_for_every_short_label() {
    let alphabet = ['_', '0', '1', 'a', '#', '-'];
    let mut written = 0;
    for text in every_short_string(&alphabet, 4) {
        let Ok(label) = ClusteringLabel::new(text.as_str()) else {
            assert_eq!(text, "");
            continue;
        };
        for (layer, cluster, spelled) in [
            (0, Cluster::Id(0), "0"),
            (1, Cluster::Id(10), "10"),
            (10, Cluster::Unassigned, "-1"),
        ] {
            let parts = TopicKeyParts {
                label: label.clone(),
                layer: LayerId::new(layer),
                cluster,
            };
            let name = format!("{text}_{layer}_{spelled}");
            assert_eq!(
                section(&name).reading(),
                SectionReading::Topic(parts),
                "{name}"
            );
            written += 1;
        }
    }
    // 6^1 + 6^2 + 6^3 + 6^4 labels, three topics each.
    assert_eq!(written, 1554 * 3);
    let (mut names, mut topics) = (0, 0);
    for name in every_short_string(&alphabet, 6) {
        names += 1;
        match section(&name).reading() {
            SectionReading::Topic(parts) => {
                let spelled = match parts.cluster {
                    Cluster::Unassigned => "-1".to_owned(),
                    Cluster::Id(n) => n.to_string(),
                };
                assert_eq!(
                    format!("{}_{}_{spelled}", parts.label, parts.layer.get()),
                    name
                );
                topics += 1;
            }
            SectionReading::UnlabelledTopic(_) | SectionReading::Global(_) => {
                panic!("{name}: the alphabet cannot spell these forms")
            }
            SectionReading::Unread => {}
        }
    }
    // 6^0 + 6^1 + ... + 6^6
    assert_eq!(names, 55_987);
    assert!(topics > 0 && topics < names);
}

/// The published topic names carry one label when one run clustered and
/// named them. Stored data can also hold none (every key in the form
/// without a label) or several (a store that kept more than one run's
/// names). Neither is read as one clustering.
#[test]
fn several_published_labels_or_none_are_never_read_as_one_clustering() {
    let rows = [
        RowClustering::Label(label("run-a")),
        RowClustering::Label(label("run-b")),
        RowClustering::Label(label("run-c")),
        RowClustering::NoLabel,
        RowClustering::NoTopic,
        RowClustering::Unread,
    ];
    let standings = |published: &PublishedLabels| -> Vec<RowStanding> {
        rows.iter().map(|row| published.standing(row)).collect()
    };

    // One label.
    let keys = [key("run-a#0#0"), key("run-a#0#1"), key("run-a#1#0")];
    let one = PublishedLabels::of(&keys);
    assert_eq!(one.labels().collect::<Vec<_>>(), [&label("run-a")]);
    assert_eq!((one.unlabelled(), one.unread()), (0, 0));
    assert_eq!(
        standings(&one),
        [
            RowStanding::PublishedClustering,
            RowStanding::AnotherClustering,
            RowStanding::AnotherClustering,
            RowStanding::NoLabel,
            RowStanding::NoTopic,
            RowStanding::Unread,
        ]
    );

    // Several labels: a row over one of them is told apart from a row over
    // the one published clustering. Which of them a page draws is not
    // decided here.
    let keys = [key("run-b#0#0"), key("run-a#0#0"), key("run-b#0#1")];
    let several = PublishedLabels::of(&keys);
    assert_eq!(
        several.labels().collect::<Vec<_>>(),
        [&label("run-a"), &label("run-b")]
    );
    assert_eq!(
        standings(&several),
        [
            RowStanding::OneOfSeveralPublished,
            RowStanding::OneOfSeveralPublished,
            RowStanding::AnotherClustering,
            RowStanding::NoLabel,
            RowStanding::NoTopic,
            RowStanding::Unread,
        ]
    );

    // No label: keys in the form without one, a key in no form, or no keys.
    let keys = [key("layer0_0"), key("layer0_1"), key("#0#1")];
    let none = PublishedLabels::of(&keys);
    assert_eq!(none.labels().count(), 0);
    assert_eq!((none.unlabelled(), none.unread()), (2, 1));
    let empty = PublishedLabels::of(&Vec::new());
    assert_eq!(empty, PublishedLabels::default());
    for published in [&none, &empty] {
        assert_eq!(
            standings(published),
            [
                RowStanding::AnotherClustering,
                RowStanding::AnotherClustering,
                RowStanding::AnotherClustering,
                RowStanding::NoLabel,
                RowStanding::NoTopic,
                RowStanding::Unread,
            ]
        );
    }

    // Keys with a label beside keys without: the labels are those the
    // labelled keys carry, and the others are counted, not guessed.
    let keys = [key("run-a#0#0"), key("layer0_1")];
    let mixed = PublishedLabels::of(&keys);
    assert_eq!(mixed.labels().collect::<Vec<_>>(), [&label("run-a")]);
    assert_eq!((mixed.unlabelled(), mixed.unread()), (1, 0));
}

#[test]
fn the_label_in_a_golden_result_is_the_clustering_label_not_the_job_asked_about() {
    // result name -> (the result's job, the label its topic keys carry)
    let mut seen = BTreeMap::new();
    let (mut keys, mut statements) = (0, 0);
    let (mut topic_sections, mut global_sections, mut unread_sections) = (0, 0, 0);
    for (name, text) in support::fixtures("delphi-job-result") {
        let Ok(DelphiJobResult::Ready(ready)) = DelphiJobResult::from_json(&text) else {
            continue;
        };
        let mut published = Vec::new();
        if let Some(layers) = &ready.outputs.topics_by_layer {
            for (layer, topics) in layers.iter() {
                for topic in topics {
                    let parts = topic.topic_key.parts().unwrap_or_else(|| panic!("{name}"));
                    assert_eq!(parts.layer, *layer, "{name}");
                    assert_eq!(parts.layer, topic.layer_id, "{name}");
                    assert_eq!(parts.cluster, topic.cluster_id, "{name}");
                    assert_eq!(
                        topic.topic_key.clustering_label(),
                        Some(parts.label.clone()),
                        "{name}"
                    );
                    seen.insert(name.clone(), (ready.job_id.clone(), parts.label));
                    published.push(topic.topic_key.clone());
                    keys += 1;
                }
            }
        }
        let published = PublishedLabels::of(&published);
        // Each narrative section, read from its name alone, against the
        // topics job the result itself records for the section.
        if let Some(narratives) = &ready.outputs.narratives {
            for (section_name, narrative) in narratives.iter() {
                match section_name.reading() {
                    SectionReading::Topic(parts) => {
                        assert_eq!(
                            Some(parts.label.as_str()),
                            narrative.source_topic_job_id.as_ref().map(|j| j.as_str()),
                            "{name}"
                        );
                        topic_sections += 1;
                    }
                    SectionReading::Global(_) => global_sections += 1,
                    SectionReading::UnlabelledTopic(_) => panic!("{name}"),
                    SectionReading::Unread => unread_sections += 1,
                }
            }
        }
        // Each collective statement, read from its own topic key, against
        // the topics job the result records for the statement.
        if let Some(rows) = &ready.outputs.collective_statements {
            for row in rows {
                let clustering = row.topic_key.clustering();
                let RowClustering::Label(label) = &clustering else {
                    panic!("{name}")
                };
                assert_eq!(label.as_str(), row.inputs.topic_job_id.as_str(), "{name}");
                if ready.outputs.topics_by_layer.is_some() {
                    assert_eq!(
                        published.standing(&clustering),
                        RowStanding::PublishedClustering,
                        "{name}"
                    );
                }
                statements += 1;
            }
        }
    }
    assert_eq!(keys, 21, "the golden results' topics");
    assert_eq!(
        (topic_sections, global_sections, unread_sections),
        (8, 5, 2),
        "the golden results' narrative sections"
    );
    assert_eq!(statements, 7, "the golden results' collective statements");
    // A run whose keys carry its own job.
    let (asked, carried) = &seen["ready"];
    assert_eq!(asked.as_str(), carried.as_str());
    // A run after new votes that kept an earlier run's topics: the result is
    // the later job's, and every key still carries the earlier label.
    let (asked, carried) = &seen["rerun-after-votes"];
    assert_eq!(asked.as_str(), "0000a001-0000-4000-8000-000000000003");
    assert_eq!(carried.as_str(), "0000a001-0000-4000-8000-000000000001");
}

/// Three families are rewritten whole by every write, with every earlier
/// row copied forward: collective statements, narrative reports and the
/// server's report-narrative cache. A record names one job for each; for
/// these three it is the last writer, never the producer of the rows.
#[test]
fn the_families_rewritten_whole_by_each_write_name_a_last_writer_not_a_producer() {
    let accumulated: Vec<(ResultFamily, RowLabel)> = ResultFamily::all()
        .filter_map(|family| match family.rows() {
            FamilyRows::OneProducer => None,
            FamilyRows::Accumulated(label) => Some((family, label)),
        })
        .collect();
    assert_eq!(
        accumulated,
        [
            (
                ResultFamily::Run(RunFamily::NarrativeReports),
                RowLabel::SectionName
            ),
            (
                ResultFamily::Run(RunFamily::CollectiveStatement),
                RowLabel::TopicKey
            ),
            (
                ResultFamily::Legacy(LegacyFamily::ReportNarrativeStore),
                RowLabel::None
            ),
        ]
    );

    // The second full run's record: the run produced the topic names it
    // published, every row; the collective statements beside them were last
    // written by the statement save.
    let statement = recorded("statement");
    let second = recorded("second");
    let names = ResultFamily::Run(RunFamily::CommentClustersLlmTopicNames);
    let statements = ResultFamily::Run(RunFamily::CollectiveStatement);
    let Some(WrittenBy::Producer(run)) = second.written_by(names) else {
        panic!("{:?}", second.written_by(names))
    };
    assert_eq!(run.job_id, second.job_id);
    assert_eq!(run.run_id, second.run_id);
    let Some(WrittenBy::LastWriter(run)) = second.written_by(statements) else {
        panic!("{:?}", second.written_by(statements))
    };
    assert_eq!(run.job_id, statement.job_id);
    assert_eq!(run.run_id, statement.run_id);
    // A family the record does not list was written by nobody.
    assert_eq!(
        second.written_by(ResultFamily::Run(RunFamily::NarrativeReports)),
        None
    );
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
}

/// What the recorder wrote beside the fourth record: the job ids of the
/// sequence, and the stored rows of two families of the bundle the last
/// save published, as a reader of that bundle gets them.
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct RecordedRows {
    jobs: BTreeMap<String, String>,
    families: BTreeMap<String, Vec<serde_json::Value>>,
}

/// One stored value as the result codec writes it: keys in byte order, no
/// space, strings as JSON writes them.
fn codec_json(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let fields: Vec<String> = keys
                .into_iter()
                .map(|k| {
                    format!(
                        "{}:{}",
                        serde_json::to_string(k).unwrap(),
                        codec_json(&map[k])
                    )
                })
                .collect();
            format!("{{{}}}", fields.join(","))
        }
        serde_json::Value::Array(items) => {
            let items: Vec<String> = items.iter().map(codec_json).collect();
            format!("[{}]", items.join(","))
        }
        other => serde_json::to_string(other).unwrap(),
    }
}

/// The content digest of a family's rows: the codec's header line, then one
/// line per row in the order of the rows' keys.
fn content_sha256(family: &str, key: &[&str], rows: &[serde_json::Value]) -> String {
    let key_of = |row: &serde_json::Value| -> Vec<u8> {
        let parts = key.iter().map(|name| row[*name].clone()).collect();
        codec_json(&serde_json::Value::Array(parts)).into_bytes()
    };
    let mut rows: Vec<&serde_json::Value> = rows.iter().collect();
    rows.sort_by_key(|row| key_of(row));
    let mut wire = codec_json(&serde_json::json!({
        "codec": "delphi-storage-codec/1", "family": family, "key": key,
    }));
    wire.push('\n');
    for row in rows {
        wire.push_str(&codec_json(row));
        wire.push('\n');
    }
    Sha256::digest(wire.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// The sequence that a record of whole families cannot describe: a full
/// run, a collective statement saved over its topics, a second full run, a
/// collective statement saved over the second run's topics. The second save
/// rewrites the statement family whole, so the family it publishes holds
/// both statements and names one job.
#[test]
fn a_statement_saved_after_a_second_run_leaves_a_row_its_record_cannot_name() {
    const NAMES: &str = "Delphi_CommentClustersLLMTopicNames";
    const STATEMENTS: &str = "Delphi_CollectiveStatement";
    let golden = read(&format!("{FIXTURES}/statement-after-second.json"));
    let record: DelphiRun = serde_json::from_str(&golden).unwrap();
    let rows: RecordedRows = serde_json::from_str(&read(&format!(
        "{FIXTURES}/statement-after-second.rows.json"
    )))
    .unwrap();
    let job = |name: &str| rows.jobs[name].as_str();
    let (first, statement, second, last) = (
        job("first"),
        job("statement"),
        job("second"),
        job("statement-after-second"),
    );
    assert_eq!(rows.jobs.len(), 4);
    assert_eq!(record.job_id.as_str(), last);
    let names = ResultFamily::Run(RunFamily::CommentClustersLlmTopicNames);
    let statements = ResultFamily::Run(RunFamily::CollectiveStatement);
    let batch = |family: ResultFamily| -> FamilyBatch {
        match &record.outputs.families.get(family).unwrap().state {
            FamilyState::Succeeded { batch, .. } => batch.clone(),
            other => panic!("{}: {other:?}", family.as_str()),
        }
    };

    // --- What the record says. ---
    // The topic names it publishes were produced by the second full run.
    let Some(WrittenBy::Producer(run)) = record.written_by(names) else {
        panic!("{:?}", record.written_by(names))
    };
    assert_eq!(run.job_id.as_str(), second);
    // The collective statements were last written by this job: one job
    // named, two rows, computed from the second run's topic names.
    let Some(WrittenBy::LastWriter(run)) = record.written_by(statements) else {
        panic!("{:?}", record.written_by(statements))
    };
    assert_eq!(run.job_id.as_str(), last);
    assert_eq!(batch(statements).row_count, 2);
    let upstream = &record
        .outputs
        .families
        .get(statements)
        .and_then(|f| f.state.computation())
        .unwrap()
        .upstream;
    assert_eq!(upstream.len(), 1);
    assert_eq!(upstream[0].family, RunFamily::CommentClustersLlmTopicNames);
    assert_eq!(upstream[0].job_id.as_str(), second);
    // So, family by family, nothing in the bundle was computed from another
    // run than the one published beside it.
    assert_eq!(record.inputs_from_other_runs(), vec![]);
    // The first run and the first save are named nowhere in the record.
    assert!(golden.contains(second) && golden.contains(last));
    assert!(!golden.contains(first));
    assert!(!golden.contains(statement));

    // --- The recorded rows are the families the record names, by digest. ---
    let stored = |family: &str| rows.families[family].as_slice();
    assert_eq!(
        content_sha256(STATEMENTS, &["zid_topic_jobid"], stored(STATEMENTS)),
        batch(statements).content_sha256.as_str()
    );
    assert_eq!(
        content_sha256(NAMES, &["conversation_id", "topic_key"], stored(NAMES)),
        batch(names).content_sha256.as_str()
    );
    assert_eq!(stored(NAMES).len() as u64, batch(names).row_count);

    // --- What the record cannot say, read from each row's own key. ---
    let topic_key = |row: &serde_json::Value| key(row["topic_key"]["S"].as_str().unwrap());
    let published: Vec<TopicKey> = stored(NAMES).iter().map(topic_key).collect();
    let published = PublishedLabels::of(&published);
    // The published topic names carry one label: the second run's job.
    assert_eq!(published.labels().collect::<Vec<_>>(), [&label(second)]);
    assert_eq!((published.unlabelled(), published.unread()), (0, 0));
    assert_eq!(
        statements.rows(),
        FamilyRows::Accumulated(RowLabel::TopicKey)
    );
    let mut read_rows: Vec<(String, RowStanding)> = stored(STATEMENTS)
        .iter()
        .map(|row| {
            let clustering = topic_key(row).clustering();
            let RowClustering::Label(label) = &clustering else {
                panic!("{row}")
            };
            (label.to_string(), published.standing(&clustering))
        })
        .collect();
    read_rows.sort();
    let mut expected = vec![
        // The statement saved first: over the first run's topics, which the
        // bundle no longer holds.
        (first.to_owned(), RowStanding::AnotherClustering),
        // The statement saved last: over the topics published beside it.
        (second.to_owned(), RowStanding::PublishedClustering),
    ];
    expected.sort();
    assert_eq!(read_rows, expected);
    // Neither row's key names the job that saved it: the last part of a
    // statement's id is the statement's own id.
    for row in stored(STATEMENTS) {
        let id = row["zid_topic_jobid"]["S"].as_str().unwrap();
        assert!(!id.contains(statement) && !id.contains(last), "{id}");
    }
}
