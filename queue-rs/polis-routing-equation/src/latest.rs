//! The count-input policy, and the frame of the latest counts.
//!
//! Every rule built so far that reads base counts reads them from the update
//! before the one being read (`base-counts:lag-1`): today's equation does, and
//! the `/1` corrected rules keep it. The policy `base-counts:lag-0` reads the
//! counts of the update being read itself. Its counts can only be made here,
//! from the current group frame, so that a frame of independently supplied
//! counts cannot stand for them.
//!
//! A `LatestCountFrame` has one constructor, from a group frame; it cannot be
//! built from a list of counts, read from JSON, or converted from or into a
//! `HistoricalCountFrame`:
//!
//! ```compile_fail
//! use polis_routing_equation::{LatestCountFrame, SourceId};
//! let frame = LatestCountFrame::new(SourceId::new("tick-b").unwrap(), []);
//! ```
//!
//! ```compile_fail
//! use polis_routing_equation::{HistoricalCountFrame, LatestCountFrame};
//! fn into_latest(h: HistoricalCountFrame) -> LatestCountFrame {
//!     h.into()
//! }
//! ```
//!
//! ```compile_fail
//! use polis_routing_equation::{HistoricalCountFrame, LatestCountFrame};
//! fn into_historical(l: LatestCountFrame) -> HistoricalCountFrame {
//!     l.into()
//! }
//! ```
//!
//! ```compile_fail
//! use polis_routing_equation::LatestCountFrame;
//! let frame: LatestCountFrame = serde_json::from_str("{}").unwrap();
//! ```
//!
//! The source id it carries is the group frame's, unchanged. Equal source
//! ids are a consistency check, not proof: that a source id names the math
//! update it came from, and that groups do not overlap, stay the caller's to
//! certify.

use crate::frames::CurrentGroupFrame;
use crate::types::{CommentId, Counts, Refusal, SourceId};
use std::collections::BTreeMap;

/// Which math update's counts feed a rule's base count term. A fixed
/// property of a rule version, never a parameter.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum CountPolicy {
    /// The counts summed over the opinion groups of the update before the
    /// one read; extremity and groups come from the update read.
    Lag1,
    /// The counts summed over the opinion groups of the update read itself;
    /// everything comes from that one update.
    Lag0,
}

impl CountPolicy {
    pub const ALL: [CountPolicy; 2] = [CountPolicy::Lag1, CountPolicy::Lag0];

    /// `base-counts:lag-1` or `base-counts:lag-0`.
    pub fn name(self) -> &'static str {
        match self {
            Self::Lag1 => "base-counts:lag-1",
            Self::Lag0 => "base-counts:lag-0",
        }
    }

    /// The policy of exactly that name; every other spelling is `None`.
    pub fn from_name(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|p| p.name() == name)
    }
}

/// The counts of the update being read, per comment, summed over its
/// opinion groups. Like the lagged counts, they leave out participants in no
/// group, so they are not everyone's counts.
///
/// A comment with a cell in at least one group is present (a cell of zeros
/// counts as present); its agreed, disagreed and passed are each the sum over
/// the groups that have a cell. A comment with no cell in any group is
/// absent. Integer sums are exact, so the order and the ids of the groups
/// cannot change a count.
#[derive(Clone, Debug, PartialEq)]
pub struct LatestCountFrame {
    source: SourceId,
    cells: BTreeMap<CommentId, Counts>,
}

impl LatestCountFrame {
    /// The latest counts of a group frame.
    ///
    /// Refused: a frame with no groups (`NoLatestCounts`: there are no latest
    /// counts, and the caller falls back with its own provenance); any
    /// comment whose summed agreed, disagreed or passed count is above
    /// `u32::MAX` (`CountOverflow`). The whole frame is checked, whichever
    /// comments a rule would later score, exclude or leave unscored. The
    /// limit is on each of the three counts, not on their sum: a comment's
    /// `seen()` may be above `u32::MAX`.
    ///
    /// Defined: groups with members and no cells give a valid frame with no
    /// comments.
    pub fn from_groups(groups: &CurrentGroupFrame) -> Result<Self, Refusal> {
        if groups.group_count() == 0 {
            return Err(Refusal::NoLatestCounts);
        }
        let narrow = |sum: u64| u32::try_from(sum).map_err(|_| Refusal::CountOverflow);
        let add = |sum: u64, count: u32| {
            sum.checked_add(u64::from(count))
                .ok_or(Refusal::CountOverflow)
        };
        let mut cells = BTreeMap::new();
        for id in groups.comment_ids() {
            let (mut agreed, mut disagreed, mut passed) = (0u64, 0u64, 0u64);
            for c in groups.cells_for(id).filter_map(|(_, cell)| cell) {
                agreed = add(agreed, c.agreed())?;
                disagreed = add(disagreed, c.disagreed())?;
                passed = add(passed, c.passed())?;
            }
            let counts = Counts::new(narrow(agreed)?, narrow(disagreed)?, narrow(passed)?);
            cells.insert(id, counts);
        }
        Ok(Self {
            source: groups.source().clone(),
            cells,
        })
    }

    /// The group frame's source id, unchanged.
    pub fn source(&self) -> &SourceId {
        &self.source
    }
    /// The comment's summed counts, or `None` when no group has a cell for it.
    pub fn get(&self, id: CommentId) -> Option<Counts> {
        self.cells.get(&id).copied()
    }
    pub fn len(&self) -> usize {
        self.cells.len()
    }
    pub fn is_empty(&self) -> bool {
        self.cells.is_empty()
    }
    /// Every present comment, in id order.
    pub fn ids(&self) -> impl Iterator<Item = CommentId> + '_ {
        self.cells.keys().copied()
    }
}
