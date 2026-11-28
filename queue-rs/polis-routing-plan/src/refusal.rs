//! Why a projection was refused. No variant carries a comment id.

use crate::limits::Limit;

/// The keys of the math result this crate reads, and the projection as a
/// whole.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Key {
    /// The projection as a whole, or a key this crate does not read.
    Projection,
    GroupVotes,
    CommentExtremity,
    Tids,
    MetaTids,
    CommentPriorities,
    GroupClusters,
    BaseClusters,
}

impl Key {
    /// The key as the math result spells it.
    pub fn name(self) -> &'static str {
        match self {
            Key::Projection => "projection",
            Key::GroupVotes => "group-votes",
            Key::CommentExtremity => "pca.comment-extremity",
            Key::Tids => "tids",
            Key::MetaTids => "meta-tids",
            Key::CommentPriorities => "comment-priorities",
            Key::GroupClusters => "group-clusters",
            Key::BaseClusters => "base-clusters",
        }
    }
}

/// A closed list of refusals. The adapter never repairs: each of these ends
/// the read, and the caller keeps today's draw.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SourceRefusal {
    /// A limit was exceeded, before anything was expanded.
    TooLarge { what: Limit },
    /// Not JSON, not the shape the key has in the math result, or a value
    /// out of range (a negative or non-integer id, a number too large to
    /// read). `Projection` when the bytes as a whole are not one JSON object.
    Malformed { key: Key },
    /// An object gives the same key twice. Found on the original bytes,
    /// before any decoder could keep one and drop the other. `key` is the
    /// top-level key it was found under.
    DuplicateKey { key: Key },
    /// A key a needed frame is made from is absent, or `null`.
    Missing { key: Key },
    /// A cell's agrees and disagrees add up to more than its seen count
    /// (A + D > S).
    SeenBelowVotes,
    /// A cell's seen count is above its group's `n-members`.
    SeenAboveMembers,
    /// A count does not fit: a cell's passes (S - A - D) above 2^32 - 1, or
    /// a sum of members that overflows.
    CountOverflow,
    /// A group in `group-votes` with `n-members` 0. The engine leaves a
    /// group with no members out; it never writes an empty one.
    EmptyGroup,
    /// `tids` and `pca.comment-extremity` have different lengths.
    ExtremityLengthMismatch,
    /// A comment id appears twice in `tids` or in `meta-tids`.
    DuplicateComment { key: Key },
    /// A negative extremity.
    InvalidExtremity,
    /// A group in `group-clusters` names a base cluster that is not in
    /// `base-clusters`.
    UnknownBaseCluster,
    /// A base cluster is named by two groups, or twice by one.
    BaseClusterInTwoGroups,
    /// A group's participants, counted through its base clusters, are not
    /// its `n-members` in `group-votes`; or a group in `group-votes` is not
    /// in `group-clusters`.
    MembersMismatch,
    /// `comment-priorities` is an array, the legacy shape today's read route
    /// also refuses.
    ArrayPriorities,
}
