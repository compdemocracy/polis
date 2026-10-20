//! Descriptive statistics of the served opinion-group tallies, not raw vote records.
use crate::{profiles, public_client, public_id, str_arg};
use clap::ArgMatches;
use polis_client::Client;
use polis_contracts::{statement_importance::Response, Error, Result};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

const MAX_ROWS: usize = 10_000;
const SAFE: u64 = 9_007_199_254_740_991;
fn invalid() -> Error {
    Error::new("invalid_comment_stats", "The site returned incomplete or incompatible comment statistics.", "No partial ranking was printed. Check the math counts and participant-visible comment pages with the operator.", 1)
}
fn bound() -> Error {
    Error::new("comment_stats_limit", "The comment statistics exceed this command's read bounds.", "Use math view and comment list to inspect the bounded source pages separately; no partial ranking was printed.", 1)
}
fn count(v: &Value) -> Result<u64> {
    v.as_u64().filter(|n| *n <= SAFE).ok_or_else(invalid)
}
fn tid(s: &str) -> Result<u32> {
    s.parse::<u32>()
        .ok()
        .filter(|n| *n <= i32::MAX as u32 && n.to_string() == s)
        .ok_or_else(invalid)
}
#[derive(Clone, Copy, Default)]
struct Counts {
    agree: u64,
    disagree: u64,
    seen: u64,
}
impl Counts {
    fn parse(v: &Value) -> Result<Self> {
        let c = Self {
            agree: count(&v["A"])?,
            disagree: count(&v["D"])?,
            seen: count(&v["S"])?,
        };
        if c.agree + c.disagree > c.seen {
            return Err(invalid());
        }
        Ok(c)
    }
    fn add(self, other: Self) -> Result<Self> {
        let c = Self {
            agree: self.agree + other.agree,
            disagree: self.disagree + other.disagree,
            seen: self.seen + other.seen,
        };
        if c.seen > SAFE {
            return Err(invalid());
        }
        Ok(c)
    }
    fn value(self) -> Value {
        let pct = |n| {
            if self.seen == 0 {
                None
            } else {
                Some(100.0 * n as f64 / self.seen as f64)
            }
        };
        let polar = self.agree + self.disagree;
        json!({"votes":self.seen,"agree":self.agree,"disagree":self.disagree,"pass":self.seen-self.agree-self.disagree,
            "agree_pct":pct(self.agree),"disagree_pct":pct(self.disagree),"pass_pct":pct(self.seen-self.agree-self.disagree),
            "divisiveness":if polar==0 { None } else { Some(1.0-self.agree.abs_diff(self.disagree) as f64/polar as f64) }})
    }
}
fn unknown() -> Value {
    json!({"votes":null,"agree":null,"disagree":null,"pass":null,"agree_pct":null,"disagree_pct":null,"pass_pct":null,"divisiveness":null})
}
fn read(
    c: &Client,
    reads: &mut Vec<Value>,
    path: &str,
    query: &[(String, String)],
    math: bool,
) -> Result<Value> {
    let bytes = if math {
        c.math_presentation_bytes(query)?
    } else {
        c.operation_bytes("GET", path, query, None, false)?
    };
    let text = String::from_utf8(bytes).map_err(|_| invalid())?;
    let used: usize = reads
        .iter()
        .map(|r| r["body"].as_str().unwrap().len())
        .sum();
    if used + text.len() > 32 * 1024 * 1024 {
        return Err(bound());
    }
    let value = serde_json::from_str(&text).map_err(|_| invalid())?;
    reads.push(json!({"path":path,"query":query,"body":text}));
    Ok(value)
}

pub fn execute(
    m: &ArgMatches,
    config: &profiles::Config,
    site: &str,
    timeout: u64,
) -> Result<Value> {
    let cid = str_arg(m, "conversation");
    public_id(cid)?; // Before even optional credential access.
    let sort = str_arg(m, "sort");
    let c = public_client(config, site, timeout)?;
    let mut reads = Vec::new();
    let math = read(
        &c,
        &mut reads,
        "/api/v3/math/pca2",
        &[("conversation_id".into(), cid.into())],
        true,
    )?;
    count(&math["math_tick"])?;
    let groups = math
        .get("group-votes")
        .and_then(Value::as_object)
        .ok_or_else(invalid)?;
    if groups.len() > 1000 {
        return Err(bound());
    }
    let mut tallies = BTreeMap::new();
    let mut math_tids = BTreeSet::new();
    for (gid, group) in groups {
        if gid.is_empty() || gid.len() > 100 {
            return Err(invalid());
        }
        let mut votes = BTreeMap::new();
        for (id, counts) in group["votes"].as_object().ok_or_else(invalid)? {
            let id = tid(id)?;
            math_tids.insert(id);
            if math_tids.len() > MAX_ROWS {
                return Err(bound());
            }
            votes.insert(id, Counts::parse(counts)?);
        }
        tallies.insert(gid.clone(), votes);
    }
    let mut texts = BTreeMap::new();
    let mut offset = 0;
    loop {
        let page = read(
            &c,
            &mut reads,
            "/api/v3/comments",
            &[
                ("conversation_id".into(), cid.into()),
                ("limit".into(), "500".into()),
                ("offset".into(), offset.to_string()),
            ],
            false,
        )?;
        let rows = page["comments"].as_array().ok_or_else(invalid)?;
        let more = page["pagination"]["hasMore"]
            .as_bool()
            .ok_or_else(invalid)?;
        if rows.len() > 500 || (more && rows.is_empty()) {
            return Err(invalid());
        }
        for row in rows {
            let id = row["tid"]
                .as_u64()
                .filter(|n| *n <= i32::MAX as u64)
                .ok_or_else(invalid)? as u32;
            let text = row["txt"].as_str().ok_or_else(invalid)?;
            if texts.insert(id, text.to_owned()).is_some() {
                return Err(invalid());
            }
        }
        if texts.len() > MAX_ROWS {
            return Err(bound());
        }
        offset += rows.len();
        if !more {
            break;
        }
        if offset >= MAX_ROWS {
            return Err(bound());
        }
    }
    if tallies.len().saturating_mul(texts.len()) > 100_000 {
        return Err(bound());
    }
    let mut notes=vec!["Counts cover only the served opinion groups, not all participants or raw vote records. Math, comment pages and current importance are separate reads, not a frozen snapshot.".to_owned(),
        "Consensus is the lowest agree percentage across every group; it is unknown if any group has no observed votes. It is not the engine's consensus score or a significance test.".to_owned(),
        "Unknown math totals (missing in any group), percentages with no votes, and divisiveness with no agree/disagree votes are null. Small samples can rank highly; inspect vote counts.".to_owned()];
    notes.push(
        "Importance fields absent from the current count snapshot are omitted, never assumed zero."
            .into(),
    );
    if tallies.is_empty() {
        notes.push(
            "The served math has no opinion groups yet (for example, a conversation with no votes), so every statistic is unknown."
                .into(),
        );
    }
    // Preserve exact decoded source JSON inside a string, including whitespace,
    // key order and number spellings. Rendering escapes terminal controls only.
    let importance = match read(
        &c,
        &mut reads,
        polis_contracts::statement_importance::PATH,
        &[("conversation_id".into(), cid.into())],
        false,
    ) {
        Ok(v) => {
            let counts: Response = serde_json::from_value(v).map_err(|_| invalid())?;
            if !counts.valid_for(cid) {
                return Err(invalid());
            }
            Some(counts)
        }
        Err(e) => {
            if e.code == "comment_stats_limit" {
                return Err(e);
            }
            notes.push(format!(
                "Importance unavailable [{}]; important fields are omitted, never assumed zero.",
                e.code
            ));
            eprintln!("polis: {}", notes.last().unwrap());
            None
        }
    };
    if sort == "important" && importance.is_none() {
        return Err(Error::new("importance_unavailable","Cannot rank comments by unavailable importance counts.","Use another sort, or ask the operator to enable the importance read. No partial ranking was printed.",8));
    }
    let counts: BTreeMap<_, _> = importance
        .as_ref()
        .map(|c| {
            c.statements
                .iter()
                .map(|s| (s.tid as u32, s.important))
                .collect()
        })
        .unwrap_or_default();
    let mut rows = Vec::new();
    for (id, text) in &texts {
        let mut total = Counts::default();
        let mut complete = !tallies.is_empty();
        let mut consensus = Some(100.0f64);
        let mut by_group = Vec::new();
        for (gid, votes) in &tallies {
            let mut group = if let Some(counts) = votes.get(id) {
                total = total.add(*counts)?;
                if counts.seen == 0 {
                    consensus = None;
                } else {
                    consensus =
                        consensus.map(|n| n.min(100.0 * counts.agree as f64 / counts.seen as f64));
                }
                counts.value()
            } else {
                complete = false;
                consensus = None;
                unknown()
            };
            group["group_id"] = json!(gid);
            if m.get_flag("by-group") {
                by_group.push(group);
            }
        }
        let mut row = if complete { total.value() } else { unknown() };
        row["tid"] = json!(id);
        row["text"] = json!(text);
        row["consensus"] = json!(if complete { consensus } else { None });
        if let Some(important) = counts.get(id) {
            row["important"] = json!(important);
        }
        if m.get_flag("by-group") {
            row["groups"] = json!(by_group);
        }
        rows.push(row);
    }
    let field = match sort {
        "agree" => "agree_pct",
        "disagree" => "disagree_pct",
        "pass" => "pass_pct",
        "divisive" => "divisiveness",
        other => other,
    };
    rows.sort_by(|a, b| match (a[field].as_f64(), b[field].as_f64()) {
        (Some(x), Some(y)) => y
            .total_cmp(&x)
            .then(a["tid"].as_u64().cmp(&b["tid"].as_u64())),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => a["tid"].as_u64().cmp(&b["tid"].as_u64()),
    });
    let hidden = math_tids
        .iter()
        .filter(|id| !texts.contains_key(id))
        .count();
    if hidden > 0 {
        notes.push(format!("{hidden} math comment IDs were absent from the participant-visible text pages and are excluded from this ranking."));
    }
    Ok(
        json!({"schema":"comment-stats/1","conversation_id":cid,"math_tick":math["math_tick"],"sort":sort,"order":"descending_unknown_last_tid_ascending",
        "comments":rows,"importance":{"state":if importance.is_some(){"observed"}else{"unavailable"},"read_at_ms":importance.map(|c|c.read_at_ms)},"notes":notes,"reads":reads}),
    )
}
fn number(v: &Value) -> String {
    v.as_f64().map_or_else(|| "-".into(), |n| format!("{n:.1}"))
}
fn whole(v: &Value) -> String {
    v.as_u64().map_or_else(|| "-".into(), |n| n.to_string())
}
pub fn text(v: &Value) -> String {
    let mut out=format!("Comment statistics (math tick {})\nTID  VOTES  AGREE%  DISAGREE%  PASS%  DIVISIVE  CONSENSUS%  IMPORTANT  TEXT\n",v["math_tick"]);
    for row in v["comments"].as_array().unwrap() {
        let clean = crate::listing::terminal_text(row["text"].as_str().unwrap());
        let flat = clean.split_whitespace().collect::<Vec<_>>().join(" ");
        let mut short = flat.chars().take(72).collect::<String>();
        if flat.chars().count() > 72 {
            short.push('…');
        }
        out.push_str(&format!(
            "{}  {}  {}  {}  {}  {}  {}  {}  {}\n",
            row["tid"],
            whole(&row["votes"]),
            number(&row["agree_pct"]),
            number(&row["disagree_pct"]),
            number(&row["pass_pct"]),
            number(&row["divisiveness"]),
            number(&row["consensus"]),
            whole(&row["important"]),
            short
        ));
        if let Some(groups) = row["groups"].as_array() {
            for g in groups {
                out.push_str(&format!(
                    "  group {}: votes {}, agree {}%, disagree {}%, pass {}%, divisiveness {}\n",
                    g["group_id"].as_str().unwrap(),
                    whole(&g["votes"]),
                    number(&g["agree_pct"]),
                    number(&g["disagree_pct"]),
                    number(&g["pass_pct"]),
                    number(&g["divisiveness"])
                ));
            }
        }
    }
    for note in v["notes"].as_array().unwrap() {
        out.push_str(&format!("\n{}\n", note.as_str().unwrap()));
    }
    out
}
