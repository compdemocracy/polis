//! The scheduler's decisions, as pure functions: whether to pause, which
//! conversation is next, and what its admission says.
use super::{
    config::{Config, Share},
    db::{Admission, CommentSet, Live, Signals},
    state::State,
    storage::Ledger,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

/// The selection a run the scheduler admits names unless [`Rules`] chooses
/// another for its conversation: the comments participants are shown
/// (`contract::participant_visible`). Each run embeds every comment of its
/// conversation and lays out, clusters and names its selection's comments
/// only. The selection is part of the run's identity: its admission names it,
/// its digest keys the admission, and its run record carries both
/// (`config_effective.selection`, `config_effective.shadow`).
pub const SELECTION: &str = crate::jobs::inputs::contract::PARTICIPANT_VISIBLE;
/// A selection [`Rules`] may choose: every comment of the conversation,
/// whatever its moderation (`contract::all_comments`).
pub const ALL_COMMENTS: &str = crate::jobs::inputs::contract::ALL_COMMENTS;
/// A selection [`Rules`] may choose: every comment of the conversation but the
/// moderated-out ones (`contract::all_but_moderated_out`).
pub const ALL_BUT_MODERATED_OUT: &str = crate::jobs::inputs::contract::ALL_BUT_MODERATED_OUT;

/// Which selection each conversation's runs name. The selection is an input
/// of a run, never a property of the shadow: the scheduler asks this which
/// one a conversation's next run names, and the census, the admission's key
/// and the run record all follow from that name (`db::census`, [`admission`]).
/// Today one source fills it, the operator's lists
/// (`config::RULE_LISTS`: `DELPHI_SHADOW_ALL_COMMENTS`,
/// `DELPHI_SHADOW_ALL_BUT_MODERATED_OUT`, resolved to conversation ids on the
/// read login); with them empty, every run names [`SELECTION`], as before
/// they existed. A conversation has one rule at a time. Held in memory only
/// and read again from the database at every start: the run record in
/// Postgres is what says which selection made a run.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Rules {
    /// The conversations whose runs name another selection than
    /// [`SELECTION`], with it.
    pub listed: std::collections::BTreeMap<i32, &'static str>,
}

impl Rules {
    /// The selection the next run of conversation `zid` names.
    pub fn selection(&self, zid: i32) -> &'static str {
        self.listed.get(&zid).copied().unwrap_or(SELECTION)
    }
}

/// Why nothing is admitted now. Closed set; these words are the log's.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pause {
    Operator,
    Disk,
    DbLatency,
    MathLag,
    DailyCap,
    /// Runs are terminal whose bytes are not yet read (`storage`).
    StorageUnmeasured,
    /// The shadow's bytes reached the budget, or the next run would pass it.
    StorageBudget,
    /// The shadow's bytes reached the budget less the live reserve, or the
    /// next run would pass it: the benchmark and featured sets and twins
    /// wait; the current set's runs go on.
    StorageReserve,
    /// Today's bytes reached the daily limit, or the next run would pass it
    /// (only when `DELPHI_SHADOW_STORAGE_DAILY_MB` sets one).
    StorageDaily,
}

impl Pause {
    pub fn word(self) -> &'static str {
        match self {
            Self::Operator => "operator",
            Self::Disk => "disk",
            Self::DbLatency => "db_latency",
            Self::MathLag => "math_lag",
            Self::DailyCap => "daily_cap",
            Self::StorageUnmeasured => "storage_unmeasured",
            Self::StorageBudget => "storage_budget",
            Self::StorageReserve => "storage_reserve",
            Self::StorageDaily => "storage_daily",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Disk {
    pub free_mb: u64,
    pub used_pct: f64,
}

/// The free space of the filesystem holding `path`.
pub fn disk(path: &std::path::Path) -> std::io::Result<Disk> {
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(path.as_os_str().as_bytes())
        .map_err(|_| std::io::Error::other("path holds NUL"))?;
    // SAFETY: statvfs fills the struct it is given; the path is NUL-terminated.
    let mut s: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c.as_ptr(), &mut s) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    let block = s.f_frsize as u64;
    let total = s.f_blocks as u64 * block;
    let avail = s.f_bavail as u64 * block;
    let free = s.f_bfree as u64 * block;
    let used_pct = if total == 0 {
        100.0
    } else {
        (total - free) as f64 * 100.0 / total as f64
    };
    Ok(Disk {
        free_mb: avail / (1024 * 1024),
        used_pct,
    })
}

/// The first reason to pause, in a fixed order, with the database-latency
/// hysteresis of the math backfill: once paused for latency, resume only
/// below half the bound.
pub fn pause(
    cfg: &Config,
    state: &State,
    operator: bool,
    disk: Option<Disk>,
    signals: Option<&Signals>,
    paused: Option<Pause>,
) -> Option<Pause> {
    if operator {
        return Some(Pause::Operator);
    }
    match disk {
        // An unreadable disk is a reason to stop, not to guess.
        None => return Some(Pause::Disk),
        Some(d) if d.free_mb < cfg.disk_free_min_mb || d.used_pct > cfg.disk_used_max_pct => {
            return Some(Pause::Disk);
        }
        _ => {}
    }
    let Some(s) = signals else {
        return Some(Pause::DbLatency);
    };
    let bound = cfg.probe_max.as_secs_f64() * 1000.0;
    if s.probe_ms > bound || (paused == Some(Pause::DbLatency) && s.probe_ms > bound / 2.0) {
        return Some(Pause::DbLatency);
    }
    if s.math_lag_ms > cfg.math_lag_max.as_millis() as i64 {
        return Some(Pause::MathLag);
    }
    if state.day_runs >= cfg.daily_runs {
        return Some(Pause::DailyCap);
    }
    if !state.storage.pending.is_empty() {
        return Some(Pause::StorageUnmeasured);
    }
    // The smallest run there can be, of the current set (the one share that
    // may spend the whole budget): when even it does not fit, nothing
    // is read to find out which would.
    storage_room(cfg, &state.storage, cfg.min_comments, Share::Whole)
}

/// Whether a run of `comments` comments, spending `share`, may be admitted
/// under the storage budget: not once the shadow's bytes have reached the
/// budget, or for a run not of the current set the budget less the live
/// reserve,
/// or, when there is a daily limit, today's have reached it; and not when the
/// run's estimate would pass any of them. With no daily limit (the default)
/// only the totals hold.
pub fn storage_room(cfg: &Config, ledger: &Ledger, comments: i64, share: Share) -> Option<Pause> {
    let next = ledger.estimate(comments);
    let over = |limit: u64| ledger.bytes >= limit || ledger.bytes.saturating_add(next) > limit;
    if over(cfg.storage_limit_bytes(Share::Whole)) {
        return Some(Pause::StorageBudget);
    }
    if share == Share::Shared && over(cfg.storage_limit_bytes(Share::Shared)) {
        return Some(Pause::StorageReserve);
    }
    if let Some(daily) = cfg.storage_daily_bytes
        && (ledger.day_bytes >= daily || ledger.day_bytes.saturating_add(next) > daily)
    {
        return Some(Pause::StorageDaily);
    }
    None
}

/// What a candidate is, before its comment set is read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Look {
    /// Read its comment set: it changed (or was never seen) and may be run.
    Read,
    /// Nothing new since it was last read.
    Unchanged,
    TooSmall,
    TooLarge,
    /// Its estimate alone passes what one run of its share may add (the
    /// budget, less the live reserve unless it is current, or the daily limit
    /// when there is one and it is smaller): it could never be admitted, and
    /// in the list's priority order it would hold back every conversation
    /// after it.
    TooCostly,
    /// Run within the rerun window.
    Recent,
}

/// What a candidate is before its comment set is read. `live.comments` is
/// every comment with text (what a run embeds): the cap and the storage
/// estimate are of that set. The floor is of the selection (what a run lays
/// out), which only the census reads: a conversation with fewer comments in
/// all is below it too, and one whose last census found too few selected is
/// below it until a comment changes. A state entry written before runs named
/// a selection is read again whatever its time: its digests are of every
/// comment, not of the selection. Every conversation is looked at under
/// [`SELECTION`]; [`look_under`] names another.
pub fn look(cfg: &Config, state: &State, live: &Live, now_ms: i64, share: Share) -> Look {
    look_under(cfg, state, live, now_ms, share, SELECTION)
}

/// [`look`], for a conversation whose next run names `selection`. A state
/// entry of another selection (the conversation's rule changed, or an earlier
/// build wrote it) is read again whatever its comments' times, so a
/// conversation whose rule changed is never taken as unchanged; only the
/// bounds and the rerun window hold it.
pub fn look_under(
    cfg: &Config,
    state: &State,
    live: &Live,
    now_ms: i64,
    share: Share,
    selection: &str,
) -> Look {
    if live.comments < cfg.min_comments {
        return Look::TooSmall;
    }
    if live.comments > cfg.max_comments {
        return Look::TooLarge;
    }
    if state.storage.estimate(live.comments) > cfg.storage_run_max_bytes(share) {
        return Look::TooCostly;
    }
    let Some(seen) = state.conversations.get(&live.zid) else {
        return Look::Read;
    };
    if let Some(at) = seen.admitted_at_ms
        && now_ms - at < cfg.rerun_after.as_millis() as i64
    {
        return Look::Recent;
    }
    if seen.selection.as_deref() == Some(selection) && seen.last_modified == live.last_modified {
        if seen.admitted_digest.as_deref() == Some(&seen.digest) {
            return Look::Unchanged;
        }
        if seen.selected < cfg.min_comments {
            return Look::TooSmall;
        }
    }
    Look::Read
}

/// The candidates to read, smallest first (then by conversation id), so the
/// first pass learns the cheap sizes before the expensive ones.
pub fn order(cfg: &Config, state: &State, live: &[Live], now_ms: i64) -> Vec<Live> {
    order_under(cfg, state, live, now_ms, &Rules::default())
}

/// [`order`], each conversation looked at under its own selection (`rules`).
pub fn order_under(
    cfg: &Config,
    state: &State,
    live: &[Live],
    now_ms: i64,
    rules: &Rules,
) -> Vec<Live> {
    let mut out: Vec<Live> = live
        .iter()
        .filter(|l| {
            look_under(cfg, state, l, now_ms, Share::Whole, rules.selection(l.zid)) == Look::Read
        })
        .cloned()
        .collect();
    out.sort_by_key(|l| (l.comments, l.zid));
    out
}

/// The named set a run is selected from. Closed, in priority order; these
/// words are the log's (`"set"`) and the run record's
/// (`config_effective.shadow.set`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Set {
    /// The benchmark list (`DELPHI_SHADOW_BENCHMARK`), in its order: large
    /// conversations kept to measure Polis 2 on, open data or not.
    Benchmark,
    /// The open-data conversations (`conversations.is_data_open`), most
    /// participants first.
    Featured,
    /// The live conversations (a comment created or moderated within
    /// `DELPHI_SHADOW_LIVE_DAYS`), for feedback on them now.
    Current,
}

impl Set {
    pub const ALL: [Set; 3] = [Self::Benchmark, Self::Featured, Self::Current];

    /// The part of the storage budget its runs may spend: the current set
    /// the whole of it, the benchmark and featured sets together all but the
    /// live reserve.
    pub fn share(self) -> Share {
        match self {
            Self::Benchmark | Self::Featured => Share::Shared,
            Self::Current => Share::Whole,
        }
    }

    pub fn word(self) -> &'static str {
        match self {
            Self::Benchmark => "benchmark",
            Self::Featured => "featured",
            Self::Current => "current",
        }
    }

    /// The set a word names (a run record's), or `None`: a run admitted
    /// before runs named their set.
    pub fn from_word(word: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|s| s.word() == word)
    }
}

/// A roster entry (read once a day) with what this cycle's live read says of
/// it: a conversation with a comment since the live window began has its
/// fresh count and newest change from that read; any other has not changed
/// since the roster read it.
pub fn overlay(roster: &[Live], live: &[Live]) -> Vec<Live> {
    let fresh: std::collections::BTreeMap<i32, &Live> = live.iter().map(|l| (l.zid, l)).collect();
    roster
        .iter()
        .map(|r| {
            fresh
                .get(&r.zid)
                .map_or_else(|| r.clone(), |l| (*l).clone())
        })
        .collect()
}

/// Every candidate to read, in the order they are tried: the benchmark set,
/// in the list's order (highest priority first); then the featured set, the
/// open-data conversations, most participants first (as the roster reads
/// them); both whatever their recent activity; then the current set, the
/// live conversations in neither, smallest first (`order`). A conversation
/// in two sets is tried once, in the first, and is of that set. All are held
/// to the same `look`: the comment bounds, the storage a run would take, the
/// rerun window and an unchanged comment set.
pub fn candidates(
    cfg: &Config,
    state: &State,
    benchmark: &[Live],
    featured: &[Live],
    current: &[Live],
    now_ms: i64,
) -> Vec<(Live, Set)> {
    candidates_under(
        cfg,
        state,
        benchmark,
        featured,
        current,
        now_ms,
        &Rules::default(),
    )
}

/// [`candidates`], each conversation looked at under its own selection
/// (`rules`). The rules choose no candidate and order none: they decide only
/// what a candidate's run lays out, and so whether its last run still stands.
pub fn candidates_under(
    cfg: &Config,
    state: &State,
    benchmark: &[Live],
    featured: &[Live],
    current: &[Live],
    now_ms: i64,
    rules: &Rules,
) -> Vec<(Live, Set)> {
    let mut out: Vec<(Live, Set)> = Vec::new();
    let mut tried = std::collections::BTreeSet::new();
    for (list, set) in [(benchmark, Set::Benchmark), (featured, Set::Featured)] {
        for l in list {
            if tried.insert(l.zid)
                && look_under(cfg, state, l, now_ms, set.share(), rules.selection(l.zid))
                    == Look::Read
            {
                out.push((l.clone(), set));
            }
        }
    }
    let rest: Vec<Live> = current
        .iter()
        .filter(|l| !tried.contains(&l.zid))
        .cloned()
        .collect();
    out.extend(
        order_under(cfg, state, &rest, now_ms, rules)
            .into_iter()
            .map(|l| (l, Set::Current)),
    );
    out
}

/// The size classes of the report (the same bounds as the production counts read).
pub fn size_class(comments: i64) -> &'static str {
    match comments {
        n if n < 20 => "a under 20",
        n if n < 100 => "b 20-99",
        n if n < 1000 => "c 100-999",
        n if n < 5000 => "d 1000-4999",
        _ => "e 5000 up",
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// The admission of one run. The idempotency key is the selection's digest
/// (with `twin` for its repeat), so a crash and restart within the queue's
/// binding window admits nothing twice, a moderation that changes what the
/// selection keeps is a new run, and one that keeps the same comments (or a
/// comment added that it does not keep) is not. The configuration names the
/// selection (`selection`, which the job's dispatch passes to the pipeline),
/// both digests of the census (every comment, which the run embeds; the
/// selection, which it lays out, clusters and names) with their counts, the
/// named set the run was selected from (a twin, its first run's; `None` only
/// for a twin of a run admitted before runs named it) and, on a twin, the run
/// it repeats, and is stored in the job's run record (`config_effective`).
/// Which selection it names is the census's (`census.selection`), chosen by
/// whoever asked for the census: the scheduler per conversation ([`Rules`]).
/// The report filter (`exclude_comment_selections`) is off: a selection is
/// the whole rule, which a report's own choices do not narrow. The
/// named set is not in the key: one selection is run once whichever set
/// selects it, and the same key asked again under another set within the
/// binding window is the queue's `conflict`, refused, not run twice.
pub fn admission(
    zid: i32,
    census: &CommentSet,
    set: Option<Set>,
    twin_of: Option<&str>,
) -> Admission {
    let config = json!({
        "selection": census.selection,
        "exclude_comment_selections": false,
        "embeddings_table": true,
        "shadow": {
            "schema": "delphi-shadow/2",
            "comment_set_sha256": census.digest,
            "comments": census.comments,
            "selection": census.selection,
            "selection_sha256": census.selection_digest,
            "selected": census.selected,
            "size_class": size_class(census.comments),
            "set": set.map(Set::word),
            "twin_of": twin_of,
            "scheduler": concat!("polis-delphi-shadow ", env!("CARGO_PKG_VERSION")),
        }
    });
    let kind = if twin_of.is_some() { "twin" } else { "first" };
    let digest = &census.selection_digest;
    let key = format!("shadow:{kind}:{zid}:{}", &digest[..digest.len().min(48)]);
    let request = json!({"zid": zid, "kind": kind, "config": config});
    Admission {
        zid,
        key,
        request_sha: sha256_hex(request.to_string().as_bytes()),
        job_id: uuid::Uuid::new_v4(),
        run_id: uuid::Uuid::new_v4(),
        config,
    }
}

/// Rest after a run: d·(1−duty)/duty.
pub fn rest_ms(duty: f64, run_ms: i64) -> i64 {
    ((run_ms.max(0) as f64) * (1.0 - duty) / duty).round() as i64
}

/// Whether the nth first run that succeeded gets a twin.
pub fn twin_due(every: u32, first_runs_succeeded: u64) -> bool {
    every > 0 && first_runs_succeeded.is_multiple_of(u64::from(every))
}

/// The admission outcome's job, when the queue took (or already had) it.
pub fn admitted_job(reply: &Value) -> Option<(String, String)> {
    let outcome = reply.get("outcome")?.as_str()?;
    if !matches!(outcome, "enqueued" | "existing") {
        return None;
    }
    Some((
        outcome.to_owned(),
        reply.get("job_id")?.as_str()?.to_owned(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shadow::{config, state::Seen};
    use std::time::Duration;

    fn cfg() -> Config {
        let m: std::collections::HashMap<&str, &str> = [
            ("DELPHI_SHADOW_ENABLED", "1"),
            ("QUEUE_DATABASE_URL", "postgresql://q@127.0.0.1/db"),
            (
                "DELPHI_SHADOW_READ_DATABASE_URL",
                "postgresql://r@127.0.0.1/db",
            ),
            ("POLIS_JOBS_TRANSPORT", "loopback"),
            (
                "DELPHI_SHADOW_CODE_VERSION",
                "0123456789abcdef0123456789abcdef01234567",
            ),
        ]
        .into_iter()
        .collect();
        match config::load(|k| m.get(k).map(|v| (*v).to_owned())) {
            Ok(config::Load::Ready(c)) => *c,
            _ => panic!("config"),
        }
    }

    fn ok_disk() -> Option<Disk> {
        Some(Disk {
            free_mb: 20_000,
            used_pct: 50.0,
        })
    }

    fn signals(probe_ms: f64, lag_ms: i64) -> Signals {
        Signals {
            probe_ms,
            math_lag_ms: lag_ms,
        }
    }

    #[test]
    fn pause_reasons_in_order_with_latency_hysteresis() {
        let c = cfg();
        let mut s = State::new("shadow-delphi-1");
        let fine = signals(5.0, 0);
        assert_eq!(pause(&c, &s, false, ok_disk(), Some(&fine), None), None);
        assert_eq!(pause(&c, &s, true, None, None, None), Some(Pause::Operator));
        assert_eq!(
            pause(&c, &s, false, None, Some(&fine), None),
            Some(Pause::Disk)
        );
        let low = Some(Disk {
            free_mb: 10_000,
            used_pct: 50.0,
        });
        assert_eq!(
            pause(&c, &s, false, low, Some(&fine), None),
            Some(Pause::Disk)
        );
        let full = Some(Disk {
            free_mb: 50_000,
            used_pct: 86.0,
        });
        assert_eq!(
            pause(&c, &s, false, full, Some(&fine), None),
            Some(Pause::Disk)
        );
        assert_eq!(
            pause(&c, &s, false, ok_disk(), None, None),
            Some(Pause::DbLatency)
        );
        assert_eq!(
            pause(&c, &s, false, ok_disk(), Some(&signals(300.0, 0)), None),
            Some(Pause::DbLatency)
        );
        // 200 ms is under the 250 ms bound but over half of it: stay paused.
        let mid = signals(200.0, 0);
        assert_eq!(pause(&c, &s, false, ok_disk(), Some(&mid), None), None);
        assert_eq!(
            pause(&c, &s, false, ok_disk(), Some(&mid), Some(Pause::DbLatency)),
            Some(Pause::DbLatency)
        );
        assert_eq!(
            pause(
                &c,
                &s,
                false,
                ok_disk(),
                Some(&signals(100.0, 0)),
                Some(Pause::DbLatency)
            ),
            None
        );
        assert_eq!(
            pause(&c, &s, false, ok_disk(), Some(&signals(5.0, 181_000)), None),
            Some(Pause::MathLag)
        );
        s.day_runs = c.daily_runs;
        assert_eq!(
            pause(&c, &s, false, ok_disk(), Some(&fine), None),
            Some(Pause::DailyCap)
        );
    }

    #[test]
    fn with_no_daily_limit_by_default_only_the_total_holds() {
        use crate::shadow::storage::{JOB_BYTES, MIB};
        let mut c = cfg();
        assert_eq!(c.storage_daily_bytes, None, "the default");
        c.storage_budget_bytes = 10 * MIB;
        let mut s = State::new("shadow-delphi-1");
        let fine = signals(5.0, 0);
        let p = |s: &State| pause(&c, s, false, ok_disk(), Some(&fine), None);
        // Nine tenths of the budget added today alone: nothing holds but the
        // total.
        s.storage.bytes = 9 * MIB;
        s.storage.day_bytes = 9 * MIB;
        assert_eq!(p(&s), None);
        assert_eq!(storage_room(&c, &s.storage, 100, Share::Whole), None);
        assert_eq!(
            storage_room(&c, &s.storage, 200, Share::Whole),
            Some(Pause::StorageBudget),
            "the total, never storage_daily"
        );
        s.storage.bytes = 10 * MIB;
        assert_eq!(p(&s), Some(Pause::StorageBudget));
        // A run fits as long as the total has room for it, whatever today holds.
        s.storage.bytes = 10 * MIB - 100 * 8192 - JOB_BYTES;
        s.storage.day_bytes = s.storage.bytes;
        assert_eq!(storage_room(&c, &s.storage, 100, Share::Whole), None);
        // One run is too costly only when it alone would pass the whole budget.
        let now = 10 * 86_400_000;
        let one = |comments| Live {
            zid: 7,
            comments,
            last_modified: 9,
        };
        c.storage_budget_bytes = s.storage.estimate(800);
        assert_eq!(look(&c, &s, &one(800), now, Share::Whole), Look::Read);
        assert_eq!(look(&c, &s, &one(801), now, Share::Whole), Look::TooCostly);
    }

    #[test]
    fn the_live_reserve_stops_benchmark_and_featured_and_current_runs_spend_the_whole_total() {
        use crate::shadow::storage::{JOB_BYTES, MIB};
        let mut c = cfg();
        // 1 GiB of the 3 GiB is kept for the current set by default; the
        // benchmark and featured sets share the rest between them.
        assert_eq!(Set::Benchmark.share(), Share::Shared);
        assert_eq!(Set::Featured.share(), Share::Shared);
        assert_eq!(Set::Current.share(), Share::Whole);
        c.storage_budget_bytes = 10 * MIB;
        c.storage_live_reserve_bytes = 4 * MIB;
        let mut s = State::new("shadow-delphi-1");
        let fine = signals(5.0, 0);
        let p = |s: &State| pause(&c, s, false, ok_disk(), Some(&fine), None);
        let room = |s: &State, comments, share| storage_room(&c, &s.storage, comments, share);
        // Under the total less the reserve: every set fits.
        s.storage.bytes = 6 * MIB - 100 * 8192 - JOB_BYTES;
        assert_eq!(room(&s, 100, Share::Shared), None);
        assert_eq!(room(&s, 101, Share::Shared), Some(Pause::StorageReserve));
        assert_eq!(room(&s, 101, Share::Whole), None);
        // At the total less the reserve: the benchmark and featured sets stop;
        // current runs continue, and nothing pauses.
        s.storage.bytes = 6 * MIB;
        assert_eq!(room(&s, 20, Share::Shared), Some(Pause::StorageReserve));
        assert_eq!(room(&s, 20, Share::Whole), None);
        assert_eq!(p(&s), None);
        // Current runs stop at the total, and so does everything.
        s.storage.bytes = 10 * MIB - 100 * 8192 - JOB_BYTES;
        assert_eq!(room(&s, 100, Share::Whole), None);
        assert_eq!(room(&s, 101, Share::Whole), Some(Pause::StorageBudget));
        s.storage.bytes = 10 * MIB;
        assert_eq!(room(&s, 20, Share::Whole), Some(Pause::StorageBudget));
        assert_eq!(room(&s, 20, Share::Shared), Some(Pause::StorageBudget));
        assert_eq!(p(&s), Some(Pause::StorageBudget));
        // One run alone past the total less the reserve can never run from
        // the benchmark or featured set, so it is not tried there; current,
        // it can.
        s.storage.bytes = 0;
        let now = 10 * 86_400_000;
        let one = |comments| Live {
            zid: 7,
            comments,
            last_modified: 9,
        };
        let shared_max = (6 * MIB - JOB_BYTES) / 8192;
        assert_eq!(
            look(&c, &s, &one(shared_max as i64), now, Share::Shared),
            Look::Read
        );
        let over = one(shared_max as i64 + 1);
        assert_eq!(look(&c, &s, &over, now, Share::Shared), Look::TooCostly);
        assert_eq!(look(&c, &s, &over, now, Share::Whole), Look::Read);
        // With no reserve every set spends the whole total.
        c.storage_live_reserve_bytes = 0;
        s.storage.bytes = 6 * MIB;
        assert_eq!(storage_room(&c, &s.storage, 20, Share::Shared), None);
    }

    #[test]
    fn the_storage_budget_and_a_set_daily_limit_hold_admission() {
        use crate::shadow::storage::{JOB_BYTES, MIB, Pending};
        let mut c = cfg();
        c.storage_budget_bytes = 10 * MIB;
        c.storage_daily_bytes = Some(4 * MIB);
        let mut s = State::new("shadow-delphi-1");
        let fine = signals(5.0, 0);
        let p = |s: &State| pause(&c, s, false, ok_disk(), Some(&fine), None);
        assert_eq!(p(&s), None);
        // Under both: a run fits when its estimate does.
        s.storage.bytes = 3 * MIB;
        s.storage.day_bytes = 3 * MIB;
        assert_eq!(p(&s), None);
        assert_eq!(storage_room(&c, &s.storage, 10, Share::Whole), None);
        // 200 comments at the default 8 KiB a comment would pass the day's cap.
        assert_eq!(
            storage_room(&c, &s.storage, 200, Share::Whole),
            Some(Pause::StorageDaily)
        );
        // The day's cap reached.
        s.storage.day_bytes = 4 * MIB;
        assert_eq!(p(&s), Some(Pause::StorageDaily));
        // The budget reached, whatever the day.
        s.storage.bytes = 10 * MIB;
        s.storage.day_bytes = 0;
        assert_eq!(p(&s), Some(Pause::StorageBudget));
        // A run that would pass the budget is not admitted, a smaller one is.
        s.storage.bytes = 10 * MIB - 100 * 8192 - JOB_BYTES;
        assert_eq!(storage_room(&c, &s.storage, 100, Share::Whole), None);
        assert_eq!(
            storage_room(&c, &s.storage, 101, Share::Whole),
            Some(Pause::StorageBudget)
        );
        // A terminal run not yet measured holds admission.
        s.storage.bytes = 0;
        s.storage.pending.push(Pending {
            env: "shadow-delphi-1".into(),
            job_id: "j".into(),
            zid: 1,
            comments: 25,
            set: None,
        });
        assert_eq!(p(&s), Some(Pause::StorageUnmeasured));
        // The earlier reasons still come first.
        s.day_runs = c.daily_runs;
        assert_eq!(p(&s), Some(Pause::DailyCap));
    }

    #[test]
    fn candidates_are_read_only_when_changed_and_due_smallest_first() {
        let c = cfg();
        let mut s = State::new("shadow-delphi-1");
        let now = 10 * 86_400_000;
        let l = |zid, comments, last_modified| Live {
            zid,
            comments,
            last_modified,
        };
        let live = vec![
            l(1, 300, 9),
            l(2, 25, 9),
            l(3, 19, 9),
            l(4, 6000, 9),
            l(5, 25, 9),
            l(6, 40, 9),
        ];
        // Never seen: read, except outside the size bounds.
        assert_eq!(
            order(&c, &s, &live, now)
                .iter()
                .map(|x| x.zid)
                .collect::<Vec<_>>(),
            vec![2, 5, 6, 1]
        );
        assert_eq!(look(&c, &s, &live[2], now, Share::Whole), Look::TooSmall);
        assert_eq!(look(&c, &s, &live[3], now, Share::Whole), Look::TooLarge);
        // Admitted a day ago on the same selection and nothing changed:
        // unchanged.
        s.conversations.insert(
            2,
            Seen {
                last_modified: 9,
                digest: "d".into(),
                comments: 25,
                selection: Some(SELECTION.into()),
                selected: 25,
                admitted_digest: Some("d".into()),
                admitted_at_ms: Some(now - 86_400_000),
                ..Seen::default()
            },
        );
        assert_eq!(look(&c, &s, &live[1], now, Share::Whole), Look::Unchanged);
        // The same entry as an earlier build wrote it (no selection: its run
        // laid out every comment) is read again, whatever its time.
        let mut earlier = s.clone();
        if let Some(seen) = earlier.conversations.get_mut(&2) {
            seen.selection = None;
        }
        assert_eq!(look(&c, &earlier, &live[1], now, Share::Whole), Look::Read);
        // Its last census kept fewer than the floor and nothing changed
        // since: below the floor, without reading it again.
        let mut few = s.clone();
        if let Some(seen) = few.conversations.get_mut(&2) {
            seen.admitted_digest = None;
            seen.selected = 19;
        }
        assert_eq!(look(&c, &few, &live[1], now, Share::Whole), Look::TooSmall);
        // Admitted an hour ago: inside the rerun window, whatever changed.
        if let Some(seen) = s.conversations.get_mut(&2) {
            seen.admitted_at_ms = Some(now - 3_600_000);
            seen.last_modified = 1;
        }
        assert_eq!(look(&c, &s, &live[1], now, Share::Whole), Look::Recent);
        // A newer comment after the window: read again.
        if let Some(seen) = s.conversations.get_mut(&2) {
            seen.admitted_at_ms = Some(now - 2 * 86_400_000);
        }
        assert_eq!(look(&c, &s, &live[1], now, Share::Whole), Look::Read);
        let mut c2 = cfg();
        c2.rerun_after = Duration::ZERO;
        assert_eq!(look(&c2, &s, &live[1], now, Share::Whole), Look::Read);
    }

    #[test]
    fn benchmark_then_featured_then_current_each_once_in_its_own_order() {
        let c = cfg();
        let mut s = State::new("shadow-delphi-1");
        let now = 10 * 86_400_000;
        let l = |zid, comments| Live {
            zid,
            comments,
            last_modified: 9,
        };
        let current = vec![l(1, 300), l(2, 25), l(3, 40), l(9, 30), l(11, 60)];
        // 7 and 8 are not current (no recent comment); 9 is both; 5 is too
        // small, 6 too large: the bounds hold for every set.
        let benchmark = vec![
            l(8, 900),
            l(9, 30),
            l(5, 3),
            l(7, 50),
            l(6, 6000),
            l(8, 900),
        ];
        // Open data, most participants first, as the roster reads them; 9
        // and 7 are already benchmarks, 11 and 12 are featured, 12 not
        // current, 13 too small.
        let featured = vec![l(9, 30), l(12, 700), l(7, 50), l(11, 60), l(13, 2)];
        let got = |s: &State, c: &Config| {
            candidates(c, s, &benchmark, &featured, &current, now)
                .into_iter()
                .map(|(x, set)| (x.zid, set.word()))
                .collect::<Vec<_>>()
        };
        assert_eq!(
            got(&s, &c),
            vec![
                (8, "benchmark"),
                (9, "benchmark"),
                (7, "benchmark"),
                (12, "featured"),
                (11, "featured"),
                (2, "current"),
                (3, "current"),
                (1, "current")
            ]
        );
        // Run on its comment set and unchanged since: a benchmark
        // conversation is not run again; with a newer comment it is, first.
        let seen = |last_modified| Seen {
            last_modified,
            digest: "d".into(),
            comments: 900,
            selection: Some(SELECTION.into()),
            selected: 900,
            admitted_digest: Some("d".into()),
            admitted_at_ms: Some(now - 2 * 86_400_000),
            ..Seen::default()
        };
        s.conversations.insert(8, seen(9));
        assert_eq!(got(&s, &c)[0], (9, "benchmark"));
        s.conversations.insert(8, seen(1));
        assert_eq!(got(&s, &c)[0], (8, "benchmark"));
        // Inside the rerun window it waits like any other.
        if let Some(x) = s.conversations.get_mut(&8) {
            x.admitted_at_ms = Some(now - 3_600_000);
        }
        assert_eq!(got(&s, &c)[0], (9, "benchmark"));
        // With a daily limit set, one whose run alone would pass it is never
        // tried (it would hold back everything after it, every day); the next
        // goes.
        let mut tight = cfg();
        tight.storage_daily_bytes = Some(s.storage.estimate(800));
        assert_eq!(look(&tight, &s, &l(7, 800), now, Share::Shared), Look::Read);
        assert_eq!(
            look(&tight, &s, &l(7, 801), now, Share::Shared),
            Look::TooCostly
        );
        assert_eq!(got(&s, &tight)[0], (9, "benchmark"));
        assert!(
            got(&s, &tight).contains(&(12, "featured")),
            "700 comments still fit"
        );
        // No benchmark list and no open-data conversation: exactly the
        // current order.
        assert_eq!(
            candidates(&c, &s, &[], &[], &current, now)
                .into_iter()
                .map(|(x, _)| x.zid)
                .collect::<Vec<_>>(),
            order(&c, &s, &current, now)
                .into_iter()
                .map(|x| x.zid)
                .collect::<Vec<_>>()
        );
        // The featured set waits behind the benchmark set: a benchmark
        // conversation that is also open data is of the benchmark set, and
        // the featured ones follow the benchmark list whatever their sizes.
        let got_sets: Vec<_> = got(&s, &c).into_iter().map(|(_, w)| w).collect();
        let Some(first_featured) = got_sets.iter().position(|w| *w == "featured") else {
            panic!("no featured candidate: {got_sets:?}");
        };
        assert!(got_sets[..first_featured].iter().all(|w| *w == "benchmark"));
        assert!(got_sets[first_featured..].iter().all(|w| *w != "benchmark"));
    }

    #[test]
    fn the_set_words_are_closed_and_read_back() {
        assert_eq!(
            Set::ALL.map(Set::word),
            ["benchmark", "featured", "current"]
        );
        for set in Set::ALL {
            assert_eq!(Set::from_word(set.word()), Some(set));
            assert_eq!(
                serde_json::to_value(set).ok(),
                Some(Value::String(set.word().into()))
            );
        }
        for old in ["important", "large", "live", "twin", ""] {
            assert_eq!(Set::from_word(old), None, "{old}");
        }
        // The priority order is the declaration order.
        assert!(Set::Benchmark < Set::Featured && Set::Featured < Set::Current);
    }

    #[test]
    fn a_roster_entry_takes_this_cycles_live_read_when_there_is_one() {
        let l = |zid, comments, last_modified| Live {
            zid,
            comments,
            last_modified,
        };
        let roster = vec![l(3, 40, 5), l(1, 20, 5), l(2, 30, 5)];
        let live = vec![l(1, 21, 9), l(4, 50, 9)];
        assert_eq!(
            overlay(&roster, &live),
            vec![l(3, 40, 5), l(1, 21, 9), l(2, 30, 5)],
            "the roster's order, the live read's numbers, nothing added"
        );
        assert_eq!(overlay(&roster, &[]), roster);
    }

    fn census(digest: &str, selection_digest: &str, comments: i64, selected: i64) -> CommentSet {
        CommentSet {
            digest: digest.into(),
            comments,
            selection: SELECTION,
            selection_digest: selection_digest.into(),
            selected,
        }
    }

    #[test]
    fn admissions_are_keyed_by_the_selection_and_name_it() {
        let (digest, picked) = ("ab".repeat(32), "ef".repeat(32));
        let set = census(&digest, &picked, 42, 30);
        let a = admission(7, &set, Some(Set::Featured), None);
        let b = admission(7, &set, Some(Set::Featured), None);
        assert_eq!(a.key, b.key);
        assert_eq!(
            a.request_sha, b.request_sha,
            "the same set is the same request"
        );
        assert_ne!(a.job_id, b.job_id);
        assert!(a.key.len() <= 128);
        assert_eq!(a.key, format!("shadow:first:7:{}", &picked[..48]));
        // The run is told what it lays out, and that no report narrows it.
        assert_eq!(a.config["selection"], "participant_visible/1");
        assert_eq!(a.config["exclude_comment_selections"], false);
        assert!(a.config.get("include_moderation").is_none());
        let shadow = &a.config["shadow"];
        assert_eq!(shadow["schema"], "delphi-shadow/2");
        assert_eq!(shadow["comment_set_sha256"], digest);
        assert_eq!(shadow["comments"], 42);
        assert_eq!(shadow["selection"], "participant_visible/1");
        assert_eq!(shadow["selection_sha256"], picked);
        assert_eq!(shadow["selected"], 30);
        // The size class and the storage estimate are of what it embeds.
        assert_eq!(shadow["size_class"], "b 20-99");
        assert_eq!(shadow["twin_of"], Value::Null);
        // The run record names the set it was selected from; the key does not.
        assert_eq!(shadow["set"], "featured");
        let c = admission(7, &set, Some(Set::Current), None);
        assert_eq!(c.config["shadow"]["set"], "current");
        assert_eq!(c.key, a.key, "one selection, one key, whichever set");
        assert_ne!(c.request_sha, a.request_sha);
        // Every comment's set changed (a rejected comment added) and the
        // selection did not: the same key, so the queue runs nothing new.
        let more = census(&"cd".repeat(32), &picked, 43, 30);
        assert_eq!(admission(7, &more, Some(Set::Featured), None).key, a.key);
        // The selection changed: a new key.
        let moderated = census(&digest, &"01".repeat(32), 42, 29);
        assert_ne!(
            admission(7, &moderated, Some(Set::Featured), None).key,
            a.key
        );
        let t = admission(
            7,
            &set,
            Some(Set::Featured),
            Some("00000000-0000-4000-8000-000000000001"),
        );
        assert_eq!(
            t.config["shadow"]["set"], "featured",
            "a twin, its first run's"
        );
        assert_eq!(
            admission(7, &set, None, Some("j")).config["shadow"]["set"],
            Value::Null
        );
        assert_ne!(t.key, a.key);
        assert_ne!(t.request_sha, a.request_sha);
        assert_eq!(
            t.config["shadow"]["twin_of"],
            "00000000-0000-4000-8000-000000000001"
        );
        assert_ne!(admission(8, &set, Some(Set::Featured), None).key, a.key);
    }

    #[test]
    fn rest_twins_sizes_and_outcomes() {
        assert_eq!(rest_ms(0.5, 60_000), 60_000);
        assert_eq!(rest_ms(1.0, 60_000), 0);
        assert_eq!(rest_ms(0.25, 1000), 3000);
        assert!(!twin_due(0, 0));
        assert!(twin_due(1, 5));
        assert!(twin_due(3, 3) && !twin_due(3, 4));
        assert_eq!(size_class(19), "a under 20");
        assert_eq!(size_class(5000), "e 5000 up");
        assert_eq!(
            admitted_job(&json!({"outcome":"enqueued","job_id":"j"})),
            Some(("enqueued".into(), "j".into()))
        );
        assert_eq!(
            admitted_job(&json!({"outcome":"conflict","job_id":"j"})),
            None
        );
    }

    #[test]
    fn a_listed_conversation_names_every_comment_and_any_other_what_participants_are_shown() {
        assert_eq!(SELECTION, "participant_visible/1");
        assert_eq!(ALL_COMMENTS, "all_comments/1");
        assert_eq!(ALL_BUT_MODERATED_OUT, "all_but_moderated_out/1");
        let none = Rules::default();
        for zid in [0, 2, 7, i32::MAX] {
            assert_eq!(none.selection(zid), SELECTION, "no list: today's rule");
        }
        let listed = Rules {
            listed: [(7, ALL_COMMENTS), (8, ALL_BUT_MODERATED_OUT)]
                .into_iter()
                .collect(),
        };
        assert_eq!(listed.selection(7), ALL_COMMENTS);
        assert_eq!(listed.selection(8), ALL_BUT_MODERATED_OUT);
        assert_eq!(listed.selection(2), SELECTION);
    }

    #[test]
    fn a_conversation_whose_rule_changed_is_read_again_and_never_taken_as_unchanged() {
        let c = cfg();
        let now = 10 * 86_400_000;
        let live = Live {
            zid: 2,
            comments: 25,
            last_modified: 9,
        };
        let mut s = State::new("shadow-delphi-1");
        s.conversations.insert(
            2,
            Seen {
                last_modified: 9,
                digest: "d".into(),
                comments: 25,
                selection: Some(SELECTION.into()),
                selected: 25,
                admitted_digest: Some("d".into()),
                admitted_at_ms: Some(now - 2 * 86_400_000),
                ..Seen::default()
            },
        );
        let listed = Rules {
            listed: [(2, ALL_COMMENTS)].into_iter().collect(),
        };
        // Run under what participants are shown and nothing changed: unchanged
        // under that rule, read again under the other (and the other way).
        assert_eq!(look(&c, &s, &live, now, Share::Whole), Look::Unchanged);
        assert_eq!(
            look_under(&c, &s, &live, now, Share::Whole, SELECTION),
            Look::Unchanged
        );
        assert_eq!(
            look_under(&c, &s, &live, now, Share::Whole, ALL_COMMENTS),
            Look::Read
        );
        assert_eq!(
            look_under(&c, &s, &live, now, Share::Whole, ALL_BUT_MODERATED_OUT),
            Look::Read
        );
        let mut all = s.clone();
        if let Some(seen) = all.conversations.get_mut(&2) {
            seen.selection = Some(ALL_COMMENTS.into());
        }
        assert_eq!(
            look_under(&c, &all, &live, now, Share::Whole, ALL_COMMENTS),
            Look::Unchanged
        );
        assert_eq!(look(&c, &all, &live, now, Share::Whole), Look::Read);
        assert_eq!(
            look_under(&c, &all, &live, now, Share::Whole, ALL_BUT_MODERATED_OUT),
            Look::Read,
            "between the two report rules too"
        );
        // Below the floor under one rule says nothing of the other.
        let mut few = s.clone();
        if let Some(seen) = few.conversations.get_mut(&2) {
            seen.admitted_digest = None;
            seen.selected = 3;
        }
        assert_eq!(look(&c, &few, &live, now, Share::Whole), Look::TooSmall);
        assert_eq!(
            look_under(&c, &few, &live, now, Share::Whole, ALL_COMMENTS),
            Look::Read
        );
        // The rerun window and the bounds still hold it, whatever its rule.
        let mut recent = s.clone();
        if let Some(seen) = recent.conversations.get_mut(&2) {
            seen.admitted_at_ms = Some(now - 3_600_000);
        }
        assert_eq!(
            look_under(&c, &recent, &live, now, Share::Whole, ALL_COMMENTS),
            Look::Recent
        );
        let large = Live {
            comments: c.max_comments + 1,
            ..live.clone()
        };
        assert_eq!(
            look_under(&c, &s, &large, now, Share::Whole, ALL_COMMENTS),
            Look::TooLarge
        );
        // Through the candidates: listed, it is a candidate again, in every
        // set; not listed, it is not.
        let zids = |got: Vec<(Live, Set)>| {
            got.into_iter()
                .map(|(l, set)| (l.zid, set))
                .collect::<Vec<_>>()
        };
        let one = std::slice::from_ref(&live);
        assert!(candidates(&c, &s, &[], &[], one, now).is_empty());
        assert_eq!(
            zids(candidates_under(&c, &s, &[], &[], one, now, &listed)),
            [(2, Set::Current)]
        );
        assert_eq!(
            zids(candidates_under(&c, &s, one, &[], &[], now, &listed)),
            [(2, Set::Benchmark)]
        );
        assert_eq!(
            zids(candidates_under(&c, &s, &[], one, &[], now, &listed)),
            [(2, Set::Featured)]
        );
        assert_eq!(order_under(&c, &s, one, now, &listed), vec![live.clone()]);
        assert!(order(&c, &s, one, now).is_empty());
        // The rules choose no candidate: a listed conversation in no set is
        // not one.
        assert!(candidates_under(&c, &s, &[], &[], &[], now, &listed).is_empty());
    }

    #[test]
    fn an_all_comments_admission_names_its_selection_in_the_run_record_and_its_key() {
        let (digest, every) = ("ab".repeat(32), "cd".repeat(32));
        let census = CommentSet {
            digest: digest.clone(),
            comments: 42,
            selection: ALL_COMMENTS,
            selection_digest: every.clone(),
            selected: 42,
        };
        let a = admission(7, &census, Some(Set::Benchmark), None);
        assert_eq!(a.config["selection"], "all_comments/1");
        assert_eq!(a.config["exclude_comment_selections"], false);
        assert!(a.config.get("include_moderation").is_none());
        let shadow = &a.config["shadow"];
        assert_eq!(shadow["schema"], "delphi-shadow/2");
        assert_eq!(shadow["selection"], "all_comments/1");
        assert_eq!(shadow["selection_sha256"], every);
        assert_eq!(shadow["comment_set_sha256"], digest);
        assert_eq!(
            (shadow["comments"].as_i64(), shadow["selected"].as_i64()),
            (Some(42), Some(42))
        );
        assert_eq!(a.key, format!("shadow:first:7:{}", &every[..48]));
        // The same conversation under the other rule: another selection
        // digest (the name line differs), so another key and request.
        let shown = CommentSet {
            selection: SELECTION,
            selection_digest: "ef".repeat(32),
            selected: 30,
            ..census.clone()
        };
        let b = admission(7, &shown, Some(Set::Benchmark), None);
        assert_eq!(b.config["selection"], "participant_visible/1");
        assert_ne!(a.key, b.key);
        assert_ne!(a.request_sha, b.request_sha);
    }

    #[test]
    fn the_disk_of_the_temporary_directory_reads() -> std::io::Result<()> {
        let d = disk(&std::env::temp_dir())?;
        assert!(d.used_pct >= 0.0 && d.used_pct <= 100.0);
        Ok(())
    }
}
