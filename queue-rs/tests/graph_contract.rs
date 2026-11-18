//! Cross-language contract in its own test process, separate from daemon unit tests.
#![allow(clippy::unwrap_used)]
use polis_queue_adapter::job_graph_contract::registry;
use serde_json::Value;

#[test]
fn python_renders_the_same_registry_for_this_build() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap();
    let scripts = root.join("delphi/scripts");
    let references = root.join("delphi/tests/job_graph");
    let extension = if cfg!(feature = "graph-test-models") {
        format!("sys.path.insert(0,{:?});", references.to_str().unwrap())
    } else {
        String::new()
    };
    let program = format!(
        "import sys,json; sys.path.insert(0,{:?}); {extension} import graph_registry as r; print(json.dumps(r.DEFINITIONS))",
        scripts.to_str().unwrap()
    );
    let python = std::env::var("POLIS_JOBS_TEST_PYTHON").unwrap_or_else(|_| "python3".into());
    let out = std::process::Command::new(python)
        .args(["-I", "-c", &program])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let value: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(value, serde_json::to_value(registry().unwrap()).unwrap());
}
