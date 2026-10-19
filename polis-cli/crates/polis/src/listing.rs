//! The human view of `conversation list`: one row per owned conversation with its
//! topic, description, participation URL and newest report URL.
use serde_json::Value;
use std::collections::HashMap;

const HEADERS: [&str; 4] = ["TOPIC", "DESCRIPTION", "URL", "REPORT"];
const GAP: &str = "  ";
/// Columns shared by the topic and description when the terminal width is unknown.
const TEXT_BUDGET: usize = 72;
/// Narrowest text columns: below these a row wraps instead of becoming unreadable.
const TOPIC_MIN: usize = 12;
const DESCRIPTION_MIN: usize = 16;
/// Widest text columns, however wide the terminal is.
const TOPIC_MAX: usize = 48;
const DESCRIPTION_MAX: usize = 80;

/// Render the table for stdout. URLs are never truncated; the topic and
/// description are cut to fit the terminal when stdout is one.
pub fn table(origin: &str, conversations: &[Value], reports: Option<&[Value]>) -> String {
    layout(origin, conversations, reports, terminal_width())
}

fn layout(
    origin: &str,
    conversations: &[Value],
    reports: Option<&[Value]>,
    terminal: Option<usize>,
) -> String {
    if conversations.is_empty() {
        return "No conversations.\n".into();
    }
    let origin = origin.trim_end_matches('/');
    let newest = newest_reports(reports.unwrap_or_default());
    let sizes = conversations.iter().any(|r| r.get("size").is_some());
    let mut headers = HEADERS.to_vec();
    if sizes {
        headers.extend(["PARTICIPANTS", "STATEMENTS", "VOTES"]);
    }
    let rows: Vec<Vec<String>> = conversations
        .iter()
        .map(|row| {
            let id = text(row, "conversation_id");
            let report = match newest.get(id) {
                Some((report_id, 1)) => link(origin, "report/", report_id),
                Some((report_id, count)) => {
                    format!("{} +{}", link(origin, "report/", report_id), count - 1)
                }
                None => String::new(),
            };
            let mut cells = vec![
                clean(text(row, "topic")),
                clean(text(row, "description")),
                link(origin, "", id),
                report,
            ];
            if sizes {
                for key in ["participants", "statements", "votes"] {
                    cells.push(
                        row["size"][key]
                            .as_u64()
                            .map_or_else(|| "-".into(), |v| v.to_string()),
                    );
                }
            }
            cells
        })
        .collect();
    let natural = |column: usize| {
        rows.iter()
            .map(|row| chars(&row[column]))
            .max()
            .unwrap_or(0)
            .max(chars(headers[column]))
    };
    let (url_width, report_width) = (natural(2), natural(3));
    let count_widths: Vec<usize> = (4..headers.len()).map(natural).collect();
    let fixed = url_width
        + report_width
        + count_widths.iter().sum::<usize>()
        + (headers.len() - 1) * GAP.len();
    let budget = terminal.map_or(TEXT_BUDGET, |columns| columns.saturating_sub(fixed));
    let (topic_width, description_width) = text_widths(budget, natural(0), natural(1));
    let mut widths = vec![topic_width, description_width, url_width, report_width];
    widths.extend(count_widths);
    let mut out = String::new();
    let header: Vec<String> = headers.into_iter().map(str::to_owned).collect();
    for row in std::iter::once(&header).chain(&rows) {
        let mut line = String::new();
        for (column, cell) in row.iter().enumerate() {
            if column > 0 {
                line.push_str(GAP);
            }
            let cell = truncate(cell, widths[column]);
            line.push_str(&cell);
            // The last column is never padded, so lines carry no trailing spaces.
            if column + 1 < widths.len() {
                line.extend(std::iter::repeat_n(' ', widths[column] - chars(&cell)));
            }
        }
        out.push_str(line.trim_end());
        out.push('\n');
    }
    out
}

/// Topic and description widths within `budget` columns: the description takes
/// the larger share, and whatever a shorter column does not need goes to the other.
fn text_widths(budget: usize, topic: usize, description: usize) -> (usize, usize) {
    let budget = budget.max(TOPIC_MIN + DESCRIPTION_MIN);
    let topic = topic.min(TOPIC_MAX);
    let description = description.min(DESCRIPTION_MAX);
    let topic_width = topic.min((budget * 2 / 5).max(TOPIC_MIN));
    let description_width =
        description.min(budget.saturating_sub(topic_width).max(DESCRIPTION_MIN));
    let topic_width = topic.min(budget.saturating_sub(description_width).max(topic_width));
    (topic_width, description_width)
}

/// The newest report of each conversation, with that conversation's report count.
/// `created` is epoch milliseconds, as a JSON number or the string PostgreSQL's
/// BIGINT arrives as; a report without it never outranks a dated one.
fn newest_reports(reports: &[Value]) -> HashMap<&str, (&str, usize)> {
    let mut newest: HashMap<&str, (&str, i64, usize)> = HashMap::new();
    for report in reports {
        let (conversation, report_id) =
            (text(report, "conversation_id"), text(report, "report_id"));
        if conversation.is_empty() || report_id.is_empty() {
            continue;
        }
        let created = match report.get("created") {
            Some(Value::Number(n)) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)),
            Some(Value::String(s)) => s.trim().parse().ok(),
            _ => None,
        }
        .unwrap_or(i64::MIN);
        match newest.get_mut(conversation) {
            Some(entry) => {
                entry.2 += 1;
                if created > entry.1 {
                    *entry = (report_id, created, entry.2);
                }
            }
            None => {
                newest.insert(conversation, (report_id, created, 1));
            }
        }
    }
    newest
        .into_iter()
        .map(|(conversation, (report_id, _, count))| (conversation, (report_id, count)))
        .collect()
}

/// A clickable link for a server-supplied ID, or the cleaned ID alone when it is
/// not a plain path segment.
fn link(origin: &str, prefix: &str, id: &str) -> String {
    if !id.is_empty()
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        format!("{origin}/{prefix}{id}")
    } else {
        clean(id)
    }
}

fn text<'a>(row: &'a Value, key: &str) -> &'a str {
    row.get(key).and_then(Value::as_str).unwrap_or("")
}

fn chars(s: &str) -> usize {
    s.chars().count()
}

/// Single-line printable text: whitespace runs become one space, and control or
/// invisible formatting characters are dropped, since the text is user-submitted.
fn clean(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut pending_space = false;
    for c in text.chars() {
        if c.is_whitespace() {
            pending_space = !out.is_empty();
        } else if !c.is_control() && !invisible(c) {
            if pending_space {
                out.push(' ');
                pending_space = false;
            }
            out.push(c);
        }
    }
    out
}

/// Zero-width and bidirectional formatting characters that reorder or hide text.
pub(crate) fn invisible(c: char) -> bool {
    matches!(
        c,
        '\u{061C}'
            | '\u{180E}'
            | '\u{200B}'..='\u{200F}'
            | '\u{202A}'..='\u{202E}'
            | '\u{2060}'..='\u{2064}'
            | '\u{2066}'..='\u{2069}'
            | '\u{FEFF}'
    )
}

/// Multi-line text for the terminal. Line breaks and tabs stay; every other
/// control character (escape sequences, bells, C1 controls) and every invisible
/// formatting character is dropped, because a passed-through response can carry
/// text chosen by the site rather than by this program.
pub(crate) fn terminal_text(text: &str) -> String {
    text.chars()
        .filter(|&c| c == '\n' || c == '\t' || !(c.is_control() || invisible(c)))
        .collect()
}

/// Cut to `width` characters, ending in an ellipsis when anything was removed.
fn truncate(text: &str, width: usize) -> String {
    if chars(text) <= width {
        return text.to_owned();
    }
    let kept: String = text.chars().take(width.saturating_sub(1)).collect();
    format!("{}…", kept.trim_end())
}

/// The terminal width when stdout is a terminal; None for a pipe or a file.
#[cfg(unix)]
fn terminal_width() -> Option<usize> {
    use std::io::IsTerminal;
    if !std::io::stdout().is_terminal() {
        return None;
    }
    let mut size = libc::winsize {
        ws_row: 0,
        ws_col: 0,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    // SAFETY: TIOCGWINSZ writes a winsize for the terminal on this descriptor.
    if unsafe { libc::ioctl(libc::STDOUT_FILENO, libc::TIOCGWINSZ, &mut size) } != 0 {
        return None;
    }
    (size.ws_col > 0).then_some(usize::from(size.ws_col))
}
#[cfg(not(unix))]
fn terminal_width() -> Option<usize> {
    None
}

#[cfg(test)]
mod tests {
    #[test]
    fn terminal_text_keeps_lines_and_tabs_and_drops_controls_and_invisibles() {
        let raw = "a\u{1b}[31mb\u{7}\u{9b}c\u{200b}\u{202e}\u{feff}\nd\te\r";
        assert_eq!(terminal_text(raw), "a[31mbc\nd\te");
    }

    use super::*;
    use serde_json::json;

    fn conversations() -> Vec<Value> {
        vec![
            json!({"conversation_id":"abc","topic":"Budget 2027","description":"Where should the city spend next year?","is_owner":true}),
            json!({"conversation_id":"def","topic":"Parks","description":null,"is_owner":true}),
        ]
    }
    fn reports() -> Vec<Value> {
        vec![
            json!({"report_id":"r1older","conversation_id":"abc","created":"1700000000000"}),
            json!({"report_id":"r0undated","conversation_id":"abc"}),
            json!({"report_id":"r2newer","conversation_id":"abc","created":1800000000000u64}),
            json!({"report_id":"r3other","conversation_id":"zzz","created":1900000000000u64}),
        ]
    }

    #[test]
    fn renders_four_columns_with_full_links_and_the_newest_report() {
        let out = layout("https://pol.is/", &conversations(), Some(&reports()), None);
        assert_eq!(
            out,
            "TOPIC        DESCRIPTION                             URL                 REPORT\n\
             Budget 2027  Where should the city spend next year?  https://pol.is/abc  https://pol.is/report/r2newer +2\n\
             Parks                                                https://pol.is/def\n"
        );
    }

    #[test]
    fn without_reports_the_column_stays_empty() {
        for reports in [None, Some(&[][..])] {
            let out = layout("https://pol.is", &conversations(), reports, None);
            assert!(out.starts_with(
                "TOPIC        DESCRIPTION                             URL                 REPORT\n"
            ));
            assert!(out.contains("  https://pol.is/abc\n"));
            assert!(!out.contains("report"));
        }
    }

    #[test]
    fn empty_listing_is_a_sentence() {
        assert_eq!(
            layout("https://pol.is", &[], None, None),
            "No conversations.\n"
        );
    }

    #[test]
    fn text_is_cleaned_and_truncated_but_links_are_not() {
        let long = "x".repeat(200);
        let rows = vec![json!({
            "conversation_id":"abc",
            "topic":"Bud\u{7}get \u{1b}[31m2027\u{200e}\n\tnow",
            "description":long,
        })];
        let out = layout("https://pol.is", &rows, None, None);
        assert!(out.contains("Budget [31m2027 now  "), "{out}");
        assert!(!out.contains('\u{7}') && !out.contains('\u{1b}') && !out.contains('\u{200e}'));
        // The 19-character topic leaves the description 53 of the 72-column budget.
        let line = out.lines().nth(1).unwrap();
        assert!(
            line.contains(&format!("{}…  https://pol.is/abc", "x".repeat(52))),
            "{line}"
        );
        assert!(!line.contains(&"x".repeat(53)));
    }

    #[test]
    fn widths_follow_the_terminal_and_hand_back_unused_space() {
        // A 120-column terminal with pol.is links leaves about 40 columns of text.
        assert_eq!(text_widths(40, 100, 100), (16, 24));
        // Short descriptions give their share to the topic, within the caps.
        assert_eq!(text_widths(100, 100, 20), (TOPIC_MAX, 20));
        assert_eq!(text_widths(300, 300, 300), (TOPIC_MAX, DESCRIPTION_MAX));
        // Nothing drops below the floors, even when the terminal is too narrow.
        assert_eq!(text_widths(0, 100, 100), (TOPIC_MIN, DESCRIPTION_MIN));
        // Short text never pads beyond its own length.
        assert_eq!(text_widths(72, 5, 8), (5, 8));
    }

    #[test]
    fn unsafe_ids_are_shown_without_a_link() {
        let rows = vec![json!({"conversation_id":"a b/..\u{1b}","topic":"T"})];
        let out = layout("https://pol.is", &rows, None, None);
        assert!(out.contains("  a b/..\n"), "{out}");
        assert!(!out.contains("https://pol.is/a"));
    }

    #[test]
    fn newest_report_ignores_undated_rows_and_counts_all() {
        let reports = reports();
        let newest = newest_reports(&reports);
        assert_eq!(newest["abc"], ("r2newer", 3));
        assert_eq!(newest["zzz"], ("r3other", 1));
        assert_eq!(newest.len(), 2);
    }

    #[test]
    fn truncation_ends_in_one_ellipsis() {
        assert_eq!(truncate("héllo wörld", 20), "héllo wörld");
        assert_eq!(truncate("héllo wörld", 7), "héllo…");
        assert_eq!(truncate("héllo wörld", 8), "héllo w…");
        assert_eq!(clean("  two\n\n words \t"), "two words");
    }
}
