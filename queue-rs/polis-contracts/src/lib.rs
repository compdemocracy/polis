//! Versioned CLI envelopes. No server, database, or credential dependencies.
pub mod admin_page;
pub mod all_conversations;
pub mod auth_envelope;
pub mod bid_to_pid;
pub mod collective_statement;
pub mod connection;
pub mod contexts;
pub mod conversation_pages;
pub mod conversation_preload;
pub mod conversation_stats;
pub mod database;
pub mod delphi_input_bundle;
pub mod delphi_input_bundle_schema;
pub mod delphi_job_result;
pub mod delphi_logs;
pub mod delphi_read;
pub mod delphi_reports;
pub mod delphi_result_read;
pub mod delphi_run;
pub mod delphi_run_read;
pub mod delphi_visualizations;
pub mod domain_whitelist;
pub mod einvites_read;
pub mod integrate_page;
pub mod legacy_conversations;
pub mod legacy_pca;
pub mod link_pages;
pub mod math_membership;
pub mod metadata_answers;
pub mod metadata_choices;
pub mod metadata_query;
pub mod metadata_questions;
pub mod metadata_read;
pub mod my_invites_csv;
pub mod ops_catchall;
pub mod ops_page;
pub mod ops_whoami;
pub mod participant_token;
pub mod participants_read;
pub mod participation_init;
pub mod participation_read;
pub mod perf_stats;
pub mod post_comments;
pub mod post_votes;
pub mod ptptois;
pub mod recent_activity;
pub mod recent_started;
pub mod report_export;
pub mod reports_read;
pub mod robots;
pub mod schema;
pub mod topic_prioritize;
pub mod topic_selections;
pub mod topic_stats;
pub mod treevite_csv;
pub mod treevite_invites;
pub mod treevite_me;
pub mod treevite_my_invites;
pub mod treevite_waves;
pub mod version;
pub mod votes_read;
/// Byte-stable JSON shared by the Delphi contracts.
pub mod wire;
pub mod xid_report;

use serde::Serialize;
use serde_json::{json, Value};

pub const SCHEMA: &str = "polis-cli/1";

#[derive(Debug, Serialize)]
pub struct Error {
    pub code: &'static str,
    pub message: String,
    pub action: &'static str,
    pub retryable: bool,
    pub outcome: &'static str,
    pub upstream: Value,
    #[serde(skip)]
    pub exit: u8,
}
impl Error {
    pub fn new(
        code: &'static str,
        message: impl Into<String>,
        action: &'static str,
        exit: u8,
    ) -> Self {
        Self {
            code,
            message: message.into(),
            action,
            retryable: false,
            outcome: "not_sent",
            upstream: Value::Null,
            exit,
        }
    }
    pub fn input(message: impl Into<String>) -> Self {
        Self::new("invalid_input", message, "Run this command with --help.", 2)
    }
}
pub type Result<T> = std::result::Result<T, Error>;

pub fn envelope(site: &str, result: &Result<Value>) -> Value {
    let mut v = json!({"schema":SCHEMA,"ok":result.is_ok(),"site":site,
        "meta":{"usage":{"state":"unavailable","unit":null,"remaining":null,"as_of":null}},
        "warnings":[]});
    match result {
        Ok(data) => v["data"] = data.clone(),
        Err(e) => v["error"] = json!(e),
    }
    v
}

pub mod upstream;

/// A commit transport result. Unknown never means safe to repeat a write.
#[derive(Debug)]
pub enum Completion<T> {
    Committed(T),
    Unknown(T),
}

/// Codes emitted by the existing pca2 implementation. Keep the wire spelling.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pca2ErrorCode {
    MissingConversationId,
    ConversationLookup,
}
impl Pca2ErrorCode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::MissingConversationId => "polis_err_param_missing_conversation_id",
            Self::ConversationLookup => "polis_err_fetching_zid_for_conversation_id",
        }
    }
}

pub mod statement_importance;
/// Explicit vote wire declarations shared with CLI consumers.
pub mod votes;

pub mod setup;

pub mod topic_selection_writes;

pub mod xid_account;
