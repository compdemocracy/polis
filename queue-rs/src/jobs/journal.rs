//! Restart journal on a host volume (build spec §1.3 "recover", §1.7).
//!
//! Before a child is spawned the daemon writes and fsyncs one entry per
//! attempt. On start it confirms the exit of every entry whose process is
//! provably gone, calling the `/2` `pq_fail(…, false, 'daemon_restarted', true)`
//! with the journaled identity, and deletes the entry once the RPC returns.
//! An entry is provably gone when its boot id or container id differs from
//! this process's (the daemon was PID 1 of the namespace that held it), when
//! this daemon is itself PID 1 of a fresh namespace, or when, on the same
//! host, both the recorded daemon pid and the child's process group are gone.
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Entry {
    pub schema: String,
    pub env: String,
    pub owner_id: String,
    pub job_id: String,
    pub attempt_id: String,
    pub lease_epoch: String,
    pub pgid: Option<i32>,
    pub daemon_pid: u32,
    pub boot_id: String,
    pub container_id: String,
}

pub const SCHEMA: &str = "polis_jobs.journal/1";

pub struct Journal {
    dir: PathBuf,
    /// Held for the process lifetime: one daemon per journal directory.
    _lock: File,
}

fn fsync_dir(dir: &Path) -> std::io::Result<()> {
    File::open(dir)?.sync_all()
}

impl Journal {
    /// Open the directory; refuse (exit 2 at the caller) if it is not writable.
    pub fn open(dir: &Path) -> anyhow::Result<Self> {
        fs::create_dir_all(dir)?;
        // Two daemons sharing a journal would read each other's live entries
        // as provably gone (different container id). Refuse instead.
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(dir.join(".lock"))?;
        // SAFETY: flock on a file descriptor we own.
        let rc = unsafe {
            libc::flock(
                std::os::fd::AsRawFd::as_raw_fd(&lock),
                libc::LOCK_EX | libc::LOCK_NB,
            )
        };
        anyhow::ensure!(
            rc == 0,
            "journal directory is locked by another polis-jobs process"
        );
        let probe = dir.join(format!(".probe-{}", std::process::id()));
        {
            let mut f = OpenOptions::new()
                .create(true)
                .truncate(true)
                .write(true)
                .open(&probe)?;
            f.write_all(b"probe")?;
            f.sync_all()?;
        }
        fs::remove_file(&probe)?;
        Ok(Self {
            dir: dir.to_owned(),
            _lock: lock,
        })
    }

    fn path(&self, attempt_id: &str) -> PathBuf {
        self.dir.join(format!("{attempt_id}.json"))
    }

    /// Write atomically (temp file, fsync, rename, fsync directory).
    pub fn write(&self, entry: &Entry) -> anyhow::Result<()> {
        anyhow::ensure!(
            uuid::Uuid::parse_str(&entry.attempt_id).is_ok(),
            "journal attempt id"
        );
        let tmp = self.dir.join(format!(".{}.tmp", entry.attempt_id));
        {
            let mut f = OpenOptions::new()
                .create(true)
                .truncate(true)
                .write(true)
                .open(&tmp)?;
            f.write_all(&serde_json::to_vec(entry)?)?;
            f.sync_all()?;
        }
        fs::rename(&tmp, self.path(&entry.attempt_id))?;
        fsync_dir(&self.dir)?;
        Ok(())
    }

    pub fn remove(&self, attempt_id: &str) -> anyhow::Result<()> {
        match fs::remove_file(self.path(attempt_id)) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
        fsync_dir(&self.dir)?;
        Ok(())
    }

    /// Every readable entry; unreadable files are reported and left in place.
    pub fn entries(&self) -> Vec<Entry> {
        let Ok(dir) = fs::read_dir(&self.dir) else {
            return vec![];
        };
        let mut out = Vec::new();
        for item in dir.flatten() {
            let path = item.path();
            let name = item.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || !name.ends_with(".json") {
                continue;
            }
            match fs::read(&path)
                .ok()
                .and_then(|b| serde_json::from_slice::<Entry>(&b).ok())
                .filter(|e| e.schema == SCHEMA)
            {
                Some(entry) => out.push(entry),
                None => eprintln!("polis_jobs journal entry unreadable, left in place: {name}"),
            }
        }
        out.sort_by(|a, b| a.attempt_id.cmp(&b.attempt_id));
        out
    }
}

fn pid_alive(pid: i32) -> bool {
    // SAFETY: signal 0 performs only the existence/permission check.
    let rc = unsafe { libc::kill(pid, 0) };
    rc == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// Whether the entry's process is provably gone (see module docs).
pub fn provably_gone(entry: &Entry, boot_id: &str, container_id: &str, owner_id: &str) -> bool {
    if entry.boot_id != boot_id || entry.container_id != container_id {
        return true;
    }
    if entry.owner_id == owner_id {
        return false;
    }
    if std::process::id() == 1 {
        return true;
    }
    let daemon_gone = i32::try_from(entry.daemon_pid).is_ok_and(|p| !pid_alive(p));
    let group_gone = match entry.pgid {
        Some(pgid) if pgid > 1 => !pid_alive(-pgid),
        // Written before spawn and never rewritten: a child may have been
        // spawned before a crash, so the group is unknown, not gone.
        None => false,
        Some(_) => false,
    };
    daemon_gone && group_gone
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(attempt: &str) -> Entry {
        Entry {
            schema: SCHEMA.into(),
            env: "dev".into(),
            owner_id: "00000000-0000-4000-8000-0000000000aa".into(),
            job_id: "00000000-0000-4000-8000-000000000001".into(),
            attempt_id: attempt.into(),
            lease_epoch: "1".into(),
            pgid: None,
            daemon_pid: 999_999,
            boot_id: "boot-a".into(),
            container_id: "box-a".into(),
        }
    }

    #[test]
    fn write_read_remove_round_trip() {
        let dir = std::env::temp_dir().join(format!("polis-jobs-journal-{}", uuid::Uuid::new_v4()));
        let j = Journal::open(&dir).unwrap_or_else(|e| panic!("{e}"));
        let e = entry("00000000-0000-4000-8000-000000000002");
        j.write(&e).unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(j.entries(), vec![e.clone()]);
        j.remove(&e.attempt_id).unwrap_or_else(|e| panic!("{e}"));
        assert!(j.entries().is_empty());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn one_daemon_per_journal_directory() {
        let dir = std::env::temp_dir().join(format!("polis-jobs-lock-{}", uuid::Uuid::new_v4()));
        let first = Journal::open(&dir).unwrap_or_else(|e| panic!("{e}"));
        assert!(Journal::open(&dir).is_err(), "second holder refused");
        drop(first);
        assert!(Journal::open(&dir).is_ok(), "free again once released");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn provenance_rules() {
        let e = entry("00000000-0000-4000-8000-000000000002");
        let me = "00000000-0000-4000-8000-0000000000bb";
        assert!(provably_gone(&e, "boot-b", "box-a", me));
        assert!(provably_gone(&e, "boot-a", "box-b", me));
        // Same host, daemon gone, but no pgid recorded: exit is unproven.
        assert!(!provably_gone(&e, "boot-a", "box-a", me));
        // Same host, daemon and recorded group gone.
        let mut gone = e.clone();
        gone.pgid = Some(999_998);
        assert!(provably_gone(&gone, "boot-a", "box-a", me));
        // Our own live entry is never recovered.
        assert!(!provably_gone(&e, "boot-a", "box-a", &e.owner_id));
        // Same host and the recorded daemon is alive (this test process).
        let mut alive = e.clone();
        alive.daemon_pid = std::process::id();
        assert!(!provably_gone(&alive, "boot-a", "box-a", me));
    }
}
