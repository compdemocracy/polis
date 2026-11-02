//! The status endpoint reads memory only; partial-state SQL probes are run
//! separately by operators and never acquire a serving-pool connection.
use crate::js::{Js, Obj};
use polis_auth::observability::{Counters, Event};

fn refusal(status: u16, error: &str) -> Option<Event> {
    Some(match (status, error) {
        (403, "polis_err_xid_required") => Event::RefusedXidRequired,
        (403, "polis_err_xid_not_allowed") => Event::RefusedXidNotAllowed,
        (401, "polis_err_treevite_auth_required") => Event::RefusedTreeviteAuthRequired,
        (403, "polis_err_domain") => Event::RefusedDomain,
        (429, "too_many_requests") => Event::RefusedOidcTooManyRequests,
        (400, "invalid_user_data") => Event::RefusedOidcInvalidUserData,
        (429, "authentication_conflict") => Event::RefusedOidcAuthenticationConflict,
        (500, "user_creation_failed") => Event::RefusedOidcUserCreationFailed,
        (500, "authentication_error") => Event::RefusedOidcAuthenticationError,
        (401, "No authentication token found") => Event::RefusedNoToken,
        (401, "Invalid token format") => Event::RefusedTokenFormat,
        (401, "Invalid authentication token") => Event::RefusedTokenAuthentication,
        _ => return None,
    })
}

pub fn observe_json(counters: &Counters, status: u16, value: &Js) {
    if status < 400 {
        return;
    }
    if let Js::Obj(body) = value
        && let Some(Js::Str(error)) = body.get("error")
        && let Some(event) = refusal(status, error)
    {
        counters.record(event);
    }
}

pub fn observe_json_text(counters: &Counters, status: u16, body: &str) {
    if !matches!(status, 400 | 401 | 403 | 429 | 500) {
        return;
    }
    #[derive(serde::Deserialize)]
    struct ErrorBody<'a> {
        error: &'a str,
    }
    if let Ok(value) = serde_json::from_str::<ErrorBody<'_>>(body)
        && let Some(event) = refusal(status, value.error)
    {
        counters.record(event);
    }
}

pub fn snapshot(counters: &Counters) -> Js {
    let mut body = Obj::new();
    for (label, count) in counters.snapshot() {
        // Match the other status counters' JSON number representation.
        body.set(label, Js::Num(count as f64));
    }
    Js::Obj(body)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn refusals_require_the_exact_status_and_code_and_ignore_details() {
        let counters = Counters::new();
        for (status, error, event) in [
            (403, "polis_err_xid_required", Event::RefusedXidRequired),
            (
                403,
                "polis_err_xid_not_allowed",
                Event::RefusedXidNotAllowed,
            ),
            (
                401,
                "polis_err_treevite_auth_required",
                Event::RefusedTreeviteAuthRequired,
            ),
            (403, "polis_err_domain", Event::RefusedDomain),
            (429, "too_many_requests", Event::RefusedOidcTooManyRequests),
            (400, "invalid_user_data", Event::RefusedOidcInvalidUserData),
            (
                429,
                "authentication_conflict",
                Event::RefusedOidcAuthenticationConflict,
            ),
            (
                500,
                "user_creation_failed",
                Event::RefusedOidcUserCreationFailed,
            ),
            (
                500,
                "authentication_error",
                Event::RefusedOidcAuthenticationError,
            ),
            (401, "No authentication token found", Event::RefusedNoToken),
            (401, "Invalid token format", Event::RefusedTokenFormat),
            (
                401,
                "Invalid authentication token",
                Event::RefusedTokenAuthentication,
            ),
        ] {
            let body = serde_json::json!({"error": error, "details": "private-value"}).to_string();
            observe_json_text(&counters, status, &body);
            observe_json_text(&counters, 200, &body);
            observe_json(&counters, status, &crate::js::parse(&body).unwrap());
            observe_json(&counters, 200, &crate::js::parse(&body).unwrap());
            assert_eq!(
                counters
                    .snapshot()
                    .find(|(k, _)| *k == event.label())
                    .unwrap()
                    .1,
                2
            );
        }
        let before: Vec<_> = counters.snapshot().collect();
        for body in [
            "invalid",
            "{}",
            "null",
            r#"{"error":42}"#,
            r#"{"error":"private-value"}"#,
        ] {
            observe_json_text(&counters, 401, body);
        }
        assert_eq!(before, counters.snapshot().collect::<Vec<_>>());
        assert!(!crate::js::stringify(&snapshot(&counters)).contains("private-value"));
    }

    #[test]
    fn status_contains_all_counters_including_inactive_operations() {
        let counters = Counters::new();
        counters.record(Event::OidcJwksMiss);
        counters.record(Event::HandoffParticipantVerification);
        let encoded = crate::js::stringify(&snapshot(&counters));
        let value: serde_json::Value = serde_json::from_str(&encoded).unwrap();
        assert_eq!(value.as_object().unwrap().len(), Event::ALL.len());
        for &event in Event::ALL {
            assert_eq!(
                value[event.label()],
                u64::from(matches!(
                    event,
                    Event::OidcJwksMiss | Event::HandoffParticipantVerification
                ))
            );
        }
        // Snapshot reads neither reset nor increment any event.
        assert_eq!(encoded, crate::js::stringify(&snapshot(&counters)));
    }
}
