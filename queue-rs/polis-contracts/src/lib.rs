//! Versioned CLI envelopes. No server, database, or credential dependencies.
pub mod about;
pub mod connection;
pub mod contexts;
pub mod database;
pub mod domain_whitelist;
pub mod metadata_answers;
pub mod metadata_questions;
pub mod metadata_read;
pub mod robots;

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

/// Explicit vote wire declarations shared with CLI consumers.
pub mod votes;

pub mod setup;
