//! `GET /api/v3/votes/famous`: the featured participants of a conversation,
//! as `doFamousQuery` (`server/src/server-helpers.ts`) computes them, on two
//! bounded read-only pools of this route's own. A request this module cannot
//! answer as Node does goes back to Node with a named reason; nothing here
//! shares a pool, a lock or a queue with a participant's choices, comments or
//! next comment.
//!
//! What Node does, in its order, and what is copied here:
//!
//! 1. the math generation, whole, kept three seconds (`getMathBundle`): the
//!    shared [`crate::math_bundle`] cache;
//! 2. the conversation row and the authors of the featured comments (the
//!    consensus and the representative comments of each group) who hold an
//!    external id under any account;
//! 3. an anonymous conversation answers `{}`;
//! 4. `getSocialParticipants`: the requester, moderators' pins, those
//!    authors and the conversation's external-id participants, by priority, up
//!    to `ptptoiLimit`. Node keeps the featured participants (the pins, the
//!    authors and the external-id participants) 30 seconds under a key of the
//!    conversation, the limit and the request's `math_tick`, the same for
//!    every requester; [`State`] keeps the same rows under the same key for
//!    the same time. The requester's own row is decided on every request and
//!    is never kept: a requester who is one of the featured participants
//!    gets that row as their own ([`featured_as_own`]); for any other
//!    identified requester [`own_row`] reads it and [`with_own_row`] gives it
//!    the first of the limit's places;
//! 5. each of those participants' history of choices, as one letter a
//!    comment. Node keeps a participant's letters under the `math_tick` of the
//!    request that read them and reads them again only for a request with a
//!    greater one; the letters of one read are as long as that read's greatest
//!    comment number. [`State`] keeps them by the same rule;
//! 6. the base cluster of each participant in the same math generation. A
//!    participant the math has not placed is left out, except the requester.

use crate::{
    db::Pool,
    http::{Outgoing, Request},
    math_bundle::{Main, Read},
    route::{self, App, Res},
};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap, VecDeque},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

#[allow(dead_code)]
#[rustfmt::skip]
#[path = "../../polis-contracts/src/votes_famous.rs"]
mod contract;
pub use contract::PATH;
use contract::{Flat, Participant, Response};

/// `mod` in `doFamousQuery`: participants a moderator has not hidden.
const SHOWN_FROM: i32 = 0;
/// A generation the math has not committed carries a tick below zero.
const FIRST_COMMITTED_TICK: i64 = 0;
/// `socialParticipantsCache`: 30 seconds, 999 entries. Node has no bound in
/// bytes; this one only ever makes an entry leave earlier, which reads it
/// again.
const ROWS_KEPT_MS: f64 = 30_000.0;
const ROWS_ENTRIES: usize = 999;
const ROWS_BYTES: usize = 16 << 20;
/// `votesForZidPidCache`: 5000 entries. Node has no bound in bytes; this one
/// only ever makes an entry leave earlier, which reads it again.
const LETTERS_ENTRIES: usize = 5000;
const LETTERS_BYTES: usize = 32 << 20;

// Bounds Node does not have. Beyond any of them the request goes to Node.
const QUERY_BYTES: usize = 4096;
const FEATURED_COMMENTS: usize = 4096;
const AUTHORS: usize = 1000;
const ROWS: usize = 200;
const ROW_TEXT_BYTES: i32 = 8192;
const HISTORY_ROWS: usize = 100_000;
const GREATEST_COMMENT: i32 = 32_767;
const REPLY_BYTES: usize = 1 << 20;
/// JavaScript's exact integers: a tick beyond them is not the number Node reads.
const EXACT_INTEGER: u64 = 9_007_199_254_740_991;

pub(crate) const DEADLINE: Duration = Duration::from_millis(150);

/// The data pool: the math generation, the featured authors, the participant
/// rows and the histories of choices.
pub fn pool_limits() -> crate::db::Limits {
    crate::db::Limits {
        size: 2,
        acquire_timeout: Duration::from_millis(15),
        statement_timeout: Duration::from_millis(100),
        max_lifetime: Duration::from_secs(300),
    }
}

/// The identity pool: the requester, the conversation code and its row.
pub fn auth_pool_limits() -> crate::db::Limits {
    crate::db::Limits {
        size: 1,
        acquire_timeout: Duration::from_millis(15),
        statement_timeout: Duration::from_millis(50),
        max_lifetime: Duration::from_secs(300),
    }
}

/// Why a request went back to Node. A closed set: every 502 of this route
/// carries one of these names in `X-Polis-Handback`, and `/health` counts them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Handback {
    /// The handler switch is off.
    Off,
    /// A method, body, cookie or parameter this route does not admit.
    Request,
    /// A credential this process does not resolve as Node does.
    Identity,
    /// No conversation for the code, or no row for the conversation.
    Conversation,
    /// The math generation could not be read whole: too large, malformed,
    /// or the database did not answer.
    MathUnreadable,
    /// The math tables are at different ticks, or one is missing.
    MathIncoherent,
    /// The consensus or the representative comments are not in the shape
    /// the math writes.
    MathShape,
    /// A featured participant, or the requester, has more than one row: Node
    /// keeps whichever comes last, and the query has no order.
    AmbiguousRows,
    /// More rows, text, history or reply than this process reads.
    Oversize,
    /// The database did not answer in time, or refused.
    Database,
    /// The request's own deadline.
    Deadline,
}

impl Handback {
    pub const ALL: [Self; 11] = [
        Self::Off,
        Self::Request,
        Self::Identity,
        Self::Conversation,
        Self::MathUnreadable,
        Self::MathIncoherent,
        Self::MathShape,
        Self::AmbiguousRows,
        Self::Oversize,
        Self::Database,
        Self::Deadline,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Request => "request",
            Self::Identity => "identity",
            Self::Conversation => "conversation",
            Self::MathUnreadable => "math_unreadable",
            Self::MathIncoherent => "math_incoherent",
            Self::MathShape => "math_shape",
            Self::AmbiguousRows => "ambiguous_rows",
            Self::Oversize => "oversize",
            Self::Database => "database",
            Self::Deadline => "deadline",
        }
    }
}

/// One row of `getSocialParticipants`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Row {
    pub priority: i32,
    pub pid: i32,
    /// The account the row is for. It ranks the kept rows; it is never part
    /// of a reply.
    pub uid: i32,
    pub social: Flat,
}

#[derive(Clone)]
struct KeptRows {
    stored_ms: f64,
    rows: Arc<Vec<Row>>,
}

/// `lru-cache` as Node uses it here (a bound on the number of entries, `get`
/// and `set` both make an entry the most recent), with a bound in bytes that
/// Node does not have: over either, the least recent entries leave.
struct Kept<K, V> {
    cap: usize,
    max_bytes: usize,
    bytes: usize,
    entries: HashMap<K, (V, usize)>,
    order: VecDeque<K>,
}

impl<K: Copy + Eq + std::hash::Hash, V: Clone> Kept<K, V> {
    fn new(cap: usize, max_bytes: usize) -> Self {
        Self {
            cap,
            max_bytes,
            bytes: 0,
            entries: HashMap::new(),
            order: VecDeque::new(),
        }
    }

    fn touch(&mut self, key: K) {
        self.order.retain(|k| *k != key);
        self.order.push_back(key);
    }

    fn get(&mut self, key: K) -> Option<V> {
        let (found, _) = self.entries.get(&key).cloned()?;
        self.touch(key);
        Some(found)
    }

    /// `lru-cache`'s `del`.
    fn remove(&mut self, key: K) {
        self.order.retain(|k| *k != key);
        if let Some((_, size)) = self.entries.remove(&key) {
            self.bytes -= size;
        }
    }

    fn set(&mut self, key: K, value: V, size: usize) {
        self.touch(key);
        self.bytes += size;
        if let Some((_, old)) = self.entries.insert(key, (value, size)) {
            self.bytes -= old;
        }
        while self.entries.len() > self.cap || self.bytes > self.max_bytes {
            let Some(oldest) = self.order.pop_front() else {
                break;
            };
            if let Some((_, old)) = self.entries.remove(&oldest) {
                self.bytes -= old;
            }
        }
    }
}

/// A participant's letters and the `math_tick` of the request that read them.
type KeptLetters = (i64, Arc<str>);

/// This route's two process caches and its hand-back counters.
pub struct State {
    /// `[zid, limit, mod, math_tick].join("_")`; `mod` is constant.
    rows: Mutex<Kept<(i32, i32, i64), KeptRows>>,
    letters: Mutex<Kept<(i32, i32), KeptLetters>>,
    handbacks: [AtomicU64; Handback::ALL.len()],
}

impl Default for State {
    fn default() -> Self {
        Self::with_bytes(ROWS_BYTES, LETTERS_BYTES)
    }
}

impl State {
    fn with_bytes(rows: usize, letters: usize) -> Self {
        Self {
            rows: Mutex::new(Kept::new(ROWS_ENTRIES, rows)),
            letters: Mutex::new(Kept::new(LETTERS_ENTRIES, letters)),
            handbacks: std::array::from_fn(|_| AtomicU64::new(0)),
        }
    }

    /// The rows Node would still answer from: stored at most 30 seconds ago.
    /// An older entry is dropped, as `lru-cache` drops it on `get`.
    fn kept_rows(&self, key: (i32, i32, i64), now_ms: f64) -> Option<Arc<Vec<Row>>> {
        let mut rows = self.rows.lock().unwrap_or_else(|e| e.into_inner());
        let kept = rows.get(key)?;
        if now_ms - kept.stored_ms > ROWS_KEPT_MS {
            rows.remove(key);
            return None;
        }
        Some(kept.rows)
    }

    fn keep_rows(&self, key: (i32, i32, i64), now_ms: f64, rows: Arc<Vec<Row>>) {
        let text = |v: &Option<String>| v.as_ref().map_or(0, String::len);
        let size: usize = rows
            .iter()
            .map(|r| {
                std::mem::size_of::<Row>()
                    + text(&r.social.x_profile_image_url)
                    + text(&r.social.xid)
                    + text(&r.social.x_name)
                    + text(&r.social.x_email)
            })
            .sum();
        self.rows.lock().unwrap_or_else(|e| e.into_inner()).set(
            key,
            KeptRows {
                stored_ms: now_ms,
                rows,
            },
            size,
        );
    }

    /// `getVotesForZidPidWithTimestampCheck` for each participant, in order:
    /// the kept letters when they were read at this tick or a later one.
    fn kept_letters(&self, zid: i32, pids: &[i32], tick: i64) -> Vec<Option<Arc<str>>> {
        let mut letters = self.letters.lock().unwrap_or_else(|e| e.into_inner());
        pids.iter()
            .map(|pid| {
                letters
                    .get((zid, *pid))
                    .filter(|(kept_at, _)| *kept_at >= tick)
                    .map(|(_, kept)| kept)
            })
            .collect()
    }

    fn keep_letters(&self, zid: i32, tick: i64, read: &BTreeMap<i32, Arc<str>>) {
        let mut letters = self.letters.lock().unwrap_or_else(|e| e.into_inner());
        for (pid, value) in read {
            letters.set((zid, *pid), (tick, value.clone()), value.len());
        }
    }

    /// `{reason: count}` for `/health`, every reason present.
    pub(crate) fn handbacks(&self) -> crate::js::Js {
        let mut out = crate::js::Obj::new();
        for (reason, count) in Handback::ALL.iter().zip(&self.handbacks) {
            out.set(
                reason.as_str(),
                crate::js::Js::Num(count.load(Ordering::Relaxed) as f64),
            );
        }
        crate::js::Js::Obj(out)
    }
}

/// The 502 nginx turns into Node's answer, naming its reason.
pub(crate) fn handback(app: &App, reason: Handback) -> Outgoing {
    let index = Handback::ALL
        .iter()
        .position(|r| *r == reason)
        .unwrap_or_default();
    app.votes_famous.handbacks[index].fetch_add(1, Ordering::Relaxed);
    let mut out = route::bad_gateway();
    out.headers
        .push(("X-Polis-Handback".into(), reason.as_str().into()));
    out
}

/// A parameter Node's `getInt` reads as this integer and no other spelling of it.
fn canonical(value: &str) -> Option<i64> {
    let n = value.parse::<i64>().ok()?;
    (n.to_string() == value).then_some(n)
}

pub fn parse(app: &App, req: &Request) -> Result<contract::Request, Handback> {
    if app.votes_famous_db.is_none() || app.votes_famous_auth_db.is_none() {
        return Err(Handback::Off);
    }
    if req.path() != PATH
        || !matches!(req.method.as_str(), "GET" | "HEAD")
        || !req.body.is_empty()
        || req.headers.get("transfer-encoding").is_some()
        || req.headers.get("content-length").is_some_and(|s| s != "0")
        || req.headers.get("cookie").is_some()
    {
        return Err(Handback::Request);
    }
    let raw = req.query().ok_or(Handback::Request)?;
    if raw.len() > QUERY_BYTES {
        return Err(Handback::Request);
    }
    let (mut cid, mut tick, mut limit) = (None, None, None);
    for (k, v) in url::form_urlencoded::parse(raw.as_bytes()) {
        match k.as_ref() {
            "conversation_id" if cid.is_none() => cid = Some(v.into_owned()),
            "math_tick" if tick.is_none() => {
                let n = canonical(&v).ok_or(Handback::Request)?;
                if n.unsigned_abs() > EXACT_INTEGER {
                    return Err(Handback::Request);
                }
                tick = Some(n);
            }
            "ptptoiLimit" if limit.is_none() => {
                let n = canonical(&v).ok_or(Handback::Request)?;
                if !(0..=i64::from(contract::MAX_LIMIT)).contains(&n) {
                    return Err(Handback::Request);
                }
                limit = Some(n as i32);
            }
            _ => return Err(Handback::Request),
        }
    }
    let cid = cid.ok_or(Handback::Request)?;
    if cid.is_empty() || cid.len() > 100 || !cid.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return Err(Handback::Request);
    }
    Ok(contract::Request {
        conversation_id: cid,
        math_tick: tick.unwrap_or(contract::LATEST_TICK),
        limit: limit.unwrap_or(contract::DEFAULT_LIMIT),
    })
}

pub async fn handle(app: &App, req: &Request, res: Res) -> Outgoing {
    match tokio::time::timeout(DEADLINE, answer(app, req)).await {
        Ok(Ok(body)) => route::json_text(req, res, 200, body),
        Ok(Err(reason)) => handback(app, reason),
        Err(_) => handback(app, Handback::Deadline),
    }
}

async fn answer(app: &App, req: &Request) -> Result<String, Handback> {
    let query = parse(app, req)?;
    let (Some(pool), Some(auth_pool)) = (&app.votes_famous_db, &app.votes_famous_auth_db) else {
        return Err(Handback::Off);
    };
    let identity = crate::hybrid_read::resolve_scoped(
        req.headers.get("authorization"),
        app.participant_verifier.as_deref(),
        app.read_oidc.as_deref(),
        auth_pool,
        Some(&query.conversation_id),
    )
    .await
    .ok_or(Handback::Identity)?;
    let cid = query.conversation_id.clone();
    let zid = auth_pool
        .with(move |c| crate::db::zid_for_conversation_id(c, &cid))
        .await
        .map_err(|_| Handback::Database)?
        .filter(|zid| *zid > 0)
        .ok_or(Handback::Conversation)?;
    Reader {
        state: &app.votes_famous,
        math: &app.math_bundle,
        math_env: &app.math_env,
        pool,
        auth_pool,
        now_ms: &crate::clock::now_ms,
    }
    .featured(zid, identity.uid().map(|v| v.0), &query)
    .await
}

/// What one answer reads from: this route's caches and pools, the shared
/// math cache, and the clock the 30-second rows are timed with.
pub(crate) struct Reader<'a> {
    pub state: &'a State,
    pub math: &'a crate::math_bundle::Cache,
    pub math_env: &'a str,
    pub pool: &'a Arc<Pool>,
    pub auth_pool: &'a Arc<Pool>,
    pub now_ms: &'a (dyn Fn() -> f64 + Sync),
}

impl Reader<'_> {
    /// `doFamousQuery` for a resolved conversation and requester: the reply's
    /// body, or the reason it is Node's to give.
    pub(crate) async fn featured(
        &self,
        zid: i32,
        uid: Option<i32>,
        query: &contract::Request,
    ) -> Result<String, Handback> {
        let bundle = self
            .math
            .get(self.pool, zid, self.math_env)
            .await
            .ok_or(Handback::MathUnreadable)?;
        let featured = featured_comments(&bundle)?;
        let anonymous = self
            .auth_pool
            .with(move |c| anonymous_conversation(c, zid))
            .await
            .map_err(|_| Handback::Database)?
            .ok_or(Handback::Conversation)?;
        if anonymous {
            return Ok("{}".into());
        }
        let key = (zid, query.limit, query.math_tick);
        let kept = match self.state.kept_rows(key, (self.now_ms)()) {
            Some(rows) => rows,
            None => {
                // Node asks for the authors on every request and uses them
                // only here, when it reads the rows.
                let authors = if featured.is_empty() {
                    Vec::new()
                } else {
                    self.pool
                        .with(move |c| featured_authors(c, zid, &featured))
                        .await
                        .map_err(|_| Handback::Database)??
                };
                let limit = i64::from(query.limit);
                let rows = Arc::new(
                    self.pool
                        .with(move |c| participant_rows(c, zid, limit, &authors))
                        .await
                        .map_err(|_| Handback::Database)??,
                );
                self.state.keep_rows(key, (self.now_ms)(), rows.clone());
                rows
            }
        };
        // The requester's own row is decided on every request and is never
        // kept. Nobody has one at a limit of zero. A requester who is one of
        // the featured participants gets that row as their own; any other
        // identified requester gets a row read for them alone.
        let rows = match uid {
            Some(uid) if query.limit > 0 => match featured_as_own(&kept, uid) {
                Some(rows) => rows,
                None => {
                    let own = self
                        .pool
                        .with(move |c| own_row(c, zid, uid))
                        .await
                        .map_err(|_| Handback::Database)??;
                    with_own_row(&kept, own, query.limit)
                }
            },
            _ => kept.to_vec(),
        };
        // `pids.sort(...)`: the kept letters are looked up in this order.
        let mut pids: Vec<i32> = rows.iter().map(|r| r.pid).collect();
        pids.sort_unstable();
        let letters = letters_for(self.state, self.pool, zid, &pids, query.math_tick).await?;
        let body = match assemble(&rows, &letters, &bundle) {
            Some(response) => serde_json::to_string(&response).map_err(|_| Handback::Oversize)?,
            None => "{}".into(),
        };
        if body.len() > REPLY_BYTES {
            return Err(Handback::Oversize);
        }
        Ok(body)
    }
}

/// `getVotesForZidPidsWithTimestampCheck`: kept letters where they are
/// recent enough, one read for all the other participants together.
async fn letters_for(
    state: &State,
    pool: &Arc<Pool>,
    zid: i32,
    pids: &[i32],
    tick: i64,
) -> Result<BTreeMap<i32, Arc<str>>, Handback> {
    let kept = state.kept_letters(zid, pids, tick);
    let mut out = BTreeMap::new();
    let mut missing = Vec::new();
    for (pid, kept) in pids.iter().zip(kept) {
        match kept {
            Some(letters) => {
                out.insert(*pid, letters);
            }
            None => missing.push(*pid),
        }
    }
    if missing.is_empty() {
        return Ok(out);
    }
    let read = pool
        .with(move |c| histories(c, zid, &missing))
        .await
        .map_err(|_| Handback::Database)??;
    let read = letters_of(&read)?;
    state.keep_letters(zid, tick, &read);
    // `Object.assign(newPidToVotes, cachedPidToVotes)`: the two never overlap.
    out.extend(read);
    Ok(out)
}

/// The comment numbers `getAuthorUidsOfFeaturedComments` asks the authors of:
/// the consensus (agree and disagree) and each group's representative
/// comments. Empty when there is no committed math.
pub(crate) fn featured_comments(bundle: &Read) -> Result<Vec<i32>, Handback> {
    let main = match bundle {
        Read::Absent => return Ok(Vec::new()),
        read if read.tick() < FIRST_COMMITTED_TICK => return Ok(Vec::new()),
        // Node presents the main document even when its companions are
        // missing or at another tick; this process does not hold it then.
        Read::Incoherent(_) => return Err(Handback::MathIncoherent),
        Read::Complete(b) => &b.main,
    };
    let tids = featured_in(main)?;
    if tids.len() > FEATURED_COMMENTS {
        return Err(Handback::Oversize);
    }
    Ok(tids.into_iter().collect())
}

fn tid_of(entry: &serde_json::Value) -> Result<i32, Handback> {
    entry
        .as_object()
        .and_then(|o| o.get("tid"))
        .and_then(serde_json::Value::as_i64)
        .and_then(|n| i32::try_from(n).ok())
        .ok_or(Handback::MathShape)
}

fn tids_of(list: Option<&serde_json::Value>, into: &mut BTreeSet<i32>) -> Result<(), Handback> {
    match list {
        None | Some(serde_json::Value::Null) => Ok(()),
        Some(serde_json::Value::Array(entries)) => {
            for entry in entries {
                into.insert(tid_of(entry)?);
            }
            Ok(())
        }
        Some(_) => Err(Handback::MathShape),
    }
}

/// Only the shapes the math writes are read: anything else Node reshapes,
/// empties or fails on in ways this module does not copy.
fn featured_in(main: &Main) -> Result<BTreeSet<i32>, Handback> {
    let mut tids = BTreeSet::new();
    match &main.consensus {
        None | Some(serde_json::Value::Null) => {}
        Some(serde_json::Value::Object(consensus)) => {
            tids_of(consensus.get("agree"), &mut tids)?;
            tids_of(consensus.get("disagree"), &mut tids)?;
        }
        Some(_) => return Err(Handback::MathShape),
    }
    match &main.repness {
        None | Some(serde_json::Value::Null) => {}
        Some(serde_json::Value::Array(groups)) if groups.is_empty() => {}
        Some(serde_json::Value::Object(groups)) => {
            for (gid, comments) in groups {
                // Node renumbers the groups with `Number(gid)`: two spellings
                // of one number would replace each other.
                if gid.parse::<u32>().ok().map(|n| n.to_string()).as_deref() != Some(gid) {
                    return Err(Handback::MathShape);
                }
                if !comments.is_array() {
                    return Err(Handback::MathShape);
                }
                tids_of(Some(comments), &mut tids)?;
            }
        }
        Some(_) => return Err(Handback::MathShape),
    }
    Ok(tids)
}

/// `conv.is_anon`, or None when the conversation has no row.
pub(crate) fn anonymous_conversation(
    c: &mut postgres::Client,
    zid: i32,
) -> anyhow::Result<Option<bool>> {
    let rows = c.query(
        "SELECT is_anon FROM conversations WHERE zid=$1 LIMIT 2",
        &[&zid],
    )?;
    if rows.len() != 1 {
        return Ok(None);
    }
    Ok(Some(
        rows[0].try_get::<_, Option<bool>>(0)?.unwrap_or(false),
    ))
}

/// The authors of the featured comments who hold an external id under any
/// account: `getAuthorUidsOfFeaturedComments`' query, the comment numbers as
/// one array parameter.
pub(crate) fn featured_authors(
    c: &mut postgres::Client,
    zid: i32,
    tids: &[i32],
) -> anyhow::Result<Result<Vec<i32>, Handback>> {
    let rows = c.query(
        &format!(
            "with authors as (select distinct(uid) from comments where zid = ($1) and tid = any($2) order by uid) \
             select authors.uid from authors inner join xids on xids.uid = authors.uid order by uid limit {}",
            AUTHORS + 1
        ),
        &[&zid, &tids],
    )?;
    if rows.len() > AUTHORS {
        return Ok(Err(Handback::Oversize));
    }
    let mut uids = Vec::new();
    for row in rows {
        let uid: i32 = row.try_get(0)?;
        if uids.last() != Some(&uid) {
            uids.push(uid);
        }
    }
    Ok(Ok(uids))
}

/// The statement of `getSocialParticipants` for the featured participants,
/// as Node builds it: moderators' pins, the featured authors and the
/// external-id participants, ranked, the first `limit` of them, each with
/// the account it is for. The requester is not in it. Two additions bound
/// what is read without changing which rows it is: a row whose four text
/// columns exceed `ROW_TEXT_BYTES` comes back without them and marked, and at
/// most `ROWS + 1` rows are read.
fn participant_rows_sql(authors: &[i32]) -> String {
    let authors_cte = if authors.is_empty() {
        String::new()
    } else {
        let parts: Vec<String> = authors
            .iter()
            .map(|uid| format!("select {uid} as uid, 900 as priority"))
            .collect();
        format!("authors as ({}), ", parts.join(" union "))
    };
    let authors_union = if authors.is_empty() {
        ""
    } else {
        "select * from authors union "
    };
    format!(
        "with \
         p as (select uid, pid, mod from participants p0 where zid = ($1) and EXISTS (SELECT 1 FROM votes v WHERE v.zid=p0.zid AND v.pid=p0.pid)), \
         xids_subset as (select * from xids where owner in (select org_id from conversations where zid = ($1)) and x_profile_image_url is not null), \
         xid_ptpts as (select p.uid, 100 as priority from p inner join xids_subset on xids_subset.uid = p.uid where p.mod >= ($3)), \
         {authors_cte}\
         pptpts as (select prioritized_ptpts.uid, max(prioritized_ptpts.priority) as priority \
         from ( \
         {authors_union}\
         select * from xid_ptpts \
         ) as prioritized_ptpts \
         inner join p on prioritized_ptpts.uid = p.uid \
         group by prioritized_ptpts.uid order by priority desc, prioritized_ptpts.uid asc), \
         mod_pptpts as (select asdfasdjfioasjdfoi.uid, max(asdfasdjfioasjdfoi.priority) as priority \
         from ( \
         select * from pptpts \
         union all \
         select uid, 999 as priority from p where mod >= 2) as asdfasdjfioasjdfoi \
         group by asdfasdjfioasjdfoi.uid order by priority desc, asdfasdjfioasjdfoi.uid asc), \
         final_set as (select * from mod_pptpts \
         limit ($2) \
         ), \
         read as (select \
         final_set.priority, \
         xids_subset.x_profile_image_url as x_profile_image_url, \
         xids_subset.xid as xid, \
         xids_subset.x_name as x_name, \
         xids_subset.x_email as x_email, \
         p.pid, \
         {fits} as fits, \
         final_set.uid \
         from final_set \
         left join xids_subset on final_set.uid = xids_subset.uid \
         left join p on final_set.uid = p.uid) \
         select priority, \
         case when fits then x_profile_image_url end, \
         case when fits then xid end, \
         case when fits then x_name end, \
         case when fits then x_email end, \
         pid, fits, uid from read limit {}",
        ROWS + 1,
        fits = fits_sql()
    )
}

/// Whether a row's four text columns are within `ROW_TEXT_BYTES`.
fn fits_sql() -> String {
    format!(
        "coalesce(octet_length(xids_subset.x_profile_image_url),0)+coalesce(octet_length(xids_subset.xid),0)\
         +coalesce(octet_length(xids_subset.x_name),0)+coalesce(octet_length(xids_subset.x_email),0) <= {ROW_TEXT_BYTES}"
    )
}

pub(crate) fn participant_rows(
    c: &mut postgres::Client,
    zid: i32,
    limit: i64,
    authors: &[i32],
) -> anyhow::Result<Result<Vec<Row>, Handback>> {
    let found = c.query(&participant_rows_sql(authors), &[&zid, &limit, &SHOWN_FROM])?;
    if found.len() > ROWS {
        return Ok(Err(Handback::Oversize));
    }
    let mut rows: Vec<Row> = Vec::with_capacity(found.len());
    for row in found {
        if !row.try_get::<_, bool>(6)? {
            return Ok(Err(Handback::Oversize));
        }
        let (Some(priority), Some(pid), Some(uid)) = (
            row.try_get::<_, Option<i32>>(0)?,
            row.try_get::<_, Option<i32>>(5)?,
            row.try_get::<_, Option<i32>>(7)?,
        ) else {
            return Ok(Err(Handback::Database));
        };
        // A negative number would not sort among a JavaScript object's keys
        // as it does here.
        if pid < 0 {
            return Ok(Err(Handback::Database));
        }
        if rows.iter().any(|r| r.pid == pid) {
            return Ok(Err(Handback::AmbiguousRows));
        }
        rows.push(Row {
            priority,
            pid,
            uid,
            social: Flat {
                x_profile_image_url: row.try_get(1)?,
                xid: row.try_get(2)?,
                x_name: row.try_get(3)?,
                x_email: row.try_get(4)?,
            },
        });
    }
    Ok(Ok(rows))
}

/// The statement for the row of a requester who is not one of the featured
/// participants, as Node builds it: the columns of a featured participant's
/// row for one account, when it is a participant of the conversation with at
/// least one row of vote history. The same bound on the row's text, and at
/// most two rows are read.
fn own_row_sql() -> String {
    format!(
        "with \
         p as (select uid, pid from participants p0 where zid = ($1) and uid = ($2) and EXISTS (SELECT 1 FROM votes v WHERE v.zid=p0.zid AND v.pid=p0.pid)), \
         xids_subset as (select * from xids where uid = ($2) and owner in (select org_id from conversations where zid = ($1)) and x_profile_image_url is not null), \
         read as (select \
         xids_subset.x_profile_image_url as x_profile_image_url, \
         xids_subset.xid as xid, \
         xids_subset.x_name as x_name, \
         xids_subset.x_email as x_email, \
         p.pid, \
         {fits} as fits \
         from p \
         left join xids_subset on p.uid = xids_subset.uid) \
         select \
         case when fits then x_profile_image_url end, \
         case when fits then xid end, \
         case when fits then x_name end, \
         case when fits then x_email end, \
         pid, fits from read limit 2",
        fits = fits_sql()
    )
}

/// The row of a requester who is not one of the featured participants, at
/// the requester's priority, or None when the account is no participant of
/// the conversation or has no row of vote history. It is read for the
/// request that asks and is never kept.
pub(crate) fn own_row(
    c: &mut postgres::Client,
    zid: i32,
    uid: i32,
) -> anyhow::Result<Result<Option<Row>, Handback>> {
    let found = c.query(&own_row_sql(), &[&zid, &uid])?;
    // Two external ids of one person under the conversation's account.
    if found.len() > 1 {
        return Ok(Err(Handback::AmbiguousRows));
    }
    let Some(row) = found.first() else {
        return Ok(Ok(None));
    };
    if !row.try_get::<_, bool>(5)? {
        return Ok(Err(Handback::Oversize));
    }
    let Some(pid) = row.try_get::<_, Option<i32>>(4)? else {
        return Ok(Err(Handback::Database));
    };
    if pid < 0 {
        return Ok(Err(Handback::Database));
    }
    Ok(Ok(Some(Row {
        priority: contract::SELF_PRIORITY,
        pid,
        uid,
        social: Flat {
            x_profile_image_url: row.try_get(0)?,
            xid: row.try_get(1)?,
            x_name: row.try_get(2)?,
            x_email: row.try_get(3)?,
        },
    })))
}

/// The rows of one reply to a requester who is one of the featured
/// participants (a pin, a featured author, an external id): the kept rows,
/// with the requester's at the requester's priority. None when the account
/// is not among them. The kept rows themselves are not changed.
pub(crate) fn featured_as_own(kept: &[Row], uid: i32) -> Option<Vec<Row>> {
    if !kept.iter().any(|r| r.uid == uid) {
        return None;
    }
    Some(
        kept.iter()
            .map(|r| Row {
                priority: if r.uid == uid {
                    contract::SELF_PRIORITY
                } else {
                    r.priority
                },
                ..r.clone()
            })
            .collect(),
    )
}

/// The rows of one reply to a requester who is not one of the featured
/// participants: their own row, when there is one, takes the first of the
/// `limit` places. When the kept rows already fill the limit, the last of
/// their ranking (the lowest priority, then the greatest account) gives up
/// its place. The kept rows themselves are not changed.
pub(crate) fn with_own_row(kept: &[Row], own: Option<Row>, limit: i32) -> Vec<Row> {
    let Some(own) = own else {
        return kept.to_vec();
    };
    let mut rows: Vec<Row> = kept.iter().filter(|r| r.pid != own.pid).cloned().collect();
    // One row a person: a second row for anyone is never kept.
    if rows.len() >= usize::try_from(limit).unwrap_or(0) {
        let last = rows
            .iter()
            .enumerate()
            .min_by_key(|(_, r)| (r.priority, std::cmp::Reverse(r.uid)))
            .map(|(at, _)| at);
        if let Some(last) = last {
            rows.remove(last);
        }
    }
    rows.insert(0, own);
    rows
}

/// One row of a participant's history: the comment and the stored choice.
pub(crate) struct Cast {
    pub pid: i32,
    pub tid: i32,
    pub stored: Option<i16>,
}

/// `getVotesForPids`: every row of the history table for these participants,
/// oldest last change first within a comment, so the latest stands.
pub(crate) fn histories(
    c: &mut postgres::Client,
    zid: i32,
    pids: &[i32],
) -> anyhow::Result<Result<Vec<Cast>, Handback>> {
    let rows = c.query(
        &format!(
            "select pid, tid, vote from votes where zid = ($1) and pid = any($2) order by pid, tid, created limit {}",
            HISTORY_ROWS + 1
        ),
        &[&zid, &pids],
    )?;
    if rows.len() > HISTORY_ROWS {
        return Ok(Err(Handback::Oversize));
    }
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        out.push(Cast {
            pid: row.try_get(0)?,
            tid: row.try_get(1)?,
            stored: row.try_get(2)?,
        });
    }
    Ok(Ok(out))
}

/// `aggregateVotesToPidVotesObj`: one string of letters for each participant
/// with a row, as long as the greatest comment number among ALL the rows of
/// this read. A stored value that is no choice (none, or out of range) leaves
/// the letter the earlier rows gave.
pub(crate) fn letters_of(rows: &[Cast]) -> Result<BTreeMap<i32, Arc<str>>, Handback> {
    let greatest = rows.iter().map(|r| r.tid).max().unwrap_or(0).max(0);
    if greatest > GREATEST_COMMENT {
        return Err(Handback::Oversize);
    }
    let length = greatest as usize + 1;
    let mut vectors: BTreeMap<i32, Vec<u8>> = BTreeMap::new();
    for row in rows {
        let vector = vectors
            .entry(row.pid)
            .or_insert_with(|| vec![contract::UNSEEN as u8; length]);
        // Every stored choice is read through the convention, never by its sign.
        let choice = crate::votes::StorageConvention::CURRENT.decode(row.stored.map(i32::from));
        if let (Some(choice), Ok(at)) = (choice, usize::try_from(row.tid)) {
            vector[at] = contract::letter(choice) as u8;
        }
    }
    Ok(vectors
        .into_iter()
        .map(|(pid, vector)| {
            let letters: String = vector.into_iter().map(char::from).collect();
            (pid, Arc::from(letters))
        })
        .collect())
}

/// `doFamousQuery` after its reads: None is the `{}` Node answers when the
/// math exists and is not committed.
pub(crate) fn assemble(
    rows: &[Row],
    letters: &BTreeMap<i32, Arc<str>>,
    bundle: &Read,
) -> Option<Response> {
    // `getBidsForPids`: a generation that is present and not committed rejects.
    if !matches!(bundle, Read::Absent) && bundle.tick() < FIRST_COMMITTED_TICK {
        return None;
    }
    let mut participants: Vec<Participant> = Vec::with_capacity(rows.len());
    for row in rows {
        let mut participant = Participant::from_row(row.priority, row.pid, row.social.clone());
        // `_.each(vectors, ...)`: only a participant with letters is placed
        // or left out.
        if let Some(found) = letters.get(&row.pid) {
            let bid = match bundle {
                Read::Complete(b) => b.bid(row.pid),
                _ => None,
            };
            if bid.is_none() && participant.is_self.is_none() {
                continue;
            }
            participant.choices = Some(found.to_string());
            participant.bid = bid;
        }
        participants.push(participant);
    }
    participants.sort_by_key(|p| p.pid);
    Some(Response(participants))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::math_bundle::{Base, Bundle, Mapping};
    use crate::votes::{StorageConvention, VoteChoice};

    fn stored(choice: VoteChoice) -> Option<i16> {
        i16::try_from(StorageConvention::CURRENT.encode(choice)).ok()
    }
    fn cast(pid: i32, tid: i32, stored: Option<i16>) -> Cast {
        Cast { pid, tid, stored }
    }
    fn none() -> Flat {
        Flat {
            x_profile_image_url: None,
            xid: None,
            x_name: None,
            x_email: None,
        }
    }
    fn external(url: &str, name: Option<&str>) -> Flat {
        Flat {
            x_profile_image_url: Some(url.into()),
            xid: Some("an id".into()),
            x_name: name.map(str::to_string),
            x_email: Some("someone@example.invalid".into()),
        }
    }
    /// A row whose account is its participant number plus 1000.
    fn row(priority: i32, pid: i32, social: Flat) -> Row {
        Row {
            priority,
            pid,
            uid: 1000 + pid,
            social,
        }
    }
    fn complete(tick: i64, ids: &[i32], mapping: &[&[i32]]) -> Read {
        Read::Complete(Bundle {
            tick,
            main: Main {
                base: Some(Base { id: ids.to_vec() }),
                ..Main::default()
            },
            mapping: Mapping {
                rows: Some(mapping.iter().map(|r| r.to_vec()).collect()),
            },
        })
    }
    fn body(rows: &[Row], letters: &BTreeMap<i32, Arc<str>>, bundle: &Read) -> String {
        match assemble(rows, letters, bundle) {
            Some(response) => serde_json::to_string(&response).unwrap(),
            None => "{}".into(),
        }
    }
    fn recorded(id: &str) -> String {
        let all: Vec<serde_json::Value> = serde_json::from_str(include_str!(
            "../../polis-contracts/src/fixtures/votes-famous.json"
        ))
        .unwrap();
        all.iter()
            .find(|r| r["id"] == id)
            .unwrap_or_else(|| panic!("no recording {id}"))["body"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    /// The histories of the recorded conversation `history/...`, as the
    /// fixture wrote them: participant 1 with every kind of row.
    fn recorded_history() -> Vec<Cast> {
        use VoteChoice::{Agree, Disagree, Pass};
        let mut rows = vec![
            // tid 0: agree, then disagree, then pass.
            cast(1, 0, stored(Agree)),
            cast(1, 0, stored(Disagree)),
            cast(1, 0, stored(Pass)),
            // tid 1: pass, then a row with no choice.
            cast(1, 1, stored(Pass)),
            cast(1, 1, None),
            // tid 2: disagree, then a value that is no choice.
            cast(1, 2, stored(Disagree)),
            cast(1, 2, Some(7)),
            cast(1, 3, stored(Agree)),
            cast(1, 4, stored(Pass)),
            cast(1, 5, stored(Disagree)),
            cast(1, 6, stored(Agree)),
            cast(1, 12, None),
            cast(1, 15, Some(7)),
            cast(1, 20, stored(Agree)),
            cast(5, 3, stored(Disagree)),
            cast(5, 30, stored(Pass)),
            cast(7, 2, stored(Agree)),
        ];
        rows.sort_by_key(|r| (r.pid, r.tid));
        rows
    }

    #[test]
    fn letters_follow_the_recorded_node_reply_for_every_kind_of_history() {
        let letters = letters_of(&recorded_history()).unwrap();
        let rows = [
            row(1000, 1, none()),
            row(
                100,
                5,
                external("https://example.invalid/other.png", Some("Other")),
            ),
            row(
                100,
                7,
                Flat {
                    x_profile_image_url: Some(String::new()),
                    xid: Some(String::new()),
                    x_name: Some("Address only".into()),
                    x_email: Some("mail@example.invalid".into()),
                },
            ),
        ];
        let bundle = complete(7, &[10, 11, 12, 13], &[&[1], &[5], &[6], &[7]]);
        assert_eq!(
            body(&rows, &letters, &bundle),
            recorded("history/cold/member")
        );
        // The length is the greatest comment number of the read, for everyone.
        assert!(letters.values().all(|l| l.len() == 31));
        assert_eq!(&*letters[&1], "ppdapdauuuuuuuuuuuuuauuuuuuuuuu");
    }

    #[test]
    fn letters_are_as_long_as_the_read_they_came_from() {
        use VoteChoice::Agree;
        let alone = letters_of(&[cast(9, 6, stored(Agree))]).unwrap();
        assert_eq!(&*alone[&9], "uuuuuua");
        let together = letters_of(&[cast(1, 9, stored(Agree)), cast(9, 6, stored(Agree))]).unwrap();
        assert_eq!(&*together[&9], "uuuuuuauuu");
        // No row at all: no participant, and nothing to keep.
        assert!(letters_of(&[]).unwrap().is_empty());
        // A row below zero is no comment: the participant still gets letters.
        let below = letters_of(&[cast(4, i32::MIN, stored(Agree))]).unwrap();
        assert_eq!(&*below[&4], "u");
        assert_eq!(
            letters_of(&[cast(4, GREATEST_COMMENT + 1, stored(Agree))]),
            Err(Handback::Oversize)
        );
        assert_eq!(
            letters_of(&[cast(4, GREATEST_COMMENT, stored(Agree))]).unwrap()[&4].len(),
            GREATEST_COMMENT as usize + 1
        );
    }

    #[test]
    fn every_stored_choice_is_read_through_the_convention() {
        use VoteChoice::{Agree, Disagree, Pass};
        // Under either storage convention the same meaning gives the same
        // letter: nothing here reads a sign.
        for (choice, letter) in [(Agree, "a"), (Disagree, "d"), (Pass, "p")] {
            assert_eq!(
                &*letters_of(&[cast(0, 0, stored(choice))]).unwrap()[&0],
                letter
            );
            assert_eq!(contract::letter(choice).to_string(), letter);
        }
        for invalid in [None, Some(2), Some(7), Some(i16::MIN), Some(i16::MAX)] {
            assert_eq!(&*letters_of(&[cast(0, 0, invalid)]).unwrap()[&0], "u");
        }
    }

    #[test]
    fn rows_join_the_math_as_the_recorded_node_replies_do() {
        let letters: BTreeMap<i32, Arc<str>> = [(1, "apdapda"), (2, "auuuuuu")]
            .into_iter()
            .map(|(pid, l)| (pid, Arc::from(l)))
            .collect();
        let two = external("https://example.invalid/s2.png", Some("Two"));
        let member = [row(1000, 1, none()), row(100, 2, two.clone())];
        let anonymous = [row(100, 2, two)];
        let alone: BTreeMap<i32, Arc<str>> = [(2, Arc::from("a"))].into_iter().collect();
        let placed = complete(0, &[10, 11, 12, 13], &[&[1], &[2], &[], &[]]);
        assert_eq!(
            body(&member, &letters, &placed),
            recorded("state/tick-zero/member")
        );
        assert_eq!(
            body(&anonymous, &alone, &placed),
            recorded("state/tick-zero/anonymous")
        );
        // A place with no label: the missing-label number, as Node logs and answers.
        let short = complete(10, &[10], &[&[1], &[2], &[], &[]]);
        assert_eq!(
            body(&member, &letters, &short),
            recorded("state/short-base-clusters/member")
        );
        // Nobody placed: the requester stays, without a cluster; others go.
        let unplaced = complete(11, &[10, 11, 12, 13], &[]);
        assert_eq!(
            body(&member, &letters, &unplaced),
            recorded("state/nobody-placed/member")
        );
        assert_eq!(
            body(&anonymous, &alone, &unplaced),
            recorded("state/nobody-placed/anonymous")
        );
        // No math at all, and math whose tables disagree: the same.
        for bundle in [Read::Absent, Read::Incoherent(30)] {
            assert_eq!(
                body(&member, &letters, &bundle),
                recorded("state/nobody-placed/member")
            );
        }
        // Math that is present and not committed answers {} whoever is in it.
        let uncommitted = FIRST_COMMITTED_TICK - 1;
        for bundle in [
            complete(uncommitted, &[10, 11], &[&[1], &[2]]),
            Read::Incoherent(uncommitted),
        ] {
            assert_eq!(
                body(&member, &letters, &bundle),
                recorded("state/not-committed/member")
            );
        }
        // A participant without letters is neither placed nor left out.
        let nobody = BTreeMap::new();
        assert_eq!(
            body(&member, &nobody, &unplaced),
            r#"{"1":{"priority":1000,"x_profile_image_url":null,"xid":null,"x_name":null,"x_email":null,"pid":1,"isSelf":true},"2":{"priority":100,"pid":2,"xInfo":{"x_profile_image_url":"https://example.invalid/s2.png","x_name":"Two"}}}"#
        );
    }

    #[test]
    fn the_requesters_own_row_is_decided_for_each_request() {
        // Nobody is featured in the recorded conversation: nothing is kept
        // but an empty list, and each reply is its own requester's.
        let kept: [Row; 0] = [];
        let letters: BTreeMap<i32, Arc<str>> = [(1, Arc::from("apdapda"))].into_iter().collect();
        let reply = |own: Option<Row>| {
            body(
                &with_own_row(&kept, own, contract::DEFAULT_LIMIT),
                &letters,
                &Read::Absent,
            )
        };
        let member = reply(Some(row(contract::SELF_PRIORITY, 1, none())));
        assert_eq!(member, recorded("no-math/cold/member"));
        assert!(member.contains(r#""isSelf":true"#));
        // The member asks after a requester without a credential, and gets
        // their own row.
        assert_eq!(member, recorded("no-math/warm/member-after-anonymous"));
        // A requester without a credential, and a member without a vote, ask
        // after the member: no row of their own, and nobody else's.
        for id in [
            "no-math/warm/anonymous-after-member",
            "no-math/warm/second-after-member",
        ] {
            assert_eq!(reply(None), recorded(id), "{id}");
            assert_eq!(recorded(id), "{}");
        }
    }

    #[test]
    fn the_own_row_takes_the_first_of_the_limits_places() {
        let picture = |n: i32| external(&format!("https://example.invalid/{n}.png"), None);
        // The kept ranking: a pin, a featured author, two external-id
        // participants. Among equals the smaller account comes first, and
        // the accounts here are not in the order of the participant numbers.
        let kept = [
            Row {
                uid: 40,
                ..row(999, 4, none())
            },
            Row {
                uid: 10,
                ..row(900, 0, none())
            },
            Row {
                uid: 50,
                ..row(100, 2, picture(2))
            },
            Row {
                uid: 30,
                ..row(100, 3, picture(3))
            },
        ];
        let before = kept.clone();
        let pids = |rows: &[Row]| -> Vec<(i32, i32)> {
            let mut out: Vec<(i32, i32)> = rows.iter().map(|r| (r.pid, r.priority)).collect();
            out.sort_unstable();
            out
        };
        let own = |pid: i32, uid: i32| Row {
            uid,
            ..row(contract::SELF_PRIORITY, pid, none())
        };
        // No requester's row: the kept rows, nobody marked.
        assert_eq!(with_own_row(&kept, None, 4), kept);
        // Room for everyone: the requester and all four.
        assert_eq!(
            pids(&with_own_row(&kept, Some(own(7, 70)), 5)),
            [(0, 900), (2, 100), (3, 100), (4, 999), (7, 1000)]
        );
        // The limit filled: the last of the ranking gives up its place, the
        // lowest priority and of those the greatest account (participant 2).
        assert_eq!(
            pids(&with_own_row(&kept, Some(own(7, 70)), 4)),
            [(0, 900), (3, 100), (4, 999), (7, 1000)]
        );
        // A requester who is one of the featured participants gets that row
        // as their own: once, and nobody gives up a place.
        let featured_too = featured_as_own(&kept, 10).unwrap();
        assert_eq!(
            pids(&featured_too),
            [(0, 1000), (2, 100), (3, 100), (4, 999)]
        );
        let last_too = featured_as_own(&kept, 50).unwrap();
        assert_eq!(pids(&last_too), [(0, 900), (2, 1000), (3, 100), (4, 999)]);
        assert_eq!(last_too[2].social, kept[2].social);
        // An account that is not among them has no row there.
        assert_eq!(featured_as_own(&kept, 70), None);
        assert_eq!(featured_as_own(&[], 10), None);
        // A limit of one: the requester alone.
        assert_eq!(
            pids(&with_own_row(&kept[..1], Some(own(7, 70)), 1)),
            [(7, 1000)]
        );
        assert_eq!(pids(&featured_as_own(&kept[..1], 40).unwrap()), [(4, 1000)]);
        // Fewer kept than the limit: nobody gives up a place.
        assert_eq!(
            pids(&with_own_row(&kept[..2], Some(own(7, 70)), 4)),
            [(0, 900), (4, 999), (7, 1000)]
        );
        // What is kept is never changed, and never holds a requester's row.
        assert_eq!(kept, before);
        assert!(kept.iter().all(|r| r.priority != contract::SELF_PRIORITY));
        // In a reply only the requester's own row is marked.
        let letters: BTreeMap<i32, Arc<str>> = [0, 2, 3, 4]
            .into_iter()
            .map(|pid| (pid, Arc::from("a")))
            .collect();
        let placed = complete(3, &[10], &[&[0, 2, 3, 4]]);
        let theirs = body(&featured_too, &letters, &placed);
        assert_eq!(theirs.matches(r#""isSelf":true"#).count(), 1);
        assert!(theirs.starts_with(r#"{"0":{"priority":1000,"#), "{theirs}");
        let nobodys = body(&with_own_row(&kept, None, 4), &letters, &placed);
        assert!(!nobodys.contains("isSelf"), "{nobodys}");
        assert!(nobodys.starts_with(r#"{"0":{"priority":900,"#), "{nobodys}");
    }

    fn main_with(consensus: &str, repness: &str) -> Read {
        let main: Main = serde_json::from_str(&format!(
            r#"{{"consensus":{consensus},"repness":{repness},"base-clusters":{{"id":[1]}}}}"#
        ))
        .unwrap();
        Read::Complete(Bundle {
            tick: 3,
            main,
            mapping: Mapping { rows: Some(vec![]) },
        })
    }

    #[test]
    fn featured_comments_are_the_consensus_and_each_groups_representatives() {
        assert_eq!(
            featured_comments(&main_with(
                r#"{"agree":[{"tid":6,"n-success":3},{"tid":0}],"disagree":[{"tid":2}]}"#,
                r#"{"0":[{"tid":1,"repness":1.5}],"1":[{"tid":2},{"tid":0}]}"#
            )),
            Ok(vec![0, 1, 2, 6])
        );
        for (consensus, repness) in [
            ("null", "null"),
            ("{}", "{}"),
            ("{}", "[]"),
            (r#"{"agree":null,"disagree":null}"#, r#"{"0":[]}"#),
        ] {
            assert_eq!(
                featured_comments(&main_with(consensus, repness)),
                Ok(vec![])
            );
        }
        // Without committed math Node asks for no authors at all.
        assert_eq!(featured_comments(&Read::Absent), Ok(vec![]));
        assert_eq!(
            featured_comments(&Read::Incoherent(FIRST_COMMITTED_TICK - 1)),
            Ok(vec![])
        );
        assert_eq!(
            featured_comments(&Read::Incoherent(4)),
            Err(Handback::MathIncoherent)
        );
        // Shapes Node empties, reshapes or fails on go back to Node.
        for (consensus, repness) in [
            (r#"{"agree":[{"tid":1},{}]}"#, "{}"),
            (r#"{"agree":[{"tid":null}]}"#, "{}"),
            (r#"{"disagree":[{"tid":"2"}]}"#, "{}"),
            (r#"{"agree":[{"tid":1.5}]}"#, "{}"),
            (r#"{"agree":[{"tid":2147483648}]}"#, "{}"),
            (r#"{"agree":{"0":{"tid":1}}}"#, "{}"),
            (r#"[{"tid":1}]"#, "{}"),
            ("5", "{}"),
            ("{}", "[1,2]"),
            ("{}", r#"[[{"tid":1}]]"#),
            ("{}", r#"{"0":{"tid":1}}"#),
            ("{}", r#"{"0":[{"repness":2}]}"#),
            ("{}", r#"{"0":[5]}"#),
            ("{}", r#"{"00":[{"tid":1}]}"#),
            ("{}", r#"{"x":[{"tid":1}]}"#),
            ("{}", "7"),
        ] {
            assert_eq!(
                featured_comments(&main_with(consensus, repness)),
                Err(Handback::MathShape),
                "{consensus} {repness}"
            );
        }
        let many: Vec<String> = (0..=FEATURED_COMMENTS)
            .map(|tid| format!(r#"{{"tid":{tid}}}"#))
            .collect();
        assert_eq!(
            featured_comments(&main_with(
                &format!(r#"{{"agree":[{}]}}"#, many.join(",")),
                "{}"
            )),
            Err(Handback::Oversize)
        );
    }

    #[test]
    fn kept_rows_last_thirty_seconds_and_no_longer() {
        let state = State::default();
        let key = (7, 30, 5);
        let rows = Arc::new(vec![row(900, 1, none())]);
        state.keep_rows(key, 1_000.0, rows.clone());
        assert!(state.kept_rows(key, 1_000.0 + ROWS_KEPT_MS).is_some());
        assert!(state.kept_rows((7, 29, 5), 1_000.0).is_none());
        assert!(state.kept_rows((7, 30, 4), 1_000.0).is_none());
        assert!(state.kept_rows((8, 30, 5), 1_000.0).is_none());
        assert!(state.kept_rows(key, 1_001.0 + ROWS_KEPT_MS).is_none());
        // Dropped, not only passed over.
        assert!(state.kept_rows(key, 1_000.0).is_none());
    }

    #[test]
    fn kept_letters_answer_the_tick_they_were_read_at_and_older_ones() {
        let state = State::default();
        let read: BTreeMap<i32, Arc<str>> = [(1, Arc::from("ap")), (2, Arc::from("uu"))]
            .into_iter()
            .collect();
        state.keep_letters(7, 5, &read);
        let kept = |tick| state.kept_letters(7, &[1, 2, 3], tick);
        assert_eq!(
            kept(5),
            [Some(Arc::from("ap")), Some(Arc::from("uu")), None]
        );
        assert_eq!(kept(3)[0], Some(Arc::from("ap")));
        assert_eq!(kept(contract::LATEST_TICK)[1], Some(Arc::from("uu")));
        assert_eq!(kept(6), [None, None, None]);
        // Another conversation's participant with the same number is another key.
        assert_eq!(state.kept_letters(8, &[1], 5), [None]);
        // A later read replaces what was kept, tick and letters.
        state.keep_letters(7, 9, &[(1, Arc::from("apd"))].into_iter().collect());
        assert_eq!(kept(6)[0], Some(Arc::from("apd")));
        assert_eq!(kept(6)[1], None);
    }

    #[test]
    fn both_caches_are_bounded_by_count_and_by_bytes() {
        let mut kept: Kept<(i32, i32), &str> = Kept::new(2, 10);
        kept.set((1, 1), "aaaa", 4);
        kept.set((1, 2), "dddd", 4);
        assert_eq!(kept.bytes, 8);
        // Reading the first makes the second the least recent.
        assert!(kept.get((1, 1)).is_some());
        kept.set((1, 3), "pp", 2);
        assert!(kept.get((1, 2)).is_none());
        assert_eq!((kept.entries.len(), kept.bytes), (2, 6));
        // Over the byte bound the least recent leave until it fits.
        kept.set((1, 4), "uuuuuuuu", 8);
        assert!(kept.get((1, 1)).is_none());
        assert_eq!((kept.entries.len(), kept.bytes), (2, 10));
        // Replacing an entry counts its new size once.
        kept.set((1, 4), "u", 1);
        assert_eq!((kept.entries.len(), kept.bytes), (2, 3));
        kept.remove((1, 3));
        kept.remove((1, 3));
        assert_eq!(
            (kept.entries.len(), kept.bytes, kept.order.len()),
            (1, 1, 1)
        );
        // An entry larger than the whole bound is not kept at all.
        kept.set((1, 5), "far too large", 13);
        assert_eq!((kept.entries.len(), kept.bytes), (0, 0));

        // The rows of an answer count the text of their external ids; the
        // letters count their length.
        let long = |pid| {
            row(
                100,
                pid,
                external(&"p".repeat(3000), Some(&"n".repeat(700))),
            )
        };
        let state = State::with_bytes(10_000, 6);
        state.keep_rows((1, 30, 0), 0.0, Arc::new(vec![long(1), long(2)]));
        assert!(state.kept_rows((1, 30, 0), 1.0).is_some());
        state.keep_rows((2, 30, 0), 0.0, Arc::new(vec![long(1)]));
        assert!(state.kept_rows((1, 30, 0), 1.0).is_none());
        assert!(state.kept_rows((2, 30, 0), 1.0).is_some());
        state.keep_letters(
            1,
            0,
            &[(1, Arc::from("apd")), (2, Arc::from("dpa"))]
                .into_iter()
                .collect(),
        );
        state.keep_letters(1, 0, &[(3, Arc::from("u"))].into_iter().collect());
        assert_eq!(
            state.kept_letters(1, &[1, 2, 3], 0),
            [None, Some(Arc::from("dpa")), Some(Arc::from("u"))]
        );
    }

    #[test]
    fn the_pools_and_the_deadline_are_the_ones_the_note_states() {
        // Two connections for the data, one for identity; a request waits
        // 15 ms for either. The deadline is under the 250 ms the nginx
        // location waits and over the longest single statement.
        let data = pool_limits();
        assert_eq!(data.size, 2);
        assert_eq!(data.acquire_timeout, Duration::from_millis(15));
        assert_eq!(data.statement_timeout, Duration::from_millis(100));
        let identity = auth_pool_limits();
        assert_eq!(identity.size, 1);
        assert_eq!(identity.acquire_timeout, Duration::from_millis(15));
        assert_eq!(identity.statement_timeout, Duration::from_millis(50));
        assert_eq!(DEADLINE, Duration::from_millis(150));
        assert!(DEADLINE > data.statement_timeout && DEADLINE > identity.statement_timeout);
    }

    #[test]
    fn every_reason_has_its_own_name() {
        let names: BTreeSet<&str> = Handback::ALL.iter().map(|r| r.as_str()).collect();
        assert_eq!(names.len(), Handback::ALL.len());
        assert!(
            names
                .iter()
                .all(|n| n.bytes().all(|b| b.is_ascii_lowercase() || b == b'_'))
        );
    }

    #[test]
    fn the_statements_are_nodes_with_and_without_featured_authors() {
        let without = participant_rows_sql(&[]);
        assert!(!without.contains("authors"));
        assert!(without.contains("from ( select * from xid_ptpts ) as prioritized_ptpts"));
        let with = participant_rows_sql(&[4, 200001]);
        assert!(with.contains(
            "authors as (select 4 as uid, 900 as priority union select 200001 as uid, 900 as priority), "
        ));
        assert!(with.contains(
            "from ( select * from authors union select * from xid_ptpts ) as prioritized_ptpts"
        ));
        for sql in [without, with] {
            // The requester is not in the kept statement: three parameters,
            // the conversation, the limit and the moderation floor.
            assert!(!sql.contains("self") && !sql.contains("1000"));
            assert!(!sql.contains("$4"));
            assert!(sql.contains("where p.mod >= ($3)"));
            assert!(sql.contains("limit ($2)"));
            assert!(sql.ends_with(&format!("limit {}", ROWS + 1)));
        }
        // The requester's own row is one account's, read by itself.
        let own = own_row_sql();
        assert!(own.contains("where zid = ($1) and uid = ($2) and EXISTS (SELECT 1 FROM votes v"));
        assert!(own.contains("from xids where uid = ($2) and owner in (select org_id from conversations where zid = ($1)) and x_profile_image_url is not null"));
        assert!(own.ends_with("limit 2"));
    }
}

#[cfg(all(test, feature = "db-tests"))]
#[path = "votes_famous_tests.rs"]
mod tests_db;
