//! Current public importance counts; never relabel them as a job's inputs.
use polis_client::Client;
use polis_contracts::{
    statement_importance::{Response, PATH},
    Error, Result,
};
use serde_json::{json, Value};
use std::collections::BTreeMap;

fn invalid() -> Error {
    Error::new(
        "invalid_importance",
        "The site returned incomplete or incompatible importance counts.",
        "Check API compatibility; no partial ranking was printed. No write was sent.",
        1,
    )
}
pub fn fetch(c: &Client, conversation: &str) -> Result<Response> {
    let value = c.request("GET", PATH, &[("conversation_id".into(),conversation.into())], None, false)
        .map_err(|mut e| { if e.upstream["status"] == 404 {
            e.code="capability_unavailable";e.exit=8;
            e.message="Statement importance is unavailable for this conversation on this site.".into();
            e.action="Ask the operator whether the public importance read is enabled; no counts were invented.";
        } e })?;
    let result: Response = serde_json::from_value(value).map_err(|_| invalid())?;
    if !result.valid_for(conversation) {
        return Err(invalid());
    }
    Ok(result)
}
fn metadata(counts: &Response) -> Value {
    json!({"schema":counts.schema,"conversation_id":counts.conversation_id,"read_at_ms":counts.read_at_ms,
        "state":"observed","scope":"current active, unmuted, participant-visible statements; latest vote per participant; not verified people or historical job inputs"})
}
/// Optional display reads keep absent counts unknown, never zero.
pub fn annotate(c: &Client, conversation: &str, value: &mut Value) -> Result<()> {
    let rows = value["comments"].as_array_mut().ok_or_else(invalid)?;
    let mut tids = std::collections::BTreeSet::new();
    for row in rows.iter() {
        let tid = row["tid"]
            .as_i64()
            .filter(|n| (0..=i32::MAX as i64).contains(n))
            .ok_or_else(invalid)?;
        if !row.is_object() || !tids.insert(tid) {
            return Err(invalid());
        }
    }
    let counts = fetch(c, conversation);
    let index = counts.as_ref().ok().map(|r| {
        r.statements
            .iter()
            .map(|s| (s.tid, s))
            .collect::<BTreeMap<_, _>>()
    });
    for row in rows {
        let count = index
            .as_ref()
            .and_then(|i| i.get(&(row["tid"].as_i64().unwrap() as i32)));
        row["important"] = count.map_or(Value::Null, |s| json!(s.important));
        row["voters"] = count.map_or(Value::Null, |s| json!(s.voters));
    }
    value["importance"] = match counts {
        Ok(counts) => metadata(&counts),
        Err(e) => {
            eprintln!(
                "polis: importance counts unavailable [{}]; null means unknown, not zero",
                e.code
            );
            json!({"state":"unavailable","error":e.code,"read_at_ms":null})
        }
    };
    Ok(())
}
pub fn list(
    c: &Client,
    cid: &str,
    limit: usize,
    offset: usize,
    sort: bool,
    minimum: u64,
) -> Result<Value> {
    let counts = fetch(c, cid)?;
    let mut ranked: Vec<_> = counts
        .statements
        .iter()
        .filter(|s| s.important >= minimum)
        .collect();
    if sort {
        ranked.sort_by(|a, b| b.important.cmp(&a.important).then(a.tid.cmp(&b.tid)));
    }
    let total = ranked.len();
    let selected: Vec<_> = ranked.into_iter().skip(offset).take(limit).collect();
    let mut rows = Vec::new();
    if !selected.is_empty() {
        let tids = selected
            .iter()
            .map(|s| s.tid.to_string())
            .collect::<Vec<_>>()
            .join(",");
        let response = c.request(
            "GET",
            "/api/v3/comments",
            &[
                ("conversation_id".into(), cid.into()),
                ("tids".into(), tids),
                ("limit".into(), selected.len().to_string()),
                ("offset".into(), "0".into()),
            ],
            None,
            false,
        )?;
        let raw = response["comments"].as_array().ok_or_else(invalid)?;
        let mut by_tid = BTreeMap::new();
        for row in raw {
            let tid = row["tid"]
                .as_i64()
                .filter(|n| (0..=i32::MAX as i64).contains(n))
                .ok_or_else(invalid)? as i32;
            if !row["txt"].is_string() || by_tid.insert(tid, row.clone()).is_some() {
                return Err(invalid());
            }
        }
        if by_tid.len() != selected.len() {
            return Err(changed());
        }
        for count in selected {
            let mut row = by_tid.remove(&count.tid).ok_or_else(changed)?;
            row["important"] = json!(count.important);
            row["voters"] = json!(count.voters);
            rows.push(row);
        }
    }
    Ok(
        json!({"comments":rows,"pagination":{"total":total,"limit":limit,"offset":offset,"has_more":offset.saturating_add(limit)<total},
        "importance":metadata(&counts),"order":if sort {"importance_desc_tid_asc"} else {"tid_asc"},
        "note":"Counts share one read snapshot; statement text is read afterward. Repeated pages are not a stable snapshot."}),
    )
}
fn changed() -> Error {
    Error::new(
        "importance_changed",
        "The selected statements changed or the text response did not match the importance read.",
        "Read again to get a fresh count snapshot. No partial ranking was printed.",
        1,
    )
}
