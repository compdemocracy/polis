//! The Delphi input bundle (`delphi-input-bundle/1`).
//!
//! With `POLIS_JOBS_INPUT_BUNDLE=1`, before a `delphi_full_pipeline` child
//! starts, the daemon reads the rows that child's stages read from Postgres
//! today, in one read-only REPEATABLE READ snapshot, and writes them into
//! `inputs/` of the attempt directory: `conversation.json`, `comments.json`,
//! `report_comment_selections.json` and `manifest.json`. The frame names the
//! manifest in `inputs.bundle` (path relative to the attempt directory, and
//! its sha256), and the child reads the files instead of Postgres. Without the
//! switch nothing here runs and the frame is unchanged.
//!
//! The types and the encoding are the contract's own source file
//! (`polis-contracts/src/delphi_input_bundle.rs`), compiled here as
//! [`contract`], so the daemon cannot write a bundle the contract would not
//! decode.
//!
//! The rows are read with the child's own database setting (`DATABASE_URL`)
//! under the daemon's transport rules, on one connection opened for this read
//! and closed after it, never a pool the participation path uses. The queries
//! are the stages' own (`census.py`, `run_pipeline.py`,
//! `700_datamapplot_for_layer.py`), run once; the stages read the comments
//! three times. No vote row is read: the stages read only the votes'
//! high-water mark.
#[path = "../../polis-contracts/src/delphi_input_bundle.rs"]
pub mod contract;

use super::config::TransportKind;
use super::transport::Connector;
use anyhow::{Result, anyhow};
use contract::{Bundle, Comment, Conversation, ReportCommentSelection};
use postgres::{Client, IsolationLevel};
use serde_json::{Value, json};
use std::path::Path;

/// The bundle's directory inside the attempt directory.
const DIRECTORY: &str = "inputs";
/// The manifest, relative to the attempt directory (the frame's directory).
pub const MANIFEST: &str = "inputs/manifest.json";
/// Bounds every statement of the read; the stages' own reads have no bound.
const STATEMENT_TIMEOUT: &str = "120s";

/// Read the rows in one read-only snapshot. The casts keep the column types
/// out of the decoding: every integer is read as bigint. A conversation that
/// does not exist is refused: the stages could not run on it either.
pub fn read(client: &mut Client, zid: i64, math_env: &str) -> Result<Bundle> {
    let mut tx = client
        .build_transaction()
        .isolation_level(IsolationLevel::RepeatableRead)
        .read_only(true)
        .start()?;
    tx.batch_execute(&format!(
        "SET LOCAL statement_timeout = '{STATEMENT_TIMEOUT}'"
    ))?;
    let r = tx
        .query_opt(
            "SELECT zid::bigint, topic::text, description::text, created::bigint, \
             modified::bigint, owner::bigint FROM conversations WHERE zid = $1::bigint",
            &[&zid],
        )?
        .ok_or_else(|| anyhow!("conversation {zid} does not exist"))?;
    let conversation = Conversation {
        zid: r.try_get(0)?,
        topic: r.try_get(1)?,
        description: r.try_get(2)?,
        created: r.try_get(3)?,
        modified: r.try_get(4)?,
        owner: r.try_get(5)?,
    };
    let mut comments = Vec::new();
    for r in tx.query(
        "SELECT tid::bigint, zid::bigint, pid::bigint, txt::text, created::bigint, \
         mod::bigint, active FROM comments WHERE zid = $1::bigint ORDER BY tid",
        &[&zid],
    )? {
        comments.push(Comment {
            tid: r.try_get(0)?,
            zid: r.try_get(1)?,
            pid: r.try_get(2)?,
            txt: r.try_get(3)?,
            created: r.try_get(4)?,
            r#mod: r.try_get(5)?,
            active: r.try_get(6)?,
        });
    }
    let mut report_comment_selections = Vec::new();
    for r in tx.query(
        "SELECT rid::bigint, tid::bigint, selection::bigint, zid::bigint, modified::bigint \
         FROM report_comment_selections WHERE zid = $1::bigint ORDER BY rid, tid",
        &[&zid],
    )? {
        report_comment_selections.push(ReportCommentSelection {
            rid: r.try_get(0)?,
            tid: r.try_get(1)?,
            selection: r.try_get(2)?,
            zid: r.try_get(3)?,
            modified: r.try_get(4)?,
        });
    }
    let vote_hwm: Option<i64> = tx
        .query_one(
            "SELECT max(created)::bigint FROM votes WHERE zid = $1::bigint",
            &[&zid],
        )?
        .try_get(0)?;
    let (math_tick, math_caching_tick) = match tx.query_opt(
        "SELECT math_tick::bigint, caching_tick::bigint FROM math_main \
         WHERE zid = $1::bigint AND math_env = $2",
        &[&zid, &math_env],
    )? {
        Some(r) => (r.try_get(0)?, r.try_get(1)?),
        None => (None, None),
    };
    tx.commit()?;
    Ok(Bundle {
        conversation,
        comments,
        report_comment_selections,
        math_env: math_env.to_owned(),
        math_tick,
        math_caching_tick,
        vote_hwm,
    })
}

/// Write the bundle into `attempt_dir/inputs/` and return the frame's
/// `inputs.bundle` value.
pub fn write(attempt_dir: &Path, bundle: &Bundle) -> Result<Value> {
    let encoded = bundle.encode()?;
    let dir = attempt_dir.join(DIRECTORY);
    std::fs::create_dir_all(&dir)?;
    for (role, bytes) in &encoded.files {
        std::fs::write(dir.join(role.file_name()), bytes)?;
    }
    std::fs::write(dir.join(contract::MANIFEST_FILE), &encoded.manifest_bytes)?;
    Ok(json!({
        "manifest": MANIFEST,
        "schema": contract::CONTRACT_VERSION,
        "sha256": contract::sha256_hex(&encoded.manifest_bytes),
    }))
}

/// Connect with the child's database setting, read, close, write.
pub fn prepare(
    dsn: &str,
    transport: &TransportKind,
    attempt_dir: &Path,
    zid: i64,
    math_env: &str,
) -> Result<Value> {
    let bundle = {
        let mut client =
            Connector::from_parts(dsn, transport, None, "polis-jobs-inputs/1")?.connect()?;
        read(&mut client, zid, math_env)?
    };
    write(attempt_dir, &bundle)
}

/// The `math_env` the child's stages read: the frame's, else `MATH_ENV`, else
/// `prod` (the child refuses a frame whose value differs from its own).
pub fn math_env(frame_inputs: &Value, environment: Option<String>) -> String {
    frame_inputs
        .get("math_env")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or(environment.filter(|v| !v.is_empty()))
        .unwrap_or_else(|| "prod".to_owned())
}

#[cfg(test)]
pub mod tests {
    use super::contract::{Manifest, Role, comment_set_sha256, sha256_hex};
    use super::*;
    use std::path::PathBuf;

    /// The contract's golden bundle, written by the polis-contracts test
    /// (`tests/delphi_input_bundle.rs`) and read by the Delphi tests.
    fn golden_dir() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../delphi/tests/fixtures/input_bundle/basic")
    }

    /// The golden bundle's rows, decoded with the contract's types.
    pub fn golden_bundle() -> Result<Bundle> {
        let dir = golden_dir();
        let read = |name: &str| std::fs::read(dir.join(name));
        let manifest: Manifest = serde_json::from_slice(&read("manifest.json")?)?;
        Ok(Bundle {
            conversation: serde_json::from_slice(&read("conversation.json")?)?,
            comments: serde_json::from_slice(&read("comments.json")?)?,
            report_comment_selections: serde_json::from_slice(&read(
                "report_comment_selections.json",
            )?)?,
            math_env: manifest.inputs.math_env,
            math_tick: manifest.inputs.math_tick,
            math_caching_tick: manifest.inputs.math_caching_tick,
            vote_hwm: manifest.inputs.vote_hwm,
        })
    }

    /// The daemon writes the golden rows as the golden files, byte for byte,
    /// and the frame value names the manifest by its digest.
    #[test]
    fn the_written_bundle_is_the_contracts_golden_bundle() -> Result<()> {
        let dir = std::env::temp_dir().join(format!("polis-jobs-inputs-{}", uuid::Uuid::new_v4()));
        let frame = write(&dir, &golden_bundle()?)?;
        for name in [
            "conversation.json",
            "comments.json",
            "report_comment_selections.json",
            "manifest.json",
        ] {
            assert_eq!(
                std::fs::read(dir.join("inputs").join(name))?,
                std::fs::read(golden_dir().join(name))?,
                "{name}"
            );
        }
        let manifest = std::fs::read(dir.join(MANIFEST))?;
        assert_eq!(
            frame,
            json!({"manifest": "inputs/manifest.json", "schema": "delphi-input-bundle/1",
                   "sha256": sha256_hex(&manifest)})
        );
        std::fs::remove_dir_all(&dir)?;
        Ok(())
    }

    #[test]
    fn the_manifest_names_every_file_by_its_bytes() -> Result<()> {
        let bundle = golden_bundle()?;
        let encoded = bundle.encode()?;
        let m = &encoded.manifest;
        for ((role, bytes), entry) in encoded.files.iter().zip(&m.files) {
            assert_eq!(entry.role, *role);
            assert_eq!(entry.bytes, bytes.len() as u64);
            assert_eq!(entry.sha256, sha256_hex(bytes));
        }
        assert_eq!(m.file(Role::Conversation).map(|f| f.rows), Some(1));
        assert_eq!(
            m.file(Role::Comments).map(|f| f.rows),
            Some(bundle.comments.len() as u64)
        );
        assert_eq!(
            m.inputs.comment_set_sha256,
            comment_set_sha256(&bundle.comments)
        );
        Ok(())
    }

    /// No comments, no math and no votes: an empty array, nulls, and the
    /// census's digest of no comments (the format line alone).
    #[test]
    fn an_empty_conversation_writes_nulls_and_empty_arrays() -> Result<()> {
        let mut bundle = golden_bundle()?;
        bundle.comments.clear();
        bundle.report_comment_selections.clear();
        (bundle.math_tick, bundle.math_caching_tick, bundle.vote_hwm) = (None, None, None);
        let encoded = bundle.encode()?;
        assert_eq!(encoded.files[1].1, b"[]\n");
        assert_eq!(encoded.files[2].1, b"[]\n");
        assert_eq!(
            encoded.manifest.inputs.comment_set_sha256,
            sha256_hex(b"polis-jobs.comment-set/1\n")
        );
        assert!(encoded.manifest.inputs.vote_hwm.is_none());
        Ok(())
    }

    #[test]
    fn rows_out_of_order_or_of_another_conversation_are_refused() -> Result<()> {
        let mut b = golden_bundle()?;
        b.comments.swap(0, 1);
        assert!(b.encode().is_err());
        let mut b = golden_bundle()?;
        b.report_comment_selections[0].zid += 1;
        assert!(b.encode().is_err());
        let mut b = golden_bundle()?;
        b.math_env.clear();
        assert!(b.encode().is_err());
        Ok(())
    }

    #[test]
    fn math_env_is_the_frames_then_the_environments_then_prod() {
        assert_eq!(
            math_env(&json!({"math_env": "python"}), Some("other".into())),
            "python"
        );
        assert_eq!(
            math_env(&json!({"math_env": null}), Some("other".into())),
            "other"
        );
        assert_eq!(math_env(&json!({}), Some(String::new())), "prod");
        assert_eq!(math_env(&json!({}), None), "prod");
    }
}
