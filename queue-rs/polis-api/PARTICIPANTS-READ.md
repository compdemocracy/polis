# Current participant row

Observable changes: none while off.

`POLIS_API_PARTICIPANTS_READS=1` and nginx `RUST_API_ROUTES=participantsRead` independently opt into GET/HEAD `/api/v3/participants`. Both default off. The database variable is `POLIS_API_PARTICIPANTS_DATABASE_URL`; reads prefer `READ_ONLY_DATABASE_URL` when present. The public conversation ID is resolved by an indexed lookup on every request. There is no process-local ID cache. The known warm reverse-cache difference after an owner adds a code does not affect this response: it retains the numeric internal ID and never reverse-resolves it.

A mandatory verified participant or OIDC identity and one conversation_id query are admitted. XID, cookies, malformed identities, ambiguous rows/schema, extra query arguments, body, unsupported methods, missing IDs and resource failures hand back to Node before a response. Missing membership returns JSON null. A single row preserves SQL column order, nullable values and bigint strings. The history COUNT overrides the stored vote_count in its original property position. No reverse-ID or field cleanup is applied.

Separate size-one read-only authentication and data pools use 15ms acquisition and 50ms statement limits, inside a 75ms overall deadline. No participation writer slots, new locks, schema or Node edits. No database connection crosses external I/O. A blocked read sheds itself while an independent pool answers.

`conformance/participants-read-run.sh` records unchanged Node and compares entire HTTP bytes with Rust. Date-only rollover causes recapture, never normalization. All cases also exercise a process with this switch off. The fixture exercises anonymous/standard participant and OIDC identities, pid zero/nonzero, empty/history counts, HEAD, CORS and unsupported boundaries. Historical JavaScript and conversion TypeScript retain the same registration and first-row-or-null behavior; current hybrid authentication and vote-history projection are subsequent changes, preserved here.
