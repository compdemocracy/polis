//! `GET /api/v3/delphi/topicMap?report_id=<id>[&job_id=<id>]`: a report's
//! topic map (`polis-topic-map/1`, [`contract`]), computed when asked from
//! three families a Delphi run already stores in the PostgreSQL result store
//! (positions `Delphi_UMAPGraph`, clusters
//! `Delphi_CommentHierarchicalClusterAssignments`, topic names
//! `Delphi_CommentClustersLLMTopicNames`) with the generator
//! `polis-topic-map`, and kept in memory by job id: a run's families never
//! change. Nothing is stored. No comment text.
//!
//! Visibility is that of the report's other Delphi reads (`/api/v3/delphi`,
//! `/delphi/reports`, `/delphi/visualizations`): Node registers them with no
//! sign-in, so the report id is what reads them.
//!
//! The participation path (votes, comments, the next comment) shares nothing
//! with this route. A run that is not in memory is read and computed by one
//! request at a time in the process ([`ADMITTED`]), admitted before anything
//! is read: any other such request is refused at once (503, `Retry-After`),
//! and requests for the run already being read wait for it holding nothing
//! but a receiver. It reads on its own pool ([`pool_limits`]), and the
//! connection goes back before anything is decoded. Decoding, the generator,
//! the ETag and the compressed forms run on the route's own thread, at the
//! lowest CPU priority, never on the runtime's threads; a map in memory is
//! answered by copying bytes. The cache's lock is held only to look up or
//! insert an entry.
use crate::{
    delphi_job_result::Cluster,
    delphi_run::JobId,
    http::{Outgoing, Request},
    route::{self, App, Res},
    wire::Invalid,
};
use serde::Deserialize;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicU64, AtomicUsize, Ordering},
};
use std::time::Duration;
use tokio::sync::Semaphore;
// Both workspaces compile the same shared contract module. Its document types
// are the clients' reading of the answer: the route serves the generator's
// bytes, and the tests hold the two to each other field for field.
#[allow(dead_code)]
#[path = "../../polis-contracts/src/delphi_topic_map.rs"]
pub(crate) mod contract;
pub use contract::PATH;
use contract::{NoMapReason, Refused};

const UMAP: &str = "Delphi_UMAPGraph";
const ASSIGNMENTS: &str = "Delphi_CommentHierarchicalClusterAssignments";
const TOPICS: &str = "Delphi_CommentClustersLLMTopicNames";
const CODEC: &str = "delphi-storage-codec/1";

/// Comments one map may hold: positions and assignments rows. The largest
/// production conversation has about 9,000 comments.
pub const MAX_COMMENTS: u64 = 20_000;
/// Rows of the positions family: one node per comment and its stored
/// neighbour edges.
pub const MAX_UMAP_ROWS: u64 = 200_000;
/// Topic-name rows, over every layer.
pub const MAX_TOPIC_ROWS: u64 = 20_000;
/// Layer ids from 0 to 15: the generator draws every level below the largest.
pub const MAX_LAYERS: u32 = 16;
/// Bytes of one stored family read, checked in the statement before it is sent.
pub const MAX_WIRE_BYTES: i64 = 32 * 1024 * 1024;
/// Bytes of the run record.
pub const MAX_RECORD_BYTES: usize = 8 * 1024 * 1024;
/// Bytes of one answered document. Each answer in flight holds a copy until it
/// is written, as every route's answers do; 2 MiB is about twice the document
/// of 20,000 comments with ordinary topic names.
pub const MAX_DOCUMENT_BYTES: usize = 2 * 1024 * 1024;
/// Bytes of documents the process keeps, over every run.
pub const CACHE_BYTES: usize = 32 * 1024 * 1024;
/// Runs the process keeps an answer for.
pub const CACHE_ENTRIES: usize = 256;
/// Requests reading or computing a run that is not in memory, at once, in the
/// process: one. Every other such request is refused at once (503); requests
/// for the run already being read wait for it, holding nothing.
pub const ADMITTED: usize = 1;
/// The whole request, from the first read to the answer it is given; the run's
/// read and computation continue past it and keep their answer.
pub const DEADLINE: Duration = Duration::from_millis(4000);

/// Two slots; one statement at a time each. The run record walks the job's
/// publication history and a positions family can be megabytes, so the
/// statement timeout is the typed result read's.
pub fn pool_limits() -> crate::db::Limits {
    crate::db::Limits {
        size: 2,
        acquire_timeout: Duration::from_millis(50),
        statement_timeout: Duration::from_millis(2000),
        max_lifetime: Duration::from_secs(300),
    }
}

/// What the process remembers of one run: its conversation and its answer.
pub(crate) struct Entry {
    zid: i32,
    outcome: Outcome,
}

#[derive(Clone)]
enum Outcome {
    /// The document, with its ETag and compressed forms.
    Map(Arc<route::Prepared>),
    NoMap(NoMapReason),
    TooLarge,
    /// The stored families could not be read as this route reads them: the
    /// request goes back to Node, and is not read again.
    Invalid,
}

impl Entry {
    #[cfg(all(test, feature = "db-tests"))]
    pub(crate) fn is_map(&self) -> bool {
        matches!(self.outcome, Outcome::Map(_))
    }
    fn bytes(&self) -> usize {
        match &self.outcome {
            Outcome::Map(prepared) => prepared.bytes(),
            _ => 64,
        }
    }
}

#[derive(Default)]
struct Cache {
    entries: VecDeque<(String, Arc<Entry>)>,
    bytes: usize,
}

impl Cache {
    fn get(&mut self, job: &str) -> Option<Arc<Entry>> {
        let at = self.entries.iter().position(|(k, _)| k == job)?;
        let item = self.entries.remove(at)?;
        let entry = item.1.clone();
        self.entries.push_back(item);
        Some(entry)
    }
    fn insert(&mut self, job: String, entry: Arc<Entry>, max_bytes: usize, max_entries: usize) {
        if let Some(at) = self.entries.iter().position(|(k, _)| *k == job)
            && let Some((_, old)) = self.entries.remove(at)
        {
            self.bytes -= old.bytes();
        }
        if entry.bytes() > max_bytes {
            return;
        }
        self.bytes += entry.bytes();
        self.entries.push_back((job, entry));
        while self.bytes > max_bytes || self.entries.len() > max_entries {
            let Some((_, old)) = self.entries.pop_front() else {
                break;
            };
            self.bytes -= old.bytes();
        }
    }
}

/// How one run's read and computation ended, for every request waiting on it.
#[derive(Clone)]
enum Settled {
    Entry(Arc<Entry>),
    /// No such run.
    NotFound,
    /// The run of this conversation has not succeeded.
    NotReady(i32),
    /// The route's connections were all in use: the requests are told to
    /// ask again.
    Busy,
    /// A read or the computation failed: the requests go back to Node.
    Failed,
}

type Settles = tokio::sync::watch::Receiver<Option<Settled>>;
type Job = Box<dyn FnOnce() + Send>;

struct Inner {
    cache: Mutex<Cache>,
    cache_bytes: usize,
    cache_entries: usize,
    /// The read-and-compute section: a run not in memory is read and computed
    /// only under one of these; without one the request is refused at once.
    admitted: Arc<Semaphore>,
    /// Runs being read or computed, and how each will settle.
    pending: Mutex<std::collections::HashMap<String, Settles>>,
    /// The route's own thread, started at its first computation.
    worker: Mutex<Option<std::sync::mpsc::Sender<Job>>>,
    in_flight: AtomicUsize,
    max_in_flight: AtomicUsize,
    computed: AtomicU64,
    busy: AtomicU64,
    /// Bytes of stored families requests hold outside the cache, now and at most.
    retained: AtomicUsize,
    max_retained: AtomicUsize,
    /// A test holds the next computation inside the route's thread.
    #[cfg(all(test, feature = "db-tests"))]
    held: Mutex<Option<std::sync::mpsc::Receiver<()>>>,
}

/// The route's own cache, admission and thread. Nothing else takes them.
#[derive(Clone)]
pub struct State(Arc<Inner>);

impl Default for State {
    fn default() -> Self {
        Self::new(CACHE_BYTES, CACHE_ENTRIES, ADMITTED)
    }
}

/// Stored family bytes one request holds, counted until they are dropped.
pub(crate) struct Held {
    inner: Arc<Inner>,
    bytes: usize,
}
impl Drop for Held {
    fn drop(&mut self) {
        self.inner.retained.fetch_sub(self.bytes, Ordering::SeqCst);
    }
}

/// One computation in flight, counted for the isolation evidence.
struct Flight<'a>(&'a Inner);
impl<'a> Flight<'a> {
    fn enter(inner: &'a Inner) -> Self {
        let now = inner.in_flight.fetch_add(1, Ordering::SeqCst) + 1;
        inner.max_in_flight.fetch_max(now, Ordering::SeqCst);
        Self(inner)
    }
}
impl Drop for Flight<'_> {
    fn drop(&mut self) {
        self.0.in_flight.fetch_sub(1, Ordering::SeqCst);
    }
}

/// A request's place for one run that is not in memory.
enum Join {
    /// Another request is reading or computing it: wait for that.
    Waiting(Settles),
    /// This request reads and computes it, under the one admission.
    Admitted(Section),
    /// The admission is taken by another run: refused at once.
    Busy,
}

/// The read-and-compute section of one run. It runs to its end whatever its
/// requests do; dropping it ends the run's pending entry, so a request never
/// waits on a section that is gone.
struct Section {
    state: State,
    job: String,
    settle: tokio::sync::watch::Sender<Option<Settled>>,
    _admission: tokio::sync::OwnedSemaphorePermit,
}

impl Drop for Section {
    fn drop(&mut self) {
        if let Ok(mut pending) = self.state.0.pending.lock() {
            pending.remove(&self.job);
        }
    }
}

/// The route's thread runs at the lowest CPU priority: in a process with a
/// CPU quota (the Compose service has half a CPU), the participation routes'
/// threads come first whenever both are ready to run.
fn lowest_priority() {
    #[cfg(target_os = "linux")]
    // SAFETY: setpriority with this thread's own id changes only this thread's
    // nice value (Linux keeps one per thread); raising it needs no privilege.
    unsafe {
        let tid = libc::syscall(libc::SYS_gettid) as libc::id_t;
        libc::setpriority(libc::PRIO_PROCESS, tid, 19);
    }
}

impl State {
    pub(crate) fn new(cache_bytes: usize, cache_entries: usize, admitted: usize) -> Self {
        Self(Arc::new(Inner {
            cache: Mutex::new(Cache::default()),
            cache_bytes,
            cache_entries,
            admitted: Arc::new(Semaphore::new(admitted)),
            pending: Mutex::new(std::collections::HashMap::new()),
            worker: Mutex::new(None),
            in_flight: AtomicUsize::new(0),
            max_in_flight: AtomicUsize::new(0),
            computed: AtomicU64::new(0),
            busy: AtomicU64::new(0),
            retained: AtomicUsize::new(0),
            max_retained: AtomicUsize::new(0),
            #[cfg(all(test, feature = "db-tests"))]
            held: Mutex::new(None),
        }))
    }
    fn cached(&self, job: &str) -> Option<Arc<Entry>> {
        self.0.cache.lock().ok()?.get(job)
    }
    fn keep(&self, job: String, entry: Arc<Entry>) {
        if let Ok(mut cache) = self.0.cache.lock() {
            cache.insert(job, entry, self.0.cache_bytes, self.0.cache_entries);
        }
    }
    /// Wait on the run's section, start it, or be refused: decided under one
    /// lock, after the cache is looked at again, so a section that has just
    /// kept its map is never started twice.
    fn join(&self, job: &str) -> Option<Join> {
        let mut pending = self.0.pending.lock().ok()?;
        if let Some(settles) = pending.get(job) {
            return Some(Join::Waiting(settles.clone()));
        }
        if let Some(entry) = self.cached(job) {
            let (_, settles) = tokio::sync::watch::channel(Some(Settled::Entry(entry)));
            return Some(Join::Waiting(settles));
        }
        let Ok(admission) = self.0.admitted.clone().try_acquire_owned() else {
            self.0.busy.fetch_add(1, Ordering::Relaxed);
            return Some(Join::Busy);
        };
        let (settle, settles) = tokio::sync::watch::channel(None);
        pending.insert(job.to_owned(), settles);
        Some(Join::Admitted(Section {
            state: self.clone(),
            job: job.to_owned(),
            settle,
            _admission: admission,
        }))
    }
    fn hold(&self, bytes: usize) -> Held {
        let now = self.0.retained.fetch_add(bytes, Ordering::SeqCst) + bytes;
        self.0.max_retained.fetch_max(now, Ordering::SeqCst);
        Held {
            inner: self.0.clone(),
            bytes,
        }
    }
    /// Stored family bytes held outside the cache at most at once, since start.
    pub(crate) fn max_retained(&self) -> usize {
        self.0.max_retained.load(Ordering::SeqCst)
    }
    /// Stored family bytes held outside the cache now.
    pub(crate) fn retained(&self) -> usize {
        self.0.retained.load(Ordering::SeqCst)
    }
    /// Computations at once, at most, since the process started.
    pub(crate) fn max_in_flight(&self) -> usize {
        self.0.max_in_flight.load(Ordering::SeqCst)
    }
    /// Maps computed since the process started.
    pub(crate) fn computed(&self) -> u64 {
        self.0.computed.load(Ordering::SeqCst)
    }
    /// For `/health`: computations since start, the most at once, the
    /// requests refused as busy, stored family bytes held now and at most,
    /// and what the cache holds.
    pub(crate) fn health(&self) -> crate::js::Js {
        let (entries, bytes) = self
            .0
            .cache
            .lock()
            .map(|c| (c.entries.len(), c.bytes))
            .unwrap_or((0, 0));
        let mut body = crate::js::Obj::new();
        let num = |n: f64| crate::js::Js::Num(n);
        body.set("computed", num(self.computed() as f64));
        body.set("maxInFlight", num(self.max_in_flight() as f64));
        body.set("busy", num(self.0.busy.load(Ordering::Relaxed) as f64));
        body.set("familyBytes", num(self.retained() as f64));
        body.set("maxFamilyBytes", num(self.max_retained() as f64));
        body.set("cacheEntries", num(entries as f64));
        body.set("cacheBytes", num(bytes as f64));
        crate::js::Js::Obj(body)
    }
    /// Hold the next computation inside the route's thread until the
    /// returned sender sends or is dropped.
    #[cfg(all(test, feature = "db-tests"))]
    pub(crate) fn hold_next_computation(&self) -> std::sync::mpsc::Sender<()> {
        let (release, held) = std::sync::mpsc::channel();
        if let Ok(mut slot) = self.0.held.lock() {
            *slot = Some(held);
        }
        release
    }
    /// Computations running now.
    #[cfg(all(test, feature = "db-tests"))]
    pub(crate) fn in_flight(&self) -> usize {
        self.0.in_flight.load(Ordering::SeqCst)
    }
    /// The route's thread: one, started on first use, at the lowest CPU
    /// priority, running one job at a time.
    fn worker(&self) -> Option<std::sync::mpsc::Sender<Job>> {
        let mut slot = self.0.worker.lock().ok()?;
        if slot.is_none() {
            let (jobs, queue) = std::sync::mpsc::channel::<Job>();
            std::thread::Builder::new()
                .name("polis-topic-map".into())
                .spawn(move || {
                    lowest_priority();
                    for job in queue {
                        // A job that panics fails its own request only.
                        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(job));
                    }
                })
                .ok()?;
            *slot = Some(jobs);
        }
        slot.clone()
    }
    /// Compute one run's answer on the route's thread, and keep it: the
    /// document, its ETag and its compressed forms, all prepared there.
    pub(crate) async fn compute(&self, job: String, wires: Wires) -> Option<Arc<Entry>> {
        let (done, result) = tokio::sync::oneshot::channel();
        let inner = self.0.clone();
        let work: Job = Box::new(move || {
            let _flight = Flight::enter(&inner);
            #[cfg(all(test, feature = "db-tests"))]
            if let Some(held) = inner.held.lock().ok().and_then(|mut h| h.take()) {
                let _ = held.recv_timeout(Duration::from_secs(30));
            }
            // Another request may have computed this run meanwhile.
            let cached = inner.cache.lock().ok().and_then(|mut c| c.get(&job));
            let entry = cached.unwrap_or_else(|| {
                let zid = wires.zid;
                let outcome = build(&job, wires).unwrap_or(Outcome::Invalid);
                inner.computed.fetch_add(1, Ordering::SeqCst);
                let entry = Arc::new(Entry { zid, outcome });
                if let Ok(mut cache) = inner.cache.lock() {
                    cache.insert(job, entry.clone(), inner.cache_bytes, inner.cache_entries);
                }
                entry
            });
            let _ = done.send(entry);
        });
        self.worker()?.send(work).ok()?;
        result.await.ok()
    }
}

impl Section {
    /// Read the run, compute it on the route's thread, keep its answer, and
    /// tell every request waiting on it.
    async fn run(self, pool: Arc<crate::db::Pool>, env: String) {
        let settled = match read(pool, env, self.job.clone(), self.state.clone()).await {
            None => Settled::Failed,
            Some(Read::NotFound) => Settled::NotFound,
            Some(Read::Busy) => Settled::Busy,
            Some(Read::NotReady(zid)) => Settled::NotReady(zid),
            Some(Read::Outcome(zid, outcome)) => {
                let entry = Arc::new(Entry { zid, outcome });
                self.state.keep(self.job.clone(), entry.clone());
                Settled::Entry(entry)
            }
            Some(Read::Wires(wires)) => match self.state.compute(self.job.clone(), *wires).await {
                Some(entry) => Settled::Entry(entry),
                None => Settled::Failed,
            },
        };
        let _ = self.settle.send(Some(settled));
    }
}

pub fn parse(app: &App, req: &Request) -> Option<contract::Request> {
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
    // The visualizations read's admission: each key once, ids of at most 100
    // letters, digits, `_` and `-`; anything else is not this route's.
    let mut query = contract::Request::default();
    let mut seen = BTreeSet::new();
    for (k, v) in url::form_urlencoded::parse(raw.as_bytes()) {
        if !matches!(k.as_ref(), "report_id" | "job_id")
            || !seen.insert(k.clone())
            || v.len() > 100
            || !v
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        {
            return None;
        }
        let value = (!v.is_empty()).then(|| v.into_owned());
        if k == "report_id" {
            query.report_id = value;
        } else {
            query.job_id = value;
        }
    }
    Some(query)
}

enum Answer {
    Refused(Refused),
    NoMap(contract::NoMap),
    Map(Arc<route::Prepared>),
}

pub async fn handle(app: &App, req: &Request, mut res: Res) -> Outgoing {
    let Some(query) = parse(app, req) else {
        return route::bad_gateway();
    };
    let Ok(Some(answer)) = tokio::time::timeout(DEADLINE, answer(app, query)).await else {
        return route::bad_gateway();
    };
    match answer {
        // Proportional work was done on the route's thread; this only copies.
        Answer::Map(prepared) => route::json_prepared(req, res, 200, &prepared),
        Answer::NoMap(body) => json(req, res, 200, &body),
        Answer::Refused(refused) => {
            if refused == Refused::Busy {
                res.set("Retry-After", contract::RETRY_AFTER);
            }
            json(req, res, refused.status(), &refused.body())
        }
    }
}

/// A small JSON answer (a refusal or a run without a map).
fn json<T: serde::Serialize>(req: &Request, res: Res, status: u16, value: &T) -> Outgoing {
    match crate::wire::to_json(value) {
        Ok(body) => route::json_text(req, res, status, body),
        Err(_) => route::bad_gateway(),
    }
}

/// `None` hands the request back to Node, whose answer for this path is 404.
async fn answer(app: &App, query: contract::Request) -> Option<Answer> {
    let Some(report) = query.report_id else {
        return Some(Answer::Refused(Refused::MissingReport));
    };
    let pool = app.delphi_topic_map_db.as_ref()?;
    let env = app.delphi_topic_map_env.clone();
    let scope = app.delphi_topic_map_scope.clone();
    let rid = report.clone();
    let served_wanted = query.job_id.is_none();
    let looked_up = pool
        .with(move |c| {
            // As getZidFromReport: no row, a null and a zero all name no conversation.
            let zid = c
                .query_opt(
                    "SELECT zid FROM reports WHERE report_id=$1 LIMIT 1",
                    &[&rid],
                )?
                .map(|r| r.try_get::<_, Option<i32>>(0))
                .transpose()?
                .flatten()
                .filter(|z| *z != 0);
            let mut served = Vec::new();
            if let (Some(z), true) = (zid, served_wanted) {
                for row in c.query(
                    "SELECT DISTINCT job_id FROM public.delphi_result_publications WHERE env=$1 AND zid=$2 AND ($3::text IS NULL OR scope_key=$3) ORDER BY job_id LIMIT 2",
                    &[&env, &z, &scope],
                )? {
                    served.push(row.try_get::<_, String>(0)?);
                }
            }
            Ok((zid, served))
        })
        .await;
    // Its connections all in use: shed at once, as for a busy section.
    let (zid, served) = match looked_up {
        Ok(found) => found,
        Err(e) if crate::db::is_acquire_timeout(&e) => {
            return Some(Answer::Refused(Refused::Busy));
        }
        Err(_) => return None,
    };
    let Some(zid) = zid else {
        return Some(Answer::Refused(Refused::UnknownReport(report)));
    };
    let job = match query.job_id {
        Some(job) => match JobId::new(job) {
            Ok(job) => job.as_str().to_owned(),
            // Job ids are lowercase canonical uuids; any other spelling names no run.
            Err(_) => return Some(Answer::Refused(Refused::JobNotFound)),
        },
        None => match served.as_slice() {
            [] => {
                return Some(Answer::NoMap(contract::NoMap::new(
                    report,
                    None,
                    NoMapReason::NoRun,
                )));
            }
            [job] => JobId::new(job.clone()).ok()?.as_str().to_owned(),
            // Two scopes serve different runs: not this route's to choose.
            _ => return None,
        },
    };
    let state = &app.delphi_topic_map;
    let settled = match state.cached(&job) {
        Some(entry) => Settled::Entry(entry),
        None => {
            let mut settles = match state.join(&job)? {
                Join::Busy => return Some(Answer::Refused(Refused::Busy)),
                Join::Waiting(settles) => settles,
                Join::Admitted(section) => {
                    let settles = section.settle.subscribe();
                    // The section runs to its end whatever this request does.
                    tokio::spawn(section.run(pool.clone(), app.delphi_topic_map_env.clone()));
                    settles
                }
            };
            // Waiting holds a receiver: no connection, thread or family byte.
            let settled = settles.wait_for(Option::is_some).await.ok()?.clone();
            settled?
        }
    };
    let entry = match settled {
        Settled::Entry(entry) => entry,
        Settled::NotFound => return Some(Answer::Refused(Refused::JobNotFound)),
        // A run of another conversation is no run of this report's.
        Settled::NotReady(owner) if owner != zid => {
            return Some(Answer::Refused(Refused::JobNotFound));
        }
        // Not kept: the run may still finish.
        Settled::NotReady(_) => {
            return Some(Answer::NoMap(contract::NoMap::new(
                report,
                Some(job),
                NoMapReason::RunNotReady,
            )));
        }
        Settled::Busy => return Some(Answer::Refused(Refused::Busy)),
        Settled::Failed => return None,
    };
    if entry.zid != zid {
        return Some(Answer::Refused(Refused::JobNotFound));
    }
    match &entry.outcome {
        Outcome::Map(prepared) => Some(Answer::Map(prepared.clone())),
        Outcome::NoMap(reason) => Some(Answer::NoMap(contract::NoMap::new(
            report,
            Some(job),
            *reason,
        ))),
        Outcome::TooLarge => Some(Answer::Refused(Refused::TooLarge)),
        Outcome::Invalid => None,
    }
}

/// The part of `pd_run_record` this route reads.
#[derive(Deserialize)]
struct Record {
    zid: i32,
    status: String,
    #[serde(default)]
    state: Option<String>,
    created_at: Option<String>,
    #[serde(default)]
    families: Vec<Family>,
}

#[derive(Deserialize)]
struct Family {
    family: String,
    artifact_id: String,
    batch_id: String,
    row_count: u64,
}

/// The three stored families of one run, as their codec files.
pub(crate) struct Wires {
    /// Counts these bytes as held until the families are dropped.
    _held: Option<Held>,
    zid: i32,
    created_at: Option<String>,
    umap: (String, u64),
    assignments: (String, u64),
    topics: (String, u64),
}

enum Read {
    NotFound,
    /// No connection within the pool's acquisition timeout.
    Busy,
    /// The run's conversation, when the run has not succeeded.
    NotReady(i32),
    /// The run's conversation and its answer, decided without its families.
    Outcome(i32, Outcome),
    Wires(Box<Wires>),
}

/// Every statement a computation needs, on one connection that goes back to
/// the pool before anything is computed. Only a request holding the
/// section's admission gets here.
async fn read(pool: Arc<crate::db::Pool>, env: String, job: String, state: State) -> Option<Read> {
    pool.with(move |c| {
        // The record's size is checked before it is sent; its conversation is
        // read either way, so an oversized run is still only its own
        // conversation's to be told about.
        let row = c.query_one(
            "SELECT CASE WHEN octet_length(t) <= $3::bigint THEN t END, (j->>'zid')::integer FROM (SELECT pd_run_record($1::text,($2::text)::uuid) AS j) s, LATERAL (SELECT j::text AS t) x",
            &[&env, &job, &(MAX_RECORD_BYTES as i64)],
        )?;
        let (text, owner): (Option<String>, Option<i32>) = (row.try_get(0)?, row.try_get(1)?);
        let Some(owner) = owner else {
            return Ok(Read::NotFound);
        };
        let Some(text) = text else {
            return Ok(Read::Outcome(owner, Outcome::TooLarge));
        };
        let record: Record = serde_json::from_str(&text)?;
        anyhow::ensure!(record.zid == owner, "one record, one conversation");
        let zid = record.zid;
        if record.state.as_deref().unwrap_or(&record.status) != "succeeded" {
            return Ok(Read::NotReady(zid));
        }
        let family = |name: &str| -> anyhow::Result<Option<&Family>> {
            let mut found = record.families.iter().filter(|f| f.family == name);
            let first = found.next();
            anyhow::ensure!(found.next().is_none(), "two batches of one family");
            Ok(first)
        };
        let (umap, assignments, topics) = (family(UMAP)?, family(ASSIGNMENTS)?, family(TOPICS)?);
        let Some(umap) = umap.filter(|f| f.row_count > 0) else {
            return Ok(Read::Outcome(zid, Outcome::NoMap(NoMapReason::NoPositions)));
        };
        let (Some(assignments), Some(topics)) = (
            assignments.filter(|f| f.row_count > 0),
            topics.filter(|f| f.row_count > 0),
        ) else {
            return Ok(Read::Outcome(zid, Outcome::NoMap(NoMapReason::NoTopics)));
        };
        if assignments.row_count > MAX_COMMENTS
            || umap.row_count > MAX_UMAP_ROWS
            || topics.row_count > MAX_TOPIC_ROWS
        {
            return Ok(Read::Outcome(zid, Outcome::TooLarge));
        }
        let mut wire = |f: &Family| -> anyhow::Result<Option<(String, u64)>> {
            // Each family where its batch lives, never the publication pointer:
            // a later publication cannot redirect this run's read.
            let artifact = uuid::Uuid::parse_str(&f.artifact_id)?.to_string();
            anyhow::ensure!(artifact == f.artifact_id, "artifact id spelling");
            let row = c.query_one(
                "SELECT CASE WHEN octet_length(w->>'wire') <= $4::bigint THEN w->>'wire' END, w->>'batch_id' FROM (SELECT public.pd_result_artifact_wire($1,($2::text)::uuid,$3) AS w) s",
                &[&env, &artifact, &f.family, &MAX_WIRE_BYTES],
            )?;
            let batch: Option<String> = row.try_get(1)?;
            anyhow::ensure!(batch.as_deref() == Some(f.batch_id.as_str()), "family batch");
            Ok(row
                .try_get::<_, Option<String>>(0)?
                .map(|text| (text, f.row_count)))
        };
        let (Some(umap), Some(assignments), Some(topics)) =
            (wire(umap)?, wire(assignments)?, wire(topics)?)
        else {
            return Ok(Read::Outcome(zid, Outcome::TooLarge));
        };
        let bytes = umap.0.len() + assignments.0.len() + topics.0.len();
        Ok(Read::Wires(Box::new(Wires {
            _held: Some(state.hold(bytes)),
            zid,
            created_at: record.created_at,
            umap,
            assignments,
            topics,
        })))
    })
    .await
    .map_or_else(
        |e| crate::db::is_acquire_timeout(&e).then_some(Read::Busy),
        Some,
    )
}

fn fail() -> Invalid {
    Invalid("invalid stored topic map family".into())
}

/// The rows of one codec file: its header names the codec and the family.
fn rows(wire: &str, family: &str, count: u64) -> Result<Vec<BTreeMap<String, Value>>, Invalid> {
    let mut out = Vec::new();
    each_row(wire, family, count, |row| {
        out.push(row);
        Ok(())
    })?;
    Ok(out)
}

/// Each row of one codec file, decoded and handed over one at a time, so the
/// positions family (a node and its stored edges per comment) is never held
/// decoded all at once.
fn each_row(
    wire: &str,
    family: &str,
    count: u64,
    mut row: impl FnMut(BTreeMap<String, Value>) -> Result<(), Invalid>,
) -> Result<(), Invalid> {
    let body = wire.strip_suffix('\n').ok_or_else(fail)?;
    let mut lines = body.split('\n');
    let head: Value = serde_json::from_str(lines.next().ok_or_else(fail)?).map_err(|_| fail())?;
    if head.get("codec").and_then(Value::as_str) != Some(CODEC)
        || head.get("family").and_then(Value::as_str) != Some(family)
    {
        return Err(fail());
    }
    let mut seen = 0u64;
    for line in lines {
        row(serde_json::from_str(line).map_err(|_| fail())?)?;
        seen += 1;
    }
    if seen != count {
        return Err(fail());
    }
    Ok(())
}

/// A stored attribute of exactly one tag.
fn tagged<'a>(value: Option<&'a Value>, tag: &str) -> Result<&'a Value, Invalid> {
    let map = value.and_then(Value::as_object).ok_or_else(fail)?;
    if map.len() != 1 {
        return Err(fail());
    }
    map.get(tag).ok_or_else(fail)
}
fn text<'a>(row: &'a BTreeMap<String, Value>, key: &str) -> Result<&'a str, Invalid> {
    tagged(row.get(key), "S")?.as_str().ok_or_else(fail)
}
fn number(value: Option<&Value>) -> Result<&str, Invalid> {
    tagged(value, "N")?.as_str().ok_or_else(fail)
}
fn finite(value: Option<&Value>) -> Result<f64, Invalid> {
    let n: f64 = number(value)?.parse().map_err(|_| fail())?;
    n.is_finite().then_some(n).ok_or_else(fail)
}
fn id(value: Option<&Value>) -> Result<u32, Invalid> {
    let raw = number(value)?;
    let n: u32 = raw.parse().map_err(|_| fail())?;
    (n.to_string() == raw).then_some(n).ok_or_else(fail)
}
/// A string attribute that may be absent or stored null.
fn optional_text(row: &BTreeMap<String, Value>, key: &str) -> Result<Option<String>, Invalid> {
    match row.get(key) {
        None => Ok(None),
        Some(v) if v == &serde_json::json!({"NULL":true}) => Ok(None),
        Some(_) => Ok(Some(text(row, key)?.to_owned())),
    }
}

/// tid -> (x, y), from the node rows (source = target); edges are skipped.
fn positions(wire: &str, count: u64, zid: i32) -> Result<BTreeMap<u32, (f64, f64)>, Invalid> {
    let conversation = zid.to_string();
    let mut out = BTreeMap::new();
    each_row(wire, UMAP, count, |row| {
        if text(&row, "conversation_id")? != conversation {
            return Err(fail());
        }
        let (source, target) = (id(row.get("source_id"))?, id(row.get("target_id"))?);
        if source != target {
            return Ok(());
        }
        let position = tagged(row.get("position"), "M")?
            .as_object()
            .ok_or_else(fail)?;
        if position.len() != 2 {
            return Err(fail());
        }
        let xy = (finite(position.get("x"))?, finite(position.get("y"))?);
        if out.insert(source, xy).is_some() {
            return Err(fail());
        }
        Ok(())
    })?;
    Ok(out)
}

/// layer -> cluster -> name, and the one model that named them all, if one.
type Names = BTreeMap<String, BTreeMap<String, polis_topic_map::TopicName>>;
fn names(rows: &[BTreeMap<String, Value>], zid: i32) -> Result<(Names, Option<String>), Invalid> {
    let conversation = zid.to_string();
    let mut out = Names::new();
    let mut models = BTreeSet::new();
    for row in rows {
        if text(row, "conversation_id")? != conversation {
            return Err(fail());
        }
        let layer = id(row.get("layer_id"))?;
        let cluster: Cluster =
            serde_json::from_str(number(row.get("cluster_id"))?).map_err(|_| fail())?;
        let name = polis_topic_map::TopicName {
            topic_name: optional_text(row, "topic_name")?,
            topic_key: Some(text(row, "topic_key")?.to_owned()),
        };
        models.insert(optional_text(row, "model_name")?);
        let Cluster::Id(cluster) = cluster else {
            continue;
        };
        if out
            .entry(layer.to_string())
            .or_default()
            .insert(cluster.to_string(), name)
            .is_some()
        {
            return Err(fail());
        }
    }
    let model = match models.len() {
        1 => models.into_iter().next().flatten(),
        _ => None,
    };
    Ok((out, model))
}

/// The run's answer, from its three codec files.
fn build(job: &str, wires: Wires) -> Result<Outcome, Invalid> {
    let zid = wires.zid;
    // Each family is decoded and its codec file let go before the next.
    let mut wires = wires;
    let nodes = positions(&std::mem::take(&mut wires.umap.0), wires.umap.1, zid)?;
    let assignment_rows = rows(&std::mem::take(&mut wires.assignments.0), ASSIGNMENTS, wires.assignments.1)?;
    let assignments =
        crate::delphi_result_read::assignment_rows(assignment_rows, zid, wires.assignments.1)?;
    let (topics_by_layer, model) = names(&rows(&std::mem::take(&mut wires.topics.0), TOPICS, wires.topics.1)?, zid)?;
    // One run's two families must name the same comments.
    let clustered: BTreeSet<u32> = assignments.iter().map(|(tid, _)| tid.get()).collect();
    if nodes.len() != clustered.len() || nodes.keys().any(|t| !clustered.contains(t)) {
        return Err(fail());
    }
    if nodes.is_empty() {
        return Ok(Outcome::NoMap(NoMapReason::NoPositions));
    }
    if nodes.len() as u64 > MAX_COMMENTS {
        return Ok(Outcome::TooLarge);
    }
    let mut layered = false;
    let mut points = Vec::with_capacity(nodes.len());
    for (tid, (x, y)) in &nodes {
        let mut clusters = BTreeMap::new();
        for (layer, cluster) in assignments.get(&tid.to_string()).ok_or_else(fail)?.iter() {
            if layer.get() >= MAX_LAYERS {
                return Ok(Outcome::TooLarge);
            }
            let value = match cluster {
                Cluster::Unassigned => -1,
                Cluster::Id(n) => i64::from(*n),
            };
            clusters.insert(layer.get().to_string(), value);
            layered = true;
        }
        points.push(polis_topic_map::ProximityPoint {
            comment_id: i64::from(*tid),
            umap_x: *x,
            umap_y: *y,
            clusters,
        });
    }
    if topics_by_layer
        .keys()
        .any(|layer| layer.parse::<u32>().map_or(true, |l| l >= MAX_LAYERS))
    {
        return Ok(Outcome::TooLarge);
    }
    if !layered || topics_by_layer.is_empty() {
        return Ok(Outcome::NoMap(NoMapReason::NoTopics));
    }
    let run = polis_topic_map::Run {
        created_at: wires.created_at,
        model_name: model,
        topics_by_layer,
    };
    let mut data = polis_topic_map::build(
        polis_topic_map::Proximity {
            proximity_data: points,
        },
        polis_topic_map::Topics {
            runs: BTreeMap::from([(job.to_owned(), run)]),
        },
        &BTreeMap::new(),
        "",
        "",
    )
    .map_err(Invalid)?;
    if !drawable(&data) {
        return Ok(Outcome::NoMap(NoMapReason::TooFewComments));
    }
    // No comment text in this route: the page holds the comments.
    data.points.text = Vec::new();
    let doc = serde_json::to_string(&data).map_err(|_| fail())?;
    if doc.len() > MAX_DOCUMENT_BYTES {
        return Ok(Outcome::TooLarge);
    }
    // The ETag and both compressions, here, off the runtime's threads.
    Ok(route::Prepared::new(doc).map_or(Outcome::Invalid, |p| Outcome::Map(Arc::new(p))))
}

/// Every number of the document is finite and the first view has an area.
/// The generator keeps the 99.9% of comments nearest the middle (all but one
/// below 1,000 comments): with one or two comments, or when the comments it
/// keeps sit on one point, its standard size divides by zero (a null in the
/// document); when they sit on one horizontal or vertical line, the first
/// view has no height or width and the points no radius.
fn drawable(data: &polis_topic_map::MapData) -> bool {
    let [x0, x1, y0, y1] = data.bounds;
    if !(x1 > x0 && y1 > y0) {
        return false;
    }
    let topics = data
        .topics
        .iter()
        .flat_map(|t| [t.x, t.y, t.weight].into_iter().chain(t.parent_share));
    data.bounds
        .iter()
        .copied()
        .chain([data.point_radius])
        .chain(data.points.x.iter().copied())
        .chain(data.points.y.iter().copied())
        .chain(topics)
        .all(f64::is_finite)
}

#[cfg(test)]
#[path = "delphi_topic_map_tests.rs"]
pub(crate) mod tests;

#[cfg(test)]
impl Clone for Wires {
    fn clone(&self) -> Self {
        Self {
            _held: None,
            zid: self.zid,
            created_at: self.created_at.clone(),
            umap: self.umap.clone(),
            assignments: self.assignments.clone(),
            topics: self.topics.clone(),
        }
    }
}

#[cfg(all(test, feature = "db-tests"))]
impl Wires {
    pub(crate) fn umap_wire(&self) -> (String, u64) {
        self.umap.clone()
    }
    pub(crate) fn assignments_wire(&self) -> (String, u64) {
        self.assignments.clone()
    }
    pub(crate) fn topics_wire(&self) -> (String, u64) {
        self.topics.clone()
    }
}
