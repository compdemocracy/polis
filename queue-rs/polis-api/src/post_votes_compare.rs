//! The routing comparison in the vote shadow: straight after today's
//! next-comment selection for a copied vote, the typed routing library draws
//! again with its rule `stored-weights/1` on the same weights (one `Arc`, so
//! one math generation), the same candidates in the same order and the same
//! unit, and the two choices are compared.
//!
//! Off unless `POLIS_API_ROUTING_COMPARE_CONVERSATIONS` lists conversation
//! codes; read only by the shadow role's observe writer. A copy whose
//! conversation code is not on the list has nothing computed, and its line is
//! the line it has with the key absent.
//!
//! It adds no statement, no connection and no pool. It runs one at a time,
//! off the runtime threads, under `COMPARE_BOUND`, and is shed first. What
//! leaves the draw is an outcome, a bool and a coarse likelihood band: never
//! a comment id, the candidates, the unit, a weight or the library's receipt.
use super::*;
use polis_routing_plan::{
    Candidates, CommentId, DrawRefusal, Drawn, ParamSet, SourceId, StoredWeight, StoredWeights,
    Unit, stored_weights_1,
};
use sha2::{Digest, Sha256};

/// The key: the switch and the list of conversations in one.
pub(crate) const SWITCH: &str = "POLIS_API_ROUTING_COMPARE_CONVERSATIONS";
/// At most this many conversation codes.
pub(crate) const MAX_CONVERSATIONS: usize = 51;
/// A conversation code: 1 to 64 letters and digits.
const MAX_CODE_BYTES: usize = 64;
/// A selection with more candidates is not compared, and nothing is copied.
pub(crate) const MAX_COMPARE_CANDIDATES: usize = 20_000;
/// How long a copy waits for its comparison.
pub(crate) const COMPARE_BOUND: Duration = Duration::from_millis(100);
/// The rule drawn, by its registry name.
pub(crate) const RULE: &str = "stored-weights/1";
/// The weights' source, as the library's receipt names it (never printed).
const SOURCE: &str = "math_main comment-priorities, read by the vote shadow";

/// The weights today's draw used, carried out of the observed selection to
/// the comparison. Never printed: its `Debug` names the type only.
pub(crate) struct DrawWeights(pub(in crate::post_votes) Arc<writer_priorities::Weights>);

/// Tests: a `DrawWeights` dropped on this thread, so a test can see that a
/// selection carried the weights at all.
#[cfg(test)]
impl Drop for DrawWeights {
    fn drop(&mut self) {
        WEIGHTS_DROPPED.with(|n| n.set(n.get() + 1));
    }
}

impl std::fmt::Debug for DrawWeights {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("DrawWeights(..)")
    }
}

#[derive(Default)]
struct Counts {
    compared: AtomicU64,
    agreed: AtomicU64,
    differed: AtomicU64,
    refused: AtomicU64,
    no_selection: AtomicU64,
    too_many_candidates: AtomicU64,
    shed: AtomicU64,
    timed_out: AtomicU64,
}

pub(crate) struct Compare {
    /// Sorted, for the lookup and the digest.
    codes: Vec<String>,
    config: String,
    source: SourceId,
    permit: Arc<tokio::sync::Semaphore>,
    counts: Counts,
    /// Tests: how many comparisons began.
    #[cfg(test)]
    pub(crate) entered: AtomicU64,
    /// Tests: how long the blocking draw sleeps before it draws.
    #[cfg(test)]
    pub(crate) hold: Mutex<Option<Duration>>,
}

#[cfg(test)]
thread_local! {
    /// Tests: the comparison's entry points (`lists`, `run`) called on this
    /// thread, by any comparison.
    pub(crate) static CALLED: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
    /// Tests: the `DrawWeights` dropped on this thread.
    pub(crate) static WEIGHTS_DROPPED: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

/// The key as the process environment holds it. Absent or empty: off.
pub(crate) fn from_env() -> Result<Option<Box<Compare>>> {
    match std::env::var(SWITCH) {
        Err(std::env::VarError::NotPresent) => Ok(None),
        Err(std::env::VarError::NotUnicode(_)) => {
            anyhow::bail!("{SWITCH} is not a list of conversation codes")
        }
        Ok(raw) => Compare::new(&raw),
    }
}

/// The codes of the key's value, read as the Delphi shadow's benchmark list is
/// read: separated by commas or white space, each 1 to 64 letters and digits,
/// a repeat dropped. An entry that is not a code is refused by its position,
/// never its text; the list is the operator's.
fn parse_codes(raw: &str) -> Result<Vec<String>> {
    let mut codes: Vec<String> = Vec::new();
    let entries = raw
        .split(|c: char| c == ',' || c.is_whitespace())
        .filter(|entry| !entry.is_empty());
    for (i, entry) in entries.enumerate() {
        if !(1..=MAX_CODE_BYTES).contains(&entry.len())
            || !entry.bytes().all(|b| b.is_ascii_alphanumeric())
        {
            anyhow::bail!(
                "{SWITCH} entry {} is not a conversation code (1-64 letters and digits)",
                i + 1
            );
        }
        if !codes.iter().any(|code| code == entry) {
            codes.push(entry.to_owned());
        }
    }
    anyhow::ensure!(!codes.is_empty(), "{SWITCH} lists no conversation");
    anyhow::ensure!(
        codes.len() <= MAX_CONVERSATIONS,
        "{SWITCH} lists more than {MAX_CONVERSATIONS} conversations"
    );
    codes.sort_unstable();
    Ok(codes)
}

/// 16 lowercase hex: the first 8 bytes of SHA-256 over the rule's canonical
/// form, a newline and the sorted codes joined by commas.
fn config_digest(sorted: &[String]) -> String {
    let mut hash = Sha256::new();
    hash.update(ParamSet::StoredWeights1.to_plain().as_bytes());
    hash.update(b"\n");
    hash.update(sorted.join(",").as_bytes());
    hash.finalize()
        .iter()
        .take(8)
        .map(|b| format!("{b:02x}"))
        .collect()
}

impl Compare {
    /// The comparison for the key's value `raw`: None when it is empty.
    pub(crate) fn new(raw: &str) -> Result<Option<Box<Self>>> {
        if raw.trim().is_empty() {
            return Ok(None);
        }
        let codes = parse_codes(raw)?;
        let source = SourceId::new(SOURCE)
            .map_err(|_| anyhow::anyhow!("{SWITCH}: the comparison's source id is refused"))?;
        Ok(Some(Box::new(Self {
            config: config_digest(&codes),
            codes,
            source,
            permit: Arc::new(tokio::sync::Semaphore::new(1)),
            counts: Counts::default(),
            #[cfg(test)]
            entered: AtomicU64::new(0),
            #[cfg(test)]
            hold: Mutex::new(None),
        })))
    }

    /// Whether the copy's conversation code is on the list: exact match, no
    /// lookup, no allocation.
    pub(crate) fn lists(&self, code: &str) -> bool {
        #[cfg(test)]
        CALLED.with(|n| n.set(n.get() + 1));
        self.codes
            .binary_search_by(|listed| listed.as_str().cmp(code))
            .is_ok()
    }

    /// The comparison for one listed copy, after today's selection. The
    /// weights are taken out of the selection here, so they never reach the
    /// record that waits through the read-back.
    pub(crate) async fn run(&self, selection: Option<&mut Selection>, unit: f64) -> Routing {
        #[cfg(test)]
        self.entered.fetch_add(1, Ordering::Relaxed);
        #[cfg(test)]
        CALLED.with(|n| n.set(n.get() + 1));
        let Some(selection) = selection else {
            return self.ended(Outcome::NoSelection, None);
        };
        let weights = selection.weights.take();
        let band = Some(candidates_band(selection.candidates.len()));
        let Some(today) = selection.next_tid else {
            return self.ended(Outcome::NoSelection, band);
        };
        if selection.candidates.len() > MAX_COMPARE_CANDIDATES {
            return self.ended(Outcome::TooManyCandidates, band);
        }
        // Never awaited: a comparison already running sheds this one, before
        // anything is copied.
        let Ok(permit) = self.permit.clone().try_acquire_owned() else {
            return self.ended(Outcome::Shed, band);
        };
        let candidates = selection.candidates.clone();
        let source = self.source.clone();
        #[cfg(test)]
        let hold = *self.hold.lock().unwrap_or_else(|e| e.into_inner());
        let task = tokio::task::spawn_blocking(move || {
            // Held until the draw ends, even past the bound: the comparisons
            // after a slow one shed.
            let _permit = permit;
            #[cfg(test)]
            if let Some(hold) = hold {
                std::thread::sleep(hold);
            }
            draw(
                weights.as_ref().map(|w| w.0.as_ref()),
                &candidates,
                unit,
                today,
                &source,
            )
        });
        let outcome = match tokio::time::timeout(COMPARE_BOUND, task).await {
            Err(_) => Outcome::TimedOut,
            Ok(Err(_)) => Outcome::Refused("task_failed"),
            Ok(Ok(Drew::Compared { agrees, p_band })) => Outcome::Compared { agrees, p_band },
            Ok(Ok(Drew::Refused(name))) => Outcome::Refused(name),
        };
        self.ended(outcome, band)
    }

    fn ended(&self, outcome: Outcome, candidates_band: Option<&'static str>) -> Routing {
        let c = &self.counts;
        match outcome {
            Outcome::Compared { agrees, .. } => {
                c.compared.fetch_add(1, Ordering::Relaxed);
                if agrees { &c.agreed } else { &c.differed }
            }
            Outcome::Refused(_) => &c.refused,
            Outcome::NoSelection => &c.no_selection,
            Outcome::TooManyCandidates => &c.too_many_candidates,
            Outcome::Shed => &c.shed,
            Outcome::TimedOut => &c.timed_out,
        }
        .fetch_add(1, Ordering::Relaxed);
        Routing {
            outcome,
            candidates_band,
            config: self.config.clone(),
        }
    }

    /// `/health`'s `routingCompare`: the rule, the list's size (never its
    /// members), the configuration digest and the counts.
    pub(crate) fn health(&self) -> Js {
        let mut body = js::Obj::new();
        body.set("enabled", Js::Bool(false));
        body.set("mode", Js::Str("observe".into()));
        body.set("rule", Js::Str(RULE.into()));
        body.set("conversations", Js::Num(self.codes.len() as f64));
        body.set("config", Js::Str(self.config.clone()));
        let c = &self.counts;
        for (key, value) in [
            ("compared", &c.compared),
            ("agreed", &c.agreed),
            ("differed", &c.differed),
            ("refused", &c.refused),
            ("noSelection", &c.no_selection),
            ("tooManyCandidates", &c.too_many_candidates),
            ("shed", &c.shed),
            ("timedOut", &c.timed_out),
        ] {
            body.set(key, Js::Num(value.load(Ordering::Relaxed) as f64));
        }
        Js::Obj(body)
    }
}

/// What became of one comparison. No comment id in it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Outcome {
    Compared {
        agrees: bool,
        p_band: &'static str,
    },
    /// The refusal's name: a `DrawRefusal` variant in snake case,
    /// `candidate_id`, or `task_failed`.
    Refused(&'static str),
    NoSelection,
    TooManyCandidates,
    Shed,
    TimedOut,
}

/// One comparison's keys on the copy's line.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Routing {
    pub(crate) outcome: Outcome,
    pub(crate) candidates_band: Option<&'static str>,
    pub(crate) config: String,
}

/// The routing keys, in their order, after every other key of the line.
pub(crate) const ROUTING_KEYS: [&str; 8] = [
    "routing_rule",
    "routing_compare",
    "routing_generation",
    "agrees_with_today",
    "routing_refusal",
    "routing_p_band",
    "routing_candidates_band",
    "routing_config",
];

impl Routing {
    pub(crate) fn print_keys(&self, line: &mut js::Obj) {
        let text = |v: Option<&str>| v.map_or(Js::Null, |v| Js::Str(v.into()));
        let (compare, agrees, refusal, p_band) = match self.outcome {
            Outcome::Compared { agrees, p_band } => ("compared", Some(agrees), None, Some(p_band)),
            Outcome::Refused(name) => ("refused", None, Some(name), None),
            Outcome::NoSelection => ("no_selection", None, None, None),
            Outcome::TooManyCandidates => ("too_many_candidates", None, None, None),
            Outcome::Shed => ("shed", None, None, None),
            Outcome::TimedOut => ("timed_out", None, None, None),
        };
        // Both sides drew from one `Arc` of one generation; there is no
        // generation to name where the library did not run.
        let generation = matches!(self.outcome, Outcome::Compared { .. } | Outcome::Refused(_))
            .then_some("same");
        line.set(ROUTING_KEYS[0], Js::Str(RULE.into()));
        line.set(ROUTING_KEYS[1], Js::Str(compare.into()));
        line.set(ROUTING_KEYS[2], text(generation));
        line.set(ROUTING_KEYS[3], agrees.map_or(Js::Null, Js::Bool));
        line.set(ROUTING_KEYS[4], text(refusal));
        line.set(ROUTING_KEYS[5], text(p_band));
        line.set(ROUTING_KEYS[6], text(self.candidates_band));
        line.set(ROUTING_KEYS[7], Js::Str(self.config.clone()));
    }
}

/// What leaves the blocking draw: no comment id, no receipt.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Drew {
    Compared { agrees: bool, p_band: &'static str },
    Refused(&'static str),
}

/// The library's draw over today's inputs: the candidates in today's order,
/// a map of the candidates' own stored entries (None when none has one, which
/// draws as Node's `latestPriorities || {}` does), the unit, and the source.
pub(in crate::post_votes) fn drawn(
    weights: Option<&writer_priorities::Weights>,
    candidates: &[i32],
    unit: f64,
    source: &SourceId,
) -> Result<Drawn, &'static str> {
    let mut ids = Vec::with_capacity(candidates.len());
    for tid in candidates {
        ids.push(CommentId::try_from(*tid).map_err(|_| "candidate_id")?);
    }
    let entries: Vec<(CommentId, StoredWeight)> = match weights {
        None => vec![],
        Some(weights) => candidates
            .iter()
            .zip(&ids)
            .filter_map(|(tid, id)| weights.stored(*tid).map(|w| (*id, w)))
            .collect(),
    };
    let candidates = Candidates::new(ids).map_err(|r| refusal_name(&r))?;
    let stored = if entries.is_empty() {
        None
    } else {
        Some(StoredWeights::new(source.clone(), entries).map_err(|_| "duplicate_candidate")?)
    };
    let unit = Unit::new(unit).map_err(|r| refusal_name(&r))?;
    stored_weights_1(stored.as_ref(), &candidates, unit, source).map_err(|r| refusal_name(&r))
}

/// The comparison of one draw with today's choice `today`.
pub(in crate::post_votes) fn draw(
    weights: Option<&writer_priorities::Weights>,
    candidates: &[i32],
    unit: f64,
    today: i32,
    source: &SourceId,
) -> Drew {
    match drawn(weights, candidates, unit, source) {
        Ok(drawn) => Drew::Compared {
            agrees: i64::from(drawn.comment().get()) == i64::from(today),
            p_band: p_band(drawn.probability()),
        },
        Err(name) => Drew::Refused(name),
    }
}

/// The refusal's variant in snake case: never its payload or its `Display`,
/// which print comment ids.
pub(crate) fn refusal_name(refusal: &DrawRefusal) -> &'static str {
    match refusal {
        DrawRefusal::UnitOutOfRange => "unit_out_of_range",
        DrawRefusal::Empty => "empty",
        DrawRefusal::DuplicateCandidate(_) => "duplicate_candidate",
        DrawRefusal::TooManyCandidates(_) => "too_many_candidates",
        DrawRefusal::UnsupportedLegacyWeight(_) => "unsupported_legacy_weight",
        DrawRefusal::InvalidDrawWeight(_) => "invalid_draw_weight",
        DrawRefusal::TotalBelowNormal => "total_below_normal",
        DrawRefusal::NoInterval => "no_interval",
        DrawRefusal::ZeroMass => "zero_mass",
        DrawRefusal::NumericDegeneracy(_) => "numeric_degeneracy",
        DrawRefusal::InvalidShare => "invalid_share",
        DrawRefusal::ExcludedCandidate(_) => "excluded_candidate",
        DrawRefusal::NeedsBaseline(_) => "needs_baseline",
    }
}

/// The decade band of the library pick's probability.
pub(crate) fn p_band(p: f64) -> &'static str {
    if p < 0.001 {
        "lt_0.001"
    } else if p < 0.01 {
        "0.001_0.01"
    } else if p < 0.1 {
        "0.01_0.1"
    } else if p < 0.5 {
        "0.1_0.5"
    } else {
        "ge_0.5"
    }
}

/// The band of the candidate count (`0` for an empty selection).
pub(crate) fn candidates_band(n: usize) -> &'static str {
    match n {
        0 => "0",
        1 => "1",
        2..=9 => "2_9",
        10..=99 => "10_99",
        100..=999 => "100_999",
        1000..=9999 => "1000_9999",
        _ => "ge_10000",
    }
}

#[cfg(test)]
#[path = "post_votes_compare_tests.rs"]
mod tests;
