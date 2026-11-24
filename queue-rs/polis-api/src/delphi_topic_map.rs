//! `GET /api/v3/delphi/topicMap?report_id=<id>[&job_id=<id>][&source=served|shadow][&selection=<rule>]`:
//! a report's topic map (`polis-topic-map/1`, [`contract`]), read as the run
//! stored it. A run that makes a map stores the document, its gzip and its
//! SHA-256 as the parts of one result family ([`contract::FAMILY`]); this
//! route finds the run, reads the one part the client needs and sends its
//! bytes as they are, with the stored SHA-256 as the ETag. It never builds,
//! hashes, compresses or parses a map: the work is the run's, done once on
//! the Delphi box. No comment text.
//!
//! Which run: without `job_id`, the run the conversation's results are served
//! from, in the publication scope of the comment rule asked for
//! ([`contract::Selection::scope`]; what participants are shown when none is
//! named), in the served env or, for `source=shadow`, the shadow's. The scope
//! is always named, so two rules' runs are never read as one. A map is one
//! run's: its parts are read from one stored family of one batch, never
//! put together from two, and it is read from the run's own batch only (a
//! read that walks a publication's earlier batches can meet an earlier run's
//! map), each row naming the run's job. The run read, its scope and its
//! comment rule are in the answer's headers.
//!
//! Who: the served map under the participants' rule is as public as the
//! report's other Delphi reads (the report id reads it). A named run and any
//! other rule: the conversation's moderators and the site administrators. The
//! shadow: the site administrators ([`App::legacy_admin_uids`]).
//!
//! The participation path (votes, comments, the next comment) shares nothing
//! with this route. Before anything is read a request takes one of
//! [`MAX_IN_FLIGHT`] places; with none free it is answered 503 at once. It
//! reads on its own pool ([`pool_limits`]) and identities on its own
//! ([`auth_pool_limits`]), never a participation pool, holds a connection
//! only for its own statements, and keeps nothing between requests. The
//! stored part crosses the connection only when it is within
//! [`MAX_PART_BYTES`], checked in the statement, so the bytes a request can
//! hold are bounded before they are allocated; the place is held until those
//! bytes are handed to the response, even when the request has given up. A
//! full pool, a slow database or the [`DEADLINE`] answer 503, the route's own
//! shedding, never an answer about the conversation.
use crate::{
    delphi_run::JobId,
    http::{Outgoing, Request},
    route::{self, App, Res},
};
use std::sync::{
    Arc,
    atomic::{AtomicU64, AtomicUsize, Ordering},
};
use std::time::Duration;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
// Both workspaces compile the same shared contract module.
#[allow(dead_code)]
#[path = "../../polis-contracts/src/delphi_topic_map.rs"]
pub(crate) mod contract;
pub use contract::PATH;
use contract::{NoMap, NoMapReason, Refused, Selection, Source, StoredNoMap};

/// Map requests reading at once in the process; any other is answered 503.
pub const MAX_IN_FLIGHT: usize = 4;
/// Bytes of the whole stored family the statement splits into its parts.
pub const MAX_FAMILY_BYTES: i64 = 4 * 1024 * 1024;
/// Bytes of one stored part as stored (its line in the family); the bytes
/// sent are never more. The step stores every row within this limit, and
/// `no_map` `too_large` above it.
pub const MAX_PART_BYTES: i64 = contract::ROW_LIMIT as i64;
/// The whole request, from its place to the bytes it sends.
pub const DEADLINE: Duration = Duration::from_millis(3000);
/// The publication scope the served runs use when the deployment names none
/// (`DELPHI_RESULT_SCOPE`), and the shadow's own.
pub const DEFAULT_SCOPE: &str = "delphi";
/// A shadow env's prefix: a served env never reads as the shadow.
pub const SHADOW_PREFIX: &str = "shadow-";
/// Whether a stored run named by `job_id` is as public as the served map:
/// yes (ruled; a past run's map may later be removed to save storage, and
/// then answers `not_stored`). Only for a run made under the participants'
/// rule; a run of another rule stays its moderators', and the shadow its site
/// administrators'. `false` makes named runs moderators-only again.
pub const PUBLIC_RUN_HISTORY: bool = true;
/// Stored families whose verdict a process keeps.
const VERDICTS: usize = 4096;

/// Two slots, one statement each: the run record walks the job's publication
/// history, so the statement timeout is the typed result read's.
pub fn pool_limits() -> crate::db::Limits {
    crate::db::Limits {
        size: 2,
        acquire_timeout: Duration::from_millis(50),
        statement_timeout: Duration::from_millis(2000),
        max_lifetime: Duration::from_secs(300),
    }
}

/// Identity and the moderator rule: indexed single-row reads.
pub fn auth_pool_limits() -> crate::db::Limits {
    crate::db::Limits {
        size: 1,
        acquire_timeout: Duration::from_millis(50),
        statement_timeout: Duration::from_millis(100),
        max_lifetime: Duration::from_secs(300),
    }
}

struct Inner {
    places: Arc<Semaphore>,
    in_flight: AtomicUsize,
    max_in_flight: AtomicUsize,
    busy: AtomicU64,
    sent: AtomicU64,
    not_modified: AtomicU64,
    /// Stored bytes requests hold now, and at most since start.
    held: AtomicUsize,
    max_held: AtomicUsize,
    /// Stored families checked against their digest in this process: one
    /// at a time, and each family's verdict kept (a stored family never
    /// changes; only the verdict is kept, never the bytes).
    checking: Arc<Semaphore>,
    checked: AtomicU64,
    verdicts: std::sync::Mutex<std::collections::VecDeque<(String, bool)>>,
    /// A test sets this to hold every read inside its connection.
    #[cfg(all(test, feature = "db-tests"))]
    reads_held: (std::sync::Mutex<bool>, std::sync::Condvar),
}

/// The route's places and counters. Nothing else takes them.
#[derive(Clone)]
pub struct State(Arc<Inner>);

impl Default for State {
    fn default() -> Self {
        Self::new(MAX_IN_FLIGHT)
    }
}

/// One request's place. Shared with its database work, so a request that
/// gives up does not free the place while its read still runs.
#[derive(Clone)]
struct Place(#[allow(dead_code)] Arc<Taken>);
struct Taken {
    inner: Arc<Inner>,
    _permit: OwnedSemaphorePermit,
}
impl Drop for Taken {
    fn drop(&mut self) {
        self.inner.in_flight.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Stored bytes one request holds, counted until they are dropped or handed
/// to the response.
struct Held {
    inner: Arc<Inner>,
    bytes: usize,
}
impl Drop for Held {
    fn drop(&mut self) {
        self.inner.held.fetch_sub(self.bytes, Ordering::SeqCst);
    }
}

impl State {
    pub(crate) fn new(places: usize) -> Self {
        Self(Arc::new(Inner {
            places: Arc::new(Semaphore::new(places)),
            in_flight: AtomicUsize::new(0),
            max_in_flight: AtomicUsize::new(0),
            busy: AtomicU64::new(0),
            sent: AtomicU64::new(0),
            not_modified: AtomicU64::new(0),
            held: AtomicUsize::new(0),
            max_held: AtomicUsize::new(0),
            checking: Arc::new(Semaphore::new(1)),
            checked: AtomicU64::new(0),
            verdicts: std::sync::Mutex::new(std::collections::VecDeque::new()),
            #[cfg(all(test, feature = "db-tests"))]
            reads_held: (std::sync::Mutex::new(false), std::sync::Condvar::new()),
        }))
    }
    /// A place, or none: never a wait.
    fn admit(&self) -> Option<Place> {
        let Ok(permit) = self.0.places.clone().try_acquire_owned() else {
            self.0.busy.fetch_add(1, Ordering::Relaxed);
            return None;
        };
        let now = self.0.in_flight.fetch_add(1, Ordering::SeqCst) + 1;
        self.0.max_in_flight.fetch_max(now, Ordering::SeqCst);
        Some(Place(Arc::new(Taken {
            inner: self.0.clone(),
            _permit: permit,
        })))
    }
    fn hold(&self, bytes: usize) -> Held {
        let now = self.0.held.fetch_add(bytes, Ordering::SeqCst) + bytes;
        self.0.max_held.fetch_max(now, Ordering::SeqCst);
        Held {
            inner: self.0.clone(),
            bytes,
        }
    }
    /// This process's verdict on the stored family `key`, if it has one.
    fn verdict(&self, key: &str) -> Option<bool> {
        let verdicts = self.0.verdicts.lock().ok()?;
        verdicts
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, good)| *good)
    }
    fn remember(&self, key: String, good: bool) {
        if let Ok(mut verdicts) = self.0.verdicts.lock() {
            verdicts.retain(|(k, _)| *k != key);
            verdicts.push_back((key, good));
            while verdicts.len() > VERDICTS {
                verdicts.pop_front();
            }
        }
    }
    /// Stored families checked since start.
    pub(crate) fn checked(&self) -> u64 {
        self.0.checked.load(Ordering::Relaxed)
    }
    /// Stored bytes held now.
    #[cfg(all(test, feature = "db-tests"))]
    pub(crate) fn held_now(&self) -> usize {
        self.0.held.load(Ordering::SeqCst)
    }
    /// Requests holding a place at most at once, since start.
    pub(crate) fn max_in_flight(&self) -> usize {
        self.0.max_in_flight.load(Ordering::SeqCst)
    }
    /// Stored bytes held at most at once, since start.
    pub(crate) fn max_held(&self) -> usize {
        self.0.max_held.load(Ordering::SeqCst)
    }
    /// Requests answered 503 for want of a place, since start.
    pub(crate) fn busy(&self) -> u64 {
        self.0.busy.load(Ordering::Relaxed)
    }
    /// For `/health`: places in use now and at most, requests shed, maps sent
    /// and answered 304, and stored bytes held now and at most.
    pub(crate) fn health(&self) -> crate::js::Js {
        let mut body = crate::js::Obj::new();
        let num = |n: f64| crate::js::Js::Num(n);
        body.set(
            "inFlight",
            num(self.0.in_flight.load(Ordering::SeqCst) as f64),
        );
        body.set("maxInFlight", num(self.max_in_flight() as f64));
        body.set("busy", num(self.busy() as f64));
        body.set("sent", num(self.0.sent.load(Ordering::Relaxed) as f64));
        body.set(
            "notModified",
            num(self.0.not_modified.load(Ordering::Relaxed) as f64),
        );
        body.set("heldBytes", num(self.0.held.load(Ordering::SeqCst) as f64));
        body.set("maxHeldBytes", num(self.max_held() as f64));
        body.set("checked", num(self.checked() as f64));
        crate::js::Js::Obj(body)
    }
    /// Requests holding a place now.
    #[cfg(all(test, feature = "db-tests"))]
    pub(crate) fn in_flight(&self) -> usize {
        self.0.in_flight.load(Ordering::SeqCst)
    }
    /// Hold every read inside its connection, as a database that has
    /// stopped answering would, until [`State::open_reads`].
    #[cfg(all(test, feature = "db-tests"))]
    pub(crate) fn close_reads(&self) {
        *self
            .0
            .reads_held
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = true;
    }
    #[cfg(all(test, feature = "db-tests"))]
    pub(crate) fn open_reads(&self) {
        *self
            .0
            .reads_held
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = false;
        self.0.reads_held.1.notify_all();
    }
    #[cfg(all(test, feature = "db-tests"))]
    fn wait_while_reads_held(&self) {
        let (closed, open) = &self.0.reads_held;
        let held = closed.lock().unwrap_or_else(|e| e.into_inner());
        let _ = open.wait_timeout_while(held, Duration::from_secs(30), |closed| *closed);
    }
}

/// The request after the method, body and query checks.
pub struct Parsed {
    request: contract::Request,
    /// A `source` or `selection` value this route does not know: 400.
    bad: Option<&'static str>,
    authorization: Option<String>,
}

pub fn parse(app: &App, req: &Request) -> Option<Parsed> {
    if app.delphi_topic_map_db.is_none()
        || req.path() != PATH
        || !matches!(req.method.as_str(), "GET" | "HEAD")
        || !req.body.is_empty()
        || req.headers.get("transfer-encoding").is_some()
        || req.headers.get("content-length").is_some_and(|s| s != "0")
    {
        return None;
    }
    let raw = req.query().unwrap_or("");
    if raw.len() > 1024 {
        return None;
    }
    // The visualizations read's admission: each key once, values of at most
    // 100 letters, digits, `_` and `-`; anything else is not this route's.
    let mut request = contract::Request::default();
    let mut bad = None;
    let mut seen = std::collections::BTreeSet::new();
    for (k, v) in url::form_urlencoded::parse(raw.as_bytes()) {
        if !matches!(k.as_ref(), "report_id" | "job_id" | "source" | "selection")
            || !seen.insert(k.clone())
            || v.len() > 100
            || !v
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        {
            return None;
        }
        if v.is_empty() {
            continue;
        }
        match k.as_ref() {
            "report_id" => request.report_id = Some(v.into_owned()),
            "job_id" => request.job_id = Some(v.into_owned()),
            "source" => match Source::parse(&v) {
                Some(source) => request.source = source,
                None => bad = bad.or(Some("source")),
            },
            _ => match Selection::parse(&v) {
                Some(selection) => request.selection = Some(selection),
                None => bad = bad.or(Some("selection")),
            },
        }
    }
    Some(Parsed {
        request,
        bad,
        authorization: req.headers.get("authorization").map(str::to_owned),
    })
}

/// A stored map, ready to send.
struct Map {
    job: String,
    source: Source,
    /// The publication scope the run was read from: the one asked for, or
    /// for a named run the one its map was published in, if any.
    scope: Option<String>,
    /// The run's comment rule as its configuration names it.
    selection: Option<String>,
    etag: String,
    gzip: bool,
    /// `None`: the client's ETag is the stored one (304).
    body: Option<(Vec<u8>, Held)>,
    privileged: bool,
}

enum Answer {
    Refused(Refused),
    NoMap(NoMap),
    Map(Box<Map>),
}

pub async fn handle(app: &App, req: &Request, res: Res) -> Outgoing {
    let Some(parsed) = parse(app, req) else {
        return route::bad_gateway();
    };
    let state = &app.delphi_topic_map;
    // The route sheds itself before it reads anything.
    let Some(place) = state.admit() else {
        return refuse(req, res, Refused::Busy);
    };
    let gzip = route::negotiate_gzip(req);
    let tags = client_tags(req);
    match tokio::time::timeout(DEADLINE, answer(app, parsed, place.clone(), gzip, tags)).await {
        Err(_) => {
            state.0.busy.fetch_add(1, Ordering::Relaxed);
            refuse(req, res, Refused::Busy)
        }
        Ok(None) => route::bad_gateway(),
        Ok(Some(Answer::Refused(refused))) => refuse(req, res, refused),
        Ok(Some(Answer::NoMap(body))) => json(req, res, 200, &body, false),
        Ok(Some(Answer::Map(map))) => send(state, req, res, *map, place),
    }
}

/// The stored bytes, as they are. The request's place and the count of its
/// bytes go with the response: they are let go when it has been written or
/// its connection has dropped, so the places bound the bytes still on their
/// way to clients, not only those being read.
fn send(state: &State, req: &Request, mut res: Res, map: Map, place: Place) -> Outgoing {
    res.set(contract::HEADER_JOB, map.job);
    res.set(contract::HEADER_SOURCE, map.source.word());
    if let Some(scope) = map.scope {
        res.set(contract::HEADER_SCOPE, scope);
    }
    if let Some(selection) = map.selection {
        res.set(contract::HEADER_SELECTION, selection);
    }
    if map.privileged {
        res.set("Cache-Control", "private, no-store");
    }
    match map.body {
        None => {
            state.0.not_modified.fetch_add(1, Ordering::Relaxed);
            route::stored_json(req, res, None, map.gzip, &map.etag, map.privileged)
        }
        Some((bytes, held)) => {
            state.0.sent.fetch_add(1, Ordering::Relaxed);
            crate::http::hold_until_written((place, held));
            route::stored_json(req, res, Some(bytes), map.gzip, &map.etag, map.privileged)
        }
    }
}

fn refuse(req: &Request, mut res: Res, refused: Refused) -> Outgoing {
    if refused == Refused::Busy {
        res.set("Retry-After", contract::RETRY_AFTER);
    }
    json(req, res, refused.status(), &refused.body(), true)
}

/// A small JSON answer (a refusal or a run without a map).
fn json<T: serde::Serialize>(
    req: &Request,
    mut res: Res,
    status: u16,
    value: &T,
    refusal: bool,
) -> Outgoing {
    if refusal {
        res.set("Cache-Control", "no-store");
    }
    match crate::wire::to_json(value) {
        Ok(body) => route::json_text(req, res, status, body),
        Err(_) => route::bad_gateway(),
    }
}

/// The entity tags of `If-None-Match` as the stored digests they name (`*`
/// stays `*`), at most eight.
fn client_tags(req: &Request) -> Vec<String> {
    let Some(raw) = req.headers.get("if-none-match") else {
        return Vec::new();
    };
    raw.split(',')
        .map(str::trim)
        .filter_map(|t| {
            if t == "*" {
                return Some(t.to_owned());
            }
            let t = t.strip_prefix("W/").unwrap_or(t);
            let hex = t.strip_prefix('"')?.strip_suffix('"')?;
            is_digest(hex).then(|| hex.to_owned())
        })
        .take(8)
        .collect()
}

fn is_digest(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Who a request must be.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Need {
    Anyone,
    Moderator,
    SiteAdministrator,
}

/// Who a request must be, from its query alone. A named run is as public as
/// the current map ([`PUBLIC_RUN_HISTORY`]) only when it was made under the
/// participants' rule, which is known once its job is read ([`answer`]).
fn need(q: &contract::Request) -> Need {
    if q.source == Source::Shadow {
        Need::SiteAdministrator
    } else if q
        .selection
        .is_some_and(|s| s != Selection::ParticipantVisible)
        || (q.job_id.is_some() && !PUBLIC_RUN_HISTORY)
    {
        Need::Moderator
    } else {
        Need::Anyone
    }
}

/// What a failed database exchange answers. Stored rows the database itself
/// cannot read as declared (a value that is not base64, a line that is not
/// JSON) and a statement this login may not run are this run's map being
/// unreadable; everything else (a statement or lock timeout, a busy or lost
/// connection, a server shutting down) is the route shedding its load.
fn failure(e: &anyhow::Error) -> Refused {
    let code = e
        .chain()
        .find_map(|c| c.downcast_ref::<postgres::Error>())
        .and_then(|e| e.as_db_error())
        .map(|db| db.code().code().to_owned());
    match code {
        Some(code) if code.starts_with("22") || code.starts_with("42") => Refused::Unreadable,
        _ => Refused::Busy,
    }
}

/// `None` hands the request back to Node, whose answer for this path is 404:
/// only when the route is switched off.
async fn answer(
    app: &App,
    parsed: Parsed,
    place: Place,
    gzip: bool,
    tags: Vec<String>,
) -> Option<Answer> {
    let refused = |r| Some(Answer::Refused(r));
    if let Some(key) = parsed.bad {
        return refused(Refused::BadParameter(key));
    }
    let q = parsed.request;
    let Some(report) = q.report_id.clone() else {
        return refused(Refused::MissingReport);
    };
    // A stored run has its own comment rule.
    if q.job_id.is_some() && q.selection.is_some() {
        return refused(Refused::BadParameter("selection"));
    }
    let (env, base) = match q.source {
        Source::Served => (
            app.delphi_topic_map_env.clone(),
            app.delphi_topic_map_scope
                .clone()
                .unwrap_or_else(|| DEFAULT_SCOPE.to_owned()),
        ),
        Source::Shadow => match &app.delphi_topic_map_shadow_env {
            Some(env) => (env.clone(), DEFAULT_SCOPE.to_owned()),
            None => return refused(Refused::SourceUnavailable),
        },
    };
    let scope = q.selection.unwrap_or_default().scope(&base);
    let pool = app.delphi_topic_map_db.as_ref()?;
    let rid = report.clone();
    let first = place.clone();
    let zid = match pool
        .with(move |c| {
            let _place = first;
            // As getZidFromReport: no row, a null and a zero name no conversation.
            Ok(c.query_opt(
                "SELECT zid FROM reports WHERE report_id=$1 LIMIT 1",
                &[&rid],
            )?
            .map(|r| r.try_get::<_, Option<i32>>(0))
            .transpose()?
            .flatten()
            .filter(|z| *z != 0))
        })
        .await
    {
        Ok(Some(zid)) => zid,
        Ok(None) => return refused(Refused::UnknownReport(report)),
        Err(e) => return refused(failure(&e)),
    };
    let mut need = need(&q);
    if need != Need::Anyone
        && let Err(r) = authorize(app, parsed.authorization.as_deref(), zid, need).await?
    {
        return refused(r);
    }
    let job = match q.job_id {
        // Job ids are lowercase canonical uuids; any other spelling names no run.
        Some(job) => match JobId::new(job) {
            Ok(job) => Some(job.as_str().to_owned()),
            Err(_) => return refused(Refused::JobNotFound),
        },
        None => None,
    };
    let named_run = job.is_some();
    let ask = Ask {
        env,
        scope: scope.clone(),
        zid,
        job,
        gzip,
        tags,
    };
    let state = app.delphi_topic_map.clone();
    let reading = place.clone();
    let read = pool
        .with(move |c| {
            let _place = reading;
            read(c, ask, &state)
        })
        .await;
    let Read { found, selection } = match read {
        Ok(read) => read,
        Err(e) => return refused(failure(&e)),
    };
    // A named run made under another comment rule is that rule's: its
    // moderators' and the site administrators', whoever may read past runs.
    if named_run
        && need == Need::Anyone
        && !matches!(found, Found::NoSuchRun)
        && selection.as_deref() != Some(PARTICIPANT_VISIBLE)
    {
        need = Need::Moderator;
        if let Err(r) = authorize(app, parsed.authorization.as_deref(), zid, need).await? {
            return refused(r);
        }
    }
    let found = match found {
        Found::Unverified(u) => match verify(&app.delphi_topic_map, *u, place.clone()).await {
            Ok(found) => found,
            Err(r) => return refused(r),
        },
        found => found,
    };
    Some(match found {
        Found::Unreadable => Answer::Refused(Refused::Unreadable),
        Found::NoSuchRun => Answer::Refused(Refused::JobNotFound),
        Found::TooLarge => Answer::Refused(Refused::TooLarge),
        // A served run came from the scope read; a named run from none.
        Found::NoMap { job, reason } => Answer::NoMap(NoMap::new(
            report,
            job,
            q.source,
            (!named_run).then(|| scope.clone()),
            reason,
        )),
        Found::Unverified(_) => Answer::Refused(Refused::Unreadable),
        Found::Map {
            job,
            scope,
            sha,
            body,
        } => Answer::Map(Box::new(Map {
            job,
            source: q.source,
            scope,
            selection,
            etag: format!("W/\"{sha}\""),
            gzip,
            body,
            privileged: need != Need::Anyone,
        })),
    })
}

/// The comment rule what participants are shown, as a run's configuration
/// names it.
const PARTICIPANT_VISIBLE: &str = "participant_visible/1";

/// `Err` is the refusal; `None` hands back.
async fn authorize(
    app: &App,
    authorization: Option<&str>,
    zid: i32,
    need: Need,
) -> Option<Result<(), Refused>> {
    let Some(raw) = authorization.filter(|h| h.starts_with("Bearer ")) else {
        return Some(Err(Refused::Unauthenticated));
    };
    let auth_pool = app.delphi_topic_map_auth_db.as_ref()?;
    let uid = match crate::hybrid_read::resolve_or_unavailable(
        Some(raw),
        app.participant_verifier.as_deref(),
        app.read_oidc.as_deref(),
        auth_pool,
    )
    .await
    {
        // The identity database did not answer: shed, never "not signed in".
        Err(_) => return Some(Err(Refused::Busy)),
        Ok(identity) => identity.and_then(|identity| identity.uid()),
    };
    let Some(uid) = uid else {
        return Some(Err(Refused::Unauthenticated));
    };
    let admins = app.legacy_admin_uids.clone();
    if admins.contains(&uid.0) {
        return Some(Ok(()));
    }
    if need == Need::SiteAdministrator {
        return Some(Err(Refused::Denied));
    }
    match auth_pool
        .with(move |c| crate::treevite_read::permits(c, zid, uid, &admins))
        .await
    {
        Ok(true) => Some(Ok(())),
        Ok(false) => Some(Err(Refused::Denied)),
        Err(e) => Some(Err(match failure(&e) {
            Refused::Unreadable => Refused::Unreadable,
            _ => Refused::Busy,
        })),
    }
}

/// What one request reads.
struct Ask {
    env: String,
    scope: String,
    zid: i32,
    /// A run named by its job id; `None` is the served run of `scope`.
    job: Option<String>,
    gzip: bool,
    tags: Vec<String>,
}

struct Read {
    found: Found,
    /// The run's comment rule as its configuration names it.
    selection: Option<String>,
}

enum Found {
    NoSuchRun,
    NoMap {
        job: Option<String>,
        reason: NoMapReason,
    },
    TooLarge,
    /// The stored rows are not a map this route can serve: a part missing,
    /// a row naming another job, a digest that is not the document's.
    Unreadable,
    /// A stored family not yet checked in this process: its document and
    /// gzip, to be checked against the stored digest before anything is sent.
    Unverified(Box<Unverified>),
    Map {
        job: String,
        scope: Option<String>,
        sha: String,
        body: Option<(Vec<u8>, Held)>,
    },
}

struct Unverified {
    key: String,
    job: String,
    scope: Option<String>,
    sha: String,
    document: Vec<u8>,
    gzip: Vec<u8>,
    held: Held,
    /// Which of the two the client gets, and whether it already holds it.
    send_gzip: bool,
    matched: bool,
}

/// The run, then its map's part, on one connection: indexed reads and the
/// result store's own functions, nothing computed here.
fn read(c: &mut postgres::Client, ask: Ask, state: &State) -> anyhow::Result<Read> {
    let (job, selection, mut artifact) = match &ask.job {
        None => {
            let rows = c.query(
                "SELECT p.job_id, p.artifact_id::text, j.job_config->>'selection' \
                 FROM public.delphi_result_publications p \
                 LEFT JOIN public.delphi_result_jobs j ON j.env=p.env AND j.job_id=p.job_id \
                 WHERE p.env=$1 AND p.zid=$2 AND p.scope_key=$3 LIMIT 2",
                &[&ask.env, &ask.zid, &ask.scope],
            )?;
            match rows.as_slice() {
                [] => {
                    return Ok(Read {
                        found: Found::NoMap {
                            job: None,
                            reason: NoMapReason::NoRun,
                        },
                        selection: None,
                    });
                }
                // One served pointer per env, conversation and scope.
                [row] => (
                    row.try_get::<_, String>(0)?,
                    row.try_get::<_, Option<String>>(2)?,
                    row.try_get::<_, Option<String>>(1)?,
                ),
                _ => {
                    return Ok(Read {
                        found: Found::Unreadable,
                        selection: None,
                    });
                }
            }
        }
        Some(job) => {
            let Some(row) = c.query_opt(
                "SELECT conversation_id, status, job_config->>'selection' \
                 FROM public.delphi_result_jobs WHERE env=$1 AND job_id=$2 LIMIT 1",
                &[&ask.env, job],
            )?
            else {
                return Ok(Read {
                    found: Found::NoSuchRun,
                    selection: None,
                });
            };
            // Another conversation's run is no run of this report's.
            if row.try_get::<_, Option<String>>(0)? != Some(ask.zid.to_string()) {
                return Ok(Read {
                    found: Found::NoSuchRun,
                    selection: None,
                });
            }
            let selection = row.try_get::<_, Option<String>>(2)?;
            if row.try_get::<_, Option<String>>(1)?.as_deref() != Some("COMPLETED") {
                return Ok(Read {
                    found: Found::NoMap {
                        job: Some(job.clone()),
                        reason: NoMapReason::RunNotReady,
                    },
                    selection,
                });
            }
            (job.clone(), selection, None)
        }
    };
    let mut scope = ask.job.is_none().then(|| ask.scope.clone());
    if ask.job.is_some() {
        // The named run's own result artifact, from its record. Only a family
        // the run itself produced counts: the record also lists families an
        // earlier run of the publication produced, an earlier map among them.
        let row = c.query_opt(
            "SELECT f->>'artifact_id', f->>'scope' \
             FROM (SELECT public.pd_run_record($1::text,($2::text)::uuid) AS r) s, \
             LATERAL jsonb_array_elements(COALESCE(s.r->'families','[]'::jsonb)) f \
             WHERE f->>'job_id'=$2 ORDER BY (f->>'family'=$3) DESC LIMIT 1",
            &[&ask.env, &job, &contract::FAMILY],
        )?;
        if let Some(row) = row {
            artifact = row.try_get::<_, Option<String>>(0)?;
            scope = row.try_get::<_, Option<String>>(1)?;
        }
    }
    // The map is read from the run's own batch only, never followed to an
    // earlier one, and every row read must name the run's job.
    let part = match artifact.as_deref() {
        Some(a) => read_part(c, &ask, a, &job, state)?,
        None => None,
    };
    #[cfg(all(test, feature = "db-tests"))]
    state.wait_while_reads_held();
    let found = match part {
        // Not stored, or no longer stored: the same answer.
        None => Found::NoMap {
            job: Some(job),
            reason: NoMapReason::NotStored,
        },
        Some(Part::TooLarge) | Some(Part::NoMap(StoredNoMap::TooLarge)) => Found::TooLarge,
        Some(Part::Unreadable) => Found::Unreadable,
        Some(Part::NoMap(reason)) => Found::NoMap {
            job: Some(job),
            reason: match reason {
                StoredNoMap::NoPositions => NoMapReason::NoPositions,
                StoredNoMap::NoTopics => NoMapReason::NoTopics,
                _ => NoMapReason::TooFewComments,
            },
        },
        Some(Part::Unverified {
            key,
            sha,
            document,
            gzip,
            matched,
        }) => {
            let held = state.hold(document.len() + gzip.len());
            Found::Unverified(Box::new(Unverified {
                key,
                job,
                scope,
                sha,
                document,
                gzip,
                held,
                send_gzip: ask.gzip,
                matched,
            }))
        }
        Some(Part::Map { sha, body }) => Found::Map {
            job,
            scope,
            sha,
            body: body.map(|b| {
                let held = state.hold(b.len());
                (b, held)
            }),
        },
    };
    Ok(Read { found, selection })
}

enum Part {
    TooLarge,
    Unreadable,
    NoMap(StoredNoMap),
    Unverified {
        key: String,
        sha: String,
        document: Vec<u8>,
        gzip: Vec<u8>,
        matched: bool,
    },
    Map {
        sha: String,
        body: Option<Vec<u8>>,
    },
}

/// The part the client needs from the family stored at `artifact`, or `None`
/// when that artifact holds no such family. Each row of the stored family is
/// one canonical line (sorted keys, no spaces, every quote inside a value
/// escaped), so a part's line is found by its key, and its job by the exact
/// text `"job_id":{"S":"<job>"}`, without parsing the others. Whatever the
/// client holds, every row the answer rests on must name `job`: the digest's,
/// the chosen part's, and when the family has not been checked in this
/// process yet, the document's and the gzip's, whose bytes then both come
/// back to be checked against the digest ([`verify`]). Only then may a
/// matching ETag skip the body.
fn read_part(
    c: &mut postgres::Client,
    ask: &Ask,
    artifact: &str,
    job: &str,
    state: &State,
) -> anyhow::Result<Option<Part>> {
    let Ok(artifact) = uuid::Uuid::parse_str(artifact).map(|u| u.to_string()) else {
        return Ok(Some(Part::Unreadable));
    };
    let key = format!("{}\n{artifact}", ask.env);
    let checked = state.verdict(&key);
    if checked == Some(false) {
        return Ok(Some(Part::Unreadable));
    }
    let verifying = checked.is_none();
    let wanted = if ask.gzip {
        contract::PART_GZIP
    } else {
        contract::PART_DOCUMENT
    };
    let part = |part: &str| format!("\"part\":{{\"S\":\"{part}\"}}");
    let by = format!("\"job_id\":{{\"S\":\"{job}\"}}");
    let row = c.query_one(
        "WITH f AS (SELECT public.pd_result_artifact_wire($1::text,($2::text)::uuid,$3::text)->>'wire' AS wire), \
         l AS (SELECT line FROM f, unnest(string_to_array(f.wire, E'\\n')) AS line WHERE octet_length(f.wire) <= $4::bigint), \
         s AS (SELECT j->'body'->>'S' AS sha, strpos(line,$11)>0 AS ours FROM \
               (SELECT line, line::jsonb AS j FROM l WHERE strpos(line,$5)>0 AND octet_length(line) <= 512 LIMIT 1) x), \
         n AS (SELECT j->'reason'->>'S' AS reason, strpos(line,$11)>0 AS ours FROM \
               (SELECT line, line::jsonb AS j FROM l WHERE strpos(line,$6)>0 AND octet_length(line) <= 512 LIMIT 1) x), \
         d AS (SELECT octet_length(line) AS len, strpos(line,$11)>0 AS ours, line FROM l WHERE strpos(line,$7)>0 LIMIT 1), \
         b AS (SELECT line::jsonb AS j FROM d WHERE NOT $12::boolean AND d.len <= $8::bigint \
               AND NOT EXISTS(SELECT 1 FROM s WHERE s.sha = ANY($10::text[]) OR '*' = ANY($10::text[]))), \
         vd AS (SELECT (line::jsonb)->'body'->>'S' AS v, strpos(line,$11)>0 AS ours FROM l \
               WHERE $12::boolean AND strpos(line,$13)>0 AND octet_length(line) <= $8::bigint LIMIT 1), \
         vg AS (SELECT (line::jsonb)->'body'->>'B' AS v, strpos(line,$11)>0 AS ours FROM l \
               WHERE $12::boolean AND strpos(line,$14)>0 AND octet_length(line) <= $8::bigint LIMIT 1) \
         SELECT (SELECT wire IS NOT NULL FROM f), \
          (SELECT octet_length(wire) FROM f)::bigint, \
          (SELECT reason FROM n), (SELECT ours FROM n), \
          (SELECT sha FROM s), (SELECT ours FROM s), \
          (SELECT len FROM d)::bigint, (SELECT ours FROM d), \
          (SELECT CASE WHEN $9::boolean THEN decode(j->'body'->>'B','base64') \
                       ELSE convert_to(j->'body'->>'S','UTF8') END FROM b), \
          (SELECT convert_to(v,'UTF8') FROM vd), (SELECT ours FROM vd), \
          (SELECT decode(v,'base64') FROM vg), (SELECT ours FROM vg), \
          (SELECT max(octet_length(line)) FROM l WHERE $12::boolean AND (strpos(line,$13)>0 OR strpos(line,$14)>0))::bigint",
        &[
            &ask.env,
            &artifact,
            &contract::FAMILY,
            &MAX_FAMILY_BYTES,
            &part(contract::PART_SHA256),
            &part(contract::PART_NO_MAP),
            &part(wanted),
            &MAX_PART_BYTES,
            &ask.gzip,
            &ask.tags,
            &by,
            &verifying,
            &part(contract::PART_DOCUMENT),
            &part(contract::PART_GZIP),
        ],
    )?;
    if !row.try_get::<_, Option<bool>>(0)?.unwrap_or(false) {
        return Ok(None);
    }
    if row
        .try_get::<_, Option<i64>>(1)?
        .is_none_or(|n| n > MAX_FAMILY_BYTES)
    {
        return Ok(Some(Part::TooLarge));
    }
    let ours = |i: usize| -> anyhow::Result<bool> {
        Ok(row.try_get::<_, Option<bool>>(i)?.unwrap_or(false))
    };
    if let Some(reason) = row.try_get::<_, Option<String>>(2)? {
        if !ours(3)? {
            return Ok(Some(Part::Unreadable));
        }
        return Ok(Some(
            StoredNoMap::parse(&reason).map_or(Part::Unreadable, Part::NoMap),
        ));
    }
    let Some(sha) = row
        .try_get::<_, Option<String>>(4)?
        .filter(|s| is_digest(s))
    else {
        return Ok(Some(Part::Unreadable));
    };
    if !ours(5)? {
        return Ok(Some(Part::Unreadable));
    }
    let Some(length) = row.try_get::<_, Option<i64>>(6)? else {
        return Ok(Some(Part::Unreadable));
    };
    if length > MAX_PART_BYTES {
        return Ok(Some(Part::TooLarge));
    }
    if !ours(7)? {
        return Ok(Some(Part::Unreadable));
    }
    let matched = ask.tags.iter().any(|t| t == "*" || *t == sha);
    if verifying {
        // The family is checked whole before any part of it is sent: a part
        // longer than its bound refuses the map, whichever part was asked.
        if row
            .try_get::<_, Option<i64>>(13)?
            .is_some_and(|n| n > MAX_PART_BYTES)
        {
            return Ok(Some(Part::TooLarge));
        }
        let (Some(document), Some(gzip)) = (
            row.try_get::<_, Option<Vec<u8>>>(9)?,
            row.try_get::<_, Option<Vec<u8>>>(11)?,
        ) else {
            // A part too long for its bound was refused above; a part that
            // is missing is not a map.
            return Ok(Some(Part::Unreadable));
        };
        if !ours(10)? || !ours(12)? {
            return Ok(Some(Part::Unreadable));
        }
        return Ok(Some(Part::Unverified {
            key,
            sha,
            document,
            gzip,
            matched,
        }));
    }
    let body = row.try_get::<_, Option<Vec<u8>>>(8)?;
    Ok(Some(match (body, matched) {
        (Some(body), _) => Part::Map {
            sha,
            body: Some(body),
        },
        (None, true) => Part::Map { sha, body: None },
        // The part's line is there but holds no bytes of its kind.
        (None, false) => Part::Unreadable,
    }))
}

/// Check a stored family once in this process, off the runtime's threads and
/// after its connection has gone back: the document's SHA-256 must be the
/// stored digest and the gzip must inflate to exactly the document. The
/// verdict is kept (a stored family never changes); the bytes are not. Only
/// one family is checked at a time; another request meanwhile waits.
///
/// The blocking check owns the bytes it reads and, with them, the checker's
/// permit, their count and a clone of the request's place, and hands all of
/// them back with its result. A request that gives up while its check is
/// queued or running (the route's deadline drops this future) therefore
/// frees none of the three bounds until the detached check, and the bytes
/// it holds, are gone: the discipline of the database work (`db.rs`, the
/// permit moves into the blocking closure).
async fn verify(state: &State, u: Unverified, place: Place) -> Result<Found, Refused> {
    // One check at a time; a request for a family being checked waits for
    // that check (holding its place, so at most the places wait) and uses
    // its verdict.
    let Ok(checking) = state.0.checking.clone().acquire_owned().await else {
        return Err(Refused::Busy);
    };
    let Unverified {
        key,
        job,
        scope,
        mut sha,
        mut document,
        mut gzip,
        mut held,
        send_gzip,
        matched,
    } = u;
    let good = match state.verdict(&key) {
        Some(good) => {
            drop(checking);
            good
        }
        None => {
            let checked = tokio::task::spawn_blocking(move || {
                let good = stored_parts_agree(&document, &gzip, &sha);
                (good, document, gzip, sha, held, checking, place)
            })
            .await;
            // A check that panicked dropped its permit, count and place with its bytes.
            let Ok((good, d, g, h, kept, checking, _place)) = checked else {
                return Err(Refused::Busy);
            };
            (document, gzip, sha, held) = (d, g, h, kept);
            // The bytes stay counted (`held`, and the request's own place);
            // the next family may be checked.
            drop(checking);
            state.0.checked.fetch_add(1, Ordering::Relaxed);
            state.remember(key, good);
            good
        }
    };
    if !good {
        return Err(Refused::Unreadable);
    }
    let body = if matched {
        drop(held);
        None
    } else {
        let bytes = if send_gzip { gzip } else { document };
        drop(held);
        let held = state.hold(bytes.len());
        Some((bytes, held))
    };
    Ok(Found::Map {
        job,
        scope,
        sha,
        body,
    })
}

/// Whether `document` hashes to `sha` and `gzip` inflates to exactly it.
pub(crate) fn stored_parts_agree(document: &[u8], gzip: &[u8], sha: &str) -> bool {
    use sha2::{Digest, Sha256};
    let digest: String = Sha256::digest(document)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    digest == sha && gunzip(gzip, document.len()).as_deref() == Some(document)
}

/// The data of a gzip file (RFC 1952) that is exactly one valid member, at
/// most `limit` bytes; otherwise none. Valid means: the magic and DEFLATE
/// method; no reserved flag bit; the optional fields within the member; the
/// header checksum, when the header carries one; a DEFLATE stream that ends
/// exactly where the 8-byte trailer begins (so nothing, not even a second
/// member, follows it: one member is the only form this route serves); and a
/// trailer whose CRC-32 and length are the data's. A conforming gzip decoder
/// accepts every gzip this accepts.
fn gunzip(member: &[u8], limit: usize) -> Option<Vec<u8>> {
    use miniz_oxide::inflate::stream::{InflateState, inflate};
    use miniz_oxide::{DataFormat, MZFlush, MZStatus};
    const FHCRC: u8 = 2;
    const FEXTRA: u8 = 4;
    const FNAME: u8 = 8;
    const FCOMMENT: u8 = 16;
    const RESERVED: u8 = 0xe0;
    if member.len() < 18 || member[..3] != [0x1f, 0x8b, 8] {
        return None;
    }
    let flags = member[3];
    if flags & RESERVED != 0 {
        return None;
    }
    let mut at = 10;
    if flags & FEXTRA != 0 {
        let n = usize::from(u16::from_le_bytes([*member.get(at)?, *member.get(at + 1)?]));
        at = at.checked_add(2 + n)?;
    }
    for flag in [FNAME, FCOMMENT] {
        if flags & flag != 0 {
            at += member.get(at..)?.iter().position(|b| *b == 0)? + 1;
        }
    }
    if flags & FHCRC != 0 {
        let stored = u16::from_le_bytes([*member.get(at)?, *member.get(at + 1)?]);
        if crc32(member.get(..at)?) as u16 != stored {
            return None;
        }
        at += 2;
    }
    let end = member.len().checked_sub(8)?;
    let stream = member.get(at..end)?;
    // One byte more than the limit, so data over it cannot end the stream.
    let mut data = vec![0u8; limit.checked_add(1)?];
    let mut state = InflateState::new_boxed(DataFormat::Raw);
    let out = inflate(&mut state, stream, &mut data, MZFlush::Finish);
    if out.status != Ok(MZStatus::StreamEnd)
        || out.bytes_consumed != stream.len()
        || out.bytes_written > limit
    {
        return None;
    }
    data.truncate(out.bytes_written);
    let crc = u32::from_le_bytes(member[end..end + 4].try_into().ok()?);
    let size = u32::from_le_bytes(member[end + 4..].try_into().ok()?);
    (crc32(&data) == crc && size as usize == data.len()).then_some(data)
}

/// The CRC-32 of RFC 1952 (the ISO 3309 polynomial, reflected).
fn crc32(bytes: &[u8]) -> u32 {
    const TABLE: [u32; 256] = {
        let mut table = [0u32; 256];
        let mut n = 0;
        while n < 256 {
            let mut c = n as u32;
            let mut k = 0;
            while k < 8 {
                c = if c & 1 != 0 {
                    0xedb8_8320 ^ (c >> 1)
                } else {
                    c >> 1
                };
                k += 1;
            }
            table[n] = c;
            n += 1;
        }
        table
    };
    !bytes.iter().fold(!0u32, |c, b| {
        TABLE[((c ^ u32::from(*b)) & 0xff) as usize] ^ (c >> 8)
    })
}

#[cfg(test)]
#[path = "delphi_topic_map_tests.rs"]
pub(crate) mod tests;
