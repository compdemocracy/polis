use crate::{client, profiles, public_id, str_arg};
use clap::ArgMatches;
use polis_contracts::{Error, Result};
use serde_json::Value;

fn invalid_response() -> Error {
    Error::new("invalid_response", "The site returned an incomplete or mismatched stored read response.", "Check the resource ID and selected site; ask the operator to check API compatibility. No write or generation was sent.", 1)
}
fn unavailable(collective: bool) -> Error {
    if collective {
        Error::new("collective_statement_unavailable", "The stored collective statement was not found.", "Run polis collective list --report <report> and copy an exact zid_topic_jobid; this read will not generate a replacement.", 1)
    } else {
        Error::new("statement_unavailable", "This statement is absent or not participant-visible.", "Check the conversation and statement number. Authorized moderators can inspect hidden statements with polis moderate list.", 1)
    }
}
fn read_error(mut e: Error, collective: bool, single: bool) -> Error {
    if collective && single && e.code == "operation_failed" && e.upstream["status"] == 404 {
        let missing = unavailable(true);
        e.code = missing.code;
        e.message = missing.message;
        e.action = missing.action;
    } else if matches!(
        e.code,
        "operation_failed" | "server_error" | "statements_read_failed"
    ) {
        e.code = if collective {
            "collective_read_failed"
        } else {
            "statements_read_failed"
        };
        e.message = "The site could not read the requested stored statements.".into();
        e.action = if collective {
            "Check the report or stored statement ID and site. Ask the operator to inspect collective-statement storage; retrying this read does not generate content."
        } else {
            "Check the conversation, statement number and pagination. Ask the operator to inspect statement reads; use moderate list for hidden statements if authorized."
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
    let collective = path.starts_with("collective ");
    let single = path.ends_with(" view");
    let mut query = vec![];
    let mut tid = None;
    let mut key = None;
    if collective {
        if single {
            let id = str_arg(m, "id");
            // DynamoDB string partition keys are at most 2048 UTF-8 bytes.
            // Query encoding keeps every literal separator as data, not a URL.
            if id.is_empty() || id.len() > 2048 || id.chars().any(char::is_control) {
                return Err(Error::input("Stored collective ID must be 1–2048 UTF-8 bytes without control characters; copy the exact zid_topic_jobid from collective list."));
            }
            key = Some(id);
            query.push(("statement_id".into(), id.into()));
        } else {
            let report = str_arg(m, "report");
            public_id(report)?;
            query.push(("report_id".into(), report.into()));
        }
    } else {
        let conversation = str_arg(m, "conversation");
        public_id(conversation)?;
        query.push(("conversation_id".into(), conversation.into()));
        if single {
            let id = *m.get_one::<u32>("tid").unwrap();
            tid = Some(id);
            query.push(("tids".into(), id.to_string()));
            // Two rows let us detect a broken upstream that ignores the exact filter.
            query.extend([("limit".into(), "2".into()), ("offset".into(), "0".into())]);
        } else {
            query.extend([
                (
                    "limit".into(),
                    m.get_one::<u16>("limit").unwrap().to_string(),
                ),
                (
                    "offset".into(),
                    m.get_one::<u32>("offset").unwrap().to_string(),
                ),
            ]);
        }
    }
    let c = client(config, site, timeout, false)?;
    let v = c
        .request(
            "GET",
            if collective {
                "/api/v3/collectiveStatement"
            } else {
                "/api/v3/comments"
            },
            &query,
            None,
            false,
        )
        .map_err(|e| read_error(e, collective, single))?;
    if collective {
        if v["status"] != "success" {
            return Err(invalid_response());
        }
        if let Some(id) = key {
            if v["statement"]["zid_topic_jobid"].as_str() != Some(id) {
                return Err(invalid_response());
            }
        } else {
            let rows = v["statements"].as_array().ok_or_else(invalid_response)?;
            if v["count"].as_u64() != Some(rows.len() as u64)
                || !rows.iter().all(|row| {
                    row["zid_topic_jobid"]
                        .as_str()
                        .is_some_and(|id| !id.is_empty())
                })
            {
                return Err(invalid_response());
            }
        }
        return Ok(v);
    }
    let rows = v["comments"].as_array().ok_or_else(invalid_response)?;
    if !v["pagination"].is_object()
        || !rows.iter().all(|row| {
            row["tid"].as_u64().is_some_and(|n| n <= i32::MAX as u64) && row["txt"].is_string()
        })
    {
        return Err(invalid_response());
    }
    if let Some(id) = tid {
        if rows.is_empty() {
            return Err(unavailable(false));
        }
        if rows.len() != 1 || rows[0]["tid"].as_u64() != Some(id as u64) {
            return Err(invalid_response());
        }
        return Ok(rows[0].clone());
    }
    Ok(v)
}
