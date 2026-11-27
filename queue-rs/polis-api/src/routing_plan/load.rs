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
//! - **Reserve before reading.** In order: the rule's build allowance (a
//!   rule with none is refused before anything is read); admission
//!   (`admit_build`: the receive buffer, the parse charge and the allowance);
//!   then `fenced`; then the read, from the primary when the conversation is
//!   unfenced, from the replica only when it is fenced and one is
//!   configured; then the build; then the same reservation cut down with
//!   `shrink` to the plan's entry, its slot and its fence; then `publish`.
//!   Admission refused: reclaim, evict one plan, try once more. `FenceFull`:
//!   evict one plan, publish once more. Never a loop.
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

use super::cache::{PlanRef, PublishRefused, Rejected, Reserved, RoutingPlanCache};
use polis_queue_adapter::jobs::transport::Connector;
use polis_routing_plan::{
    BundleKey, CachedPlan, ContentId, ENTRY_OVERHEAD, FENCE_OVERHEAD, Failure, Plan, Projection,
    Rejection, RowIdentity, RuleConfig, SLOT_OVERHEAD, SourceKey, SourceLimits, WantedKey,
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
/// `max_bytes` of the loader's own per rule, the largest for which one
/// build's admission (the receive buffer, the parse charge and the rule's
/// build allowance at that length, `admit_build`) fits one conversation's
/// share of the default budget (`loader_admission_fits_one_share` checks
/// it and prints the ask). The bounds are made from the length alone:
///
/// - parse: about 10 x the length (the walk's scratch, kept keys and
///   spill);
/// - frames: 4 x the length for their readers' scratch, and the counts a
///   source of that length can hold (every counted entry owns two bytes);
/// - stored weights and uniform: the counts' limits bind first (40,000
///   comments), about 24 MB for the stored map read and cloned;
/// - the floor: the counts bind by length; the most a byte can cost is a
///   membership entry (about 1 KB per two bytes in the frames' bound), so
///   its admission is about 520 x the length.
///
/// With a 64 MiB share: stored weights and uniform admit 2 MiB
/// (`STORED_MAX_BYTES`), the floor 96 KiB (`FLOOR_MAX_BYTES`). A larger
/// projection is `Oversized` and keeps today's draw.
pub(crate) const LIMITS: SourceLimits = SourceLimits {
    max_bytes: STORED_MAX_BYTES,
    max_depth: 32,
    max_comments: 40_000,
    max_groups: 64,
    max_cells: 40_000 * 64,
    max_memberships: 4_000_000,
};

/// The longest projection a stored-weights or uniform build reads.
pub(crate) const STORED_MAX_BYTES: u64 = 2 * 1024 * 1024;

/// The longest projection a floor build reads.
pub(crate) const FLOOR_MAX_BYTES: u64 = 96 * 1024;

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
/// reads a whole row into its buffer, so it can hold one projection of
/// `max_bytes`, plus this.
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
    /// The rule's build allowance overflows: nothing was reserved or read.
    NoAllowance,
    /// The cache's negative cache holds this load back: nothing was read.
    BackingOff,
    /// Admission was refused after reclaiming and evicting one plan.
    NotAdmitted,
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

/// Where the loader stands in one load, for a test to act between steps.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Stage {
    /// The build is admitted and the fence read; nothing is sent yet.
    BeforeRead,
    /// The row is received and owned; the connection is idle.
    AfterRead,
    /// The plan is built; the reservation is about to be cut down.
    BeforePublish,
}

pub(crate) trait Hooks {
    /// `backend`: the open connection's server process, if one is open.
    fn at(&mut self, _stage: Stage, _backend: Option<i32>) {}
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

/// The bytes a build of `rule` in `math_env` is admitted with beside its
/// receive buffer and parse charge: the rule's build allowance, and the
/// plan's entry, slot and fence. `None`: the arithmetic overflows.
pub(crate) fn allowance(rule: &RuleConfig, job: &Job) -> Option<u64> {
    let build = Plan::build_allowance(rule, &limits(rule))?;
    let env = job.math_env.len() as u64;
    let key = env
        .checked_add(job.rule_plain.len() as u64)?
        .checked_add(job.policy.as_ref().map_or(0, |p| p.len() as u64))?
        .checked_add(KEY_TEXT_FIXED)?;
    build
        .checked_add(key)?
        .checked_add(ENTRY_OVERHEAD + SLOT_OVERHEAD + FENCE_OVERHEAD)?
        .checked_add(env.checked_mul(2)?)
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
        let wanted = Failure::BeforeRead(WantedKey {
            zid: job.zid,
            math_env: job.math_env.as_str().into(),
            desired_tick: job.desired_tick,
        });
        let Some(allowance) = allowance(&job.rule, job) else {
            return Outcome::NoAllowance;
        };
        match cache.retry_allowed(&wanted) {
            Ok(true) => {}
            Ok(false) => return Outcome::BackingOff,
            Err(_) => return Outcome::CachePoisoned,
        }
        let limits = limits(&job.rule);
        let max = limits.max_bytes as usize;
        let mut reserved = match cache.admit_build(max, &limits, allowance) {
            Ok(Some(r)) => r,
            Ok(None) => {
                if cache.reclaim().is_err() || cache.evict_lru().is_err() {
                    return Outcome::CachePoisoned;
                }
                match cache.admit_build(max, &limits, allowance) {
                    Ok(Some(r)) => r,
                    Ok(None) => return Outcome::NotAdmitted,
                    Err(_) => return Outcome::CachePoisoned,
                }
            }
            Err(_) => return Outcome::CachePoisoned,
        };
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
                let _ = cache.record_failure(wanted);
                return outcome;
            }
        };
        let Some(source) = read else {
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
            let _ = cache.record_failure(Failure::BeforeRead(WantedKey {
                zid: job.zid,
                math_env: job.math_env.as_str().into(),
                desired_tick: source.row.math_tick,
            }));
            return Outcome::Oversized;
        };
        let source_key = |content: ContentId| SourceKey {
            zid: job.zid,
            math_env: source.row.math_env.as_str().into(),
            math_tick: source.row.math_tick,
            content,
        };
        let built = {
            let bytes = text.into_bytes();
            let content = ContentId::of(&bytes);
            match Projection::parse(&bytes, source.row.clone(), &limits) {
                Err(_) => Err((Outcome::SourceRefused, Failure::Source(source_key(content)))),
                Ok(projection) => match projection.frames(job.rule.needs()) {
                    Err(_) => Err((Outcome::SourceRefused, Failure::Source(source_key(content)))),
                    Ok(frames) => match Plan::build(&frames, &job.rule) {
                        Err(_) => Err((
                            Outcome::BuildRefused,
                            Failure::Build(source_key(content), job.config_digest),
                        )),
                        Ok(plan) => Ok((
                            BundleKey::of(
                                &projection,
                                &job.rule,
                                job.policy.as_deref(),
                                job.config_digest,
                            ),
                            plan,
                        )),
                    },
                },
            }
            // The bytes, the projection and the frames are freed here,
            // before the reservation is cut down.
        };
        let (key, plan) = match built {
            Ok(built) => built,
            Err((outcome, failure)) => {
                let _ = cache.record_failure(failure);
                return outcome;
            }
        };
        let Ok(cached) = CachedPlan::new(key, plan, cache.reading()) else {
            return Outcome::KeyMismatch;
        };
        let env = source.row.math_env.len() as u64;
        let need = cached
            .charge()
            .saturating_add(SLOT_OVERHEAD + FENCE_OVERHEAD)
            .saturating_add(env.saturating_mul(2));
        hooks.at(Stage::BeforePublish, self.backend());
        match reserved.shrink(need) {
            Ok(true) => {}
            Ok(false) => return Outcome::Undercharged,
            Err(_) => return Outcome::CachePoisoned,
        }
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
            // `LIMITS` has the largest byte bound of any rule.
            .try_reserve(LIMITS.max_bytes + CONNECTION_FIXED)
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
