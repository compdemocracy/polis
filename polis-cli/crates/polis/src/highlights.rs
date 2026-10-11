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
    let moderation = m.get_one::<i32>("mod").copied();
    let mut query = vec![("conversation_id".into(), conversation.into())];
    if let Some(value) = moderation {
        query.push(("mod".into(), value.to_string()));
    }
    let data = client(config, site, timeout, false)?.participant_highlights(&query).map_err(|mut e| {
        if e.upstream["status"] == 304 {
            e.code = "participant_profiles_unavailable";
            e.message = "The site returned no participant profile representation.".into();
            e.action = "Check the conversation and site compatibility; this is not an empty profile list. No retry was made.";
        } else if e.upstream["status"].as_u64().is_some_and(|status| status >= 500) {
            e.code = "participant_profiles_read_failed";
            e.action = "Check the conversation and participant-profile storage with the site operator. No retry was made.";
        }
        e
    })?;
    for row in data.as_array().ok_or_else(invalid)? {
        let pid = row.get("pid").and_then(Value::as_u64);
        let value = row.get("mod").and_then(Value::as_i64);
        let profile = row
            .get("xInfo")
            .and_then(Value::as_object)
            .ok_or_else(invalid)?;
        if !pid.is_some_and(|p| p <= i32::MAX as u64)
            || !value.is_some_and(|v| i32::try_from(v).is_ok())
            || moderation.is_some_and(|m| value != Some(i64::from(m)))
            || row.get("conversation_id").and_then(Value::as_str) != Some(conversation)
            || !profile.get("xid").is_some_and(Value::is_string)
            || !profile
                .get("x_profile_image_url")
                .is_some_and(Value::is_string)
            || profile
                .get("x_name")
                .is_some_and(|n| !n.is_null() && !n.is_string())
        {
            return Err(invalid());
        }
    }
    // Preserve rows, extension fields and server order.
    Ok(data)
}
fn invalid() -> Error {
    Error::new("invalid_response", "The site returned incompatible participant profiles.", "Expected profile rows for this exact conversation and moderation filter. Check site compatibility; no retry was made.", 1)
}
