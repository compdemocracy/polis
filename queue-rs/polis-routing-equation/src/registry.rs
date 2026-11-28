//! The rules by name and version, their documentation, and the canonical plain
//! form of a parameter set.
//!
//! A published rule's numbers never change: a new formula or a new default is
//! a new version. Running another allowed parameter set is not a new rule; it
//! is the rule plus its complete canonical parameter form.

use crate::corrected::{ConsensusForm, GicParams, MetaPolicy, SymmetricGicParams, SymmetricParams};
use crate::floor::FloorParams;
use crate::historical::HistoricalParams;
use crate::latest::CountPolicy;
use crate::types::Refusal;
use serde::Serialize;
use serde_json::{Map, Value};

/// Every rule this crate holds. A closed set: a name not listed is refused,
/// never answered with a default.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum RuleId {
    Historical1,
    StoredWeights1,
    Symmetric1,
    GicMean1,
    GicGeomean1,
    SymmetricGic1,
    Uniform1,
    SymmetricGicFloor1,
    Symmetric2,
    SymmetricGic2,
    SymmetricGicFloor2,
}

impl RuleId {
    pub const ALL: [RuleId; 11] = [
        RuleId::Historical1,
        RuleId::StoredWeights1,
        RuleId::Symmetric1,
        RuleId::GicMean1,
        RuleId::GicGeomean1,
        RuleId::SymmetricGic1,
        RuleId::Uniform1,
        RuleId::SymmetricGicFloor1,
        RuleId::Symmetric2,
        RuleId::SymmetricGic2,
        RuleId::SymmetricGicFloor2,
    ];

    /// The rule's `name/version`.
    pub fn name(self) -> &'static str {
        match self {
            Self::Historical1 => "historical/1",
            Self::StoredWeights1 => "stored-weights/1",
            Self::Symmetric1 => "symmetric/1",
            Self::GicMean1 => "gic-mean/1",
            Self::GicGeomean1 => "gic-geomean/1",
            Self::SymmetricGic1 => "symmetric-gic/1",
            Self::Uniform1 => "uniform/1",
            Self::SymmetricGicFloor1 => "symmetric-gic-floor/1",
            Self::Symmetric2 => "symmetric/2",
            Self::SymmetricGic2 => "symmetric-gic/2",
            Self::SymmetricGicFloor2 => "symmetric-gic-floor/2",
        }
    }

    /// Which math update's counts feed the rule's base count term: a fixed
    /// property of the version, never a parameter. `None` for a rule that
    /// reads no base counts.
    pub fn count_policy(self) -> Option<CountPolicy> {
        match self {
            Self::Historical1
            | Self::Symmetric1
            | Self::SymmetricGic1
            | Self::SymmetricGicFloor1 => Some(CountPolicy::Lag1),
            Self::Symmetric2 | Self::SymmetricGic2 | Self::SymmetricGicFloor2 => {
                Some(CountPolicy::Lag0)
            }
            Self::StoredWeights1 | Self::Uniform1 | Self::GicMean1 | Self::GicGeomean1 => None,
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

/// Asks for a rule by its `name/version` together with the count policy a
/// configuration names for it, for example `symmetric-gic-floor/2` with
/// `base-counts:lag-0`. Refused: an unknown rule (`UnknownRule`), an unknown
/// policy name (`UnknownPolicy`), and a rule the policy is not defined for
/// (`PolicyNotDefined`), including every rule that reads no base counts.
pub fn resolve(rule: &str, policy: &str) -> Result<RuleId, Refusal> {
    let id = lookup(rule)?;
    let asked = CountPolicy::from_name(policy).ok_or_else(|| Refusal::UnknownPolicy {
        asked: policy.to_string(),
    })?;
    if id.count_policy() == Some(asked) {
        Ok(id)
    } else {
        Err(Refusal::PolicyNotDefined {
            rule: id.name(),
            policy: asked,
        })
    }
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

impl RuleDoc {
    /// The rule's count policy by name, or that it reads no base counts.
    pub fn count_policy(&self) -> &'static str {
        self.rule
            .count_policy()
            .map_or("reads no base counts", CountPolicy::name)
    }
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

const SYMMETRIC_PARAMS: [ParamDoc; 8] = [
    ParamDoc {
        name: "side_prior",
        default: "1",
        allowed: "[1e-3, 1000], and at most `seen_prior`",
        meaning: "added to the agrees plus disagrees in the side share",
        source: "`historical/1`'s `(A + 1)` and `(P + 1)` read as one term `(A + D + 1)`",
    },
    ParamDoc {
        name: "seen_prior",
        default: "2",
        allowed: "[1e-3, 1000]",
        meaning: "added to the votes seen in the side share",
        source: "`importance_metric`: `(S + 2)`",
    },
    HISTORICAL_PARAMS[3],
    HISTORICAL_PARAMS[4],
    HISTORICAL_PARAMS[5],
    HISTORICAL_PARAMS[6],
    HISTORICAL_PARAMS[7],
    ParamDoc {
        name: "meta_policy",
        default: "`fixed`",
        allowed: "`fixed`, `ordinary` or `exclude`",
        meaning: "a meta comment weighs `meta_inner^exponent`, is scored like any comment, or is excluded",
        source: "`fixed` is today's behaviour (`META_PRIORITY`)",
    },
];

const GIC_PARAMS: [ParamDoc; 2] = [
    ParamDoc {
        name: "gic_offset",
        default: "0.5",
        allowed: "[1e-3, 100]",
        meaning: "added to G, so the factor is always positive",
        source: "the factor `(0.5 + G)` of the corrected equation",
    },
    ParamDoc {
        name: "gic_min_groups",
        default: "2",
        allowed: "an integer from 1 to 64",
        meaning: "with fewer opinion groups than this, the factor is exactly 1",
        source: "one group has no consensus across groups to measure",
    },
];

const SYMMETRIC_GIC_PARAMS: [ParamDoc; 11] = [
    SYMMETRIC_PARAMS[0],
    SYMMETRIC_PARAMS[1],
    SYMMETRIC_PARAMS[2],
    SYMMETRIC_PARAMS[3],
    SYMMETRIC_PARAMS[4],
    SYMMETRIC_PARAMS[5],
    SYMMETRIC_PARAMS[6],
    SYMMETRIC_PARAMS[7],
    ParamDoc {
        name: "consensus_form",
        default: "`gic-geomean/1`",
        allowed: "`gic-geomean/1` or `gic-mean/1`",
        meaning: "which form of the group-informed consensus factor multiplies the weight",
        source: "the geometric mean is the form the corrected equation was studied with",
    },
    GIC_PARAMS[0],
    GIC_PARAMS[1],
];

const FLOOR_PARAMS: [ParamDoc; 12] = [
    SYMMETRIC_GIC_PARAMS[0],
    SYMMETRIC_GIC_PARAMS[1],
    SYMMETRIC_GIC_PARAMS[2],
    SYMMETRIC_GIC_PARAMS[3],
    SYMMETRIC_GIC_PARAMS[4],
    SYMMETRIC_GIC_PARAMS[5],
    SYMMETRIC_GIC_PARAMS[6],
    SYMMETRIC_GIC_PARAMS[7],
    SYMMETRIC_GIC_PARAMS[8],
    SYMMETRIC_GIC_PARAMS[9],
    SYMMETRIC_GIC_PARAMS[10],
    ParamDoc {
        name: "floor_share",
        default: "0.1",
        allowed: "[0, 1)",
        meaning: "the share of the chance spread evenly over the candidates; the rest follows the weights",
        source: "the uniform floor of the corrected equation (`alpha = 0.10`)",
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
        RuleId::Symmetric1 => RuleDoc {
            rule,
            summary: "Today's equation with agree and disagree weighed alike in the count term (a candidate, not chosen).",
            formula: "R = (A + D + side_prior) / (S + seen_prior); \
                      weight = (R * R * (E + extremity_offset) * (1 + novelty_amplitude * 2^(-S / novelty_halving_votes)))^exponent; \
                      a meta comment follows meta_policy",
            params: &SYMMETRIC_PARAMS,
        },
        RuleId::GicMean1 => RuleDoc {
            rule,
            summary: "The group-informed consensus factor as the report computes it: the mean over opinion groups.",
            formula: "G = mean, over the groups with a count for the comment, of (A_g + 1) / (A_g + D_g + 2), or 0.5 if none; \
                      factor = gic_offset + G, or 1 with fewer than gic_min_groups groups",
            params: &GIC_PARAMS,
        },
        RuleId::GicGeomean1 => RuleDoc {
            rule,
            summary: "The group-informed consensus factor as a geometric mean over opinion groups, passes included.",
            formula: "G = exp(mean over every group of ln((A_g + 1) / (S_g + 2))), a group with no count read as no votes; \
                      factor = gic_offset + G, or 1 with fewer than gic_min_groups groups",
            params: &GIC_PARAMS,
        },
        RuleId::SymmetricGic1 => RuleDoc {
            rule,
            summary: "symmetric/1 times the group-informed consensus factor (a candidate, not chosen).",
            formula: "weight = symmetric/1's weight * (gic_offset + G), G in the consensus_form; \
                      an unscored comment and a fixed meta comment are not multiplied",
            params: &SYMMETRIC_GIC_PARAMS,
        },
        RuleId::Uniform1 => RuleDoc {
            rule,
            summary: "Every candidate has the same chance: the uniform lane on its own.",
            formula: "d_j = 1 for every candidate; q = 1/n",
            params: &[],
        },
        RuleId::SymmetricGicFloor1 => RuleDoc {
            rule,
            summary: "symmetric-gic/1 with a uniform floor: a stated share of the chance is spread evenly, the rest follows the weights (a candidate, not chosen).",
            formula: "d_j = floor_share / n + (1 - floor_share) * w_j / W, w the symmetric-gic/1 weights with unscored read as 1, W their sum over the candidates; \
                      W = 0 donates the weighted share to the uniform lane; drawn with stable-cdf/1",
            params: &FLOOR_PARAMS,
        },
        RuleId::Symmetric2 => RuleDoc {
            rule,
            summary: "symmetric/1 on the counts of the math update being read (base-counts:lag-0), not the update before it (a candidate, not chosen).",
            formula: "symmetric/1's formula, with A, D and P summed over the opinion groups of the update whose extremity is read",
            params: &SYMMETRIC_PARAMS,
        },
        RuleId::SymmetricGic2 => RuleDoc {
            rule,
            summary: "symmetric-gic/1 on the counts of the math update being read (base-counts:lag-0): counts, extremity and groups from one update (a candidate, not chosen).",
            formula: "symmetric-gic/1's formula, with A, D and P summed over the same opinion groups that give G",
            params: &SYMMETRIC_GIC_PARAMS,
        },
        RuleId::SymmetricGicFloor2 => RuleDoc {
            rule,
            summary: "symmetric-gic-floor/1 over symmetric-gic/2's weights (base-counts:lag-0) (a candidate, not chosen).",
            formula: "symmetric-gic-floor/1's formula, w the symmetric-gic/2 weights with unscored read as 1; drawn with stable-cdf/1",
            params: &FLOOR_PARAMS,
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
    Symmetric1(SymmetricParams),
    GicMean1(GicParams),
    GicGeomean1(GicParams),
    SymmetricGic1(SymmetricGicParams),
    Uniform1,
    SymmetricGicFloor1(FloorParams),
    Symmetric2(SymmetricParams),
    SymmetricGic2(SymmetricGicParams),
    SymmetricGicFloor2(FloorParams),
}

const SYMMETRIC_KEYS: [&str; 8] = [
    "side_prior",
    "seen_prior",
    "extremity_offset",
    "novelty_amplitude",
    "novelty_halving_votes",
    "exponent",
    "meta_inner",
    "meta_policy",
];

const GIC_KEYS: [&str; 2] = ["gic_offset", "gic_min_groups"];

const SYMMETRIC_GIC_KEYS: [&str; 11] = [
    "side_prior",
    "seen_prior",
    "extremity_offset",
    "novelty_amplitude",
    "novelty_halving_votes",
    "exponent",
    "meta_inner",
    "meta_policy",
    "consensus_form",
    "gic_offset",
    "gic_min_groups",
];

const FLOOR_KEYS: [&str; 12] = [
    "side_prior",
    "seen_prior",
    "extremity_offset",
    "novelty_amplitude",
    "novelty_halving_votes",
    "exponent",
    "meta_inner",
    "meta_policy",
    "consensus_form",
    "gic_offset",
    "gic_min_groups",
    "floor_share",
];

fn symmetric_plain(p: &SymmetricParams) -> String {
    format!(
        "\"side_prior\":{},\"seen_prior\":{},\"extremity_offset\":{},\"novelty_amplitude\":{},\"novelty_halving_votes\":{},\"exponent\":{},\"meta_inner\":{},\"meta_policy\":\"{}\"",
        number(p.side_prior()),
        number(p.seen_prior()),
        number(p.extremity_offset()),
        number(p.novelty_amplitude()),
        number(p.novelty_halving_votes()),
        p.exponent(),
        number(p.meta_inner()),
        p.meta_policy().name(),
    )
}

fn gic_plain(p: &GicParams) -> String {
    format!(
        "\"gic_offset\":{},\"gic_min_groups\":{}",
        number(p.offset()),
        p.min_groups()
    )
}

fn float_of(params: &Map<String, Value>, key: &str) -> Result<f64, Refusal> {
    params
        .get(key)
        .and_then(Value::as_f64)
        .ok_or_else(|| Refusal::Plain(format!("{key} is not a number")))
}

fn small_int(params: &Map<String, Value>, key: &str) -> Result<u8, Refusal> {
    params
        .get(key)
        .and_then(Value::as_u64)
        .and_then(|e| u8::try_from(e).ok())
        .ok_or_else(|| Refusal::Plain(format!("{key} is not a small integer")))
}

fn name_of<'a>(params: &'a Map<String, Value>, key: &str) -> Result<&'a str, Refusal> {
    params
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| Refusal::Plain(format!("{key} is not a string")))
}

fn symmetric_from(params: &Map<String, Value>) -> Result<SymmetricParams, Refusal> {
    let meta = name_of(params, "meta_policy")?;
    let meta = MetaPolicy::from_name(meta)
        .ok_or_else(|| Refusal::Plain(format!("unknown meta_policy {meta:?}")))?;
    SymmetricParams::new(
        float_of(params, "side_prior")?,
        float_of(params, "seen_prior")?,
        float_of(params, "extremity_offset")?,
        float_of(params, "novelty_amplitude")?,
        float_of(params, "novelty_halving_votes")?,
        small_int(params, "exponent")?,
        float_of(params, "meta_inner")?,
        meta,
    )
    .map_err(Refusal::Param)
}

fn gic_from(params: &Map<String, Value>) -> Result<GicParams, Refusal> {
    GicParams::new(
        float_of(params, "gic_offset")?,
        small_int(params, "gic_min_groups")?,
    )
    .map_err(Refusal::Param)
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
            RuleId::Symmetric1 => Self::Symmetric1(SymmetricParams::default()),
            RuleId::GicMean1 => Self::GicMean1(GicParams::default()),
            RuleId::GicGeomean1 => Self::GicGeomean1(GicParams::default()),
            RuleId::SymmetricGic1 => Self::SymmetricGic1(SymmetricGicParams::default()),
            RuleId::Uniform1 => Self::Uniform1,
            RuleId::SymmetricGicFloor1 => Self::SymmetricGicFloor1(FloorParams::default()),
            RuleId::Symmetric2 => Self::Symmetric2(SymmetricParams::default()),
            RuleId::SymmetricGic2 => Self::SymmetricGic2(SymmetricGicParams::default()),
            RuleId::SymmetricGicFloor2 => Self::SymmetricGicFloor2(FloorParams::default()),
        }
    }

    pub fn rule(&self) -> RuleId {
        match self {
            Self::Historical1(_) => RuleId::Historical1,
            Self::StoredWeights1 => RuleId::StoredWeights1,
            Self::Symmetric1(_) => RuleId::Symmetric1,
            Self::GicMean1(_) => RuleId::GicMean1,
            Self::GicGeomean1(_) => RuleId::GicGeomean1,
            Self::SymmetricGic1(_) => RuleId::SymmetricGic1,
            Self::Uniform1 => RuleId::Uniform1,
            Self::SymmetricGicFloor1(_) => RuleId::SymmetricGicFloor1,
            Self::Symmetric2(_) => RuleId::Symmetric2,
            Self::SymmetricGic2(_) => RuleId::SymmetricGic2,
            Self::SymmetricGicFloor2(_) => RuleId::SymmetricGicFloor2,
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
            Self::Symmetric1(p) | Self::Symmetric2(p) => format!(
                "{{\"rule\":\"{}\",\"params\":{{{}}},\"terms\":[]}}",
                self.rule().name(),
                symmetric_plain(p)
            ),
            Self::GicMean1(p) | Self::GicGeomean1(p) => format!(
                "{{\"rule\":\"{}\",\"params\":{{{}}},\"terms\":[]}}",
                self.rule().name(),
                gic_plain(p)
            ),
            Self::SymmetricGic1(p) | Self::SymmetricGic2(p) => format!(
                "{{\"rule\":\"{}\",\"params\":{{{},\"consensus_form\":\"{}\",{}}},\"terms\":[]}}",
                self.rule().name(),
                symmetric_plain(p.base()),
                p.form().name(),
                gic_plain(p.gic())
            ),
            Self::Uniform1 => "{\"rule\":\"uniform/1\",\"params\":{},\"terms\":[]}".to_string(),
            Self::SymmetricGicFloor1(p) | Self::SymmetricGicFloor2(p) => format!(
                "{{\"rule\":\"{}\",\"params\":{{{},\"consensus_form\":\"{}\",{},\"floor_share\":{}}},\"terms\":[]}}",
                self.rule().name(),
                symmetric_plain(p.base().base()),
                p.base().form().name(),
                gic_plain(p.base().gic()),
                number(p.floor_share())
            ),
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
            RuleId::Symmetric1 => {
                exact_keys(params, &SYMMETRIC_KEYS, "params")?;
                symmetric_from(params).map(Self::Symmetric1)
            }
            RuleId::Symmetric2 => {
                exact_keys(params, &SYMMETRIC_KEYS, "params")?;
                symmetric_from(params).map(Self::Symmetric2)
            }
            RuleId::GicMean1 => {
                exact_keys(params, &GIC_KEYS, "params")?;
                gic_from(params).map(Self::GicMean1)
            }
            RuleId::GicGeomean1 => {
                exact_keys(params, &GIC_KEYS, "params")?;
                gic_from(params).map(Self::GicGeomean1)
            }
            RuleId::SymmetricGic1 | RuleId::SymmetricGic2 => {
                exact_keys(params, &SYMMETRIC_GIC_KEYS, "params")?;
                let form = name_of(params, "consensus_form")?;
                let form = ConsensusForm::from_name(form)
                    .ok_or_else(|| Refusal::Plain(format!("unknown consensus_form {form:?}")))?;
                let p = SymmetricGicParams::new(symmetric_from(params)?, form, gic_from(params)?);
                Ok(if rule == RuleId::SymmetricGic1 {
                    Self::SymmetricGic1(p)
                } else {
                    Self::SymmetricGic2(p)
                })
            }
            RuleId::Uniform1 => {
                exact_keys(params, &[], "params")?;
                Ok(Self::Uniform1)
            }
            RuleId::SymmetricGicFloor1 | RuleId::SymmetricGicFloor2 => {
                exact_keys(params, &FLOOR_KEYS, "params")?;
                let form = name_of(params, "consensus_form")?;
                let form = ConsensusForm::from_name(form)
                    .ok_or_else(|| Refusal::Plain(format!("unknown consensus_form {form:?}")))?;
                let base =
                    SymmetricGicParams::new(symmetric_from(params)?, form, gic_from(params)?);
                let p = FloorParams::new(base, float_of(params, "floor_share")?)
                    .map_err(Refusal::Param)?;
                Ok(if rule == RuleId::SymmetricGicFloor1 {
                    Self::SymmetricGicFloor1(p)
                } else {
                    Self::SymmetricGicFloor2(p)
                })
            }
        }
    }
}
