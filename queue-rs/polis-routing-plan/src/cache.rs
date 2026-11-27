//! The byte-accounted cache of plans: the pure state machine.
//!
//! A cache, nothing more. Losing it, wholly or in part, never makes an
//! answer incorrect and never stops anything: a miss means the caller serves
//! today's draw, with the reason. It holds one conversation's plan per
//! `(conversation, environment, configuration digest, arm)`, fenced by
//! everything the plan was built from, behind a pointer that only moves
//! forward by math tick.
//!
//! This module is pure, like the rest of the crate. It has no lock, no
//! thread, no clock and no randomness of its own: every method takes
//! `&mut self` or `&self`, time arrives as a [`Monotonic`] reading the
//! caller took from its own monotonic clock, and jitter arrives as a number.
//! The caller owns the lock around it (a `try_lock` that misses with
//! [`MissReason::LockBusy`] or [`MissReason::LockPoisoned`]), and the shared
//! handle the plans live in (an `Arc` in the caller), through [`PlanHandle`].
//!
//! Every byte the cache holds is charged against one [`Budget`] while
//! anything holds it: resident plans, retired plans, slot and negative-cache
//! metadata, the retired list's own capacity, and the reservations callers
//! take before they allocate. Nothing here frees a plan on a lookup: a
//! replaced, evicted or cleared plan moves onto the retired list with its
//! charge, and only [`PlanCache::reclaim_one`], which the builder calls,
//! hands one back for destruction, and only once the cache's reference is
//! the last.
//!
//! The forward-only pointer lives in a fence per `(conversation,
//! environment)`, kept apart from the plans and across every
//! configuration: the newest tick seen, the tick last published as ready
//! and its content, and the head-lag clock. Eviction, a clear and a
//! configuration change retire plans and keep their fences, so a plan from
//! an older math update, or a second content for a tick, is refused after
//! any of them exactly as before. Fences are bounded ([`FENCE_ENTRIES`])
//! and charged ([`FENCE_OVERHEAD`]); only a fence that covers no resident
//! plan is forgotten, least recently used first, and disabling the cache
//! forgets every such fence, as a restart does. A conversation with no
//! fence is one the cache knows nothing about: see [`PlanCache::publish`]
//! for what it then requires of the caller.

use crate::identity::{ContentId, RowIdentity};
use crate::plan::{Plan, RuleConfig};
use crate::projection::Projection;
use polis_routing_equation::SourceId;
use std::collections::BTreeMap;

/// The default byte budget: 256 MiB. The largest plan measured on
/// constructed worst cases (a `symmetric-gic-floor/2` plan over 40,000
/// comments) charges about 45 MB, so the default holds four such plans,
/// each within one conversation's share. It is a ceiling on what the cache
/// may hold, not a promise that a given source can be admitted: the parse
/// charge of a large source can exceed a conversation's share, and then the
/// build is refused by the charge.
pub const DEFAULT_CACHE_BYTES: u64 = 256 * 1024 * 1024;

/// The most one conversation's resident plans may charge, and the most any
/// single reservation may be: a quarter of the budget, so no conversation
/// can hold the cache against the others.
pub const MAX_SHARE_DIVISOR: u64 = 4;

/// How many replaced or evicted plans can wait for reclamation at once. The
/// list's capacity is allocated, and charged, when the cache is made, so
/// retiring a plan never allocates.
pub const RETIRED_ENTRIES: usize = 64;

/// The retired list's bound in bytes: half of the budget.
pub const RETIRED_BYTES_DIVISOR: u64 = 2;

/// Entries in each of the three negative caches.
pub const NEGATIVE_ENTRIES: usize = 1024;

/// The first retry delay after a failure: 30 s.
pub const RETRY_BASE_NS: u64 = 30 * 1_000_000_000;

/// The longest retry delay: 30 minutes (60 times the base).
pub const RETRY_CAP_NS: u64 = 30 * 60 * 1_000_000_000;

/// What one resident or retired plan's bookkeeping is charged beyond the
/// plan itself and its key's text: the cached plan's own fields, the shared
/// handle's header and the handle held in the slot.
pub const ENTRY_OVERHEAD: u64 = 1024;

/// What one slot is charged beyond its environment's text: its share of the
/// slot map's node and of its list's capacity.
pub const SLOT_OVERHEAD: u64 = 2048;

/// What one negative-cache entry is charged beyond its environment's text.
pub const NEGATIVE_OVERHEAD: u64 = 1536;

/// What the cache itself is charged when made, beyond the retired list's
/// capacity: its maps' roots and its counters.
pub const CACHE_FIXED: u64 = 4096;

/// How many fences the cache remembers at once. A fence outlives its
/// conversation's plans; at this bound the least recently used fence that
/// covers no resident plan is forgotten to make room, and if every fence
/// covers one, a publication that needs a new fence is refused.
pub const FENCE_ENTRIES: usize = 4096;

/// What one fence is charged beyond its environment's text: its own
/// fields, its share of the fence map's node and of its list's capacity.
pub const FENCE_OVERHEAD: u64 = 512;

/// A reading of the caller's monotonic clock, in nanoseconds from an origin
/// the caller chose. Never the wall clock: the head-lag bound is a duration
/// on this clock.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Monotonic(u64);

impl Monotonic {
    pub const fn from_nanos(nanos: u64) -> Self {
        Self(nanos)
    }
    pub const fn nanos(self) -> u64 {
        self.0
    }
    /// Nanoseconds from `earlier` to `self`; zero if `earlier` is later.
    pub const fn since(self, earlier: Monotonic) -> u64 {
        self.0.saturating_sub(earlier.0)
    }
    const fn plus(self, nanos: u64) -> Monotonic {
        Monotonic(self.0.saturating_add(nanos))
    }
}

/// The assignment slot of a key. One variant today, so a later assignment
/// adds variants without reshaping the key.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Arm {
    Default,
}

/// Where a plan's meta comments came from. One variant: the `meta-tids` of
/// the same read the plan was built from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum MetaSource {
    SameRead,
}

/// Everything a plan was built from. Two plans with equal keys are built
/// from the same bytes, under the same rule, parameters and configuration.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BundleKey {
    zid: i32,
    math_env: Box<str>,
    math_tick: i64,
    content: ContentId,
    last_vote_timestamp: Option<i64>,
    source: SourceId,
    policy: Option<Box<str>>,
    meta_source: MetaSource,
    rule_canonical: Box<str>,
    config_digest: [u8; 32],
    arm: Arm,
}

impl BundleKey {
    /// The key of a plan built from `projection` under `rule` (its count
    /// policy as configured) and the configuration whose digest is
    /// `config_digest`, in the default arm.
    pub fn of(
        projection: &Projection,
        rule: &RuleConfig,
        policy: Option<&str>,
        config_digest: [u8; 32],
    ) -> Self {
        Self::from_parts(
            projection.row(),
            *projection.content(),
            projection.source().clone(),
            rule,
            policy,
            config_digest,
        )
    }

    fn from_parts(
        row: &RowIdentity,
        content: ContentId,
        source: SourceId,
        rule: &RuleConfig,
        policy: Option<&str>,
        config_digest: [u8; 32],
    ) -> Self {
        Self {
            zid: row.zid,
            math_env: row.math_env.as_str().into(),
            math_tick: row.math_tick,
            content,
            last_vote_timestamp: row.last_vote_timestamp,
            source,
            policy: policy.map(Into::into),
            meta_source: MetaSource::SameRead,
            rule_canonical: rule.to_plain().into_boxed_str(),
            config_digest,
            arm: Arm::Default,
        }
    }

    pub fn zid(&self) -> i32 {
        self.zid
    }
    pub fn math_env(&self) -> &str {
        &self.math_env
    }
    pub fn math_tick(&self) -> i64 {
        self.math_tick
    }
    pub fn content(&self) -> &ContentId {
        &self.content
    }
    pub fn last_vote_timestamp(&self) -> Option<i64> {
        self.last_vote_timestamp
    }
    pub fn source(&self) -> &SourceId {
        &self.source
    }
    pub fn policy(&self) -> Option<&str> {
        self.policy.as_deref()
    }
    pub fn meta_source(&self) -> MetaSource {
        self.meta_source
    }
    pub fn rule_canonical(&self) -> &str {
        &self.rule_canonical
    }
    pub fn config_digest(&self) -> &[u8; 32] {
        &self.config_digest
    }
    pub fn arm(&self) -> Arm {
        self.arm
    }

    fn text_bytes(&self) -> u64 {
        let policy = self.policy.as_deref().map_or(0, str::len);
        (self.math_env.len() + self.rule_canonical.len() + policy + self.source.as_str().len())
            as u64
    }
}

/// A plan with its key and when it was built.
#[derive(Debug)]
pub struct CachedPlan {
    key: BundleKey,
    plan: Plan,
    built_at: Monotonic,
}

/// Why a plan cannot be cached under a key.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeyMismatch {
    /// The plan names a different read than the key.
    Source,
    /// The plan is of a different rule than the key.
    Rule,
}

impl CachedPlan {
    /// A plan and its key, if the plan was built from the key's read and is
    /// of the key's rule: a plan from another math update, rule or read can
    /// never be filed under this key.
    pub fn new(key: BundleKey, plan: Plan, built_at: Monotonic) -> Result<Self, KeyMismatch> {
        if plan.source() != &key.source {
            return Err(KeyMismatch::Source);
        }
        let kind = RuleConfig::parse(&key.rule_canonical, key.policy.as_deref())
            .ok()
            .map(|rule| rule_kind(&rule));
        if kind != Some(plan.kind()) {
            return Err(KeyMismatch::Rule);
        }
        Ok(Self {
            key,
            plan,
            built_at,
        })
    }
    pub fn key(&self) -> &BundleKey {
        &self.key
    }
    pub fn plan(&self) -> &Plan {
        &self.plan
    }
    pub fn built_at(&self) -> Monotonic {
        self.built_at
    }
    /// What this entry is charged while anything holds it: the plan's own
    /// charge, its key's text and [`ENTRY_OVERHEAD`]; saturating, so a charge
    /// that cannot be represented is refused by the budget.
    pub fn charge(&self) -> u64 {
        (self.plan.charged_bytes() as u64)
            .saturating_add(self.key.text_bytes())
            .saturating_add(ENTRY_OVERHEAD)
    }
}

fn rule_kind(rule: &RuleConfig) -> crate::plan::PlanKind {
    use crate::plan::PlanKind;
    match rule {
        RuleConfig::StoredWeights1 => PlanKind::StoredWeights,
        RuleConfig::Uniform1 => PlanKind::Uniform,
        RuleConfig::SymmetricGicFloor2(_) => PlanKind::Floor,
    }
}

/// The caller's shared handle to a cached plan (an `Arc<CachedPlan>` in the
/// caller). Cloning it must not allocate, and dropping a clone that is not
/// the last must not free the plan.
pub trait PlanHandle: Clone {
    fn cached(&self) -> &CachedPlan;
    /// True when this handle is the only reference left.
    fn sole_owner(&self) -> bool;
}

/// The configuration a request captured once, before any lookup, and holds
/// unchanged for the whole request.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ConfigCapture {
    digest: [u8; 32],
    head_lag_bound_ns: u64,
}

impl ConfigCapture {
    pub const fn new(digest: [u8; 32], head_lag_bound_ns: u64) -> Self {
        Self {
            digest,
            head_lag_bound_ns,
        }
    }
    pub const fn digest(&self) -> &[u8; 32] {
        &self.digest
    }
    pub const fn head_lag_bound_ns(&self) -> u64 {
        self.head_lag_bound_ns
    }
}

/// Bytes taken from the budget before they are allocated. It is linear: it
/// cannot be cloned, and its bytes return only through [`PlanCache::release`]
/// or by becoming a published plan's charge. One that is dropped instead
/// keeps its bytes charged for the cache's life: an over-charge, never an
/// under-charge. It remembers when it was taken, so a build that began
/// before the cache forgot a fence cannot publish into a conversation the
/// cache no longer holds a fence for.
#[must_use = "a reservation's bytes return only through PlanCache::release"]
#[derive(Debug, PartialEq, Eq)]
pub struct Reservation {
    bytes: u64,
    taken: u64,
}

impl Reservation {
    pub fn bytes(&self) -> u64 {
        self.bytes
    }
}

/// One byte budget. Pure arithmetic: what is charged, never what the
/// allocator holds.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Budget {
    limit: u64,
    used: u64,
}

impl Budget {
    fn new(limit: u64) -> Option<Self> {
        (limit > 0).then_some(Self { limit, used: 0 })
    }
    fn try_take(&mut self, n: u64) -> bool {
        match self.used.checked_add(n) {
            Some(total) if total <= self.limit => {
                self.used = total;
                true
            }
            _ => false,
        }
    }
    fn give_back(&mut self, n: u64) {
        self.used = self.used.saturating_sub(n);
    }
    pub fn limit(&self) -> u64 {
        self.limit
    }
    pub fn used(&self) -> u64 {
        self.used
    }
    pub fn available(&self) -> u64 {
        self.limit.saturating_sub(self.used)
    }
}

/// How fresh a hit is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Freshness {
    /// The plan's tick is the newest seen.
    Current,
    /// The plan's tick is newer than the request's own snapshot; it is
    /// served under its own, newer identity.
    AheadOfRequest,
    /// A newer tick has been seen, for less than the head-lag bound.
    Lagging { behind_ns: u64 },
}

/// Why a lookup missed. Every miss is today's draw, with this reason.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MissReason {
    NoPlan,
    HeadLag,
    /// Returned by the caller's lock: the lock was held.
    LockBusy,
    /// Returned by the caller's lock: the lock was poisoned.
    LockPoisoned,
    RefusedSource,
    ConfigDisabled,
}

impl MissReason {
    pub fn name(self) -> &'static str {
        match self {
            MissReason::NoPlan => "no_plan",
            MissReason::HeadLag => "head_lag",
            MissReason::LockBusy => "lock_busy",
            MissReason::LockPoisoned => "lock_poisoned",
            MissReason::RefusedSource => "refused_source",
            MissReason::ConfigDisabled => "config_disabled",
        }
    }
}

#[derive(Debug)]
pub enum Lookup<H> {
    Hit { plan: H, freshness: Freshness },
    Miss(MissReason),
}

/// Why a publication was not taken. The plan and its reservation go back
/// to the builder, which drops the plan and then releases the reservation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Rejection {
    /// Its tick is older than the ready plan's, or it is the ready plan's
    /// key again.
    Superseded,
    /// Its configuration is no longer the current one.
    Discarded,
    /// A different content for a tick that already has a plan: one
    /// `(conversation, environment, tick)` is immutable. Counted.
    GenerationConflict,
    /// The retired list has no room for the plan it would replace.
    Busy,
    /// The conversation would hold more than its share.
    OverShare,
    /// The reservation is smaller than the entry's charge (with its fence's,
    /// when the conversation has none yet).
    Undercharged,
    /// The cache holds no fence for the conversation and the reservation
    /// was taken before the cache last forgot one: the plan could be older
    /// than what that fence held. A fresh reservation, for a fresh read,
    /// may publish.
    FenceForgotten,
    /// The cache holds no fence for the conversation and cannot remember
    /// one: [`FENCE_ENTRIES`] are held and every one covers a resident plan.
    /// Nothing is published that the cache could not fence; the
    /// conversation misses `no_plan` until a plan is evicted and a later
    /// publication finds room.
    FenceFull,
}

#[derive(Debug)]
pub enum Published<H> {
    Ready,
    Rejected {
        handle: H,
        reservation: Reservation,
        reason: Rejection,
    },
}

/// A retired plan the cache no longer references, handed to the builder to
/// destroy. Its bytes are still charged until [`PlanCache::credit`].
#[derive(Debug)]
pub struct Reclaim<H> {
    handle: H,
    bytes: u64,
}

impl<H> Reclaim<H> {
    /// Drops the plan (the last reference) and returns the receipt that
    /// gives its bytes back.
    pub fn destroy(self) -> Freed {
        let Reclaim { handle, bytes } = self;
        drop(handle);
        Freed { bytes }
    }
    pub fn bytes(&self) -> u64 {
        self.bytes
    }
}

/// Proof that a reclaimed plan was dropped.
#[must_use = "a freed plan's bytes return only through PlanCache::credit"]
#[derive(Debug, PartialEq, Eq)]
pub struct Freed {
    bytes: u64,
}

/// What a clear, a configuration change or an eviction moved.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Moved {
    /// Plans moved to the retired list.
    pub retired: usize,
    /// Plans kept in place because the retired list had no room.
    pub kept: usize,
}

/// A failure the negative cache remembers, with the key it is held under.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Failure {
    /// The source itself was refused: not keyed by configuration.
    Source(SourceKey),
    /// The build was refused: keyed by the source and the configuration.
    Build(SourceKey, [u8; 32]),
    /// Nothing was read: keyed by the tick that was wanted.
    BeforeRead(WantedKey),
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct SourceKey {
    pub zid: i32,
    pub math_env: Box<str>,
    pub math_tick: i64,
    pub content: ContentId,
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct WantedKey {
    pub zid: i32,
    pub math_env: Box<str>,
    pub desired_tick: i64,
}

impl Failure {
    fn zid_env_tick(&self) -> (i32, &str, i64) {
        match self {
            Failure::Source(k) | Failure::Build(k, _) => (k.zid, &k.math_env, k.math_tick),
            Failure::BeforeRead(k) => (k.zid, &k.math_env, k.desired_tick),
        }
    }
    fn charge(&self) -> u64 {
        NEGATIVE_OVERHEAD + self.zid_env_tick().1.len() as u64
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Negative {
    failures: u32,
    retry_at: Monotonic,
    seq: u64,
    charge: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Recorded {
    /// Held, with the next retry at this reading.
    Held { retry_at: Monotonic },
    /// The budget had no room; nothing is remembered.
    NoRoom,
}

/// The retry delay after `failures` failures: 30 s doubled per failure up
/// to 30 minutes, plus up to a quarter of it from the caller's jitter (in
/// thousandths, clamped to 1,000).
pub fn retry_delay_ns(failures: u32, jitter_permille: u16) -> u64 {
    let shift = failures.saturating_sub(1).min(16);
    let delay = RETRY_BASE_NS
        .saturating_mul(1u64 << shift)
        .min(RETRY_CAP_NS);
    let jitter = (delay / 4).saturating_mul(u64::from(jitter_permille.min(1000))) / 1000;
    delay.saturating_add(jitter)
}

#[derive(Debug)]
struct Slot<H> {
    env: Box<str>,
    ready: H,
    ready_charge: u64,
    meta_charge: u64,
    stamp: u64,
}

impl<H: PlanHandle> Slot<H> {
    fn ready_tick(&self) -> i64 {
        self.ready.cached().key.math_tick
    }
}

/// What the cache remembers of one `(conversation, environment)`, across
/// every configuration and for longer than any of its plans.
#[derive(Debug)]
struct Fence {
    env: Box<str>,
    /// The newest tick ever published as ready, and its content.
    ready_tick: i64,
    ready_content: ContentId,
    ready_vote_timestamp: Option<i64>,
    newest_seen: i64,
    first_seen_ahead: Option<Monotonic>,
    stamp: u64,
    charge: u64,
}

impl Fence {
    /// Whether `key` is the content this fence holds for its ready tick.
    fn holds(&self, key: &BundleKey) -> bool {
        self.ready_content == key.content && self.ready_vote_timestamp == key.last_vote_timestamp
    }
    /// Advances the newest seen tick by maximum and keeps the head-lag
    /// clock: started at the first sight of a tick ahead of the ready tick,
    /// never reset by repeats or partial catch-up, cleared only when the
    /// ready tick has caught up.
    fn see(&mut self, tick: i64, now: Monotonic) {
        if tick > self.newest_seen {
            self.newest_seen = tick;
        }
        if self.newest_seen > self.ready_tick {
            if self.first_seen_ahead.is_none() {
                self.first_seen_ahead = Some(now);
            }
        } else {
            self.first_seen_ahead = None;
        }
    }
    fn mark_ready(&mut self, ready: Ready, now: Monotonic, stamp: u64) {
        self.ready_tick = ready.tick;
        self.ready_content = ready.content;
        self.ready_vote_timestamp = ready.vote_timestamp;
        self.stamp = stamp;
        self.see(ready.tick, now);
    }
}

/// The part of a key a fence keeps.
#[derive(Clone, Copy, Debug)]
struct Ready {
    tick: i64,
    content: ContentId,
    vote_timestamp: Option<i64>,
}

/// Whether a resident plan of `(zid, env)`, under any configuration, is
/// covered by its fence.
fn covers_a_plan<H>(slots: &BTreeMap<SlotId, Vec<Slot<H>>>, zid: i32, env: &str) -> bool {
    slots
        .range((zid, [0u8; 32], Arm::Default)..=(zid, [u8::MAX; 32], Arm::Default))
        .any(|(_, list)| list.iter().any(|s| &*s.env == env))
}

#[derive(Debug)]
struct Retired<H> {
    handle: H,
    bytes: u64,
}

type SlotId = (i32, [u8; 32], Arm);

/// The cache. See the module's documentation.
#[derive(Debug)]
pub struct PlanCache<H> {
    budget: Budget,
    current: Option<[u8; 32]>,
    slots: BTreeMap<SlotId, Vec<Slot<H>>>,
    retired: Vec<Retired<H>>,
    retired_bytes: u64,
    negatives: BTreeMap<Failure, Negative>,
    fences: BTreeMap<i32, Vec<Fence>>,
    fence_count: usize,
    /// The sequence number at which a fence was last forgotten (0: never).
    forgot_at: u64,
    seq: u64,
    conflicts: u64,
}

impl<H: PlanHandle> PlanCache<H> {
    /// A cache with a budget of `budget_bytes` and the configuration whose
    /// digest is `current` (`None`: disabled). `None` if the budget is zero
    /// or cannot hold the cache's own fixed charge.
    pub fn new(budget_bytes: u64, current: Option<[u8; 32]>) -> Option<Self> {
        let mut budget = Budget::new(budget_bytes)?;
        let retired_capacity = (RETIRED_ENTRIES * size_of::<Retired<H>>()) as u64;
        if !budget.try_take(CACHE_FIXED.saturating_add(retired_capacity)) {
            return None;
        }
        Some(Self {
            budget,
            current,
            slots: BTreeMap::new(),
            retired: Vec::with_capacity(RETIRED_ENTRIES),
            retired_bytes: 0,
            negatives: BTreeMap::new(),
            fences: BTreeMap::new(),
            fence_count: 0,
            forgot_at: 0,
            seq: 0,
            conflicts: 0,
        })
    }

    /// How many fences are held.
    pub fn fence_len(&self) -> usize {
        self.fence_count
    }
    /// Whether the cache holds a fence for `(zid, env)`. With none, the
    /// first publication is taken on the caller's word that it is current
    /// (see [`PlanCache::publish`]).
    pub fn fenced(&self, zid: i32, env: &str) -> bool {
        self.fences
            .get(&zid)
            .is_some_and(|l| l.iter().any(|f| &*f.env == env))
    }

    pub fn budget(&self) -> &Budget {
        &self.budget
    }
    /// The most one conversation's resident plans may charge, and the most
    /// one reservation may be.
    pub fn max_share(&self) -> u64 {
        self.budget.limit / MAX_SHARE_DIVISOR
    }
    pub fn retired_max_bytes(&self) -> u64 {
        self.budget.limit / RETIRED_BYTES_DIVISOR
    }
    pub fn retired_len(&self) -> usize {
        self.retired.len()
    }
    pub fn retired_bytes(&self) -> u64 {
        self.retired_bytes
    }
    pub fn resident_len(&self) -> usize {
        self.slots.values().map(Vec::len).sum()
    }
    /// How many publications were refused as a second content for one
    /// tick.
    pub fn generation_conflicts(&self) -> u64 {
        self.conflicts
    }
    pub fn current(&self) -> Option<&[u8; 32]> {
        self.current.as_ref()
    }

    /// Takes `n` bytes from the budget, or `None` at once: if they do not
    /// fit, or `n` is more than one conversation's share. Never waits.
    pub fn try_reserve(&mut self, n: u64) -> Option<Reservation> {
        if n > self.max_share() || !self.budget.try_take(n) {
            return None;
        }
        self.seq = self.seq.saturating_add(1);
        Some(Reservation {
            bytes: n,
            taken: self.seq,
        })
    }

    /// Gives a reservation's bytes back.
    pub fn release(&mut self, reservation: Reservation) {
        self.budget.give_back(reservation.bytes);
    }

    /// A build's admission, before anything is read or allocated: the
    /// receive buffer for a source of `len` bytes, the parse charge for it
    /// under `limits`, and `allowance` for the build's own scratch and the
    /// plan it makes. Refused at once if the source is over `max_bytes`, the
    /// parse charge cannot be made, or the sum does not fit the budget or one
    /// conversation's share. The default 64 MiB `max_bytes` is not an
    /// admission promise: the parse charge of a source that large is far
    /// above one share, so it is refused by the charge.
    pub fn admit_build(
        &mut self,
        len: usize,
        limits: &crate::limits::SourceLimits,
        allowance: u64,
    ) -> Option<Reservation> {
        if u64::try_from(len).ok()? > limits.max_bytes {
            return None;
        }
        let parse = Projection::parse_reservation(len, limits).ok()?;
        let total = parse.checked_add(len as u64)?.checked_add(allowance)?;
        self.try_reserve(total)
    }

    /// Looks up the plan to serve for `(zid, env)` under the request's
    /// captured configuration. `seen_tick` is the math tick the request
    /// read, if it read one; `None` advances nothing and starts no clock.
    ///
    /// It reads the fence and the slot, updates their counters and clones
    /// one handle: nothing is allocated or freed. A fence with no plan
    /// still takes the seen tick, in place, so its clock runs while the
    /// plan is rebuilt. A plan older than its fence's ready tick (one kept
    /// under another configuration while a newer one was published) is
    /// never served, and a reading earlier than the head-lag clock's start
    /// cannot show that the bound has not passed, so both miss `head_lag`.
    pub fn lookup(
        &mut self,
        capture: &ConfigCapture,
        zid: i32,
        env: &str,
        seen_tick: Option<i64>,
        now: Monotonic,
    ) -> Lookup<H> {
        if self.current.as_ref() != Some(&capture.digest) {
            return Lookup::Miss(MissReason::ConfigDisabled);
        }
        self.seq = self.seq.saturating_add(1);
        let stamp = self.seq;
        let fence = self
            .fences
            .get_mut(&zid)
            .and_then(|list| list.iter_mut().find(|f| &*f.env == env));
        let Some(fence) = fence else {
            // No fence: no plan either (a resident plan always has one).
            return Lookup::Miss(self.no_plan_reason(zid, env, seen_tick));
        };
        fence.stamp = stamp;
        if let Some(tick) = seen_tick {
            fence.see(tick, now);
        }
        let slot = self
            .slots
            .get_mut(&(zid, capture.digest, Arm::Default))
            .and_then(|list| list.iter_mut().find(|s| &*s.env == env));
        let Some(slot) = slot else {
            return Lookup::Miss(self.no_plan_reason(zid, env, seen_tick));
        };
        slot.stamp = stamp;
        let ready_tick = slot.ready_tick();
        if ready_tick < fence.ready_tick {
            return Lookup::Miss(MissReason::HeadLag);
        }
        let freshness = if ready_tick >= fence.newest_seen {
            match seen_tick {
                Some(t) if ready_tick > t => Freshness::AheadOfRequest,
                _ => Freshness::Current,
            }
        } else {
            match fence.first_seen_ahead {
                Some(start) if now >= start && now.since(start) < capture.head_lag_bound_ns => {
                    Freshness::Lagging {
                        behind_ns: now.since(start),
                    }
                }
                _ => return Lookup::Miss(MissReason::HeadLag),
            }
        };
        Lookup::Hit {
            plan: slot.ready.clone(),
            freshness,
        }
    }

    fn no_plan_reason(&self, zid: i32, env: &str, seen_tick: Option<i64>) -> MissReason {
        let Some(tick) = seen_tick else {
            return MissReason::NoPlan;
        };
        let refused = self.negatives.keys().any(|f| match f {
            Failure::Source(k) => k.zid == zid && &*k.math_env == env && k.math_tick == tick,
            Failure::Build(..) | Failure::BeforeRead(_) => false,
        });
        if refused {
            MissReason::RefusedSource
        } else {
            MissReason::NoPlan
        }
    }

    /// The loader saw `tick` for `(zid, env)`: the newest seen tick of its
    /// fence advances by maximum, whatever plans it holds. A conversation
    /// with no fence records nothing.
    pub fn note_seen(&mut self, zid: i32, env: &str, tick: i64, now: Monotonic) {
        if let Some(fence) = self
            .fences
            .get_mut(&zid)
            .and_then(|list| list.iter_mut().find(|f| &*f.env == env))
        {
            fence.see(tick, now);
        }
    }

    /// Publishes a built plan under the reservation the builder took for it.
    /// The pointer moves only forward by tick; a plan from an older tick, a
    /// configuration no longer current, or a second content for one tick is
    /// refused, and the existing plan stays in place.
    ///
    /// The tick and content checks are made against the conversation's
    /// fence, which outlives its plans, so they hold after an eviction, a
    /// clear or a configuration change. A conversation with no fence (new,
    /// or forgotten, or after a restart) is one the cache knows nothing
    /// about, and its first publication sets the fence: the cache takes it
    /// on the caller's word that the plan was built from a read of the
    /// newest math update (the primary, never a replica that may lag),
    /// taken after the plan's reservation. A reservation taken before the
    /// cache last forgot a fence is refused for such a conversation
    /// ([`Rejection::FenceForgotten`]), so a build that began before the
    /// forgetting cannot publish an older update into the gap.
    pub fn publish(&mut self, handle: H, reservation: Reservation, now: Monotonic) -> Published<H> {
        let (zid, digest, ready, env_len) = {
            let key = &handle.cached().key;
            (
                key.zid,
                key.config_digest,
                Ready {
                    tick: key.math_tick,
                    content: key.content,
                    vote_timestamp: key.last_vote_timestamp,
                },
                key.math_env.len(),
            )
        };
        let tick = ready.tick;
        let reject = |handle, reservation, reason| Published::Rejected {
            handle,
            reservation,
            reason,
        };
        if self.current != Some(digest) {
            return reject(handle, reservation, Rejection::Discarded);
        }
        let fence_at = self.fences.get(&zid).and_then(|list| {
            list.iter()
                .position(|f| *f.env == *handle.cached().key.math_env)
        });
        let fence_need = match fence_at.and_then(|i| self.fences.get(&zid)?.get(i)) {
            Some(fence) => {
                if tick < fence.ready_tick {
                    return reject(handle, reservation, Rejection::Superseded);
                }
                if tick == fence.ready_tick && !fence.holds(&handle.cached().key) {
                    self.conflicts = self.conflicts.saturating_add(1);
                    return reject(handle, reservation, Rejection::GenerationConflict);
                }
                0
            }
            None => {
                if reservation.taken < self.forgot_at {
                    return reject(handle, reservation, Rejection::FenceForgotten);
                }
                if self.fence_count >= FENCE_ENTRIES && self.forgettable_fence().is_none() {
                    return reject(handle, reservation, Rejection::FenceFull);
                }
                FENCE_OVERHEAD + env_len as u64
            }
        };
        let charge = handle.cached().charge();
        let resident = self.resident_charge(zid);
        let max_share = self.max_share();
        let retired_room = RETIRED_ENTRIES.saturating_sub(self.retired.len());
        let retired_bytes_room = self.retired_max_bytes().saturating_sub(self.retired_bytes);
        let id = (zid, digest, Arm::Default);
        let existing = self.slots.get_mut(&id).and_then(|list| {
            list.iter_mut()
                .find(|s| *s.env == *handle.cached().key.math_env)
        });
        match existing {
            Some(slot) => {
                let ready_tick = slot.ready_tick();
                if tick < ready_tick {
                    return reject(handle, reservation, Rejection::Superseded);
                }
                if tick == ready_tick {
                    if handle.cached().key == slot.ready.cached().key {
                        return reject(handle, reservation, Rejection::Superseded);
                    }
                    self.conflicts = self.conflicts.saturating_add(1);
                    return reject(handle, reservation, Rejection::GenerationConflict);
                }
                if retired_room == 0 || slot.ready_charge > retired_bytes_room {
                    return reject(handle, reservation, Rejection::Busy);
                }
                if resident
                    .saturating_sub(slot.ready_charge)
                    .saturating_add(charge)
                    > max_share
                {
                    return reject(handle, reservation, Rejection::OverShare);
                }
                let need = charge.saturating_add(fence_need);
                if reservation.bytes < need {
                    return reject(handle, reservation, Rejection::Undercharged);
                }
                let excess = reservation.bytes - need;
                let new_env = fence_at
                    .is_none()
                    .then(|| handle.cached().key.math_env.clone());
                let old = std::mem::replace(&mut slot.ready, handle);
                let old_bytes = std::mem::replace(&mut slot.ready_charge, charge);
                self.budget.give_back(excess);
                self.retire(old, old_bytes);
                self.seq = self.seq.saturating_add(1);
                let stamp = self.seq;
                self.fence_ready(zid, fence_at, new_env, ready, fence_need, now, stamp);
                Published::Ready
            }
            None => {
                let meta = SLOT_OVERHEAD + env_len as u64;
                let entry = charge.saturating_add(meta);
                if resident.saturating_add(entry) > max_share {
                    return reject(handle, reservation, Rejection::OverShare);
                }
                let need = entry.saturating_add(fence_need);
                if reservation.bytes < need {
                    return reject(handle, reservation, Rejection::Undercharged);
                }
                let excess = reservation.bytes - need;
                self.budget.give_back(excess);
                let env: Box<str> = handle.cached().key.math_env.clone();
                let new_env = fence_at.is_none().then(|| env.clone());
                self.seq = self.seq.saturating_add(1);
                let stamp = self.seq;
                self.slots.entry(id).or_default().push(Slot {
                    env,
                    ready: handle,
                    ready_charge: charge,
                    meta_charge: meta,
                    stamp,
                });
                self.fence_ready(zid, fence_at, new_env, ready, fence_need, now, stamp);
                Published::Ready
            }
        }
    }

    /// Moves the fence of `(zid, env)` to a newly ready plan, or makes it,
    /// forgetting the least recently used idle fence first if the
    /// fence table is full (the caller has checked that one exists).
    #[allow(clippy::too_many_arguments)]
    fn fence_ready(
        &mut self,
        zid: i32,
        at: Option<usize>,
        new_env: Option<Box<str>>,
        ready: Ready,
        charge: u64,
        now: Monotonic,
        stamp: u64,
    ) {
        if let Some(fence) = at.and_then(|i| self.fences.get_mut(&zid)?.get_mut(i)) {
            fence.mark_ready(ready, now, stamp);
            return;
        }
        let Some(env) = new_env else { return };
        if self.fence_count >= FENCE_ENTRIES {
            if let Some((z, i)) = self.forgettable_fence() {
                self.forget_fence(z, i);
            }
        }
        let mut fence = Fence {
            env,
            ready_tick: ready.tick,
            ready_content: ready.content,
            ready_vote_timestamp: ready.vote_timestamp,
            newest_seen: ready.tick,
            first_seen_ahead: None,
            stamp,
            charge,
        };
        fence.see(ready.tick, now);
        self.fences.entry(zid).or_default().push(fence);
        self.fence_count += 1;
    }

    /// The least recently used fence that covers no resident plan.
    fn forgettable_fence(&self) -> Option<(i32, usize)> {
        let slots = &self.slots;
        self.fences
            .iter()
            .flat_map(|(z, list)| list.iter().enumerate().map(move |(i, f)| (*z, i, f)))
            .filter(|(z, _, f)| !covers_a_plan(slots, *z, &f.env))
            .min_by_key(|(z, i, f)| (f.stamp, *z, *i))
            .map(|(z, i, _)| (z, i))
    }

    fn forget_fence(&mut self, zid: i32, index: usize) {
        let Some(list) = self.fences.get_mut(&zid) else {
            return;
        };
        if index >= list.len() {
            return;
        }
        let fence = list.swap_remove(index);
        if list.is_empty() {
            self.fences.remove(&zid);
        }
        self.budget.give_back(fence.charge);
        self.fence_count = self.fence_count.saturating_sub(1);
        self.seq = self.seq.saturating_add(1);
        self.forgot_at = self.seq;
    }

    /// Forgets every fence that covers no resident plan, as a restart does.
    fn forget_idle_fences(&mut self) {
        let slots = &self.slots;
        let (mut freed, mut forgot) = (0u64, 0usize);
        for (zid, list) in &mut self.fences {
            list.retain(|f| {
                let keep = covers_a_plan(slots, *zid, &f.env);
                if !keep {
                    freed = freed.saturating_add(f.charge);
                    forgot += 1;
                }
                keep
            });
        }
        self.fences.retain(|_, list| !list.is_empty());
        if forgot > 0 {
            self.budget.give_back(freed);
            self.fence_count = self.fence_count.saturating_sub(forgot);
            self.seq = self.seq.saturating_add(1);
            self.forgot_at = self.seq;
        }
    }

    fn resident_charge(&self, zid: i32) -> u64 {
        self.slots
            .range((zid, [0u8; 32], Arm::Default)..=(zid, [u8::MAX; 32], Arm::Default))
            .flat_map(|(_, list)| list.iter())
            .map(|s| s.ready_charge.saturating_add(s.meta_charge))
            .fold(0u64, u64::saturating_add)
    }

    /// Callers check the room first; retiring never allocates (the list's
    /// capacity was allocated when the cache was made).
    fn retire(&mut self, handle: H, bytes: u64) {
        self.retired_bytes = self.retired_bytes.saturating_add(bytes);
        self.retired.push(Retired { handle, bytes });
    }

    /// Moves the least recently looked-up plan, across every conversation,
    /// onto the retired list with its slot's charge, if `filter` admits it.
    /// Ties fall to the slot map's order. Refused, keeping the plan where
    /// it is, if the retired list has no room: eviction never discards the
    /// last owner a reader does not hold.
    fn retire_oldest(&mut self, filter: impl Fn(&SlotId) -> bool) -> Option<bool> {
        let (id, env_index) = self
            .slots
            .iter()
            .filter(|(id, _)| filter(id))
            .flat_map(|(id, list)| list.iter().enumerate().map(move |(i, s)| (s.stamp, *id, i)))
            .min_by_key(|(stamp, id, i)| (*stamp, *id, *i))
            .map(|(_, id, i)| (id, i))?;
        let bytes = {
            let slot = self.slots.get(&id)?.get(env_index)?;
            slot.ready_charge.saturating_add(slot.meta_charge)
        };
        if self.retired.len() >= RETIRED_ENTRIES
            || self.retired_bytes.saturating_add(bytes) > self.retired_max_bytes()
        {
            return Some(false);
        }
        let list = self.slots.get_mut(&id)?;
        let slot = list.swap_remove(env_index);
        if list.is_empty() {
            self.slots.remove(&id);
        }
        self.retire(slot.ready, bytes);
        Some(true)
    }

    /// Evicts the least recently looked-up plan. `Some(true)`: moved to the
    /// retired list; `Some(false)`: kept, the retired list is full; `None`:
    /// nothing resident.
    pub fn evict_lru(&mut self) -> Option<bool> {
        self.retire_oldest(|_| true)
    }

    /// Moves every resident plan the retired list has room for onto it,
    /// least recently looked up first; the rest stay resident.
    pub fn clear(&mut self) -> Moved {
        self.retire_all(|_| true)
    }

    fn retire_all(&mut self, filter: impl Fn(&SlotId) -> bool + Copy) -> Moved {
        let mut moved = Moved::default();
        while let Some(true) = self.retire_oldest(filter) {
            moved.retired += 1;
        }
        moved.kept = self
            .slots
            .iter()
            .filter(|(id, _)| filter(id))
            .map(|(_, l)| l.len())
            .sum();
        moved
    }

    /// Makes `digest` the current configuration (`None`: disabled, and at
    /// shutdown). From now on lookups under any other digest miss with
    /// `config_disabled` and publications under it are discarded; plans of
    /// other configurations move to the retired list as room allows (call
    /// again after reclaiming to move the rest), and build refusals held
    /// under other configurations are forgotten. A new configuration keeps
    /// every fence, so it can never publish an older math update than one
    /// already published; disabling (`None`) forgets every fence that
    /// covers no plan still resident, as a restart does.
    pub fn set_config(&mut self, digest: Option<[u8; 32]>) -> Moved {
        self.current = digest;
        let mut freed = 0u64;
        self.negatives.retain(|f, n| match f {
            Failure::Build(_, d) if Some(*d) != digest => {
                freed = freed.saturating_add(n.charge);
                false
            }
            _ => true,
        });
        self.budget.give_back(freed);
        let moved = self.retire_all(|id| Some(id.1) != digest);
        if digest.is_none() {
            self.forget_idle_fences();
        }
        moved
    }

    /// Hands back one retired plan whose only remaining reference is the
    /// cache's, for the builder to destroy; `None` if none is. A retired
    /// plan is never reachable from a lookup, so once it is the sole owner
    /// nothing can borrow it again.
    pub fn reclaim_one(&mut self) -> Option<Reclaim<H>> {
        let index = self.retired.iter().position(|r| r.handle.sole_owner())?;
        let Retired { handle, bytes } = self.retired.swap_remove(index);
        self.retired_bytes = self.retired_bytes.saturating_sub(bytes);
        Some(Reclaim { handle, bytes })
    }

    /// Gives a destroyed plan's bytes back.
    pub fn credit(&mut self, freed: Freed) {
        self.budget.give_back(freed.bytes);
    }

    /// Remembers a failure, with capped exponential backoff from 30 s and
    /// the caller's jitter. A full map forgets its oldest entry first.
    pub fn record_failure(
        &mut self,
        failure: Failure,
        now: Monotonic,
        jitter_permille: u16,
    ) -> Recorded {
        if let Some(entry) = self.negatives.get_mut(&failure) {
            entry.failures = entry.failures.saturating_add(1);
            entry.retry_at = now.plus(retry_delay_ns(entry.failures, jitter_permille));
            return Recorded::Held {
                retry_at: entry.retry_at,
            };
        }
        let kind = std::mem::discriminant(&failure);
        let of_kind = self
            .negatives
            .keys()
            .filter(|f| std::mem::discriminant(*f) == kind)
            .count();
        if of_kind >= NEGATIVE_ENTRIES {
            let oldest = self
                .negatives
                .iter()
                .filter(|(f, _)| std::mem::discriminant(*f) == kind)
                .min_by_key(|(_, n)| n.seq)
                .map(|(f, _)| f.clone());
            if let Some(n) = oldest.and_then(|o| self.negatives.remove(&o)) {
                self.budget.give_back(n.charge);
            }
        }
        let charge = failure.charge();
        if !self.budget.try_take(charge) {
            return Recorded::NoRoom;
        }
        self.seq = self.seq.saturating_add(1);
        let retry_at = now.plus(retry_delay_ns(1, jitter_permille));
        self.negatives.insert(
            failure,
            Negative {
                failures: 1,
                retry_at,
                seq: self.seq,
                charge,
            },
        );
        Recorded::Held { retry_at }
    }

    /// Whether a failure may be retried now: never held, or its delay has
    /// passed.
    pub fn retry_allowed(&self, failure: &Failure, now: Monotonic) -> bool {
        self.negatives
            .get(failure)
            .is_none_or(|n| now >= n.retry_at)
    }

    /// How many failures of each kind are held: source, build, before read.
    pub fn negative_counts(&self) -> (usize, usize, usize) {
        self.negatives
            .keys()
            .fold((0, 0, 0), |(s, b, r), f| match f {
                Failure::Source(_) => (s + 1, b, r),
                Failure::Build(..) => (s, b + 1, r),
                Failure::BeforeRead(_) => (s, b, r + 1),
            })
    }

    /// A newer source was seen for `(zid, env)`: every failure held for an
    /// older tick of it is forgotten.
    pub fn note_newer_source(&mut self, zid: i32, env: &str, tick: i64) {
        let mut freed = 0u64;
        self.negatives.retain(|f, n| {
            let (z, e, t) = f.zid_env_tick();
            if z == zid && e == env && t < tick {
                freed = freed.saturating_add(n.charge);
                false
            } else {
                true
            }
        });
        self.budget.give_back(freed);
    }
}
