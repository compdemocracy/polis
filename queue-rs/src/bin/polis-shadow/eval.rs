//! Tests only: runs a compiled query over fixture log lines the way Logs
//! Insights does (JSON fields discovered and flattened with dots, `filter`,
//! `fields`, one or two `stats` stages, `limit`), and returns rows as
//! `get-query-results` would: strings, with absent values left out. It is the
//! semantics the compiled queries assume; where Logs Insights in the account
//! differs (README, "Unproven"), `run` reports the query as refused or the
//! join's totals as inconsistent rather than printing a wrong number.
//!
//! A field a line does not carry is read as the production account's Logs
//! Insights reads it (README, "A field a line does not carry"): an empty
//! string is no field at all; in a `filter` a condition on an absent field
//! is unknown and an `or` with a true part keeps the line; in `fields` and
//! in `stats` an `and` or an `or` with an absent operand and a true one is
//! absent, and a `sum()` none of whose lines has a value is absent from the
//! row, not 0. Three more rules no probe has measured, and the evaluator
//! reads each of them both ways (`Reading`): the tests run under every
//! reading, and a query whose counts differ between them is rewritten.
use crate::aws::Row;
use crate::query::{Agg, Bounds, E, Key, Op, Param, Query, Stats};
use crate::route::ROW_LIMIT;
use std::cell::Cell;
use std::collections::BTreeMap;

/// How the evaluator reads the three rules of Logs Insights in `fields` and
/// `stats` that no probe has measured in the production account. Measured:
/// `true and <absent>` and `true or <absent>` are absent; a sum of absent
/// values only is absent, of false values only 0, and of absent and true
/// values the trues. Not measured:
///
/// - an `and` with a false operand and an absent one: absent, or false;
/// - an `or` with a false operand and an absent one and no true one:
///   absent, or false;
/// - a `sum()` whose lines give false and absent values and no true one:
///   0, or absent.
///
/// The production run's join said "the shadow's host absent 0" where there
/// were 2. That excludes one combination: `false and <absent>` false
/// together with such a sum being 0. The queries are written so that no
/// count depends on any of the three, whichever holds, and the tests are
/// run under all eight readings (`READINGS`): by `POLIS_SHADOW_READING` for
/// a whole run, or by `with_reading` inside one test.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Reading {
    /// `false and <absent>` is false (otherwise absent).
    pub false_and_absent_is_false: bool,
    /// `false or <absent>`, with no true operand, is false (otherwise
    /// absent).
    pub false_or_absent_is_false: bool,
    /// A sum of false and absent values, with no true one, is absent
    /// (otherwise 0).
    pub false_and_absent_sum_is_absent: bool,
}

impl Reading {
    /// The words `POLIS_SHADOW_READING` takes, one for each rule read the
    /// other way: `and-false`, `or-false`, `sum-absent`, comma-separated;
    /// unset or empty is the evaluator's own reading.
    pub fn parse(words: &str) -> Reading {
        let mut r = Reading::default();
        for word in words.split(',').map(str::trim).filter(|w| !w.is_empty()) {
            match word {
                "and-false" => r.false_and_absent_is_false = true,
                "or-false" => r.false_or_absent_is_false = true,
                "sum-absent" => r.false_and_absent_sum_is_absent = true,
                other => panic!(
                    "POLIS_SHADOW_READING: {other:?} is not one of and-false, or-false, sum-absent"
                ),
            }
        }
        r
    }

    /// The words that name this reading, as `parse` reads them.
    pub fn words(self) -> String {
        let mut w = vec![];
        if self.false_and_absent_is_false {
            w.push("and-false");
        }
        if self.false_or_absent_is_false {
            w.push("or-false");
        }
        if self.false_and_absent_sum_is_absent {
            w.push("sum-absent");
        }
        if w.is_empty() {
            "the evaluator's own".into()
        } else {
            w.join(",")
        }
    }
}

/// Every reading of the three unmeasured rules.
pub const READINGS: [Reading; 8] = {
    let mut all = [Reading {
        false_and_absent_is_false: false,
        false_or_absent_is_false: false,
        false_and_absent_sum_is_absent: false,
    }; 8];
    let mut i = 0;
    while i < 8 {
        all[i] = Reading {
            false_and_absent_is_false: (i & 4) != 0,
            false_or_absent_is_false: (i & 2) != 0,
            false_and_absent_sum_is_absent: (i & 1) != 0,
        };
        i += 1;
    }
    all
};

thread_local! {
    static READING: Cell<Option<Reading>> = const { Cell::new(None) };
}

/// The reading in force: the one `with_reading` set on this thread, else
/// `POLIS_SHADOW_READING`'s.
pub fn reading() -> Reading {
    READING.with(Cell::get).unwrap_or_else(|| {
        static FROM_ENV: std::sync::OnceLock<Reading> = std::sync::OnceLock::new();
        *FROM_ENV.get_or_init(|| {
            Reading::parse(&std::env::var("POLIS_SHADOW_READING").unwrap_or_default())
        })
    })
}

/// Runs `f` with the evaluator reading `r` on this thread.
pub fn with_reading<T>(r: Reading, f: impl FnOnce() -> T) -> T {
    let before = READING.with(|c| c.replace(Some(r)));
    let out = f();
    READING.with(|c| c.set(before));
    out
}

#[derive(Clone, Debug, PartialEq)]
pub enum V {
    Null,
    Num(f64),
    Str(String),
    Bool(bool),
}

pub type Line = BTreeMap<String, V>;

fn flatten(prefix: &str, value: &serde_json::Value, out: &mut Line) {
    match value {
        serde_json::Value::Object(map) => {
            for (k, v) in map {
                let key = if prefix.is_empty() {
                    k.clone()
                } else {
                    format!("{prefix}.{k}")
                };
                flatten(&key, v, out);
            }
        }
        serde_json::Value::Null => {
            out.insert(prefix.to_owned(), V::Null);
        }
        serde_json::Value::Bool(b) => {
            out.insert(prefix.to_owned(), V::Bool(*b));
        }
        serde_json::Value::Number(n) => {
            out.insert(prefix.to_owned(), V::Num(n.as_f64().unwrap_or(f64::NAN)));
        }
        // An empty string is not discovered as a field: production's mirror
        // row for a copy nginx answered itself, whose upstream status nginx
        // writes as "", came back with no `mirror_upstream_status` at all.
        serde_json::Value::String(s) if s.is_empty() => {}
        serde_json::Value::String(s) => {
            out.insert(prefix.to_owned(), V::Str(s.clone()));
        }
        serde_json::Value::Array(_) => {
            out.insert(prefix.to_owned(), V::Str(value.to_string()));
        }
    }
}

/// One fixture line: the JSON a producer writes, at an event time.
pub fn line(at_ms: i64, json: &str) -> Line {
    let value: serde_json::Value = serde_json::from_str(json).expect("fixture line is JSON");
    let mut out = Line::new();
    flatten("", &value, &mut out);
    out.insert("@timestamp".into(), V::Num(at_ms as f64));
    out
}

fn number(v: &V) -> Option<f64> {
    match v {
        V::Num(n) => Some(*n),
        V::Str(s) => s.trim().parse::<f64>().ok(),
        _ => None,
    }
}

/// Where an expression is read: Logs Insights reads an absent operand of
/// `and` and `or` one way in a `filter` and another in `fields` and `stats`.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Ctx {
    /// A `filter`: an absent operand is unknown; `or` with a true part is
    /// true and `and` with a false part false (the account keeps every Node
    /// access line its filters name, though the `or` beside it tests a
    /// field those lines do not carry).
    Filter,
    /// `fields` and `stats`: an `and` or `or` with an absent operand is
    /// absent, except where the reading in force says a false operand
    /// decides (`Reading`). Measured in production: inside `fields` and
    /// inside a sum, `outcome = "would_serve" or reason =
    /// "strict_moderation"` was absent on every would-serve line (they carry
    /// no `reason`), and true on the 20 lines that carry both. An `and` or an
    /// `or` with a false operand and an absent one was not measured.
    Value,
}

fn eval(e: &E, row: &Line, bounds: Bounds, ctx: Ctx) -> V {
    let eval = |e: &E| eval(e, row, bounds, ctx);
    match e {
        E::Field(name) => row.get(*name).cloned().unwrap_or(V::Null),
        E::Str(text) => V::Str((*text).to_owned()),
        E::Num(value) => V::Num(*value as f64),
        E::Decimal(value) => V::Num(*value),
        E::Param(param) => match (bounds, param) {
            (Bounds::Window { from_ms, .. }, Param::FromMs) => V::Num(from_ms as f64),
            (Bounds::Window { to_ms, .. }, Param::ToMs) => V::Num(to_ms as f64),
            (Bounds::Placeholders, _) => V::Null,
        },
        E::TimestampMs => row.get("@timestamp").cloned().unwrap_or(V::Null),
        E::Cmp(a, op, b) => {
            let (a, b) = (eval(a), eval(b));
            let ordering = match (&a, &b) {
                (V::Null, _) | (_, V::Null) => return V::Null,
                (V::Str(x), V::Str(y)) => x.partial_cmp(y),
                _ => match (number(&a), number(&b)) {
                    (Some(x), Some(y)) => x.partial_cmp(&y),
                    _ => return V::Null,
                },
            };
            let Some(ordering) = ordering else {
                return V::Null;
            };
            V::Bool(match op {
                Op::Eq => ordering.is_eq(),
                Op::Ne => !ordering.is_eq(),
                Op::Lt => ordering.is_lt(),
                Op::Ge => !ordering.is_lt(),
                Op::Gt => ordering.is_gt(),
            })
        }
        E::And(parts) | E::Or(parts) => {
            let and = matches!(e, E::And(_));
            let values: Vec<V> = parts.iter().map(eval).collect();
            let unknown = values.iter().any(|v| !matches!(v, V::Bool(_)));
            if unknown && ctx == Ctx::Value {
                // A true operand beside an absent one is absent (measured).
                // A false one beside an absent one decides only under the
                // readings that say so.
                let r = reading();
                let (has_false, has_true) = (
                    values.contains(&V::Bool(false)),
                    values.contains(&V::Bool(true)),
                );
                if has_false
                    && ((and && r.false_and_absent_is_false)
                        || (!and && !has_true && r.false_or_absent_is_false))
                {
                    return V::Bool(false);
                }
                return V::Null;
            }
            // In a filter, a deciding part decides; otherwise an unknown part
            // leaves the whole unknown.
            if values.contains(&V::Bool(!and)) {
                V::Bool(!and)
            } else if unknown {
                V::Null
            } else {
                V::Bool(and)
            }
        }
        E::In(field, values) => match row.get(*field) {
            Some(V::Str(s)) => V::Bool(values.contains(&s.as_str())),
            _ => V::Null,
        },
        E::Present(field) => V::Bool(!matches!(row.get(*field), None | Some(V::Null))),
        E::HasDigit(field) => match row.get(*field) {
            Some(V::Str(s)) => V::Bool(s.bytes().any(|b| b.is_ascii_digit())),
            Some(V::Num(_)) => V::Bool(true),
            _ => V::Null,
        },
    }
}

fn aggregate(agg: &Agg, rows: &[&Line], bounds: Bounds) -> V {
    match agg {
        Agg::Count => V::Num(rows.len() as f64),
        // A sum with no value on any of its lines is no value: production's
        // `sum()` of a condition that was absent on all 275 of a group's
        // lines came back with no field, where one false on all 20 of
        // another group's came back 0. A sum of false and absent values and
        // no true one was not measured: 0, or absent (`Reading`).
        Agg::Sum(e) => {
            let values: Vec<V> = rows
                .iter()
                .map(|row| eval(e, row, bounds, Ctx::Value))
                .collect();
            let trues = values.iter().filter(|v| **v == V::Bool(true)).count();
            if values.iter().all(|v| *v == V::Null)
                || (trues == 0
                    && values.contains(&V::Null)
                    && reading().false_and_absent_sum_is_absent)
            {
                V::Null
            } else {
                V::Num(trues as f64)
            }
        }
        Agg::Total(field) => {
            let values: Vec<f64> = rows
                .iter()
                .filter_map(|row| row.get(*field).and_then(number))
                .collect();
            if values.is_empty() {
                V::Null
            } else {
                V::Num(values.iter().sum())
            }
        }
        Agg::Max(field) => rows
            .iter()
            .filter_map(|row| row.get(*field).and_then(number))
            .fold(None, |m: Option<f64>, v| Some(m.map_or(v, |m| m.max(v))))
            .map_or(V::Null, V::Num),
        Agg::Min(field) => rows
            .iter()
            .filter_map(|row| row.get(*field).and_then(number))
            .fold(None, |m: Option<f64>, v| Some(m.map_or(v, |m| m.min(v))))
            .map_or(V::Null, V::Num),
        Agg::Pct(field, p) => {
            let mut values: Vec<f64> = rows
                .iter()
                .filter_map(|row| row.get(*field).and_then(number))
                .collect();
            if values.is_empty() {
                return V::Null;
            }
            values.sort_by(f64::total_cmp);
            let rank = ((f64::from(*p) / 100.0) * values.len() as f64).ceil() as usize;
            V::Num(values[rank.clamp(1, values.len()) - 1])
        }
        Agg::CountDistinct(field) => {
            let mut seen: Vec<String> = rows
                .iter()
                .filter_map(|row| match row.get(*field) {
                    None | Some(V::Null) => None,
                    Some(v) => Some(format!("{v:?}")),
                })
                .collect();
            seen.sort();
            seen.dedup();
            V::Num(seen.len() as f64)
        }
    }
}

fn key_text(v: &V) -> Option<String> {
    match v {
        V::Null => None,
        V::Num(n) => Some(cell(*n)),
        V::Str(s) => Some(s.clone()),
        V::Bool(b) => Some(b.to_string()),
    }
}

fn cell(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 1e15 {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    }
}

fn stage(stats: &Stats, rows: &[Line], bounds: Bounds) -> Vec<Line> {
    let mut groups: BTreeMap<Vec<Option<String>>, Vec<&Line>> = BTreeMap::new();
    for row in rows {
        let key = stats
            .by
            .iter()
            .map(|k| match k {
                Key::Field(name) => key_text(row.get(*name).unwrap_or(&V::Null)),
                Key::Hour | Key::FiveMinutes | Key::Day => {
                    let width = match k {
                        Key::Hour => 3600,
                        Key::Day => 86_400,
                        _ => 300,
                    };
                    row.get("@timestamp")
                        .and_then(number)
                        .map(|ms| crate::time::format((ms as i64).div_euclid(width * 1000) * width))
                }
            })
            .collect();
        groups.entry(key).or_default().push(row);
    }
    if stats.by.is_empty() && groups.is_empty() {
        groups.insert(vec![], vec![]);
    }
    groups
        .into_iter()
        .map(|(key, members)| {
            let mut out = Line::new();
            for (k, value) in stats.by.iter().zip(key) {
                let name = match k {
                    Key::Field(name) => (*name).to_owned(),
                    other => other.bin_name().unwrap_or_default().to_owned(),
                };
                out.insert(name, value.map(V::Str).unwrap_or(V::Null));
            }
            for (name, agg) in &stats.aggs {
                out.insert((*name).to_owned(), aggregate(agg, &members, bounds));
            }
            out
        })
        .collect()
}

/// Runs `q` over `lines` for a window, as `run` would issue it.
pub fn run(q: &Query, lines: &[Line], from_s: i64, to_s: i64) -> Vec<Row> {
    run_capped(q, lines, from_s, to_s, None)
}

/// `run`, in an account whose Logs Insights keeps at most `cap` rows of a
/// first stage before the second reads them. Whether a real account does is
/// not known; the tool is built so that it does not matter.
pub fn run_capped(
    q: &Query,
    lines: &[Line],
    from_s: i64,
    to_s: i64,
    cap: Option<usize>,
) -> Vec<Row> {
    let bounds = Bounds::Window {
        from_ms: from_s * 1000,
        to_ms: to_s * 1000,
    };
    let (start, end) = ((from_s - q.pad_s) * 1000, (to_s + q.pad_s) * 1000);
    let mut rows: Vec<Line> = lines
        .iter()
        .filter(|line| {
            line.get("@timestamp")
                .and_then(number)
                .is_some_and(|t| t >= start as f64 && t <= end as f64)
        })
        .filter(|line| eval(&q.filter, line, bounds, Ctx::Filter) == V::Bool(true))
        .cloned()
        .collect();
    for row in &mut rows {
        for (name, e) in &q.fields {
            let value = eval(e, row, bounds, Ctx::Value);
            row.insert((*name).to_owned(), value);
        }
    }
    for (i, stats) in q.stages.iter().enumerate() {
        rows = stage(stats, &rows, bounds);
        if let Some(cap) = cap
            && i + 1 < q.stages.len()
        {
            rows.truncate(cap);
        }
    }
    rows.into_iter()
        .take(ROW_LIMIT)
        .map(|row| {
            row.into_iter()
                .filter_map(|(k, v)| match v {
                    V::Null => None,
                    V::Num(n) => Some((k, cell(n))),
                    V::Str(s) => Some((k, s)),
                    V::Bool(b) => Some((k, b.to_string())),
                })
                .collect()
        })
        .collect()
}
