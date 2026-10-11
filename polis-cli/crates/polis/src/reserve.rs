use crate::{client, profiles};
use polis_contracts::{Error, Result};
use serde_json::{json, Value};

const RECOVERY: &str = "Ask the site operator to check reservation compatibility and inspect unassigned conversation IDs before retrying. The legacy route requires a conversation row at zid=0, which a fresh database lacks. An ID may already have been allocated; no reservation lookup or idempotency contract exists. No automatic retry was made.";

pub fn execute(config: &profiles::Config, site: &str, timeout: u64) -> Result<Value> {
    let receipt = client(config, site, timeout, true)?
        .reserve_conversation()
        .map_err(|mut e| {
            if e.outcome == "unknown" {
                e.code = "conversation_reservation_outcome_unknown";
                e.message = "The site did not confirm conversation ID allocation.".into();
                e.action = RECOVERY;
            }
            e
        })?;
    let id = receipt.get("conversation_id").and_then(Value::as_str);
    // Current non-short generator emits exactly ten lowercase ASCII letters/digits,
    // beginning with 2..9. Refuse incompatible success without claiming no allocation.
    if !id.is_some_and(|id| {
        id.len() == 10
            && matches!(id.as_bytes()[0], b'2'..=b'9')
            && id
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
    }) {
        let mut e = Error::new(
            "conversation_reservation_outcome_unknown",
            "The site returned an incompatible reservation receipt.",
            RECOVERY,
            7,
        );
        e.outcome = "unknown";
        return Err(e);
    }
    Ok(json!({
        "state": "allocated",
        "conversation_id": id,
        "receipt": receipt,
        "conversation_created": false,
        "owner_bound": false,
        "note": "This allocates an unassigned ID only. It does not establish ownership or exclusive access. Preserve the receipt for a later explicit API creation request; the CLI create command does not yet accept a reserved ID."
    }))
}
