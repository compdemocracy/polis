use crate::{client, profiles, public_id, str_arg};
use clap::ArgMatches;
use polis_contracts::{Error, Result};
use serde_json::{json, Value};

const QUESTIONS: &str = "/api/v3/metadata/questions";
const ANSWERS: &str = "/api/v3/metadata/answers";
fn invalid() -> Error {
    Error::new("invalid_response", "The site returned malformed metadata rows.", "Inspect both metadata lists and API compatibility. No POST was sent if this happened during preflight.", 1)
}
fn valid_id(v: &Value) -> bool {
    v.as_u64().is_some_and(|n| n > 0 && n <= i32::MAX as u64)
}
fn rows(value: &Value, answers: bool) -> Result<&Vec<Value>> {
    let rows = value.as_array().ok_or_else(invalid)?;
    let mut ids = std::collections::HashSet::new();
    for row in rows {
        let field = if answers { "pmaid" } else { "pmqid" };
        if !valid_id(&row["pmqid"])
            || !valid_id(&row[field])
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
fn unknown() -> Error {
    let mut e = Error::new("outcome_unknown", "The write response did not contain the expected answer-option receipt.", "Inspect BOTH metadata lists before retrying; an option may already have been created or reactivated. No automatic retry.", 7);
    e.outcome = "unknown";
    e
}
fn write_error(mut e: Error) -> Error {
    if matches!(
        e.code,
        "operation_failed" | "server_error" | "outcome_unknown"
    ) {
        e.message = "The site could not confirm answer-option creation or reactivation.".into();
        e.action = "Inspect BOTH metadata lists before retrying; the option may already be active. Check exact conversation ownership and question membership. No automatic retry.";
    }
    e
}
pub fn execute(
    m: &ArgMatches,
    config: &profiles::Config,
    site: &str,
    timeout: u64,
) -> Result<Value> {
    let conversation = str_arg(m, "conversation");
    public_id(conversation)?;
    let question = *m.get_one::<u32>("question").unwrap();
    let text = str_arg(m, "value");
    if text.is_empty()
        || text.encode_utf16().count() > 999
        || text.starts_with(' ')
        || text.ends_with(' ')
        || text.chars().any(char::is_control)
    {
        return Err(Error::input("Option text must be 1–999 UTF-16 code units with no controls or surrounding ASCII spaces. Text is never trimmed; nothing was sent."));
    }
    if !m.get_flag("yes") {
        return Err(Error::input("Supply --yes to confirm creating this option or reactivating a deleted option with the same exact text. Nothing was sent."));
    }
    let c = client(config, site, timeout, true)?;
    let query = vec![("conversation_id".into(), conversation.into())];
    let questions = c.request("GET", QUESTIONS, &query, None, false)?;
    let selected_question = rows(&questions, false)?
        .iter()
        .find(|q| q["pmqid"] == question)
        .ok_or_else(|| Error::new("metadata_target_unavailable", "The active question does not belong to the selected conversation, or is deleted.", "Inspect metadata question list for this conversation. Nothing was sent; do not substitute another ID automatically.", 5))?;
    let options = c.request("GET", ANSWERS, &query, None, false)?;
    if rows(&options, true)?
        .iter()
        .any(|a| a["pmqid"] == question && a["value"] == text)
    {
        return Err(Error::new("metadata_option_exists", "An active option already has this exact text under the selected question.", "Use metadata answer list to inspect its ID. No POST was sent. A deleted option with the same text may be reactivated by an explicit confirmed add.", 5));
    }
    let receipt = c
        .request(
            "POST",
            ANSWERS,
            &[],
            Some(json!({"conversation_id":conversation,"pmqid":question,"value":text})),
            true,
        )
        .map_err(write_error)?;
    // POST returns the raw row; GET's legacy is_exclusive flag is not a receipt field.
    if !valid_id(&receipt["pmaid"])
        || receipt["pmqid"] != question
        || receipt["value"] != text
        || receipt["alive"] != true
    {
        return Err(unknown());
    }
    // Both observations are needed: the question may have been deleted concurrently.
    // Readback is not a transaction, authorization boundary or compare-and-set.
    let readback = (|| -> Result<Option<Value>> {
        let q = c.request("GET", QUESTIONS, &query, None, false)?;
        let question_active = rows(&q, false)?.iter().any(|r| r["pmqid"] == question);
        let a = c.request("GET", ANSWERS, &query, None, false)?;
        let found = rows(&a, true)?.iter().find(|r| {
            r["pmaid"] == receipt["pmaid"] && r["pmqid"] == question && r["value"] == text
        });
        Ok(if question_active {
            found.cloned()
        } else {
            None
        })
    })();
    let (state, observed) = match readback {
        Ok(Some(row)) => ("observed", row),
        Ok(None) => ("not_confirmed", Value::Null),
        Err(_) => ("unavailable", Value::Null),
    };
    Ok(
        json!({"state":"accepted","conversation_id":conversation,"question":question,"receipt":receipt,"preflight_question":selected_question,"readback_state":state,"observed":observed,"note":"Accepted creation or reactivation; the legacy receipt does not distinguish them. Answer options are not participant responses. Preflight/readback are not atomic or a server authorization boundary. Inspect BOTH lists before retrying an uncertain write."}),
    )
}
