//! Comment routing's equation and its draw, as named, versioned rules with
//! typed inputs.
//!
//! Polis gives every comment a participant has not voted on a weight, draws
//! one with a chance proportional to its weight, and shows it. This crate
//! holds today's weight, `historical/1`, and today's draw, `stored-weights/1`,
//! exactly, and the corrected rules as candidates, none of them chosen; every draw comes with a receipt that says which comment was drawn
//! and the probability it had, true to within 2^-50.
//!
//! It is a pure library: nothing in Polis calls it yet, and it has no route,
//! no database, no clock, no logging and no randomness of its own. The README
//! says what each term rewards and what is proven.

#![forbid(unsafe_code)]

pub mod corrected;
pub mod draw;
mod dupkeys;
pub mod floor;
pub mod frames;
pub mod historical;
mod receipt;
pub mod registry;
pub mod types;

pub use corrected::{
    Consensus, ConsensusForm, CorrectedWeights, GicParams, MetaPolicy, SymmetricGicParams,
    SymmetricParams, consensus, symmetric_1, symmetric_gic_1,
};
pub use draw::{
    Candidates, Cdf, CorrectedProvenance, DrawFlags, DrawMode, Drawn, Lane, MIN_TOTAL,
    StoredWeight, StoredWeights, Unit, WeightProvenance, WeightsUsed, cdf, stored_weights_1,
};
pub use floor::{
    DEGENERACY_RATIO, FloorMarginals, FloorParams, FloorPlan, ZERO_MASS_DONATION, floor_marginals,
    stable_cdf, symmetric_gic_floor_1, uniform_1,
};
pub use frames::{
    CommentMarks, CurrentFrames, CurrentGroupFrame, EveryoneFrame, GroupMarks, ImportanceMarks,
    MarkTotals, Marks, MarksFrame, TOTAL_SLACK, VoterWeightFrame, VoterWeightSum,
};
pub use historical::{
    HistoricalParams, HistoricalProvenance, HistoricalWeights, MetaComments, Scored, historical_1,
};
pub use registry::{ParamDoc, ParamSet, RuleDoc, RuleId, describe, lookup, params_table};
pub use types::{
    CommentId, Counts, DrawRefusal, Explanation, Extremity, ExtremityFrame, Factor, FactorName,
    GroupId, HistoricalCountFrame, MAX_CANDIDATES, ParamError, Refusal, SourceId, WEIGHT_CEILING,
    Weight,
};
