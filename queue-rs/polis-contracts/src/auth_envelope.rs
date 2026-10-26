//! `auth-envelope/1`: current `attachAuthToken()` and `ensureParticipant` wire data.
//! This entry describes emitted JSON, not token verification or admission.
use crate::schema::{literal, literal_u32, object, required, string, Schema};
use crate::wire::{literal, Json};
use serde::{Deserialize, Serialize};

pub const CONTRACT_VERSION: &str = "auth-envelope/1";
pub const EXPIRATION_SECONDS: u32 = 365 * 24 * 60 * 60;
literal!(Bearer, "Bearer");

/// The value of `auth`, in the insertion order used by ensure-participant.ts.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Auth {
    pub token: String,
    pub token_type: Bearer,
    pub expires_in: Expiration,
}

/// Node's fixed lifetime. This unit type cannot encode a different number.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Expiration;

impl Serialize for Expiration {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_u32(EXPIRATION_SECONDS)
    }
}

impl<'de> Deserialize<'de> for Expiration {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let seconds = u32::deserialize(deserializer)?;
        if seconds == EXPIRATION_SECONDS {
            Ok(Self)
        } else {
            Err(serde::de::Error::custom("expected expires_in=31536000"))
        }
    }
}

/// The default middleware wraps `res.json` only, after participant middleware.
/// A present token is added to every non-null, non-array object whose `auth`
/// is JavaScript-falsy. There is NO status check: error objects qualify too.
/// Truthy `auth` values (even `{}` and `[]`) survive unchanged. Existing falsy
/// `auth` is replaced in its original position; a new key is appended. Object
/// spread copies the body, and JavaScript enumerates integer keys first.
/// This predicate deliberately has no status argument. Conditional/WithOptions
/// middleware are different contracts, as are direct `send`/`end` responses.
pub fn should_attach(token_present: bool, body: &Json) -> bool {
    if !token_present {
        return false;
    }
    let Json::Object(fields) = body else {
        return false;
    };
    match fields.get("auth") {
        None | Some(Json::Null) | Some(Json::Bool(false)) => true,
        Some(Json::Number(n)) => n.get() == 0.0,
        Some(Json::String(s)) => s.is_empty(),
        _ => false,
    }
}

pub fn document() -> Schema {
    object(vec![
        required("token", string()),
        required("token_type", literal("Bearer")),
        required("expires_in", literal_u32(EXPIRATION_SECONDS)),
    ])
    .strict()
    .description("Value of auth. ensureParticipant emits expires_in=31536000 seconds. The default attachAuthToken adds it to object JSON bodies with no truthy auth, regardless of HTTP status, including error bodies; arrays, null and primitives are unchanged. A new auth key is last; replacing a falsy auth retains its position. This document describes the value, not the varying surrounding body.")
    .document(CONTRACT_VERSION, "Generated from polis-contracts auth_envelope::document; POLIS_CONTRACTS_WRITE_SCHEMAS=1 cargo test --locked -p polis-contracts --test identity_contracts")
}
