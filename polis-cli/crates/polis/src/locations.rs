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
    let group = m.get_one::<u32>("group").expect("required group");
    let query = vec![
        ("conversation_id".into(), conversation.into()),
        ("gid".into(), group.to_string()),
    ];
    let data = client(config, site, timeout, false)?.participant_locations(&query).map_err(|mut e| {
        if e.upstream["status"] == 304 {
            e.code = "participant_locations_unavailable";
            e.message = "The site returned no participant location representation.".into();
            e.action = "Check the conversation, group index and site compatibility; this is not an empty location list. No retry was made.";
        } else if e.upstream["status"].as_u64().is_some_and(|status| status >= 500) {
            e.code = "participant_locations_read_failed";
            e.action = "Check participant-location storage and the math bundle with the site operator. No retry was made.";
        }
        e
    })?;
    for row in data.as_array().ok_or_else(invalid)? {
        if !coordinate(row.get("lat"), 90.0)
            || !coordinate(row.get("lng"), 180.0)
            || row.get("n").and_then(Value::as_u64) != Some(1)
        {
            return Err(invalid());
        }
    }
    // Keep duplicate points, array order and extension fields; never clip or aggregate.
    Ok(data)
}
fn coordinate(value: Option<&Value>, limit: f64) -> bool {
    value
        .and_then(Value::as_f64)
        .is_some_and(|v| v.is_finite() && v.abs() <= limit)
}
fn invalid() -> Error {
    Error::new("invalid_response", "The site returned incompatible participant locations.", "Expected an array of finite latitude [-90,90], longitude [-180,180] and n=1 rows. Check site compatibility and stored coordinates; no rows were clipped or dropped, and no retry was made.", 1)
}
