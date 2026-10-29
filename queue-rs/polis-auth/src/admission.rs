//! Participant admission, shared by the opt-in Treevite write handlers.
//!
//! A caller supplies a primary connection from a bounded participation budget.
//! Verify credentials and prepare bcrypt recovery material before calling; sign
//! tokens and issue child-wave invites only after this function returns. There
//! are no callbacks, network calls, hashing workers or token signers in the
//! transaction. The existing participant trigger owns number allocation.
use crate::{Pid, Refusal, Uid, Zid, participant::RequestIdentity};
use hmac::{Hmac, KeyInit, Mac};
use postgres::{Client, Transaction, error::SqlState};
use sha2::Sha256;

/// Trusted authentication input, never populated directly from request fields.
/// Anonymous scope is checked against resolved conversation numbers (aliases
/// may name the same conversation). Account UIDs require verified account auth.
/// No Debug implementation: credentials and identity values are not logs.
pub enum Identity<'a> {
    Anonymous,
    AnonymousParticipant { uid: Uid, conversation: Zid },
    Account(Uid),
    Xid { xid: &'a str, uid: Option<Uid> },
}

impl<'a> Identity<'a> {
    /// No bearer credential. Preserve a nonblank XID byte-for-byte; only
    /// JavaScript-whitespace-only values mean anonymous first contact.
    pub fn without_token(xid: Option<&'a str>) -> Self {
        match xid.filter(|s| {
            !s.trim_matches(crate::participant::request_xid_whitespace)
                .is_empty()
        }) {
            Some(xid) => Self::Xid { xid, uid: None },
            None => Self::Anonymous,
        }
    }
    /// The verifier has already dropped out-of-scope anonymous UIDs and applied
    /// request-XID precedence. The target must be the verifier's target.
    pub fn from_verified(identity: &'a RequestIdentity, target: Zid) -> Self {
        if let Some(xid) = identity.xid() {
            return Self::Xid {
                xid,
                uid: identity.uid(),
            };
        }
        match identity.uid() {
            Some(uid) if identity.kind == crate::participant::Kind::StandardUser => {
                Self::Account(uid)
            }
            Some(uid) => Self::AnonymousParticipant {
                uid,
                conversation: target,
            },
            None => Self::Anonymous,
        }
    }

    fn scoped(&self, target: Zid) -> (Option<Uid>, Option<&str>) {
        match self {
            Self::Anonymous => (None, None),
            Self::AnonymousParticipant { uid, conversation } => {
                ((*conversation == target).then_some(*uid), None)
            }
            Self::Account(uid) => (Some(*uid), None),
            Self::Xid { xid, uid } => (*uid, Some(*xid)),
        }
    }
}

/// Produced on a bounded crypto worker before admission, using the existing
/// bcrypt cost and pepper chains. Only the cheap PID-dependent HMAC runs inside
/// admission. Keep the raw code for the response; never log this structure.
pub struct PreparedRecovery<'a> {
    pub code: &'a str,
    pub bcrypt_hash: &'a str,
    pub lookup: &'a str,
    pub fingerprint_key: &'a [u8],
}

/// Login proof after bcrypt verification outside the transaction. The exact
/// lookup/hash pair and revocation state are checked again under a row lock so
/// a replaced or revoked credential cannot authenticate on stale evidence.
pub struct VerifiedLogin<'a> {
    pub lookup: &'a str,
    pub bcrypt_hash: &'a str,
}

pub enum Entry<'a> {
    Participation {
        create_if_missing: bool,
    },
    Invite {
        code: &'a str,
        recovery: PreparedRecovery<'a>,
    },
    Login(VerifiedLogin<'a>),
}

pub struct Request<'a> {
    pub zid: Zid,
    pub identity: Identity<'a>,
    pub entry: Entry<'a>,
    /// Trusted server configuration, never a token claim.
    pub admin_uids: &'a [Uid],
    pub x_name: Option<&'a str>,
    pub x_email: Option<&'a str>,
    pub x_profile_image_url: Option<&'a str>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Admitted {
    pub uid: Uid,
    pub pid: Pid,
    pub new_user: bool,
    pub new_participant: bool,
    /// Child-wave work uses these only after commit. BIGINT stays i64.
    pub invite: Option<(i64, i64)>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    Refused(Refusal),
    /// No database messages or credential values escape this boundary.
    Unavailable,
    /// COMMIT failed: the caller must not assume rollback or retry blindly.
    CommitUnknown,
}

enum Failure {
    Refused(Refusal),
    Burned(Refusal),
    Database(postgres::Error),
}
impl From<postgres::Error> for Failure {
    fn from(value: postgres::Error) -> Self {
        Self::Database(value)
    }
}
fn refuse<T>(status: u16, code: &'static str) -> Result<T, Failure> {
    Err(Failure::Refused(Refusal { status, code }))
}

/// One transaction per attempt. Uniqueness races roll back *all* writes and
/// resolve again from primary, at most three times. Lock timeouts are not
/// retried. Sequences may advance on rollback; rows and participant numbers do
/// not. A successful return means COMMIT was acknowledged, not that a future
/// response reached the client. Recovery after reply loss needs a separate
/// client-bound protocol before this can be served.
pub fn admit(client: &mut Client, request: &Request<'_>) -> Result<Option<Admitted>, Error> {
    for attempt in 0..3 {
        let mut tx = crate::transaction::begin(client).map_err(|_| Error::Unavailable)?;
        let result = run(&mut tx, request);
        match result {
            Ok(admitted) => {
                tx.commit().map_err(|_| Error::CommitUnknown)?;
                return Ok(admitted);
            }
            Err(Failure::Burned(reason)) => {
                tx.commit().map_err(|_| Error::CommitUnknown)?;
                return Err(Error::Refused(reason));
            }
            Err(error) => {
                tx.rollback().map_err(|_| Error::Unavailable)?;
                match error {
                    Failure::Refused(reason) | Failure::Burned(reason) => {
                        return Err(Error::Refused(reason));
                    }
                    Failure::Database(error)
                        if error.code() == Some(&SqlState::UNIQUE_VIOLATION) && attempt < 2 => {}
                    Failure::Database(_) => return Err(Error::Unavailable),
                }
            }
        }
    }
    Err(Error::Unavailable)
}

fn require_participant_account(
    tx: &mut Transaction<'_>,
    uid: Uid,
    admins: &[Uid],
) -> Result<(), Failure> {
    if admins.contains(&uid) {
        return refuse(403, "polis_err_xid_owner_account");
    }
    // Same predicate as Node's xid-account guard: site moderation of ANY
    // conversation counts, not just the conversation being joined.
    let row = tx.query_opt("SELECT u.is_owner,
        EXISTS (SELECT 1 FROM conversations c WHERE c.owner=u.uid),
        EXISTS (SELECT 1 FROM users owner_user JOIN conversations c ON c.owner=owner_user.uid WHERE owner_user.site_id=u.site_id),
        EXISTS (SELECT 1 FROM oidc_user_mappings m WHERE m.uid=u.uid)
        FROM users u WHERE u.uid=$1", &[&uid.0])?;
    if let Some(row) = row {
        for index in 0..4 {
            if row.try_get::<_, Option<bool>>(index)?.unwrap_or(false) {
                return refuse(403, "polis_err_xid_owner_account");
            }
        }
    }
    Ok(())
}

fn require_anonymous(tx: &mut Transaction<'_>, uid: Uid, admins: &[Uid]) -> Result<(), Failure> {
    require_participant_account(tx, uid, admins)?;
    if tx
        .query_opt("SELECT 1 FROM xids WHERE uid=$1", &[&uid.0])?
        .is_some()
    {
        return refuse(403, "polis_err_treevite_identity_conversion");
    }
    Ok(())
}

fn require_open(tx: &mut Transaction<'_>, zid: Zid) -> Result<(), Failure> {
    // Called after the allocator, never before it: taking a conversation row
    // lock before the advisory lock would invert Node's lock order. For a
    // returning member this short lock also serializes the final open check.
    let row = tx.query_opt(
        "SELECT is_active FROM conversations WHERE zid=$1 FOR SHARE",
        &[&zid.0],
    )?;
    if row.is_none_or(|row| row.get::<_, Option<bool>>(0) != Some(true)) {
        return refuse(403, "polis_err_conversation_is_closed");
    }
    Ok(())
}

fn run(tx: &mut Transaction<'_>, request: &Request<'_>) -> Result<Option<Admitted>, Failure> {
    let zid = request.zid;
    // Lock even a spent invite; a waiter sees the winner's committed status.
    // No user or participant is inserted before this decision.
    let invite = if let Entry::Invite { code, .. } = &request.entry {
        let row = tx.query_opt("SELECT id,wave_id,status FROM treevite_invites WHERE zid=$1 AND invite_code=$2 FOR UPDATE", &[&zid.0, code])?;
        let Some(row) = row else {
            return refuse(400, "polis_err_treevite_invalid_or_used_invite");
        };
        if row.try_get::<_, i16>(2)? != 0 {
            return refuse(400, "polis_err_treevite_invalid_or_used_invite");
        }
        if tx.query_one("SELECT created_at + interval '30 days' <= clock_timestamp() FROM treevite_invites WHERE id=$1", &[&row.try_get::<_, i64>(0)?])?.try_get::<_, bool>(0)? {
            return refuse(400, "polis_err_treevite_invite_expired");
        }
        if matches!(
            request.identity,
            Identity::Account(_) | Identity::Xid { .. }
        ) {
            return refuse(403, "polis_err_treevite_identity_conversion");
        }
        Some((row.try_get::<_, i64>(0)?, row.try_get::<_, i64>(1)?))
    } else {
        None
    };
    let row = tx.query_opt("SELECT owner,is_active,treevite_enabled,use_xid_whitelist,xid_required FROM conversations WHERE zid=$1", &[&zid.0])?;
    let Some(row) = row else {
        return refuse(404, "polis_err_fetching_zid_for_conversation_id");
    };
    let owner: i32 = row.try_get(0)?;
    if row.try_get::<_, Option<bool>>(1)? != Some(true) {
        return refuse(403, "polis_err_conversation_is_closed");
    }
    let treevite = row.try_get::<_, Option<bool>>(2)?.unwrap_or(false);
    let whitelist = row.try_get::<_, Option<bool>>(3)?.unwrap_or(false);
    let xid_required: bool = row.try_get(4)?;

    if let Entry::Login(proof) = &request.entry {
        let row = tx.query_opt("SELECT p.uid,l.pid,l.login_code_hash,l.revoked FROM treevite_login_codes l JOIN participants p ON p.zid=l.zid AND p.pid=l.pid WHERE l.zid=$1 AND l.login_code_lookup=$2 FOR UPDATE OF l", &[&zid.0, &proof.lookup])?;
        let Some(row) = row else {
            return refuse(401, "polis_err_treevite_login_code_invalid");
        };
        if row.try_get::<_, bool>(3)? || row.try_get::<_, String>(2)? != proof.bcrypt_hash {
            return refuse(401, "polis_err_treevite_login_code_invalid");
        }
        if tx.query_one("SELECT COALESCE(expires_at <= clock_timestamp(),false) FROM treevite_login_codes WHERE zid=$1 AND login_code_lookup=$2", &[&zid.0, &proof.lookup])?.try_get::<_, bool>(0)? {
            return refuse(401, "polis_err_treevite_login_code_expired");
        }
        let uid = Uid(row.try_get(0)?);
        require_anonymous(tx, uid, request.admin_uids)?;
        let pid: i32 = row.try_get(1)?;
        tx.execute("UPDATE treevite_login_codes SET last_used_at=now(),updated_at=now() WHERE zid=$1 AND pid=$2", &[&zid.0, &pid])?;
        require_open(tx, zid)?;
        return Ok(Some(Admitted {
            uid,
            pid: Pid(pid as u32),
            new_user: false,
            new_participant: false,
            invite: None,
        }));
    }

    let (mut uid, xid) = request.identity.scoped(zid);
    if let Some(xid) = xid {
        if whitelist
            && tx
                .query_opt(
                    "SELECT 1 FROM xid_whitelist WHERE owner=$1 AND xid=$2",
                    &[&owner, &xid],
                )?
                .is_none()
        {
            return refuse(403, "polis_err_xid_not_allowed");
        }
        if uid.is_none() {
            uid = tx
                .query_opt(
                    "SELECT uid FROM xids WHERE owner=$1 AND xid=$2",
                    &[&owner, &xid],
                )?
                .map(|row| row.try_get(0))
                .transpose()?
                .map(Uid);
        }
        if let Some(uid) = uid {
            require_participant_account(tx, uid, request.admin_uids)?;
        }
    }
    let create = match request.entry {
        Entry::Participation { create_if_missing } => create_if_missing || xid.is_some(),
        _ => true,
    };
    // A valid invite remains an alternative to a required XID, as in Node.
    if create && uid.is_none() && xid.is_none() && invite.is_none() && (whitelist || xid_required) {
        return refuse(403, "polis_err_xid_required");
    }
    let existing = if let Some(uid) = uid {
        if invite.is_some() {
            // Serialize this member's accepts even when no login row exists.
            // Participation never takes this Treevite-only lock; in particular,
            // comments' participant foreign-key checks must remain free to run.
            tx.query_one("SELECT pg_advisory_xact_lock(hashtextextended(jsonb_build_array('treevite:member-accept', $1::int, $2::int)::text,0))", &[&zid.0, &uid.0])?;
        }
        tx.query_opt(
            "SELECT pid FROM participants WHERE zid=$1 AND uid=$2",
            &[&zid.0, &uid.0],
        )?
        .map(|row| row.try_get::<_, i32>(0))
        .transpose()?
    } else {
        None
    };
    if let Some((id, _)) = invite {
        if let Some(uid) = uid {
            require_anonymous(tx, uid, request.admin_uids)?;
        }
        if let Some(pid) = existing {
            let present = tx
                .query_opt(
                    "SELECT 1 FROM treevite_login_codes WHERE zid=$1 AND pid=$2 FOR UPDATE",
                    &[&zid.0, &pid],
                )?
                .is_some();
            let live = present && tx.query_one("SELECT NOT revoked AND COALESCE(expires_at > clock_timestamp(),true) FROM treevite_login_codes WHERE zid=$1 AND pid=$2", &[&zid.0, &pid])?.try_get::<_, bool>(0)?;
            if live {
                tx.execute("UPDATE treevite_invites SET status=1,invite_used_by_pid=NULL,invite_used_at=now(),updated_at=now() WHERE id=$1", &[&id])?;
                return Err(Failure::Burned(Refusal {
                    status: 409,
                    code: "polis_err_treevite_login_code_exists",
                }));
            }
        }
    }
    if !create {
        return Ok(uid.zip(existing).map(|(uid, pid)| Admitted {
            uid,
            pid: Pid(pid as u32),
            new_user: false,
            new_participant: false,
            invite: None,
        }));
    }
    if treevite && invite.is_none() && existing.is_none() && uid != Some(Uid(owner)) {
        return refuse(401, "polis_err_treevite_auth_required");
    }
    let new_user = uid.is_none();
    let uid = match uid {
        Some(uid) => uid,
        None => Uid(tx
            .query_one(
                if invite.is_some() {
                    "INSERT INTO users(is_owner,site_owner) VALUES(false,false) RETURNING uid"
                } else {
                    "INSERT INTO users(created) VALUES(default) RETURNING uid"
                },
                &[],
            )?
            .try_get(0)?),
    };
    // Configuration may name a UID before its sequence value is allocated.
    // Apply the same guard to newly allocated XID users before membership too.
    if new_user && xid.is_some() {
        require_participant_account(tx, uid, request.admin_uids)?;
    }
    if new_user && invite.is_some() {
        require_anonymous(tx, uid, request.admin_uids)?;
    }
    let pid = match existing {
        Some(pid) => pid,
        None => {
            if invite.is_none() {
                tx.execute("INSERT INTO participants_extended(zid,uid) VALUES($1,$2) ON CONFLICT(zid,uid) DO NOTHING", &[&zid.0, &uid.0])?;
            }
            // Migration 000044 holds its advisory lock through our COMMIT.
            tx.query_one("INSERT INTO participants(pid,zid,uid,created) VALUES(NULL,$1,$2,default) RETURNING pid", &[&zid.0, &uid.0])?.try_get::<_, i32>(0)?
        }
    };
    if new_user && let Some(xid) = xid {
        // A competing binding must cause rollback and primary re-resolution;
        // never update its PID while retaining another user's UID.
        tx.execute("INSERT INTO xids(owner,uid,xid,zid,pid,x_name,x_email,x_profile_image_url) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", &[&owner, &uid.0, &xid, &zid.0, &pid, &request.x_name, &request.x_email, &request.x_profile_image_url])?;
    }
    if let Entry::Invite { recovery, .. } = &request.entry {
        let mut mac = Hmac::<Sha256>::new_from_slice(recovery.fingerprint_key).map_err(|_| {
            Failure::Refused(Refusal {
                status: 500,
                code: "polis_err_treevite_accept_invite",
            })
        })?;
        mac.update(format!("{}:{pid}:{}", zid.0, recovery.code).as_bytes());
        let fingerprint: String = mac
            .finalize()
            .into_bytes()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        tx.execute("INSERT INTO treevite_login_codes(zid,pid,login_code_hash,login_code_fingerprint,login_code_lookup,fp_kid,revoked,last_used_at,updated_at,expires_at) VALUES($1,$2,$3,$4,$5,1,false,null,now(),now() + interval '1 year') ON CONFLICT(zid,pid) DO UPDATE SET login_code_hash=excluded.login_code_hash,login_code_fingerprint=excluded.login_code_fingerprint,login_code_lookup=excluded.login_code_lookup,fp_kid=excluded.fp_kid,revoked=false,updated_at=now(),expires_at=excluded.expires_at", &[&zid.0, &pid, &recovery.bcrypt_hash, &fingerprint, &recovery.lookup])?;
        if let Some((id, _)) = invite {
            tx.execute("UPDATE treevite_invites SET status=1,invite_used_by_pid=$1,invite_used_at=now(),updated_at=now() WHERE id=$2", &[&pid, &id])?;
        }
    }
    require_open(tx, zid)?;
    Ok(Some(Admitted {
        uid,
        pid: Pid(pid as u32),
        new_user,
        new_participant: existing.is_none(),
        invite,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anonymous_scope_is_per_conversation_including_pid_zero() {
        let first = Identity::Anonymous;
        assert_eq!(first.scoped(Zid(1)), (None, None));
        let returning = Identity::AnonymousParticipant {
            uid: Uid(7),
            conversation: Zid(1),
        };
        assert_eq!(returning.scoped(Zid(1)), (Some(Uid(7)), None));
        assert_eq!(returning.scoped(Zid(2)), (None, None));
    }

    #[test]
    fn account_and_xid_resolution_keep_their_different_namespaces() {
        assert_eq!(
            Identity::Account(Uid(7)).scoped(Zid(2)),
            (Some(Uid(7)), None)
        );
        assert_eq!(
            Identity::Xid {
                xid: "first",
                uid: None
            }
            .scoped(Zid(2)),
            (None, Some("first"))
        );
        assert_eq!(
            Identity::Xid {
                xid: "returning",
                uid: Some(Uid(7))
            }
            .scoped(Zid(2)),
            (Some(Uid(7)), Some("returning"))
        );
    }

    #[test]
    fn bare_xid_whitespace_matches_node_without_trimming_real_identifiers() {
        for blank in ["", " \t", "\u{feff}"] {
            assert_eq!(
                Identity::without_token(Some(blank)).scoped(Zid(1)),
                (None, None)
            );
        }
        for xid in [" member ", "\u{0085}"] {
            assert_eq!(
                Identity::without_token(Some(xid)).scoped(Zid(1)),
                (None, Some(xid))
            );
        }
    }
}
