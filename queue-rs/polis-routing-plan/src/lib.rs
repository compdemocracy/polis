//! The frames adapter for comment routing.
//!
//! The math engine stores one result per conversation (`math_main`). This
//! crate takes the parts of that result that comment routing reads, handed to
//! it as bytes, and turns them into the routing equation's typed input
//! frames: the extremity of each comment, each opinion group's counts, the
//! meta comments and the stored weights. Every frame of one read carries the
//! same source id, made from the row's identity and a SHA-256 of the bytes.
//!
//! It is a pure library: nothing in Polis calls it yet. It opens nothing,
//! reads no clock, keeps no state and logs nothing; it reads the bytes it is
//! handed. Every size is checked before anything is expanded, and anything it
//! cannot read exactly is refused, never repaired. The README says where each
//! count comes from in the math result.

#![forbid(unsafe_code)]

mod decode;
mod identity;
mod limits;
mod plan;
mod projection;
mod refusal;
mod reserve;
mod scan;

pub use identity::{ContentId, RowIdentity, SOURCE_ID_PREFIX, source_id};
pub use limits::{Limit, SourceLimits};
pub use plan::{
    BuildRefusal, Fallback, MAX_EXCLUDE_META_COMMENTS, MAX_PLAN_CANDIDATES, NeededFrame, Plan,
    PlanDraw, PlanKind, RuleConfig,
};
pub use projection::{FrameNeeds, Frames, Projection};
pub use refusal::{Key, SourceRefusal};
pub use scan::Tally;
