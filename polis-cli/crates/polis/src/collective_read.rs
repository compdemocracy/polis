//! A readable view of the report's stored collective statements.
use serde_json::Value;

pub fn text(value: &Value) -> String {
    let rows = value["statements"]
        .as_array()
        .expect("validated statement list");
    if rows.is_empty() {
        return "No stored collective statements.\n".into();
    }
    let mut out = String::new();
    for row in rows {
        let topic = ["topic_name", "topic_key", "zid_topic_jobid"]
            .iter()
            .find_map(|key| row[key].as_str().filter(|s| !s.trim().is_empty()))
            .unwrap_or("Untitled topic");
        out.push_str(&format!("{topic}\n\n"));
        let data = &row["statement_data"];
        if let Some(paragraphs) = data["paragraphs"].as_array() {
            if paragraphs.is_empty() {
                out.push_str("No stored statement text.\n\n");
            }
            for paragraph in paragraphs {
                let start = out.len();
                if let Some(title) = paragraph["title"].as_str() {
                    out.push_str(&format!("{title}\n"));
                }
                if let Some(sentences) = paragraph["sentences"].as_array() {
                    for sentence in sentences {
                        if let Some(clauses) = sentence["clauses"].as_array() {
                            let mut line = Vec::new();
                            for clause in clauses {
                                let mut text = clause["text"]
                                    .as_str()
                                    .map(str::to_owned)
                                    .unwrap_or_else(|| clause.to_string());
                                if let Some(citations) =
                                    clause["citations"].as_array().filter(|c| !c.is_empty())
                                {
                                    let ids: Vec<_> = citations
                                        .iter()
                                        .map(|id| {
                                            id.as_str()
                                                .map(str::to_owned)
                                                .unwrap_or_else(|| id.to_string())
                                        })
                                        .collect();
                                    text.push_str(&format!(" [{}]", ids.join(", ")));
                                }
                                line.push(text);
                            }
                            out.push_str(&format!("{}\n", line.join(" ")));
                        } else {
                            out.push_str(&format!("{sentence}\n"));
                        }
                    }
                }
                if out.len() == start {
                    out.push_str(&format!("{paragraph}\n"));
                }
                out.push('\n');
            }
        } else if data.is_null() {
            out.push_str("No stored statement text.\n\n");
        } else if let Some(text) = data.as_str() {
            out.push_str(&format!("{text}\n\n"));
        } else {
            out.push_str(&format!(
                "{}\n\n",
                serde_json::to_string_pretty(data).unwrap()
            ));
        }
    }
    out
}
