//! `stored-weights/1` and the shared draw arithmetic, `legacy-cdf/1`.
//!
//! The arithmetic is today's inverse CDF, as the Node server's
//! `selectProbabilistically` (`server/src/nextComment.ts`) and the Rust
//! selector's `select` (`queue-rs/polis-api/src/next_comment.rs`) compute it:
//! running sums in the candidates' order, `random_n = unit * total`, and the
//! first candidate whose running sum is greater than `random_n`.

use crate::historical::HistoricalWeights;
use crate::registry::{ParamSet, RuleId};
use crate::types::{CommentId, DrawRefusal, MAX_CANDIDATES, Refusal, SourceId, WEIGHT_CEILING};
use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

/// 2^-1021: below this total the arithmetic can fail to choose anything.
pub const MIN_TOTAL: f64 = 2.0 * f64::MIN_POSITIVE;

/// The caller's random number, finite and in [0, 1). The crate has no
/// randomness of its own. A negative zero is read as zero.
#[derive(Clone, Copy, Debug, PartialEq, PartialOrd, Serialize)]
pub struct Unit(f64);

impl Unit {
    pub fn new(value: f64) -> Result<Self, DrawRefusal> {
        if !value.is_finite() || !(0.0..1.0).contains(&value) {
            return Err(DrawRefusal::UnitOutOfRange);
        }
        Ok(Self(if value == 0.0 { 0.0 } else { value }))
    }
    pub fn get(self) -> f64 {
        self.0
    }
}

/// The participant's eligible comments, in the caller's order (both selectors
/// order them by creation). Not empty, no duplicates, at most 2^24.
#[derive(Clone, Debug, PartialEq)]
pub struct Candidates(Vec<CommentId>);

impl Candidates {
    pub fn new(ids: Vec<CommentId>) -> Result<Self, DrawRefusal> {
        if ids.is_empty() {
            return Err(DrawRefusal::Empty);
        }
        if ids.len() > MAX_CANDIDATES {
            return Err(DrawRefusal::TooManyCandidates(ids.len()));
        }
        let mut seen = BTreeSet::new();
        for id in &ids {
            if !seen.insert(*id) {
                return Err(DrawRefusal::DuplicateCandidate(*id));
            }
        }
        Ok(Self(ids))
    }
    pub fn ids(&self) -> &[CommentId] {
        &self.0
    }
    pub fn len(&self) -> usize {
        self.0.len()
    }
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
    /// FNV-1a 64 over the ids in order, each as four little-endian bytes: an
    /// identity check on the order that drew, not cryptography.
    pub fn order_digest(&self) -> u64 {
        let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
        for id in &self.0 {
            for byte in id.get().to_le_bytes() {
                hash ^= u64::from(byte);
                hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
            }
        }
        hash
    }
}

/// One value of the math result's `comment-priorities`, as both readers read
/// it: a number, `null` or `false`.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub enum StoredWeight {
    Number(f64),
    Null,
    False,
}

/// The math result's `comment-priorities` map, with its source.
#[derive(Clone, Debug, PartialEq)]
pub struct StoredWeights {
    source: SourceId,
    map: BTreeMap<CommentId, StoredWeight>,
}

impl StoredWeights {
    pub fn new(
        source: SourceId,
        entries: impl IntoIterator<Item = (CommentId, StoredWeight)>,
    ) -> Result<Self, Refusal> {
        let mut map = BTreeMap::new();
        for (id, w) in entries {
            if map.contains_key(&id) {
                return Err(Refusal::DuplicateComment(id));
            }
            map.insert(id, w);
        }
        Ok(Self { source, map })
    }

    /// Reads the stored JSON object. Refused: malformed JSON, a duplicate key,
    /// the legacy array shape, a key that is not a comment id written as the
    /// selectors write one (decimal, no sign, no leading zero), and a value
    /// that is not a number, `null` or `false`.
    pub fn from_json(source: SourceId, json: &str) -> Result<Self, Refusal> {
        crate::dupkeys::check(json).map_err(Refusal::Plain)?;
        let value: Value = serde_json::from_str(json).map_err(|e| Refusal::Plain(e.to_string()))?;
        let object = match value {
            Value::Object(object) => object,
            Value::Array(_) => return Err(Refusal::UnsupportedLegacyShape("an array")),
            _ => return Err(Refusal::UnsupportedLegacyShape("not an object")),
        };
        let mut entries = Vec::with_capacity(object.len());
        for (key, value) in object {
            let tid = key
                .parse::<u32>()
                .ok()
                .filter(|tid| tid.to_string() == key)
                .ok_or(Refusal::UnsupportedLegacyShape(
                    "a key that is not a comment id",
                ))?;
            let weight = match value {
                Value::Number(n) => StoredWeight::Number(n.as_f64().ok_or(
                    Refusal::UnsupportedLegacyShape("a number that is not a double"),
                )?),
                Value::Null => StoredWeight::Null,
                Value::Bool(false) => StoredWeight::False,
                _ => {
                    return Err(Refusal::UnsupportedLegacyShape(
                        "a value that is not a number, null or false",
                    ));
                }
            };
            entries.push((CommentId::new(tid), weight));
        }
        Self::new(source, entries)
    }

    /// The weights `historical/1` gave, as a stored map: each scored comment
    /// its weight; unscored comments are absent (and so draw at 1).
    pub fn from_historical(source: SourceId, weights: &HistoricalWeights) -> Self {
        Self {
            source,
            map: weights
                .scored()
                .map(|(id, s)| (id, StoredWeight::Number(s.weight().get())))
                .collect(),
        }
    }

    pub fn source(&self) -> &SourceId {
        &self.source
    }
    pub fn get(&self, id: CommentId) -> Option<StoredWeight> {
        self.map.get(&id).copied()
    }
}

/// The result of the shared arithmetic over a list of draw weights.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Cdf {
    index: usize,
    random_n: f64,
    total: f64,
    probability: f64,
    absorbed: Vec<usize>,
}

impl Cdf {
    pub fn index(&self) -> usize {
        self.index
    }
    pub fn random_n(&self) -> f64 {
        self.random_n
    }
    pub fn total(&self) -> f64 {
        self.total
    }
    /// `q = fl(d / total)` for the chosen candidate: its probability under the
    /// rule, true to within 2^-50 when the total is at least 2^-1021.
    pub fn probability(&self) -> f64 {
        self.probability
    }
    /// Positions with a positive draw weight that the running sum absorbed:
    /// they have no interval of units and cannot be chosen.
    pub fn absorbed(&self) -> &[usize] {
        &self.absorbed
    }
}

/// `legacy-cdf/1`, the arithmetic every rule draws with. Each draw weight must
/// be finite and in [0, 1e150]; the total must be at least 2^-1021. Nothing is
/// repaired.
pub fn cdf(draw_weights: &[f64], unit: Unit) -> Result<Cdf, DrawRefusal> {
    if draw_weights.is_empty() {
        return Err(DrawRefusal::Empty);
    }
    if draw_weights.len() > MAX_CANDIDATES {
        return Err(DrawRefusal::TooManyCandidates(draw_weights.len()));
    }
    if let Some(bad) = draw_weights
        .iter()
        .position(|w| !(w.is_finite() && (0.0..=WEIGHT_CEILING).contains(w)))
    {
        return Err(DrawRefusal::InvalidDrawWeight(bad));
    }
    let mut cumulative = Vec::with_capacity(draw_weights.len());
    let mut total = 0.0f64;
    let mut absorbed = Vec::new();
    for (i, w) in draw_weights.iter().enumerate() {
        let before = total;
        total += w;
        if *w > 0.0 && total == before {
            absorbed.push(i);
        }
        cumulative.push(total);
    }
    if total < MIN_TOTAL {
        return Err(DrawRefusal::TotalBelowNormal);
    }
    let random_n = unit.get() * total;
    let index = cumulative
        .iter()
        .position(|c| *c > random_n)
        .ok_or(DrawRefusal::NoInterval)?;
    let chosen = draw_weights
        .get(index)
        .copied()
        .ok_or(DrawRefusal::NoInterval)?;
    Ok(Cdf {
        index,
        random_n,
        total,
        probability: chosen / total,
        absorbed,
    })
}

/// The draw modes. Piece by piece more are added; a published mode's
/// arithmetic never changes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DrawMode {
    LegacyCdf1,
}

impl DrawMode {
    pub fn name(self) -> &'static str {
        match self {
            Self::LegacyCdf1 => "legacy-cdf/1",
        }
    }
}

impl Serialize for DrawMode {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(self.name())
    }
}

/// One lane's part in a receipt: its effective share, its normaliser and its
/// contribution to the chosen comment's probability.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Lane {
    lane: &'static str,
    share: f64,
    normaliser: f64,
    contribution: f64,
}

impl Lane {
    pub fn lane(&self) -> &'static str {
        self.lane
    }
    pub fn share(&self) -> f64 {
        self.share
    }
    pub fn normaliser(&self) -> f64 {
        self.normaliser
    }
    pub fn contribution(&self) -> f64 {
        self.contribution
    }
}

/// What the legacy mapping did, and which candidates could not be reached.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct DrawFlags {
    zero_mapped_to_one: usize,
    null_or_false_mapped_to_one: usize,
    absent_mapped_to_one: usize,
    absorbed: Vec<CommentId>,
    donations: Vec<String>,
}

impl DrawFlags {
    pub fn zero_mapped_to_one(&self) -> usize {
        self.zero_mapped_to_one
    }
    pub fn null_or_false_mapped_to_one(&self) -> usize {
        self.null_or_false_mapped_to_one
    }
    pub fn absent_mapped_to_one(&self) -> usize {
        self.absent_mapped_to_one
    }
    pub fn absorbed(&self) -> &[CommentId] {
        &self.absorbed
    }
    pub fn donations(&self) -> &[String] {
        &self.donations
    }
}

/// The receipt of a draw: which comment, the chance it had, and everything
/// needed to say what drew it. The crate stores and logs nothing; the caller
/// keeps it.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Drawn {
    comment: CommentId,
    index: usize,
    random_n: f64,
    probability: f64,
    rule: RuleId,
    params: String,
    draw_mode: DrawMode,
    lanes: Vec<Lane>,
    sampled_lane: Option<String>,
    flags: DrawFlags,
    candidate_count: usize,
    candidate_order_digest: u64,
    sources: Vec<SourceId>,
    input_source: SourceId,
}

impl Drawn {
    pub fn comment(&self) -> CommentId {
        self.comment
    }
    pub fn index(&self) -> usize {
        self.index
    }
    pub fn random_n(&self) -> f64 {
        self.random_n
    }
    pub fn probability(&self) -> f64 {
        self.probability
    }
    pub fn rule(&self) -> RuleId {
        self.rule
    }
    /// The rule's complete canonical parameter form.
    pub fn params(&self) -> &str {
        &self.params
    }
    pub fn draw_mode(&self) -> DrawMode {
        self.draw_mode
    }
    pub fn lanes(&self) -> &[Lane] {
        &self.lanes
    }
    /// Always `None`: no lane is sampled; the draw samples the marginal.
    pub fn sampled_lane(&self) -> Option<&str> {
        self.sampled_lane.as_deref()
    }
    pub fn flags(&self) -> &DrawFlags {
        &self.flags
    }
    pub fn candidate_count(&self) -> usize {
        self.candidate_count
    }
    pub fn candidate_order_digest(&self) -> u64 {
        self.candidate_order_digest
    }
    pub fn sources(&self) -> &[SourceId] {
        &self.sources
    }
    pub fn input_source(&self) -> &SourceId {
        &self.input_source
    }
}

/// `stored-weights/1`: today's draw, exactly, over the stored map (`None`
/// when the conversation has no map, as Node's `latestPriorities || {}`).
///
/// Each candidate's draw weight is its stored value after the legacy mapping:
/// absent, `null`, `false` or 0 become 1; a finite number above 0 and at most
/// 1e150 is itself; anything else is `UnsupportedLegacyWeight`.
pub fn stored_weights_1(
    weights: Option<&StoredWeights>,
    candidates: &Candidates,
    unit: Unit,
    input_source: &SourceId,
) -> Result<Drawn, DrawRefusal> {
    let mut flags = DrawFlags::default();
    let mut draw_weights = Vec::with_capacity(candidates.len());
    for id in candidates.ids() {
        let w = match weights.and_then(|m| m.get(*id)) {
            None => {
                flags.absent_mapped_to_one += 1;
                1.0
            }
            Some(StoredWeight::Null | StoredWeight::False) => {
                flags.null_or_false_mapped_to_one += 1;
                1.0
            }
            Some(StoredWeight::Number(0.0)) => {
                flags.zero_mapped_to_one += 1;
                1.0
            }
            Some(StoredWeight::Number(n)) if n.is_finite() && n > 0.0 && n <= WEIGHT_CEILING => n,
            Some(StoredWeight::Number(_)) => return Err(DrawRefusal::UnsupportedLegacyWeight(*id)),
        };
        draw_weights.push(w);
    }
    let pick = cdf(&draw_weights, unit)?;
    let comment = candidates
        .ids()
        .get(pick.index)
        .copied()
        .ok_or(DrawRefusal::NoInterval)?;
    flags.absorbed = pick
        .absorbed
        .iter()
        .filter_map(|i| candidates.ids().get(*i).copied())
        .collect();
    Ok(Drawn {
        comment,
        index: pick.index,
        random_n: pick.random_n,
        probability: pick.probability,
        rule: RuleId::StoredWeights1,
        params: ParamSet::StoredWeights1.to_plain(),
        draw_mode: DrawMode::LegacyCdf1,
        lanes: vec![Lane {
            lane: "weights",
            share: 1.0,
            normaliser: pick.total,
            contribution: pick.probability,
        }],
        sampled_lane: None,
        flags,
        candidate_count: candidates.len(),
        candidate_order_digest: candidates.order_digest(),
        sources: weights.map(|w| w.source().clone()).into_iter().collect(),
        input_source: input_source.clone(),
    })
}
