use crate::{client, profiles, public_id, str_arg};
use clap::ArgMatches;
use polis_contracts::{Error, Result};
use serde_json::Value;

fn invalid_response() -> Error {
    Error::new("invalid_response", "The site returned malformed metadata or context rows.", "Check the selected site and question filter; ask the operator to check API compatibility. No write was sent.", 1)
}
fn read_error(mut e: Error, context: bool) -> Error {
    if matches!(e.code, "operation_failed" | "server_error") {
        e.code = if context {
            "contexts_read_failed"
        } else {
            "metadata_read_failed"
        };
        e.message = "The site could not read the requested metadata or contexts.".into();
        e.action = if context {
            "Check the selected site; ask the operator to inspect public context storage. Retrying this read does not create contexts."
        } else {
            "Check the conversation and optional question ID; use metadata question list to find active questions. Ask the operator to inspect metadata storage."
        };
    }
    e
}
fn id(v: &Value) -> bool {
    v.as_u64().is_some_and(|n| n > 0 && n <= i32::MAX as u64)
}
pub fn execute(
    path: &str,
    m: &ArgMatches,
    config: &profiles::Config,
    site: &str,
    timeout: u64,
) -> Result<Value> {
    let context = path == "context list";
    let answers = path == "metadata answer list";
    let mut query = vec![];
    let mut question = None;
    if !context {
        let conversation = str_arg(m, "conversation");
        public_id(conversation)?;
        query.push(("conversation_id".into(), conversation.into()));
        if answers {
            question = m.get_one::<u32>("question").copied();
            if let Some(q) = question {
                query.push(("pmqid".into(), q.to_string()));
            }
        }
    }
    let route = if context {
        "/api/v3/contexts"
    } else if answers {
        "/api/v3/metadata/answers"
    } else {
        "/api/v3/metadata/questions"
    };
    let v = client(config, site, timeout, false)?
        .request("GET", route, &query, None, false)
        .map_err(|e| read_error(e, context))?;
    let rows = v.as_array().ok_or_else(invalid_response)?;
    let mut identities = std::collections::HashSet::new();
    for row in rows {
        let valid = if context {
            row["name"]
                .as_str()
                .is_some_and(|name| identities.insert(name.to_owned()))
        } else {
            id(&row["pmqid"])
                && row["alive"] == true
                && if answers {
                    id(&row["pmaid"])
                        && row["value"].is_string()
                        && row["is_exclusive"].is_boolean()
                        && question.is_none_or(|q| row["pmqid"].as_u64() == Some(q as u64))
                        && identities.insert(row["pmaid"].to_string())
                } else {
                    row["key"].is_string()
                        && row["required"].is_boolean()
                        && identities.insert(row["pmqid"].to_string())
                }
        };
        if !valid {
            return Err(invalid_response());
        }
    }
    Ok(v)
}
