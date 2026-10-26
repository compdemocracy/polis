//! Authority decisions for already verified identities. This crate does not
//! issue or log tokens or install HTTP routes. Participant verification and
//! existing-membership reads are in the participant module.
//! Staged transactional admission has no serving callers.
//!
//! Owner and moderator are distinct policies, not an ordered privilege ladder.
//! Node's moderator rule uses site equality (SQL NULL never equals NULL) and an
//! explicit administrator UID bypass. Its zinvite owner rule uses only owner
//! equality, without that bypass. Evaluate the policy the route actually uses.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Uid(pub i32);
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Pid(pub u32);
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Zid(pub i32);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TokenKind {
    AnonymousParticipant,
    XidParticipant,
}

/// Construct only after the HTTP authentication layer verifies a credential.
/// Participant claims do not prove membership in a different conversation.
/// No Debug implementation: identity/claim values are not diagnostic output.
#[derive(Clone)]
pub enum Principal {
    Anonymous,
    Participant {
        uid: Uid,
        pid: Option<Pid>,
        conversation: String,
        kind: TokenKind,
    },
    User {
        uid: Uid,
        oidc_sub: Option<String>,
    },
}
impl Principal {
    pub fn uid(&self) -> Option<Uid> {
        match self {
            Self::Anonymous => None,
            Self::Participant { uid, .. } | Self::User { uid, .. } => Some(*uid),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Level {
    Owner,
    Moderator,
}

/// Evidence of the specific policy evaluated, not a reusable privilege rank.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Authority {
    Owner,
    SiteModerator,
    None,
}

/// A database failure is not evidence of either permission or a 403 denial.
/// The HTTP caller chooses its closed service-unavailable response.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Unavailable;

/// One bounded read on the caller's dedicated read pool. Implementations must
/// not accept site, ownership or administrator claims from request parameters.
pub trait AuthorityLookup {
    fn permits(&mut self, zid: Zid, uid: Uid, policy: Level) -> Result<bool, Unavailable>;
}

impl Authority {
    /// Synchronous like the workspace's Postgres boundary. An async HTTP caller
    /// runs this inside its bounded blocking pool; no pool is created here.
    /// `admin_uids` is trusted site configuration, never a JWT claim.
    pub fn for_conversation(
        db: &mut impl AuthorityLookup,
        zid: Zid,
        principal: &Principal,
        policy: Level,
        admin_uids: &[Uid],
    ) -> Result<Self, Unavailable> {
        let Some(uid) = principal.uid() else {
            return Ok(Self::None);
        };
        // isModerator returns before querying for configured administrator UIDs,
        // even when the conversation is absent or the database is unavailable.
        if policy == Level::Moderator && admin_uids.contains(&uid) {
            return Ok(Self::SiteModerator);
        }
        if !db.permits(zid, uid, policy)? {
            return Ok(Self::None);
        }
        Ok(match policy {
            Level::Owner => Self::Owner,
            Level::Moderator => Self::SiteModerator,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Refusal {
    pub status: u16,
    pub code: &'static str,
}

/// The route supplies its existing fixed error code; no upstream payload or
/// database diagnostic becomes an HTTP refusal. A different policy requires
/// a new evaluation, even for an owner or configured administrator.
pub fn require(authority: Authority, policy: Level, code: &'static str) -> Result<(), Refusal> {
    match (authority, policy) {
        (Authority::Owner, Level::Owner) | (Authority::SiteModerator, Level::Moderator) => Ok(()),
        _ => Err(Refusal { status: 403, code }),
    }
}

/// Node's strict zinvite owner probe, reduced to its boolean result.
pub const OWNER_SQL: &str = "select count(*) from conversations where zid = ($1) and owner = ($2)";
/// Exact predicate from server/src/utils/common.ts isModerator. Empty strings
/// compare equal, NULLs do not, and a missing user or conversation yields zero.
pub const MODERATOR_SQL: &str = "select count(*) from conversations where owner in (select uid from users where site_id = (select site_id from users where uid = ($2))) and zid = ($1)";

pub struct PostgresLookup<'a, T: postgres::GenericClient>(pub &'a mut T);
impl<T: postgres::GenericClient> AuthorityLookup for PostgresLookup<'_, T> {
    fn permits(&mut self, zid: Zid, uid: Uid, policy: Level) -> Result<bool, Unavailable> {
        let sql = match policy {
            Level::Owner => OWNER_SQL,
            Level::Moderator => MODERATOR_SQL,
        };
        let row = self
            .0
            .query_one(sql, &[&zid.0, &uid.0])
            .map_err(|_| Unavailable)?;
        let count: i64 = row.try_get(0).map_err(|_| Unavailable)?;
        Ok(count >= 1)
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    struct Lookup {
        result: Result<bool, Unavailable>,
        calls: Vec<(Zid, Uid, Level)>,
    }
    impl AuthorityLookup for Lookup {
        fn permits(&mut self, zid: Zid, uid: Uid, policy: Level) -> Result<bool, Unavailable> {
            self.calls.push((zid, uid, policy));
            self.result
        }
    }
    fn user(uid: i32) -> Principal {
        Principal::User {
            uid: Uid(uid),
            oidc_sub: None,
        }
    }
    #[test]
    fn absent_identity_does_not_query_or_gain_administrator_authority() {
        let mut db = Lookup {
            result: Err(Unavailable),
            calls: vec![],
        };
        for level in [Level::Owner, Level::Moderator] {
            assert_eq!(
                Authority::for_conversation(
                    &mut db,
                    Zid(1),
                    &Principal::Anonymous,
                    level,
                    &[Uid(0)]
                ),
                Ok(Authority::None)
            );
        }
        assert!(db.calls.is_empty());
    }
    #[test]
    fn administrator_bypasses_moderator_lookup_even_for_missing_conversation() {
        let mut db = Lookup {
            result: Err(Unavailable),
            calls: vec![],
        };
        assert_eq!(
            Authority::for_conversation(&mut db, Zid(-1), &user(7), Level::Moderator, &[Uid(7)]),
            Ok(Authority::SiteModerator)
        );
        assert!(db.calls.is_empty());
    }
    #[test]
    fn administrator_does_not_bypass_owner_lookup() {
        let mut db = Lookup {
            result: Ok(false),
            calls: vec![],
        };
        assert_eq!(
            Authority::for_conversation(&mut db, Zid(1), &user(7), Level::Owner, &[Uid(7)]),
            Ok(Authority::None)
        );
        assert_eq!(db.calls, vec![(Zid(1), Uid(7), Level::Owner)]);
    }
    #[test]
    fn all_verified_token_kinds_use_uid_not_pid_or_token_conversation() {
        let principals = [
            user(7),
            Principal::Participant {
                uid: Uid(7),
                pid: Some(Pid(0)),
                conversation: "other".into(),
                kind: TokenKind::AnonymousParticipant,
            },
            Principal::Participant {
                uid: Uid(7),
                pid: None,
                conversation: "other".into(),
                kind: TokenKind::XidParticipant,
            },
        ];
        for p in principals {
            let mut db = Lookup {
                result: Ok(true),
                calls: vec![],
            };
            assert_eq!(
                Authority::for_conversation(&mut db, Zid(42), &p, Level::Moderator, &[]),
                Ok(Authority::SiteModerator)
            );
            assert_eq!(db.calls, vec![(Zid(42), Uid(7), Level::Moderator)]);
        }
    }
    #[test]
    fn lookup_failure_stays_unavailable_not_forbidden_or_allowed() {
        let mut db = Lookup {
            result: Err(Unavailable),
            calls: vec![],
        };
        for level in [Level::Owner, Level::Moderator] {
            assert_eq!(
                Authority::for_conversation(&mut db, Zid(1), &user(1), level, &[]),
                Err(Unavailable)
            );
        }
    }
    #[test]
    fn owner_and_moderator_are_separate_policy_evidence() {
        let code = "polis_err_fetching_zinvite_not_conversation_owner";
        for auth in [Authority::Owner, Authority::SiteModerator, Authority::None] {
            for level in [Level::Owner, Level::Moderator] {
                let expected = matches!(
                    (auth, level),
                    (Authority::Owner, Level::Owner) | (Authority::SiteModerator, Level::Moderator)
                );
                assert_eq!(require(auth, level, code).is_ok(), expected);
                if !expected {
                    assert_eq!(
                        require(auth, level, code),
                        Err(Refusal { status: 403, code })
                    );
                }
            }
        }
    }
    #[test]
    fn negative_lookup_yields_none_and_positive_lookup_yields_only_requested_policy() {
        for result in [false, true] {
            for level in [Level::Owner, Level::Moderator] {
                let mut db = Lookup {
                    result: Ok(result),
                    calls: vec![],
                };
                let auth =
                    Authority::for_conversation(&mut db, Zid(1), &user(1), level, &[]).unwrap();
                assert_eq!(require(auth, level, "refused").is_ok(), result);
                assert_eq!(db.calls.len(), 1);
            }
        }
    }
}

pub mod admission;
pub mod observability;
pub mod participant;
