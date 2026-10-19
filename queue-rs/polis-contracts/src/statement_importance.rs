//! Public aggregate counts for participant-visible, active statements.
use serde::{Deserialize, Serialize};
pub const PATH: &str = "/api/v3/statements/importance";
pub const SCHEMA: &str = "statement-importance/1";
pub const MAX_STATEMENTS: usize = 10_000;
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Statement {
    pub tid: i32,
    /// Participants whose latest vote on this statement is marked high_priority.
    pub important: u64,
    /// Participants with a vote on this statement (latest vote each).
    pub voters: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Response {
    pub schema: String,
    pub conversation_id: String,
    /// Database statement start, Unix milliseconds; all counts share its snapshot.
    pub read_at_ms: u64,
    /// Ascending tid; includes participant-visible statements with no votes.
    pub statements: Vec<Statement>,
}
impl Response {
    pub fn valid_for(&self, cid: &str) -> bool {
        self.schema == SCHEMA
            && self.conversation_id == cid
            && self.read_at_ms > 0
            && self.read_at_ms <= 9_007_199_254_740_991
            && self.statements.len() <= MAX_STATEMENTS
            && self
                .statements
                .iter()
                .all(|s| s.tid >= 0 && s.important <= s.voters && s.voters <= 9_007_199_254_740_991)
            && self.statements.windows(2).all(|s| s[0].tid < s[1].tid)
    }
}
