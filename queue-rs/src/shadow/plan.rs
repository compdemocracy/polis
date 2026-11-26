//! The scheduler's decisions, as pure functions: whether to pause, which
//! conversation is next, and what its admission says.
use super::{
    config::{Config, SCOPE, Share},
    db::{Admission, CommentSet, Live, RuleRun, Signals},
    state::State,
    storage::Ledger,
};

/// The selection every run the scheduler admits names: the comments
/// participants are shown (`contract::participant_visible`). Each run embeds
/// every comment of its conversation and lays out, clusters and names these
/// only. It is part of the run's identity: its admission names it, its
/// digest keys the admission, and its run record carries both
/// (`config_effective.selection`, `config_effective.shadow`).
pub const SELECTION: &str = crate::jobs::inputs::contract::PARTICIPANT_VISIBLE;
/// A comment rule a list adds runs under: every comment of the conversation,
/// whatever its moderation (`contract::all_comments`).
pub const ALL_COMMENTS: &str = crate::jobs::inputs::contract::ALL_COMMENTS;
/// A comment rule a list adds runs under: every comment of the conversation
/// but the moderated-out ones (`contract::all_but_moderated_out`).
pub const ALL_BUT_MODERATED_OUT: &str = crate::jobs::inputs::contract::ALL_BUT_MODERATED_OUT;

/// The comment rules the operator's lists add (`config::RULE_LISTS`), per
/// conversation. They add runs and replace none: every conversation of the
/// three sets runs under [`SELECTION`] exactly as without the lists, and a
/// conversation a list names also runs under that list's rule, each
/// (conversation, rule) its own job: its own admission key, run record,
/// publication scope ([`rule_scope`]) and "unchanged" decision, read from its
/// own newest run in Postgres ([`rule_look`]). A conversation on both lists
/// runs under all three rules. The rule is an input of the run: an owner's
/// request could name one the same way. Held in memory only and read again
/// at every start; the run records in Postgres are what say which rule made
/// a run.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Rules {
    /// The conversations the lists name, each with its added rules in
    /// `config::RULE_LISTS` order, each once.
    pub listed: std::collections::BTreeMap<i32, Vec<&'static str>>,
}

impl Rules {
    /// The rules a list adds for conversation `zid`, besides [`SELECTION`].
    pub fn added(&self, zid: i32) -> &[&'static str] {
        self.listed.get(&zid).map_or(&[], Vec::as_slice)
    }

    /// Add `selection` for `zid`; false when it was already there (two codes
    /// of one conversation in one list: one job, not two).
    pub fn add(&mut self, zid: i32, selection: &'static str) -> bool {
        let rules = self.listed.entry(zid).or_default();
        if rules.contains(&selection) {
            return false;
        }
        rules.push(selection);
        true
    }
}

/// A comment rule's word: its selection's name without the version
/// (`all_comments/1` is `all_comments`).
pub fn rule_word(selection: &str) -> &str {
    selection.split('/').next().unwrap_or(selection)
}

/// The publication scope of runs under `selection`: [`SCOPE`] for
/// [`SELECTION`], as today; for a rule a list adds, its own
/// (`delphi:all_comments`, `delphi:all_but_moderated_out`), so each rule's
/// results and current pointer are its own and never replace another's.
pub fn rule_scope(selection: &str) -> String {
    if selection == SELECTION {
        SCOPE.to_owned()
    } else {
        format!("{SCOPE}:{}", rule_word(selection))
    }
}
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

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
    held(cfg, state, operator, disk, signals, paused, true)
}

/// The pauses a derived map job is asked under: every one of [`pause`] but
/// the daily cap of full runs (the backfill has its own, `backfill`).
pub fn derived_pause(
    cfg: &Config,
    state: &State,
    operator: bool,
    disk: Option<Disk>,
    signals: Option<&Signals>,
    paused: Option<Pause>,
) -> Option<Pause> {
    held(cfg, state, operator, disk, signals, paused, false)
}

fn held(
    cfg: &Config,
    state: &State,
    operator: bool,
    disk: Option<Disk>,
    signals: Option<&Signals>,
    paused: Option<Pause>,
    daily_cap: bool,
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
    if daily_cap && state.day_runs >= cfg.daily_runs {
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
/// comment, not of the selection.
pub fn look(cfg: &Config, state: &State, live: &Live, now_ms: i64, share: Share) -> Look {
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
    if seen.selection.as_deref() == Some(SELECTION) && seen.last_modified == live.last_modified {
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
    let mut out: Vec<Live> = live
        .iter()
        .filter(|l| look(cfg, state, l, now_ms, Share::Whole) == Look::Read)
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
    let mut out: Vec<(Live, Set)> = Vec::new();
    let mut tried = std::collections::BTreeSet::new();
    for (list, set) in [(benchmark, Set::Benchmark), (featured, Set::Featured)] {
        for l in list {
            if tried.insert(l.zid) && look(cfg, state, l, now_ms, set.share()) == Look::Read {
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
        order(cfg, state, &rest, now_ms)
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
/// it repeats, and is stored in the job's run record (`config_effective`). The
/// report filter (`exclude_comment_selections`) is off: the selection is what
/// participants are shown, which a report's own choices do not narrow. The
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
        scope: SCOPE.to_owned(),
        key,
        request_sha: sha256_hex(request.to_string().as_bytes()),
        job_id: uuid::Uuid::new_v4(),
        run_id: uuid::Uuid::new_v4(),
        config,
    }
}

/// What a (conversation, rule) a list adds is, before its census is read,
/// from its own newest run (`history`, read from Postgres, never from the
/// state file): the bounds and the storage a run would take, as [`look`]
/// holds them; `Recent` while its newest run is inside the rerun window (its
/// age by the database's clock);
/// `Unchanged` when this process already found that run's selection equal to
/// the census at the same newest comment change (`checked`, memory only: a
/// restart reads the census once more); otherwise `Read`. A non-terminal
/// newest run is the caller's to watch, not to admit beside.
pub fn rule_look(
    cfg: &Config,
    state: &State,
    live: &Live,
    share: Share,
    history: Option<&RuleRun>,
    checked: Option<&(i64, String)>,
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
    if let Some(run) = history
        && run.age_ms < cfg.rerun_after.as_millis() as i64
    {
        return Look::Recent;
    }
    let newest = history.map_or("", |r| r.job_id.as_str());
    if checked.is_some_and(|(modified, job)| *modified == live.last_modified && job == newest) {
        return Look::Unchanged;
    }
    Look::Read
}

/// Whether a (conversation, rule)'s census needs no run: its newest run was
/// admitted under the same selection digest. Only the newest counts: an older
/// run of the same digest has been superseded by a later one (the selection
/// changed and came back), and its results are not the rule's current ones.
pub fn rule_unchanged(history: Option<&RuleRun>, census: &CommentSet) -> bool {
    history.is_some_and(|r| r.selection_sha256.as_deref() == Some(census.selection_digest.as_str()))
}

/// The admission of a run a comment-rule list adds: [`admission`]'s
/// configuration (naming the rule, both digests and counts, the set), in the
/// rule's own scope ([`rule_scope`]), keyed by the selection's digest and the
/// newest run of this (conversation, rule) it follows (`after`, `none` for
/// the first). The key is derived from the durable run history alone: a
/// crash and restart that finds the same newest run admits the same key and
/// gets the same job back (`existing`), and a selection that changed and
/// came back follows a newer run, so it is a new key and a new job, never the
/// superseded one. A rule's key cannot equal a run of [`SELECTION`]'s: the
/// digest's second line is the rule's name, and the shape differs.
pub fn rule_admission(
    zid: i32,
    census: &CommentSet,
    set: Option<Set>,
    after: Option<&str>,
) -> Admission {
    let mut a = admission(zid, census, set, None);
    let scope = rule_scope(census.selection);
    a.config["shadow"]["follows"] = after.map_or(Value::Null, Value::from);
    let digest = &census.selection_digest;
    let after_key = after.map_or_else(|| "none".to_owned(), |j| j.replace('-', ""));
    a.key = format!(
        "shadow:first:{zid}:{}:{after_key}",
        &digest[..digest.len().min(48)]
    );
    let request = json!({"zid": zid, "kind": "first", "scope": scope, "config": a.config});
    a.request_sha = sha256_hex(request.to_string().as_bytes());
    a.scope = scope;
    a
}

/// The word a namer is recorded under: `<model>.p<prompt version>.<thinking>`
/// (`claude-haiku-5-5.p1.default`), the word `polis-topic-names` records.
/// Through Amazon Bedrock it is prefixed with the provider
/// (`bedrock.claude-sonnet-5-5.p1.default`, as `polis-topic-names` writes it);
/// a namer with no `provider`, or `anthropic`, has no prefix, so every word
/// stored before the provider existed keeps its meaning.
/// Refused unless the provider, model, prompt and thinking are ones the child
/// passes on (`jobs::child::namer`), so an admission never names a namer no
/// child runs.
pub fn namer_word(naming: &Value) -> Result<String, &'static str> {
    use crate::jobs::child::{NAMER_MODELS, NAMER_PROMPTS, NAMER_THINKING, namer_provider};
    let field = |key: &str, known: &[&'static str], refusal: &'static str| {
        naming
            .get(key)
            .and_then(Value::as_str)
            .and_then(|v| known.iter().copied().find(|k| *k == v))
            .ok_or(refusal)
    };
    let fields = naming.as_object().ok_or("naming_not_an_object")?;
    if fields.get("by").and_then(Value::as_str) != Some("model") {
        return Err("naming_unknown_by");
    }
    if fields.keys().any(|k| {
        !matches!(
            k.as_str(),
            "by" | "provider" | "model" | "prompt" | "thinking"
        )
    }) {
        return Err("naming_unknown_key");
    }
    let provider = namer_provider(fields)?;
    let model = field("model", &NAMER_MODELS, "naming_unknown_model")?;
    let prompt = field("prompt", &NAMER_PROMPTS, "naming_unknown_prompt")?;
    let thinking = field("thinking", &NAMER_THINKING, "naming_unknown_thinking")?;
    let version = prompt.rsplit('/').next().unwrap_or(prompt);
    Ok(match provider {
        None => format!("{model}.p{version}.{thinking}"),
        Some(p) => format!("{p}.{model}.p{version}.{thinking}"),
    })
}

/// The publication scope of runs named by `namer` (a [`namer_word`]): its
/// own, so a named run never moves the keyword run's current pointer and two
/// namers never move each other's.
pub fn names_scope(namer: &str) -> String {
    format!("{SCOPE}:names:{namer}")
}

/// The admission of a run that names the topics of `source`, a finished
/// keyword run of conversation `zid` under [`SELECTION`], with `naming` (the
/// configuration's `naming` object, `by: model`). `source_config` is the
/// source's own `config_effective`, read from its run record in Postgres.
///
/// Identity. The key is `shadow:names:<zid>:<source, no dashes>:<namer>`,
/// derived from the durable history alone, so a restart that asks again gets
/// the same job back (`existing`) and two identical requests are one job. The
/// scope is the namer's ([`names_scope`]). So a named run is never its
/// source's duplicate (another key shape and another scope), and two named
/// runs of one source with different namers are two jobs (another key and
/// another scope). The configuration carries the source's selection and
/// census digests, `names_of` and `naming`, and is stored in the job's run
/// record (`config_effective`).
///
/// Refused: a source under another comment rule (only the comments
/// participants are shown are ever sent to a model), a source that is itself
/// a named run (only keyword runs are named), and a namer no child runs.
pub fn names_admission(
    zid: i32,
    source: &str,
    source_config: &Value,
    naming: &Value,
) -> Result<Admission, &'static str> {
    let source = uuid::Uuid::parse_str(source).map_err(|_| "names_of_not_a_job")?;
    if source_config["selection"] != SELECTION {
        return Err("names_of_source_other_rule");
    }
    if !source_config["names_of"].is_null() || source_config["naming"]["by"] == "model" {
        return Err("names_of_source_named");
    }
    let namer = namer_word(naming)?;
    // `anthropic` is the default: stored as no `provider`, so a request that
    // names it is the same job (key, scope and request digest) as one that
    // does not.
    let mut naming = naming.clone();
    if naming["provider"] == "anthropic"
        && let Some(fields) = naming.as_object_mut()
    {
        fields.remove("provider");
    }
    let shadow = &source_config["shadow"];
    let source = source.hyphenated().to_string();
    let config = json!({
        "selection": SELECTION,
        "exclude_comment_selections": false,
        "names_of": source,
        "naming": naming,
        "shadow": {
            "schema": "delphi-shadow/2",
            "comment_set_sha256": shadow["comment_set_sha256"],
            "comments": shadow["comments"],
            "selection": SELECTION,
            "selection_sha256": shadow["selection_sha256"],
            "selected": shadow["selected"],
            "size_class": shadow["size_class"],
            "names_of": source,
            "namer": namer,
            "scheduler": concat!("polis-delphi-shadow ", env!("CARGO_PKG_VERSION")),
        }
    });
    let scope = names_scope(&namer);
    let key = format!("shadow:names:{zid}:{}:{namer}", source.replace('-', ""));
    let request = json!({"zid": zid, "kind": "names", "scope": scope, "config": config});
    Ok(Admission {
        zid,
        scope,
        key,
        request_sha: sha256_hex(request.to_string().as_bytes()),
        job_id: uuid::Uuid::new_v4(),
        run_id: uuid::Uuid::new_v4(),
        config,
    })
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
    fn the_lists_add_rules_per_conversation_each_once() {
        assert_eq!(SELECTION, "participant_visible/1");
        assert_eq!(ALL_COMMENTS, "all_comments/1");
        assert_eq!(ALL_BUT_MODERATED_OUT, "all_but_moderated_out/1");
        let mut r = Rules::default();
        assert!(r.added(7).is_empty(), "no list: no added rule");
        assert!(r.add(7, ALL_COMMENTS));
        assert!(r.add(7, ALL_BUT_MODERATED_OUT), "both lists: both rules");
        assert!(
            !r.add(7, ALL_COMMENTS),
            "an alias in the same list: one job"
        );
        assert!(r.add(8, ALL_BUT_MODERATED_OUT));
        assert_eq!(r.added(7), [ALL_COMMENTS, ALL_BUT_MODERATED_OUT]);
        assert_eq!(r.added(8), [ALL_BUT_MODERATED_OUT]);
        assert!(r.added(9).is_empty());
        // Each rule publishes in its own scope; what participants are shown
        // keeps today's.
        assert_eq!(rule_scope(SELECTION), "delphi");
        assert_eq!(rule_scope(ALL_COMMENTS), "delphi:all_comments");
        assert_eq!(
            rule_scope(ALL_BUT_MODERATED_OUT),
            "delphi:all_but_moderated_out"
        );
    }

    fn run(job: &str, age_ms: i64, digest: &str) -> RuleRun {
        RuleRun {
            job_id: job.into(),
            status: "succeeded".into(),
            age_ms,
            selection_sha256: Some(digest.into()),
            comment_set_sha256: Some("cs".into()),
            comments: 40,
            set: Some(Set::Current),
        }
    }

    #[test]
    fn a_rules_look_is_its_own_newest_run_never_the_state_file() {
        let c = cfg();
        let now = 10 * 86_400_000;
        let live = Live {
            zid: 7,
            comments: 40,
            last_modified: 9,
        };
        let mut s = State::new("shadow-delphi-1");
        // Whatever the state file says of the conversation's other run, it
        // does not decide this rule's.
        s.conversations.insert(
            7,
            Seen {
                last_modified: 9,
                digest: "d".into(),
                comments: 40,
                selection: Some(SELECTION.into()),
                selected: 40,
                admitted_digest: Some("d".into()),
                admitted_at_ms: Some(now - 2 * 86_400_000),
                ..Seen::default()
            },
        );
        assert_eq!(look(&c, &s, &live, now, Share::Whole), Look::Unchanged);
        let look_at = |history: Option<&RuleRun>, checked: Option<&(i64, String)>, _now: i64| {
            rule_look(&c, &s, &live, Share::Whole, history, checked)
        };
        assert_eq!(look_at(None, None, now), Look::Read, "never run: read");
        assert_eq!(
            look_at(None, Some(&(9, String::new())), now),
            Look::Unchanged,
            "never run, and found too small at this change: not read again"
        );
        let old = run("j1", 2 * 86_400_000, "d1");
        assert_eq!(look_at(Some(&old), None, now), Look::Read);
        let recent = run("j1", 3_600_000, "d1");
        assert_eq!(look_at(Some(&recent), None, now), Look::Recent);
        // Checked in this process at the same newest change, for this run:
        // unchanged. A newer comment, or a newer run, reads it again.
        let seen = (9, "j1".to_owned());
        assert_eq!(look_at(Some(&old), Some(&seen), now), Look::Unchanged);
        assert_eq!(
            look_at(Some(&old), Some(&(8, "j1".to_owned())), now),
            Look::Read
        );
        assert_eq!(
            look_at(Some(&run("j2", 2 * 86_400_000, "d1")), Some(&seen), now),
            Look::Read
        );
        // The bounds hold as for every run.
        let large = Live {
            comments: c.max_comments + 1,
            ..live.clone()
        };
        assert_eq!(
            rule_look(&c, &s, &large, Share::Whole, None, None),
            Look::TooLarge
        );
        let small = Live {
            comments: c.min_comments - 1,
            ..live.clone()
        };
        assert_eq!(
            rule_look(&c, &s, &small, Share::Whole, None, None),
            Look::TooSmall
        );
        // Unchanged only against the newest run: an older run of the same
        // digest was superseded.
        let census = census_under(ALL_COMMENTS, "d1");
        let old = run("j1", 2 * 86_400_000, &census.selection_digest);
        assert!(rule_unchanged(Some(&old), &census));
        assert!(!rule_unchanged(Some(&run("j2", 0, "d2")), &census));
        assert!(!rule_unchanged(None, &census));
    }

    fn census_under(selection: &'static str, digest: &str) -> CommentSet {
        CommentSet {
            digest: "ab".repeat(32),
            comments: 42,
            selection,
            selection_digest: digest.repeat(64 / digest.len().max(1)),
            selected: 42,
        }
    }

    #[test]
    fn a_rule_run_is_its_own_job_keyed_by_its_selection_and_the_run_it_follows() {
        let every = census_under(ALL_COMMENTS, "cd");
        let first = rule_admission(7, &every, Some(Set::Benchmark), None);
        assert_eq!(first.scope, "delphi:all_comments");
        assert_eq!(first.config["selection"], "all_comments/1");
        assert_eq!(first.config["exclude_comment_selections"], false);
        let shadow = &first.config["shadow"];
        assert_eq!(shadow["schema"], "delphi-shadow/2");
        assert_eq!(shadow["selection"], "all_comments/1");
        assert_eq!(shadow["selection_sha256"], every.selection_digest);
        assert_eq!(shadow["follows"], Value::Null);
        assert_eq!(
            first.key,
            format!("shadow:first:7:{}:none", &every.selection_digest[..48])
        );
        // A crash and restart with the same newest run: the same key and
        // request, so the queue hands back the same job.
        let again = rule_admission(7, &every, Some(Set::Benchmark), None);
        assert_eq!(
            (again.key.as_str(), again.request_sha.as_str()),
            (first.key.as_str(), first.request_sha.as_str())
        );
        // The same selection after a newer run (it changed and came back): a
        // new key, so a new job, never the superseded one.
        let job = "00000000-0000-4000-8000-0000000000aa";
        let back = rule_admission(7, &every, Some(Set::Benchmark), Some(job));
        assert_ne!(back.key, first.key);
        assert_eq!(back.config["shadow"]["follows"], job);
        assert!(back.key.ends_with(&format!(":{}", job.replace('-', ""))));
        let widest = rule_admission(i32::MIN, &every, Some(Set::Benchmark), Some(job));
        assert!(widest.key.len() <= 128, "{}", widest.key.len());
        // Every conversation's run is unchanged by the lists: today's key,
        // scope and request.
        let shown = census_under(SELECTION, "ef");
        let a = admission(7, &shown, Some(Set::Benchmark), None);
        assert_eq!(a.scope, "delphi");
        assert_eq!(
            a.key,
            format!("shadow:first:7:{}", &shown.selection_digest[..48])
        );
        assert!(a.config["shadow"].get("follows").is_none());
        // Each rule of one conversation is its own key and scope.
        let not_out = rule_admission(
            7,
            &census_under(ALL_BUT_MODERATED_OUT, "12"),
            Some(Set::Benchmark),
            None,
        );
        assert_eq!(not_out.scope, "delphi:all_but_moderated_out");
        assert!(
            [a.key.as_str(), first.key.as_str()]
                .iter()
                .all(|k| *k != not_out.key)
        );
    }

    const SOURCE: &str = "0e8a7c1e-1111-4222-8333-444455556666";

    fn haiku() -> Value {
        json!({"by": "model", "model": "claude-haiku-5-5", "prompt": "polis-topic-names/1", "thinking": "default"})
    }

    fn source_config() -> Value {
        admission(7, &census("d", "s", 40, 30), Some(Set::Current), None).config
    }

    #[test]
    #[allow(clippy::unwrap_used)]
    fn a_named_run_is_keyed_by_its_source_and_namer_in_the_namers_scope() {
        let a = names_admission(7, SOURCE, &source_config(), &haiku()).unwrap();
        assert_eq!(
            a.key,
            "shadow:names:7:0e8a7c1e111142228333444455556666:claude-haiku-5-5.p1.default"
        );
        assert!(a.key.len() <= 128);
        assert_eq!(a.scope, "delphi:names:claude-haiku-5-5.p1.default");
        assert_eq!(a.config["names_of"], SOURCE);
        assert_eq!(a.config["naming"], haiku());
        assert_eq!(a.config["selection"], SELECTION);
        // The source's census digests travel with it.
        let src = source_config();
        assert_eq!(
            a.config["shadow"]["selection_sha256"],
            src["shadow"]["selection_sha256"]
        );
        assert_eq!(
            a.config["shadow"]["comment_set_sha256"],
            src["shadow"]["comment_set_sha256"]
        );
        // The child's own checks accept the configuration.
        assert_eq!(
            crate::jobs::names_of::source(&a.config),
            Ok(Some(SOURCE.to_owned()))
        );
    }

    #[test]
    #[allow(clippy::unwrap_used)]
    fn two_identical_requests_are_one_job_and_every_other_is_another() {
        let a = names_admission(7, SOURCE, &source_config(), &haiku()).unwrap();
        let again = names_admission(7, SOURCE, &source_config(), &haiku()).unwrap();
        assert_eq!(
            (&a.key, &a.scope, &a.request_sha),
            (&again.key, &again.scope, &again.request_sha)
        );

        // Another namer: another key and another scope.
        let mut sonnet = haiku();
        sonnet["model"] = json!("claude-sonnet-5-5");
        let s = names_admission(7, SOURCE, &source_config(), &sonnet).unwrap();
        assert_ne!(s.key, a.key);
        assert_ne!(s.scope, a.scope);
        let mut off = haiku();
        off["thinking"] = json!("off");
        let o = names_admission(7, SOURCE, &source_config(), &off).unwrap();
        assert_ne!(o.key, a.key);
        assert_ne!(o.scope, a.scope);

        // Another source run: another key, the namer's scope.
        let other = names_admission(
            7,
            "0e8a7c1e-1111-4222-8333-444455556667",
            &source_config(),
            &haiku(),
        )
        .unwrap();
        assert_ne!(other.key, a.key);
        assert_eq!(other.scope, a.scope);

        // Never its source's duplicate, nor any keyword or rule run's.
        let c = census("d", "s", 40, 30);
        let first = admission(7, &c, Some(Set::Current), None);
        let rule = rule_admission(7, &census_under(ALL_COMMENTS, "d"), None, None);
        for keyword in [&first, &rule] {
            assert_ne!(keyword.key, a.key);
            assert_ne!(keyword.scope, a.scope);
        }
        // The keyword runs' admissions are what they were: no naming, no source.
        assert!(first.config.get("naming").is_none() && first.config.get("names_of").is_none());
        assert!(rule.config.get("naming").is_none() && rule.config.get("names_of").is_none());
    }

    #[test]
    #[allow(clippy::unwrap_used)]
    fn the_provider_names_its_own_job_and_its_absence_is_todays() {
        let today = names_admission(7, SOURCE, &source_config(), &haiku()).unwrap();
        // Today's word, key and scope, byte for byte, for an absent provider
        // and for the default named.
        let mut anthropic = haiku();
        anthropic["provider"] = json!("anthropic");
        assert_eq!(namer_word(&haiku()).unwrap(), "claude-haiku-5-5.p1.default");
        assert_eq!(
            namer_word(&anthropic).unwrap(),
            "claude-haiku-5-5.p1.default"
        );
        let named = names_admission(7, SOURCE, &source_config(), &anthropic).unwrap();
        assert_eq!(
            (&named.key, &named.scope, &named.request_sha, &named.config),
            (&today.key, &today.scope, &today.request_sha, &today.config)
        );
        assert_eq!(named.config["naming"], haiku());

        // Through Amazon Bedrock: another word, key and scope.
        let mut bedrock = haiku();
        bedrock["provider"] = json!("bedrock");
        assert_eq!(
            namer_word(&bedrock).unwrap(),
            "bedrock.claude-haiku-5-5.p1.default"
        );
        let b = names_admission(7, SOURCE, &source_config(), &bedrock).unwrap();
        assert_eq!(
            b.key,
            "shadow:names:7:0e8a7c1e111142228333444455556666:bedrock.claude-haiku-5-5.p1.default"
        );
        assert!(b.key.len() <= 128);
        assert_eq!(b.scope, "delphi:names:bedrock.claude-haiku-5-5.p1.default");
        assert_eq!(
            b.config["shadow"]["namer"],
            "bedrock.claude-haiku-5-5.p1.default"
        );
        assert_eq!(b.config["naming"], bedrock);
        assert_ne!(b.key, today.key);
        assert_ne!(b.scope, today.scope);
        assert_ne!(b.request_sha, today.request_sha);
        // The child accepts what the admission stores.
        assert_eq!(
            crate::jobs::names_of::source(&b.config),
            Ok(Some(SOURCE.to_owned()))
        );

        for provider in [json!("vertex"), json!("Bedrock"), Value::Null, json!(1)] {
            let mut n = haiku();
            n["provider"] = provider;
            assert_eq!(
                names_admission(7, SOURCE, &source_config(), &n).unwrap_err(),
                "naming_unknown_provider"
            );
        }
    }

    #[test]
    #[allow(clippy::unwrap_used)]
    fn only_a_keyword_run_of_the_shown_rule_is_named_and_only_by_a_known_namer() {
        let rule = rule_admission(7, &census_under(ALL_COMMENTS, "d"), None, None).config;
        assert_eq!(
            names_admission(7, SOURCE, &rule, &haiku()).unwrap_err(),
            "names_of_source_other_rule"
        );
        let not_out =
            rule_admission(7, &census_under(ALL_BUT_MODERATED_OUT, "d"), None, None).config;
        assert_eq!(
            names_admission(7, SOURCE, &not_out, &haiku()).unwrap_err(),
            "names_of_source_other_rule"
        );
        let named = names_admission(7, SOURCE, &source_config(), &haiku())
            .unwrap()
            .config;
        assert_eq!(
            names_admission(7, SOURCE, &named, &haiku()).unwrap_err(),
            "names_of_source_named"
        );
        assert_eq!(
            names_admission(7, "nope", &source_config(), &haiku()).unwrap_err(),
            "names_of_not_a_job"
        );
        for (change, word) in [
            (json!({"by": "keywords"}), "naming_unknown_by"),
            (json!("haiku"), "naming_not_an_object"),
            (
                json!({"by": "model", "model": "claude-opus", "prompt": "polis-topic-names/1", "thinking": "default"}),
                "naming_unknown_model",
            ),
            (
                json!({"by": "model", "model": "claude-haiku-5-5", "prompt": "polis-topic-names/2", "thinking": "default"}),
                "naming_unknown_prompt",
            ),
            (
                json!({"by": "model", "model": "claude-haiku-5-5", "prompt": "polis-topic-names/1", "thinking": "max"}),
                "naming_unknown_thinking",
            ),
            (
                json!({"by": "model", "model": "claude-haiku-5-5", "prompt": "polis-topic-names/1", "thinking": "off", "extra": 1}),
                "naming_unknown_key",
            ),
        ] {
            assert_eq!(
                names_admission(7, SOURCE, &source_config(), &change).unwrap_err(),
                word
            );
        }
    }

    #[test]
    fn the_disk_of_the_temporary_directory_reads() -> std::io::Result<()> {
        let d = disk(&std::env::temp_dir())?;
        assert!(d.used_pct >= 0.0 && d.used_pct <= 100.0);
        Ok(())
    }
}
