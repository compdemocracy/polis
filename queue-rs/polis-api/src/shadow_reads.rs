//! The shadow listener's read lanes: copies of `GET /api/v3/votes`
//! (`X-Polis-Shadow: votesReadShadow`), `GET /api/v3/comments`
//! (`commentsReadShadow`) and `GET /api/v3/nextComment`
//! (`nextCommentShadow`). A lane is served only when it is built, and it is
//! built only when its handler's own switch says `observe`
//! (`POLIS_API_VOTES_READS`, `POLIS_API_COMMENT_READS`,
//! `POLIS_API_NEXT_COMMENT_READS`). With none of them set to that word this
//! process builds nothing here and answers a GET as it did before: 404.
//!
//! Each lane has its own bound on copies being observed at once, its own rate
//! bucket and its own read-only pools, with the limits the live handler's
//! pools have. Nothing here takes a slot, a token or a connection of the vote
//! lane's or the comment lane's, and nothing of theirs is taken here.
//!
//! A copy is answered `204 No Content` at once, before any database work,
//! whatever becomes of it. Then it runs through the route prelude and the
//! handler a live request runs through, on the lane's pools, and one
//! `shadow_observation` line is printed for it: would the live handler serve
//! it, and if not, why not, as one word of a closed set.
//!
//! A GET's query string holds a participant number and can hold an external
//! id. It is used in process and never reaches a line: no line here carries
//! the query string or any part of it, a participant, comment or user
//! number, an external id, a token, a vote, text, a digest or a length.
//! Every value on the line is a number this module measured, the
//! conversation number, or a word of a closed set.
#![deny(
    clippy::string_slice,
    clippy::indexing_slicing,
    clippy::unwrap_used,
    clippy::expect_used
)]
use super::{event, ms, no_content, num, request_id, text};
use crate::{
    config, db,
    http::{Outgoing, Request},
    js::{self, Js, Obj},
    route::{self, App},
};
use anyhow::{Context, Result};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicU32, AtomicU64, Ordering},
    },
    time::Duration,
};

/// The value of a read handler's switch that builds its lane, in the shadow
/// role only.
pub(crate) const OBSERVE: &str = "observe";
/// Copies of one route being observed at once. A copy over the bound is shed.
pub(crate) const CAPACITY: usize = 8;
/// Copies in a row that must fail at the database before a lane reports it
/// unreachable.
pub(crate) const UNREACHABLE: u32 = 3;

/// A read route nginx mirrors to this listener.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Route {
    Votes,
    Comments,
    NextComment,
}

impl Route {
    pub(crate) const ALL: [Route; 3] = [Route::Votes, Route::Comments, Route::NextComment];

    /// The route's selector name: what nginx's copies carry in
    /// `X-Polis-Shadow`.
    pub(crate) const fn selector(self) -> &'static str {
        match self {
            Route::Votes => "votesReadShadow",
            Route::Comments => "commentsReadShadow",
            Route::NextComment => "nextCommentShadow",
        }
    }

    pub(crate) const fn path(self) -> &'static str {
        match self {
            Route::Votes => crate::votes_read::PATH,
            Route::Comments => crate::comments::PATH,
            Route::NextComment => crate::next_comment::PATH,
        }
    }

    /// The `route` value of the lane's lines.
    pub(crate) const fn name(self) -> &'static str {
        match self {
            Route::Votes => "GET /api/v3/votes",
            Route::Comments => "GET /api/v3/comments",
            Route::NextComment => "GET /api/v3/nextComment",
        }
    }

    /// The lane's key on `GET /health`.
    pub(crate) const fn health_key(self) -> &'static str {
        match self {
            Route::Votes => "getVotes",
            Route::Comments => "getComments",
            Route::NextComment => "getNextComment",
        }
    }

    /// The lane's key on the `shadow_listening` event.
    pub(crate) const fn event_key(self) -> &'static str {
        match self {
            Route::Votes => "get_votes",
            Route::Comments => "get_comments",
            Route::NextComment => "get_next_comment",
        }
    }

    /// The handler's switch: the one the main role reads `1` from.
    pub(crate) const fn switch(self) -> &'static str {
        match self {
            Route::Votes => "POLIS_API_VOTES_READS",
            Route::Comments => "POLIS_API_COMMENT_READS",
            Route::NextComment => "POLIS_API_NEXT_COMMENT_READS",
        }
    }

    /// The lane's rate: copies a second this process may observe. Required;
    /// there is no default.
    pub(crate) const fn rate_setting(self) -> &'static str {
        match self {
            Route::Votes => "POLIS_API_SHADOW_VOTES_READ_MAX_PER_SECOND",
            Route::Comments => "POLIS_API_SHADOW_COMMENTS_READ_MAX_PER_SECOND",
            Route::NextComment => "POLIS_API_SHADOW_NEXT_COMMENT_MAX_PER_SECOND",
        }
    }

    const fn index(self) -> usize {
        match self {
            Route::Votes => 0,
            Route::Comments => 1,
            Route::NextComment => 2,
        }
    }
}

/// How many rows the answer has, as a class. Never the number: the number of
/// a participant's own rows, beside the conversation and the time, can pick
/// out one person.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Rows {
    None,
    One,
    Many,
}

impl Rows {
    pub(crate) fn of(count: usize) -> Self {
        match count {
            0 => Self::None,
            1 => Self::One,
            _ => Self::Many,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::One => "one",
            Self::Many => "many",
        }
    }
}

/// What a read handler reports about one copy, from inside `route::serve`.
#[derive(Default)]
pub(crate) struct Record {
    pub(crate) reason: Option<&'static str>,
    pub(crate) zid: Option<i32>,
    pub(crate) rows: Option<Rows>,
    /// Time spent waiting on the lane's pools: for a connection, and for the
    /// statements run on it.
    pub(crate) database: Option<Duration>,
    /// Whether a connection or a statement failed (not a busy pool), for the
    /// lane's `reachable`.
    pub(crate) database_failed: bool,
    /// Why the identity lookup's own database operation failed, when it did:
    /// a busy pool or a failed connection or statement is not a refused
    /// credential.
    pub(crate) credential_database: Option<&'static str>,
    pub(crate) selected: Option<bool>,
    pub(crate) remaining: Option<i64>,
    pub(crate) total: Option<i64>,
    pub(crate) weights_tick: Option<i64>,
}

tokio::task_local! {
    static RECORD: Arc<Mutex<Record>>;
}

/// Reads or adds to the current copy's record. Outside an observation (every
/// live request) there is no record: this does nothing and answers None.
pub(crate) fn record<T>(f: impl FnOnce(&mut Record) -> T) -> Option<T> {
    RECORD
        .try_with(|record| f(&mut record.lock().unwrap_or_else(|e| e.into_inner())))
        .ok()
}

/// True inside an observation of a copy; false for every live request.
pub(crate) fn observing() -> bool {
    RECORD.try_with(|_| ()).is_ok()
}

/// The answer a read handler gives a request it hands back to Node, with the
/// reason it does. The answer is `route::bad_gateway()` and nothing else: the
/// reason goes to the current copy's record, and a live request has none.
#[cfg_attr(test, track_caller)]
pub(crate) fn handback(reason: &'static str) -> Outgoing {
    record(|record| record.reason = Some(reason));
    route::bad_gateway()
}

/// The reason for a hand-back after a database operation failed: the pool
/// had no free slot within its acquire timeout, or the connection or a
/// statement failed.
pub(crate) fn database_reason(error: &anyhow::Error) -> &'static str {
    if db::is_acquire_timeout(error) {
        "pool_busy"
    } else {
        record(|record| record.database_failed = true);
        "database"
    }
}

/// Records that the database operation of an identity lookup failed, and how
/// (`hybrid_read::resolve_scoped` calls it where its lookup did not answer),
/// so the copy's line gives that reason and the failure counts for the lane's
/// `reachable`. Outside an observation it does nothing.
pub(crate) fn credential_database(error: &anyhow::Error) {
    let reason = database_reason(error);
    record(|record| record.credential_database = Some(reason));
}

/// The reason for a credential `hybrid_read::resolve_scoped` handed back:
/// the database's own reason when its lookup failed there (`pool_busy`,
/// `database`), else the credential's class, which `class` gives.
pub(crate) fn credential_reason(class: impl FnOnce() -> &'static str) -> &'static str {
    record(|record| record.credential_database.take())
        .flatten()
        .unwrap_or_else(class)
}

/// Adds the time one operation on a pool took to the current copy's record:
/// the wait for a slot, the connection when the pool had none idle, and the
/// statements. `db::Pool` calls it; outside an observation it does nothing.
pub(crate) fn database_time(took: Duration) {
    record(|record| record.database = Some(record.database.unwrap_or_default() + took));
}

#[derive(Default)]
struct Counters {
    observed: AtomicU64,
    would_serve: AtomicU64,
    would_answer: AtomicU64,
    would_hand_back: AtomicU64,
    would_fail: AtomicU64,
    shed: AtomicU64,
}

/// One read route's own lane.
pub(crate) struct Lane {
    route: Route,
    max_per_second: u32,
    bucket: Mutex<(f64, tokio::time::Instant)>,
    in_flight: Arc<tokio::sync::Semaphore>,
    /// The lane's pools by name: every one a read-only session.
    pools: Vec<(&'static str, Arc<db::Pool>)>,
    /// Copies in a row whose connection or statement failed, since the last
    /// one the database answered. The startup probe counts as `UNREACHABLE`
    /// of them when the database does not answer it.
    failures: AtomicU32,
    counters: Counters,
    #[cfg(test)]
    park: tokio::sync::RwLock<()>,
}

impl Lane {
    pub(crate) fn new(
        route: Route,
        max_per_second: u32,
        pools: Vec<(&'static str, Arc<db::Pool>)>,
    ) -> Arc<Self> {
        Arc::new(Self {
            route,
            max_per_second,
            bucket: Mutex::new((f64::from(max_per_second), tokio::time::Instant::now())),
            in_flight: Arc::new(tokio::sync::Semaphore::new(CAPACITY)),
            pools,
            failures: AtomicU32::new(0),
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

    /// Every pool the lane holds. No other pool is built for it.
    #[cfg(test)]
    pub(crate) fn pools(&self) -> &[(&'static str, Arc<db::Pool>)] {
        &self.pools
    }

    /// Asks each of the lane's pools once whether its database answers.
    pub(crate) async fn probe(&self) -> bool {
        let mut reachable = true;
        for (_, pool) in &self.pools {
            reachable &= pool.ping().await;
        }
        self.failures
            .store(if reachable { 0 } else { UNREACHABLE }, Ordering::Relaxed);
        reachable
    }

    /// Whether the lane's database answers, as far as the lane has seen: its
    /// startup probe, and then its copies. One failed statement does not say
    /// it is gone; `UNREACHABLE` copies in a row do, until one is answered.
    pub(crate) fn reachable(&self) -> bool {
        self.failures.load(Ordering::Relaxed) < UNREACHABLE
    }

    /// Holds every new observation at its start until the returned lock is
    /// released.
    #[cfg(test)]
    pub(crate) async fn park(&self) -> tokio::sync::RwLockWriteGuard<'_, ()> {
        self.park.write().await
    }
}

/// The read lanes this process built: none in the main role, and none in the
/// shadow role unless a read handler's switch says `observe`.
#[derive(Default)]
pub(crate) struct Lanes([Option<Arc<Lane>>; 3]);

impl Lanes {
    pub(crate) fn get(&self, route: Route) -> Option<&Arc<Lane>> {
        self.0.get(route.index()).and_then(Option::as_ref)
    }

    pub(crate) fn set(&mut self, lane: Arc<Lane>) {
        if let Some(slot) = self.0.get_mut(lane.route.index()) {
            *slot = Some(lane);
        }
    }

    pub(crate) fn built(&self) -> impl Iterator<Item = &Arc<Lane>> {
        self.0.iter().flatten()
    }
}

/// One `shadow_observation` line of a read lane. The keys and their order are
/// the line's contract (`LINE_KEYS` in the tests), the same for the three
/// routes: a key a route has no value for is null.
#[derive(Default)]
struct Line<'a> {
    request_id: Option<&'a str>,
    outcome: &'static str,
    status: Option<u16>,
    reason: Option<&'static str>,
    queue: Option<Duration>,
    handler: Option<Duration>,
    database: Option<Duration>,
    total: Option<Duration>,
    zid: Option<i32>,
    rows: Option<Rows>,
    selected: Option<bool>,
    remaining: Option<i64>,
    total_count: Option<i64>,
    weights_tick: Option<i64>,
}

impl Line<'_> {
    fn print(&self, app: &App, route: Route) {
        let mut line = Obj::new();
        line.set("message", Js::Str("shadow_observation".into()));
        line.set("listener", Js::Str("shadow".into()));
        line.set("service", Js::Str("polis-api-shadow".into()));
        line.set("env", Js::Str(app.dd_env().into()));
        line.set("shadow", Js::Str(route.selector().into()));
        line.set("route", Js::Str(route.name().into()));
        line.set("request_id", text(self.request_id));
        line.set("outcome", Js::Str(self.outcome.into()));
        line.set("status", num(self.status));
        line.set("reason", text(self.reason));
        line.set("queue_ms", ms(self.queue));
        line.set("handler_ms", ms(self.handler));
        line.set("db_ms", ms(self.database));
        line.set("total_ms", ms(self.total));
        line.set("zid", num(self.zid));
        line.set("rows", text(self.rows.map(Rows::as_str)));
        line.set("selected", self.selected.map(Js::Bool).unwrap_or(Js::Null));
        line.set("remaining", num(self.remaining.map(|n| n as f64)));
        line.set("total", num(self.total_count.map(|n| n as f64)));
        line.set("weights_tick", num(self.weights_tick.map(|n| n as f64)));
        print(js::stringify(&Js::Obj(line)));
    }
}

fn print(line: String) {
    #[cfg(test)]
    tests::record_line(&line);
    println!("{line}");
}

/// A copy of a read, at the shadow listener: answered 204 at once, before
/// any database work, whatever becomes of it.
pub(crate) async fn accept(app: Arc<App>, route: Route, req: Request) -> Outgoing {
    let Some(lane) = app.read_lanes.get(route).cloned() else {
        return super::not_found();
    };
    let received = tokio::time::Instant::now();
    let decision = if !lane.take_token() {
        Err("rate_cap")
    } else {
        lane.in_flight
            .clone()
            .try_acquire_owned()
            .map_err(|_| "lane_full")
    };
    // The path only: the access line never carries a query string.
    route::access_log_as(
        &app,
        &req,
        204,
        received.elapsed(),
        "none",
        &crate::db_connect::Observation::default(),
        Some("shadow"),
    );
    match decision {
        Ok(permit) => {
            tokio::spawn(observe(app, lane, req, received, permit));
        }
        Err(reason) => {
            lane.counters.shed.fetch_add(1, Ordering::Relaxed);
            Line {
                request_id: request_id(&req),
                outcome: "shed",
                reason: Some(reason),
                ..Line::default()
            }
            .print(&app, route);
        }
    }
    no_content()
}

/// Why the route prelude answered a read without its handler recording a
/// reason, in the prelude's own order (`route::serve`): the revocation
/// snapshot, the handler's own eligibility where the prelude asks for it, the
/// HTTPS rule and the body checks. Pure: no database work.
fn prelude_reason(app: &App, route: Route, req: &Request) -> Option<&'static str> {
    if let Some(raw) = req.headers.get("authorization")
        && crate::revocation::refusal(app, raw, (crate::clock::now_ms() / 1000.0) as u64).is_some()
    {
        return Some("revoked");
    }
    let ineligible = match route {
        Route::Votes => crate::votes_read::parse_reasoned(app, req).err(),
        Route::NextComment => crate::next_comment::ineligible(app, req),
        // The comment list is checked by its handler alone.
        Route::Comments => None,
    };
    if ineligible.is_some() {
        return ineligible;
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
    let route = lane.route;
    let queue = received.elapsed();
    #[cfg(test)]
    read_tests::panic_point(&req);
    let record = Arc::new(Mutex::new(Record::default()));
    let started = tokio::time::Instant::now();
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
    let handler = started.elapsed();
    let total = received.elapsed();
    drop(permit);
    let mut taken = std::mem::take(&mut *record.lock().unwrap_or_else(|e| e.into_inner()));
    // The would-be answer is dropped here with its body: nothing of it is
    // kept but its status.
    let status = out.status;
    drop(out);
    let outcome = match status {
        // The live handler would answer with what it read (304: with nothing
        // new for a client that holds it).
        200..=299 | 304 => "would_serve",
        502 => "would_hand_back",
        500..=599 => "would_fail",
        // The prelude would answer without the handler: a redirect to HTTPS,
        // a refused body, a revoked session.
        _ => "would_answer",
    };
    if taken.reason.is_none() && outcome != "would_serve" {
        taken.reason = prelude_reason(&app, route, &req);
    }
    if taken.database_failed {
        lane.failures.fetch_add(1, Ordering::Relaxed);
    } else if taken.database.is_some() && taken.reason != Some("pool_busy") {
        lane.failures.store(0, Ordering::Relaxed);
    }
    let counters = &lane.counters;
    counters.observed.fetch_add(1, Ordering::Relaxed);
    match outcome {
        "would_serve" => &counters.would_serve,
        "would_hand_back" => &counters.would_hand_back,
        "would_fail" => &counters.would_fail,
        _ => &counters.would_answer,
    }
    .fetch_add(1, Ordering::Relaxed);
    Line {
        request_id: request_id(&req),
        outcome,
        status: Some(status),
        reason: taken.reason,
        queue: Some(queue),
        handler: Some(handler),
        database: taken.database,
        total: Some(total),
        zid: taken.zid,
        rows: taken.rows,
        selected: taken.selected,
        remaining: taken.remaining,
        total_count: taken.total,
        weights_tick: taken.weights_tick,
    }
    .print(&app, route);
}

/// A read lane's part of `GET /health` on the shadow listener. `enabled`
/// means serving participants, so it is always false here.
pub(crate) fn health(lane: &Lane) -> Js {
    let c = &lane.counters;
    let reachable = lane.reachable();
    let mut body = Obj::new();
    body.set("enabled", Js::Bool(false));
    body.set("mode", Js::Str(OBSERVE.into()));
    body.set("selector", Js::Str(lane.route.selector().into()));
    for (key, value) in [
        ("observed", &c.observed),
        ("wouldServe", &c.would_serve),
        ("wouldAnswer", &c.would_answer),
        ("wouldHandBack", &c.would_hand_back),
        ("wouldFail", &c.would_fail),
        ("shed", &c.shed),
    ] {
        body.set(key, Js::Num(value.load(Ordering::Relaxed) as f64));
    }
    body.set("inFlight", Js::Num(lane.in_flight() as f64));
    body.set("capacity", Js::Num(CAPACITY as f64));
    body.set("maxPerSecond", Js::Num(f64::from(lane.max_per_second)));
    let mut pools = Obj::new();
    for (name, pool) in &lane.pools {
        pools.set(name, pool.health(reachable));
    }
    body.set("pools", Js::Obj(pools));
    Js::Obj(body)
}

fn switched_on(route: Route) -> bool {
    std::env::var(route.switch()).ok().as_deref() == Some(OBSERVE)
}

fn rate(route: Route) -> Result<u32> {
    std::env::var(route.rate_setting())
        .ok()
        .and_then(|value| value.parse::<u32>().ok())
        .filter(|value| (1..=10_000).contains(value))
        .with_context(|| {
            format!(
                "{}={OBSERVE} requires {}, 1 to 10000",
                route.switch(),
                route.rate_setting()
            )
        })
}

fn required(name: &str, route: Route) -> Result<String> {
    std::env::var(name)
        .ok()
        .filter(|value| !value.is_empty())
        .with_context(|| format!("{}={OBSERVE} requires {name}", route.switch()))
}

/// The database the main role's read pools prefer when it is set.
fn replica_or(dsn: &str) -> String {
    std::env::var("READ_ONLY_DATABASE_URL")
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| dsn.to_owned())
}

/// Builds one lane on `app`: the pools the main role builds for the same
/// handler under `1`, with the same names and limits (read-only sessions, as
/// every pool of `db::Pool::new` is), put where the handler looks for them.
/// `connector` is asked for each pool's connections by the pool's name;
/// `replica` says the main role would read that pool from the replica when
/// one is configured.
pub(crate) fn install(
    app: &mut App,
    route: Route,
    max_per_second: u32,
    connector: impl Fn(&'static str, bool) -> Result<polis_queue_adapter::jobs::transport::Connector>,
) -> Result<()> {
    let pools = match route {
        Route::Votes => {
            let reads = db::Pool::new(
                connector("polis-api-votes-read/1", true)?,
                crate::votes_read::pool_limits(),
            );
            let auth = db::Pool::new(
                connector("polis-api-votes-read-auth/1", false)?,
                crate::votes_read::pool_limits(),
            );
            app.votes_read_db = Some(reads.clone());
            app.votes_read_auth_db = Some(auth.clone());
            vec![("reads", reads), ("auth", auth)]
        }
        Route::Comments => {
            let count = db::Pool::new(
                connector("polis-api-comment-count/1", true)?,
                crate::comments::count_pool_limits(),
            );
            let reads = db::Pool::new(
                connector("polis-api-comments/1", false)?,
                crate::comments::pool_limits(),
            );
            app.comments_count_db = Some(count.clone());
            app.comments_db = Some(reads.clone());
            vec![("reads", reads), ("count", count)]
        }
        Route::NextComment => {
            let reads = db::Pool::new(
                connector("polis-api-next-comment/1", false)?,
                crate::next_comment::pool_limits(),
            );
            app.next_comment_db = Some(reads.clone());
            vec![("reads", reads)]
        }
    };
    app.read_lanes.set(Lane::new(route, max_per_second, pools));
    Ok(())
}

/// Builds the read lanes the shadow role was asked for, each with what the
/// main role builds for the same handler under `1`: the same pools, the same
/// database settings and the same identity settings. A switch holding any
/// other value builds nothing, as before. No database work.
pub(crate) fn configure(app: &mut App) -> Result<()> {
    if !Route::ALL.into_iter().any(switched_on) {
        return Ok(());
    }
    for route in Route::ALL.into_iter().filter(|route| switched_on(*route)) {
        let max_per_second = rate(route)?;
        let dsn = required(
            match route {
                Route::Votes => "POLIS_API_VOTES_READ_DATABASE_URL",
                Route::Comments => "POLIS_API_COMMENTS_DATABASE_URL",
                Route::NextComment => "POLIS_API_NEXT_COMMENT_DATABASE_URL",
            },
            route,
        )?;
        install(app, route, max_per_second, |name, replica| {
            let dsn = if replica {
                replica_or(&dsn)
            } else {
                dsn.clone()
            };
            config::connector_for_dsn(&dsn, name)
        })?;
        match route {
            Route::Votes => {}
            Route::Comments => {
                let admins = std::env::var("ADMIN_UIDS")
                    .ok()
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| "[]".into());
                app.legacy_admin_uids = crate::recent_started::admin_uids(&admins)?;
            }
            // As the main role: ordinary selection only when the shared
            // setting says so; the initial-comment branch does not depend
            // on it.
            Route::NextComment => {
                app.next_comment_plain =
                    std::env::var("TOPICAL_COMMENT_RATIO").ok().as_deref() == Some("0");
            }
        }
    }
    // Signed-in accounts: the main role's setting, read the same way.
    app.read_oidc = crate::hybrid_read::Oidc::from_env()?;
    // Participant tokens: verified only when the participant-read switch says
    // observe too, as the main role verifies them only under `1`.
    if std::env::var("POLIS_API_PARTICIPANT_READS").ok().as_deref() == Some(OBSERVE) {
        let issuer = std::env::var("POLIS_JWT_ISSUER")
            .context("POLIS_API_PARTICIPANT_READS=observe requires POLIS_JWT_ISSUER")?;
        let audience = std::env::var("POLIS_JWT_AUDIENCE")
            .context("POLIS_API_PARTICIPANT_READS=observe requires POLIS_JWT_AUDIENCE")?;
        let key = match std::env::var("POLIS_API_PARTICIPANT_PUBLIC_KEY_FILE")
            .ok()
            .filter(|path| !path.is_empty())
        {
            Some(path) => Some(std::fs::read(path)?),
            None => None,
        };
        let verifier = match (key, app.participant_keys.as_ref()) {
            (Some(key), _) => polis_auth::participant::Verifier::new(&key, &issuer, &audience),
            (None, Some(keys)) => keys.verifier(&issuer, &audience),
            (None, None) => anyhow::bail!(
                "POLIS_API_PARTICIPANT_READS=observe requires the participant public key: POLIS_API_PARTICIPANT_PUBLIC_KEY_FILE, or the participant keys the process loads (JWT_PUBLIC_KEY or JWT_PUBLIC_KEY_PATH)"
            ),
        }
        .context("invalid participant verifier configuration")?;
        app.participant_verifier = Some(Arc::new(verifier));
    }
    Ok(())
}

/// Asks each built lane's database once, before the listener opens, and
/// prints what it found: which lanes this process observes, at what rate, and
/// whether each one's database answered. A lane whose database did not answer
/// is still served; `/health` reports it degraded until a copy reaches it.
pub(crate) async fn report_startup(app: &App) {
    for lane in app.read_lanes.built() {
        let reachable = lane.probe().await;
        event(
            "shadow_read_lane",
            &[
                ("shadow", Js::Str(lane.route.selector().into())),
                ("route", Js::Str(lane.route.name().into())),
                ("max_per_second", Js::Num(f64::from(lane.max_per_second))),
                ("capacity", Js::Num(CAPACITY as f64)),
                (
                    "database",
                    Js::Str(if reachable { "ok" } else { "failed" }.into()),
                ),
                (
                    "participant_tokens",
                    Js::Str(
                        if app.participant_verifier.is_some() {
                            "verified"
                        } else {
                            "off"
                        }
                        .into(),
                    ),
                ),
            ],
        );
    }
}

#[cfg(test)]
pub(crate) use tests::recorded;

#[cfg(test)]
#[path = "shadow_reads_tests.rs"]
mod read_tests;

#[cfg(test)]
pub(crate) mod tests {
    static LINES: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

    pub(crate) fn record_line(line: &str) {
        LINES
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(line.to_owned());
    }

    /// Every observation line the read lanes printed in this process.
    pub(crate) fn recorded() -> Vec<String> {
        LINES.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
}
