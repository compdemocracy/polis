use clap::ArgMatches;
use polis_client::Client;
use polis_contracts::{Error, Result};
use serde_json::Value;

pub fn list(m: &ArgMatches, make_client: impl FnOnce() -> Result<Client>) -> Result<Value> {
    let sort = m
        .get_one::<String>("sort")
        .map(String::as_str)
        .unwrap_or("newest");
    if sort == "oldest" && m.get_flag("recent") {
        return Err(Error::input("--recent conflicts with --sort oldest."));
    }
    let limit = *m.get_one::<u16>("limit").unwrap();
    if limit > 500 {
        return Err(Error::input(
            "Cursor listing accepts a limit of at most 500.",
        ));
    }
    let minimum = m.get_one::<u32>("min-participants").copied().unwrap_or(0);
    let mut query = vec![
        ("sort".into(), sort.into()),
        ("limit".into(), limit.to_string()),
        ("min_participants".into(), minimum.to_string()),
    ];
    for (arg, key) in [
        ("search", "search"),
        ("active", "is_active"),
        ("draft", "is_draft"),
        ("cursor", "cursor"),
    ] {
        if let Some(value) = m.get_one::<String>(arg) {
            if (arg == "search" && value.chars().count() > 200)
                || (arg == "cursor" && (value.is_empty() || value.len() > 4096))
                || value.contains('\0')
            {
                return Err(Error::input("Invalid search or cursor length."));
            }
            query.push((key.into(), value.clone()));
        }
    }
    let invalid = || {
        Error::new("capability_unavailable", "This site does not serve the owner-list feature.", "Enable the Rust owner list on this site, or omit --sort, --min-participants and --cursor to use the existing Node list. No unfiltered fallback was attempted.", 8)
    };
    let data = make_client()?
        .request("GET", "/api/v3/owner/conversations", &query, None, false)
        .map_err(|error| {
            // Older sites have no route; the disabled gateway returns 502.
            // Keep authentication, permission, transport and other server
            // failures distinct, and never retry with an unfiltered list.
            if matches!(error.upstream["status"].as_u64(), Some(404 | 502)) {
                let mut unavailable = invalid();
                unavailable.outcome = error.outcome;
                unavailable.upstream = error.upstream;
                unavailable
            } else {
                error
            }
        })?;
    if data["scope"] != "owner" || data["sort"] != sort || data["pagination"]["limit"] != limit {
        return Err(invalid());
    }
    let rows = data["conversations"].as_array().ok_or_else(invalid)?;
    let more = data["pagination"]["has_more"]
        .as_bool()
        .ok_or_else(invalid)?;
    if rows.len() > usize::from(limit) || (more && rows.len() != usize::from(limit)) {
        return Err(invalid());
    }
    match (more, &data["pagination"]["next_cursor"]) {
        (true, Value::String(cursor)) if !cursor.is_empty() && cursor.len() <= 4096 => {}
        (false, Value::Null) => {}
        _ => return Err(invalid()),
    }
    for row in rows {
        if row["conversation_id"].as_str().is_none_or(str::is_empty)
            || row["created"]
                .as_u64()
                .is_none_or(|v| v > 9_007_199_254_740_991)
            || row["participant_count"]
                .as_u64()
                .is_none_or(|v| v < u64::from(minimum) || v > i32::MAX as u64)
            || !matches!(row["topic"], Value::String(_) | Value::Null)
            || !matches!(row["description"], Value::String(_) | Value::Null)
            || !matches!(row["is_active"], Value::Bool(_) | Value::Null)
            || !matches!(row["is_draft"], Value::Bool(_) | Value::Null)
        {
            return Err(invalid());
        }
    }
    Ok(data)
}
