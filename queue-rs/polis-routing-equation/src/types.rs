//! The inputs and outputs every rule shares: identifiers, counts, frames,
//! extremity, weights, explanations and the refusals.
//!
//! Every public type keeps its fields private and is built only through a
//! constructor that validates it; where a type is read from JSON, the reading
//! goes through the same constructor.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fmt;

/// The largest weight any rule may produce. It keeps a sum of up to
/// `MAX_CANDIDATES` weights finite (2^24 x 1e150 < 1.8e308).
pub const WEIGHT_CEILING: f64 = 1e150;

/// The most candidates one draw accepts (2^24).
pub const MAX_CANDIDATES: usize = 1 << 24;

/// A comment's `tid`. Built from the selectors' `i32` with `try_from`, which
/// refuses a negative id.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(try_from = "i64", into = "u32")]
pub struct CommentId(u32);

impl CommentId {
    pub const fn new(tid: u32) -> Self {
        Self(tid)
    }
    pub fn get(self) -> u32 {
        self.0
    }
}

impl TryFrom<i32> for CommentId {
    type Error = Refusal;
    fn try_from(tid: i32) -> Result<Self, Refusal> {
        u32::try_from(tid)
            .map(Self)
            .map_err(|_| Refusal::CommentIdOutOfRange(i64::from(tid)))
    }
}

impl TryFrom<i64> for CommentId {
    type Error = Refusal;
    fn try_from(tid: i64) -> Result<Self, Refusal> {
        u32::try_from(tid)
            .map(Self)
            .map_err(|_| Refusal::CommentIdOutOfRange(tid))
    }
}

impl From<CommentId> for u32 {
    fn from(id: CommentId) -> u32 {
        id.0
    }
}

impl fmt::Display for CommentId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// An opinion group's id as the math writes it. Ids may be sparse (0, 2, 7):
/// groups are kept in ordered maps, so iteration follows the id and never a
/// position, and every sum over groups is order-independent.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct GroupId(u32);

impl GroupId {
    pub fn new(id: u32) -> Self {
        Self(id)
    }
    pub fn get(self) -> u32 {
        self.0
    }
}

impl fmt::Display for GroupId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// An opaque identity, supplied by the caller, for where an input came from (a
/// math generation, a tick, a run): 1 to 128 printable ASCII bytes. The crate
/// never interprets it; it carries it into results and receipts so that a
/// replay can say what fed what.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct SourceId(String);

impl SourceId {
    pub fn new(id: impl Into<String>) -> Result<Self, Refusal> {
        let id = id.into();
        if id.is_empty() || id.len() > 128 || !id.bytes().all(|b| (0x20..=0x7e).contains(&b)) {
            return Err(Refusal::InvalidSourceId);
        }
        Ok(Self(id))
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for SourceId {
    type Error = Refusal;
    fn try_from(id: String) -> Result<Self, Refusal> {
        Self::new(id)
    }
}

impl From<SourceId> for String {
    fn from(id: SourceId) -> String {
        id.0
    }
}

/// How many participants agreed with, disagreed with and passed on one
/// comment: three unsigned counts, each by name. There is no vote type in this
/// crate and no signed number that could stand for one; what a stored or an
/// exported vote value means is decided by whoever counts.
///
/// Seen is never stored: it is `agreed + disagreed + passed`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(from = "CountsRaw")]
pub struct Counts {
    agreed: u32,
    disagreed: u32,
    passed: u32,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CountsRaw {
    agreed: u32,
    disagreed: u32,
    passed: u32,
}

impl From<CountsRaw> for Counts {
    fn from(raw: CountsRaw) -> Self {
        Self::new(raw.agreed, raw.disagreed, raw.passed)
    }
}

impl Counts {
    pub fn new(agreed: u32, disagreed: u32, passed: u32) -> Self {
        Self {
            agreed,
            disagreed,
            passed,
        }
    }

    /// From the math engine's `{A, D, S}` shape: passes are
    /// `S - (A + D)`, as the engine computes them. A seen count below
    /// `A + D` is refused.
    pub fn from_seen(agreed: u32, disagreed: u32, seen: u64) -> Result<Self, Refusal> {
        let voted = u64::from(agreed) + u64::from(disagreed);
        if seen < voted {
            return Err(Refusal::SeenBelowVotes {
                agreed,
                disagreed,
                seen,
            });
        }
        let passed = u32::try_from(seen - voted).map_err(|_| Refusal::CountOverflow)?;
        Ok(Self::new(agreed, disagreed, passed))
    }

    pub fn agreed(self) -> u32 {
        self.agreed
    }
    pub fn disagreed(self) -> u32 {
        self.disagreed
    }
    pub fn passed(self) -> u32 {
        self.passed
    }

    /// `agreed + disagreed + passed`. Three `u32` values sum to at most
    /// 3 x (2^32 - 1), so this sum in `u64` is exact and cannot wrap.
    pub fn seen(self) -> u64 {
        u64::from(self.agreed) + u64::from(self.disagreed) + u64::from(self.passed)
    }
}

fn unique_map<V>(
    cells: impl IntoIterator<Item = (CommentId, V)>,
) -> Result<BTreeMap<CommentId, V>, Refusal> {
    let mut map = BTreeMap::new();
    for (id, value) in cells {
        // A duplicate is refused before insertion, so no value is overwritten.
        if map.contains_key(&id) {
            return Err(Refusal::DuplicateComment(id));
        }
        map.insert(id, value);
    }
    Ok(map)
}

/// The per-comment counts the historical equation consumes, already summed
/// over the previous scoring tick's opinion groups. A comment absent from the
/// frame was not scored in that tick; it does not mean zero votes.
#[derive(Clone, Debug, PartialEq)]
pub struct HistoricalCountFrame {
    source: SourceId,
    cells: BTreeMap<CommentId, Counts>,
}

impl HistoricalCountFrame {
    pub fn new(
        source: SourceId,
        cells: impl IntoIterator<Item = (CommentId, Counts)>,
    ) -> Result<Self, Refusal> {
        Ok(Self {
            source,
            cells: unique_map(cells)?,
        })
    }
    pub fn source(&self) -> &SourceId {
        &self.source
    }
    pub fn get(&self, id: CommentId) -> Option<Counts> {
        self.cells.get(&id).copied()
    }
    pub fn len(&self) -> usize {
        self.cells.len()
    }
    pub fn is_empty(&self) -> bool {
        self.cells.is_empty()
    }
    pub fn ids(&self) -> impl Iterator<Item = CommentId> + '_ {
        self.cells.keys().copied()
    }
    /// The votes seen across every comment of the frame, refused rather than
    /// wrapped if the sum leaves `u64`.
    pub fn total_seen(&self) -> Result<u64, Refusal> {
        self.cells.values().try_fold(0u64, |sum, c| {
            sum.checked_add(c.seen()).ok_or(Refusal::CountOverflow)
        })
    }
}

/// A comment's extremity: finite and not negative. Its one source is the math
/// result's stored `pca.comment-extremity`, aligned by the result's `tids`; a
/// caller passes the stored value through and never recomputes it.
#[derive(Clone, Copy, Debug, PartialEq, PartialOrd, Serialize, Deserialize)]
#[serde(try_from = "f64", into = "f64")]
pub struct Extremity(f64);

impl Extremity {
    pub fn new(value: f64) -> Result<Self, Refusal> {
        if !value.is_finite() || value < 0.0 {
            return Err(Refusal::InvalidExtremity);
        }
        Ok(Self(value))
    }
    pub fn get(self) -> f64 {
        self.0
    }
}

impl TryFrom<f64> for Extremity {
    type Error = Refusal;
    fn try_from(value: f64) -> Result<Self, Refusal> {
        Self::new(value)
    }
}

impl From<Extremity> for f64 {
    fn from(e: Extremity) -> f64 {
        e.0
    }
}

/// The current tick's extremity for each comment.
#[derive(Clone, Debug, PartialEq)]
pub struct ExtremityFrame {
    source: SourceId,
    values: BTreeMap<CommentId, Extremity>,
}

impl ExtremityFrame {
    pub fn new(
        source: SourceId,
        values: impl IntoIterator<Item = (CommentId, Extremity)>,
    ) -> Result<Self, Refusal> {
        Ok(Self {
            source,
            values: unique_map(values)?,
        })
    }
    pub fn source(&self) -> &SourceId {
        &self.source
    }
    pub fn get(&self, id: CommentId) -> Option<Extremity> {
        self.values.get(&id).copied()
    }
    pub fn ids(&self) -> impl Iterator<Item = CommentId> + '_ {
        self.values.keys().copied()
    }
}

/// A rule's weight for one comment: finite, not negative and at most
/// `WEIGHT_CEILING`. Only this crate builds one.
#[derive(Clone, Copy, Debug, PartialEq, PartialOrd, Serialize)]
pub struct Weight(f64);

impl Weight {
    pub(crate) fn checked(value: f64) -> Option<Self> {
        (value.is_finite() && (0.0..=WEIGHT_CEILING).contains(&value)).then_some(Self(value))
    }
    pub fn get(self) -> f64 {
        self.0
    }
}

/// The stable names of the factors an explanation can hold.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FactorName {
    AgreeShare,
    NotPassShare,
    SideShare,
    ExtremityBoost,
    AxisBoost,
    Novelty,
    Meta,
    GroupConsensus,
    Importance,
}

impl FactorName {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::AgreeShare => "agree_share",
            Self::NotPassShare => "not_pass_share",
            Self::SideShare => "side_share",
            Self::ExtremityBoost => "extremity_boost",
            Self::AxisBoost => "axis_boost",
            Self::Novelty => "novelty",
            Self::Meta => "meta",
            Self::GroupConsensus => "group_consensus",
            Self::Importance => "importance",
        }
    }
}

/// One named factor of a weight and its value.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct Factor {
    name: FactorName,
    value: f64,
}

impl Factor {
    pub(crate) fn new(name: FactorName, value: f64) -> Self {
        Self { name, value }
    }
    pub fn name(self) -> FactorName {
        self.name
    }
    pub fn value(self) -> f64 {
        self.value
    }
}

/// How a weight was made: the factors inside the power, multiplied left to
/// right; the power, taken by repeated multiplication; then the factors
/// outside it, left to right. A rule computes its weight by evaluating its
/// explanation, so the two agree bit for bit (a property of this
/// implementation, not evidence from an independent oracle).
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Explanation {
    inner: Vec<Factor>,
    exponent: u8,
    outer: Vec<Factor>,
}

impl Explanation {
    pub(crate) fn new(inner: Vec<Factor>, exponent: u8, outer: Vec<Factor>) -> Self {
        Self {
            inner,
            exponent,
            outer,
        }
    }
    pub fn inner(&self) -> &[Factor] {
        &self.inner
    }
    pub fn exponent(&self) -> u8 {
        self.exponent
    }
    pub fn outer(&self) -> &[Factor] {
        &self.outer
    }

    /// The weight, evaluated left to right.
    pub fn evaluate(&self) -> f64 {
        match self.evaluate_checked() {
            Ok(v) | Err((v, _)) => v,
        }
    }

    /// The weight, or the first step at which the running value left the
    /// finite range `[0, WEIGHT_CEILING]` together with that step's name.
    pub(crate) fn evaluate_checked(&self) -> Result<f64, (f64, &'static str)> {
        let in_range = |v: f64| v.is_finite() && (0.0..=WEIGHT_CEILING).contains(&v);
        let mut base = 1.0f64;
        for f in &self.inner {
            if !in_range(f.value) {
                return Err((f.value, f.name.as_str()));
            }
            base *= f.value;
            if !in_range(base) {
                return Err((base, f.name.as_str()));
            }
        }
        let mut value = base;
        for _ in 1..self.exponent {
            value *= base;
        }
        if !in_range(value) {
            return Err((value, "power"));
        }
        for f in &self.outer {
            value *= f.value;
            if !in_range(value) {
                return Err((value, f.name.as_str()));
            }
        }
        Ok(value)
    }
}

/// Why a parameter was refused: its name, the value given and the range it
/// must lie in.
#[derive(Clone, Debug, PartialEq)]
pub struct ParamError {
    pub name: &'static str,
    pub value: String,
    pub allowed: &'static str,
}

impl fmt::Display for ParamError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "parameter {} = {} is outside {}",
            self.name, self.value, self.allowed
        )
    }
}

impl std::error::Error for ParamError {}

/// Why an input, a parameter set or a rule was refused. Every public function
/// of the crate returns one of these instead of panicking.
#[derive(Clone, Debug, PartialEq)]
pub enum Refusal {
    CommentIdOutOfRange(i64),
    InvalidSourceId,
    SeenBelowVotes {
        agreed: u32,
        disagreed: u32,
        seen: u64,
    },
    CountOverflow,
    DuplicateComment(CommentId),
    InvalidExtremity,
    WeightOutOfRange {
        comment: CommentId,
        term: &'static str,
    },
    /// The stored weights are not an object of comment ids, or hold a value
    /// that is not a number, `null` or `false` (the legacy array shape is one).
    UnsupportedLegacyShape(&'static str),
    Param(ParamError),
    UnknownRule {
        asked: String,
        known: Vec<&'static str>,
    },
    /// Malformed JSON, or a canonical parameter form with an unknown, missing
    /// or duplicate key, or a term this version does not know.
    Plain(String),
    /// A group is given twice in a group frame's members.
    DuplicateGroup(GroupId),
    /// A group with no members. A group frame lists only groups that exist.
    EmptyGroup(GroupId),
    /// A cell or a mark names a group that is not among the frame's members.
    UnknownGroup {
        group: GroupId,
        comment: CommentId,
    },
    /// The same (group, comment) cell is given twice.
    DuplicateCell {
        group: GroupId,
        comment: CommentId,
    },
    /// More of a group saw a comment than the group has members.
    SeenAboveMembers {
        group: GroupId,
        comment: CommentId,
    },
    /// The groups' members add up to more than the declared participants.
    MembersAboveParticipants,
    /// More participants saw a comment than the conversation has.
    SeenAboveParticipants(CommentId),
    /// Two frames of one tick disagree: the groups' counts for a comment
    /// exceed everyone's in the named field.
    FrameInconsistent {
        comment: CommentId,
        field: &'static str,
    },
    /// More marks than votes that could carry one.
    MarksAboveEligible,
    /// Importance inputs that must come from one frame name different sources
    /// or cohorts.
    MarksSourceMismatch,
    /// The per-comment marks add up to more than the conversation's total.
    MarksAboveTotal,
    /// Group marks were given without a current group frame of their source.
    GroupMarksWithoutGroups,
    /// A group's eligible votes on a comment exceed the group's members.
    MarksAboveMembers {
        group: GroupId,
        comment: CommentId,
    },
    /// A voter-weight aggregate is not finite, is below its voter count, or
    /// is non-zero with no voters (the comment, or none for the totals).
    InvalidVoterWeight(Option<CommentId>),
    /// The per-comment voter-weight aggregates exceed the conversation's
    /// totals.
    VoterWeightAboveTotal,
}

impl fmt::Display for Refusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::CommentIdOutOfRange(t) => write!(f, "comment id {t} is not a u32"),
            Self::InvalidSourceId => f.write_str("a source id is 1 to 128 printable ASCII bytes"),
            Self::SeenBelowVotes {
                agreed,
                disagreed,
                seen,
            } => write!(
                f,
                "seen {seen} is below agreed {agreed} + disagreed {disagreed}"
            ),
            Self::CountOverflow => f.write_str("a count overflowed"),
            Self::DuplicateComment(id) => write!(f, "comment {id} is given twice"),
            Self::InvalidExtremity => f.write_str("extremity must be finite and not negative"),
            Self::WeightOutOfRange { comment, term } => {
                write!(f, "comment {comment}: the weight left its range at {term}")
            }
            Self::UnsupportedLegacyShape(what) => write!(f, "unsupported stored weights: {what}"),
            Self::Param(e) => e.fmt(f),
            Self::UnknownRule { asked, known } => {
                write!(f, "unknown rule {asked:?}; known: {}", known.join(", "))
            }
            Self::Plain(why) => write!(f, "plain form refused: {why}"),
            Self::DuplicateGroup(g) => write!(f, "group {g} is given twice"),
            Self::EmptyGroup(g) => write!(f, "group {g} has no members"),
            Self::UnknownGroup { group, comment } => {
                write!(f, "comment {comment}: group {group} is not in the frame")
            }
            Self::DuplicateCell { group, comment } => {
                write!(f, "group {group}, comment {comment} is given twice")
            }
            Self::SeenAboveMembers { group, comment } => {
                write!(
                    f,
                    "comment {comment}: group {group} saw it more than its members"
                )
            }
            Self::MembersAboveParticipants => {
                f.write_str("the groups' members exceed the participants")
            }
            Self::SeenAboveParticipants(c) => {
                write!(f, "comment {c}: seen by more than the participants")
            }
            Self::FrameInconsistent { comment, field } => {
                write!(
                    f,
                    "comment {comment}: the groups' {field} exceed everyone's"
                )
            }
            Self::MarksAboveEligible => f.write_str("marked exceeds eligible"),
            Self::MarksSourceMismatch => {
                f.write_str("importance inputs name different sources or cohorts")
            }
            Self::MarksAboveTotal => f.write_str("the comments' marks exceed the total"),
            Self::GroupMarksWithoutGroups => {
                f.write_str("group marks need a current group frame of their source")
            }
            Self::MarksAboveMembers { group, comment } => {
                write!(
                    f,
                    "comment {comment}: group {group}'s eligible votes exceed its members"
                )
            }
            Self::InvalidVoterWeight(Some(c)) => write!(f, "comment {c}: invalid voter weights"),
            Self::InvalidVoterWeight(None) => f.write_str("invalid voter-weight totals"),
            Self::VoterWeightAboveTotal => {
                f.write_str("the comments' voter weights exceed the totals")
            }
        }
    }
}

impl std::error::Error for Refusal {}

/// Why a draw was refused. A refused draw has no receipt: the caller's own
/// fallback draws, and its receipt names the rule that actually drew.
#[derive(Clone, Debug, PartialEq)]
pub enum DrawRefusal {
    /// The unit is not finite or not in [0, 1).
    UnitOutOfRange,
    Empty,
    DuplicateCandidate(CommentId),
    TooManyCandidates(usize),
    /// A candidate's stored weight is negative, not finite or above
    /// `WEIGHT_CEILING`. Today's read route would draw a finite negative; a
    /// probability cannot be negative, so this rule refuses.
    UnsupportedLegacyWeight(CommentId),
    /// A draw weight given to the shared arithmetic is not finite, negative or
    /// above `WEIGHT_CEILING` (its position in the list).
    InvalidDrawWeight(usize),
    /// The total weight is below 2^-1021, where the arithmetic can fail to
    /// choose anything; refused before drawing.
    TotalBelowNormal,
    /// No running sum exceeded the scaled unit. Proven impossible on the
    /// accepted domain; reported rather than assumed.
    NoInterval,
}

impl fmt::Display for DrawRefusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnitOutOfRange => f.write_str("the unit must be finite and in [0, 1)"),
            Self::Empty => f.write_str("no candidates"),
            Self::DuplicateCandidate(id) => write!(f, "candidate {id} is given twice"),
            Self::TooManyCandidates(n) => write!(f, "{n} candidates is more than 2^24"),
            Self::UnsupportedLegacyWeight(id) => {
                write!(f, "candidate {id}: stored weight outside [0, 1e150]")
            }
            Self::InvalidDrawWeight(i) => write!(f, "draw weight {i} outside [0, 1e150]"),
            Self::TotalBelowNormal => f.write_str("the total weight is below 2^-1021"),
            Self::NoInterval => f.write_str("no candidate's interval holds the unit"),
        }
    }
}

impl std::error::Error for DrawRefusal {}
