use crate::{client, profiles, public_id, str_arg};
use clap::ArgMatches;
use polis_contracts::{Error, Result};
use serde_json::{json, Value};

fn unknown() -> Error {
    let mut e = Error::new("outcome_unknown", "The write response did not contain the expected receipt.", "Inspect metadata question list or context list before retrying; the write may already have succeeded.", 7);
    e.outcome = "unknown";
    e
}
fn write_error(mut e: Error, context: bool) -> Error {
    if matches!(e.code, "operation_failed" | "server_error") {
        e.message = "The site could not confirm the requested creation.".into();
        e.action = if context {
            "Inspect context list before retrying. Names are site-wide; a private-name collision may require operator help."
        } else {
            "Check exact conversation ownership and inspect metadata question list before retrying. Question text must be unique within the conversation; a deleted question may still reserve its text."
        };
    }
    e
}
pub fn execute(
    path: &str,
    m: &ArgMatches,
    config: &profiles::Config,
    site: &str,
    timeout: u64,
) -> Result<Value> {
    let context = path == "context create";
    let text = str_arg(m, if context { "name" } else { "key" });
    let limit = if context { 300 } else { 999 };
    if text.is_empty()
        || text.encode_utf16().count() > limit
        || text.starts_with(' ')
        || text.ends_with(' ')
        || text.chars().any(char::is_control)
    {
        return Err(Error::input("Text is empty, too long, contains controls or has surrounding ASCII spaces. Supply exact text within the documented UTF-16 limit; nothing was sent."));
    }
    let conversation = if context {
        None
    } else {
        let id = str_arg(m, "conversation");
        public_id(id)?;
        Some(id)
    };
    let route = if context {
        "/api/v3/contexts"
    } else {
        "/api/v3/metadata/questions"
    };
    let body = if context {
        json!({"name":text})
    } else {
        json!({"conversation_id":conversation,"key":text})
    };
    let c = client(config, site, timeout, true)?;
    let receipt = c
        .request("POST", route, &[], Some(body), true)
        .map_err(|e| write_error(e, context))?;
    let valid = if context {
        receipt.as_object().is_some_and(|o| o.is_empty())
    } else {
        receipt["key"] == text
            && receipt["alive"] == true
            && receipt["pmqid"]
                .as_u64()
                .is_some_and(|id| id > 0 && id <= i32::MAX as u64)
    };
    if !valid {
        return Err(unknown());
    }
    let query = conversation
        .map(|id| vec![("conversation_id".into(), id.into())])
        .unwrap_or_default();
    // A read failure must never erase an already accepted creation receipt.
    let readback = c.request("GET", route, &query, None, false);
    let (state, observed) = match readback {
        Ok(v) => match v.as_array() {
            Some(rows) => {
                let matches: Vec<_> = rows
                    .iter()
                    .filter(|row| {
                        if context {
                            row["name"] == text
                        } else {
                            row["pmqid"] == receipt["pmqid"]
                                && row["key"] == text
                                && row["alive"] == true
                        }
                    })
                    .collect();
                if matches.len() == 1 {
                    ("observed", matches[0].clone())
                } else {
                    ("not_confirmed", Value::Null)
                }
            }
            None => ("unavailable", Value::Null),
        },
        Err(_) => ("unavailable", Value::Null),
    };
    Ok(
        json!({"state":"accepted","receipt":receipt,"readback_state":state,"observed":observed,"note":"Readback is an observation, not a new authorization or idempotency guarantee. Inspect the list before retrying an uncertain creation."}),
    )
}
