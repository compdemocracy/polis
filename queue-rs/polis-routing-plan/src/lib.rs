//! The frames adapter for comment routing.
//!
//! The math engine stores one result per conversation (`math_main`). This
//! crate takes the parts of that result that comment routing reads, handed to
//! it as bytes, and turns them into the routing equation's typed input
//! frames: the extremity of each comment, each opinion group's counts, the
//! meta comments and the stored weights. Every frame of one read carries the
//! same source id, made from the row's identity and a SHA-256 of the bytes.
//!
//! It also builds one conversation's plan for a configured rule and draws
//! the next comment from it in one call (`Plan`), with the caller's random
//! unit.
//!
//! It also holds the byte-accounted cache of plans (`PlanCache`) as a pure
//! state machine: the caller owns the lock around it, the shared handle
//! each plan lives in, the clock (time arrives as an argument) and any
//! randomness (jitter arrives as a number).
//!
//! It is a pure library: nothing in Polis calls it yet. It opens nothing,
//! reads no clock, keeps nothing beyond the values a caller holds and logs
//! nothing; it reads the bytes it is handed. Every size is checked before anything is expanded, and anything it
//! cannot read exactly is refused, never repaired. The README says where each
//! count comes from in the math result.

#![forbid(unsafe_code)]

mod cache;
mod decode;
mod identity;
mod limits;
mod plan;
mod projection;
mod refusal;
mod reserve;
mod scan;

pub use cache::{
    Arm, Budget, BundleKey, CACHE_FIXED, CachedPlan, ConfigCapture, DEFAULT_CACHE_BYTES,
    ENTRY_OVERHEAD, FENCE_ENTRIES, FENCE_OVERHEAD, Failure, Freed, Freshness, KeyMismatch, Lookup,
    MAX_SHARE_DIVISOR, MetaSource, MissReason, Monotonic, Moved, NEGATIVE_ENTRIES,
    NEGATIVE_OVERHEAD, PlanCache, PlanHandle, Published, RETIRED_BYTES_DIVISOR, RETIRED_ENTRIES,
    RETRY_BASE_NS, RETRY_CAP_NS, Reclaim, Recorded, Rejection, Reservation, SLOT_OVERHEAD,
    SourceKey, WantedKey, retry_delay_ns,
};
pub use identity::{ContentId, RowIdentity, SOURCE_ID_PREFIX, source_id};
pub use limits::{Limit, SourceLimits};
pub use plan::{
    BuildRefusal, Fallback, MAX_EXCLUDE_META_COMMENTS, MAX_PLAN_CANDIDATES, NeededFrame, Plan,
    PlanDraw, PlanKind, RuleConfig,
};
pub use projection::{FrameCounts, FrameNeeds, Frames, Projection};
pub use refusal::{Key, SourceRefusal};
pub use reserve::{REVIEWED_RUSTC, ordered_maps_charge, std_bounds_reviewed};
pub use scan::Tally;
