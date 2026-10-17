use polis_contracts::{Error, Result};
use serde_json::{json, Value};
use std::collections::HashSet;
pub fn text(value: &str) -> Result<()> {
    if value.trim().is_empty() || value.encode_utf16().count() > 997 || value.contains('\0') {
        return Err(Error::input(
            "Statement must contain text, no NUL, and at most 997 UTF-16 units.",
        ));
    }
    Ok(())
}
pub fn validate(raw: &str) -> Result<Vec<Value>> {
    let raw = raw.strip_prefix('\u{feff}').unwrap_or(raw);
    strict_csv(raw)?;
    let mut reader = csv::ReaderBuilder::new()
        .flexible(false)
        .from_reader(raw.as_bytes());
    let headers = reader
        .headers()
        .map_err(|_| Error::input("Cannot parse CSV header."))?
        .clone();
    if headers.len() != 2
        || !headers.iter().any(|h| h == "comment_text")
        || !headers.iter().any(|h| h == "original_id")
    {
        return Err(Error::input(
            "CSV requires exactly comment_text and original_id headers; no unknown columns.",
        ));
    }
    let ti = headers.iter().position(|h| h == "comment_text").unwrap();
    let oi = headers.iter().position(|h| h == "original_id").unwrap();
    let mut texts = HashSet::new();
    let mut ids = HashSet::new();
    let mut rows = Vec::new();
    for (i, row) in reader.records().enumerate() {
        let row = row.map_err(|_| {
            Error::input(format!(
                "Invalid CSV record {} (quoting or column count).",
                i + 2
            ))
        })?;
        let t = &row[ti];
        let id = &row[oi];
        text(t).map_err(|_| Error::input(format!("Invalid statement in CSV record {}.", i + 2)))?;
        let canonical = uuid::Uuid::parse_str(id)
            .map(|u| u.to_string())
            .unwrap_or_else(|_| id.to_owned());
        if id.trim().is_empty()
            || id.len() > 200
            || id.chars().any(char::is_control)
            || !texts.insert(t.to_owned())
            || !ids.insert(canonical)
        {
            return Err(Error::input(format!(
                "Empty/oversized original_id or duplicate text/id in CSV record {}.",
                i + 2
            )));
        }
        rows.push(json!({"record":i+2,"comment_text":t,"original_id":id}));
        if rows.len() > 1000 {
            return Err(Error::input("Import at most 1000 statements per file."));
        }
    }
    if rows.is_empty() {
        return Err(Error::input("CSV contains no statements."));
    }
    Ok(rows)
}
// The normal binary has no environment-controlled identity generation. The
// dedicated test build accepts a declared generated UUID so two live executions
// receive the same input; no receipt field is removed from the comparison.
#[cfg(feature = "fixture-ids")]
fn fixture_id(value: &str) -> Result<uuid::Uuid> {
    uuid::Uuid::parse_str(value).map_err(|_| Error::input("Invalid fixture statement UUID."))
}
fn statement_id() -> Result<uuid::Uuid> {
    #[cfg(feature = "fixture-ids")]
    if let Some(value) = std::env::var_os("POLIS_CLI_FIXTURE_UUID") {
        return fixture_id(
            value
                .to_str()
                .ok_or_else(|| Error::input("Invalid fixture statement UUID."))?,
        );
    }
    Ok(uuid::Uuid::new_v4())
}
pub fn single(value: &str) -> Result<String> {
    text(value)?;
    let mut writer = csv::Writer::from_writer(Vec::new());
    writer
        .write_record(["comment_text", "original_id"])
        .map_err(|_| Error::input("Cannot encode statement."))?;
    writer
        .write_record([value, &statement_id()?.to_string()])
        .map_err(|_| Error::input("Cannot encode statement."))?;
    Ok(String::from_utf8(writer.into_inner().unwrap()).unwrap())
}

// csv intentionally accepts some malformed quoting and blank records; imports do not.
pub(crate) fn strict_csv(raw: &str) -> Result<()> {
    let mut state = 0; // field start, unquoted, quoted, closing quote
    let mut present = false;
    let mut bytes = raw.bytes().peekable();
    while let Some(b) = bytes.next() {
        match (state, b) {
            (2, b'"') => state = 3,
            (2, _) => {}
            (3, b'"') => state = 2,
            (_, b'\n' | b'\r') => {
                if !present {
                    return Err(Error::input(
                        "CSV contains a blank record; remove it explicitly.",
                    ));
                }
                if b == b'\r' && bytes.peek() == Some(&b'\n') {
                    bytes.next();
                }
                state = 0;
                present = false;
            }
            (_, b',') => {
                state = 0;
                present = true;
            }
            (0, b'"') => {
                state = 2;
                present = true;
            }
            (1, b'"') | (3, _) => return Err(Error::input("CSV has malformed quoting.")),
            (_, _) => {
                state = 1;
                present = true;
            }
        }
    }
    if state == 2 {
        return Err(Error::input("CSV has an unclosed quoted field."));
    }
    Ok(())
}

// Keep external identifiers in the receipt; PostgreSQL receives a stable UUID.
// Domain separation binds mappings to a site AND conversation, never statement text.
pub fn submission(raw: &str, origin: &str, conversation: &str) -> Result<(String, Vec<Value>)> {
    let rows = validate(raw)?;
    let origin = polis_client::base_url(origin)?.to_string();
    let mut writer = csv::Writer::from_writer(Vec::new());
    writer
        .write_record(["comment_text", "original_id"])
        .map_err(|_| Error::input("Cannot encode CSV."))?;
    let mut mapping = Vec::new();
    let mut submitted = HashSet::new();
    for row in rows {
        let original = row["original_id"].as_str().unwrap();
        let id = uuid::Uuid::parse_str(original)
            .unwrap_or_else(|_| {
                let name =
                    serde_json::to_vec(&json!(["polis-seed/1", origin, conversation, original]))
                        .unwrap();
                uuid::Uuid::new_v5(&uuid::Uuid::NAMESPACE_URL, &name)
            })
            .to_string();
        if !submitted.insert(id.clone()) {
            return Err(Error::input(
                "External identifiers collide after UUID mapping.",
            ));
        }
        writer
            .write_record([row["comment_text"].as_str().unwrap(), &id])
            .map_err(|_| Error::input("Cannot encode CSV."))?;
        mapping.push(
            json!({"record":row["record"],"original_id":original,"submitted_original_id":id}),
        );
    }
    Ok((
        String::from_utf8(writer.into_inner().unwrap()).unwrap(),
        mapping,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn external_ids_are_stable_scoped_and_receipted() {
        let raw="comment_text,original_id\n  keep spaces  ,source-42\nUUID row,00000000-0000-4000-8000-000000000001\n";
        let (a, m) = submission(raw, "https://example.invalid/", "convA").unwrap();
        assert_eq!(
            submission(raw, "https://example.invalid/", "convA")
                .unwrap()
                .0,
            a
        );
        assert_ne!(
            submission(raw, "https://other.invalid/", "convA")
                .unwrap()
                .0,
            a
        );
        assert_ne!(
            submission(raw, "https://example.invalid/", "convB")
                .unwrap()
                .0,
            a
        );
        assert!(a.contains("  keep spaces  ,"));
        assert_eq!(m[0]["original_id"], "source-42");
        uuid::Uuid::parse_str(m[0]["submitted_original_id"].as_str().unwrap()).unwrap();
        assert_eq!(m[1]["original_id"], m[1]["submitted_original_id"]);
    }
    #[test]
    fn canonical_uuid_duplicates_and_external_duplicates_are_refused() {
        for ids in [
            ("same", "same"),
            (
                "00000000-0000-4000-8000-000000000001",
                "00000000000040008000000000000001",
            ),
        ] {
            assert!(validate(&format!(
                "comment_text,original_id\none,{}\ntwo,{}\n",
                ids.0, ids.1
            ))
            .is_err());
        }
    }
}

#[cfg(all(test, feature = "fixture-ids"))]
mod fixture_tests {
    use super::*;
    #[test]
    fn declared_id_is_preserved() {
        let id = "00000000-0000-4000-8000-000000000027";
        assert_eq!(fixture_id(id).unwrap().to_string(), id);
    }
    #[test]
    fn malformed_id_is_rejected() {
        assert!(fixture_id("not-a-uuid").is_err());
    }
}
