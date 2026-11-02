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
acquire and statement deadlines. Authority lookup creates no pool or locks and is
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

## Staged admission (switched off and never served)

`admission::admit` has no serving callers, route, environment switch or pool.
It accepts already verified identity evidence and a caller-owned primary
connection. It commits user creation, membership, the optional XID binding,
invite consumption and prepared recovery material in one Rust transaction.
No migration or Postgres admission function is added. The existing participant
allocator supplies the PID, including zero, and holds its transaction lock
until commit. Returning identities are looked up on primary; anonymous UIDs
are never reused in a different conversation. The exact conversation owner
keeps the Treevite bypass; moderators and administrators do not acquire it.
An XID resolving to any conversation owner, owner-flagged account, same-site
moderator, configured administrator or OIDC-mapped account is refused with
`polis_err_xid_owner_account`, matching the Node account guard.

The invite row is locked before any identity write. Closed conversations and
the identity gates refuse without committed writes. Uniqueness races roll
back the whole attempt and re-resolve, with three attempts maximum. Lock and
statement timeouts are five seconds; lock timeouts are not retried. A final
locked open check follows the participant allocator so a concurrent close
cannot admit a new member, and the conversation/advisory lock order is not
inverted. Sequence values may be consumed by rollback, as in PostgreSQL;
participant rows, numbers and counts are rolled back together.

`PreparedRecovery` must come from a bounded crypto worker that generated the
code and computed bcrypt and the existing peppered lookup before admission.
Only the inexpensive PID-dependent HMAC runs while holding the allocator lock.
`VerifiedLogin` is evidence of an external bcrypt check; admission rechecks the
exact hash, lookup and revocation under a row lock. It does not itself verify
an untrusted login code. Signing and child-wave issuance are separate work
after commit, never callbacks inside the transaction. OIDC first-use
provisioning and retired cookie/single-use-invite paths are outside this module.

This function is not a complete credential endpoint. A commit error is
`CommitUnknown`, not permission to retry. A lost response, failed post-commit
signing or child issuance still needs a client-bound recovery/delivery protocol
before serving can be considered. No new expiry or revocation policy is added.
The staged function creates no participation traffic or resource contention;
future integration must use bounded participation capacity and separately
budget cryptography and child issuance. These tests do not establish full-stack
load isolation or safe mixed Node/Rust invite admission.

The shared `scripts/test-polis-auth.sh` entry point also runs admission tests
against isolated fixture schemas, with the real Treevite DDL and the allocator
function from migration 000044. They force simultaneous invite contenders,
check the losing identity cannot recover unauthorized membership, inject SQL
failures at each write boundary and at commit, and exercise concurrent XID and
account joins. `admission_recordings.rs` compares the admission projection of
committed Node recordings: UID/PID, row creation, identity links, recovery
material and exact gate-refusal bodies. It does not claim full HTTP byte parity
for an endpoint that is not implemented or routed. Node's recorded orphan-user
and unbound-participant failures are pinned as deliberate atomicity deltas.
||||||| 958aa56e5

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


## Staged single-sign-on provisioning and provider keys

`oidc::provision` takes verified, mapped claims and a caller-owned primary
connection. No route calls it. Its future authentication caller must invoke it
on any authenticated request, including reads, before route field validation.
`Profile::from_verified_claims` preserves Node's standard/namespaced email and
name fallbacks, nickname, local part, and whitespace. `email_verified` and the
namespaced `delphi_enabled` stay request metadata, not database columns.

A mapping hit returns the existing UID without updating the account. A miss
upserts by email, updates only hname/username on conflict, and installs the
mapping in the same READ COMMITTED transaction. New accounts have `is_owner`
true and the database's default site_id/site_owner. An existing email keeps its
owner rights and site. A new social login for an existing email replaces its old
mapping. Uniqueness losers roll back all writes and retry from primary at most
three times, using the same five-second transaction timeout policy as admission.
A failed COMMIT returns CommitUnknown, never an automatic retry. Sequence gaps
are possible; orphan accounts from a losing mapping insertion are not.

`provider::Verifier::from_environment` reads AUTH_ISSUER, AUTH_AUDIENCE, AUTH_NAMESPACE
and JWKS_URI once at startup from the same environment document as Node, and
records to the process counters already exposed by polis-api health.
`Verifier::from_snapshot` validates the baked JWKS bytes before creating the
verifier and dormant refresh worker. There is no network boot fallback. This
module does not change participant signing keys or add a kid to those tokens.

Only explicitly starting `Refresh::run` creates network work. Its caller chooses
a schedule of at least one minute (five minutes is a reasonable initial value).
Scheduled and unknown-kid refreshes share a one-attempt-per-minute cap, including
failures. Requests immediately refuse unknown kids and count oidc_jwks_misses;
they only signal the worker. The complete validated set replaces the previous
set atomically; HTTP errors, timeouts, invalid keys and oversized responses keep
the old set and count oidc_jwks_refresh_failures. Successful replacements count
oidc_jwks_refresh_successes. Removed keys cease to verify after replacement.

Unknown-key tracing warnings contain only a SHA-256 digest of the kid, at most
once per kid per hour. The log limiter holds at most 4096 digests; a distinct-kid
flood above that cap is still counted but extra logs are suppressed until slots
expire. A future serving caller must install a tracing subscriber, expose these
counters to health/monitoring and alert on misses/failures. No token/profile or
provider response is logged. The worker uses no proxy or redirects, has a ten
second request deadline and 64 KiB response limit, and permits plaintext HTTP
only for a loopback test provider. Abort and await its task at shutdown.

All of this remains switched off and never served. No Node, schema, routing or
production service configuration changes. The participation path gets no new
pool use, locks or network calls. Future wiring must give provisioning its own
bounded primary/worker budget; provider refresh never owns a database connection.
This delivery does not establish a full-stack participation-load guarantee.

Tests use real release migrations and disposable PostgreSQL, force concurrent
first-use callers to miss before releasing their inserts, and inject mapping
and COMMIT failures. The local fake JWKS server exercises key rotation, scheduled
refresh, rate limiting and failure retention under a controlled clock. Committed
Node HTTP recordings supply first-use/repeat account projections. Additional
`tests/fixtures/oidc-provisioning.json` records the unchanged Node function with
a real PostgreSQL transaction adapter across 13 calls: profile fallbacks, repeat,
email conflicts with/without a prior mapping and missing email. Tests compare
canonical JSON bytes for UID, profile, rights and mapping fields. Random site IDs
and database timestamps are structural assertions; full HTTP/signing parity is
outside this unrouted module. Malformed truthy non-string profile fields fail
closed in Rust instead of relying on Node/driver coercion. Node's non-atomic
constraint recovery and its possible concurrent orphan account are deliberately
replaced by whole-transaction retry.
