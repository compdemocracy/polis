//! Importance: the 2019 per-voter helper, and the two routing terms that
//! adapt importance marks into a multiplier on a comment's weight.
//!
//! - `issue217-voter-weight/1` is the formula of public issue #217 (2019),
//!   "(totalParticipantVotes / totalStatements) * (arbitraryScalingConstant /
//!   totalUsesOfPrioritization) + 1" with the constant 100. It weighs one
//!   voter's mark on one comment. The issue multiplies the vote matrix by
//!   these values; it does not define a routing factor, so the helper is not
//!   one.
//! - `importance-normalized-lift/1` adapts the helper's aggregates: a
//!   comment's mean voter weight over the conversation's, never below 1, with
//!   an optional cap (none by default: unbounded).
//! - `importance-lift/1` is the bounded pooled lift: the comment's smoothed
//!   share of marked votes over the conversation's own rate, never below 1
//!   and at most `cap`.
//!
//! A term multiplies a scored comment's weight outside the power. It never
//! touches the uniform lane, an unscored comment (which draws at 1) or a
//! fixed meta comment (a constant outside every factor). A comment with no
//! marks gets exactly 1, and a conversation with no marks at all gives every
//! comment exactly 1, so the rule equals its base rule bit for bit.

use crate::corrected::CorrectedWeights;
use crate::frames::{CommentMarks, MarkTotals, VoterWeightFrame};
use crate::historical::Scored;
use crate::registry::number;
use crate::types::{CommentId, Factor, FactorName, ParamError, Refusal, SourceId, Weight};

/// The issue's `arbitraryScalingConstant`.
pub const ISSUE217_SCALING: u64 = 100;

/// One voter, as issue #217 counts them: votes cast (V), marks used (U) and
/// whether this vote carries a mark.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Issue217Voter {
    votes_cast: u64,
    marks_used: u64,
    marked_this: bool,
}

impl Issue217Voter {
    /// Refused: a mark on this vote with no marks used, or more marks used
    /// than votes cast.
    pub fn new(votes_cast: u64, marks_used: u64, marked_this: bool) -> Result<Self, Refusal> {
        if (marked_this && marks_used == 0) || marks_used > votes_cast {
            return Err(Refusal::InvalidVoterMarks);
        }
        Ok(Self {
            votes_cast,
            marks_used,
            marked_this,
        })
    }
}

/// `issue217-voter-weight/1`: `(V / N) * (100 / U) + 1` for a marked vote,
/// exactly 1 for an unmarked one. N is the number of comments in the
/// conversation (the universe the caller declares). Refused: N = 0 for a
/// marked vote, and V > N (votes are distinct current responses). Computed
/// as `1 + (V * 100) / (N * U)`, rounded once using integer remainders,
/// so the result is the double nearest the exact value: 51, 26, 11/6
/// and 4/3 on the issue's own numbers.
pub fn issue217_voter_weight(voter: Issue217Voter, statements: u64) -> Result<f64, Refusal> {
    if voter.votes_cast > statements {
        return Err(Refusal::InvalidVoterMarks);
    }
    if !voter.marked_this {
        return Ok(1.0);
    }
    if statements == 0 {
        return Err(Refusal::InvalidVoterMarks);
    }
    let (v, n, u) = (
        u128::from(voter.votes_cast),
        u128::from(statements),
        u128::from(voter.marks_used),
    );
    let num = v * u128::from(ISSUE217_SCALING);
    let den = n * u;
    Ok(one_plus_ratio(num, den))
}

/// Round 1 + num/den once, ties to even. The caller's validated counts
/// guarantee den > 0 and a result in [1, 101]. Keeping the integer part
/// separate avoids overflowing num + den at the top of the u64 domain.
fn one_plus_ratio(num: u128, den: u128) -> f64 {
    let whole = 1 + (num / den) as u64;
    let fraction_bits = 52 - (u64::BITS - 1 - whole.leading_zeros());
    let mut significand = whole << fraction_bits;
    let mut remainder = num % den;
    for bit in (0..fraction_bits).rev() {
        // Double the remainder modulo den without overflowing u128.
        let complement = den - remainder;
        if remainder >= complement {
            remainder -= complement;
            significand |= 1u64 << bit;
        } else {
            remainder += remainder;
        }
    }
    let complement = den - remainder;
    if remainder > complement || (remainder == complement && significand & 1 != 0) {
        significand += 1;
    }
    // Both integers are exactly representable; division by a power of two
    // is exact, including a carry into the next binade.
    significand as f64 / (1u64 << fraction_bits) as f64
}

/// The parameters of `importance-lift/1`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LiftParams {
    prior_strength: f64,
    cap: f64,
}

impl Default for LiftParams {
    fn default() -> Self {
        Self {
            prior_strength: 20.0,
            cap: 3.0,
        }
    }
}

impl LiftParams {
    /// `prior_strength` (k) in [0, 1e6]; `cap` in [1, 1000].
    pub fn new(prior_strength: f64, cap: f64) -> Result<Self, ParamError> {
        crate::corrected::within("prior_strength", prior_strength, 0.0, 1e6, "[0, 1e6]")?;
        crate::corrected::within("cap", cap, 1.0, 1000.0, "[1, 1000]")?;
        Ok(Self {
            prior_strength: prior_strength + 0.0,
            cap,
        })
    }
    pub fn prior_strength(&self) -> f64 {
        self.prior_strength
    }
    pub fn cap(&self) -> f64 {
        self.cap
    }
}

/// The parameters of `importance-normalized-lift/1`: an optional cap.
#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub struct NormalizedLiftParams {
    cap: Option<f64>,
}

impl NormalizedLiftParams {
    /// `cap`, when given, in [1, 1e6]. None (the default) is unbounded.
    pub fn new(cap: Option<f64>) -> Result<Self, ParamError> {
        if let Some(c) = cap {
            crate::corrected::within("cap", c, 1.0, 1e6, "[1, 1e6], or none")?;
        }
        Ok(Self { cap })
    }
    pub fn cap(&self) -> Option<f64> {
        self.cap
    }
}

/// An importance term with its complete parameters.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum TermParams {
    ImportanceLift1(LiftParams),
    ImportanceNormalizedLift1(NormalizedLiftParams),
}

impl TermParams {
    pub fn name(&self) -> &'static str {
        match self {
            Self::ImportanceLift1(_) => "importance-lift/1",
            Self::ImportanceNormalizedLift1(_) => "importance-normalized-lift/1",
        }
    }
    /// `{"term":<name>,"params":{...}}`, every parameter written out.
    pub fn to_plain(&self) -> String {
        match self {
            Self::ImportanceLift1(p) => format!(
                "{{\"term\":\"importance-lift/1\",\"params\":{{\"prior_strength\":{},\"cap\":{}}}}}",
                number(p.prior_strength),
                number(p.cap)
            ),
            Self::ImportanceNormalizedLift1(p) => format!(
                "{{\"term\":\"importance-normalized-lift/1\",\"params\":{{\"cap\":{}}}}}",
                p.cap.map_or_else(|| "null".to_string(), number)
            ),
        }
    }
    pub(crate) fn from_value(value: &serde_json::Value) -> Result<Self, Refusal> {
        let bad = |why: &str| Refusal::Plain(format!("a term: {why}"));
        let top = value.as_object().ok_or_else(|| bad("not an object"))?;
        crate::registry::exact_keys(top, &["term", "params"], "a term")?;
        let params = top
            .get("params")
            .and_then(serde_json::Value::as_object)
            .ok_or_else(|| bad("params is not an object"))?;
        let float = |k: &str| {
            params
                .get(k)
                .and_then(serde_json::Value::as_f64)
                .ok_or_else(|| bad("a parameter is not a number"))
        };
        match top.get("term").and_then(serde_json::Value::as_str) {
            Some("importance-lift/1") => {
                crate::registry::exact_keys(params, &["prior_strength", "cap"], "params")?;
                LiftParams::new(float("prior_strength")?, float("cap")?)
                    .map(Self::ImportanceLift1)
                    .map_err(Refusal::Param)
            }
            Some("importance-normalized-lift/1") => {
                crate::registry::exact_keys(params, &["cap"], "params")?;
                let cap = match params.get("cap") {
                    Some(serde_json::Value::Null) => None,
                    _ => Some(float("cap")?),
                };
                NormalizedLiftParams::new(cap)
                    .map(Self::ImportanceNormalizedLift1)
                    .map_err(Refusal::Param)
            }
            _ => Err(bad("unknown term")),
        }
    }
}

/// The inputs a term reads: the marks for `importance-lift/1`, the 2019
/// voter-weight aggregates for `importance-normalized-lift/1`.
#[derive(Clone, Copy, Debug)]
pub enum TermInputs<'a> {
    /// Per-comment marks and the conversation's totals, or `None` where
    /// unavailable (never a zero).
    Marks {
        comments: Option<&'a CommentMarks>,
        totals: Option<&'a MarkTotals>,
    },
    VoterWeights(&'a VoterWeightFrame),
}

/// The pooled rate rho = marked / eligible over the conversation, or None
/// when unavailable (no totals, no eligible votes, or no marks at all).
fn pooled_rate(
    comments: Option<&CommentMarks>,
    totals: Option<&MarkTotals>,
) -> Result<Option<f64>, Refusal> {
    let Some(t) = totals else {
        return Ok(None);
    };
    // Validated here, at this term's own boundary, whatever the frames
    // checked: one source and cohort, with the combined marked and unmarked
    // counts no greater than the conversation's totals. Missing comments may
    // account for the remainder; they cannot account for negative counts.
    if let Some(c) = comments {
        if c.source() != t.source() || c.cohort() != t.cohort() {
            return Err(Refusal::MarksSourceMismatch);
        }
        let (marked, eligible) =
            c.iter()
                .try_fold((0u64, 0u64), |(marked, eligible), (_, m)| {
                    Ok::<_, Refusal>((
                        marked
                            .checked_add(m.marked())
                            .ok_or(Refusal::CountOverflow)?,
                        eligible
                            .checked_add(m.eligible())
                            .ok_or(Refusal::CountOverflow)?,
                    ))
                })?;
        if marked > t.totals().marked()
            || eligible > t.totals().eligible()
            || eligible - marked > t.totals().eligible() - t.totals().marked()
        {
            return Err(Refusal::MarksAboveTotal);
        }
    }
    let (marked, eligible) = (t.totals().marked(), t.totals().eligible());
    if marked == 0 || eligible == 0 {
        return Ok(None);
    }
    Ok(Some(marked as f64 / eligible as f64))
}

/// The multiplier one term gives one comment. Exactly 1 by an explicit branch
/// wherever the term has nothing to say.
fn multiplier(
    term: &TermParams,
    inputs: &TermInputs<'_>,
    rho: Option<f64>,
    comment: CommentId,
) -> Result<f64, Refusal> {
    match (term, inputs) {
        (TermParams::ImportanceLift1(p), TermInputs::Marks { comments, .. }) => {
            let (Some(rho), Some(m)) = (rho, comments.and_then(|c| c.get(comment))) else {
                return Ok(1.0);
            };
            if m.eligible() == 0 {
                return Ok(1.0);
            }
            let k = p.prior_strength;
            let r = (m.marked() as f64 + k * rho) / (m.eligible() as f64 + k);
            Ok((r / rho).clamp(1.0, p.cap))
        }
        (TermParams::ImportanceNormalizedLift1(p), TermInputs::VoterWeights(frame)) => {
            let totals = frame.totals();
            let Some(this) = frame.get(comment) else {
                return Ok(1.0);
            };
            if this.voters() == 0 || totals.voters() == 0 {
                return Ok(1.0);
            }
            let i = this.weight_sum() / this.voters() as f64;
            let mean = totals.weight_sum() / totals.voters() as f64;
            let m = (i / mean).max(1.0);
            Ok(p.cap.map_or(m, |c| m.min(c)))
        }
        _ => Err(Refusal::TermInputsMismatch),
    }
}

/// The per-comment multipliers one term gives, for every comment the base
/// rule scored (a test and replay aid; `with_importance` applies them).
pub fn importance_multipliers(
    weights: &CorrectedWeights,
    term: &TermParams,
    inputs: &TermInputs<'_>,
) -> Result<Vec<(CommentId, f64)>, Refusal> {
    if !matches!(
        (term, inputs),
        (TermParams::ImportanceLift1(_), TermInputs::Marks { .. })
            | (
                TermParams::ImportanceNormalizedLift1(_),
                TermInputs::VoterWeights(_)
            )
    ) {
        return Err(Refusal::TermInputsMismatch);
    }
    let rho = match inputs {
        TermInputs::Marks { comments, totals } => pooled_rate(*comments, *totals)?,
        TermInputs::VoterWeights(_) => None,
    };
    weights
        .scored()
        .map(|(id, _)| multiplier(term, inputs, rho, id).map(|m| (id, m)))
        .collect()
}

/// The base rule's weights with one importance term composed outside the
/// power. A scored comment's explanation gains the factor `importance`; a
/// fixed meta comment and an unscored comment are left as they are. Refused:
/// a term already present (`RepeatedTerm`), inputs of the other term's kind
/// (`TermInputsMismatch`), marks that disagree with their totals, and a
/// weight that would leave [0, 1e150] (`WeightOutOfRange`, term
/// `importance`). `source` names the term's input frame in the provenance.
pub fn with_importance(
    weights: CorrectedWeights,
    term: TermParams,
    inputs: TermInputs<'_>,
    source: SourceId,
) -> Result<CorrectedWeights, Refusal> {
    if !weights.terms().is_empty() {
        return Err(Refusal::RepeatedTerm);
    }
    let factors = importance_multipliers(&weights, &term, &inputs)?;
    let mut rescored = Vec::with_capacity(factors.len());
    for (id, m) in factors {
        let Some(s) = weights.get(id) else {
            continue;
        };
        let e = s.explanation();
        let fixed_meta = e
            .inner()
            .first()
            .is_some_and(|f| f.name() == FactorName::Meta);
        if fixed_meta {
            continue;
        }
        let mut outer = e.outer().to_vec();
        outer.push(Factor::new(FactorName::Importance, m));
        let explanation = crate::types::Explanation::new(e.inner().to_vec(), e.exponent(), outer);
        let value = explanation
            .evaluate_checked()
            .map_err(|(_, t)| Refusal::WeightOutOfRange {
                comment: id,
                term: t,
            })?;
        let weight = Weight::checked(value).ok_or(Refusal::WeightOutOfRange {
            comment: id,
            term: "importance",
        })?;
        rescored.push((id, Scored::new(weight, explanation)));
    }
    Ok(weights.with_term(term, source, rescored))
}
