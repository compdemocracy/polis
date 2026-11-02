//! POST wave creation. Disabled unless POLIS_API_POST_TREEVITE_WAVES=1.
//! Uses POLIS_API_POST_TREEVITE_WAVES_DATABASE_URL (explicit primary).
//! Sanity stops include all statuses and promised, not yet issued child codes.
//! They are not request-rate limits and never throttle participation surge.
use serde::{Deserialize, Serialize};

pub const PATH: &str = "/api/v3/treevite/waves";
pub const CONVERSATION_CAP_ENV: &str = "POLIS_API_TREEVITE_CONVERSATION_CODE_CAP";
pub const OWNER_CAP_ENV: &str = "POLIS_API_TREEVITE_OWNER_CODE_CAP";
pub const DEFAULT_CONVERSATION_CAP: i64 = 250_000;
pub const DEFAULT_OWNER_CAP: i64 = 1_000_000;
/// Each create examines at most this many deficient consumed-parent allocations
/// across older child waves. Completed allocations are excluded before LIMIT,
/// so later creates (or accept reconciliation) can fill the remainder. Discovery
/// retains the writer's statement timeout; filling retains its total deadline.
pub const RECONCILIATION_ROW_LIMIT: i64 = 100;

/// Parsed JavaScript numbers; storage narrowing follows handler validation.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub conversation_id: String,
    pub invites_per_user: f64,
    pub owner_invites: f64,
    pub parent_wave: Option<f64>,
}

/// Field order is PostgreSQL RETURNING *, followed by invites_created. The
/// read endpoint has a different order. BIGSERIAL remains a JSON string.
/// invites_created counts only this wave; older-wave repairs are logged.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Response {
    pub id: String,
    pub zid: i32,
    pub wave: i32,
    pub parent_wave: i32,
    pub size: i32,
    pub invites_per_user: i32,
    pub owner_invites: i32,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub invites_created: i32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ErrorCode {
    NotOwner,
    AuthCheck,
    RequiresInvites,
    ParentNotFound,
    ConversationCap,
    OwnerCap,
    CreateWave,
    OutcomeUnknown,
}
impl ErrorCode {
    pub const fn status(self) -> u16 {
        match self {
            Self::NotOwner => 403,
            Self::RequiresInvites | Self::ParentNotFound => 400,
            Self::ConversationCap | Self::OwnerCap => 409,
            Self::OutcomeUnknown => 503,
            Self::AuthCheck | Self::CreateWave => 500,
        }
    }
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::NotOwner => "polis_err_treevite_not_conversation_owner",
            Self::AuthCheck => "polis_err_treevite_auth_check",
            Self::RequiresInvites => "polis_err_treevite_wave_requires_invites",
            Self::ParentNotFound => "polis_err_treevite_parent_wave_not_found",
            Self::ConversationCap => "polis_err_treevite_conversation_code_cap",
            Self::OwnerCap => "polis_err_treevite_owner_code_cap",
            Self::CreateWave => "polis_err_treevite_create_wave",
            Self::OutcomeUnknown => "polis_err_treevite_wave_outcome_unknown",
        }
    }
}
