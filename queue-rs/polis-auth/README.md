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
a primary account lookup for each verified XID token, before request scoping
can drop its UID, and is not called by any route; `verify` still hands XID
tokens back to Node. Cross-language coverage lives in
`tests/participant_jwt_interop.rs` and
`server/__tests__/unit/participant-jwt-interop.test.ts`; request identity rules
are also checked by `server/__tests__/unit/xid-request-identity.test.ts`.

The `observability` module provides fixed-label process counters; `probes/`
contains offline aggregate SQL queries. See
[Identity observability](../polis-api/IDENTITY_OBSERVABILITY.md) for semantics,
permissions and execution limits.

The XID account guard mirrors Node: configured numeric administrator UIDs,
conversation owners, the owner flag, users sharing a site with any conversation
owner, then OIDC mappings. It uses one indexed `EXISTS` query on the primary,
without writes, row locks, network calls or a new pool. NULL sites do not match;
empty sites do. Missing accounts retain Node's existing token handling.

Pass `xid_account::Check` to `verify_for_request`. An invalid credential is
`Ok(None)`; a privileged XID is `Err(Refusal::Privileged(class))`. Query failure
is `Err(Refusal::CheckFailed)`, never admission. At an HTTP boundary consume the
refusal with `into_response(&observability::PROCESS)` and return its status and
body verbatim as JSON. This emits one warning containing only the fixed error
and class, and increments `xid.refused.<class>` in the existing health document.
The same code is used for all five 403 classes; the class is not sent to clients.
Database failure matches Node's 500 participant-creation refusal and
`xid.refused.check_failed` counter.

Admission and minting are not implemented in this crate yet. Their callers must
use `Check::require_participant` on the resolved UID before enrolling a bare XID
or signing/reissuing its credential, including after resolving a request XID
under another conversation owner. A check is current evidence, not a reusable
permission to mint. This change adds no routes and admits no new serving traffic.
The participation path therefore has no new work or shared resources. Future
callers must use bounded primary connections and the same response boundary.

`conformance/record-xid-accounts.cjs` runs from a built Node server directory
with the Node account guard installed. It generates local users and keys,
refuses non-loopback socket connections, then records bare-XID and existing-token
HTTP responses for every class and a plain participant. Pass the output filename
as its argument. The committed fixture lives in
`../polis-contracts/tests/fixtures/xid-account.json`; all identities there are
generated. No private key is retained. `scripts/test-polis-auth.sh` applies the
repository migrations to its disposable database before running the real-table
integration test; it must never point at an existing installation.
