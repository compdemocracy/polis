//! Immutable, bounded revocation snapshots. Refresh I/O belongs to the caller's
//! background worker; verification never has a database handle.
use sha2::{Digest, Sha256};
use std::sync::{Arc, RwLock};

pub const MAX_REVOKED: usize = 1_000_000;
pub const MAX_ALIASES: usize = 1_000_000;
pub const REFRESH_PERIOD: std::time::Duration = std::time::Duration::from_secs(30);

#[derive(Default)]
pub struct Snapshot {
    revoked: Box<[(i32, i32)]>,
    // Fixed-size hashes avoid retaining arbitrary-length database strings.
    aliases: Box<[([u8; 32], i32)]>,
}
impl Snapshot {
    pub fn load(c: &mut postgres::Client) -> Result<Self, crate::Unavailable> {
        Self::read(c).map_err(|_| crate::Unavailable)
    }
    fn read(c: &mut postgres::Client) -> Result<Self, Box<dyn std::error::Error>> {
        // Both reads see the same database snapshot. Stream rows so a broken
        // cardinality assumption cannot allocate an unbounded result buffer.
        let mut tx = c
            .build_transaction()
            .isolation_level(postgres::IsolationLevel::RepeatableRead)
            .read_only(true)
            .start()?;
        if tx
            .query_one("SELECT pg_is_in_recovery()", &[])?
            .try_get::<_, bool>(0)?
        {
            return Err("revocations require primary".into());
        }
        let mut revoked = Vec::new();
        use postgres::fallible_iterator::FallibleIterator;
        {
            let mut rows = tx.query_raw(
                "SELECT zid,pid FROM treevite_login_codes WHERE revoked LIMIT $1",
                [&((MAX_REVOKED + 1) as i64)],
            )?;
            while let Some(row) = rows.next()? {
                if revoked.len() == MAX_REVOKED {
                    return Err("revocation snapshot limit".into());
                }
                revoked.push((row.try_get(0)?, row.try_get(1)?));
            }
        }
        let mut aliases = Vec::new();
        {
            let mut rows = tx.query_raw("SELECT z.zinvite,z.zid FROM zinvites z WHERE EXISTS (SELECT 1 FROM treevite_login_codes l WHERE l.zid=z.zid AND l.revoked) LIMIT $1", [&((MAX_ALIASES + 1) as i64)])?;
            while let Some(row) = rows.next()? {
                if aliases.len() == MAX_ALIASES {
                    return Err("revocation alias limit".into());
                }
                let alias: &str = row.try_get(0)?;
                if alias.len() > 100 {
                    return Err("revocation alias length".into());
                }
                aliases.push((Sha256::digest(alias.as_bytes()).into(), row.try_get(1)?));
            }
        }
        tx.commit()?;
        revoked.sort_unstable();
        revoked.dedup();
        aliases.sort_unstable();
        aliases.dedup();
        Ok(Self {
            revoked: revoked.into_boxed_slice(),
            aliases: aliases.into_boxed_slice(),
        })
    }
    pub fn contains(&self, zid: i32, pid: i32) -> bool {
        self.revoked.binary_search(&(zid, pid)).is_ok()
    }
    fn contains_alias(&self, conversation: &str, pid: i32) -> bool {
        let digest: [u8; 32] = Sha256::digest(conversation.as_bytes()).into();
        self.aliases
            .binary_search_by_key(&digest, |a| a.0)
            .ok()
            .is_some_and(|index| self.contains(self.aliases[index].1, pid))
    }
    pub fn len(&self) -> usize {
        self.revoked.len()
    }
    pub fn is_empty(&self) -> bool {
        self.revoked.is_empty()
    }
    pub fn bytes(&self) -> usize {
        std::mem::size_of_val(self.revoked.as_ref()) + std::mem::size_of_val(self.aliases.as_ref())
    }
}

#[derive(Default)]
pub struct Revocations(RwLock<Arc<Snapshot>>);
impl Revocations {
    pub fn new(snapshot: Snapshot) -> Arc<Self> {
        Arc::new(Self(RwLock::new(Arc::new(snapshot))))
    }
    pub fn replace(&self, snapshot: Snapshot) {
        let old = std::mem::replace(
            &mut *self.0.write().unwrap_or_else(|e| e.into_inner()),
            Arc::new(snapshot),
        );
        // Free the old allocation after releasing the write lock.
        drop(old);
    }
    pub fn snapshot(&self) -> Arc<Snapshot> {
        self.0.read().unwrap_or_else(|e| e.into_inner()).clone()
    }
    pub fn contains(&self, conversation: &str, pid: i32) -> bool {
        self.snapshot().contains_alias(conversation, pid)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn compact_memory_and_alias_lookup() {
        let revoked = (0..100_000)
            .map(|pid| (7, pid))
            .collect::<Vec<_>>()
            .into_boxed_slice();
        let aliases = vec![(Sha256::digest(b"fixture").into(), 7)].into_boxed_slice();
        let snapshot = Snapshot { revoked, aliases };
        assert_eq!(snapshot.bytes(), 800_036);
        assert!(snapshot.contains_alias("fixture", 0));
        assert!(snapshot.contains_alias("fixture", 99_999));
        assert!(!snapshot.contains_alias("fixture", 100_000));
        assert!(!snapshot.contains_alias("other", 0));
        let shared = Revocations::new(snapshot);
        let old = shared.snapshot();
        shared.replace(Snapshot::default());
        assert!(old.contains(7, 0));
        assert!(!shared.contains("fixture", 0));
    }
}
