//! Running a join in slices of the window, and adding the slices up.
//!
//! Logs Insights returns at most 10,000 rows, and a join's first stage has a
//! row for every request id in its time range. So a join is never given a
//! range that holds more than `SLICE_MAX_REQUESTS` requests: the window is
//! cut, at five-minute marks, into slices that each hold at most that many,
//! by nginx's own count of its lines in each five minutes. A request belongs
//! to the slice its nginx line falls in, the slices cover the window exactly
//! once, and a join's final stage holds only counts, so the slices' rows add
//! up to the window's. Each slice's total is checked against nginx's count
//! for the same span, which is taken by the same test of a line's time and
//! must be equal; a slice that does not match is not added up, and the
//! comparison is withheld.
use crate::aws::{Row, Window};
use crate::route::BIN_S;
use std::collections::BTreeMap;

/// The join's count of nginx lines inside its range, in every sliced query.
pub const TOTAL: &str = "edge_lines";

/// Requests in each five minutes, from the `edge_bins` rows: (start, count),
/// in order. An error says what is wrong and never quotes a row.
pub fn bins(rows: &[Row]) -> Result<Vec<(i64, u64)>, String> {
    let mut out: BTreeMap<i64, u64> = BTreeMap::new();
    for row in rows {
        let at = row
            .get("slot")
            .and_then(|at| crate::time::parse(at).ok())
            .ok_or("a five-minute count has no readable time")?;
        let count = row
            .get("n")
            .and_then(|n| n.trim().parse::<f64>().ok())
            .filter(|n| n.is_finite() && *n >= 0.0)
            .ok_or("a five-minute count is not a number")?;
        *out.entry(at.div_euclid(BIN_S) * BIN_S).or_default() += count.round() as u64;
    }
    Ok(out.into_iter().collect())
}

/// The slices a join runs in: in order, covering the window exactly once,
/// each a run of whole five-minute bins holding at most `max` requests. One
/// bin that alone holds more cannot be joined completely, and is refused.
pub fn plan(window: Window, bins: &[(i64, u64)], max: u64) -> Result<Vec<Window>, String> {
    let mut slices = vec![];
    let (mut start, mut held) = (window.from_s, 0u64);
    for &(bin, count) in bins {
        if bin >= window.to_s {
            continue;
        }
        if count > max {
            return Err(format!(
                "one five-minute span holds {count} requests, more than the {max} a join query is given, so the join would be cut off"
            ));
        }
        let begins = bin.max(window.from_s);
        if held + count > max && begins > start {
            slices.push(Window {
                from_s: start,
                to_s: begins,
            });
            (start, held) = (begins, 0);
        }
        held += count;
    }
    slices.push(Window {
        from_s: start,
        to_s: window.to_s,
    });
    Ok(slices)
}

/// nginx's count of its lines in a slice, from the same bins.
pub fn expected(window: Window, slice: Window, bins: &[(i64, u64)]) -> u64 {
    bins.iter()
        .filter(|(bin, _)| {
            let begins = (*bin).max(window.from_s);
            *bin < window.to_s && begins >= slice.from_s && begins < slice.to_s
        })
        .map(|(_, count)| count)
        .sum()
}

/// A slice's own count of the nginx lines it joined.
pub fn joined(rows: &[Row]) -> u64 {
    rows.iter()
        .filter_map(|row| row.get(TOTAL).and_then(|v| v.trim().parse::<f64>().ok()))
        .map(|v| v.max(0.0).round() as u64)
        .sum()
}

/// The pieces a query with `chunk_s` runs in: in order, covering the window
/// exactly once, each at most `chunk_s` long.
pub fn chunks(window: Window, chunk_s: i64) -> Vec<Window> {
    if chunk_s <= 0 {
        return vec![window];
    }
    let mut out = vec![];
    let mut from_s = window.from_s;
    while from_s < window.to_s {
        let to_s = (from_s + chunk_s).min(window.to_s);
        out.push(Window { from_s, to_s });
        from_s = to_s;
    }
    out
}

/// The slices' rows added up: one row for each group, each count the sum of
/// that group's counts.
pub fn merge(keys: &[&str], parts: Vec<Vec<Row>>) -> Vec<Row> {
    let mut groups: BTreeMap<Vec<Option<String>>, BTreeMap<String, f64>> = BTreeMap::new();
    for row in parts.into_iter().flatten() {
        let key: Vec<Option<String>> = keys.iter().map(|k| row.get(*k).cloned()).collect();
        let sums = groups.entry(key).or_default();
        for (name, value) in &row {
            if keys.contains(&name.as_str()) {
                continue;
            }
            if let Ok(v) = value.trim().parse::<f64>() {
                *sums.entry(name.clone()).or_default() += v;
            }
        }
    }
    groups
        .into_iter()
        .map(|(key, sums)| {
            let mut row = Row::new();
            for (name, value) in keys.iter().zip(key) {
                if let Some(value) = value {
                    row.insert((*name).to_owned(), value);
                }
            }
            for (name, sum) in sums {
                row.insert(name, format!("{}", sum.round() as i64));
            }
            row
        })
        .collect()
}
