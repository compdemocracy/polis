//! Participation credentials are independent of the administrator's sign-in.
use crate::{profiles, public_id, str_arg};
use clap::ArgMatches;
use polis_client::Client;
use polis_contracts::{Error, Result};
use serde_json::{json, Value};

fn invalid(effect: bool) -> Error {
    let mut e = Error::new(
        "invalid_participation_response",
        "The site returned an incompatible participation response.",
        "No automatic retry was made. Check participation before accepting another invite.",
        if effect { 7 } else { 1 },
    );
    e.outcome = if effect { "unknown" } else { "rejected" };
    e
}
fn safe_error(mut e: Error) -> Error {
    // Correlation metadata may echo an invite/login secret submitted in the body.
    e.upstream["request_id"] = Value::Null;
    e
}
fn secret(value: &Value, effect: bool) -> Result<String> {
    let value = value.as_str().ok_or_else(|| invalid(effect))?;
    profiles::validate_token(value).map_err(|_| invalid(effect))?;
    Ok(value.to_owned())
}
pub(crate) fn issued_token(data: &Value, effect: bool) -> Result<Option<String>> {
    let Some(auth) = data.get("auth") else {
        return Ok(None);
    };
    if auth["token_type"] != "Bearer" {
        return Err(invalid(effect));
    }
    secret(&auth["token"], effect).map(Some)
}

pub fn join(m: &ArgMatches, config: &profiles::Config, site: &str, timeout: u64) -> Result<Value> {
    let conversation = str_arg(m, "conversation");
    public_id(conversation)?;
    let invite = m.get_one::<String>("invite");
    let login = m.get_one::<String>("login-code");
    for code in [invite, login].into_iter().flatten() {
        profiles::validate_token(code)
            .map_err(|_| Error::input("Use a nonempty invite or login code without whitespace."))?;
    }
    let origin = config.url(site)?;
    let scope = profiles::participant_scope(origin, conversation)?;
    // Fail unsafe/busy storage before consuming a one-time invitation. The lock
    // also serializes first actions and token replacements across CLI processes.
    let _lock = profiles::credential_lock(site, &scope)?;
    let saved = profiles::participant_load(site, &scope)?;
    let token = if login.is_some() {
        None
    } else {
        saved.as_ref().map(|s| s.token.clone())
    };
    let c = Client::with_ca(
        origin,
        token,
        timeout,
        config.auth(site)?.ca_file.as_deref(),
    )?;
    let effect = invite.is_some() || login.is_some();
    let data = if let Some(code) = invite {
        c.request(
            "POST",
            "/api/v3/treevite/acceptInvite",
            &[],
            Some(json!({"conversation_id":conversation,"invite_code":code})),
            true,
        )
    } else if let Some(code) = login {
        c.request(
            "POST",
            "/api/v3/treevite/login",
            &[],
            Some(json!({"conversation_id":conversation,"login_code":code})),
            true,
        )
    } else {
        c.request(
            "GET",
            "/api/v3/participationInit",
            &[
                ("conversation_id".into(), conversation.into()),
                ("includePCA".into(), "false".into()),
            ],
            None,
            false,
        )
    }
    .map_err(safe_error)?;
    let issued = issued_token(&data, effect)?;
    let enrolled = if effect {
        if data["status"] != "ok" || issued.is_none() {
            return Err(invalid(true));
        }
        true
    } else {
        if !data["conversation"].is_object()
            || data["conversation"]["conversation_id"] != conversation
            || data.get("ptpt").is_none()
        {
            return Err(invalid(false));
        }
        if data["ptpt"].is_null() {
            false
        } else {
            if data["ptpt"]["pid"].as_u64().is_none() || (issued.is_none() && saved.is_none()) {
                return Err(invalid(false));
            }
            true
        }
    };
    let login_code = if invite.is_some() {
        Some(secret(&data["login_code"], true)?)
    } else if let Some(code) = login {
        Some(code.clone())
    } else {
        saved.as_ref().and_then(|s| s.login_code.clone())
    };
    if let Some(token) = &issued {
        profiles::participant_store(site, &scope, token, login_code).map_err(|_| {
            let mut e = Error::new("participant_credentials_not_saved", "The response arrived, but participant credentials could not be saved.",
                "Do not blindly accept the invite again. Check the owner-only credentials directory and ask the site operator to recover access.", 7);
            e.outcome = "unknown";
            e
        })?;
    }
    // Do not pass through user, statement, vote, token, code, or error text.
    Ok(
        json!({"conversation_id":conversation,"state":if enrolled {"enrolled"} else {"ready_not_enrolled"},"enrolled":enrolled,"credentials_saved":issued.is_some() || saved.is_some()}),
    )
}
