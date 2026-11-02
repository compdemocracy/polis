//! External identities may authenticate participant accounts only.
//! Use a bounded primary connection: privilege changes must not lag a replica.
use crate::{
    Uid, Unavailable,
    observability::{Counters, Event},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Class {
    Admin,
    ConversationOwner,
    OwnerFlag,
    SiteModerator,
    OidcMapped,
}
impl Class {
    pub const fn label(self) -> &'static str {
        match self {
            Self::Admin => "admin",
            Self::ConversationOwner => "conversation_owner",
            Self::OwnerFlag => "owner_flag",
            Self::SiteModerator => "site_moderator",
            Self::OidcMapped => "oidc_mapped",
        }
    }
    const fn event(self) -> Event {
        match self {
            Self::Admin => Event::RefusedXidAdmin,
            Self::ConversationOwner => Event::RefusedXidConversationOwner,
            Self::OwnerFlag => Event::RefusedXidOwnerFlag,
            Self::SiteModerator => Event::RefusedXidSiteModerator,
            Self::OidcMapped => Event::RefusedXidOidcMapped,
        }
    }
}
#[derive(Default, Clone, Copy)]
pub struct Account {
    pub owns_conversation: bool,
    pub is_owner: bool,
    pub site_moderator: bool,
    pub oidc_mapped: bool,
}
/// Node's classifyXidAccount precedence, including overlapping privileges.
pub fn classify(account: Account, admin: bool) -> Option<Class> {
    if admin {
        Some(Class::Admin)
    } else if account.owns_conversation {
        Some(Class::ConversationOwner)
    } else if account.is_owner {
        Some(Class::OwnerFlag)
    } else if account.site_moderator {
        Some(Class::SiteModerator)
    } else if account.oidc_mapped {
        Some(Class::OidcMapped)
    } else {
        None
    }
}
pub trait Lookup {
    fn account(&mut self, uid: Uid) -> Result<Option<Account>, Unavailable>;
}
impl<F: FnMut(Uid) -> Result<Option<Account>, Unavailable>> Lookup for F {
    fn account(&mut self, uid: Uid) -> Result<Option<Account>, Unavailable> {
        self(uid)
    }
}
pub const SQL: &str = "SELECT u.is_owner,
    EXISTS (SELECT 1 FROM conversations c WHERE c.owner = u.uid) AS owns_conversation,
    EXISTS (SELECT 1 FROM users owner_user
      JOIN conversations c ON c.owner = owner_user.uid
      WHERE owner_user.site_id = u.site_id) AS site_moderator,
    EXISTS (SELECT 1 FROM oidc_user_mappings m WHERE m.uid = u.uid) AS oidc_mapped
    FROM users u WHERE u.uid = $1";
impl<T: postgres::GenericClient> Lookup for crate::PostgresLookup<'_, T> {
    fn account(&mut self, uid: Uid) -> Result<Option<Account>, Unavailable> {
        let rows = self.0.query(SQL, &[&uid.0]).map_err(|_| Unavailable)?;
        let Some(row) = rows.first() else {
            return Ok(None);
        };
        Ok(Some(Account {
            is_owner: row
                .try_get::<_, Option<bool>>("is_owner")
                .map_err(|_| Unavailable)?
                .unwrap_or(false),
            owns_conversation: row.try_get("owns_conversation").map_err(|_| Unavailable)?,
            site_moderator: row.try_get("site_moderator").map_err(|_| Unavailable)?,
            oidc_mapped: row.try_get("oidc_mapped").map_err(|_| Unavailable)?,
        }))
    }
}
/// Trusted ADMIN_UIDS configuration; never populate it from token claims.
pub struct Check<'a, L> {
    pub db: &'a mut L,
    pub admin_uids: &'a [Uid],
}
impl<L: Lookup> Check<'_, L> {
    pub fn xid_account_class(&mut self, uid: Uid) -> Result<Option<Class>, Unavailable> {
        if self.admin_uids.contains(&uid) {
            return Ok(Some(Class::Admin));
        }
        // Node preserves existing handling for a missing account.
        Ok(self
            .db
            .account(uid)?
            .and_then(|account| classify(account, false)))
    }
    /// Apply before using a resolved bare XID, enrolling it or minting/reissuing
    /// its token. Verification also checks the signed UID before request scoping.
    pub fn require_participant(&mut self, uid: Uid) -> Result<(), Refusal> {
        match self.xid_account_class(uid) {
            Ok(None) => Ok(()),
            Ok(Some(class)) => Err(Refusal::Privileged(class)),
            Err(_) => Err(Refusal::CheckFailed),
        }
    }
}
#[derive(Debug, PartialEq, Eq)]
pub enum Refusal {
    Privileged(Class),
    CheckFailed,
}
#[derive(Debug, PartialEq, Eq)]
pub struct Response {
    pub status: u16,
    pub body: &'static str,
}
impl Refusal {
    pub fn status(&self) -> u16 {
        if matches!(self, Self::CheckFailed) {
            500
        } else {
            403
        }
    }
    pub fn body(&self) -> &'static str {
        match self {
            Self::Privileged(_) => {
                r#"{"error":"polis_err_xid_owner_account","message":"polis_err_xid_owner_account","status":403}"#
            }
            Self::CheckFailed => {
                r#"{"error":"polis_err_participant_creation","message":"polis_err_participant_creation","status":500}"#
            }
        }
    }
    /// Consume once at the HTTP boundary. Checks alone do not count responses.
    /// The generic JSON observer must not count this refusal again: its class
    /// is intentionally absent from the wire body.
    pub fn into_response(self, counters: &Counters) -> Response {
        self.respond(counters, |line| eprintln!("{line}"))
    }

    fn respond(self, counters: &Counters, log: impl FnOnce(&str)) -> Response {
        let (class, event, code) = match self {
            Self::Privileged(class) => {
                (class.label(), class.event(), "polis_err_xid_owner_account")
            }
            Self::CheckFailed => (
                "check_failed",
                Event::RefusedXidCheckFailed,
                "polis_err_participant_creation",
            ),
        };
        counters.record(event);
        log(&format!(
            r#"{{"level":"warn","message":"{code}","account_class":"{class}"}}"#
        ));
        Response {
            status: self.status(),
            body: self.body(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn each_response_emits_one_class_only_warning_and_one_counter() {
        for refusal in [
            Refusal::Privileged(Class::Admin),
            Refusal::Privileged(Class::ConversationOwner),
            Refusal::Privileged(Class::OwnerFlag),
            Refusal::Privileged(Class::SiteModerator),
            Refusal::Privileged(Class::OidcMapped),
            Refusal::CheckFailed,
        ] {
            let class = match refusal {
                Refusal::Privileged(c) => c.label(),
                Refusal::CheckFailed => "check_failed",
            };
            let counters = Counters::new();
            let mut lines = Vec::new();
            let response = refusal.respond(&counters, |line| lines.push(line.to_owned()));
            assert_eq!(lines.len(), 1);
            let expected_code = if response.status == 403 {
                "polis_err_xid_owner_account"
            } else {
                "polis_err_participant_creation"
            };
            assert_eq!(
                lines[0],
                format!(
                    r#"{{"level":"warn","message":"{expected_code}","account_class":"{class}"}}"#
                )
            );
            assert_eq!(counters.snapshot().map(|(_, n)| n).sum::<u64>(), 1);
        }
    }
}
