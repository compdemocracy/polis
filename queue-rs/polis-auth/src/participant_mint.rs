//! Node-compatible participant signing over an already resolved identity.
//! No request parsing, admission, key loading, logging or serving caller.
use crate::{Pid, Uid, keys::Keys, xid_account};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::Serialize;

/// Identity values deliberately have no Debug implementation. Resolve admission
/// first; never replace an established anonymous session with a request XID.
pub struct Identity<'a> {
    uid: Uid,
    kind: Kind<'a>,
}
enum Kind<'a> {
    Anonymous,
    Xid(&'a str),
    StandardUser(&'a str),
}
#[derive(Debug, PartialEq, Eq)]
pub enum Error {
    MissingPrivateKey,
    MissingIdentifier,
    InvalidClaims,
    InvalidClock,
    Signing,
    PrivilegedAccount(xid_account::Class),
    AccountCheckFailed,
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::MissingPrivateKey => "participant signing key is unavailable",
            Self::MissingIdentifier => "participant identifier is required",
            Self::InvalidClaims => "participant claims are invalid",
            Self::InvalidClock => "participant clock is out of range",
            Self::Signing => "participant signing failed",
            Self::PrivilegedAccount(_) => "external identity is not a participant account",
            Self::AccountCheckFailed => "participant account check failed",
        })
    }
}
impl std::error::Error for Error {}
impl<'a> Identity<'a> {
    pub fn anonymous(uid: Uid) -> Self {
        Self {
            uid,
            kind: Kind::Anonymous,
        }
    }
    pub fn standard_user(uid: Uid, subject: &'a str) -> Result<Self, Error> {
        if subject.is_empty() {
            return Err(Error::MissingIdentifier);
        }
        Ok(Self {
            uid,
            kind: Kind::StandardUser(subject),
        })
    }
    /// Apply the existing primary-account check immediately before minting.
    /// The caller must not retain this value across a privilege change.
    pub fn xid(
        uid: Uid,
        xid: &'a str,
        check: &mut xid_account::Check<'_, impl xid_account::Lookup>,
    ) -> Result<Self, Error> {
        if xid.chars().all(crate::participant::request_xid_whitespace) {
            return Err(Error::MissingIdentifier);
        }
        check
            .require_participant(uid)
            .map_err(|refusal| match refusal {
                xid_account::Refusal::Privileged(class) => Error::PrivilegedAccount(class),
                xid_account::Refusal::CheckFailed => Error::AccountCheckFailed,
            })?;
        Ok(Self {
            uid,
            kind: Kind::Xid(xid),
        })
    }
}

// Struct field order is Node's object insertion order, including kind fields.
#[derive(Serialize)]
struct Claims<'a> {
    aud: &'a str,
    iss: &'a str,
    pid: u32,
    uid: i32,
    exp: u64,
    iat: u64,
    conversation_id: &'a str,
    sub: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    anonymous_participant: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    xid: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    xid_participant: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    oidc_sub: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    standard_user_participant: Option<bool>,
}

/// Seconds since the epoch, sampled twice just like Node's two Date.now calls
/// (expiration first, issuance second). The caller supplies its clock and the
/// issuer/audience configuration already used by its verifier. External IDs
/// containing only request whitespace are refused before the account check.
/// This does not establish membership or authorize a request.
pub fn mint(
    keys: &Keys,
    identity: Identity<'_>,
    conversation: &str,
    pid: Pid,
    issuer: &str,
    audience: &str,
    mut now: impl FnMut() -> u64,
) -> Result<String, Error> {
    if conversation.is_empty() || issuer.is_empty() || audience.is_empty() || identity.uid.0 <= 0 {
        return Err(Error::InvalidClaims);
    }
    let key = keys.private_key().ok_or(Error::MissingPrivateKey)?;
    let exp = now().checked_add(31_536_000).ok_or(Error::InvalidClock)?;
    let iat = now();
    if exp > 9_007_199_254_740_991 || iat > 9_007_199_254_740_991 {
        return Err(Error::InvalidClock);
    }
    let mut c = Claims {
        aud: audience,
        iss: issuer,
        pid: pid.0,
        uid: identity.uid.0,
        exp,
        iat,
        conversation_id: conversation,
        sub: String::new(),
        anonymous_participant: None,
        xid: None,
        xid_participant: None,
        oidc_sub: None,
        standard_user_participant: None,
    };
    match identity.kind {
        Kind::Anonymous => {
            c.sub = format!("anon:{}", identity.uid.0);
            c.anonymous_participant = Some(true);
        }
        Kind::Xid(xid) => {
            c.sub = format!("xid:{xid}");
            c.xid = Some(xid);
            c.xid_participant = Some(true);
        }
        Kind::StandardUser(subject) => {
            c.sub = format!("user:{subject}");
            c.oidc_sub = Some(subject);
            c.standard_user_participant = Some(true);
        }
    }
    // jsonwebtoken's Header serializes typ before alg. Node serializes alg first.
    let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"RS256","typ":"JWT"}"#);
    let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&c).map_err(|_| Error::Signing)?);
    let input = format!("{header}.{payload}");
    let signature =
        jsonwebtoken::crypto::sign(input.as_bytes(), key, jsonwebtoken::Algorithm::RS256)
            .map_err(|_| Error::Signing)?;
    Ok(format!("{input}.{signature}"))
}
