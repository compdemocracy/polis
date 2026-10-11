//! Allowlisted source codes and recovery guidance. Never return upstream prose.
use crate::Pca2ErrorCode;
use serde_json::Value;
mod catalog {
    include!("error_catalog.rs");
}

#[derive(Debug, Clone, Copy)]
pub struct Guidance {
    pub upstream_code: &'static str,
    pub code: &'static str,
    pub message: &'static str,
    pub action: &'static str,
}

const NARRATIVE: &[&str] = &[
    "AUTH_REQUIRED",
    "OWNER_REQUIRED",
    "INVALID_NARRATIVE",
    "IMPORT_CONFLICT",
    "STALE_NARRATIVE_INPUTS",
    "NARRATIVE_INPUTS_UNAVAILABLE",
    "NARRATIVE_STORAGE_UNAVAILABLE",
    "SECTION_NOT_FOUND",
];

pub fn known(raw: &str) -> Option<&'static str> {
    catalog::CATALOG
        .iter()
        .chain(NARRATIVE)
        .copied()
        .find(|s| *s == raw)
}

/// Inspect only explicit code slots or a plain code body. Arbitrary messages,
/// submitted content, diagnostic details and request IDs are never reflected.
pub fn code_from(value: &Value) -> Option<&'static str> {
    [
        value.as_str(),
        value.get("code").and_then(Value::as_str),
        value.get("error").and_then(Value::as_str),
        value
            .get("error")
            .and_then(|v| v.get("code"))
            .and_then(Value::as_str),
        value.get("message").and_then(Value::as_str),
    ]
    .into_iter()
    .flatten()
    .find_map(known)
}

pub fn guidance(code: &'static str) -> Guidance {
    let (kind, message, action) = match code {
        "AUTH_REQUIRED" | "polis_err_need_auth" | "polis_err_treevite_auth_required" =>
            ("auth_required", "This operation requires authentication.", "Run polis auth status, then polis auth login for the selected site."),
        "OWNER_REQUIRED" => ("owner_required", "This operation requires the conversation owner.", "Sign in as the conversation owner; an enabled account alone is insufficient."),
        "STALE_NARRATIVE_INPUTS" => ("stale_narrative_inputs", "The conversation changed after narrative export.", "Export fresh inputs with polis delphi narrative export, then revise the result before importing."),
        "IMPORT_CONFLICT" => ("narrative_conflict", "This export already has a different imported result.", "View the existing narrative. Export fresh inputs for a new result; do not overwrite this export."),
        "INVALID_NARRATIVE" => ("invalid_narrative", "The narrative does not satisfy the exchange contract.", "Check result.schema.json, the resource IDs, sections, citations and digest from the exported manifest."),
        "SECTION_NOT_FOUND" => ("section_not_found", "The requested narrative section is unavailable.", "Export without --section to inspect the available sections."),
        "NARRATIVE_INPUTS_UNAVAILABLE" => ("narrative_inputs_unavailable", "The narrative input service is unavailable.", "Ask the site operator to check the private input service; this command calls no model."),
        "NARRATIVE_STORAGE_UNAVAILABLE" => ("narrative_storage_unavailable", "Narrative storage could not confirm the operation.", "Use polis delphi narrative view to check the run before retrying the identical import."),
        "polis_err_update_conversation_permission" | "polis_err_post_reports_permissions" | "polis_err_put_reports_permissions" | "polis_err_conversationStats_need_report_id_or_moderation_permission" =>
            ("forbidden", "This operation requires moderator access to the conversation.", "Run polis auth status for this site, then ask the owner for moderator access; an enabled account alone is insufficient."),
        "polis_err_update_conversation" =>
            ("conversation_update_failed", "The site could not confirm the conversation edit.", "Run polis conversation view <id> and compare settings before retrying; ask the operator if the failure persists."),
        "polis_err_post_reports_misc" =>
            ("report_write_failed", "The site could not confirm the report write.", "Run polis report list --conversation <id> before retrying; creation has no idempotency key and repeating it can create duplicates."),
        "polis_err_conversationStats_misc" =>
            ("conversation_stats_unavailable", "The site could not read participation statistics.", "Check the conversation ID and moderator account; ask the operator to inspect statistics reads if this persists."),
        "polis_err_topicMod_comments_store_missing" => ("topic_statements_unavailable", "Per-topic statement listing is unavailable on this site.", "Use report statements list for visible conversation statements, or ask the operator about topic storage. An empty topic was not returned; retrying will not create the store."),
        "polis_err_get_reports_misc" => ("report_read_failed", "The site could not read this report.", "Check the report ID and selected site; ask the operator to inspect report storage if this persists."),
        "polis_err_get_comments" => ("statements_read_failed", "The site could not read statements.", "Check the conversation/report and pagination parameters. Ask the operator to inspect statement reads if this persists."),
        "polis_err_conversation_is_closed" => ("conversation_closed", "This conversation is closed.", "View its results or ask its owner to reopen it before submitting."),
        "polis_err_post_comment_duplicate" | "polis_err_comment_duplicate" | "polis_err_ptptCommentMod_duplicate" =>
            ("duplicate_statement", "This statement already exists.", "Find the existing statement rather than submitting another copy."),
        s if s == Pca2ErrorCode::MissingConversationId.as_str() =>
            ("invalid_input", "A conversation ID is required.", "Supply the public conversation ID shown in its link."),
        s if s == Pca2ErrorCode::ConversationLookup.as_str() =>
            ("conversation_unavailable", "The conversation could not be resolved.", "Check the public conversation ID and selected site; ask the operator if the link is correct."),
        s if s.contains("auth") || s.contains("permission") || s.contains("no_access") =>
            ("forbidden", "The site refused access to this resource.", "Check the selected site and account permissions; signing in does not grant ownership."),
        s if s.starts_with("polis_err_param_") || s.contains("invalid_request") =>
            ("invalid_input", "The site refused a request parameter.", "Run the command with --help and check resource IDs and input format."),
        _ => ("operation_failed", "The site could not complete this operation.", "Read the current resource state before retrying a write; give the upstream code to the site operator if this persists."),
    };
    Guidance {
        upstream_code: code,
        code: kind,
        message,
        action,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn wire_codes_are_shared_with_the_route() {
        for code in [
            Pca2ErrorCode::MissingConversationId,
            Pca2ErrorCode::ConversationLookup,
        ] {
            assert_eq!(
                code_from(&json!({"error":code.as_str()})),
                Some(code.as_str())
            );
            assert_ne!(guidance(code.as_str()).code, "operation_failed");
        }
    }
    #[test]
    fn payloads_cannot_be_echoed_as_codes() {
        for value in [
            json!({"error":"polis_err_need_auth secret"}),
            json!({"details":"polis_err_need_auth"}),
            json!({"error":{"code":"secret"}}),
        ] {
            assert!(code_from(&value).is_none());
        }
        assert_eq!(
            code_from(&json!({"error":{"code":"STALE_NARRATIVE_INPUTS"}})),
            Some("STALE_NARRATIVE_INPUTS")
        );
    }
    #[test]
    fn catalog_has_no_duplicates() {
        let mut entries = catalog::CATALOG.to_vec();
        entries.sort_unstable();
        entries.dedup();
        assert_eq!(entries.len(), catalog::CATALOG.len());
        for code in entries {
            assert_eq!(known(code), Some(code));
        }
    }
}
