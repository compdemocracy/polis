//! POST /api/v3/comments for an existing member of a conversation: an
//! ordinary comment and, when the request carries one, its author's vote.
//!
//! Switched off unless `POLIS_API_POST_COMMENTS` is set, and never routed
//! here by nginx. Every request this handler does not model is handed back to
//! Node (502) before anything is written, with a named reason. The comment
//! and its author's vote are one transaction. Once it is dispatched a failure
//! is a hand-back only when PostgreSQL itself refused a statement of it
//! before any commit was asked for, which proves nothing is stored
//! (`refusal`, `vote_refusal`): Node must never be asked to repeat a comment
//! that may already be stored.
//!
//! The handler shares nothing with votes or the next comment: its three pools
//! (admission reads, the insert, notification work) are its own, it takes no
//! lock but the comment-number lock the database's own trigger takes for any
//! writer, and its notification work has its own bounded lane.
//!
//! The comment's text is held in `CommentText`, which cannot be printed.
//! Database errors are never formatted here either: PostgreSQL's detail for a
//! unique violation on (zid, txt) contains the text.
use crate::post_comments_contract as contract;
use crate::post_comments_decision::{Admitted, Decision, Existing, Live, Row, Writable, decide};
use crate::post_comments_text::CommentText;
use crate::{
    config, db,
    http::{Outgoing, Request},
    js::{self, Js},
    route::{self, App, Res},
    votes::{StorageConvention, VoteChoice},
};
use anyhow::{Context, Result};
use polis_auth::{Zid, participant};
use postgres::Client;
use std::{
    collections::BTreeMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

pub const PATH: &str = contract::PATH;
pub(crate) const MAX_BODY_BYTES: usize = 65536;
const ADMISSION_DEADLINE: Duration = Duration::from_millis(250);
/// How long the reply waits for the dispatched write. Longer than the wait
/// for a writer connection plus the insert's statement bound, so that an
/// insert PostgreSQL refuses at either of the pool's bounds is reported, and
/// handed back to Node, before the deadline answers "unknown".
const DISPATCH_DEADLINE: Duration = Duration::from_millis(1500);
const BACKGROUND_MAX_PENDING: usize = 64;

pub(crate) struct Writer {
    pool: Arc<db::Pool>,
    reads: Arc<db::Pool>,
    background: Arc<Background>,
    verifier: participant::Verifier,
    admins: Vec<i32>,
    /// The time the transaction's statements may take in all: the insert
    /// pool's statement bound.
    budget: Duration,
    reasons: Mutex<BTreeMap<&'static str, u64>>,
}

/// The insert and the author's vote: four connections, 100 ms to get one,
/// one second per statement, and the writer pool's 100 ms lock wait.
fn writer_limits() -> db::Limits {
    db::Limits {
        size: 4,
        acquire_timeout: Duration::from_millis(100),
        statement_timeout: Duration::from_millis(1000),
        max_lifetime: Duration::from_secs(300),
    }
}

/// Admission: two read-only connections, 100 ms to get one, 100 ms a read.
fn read_limits() -> db::Limits {
    db::Limits {
        size: 2,
        acquire_timeout: Duration::from_millis(100),
        statement_timeout: Duration::from_millis(100),
        max_lifetime: Duration::from_secs(300),
    }
}

/// The notification task and the author's last interaction: two connections.
fn background_limits() -> db::Limits {
    db::Limits {
        size: 2,
        ..writer_limits()
    }
}

impl Writer {
    fn new(
        connector: impl Fn(&str) -> Result<polis_queue_adapter::jobs::transport::Connector>,
        verifier: participant::Verifier,
        admins: Vec<i32>,
    ) -> Result<Self> {
        Ok(Self {
            pool: db::Pool::writer(connector("polis-api-post-comments/1")?, writer_limits()),
            reads: db::Pool::new(connector("polis-api-comment-reads/1")?, read_limits()),
            background: Background::new(db::Pool::writer(
                connector("polis-api-comment-notifications/1")?,
                background_limits(),
            )),
            verifier,
            admins,
            budget: writer_limits().statement_timeout,
            reasons: Mutex::default(),
        })
    }

    /// Every pool the live handler builds: the insert's, admission's and the
    /// notification work's. No rest pattern: a new field must be classified
    /// for this inventory.
    #[cfg(all(test, feature = "db-tests"))]
    pub(crate) fn startup_pools(&self) -> [&Arc<db::Pool>; 3] {
        let Self {
            pool,
            reads,
            background,
            verifier: _,
            admins: _,
            budget: _,
            reasons: _,
        } = self;
        let Background {
            pool: background_pool,
            admitted: _,
            dropped: _,
        } = background.as_ref();
        [pool, reads, background_pool]
    }

    pub(crate) fn set_revocations(&mut self, snapshot: Arc<polis_auth::revocation::Revocations>) {
        self.verifier.set_revocations(snapshot);
    }

    pub(crate) fn check_revocation(&self, raw: &str, now: u64) -> Result<(), polis_auth::Refusal> {
        self.verifier.check_revocation(raw, now)
    }

    fn admission(&self) -> Admission<'_> {
        Admission {
            verifier: &self.verifier,
            reads: &self.reads,
            admins: &self.admins,
        }
    }

    fn count(&self, reason: &'static str) {
        *self
            .reasons
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entry(reason)
            .or_default() += 1;
    }

    #[cfg(all(test, feature = "db-tests"))]
    pub(crate) fn counted(&self, reason: &'static str) -> u64 {
        self.reasons
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(reason)
            .copied()
            .unwrap_or_default()
    }
}

/// What `POLIS_API_POST_COMMENTS` asks for. Unset, empty or `0` is off;
/// another value than `1` or `observe` is a startup error, never a silent
/// off.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Switch {
    Off,
    Live,
    Observe,
}

fn parse_switch(value: Option<&str>) -> Result<Switch> {
    match value {
        None | Some("" | "0") => Ok(Switch::Off),
        Some("1") => Ok(Switch::Live),
        Some("observe") => Ok(Switch::Observe),
        Some(_) => anyhow::bail!("POLIS_API_POST_COMMENTS must be unset, 0, 1 or observe"),
    }
}

/// What a role does with a switch. The main role builds the live handler for
/// `1` and refuses `observe`; the shadow role accepts `observe` and refuses
/// `1`.
fn mode(role: crate::shadow::Role, switch: Switch) -> Result<Switch> {
    match (role, switch) {
        (crate::shadow::Role::Main, Switch::Observe) => anyhow::bail!(
            "POLIS_API_POST_COMMENTS=observe is accepted only by the shadow role (POLIS_API_ROLE=shadow)"
        ),
        (crate::shadow::Role::Shadow, Switch::Live) => anyhow::bail!(
            "the shadow role never builds the live comment writer: POLIS_API_POST_COMMENTS=1 is refused there"
        ),
        (_, switch) => Ok(switch),
    }
}

pub(crate) enum Configured {
    Off,
    Live(Box<Writer>),
    /// Built only by the shadow role: admission and the read-back of what
    /// Node stored, on read-only pools, and nothing that can write.
    Observe(Box<Observer>),
}

/// The comment handler this process's role builds: the live handler in the
/// main role, the observer in the shadow role. Both share every startup
/// condition below, and both verify participant tokens with the key in
/// POLIS_API_PARTICIPANT_PUBLIC_KEY_FILE when that is set, and otherwise
/// with the participant keys the process loaded at startup.
pub(crate) fn configure(
    role: crate::shadow::Role,
    keys: Option<&polis_auth::keys::Keys>,
) -> Result<Configured> {
    let value = std::env::var("POLIS_API_POST_COMMENTS").ok();
    let switch = mode(role, parse_switch(value.as_deref())?)?;
    if switch == Switch::Off {
        return Ok(Configured::Off);
    }
    // Node detects a comment's language when its translation setting is on.
    // That provider stays Node's: an absent setting does not mean off.
    anyhow::ensure!(
        std::env::var("SHOULD_USE_TRANSLATION_API").ok().as_deref() == Some("false"),
        "post comments requires SHOULD_USE_TRANSLATION_API=false"
    );
    let dsn = std::env::var("POLIS_API_POST_COMMENTS_DATABASE_URL")
        .context("post comments requires an explicit primary database")?;
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
            "post comments requires the participant public key: POLIS_API_PARTICIPANT_PUBLIC_KEY_FILE, or the participant keys the process loads (JWT_PUBLIC_KEY or JWT_PUBLIC_KEY_PATH)"
        ),
    }
    .context("invalid participant verifier configuration")?;
    let admins: Vec<i32> =
        serde_json::from_str(&std::env::var("ADMIN_UIDS").unwrap_or_else(|_| "[]".into()))?;
    if switch == Switch::Observe {
        return observe::build(&dsn, verifier, admins);
    }
    Ok(Configured::Live(Box::new(Writer::new(
        |name| config::connector_for_dsn(&dsn, name),
        verifier,
        admins,
    )?)))
}

/// What a request asks for, once its shape is admitted.
#[derive(Clone, Debug)]
struct Comment {
    text: CommentText,
    vote: Option<VoteChoice>,
}

/// The request's shape, with the reason a request is handed back. Nothing
/// here reads the database or the token.
///
/// Body keys, one by one. `conversation_id`, `txt`, `vote` and `is_seed` are
/// the route's parameters. `pid` and `agid` are sent by the participation
/// clients on every comment and are not parameters of this route: Node never
/// reads them, and neither does this. `xid` is a parameter of the route and
/// selects another identity; `x_name`, `x_profile_image_url` and `x_email`
/// travel with it. Any other key is one no client of this repository sends.
fn request_reasoned(req: &Request) -> Result<(String, Comment), &'static str> {
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
    // JSON: the command-line client's, the `fetch` client's, and the jQuery
    // client's as a browser's XMLHttpRequest rewrites its charset.
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
    // A syntax error's message names a position, never the body; it is
    // dropped all the same.
    let value: serde_json::Value = serde_json::from_slice(&req.body).map_err(|_| "shape_json")?;
    let obj = value.as_object().ok_or("shape_json")?;
    if obj.contains_key("xid") {
        return Err("xid_key");
    }
    if ["x_name", "x_profile_image_url", "x_email"]
        .iter()
        .any(|key| obj.contains_key(*key))
    {
        return Err("xid_profile_key");
    }
    if obj.keys().any(|key| {
        !matches!(
            key.as_str(),
            "conversation_id" | "txt" | "vote" | "is_seed" | "pid" | "agid"
        )
    }) {
        return Err("shape_keys");
    }
    let raw: contract::Request = serde_json::from_value(value).map_err(|_| "shape_json")?;
    let cid = raw
        .conversation_id
        .as_ref()
        .and_then(|v| crate::post_votes_contract::string(v, 100))
        .ok_or("shape_conversation_id")?;
    if cid.is_empty() || !cid.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return Err("shape_conversation_id");
    }
    // Node answers 400 for each of these, in this order: the text, the vote,
    // the seed flag. The parsed fields are taken apart at once; the text goes
    // into the type that cannot be printed.
    let contract::ParsedFields { txt, vote, is_seed } =
        raw.parse_fields().map_err(|invalid| match invalid.0 {
            "txt" => "txt_invalid",
            "vote" => "vote_invalid",
            _ => "is_seed_invalid",
        })?;
    let text = CommentText::new(txt);
    if text.is_empty() {
        return Err("txt_empty");
    }
    if text.contains_nul() {
        return Err("txt_nul");
    }
    // Node honours the flag for a moderator and ignores it for anyone else.
    if is_seed == Some(true) {
        return Err("is_seed");
    }
    Ok((cid, Comment { text, vote }))
}

/// Why the route prelude answers a comment without reaching `handle`. Pure:
/// no database work.
fn ineligible(app: &App, req: &Request) -> Option<&'static str> {
    if app.post_comments.is_none() && app.post_comments_observe.is_none() {
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
    None
}

pub(crate) fn eligible(app: &App, req: &Request) -> bool {
    // Cookies neither authenticate nor disqualify a caller. handle still
    // requires a supported verified Bearer and membership before dispatch.
    match ineligible(app, req) {
        None => true,
        Some(reason) => {
            if let Some(writer) = &app.post_comments {
                writer.count(reason);
            }
            false
        }
    }
}

/// What admission uses.
struct Admission<'a> {
    verifier: &'a participant::Verifier,
    reads: &'a Arc<db::Pool>,
    admins: &'a [i32],
}

/// A database error with nothing of the statement, its parameters or the
/// server's message left in it: only the SQLSTATE.
fn scrub(error: anyhow::Error) -> anyhow::Error {
    match error
        .downcast_ref::<postgres::Error>()
        .and_then(postgres::Error::code)
    {
        Some(code) => anyhow::anyhow!("comment admission read failed: SQLSTATE {}", code.code()),
        None => anyhow::anyhow!("comment admission read failed"),
    }
}

/// The admission read. One statement gives the conversation's settings,
/// whether the author moderates it (its owner, or a user on the owner's
/// site), and the comment that already has this text, if any: its number,
/// author and time, so that a later reader of the same statement can tell
/// whose row it is.
///
/// Every part is a lookup by key whatever the planner's statistics say: the
/// conversation by its number, the two users each in a scalar subquery by
/// user number (a subquery cannot be planned as a merge over the users
/// table, which a join can), and the comment by the unique key on
/// (zid, txt).
const ADMISSION: &str =
    "select c.is_active, c.strict_moderation, c.xid_required, c.use_xid_whitelist,
     (select site_id from users where uid = $2) = (select site_id from users where uid = c.owner),
     m.tid, m.pid, m.created
     from conversations c
     left join comments m on m.zid = c.zid and m.txt = $3
     where c.zid = $1";

/// A request that is not a member's: which of the two reasons. The member
/// lookup (`polis_auth::participant::resolve`) leaves out every conversation
/// with Treevite, member or not.
const TREEVITE: &str = "select treevite_enabled from conversations where zid = $1";

/// Admission's reads. A refusal is Ok(Err(reason, the conversation when it
/// is known)); every one is handed back.
type Refusal = (&'static str, Option<i32>);

fn admit(
    c: &mut Client,
    cid: &str,
    identity: &participant::Verified,
    text: &CommentText,
) -> Result<Result<Admitted, Refusal>> {
    let Some(zid) = db::zid_for_conversation_id(c, cid)? else {
        return Ok(Err(("unknown_conversation", None)));
    };
    let Some(pid) = participant::resolve(c, Zid(zid), identity)? else {
        let treevite = c
            .query_opt(TREEVITE, &[&zid])?
            .map(|row| row.try_get::<_, Option<bool>>(0))
            .transpose()?
            .flatten()
            .unwrap_or(false);
        return Ok(Err((
            if treevite {
                "treevite"
            } else {
                "not_a_participant"
            },
            Some(zid),
        )));
    };
    let row = c.query_one(ADMISSION, &[&zid, &identity.uid().0, text])?;
    let flag = |index: usize| -> Result<bool> {
        Ok(row.try_get::<_, Option<bool>>(index)?.unwrap_or(false))
    };
    // A moderator's comment starts approved, and may be a seed.
    if flag(4)? {
        return Ok(Err(("moderator", Some(zid))));
    }
    if flag(2)? {
        return Ok(Err(("xid_required", Some(zid))));
    }
    if flag(3)? {
        return Ok(Err(("xid_allowlist", Some(zid))));
    }
    let existing = match row.try_get::<_, Option<i32>>(5)? {
        Some(tid) => Some(Existing {
            tid,
            pid: row.try_get(6)?,
            created: row.try_get(7)?,
        }),
        None => None,
    };
    Ok(Ok(Admitted {
        zid,
        pid: pid.0 as i32,
        uid: identity.uid().0,
        active: flag(0)?,
        strict: flag(1)?,
        existing,
    }))
}

/// Why a token was not accepted, from its unverified payload. A label for
/// the hand-back only: it admits nothing.
fn token_reason(authorization: &str, cid: &str) -> &'static str {
    let Some(payload) = polis_auth::observability::credential_hints(authorization) else {
        return "token_refused";
    };
    if payload.get("xid").is_some() || payload.get("xid_participant").is_some() {
        return "token_xid";
    }
    if payload.get("anonymous_participant").is_none()
        && payload.get("standard_user_participant").is_none()
    {
        // An account's own token: Node may provision the user from it.
        return "token_oidc";
    }
    if payload
        .get("conversation_id")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|issued_for| issued_for != cid)
    {
        return "token_other_conversation";
    }
    "token_refused"
}

/// A request admission accepted, and what Node would do with it.
#[derive(Debug)]
struct Prepared {
    decision: Decision,
    #[allow(dead_code)]
    admission: Duration,
}

/// A request handed back before any decision.
#[derive(Debug)]
struct Refused {
    reason: &'static str,
    /// The conversation, when admission resolved it.
    #[allow(dead_code)]
    zid: Option<i32>,
    admission: Option<Duration>,
}

impl Refused {
    fn before_admission(reason: &'static str) -> Self {
        Self {
            reason,
            zid: None,
            admission: None,
        }
    }
}

/// A request admission accepted, before any decision is taken from it.
struct Checked {
    admitted: Admitted,
    text: CommentText,
    vote: Option<VoteChoice>,
    admission: Duration,
}

/// Everything before the decision: the request's shape, the token, the admin
/// refusal, and admission under its deadline.
async fn prepare(writer: Admission<'_>, req: &Request) -> Result<Prepared, Refused> {
    let Checked {
        admitted,
        text,
        vote,
        admission,
    } = check(writer, req).await?;
    Ok(Prepared {
        decision: decide(&admitted, text, vote),
        admission,
    })
}

/// `prepare` up to the decision, for the live handler and for observe mode
/// alike: the same shape check, token verification, admin refusal and
/// admission statement, under the same deadline.
async fn check(writer: Admission<'_>, req: &Request) -> Result<Checked, Refused> {
    let (cid, comment) = request_reasoned(req).map_err(Refused::before_admission)?;
    let Some(auth) = req.headers.get("authorization") else {
        return Err(Refused::before_admission("no_token"));
    };
    let Some(identity) =
        writer
            .verifier
            .verify(auth, &cid, (crate::clock::now_ms() / 1000.0) as u64)
    else {
        return Err(Refused::before_admission(token_reason(auth, &cid)));
    };
    if writer.admins.contains(&identity.uid().0) {
        return Err(Refused::before_admission("admin"));
    }
    let Comment { text, vote } = comment;
    let started = tokio::time::Instant::now();
    let lookup = text.clone();
    let admission = tokio::time::timeout(
        ADMISSION_DEADLINE,
        writer
            .reads
            .with(move |c| admit(c, &cid, &identity, &lookup).map_err(scrub)),
    )
    .await;
    let admission_time = started.elapsed();
    let refused = |reason, zid| Refused {
        reason,
        zid,
        admission: Some(admission_time),
    };
    let admitted = match admission {
        Ok(Ok(Ok(admitted))) => admitted,
        Ok(Ok(Err((reason, zid)))) => return Err(refused(reason, zid)),
        Ok(Err(_)) => return Err(refused("admission_unavailable", None)),
        Err(_) => return Err(refused("admission_timeout", None)),
    };
    Ok(Checked {
        admitted,
        text,
        vote,
        admission: admission_time,
    })
}

/// The comment row, as Node inserts it: `tid` null for the `tid_auto`
/// trigger, which assigns the number under the conversation's comment-number
/// lock and holds that lock until the transaction ends. Only a
/// `Writable` can be inserted, and no strict conversation's row is one.
fn insert(
    c: &mut impl postgres::GenericClient,
    writable: &Writable,
) -> Result<i32, postgres::Error> {
    let row = writable.row();
    c.query_one(
        "insert into comments
         (pid, zid, txt, velocity, active, mod, uid, anon, is_seed, created, tid, lang, lang_confidence)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, default, null, null, null)
         returning tid",
        &[
            &row.pid,
            &row.zid,
            &row.text,
            &crate::post_comments_decision::VELOCITY,
            &Row::ACTIVE,
            &crate::post_comments_decision::UNMODERATED,
            &row.uid,
            &Row::ANON,
            &Row::IS_SEED,
        ],
    )?
    .try_get(0)
}

/// Node's answers to a failed insert. Only the text's own unique key, under
/// either of the names it has across installations, is a duplicate; the
/// comment-number key is not.
fn classify(error: &postgres::Error) -> (u16, &'static str) {
    if let Some(e) = error.as_db_error() {
        use postgres::error::SqlState;
        if *e.code() == SqlState::UNIQUE_VIOLATION
            && matches!(
                e.constraint(),
                Some("comments_zid_txt_key" | "comments_txt_unique_constraint")
            )
        {
            return (409, "polis_err_post_comment_duplicate");
        }
        if *e.code() == SqlState::FOREIGN_KEY_VIOLATION {
            return (
                500,
                if e.constraint() == Some("comments_zid_pid_fkey") {
                    "polis_err_post_comment_participant_race_condition"
                } else {
                    "polis_err_post_comment_constraint_violation"
                },
            );
        }
    }
    (500, "polis_err_post_comment")
}

/// A refusal of the comment's insert that proves nothing is stored, and the
/// reason it is handed back under. Node has neither of this pool's bounds:
/// it would have waited, and stored the comment.
///
/// The insert runs in a transaction this handler opened and has not asked
/// to commit. PostgreSQL answers a statement with an error of severity ERROR
/// only by aborting its transaction, which can then only be rolled back.
/// Both codes below are the handler's own bounds: `55P03` when a lock wait
/// runs out (the comment-number lock, or any other lock the insert waits
/// for), `57014` when the statement is cancelled at its time bound.
///
/// A fatal error or a closed connection is not the statement's refusal, and
/// a code from a server too old to send the severity is not trusted: those
/// stay answered, as does every other error of the insert, with Node's
/// answer to it.
fn refusal(error: &postgres::Error) -> Option<&'static str> {
    use postgres::error::{Severity, SqlState};
    let e = error.as_db_error()?;
    if e.parsed_severity() != Some(Severity::Error) {
        return None;
    }
    if *e.code() == SqlState::LOCK_NOT_AVAILABLE {
        Some("insert_lock_timeout")
    } else if *e.code() == SqlState::QUERY_CANCELED {
        Some("insert_canceled")
    } else {
        None
    }
}

/// What stopped the author's vote before any commit was asked for, and the
/// reason the request is handed back under. The comment's insert is in the
/// same transaction, so it is rolled back with the vote and nothing is
/// stored: Node, asked instead, stores the comment and answers a failing vote
/// in its own way. Only PostgreSQL's own ERROR for a statement counts; a
/// closed connection or a fatal error is answered, never handed back.
fn vote_refusal(error: &postgres::Error) -> Option<&'static str> {
    use postgres::error::{Severity, SqlState};
    let e = error.as_db_error()?;
    if e.parsed_severity() != Some(Severity::Error) {
        return None;
    }
    Some(if *e.code() == SqlState::LOCK_NOT_AVAILABLE {
        "author_vote_lock_timeout"
    } else if *e.code() == SqlState::QUERY_CANCELED {
        "author_vote_canceled"
    } else {
        "author_vote_refused"
    })
}

/// The conversation was closed, or gone, when the vote read it again.
#[derive(Debug)]
struct ClosedBeforeVote;
impl std::fmt::Display for ClosedBeforeVote {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("the conversation is closed")
    }
}
impl std::error::Error for ClosedBeforeVote {}

/// The author's vote on their own comment: after the comment's insert, in
/// the same transaction, and only when the request carries a vote. Node's
/// vote function reads the conversation again first and refuses a closed
/// one; so does this. The stored value comes
/// from the vote convention, never from the wire value. Like the insert, it
/// takes a `Writable`: nothing can be written for a strict conversation's row.
fn author_vote(
    c: &mut impl postgres::GenericClient,
    writable: &Writable,
    tid: i32,
    choice: VoteChoice,
) -> Result<()> {
    author_vote_under(c, writable, tid, choice, StorageConvention::CURRENT)
}

/// `author_vote` under a stated storage convention. The live path passes the
/// current one, the value the comment contract's `author_vote` gives. The
/// convention is a parameter so that a test can run this same write under the
/// convention whose numbers differ from the wire's: there a write that stored
/// the wire value in place of the convention's stores the opposite choice,
/// which no test can see while the two give the same numbers.
fn author_vote_under(
    c: &mut impl postgres::GenericClient,
    writable: &Writable,
    tid: i32,
    choice: VoteChoice,
    convention: StorageConvention,
) -> Result<()> {
    let active = c
        .query_opt(
            "select is_active from conversations where zid = $1",
            &[&writable.row().zid],
        )?
        .map(|row| row.try_get::<_, Option<bool>>(0))
        .transpose()?
        .flatten()
        .unwrap_or(false);
    if !active {
        return Err(anyhow::Error::new(ClosedBeforeVote));
    }
    insert_author_vote(c, writable, tid, i16::try_from(convention.encode(choice))?)
}

/// `stored` is a value of the storage convention. Weight 0 and no priority,
/// as Node passes them; the insert rule on the table keeps the latest-vote
/// row.
fn insert_author_vote(
    c: &mut impl postgres::GenericClient,
    writable: &Writable,
    tid: i32,
    stored: i16,
) -> Result<()> {
    let row = writable.row();
    c.execute(
        "insert into votes (pid, zid, tid, vote, weight_x_32767, high_priority, created)
         values ($1, $2, $3, $4, $5, $6, default)",
        &[&row.pid, &row.zid, &tid, &stored, &0_i16, &false],
    )?;
    Ok(())
}

/// What the dispatched work did.
#[derive(Debug, PartialEq, Eq)]
enum Stored {
    Tid(i32),
    /// Node's answer to the same failure of the insert, with nothing stored;
    /// or 500 when what was stored is not known (a commit that failed, a
    /// connection that ended).
    Failed(u16, &'static str),
    /// PostgreSQL refused a statement before any commit was asked for:
    /// nothing is stored.
    Refused(&'static str),
}

/// The transaction's own bounds, as the vote writer's append sets them: the
/// lock wait, the pool's statement bound and a bound on sitting idle inside
/// the transaction.
const TRANSACTION_BOUNDS: &str = "SET LOCAL lock_timeout='100ms';
     SET LOCAL statement_timeout FROM CURRENT;
     SET LOCAL idle_in_transaction_session_timeout='1s'";

/// The comment and then its author's vote, in one transaction on one writer
/// connection: both are stored or neither is. No error is formatted: its
/// detail can hold the text.
///
/// Until `commit` is called nothing can be stored, so a statement PostgreSQL
/// refuses before it is either answered as Node answers the same error of
/// the insert, or handed back (`refusal`, `vote_refusal`, and a conversation
/// found closed by the vote's second read). A commit that fails is never
/// handed back: 500, with what is stored unknown.
///
/// `budget` is the time the statements may take in all, so that a refusal
/// reaches the reply before its deadline: the insert runs under the pool's
/// statement bound, and the vote's two statements share what the insert left.
fn store(c: &mut Client, writable: &Writable, budget: Duration) -> Stored {
    #[cfg(test)]
    tests::panic_point(writable);
    let began = Instant::now();
    let unknown = Stored::Failed(500, "polis_err_post_comment");
    let insert_failed = |error: &postgres::Error| match refusal(error) {
        Some(reason) => Stored::Refused(reason),
        None => {
            let (status, code) = classify(error);
            Stored::Failed(status, code)
        }
    };
    let vote_failed = |error: &postgres::Error| match vote_refusal(error) {
        Some(reason) => Stored::Refused(reason),
        None => Stored::Failed(500, "polis_err_post_comment"),
    };
    let mut tx = match c
        .build_transaction()
        .isolation_level(postgres::IsolationLevel::ReadCommitted)
        .start()
    {
        Ok(tx) => tx,
        Err(error) => return insert_failed(&error),
    };
    if let Err(error) = tx.batch_execute(TRANSACTION_BOUNDS) {
        return insert_failed(&error);
    }
    let tid = match insert(&mut tx, writable) {
        Ok(tid) => tid,
        Err(error) => return insert_failed(&error),
    };
    #[cfg(test)]
    tests::panic_between(writable);
    if let Some(choice) = writable.row().vote {
        // Two statements follow; each may take half of what is left.
        let each = (budget.saturating_sub(began.elapsed()).as_millis() / 2).max(1);
        if let Err(error) = tx.batch_execute(&format!("SET LOCAL statement_timeout = {each}")) {
            return vote_failed(&error);
        }
        if let Err(error) = author_vote(&mut tx, writable, tid, choice) {
            if error.is::<ClosedBeforeVote>() {
                return Stored::Refused("closed_before_vote");
            }
            return match error.downcast_ref::<postgres::Error>() {
                Some(error) => vote_failed(error),
                None => unknown,
            };
        }
    }
    match tx.commit() {
        Ok(()) => Stored::Tid(tid),
        Err(_) => {
            end_failed_commit(c);
            unknown
        }
    }
}

/// After a COMMIT that failed. The driver counts a transaction as finished
/// from the moment it sends COMMIT, so it sends no ROLLBACK when the COMMIT
/// fails. If PostgreSQL refused the COMMIT statement itself (a cancel at the
/// statement bound, which for the vote's share of the second can be a few
/// milliseconds, or a cancel request, before the transaction was ended), the
/// session is still inside the aborted transaction; the pool would keep the
/// connection, and the next comment on it would fail at its BEGIN and be
/// answered 500 with nothing stored. A ROLLBACK ends that state. Where the
/// failed COMMIT already ended the transaction it is a warning and changes
/// nothing; on a connection that is gone it fails, and the pool drops the
/// connection. It never changes what the failed COMMIT stored, which stays
/// unknown.
fn end_failed_commit(c: &mut Client) {
    let _ = c.batch_execute("ROLLBACK");
}

#[derive(Debug, PartialEq, Eq)]
enum Written {
    Stored {
        tid: i32,
        pid: i32,
    },
    Failed(u16, &'static str),
    /// No writer connection was obtained and no statement was sent.
    NotStarted,
    /// The transaction was begun and PostgreSQL refused a statement of it
    /// before any commit was asked for: nothing is stored.
    Refused(&'static str),
}

async fn dispatch(
    pool: Arc<db::Pool>,
    background: Arc<Background>,
    writable: Writable,
    budget: Duration,
    _active: ActiveDispatch,
) -> Written {
    let started = Arc::new(AtomicBool::new(false));
    let entered = started.clone();
    let (zid, pid, uid) = {
        let row = writable.row();
        (row.zid, row.pid, row.uid)
    };
    let result = pool
        .with(move |c| {
            entered.store(true, Ordering::SeqCst);
            Ok(store(c, &writable, budget))
        })
        .await;
    match result {
        Ok(Stored::Tid(tid)) => {
            // Best effort, as in Node: neither is a condition of the reply.
            background.schedule(move |c| {
                c.execute(
                    "insert into notification_tasks (zid) values ($1)
                     on conflict (zid) do update set modified = now_as_millis()",
                    &[&zid],
                )?;
                Ok(())
            });
            background.schedule(move |c| {
                c.execute(
                    "update participants set last_interaction = now_as_millis(), nsli = 0
                     where zid = $1 and uid = $2",
                    &[&zid, &uid],
                )?;
                Ok(())
            });
            Written::Stored { tid, pid }
        }
        Ok(Stored::Failed(status, code)) => Written::Failed(status, code),
        Ok(Stored::Refused(reason)) => Written::Refused(reason),
        // The pool gave no connection in time, or could not open one: the
        // work never ran, so Node can still be asked.
        Err(_) if !started.load(Ordering::SeqCst) => Written::NotStarted,
        // The work ran and did not report (it panicked): unknown.
        Err(_) => Written::Failed(500, "polis_err_post_comment"),
    }
}

pub(crate) async fn handle(app: &App, req: &Request, res: Res) -> Outgoing {
    // A process holds one mode. Observe is checked first, so a copy can never
    // reach the live handler's dispatch.
    if let Some(observer) = &app.post_comments_observe {
        return observe::handle(observer, req, res).await;
    }
    let Some(writer) = &app.post_comments else {
        return route::bad_gateway();
    };
    let hand_back = |reason: &'static str| {
        writer.count(reason);
        route::bad_gateway()
    };
    let prepared = match prepare(writer.admission(), req).await {
        Ok(prepared) => prepared,
        Err(refused) => return hand_back(refused.reason),
    };
    let writable = match prepared.decision.live() {
        Live::Answer(status, code) => {
            return route::fail_json(req, res, status, Js::Str(code.into()));
        }
        Live::HandBack(reason) => return hand_back(reason),
        Live::Write(writable) => writable,
    };
    // The task owns the write through completion: a caller that disconnects
    // or a reply deadline cannot cancel it. After this line a hand-back is
    // possible only when the task itself reports that nothing was sent, or
    // that PostgreSQL refused the transaction before any commit was asked.
    let task = tokio::spawn(dispatch(
        writer.pool.clone(),
        writer.background.clone(),
        writable,
        writer.budget,
        ActiveDispatch::new(),
    ));
    match tokio::time::timeout(DISPATCH_DEADLINE, task).await {
        Ok(Ok(Written::Stored { tid, pid })) => {
            match serde_json::to_string(&contract::Success {
                tid,
                current_pid: pid,
                auth: None,
            }) {
                Ok(body) => route::json_text(req, res, 200, body),
                Err(_) => route::fail_json(req, res, 500, Js::Str("polis_err_post_comment".into())),
            }
        }
        Ok(Ok(Written::Failed(status, code))) => {
            route::fail_json(req, res, status, Js::Str(code.into()))
        }
        Ok(Ok(Written::NotStarted)) => hand_back("writer_unavailable"),
        Ok(Ok(Written::Refused(reason))) => {
            writer.count(reason);
            let mut out = route::bad_gateway();
            out.headers.push((DISPATCH.into(), "refused".into()));
            out
        }
        // The reply deadline passed, or the task died: the comment may or may
        // not be stored. Never a hand-back.
        _ => {
            UNKNOWN.fetch_add(1, Ordering::Relaxed);
            route::fail_json(req, res, 500, Js::Str("polis_err_post_comment".into()))
        }
    }
}

/// The notification task and the author's last interaction, off the reply's
/// path. One bound covers running work and work waiting for the two
/// connections; beyond it the work is dropped and counted, never queued.
struct Background {
    pool: Arc<db::Pool>,
    admitted: Arc<tokio::sync::Semaphore>,
    dropped: AtomicU64,
}

impl Background {
    fn new(pool: Arc<db::Pool>) -> Arc<Self> {
        Arc::new(Self {
            pool,
            admitted: Arc::new(tokio::sync::Semaphore::new(BACKGROUND_MAX_PENDING)),
            dropped: AtomicU64::new(0),
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
            // The permit stays with the blocking operation until it ends,
            // even if this future is dropped. A pool timeout drops the
            // closure and its permit without running the work.
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
        let dropped = self.dropped.fetch_add(1, Ordering::Relaxed) + 1;
        // Exponentially, so overload cannot become an unbounded log stream.
        if dropped.is_power_of_two() {
            eprintln!("{{\"event\":\"comment_notification_dropped\",\"count\":{dropped}}}");
        }
    }
}

static IN_FLIGHT: AtomicU64 = AtomicU64::new(0);
struct ActiveDispatch;
impl ActiveDispatch {
    fn new() -> Self {
        IN_FLIGHT.fetch_add(1, Ordering::Relaxed);
        Self
    }
}
impl Drop for ActiveDispatch {
    fn drop(&mut self) {
        IN_FLIGHT.fetch_sub(1, Ordering::Relaxed);
    }
}
static SERVED: AtomicU64 = AtomicU64::new(0);
static HANDED_BACK: AtomicU64 = AtomicU64::new(0);
static UNKNOWN: AtomicU64 = AtomicU64::new(0);

pub(crate) fn observe(out: &Outgoing) {
    let (counter, event) = if out.status == 502 {
        (&HANDED_BACK, "post_comments_handed_back")
    } else {
        (&SERVED, "post_comments_served")
    };
    let count = counter.fetch_add(1, Ordering::Relaxed) + 1;
    if count.is_power_of_two() {
        eprintln!("{{\"event\":\"{event}\",\"count\":{count}}}");
    }
}

pub(crate) fn health(app: &App) -> Js {
    let mut body = js::Obj::new();
    // Enabled means serving participants: the live handler only.
    body.set("enabled", Js::Bool(app.post_comments.is_some()));
    body.set(
        "mode",
        Js::Str(
            if app.post_comments.is_some() {
                "live"
            } else {
                "off"
            }
            .into(),
        ),
    );
    for (key, value) in [
        ("served", &SERVED),
        ("handedBack", &HANDED_BACK),
        ("unknown", &UNKNOWN),
        ("inFlight", &IN_FLIGHT),
    ] {
        body.set(key, Js::Num(value.load(Ordering::Relaxed) as f64));
    }
    let background = app.post_comments.as_ref().map(|w| &w.background);
    body.set(
        "notificationsInFlight",
        Js::Num(background.map_or(0, |b| {
            BACKGROUND_MAX_PENDING - b.admitted.available_permits()
        }) as f64),
    );
    body.set(
        "notificationDropped",
        Js::Num(background.map_or(0, |b| b.dropped.load(Ordering::Relaxed)) as f64),
    );
    let mut reasons = js::Obj::new();
    if let Some(writer) = &app.post_comments {
        for (reason, count) in writer
            .reasons
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
        {
            reasons.set(reason, Js::Num(*count as f64));
        }
    }
    body.set("handBackReasons", Js::Obj(reasons));
    Js::Obj(body)
}

/// The header every hand-back of this handler carries, so that a later
/// gateway can tell it from its own transport 502. Either value means the
/// comment is not stored and Node may be asked: `not-started` (nothing was
/// dispatched) or `refused` (the write was dispatched and PostgreSQL refused
/// it, see `refusal`). A 502 without it promises nothing.
const DISPATCH: &str = "X-Polis-Comment-Dispatch";

pub(crate) fn mark_handback(out: &mut Outgoing) {
    if !out.headers.iter().any(|(name, _)| name == DISPATCH) {
        out.headers.push((DISPATCH.into(), "not-started".into()));
    }
}

/// Why the route prelude answered a comment without reaching `handle`, in
/// the prelude's own order (`route::serve`): the revocation snapshot, the
/// handler's eligibility, the HTTPS rule and the body checks. Pure: no
/// database work. Observe mode records it when the record has no reason.
pub(crate) fn shape_reason(app: &App, req: &Request) -> Option<&'static str> {
    if let Some(raw) = req.headers.get("authorization")
        && crate::revocation::refusal(app, raw, (crate::clock::now_ms() / 1000.0) as u64).is_some()
    {
        return Some("revoked");
    }
    if let Some(reason) = ineligible(app, req) {
        return Some(reason);
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

/// What a copy says about itself without any database work and whatever its
/// shape: whether its body carries a vote, and whether it carries the seed
/// flag. Never the text, the vote's value, the token or the conversation
/// code. The parsed body is dropped here.
pub(crate) fn copy_facts(req: &Request) -> (bool, bool) {
    let Ok(serde_json::Value::Object(body)) = serde_json::from_slice(&req.body) else {
        return (false, false);
    };
    let present = |key: &str| body.get(key).is_some_and(|value| !value.is_null());
    (present("vote"), present("is_seed"))
}

#[path = "post_comments_observe.rs"]
pub(crate) mod observe;
pub(crate) use observe::Observer;

#[cfg(test)]
#[path = "post_comments_tests.rs"]
pub(crate) mod tests;
