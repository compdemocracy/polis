//! The source loader: one conversation's stored math result, read in one
//! statement on the loader's own single connection, built into a plan off
//! every request, and published into the plan cache.
//!
//! - **Its own thread and its own connection.** `spawn` runs the loader on
//!   one OS thread of its own (never a tokio worker: the builder-side calls
//!   of the cache wait for its lock, and the synchronous PostgreSQL client
//!   cannot run inside a runtime). The loader holds at most one connection,
//!   opened by its own connector, shared with no pool a vote, a comment or a
//!   next-comment request uses. Every connect and every statement is
//!   bounded (`SETUP_TIMEOUT`, `STATEMENT_TIMEOUT`, and an I/O deadline
//!   above it); a failure drops the connection and ends the load with its
//!   outcome. Nothing is retried in a loop: a failure is remembered by the
//!   cache's negative cache, and a load it holds back ends `BackingOff`.
//! - **Reserve before each piece of work, on one reservation.** In order,
//!   on the one reservation a build takes, grown and cut down in place and
//!   never released and taken again (so it keeps the moment it was taken,
//!   and a build that began before a fence was forgotten is refused at
//!   publication):
//!   1. the read only: the receive buffer, at most the rule's `max_bytes`
//!      (`admit_read`), beside the connection's own charge, which covers
//!      the largest `max_bytes` of any rule (`CONNECTION_MAX_BYTES`);
//!   2. `fenced`; then the one statement, on the primary when the
//!      conversation is unfenced and on the replica only when it is fenced
//!      and one is configured; the connection is idle again before anything
//!      is computed;
//!   3. cut down to the bytes received, and the measuring pass over them
//!      (`Projection::measure`, which allocates nothing);
//!   4. grown by the measured parse charge (`measured_parse_reservation`,
//!      under the same limits), and the parse (`parse_measured`); the plan's
//!      key is taken from the projection and the receive buffer dropped;
//!   5. resized to what the projection holds and the frames stage
//!      (`Projection::reservation`), and the frames; the projection dropped
//!      (the frames own their data); resized to the build stage
//!      (`Plan::build_stage_bound`, from the frames' real counts), and the
//!      build;
//!   6. cut down to the plan's entry, its slot and its fence; `publish`.
//!
//!   A grow refused (after reclaiming and evicting one plan, once) ends the
//!   load at that step: what is held is dropped, the reservation released,
//!   and the failure recorded before any content key (`Failure::BeforeRead`)
//!   so the conversation backs off by the negative cache's delay; it is
//!   never read again at once. `FenceFull`: evict one plan, publish once
//!   more. Never a loop.
//! - **One statement, one snapshot** (`SOURCE_STATEMENT`). The row's
//!   identity and the projection come from one row of one statement, so they
//!   can never straddle a math update. The projection's byte length is
//!   checked in the statement: past `max_bytes` only the length crosses the
//!   wire, never the document.
//! - **The stored fields, never derived.** The projection is the stored
//!   result's own values under its own keys; nothing is computed from them.
//!   No vote is read: `group-votes` holds the math engine's counts.
//! - **Closed outcomes.** Every load ends in one `Outcome`; none carries a
//!   comment id, a participant, comment text or a vote.
//!
//! Dormant: nothing in this crate calls it. Nothing here touches a file.

use super::cache::{PlanRef, Poisoned, PublishRefused, Rejected, Reserved, RoutingPlanCache};
use polis_queue_adapter::jobs::transport::Connector;
use polis_routing_plan::{
    BundleKey, CachedPlan, ContentId, ENTRY_OVERHEAD, FENCE_OVERHEAD, Failure, Plan, Projection,
    Rejection, RowIdentity, RuleConfig, SLOT_OVERHEAD, SourceKey, SourceLimits, WantedKey,
    std_bounds_reviewed,
};
use postgres::Client;
use postgres::error::SqlState;
use postgres::types::Type;
use std::sync::Arc;
use std::sync::mpsc::{Receiver, SyncSender};
use std::time::{Duration, Instant};

/// The name the loader's connection gives the database.
pub(crate) const APPLICATION_NAME: &str = "polis-api-routing-plan/1";
/// `statement_timeout` on the loader's connection.
pub(crate) const STATEMENT_TIMEOUT: Duration = Duration::from_secs(5);
/// A connection's setup (TCP, TLS, authentication, session settings).
pub(crate) const SETUP_TIMEOUT: Duration = Duration::from_secs(5);
/// Any one exchange with the server: the statement timeout and a second for
/// the server's answer, so a server that stops answering cannot hold the
/// loader past its own deadline.
pub(crate) const IO_TIMEOUT: Duration = Duration::from_secs(6);

/// What a projection is held to: the adapter's default counts, and a
/// `max_bytes` of the loader's own per rule. Admission is in stages, each
/// charged from what the source really holds (see the module's comment), so
/// `max_bytes` bounds only the read: the receive buffer before anything is
/// measured, and the connection's charge, which covers it. It is a stated
/// fraction of one conversation's share (64 MiB at the default budget):
/// 8 MiB, an eighth, so the read holds at most 2 x 8 MiB + 64 KiB (the
/// buffer and the connection, about 25% of a share) before the measuring
/// pass, and no read can take a whole share unmeasured.
///
/// Past the read, each stage is admitted only when it fits (the share and
/// the budget): the measured parse (about the length again at the
/// constructed witnesses), the frames stage and the build stage, from the
/// counts and the frames' real lengths. At the constructed witnesses (five
/// groups, every twentieth comment meta, stored weights; 1.8 MB at 10,000
/// comments and 7.5 MB at 40,000) the largest stage is the floor's build
/// stage, 9,758,282 and 38,939,612 bytes, and the stored weights' the
/// parse, 3,675,090 and 15,290,627, inside a share of 67,108,864
/// (`loader_admits_both_witnesses_in_one_share` prints every stage). The
/// counts' limits (40,000 comments) bind before the length at that density.
/// Whatever its content, a source is admitted at every stage up to about
/// 2.6 MB for stored weights and 216 KB for the floor (the worst case of
/// its length, `loader_admission_fits_one_share`); past that, as its
/// measured stages fit. A source whose own stage does not fit
/// is refused at that stage and keeps today's draw; a projection over
/// `max_bytes` is `Oversized` and only its length crosses the wire.
pub(crate) const LIMITS: SourceLimits = SourceLimits {
    max_bytes: STORED_MAX_BYTES,
    max_depth: 32,
    max_comments: 40_000,
    max_groups: 64,
    max_cells: 40_000 * 64,
    max_memberships: 4_000_000,
};

/// The longest projection a stored-weights or uniform build reads.
pub(crate) const STORED_MAX_BYTES: u64 = 8 * 1024 * 1024;

/// The longest projection a floor build reads.
pub(crate) const FLOOR_MAX_BYTES: u64 = 8 * 1024 * 1024;

/// The largest `max_bytes` of any rule: what the connection's charge
/// covers, whichever rule it reads for.
pub(crate) const CONNECTION_MAX_BYTES: u64 = if STORED_MAX_BYTES > FLOOR_MAX_BYTES {
    STORED_MAX_BYTES
} else {
    FLOOR_MAX_BYTES
};

/// The limits a build of `rule` is held to.
pub(crate) fn limits(rule: &RuleConfig) -> SourceLimits {
    match rule {
        RuleConfig::SymmetricGicFloor2(_) => SourceLimits {
            max_bytes: FLOOR_MAX_BYTES,
            ..LIMITS
        },
        RuleConfig::StoredWeights1 | RuleConfig::Uniform1 => LIMITS,
    }
}

/// Charged for the connection's own buffers while it is open: the driver
/// reads a whole row into its buffer, so it can hold one projection of the
/// largest `max_bytes` of any rule (`CONNECTION_MAX_BYTES`), plus this.
pub(crate) const CONNECTION_FIXED: u64 = 64 * 1024;

/// A bound on a plan key's text beside the environment, the rule and the
/// policy: its source id at the longest the library admits.
const KEY_TEXT_FIXED: u64 = 128;

/// The one statement a load sends. For the conversation's current row
/// (`math_tick >= 0`): the row's `math_env`, `math_tick` and
/// `last_vote_timestamp` columns, the database's `now()` in milliseconds,
/// the projection's length in bytes, and the projection itself only when
/// that length is at most `$3`.
///
/// The projection is a `json` object of the stored result's own values,
/// under its own keys, in a fixed order, each present only when the stored
/// result has it: `group-votes`, `pca` (holding only `comment-extremity`),
/// `tids`, `meta-tids`, `comment-priorities`, `group-clusters`,
/// `base-clusters`. Every value is cast to `json` explicitly, so the
/// statement is the same on a `jsonb` column (a database built by the
/// migrations) and a `json` one (a database that predates them): `->` exists
/// for both, and the cast is a no-op on `json`. Every column is named and
/// none is read by position, so the column order of the table does not
/// matter. Read only; one statement is one snapshot. The projection is
/// built once per row in a subquery the planner keeps (`offset 0`), so the
/// length check and the value read one result; it is not sorted and not
/// materialized, so a refused large document is not written to temporary
/// files on the server (the key order is the list's, as the aggregate reads
/// its input in order).
pub(crate) const SOURCE_STATEMENT: &str = "\
select m.math_env::text as math_env,
       m.math_tick::int8 as math_tick,
       m.last_vote_timestamp::int8 as last_vote_timestamp,
       floor(extract(epoch from now()) * 1000)::int8 as db_now_ms,
       octet_length(p.projection)::int8 as projection_bytes,
       case when octet_length(p.projection) <= $3 then p.projection end as projection
  from math_main m
  cross join lateral (
    select coalesce(
             (select json_object_agg(e.k, e.v)
                from (values
                  ('group-votes', (m.data -> 'group-votes')::json),
                  ('pca', case when (m.data -> 'pca' -> 'comment-extremity') is null then null
                               else json_build_object('comment-extremity',
                                      (m.data -> 'pca' -> 'comment-extremity')::json) end),
                  ('tids', (m.data -> 'tids')::json),
                  ('meta-tids', (m.data -> 'meta-tids')::json),
                  ('comment-priorities', (m.data -> 'comment-priorities')::json),
                  ('group-clusters', (m.data -> 'group-clusters')::json),
                  ('base-clusters', (m.data -> 'base-clusters')::json)
                ) as e(k, v)
               where e.v is not null),
             '{}'::json)::text as projection
    offset 0
  ) p
 where m.zid = $1 and m.math_env = $2 and m.math_tick >= 0";

/// Every way one load ends. Closed; none carries a comment id, a
/// participant, comment text or a vote.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Outcome {
    /// The plan is published.
    Published,
    /// The plan crate gives no bounds here (an unreviewed toolchain, or the
    /// key's bound overflows): nothing was reserved or read.
    NoAllowance,
    /// The cache's negative cache holds this load back: nothing was read.
    BackingOff,
    /// The read's reservation (the receive buffer) was refused after
    /// reclaiming and evicting one plan: nothing was read.
    NotAdmitted,
    /// A later step's grow was refused after reclaiming and evicting one
    /// plan: the read was paid, so the conversation backs off.
    StepRefused(Step),
    /// The connection's own buffer could not be reserved: nothing was read.
    ConnectionNotReserved,
    /// The cache's lock is poisoned: nothing more was done.
    CachePoisoned,
    /// Connecting failed or the statement failed: nothing was published.
    DatabaseUnavailable,
    /// The statement ran past its timeout and was cancelled.
    StatementTimeout,
    /// The conversation has no current math result in that environment.
    NoRow,
    /// The projection is longer than `max_bytes`; only its length was read.
    Oversized,
    /// The adapter refused the projection.
    SourceRefused,
    /// The adapter read the projection but refused to build the plan (a
    /// frame the rule needs is missing, among others).
    BuildRefused,
    /// The plan does not match its key (never expected: the same read).
    KeyMismatch,
    /// The plan's entry is larger than the build's reservation.
    Undercharged,
    /// Publication refused: the reason, after the one retry `FenceFull` gets.
    Refused(Rejection),
}

/// One load: which conversation, under which rule and configuration. The
/// rule is parsed once per configuration by whatever sends the job.
#[derive(Clone, Debug)]
pub(crate) struct Job {
    pub(crate) zid: i32,
    pub(crate) math_env: String,
    /// The tick the load is for (the newest a request saw), which keys a
    /// failure before any content was read.
    pub(crate) desired_tick: i64,
    pub(crate) rule: RuleConfig,
    /// The rule's canonical plain text, `rule.to_plain()`.
    pub(crate) rule_plain: String,
    pub(crate) policy: Option<String>,
    pub(crate) config_digest: [u8; 32],
}

/// A step after the read whose grow can be refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Step {
    Parse,
    Frames,
    Build,
}

/// Where the loader stands in one load, for a test to act between steps.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Stage {
    /// The read is admitted and the fence read; nothing is sent yet.
    BeforeRead,
    /// The row is received and owned; the connection is idle.
    AfterRead,
    /// The reservation is cut down to the bytes received, and they are
    /// measured.
    Received,
    /// Grown by the parse charge; the parse runs next.
    Parsing,
    /// Parsed; the buffer is still held.
    Parsed,
    /// Resized to what the projection holds and the frames stage; the
    /// buffer is gone; the frames are read next.
    Framing,
    /// The frames are read; the projection is still held.
    Framed,
    /// Resized to the build stage; the projection is gone; the build runs
    /// next.
    Building,
    /// The plan is built; the frames are still held.
    Built,
    /// Cut down to the plan's entry, slot and fence; publication is next.
    BeforePublish,
}

pub(crate) trait Hooks {
    /// `backend`: the open connection's server process, if one is open.
    fn at(&mut self, _stage: Stage, _backend: Option<i32>) {}
    /// At each stage after the read, with what the build's one reservation
    /// holds then. It must not allocate: a test counts allocations here.
    fn reserved(&mut self, _stage: Stage, _bytes: u64) {}
}

/// No hook: what the loader's thread runs.
pub(crate) struct NoHooks;
impl Hooks for NoHooks {}

/// Which server a read went to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Target {
    Primary,
    Replica,
}

/// What the one statement returned for a row.
#[derive(Debug)]
pub(crate) struct Source {
    pub(crate) row: RowIdentity,
    /// The projection's length in bytes, as the database measured it.
    pub(crate) projection_bytes: i64,
    /// The projection, or `None` when it is longer than the bound.
    pub(crate) projection: Option<String>,
}

/// The one statement, on `client`. `Ok(None)`: no current row.
pub(crate) fn read_source(
    client: &mut Client,
    zid: i32,
    math_env: &str,
    max_bytes: u64,
) -> Result<Option<Source>, postgres::Error> {
    let max = i64::try_from(max_bytes).unwrap_or(i64::MAX);
    let rows = client.query_typed(
        SOURCE_STATEMENT,
        &[
            (&zid, Type::INT4),
            (&math_env, Type::TEXT),
            (&max, Type::INT8),
        ],
    )?;
    let Some(row) = rows.into_iter().next() else {
        return Ok(None);
    };
    let source = Source {
        row: RowIdentity {
            zid,
            math_env: row.try_get::<_, String>("math_env")?,
            math_tick: row.try_get::<_, i64>("math_tick")?,
            last_vote_timestamp: row.try_get::<_, Option<i64>>("last_vote_timestamp")?,
            db_now_ms: row.try_get::<_, i64>("db_now_ms")?,
        },
        projection_bytes: row.try_get::<_, i64>("projection_bytes")?,
        projection: row.try_get::<_, Option<String>>("projection")?,
    };
    drop(row);
    Ok(Some(source))
}

/// A bound on the heap of a plan's key (`BundleKey::of`): its environment,
/// its rule's and policy's text, and its source id at the longest the
/// library admits; it is alive from the parse to the publication. `None`:
/// the arithmetic overflows.
pub(crate) fn key_bound(job: &Job) -> Option<u64> {
    (job.math_env.len() as u64)
        .checked_add(job.rule_plain.len() as u64)?
        .checked_add(job.policy.as_ref().map_or(0, |p| p.len() as u64))?
        .checked_add(KEY_TEXT_FIXED)
}

/// What a published plan's reservation holds beside the entry's charge: its
/// slot and its fence, each keyed by the environment.
fn publication_overhead(env: u64) -> u64 {
    (SLOT_OVERHEAD + FENCE_OVERHEAD).saturating_add(env.saturating_mul(2))
}

/// Resizes the build's one reservation to `to`: cut down when it holds at
/// least that (never refused), else grown in place; a refused grow is
/// tried once more after reclaiming and evicting one plan, never in a loop.
/// `Ok(false)`: refused, unchanged.
fn resize(cache: &RoutingPlanCache, reserved: &mut Reserved, to: u64) -> Result<bool, Poisoned> {
    if to <= reserved.bytes() {
        return reserved.shrink(to);
    }
    if reserved.grow(to)? {
        return Ok(true);
    }
    make_room(cache)?;
    reserved.grow(to)
}

/// Room for the one retry: destroys what is already retired, evicts the
/// least recently used plan, and destroys it too. An evicted plan's bytes
/// stay charged on the retired list until it is destroyed, so without the
/// second reclaim the retry could not use the room the eviction made and
/// would evict another conversation's plan for nothing.
fn make_room(cache: &RoutingPlanCache) -> Result<(), Poisoned> {
    cache.reclaim()?;
    cache.evict_lru()?;
    cache.reclaim()?;
    Ok(())
}

/// A refused grow at `step`: the reservation is released first (the caller
/// has dropped what it held), then the failure is recorded before any
/// content key, so the conversation backs off and is not read again at once
/// (releasing first leaves room for the entry's own charge).
fn step_refused(cache: &RoutingPlanCache, reserved: Reserved, job: &Job, step: Step) -> Outcome {
    drop(reserved);
    match cache.record_failure(job.wanted()) {
        Ok(_) => Outcome::StepRefused(step),
        Err(_) => Outcome::CachePoisoned,
    }
}

impl Job {
    /// The failure keyed by what the load is for, before any content.
    fn wanted(&self) -> Failure {
        Failure::BeforeRead(WantedKey {
            zid: self.zid,
            math_env: self.math_env.as_str().into(),
            desired_tick: self.desired_tick,
        })
    }
}

/// Every step after the read, on the build's one reservation, from the
/// received `bytes` of `row`'s projection to a plan ready to publish and the
/// reservation cut down to it. Each step's bound is held before the step
/// allocates; what a step no longer needs is dropped before the reservation
/// is cut down. Every refusal releases the reservation and ends in one
/// `Outcome`.
pub(crate) fn stages(
    cache: &RoutingPlanCache,
    mut reserved: Reserved,
    bytes: Vec<u8>,
    row: RowIdentity,
    job: &Job,
    hooks: &mut dyn Hooks,
) -> Result<(Reserved, CachedPlan), Outcome> {
    let limits = limits(&job.rule);
    let needs = job.rule.needs();
    let Some(key) = key_bound(job) else {
        return Err(Outcome::NoAllowance);
    };
    let content = ContentId::of(&bytes);
    let tick = row.math_tick;
    // Made only on a refusal, after the reservation is released.
    let source_key = || SourceKey {
        zid: job.zid,
        math_env: job.math_env.as_str().into(),
        math_tick: tick,
        content,
    };
    let source_refused = |reserved| {
        drop(reserved);
        let _ = cache.record_failure(Failure::Source(source_key()));
        Outcome::SourceRefused
    };
    let row_env = row.math_env.capacity() as u64;

    // 3. The bytes received, measured; the pass allocates nothing.
    let received = (bytes.capacity() as u64).saturating_add(row_env);
    match resize(cache, &mut reserved, received) {
        Ok(true) => {}
        Ok(false) => {
            drop((bytes, row));
            return Err(step_refused(cache, reserved, job, Step::Parse));
        }
        Err(_) => return Err(Outcome::CachePoisoned),
    }
    hooks.reserved(Stage::Received, reserved.bytes());
    let measure = Projection::measure(&bytes, &limits);
    let charge = measure
        .as_ref()
        .ok()
        .and_then(|m| Projection::measured_parse_reservation(m, &limits).ok());
    let (Ok(measure), Some(charge)) = (measure, charge) else {
        drop((bytes, row));
        return Err(source_refused(reserved));
    };

    // 4. The parse, under its measured charge; the key is taken from the
    // projection and the buffer dropped.
    match resize(
        cache,
        &mut reserved,
        received.saturating_add(charge).saturating_add(key),
    ) {
        Ok(true) => {}
        Ok(false) => {
            drop((bytes, row));
            return Err(step_refused(cache, reserved, job, Step::Parse));
        }
        Err(_) => return Err(Outcome::CachePoisoned),
    }
    hooks.reserved(Stage::Parsing, reserved.bytes());
    let projection = match Projection::parse_measured(&bytes, row, &limits, &measure) {
        Ok(p) => p,
        Err(_) => {
            drop(bytes);
            return Err(source_refused(reserved));
        }
    };
    hooks.reserved(Stage::Parsed, reserved.bytes());
    let bundle = BundleKey::of(
        &projection,
        &job.rule,
        job.policy.as_deref(),
        job.config_digest,
    );
    drop(bytes);

    // 5. The frames, under what the projection holds and the frames stage.
    let Ok(frames_stage) = projection.reservation(needs) else {
        drop((bundle, projection));
        return Err(source_refused(reserved));
    };
    let framing = projection
        .held()
        .saturating_add(key)
        .saturating_add(frames_stage);
    match resize(cache, &mut reserved, framing) {
        Ok(true) => {}
        Ok(false) => {
            drop((bundle, projection));
            return Err(step_refused(cache, reserved, job, Step::Frames));
        }
        Err(_) => return Err(Outcome::CachePoisoned),
    }
    hooks.reserved(Stage::Framing, reserved.bytes());
    let frames = match projection.frames(needs) {
        Ok(f) => f,
        Err(_) => {
            drop((bundle, projection));
            return Err(source_refused(reserved));
        }
    };
    hooks.reserved(Stage::Framed, reserved.bytes());
    // The frames own their data: the projection goes before the build.
    drop(projection);

    // The build, under the build stage from the frames' real counts, with
    // the plan's key, entry, slot and fence, so the cut down after it is
    // never a grow.
    let building = Plan::build_stage_bound(&job.rule, &frames.counts()).map(|b| {
        b.saturating_add(key)
            .saturating_add(ENTRY_OVERHEAD)
            .saturating_add(publication_overhead(job.math_env.len() as u64))
    });
    let resized = match building {
        Some(to) => resize(cache, &mut reserved, to),
        None => Ok(false),
    };
    match resized {
        Ok(true) => {}
        Ok(false) => {
            drop((bundle, frames));
            return Err(step_refused(cache, reserved, job, Step::Build));
        }
        Err(_) => return Err(Outcome::CachePoisoned),
    }
    hooks.reserved(Stage::Building, reserved.bytes());
    let plan = match Plan::build(&frames, &job.rule) {
        Ok(plan) => plan,
        Err(_) => {
            drop((bundle, frames));
            drop(reserved);
            let _ = cache.record_failure(Failure::Build(source_key(), job.config_digest));
            return Err(Outcome::BuildRefused);
        }
    };
    hooks.reserved(Stage::Built, reserved.bytes());
    drop(frames);

    // 6. Cut down to the plan's entry, its slot and its fence.
    let Ok(cached) = CachedPlan::new(bundle, plan, cache.reading()) else {
        return Err(Outcome::KeyMismatch);
    };
    cut_down(&mut reserved, &cached, job.math_env.len() as u64)?;
    hooks.reserved(Stage::BeforePublish, reserved.bytes());
    Ok((reserved, cached))
}

/// Cuts the build's reservation down to `cached`'s entry, its slot and its
/// fence. `Undercharged`: the entry is more than the build held.
pub(crate) fn cut_down(
    reserved: &mut Reserved,
    cached: &CachedPlan,
    env: u64,
) -> Result<(), Outcome> {
    let need = cached.charge().saturating_add(publication_overhead(env));
    match reserved.shrink(need) {
        Ok(true) => Ok(()),
        Ok(false) => Err(Outcome::Undercharged),
        Err(_) => Err(Outcome::CachePoisoned),
    }
}

/// The loader: its connectors and its one connection.
pub(crate) struct Loader {
    primary: Connector,
    replica: Option<Connector>,
    open: Option<Open>,
}

struct Open {
    target: Target,
    client: Client,
    backend: i32,
    /// The connection's buffers, charged for as long as it is open.
    _charge: Reserved,
}

impl Loader {
    /// A loader over `primary`, and `replica` if one is configured. Opens
    /// nothing until its first load.
    pub(crate) fn new(primary: Connector, replica: Option<Connector>) -> Self {
        Self {
            primary,
            replica,
            open: None,
        }
    }

    /// The server the open connection goes to, if one is open.
    pub(crate) fn open_target(&self) -> Option<Target> {
        self.open.as_ref().map(|o| o.target)
    }

    /// Closes the open connection, if any, and gives back its charge: after
    /// a build that panicked, so a half-used connection is never reused.
    pub(crate) fn close(&mut self) {
        self.open = None;
    }

    /// The open connection's server process id, if one is open.
    pub(crate) fn backend(&self) -> Option<i32> {
        self.open.as_ref().map(|o| o.backend)
    }

    /// One load of `job` into `cache`. See the module's comment for the
    /// order; every path ends in one `Outcome`.
    pub(crate) fn load(
        &mut self,
        cache: &Arc<RoutingPlanCache>,
        job: &Job,
        hooks: &mut dyn Hooks,
    ) -> Outcome {
        let wanted = job.wanted();
        if !std_bounds_reviewed() || key_bound(job).is_none() {
            return Outcome::NoAllowance;
        }
        match cache.retry_allowed(&wanted) {
            Ok(true) => {}
            Ok(false) => return Outcome::BackingOff,
            Err(_) => return Outcome::CachePoisoned,
        }
        // 1. The read only: the receive buffer.
        let limits = limits(&job.rule);
        let reserved = match cache.admit_read(limits.max_bytes, &limits) {
            Ok(Some(r)) => r,
            Ok(None) => {
                if make_room(cache).is_err() {
                    return Outcome::CachePoisoned;
                }
                match cache.admit_read(limits.max_bytes, &limits) {
                    Ok(Some(r)) => r,
                    Ok(None) => return Outcome::NotAdmitted,
                    Err(_) => return Outcome::CachePoisoned,
                }
            }
            Err(_) => return Outcome::CachePoisoned,
        };
        // 2. The fence, after reserving; then the one statement.
        let fenced = match cache.fenced(job.zid, &job.math_env) {
            Ok(f) => f,
            Err(_) => return Outcome::CachePoisoned,
        };
        let target = if fenced && self.replica.is_some() {
            Target::Replica
        } else {
            Target::Primary
        };
        hooks.at(Stage::BeforeRead, self.backend());
        let read = match self.read(cache, target, job) {
            Ok(read) => read,
            Err(outcome) => {
                drop(reserved);
                let _ = cache.record_failure(wanted);
                return outcome;
            }
        };
        let Some(source) = read else {
            drop(reserved);
            let _ = cache.record_failure(wanted);
            return Outcome::NoRow;
        };
        hooks.at(Stage::AfterRead, self.backend());
        if cache
            .note_seen(job.zid, &source.row.math_env, source.row.math_tick)
            .is_err()
        {
            return Outcome::CachePoisoned;
        }
        let Some(text) = source.projection else {
            drop(reserved);
            let _ = cache.record_failure(Failure::BeforeRead(WantedKey {
                zid: job.zid,
                math_env: job.math_env.as_str().into(),
                desired_tick: source.row.math_tick,
            }));
            return Outcome::Oversized;
        };
        // 3 to 6, on the same reservation.
        let (reserved, cached) =
            match stages(cache, reserved, text.into_bytes(), source.row, job, hooks) {
                Ok(ready) => ready,
                Err(outcome) => return outcome,
            };
        hooks.at(Stage::BeforePublish, self.backend());
        match reserved.publish(PlanRef::new(cached)) {
            Ok(()) => Outcome::Published,
            Err(rejected) => {
                let Rejected {
                    plan,
                    reservation,
                    reason,
                } = *rejected;
                match reason {
                    PublishRefused::Rejected(Rejection::FenceFull) => {
                        if cache.evict_lru().is_err() {
                            return Outcome::CachePoisoned;
                        }
                        match reservation.publish(plan) {
                            Ok(()) => Outcome::Published,
                            Err(again) => refused(*again),
                        }
                    }
                    PublishRefused::Rejected(r) => {
                        drop(plan);
                        drop(reservation);
                        Outcome::Refused(r)
                    }
                    PublishRefused::Poisoned => Outcome::CachePoisoned,
                }
            }
        }
    }

    /// The statement on the connection to `target`, opened if need be. The
    /// connection is dropped on any failure.
    fn read(
        &mut self,
        cache: &Arc<RoutingPlanCache>,
        target: Target,
        job: &Job,
    ) -> Result<Option<Source>, Outcome> {
        if self.open.as_ref().is_some_and(|o| o.target != target) {
            self.open = None;
        }
        if self.open.is_none() {
            self.open = Some(self.connect(cache, target)?);
        }
        let Some(open) = self.open.as_mut() else {
            return Err(Outcome::DatabaseUnavailable);
        };
        open.client
            .set_deadline(Some(Instant::now() + STATEMENT_TIMEOUT + IO_TIMEOUT));
        let read = read_source(
            &mut open.client,
            job.zid,
            &job.math_env,
            limits(&job.rule).max_bytes,
        );
        open.client.set_deadline(None);
        read.map_err(|e| {
            self.open = None;
            if e.code() == Some(&SqlState::QUERY_CANCELED) {
                Outcome::StatementTimeout
            } else {
                Outcome::DatabaseUnavailable
            }
        })
    }

    fn connect(&self, cache: &Arc<RoutingPlanCache>, target: Target) -> Result<Open, Outcome> {
        let connector = match target {
            Target::Primary => &self.primary,
            Target::Replica => self.replica.as_ref().unwrap_or(&self.primary),
        };
        let charge = cache
            // The largest byte bound of any rule: the driver's buffer can
            // hold one whole row of it, whichever rule reads.
            .try_reserve(CONNECTION_MAX_BYTES + CONNECTION_FIXED)
            .map_err(|_| Outcome::ConnectionNotReserved)?;
        let deadline = Instant::now() + SETUP_TIMEOUT;
        let mut client = connector
            .connect_bounded(deadline, IO_TIMEOUT)
            .map_err(|_| Outcome::DatabaseUnavailable)?;
        client
            .batch_execute(&format!(
                "SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY; \
                 SET statement_timeout = {}; SET application_name = '{APPLICATION_NAME}'",
                STATEMENT_TIMEOUT.as_millis()
            ))
            .map_err(|_| Outcome::DatabaseUnavailable)?;
        let backend = client
            .query_one("select pg_backend_pid()", &[])
            .and_then(|row| row.try_get::<_, i32>(0))
            .map_err(|_| Outcome::DatabaseUnavailable)?;
        client.set_deadline(None);
        Ok(Open {
            target,
            client,
            backend,
            _charge: charge,
        })
    }
}

fn refused(rejected: Rejected) -> Outcome {
    let Rejected {
        plan,
        reservation,
        reason,
    } = rejected;
    drop(plan);
    drop(reservation);
    match reason {
        PublishRefused::Rejected(r) => Outcome::Refused(r),
        PublishRefused::Poisoned => Outcome::CachePoisoned,
    }
}

/// The loader's thread: one OS thread of its own, named, that takes jobs
/// from a bounded channel and hands each outcome back without waiting (a
/// full outcome channel drops the outcome, never the thread). It ends when
/// every sender of `jobs` is gone. Nothing starts it yet.
pub(crate) fn spawn(
    mut loader: Loader,
    cache: Arc<RoutingPlanCache>,
    jobs: Receiver<Job>,
    outcomes: SyncSender<Outcome>,
) -> std::io::Result<std::thread::JoinHandle<()>> {
    std::thread::Builder::new()
        .name("polis-api-routing-plan-loader".into())
        .spawn(move || {
            for job in jobs {
                let outcome = loader.load(&cache, &job, &mut NoHooks);
                let _ = outcomes.try_send(outcome);
            }
        })
}
