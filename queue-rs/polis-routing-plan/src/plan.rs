//! The plan build and the one-call draw.
//!
//! A plan is one conversation's routing weights for one configured rule,
//! built once from one read's frames. A draw takes the candidate ids today's
//! query returned and the caller's random unit, and either chooses one
//! comment with its receipt or names the closed reason the caller must serve
//! today's draw instead. Nothing here reads a clock, a database or a random
//! source; the unit is an argument.

use crate::limits::SourceLimits;
use crate::projection::{FrameNeeds, Frames};
use crate::reserve::{map, reservation, vecs};
use crate::scan::Tally;
use polis_routing_equation::importance::TermParams;
use polis_routing_equation::{
    Candidates, CommentId, DrawRefusal, Drawn, Factor, FloorParams, FloorPlan, Lane, MetaPolicy,
    ParamSet, Scored, SourceId, StoredWeight, StoredWeights, Unit, ZERO_MASS_DONATION, resolve,
    stored_weights_1, symmetric_gic_2, symmetric_gic_floor_2, uniform_1,
};
use std::mem::size_of;

/// The most candidates any plan draws over: the default comment limit of a
/// projection. A longer list is today's draw, refused before any copy.
pub const MAX_PLAN_CANDIDATES: usize = 40_000;

/// The most comments, and the most candidates, a floor plan with
/// `meta_policy = exclude` is built for or draws over. An upper refusal
/// bound while the exclude-meta cost is open, not a measured serving
/// envelope: a conversation over it keeps today's draw.
pub const MAX_EXCLUDE_META_COMMENTS: usize = 10_000;

/// The longest source id the library admits (`SourceId::new`), charged for
/// every source id a plan or a receipt holds.
const SOURCE_ID_BYTES: u64 = 128;

/// A receipt clones at most this many source ids: the input source, the
/// weights source, and the provenance's base counts, extremity, groups and
/// term source.
const RECEIPT_SOURCE_IDS: u64 = 6;

/// A fixed allowance per draw for what the formula does not list by name
/// (the allocator's rounding is not counted by the allocator; this covers
/// small allocations of the library's receipt this crate cannot see).
const DRAW_FIXED: u64 = 1024;

/// The rule and policy pairs a plan can be built for. Closed: every other
/// pair is `BuildRefusal::Unsupported`, including every `/1` computed rule,
/// whose base counts need the previous update, which one stored math result
/// does not hold.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum RuleConfig {
    /// `stored-weights/1`: today's draw over the stored map.
    StoredWeights1,
    /// `uniform/1`: every candidate alike.
    Uniform1,
    /// `symmetric-gic-floor/2` over `symmetric-gic/2` weights with the
    /// floor's base parameters (`base-counts:lag-0`).
    SymmetricGicFloor2(FloorParams),
}

impl RuleConfig {
    /// Reads a configuration: the library's canonical plain form of the
    /// rule and its parameters, exactly as `ParamSet::to_plain` writes it,
    /// and the count policy it names. A rule that reads base counts must
    /// name its policy, checked with the library's `resolve`; one that reads
    /// none must name none.
    pub fn parse(plain: &str, count_policy: Option<&str>) -> Result<Self, BuildRefusal> {
        let set = ParamSet::from_plain(plain).map_err(|_| BuildRefusal::InvalidConfig)?;
        let config = match set {
            ParamSet::StoredWeights1 => RuleConfig::StoredWeights1,
            ParamSet::Uniform1 => RuleConfig::Uniform1,
            ParamSet::SymmetricGicFloor2(p) => RuleConfig::SymmetricGicFloor2(p),
            ParamSet::Historical1(_)
            | ParamSet::Symmetric1(_)
            | ParamSet::GicMean1(_)
            | ParamSet::GicGeomean1(_)
            | ParamSet::SymmetricGic1(_)
            | ParamSet::SymmetricGicFloor1(_)
            | ParamSet::Symmetric2(_)
            | ParamSet::SymmetricGic2(_) => return Err(BuildRefusal::Unsupported),
        };
        // One spelling per configuration, so its identity is its text.
        if set.to_plain() != plain {
            return Err(BuildRefusal::InvalidConfig);
        }
        let rule = set.rule();
        match (rule.count_policy(), count_policy) {
            (None, None) => {}
            (Some(_), Some(policy)) => {
                if resolve(rule.name(), policy).map_err(|_| BuildRefusal::InvalidConfig)? != rule {
                    return Err(BuildRefusal::InvalidConfig);
                }
            }
            (None, Some(_)) | (Some(_), None) => return Err(BuildRefusal::InvalidConfig),
        }
        Ok(config)
    }

    /// The rule with its complete parameters.
    pub fn param_set(&self) -> ParamSet {
        match self {
            RuleConfig::StoredWeights1 => ParamSet::StoredWeights1,
            RuleConfig::Uniform1 => ParamSet::Uniform1,
            RuleConfig::SymmetricGicFloor2(p) => ParamSet::SymmetricGicFloor2(*p),
        }
    }

    /// The canonical plain form.
    pub fn to_plain(&self) -> String {
        self.param_set().to_plain()
    }

    /// The frames this rule reads: the stored map for `stored-weights/1`,
    /// none for `uniform/1`, the extremity, groups and meta frames for the
    /// floor. Charge `Projection::reservation` for these before reading.
    pub fn needs(&self) -> FrameNeeds {
        match self {
            RuleConfig::StoredWeights1 => FrameNeeds {
                stored_weights: true,
                ..FrameNeeds::default()
            },
            RuleConfig::Uniform1 => FrameNeeds::default(),
            RuleConfig::SymmetricGicFloor2(_) => FrameNeeds {
                stored_weights: false,
                extremity: true,
                groups: true,
                meta: true,
            },
        }
    }
}

/// A frame a rule needs that the frames given do not hold.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NeededFrame {
    StoredWeights,
    Extremity,
    Groups,
    Meta,
}

/// Why a plan was not built. Closed, and no variant carries a comment id;
/// every one of them keeps today's draw.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BuildRefusal {
    /// A rule the library knows that this crate does not build.
    Unsupported,
    /// Not the canonical plain form, out of range, or the wrong count policy.
    InvalidConfig,
    /// The frames were read without one the rule needs.
    MissingFrame { frame: NeededFrame },
    /// A floor with `meta_policy = exclude` over a conversation with more
    /// than `MAX_EXCLUDE_META_COMMENTS` comments.
    ExcludeMetaTooLarge,
    /// The library refused to compute the weights from these frames.
    WeightsRefused,
    /// The library refused the floor over the weights computed.
    BaseMismatch,
}

#[derive(Clone, Debug, PartialEq)]
enum Variant {
    StoredWeights {
        map: Option<StoredWeights>,
        entries: usize,
        source: SourceId,
    },
    Uniform {
        source: SourceId,
    },
    Floor {
        plan: FloorPlan,
        meta_entries: usize,
        source: SourceId,
    },
}

/// Which variant a plan is: each is drawn with its own library function,
/// never through another's.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PlanKind {
    /// `stored_weights_1` over the stored map.
    StoredWeights,
    /// `uniform_1`.
    Uniform,
    /// `FloorPlan::draw` of `symmetric-gic-floor/2`.
    Floor,
}

/// One conversation's plan, for one rule, from one read.
#[derive(Clone, Debug, PartialEq)]
pub struct Plan {
    variant: Variant,
}

/// A draw the plan made: the comment to fetch, as the database's id, and
/// the library's receipt. Only a plan's own draw makes one; a fallback has
/// no receipt and no chance of its own here.
#[derive(Clone, Debug, PartialEq)]
pub struct PlanDraw {
    tid: i32,
    drawn: Drawn,
}

impl PlanDraw {
    /// The comment to fetch: the receipt's comment id, never an index into
    /// the caller's list.
    pub fn tid(&self) -> i32 {
        self.tid
    }
    /// The receipt.
    pub fn drawn(&self) -> &Drawn {
        &self.drawn
    }
    pub fn into_drawn(self) -> Drawn {
        self.drawn
    }
}

/// Why the plan did not draw, so that the caller serves today's draw on the
/// same unfiltered candidates and the same unit. Closed, and no variant
/// carries a comment id. Three are invariant failures (`is_invariant`):
/// proved impossible on what the draw accepts, to be counted and looked
/// into, never treated as ordinary input.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fallback {
    /// More candidates than the plan's bound, or than the library's.
    TooManyCandidates,
    /// A candidate id that is negative.
    InvalidCandidateId,
    /// Every candidate is excluded by the plan; not the query running dry.
    AllExcluded,
    UnitOutOfRange,
    Empty,
    DuplicateCandidate,
    UnsupportedLegacyWeight,
    InvalidDrawWeight,
    TotalBelowNormal,
    ZeroMass,
    NumericDegeneracy,
    InvalidShare,
    /// A candidate the plan has no facts for (a comment newer than the read).
    NeedsBaseline,
    /// Invariant: no candidate's interval held an admitted unit.
    NoInterval,
    /// Invariant: an excluded candidate reached the draw after the filter.
    ExcludedCandidate,
    /// Invariant: the receipt's comment id does not fit the database's id.
    ReceiptIdOutOfRange,
}

impl Fallback {
    /// The reason as it is recorded.
    pub fn name(self) -> &'static str {
        match self {
            Fallback::TooManyCandidates => "too_many_candidates",
            Fallback::InvalidCandidateId => "invalid_candidate_id",
            Fallback::AllExcluded => "all_excluded",
            Fallback::UnitOutOfRange => "unit_out_of_range",
            Fallback::Empty => "empty",
            Fallback::DuplicateCandidate => "duplicate_candidate",
            Fallback::UnsupportedLegacyWeight => "unsupported_legacy_weight",
            Fallback::InvalidDrawWeight => "invalid_draw_weight",
            Fallback::TotalBelowNormal => "total_below_normal",
            Fallback::ZeroMass => "zero_mass",
            Fallback::NumericDegeneracy => "numeric_degeneracy",
            Fallback::InvalidShare => "invalid_share",
            Fallback::NeedsBaseline => "needs_baseline",
            Fallback::NoInterval => "no_interval",
            Fallback::ExcludedCandidate => "excluded_candidate",
            Fallback::ReceiptIdOutOfRange => "receipt_id_out_of_range",
        }
    }

    /// Whether this is an invariant failure rather than ordinary input.
    pub fn is_invariant(self) -> bool {
        matches!(
            self,
            Fallback::NoInterval | Fallback::ExcludedCandidate | Fallback::ReceiptIdOutOfRange
        )
    }

    /// The library's refusal as a fallback reason. A `match` with no
    /// wildcard: a refusal the library adds does not compile here until it
    /// is given its own reason.
    // Keep future library refusals a compile error, even when a wildcard
    // would currently return the same reason as the last named variant.
    #[deny(
        clippy::wildcard_enum_match_arm,
        clippy::match_wildcard_for_single_variants
    )]
    pub fn from_refusal(refusal: DrawRefusal) -> Self {
        match refusal {
            DrawRefusal::UnitOutOfRange => Fallback::UnitOutOfRange,
            DrawRefusal::Empty => Fallback::Empty,
            DrawRefusal::DuplicateCandidate(_) => Fallback::DuplicateCandidate,
            DrawRefusal::TooManyCandidates(_) => Fallback::TooManyCandidates,
            DrawRefusal::UnsupportedLegacyWeight(_) => Fallback::UnsupportedLegacyWeight,
            DrawRefusal::InvalidDrawWeight(_) => Fallback::InvalidDrawWeight,
            DrawRefusal::TotalBelowNormal => Fallback::TotalBelowNormal,
            DrawRefusal::NoInterval => Fallback::NoInterval,
            DrawRefusal::ZeroMass => Fallback::ZeroMass,
            DrawRefusal::NumericDegeneracy(_) => Fallback::NumericDegeneracy,
            DrawRefusal::InvalidShare => Fallback::InvalidShare,
            DrawRefusal::ExcludedCandidate(_) => Fallback::ExcludedCandidate,
            DrawRefusal::NeedsBaseline(_) => Fallback::NeedsBaseline,
        }
    }
}

fn excludes_meta(plan: &FloorPlan) -> bool {
    plan.params().base().base().meta_policy() == MetaPolicy::Exclude
}

fn sz<T>() -> u64 {
    size_of::<T>() as u64
}

fn add(a: u64, b: Option<u64>) -> Option<u64> {
    a.checked_add(b?)
}

impl Plan {
    /// Builds the plan for `config` from one read's frames. Uniform needs no
    /// frame; stored weights need only the stored map (read, even if
    /// absent); the floor needs the extremity, groups and meta frames.
    pub fn build(frames: &Frames, config: &RuleConfig) -> Result<Plan, BuildRefusal> {
        let source = frames.source().clone();
        let variant = match config {
            RuleConfig::Uniform1 => Variant::Uniform { source },
            RuleConfig::StoredWeights1 => {
                if !frames.needs().stored_weights {
                    return Err(BuildRefusal::MissingFrame {
                        frame: NeededFrame::StoredWeights,
                    });
                }
                Variant::StoredWeights {
                    map: frames.stored().cloned(),
                    entries: frames.stored_entries(),
                    source,
                }
            }
            RuleConfig::SymmetricGicFloor2(params) => {
                let missing = |frame| BuildRefusal::MissingFrame { frame };
                let extremity = frames
                    .extremity()
                    .ok_or_else(|| missing(NeededFrame::Extremity))?;
                let groups = frames
                    .groups()
                    .ok_or_else(|| missing(NeededFrame::Groups))?;
                let meta = frames.meta().ok_or_else(|| missing(NeededFrame::Meta))?;
                let exclude = params.base().base().meta_policy() == MetaPolicy::Exclude;
                // Early: every comment with an extremity is one the plan
                // would know, so over the bound here is over it below.
                if exclude && extremity.ids().nth(MAX_EXCLUDE_META_COMMENTS).is_some() {
                    return Err(BuildRefusal::ExcludeMetaTooLarge);
                }
                let weights = symmetric_gic_2(params.base(), groups, extremity, meta)
                    .map_err(|_| BuildRefusal::WeightsRefused)?;
                if exclude {
                    // The comments the plan knows: scored, unscored and
                    // excluded, which the library keeps disjoint.
                    let known = weights
                        .scored()
                        .count()
                        .checked_add(weights.unscored().count())
                        .and_then(|n| n.checked_add(weights.excluded().count()));
                    if known.is_none_or(|n| n > MAX_EXCLUDE_META_COMMENTS) {
                        return Err(BuildRefusal::ExcludeMetaTooLarge);
                    }
                }
                let plan = symmetric_gic_floor_2(params, weights, meta)
                    .map_err(|_| BuildRefusal::BaseMismatch)?;
                Variant::Floor {
                    plan,
                    meta_entries: frames.meta_entries(),
                    source,
                }
            }
        };
        Ok(Plan { variant })
    }

    pub fn kind(&self) -> PlanKind {
        match &self.variant {
            Variant::StoredWeights { .. } => PlanKind::StoredWeights,
            Variant::Uniform { .. } => PlanKind::Uniform,
            Variant::Floor { .. } => PlanKind::Floor,
        }
    }

    /// The read's source id, which every receipt of this plan names.
    pub fn source(&self) -> &SourceId {
        match &self.variant {
            Variant::StoredWeights { source, .. }
            | Variant::Uniform { source }
            | Variant::Floor { source, .. } => source,
        }
    }

    /// The stored map a stored-weights plan draws over (`None` for no map,
    /// and for the other variants).
    pub fn stored(&self) -> Option<&StoredWeights> {
        match &self.variant {
            Variant::StoredWeights { map, .. } => map.as_ref(),
            Variant::Uniform { .. } | Variant::Floor { .. } => None,
        }
    }

    /// The floor plan a floor plan draws with.
    pub fn floor(&self) -> Option<&FloorPlan> {
        match &self.variant {
            Variant::Floor { plan, .. } => Some(plan),
            Variant::StoredWeights { .. } | Variant::Uniform { .. } => None,
        }
    }

    /// The most candidates this plan draws over: `MAX_EXCLUDE_META_COMMENTS`
    /// for a floor with `meta_policy = exclude`, else `MAX_PLAN_CANDIDATES`.
    pub fn candidate_bound(&self) -> usize {
        match &self.variant {
            Variant::Floor { plan, .. } if excludes_meta(plan) => MAX_EXCLUDE_META_COMMENTS,
            Variant::Floor { .. } | Variant::StoredWeights { .. } | Variant::Uniform { .. } => {
                MAX_PLAN_CANDIDATES
            }
        }
    }

    /// Draws once, over the candidates today's query returned, in its order,
    /// with the caller's unit. In order, with no retry and no second rule:
    /// the bound before any copy; each id converted, checked; for a floor
    /// with `meta_policy = exclude`, every id the plan's own `excludes`
    /// names left out, order kept; the library's `Candidates` and `Unit`;
    /// the variant's own draw, once; the receipt's comment as the database's
    /// id. The caller's slice is never indexed with the receipt's index,
    /// which counts positions in the filtered list.
    pub fn draw(&self, sql_candidates: &[i32], unit: f64) -> Result<PlanDraw, Fallback> {
        if sql_candidates.len() > self.candidate_bound() {
            return Err(Fallback::TooManyCandidates);
        }
        let filter = match &self.variant {
            Variant::Floor { plan, .. } if excludes_meta(plan) => Some(plan),
            Variant::Floor { .. } | Variant::StoredWeights { .. } | Variant::Uniform { .. } => None,
        };
        let mut ids = Vec::with_capacity(sql_candidates.len());
        for &tid in sql_candidates {
            let id = CommentId::new(u32::try_from(tid).map_err(|_| Fallback::InvalidCandidateId)?);
            if filter.is_some_and(|p| p.excludes(id)) {
                continue;
            }
            ids.push(id);
        }
        if ids.is_empty() && !sql_candidates.is_empty() {
            return Err(Fallback::AllExcluded);
        }
        let candidates = Candidates::new(ids).map_err(Fallback::from_refusal)?;
        let unit = Unit::new(unit).map_err(Fallback::from_refusal)?;
        let drawn = match &self.variant {
            Variant::StoredWeights { map, source, .. } => {
                stored_weights_1(map.as_ref(), &candidates, unit, source)
            }
            Variant::Uniform { source } => uniform_1(&candidates, unit, source),
            Variant::Floor { plan, source, .. } => plan.draw(&candidates, unit, source, source),
        }
        .map_err(Fallback::from_refusal)?;
        let tid =
            i32::try_from(drawn.comment().get()).map_err(|_| Fallback::ReceiptIdOutOfRange)?;
        Ok(PlanDraw { tid, drawn })
    }

    /// An upper bound, in bytes, on what this plan holds for as long as it
    /// lives, with one `Arc` around it: the plan itself, its source ids at
    /// their longest, every ordered map and set at one node per entry plus
    /// one, every scored entry's factors, and the terms. Checked arithmetic;
    /// an overflow charges `usize::MAX`. The cache's own entry (its key, its
    /// pointer, its bookkeeping) is the cache's to charge.
    pub fn charged_bytes(&self) -> usize {
        let charge = self.charge().and_then(|c| usize::try_from(c).ok());
        charge.unwrap_or(usize::MAX)
    }

    fn charge(&self) -> Option<u64> {
        // The Arc's two counters and the plan, inline.
        let mut total = sz::<usize>().checked_mul(2)?.checked_add(sz::<Plan>())?;
        total = total.checked_add(SOURCE_ID_BYTES)?;
        match &self.variant {
            Variant::Uniform { .. } => {}
            Variant::StoredWeights {
                map: m, entries, ..
            } => {
                if m.is_some() {
                    // The map's source id, and its entries.
                    total = total.checked_add(SOURCE_ID_BYTES)?;
                    total = add(
                        total,
                        map(*entries as u64, sz::<CommentId>(), sz::<StoredWeight>()),
                    )?;
                }
            }
            Variant::Floor {
                plan, meta_entries, ..
            } => {
                let w = plan.weights();
                // Base counts, extremity, groups and term source ids.
                total = total.checked_add(SOURCE_ID_BYTES.checked_mul(4)?)?;
                let id = sz::<CommentId>();
                total = add(total, map(w.scored().count() as u64, id, sz::<Scored>()))?;
                for (_, s) in w.scored() {
                    let e = s.explanation();
                    let factors = (e.inner().len() as u64).checked_add(e.outer().len() as u64)?;
                    total = total.checked_add(factors.checked_mul(sz::<Factor>())?)?;
                }
                total = add(total, map(w.unscored().count() as u64, id, 0))?;
                total = add(total, map(w.excluded().count() as u64, id, 0))?;
                total = add(total, map(*meta_entries as u64, id, 0))?;
                total =
                    total.checked_add((w.terms().len() as u64).checked_mul(sz::<TermParams>())?)?;
            }
        }
        Some(total)
    }

    /// An upper bound, in bytes, on everything one `draw` over `candidates`
    /// ids allocates, held all at once, until its result is dropped: the
    /// converted and filtered ids, the library's duplicate check, every
    /// scratch vector of the variant's draw (weights, running sums, the
    /// floor's three lanes, absorbed positions and ids), and the receipt
    /// (lanes, cloned source ids, provenance, terms, donations), plus a
    /// fixed allowance per call. Allocation free; `None` on overflow, which
    /// the caller refuses. A list over `candidate_bound` needs nothing: the
    /// draw refuses it before any copy.
    pub fn draw_reservation(&self, candidates: usize) -> Option<u64> {
        if candidates > self.candidate_bound() {
            return Some(0);
        }
        let n = candidates as u64;
        let f = sz::<f64>();
        let id = sz::<CommentId>();
        // The ids, converted and filtered, and the duplicate check's set.
        let mut total = n.checked_mul(id)?;
        total = add(total, map(n, id, 0))?;
        // The running sums of the shared arithmetic, and the positions it
        // absorbs (pushed one at a time).
        total = total.checked_add(n.checked_mul(f)?)?;
        total = add(total, vecs(n, 1, sz::<usize>()))?;
        let donation = sz::<String>().checked_add(ZERO_MASS_DONATION.len() as u64)?;
        let mut terms = 0u64;
        match &self.variant {
            Variant::StoredWeights { .. } => {
                // The draw weights, and the absorbed ids collected.
                total = total.checked_add(n.checked_mul(f)?)?;
                total = add(total, vecs(n, 1, id))?;
            }
            Variant::Uniform { .. } => {
                total = total.checked_add(n.checked_mul(f)?)?;
            }
            Variant::Floor { plan, .. } => {
                // Base weights, then the uniform, weighted and draw lanes.
                total = total.checked_add(n.checked_mul(f)?.checked_mul(4)?)?;
                // The marginals' donation and the receipt's copy of it.
                total = total.checked_add(donation.checked_mul(2)?)?;
                terms = (plan.weights().terms().len() as u64).checked_mul(sz::<TermParams>())?;
            }
        }
        // The receipt: two lanes at most, the cloned source ids, the terms.
        total = total.checked_add(sz::<Lane>().checked_mul(2)?)?;
        total = total.checked_add(SOURCE_ID_BYTES.checked_mul(RECEIPT_SOURCE_IDS)?)?;
        total = total.checked_add(terms)?;
        total.checked_add(DRAW_FIXED)
    }

    /// An upper bound, in bytes, on what building `config`'s plan from a
    /// projection checked under `limits` allocates beyond the projection
    /// itself: the frames the rule needs, at every count the limits allow,
    /// held while the build runs, and the plan the build returns (its
    /// `charged_bytes` at those counts). Known before anything is read, so a
    /// build can be admitted before its source is fetched. Allocation free.
    ///
    /// `None`: the arithmetic overflows, or no bound is calibrated for the
    /// rule. The floor's weights are computed by the library with scratch
    /// this crate does not yet bound or measure, so a floor build has no
    /// allowance and a caller refuses it before reading anything.
    pub fn build_allowance(config: &RuleConfig, limits: &SourceLimits) -> Option<u64> {
        let worst = Tally {
            groups: limits.max_groups,
            cells: limits.max_cells,
            tids: limits.max_comments,
            meta: limits.max_comments,
            extremity: limits.max_comments,
            priorities: limits.max_comments,
            memberships: limits.max_memberships,
            longest_string: limits.max_bytes,
        };
        let frames = reservation(&worst, config.needs())?;
        // The Arc's two counters, the plan inline and its source id.
        let inline = sz::<usize>()
            .checked_mul(2)?
            .checked_add(sz::<Plan>())?
            .checked_add(SOURCE_ID_BYTES)?;
        let plan = match config {
            RuleConfig::Uniform1 => inline,
            // The stored map, cloned from the frame: its source id and one
            // node per entry plus one.
            RuleConfig::StoredWeights1 => add(
                inline.checked_add(SOURCE_ID_BYTES)?,
                map(limits.max_comments, sz::<CommentId>(), sz::<StoredWeight>()),
            )?,
            RuleConfig::SymmetricGicFloor2(_) => return None,
        };
        frames.checked_add(plan)
    }
}
