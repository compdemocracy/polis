//! Participant comments over the existing Node endpoint.
use crate::{participation, profiles, public_id, str_arg};
use clap::ArgMatches;
use polis_client::Client;
use polis_contracts::{Error, Result};
use serde_json::{json, Value};

fn invalid() -> Error {
    let mut e = Error::new(
        "invalid_comment_response",
        "The site returned an incompatible comment response.",
        "No retry was made. Inspect the conversation before submitting again.",
        7,
    );
    e.outcome = "unknown";
    e
}
fn safe_error(mut e: Error) -> Error {
    // Even a correlation header can contain the submitted text.
    e.upstream["request_id"] = Value::Null;
    if e.exit == 3 || e.exit == 4 {
        e.action = "Check this conversation's participation requirements; an invite may require polis join. No anonymous fallback or retry was made.";
    }
    e
}
pub fn submit(
    m: &ArgMatches,
    config: &profiles::Config,
    site: &str,
    timeout: u64,
) -> Result<Value> {
    let conversation = str_arg(m, "conversation");
    public_id(conversation)?;
    let text = str_arg(m, "text");
    if text.trim().is_empty() {
        return Err(Error::input("Provide nonempty comment text."));
    }
    let origin = config.url(site)?;
    let scope = profiles::participant_scope(origin, conversation)?;
    let _lock = profiles::credential_lock(site, &scope)?;
    let saved = profiles::participant_load(site, &scope)?;
    let data = Client::with_ca(
        origin,
        saved.as_ref().map(|s| s.token.clone()),
        timeout,
        config.auth(site)?.ca_file.as_deref(),
    )?
    .request(
        "POST",
        "/api/v3/comments",
        &[],
        Some(json!({"conversation_id":conversation,"txt":text})),
        true,
    )
    .map_err(safe_error)?;
    let issued = participation::issued_token(&data, true).map_err(|_| invalid())?;
    // Retain a valid identity even if the remaining receipt is incompatible.
    if let Some(token) = &issued {
        profiles::participant_store(site, &scope, token, saved.as_ref().and_then(|s| s.login_code.clone()))
            .map_err(|_| {
                let mut e = Error::new("participant_credentials_not_saved",
                    "The comment response arrived, but participant credentials could not be saved.",
                    "Do not submit again blindly. Check the owner-only credential directory and ask the site operator to recover access.", 7);
                e.outcome = "unknown";
                e
            })?;
    }
    let pid = data["currentPid"]
        .as_u64()
        .filter(|n| *n <= i32::MAX as u64)
        .ok_or_else(invalid)?;
    let tid = data["tid"]
        .as_u64()
        .filter(|n| *n <= i32::MAX as u64)
        .ok_or_else(invalid)?;
    if saved.is_none() && issued.is_none() {
        return Err(invalid());
    }
    // A receipt confirms submission, not moderation approval. Never pass through
    // raw fields that could contain submitted text or credentials.
    Ok(
        json!({"conversation_id":conversation,"state":"submitted","statement":tid,
        "participant_id":pid,"credentials_saved":true}),
    )
}
