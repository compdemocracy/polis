//! Offline questions an analyst can answer with the existing command surface.
use serde_json::{json, Value};
fn guide() -> Value {
    serde_json::from_str(include_str!("../../../docs/questions.json"))
        .expect("validated questions guide")
}
pub fn text() -> String {
    let guide = guide();
    let mut out = format!(
        "Questions to ask about a Polis conversation\n\n{}\n",
        guide["intro"].as_str().unwrap()
    );
    for (i, row) in guide["questions"].as_array().unwrap().iter().enumerate() {
        out.push_str(&format!(
            "\n{}. {}\n",
            i + 1,
            row["question"].as_str().unwrap()
        ));
        for command in row["commands"].as_array().unwrap() {
            out.push_str(&format!("  {}\n", command.as_str().unwrap()));
        }
        out.push_str(&format!("{}\n", row["look_for"].as_str().unwrap()));
    }
    out
}
pub fn execute() -> Value {
    let mut guide = guide();
    guide["help"] = json!(text());
    guide
}
