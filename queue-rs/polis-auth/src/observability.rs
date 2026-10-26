//! Process-local identity events. Labels are a closed set: no credential,
//! claim, database diagnostic, or request value can become a metric label.
//! Record successful writes only after commit, retries only when retried,
//! and refusals only when this process returns that refusal to the client.
use std::sync::atomic::{AtomicU64, Ordering};

macro_rules! events {
    ($($variant:ident => $label:literal),+ $(,)?) => {
        #[derive(Clone, Copy, Debug, PartialEq, Eq)]
        #[repr(usize)]
        pub enum Event { $($variant),+ }
        impl Event {
            pub const ALL: &[Self] = &[$(Self::$variant),+];
            pub const fn label(self) -> &'static str {
                match self { $(Self::$variant => $label),+ }
            }
        }
    };
}

events! {
    MintedAnonymous => "tokens_minted_anonymous",
    MintedXid => "tokens_minted_xid",
    MintedStandardUser => "tokens_minted_standard_user",
    MintedTreevite => "tokens_minted_treevite",
    ParticipantCreated => "participants_created",
    UserCreatedAnonymous => "users_created_anonymous",
    UserCreatedOidc => "users_created_oidc",
    XidUpserted => "xid_rows_upserted",
    RefusedXidRequired => "refusal_polis_err_xid_required",
    RefusedXidNotAllowed => "refusal_polis_err_xid_not_allowed",
    RefusedTreeviteAuthRequired => "refusal_polis_err_treevite_auth_required",
    RefusedDomain => "refusal_polis_err_domain",
    RefusedOidcTooManyRequests => "refusal_too_many_requests",
    RefusedOidcInvalidUserData => "refusal_invalid_user_data",
    RefusedOidcAuthenticationConflict => "refusal_authentication_conflict",
    RefusedOidcUserCreationFailed => "refusal_user_creation_failed",
    RefusedOidcAuthenticationError => "refusal_authentication_error",
    RefusedNoToken => "refusal_no_authentication_token_found",
    RefusedTokenFormat => "refusal_invalid_token_format",
    RefusedTokenAuthentication => "refusal_invalid_authentication_token",
    UniqueViolationRetry => "retries_23505",
    LockTimeout => "lock_timeouts_55P03",
    OidcJwksMiss => "oidc_jwks_misses",
    SigningFailure => "signing_failures",
    HandoffCredentialShape => "handoff_credential_shape",
    HandoffConversationScope => "handoff_conversation_scope",
    HandoffVerifierUnavailable => "handoff_verifier_unavailable",
    HandoffParticipantVerification => "handoff_participant_verification",
    HandoffParticipantMembership => "handoff_participant_membership",
    HandoffUnsupportedKind => "handoff_unsupported_kind",
    HandoffOidcVerification => "handoff_oidc_verification",
    HandoffOidcProfile => "handoff_oidc_profile",
    HandoffOidcMapping => "handoff_oidc_mapping",
    HandoffConversationMissing => "handoff_conversation_missing",
    HandoffDatabase => "handoff_database",
}

pub struct Counters {
    values: [AtomicU64; Event::ALL.len()],
}

impl Default for Counters {
    fn default() -> Self {
        Self::new()
    }
}

impl Counters {
    pub const fn new() -> Self {
        Self {
            values: [const { AtomicU64::new(0) }; Event::ALL.len()],
        }
    }

    pub fn record(&self, event: Event) {
        // Saturate instead of wrapping a long-lived process back to zero.
        let _ = self.values[event as usize].fetch_update(
            Ordering::Relaxed,
            Ordering::Relaxed,
            |value| Some(value.saturating_add(1)),
        );
    }

    /// Each counter is monotonic; this is not a transaction across counters.
    pub fn snapshot(&self) -> impl Iterator<Item = (&'static str, u64)> + '_ {
        Event::ALL.iter().map(|&event| {
            (
                event.label(),
                self.values[event as usize].load(Ordering::Relaxed),
            )
        })
    }
}

pub static PROCESS: Counters = Counters::new();

/// A read-only identity decision handed back to the caller. This does not
/// assert that Node refused the request, nor that its response was delivered.
pub fn handoff<T>(event: Event) -> Option<T> {
    PROCESS.handoff(event)
}

impl Counters {
    pub fn handoff<T>(&self, event: Event) -> Option<T> {
        self.record(event);
        None
    }
}

/// Unverified routing hints, never evidence of identity or membership.
pub fn credential_hints(raw: &str) -> Option<serde_json::Value> {
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    let token = raw.strip_prefix("Bearer ")?;
    if token.is_empty() || token.len() > 16384 {
        return None;
    }
    let bytes = URL_SAFE_NO_PAD.decode(token.split('.').nth(1)?).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Shared reason precedence for credentials that are handed back. These hints
/// only label a failure; they never admit a request or replace verification.
/// Participant shapes: malformed fields, then scope. Other shapes: unsupported
/// kind. Verification failures without one of these hints keep their verifier's
/// reason. A mixed participant/XID shape follows participant verification.
pub fn credential_handoff(
    payload: &serde_json::Value,
    conversation: Option<&str>,
) -> Option<Event> {
    use serde_json::Value;
    if payload.get("nbf").is_some_and(|v| v.as_u64().is_none()) {
        return Some(Event::HandoffCredentialShape);
    }
    if payload.get("anonymous_participant").is_some()
        || payload.get("standard_user_participant").is_some()
    {
        let Some(cid) = payload.get("conversation_id").and_then(Value::as_str) else {
            return Some(Event::HandoffCredentialShape);
        };
        if conversation.is_some_and(|requested| requested != cid) {
            return Some(Event::HandoffConversationScope);
        }
    } else if ["xid", "xid_participant", "oidc_sub"]
        .iter()
        .any(|k| payload.get(k).is_some())
    {
        return Some(Event::HandoffUnsupportedKind);
    }
    None
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn labels_are_unique_and_every_event_has_an_independent_zero_counter() {
        let counters = Counters::new();
        let initial: std::collections::BTreeMap<_, _> = counters.snapshot().collect();
        assert_eq!(initial.len(), Event::ALL.len());
        assert!(initial.values().all(|&n| n == 0));
        for (i, &event) in Event::ALL.iter().enumerate() {
            for _ in 0..=i {
                counters.record(event);
            }
        }
        for (i, (_, value)) in counters.snapshot().enumerate() {
            assert_eq!(value, (i + 1) as u64);
        }
    }

    #[test]
    fn concurrent_events_are_not_lost_and_instances_are_independent() {
        let counters = Counters::new();
        std::thread::scope(|scope| {
            for _ in 0..8 {
                scope.spawn(|| {
                    for _ in 0..1000 {
                        counters.record(Event::OidcJwksMiss);
                    }
                });
            }
        });
        assert_eq!(
            counters
                .snapshot()
                .find(|(k, _)| *k == "oidc_jwks_misses")
                .unwrap()
                .1,
            8000
        );
        assert!(Counters::new().snapshot().all(|(_, n)| n == 0));
    }

    #[test]
    fn counters_do_not_wrap() {
        let counters = Counters::new();
        counters.values[Event::SigningFailure as usize].store(u64::MAX, Ordering::Relaxed);
        counters.record(Event::SigningFailure);
        assert_eq!(
            counters.values[Event::SigningFailure as usize].load(Ordering::Relaxed),
            u64::MAX
        );
    }
}
