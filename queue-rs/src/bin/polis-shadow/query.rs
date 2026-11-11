//! The compiled Logs Insights queries, as values. Each query is a filter, an
//! optional list of computed fields and one or two `stats` stages. A query is
//! rendered to Logs Insights text for `aws logs start-query`, and the tests
//! evaluate the same value over fixture lines (`eval.rs`), so the text that
//! runs in AWS and the logic the tests check are one thing.
//!
//! Nothing here accepts query text. The only values filled in at run time are
//! the window's two bounds, as integers.

/// A comparison operator.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Op {
    Eq,
    Ne,
    Lt,
    Ge,
    Gt,
}

impl Op {
    fn text(self) -> &'static str {
        match self {
            Op::Eq => "=",
            Op::Ne => "!=",
            Op::Lt => "<",
            Op::Ge => ">=",
            Op::Gt => ">",
        }
    }
}

/// A value the query fills in at run time.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Param {
    /// The window's start, epoch milliseconds.
    FromMs,
    /// The window's end (exclusive), epoch milliseconds.
    ToMs,
}

/// An expression. Field names are log fields or, after a `stats` stage, the
/// names that stage produced.
#[derive(Clone, Debug, PartialEq)]
pub enum E {
    Field(&'static str),
    Str(&'static str),
    Num(i64),
    Param(Param),
    Cmp(Box<E>, Op, Box<E>),
    And(Vec<E>),
    Or(Vec<E>),
    In(&'static str, Vec<&'static str>),
    Present(&'static str),
    /// `field like /[0-9]/`: the field holds at least one digit.
    HasDigit(&'static str),
    /// `toMillis(@timestamp)`.
    TimestampMs,
}

pub fn f(name: &'static str) -> E {
    E::Field(name)
}
pub fn s(text: &'static str) -> E {
    E::Str(text)
}
pub fn n(value: i64) -> E {
    E::Num(value)
}
pub fn eq(a: E, b: E) -> E {
    E::Cmp(Box::new(a), Op::Eq, Box::new(b))
}
pub fn ne(a: E, b: E) -> E {
    E::Cmp(Box::new(a), Op::Ne, Box::new(b))
}
pub fn lt(a: E, b: E) -> E {
    E::Cmp(Box::new(a), Op::Lt, Box::new(b))
}
pub fn ge(a: E, b: E) -> E {
    E::Cmp(Box::new(a), Op::Ge, Box::new(b))
}
pub fn gt(a: E, b: E) -> E {
    E::Cmp(Box::new(a), Op::Gt, Box::new(b))
}
/// `a and b and ...`, with nested conjunctions flattened into one.
pub fn and(parts: Vec<E>) -> E {
    let mut flat = vec![];
    for part in parts {
        match part {
            E::And(inner) => flat.extend(inner),
            other => flat.push(other),
        }
    }
    E::And(flat)
}
/// `a or b or ...`, with nested disjunctions flattened into one.
pub fn or(parts: Vec<E>) -> E {
    let mut flat = vec![];
    for part in parts {
        match part {
            E::Or(inner) => flat.extend(inner),
            other => flat.push(other),
        }
    }
    E::Or(flat)
}
/// `field = "text"`.
pub fn is(field: &'static str, text: &'static str) -> E {
    eq(f(field), s(text))
}
/// `field = number`.
pub fn num_is(field: &'static str, value: i64) -> E {
    eq(f(field), n(value))
}

/// An aggregation.
#[derive(Clone, Debug, PartialEq)]
pub enum Agg {
    /// `count(*)`.
    Count,
    /// `sum(<condition>)`: the number of lines (or first-stage rows) for which
    /// the condition holds.
    Sum(E),
    Max(&'static str),
    /// `min(field)`. Used for a request's earliest line time, which places a
    /// request id in exactly one slice of the window.
    Min(&'static str),
    /// `sum(field)` of a first-stage count: the total of those counts.
    Total(&'static str),
    /// `pct(field, p)`.
    Pct(&'static str, u8),
    CountDistinct(&'static str),
}

/// A `stats` group key.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Key {
    Field(&'static str),
    /// `bin(1h)`.
    Hour,
    /// `bin(5m)`: the request counts a run plans its join's slices from.
    FiveMinutes,
    /// `bin(1d)`: for a route too quiet for an hour to hold enough requests.
    Day,
}

impl Key {
    /// The name a time bin is returned under.
    pub fn bin_name(self) -> Option<&'static str> {
        match self {
            Key::Hour => Some("hour"),
            Key::FiveMinutes => Some("slot"),
            Key::Day => Some("day"),
            Key::Field(_) => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Stats {
    pub aggs: Vec<(&'static str, Agg)>,
    pub by: Vec<Key>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Query {
    pub name: &'static str,
    /// What the query is for, one line (printed by `queries`).
    pub about: &'static str,
    pub filter: E,
    /// Computed per line, after the filter.
    pub fields: Vec<(&'static str, E)>,
    /// One stage, or two (the first grouped by request id).
    pub stages: Vec<Stats>,
    /// How far the query's time range reaches beyond the window on each side,
    /// in seconds: a request's lines are written up to the shadow's readback
    /// retry (10 s) apart, so the join reads a little past both bounds and
    /// counts only requests whose nginx line falls inside the window.
    pub pad_s: i64,
    /// Also run over the same window a week earlier (the stop rule's
    /// baseline); its rows are stored as `<name>_previous`.
    pub previous_week: bool,
    /// Read over the stop rule's span (the last eight days of the window,
    /// `route::stop_span`) and not the whole window: the stop rule is about
    /// what the copy is doing to production now, not about the evidence.
    pub recent: bool,
    /// Run over consecutive pieces of the window of at most this many
    /// seconds, and the pieces' rows put together; 0 for a query run over
    /// the window in one piece. For a query whose rows are bins of time,
    /// which a long window has more of than Logs Insights returns.
    pub chunk_s: i64,
    /// Run once for each slice of the window and added up (`slices.rs`): a
    /// query whose first stage has one row for each request, so that no
    /// stage of it comes near the most rows Logs Insights handles. Its final
    /// stage holds counts only, which add.
    pub sliced: bool,
}

/// The window bounds a rendering fills in.
#[derive(Clone, Copy, Debug)]
pub enum Bounds {
    /// `<from_ms>` and `<to_ms>`, for printing.
    Placeholders,
    Window {
        from_ms: i64,
        to_ms: i64,
    },
}

fn quote(text: &str) -> String {
    // Every literal is a constant of this file or the route table; none holds
    // a quote or a backslash (the route test checks).
    format!("\"{text}\"")
}

fn render(e: &E, bounds: Bounds, out: &mut String) {
    match e {
        E::Field(name) => out.push_str(name),
        E::Str(text) => out.push_str(&quote(text)),
        E::Num(value) => out.push_str(&value.to_string()),
        E::Param(param) => match (bounds, param) {
            (Bounds::Placeholders, Param::FromMs) => out.push_str("<from_ms>"),
            (Bounds::Placeholders, Param::ToMs) => out.push_str("<to_ms>"),
            (Bounds::Window { from_ms, .. }, Param::FromMs) => out.push_str(&from_ms.to_string()),
            (Bounds::Window { to_ms, .. }, Param::ToMs) => out.push_str(&to_ms.to_string()),
        },
        E::Cmp(a, op, b) => {
            render(a, bounds, out);
            out.push(' ');
            out.push_str(op.text());
            out.push(' ');
            render(b, bounds, out);
        }
        E::And(parts) | E::Or(parts) => {
            let joiner = if matches!(e, E::And(_)) {
                " and "
            } else {
                " or "
            };
            for (i, part) in parts.iter().enumerate() {
                if i > 0 {
                    out.push_str(joiner);
                }
                let nested = matches!(part, E::And(_) | E::Or(_));
                if nested {
                    out.push('(');
                }
                render(part, bounds, out);
                if nested {
                    out.push(')');
                }
            }
        }
        E::In(field, values) => {
            out.push_str(field);
            out.push_str(" in [");
            for (i, value) in values.iter().enumerate() {
                if i > 0 {
                    out.push_str(", ");
                }
                out.push_str(&quote(value));
            }
            out.push(']');
        }
        E::Present(field) => {
            out.push_str("ispresent(");
            out.push_str(field);
            out.push(')');
        }
        E::HasDigit(field) => {
            out.push_str(field);
            out.push_str(" like /[0-9]/");
        }
        E::TimestampMs => out.push_str("toMillis(@timestamp)"),
    }
}

pub fn expr_text(e: &E, bounds: Bounds) -> String {
    let mut out = String::new();
    render(e, bounds, &mut out);
    out
}

fn agg_text(agg: &Agg, bounds: Bounds) -> String {
    match agg {
        Agg::Count => "count(*)".into(),
        Agg::Sum(e) => format!("sum({})", expr_text(e, bounds)),
        Agg::Max(field) => format!("max({field})"),
        Agg::Min(field) => format!("min({field})"),
        Agg::Total(field) => format!("sum({field})"),
        Agg::Pct(field, p) => format!("pct({field}, {p})"),
        Agg::CountDistinct(field) => format!("count_distinct({field})"),
    }
}

impl Query {
    /// The Logs Insights text, one command per line.
    pub fn text(&self, bounds: Bounds) -> String {
        let mut lines = vec![format!("filter {}", expr_text(&self.filter, bounds))];
        if !self.fields.is_empty() {
            let fields: Vec<String> = self
                .fields
                .iter()
                .map(|(name, e)| format!("{} as {name}", expr_text(e, bounds)))
                .collect();
            lines.push(format!("| fields {}", fields.join(", ")));
        }
        for stage in &self.stages {
            let aggs: Vec<String> = stage
                .aggs
                .iter()
                .map(|(name, agg)| format!("{} as {name}", agg_text(agg, bounds)))
                .collect();
            let mut line = format!("| stats {}", aggs.join(", "));
            if !stage.by.is_empty() {
                let keys: Vec<String> = stage
                    .by
                    .iter()
                    .map(|key| match key {
                        Key::Field(name) => (*name).to_owned(),
                        Key::Hour => "bin(1h) as hour".to_owned(),
                        Key::FiveMinutes => "bin(5m) as slot".to_owned(),
                        Key::Day => "bin(1d) as day".to_owned(),
                    })
                    .collect();
                line.push_str(" by ");
                line.push_str(&keys.join(", "));
            }
            lines.push(line);
        }
        // Logs Insights returns 1,000 rows unless told otherwise; 10,000 is
        // its most. A result that reaches it is treated as cut off.
        lines.push(format!("| limit {}", crate::route::ROW_LIMIT));
        lines.join("\n")
    }

    pub fn two_stage(&self) -> bool {
        self.stages.len() == 2
    }

    /// The final stage's group keys, by the names its rows carry them under.
    pub fn final_keys(&self) -> Vec<&'static str> {
        self.stages
            .last()
            .map(|stage| {
                stage
                    .by
                    .iter()
                    .map(|key| match key {
                        Key::Field(name) => *name,
                        other => other.bin_name().unwrap_or(""),
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Whether every value of the final stage is a count, so that the rows
    /// of two disjoint slices of the window add up to the rows of both.
    pub fn additive(&self) -> bool {
        self.stages.last().is_some_and(|stage| {
            stage
                .aggs
                .iter()
                .all(|(_, agg)| matches!(agg, Agg::Count | Agg::Sum(_) | Agg::Total(_)))
        })
    }
}

/// Fields a final `stats ... by` may group on: classes and statuses. Never a
/// request id, a participant, a statement, a vote, a token or text.
pub const GROUP_ALLOWLIST: &[&str] = &[
    "message",
    "zid",
    "weights_tick",
    "outcome",
    "reason",
    "status",
    "edge_status",
    "node_status",
    "http.status_code",
    "node_next",
    "mirror_status",
    "mirror_upstream_status",
    "follow_on",
    "node_vote",
    "prev",
    "admitted",
    // The comment observer's classes: each a boolean or a word from a closed
    // set (docs/post-comments-rust-handler.md, "Observe mode").
    "strict",
    "vote_present",
    "seed_present",
    "body_class",
    "text_row",
    "node_comment",
    "node_txt",
    "node_txt_difference",
    "node_author",
    "node_row",
    "node_lang",
];

/// Fields a final stage may take a maximum or a percentile of: durations.
/// (A maximum of anything else, a conversation number say, would return one
/// conversation's number.)
pub const MEASURE_ALLOWLIST: &[&str] = &[
    "mirror_s",
    "edge_upstream_s",
    "edge_request_s",
    "queue_ms",
    "admission_ms",
    "selection_ms",
    "total_ms",
    "readback_s",
    "duration_ms",
];

/// Names that may never leave AWS in any form a query returns. The statement
/// numbers are here because one beside a conversation number and a time picks
/// out a row of that conversation's public votes: `tid` and `next_tid` are no
/// longer on the shadow's line, and Node's `node_next_tid` is never read.
pub const NEVER: &[&str] = &[
    "request_id",
    "pid",
    "uid",
    "tid",
    "next_tid",
    "node_next_tid",
    "vote",
    "txt",
    "xid",
    "token",
    "authorization",
    "useragent",
    "network.client.ip",
    "http.url",
    // The comment observer prints a text's lengths beside a stored text that
    // differs. An exact length picks a comment out of a conversation's public
    // list, so no query may bring one out.
    "txt_units",
    "node_txt_units",
    "txt_bytes",
    "node_txt_bytes",
];

/// Why a query may not run, or None. The rule: the first of two stages groups
/// by `request_id` alone, and never leaves AWS; every final group key is an
/// allowlisted field (in a two-stage query, a first-stage maximum of one, or a
/// first-stage count); every final maximum or percentile is of a duration;
/// and no expression anywhere in a final stage names a field in `NEVER`.
pub fn refusal(q: &Query) -> Option<String> {
    if let Some(why) = clash(q) {
        return Some(why);
    }
    if let Some(why) = single_access_spelling(q) {
        return Some(why);
    }
    let (first, last) = match q.stages.as_slice() {
        [only] => (None, only),
        [first, last] => (Some(first), last),
        _ => return Some(format!("{}: one or two stats stages", q.name)),
    };
    if let Some(first) = first
        && first.by != [Key::Field("request_id")]
    {
        return Some(format!(
            "{}: a first stage groups by request_id alone",
            q.name
        ));
    }
    // What a final-stage name means: a log field (one stage) or a first-stage
    // output (two stages).
    let source = |name: &'static str| -> Result<Option<&'static str>, String> {
        match first {
            None => Ok(Some(name)),
            Some(first) => match first.aggs.iter().find(|(out, _)| *out == name) {
                Some((_, Agg::Max(field) | Agg::Min(field))) => Ok(Some(*field)),
                Some((_, Agg::Sum(_) | Agg::Count | Agg::Total(_))) => Ok(None),
                Some((_, other)) => Err(format!(
                    "{}: final stage uses {name}, a first-stage {other:?}",
                    q.name
                )),
                None => Err(format!("{}: {name} is not a first-stage output", q.name)),
            },
        }
    };
    for key in &last.by {
        let Key::Field(name) = key else { continue };
        match source(name) {
            Err(why) => return Some(why),
            Ok(Some(field)) if !GROUP_ALLOWLIST.contains(&field) => {
                return Some(format!(
                    "{}: groups by {name} ({field}), not allowlisted",
                    q.name
                ));
            }
            Ok(_) => {}
        }
    }
    for (out, agg) in &last.aggs {
        match agg {
            Agg::Count | Agg::CountDistinct(_) => {}
            // Only a total of first-stage counts: a sum of a log field (a
            // vote, say) is a value, not a count.
            Agg::Total(field) => {
                if first.is_none() || !matches!(source(field), Ok(None)) {
                    return Some(format!(
                        "{}: {out} totals {field}, which is not a first-stage count",
                        q.name
                    ));
                }
            }
            Agg::Max(field) | Agg::Min(field) | Agg::Pct(field, _) => match source(field) {
                Ok(Some(f)) if MEASURE_ALLOWLIST.contains(&f) => {}
                _ => {
                    return Some(format!(
                        "{}: {out} takes {field}, which is not a duration",
                        q.name
                    ));
                }
            },
            Agg::Sum(e) => {
                for name in names(e) {
                    match source(name) {
                        Err(why) => return Some(why),
                        Ok(Some(field)) if NEVER.contains(&field) || NEVER.contains(&name) => {
                            return Some(format!("{}: {out} reads {field}", q.name));
                        }
                        Ok(_) => {}
                    }
                }
            }
        }
    }
    None
}

/// Node's access line: winston appends the meta's `message` to the message
/// argument (winston 3 `logger.js`), so production writes
/// `"message":"http_request http_request"`. A query that tests `message`
/// against the single spelling alone would never match it.
pub const ACCESS_LINE: [&str; 2] = ["http_request", "http_request http_request"];

fn single_access_spelling(q: &Query) -> Option<String> {
    fn bad(e: &E) -> bool {
        match e {
            E::Cmp(a, _, b) => {
                matches!((&**a, &**b), (E::Field("message"), E::Str("http_request")))
                    || matches!((&**a, &**b), (E::Str("http_request"), E::Field("message")))
                    || bad(a)
                    || bad(b)
            }
            E::In("message", values) => {
                values.contains(&"http_request") && !values.contains(&ACCESS_LINE[1])
            }
            E::And(parts) | E::Or(parts) => parts.iter().any(bad),
            _ => false,
        }
    }
    let mut exprs = vec![&q.filter];
    exprs.extend(q.fields.iter().map(|(_, e)| e));
    for stage in &q.stages {
        for (_, agg) in &stage.aggs {
            if let Agg::Sum(e) = agg {
                exprs.push(e);
            }
        }
    }
    exprs.into_iter().any(bad).then(|| {
        format!(
            "{}: matches Node's access line by its single spelling; production writes \"http_request http_request\"",
            q.name
        )
    })
}

/// A name defined twice, or defined after something earlier in the query
/// reads it: Logs Insights refuses such a query ("Cycle found in operation
/// dependency graph"), so the tests refuse it first.
fn clash(q: &Query) -> Option<String> {
    let mut seen: Vec<&'static str> = names(&q.filter);
    let define = |defined: &'static str, seen: &mut Vec<&'static str>| {
        if seen.contains(&defined) {
            Some(format!(
                "{}: {defined} is defined after it is read or defined",
                q.name
            ))
        } else {
            seen.push(defined);
            None
        }
    };
    for (name, e) in &q.fields {
        seen.extend(names(e));
        if let Some(why) = define(name, &mut seen) {
            return Some(why);
        }
    }
    for stage in &q.stages {
        // Everything a stage reads comes before what it defines.
        for (_, agg) in &stage.aggs {
            match agg {
                Agg::Count => {}
                Agg::Sum(e) => seen.extend(names(e)),
                Agg::Max(f)
                | Agg::Min(f)
                | Agg::Total(f)
                | Agg::Pct(f, _)
                | Agg::CountDistinct(f) => seen.push(f),
            }
        }
        for key in &stage.by {
            if let Key::Field(f) = key {
                seen.push(f);
            }
        }
        for (name, _) in &stage.aggs {
            if let Some(why) = define(name, &mut seen) {
                return Some(why);
            }
        }
        for key in &stage.by {
            if let Some(name) = key.bin_name()
                && let Some(why) = define(name, &mut seen)
            {
                return Some(why);
            }
        }
    }
    None
}

/// Every field name an expression reads.
pub fn names(e: &E) -> Vec<&'static str> {
    let mut out = vec![];
    fn walk(e: &E, out: &mut Vec<&'static str>) {
        match e {
            E::Field(name) | E::Present(name) | E::HasDigit(name) | E::In(name, _) => {
                out.push(*name)
            }
            E::Cmp(a, _, b) => {
                walk(a, out);
                walk(b, out);
            }
            E::And(parts) | E::Or(parts) => parts.iter().for_each(|p| walk(p, out)),
            E::Str(_) | E::Num(_) | E::Param(_) | E::TimestampMs => {}
        }
    }
    walk(e, &mut out);
    out
}

/// Every string literal an expression holds.
#[cfg(test)]
pub fn literals(e: &E) -> Vec<&'static str> {
    let mut out = vec![];
    fn walk(e: &E, out: &mut Vec<&'static str>) {
        match e {
            E::Str(text) => out.push(*text),
            E::In(_, values) => out.extend(values.iter().copied()),
            E::Cmp(a, _, b) => {
                walk(a, out);
                walk(b, out);
            }
            E::And(parts) | E::Or(parts) => parts.iter().for_each(|p| walk(p, out)),
            _ => {}
        }
    }
    walk(e, &mut out);
    out
}
