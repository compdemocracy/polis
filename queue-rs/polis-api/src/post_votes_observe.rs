//! Observe mode: the vote writer's admission and next-statement selection, run
//! on a copy of a vote that Node is answering, with no write of any kind.
//!
//! Built only by the shadow role (`crate::shadow`), and never beside the live
//! writer. It has no writer pool and no notification pool, so `append`,
//! `star`, the notification update and the no-more-comments insert have no
//! connection to run on; both of its pools are read-only sessions
//! (`db::Pool::new`) as the backstop. Admission and selection run the live
//! code (`prepare`, `next_selecting`) on the same `reads` limits, so the copy
//! meets the contention the live writer would.
//!
//! After selection it reads back the vote Node stored for the same member and
//! statement, to compare the two engines' storage sign and member resolution,
//! through `StorageConvention` only. No vote value, member id, text or token
//! is ever written to a line.
use super::*;
use crate::{
    http::Body,
    votes::{StorageConvention, VoteChoice},
};
use std::collections::{BTreeMap, HashMap};

/// `readback`: one connection for the database-time anchor, the readback and
/// the membership lookups. Never an admission slot.
pub(crate) fn readback_limits() -> db::Limits {
    db::Limits {
        size: 1,
        acquire_timeout: Duration::from_millis(100),
        statement_timeout: Duration::from_millis(100),
        max_lifetime: Duration::from_secs(300),
    }
}

/// When the readback looks for Node's row, measured from the copy's receipt.
#[derive(Clone, Copy, Debug)]
pub(crate) struct ReadbackTiming {
    pub(crate) first: Duration,
    pub(crate) retry: Duration,
}

impl Default for ReadbackTiming {
    fn default() -> Self {
        Self {
            first: Duration::from_secs(2),
            retry: Duration::from_secs(10),
        }
    }
}

pub(crate) struct Observer {
    pub(super) verifier: participant::Verifier,
    pub(super) reads: Arc<db::Pool>,
    pub(super) readback: Arc<db::Pool>,
    pub(super) admins: Vec<i32>,
    pub(super) priorities: Arc<writer_priorities::Cache>,
    pub(super) follow_on: Arc<FollowOnLane>,
    pub(super) memo: Mutex<Memo>,
    pub(crate) timing: ReadbackTiming,
}

impl Observer {
    pub(super) fn new(
        verifier: participant::Verifier,
        reads: Arc<db::Pool>,
        readback: Arc<db::Pool>,
        admins: Vec<i32>,
        priorities: Arc<writer_priorities::Cache>,
    ) -> Self {
        Self {
            verifier,
            reads,
            readback,
            admins,
            priorities,
            follow_on: Arc::new(FollowOnLane::default()),
            memo: Mutex::new(Memo::default()),
            timing: ReadbackTiming::default(),
        }
    }

    /// Every pool observe mode builds: the two read-only pools, and no writer
    /// or notification pool. No rest pattern: a new field must be classified.
    #[cfg(test)]
    pub(crate) fn startup_pools(&self) -> [(&'static str, &Arc<db::Pool>); 2] {
        let Self {
            verifier: _,
            reads,
            readback,
            admins: _,
            priorities: _,
            follow_on: _,
            memo: _,
            timing: _,
        } = self;
        [("reads", reads), ("readback", readback)]
    }

    pub(crate) fn pools_health(&self, readback_reachable: bool) -> Js {
        let mut pools = js::Obj::new();
        pools.set("reads", self.reads.health(true));
        pools.set("readback", self.readback.health(readback_reachable));
        Js::Obj(pools)
    }

    pub(crate) async fn ping(&self) -> bool {
        self.readback.ping().await
    }

    pub(crate) fn set_revocations(&mut self, snapshot: Arc<polis_auth::revocation::Revocations>) {
        self.verifier.set_revocations(snapshot);
    }

    pub(crate) fn check_revocation(&self, raw: &str, now: u64) -> Result<(), polis_auth::Refusal> {
        self.verifier.check_revocation(raw, now)
    }

    fn admission(&self) -> Admission<'_> {
        Admission {
            verifier: &self.verifier,
            reads: &self.reads,
            admins: &self.admins,
            priorities: &self.priorities,
            follow_on: &self.follow_on,
        }
    }

    /// Database time at the copy's arrival, on `readback`. None when that
    /// pool does not answer; the readback is then skipped.
    pub(crate) async fn anchor(&self) -> Option<i64> {
        self.readback
            .with(|c| {
                Ok(c.query_one("select now_as_millis()", &[])?
                    .try_get::<_, i64>(0)?)
            })
            .await
            .ok()
    }

    /// Classifies the copy's statement against the candidates this process
    /// selected from for the same member last time (the membership memo).
    /// Lookups run only when the statement was not a candidate.
    pub(crate) async fn previous(&self, key: (i32, i32), tid: i32) -> Option<&'static str> {
        let stored = self
            .memo
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .lookup(key, tid);
        let anchor = match stored {
            None => return Some("none"),
            Some((true, _)) => return Some("hit"),
            Some((false, anchor)) => anchor,
        };
        let (zid, pid) = key;
        self.readback
            .with(move |c| {
                let created = c
                    .query_opt(
                        "select created from comments where zid=$1 and tid=$2",
                        &[&zid, &tid],
                    )?
                    .and_then(|row| row.try_get::<_, Option<i64>>(0).ok().flatten());
                if created.is_some_and(|created| created > anchor) {
                    return Ok("new");
                }
                let earlier = c.query_opt(
                    "select 1 from votes where zid=$1 and pid=$2 and tid=$3 and created < $4 limit 1",
                    &[&zid, &pid, &tid, &anchor],
                )?;
                Ok(if earlier.is_some() { "revote" } else { "miss" })
            })
            .await
            .ok()
    }

    pub(crate) fn remember(&self, key: (i32, i32), candidates: Vec<i32>, anchor: i64) {
        self.memo
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(key, candidates, anchor);
    }

    /// Node's stored vote for this member and statement, in a window anchored
    /// on database time, first at `timing.first` after receipt and once more
    /// at `timing.retry` when no row is there yet. No connection or lease is
    /// held while waiting. Returns the class and the delay that decided it.
    pub(crate) async fn read_back(
        &self,
        key: (i32, i32),
        tid: i32,
        expected: VoteChoice,
        anchor: i64,
        received: tokio::time::Instant,
    ) -> (NodeVote, Option<f64>) {
        let mut decided = None;
        for delay in [self.timing.first, self.timing.retry] {
            tokio::time::sleep_until(received + delay).await;
            decided = Some(delay.as_secs_f64());
            let (zid, pid) = key;
            let rows = self
                .readback
                .with(move |c| {
                    c.query(
                        "select vote from votes
                         where zid=$1 and pid=$2 and tid=$3 and created >= $4::bigint - 5000
                         order by created",
                        &[&zid, &pid, &tid, &anchor],
                    )?
                    .iter()
                    .map(|row| Ok(row.try_get::<_, Option<i16>>(0)?))
                    .collect::<Result<Vec<_>>>()
                })
                .await;
            match rows {
                Err(_) => return (NodeVote::Unavailable, decided),
                Ok(rows) if rows.is_empty() => continue,
                Ok(rows) => return (NodeVote::classify(&rows, expected), decided),
            }
        }
        (NodeVote::Absent, decided)
    }
}

/// How Node's stored rows compare with the copy's vote.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum NodeVote {
    /// Every row in the window carries the copy's vote.
    Same,
    /// Some do and some do not: a quick change of vote, not a stop.
    Ambiguous,
    /// None does: a vote-sign stop until explained.
    Different,
    Absent,
    Unavailable,
    NotChecked,
}

impl NodeVote {
    fn classify(rows: &[Option<i16>], expected: VoteChoice) -> Self {
        let matches = rows
            .iter()
            .filter(|raw| StorageConvention::CURRENT.decode(raw.map(i32::from)) == Some(expected))
            .count();
        if matches == 0 {
            Self::Different
        } else if matches == rows.len() {
            Self::Same
        } else {
            Self::Ambiguous
        }
    }

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Same => "same",
            Self::Ambiguous => "ambiguous",
            Self::Different => "different",
            Self::Absent => "absent",
            Self::Unavailable => "unavailable",
            Self::NotChecked => "not_checked",
        }
    }
}

const MEMO_KEYS: usize = 20_000;
const MEMO_TIDS: usize = 1_000_000;

/// Per process: for each member, the candidates of the last completed
/// selection here and its database-time anchor. Bounded by members and by
/// statements, least recently stored first out. Member ids stay in process.
#[derive(Default)]
pub(crate) struct Memo {
    entries: HashMap<(i32, i32), (u64, Vec<i32>, i64)>,
    order: BTreeMap<u64, (i32, i32)>,
    sequence: u64,
    tids: usize,
}

impl Memo {
    fn lookup(&self, key: (i32, i32), tid: i32) -> Option<(bool, i64)> {
        self.entries
            .get(&key)
            .map(|(_, candidates, anchor)| (candidates.binary_search(&tid).is_ok(), *anchor))
    }

    fn insert(&mut self, key: (i32, i32), mut candidates: Vec<i32>, anchor: i64) {
        candidates.sort_unstable();
        candidates.dedup();
        if let Some((sequence, old, _)) = self.entries.remove(&key) {
            self.order.remove(&sequence);
            self.tids -= old.len();
        }
        if candidates.len() > MEMO_TIDS {
            return;
        }
        self.sequence += 1;
        self.tids += candidates.len();
        self.order.insert(self.sequence, key);
        self.entries
            .insert(key, (self.sequence, candidates, anchor));
        while self.entries.len() > MEMO_KEYS || self.tids > MEMO_TIDS {
            let Some((_, oldest)) = self.order.pop_first() else {
                break;
            };
            if let Some((_, old, _)) = self.entries.remove(&oldest) {
                self.tids -= old.len();
            }
        }
    }
}

/// The observe path of `post_votes::handle`: the live prelude, then the
/// follow-on selection instead of dispatch. The answer is the would-be
/// status; the shadow answers nginx 204 whatever it is.
pub(super) async fn handle(app: &App, observer: &Observer, req: &Request, res: Res) -> Outgoing {
    let prepared = match prepare(app, observer.admission(), req, res).await {
        Ok(prepared) => prepared,
        Err(refused) => {
            crate::shadow::record(|record| {
                record.reason = Some(refused.reason);
                record.zid = refused.member.map(|(zid, _)| zid);
                record.admitted = refused.member.is_some();
                record.admission = refused.admission;
                // Admitted, then refused (a closed conversation): Node's row
                // is still read back, since a stored vote would disagree.
                if let (Some(member), Some(fields)) = (refused.member, &refused.fields) {
                    record.readback = Some((member, fields.tid as i32, fields.vote));
                }
            });
            return refused.out;
        }
    };
    let Prepared {
        admitted,
        fields,
        res: _,
        admission,
    } = prepared;
    let tid = fields.tid as i32;
    crate::shadow::record(|record| {
        record.admitted = true;
        record.zid = Some(admitted.zid);
        record.admission = Some(admission);
        record.readback = Some(((admitted.zid, admitted.pid), tid, fields.vote));
    });
    // The live writer sets its reply deadline here, then draws.
    let reply_deadline = tokio::time::Instant::now() + DISPATCH_DEADLINE;
    let unit = next_comment::draw(req);
    let (follow_on, selection, took) = select(
        &observer.reads,
        admitted,
        &fields,
        app.math_env.clone(),
        unit,
        reply_deadline,
    )
    .await;
    crate::shadow::record(|record| {
        record.follow_on = Some(follow_on);
        record.selection = took;
        if let Some(selection) = selection {
            record.next_tid = selection.next_tid;
            record.remaining = selection.remaining;
            record.total = selection.total;
            record.weights_tick = selection.weights_tick;
            record.candidates = Some(selection.candidates);
        }
    });
    // A receipt is assumed: the append is not modelled. Nothing is sent.
    Outgoing {
        status: 200,
        headers: vec![],
        body: Body::Empty,
        close: false,
    }
}

/// The live follow-on selection (`dispatch` after the receipt): the same
/// lane, the same reads pool, alarm, deadline estimate and statements, with
/// the copy's statement counted as voted. Where live would run `exhausted`
/// only to decide the no-more-comments insert, observe records "degraded".
/// `Admitted`, and with it the priority lease, is gone when this returns.
async fn select(
    reads: &Arc<db::Pool>,
    admitted: Admitted,
    fields: &ParsedFields,
    env: String,
    unit: f64,
    reply_deadline: tokio::time::Instant,
) -> (&'static str, Option<Selection>, Option<Duration>) {
    let a = admitted.clone();
    let lang = fields.lang.clone();
    let voted = fields.tid as i32;
    let acquired = admitted.follow_on.acquire_until(reply_deadline).await;
    drop(admitted);
    let Ok(permits) = acquired else {
        return ("degraded", None, None);
    };
    let selection_started = tokio::time::Instant::now();
    let result = reads
        .with_acquire_alarm(
            DISPATCH_ACQUIRE_ALARM,
            || crate::shadow::event("shadow_post_votes_follow_on_acquire_alarm", &[]),
            move |c| {
                // Keep both capacity limits until the blocking work ends,
                // including when its awaiting future has been dropped.
                let _permits = permits;
                if !a.follow_on.can_finish(reply_deadline) {
                    return Ok(None);
                }
                let mut selection = Selection::new(voted);
                let selected =
                    next_selecting(c, &a, &env, unit, lang.as_deref(), Some(&mut selection));
                a.follow_on.record_selection(selection_started.elapsed());
                selected?;
                Ok(Some(selection))
            },
        )
        .await;
    let took = Some(selection_started.elapsed());
    match result {
        Ok(Some(selection)) => (
            if selection.next_tid.is_some() {
                "complete"
            } else {
                "absent"
            },
            Some(selection),
            took,
        ),
        _ => ("degraded", None, took),
    }
}
