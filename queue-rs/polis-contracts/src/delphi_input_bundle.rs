//! `delphi-input-bundle/1`: the files polis-jobs writes into an attempt's
//! work directory before a `delphi_full_pipeline` child starts, so the Python
//! stages read their inputs from files instead of from Postgres.
//!
//! A bundle is a directory holding `manifest.json` and one file per [`Role`].
//! The manifest names each file with its row schema, row count, byte size and
//! sha256, and carries the run's `inputs` block exactly as the output manifest
//! records it (`polis-jobs.output-manifest/2`'s `inputs`). The job frame binds
//! the manifest by path and sha256 (`inputs.bundle`); without that key the
//! child reads Postgres as before.
//!
//! The rows are what the stages read today, column for column:
//! - the conversation's `topic`, `description`, `created`, `modified`, `owner`
//!   (`umap_narrative/run_pipeline.py`, `fetch_conversation_data`);
//! - every comment's `tid, zid, pid, txt, created, mod, active`, ordered by
//!   tid (`PostgresClient.get_comments_by_conversation`);
//! - every `report_comment_selections` row of the conversation, ordered by
//!   rid then tid (`PostgresClient.get_report_comment_selections`).
//!
//! No vote row and no participant row crosses: no stage of the full pipeline
//! reads one. The votes reach the run only as `inputs.vote_hwm`, the newest
//! vote's `created`, as the input census has always recorded it.
//!
//! This file is compiled by two workspaces (polis-contracts and polis-jobs),
//! so it uses only serde, serde_json and sha2. The JSON Schema documents are
//! in `delphi_input_bundle_schema.rs`.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const CONTRACT_VERSION: &str = "delphi-input-bundle/1";
/// The manifest's file name inside the bundle directory.
pub const MANIFEST_FILE: &str = "manifest.json";
/// The header line of the comment-set digest (`census.py`, `COMMENT_SET_FORMAT`).
pub const COMMENT_SET_FORMAT: &str = "polis-jobs.comment-set/1";

/// One file of the bundle.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    Conversation,
    Comments,
    ReportCommentSelections,
}

impl Role {
    /// Every role, in the order the manifest lists them.
    pub const ALL: [Role; 3] = [
        Role::Conversation,
        Role::Comments,
        Role::ReportCommentSelections,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            Role::Conversation => "conversation",
            Role::Comments => "comments",
            Role::ReportCommentSelections => "report_comment_selections",
        }
    }

    /// The file's name inside the bundle directory.
    pub const fn file_name(self) -> &'static str {
        match self {
            Role::Conversation => "conversation.json",
            Role::Comments => "comments.json",
            Role::ReportCommentSelections => "report_comment_selections.json",
        }
    }

    /// The schema of the file's contents.
    pub const fn row_schema(self) -> &'static str {
        match self {
            Role::Conversation => "delphi-input-bundle.conversation/1",
            Role::Comments => "delphi-input-bundle.comments/1",
            Role::ReportCommentSelections => "delphi-input-bundle.report-comment-selections/1",
        }
    }
}

/// The conversation row (one JSON object).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Conversation {
    pub zid: i64,
    pub topic: Option<String>,
    pub description: Option<String>,
    pub created: Option<i64>,
    pub modified: Option<i64>,
    pub owner: Option<i64>,
}

/// One comment, as `get_comments_by_conversation` selects it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Comment {
    pub tid: i64,
    pub zid: i64,
    pub pid: i64,
    pub txt: String,
    pub created: Option<i64>,
    pub r#mod: i64,
    pub active: bool,
}

/// One `report_comment_selections` row.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReportCommentSelection {
    pub rid: i64,
    pub tid: i64,
    pub selection: i64,
    pub zid: i64,
    pub modified: Option<i64>,
}

/// The run's inputs, exactly the output manifest's `inputs` block.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Inputs {
    pub math_env: String,
    pub math_tick: Option<i64>,
    pub math_caching_tick: Option<i64>,
    pub comment_set_sha256: String,
    pub vote_hwm: Option<i64>,
}

/// One file entry of the manifest.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FileEntry {
    pub role: Role,
    /// The file's name, relative to the manifest's directory.
    pub path: String,
    pub schema: String,
    pub rows: u64,
    pub bytes: u64,
    pub sha256: String,
}

/// `manifest.json`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub schema: String,
    pub zid: i64,
    pub inputs: Inputs,
    pub files: Vec<FileEntry>,
}

/// Why a manifest or a bundle was refused.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Invalid(pub String);

impl std::fmt::Display for Invalid {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "delphi-input-bundle/1 refused: {}", self.0)
    }
}

impl std::error::Error for Invalid {}

fn check(ok: bool, rule: &str) -> Result<(), Invalid> {
    if ok {
        Ok(())
    } else {
        Err(Invalid(rule.to_owned()))
    }
}

fn is_sha256_hex(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// The comment-set digest the input census records (`census.py`,
/// `comment_set_sha256`): sha256 over the header line, then one line per
/// comment ordered by tid, `tid\tmod\tactive\tsha256(txt)\n`, active as 1 or 0.
pub fn comment_set_sha256(comments: &[Comment]) -> String {
    let mut sorted: Vec<&Comment> = comments.iter().collect();
    sorted.sort_by_key(|c| c.tid);
    let mut h = Sha256::new();
    h.update(COMMENT_SET_FORMAT.as_bytes());
    h.update(b"\n");
    for c in sorted {
        let line = format!(
            "{}\t{}\t{}\t{}\n",
            c.tid,
            c.r#mod,
            u8::from(c.active),
            sha256_hex(c.txt.as_bytes())
        );
        h.update(line.as_bytes());
    }
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// A file's bytes: compact JSON and one trailing newline.
pub fn encode<T: Serialize + ?Sized>(value: &T) -> Result<Vec<u8>, Invalid> {
    let mut bytes = serde_json::to_vec(value).map_err(|e| Invalid(format!("encode: {e}")))?;
    bytes.push(b'\n');
    Ok(bytes)
}

impl Manifest {
    /// Every rule a manifest must meet before a child may read the bundle.
    pub fn check(&self) -> Result<(), Invalid> {
        check(self.schema == CONTRACT_VERSION, "schema")?;
        check(self.zid >= 0, "zid")?;
        let env = &self.inputs.math_env;
        check(!env.is_empty() && env.len() <= 999, "inputs.math_env")?;
        check(
            is_sha256_hex(&self.inputs.comment_set_sha256),
            "inputs.comment_set_sha256",
        )?;
        check(self.files.len() == Role::ALL.len(), "files")?;
        for (entry, role) in self.files.iter().zip(Role::ALL) {
            check(entry.role == role, "files.role")?;
            check(entry.path == role.file_name(), "files.path")?;
            check(entry.schema == role.row_schema(), "files.schema")?;
            check(is_sha256_hex(&entry.sha256), "files.sha256")?;
            check(role != Role::Conversation || entry.rows == 1, "files.rows")?;
        }
        Ok(())
    }

    pub fn file(&self, role: Role) -> Option<&FileEntry> {
        self.files.iter().find(|f| f.role == role)
    }
}

/// The rows of a bundle and the census values that are not derived from them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Bundle {
    pub conversation: Conversation,
    /// Ordered by tid.
    pub comments: Vec<Comment>,
    /// Ordered by rid, then tid.
    pub report_comment_selections: Vec<ReportCommentSelection>,
    pub math_env: String,
    pub math_tick: Option<i64>,
    pub math_caching_tick: Option<i64>,
    pub vote_hwm: Option<i64>,
}

/// The encoded bundle: each file's bytes, then the manifest's bytes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Encoded {
    pub files: Vec<(Role, Vec<u8>)>,
    pub manifest: Manifest,
    pub manifest_bytes: Vec<u8>,
}

impl Bundle {
    /// Encode every file and the manifest that binds them. Refuses rows out of
    /// order, rows of another conversation, and a manifest that breaks a rule.
    pub fn encode(&self) -> Result<Encoded, Invalid> {
        let zid = self.conversation.zid;
        check(
            self.comments.windows(2).all(|w| w[0].tid < w[1].tid),
            "comments order",
        )?;
        check(self.comments.iter().all(|c| c.zid == zid), "comments zid")?;
        check(
            self.report_comment_selections
                .windows(2)
                .all(|w| (w[0].rid, w[0].tid) < (w[1].rid, w[1].tid)),
            "report_comment_selections order",
        )?;
        check(
            self.report_comment_selections.iter().all(|s| s.zid == zid),
            "report_comment_selections zid",
        )?;
        let files = vec![
            (Role::Conversation, encode(&self.conversation)?, 1),
            (Role::Comments, encode(&self.comments)?, self.comments.len()),
            (
                Role::ReportCommentSelections,
                encode(&self.report_comment_selections)?,
                self.report_comment_selections.len(),
            ),
        ];
        let manifest = Manifest {
            schema: CONTRACT_VERSION.to_owned(),
            zid,
            inputs: Inputs {
                math_env: self.math_env.clone(),
                math_tick: self.math_tick,
                math_caching_tick: self.math_caching_tick,
                comment_set_sha256: comment_set_sha256(&self.comments),
                vote_hwm: self.vote_hwm,
            },
            files: files
                .iter()
                .map(|(role, bytes, rows)| FileEntry {
                    role: *role,
                    path: role.file_name().to_owned(),
                    schema: role.row_schema().to_owned(),
                    rows: *rows as u64,
                    bytes: bytes.len() as u64,
                    sha256: sha256_hex(bytes),
                })
                .collect(),
        };
        manifest.check()?;
        let manifest_bytes = encode(&manifest)?;
        Ok(Encoded {
            files: files.into_iter().map(|(r, b, _)| (r, b)).collect(),
            manifest,
            manifest_bytes,
        })
    }
}
