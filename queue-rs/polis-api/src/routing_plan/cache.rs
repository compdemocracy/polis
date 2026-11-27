//! The plan cache's wrapper: the process state that the pure cache in
//! `polis-routing-plan` (`PlanCache`) leaves to its caller.
//!
//! - One lock per process around the one cache. A request takes it only with
//!   `try_lock`: contention is the miss `lock_busy` and poison the miss
//!   `lock_poisoned`, never a wait and never a panic. Under the lock a lookup
//!   reads the clock and calls the core's `lookup`, nothing else.
//! - The byte budget, read once at startup (`cache_bytes_from_env`).
//! - The configuration digest (`Settings::digest`): the rule's canonical text
//!   with every parameter, its count policy, the mode, the conversation
//!   allowlist and every setting a plan depends on, so two rules or two
//!   parameter sets never share a digest.
//! - The monotonic clock (`Instant`, from one origin taken when the cache is
//!   made; never the wall clock), read after the lock is taken.
//! - The jitter of the negative cache's backoff, drawn before the lock.
//! - The reservation (`Reserved`): it holds the one cache it came from
//!   and returns its bytes there when it is dropped, on every path including
//!   unwinding, without waiting. The core's token never leaves this module.
//!
//! Dormant: nothing in this crate constructs it. It keeps nothing anywhere
//! but in memory; losing it at any moment loses only plans that are rebuilt
//! from the stored math result. The file names only `std`, `anyhow`,
//! `polis-routing-plan`, `rand` and `sha2`, so the allocation test compiles it
//! on its own under a counting allocator.

use polis_routing_plan::{
    CachedPlan, ConfigCapture, DEFAULT_CACHE_BYTES, Failure, Lookup, MissReason, Monotonic, Moved,
    PlanCache, PlanHandle, Published, RETIRED_ENTRIES, Recorded, Rejection, Reservation,
    RuleConfig, SourceLimits,
};
use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, SyncSender, TrySendError, sync_channel};
use std::sync::{Arc, Mutex, MutexGuard, TryLockError};
use std::time::Instant;

/// The setting the byte budget is read from, once, at startup.
pub(crate) const CACHE_BYTES_SETTING: &str = "POLIS_API_ROUTING_PLAN_CACHE_BYTES";
/// The smallest budget accepted: room for the cache's own fixed charge, its
/// retired list and a share of a quarter of a mebibyte.
pub(crate) const MIN_CACHE_BYTES: u64 = 1024 * 1024;
/// The largest budget accepted, and the default.
pub(crate) const MAX_CACHE_BYTES: u64 = DEFAULT_CACHE_BYTES;

/// Reservations a dropped reservation can hand back while the lock is held, before
/// one is lost (an over-charge, counted). Drained by every builder-side call.
pub(crate) const RETURN_SLOTS: usize = 1024;
/// What the return channel is charged for its whole life: each slot (the
/// token and the channel's stamp), and the channel's own state.
const RETURNS_CHARGE: u64 =
    (RETURN_SLOTS * (size_of::<Reservation>() + 2 * size_of::<usize>())) as u64 + 1024;

/// The byte budget from `POLIS_API_ROUTING_PLAN_CACHE_BYTES`. Called once at
/// startup, by whatever builds the cache; nothing reads it per request.
pub(crate) fn cache_bytes_from_env() -> anyhow::Result<u64> {
    cache_bytes_from(std::env::var(CACHE_BYTES_SETTING).ok().as_deref())
}

/// The byte budget a setting's value names: absent or empty is
/// `DEFAULT_CACHE_BYTES` (256 MiB); a whole number of bytes from
/// `MIN_CACHE_BYTES` to `MAX_CACHE_BYTES` is that number; anything else
/// (zero, a sign, a space, a fraction, a word, a number out of range) is an
/// error, so the process refuses to start rather than guess.
pub(crate) fn cache_bytes_from(value: Option<&str>) -> anyhow::Result<u64> {
    let Some(value) = value.filter(|value| !value.is_empty()) else {
        return Ok(DEFAULT_CACHE_BYTES);
    };
    value
        .bytes()
        .all(|b| b.is_ascii_digit())
        .then(|| value.parse::<u64>().ok())
        .flatten()
        .filter(|bytes| (MIN_CACHE_BYTES..=MAX_CACHE_BYTES).contains(bytes))
        .ok_or_else(|| {
            anyhow::anyhow!(
                "{CACHE_BYTES_SETTING} must be a whole number of bytes from {MIN_CACHE_BYTES} to {MAX_CACHE_BYTES}"
            )
        })
}

/// The mode the configuration names. Off has no cache, so it has no digest.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Mode {
    Observe,
    Serve,
}

impl Mode {
    fn name(self) -> &'static str {
        match self {
            Mode::Observe => "observe",
            Mode::Serve => "serve",
        }
    }
}

/// Everything a plan, a lookup or its serving depends on. Each later setting
/// (the builders, the rebuild-interval factor, the observer's limits) is
/// added here and to `canonical`, with its own digest test.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Settings {
    pub(crate) mode: Mode,
    /// The rule, with every parameter.
    pub(crate) rule: RuleConfig,
    /// The rule's count policy, when it has one.
    pub(crate) count_policy: Option<String>,
    /// The conversations enrolled. A set: order and repeats do not matter.
    pub(crate) conversations: Vec<i32>,
    pub(crate) cache_bytes: u64,
    pub(crate) head_lag_bound_ns: u64,
}

impl Settings {
    /// The canonical encoding the digest is taken over: a version line, then
    /// one line per field, `name length:value`, so no value can run into the
    /// next. The rule is its canonical plain form, every parameter written
    /// out; the conversations are sorted and without repeats.
    pub(crate) fn canonical(&self) -> String {
        let mut conversations = self.conversations.clone();
        conversations.sort_unstable();
        conversations.dedup();
        let conversations = conversations
            .iter()
            .map(i32::to_string)
            .collect::<Vec<_>>()
            .join(",");
        let policy = match &self.count_policy {
            None => "none".to_owned(),
            Some(policy) => format!("some:{policy}"),
        };
        let mut out = String::from("polis-api-routing-plan-config/1\n");
        for (name, value) in [
            ("mode", self.mode.name().to_owned()),
            ("rule", self.rule.to_plain()),
            ("count_policy", policy),
            ("conversations", conversations),
            ("cache_bytes", self.cache_bytes.to_string()),
            ("head_lag_bound_ns", self.head_lag_bound_ns.to_string()),
        ] {
            out.push_str(&format!("{name} {}:{value}\n", value.len()));
        }
        out
    }

    /// The full SHA-256 of `canonical`: the configuration's identity.
    pub(crate) fn digest(&self) -> [u8; 32] {
        Sha256::digest(self.canonical().as_bytes()).into()
    }

    /// What a request captures once, before any lookup, and holds for the
    /// whole request.
    pub(crate) fn capture(&self) -> ConfigCapture {
        ConfigCapture::new(self.digest(), self.head_lag_bound_ns)
    }
}

/// A cached plan as this process shares it. Cloning it allocates nothing;
/// no `Weak` reference to a plan is ever made, so a plan whose last strong
/// reference is the reclaimer's cannot come back.
#[derive(Clone, Debug)]
pub(crate) struct PlanRef(Arc<CachedPlan>);

impl PlanRef {
    pub(crate) fn new(plan: CachedPlan) -> Self {
        Self(Arc::new(plan))
    }
    pub(crate) fn plan(&self) -> &CachedPlan {
        &self.0
    }
}

impl PlanHandle for PlanRef {
    fn cached(&self) -> &CachedPlan {
        &self.0
    }
    fn sole_owner(&self) -> bool {
        Arc::strong_count(&self.0) == 1 && Arc::weak_count(&self.0) == 0
    }
}

/// The lock was poisoned: a builder-side call does nothing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Poisoned;

/// Why `try_reserve` took nothing. It never waits.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum NotReserved {
    LockBusy,
    LockPoisoned,
    /// The bytes do not fit the budget, or are more than one share.
    NoRoom,
}

/// Why a publication was not taken: the plan and the reservation come back,
/// for the builder to drop in that order, or to retry once.
#[derive(Debug)]
pub(crate) struct Rejected {
    pub(crate) plan: PlanRef,
    pub(crate) reservation: Reserved,
    pub(crate) reason: PublishRefused,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PublishRefused {
    Rejected(Rejection),
    Poisoned,
}

/// What the lock protects: the core, and the receiving end of the channel that
/// dropped reservations hand their reservations to while the lock is held.
pub(crate) struct Inner {
    core: PlanCache<PlanRef>,
    returned: Receiver<Reservation>,
    /// The return channel's charge, held for the cache's life.
    _returns_charge: Reservation,
}

impl Inner {
    /// Gives back what dropped reservations handed over: at most one channel's
    /// worth, arithmetic only.
    fn drain_returns(&mut self) {
        for _ in 0..RETURN_SLOTS {
            match self.returned.try_recv() {
                Ok(token) => self.core.release(token),
                Err(_) => break,
            }
        }
    }
}

/// The one plan cache of a process.
pub(crate) struct RoutingPlanCache {
    inner: Mutex<Inner>,
    returns: SyncSender<Reservation>,
    origin: Instant,
    closed: AtomicBool,
    returns_lost: AtomicU64,
}

impl std::fmt::Debug for RoutingPlanCache {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RoutingPlanCache").finish_non_exhaustive()
    }
}

// A test sees the region between taking and releasing the real lock on a
// lookup (the allocation test counts allocations there).
#[cfg(test)]
thread_local! {
    pub(crate) static UNDER_LOCK: std::cell::Cell<Option<fn(bool)>> =
        const { std::cell::Cell::new(None) };
}

#[inline(always)]
fn under_lock(_on: bool) {
    #[cfg(test)]
    if let Some(hook) = UNDER_LOCK.with(std::cell::Cell::get) {
        hook(_on);
    }
}

impl RoutingPlanCache {
    /// The cache, with a budget of `cache_bytes` (from
    /// `cache_bytes_from_env`) and the configuration whose digest is
    /// `current`. `None` if the budget cannot hold the cache's own charges.
    pub(crate) fn new(cache_bytes: u64, current: Option<[u8; 32]>) -> Option<Arc<Self>> {
        let mut core = PlanCache::new(cache_bytes, current)?;
        let returns_charge = core.try_reserve(RETURNS_CHARGE)?;
        let (returns, returned) = sync_channel(RETURN_SLOTS);
        Some(Arc::new(Self {
            inner: Mutex::new(Inner {
                core,
                returned,
                _returns_charge: returns_charge,
            }),
            returns,
            origin: Instant::now(),
            closed: AtomicBool::new(false),
            returns_lost: AtomicU64::new(0),
        }))
    }

    /// The monotonic reading, from this cache's origin.
    fn reading(&self) -> Monotonic {
        Monotonic::from_nanos(u64::try_from(self.origin.elapsed().as_nanos()).unwrap_or(u64::MAX))
    }

    /// A request's lookup. It never waits: a held lock is `lock_busy`, a
    /// poisoned one `lock_poisoned`, a cache that is shutting down
    /// `config_disabled`. Under the lock it reads the clock and calls the
    /// core's lookup, which allocates and frees nothing; a hit clones one
    /// `Arc`. The lock is released before the caller draws.
    pub(crate) fn lookup(
        &self,
        capture: &ConfigCapture,
        zid: i32,
        env: &str,
        seen_tick: Option<i64>,
    ) -> Lookup<PlanRef> {
        if self.closed.load(Ordering::Acquire) {
            return Lookup::Miss(MissReason::ConfigDisabled);
        }
        let mut inner = match self.inner.try_lock() {
            Ok(inner) => inner,
            Err(TryLockError::WouldBlock) => return Lookup::Miss(MissReason::LockBusy),
            Err(TryLockError::Poisoned(_)) => return Lookup::Miss(MissReason::LockPoisoned),
        };
        under_lock(true);
        let now = self.reading();
        let found = inner.core.lookup(capture, zid, env, seen_tick, now);
        under_lock(false);
        drop(inner);
        found
    }

    /// Bytes for work about to allocate, without waiting: a held or poisoned
    /// lock, or no room, takes nothing.
    pub(crate) fn try_reserve(self: &Arc<Self>, n: u64) -> Result<Reserved, NotReserved> {
        let mut inner = match self.inner.try_lock() {
            Ok(inner) => inner,
            Err(TryLockError::WouldBlock) => return Err(NotReserved::LockBusy),
            Err(TryLockError::Poisoned(_)) => return Err(NotReserved::LockPoisoned),
        };
        let token = inner.core.try_reserve(n).ok_or(NotReserved::NoRoom)?;
        drop(inner);
        Ok(self.reserved(token))
    }

    fn reserved(self: &Arc<Self>, token: Reservation) -> Reserved {
        Reserved {
            cache: self.clone(),
            token: Some(token),
        }
    }

    /// The builder side's lock: it waits only for other short holders (a
    /// lookup holds it for the core's lookup alone), and first gives back
    /// what dropped reservations handed over.
    fn locked(&self) -> Result<MutexGuard<'_, Inner>, Poisoned> {
        let mut inner = self.inner.lock().map_err(|_| Poisoned)?;
        inner.drain_returns();
        Ok(inner)
    }

    /// A build's admission, before anything is read: see the core's
    /// `admit_build`. `Ok(None)`: refused.
    pub(crate) fn admit_build(
        self: &Arc<Self>,
        len: usize,
        limits: &SourceLimits,
        allowance: u64,
    ) -> Result<Option<Reserved>, Poisoned> {
        let token = self.locked()?.core.admit_build(len, limits, allowance);
        Ok(token.map(|token| self.reserved(token)))
    }

    /// Whether the cache holds a fence for `(zid, env)`. A builder reads it
    /// only after taking its build's reservation.
    pub(crate) fn fenced(&self, zid: i32, env: &str) -> Result<bool, Poisoned> {
        Ok(self.locked()?.core.fenced(zid, env))
    }

    /// The loader saw `tick` for `(zid, env)`.
    pub(crate) fn note_seen(&self, zid: i32, env: &str, tick: i64) -> Result<(), Poisoned> {
        let mut inner = self.locked()?;
        let now = self.reading();
        inner.core.note_seen(zid, env, tick, now);
        Ok(())
    }

    /// Evicts the least recently looked-up plan onto the retired list.
    pub(crate) fn evict_lru(&self) -> Result<Option<bool>, Poisoned> {
        Ok(self.locked()?.core.evict_lru())
    }

    /// Retires every resident plan the retired list has room for.
    pub(crate) fn clear(&self) -> Result<Moved, Poisoned> {
        Ok(self.locked()?.core.clear())
    }

    /// Changes the current configuration (`None`: disabled).
    pub(crate) fn set_config(&self, digest: Option<[u8; 32]>) -> Result<Moved, Poisoned> {
        Ok(self.locked()?.core.set_config(digest))
    }

    /// Remembers a failure. The jitter is drawn before the lock.
    pub(crate) fn record_failure(&self, failure: Failure) -> Result<Recorded, Poisoned> {
        let jitter = rand::random::<u16>() % 1001;
        let mut inner = self.locked()?;
        let now = self.reading();
        Ok(inner.core.record_failure(failure, now, jitter))
    }

    /// Whether a remembered failure may be retried now.
    pub(crate) fn retry_allowed(&self, failure: &Failure) -> Result<bool, Poisoned> {
        let inner = self.locked()?;
        Ok(inner.core.retry_allowed(failure, self.reading()))
    }

    /// Destroys every retired plan this cache holds the last reference to,
    /// each outside the lock, and gives its bytes back: the builder thread's
    /// reclamation. Bounded by the retired list's length.
    pub(crate) fn reclaim(&self) -> Result<usize, Poisoned> {
        let mut destroyed = 0;
        for _ in 0..RETIRED_ENTRIES {
            let Some(reclaim) = self.locked()?.core.reclaim_one() else {
                break;
            };
            let freed = reclaim.destroy();
            self.locked()?.core.credit(freed);
            destroyed += 1;
        }
        Ok(destroyed)
    }

    /// Orderly shutdown, after the caller has stopped new requests and
    /// drained the requests and observers it runs: no lookup is served any
    /// more, the configuration is disabled (every fence that covers no plan
    /// is forgotten, as a restart does), and every plan nothing borrows is
    /// destroyed. A plan still borrowed stays retired until it is reclaimed
    /// again.
    pub(crate) fn shutdown(&self) -> Result<usize, Poisoned> {
        self.closed.store(true, Ordering::Release);
        self.set_config(None)?;
        self.reclaim()
    }

    /// The budget: bytes charged and the limit.
    pub(crate) fn budget(&self) -> Result<(u64, u64), Poisoned> {
        let inner = self.locked()?;
        Ok((inner.core.budget().used(), inner.core.budget().limit()))
    }

    /// Reservations lost because the lock was held and the return channel
    /// was full: each stays charged (an over-charge, never an under-charge).
    pub(crate) fn returns_lost(&self) -> u64 {
        self.returns_lost.load(Ordering::Relaxed)
    }

    /// A dropped reservation's bytes, given back without waiting: under the lock
    /// when it is free (poisoned or not: this is arithmetic), otherwise
    /// through the return channel, for the next builder-side call.
    fn give_back(&self, token: Reservation) {
        match self.inner.try_lock() {
            Ok(mut inner) => inner.core.release(token),
            Err(TryLockError::Poisoned(poisoned)) => poisoned.into_inner().core.release(token),
            Err(TryLockError::WouldBlock) => match self.returns.try_send(token) {
                Ok(()) => {}
                Err(TrySendError::Full(token) | TrySendError::Disconnected(token)) => {
                    drop(token);
                    self.returns_lost.fetch_add(1, Ordering::Relaxed);
                }
            },
        }
    }

    #[cfg(test)]
    pub(crate) fn hold_lock_for_test(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Bytes charged, read even through a poisoned lock, without draining
    /// the return channel.
    #[cfg(test)]
    pub(crate) fn used_for_test(&self) -> u64 {
        self.hold_lock_for_test().core.budget().used()
    }
}

/// Bytes taken from one cache's budget. It holds that cache, so its bytes
/// can only ever return there, once: in `Drop`, on every path including
/// unwinding, or by becoming a published plan's charge. The core's token
/// inside it is never handed out.
#[derive(Debug)]
pub(crate) struct Reserved {
    cache: Arc<RoutingPlanCache>,
    token: Option<Reservation>,
}

impl Reserved {
    pub(crate) fn bytes(&self) -> u64 {
        self.token.as_ref().map_or(0, Reservation::bytes)
    }

    /// Cuts the reservation down to `keep` bytes, giving the rest back and
    /// keeping when it was taken (the core's `shrink`). `Ok(true)`: cut
    /// down. `Ok(false)`: refused, unchanged, because `keep` is more than it
    /// holds. `Err(Poisoned)`: refused, unchanged.
    pub(crate) fn shrink(&mut self, keep: u64) -> Result<bool, Poisoned> {
        let mut inner = self.cache.locked()?;
        let Some(token) = self.token.take() else {
            return Ok(false);
        };
        let (token, cut) = match inner.core.shrink(token, keep) {
            Ok(token) => (token, true),
            Err(token) => (token, false),
        };
        self.token = Some(token);
        Ok(cut)
    }

    /// Publishes `plan` under this reservation, into this reservation's own
    /// cache. Refused, the plan and the reservation come back.
    pub(crate) fn publish(mut self, plan: PlanRef) -> Result<(), Box<Rejected>> {
        let cache = self.cache.clone();
        let Ok(mut inner) = cache.locked() else {
            return Err(Box::new(Rejected {
                plan,
                reservation: self,
                reason: PublishRefused::Poisoned,
            }));
        };
        let Some(token) = self.token.take() else {
            return Ok(());
        };
        let now = cache.reading();
        match inner.core.publish(plan, token, now) {
            Published::Ready => Ok(()),
            Published::Rejected {
                handle,
                reservation,
                reason,
            } => {
                self.token = Some(reservation);
                drop(inner);
                Err(Box::new(Rejected {
                    plan: handle,
                    reservation: self,
                    reason: PublishRefused::Rejected(reason),
                }))
            }
        }
    }
}

impl Drop for Reserved {
    fn drop(&mut self) {
        if let Some(token) = self.token.take() {
            self.cache.give_back(token);
        }
    }
}
