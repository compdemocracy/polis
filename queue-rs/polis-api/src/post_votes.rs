//! Existing, conversation-scoped participant votes. Handoff is possible only
//! before the append is dispatched. Every subsequent failure is terminal.
use crate::post_votes_contract::{self as contract, ParsedFields};
use crate::{
    comments, config, db,
    http::{Outgoing, Request},
    js::{self, Js},
    next_comment,
    route::{self, App, Res},
};
use anyhow::{Context, Result};
use contract::{AcceptedVote, DurableSuccess, FollowOn, FollowOnState, NotificationState};
use polis_auth::{PostgresLookup, Uid, Zid, admission as join, participant, xid_account};
use postgres::Client;
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

#[path = "writer_priorities.rs"]
mod writer_priorities;

#[path = "post_votes_observe.rs"]
pub(crate) mod observe;
pub(crate) use observe::Observer;

#[path = "post_votes_identity.rs"]
pub(crate) mod identity;

pub const PATH: &str = contract::PATH;
// The comment contract is compiled into this crate by path. It names these
// four parsers by their path in the contracts crate, which here is this
// module's path.
pub(crate) use contract::{InvalidField, boolean, integer, string};
pub(crate) const MAX_BODY_BYTES: usize = 65536;
const REJECTED_COMMENT_MOD: i32 = -1;
const ADMISSION_DEADLINE: Duration = Duration::from_millis(250);
const DISPATCH_DEADLINE: Duration = Duration::from_secs(1);
// Accepted work may outlive the HTTP response. Report writer contention while
// preserving queue position until the pool's dispatched-acquisition cutoff.
const DISPATCH_ACQUIRE_ALARM: Duration = Duration::from_secs(1);

pub(crate) struct Writer {
    pool: Arc<db::Pool>,
    background: Arc<NotificationPool>,
    verifier: participant::Verifier,
    reads: Arc<db::Pool>,
    admins: Vec<i32>,
    priorities: Arc<writer_priorities::Cache>,
    follow_on: Arc<FollowOnLane>,
    /// `POLIS_API_POST_VOTES_IDENTITY_NO_WRITE=1`: the identity cases that
    /// write nothing (`IDENTITY_NO_WRITE_SWITCH`). Off, admission is exactly
    /// what it was before the switch existed.
    pub(crate) identity_no_write: bool,
    /// `POLIS_API_POST_VOTES_FIRST_CONTACT=1`: a first vote with no token and
    /// no external id (`FIRST_CONTACT_SWITCH`). None, the request is handed
    /// back exactly as before the switch existed.
    pub(crate) first_contact: Option<FirstContact>,
}

/// What a first contact writes with: a pool of its own on the primary, and the
/// participant signing key. Nothing else uses this pool.
pub(crate) struct FirstContact {
    pub(crate) pool: Arc<db::Pool>,
    pub(crate) keys: Arc<polis_auth::keys::Keys>,
    pub(crate) issuer: String,
    pub(crate) audience: String,
}

/// The first contact's pool: two connections, 100 ms to get one, one second a
/// statement. The transaction's own bounds are `FIRST_CONTACT_BOUNDS`.
pub(crate) fn first_contact_limits() -> db::Limits {
    db::Limits {
        size: 2,
        acquire_timeout: Duration::from_millis(100),
        statement_timeout: Duration::from_millis(1000),
        max_lifetime: Duration::from_secs(300),
    }
}

/// Each admission attempt's transaction: 100 ms for a lock (the
/// participant-number lock among them), one second a statement.
const FIRST_CONTACT_BOUNDS: join::Bounds = join::Bounds {
    statement: Duration::from_millis(1000),
    lock: Duration::from_millis(100),
    idle: Duration::from_millis(1000),
    transaction: Duration::from_millis(2000),
};

impl Writer {
    #[cfg(all(test, feature = "db-tests"))]
    pub(crate) fn startup_pools(&self) -> [&Arc<db::Pool>; 3] {
        // No rest pattern: new fields must be classified for this inventory.
        let Self {
            pool,
            background,
            verifier: _,
            reads,
            admins: _,
            priorities: _,
            follow_on: _,
            identity_no_write: _,
            first_contact: _,
        } = self;
        let NotificationPool {
            pool: background_pool,
            admitted: _,
            dropped: _,
        } = background.as_ref();
        [pool, background_pool, reads]
    }

    pub(crate) fn set_revocations(&mut self, snapshot: Arc<polis_auth::revocation::Revocations>) {
        self.verifier.set_revocations(snapshot);
    }
    pub(crate) fn check_revocation(&self, raw: &str, now: u64) -> Result<(), polis_auth::Refusal> {
        self.verifier.check_revocation(raw, now)
    }

    /// The live writer `configure` builds in the main role, for the tests of
    /// its startup conditions.
    #[cfg(test)]
    pub(crate) fn from_env() -> Result<Option<Self>> {
        match configure(
            crate::shadow::Role::Main,
            polis_auth::keys::Keys::from_env_optional()?.as_ref(),
        )? {
            Configured::Live(writer) => Ok(Some(writer)),
            Configured::Off => Ok(None),
            Configured::Observe(_) => {
                anyhow::bail!("observe mode is built only by the shadow role")
            }
        }
    }

    fn admission(&self) -> Admission<'_> {
        Admission {
            verifier: &self.verifier,
            reads: &self.reads,
            admins: &self.admins,
            priorities: &self.priorities,
            follow_on: &self.follow_on,
            identity: self.identity_no_write,
            first_contact: self.first_contact.is_some(),
        }
    }
}

/// What `POLIS_API_POST_VOTES` asks for. Unset, empty or `0` is off, as any
/// value but `1` was before observe existed; another value is a startup error
/// rather than a silent off.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Switch {
    Off,
    Live,
    Observe,
}

fn switch() -> Result<Switch> {
    match std::env::var("POLIS_API_POST_VOTES").ok().as_deref() {
        None | Some("" | "0") => Ok(Switch::Off),
        Some("1") => Ok(Switch::Live),
        Some("observe") => Ok(Switch::Observe),
        Some(_) => anyhow::bail!("POLIS_API_POST_VOTES must be unset, 0, 1 or observe"),
    }
}

/// The identity switch of the live writer. Unset, empty or `0` is off: every
/// request is admitted, refused and handed back exactly as before the switch
/// existed. `1` also serves, with no row written and no token minted, an
/// external-id token's member, a member token beside the four external-id
/// keys, a member of a conversation that requires or lists external ids, and
/// a Treevite member whose row is the token's; and it answers, with Node's
/// bytes, the refusals Node's participant middleware makes before writing.
/// Read only by the main role, and accepted only beside
/// `POLIS_API_POST_VOTES=1`; another value is a startup error.
pub(crate) const IDENTITY_NO_WRITE_SWITCH: &str = "POLIS_API_POST_VOTES_IDENTITY_NO_WRITE";

fn identity_no_write_switch() -> Result<bool> {
    match std::env::var(IDENTITY_NO_WRITE_SWITCH).ok().as_deref() {
        None | Some("" | "0") => Ok(false),
        Some("1") => Ok(true),
        Some(_) => anyhow::bail!("{IDENTITY_NO_WRITE_SWITCH} must be unset, 0 or 1"),
    }
}

/// The first-contact switch of the live writer. Unset, empty or `0` is off:
/// a vote with no token and no external id is handed back, as before the
/// switch existed. `1` serves it: the conversation's open check and the
/// fields first, with nothing written; then a user and a participant on a pool
/// of the first contact's own, the vote, and an anonymous participant token in
/// the reply. Read only by the main role, and accepted only beside
/// `POLIS_API_POST_VOTES=1` and `POLIS_API_POST_VOTES_IDENTITY_NO_WRITE=1`;
/// the participant signing key is then required. Another value is a startup
/// error.
pub(crate) const FIRST_CONTACT_SWITCH: &str = "POLIS_API_POST_VOTES_FIRST_CONTACT";

fn first_contact_switch() -> Result<bool> {
    match std::env::var(FIRST_CONTACT_SWITCH).ok().as_deref() {
        None | Some("" | "0") => Ok(false),
        Some("1") => Ok(true),
        Some(_) => anyhow::bail!("{FIRST_CONTACT_SWITCH} must be unset, 0 or 1"),
    }
}

pub(crate) enum Configured {
    Off,
    Live(Writer),
    Observe(Observer),
}

/// The vote writer this process's role builds. The main role builds the live
/// writer for `1` and refuses `observe`; the shadow role builds the observe
/// writer for `observe` and refuses `1`. Both modes share every startup
/// condition below. Both verify participant tokens with the key in
/// POLIS_API_PARTICIPANT_PUBLIC_KEY_FILE when that is set, and otherwise with
/// the participant keys the process loaded at startup (the container that
/// runs this has no key file; the participant reads use the same keys).
pub(crate) fn configure(
    role: crate::shadow::Role,
    keys: Option<&polis_auth::keys::Keys>,
) -> Result<Configured> {
    let switch = switch()?;
    // Identity is observed only beside the vote observer, in the shadow role.
    // The main role never reads its switch.
    let observe_identity = role == crate::shadow::Role::Shadow && identity::switch()?;
    anyhow::ensure!(
        !observe_identity || switch == Switch::Observe,
        "{}=observe requires POLIS_API_POST_VOTES=observe",
        identity::SWITCH
    );
    // The live writer's identity switch: never read by the shadow role.
    let identity_no_write = role == crate::shadow::Role::Main && identity_no_write_switch()?;
    anyhow::ensure!(
        !identity_no_write || switch == Switch::Live,
        "{IDENTITY_NO_WRITE_SWITCH}=1 requires POLIS_API_POST_VOTES=1"
    );
    // The first-contact switch: never read by the shadow role.
    let first_contact = role == crate::shadow::Role::Main && first_contact_switch()?;
    anyhow::ensure!(
        !first_contact || identity_no_write,
        "{FIRST_CONTACT_SWITCH}=1 requires {IDENTITY_NO_WRITE_SWITCH}=1 and POLIS_API_POST_VOTES=1"
    );
    match (role, switch) {
        (_, Switch::Off) => return Ok(Configured::Off),
        (crate::shadow::Role::Main, Switch::Observe) => anyhow::bail!(
            "POLIS_API_POST_VOTES=observe is accepted only by the shadow role (POLIS_API_ROLE=shadow)"
        ),
        (crate::shadow::Role::Shadow, Switch::Live) => anyhow::bail!(
            "the shadow role never builds the live vote writer: POLIS_API_POST_VOTES=1 is refused there"
        ),
        _ => {}
    }
    // Topical selection and translation providers cannot be part of this
    // admitted slice. An absent setting does not imply ordinary selection.
    anyhow::ensure!(
        std::env::var("TOPICAL_COMMENT_RATIO").ok().as_deref() == Some("0"),
        "post votes requires explicit ordinary next-statement selection"
    );
    anyhow::ensure!(
        std::env::var("SHOULD_USE_TRANSLATION_API").ok().as_deref() == Some("false"),
        "post votes requires SHOULD_USE_TRANSLATION_API=false"
    );
    let dsn = std::env::var("POLIS_API_POST_VOTES_DATABASE_URL")
        .context("post votes requires an explicit primary database")?;
    let key = match std::env::var("POLIS_API_PARTICIPANT_PUBLIC_KEY_FILE")
        .ok()
        .filter(|path| !path.is_empty())
    {
        Some(path) => Some(std::fs::read(path)?),
        None => None,
    };
    let issuer = std::env::var("POLIS_JWT_ISSUER")?;
    let audience = std::env::var("POLIS_JWT_AUDIENCE")?;
    let verifier = match (key, keys) {
        (Some(key), _) => participant::Verifier::new(&key, &issuer, &audience),
        (None, Some(keys)) => keys.verifier(&issuer, &audience),
        (None, None) => anyhow::bail!(
            "post votes requires the participant public key: POLIS_API_PARTICIPANT_PUBLIC_KEY_FILE, or the participant keys the process loads (JWT_PUBLIC_KEY or JWT_PUBLIC_KEY_PATH)"
        ),
    }
    .context("invalid participant verifier configuration")?;
    let admins: Vec<i32> =
        serde_json::from_str(&std::env::var("ADMIN_UIDS").unwrap_or_else(|_| "[]".into()))?;
    let priorities = Arc::new(writer_priorities::Cache::with_max_bytes(
        writer_priorities::max_bytes_from_env()?,
    ));
    if switch == Switch::Observe {
        // Observe never calls db::Pool::writer: both pools are read-only
        // sessions, and there is no notification pool.
        let mut observer = Observer::new(
            verifier,
            db::Pool::new(
                config::connector_for_dsn(&dsn, "polis-api-vote-reads/1")?,
                read_limits(),
            ),
            db::Pool::new(
                config::connector_for_dsn(&dsn, "polis-api-vote-shadow-readback/1")?,
                observe::readback_limits(),
            ),
            admins,
            priorities,
        );
        if observe_identity {
            // A third read-only pool, of its own: an identity decision never
            // takes an admission slot or the vote read-back's connection.
            observer.identity = Some(Box::new(identity::IdentityObserver::new(db::Pool::new(
                config::connector_for_dsn(&dsn, "polis-api-vote-shadow-identity/1")?,
                identity::limits(),
            ))));
        }
        return Ok(Configured::Observe(observer));
    }
    let first_contact = if first_contact {
        let keys = polis_auth::keys::Keys::from_env()
            .map_err(|error| anyhow::anyhow!("{FIRST_CONTACT_SWITCH}=1: {error:?}"))?;
        anyhow::ensure!(
            keys.private_key().is_some(),
            "{FIRST_CONTACT_SWITCH}=1 requires the participant signing key (JWT_PRIVATE_KEY or JWT_PRIVATE_KEY_PATH)"
        );
        Some(FirstContact {
            pool: db::Pool::writer(
                config::connector_for_dsn(&dsn, "polis-api-vote-first-contact/1")?,
                first_contact_limits(),
            ),
            keys: Arc::new(keys),
            issuer: issuer.clone(),
            audience: audience.clone(),
        })
    } else {
        None
    };
    Ok(Configured::Live(Writer {
        pool: db::Pool::writer(
            config::connector_for_dsn(&dsn, "polis-api-post-votes/1")?,
            db::Limits {
                size: 4,
                acquire_timeout: Duration::from_millis(100),
                statement_timeout: Duration::from_millis(1000),
                max_lifetime: Duration::from_secs(300),
            },
        ),
        background: NotificationPool::new(db::Pool::writer(
            config::connector_for_dsn(&dsn, "polis-api-vote-notifications/1")?,
            db::Limits {
                size: 2,
                acquire_timeout: Duration::from_millis(100),
                statement_timeout: Duration::from_millis(1000),
                max_lifetime: Duration::from_secs(300),
            },
        )),
        verifier,
        reads: db::Pool::new(
            config::connector_for_dsn(&dsn, "polis-api-vote-reads/1")?,
            read_limits(),
        ),
        admins,
        priorities,
        follow_on: Arc::new(FollowOnLane::default()),
        identity_no_write,
        first_contact,
    }))
}

/// What admission uses, from the live writer or the observe writer.
struct Admission<'a> {
    verifier: &'a participant::Verifier,
    reads: &'a Arc<db::Pool>,
    admins: &'a [i32],
    priorities: &'a Arc<writer_priorities::Cache>,
    follow_on: &'a Arc<FollowOnLane>,
    /// The live writer's identity switch; always false in observe mode.
    identity: bool,
    /// The live writer's first-contact switch; always false in observe mode.
    first_contact: bool,
}

fn request(req: &Request) -> Option<(String, contract::Request)> {
    request_reasoned(req).ok()
}

/// `request`, with the reason a request is handed back. The checks and their
/// results are the same; observe mode records the reason.
fn request_reasoned(req: &Request) -> Result<(String, contract::Request), &'static str> {
    if req.method != "POST" {
        return Err("shape_method");
    }
    if req.query().is_some_and(|q| !q.is_empty()) {
        return Err("shape_query");
    }
    if req.body.len() > MAX_BODY_BYTES {
        return Err("shape_size");
    }
    if req.headers.get("content-encoding").is_some() {
        return Err("shape_encoding");
    }
    // The three forms the clients send, each of which Node parses as UTF-8
    // JSON. The upper-case one is the jQuery participation client's
    // `charset=utf-8` as a browser's XMLHttpRequest sends it: for a string
    // body it rewrites the charset value to `UTF-8`.
    if !matches!(
        req.headers.get("content-type"),
        Some(
            "application/json"
                | "application/json; charset=utf-8"
                | "application/json; charset=UTF-8"
        )
    ) {
        return Err("shape_content_type");
    }
    let value: serde_json::Value = serde_json::from_slice(&req.body).map_err(|_| "shape_json")?;
    let obj = value.as_object().ok_or("shape_json")?;
    if obj.keys().any(|k| {
        !matches!(
            k.as_str(),
            "conversation_id"
                | "tid"
                | "vote"
                | "starred"
                | "high_priority"
                | "lang"
                | "pid"
                | "agid"
        )
    }) {
        return Err("shape_keys");
    }
    // Node ignores body pid/agid. The field codec discards them too; only the
    // verified token and resolved membership may identify the voter.
    let raw: contract::Request = serde_json::from_value(value).map_err(|_| "shape_json")?;
    let cid = raw
        .conversation_id
        .as_ref()
        .and_then(|v| contract::string(v, 100))
        .ok_or("shape_conversation_id")?;
    if cid.is_empty() || !cid.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return Err("shape_conversation_id");
    }
    Ok((cid, raw))
}

/// The body keys that name an external id. Node's vote route parses only
/// `xid` (`want("xid", getStringLimitLength(1, 999))`); the profile keys are
/// not parsed there and change nothing.
const EXTERNAL_ID_KEYS: [&str; 4] = ["xid", "x_name", "x_profile_image_url", "x_email"];

/// `request_reasoned` with the identity switch on: the four external-id keys
/// are taken out of the body before the same checks, and the external id the
/// body names is returned. An external id Node's parser would refuse, or one
/// that is only whitespace, is handed back for Node to answer.
fn request_identity(
    req: &Request,
) -> Result<(String, contract::Request, Option<String>), &'static str> {
    match request_reasoned(req) {
        Err("shape_keys") => {}
        other => return other.map(|(cid, raw)| (cid, raw, None)),
    }
    let value: serde_json::Value = serde_json::from_slice(&req.body).map_err(|_| "shape_json")?;
    let mut object = value.as_object().ok_or("shape_json")?.clone();
    if !EXTERNAL_ID_KEYS.iter().any(|key| object.contains_key(*key)) {
        return Err("shape_keys");
    }
    let xid = object.get("xid").cloned();
    for key in EXTERNAL_ID_KEYS {
        object.remove(key);
    }
    let rest = Request {
        method: req.method.clone(),
        target: req.target.clone(),
        headers: req.headers.clone(),
        body: serde_json::to_vec(&serde_json::Value::Object(object)).map_err(|_| "shape_json")?,
    };
    let (cid, raw) = request_reasoned(&rest)?;
    let xid = match xid {
        None | Some(serde_json::Value::Null) => None,
        Some(value) => match contract::string(&value, 999) {
            Some(xid)
                if !matches!(
                    join::Identity::without_token(Some(&xid)),
                    join::Identity::Anonymous
                ) =>
            {
                Some(xid)
            }
            _ => return Err("xid_parameter"),
        },
    };
    Ok((cid, raw, xid))
}

pub(crate) fn eligible(app: &App, req: &Request) -> bool {
    // Cookies neither authenticate nor disqualify a caller. handle still
    // requires a supported verified Bearer and membership before dispatch.
    let shape = match &app.post_votes {
        Some(writer) if writer.identity_no_write => request_identity(req).is_ok(),
        _ => request(req).is_some(),
    };
    (app.post_votes.is_some() || app.post_votes_observe.is_some())
        && app.production
        && shape
        && (app.dev_mode
            || app.use_network_host
            || req.headers.get("x-forwarded-proto") == Some("https"))
}

#[derive(Clone)]
struct Admitted {
    zid: i32,
    pid: i32,
    uid: i32,
    active: bool,
    // Retain the validated generation until the dispatched work completes.
    _priority_lease: Option<Arc<writer_priorities::Weights>>,
    priorities: Arc<writer_priorities::Cache>,
    follow_on: Arc<FollowOnLane>,
}

fn read_limits() -> db::Limits {
    db::Limits {
        size: 2,
        acquire_timeout: Duration::from_millis(100),
        statement_timeout: Duration::from_millis(100),
        max_lifetime: Duration::from_secs(300),
    }
}

#[cfg(all(test, feature = "db-tests"))]
// The narrow-read isolation test uses the production snapshot query and returns
// its raw representation so its existing byte assertions remain unchanged.
fn priorities(c: &mut Client, zid: i32, env: &str) -> Result<Option<Js>> {
    Arc::new(writer_priorities::Cache::default())
        .snapshot(c, zid, env)?
        .raw_for_test()
}

/// Who a request is, as admission reads it.
enum Caller {
    /// A participant token for this conversation that is not an external
    /// id's: the only caller when the identity switch is off.
    Member(participant::Verified),
    /// Identity switch on: an external-id token for this conversation, for
    /// the external id it is bound to.
    Xid {
        member: participant::Verified,
        xid: String,
    },
    /// Identity switch on: no token, and the external id the body names.
    /// Only Node's refusals before any write are answered; the rest is
    /// handed back.
    Tokenless(Option<String>),
    /// First-contact switch on: no token and no external id, or an
    /// anonymous participant token for another conversation code (`other`,
    /// the token's code). A new person either way. Admission's reads decide;
    /// a first contact is written only after the fields.
    FirstContact { other: Option<String> },
    /// First-contact switch on: a signed-in account's participant token for
    /// another conversation code (`other`), and no external id. The account
    /// keeps its user and gets a participant in this conversation.
    Account { uid: Uid, other: String },
}

/// The person a first contact creates: the conversation's code for the
/// token, and for a signed-in account its user and subject (a standard-user
/// token); None, a new anonymous user.
struct NewParticipant {
    cid: String,
    account: Option<(Uid, String)>,
}

/// Whether a token issued for conversation code `code` is for the
/// conversation `zid`, as Node decides it: by resolved conversation, so an
/// alias of the same conversation is the same one. A code that resolves to
/// nothing is another conversation.
fn token_names(c: &mut Client, code: &str, zid: i32) -> Result<bool> {
    Ok(db::zid_for_conversation_id(c, code)? == Some(zid))
}

/// A request admission does not admit: handed back for its reason, or
/// answered with Node's refusal (status and code) before anything is written.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Turned {
    Back(&'static str),
    Answer(u16, &'static str),
    /// A first contact: nobody exists and nothing is written yet. Whether
    /// the conversation is open, read in the same admission.
    FirstContact {
        zid: i32,
        active: bool,
    },
}

/// The refusals Node's participant middleware answers for a request with no
/// token before it creates anybody. `polis_auth::admission` makes them in
/// Node's order; any other decision is handed back.
const TOKENLESS_REFUSALS: [&str; 4] = [
    "polis_err_xid_not_allowed",
    "polis_err_xid_required",
    "polis_err_treevite_auth_required",
    "polis_err_xid_owner_account",
];

/// The server-side bounds of the tokenless decision's read-only snapshot,
/// within the admission deadline.
const TOKENLESS_BOUNDS: join::Bounds = join::Bounds {
    statement: Duration::from_millis(100),
    lock: Duration::from_millis(100),
    idle: Duration::from_millis(250),
    transaction: Duration::from_millis(250),
};

/// Admission's reads. A refusal is Ok(Err(turned)); with the identity switch
/// off every one is handed back.
#[allow(clippy::too_many_arguments)]
fn admit(
    c: &mut Client,
    cid: &str,
    caller: &Caller,
    identity_on: bool,
    admins: &[i32],
    env: &str,
    cache: Arc<writer_priorities::Cache>,
    follow_on: Arc<FollowOnLane>,
) -> Result<Result<(Admitted, writer_priorities::Snapshot), Turned>> {
    let Some(zid) = db::zid_for_conversation_id(c, cid)? else {
        return Ok(Err(Turned::Back("unknown_conversation")));
    };
    let identity = match caller {
        Caller::Member(identity) => identity,
        Caller::Xid { member, xid } => {
            if let Err(turned) = xid_member(c, zid, member, xid, admins)? {
                return Ok(Err(turned));
            }
            member
        }
        Caller::Tokenless(xid) => {
            return Ok(Err(tokenless(c, zid, xid.as_deref(), admins, false)));
        }
        Caller::FirstContact { other } => {
            if let Some(code) = other
                && token_names(c, code, zid)?
            {
                return Ok(Err(Turned::Back("token_alias")));
            }
            return Ok(Err(first_contact_turn(
                c,
                zid,
                &join::Identity::Anonymous,
                admins,
            )?));
        }
        Caller::Account { uid, other } => {
            if token_names(c, other, zid)? {
                return Ok(Err(Turned::Back("token_alias")));
            }
            // The account test a member's standard-user token gets below.
            if c.query_one(
                "select coalesce(u.site_id is not null and u.site_id = owner_user.site_id, false)
                 from conversations c left join users owner_user on owner_user.uid=c.owner
                 left join users u on u.uid=$2 where c.zid=$1",
                &[&zid, &uid.0],
            )?
            .try_get::<_, bool>(0)?
            {
                return Ok(Err(Turned::Back("site_owner_standard_user")));
            }
            return Ok(Err(first_contact_turn(
                c,
                zid,
                &join::Identity::Account(*uid),
                admins,
            )?));
        }
    };

    // Node trusts a member token's participant number in a Treevite
    // conversation too; its Treevite check applies only to a request with none.
    let pid = if identity_on {
        participant::resolve_member(c, Zid(zid), identity)?
    } else {
        participant::resolve(c, Zid(zid), identity)?
    };
    let Some(pid) = pid else {
        return Ok(Err(Turned::Back("not_a_participant")));
    };
    let row = c.query_one(
        "select c.is_active, c.xid_required, c.use_xid_whitelist,
         u.site_id is not null and u.site_id = owner_user.site_id
         from conversations c left join users owner_user on owner_user.uid=c.owner
         left join users u on u.uid=$2 where c.zid=$1",
        &[&zid, &identity.uid().0],
    )?;
    // The same three tests, in the same order, as one disjunction before.
    if identity.kind == participant::Kind::StandardUser
        && row.try_get::<_, Option<bool>>(3)?.unwrap_or(false)
    {
        return Ok(Err(Turned::Back("site_owner_standard_user")));
    }
    // Node refuses neither for a caller with a member token: a required
    // external id only stops a new user, and the allow-list applies only
    // where the external id is the identity (checked in `xid_member`).
    if !identity_on {
        if row.try_get::<_, Option<bool>>(1)?.unwrap_or(false) {
            return Ok(Err(Turned::Back("xid_required")));
        }
        if row.try_get::<_, Option<bool>>(2)?.unwrap_or(false) {
            return Ok(Err(Turned::Back("xid_allowlist")));
        }
    }
    let snapshot = cache.snapshot(c, zid, env)?;
    Ok(Ok((
        Admitted {
            zid,
            pid: pid.0 as i32,
            uid: identity.uid().0,
            active: row.try_get::<_, Option<bool>>(0)?.unwrap_or(false),
            _priority_lease: None,
            priorities: cache,
            follow_on,
        },
        snapshot,
    )))
}

/// An external-id token's member, as Node checks it on every vote: the
/// signed user's account first (hybrid auth, `requireXidParticipantAccount`),
/// then the owner's allow-list (`_requireXidAllowed`). An account check that
/// cannot be read is handed back, never refused.
fn xid_member(
    c: &mut Client,
    zid: i32,
    member: &participant::Verified,
    xid: &str,
    admins: &[i32],
) -> Result<Result<(), Turned>> {
    let admin_uids: Vec<Uid> = admins.iter().copied().map(Uid).collect();
    let account = xid_account::Check {
        db: &mut PostgresLookup(c),
        admin_uids: &admin_uids,
    }
    .require_participant(member.uid());
    match account {
        Ok(()) => {}
        Err(xid_account::Refusal::Privileged(_)) => {
            return Ok(Err(Turned::Answer(403, "polis_err_xid_owner_account")));
        }
        Err(xid_account::Refusal::CheckFailed) => {
            return Ok(Err(Turned::Back("account_check_failed")));
        }
    }
    Ok(match join::xid_allowed(c, Zid(zid), xid)? {
        Some(true) => Ok(()),
        Some(false) => Err(Turned::Answer(403, "polis_err_xid_not_allowed")),
        None => Err(Turned::Back("unknown_conversation")),
    })
}

/// A first contact's admission: the decision for `identity` (a new anonymous
/// user, or a signed-in account), and, when it creates, whether the
/// conversation is open. Nothing is written.
fn first_contact_turn(
    c: &mut Client,
    zid: i32,
    identity: &join::Identity<'_>,
    admins: &[i32],
) -> Result<Turned> {
    Ok(match decided(c, zid, identity, admins, true) {
        Turned::FirstContact { .. } => {
            let row = c.query_one(
                "select coalesce(is_active,false),
                 coalesce(xid_required,false) or coalesce(use_xid_whitelist,false)
                 or coalesce(treevite_enabled,false)
                 from conversations where zid=$1",
                &[&zid],
            )?;
            let (active, rules) = (row.try_get::<_, bool>(0)?, row.try_get::<_, bool>(1)?);
            if !active && rules {
                // Closed, and an identity rule Node checks before it
                // creates anybody: Node answers that rule. Handed back.
                Turned::Back("no_token")
            } else {
                Turned::FirstContact { zid, active }
            }
        }
        turned => turned,
    })
}

/// A request with no token: what admission's participation entry decides, by
/// reads alone in one read-only snapshot. Node's refusals before any write
/// are answered; everything else (a first contact, which writes) goes back.
///
/// With `first_contact`, a decision to create a user and a participant is a
/// first contact (`Turned::FirstContact`, its `active` still to be read).
fn tokenless(
    c: &mut Client,
    zid: i32,
    xid: Option<&str>,
    admins: &[i32],
    first_contact: bool,
) -> Turned {
    let identity = join::Identity::without_token(xid);
    decided(c, zid, &identity, admins, first_contact && xid.is_none())
}

/// What admission's participation entry decides for `identity`, by reads
/// alone in one read-only snapshot. Node's refusals before any write are
/// answered. With `first_contact`, a decision to create (a user and a
/// participant for an anonymous identity, a participant for an account) is
/// a first contact; everything else goes back.
fn decided(
    c: &mut Client,
    zid: i32,
    identity: &join::Identity<'_>,
    admins: &[i32],
    first_contact: bool,
) -> Turned {
    let admin_uids: Vec<Uid> = admins.iter().copied().map(Uid).collect();
    let account = matches!(identity, join::Identity::Account(_));
    let Ok(mut snapshot) = join::snapshot(c, &TOKENLESS_BOUNDS) else {
        return Turned::Back("admission_unavailable");
    };
    let decision = snapshot.decide(&join::Participation {
        zid: Zid(zid),
        identity,
        create_if_missing: true,
        admin_uids: &admin_uids,
    });
    snapshot.end();
    match decision.map(|decision| decision.outcome) {
        Ok(join::Outcome::Refused(refusal)) if TOKENLESS_REFUSALS.contains(&refusal.code) => {
            Turned::Answer(refusal.status, refusal.code)
        }
        Ok(join::Outcome::CreateUserAndParticipant) if first_contact && !account => {
            Turned::FirstContact { zid, active: false }
        }
        Ok(join::Outcome::CreateParticipant) if first_contact && account => {
            Turned::FirstContact { zid, active: false }
        }
        // Admission refuses a closed conversation before its other rules;
        // Node creates first and then refuses. Rust refuses first, after the
        // fields (`admit` reads the rules the refusal did not reach).
        Ok(join::Outcome::Refused(refusal))
            if first_contact && refusal.code == "polis_err_conversation_is_closed" =>
        {
            Turned::FirstContact { zid, active: false }
        }
        Ok(_) if account => Turned::Back("account_not_created"),
        Ok(_) => Turned::Back("no_token"),
        Err(_) => Turned::Back("admission_unavailable"),
    }
}

fn next(
    c: &mut Client,
    a: &Admitted,
    env: &str,
    unit: f64,
    lang: Option<&str>,
) -> Result<Option<Js>> {
    next_selecting(c, a, env, unit, lang, None)
}

/// What observe mode records of a selection, in process. `voted` is the
/// statement the copied vote is on: it counts as voted, as it does after the
/// live writer's commit and after Node's insert, whether or not Node's commit
/// is visible. The statement numbers here (`voted`, `candidates`, `next_tid`)
/// never reach a line: the line carries how many candidates there were and
/// whether a next statement was selected.
#[derive(Debug, Default)]
pub(super) struct Selection {
    pub(super) voted: i32,
    pub(super) candidates: Vec<i32>,
    pub(super) weights_tick: Option<i64>,
    pub(super) next_tid: Option<i32>,
    pub(super) remaining: Option<i64>,
    pub(super) total: Option<i64>,
}

impl Selection {
    pub(super) fn new(voted: i32) -> Self {
        Self {
            voted,
            ..Self::default()
        }
    }
}

/// `next`. With `observed` None (live) the statements, their text and their
/// order are next's own. With Some, the voted statement leaves the candidates
/// and the remaining count, and the selection is recorded.
fn next_selecting(
    c: &mut Client,
    a: &Admitted,
    env: &str,
    unit: f64,
    lang: Option<&str>,
    mut observed: Option<&mut Selection>,
) -> Result<Option<Js>> {
    let strict = c
        .query_one(
            "select strict_moderation from conversations where zid=$1",
            &[&a.zid],
        )?
        .try_get::<_, Option<bool>>(0)?
        .unwrap_or(false);
    let moderation = if strict {
        "mod = 1".to_owned()
    } else {
        format!("mod != {REJECTED_COMMENT_MOD}")
    };
    let rows = c.query(
        &format!(
            "select tid from comments where zid=$1
         and tid not in (select tid from votes_latest_unique where zid=$1 and pid=$2)
         and active=true and {moderation} and velocity>0
         order by created"
        ),
        &[&a.zid, &a.pid],
    )?;
    let mut tids = rows
        .iter()
        .map(|row| row.try_get::<_, i32>("tid"))
        .collect::<Result<Vec<_>, _>>()?;
    if let Some(observed) = observed.as_deref() {
        tids.retain(|tid| *tid != observed.voted);
    }
    let snapshot = a.priorities.snapshot(c, a.zid, env)?;
    let weights_tick = snapshot.tick();
    let weights = snapshot.validate()?;
    let counts = match observed.as_deref() {
        None => c.query_one(
            "with v as (select * from votes_latest_unique where zid=$1 and pid=$2),
         c as (select * from get_visible_comments($1)),
         remaining as (select count(*) as n from c left join v on c.tid=v.tid where v.vote is null),
         total as (select count(*) as n from c)
         select remaining.n,total.n from remaining,total",
            &[&a.zid, &a.pid],
        )?,
        Some(observed) => c.query_one(
            "with v as (select * from votes_latest_unique where zid=$1 and pid=$2),
         c as (select * from get_visible_comments($1)),
         remaining as (select count(*) as n from c left join v on c.tid=v.tid where v.vote is null and c.tid <> $3),
         total as (select count(*) as n from c)
         select remaining.n,total.n from remaining,total",
            &[&a.zid, &a.pid, &observed.voted],
        )?,
    };
    if let Some(observed) = observed.as_deref_mut() {
        observed.candidates.clone_from(&tids);
        observed.weights_tick = weights_tick;
    }
    if tids.is_empty() {
        return Ok(None);
    }
    let (index, random) = weights.select(&tids, unit)?;
    let selected = c.query_one(
        "select * from comments where zid=$1 and tid=$2",
        &[&a.zid, &tids[index]],
    )?;
    let mut row = comments::project(&selected)?
        .as_obj()
        .cloned()
        .context("invalid statement")?;
    row.set("randomN", Js::Num(random));
    let (remaining, total) = (counts.try_get::<_, i64>(0)?, counts.try_get::<_, i64>(1)?);
    row.set("remaining", Js::Num(remaining as f64));
    row.set("total", Js::Num(total as f64));
    if let Some(observed) = observed {
        observed.next_tid = Some(tids[index]);
        observed.remaining = Some(remaining);
        observed.total = Some(total);
    }
    // Node skips the stored read entirely without a requested language. The
    // provider is disabled at startup; this follow-on never authorizes replay
    // of a committed vote.
    let translations = if lang.is_some_and(|lang| !lang.is_empty()) {
        // Optional translation failure keeps the selected statement, as Node
        // does. This SELECT uses the existing reads client/statement deadline,
        // after commit, with no provider, transaction or explicit lock.
        stored_translations(c, a.zid, tids[index]).unwrap_or_default()
    } else {
        vec![]
    };
    row.set("translations", Js::Arr(translations));
    Ok(Some(Js::Obj(row)))
}

// Match next()'s candidate eligibility, not its total/remaining counts (which
// deliberately include muted comments). EXISTS stops at the first eligible row
// without sorting, materializing every id, reading priorities or translations.
fn exhausted(c: &mut Client, a: &Admitted) -> Result<bool> {
    let strict = c
        .query_one(
            "select strict_moderation from conversations where zid=$1",
            &[&a.zid],
        )?
        .try_get::<_, Option<bool>>(0)?
        .unwrap_or(false);
    let moderation = if strict {
        "mod = 1".to_owned()
    } else {
        format!("mod != {REJECTED_COMMENT_MOD}")
    };
    Ok(!c
        .query_one(
            &format!(
                "select exists(select 1 from comments where zid=$1
         and tid not in (select tid from votes_latest_unique where zid=$1 and pid=$2)
         and active=true and {moderation} and velocity>0)"
            ),
            &[&a.zid, &a.pid],
        )?
        .try_get::<_, bool>(0)?)
}

// Node's SELECT * returns all languages/sources, in database order. Preserve
// both that row order and column order; int8 values remain strings, as in pg.
fn stored_translations(c: &mut Client, zid: i32, tid: i32) -> Result<Vec<Js>> {
    c.query(
        "select * from comment_translations where zid = ($1) and tid = ($2);",
        &[&zid, &tid],
    )?
    .iter()
    .map(|row| {
        let mut out = js::Obj::new();
        for (index, column) in row.columns().iter().enumerate() {
            let value = match *column.type_() {
                postgres::types::Type::INT4 => row
                    .try_get::<_, Option<i32>>(index)?
                    .map(|n| Js::Num(f64::from(n))),
                postgres::types::Type::INT8 => row
                    .try_get::<_, Option<i64>>(index)?
                    .map(|n| Js::Str(n.to_string())),
                postgres::types::Type::VARCHAR | postgres::types::Type::TEXT => {
                    row.try_get::<_, Option<String>>(index)?.map(Js::Str)
                }
                _ => anyhow::bail!("unsupported translation column"),
            };
            out.set(column.name(), value.unwrap_or(Js::Null));
        }
        Ok(Js::Obj(out))
    })
    .collect()
}

enum Outcome {
    Success(DurableSuccess),
    Failure(u16, &'static str),
}

fn append(c: &mut Client, a: &Admitted, fields: &ParsedFields) -> Result<AcceptedVote> {
    let mut tx = c
        .build_transaction()
        .isolation_level(postgres::IsolationLevel::ReadCommitted)
        .start()?;
    // Keep the writer pool's statement bound (one second in production),
    // with local lock and idle bounds for the whole vote transaction.
    tx.batch_execute(
        "SET LOCAL lock_timeout='100ms';
         SET LOCAL statement_timeout FROM CURRENT;
         SET LOCAL idle_in_transaction_session_timeout='1s'",
    )?;
    let vote = append_in_transaction(&mut tx, a, fields)?;
    // A failed acknowledgement cannot authorize a Node replay. Keep commit
    // errors distinct from statement rejections even if they carry SQLSTATE.
    tx.commit()
        .map_err(|error| anyhow::anyhow!("vote commit acknowledgement unavailable: {error}"))?;
    Ok(vote)
}

fn append_in_transaction(
    tx: &mut postgres::Transaction<'_>,
    a: &Admitted,
    fields: &ParsedFields,
) -> Result<AcceptedVote> {
    let storage = i16::try_from(contract::stored_vote(fields.vote))?;
    let tid = fields.tid as i32;
    // Establish a missing key so concurrent first votes serialize too. This
    // provisional row is invisible until commit and rolls back on any failure.
    let inserted = tx.execute(
        "insert into votes_latest_unique(zid,pid,tid,vote,weight_x_32767,modified)
         values($1,$2,$3,$4,0,now_as_millis())
         on conflict (zid,pid,tid) do nothing",
        &[&a.zid, &a.pid, &tid, &storage],
    )?;
    let latest = tx.query_one(
        "select vote,modified from votes_latest_unique
         where zid=$1 and pid=$2 and tid=$3 for update",
        &[&a.zid, &a.pid, &tid],
    )?;
    let replayed = inserted == 0 && latest.try_get::<_, Option<i16>>(0)? == Some(storage);
    let created = if replayed {
        latest.try_get(1)?
    } else {
        // The existing INSERT rule updates latest choice/time and retains its
        // weight. No history scan, participant lock or conversation lock.
        tx.query_one(
            "insert into votes(pid,zid,tid,vote,weight_x_32767,high_priority)
             values($1,$2,$3,$4,0,$5) returning created",
            &[&a.pid, &a.zid, &tid, &storage, &fields.high_priority],
        )?
        .try_get(0)?
    };
    Ok(AcceptedVote {
        tid,
        vote: fields.vote.wire(),
        created,
        replayed,
    })
}

fn star(c: &mut Client, a: &Admitted, fields: &ParsedFields, created: i64) -> Result<()> {
    if let Some(starred) = fields.starred {
        c.execute(
            "insert into stars(pid,zid,tid,starred,created) values($1,$2,$3,$4,$5)",
            &[
                &a.pid,
                &a.zid,
                &(fields.tid as i32),
                &i32::from(starred),
                &created,
            ],
        )?;
    }
    Ok(())
}

fn complete(
    c: &mut Client,
    a: &Admitted,
    env: &str,
    unit: f64,
    lang: Option<&str>,
) -> Result<contract::Success> {
    let next_comment = next(c, a, env, unit, lang)?
        .map(|next| {
            serde_json::value::RawValue::from_string(js::stringify(&next))
                .map(contract::NextComment)
        })
        .transpose()?;
    Ok(contract::Success {
        next_comment,
        current_pid: a.pid,
        auth: None,
    })
}

#[cfg(test)]
#[path = "post_votes_tests.rs"]
mod tests;

fn notification_state(c: &mut Client, a: &Admitted) -> Result<()> {
    c.execute(
        "update participants set last_interaction=now_as_millis(),nsli=0 where zid=$1 and uid=$2",
        &[&a.zid, &a.uid],
    )?;
    Ok(())
}

/// A request admission accepted: an existing member of an open or closed
/// conversation, with valid fields.
struct Prepared {
    admitted: Admitted,
    fields: ParsedFields,
    res: Res,
    admission: Duration,
    /// A first contact: who is to be created, and the conversation's code
    /// for the token. Nobody is written yet; `admitted` carries no
    /// participant until `create`.
    first_contact: Option<NewParticipant>,
}

/// A request handed back or refused before dispatch: the live answer, and the
/// reason observe mode records.
struct Refused {
    out: Outgoing,
    reason: &'static str,
    /// The member (zid, pid) when admission accepted the request.
    member: Option<(i32, i32)>,
    /// The fields, when they parsed and the conversation was closed.
    fields: Option<ParsedFields>,
    admission: Option<Duration>,
}

impl Refused {
    #[cfg_attr(test, track_caller)]
    fn handback(reason: &'static str) -> Box<Self> {
        Box::new(Self {
            out: route::bad_gateway(),
            reason,
            member: None,
            fields: None,
            admission: None,
        })
    }

    /// Node's answer to a request refused before anything is written.
    fn answered(out: Outgoing, reason: &'static str) -> Box<Self> {
        Box::new(Self {
            out,
            reason,
            member: None,
            fields: None,
            admission: None,
        })
    }
}

/// Everything before dispatch, for live and observe alike: the request
/// shape, the token, the admin refusal, admission under its deadline, the
/// fields, the tid range and the closed conversation.
async fn prepare(
    app: &App,
    writer: Admission<'_>,
    req: &Request,
    res: Res,
) -> Result<Prepared, Box<Refused>> {
    let (cid, raw, named) = if writer.identity {
        request_identity(req)
    } else {
        request_reasoned(req).map(|(cid, raw)| (cid, raw, None))
    }
    .map_err(Refused::handback)?;
    let auth = req.headers.get("authorization");
    let now = (crate::clock::now_ms() / 1000.0) as u64;
    let mut account = None;
    let caller = match auth {
        None if writer.first_contact && named.is_none() => Caller::FirstContact { other: None },
        None if writer.identity => Caller::Tokenless(named),
        None => return Err(Refused::handback("no_token")),
        Some(auth) if writer.identity => 'caller: {
            // The account check of an external-id token runs with
            // admission's reads (`xid_member`), on the signed user.
            let mut deferred =
                |_: Uid| Ok::<Option<xid_account::Account>, polis_auth::Unavailable>(None);
            let scoped = writer
                .verifier
                .verify_for_request(
                    auth,
                    &cid,
                    named.as_deref(),
                    now,
                    &mut xid_account::Check {
                        db: &mut deferred,
                        admin_uids: &[],
                    },
                )
                .ok()
                .flatten();
            // A token for another conversation code, with the first-contact
            // switch on and no external id named: an anonymous token is a
            // new person, a signed-in account's keeps its user. Whether the
            // code is another conversation is decided in admission, by
            // resolved conversation.
            if writer.first_contact
                && named.is_none()
                && let Some(scoped) = scoped.as_ref().filter(|s| !s.same_conversation())
            {
                let other = scoped.token_conversation().to_owned();
                match (scoped.kind, scoped.uid(), scoped.subject()) {
                    (participant::Kind::Anonymous, None, _) => {
                        break 'caller Caller::FirstContact { other: Some(other) };
                    }
                    (participant::Kind::StandardUser, Some(uid), Some(subject)) => {
                        if writer.admins.contains(&uid.0) {
                            return Err(Refused::handback("admin"));
                        }
                        account = Some((uid, subject.to_owned()));
                        break 'caller Caller::Account { uid, other };
                    }
                    _ => {}
                }
            }
            let Some((member, xid)) = scoped
                .as_ref()
                .and_then(|scoped| Some((scoped.member()?, scoped.xid().map(str::to_owned))))
            else {
                return Err(Refused::handback("token_refused"));
            };
            match (member.kind, xid) {
                (participant::Kind::Xid, Some(xid)) => {
                    // Node's hybrid auth refuses an administrator's
                    // external-id token before it reads the conversation.
                    if writer.admins.contains(&member.uid().0) {
                        return Err(Refused::answered(
                            route::fail_json(
                                req,
                                res,
                                403,
                                Js::Str("polis_err_xid_owner_account".into()),
                            ),
                            "xid_owner_account",
                        ));
                    }
                    Caller::Xid { member, xid }
                }
                (participant::Kind::Xid, None) => return Err(Refused::handback("token_refused")),
                _ => Caller::Member(member),
            }
        }
        Some(auth) => match writer.verifier.verify(auth, &cid, now) {
            Some(identity) => Caller::Member(identity),
            None => return Err(Refused::handback("token_refused")),
        },
    };
    if let Caller::Member(identity) = &caller
        && writer.admins.contains(&identity.uid().0)
    {
        return Err(Refused::handback("admin"));
    }
    let env = app.math_env.clone();
    let conversation = cid.clone();
    let started = tokio::time::Instant::now();
    let admission = tokio::time::timeout(ADMISSION_DEADLINE, async {
        let cache = writer.priorities.clone();
        let follow_on = writer.follow_on.clone();
        let identity_on = writer.identity;
        let admins = writer.admins.to_vec();
        let prepared = writer
            .reads
            .with(move |c| {
                admit(
                    c,
                    &cid,
                    &caller,
                    identity_on,
                    &admins,
                    &env,
                    cache,
                    follow_on,
                )
            })
            .await
            .map_err(|_| Turned::Back("admission_unavailable"))?;
        let (mut admitted, snapshot) = prepared?;
        // Parsing, coalescing and shape validation hold no admission SQL
        // slot. A timed-out first caller can leave the generation warming,
        // but cannot retain a connection or dispatch a vote afterwards.
        admitted._priority_lease = Some(
            match tokio::task::spawn_blocking(move || snapshot.validate()).await {
                Ok(Ok(weights)) => weights,
                Ok(Err(error)) if error.is::<writer_priorities::CacheBusy>() => {
                    return Err(Turned::Back("priorities_busy"));
                }
                Ok(Err(_)) => return Err(Turned::Back("priorities_invalid")),
                Err(_) => return Err(Turned::Back("admission_unavailable")),
            },
        );
        Ok::<_, Turned>(admitted)
    })
    .await;
    let admission_time = started.elapsed();
    let mut first_contact = None;
    let admitted = match admission {
        Ok(Ok(admitted)) => admitted,
        // Nothing is written before the fields parse and the conversation is
        // found open, below: a first contact is refused first.
        Ok(Err(Turned::FirstContact { zid, active })) => {
            first_contact = Some(NewParticipant {
                cid: conversation,
                account: account.take(),
            });
            Admitted {
                zid,
                pid: -1,
                uid: 0,
                active,
                _priority_lease: None,
                priorities: writer.priorities.clone(),
                follow_on: writer.follow_on.clone(),
            }
        }
        Ok(Err(Turned::Back(reason))) => {
            let mut refused = Refused::handback(reason);
            refused.admission = Some(admission_time);
            return Err(refused);
        }
        Ok(Err(Turned::Answer(status, code))) => {
            let mut refused = Refused::answered(
                route::fail_json(req, res, status, Js::Str(code.into())),
                code,
            );
            refused.admission = Some(admission_time);
            return Err(refused);
        }
        Err(_) => {
            let mut refused = Refused::handback("admission_timeout");
            refused.admission = Some(admission_time);
            return Err(refused);
        }
    };
    let member = first_contact
        .is_none()
        .then_some((admitted.zid, admitted.pid));
    let refused = |out, reason| {
        Box::new(Refused {
            out,
            reason,
            member,
            fields: None,
            admission: Some(admission_time),
        })
    };
    let fields = match raw.parse_fields() {
        Ok(fields) => fields,
        Err(_) => return Err(refused(route::parameter_error(app, req, res), "parameter")),
    };
    if !(i32::MIN as f64..=i32::MAX as f64).contains(&fields.tid) {
        return Err(refused(route::bad_gateway(), "tid_range"));
    }
    if !admitted.active {
        let mut closed = refused(
            route::fail_json(
                req,
                res,
                403,
                Js::Str("polis_err_conversation_is_closed".into()),
            ),
            "closed",
        );
        closed.fields = Some(fields);
        return Err(closed);
    }
    Ok(Prepared {
        admitted,
        fields,
        res,
        admission: admission_time,
        first_contact,
    })
}

pub(crate) async fn handle(app: &App, req: &Request, res: Res) -> Outgoing {
    // A process holds one mode. Observe is checked first, so a copy can never
    // reach the live writer's dispatch.
    if let Some(observer) = &app.post_votes_observe {
        return observe::handle(app, observer, req, res).await;
    }
    let Some(writer) = &app.post_votes else {
        return route::bad_gateway();
    };
    let Prepared {
        mut admitted,
        fields,
        res,
        admission: _,
        first_contact,
    } = match prepare(app, writer.admission(), req, res).await {
        Ok(prepared) => prepared,
        Err(refused) => return refused.out,
    };
    // Publish a receipt immediately after SQL acknowledges the vote transaction commit. A
    // disconnected caller cannot cancel the task. A deadline without a receipt
    // is explicitly unknown (202), never a failure that nginx may replay.
    // Once the process is stopping nothing more is dispatched: this vote is
    // handed back, marked, and nginx gives it to Node (`crate::shutdown`).
    let Some(active_dispatch) = ActiveDispatch::begin() else {
        return route::bad_gateway();
    };
    // A first contact is written after dispatch has begun, so a stopping
    // process hands it back before anyone exists. Once the user and the
    // participant are committed nothing is handed back: Node would make a
    // second person. Its token is signed at once, so every reply from here
    // on carries it: the vote's 200, its 406 and 500, and the 202 receipt.
    let auth = match (&first_contact, &writer.first_contact) {
        (None, _) => None,
        (Some(_), None) => return route::bad_gateway(),
        (Some(new), Some(lane)) => match create(
            lane,
            &writer.admins,
            admitted.zid,
            new.account.as_ref().map(|(uid, _)| *uid),
        )
        .await
        {
            Ok(created) => {
                admitted.pid = created.pid.0 as i32;
                admitted.uid = created.uid.0;
                issue(lane, &created, new).await
            }
            Err(reason) => {
                first_contact_handed_back(reason, admitted.zid);
                return route::bad_gateway();
            }
        },
    };
    let receipt = Arc::new(Mutex::new(None));
    let fallback_pid = admitted.pid;
    let fallback_star = fields.starred.is_some();
    #[cfg(all(test, feature = "db-tests"))]
    if let Some(observation) = &active_dispatch.observation {
        observation.lock().unwrap().receipt = Some(receipt.clone());
    }
    let reply_deadline = tokio::time::Instant::now() + DISPATCH_DEADLINE;
    let task = tokio::spawn(dispatch(
        writer.pool.clone(),
        writer.reads.clone(),
        writer.background.clone(),
        admitted,
        fields,
        app.math_env.clone(),
        next_comment::draw(req),
        receipt.clone(),
        reply_deadline,
        active_dispatch,
    ));
    match tokio::time::timeout_at(reply_deadline, task).await {
        Ok(Ok(Ok(Outcome::Success(mut body)))) => {
            body.auth = auth;
            accepted(req, res, body)
        }
        Ok(Ok(Ok(Outcome::Failure(status, code)))) => failed(req, res, status, code, auth.as_ref()),
        _ => {
            let vote = receipt.lock().unwrap_or_else(|e| e.into_inner()).clone();
            if let Some(vote) = vote {
                let mut body = degraded(fallback_pid, vote, fallback_star);
                body.auth = auth;
                accepted(req, res, body)
            } else {
                // A fixed body of two strings and, at most, the token.
                let body = serde_json::to_string(&contract::UnknownAcceptance::new(auth))
                    .unwrap_or_else(|_| r#"{"acceptance":"unknown","retry":"same_vote"}"#.into());
                route::json_text(req, res, 202, body)
            }
        }
    }
}

/// Node's `failJson` body (`error`, `message`, `status`), with the token of a
/// participant this request created as its last key, as Node's token
/// injector places it on a handler's failure. With no token, `fail_json`'s
/// bytes.
fn failed(
    req: &Request,
    res: Res,
    status: u16,
    code: &'static str,
    auth: Option<&contract::Auth>,
) -> Outgoing {
    let Some(auth) = auth else {
        return route::fail_json(req, res, status, Js::Str(code.into()));
    };
    match serde_json::to_string(&contract::Failure {
        error: code.into(),
        message: code.into(),
        status,
        auth: Some(auth.clone()),
    }) {
        Ok(body) => route::json_text(req, res, status, body),
        Err(_) => route::fail_json(req, res, status, Js::Str(code.into())),
    }
}

fn degraded(pid: i32, vote: AcceptedVote, star: bool) -> DurableSuccess {
    DurableSuccess {
        next_comment: None,
        current_pid: pid,
        vote,
        follow_on: FollowOn {
            star: if star {
                FollowOnState::Degraded
            } else {
                FollowOnState::Absent
            },
            next_comment: FollowOnState::Degraded,
            notifications: NotificationState::BestEffort,
        },
        auth: None,
    }
}

/// A first contact's writes, on its own pool: a user, the participant's
/// extended row and the participant under the participant-number lock, in
/// one transaction (`polis_auth::admission`). Err is the reason it is handed
/// back; nothing was committed, except for the commit whose outcome is
/// unknown.
async fn create(
    lane: &FirstContact,
    admins: &[i32],
    zid: i32,
    account: Option<Uid>,
) -> Result<join::Admitted, &'static str> {
    let admin_uids: Vec<Uid> = admins.iter().copied().map(Uid).collect();
    let admitted = lane
        .pool
        .with(move |c| {
            Ok(join::admit_within(
                c,
                &join::Request {
                    zid: Zid(zid),
                    identity: account.map_or(join::Identity::Anonymous, join::Identity::Account),
                    entry: join::Entry::Participation {
                        create_if_missing: true,
                    },
                    admin_uids: &admin_uids,
                    x_name: None,
                    x_email: None,
                    x_profile_image_url: None,
                },
                &FIRST_CONTACT_BOUNDS,
            ))
        })
        .await;
    match admitted {
        // No connection within 100 ms, or none could be opened: nothing ran.
        Err(_) => Err("first_contact_unavailable"),
        // A new anonymous user and its participant; for an account, a new
        // participant of that user. Anything else was not this request's.
        Ok(Ok(Some(admitted)))
            if admitted.new_participant
                && match account {
                    None => admitted.new_user,
                    Some(uid) => !admitted.new_user && admitted.uid == uid,
                } =>
        {
            Ok(admitted)
        }
        Ok(Ok(_)) => Err("first_contact_not_created"),
        Ok(Err(join::Error::Refused(_))) => Err("first_contact_refused"),
        // A lock wait past 100 ms, a statement past one second, a dropped
        // connection: rolled back.
        Ok(Err(join::Error::Unavailable)) => Err("first_contact_unavailable"),
        Ok(Err(join::Error::CommitUnknown)) => Err(FIRST_CONTACT_COMMIT_UNKNOWN),
    }
}

const FIRST_CONTACT_COMMIT_UNKNOWN: &str = "first_contact_commit_unknown";

/// A first contact handed back. A commit whose acknowledgement was lost may
/// have created a participant that Node, given the request, creates again:
/// every one is a line and a count (`/health`), never silent.
fn first_contact_handed_back(reason: &'static str, zid: i32) {
    if reason == FIRST_CONTACT_COMMIT_UNKNOWN {
        let count = FIRST_CONTACT_UNKNOWN.fetch_add(1, Ordering::Relaxed) + 1;
        eprintln!(
            "{{\"event\":\"post_votes_first_contact_commit_unknown\",\"zid\":{zid},\"count\":{count}}}"
        );
    } else {
        let count = FIRST_CONTACT_HANDED_BACK.fetch_add(1, Ordering::Relaxed) + 1;
        if count.is_power_of_two() {
            eprintln!(
                "{{\"event\":\"post_votes_first_contact_handed_back\",\"reason\":\"{reason}\",\"count\":{count}}}"
            );
        }
    }
}

/// The token for a participant this request created, signed after the
/// commit, off the async runtime, as Node issues it: anonymous for a new
/// user, a standard user's (its subject from the token it presented) for an
/// account.
async fn issue(
    lane: &FirstContact,
    created: &join::Admitted,
    new: &NewParticipant,
) -> Option<contract::Auth> {
    let keys = lane.keys.clone();
    let (issuer, audience, cid) = (lane.issuer.clone(), lane.audience.clone(), new.cid.clone());
    let subject = new.account.as_ref().map(|(_, subject)| subject.clone());
    let (uid, pid) = (created.uid, created.pid);
    let token = tokio::task::spawn_blocking(move || {
        let identity = match subject.as_deref() {
            None => polis_auth::participant_mint::Identity::anonymous(uid),
            Some(subject) => polis_auth::participant_mint::Identity::standard_user(uid, subject)?,
        };
        polis_auth::participant_mint::mint(&keys, identity, &cid, pid, &issuer, &audience, || {
            (crate::clock::now_ms() / 1000.0) as u64
        })
    })
    .await;
    match token {
        Ok(Ok(token)) => Some(contract::Auth {
            token,
            token_type: "Bearer".into(),
            // Node's one year (ensure-participant.ts, the token's lifetime).
            expires_in: 31_536_000,
        }),
        _ => {
            eprintln!("{{\"event\":\"post_votes_first_contact_token_unavailable\"}}");
            None
        }
    }
}

fn accepted(req: &Request, res: Res, body: DurableSuccess) -> Outgoing {
    // A fixed receipt of integers/bool is always serializable. Even a future
    // optional-body codec error must retain this receipt with HTTP 200.
    let fallback = format!(
        "{{\"currentPid\":{},\"vote\":{{\"tid\":{},\"vote\":{},\"created\":{},\"replayed\":{}}},\"followOn\":{{\"star\":\"{}\",\"nextComment\":\"degraded\",\"notifications\":\"best_effort\"}}}}",
        body.current_pid,
        body.vote.tid,
        body.vote.vote,
        body.vote.created,
        body.vote.replayed,
        if body.follow_on.star == FollowOnState::Absent {
            "absent"
        } else {
            "degraded"
        }
    );
    let encoded = serde_json::to_string(&body);
    if encoded.is_err()
        || body.follow_on.star == FollowOnState::Degraded
        || body.follow_on.next_comment == FollowOnState::Degraded
        || body.follow_on.notifications == NotificationState::Degraded
    {
        let count = DEGRADED.fetch_add(1, Ordering::Relaxed) + 1;
        if count.is_power_of_two() {
            eprintln!(
                "{{\"event\":\"post_votes_durable_accepted_with_degraded_follow_on\",\"count\":{count}}}"
            );
        }
    }
    route::json_text(req, res, 200, encoded.unwrap_or(fallback))
}

#[allow(clippy::too_many_arguments)]
async fn dispatch(
    pool: Arc<db::Pool>,
    reads: Arc<db::Pool>,
    background: Arc<NotificationPool>,
    admitted: Admitted,
    fields: ParsedFields,
    env: String,
    unit: f64,
    receipt: Arc<Mutex<Option<AcceptedVote>>>,
    reply_deadline: tokio::time::Instant,
    _active_dispatch: ActiveDispatch,
) -> Result<Outcome> {
    let a = admitted.clone();
    let f = fields.clone();
    let alarm_after = DISPATCH_ACQUIRE_ALARM;
    #[cfg(all(test, feature = "db-tests"))]
    let observation = _active_dispatch.observation.clone();
    #[cfg(all(test, feature = "db-tests"))]
    let alarm_after = observation
        .as_ref()
        .and_then(|o| o.lock().unwrap().acquire_alarm_after)
        .unwrap_or(alarm_after);
    let (zid, tid) = (admitted.zid, fields.tid);
    let created = pool
        .with_acquire_alarm(alarm_after, move || {
            ACQUIRE_ALARM_HITS.fetch_add(1, Ordering::Relaxed);
            eprintln!(
                "{{\"event\":\"post_votes_writer_acquire_alarm\",\"alarmMs\":{},\"zid\":{zid},\"tid\":{tid}}}",
                alarm_after.as_millis()
            );
            #[cfg(all(test, feature = "db-tests"))]
            if let Some(observation) = observation {
                observation.lock().unwrap().acquire_alarms += 1;
            }
        }, move |c| {
            match append(c, &a, &f) {
                Ok(vote) => Ok(Ok(vote)),
                Err(error) => match error
                    .downcast_ref::<postgres::Error>()
                    .and_then(postgres::Error::code)
                {
                    Some(&postgres::error::SqlState::UNIQUE_VIOLATION) => {
                        Ok(Err(Outcome::Failure(406, "polis_err_vote_duplicate")))
                    }
                    Some(_) => Ok(Err(Outcome::Failure(500, "polis_err_vote"))),
                    // A broken connection or commit failure can hide a committed vote.
                    None => Err(error),
                },
            }
        })
        .await
        .inspect_err(|error| {
            if let Some(timeout) = error.downcast_ref::<db::DispatchedAcquireTimeout>() {
                eprintln!(
                    "{{\"event\":\"post_votes_writer_acquire_cutoff\",\"zid\":{zid},\"tid\":{tid},\"wait_ms\":{}}}",
                    timeout.waited.as_millis()
                );
            }
        })?;
    let created = match created {
        Ok(created) => created,
        Err(outcome) => return Ok(outcome),
    };
    *receipt.lock().unwrap_or_else(|e| e.into_inner()) = Some(created.clone());
    let notified = schedule_notification(background.clone(), admitted.clone());
    #[cfg(all(test, feature = "db-tests"))]
    if let Some(observation) = &_active_dispatch.observation {
        observation.lock().unwrap().notification_scheduled = notified;
    }
    let mut body = degraded(admitted.pid, created.clone(), fields.starred.is_some());
    if !notified {
        body.follow_on.notifications = NotificationState::Degraded;
    }
    let lang = fields.lang.clone();
    if fields.starred.is_some() {
        let a = admitted.clone();
        if pool
            .with(move |c| star(c, &a, &fields, created.created))
            .await
            .is_err()
        {
            return Ok(Outcome::Success(body));
        }
        body.follow_on.star = FollowOnState::Complete;
    }
    let a = admitted.clone();
    // Waiting is post-receipt: it owns no database connection and can outlive
    // the unchanged HTTP deadline. At most one follow-on enters the reads
    // pool, leaving the other existing slot for admission.
    let Ok(permits) = admitted.follow_on.acquire_until(reply_deadline).await else {
        return Ok(Outcome::Success(body));
    };
    #[cfg(all(test, feature = "db-tests"))]
    let selection_observation = _active_dispatch.observation.clone();
    let selection_started = tokio::time::Instant::now();
    if let Ok(completed) = reads
        .with_acquire_alarm(
            DISPATCH_ACQUIRE_ALARM,
            || eprintln!("{{\"event\":\"post_votes_follow_on_acquire_alarm\"}}"),
            move |c| {
                // Keep both capacity limits until the blocking work ends,
                // including when its awaiting future has been dropped.
                let _permits = permits;
                if !a.follow_on.can_finish(reply_deadline) {
                    // Too little time remains for a full selection, or the
                    // reply has already gone. Keep exhaustion analytics without
                    // spending the lane on a row unlikely to reach the caller.
                    Ok((None, exhausted(c, &a)?))
                } else {
                    #[cfg(all(test, feature = "db-tests"))]
                    if let Some(observation) = selection_observation {
                        observation.lock().unwrap().selection_started = true;
                    }
                    let completed = complete(c, &a, &env, unit, lang.as_deref());
                    // Include acquiring the reads connection and blocking-task
                    // scheduling, not just SQL, in the next duration estimate.
                    a.follow_on.record_selection(selection_started.elapsed());
                    let completed = completed?;
                    let exhausted = completed.next_comment.is_none();
                    Ok((Some(completed), exhausted))
                }
            },
        )
        .await
    {
        let (completed, exhausted) = completed;
        if let Some(completed) = completed {
            body.next_comment = completed.next_comment;
            body.follow_on.next_comment = if body.next_comment.is_some() {
                FollowOnState::Complete
            } else {
                FollowOnState::Absent
            };
        }
        if exhausted
            && !background.schedule(move |c| {
                c.execute(
                    "insert into event_ptpt_no_more_comments(zid,pid,votes_placed)
                values($1,$2,(select count(*) from votes where zid=$1 and pid=$2))",
                    &[&admitted.zid, &admitted.pid],
                )?;
                Ok(())
            })
        {
            body.follow_on.notifications = NotificationState::Degraded;
        }
    }
    Ok(Outcome::Success(body))
}

// Bound retained post-receipt work independently of vote admission. Overflow
// or wait expiry degrades only this optional work, never the durable receipt.
// The reads pool separately bounds dispatched acquisition at five seconds;
// neither wait holds a connection. SQL and HTTP deadlines stay unchanged.
const FOLLOW_ON_MAX_PENDING: usize = 64;
const FOLLOW_ON_WAIT: Duration = Duration::from_secs(30);
#[derive(Debug)]
struct FollowOnLane {
    pending: Arc<tokio::sync::Semaphore>,
    running: Arc<tokio::sync::Semaphore>,
    waiting: Mutex<std::collections::BTreeSet<(tokio::time::Instant, u64)>>,
    selection: Mutex<Option<(tokio::time::Instant, Duration)>>,
    sequence: AtomicU64,
    changed: tokio::sync::Notify,
}
impl Default for FollowOnLane {
    fn default() -> Self {
        Self {
            pending: Arc::new(tokio::sync::Semaphore::new(FOLLOW_ON_MAX_PENDING)),
            running: Arc::new(tokio::sync::Semaphore::new(1)),
            waiting: Mutex::default(),
            selection: Mutex::default(),
            sequence: AtomicU64::new(0),
            changed: tokio::sync::Notify::new(),
        }
    }
}
// Cancellation, wait expiry and blocking completion all release capacity and
// wake waiting tasks. The queue lock is held only to choose/remove an entry,
// never while waiting, querying PostgreSQL or selecting a comment.
#[derive(Debug)]
struct FollowOnSlot {
    lane: Arc<FollowOnLane>,
    key: (tokio::time::Instant, u64),
    _pending: tokio::sync::OwnedSemaphorePermit,
    running: Option<tokio::sync::OwnedSemaphorePermit>,
}
impl Drop for FollowOnSlot {
    fn drop(&mut self) {
        self.lane
            .waiting
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.key);
        drop(self.running.take());
        self.lane.changed.notify_waiters();
    }
}
impl FollowOnLane {
    fn can_finish(&self, deadline: tokio::time::Instant) -> bool {
        let now = tokio::time::Instant::now();
        let selection = self.selection.lock().unwrap_or_else(|e| e.into_inner());
        // A short-lived estimate recovers after a host pause or a change of
        // conversation size. Without a recent sample, attempt live work.
        let estimate = selection
            .filter(|(at, _)| now.duration_since(*at) < DISPATCH_DEADLINE)
            .map_or(Duration::ZERO, |(_, duration)| duration);
        deadline.saturating_duration_since(now) > estimate
    }

    fn record_selection(&self, elapsed: Duration) {
        let now = tokio::time::Instant::now();
        let mut selection = self.selection.lock().unwrap_or_else(|e| e.into_inner());
        // A recent selection plus 25% headroom reserves time for returning the
        // result. This is a prediction, never an extension of the reply budget.
        *selection = Some((now, elapsed.saturating_add(elapsed / 4)));
    }

    #[cfg(all(test, feature = "db-tests"))]
    async fn acquire(self: &Arc<Self>) -> Result<FollowOnSlot> {
        self.acquire_until(tokio::time::Instant::now() + DISPATCH_DEADLINE)
            .await
    }

    async fn acquire_until(
        self: &Arc<Self>,
        deadline: tokio::time::Instant,
    ) -> Result<FollowOnSlot> {
        let pending = self
            .pending
            .clone()
            .try_acquire_owned()
            .context("follow-on queue full")?;
        let key = (deadline, self.sequence.fetch_add(1, Ordering::Relaxed));
        let mut slot = FollowOnSlot {
            lane: self.clone(),
            key,
            _pending: pending,
            running: None,
        };
        self.waiting
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(key);
        tokio::time::timeout(FOLLOW_ON_WAIT, async {
            loop {
                // Register before testing the queue so a completion cannot be
                // missed between checking capacity and waiting for it.
                let notified = self.changed.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                {
                    let mut waiting = self.waiting.lock().unwrap_or_else(|e| e.into_inner());
                    // Earliest reply deadline first. Entries with insufficient
                    // time run only the exhaustion check in the blocking task;
                    // they cannot consume a full selection ahead of live work.
                    if waiting.first().copied() == Some(key)
                        && let Ok(running) = self.running.clone().try_acquire_owned()
                    {
                        waiting.remove(&key);
                        slot.running = Some(running);
                        return;
                    }
                }
                // Deadline order never changes as time passes. Removal and
                // completion notify all waiters; no expiry timer is needed.
                notified.await;
            }
        })
        .await
        .context("follow-on wait expired")?;
        Ok(slot)
    }
}

/// A separate admission bound covers both active work and tasks waiting for
/// the two database connections. Admission never waits or spawns on overflow.
struct NotificationPool {
    pool: Arc<db::Pool>,
    admitted: Arc<tokio::sync::Semaphore>,
    dropped: std::sync::atomic::AtomicU64,
}

impl NotificationPool {
    fn new(pool: Arc<db::Pool>) -> Arc<Self> {
        Arc::new(Self {
            pool,
            admitted: Arc::new(tokio::sync::Semaphore::new(64)),
            dropped: std::sync::atomic::AtomicU64::new(0),
        })
    }

    fn schedule<F>(self: &Arc<Self>, work: F) -> bool
    where
        F: FnOnce(&mut Client) -> Result<()> + Send + 'static,
    {
        let Ok(permit) = self.admitted.clone().try_acquire_owned() else {
            self.record_drop();
            return false;
        };
        let lane = self.clone();
        tokio::spawn(async move {
            // Keep admission through the actual blocking operation, even if
            // its awaiting future is dropped. A pool timeout drops the closure
            // and its permit without ever running the work.
            let result = lane
                .pool
                .with(move |c| {
                    let _permit = permit;
                    work(c)
                })
                .await;
            if result.is_err() {
                lane.record_drop();
            }
        });
        true
    }

    fn record_drop(&self) {
        let dropped = self
            .dropped
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            + 1;
        // Report exponentially so overload cannot create an unbounded log stream.
        if dropped.is_power_of_two() {
            eprintln!("{{\"event\":\"vote_notification_dropped\",\"count\":{dropped}}}");
        }
    }
}

fn schedule_notification(pool: Arc<NotificationPool>, admitted: Admitted) -> bool {
    // Best effort: capacity, acquisition, lock/statement failures and shutdown
    // may drop work. No durable queue, retry or flush guarantee. Later votes
    // may refresh state but cannot repair every missed suppression decision.
    pool.schedule(move |c| notification_state(c, &admitted))
}

static IN_FLIGHT: AtomicU64 = AtomicU64::new(0);
struct ActiveDispatch {
    _dispatched: crate::shutdown::Dispatched,
    #[cfg(all(test, feature = "db-tests"))]
    observation: Option<tests::DispatchObservation>,
}
impl ActiveDispatch {
    /// None once the process is stopping: the vote is not dispatched.
    fn begin() -> Option<Self> {
        let dispatched = crate::shutdown::Dispatched::begin()?;
        IN_FLIGHT.fetch_add(1, Ordering::Relaxed);
        Some(Self {
            _dispatched: dispatched,
            #[cfg(all(test, feature = "db-tests"))]
            observation: tests::current_dispatch_observation(),
        })
    }

    /// A dispatch in a test process, which never stops.
    #[cfg(all(test, feature = "db-tests"))]
    fn new() -> Self {
        Self::begin().expect("a test process is never stopping")
    }
}
impl Drop for ActiveDispatch {
    fn drop(&mut self) {
        #[cfg(all(test, feature = "db-tests"))]
        if let Some(observation) = &self.observation {
            observation.lock().unwrap().finished = true;
        }
        IN_FLIGHT.fetch_sub(1, Ordering::Relaxed);
    }
}
static SERVED: AtomicU64 = AtomicU64::new(0);
static HANDED_BACK: AtomicU64 = AtomicU64::new(0);
static DEGRADED: AtomicU64 = AtomicU64::new(0);
static UNKNOWN: AtomicU64 = AtomicU64::new(0);
static ACQUIRE_ALARM_HITS: AtomicU64 = AtomicU64::new(0);
static FIRST_CONTACT_UNKNOWN: AtomicU64 = AtomicU64::new(0);
static FIRST_CONTACT_HANDED_BACK: AtomicU64 = AtomicU64::new(0);

pub(crate) fn observe(out: &Outgoing) {
    let (counter, event) = if out.status == 502 {
        (&HANDED_BACK, "post_votes_handed_back")
    } else {
        (&SERVED, "post_votes_served")
    };
    let count = counter.fetch_add(1, Ordering::Relaxed) + 1;
    if count.is_power_of_two() {
        eprintln!("{{\"event\":\"{event}\",\"count\":{count}}}");
    }
    if out.status == 202 {
        UNKNOWN.fetch_add(1, Ordering::Relaxed);
    }
}

/// Notification work the live writer has queued and not finished: what
/// `/health` reports and what a stop waits for.
pub(crate) fn notifications_in_flight(app: &App) -> usize {
    app.post_votes
        .as_ref()
        .map_or(0, |w| 64 - w.background.admitted.available_permits())
}

pub(crate) fn health(app: &App) -> Js {
    let mut body = js::Obj::new();
    // Enabled means serving participants: the live writer only.
    body.set("enabled", Js::Bool(app.post_votes.is_some()));
    body.set(
        "mode",
        Js::Str(
            if app.post_votes.is_some() {
                "live"
            } else if app.post_votes_observe.is_some() {
                "observe"
            } else {
                "off"
            }
            .into(),
        ),
    );
    for (key, value) in [
        ("served", &SERVED),
        ("handedBack", &HANDED_BACK),
        ("durableAcceptedWithDegradedFollowOn", &DEGRADED),
        ("unknown", &UNKNOWN),
        ("writerAcquireAlarmHits", &ACQUIRE_ALARM_HITS),
        ("inFlight", &IN_FLIGHT),
    ] {
        body.set(key, Js::Num(value.load(Ordering::Relaxed) as f64));
    }
    // Only with the first-contact switch on: off, the body is unchanged.
    if app
        .post_votes
        .as_ref()
        .is_some_and(|w| w.first_contact.is_some())
    {
        for (key, value) in [
            ("firstContactHandedBack", &FIRST_CONTACT_HANDED_BACK),
            ("firstContactCommitUnknown", &FIRST_CONTACT_UNKNOWN),
        ] {
            body.set(key, Js::Num(value.load(Ordering::Relaxed) as f64));
        }
    }
    body.set(
        "notificationsInFlight",
        Js::Num(notifications_in_flight(app) as f64),
    );
    body.set(
        "notificationDropped",
        Js::Num(
            app.post_votes
                .as_ref()
                .map_or(0, |w| w.background.dropped.load(Ordering::Relaxed)) as f64,
        ),
    );
    Js::Obj(body)
}

/// Why the route prelude answered a vote without reaching `handle`, in the
/// prelude's own order (`route::serve`): the revocation snapshot, the
/// writer's eligibility, the HTTPS rule and the body checks. The prelude
/// refuses no request for its origin, so there is no origin reason. Pure: no
/// database work. Observe mode records it when the record has no reason.
pub(crate) fn shape_reason(app: &App, req: &Request) -> Option<&'static str> {
    if let Some(raw) = req.headers.get("authorization")
        && crate::revocation::refusal(app, raw, (crate::clock::now_ms() / 1000.0) as u64).is_some()
    {
        return Some("revoked");
    }
    if app.post_votes.is_none() && app.post_votes_observe.is_none() {
        return Some("unconfigured");
    }
    if !app.production {
        return Some("not_production");
    }
    if let Err(reason) = request_reasoned(req) {
        return Some(reason);
    }
    if !(app.dev_mode
        || app.use_network_host
        || req.headers.get("x-forwarded-proto") == Some("https"))
    {
        return Some("not_https");
    }
    let has_body = req.headers.get("transfer-encoding").is_some()
        || req
            .headers
            .get("content-length")
            .is_some_and(|v| !js::string_to_number(v).is_nan());
    if has_body
        && !crate::params::body_is_modelled(
            req.headers.get("content-type"),
            req.headers.get("content-encoding"),
        )
    {
        return Some("body_unmodelled");
    }
    if matches!(
        crate::params::parse_body(req.headers.get("content-type"), has_body, &req.body),
        crate::params::Body::Invalid
    ) {
        return Some("parameter");
    }
    None
}

/// What a copy says about itself without any database work: whether it
/// carries a star and a language. Never the statement, the vote, the token or
/// the conversation code.
pub(crate) fn copy_facts(req: &Request) -> (bool, bool) {
    let Ok((_, raw)) = request_reasoned(req) else {
        return (false, false);
    };
    let present = |v: &Option<serde_json::Value>| v.as_ref().is_some_and(|v| !v.is_null());
    (present(&raw.starred), present(&raw.lang))
}

/// A future gateway can distinguish explicit pre-dispatch hand-back from its
/// own transport 502. Never emit this marker after dispatch begins.
pub(crate) fn mark_handback(out: &mut Outgoing) {
    out.headers
        .push(("X-Polis-Vote-Dispatch".into(), "not-started".into()));
}
