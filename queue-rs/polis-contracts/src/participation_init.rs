//! Three row-derived objects served by
//! GET /api/v3/participationInit. These are nested entries, not a new response.
//! xInfo is user.xInfo, never a top-level field. See README for omissions and
//! migration-dependent ordering. BIGINT values retain node-postgres strings.
//! Conversation is the bootstrap (active migration chain) variant. The supported
//! legacy layout documented in docs/migration-legacy-contract.md omits branding_type,
//! adds dataset_explanation, is_curated and need_suzinvite, and may place
//! prioritize_seed/use_xid_whitelist elsewhere. This strict type rejects that
//! object (missing branding_type / unknown is_curated); pinning the legacy variant
//! needs its own recording, not just a reordered bootstrap example.
use crate::participant_token::True;
use crate::schema::{
    array, boolean, integer, literal_bool, nullable, object, optional, required, string, Schema,
};
use crate::wire::{present, required as required_nullable};
use serde::{Deserialize, Serialize};

pub const PATH: &str = "/api/v3/participationInit";
const SOURCE: &str = "Generated from polis-contracts participation_init; POLIS_CONTRACTS_WRITE_SCHEMAS=1 cargo test --locked -p polis-contracts --test identity_contracts";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Participant {
    pub pid: i32,
    pub uid: i32,
    pub vote_count: i32,
    pub last_interaction: String,
    pub subscribed: i32,
    #[serde(deserialize_with = "required_nullable")]
    pub last_notified: Option<String>,
    pub nsli: i16,
    #[serde(rename = "mod")]
    pub moderation: i32,
    #[serde(deserialize_with = "required_nullable")]
    pub created: Option<String>,
}

pub fn participant_document() -> Schema {
    object(vec![
        required("pid", integer()),
        required("uid", integer()),
        required("vote_count", integer()),
        required("last_interaction", string()),
        required("subscribed", integer()),
        required("last_notified", nullable(string())),
        required("nsli", integer()),
        required("mod", integer()),
        required("created", nullable(string())),
    ]).strict().description("Column-order-dependent Participant object; see participation_init module and README for migration provenance and omission rules.").document("participation-init-participant/1", SOURCE)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct XInfo {
    pub uid: i32,
    pub xid: String,
    #[serde(deserialize_with = "required_nullable")]
    pub x_profile_image_url: Option<String>,
    #[serde(deserialize_with = "required_nullable")]
    pub x_name: Option<String>,
    #[serde(deserialize_with = "required_nullable")]
    pub x_email: Option<String>,
    pub modified: String,
    #[serde(deserialize_with = "required_nullable")]
    pub zid: Option<i32>,
    #[serde(deserialize_with = "required_nullable")]
    pub pid: Option<i32>,
}

pub fn x_info_document() -> Schema {
    object(vec![
        required("uid", integer()),
        required("xid", string()),
        required("x_profile_image_url", nullable(string())),
        required("x_name", nullable(string())),
        required("x_email", nullable(string())),
        required("modified", string()),
        required("zid", nullable(integer())),
        required("pid", nullable(integer())),
    ]).strict().description("Column-order-dependent XInfo object; see participation_init module and README for migration provenance and omission rules.").document("participation-init-x-info/1", SOURCE)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
/// Bootstrap layout only; the documented legacy column set is rejected.
pub struct Conversation {
    #[serde(deserialize_with = "required_nullable")]
    pub topic: Option<String>,
    #[serde(deserialize_with = "required_nullable")]
    pub description: Option<String>,
    #[serde(deserialize_with = "required_nullable")]
    pub link_url: Option<String>,
    #[serde(deserialize_with = "required_nullable")]
    pub parent_url: Option<String>,
    pub upvotes: i32,
    #[serde(deserialize_with = "required_nullable")]
    pub participant_count: Option<i32>,
    #[serde(deserialize_with = "required_nullable")]
    pub is_anon: Option<bool>,
    #[serde(deserialize_with = "required_nullable")]
    pub is_active: Option<bool>,
    #[serde(deserialize_with = "required_nullable")]
    pub is_draft: Option<bool>,
    #[serde(deserialize_with = "required_nullable")]
    pub is_public: Option<bool>,
    #[serde(deserialize_with = "required_nullable")]
    pub is_data_open: Option<bool>,
    #[serde(deserialize_with = "required_nullable")]
    pub profanity_filter: Option<bool>,
    #[serde(deserialize_with = "required_nullable")]
    pub spam_filter: Option<bool>,
    #[serde(deserialize_with = "required_nullable")]
    pub strict_moderation: Option<bool>,
    #[serde(deserialize_with = "required_nullable")]
    pub prioritize_seed: Option<bool>,
    pub vis_type: i32,
    pub write_type: i32,
    pub help_type: i32,
    pub write_hint_type: i32,
    #[serde(deserialize_with = "required_nullable")]
    pub style_btn: Option<String>,
    pub socialbtn_type: i32,
    pub subscribe_type: i32,
    pub branding_type: i32,
    #[serde(deserialize_with = "required_nullable")]
    pub bgcolor: Option<String>,
    #[serde(deserialize_with = "required_nullable")]
    pub help_bgcolor: Option<String>,
    #[serde(deserialize_with = "required_nullable")]
    pub help_color: Option<String>,
    #[serde(deserialize_with = "required_nullable")]
    pub email_domain: Option<String>,
    #[serde(deserialize_with = "required_nullable")]
    pub use_xid_whitelist: Option<bool>,
    #[serde(deserialize_with = "required_nullable")]
    pub owner: Option<i32>,
    #[serde(deserialize_with = "required_nullable")]
    pub org_id: Option<i32>,
    #[serde(deserialize_with = "required_nullable")]
    pub context: Option<String>,
    #[serde(deserialize_with = "required_nullable")]
    pub course_id: Option<i32>,
    #[serde(deserialize_with = "required_nullable")]
    pub owner_sees_participation_stats: Option<bool>,
    #[serde(deserialize_with = "required_nullable")]
    pub auth_needed_to_vote: Option<bool>,
    #[serde(deserialize_with = "required_nullable")]
    pub auth_needed_to_write: Option<bool>,
    #[serde(deserialize_with = "required_nullable")]
    pub auth_opt_fb: Option<bool>,
    #[serde(deserialize_with = "required_nullable")]
    pub auth_opt_tw: Option<bool>,
    #[serde(deserialize_with = "required_nullable")]
    pub auth_opt_allow_3rdparty: Option<bool>,
    #[serde(deserialize_with = "required_nullable")]
    pub modified: Option<String>,
    #[serde(deserialize_with = "required_nullable")]
    pub created: Option<String>,
    pub importance_enabled: bool,
    #[serde(deserialize_with = "required_nullable")]
    pub treevite_enabled: Option<bool>,
    pub xid_required: bool,
    pub topics_enabled: bool,
    #[serde(deserialize_with = "required_nullable")]
    pub site_id: Option<String>,
    // participationInit calls getOneConversation with lang=null, so always [].
    pub translations: [(); 0],
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    #[serde(rename = "hasMetadata")]
    pub has_metadata: Option<True>,
    // Present (possibly null) except when context is hongkong2014.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_nullable"
    )]
    pub ownername: Option<Option<String>>,
    pub is_mod: bool,
    pub is_owner: bool,
    pub conversation_id: String,
}

pub fn conversation_document() -> Schema {
    object(vec![
        required("topic", nullable(string())),
        required("description", nullable(string())),
        required("link_url", nullable(string())),
        required("parent_url", nullable(string())),
        required("upvotes", integer()),
        required("participant_count", nullable(integer())),
        required("is_anon", nullable(boolean())),
        required("is_active", nullable(boolean())),
        required("is_draft", nullable(boolean())),
        required("is_public", nullable(boolean())),
        required("is_data_open", nullable(boolean())),
        required("profanity_filter", nullable(boolean())),
        required("spam_filter", nullable(boolean())),
        required("strict_moderation", nullable(boolean())),
        required("prioritize_seed", nullable(boolean())),
        required("vis_type", integer()),
        required("write_type", integer()),
        required("help_type", integer()),
        required("write_hint_type", integer()),
        required("style_btn", nullable(string())),
        required("socialbtn_type", integer()),
        required("subscribe_type", integer()),
        required("branding_type", integer()),
        required("bgcolor", nullable(string())),
        required("help_bgcolor", nullable(string())),
        required("help_color", nullable(string())),
        required("email_domain", nullable(string())),
        required("use_xid_whitelist", nullable(boolean())),
        required("owner", nullable(integer())),
        required("org_id", nullable(integer())),
        required("context", nullable(string())),
        required("course_id", nullable(integer())),
        required("owner_sees_participation_stats", nullable(boolean())),
        required("auth_needed_to_vote", nullable(boolean())),
        required("auth_needed_to_write", nullable(boolean())),
        required("auth_opt_fb", nullable(boolean())),
        required("auth_opt_tw", nullable(boolean())),
        required("auth_opt_allow_3rdparty", nullable(boolean())),
        required("modified", nullable(string())),
        required("created", nullable(string())),
        required("importance_enabled", boolean()),
        required("treevite_enabled", nullable(boolean())),
        required("xid_required", boolean()),
        required("topics_enabled", boolean()),
        required("site_id", nullable(string())),
        required("translations", array(crate::schema::null()).max_items(0)),
        optional("hasMetadata", literal_bool(true)),
        optional("ownername", nullable(string())),
        required("is_mod", boolean()), required("is_owner", boolean()),
        required("conversation_id", string()),
    ]).strict().description("Bootstrap (active migration chain) Conversation object with physical column order. The supported legacy layout omits branding_type, adds dataset_explanation, is_curated and need_suzinvite, and may place prioritize_seed/use_xid_whitelist elsewhere. This strict type rejects that object (missing field branding_type / unknown field is_curated); pinning it needs its own recording. See docs/migration-legacy-contract.md and the module README for provenance and omission rules.").document("participation-init-conversation/1", SOURCE)
}

// Distinguish absent ownername from present null, both produced by Node.
fn present_nullable<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Option<String>>, D::Error> {
    Option::<String>::deserialize(deserializer).map(Some)
}
