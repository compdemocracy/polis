# Metadata selection read

`POLIS_API_METADATA_QUERY_READS=1` and `RUST_API_ROUTES=metadataQuery`
independently select POST `/api/v3/query_participants_by_metadata`; both are off
by default. This POST is a read. No write route is enabled by its selector.

`POLIS_API_METADATA_QUERY_DATABASE_URL` supplies primary identity and direct
conversation-ID lookup; `READ_ONLY_DATABASE_URL`, when set, supplies metadata
reads. Independent one-slot read-only pools use 15 ms admission, 50 ms SQL and
75 ms request bounds. There are no migrations, participant writes, external
requests or connections held across external work. Public keys are loaded at
startup using the existing participant/OIDC read verifier settings.

The admitted input is canonical JSON with a conversation_id of 1–100 ASCII
alphanumeric characters and up to 256 signed 32-bit integer pmaids. The body
is limited to 16 KiB and the response to 1000 participant IDs. Other JSON
coercions, duplicate fields, forms, query parameters, cookies and unsupported
auth identities hand back to Node. Existing signed identities only are resolved.

Empty selections return [] after authentication and conversation lookup.
Nonempty selections retain the existing unchecked-answer SQL, including its
lack of a choice-conversation predicate, inactive-row rules, NULL behavior and
unsorted output. The owner/participant callback's result is ignored by Node;
this port preserves that behavior. It introduces no owner-only gate. Query or
pool failures hand back before any response bytes, with separate health counters.

The raw conformance runner checks unchanged Node bytes, disabled routing,
participant/OIDC identities, cross-conversation choices and NULL exclusions.
