//! The canonical plain form of a draw's receipt, and of what produced the
//! weights it drew from.
//!
//! The form is JSON with every field written out, keys in a fixed order, and
//! numbers in the shortest form that reads back to the same double. Reading
//! goes through the crate's constructors and then writes the receipt again:
//! text that is not exactly the canonical form of what it reads as is
//! refused, so one receipt has one spelling and two receipts are equal
//! exactly when their texts are. Reading a receipt back does not re-run or
//! verify the draw; it restores what was written.

use crate::draw::{
    Candidates, CorrectedProvenance, DrawFlags, DrawMode, Drawn, Lane, WeightProvenance,
    WeightsUsed,
};
use crate::floor::ZERO_MASS_DONATION;
use crate::historical::HistoricalProvenance;
use crate::registry::{ParamSet, exact_keys, number};
use crate::types::{CommentId, MAX_CANDIDATES, Refusal, SourceId, WEIGHT_CEILING};
use serde_json::{Map, Value};
use std::collections::BTreeSet;

const RECEIPT_KEYS: [&str; 13] = [
    "comment",
    "index",
    "random_n",
    "probability",
    "rule",
    "draw_mode",
    "weights",
    "lanes",
    "sampled_lane",
    "flags",
    "candidate_count",
    "candidate_order_digest",
    "input_source",
];

/// A JSON string, escaped.
fn text(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_default()
}

fn plain_refusal(why: impl Into<String>) -> Refusal {
    Refusal::Plain(why.into())
}

fn field<'a>(object: &'a Map<String, Value>, key: &str) -> Result<&'a Value, Refusal> {
    object
        .get(key)
        .ok_or_else(|| plain_refusal(format!("missing key {key:?}")))
}

fn object<'a>(value: &'a Value, what: &str) -> Result<&'a Map<String, Value>, Refusal> {
    value
        .as_object()
        .ok_or_else(|| plain_refusal(format!("{what} is not an object")))
}

fn string<'a>(object: &'a Map<String, Value>, key: &str) -> Result<&'a str, Refusal> {
    field(object, key)?
        .as_str()
        .ok_or_else(|| plain_refusal(format!("{key} is not a string")))
}

fn unsigned(object: &Map<String, Value>, key: &str) -> Result<u64, Refusal> {
    field(object, key)?
        .as_u64()
        .ok_or_else(|| plain_refusal(format!("{key} is not an unsigned integer")))
}

fn count(object: &Map<String, Value>, key: &str) -> Result<usize, Refusal> {
    usize::try_from(unsigned(object, key)?)
        .map_err(|_| plain_refusal(format!("{key} is too large")))
}

fn float(object: &Map<String, Value>, key: &str) -> Result<f64, Refusal> {
    field(object, key)?
        .as_f64()
        .ok_or_else(|| plain_refusal(format!("{key} is not a number")))
}

fn source(object: &Map<String, Value>, key: &str) -> Result<SourceId, Refusal> {
    SourceId::new(string(object, key)?)
}

fn comment_id(value: &Value) -> Result<CommentId, Refusal> {
    let tid = value
        .as_u64()
        .ok_or_else(|| plain_refusal("a comment id is not an unsigned integer"))?;
    let tid = u32::try_from(tid).map_err(|_| plain_refusal("a comment id is not a u32"))?;
    Ok(CommentId::new(tid))
}

fn array<'a>(object: &'a Map<String, Value>, key: &str) -> Result<&'a Vec<Value>, Refusal> {
    field(object, key)?
        .as_array()
        .ok_or_else(|| plain_refusal(format!("{key} is not an array")))
}

impl WeightProvenance {
    /// The canonical plain form: `{"kind":"math-engine-stored"}`, or
    /// `{"kind":"computed","rule":<the producing rule's plain form>,
    /// "inputs":{...}}` with every input frame's source by name.
    pub fn to_plain(&self) -> String {
        match self {
            Self::MathEngineStored => "{\"kind\":\"math-engine-stored\"}".to_string(),
            Self::Historical1(h) => format!(
                "{{\"kind\":\"computed\",\"rule\":{},\"inputs\":{{\"previous_counts\":{},\"current_extremity\":{}}}}}",
                ParamSet::Historical1(*h.params()).to_plain(),
                text(h.previous_counts().as_str()),
                text(h.current_extremity().as_str()),
            ),
            Self::Corrected(c) => {
                let mut groups = c.current_groups.as_ref().map_or_else(String::new, |g| {
                    format!(",\"current_groups\":{}", text(g.as_str()))
                });
                if let Some(t) = &c.term_source {
                    groups.push_str(&format!(",\"importance\":{}", text(t.as_str())));
                }
                let terms: Vec<String> = c.terms.iter().map(|t| t.to_plain()).collect();
                let base = c.params.to_plain();
                let rule = match base.strip_suffix("\"terms\":[]}") {
                    Some(head) => format!("{head}\"terms\":[{}]}}", terms.join(",")),
                    None => base,
                };
                format!(
                    "{{\"kind\":\"computed\",\"rule\":{},\"inputs\":{{\"previous_counts\":{},\"current_extremity\":{}{}}}}}",
                    rule,
                    text(c.previous_counts.as_str()),
                    text(c.current_extremity.as_str()),
                    groups,
                )
            }
        }
    }

    fn from_value(value: &Value) -> Result<Self, Refusal> {
        let top = object(value, "produced_by")?;
        match string(top, "kind")? {
            "math-engine-stored" => {
                exact_keys(top, &["kind"], "produced_by")?;
                Ok(Self::MathEngineStored)
            }
            "computed" => {
                exact_keys(top, &["kind", "rule", "inputs"], "produced_by")?;
                let mut rule_value = field(top, "rule")?.clone();
                let terms: Vec<crate::importance::TermParams> = match rule_value.get("terms") {
                    Some(Value::Array(ts)) => ts
                        .iter()
                        .map(crate::importance::TermParams::from_value)
                        .collect::<Result<_, _>>()?,
                    _ => return Err(plain_refusal("terms is not an array")),
                };
                if let Some(t) = rule_value.get_mut("terms") {
                    *t = Value::Array(vec![]);
                }
                let rule = ParamSet::from_plain(&rule_value.to_string())?;
                let inputs = object(field(top, "inputs")?, "inputs")?;
                if !terms.is_empty() {
                    let groups = matches!(rule, ParamSet::SymmetricGic1(_));
                    let mut keys = vec!["previous_counts", "current_extremity"];
                    if groups {
                        keys.push("current_groups");
                    }
                    keys.push("importance");
                    if terms.len() > 1
                        || !matches!(
                            rule,
                            ParamSet::Historical1(_)
                                | ParamSet::Symmetric1(_)
                                | ParamSet::SymmetricGic1(_)
                        )
                    {
                        return Err(plain_refusal("terms the producing rule cannot carry"));
                    }
                    exact_keys(inputs, &keys, "inputs")?;
                    return Ok(Self::Corrected(CorrectedProvenance {
                        params: rule,
                        previous_counts: source(inputs, "previous_counts")?,
                        current_extremity: source(inputs, "current_extremity")?,
                        current_groups: if groups {
                            Some(source(inputs, "current_groups")?)
                        } else {
                            None
                        },
                        terms,
                        term_source: Some(source(inputs, "importance")?),
                    }));
                }
                match rule {
                    ParamSet::Historical1(params) => {
                        exact_keys(inputs, &["previous_counts", "current_extremity"], "inputs")?;
                        Ok(Self::Historical1(HistoricalProvenance::new(
                            params,
                            source(inputs, "previous_counts")?,
                            source(inputs, "current_extremity")?,
                        )))
                    }
                    ParamSet::Symmetric1(_) => {
                        exact_keys(inputs, &["previous_counts", "current_extremity"], "inputs")?;
                        Ok(Self::Corrected(CorrectedProvenance {
                            params: rule,
                            previous_counts: source(inputs, "previous_counts")?,
                            current_extremity: source(inputs, "current_extremity")?,
                            current_groups: None,
                            terms: vec![],
                            term_source: None,
                        }))
                    }
                    ParamSet::SymmetricGic1(_) => {
                        exact_keys(
                            inputs,
                            &["previous_counts", "current_extremity", "current_groups"],
                            "inputs",
                        )?;
                        Ok(Self::Corrected(CorrectedProvenance {
                            params: rule,
                            previous_counts: source(inputs, "previous_counts")?,
                            current_extremity: source(inputs, "current_extremity")?,
                            current_groups: Some(source(inputs, "current_groups")?),
                            terms: vec![],
                            term_source: None,
                        }))
                    }
                    other => Err(plain_refusal(format!(
                        "{} does not compute weights",
                        other.rule().name()
                    ))),
                }
            }
            other => Err(plain_refusal(format!("unknown provenance kind {other:?}"))),
        }
    }
}

impl WeightsUsed {
    /// The canonical plain form: `{"kind":"no-map"}`, or
    /// `{"kind":"map","source":...,"produced_by":<WeightProvenance>}`.
    pub fn to_plain(&self) -> String {
        match self {
            Self::NoMap => "{\"kind\":\"no-map\"}".to_string(),
            Self::NotRead => "{\"kind\":\"not-read\"}".to_string(),
            Self::Map { source, provenance } => format!(
                "{{\"kind\":\"map\",\"source\":{},\"produced_by\":{}}}",
                text(source.as_str()),
                provenance.to_plain()
            ),
        }
    }

    fn from_value(value: &Value) -> Result<Self, Refusal> {
        let top = object(value, "weights")?;
        match string(top, "kind")? {
            "no-map" => {
                exact_keys(top, &["kind"], "weights")?;
                Ok(Self::NoMap)
            }
            "not-read" => {
                exact_keys(top, &["kind"], "weights")?;
                Ok(Self::NotRead)
            }
            "map" => {
                exact_keys(top, &["kind", "source", "produced_by"], "weights")?;
                Ok(Self::Map {
                    source: source(top, "source")?,
                    provenance: WeightProvenance::from_value(field(top, "produced_by")?)?,
                })
            }
            other => Err(plain_refusal(format!("unknown weights kind {other:?}"))),
        }
    }
}

fn lane_to_plain(lane: &Lane) -> String {
    format!(
        "{{\"lane\":{},\"share\":{},\"normaliser\":{},\"contribution\":{}}}",
        text(lane.lane),
        number(lane.share),
        number(lane.normaliser),
        number(lane.contribution)
    )
}

fn lane_from_value(value: &Value) -> Result<Lane, Refusal> {
    let top = object(value, "a lane")?;
    exact_keys(
        top,
        &["lane", "share", "normaliser", "contribution"],
        "a lane",
    )?;
    let lane = match string(top, "lane")? {
        "weights" => "weights",
        "uniform" => "uniform",
        other => return Err(plain_refusal(format!("unknown lane {other:?}"))),
    };
    Ok(Lane {
        lane,
        share: float(top, "share")?,
        normaliser: float(top, "normaliser")?,
        contribution: float(top, "contribution")?,
    })
}

fn flags_to_plain(flags: &DrawFlags) -> String {
    let absorbed: Vec<String> = flags
        .absorbed
        .iter()
        .map(|id| id.get().to_string())
        .collect();
    let donations: Vec<String> = flags.donations.iter().map(|d| text(d)).collect();
    format!(
        "{{\"zero_mapped_to_one\":{},\"null_or_false_mapped_to_one\":{},\"absent_mapped_to_one\":{},\"absorbed\":[{}],\"donations\":[{}]}}",
        flags.zero_mapped_to_one,
        flags.null_or_false_mapped_to_one,
        flags.absent_mapped_to_one,
        absorbed.join(","),
        donations.join(",")
    )
}

fn flags_from_value(value: &Value) -> Result<DrawFlags, Refusal> {
    let top = object(value, "flags")?;
    exact_keys(
        top,
        &[
            "zero_mapped_to_one",
            "null_or_false_mapped_to_one",
            "absent_mapped_to_one",
            "absorbed",
            "donations",
        ],
        "flags",
    )?;
    Ok(DrawFlags {
        zero_mapped_to_one: count(top, "zero_mapped_to_one")?,
        null_or_false_mapped_to_one: count(top, "null_or_false_mapped_to_one")?,
        absent_mapped_to_one: count(top, "absent_mapped_to_one")?,
        absorbed: array(top, "absorbed")?
            .iter()
            .map(comment_id)
            .collect::<Result<_, _>>()?,
        donations: array(top, "donations")?
            .iter()
            .map(|d| {
                d.as_str()
                    .map(str::to_string)
                    .ok_or_else(|| plain_refusal("a donation is not a string"))
            })
            .collect::<Result<_, _>>()?,
    })
}

impl Drawn {
    /// The receipt's canonical plain form, for example (one line):
    ///
    /// ```text
    /// {"comment":1,"index":1,"random_n":1.0,"probability":0.75,
    ///  "rule":{"rule":"stored-weights/1","params":{},"terms":[]},
    ///  "draw_mode":"legacy-cdf/1",
    ///  "weights":{"kind":"map","source":"...","produced_by":{"kind":"math-engine-stored"}},
    ///  "lanes":[{"lane":"weights","share":1.0,"normaliser":4.0,"contribution":0.75}],
    ///  "sampled_lane":null,
    ///  "flags":{"zero_mapped_to_one":1,"null_or_false_mapped_to_one":0,
    ///           "absent_mapped_to_one":0,"absorbed":[],"donations":[]},
    ///  "candidate_count":2,"candidate_order_digest":"<16 hex digits>",
    ///  "input_source":"..."}
    /// ```
    pub fn to_plain(&self) -> String {
        let lanes: Vec<String> = self.lanes.iter().map(lane_to_plain).collect();
        let sampled = self
            .sampled_lane
            .as_deref()
            .map_or_else(|| "null".to_string(), text);
        format!(
            "{{\"comment\":{},\"index\":{},\"random_n\":{},\"probability\":{},\"rule\":{},\"draw_mode\":{},\"weights\":{},\"lanes\":[{}],\"sampled_lane\":{},\"flags\":{},\"candidate_count\":{},\"candidate_order_digest\":\"{:016x}\",\"input_source\":{}}}",
            self.comment.get(),
            self.index,
            number(self.random_n),
            number(self.probability),
            self.rule.to_plain(),
            text(self.draw_mode.name()),
            self.weights.to_plain(),
            lanes.join(","),
            sampled,
            flags_to_plain(&self.flags),
            self.candidate_count,
            self.candidate_order_digest,
            text(self.input_source.as_str()),
        )
    }

    // These checks require no input frames and do not re-run a draw; each
    // recorded rule has its own.
    fn validate_recorded_shape(&self) -> Result<(), Refusal> {
        match self.rule {
            ParamSet::StoredWeights1 => self.validate_stored_weights(),
            ParamSet::Uniform1 => self.validate_uniform(),
            ParamSet::SymmetricGicFloor1(_) => self.validate_floor(),
            other => Err(plain_refusal(format!(
                "{} does not draw",
                other.rule().name()
            ))),
        }
    }

    /// The checks every new-shape receipt shares: its count, index, unit
    /// scale, no sampled lane, no legacy mapping and nothing absorbed (the
    /// stable draw refuses absorption), and the one-candidate case.
    fn validate_common_stable(&self, fail: &dyn Fn() -> Refusal) -> Result<(), Refusal> {
        if self.draw_mode != DrawMode::StableCdf1
            || self.candidate_count == 0
            || self.candidate_count > MAX_CANDIDATES
            || self.index >= self.candidate_count
            || !self.probability.is_finite()
            || self.probability <= 0.0
            || self.probability > 1.0
            || !self.random_n.is_finite()
            || self.random_n.is_sign_negative()
            || self.sampled_lane.is_some()
            || self.flags.zero_mapped_to_one != 0
            || self.flags.null_or_false_mapped_to_one != 0
            || !self.flags.absorbed.is_empty()
            || self.flags.absent_mapped_to_one > self.candidate_count
            || (self.candidate_count == 1 && self.probability != 1.0)
        {
            return Err(fail());
        }
        if self.candidate_count == 1 {
            let only = Candidates::new(vec![self.comment]).map_err(|_| fail())?;
            if only.order_digest() != self.candidate_order_digest {
                return Err(fail());
            }
        }
        Ok(())
    }

    fn validate_uniform(&self) -> Result<(), Refusal> {
        let fail = || plain_refusal("inconsistent uniform/1 receipt");
        self.validate_common_stable(&fail)?;
        let n = self.candidate_count as f64;
        let [lane] = self.lanes.as_slice() else {
            return Err(fail());
        };
        // Every draw weight is 1: the total is n exactly, q is 1/n and the
        // index is the floor of random_n.
        if self.weights != WeightsUsed::NotRead
            || self.flags.absent_mapped_to_one != 0
            || !self.flags.donations.is_empty()
            || lane.lane != "uniform"
            || lane.share != 1.0
            || lane.normaliser != n
            || self.probability != 1.0 / n
            || lane.contribution.to_bits() != self.probability.to_bits()
            || self.random_n >= n
            || self.index as f64 != self.random_n.floor()
        {
            return Err(fail());
        }
        Ok(())
    }

    fn validate_floor(&self) -> Result<(), Refusal> {
        let fail = || plain_refusal("inconsistent symmetric-gic-floor/1 receipt");
        self.validate_common_stable(&fail)?;
        let ParamSet::SymmetricGicFloor1(params) = self.rule else {
            return Err(fail());
        };
        let WeightsUsed::Map {
            provenance: WeightProvenance::Corrected(c),
            ..
        } = &self.weights
        else {
            return Err(fail());
        };
        if c.params != ParamSet::SymmetricGic1(*params.base()) || c.current_groups.is_none() {
            return Err(fail());
        }
        let [uniform, weights] = self.lanes.as_slice() else {
            return Err(fail());
        };
        let n = self.candidate_count as f64;
        let donated = match self.flags.donations.as_slice() {
            [] => false,
            [d] if d == ZERO_MASS_DONATION => true,
            _ => return Err(fail()),
        };
        let shares_ok = if donated {
            uniform.share == 1.0
                && weights.share == 0.0
                && weights.normaliser == 0.0
                && weights.contribution == 0.0
        } else {
            uniform.share.to_bits() == params.floor_share().to_bits()
                && weights.share.to_bits() == (1.0 - params.floor_share()).to_bits()
                && weights.normaliser.is_finite()
                && weights.normaliser > 0.0
        };
        // q = (u + w) / T with T the computed sum of the d's, within n
        // roundings of 1: q is within (4n + 8) 2^-53 of u + w.
        let d = uniform.contribution + weights.contribution;
        let slack = (4.0 * n + 8.0) * f64::EPSILON / 2.0;
        if uniform.lane != "uniform"
            || weights.lane != "weights"
            || !shares_ok
            || uniform.normaliser != n
            || uniform.contribution.to_bits() != (uniform.share / n).to_bits()
            || !weights.contribution.is_finite()
            || weights.contribution.is_sign_negative()
            || weights.contribution > weights.share
            || (self.probability - d).abs() > slack
            || self.random_n >= 1.0 + slack
        {
            return Err(fail());
        }
        Ok(())
    }

    fn validate_stored_weights(&self) -> Result<(), Refusal> {
        let fail = || plain_refusal("inconsistent stored-weights/1 receipt");
        let foreign = matches!(
            self.weights,
            WeightsUsed::NotRead
                | WeightsUsed::Map {
                    provenance: WeightProvenance::Corrected(_),
                    ..
                }
        );
        if foreign
            || self.draw_mode != DrawMode::LegacyCdf1
            || self.rule != ParamSet::StoredWeights1
            || self.candidate_count == 0
            || self.candidate_count > MAX_CANDIDATES
            || self.index >= self.candidate_count
            || !self.probability.is_finite()
            || self.probability.is_sign_negative()
            || self.probability > 1.0
            || !self.random_n.is_finite()
            || self.random_n.is_sign_negative()
            || self.sampled_lane.is_some()
            || !self.flags.donations.is_empty()
        {
            return Err(fail());
        }
        let [lane] = self.lanes.as_slice() else {
            return Err(fail());
        };
        if lane.lane != "weights"
            || lane.share != 1.0
            || !lane.normaliser.is_finite()
            || lane.normaliser < crate::draw::MIN_TOTAL
            || self.random_n >= lane.normaliser
            || lane.contribution.to_bits() != self.probability.to_bits()
            || (self.candidate_count == 1 && self.probability != 1.0)
        {
            return Err(fail());
        }
        let mapped = self
            .flags
            .zero_mapped_to_one
            .checked_add(self.flags.null_or_false_mapped_to_one)
            .and_then(|n| n.checked_add(self.flags.absent_mapped_to_one))
            .ok_or_else(fail)?;
        let absorbed: BTreeSet<_> = self.flags.absorbed.iter().copied().collect();
        if mapped > self.candidate_count
            || absorbed.len() != self.flags.absorbed.len()
            || absorbed.len() >= self.candidate_count
            || absorbed.contains(&self.comment)
        {
            return Err(fail());
        }
        if self.weights == WeightsUsed::NoMap
            && (self.flags.absent_mapped_to_one != self.candidate_count
                || self.flags.zero_mapped_to_one != 0
                || self.flags.null_or_false_mapped_to_one != 0)
        {
            return Err(fail());
        }
        // Every candidate mapped to 1 (always so with no map): the running
        // sums are exactly 1, 2, ..., n, so the total, the probability and the
        // index follow from the count and random_n alone.
        if mapped == self.candidate_count
            && (!absorbed.is_empty()
                || lane.normaliser != self.candidate_count as f64
                || self.probability != 1.0 / self.candidate_count as f64
                || self.index as f64 != self.random_n.floor())
        {
            return Err(fail());
        }
        // Each mapped candidate adds exactly 1 to a running sum of
        // non-negative doubles, and no draw weight exceeds the ceiling, so the
        // total lies between the mapped count and n times the ceiling (doubled
        // to cover rounding).
        let n = self.candidate_count as f64;
        if lane.normaliser < mapped as f64 || lane.normaliser > 2.0 * n * WEIGHT_CEILING {
            return Err(fail());
        }
        // One candidate: the candidate list is exactly the chosen comment, so
        // its order digest is known.
        if self.candidate_count == 1 {
            // Adding one weight to zero is exact: no summation allowance.
            if lane.normaliser > WEIGHT_CEILING {
                return Err(fail());
            }
            let only = Candidates::new(vec![self.comment]).map_err(|_| fail())?;
            if only.order_digest() != self.candidate_order_digest {
                return Err(fail());
            }
        }
        Ok(())
    }

    /// Reads a receipt's canonical plain form back. This validates the recorded
    /// rule's structural invariants, not the truth of the draw or its sources.
    /// Only the caller can authenticate the stored record and its input sources.
    /// Refused: malformed JSON,
    /// a duplicate key anywhere, a missing or unknown key, a value of the
    /// wrong type or outside its constructor's domain, an unknown rule, draw
    /// mode, lane or provenance, and any text that is not exactly the
    /// canonical form of the receipt it reads as.
    pub fn from_plain(plain: &str) -> Result<Self, Refusal> {
        crate::dupkeys::check(plain).map_err(Refusal::Plain)?;
        let value: Value = serde_json::from_str(plain).map_err(|e| plain_refusal(e.to_string()))?;
        let top = object(&value, "the receipt")?;
        exact_keys(top, &RECEIPT_KEYS, "the receipt")?;
        let draw_mode = match string(top, "draw_mode")? {
            "legacy-cdf/1" => DrawMode::LegacyCdf1,
            "stable-cdf/1" => DrawMode::StableCdf1,
            other => return Err(plain_refusal(format!("unknown draw mode {other:?}"))),
        };
        let digest = string(top, "candidate_order_digest")?;
        let candidate_order_digest = u64::from_str_radix(digest, 16)
            .map_err(|_| plain_refusal("candidate_order_digest is not 16 hex digits"))?;
        let sampled_lane = match field(top, "sampled_lane")? {
            Value::Null => None,
            Value::String(s) => Some(s.clone()),
            _ => return Err(plain_refusal("sampled_lane is not null or a string")),
        };
        let drawn = Self {
            comment: comment_id(field(top, "comment")?)?,
            index: count(top, "index")?,
            random_n: float(top, "random_n")?,
            probability: float(top, "probability")?,
            rule: ParamSet::from_plain(&field(top, "rule")?.to_string())?,
            draw_mode,
            weights: WeightsUsed::from_value(field(top, "weights")?)?,
            lanes: array(top, "lanes")?
                .iter()
                .map(lane_from_value)
                .collect::<Result<_, _>>()?,
            sampled_lane,
            flags: flags_from_value(field(top, "flags")?)?,
            candidate_count: count(top, "candidate_count")?,
            candidate_order_digest,
            input_source: source(top, "input_source")?,
        };
        drawn.validate_recorded_shape()?;
        if drawn.to_plain() != plain {
            return Err(plain_refusal(
                "not the canonical form of the receipt it reads as",
            ));
        }
        Ok(drawn)
    }
}
