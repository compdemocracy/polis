//! CSV presentation of existing reads; no requests or identity enrichment.
use polis_contracts::{Error, Result};
use serde_json::Value;
use std::collections::BTreeSet;

pub fn available(path: &str) -> bool {
    crate::admin::csv_available(path)
        || matches!(
            path,
            "api"
                | "seed csv preview"
                | "site list"
                | "auth status"
                | "account view"
                | "plan view"
                | "conversation list"
                | "conversation view"
                | "conversation stats"
                | "conversation share"
                | "comment list"
                | "comment view"
                | "comment stats"
                | "comment next"
                | "comment translations"
                | "moderate list"
                | "participant list"
                | "participant status"
                | "participant xid list"
                | "participant locations"
                | "participant highlight list"
                | "participant group-members"
                | "vote list"
                | "report list"
                | "report view"
                | "report stats"
                | "report comments list"
                | "report topics"
                | "math view"
                | "metadata question list"
                | "metadata answer list"
                | "context list"
                | "invite code list"
                | "invite wave list"
                | "invite list"
                | "invite status"
                | "topic list"
                | "topic comments"
                | "topic hierarchy"
                | "topic proximity"
                | "topic prioritize"
                | "topic stats"
                | "collective list"
                | "collective view"
                | "collective statements"
                | "delphi status"
                | "delphi results"
                | "delphi narrative view"
                | "delphi visualization view"
                | "delphi show"
        )
}

/// Select only documented row containers. Everything else stays one complete
/// object (nested arrays/objects are JSON cells), rather than guessing a table.
fn rows<'a>(path: &str, value: &'a Value) -> &'a Value {
    let key = match path {
        "site list" => "sites",
        "seed csv preview" => "rows",
        "conversation list" => "conversations",
        "comment list" | "comment stats" | "report comments list" | "topic comments" => "comments",
        "participant list" => "participants",
        "vote list" => "votes",
        "vote mine" | "vote famous" => "data",
        "invite code list" => "codes",
        "invite list" => "invites",
        "collective list" | "collective statements" => "statements",
        "topic list" | "report topics" => "topics",
        "topic proximity" => "proximity_data",
        "delphi status" => "jobs",
        _ => return value,
    };
    value.get(key).filter(|v| v.is_array()).unwrap_or(value)
}

pub fn csv(path: &str, value: &Value) -> Result<Vec<u8>> {
    let value = rows(path, value);
    let rows: Vec<&Value> = match value {
        Value::Array(rows) => rows.iter().collect(),
        _ => vec![value],
    };
    let objects = !rows.is_empty() && rows.iter().all(|r| r.is_object());
    let mut headers = BTreeSet::new();
    if objects {
        for row in &rows {
            headers.extend(row.as_object().unwrap().keys().map(String::as_str));
        }
    }
    // Header-only `value` is also the representation of an empty result. For
    // mixed/scalar rows the single cell keeps the complete value.
    let object_columns = objects && !headers.is_empty();
    if !object_columns {
        headers.insert("value");
    }
    if rows.len().saturating_add(1).saturating_mul(headers.len()) > 1_000_000 {
        return Err(Error::input(
            "CSV would exceed one million cells. Narrow the read or use --json.",
        ));
    }
    let mut writer = csv::WriterBuilder::new()
        .terminator(csv::Terminator::CRLF)
        .from_writer(Vec::new());
    let error = |_| Error::input("Cannot encode CSV output.");
    writer.write_record(&headers).map_err(error)?;
    for row in rows {
        let cells: Vec<String> = if object_columns {
            headers
                .iter()
                .map(|key| row.get(*key).map(cell).unwrap_or_default())
                .collect()
        } else {
            vec![cell(row)]
        };
        writer.write_record(cells).map_err(error)?;
        if writer.get_ref().len() > 64 * 1024 * 1024 {
            return Err(Error::input(
                "CSV exceeds 64 MiB. Narrow the read or use --json.",
            ));
        }
    }
    let bytes = writer
        .into_inner()
        .map_err(|_| Error::input("Cannot finish CSV output."))?;
    if bytes.len() > 64 * 1024 * 1024 {
        return Err(Error::input(
            "CSV exceeds 64 MiB. Narrow the read or use --json.",
        ));
    }
    Ok(bytes)
}
fn cell(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        _ => value.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn sparse_columns_cannot_expand_a_small_read_without_bound() {
        let rows: Vec<_> = (0..1000).map(|n| json!({format!("field{n}"): n})).collect();
        assert!(csv("context list", &json!(rows)).is_err());
    }

    #[test]
    fn mixed_rows_keep_every_value_and_order() {
        let input = json!([{"value": "x"}, [0, null], true, "comma,quote\"", null]);
        let bytes = csv("context list", &input).unwrap();
        let mut reader = csv::Reader::from_reader(bytes.as_slice());
        assert_eq!(
            reader.headers().unwrap(),
            &csv::StringRecord::from(vec!["value"])
        );
        let cells: Vec<_> = reader.records().map(|r| r.unwrap()[0].to_owned()).collect();
        assert_eq!(
            cells,
            vec![
                r#"{"value":"x"}"#,
                "[0,null]",
                "true",
                "comma,quote\"",
                "null"
            ]
        );
    }
}
