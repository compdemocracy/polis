//! `GET /api/v3/delphi/topicMap?report_id=<id>[&job_id=<id>][&source=served|shadow][&selection=<rule>]`:
//! a report's topic map (`polis-topic-map/1`, [`contract`]), read as the run
//! stored it. A run that makes a map stores the document, its gzip and its
//! SHA-256 as the parts of one result family ([`contract::FAMILY`]); this
//! route finds the run, reads the one part the client needs and sends its
//! bytes as they are, with the stored SHA-256 as the ETag. It never builds
//! a map: the work is the run's, done once on the Delphi box. The one
//! rewrite is the reader's form below, for a map that holds comments
//! moderated out now. No comment text.
//!
//! Which run: without `job_id`, the run the conversation's results are served
//! from, in the publication scope of the comment rule asked for
//! ([`contract::Selection::scope`]; what participants are shown when none is
//! named); with `job_id`, that run, whichever rule it ran under. In the served
//! env for `source=served`, the shadow's for `source=shadow`, and without
//! `source` the served env first and the shadow's when the served one has
//! nothing stored for the query ([`nothing_stored`]). The scope
//! is always named, so two rules' runs are never read as one. A map is one
//! run's: its parts are read from one stored family of one batch, never
//! put together from two, and it is read from the run's own batch only (a
//! read that walks a publication's earlier batches can meet an earlier run's
//! map), each row naming the run's job. The run read, its scope and its
//! comment rule are in the answer's headers.
//!
//! Who: anyone who holds the report id, for every query, as for the report's
//! other Delphi reads. What they receive depends on who they are and on the
//! comments' moderation now, not when the run was made:
//!
//! - The conversation's moderators and the site administrators (a bearer
//!   token that verifies, read on the route's one-slot identity pool,
//!   [`auth_pool_limits`]) receive the map as the run stored it, marked
//!   `Cache-Control: private, no-store` and `Vary: Authorization,
//!   Accept-Encoding`.
//! - Every other reader, signed in or not, receives each comment that is held
//!   back now ([`held_back`]: moderated out, `comments.mod = -1`; inactive,
//!   `active = false`; or muted, `velocity <= 0`) as a bare point
//!   ([`public_form`]): its position, no id, no topic, and the count of such
//!   points in `points.moderatedOut`. A topic left with no member this
//!   reader may see is not sent; a topic with a held-back member is sent
//!   with the neutral name `Topic <cluster>` and its label placed over its
//!   visible members only; the labels' colours are chosen again from what
//!   is sent. A map that holds no held-back comment is sent as stored, byte
//!   for byte. A comment not yet moderated (`mod = 0`, under strict
//!   moderation too) is not held back. The held-back comments are read on
//!   the route's own read pool, in the same connection as the map, one
//!   indexed statement, when the request starts: a moderation committed
//!   while a read is under way reaches the next request.
//! - The ETag says which form was sent: the stored SHA-256 for the stored
//!   form, and for a reader's form while the conversation has any held-back
//!   comment, a digest of the stored SHA-256 and of a keyed digest of the
//!   held-back ids ([`reader_form`]), keyed by a secret this process draws
//!   at start. It prevents offline enumeration of held-back ids; repeated
//!   tags still reveal set equality within a process. A held-back set change
//!   is a new ETag; and a
//!   stored form's ETag never answers 304 to a reader who must receive the
//!   other.
//!
//! The participation path (votes, comments, the next comment) shares no
//! connection pool and no request place with this route. Before anything is
//! read a request takes one of
//! [`MAX_IN_FLIGHT`] places; with none free it is answered 503 at once. It
//! reads on its own pool ([`pool_limits`]), never a participation pool, holds a connection
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
use contract::{List, NoMap, NoMapReason, Refused, Selection, Source, StoredNoMap};

/// Identity and the moderator rule, for a request with a bearer token only:
/// indexed single-row reads.
pub fn auth_pool_limits() -> crate::db::Limits {
    crate::db::Limits {
        size: 1,
        acquire_timeout: Duration::from_millis(50),
        statement_timeout: Duration::from_millis(100),
        max_lifetime: Duration::from_secs(300),
    }
}

/// The name of the reader's form in its ETag ([`reader_tag`]): a change to
/// [`public_form`] changes it, so no client keeps an older form.
pub const READER_FORM: &str = "held-back/2";

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

/// Read once at startup, only when the topic map handler is enabled.
pub fn derived_reads_from_env() -> bool {
    std::env::var("POLIS_API_DELPHI_TOPIC_MAP_DERIVED_READS")
        .ok()
        .as_deref()
        == Some("1")
}

/// The result envs the route reads, from the deployment's settings.
#[derive(Debug)]
pub struct Envs {
    /// The served Delphi's env, when its results are in Postgres
    /// (`DELPHI_RESULT_BACKEND=postgres`). `None` when they are in DynamoDB:
    /// the served side then has nothing stored and is never read.
    pub served: Option<String>,
    /// The shadow's env (`POLIS_API_DELPHI_TOPIC_MAP_SHADOW_ENV`).
    pub shadow: Option<String>,
}

impl Envs {
    /// From `DELPHI_RESULT_BACKEND`, `DELPHI_RESULT_ENV` and
    /// `POLIS_API_DELPHI_TOPIC_MAP_SHADOW_ENV`. The backend is read as Node
    /// and the Delphi service read it: unset or empty is DynamoDB, and any
    /// value other than `postgres` and `dynamodb` refuses rather than guess.
    pub fn from_settings(
        backend: Option<&str>,
        served: Option<&str>,
        shadow: Option<&str>,
    ) -> anyhow::Result<Self> {
        let named = |s: Option<&str>| s.filter(|s| !s.is_empty()).map(str::to_owned);
        let served = match backend.unwrap_or_default() {
            "postgres" => Some(named(served).ok_or_else(|| {
                anyhow::anyhow!("DELPHI_RESULT_ENV is required for report topic map reads")
            })?),
            "" | "dynamodb" => None,
            _ => anyhow::bail!(
                "the report topic map reads DELPHI_RESULT_BACKEND as postgres, dynamodb or unset, and refuses any other value"
            ),
        };
        let shadow = named(shadow);
        match &shadow {
            Some(shadow) => anyhow::ensure!(
                shadow.starts_with(SHADOW_PREFIX) && Some(shadow) != served.as_ref(),
                "POLIS_API_DELPHI_TOPIC_MAP_SHADOW_ENV must be a shadow- env other than DELPHI_RESULT_ENV"
            ),
            None => anyhow::ensure!(
                served.is_some(),
                "the report topic map needs the served Delphi's results in Postgres (DELPHI_RESULT_BACKEND=postgres and DELPHI_RESULT_ENV) or the shadow's (POLIS_API_DELPHI_TOPIC_MAP_SHADOW_ENV, a shadow- env), and has neither"
            ),
        }
        Ok(Self { served, shadow })
    }
}
/// Stored families whose verdict a process keeps.
const VERDICTS: usize = 4096;
/// Readers' forms being made at once in the process ([`reader_body`]). The
/// service runs with half a CPU on a web box of two: one rewrite at a time
/// can take at most one CPU, and [`REWRITE_SHARE`] bounds that over time.
pub const MAX_REWRITES: usize = 1;
/// Time the rewrites may take in the process, per second of time: a tenth of
/// a second, a fifth of the service's half CPU. It is wall time of the
/// rewrite, at least its CPU time. A rewrite is charged before it starts
/// (its estimated time, [`REWRITE_ESTIMATE`]) and settled when it ends (what
/// it took), so rewrites arriving together cannot start on the same credit:
/// from any moment, the rewrite time spent by a later moment `t` seconds on
/// is at most the larger of [`REWRITE_BURST`] and the costliest single
/// estimate, plus `t` times this share, plus whatever the rewrites took
/// beyond their estimates. The estimate is charged in full: a rewrite
/// costlier than the burst starts from a full bank and leaves the budget
/// owing the rest. A rewrite is not interrupted: a rewrite slower than its
/// estimate runs to its end, and the next waits until the difference is
/// repaid.
pub const REWRITE_SHARE: Duration = Duration::from_millis(100);
/// Rewrite time a quiet process may bank, and so spend at once. A rewrite
/// whose estimate is larger waits for a full bank and is charged its whole
/// estimate, the budget owing the rest.
pub const REWRITE_BURST: Duration = Duration::from_millis(200);
/// A rewrite's estimate before the process has timed one, in seconds per
/// byte of the stored part: a part at the stored-row bound is charged the
/// whole burst. Once the process has timed rewrites, the estimate is the
/// slowest seconds per byte it has seen of that encoding, times
/// [`REWRITE_HEADROOM`].
pub const REWRITE_ESTIMATE: f64 = 0.2 / MAX_PART_BYTES as f64;
/// The margin on the slowest rate seen.
pub const REWRITE_HEADROOM: f64 = 1.5;
/// Readers' forms a process keeps, least recently used out first: at most
/// this many, so a lookup reads a short list...
pub const READER_FORMS_KEPT: usize = 64;
/// ...and at most this many bytes of them (the form and its gzip): 32 MiB,
/// a sixteenth of the service's 512 MiB, about forty forms of a map of 9,000
/// comments (641 KB, and its gzip).
pub const READER_FORM_BYTES_KEPT: usize = 32 * 1024 * 1024;
/// Held-back comments a reader's form is made for. A conversation that holds
/// back more is refused to readers who are not moderators (422 `too_large`,
/// as a map too large to send): the read stops one past it.
pub const MAX_HELD_BACK: usize = 25_000;

/// Two slots, one statement each: the run record walks the job's publication
/// history, so the statement timeout is the typed result read's. The
/// moderated-out comments are read here too, before the map, on the same
/// connection.
pub fn pool_limits() -> crate::db::Limits {
    crate::db::Limits {
        size: 2,
        acquire_timeout: Duration::from_millis(50),
        statement_timeout: Duration::from_millis(2000),
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
    /// The key of the readers' validators ([`reader_form`]), drawn when the
    /// process starts and never written anywhere.
    validator_key: [u8; 32],
    /// The rewrites' places ([`MAX_REWRITES`]) and their time budget
    /// ([`REWRITE_SHARE`]): seconds banked, and when last counted.
    rewriting: Arc<Semaphore>,
    rewriting_now: AtomicUsize,
    max_rewriting: AtomicUsize,
    rewrites: AtomicU64,
    budget: std::sync::Mutex<Budget>,
    /// Readers' forms kept, and those being made.
    forms: std::sync::Mutex<Forms>,
    forms_reused: AtomicU64,
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
            validator_key: rand::random(),
            rewriting: Arc::new(Semaphore::new(MAX_REWRITES)),
            rewriting_now: AtomicUsize::new(0),
            max_rewriting: AtomicUsize::new(0),
            rewrites: AtomicU64::new(0),
            budget: std::sync::Mutex::new(Budget::new()),
            forms: std::sync::Mutex::new(Forms::default()),
            forms_reused: AtomicU64::new(0),
            #[cfg(all(test, feature = "db-tests"))]
            reads_held: (std::sync::Mutex::new(false), std::sync::Condvar::new()),
        }))
    }
    /// The key of this process's readers' validators.
    pub(crate) fn validator_key(&self) -> &[u8; 32] {
        &self.0.validator_key
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
    /// Maps sent (200), since start.
    #[cfg(all(test, feature = "db-tests"))]
    pub(crate) fn sent(&self) -> u64 {
        self.0.sent.load(Ordering::Relaxed)
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
        body.set("rewrites", num(self.rewrites() as f64));
        body.set("maxRewriting", num(self.max_rewriting() as f64));
        body.set(
            "formsReused",
            num(self.0.forms_reused.load(Ordering::Relaxed) as f64),
        );
        let (kept, kept_bytes) = self.kept();
        body.set("formsKept", num(kept as f64));
        body.set("formBytesKept", num(kept_bytes as f64));
        crate::js::Js::Obj(body)
    }
    /// Readers' forms made since start.
    pub(crate) fn rewrites(&self) -> u64 {
        self.0.rewrites.load(Ordering::Relaxed)
    }
    /// Readers' forms being made at most at once, since start.
    pub(crate) fn max_rewriting(&self) -> usize {
        self.0.max_rewriting.load(Ordering::SeqCst)
    }
    /// Readers' forms kept now, and their bytes.
    pub(crate) fn kept(&self) -> (usize, usize) {
        let forms = self.forms();
        (forms.kept.len(), forms.bytes)
    }
    fn forms(&self) -> std::sync::MutexGuard<'_, Forms> {
        self.0.forms.lock().unwrap_or_else(|e| e.into_inner())
    }
    fn budget(&self) -> std::sync::MutexGuard<'_, Budget> {
        self.0.budget.lock().unwrap_or_else(|e| e.into_inner())
    }
    /// How long until the rewrites' budget is out of debt, after counting
    /// the time banked since it was last counted.
    #[cfg(test)]
    fn budget_wait(&self) -> Duration {
        self.spend(Duration::ZERO)
    }
    /// Takes `took` from the rewrites' budget; returns the wait as
    /// [`State::budget_wait`].
    #[cfg(test)]
    fn spend(&self, took: Duration) -> Duration {
        let mut b = self.budget();
        b.refill();
        b.balance -= took.as_secs_f64();
        if b.balance >= 0.0 {
            Duration::ZERO
        } else {
            Duration::from_secs_f64(-b.balance / REWRITE_SHARE.as_secs_f64())
        }
    }
    /// Charges the estimate of a rewrite of a stored part of `len` bytes
    /// before it starts: the seconds charged, or how long until the budget
    /// holds them (nothing is charged then).
    ///
    /// The estimate is charged in full. One costlier than the burst starts
    /// only from a full bank and leaves the budget owing the difference, so
    /// the next rewrite waits until that is repaid: a costly map is charged
    /// what it is expected to take, never only the burst.
    fn reserve(&self, len: usize, gzip: bool) -> Result<f64, Duration> {
        let mut b = self.budget();
        b.refill();
        let cost = b.estimate(len, gzip);
        let needed = cost.min(REWRITE_BURST.as_secs_f64());
        if b.balance >= needed {
            b.balance -= cost;
            b.largest = b.largest.max(cost);
            Ok(cost)
        } else {
            Err(Duration::from_secs_f64(
                (needed - b.balance) / REWRITE_SHARE.as_secs_f64(),
            ))
        }
    }
    /// Settles a rewrite charged `reserved` that took `took`: the difference
    /// is repaid or owed, the rate it ran at is learned.
    fn settle(&self, reserved: f64, took: Duration, len: usize, gzip: bool) {
        let mut b = self.budget();
        b.refill();
        let took = took.as_secs_f64();
        b.balance += reserved - took;
        b.charged += took;
        if took > reserved {
            b.overrun += took - reserved;
        }
        let rate = &mut b.rate[gzip as usize];
        *rate = Some(rate.unwrap_or(0.0).max(took / len.max(1) as f64));
    }
    /// Rewrite time taken since start, and of it the part beyond what was
    /// charged before each rewrite started, in seconds.
    #[cfg(test)]
    pub(crate) fn rewrite_time(&self) -> (f64, f64) {
        let b = self.budget();
        (b.charged, b.overrun)
    }
    /// The rewrites' bound over a window of `window` seconds, as charged so
    /// far: the larger of the burst and the largest estimate charged, plus
    /// the share of the window ([`REWRITE_SHARE`]), plus what the rewrites
    /// took beyond their charges.
    #[cfg(test)]
    pub(crate) fn rewrite_bound(&self, window: f64) -> f64 {
        let b = self.budget();
        REWRITE_BURST.as_secs_f64().max(b.largest)
            + REWRITE_SHARE.as_secs_f64() * window
            + b.overrun
    }
    /// Keep at most `forms` readers' forms and `bytes` of them from now on,
    /// for a test that needs forms let go with fewer maps than the
    /// process's own bounds take.
    #[cfg(all(test, feature = "db-tests"))]
    pub(crate) fn keep_at_most(&self, forms: usize, bytes: usize) {
        self.forms().bounds = Some((forms, bytes));
    }
    /// Readers' forms let go to keep within the bounds, since start.
    #[cfg(all(test, feature = "db-tests"))]
    pub(crate) fn forms_evicted(&self) -> u64 {
        self.forms().evicted
    }
    /// A kept form for `key`, the rewrite in progress for it, or this
    /// request's own rewrite to make: decided under one lock, so a form is
    /// made once however many ask for it at once.
    fn role(&self, key: &FormKey) -> Role {
        let mut forms = self.forms();
        if let Some(entry) = forms
            .kept
            .iter()
            .position(|(k, _)| k == key)
            .and_then(|i| forms.kept.remove(i))
        {
            let kept = entry.1.clone();
            forms.kept.push_back(entry);
            self.0.forms_reused.fetch_add(1, Ordering::Relaxed);
            return Role::Kept(kept);
        }
        if let Some(flight) = forms.flights.get(key) {
            return Role::Follow(flight.clone());
        }
        let (tx, rx) = tokio::sync::watch::channel(None);
        forms.flights.insert(key.clone(), rx);
        Role::Lead(Flying {
            state: self.clone(),
            key: key.clone(),
            tx: Some(tx),
        })
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
    /// A `source`, `selection` or `list` value this route does not know: 400.
    bad: Option<&'static str>,
    /// Only to tell a moderator: the answer to anyone else is the same.
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
        if !matches!(
            k.as_ref(),
            "report_id" | "job_id" | "source" | "selection" | "list"
        ) || !seen.insert(k.clone())
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
                Some(source) => request.source = Some(source),
                None => bad = bad.or(Some("source")),
            },
            "list" => match List::parse(&v) {
                Some(list) => request.list = Some(list),
                None => bad = bad.or(Some("list")),
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
    /// The derived job that made the map, when the run stored none.
    made_by: Option<String>,
    source: Source,
    /// The publication scope the run was read from: the one asked for, or
    /// for a named run the one its map was published in, if any.
    scope: Option<String>,
    /// The run's comment rule as its configuration names it.
    selection: Option<String>,
    etag: String,
    gzip: bool,
    /// `None`: the client's ETag is this reader's (304).
    body: Option<(Vec<u8>, Held)>,
    /// Sent to a moderator: the full map, never stored by a cache.
    privileged: bool,
}

enum Answer {
    Refused(Refused),
    NoMap(NoMap),
    Jobs(contract::JobList),
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
        Ok(Some(Answer::Jobs(body))) => json(req, res, 200, &body, false),
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
    if let Some(by) = map.made_by {
        res.set(contract::HEADER_MADE_BY, by);
    }
    if map.privileged {
        res.set("Cache-Control", "private, no-store");
    }
    if let Some(scope) = map.scope {
        res.set(contract::HEADER_SCOPE, scope);
    }
    if let Some(selection) = map.selection {
        res.set(contract::HEADER_SELECTION, selection);
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

/// [`failure`], decided inside the connection's closure: the pool reports
/// any error of its closure as the database being unavailable, as text, so
/// a statement this login may not run (SQLSTATE class 42, such as a missing
/// `SELECT` grant on `comments`) or a stored value the database cannot read
/// (class 22) is told apart here, while its error is still typed. Such a
/// failure is a 500 that names nothing; every other is `Err`, the route
/// shedding (503).
fn classified<T>(r: anyhow::Result<T>) -> anyhow::Result<Result<T, Refused>> {
    match r {
        Ok(v) => Ok(Ok(v)),
        Err(e) => match failure(&e) {
            Refused::Unreadable => Ok(Err(Refused::Unreadable)),
            _ => Err(e),
        },
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
    let authorization = parsed.authorization;
    let q = parsed.request;
    let Some(report) = q.report_id.clone() else {
        return refused(Refused::MissingReport);
    };
    // A stored run has its own comment rule.
    if q.job_id.is_some() && q.selection.is_some() {
        return refused(Refused::BadParameter("selection"));
    }
    // A list names runs; a run is read by itself.
    if q.list.is_some() && q.job_id.is_some() {
        return refused(Refused::BadParameter("list"));
    }
    let sides = match sides(app, q.source) {
        Ok(sides) => sides,
        Err(r) => return refused(r),
    };
    let selection_asked = q.selection.unwrap_or_default();
    let pool = app.delphi_topic_map_db.as_ref()?;
    let rid = report.clone();
    let first = place.clone();
    let zid = match pool
        .with(move |c| {
            let _place = first;
            // As getZidFromReport: no row, a null and a zero name no conversation.
            classified((|| {
                Ok(c.query_opt(
                    "SELECT zid FROM reports WHERE report_id=$1 LIMIT 1",
                    &[&rid],
                )?
                .map(|r| r.try_get::<_, Option<i32>>(0))
                .transpose()?
                .flatten()
                .filter(|z| *z != 0))
            })())
        })
        .await
    {
        Ok(Ok(Some(zid))) => zid,
        Ok(Ok(None)) => return refused(Refused::UnknownReport(report)),
        Ok(Err(r)) => return refused(r),
        Err(e) => return refused(failure(&e)),
    };
    // The list is read from the run records alone: the same for every
    // reader, so no identity is read for it.
    if q.list.is_some() {
        let asked = q.selection;
        let listing = place.clone();
        let derived = app.delphi_topic_map_derived;
        // A side with no env lists no run, as an env with none stored.
        let sides: Vec<(Source, String, String)> = sides
            .into_iter()
            .filter_map(|s| s.env.map(|env| (s.source, env, s.base)))
            .collect();
        return Some(
            match pool
                .with(move |c| {
                    let _place = listing;
                    classified(list_jobs(c, zid, &sides, asked, derived))
                })
                .await
            {
                Ok(Ok(jobs)) => Answer::Jobs(contract::JobList {
                    report_id: report,
                    jobs,
                }),
                Ok(Err(r)) => Answer::Refused(r),
                Err(e) => Answer::Refused(failure(&e)),
            },
        );
    }
    // A moderator receives the full map; anyone else, whatever their token
    // says, the reader's form.
    let moderator = match authorization.as_deref() {
        None => false,
        Some(raw) => match moderates(app, raw, zid).await? {
            Ok(moderator) => moderator,
            Err(r) => return refused(r),
        },
    };
    let job = match q.job_id {
        // Job ids are lowercase canonical uuids; any other spelling names no run.
        Some(job) => match JobId::new(job) {
            Ok(job) => Some(job.as_str().to_owned()),
            Err(_) => return refused(Refused::JobNotFound),
        },
        None => None,
    };
    let named_run = job.is_some();
    // A side with no env is never asked: it has nothing stored.
    let asks: Vec<(Source, String, Option<Ask>)> = sides
        .into_iter()
        .map(|Side { source, env, base }| {
            let scope = selection_asked.scope(&base);
            let ask = env.map(|env| Ask {
                env,
                scope: scope.clone(),
                zid,
                job: job.clone(),
                gzip,
                tags: tags.clone(),
                form: String::new(),
                derived: app.delphi_topic_map_derived,
            });
            (source, scope, ask)
        })
        .collect();
    let state = app.delphi_topic_map.clone();
    let reading = place.clone();
    // Every side on one connection, one after the other: the first side with
    // something stored answers; when none has, the first side's answer.
    let read = pool
        .with(move |c| {
            let _place = reading;
            classified((|| {
                // What is held back now, before the map: one indexed read.
                // More than a reader's form is made for: no map.
                let hidden = if moderator {
                    Vec::new()
                } else {
                    match held_back(c, zid)? {
                        Some(hidden) => hidden,
                        None => return Ok(None),
                    }
                };
                let form = reader_form(state.validator_key(), zid, &hidden);
                let mut first = None;
                for (source, scope, ask) in asks {
                    let read = match ask {
                        Some(mut ask) => {
                            ask.form = form.clone();
                            read(c, ask, &state)?
                        }
                        None => unread(named_run),
                    };
                    if !nothing_stored(&read.found) {
                        return Ok(Some((read, source, scope, hidden, form)));
                    }
                    first.get_or_insert((read, source, scope));
                }
                let (read, source, scope) =
                    first.ok_or_else(|| anyhow::anyhow!("no side to read"))?;
                Ok(Some((read, source, scope, hidden, form)))
            })())
        })
        .await;
    let (
        Read {
            found,
            selection,
            made_by,
        },
        source,
        scope,
        hidden,
        form,
    ) = match read {
        Ok(Ok(Some(read))) => read,
        Ok(Ok(None)) => return refused(Refused::TooLarge),
        Ok(Err(r)) => return refused(r),
        Err(e) => return refused(failure(&e)),
    };
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
        Found::NoMap { job, reason } => Answer::NoMap(NoMap {
            map_job_id: made_by,
            ..NoMap::new(report, job, source, (!named_run).then_some(scope), reason)
        }),
        Found::Unverified(_) => Answer::Refused(Refused::Unreadable),
        Found::Map {
            job,
            scope,
            sha,
            body,
        } => {
            // A reader who may not see what is moderated out receives it as
            // bare points; a map holding none of it is sent as stored.
            let body = match body {
                Some((bytes, held)) if !hidden.is_empty() => {
                    let key = (sha.clone(), form.clone());
                    let state = &app.delphi_topic_map;
                    match reader_body(state, key, bytes, held, hidden, gzip, place).await {
                        Ok(body) => Some(body),
                        Err(r) => return refused(r),
                    }
                }
                body => body,
            };
            Answer::Map(Box::new(Map {
                job,
                made_by,
                source,
                scope,
                selection,
                etag: format!("W/\"{}\"", reader_tag(&sha, &form)),
                gzip,
                body,
                privileged: moderator,
            }))
        }
    })
}

/// Whether the bearer of `authorization` moderates the conversation or
/// administers the site, as the moderation list decides it (`isModerator`:
/// the owner, a user of the owner's site, a site administrator). A header
/// that is not a bearer token, or a token that does not verify, is a reader
/// like any other; the identity database not answering sheds the request.
/// `None` hands back.
async fn moderates(app: &App, authorization: &str, zid: i32) -> Option<Result<bool, Refused>> {
    if !authorization.starts_with("Bearer ") {
        return Some(Ok(false));
    }
    let auth_pool = app.delphi_topic_map_auth_db.as_ref()?;
    let uid = match crate::hybrid_read::resolve_or_unavailable(
        Some(authorization),
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
        return Some(Ok(false));
    };
    let admins = app.legacy_admin_uids.clone();
    if admins.contains(&uid.0) {
        return Some(Ok(true));
    }
    match auth_pool
        .with(move |c| crate::treevite_read::permits(c, zid, uid, &admins))
        .await
    {
        Ok(moderator) => Some(Ok(moderator)),
        Err(_) => Some(Err(Refused::Busy)),
    }
}

/// The ids of the conversation's comments held back from a reader who is not
/// a moderator, in order: moderated out (`mod = -1`, the moderation list's
/// `polisTypes.mod.ban`), inactive (`active = false`) or muted
/// (`velocity <= 0`), the states Node's participant list leaves out
/// (`server/src/comment.ts`, `participantVisibleClause`). A comment not yet
/// moderated (`mod = 0`) is not held back, under strict moderation too: a
/// job that laid it out may show it. One statement on the comments' `(zid)`
/// index, which reads at most one id past [`MAX_HELD_BACK`]: `None` when the
/// conversation holds back more than that.
fn held_back(c: &mut postgres::Client, zid: i32) -> anyhow::Result<Option<Vec<i64>>> {
    let row = c.query_one(
        "SELECT COALESCE(array_agg(tid ORDER BY tid), '{}'::bigint[]) FROM \
         (SELECT tid::bigint AS tid FROM public.comments \
          WHERE zid=$1 AND (mod=-1 OR active IS NOT TRUE OR velocity<=0) ORDER BY 1 LIMIT $2) h",
        &[&zid, &(MAX_HELD_BACK as i64 + 1)],
    )?;
    let hidden = row.try_get::<_, Vec<i64>>(0)?;
    Ok((hidden.len() <= MAX_HELD_BACK).then_some(hidden))
}

/// What a reader's ETag adds to the stored digest: nothing when no comment
/// is held back, so such a reader's form is the stored one; otherwise the
/// form's name and HMAC-SHA256, under this process's `key`, of the
/// conversation and its held-back ids. Without the key the tag is a digest
/// of a value nobody outside the process can compute, so knowing or
/// guessing ids confirms nothing. Another process (the other web box, the
/// next deploy) draws another key: its tag for the same bytes differs, which
/// costs a client one download, and a 304 is still given only to a tag this
/// process made for the form it would send now.
pub(crate) fn reader_form(key: &[u8; 32], zid: i32, hidden: &[i64]) -> String {
    if hidden.is_empty() {
        return String::new();
    }
    let ids: Vec<String> = hidden.iter().map(i64::to_string).collect();
    let mac = hmac_sha256(key, format!("{zid}:{}", ids.join(",")).as_bytes());
    format!(":{READER_FORM}:{}", hex_of(&mac))
}

/// HMAC-SHA256 (RFC 2104) for a key of at most one block (64 bytes).
pub(crate) fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    let (mut ipad, mut opad) = ([0x36u8; 64], [0x5cu8; 64]);
    for (i, k) in key.iter().take(64).enumerate() {
        ipad[i] ^= k;
        opad[i] ^= k;
    }
    let inner = Sha256::new()
        .chain_update(ipad)
        .chain_update(message)
        .finalize();
    Sha256::new()
        .chain_update(opad)
        .chain_update(inner)
        .finalize()
        .into()
}

fn hex_of(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The ETag (without `W/` and quotes) of the form `form` of the stored map
/// whose digest is `sha`; the statement in [`read_part`] computes the same.
pub(crate) fn reader_tag(sha: &str, form: &str) -> String {
    if form.is_empty() {
        sha.to_owned()
    } else {
        sha256_hex(format!("{sha}{form}").as_bytes())
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// A reader's form or the request kept to make it: the stored digest and the
/// form's part of the ETag ([`reader_form`]: the held-back set, keyed). A
/// moderator's map is never one (it is sent as stored), so a kept form is
/// only ever a reader's, and a held-back set that changes is another key.
type FormKey = (String, String);
/// A rewrite's result, once it is made.
type Made = Option<Result<Arc<Kept>, Refused>>;
type Flight = tokio::sync::watch::Receiver<Made>;

/// A reader's form, kept.
enum Kept {
    /// The map holds none of the held-back comments: the stored part, as read.
    Stored,
    Form {
        plain: Vec<u8>,
        gzip: Vec<u8>,
    },
}

impl Kept {
    fn bytes(&self) -> usize {
        match self {
            Kept::Stored => 0,
            Kept::Form { plain, gzip } => plain.len() + gzip.len(),
        }
    }
}

/// Readers' forms kept, least recently used first, within
/// [`READER_FORMS_KEPT`] and [`READER_FORM_BYTES_KEPT`]; and the rewrites in
/// progress, each one's result shared with every request for its key.
#[derive(Default)]
struct Forms {
    kept: std::collections::VecDeque<(FormKey, Arc<Kept>)>,
    bytes: usize,
    evicted: u64,
    flights: std::collections::HashMap<FormKey, Flight>,
    /// Forms and bytes kept at most, when a test sets smaller bounds than
    /// [`READER_FORMS_KEPT`] and [`READER_FORM_BYTES_KEPT`].
    bounds: Option<(usize, usize)>,
}

impl Forms {
    fn keep(&mut self, key: FormKey, kept: Arc<Kept>) {
        let (most, most_bytes) = self
            .bounds
            .unwrap_or((READER_FORMS_KEPT, READER_FORM_BYTES_KEPT));
        let n = kept.bytes();
        if n > most_bytes {
            return;
        }
        while self.kept.len() >= most || self.bytes + n > most_bytes {
            let Some((_, old)) = self.kept.pop_front() else {
                break;
            };
            self.bytes -= old.bytes();
            self.evicted += 1;
        }
        self.bytes += n;
        self.kept.push_back((key, kept));
    }
}

enum Role {
    Kept(Arc<Kept>),
    Follow(Flight),
    Lead(Flying),
}

/// A rewrite in progress: its result is kept and shared when it is made
/// ([`Flying::land`]); when it ends any other way (the request gave up
/// before it started, or it panicked) its key is let go, and the requests
/// that waited for it are shed.
struct Flying {
    state: State,
    key: FormKey,
    tx: Option<tokio::sync::watch::Sender<Made>>,
}

impl Flying {
    fn land(mut self, made: Result<Arc<Kept>, Refused>) {
        let Some(tx) = self.tx.take() else {
            return;
        };
        {
            let mut forms = self.state.forms();
            if let Ok(kept) = &made {
                forms.keep(self.key.clone(), kept.clone());
            }
            forms.flights.remove(&self.key);
        }
        let _ = tx.send(Some(made));
    }
}

impl Drop for Flying {
    fn drop(&mut self) {
        if self.tx.is_some() {
            self.state.forms().flights.remove(&self.key);
        }
    }
}

/// The reader's form of the stored part `bytes` (the gzip when `gzip`) of the
/// map whose stored digest and reader's form are `key`. A form already made
/// in this process is sent again; one being made is waited for; otherwise
/// this request makes it, once at most [`MAX_REWRITES`] are being made and
/// the rewrites' budget ([`REWRITE_SHARE`]) allows. Every wait is within the
/// route's deadline, after which the request is shed (503) as any other. The
/// rewrite runs off the runtime's threads, holding the request's place, the
/// rewrite's place and the stored bytes' count until it is done, even when
/// the request has given up; its result is then kept for the next request.
/// A map that holds none of `hidden` is the stored bytes; one whose document
/// does not read as the contract's closed type is not sent at all.
async fn reader_body(
    state: &State,
    key: FormKey,
    bytes: Vec<u8>,
    held: Held,
    hidden: Vec<i64>,
    gzip: bool,
    place: Place,
) -> Result<(Vec<u8>, Held), Refused> {
    let (kept, bytes, held) = match state.role(&key) {
        Role::Kept(kept) => (kept, bytes, held),
        Role::Follow(mut flight) => {
            let made = flight.wait_for(Option::is_some).await.map(|m| m.clone());
            match made {
                Ok(Some(made)) => (made?, bytes, held),
                _ => return Err(Refused::Busy),
            }
        }
        Role::Lead(flying) => {
            let Ok(permit) = state.0.rewriting.clone().acquire_owned().await else {
                return Err(Refused::Busy);
            };
            // Charged before it starts; nothing is charged while it waits,
            // so a request shed at the deadline here owes nothing.
            let reserved = loop {
                match state.reserve(bytes.len(), gzip) {
                    Ok(reserved) => break reserved,
                    Err(wait) => tokio::time::sleep(wait).await,
                }
            };
            let s = state.clone();
            let made = tokio::task::spawn_blocking(move || {
                let (_place, _permit) = (place, permit);
                let now = s.0.rewriting_now.fetch_add(1, Ordering::SeqCst) + 1;
                s.0.max_rewriting.fetch_max(now, Ordering::SeqCst);
                // Settled however the rewrite ends, a panic included.
                let settle = Settle {
                    state: s.clone(),
                    reserved,
                    started: std::time::Instant::now(),
                    len: bytes.len(),
                    gzip,
                };
                let made = make_form(&bytes, hidden, gzip).map(Arc::new);
                drop(settle);
                s.0.rewrites.fetch_add(1, Ordering::Relaxed);
                flying.land(made.clone());
                (made, bytes, held)
            })
            .await;
            let Ok((made, bytes, held)) = made else {
                return Err(Refused::Busy);
            };
            (made?, bytes, held)
        }
    };
    let bytes = match &*kept {
        Kept::Stored => bytes,
        Kept::Form { gzip: z, .. } if gzip => z.clone(),
        Kept::Form { plain, .. } => plain.clone(),
    };
    drop(held);
    let held = state.hold(bytes.len());
    Ok((bytes, held))
}

/// The rewrites' time budget ([`REWRITE_SHARE`]): seconds banked (negative
/// when owed) as of `at`, the slowest rate seen per encoding (plain, gzip),
/// and what the rewrites took in all and beyond their charges.
struct Budget {
    balance: f64,
    at: std::time::Instant,
    rate: [Option<f64>; 2],
    charged: f64,
    overrun: f64,
    /// The largest estimate charged before a rewrite started.
    largest: f64,
}

impl Budget {
    fn new() -> Self {
        Self {
            balance: REWRITE_BURST.as_secs_f64(),
            at: std::time::Instant::now(),
            rate: [None; 2],
            charged: 0.0,
            overrun: 0.0,
            largest: 0.0,
        }
    }
    /// Banks the share since it was last counted, up to the burst.
    fn refill(&mut self) {
        let now = std::time::Instant::now();
        let banked =
            self.balance + now.duration_since(self.at).as_secs_f64() * REWRITE_SHARE.as_secs_f64();
        self.balance = banked.min(REWRITE_BURST.as_secs_f64());
        self.at = now;
    }
    /// What a rewrite of a part of `len` bytes is charged before it starts:
    /// at least a millisecond, and in full however costly
    /// ([`State::reserve`]).
    fn estimate(&self, len: usize, gzip: bool) -> f64 {
        let rate = self.rate[gzip as usize].map_or(REWRITE_ESTIMATE, |r| r * REWRITE_HEADROOM);
        (rate * len as f64).max(0.001)
    }
}

/// Settles a rewrite's charge when dropped ([`State::settle`]), and counts it
/// as no longer running.
struct Settle {
    state: State,
    reserved: f64,
    started: std::time::Instant,
    len: usize,
    gzip: bool,
}

impl Drop for Settle {
    fn drop(&mut self) {
        let took = self.started.elapsed();
        self.state.settle(self.reserved, took, self.len, self.gzip);
        self.state.0.rewriting_now.fetch_sub(1, Ordering::SeqCst);
    }
}

/// The reader's form of the stored part `bytes` (the gzip when `gzip`), and
/// its gzip, for keeping.
fn make_form(bytes: &[u8], hidden: Vec<i64>, gzip: bool) -> Result<Kept, Refused> {
    let inflated;
    let document = if gzip {
        inflated = gunzip(bytes, MAX_PART_BYTES as usize).ok_or(Refused::Unreadable)?;
        &inflated[..]
    } else {
        bytes
    };
    let hidden: std::collections::BTreeSet<i64> = hidden.into_iter().collect();
    match public_form(document, &hidden) {
        Ok(None) => Ok(Kept::Stored),
        Ok(Some(plain)) => {
            let gzip = crate::compress::node_stream(&plain, true)
                .map_err(|_| Refused::Unreadable)?
                .concat();
            Ok(Kept::Form { plain, gzip })
        }
        Err(()) => Err(Refused::Unreadable),
    }
}

/// The map as a reader who may not see moderated-out comments receives it:
/// every point whose comment id is in `hidden` becomes a bare point, `None`
/// when the map holds none. A bare point keeps its position and nothing
/// else: its `id` is null, its `topic` is -1 at every level, its `text` (if
/// the document has any) is empty, and the bare points come last, ordered by
/// position, so neither their place in the arrays nor a neighbour's id tells
/// which comment one is. `points.moderatedOut` is their count: a view draws
/// the last `moderatedOut` points as moderated out.
///
/// The topics follow what this reader may see, level by level, because a
/// topic's name, label position and colour were made from all its members:
///
/// - a topic with no visible member is not sent (its name may be made of
///   held-back comments' words);
/// - a topic with a held-back member is sent with the generator's neutral
///   name, `Topic <cluster>` (`polis-topic-map/src/lib.rs`, the name a topic
///   gets when the run stored none, which `stored::safe_name` keeps as
///   generic), its label at the mean of its visible members, and its
///   `count` and `weight` counted over them as the generator counts them;
/// - a topic with no held-back member keeps its name, position, count and
///   weight as stored;
/// - every topic's `parent` and `parentShare` are counted again over the
///   visible members (for a topic with no held-back member they come out as
///   stored), and each level's `topics` and `unclustered` with them;
/// - every label's colours, and each level's `cmapPalette`, are chosen again
///   by the generator's palette (`polis_topic_map::map_colors`) from what is
///   sent: the points' positions and the labels' positions. The stored
///   colours were chosen over every label's position, a dropped or moved one
///   included, so they are not sent.
///
/// `Err`: the document does not read as the contract's closed type, or its
/// arrays disagree; such a map is not sent to this reader.
pub(crate) fn public_form(
    document: &[u8],
    hidden: &std::collections::BTreeSet<i64>,
) -> Result<Option<Vec<u8>>, ()> {
    let mut doc: contract::TopicMap = serde_json::from_slice(document).map_err(|_| ())?;
    let p = &doc.points;
    let n = p.id.len();
    if p.x.len() != n
        || p.y.len() != n
        || p.topic.len() != doc.levels.len()
        || p.topic.iter().any(|row| row.len() != n)
        || !(p.text.is_empty() || p.text.len() == n)
        || p.moderated_out != 0
    {
        return Err(());
    }
    let mut bare = Vec::new();
    let mut visible = Vec::new();
    for (i, id) in p.id.iter().enumerate() {
        match id {
            None => return Err(()),
            Some(id) if hidden.contains(id) => bare.push(i),
            Some(_) => visible.push(i),
        }
    }
    if bare.is_empty() {
        return Ok(None);
    }
    bare.sort_by(|&a, &b| p.x[a].total_cmp(&p.x[b]).then(p.y[a].total_cmp(&p.y[b])));
    let topics_in = doc.topics.len();
    let mut count = vec![0u64; topics_in];
    let mut sums = vec![[0.0f64; 2]; topics_in];
    let mut holds_back = vec![false; topics_in];
    for row in &p.topic {
        for &i in &visible {
            if row[i] >= 0 {
                let k = row[i] as usize;
                *count.get_mut(k).ok_or(())? += 1;
                sums[k][0] += p.x[i];
                sums[k][1] += p.y[i];
            }
        }
        for &i in &bare {
            if row[i] >= 0 {
                *holds_back.get_mut(row[i] as usize).ok_or(())? = true;
            }
        }
    }
    let mut renumber = vec![-1i64; topics_in];
    let mut next = 0;
    for (k, c) in count.iter().enumerate() {
        if *c > 0 {
            renumber[k] = next;
            next += 1;
        }
    }
    let order: Vec<usize> = visible.iter().chain(&bare).copied().collect();
    let shown = visible.len();
    let rows: Vec<Vec<i64>> = p
        .topic
        .iter()
        .map(|row| {
            order
                .iter()
                .enumerate()
                .map(|(j, &i)| {
                    if j >= shown || row[i] < 0 {
                        -1
                    } else {
                        renumber[row[i] as usize]
                    }
                })
                .collect()
        })
        .collect();
    let points = contract::Points {
        id: order
            .iter()
            .enumerate()
            .map(|(j, &i)| if j < shown { p.id[i] } else { None })
            .collect(),
        x: order.iter().map(|&i| p.x[i]).collect(),
        y: order.iter().map(|&i| p.y[i]).collect(),
        topic: Vec::new(),
        text: if p.text.is_empty() {
            Vec::new()
        } else {
            order
                .iter()
                .enumerate()
                .map(|(j, &i)| {
                    if j < shown {
                        p.text[i].clone()
                    } else {
                        String::new()
                    }
                })
                .collect()
        },
        moderated_out: bare.len() as u64,
    };
    let mut topics: Vec<contract::Topic> = std::mem::take(&mut doc.topics)
        .into_iter()
        .zip(count.iter().zip(holds_back.iter().zip(&sums)))
        .filter(|(_, (c, _))| **c > 0)
        .map(|(mut t, (c, (holds_back, xy)))| {
            if *holds_back {
                t.name = format!("Topic {}", t.cluster);
                t.x = round5(xy[0] / *c as f64);
                t.y = round5(xy[1] / *c as f64);
                t.count = *c;
                t.weight = (*c as f64).powf(0.25);
            }
            t.parent = None;
            t.parent_share = None;
            t
        })
        .collect();
    // The tree as the generator makes it: a topic's parent is the topic one
    // level coarser that holds the most of its (visible) comments.
    for level in 0..rows.len().saturating_sub(1) {
        let mut tally: std::collections::BTreeMap<i64, std::collections::BTreeMap<i64, u64>> =
            Default::default();
        #[allow(
            clippy::needless_range_loop,
            reason = "one index walks two rows in step"
        )]
        for j in 0..shown {
            let (child, parent) = (rows[level][j], rows[level + 1][j]);
            if child >= 0 && parent >= 0 {
                *tally.entry(child).or_default().entry(parent).or_default() += 1;
            }
        }
        for (child, parents) in tally {
            let Some((parent, n)) = parents
                .iter()
                .max_by(|a, b| a.1.cmp(b.1).then(b.0.cmp(a.0)))
                .map(|(p, n)| (*p, *n))
            else {
                continue;
            };
            let parent_id = topics[parent as usize].id.clone();
            let t = &mut topics[child as usize];
            t.parent = Some(parent_id);
            t.parent_share = Some((n as f64 / t.count as f64 * 1e5).round() / 1e5);
        }
    }
    for (level, row) in doc.levels.iter_mut().zip(&rows) {
        level.topics = topics.iter().filter(|t| t.level == level.level).count() as u64;
        level.unclustered = row.iter().filter(|k| **k < 0).count() as u64;
    }
    recolor(&mut topics, &mut doc.levels, &points.x, &points.y);
    doc.topics = topics;
    doc.points = contract::Points {
        topic: rows,
        ..points
    };
    serde_json::to_vec(&doc).map(Some).map_err(|_| ())
}

fn round5(v: f64) -> f64 {
    (v * 1e5).round() / 1e5
}

/// The labels' colours as the generator chooses them (`polis-topic-map`,
/// `build`), from what a reader is sent only: each level's palette over the
/// points' positions and that level's labels, the colour-map palette when
/// the level has more than 50 labels with "unclustered" counted among them;
/// and one palette over every level's labels for `colorAll`.
fn recolor(topics: &mut [contract::Topic], levels: &mut [contract::Level], x: &[f64], y: &[f64]) {
    use polis_topic_map::{ciecam02::Space, map_colors};
    static SPACE: std::sync::OnceLock<Space> = std::sync::OnceLock::new();
    let space = SPACE.get_or_init(Space::new);
    let hex = |c: [u8; 3]| format!("#{:02x}{:02x}{:02x}", c[0], c[1], c[2]);
    let coords: Vec<[f64; 2]> = x.iter().zip(y).map(|(x, y)| [*x, *y]).collect();
    let mut any_unclustered = false;
    for level in levels.iter_mut() {
        let at: Vec<usize> = (0..topics.len())
            .filter(|&k| topics[k].level == level.level)
            .collect();
        let labels: Vec<[f64; 2]> = at.iter().map(|&k| [topics[k].x, topics[k].y]).collect();
        any_unclustered |= level.unclustered > 0;
        level.cmap_palette = at.len() + usize::from(level.unclustered > 0) > 50;
        let (base, text) = map_colors(space, &coords, &labels, level.cmap_palette);
        for (j, &k) in at.iter().enumerate() {
            topics[k].color = hex(base[j]);
            topics[k].label_color = hex(text[j]);
        }
    }
    let labels: Vec<[f64; 2]> = topics.iter().map(|t| [t.x, t.y]).collect();
    let cmap = topics.len() + usize::from(any_unclustered) > 50;
    let (base, text) = map_colors(space, &coords, &labels, cmap);
    for (k, t) in topics.iter_mut().enumerate() {
        t.color_all = hex(base[k]);
        t.label_color_all = hex(text[k]);
    }
}

/// The finished full pipeline runs of `zid` on `sides`, newest first, at
/// most [`contract::MAX_LISTED`], and which one a read without `job_id`
/// answers. Two statements, each bounded, neither calling anything once per
/// listed run: the runs from the jobs view alone (its `(env, zid::text)`
/// index; the comment rule from each run's configuration),
/// then the sides' served pointers (at most one per side) with what each
/// pointer's run record says of the map family at the pointer's artifact.
/// Whether a listed run stored a map, and how many points it laid out, are
/// in its run record only, one `pd_run_record` call per run, so the list
/// does not read them: a page learns them by reading the run. How a run's
/// topics were named is in its manifest (`models.topic`), also in its run
/// record only, so every listed run says the keyword fallback (see
/// [`LISTED_NAMES`]); a run's configuration says what naming was asked for,
/// never what the run stored, and is not read.
fn list_jobs(
    c: &mut postgres::Client,
    zid: i32,
    sides: &[(Source, String, String)],
    asked: Option<Selection>,
    derived: bool,
) -> anyhow::Result<Vec<contract::ListedJob>> {
    if sides.is_empty() {
        return Ok(Vec::new());
    }
    let envs: Vec<String> = sides.iter().map(|(_, env, _)| env.clone()).collect();
    let rule: Option<&str> = asked.map(Selection::word);
    let rows = c.query(
        "SELECT env, job_id, job_config->>'selection', created_at \
         FROM public.delphi_result_jobs \
         WHERE env = ANY($1::text[]) AND conversation_id=$2 AND status='COMPLETED' \
          AND job_type='full_pipeline' \
          AND ($3::text IS NULL OR split_part(job_config->>'selection','/',1)=$3) \
         ORDER BY created_at DESC, job_id DESC LIMIT $4",
        &[
            &envs,
            &zid.to_string(),
            &rule,
            &(contract::MAX_LISTED as i64),
        ],
    )?;
    // The run a read without `job_id` answers: per side in order, the served
    // pointer's run when its record holds that run's map at the pointer's
    // artifact; a side with no pointer or no map family there has nothing
    // stored and the next is read; a pointer at a run that stored no map
    // (or a family another run produced) is that read's answer, so no run.
    let selection = asked.unwrap_or_default();
    let pairs: Vec<(String, String)> = sides
        .iter()
        .map(|(_, env, base)| (env.clone(), selection.scope(base)))
        .collect();
    let (first, second) = (&pairs[0], pairs.last().unwrap_or(&pairs[0]));
    let pointers = c.query(
        "SELECT p.env, p.job_id, \
          (SELECT jsonb_build_object('rows', f->'row_count', 'job', f->>'job_id') \
           FROM jsonb_array_elements(public.pd_run_record(p.env, p.job_id::uuid)->'families') f \
           WHERE f->>'family'=$6 AND f->>'artifact_id'=p.artifact_id::text LIMIT 1) \
         FROM public.delphi_result_publications p \
         WHERE p.zid=$1 AND ((p.env=$2 AND p.scope_key=$3) OR (p.env=$4 AND p.scope_key=$5)) \
         LIMIT 2",
        &[
            &zid,
            &first.0,
            &first.1,
            &second.0,
            &second.1,
            &contract::FAMILY,
        ],
    )?;
    // The derived map job of every listed run and of each side's served run,
    // one statement per side, by the runs' derived keys ([`producers`]);
    // none when derived maps are not read.
    let mut made: Vec<(String, String, Producer)> = Vec::new();
    for (_, env, _) in sides.iter().filter(|_| derived) {
        let mut ids: Vec<String> = Vec::new();
        for row in rows.iter().chain(pointers.iter()) {
            if row.try_get::<_, String>(0).is_ok_and(|e| e == *env) {
                let id: String = row.try_get(1)?;
                if !ids.contains(&id) {
                    ids.push(id);
                }
            }
        }
        for (id, producer) in producers(c, env, zid, &ids)? {
            made.push((env.clone(), id, producer));
        }
    }
    let made_by = |env: &str, job: &str| {
        made.iter()
            .find(|(e, j, _)| e == env && j == job)
            .map(|(_, _, p)| p)
    };
    let mut current = None;
    for (source, env, _) in sides {
        let Some(row) = pointers
            .iter()
            .find(|r| r.try_get::<_, String>(0).is_ok_and(|e| e == *env))
        else {
            continue;
        };
        let job: String = row.try_get(1)?;
        let Some(family) = row.try_get::<_, Option<serde_json::Value>>(2)? else {
            // No map of its own: as the read, its derived job's. A map it
            // stored is current; a stored reason, a job not finished or rows
            // that disagree are the read's answer, so no run; no job, or one
            // that failed, is nothing stored.
            match made_by(env, &job) {
                None
                | Some(Producer::None)
                | Some(Producer::Unavailable(_))
                | Some(Producer::Failed(_)) => continue,
                Some(Producer::Stored { job: by, .. }) => {
                    let rows = c.query_opt(
                        "SELECT (f->>'row_count')::bigint \
                         FROM jsonb_array_elements(public.pd_run_record($1::text,($2::text)::uuid)->'families') f \
                         WHERE f->>'family'=$3 AND f->>'job_id'=$2 LIMIT 1",
                        &[env, by, &contract::FAMILY],
                    )?;
                    let stored = match rows {
                        Some(r) => r.try_get::<_, Option<i64>>(0)?,
                        None => None,
                    };
                    if stored.is_some_and(|n| n >= 3) {
                        current = Some((*source, job));
                    }
                }
                Some(_) => {}
            }
            break;
        };
        let stored = family.get("rows").and_then(serde_json::Value::as_i64);
        if family.get("job").and_then(serde_json::Value::as_str) == Some(job.as_str())
            && stored.is_some_and(|n| n >= 3)
        {
            current = Some((*source, job));
        }
        break;
    }
    let mut jobs = Vec::new();
    for row in rows {
        let env: String = row.try_get(0)?;
        let Some((source, _, _)) = sides.iter().find(|(_, e, _)| *e == env) else {
            continue;
        };
        let job_id: String = row.try_get(1)?;
        // `participant_visible/1` and its kind: the rule without its version.
        let rule = row
            .try_get::<_, Option<String>>(2)?
            .and_then(|s| Selection::parse(s.split('/').next().unwrap_or("")));
        let map = match made_by(&env, &job_id) {
            Some(Producer::Stored { job, .. }) => Some(contract::ListedMap {
                job_id: job.clone(),
                status: contract::MapStatus::Stored,
            }),
            Some(Producer::Pending(job)) => Some(contract::ListedMap {
                job_id: job.clone(),
                status: contract::MapStatus::Pending,
            }),
            Some(Producer::Failed(job)) => Some(contract::ListedMap {
                job_id: job.clone(),
                status: contract::MapStatus::Failed,
            }),
            _ => None,
        };
        jobs.push(contract::ListedJob {
            current: current.as_ref() == Some(&(*source, job_id.clone())),
            job_id,
            source: *source,
            selection: rule,
            created_at: row.try_get(3)?,
            points: None,
            levels: None,
            names: LISTED_NAMES,
            map,
        });
    }
    Ok(jobs)
}

/// What the list says of every run's names: the keyword fallback. The
/// outcome of a run's naming (a model's names, or the keyword fallback when
/// the model was not asked, had no key, was over its cap or failed) is its
/// manifest's `models.topic`, readable only through its run record, one
/// `pd_run_record` call per run; the configuration's `naming` is what was
/// asked for, so the list never reports it as what the run stored.
pub(crate) const LISTED_NAMES: contract::Names = contract::Names {
    by: contract::NamedBy::Keywords,
    model: None,
};

/// Whether a side has nothing stored for the query, so that a query naming
/// no `source` reads the next side: no served run, a run whose own batch
/// holds no map family, or no such job. Anything the run itself stored (a
/// map, a stored no-map reason, a map too large, rows that are not a map) is
/// that side's answer.
fn nothing_stored(found: &Found) -> bool {
    matches!(
        found,
        Found::NoSuchRun
            | Found::NoMap {
                reason: NoMapReason::NoRun | NoMapReason::NotStored | NoMapReason::MapFailed,
                ..
            }
    )
}

/// One side a request reads: its source, its env (`None` for a served side
/// whose results are not in Postgres) and its base publication scope.
struct Side {
    source: Source,
    env: Option<String>,
    base: String,
}

/// The sides a request reads, in order: the one named, or without `source`
/// the served side and then, when the deployment reads one, the shadow's.
fn sides(app: &App, source: Option<Source>) -> Result<Vec<Side>, Refused> {
    let served = Side {
        source: Source::Served,
        // Empty only when the route was started on the shadow alone.
        env: Some(app.delphi_topic_map_env.clone()).filter(|e| !e.is_empty()),
        base: app
            .delphi_topic_map_scope
            .clone()
            .unwrap_or_else(|| DEFAULT_SCOPE.to_owned()),
    };
    let shadow = app.delphi_topic_map_shadow_env.clone().map(|env| Side {
        source: Source::Shadow,
        env: Some(env),
        base: DEFAULT_SCOPE.to_owned(),
    });
    Ok(match source {
        Some(Source::Served) => vec![served],
        Some(Source::Shadow) => vec![shadow.ok_or(Refused::SourceUnavailable)?],
        None => std::iter::once(served).chain(shadow).collect(),
    })
}

/// What [`read`] answers for an env with nothing stored, read from no env:
/// no served run, or for a named run no such run.
fn unread(named_run: bool) -> Read {
    Read {
        found: if named_run {
            Found::NoSuchRun
        } else {
            Found::NoMap {
                job: None,
                reason: NoMapReason::NoRun,
            }
        },
        selection: None,
        made_by: None,
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
    /// What this reader's ETag adds to the stored digest ([`reader_form`]).
    form: String,
    /// Whether derived maps are read (`POLIS_API_DELPHI_TOPIC_MAP_DERIVED_READS`):
    /// off, no derived lookup of any kind is made.
    derived: bool,
}

struct Read {
    found: Found,
    /// The run's comment rule as its configuration names it.
    selection: Option<String>,
    /// The derived job whose map (or outcome) this is, when the run stored
    /// no map of its own ([`producer`]).
    made_by: Option<String>,
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
    // The derived job a request named, when it named one: see below.
    let mut via: Option<String> = None;
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
                        made_by: None,
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
                        made_by: None,
                    });
                }
            }
        }
        Some(named) => {
            let Some(mut row) = c.query_opt(
                "SELECT conversation_id, status, job_config->>'selection', job_type, \
                  job_config->'derived'->'source'->>'job_id' \
                 FROM public.delphi_result_jobs WHERE env=$1 AND job_id=$2 LIMIT 1",
                &[&ask.env, named],
            )?
            else {
                return Ok(Read {
                    found: Found::NoSuchRun,
                    selection: None,
                    made_by: None,
                });
            };
            let mut job = named;
            // A derived job named itself, when derived maps are read: its
            // source run is the run (its selection, its scope, the document's
            // own provenance) and the derived job the map's maker, exactly as
            // a read of the source that found it.
            let source: Option<String> = if ask.derived
                && row.try_get::<_, Option<String>>(0)? == Some(ask.zid.to_string())
                && row.try_get::<_, Option<String>>(3)?.as_deref() == Some("derived")
            {
                let Some(source) = row.try_get::<_, Option<String>>(4)? else {
                    return Ok(Read {
                        found: Found::Unreadable,
                        selection: None,
                        made_by: None,
                    });
                };
                Some(source)
            } else {
                None
            };
            if let Some(source) = &source {
                via = Some(named.clone());
                let Some(of_source) = c.query_opt(
                    "SELECT conversation_id, status, job_config->>'selection', job_type, NULL::text \
                     FROM public.delphi_result_jobs WHERE env=$1 AND job_id=$2 LIMIT 1",
                    &[&ask.env, source],
                )?
                else {
                    return Ok(Read {
                        found: Found::NoSuchRun,
                        selection: None,
                        made_by: None,
                    });
                };
                row = of_source;
                job = source;
            }
            // Another conversation's run is no run of this report's.
            if row.try_get::<_, Option<String>>(0)? != Some(ask.zid.to_string()) {
                return Ok(Read {
                    found: Found::NoSuchRun,
                    selection: None,
                    made_by: None,
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
                    made_by: None,
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
    // A request naming a derived job asks for its map, never the run's own.
    if via.is_some() {
        artifact = None;
    }
    let part = match artifact.as_deref() {
        Some(a) => read_part(c, &ask, a, &job, state)?,
        None => None,
    };
    // A run whose own batch holds no map: the map a derived job made from
    // its stored results, found by the run's derived key, is its map. Every
    // row of that map must name the derived job; the document names the run.
    let mut made_by = None;
    let part = match part {
        Some(part) => Some(part),
        // Derived maps not read: no lookup, the run's own answer.
        None if !ask.derived => None,
        None => match addressed(producer(c, &ask.env, ask.zid, &job)?, via.as_deref()) {
            Producer::None | Producer::Unavailable(_) => None,
            Producer::Unreadable => Some(Part::Unreadable),
            Producer::Pending(by) => {
                return Ok(Read {
                    found: Found::NoMap {
                        job: Some(job),
                        reason: NoMapReason::MapPending,
                    },
                    selection,
                    made_by: Some(by),
                });
            }
            Producer::Failed(by) => {
                return Ok(Read {
                    found: Found::NoMap {
                        job: Some(job),
                        reason: NoMapReason::MapFailed,
                    },
                    selection,
                    made_by: Some(by),
                });
            }
            Producer::Stored { job: by, artifact } => {
                let part = read_part(c, &ask, &artifact, &by, state)?;
                made_by = Some(by);
                // A finished derived job that holds no map family is not a map.
                Some(part.unwrap_or(Part::Unreadable))
            }
        },
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
    Ok(Read {
        found,
        selection,
        made_by,
    })
}

/// What made the map of a run that stored none of its own.
#[derive(Debug, PartialEq, Eq)]
enum Producer {
    /// No derived job for the run.
    None,
    /// No derived job can be looked up: the login may not read the job
    /// address table (`permission`). Answered as [`Producer::None`].
    Unavailable(&'static str),
    /// Its derived job is waiting or running.
    Pending(String),
    /// Its derived job ended without storing anything.
    Failed(String),
    /// Its derived job finished and published its map family (a map, or the
    /// reason there is none) at `artifact`.
    Stored { job: String, artifact: String },
    /// Rows that disagree: a finished job with no published map, a job made
    /// from another run, a specification of another key, operation or
    /// version.
    Unreadable,
}

/// The derived topic map job of each run in `sources` (of `env` and the
/// conversation `zid`), by exact address: the run's derived key
/// ([`derived_key`], the generator's own), the job address table's one row
/// for it (`delphi_job_aliases`, primary key `derived/1:<key>`), the job
/// that row names (`delphi_result_jobs` by env and job id) and, when it has
/// finished, its own publication (`derived:<key>`). One statement however
/// many runs (the list's own bound): per run, one primary-key read of the
/// address table and, per address found, one read of the job by its
/// `(env, job_id::text)` index and one of its publication by the served
/// pointer's primary key `(env, zid, scope_key)`; no history is read. Never the newest derived job of the
/// conversation, never a run record.
fn producers(
    c: &mut postgres::Client,
    env: &str,
    zid: i32,
    sources: &[String],
) -> anyhow::Result<Vec<(String, Producer)>> {
    if sources.is_empty() {
        return Ok(Vec::new());
    }
    let keys: Vec<String> = sources.iter().map(|s| derived_key(env, s)).collect();
    let aliases: Vec<String> = keys.iter().map(|k| format!("{ALIAS_PREFIX}{k}")).collect();
    let scopes: Vec<String> = keys.iter().map(|k| format!("derived:{k}")).collect();
    let rows = match c.query(
        PRODUCERS,
        &[
            &env,
            &zid,
            &sources,
            &keys,
            &aliases,
            &scopes,
            &zid.to_string(),
        ],
    ) {
        Ok(rows) => rows,
        Err(e) if e.code() == Some(&postgres::error::SqlState::INSUFFICIENT_PRIVILEGE) => {
            derived_lookup_unavailable("permission");
            return Ok(sources
                .iter()
                .map(|s| (s.clone(), Producer::Unavailable("permission")))
                .collect());
        }
        Err(e) => return Err(e.into()),
    };
    let mut out: Vec<(String, Producer)> = Vec::with_capacity(sources.len());
    for source in sources {
        let mine: Vec<_> = rows
            .iter()
            .filter(|r| r.try_get::<_, String>(0).is_ok_and(|s| s == *source))
            .collect();
        let producer = match mine.as_slice() {
            [] => Producer::None,
            [row] => {
                let job: String = row.try_get(1)?;
                let status: Option<String> = row.try_get(2)?;
                let from: Option<String> = row.try_get(3)?;
                let specified: Option<bool> = row.try_get(4)?;
                // Its publication counts only when it points at its own map.
                let published_by: Option<String> = row.try_get(6)?;
                let artifact: Option<String> = row
                    .try_get::<_, Option<String>>(5)?
                    .filter(|_| published_by.as_deref() == Some(job.as_str()));
                match (
                    from.as_deref() == Some(source.as_str()) && specified == Some(true),
                    status.as_deref(),
                    artifact,
                ) {
                    (false, _, _) => Producer::Unreadable,
                    (true, Some("COMPLETED"), Some(artifact)) => Producer::Stored { job, artifact },
                    (true, Some("COMPLETED"), None) => Producer::Unreadable,
                    (true, Some("FAILED" | "CANCELLED"), _) => Producer::Failed(job),
                    (true, _, _) => Producer::Pending(job),
                }
            }
            // One address names one job: rows that say otherwise disagree.
            _ => Producer::Unreadable,
        };
        out.push((source.clone(), producer));
    }
    Ok(out)
}

/// The producer a run's key addresses, held to the derived job a request
/// named (`via`): the run's key must address that very job, else the rows
/// disagree. A lookup that cannot be made stays no derived map.
fn addressed(found: Producer, via: Option<&str>) -> Producer {
    let Some(via) = via else {
        return found;
    };
    match &found {
        Producer::Pending(by) | Producer::Failed(by) | Producer::Stored { job: by, .. }
            if by == via =>
        {
            found
        }
        Producer::Unavailable(_) => found,
        _ => Producer::Unreadable,
    }
}

/// The statement of [`producers`]: `$1` env, `$2` zid, `$3` the source runs,
/// `$4` their keys, `$5` their addresses, `$6` their publication scopes (all
/// computed here, so every lookup is by equality on a key), `$7` the zid as
/// the job view's text.
pub(crate) const PRODUCERS: &str = "SELECT s.source, j.job_id, j.status, \
      j.job_config->'derived'->'source'->>'job_id', \
      j.job_config->'derived'->>'key' = s.key \
       AND j.job_config->'derived'->>'operation' = 'topic_map' \
       AND j.job_config->'derived'->>'version' = '1', \
      p.artifact, p.job_id \
     FROM unnest($3::text[],$4::text[],$5::text[],$6::text[]) AS s(source,key,alias,scope) \
     CROSS JOIN LATERAL (SELECT a.job_id::text AS job FROM public.delphi_job_aliases a \
       WHERE a.public_id=s.alias AND a.source='derived' LIMIT 1) a \
     CROSS JOIN LATERAL (SELECT j.job_id, j.status, j.job_config FROM public.delphi_result_jobs j \
       WHERE j.env=$1 AND j.job_id=a.job AND j.conversation_id=$7 AND j.job_type='derived' LIMIT 1) j \
     LEFT JOIN LATERAL (SELECT p.artifact_id::text AS artifact, p.job_id \
       FROM public.delphi_result_publications p \
       WHERE p.env=$1 AND p.zid=$2 AND p.scope_key=s.scope LIMIT 1) p ON true";

/// The job address table's prefix for a derived job's key, as admission
/// writes it (`derived/<schema>:<key>`).
const ALIAS_PREFIX: &str = "derived/1:";

/// The one line a process writes when a derived lookup cannot be made (the
/// login may not read the job address table), the first time only: every
/// such lookup is answered as no derived map, and in-run maps are served as
/// before.
fn derived_lookup_unavailable(reason: &'static str) {
    static SAID: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if !SAID.swap(true, std::sync::atomic::Ordering::Relaxed) {
        eprintln!(
            "{{\"event\":\"delphi_topic_map_derived_lookup\",\"outcome\":\"unavailable\",\"reason\":\"{reason}\"}}"
        );
    }
}

/// [`producers`] for one run.
fn producer(
    c: &mut postgres::Client,
    env: &str,
    zid: i32,
    source: &str,
) -> anyhow::Result<Producer> {
    Ok(producers(c, env, zid, &[source.to_owned()])?
        .pop()
        .map_or(Producer::None, |(_, p)| p))
}

/// The key of the derived topic map job made from `source` in `env`: the
/// generator's own (`polis_topic_map::derived::key`), version 1.
pub(crate) fn derived_key(env: &str, source: &str) -> String {
    polis_topic_map::derived::key(
        polis_topic_map::derived::Operation::TopicMap,
        1,
        env,
        source,
    )
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
               AND NOT EXISTS(SELECT 1 FROM s WHERE '*' = ANY($10::text[]) OR (CASE WHEN $15::text = '' THEN s.sha \
                 ELSE encode(sha256(convert_to(s.sha || $15::text,'UTF8')),'hex') END) = ANY($10::text[]))), \
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
            &ask.form,
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
    let tag = reader_tag(&sha, &ask.form);
    let matched = ask.tags.iter().any(|t| t == "*" || *t == tag);
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
    sha256_hex(document) == sha && gunzip(gzip, document.len()).as_deref() == Some(document)
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
