//! `participant-token/1`: the payloads minted by issueParticipantJWT in
//! server/src/auth/jwt-utils.ts. This is a wire description, not a verifier.
//! Audience and issuer come from configuration. exp and iat are separate
//! floor(Date.now()/1000) reads: do not require exp-iat to be exactly one year.
//! The signing header is {alg:"RS256",typ:"JWT"}; there is no kid today.
//! No kind discriminator is added to the JSON beyond the existing true flag.
use crate::schema::{integer, literal, literal_bool, object, required, string, union, Schema};
use crate::wire::literal;
use serde::{Deserialize, Serialize};

pub const CONTRACT_VERSION: &str = "participant-token/1";
// Sub is a string on the wire: anon:<uid>, xid:<xid>, user:<oidc_sub>.
// Those relationships describe minting; deserialization is not verification.
literal!(Rs256, "RS256");
literal!(Jwt, "JWT");

/// A kind flag that is always the JSON boolean true in a minted token.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct True;
impl Serialize for True {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_bool(true)
    }
}
impl<'de> Deserialize<'de> for True {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        if bool::deserialize(deserializer)? {
            Ok(Self)
        } else {
            Err(serde::de::Error::custom(
                "participant kind flag must be true",
            ))
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Header {
    pub alg: Rs256,
    pub typ: Jwt,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Anonymous {
    pub aud: String,
    pub iss: String,
    pub pid: i32,
    pub uid: i32,
    pub exp: u64,
    pub iat: u64,
    pub conversation_id: String,
    pub sub: String,
    pub anonymous_participant: True,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Xid {
    pub aud: String,
    pub iss: String,
    pub pid: i32,
    pub uid: i32,
    pub exp: u64,
    pub iat: u64,
    pub conversation_id: String,
    pub sub: String,
    pub xid: String,
    pub xid_participant: True,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StandardUser {
    pub aud: String,
    pub iss: String,
    pub pid: i32,
    pub uid: i32,
    pub exp: u64,
    pub iat: u64,
    pub conversation_id: String,
    pub sub: String,
    pub oidc_sub: String,
    pub standard_user_participant: True,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Claims {
    Anonymous(Anonymous),
    Xid(Xid),
    StandardUser(StandardUser),
}

pub fn header_document() -> Schema {
    object(vec![
        required("alg", literal("RS256")),
        required("typ", literal("JWT")),
    ])
    .strict()
    .document("participant-token-header/1", SOURCE)
}
const SOURCE: &str = "Generated from polis-contracts participant_token; POLIS_CONTRACTS_WRITE_SCHEMAS=1 cargo test --locked -p polis-contracts --test identity_contracts";

pub fn document() -> Schema {
    let branch = |flag, identifier| {
        let mut fields = vec![
            required("aud", string()),
            required("iss", string()),
            required("pid", integer()),
            required("uid", integer()),
            required("exp", integer().minimum(0)),
            required("iat", integer().minimum(0)),
            required("conversation_id", string()),
            required("sub", string()),
        ];
        if let Some(identifier) = identifier {
            fields.push(required(identifier, string()));
        }
        fields.push(required(flag, literal_bool(true)));
        object(fields).strict()
    };
    union(vec![branch("anonymous_participant", None), branch("xid_participant", Some("xid")), branch("standard_user_participant", Some("oidc_sub"))])
        .description("Payloads currently minted by issueParticipantJWT: sub=anon:<uid>, xid:<xid>, or user:<oidc_sub>. Audience and issuer are configured strings; exp is the current whole second plus 31536000, iat is a separate clock read. XID and OIDC identifiers must be nonempty at minting. No header or signature verification is performed by these types.")
        .document(CONTRACT_VERSION, SOURCE)
}
