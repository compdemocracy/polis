//! What the participation entry of admission would decide, by reads alone.
//!
//! `Snapshot::decide` runs the very reads `admit` runs for the participation
//! entry (`open_conversation`, then `participation`) and stops where `admit`
//! would write. It runs in one read-only transaction at one snapshot, with
//! bounds the server itself enforces, so a caller that stalls between two
//! reads cannot keep the transaction, and the locks its reads hold, open.
//!
//! It answers: "what `admit` would decide at one instant, with nobody else
//! joining". It cannot know what only the writes reveal:
//!
//! - the user number a new user would get, which `admit` checks against the
//!   configured administrators after the insert;
//! - the final open check `admit` makes after its writes, so a conversation
//!   closed between the two reads is admitted here and refused there;
//! - a concurrent first request for the same account or external id, which
//!   `admit` resolves by rolling back and reading again;
//! - a lock wait, a failed commit or a failed write.
//!
//! Nothing here inserts, updates, deletes, locks a row, takes an advisory
//! lock or draws from a sequence.
use super::{Before, Failure, Identity, Seen, open_conversation, participation};
use crate::{Pid, Refusal, Uid, Unavailable, Zid, participant::Verified};
use postgres::{Client, IsolationLevel, Transaction};
use std::time::Duration;

/// The server-side bounds of one snapshot. `transaction` is applied on
/// PostgreSQL 17 and later, where the setting exists.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Bounds {
    /// One statement.
    pub statement: Duration,
    /// One wait for a lock.
    pub lock: Duration,
    /// The transaction, idle between two statements.
    pub idle: Duration,
    /// The whole transaction.
    pub transaction: Duration,
}

impl Bounds {
    /// For an observer: each read is cut at 100 ms, a stalled transaction is
    /// ended by the server after one second, and no transaction outlives two.
    pub const OBSERVE: Self = Self {
        statement: Duration::from_millis(100),
        lock: Duration::from_millis(100),
        idle: Duration::from_secs(1),
        transaction: Duration::from_secs(2),
    };
}

/// One read-only transaction at one snapshot (`REPEATABLE READ READ ONLY`),
/// bounded by the server. Dropping it rolls it back.
pub struct Snapshot<'a> {
    tx: Transaction<'a>,
}

/// Begins a snapshot on `client`. The bounds are set before any read.
pub fn snapshot<'a>(client: &'a mut Client, bounds: &Bounds) -> Result<Snapshot<'a>, Unavailable> {
    let mut tx = client
        .build_transaction()
        .isolation_level(IsolationLevel::RepeatableRead)
        .read_only(true)
        .start()
        .map_err(|_| Unavailable)?;
    tx.batch_execute(&format!(
        "SET LOCAL statement_timeout = {}; SET LOCAL lock_timeout = {}; \
         SET LOCAL idle_in_transaction_session_timeout = {}; \
         SELECT set_config('transaction_timeout', '{}', true) \
         WHERE current_setting('server_version_num')::int >= 170000",
        bounds.statement.as_millis(),
        bounds.lock.as_millis(),
        bounds.idle.as_millis(),
        bounds.transaction.as_millis(),
    ))
    .map_err(|_| Unavailable)?;
    Ok(Snapshot { tx })
}

/// A request at the participation entry. The identity is trusted input, as
/// for `admit`: a verified token's, or an external id from a request with no
/// token.
pub struct Participation<'a> {
    pub zid: Zid,
    pub identity: &'a Identity<'a>,
    pub create_if_missing: bool,
    /// Trusted server configuration, never a token claim.
    pub admin_uids: &'a [Uid],
}

/// What `admit` would do.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// An existing member: nothing is created.
    Found,
    /// A participant for a user that exists.
    CreateParticipant,
    /// A user, and a participant for it.
    CreateUserAndParticipant,
    /// Nobody, and nothing is created: the entry does not create.
    Nobody,
    Refused(Refusal),
}

/// What the reads saw of an external id.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum XidSeen {
    /// The request names none.
    NotNamed,
    /// It is bound to a user under the conversation's owner.
    Bound,
    /// It is bound to nobody under the conversation's owner.
    Unbound,
    /// The decision was made before the binding was looked up.
    NotReached,
}

/// The conversation's rules for joining, as the decision read them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RulesSeen {
    pub treevite: bool,
    pub xid_required: bool,
    pub allowlist: bool,
}

/// One decision. It has no `Debug`: it holds a user number, a participant
/// number and the conversation owner's user number, which are not logs.
pub struct Decision {
    pub outcome: Outcome,
    /// None when the conversation does not exist or is closed: it is refused
    /// before its rules are read.
    pub rules: Option<RulesSeen>,
    pub xid: XidSeen,
    uid: Option<Uid>,
    pid: Option<i32>,
    owner: Option<i32>,
}

impl Decision {
    /// The user the reads resolved, when they resolved one.
    pub fn uid(&self) -> Option<Uid> {
        self.uid
    }
    /// The participant number of that user's row in this conversation.
    pub fn pid(&self) -> Option<Pid> {
        self.pid.and_then(|pid| u32::try_from(pid).ok()).map(Pid)
    }
    /// The conversation's owner, under whom an external id is bound.
    pub fn owner(&self) -> Option<Uid> {
        self.owner.map(Uid)
    }
}

/// A token holder's participant row against the token.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MemberRow {
    /// One row, with the token's participant number.
    Matches,
    /// No row for the token's user in this conversation.
    Absent,
    /// A row with another participant number.
    Differs,
}

/// Why the membership read (`participant::resolve`) finds no member for a
/// token: the conversation uses Treevite, or the row is not the token's.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Membership {
    pub treevite: bool,
    pub row: MemberRow,
}

impl<'a> Snapshot<'a> {
    /// For the caller's own reads at this snapshot.
    pub fn client(&mut self) -> &mut Transaction<'a> {
        &mut self.tx
    }

    /// What `admit` would decide for this request at this snapshot.
    pub fn decide(&mut self, request: &Participation<'_>) -> Result<Decision, Unavailable> {
        let named = request.identity.scoped(request.zid).1.is_some();
        let rules = match open_conversation(&mut self.tx, request.zid) {
            Ok(rules) => rules,
            Err(Failure::Refused(refusal) | Failure::Burned(refusal)) => {
                return Ok(Decision {
                    outcome: Outcome::Refused(refusal),
                    rules: None,
                    xid: if named {
                        XidSeen::NotReached
                    } else {
                        XidSeen::NotNamed
                    },
                    uid: None,
                    pid: None,
                    owner: None,
                });
            }
            Err(Failure::Database(_)) => return Err(Unavailable),
        };
        let mut seen = Seen::default();
        let before = participation(
            &mut self.tx,
            request.zid,
            &rules,
            request.identity,
            request.create_if_missing,
            request.admin_uids,
            &mut seen,
        );
        let outcome = match before {
            Ok(Before::Found(Some(_))) => Outcome::Found,
            Ok(Before::Found(None)) => Outcome::Nobody,
            Ok(Before::Write {
                uid: Some(_),
                existing: Some(_),
            }) => Outcome::Found,
            Ok(Before::Write {
                uid: Some(_),
                existing: None,
            }) => Outcome::CreateParticipant,
            Ok(Before::Write { uid: None, .. }) => Outcome::CreateUserAndParticipant,
            Err(Failure::Refused(refusal) | Failure::Burned(refusal)) => Outcome::Refused(refusal),
            Err(Failure::Database(_)) => return Err(Unavailable),
        };
        let xid = match (named, seen.bound) {
            (false, _) => XidSeen::NotNamed,
            (true, Some(true)) => XidSeen::Bound,
            (true, Some(false)) => XidSeen::Unbound,
            // A token already bound to this external id here: no lookup.
            (true, None) if request.identity.scoped(request.zid).0.is_some() => XidSeen::Bound,
            (true, None) => XidSeen::NotReached,
        };
        Ok(Decision {
            outcome,
            rules: Some(RulesSeen {
                treevite: rules.treevite,
                xid_required: rules.xid_required,
                allowlist: rules.whitelist,
            }),
            xid,
            uid: seen.uid,
            pid: seen.existing,
            owner: Some(rules.owner),
        })
    }

    /// The conversation's Treevite setting and the token holder's row, in one
    /// read. None when the conversation has no row, or more than one row
    /// answers: neither can be classified.
    pub fn membership(
        &mut self,
        zid: Zid,
        identity: &Verified,
    ) -> Result<Option<Membership>, Unavailable> {
        let rows = self
            .tx
            .query(
                "SELECT c.treevite_enabled, p.pid FROM conversations c \
                 LEFT JOIN participants p ON p.zid=c.zid AND p.uid=$2 WHERE c.zid=$1",
                &[&zid.0, &identity.uid().0],
            )
            .map_err(|_| Unavailable)?;
        let [row] = rows.as_slice() else {
            return Ok(None);
        };
        let treevite = row
            .try_get::<_, Option<bool>>(0)
            .map_err(|_| Unavailable)?
            .unwrap_or(false);
        let pid = row.try_get::<_, Option<i32>>(1).map_err(|_| Unavailable)?;
        let row = match pid {
            None => MemberRow::Absent,
            Some(pid) if u32::try_from(pid).ok() == Some(identity.pid().0) => MemberRow::Matches,
            Some(_) => MemberRow::Differs,
        };
        Ok(Some(Membership { treevite, row }))
    }

    /// Ends the transaction. It wrote nothing, so there is nothing to keep.
    pub fn end(self) {
        let _ = self.tx.rollback();
    }
}
