//! From the compiled queries' results and the stop rule's metrics to the
//! printed tables and the verdict. Everything printed is a count, a share, a
//! duration or a test statistic: never a request id, a conversation or
//! statement number, a participant or text.
use crate::aws::{Row, Window};
use crate::route::{Kind, ROW_LIMIT, Route};
use std::collections::BTreeMap;
use std::fmt::Write as _;

/// Each query's rows, or why there are none (not run, refused).
pub type Results = BTreeMap<String, Result<Vec<Row>, String>>;
/// Each metric's datapoints (epoch seconds, value), or why there are none.
pub type Metrics = BTreeMap<String, Result<Vec<(i64, f64)>, String>>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    Pass,
    /// A stop mark: remove the shadow.
    Stop,
    TooLittle,
    /// No stop, enough evidence, and a criterion missed: examine before the
    /// flip.
    Examine,
}

impl Verdict {
    pub fn exit_code(self) -> i32 {
        match self {
            Verdict::Pass => 0,
            Verdict::Stop => 1,
            Verdict::TooLittle => 2,
            Verdict::Examine => 4,
        }
    }
    pub(crate) fn text(self) -> &'static str {
        match self {
            Verdict::Pass => "PASS",
            Verdict::Stop => "STOP",
            Verdict::TooLittle => "TOO LITTLE EVIDENCE",
            Verdict::Examine => "EXAMINE",
        }
    }
}

/// How one criterion came out.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mark {
    Pass,
    /// Missed: examine before the flip.
    Miss,
    /// A stop on its own: a status disagreement, a vote read back with the
    /// other sign, a would-be failure, the stop rule.
    Stop,
    /// Below the evidence bar.
    Short,
    /// Could not be evaluated (a query refused or not run, no metric).
    NotEvaluated,
    /// Reported, with no threshold.
    Info,
}

impl Mark {
    pub(crate) fn text(self) -> &'static str {
        match self {
            Mark::Pass => "pass",
            Mark::Miss => "MISS",
            Mark::Stop => "STOP",
            Mark::Short => "too little evidence",
            Mark::NotEvaluated => "not evaluated",
            Mark::Info => "reported",
        }
    }
}

pub struct Criterion {
    pub name: &'static str,
    pub value: String,
    pub mark: Mark,
}

pub struct Report {
    pub text: String,
    pub criteria: Vec<Criterion>,
    pub verdict: Verdict,
}

impl Report {
    pub fn mark(&self, name: &str) -> Option<Mark> {
        self.criteria
            .iter()
            .find(|c| c.name == name)
            .map(|c| c.mark)
    }
}

pub struct Inputs<'a> {
    pub route: Route,
    pub window: Window,
    pub results: &'a Results,
    pub metrics: &'a Metrics,
}

pub(crate) fn num(row: &Row, key: &str) -> Option<f64> {
    row.get(key).and_then(|v| v.trim().parse::<f64>().ok())
}
pub(crate) fn count(row: &Row, key: &str) -> u64 {
    num(row, key)
        .map(|v| v.max(0.0).round() as u64)
        .unwrap_or(0)
}
pub(crate) fn text<'r>(row: &'r Row, key: &str) -> &'r str {
    row.get(key).map(String::as_str).unwrap_or("")
}
pub(crate) fn sum(rows: &[Row], key: &str, keep: impl Fn(&Row) -> bool) -> u64 {
    rows.iter().filter(|r| keep(r)).map(|r| count(r, key)).sum()
}
pub(crate) fn share(part: u64, whole: u64) -> Option<f64> {
    (whole > 0).then(|| part as f64 * 100.0 / whole as f64)
}
pub(crate) fn pct(value: Option<f64>) -> String {
    match value {
        Some(v) => format!("{v:.2} %"),
        None => "n/a".into(),
    }
}
pub(crate) fn ms(value: Option<f64>) -> String {
    match value {
        Some(v) => format!("{v:.1} ms"),
        None => "n/a".into(),
    }
}
/// A status, or the empty group Logs Insights reports when there is none. A
/// number that is not an HTTP status is not printed as one.
pub(crate) fn status(row: &Row, key: &str) -> String {
    match num(row, key) {
        Some(v) if (100.0..=599.0).contains(&v) => format!("{}", v.round() as i64),
        Some(_) => "other".into(),
        None => "none".into(),
    }
}
/// A reason as the shadow writes one: lower-case letters and underscores.
/// Anything else in that field is not printed.
pub(crate) fn class_word(word: &str) -> &str {
    if !word.is_empty()
        && word.len() <= 40
        && word.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
    {
        word
    } else {
        "(not a reason word)"
    }
}
const WOULD: [&str; 3] = ["would_serve", "would_hand_back", "would_fail"];

/// The design's numbers for the week.
pub(crate) mod bar {
    pub const MIRROR_P99_MS: f64 = 5.0;
    pub const MIRROR_MAX_MS: f64 = 60.0;
    pub const COVERAGE: f64 = 99.5;
    pub const ADMITTED: u64 = 5000;
    pub const CONVERSATIONS: u64 = 50;
    pub const NODE_VOTE: f64 = 99.9;
    pub const COUNTS: f64 = 99.5;
    pub const EXHAUSTION: f64 = 99.9;
    pub const MEMBERSHIP: f64 = 98.0;
    pub const ADMISSION_P99_MS: f64 = 100.0;
    pub const TOTAL_P99_MS: f64 = 400.0;
    pub const DEGRADED: f64 = 1.0;
    // The stop rule.
    pub const DB_CPU: f64 = 60.0;
    pub const STOP_MIRROR_P99_MS: f64 = 10.0;
    pub const STOP_MIRROR_MAX_MS: f64 = 60.0;
    pub const LB_RATIO: f64 = 1.2;
    pub const LB_FLOOR_S: f64 = 0.1;
    pub const SUSTAINED_HOURS: u32 = 3;
    pub const VOTE_P99_RATIO: f64 = 1.2;
    pub const VOTE_P99_FLOOR_MS: f64 = 50.0;
    pub const VOTE_MIN_PER_HOUR: u64 = 20;
    pub const VOTE_5XX_MIN: u64 = 10;
    pub const VOTE_5XX_RATIO: f64 = 3.0;
    /// Percentage points (the shares are in percent).
    pub const VOTE_5XX_POINTS: f64 = 0.5;
    /// The share of a window's datapoints a metric must have been read for
    /// before the stop rule says anything from it, in percent. CloudWatch
    /// answers a wrong resource name, and a span older than it keeps a
    /// period for, with no datapoints and no error.
    pub const METRIC_READ: u64 = 95;
}

/// Whether `have` datapoints are too few to speak for a window that should
/// hold `expected` of them (0 when the window is not known, as for saved
/// results reported without one: then only "none at all" can be told).
fn too_few(have: usize, expected: i64) -> bool {
    have == 0 || (expected > 0 && (have as u64) * 100 < expected as u64 * bar::METRIC_READ)
}

/// The verdict a report's criteria give: a stop first, then too little
/// evidence (a count short of its minimum, or a criterion not evaluated),
/// then a miss to examine, else a pass.
pub(crate) fn verdict_of(criteria: &[Criterion]) -> Verdict {
    if criteria.iter().any(|c| c.mark == Mark::Stop) {
        Verdict::Stop
    } else if criteria
        .iter()
        .any(|c| matches!(c.mark, Mark::Short | Mark::NotEvaluated))
    {
        Verdict::TooLittle
    } else if criteria.iter().any(|c| c.mark == Mark::Miss) {
        Verdict::Examine
    } else {
        Verdict::Pass
    }
}

/// A query's rows for a report section, or why the section has none: not
/// run, refused, or returned as many rows as Logs Insights returns at most,
/// in which case the result may be cut off and nothing is reported from it.
pub(crate) fn section_rows<'a>(results: &'a Results, name: &str) -> Result<&'a [Row], String> {
    match results.get(name) {
        Some(Ok(rows)) if rows.len() >= ROW_LIMIT => Err(format!(
            "{name}: {ROW_LIMIT} rows, the most Logs Insights returns; the result may be cut off"
        )),
        Some(Ok(rows)) => Ok(rows.as_slice()),
        Some(Err(why)) => Err(format!("{name}: {why}")),
        None => Err(format!("{name}: not run")),
    }
}

/// Section 2, the same for every route: what became of each copy, and how
/// long the copy held the participant's connection. Returns the hold's
/// largest hourly p99 and its largest value, in milliseconds.
pub(crate) fn copy_section(
    out: &mut String,
    add: &mut impl FnMut(&'static str, String, Mark),
    mirror: Result<&[Row], String>,
    hours: Result<&[Row], String>,
) -> Option<(f64, f64)> {
    let _ = writeln!(out, "\n2. The copy (nginx)");
    let mut hold: Option<(f64, f64)> = None;
    match mirror {
        Ok(mirror) => {
            let copied_row = |row: &Row| {
                text(row, "mirror_upstream_status")
                    .bytes()
                    .any(|b| b.is_ascii_digit())
            };
            let all = sum(mirror, "n", |_| true);
            let copied = sum(mirror, "n", copied_row);
            let skipped = sum(mirror, "n", |row| {
                !copied_row(row) && status(row, "mirror_status") == "204"
            });
            let absent = sum(mirror, "n", |row| {
                !copied_row(row) && status(row, "mirror_status") != "204"
            });
            let up = |code: &str| {
                sum(mirror, "n", |row| {
                    text(row, "mirror_upstream_status") == code
                })
            };
            let _ = writeln!(
                out,
                "   copies logged                                    {all}"
            );
            let _ = writeln!(
                out,
                "   copied (an upstream status)                      {copied} ({})",
                pct(share(copied, all))
            );
            let _ = writeln!(
                out,
                "   not copied: outside the 1..9999-byte bound       {skipped}"
            );
            let _ = writeln!(
                out,
                "   not copied: the shadow's host absent             {absent}"
            );
            let _ = writeln!(
                out,
                "   the shadow answered 204 / refused 502 / timed out 504: {} / {} / {}",
                up("204"),
                up("502"),
                up("504")
            );
            add(
                "copied share",
                pct(share(copied, all)),
                if all > 0 {
                    Mark::Info
                } else {
                    Mark::NotEvaluated
                },
            );
        }
        Err(why) => {
            let _ = writeln!(out, "   unavailable: {why}");
            add("copied share", why, Mark::NotEvaluated);
        }
    }
    match hours {
        Ok(hours) if !hours.is_empty() => {
            let worst_p99 = hours
                .iter()
                .filter_map(|row| num(row, "p99_s"))
                .fold(0.0, f64::max)
                * 1000.0;
            let worst = hours
                .iter()
                .filter_map(|row| num(row, "max_s"))
                .fold(0.0, f64::max)
                * 1000.0;
            hold = Some((worst_p99, worst));
            let _ = writeln!(
                out,
                "   the copy's hold: largest hourly p99 {}, largest {} ({} hours)",
                ms(Some(worst_p99)),
                ms(Some(worst)),
                hours.len()
            );
        }
        Ok(_) => {
            let _ = writeln!(out, "   the copy's hold: no copies");
        }
        Err(why) => {
            let _ = writeln!(out, "   the copy's hold unavailable: {why}");
        }
    }
    match hold {
        Some((p99, max)) => add(
            "the copy's cost",
            format!(
                "largest hourly p99 {}, largest {}",
                ms(Some(p99)),
                ms(Some(max))
            ),
            if p99 <= bar::MIRROR_P99_MS && max <= bar::MIRROR_MAX_MS {
                Mark::Pass
            } else {
                Mark::Miss
            },
        ),
        None => add("the copy's cost", "no copies".into(), Mark::NotEvaluated),
    }

    hold
}

/// Section 3, the same for every route: Node's status and time as nginx saw
/// them.
pub(crate) fn edge_section(out: &mut String, noun: &str, edge: Result<&[Row], String>) {
    let _ = writeln!(
        out,
        "\n3. Node's answers to shadowed {noun}, as nginx saw them"
    );
    match edge {
        Ok(edge) => {
            let mut by: Vec<(String, u64)> = edge
                .iter()
                .map(|row| (status(row, "edge_status"), count(row, "n")))
                .collect();
            by.sort();
            for (code, n) in &by {
                let _ = writeln!(out, "   status {code:<6} {n}");
            }
            if let Some(ok) = edge.iter().find(|row| status(row, "edge_status") == "200") {
                let _ = writeln!(
                    out,
                    "   Node's time on 200s: p50 {}, p99 {}, largest {}",
                    ms(num(ok, "node_p50_s").map(|s| s * 1000.0)),
                    ms(num(ok, "node_p99_s").map(|s| s * 1000.0)),
                    ms(num(ok, "node_max_s").map(|s| s * 1000.0))
                );
            }
        }
        Err(why) => {
            let _ = writeln!(out, "   unavailable: {why}");
        }
    }
}

pub fn build(inputs: &Inputs) -> Report {
    match inputs.route.kind {
        Kind::Votes { node_line } => build_votes(inputs, node_line),
        Kind::Comments => crate::report_comments::build(inputs),
    }
}

fn build_votes(inputs: &Inputs, node_line: &'static str) -> Report {
    let mut out = String::new();
    let mut criteria: Vec<Criterion> = vec![];
    let mut add = |name: &'static str, value: String, mark: Mark| {
        criteria.push(Criterion { name, value, mark })
    };
    let rows = |name: &str| section_rows(inputs.results, name);
    let r = inputs.route;
    let _ = writeln!(out, "polis-shadow: {} ({})", r.route, r.shadow);
    let _ = writeln!(
        out,
        "window: {} to {} (UTC, end excluded)",
        crate::time::format(inputs.window.from_s),
        crate::time::format(inputs.window.to_s)
    );

    // ---- Lines.
    let _ = writeln!(out, "\n1. Lines in the window");
    let mut edge_lines = None;
    match rows("lines") {
        Ok(lines) => {
            for (message, label) in [
                ("shadow_edge", "nginx, each shadowed vote (shadow_edge)"),
                ("shadow_mirror", "nginx, each copy (shadow_mirror)"),
                (node_line, "Node, each handler reply"),
                ("http_request", "Node, access lines with a request id"),
                (
                    "shadow_observation",
                    "the shadow, each copy (shadow_observation)",
                ),
            ] {
                // Node's access line is written "http_request http_request".
                let n = sum(lines, "lines", |row| {
                    let m = text(row, "message");
                    m == message
                        || (message == "http_request" && crate::query::ACCESS_LINE.contains(&m))
                });
                if message == "shadow_edge" {
                    edge_lines = Some(n);
                }
                let _ = writeln!(out, "   {label:<48} {n}");
            }
        }
        Err(why) => {
            let _ = writeln!(out, "   unavailable: {why}");
        }
    }

    // ---- The copy.
    let hold = copy_section(&mut out, &mut add, rows("mirror"), rows("mirror_hours"));

    // ---- Node as nginx saw it.
    edge_section(&mut out, "votes", rows("edge"));

    // ---- The shadow's observations.
    let _ = writeln!(out, "\n4. The shadow's observations");
    let mut admitted_total = None;
    match rows("observations") {
        Ok(obs) => {
            let outcome = |row: &Row| text(row, "outcome").to_owned();
            let observed = sum(obs, "n", |row| WOULD.contains(&text(row, "outcome")));
            let admitted = sum(obs, "n", |row| {
                WOULD.contains(&text(row, "outcome")) && text(row, "admitted") == "1"
            });
            admitted_total = Some(admitted);
            for o in [
                "would_serve",
                "would_hand_back",
                "would_fail",
                "shed",
                "not_observed",
            ] {
                let n = sum(obs, "n", |row| outcome(row) == o);
                let _ = writeln!(out, "   {o:<20} {n}");
            }
            let _ = writeln!(
                out,
                "   admitted {admitted} of {observed} observed ({})",
                pct(share(admitted, observed))
            );
            add(
                "admitted share",
                format!(
                    "{} ({admitted} of {observed})",
                    pct(share(admitted, observed))
                ),
                if observed > 0 {
                    Mark::Info
                } else {
                    Mark::NotEvaluated
                },
            );
            let mut reasons: BTreeMap<String, u64> = BTreeMap::new();
            for row in obs
                .iter()
                .filter(|row| text(row, "outcome") == "would_hand_back")
            {
                *reasons.entry(text(row, "reason").to_owned()).or_default() += count(row, "n");
            }
            let mut reasons: Vec<_> = reasons.into_iter().collect();
            reasons.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
            let _ = writeln!(out, "   hand-back reasons:");
            for (reason, n) in &reasons {
                let reason = if reason.is_empty() {
                    "(none given)"
                } else {
                    class_word(reason)
                };
                let _ = writeln!(out, "     {reason:<26} {n}");
            }
            let mut shed: BTreeMap<String, u64> = BTreeMap::new();
            for row in obs.iter().filter(|row| text(row, "outcome") == "shed") {
                *shed.entry(text(row, "reason").to_owned()).or_default() += count(row, "n");
            }
            for (reason, n) in shed {
                let _ = writeln!(out, "   shed ({}): {n}", class_word(&reason));
            }
            let mut statuses: BTreeMap<String, u64> = BTreeMap::new();
            for row in obs
                .iter()
                .filter(|row| WOULD.contains(&text(row, "outcome")))
            {
                *statuses.entry(status(row, "status")).or_default() += count(row, "n");
            }
            let _ = writeln!(out, "   would-be statuses:");
            for (code, n) in &statuses {
                let _ = writeln!(out, "     {code:<6} {n}");
            }
            // CORS refusals are the prelude's 500 and stay out of the would-be
            // failures; they are reported on their own.
            let cors = sum(obs, "n", |row| {
                text(row, "outcome") == "would_fail" && text(row, "reason") == "cors"
            });
            let fails = sum(obs, "n", |row| {
                text(row, "outcome") == "would_fail" && text(row, "reason") != "cors"
            });
            let admitted_5xx = sum(obs, "n", |row| {
                text(row, "admitted") == "1"
                    && WOULD.contains(&text(row, "outcome"))
                    && text(row, "reason") != "cors"
                    && num(row, "status").is_some_and(|s| s >= 500.0 && s != 502.0)
            });
            let _ = writeln!(
                out,
                "   would_fail {fails} (CORS refusals, not counted: {cors}); admitted would-be 5xx other than 502: {admitted_5xx}"
            );
            add(
                "would-be failures",
                format!(
                    "would_fail {fails}, admitted would-be 5xx {admitted_5xx} (CORS refusals {cors}, not counted)"
                ),
                if fails == 0 && admitted_5xx == 0 {
                    Mark::Pass
                } else {
                    Mark::Stop
                },
            );
            // Admitted would-be 200s: the readback, the follow-on, membership.
            let served = |row: &Row| {
                text(row, "admitted") == "1"
                    && text(row, "outcome") == "would_serve"
                    && status(row, "status") == "200"
            };
            let by = |key: &str, value: &str| {
                sum(obs, "n", |row| served(row) && text(row, key) == value)
            };
            let served_n = sum(obs, "n", served);
            let (same, ambiguous, different, absent) = (
                by("node_vote", "same"),
                by("node_vote", "ambiguous"),
                by("node_vote", "different"),
                by("node_vote", "absent"),
            );
            let unavailable = by("node_vote", "unavailable");
            let unchecked = by("node_vote", "not_checked");
            let closed_same = sum(obs, "n", |row| {
                text(row, "admitted") == "1"
                    && status(row, "status") == "403"
                    && text(row, "node_vote") == "same"
            });
            let _ = writeln!(
                out,
                "   Node's stored vote, read back (admitted would-be 200s, {served_n}): same {same}, ambiguous {ambiguous}, different {different}, absent {absent}, unavailable {unavailable}, not checked {unchecked}"
            );
            let _ = writeln!(
                out,
                "   would-be 403 (closed) that Node stored: {closed_same}"
            );
            // Over every admitted would-be 200, so a readback that never ran
            // (unavailable, not checked) counts against the share.
            let agree = share(same + ambiguous, served_n);
            add(
                "node_vote",
                format!(
                    "different {different}; same or ambiguous {} of {served_n} admitted would-be 200s ({} read back); would-be 403 stored by Node {closed_same}",
                    pct(agree),
                    same + ambiguous + different + absent
                ),
                if different > 0 {
                    Mark::Stop
                } else if served_n == 0 {
                    Mark::NotEvaluated
                } else if agree.is_some_and(|a| a >= bar::NODE_VOTE) && closed_same == 0 {
                    Mark::Pass
                } else {
                    Mark::Miss
                },
            );
            let (complete, none, degraded) = (
                by("follow_on", "complete"),
                by("follow_on", "absent"),
                by("follow_on", "degraded"),
            );
            let _ = writeln!(
                out,
                "   next statement (admitted would-be 200s): selected {complete}, none left {none}, degraded {degraded}"
            );
            let (hit, miss, new, revote, none_prev) = (
                by("prev", "hit"),
                by("prev", "miss"),
                by("prev", "new"),
                by("prev", "revote"),
                by("prev", "none"),
            );
            let _ = writeln!(
                out,
                "   membership: hit {hit}, miss {miss}, new {new}, revote {revote}, none (first here, or the other box) {none_prev}"
            );
            let membership = share(hit, hit + miss);
            add(
                "membership",
                format!(
                    "hit {} of hit and miss ({hit} / {})",
                    pct(membership),
                    hit + miss
                ),
                match membership {
                    None => Mark::NotEvaluated,
                    Some(m) if m >= bar::MEMBERSHIP => Mark::Pass,
                    Some(_) => Mark::Miss,
                },
            );
            let timeouts = sum(obs, "n", |row| text(row, "reason") == "admission_timeout");
            let degraded_share = share(degraded, served_n);
            add(
                "follow-on and admission",
                format!(
                    "degraded {} of admitted would-be 200s; admission_timeout {timeouts}",
                    pct(degraded_share)
                ),
                match degraded_share {
                    None => Mark::NotEvaluated,
                    Some(d) if d <= bar::DEGRADED && timeouts == 0 => Mark::Pass,
                    Some(_) => Mark::Miss,
                },
            );
        }
        Err(why) => {
            let _ = writeln!(out, "   unavailable: {why}");
            for name in [
                "admitted share",
                "would-be failures",
                "node_vote",
                "membership",
                "follow-on and admission",
            ] {
                add(name, "unavailable (section 4)".into(), Mark::NotEvaluated);
            }
        }
    }
    // With no admitted copy Logs Insights returns no row at all: zero.
    let conversations = rows("conversations")
        .ok()
        .map(|rows| rows.first().map_or(0, |row| count(row, "conversations")));
    match (admitted_total, conversations) {
        (Some(admitted), Some(conversations)) => {
            let _ = writeln!(
                out,
                "   admitted observations span {conversations} conversations"
            );
            add(
                "evidence volume",
                format!("{admitted} admitted across {conversations} conversations"),
                if admitted >= bar::ADMITTED && conversations >= bar::CONVERSATIONS {
                    Mark::Pass
                } else {
                    Mark::Short
                },
            );
        }
        _ => add("evidence volume", "unavailable".into(), Mark::NotEvaluated),
    }

    // ---- Joined with Node.
    let _ = writeln!(out, "\n5. Joined with Node by request id");
    match rows("join") {
        Ok(join) => join_section(&mut out, &mut add, join, edge_lines, node_line),
        Err(why) => {
            let _ = writeln!(out, "   unavailable: {why}");
            for name in [
                "coverage",
                "status agreement",
                "remaining and total",
                "exhaustion and presence",
            ] {
                add(name, "unavailable (section 5)".into(), Mark::NotEvaluated);
            }
        }
    }

    // ---- Latency.
    let _ = writeln!(
        out,
        "\n6. The shadow's latency on admitted copies (append excluded)"
    );
    match rows("latency").map(|rows| rows.first().cloned()) {
        Ok(Some(l)) => {
            let get = |k: &str| num(&l, k);
            let _ = writeln!(
                out,
                "   queue p99 {}; admission p50 {}, p99 {}, largest {}; selection p50 {}, p99 {}; total p50 {}, p99 {}, largest {}; readback p99 {} s",
                ms(get("queue_p99")),
                ms(get("admission_p50")),
                ms(get("admission_p99")),
                ms(get("admission_max")),
                ms(get("selection_p50")),
                ms(get("selection_p99")),
                ms(get("total_p50")),
                ms(get("total_p99")),
                ms(get("total_max")),
                get("readback_p99")
                    .map(|v| format!("{v:.1}"))
                    .unwrap_or_else(|| "n/a".into())
            );
            match (get("admission_p99"), get("total_p99")) {
                (Some(a), Some(t)) => add(
                    "writer latency",
                    format!("admission p99 {}, total p99 {}", ms(Some(a)), ms(Some(t))),
                    if a <= bar::ADMISSION_P99_MS && t <= bar::TOTAL_P99_MS {
                        Mark::Pass
                    } else {
                        Mark::Miss
                    },
                ),
                _ => add(
                    "writer latency",
                    "no admitted copies".into(),
                    Mark::NotEvaluated,
                ),
            }
        }
        Ok(None) => add(
            "writer latency",
            "no admitted copies".into(),
            Mark::NotEvaluated,
        ),
        Err(why) => {
            let _ = writeln!(out, "   unavailable: {why}");
            add("writer latency", why, Mark::NotEvaluated);
        }
    }

    // ---- The stop rule.
    let _ = writeln!(out, "\n7. The stop rule");
    stop_rule(
        &mut out,
        &mut add,
        inputs.results,
        inputs.metrics,
        hold,
        &StopWords {
            by: crate::query::Key::Hour,
            what: "vote",
            route: r.route,
            lines: "node_votes",
        },
        crate::route::stop_span(inputs.window),
    );

    // ---- Criteria and verdict.
    let verdict = verdict_of(&criteria);
    let _ = writeln!(out, "\n8. Criteria for the week");
    for c in &criteria {
        let _ = writeln!(out, "   {:<26} {:<20} {}", c.name, c.mark.text(), c.value);
    }
    let _ = writeln!(out, "\nWhat this cannot compare:");
    for limit in LIMITS {
        let _ = writeln!(out, "   - {limit}");
    }
    let _ = writeln!(out, "\nVERDICT: {}", verdict.text());
    Report {
        text: out,
        criteria,
        verdict,
    }
}

/// The comparison's limits, printed with every report.
const LIMITS: &[&str] = &[
    "The drawn statement, and how the draws are weighted: the shadow's line names no statement (a statement number beside a conversation number and a time picks out a participant's public vote), so neither the picks nor their distribution are compared. Whether a statement was served, the two counts and membership are.",
    "Membership detects only a candidate set that is too small; about half of next votes land on the other box (prev none).",
    "A math generation change between Node's pick and the shadow's is not excluded (the shadow line carries no tick age).",
    "Node's topical picks are excluded from every next-statement comparison.",
    "Latency and the degraded share leave out the append, which observe mode does not run (optimistic); the shadow's reads run beside Node's own pick (its database load is pessimistic).",
    "Not covered: append contention, 202 unknown, 406 duplicates, the star write, notification state, the no-more-comments row, hand-back replay, mixed routing and retries, drain on stop, what clients do with the writer's answers.",
    "Not copied: requests that miss the exact location (case, trailing slash), bodies outside 1 to 9999 bytes; a copy carries no query string.",
    "CORS refusals are reported on their own and are not counted as would-be failures.",
];

fn join_section(
    out: &mut String,
    add: &mut impl FnMut(&'static str, String, Mark),
    join: &[Row],
    edge_lines: Option<u64>,
    node_line: &'static str,
) {
    let all = |key: &str| sum(join, key, |_| true);
    let votes = all("votes");
    let repeated = all("repeated");
    let _ = writeln!(
        out,
        "   shadowed votes (one nginx line in the window) {votes}; ids with a line repeated {repeated}; Node lines with no nginx line {}",
        all("without_edge")
    );
    // The second stage's total of nginx lines must equal the one-stage count
    // (a line exactly on the window's end second may fall on either side),
    // or the account's Logs Insights did not run the two stages as written.
    let joined_lines = all("edge_lines");
    if let Some(edge) = edge_lines
        && joined_lines.abs_diff(edge) > 2 + edge / 1000
    {
        let why = format!(
            "the two-stage total of nginx lines ({joined_lines}) does not match the one-stage count ({edge}); the joined comparison is withheld"
        );
        let _ = writeln!(out, "   {why}");
        for name in [
            "coverage",
            "status agreement",
            "remaining and total",
            "exhaustion and presence",
        ] {
            add(name, "withheld (section 5)".into(), Mark::NotEvaluated);
        }
        return;
    }
    let copied = all("copied");
    let covered = all("covered");
    let host_absent = all("host_absent");
    // A copy nginx answered itself (the shadow's host absent: a shadow that
    // is down) is a copy the shadow should have seen.
    let expected = copied + host_absent;
    let _ = writeln!(
        out,
        "   copied {copied}, answered 204 {}, the shadow's host absent {host_absent}, outside the body bound {}, no copy line {}; observed lines for copied votes {covered} ({} of copied and host-absent)",
        all("answered"),
        all("not_copied"),
        all("no_mirror"),
        pct(share(covered, expected))
    );
    let coverage = share(covered, expected);
    add(
        "coverage",
        format!(
            "{} of copied votes, a down shadow included ({covered} / {expected})",
            pct(coverage)
        ),
        match coverage {
            None => Mark::NotEvaluated,
            Some(c) if c >= bar::COVERAGE => Mark::Pass,
            Some(_) => Mark::Miss,
        },
    );
    let _ = writeln!(
        out,
        "   Node: {} replies from the handler ({}), {} refused before it (access line only); Node's status differs from nginx's on {} replies and {} access lines",
        all("node_replied"),
        node_line,
        all("node_refused_early"),
        all("node_edge_mismatch"),
        all("http_edge_mismatch")
    );
    // Status agreement on admitted copies the shadow would serve (200, 400,
    // 403). Node's status is its handler's (vote_reply) where it replied,
    // else nginx's view (a refusal before the handler). Two classes are not
    // compared: the participant went away (nginx 499; Node's handler may
    // still have finished), and a 5xx nginx answered with no reply from
    // Node's handler (Node down or cut off). A Node 500 after the vote was
    // stored (the shadow's 200 with Node's row read back) is its own class.
    let node_status = |row: &Row| {
        let handler = status(row, "node_st");
        if handler == "none" {
            status(row, "edge_st")
        } else {
            handler
        }
    };
    let gone = |row: &Row| status(row, "edge_st") == "499";
    let nginx_only = |row: &Row| {
        !gone(row) && status(row, "node_st") == "none" && status(row, "edge_st").starts_with('5')
    };
    let serving = |row: &Row| matches!(status(row, "rust_st").as_str(), "200" | "400" | "403");
    let compared_row = |row: &Row| serving(row) && !gone(row) && !nginx_only(row);
    let went_away = sum(join, "admitted_n", |row| serving(row) && gone(row));
    let nginx_answered = sum(join, "admitted_n", |row| serving(row) && nginx_only(row));
    let compared = sum(join, "admitted_n", compared_row);
    let agree = sum(join, "admitted_n", |row| {
        compared_row(row) && node_status(row) == status(row, "rust_st")
    });
    let stored_then_500 = |row: &Row| node_status(row) == "500" && status(row, "rust_st") == "200";
    let after_store = sum(join, "same", |row| {
        compared_row(row) && stored_then_500(row)
    });
    let disagree = compared.saturating_sub(agree + after_store);
    let _ = writeln!(
        out,
        "   status on admitted would-serve copies: agree {agree} of {compared}; Node 500 after storing the vote {after_store}; disagree {disagree}; not compared: the participant went away (499) {went_away}, nginx answered 5xx without Node's handler {nginx_answered}"
    );
    let mut pairs: Vec<(String, String, u64)> = join
        .iter()
        .filter(|row| compared_row(row) && node_status(row) != status(row, "rust_st"))
        .map(|row| {
            let n = count(row, "admitted_n").saturating_sub(if stored_then_500(row) {
                count(row, "same")
            } else {
                0
            });
            (node_status(row), status(row, "rust_st"), n)
        })
        .filter(|p| p.2 > 0)
        .collect();
    pairs.sort();
    for (node, rust, n) in &pairs {
        let _ = writeln!(out, "     Node {node:<6} shadow {rust:<6} {n}");
    }
    add(
        "status agreement",
        format!(
            "{} ({agree} / {compared}); Node 500 after store {after_store}; disagree {disagree}; went away {went_away}, nginx-only 5xx {nginx_answered} (not compared)",
            pct(share(agree, compared))
        ),
        if compared == 0 {
            Mark::NotEvaluated
        } else if disagree == 0 {
            Mark::Pass
        } else {
            Mark::Stop
        },
    );
    // The next statement, where Node's handler and the shadow both answered
    // 200 (whether or not the participant stayed for the reply).
    let both_200 = |row: &Row| status(row, "node_st") == "200" && status(row, "rust_st") == "200";
    let s = |key: &str| sum(join, key, both_200);
    let topical = s("node_topical");
    let both_next = s("both_next");
    let both_none = s("both_none");
    let rust_none = s("rust_none_only");
    let node_none = s("node_none_only");
    let comparable = both_next + both_none + rust_none + node_none;
    let _ = writeln!(
        out,
        "   next statement where both answered 200: both a statement {both_next}, both none left {both_none}, only the shadow none {rust_none}, only Node none {node_none}; Node topical picks excluded {topical}; the shadow degraded {}",
        s("follow_degraded")
    );
    let presence = share(both_next + both_none, comparable);
    add(
        "exhaustion and presence",
        format!("{} of {comparable}", pct(presence)),
        match presence {
            None => Mark::NotEvaluated,
            Some(p) if p >= bar::EXHAUSTION => Mark::Pass,
            Some(_) => Mark::Miss,
        },
    );
    let (remaining, total) = (s("remaining_equal"), s("total_equal"));
    let _ = writeln!(
        out,
        "   remaining equal {remaining} of {both_next} ({}); total equal {total} of {both_next} ({})",
        pct(share(remaining, both_next)),
        pct(share(total, both_next))
    );
    let (rs, ts) = (share(remaining, both_next), share(total, both_next));
    add(
        "remaining and total",
        format!("remaining {}, total {} of {both_next}", pct(rs), pct(ts)),
        match (rs, ts) {
            (Some(a), Some(b)) if a >= bar::COUNTS && b >= bar::COUNTS => Mark::Pass,
            (Some(_), Some(_)) => Mark::Miss,
            _ => Mark::NotEvaluated,
        },
    );
}

/// The longest run of consecutive breached spans, `step` seconds apart.
fn longest_run(hours: &[(i64, bool)], step: i64) -> u32 {
    let (mut best, mut run, mut last) = (0, 0, None);
    for &(t, breach) in hours {
        run = match (breach, last) {
            (false, _) => 0,
            (true, Some(prev)) if t - prev == step && run > 0 => run + 1,
            (true, _) => 1,
        };
        last = Some(t);
        best = best.max(run);
    }
    best
}

/// What the stop rule's two request rules are called for a route.
pub(crate) struct StopWords {
    /// The span Node's latency is compared over: an hour, or for a route
    /// too quiet for an hour to hold 20 requests, a day.
    pub by: crate::query::Key,
    /// "vote" or "comment".
    pub what: &'static str,
    /// The route, as nginx writes it.
    pub route: &'static str,
    /// The name of the query of Node's access lines for the route by hour.
    pub lines: &'static str,
}

pub(crate) fn stop_rule(
    out: &mut String,
    add: &mut impl FnMut(&'static str, String, Mark),
    results: &Results,
    metrics: &Metrics,
    hold: Option<(f64, f64)>,
    words: &StopWords,
    window: Window,
) {
    let StopWords {
        by,
        what,
        route,
        lines,
    } = *words;
    let (step, unit, column) = match by {
        crate::query::Key::Day => (86_400, "day", "day"),
        _ => (3600, "hour", "hour"),
    };
    let mut fired: Vec<String> = vec![];
    let mut missing: Vec<String> = vec![];
    // Read, with too few datapoints for the window to say the rule held.
    let mut thin: Vec<String> = vec![];
    let series = |name: &str| -> Option<&[(i64, f64)]> {
        match metrics.get(name) {
            Some(Ok(points)) => Some(points.as_slice()),
            _ => None,
        }
    };
    // 1. Database CPU, two consecutive 5-minute averages above 60 %.
    let span_s = window.to_s - window.from_s;
    match series("db_cpu") {
        // No datapoint, or too few for the window, is a metric not read:
        // never "no", which would pass a rule nothing was read for.
        Some(cpu)
            if too_few(cpu.len(), span_s / 300)
                && !cpu.windows(2).any(|w| {
                    w[1].0 - w[0].0 == 300 && w[0].1 > bar::DB_CPU && w[1].1 > bar::DB_CPU
                }) =>
        {
            let _ = writeln!(
                out,
                "   1. database CPU: {} of the window's {} five-minute averages were read; the rule is not evaluated",
                cpu.len(),
                span_s / 300
            );
            thin.push("database CPU".into());
        }
        Some(cpu) => {
            let peak = cpu.iter().map(|p| p.1).fold(0.0, f64::max);
            let pair = cpu
                .windows(2)
                .any(|w| w[1].0 - w[0].0 == 300 && w[0].1 > bar::DB_CPU && w[1].1 > bar::DB_CPU);
            let _ = writeln!(
                out,
                "   1. database CPU: largest 5-minute average {peak:.1} %; two consecutive above {} %: {}",
                bar::DB_CPU,
                if pair { "yes" } else { "no" }
            );
            if pair {
                fired.push("database CPU".into());
            }
        }
        None => missing.push("database CPU".into()),
    }
    // 2. The copy's hold.
    match hold {
        Some((p99, max)) => {
            let breach = p99 > bar::STOP_MIRROR_P99_MS || max > bar::STOP_MIRROR_MAX_MS;
            let _ = writeln!(
                out,
                "   2. the copy's hold: largest hourly p99 {}, largest {}: {}",
                ms(Some(p99)),
                ms(Some(max)),
                if breach {
                    "above the rule"
                } else {
                    "within it"
                }
            );
            if breach {
                fired.push("the copy's hold".into());
            }
        }
        None => {
            let _ = writeln!(out, "   2. the copy's hold: no copies");
        }
    }
    // 3. The load balancer's p99 against the same hour a week earlier.
    const WEEK: i64 = 7 * 86_400;
    // 3. The load balancer's p99, sustained: three hours in a row each more
    // than 20 % and more than 100 ms above the same hour a week earlier.
    match (series("lb_p99"), series("lb_p99_previous")) {
        (Some(now), Some(before)) => {
            let hours: Vec<(i64, bool)> = now
                .iter()
                .filter_map(|(t, v)| {
                    before
                        .iter()
                        .find(|(b, _)| *b == t - WEEK)
                        .map(|(_, w)| (*t, *v > w * bar::LB_RATIO && v - w > bar::LB_FLOOR_S))
                })
                .collect();
            let run = longest_run(&hours, 3600);
            if too_few(hours.len(), span_s / 3600) && run < bar::SUSTAINED_HOURS {
                let _ = writeln!(
                    out,
                    "   3. load balancer p99, all routes: {} of the window's {} hours have a p99 in both weeks; the rule is not evaluated",
                    hours.len(),
                    span_s / 3600
                );
                thin.push("load balancer p99".into());
            } else {
                let _ = writeln!(
                    out,
                    "   3. load balancer p99, all routes: {} of {} hours more than 20 % and 100 ms above the same hour a week earlier, longest run {run}; stops at {} in a row",
                    hours.iter().filter(|h| h.1).count(),
                    hours.len(),
                    bar::SUSTAINED_HOURS
                );
                if run >= bar::SUSTAINED_HOURS {
                    fired.push("load balancer p99, sustained".into());
                }
            }
        }
        _ => missing.push("load balancer p99".into()),
    }
    // 4 and 5. Votes, from Node's access lines for every POST /api/v3/votes
    // (not only shadowed ones), against the same span a week earlier.
    // (hour, votes, 5xx, p99 ms) per hour of Node's vote lines.
    type Hour = (i64, u64, u64, Option<f64>);
    let hourly = |name: &str| -> Option<Vec<Hour>> {
        let Some(Ok(rows)) = results.get(name) else {
            return None;
        };
        let mut out: Vec<_> = rows
            .iter()
            .filter_map(|row| {
                let t = crate::time::parse(text(row, column)).ok()?;
                Some((t, count(row, "n"), count(row, "e5"), num(row, "p99_ms")))
            })
            .collect();
        out.sort_by_key(|h| h.0);
        Some(out)
    };
    // A query that returned no line of Node's at all, in the window or in
    // the week before it, read nothing: rules 4 and 5 are then not read,
    // never "within it" on no data.
    let any = |hours: &Option<Vec<Hour>>| {
        hours
            .as_ref()
            .is_some_and(|hours| hours.iter().any(|hour| hour.1 > 0))
    };
    match (hourly(lines), hourly(&format!("{lines}_previous"))) {
        (now, before) if !any(&now) || !any(&before) => {
            if now.is_some() && before.is_some() {
                let _ = writeln!(
                    out,
                    "   4 and 5. {what} errors and {what} p99: Node's access lines for {route} were found in {}; the rules are not evaluated",
                    match (any(&now), any(&before)) {
                        (true, false) => "the window and not in the week before it",
                        (false, true) => "the week before the window and not in it",
                        _ => "neither the window nor the week before it",
                    }
                );
                thin.push(format!("Node's {what} lines"));
            } else {
                missing.push(format!("Node's {what} lines"));
            }
        }
        (Some(now), Some(before)) => {
            // 4. Vote errors over the window: at least 10 Node 5xx on votes,
            // a share more than three times the earlier week's and more than
            // half a percentage point above it.
            let (n, e5) = now.iter().fold((0, 0), |a, h| (a.0 + h.1, a.1 + h.2));
            let (n0, e50) = before.iter().fold((0, 0), |a, h| (a.0 + h.1, a.1 + h.2));
            let rate = share(e5, n).unwrap_or(0.0);
            let rate0 = share(e50, n0).unwrap_or(0.0);
            let errors = e5 >= bar::VOTE_5XX_MIN
                && rate > rate0 * bar::VOTE_5XX_RATIO
                && rate - rate0 > bar::VOTE_5XX_POINTS;
            let _ = writeln!(
                out,
                "   4. {what} errors (Node's 5xx on {route}): {e5} of {n} ({}) against {e50} of {n0} ({}) a week earlier: {}",
                pct(Some(rate)),
                pct(Some(rate0)),
                if errors {
                    "above the rule"
                } else {
                    "within it"
                }
            );
            if errors {
                fired.push(format!("{what} errors"));
            }
            // 5. Vote latency, sustained: three hours in a row, each with at
            // least 20 votes in both weeks, whose p99 is more than 20 % and
            // more than 50 ms above the same hour a week earlier.
            let hours: Vec<(i64, bool)> = now
                .iter()
                .filter_map(|&(t, n, _, p99)| {
                    let &(_, n0, _, p0) = before.iter().find(|b| b.0 == t - WEEK)?;
                    let (p99, p0) = (p99?, p0?);
                    (n >= bar::VOTE_MIN_PER_HOUR && n0 >= bar::VOTE_MIN_PER_HOUR).then_some((
                        t,
                        p99 > p0 * bar::VOTE_P99_RATIO && p99 - p0 > bar::VOTE_P99_FLOOR_MS,
                    ))
                })
                .collect();
            let run = longest_run(&hours, step);
            if hours.is_empty() {
                // Not one span holds enough requests in both weeks: the rule
                // compared nothing, and "0 of 0" is not a rule that held.
                let _ = writeln!(
                    out,
                    "   5. {what} p99 (Node's duration_ms): no {unit} holds {} requests in both weeks; the rule is not evaluated",
                    bar::VOTE_MIN_PER_HOUR
                );
                thin.push(format!("{what} p99"));
            } else {
                let _ = writeln!(
                    out,
                    "   5. {what} p99 (Node's duration_ms): {} of {} comparable {unit}s more than 20 % and 50 ms above a week earlier, longest run {run}; stops at {} in a row",
                    hours.iter().filter(|h| h.1).count(),
                    hours.len(),
                    bar::SUSTAINED_HOURS
                );
            }
            if run >= bar::SUSTAINED_HOURS {
                fired.push(format!("{what} p99, sustained"));
            }
        }
        _ => missing.push(format!("Node's {what} lines")),
    }
    // Target 5xx over all routes: context only. They are non-zero on nearly
    // every day and swing by two orders of magnitude (15 to 1,999 a day),
    // deploys included, so they cannot attribute a stop to the shadow.
    if let (Some(now), Some(before)) = (series("target_5xx"), series("target_5xx_previous")) {
        let _ = writeln!(
            out,
            "   target 5xx, all routes (context, not a stop): {} in the window, {} the same span a week earlier",
            now.iter().map(|p| p.1).sum::<f64>(),
            before.iter().map(|p| p.1).sum::<f64>()
        );
    }
    for name in &missing {
        let _ = writeln!(out, "   {name}: no metric read");
    }
    missing.extend(thin);
    add(
        "stop rule",
        if fired.is_empty() && missing.is_empty() {
            "never fired".into()
        } else if fired.is_empty() {
            format!("not read: {}", missing.join(", "))
        } else {
            format!("fired: {}", fired.join(", "))
        },
        if !fired.is_empty() {
            Mark::Stop
        } else if !missing.is_empty() {
            Mark::NotEvaluated
        } else {
            Mark::Pass
        },
    );
}
