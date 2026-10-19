//! The JSON Schema documents of `delphi-input-bundle/1`: the manifest and the
//! three row files, built from the types in `delphi_input_bundle.rs` the way
//! the other contracts build theirs (`schema.rs`). The committed copies live
//! in `queue-rs/schemas/`; a test keeps them byte-equal to these.
use crate::delphi_input_bundle::{Role, CONTRACT_VERSION};
use crate::schema::{
    array, boolean, integer, literal, nullable, object, required, string, union, Schema,
};

const SOURCE_NOTE: &str = "Generated from queue-rs/polis-contracts/src/delphi_input_bundle_schema.rs. Do not edit; edit the Rust source and regenerate (POLIS_CONTRACTS_WRITE_SCHEMAS=1 cargo test --test delphi_input_bundle).";
const SHA256_HEX: &str = "^[0-9a-f]{64}$";

fn sha256() -> Schema {
    string().pattern(SHA256_HEX)
}

fn count() -> Schema {
    integer().minimum(0)
}

fn file_entry(role: Role) -> Schema {
    object(vec![
        required("role", literal(role.as_str())),
        required("path", literal(role.file_name())),
        required("schema", literal(role.row_schema())),
        required("rows", count()),
        required("bytes", count()),
        required("sha256", sha256()),
    ])
    .strict()
}

/// `queue-rs/schemas/delphi-input-bundle-v1.json`: `manifest.json`.
pub fn manifest_document() -> Schema {
    let inputs = object(vec![
        required("math_env", string().min_length(1)),
        required("math_tick", nullable(integer())),
        required("math_caching_tick", nullable(integer())),
        required("comment_set_sha256", sha256()),
        required("vote_hwm", nullable(integer())),
    ])
    .strict()
    .description("The run's inputs, exactly the output manifest's inputs block.");
    let entries: Vec<Schema> = Role::ALL.iter().map(|r| file_entry(*r)).collect();
    object(vec![
        required("schema", literal(CONTRACT_VERSION)),
        required("zid", count()),
        required("inputs", inputs),
        required("files", array(union(entries)).min_items(3).max_items(3)),
    ])
    .strict()
    .title("DelphiInputBundleManifest")
    .description("The files polis-jobs writes for a Delphi stage before its child starts: one entry per role, in the order conversation, comments, report_comment_selections.")
    .document(CONTRACT_VERSION, SOURCE_NOTE)
}

/// `queue-rs/schemas/delphi-input-bundle-conversation-v1.json`.
pub fn conversation_document() -> Schema {
    object(vec![
        required("zid", count()),
        required("topic", nullable(string())),
        required("description", nullable(string())),
        required("created", nullable(integer())),
        required("modified", nullable(integer())),
        required("owner", nullable(integer())),
    ])
    .strict()
    .title("DelphiInputBundleConversation")
    .description("The conversation row the stages read.")
    .document(Role::Conversation.row_schema(), SOURCE_NOTE)
}

/// `queue-rs/schemas/delphi-input-bundle-comments-v1.json`.
pub fn comments_document() -> Schema {
    array(
        object(vec![
            required("tid", count()),
            required("zid", count()),
            required("pid", integer()),
            required("txt", string()),
            required("created", nullable(integer())),
            required("mod", integer()),
            required("active", boolean()),
        ])
        .strict(),
    )
    .title("DelphiInputBundleComments")
    .description("Every comment of the conversation, ordered by tid.")
    .document(Role::Comments.row_schema(), SOURCE_NOTE)
}

/// `queue-rs/schemas/delphi-input-bundle-report-comment-selections-v1.json`.
pub fn report_comment_selections_document() -> Schema {
    array(
        object(vec![
            required("rid", count()),
            required("tid", count()),
            required("selection", integer()),
            required("zid", count()),
            required("modified", nullable(integer())),
        ])
        .strict(),
    )
    .title("DelphiInputBundleReportCommentSelections")
    .description(
        "Every report_comment_selections row of the conversation, ordered by rid then tid.",
    )
    .document(Role::ReportCommentSelections.row_schema(), SOURCE_NOTE)
}

/// Each committed schema file (relative to the repository root) and its text.
pub fn documents() -> Vec<(&'static str, String)> {
    let render = |s: Schema| crate::schema::render(&s.to_json());
    vec![
        (
            "queue-rs/schemas/delphi-input-bundle-v1.json",
            render(manifest_document()),
        ),
        (
            "queue-rs/schemas/delphi-input-bundle-conversation-v1.json",
            render(conversation_document()),
        ),
        (
            "queue-rs/schemas/delphi-input-bundle-comments-v1.json",
            render(comments_document()),
        ),
        (
            "queue-rs/schemas/delphi-input-bundle-report-comment-selections-v1.json",
            render(report_comment_selections_document()),
        ),
    ]
}
