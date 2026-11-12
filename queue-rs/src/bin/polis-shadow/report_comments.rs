//! The comment route's report: what the shadow would have done with each
//! copied comment, what it read in the database, and how that sits beside
//! Node's answer to the same request.
//!
//! Three words carry the judgement. An **agreement** needs Node's status in
//! hand and nothing left open: Node answered 200, the handler would store the
//! comment, and Node's stored row is this request's own with the text,
//! author, columns, language and author's vote the handler would store; or
//! the handler would answer 409, 403, 401 or 400 itself and Node answered the
//! same. A **disagreement** is definite and is a stop until it is explained.
//! **Not known** is neither, however many there are.
//!
//! Everything printed is a count, a share, a duration, a status or a word
//! from a closed set compiled into this tool. A word a line carries that is
//! not in its set is counted as unrecognised and never printed.
use crate::aws::Row;
use crate::report::{
    Criterion, Inputs, Mark, Report, StopWords, copy_section, count, edge_section, ms, num, pct,
    section_rows, share, status, stop_rule, sum, text, verdict_of,
};
use crate::route_comments::*;
use std::collections::BTreeMap;
use std::fmt::Write as _;

/// The counts below which a class of evidence is too small to mean anything.
/// Each is a count of judged observations, never a span of days. Where a
/// count is the size of a sample with no disagreement in it, the disagreement
/// rate is under three divided by the count, with 95 % confidence.
pub mod need {
    /// Observed copies, for the admitted share and the reasons: a share of
    /// 1,000 is known to about three percentage points.
    pub const OBSERVED: u64 = 1_000;
    /// Comments the handler would store, judged against Node: none
    /// disagreeing in 300 puts the rate under 1 %. About one comment in six
    /// is of this kind.
    pub const WOULD_SERVE: u64 = 300;
    /// Stored comments read back (the ones the handler would store and the
    /// ones in conversations with strict moderation): none differing in 600
    /// puts the rate under 0.5 %. About two comments in three are read back.
    pub const STORED: u64 = 600;
    /// Authors' votes compared with the vote the copy carried: none
    /// differing in 300 puts the rate under 1 %.
    pub const VOTES: u64 = 300;
    /// Would-be duplicates judged against Node. Duplicates are rare (about
    /// one comment in a hundred at most), so this is small: 20 says the
    /// lookup was met by real traffic, and bounds nothing tightly.
    pub const DUPLICATES: u64 = 20;
}

mod bar {
    pub const COVERAGE: f64 = 99.5;
    pub const ADMISSION_P99_MS: f64 = 100.0;
    /// The most of a class that may be "not known" beside a pass, in percent
    /// of the class's judged and not-known requests. What is not known is
    /// never an agreement or a disagreement, but a pass over the judged part
    /// says nothing of an unjudged part this large (read-backs that failed
    /// or never ran are not spread evenly over comments).
    pub const NOT_KNOWN: f64 = 5.0;
}

/// A word from a closed set, or the mark of one that is not.
fn known<'a>(word: &'a str, set: &[&str]) -> &'a str {
    if set.contains(&word) {
        word
    } else {
        "(unrecognised)"
    }
}

/// A status as a three-digit number, `none`, or `other`: never a number of
/// any other size.
fn code(row: &Row, key: &str) -> String {
    status(row, key)
}

fn server_error(code: &str) -> bool {
    code.starts_with('5')
}

/// A boolean as Logs Insights returns it, in either of its two forms.
fn flag(row: &Row, key: &str) -> Option<bool> {
    match text(row, key) {
        "true" | "1" => Some(true),
        "false" | "0" => Some(false),
        _ => None,
    }
}

/// Counts of a readback or facts field's words, in the set's order, with the
/// lines that carry no word or an unrecognised one.
fn by_word(rows: &[Row], key: &str, set: &[&str]) -> (Vec<(String, u64)>, u64, u64) {
    let counts: Vec<(String, u64)> = set
        .iter()
        .map(|word| {
            (
                (*word).to_owned(),
                sum(rows, "n", |row| text(row, key) == *word),
            )
        })
        .collect();
    let none = sum(rows, "n", |row| text(row, key).is_empty());
    let other = sum(rows, "n", |row| {
        let word = text(row, key);
        !word.is_empty() && !set.contains(&word)
    });
    (counts, none, other)
}

fn words_line(counts: &(Vec<(String, u64)>, u64, u64)) -> String {
    let mut parts: Vec<String> = counts
        .0
        .iter()
        .map(|(word, n)| format!("{word} {n}"))
        .collect();
    if counts.2 > 0 {
        parts.push(format!("(unrecognised) {}", counts.2));
    }
    parts.join(", ")
}

/// How a minimum count stands.
fn against(have: u64, need: u64) -> String {
    if have >= need {
        format!("{have} (minimum {need})")
    } else {
        format!("{have} of the {need} needed")
    }
}

#[derive(Default)]
struct Joined {
    // Comments the handler would store.
    serve: u64,
    serve_agree: u64,
    serve_stored_otherwise: u64,
    serve_contradicted: u64,
    serve_not_read: u64,
    serve_repeat: u64,
    serve_node_failed: u64,
    serve_node_failed_stored: u64,
    serve_no_status: u64,
    // Requests the handler would answer itself.
    answer: u64,
    answer_agree: u64,
    duplicate_agree: u64,
    closed_agree: u64,
    answer_contradicted: u64,
    duplicate_contradicted: u64,
    answer_late: u64,
    answer_repeat: u64,
    answer_node_failed: u64,
    answer_no_status: u64,
    // Stored comments read back, where Node answered 200.
    read: u64,
    read_clean: u64,
    read_diff: u64,
    kinds: BTreeMap<&'static str, u64>,
    vote_same: u64,
    vote_different: u64,
    vote_absent: u64,
    vote_not_compared: u64,
    // Node answered 5xx and the comment is stored.
    stored_then_failed: u64,
    stored_then_failed_no_vote: u64,
    /// (Node's status, the would-be status, requests) contradicted.
    pairs: Vec<(String, String, u64)>,
}

fn classify(join: &[Row]) -> Joined {
    let mut j = Joined::default();
    for row in join {
        let (node, would) = (code(row, "http_st"), code(row, "rust_st"));
        let n = |key: &str| count(row, key);
        let mut contradicted = 0;
        // ---- The handler would store the comment (a would-be 200).
        let serve = n("serve");
        j.serve += serve;
        if serve > 0 {
            match node.as_str() {
                "200" => {
                    let (clean, diff) = (n("serve_clean"), n("serve_diff"));
                    j.serve_agree += clean;
                    j.serve_stored_otherwise += diff;
                    j.serve_not_read += serve.saturating_sub(clean + diff);
                }
                // The same text twice from one person within five seconds:
                // the shadow reads the first request's row as this request's
                // own, at admission or (when the copy's admission ran before
                // Node stored the first) at the read-back.
                "409" => {
                    let repeat = n("serve_any_own").min(serve);
                    j.serve_repeat += repeat;
                    contradicted += serve - repeat;
                    j.serve_contradicted += serve - repeat;
                }
                "none" | "other" => j.serve_no_status += serve,
                code if server_error(code) => {
                    j.serve_node_failed += serve;
                    j.serve_node_failed_stored += n("serve_own").min(serve);
                }
                _ => {
                    contradicted += serve;
                    j.serve_contradicted += serve;
                }
            }
        }
        // ---- The handler would answer without writing.
        let answer = n("answer");
        j.answer += answer;
        if answer > 0 {
            let duplicate = would == "409";
            if node == "none" || node == "other" {
                j.answer_no_status += answer;
            } else if node == would {
                j.answer_agree += answer;
                match would.as_str() {
                    "409" => j.duplicate_agree += answer,
                    "403" => j.closed_agree += answer,
                    _ => {}
                }
            } else if server_error(&node) {
                j.answer_node_failed += answer;
            } else {
                // Not known: a would-be duplicate beside Node's 200 whose
                // observation started late (Node's own row, taken for
                // another's), and Node's 409 for a text the shadow read as
                // this request's own row.
                let not_known = if node == "200" && duplicate {
                    let late = n("answer_late").min(answer);
                    j.answer_late += late;
                    late
                } else if node == "409" {
                    let repeat = n("answer_tr_own").min(answer);
                    j.answer_repeat += repeat;
                    repeat
                } else {
                    0
                };
                contradicted += answer - not_known;
                j.answer_contradicted += answer - not_known;
                if duplicate {
                    j.duplicate_contradicted += answer - not_known;
                }
            }
        }
        if contradicted > 0 {
            j.pairs.push((node.clone(), would.clone(), contradicted));
        }
        // ---- What Node stored, for the copies that are read back.
        if node == "200" {
            let (read, clean, diff) = (n("read"), n("read_clean"), n("read_diff"));
            j.read += read;
            j.read_clean += clean;
            j.read_diff += diff;
            for (kind, key) in [
                ("no row with the text", "read_absent"),
                ("a row that is not this request's", "read_other"),
                ("the text", "read_x_diff"),
                ("the author", "read_a_diff"),
                ("a column", "read_w_diff"),
                ("a language set", "read_l_set"),
                ("the author's vote", "read_v_diff"),
                ("no author's vote", "read_v_absent"),
            ] {
                *j.kinds.entry(kind).or_default() += n(key);
            }
            j.vote_same += n("read_v_same");
            j.vote_different += n("read_v_diff");
            j.vote_absent += n("read_v_absent");
            j.vote_not_compared += n("read_v_unk");
        } else if server_error(&node) {
            j.stored_then_failed += n("read_own");
            j.stored_then_failed_no_vote += n("read_v_absent");
        }
    }
    j.pairs.sort();
    j
}

pub fn build(inputs: &Inputs) -> Report {
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
                ("shadow_edge", "nginx, each shadowed comment (shadow_edge)"),
                ("shadow_mirror", "nginx, each copy (shadow_mirror)"),
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

    // ---- The copy, and Node as nginx saw it.
    let hold = copy_section(&mut out, &mut add, rows("mirror"), rows("mirror_hours"));
    edge_section(&mut out, "comments", rows("edge"));

    // Words on the lines that are in none of this tool's sets. A line that
    // carries one is counted in no class, so a word the shadow learned after
    // this tool was built could hide what it says: no verdict but "not
    // evaluated" while there is one.
    let mut strange: u64 = 0;

    // ---- The shadow's observations.
    let _ = writeln!(out, "\n4. The shadow's observations");
    match rows("observations") {
        Ok(obs) => {
            let of = |outcome: &str| sum(obs, "n", |row| text(row, "outcome") == outcome);
            for outcome in OUTCOMES {
                let _ = writeln!(out, "   {outcome:<20} {}", of(outcome));
            }
            let unrecognised = sum(obs, "n", |row| !OUTCOMES.contains(&text(row, "outcome")));
            if unrecognised > 0 {
                let _ = writeln!(out, "   {:<20} {unrecognised}", "(unrecognised)");
            }
            strange += unrecognised
                + sum(obs, "n", |row| {
                    let reason = text(row, "reason");
                    !reason.is_empty() && !REASONS.contains(&reason)
                });
            let observed = sum(obs, "n", |row| OBSERVED.contains(&text(row, "outcome")));
            let admitted = sum(obs, "n", |row| {
                OBSERVED.contains(&text(row, "outcome")) && text(row, "admitted") == "1"
            });
            let strict = sum(obs, "n", |row| {
                text(row, "admitted") == "1" && flag(row, "strict") == Some(true)
            });
            let _ = writeln!(
                out,
                "   admitted {admitted} of {observed} observed ({}); in conversations with strict moderation {strict} of the admitted",
                pct(share(admitted, observed))
            );
            add(
                "observed copies",
                against(observed, need::OBSERVED),
                if observed >= need::OBSERVED {
                    Mark::Pass
                } else {
                    Mark::Short
                },
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
            let mut answers: BTreeMap<(String, String), u64> = BTreeMap::new();
            for row in obs
                .iter()
                .filter(|row| text(row, "outcome") == "would_answer")
            {
                *answers
                    .entry((
                        code(row, "status"),
                        known(text(row, "reason"), &REASONS).to_owned(),
                    ))
                    .or_default() += count(row, "n");
            }
            let _ = writeln!(out, "   would answer without writing:");
            for ((status, reason), n) in &answers {
                let _ = writeln!(out, "     {status:<6} {reason:<26} {n}");
            }
            for (outcome, title) in [
                ("would_hand_back", "hand-back reasons:"),
                ("unknown", "not known, by reason:"),
                ("shed", "shed, by reason:"),
                ("not_observed", "not observed, by reason:"),
            ] {
                let mut reasons: BTreeMap<String, u64> = BTreeMap::new();
                for row in obs.iter().filter(|row| text(row, "outcome") == outcome) {
                    let reason = match text(row, "reason") {
                        "" => "(none given)",
                        word => known(word, &REASONS),
                    };
                    *reasons.entry(reason.to_owned()).or_default() += count(row, "n");
                }
                if reasons.is_empty() {
                    continue;
                }
                let mut reasons: Vec<_> = reasons.into_iter().collect();
                reasons.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
                let _ = writeln!(out, "   {title}");
                for (reason, n) in &reasons {
                    let _ = writeln!(out, "     {reason:<26} {n}");
                }
            }
            let fails = of("would_fail");
            let would_be_5xx = sum(obs, "n", |row| {
                OBSERVED.contains(&text(row, "outcome"))
                    && num(row, "status").is_some_and(|s| s >= 500.0 && s != 502.0)
            });
            let _ = writeln!(
                out,
                "   would_fail {fails}; would-be 5xx other than a hand-back's 502: {would_be_5xx}"
            );
            add(
                "would-be failures",
                format!("would_fail {fails}, would-be 5xx {would_be_5xx}"),
                if fails == 0 && would_be_5xx == 0 {
                    Mark::Pass
                } else {
                    Mark::Stop
                },
            );
        }
        Err(why) => {
            let _ = writeln!(out, "   unavailable: {why}");
            for name in ["observed copies", "admitted share", "would-be failures"] {
                add(name, "unavailable (section 4)".into(), Mark::NotEvaluated);
            }
        }
    }
    // How many conversations the admitted copies are in: a count, never a
    // conversation's number. With no admitted copy Logs Insights returns no
    // row at all: zero of each. A line written before the observer printed
    // the number names no conversation, and is said to.
    match rows("conversations") {
        Ok(spread) => {
            let (admitted, named, conversations) = spread.first().map_or((0, 0, 0), |row| {
                (
                    count(row, "n"),
                    count(row, "named"),
                    count(row, "conversations"),
                )
            });
            let unnamed = admitted.saturating_sub(named);
            let _ = writeln!(
                out,
                "   admitted copies span {conversations} conversations{}",
                if unnamed > 0 {
                    format!(
                        "; {unnamed} of the {admitted} admitted name none (their lines carry no conversation number) and are in none of that count"
                    )
                } else {
                    String::new()
                }
            );
            add(
                "conversations",
                format!(
                    "{named} admitted copies across {conversations} conversations{}",
                    if unnamed > 0 {
                        format!("; {unnamed} more admitted name none")
                    } else {
                        String::new()
                    }
                ),
                if admitted > 0 {
                    Mark::Info
                } else {
                    Mark::NotEvaluated
                },
            );
        }
        Err(why) => {
            let _ = writeln!(out, "   conversations unavailable: {why}");
            add(
                "conversations",
                "unavailable (section 4)".into(),
                Mark::NotEvaluated,
            );
        }
    }
    match rows("facts") {
        Ok(facts) => {
            strange += by_word(facts, "body_class", &BODY_CLASS).2;
            let with =
                |key: &str, value: bool| sum(facts, "n", |row| flag(row, key) == Some(value));
            let _ = writeln!(
                out,
                "   copies carrying a vote {}, carrying none {}; carrying a seed flag {}; body size: {}",
                with("vote_present", true),
                with("vote_present", false),
                with("seed_present", true),
                words_line(&by_word(facts, "body_class", &BODY_CLASS))
            );
        }
        Err(why) => {
            let _ = writeln!(out, "   what the copies carry unavailable: {why}");
        }
    }

    // ---- What the shadow read in the database.
    let _ = writeln!(
        out,
        "\n5. What the shadow read in the database (admitted copies)"
    );
    // A stored vote or a stored text that differs on any line at all,
    // whether or not the line pairs with a Node line.
    let mut differs_anywhere: Option<(u64, u64)> = None;
    match rows("readback") {
        Ok(read) => {
            let sets: [(&str, &[&str]); 8] = [
                ("text_row", &TEXT_ROW),
                ("node_comment", &NODE_COMMENT),
                ("node_txt", &NODE_TXT),
                ("node_txt_difference", &NODE_TXT_DIFFERENCE),
                ("node_author", &NODE_AUTHOR),
                ("node_row", &NODE_ROW),
                ("node_lang", &NODE_LANG),
                ("node_vote", &NODE_VOTE),
            ];
            for (key, set) in sets {
                strange += by_word(read, key, set).2;
            }
            let _ = writeln!(
                out,
                "   a row with the copy's text at admission (text_row): {}",
                words_line(&by_word(read, "text_row", &TEXT_ROW))
            );
            let _ = writeln!(
                out,
                "   Node's stored comment, read back (node_comment): {}",
                words_line(&by_word(read, "node_comment", &NODE_COMMENT))
            );
            let own = |row: &Row| text(row, "node_comment") == "own";
            let own_rows: Vec<Row> = read.iter().filter(|row| own(row)).cloned().collect();
            let _ = writeln!(
                out,
                "   of Node's own rows ({}): text {}; author {}; columns {}; language {}",
                sum(&own_rows, "n", |_| true),
                words_line(&by_word(&own_rows, "node_txt", &NODE_TXT)),
                words_line(&by_word(&own_rows, "node_author", &NODE_AUTHOR)),
                words_line(&by_word(&own_rows, "node_row", &NODE_ROW)),
                words_line(&by_word(&own_rows, "node_lang", &NODE_LANG))
            );
            let differing: Vec<Row> = read
                .iter()
                .filter(|row| text(row, "node_txt") == "different")
                .cloned()
                .collect();
            let text_differs = sum(&differing, "n", |_| true);
            if text_differs > 0 {
                let _ = writeln!(
                    out,
                    "   stored texts that differ, by kind: {}",
                    words_line(&by_word(
                        &differing,
                        "node_txt_difference",
                        &NODE_TXT_DIFFERENCE
                    ))
                );
            }
            let _ = writeln!(
                out,
                "   the author's vote (node_vote): {}",
                words_line(&by_word(read, "node_vote", &NODE_VOTE))
            );
            differs_anywhere = Some((
                sum(read, "n", |row| text(row, "node_vote") == "different"),
                text_differs,
            ));
        }
        Err(why) => {
            let _ = writeln!(out, "   unavailable: {why}");
        }
    }

    add(
        "words on the lines",
        if strange == 0 {
            "every outcome, reason and class is one this tool knows".into()
        } else {
            format!(
                "{strange} words this tool does not know; a line that carries one is counted in no class, so nothing is concluded until the tool knows the word"
            )
        },
        if strange == 0 {
            Mark::Pass
        } else {
            Mark::NotEvaluated
        },
    );

    // ---- Paired with Node.
    let _ = writeln!(out, "\n6. Paired with Node by request id");
    let judged = [
        "coverage",
        "pairing",
        "would serve",
        "would answer",
        "stored comment",
        "author's vote",
    ];
    match rows("join") {
        Ok(join) => {
            let all = |key: &str| sum(join, key, |_| true);
            let _ = writeln!(
                out,
                "   shadowed comments (one nginx line in the window) {}; ids with a line repeated {}; ids with no nginx line {}",
                all("comments"),
                all("repeated"),
                all("without_edge")
            );
            // The second stage's total of nginx lines must equal the
            // one-stage count, or the two stages did not run as written.
            let joined_lines = all("edge_lines");
            let consistent = match edge_lines {
                Some(edge) => joined_lines.abs_diff(edge) <= 2 + edge / 1000,
                None => false,
            };
            if !consistent {
                let why = match edge_lines {
                    Some(edge) => format!(
                        "the two-stage total of nginx lines ({joined_lines}) does not match the one-stage count ({edge}); the paired comparison is withheld"
                    ),
                    None => "the one-stage count of nginx lines is unavailable, so the join cannot be checked; the paired comparison is withheld".to_owned(),
                };
                let _ = writeln!(out, "   {why}");
                for name in judged {
                    add(name, "withheld (section 6)".into(), Mark::NotEvaluated);
                }
            } else {
                paired_section(&mut out, &mut add, join, differs_anywhere);
            }
        }
        Err(why) => {
            let _ = writeln!(out, "   unavailable: {why}");
            for name in judged {
                add(name, "unavailable (section 6)".into(), Mark::NotEvaluated);
            }
        }
    }

    // ---- Latency.
    let _ = writeln!(
        out,
        "\n7. The shadow's latency on admitted copies (the write is not modelled)"
    );
    let timeouts = rows("observations").ok().map(|obs| {
        (
            sum(obs, "n", |row| text(row, "reason") == "admission_timeout"),
            sum(obs, "n", |row| {
                text(row, "reason") == "admission_unavailable"
            }),
        )
    });
    match (rows("latency").map(|rows| rows.first().cloned()), timeouts) {
        (Ok(Some(l)), Some((timeout, unavailable))) => {
            let get = |k: &str| num(&l, k);
            let _ = writeln!(
                out,
                "   queue p99 {}, largest {}; admission p50 {}, p99 {}, largest {}; total p50 {}, p99 {}, largest {}; read-back p99 {} s",
                ms(get("queue_p99")),
                ms(get("queue_max")),
                ms(get("admission_p50")),
                ms(get("admission_p99")),
                ms(get("admission_max")),
                ms(get("total_p50")),
                ms(get("total_p99")),
                ms(get("total_max")),
                get("readback_p99")
                    .map(|v| format!("{v:.1}"))
                    .unwrap_or_else(|| "n/a".into())
            );
            let _ = writeln!(
                out,
                "   admission_timeout {timeout}, admission_unavailable {unavailable}"
            );
            match get("admission_p99") {
                Some(p99) => add(
                    "admission",
                    format!(
                        "p99 {}; admission_timeout {timeout}, admission_unavailable {unavailable}",
                        ms(Some(p99))
                    ),
                    if p99 <= bar::ADMISSION_P99_MS && timeout == 0 {
                        Mark::Pass
                    } else {
                        Mark::Miss
                    },
                ),
                None => add("admission", "no admitted copies".into(), Mark::NotEvaluated),
            }
        }
        (Ok(None), _) => add("admission", "no admitted copies".into(), Mark::NotEvaluated),
        (Err(why), _) => {
            let _ = writeln!(out, "   unavailable: {why}");
            add("admission", why, Mark::NotEvaluated);
        }
        (Ok(Some(_)), None) => add(
            "admission",
            "unavailable (section 4)".into(),
            Mark::NotEvaluated,
        ),
    }

    // ---- The stop rule.
    let _ = writeln!(out, "\n8. The stop rule");
    let stop = crate::route::stop_span(inputs.window);
    if stop.from_s != inputs.window.from_s {
        let _ = writeln!(
            out,
            "   read over the last {} days of the window, {} to {}: it is about what the copy is doing to production now, not about the evidence (the copy's hold, rule 2, is read over the whole window). Rules 1, 3, 4 and 5 were not read for the window before that: a stop that fired there is in a report whose window ends there, not in this one",
            crate::route::STOP_SPAN_S / 86_400,
            crate::time::format(stop.from_s),
            crate::time::format(stop.to_s)
        );
    }
    stop_rule(
        &mut out,
        &mut add,
        inputs.results,
        inputs.metrics,
        hold,
        &StopWords {
            by: crate::query::Key::Day,
            what: "comment",
            route: r.route,
            lines: "node_requests",
        },
        stop,
    );

    // ---- Criteria and verdict.
    let verdict = verdict_of(&criteria);
    let _ = writeln!(out, "\n9. Criteria");
    for c in &criteria {
        let _ = writeln!(out, "   {:<26} {:<20} {}", c.name, c.mark.text(), c.value);
    }
    let short: Vec<&str> = criteria
        .iter()
        .filter(|c| c.mark == Mark::Short)
        .map(|c| c.name)
        .collect();
    let not_evaluated = criteria
        .iter()
        .filter(|c| c.mark == Mark::NotEvaluated)
        .count();
    let _ = writeln!(
        out,
        "\nEnough evidence is a count of judged observations for each class, whatever span of time it takes; no number of days stands in for it."
    );
    if !short.is_empty() {
        let _ = writeln!(
            out,
            "Not enough observations yet for: {}. Until each minimum is reached, an agreement share above is a count, not a result, and the verdict cannot be PASS.",
            short.join(", ")
        );
    }
    if not_evaluated > 0 {
        let _ = writeln!(
            out,
            "{not_evaluated} criteria could not be evaluated (a query refused, cut off or withheld, or a metric not read); nothing is concluded from part of a result."
        );
    }
    let _ = writeln!(out, "\nWhat this cannot show:");
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
    "Which comment: no line carries a comment number, so Node's stored comment is found by its text and never by its number, and a would-be duplicate cannot be shown to be the same comment Node refused.",
    "Which conversations: an admitted copy's line names its conversation by number, and the one thing read from it is how many conversations the admitted copies span. No class is counted by conversation: a disagreement is not placed in one, and a copy handed back before it is admitted names none. No minimum is set on the number of conversations: it is reported for a reader to weigh.",
    "A comment Node stored under a text other than the one the handler parsed: it is looked for by the parsed text and not found, so it reads only as no row beside Node's 200, and how the two texts differ is not shown.",
    "Email and notifications: the moderators' email for a comment awaiting moderation, the notification task and the author's last-interaction time are not read or compared.",
    "What Node did besides answer: Node writes no line of its own for a comment, so whether Node created the participant, and what Node took the conversation's moderation to be, are not paired with the shadow's reading.",
    "The write: observe mode stores nothing, so the insert, the comment's number, the wait for the comment-number lock, a duplicate arriving between admission and the insert, the author's vote as a write, and the reply deadline are not covered.",
    "Texts at the edges (the length limit, surrogates, control characters, surrounding spaces) and an author's vote other than agree hardly occur in real comments; a report says little about them however long it runs.",
    "A request Node refused before its router matched the route has an access line that names no route; it is counted as an observation with no Node line and is never judged. Only where nginx's status for it is not what the handler would answer is that said, as a criterion to examine.",
    "Not copied: requests that miss the exact location (case, trailing slash) and bodies outside 1 to 9999 bytes; a copy carries no query string.",
];

fn paired_section(
    out: &mut String,
    add: &mut impl FnMut(&'static str, String, Mark),
    join: &[Row],
    differs_anywhere: Option<(u64, u64)>,
) {
    let all = |key: &str| sum(join, key, |_| true);
    let (copied, covered, host_absent) = (all("copied"), all("covered"), all("host_absent"));
    // A copy nginx answered itself (the shadow's host absent: a shadow that
    // is down) is a copy the shadow should have seen.
    let expected = copied + host_absent;
    let coverage = share(covered, expected);
    let _ = writeln!(
        out,
        "   copied {copied}, answered 204 {}, the shadow's host absent {host_absent}, outside the body bound {}, no copy line {}; observation lines for copied comments {covered} ({} of copied and host-absent)",
        all("answered"),
        all("not_copied"),
        all("no_mirror"),
        pct(coverage)
    );
    add(
        "coverage",
        format!(
            "{} of copied comments, a down shadow included ({covered} / {expected})",
            pct(coverage)
        ),
        match coverage {
            None => Mark::NotEvaluated,
            Some(c) if c >= bar::COVERAGE => Mark::Pass,
            Some(_) => Mark::Miss,
        },
    );
    let (paired, no_node, no_obs, no_obs_copied) = (
        all("paired"),
        all("no_node"),
        all("no_obs"),
        all("no_obs_copied"),
    );
    let _ = writeln!(
        out,
        "   paired (one nginx line, one Node access line, one observation) {paired}; observations with no Node line {no_node}; Node lines with no observation {no_obs} (of them copied {no_obs_copied}); Node's status differs from nginx's on {}",
        all("http_edge_mismatch")
    );
    // An observation with no Node line is never judged: Node's status is
    // not in hand. nginx's is, and where the handler would store the comment
    // or answer it itself and nginx saw Node answer something else (the
    // participant staying, and no 5xx), the two cannot both be right: a
    // request Node refused before its router matched the route, say. Such a
    // request must not pass unseen.
    let mut unpaired_differ = 0;
    for row in join {
        let (edge, would) = (code(row, "edge_st"), code(row, "rust_st"));
        if matches!(edge.as_str(), "499" | "none" | "other") || server_error(&edge) {
            continue;
        }
        if edge != "200" {
            unpaired_differ += count(row, "no_node_serve");
        }
        if edge != would {
            unpaired_differ += count(row, "no_node_answer");
        }
    }
    let _ = writeln!(
        out,
        "   observations with no Node line where the handler would store or answer and nginx saw another status from Node: {unpaired_differ} (not judged: Node's own status is not in hand; to be examined)"
    );
    add(
        "pairing",
        format!(
            "{paired} paired; observations with no Node line {no_node} (of them at odds with the status nginx saw {unpaired_differ}); Node lines with no observation {no_obs}"
        ),
        if all("comments") == 0 {
            Mark::NotEvaluated
        } else if unpaired_differ > 0 {
            Mark::Miss
        } else {
            Mark::Info
        },
    );
    let j = classify(join);
    let _ = writeln!(
        out,
        "   paired and not judged: handed back to Node {}, not known for want of an anchor {}, shed or not observed {}, would fail {}",
        all("hand"),
        all("unknown"),
        all("unobserved"),
        all("failed")
    );

    // ---- Would serve.
    let serve_judged = j.serve_agree + j.serve_stored_otherwise + j.serve_contradicted;
    let serve_differ = j.serve_stored_otherwise + j.serve_contradicted;
    let serve_not_known = j.serve_not_read + j.serve_repeat + j.serve_no_status;
    let _ = writeln!(
        out,
        "   would store the comment (would_serve) {}: agree {} (Node 200 and its own row stored as the handler would store it); disagree {serve_differ} (Node 200 and stored otherwise {}, Node's status contradicts {}); not known {serve_not_known} (the stored comment or its vote not read {}, the same text twice within five seconds {}, no status on Node's line {}); Node answered 5xx {} (the comment stored all the same {})",
        j.serve,
        j.serve_agree,
        j.serve_stored_otherwise,
        j.serve_contradicted,
        j.serve_not_read,
        j.serve_repeat,
        j.serve_no_status,
        j.serve_node_failed,
        j.serve_node_failed_stored
    );
    let serve_unknown = share(serve_not_known, serve_judged + serve_not_known);
    add(
        "would serve",
        format!(
            "agree {}, disagree {serve_differ}, not known {serve_not_known}, Node 5xx {}; judged {}; not known {} of judged and not known",
            j.serve_agree,
            j.serve_node_failed,
            against(serve_judged, need::WOULD_SERVE),
            pct(serve_unknown)
        ),
        if serve_differ > 0 {
            Mark::Stop
        } else if serve_judged < need::WOULD_SERVE {
            Mark::Short
        } else if serve_unknown.is_some_and(|s| s > bar::NOT_KNOWN) {
            Mark::Miss
        } else {
            Mark::Pass
        },
    );

    // ---- Would answer.
    let duplicates_judged = j.duplicate_agree + j.duplicate_contradicted;
    let answer_not_known = j.answer_late + j.answer_repeat + j.answer_no_status;
    let _ = writeln!(
        out,
        "   would answer without writing (would_answer) {}: agree {} (duplicate 409 {}, closed 403 {}); Node's status contradicts {}; not known {answer_not_known} (a would-be duplicate beside Node's 200 on a copy observed more than {} ms late {}, the same text twice within five seconds {}, no status on Node's line {}); Node answered 5xx {}",
        j.answer,
        j.answer_agree,
        j.duplicate_agree,
        j.closed_agree,
        j.answer_contradicted,
        LATE_COPY_MS,
        j.answer_late,
        j.answer_repeat,
        j.answer_no_status,
        j.answer_node_failed
    );
    for (node, would, n) in &j.pairs {
        let _ = writeln!(out, "     Node {node:<6} shadow {would:<6} {n}");
    }
    add(
        "would answer",
        format!(
            "agree {}, contradicted {}, not known {answer_not_known}; duplicates judged {}",
            j.answer_agree,
            j.answer_contradicted,
            against(duplicates_judged, need::DUPLICATES)
        ),
        if j.answer_contradicted > 0 {
            Mark::Stop
        } else if duplicates_judged < need::DUPLICATES {
            Mark::Short
        } else {
            Mark::Pass
        },
    );

    // ---- The stored comment.
    let read_judged = j.read_clean + j.read_diff;
    let read_not_known = j.read.saturating_sub(read_judged);
    let kinds: Vec<String> = j
        .kinds
        .iter()
        .filter(|(_, n)| **n > 0)
        .map(|(kind, n)| format!("{kind} {n}"))
        .collect();
    let _ = writeln!(
        out,
        "   stored comments read back where Node answered 200 (would store, or handed back for strict moderation) {}: as the handler would store it {}; otherwise {}{}; not known {read_not_known}",
        j.read,
        j.read_clean,
        j.read_diff,
        if kinds.is_empty() {
            String::new()
        } else {
            format!(" ({})", kinds.join(", "))
        }
    );
    let (vote_anywhere, text_anywhere) = differs_anywhere.unwrap_or((0, 0));
    let read_unknown = share(read_not_known, j.read);
    add(
        "stored comment",
        format!(
            "as the handler would store it {}, otherwise {}, not known {read_not_known}; a stored text that differs on any line {text_anywhere}; judged {}; not known {} of those read back",
            j.read_clean,
            j.read_diff,
            against(read_judged, need::STORED),
            pct(read_unknown)
        ),
        if j.read_diff > 0 || text_anywhere > 0 {
            Mark::Stop
        } else if differs_anywhere.is_none() {
            Mark::NotEvaluated
        } else if read_judged < need::STORED {
            Mark::Short
        } else if read_unknown.is_some_and(|s| s > bar::NOT_KNOWN) {
            Mark::Miss
        } else {
            Mark::Pass
        },
    );

    // ---- The author's vote.
    let votes_compared = j.vote_same + j.vote_different + j.vote_absent;
    let _ = writeln!(
        out,
        "   the author's vote on those: same {}, different {}, absent {}, not compared {}; a stored vote that differs on any line {vote_anywhere}",
        j.vote_same, j.vote_different, j.vote_absent, j.vote_not_compared
    );
    let _ = writeln!(
        out,
        "   Node answered 5xx with the comment stored {} (without its author's vote {})",
        j.stored_then_failed, j.stored_then_failed_no_vote
    );
    add(
        "author's vote",
        format!(
            "same {}, different {} (on any line {vote_anywhere}), absent {}, not compared {}; compared {}",
            j.vote_same,
            j.vote_different,
            j.vote_absent,
            j.vote_not_compared,
            against(votes_compared, need::VOTES)
        ),
        if j.vote_different > 0 || vote_anywhere > 0 {
            Mark::Stop
        } else if differs_anywhere.is_none() {
            Mark::NotEvaluated
        } else if votes_compared < need::VOTES {
            Mark::Short
        } else {
            Mark::Pass
        },
    );
}
