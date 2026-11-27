//! The limits a projection is held to before anything is expanded.

/// Every limit is checked on the bytes, or on counts taken from the bytes,
/// before any frame is allocated.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SourceLimits {
    /// The projection's length in bytes.
    pub max_bytes: u64,
    /// How deeply arrays and objects may nest; the outer object is depth 1.
    /// Keep it below 128, the JSON reader's own limit, or a deeper document
    /// is refused as malformed instead of too deep.
    pub max_depth: u32,
    /// Comments: each of `tids`, `meta-tids`, `pca.comment-extremity` and
    /// `comment-priorities` alone, and the distinct ids of `tids` and
    /// `meta-tids` together, always, at parse.
    pub max_comments: u64,
    /// Entries of `group-votes`.
    pub max_groups: u64,
    /// Entries of every group's `votes`, summed over the groups.
    pub max_cells: u64,
    /// Entries of `group-clusters`, of every group's `members`, of
    /// `base-clusters`' `id` and `members`, and of every base cluster's
    /// member list, summed.
    pub max_memberships: u64,
}

impl Default for SourceLimits {
    fn default() -> Self {
        Self {
            max_bytes: 64 * 1024 * 1024,
            max_depth: 32,
            max_comments: 40_000,
            max_groups: 64,
            max_cells: 40_000 * 64,
            max_memberships: 4_000_000,
        }
    }
}

/// Which limit a projection went over.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Limit {
    Bytes,
    Depth,
    Comments,
    Groups,
    Cells,
    Memberships,
    /// The expanded-size reservation does not fit in 64 bits.
    Reservation,
}
