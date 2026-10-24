//! One coherent math generation, cached as a whole for three seconds.
use crate::{db::Pool, lru::Lru};
use serde::Deserialize;
use std::sync::{Arc, Mutex};
#[derive(Debug, Clone, Deserialize, Default)]
pub struct Base {
    #[serde(default)]
    pub id: Vec<i32>,
}
#[derive(Debug, Clone, Deserialize, Default)]
pub struct Group {
    #[serde(default)]
    pub members: Vec<i32>,
}
#[derive(Debug, Clone, Deserialize, Default)]
pub struct Main {
    #[serde(rename = "base-clusters", default)]
    pub base: Option<Base>,
    #[serde(rename = "group-clusters", default)]
    pub groups: Option<Vec<Group>>,
}
#[derive(Debug, Clone, Deserialize, Default)]
pub struct Mapping {
    #[serde(rename = "bidToPid", default)]
    pub rows: Option<Vec<Vec<i32>>>,
}
#[derive(Debug, Clone)]
pub struct Bundle {
    pub tick: i64,
    pub main: Main,
    pub mapping: Mapping,
}
#[derive(Debug, Clone)]
pub enum Read {
    Absent,
    Incoherent(i64),
    Complete(Bundle),
}
impl Read {
    pub fn tick(&self) -> i64 {
        match self {
            Self::Absent => 0,
            Self::Incoherent(t) => *t,
            Self::Complete(b) => b.tick,
        }
    }
}
#[derive(Clone)]
struct Entry {
    expiration: f64,
    read: Arc<Read>,
}
pub struct Cache {
    entries: Mutex<Lru<(String, i32), Entry>>,
}
impl Cache {
    pub fn new(enabled: bool) -> Self {
        Self {
            entries: Mutex::new(Lru::new(if enabled { 100 } else { 1 })),
        }
    }
    pub async fn get(&self, pool: &Arc<Pool>, zid: i32, env: &str) -> Option<Arc<Read>> {
        let key = (env.to_owned(), zid);
        if let Some(cached) = self
            .entries
            .lock()
            .ok()?
            .get(&key)
            .filter(|e| e.expiration > crate::clock::now_ms())
        {
            return Some(cached.read);
        }
        let namespace = env.to_owned();
        let read = Arc::new(
            pool.with(move |c| read(c, zid, &namespace))
                .await
                .ok()
                .flatten()?,
        );
        self.entries.lock().ok()?.set(
            key,
            Entry {
                expiration: crate::clock::now_ms() + 3000.0,
                read: read.clone(),
            },
        );
        Some(read)
    }
}
pub fn read(c: &mut postgres::Client, zid: i32, env: &str) -> anyhow::Result<Option<Read>> {
    let rows=c.query("SELECT m.math_tick,b.math_tick,p.math_tick,t.math_tick,CASE WHEN octet_length(m.data::text)<=65536 THEN m.data::text END,CASE WHEN octet_length(b.data::text)<=65536 THEN b.data::text END,p.data IS NOT NULL AND p.data<>'null'::jsonb FROM math_main m LEFT JOIN math_bidtopid b ON b.zid=m.zid AND b.math_env=m.math_env LEFT JOIN math_ptptstats p ON p.zid=m.zid AND p.math_env=m.math_env LEFT JOIN math_ticks t ON t.zid=m.zid AND t.math_env=m.math_env WHERE m.zid=$1 AND m.math_env=$2 LIMIT 2",&[&zid,&env])?;
    if rows.len() > 1 {
        return Ok(None);
    }
    let Some(r) = rows.first() else {
        return Ok(Some(Read::Absent));
    };
    let tick = r.try_get::<_, Option<i64>>(0)?.unwrap_or(-1);
    if tick.unsigned_abs() > 9007199254740991 {
        return Ok(None);
    }
    let Some(main) = r.try_get::<_, Option<String>>(4)? else {
        return Ok(None);
    };
    let mapping = r.try_get::<_, Option<String>>(5)?;
    let matching = (1..=3).all(|i| r.try_get::<_, Option<i64>>(i).ok() == Some(Some(tick)));
    if !matching
        || mapping.as_deref() == Some("null")
        || !r.try_get::<_, Option<bool>>(6)?.unwrap_or(false)
    {
        return Ok(Some(Read::Incoherent(tick)));
    }
    let Some(mapping) = mapping else {
        return Ok(None);
    };
    let main: Main = match serde_json::from_str(&main) {
        Ok(v) => v,
        Err(_) => return Ok(None),
    };
    let mapping: Mapping = match serde_json::from_str(&mapping) {
        Ok(v) => v,
        Err(_) => return Ok(None),
    };
    Ok(Some(Read::Complete(Bundle {
        tick,
        main,
        mapping,
    })))
}
impl Bundle {
    pub fn bid(&self, pid: i32) -> Option<i32> {
        let position = self
            .mapping
            .rows
            .as_ref()?
            .iter()
            .position(|pids| pids.contains(&pid))?;
        Some(
            self.main
                .base
                .as_ref()
                .and_then(|b| b.id.get(position))
                .copied()
                .unwrap_or(-1),
        )
    }
    pub fn pids(&self, gid: i32) -> Option<Vec<i32>> {
        let Some(group) = usize::try_from(gid)
            .ok()
            .and_then(|i| self.main.groups.as_ref()?.get(i))
        else {
            return Some(vec![]);
        };
        let mut pids = Vec::new();
        for bid in &group.members {
            // JavaScript's assigned bid index keeps the final occurrence of an ID.
            if let Some(i) = self
                .main
                .base
                .as_ref()
                .and_then(|b| b.id.iter().rposition(|x| x == bid))
                && let Some(more) = self.mapping.rows.as_ref().and_then(|r| r.get(i))
            {
                if pids.len().checked_add(more.len())? > 16384 {
                    return None;
                }
                pids.extend_from_slice(more);
            }
        }
        pids.sort_unstable();
        Some(pids)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn repeated_group_members_cannot_multiply_the_pid_buffer_without_bound() {
        let b = Bundle {
            tick: 0,
            main: Main {
                base: Some(Base { id: vec![1] }),
                groups: Some(vec![Group {
                    members: vec![1; 200],
                }]),
            },
            mapping: Mapping {
                rows: Some(vec![vec![0; 200]]),
            },
        };
        assert!(b.pids(0).is_none());
        assert_eq!(b.pids(-1), Some(vec![]));
    }
}
