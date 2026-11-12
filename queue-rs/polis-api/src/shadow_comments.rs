//! The shadow listener's second route: copies of `POST /api/v3/comments`
//! (`X-Polis-Shadow: commentsShadow`), served only when the comment observer
//! is built (`POLIS_API_POST_COMMENTS=observe`).
//!
//! The route has a lane of its own, held by its observer: its own bound on
//! observations in admission at once, its own bound on observations waiting
//! for their read-back, and its own rate bucket. Nothing here takes a slot,
//! a token or a connection of the vote route's, and nothing of the vote
//! route's is taken here.
//!
//! One `shadow_observation` line is printed for each copy. It names no
//! conversation, comment, participant or user, and carries no text, no part
//! or hash of text, no vote value, token, address or header value: the
//! request id is its only join key. Every value on it is a number, a
//! boolean or a word from a closed set. What needs a row's number or the
//! text uses it in process (`post_comments_observe.rs`) and the line carries
//! the class it found.
//!
//! A copy's body is dropped as soon as its admission has ended. The parsed
//! text alone is kept, in the type that cannot be printed, until the
//! read-back of what Node stored has ended; at most `READBACK_WAITING`
//! observations wait at once.
#![deny(
    clippy::string_slice,
    clippy::indexing_slicing,
    clippy::unwrap_used,
    clippy::expect_used
)]
use super::{event, ms, no_content, num, request_id, text};
use crate::{
    http::{Outgoing, Request},
    js::{self, Js, Obj},
    post_comments::{
        self,
        observe::{AuthorVote, NodeComment, Observer, Stored, Subject, TextRow},
    },
    post_comments_text::{Compared, Length},
    route::{self, App},
};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

/// The route's selector name: what nginx's copies carry in `X-Polis-Shadow`.
pub(crate) const NAME: &str = "commentsShadow";
const ROUTE: &str = "POST /api/v3/comments";
/// Observations in admission at once.
pub(crate) const CAPACITY: usize = 8;
/// Observations waiting for their read-back at once (no connection is held).
pub(crate) const READBACK_WAITING: usize = 64;

/// What the comment handler reports about one copy, from inside
/// `route::serve`. In process only: the subject of the read-back is never
/// printed.
#[derive(Default)]
pub(crate) struct Record {
    /// Database time at the copy's arrival, set before admission runs.
    pub(crate) anchor: Option<i64>,
    pub(crate) reason: Option<&'static str>,
    pub(crate) admitted: bool,
    pub(crate) strict: Option<bool>,
    pub(crate) admission: Option<Duration>,
    pub(crate) text_row: Option<TextRow>,
    /// The would-be answer cannot be told: a text match with no anchor.
    pub(crate) unknown: bool,
    pub(crate) subject: Option<Subject>,
}

tokio::task_local! {
    static RECORD: Arc<Mutex<Record>>;
}

/// Reads or adds to the current copy's record. Outside an observation there
/// is no record: this does nothing and answers None.
pub(crate) fn record<T>(f: impl FnOnce(&mut Record) -> T) -> Option<T> {
    RECORD
        .try_with(|record| f(&mut record.lock().unwrap_or_else(|e| e.into_inner())))
        .ok()
}

#[derive(Default)]
struct Counters {
    observed: AtomicU64,
    would_serve: AtomicU64,
    would_answer: AtomicU64,
    would_hand_back: AtomicU64,
    would_fail: AtomicU64,
    unknown: AtomicU64,
    shed: AtomicU64,
    not_observed: AtomicU64,
    readback_own: AtomicU64,
    readback_other: AtomicU64,
    readback_absent: AtomicU64,
    text_different: AtomicU64,
    vote_same: AtomicU64,
    vote_ambiguous: AtomicU64,
    vote_different: AtomicU64,
    vote_absent: AtomicU64,
}

/// The comment route's own lane.
pub(crate) struct Lane {
    max_per_second: u32,
    bucket: Mutex<(f64, tokio::time::Instant)>,
    in_flight: Arc<tokio::sync::Semaphore>,
    readback: Arc<tokio::sync::Semaphore>,
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

    /// Holds every new observation at its start until the returned lock is
    /// released.
    #[cfg(test)]
    pub(crate) async fn park(&self) -> tokio::sync::RwLockWriteGuard<'_, ()> {
        self.park.write().await
    }
}

/// The copy's body size as one of four classes; the largest is past what
/// nginx copies (9,999 bytes).
fn body_class(bytes: usize) -> &'static str {
    match bytes {
        0..=1024 => "le_1k",
        1025..=4096 => "le_4k",
        4097..=9999 => "le_10k",
        _ => "over_10k",
    }
}

/// One `shadow_observation` line of the comment route. The keys and their
/// order are the line's contract (`LINE_KEYS` in the tests).
struct Line<'a> {
    request_id: Option<&'a str>,
    outcome: &'static str,
    admitted: bool,
    status: Option<u16>,
    reason: Option<&'static str>,
    queue: Option<Duration>,
    admission: Option<Duration>,
    total: Option<Duration>,
    readback_s: Option<f64>,
    strict: Option<bool>,
    facts: (bool, bool),
    body_class: &'static str,
    text_row: Option<TextRow>,
    stored: Stored,
}

impl<'a> Line<'a> {
    /// A copy that was not observed: shed by the lane, or refused by a
    /// process that holds a live handler.
    fn unobserved(
        req: &'a Request,
        outcome: &'static str,
        reason: &'static str,
        facts: (bool, bool),
    ) -> Self {
        Self {
            request_id: request_id(req),
            outcome,
            admitted: false,
            status: None,
            reason: Some(reason),
            queue: None,
            admission: None,
            total: None,
            readback_s: None,
            strict: None,
            facts,
            body_class: body_class(req.body.len()),
            text_row: None,
            stored: Stored::of(NodeComment::NotChecked),
        }
    }

    fn print(&self, app: &App) {
        let (vote_present, seed_present) = self.facts;
        let word = |value: Option<&'static str>| text(value);
        let flag = |value: Option<bool>| value.map(Js::Bool).unwrap_or(Js::Null);
        let (node_txt, difference, lengths) = match self.stored.text {
            None => (None, None, None),
            Some(Compared::Same) => (Some("same"), None, None),
            Some(Compared::Different {
                class,
                parsed,
                stored,
            }) => (
                Some("different"),
                Some(class.as_str()),
                Some((parsed, stored)),
            ),
        };
        let length = |pick: fn(&(Length, Length)) -> usize| {
            lengths
                .as_ref()
                .map(|lengths| Js::Num(pick(lengths) as f64))
                .unwrap_or(Js::Null)
        };
        let mut line = Obj::new();
        line.set("message", Js::Str("shadow_observation".into()));
        line.set("listener", Js::Str("shadow".into()));
        line.set("service", Js::Str("polis-api-shadow".into()));
        line.set("env", Js::Str(app.dd_env().into()));
        line.set("shadow", Js::Str(NAME.into()));
        line.set("route", Js::Str(ROUTE.into()));
        line.set("request_id", text(self.request_id));
        line.set("outcome", Js::Str(self.outcome.into()));
        line.set("admitted", Js::Num(if self.admitted { 1.0 } else { 0.0 }));
        line.set("status", num(self.status));
        line.set("reason", word(self.reason));
        line.set("queue_ms", ms(self.queue));
        line.set("admission_ms", ms(self.admission));
        line.set("total_ms", ms(self.total));
        line.set("readback_s", num(self.readback_s));
        line.set("strict", flag(self.strict));
        line.set("vote_present", Js::Bool(vote_present));
        line.set("seed_present", Js::Bool(seed_present));
        line.set("body_class", Js::Str(self.body_class.into()));
        line.set("write", Js::Str("not_modelled".into()));
        line.set("text_row", word(self.text_row.map(TextRow::as_str)));
        line.set("node_comment", Js::Str(self.stored.comment.as_str().into()));
        line.set("node_txt", word(node_txt));
        line.set("node_txt_difference", word(difference));
        line.set("txt_units", length(|(parsed, _)| parsed.units));
        line.set("node_txt_units", length(|(_, stored)| stored.units));
        line.set("txt_bytes", length(|(parsed, _)| parsed.bytes));
        line.set("node_txt_bytes", length(|(_, stored)| stored.bytes));
        line.set(
            "node_author",
            word(
                self.stored
                    .author
                    .map(|same| if same { "same" } else { "different" }),
            ),
        );
        line.set("node_row", word(self.stored.row));
        line.set(
            "node_lang",
            word(
                self.stored
                    .lang
                    .map(|set| if set { "set" } else { "unset" }),
            ),
        );
        line.set("node_vote", Js::Str(self.stored.vote.as_str().into()));
        print(js::stringify(&Js::Obj(line)));
    }
}

fn print(line: String) {
    #[cfg(test)]
    tests::record_line(&line);
    println!("{line}");
}

enum Decision {
    Observe(tokio::sync::OwnedSemaphorePermit),
    Shed(&'static str),
    NotObserved,
}

/// A copy of a comment, at the shadow listener: answered 204 at once, before
/// any database work, whatever becomes of it.
pub(crate) async fn accept(app: Arc<App>, req: Request) -> Outgoing {
    let Some(observer) = app.post_comments_observe.as_ref() else {
        return super::not_found();
    };
    let lane = observer.lane.clone();
    let received = tokio::time::Instant::now();
    // A copy is never dispatched to a live handler; none exists in this role,
    // and a process holding one is not observed at all.
    let decision = if app.post_comments.is_some() {
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
    match decision {
        Decision::Observe(permit) => {
            tokio::spawn(observe(app, req, received, permit));
        }
        Decision::Shed(reason) => {
            lane.counters.shed.fetch_add(1, Ordering::Relaxed);
            Line::unobserved(&req, "shed", reason, post_comments::copy_facts(&req)).print(&app);
        }
        Decision::NotObserved => {
            lane.counters.not_observed.fetch_add(1, Ordering::Relaxed);
            Line::unobserved(
                &req,
                "not_observed",
                "unconfigured",
                post_comments::copy_facts(&req),
            )
            .print(&app);
        }
    }
    no_content()
}

/// One observation, after its 204 has been returned.
async fn observe(
    app: Arc<App>,
    req: Request,
    received: tokio::time::Instant,
    permit: tokio::sync::OwnedSemaphorePermit,
) {
    let Some(observer) = app.post_comments_observe.as_ref() else {
        return;
    };
    let lane = &observer.lane;
    #[cfg(test)]
    drop(lane.park.read().await);
    let anchor = observer.anchor().await;
    let queue = received.elapsed();
    let record = Arc::new(Mutex::new(Record {
        anchor,
        ..Record::default()
    }));
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
    // The lane slot covers admission only.
    drop(permit);
    let mut taken = std::mem::take(&mut *record.lock().unwrap_or_else(|e| e.into_inner()));
    let (outcome, status) = if taken.unknown {
        taken.reason = Some("no_anchor");
        ("unknown", None)
    } else {
        (
            match out.status {
                // The live handler would dispatch the write.
                200 => "would_serve",
                502 => "would_hand_back",
                500..=599 => "would_fail",
                // It would answer without writing: 409, 403.
                _ => "would_answer",
            },
            Some(out.status),
        )
    };
    if taken.reason.is_none() && out.status != 200 {
        taken.reason = post_comments::shape_reason(&app, &req);
    }
    // What the line needs of the request, and then the copy's body is gone:
    // only the parsed text is kept for the read-back.
    let request_id = request_id(&req).map(str::to_owned);
    let facts = post_comments::copy_facts(&req);
    let body_class = body_class(req.body.len());
    drop(req);
    let mut stored = Stored::of(NodeComment::NotChecked);
    let mut readback_s = None;
    if let Some(subject) = taken.subject.take() {
        match anchor {
            // Without the anchor a row could not be told from an earlier
            // one, so none is looked for.
            None => stored = Stored::of(NodeComment::Unknown),
            Some(anchor) => {
                if let Ok(slot) = lane.readback.clone().try_acquire_owned() {
                    (stored, readback_s) = observer.read_back(&subject, anchor, received).await;
                    drop(slot);
                }
            }
        }
    }
    let counters = &lane.counters;
    counters.observed.fetch_add(1, Ordering::Relaxed);
    match outcome {
        "would_serve" => &counters.would_serve,
        "would_hand_back" => &counters.would_hand_back,
        "would_fail" => &counters.would_fail,
        "unknown" => &counters.unknown,
        _ => &counters.would_answer,
    }
    .fetch_add(1, Ordering::Relaxed);
    match stored.comment {
        NodeComment::Own => Some(&counters.readback_own),
        NodeComment::Other => Some(&counters.readback_other),
        NodeComment::Absent => Some(&counters.readback_absent),
        NodeComment::Unknown | NodeComment::Unavailable | NodeComment::NotChecked => None,
    }
    .map(|counter| counter.fetch_add(1, Ordering::Relaxed));
    if matches!(stored.text, Some(Compared::Different { .. })) {
        counters.text_different.fetch_add(1, Ordering::Relaxed);
    }
    match stored.vote {
        AuthorVote::Same => Some(&counters.vote_same),
        AuthorVote::Ambiguous => Some(&counters.vote_ambiguous),
        AuthorVote::Different => Some(&counters.vote_different),
        AuthorVote::Absent => Some(&counters.vote_absent),
        AuthorVote::NotSent | AuthorVote::Unavailable | AuthorVote::NotChecked => None,
    }
    .map(|counter| counter.fetch_add(1, Ordering::Relaxed));
    Line {
        request_id: request_id.as_deref(),
        outcome,
        admitted: taken.admitted,
        status,
        reason: taken.reason,
        queue: Some(queue),
        admission: taken.admission,
        total: Some(total),
        readback_s,
        strict: taken.strict,
        facts,
        body_class,
        text_row: taken.text_row,
        stored,
    }
    .print(&app);
}

/// The comment observer's part of `GET /health` on the shadow listener.
/// `enabled` means serving participants, so it is always false here.
pub(crate) fn health(observer: &Observer, reachable: bool) -> Js {
    let lane = &observer.lane;
    let c = &lane.counters;
    let mut body = Obj::new();
    body.set("enabled", Js::Bool(false));
    body.set("mode", Js::Str("observe".into()));
    for (key, value) in [
        ("observed", &c.observed),
        ("wouldServe", &c.would_serve),
        ("wouldAnswer", &c.would_answer),
        ("wouldHandBack", &c.would_hand_back),
        ("wouldFail", &c.would_fail),
        ("unknown", &c.unknown),
        ("shed", &c.shed),
        ("notObserved", &c.not_observed),
        ("readbackOwn", &c.readback_own),
        ("readbackOther", &c.readback_other),
        ("readbackAbsent", &c.readback_absent),
        ("textDifferent", &c.text_different),
        ("voteSame", &c.vote_same),
        ("voteAmbiguous", &c.vote_ambiguous),
        ("voteDifferent", &c.vote_different),
        ("voteAbsent", &c.vote_absent),
    ] {
        body.set(key, Js::Num(value.load(Ordering::Relaxed) as f64));
    }
    body.set("inFlight", Js::Num(lane.in_flight() as f64));
    body.set("capacity", Js::Num(CAPACITY as f64));
    body.set("maxPerSecond", Js::Num(f64::from(lane.max_per_second)));
    body.set("readbackWaiting", Js::Num(lane.readback_waiting() as f64));
    body.set("readbackCapacity", Js::Num(READBACK_WAITING as f64));
    body.set("pools", observer.pools_health(reachable));
    Js::Obj(body)
}

/// Prints, once at startup, the server's settings that decide whether a
/// statement's parameters can reach its log. The observer sends a comment's
/// text as a parameter, as Node does.
pub(crate) async fn report_logging_settings(observer: &Observer) {
    let settings = observer.logging_settings().await;
    let mut fields = vec![(
        "read".to_owned(),
        Js::Str(if settings.is_some() { "ok" } else { "failed" }.into()),
    )];
    for (name, setting) in settings.unwrap_or_default() {
        fields.push((name, Js::Str(setting)));
    }
    let fields: Vec<(&str, Js)> = fields
        .iter()
        .map(|(name, value)| (name.as_str(), value.clone()))
        .collect();
    event("shadow_post_comments_database_logging", &fields);
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

    /// Every observation line the comment route printed in this process.
    pub(crate) fn recorded() -> Vec<String> {
        LINES.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
}
