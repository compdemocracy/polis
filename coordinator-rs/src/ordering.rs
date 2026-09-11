//! The declared live source normalization, `polis-order/1`.
//!
//! Rev5 item 1: a live full-rebuild profile may declare the content
//! normalization `(tid,pid,created_ms,semantic_vote,weight)`, where
//! `semantic_vote = raw_vote * storage_agree_value`. The polarity constant is
//! therefore a **declared contract term**, not a literal spelled into one SQL
//! string: the coordinator builds its ORDER BY from these terms and ships the
//! same manifest to the worker, so both sides read one declaration. Ordering on
//! the raw sign instead would break the polarity property (P-023, D3).
use crate::store::digest;
use anyhow::Result;
use serde_json::{Value, json};

pub const SCHEMA: &str = "polis-order/1";
pub const PROFILE: &str = "live-tid-pid-created-semantic-value-weight/1";
/// Declared configuration input that carries the agree convention.
pub const PARAMETER: &str = "storage_agree_value";
/// The bind position `source()` gives `PARAMETER`; asserted by the query builder.
pub const PARAMETER_BINDING: &str = "$2";
pub const SEMANTIC_VOTE: &str = "raw_vote * storage_agree_value";

pub struct Term {
    pub name: &'static str,
    /// SQL over `votes`; only `PARAMETER_BINDING` may be a bound parameter.
    pub expression: &'static str,
    pub nulls: &'static str,
    pub source: &'static str,
}

pub const TERMS: &[Term] = &[
    Term {
        name: "tid",
        expression: "tid",
        nulls: "",
        source: "votes.tid",
    },
    Term {
        name: "pid",
        expression: "pid",
        nulls: "",
        source: "votes.pid",
    },
    Term {
        name: "created_ms",
        expression: "created",
        nulls: "",
        source: "votes.created",
    },
    Term {
        name: "semantic_vote",
        expression: "(vote::bigint*$2::bigint)",
        nulls: "",
        source: SEMANTIC_VOTE,
    },
    Term {
        name: "weight_x_32767",
        expression: "weight_x_32767",
        nulls: " NULLS FIRST",
        source: "votes.weight_x_32767",
    },
];

/// The declared ORDER BY, assembled from the terms above.
pub fn order_by() -> String {
    TERMS
        .iter()
        .map(|t| format!("{}{}", t.expression, t.nulls))
        .collect::<Vec<_>>()
        .join(",")
}

/// The terms whose only purpose is to break an otherwise ambiguous tie, i.e.
/// everything after the `(tid,pid,created_ms)` census key.
pub fn tiebreak_terms() -> Vec<&'static str> {
    TERMS.iter().skip(3).map(|t| t.name).collect()
}

fn algorithm(storage_agree_value: i64) -> Value {
    json!({"schema":SCHEMA,"profile":PROFILE,"parameter":PARAMETER,
        "storage_agree_value":storage_agree_value,"semantic_vote":SEMANTIC_VOTE,
        "terms":TERMS.iter().map(|t|json!({"name":t.name,"source":t.source,
            "nulls":if t.nulls.is_empty(){"default"}else{"first"}})).collect::<Vec<_>>(),
        "order_by":order_by()})
}

/// Pins the ordering algorithm; independent of any one conversation's data.
pub fn algorithm_digest(storage_agree_value: i64) -> Result<String> {
    Ok(digest(&serde_json::to_vec(&algorithm(storage_agree_value))?))
}

/// The declared normalization plus this conversation's `equal_time_census`.
/// This exact object is both the coordinator's ordering declaration and the
/// worker manifest's `ordering` value.
pub fn manifest(storage_agree_value: i64, census: Value) -> Result<Value> {
    let mut value = algorithm(storage_agree_value);
    value["algorithm_digest"] = json!(algorithm_digest(storage_agree_value)?);
    value["equal_time_census"] = census;
    Ok(value)
}

/// Rev5: record ambiguous tied maxima rather than silently resolving them.
/// A group is a set of rows sharing `(tid,pid,created_ms)` whose relative order
/// is decided only by the trailing tiebreak terms. `rows` must already be in
/// the declared order.
pub fn census(rows: &[Value]) -> Value {
    let key = |v: &Value| (v["tid"].clone(), v["pid"].clone(), v["created"].clone());
    let (mut groups, mut tied) = (0usize, 0usize);
    let mut index = 0usize;
    while index < rows.len() {
        let mut end = index + 1;
        while end < rows.len() && key(&rows[end]) == key(&rows[index]) {
            end += 1;
        }
        if end - index > 1 {
            groups += 1;
            tied += end - index;
        }
        index = end;
    }
    json!({"schema":"polis-census/1","key":["tid","pid","created_ms"],
        "resolved_by":tiebreak_terms(),"tied_groups":groups,"tied_rows":tied})
}
