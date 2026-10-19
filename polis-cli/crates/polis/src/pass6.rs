use crate::{profiles, public_client, public_id, str_arg};
use clap::ArgMatches;
use polis_contracts::{Error, Result};
use serde_json::Value;

fn response_error() -> Error {
    Error::new("invalid_response", "The site returned an incomplete or ambiguous read response.", "Check the selected site and resource ID; ask the operator to check API compatibility. No write was sent.", 1)
}
fn read_error(mut e: Error) -> Error {
    if matches!(e.code, "operation_failed" | "server_error") {
        e.code = "topic_read_failed";
        e.message = "The site could not read the stored topic data.".into();
        e.action = "Check the conversation and optional job ID. Ask the operator to check stored topic data; this read does not start analysis or call a model.";
    }
    e
}

// Encode one segment, including '#' in job-scoped topic keys. Reject path
// separators/dot segments rather than relying on proxy normalization behavior.
fn topic_path(key: &str) -> Result<String> {
    if key.is_empty()
        || key.len() > 1024
        || key.chars().any(char::is_control)
        || key.contains(['/', '\\'])
        || matches!(key, "." | "..")
    {
        return Err(Error::input("Topic key must be 1–1024 UTF-8 bytes, with no controls, slash, backslash or dot segment. Copy an exact key from topic list."));
    }
    let mut url = url::Url::parse("https://localhost/api/v3/topicMod/topics/").unwrap();
    url.path_segments_mut()
        .unwrap()
        .pop_if_empty()
        .push(key)
        .push("comments");
    Ok(url.path().into())
}

pub fn execute(
    path: &str,
    m: &ArgMatches,
    config: &profiles::Config,
    site: &str,
    timeout: u64,
) -> Result<Value> {
    let is_report = path.starts_with("report ");
    let id = if path == "report topics" {
        m.get_one::<String>("report")
            .or_else(|| m.get_one::<String>("id"))
            .map(String::as_str)
            .ok_or_else(|| Error::input("Supply a report ID or --report REPORT."))?
    } else {
        str_arg(m, if is_report { "id" } else { "conversation" })
    };
    public_id(id)?;
    let topic = if path == "topic comments" {
        Some(topic_path(str_arg(m, "key"))?)
    } else {
        None
    };
    let job = if matches!(path, "topic list" | "report topics") {
        m.get_one::<String>("job")
    } else {
        None
    };
    if job.is_some_and(|j| {
        j.is_empty()
            || j.len() > 256
            || !j
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
    }) {
        return Err(Error::input(
            "Job ID must be 1–256 ASCII letters, digits, underscores or hyphens.",
        ));
    }
    if path == "topic proximity" {
        let layer = str_arg(m, "layer");
        if layer != "all"
            && (layer.is_empty()
                || !layer.bytes().all(|b| b.is_ascii_digit())
                || layer.parse::<u32>().map_or(true, |n| n > i32::MAX as u32))
        {
            return Err(Error::input(
                "Layer must be all or a nonnegative 32-bit integer.",
            ));
        }
    }
    let c = public_client(config, site, timeout)?;
    let conversation = if is_report {
        let rows = c.request(
            "GET",
            "/api/v3/reports",
            &[("report_id".into(), id.into())],
            None,
            false,
        )?;
        let rows = rows
            .as_array()
            .filter(|r| r.len() == 1)
            .ok_or_else(response_error)?;
        let row = &rows[0];
        if row["report_id"].as_str() != Some(id) {
            return Err(response_error());
        }
        let conv = row["conversation_id"].as_str().ok_or_else(response_error)?;
        public_id(conv).map_err(|_| response_error())?;
        conv.to_owned()
    } else {
        id.to_owned()
    };
    let mut query = vec![("conversation_id".into(), conversation.clone())];
    let route = match path {
        "report stats" => {
            query.push(("report_id".into(), id.into()));
            if let Some(until) = m.get_one::<u64>("until") {
                query.push(("until".into(), until.to_string()));
            }
            "/api/v3/conversationStats"
        }
        "report comments list" => {
            query.extend([
                ("report_id".into(), id.into()),
                (
                    "limit".into(),
                    m.get_one::<u16>("limit").unwrap().to_string(),
                ),
                (
                    "offset".into(),
                    m.get_one::<u32>("offset").unwrap().to_string(),
                ),
            ]);
            "/api/v3/comments"
        }
        "topic list" | "report topics" => {
            if let Some(job) = job {
                query.push(("job_id".into(), job.clone()));
            }
            "/api/v3/topicMod/topics"
        }
        "topic comments" => topic.as_deref().unwrap(),
        "topic hierarchy" => "/api/v3/topicMod/hierarchy",
        "topic proximity" => {
            query.push(("layer_id".into(), str_arg(m, "layer").into()));
            "/api/v3/topicMod/proximity"
        }
        "topic stats" => "/api/v3/topicMod/stats",
        _ => return Err(Error::input("Unknown read command.")),
    };
    let result = c.request("GET", route, &query, None, false);
    let mut v = if route.contains("/topicMod/") {
        result.map_err(read_error)?
    } else {
        result?
    };
    // Fail on malformed successful bodies; preserve all valid fields, including
    // moderation_available=false and null/empty results. Do not invent freshness.
    let valid = match path {
        "report stats" => v["voteTimes"].is_array() && v["commentTimes"].is_array(),
        "report comments list" => v["comments"].is_array() && v["pagination"].is_object(),
        _ if v["status"] != "success" => false,
        "topic list" | "report topics" => {
            v["topics"].is_array() || v["topics_by_layer"].is_object()
        }
        "topic comments" => v["comments"].is_array(),
        "topic hierarchy" => v
            .get("hierarchy")
            .is_some_and(|h| h.is_null() || h.is_object()),
        "topic proximity" => v["proximity_data"].is_array(),
        "topic stats" => v["stats"].is_object() && v["moderation_available"].is_boolean(),
        _ => false,
    };
    if !valid {
        return Err(response_error());
    }
    if path == "report comments list" {
        crate::importance::annotate(&c, &conversation, &mut v)?;
    }
    Ok(v)
}
