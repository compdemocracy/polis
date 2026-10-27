//! `xid-account/1`: Node's external-identity account boundary.
//! Class names are observability labels; the HTTP refusal never reveals them.
use crate::schema::{literal, literal_u32, object, required, Schema};
use crate::wire::literal;
use serde::{Deserialize, Serialize};
pub const CONTRACT_VERSION: &str = "xid-account/1";
literal!(OwnerAccountError, "polis_err_xid_owner_account");
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Forbidden;
impl Serialize for Forbidden {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_u16(403)
    }
}
impl<'de> Deserialize<'de> for Forbidden {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        if u16::deserialize(deserializer)? == 403 {
            Ok(Self)
        } else {
            Err(serde::de::Error::custom("expected status=403"))
        }
    }
}
/// Field order is the insertion order in respondToXidAccountError.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Refusal {
    pub error: OwnerAccountError,
    pub message: OwnerAccountError,
    pub status: Forbidden,
}

pub struct Entry {
    pub account_class: &'static str,
    pub status: u16,
}
/// One pinned entry per class, in Node's precedence order, then admission.
pub const ENTRIES: &[Entry] = &[
    Entry {
        account_class: "admin",
        status: 403,
    },
    Entry {
        account_class: "conversation_owner",
        status: 403,
    },
    Entry {
        account_class: "owner_flag",
        status: 403,
    },
    Entry {
        account_class: "site_moderator",
        status: 403,
    },
    Entry {
        account_class: "oidc_mapped",
        status: 403,
    },
    Entry {
        account_class: "plain_participant",
        status: 200,
    },
];
pub fn document() -> Schema {
    object(vec![
        required("error", literal("polis_err_xid_owner_account")),
        required("message", literal("polis_err_xid_owner_account")),
        required("status", literal_u32(403)),
    ])
    .strict()
}
