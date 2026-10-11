use crate::{client, profiles, public_id, str_arg};
use clap::ArgMatches;
use polis_contracts::{Error, Result};
use serde_json::Value;

pub fn execute(
    m: &ArgMatches,
    config: &profiles::Config,
    site: &str,
    timeout: u64,
) -> Result<Value> {
    let conversation = str_arg(m, "conversation");
    public_id(conversation)?;
    let keys: Vec<_> = m.get_many::<String>("key").into_iter().flatten().collect();
    let mut unique = std::collections::HashSet::new();
    if keys.len() > 32
        || keys.iter().any(|k| {
            k.is_empty()
                || k.len() > 100
                || !k
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
                || !unique.insert(k.as_str())
        })
    {
        return Err(Error::input(
            "Use at most 32 unique keys, each 1–100 ASCII letters, digits, underscores or hyphens.",
        ));
    }
    let mut query = vec![("conversation_id".into(), conversation.into())];
    if !keys.is_empty() {
        query.push((
            "keys".into(),
            keys.iter()
                .map(|k| k.as_str())
                .collect::<Vec<_>>()
                .join(","),
        ));
    }
    let data = client(config, site, timeout, false)?.math_presentation(&query).map_err(|mut e| {
        if e.upstream["status"] == 304 {
            e.code = "math_unavailable";
            e.message = "The site returned no math presentation.".into();
            e.action = "No conditional request was sent. Check this conversation's math availability with the site operator; no computation was requested.";
        } else if e.code == "server_error" {
            e.code = "math_read_failed";
            e.action = "Check the conversation and site math storage with the operator. This read did not request computation or automatically retry.";
        }
        e
    })?;
    let object = data.as_object().ok_or_else(invalid)?;
    // Validate the boundary, not an engine-specific checkpoint schema. Optional
    // fields and unknown extensions remain exactly as parsed from the API.
    if keys.is_empty() && !object.get("math_tick").is_some_and(valid_tick) {
        return Err(invalid());
    }
    if object.get("math_tick").is_some_and(|v| !valid_tick(v))
        || (!keys.is_empty() && object.keys().any(|k| !unique.contains(k.as_str())))
    {
        return Err(invalid());
    }
    Ok(data)
}
fn valid_tick(v: &Value) -> bool {
    v.as_u64().is_some_and(|n| n <= 9_007_199_254_740_991)
}
fn invalid() -> Error {
    Error::new("invalid_response", "The site returned an incompatible math presentation.", "Check API compatibility: expected an object, a nonnegative safe-integer math_tick for the whole presentation, and only requested keys for a subset. No computation was requested.", 1)
}
