# Star and trash write characterization

These recordings run the unchanged Node application against generated local users and an isolated PostgreSQL database. No vote rows are needed. `record.cjs OUTPUT [EXPECTED]` records status, ordered headers, lexical body bytes and durable effects. The optional second argument compares a fresh replay without updating the expected file. The test service environment must point only to localhost ports 59040–59045; the recorder refuses other outbound connections. A local OIDC simulator signs the two OIDC cases; `MARK_PROVIDER_TOKEN_FILE` names its temporary credential file, which is never a committed artifact.

The corpus covers anonymous/standard/owner/site moderator/admin/XID/OIDC credentials, pid zero, stale/foreign/invalid/expired credentials, absent membership, closed/gated conversations, malformed parameters, numeric-prefix strings, repeated appends, unknown/negative tids, parser failures, and explicit database-failure controls. A participant moderation flag is separately labelled `marked-participant`; it is not a site moderator grant.

Date, Connection and Keep-Alive headers are excluded. Created timestamps are omitted from durable history comparisons; modified is compared as initial/advanced after the deferred update settles. Allocated OIDC account IDs are replaced by labelled fixture identities. Generated credential bytes never enter the recordings. There is no token issuance by these routes. Content-Length and ETag are verified against raw response bytes. Status, every remaining ordered header and body bytes are compared exactly.

`write` and `duplicate` inject a pre-query error, respectively XX000 and 23505. `after-commit` executes the real append then withholds its acknowledgement with an injected error; its durable row remains. These are explicit fault controls, not naturally occurring database errors. The baseline DDL has no unique key, so normal repeated appends do not produce 406. The trashes callback's internal catch is an additional defensive 500 `polis_err_trashes` branch; ordinary typed PostgreSQL rows do not trigger it.

The Rust replay runs below HTTP with the same generated identities and published history table definitions. It admits only numeric i32 tids and numeric 0/1 values, verified anonymous/standard tokens and matching durable membership. It preserves stars' 500 after commit. Unsupported branches return the Node hand-back signal before any mutation, with all fixture table columns unchanged. Disabled routes always hand back. No nginx entry or listener activation accompanies these files.

`mixed.cjs PRIVATE_CREDENTIAL_FILE` starts only the unchanged Node listener for the separately invoked `mixed_node_and_rust_marks` database test. It demonstrates concurrent Node and below-HTTP Rust appends to the same keys. The credential file is generated at runtime, mode 0600, and must be removed afterward.

## Source contract

- `server/app.ts:1337–1363`: required hybrid auth, tid, conversation, value, membership, handler; body-only parameters.
- `server/src/utils/parameter.ts:246–287`: integer parser and range check; strings use decimal prefixes.
- `server/src/user.ts:156–189`: UID membership lookup, no participant creation; missing membership goes to the final error handler.
- `server/src/routes/commentMod.ts:168–244`: success and 406/500 branches, trashes deferred metadata and defensive callback catch.
- `server/src/server-helpers.ts:426–475` and `server/src/db/pg-query.ts:282–303`: stars queryP returns an array, causing the handler's result.rows dereference to fail after commit; ordinary stars does not schedule metadata.
- `server/postgres/migrations/000000_initial.sql:863–880`: append-only history, no parent foreign key or uniqueness constraint.

These are compatibility observations, not fixes. A serving proposal must separately address retry policy, unknown commits, shutdown draining and the existing stars error contract.
