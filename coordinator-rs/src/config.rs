use anyhow::{Result, ensure};
use std::env;

#[derive(Clone)]
pub struct Config {
    pub database_url: String,
    pub math_env: String,
    pub python: String,
    pub owner: String,
    pub storage_agree_value: i64,
    pub shard_index: i32,
    pub shard_count: i32,
    pub allowlist: Vec<i32>,
    pub page_size: i64,
    pub window: i64,
    pub lease_seconds: i32,
    pub poll_ms: u64,
    pub cache_capacity: usize,
}
fn value<T: std::str::FromStr>(name: &str, default: &str) -> Result<T>
where
    T::Err: std::error::Error + Send + Sync + 'static,
{
    Ok(env::var(name)
        .unwrap_or_else(|_| default.to_owned())
        .parse()?)
}
impl Config {
    pub fn from_env() -> Result<Self> {
        let c = Self {
            database_url: env::var("DATABASE_URL")?,
            math_env: env::var("MATH_ENV").unwrap_or_else(|_| "rustproto".into()),
            python: env::var("P026_PYTHON").unwrap_or_else(|_| "python3".into()),
            owner: uuid::Uuid::new_v4().to_string(),
            storage_agree_value: value("STORAGE_AGREE_VALUE", "-1")?,
            shard_index: value("POLL_SHARD_INDEX", "0")?,
            shard_count: value("POLL_SHARD_COUNT", "1")?,
            allowlist: env::var("POLL_ALLOWLIST")
                .unwrap_or_default()
                .split(',')
                .filter(|s| !s.is_empty())
                .map(str::parse)
                .collect::<Result<_, _>>()?,
            page_size: value("P026_PAGE_SIZE", "16")?,
            window: value("P026_WINDOW", "64")?,
            lease_seconds: value("P026_LEASE_SECONDS", "120")?,
            poll_ms: value("P026_POLL_MS", "1000")?,
            cache_capacity: value("P026_CACHE_CAP", "16")?,
        };
        c.validate()?;
        Ok(c)
    }
    pub fn validate(&self) -> Result<()> {
        ensure!(
            matches!(self.storage_agree_value, -1 | 1),
            "invalid polarity"
        );
        ensure!(
            self.shard_count > 0 && (0..self.shard_count).contains(&self.shard_index),
            "invalid shard"
        );
        ensure!((1..=1000).contains(&self.page_size), "invalid page size");
        ensure!(self.window > 0, "invalid trailing window");
        ensure!(
            self.lease_seconds > 0 && self.poll_ms > 0,
            "invalid interval"
        );
        ensure!(
            !self.math_env.is_empty() && self.math_env.len() <= 999,
            "invalid namespace"
        );
        ensure!(self.cache_capacity <= 1024, "invalid warm cache capacity");
        Ok(())
    }
    pub fn accepts(&self, zid: i32) -> bool {
        zid % self.shard_count == self.shard_index
            && (self.allowlist.is_empty() || self.allowlist.contains(&zid))
    }
}
