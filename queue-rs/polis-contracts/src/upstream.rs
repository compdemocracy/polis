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
        "polis_err_fetching_zinvite_not_conversation_owner" | "polis_err_creating_zinvite_not_conversation_owner" =>
            ("forbidden", "This operation requires the conversation owner.", "Check the selected site and sign in as the conversation owner; moderator access alone is insufficient."),
        "polis_err_treevite_not_conversation_owner" | "polis_err_sending_invite_not_conversation_owner" =>
            ("forbidden", "This operation requires the conversation owner or a moderator on the owner's site.", "Check the selected site and sign in as the conversation owner or a moderator; an enabled account alone is insufficient."),
        "polis_err_delphi_jobs_delphi_disabled" =>
            ("forbidden", "Delphi analysis is not enabled for this account.", "No job was queued. Check the selected site and sign in with an account that has Delphi enabled."),
        // Answered with HTTP 500 when the permission lookup itself fails: a
        // site fault, not a refusal (kept ahead of the "auth" catch-all below).
        "polis_err_treevite_auth_check" | "polis_err_sending_invite_auth_check" =>
            ("server_error", "The site could not check access to this conversation.", "Check site health and retry; give the upstream code to the site operator if this persists."),
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
        "polis_err_xid_whitelist_fixed_after_start" =>
            ("xid_allowlist_fixed", "The external-ID allow-list setting is fixed once participation has started.", "No change was made and none will be retried. Keep the current --external-id setting for this conversation, or start a new conversation for a different one."),
        "polis_err_conversationStats_misc" =>
            ("conversation_stats_unavailable", "The site could not read participation statistics.", "Check the conversation ID and moderator account; ask the operator to inspect statistics reads if this persists."),
        "polis_err_topicMod_comments_store_missing" => ("topic_statements_unavailable", "Per-topic comment listing is unavailable on this site.", "Use report comments list for visible conversation comments, or ask the operator about topic storage. An empty topic was not returned; retrying will not create the store."),
        "polis_err_get_reports_misc" => ("report_read_failed", "The site could not read this report.", "Check the report ID and selected site; ask the operator to inspect report storage if this persists."),
        "polis_err_get_comments" => ("statements_read_failed", "The site could not read comments.", "Check the conversation/report and pagination parameters. Ask the operator to inspect comment reads if this persists."),
        "polis_err_conversation_is_closed" => ("conversation_closed", "This conversation is closed.", "View its results or ask its owner to reopen it before submitting."),
        "polis_err_post_comment_duplicate" | "polis_err_comment_duplicate" | "polis_err_ptptCommentMod_duplicate" =>
            ("duplicate_statement", "This comment already exists.", "Find the existing comment rather than submitting another copy."),
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
    fn invite_refusals_are_allowlisted_and_forbidden() {
        for (code, kind) in [
            ("polis_err_treevite_not_conversation_owner", "forbidden"),
            (
                "polis_err_sending_invite_not_conversation_owner",
                "forbidden",
            ),
            (
                "polis_err_fetching_zinvite_not_conversation_owner",
                "forbidden",
            ),
            (
                "polis_err_creating_zinvite_not_conversation_owner",
                "forbidden",
            ),
            ("polis_err_treevite_auth_check", "server_error"),
            ("polis_err_sending_invite_auth_check", "server_error"),
        ] {
            for body in [
                json!(code),
                json!({"code": code}),
                json!({"error": code}),
                json!({"error": {"code": code}}),
                json!({"message": code}),
            ] {
                let recognized = code_from(&body).expect("known invite code");
                assert_eq!(recognized, code);
                assert_eq!(guidance(recognized).code, kind, "{code}");
            }
        }
        // Moderators pass the treevite and emailed-invite checks; only the
        // conversation-code read is owner-only.
        assert!(guidance("polis_err_treevite_not_conversation_owner")
            .message
            .contains("moderator"));
        assert!(
            !guidance("polis_err_fetching_zinvite_not_conversation_owner")
                .message
                .contains("moderator")
        );
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
