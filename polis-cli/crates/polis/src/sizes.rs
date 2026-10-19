//! Explicit, bounded statistics reads for the owner list. No writes or vote values.
use clap::ArgMatches;
use polis_client::Client;
use polis_contracts::{Error, Result};
use serde_json::{json, Value};

pub fn validate(m: &ArgMatches) -> Result<bool> {
    let sort = m.get_one::<String>("sort").map(String::as_str);
    let sizes =
        m.get_flag("sizes") || matches!(sort, Some("participants" | "statements" | "votes"));
    if sizes
        && (matches!(sort, Some("newest" | "oldest"))
            || m.get_one::<String>("cursor").is_some()
            || m.get_one::<u32>("min-participants").is_some()
            || m.get_flag("recent")
            || *m.get_one::<u16>("limit").unwrap() > 500)
    {
        return Err(Error::input("Sizes accept --limit up to 500 and cannot combine with --recent, date sort, --cursor or --min-participants."));
    }
    Ok(sizes)
}

pub fn enrich(listing: &mut Value, client: &Client, sort: Option<&str>) -> Result<()> {
    let limit = listing["pagination"]["limit"].as_u64().unwrap_or(0) as usize;
    let server_rows = listing["pagination"]["server_rows"]
        .as_u64()
        .unwrap_or(u64::MAX);
    if server_rows > limit as u64 || limit > 500 {
        return Err(Error::new(
            "invalid_response",
            "The site exceeded the requested list limit.",
            "No size reads were attempted.",
            1,
        ));
    }
    let rows = listing["conversations"]
        .as_array_mut()
        .ok_or_else(|| Error::input("Expected owned conversations."))?;
    // Validate every ID before issuing the first stats read.
    for row in rows.iter() {
        crate::public_id(row["conversation_id"].as_str().unwrap_or(""))?;
    }
    for row in rows.iter_mut() {
        let id = row["conversation_id"].as_str().unwrap();
        let stats = client.request(
            "GET",
            "/api/v3/conversationStats",
            &[("conversation_id".into(), id.into())],
            None,
            false,
        )?;
        let mut counts = serde_json::Map::new();
        for (name, field) in [
            ("participants", "firstVoteTimes"),
            ("statements", "commentTimes"),
            ("votes", "voteTimes"),
        ] {
            let values = stats[field].as_array().filter(|v| v.iter().all(|t| t.as_u64().is_some_and(|n| n <= 9_007_199_254_740_991))).ok_or_else(|| Error::new("invalid_response", "The site returned incomplete or invalid size statistics.", "No partial ranking was printed. Check the site's conversationStats response.", 1))?;
            counts.insert(name.into(), json!(values.len()));
        }
        row["size"] = Value::Object(counts);
    }
    if let Some(key) = sort {
        rows.sort_by_key(|r| std::cmp::Reverse(r["size"][key].as_u64().unwrap()));
        listing["sort"] = json!(key);
    }
    listing["size_scope"] = json!("returned_owned_rows");
    listing["size_source"] = json!("conversationStats: distinct voting participants; all comment rows; all vote rows including revotes");
    Ok(())
}
