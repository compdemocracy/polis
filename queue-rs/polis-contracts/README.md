# Shared Rust contracts

This dependency contains no database, HTTP client, credentials or provider work.
The CLI and queue-rs/polis-api consume the same crate by path. The queue adapter
re-exports `Completion<Value>`; the route and CLI share `Pca2ErrorCode` spellings.
The CLI error envelope remains `polis-cli/1` and remains distinct from legacy
server wire bytes. Moving these types changes no queue SQL or route response.

`upstream` recognizes literal codes from the 2026-10-08 route/error census plus
the narrative exchange. Guidance is curated; internal exceptions, dynamic SDK
text and localized client strings retain an HTTP fallback. Only allowlisted
codes are echoed. No automatic request retry is introduced. HTTP 200 failures
and unconfirmed writes keep `outcome: unknown`; recovery advice is not evidence
that a write was rejected.

Narrative input/export schemas remain owned by the exchange server. This change
does not claim all Node routes or the job DAG have typed Rust equivalents.
