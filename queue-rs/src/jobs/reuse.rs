//! Stored comment embeddings a full-pipeline run may reuse
//! (`delphi-embedding-reuse/1`).
//!
//! One switch, default off (`POLIS_JOBS_EMBEDDINGS_REUSE=1`), effective only
//! with the embeddings table (`DELPHI_EMBEDDINGS_TABLE=1`) and the input
//! bundle (`POLIS_JOBS_INPUT_BUNDLE=1`). When all three are on, the daemon,
//! after reading the bundle and on the same connection, reads the stored
//! vectors of this env, conversation and model and writes them beside the
//! bundle as `inputs/embeddings.spool`, in the embeddings spool layout
//! (`jobs::embedding`). The frame names it in `inputs.embeddings`. The child
//! may then encode only the comments the file does not hold with the text
//! SHA-256 it computes for them today.
//!
//! Which rows: every `delphi_comment_embeddings` row of (env, zid, model)
//! whose own attempt closed its set (`delphi_embedding_sets` for the row's
//! `batch_id` and model exists) and that lies under that set's `seq_mark`.
//! The table's primary key holds one row per comment id, so that row is the
//! newest stored vector for it. Rows an attempt wrote and never closed (it
//! failed or is still running) are never handed over. Model identity is the
//! exact `delphi_embedding_models.name` (repository, revision and width, as
//! `repo@revision:dims`), so a changed model resolves to another row, or to
//! none, and reuses nothing.
//!
//! A reuse file never fails, retries or holds up a run past its bound: any
//! absence, bound or error leaves the run without the file and the frame says
//! why in one word (`reason`). The read is two statements in one read-only
//! transaction, each under `statement_timeout` 20 s and `lock_timeout` 5 s; it
//! takes ACCESS SHARE only, and reads by the primary keys
//! (`delphi_embedding_models` by its unique name, `delphi_comment_embeddings`
//! by `(env, zid, model_id, tid)`, `delphi_embedding_sets` by
//! `(env, batch_id, model_id)`). The file is bounded by `MAX_SPOOL_BYTES`.
use super::embedding::{self, MAX_SPOOL_BYTES, MODEL_MINILM, Row};
use super::sha256_hex;
use crate::job_graph_contract::{Model, Step};
use postgres::error::SqlState;
use postgres::{Client, IsolationLevel};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::path::Path;

/// The frame value's schema.
pub const SCHEMA: &str = "delphi-embedding-reuse/1";
/// The file, relative to the attempt directory (the frame's directory).
pub const FILE: &str = "inputs/embeddings.spool";
const STATEMENT_TIMEOUT: &str = "20s";
const LOCK_TIMEOUT: &str = "5s";
/// The spool header before the model name: magic, dims, row count, name length.
const HEADER: usize = 16;

/// The rows of one closed-set read, before they are written.
pub struct Stored {
    pub model_id: i16,
    pub dims: u16,
    pub rows: Vec<Row>,
}

/// Why a run goes on without the file, as the frame's one word.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Skip {
    /// The run's model could not be named, or names no stored model.
    Model,
    /// The stored-embeddings tables are not in this database.
    Absent,
    /// No closed-set row for this env, conversation and model.
    Empty,
    /// More rows than `MAX_SPOOL_BYTES` holds.
    Bound,
    /// A statement or lock timeout.
    Timeout,
    /// The login may not read the tables.
    Denied,
    /// A row the spool cannot carry (width, value).
    Unreadable,
    /// Any other read or connection error.
    Failed,
    /// The file could not be written.
    Unwritable,
}

impl Skip {
    pub fn word(self) -> &'static str {
        match self {
            Skip::Model => "model",
            Skip::Absent => "absent",
            Skip::Empty => "empty",
            Skip::Bound => "bound",
            Skip::Timeout => "timeout",
            Skip::Denied => "denied",
            Skip::Unreadable => "unreadable",
            Skip::Failed => "failed",
            Skip::Unwritable => "unwritable",
        }
    }
}

/// What the daemon asks for: the queue env the rows are stored under, the
/// stored name of the run's model (None when it could not be named), and the
/// file's bound.
pub struct Request {
    pub env: String,
    pub model: Option<String>,
    pub max_bytes: usize,
}

fn classify(error: &postgres::Error) -> Skip {
    match error.code() {
        Some(c) if *c == SqlState::QUERY_CANCELED || *c == SqlState::LOCK_NOT_AVAILABLE => {
            Skip::Timeout
        }
        Some(c) if *c == SqlState::INSUFFICIENT_PRIVILEGE => Skip::Denied,
        Some(c) if *c == SqlState::UNDEFINED_TABLE => Skip::Absent,
        _ => Skip::Failed,
    }
}

/// The rows statement (public so a database test can read its plan).
pub const ROWS: &str = "SELECT e.tid, e.text_sha, e.embedding \
     FROM public.delphi_comment_embeddings e \
     JOIN public.delphi_embedding_sets s \
       ON s.env = e.env AND s.batch_id = e.batch_id AND s.model_id = e.model_id \
     WHERE e.env = $1 AND e.zid = $2 AND e.model_id = $3 \
       AND s.zid = e.zid AND e.seq <= s.seq_mark \
     ORDER BY e.tid LIMIT $4";

/// Read the closed-set rows of (env, zid, model), at most as many as
/// `max_bytes` of spool can hold.
pub fn read(
    client: &mut Client,
    env: &str,
    zid: i64,
    model: &str,
    max_bytes: usize,
) -> Result<Stored, Skip> {
    let zid = i32::try_from(zid).map_err(|_| Skip::Empty)?;
    let mut tx = client
        .build_transaction()
        .isolation_level(IsolationLevel::RepeatableRead)
        .read_only(true)
        .start()
        .map_err(|e| classify(&e))?;
    tx.batch_execute(&format!(
        "SET LOCAL statement_timeout = '{STATEMENT_TIMEOUT}'; \
         SET LOCAL lock_timeout = '{LOCK_TIMEOUT}'; SET LOCAL enable_seqscan = off"
    ))
    .map_err(|e| classify(&e))?;
    let m = tx
        .query_opt(
            "SELECT model_id, dims FROM public.delphi_embedding_models WHERE name = $1",
            &[&model],
        )
        .map_err(|e| classify(&e))?
        .ok_or(Skip::Model)?;
    let model_id: i16 = m.try_get(0).map_err(|_| Skip::Unreadable)?;
    let dims: i16 = m.try_get(1).map_err(|_| Skip::Unreadable)?;
    let dims = u16::try_from(dims).map_err(|_| Skip::Unreadable)?;
    let stride = 36 + 4 * usize::from(dims);
    let max_rows = max_bytes.saturating_sub(HEADER + model.len()) / stride;
    let limit = i64::try_from(max_rows).unwrap_or(i64::MAX - 1) + 1;
    let found = tx
        .query(ROWS, &[&env, &zid, &model_id, &limit])
        .map_err(|e| classify(&e))?;
    if found.len() > max_rows {
        return Err(Skip::Bound);
    }
    if found.is_empty() {
        return Err(Skip::Empty);
    }
    let mut rows = Vec::with_capacity(found.len());
    for r in &found {
        let text_sha: Vec<u8> = r.try_get(1).map_err(|_| Skip::Unreadable)?;
        rows.push(Row {
            tid: r.try_get(0).map_err(|_| Skip::Unreadable)?,
            text_sha: text_sha.try_into().map_err(|_| Skip::Unreadable)?,
            vector: r.try_get(2).map_err(|_| Skip::Unreadable)?,
        });
    }
    tx.commit().map_err(|e| classify(&e))?;
    Ok(Stored {
        model_id,
        dims,
        rows,
    })
}

/// Write the rows as `attempt_dir/inputs/embeddings.spool` (a temporary file
/// renamed into place) and return (sha256, rows).
pub fn write(
    attempt_dir: &Path,
    model: &str,
    stored: &Stored,
    max_bytes: usize,
) -> Result<(String, usize), Skip> {
    let spool = embedding::write_spool(model, stored.dims, &stored.rows).map_err(|e| {
        if e.to_string() == "embedding_spool_bound" {
            Skip::Bound
        } else {
            Skip::Unreadable
        }
    })?;
    if spool.len() > max_bytes.min(MAX_SPOOL_BYTES) {
        return Err(Skip::Bound);
    }
    let path = attempt_dir.join(FILE);
    let temporary = attempt_dir.join(format!("{FILE}.tmp"));
    let written = path
        .parent()
        .map_or(Ok(()), std::fs::create_dir_all)
        .and_then(|_| std::fs::write(&temporary, &spool))
        .and_then(|_| std::fs::rename(&temporary, &path));
    if written.is_err() {
        let _ = std::fs::remove_file(&temporary);
        let _ = std::fs::remove_file(&path);
        return Err(Skip::Unwritable);
    }
    Ok((sha256_hex(&spool), stored.rows.len()))
}

/// Read and write on the bundle's connection; never an error: the frame's
/// `inputs.embeddings` value, with the file or with the reason there is none.
pub fn prepare(client: &mut Client, attempt_dir: &Path, zid: i64, request: &Request) -> Value {
    let Some(model) = request.model.as_deref() else {
        return frame(request, zid, Err(Skip::Model));
    };
    let done = read(client, &request.env, zid, model, request.max_bytes).and_then(|stored| {
        write(attempt_dir, model, &stored, request.max_bytes)
            .map(|(sha, rows)| (sha, rows, stored.model_id, stored.dims))
    });
    frame(request, zid, done)
}

/// One shape whether or not the file was written: the file's keys are null
/// and `reason` names why when it was not; `reason` is null when it was.
pub fn frame(request: &Request, zid: i64, done: Result<(String, usize, i16, u16), Skip>) -> Value {
    match done {
        Ok((sha, rows, model_id, dims)) => json!({
            "schema": SCHEMA, "file": FILE, "sha256": sha, "rows": rows,
            "model": request.model, "model_id": model_id, "dims": dims,
            "env": request.env, "zid": zid, "reason": null,
        }),
        Err(skip) => json!({
            "schema": SCHEMA, "file": null, "sha256": null, "rows": null,
            "model": request.model, "model_id": null, "dims": null,
            "env": request.env, "zid": zid, "reason": skip.word(),
        }),
    }
}

/// The stored name of the model the full pipeline will embed with, from the
/// same settings Delphi's `embedding_model.resolve()` reads, mapped as
/// `put_comment_embeddings_table` maps it before storing. None when it cannot
/// be named here; then nothing is handed over. This only chooses which rows to
/// read: the child compares the file's `model` with its own resolved name and
/// ignores the file on any difference, so a mistake here costs reuse, never a
/// wrong vector.
pub fn run_model(get: &dyn Fn(&str) -> Option<String>) -> Option<String> {
    let set = |key: &str| {
        get(key)
            .map(|v| v.trim().to_owned())
            .filter(|v| !v.is_empty())
    };
    let default = crate::shadow::graph::default_model().ok()?;
    let (default_repo, rest) = default.split_once('@')?;
    let (_, width) = rest.rsplit_once(':')?;
    let mut configured = set("SENTENCE_TRANSFORMER_MODEL");
    if let Some(selection) = get("DELPHI_EMBED_MODEL_BY_ENV").filter(|v| !v.is_empty()) {
        let mapping: BTreeMap<String, String> = serde_json::from_str(&selection).ok()?;
        let environment = get("DELPHI_RESULT_ENV")
            .or_else(|| get("QUEUE_ENV"))
            .unwrap_or_default();
        if let Some(chosen) = mapping.get(&environment) {
            let definition = Model::named(chosen).and_then(|m| m.definition()).ok()?;
            if definition.step != Step::Embeddings || definition.model != *chosen {
                return None;
            }
            configured = Some(chosen.clone());
        }
    }
    let name = if set("DELPHI_EMBED_MODEL_PATH").is_some() {
        let path = set("DELPHI_EMBED_MODEL_LOCK")?;
        let bytes = std::fs::read(path).ok().filter(|b| b.len() <= 1_048_576)?;
        let lock: Value = serde_json::from_slice(&bytes).ok()?;
        if lock["schema"] != "delphi-embedding-model/1" {
            return None;
        }
        let repo = lock["repo"].as_str().filter(|s| !s.is_empty())?;
        let revision = lock["revision"].as_str().filter(|s| !s.is_empty())?;
        let name = format!("{repo}@{revision}:{width}");
        if let Some(c) = configured.as_deref()
            && c != repo
            && Some(c) != lock["name"].as_str()
            && c != name
        {
            return None;
        }
        name
    } else {
        match configured.as_deref() {
            None => default.to_owned(),
            Some(c) if c == default || c == default_repo => default.to_owned(),
            Some(c) => c.to_owned(),
        }
    };
    match name.as_str() {
        "all-MiniLM-L6-v2" | MODEL_MINILM => Some(MODEL_MINILM.to_owned()),
        n if n == default => Some(name),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resolve(pairs: &[(&str, &str)]) -> Option<String> {
        let map: BTreeMap<String, String> = pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect();
        run_model(&|k| map.get(k).cloned())
    }

    fn default() -> String {
        crate::shadow::graph::default_model()
            .map(str::to_owned)
            .unwrap_or_default()
    }

    #[test]
    fn the_run_model_is_named_as_delphi_stores_it() {
        assert_eq!(resolve(&[]), Some(default()));
        let repo = default().split_once('@').map(|(r, _)| r.to_owned());
        let repo = repo.unwrap_or_default();
        assert_eq!(
            resolve(&[("SENTENCE_TRANSFORMER_MODEL", &repo)]),
            Some(default())
        );
        assert_eq!(
            resolve(&[("SENTENCE_TRANSFORMER_MODEL", "all-MiniLM-L6-v2")]),
            Some(MODEL_MINILM.to_owned())
        );
        // A model Delphi's store has no name for is not read at all.
        assert_eq!(
            resolve(&[("SENTENCE_TRANSFORMER_MODEL", "other/model")]),
            None
        );
        // The per-environment choice wins for the child's own environment.
        let by_env = format!(r#"{{"shadow-a":"{MODEL_MINILM}"}}"#);
        assert_eq!(
            resolve(&[
                ("DELPHI_EMBED_MODEL_BY_ENV", &by_env),
                ("DELPHI_RESULT_ENV", "shadow-a")
            ]),
            Some(MODEL_MINILM.to_owned())
        );
        assert_eq!(
            resolve(&[
                ("DELPHI_EMBED_MODEL_BY_ENV", &by_env),
                ("DELPHI_RESULT_ENV", "shadow-b")
            ]),
            Some(default())
        );
        assert_eq!(resolve(&[("DELPHI_EMBED_MODEL_BY_ENV", "[1]")]), None);
    }

    #[test]
    fn a_local_model_is_named_from_its_lock() {
        let dir = std::env::temp_dir().join(format!("polis-reuse-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap_or_default();
        let lock = dir.join("model.lock.json");
        let (repo, rest) = default()
            .split_once('@')
            .map_or((String::new(), String::new()), |(a, b)| {
                (a.to_owned(), b.to_owned())
            });
        let revision = rest
            .rsplit_once(':')
            .map(|(r, _)| r.to_owned())
            .unwrap_or_default();
        let write = |revision: &str| {
            std::fs::write(
                &lock,
                json!({"schema": "delphi-embedding-model/1", "repo": repo, "revision": revision})
                    .to_string(),
            )
            .unwrap_or_default()
        };
        write(&revision);
        let path = [
            ("DELPHI_EMBED_MODEL_PATH", "/models/granite"),
            ("DELPHI_EMBED_MODEL_LOCK", lock.to_str().unwrap_or_default()),
        ];
        assert_eq!(resolve(&path), Some(default()));
        // Another revision is another model: nothing the store names.
        write("0000000000000000000000000000000000000000");
        assert_eq!(resolve(&path), None);
        assert_eq!(resolve(&path[..1]), None, "a directory with no lock");
        std::fs::remove_dir_all(&dir).unwrap_or_default();
    }

    #[test]
    fn every_reason_is_one_word_and_the_frame_keeps_one_shape() {
        let request = Request {
            env: "shadow-a".into(),
            model: Some(MODEL_MINILM.into()),
            max_bytes: MAX_SPOOL_BYTES,
        };
        let skipped = frame(&request, 7, Err(Skip::Empty));
        let written = frame(&request, 7, Ok(("ab".into(), 2, 1, 384)));
        let keys = |v: &Value| v.as_object().map(|o| o.keys().cloned().collect::<Vec<_>>());
        assert_eq!(keys(&skipped), keys(&written));
        assert_eq!(skipped["reason"], "empty");
        assert!(skipped["file"].is_null());
        assert_eq!(written["file"], FILE);
        assert!(written["reason"].is_null());
        for skip in [
            Skip::Model,
            Skip::Absent,
            Skip::Empty,
            Skip::Bound,
            Skip::Timeout,
            Skip::Denied,
            Skip::Unreadable,
            Skip::Failed,
            Skip::Unwritable,
        ] {
            assert!(skip.word().chars().all(|c| c.is_ascii_lowercase()));
        }
    }

    #[test]
    fn the_written_file_is_the_spool_layout_and_its_bound_holds() {
        let dir = std::env::temp_dir().join(format!("polis-reuse-{}", uuid::Uuid::new_v4()));
        let stored = Stored {
            model_id: 1,
            dims: 3,
            rows: vec![
                Row {
                    tid: 0,
                    text_sha: [1; 32],
                    vector: vec![0.5, -1.0, 2.25],
                },
                Row {
                    tid: 7,
                    text_sha: [2; 32],
                    vector: vec![0.0, 1.5, -3.5],
                },
            ],
        };
        let (sha, rows) = write(&dir, "m", &stored, MAX_SPOOL_BYTES).unwrap_or_default();
        let bytes = std::fs::read(dir.join(FILE)).unwrap_or_default();
        assert_eq!((sha, rows), (sha256_hex(&bytes), 2));
        let back = embedding::read_spool(&bytes).ok();
        assert_eq!(back, Some(("m".into(), 3, stored.rows.clone())));
        // One byte under the spool's size is refused, and no file is left.
        let other = dir.join("other");
        assert_eq!(
            write(&other, "m", &stored, bytes.len() - 1).err(),
            Some(Skip::Bound)
        );
        assert!(!other.join(FILE).exists());
        std::fs::remove_dir_all(&dir).unwrap_or_default();
    }
}
