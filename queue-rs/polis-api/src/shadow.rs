//! The shadow role: polis-api run as its own process (`POLIS_API_ROLE=shadow`)
//! that receives nginx's copy of each request Node answers on a mirrored
//! route, and writes nothing.
//!
//! It listens only on `POLIS_API_SHADOW_LISTEN` and serves `GET /health` and
//! the copies of the routes in its table (`ROUTES`): `POST /api/v3/votes`
//! with `X-Polis-Shadow: votesShadow`, and, when the comment observer is
//! built, `POST /api/v3/comments` with `X-Polis-Shadow: commentsShadow`
//! (`shadow_comments.rs`). A copy is answered `204 No Content` at once,
//! before any database work, whatever happens to it. Then, in its own
//! route's lane, bounded by count and by rate, it runs through the same
//! route prelude and handler as a live request, with that handler in observe
//! mode (`post_votes_observe.rs`, `post_comments_observe.rs`), and one
//! `shadow_observation` line is printed for it. Each route has its own lane,
//! its own bound on waiting read-backs, its own rate bucket and its own two
//! read-only pools, so a burst on one route cannot delay or drop a copy of
//! the other. Only observers are built here: a live writer is refused at
//! startup, no other writer is constructed, and no read route is configured
//! whatever the env file says.
//!
//! Every line this process prints says it is the shadow's (`listener:
//! "shadow"`, or an event name starting `shadow_`), because every container on
//! a box writes into one log stream. No line carries a vote value, a member id,
//! a statement number, comment text, a token or any header value.
use crate::{
    config, db,
    http::{self, Body, Outgoing, Request},
    js::{self, Js, Obj},
    post_votes::{self, observe::NodeVote},
    route::{self, App},
};
use anyhow::{Context, Result};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};

#[path = "shadow_comments.rs"]
pub(crate) mod comments;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Role {
    Main,
    Shadow,
}

/// `POLIS_API_ROLE`: `main` (the default) or `shadow`.
pub(crate) fn role() -> Result<Role> {
    match std::env::var("POLIS_API_ROLE").ok().as_deref() {
        None | Some("" | "main") => Ok(Role::Main),
        Some("shadow") => Ok(Role::Shadow),
        Some(_) => anyhow::bail!("POLIS_API_ROLE must be main or shadow"),
    }
}

static SHADOW_ROLE: AtomicBool = AtomicBool::new(false);

/// `shadow_` in the shadow role, empty in the main role: the prefix for event
/// names printed by code both roles share.
pub(crate) fn event_prefix() -> &'static str {
    if SHADOW_ROLE.load(Ordering::Relaxed) {
        "shadow_"
    } else {
        ""
    }
}

/// The vote route's selector name.
pub(crate) const VOTES: &str = "votesShadow";

/// A route nginx mirrors to this listener.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Mirrored {
    Votes,
    Comments,
}

/// The mirrored routes: the selector name a copy carries in `X-Polis-Shadow`,
/// and the path it was posted to. A request is a copy of a route when both
/// are that route's.
const ROUTES: [(Mirrored, &str, &str); 2] = [
    (Mirrored::Votes, VOTES, post_votes::PATH),
    (
        Mirrored::Comments,
        comments::NAME,
        crate::post_comments::PATH,
    ),
];

fn mirrored(req: &Request) -> Option<Mirrored> {
    if req.method != "POST" {
        return None;
    }
    let selector = req.headers.get("x-polis-shadow")?;
    ROUTES
        .iter()
        .find(|(_, name, path)| selector == *name && req.path() == *path)
        .map(|(route, _, _)| *route)
}
const VOTES_ROUTE: &str = "POST /api/v3/votes";
/// Observations in admission or selection at once.
const CAPACITY: usize = 32;
/// Observations waiting for their readback at once (no connection is held).
const READBACK_WAITING: usize = 256;

/// What the vote handler reports about one copy, from inside `route::serve`.
#[derive(Default)]
pub(crate) struct Record {
    pub(crate) reason: Option<&'static str>,
    pub(crate) admitted: bool,
    pub(crate) zid: Option<i32>,
    pub(crate) admission: Option<Duration>,
    pub(crate) selection: Option<Duration>,
    pub(crate) follow_on: Option<&'static str>,
    pub(crate) remaining: Option<i64>,
    pub(crate) total: Option<i64>,
    pub(crate) weights_tick: Option<i64>,
    pub(crate) candidates: Option<Vec<i32>>,
    /// In process only, never printed: the member (zid, pid), the statement
    /// and the vote, for the readback and the membership memo.
    pub(crate) readback: Option<((i32, i32), i32, crate::votes::VoteChoice)>,
}

tokio::task_local! {
    static RECORD: Arc<Mutex<Record>>;
}

/// Adds to the current copy's record. Outside an observation (every live
/// request) there is no record and this does nothing.
pub(crate) fn record(f: impl FnOnce(&mut Record)) {
    let _ = RECORD.try_with(|record| f(&mut record.lock().unwrap_or_else(|e| e.into_inner())));
}

#[derive(Default)]
struct Counters {
    observed: AtomicU64,
    would_serve: AtomicU64,
    would_hand_back: AtomicU64,
    would_fail: AtomicU64,
    shed: AtomicU64,
    not_observed: AtomicU64,
    readback_same: AtomicU64,
    readback_ambiguous: AtomicU64,
    readback_different: AtomicU64,
    readback_absent: AtomicU64,
}

/// Request heads the shadow listener could not parse (it drops them without
/// an answer, as the main listener does), and copies whose body it would not
/// read (chunked or over the writer's size). Process-wide: http.rs counts them.
static HEAD_REFUSED: AtomicU64 = AtomicU64::new(0);
static BODY_UNREAD: AtomicU64 = AtomicU64::new(0);

pub(crate) struct Lane {
    max_per_second: u32,
    bucket: Mutex<(f64, tokio::time::Instant)>,
    in_flight: Arc<tokio::sync::Semaphore>,
    readback: Arc<tokio::sync::Semaphore>,
    address: Mutex<Option<String>>,
    counters: Counters,
    #[cfg(test)]
    park: tokio::sync::RwLock<()>,
}

impl Lane {
    pub(crate) fn new(max_per_second: u32) -> Arc<Self> {
        Arc::new(Self {
            max_per_second,
            bucket: Mutex::new((f64::from(max_per_second), tokio::time::Instant::now())),
            in_flight: Arc::new(tokio::sync::Semaphore::new(CAPACITY)),
            readback: Arc::new(tokio::sync::Semaphore::new(READBACK_WAITING)),
            address: Mutex::new(None),
            counters: Counters::default(),
            #[cfg(test)]
            park: tokio::sync::RwLock::new(()),
        })
    }

    /// A token bucket of `max_per_second`, refilled continuously.
    fn take_token(&self) -> bool {
        let rate = f64::from(self.max_per_second);
        let mut bucket = self.bucket.lock().unwrap_or_else(|e| e.into_inner());
        let now = tokio::time::Instant::now();
        let refill = now.duration_since(bucket.1).as_secs_f64() * rate;
        bucket.0 = (bucket.0 + refill).min(rate);
        bucket.1 = now;
        if bucket.0 >= 1.0 {
            bucket.0 -= 1.0;
            true
        } else {
            false
        }
    }

    pub(crate) fn in_flight(&self) -> usize {
        CAPACITY - self.in_flight.available_permits()
    }

    pub(crate) fn readback_waiting(&self) -> usize {
        READBACK_WAITING - self.readback.available_permits()
    }

    fn listening(&self, address: std::net::SocketAddr) {
        *self.address.lock().unwrap_or_else(|e| e.into_inner()) = Some(address.to_string());
    }

    /// Holds every new observation at its start until the returned lock is
    /// released.
    #[cfg(test)]
    pub(crate) async fn park(&self) -> tokio::sync::RwLockWriteGuard<'_, ()> {
        self.park.write().await
    }
}

/// One `shadow_observation` line. The keys and their order are the line's
/// contract (`LINE_KEYS` in the tests). No key names a statement, neither the
/// one voted on nor the one that would be served next: beside the
/// conversation number and the time, a statement number picks out one row of
/// the conversation's public votes, and with it a participant. What needs the
/// number uses it in process and the line carries the class it found
/// (`node_vote`, `prev`, `follow_on`).
#[derive(Default)]
struct Line<'a> {
    request_id: Option<&'a str>,
    outcome: &'static str,
    admitted: bool,
    status: Option<u16>,
    reason: Option<&'static str>,
    queue: Option<Duration>,
    admission: Option<Duration>,
    selection: Option<Duration>,
    total: Option<Duration>,
    readback_s: Option<f64>,
    zid: Option<i32>,
    facts: (bool, bool),
    follow_on: Option<&'static str>,
    remaining: Option<i64>,
    total_count: Option<i64>,
    candidates: Option<usize>,
    weights_tick: Option<i64>,
    prev: Option<&'static str>,
    node_vote: Option<NodeVote>,
}

fn ms(duration: Option<Duration>) -> Js {
    duration
        .map(|d| Js::Num((d.as_secs_f64() * 1000.0 * 1000.0).round() / 1000.0))
        .unwrap_or(Js::Null)
}

fn num(value: Option<impl Into<f64>>) -> Js {
    value.map(|v| Js::Num(v.into())).unwrap_or(Js::Null)
}

fn text(value: Option<&str>) -> Js {
    value.map(|v| Js::Str(v.into())).unwrap_or(Js::Null)
}

impl Line<'_> {
    fn print(&self, app: &App) {
        let (starred, lang) = self.facts;
        let mut line = Obj::new();
        line.set("message", Js::Str("shadow_observation".into()));
        line.set("listener", Js::Str("shadow".into()));
        line.set("service", Js::Str("polis-api-shadow".into()));
        line.set("env", Js::Str(app.dd_env().into()));
        line.set("shadow", Js::Str(VOTES.into()));
        line.set("route", Js::Str(VOTES_ROUTE.into()));
        line.set("request_id", text(self.request_id));
        line.set("outcome", Js::Str(self.outcome.into()));
        line.set("admitted", Js::Num(if self.admitted { 1.0 } else { 0.0 }));
        line.set("status", num(self.status));
        line.set("reason", text(self.reason));
        line.set("queue_ms", ms(self.queue));
        line.set("admission_ms", ms(self.admission));
        line.set("selection_ms", ms(self.selection));
        line.set("total_ms", ms(self.total));
        line.set("readback_s", num(self.readback_s));
        line.set("zid", num(self.zid));
        line.set("starred_present", Js::Bool(starred));
        line.set("lang_present", Js::Bool(lang));
        line.set("append", Js::Str("not_modelled".into()));
        line.set("follow_on", text(self.follow_on));
        line.set("remaining", num(self.remaining.map(|n| n as f64)));
        line.set("total", num(self.total_count.map(|n| n as f64)));
        line.set("candidates", num(self.candidates.map(|n| n as f64)));
        line.set("weights_tick", num(self.weights_tick.map(|n| n as f64)));
        line.set("prev", text(self.prev));
        line.set(
            "node_vote",
            Js::Str(
                self.node_vote
                    .unwrap_or(NodeVote::NotChecked)
                    .as_str()
                    .into(),
            ),
        );
        print(js::stringify(&Js::Obj(line)));
    }
}

fn print(line: String) {
    #[cfg(test)]
    tests::record_line(&line);
    println!("{line}");
}

/// An event line of the shadow role. `name` must start `shadow_`.
pub(crate) fn event(name: &str, fields: &[(&str, Js)]) {
    let mut line = Obj::new();
    line.set("event", Js::Str(name.into()));
    line.set("listener", Js::Str("shadow".into()));
    line.set("service", Js::Str("polis-api-shadow".into()));
    for (key, value) in fields {
        line.set(key, value.clone());
    }
    let line = js::stringify(&Js::Obj(line));
    #[cfg(test)]
    tests::record_line(&line);
    eprintln!("{line}");
}

/// The shadow listener refused a request head (see `http::HeadRefused`).
pub(crate) fn head_refused(class: &'static str) {
    let count = HEAD_REFUSED.fetch_add(1, Ordering::Relaxed) + 1;
    event(
        "shadow_http_head_refused",
        &[
            ("class", Js::Str(class.into())),
            ("count", Js::Num(count as f64)),
        ],
    );
}

/// A copy whose body the writer would not read: answered 204 and closed, as
/// the live listener would hand it back without reading it.
pub(crate) fn body_unread() {
    let count = BODY_UNREAD.fetch_add(1, Ordering::Relaxed) + 1;
    event(
        "shadow_http_body_unread",
        &[("count", Js::Num(count as f64))],
    );
}

pub(crate) fn connection_error(detail: &str) {
    event(
        "shadow_http_connection_error",
        &[("detail", Js::Str(detail.into()))],
    );
}

fn request_id(req: &Request) -> Option<&str> {
    req.headers
        .get("x-request-id")
        .filter(|id| id.len() == 32 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')))
}

fn no_content() -> Outgoing {
    Outgoing {
        status: 204,
        headers: vec![],
        body: Body::Empty,
        close: false,
    }
}

fn not_found() -> Outgoing {
    let bytes = b"Not Found\n".to_vec();
    Outgoing {
        status: 404,
        headers: vec![
            ("Content-Type".into(), "text/plain; charset=utf-8".into()),
            ("Content-Length".into(), bytes.len().to_string()),
        ],
        body: Body::Fixed(bytes),
        close: false,
    }
}

enum Decision {
    Observe(tokio::sync::OwnedSemaphorePermit),
    Shed(&'static str),
    NotObserved,
}

/// Everything the shadow listener serves. `lane` is the vote route's; the
/// comment route's lane is its observer's own.
pub(crate) async fn accept(app: Arc<App>, lane: Arc<Lane>, req: Request) -> Outgoing {
    if req.method == "GET" && req.path() == "/health" {
        return health(&app, &lane).await;
    }
    match mirrored(&req) {
        Some(Mirrored::Votes) => accept_vote(app, lane, req).await,
        // Served only when its observer is built: without it a comment copy
        // is, as before, not a copy of anything this listener serves.
        Some(Mirrored::Comments) if app.post_comments_observe.is_some() => {
            comments::accept(app, req).await
        }
        // Not a copy of a shadowed route; nothing is recorded.
        _ => not_found(),
    }
}

/// A copy of a vote.
async fn accept_vote(app: Arc<App>, lane: Arc<Lane>, req: Request) -> Outgoing {
    let received = tokio::time::Instant::now();
    // A copy is never dispatched to a live writer; none exists in this role,
    // and a process holding one is not observed at all.
    let decision = if app.post_votes.is_some() || app.post_votes_observe.is_none() {
        Decision::NotObserved
    } else if !lane.take_token() {
        Decision::Shed("rate_cap")
    } else {
        match lane.in_flight.clone().try_acquire_owned() {
            Ok(permit) => Decision::Observe(permit),
            Err(_) => Decision::Shed("lane_full"),
        }
    };
    route::access_log_as(
        &app,
        &req,
        204,
        received.elapsed(),
        "none",
        &crate::db_connect::Observation::default(),
        Some("shadow"),
    );
    let facts = post_votes::copy_facts(&req);
    match decision {
        Decision::Observe(permit) => {
            tokio::spawn(observe(app, lane, req, received, permit));
        }
        Decision::Shed(reason) => {
            lane.counters.shed.fetch_add(1, Ordering::Relaxed);
            Line {
                request_id: request_id(&req),
                outcome: "shed",
                reason: Some(reason),
                facts,
                ..Line::default()
            }
            .print(&app);
        }
        Decision::NotObserved => {
            lane.counters.not_observed.fetch_add(1, Ordering::Relaxed);
            Line {
                request_id: request_id(&req),
                outcome: "not_observed",
                reason: Some("unconfigured"),
                facts,
                ..Line::default()
            }
            .print(&app);
        }
    }
    no_content()
}

/// One observation, after its 204 has been returned.
async fn observe(
    app: Arc<App>,
    lane: Arc<Lane>,
    req: Request,
    received: tokio::time::Instant,
    permit: tokio::sync::OwnedSemaphorePermit,
) {
    #[cfg(test)]
    drop(lane.park.read().await);
    let Some(observer) = app.post_votes_observe.as_ref() else {
        return;
    };
    let anchor = observer.anchor().await;
    let queue = received.elapsed();
    let record = Arc::new(Mutex::new(Record::default()));
    // The prelude and handler of a live request, with the 502-to-revoked
    // rewrite of route::handle.
    let out = crate::db_connect::OBSERVATION
        .scope(
            Arc::new(crate::db_connect::Observation::default()),
            crate::pca::CACHE_OUTCOME.scope(
                std::cell::Cell::new("none"),
                RECORD.scope(record.clone(), async {
                    let out = route::serve(&app, &req).await;
                    route::revoked_rewrite(&app, &req, out)
                }),
            ),
        )
        .await;
    let total = received.elapsed();
    // The lane slot covers admission and selection only.
    drop(permit);
    let mut taken = std::mem::take(&mut *record.lock().unwrap_or_else(|e| e.into_inner()));
    if taken.reason.is_none() && out.status != 200 {
        taken.reason = post_votes::shape_reason(&app, &req);
    }
    let served = out.status == 200;
    let mut prev = None;
    let mut node_vote = NodeVote::NotChecked;
    let mut readback_s = None;
    if let Some((member, tid, vote)) = taken.readback {
        if served {
            prev = observer.previous(member, tid).await;
            if let (Some(anchor), Some(candidates)) = (anchor, taken.candidates.clone()) {
                observer.remember(member, candidates, anchor);
            }
        }
        if let Some(anchor) = anchor
            && let Ok(slot) = lane.readback.clone().try_acquire_owned()
        {
            let (class, delay) = observer
                .read_back(member, tid, vote, anchor, received)
                .await;
            drop(slot);
            node_vote = class;
            readback_s = delay;
        }
    }
    let outcome = match out.status {
        502 => "would_hand_back",
        500..=599 => "would_fail",
        _ => "would_serve",
    };
    let counters = &lane.counters;
    counters.observed.fetch_add(1, Ordering::Relaxed);
    match outcome {
        "would_hand_back" => &counters.would_hand_back,
        "would_fail" => &counters.would_fail,
        _ => &counters.would_serve,
    }
    .fetch_add(1, Ordering::Relaxed);
    match node_vote {
        NodeVote::Same => Some(&counters.readback_same),
        NodeVote::Ambiguous => Some(&counters.readback_ambiguous),
        NodeVote::Different => Some(&counters.readback_different),
        NodeVote::Absent => Some(&counters.readback_absent),
        NodeVote::Unavailable | NodeVote::NotChecked => None,
    }
    .map(|counter| counter.fetch_add(1, Ordering::Relaxed));
    Line {
        request_id: request_id(&req),
        outcome,
        admitted: taken.admitted,
        status: Some(out.status),
        reason: taken.reason,
        queue: Some(queue),
        admission: taken.admission,
        selection: taken.selection,
        total: Some(total),
        readback_s,
        zid: taken.zid,
        facts: post_votes::copy_facts(&req),
        follow_on: taken.follow_on,
        remaining: taken.remaining,
        total_count: taken.total,
        candidates: taken.candidates.as_ref().map(Vec::len),
        weights_tick: taken.weights_tick,
        prev,
        node_vote: Some(node_vote),
    }
    .print(&app);
}

/// `GET /health` on the shadow listener. `enabled` means serving
/// participants, so it is always false here; `mode` says observe.
pub(crate) async fn health(app: &App, lane: &Lane) -> Outgoing {
    let observer = app.post_votes_observe.as_ref();
    let votes_reachable = match observer {
        Some(observer) => observer.ping().await,
        None => true,
    };
    // The comment observer, when built, has a key of its own below, and its
    // read-back database counts toward the status as the vote observer's does.
    let comment_observer = app.post_comments_observe.as_ref();
    let comments_reachable = match comment_observer {
        Some(observer) => observer.ping().await,
        None => true,
    };
    let all_reachable = votes_reachable && comments_reachable;
    let mut body = Obj::new();
    body.set("role", Js::Str("shadow".into()));
    body.set(
        "status",
        Js::Str(if all_reachable { "ok" } else { "degraded" }.into()),
    );
    body.set("version", Js::Str(env!("POLIS_VERSION").into()));
    body.set("commit", Js::Str(env!("GIT_HASH").into()));
    let mut votes = Obj::new();
    votes.set("enabled", Js::Bool(false));
    votes.set(
        "mode",
        Js::Str(if observer.is_some() { "observe" } else { "off" }.into()),
    );
    let c = &lane.counters;
    for (key, value) in [
        ("observed", &c.observed),
        ("wouldServe", &c.would_serve),
        ("wouldHandBack", &c.would_hand_back),
        ("wouldFail", &c.would_fail),
        ("shed", &c.shed),
        ("notObserved", &c.not_observed),
        ("readbackSame", &c.readback_same),
        ("readbackAmbiguous", &c.readback_ambiguous),
        ("readbackDifferent", &c.readback_different),
        ("readbackAbsent", &c.readback_absent),
    ] {
        votes.set(key, Js::Num(value.load(Ordering::Relaxed) as f64));
    }
    votes.set(
        "pools",
        observer
            .map(|observer| observer.pools_health(votes_reachable))
            .unwrap_or_else(|| Js::Obj(Obj::new())),
    );
    body.set("postVotes", Js::Obj(votes));
    if let Some(observer) = comment_observer {
        body.set(
            "postComments",
            comments::health(observer, comments_reachable),
        );
    }
    let address = lane
        .address
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let mut shadow = Obj::new();
    shadow.set("listening", Js::Bool(address.is_some()));
    shadow.set("address", text(address.as_deref()));
    shadow.set("inFlight", Js::Num(lane.in_flight() as f64));
    shadow.set("capacity", Js::Num(CAPACITY as f64));
    shadow.set("maxPerSecond", Js::Num(f64::from(lane.max_per_second)));
    shadow.set("readbackWaiting", Js::Num(lane.readback_waiting() as f64));
    shadow.set(
        "headRefused",
        Js::Num(HEAD_REFUSED.load(Ordering::Relaxed) as f64),
    );
    shadow.set(
        "bodyUnread",
        Js::Num(BODY_UNREAD.load(Ordering::Relaxed) as f64),
    );
    body.set("shadow", Js::Obj(shadow));
    let bytes = js::stringify(&Js::Obj(body)).into_bytes();
    Outgoing {
        status: if all_reachable { 200 } else { 503 },
        headers: vec![
            ("Content-Type".into(), "application/json".into()),
            ("Cache-Control".into(), "no-cache".into()),
            ("Content-Length".into(), bytes.len().to_string()),
        ],
        body: Body::Fixed(bytes),
        close: false,
    }
}

pub(crate) struct Shadow {
    pub(crate) app: App,
    pub(crate) lane: Arc<Lane>,
    pub(crate) listen: String,
}

/// The shadow role's configuration, with no database work: the process
/// settings the route prelude reads (CORS, HTTPS, NODE_ENV, MATH_ENV), the
/// participant keys, and the observe writer. No read route is configured and
/// no other writer is built, whatever switches the env file carries.
pub(crate) fn configure() -> Result<Shadow> {
    SHADOW_ROLE.store(true, Ordering::Relaxed);
    let participant_keys = polis_auth::keys::Keys::from_env_optional()?;
    let cfg = config::Config::from_env()?;
    let listen = std::env::var("POLIS_API_SHADOW_LISTEN")
        .ok()
        .filter(|value| !value.is_empty())
        .context("the shadow role requires POLIS_API_SHADOW_LISTEN")?;
    let max_per_second = std::env::var("POLIS_API_SHADOW_MAX_PER_SECOND")
        .ok()
        .and_then(|value| value.parse::<u32>().ok())
        .filter(|value| (1..=10_000).contains(value))
        .context("the shadow role requires POLIS_API_SHADOW_MAX_PER_SECOND, 1 to 10000")?;
    let mut app = App::new(
        &cfg,
        db::Pool::new(config::db_connector()?, cfg.pool.clone()),
    );
    app.participant_keys = participant_keys;
    match post_votes::configure(Role::Shadow, app.participant_keys.as_ref())? {
        post_votes::Configured::Observe(observer) => app.post_votes_observe = Some(observer),
        post_votes::Configured::Off => {}
        post_votes::Configured::Live(_) => {
            anyhow::bail!("the shadow role never builds the live vote writer")
        }
    }
    // The comment observer: built only when the comment handler's own switch
    // says observe. A value this role does not accept stops the process.
    match crate::post_comments::configure(Role::Shadow, app.participant_keys.as_ref())? {
        crate::post_comments::Configured::Observe(observer) => {
            app.post_comments_observe = Some(*observer);
        }
        crate::post_comments::Configured::Off => {}
        crate::post_comments::Configured::Live(_) => {
            anyhow::bail!("the shadow role never builds the live comment writer")
        }
    }
    Ok(Shadow {
        app,
        lane: Lane::new(max_per_second),
        listen,
    })
}

/// Serves the shadow listener until the listener fails.
pub(crate) async fn serve(
    listener: tokio::net::TcpListener,
    app: Arc<App>,
    lane: Arc<Lane>,
) -> Result<()> {
    lane.listening(listener.local_addr()?);
    let handler = Arc::new(move |req: Request| accept(app.clone(), lane.clone(), req));
    http::serve_as(listener, handler, http::Listener::Shadow).await
}

/// The shadow role's process: configure, load the revocation snapshot the
/// prelude checks, listen, and stop on SIGINT as the main role does.
pub(crate) async fn run() -> Result<()> {
    let Shadow {
        mut app,
        lane,
        listen,
    } = configure()?;
    let refresh = crate::revocation::configure(&mut app).await?;
    let listener = tokio::net::TcpListener::bind(&listen)
        .await
        .with_context(|| format!("bind {listen}"))?;
    let mut listening = vec![
        ("address", Js::Str(listener.local_addr()?.to_string())),
        (
            "mode",
            Js::Str(
                if app.post_votes_observe.is_some() {
                    "observe"
                } else {
                    "off"
                }
                .into(),
            ),
        ),
    ];
    if let Some(observer) = app.post_comments_observe.as_ref() {
        // A process that holds comments' text prints no panic message.
        install_panic_hook();
        listening.push(("post_comments", Js::Str("observe".into())));
        comments::report_logging_settings(observer).await;
    }
    event("shadow_listening", &listening);
    let result = tokio::select! {
        r = serve(listener, Arc::new(app), lane) => r,
        _ = tokio::signal::ctrl_c() => Ok(()),
    };
    if let Some(task) = refresh {
        task.abort();
        let _ = task.await;
    }
    result
}

/// After this, a panic in this process prints where it happened and never
/// what it said. A panic's message can quote what the panicking code held: a
/// string cut off a character boundary prints the string. Installed by the
/// shadow role when it builds the comment observer.
pub(crate) fn install_panic_hook() {
    std::panic::set_hook(Box::new(|info| {
        let location = info
            .location()
            .map(|at| format!("{}:{}:{}", at.file(), at.line(), at.column()));
        event("shadow_panic", &[("location", text(location.as_deref()))]);
    }));
}

#[cfg(test)]
pub(crate) use tests::recorded;

#[cfg(test)]
pub(crate) mod tests {
    static LINES: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

    pub(crate) fn record_line(line: &str) {
        LINES
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(line.to_owned());
    }

    pub(crate) fn recorded() -> Vec<String> {
        LINES.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
}
