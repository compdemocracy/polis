//! The row's identity, the content identity and the source id made from them.

use crate::refusal::{Key, SourceRefusal};
use polis_routing_equation::SourceId;
use sha2::Digest;
use sha2::Sha256;
use std::fmt;
use std::fmt::Write as _;

/// What the loader read beside the projection, in the same statement: the
/// conversation, the row's `math_env` and `math_tick` columns (never the
/// `math_tick` inside the JSON, which is made from the engine's wall clock),
/// the row's `last_vote_timestamp` publication column, and the database's
/// `now()` in milliseconds.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RowIdentity {
    pub zid: i32,
    pub math_env: String,
    pub math_tick: i64,
    pub last_vote_timestamp: Option<i64>,
    pub db_now_ms: i64,
}

/// SHA-256 over the projection's bytes exactly as they were fetched.
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ContentId([u8; 32]);

impl ContentId {
    pub fn of(bytes: &[u8]) -> Self {
        Self(Sha256::digest(bytes).into())
    }
    pub fn bytes(&self) -> &[u8; 32] {
        &self.0
    }
    /// The 64 lowercase hex characters.
    pub fn hex(&self) -> String {
        hex(&self.0)
    }
}

impl fmt::Debug for ContentId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "ContentId({})", self.hex())
    }
}

/// The fixed prefix of every source id this crate makes; 64 hex characters
/// follow it, so a source id is 78 printable bytes, inside the equation
/// crate's limit of 128.
pub const SOURCE_ID_PREFIX: &str = "plan-source/1:";

const DOMAIN: &[u8] = b"polis-routing-plan source id 1";

/// The source id of one read: SHA-256 over length-delimited fields, in a
/// fixed order: a domain tag, the conversation, the environment, the row's
/// `math_tick`, the content identity and the publication identity used (the
/// row's `last_vote_timestamp`, or a tag saying it was absent).
///
/// The database's `now()` is not part of it: it says when the row was read,
/// not what was read, and the same row read twice must have one id.
pub fn source_id(row: &RowIdentity, content: &ContentId) -> Result<SourceId, SourceRefusal> {
    let mut h = Sha256::new();
    field(&mut h, DOMAIN);
    field(&mut h, &row.zid.to_be_bytes());
    field(&mut h, row.math_env.as_bytes());
    field(&mut h, &row.math_tick.to_be_bytes());
    field(&mut h, content.bytes());
    match row.last_vote_timestamp {
        None => field(&mut h, b"no-last-vote-timestamp"),
        Some(t) => {
            field(&mut h, b"last-vote-timestamp");
            field(&mut h, &t.to_be_bytes());
        }
    }
    let digest: [u8; 32] = h.finalize().into();
    let mut id = String::with_capacity(SOURCE_ID_PREFIX.len() + 64);
    id.push_str(SOURCE_ID_PREFIX);
    id.push_str(&hex(&digest));
    // The prefix and the hex are printable ASCII and 78 bytes long, so the
    // equation crate's check cannot refuse them; if it ever did, the read is
    // refused rather than given another id.
    SourceId::new(id).map_err(|_| SourceRefusal::Malformed {
        key: Key::Projection,
    })
}

fn field(h: &mut Sha256, bytes: &[u8]) {
    h.update((bytes.len() as u64).to_be_bytes());
    h.update(bytes);
}

fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        // Writing into a String cannot fail.
        let _ = write!(s, "{b:02x}");
    }
    s
}
