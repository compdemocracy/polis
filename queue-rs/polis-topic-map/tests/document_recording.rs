//! The document `polis-topic-map/1` written for each public fixture, recorded
//! as its length in bytes and its SHA-256. The recorded values are what the
//! prototype this crate was moved from wrote for the same inputs, so any change
//! to a position, a weight, a colour, a name, a parent or the order of the
//! fields fails here. The library and the command-line binary must write the
//! same bytes.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use polis_topic_map::{Proximity, Topics};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::Command;

struct Case {
    set: &'static str,
    title: &'static str,
    attribution: &'static str,
    bytes: usize,
    sha256: &'static str,
}

const CASES: [Case; 2] = [
    Case {
        set: "bg2050",
        title: "Imagine Bowling Green in 2050.",
        attribution: "compdemocracy/openData, bg2050-volunteers, CC BY 4.0",
        bytes: 266_350,
        sha256: "a60904ce4f93defd583b90924a95a50da28c56e3da940487f2b6ada6c9deb92d",
    },
    Case {
        set: "biodiversity",
        title: "Protecting and Restoring NZ’s Biodiversity",
        attribution: "compdemocracy/openData, scoop-hivemind.biodiversity, CC BY 4.0",
        bytes: 11_396,
        sha256: "c4d527ee9d7eb481f2648b2a6e49c0a5d683bba8da2b2a6dd12473b97d202b1a",
    },
];

fn fixture(set: &str, file: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(set)
        .join(file)
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

#[test]
fn the_library_writes_the_recorded_document() {
    for c in &CASES {
        let prox: Proximity = serde_json::from_str(
            &std::fs::read_to_string(fixture(c.set, "proximity.json")).unwrap(),
        )
        .unwrap();
        let topics: Topics =
            serde_json::from_str(&std::fs::read_to_string(fixture(c.set, "topics.json")).unwrap())
                .unwrap();
        let data =
            polis_topic_map::build(prox, topics, &BTreeMap::new(), c.title, c.attribution).unwrap();
        let doc = serde_json::to_string(&data).unwrap();
        assert_eq!(doc.len(), c.bytes, "{}: length of the document", c.set);
        assert_eq!(
            sha256_hex(doc.as_bytes()),
            c.sha256,
            "{}: SHA-256 of the document",
            c.set
        );
    }
}

#[test]
fn the_binary_writes_the_same_bytes() {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR"));
    for c in &CASES {
        let out = dir.join(format!("polis-topic-map-{}.json", c.set));
        let run = Command::new(env!("CARGO_BIN_EXE_polis-topic-map"))
            .arg("data")
            .arg("--proximity")
            .arg(fixture(c.set, "proximity.json"))
            .arg("--topics")
            .arg(fixture(c.set, "topics.json"))
            .args(["--title", c.title, "--attribution", c.attribution, "--out"])
            .arg(&out)
            .output()
            .unwrap();
        assert!(
            run.status.success(),
            "{}: {}",
            c.set,
            String::from_utf8_lossy(&run.stderr)
        );
        let doc = std::fs::read(&out).unwrap();
        assert_eq!(doc.len(), c.bytes, "{}: length of the file", c.set);
        assert_eq!(sha256_hex(&doc), c.sha256, "{}: SHA-256 of the file", c.set);
    }
}
