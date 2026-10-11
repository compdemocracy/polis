use crate::{client, profiles, public_id, str_arg};
use clap::ArgMatches;
use polis_contracts::{Error, Result};
use serde_json::{json, Value};

const RECOVERY: &str = "Ask the site operator to inspect this account's stored translation preference before retrying. The update may have succeeded; participant status does not read this preference. No automatic retry was made.";

pub fn execute(
    m: &ArgMatches,
    config: &profiles::Config,
    site: &str,
    timeout: u64,
) -> Result<Value> {
    let conversation = str_arg(m, "conversation");
    public_id(conversation)?;
    let translations = str_arg(m, "translations") == "true";
    let receipt = client(config, site, timeout, true)?
        .set_participant_preferences(json!({
            "conversation_id": conversation,
            "show_translation_activated": translations,
        }))
        .map_err(|mut e| {
            if e.outcome == "unknown" {
                e.code = "participant_preference_outcome_unknown";
                e.message = "The site did not confirm the participant preference update.".into();
                e.action = RECOVERY;
            }
            e
        })?;
    // UPDATE without RETURNING yields [] even when zero rows matched.
    // Do not equate this acknowledgement with persistence or participant creation.
    if receipt.as_array().is_none_or(|rows| !rows.is_empty()) {
        let mut e = Error::new(
            "participant_preference_outcome_unknown",
            "The site returned an incompatible preference receipt.",
            RECOVERY,
            7,
        );
        e.outcome = "unknown";
        return Err(e);
    }
    Ok(json!({
        "state": "acknowledged",
        "conversation_id": conversation,
        "requested": {"show_translation_activated": translations},
        "receipt": receipt,
        "affected_rows": null,
        "persistence": "unverified",
        "note": "The site does not report affected rows or expose preference readback. A missing preference row also returns this acknowledgement; no participant was created or joined by this command. This sets a stored display preference and does not request translations."
    }))
}
