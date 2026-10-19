use crate::{client, profiles, public_id, str_arg};
use clap::ArgMatches;
use polis_contracts::{setup::ExternalIdentityMode, Error, Result};
use serde_json::{json, Map, Value};

// app.ts applies false defaults even to omitted fields on PUT conversations.
// Preserve those fields explicitly; do not guess when the server omits them.
const PRESERVE: &[&str] = &[
    "is_draft",
    "is_data_open",
    "owner_sees_participation_stats",
    "treevite_enabled",
    "topics_enabled",
];
fn unknown() -> Error {
    let mut e = Error::new("outcome_unknown", "The edit replied, but the requested settings could not be confirmed.", "Run polis conversation view <id> for this site before retrying. Concurrent edits are not protected by this server.", 7);
    e.outcome = "unknown";
    e
}
pub fn execute(
    path: &str,
    m: &ArgMatches,
    config: &profiles::Config,
    site: &str,
    timeout: u64,
) -> Result<Value> {
    if path == "account view" {
        return client(config, site, timeout, true)?.request(
            "GET",
            "/api/v3/users",
            &[],
            None,
            false,
        );
    }
    let id = str_arg(
        m,
        if path == "report create" {
            "conversation"
        } else {
            "id"
        },
    );
    public_id(id)?;
    if path == "conversation share" {
        let base = polis_client::base_url(config.url(site)?)?;
        let participant = base
            .join(id)
            .map_err(|_| Error::input("Invalid conversation URL."))?;
        let admin = base
            .join(&format!("m/{id}/share"))
            .map_err(|_| Error::input("Invalid share URL."))?;
        return Ok(
            json!({"conversation_id":id,"participation_url":participant.as_str(),"admin_share_url":admin.as_str(),"verified":false,"note":"Links only; no request, invitation, permission change, browser action or message sent. The site still controls participation access."}),
        );
    }
    let mut changes = Map::new();
    if path == "conversation edit" {
        for (arg, field, limit) in [
            ("topic", "topic", 1000),
            ("description", "description", 50000),
        ] {
            if let Some(value) = m.get_one::<String>(arg) {
                if value.encode_utf16().count() > limit
                    || (arg == "topic" && value.trim().is_empty())
                    || value.contains('\0')
                    || value.starts_with(' ')
                    || value.ends_with(' ')
                {
                    return Err(Error::input(format!("--{arg} must fit {limit} UTF-16 units, contain no NUL or leading/trailing ASCII spaces (the server trims them), and topic must not be blank.")));
                }
                changes.insert(field.into(), json!(value));
            }
        }
        for (arg, field) in [
            ("draft", "is_draft"),
            ("data-open", "is_data_open"),
            ("strict-moderation", "strict_moderation"),
            ("invite-only", "treevite_enabled"),
        ] {
            if let Some(value) = m.get_one::<String>(arg) {
                changes.insert(field.into(), json!(value == "true"));
            }
        }
        if let Some(name) = m.get_one::<String>("external-id") {
            // Both Node flags come from the one typed mapping, never set apart.
            let mode = ExternalIdentityMode::from_name(name).ok_or_else(|| {
                Error::input("--external-id must be optional, required or allowlist.")
            })?;
            if let Value::Object(flags) = mode.node_flags() {
                changes.extend(flags);
            }
        }
        if changes.is_empty() {
            return Err(Error::input("Choose at least one setting: --topic, --description, --draft, --data-open, --strict-moderation, --invite-only or --external-id. Use --description '' to clear it."));
        }
    }
    let c = client(config, site, timeout, true)?;
    let query = vec![("conversation_id".into(), id.into())];
    if path == "conversation stats" {
        let mut query = query;
        if let Some(until) = m.get_one::<u64>("until") {
            query.push(("until".into(), until.to_string()));
        }
        return c.request("GET", "/api/v3/conversationStats", &query, None, false);
    }
    if path == "report create" {
        let receipt = c.request(
            "POST",
            "/api/v3/reports",
            &[],
            Some(json!({"conversation_id":id,"mod_level":-2})),
            true,
        )?;
        // Current servers return the inserted report's public ID; older ones
        // reply {}. A list diff is not proof of which report this request
        // created when another writer is running, so without an ID none is taken.
        let report_id = receipt["report_id"]
            .as_str()
            .filter(|r| public_id(r).is_ok())
            .map(str::to_owned);
        let readback = c.request("GET", "/api/v3/reports", &query, None, false);
        let (reports, readback_state) = match readback {
            Ok(rows) if rows.is_array() => (rows, "observed"),
            _ => (Value::Null, "unavailable"),
        };
        let note = if report_id.is_some() {
            "Creation replied with the created report's ID. Listed reports are a readback observation. Do not repeat creation; repeated creation makes another report. This creates report configuration only, not math, exports or Delphi work."
        } else {
            "Creation replied successfully, but the server returns no created ID or idempotency key. Listed reports are not attributed to this request. Do not repeat creation to recover an ID; use report list. This creates report configuration only, not math, exports or Delphi work."
        };
        return Ok(
            json!({"state":"accepted","conversation_id":id,"report_id":report_id,"receipt":receipt,"reports":reports,"readback_state":readback_state,"note":note}),
        );
    }
    let before = c.request("GET", "/api/v3/conversations", &query, None, false)?;
    if before["is_mod"].as_bool() != Some(true) {
        return Err(Error::new(
            "forbidden",
            "The conversation view did not confirm moderator access.",
            "Sign in with a moderator account for this conversation and selected site.",
            4,
        ));
    }
    let mut body = changes.clone();
    for field in PRESERVE {
        let value = before[*field].as_bool().ok_or_else(|| Error::new("capability_unavailable", format!("The server did not return a boolean {field}; editing could reset a setting."), "Use the admin settings page or ask the operator to expose complete moderator settings; no edit was sent.", 8))?;
        body.entry((*field).to_owned()).or_insert(json!(value));
    }
    body.insert("conversation_id".into(), json!(id));
    let receipt = c.request(
        "PUT",
        "/api/v3/conversations",
        &[],
        Some(Value::Object(body.clone())),
        true,
    )?;
    let after = c
        .request("GET", "/api/v3/conversations", &query, None, false)
        .map_err(|_| unknown())?;
    if body
        .iter()
        .any(|(key, value)| key != "conversation_id" && after.get(key) != Some(value))
    {
        return Err(unknown());
    }
    Ok(
        json!({"state":"updated","conversation_id":id,"changes":changes,"confirmed_by":"GET /api/v3/conversations","receipt":receipt,"concurrency":"No compare-and-set support; coordinate simultaneous moderator edits."}),
    )
}
