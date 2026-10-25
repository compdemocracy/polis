# Conversation authority

`Principal` holds an already verified identity. `Authority::for_conversation`
evaluates one explicit route policy using a caller-owned read connection, and
`require()` turns denial into a fixed status/code value. This crate has no
pool, HTTP route, middleware registration or production switch. Authority
evaluation does not accept tokens or mint credentials.

The policies reproduce the current Node rules:

- `Owner`: `conversations.owner = uid`. An administrator or same-site account
  gets no special privilege on this policy.
- `Moderator`: the conversation owner's user row has the same non-NULL site ID
  as the caller's user row. Configured administrator UIDs bypass the query,
  including for nonexistent conversations. This is `isModerator`, not a role
  flag on the user. Empty site IDs compare equal; NULLs do not. A missing user
  does not match. Participant token kinds use their verified UID just as Node
  does; a token PID or conversation claim does not grant authority.

These are distinct policies rather than a hierarchy: even an owner with a NULL
site ID fails Node's moderator predicate. Pass the same policy to the evaluator
and `require`; changing policies requires another evaluation. The route supplies
its existing literal `polis_err_*` code. Database errors return `Unavailable`,
separately from a forbidden decision, without leaking database diagnostics.

`PostgresLookup` uses synchronous workspace transport conventions. A future
async handler must call it through its own bounded blocking/read pool, with
acquire and statement deadlines. This library creates no pool or locks and is
not connected to the vote, comment or next-statement paths. No load-isolation
claim follows from these unit tests; deployment and route integration need
their own conformance and contention tests.

Run `bash scripts/test-polis-auth.sh` from the repository with
`POLIS_AUTH_TEST_DATABASE_URL` set to a disposable PostgreSQL 17 database. The
integration test uses connection-local temporary tables and compares both
policies against Node's predicates across 240 decisions, with direct checks for
NULL, empty and differently cased sites, absent users/conversations and admin
bypass. The script is also the hosted CI entry point.

The `participant` module verifies Node-issued RS256 anonymous and standard-user
participant JWTs against an operator-supplied public key, issuer and audience.
It requires the requested conversation code to match exactly, checks expiry,
not-before, issued-at and subject/type/UID/PID bindings, then resolves an existing
membership through the caller's read-only connection. PID zero is valid. XID,
unknown claims, mixed token kinds, aliases, missing/ambiguous membership and
Treevite conversations return a handoff. It never creates users/participants,
issues tokens, fetches provider keys or logs credentials. The caller supplies a
trusted clock and bounded primary-read connection; keys are not fetched remotely.


The opt-in `participant::Verifier::verify_for_request` also scopes XID tokens
and request XIDs, returning an identity without granting membership. It performs
no lookup or write and is not called by any route; `verify` still hands XID
tokens back to Node. Cross-language coverage lives in
`tests/participant_jwt_interop.rs` and
`server/__tests__/unit/participant-jwt-interop.test.ts`; request identity rules
are also checked by `server/__tests__/unit/xid-request-identity.test.ts`.
