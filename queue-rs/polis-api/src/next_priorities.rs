//! Only the next-comment pool uses this cache. A flight never crosses pool
//! boundaries, and no cache lock is held during database work or a wait.
use crate::{
    clock::now_ms,
    js::{self, Js, Obj},
    lru::Lru,
};
use anyhow::{Result, bail};
use postgres::{Client, types::Type};
use std::{
    collections::HashMap,
    sync::{Arc, Condvar, Mutex},
    time::Instant,
};

type Key = (String, i32);
#[derive(Clone)]
struct Entry {
    until: f64,
    tick: i64,
    data: Arc<Js>,
}
type Outcome = std::result::Result<Option<Entry>, String>;
#[derive(Default)]
struct Flight {
    outcome: Mutex<Option<Outcome>>,
    ready: Condvar,
}
struct State {
    cache: Lru<Key, Option<Entry>>,
    flights: HashMap<Key, Arc<Flight>>,
}
pub(crate) struct Priorities {
    state: Mutex<State>,
    #[cfg(test)]
    joined: std::sync::atomic::AtomicUsize,
    #[cfg(test)]
    test_flight_timeout: Option<std::time::Duration>,
}
impl Priorities {
    pub(crate) fn new(size: usize) -> Self {
        Self {
            state: Mutex::new(State {
                cache: Lru::new(size),
                flights: HashMap::new(),
            }),
            #[cfg(test)]
            joined: std::sync::atomic::AtomicUsize::new(0),
            #[cfg(test)]
            test_flight_timeout: None,
        }
    }
    #[cfg(all(test, feature = "db-tests"))]
    pub(crate) fn with_test_flight_timeout(size: usize, timeout: std::time::Duration) -> Self {
        let mut cache = Self::new(size);
        cache.test_flight_timeout = Some(timeout);
        cache
    }
    #[cfg(all(test, feature = "db-tests"))]
    pub(crate) fn read(&self, c: &mut Client, zid: i32, env: &str) -> Result<Option<Arc<Js>>> {
        self.read_until(c, zid, env, Instant::now() + super::next_comment::DEADLINE)
    }
    #[cfg(all(test, feature = "db-tests"))]
    pub(crate) fn read_until(
        &self,
        c: &mut Client,
        zid: i32,
        env: &str,
        deadline: Instant,
    ) -> Result<Option<Arc<Js>>> {
        Ok(self
            .read_with_tick_until(c, zid, env, deadline)?
            .map(|(data, _)| data))
    }
    /// `read_until`, with the math generation the priorities came from.
    pub(crate) fn read_with_tick_until(
        &self,
        c: &mut Client,
        zid: i32,
        env: &str,
        deadline: Instant,
    ) -> Result<Option<(Arc<Js>, i64)>> {
        Ok(self
            .load_entry((env.to_owned(), zid), deadline, |cached| {
                refresh(c, zid, env, cached)
            })?
            .map(|entry| (entry.data, entry.tick)))
    }
    #[cfg(test)]
    fn load(
        &self,
        key: Key,
        deadline: Instant,
        read: impl FnOnce(Option<Entry>) -> Result<Option<Entry>>,
    ) -> Result<Option<Arc<Js>>> {
        Ok(self
            .load_entry(key, deadline, read)?
            .map(|entry| entry.data))
    }
    fn load_entry(
        &self,
        key: Key,
        deadline: Instant,
        read: impl FnOnce(Option<Entry>) -> Result<Option<Entry>>,
    ) -> Result<Option<Entry>> {
        let (cached, flight, leader) = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| anyhow::anyhow!("priority cache lock"))?;
            let cached = state.cache.get(&key).flatten();
            if let Some(entry) = &cached
                && entry.until > now_ms()
            {
                return Ok(Some(entry.clone()));
            }
            if let Some(flight) = state.flights.get(&key) {
                (cached, flight.clone(), false)
            } else {
                let flight = Arc::new(Flight::default());
                state.flights.insert(key.clone(), flight.clone());
                (cached, flight, true)
            }
        };
        if leader {
            // The blocking database operation owns this lease even if its HTTP
            // future is dropped. A panic also releases every registered waiter.
            let mut lease = Leader {
                cache: self,
                key,
                flight,
                completed: false,
            };
            let result = read(cached);
            lease.complete(
                result
                    .as_ref()
                    .map(Clone::clone)
                    .map_err(|e| format!("{e:#}")),
            );
            return result;
        }
        #[cfg(test)]
        self.joined
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let limits = super::next_comment::pool_limits();
        let until =
            deadline.min(Instant::now() + limits.acquire_timeout + limits.statement_timeout);
        #[cfg(test)]
        let until = self
            .test_flight_timeout
            .map_or(until, |timeout| deadline.min(Instant::now() + timeout));
        let outcome = flight
            .outcome
            .lock()
            .map_err(|_| anyhow::anyhow!("priority flight lock"))?;
        let (outcome, _) = flight
            .ready
            .wait_timeout_while(
                outcome,
                until.saturating_duration_since(Instant::now()),
                |v| v.is_none(),
            )
            .map_err(|_| anyhow::anyhow!("priority flight lock"))?;
        if Instant::now() >= until {
            bail!("priority flight deadline");
        }
        match outcome.as_ref() {
            Some(Ok(Some(entry))) if entry.until > now_ms() => Ok(Some(entry.clone())),
            Some(Ok(None)) => Ok(None),
            Some(Err(error)) => bail!("{error}"),
            _ => bail!("priority flight unavailable"),
        }
    }
    #[cfg(all(test, feature = "db-tests"))]
    pub(crate) fn wait_for_joiners(&self, count: usize) {
        let deadline = Instant::now()
            + self
                .test_flight_timeout
                .unwrap_or(std::time::Duration::from_secs(1));
        while self.joined.load(std::sync::atomic::Ordering::SeqCst) < count {
            assert!(Instant::now() < deadline, "waiter did not join");
            std::thread::yield_now();
        }
    }
    #[cfg(all(test, feature = "db-tests"))]
    pub(crate) fn expire(&self, zid: i32, env: &str) {
        let key = (env.to_owned(), zid);
        let mut state = self.state.lock().unwrap();
        if let Some(mut entry) = state.cache.get(&key).flatten() {
            entry.until = 0.0;
            state.cache.set(key, Some(entry));
        }
    }
}
struct Leader<'a> {
    cache: &'a Priorities,
    key: Key,
    flight: Arc<Flight>,
    completed: bool,
}
impl Leader<'_> {
    fn complete(&mut self, outcome: Outcome) {
        let mut state = self.cache.state.lock().unwrap_or_else(|e| e.into_inner());
        if let Ok(entry) = &outcome {
            state.cache.set(self.key.clone(), entry.clone());
        }
        *self
            .flight
            .outcome
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some(outcome);
        state.flights.remove(&self.key);
        self.completed = true;
        self.flight.ready.notify_all();
    }
}
impl Drop for Leader<'_> {
    fn drop(&mut self) {
        if !self.completed {
            self.complete(Err("priority read interrupted".into()));
        }
    }
}
fn refresh(c: &mut Client, zid: i32, env: &str, cached: Option<Entry>) -> Result<Option<Entry>> {
    let tick = cached.as_ref().map(|entry| entry.tick);
    // Explicit parameter types batch Parse/Bind/Execute into one exchange.
    // CASE does not evaluate or transfer the JSONB projection on a cache hit.
    // A missing priority field is distinct from a reused generation (SQL NULL).
    //
    // `data` is jsonb in a database built from the migrations and json in
    // installations older than them. Nothing here remembers which: the
    // server resolves `->` and the inner CASE against the column it is
    // reading, each time the statement runs. Only the arm of the column's
    // own type is evaluated, and its cast is to the type the column already
    // has, so it does nothing; the other arm's cast, which would convert the
    // whole document, never runs. A column of any other type has no `->` and
    // fails the statement.
    let rows = c.query_typed(
        "select math_tick, case when math_tick = $3 then null else \
           case pg_typeof(data) \
             when 'pg_catalog.jsonb'::regtype then jsonb_typeof(data::jsonb) \
             when 'pg_catalog.json'::regtype then json_typeof(data::json) \
           end \
         end, \
         case when math_tick = $3 then null else (data->'comment-priorities')::text end \
         from math_main where zid=$1 and math_env=$2 and math_tick>=0",
        &[(&zid, Type::INT4), (&env, Type::TEXT), (&tick, Type::INT8)],
    )?;
    let Some(row) = rows.first() else {
        return Ok(None);
    };
    let current: i64 = row.try_get(0)?;
    if let Some(mut entry) = cached.filter(|entry| entry.tick == current) {
        entry.until = now_ms() + 3000.0;
        return Ok(Some(entry));
    }
    if row.try_get::<_, Option<String>>(1)?.as_deref() != Some("object") {
        bail!("unsupported math shape");
    }
    // Retain the small wrapper so selection's missing/null/array semantics are
    // unchanged. No unrelated math fields are parsed, cloned or retained.
    let mut obj = Obj::new();
    if let Some(text) = row.try_get::<_, Option<String>>(2)? {
        obj.set("comment-priorities", js::parse(&text)?);
    }
    Ok(Some(Entry {
        until: now_ms() + 3000.0,
        tick: current,
        data: Arc::new(Js::Obj(obj)),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        sync::{
            atomic::{AtomicUsize, Ordering::SeqCst},
            mpsc,
        },
        time::Duration,
    };
    fn entry() -> Entry {
        Entry {
            until: now_ms() + 3000.0,
            tick: 0,
            data: Arc::new(Js::Obj(Obj::new())),
        }
    }
    fn joined(cache: &Priorities, n: usize) {
        let deadline = Instant::now() + Duration::from_secs(1);
        while cache.joined.load(SeqCst) < n {
            assert!(Instant::now() < deadline, "waiter did not join");
            std::thread::yield_now();
        }
    }
    fn shared(kind: usize) {
        let cache = Arc::new(Priorities::new(4));
        let calls = Arc::new(AtomicUsize::new(0));
        let (ready, started) = mpsc::channel();
        let (release, held) = mpsc::channel();
        let leader_cache = cache.clone();
        let count = calls.clone();
        let leader = std::thread::spawn(move || {
            leader_cache.load(
                ("test".into(), 1),
                Instant::now() + Duration::from_secs(1),
                move |_| {
                    count.fetch_add(1, SeqCst);
                    ready.send(()).unwrap();
                    held.recv_timeout(Duration::from_secs(1)).unwrap();
                    match kind {
                        0 => Ok(Some(entry())),
                        1 => Ok(None),
                        _ => bail!("database read failed"),
                    }
                },
            )
        });
        started.recv_timeout(Duration::from_secs(1)).unwrap();
        let follower_cache = cache.clone();
        let count = calls.clone();
        let follower = std::thread::spawn(move || {
            follower_cache.load(
                ("test".into(), 1),
                Instant::now() + Duration::from_secs(1),
                move |_| {
                    count.fetch_add(1, SeqCst);
                    bail!("a joiner must never repeat the read")
                },
            )
        });
        joined(&cache, 1);
        release.send(()).unwrap();
        let a = leader.join().unwrap();
        let b = follower.join().unwrap();
        assert_eq!(calls.load(SeqCst), 1);
        match kind {
            0 => assert!(Arc::ptr_eq(&a.unwrap().unwrap(), &b.unwrap().unwrap())),
            1 => {
                assert!(a.unwrap().is_none());
                assert!(b.unwrap().is_none());
            }
            _ => assert_eq!(a.unwrap_err().to_string(), b.unwrap_err().to_string()),
        }
        if kind != 0 {
            cache
                .load(
                    ("test".into(), 1),
                    Instant::now() + Duration::from_secs(1),
                    |_| {
                        calls.fetch_add(1, SeqCst);
                        Ok(Some(entry()))
                    },
                )
                .unwrap();
            assert_eq!(
                calls.load(SeqCst),
                2,
                "absence and errors must not be cached"
            );
        }
    }
    #[test]
    fn concurrent_success_shares_the_parsed_allocation() {
        shared(0);
    }
    #[test]
    fn concurrent_absence_shares_the_answer_but_does_not_cache_it() {
        shared(1);
    }
    #[test]
    fn concurrent_failure_is_broadcast_without_queued_retries() {
        shared(2);
    }
    #[test]
    fn wait_ends_at_the_earlier_caller_deadline() {
        bounded(Duration::from_millis(10));
    }
    #[test]
    fn wait_ends_at_acquisition_plus_statement_timeout() {
        bounded(Duration::from_secs(1));
    }
    fn bounded(budget: Duration) {
        let cache = Arc::new(Priorities::new(4));
        let c = cache.clone();
        let (ready, started) = mpsc::channel();
        let (release, held) = mpsc::channel();
        let leader = std::thread::spawn(move || {
            c.load(
                ("test".into(), 1),
                Instant::now() + Duration::from_secs(1),
                |_| {
                    ready.send(()).unwrap();
                    held.recv_timeout(Duration::from_secs(1)).unwrap();
                    Ok(Some(entry()))
                },
            )
        });
        started.recv_timeout(Duration::from_secs(1)).unwrap();
        let started = Instant::now();
        let result = cache.load(("test".into(), 1), started + budget, |_| {
            panic!("waiter became a leader")
        });
        let elapsed = started.elapsed();
        release.send(()).unwrap();
        leader.join().unwrap().unwrap();
        assert!(result.is_err());
        let expected = budget.min(Duration::from_millis(51));
        assert!(elapsed >= expected);
        assert!(
            elapsed < expected + Duration::from_millis(50),
            "bounded wait took {elapsed:?}"
        );
    }
    #[test]
    fn interrupted_leader_releases_joiners_and_allows_retry() {
        let cache = Arc::new(Priorities::new(4));
        let c = cache.clone();
        let (ready, started) = mpsc::channel();
        let (release, held) = mpsc::channel();
        let leader = std::thread::spawn(move || {
            c.load(
                ("test".into(), 1),
                Instant::now() + Duration::from_secs(1),
                |_| {
                    ready.send(()).unwrap();
                    held.recv_timeout(Duration::from_secs(1)).unwrap();
                    panic!("interrupted read")
                },
            )
        });
        started.recv_timeout(Duration::from_secs(1)).unwrap();
        let c = cache.clone();
        let waiter = std::thread::spawn(move || {
            c.load(
                ("test".into(), 1),
                Instant::now() + Duration::from_secs(1),
                |_| panic!("repeated read"),
            )
        });
        joined(&cache, 1);
        release.send(()).unwrap();
        assert!(leader.join().is_err());
        assert_eq!(
            waiter.join().unwrap().unwrap_err().to_string(),
            "priority read interrupted"
        );
        assert!(
            cache
                .load(
                    ("test".into(), 1),
                    Instant::now() + Duration::from_secs(1),
                    |_| Ok(Some(entry()))
                )
                .unwrap()
                .is_some()
        );
    }
    #[test]
    fn environments_and_conversations_do_not_share_entries() {
        let cache = Priorities::new(2);
        for key in [("a".into(), 1), ("b".into(), 1), ("a".into(), 2)] {
            cache
                .load(key, Instant::now() + Duration::from_secs(1), |cached| {
                    assert!(cached.is_none());
                    Ok(Some(entry()))
                })
                .unwrap();
        }
        cache
            .load(
                ("a".into(), 1),
                Instant::now() + Duration::from_secs(1),
                |cached| {
                    assert!(cached.is_none(), "LRU must evict");
                    Ok(Some(entry()))
                },
            )
            .unwrap();
    }
}

#[cfg(all(test, feature = "db-tests"))]
#[path = "next_priority_protocol_tests.rs"]
mod protocol_tests;
