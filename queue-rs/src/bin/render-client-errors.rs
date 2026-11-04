//! Print a top-N client-error table from a local Logs Insights JSON or CSV export.
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};
use std::io::{self, Read};

const MAX_BYTES: u64 = 16 * 1024 * 1024;
const MAX_ROWS: usize = 10000;
const REQUIRED: [&str; 4] = ["signature", "client", "kind", "total_count"];
const DETAILS: [&str; 7] = [
    "error_message",
    "resource",
    "status",
    "page",
    "stack",
    "first_build",
    "latest_build",
];
type Row = BTreeMap<String, String>;
type Result<T> = std::result::Result<T, &'static str>;

// CSV supports quoted commas, quotes, CRLF and multiline cells. Reject incomplete
// quoted fields and trailing text after a closing quote before interpreting rows.
fn csv_records(text: &str) -> Result<Vec<Vec<String>>> {
    let mut records = Vec::new();
    let mut row = Vec::new();
    let mut field = String::new();
    let mut chars = text.chars().peekable();
    let mut quoted = false;
    let mut closed = false;
    let mut started = false;
    while let Some(ch) = chars.next() {
        if quoted {
            if ch == '"' {
                if chars.peek() == Some(&'"') {
                    chars.next();
                    field.push('"');
                } else {
                    quoted = false;
                    closed = true;
                }
            } else {
                field.push(ch);
            }
            continue;
        }
        if closed && ch != ',' && ch != '\r' && ch != '\n' {
            return Err("malformed CSV quoted cell");
        }
        match ch {
            '"' if !started => {
                quoted = true;
                started = true;
            }
            ',' => {
                row.push(std::mem::take(&mut field));
                closed = false;
                started = false;
            }
            '\r' | '\n' => {
                if ch == '\r' && chars.peek() == Some(&'\n') {
                    chars.next();
                }
                if started || !field.is_empty() || !row.is_empty() {
                    row.push(std::mem::take(&mut field));
                    records.push(std::mem::take(&mut row));
                    if records.len() > MAX_ROWS + 1 {
                        return Err("expected at most 10000 result rows");
                    }
                }
                closed = false;
                started = false;
            }
            _ => {
                field.push(ch);
                started = true;
            }
        }
    }
    if quoted {
        return Err("unterminated CSV quoted cell");
    }
    if started || !field.is_empty() || !row.is_empty() {
        row.push(field);
        records.push(row);
    }
    Ok(records)
}

fn parse_export(text: &str) -> Result<Vec<Row>> {
    let text = text.trim_start_matches('\u{feff}');
    if text.trim_start().starts_with(['[', '{']) {
        let data: Value = serde_json::from_str(text).map_err(|_| "invalid JSON export")?;
        let results = if let Some(object) = data.as_object() {
            if object.get("status").is_some_and(|s| s != "Complete")
                || object
                    .get("nextToken")
                    .is_some_and(|s| !s.is_null() && s != "")
            {
                return Err("query export is incomplete");
            }
            object.get("results").ok_or("missing results")?
        } else {
            &data
        };
        let rows = results.as_array().ok_or("expected result rows")?;
        if rows.len() > MAX_ROWS {
            return Err("expected at most 10000 result rows");
        }
        rows.iter()
            .map(|pairs| {
                let mut row = Row::new();
                for pair in pairs.as_array().ok_or("expected field/value pairs")? {
                    let field = pair
                        .get("field")
                        .and_then(Value::as_str)
                        .ok_or("expected string field/value pairs")?;
                    let value = pair
                        .get("value")
                        .and_then(Value::as_str)
                        .ok_or("expected string field/value pairs")?;
                    if row.insert(field.into(), value.into()).is_some() {
                        return Err("duplicate field");
                    }
                }
                Ok(row)
            })
            .collect()
    } else {
        let records = csv_records(text)?;
        let headers = records.first().ok_or("missing CSV headers")?;
        if headers.iter().collect::<HashSet<_>>().len() != headers.len()
            || !REQUIRED.iter().all(|key| headers.iter().any(|s| s == key))
        {
            return Err("CSV requires unique signature, client, kind, total_count headers");
        }
        if records.len() > MAX_ROWS + 1 {
            return Err("expected at most 10000 result rows");
        }
        records
            .iter()
            .skip(1)
            .map(|values| {
                if values.len() != headers.len() {
                    return Err("CSV row does not match its headers");
                }
                Ok(headers
                    .iter()
                    .cloned()
                    .zip(values.iter().cloned())
                    .collect())
            })
            .collect()
    }
}

fn validate(rows: Vec<Row>) -> Result<Vec<(u64, Row)>> {
    let has_period = rows.first().is_some_and(|row| row.contains_key("period"));
    let mut seen = HashSet::new();
    rows.into_iter()
        .map(|row| {
            if !REQUIRED.iter().all(|key| row.contains_key(*key)) {
                return Err("missing required field");
            }
            let signature = &row["signature"];
            if signature.len() != 16
                || !signature
                    .bytes()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
            {
                return Err("signature must be 16 lowercase hex characters");
            }
            let raw = &row["total_count"];
            let count = raw
                .parse::<u64>()
                .map_err(|_| "total_count must be a positive 64-bit integer")?;
            if raw.starts_with('0')
                || !raw.bytes().all(|c| c.is_ascii_digit())
                || count == 0
                || count > i64::MAX as u64
            {
                return Err("total_count must be a positive 64-bit integer");
            }
            if ![
                "error",
                "unhandledrejection",
                "console_error",
                "console_warn",
                "fetch",
                "xhr",
                "resource",
                "csp",
            ]
            .contains(&row["kind"].as_str())
                || row["client"].trim().is_empty()
            {
                return Err("invalid kind or empty client");
            }
            if row.contains_key("period") != has_period
                || (has_period && row["period"].trim().is_empty())
            {
                return Err("period must be present and nonempty on every row");
            }
            let key: Vec<String> = ["signature", "client", "kind", "period"]
                .iter()
                .map(|key| row.get(*key).cloned().unwrap_or_default())
                .collect();
            if !seen.insert(key) {
                return Err("duplicate summary group");
            }
            Ok((count, row))
        })
        .collect()
}

// Only hashed bundle locations lose offsets in this optional triage view.
// The browser and the default table retain each precise position.
fn build_location(location: &str) -> Option<String> {
    let file = if let Some((prefix, column)) = location.rsplit_once(':') {
        if let Some((file, line)) = prefix.rsplit_once(':') {
            if !column.is_empty()
                && !line.is_empty()
                && column.bytes().all(|b| b.is_ascii_digit())
                && line.bytes().all(|b| b.is_ascii_digit())
            {
                file
            } else {
                location
            }
        } else {
            location
        }
    } else {
        location
    };
    let (stem, extension) = file.rsplit_once('.')?;
    if !["js", "mjs", "css"].contains(&extension) {
        return None;
    }
    let (name, hash) = stem.rsplit_once('.')?;
    if hash.len() < 8
        || !hash
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return None;
    }
    Some(format!("{name}.{extension}"))
}

fn location_signature(parts: &[String]) -> String {
    let mut a = 2166136261u32;
    let mut b = 5381u32;
    for unit in parts.join("\n").encode_utf16() {
        a = (a ^ u32::from(unit)).wrapping_mul(16777619);
        b = (b ^ u32::from(unit)).wrapping_mul(33);
    }
    format!("{a:08x}{b:08x}")
}

fn group_builds(mut rows: Vec<(u64, Row)>) -> Result<Vec<(u64, Row)>> {
    // Select a deterministic representative. Without timestamps, combining the
    // per-row first/latest builds cannot establish a new chronological range.
    rows.sort_by(|a, b| a.1.cmp(&b.1));
    let mut groups: BTreeMap<Vec<String>, (u64, Row)> = BTreeMap::new();
    for (count, mut row) in rows {
        let stack = row.get("stack").map(String::as_str).unwrap_or("");
        let location = stack
            .lines()
            .next()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| row.get("resource").map(String::as_str).unwrap_or(""));
        let normalized = build_location(location);
        let mut key = vec![row["client"].clone(), row["kind"].clone()];
        let diagnostic = row
            .get("status")
            .filter(|s| !s.is_empty() && *s != "0")
            .or_else(|| row.get("error_message"))
            .cloned();
        if let (Some(location), Some(diagnostic)) = (normalized, diagnostic) {
            key.extend([diagnostic, location.clone()]);
            row.insert("signature".into(), location_signature(&key));
            row.insert("group_location".into(), location);
        } else {
            // Missing diagnostic fields must never merge unrelated summaries.
            key.extend([row["signature"].clone(), String::new()]);
        }
        key.push(row.get("period").cloned().unwrap_or_default());
        row.insert("position_signatures".into(), "1".into());
        if let Some((total, representative)) = groups.get_mut(&key) {
            *total = total
                .checked_add(count)
                .filter(|n| *n <= i64::MAX as u64)
                .ok_or("combined total_count exceeds a positive 64-bit integer")?;
            representative.insert("total_count".into(), total.to_string());
            let positions = representative["position_signatures"]
                .parse::<usize>()
                .map_err(|_| "invalid position count")?
                + 1;
            representative.insert("position_signatures".into(), positions.to_string());
        } else {
            groups.insert(key, (count, row));
        }
    }
    Ok(groups.into_values().collect())
}

fn cell(value: &str) -> String {
    let mut escaped = String::new();
    for ch in value.chars() {
        match ch {
            '"' => escaped.push_str("\\\""),
            '\\' => escaped.push_str("\\\\"),
            '\n' => escaped.push_str("\\n"),
            '\r' => escaped.push_str("\\r"),
            '\t' => escaped.push_str("\\t"),
            '\u{08}' => escaped.push_str("\\b"),
            '\u{0c}' => escaped.push_str("\\f"),
            ' '..='~' if !"|<>&`".contains(ch) => escaped.push(ch),
            _ => {
                for unit in ch.encode_utf16(&mut [0; 2]) {
                    escaped.push_str(&format!("\\u{unit:04x}"));
                }
            }
        }
        if escaped.len() > 120 {
            escaped.truncate(117);
            escaped.push_str("...");
            break;
        }
    }
    escaped
}

fn render(mut rows: Vec<(u64, Row)>, top: usize, grouped: bool) -> String {
    if rows.is_empty() {
        return "No results.".into();
    }
    rows.sort_by(|(a_count, a), (b_count, b)| {
        b_count.cmp(a_count).then_with(|| {
            ["client", "kind", "signature", "period"]
                .iter()
                .map(|key| a.get(*key))
                .cmp(
                    ["client", "kind", "signature", "period"]
                        .iter()
                        .map(|key| b.get(*key)),
                )
        })
    });
    let mut fields = vec!["total_count", "client", "kind", "signature"];
    if rows[0].1.contains_key("period") {
        fields.push("period");
    }
    if grouped {
        fields.extend(["group_location", "position_signatures"]);
    }
    fields.extend(DETAILS);
    let mut table: Vec<Vec<String>> = vec![
        fields
            .iter()
            .map(|field| {
                if *field == "total_count" {
                    "COUNT".into()
                } else if grouped && *field == "signature" {
                    "GROUP_SIGNATURE".into()
                } else {
                    field.to_uppercase()
                }
            })
            .collect(),
    ];
    table.extend(rows.iter().take(top).map(|(_, row)| {
        fields
            .iter()
            .map(|key| cell(row.get(*key).map(String::as_str).unwrap_or("")))
            .collect()
    }));
    let widths: Vec<usize> = (0..fields.len())
        .map(|column| table.iter().map(|row| row[column].len()).max().unwrap_or(0))
        .collect();
    let mut lines: Vec<String> = table
        .iter()
        .map(|row| {
            row.iter()
                .zip(&widths)
                .map(|(value, width)| format!("{value:width$}"))
                .collect::<Vec<_>>()
                .join(" | ")
                .trim_end()
                .to_owned()
        })
        .collect();
    lines.insert(
        1,
        widths
            .iter()
            .map(|width| "-".repeat(*width))
            .collect::<Vec<_>>()
            .join("-+-"),
    );
    lines.join("\n")
}

fn run() -> Result<String> {
    let mut input = None;
    let mut top = 20;
    let mut grouped = false;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--help" || arg == "-h" {
            return Ok("Usage: render-client-errors <JSON-or-CSV-path|-> [--top 1..1000] [--group-builds]\nPrint a local client-error export as an escaped table (default top: 20).".into());
        }
        if arg == "--group-builds" {
            grouped = true;
        } else if arg == "--top" || arg.starts_with("--top=") {
            let raw = if let Some(value) = arg.strip_prefix("--top=") {
                value.to_owned()
            } else {
                args.next().ok_or("top must be between 1 and 1000")?
            };
            if raw.is_empty() || raw.len() > 4 || !raw.bytes().all(|c| c.is_ascii_digit()) {
                return Err("top must be between 1 and 1000");
            }
            top = raw.parse().map_err(|_| "top must be between 1 and 1000")?;
            if !(1..=1000).contains(&top) {
                return Err("top must be between 1 and 1000");
            }
        } else if input.is_none() && (arg == "-" || !arg.starts_with('-')) {
            input = Some(arg);
        } else {
            return Err("expected input path and optional --top");
        }
    }
    let input = input.ok_or("expected input path or - for stdin")?;
    let reader: Box<dyn Read> = if input == "-" {
        Box::new(io::stdin())
    } else {
        Box::new(std::fs::File::open(input).map_err(|_| "cannot read export")?)
    };
    let mut bytes = Vec::new();
    reader
        .take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "cannot read export")?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("export exceeds 16 MiB");
    }
    let text = std::str::from_utf8(&bytes).map_err(|_| "cannot read a valid UTF-8 export")?;
    let rows = validate(parse_export(text)?)?;
    let rows = if grouped { group_builds(rows)? } else { rows };
    let table = render(rows, top, grouped);
    if grouped {
        Ok(format!(
            "Cross-build groups; representative details and build range describe one input row.\n{table}"
        ))
    } else {
        Ok(table)
    }
}

fn main() {
    match run() {
        Ok(output) => println!("{output}"),
        Err(message) => {
            eprintln!("error: {message}");
            std::process::exit(2);
        }
    }
}
