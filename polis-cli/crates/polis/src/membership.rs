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
    let data = client(config, site, timeout, false)?.base_cluster_membership(conversation).map_err(|mut e| {
        if e.upstream["status"] == 304 {
            e.code = "membership_unavailable";
            e.message = "The site returned no base-cluster membership map.".into();
            e.action = "Check math availability with the site operator. The legacy API can also mask storage failures as 304; this does not prove an empty conversation. No computation or retry was requested.";
        } else if e.code == "server_error" {
            e.code = "membership_read_failed";
            e.action = "Check the conversation and math storage with the site operator. No computation or retry was requested.";
        }
        e
    })?;
    let rows = data
        .get("bidToPid")
        .and_then(Value::as_array)
        .ok_or_else(invalid)?;
    let mut seen = std::collections::HashSet::new();
    for row in rows {
        for pid in row.as_array().ok_or_else(invalid)? {
            let pid = pid
                .as_u64()
                .filter(|n| *n <= i32::MAX as u64)
                .ok_or_else(invalid)?;
            if !seen.insert(pid) {
                return Err(invalid());
            }
        }
    }
    Ok(data)
}
fn invalid() -> Error {
    Error::new("invalid_response", "The site returned an incompatible base-cluster membership map.", "Expected bidToPid as arrays of unique nonnegative participant IDs. Ask the site operator to check math storage. No computation or retry was requested.", 1)
}
