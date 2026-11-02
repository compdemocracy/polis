# Identity observability

No new request class is served. Identity admission, minting, Node handlers,
schema and route configuration are unchanged.

`GET /health` adds an `identity` object with process-local cumulative counters.
Every label is present from startup, initially zero. Restarting the process
resets them. Each counter is atomic and saturates at the maximum unsigned
64-bit value; the snapshot is not atomic across counters. As with the existing
status counters, JSON numbers lose integer precision above 2^53.

`polis_auth::observability::Event` is the closed label set; `PROCESS.record`
accepts no text or identity values. There are no token, XID, email, cookie,
subject, UID, PID, conversation or key-ID labels.

| Counters | Meaning |
| --- | --- |
| `tokens_minted_{anonymous,xid,standard_user,treevite}` | Successful signing, by issuance path. Treevite is an issuance path, not a JWT claim kind. Count each token once. |
| `participants_created`, `users_created_{anonymous,oidc}`, `xid_rows_upserted` | Successful committed writes, not attempted writes. |
| `refusal_polis_err_{xid_required,xid_not_allowed,treevite_auth_required,domain}` | The named refusal returned by this process. |
| `refusal_{too_many_requests,invalid_user_data,authentication_conflict,user_creation_failed,authentication_error}` | The five OIDC provisioning error bodies, identified by their fixed `error` field. |
| `refusal_{no_authentication_token_found,invalid_token_format,invalid_authentication_token}` | The three token error bodies, identified by their fixed `error` field with spaces replaced by underscores and lowercased. |
| `retries_23505`, `lock_timeouts_55P03`, `signing_failures` | A unique-violation retry actually attempted, an identity lock timeout, or a signing failure. |
| `oidc_jwks_misses` | An RS256 token header has a key ID absent from the configured snapshot. Malformed headers, missing key IDs, wrong algorithms and bad signatures under known keys are not misses. The header is unverified; a miss does not establish an authentic identity. |
| `handoff_*` | A read-only identity operation returned control to the caller for fallback, by the reasons below. These are operation counts, not completed HTTP response counts. |

Creation, minting, retry, lock-timeout and signing-failure counters remain
zero: these identity operations are not implemented in this Rust foundation.
Their producers must record at the boundaries above when added. Refusals are
counted at the JSON response constructors using exact status/error pairs,
before compression or HEAD body removal; currently only the missing-token
body is produced. Other refusal counters remain zero until their responses
exist. The counters do not infer Node outcomes from a hand-back or count Node
events.

All routes use `credential_handoff` as the reason table for credential hints:
malformed credentials/fields are `credential_shape`; participant shapes with
another conversation are `conversation_scope`; XID shapes are `unsupported_kind`
(including in another conversation). Mixed participant/XID shapes follow
participant verification. Hints are unverified and only label hand-backs; they
never establish identity. A bad signature or clock under an otherwise supported
participant shape is `participant_verification`. Missing or mismatched existing
membership is `participant_membership`. All names have the `handoff_` prefix.

Hybrid reads additionally count `verifier_unavailable`, `oidc_verification`,
`oidc_profile`, `oidc_mapping`, `conversation_missing` and `database`. Database
includes hybrid pool acquisition and query failures, not unrelated backend
failures. JWKS misses are counted in the shared OIDC verifier; a hybrid JWKS
miss increments both its miss counter and its OIDC hand-back counter. Inner
participant failures are not recounted by the hybrid caller. An optional
participant lookup after successful OIDC authentication records no hand-back.
Existing `participantServed` and `participantFallback` retain their request-level
meaning. Requests rejected before identity resolution keep their route counters.
A route deadline that cancels resolution before it returns records no identity
hand-back; its route fallback counter still applies.

## Partial-state probes

The three files in `../polis-auth/probes/` each contain one aggregate query:

1. `recent-unattached-users.sql`: users created within the last 24 hours with
   neither membership nor OIDC mapping. Uses the schema's millisecond clock,
   includes the lower boundary, excludes future and NULL creation times.
2. `participants-missing-owner-xids.sql`: participants in conversations with
   `xid_required` or `use_xid_whitelist` whose user has no XID binding under
   that conversation's owner. The owner itself is excluded. Count memberships,
   not XID rows; duplicate bindings do not multiply the count. This catches a
   committed participant left without any XID row after an upsert failed.
3. `xids-missing-participant-id.sql`: XID rows with NULL `pid` and an existing
   participant at the exact stored `(zid, uid)`. NULL `zid` is not a match;
   participant zero is a valid match.

These are candidates for investigation, not proof of failed admission. A recent
unattached password-signup account also counts in probe 1. Without an XID
requirement, the tables cannot distinguish a failed XID upsert from an anonymous
participant; Node's `polis_err_adding_xid_record` log is the signal there. An
owner-bound account is excluded when participating in its own conversation or
when bound under the requested owner; other missing required bindings count.
The queries do not repair rows or reconstruct their history.

The probe box's reader login currently lacks the required SELECT grants on
`users(uid, created)`, `oidc_user_mappings(uid)`, and
`xids(uid, owner, zid, pid)`. Its existing grants cover `participants` and
`conversations`, including the requirement flags. Until a grant change is ruled,
run these through the same path as the XID census: an SSM command inside the
Delphi container, using its configured database connection and returning counts
only. Use the reviewed job wrapper with recorded query digests and receipts;
no ad hoc database shell. This patch adds neither grants nor a job wrapper.

Run against a read replica or isolated snapshot, never a serving pool. The
wrapper must set `default_transaction_read_only=on`, `statement_timeout=5000`
and `lock_timeout=1000`. Five seconds is a safety ceiling, not a promise of
completion: a timeout is an unavailable result, never a zero. Inspect the first
run's duration and replica load before approving a different ceiling or cadence.

Probe 1 must scan `users`: the released schema has no index on `created`.
Its time predicate leaves that column bare, and its anti-joins can use
`participants_conv_uid_idx` and `idx_oidc_mappings_uid`. The previous scale
measurement took about 1.2 seconds at five million users. Probe 2 filters
conversations by the two requirement flags, joins through the indexed `zid`
membership key, and can look up XID rows using `idx_xids_uid_zid` then filter
owner. There is no composite `(uid, owner)` index. Depending on cardinality,
Postgres can still choose full scans/hash joins; no forced index plan or new
schema is assumed. The former unrestricted probe took 1.4–3.3 seconds at six
million memberships. Probe 3 can use `idx_xids_pid` for NULL PIDs and the exact
membership index; it previously measured 28 milliseconds at one million XIDs.
These are test measurements, not production bounds.

No scheduled execution or dashboard is installed. `/health` reads only in-memory
counters and never executes these scans. The participation path gains no query,
pool, database lock, network call, or background task.

The SQL tests create isolated databases and apply every migration in
`server/postgres/migrations/release.txt`, including the real participant-number
trigger. They require a disposable test login allowed to create databases and
remove their own databases after each test:

```sh
POLIS_AUTH_TEST_DATABASE_URL="$TEST_DATABASE_URL" \
  cargo test --locked -p polis-auth --features db-tests --test identity_probes
```

The XID account boundary also exposes `xid.refused.admin`,
`xid.refused.conversation_owner`, `xid.refused.owner_flag`,
`xid.refused.site_moderator`, `xid.refused.oidc_mapped`, and
`xid.refused.check_failed`. These match Node's metric labels. Consume the typed
`polis_auth::xid_account::Refusal` once at the response boundary to record the
class and its identity-free warning; the generic JSON observer cannot infer
the class from the shared error body and must not count it again. The current
serving routes hand XIDs to Node, so these counters stay zero until the foundation
is connected to admission routes.
