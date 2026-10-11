use crate::{client, profiles, public_id, str_arg};
use clap::ArgMatches;
use polis_contracts::{Error, Result};
use serde_json::{json, Value};

const QUESTIONS: &str = "/api/v3/metadata/questions";
const ANSWERS: &str = "/api/v3/metadata/answers";
fn invalid() -> Error {
    Error::new("invalid_response", "The site returned malformed metadata rows.", "Inspect both metadata lists and API compatibility. No DELETE was sent if this happened during preflight.", 1)
}
fn rows(value: &Value, answers: bool) -> Result<&Vec<Value>> {
    let rows = value.as_array().ok_or_else(invalid)?;
    let mut ids = std::collections::HashSet::new();
    let id = |v: &Value| v.as_u64().is_some_and(|n| n > 0 && n <= i32::MAX as u64);
    for row in rows {
        let field = if answers { "pmaid" } else { "pmqid" };
        if !id(&row["pmqid"])
            || !id(&row[field])
            || !ids.insert(row[field].as_u64().unwrap())
            || row["alive"] != true
            || if answers {
                !row["value"].is_string() || !row["is_exclusive"].is_boolean()
            } else {
                !row["key"].is_string() || !row["required"].is_boolean()
            }
        {
            return Err(invalid());
        }
    }
    Ok(rows)
}
fn unavailable() -> Error {
    Error::new("metadata_target_unavailable", "The active target does not belong to the selected conversation and question, or is already deleted.", "Inspect metadata question list and metadata answer list for this conversation. Nothing was deleted; do not substitute another ID automatically.", 5)
}
fn write_error(mut e: Error) -> Error {
    if matches!(
        e.code,
        "operation_failed" | "server_error" | "outcome_unknown"
    ) {
        e.message = "The site could not confirm metadata deletion.".into();
        e.action = "Inspect BOTH metadata question list and metadata answer list before retrying. Question deletion has a non-atomic cascade and may have partially succeeded. No automatic retry.";
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
    let conversation = str_arg(m, "conversation");
    public_id(conversation)?;
    if !m.get_flag("yes") {
        return Err(Error::input("Supply --yes to confirm soft deletion of this exact target; deleting a question also deletes its answer options. Nothing was sent."));
    }
    let question = *m.get_one::<u32>("question").unwrap();
    let answer = if path == "metadata answer delete" {
        m.get_one::<u32>("answer").copied()
    } else {
        None
    };
    let c = client(config, site, timeout, true)?;
    let query = vec![("conversation_id".into(), conversation.into())];
    let questions = c.request("GET", QUESTIONS, &query, None, false)?;
    let selected_question = rows(&questions, false)?
        .iter()
        .find(|q| q["pmqid"] == question)
        .ok_or_else(unavailable)?;
    let options = c.request("GET", ANSWERS, &query, None, false)?;
    let selected_options: Vec<_> = rows(&options, true)?
        .iter()
        .filter(|a| a["pmqid"] == question)
        .collect();
    let target = match answer {
        Some(id) => (*selected_options
            .iter()
            .find(|a| a["pmaid"] == id)
            .ok_or_else(unavailable)?)
        .clone(),
        None => selected_question.clone(),
    };
    let route = match answer {
        Some(id) => format!("{ANSWERS}/{id}"),
        None => format!("{QUESTIONS}/{question}"),
    };
    let receipt = c
        .request("DELETE", &route, &[], None, true)
        .map_err(write_error)?;
    if receipt.get("success") != Some(&Value::Bool(true)) || !receipt.is_object() {
        let mut e = Error::new("outcome_unknown", "The delete response did not contain a success receipt.", "Inspect BOTH metadata lists before retrying; deletion may have partially or fully succeeded.", 7);
        e.outcome = "unknown";
        return Err(e);
    }
    // Post-write errors cannot erase an accepted receipt or trigger another DELETE.
    let readback = (|| -> Result<bool> {
        let question_absent = if answer.is_none() {
            let v = c.request("GET", QUESTIONS, &query, None, false)?;
            !rows(&v, false)?.iter().any(|q| q["pmqid"] == question)
        } else {
            true
        };
        let v = c.request("GET", ANSWERS, &query, None, false)?;
        let options_absent = !rows(&v, true)?.iter().any(|a| match answer {
            Some(id) => a["pmaid"] == id,
            None => a["pmqid"] == question,
        });
        Ok(question_absent && options_absent)
    })();
    let state = match readback {
        Ok(true) => "observed",
        Ok(false) => "not_confirmed",
        Err(_) => "unavailable",
    };
    Ok(
        json!({"state":"accepted","conversation_id":conversation,"question":question,"answer":answer,"receipt":receipt,"preflight_target":target,"preflight_answer_options":selected_options,"readback_state":state,"note":"Readback observes absence from active lists only. No physical erasure or participant-response deletion is asserted. No compare-and-set; question cascade is non-atomic. Inspect BOTH lists before retrying an uncertain write."}),
    )
}
