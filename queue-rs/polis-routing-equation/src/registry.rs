//! The rules by name and version, their documentation, and the canonical plain
//! form of a parameter set.
//!
//! A published rule's numbers never change: a new formula or a new default is
//! a new version. Running another allowed parameter set is not a new rule; it
//! is the rule plus its complete canonical parameter form.

use crate::historical::HistoricalParams;
use crate::types::Refusal;
use serde::Serialize;
use serde_json::{Map, Value};

/// Every rule this crate holds. A closed set: a name not listed is refused,
/// never answered with a default.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum RuleId {
    Historical1,
    StoredWeights1,
}

impl RuleId {
    pub const ALL: [RuleId; 2] = [RuleId::Historical1, RuleId::StoredWeights1];

    /// The rule's `name/version`.
    pub fn name(self) -> &'static str {
        match self {
            Self::Historical1 => "historical/1",
            Self::StoredWeights1 => "stored-weights/1",
        }
    }
}

impl Serialize for RuleId {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(self.name())
    }
}

/// Asks for a rule by its `name/version`, for example `historical/1`.
pub fn lookup(asked: &str) -> Result<RuleId, Refusal> {
    RuleId::ALL
        .iter()
        .copied()
        .find(|r| r.name() == asked)
        .ok_or_else(|| Refusal::UnknownRule {
            asked: asked.to_string(),
            known: RuleId::ALL.iter().map(|r| r.name()).collect(),
        })
}

/// One parameter, as the README's tables show it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ParamDoc {
    pub name: &'static str,
    pub default: &'static str,
    pub allowed: &'static str,
    pub meaning: &'static str,
    pub source: &'static str,
}

/// A rule's documentation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RuleDoc {
    pub rule: RuleId,
    pub summary: &'static str,
    pub formula: &'static str,
    pub params: &'static [ParamDoc],
}

const HISTORICAL_PARAMS: [ParamDoc; 8] = [
    ParamDoc {
        name: "agree_prior",
        default: "1",
        allowed: "[1e-3, 1000], and at most `seen_prior`",
        meaning: "added to the agrees in the agree share",
        source: "`conversation.py`, `importance_metric`: `(A + 1)`",
    },
    ParamDoc {
        name: "pass_prior",
        default: "1",
        allowed: "[1e-3, 1000], and `seen_prior - pass_prior` at least 1e-3",
        meaning: "added to the passes in the pass share",
        source: "`importance_metric`: `(P + 1)`",
    },
    ParamDoc {
        name: "seen_prior",
        default: "2",
        allowed: "[1e-3, 1000]",
        meaning: "added to the votes seen in both shares",
        source: "`importance_metric`: `(S + 2)`",
    },
    ParamDoc {
        name: "extremity_offset",
        default: "1",
        allowed: "[1e-3, 100]",
        meaning: "added to the extremity, so a comment at the centre still counts",
        source: "`importance_metric`: `(E + 1)`",
    },
    ParamDoc {
        name: "novelty_amplitude",
        default: "8",
        allowed: "[0, 1000]",
        meaning: "how much larger a comment with no votes is made",
        source: "`priority_metric`: `1 + 8 * (2 ** (-S / 5))`",
    },
    ParamDoc {
        name: "novelty_halving_votes",
        default: "5",
        allowed: "[1e-3, 1e6]",
        meaning: "votes seen after which the novelty boost has halved",
        source: "`priority_metric`: `-S / 5`",
    },
    ParamDoc {
        name: "exponent",
        default: "2",
        allowed: "an integer from 1 to 4",
        meaning: "the power the product is raised to",
        source: "`priority_metric`: `inner ** 2`",
    },
    ParamDoc {
        name: "meta_inner",
        default: "7",
        allowed: "[1e-3, 1e6]",
        meaning: "a meta comment's value before the power (\"TODO TUNE\" in the source)",
        source: "`META_PRIORITY = 7`",
    },
];

/// The documentation of a rule: summary, formula and every parameter.
pub fn describe(rule: RuleId) -> RuleDoc {
    match rule {
        RuleId::Historical1 => RuleDoc {
            rule,
            summary: "Today's comment routing equation: the weight the math engine gives each comment.",
            formula: "p = (P + pass_prior) / (S + seen_prior); a = (A + agree_prior) / (S + seen_prior); \
                      weight = ((1 - p) * (E + extremity_offset) * a * (1 + novelty_amplitude * 2^(-S / novelty_halving_votes)))^exponent; \
                      a meta comment weighs meta_inner^exponent",
            params: &HISTORICAL_PARAMS,
        },
        RuleId::StoredWeights1 => RuleDoc {
            rule,
            summary: "Today's draw: one comment drawn with chance proportional to its stored weight.",
            formula: "draw weight = stored weight, with absent, null, false and 0 read as 1; \
                      chosen = the first candidate whose running sum is greater than unit x total",
            params: &[],
        },
    }
}

/// A rule's parameter table in Markdown, as the README shows it.
pub fn params_table(rule: RuleId) -> String {
    let doc = describe(rule);
    if doc.params.is_empty() {
        return "This rule has no parameters.\n".to_string();
    }
    let mut out =
        String::from("| Name | Default | Allowed | Meaning | Source |\n|---|---|---|---|---|\n");
    for p in doc.params {
        out.push_str(&format!(
            "| `{}` | {} | {} | {} | {} |\n",
            p.name, p.default, p.allowed, p.meaning, p.source
        ));
    }
    out
}

/// A rule together with a complete, validated parameter set.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ParamSet {
    Historical1(HistoricalParams),
    StoredWeights1,
}

const HISTORICAL_KEYS: [&str; 8] = [
    "agree_prior",
    "pass_prior",
    "seen_prior",
    "extremity_offset",
    "novelty_amplitude",
    "novelty_halving_votes",
    "exponent",
    "meta_inner",
];

pub(crate) fn number(x: f64) -> String {
    serde_json::Number::from_f64(x).map_or_else(String::new, |n| n.to_string())
}

pub(crate) fn exact_keys(
    object: &Map<String, Value>,
    keys: &[&str],
    what: &str,
) -> Result<(), Refusal> {
    if let Some(unknown) = object.keys().find(|k| !keys.contains(&k.as_str())) {
        return Err(Refusal::Plain(format!("unknown key {unknown:?} in {what}")));
    }
    if let Some(missing) = keys.iter().find(|k| !object.contains_key(**k)) {
        return Err(Refusal::Plain(format!("missing key {missing:?} in {what}")));
    }
    Ok(())
}

impl ParamSet {
    /// The published defaults of a rule.
    pub fn default_for(rule: RuleId) -> Self {
        match rule {
            RuleId::Historical1 => Self::Historical1(HistoricalParams::default()),
            RuleId::StoredWeights1 => Self::StoredWeights1,
        }
    }

    pub fn rule(&self) -> RuleId {
        match self {
            Self::Historical1(_) => RuleId::Historical1,
            Self::StoredWeights1 => RuleId::StoredWeights1,
        }
    }

    pub fn is_default(&self) -> bool {
        *self == Self::default_for(self.rule())
    }

    /// The canonical plain form: JSON with `rule`, then `params` in
    /// declaration order, then `terms`; every parameter written out; floats in
    /// Rust's shortest form that reads back to the same double.
    pub fn to_plain(&self) -> String {
        match self {
            Self::Historical1(p) => format!(
                "{{\"rule\":\"historical/1\",\"params\":{{\"agree_prior\":{},\"pass_prior\":{},\"seen_prior\":{},\"extremity_offset\":{},\"novelty_amplitude\":{},\"novelty_halving_votes\":{},\"exponent\":{},\"meta_inner\":{}}},\"terms\":[]}}",
                number(p.agree_prior()),
                number(p.pass_prior()),
                number(p.seen_prior()),
                number(p.extremity_offset()),
                number(p.novelty_amplitude()),
                number(p.novelty_halving_votes()),
                p.exponent(),
                number(p.meta_inner()),
            ),
            Self::StoredWeights1 => {
                "{\"rule\":\"stored-weights/1\",\"params\":{},\"terms\":[]}".to_string()
            }
        }
    }

    /// Reads a plain form through the same constructors. Refused: malformed
    /// JSON, duplicate keys anywhere, unknown or missing keys, an unknown rule
    /// or version, any term (this version composes none), a float where an
    /// integer is required, and any out-of-range value.
    pub fn from_plain(plain: &str) -> Result<Self, Refusal> {
        crate::dupkeys::check(plain).map_err(Refusal::Plain)?;
        let value: Value =
            serde_json::from_str(plain).map_err(|e| Refusal::Plain(e.to_string()))?;
        let top = value
            .as_object()
            .ok_or_else(|| Refusal::Plain("not an object".to_string()))?;
        exact_keys(top, &["rule", "params", "terms"], "the plain form")?;
        let rule = top
            .get("rule")
            .and_then(Value::as_str)
            .ok_or_else(|| Refusal::Plain("rule is not a string".to_string()))?;
        let rule = lookup(rule)?;
        let terms = top
            .get("terms")
            .and_then(Value::as_array)
            .ok_or_else(|| Refusal::Plain("terms is not an array".to_string()))?;
        if let Some(term) = terms.first() {
            return Err(Refusal::Plain(format!("unknown term {term}")));
        }
        let params = top
            .get("params")
            .and_then(Value::as_object)
            .ok_or_else(|| Refusal::Plain("params is not an object".to_string()))?;
        match rule {
            RuleId::StoredWeights1 => {
                exact_keys(params, &[], "params")?;
                Ok(Self::StoredWeights1)
            }
            RuleId::Historical1 => {
                exact_keys(params, &HISTORICAL_KEYS, "params")?;
                let float = |key: &str| {
                    params
                        .get(key)
                        .and_then(Value::as_f64)
                        .ok_or_else(|| Refusal::Plain(format!("{key} is not a number")))
                };
                let exponent = params
                    .get("exponent")
                    .and_then(Value::as_u64)
                    .and_then(|e| u8::try_from(e).ok())
                    .ok_or_else(|| {
                        Refusal::Plain("exponent is not an integer from 1 to 4".to_string())
                    })?;
                HistoricalParams::new(
                    float("agree_prior")?,
                    float("pass_prior")?,
                    float("seen_prior")?,
                    float("extremity_offset")?,
                    float("novelty_amplitude")?,
                    float("novelty_halving_votes")?,
                    exponent,
                    float("meta_inner")?,
                )
                .map(Self::Historical1)
                .map_err(Refusal::Param)
            }
        }
    }
}
